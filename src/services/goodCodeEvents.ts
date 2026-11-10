import amqp, { type Channel, type ChannelModel, type ConsumeMessage } from 'amqplib'
import { config } from '../config'
import { closeAbandonedConnection, describeAmqpError, warnIfLocalhostBrokerInContainer } from './amqpUtil'
import { queryOne } from '../db'
import { sendAndLog } from './messaging'
import { claimForSend } from './maintenanceEvents'
import { resolvePersonName } from './hrDirectory'
import { buildGoodCodeCard, type GoodCodeCardKind, type GoodCodeRequestView } from './goodCodeFlex'

// ---------------------------------------------------------------------------
// Consumer ของ RabbitMQ: คำขอเพิ่มรหัสสินค้าใหม่จาก qtec-integra (integra-costcode-service, Good Code Master)
// -> การ์ดถึงผู้อนุมัติ (GOOD_CODE_LINE_TARGETS) และการ์ดผลตัดสินถึงผู้ขอ ด้วย OA HR
//
// exchange "integra-drawing" (topic) routing key (ดู integra-costcode-service/Events/GoodCodeEvents.cs):
//   good-code.request.submitted   ยื่นคำขอ (type New/Edit/Correction/Archive)      -> kind submitted (เฉพาะ New)
//   good-code.created             อนุมัติคำขอ New แล้ว = ลงทะเบียนรายการ          -> kind approved
//   good-code.request.rejected    ไม่อนุมัติ                                     -> kind rejected (เฉพาะ New)
// event มีแค่ requestId / goodCode / type / reason / by (ไม่มีชื่อสินค้า ประเภท หมวด กลุ่ม หน่วย)
// จึงถามรายละเอียดจาก GET <GOOD_CODE_API_URL>/api/v1/good-code-requests/{id} (ไม่ต้องล็อกอิน) ถามไม่ได้ = ใช้ข้อมูลใน event
//
// ข้อควรรู้: ผู้มีสิทธิ์ good-code:approve กด "บันทึกรหัสสินค้า" จากหน้าเว็บ = บันทึกตรง (direct save) ไม่มี request.submitted
//   แต่ได้ good-code.created ทันทีพร้อมคำขอ New สถานะ Pending (รายการรอตรวจกับ WINSpeed / รอผู้อนุมัติ) -> ส่งการ์ด "คำขอใหม่" แทน
//   และเมื่ออนุมัติคำขอแบบนั้นในภายหลัง ฝั่ง integra ไม่ publish event (จึงไม่มีการ์ดผล) ไม่อนุมัติมี request.rejected ตามปกติ
// JSON เป็น camelCase (System.Text.Json แบบ Web) เวลาเป็นเวลาไทยไม่มี timezone
// ---------------------------------------------------------------------------

/** payload ของ good-code.* ที่ใช้ (ช่องอื่นของ event ไม่สนใจ) */
export interface GoodCodeEvent {
  eventId?: string
  occurredAt?: string
  goodCodeId?: string
  goodCode?: string
  by?: string
  requestId?: string
  /** GCR-YYMM-#### — มีใน good-code.request.* / corrected / archived (ไม่มีใน good-code.created) */
  requestNo?: string
  type?: string
  reason?: string
  proposedGoodCode?: string | null
  dependencyBlocked?: boolean
  // good-code.created
  goodName?: string
  goodNameEng?: string
}

/** GoodCodeRequestDto ของ integra-costcode-service (เฉพาะช่องที่ใช้) */
interface GoodCodeRequestDto {
  id: string
  /** GCR-YYMM-#### (TblGoodCodeRequest.RequestNo, มีตั้งแต่ 2026-11-05) */
  requestNo?: string
  goodCode: string
  type: string
  proposal?: {
    item?: {
      goodName1?: string
      goodNameEng1?: string
      goodTypeCode?: string | null
      goodTypeName?: string
      goodCateCode?: string | null
      goodCateName?: string
      goodGroupCode?: string | null
      goodGroupName?: string
      goodUnitName?: string | null
    } | null
  } | null
  reason?: string
  requestedBy?: string
  requestedAt?: string
  status?: string
  decidedBy?: string | null
  decidedAt?: string | null
  decisionReason?: string | null
}

