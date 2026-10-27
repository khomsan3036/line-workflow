import amqp, { type Channel, type ChannelModel, type ConsumeMessage } from 'amqplib'
import { config } from '../config'
import { closeAbandonedConnection, describeAmqpError, warnIfLocalhostBrokerInContainer } from './amqpUtil'
import { query, queryOne } from '../db'
import { MAX_ALERT_IMAGES, normalizeAlert, type AlertImage, type AlertSeverity, type GroupAlert } from './maintenanceFlex'
import { buildExpiryDigestCard, expiryDigestToText, parseExpiryDigest } from './documentExpiryFlex'
import { pushAlertToGroups } from './maintenanceLocalTools'
import { resolvePersonName } from './hrDirectory'
import { buildFuelRequestCard, fuelRequestCardToText, type FuelUsageSummary } from './fuelRequestFlex'

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
//   filestorage.file.uploaded   FileUploadedEvent (รูป/ไฟล์ที่อัปโหลดเข้า filestorage) — ไม่ได้ทำการ์ดเอง
//                               ใช้เติมรูปก่อนซ่อมให้การ์ด repair.requested ที่พักรออยู่ (ดู pendingRepairs)
// JSON เป็น camelCase และ enum เป็นตัวเลข (System.Text.Json แบบ Web) จึงต้องรับได้ทั้งเลขและชื่อ
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>

const REPAIR_SEVERITY = ['Emergency', 'High', 'Normal']
const REPAIR_STATUS = ['Reported', 'PendingApproval', 'Approved', 'Assigned', 'InProgress', 'OnHold', 'Completed', 'Closed', 'Rejected', 'Cancelled']
const REPAIR_STATUS_THAI: Record<string, string> = {
  Reported: 'แจ้งซ่อม',
  PendingApproval: 'รออนุมัติ',
  Approved: 'อนุมัติแล้ว',
  Assigned: 'มอบหมายแล้ว',
  InProgress: 'กำลังดำเนินการ',
  OnHold: 'พักงาน',
  Completed: 'เสร็จสิ้น',
  Closed: 'ปิดงาน',
  Rejected: 'ไม่อนุมัติ',
  Cancelled: 'ยกเลิก'
}
const REQUEST_STATUS = ['Draft', 'Submitted', 'PendingApproval', 'Approved', 'Rejected', 'Fulfilled', 'Closed', 'Cancelled']
const REQUEST_STATUS_THAI: Record<string, string> = {
  Draft: 'ฉบับร่าง',
  Submitted: 'ส่งคำขอแล้ว',
  PendingApproval: 'รออนุมัติ',
  Approved: 'อนุมัติแล้ว',
  Rejected: 'ไม่อนุมัติ',
  Fulfilled: 'เติมแล้ว',
  Closed: 'ปิดงาน',
  Cancelled: 'ยกเลิก'
}
const WORK_LOCATION = ['Workshop', 'Site']
/** ชื่อไทยของ FuelType (enum ของ fuel service: Diesel, Gasoline91, Gasoline95, Gasohol, NGV, LPG, EV, EngineOil) */
const FUEL_TYPE_THAI: Record<string, string> = { Diesel: 'ดีเซล', Gasoline91: 'เบนซิน 91', Gasoline95: 'เบนซิน 95', Gasohol: 'แก๊สโซฮอล์', NGV: 'NGV', LPG: 'LPG', EV: 'ไฟฟ้า (EV)', EngineOil: 'น้ำมันเครื่อง' }

/** โรงงาน / หน้างาน จากค่า Workshop | Site (ตัวเลขหรือชื่อ) ว่างเมื่อไม่รู้ */
function locationThai(v: unknown): string {
  const name = enumName(v, WORK_LOCATION)
  return name === 'Site' ? 'หน้างาน' : name === 'Workshop' ? 'โรงงาน' : ''
}

let connection: ChannelModel | null = null
let channel: Channel | null = null
let stopping = false
let reconnectDelayMs = 2000
let stats = { consumed: 0, alerted: 0, skipped: 0, deduped: 0, failed: 0, lastEventAt: null as string | null, lastError: null as string | null }

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

