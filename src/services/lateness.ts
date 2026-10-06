import { getMssqlPool, mssqlEnabled, sql } from '../dbMssql'
import { ABSENCE_LOCATIONS, ACTIVE_STAFF_CTE, clean, loadWorkdays, ymd, type AbsenceLocation } from './absence'
import { addDays, todayLocal } from './attendanceQuery'

// ---------------------------------------------------------------------------
// พนักงานที่มาสายติดต่อกันตั้งแต่ minDays วันทำงานขึ้นไป แยก Workshop / Site
//
// มาสาย = สแกนแรกของวัน (AttendanceDaily.CheckTimeIn) หลังเวลาเข้างานของสถานที่ที่สแกนวันนั้น
//   Workshop หลัง 08:00 / Site หลัง 07:40 (เทียบระดับนาที: 08:00:45 ยังไม่สาย 08:01 สาย) ตั้งได้ใน .env
//   สแกนแรกตั้งแต่ maxTime (10:00) ขึ้นไปไม่นับว่าสาย: ส่วนใหญ่เป็นคนที่ลืมสแกนเช้าแล้วมาสแกนตอนกลับจากพักเที่ยง
//   (ตรวจ 6 ต.ค. 2569: Site มีสแกนแรก 11:40-11:44 ซ้ำทุกวันหลายคน) หรือลาครึ่งวัน วันนั้นจึงตัดความต่อเนื่อง
//
// ติดต่อกัน = นับย้อนจากวันทำงานล่าสุด (ถึงวันที่ตรวจ ค่าเริ่มต้นเมื่อวาน) ไปทีละวันทำงานของสถานที่ล่าสุดของคนนั้น
//   ต้องสายในวันทำงานล่าสุด วันที่มาตรงเวลาตัดความต่อเนื่อง
//   วันที่ไม่มาสแกน (หยุด/ลา) ข้ามไปโดยไม่ตัด = "สายทุกวันที่มาทำงาน" เช่น สาย ศ. ไม่มา ส. สาย จ. นับ 2 วัน
//   (ตรวจ 6 ต.ค. 2569: นับแบบไม่ข้ามทำให้คนที่สาย 4 วันจาก 5 วันที่มาหลุดเพราะไม่มาวันเสาร์)
//   วันอาทิตย์ / วันหยุดบริษัท ไม่ใช่วันทำงาน (detectWorkdays ใน absence.ts)
//
// เฉพาะพนักงานสถานะยังทำงานอยู่ใน MANPOWER_HR (ACTIVE_STAFF_CTE เดียวกับการ์ดขาดงาน) และต้องสแกนวันทำงานล่าสุด
// จึงเป็นคนที่ยังเคลื่อนไหวอยู่แน่นอน ผู้รับเหมาที่ไม่อยู่ในทะเบียน HR ไม่ถูกนับ
// ---------------------------------------------------------------------------

/** ย้อนดูกี่วัน (พอสำหรับสาย ~3 สัปดาห์ติดกัน) */
const WINDOW_DAYS = 28

export interface LateDay {
  date: string
  /** เวลาสแกนแรก HH:mm */
  time: string
  lateMinutes: number
}

export interface LatePerson {
  empCode: string
  name: string
  nickname: string | null
  department: string | null
  position: string | null
  foreman: string | null
  /** วันทำงานที่มาสายติดต่อกัน */
  streak: number
  /** วันที่สายในช่วงที่ติดกัน เรียงใหม่ -> เก่า */
  days: LateDay[]
  avgLateMinutes: number
}

export interface LatenessLocationReport {
  location: AbsenceLocation
  /** เวลาเข้างาน HH:mm */
  startTime: string
  /** วันทำงานล่าสุดที่ใช้ตัดสิน (null = ไม่มีวันทำงานในช่วง) */
  lastWorkday: string | null
  /** คนที่มาทำงานวันทำงานล่าสุด (สถานะยังทำงาน) */
  attended: number
  /** ในนั้นมาสายกี่คน */
  lateOnLastDay: number
  /** เรียงสายติดกันนานสุดก่อน แล้วสายเฉลี่ยมากก่อน */
  people: LatePerson[]
}

