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

/** มุมมองการแยกตัวเลข: ตามสถานที่ (ค่าเริ่มต้น) / ตามแผนก / ตามตำแหน่ง */
export type GroupBy = 'location' | 'department' | 'position'

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
  groupBy: GroupBy
  /** กรองเฉพาะแผนกนี้ (ชื่อตามทะเบียน HR เช่น "IT", "QA/QC") ไม่ระบุ = ทุกแผนก */
  department?: string
  /** กรองเฉพาะตำแหน่งนี้ (ชื่อตาม JOBTITLE เช่น "Fitter A", "Foreman") ไม่ระบุ = ทุกตำแหน่ง */
  position?: string
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
  'checktimein',
  // ถามแบบแยกตามแผนก/ตำแหน่ง เช่น "แยกตามแผนก วันนี้", "ตามตำแหน่ง site"
  'ตามแผนก',
  'แยกแผนก',
  'รายแผนก',
  'ตามฝ่าย',
  'ตามหน่วยงาน',
  'ตามตำแหน่ง',
  'แยกตำแหน่ง',
  'รายตำแหน่ง'
]

// เรียงคำเฉพาะเจาะจงก่อน: "แผนก IT ตามสถานที่" ต้องได้ตามสถานที่ ไม่ใช่ตามแผนก (คำว่า แผนก อยู่ในตัวกรอง)
const GROUP_WORDS: { key: GroupBy; words: string[] }[] = [
  { key: 'location', words: ['ตามสถานที่', 'แยกสถานที่', 'รายสถานที่', 'by location'] },
  { key: 'position', words: ['ตำแหน่ง', 'position', 'job title', 'jobtitle'] },
  { key: 'department', words: ['แผนก', 'ฝ่าย', 'หน่วยงาน', 'department', 'dept'] }
]

/**
 * คำไทย/คำย่อที่ผู้ใช้พิมพ์แทนชื่อแผนกในทะเบียน HR (ชื่อจริงเป็นอังกฤษ เช่น Production, QA/QC)
 * ชื่อจริงทุกชื่อจับได้อยู่แล้วโดยไม่ต้องใส่ที่นี่ (เทียบทั้งคำ ไม่สนตัวพิมพ์เล็กใหญ่)
 */
const DEPARTMENT_ALIASES: Record<string, string[]> = {
  IT: ['ไอที', 'ไอ ที', 'คอม', 'คอมพิวเตอร์'],
  HR: ['บุคคล', 'ฝ่ายบุคคล', 'ทรัพยากรบุคคล', 'เอชอาร์'],
  HSE: ['ความปลอดภัย', 'เซฟตี้', 'เซฟตี', 'safety', 'จป'],
  'QA/QC': ['qa', 'qc', 'qaqc', 'qa qc', 'คิวซี', 'คุณภาพ'],
  Production: ['ผลิต', 'ฝ่ายผลิต', 'โปรดักชั่น'],
  Painting: ['สี', 'พ่นสี', 'ทาสี', 'paint'],
  Scaffolding: ['นั่งร้าน', 'scaffold'],
  Maintenance: ['ซ่อมบำรุง', 'ซ่อม', 'เมนเทนแนนซ์', 'mt'],
  Administration: ['ธุรการ', 'admin'],
  Warehouse: ['คลังสินค้า', 'คลัง'],
  Store: ['สโตร์', 'สโตร'],
  Procurement: ['จัดซื้อ', 'purchase', 'purchasing'],
  Insulation: ['ฉนวน'],
  Project: ['โครงการ'],
  'Project Control': ['project control', 'คุมโครงการ'],
  Management: ['ผู้บริหาร', 'บริหาร'],
  Engineering: ['วิศวกรรม', 'วิศวกร'],
  Civil: ['โยธา'],
  Transportation: ['ขนส่ง'],
  ผู้รับเหมา: ['ผรม', 'ผรม.', 'รับเหมา', 'contractor', 'subcontract'],
  ไม่ระบุ: ['ไม่ระบุแผนก', 'ไม่มีแผนก']
}