// ---------------------------------------------------------------------------
// กันการ์ดซ้ำตามเนื้อหา
// ปัญหาที่พบจริง (2026-09-09): alert "[URGENT] emergency repair REP-202608-0004" ถูกส่งเข้าทุกกลุ่ม 8 ครั้งใน 3 วัน
// เพราะ tool Get* ของ MCP server (GetCriticalAlerts/GetOverallSummary/...) publish alert ทุกตัวที่พบลง
// maintenance.line.notification ทุกครั้งที่แชทบอทหรือตัวตั้งเวลาถาม (ฝั่งนั้นกันซ้ำด้วย AlertId แค่ 60 นาที ในหน่วยความจำ)
//   1) alert ที่เกิดจากคำถามของแอปนี้เอง (payload.tool = Get* และ requestedBy เป็น line:U.../scheduler) -> ข้าม
//      เพราะผู้ถามได้การ์ดคำตอบแล้ว และตัวตั้งเวลาก็ส่งการ์ดสรุปเข้ากลุ่มเองอยู่แล้ว
//   2) ที่เหลือจำคีย์ตามเนื้อหาไว้ในตาราง maintenance_alert_dedupe (รอดข้าม restart ของ tsx watch และใช้ร่วมกันหลาย instance)
//      ไม่ส่งคีย์เดิมซ้ำภายใน MAINTENANCE_EVENT_DEDUPE_HOURS
// ---------------------------------------------------------------------------

/** ผู้ถามที่เป็นแอปนี้เอง: requestedByLabel ใน maintenanceAgent.ts ให้ "ชื่อ (line:U...)" และตัวตั้งเวลาให้ "scheduler (line:scheduler)" */
const OWN_REQUESTER = /line:(u[0-9a-f]{32}|scheduler)\b/i

function isNotificationKey(routingKey: string): boolean {
  return /^maintenance\.[a-z]+\.notification$/.test(routingKey)
}

/** alert อัตโนมัติจากการวิเคราะห์ (มี tool) ที่แอปนี้เป็นคนถามเอง */
export function isOwnAnalysisAlert(routingKey: string, e: Json): boolean {
  return isNotificationKey(routingKey) && str(e.tool) !== '' && OWN_REQUESTER.test(str(e.requestedBy))
}

/**
 * คีย์กันซ้ำตามเนื้อหา (null = ไม่กันตามเนื้อหา ใช้แค่ id ของข้อความ)
 *   คำขอจากระบบ: เลขที่คำขอ/booking  (publisher ส่งซ้ำด้วย eventId ใหม่ก็ยังกันได้)
 *   alert อัตโนมัติ: alertId ที่ MCP คำนวณจาก service|category|reference (คงที่ต่อ alert เดิม)
 *   Send* ที่ผู้ใช้สั่งเอง (ไม่มี alertId/tool): ไม่กันตามเนื้อหา ส่งซ้ำได้ตามที่สั่ง
 */
export function dedupeKey(routingKey: string, e: Json): string | null {
  let key: string | null = null
  if (routingKey === 'repair.requested') key = str(e.repairRequestId) ? `repair:${str(e.repairRequestId)}` : null
  else if (routingKey === 'fuel.requested') key = str(e.fuelRequestId) || str(e.requestNo) ? `fuel:${str(e.fuelRequestId) || str(e.requestNo)}` : null
  else if (routingKey === 'vehicle.booking.requested') key = str(e.bookingId) || str(e.bookingNo) ? `booking:${str(e.bookingId) || str(e.bookingNo)}` : null
  else if (isNotificationKey(routingKey)) {
    if (str(e.alertId)) key = `alert:${str(e.alertId)}`
    else if (str(e.tool) && str(e.reference)) key = `alert:${[str(e.service), str(e.category), str(e.reference)].join('|')}`
  }
  return key ? key.slice(0, 200) : null
}

