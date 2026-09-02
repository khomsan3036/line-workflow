import { getMssqlPool, mssqlEnabled, sql } from '../dbMssql'
import type { AttendanceQuery, LocationFilter } from './attendanceQuery'
import { addDays } from './attendanceQuery'

// ---------------------------------------------------------------------------
// อ่านสรุปการเข้างานจากตาราง AttendanceDaily (SQL Server ของระบบ HR)
//
// ตารางนี้มี 1 แถวต่อพนักงาน 1 คนต่อวัน (CheckTimeIn = สแกนแรกของวัน)
// "จำนวนพนักงานที่เข้างาน" = COUNT(DISTINCT EnrollNumber) ของวันนั้น
// ---------------------------------------------------------------------------

export interface LocationStat {
  location: string
  people: number
  checkedOut: number
  earliestIn: string | null // HH:mm
  latestIn: string | null
}

export interface DayStat {
  date: string // YYYY-MM-DD
  people: number
  checkedOut: number
  byLocation: LocationStat[]
}

export interface AttendanceSummary {
  query: AttendanceQuery
  /** รวมคน-วัน ตลอดช่วง (วันเดียว = จำนวนคนของวันนั้น) */
  totalPeople: number
  /** จำนวนพนักงานไม่ซ้ำคนตลอดช่วง */
  uniquePeople: number
  /** สแกนออกแล้ว (มี CheckTimeOut) */
  totalCheckedOut: number
  /** จำนวนวันที่มีการสแกนอย่างน้อย 1 คน */
  activeDays: number
  byLocation: LocationStat[]
  /** รายวันเรียงจากเก่าไปใหม่ (มีทุกวันในช่วง แม้ไม่มีคนสแกน) */
  days: DayStat[]
  earliestIn: string | null
  latestIn: string | null
  /** เวลาที่ข้อมูลอัปเดตล่าสุดในตาราง (ISO) */
  updatedAt: Date | null
}

interface DayLocationRow {
  CheckDate: Date
  LocationIn: string
  People: number
  CheckedOut: number
  EarliestIn: Date | null
  LatestIn: Date | null
}

function locationClause(location: LocationFilter): string {
  return location === 'all' ? '' : 'AND LocationIn = @location'
}

/** TIME จาก mssql มาเป็น Date ที่ 1970-01-01 (UTC) จึงอ่านชั่วโมง/นาทีแบบ UTC */
function timeToHHmm(value: Date | null): string | null {
  if (!value) return null
  const h = String(value.getUTCHours()).padStart(2, '0')
  const m = String(value.getUTCMinutes()).padStart(2, '0')
  return `${h}:${m}`
}

function dateToYmd(value: Date): string {
  // DATE จาก mssql มาเป็น Date เที่ยงคืน UTC
  return value.toISOString().slice(0, 10)
}

function minTime(a: string | null, b: string | null): string | null {
  if (!a) return b
  if (!b) return a
  return a < b ? a : b
}

function maxTime(a: string | null, b: string | null): string | null {
  if (!a) return b
  if (!b) return a
  return a > b ? a : b
}

export function attendanceAvailable(): boolean {
  return mssqlEnabled()
}

export async function getAttendanceSummary(query: AttendanceQuery): Promise<AttendanceSummary> {
  const pool = await getMssqlPool()
  const { start, end } = query.period
  const where = `CheckDate >= @start AND CheckDate <= @end ${locationClause(query.location)}`

  const request = pool.request().input('start', sql.Date, start).input('end', sql.Date, end)
  if (query.location !== 'all') request.input('location', sql.NVarChar(100), query.location)

  const perDayLocation = await request.query<DayLocationRow>(`
    SELECT CheckDate,
           LocationIn,
           COUNT(DISTINCT EnrollNumber)                            AS People,
           SUM(CASE WHEN CheckTimeOut IS NOT NULL THEN 1 ELSE 0 END) AS CheckedOut,
           MIN(CheckTimeIn)                                        AS EarliestIn,
           MAX(CheckTimeIn)                                        AS LatestIn
      FROM dbo.AttendanceDaily
     WHERE ${where}
     GROUP BY CheckDate, LocationIn
     ORDER BY CheckDate, LocationIn`)

  const request2 = pool.request().input('start', sql.Date, start).input('end', sql.Date, end)
  if (query.location !== 'all') request2.input('location', sql.NVarChar(100), query.location)
  const totals = await request2.query<{ UniquePeople: number; UpdatedAt: Date | null }>(`
    SELECT COUNT(DISTINCT EnrollNumber) AS UniquePeople,
           MAX(UpdatedAt)               AS UpdatedAt
      FROM dbo.AttendanceDaily
     WHERE ${where}`)

  // จัดกลุ่มรายวัน + รายสถานที่
  const dayMap = new Map<string, DayStat>()
  const locMap = new Map<string, LocationStat>()

  for (const row of perDayLocation.recordset) {
    const ymd = dateToYmd(row.CheckDate)
    const stat: LocationStat = {
      location: row.LocationIn || 'ไม่ระบุ',
      people: Number(row.People),
      checkedOut: Number(row.CheckedOut),
      earliestIn: timeToHHmm(row.EarliestIn),
      latestIn: timeToHHmm(row.LatestIn)
    }

    const day = dayMap.get(ymd) ?? { date: ymd, people: 0, checkedOut: 0, byLocation: [] }
    day.people += stat.people
    day.checkedOut += stat.checkedOut
    day.byLocation.push(stat)
    dayMap.set(ymd, day)

    const loc = locMap.get(stat.location) ?? {
      location: stat.location,
      people: 0,
      checkedOut: 0,
      earliestIn: null,
      latestIn: null
    }
    loc.people += stat.people
    loc.checkedOut += stat.checkedOut
    loc.earliestIn = minTime(loc.earliestIn, stat.earliestIn)
    loc.latestIn = maxTime(loc.latestIn, stat.latestIn)
    locMap.set(stat.location, loc)
  }

  // เติมวันที่ไม่มีข้อมูลให้ครบช่วง (ไม่เกินวันนี้ของช่วง)
  const days: DayStat[] = []
  for (let d = start; d <= end; d = addDays(d, 1)) {
    days.push(dayMap.get(d) ?? { date: d, people: 0, checkedOut: 0, byLocation: [] })
  }

  const byLocation = [...locMap.values()].sort((a, b) => b.people - a.people)
  const totalPeople = byLocation.reduce((s, l) => s + l.people, 0)
  const totalCheckedOut = byLocation.reduce((s, l) => s + l.checkedOut, 0)

  return {
    query,
    totalPeople,
    uniquePeople: Number(totals.recordset[0]?.UniquePeople ?? 0),
    totalCheckedOut,
    activeDays: days.filter((d) => d.people > 0).length,
    byLocation,
    days,
    earliestIn: byLocation.reduce<string | null>((m, l) => minTime(m, l.earliestIn), null),
    latestIn: byLocation.reduce<string | null>((m, l) => maxTime(m, l.latestIn), null),
    updatedAt: totals.recordset[0]?.UpdatedAt ?? null
  }
}
