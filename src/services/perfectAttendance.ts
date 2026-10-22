import { getMssqlPool, mssqlEnabled, sql } from '../dbMssql'
import { ABSENCE_LOCATIONS, ACTIVE_STAFF_CTE, BASE_CODE, clean, loadWorkdays, ymd, type AbsenceLocation } from './absence'
import { addDays, todayLocal } from './attendanceQuery'
import { DEFAULT_START_TIMES } from './lateness'

// ---------------------------------------------------------------------------
// พนักงานเข้างานดีเด่นประจำเดือน: ไม่ขาด ไม่สาย ไม่ลา ตลอดทั้งเดือน แยก Workshop / Site
//
// เงื่อนไข "ดีเด่น" (ต้องผ่านทุกข้อ ตรวจจากสแกนนิ้ว AttendanceDaily + ข้อมูลลาที่ sync จาก bPlus)
//   1. สถานะยังทำงานอยู่ใน MANPOWER_HR (ACTIVE_STAFF_CTE เดียวกับการ์ดขาดงาน/มาสาย) ผู้รับเหมาที่ไม่อยู่ในทะเบียน HR ไม่ถูกนับ
//   2. ไม่ขาด: สแกนนิ้วครบทุกวันทำงานของสถานที่ประจำในเดือนนั้น (วันทำงาน = detectWorkdays ใน absence.ts: จ.-ส. ที่ไม่ใช่
//      วันหยุดบริษัท) สถานที่ประจำ = สถานที่ที่สแกนมากวันที่สุดในเดือน สแกนที่อีกสถานที่ก็นับว่ามาทำงาน
//   3. ไม่สาย: สแกนแรกของทุกวันทำงานไม่เกินเวลาเข้างานของสถานที่ที่สแกนวันนั้น (Workshop 08:00 / Site 07:40 ตั้งใน .env
//      ตัวเดียวกับการ์ดมาสาย) ต่างจากการ์ดมาสายตรงที่สแกนแรกหลัง LATE_MAX_TIME ก็ไม่ผ่าน เพราะยืนยันไม่ได้ว่ามาทันเวลา
//   4. ไม่ลา: ไม่มีแถว AttendanceTmTran ในเดือนนั้นที่ TMT_STT เป็นประเภทการลาของ bPlus (TMSTAMPTYPE: ลากิจ ลาพักร้อน
//      ป่วยมี/ไม่มีใบแพทย์ ลาคลอด ลาบวช พักงาน ...) bPlus บันทึกการลาเป็น "ประเภทบัตรตอก" ของวันนั้น ไม่ใช่รหัสเงินได้ใน TMRESULT
//      (ตรวจ 22 ต.ค. 2569: ลากิจ(ไม่จ่าย) 7,260 แถวในปี 2569 ส่วน TMR_DF 213-218 ไม่มีสักแถว) คนที่ลาแล้วเลิกลาภายหลัง
//      อาจยังมีแถวเก่าค้าง ถือว่าไม่ผ่านไปก่อน (เข้มไว้ดีกว่าให้รางวัลผิดคน)
//
// อันดับ (ทุกคนในรายชื่อผ่านเกณฑ์เท่ากัน จึงเรียงด้วยความ "ขยัน"): มาก่อนเวลาเข้างานเฉลี่ยมากที่สุดก่อน แล้วจำนวนวันที่
// มาทำงานทั้งหมด (รวมวันหยุด/อาทิตย์ที่มาสแกน) แล้วรหัสพนักงาน อันดับเป็นเลขเรียง 1..N ไม่มีอันดับร่วม
//
// ช่วงเวลา: เดือนที่ผ่านมาเต็มเดือน (ค่าเริ่มต้น ส่งต้นเดือนถัดไป) หรือเดือนปัจจุบันถึงเมื่อวาน (--month=เดือนนี้ ไว้ลองดู)
// ---------------------------------------------------------------------------

/** ต้องสแกนอย่างน้อยกี่วันทำงานในเดือน จึงนับเป็นพนักงานของสถานที่นั้น (คนเข้าใหม่กลางเดือนก็ยังนับ ถ้าวันทำงานถึง) */
const MIN_WORKDAYS = 10

export interface PerfectPerson {
  rank: number
  empCode: string
  name: string
  nickname: string | null
  department: string | null
  position: string | null
  /** วันทำงานที่มาครบ */
  workdays: number
  /** วันที่สแกนทั้งหมดในเดือน (รวมวันหยุดที่มาทำงาน) */
  scanDays: number
  /** มาก่อนเวลาเข้างานเฉลี่ย (นาที) เฉพาะวันทำงาน */
  avgEarlyMinutes: number
  /** เวลาสแกนแรกเฉลี่ย HH:mm */
  avgTimeIn: string
  /** สแกนแรกที่เช้าที่สุดของเดือน HH:mm */
  earliestTimeIn: string
}

