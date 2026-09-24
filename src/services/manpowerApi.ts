import { config } from '../config'

// ---------------------------------------------------------------------------
// เรียก API ระบบ HR (qtecintegra) เพื่อดูเวลาเข้า-ออกของพนักงานรายคน
//
//   GET {MANPOWER_API_URL}?TMT_DATE_START=YYYY-MM-DD&TMT_DATE_END=YYYY-MM-DD&prs_no=S69-1-003
//
// API คืนอย่างน้อย 1 แถวต่อวัน (มีทุกวันในช่วง แม้วันหยุด) โดย loG_FOUND = 'Y' เมื่อมีการสแกน
// พนักงานที่มีทะเบียนทั้งฐาน Site และ Workshop ได้ 1 แถวต่อฐานต่อวัน จึงต้องรวมเป็นวันละแถว (toDailyRecords)
// ถ้าไม่พบรหัสพนักงาน API ตอบ HTTP 400 พร้อม errorMessages ["No Employee Found"]
// ข้อควรระวัง: ห้ามเรียกโดยไม่ส่ง prs_no เพราะ API จะคืนข้อมูลของทุกคน
// ---------------------------------------------------------------------------

interface ApiEnvelope {
  statusCode: number
  isSuccess: boolean
  errorMessages: string[]
  result: ApiRow[] | null
}

interface ApiRow {
  prS_NO: string
  fulllname: string | null
  name: string | null
  surname: string | null
  position: string | null
  dept: string | null
  emP_TYPE: string | null
  tmT_DATE: string
  /** วันที่ของแถวเสมอ (tmT_DATE เป็น "0001-01-01" เมื่อ bPlus ยังไม่มีแถว TMTRAN ของวันนั้น) */
  checkdate: string | null
  stampin: string | null
  stampout: string | null
  sF_INOUT: string | null
  sF_CODE: string | null
  tmT_WORK_HOUR: number | null
  loG_FOUND: string | null
  shifT_FOUND: string | null
  working: number
  leave: number
  absent: number
  status: string | null
  remark: string | null
  scaN_1: string | null
  scaN_2: string | null
  scaN_3: string | null
  scaN_4: string | null
  tmT_STAMPINFO: string | null
}

export interface EmployeeInfo {
  prsNo: string
  fullName: string
  position: string | null
  dept: string | null
  empType: string | null
}

export interface TimeRecord {
  /** YYYY-MM-DD */
  date: string
  /** HH:mm หรือ null */
  stampIn: string | null
  stampOut: string | null
  /** เวลากะ HH:mm */
  shiftStart: string | null
  shiftEnd: string | null
  shiftCode: string | null
  shiftHours: number | null
  /** มีการสแกนอย่างน้อย 1 ครั้ง */
  hasLog: boolean
  /** เวลาสแกนทั้งหมดที่ระบบเก็บไว้ (เรียงตามลำดับ) */
  scans: string[]
  leave: boolean
  absent: boolean
  remark: string | null
}

export interface ManpowerResult {
  employee: EmployeeInfo
  records: TimeRecord[]
}

export class EmployeeNotFoundError extends Error {
  constructor(public readonly prsNo: string) {
    super(`ไม่พบรหัสพนักงาน ${prsNo}`)
  }
}

function hhmm(value: string | null | undefined): string | null {
  if (!value) return null
  const m = value.match(/^(\d{1,2}):(\d{2})/)
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null
}

/** "08:00  17:00" -> ["08:00", "17:00"] */
function parseShift(value: string | null): [string | null, string | null] {
  if (!value) return [null, null]
  const parts = value.trim().split(/\s+/)
  return [hhmm(parts[0]), hhmm(parts[1])]
}

/** "2026-09-23T00:00:00" -> "2026-09-23"; ค่าว่างของ .NET ("0001-01-01") = null */
function ymd(value: string | null | undefined): string | null {
  const d = value?.slice(0, 10) ?? ''
  return /^\d{4}-\d{2}-\d{2}$/.test(d) && !d.startsWith('0001') ? d : null
}

/**
 * วันที่ของแถว: tmT_DATE ว่าง ("0001-01-01") เมื่อ bPlus ยังไม่มีแถว TMTRAN ของวันนั้น (tmT_FOUND = N,
 * เวลามาจาก log เครื่องสแกนตรง ๆ) วันจริงอยู่ใน checkdate ซึ่งมีทุกแถว
 */
function rowDate(row: ApiRow): string | null {
  return ymd(row.tmT_DATE) ?? ymd(row.checkdate)
}

function toRecord(row: ApiRow, date: string): TimeRecord {
  const [shiftStart, shiftEnd] = parseShift(row.sF_INOUT)
  const scans = [row.scaN_1, row.scaN_2, row.scaN_3, row.scaN_4]
    .map((s) => hhmm(s))
    .filter((s): s is string => s !== null)
  const stampIn = hhmm(row.stampin)
  return {
    date,
    stampIn,
    stampOut: hhmm(row.stampout),
    shiftStart,
    shiftEnd,
    shiftCode: row.sF_CODE,
    shiftHours: row.tmT_WORK_HOUR ?? null,
    // loG_FOUND = N ได้แม้มีเวลาลงใน bPlus (usE_SOURCE = TMTRAN_ONLY) มีเวลาเข้าจึงถือว่ามีการสแกน
    hasLog: row.loG_FOUND === 'Y' || stampIn !== null || scans.length > 0,
    scans,
    // API ให้ leave = 0 แม้วันลา (พบ 2026-09-15 ของ 67-1-010) แต่รหัสกะเป็นชื่อการลา เช่น "ลากิจจ่าย"
    // นับเป็นลาเฉพาะเมื่อไม่มีเวลาเข้า เพราะลาครึ่งวันยังมาสแกน ต้องแสดงเวลาจริง
    leave: Number(row.leave) > 0 || (isLeaveShiftCode(row.sF_CODE) && stampIn === null),
    absent: Number(row.absent) > 0,
    remark: row.remark
  }
}

