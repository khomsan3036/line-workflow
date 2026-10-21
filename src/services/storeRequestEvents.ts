import amqp, { type Channel, type ChannelModel, type ConsumeMessage } from 'amqplib'
import { config } from '../config'
import { closeAbandonedConnection, describeAmqpError, warnIfLocalhostBrokerInContainer } from './amqpUtil'
import { queryOne } from '../db'
import { sendAndLog } from './messaging'
import { claimForSend } from './maintenanceEvents'
import { buildStoreRequestCard, type StoreRequestEvent, type StoreRequestKind } from './storeRequestFlex'

// ---------------------------------------------------------------------------
// Consumer ของ RabbitMQ: ใบขอเบิก/ขอยืมจาก qtec-integra (integra-store-service) -> การ์ดเข้ากลุ่มทีมสโตร์ด้วย OA HR
//
// exchange "integra-drawing" (topic, ใช้ร่วมกันทุก service ของ integra) routing key:
//   store.request.submitted   ยื่นใบขอ (ยังไม่อนุมัติ)            -> kind submitted
//   store.request.decided     สายอนุมัติจบ decision approved/rejected -> kind approved / rejected
//   store.request.fulfilled   สโตร์จ่ายของ (บางส่วน/ครบ) docNos[]   -> kind fulfilled
//   store.request.cancelled   ผู้ขอยกเลิก                         -> kind cancelled
// ปลายทาง = STORE_REQUEST_LINE_TARGETS (C… กลุ่ม / U… บุคคล) ชนิดที่ส่ง = STORE_REQUEST_LINE_EVENTS
// ฝั่ง integra ส่งอีเมลรายบุคคลอยู่แล้ว (integra-notification-service) แอปนี้ทำเฉพาะการ์ดเข้า LINE
// JSON เป็น camelCase (System.Text.Json แบบ Web) — event รุ่นก่อน 2026-10-19 ไม่มี items[] การ์ดจะแสดงแค่จำนวนรายการ
// ---------------------------------------------------------------------------

const cfg = {
  ...config.storeRequest,
  routingKeys: ['store.request.submitted', 'store.request.decided', 'store.request.fulfilled', 'store.request.cancelled']
}

let connection: ChannelModel | null = null
let channel: Channel | null = null
let stopping = false
let reconnectDelayMs = 2000
const stats = { consumed: 0, sent: 0, filtered: 0, skipped: 0, deduped: 0, failed: 0, lastEventAt: null as string | null, lastError: null as string | null }

const seen = new Map<string, number>()
const SEEN_TTL_MS = 6 * 60 * 60 * 1000
function isDuplicate(id: string): boolean {
  const now = Date.now()
  for (const [k, t] of seen) if (now - t > SEEN_TTL_MS) seen.delete(k)
  if (seen.has(id)) return true
  seen.set(id, now)
  return false
}

/** routing key + payload -> ชนิดการ์ด (null = ไม่รู้จัก) */
export function storeRequestKind(routingKey: string, payload: StoreRequestEvent): StoreRequestKind | null {
  switch (routingKey) {
    case 'store.request.submitted':
      return 'submitted'
    case 'store.request.decided':
      return String(payload.decision ?? '').toLowerCase() === 'rejected' ? 'rejected' : 'approved'
    case 'store.request.fulfilled':
      return 'fulfilled'
    case 'store.request.cancelled':
      return 'cancelled'
    default:
      return null
  }
}

/** ส่งการ์ดของ event เดียวไปทุกปลายทาง ใช้ทั้ง consumer และสคริปต์ทดสอบ */
export async function deliverStoreRequestCard(opts: {
  kind: StoreRequestKind
  event: StoreRequestEvent
  targets: string[]
  sentBy: string
  dryRun?: boolean
}): Promise<Array<{ targetId: string; status: string; error: string | null }>> {
  const card = buildStoreRequestCard(opts.kind, opts.event, cfg.webUrl)
  const results: Array<{ targetId: string; status: string; error: string | null }> = []
  for (const raw of opts.targets) {
    const id = raw.trim()
    if (!/^[CRU][0-9a-f]{32}$/.test(id)) {
      results.push({ targetId: id, status: 'failed', error: 'รูปแบบ target id ไม่ถูกต้อง (ต้องเป็น C…/U… 33 ตัว)' })
      continue
    }
    const res = await sendAndLog({
      targetType: id.startsWith('U') ? 'user' : 'group',
      targetId: id,
      kind: 'flex',
      altText: card.altText,
      contents: card.contents,
      sentBy: opts.sentBy,
      channel: 'hr',
      dryRun: opts.dryRun
    })
    results.push({ targetId: id, status: res.status, error: res.error ?? null })
  }
  return results
}

