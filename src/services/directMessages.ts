import { pool, query } from '../db'
import type { ChannelKey } from '../line/client'

// ---------------------------------------------------------------------------
// ข้อความแชท 1:1 กับ OA - เก็บแยกจากข้อความกลุ่ม (ตาราง direct_messages)
// ---------------------------------------------------------------------------

export interface DirectMessageRecord {
  lineMessageId: string
  userId: string
  displayName: string | null
  messageType: string
  messageText: string | null
  replyText: string | null
  replyMatched: boolean | null
  sentAt: Date
  /** OA ที่รับข้อความ (ค่าเริ่มต้น hr) */
  channel?: ChannelKey
  /** groupId เมื่อข้อความมาจากกลุ่ม (บอท MT ตอบในกลุ่มเมื่อถูก mention) */
  groupId?: string | null
}

export async function saveDirectMessage(
  record: DirectMessageRecord
): Promise<'inserted' | 'skipped' | 'error'> {
  const sql = `
    INSERT INTO direct_messages
      (line_message_id, user_id, display_name, message_type, message_text, reply_text, reply_matched, sent_at,
       channel, group_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    ON CONFLICT (line_message_id) DO NOTHING`

  try {
    const result = await pool.query(sql, [
      record.lineMessageId,
      record.userId,
      record.displayName,
      record.messageType,
      record.messageText,
      record.replyText,
      record.replyMatched,
      record.sentAt,
      record.channel ?? 'hr',
      record.groupId ?? null
    ])
    const who = record.displayName ?? record.userId

    if (!result.rowCount) {
      console.log(`[ข้าม] ข้อความ 1:1 ซ้ำ id=${record.lineMessageId} จาก ${who}`)
      return 'skipped'
    }

    const preview = record.messageText ?? `[${record.messageType}]`
    console.log(`[บันทึก 1:1] ${who} (${record.messageType}): ${preview}`)
    return 'inserted'
  } catch (err) {
    // DB พังก็แค่ log ไว้ ไม่ throw เพราะ webhook ตอบ 200 ไปแล้ว
    console.error('[DB] บันทึกข้อความ 1:1 ไม่สำเร็จ:', err instanceof Error ? err.message : err)
    return 'error'
  }
}

/** ทำเครื่องหมายว่าผู้ใช้ยกเลิกส่ง และลบเนื้อความออก (ตามแนวปฏิบัติของ LINE) */
export async function unsendDirectMessage(lineMessageId: string): Promise<boolean> {
  const res = await pool.query(
    `UPDATE direct_messages
        SET message_text = NULL,
            message_type = 'unsent',
            unsent_at = now()
      WHERE line_message_id = $1`,
    [lineMessageId]
  )
  return (res.rowCount ?? 0) > 0
}

export interface DirectMessageRow {
  id: number
  line_message_id: string
  user_id: string
  display_name: string | null
  message_type: string
  message_text: string | null
  reply_text: string | null
  reply_matched: boolean | null
  sent_at: Date
  unsent_at: Date | null
  channel: string
  group_id: string | null
}

export async function listDirectMessages(limit = 100): Promise<DirectMessageRow[]> {
  return query<DirectMessageRow>(
    `SELECT id, line_message_id, user_id, display_name, message_type, message_text,
            reply_text, reply_matched, sent_at, unsent_at, channel, group_id
       FROM direct_messages
      ORDER BY sent_at DESC
      LIMIT $1`,
    [limit]
  )
}

export interface ConversationTurn {
  userText: string
  replyText: string
  sentAt: Date
}

/**
 * คู่ถาม-ตอบล่าสุดของผู้ใช้คนหนึ่งใน OA หนึ่ง (เรียงเก่า -> ใหม่) ใช้ให้แชทบอทคุยต่อเนื่องได้
 * เอาเฉพาะข้อความ text ที่มีคำตอบ และไม่เก่ากว่า maxAgeMinutes
 */
export async function listRecentConversation(
  userId: string,
  channel: ChannelKey,
  limitPairs: number,
  maxAgeMinutes: number,
  groupId: string | null = null
): Promise<ConversationTurn[]> {
  if (limitPairs <= 0) return []
  const rows = await query<{ message_text: string; reply_text: string; sent_at: Date }>(
    `SELECT message_text, reply_text, sent_at
       FROM direct_messages
      WHERE user_id = $1
        AND channel = $2
        AND group_id IS NOT DISTINCT FROM $3
        AND message_type = 'text'
        AND message_text IS NOT NULL
        AND reply_text IS NOT NULL
        AND unsent_at IS NULL
        AND sent_at >= now() - ($4::int * interval '1 minute')
      ORDER BY sent_at DESC
      LIMIT $5`,
    [userId, channel, groupId, maxAgeMinutes, limitPairs]
  )
  return rows.reverse().map((r) => ({ userText: r.message_text, replyText: r.reply_text, sentAt: r.sent_at }))
}
