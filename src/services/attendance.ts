import { getMssqlPool, mssqlEnabled, sql } from '../dbMssql'
import type { AttendanceQuery, GroupBy, LocationFilter } from './attendanceQuery'
import { addDays } from './attendanceQuery'
import { getBplusCrossCheck, type CrossCheckStat } from './attendanceCrossCheck'

// ---------------------------------------------------------------------------
// อ่านสรุปการเข้างานจากตาราง AttendanceDaily (SQL Server ของระบบ HR)
//
// ตารางนี้มี 1 แถวต่อพนักงาน 1 คนต่อวัน (CheckTimeIn = สแกนแรกของวัน)
// "จำนวนพนักงานที่เข้างาน" = COUNT(DISTINCT EnrollNumber) ของวันนั้น
//
// แยกตามแผนก/ตำแหน่ง และกรองเฉพาะแผนก: AttendanceDaily ไม่มีข้อมูลแผนก จึง join ผ่านทะเบียนพนักงานของเครื่องสแกน
//   AttendanceDaily.EnrollNumber = AttendancePersonalInfo.PRS_E_CARD (เลขบัตร 6 หลัก) -> ได้รหัสพนักงาน PRS_NO
//   แผนก   : MANPOWER_HR.DEPT โดย EMP_CODE = PRS_NO (บางคนรหัสในทะเบียน HR มี S นำหน้า จึง join ซ้ำด้วย 'S'+PRS_NO)
//            ค่าเป็นแผนกจริง เช่น Production, Painting, QA/QC, HSE, IT, HR
//            (DEPTTAB ของเครื่องสแกนไม่ใช่แผนก แต่เป็นโครงการ/ประเภทค่าจ้าง เช่น "J-400 Di. รายวัน" จึงใช้แค่ดูว่าเป็นผู้รับเหมา)
//            คนที่ไม่อยู่ในทะเบียน HR: ถ้า DEPTTAB ขึ้นต้น "ผรม." = ผู้รับเหมา -> กลุ่ม "ผู้รับเหมา" ที่เหลือ "ไม่ระบุ"
//   ตำแหน่ง : AttendancePersonalInfo.PRS_JBT -> JOBTITLE.JBT_KEY (JBT_THAIDESC เช่น Fitter A, Foreman) ครอบคลุมเกือบทุกคน
// ข้อควรระวัง: MANPOWER_HR.EMP_CODE เป็น varchar ส่วน PRS_NO เป็น nvarchar ต้อง CAST ให้ชนิดตรงกันและห้ามใช้ OR ใน ON
// ไม่งั้น join ช้าเกิน 15 วินาที (timeout) - แบบปัจจุบันใช้เวลาราว 0.3 วินาที
// (ตรวจ 9 ก.ย. 2569: แผนกจับคู่ได้ ~1,750 จาก 2,109 คน ที่เหลือส่วนใหญ่เป็นผู้รับเหมา; ตำแหน่ง 2,103 คน)
// ---------------------------------------------------------------------------

export interface LocationStat {
  location: string
  people: number
  checkedOut: number
  earliestIn: string | null // HH:mm
  latestIn: string | null
}

/** ยอดของ 1 แผนก/ตำแหน่ง ตลอดช่วงที่ถาม */
export interface GroupStat {
  name: string
  /** รวมคน-วัน (วันเดียว = จำนวนคน) */
  people: number
  checkedOut: number
  /** แยกย่อยตามสถานที่ (ชื่อสถานที่ -> คน-วัน) */
  byLocation: Record<string, number>
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
  /** แยกตามแผนก/ตำแหน่ง (เฉพาะเมื่อ query.groupBy ไม่ใช่ location) เรียงจากมากไปน้อย */
  byGroup: GroupStat[]
  /** รายวันเรียงจากเก่าไปใหม่ (มีทุกวันในช่วง แม้ไม่มีคนสแกน) */
  days: DayStat[]
  earliestIn: string | null
  latestIn: string | null
  /** เวลาที่ข้อมูลอัปเดตล่าสุดในตาราง (ISO) */
  updatedAt: Date | null
  /** ผลตรวจเทียบกับ bPlus (AttendanceTmTran); null = ไม่ได้เทียบ (มีตัวกรองแผนก/ตำแหน่ง หรืออ่านไม่สำเร็จ) */
  crossCheck: CrossCheckStat | null
}

