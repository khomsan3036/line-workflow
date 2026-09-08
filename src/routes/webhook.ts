import express, { type Request, type Response, type Router } from 'express'
import { asyncRouter } from '../middleware/asyncRouter'
import { validateSignature, type WebhookEvent } from '@line/bot-sdk'
import { config } from '../config'
import { getGroupMemberCount, getGroupName, getUserProfileName } from '../line/client'
import { replyAndLog } from '../services/messaging'
import { saveDirectMessage } from '../services/directMessages'
import { handleAttendanceQuestion } from '../services/attendanceHandler'
import { handleMyAttendance, replyVerifyOnFollow } from '../services/myAttendanceHandler'
import { handleMaintenanceEvent } from '../services/maintenanceHandler'
import { upsertGroup } from '../services/groups'
import { recordGroupMessage } from '../services/groupMessages'
import { handleUnsend } from '../services/unsend'
import { FALLBACK_TEXT, SHORTCUT_QUICK_REPLY, WELCOME_TEXT, replyForPostback, replyForText } from '../services/autoReply'

// ---------------------------------------------------------------------------
// ขาเข้า: รับ event จาก LINE Platform แล้วบันทึกข้อความในกลุ่มลง PostgreSQL
//
// กฎเหล็ก 3 ข้อของ webhook LINE
//   1) ต้องตอบ 200 เสมอ ถ้าตอบ error ซ้ำ ๆ LINE จะหยุดส่ง event มาให้
//   2) ต้องตรวจ signature ด้วย channel secret (กันคนอื่นยิงปลอม)
//   3) ต้องไม่ใช้ express.json() ครอบ route นี้ เพราะ middleware ต้องอ่าน raw body
// ---------------------------------------------------------------------------

type WebhookChannel = 'hr' | 'mt'

/**
 * ตรวจ signature แล้วบอกว่า event นี้มาจาก OA ไหน
 *
 * ทำไมไม่ใช้ middleware() ของ SDK ตรง ๆ: มี OA สองตัวในโปรเซสเดียว และในทางปฏิบัติ Webhook URL ใน
 * LINE Developers Console ตั้งผิด path กันบ่อย (เช่น OA ทีมซ่อมบำรุงชี้มาที่ /webhook แทน /webhook/mt)
 * จึงตรวจกับ secret ของ path ที่คาดไว้ก่อน ถ้าไม่ตรงค่อยลอง secret ของอีก OA แล้วส่งต่อให้ถูกตัว
 * คืน null เมื่อไม่ตรงกับ secret ใดเลย (= ไม่ใช่คำขอจาก LINE ของเรา)
 */
function detectChannel(rawBody: Buffer, signature: string | undefined, expected: WebhookChannel): WebhookChannel | null {
  const secrets: Record<WebhookChannel, string> = {
    hr: config.channelSecret,
    mt: config.maintenance.enabled ? config.maintenance.channelSecret : ''
  }
  const order: WebhookChannel[] = expected === 'hr' ? ['hr', 'mt'] : ['mt', 'hr']

  if (signature) {
    for (const channel of order) {
      if (secrets[channel] && validateSignature(rawBody, secrets[channel], signature)) return channel
    }
  }

  // ไม่ได้ตั้ง secret ของ path นี้ไว้ (ช่วงเรียน/ทดสอบ) -> รับโดยไม่ตรวจ แต่เตือนใน log
  if (!secrets[expected] && (expected === 'hr' || config.maintenance.enabled)) {
    console.warn(`[Webhook] รับ event ที่ /webhook${expected === 'mt' ? '/mt' : ''} โดยไม่ตรวจ signature (ยังไม่ได้ตั้ง channel secret)`)
    return expected
  }
  return null
}