/**
 * จองสิทธิ์ส่งคีย์นี้: true = ยังไม่ได้ส่งภายในช่วงกันซ้ำ (บันทึกว่าส่งแล้ว), false = ซ้ำ
 * ทำใน SQL คำสั่งเดียว (INSERT ... ON CONFLICT ... WHERE พ้นช่วง) จึงปลอดภัยเมื่อหลาย instance รับพร้อมกัน
 * DB ล่มให้ถอยไปกันซ้ำในหน่วยความจำของ process นี้แทน
 */
export async function claimForSend(key: string, hours: number): Promise<boolean> {
  try {
    const claimed = await queryOne<{ dedupe_key: string }>(
      `INSERT INTO maintenance_alert_dedupe (dedupe_key, first_sent_at, last_seen_at, hits)
       VALUES ($1, now(), now(), 0)
       ON CONFLICT (dedupe_key) DO UPDATE SET first_sent_at = now(), last_seen_at = now(), hits = 0
         WHERE maintenance_alert_dedupe.first_sent_at < now() - interval '1 hour' * $2::float8
       RETURNING dedupe_key`,
      [key, hours]
    )
    if (claimed) return true
    await query('UPDATE maintenance_alert_dedupe SET last_seen_at = now(), hits = hits + 1 WHERE dedupe_key = $1', [key])
    return false
  } catch (err) {
    console.warn('[MT-events] ตาราง maintenance_alert_dedupe ใช้ไม่ได้ กันซ้ำในหน่วยความจำแทน:', err instanceof Error ? err.message : err)
    return !isDuplicate(`content:${key}`)
  }
}

