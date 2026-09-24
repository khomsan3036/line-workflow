import type { MessageEvent } from '@line/bot-sdk'
import { pool } from '../db'
import { getGroupMemberName, getGroupName, type ChannelKey } from '../line/client'
import { getGroup, upsertGroup } from './groups'
import { archiveMedia } from './media'

// ---------------------------------------------------------------------------
// บันทึกข้อความในกลุ่ม (line_messages) และเก็บไฟล์สื่อ (media_files)
//
// ใช้ร่วมกันทั้ง OA HR (/webhook) และ OA ทีมซ่อมบำรุง (/webhook/mt)
// เพราะทั้งสอง OA อาจอยู่ในกลุ่มเดียวกันหรือคนละกลุ่มก็ได้ และการเก็บบันทึกต้องทำเหมือนกัน
// สิ่งที่ต่างกันคือ token ที่ใช้ดึงไฟล์: LINE ให้ดึง content ได้เฉพาะ OA ที่รับข้อความนั้น
// จึงต้องส่ง channel ต่อไปให้ archiveMedia ทุกครั้ง
// ---------------------------------------------------------------------------

export interface MessageRecord {
  lineMessageId: string
  groupId: string
  userId: string | null
  displayName: string | null
  messageType: string
  messageText: string | null
  sentAt: Date
  /** OA ที่รับข้อความนี้ (ค่าเริ่มต้น hr) */
  channel?: ChannelKey
}

export async function saveMessage(record: MessageRecord): Promise<'inserted' | 'skipped' | 'error'> {
  const sql = `
    INSERT INTO line_messages
      (line_message_id, group_id, user_id, display_name, message_type, message_text, sent_at, channel)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (line_message_id) DO NOTHING`

  try {
    const result = await pool.query(sql, [
      record.lineMessageId,
      record.groupId,
      record.userId,
      record.displayName,
      record.messageType,
      record.messageText,
      record.sentAt,
      record.channel ?? 'hr'
    ])
    const who = record.displayName ?? record.userId ?? 'ไม่ทราบผู้ส่ง'

    // rowCount = 0 แปลว่าชนกับข้อมูลเดิม ถูกข้ามด้วย ON CONFLICT DO NOTHING
    // (เกิดได้ทั้งจาก LINE retry และจากกรณีสอง OA อยู่ในกลุ่มเดียวกันแล้วได้รับข้อความเดียวกัน)
    if (!result.rowCount) {
      console.log(`[ข้าม] ข้อความซ้ำ id=${record.lineMessageId} จาก ${who}`)
      return 'skipped'
    }

    const preview = record.messageText ?? `[${record.messageType}]`
    const tag = record.channel && record.channel !== 'hr' ? `[บันทึก:${record.channel}]` : '[บันทึก]'
    console.log(`${tag} ${who} (${record.messageType}): ${preview}`)
    return 'inserted'
  } catch (err) {
    // DB พังก็แค่ log ไว้ ไม่ throw เพราะ webhook ตอบ 200 ไปแล้ว
    console.error('[DB] บันทึกข้อความไม่สำเร็จ:', err instanceof Error ? err.message : err)
    return 'error'
  }
}

/** ตรวจชื่อกลุ่มกับ LINE ซ้ำได้ทุกกี่มิลลิวินาทีต่อกลุ่ม (ต่อโปรเซส) */
const GROUP_NAME_REFRESH_MS = 60 * 60 * 1000
const groupNameCheckedAt = new Map<string, number>()

/**
 * ชื่อกลุ่มที่ควรบันทึกลงทะเบียน: ยังไม่มีชื่อ (บอทถูกเชิญก่อนระบบรัน หรือ join handler รุ่นเก่าไม่ได้เก็บ)
 * หรือไม่ได้ตรวจกับ LINE มาเกิน 1 ชั่วโมง ให้ดึงชื่อปัจจุบันจาก LINE คืน null เมื่อไม่ต้องอัปเดต/ดึงไม่ได้
 * LINE ไม่มี event แจ้งเปลี่ยนชื่อกลุ่ม ต้องถามเองเป็นระยะ ไม่งั้นชื่อเก่าค้างตลอด
 * (พบ 2026-09-24: QTEC_WELD เปลี่ยนเป็น QTEC_INTEGRA_QAQC แล้ว แต่ระบบยังเป็นชื่อเดิม)
 * ชื่อกลุ่มสำคัญกับการ์ดสรุปประชุม หน้า dashboard และการเลือกแผนกของการ์ดเข้างาน (REPORT_GROUP_IDS)
 */
export async function groupNameToSave(groupId: string, channel: ChannelKey): Promise<string | null> {
  const existing = await getGroup(groupId)
  const checkedAt = groupNameCheckedAt.get(groupId) ?? 0
  if (existing?.group_name && Date.now() - checkedAt < GROUP_NAME_REFRESH_MS) return null
  groupNameCheckedAt.set(groupId, Date.now())
  const current = await getGroupName(groupId, channel)
  if (!current || current === existing?.group_name) return null
  if (existing?.group_name) console.log(`[กลุ่ม] ชื่อกลุ่มเปลี่ยน ${groupId}: ${existing.group_name} -> ${current}`)
  return current
}

export interface RecordedGroupMessage {
  groupId: string
  userId: string | null
  displayName: string | null
  messageText: string | null
  sentAt: Date
}

/**
 * บันทึก message event จากกลุ่มให้ครบ: อัปเดตทะเบียนกลุ่ม, เก็บข้อความ, และเก็บไฟล์สื่อ
 * คืนข้อมูลที่ handler ต้องใช้ต่อ (เช่น ชื่อผู้ส่ง เนื้อความ) จะได้ไม่ต้องเรียก LINE ซ้ำ
 */
export async function recordGroupMessage(
  event: MessageEvent,
  groupId: string,
  channel: ChannelKey,
  groupPatch: { isActive?: boolean; groupName?: string | null } = {}
): Promise<RecordedGroupMessage> {
  const userId = event.source.userId ?? null
  const message = event.message
  const sentAt = new Date(event.timestamp)

  let displayName: string | null = null
  if (userId) displayName = await getGroupMemberName(groupId, userId, channel)

  const messageText = message.type === 'text' ? message.text : null

  const groupName = groupPatch.groupName ?? (await groupNameToSave(groupId, channel))
  await upsertGroup(groupId, { touchLastMessage: true, channel, ...groupPatch, groupName })
  await saveMessage({
    lineMessageId: message.id,
    groupId,
    userId,
    displayName,
    messageType: message.type,
    messageText,
    sentAt,
    channel
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
    } else {
      void archiveMedia({
        lineMessageId: message.id,
        groupId,
        userId,
        displayName,
        mediaType: message.type,
        fileName: message.type === 'file' ? message.fileName : null,
        fileSize: message.type === 'file' ? Number(message.fileSize) : null,
        sentAt,
        channel
      })
    }
  }

  return { groupId, userId, displayName, messageText, sentAt }
}
