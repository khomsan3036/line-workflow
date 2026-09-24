import { getMssqlPool, sql } from '../dbMssql'
import type { AttendanceQuery } from './attendanceQuery'

// ---------------------------------------------------------------------------
// ตรวจเทียบการเข้างาน: เครื่องสแกนนิ้ว (AttendanceDaily) กับระบบ bPlus (AttendanceTmTran)
//
// ทั้งสองตารางอยู่ใน SQL Server เดียวกัน (โปรเจกต์ fingerprintsync เป็นคน sync)
//   AttendanceDaily  : 1 แถวต่อคนต่อวัน, คนคือ EnrollNumber (เลขบัตร), สถานที่คือ LocationIn
//   AttendanceTmTran : สำเนาตาราง TMTRAN ของ bPlus จาก 2 ฐาน (Location = Site / Workshop)
//                      1 แถวต่อพนักงานต่อวันต่อกะ, TMT_EMP เป็น key ภายในของฐานนั้น
// จับคู่คน: TMT_EMP = AttendancePersonalInfo.PRS_EMP (Location เดียวกัน เพราะ key ชนกันข้ามฐาน)
//          -> PRS_E_CARD = AttendanceDaily.EnrollNumber (เหมือน ENRICHED_SQL ใน attendance.ts)
// เทียบระดับ "คน-วัน" (EnrollNumber + วันที่) ไม่ผูกสถานที่ เพราะคนที่ขึ้นทะเบียน Workshop ไปสแกนที่ Site ได้
// เมื่อกรองสถานที่ นับตามสถานที่สแกนนิ้ว (ไม่มีสแกนจึงใช้สถานที่ใน bPlus) คนหนึ่งจึงอยู่สถานที่เดียว
//
// ข้อควรระวัง
//   - แถว TMTRAN ที่ไม่มีเวลาลงเลย (ตารางกะ/ขาดงาน) ไม่นับว่า "มาทำงานใน bPlus"
//   - bPlus นำเข้าเวลาช้ากว่าเครื่องสแกน จึงเทียบเฉพาะวันที่ bPlus มีข้อมูลแล้ว (ComparedDays)
//     วันที่ยังไม่มีข้อมูลไม่ถูกนับเป็น "ไม่ตรง" แต่การ์ดบอกว่ายังไม่ได้เทียบกี่วัน
//   - พนักงานใน bPlus ที่ไม่มีเลขบัตร (PRS_E_CARD ว่าง) จับคู่ไม่ได้ นับแยกเป็น Unlinked
// ---------------------------------------------------------------------------

/** เวลาเข้าที่ต่างกันเกินกี่นาทีจึงนับว่า "เวลาไม่ตรง" (bPlus อาจเลือกสแกนคนละครั้งกับสแกนแรกของวัน) */
export const CROSS_CHECK_TIME_TOLERANCE_MIN = 10

export interface CrossCheckStat {
  /** จำนวนวันในช่วงที่ bPlus มีข้อมูลการลงเวลาแล้ว (ใช้เทียบ) */
  comparedDays: number
  /** จำนวนวันในช่วงที่เครื่องสแกนมีข้อมูล */
  scanDays: number
  /** คน-วัน ที่มีทั้งสองระบบ */
  matched: number
  /** สแกนนิ้วแล้ว แต่ bPlus ไม่มีเวลาลง */
  scanOnly: number
  /** bPlus มีเวลาลง แต่ไม่พบการสแกนนิ้ว */
  bplusOnly: number
  /** ตรงกันแต่เวลาเข้าต่างกันเกิน CROSS_CHECK_TIME_TOLERANCE_MIN นาที */
  timeDiff: number
  /** แถว bPlus ที่มีเวลาลงแต่ไม่มีเลขบัตร จึงจับคู่ไม่ได้ */
  unlinked: number
  /** เวลาที่ข้อมูล bPlus ของช่วงนี้ sync ล่าสุด "YYYY-MM-DD HH:mm" (เวลาเครื่อง SQL Server) */
  lastSyncAt: string | null
}

interface CrossCheckRow {
  ComparedDays: number
  ScanDays: number
  Matched: number
  ScanOnly: number
  BplusOnly: number
  TimeDiff: number
  Unlinked: number
  LastSyncAt: string | null
}

/** % ที่ตรงกันจากทั้งหมดที่เทียบ (ไม่มีอะไรให้เทียบ = null) */
export function crossCheckRate(c: CrossCheckStat): number | null {
  const compared = c.matched + c.scanOnly + c.bplusOnly
  if (compared <= 0) return null
  return Math.floor((c.matched / compared) * 1000) / 10
}

/** ช่วงวันที่ + สถานที่ที่ใช้ตรวจเทียบ (ส่วนหนึ่งของ AttendanceQuery ใช้ซ้ำกับปุ่ม "ดูรายชื่อ" บนการ์ด) */
export interface CrossCheckScope {
  start: string
  end: string
  location: AttendanceQuery['location']
}

