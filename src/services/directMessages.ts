import { pool, query } from '../db'

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
}

export async function saveDirectMessage(
  record: DirectMessageRecord
): Promise<'inserted' | 'skipped' | 'error'> {
  const sql = `
    INSERT INTO direct_messages
      (line_message_id, user_id, display_name, message_type, message_text, reply_text, reply_matched, sent_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
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
      record.sentAt
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
}

export async function listDirectMessages(limit = 100): Promise<DirectMessageRow[]> {
  return query<DirectMessageRow>(
    `SELECT id, line_message_id, user_id, display_name, message_type, message_text,
            reply_text, reply_matched, sent_at, unsent_at
       FROM direct_messages
      ORDER BY sent_at DESC
      LIMIT $1`,
    [limit]
  )
}
