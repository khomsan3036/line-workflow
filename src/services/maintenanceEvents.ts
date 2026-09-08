import amqp, { type Channel, type ChannelModel, type ConsumeMessage } from 'amqplib'
import { config } from '../config'
import { normalizeAlert, type AlertSeverity, type GroupAlert } from './maintenanceFlex'
import { pushAlertToGroups } from './maintenanceLocalTools'

// ---------------------------------------------------------------------------
// Consumer ของ RabbitMQ: รับ event จากระบบซ่อมบำรุง (exchange "maintenance") แล้วแจ้งเข้าไลน์กลุ่มของทีม
//
// ทำไมอยู่ในแอปนี้: ระบบซ่อมบำรุงมีแต่ตัว publish (repair/fuel/vehicle service และ MCP tool Send*)
// แต่ไม่มี consumer ที่ส่งเข้า LINE (service notification-alert ยังเป็นโครงเปล่า) แอปนี้มี OA MT
// และทะเบียนกลุ่มอยู่แล้ว จึงเป็นจุดที่เติมช่องว่างนี้ได้โดยไม่ต้องแก้ระบบซ่อมบำรุง
//
// routing key ที่รองรับ (MAINTENANCE_EVENT_ROUTING_KEYS)
//   repair.requested            RepairRequestedEvent        (แจ้งซ่อมใหม่)
//   fuel.requested              FuelRequestedEvent          (ขอเบิกน้ำมัน)
//   vehicle.booking.requested   VehicleBookingRequestedEvent (ขอจองรถ)
//   maintenance.*.notification  NotificationPayload / AlertNotificationPayload จาก MCP server
// JSON เป็น camelCase และ enum เป็นตัวเลข (System.Text.Json แบบ Web) จึงต้องรับได้ทั้งเลขและชื่อ
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>

const REPAIR_SEVERITY = ['Emergency', 'High', 'Normal']
const REQUEST_STATUS = ['Draft', 'Submitted', 'PendingApproval', 'Approved', 'Rejected', 'Fulfilled', 'Closed', 'Cancelled']

let connection: ChannelModel | null = null
let channel: Channel | null = null
let stopping = false
let reconnectDelayMs = 2000
let stats = { consumed: 0, alerted: 0, skipped: 0, failed: 0, lastEventAt: null as string | null, lastError: null as string | null }

// กัน event ซ้ำ (broker ส่งซ้ำได้เมื่อ ack ไม่ถึง) จำ id ล่าสุดไว้ในหน่วยความจำ
const seen = new Map<string, number>()
const SEEN_TTL_MS = 6 * 60 * 60 * 1000

function isDuplicate(id: string | null): boolean {
  if (!id) return false
  const now = Date.now()
  for (const [k, t] of seen) if (now - t > SEEN_TTL_MS) seen.delete(k)
  if (seen.has(id)) return true
  seen.set(id, now)
  return false
}

function str(v: unknown): string {
  return v === null || v === undefined ? '' : String(v).trim()
}

function enumName(v: unknown, names: string[]): string {
  if (typeof v === 'number') return names[v] ?? String(v)
  return str(v)
}

function money(v: unknown): string {
  const n = Number(v)
  return Number.isFinite(n) ? n.toLocaleString('th-TH', { maximumFractionDigits: 0 }) : str(v)
}

/**
 * แปลงเวลาจาก event เป็น Date
 * ระบบซ่อมบำรุง (.NET) ส่ง DateTime แบบไม่มี offset เช่น "2026-09-08T08:30:00" ซึ่งเป็นเวลาไทยอยู่แล้ว
 * ถ้าปล่อยให้ new Date() ตีความตาม timezone ของเครื่อง (เช่น UTC ใน Docker) เวลาจะเพี้ยนไป 7 ชั่วโมง
 */
function eventDate(v: unknown): Date | null {
  const s = str(v)
  if (!s) return null
  const naive = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)
  const d = new Date(naive && config.timezone === 'Asia/Bangkok' ? `${s}+07:00` : s)
  return Number.isNaN(d.getTime()) ? null : d
}