function scopeOf(query: AttendanceQuery): CrossCheckScope {
  return { start: query.period.start, end: query.period.end, location: query.location }
}

async function crossCheckRequest(scope: CrossCheckScope) {
  const pool = await getMssqlPool()
  const request = pool
    .request()
    .input('start', sql.Date, scope.start)
    .input('end', sql.Date, scope.end)
    .input('tolerance', sql.Int, CROSS_CHECK_TIME_TOLERANCE_MIN)
  if (scope.location !== 'all') request.input('location', sql.NVarChar(100), scope.location)
  return request
}

/**
 * CTE ที่จับคู่คน-วันของสองระบบ (pairs) ใช้ร่วมกันทั้งตัวเลขสรุปและรายชื่อ ให้สองอย่างตรงกันเสมอ
 * PERSONALINFO อาจมีหลายแถวต่อ PRS_EMP (หลาย PRS_NO) จึงรวมเหลือแถวเดียวก่อน join ไม่ให้นับซ้ำ
 * เมื่อกรองสถานที่ นับคนตามสถานที่สแกนนิ้วก่อน (ตรงกับยอดบนการ์ด) ไม่มีสแกนจึงใช้สถานที่ใน bPlus
 * คนที่สองระบบบันทึกคนละสถานที่จึงถูกนับที่เดียว (Site + Workshop = ทุกสถานที่ ไม่นับซ้ำ)
 *
 * ดึงแถวของช่วงวันที่ลง temp table (#bpRaw, #scan) ก่อน join เสมอ: วันล่าสุด (วันนี้/เมื่อวาน) อยู่เลย histogram
 * ของสถิติ TMT_DATE/CheckDate ที่ยังไม่อัปเดต SQL Server จึงเดาว่ามีราว 1 แถว แล้วเลือก nested loop กับหลายพันแถว
 * ทำให้ query เกิน requestTimeout 15 วินาที การ์ดจึงไม่มีส่วน bPlus (พบ 2026-09-24: วันที่ 23 ใช้ 15 วิขึ้นไป วันก่อนหน้าไม่ถึง 1 วิ)
 * temp table มีสถิติของจริง plan จึงถูกต้องทุกวัน ใช้ได้เพราะ prelude กับ SELECT อยู่ใน batch เดียวกัน
 */
function pairsCte(byLocation: boolean): string {
  return `
    SET NOCOUNT ON;
    SELECT t.Location, t.TMT_DATE AS D, p.Card,
           COALESCE(t.TMT_STAMP_IN, t.TMT_STAMP_1) AS TimeIn,
           COALESCE(t.UpdatedAt, t.SyncedAt)      AS SyncedAt
      INTO #bpRaw
      FROM dbo.AttendanceTmTran t
      LEFT JOIN (
        SELECT Location, PRS_EMP, MAX(NULLIF(LTRIM(RTRIM(PRS_E_CARD)), '')) AS Card
          FROM dbo.AttendancePersonalInfo
         GROUP BY Location, PRS_EMP
      ) p ON p.Location = t.Location AND p.PRS_EMP = t.TMT_EMP
     WHERE t.TMT_DATE >= @start AND t.TMT_DATE <= @end
       AND COALESCE(t.TMT_STAMP_IN, t.TMT_STAMP_OUT, t.TMT_STAMP_1) IS NOT NULL;
    SELECT EnrollNumber, CheckDate AS D, LocationIn AS Loc,
           CAST(CheckDate AS datetime) + CAST(CheckTimeIn AS datetime) AS TimeIn
      INTO #scan
      FROM dbo.AttendanceDaily
     WHERE CheckDate >= @start AND CheckDate <= @end;
    WITH bpRaw AS (
      SELECT * FROM #bpRaw
    ),
    bpDays AS (
      SELECT DISTINCT D FROM bpRaw ${byLocation ? 'WHERE Location = @location' : ''}
    ),
    bp AS (
      SELECT Card AS EnrollNumber, D, MIN(Location) AS Loc, MIN(TimeIn) AS TimeIn
        FROM bpRaw
       WHERE Card IS NOT NULL
       GROUP BY Card, D
    ),
    scan AS (
      SELECT * FROM #scan
    ),
    pairs AS (
      SELECT s.EnrollNumber AS ScanEmp, b.EnrollNumber AS BpEmp, s.TimeIn AS ScanIn, b.TimeIn AS BpIn,
             COALESCE(s.D, b.D) AS D, COALESCE(s.EnrollNumber, b.EnrollNumber) AS Card,
             s.Loc AS ScanLoc, b.Loc AS BpLoc
        FROM scan s
        FULL OUTER JOIN bp b ON b.EnrollNumber = s.EnrollNumber AND b.D = s.D
       WHERE COALESCE(s.D, b.D) IN (SELECT D FROM bpDays)
         ${byLocation ? 'AND COALESCE(s.Loc, b.Loc) = @location' : ''}
    )`
}