/**
 * ผลตรวจเทียบ bPlus ครั้งล่าสุดที่ล้ม (ดูได้จาก /health)
 * การ์ดจะไม่มีส่วน "ตรวจเทียบกับระบบ bPlus" เลยเมื่อ query ล้ม ซึ่งเงียบเกินไป
 * เครื่อง production เข้าไปดู log ยาก จึงเก็บเหตุผลไว้ให้เรียกดูจากภายนอกได้
 */
let lastCrossCheckError: { at: string; query: string; message: string } | null = null

/** สถานะการตรวจเทียบ bPlus สำหรับ /health (ok = ครั้งล่าสุดผ่าน) */
export function crossCheckHealth(): { ok: boolean; lastError: typeof lastCrossCheckError } {
  return { ok: lastCrossCheckError === null, lastError: lastCrossCheckError }
}

/** ข้อความผิดพลาดของ mssql มีเลข error/state ที่บอกสาเหตุได้ตรงกว่า message เปล่า ๆ */
function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  const e = err as Error & { code?: string; number?: number; state?: number }
  const tags = [e.name, e.code, e.number !== undefined ? `SQL ${e.number}` : '', e.state !== undefined ? `state ${e.state}` : '']
    .filter(Boolean)
    .join(' ')
  return tags ? `${e.message} (${tags})` : e.message
}

/** อ่านผลตรวจเทียบ bPlus แบบไม่ทำให้การ์ดหลักล้ม: ตาราง bPlus อาจยังไม่ sync หรือไม่มีในบางเครื่อง */
async function safeCrossCheck(query: AttendanceQuery): Promise<CrossCheckStat | null> {
  if (query.department || query.position) return null
  try {
    const stat = await getBplusCrossCheck(query)
    lastCrossCheckError = null
    return stat
  } catch (err) {
    const message = describeError(err)
    lastCrossCheckError = {
      at: new Date().toISOString(),
      query: `${query.period.start}..${query.period.end} / ${query.location}`,
      message
    }
    console.error(`[เข้างาน] ตรวจเทียบ bPlus ไม่สำเร็จ (${lastCrossCheckError.query}):`, message)
    return null
  }
}

interface DayLocationRow {
  CheckDate: Date
  LocationIn: string
  People: number
  CheckedOut: number
  EarliestIn: Date | null
  LatestIn: Date | null
}

interface GroupRow {
  GroupName: string | null
  CheckDate: Date
  LocationIn: string
  People: number
  CheckedOut: number
}

export const UNKNOWN_GROUP = 'ไม่ระบุ'
export const CONTRACTOR_GROUP = 'ผู้รับเหมา'

/** ชื่อกลุ่มจากฐาน HR มีช่องว่างซ้ำ/ท้ายคำ เช่น "F-401/1    In.รายเดือน" */
function cleanGroupName(name: string | null): string {
  const t = (name ?? '').replace(/\s+/g, ' ').trim()
  return t === '' ? UNKNOWN_GROUP : t
}

/**
 * ตารางเข้างานที่เติมชื่อแผนก (DeptName) และตำแหน่ง (JobName) ให้แต่ละแถว
 * ใช้เฉพาะเมื่อต้องแยกกลุ่มหรือกรองแผนก เพราะ join ทะเบียนพนักงานช้ากว่าอ่านตารางตรง ๆ
 */
const ENRICHED_SQL = `(
  SELECT a.EnrollNumber, a.CheckDate, a.CheckTimeIn, a.CheckTimeOut, a.LocationIn, a.UpdatedAt,
         COALESCE(NULLIF(LTRIM(RTRIM(m1.DEPT)), ''), NULLIF(LTRIM(RTRIM(m2.DEPT)), ''),
                  CASE WHEN LTRIM(d.DEPT_THAIDESC) LIKE N'ผรม%' THEN N'${CONTRACTOR_GROUP}' END) AS DeptName,
         ISNULL(NULLIF(LTRIM(RTRIM(j.JBT_THAIDESC)), ''), j.JBT_ENGDESC)                          AS JobName
    FROM dbo.AttendanceDaily a
    LEFT JOIN (
          SELECT PRS_E_CARD, MAX(PRS_NO) AS PRS_NO, MAX(PRS_DEPT) AS PRS_DEPT, MAX(PRS_JBT) AS PRS_JBT
            FROM dbo.AttendancePersonalInfo
           GROUP BY PRS_E_CARD
         ) p ON p.PRS_E_CARD = a.EnrollNumber
    LEFT JOIN (SELECT EMP_CODE, MAX(DEPT) AS DEPT FROM dbo.MANPOWER_HR GROUP BY EMP_CODE) m1
           ON m1.EMP_CODE = CAST(p.PRS_NO AS varchar(50))
    LEFT JOIN (SELECT EMP_CODE, MAX(DEPT) AS DEPT FROM dbo.MANPOWER_HR GROUP BY EMP_CODE) m2
           ON m2.EMP_CODE = 'S' + CAST(p.PRS_NO AS varchar(50))
    LEFT JOIN dbo.DEPTTAB d ON d.DEPT_KEY = p.PRS_DEPT
    LEFT JOIN dbo.JOBTITLE j ON j.JBT_KEY = p.PRS_JBT
)`

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