/** เคยส่งการ์ดของใบขอนี้ไปแล้วหรือยัง (ดูจากคีย์กันซ้ำ) — ตารางใช้ไม่ได้ = ถือว่าเคย (แจ้งเกินดีกว่าตกหล่น) */
async function groupSawRequest(reqId: string): Promise<boolean> {
  if (cfg.dedupeHours <= 0) return true // ไม่ได้เก็บคีย์ จึงรู้ไม่ได้
  try {
    const row = await queryOne<{ dedupe_key: string }>(
      `SELECT dedupe_key FROM maintenance_alert_dedupe WHERE dedupe_key LIKE $1 AND dedupe_key NOT LIKE $2 LIMIT 1`,
      [`store-request:${reqId}:%`, `store-request:${reqId}:cancelled%`]
    )
    return row !== null
  } catch {
    return true
  }
}

async function handleMessage(msg: ConsumeMessage): Promise<void> {
  const key = msg.fields.routingKey
  stats.consumed++
  stats.lastEventAt = new Date().toISOString()

  let payload: StoreRequestEvent
  try {
    payload = JSON.parse(msg.content.toString('utf8')) as StoreRequestEvent
  } catch {
    stats.skipped++
    console.warn(`[store-events] ข้าม ${key}: body ไม่ใช่ JSON`)
    return
  }
  const kind = storeRequestKind(key, payload)
  if (!kind || !payload.reqId) {
    stats.skipped++
    return
  }
  const eventId = String(payload.eventId ?? msg.properties.messageId ?? '')
  if (eventId && isDuplicate(eventId)) {
    stats.skipped++
    return
  }
  if (!cfg.events.includes(kind)) {
    stats.filtered++
    return
  }
  // ยกเลิกใบที่กลุ่มไม่เคยเห็น (ยกเลิกก่อนอนุมัติ ขณะไม่ได้ส่งการ์ด submitted) = ไม่ต้องแจ้ง ไม่งั้นทีมสโตร์งงว่าใบไหน
  if (kind === 'cancelled' && !(await groupSawRequest(payload.reqId))) {
    stats.filtered++
    console.log(`[store-events] ข้าม cancelled ${payload.reqId}: ยังไม่เคยส่งการ์ดใบนี้ (ยกเลิกก่อนอนุมัติ)`)
    return
  }

  // จ่ายบางส่วนหลายครั้ง = การ์ดแยกกันตามเลขเอกสาร
  const dedupeKey = `store-request:${payload.reqId}:${kind}${kind === 'fulfilled' && payload.docNos?.length ? `:${payload.docNos.join('+')}` : ''}`
  if (cfg.dedupeHours > 0 && !(await claimForSend(dedupeKey, cfg.dedupeHours))) {
    stats.deduped++
    console.log(`[store-events] ข้าม ${key} ${payload.reqId}: ส่งไปแล้วภายใน ${cfg.dedupeHours} ชม.`)
    return
  }

  const results = await deliverStoreRequestCard({ kind, event: payload, targets: cfg.targets, sentBy: `store-events:${key}` })
  const ok = results.filter((r) => r.status === 'sent' || r.status === 'mock').length
  if (ok > 0) stats.sent++
  else stats.failed++
  console.log(
    `[store-events] ${key} ${payload.reqId} (${kind}) -> ส่ง ${ok}/${results.length}` +
      (ok < results.length ? ` (${results.filter((r) => r.status === 'failed').map((r) => `${r.targetId.slice(0, 6)}…: ${r.error}`).join('; ')})` : '')
  )
}

