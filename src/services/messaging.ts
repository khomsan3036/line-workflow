import { query } from '../db'
import {
  broadcastText,
  isBotInGroup,
  pushFlex,
  pushText,
  replyFlex,
  replyText,
  type ChannelKey,
  type SendOutcome
} from '../line/client'

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
  /** OA ที่ใช้ส่ง (ค่าเริ่มต้น hr = OA หลัก) */
  channel?: ChannelKey
}

export interface SendResult extends SendOutcome {
  logId: number | null
}

export async function sendAndLog(req: SendRequest): Promise<SendResult> {
  let outcome: SendOutcome
  const channel = req.channel ?? 'hr'

  if (req.dryRun) {
    // dry-run = ประกอบข้อความจริงแต่ไม่ส่งออก ใช้ตรวจหน้าตาก่อนยิงของจริง
    outcome = { status: 'sent' }
    console.log('[DRY-RUN] ไม่ส่งออกจริง:', req.kind, req.text ?? req.altText)
  } else if (req.targetType === 'broadcast') {
    outcome = await broadcastText(req.text ?? '')
  } else if (req.kind === 'flex') {
    outcome = await pushFlex(req.targetId ?? '', req.altText ?? 'ข้อความจากระบบ', req.contents, channel)
  } else {
    outcome = await pushText(req.targetId ?? '', req.text ?? '', channel)
  }

  // "Failed to send messages" จาก LINE บอกแค่ว่าส่งไม่ได้ ไม่บอกสาเหตุ กรณีที่พบบ่อยที่สุดคือบอทไม่ได้อยู่ในกลุ่ม
  // (กลุ่มถูกบันทึกไว้ตอนใช้ OA อื่น หรือถูกเชิญออก) จึงตรวจให้แล้วอธิบายเป็นภาษาคน
  if (outcome.status === 'failed' && req.targetType === 'group' && req.targetId) {
    outcome = { ...outcome, error: await explainGroupSendError(req.targetId, outcome.error, channel) }
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
    sentBy: req.sentBy,
    channel
  })

  return { ...outcome, status: outcome.status, logId }
}

const CHANNEL_LABEL: Record<ChannelKey, string> = { hr: 'HR Notification', mt: 'MT Notification' }

/** เติมคำอธิบายให้ error ตอนส่งเข้ากลุ่มไม่สำเร็จ (ตรวจว่าบอทยังอยู่ในกลุ่มหรือไม่) */
export async function explainGroupSendError(
  groupId: string,
  error: string | undefined,
  channel: ChannelKey
): Promise<string> {
  const raw = error ?? 'ไม่ทราบสาเหตุ'
  if (!/failed to send messages/i.test(raw)) return raw
  const inGroup = await isBotInGroup(groupId, channel)
  if (inGroup === false) {
    const other: ChannelKey = channel === 'hr' ? 'mt' : 'hr'
    const otherInGroup = await isBotInGroup(groupId, other)
    if (otherInGroup) {
      return `${raw} - บอท "${CHANNEL_LABEL[channel]}" ไม่ได้อยู่ในกลุ่มนี้ แต่บอท "${CHANNEL_LABEL[other]}" อยู่ ให้เลือก "ส่งจาก OA" เป็น ${CHANNEL_LABEL[other]} แล้วส่งใหม่`
    }
    return (
      `${raw} - บอท "${CHANNEL_LABEL[channel]}" ไม่ได้อยู่ในกลุ่มนี้ (กลุ่มอาจถูกบันทึกไว้ตอนใช้ OA อื่น หรือบอทถูกเชิญออก) ` +
      `ให้เชิญ OA "${CHANNEL_LABEL[channel]}" เข้ากลุ่มแล้วส่งใหม่ (groupId ${groupId})`
    )
  }
  return `${raw} - LINE ปฏิเสธการส่งเข้ากลุ่มนี้ ตรวจว่าบอทยังอยู่ในกลุ่ม และกลุ่มไม่ได้ตั้งค่าบล็อกข้อความจาก OA`
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
  /** OA ที่ใช้ตอบ (ค่าเริ่มต้น hr = OA หลัก) */
  channel?: ChannelKey
}

export async function replyAndLog(req: ReplyRequest): Promise<SendResult> {
  const kind = req.kind ?? 'text'
  const channel = req.channel ?? 'hr'
  const outcome =
    kind === 'flex'
      ? await replyFlex(req.replyToken, req.text, req.contents, req.quickReply, channel)
      : await replyText(req.replyToken, req.text, req.quickReply, channel)

  const logId = await insertLog({
    targetType: req.targetType ?? 'user',
    targetId: req.targetId ?? null,
    targetName: null,
    kind,
    preview: req.text.slice(0, 500),
    payload: kind === 'flex' ? { altText: req.text, contents: req.contents } : { text: req.text },
    status: outcome.status,
    error: outcome.error ?? null,
    sentBy: req.sentBy,
    channel
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
  channel: ChannelKey
}

/**
 * บันทึกแถว failed ของข้อความที่ประกอบไม่สำเร็จจึงไม่ได้ส่ง (เช่น อ่านฐานข้อมูลไม่ทัน)
 * ให้หน้าประวัติการส่งเห็นว่างานตั้งเวลาทำงานแล้วแต่พัง แทนที่จะเงียบหายไป
 */
export async function logFailedSend(req: Omit<SendRequest, 'dryRun' | 'contents'> & { error: string }): Promise<number | null> {
  return insertLog({
    targetType: req.targetType,
    targetId: req.targetId ?? null,
    targetName: req.targetName ?? null,
    kind: req.kind,
    preview: (req.text ?? req.altText ?? '').slice(0, 500),
    payload: null,
    status: 'failed',
    error: req.error,
    sentBy: req.sentBy,
    channel: req.channel ?? 'hr'
  })
}

/** บันทึกลง message_logs - ถ้า DB พังก็แค่ log ไว้ ไม่ throw เพราะข้อความส่งออกไปแล้ว */
async function insertLog(entry: LogEntry): Promise<number | null> {
  try {
    const rows = await query<{ id: number }>(
      `INSERT INTO message_logs
         (target_type, target_id, target_name, message_kind, preview, payload, status, error, sent_by, channel)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
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
        entry.sentBy,
        entry.channel
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
  channel: string
  created_at: Date
}

export async function listLogs(limit = 100): Promise<MessageLogRow[]> {
  return query<MessageLogRow>(
    `SELECT id, target_type, target_id, target_name, message_kind, preview, status, error, sent_by, channel, created_at
       FROM message_logs
      ORDER BY created_at DESC
      LIMIT $1`,
    [limit]
  )
}
