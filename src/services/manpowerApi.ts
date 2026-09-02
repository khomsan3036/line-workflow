import { config } from '../config'

// ---------------------------------------------------------------------------
// เรียก API ระบบ HR (qtecintegra) เพื่อดูเวลาเข้า-ออกของพนักงานรายคน
//
//   GET {MANPOWER_API_URL}?TMT_DATE_START=YYYY-MM-DD&TMT_DATE_END=YYYY-MM-DD&prs_no=S69-1-003
//
// API คืน 1 แถวต่อวัน (มีทุกวันในช่วง แม้วันหยุด) โดย loG_FOUND = 'Y' เมื่อมีการสแกน
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

function toRecord(row: ApiRow): TimeRecord {
  const [shiftStart, shiftEnd] = parseShift(row.sF_INOUT)
  const scans = [row.scaN_1, row.scaN_2, row.scaN_3, row.scaN_4]
    .map((s) => hhmm(s))
    .filter((s): s is string => s !== null)
  return {
    date: row.tmT_DATE.slice(0, 10),
    stampIn: hhmm(row.stampin),
    stampOut: hhmm(row.stampout),
    shiftStart,
    shiftEnd,
    shiftCode: row.sF_CODE,
    shiftHours: row.tmT_WORK_HOUR ?? null,
    hasLog: row.loG_FOUND === 'Y',
    scans,
    leave: Number(row.leave) > 0,
    absent: Number(row.absent) > 0,
    remark: row.remark
  }
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
    records: rows.map(toRecord).sort((a, b) => a.date.localeCompare(b.date))
  }
}