export interface PerfectLocationReport {
  location: AbsenceLocation
  startTime: string
  /** จำนวนวันทำงานของสถานที่ในช่วง */
  workdays: number
  /** พนักงาน (สถานะยังทำงาน) ที่สแกนที่นี่เป็นหลักและสแกน >= MIN_WORKDAYS วันทำงาน */
  staff: number
  /** คนที่ผ่านทุกเกณฑ์ (เรียงอันดับแล้ว ทุกคน ไม่ใช่แค่ top) */
  people: PerfectPerson[]
  /** จำนวนคนที่ไม่ผ่านแต่ละเกณฑ์ (คนหนึ่งอาจไม่ผ่านหลายข้อ) เอาไว้บอกใน CLI / log */
  missed: { absent: number; late: number; leave: number }
}

export interface PerfectAttendanceReport {
  /** YYYY-MM */
  month: string
  start: string
  end: string
  /** true = เดือนปัจจุบันถึงเมื่อวาน (ยังไม่จบเดือน) */
  partial: boolean
  locations: PerfectLocationReport[]
}

export interface PerfectAttendanceOptions {
  /** YYYY-MM (ค่าเริ่มต้น = เดือนที่แล้ว) เดือนปัจจุบัน = ถึงเมื่อวาน */
  month?: string
  startTimes?: Partial<Record<AbsenceLocation, string>>
}

/** สแกนแรกของแต่ละคน-วัน (เฉพาะพนักงานสถานะยังทำงาน) ทั้งเดือน */
const SCAN_SQL = `
WITH ${ACTIVE_STAFF_CTE},
firstScan AS (
  SELECT c.Code, a.CheckDate, a.LocationIn, CONVERT(char(5), a.CheckTimeIn, 108) AS TimeIn,
         ROW_NUMBER() OVER (PARTITION BY c.Code, a.CheckDate ORDER BY a.CheckTimeIn) AS rn
    FROM dbo.AttendanceDaily a
    JOIN card c ON c.Card = a.EnrollNumber
   WHERE a.CheckDate >= @start AND a.CheckDate <= @end AND a.CheckTimeIn IS NOT NULL
)
SELECT f.Code, f.CheckDate, f.LocationIn, f.TimeIn, h.EmpCode, h.Name, h.Surname, h.Nickname, h.Dept, h.Position
  FROM firstScan f
  JOIN hr h ON CAST(h.Code AS nvarchar(50)) = f.Code
 WHERE f.rn = 1`

/**
 * วันลาต่อคนในเดือน: AttendanceTmTran.TMT_STT -> TMSTAMPTYPE (ประเภทบัตรตอก) ที่เป็นการลา/ป่วย/พักงาน
 * คนกับทะเบียน: TMT_EMP = AttendancePersonalInfo.PRS_EMP ของ Location เดียวกัน -> PRS_NO แบบไม่มี S
 * ดึงแถวของเดือนลง temp table ก่อน join (เหตุผลเดียวกับ attendanceCrossCheck.ts: สถิติของวันล่าสุดยังไม่อัปเดต
 * SQL Server เลือก nested loop แล้วช้าเกิน timeout)
 */
const LEAVE_SQL = `
SET NOCOUNT ON;
SELECT t.Location, t.TMT_EMP, t.TMT_DATE, t.TMT_STT
  INTO #leave
  FROM dbo.AttendanceTmTran t
 WHERE t.TMT_DATE >= @start AND t.TMT_DATE <= @end AND t.TMT_STT <> 0;
SELECT e.Code, COUNT(DISTINCT l.TMT_DATE) AS LeaveDays, MIN(s.STT_DESC) AS LeaveType
  FROM #leave l
  JOIN dbo.TMSTAMPTYPE s ON s.STT_KEY = l.TMT_STT
  JOIN (
    SELECT DISTINCT Location, PRS_EMP, ${BASE_CODE('PRS_NO')} AS Code
      FROM dbo.AttendancePersonalInfo
     WHERE PRS_NO IS NOT NULL
  ) e ON e.Location = l.Location AND e.PRS_EMP = l.TMT_EMP
 WHERE s.STT_DESC LIKE N'ลา%' OR s.STT_DESC LIKE N'ป่วย%' OR s.STT_DESC LIKE N'พักงาน%' OR s.STT_DESC LIKE N'ใบแพทย์%'
    OR s.STT_DF IN (213, 214, 215, 216, 217, 218, 257, 265, 266)
 GROUP BY e.Code`

interface ScanRow {
  Code: string
  CheckDate: Date
  LocationIn: string
  TimeIn: string
  EmpCode: string
  Name: string | null
  Surname: string | null
  Nickname: string | null
  Dept: string | null
  Position: string | null
}

interface LeaveRow {
  Code: string
  LeaveDays: number
  LeaveType: string | null
}

function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