// ---------------------------------------------------------------------------
// รายชื่อแผนกจากทะเบียน HR (เฉพาะพนักงานที่ยังทำงานอยู่) cache 10 นาที ให้ parser จับชื่อแผนกในข้อความได้
// ---------------------------------------------------------------------------

let departmentsCache: { names: string[]; at: number } | null = null
const DEPARTMENTS_TTL_MS = 10 * 60 * 1000

export async function listDepartments(): Promise<string[]> {
  if (departmentsCache && Date.now() - departmentsCache.at < DEPARTMENTS_TTL_MS) return departmentsCache.names
  if (!mssqlEnabled()) return []
  try {
    const pool = await getMssqlPool()
    const rows = await pool.request().query<{ DEPT: string | null }>(`
      SELECT DEPT FROM dbo.MANPOWER_HR
       WHERE STATUS_WORK = 'TRUE' AND DEPT IS NOT NULL AND LTRIM(RTRIM(DEPT)) <> ''
       GROUP BY DEPT ORDER BY COUNT(*) DESC`)
    const names = rows.recordset.map((r) => cleanGroupName(r.DEPT)).filter((n) => n !== UNKNOWN_GROUP)
    names.push(CONTRACTOR_GROUP)
    departmentsCache = { names, at: Date.now() }
    return names
  } catch (err) {
    console.error('[เข้างาน] อ่านรายชื่อแผนกไม่ได้:', err instanceof Error ? err.message : err)
    return departmentsCache?.names ?? []
  }
}

// รายชื่อตำแหน่งจากตารางหลักของเครื่องสแกน (JOBTITLE) cache 10 นาที ให้ parser จับ "ตำแหน่ง Fitter A" ได้
let positionsCache: { names: string[]; at: number } | null = null

export async function listPositions(): Promise<string[]> {
  if (positionsCache && Date.now() - positionsCache.at < DEPARTMENTS_TTL_MS) return positionsCache.names
  if (!mssqlEnabled()) return []
  try {
    const pool = await getMssqlPool()
    const rows = await pool.request().query<{ Name: string | null }>(`
      SELECT ISNULL(NULLIF(LTRIM(RTRIM(JBT_THAIDESC)), ''), JBT_ENGDESC) AS Name
        FROM dbo.JOBTITLE
       WHERE JBT_ENABLED IS NULL OR JBT_ENABLED <> 'N'`)
    const names = [...new Set(rows.recordset.map((r) => cleanGroupName(r.Name)))].filter((n) => n !== UNKNOWN_GROUP)
    positionsCache = { names, at: Date.now() }
    return names
  } catch (err) {
    console.error('[เข้างาน] อ่านรายชื่อตำแหน่งไม่ได้:', err instanceof Error ? err.message : err)
    return positionsCache?.names ?? []
  }
}