const TH_DATE: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' }
const TH_TIME: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' }

function fmtDate(d: Date, opts: Intl.DateTimeFormatOptions): string {
  return d.toLocaleString('th-TH', { timeZone: config.timezone, ...opts })
}

function thaiDateTime(v: unknown): string {
  const d = eventDate(v)
  return d ? fmtDate(d, { ...TH_DATE, ...TH_TIME }) : str(v)
}

/** ช่วงเวลาแบบอ่านง่าย: วันเดียว "อ. 8 ก.ย. 08:30 - 17:00 น." หลายวัน "8 ก.ย. 08:30 - 9 ก.ย. 17:00 น." */
function thaiDateRange(startV: unknown, endV: unknown): string {
  const start = eventDate(startV)
  const end = eventDate(endV)
  if (!start) return ''
  if (!end) return `${fmtDate(start, { weekday: 'short', ...TH_DATE, ...TH_TIME })} น.`
  const sameDay = fmtDate(start, { dateStyle: 'short' }) === fmtDate(end, { dateStyle: 'short' })
  if (sameDay) return `${fmtDate(start, { weekday: 'short', ...TH_DATE })} ${fmtDate(start, TH_TIME)} - ${fmtDate(end, TH_TIME)} น.`
  return `${fmtDate(start, { ...TH_DATE, ...TH_TIME })} - ${fmtDate(end, { ...TH_DATE, ...TH_TIME })} น.`
}

/** ระยะเวลาใช้รถ เช่น "8 ชม. 30 น." หรือ "2 วัน 3 ชม." */
function durationLabel(startV: unknown, endV: unknown): string {
  const start = eventDate(startV)
  const end = eventDate(endV)
  if (!start || !end || end <= start) return ''
  const minutes = Math.round((end.getTime() - start.getTime()) / 60000)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const mins = minutes % 60
  const parts = [days ? `${days} วัน` : '', hours ? `${hours} ชม.` : '', !days && mins ? `${mins} น.` : '']
  return parts.filter(Boolean).join(' ')
}

/** ปุ่มเปิดหน้าเว็บระบบซ่อมบำรุง (เฉพาะเมื่อตั้ง MAINTENANCE_WEB_URL) */
function webAction(label: string, path: string): Array<{ label: string; uri: string }> {
  if (!config.maintenance.webUrl) return []
  return [{ label, uri: `${config.maintenance.webUrl}${path}` }]
}

/** หัวข้อ/ค่า ที่ตัดคู่ที่ค่าว่างออก */
function details(pairs: Array<[string, string]>): Array<{ label: string; value: string }> {
  return pairs.filter(([, value]) => value !== '').map(([label, value]) => ({ label, value }))
}

function shortId(v: unknown): string {
  const s = str(v)
  return s.length > 8 ? s.slice(0, 8) : s
}

// ---------------------------------------------------------------------------
// แปลง event แต่ละชนิดเป็นการ์ดแจ้งเตือน
// ---------------------------------------------------------------------------

function fromRepairRequested(e: Json): GroupAlert {
  const severity = enumName(e.severity, REPAIR_SEVERITY)
  const tone: AlertSeverity = severity === 'Emergency' ? 'urgent' : severity === 'High' ? 'warning' : 'info'
  const severityThai = severity === 'Emergency' ? 'ฉุกเฉิน' : severity === 'High' ? 'สูง' : 'ปกติ'
  const asset = str(e.assetCode)
  return normalizeAlert(
    {
      title: `แจ้งซ่อมใหม่${asset ? ` ${asset}` : ''}`,
      message: str(e.symptom) || 'ไม่ได้ระบุอาการ',
      severity: tone,
      details: details([
        ['ความรุนแรง', severityThai],
        ['ทรัพย์สิน', asset],
        ['ผู้แจ้ง', str(e.by)],
        ['งานเลขที่', shortId(e.repairRequestId)]
      ]),
      actions: webAction('เปิดงานซ่อม', '/services/maintenance-request'),
      reference: asset || shortId(e.repairRequestId)
    },
    str(e.by) || 'ระบบซ่อมบำรุง'
  )
}

