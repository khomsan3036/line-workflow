import { getMssqlPool, mssqlEnabled, sql } from '../dbMssql'
import type { DatePeriod } from './attendanceQuery'

// ---------------------------------------------------------------------------
// อันดับพนักงานที่ทำ OT สะสมมากที่สุด แยก Workshop / Site
//
// ที่มา: dbo.AttendanceTmResult = สำเนา TMRESULT (ผลคำนวณเวลา) ของ bPlus 2 ฐาน (Location = Site / Workshop)
// ที่ fingerprintsync ดึงมา ชั่วโมง OT คือ TMR_QTY ของรหัสเงินได้ ค่าล่วงเวลา X1 / X1.5 / X2 / X3 (PRDEFTAB 111-114, หน่วยชั่วโมง)
// ไม่นับ 264 "ชั่วโมงการทำงานวันหยุด" และ 253 "เก็บชั่วโมง" เพราะไม่ใช่รหัสค่าล่วงเวลา
//
// ข้อควรระวังของข้อมูล (ตรวจ 29 ก.ย. 2569) ถ้าไม่จัดการ ยอด OT จะเกินจริงหลายเท่า:
//   1. bPlus คำนวณวันเดิมซ้ำทุกครั้งที่ประมวลผล และสร้างแถวใหม่ด้วย TMR_KEY ใหม่ ส่วน sync MERGE ด้วย (Location, TMR_KEY)
//      และไม่ลบแถวเก่า คน-วันเดียวจึงมีหลายชุด (เช่น 9 ชุด) ต้องใช้ชุดล่าสุด = แถวที่ SyncedAt ใกล้ค่าสูงสุดของคน-วันนั้น
//      (ดูทุกรหัส ไม่ใช่เฉพาะ OT ชุดล่าสุดที่ไม่มี OT แปลว่า OT ถูกยกเลิก)
//   2. ในชุดเดียวกันของฐาน Site บางวันมีแถว OT ซ้ำเป๊ะ (รหัสเดียวกัน ขั้นกะ TMR_SS เดียวกัน) จึงเก็บแถวเดียวต่อ (รหัส, TMR_SS)
//   3. พนักงานบางคนมีทะเบียนทั้ง 2 ฐาน และทั้งสองฐานคำนวณ OT วันเดียวกันให้ (เช่น 68-2-375 สแกนที่ Site อย่างเดียว
//      แต่ Workshop ก็มี OT) จึงรวมคนข้ามฐานด้วยรหัสพนักงาน (PRS_NO) แล้วนับ OT แต่ละวันครั้งเดียว:
//      ใช้ฐานที่ตรงกับสถานที่สแกนจริงของวันนั้น (AttendanceDaily.LocationIn) ถ้าไม่ตรง/ไม่มีสแกน ใช้ฐานที่ OT มากกว่า
//      และนับวันนั้นเข้าสถานที่ที่สแกน (ไม่มีสแกน = ตามฐาน bPlus) แบบเดียวกับ attendanceCrossCheck.ts
// ชื่อ/แผนก/ตำแหน่งมาจาก MANPOWER_HR (join ด้วยรหัสพนักงาน และ 'S' + รหัส) ตำแหน่งสำรองจาก JOBTITLE ของ bPlus
// ---------------------------------------------------------------------------

export const OT_LOCATIONS = ['Workshop', 'Site'] as const
export type OtLocation = (typeof OT_LOCATIONS)[number]

/** รหัสเงินได้ค่าล่วงเวลาใน PRDEFTAB -> ตัวคูณ */
const OT_RATES: Record<number, string> = { 111: 'x1', 112: 'x1.5', 113: 'x2', 114: 'x3' }

export interface OtPerson {
  rank: number
  empCode: string
  name: string
  nickname: string | null
  department: string | null
  position: string | null
  hours: number
  /** จำนวนวันที่มี OT */
  days: number
  /** ชั่วโมงแยกตามตัวคูณ เช่น { 'x1.5': 40, 'x3': 3.5 } */
  byRate: Record<string, number>
}