export async function getAttendanceSummary(query: AttendanceQuery): Promise<AttendanceSummary> {
  const pool = await getMssqlPool()
  const { start, end } = query.period
  const department = query.department ?? null
  const position = query.position ?? null
  // ต้องใช้ตารางที่เติมแผนก/ตำแหน่งเมื่อกรองแผนก/ตำแหน่งหรือแยกกลุ่ม (ไม่งั้นอ่านตารางตรงเร็วกว่า)
  const enriched = department !== null || position !== null || query.groupBy !== 'location'
  const from = enriched ? `${ENRICHED_SQL} a` : 'dbo.AttendanceDaily a'
  const where = [
    'a.CheckDate >= @start AND a.CheckDate <= @end',
    query.location !== 'all' ? 'AND a.LocationIn = @location' : '',
    department !== null ? `AND ${department === UNKNOWN_GROUP ? 'a.DeptName IS NULL' : 'a.DeptName = @department'}` : '',
    position !== null ? `AND ${position === UNKNOWN_GROUP ? 'a.JobName IS NULL' : 'a.JobName = @position'}` : ''
  ].join(' ')

  const newRequest = () => {
    const r = pool.request().input('start', sql.Date, start).input('end', sql.Date, end)
    if (query.location !== 'all') r.input('location', sql.NVarChar(100), query.location)
    if (department !== null) r.input('department', sql.NVarChar(100), department)
    if (position !== null) r.input('position', sql.NVarChar(200), position)
    return r
  }

  const perDayLocation = await newRequest().query<DayLocationRow>(`
    SELECT a.CheckDate,
           a.LocationIn,
           COUNT(DISTINCT a.EnrollNumber)                            AS People,
           SUM(CASE WHEN a.CheckTimeOut IS NOT NULL THEN 1 ELSE 0 END) AS CheckedOut,
           MIN(a.CheckTimeIn)                                        AS EarliestIn,
           MAX(a.CheckTimeIn)                                        AS LatestIn
      FROM ${from}
     WHERE ${where}
     GROUP BY a.CheckDate, a.LocationIn
     ORDER BY a.CheckDate, a.LocationIn`)

  const totals = await newRequest().query<{ UniquePeople: number; UpdatedAt: Date | null }>(`
    SELECT COUNT(DISTINCT a.EnrollNumber) AS UniquePeople,
           MAX(a.UpdatedAt)               AS UpdatedAt
      FROM ${from}
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

  // แยกตามแผนก/ตำแหน่ง: นับต่อวันแล้วรวมใน JS ให้เป็น "คน-วัน" แบบเดียวกับยอดรวม/รายสถานที่
  let byGroup: GroupStat[] = []
  if (query.groupBy !== 'location' && totalPeople > 0) {
    const nameCol = query.groupBy === 'department' ? 'a.DeptName' : 'a.JobName'
    const rows = await newRequest().query<GroupRow>(`
      SELECT ${nameCol}                                                AS GroupName,
             a.CheckDate,
             a.LocationIn,
             COUNT(DISTINCT a.EnrollNumber)                            AS People,
             SUM(CASE WHEN a.CheckTimeOut IS NOT NULL THEN 1 ELSE 0 END) AS CheckedOut
        FROM ${from}
       WHERE ${where}
       GROUP BY ${nameCol}, a.CheckDate, a.LocationIn`)
    const groupMap = new Map<string, GroupStat>()
    for (const row of rows.recordset) {
      const name = cleanGroupName(row.GroupName)
      const g = groupMap.get(name) ?? { name, people: 0, checkedOut: 0, byLocation: {} }
      const loc = row.LocationIn || 'ไม่ระบุ'
      g.people += Number(row.People)
      g.checkedOut += Number(row.CheckedOut)
      g.byLocation[loc] = (g.byLocation[loc] ?? 0) + Number(row.People)
      groupMap.set(name, g)
    }
    // แผนก/ตำแหน่งจริงเรียงจากมากไปน้อย แล้วต่อด้วย "ผู้รับเหมา" และ "ไม่ระบุ" ท้ายสุดเสมอ
    const rank = (name: string) => (name === UNKNOWN_GROUP ? 2 : name === CONTRACTOR_GROUP ? 1 : 0)
    byGroup = [...groupMap.values()].sort(
      (a, b) => rank(a.name) - rank(b.name) || b.people - a.people || a.name.localeCompare(b.name, 'th')
    )
  }

  return {
    query,
    totalPeople,
    uniquePeople: Number(totals.recordset[0]?.UniquePeople ?? 0),
    totalCheckedOut,
    activeDays: days.filter((d) => d.people > 0).length,
    byLocation,
    byGroup,
    days,
    earliestIn: byLocation.reduce<string | null>((m, l) => minTime(m, l.earliestIn), null),
    latestIn: byLocation.reduce<string | null>((m, l) => maxTime(m, l.latestIn), null),
    updatedAt: totals.recordset[0]?.UpdatedAt ?? null,
    crossCheck: totalPeople > 0 ? await safeCrossCheck(query) : null
  }
}

export type { GroupBy, LocationFilter }
