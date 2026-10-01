import amqp, { type Channel, type ChannelModel, type ConsumeMessage } from 'amqplib'
import { config } from '../config'
import { sendAndLog } from './messaging'
import { claimForSend } from './maintenanceEvents'
import { pushReporterUpdate } from './complaintChat'
import {
  buildComplaintNewCard,
  buildComplaintSlaCard,
  buildComplaintStatusCard,
  type ComplaintRecipient,
  type ComplaintSlaBreached,
  type ComplaintStatusChanged,
  type ComplaintSubmitted
} from './complaintFlex'

// ---------------------------------------------------------------------------
// Consumer ของ RabbitMQ: รับ event จากระบบรับเรื่องร้องเรียน (exchange "complaint.events") แล้วส่งการ์ดด้วย OA HR
//
// สัญญา (complaint.v1) — Complaint.Api เป็นคนตัดสินใจ "ส่งถึงใคร" (recipients[] = C… กลุ่ม / U… บุคคล
// และตัดกลุ่มออกแล้วสำหรับหมวด Restricted) แอปนี้ตัดสินใจ "ส่งอย่างไร" (การ์ด, OA, dedupe, log)
//   complaint.submitted        -> การ์ดเรื่องใหม่ (มี hero = thumbnail รูปแรก ถ้ามี)
//   complaint.status_changed   -> การ์ดสถานะเปลี่ยน
//   complaint.sla_breached     -> การ์ดเกิน SLA
// แล้ว publish ผลกลับเป็น complaint.notification.result ให้ Complaint.Api อัปเดต notification_log
// JSON เป็น camelCase (System.Text.Json แบบ Web)
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>

let connection: ChannelModel | null = null
let channel: Channel | null = null
let stopping = false
let reconnectDelayMs = 2000
const stats = { consumed: 0, sent: 0, skipped: 0, deduped: 0, failed: 0, lastEventAt: null as string | null, lastError: null as string | null }

const seen = new Map<string, number>()
const SEEN_TTL_MS = 6 * 60 * 60 * 1000
function isDuplicate(id: string): boolean {
  const now = Date.now()
  for (const [k, t] of seen) if (now - t > SEEN_TTL_MS) seen.delete(k)
  if (seen.has(id)) return true
  seen.set(id, now)
  return false
}

const cfg = {
  get url() {
    return (process.env.RABBITMQ_URL ?? '').trim()
  },
  exchange: process.env.COMPLAINT_EVENT_EXCHANGE ?? 'complaint.events',
  queue: process.env.COMPLAINT_EVENT_QUEUE ?? 'line-workflow.complaint',
  routingKeys: ['complaint.submitted', 'complaint.status_changed', 'complaint.sla_breached', 'complaint.reporter_update'],
  // routing key ตามกติกาของ Complaint.Api: ComplaintNotificationResultIntegrationEvent -> complaint.notification_result
  resultKey: 'complaint.notification_result',
  dedupeHours: Number(process.env.COMPLAINT_EVENT_DEDUPE_HOURS ?? 1),
  get enabled() {
    return this.url !== '' && (process.env.COMPLAINT_EVENTS_ENABLED ?? 'true') !== 'false'
  }
}

interface DeliveryResult {
  targetId: string
  status: string
  error: string | null
  messageLogId: number | null
}

async function pushToRecipients(
  recipients: ComplaintRecipient[],
  card: { contents: unknown; altText: string },
  sentBy: string
): Promise<DeliveryResult[]> {
  const results: DeliveryResult[] = []
  for (const r of recipients) {
    const id = (r.targetId ?? '').trim()
    if (!/^[CRU][0-9a-f]{32}$/.test(id)) {
      results.push({ targetId: id, status: 'failed', error: 'รูปแบบ target id ไม่ถูกต้อง', messageLogId: null })
      continue
    }
    const res = await sendAndLog({
      targetType: id.startsWith('U') ? 'user' : 'group',
      targetId: id,
      targetName: r.targetName ?? undefined,
      kind: 'flex',
      altText: card.altText,
      contents: card.contents,
      sentBy,
      channel: 'hr'
    })
    results.push({ targetId: id, status: res.status, error: res.error ?? null, messageLogId: res.logId })
  }
  return results
}