export interface LatenessReport {
  asOf: string
  minDays: number
  maxTime: string
  locations: LatenessLocationReport[]
}

export interface LatenessOptions {
  asOf?: string
  minDays?: number
  /** เวลาเข้างาน HH:mm ต่อสถานที่ */
  startTimes?: Partial<Record<AbsenceLocation, string>>
  /** สแกนแรกตั้งแต่เวลานี้ไม่นับว่าสาย */
  maxTime?: string
}

export const DEFAULT_START_TIMES: Record<AbsenceLocation, string> = { Workshop: '08:00', Site: '07:40' }

/** สแกนแรกของแต่ละคน-วัน (สถานะยังทำงาน) + ยอดมา/สายรายวันต่อสถานที่ */
const LATE_SQL = `
WITH ${ACTIVE_STAFF_CTE},
firstScan AS (
  SELECT c.Code, a.CheckDate, a.LocationIn, CONVERT(char(5), a.CheckTimeIn, 108) AS TimeIn,
         ROW_NUMBER() OVER (PARTITION BY c.Code, a.CheckDate ORDER BY a.CheckTimeIn) AS rn
    FROM dbo.AttendanceDaily a
    JOIN card c ON c.Card = a.EnrollNumber
   WHERE a.CheckDate >= @from AND a.CheckDate <= @asOf AND a.CheckTimeIn IS NOT NULL
),
day AS (
  SELECT f.Code, f.CheckDate, f.LocationIn, f.TimeIn,
         CASE WHEN f.TimeIn < @maxTime
                   AND ((f.LocationIn = 'Workshop' AND f.TimeIn > @workshopTime) OR (f.LocationIn = 'Site' AND f.TimeIn > @siteTime))
              THEN 1 ELSE 0 END AS Late
    FROM firstScan f
    JOIN hr h ON CAST(h.Code AS nvarchar(50)) = f.Code
   WHERE f.rn = 1
)
SELECT d.CheckDate, d.LocationIn, d.TimeIn, d.Code, h.EmpCode, h.Name, h.Surname, h.Nickname, h.Dept, h.Position, h.Foreman
  FROM day d
  JOIN hr h ON CAST(h.Code AS nvarchar(50)) = d.Code
 WHERE d.Code IN (SELECT Code FROM day WHERE Late = 1 AND CheckDate >= @recent);

WITH ${ACTIVE_STAFF_CTE},
firstScan AS (
  SELECT c.Code, a.CheckDate, a.LocationIn, CONVERT(char(5), a.CheckTimeIn, 108) AS TimeIn,
         ROW_NUMBER() OVER (PARTITION BY c.Code, a.CheckDate ORDER BY a.CheckTimeIn) AS rn
    FROM dbo.AttendanceDaily a
    JOIN card c ON c.Card = a.EnrollNumber
   WHERE a.CheckDate >= @recent AND a.CheckDate <= @asOf AND a.CheckTimeIn IS NOT NULL
)
SELECT f.CheckDate, f.LocationIn, COUNT(*) AS Attended,
       SUM(CASE WHEN f.TimeIn < @maxTime
                     AND ((f.LocationIn = 'Workshop' AND f.TimeIn > @workshopTime) OR (f.LocationIn = 'Site' AND f.TimeIn > @siteTime))
                THEN 1 ELSE 0 END) AS Late
  FROM firstScan f
  JOIN hr h ON CAST(h.Code AS nvarchar(50)) = f.Code
 WHERE f.rn = 1
 GROUP BY f.CheckDate, f.LocationIn`

interface DayRow {
  CheckDate: Date
  LocationIn: string
  TimeIn: string
  Code: string
  EmpCode: string
  Name: string | null
  Surname: string | null
  Nickname: string | null
  Dept: string | null
  Position: string | null
  Foreman: string | null
}

function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

export function latenessAvailable(): boolean {
  return mssqlEnabled()
}