/** ลบคีย์เก่าที่ไม่เห็นมานาน (เรียกตอนต่อ RabbitMQ ได้) */
async function purgeDedupe(): Promise<void> {
  try {
    await query(`DELETE FROM maintenance_alert_dedupe WHERE last_seen_at < now() - interval '30 days'`)
  } catch {
    // ตารางยังไม่ถูกสร้าง (ยังไม่ได้รัน db:setup) จะเห็น warn ตอน claimForSend แทน
  }
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
// รูปก่อนซ่อมบนการ์ดแจ้งซ่อมใหม่
//
// ระบบซ่อมบำรุงส่ง repair.requested ทันทีที่สร้างใบงาน แต่รูปที่ผู้แจ้งถ่ายไว้ถูกอัปโหลดเข้า filestorage
// "หลัง" จากนั้น (ต้องมี id ใบงานก่อน) และ filestorage ส่ง filestorage.file.uploaded ทีละไฟล์ โดย
// referenceId = id ใบงาน การ์ดจึงถูกพักไว้ใน pendingRepairs รอรูปจนกว่า
//   - ไม่มีรูปใหม่มาอีกภายใน quietMs หลังรูปล่าสุด (ส่งได้เลย ไม่ต้องรอจนครบ) หรือ
//   - ครบ waitMs นับจากแจ้งซ่อม (ส่งเลยแม้ไม่มีรูป — ใบงานที่ไม่มีรูปก็ต้องแจ้ง)
// ตอนนี้ใบงานใหม่มีได้แต่รูป "ก่อนซ่อม" (รูปหลังซ่อมมาตอนปิดงาน) ทุกรูปในช่วงรอจึงเป็นรูปก่อนซ่อม
// รูปในการ์ดใช้ <filesUrl>/{id}/preview ที่ filestorage ย่อให้ ≤1024px (ข้อจำกัดของ LINE Flex) และ
// แตะแล้วเปิด preview?w=2048 เพื่อดูชัด ๆ   พักไว้ในหน่วยความจำ: ถ้า process ตายระหว่างรอ การ์ดจะหาย
// แต่ message ยังไม่ถูก ack (handleMessage รอจนส่งเสร็จ) broker จึงส่งซ้ำให้ตอนต่อใหม่
// ---------------------------------------------------------------------------

interface PendingRepair {
  images: AlertImage[]
  /** ปลุก handleMessage ของ repair.requested ให้ส่งการ์ด */
  release: () => void
  quietTimer: NodeJS.Timeout | null
}

const pendingRepairs = new Map<string, PendingRepair>()

/** URL รูปสำหรับการ์ด (ย่อแล้ว) และสำหรับแตะเปิดดู */
function photoUrls(fileId: string): { url: string; openUri: string } | null {
  const base = config.maintenance.events.repairPhotos.filesUrl
  if (!base) return null
  return { url: `${base}/${fileId}/preview`, openUri: `${base}/${fileId}/preview?w=2048` }
}

/** ค่าใน snapshot After ของ FileUploadedEvent (คีย์เป็น PascalCase ตามชื่อ property ของ .NET หรือ camelCase) */
function snapshotValue(after: unknown, key: string): string {
  if (!after || typeof after !== 'object') return ''
  const o = after as Record<string, unknown>
  return str(o[key] ?? o[key.charAt(0).toLowerCase() + key.slice(1)])
}

/** เป็นไฟล์รูปไหม — ดู ContentType ก่อน ไม่มีก็ดูนามสกุล */
function isImageUpload(e: Json): boolean {
  const type = snapshotValue(e.after, 'ContentType').toLowerCase()
  if (type) return type.startsWith('image/')
  return /\.(jpe?g|png|gif|webp|heic|heif)$/i.test(str(e.fileName))
}

/**
 * รูปที่อัปโหลดเข้าใบงานที่กำลังรออยู่: เก็บแล้วเลื่อนเวลาส่ง (quiet period)
 * ใบงานที่ไม่ได้รออยู่ (รูปหลังซ่อม, ไฟล์ของระบบอื่น) ข้ามเงียบ ๆ
 */
function attachUploadedPhoto(e: Json): 'attached' | 'ignored' {
  const repairId = str(e.referenceId).toLowerCase()
  const fileId = str(e.fileId)
  const pending = repairId ? pendingRepairs.get(repairId) : undefined
  if (!pending || !fileId || !isImageUpload(e)) return 'ignored'
  const urls = photoUrls(fileId)
  if (!urls) return 'ignored'
  if (pending.images.some((img) => img.url === urls.url)) return 'ignored'
  pending.images.push({ ...urls, label: str(e.fileName) || undefined })
  if (pending.quietTimer) clearTimeout(pending.quietTimer)
  // ครบจำนวนที่การ์ดแสดงได้แล้วไม่ต้องรอต่อ
  if (pending.images.length >= MAX_ALERT_IMAGES) pending.release()
  else pending.quietTimer = setTimeout(pending.release, config.maintenance.events.repairPhotos.quietMs)
  return 'attached'
}

/**
 * สถานะล่าสุดของใบงานจาก repair service (ชื่อ enum เช่น "PendingApproval"; '' = อ่านไม่ได้)
 * event repair.requested ออกตอนสร้างใบงานซึ่งยังเป็น "แจ้งซ่อม" แต่เว็บ/มือถือจะส่งขออนุมัติต่อทันที
 * การ์ดถูกส่งหลังรอรูปอยู่แล้ว จึงอ่านสถานะจริง ณ ตอนส่งแทนที่จะเชื่อค่าใน event
 */
async function fetchRepairStatus(repairId: string): Promise<string> {
  const base = config.maintenance.repairApiUrl
  if (!base || !repairId) return ''
  try {
    const res = await fetch(`${base}/api/repair-requests/${encodeURIComponent(repairId)}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10000)
    })
    if (!res.ok) return ''
    const body = (await res.json()) as { data?: { repairStatus?: unknown } }
    return enumName(body.data?.repairStatus, REPAIR_STATUS)
  } catch {
    return ''
  }
}

/**
 * รายงานการใช้น้ำมันของรถหนึ่งคัน (fuel-usage-report?vehicleCode=) สำหรับส่วน "ความคุ้มค่า" บนการ์ดเบิกน้ำมัน
 * null = ไม่มีข้อมูล/อ่านไม่ได้ (การ์ดแสดงส่วนอื่นตามปกติ)
 */
async function fetchFuelUsage(vehicleCode: string): Promise<FuelUsageSummary | null> {
  const base = config.maintenance.fuelApiUrl
  if (!base || !vehicleCode) return null
  try {
    const res = await fetch(`${base}/api/fuel-requests/fuel-usage-report?vehicleCode=${encodeURIComponent(vehicleCode)}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10000)
    })
    if (!res.ok) return null
    const body = (await res.json()) as { data?: Json[] | Json }
    const rows = Array.isArray(body.data) ? body.data : body.data ? [body.data] : []
    const r = rows.find((x) => str(x.vehicleCode).toLowerCase() === vehicleCode.toLowerCase()) ?? rows[0]
    if (!r) return null
    const n = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null)
    return {
      basis: enumName(r.usageBasis, ['Odometer', 'WorkingHours']) === 'WorkingHours' ? 'WorkingHours' : 'Odometer',
      kmPerLiter: n(r.kmPerLiter),
      targetKmPerLiter: n(r.targetKmPerLiter) ?? 0,
      kmDriven: n(r.kmDriven),
      totalLiters: n(r.totalLiters) ?? 0,
      requestCount: n(r.requestCount) ?? 0,
      diffBaht: n(r.diffBaht),
      badge: str(r.badge).toLowerCase() || null
    }
  } catch {
    return null
  }
}