async function publishResult(ch: Channel, sourceEventId: string, ticketNo: string, results: DeliveryResult[]): Promise<void> {
  const payload = {
    id: crypto.randomUUID(),
    occurredAt: new Date().toISOString(),
    sourceEventId,
    ticketNo,
    results
  }
  ch.publish(cfg.exchange, cfg.resultKey, Buffer.from(JSON.stringify(payload), 'utf8'), {
    contentType: 'application/json',
    persistent: true,
    messageId: payload.id,
    type: cfg.resultKey
  })
}

async function handleMessage(ch: Channel, msg: ConsumeMessage): Promise<void> {
  const key = msg.fields.routingKey
  stats.consumed++
  stats.lastEventAt = new Date().toISOString()

  let payload: Json
  try {
    payload = JSON.parse(msg.content.toString('utf8')) as Json
  } catch {
    stats.skipped++
    console.warn(`[complaint-events] ข้าม ${key}: body ไม่ใช่ JSON`)
    return
  }
  const eventId = String(payload.id ?? msg.properties.messageId ?? '')
  const ticketNo = String(payload.ticketNo ?? '')
  if (eventId && isDuplicate(eventId)) {
    stats.skipped++
    return
  }
  // การ์ดถึงผู้ร้องเรียนที่ opt-in: ไม่มี recipients[] แต่มี lineUserIds[] และไม่ต้องรายงานผลกลับ
  if (key === 'complaint.reporter_update') {
    const ids = (Array.isArray(payload.lineUserIds) ? payload.lineUserIds : []).map(String).filter((u) => /^U[0-9a-f]{32}$/.test(u))
    if (ids.length === 0) { stats.skipped++; return }
    const ok = await pushReporterUpdate({ ticketNo, toStatusTh: String(payload.toStatusTh ?? payload.toStatus ?? ''), publicNote: (payload.publicNote as string | null) ?? null, trackUrl: String(payload.trackUrl ?? ''), lineUserIds: ids })
    if (ok > 0) stats.sent++; else stats.failed++
    console.log(`[complaint-events] reporter_update ${ticketNo} -> ส่ง ${ok}/${ids.length}`)
    return
  }
  const recipients = (Array.isArray(payload.recipients) ? payload.recipients : []) as ComplaintRecipient[]
  if (recipients.length === 0) {
    stats.skipped++
    console.warn(`[complaint-events] ${key} ${ticketNo}: ไม่มีผู้รับ (ตั้งค่าผู้รับเรื่องของหมวดในระบบร้องเรียน)`)
    return
  }

  let card: { contents: unknown; altText: string }
  let dedupeKey: string
  if (key === 'complaint.submitted') {
    card = buildComplaintNewCard({ ...(payload as unknown as ComplaintSubmitted), eventId })
    dedupeKey = `complaint:${ticketNo}:new`
  } else if (key === 'complaint.status_changed') {
    const e = payload as unknown as ComplaintStatusChanged
    card = buildComplaintStatusCard({ ...e, eventId })
    dedupeKey = `complaint:${ticketNo}:status:${e.toStatus}`
  } else if (key === 'complaint.sla_breached') {
    const e = payload as unknown as ComplaintSlaBreached
    card = buildComplaintSlaCard({ ...e, eventId })
    dedupeKey = `complaint:${ticketNo}:sla:${e.slaKind}`
  } else {
    stats.skipped++
    return
  }

  // "ส่งซ้ำ" จาก console ตั้งใจส่งเดิมอีกครั้ง — Complaint.Api ออก eventId ใหม่ แต่ dedupe ตามเนื้อหายังกันภายใน 1 ชม.
  // เพื่อไม่ให้ admin กดรัว ๆ แล้วกลุ่มได้การ์ดเดิม 5 ใบ
  if (cfg.dedupeHours > 0 && !(await claimForSend(dedupeKey, cfg.dedupeHours))) {
    stats.deduped++
    console.log(`[complaint-events] ข้าม ${key} ${ticketNo}: ส่งไปแล้วภายใน ${cfg.dedupeHours} ชม.`)
    await publishResult(ch, eventId, ticketNo, recipients.map((r) => ({ targetId: r.targetId, status: 'failed', error: `ส่งไปแล้วภายใน ${cfg.dedupeHours} ชม. (กันซ้ำ)`, messageLogId: null })))
    return
  }

  const results = await pushToRecipients(recipients, card, `complaint-events:${key}`)
  const ok = results.filter((r) => r.status === 'sent' || r.status === 'mock').length
  if (ok > 0) stats.sent++
  else stats.failed++
  console.log(
    `[complaint-events] ${key} ${ticketNo} -> ส่ง ${ok}/${results.length}` +
      (ok < results.length ? ` (${results.filter((r) => r.status === 'failed').map((r) => `${r.targetId.slice(0, 6)}…: ${r.error}`).join('; ')})` : '')
  )
  await publishResult(ch, eventId, ticketNo, results)
}

