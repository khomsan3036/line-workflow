import { query } from '../db'
import { broadcastText, pushFlex, pushText, type SendOutcome } from '../line/client'

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

  let logId: number | null = null
  try {
    const rows = await query<{ id: number }>(
      `INSERT INTO message_logs
         (target_type, target_id, target_name, message_kind, preview, payload, status, error, sent_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        req.targetType,
        req.targetId ?? null,
        req.targetName ?? null,
        req.kind,
        preview,
        JSON.stringify(payload),
        status,
        outcome.error ?? null,
        req.sentBy
      ]
    )
    logId = rows[0]?.id ?? null
  } catch (err) {
    console.error('[Log] บันทึก message_logs ไม่สำเร็จ:', err instanceof Error ? err.message : err)
  }

  return { ...outcome, status: outcome.status, logId }
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
