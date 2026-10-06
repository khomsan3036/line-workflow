import { getMssqlPool, mssqlEnabled, sql } from '../dbMssql'
import { addDays, dayOfWeek, todayLocal } from './attendanceQuery'

// ---------------------------------------------------------------------------
// พนักงานที่ขาดงานติดต่อกัน (ไม่มีการสแกนนิ้ว) ตั้งแต่ ABSENCE_MIN_DAYS วันทำงานขึ้นไป แยก Workshop / Site
//
// ใครถูกนับ (ต้องผ่านทุกข้อ)
//   1. สถานะยังทำงานอยู่ในทะเบียน HR: MANPOWER_HR.STATUS_WORK = 'TRUE' และไม่มี RESIGN_DATE ที่ผ่านมาแล้ว
//      (ทะเบียน HR มีคนลาออก/inactive ราว 14,000 แถว ส่วน bPlus ยังมีคนที่ลาออกแล้วค้างอยู่ จึงใช้ HR เป็นหลัก)
//   2. ยังเคลื่อนไหวอยู่: สแกนนิ้วล่าสุดไม่เกิน activeDays วัน (ค่าเริ่มต้น 14) ก่อนวันที่ตรวจ และสแกนอย่างน้อย
//      MIN_SCAN_DAYS วันในช่วง WINDOW_DAYS วันที่อ่าน คนที่หายไปนานกว่านั้นถือว่าออกไปแล้วแต่ HR ยังไม่ปรับสถานะ
//      ไม่ใช่ "ขาดงาน" (ตรวจ 6 ต.ค. 2569: ถ้าใช้ 30 วัน ได้ 175 คน ส่วนใหญ่หายไป 3-4 สัปดาห์) การ์ดแสดงเป็นจำนวน (stale)
//   3. นับวันทำงานที่ไม่มีสแกนต่อจากวันสแกนล่าสุดจนถึงวันที่ตรวจ ได้ตั้งแต่ minDays ขึ้นไป
//
// วันทำงาน = จันทร์-เสาร์ ที่สถานที่นั้นมีคนสแกนอย่างน้อย WORKDAY_RATIO ของค่ามัธยฐาน (วันหยุดบริษัท
// เช่น 27 ก.ย. 2569 มีคนสแกนแค่หลักสิบ จึงไม่นับ) วันอาทิตย์ไม่ใช่วันทำงานตามตารางกะของ bPlus (ไม่มี "ขาดงาน"
// วันอาทิตย์) แต่ถ้ามาสแกนวันอาทิตย์ก็นับว่ามาทำงาน
//
// คนกับบัตร: AttendanceDaily.EnrollNumber = AttendancePersonalInfo.PRS_E_CARD -> PRS_NO แล้วรวมเป็นคนเดียวด้วยรหัส
// แบบไม่มี S นำหน้า (บัตรหลายใบ / ทะเบียน 2 ฐานของคนเดียวกันรวมกัน) สถานที่ = สถานที่ที่สแกนล่าสุด
// ข้อจำกัด: bPlus ยังไม่มีข้อมูลการลาที่ sync มา คนที่ลาจึงถูกนับด้วย การ์ดบอกให้ตรวจสอบก่อน
// ---------------------------------------------------------------------------

export const ABSENCE_LOCATIONS = ['Workshop', 'Site'] as const
export type AbsenceLocation = (typeof ABSENCE_LOCATIONS)[number]

/** จำนวนวันย้อนหลังที่อ่านสแกน */
const WINDOW_DAYS = 45
/** สแกนอย่างน้อยกี่วันในช่วงที่อ่าน จึงนับว่าเป็นคนที่มาทำงานจริง (ไม่ใช่สแกนครั้งเดียวแล้วหาย) */
const MIN_SCAN_DAYS = 3
/** วันที่มีคนสแกนต่ำกว่าสัดส่วนนี้ของวันปกติ = วันหยุดของสถานที่นั้น */
const WORKDAY_RATIO = 0.5

export interface AbsentPerson {
  empCode: string
  name: string
  nickname: string | null
  department: string | null
  position: string | null
  /** หัวหน้างาน (MANPOWER_HR.UNDER_FM) */
  foreman: string | null
  /** วันทำงานที่ขาดติดต่อกัน */
  streak: number
  /** วันสแกนล่าสุด (YYYY-MM-DD) */
  lastScan: string
  /** วันทำงานวันแรกที่ขาด */
  since: string
}