function fromFuelRequested(e: Json): GroupAlert {
  const vehicle = [str(e.vehicleCode), str(e.vehicleName)].filter(Boolean).join(' ')
  const auto = e.autoApproved === true
  const status = enumName(e.requestStatus, REQUEST_STATUS)
  const liters = Number(e.requestedLiters)
  return normalizeAlert(
    {
      title: `ขอเบิกน้ำมัน ${str(e.requestNo) || shortId(e.fuelRequestId)}`,
      message: `${str(e.requesterName) ? `คุณ${str(e.requesterName)} ` : ''}ขอเบิกน้ำมันให้ ${vehicle || 'รถที่ไม่ระบุ'} ${
        auto ? 'อนุมัติอัตโนมัติแล้ว' : 'รออนุมัติ'
      }`,
      severity: auto ? 'info' : 'warning',
      details: details([
        ['รถ', vehicle],
        ['ประเภทน้ำมัน', str(e.fuelType)],
        ['จำนวน', `${Number.isFinite(liters) ? liters.toLocaleString('th-TH') : str(e.requestedLiters)} ลิตร`],
        ['ประมาณค่าใช้จ่าย', `${money(e.estimatedCost)} บาท`],
        ['ผู้ขอ', str(e.requesterName)],
        ['โครงการ', str(e.projectCode)],
        ['เลขไมล์', Number(e.odometer) > 0 ? `${Number(e.odometer).toLocaleString('th-TH')} กม.` : ''],
        ['สถานะ', status]
      ]),
      actions: webAction('เปิดหน้าอนุมัติ', '/services/fuel-request'),
      reference: str(e.requestNo) || undefined
    },
    str(e.requesterName) || str(e.by) || 'ระบบซ่อมบำรุง'
  )
}

/**
 * คำขอจองรถ (VehicleBookingRequestedEvent)
 * event รุ่นใหม่มีรายละเอียดครบ (รถ ผู้ขอ แผนก โครงการ วัตถุประสงค์ ปลายทาง ผู้โดยสาร)
 * ถ้าเป็น event รุ่นเก่าที่มีแค่ id จะแสดงเท่าที่มี ไม่ล้ม
 */
function fromVehicleBookingRequested(e: Json): GroupAlert {
  const vehicleCode = str(e.vehicleCode)
  const vehicleName = str(e.vehicleName)
  const plate = str(e.vehiclePlate)
  const asset = [str(e.assetCode), str(e.assetName)].filter(Boolean).join(' ')
  const vehicle = [vehicleCode, vehicleName].filter(Boolean).join(' ') || asset || (str(e.vehicleId) ? `รหัส ${shortId(e.vehicleId)}` : '')

  const requester = str(e.requesterName) || str(e.requesterEmail) || str(e.by)
  // ใส่ "คุณ" เฉพาะเมื่อเป็นชื่อคน (อีเมล/username จาก event รุ่นเก่าไม่ต้อง)
  const who = str(e.requesterName) ? `คุณ${str(e.requesterName)}` : requester
  const dept = str(e.department)
  const destination = str(e.destination)
  const passengers = Number(e.passengers)
  const when = thaiDateRange(e.startAt, e.endAt)
  const duration = durationLabel(e.startAt, e.endAt)
  const bookingNo = str(e.bookingNo) || shortId(e.bookingId)

  const message =
    `${who || 'มีผู้'}${dept ? ` (${dept})` : ''} ขอใช้รถ${vehicle ? ` ${vehicle}` : ''}` +
    `${destination ? ` ไป${destination}` : ''}${when ? ` ${when}` : ''} รออนุมัติ`

  return normalizeAlert(
    {
      title: `ขอจองรถ ${bookingNo}`,
      message,
      severity: 'warning',
      details: details([
        ['รถ', vehicle],
        ['ทะเบียน', plate],
        ['ผู้ขอ', requester],
        ['แผนก', dept],
        ['โครงการ', str(e.projectCode)],
        ['วัตถุประสงค์', str(e.purpose)],
        ['ปลายทาง', destination],
        ['ผู้โดยสาร', Number.isFinite(passengers) && passengers > 0 ? `${passengers} คน` : ''],
        ['ช่วงเวลา', when],
        ['ระยะเวลา', duration]
      ]),
      actions: webAction('เปิดหน้าอนุมัติ', '/services/vehicle-requests/approvals'),
      reference: str(e.bookingNo) || undefined
    },
    requester || 'ระบบซ่อมบำรุง'
  )
}

