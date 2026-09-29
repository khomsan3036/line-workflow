import express, { type Request, type Response, type Router } from 'express'
import { asyncRouter } from '../middleware/asyncRouter'
import { validateSignature, type WebhookEvent } from '@line/bot-sdk'
import { config } from '../config'
import { getGroupMemberCount, getGroupName, getUserProfileName } from '../line/client'
import { replyAndLog } from '../services/messaging'
import { saveDirectMessage } from '../services/directMessages'
import { handleAttendanceQuestion } from '../services/attendanceHandler'
import { handleMyAttendance, replyVerifyOnFollow } from '../services/myAttendanceHandler'
import { handleOvertimeQuestion } from '../services/overtimeHandler'
import {
  addressedToBot,
  answerMaintenanceMessage,
  handleMaintenanceEvent,
  maintenanceQuestionFromPostback,
  type AddressedText
} from '../services/maintenanceHandler'
import { upsertGroup } from '../services/groups'
import { recordGroupMessage } from '../services/groupMessages'
import { handleUnsend } from '../services/unsend'
import { FALLBACK_TEXT, SHORTCUT_QUICK_REPLY, WELCOME_TEXT, replyForPostback, replyForText } from '../services/autoReply'
import { MAINTENANCE_HINT_LINE, buildTopicHelp, resolveTopic, topicQuickReply } from '../services/topicRouter'
import { handleCrossCheckListPostback } from '../services/crossCheckListHandler'

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

      // ใช้ OA HR ร่วมกัน: ไม่มี OA MT แยก ทุก event (รวมที่หลงมาที่ /webhook/mt) ให้ handleEvent ของ HR
      // ซึ่งส่งต่อคำถามซ่อมบำรุงให้แชทบอทเองอยู่แล้ว
      if (config.maintenance.sharedOa && expected === 'mt') {
        console.warn('[Webhook] ใช้ OA HR ร่วมกันอยู่ ควรตั้ง Webhook URL ใน LINE Developers Console เป็น /webhook (ไม่ใช่ /webhook/mt)')
      }
      const useHr = channel === 'hr' || config.maintenance.sharedOa

      const events = parsed.events ?? []
      const handle = useHr ? handleEvent : handleMaintenanceEvent
      const tag = useHr ? '[Webhook]' : '[Webhook MT]'
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
        ...(maintenanceInHrChat()
          ? ['ถามผมได้ด้วยการพิมพ์ @ผู้ช่วย ตามด้วยคำถาม เรื่อง HR (สรุปพนักงาน) หรือซ่อมบำรุง (งานซ่อม น้ำมัน รถ)']
          : []),
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
    // ปุ่ม "ดูรายชื่อ" บนการ์ดสรุปการเข้างาน (ตรวจเทียบ bPlus) ส่งรายชื่อเข้าแชทส่วนตัวเฉพาะ HR
    if (
      event.source.userId &&
      (await handleCrossCheckListPostback({
        data: event.postback.data,
        replyToken: event.replyToken,
        userId: event.source.userId,
        groupId: event.source.type === 'group' ? event.source.groupId : null
      }))
    ) {
      return
    }
    const reply = replyForPostback(event.postback.data)
    // ใช้ OA ร่วมกัน: ปุ่มของฝั่งซ่อมบำรุง (data=q=<คำถาม>) ให้แชทบอทซ่อมบำรุงตอบ
    const question = reply === null && maintenanceInHrChat() ? maintenanceQuestionFromPostback(event.postback.data) : null
    if (question && event.source.userId) {
      await answerMaintenanceMessage({
        replyToken: event.replyToken,
        userId: event.source.userId,
        groupId: event.source.type === 'group' ? event.source.groupId : null,
        text: question,
        lineMessageId: `postback-${event.webhookEventId ?? event.timestamp}`,
        timestamp: event.timestamp
      })
      console.log(`[Postback] data=${event.postback.data} -> ส่งให้แชทบอทซ่อมบำรุง`)
      return
    }
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

    // ลำดับการตอบ: OT ของฉัน -> เวลาเข้างานของฉัน -> สรุปพนักงานทั้งหมด -> เมนู -> แชทบอทซ่อมบำรุง (เมื่อใช้ OA ร่วมกัน) -> fallback
    let replyText: string | null = null
    let matched: boolean | null = null

    if (text !== null) {
      // OT ก่อน "เวลาเข้างานของฉัน" เพราะ "OT ของฉัน" มีคำว่า "ของฉัน" ซึ่ง handleMyAttendance ก็รับด้วย
      // (แชท 1:1 ดูได้เฉพาะ OT ของตัวเอง ไม่เห็นอันดับ)
      const overtime = await handleOvertimeQuestion({ text, replyToken: event.replyToken, targetType: 'user', targetId: userId })
      const mine = overtime ? null : await handleMyAttendance({ text, replyToken: event.replyToken, userId })
      const attendance = mine || overtime
        ? null
        : await handleAttendanceQuestion({
            text,
            replyToken: event.replyToken,
            targetType: 'user',
            targetId: userId
          })

      if (overtime) {
        replyText = overtime.summaryText
        matched = true
        console.log(`[แชท 1:1] "${text}" -> ตอบ OT ของฉัน`)
      } else if (mine) {
        replyText = mine.summaryText
        matched = true
        console.log(`[แชท 1:1] "${text}" -> ตอบเวลาเข้างานของฉัน`)
      } else if (attendance) {
        replyText = attendance.summaryText
        matched = true
        console.log(`[แชท 1:1] "${text}" -> ตอบสรุปเข้างาน`)
      } else {
        const reply = replyForText(text)
        // ใช้ OA ร่วมกันและไม่ตรงเมนู: แยกหัวข้อ (คำนำหน้า "MT ..."/"HR ..." หรือคำหลัก) เรื่องซ่อม/น้ำมัน/รถ -> แชทบอทซ่อมบำรุง
        // เรื่อง HR หรือไม่ชัด -> ข้อความแนะนำเมนู (fallback) พร้อม quick reply ทั้งสองหัวข้อให้เลือก
        const resolved = reply === null && maintenanceInHrChat() ? resolveTopic({ text }) : null
        if (resolved?.topic === 'maintenance') {
          // (แชทบอทตอบและบันทึก direct_messages เองแล้ว)
          console.log(`[แชท 1:1] "${text}" -> ส่งให้แชทบอทซ่อมบำรุง`)
          await answerMaintenanceMessage({
            replyToken: event.replyToken,
            userId,
            groupId: null,
            text: resolved.text || text,
            lineMessageId: event.message.id,
            timestamp: event.timestamp
          })
          return
        }
        replyText = reply ?? fallbackText()
        matched = reply !== null
        await replyAndLog({
          replyToken: event.replyToken,
          targetId: userId,
          text: replyText,
          quickReply: maintenanceInHrChat() ? topicQuickReply({ inGroup: false }) : SHORTCUT_QUICK_REPLY,
          sentBy: reply ? 'auto-reply:menu' : 'auto-reply:fallback'
        })
        console.log(`[แชท 1:1] "${text}"${reply ? ' -> ตอบตามเมนู' : ` -> ตอบ fallback (หัวข้อ: ${resolved?.topic ?? 'hr'})`}`)
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

  // ในกลุ่มก็ถามสรุปเข้างาน / Top OT ได้ (ตอบเฉพาะเมื่อข้อความเป็นคำถามเรื่องนี้ ไม่รบกวนแชทปกติ)
  if (messageText !== null) {
    const overtime = await handleOvertimeQuestion({
      text: messageText,
      replyToken: event.replyToken,
      targetType: 'group',
      targetId: groupId
    })
    if (overtime) {
      console.log(`[กลุ่ม] "${messageText}" -> ตอบเรื่อง OT`)
      return
    }
    const attendance = await handleAttendanceQuestion({
      text: messageText,
      replyToken: event.replyToken,
      targetType: 'group',
      targetId: groupId
    })
    if (attendance) {
      console.log(`[กลุ่ม] "${messageText}" -> ตอบสรุปเข้างาน`)
      return
    }

    // ใช้ OA ร่วมกัน (บอทตัวเดียวในกลุ่มตอบหลายเรื่อง): ตอบเมื่อมีคน @บอท แล้วแยกหัวข้อ HR / ซ่อมบำรุง จากข้อความ
    // ไม่ชัดว่าเรื่องอะไร -> ไม่เดา แต่ถามกลับพร้อม quick reply ให้เลือก (ดู answerAddressedGroupMessage)
    if (maintenanceInHrChat() && event.message.type === 'text' && event.source.userId) {
      const addressed = await addressedToBot(event.message)
      if (addressed === null) return
      await answerAddressedGroupMessage({
        replyToken: event.replyToken,
        userId: event.source.userId,
        groupId,
        addressed,
        lineMessageId: event.message.id,
        timestamp: event.timestamp
      })
    }
  }
}

/**
 * ข้อความในกลุ่มที่พูดกับบอท (โหมด OA เดียว) แยกหัวข้อแล้วส่งต่อ
 *   ซ่อมบำรุง (@MT / คำนำหน้า MT / คำหลักเรื่องซ่อม น้ำมัน รถ) -> แชทบอทซ่อมบำรุง
 *   HR (@HR / คำนำหน้า HR / คำหลักเรื่องบุคคล)                 -> สรุปเข้างาน หรือคำตอบตามเมนู HR; ไม่มีคำตอบ -> แนะนำเรื่อง HR ที่ถามได้
 *   ไม่ชัด                                                    -> ข้อความแนะนำทั้งสองหัวข้อ + quick reply ให้เลือก
 * เพิ่มหัวข้อใหม่: เพิ่มใน TOPICS (services/topicRouter.ts) แล้วเพิ่มกิ่งในฟังก์ชันนี้
 */
async function answerAddressedGroupMessage(params: {
  replyToken: string
  userId: string
  groupId: string
  addressed: AddressedText
  lineMessageId: string
  timestamp: number
}): Promise<void> {
  const { replyToken, userId, groupId, addressed } = params
  const { topic, text: question } = resolveTopic(addressed)
  const shown = `@${addressed.alias ?? 'บอท'} ${question}`.trim()

  if (topic === 'maintenance') {
    console.log(`[กลุ่ม] "${shown}" -> ส่งให้แชทบอทซ่อมบำรุง`)
    await answerMaintenanceMessage({
      replyToken,
      userId,
      groupId,
      text: question || 'สรุปภาพรวมวันนี้',
      lineMessageId: params.lineMessageId,
      timestamp: params.timestamp
    })
    return
  }

  if (topic === 'hr' && question !== '') {
    const overtime = await handleOvertimeQuestion({ text: question, replyToken, targetType: 'group', targetId: groupId, addressed: true })
    if (overtime) {
      console.log(`[กลุ่ม] "${shown}" -> ตอบเรื่อง OT`)
      return
    }
    const attendance = await handleAttendanceQuestion({ text: question, replyToken, targetType: 'group', targetId: groupId })
    if (attendance) {
      console.log(`[กลุ่ม] "${shown}" -> ตอบสรุปเข้างาน`)
      return
    }
    const menu = replyForText(question)
    if (menu) {
      await replyAndLog({
        replyToken,
        targetType: 'group',
        targetId: groupId,
        text: menu,
        quickReply: topicQuickReply({ inGroup: true, topic: 'hr' }),
        sentBy: 'auto-reply:menu'
      })
      console.log(`[กลุ่ม] "${shown}" -> ตอบตามเมนู`)
      return
    }
  }

  // ไม่ชัดว่าเรื่องอะไร หรือเรื่อง HR ที่ยังไม่มีฟีเจอร์ตอบ -> แนะนำสิ่งที่ถามได้ + quick reply (กดแล้วส่ง "@ผู้ช่วย ..." กลับมา)
  const help = buildTopicHelp({ inGroup: true, topic: topic === 'hr' ? 'hr' : undefined })
  await replyAndLog({
    replyToken,
    targetType: 'group',
    targetId: groupId,
    text: help.text,
    quickReply: help.quickReply,
    sentBy: topic === 'hr' ? 'auto-reply:topic-help:hr' : 'auto-reply:topic-help'
  })
  console.log(`[กลุ่ม] "${shown}" -> ${topic === 'hr' ? 'แนะนำเรื่อง HR ที่ถามได้' : 'ถามกลับว่าเรื่อง HR หรือซ่อมบำรุง'}`)
}

/** แชทบอทซ่อมบำรุงตอบผ่าน OA HR หรือไม่ (โหมดใช้ OA ตัวเดียว) */
function maintenanceInHrChat(): boolean {
  return config.maintenance.enabled && config.maintenance.sharedOa
}

/** ข้อความแนะนำเมนูเมื่อไม่เข้าใจ: โหมด OA เดียวเพิ่มบรรทัดบอกว่าถามเรื่องซ่อมบำรุงได้ด้วย */
function fallbackText(): string {
  return maintenanceInHrChat() ? `${FALLBACK_TEXT}\n${MAINTENANCE_HINT_LINE}` : FALLBACK_TEXT
}

// admin.ts (ปุ่ม "สร้างข้อความทดสอบ") ยัง import จากที่นี่
export { saveMessage, type MessageRecord } from '../services/groupMessages'