export interface AbsenceLocationReport {
  location: AbsenceLocation
  /** เรียงจากขาดนานสุด */
  people: AbsentPerson[]
  /** คนที่ยังทำงานอยู่และสแกนที่สถานที่นี้ในช่วงที่อ่าน (ฐานของสัดส่วน) */
  activePeople: number
  /** สถานะ HR ยังทำงานอยู่ แต่ไม่สแกนเกิน activeDays วัน (น่าจะออกไปแล้ว HR ยังไม่ปรับสถานะ) แสดงเป็นตัวเลขเท่านั้น */
  stale: number
  /** วันทำงานล่าสุดก่อน/เท่ากับวันที่ตรวจ */
  workdays: string[]
}

export interface AbsenceReport {
  /** ข้อมูลถึงวันที่ (YYYY-MM-DD) */
  asOf: string
  minDays: number
  activeDays: number
  locations: AbsenceLocationReport[]
}

export interface AbsenceOptions {
  /** ตรวจถึงวันที่ (ค่าเริ่มต้น = เมื่อวาน เพราะวันนี้ยังสแกนไม่ครบ) */
  asOf?: string
  /** ขาดติดต่อกันกี่วันขึ้นไป (ค่าเริ่มต้น 2) */
  minDays?: number
  /** สแกนล่าสุดไม่เกินกี่วัน จึงนับว่ายังเคลื่อนไหว (ค่าเริ่มต้น 14) */
  activeDays?: number
}

export const BASE_CODE = (col: string) => `CASE WHEN ${col} LIKE 'S[0-9]%' THEN SUBSTRING(${col}, 2, 50) ELSE ${col} END`

/**
 * CTE ร่วม (ใช้ใน lateness.ts ด้วย): card = เลขบัตร -> รหัสพนักงานแบบไม่มี S
 * hr = พนักงานสถานะยังทำงานอยู่ (@asOf = วันที่ตรวจ) พร้อมชื่อ แผนก ตำแหน่ง หัวหน้างาน
 */
export const ACTIVE_STAFF_CTE = `
card AS (
  SELECT DISTINCT LTRIM(RTRIM(PRS_E_CARD)) AS Card, ${BASE_CODE('PRS_NO')} AS Code
    FROM dbo.AttendancePersonalInfo
   WHERE NULLIF(LTRIM(RTRIM(PRS_E_CARD)), '') IS NOT NULL AND PRS_NO IS NOT NULL
),
hr AS (
  SELECT ${BASE_CODE('EMP_CODE')} AS Code,
         MAX(EMP_CODE) AS EmpCode, MAX(NAME) AS Name, MAX(SURNAME) AS Surname, MAX(NICKNAME) AS Nickname,
         MAX(DEPT) AS Dept, MAX(POSITION) AS Position, MAX(UNDER_FM) AS Foreman
    FROM dbo.MANPOWER_HR
   WHERE STATUS_WORK = 'TRUE' AND (RESIGN_DATE IS NULL OR RESIGN_DATE > @asOf)
   GROUP BY ${BASE_CODE('EMP_CODE')}
)`

/** คนที่ยังทำงานอยู่ + วันสแกนล่าสุด / สถานที่ล่าสุด / จำนวนวันที่สแกน */
const PEOPLE_SQL = `
WITH ${ACTIVE_STAFF_CTE},
scan AS (
  SELECT c.Code, a.CheckDate, a.LocationIn,
         ROW_NUMBER() OVER (PARTITION BY c.Code ORDER BY a.CheckDate DESC, a.CheckTimeIn DESC) AS rn
    FROM dbo.AttendanceDaily a
    JOIN card c ON c.Card = a.EnrollNumber
   WHERE a.CheckDate >= @from AND a.CheckDate <= @asOf
),
agg AS (
  SELECT Code, MAX(CASE WHEN rn = 1 THEN CheckDate END) AS LastScan,
         MAX(CASE WHEN rn = 1 THEN LocationIn END) AS LastLoc, COUNT(DISTINCT CheckDate) AS ScanDays
    FROM scan
   GROUP BY Code
)
SELECT h.EmpCode, h.Name, h.Surname, h.Nickname, h.Dept, h.Position, h.Foreman, a.LastScan, a.LastLoc, a.ScanDays
  FROM hr h
  JOIN agg a ON a.Code = CAST(h.Code AS nvarchar(50))`

