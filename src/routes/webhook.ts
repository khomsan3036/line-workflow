import express, { type Request, type Response, type Router } from 'express'
import { asyncRouter } from '../middleware/asyncRouter'
import { middleware, type WebhookEvent } from '@line/bot-sdk'
import { config } from '../config'
import { pool } from '../db'
import { getGroupMemberCount, getGroupMemberName, replyText } from '../line/client'
import { upsertGroup } from '../services/groups'
import { archiveMedia } from '../services/media'
import { handleUnsend } from '../services/unsend'
import { FALLBACK_TEXT, WELCOME_TEXT, replyForPostback, replyForText } from '../services/autoReply'

// ---------------------------------------------------------------------------
// ขาเข้า: รับ event จาก LINE Platform แล้วบันทึกข้อความในกลุ่มลง PostgreSQL
//
// กฎเหล็ก 3 ข้อของ webhook LINE
//   1) ต้องตอบ 200 เสมอ ถ้าตอบ error ซ้ำ ๆ LINE จะหยุดส่ง event มาให้
//   2) ต้องตรวจ signature ด้วย channel secret (กันคนอื่นยิงปลอม)
//   3) ต้องไม่ใช้ express.json() ครอบ route นี้ เพราะ middleware ต้องอ่าน raw body
// ---------------------------------------------------------------------------

export function createWebhookRouter(): Router {
  const router = asyncRouter()

  // ถ้ายังไม่ได้ตั้ง CHANNEL_SECRET (เช่นตอนเรียนช่วงแรก) ให้รับ JSON ตรง ๆ
  // และเตือนใน log ว่าข้ามการตรวจ signature อยู่ - ห้ามใช้แบบนี้ใน production
  const verifier = config.channelSecret
    ? middleware({ channelSecret: config.channelSecret })
    : express.json()

  if (!config.channelSecret) {
    console.warn('[Webhook] ยังไม่ได้ตั้ง CHANNEL_SECRET จึงข้ามการตรวจ signature (ใช้เฉพาะตอนทดสอบ)')
  }

  router.post('/webhook', verifier, async (req: Request, res: Response) => {
    // ตอบ 200 ทันที ไม่ให้ LINE รอ
    res.status(200).end()

    const events: WebhookEvent[] = req.body?.events ?? []
    for (const event of events) {
      try {
        await handleEvent(event)
      } catch (err) {
        console.error('[Webhook] ประมวลผล event ไม่สำเร็จ:', err instanceof Error ? err.message : err)
      }
    }
  })

  return router
}