/** รหัสกะที่เป็นการลา ("ลากิจจ่าย", "ลาป่วย" …) bPlus ใส่ชื่อการลาแทนรหัสกะในวันที่ลา */
export function isLeaveShiftCode(code: string | null | undefined): boolean {
  return /^ลา/.test(code?.trim() ?? '')
}

/** แถวที่ข้อมูลครบกว่าได้เป็นหลัก: มีเวลาเข้า/ออก > มีเวลากะ > จำนวนสแกน */
function completeness(r: TimeRecord): number {
  return (r.stampIn ? 100 : 0) + (r.stampOut ? 100 : 0) + (r.shiftStart ? 10 : 0) + r.scans.length
}

/**
 * รวมแถวของวันเดียวกันเป็นแถวเดียว: พนักงานที่มีทะเบียนทั้งฐาน Site และ Workshop ของ bPlus (ราว 1,700 รหัส)
 * API คืน 1 แถวต่อฐานต่อวัน การ์ดจึงเคยแสดงวันซ้ำ (พบ 2026-09-24 กับ 67-1-010 ทุกวันซ้ำ 2 แถว)
 * ใช้แถวที่ครบกว่าเป็นหลัก แล้วเติมช่องที่ว่างจากอีกแถว (เช่นฐานหนึ่งมีเวลากะ อีกฐานมีเวลาสแกน)
 */
function mergeDay(a: TimeRecord, b: TimeRecord): TimeRecord {
  const [main, other] = completeness(b) > completeness(a) ? [b, a] : [a, b]
  const hasLog = main.hasLog || other.hasLog
  const stampIn = main.stampIn ?? other.stampIn
  return {
    ...main,
    stampIn,
    stampOut: main.stampOut ?? other.stampOut,
    shiftStart: main.shiftStart ?? other.shiftStart,
    shiftEnd: main.shiftEnd ?? other.shiftEnd,
    shiftCode: main.shiftCode ?? other.shiftCode,
    shiftHours: main.shiftHours ?? other.shiftHours,
    hasLog,
    scans: main.scans.length > 0 ? main.scans : other.scans,
    // อีกฐานบอกว่าลาแต่ฐานหลักมีเวลาเข้า = มาทำงาน (เช่นลาครึ่งวัน) ไม่ซ่อนเวลาสแกน
    leave: main.leave || (other.leave && stampIn === null),
    absent: (main.absent || other.absent) && !hasLog,
    remark: main.remark ?? other.remark
  }
}

/** แปลงแถวของ API เป็น 1 record ต่อวัน เฉพาะวันในช่วงที่ถาม เรียงจากเก่าไปใหม่ */
function toDailyRecords(rows: ApiRow[], start: string, end: string): TimeRecord[] {
  const byDate = new Map<string, TimeRecord>()
  for (const row of rows) {
    const date = rowDate(row)
    if (!date || date < start || date > end) continue
    const record = toRecord(row, date)
    const prev = byDate.get(date)
    byDate.set(date, prev ? mergeDay(prev, record) : record)
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
}

/** ตรวจรูปแบบรหัสพนักงาน เช่น S69-1-003, 20-1-026 */
export function isValidPrsNo(value: string): boolean {
  return /^[A-Za-z]{0,3}\d{1,3}-\d{1,2}-\d{3,4}$/.test(value.trim())
}

export function normalizePrsNo(value: string): string {
  return value.trim().toUpperCase()
}

export async function fetchManpower(prsNo: string, start: string, end: string): Promise<ManpowerResult> {
  const code = normalizePrsNo(prsNo)
  if (!isValidPrsNo(code)) throw new EmployeeNotFoundError(code)

  const url = new URL(config.manpowerApiUrl)
  url.searchParams.set('TMT_DATE_START', start)
  url.searchParams.set('TMT_DATE_END', end)
  url.searchParams.set('prs_no', code)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.manpowerApiTimeoutMs)
  let res: Response
  try {
    res = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } })
  } finally {
    clearTimeout(timer)
  }

  const body = (await res.json().catch(() => null)) as ApiEnvelope | null
  if (!body) throw new Error(`HR API ตอบกลับไม่ใช่ JSON (HTTP ${res.status})`)

  if (!body.isSuccess || !body.result) {
    const msg = body.errorMessages?.join(', ') ?? ''
    if (/no employee/i.test(msg) || body.statusCode === 404) throw new EmployeeNotFoundError(code)
    throw new Error(`HR API error: ${msg || `HTTP ${res.status}`}`)
  }

  const rows = body.result.filter((r) => r.prS_NO?.toUpperCase() === code)
  if (rows.length === 0) throw new EmployeeNotFoundError(code)

  const first = rows[0]
  const fullName = first.fulllname?.trim() || `${first.name ?? ''} ${first.surname ?? ''}`.trim() || code

  return {
    employee: {
      prsNo: first.prS_NO,
      fullName,
      position: first.position,
      dept: first.dept,
      empType: first.emP_TYPE
    },
    records: toDailyRecords(rows, start, end)
  }
}
