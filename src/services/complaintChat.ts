import { config } from '../config'
import { replyAndLog, sendAndLog } from './messaging'
import { buildComplaintDigestCard, buildReporterUpdateCard } from './complaintFlex'

// ---------------------------------------------------------------------------
// ส่วนโต้ตอบของระบบรับเรื่องร้องเรียนในแชท (OA HR)
//   - ปุ่ม "รับเรื่อง" บนการ์ด (postback complaint=ack&t=<ticket>) -> Complaint.Api /integration/line/acknowledge
//   - ผู้ร้องเรียนพิมพ์ "ติดตาม CP-2026-00001 123456" -> ผูก userId กับเรื่อง เพื่อรับแจ้งความคืบหน้า
//   - ยอดเรื่องค้าง (digest) สำหรับงานตั้งเวลา
// Complaint.Api ตรวจสิทธิ์เองทั้งหมด (LINE userId ต้องผูกกับ staff) แอปนี้แค่ส่งต่อและตอบผล
// ---------------------------------------------------------------------------

const api = {
  get base() {
    return (process.env.COMPLAINT_API_URL ?? '').trim().replace(/\/$/, '')
  },
  get token() {
    return (process.env.COMPLAINT_SERVICE_TOKEN ?? '').trim()
  },
  get enabled() {
    return this.base !== '' && this.token !== ''
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${api.base}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', 'x-service-token': api.token, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(15000)
  })
  if (!res.ok) throw new Error(`Complaint.Api ${path} -> HTTP ${res.status}`)
  return (await res.json()) as T
}

export function complaintAckPostback(ticketNo: string): string {
  return `complaint=ack&t=${encodeURIComponent(ticketNo)}`
}

/** ปุ่ม "รับเรื่อง" บนการ์ด: true = จัดการแล้ว */
export async function handleComplaintPostback(args: { data: string; replyToken: string; userId: string; targetType: 'user' | 'group'; targetId: string }): Promise<boolean> {
  const m = /^complaint=ack&t=([^&]+)$/.exec(args.data)
  if (!m) return false
  const ticketNo = decodeURIComponent(m[1])
  let text: string
  if (!api.enabled) text = 'ยังไม่ได้ตั้งค่า COMPLAINT_API_URL / COMPLAINT_SERVICE_TOKEN'
  else {
    try {
      const r = await call<{ ok: boolean; message: string }>('/api/integration/line/acknowledge', { method: 'POST', body: JSON.stringify({ ticketNo, lineUserId: args.userId }) })
      text = (r.ok ? '✅ ' : '⚠️ ') + r.message
    } catch (err) {
      text = `⚠️ ติดต่อระบบรับเรื่องร้องเรียนไม่ได้: ${err instanceof Error ? err.message : String(err)}`
    }
  }
  await replyAndLog({ replyToken: args.replyToken, targetType: args.targetType, targetId: args.targetId, text, sentBy: 'complaint:ack-postback' })
  console.log(`[complaint] postback ack ${ticketNo} by ${args.userId.slice(0, 8)}… -> ${text.slice(0, 60)}`)
  return true
}

const TRACK_RE = /^(?:ติดตาม|track)\s+(CP-\d{4}-\d{5})\s+(\d{6})\s*$/i

/** ผู้ร้องเรียนพิมพ์ "ติดตาม CP-2026-00001 123456" ในแชท 1:1: true = จัดการแล้ว */
export async function handleComplaintTrackMessage(args: { text: string; replyToken: string; userId: string }): Promise<boolean> {
  const m = TRACK_RE.exec(args.text.trim())
  if (!m) return false
  let text: string
  if (!api.enabled) text = 'ระบบติดตามเรื่องร้องเรียนยังไม่เปิดใช้งาน'
  else {
    try {
      const r = await call<{ ok: boolean; message: string }>('/api/integration/line/link-reporter', { method: 'POST', body: JSON.stringify({ ticketNo: m[1].toUpperCase(), trackingCode: m[2], lineUserId: args.userId }) })
      text = (r.ok ? '🔔 ' : '⚠️ ') + r.message
    } catch (err) {
      text = `⚠️ ติดต่อระบบรับเรื่องร้องเรียนไม่ได้: ${err instanceof Error ? err.message : String(err)}`
    }
  }
  await replyAndLog({ replyToken: args.replyToken, targetType: 'user', targetId: args.userId, text, sentBy: 'complaint:track-link' })
  return true
}

export interface ComplaintDigest {
  asOf: string
  open: number
  newToday: number
  resolvedToday: number
  unacknowledged: number
  overdue: number
  byCategory: { category: string; count: number }[]
  overdueItems: { ticketNo: string; status: string; cat: string; assigneeName: string | null; vehiclePlate: string | null; severity: string; dueAt: string }[]
  consoleUrl: string
}

/** งานตั้งเวลา: การ์ดสรุปเรื่องร้องเรียนค้าง -> COMPLAINT_DIGEST_GROUP_IDS */
export async function runComplaintDigest(opts: { dryRun?: boolean; to?: string[] } = {}): Promise<{ sent: number; digest: ComplaintDigest | null }> {
  if (!api.enabled) {
    console.warn('[complaint-digest] ปิดอยู่ (ไม่ได้ตั้ง COMPLAINT_API_URL / COMPLAINT_SERVICE_TOKEN)')
    return { sent: 0, digest: null }
  }
  const digest = await call<ComplaintDigest>('/api/integration/digest')
  const targets = opts.to ?? (process.env.COMPLAINT_DIGEST_GROUP_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const card = buildComplaintDigestCard(digest)
  let sent = 0
  for (const id of targets) {
    const r = await sendAndLog({ targetType: id.startsWith('U') ? 'user' : 'group', targetId: id, kind: 'flex', altText: card.altText, contents: card.contents, sentBy: 'scheduler:complaint-digest', channel: 'hr', dryRun: opts.dryRun })
    if (r.status !== 'failed') sent++
  }
  console.log(`[complaint-digest] เปิด ${digest.open} · ยังไม่รับ ${digest.unacknowledged} · เกิน SLA ${digest.overdue} -> ส่ง ${sent}/${targets.length}`)
  return { sent, digest }
}

/** การ์ดแจ้งผู้ร้องเรียนที่ opt-in (จาก event complaint.reporter_update) */
export async function pushReporterUpdate(e: { ticketNo: string; toStatusTh: string; publicNote?: string | null; trackUrl: string; lineUserIds: string[] }): Promise<number> {
  const card = buildReporterUpdateCard(e)
  let ok = 0
  for (const uid of e.lineUserIds) {
    const r = await sendAndLog({ targetType: 'user', targetId: uid, kind: 'flex', altText: card.altText, contents: card.contents, sentBy: 'complaint-events:reporter_update', channel: 'hr' })
    if (r.status === 'sent' || r.status === 'mock') ok++
  }
  return ok
}

export function complaintChatStatus(): Record<string, unknown> {
  return { enabled: api.enabled, apiUrl: api.base || null, digestTargets: (process.env.COMPLAINT_DIGEST_GROUP_IDS ?? '').split(',').filter(Boolean).length, tz: config.timezone }
}