export async function handleEvent(event: WebhookEvent): Promise<void> {
  // 1) บอทถูกเชิญเข้ากลุ่ม -> แนะนำตัว + ขอความยินยอม (สำคัญเรื่อง PDPA)
  if (event.type === 'join' && event.source.type === 'group') {
    const groupId = event.source.groupId
    const memberCount = await getGroupMemberCount(groupId)
    await upsertGroup(groupId, { memberCount, isActive: true })
    await replyText(
      event.replyToken,
      [
        'สวัสดีครับ ผมคือบอทบันทึกบทสนทนาของทีม',
        'ผมจะเริ่มบันทึกข้อความในกลุ่มนี้ตั้งแต่ตอนนี้เป็นต้นไป เพื่อใช้สรุปประชุมและติดตามงาน',
        'ข้อความก่อนหน้านี้ผมมองไม่เห็นนะครับ',
        'ถ้าไม่สะดวกให้บันทึก แจ้งผู้ดูแลเพื่อเชิญผมออกจากกลุ่มได้เลยครับ'
      ].join('\n')
    )
    console.log(`[Join] บอทเข้าร่วมกลุ่ม ${groupId}`)
    return
  }

  // 2) บอทถูกเชิญออกจากกลุ่ม -> ทำเครื่องหมายว่ากลุ่มไม่ active
  if (event.type === 'leave' && event.source.type === 'group') {
    await upsertGroup(event.source.groupId, { isActive: false })
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
    await replyText(event.replyToken, WELCOME_TEXT)
    console.log('[Follow] มีผู้ใช้เพิ่มเพื่อนกับ OA')
    return
  }

  // 5) ผู้ใช้กดปุ่ม Rich Menu ที่เป็น action ชนิด postback
  if (event.type === 'postback') {
    const reply = replyForPostback(event.postback.data)
    await replyText(event.replyToken, reply ?? FALLBACK_TEXT)
    console.log(`[Postback] data=${event.postback.data}${reply ? '' : ' (ไม่ตรงเมนูใด)'}`)
    return
  }

  // 6) สนใจเฉพาะ message event
  if (event.type !== 'message') return

  // ---------------------------------------------------------------------
  // แชท 1:1 กับ OA: ตอบกลับตามเมนู (Rich Menu ชนิด message ส่งข้อความเข้ามาทางนี้)
  //
  // ตั้งใจ "ไม่บันทึก" ข้อความแชทส่วนตัวลงฐานข้อมูล เพราะระบบนี้ออกแบบมา
  // เพื่อเก็บบทสนทนาของกลุ่มที่แจ้งความยินยอมไว้แล้วเท่านั้น (PDPA)
  // ---------------------------------------------------------------------
  if (event.source.type === 'user') {
    if (event.message.type !== 'text') return
    const reply = replyForText(event.message.text)
    await replyText(event.replyToken, reply ?? FALLBACK_TEXT)
    console.log(`[แชท 1:1] "${event.message.text}"${reply ? ' -> ตอบตามเมนู' : ' -> ตอบ fallback'}`)
    return
  }

  if (event.source.type !== 'group') return

  const groupId = event.source.groupId
  const userId = event.source.userId ?? null
  const message = event.message
  const sentAt = new Date(event.timestamp)

  let displayName: string | null = null
  if (userId) displayName = await getGroupMemberName(groupId, userId)

  const messageText = message.type === 'text' ? message.text : null

  await upsertGroup(groupId, { touchLastMessage: true })
  await saveMessage({
    lineMessageId: message.id,
    groupId,
    userId,
    displayName,
    messageType: message.type,
    messageText,
    sentAt
  })

  // ---------------------------------------------------------------------
  // ถ้าเป็นรูป วิดีโอ เสียง หรือไฟล์ ให้ดาวน์โหลดมาเก็บถาวรทันที
  //
  // ทำไมต้อง "ทันที": เอกสาร LINE ระบุว่าไฟล์ที่ผู้ใช้ส่งจะถูกลบอัตโนมัติ
  // หลังผ่านไประยะหนึ่ง และไม่เปิดเผยว่ากี่วัน ถ้ารอไปโหลดทีหลังอาจไม่ทัน
  //
  // ไม่ await ตรงนี้ เพราะเราตอบ 200 ให้ LINE ไปแล้ว การโหลดไฟล์ใหญ่
  // ไม่ควรถ่วง event ถัดไป (error จัดการภายใน archiveMedia เองทั้งหมด)
  // ---------------------------------------------------------------------
  if (message.type === 'image' || message.type === 'video' || message.type === 'audio' || message.type === 'file') {
    // ไฟล์ที่ส่งจากบริการภายนอกจะไม่ได้อยู่บนเซิร์ฟเวอร์ LINE จึงดึงไม่ได้
    const provider = (message as { contentProvider?: { type?: string } }).contentProvider
    if (provider && provider.type === 'external') {
      console.log(`[สื่อ] ข้าม ${message.type} เพราะเป็นไฟล์จากภายนอก (contentProvider = external)`)
      return
    }

    void archiveMedia({
      lineMessageId: message.id,
      groupId,
      userId,
      displayName,
      mediaType: message.type,
      fileName: message.type === 'file' ? message.fileName : null,
      fileSize: message.type === 'file' ? Number(message.fileSize) : null,
      sentAt
    })
  }
}

export interface MessageRecord {
  lineMessageId: string
  groupId: string
  userId: string | null
  displayName: string | null
  messageType: string
  messageText: string | null
  sentAt: Date
}

export async function saveMessage(record: MessageRecord): Promise<'inserted' | 'skipped' | 'error'> {
  const sql = `
    INSERT INTO line_messages
      (line_message_id, group_id, user_id, display_name, message_type, message_text, sent_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (line_message_id) DO NOTHING`

  try {
    const result = await pool.query(sql, [
      record.lineMessageId,
      record.groupId,
      record.userId,
      record.displayName,
      record.messageType,
      record.messageText,
      record.sentAt
    ])
    const who = record.displayName ?? record.userId ?? 'ไม่ทราบผู้ส่ง'

    // rowCount = 0 แปลว่าชนกับข้อมูลเดิม ถูกข้ามด้วย ON CONFLICT DO NOTHING
    if (!result.rowCount) {
      console.log(`[ข้าม] ข้อความซ้ำ id=${record.lineMessageId} จาก ${who}`)
      return 'skipped'
    }

    const preview = record.messageText ?? `[${record.messageType}]`
    console.log(`[บันทึก] ${who} (${record.messageType}): ${preview}`)
    return 'inserted'
  } catch (err) {
    // DB พังก็แค่ log ไว้ ไม่ throw เพราะ webhook ตอบ 200 ไปแล้ว
    console.error('[DB] บันทึกข้อความไม่สำเร็จ:', err instanceof Error ? err.message : err)
    return 'error'
  }
}