async function connect(): Promise<void> {
  const url = /[?&]heartbeat=/.test(cfg.url) ? cfg.url : `${cfg.url}${cfg.url.includes('?') ? '&' : '?'}heartbeat=30`
  const conn = await amqp.connect(url)
  // ผูก listener 'error' ทันที: amqplib โยน error ของ channel ที่ไม่มีใครฟังขึ้นมาเป็น 'error' ของ connection
  // ถ้ายังไม่ได้ผูกตอน assertExchange/assertQueue ล้ม (เช่น exchange ประกาศไว้คนละชนิด) process จะตายทั้งตัว
  conn.on('error', (err) => {
    stats.lastError = describeAmqpError(err)
    console.error('[store-events] การเชื่อมต่อ RabbitMQ ผิดพลาด:', stats.lastError)
  })
  // ต่อ broker ได้แล้วแต่ขั้นถัดไปล้ม (เช่น exchange ถูกประกาศไว้คนละชนิด) ต้องปิด connection ก่อน throw ไม่งั้นค้างทุกรอบที่ลองใหม่
  try {
    const ch = await conn.createChannel()
    ch.on('error', (err) => {
      stats.lastError = describeAmqpError(err)
      console.error('[store-events] channel RabbitMQ ผิดพลาด:', stats.lastError)
    })
    // ประกาศให้ตรงกับฝั่ง .NET (RabbitMqEventBus: topic, durable) ไม่งั้น broker ปิด channel ด้วย PRECONDITION_FAILED
    await ch.assertExchange(cfg.exchange, 'topic', { durable: true })
    await ch.assertQueue(cfg.queue, { durable: true })
    for (const key of cfg.routingKeys) await ch.bindQueue(cfg.queue, cfg.exchange, key)
    // ทีละข้อความ ให้การ์ดออกตามลำดับ (อนุมัติก่อนจ่าย)
    await ch.prefetch(1)

    conn.on('close', () => {
      connection = null
      channel = null
      if (stopping) return
      console.warn(`[store-events] หลุดจาก RabbitMQ จะเชื่อมต่อใหม่ใน ${reconnectDelayMs / 1000}s`)
      setTimeout(() => void connectWithRetry(), reconnectDelayMs)
      reconnectDelayMs = Math.min(reconnectDelayMs * 2, 60000)
    })

    await ch.consume(cfg.queue, (msg) => {
      if (!msg) return
      void handleMessage(msg)
        .catch((err) => {
          stats.failed++
          stats.lastError = describeAmqpError(err)
          console.error(`[store-events] ประมวลผล ${msg.fields.routingKey} ไม่สำเร็จ:`, stats.lastError)
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
  } catch (err) {
    connection = null
    channel = null
    await closeAbandonedConnection(conn)
    throw err
  }
  console.log(
    `[store-events] รับ event จาก RabbitMQ แล้ว (exchange ${cfg.exchange}, queue ${cfg.queue}) -> ${cfg.targets.length} ปลายทาง, ชนิด: ${cfg.events.join(', ')}`
  )
}

async function connectWithRetry(): Promise<void> {
  if (stopping || connection) return
  try {
    await connect()
  } catch (err) {
    stats.lastError = describeAmqpError(err)
    console.error(`[store-events] เชื่อมต่อ RabbitMQ ไม่ได้ (${stats.lastError}) จะลองใหม่ใน ${reconnectDelayMs / 1000}s`)
    setTimeout(() => void connectWithRetry(), reconnectDelayMs)
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, 60000)
  }
}

export function startStoreRequestEventConsumer(): void {
  if (!cfg.enabled) {
    console.log('[store-events] ปิดอยู่ (ไม่ได้ตั้ง STORE_REQUEST_LINE_TARGETS / RabbitMQ หรือ STORE_REQUEST_EVENTS_ENABLED=false)')
    return
  }
  warnIfLocalhostBrokerInContainer('store-events', cfg.url, process.env.STORE_EVENTS_RABBITMQ_URL ? 'STORE_EVENTS_RABBITMQ_URL' : 'RABBITMQ_URL')
  stopping = false
  void connectWithRetry()
}

export async function stopStoreRequestEventConsumer(): Promise<void> {
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

export function storeRequestEventsStatus(): Record<string, unknown> {
  if (!cfg.enabled) return { enabled: false }
  return {
    enabled: true,
    connected: connection !== null,
    broker: cfg.url.replace(/:[^:@/]*@/, ':****@'),
    exchange: cfg.exchange,
    queue: cfg.queue,
    events: cfg.events,
    targets: cfg.targets.length,
    ...stats,
    mockLine: config.mockLine
  }
}