/**
 * อ่านผลตรวจเทียบของช่วงเวลา/สถานที่ที่ถาม
 * ยังไม่รองรับตัวกรองแผนก/ตำแหน่ง (ต้อง join ทะเบียน HR ทั้งสองฝั่ง) ผู้เรียกจึงไม่ควรเรียกเมื่อมีตัวกรอง
 */
export async function getBplusCrossCheck(query: AttendanceQuery): Promise<CrossCheckStat> {
  const scope = scopeOf(query)
  const byLocation = scope.location !== 'all'
  const request = await crossCheckRequest(scope)
  const result = await request.query<CrossCheckRow>(`${pairsCte(byLocation)}
    SELECT
      (SELECT COUNT(*) FROM bpDays)                                                    AS ComparedDays,
      (SELECT COUNT(DISTINCT D) FROM scan ${byLocation ? 'WHERE Loc = @location' : ''}) AS ScanDays,
      ISNULL(SUM(CASE WHEN ScanEmp IS NOT NULL AND BpEmp IS NOT NULL THEN 1 ELSE 0 END), 0) AS Matched,
      ISNULL(SUM(CASE WHEN BpEmp IS NULL THEN 1 ELSE 0 END), 0)                          AS ScanOnly,
      ISNULL(SUM(CASE WHEN ScanEmp IS NULL THEN 1 ELSE 0 END), 0)                        AS BplusOnly,
      ISNULL(SUM(CASE WHEN ScanIn IS NOT NULL AND BpIn IS NOT NULL
                       AND ABS(DATEDIFF(minute, ScanIn, BpIn)) > @tolerance THEN 1 ELSE 0 END), 0) AS TimeDiff,
      (SELECT COUNT(*) FROM bpRaw
        WHERE Card IS NULL AND D IN (SELECT D FROM bpDays) ${byLocation ? 'AND Location = @location' : ''}) AS Unlinked,
      (SELECT CONVERT(varchar(16), MAX(SyncedAt), 120) FROM bpRaw)                      AS LastSyncAt
    FROM pairs`)

  const row = result.recordset[0]
  return {
    comparedDays: Number(row?.ComparedDays ?? 0),
    scanDays: Number(row?.ScanDays ?? 0),
    matched: Number(row?.Matched ?? 0),
    scanOnly: Number(row?.ScanOnly ?? 0),
    bplusOnly: Number(row?.BplusOnly ?? 0),
    timeDiff: Number(row?.TimeDiff ?? 0),
    unlinked: Number(row?.Unlinked ?? 0),
    lastSyncAt: row?.LastSyncAt ?? null
  }
}

// ---------------------------------------------------------------------------
// รายชื่อคนที่ไม่ตรงกัน (ปุ่ม "ดูรายชื่อ" บนการ์ด เฉพาะ HR) ใช้ pairs ชุดเดียวกับตัวเลขสรุป
// ---------------------------------------------------------------------------

/** scanOnly = สแกนแล้วแต่ไม่มีใน bPlus, bplusOnly = มีใน bPlus แต่ไม่พบสแกน, timeDiff = เวลาเข้าต่างกันเกินเกณฑ์ */
export type CrossCheckKind = 'scanOnly' | 'bplusOnly' | 'timeDiff'

export const CROSS_CHECK_KINDS: CrossCheckKind[] = ['scanOnly', 'bplusOnly', 'timeDiff']

export interface CrossCheckPerson {
  /** YYYY-MM-DD */
  date: string
  /** เลขบัตร (EnrollNumber = PRS_E_CARD) */
  card: string
  /** รหัสพนักงาน bPlus (PRS_NO) ไม่พบ = null */
  prsNo: string | null
  /** ชื่อ-สกุลจากทะเบียน HR ไม่พบ = null */
  name: string | null
  dept: string | null
  location: string | null
  /** HH:mm */
  scanIn: string | null
  bplusIn: string | null
}

interface CrossCheckPersonRow {
  D: Date
  Card: string
  PrsNo: string | null
  FullName: string | null
  Dept: string | null
  Loc: string | null
  ScanIn: string | null
  BpIn: string | null
}

const KIND_WHERE: Record<CrossCheckKind, string> = {
  scanOnly: 'x.BpEmp IS NULL',
  bplusOnly: 'x.ScanEmp IS NULL',
  timeDiff: 'x.ScanIn IS NOT NULL AND x.BpIn IS NOT NULL AND ABS(DATEDIFF(minute, x.ScanIn, x.BpIn)) > @tolerance'
}