export function createWebhookRouter(): Router {
  const router = asyncRouter()

  if (!config.channelSecret) {
    console.warn('[Webhook] ยังไม่ได้ตั้ง CHANNEL_SECRET (หรือ CHANNEL_SECRET_HR) จึงข้ามการตรวจ signature (ใช้เฉพาะตอนทดสอบ)')
  }
  if (config.maintenance.enabled && !config.maintenance.channelSecret) {
    console.warn('[Webhook MT] ยังไม่ได้ตั้ง CHANNEL_SECRET_MT จึงข้ามการตรวจ signature (ใช้เฉพาะตอนทดสอบ)')
  }

  // อ่าน body ดิบ (ไม่ผ่าน express.json) เพราะต้องใช้ byte เดิมเป๊ะ ๆ ในการตรวจ HMAC
  const rawBody = express.raw({ type: '*/*', limit: '1mb' })

  function webhookHandler(expected: WebhookChannel) {
    return async (req: Request, res: Response): Promise<void> => {
      const path = expected === 'hr' ? '/webhook' : '/webhook/mt'
      const body: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
      const signature = req.get('x-line-signature')

      const channel = detectChannel(body, signature, expected)
      if (!channel) {
        console.error(
          `[Webhook] signature ไม่ตรงกับ channel secret ของ OA ใดเลย (path ${path}${signature ? '' : ', ไม่มี X-Line-Signature'})` +
            ' -> ตรวจว่า CHANNEL_SECRET_HR / CHANNEL_SECRET_MT ใน .env ตรงกับ channel ที่ตั้ง Webhook URL ไว้'
        )
        res.status(401).send('signature validation failed')
        return
      }

      let parsed: { destination?: string; events?: WebhookEvent[] }
      try {
        parsed = JSON.parse(body.toString('utf8'))
      } catch {
        res.status(400).json({ error: 'invalid request body' })
        return
      }

      // ตอบ 200 ทันที ไม่ให้ LINE รอ
      res.status(200).end()

      if (channel !== expected) {
        console.warn(
          `[Webhook] event ของ OA "${channel}" ส่งมาที่ ${path} (ควรเป็น ${channel === 'hr' ? '/webhook' : '/webhook/mt'})` +
            ' ระบบส่งต่อให้ถูกตัวแล้ว แต่ควรแก้ Webhook URL ใน LINE Developers Console ให้ตรง'
        )
      }
      if (!config.maintenance.enabled && channel === 'mt') return

      const events = parsed.events ?? []
      const handle = channel === 'hr' ? handleEvent : handleMaintenanceEvent
      const tag = channel === 'hr' ? '[Webhook]' : '[Webhook MT]'
      for (const event of events) {
        try {
          await handle(event)
        } catch (err) {
          console.error(`${tag} ประมวลผล event ไม่สำเร็จ:`, err instanceof Error ? err.message : err)
        }
      }
    }
  }

  // OA หลัก (HR Notification)
  router.post('/webhook', rawBody, webhookHandler('hr'))

  // OA ทีมซ่อมบำรุง (Maintenance Team) - LINE Developers Console > Messaging API > Webhook URL:
  //   <PUBLIC_URL>/api/line-workflow/webhook/mt  (nginx ส่งต่อมาที่ /webhook/mt)
  router.post('/webhook/mt', rawBody, webhookHandler('mt'))

  return router
}