export async function getConsecutiveLateness(options: LatenessOptions = {}): Promise<LatenessReport> {
  const asOf = options.asOf ?? addDays(todayLocal(), -1)
  const minDays = Math.max(1, options.minDays ?? 2)
  const startTimes = { ...DEFAULT_START_TIMES, ...options.startTimes }
  const maxTime = options.maxTime ?? '10:00'
  const from = addDays(asOf, -WINDOW_DAYS)
  // ต้องสายในวันทำงานล่าสุด ซึ่งอยู่ภายใน 7 วัน (ไม่มีวันหยุดยาวเกินสัปดาห์)
  const recent = addDays(asOf, -7)

  const pool = await getMssqlPool()
  const [result, workdaysByLoc] = await Promise.all([
    pool
      .request()
      .input('from', sql.Date, from)
      .input('recent', sql.Date, recent)
      .input('asOf', sql.Date, asOf)
      .input('workshopTime', sql.Char(5), startTimes.Workshop)
      .input('siteTime', sql.Char(5), startTimes.Site)
      .input('maxTime', sql.Char(5), maxTime)
      .query(LATE_SQL),
    loadWorkdays(from, asOf)
  ])
  const rows = (result.recordsets as unknown as [DayRow[], { CheckDate: Date; LocationIn: string; Attended: number; Late: number }[]])
  const [dayRows, dailyTotals] = rows

  const isLate = (time: string, location: string) =>
    time < maxTime && location in startTimes && time > startTimes[location as AbsenceLocation]

  // รวมแถวเป็นรายคน: วันที่ -> สแกนแรก
  const byPerson = new Map<string, { info: DayRow; days: Map<string, { time: string; location: string }>; lastDate: string; lastLoc: string }>()
  for (const r of dayRows) {
    const date = ymd(r.CheckDate)
    let p = byPerson.get(r.Code)
    if (!p) {
      p = { info: r, days: new Map(), lastDate: date, lastLoc: r.LocationIn }
      byPerson.set(r.Code, p)
    }
    p.days.set(date, { time: r.TimeIn, location: r.LocationIn })
    if (date > p.lastDate) {
      p.lastDate = date
      p.lastLoc = r.LocationIn
    }
  }

  const locations = ABSENCE_LOCATIONS.map((location): LatenessLocationReport => {
    const workdays = workdaysByLoc.get(location) ?? []
    const lastWorkday = workdays.at(-1) ?? null
    const total = dailyTotals.find((t) => t.LocationIn === location && lastWorkday !== null && ymd(t.CheckDate) === lastWorkday)

    const people: LatePerson[] = []
    for (const p of byPerson.values()) {
      if (p.lastLoc !== location || !lastWorkday) continue
      const days: LateDay[] = []
      if (!p.days.has(lastWorkday)) continue
      for (let i = workdays.length - 1; i >= 0; i--) {
        const scan = p.days.get(workdays[i])
        if (!scan) continue
        if (!isLate(scan.time, scan.location)) break
        days.push({
          date: workdays[i],
          time: scan.time,
          lateMinutes: minutes(scan.time) - minutes(startTimes[scan.location as AbsenceLocation])
        })
      }
      if (days.length < minDays) continue
      const r = p.info
      people.push({
        empCode: r.EmpCode,
        name: clean(`${r.Name ?? ''} ${r.Surname ?? ''}`) ?? `รหัส ${r.EmpCode}`,
        nickname: clean(r.Nickname),
        department: clean(r.Dept),
        position: clean(r.Position),
        foreman: clean(r.Foreman),
        streak: days.length,
        days,
        avgLateMinutes: Math.round(days.reduce((s, d) => s + d.lateMinutes, 0) / days.length)
      })
    }
    people.sort((a, b) => b.streak - a.streak || b.avgLateMinutes - a.avgLateMinutes || a.empCode.localeCompare(b.empCode))
    return {
      location,
      startTime: startTimes[location],
      lastWorkday,
      attended: Number(total?.Attended ?? 0),
      lateOnLastDay: Number(total?.Late ?? 0),
      people
    }
  })

  return { asOf, minDays, maxTime, locations }
}
