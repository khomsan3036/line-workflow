import { query } from '../db'
import { broadcastText, pushFlex, pushText, replyFlex, replyText, type SendOutcome } from '../line/client'

// ---------------------------------------------------------------------------
// ชั้น "ส่งข้อความ + บันทึก log"
// ทุกการส่งออกจากระบบต้องผ่านที่นี่ เพื่อให้มีร่องรอยตรวจสอบได้ครบ
// ---------------------------------------------------------------------------

export interface SendRequest {
  targetType: 'group' | 'user' | 'broadcast'
  targetId?: string
  targetName?: string
  kind: 'text' | 'flex'
  text?: string
  altText?: string
  contents?: unknown
  sentBy: string
  dryRun?: boolean
}

export interface SendResult extends SendOutcome {
  logId: number | null
}

export async function sendAndLog(req: SendRequest): Promise<SendResult> {
  let outcome: SendOutcome

  if (req.dryRun) {
    // dry-run = ประกอบข้อความจริงแต่ไม่ส่งออก ใช้ตรวจหน้าตาก่อนยิงของจริง
    outcome = { status: 'sent' }
    console.log('[DRY-RUN] ไม่ส่งออกจริง:', req.kind, req.text ?? req.altText)
  } else if (req.targetType === 'broadcast') {
    outcome = await broadcastText(req.text ?? '')
  } else if (req.kind === 'flex') {
    outcome = await pushFlex(req.targetId ?? '', req.altText ?? 'ข้อความจากระบบ', req.contents)
  } else {
    outcome = await pushText(req.targetId ?? '', req.text ?? '')
  }

  const status = req.dryRun ? 'dry-run' : outcome.status
  const preview = (req.text ?? req.altText ?? '').slice(0, 500)
  const payload = req.kind === 'flex' ? { altText: req.altText, contents: req.contents } : { text: req.text }

  const logId = await insertLog({
    targetType: req.targetType,
    targetId: req.targetId ?? null,
    targetName: req.targetName ?? null,
    kind: req.kind,
    preview,
    payload,
    status,
    error: outcome.error ?? null,
    sentBy: req.sentBy
  })

  return { ...outcome, status: outcome.status, logId }
}

// ---------------------------------------------------------------------------
// ตอบกลับอัตโนมัติจาก webhook (follow / rich menu / แชท 1:1) + บันทึก log
// ใช้ reply token แทน push จึงไม่กินโควตาข้อความ แต่ยังต้องมีร่องรอยใน message_logs
// ---------------------------------------------------------------------------

export interface ReplyRequest {
  replyToken: string
  /** ปลายทางที่ตอบกลับ (ค่าเริ่มต้น user) */
  targetType?: 'user' | 'group'
  /** userId หรือ groupId ของปลายทาง */
  targetId?: string
  /** ข้อความ (kind text) หรือ altText (kind flex) */
  text: string
  /** ค่าเริ่มต้น text */
  kind?: 'text' | 'flex'
  /** Flex contents เมื่อ kind = flex */
  contents?: unknown
  /** quick reply แนบท้ายข้อความ (ไม่บังคับ) */
  quickReply?: unknown
  /** ระบุที่มาของการตอบ เช่น auto-reply:follow, auto-reply:postback */
  sentBy: string
}

export async function replyAndLog(req: ReplyRequest): Promise<SendResult> {
  const kind = req.kind ?? 'text'
  const outcome =
    kind === 'flex'
      ? await replyFlex(req.replyToken, req.text, req.contents, req.quickReply)
      : await replyText(req.replyToken, req.text, req.quickReply)

  const logId = await insertLog({
    targetType: req.targetType ?? 'user',
    targetId: req.targetId ?? null,
    targetName: null,
    kind,
    preview: req.text.slice(0, 500),
    payload: kind === 'flex' ? { altText: req.text, contents: req.contents } : { text: req.text },
    status: outcome.status,
    error: outcome.error ?? null,
    sentBy: req.sentBy
  })

  return { ...outcome, logId }
}

interface LogEntry {
  targetType: string
  targetId: string | null
  targetName: string | null
  kind: string
  preview: string
  payload: unknown
  status: string
  error: string | null
  sentBy: string
}

/** บันทึกลง message_logs - ถ้า DB พังก็แค่ log ไว้ ไม่ throw เพราะข้อความส่งออกไปแล้ว */
async function insertLog(entry: LogEntry): Promise<number | null> {
  try {
    const rows = await query<{ id: number }>(
      `INSERT INTO message_logs
         (target_type, target_id, target_name, message_kind, preview, payload, status, error, sent_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        entry.targetType,
        entry.targetId,
        entry.targetName,
        entry.kind,
        entry.preview,
        JSON.stringify(entry.payload),
        entry.status,
        entry.error,
        entry.sentBy
      ]
    )
    return rows[0]?.id ?? null
  } catch (err) {
    console.error('[Log] บันทึก message_logs ไม่สำเร็จ:', err instanceof Error ? err.message : err)
    return null
  }
}

export interface MessageLogRow {
  id: number
  target_type: string
  target_id: string | null
  target_name: string | null
  message_kind: string
  preview: string | null
  status: string
  error: string | null
  sent_by: string | null
  created_at: Date
}

export async function listLogs(limit = 100): Promise<MessageLogRow[]> {
  return query<MessageLogRow>(
    `SELECT id, target_type, target_id, target_name, message_kind, preview, status, error, sent_by, created_at
       FROM message_logs
      ORDER BY created_at DESC
      LIMIT $1`,
    [limit]
  )
}