/** พักการ์ดแจ้งซ่อมไว้รอรูป แล้วคืนรูปที่รวบรวมได้ (ว่างได้) */
function waitForRepairPhotos(repairId: string): Promise<AlertImage[]> {
  const cfg = config.maintenance.events.repairPhotos
  if (!repairId || cfg.waitMs <= 0 || !cfg.filesUrl) return Promise.resolve([])
  const key = repairId.toLowerCase()
  const existing = pendingRepairs.get(key)
  if (existing) existing.release() // event เดิมซ้ำ: ปล่อยตัวเก่าให้ไปก่อน (dedupe ตอนส่งจะกันซ้ำให้)
  return new Promise((resolve) => {
    const entry: PendingRepair = { images: [], release: () => {}, quietTimer: null }
    let done = false
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(maxTimer)
      if (entry.quietTimer) clearTimeout(entry.quietTimer)
      if (pendingRepairs.get(key) === entry) pendingRepairs.delete(key)
      resolve(entry.images)
    }
    entry.release = finish
    const maxTimer = setTimeout(finish, cfg.waitMs)
    pendingRepairs.set(key, entry)
  })
}

// ---------------------------------------------------------------------------
// แปลง event แต่ละชนิดเป็นการ์ดแจ้งเตือน
// ---------------------------------------------------------------------------

function fromRepairRequested(e: Json, images: AlertImage[] = [], reporterName = '', status = ''): GroupAlert {
  const severity = enumName(e.severity, REPAIR_SEVERITY)
  const tone: AlertSeverity = severity === 'Emergency' ? 'urgent' : severity === 'High' ? 'warning' : 'info'
  const severityThai = severity === 'Emergency' ? 'ฉุกเฉิน' : severity === 'High' ? 'สูง' : 'ปกติ'
  const asset = str(e.assetCode)
  // event รุ่นใหม่มีเลขที่ใบงาน (REP-yyyyMM-####) และสถานที่; รุ่นเก่ามีแต่ id
  const reportedNo = str(e.reportedNo)
  const repairId = str(e.repairRequestId)
  // ผู้แจ้ง: ชื่อจากทะเบียน HR ถ้าหาได้ ไม่ได้ก็อีเมล/บัญชีที่ประทับมา
  const reporter = reporterName || str(e.by)
  const statusThai = REPAIR_STATUS_THAI[status] ?? status
  return normalizeAlert(
    {
      title: `แจ้งซ่อมใหม่ ${reportedNo || asset || shortId(repairId)}`,
      message: str(e.symptom) || 'ไม่ได้ระบุอาการ',
      severity: tone,
      details: details([
        ['ความรุนแรง', severityThai],
        ['ทรัพย์สิน', asset],
        ['สถานที่', locationThai(e.location)],
        ['ผู้แจ้ง', reporter],
        ['งานเลขที่', reportedNo || shortId(repairId)],
        ['สถานะ', statusThai]
      ]),
      // ลิงก์ตรงไปหน้าสถานะของใบงานนี้ (หน้าเดียวกับที่อีเมลแจ้งเตือนพาไป)
      actions: webAction('เปิดงานซ่อม', repairId ? `/services/maintenance-request/status?id=${encodeURIComponent(repairId)}` : '/services/maintenance-request'),
      reference: reportedNo || asset || shortId(repairId),
      images
    },
    reporter || 'ระบบซ่อมบำรุง'
  )
}