/** NotificationPayload / AlertNotificationPayload ที่ MCP server publish (Send* tools และ notifications_sent) */
function fromNotificationPayload(e: Json): GroupAlert {
  const type = str(e.type).toLowerCase()
  const sev = str(e.severity).toLowerCase()
  const severity: AlertSeverity =
    sev === 'urgent' || type === 'urgent' ? 'urgent' : sev === 'warning' || type === 'alert' || type === 'pending' ? 'warning' : 'info'
  const service = str(e.service)
  return normalizeAlert(
    {
      title: str(e.title) || 'แจ้งเตือนจากระบบซ่อมบำรุง',
      message: str(e.message) || '-',
      severity,
      details: details([
        ['ระบบ', service],
        ['ประเภท', str(e.category)],
        ['ทรัพย์สิน', str(e.assetCode)],
        ['ควรทำ', str(e.action)],
        ['ช่วงเวลา', str(e.period)]
      ]),
      reference: str(e.reference) || undefined
    },
    str(e.requestedBy) || 'ระบบซ่อมบำรุง'
  )
}

export function mapEventToAlert(routingKey: string, e: Json): GroupAlert | null {
  if (routingKey === 'repair.requested') return fromRepairRequested(e)
  if (routingKey === 'fuel.requested') return fromFuelRequested(e)
  if (routingKey === 'vehicle.booking.requested') return fromVehicleBookingRequested(e)
  if (/^maintenance\.[a-z]+\.notification$/.test(routingKey)) return fromNotificationPayload(e)
  return null
}

// ---------------------------------------------------------------------------
// วงจร consumer
// ---------------------------------------------------------------------------

async function handleMessage(msg: ConsumeMessage): Promise<void> {
  const key = msg.fields.routingKey
  stats.consumed++
  stats.lastEventAt = new Date().toISOString()

  let payload: Json
  try {
    payload = JSON.parse(msg.content.toString('utf8')) as Json
  } catch {
    stats.skipped++
    console.warn(`[MT-events] ข้าม ${key}: body ไม่ใช่ JSON`)
    return
  }

  const eventId = str(payload.eventId) || str(payload.id) || msg.properties.messageId || null
  if (isDuplicate(eventId)) {
    stats.skipped++
    console.log(`[MT-events] ข้าม ${key} id=${eventId} (ซ้ำ)`)
    return
  }

  const alert = mapEventToAlert(key, payload)
  if (!alert) {
    stats.skipped++
    console.log(`[MT-events] ข้าม ${key}: ไม่มีตัวแปลงสำหรับ routing key นี้`)
    return
  }

  // payload จาก MCP ระบุ groupId ได้ (AlertNotifications:GroupId) ถ้าตรงกับกลุ่มที่บอทอยู่ให้ส่งเฉพาะกลุ่มนั้น
  const groupHint = str(payload.groupId) || null
  let result = await pushAlertToGroups(alert, `mt-events:${key}`, groupHint)
  if (result.targets === 0 && groupHint) result = await pushAlertToGroups(alert, `mt-events:${key}`)

  if (result.targets === 0) {
    stats.skipped++
    console.warn(`[MT-events] ${key}: บอท MT ยังไม่ได้อยู่ในกลุ่มใด จึงไม่ได้แจ้ง`)
    return
  }
  const ok = result.sent.filter((s) => s.status === 'sent' || s.status === 'mock').length
  if (ok > 0) stats.alerted++
  else stats.failed++
  console.log(
    `[MT-events] ${key} -> "${alert.title}" ส่งเข้า ${ok}/${result.targets} กลุ่ม` +
      (ok < result.targets ? ` (${result.sent.filter((s) => s.status === 'failed').map((s) => `${s.group}: ${s.error}`).join('; ')})` : '')
  )
}