function hhmm(totalMinutes: number): string {
  const m = Math.round(totalMinutes)
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

export function perfectAttendanceAvailable(): boolean {
  return mssqlEnabled()
}

/** ช่วงของเดือน: เดือนที่ผ่านมาเต็มเดือน หรือเดือนปัจจุบันถึงเมื่อวาน */
export function resolveMonth(month: string | undefined, today = todayLocal()): { month: string; start: string; end: string; partial: boolean } {
  const current = today.slice(0, 7)
  let key = month ?? addDays(`${current}-01`, -1).slice(0, 7)
  if (!/^\d{4}-\d{2}$/.test(key) || key > current) key = addDays(`${current}-01`, -1).slice(0, 7)
  const start = `${key}-01`
  const lastDay = addDays(`${addDays(`${key}-28`, 4).slice(0, 7)}-01`, -1)
  if (key === current) {
    const yesterday = addDays(today, -1)
    return { month: key, start, end: yesterday < start ? start : yesterday, partial: true }
  }
  return { month: key, start, end: lastDay, partial: false }
}

export async function getPerfectAttendance(options: PerfectAttendanceOptions = {}): Promise<PerfectAttendanceReport> {
  const { month, start, end, partial } = resolveMonth(options.month)
  const startTimes = { ...DEFAULT_START_TIMES, ...options.startTimes }

  const pool = await getMssqlPool()
  const newRequest = () => pool.request().input('start', sql.Date, start).input('end', sql.Date, end).input('asOf', sql.Date, end)
  const [scans, leaves, workdaysByLoc] = await Promise.all([
    newRequest().query<ScanRow>(SCAN_SQL),
    newRequest().query<LeaveRow>(LEAVE_SQL),
    loadWorkdays(start, end)
  ])
  const leaveByCode = new Map(leaves.recordset.map((r) => [r.Code, r]))

  // รวมเป็นรายคน: วันที่ -> สแกนแรก (เวลา, สถานที่)
  const byPerson = new Map<string, { info: ScanRow; days: Map<string, { time: string; location: string }> }>()
  for (const r of scans.recordset) {
    let p = byPerson.get(r.Code)
    if (!p) {
      p = { info: r, days: new Map() }
      byPerson.set(r.Code, p)
    }
    p.days.set(ymd(r.CheckDate), { time: r.TimeIn, location: r.LocationIn })
  }

  const buckets = new Map<AbsenceLocation, { staff: number; people: PerfectPerson[]; missed: { absent: number; late: number; leave: number } }>()
  for (const location of ABSENCE_LOCATIONS) buckets.set(location, { staff: 0, people: [], missed: { absent: 0, late: 0, leave: 0 } })

  for (const [code, p] of byPerson) {
    // สถานที่ประจำ = ที่สแกนมากวันที่สุด (เท่ากัน -> ตามลำดับ ABSENCE_LOCATIONS)
    const count = new Map<string, number>()
    for (const d of p.days.values()) count.set(d.location, (count.get(d.location) ?? 0) + 1)
    const home = ABSENCE_LOCATIONS.reduce<AbsenceLocation | null>(
      (best, loc) => (best === null || (count.get(loc) ?? 0) > (count.get(best) ?? 0) ? loc : best),
      null
    )
    if (!home || (count.get(home) ?? 0) === 0) continue
    const workdays = workdaysByLoc.get(home) ?? []
    const attended = workdays.filter((d) => p.days.has(d))
    if (attended.length < MIN_WORKDAYS) continue
    const bucket = buckets.get(home)!
    bucket.staff++

    let ok = true
    if (attended.length < workdays.length) {
      bucket.missed.absent++
      ok = false
    }
    const early: number[] = []
    let late = false
    for (const d of attended) {
      const scan = p.days.get(d)!
      const startTime = startTimes[scan.location as AbsenceLocation] ?? startTimes[home]
      const diff = minutes(startTime) - minutes(scan.time)
      if (diff < 0) late = true
      early.push(diff)
    }
    if (late) {
      bucket.missed.late++
      ok = false
    }
    const leave = leaveByCode.get(code)
    if (leave && Number(leave.LeaveDays) > 0) {
      bucket.missed.leave++
      ok = false
    }
    if (!ok) continue

    const r = p.info
    const avgEarly = early.reduce((s, x) => s + x, 0) / early.length
    const times = attended.map((d) => minutes(p.days.get(d)!.time))
    bucket.people.push({
      rank: 0,
      empCode: r.EmpCode,
      name: clean(`${r.Name ?? ''} ${r.Surname ?? ''}`) ?? `รหัส ${r.EmpCode}`,
      nickname: clean(r.Nickname),
      department: clean(r.Dept),
      position: clean(r.Position),
      workdays: attended.length,
      scanDays: p.days.size,
      avgEarlyMinutes: Math.round(avgEarly),
      avgTimeIn: hhmm(times.reduce((s, x) => s + x, 0) / times.length),
      earliestTimeIn: hhmm(Math.min(...times))
    })
  }

  const locations = ABSENCE_LOCATIONS.map((location): PerfectLocationReport => {
    const b = buckets.get(location)!
    b.people.sort((a, c) => c.avgEarlyMinutes - a.avgEarlyMinutes || c.scanDays - a.scanDays || a.empCode.localeCompare(c.empCode))
    b.people.forEach((p, i) => (p.rank = i + 1))
    return {
      location,
      startTime: startTimes[location],
      workdays: (workdaysByLoc.get(location) ?? []).length,
      staff: b.staff,
      people: b.people,
      missed: b.missed
    }
  })

  return { month, start, end, partial, locations }
}