/** คำไทยที่ผู้ใช้พิมพ์แทนชื่อตำแหน่งใน JOBTITLE (ใช้ต่อเมื่อมีคำว่า "ตำแหน่ง" ในข้อความ กันชนกับคำแผนก) */
const POSITION_ALIASES: Record<string, string[]> = {
  Welder: ['ช่างเชื่อม', 'เชื่อม'],
  Foreman: ['โฟร์แมน', 'โฟแมน', 'หัวหน้างาน'],
  Painter: ['ช่างสี', 'ช่างพ่นสี'],
  Helper: ['ผู้ช่วยช่าง', 'คนงาน'],
  Scaffolder: ['ช่างนั่งร้าน'],
  Supervisor: ['ซุปเปอร์ไวเซอร์', 'หัวหน้า'],
  Driver: ['คนขับ', 'คนขับรถ', 'พขร'],
  Rigger: ['ริกเกอร์'],
  'QC Inspector': ['ผู้ตรวจสอบคุณภาพ'],
  'Safety Supervisor': ['จป.', 'เซฟตี้'],
  'Fire Watch': ['ไฟร์วอช', 'เฝ้าไฟ'],
  Engineer: ['วิศวกร'],
  Flagman: ['คนโบกธง'],
  ไม่ระบุ: ['ไม่ระบุตำแหน่ง', 'ไม่มีตำแหน่ง']
}

