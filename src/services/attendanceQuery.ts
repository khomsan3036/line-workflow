import { config } from '../config'

// ---------------------------------------------------------------------------
// แปลงข้อความภาษาไทยที่ผู้ใช้พิมพ์ในแชท ให้เป็นคำถามสรุปการเข้างาน
//
//   "สรุปจำนวนพนักงานประจำวัน"        -> วันนี้ ทุกสถานที่
//   "พนักงานเข้างานเมื่อวาน workshop" -> เมื่อวาน เฉพาะ Workshop
//   "สรุปพนักงานอาทิตย์ที่แล้ว site"  -> สัปดาห์ก่อน (จ-อา) เฉพาะ Site
//   "สรุปพนักงาน 28/8"                 -> วันที่ระบุ
//
// คืน null เมื่อข้อความไม่เกี่ยวกับการเข้างาน (ให้ menu/fallback จัดการต่อ)
// ---------------------------------------------------------------------------

export type LocationFilter = 'all' | 'Workshop' | 'Site'

export type PeriodKey =
  | 'today'
  | 'yesterday'
  | 'thisWeek'
  | 'lastWeek'
  | 'thisMonth'
  | 'lastMonth'
  | 'date'

export interface DatePeriod {
  key: PeriodKey
  /** true = วันเดียว, false = ช่วงหลายวัน */
  single: boolean
  /** YYYY-MM-DD (เวลาท้องถิ่นตาม TZ) */
  start: string
  end: string
  /** ป้ายแสดงผล เช่น "วันนี้ · พุธ 2 ก.ย. 2569" */
  label: string
}

export interface AttendanceQuery {
  period: DatePeriod
  location: LocationFilter
}

// คำที่บอกว่าผู้ใช้กำลังถามเรื่องการเข้างาน (ต้องเจออย่างน้อย 1 คำ)
const INTENT_WORDS = [
  'สรุปจำนวนพนักงาน',
  'จำนวนพนักงาน',
  'สรุปพนักงาน',
  'พนักงานเข้างาน',
  'คนเข้างาน',
  'เข้างาน',
  'มาทำงาน',
  'สแกนเข้า',
  'สแกนนิ้ว',
  'การสแกน',
  'มากี่คน',
  'attendance',
  'check in',
  'checkin',
  'check-in',
  'checktimein'
]

const PERIOD_WORDS: { key: PeriodKey; words: string[] }[] = [
  { key: 'lastWeek', words: ['อาทิตย์ที่แล้ว', 'สัปดาห์ที่แล้ว', 'อาทิตย์ก่อน', 'สัปดาห์ก่อน', 'last week', 'lastweek'] },
  { key: 'thisWeek', words: ['อาทิตย์นี้', 'สัปดาห์นี้', 'this week', 'thisweek'] },
  { key: 'lastMonth', words: ['เดือนที่แล้ว', 'เดือนก่อน', 'last month', 'lastmonth'] },
  { key: 'thisMonth', words: ['เดือนนี้', 'this month', 'thismonth'] },
  { key: 'yesterday', words: ['เมื่อวานนี้', 'เมื่อวาน', 'yesterday'] },
  { key: 'today', words: ['วันนี้', 'ประจำวัน', 'today'] }
]

const LOCATION_WORDS: { key: LocationFilter; words: string[] }[] = [
  { key: 'Workshop', words: ['workshop', 'เวิร์คช็อป', 'เวิร์กช็อป', 'เวิร์คชอป', 'โรงงาน'] },
  { key: 'Site', words: ['site', 'ไซต์', 'ไซท์', 'ไซด์', 'หน้างาน'] },
  { key: 'all', words: ['ทั้งหมด', 'ทุกที่', 'ทุกสถานที่', 'รวมทุก', 'all'] }
]

export const LOCATION_LABELS: Record<LocationFilter, string> = {
  all: 'ทุกสถานที่',
  Workshop: 'Workshop',
  Site: 'Site'
}

const THAI_DAYS = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์']
const THAI_DAYS_SHORT = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส']
const THAI_MONTHS_SHORT = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.']

// ---------------------------------------------------------------------------
// ตัวช่วยเรื่องวันที่ - ทำงานบน "วันที่ท้องถิ่น" (YYYY-MM-DD) ตาม TZ ใน .env
// ไม่ใช้ Date โดยตรงเพราะเซิร์ฟเวอร์อาจไม่ได้ตั้ง TZ เป็นไทย
// ---------------------------------------------------------------------------

/** วันนี้ตามเขตเวลาที่ตั้งไว้ */
export function todayLocal(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date())
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00'
  return `${get('year')}-${get('month')}-${get('day')}`
}