async function connect(): Promise<void> {
  const url = /[?&]heartbeat=/.test(cfg.url) ? cfg.url : `${cfg.url}${cfg.url.includes('?') ? '&' : '?'}heartbeat=30`
  const conn = await amqp.connect(url)
  const ch = await conn.createChannel()
  await ch.assertExchange(cfg.exchange, 'topic', { durable: true })
  await ch.assertQueue(cfg.queue, { durable: true })
  for (const key of cfg.routingKeys) await ch.bindQueue(cfg.queue, cfg.exchange, key)
  await ch.prefetch(3)

  conn.on('error', (err) => {
    stats.lastError = err instanceof Error ? err.message : String(err)
    console.error('[complaint-events] การเชื่อมต่อ RabbitMQ ผิดพลาด:', stats.lastError)
  })
  conn.on('close', () => {
    connection = null
    channel = null
    if (stopping) return
    console.warn(`[complaint-events] หลุดจาก RabbitMQ จะเชื่อมต่อใหม่ใน ${reconnectDelayMs / 1000}s`)
    setTimeout(() => void connectWithRetry(), reconnectDelayMs)
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, 60000)
  })

  await ch.consume(cfg.queue, (msg) => {
    if (!msg) return
    void handleMessage(ch, msg)
      .catch((err) => {
        stats.failed++
        stats.lastError = err instanceof Error ? err.message : String(err)
        console.error(`[complaint-events] ประมวลผล ${msg.fields.routingKey} ไม่สำเร็จ:`, stats.lastError)
      })
      .finally(() => {
        try {
          ch.ack(msg)
        } catch {
          /* channel ปิดแล้ว */
        }
      })
  })

  connection = conn
  channel = ch
  reconnectDelayMs = 2000
  console.log(`[complaint-events] รับ event จาก RabbitMQ แล้ว (exchange ${cfg.exchange}, queue ${cfg.queue})`)
}

async function connectWithRetry(): Promise<void> {
  if (stopping || connection) return
  try {
    await connect()
  } catch (err) {
    stats.lastError = err instanceof Error ? err.message : String(err)
    console.error(`[complaint-events] เชื่อมต่อ RabbitMQ ไม่ได้ (${stats.lastError}) จะลองใหม่ใน ${reconnectDelayMs / 1000}s`)
    setTimeout(() => void connectWithRetry(), reconnectDelayMs)
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, 60000)
  }
}

export function startComplaintEventConsumer(): void {
  if (!cfg.enabled) {
    console.log('[complaint-events] ปิดอยู่ (ไม่ได้ตั้ง RABBITMQ_URL หรือ COMPLAINT_EVENTS_ENABLED=false)')
    return
  }
  stopping = false
  void connectWithRetry()
}

export async function stopComplaintEventConsumer(): Promise<void> {
  stopping = true
  try {
    await channel?.close()
    await connection?.close()
  } catch {
    /* ignore */
  }
  channel = null
  connection = null
}

export function complaintEventsStatus(): Record<string, unknown> {
  if (!cfg.enabled) return { enabled: false }
  return { enabled: true, connected: connection !== null, exchange: cfg.exchange, queue: cfg.queue, ...stats, mockLine: config.mockLine }
}