const cfg = {
  ...config.goodCode,
  routingKeys: ['good-code.request.submitted', 'good-code.created', 'good-code.request.rejected']
}

let connection: ChannelModel | null = null
let channel: Channel | null = null
let stopping = false
let reconnectDelayMs = 2000
const stats = {
  consumed: 0,
  sent: 0,
  filtered: 0,
  skipped: 0,
  deduped: 0,
  failed: 0,
  apiMisses: 0,
  lastEventAt: null as string | null,
  lastError: null as string | null
}

const seen = new Map<string, number>()
const SEEN_TTL_MS = 6 * 60 * 60 * 1000
function isDuplicate(id: string): boolean {
  const now = Date.now()
  for (const [k, t] of seen) if (now - t > SEEN_TTL_MS) seen.delete(k)
  if (seen.has(id)) return true
  seen.set(id, now)
  return false
}

const EMPLOYEE_NO = /^[a-z]?\d{2}-\d-\d{3}$/i

/** "56-1-715" หรือ "67-1-010-ทรงธรรม" (X-User ที่หน้าเว็บประทับ) -> { code, name } */
export function splitActor(stamp: string | null | undefined): { code: string | null; name: string | null } {
  const v = (stamp ?? '').trim()
  if (!v) return { code: null, name: null }
  const m = v.match(/^([a-z]?\d{2}-\d-\d{3})(?:-(.+))?$/i)
  if (m) return { code: m[1], name: m[2]?.trim() || null }
  return { code: null, name: v }
}

/** ชื่อคนจากรหัสพนักงาน (best-effort: HR ล่ม/ไม่พบ = null) */
async function nameOf(stamp: string | null | undefined): Promise<string | null> {
  const { code, name } = splitActor(stamp)
  if (name) return name
  if (!code) return null
  try {
    return await resolvePersonName(code)
  } catch {
    return null
  }
}