export interface OtLocationRanking {
  location: OtLocation
  /** Top N (รวมคนที่ได้ชั่วโมงเท่ากับอันดับสุดท้ายไม่เกิน limit) */
  top: OtPerson[]
  /** คนที่ชั่วโมงเท่ากับอันดับสุดท้ายแต่ไม่ได้แสดง */
  tiedOut: number
  /** OT รวมทั้งสถานที่ (ชม.) */
  totalHours: number
  /** จำนวนคนที่มี OT */
  people: number
}

export interface OtRanking {
  period: DatePeriod
  /** จำนวนอันดับต่อสถานที่ที่ขอ (ค่าเริ่มต้น 10) */
  limit: number
  locations: OtLocationRanking[]
  /** วันล่าสุดในช่วงที่ bPlus มีผลคำนวณแล้ว (YYYY-MM-DD) null = ยังไม่มีเลย */
  lastDataDate: string | null
  /** เวลา sync ล่าสุดของข้อมูลที่ใช้ */
  syncedAt: Date | null
}

interface PersonRow {
  WorkLoc: string
  PersonKey: string
  EmpCode: string | null
  Hours: number
  Days: number
  H111: number
  H112: number
  H113: number
  H114: number
}

/**
 * รหัสพนักงานแบบไม่มี S นำหน้า: bPlus มีทะเบียนแยกกันของคนเดียวกันเป็น "69-1-003" และ "S69-1-003"
 * (PRS_EMP ต่างกัน) จึงรวมเป็นคนเดียวด้วยรหัสนี้ และเทียบกับรหัสใน line_employee_links ได้ทั้งสองแบบ
 */
const BASE_CODE = (col: string) => `CASE WHEN ${col} LIKE 'S[0-9]%' THEN SUBSTRING(${col}, 2, 50) ELSE ${col} END`

export function baseEmpCode(code: string): string {
  return /^S\d/i.test(code.trim()) ? code.trim().slice(1) : code.trim()
}

/**
 * CTE ที่ตัดข้อมูลซ้ำ 3 ชั้นตามหัวไฟล์ จบที่ picked (rn = 1 คือ OT ของคน-วันนั้นที่นับจริง)
 * forPerson = อ่านเฉพาะคนเดียว (@code = รหัสแบบไม่มี S) กรองตั้งแต่ต้น ไม่ต้องคำนวณทั้งบริษัท
 */
function pickedCte(forPerson: boolean): string {
  const personFilter = forPerson
    ? `AND EXISTS (SELECT 1 FROM dbo.AttendancePersonalInfo i
                    WHERE i.Location = r.Location AND i.PRS_EMP = r.TMR_EMP AND i.PRS_NO IN (@code, 'S' + @code))`
    : ''
  return `
WITH raw AS (
  SELECT r.Location, r.TMR_EMP, r.TMR_DATE, r.TMR_DF, r.TMR_SS, r.TMR_QTY, r.SyncedAt,
         MAX(r.SyncedAt) OVER (PARTITION BY r.Location, r.TMR_EMP, r.TMR_DATE) AS LastSync
    FROM dbo.AttendanceTmResult r
   WHERE r.TMR_DATE >= @start AND r.TMR_DATE <= @end ${personFilter}
),
latest AS (
  SELECT Location, TMR_EMP, TMR_DATE AS D, TMR_DF, TMR_SS, MAX(TMR_QTY) AS Qty, MAX(SyncedAt) AS SyncedAt
    FROM raw
   WHERE SyncedAt >= DATEADD(minute, -30, LastSync) AND TMR_DF IN (111, 112, 113, 114) AND TMR_QTY > 0
   GROUP BY Location, TMR_EMP, TMR_DATE, TMR_DF, TMR_SS
),
emp AS (
  SELECT Location, PRS_EMP, MAX(${BASE_CODE('PRS_NO')}) AS Code, MAX(NULLIF(LTRIM(RTRIM(PRS_E_CARD)), '')) AS Card
    FROM dbo.AttendancePersonalInfo
   GROUP BY Location, PRS_EMP
),
perDay AS (
  SELECT l.Location AS BpLoc, l.D,
         COALESCE(e.Code, CONCAT(l.Location, ':', l.TMR_EMP)) AS PersonKey, e.Code AS EmpCode, e.Card,
         SUM(l.Qty) AS Hours,
         SUM(CASE WHEN l.TMR_DF = 111 THEN l.Qty ELSE 0 END) AS H111,
         SUM(CASE WHEN l.TMR_DF = 112 THEN l.Qty ELSE 0 END) AS H112,
         SUM(CASE WHEN l.TMR_DF = 113 THEN l.Qty ELSE 0 END) AS H113,
         SUM(CASE WHEN l.TMR_DF = 114 THEN l.Qty ELSE 0 END) AS H114
    FROM latest l
    LEFT JOIN emp e ON e.Location = l.Location AND e.PRS_EMP = l.TMR_EMP
   GROUP BY l.Location, l.D, l.TMR_EMP, e.Code, e.Card
),
picked AS (
  SELECT d.*, COALESCE(s.LocationIn, d.BpLoc) AS WorkLoc,
         ROW_NUMBER() OVER (PARTITION BY d.PersonKey, d.D
                            ORDER BY CASE WHEN s.LocationIn = d.BpLoc THEN 0 ELSE 1 END, d.Hours DESC, d.BpLoc) AS rn
    FROM perDay d
    LEFT JOIN dbo.AttendanceDaily s ON s.EnrollNumber = d.Card AND s.CheckDate = d.D
)`
}