/** จับ "ทั้งคำ" สำหรับชื่ออังกฤษ ("it" ต้องไม่ไปตรงกับ "site") ส่วนภาษาไทยใช้ substring ตามปกติ */
function containsWord(text: string, word: string): boolean {
  const w = word.toLowerCase()
  if (!/[a-z]/.test(w)) return text.includes(w)
  return new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}($|[^a-z0-9])`).test(text)
}

/**
 * หาแผนกที่ผู้ใช้ระบุจากข้อความ เทียบกับรายชื่อแผนกจริง (listDepartments ใน attendance.ts) และคำแทนใน DEPARTMENT_ALIASES
 * ชื่อยาวก่อน ("Project Control" ก่อน "Project") คืน undefined เมื่อไม่ได้ระบุแผนก (เช่น "ตามแผนก" เฉย ๆ)
 */
export function detectDepartment(text: string, departments: string[]): string | undefined {
  return matchName(normalize(text), departments, DEPARTMENT_ALIASES, true)?.name
}

/**
 * หาตำแหน่งที่ผู้ใช้ระบุ (รายชื่อจาก listPositions ใน attendance.ts) ชื่ออังกฤษจับได้ทุกที่ในข้อความ
 * ส่วนคำไทยใน POSITION_ALIASES ต้องมีคำว่า "ตำแหน่ง" กำกับ ("ช่างสี" จะได้ไม่ชนกับแผนก Painting)
 */
export function detectPosition(text: string, positions: string[]): string | undefined {
  const t = normalize(text)
  return matchName(t, positions, POSITION_ALIASES, /ตำแหน่ง|position/.test(t))?.name
}

/** จับชื่อจากรายชื่อ + คำแทน ชื่อยาวก่อน คืนชื่อจริงและคำที่จับได้ (เอาไว้ตัดออกจากข้อความก่อนหาชื่อชนิดอื่น) */
function matchName(
  t: string,
  names: string[],
  aliases: Record<string, string[]>,
  allowAliases: boolean,
  accept: (name: string, word: string) => boolean = () => true
): { name: string; word: string } | undefined {
  const candidates = names
    .map((name) => ({ name, words: [name, ...(allowAliases ? (aliases[name] ?? []) : [])] }))
    .sort((a, b) => b.name.length - a.name.length)
  for (const c of candidates) {
    const words = [...c.words].sort((a, b) => b.length - a.length)
    const word = words.find((w) => containsWord(t, w) && accept(c.name, w.toLowerCase()))
    if (word) return { name: c.name, word: word.toLowerCase() }
  }
  return undefined
}

const DEPARTMENT_LABEL = /แผนก|ฝ่าย|department|dept\.?/
const POSITION_LABEL = /ตำแหน่ง|position/

/** คำนี้มีคำบอกชนิด (แผนก/ตำแหน่ง) นำหน้าอยู่ในข้อความหรือไม่ เช่น "แผนก procurement" */
function labeledAs(t: string, label: RegExp, word: string): boolean {
  const w = word.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
  return new RegExp(`(?:${label.source})\\s*${w}`).test(t)
}

export const GROUP_LABELS: Record<GroupBy, string> = {
  location: 'ตามสถานที่',
  department: 'ตามแผนก',
  position: 'ตามตำแหน่ง'
}

/** ชื่อหน่วยของกลุ่ม ใช้ในประโยค เช่น "12 แผนก" */
export const GROUP_UNITS: Record<GroupBy, string> = {
  location: 'สถานที่',
  department: 'แผนก',
  position: 'ตำแหน่ง'
}

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

/** มุมมองการแยก (ค่าเริ่มต้น = ตามสถานที่) */
export function detectGroupBy(text: string): GroupBy {
  const t = normalize(text)
  for (const g of GROUP_WORDS) {
    if (g.words.some((w) => t.includes(w))) return g.key
  }
  return 'location'
}

/**
 * แปลงข้อความเป็นคำถาม - คืน null ถ้าไม่ใช่คำถามเรื่องการเข้างาน
 * ค่าเริ่มต้นเมื่อไม่ระบุ: วันนี้ + ทุกสถานที่ + แยกตามสถานที่
 *   "สรุปพนักงาน วันนี้ ตามแผนก"            -> แยกตามแผนก ทุกสถานที่
 *   "สรุปพนักงาน workshop ตามตำแหน่ง"       -> แยกตามตำแหน่ง เฉพาะ Workshop
 */
export function parseAttendanceQuery(
  text: string,
  today = todayLocal(),
  options: { departments?: string[]; positions?: string[] } = {}
): AttendanceQuery | null {
  const t = normalize(text)
  const departments = options.departments ?? []
  // ชื่อที่เป็นทั้งแผนกและตำแหน่งใน MANPOWER_HR (Procurement, Administration, Safety, Maintenance, Civil):
  // ถือเป็นตำแหน่งต่อเมื่อพิมพ์ "ตำแหน่ง X" ไม่งั้นเป็นแผนก ("แผนก Procurement ตามตำแหน่ง" เคยถูกอ่านเป็น
  // ตำแหน่ง Procurement แล้วแยกตามแผนก จนการ์ดโชว์แค่ Administration คนเดียว)
  const isDepartmentWord = (word: string) =>
    !labeledAs(t, POSITION_LABEL, word) &&
    (labeledAs(t, DEPARTMENT_LABEL, word) || departments.some((d) => d.toLowerCase() === word))
  // ตัวกรองตำแหน่งก่อน แล้วตัดคำที่จับได้ออกก่อนหาแผนก ("ตำแหน่ง Safety Supervisor" จะได้ไม่กลายเป็นแผนก HSE)
  const positionHit = t.includes('ทุกตำแหน่ง')
    ? undefined
    : matchName(t, options.positions ?? [], POSITION_ALIASES, /ตำแหน่ง|position/.test(t), (_name, word) => !isDepartmentWord(word))
  const rest = positionHit ? t.replace(positionHit.word, ' ') : t
  const department = rest.includes('ทุกแผนก') ? undefined : detectDepartment(rest, departments)
  const position = positionHit?.name

  // "แผนก IT" / "ตำแหน่ง Foreman" ก็ถือเป็นคำถามเรื่องเข้างาน แม้ไม่มีคำว่าสรุปพนักงาน
  const mentionsFilter =
    (department !== undefined && /แผนก|department|dept/.test(t)) || (position !== undefined && /ตำแหน่ง|position/.test(t))
  if (!mentionsFilter && !INTENT_WORDS.some((w) => t.includes(w))) return null

  let location: LocationFilter = 'all'
  for (const l of LOCATION_WORDS) {
    if (l.words.some((w) => t.includes(w))) {
      location = l.key
      break
    }
  }

  // มุมมองที่ซ้ำกับตัวกรองไม่มีความหมาย: กรองแผนก -> ดูตำแหน่งในแผนก, กรองตำแหน่ง -> ดูว่าอยู่แผนกไหน,
  // กรองทั้งคู่ -> ดูตามสถานที่ (ขอ "ตามสถานที่" ชัดเจนได้เสมอ)
  let groupBy = detectGroupBy(t)
  if (department !== undefined && position !== undefined && groupBy !== 'location') groupBy = 'location'
  else if (department !== undefined && groupBy === 'department') groupBy = 'position'
  else if (position !== undefined && groupBy === 'position') groupBy = 'department'

  return {
    period: detectPeriod(t, today),
    location,
    groupBy,
    ...(department !== undefined ? { department } : {}),
    ...(position !== undefined ? { position } : {})
  }
}