/** รายชื่อคน-วันที่ไม่ตรงกันตามประเภท เรียงตามวันที่ สถานที่ แล้วรหัสพนักงาน */
export async function listCrossCheckPeople(scope: CrossCheckScope, kind: CrossCheckKind): Promise<CrossCheckPerson[]> {
  const request = await crossCheckRequest(scope)
  // ชื่อ/แผนกจาก MANPOWER_HR (รหัสพนักงานบางคนขึ้นต้นด้วย S) ต่อสองรอบแยกกัน ไม่ใช้ OR ใน ON (ช้ามาก)
  const result = await request.query<CrossCheckPersonRow>(`${pairsCte(scope.location !== 'all')}
    SELECT x.D, x.Card, p.PRS_NO AS PrsNo,
           LTRIM(RTRIM(CONCAT(COALESCE(m1.TITLE, m2.TITLE), COALESCE(m1.NAME, m2.NAME), ' ', COALESCE(m1.SURNAME, m2.SURNAME)))) AS FullName,
           NULLIF(LTRIM(RTRIM(COALESCE(m1.DEPT, m2.DEPT))), '') AS Dept,
           COALESCE(x.ScanLoc, x.BpLoc) AS Loc,
           CONVERT(varchar(5), x.ScanIn, 108) AS ScanIn,
           CONVERT(varchar(5), x.BpIn, 108)   AS BpIn
      FROM pairs x
      LEFT JOIN (SELECT PRS_E_CARD, MAX(PRS_NO) AS PRS_NO FROM dbo.AttendancePersonalInfo GROUP BY PRS_E_CARD) p
             ON p.PRS_E_CARD = x.Card
      LEFT JOIN (SELECT EMP_CODE, MAX(TITLE) AS TITLE, MAX(NAME) AS NAME, MAX(SURNAME) AS SURNAME, MAX(DEPT) AS DEPT
                   FROM dbo.MANPOWER_HR GROUP BY EMP_CODE) m1
             ON m1.EMP_CODE = CAST(p.PRS_NO AS varchar(50))
      LEFT JOIN (SELECT EMP_CODE, MAX(TITLE) AS TITLE, MAX(NAME) AS NAME, MAX(SURNAME) AS SURNAME, MAX(DEPT) AS DEPT
                   FROM dbo.MANPOWER_HR GROUP BY EMP_CODE) m2
             ON m2.EMP_CODE = 'S' + CAST(p.PRS_NO AS varchar(50))
     WHERE ${KIND_WHERE[kind]}
     ORDER BY x.D, COALESCE(x.ScanLoc, x.BpLoc), p.PRS_NO, x.Card`)

  return result.recordset.map((r) => ({
    date: r.D instanceof Date ? r.D.toISOString().slice(0, 10) : String(r.D).slice(0, 10),
    card: String(r.Card).trim(),
    prsNo: r.PrsNo ? String(r.PrsNo).trim() : null,
    name: r.FullName && r.FullName.trim() !== '' ? r.FullName.replace(/\s+/g, ' ').trim() : null,
    dept: r.Dept,
    location: r.Loc,
    scanIn: r.ScanIn,
    bplusIn: r.BpIn
  }))
}

// ---------------------------------------------------------------------------
// ข้อมูล postback ของปุ่ม "ดูรายชื่อ" เช่น xc=bplusOnly&s=2026-09-18&e=2026-09-18&l=all&p=0
// (p = หน้าของรายชื่อ เริ่มที่ 0) LINE จำกัด data ไม่เกิน 300 ตัวอักษร
// ---------------------------------------------------------------------------

export interface CrossCheckListRequest extends CrossCheckScope {
  kind: CrossCheckKind
  page: number
}

export function crossCheckPostbackData(req: CrossCheckListRequest): string {
  return new URLSearchParams({ xc: req.kind, s: req.start, e: req.end, l: req.location, p: String(req.page) }).toString()
}

/** แปลง postback กลับเป็นคำขอ ค่าไม่ถูกต้อง/ไม่ใช่ปุ่มนี้ = null (ข้อมูลมาจากผู้ใช้ ตรวจทุกช่อง) */
export function parseCrossCheckPostback(data: string): CrossCheckListRequest | null {
  const q = new URLSearchParams(data)
  const kind = q.get('xc') as CrossCheckKind | null
  if (!kind || !CROSS_CHECK_KINDS.includes(kind)) return null
  const start = q.get('s') ?? ''
  const end = q.get('e') ?? ''
  const ymd = /^\d{4}-\d{2}-\d{2}$/
  if (!ymd.test(start) || !ymd.test(end) || start > end) return null
  const l = q.get('l')
  const location = l === 'Site' || l === 'Workshop' ? l : 'all'
  const page = Math.max(0, Math.min(1000, Number.parseInt(q.get('p') ?? '0', 10) || 0))
  return { kind, start, end, location, page }
}