const RANKING_SQL = `${pickedCte(false)}
SELECT WorkLoc, PersonKey, MAX(EmpCode) AS EmpCode, SUM(Hours) AS Hours, COUNT(*) AS Days,
       SUM(H111) AS H111, SUM(H112) AS H112, SUM(H113) AS H113, SUM(H114) AS H114
  FROM picked
 WHERE rn = 1
 GROUP BY WorkLoc, PersonKey`

const PERSONAL_SQL = `${pickedCte(true)}
SELECT D, WorkLoc, Hours, H111, H112, H113, H114
  FROM picked
 WHERE rn = 1
 ORDER BY D`

interface InfoRow {
  EmpCode: string
  FullName: string | null
  Nickname: string | null
  Dept: string | null
  Position: string | null
}

function clean(value: string | null | undefined): string | null {
  // ทะเบียน HR บางแถวมีเครื่องหมายคำพูดหลงมาในชื่อ เช่น 'วัชณัฐ " หม้อแก้ว"'
  const t = (value ?? '').replace(/"/g, ' ').replace(/\s+/g, ' ').trim()
  return t === '' ? null : t
}

/** ปัดเป็นทศนิยม 2 ตำแหน่ง (bPlus เก็บนาทีเป็นเศษชั่วโมง เช่น 0.0167) */
function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** ชื่อ แผนก ตำแหน่ง ของรหัสพนักงานที่ติดอันดับ (อ่านทีเดียวทุกคน) */
async function loadPeople(codes: string[]): Promise<Map<string, InfoRow>> {
  const map = new Map<string, InfoRow>()
  if (codes.length === 0) return map
  const pool = await getMssqlPool()
  const req = pool.request()
  // รหัสแบบไม่มี S และแบบมี S (ทะเบียน bPlus ของคนเดียวกันอาจเป็นแบบใดแบบหนึ่ง)
  const params = codes.flatMap((code, i) => {
    req.input(`c${i}`, sql.NVarChar(50), code)
    req.input(`s${i}`, sql.NVarChar(50), `S${code}`)
    return [`@c${i}`, `@s${i}`]
  })
  const rows = await req.query<InfoRow>(`
    SELECT p.PRS_NO AS EmpCode,
           COALESCE(NULLIF(LTRIM(RTRIM(CONCAT(m1.NAME, ' ', m1.SURNAME))), ''),
                    NULLIF(LTRIM(RTRIM(CONCAT(m2.NAME, ' ', m2.SURNAME))), '')) AS FullName,
           COALESCE(NULLIF(LTRIM(RTRIM(m1.NICKNAME)), ''), NULLIF(LTRIM(RTRIM(m2.NICKNAME)), '')) AS Nickname,
           COALESCE(NULLIF(LTRIM(RTRIM(m1.DEPT)), ''), NULLIF(LTRIM(RTRIM(m2.DEPT)), '')) AS Dept,
           COALESCE(NULLIF(LTRIM(RTRIM(m1.POSITION)), ''), NULLIF(LTRIM(RTRIM(m2.POSITION)), ''),
                    NULLIF(LTRIM(RTRIM(j.JBT_THAIDESC)), ''), j.JBT_ENGDESC) AS Position
      FROM (SELECT ${BASE_CODE('PRS_NO')} AS PRS_NO, MAX(PRS_JBT) AS PRS_JBT FROM dbo.AttendancePersonalInfo
             WHERE PRS_NO IN (${params.join(', ')}) GROUP BY ${BASE_CODE('PRS_NO')}) p
      LEFT JOIN (SELECT EMP_CODE, MAX(NAME) AS NAME, MAX(SURNAME) AS SURNAME, MAX(NICKNAME) AS NICKNAME,
                        MAX(DEPT) AS DEPT, MAX(POSITION) AS POSITION FROM dbo.MANPOWER_HR GROUP BY EMP_CODE) m1
             ON m1.EMP_CODE = CAST(p.PRS_NO AS varchar(50))
      LEFT JOIN (SELECT EMP_CODE, MAX(NAME) AS NAME, MAX(SURNAME) AS SURNAME, MAX(NICKNAME) AS NICKNAME,
                        MAX(DEPT) AS DEPT, MAX(POSITION) AS POSITION FROM dbo.MANPOWER_HR GROUP BY EMP_CODE) m2
             ON m2.EMP_CODE = 'S' + CAST(p.PRS_NO AS varchar(50))
      LEFT JOIN dbo.JOBTITLE j ON j.JBT_KEY = p.PRS_JBT`)
  for (const row of rows.recordset) map.set(row.EmpCode, row)
  return map
}

export function overtimeAvailable(): boolean {
  return mssqlEnabled()
}

/** จัดอันดับ OT สะสมในช่วง period แยก Workshop / Site (limit = จำนวนอันดับต่อสถานที่) */
export async function getOvertimeRanking(period: DatePeriod, limit = 10): Promise<OtRanking> {
  const pool = await getMssqlPool()
  const newRequest = () => pool.request().input('start', sql.Date, period.start).input('end', sql.Date, period.end)

  const [people, meta] = await Promise.all([
    newRequest().query<PersonRow>(RANKING_SQL),
    newRequest().query<{ LastDate: Date | null; SyncedAt: Date | null }>(`
      SELECT MAX(TMR_DATE) AS LastDate, MAX(SyncedAt) AS SyncedAt
        FROM dbo.AttendanceTmResult
       WHERE TMR_DATE >= @start AND TMR_DATE <= @end AND TMR_DF IN (111, 112, 113, 114)`)
  ])

  const rankings = OT_LOCATIONS.map((location) => {
    const rows = people.recordset
      .filter((r) => r.WorkLoc === location)
      .map((r) => ({ ...r, Hours: round2(Number(r.Hours)) }))
      .sort((a, b) => b.Hours - a.Hours || Number(b.Days) - Number(a.Days) || a.PersonKey.localeCompare(b.PersonKey))
    const top = rows.slice(0, limit)
    const cutoff = top.at(-1)?.Hours
    return {
      location,
      rows: top,
      tiedOut: cutoff === undefined ? 0 : rows.slice(limit).filter((r) => r.Hours === cutoff).length,
      totalHours: round2(rows.reduce((s, r) => s + r.Hours, 0)),
      people: rows.length
    }
  })

  const codes = rankings.flatMap((r) => r.rows.map((p) => p.EmpCode).filter((c): c is string => !!c))
  const info = await loadPeople([...new Set(codes)])

  const locations: OtLocationRanking[] = rankings.map((r) => ({
    location: r.location,
    tiedOut: r.tiedOut,
    totalHours: r.totalHours,
    people: r.people,
    top: r.rows.map((row, i) => {
      const who = row.EmpCode ? info.get(row.EmpCode) : undefined
      return {
        // เลขอันดับเรียง 1..N ตามลำดับในรายการ (ชั่วโมงเท่ากันตัดสินด้วยวันที่ทำ OT มากกว่า แล้วตามรหัส)
        // ไม่ใช้อันดับร่วม (1, 2, 2, 2, 5 ...) เพราะเลขสุดท้ายบนการ์ดไม่ถึง N คนอ่านแล้วนึกว่าแสดงไม่ครบ
        rank: i + 1,
        empCode: row.EmpCode ?? '-',
        // ไม่อยู่ในทะเบียน HR (ส่วนใหญ่ผู้รับเหมา) แสดงรหัสแทนชื่อ
        name: clean(who?.FullName) ?? (row.EmpCode ? `รหัส ${row.EmpCode}` : 'ไม่พบชื่อ'),
        nickname: clean(who?.Nickname),
        department: clean(who?.Dept),
        position: clean(who?.Position),
        hours: row.Hours,
        days: Number(row.Days),
        byRate: rates(row)
      }
    })
  }))

  const lastDate = meta.recordset[0]?.LastDate ?? null
  return {
    period,
    limit,
    locations,
    lastDataDate: lastDate ? lastDate.toISOString().slice(0, 10) : null,
    syncedAt: meta.recordset[0]?.SyncedAt ?? null
  }
}

// ---------------------------------------------------------------------------
// OT ของพนักงานคนเดียว (แชท 1:1 "OT ของฉัน") ใช้การตัดข้อมูลซ้ำชุดเดียวกับการจัดอันดับ ตัวเลขจึงตรงกันเสมอ
// ---------------------------------------------------------------------------

export interface OtDay {
  date: string // YYYY-MM-DD
  location: string
  hours: number
  byRate: Record<string, number>
}

export interface PersonalOvertime {
  period: DatePeriod
  empCode: string
  hours: number
  byRate: Record<string, number>
  /** เฉพาะวันที่มี OT เรียงจากเก่าไปใหม่ */
  days: OtDay[]
  lastDataDate: string | null
}

interface PersonalRow {
  D: Date
  WorkLoc: string
  Hours: number
  H111: number
  H112: number
  H113: number
  H114: number
}

function rates(row: { H111: number; H112: number; H113: number; H114: number }): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [df, label] of Object.entries(OT_RATES)) {
    const h = round2(Number(row[`H${df}` as 'H111'] ?? 0))
    if (h > 0) out[label] = h
  }
  return out
}