/** ถาม integra-costcode-service ด้วย GET (ไม่ต้องล็อกอิน) — ล้มเหลว = null */
async function apiGet<T>(path: string): Promise<T | null> {
  if (!cfg.apiUrl) return null
  try {
    const res = await fetch(`${cfg.apiUrl}${path}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(cfg.apiTimeoutMs) })
    if (!res.ok) {
      stats.apiMisses++
      console.warn(`[good-code-events] ${path} -> HTTP ${res.status}`)
      return null
    }
    const body = (await res.json()) as { success?: boolean; data?: T }
    return body.success !== false && body.data !== undefined ? body.data : null
  } catch (err) {
    stats.apiMisses++
    console.warn(`[good-code-events] ถาม ${path} ไม่ได้:`, err instanceof Error ? err.message : err)
    return null
  }
}

export async function fetchRequestById(id: string): Promise<GoodCodeRequestDto | null> {
  return apiGet<GoodCodeRequestDto>(`/api/v1/good-code-requests/${encodeURIComponent(id)}`)
}

/** คำขอของรหัสนี้ (ล่าสุดก่อน) — ใช้ตอน good-code.created ซึ่งไม่มี requestId และตอนทดสอบด้วย --good-code */
export async function fetchRequestsByCode(goodCode: string): Promise<GoodCodeRequestDto[]> {
  const rows = await apiGet<GoodCodeRequestDto[]>(`/api/v1/good-code-requests?goodCode=${encodeURIComponent(goodCode)}`)
  return Array.isArray(rows) ? rows : []
}

/** รวม DTO (ถ้ามี) กับ event เป็นข้อมูลการ์ด แล้วเติมชื่อคนจาก HR */
export async function toView(dto: GoodCodeRequestDto | null, ev: GoodCodeEvent | null): Promise<GoodCodeRequestView> {
  const item = dto?.proposal?.item ?? null
  const requestedBy = dto?.requestedBy ?? (ev?.type ? ev.by : null) ?? null
  const decidedBy = dto?.decidedBy ?? null
  const view: GoodCodeRequestView = {
    requestId: dto?.id ?? ev?.requestId ?? '',
    requestNo: dto?.requestNo ?? ev?.requestNo ?? null,
    goodCode: dto?.goodCode ?? ev?.goodCode ?? '',
    type: dto?.type ?? ev?.type ?? 'New',
    goodName: item?.goodName1 ?? ev?.goodName ?? null,
    goodNameEng: item?.goodNameEng1 ?? ev?.goodNameEng ?? null,
    goodTypeCode: item?.goodTypeCode ?? null,
    goodTypeName: item?.goodTypeName ?? null,
    goodCateCode: item?.goodCateCode ?? null,
    goodCateName: item?.goodCateName ?? null,
    goodGroupCode: item?.goodGroupCode ?? null,
    goodGroupName: item?.goodGroupName ?? null,
    unitName: item?.goodUnitName ?? null,
    requestedBy: splitActor(requestedBy).code ?? requestedBy,
    requestedAt: dto?.requestedAt ?? ev?.occurredAt ?? null,
    reason: dto?.reason ?? ev?.reason ?? null,
    decidedBy: splitActor(decidedBy).code ?? decidedBy,
    decidedAt: dto?.decidedAt ?? null,
    decisionReason: dto?.decisionReason ?? null
  }
  view.requesterName = await nameOf(requestedBy)
  view.deciderName = await nameOf(decidedBy)
  return view
}

/** LINE userId ของผู้ขอ (ผูกรหัสพนักงานไว้ใน line_employee_links) — ไม่มี/DB ล่ม = [] */
async function requesterLineIds(prsNo: string | null | undefined): Promise<string[]> {
  const code = (prsNo ?? '').trim()
  if (!code || !EMPLOYEE_NO.test(code)) return []
  try {
    const row = await queryOne<{ line_user_id: string }>(
      `SELECT line_user_id FROM line_employee_links
        WHERE upper(prs_no) = upper($1)
        ORDER BY verified_at DESC NULLS LAST, updated_at DESC
        LIMIT 1`,
      [code]
    )
    return row ? [row.line_user_id] : []
  } catch {
    return []
  }
}

/** ส่งการ์ดหนึ่งใบไปทุกปลายทาง ใช้ทั้ง consumer และสคริปต์ทดสอบ */
export async function deliverGoodCodeCard(opts: {
  kind: GoodCodeCardKind
  view: GoodCodeRequestView
  targets: string[]
  sentBy: string
  dryRun?: boolean
}): Promise<Array<{ targetId: string; status: string; error: string | null }>> {
  const card = buildGoodCodeCard(opts.kind, opts.view, cfg.webUrl)
  const results: Array<{ targetId: string; status: string; error: string | null }> = []
  for (const raw of [...new Set(opts.targets.map((t) => t.trim()))]) {
    if (!/^[CRU][0-9a-f]{32}$/.test(raw)) {
      results.push({ targetId: raw, status: 'failed', error: 'รูปแบบ target id ไม่ถูกต้อง (ต้องเป็น C…/U… 33 ตัว)' })
      continue
    }
    const res = await sendAndLog({
      targetType: raw.startsWith('U') ? 'user' : 'group',
      targetId: raw,
      kind: 'flex',
      altText: card.altText,
      contents: card.contents,
      sentBy: opts.sentBy,
      channel: 'hr',
      dryRun: opts.dryRun
    })
    results.push({ targetId: raw, status: res.status, error: res.error ?? null })
  }
  return results
}

/** routing key + payload -> ชนิดการ์ด (null = ไม่เกี่ยว) */
export function goodCodeKind(routingKey: string, ev: GoodCodeEvent): GoodCodeCardKind | null {
  const type = (ev.type ?? '').toLowerCase()
  switch (routingKey) {
    case 'good-code.request.submitted':
      return type === 'new' ? 'submitted' : null
    case 'good-code.request.rejected':
      return type === 'new' ? 'rejected' : null
    case 'good-code.created':
      return 'approved'
    default:
      return null
  }
}

async function handleMessage(msg: ConsumeMessage): Promise<void> {
  const key = msg.fields.routingKey
  stats.consumed++
  stats.lastEventAt = new Date().toISOString()

  let ev: GoodCodeEvent
  try {
    ev = JSON.parse(msg.content.toString('utf8')) as GoodCodeEvent
  } catch {
    stats.skipped++
    console.warn(`[good-code-events] ข้าม ${key}: body ไม่ใช่ JSON`)
    return
  }
  let kind = goodCodeKind(key, ev)
  if (!kind || !ev.goodCode) {
    stats.filtered++
    return
  }
  const eventId = String(ev.eventId ?? msg.properties.messageId ?? '')
  if (eventId && isDuplicate(eventId)) {
    stats.skipped++
    return
  }
  if (!cfg.events.includes(kind)) {
    stats.filtered++
    return
  }

  // หา DTO ของคำขอ: submitted/rejected มี requestId, created ต้องหาจากรหัส
  //   created + คำขอ New สถานะ Approved = อนุมัติคำขอ -> การ์ดผล
  //   created + คำขอ New สถานะ Pending  = ผู้อนุมัติ "บันทึกตรง" จากหน้าเว็บ รายการรอตรวจ/อนุมัติอยู่ -> การ์ดคำขอใหม่ (ไม่มี request.submitted มาให้)
  let dto: GoodCodeRequestDto | null = null
  if (kind === 'approved') {
    const rows = await fetchRequestsByCode(ev.goodCode).then((r) => r.filter((x) => x.type === 'New'))
    dto = rows.find((r) => r.status === 'Approved') ?? null
    if (!dto) {
      const pending = rows.find((r) => r.status === 'Pending')
      if (!pending) {
        stats.filtered++
        console.log(`[good-code-events] ข้าม ${key} ${ev.goodCode}: ไม่พบคำขอ New ของรหัสนี้ (ถาม API ไม่ได้ หรือไม่มีคำขอ)`)
        return
      }
      dto = pending
      kind = 'submitted'
      if (!cfg.events.includes(kind)) {
        stats.filtered++
        return
      }
    }
  } else if (ev.requestId) {
    dto = await fetchRequestById(ev.requestId)
  }
  const view = await toView(dto, ev)
  if (!view.requestId) view.requestId = eventId

  const dedupeKey = `good-code:${view.requestId}:${kind}`
  if (cfg.dedupeHours > 0 && !(await claimForSend(dedupeKey, cfg.dedupeHours))) {
    stats.deduped++
    console.log(`[good-code-events] ข้าม ${key} ${ev.goodCode}: ส่งไปแล้วภายใน ${cfg.dedupeHours} ชม.`)
    return
  }

  const targets = [...cfg.targets]
  if (kind !== 'submitted' && cfg.notifyRequester) targets.push(...(await requesterLineIds(view.requestedBy)))

  const results = await deliverGoodCodeCard({ kind, view, targets, sentBy: `good-code-events:${key}` })
  const ok = results.filter((r) => r.status === 'sent' || r.status === 'mock').length
  if (ok > 0) stats.sent++
  else stats.failed++
  console.log(
    `[good-code-events] ${key} ${ev.goodCode} (${kind}) -> ส่ง ${ok}/${results.length}` +
      (ok < results.length ? ` (${results.filter((r) => r.status === 'failed').map((r) => `${r.targetId.slice(0, 6)}…: ${r.error}`).join('; ')})` : '')
  )
}

async function connect(): Promise<void> {
  const url = /[?&]heartbeat=/.test(cfg.url) ? cfg.url : `${cfg.url}${cfg.url.includes('?') ? '&' : '?'}heartbeat=30`
  const conn = await amqp.connect(url)
  conn.on('error', (err) => {
    stats.lastError = describeAmqpError(err)
    console.error('[good-code-events] การเชื่อมต่อ RabbitMQ ผิดพลาด:', stats.lastError)
  })
  try {
    const ch = await conn.createChannel()
    ch.on('error', (err) => {
      stats.lastError = describeAmqpError(err)
      console.error('[good-code-events] channel RabbitMQ ผิดพลาด:', stats.lastError)
    })
    // ประกาศให้ตรงกับฝั่ง .NET (RabbitMqEventBus: topic, durable)
    await ch.assertExchange(cfg.exchange, 'topic', { durable: true })
    await ch.assertQueue(cfg.queue, { durable: true })
    for (const key of cfg.routingKeys) await ch.bindQueue(cfg.queue, cfg.exchange, key)
    await ch.prefetch(1)

    conn.on('close', () => {
      connection = null
      channel = null
      if (stopping) return
      console.warn(`[good-code-events] หลุดจาก RabbitMQ จะเชื่อมต่อใหม่ใน ${reconnectDelayMs / 1000}s`)
      setTimeout(() => void connectWithRetry(), reconnectDelayMs)
      reconnectDelayMs = Math.min(reconnectDelayMs * 2, 60000)
    })

    await ch.consume(cfg.queue, (msg) => {
      if (!msg) return
      void handleMessage(msg)
        .catch((err) => {
          stats.failed++
          stats.lastError = describeAmqpError(err)
          console.error(`[good-code-events] ประมวลผล ${msg.fields.routingKey} ไม่สำเร็จ:`, stats.lastError)
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
    `[good-code-events] รับ event จาก RabbitMQ แล้ว (exchange ${cfg.exchange}, queue ${cfg.queue}) -> ${cfg.targets.length} ปลายทาง, ชนิด: ${cfg.events.join(', ')}` +
      (cfg.apiUrl ? ` รายละเอียดจาก ${cfg.apiUrl}` : ' (ไม่ได้ตั้ง GOOD_CODE_API_URL การ์ดจะไม่มีชื่อ/ประเภทสินค้า)')
  )
}

async function connectWithRetry(): Promise<void> {
  if (stopping || connection) return
  try {
    await connect()
  } catch (err) {
    stats.lastError = describeAmqpError(err)
    console.error(`[good-code-events] เชื่อมต่อ RabbitMQ ไม่ได้ (${stats.lastError}) จะลองใหม่ใน ${reconnectDelayMs / 1000}s`)
    setTimeout(() => void connectWithRetry(), reconnectDelayMs)
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, 60000)
  }
}

export function startGoodCodeEventConsumer(): void {
  if (!cfg.enabled) {
    console.log('[good-code-events] ปิดอยู่ (ไม่ได้ตั้ง GOOD_CODE_LINE_TARGETS / RabbitMQ หรือ GOOD_CODE_EVENTS_ENABLED=false)')
    return
  }
  warnIfLocalhostBrokerInContainer(
    'good-code-events',
    cfg.url,
    process.env.GOOD_CODE_EVENTS_RABBITMQ_URL ? 'GOOD_CODE_EVENTS_RABBITMQ_URL' : process.env.STORE_EVENTS_RABBITMQ_URL ? 'STORE_EVENTS_RABBITMQ_URL' : 'RABBITMQ_URL'
  )
  stopping = false
  void connectWithRetry()
}

export async function stopGoodCodeEventConsumer(): Promise<void> {
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

export function goodCodeEventsStatus(): Record<string, unknown> {
  if (!cfg.enabled) return { enabled: false }
  return {
    enabled: true,
    connected: connection !== null,
    broker: cfg.url.replace(/:[^:@/]*@/, ':****@'),
    exchange: cfg.exchange,
    queue: cfg.queue,
    events: cfg.events,
    targets: cfg.targets.length,
    notifyRequester: cfg.notifyRequester,
    apiUrl: cfg.apiUrl || null,
    ...stats,
    mockLine: config.mockLine
  }
}