/** จำนวนคนสแกนต่อวันต่อสถานที่ ใช้หาวันทำงาน */
const DAYS_SQL = `
SELECT CheckDate, LocationIn, COUNT(DISTINCT EnrollNumber) AS People
  FROM dbo.AttendanceDaily
 WHERE CheckDate >= @from AND CheckDate <= @asOf
 GROUP BY CheckDate, LocationIn`

interface PersonRow {
  EmpCode: string
  Name: string | null
  Surname: string | null
  Nickname: string | null
  Dept: string | null
  Position: string | null
  Foreman: string | null
  LastScan: Date
  LastLoc: string | null
  ScanDays: number
}

export function clean(value: string | null | undefined): string | null {
  const t = (value ?? '').replace(/"/g, ' ').replace(/\s+/g, ' ').trim()
  return t === '' ? null : t
}

export function ymd(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** วันทำงานของสถานที่ (เรียงเก่า -> ใหม่): จ.-ส. ที่มีคนสแกนอย่างน้อย WORKDAY_RATIO ของค่ามัธยฐาน */
export function detectWorkdays(counts: Map<string, number>, from: string, asOf: string): string[] {
  const weekdays: string[] = []
  for (let d = from; d <= asOf; d = addDays(d, 1)) if (dayOfWeek(d) !== 0) weekdays.push(d)
  const typical = median(weekdays.map((d) => counts.get(d) ?? 0).filter((n) => n > 0))
  return weekdays.filter((d) => (counts.get(d) ?? 0) >= typical * WORKDAY_RATIO && typical > 0)
}

/** วันทำงานของแต่ละสถานที่ในช่วง from..asOf (อ่านจำนวนคนสแกนต่อวัน) */
export async function loadWorkdays(from: string, asOf: string): Promise<Map<string, string[]>> {
  const pool = await getMssqlPool()
  const days = await pool
    .request()
    .input('from', sql.Date, from)
    .input('asOf', sql.Date, asOf)
    .query<{ CheckDate: Date; LocationIn: string; People: number }>(DAYS_SQL)
  const out = new Map<string, string[]>()
  for (const location of ABSENCE_LOCATIONS) {
    const counts = new Map<string, number>()
    for (const r of days.recordset) if (r.LocationIn === location) counts.set(ymd(r.CheckDate), Number(r.People))
    out.set(location, detectWorkdays(counts, from, asOf))
  }
  return out
}

export function absenceAvailable(): boolean {
  return mssqlEnabled()
}

export async function getConsecutiveAbsence(options: AbsenceOptions = {}): Promise<AbsenceReport> {
  const asOf = options.asOf ?? addDays(todayLocal(), -1)
  const minDays = Math.max(1, options.minDays ?? 2)
  const activeDays = Math.max(minDays, options.activeDays ?? 14)
  const from = addDays(asOf, -WINDOW_DAYS)
  const activeFrom = addDays(asOf, -activeDays)

  const pool = await getMssqlPool()
  const newRequest = () => pool.request().input('from', sql.Date, from).input('asOf', sql.Date, asOf)
  const [people, workdaysByLoc] = await Promise.all([newRequest().query<PersonRow>(PEOPLE_SQL), loadWorkdays(from, asOf)])

  const locations = ABSENCE_LOCATIONS.map((location): AbsenceLocationReport => {
    const workdays = workdaysByLoc.get(location) ?? []

    const active = people.recordset.filter((r) => r.LastLoc === location && Number(r.ScanDays) >= MIN_SCAN_DAYS)
    const absent: AbsentPerson[] = []
    let stale = 0
    for (const r of active) {
      const lastScan = ymd(r.LastScan)
      if (lastScan < activeFrom) {
        stale++
        continue
      }
      const missed = workdays.filter((d) => d > lastScan)
      if (missed.length < minDays) continue
      const name = clean(`${r.Name ?? ''} ${r.Surname ?? ''}`)
      absent.push({
        empCode: r.EmpCode,
        name: name ?? `รหัส ${r.EmpCode}`,
        nickname: clean(r.Nickname),
        department: clean(r.Dept),
        position: clean(r.Position),
        foreman: clean(r.Foreman),
        streak: missed.length,
        lastScan,
        since: missed[0]
      })
    }
    absent.sort((a, b) => b.streak - a.streak || a.lastScan.localeCompare(b.lastScan) || a.empCode.localeCompare(b.empCode))
    return { location, people: absent, activePeople: active.length - stale, stale, workdays }
  })

  return { asOf, minDays, activeDays, locations }
}