export async function getPersonalOvertime(empCode: string, period: DatePeriod): Promise<PersonalOvertime> {
  const pool = await getMssqlPool()
  const code = baseEmpCode(empCode)
  const newRequest = () => pool.request().input('start', sql.Date, period.start).input('end', sql.Date, period.end)
  const [rows, meta] = await Promise.all([
    newRequest().input('code', sql.NVarChar(50), code).query<PersonalRow>(PERSONAL_SQL),
    newRequest().query<{ LastDate: Date | null }>(`
      SELECT MAX(TMR_DATE) AS LastDate FROM dbo.AttendanceTmResult
       WHERE TMR_DATE >= @start AND TMR_DATE <= @end AND TMR_DF IN (111, 112, 113, 114)`)
  ])

  const days: OtDay[] = rows.recordset.map((r) => ({
    date: r.D.toISOString().slice(0, 10),
    location: r.WorkLoc,
    hours: round2(Number(r.Hours)),
    byRate: rates(r)
  }))
  const byRate: Record<string, number> = {}
  for (const d of days) for (const [k, v] of Object.entries(d.byRate)) byRate[k] = round2((byRate[k] ?? 0) + v)
  const lastDate = meta.recordset[0]?.LastDate ?? null

  return {
    period,
    empCode: code,
    hours: round2(days.reduce((s, d) => s + d.hours, 0)),
    byRate,
    days,
    lastDataDate: lastDate ? lastDate.toISOString().slice(0, 10) : null
  }
}