/** เวลาปัจจุบัน HH:mm ตามเขตเวลาที่ตั้งไว้ */
export function nowTimeLocal(): string {
  return new Intl.DateTimeFormat('th-TH', {
    timeZone: config.timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(new Date())
}

function toUtcDate(ymd: string): Date {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}

function fromUtcDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export function addDays(ymd: string, days: number): string {
  const d = toUtcDate(ymd)
  d.setUTCDate(d.getUTCDate() + days)
  return fromUtcDate(d)
}

/** 0 = อาทิตย์ ... 6 = เสาร์ */
export function dayOfWeek(ymd: string): number {
  return toUtcDate(ymd).getUTCDay()
}

/** "พุธ 2 ก.ย. 2569" */
export function formatThaiDate(ymd: string, opts: { weekday?: boolean; year?: boolean } = {}): string {
  const d = toUtcDate(ymd)
  const day = d.getUTCDate()
  const month = THAI_MONTHS_SHORT[d.getUTCMonth()]
  const year = d.getUTCFullYear() + 543
  const weekday = opts.weekday === false ? '' : `${THAI_DAYS[d.getUTCDay()]} `
  return `${weekday}${day} ${month}${opts.year === false ? '' : ` ${year}`}`
}

/** "พ 2 ก.ย." สำหรับแถวรายวัน */
export function formatThaiDateShort(ymd: string): string {
  const d = toUtcDate(ymd)
  return `${THAI_DAYS_SHORT[d.getUTCDay()]} ${d.getUTCDate()} ${THAI_MONTHS_SHORT[d.getUTCMonth()]}`
}

function rangeLabel(start: string, end: string): string {
  return `${formatThaiDate(start, { weekday: false, year: false })} - ${formatThaiDate(end, { weekday: false })}`
}

export function buildPeriod(key: PeriodKey, today = todayLocal(), explicitDate?: string): DatePeriod {
  switch (key) {
    case 'today':
      return { key, single: true, start: today, end: today, label: `วันนี้ · ${formatThaiDate(today)}` }
    case 'yesterday': {
      const d = addDays(today, -1)
      return { key, single: true, start: d, end: d, label: `เมื่อวาน · ${formatThaiDate(d)}` }
    }
    case 'thisWeek': {
      // สัปดาห์เริ่มวันจันทร์
      const offset = (dayOfWeek(today) + 6) % 7
      const start = addDays(today, -offset)
      const end = addDays(start, 6)
      return { key, single: false, start, end, label: `สัปดาห์นี้ · ${rangeLabel(start, end)}` }
    }
    case 'lastWeek': {
      const offset = (dayOfWeek(today) + 6) % 7
      const start = addDays(today, -offset - 7)
      const end = addDays(start, 6)
      return { key, single: false, start, end, label: `สัปดาห์ที่แล้ว · ${rangeLabel(start, end)}` }
    }
    case 'thisMonth': {
      const start = `${today.slice(0, 7)}-01`
      const next = addDays(`${today.slice(0, 7)}-28`, 4)
      const end = addDays(`${next.slice(0, 7)}-01`, -1)
      return { key, single: false, start, end, label: `เดือนนี้ · ${rangeLabel(start, end)}` }
    }
    case 'lastMonth': {
      const end = addDays(`${today.slice(0, 7)}-01`, -1)
      const start = `${end.slice(0, 7)}-01`
      return { key, single: false, start, end, label: `เดือนที่แล้ว · ${rangeLabel(start, end)}` }
    }
    case 'date': {
      const d = explicitDate ?? today
      return { key, single: true, start: d, end: d, label: formatThaiDate(d) }
    }
  }
}

/** รองรับ 28/8, 28/08/2569, 28-8-2026, 2026-08-28 (ไม่จับรหัสพนักงานรูปแบบ S69-1-003) */
export function parseExplicitDate(text: string, today: string): string | null {
  const iso = text.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/)
  if (iso) return normalizeYmd(Number(iso[1]), Number(iso[2]), Number(iso[3]))

  // ตัดรหัสพนักงาน (เช่น S69-1-003, 20-1-026) ออกก่อน ไม่ให้ถูกอ่านเป็นวันที่
  const cleaned = text.replace(/\b[a-z]{0,3}\d{1,3}-\d{1,2}-\d{3,4}\b/gi, ' ')
  const dmy = cleaned.match(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/)
  if (!dmy) return null
  const day = Number(dmy[1])
  const month = Number(dmy[2])
  let year = dmy[3] ? Number(dmy[3]) : Number(today.slice(0, 4))
  if (year < 100) year += 2000
  if (year > 2400) year -= 543 // พ.ศ. -> ค.ศ.
  return normalizeYmd(year, month, day)
}

function normalizeYmd(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null
  const dt = new Date(Date.UTC(y, m - 1, d))
  if (dt.getUTCMonth() !== m - 1) return null
  return fromUtcDate(dt)
}

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ')
}

export function isAttendanceIntent(text: string): boolean {
  const t = normalize(text)
  return INTENT_WORDS.some((w) => t.includes(w))
}

/** หาช่วงเวลาจากข้อความ (วันนี้/เมื่อวาน/สัปดาห์/เดือน/วันที่ระบุ) ค่าเริ่มต้น = วันนี้ */
export function detectPeriod(text: string, today = todayLocal()): DatePeriod {
  const t = normalize(text)
  const explicit = parseExplicitDate(t, today)
  if (explicit) return buildPeriod('date', today, explicit)
  for (const p of PERIOD_WORDS) {
    if (p.words.some((w) => t.includes(w))) return buildPeriod(p.key, today)
  }
  return buildPeriod('today', today)
}

/**
 * แปลงข้อความเป็นคำถาม - คืน null ถ้าไม่ใช่คำถามเรื่องการเข้างาน
 * ค่าเริ่มต้นเมื่อไม่ระบุ: วันนี้ + ทุกสถานที่
 */
export function parseAttendanceQuery(text: string, today = todayLocal()): AttendanceQuery | null {
  const t = normalize(text)
  if (!INTENT_WORDS.some((w) => t.includes(w))) return null

  let location: LocationFilter = 'all'
  for (const l of LOCATION_WORDS) {
    if (l.words.some((w) => t.includes(w))) {
      location = l.key
      break
    }
  }

  return { period: detectPeriod(t, today), location }
}