/**
 * ขอเบิกน้ำมัน (FuelRequestedEvent)
 * ผู้ขอ: ชื่อเต็มจากทะเบียน HR (ตามอีเมลผู้ขอ/บัญชีที่ประทับ) ถ้าหาได้ — requesterName ใน event
 * จากเว็บรุ่นเก่ามีแต่ชื่อไม่มีนามสกุล; สถานะแปลเป็นไทย (event ส่งชื่อ enum หรือตัวเลข)
 */
function fromFuelRequested(e: Json, requesterFullName = '', usage: FuelUsageSummary | null = null): GroupAlert {
  const vehicle = [str(e.vehicleCode), str(e.vehicleName)].filter(Boolean).join(' ')
  const auto = e.autoApproved === true
  const status = enumName(e.requestStatus, REQUEST_STATUS)
  const statusThai = REQUEST_STATUS_THAI[status] ?? status
  const liters = Number(e.requestedLiters)
  const requester = requesterFullName || str(e.requesterName) || str(e.requesterEmail) || str(e.by)
  const fuelType = str(e.fuelType)
  const base = normalizeAlert(
    {
      title: `ขอเบิกน้ำมัน ${str(e.requestNo) || shortId(e.fuelRequestId)}`,
      message: `${requester ? `คุณ${requester} ` : ''}ขอเบิกน้ำมันให้ ${vehicle || 'รถที่ไม่ระบุ'} ${
        auto ? 'อนุมัติอัตโนมัติแล้ว' : statusThai || 'รออนุมัติ'
      }`,
      severity: auto ? 'info' : 'warning',
      details: details([
        ['รถ', vehicle],
        ['ประเภทน้ำมัน', FUEL_TYPE_THAI[fuelType] ?? fuelType],
        ['จำนวน', `${Number.isFinite(liters) ? liters.toLocaleString('th-TH') : str(e.requestedLiters)} ลิตร`],
        ['ประมาณค่าใช้จ่าย', `${money(e.estimatedCost)} บาท`],
        ['ผู้ขอ', requester],
        ['โครงการ', str(e.projectCode)],
        ['สถานที่', locationThai(e.location)],
        ['เลขไมล์', Number(e.odometer) > 0 ? `${Number(e.odometer).toLocaleString('th-TH')} กม.` : ''],
        ['สถานะ', statusThai]
      ]),
      actions: webAction('เปิดหน้าอนุมัติ', '/services/fuel-request'),
      reference: str(e.requestNo) || undefined
    },
    requester || 'ระบบซ่อมบำรุง'
  )
  // การ์ดเฉพาะทาง: ไฮไลต์ปริมาณ + ส่วนความคุ้มค่าของรถ (base ยังใช้เป็น altText/ข้อความสำรอง)
  const card = {
    requestNo: str(e.requestNo) || shortId(e.fuelRequestId),
    vehicle,
    requester,
    fuelType: FUEL_TYPE_THAI[fuelType] ?? fuelType,
    liters: Number.isFinite(liters) ? liters : null,
    estimatedCost: Number.isFinite(Number(e.estimatedCost)) ? Number(e.estimatedCost) : null,
    projectCode: str(e.projectCode),
    location: locationThai(e.location),
    odometer: Number.isFinite(Number(e.odometer)) ? Number(e.odometer) : null,
    status: statusThai,
    autoApproved: auto,
    usage
  }
  return { ...base, custom: buildFuelRequestCard(card), customText: fuelRequestCardToText(card) }
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

  // เอกสารใกล้หมดอายุ (asset service) มีการ์ดของตัวเอง: การ์ดกลางจะโชว์
  // "ประเภท: document_expiry_sticker" และซ่อนเลข "เหลือกี่วัน" ไว้ในข้อความ
  const digest = parseExpiryDigest(e, config.maintenance.webUrl)
  if (digest) {
    const base = normalizeAlert(
      {
        title: str(e.title) || `${digest.categoryLabel}: เอกสารใกล้หมดอายุ`,
        message: str(e.message) || '-',
        severity,
        items: Array.isArray(e.items) ? e.items : [],
        reference: undefined
      },
      str(e.requestedBy) || 'ระบบเอกสารและวันหมดอายุ'
    )
    return { ...base, custom: buildExpiryDigestCard(digest), customText: expiryDigestToText(digest) }
  }

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

export function mapEventToAlert(
  routingKey: string,
  e: Json,
  images: AlertImage[] = [],
  reporterName = '',
  status = '',
  usage: FuelUsageSummary | null = null
): GroupAlert | null {
  if (routingKey === 'repair.requested') return fromRepairRequested(e, images, reporterName, status)
  if (routingKey === 'fuel.requested') return fromFuelRequested(e, reporterName, usage)
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

  // ไฟล์ที่อัปโหลด: ไม่มีการ์ดของตัวเอง แค่เติมรูปให้การ์ดแจ้งซ่อมที่รออยู่
  if (key === 'filestorage.file.uploaded') {
    const outcome = attachUploadedPhoto(payload)
    if (outcome === 'attached') console.log(`[MT-events] ${key}: แนบรูป ${str(payload.fileName)} ให้ใบงาน ${shortId(payload.referenceId)}`)
    return
  }

  // แจ้งซ่อมใหม่: พักการ์ดรอรูปก่อนซ่อมที่กำลังอัปโหลดตามมา (ดูคำอธิบายที่ pendingRepairs)
  let images: AlertImage[] = []
  let reporterName = ''
  let status = ''
  let usage: FuelUsageSummary | null = null
  if (key === 'repair.requested') {
    const repairId = str(payload.repairRequestId)
    // หาชื่อผู้แจ้งจาก HR ระหว่างรอรูป แล้วค่อยอ่านสถานะล่าสุดหลังรอ (ตอนนั้นเว็บส่งขออนุมัติไปแล้ว) ทั้งหมด best-effort
    const [photos, name] = await Promise.all([waitForRepairPhotos(repairId), resolvePersonName(str(payload.by)).catch(() => null)])
    images = photos
    reporterName = name ?? ''
    status = await fetchRepairStatus(repairId)
    if (images.length > 0) console.log(`[MT-events] ${key}: ได้รูปก่อนซ่อม ${images.length} รูปสำหรับใบงาน ${shortId(repairId)}`)
  } else if (key === 'fuel.requested') {
    // ชื่อเต็มผู้ขอจาก HR (ตามอีเมลผู้ขอก่อน ไม่ได้ก็บัญชีที่ประทับ) และรายงานความคุ้มค่าของรถคันนั้น
    const [name, report] = await Promise.all([
      resolvePersonName(str(payload.requesterEmail) || str(payload.by)).catch(() => null),
      fetchFuelUsage(str(payload.vehicleCode))
    ])
    reporterName = name ?? ''
    usage = report
  }

  const alert = mapEventToAlert(key, payload, images, reporterName, status, usage)
  if (!alert) {
    stats.skipped++
    console.log(`[MT-events] ข้าม ${key}: ไม่มีตัวแปลงสำหรับ routing key นี้`)
    return
  }

  const cfg = config.maintenance.events
  if (cfg.skipOwnAnalysisAlerts && isOwnAnalysisAlert(key, payload)) {
    stats.deduped++
    console.log(`[MT-events] ข้าม ${key} "${alert.title}": alert อัตโนมัติจากคำถามของแอปนี้เอง (${str(payload.tool)} โดย ${str(payload.requestedBy)})`)
    return
  }
  const contentKey = dedupeKey(key, payload)
  if (contentKey && cfg.dedupeHours > 0 && !(await claimForSend(contentKey, cfg.dedupeHours))) {
    stats.deduped++
    console.log(`[MT-events] ข้าม ${key} "${alert.title}": ส่ง ${contentKey} ไปแล้วภายใน ${cfg.dedupeHours} ชม.`)
    return
  }

  // payload จาก MCP ระบุ groupId ได้ (AlertNotifications:GroupId) ถ้าตรงกับกลุ่มที่บอทอยู่ให้ส่งเฉพาะกลุ่มนั้น
  // ไม่ระบุ/ไม่ตรง -> กลุ่มของทีมซ่อมบำรุงเท่านั้น (MT_ALERT_GROUP_IDS หรือชื่อกลุ่มมีคำว่า MT) ไม่ใช่ทุกกลุ่มที่บอทอยู่
  const groupHint = str(payload.groupId) || null
  let result = await pushAlertToGroups(alert, `mt-events:${key}`, groupHint)
  if (result.targets === 0 && groupHint) {
    console.warn(`[MT-events] ${key}: ไม่พบกลุ่ม ${groupHint} ที่บอทอยู่ ส่งเข้ากลุ่มทีมซ่อมบำรุงแทน`)
    result = await pushAlertToGroups(alert, `mt-events:${key}`)
  }

  if (result.targets === 0) {
    stats.skipped++
    console.warn(
      `[MT-events] ${key}: ยังไม่มีกลุ่มทีมซ่อมบำรุงให้ส่ง (เชิญบอทเข้ากลุ่มที่ชื่อมีคำว่า MT/ซ่อมบำรุง หรือตั้ง MT_ALERT_GROUP_IDS)`
    )
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
  // ผูก listener 'error' ทันที: amqplib โยน error ของ channel ที่ไม่มีใครฟังขึ้นมาเป็น 'error' ของ connection
  // ถ้ายังไม่ได้ผูกตอน assertExchange/assertQueue ล้ม (เช่น exchange ประกาศไว้คนละชนิด) process จะตายทั้งตัว
  conn.on('error', (err) => {
    stats.lastError = describeAmqpError(err)
    console.error('[MT-events] การเชื่อมต่อ RabbitMQ ผิดพลาด:', stats.lastError)
  })
  // ต่อ broker ได้แล้วแต่ขั้นถัดไปล้ม (เช่น exchange ถูกประกาศไว้คนละชนิด) ต้องปิด connection ก่อน throw ไม่งั้นค้างทุกรอบที่ลองใหม่
  try {
    const ch = await conn.createChannel()
    ch.on('error', (err) => {
      stats.lastError = describeAmqpError(err)
      console.error('[MT-events] channel RabbitMQ ผิดพลาด:', stats.lastError)
    })
    await ch.assertExchange(cfg.exchange, 'topic', { durable: true })
    await ch.assertQueue(cfg.queue, { durable: true })
    for (const key of cfg.routingKeys) await ch.bindQueue(cfg.queue, cfg.exchange, key)
    // การ์ดแจ้งซ่อมถูกพักรอรูปได้ถึง waitMs โดยยังไม่ ack ต้องเผื่อให้ event อื่นไหลต่อได้ระหว่างนั้น
    await ch.prefetch(20)

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
          stats.lastError = describeAmqpError(err)
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
  } catch (err) {
    connection = null
    channel = null
    await closeAbandonedConnection(conn)
    throw err
  }
  void purgeDedupe()
  console.log(
    `[MT-events] รับ event จาก RabbitMQ แล้ว (exchange ${cfg.exchange}, queue ${cfg.queue}, keys: ${cfg.routingKeys.join(', ')})`
  )
}

async function connectWithRetry(): Promise<void> {
  if (stopping || connection) return
  try {
    await connect()
  } catch (err) {
    stats.lastError = describeAmqpError(err)
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
  warnIfLocalhostBrokerInContainer('MT-events', config.maintenance.events.url, 'RABBITMQ_URL')
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