async function connect(): Promise<void> {
  const cfg = config.maintenance.events
  // heartbeat กำหนดผ่าน query string ของ URL (amqplib ไม่รับใน socket options)
  const url = /[?&]heartbeat=/.test(cfg.url) ? cfg.url : `${cfg.url}${cfg.url.includes('?') ? '&' : '?'}heartbeat=30`
  const conn = await amqp.connect(url)
  const ch = await conn.createChannel()
  await ch.assertExchange(cfg.exchange, 'topic', { durable: true })
  await ch.assertQueue(cfg.queue, { durable: true })
  for (const key of cfg.routingKeys) await ch.bindQueue(cfg.queue, cfg.exchange, key)
  await ch.prefetch(5)

  conn.on('error', (err) => {
    stats.lastError = err instanceof Error ? err.message : String(err)
    console.error('[MT-events] การเชื่อมต่อ RabbitMQ ผิดพลาด:', stats.lastError)
  })
  conn.on('close', () => {
    connection = null
    channel = null
    if (stopping) return
    console.warn(`[MT-events] หลุดจาก RabbitMQ จะเชื่อมต่อใหม่ใน ${reconnectDelayMs / 1000}s`)
    setTimeout(() => void connectWithRetry(), reconnectDelayMs)
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, 60000)
  })

  await ch.consume(cfg.queue, (msg) => {
    if (!msg) return
    void handleMessage(msg)
      .catch((err) => {
        stats.failed++
        stats.lastError = err instanceof Error ? err.message : String(err)
        console.error(`[MT-events] ประมวลผล ${msg.fields.routingKey} ไม่สำเร็จ:`, stats.lastError)
      })
      // ack เสมอ (แม้ส่งไม่สำเร็จ) กันข้อความค้างวนซ้ำ ผลการส่งอยู่ใน message_logs แล้ว
      .finally(() => {
        try {
          ch.ack(msg)
        } catch {
          // channel ปิดไปแล้ว ข้อความจะถูกส่งซ้ำตอนต่อใหม่ และถูกกันด้วย isDuplicate
        }
      })
  })

  connection = conn
  channel = ch
  reconnectDelayMs = 2000
  console.log(
    `[MT-events] รับ event จาก RabbitMQ แล้ว (exchange ${cfg.exchange}, queue ${cfg.queue}, keys: ${cfg.routingKeys.join(', ')})`
  )
}

async function connectWithRetry(): Promise<void> {
  if (stopping || connection) return
  try {
    await connect()
  } catch (err) {
    stats.lastError = err instanceof Error ? err.message : String(err)
    console.error(`[MT-events] เชื่อมต่อ RabbitMQ ไม่ได้ (${stats.lastError}) จะลองใหม่ใน ${reconnectDelayMs / 1000}s`)
    setTimeout(() => void connectWithRetry(), reconnectDelayMs)
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, 60000)
  }
}

/** เริ่ม consumer (ไม่ throw: ถ้าต่อไม่ได้จะลองใหม่เรื่อย ๆ เบื้องหลัง) */
export function startMaintenanceEventConsumer(): void {
  if (!config.maintenance.events.enabled) {
    console.log('[MT-events] ปิดอยู่ (ไม่ได้ตั้ง RABBITMQ_URL)')
    return
  }
  stopping = false
  void connectWithRetry()
}

export async function stopMaintenanceEventConsumer(): Promise<void> {
  stopping = true
  try {
    await channel?.close()
    await connection?.close()
  } catch {
    // ปิดไม่สำเร็จก็ไม่เป็นไร
  }
  connection = null
  channel = null
}

/** สถานะสำหรับ /health */
export function maintenanceEventsStatus(): Record<string, unknown> {
  const cfg = config.maintenance.events
  if (!cfg.enabled) return { enabled: false }
  return { enabled: true, connected: connection !== null, exchange: cfg.exchange, queue: cfg.queue, routingKeys: cfg.routingKeys, ...stats }
}