export async function handleEvent(event: WebhookEvent): Promise<void> {
  // 1) บอทถูกเชิญเข้ากลุ่ม -> แนะนำตัว + ขอความยินยอม (สำคัญเรื่อง PDPA)
  if (event.type === 'join' && event.source.type === 'group') {
    const groupId = event.source.groupId
    const [groupName, memberCount] = await Promise.all([getGroupName(groupId), getGroupMemberCount(groupId)])
    await upsertGroup(groupId, { groupName, memberCount, isActive: true, channel: 'hr' })
    await replyAndLog({
      replyToken: event.replyToken,
      targetType: 'group',
      targetId: groupId,
      text: [
        'สวัสดีครับ ผมคือบอทบันทึกบทสนทนาของทีม',
        'ผมจะเริ่มบันทึกข้อความในกลุ่มนี้ตั้งแต่ตอนนี้เป็นต้นไป เพื่อใช้สรุปประชุมและติดตามงาน',
        'ข้อความก่อนหน้านี้ผมมองไม่เห็นนะครับ',
        'ถ้าไม่สะดวกให้บันทึก แจ้งผู้ดูแลเพื่อเชิญผมออกจากกลุ่มได้เลยครับ'
      ].join('\n'),
      sentBy: 'auto-reply:join'
    })
    console.log(`[Join] บอทเข้าร่วมกลุ่ม ${groupId}`)
    return
  }

  // 2) บอทถูกเชิญออกจากกลุ่ม -> ทำเครื่องหมายว่ากลุ่มไม่ active
  if (event.type === 'leave' && event.source.type === 'group') {
    await upsertGroup(event.source.groupId, { isActive: false, channel: 'hr' })
    console.log(`[Leave] บอทออกจากกลุ่ม ${event.source.groupId}`)
    return
  }

  // 3) ผู้ใช้กดยกเลิกส่งข้อความ (unsend)
  //    LINE กำหนดให้ระบบที่เก็บข้อมูลลบข้อความนั้นออกจากฐานข้อมูลและ storage ด้วย
  //    "Delete the target message stored in a database or other storage device"
  if (event.type === 'unsend') {
    await handleUnsend(event.unsend.messageId)
    return
  }

  // 4) มีคนกดเพิ่มเพื่อนกับ Official Account -> ทักทายและชี้ไปที่ Rich Menu
  if (event.type === 'follow') {
    // ถ้าตั้ง LINE Login ไว้และผู้ใช้ยังไม่เคยยืนยันตัวตน ให้ส่งการ์ด "ยืนยันตัวตน" แทนข้อความต้อนรับ
    // (ผูก LINE userId กับรหัสพนักงานตั้งแต่เพิ่มเพื่อน จะได้ใช้ "เวลาเข้างานของฉัน" ได้ทันที)
    const userId = event.source.userId
    if (userId && (await replyVerifyOnFollow(userId, event.replyToken))) {
      console.log('[Follow] มีผู้ใช้เพิ่มเพื่อนกับ OA -> ส่งการ์ดยืนยันตัวตน')
      return
    }
    await replyAndLog({
      replyToken: event.replyToken,
      targetId: event.source.userId,
      text: WELCOME_TEXT,
      quickReply: SHORTCUT_QUICK_REPLY,
      sentBy: 'auto-reply:follow'
    })
    console.log('[Follow] มีผู้ใช้เพิ่มเพื่อนกับ OA')
    return
  }

  // 5) ผู้ใช้กดปุ่ม Rich Menu ที่เป็น action ชนิด postback
  if (event.type === 'postback') {
    const reply = replyForPostback(event.postback.data)
    await replyAndLog({
      replyToken: event.replyToken,
      targetId: event.source.userId,
      text: reply ?? FALLBACK_TEXT,
      quickReply: SHORTCUT_QUICK_REPLY,
      sentBy: reply ? 'auto-reply:postback' : 'auto-reply:fallback'
    })
    console.log(`[Postback] data=${event.postback.data}${reply ? '' : ' (ไม่ตรงเมนูใด)'}`)
    return
  }

  // 6) สนใจเฉพาะ message event
  if (event.type !== 'message') return

  // ---------------------------------------------------------------------
  // แชท 1:1 กับ OA: ตอบกลับตามเมนู (Rich Menu ชนิด message ส่งข้อความเข้ามาทางนี้)
  // แล้วบันทึกลงตาราง direct_messages (แยกจากข้อความกลุ่มใน line_messages)
  // ---------------------------------------------------------------------
  if (event.source.type === 'user') {
    const userId = event.source.userId
    const text = event.message.type === 'text' ? event.message.text : null

    // ลำดับการตอบ: เวลาเข้างานของฉัน -> สรุปพนักงานทั้งหมด -> เมนู -> fallback
    let replyText: string | null = null
    let matched: boolean | null = null

    if (text !== null) {
      const mine = await handleMyAttendance({ text, replyToken: event.replyToken, userId })
      const attendance = mine
        ? null
        : await handleAttendanceQuestion({
            text,
            replyToken: event.replyToken,
            targetType: 'user',
            targetId: userId
          })

      if (mine) {
        replyText = mine.summaryText
        matched = true
        console.log(`[แชท 1:1] "${text}" -> ตอบเวลาเข้างานของฉัน`)
      } else if (attendance) {
        replyText = attendance.summaryText
        matched = true
        console.log(`[แชท 1:1] "${text}" -> ตอบสรุปเข้างาน`)
      } else {
        const reply = replyForText(text)
        replyText = reply ?? FALLBACK_TEXT
        matched = reply !== null
        await replyAndLog({
          replyToken: event.replyToken,
          targetId: userId,
          text: replyText,
          quickReply: SHORTCUT_QUICK_REPLY,
          sentBy: reply ? 'auto-reply:menu' : 'auto-reply:fallback'
        })
        console.log(`[แชท 1:1] "${text}"${reply ? ' -> ตอบตามเมนู' : ' -> ตอบ fallback'}`)
      }
    }

    const displayName = await getUserProfileName(userId)
    await saveDirectMessage({
      lineMessageId: event.message.id,
      userId,
      displayName,
      messageType: event.message.type,
      messageText: text,
      replyText,
      replyMatched: matched,
      sentAt: new Date(event.timestamp)
    })
    return
  }

  if (event.source.type !== 'group') return

  // บันทึกข้อความ + เก็บไฟล์สื่อ (โค้ดร่วมกับ OA ทีมซ่อมบำรุง อยู่ใน services/groupMessages.ts)
  const { groupId, messageText } = await recordGroupMessage(event, event.source.groupId, 'hr')

  // ในกลุ่มก็ถามสรุปเข้างานได้ (ตอบเฉพาะเมื่อข้อความเป็นคำถามเรื่องนี้ ไม่รบกวนแชทปกติ)
  if (messageText !== null) {
    const attendance = await handleAttendanceQuestion({
      text: messageText,
      replyToken: event.replyToken,
      targetType: 'group',
      targetId: groupId
    })
    if (attendance) console.log(`[กลุ่ม] "${messageText}" -> ตอบสรุปเข้างาน`)
  }
}

// admin.ts (ปุ่ม "สร้างข้อความทดสอบ") ยัง import จากที่นี่
export { saveMessage, type MessageRecord } from '../services/groupMessages'
