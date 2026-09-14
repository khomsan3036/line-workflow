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
// เมื่อกรองสถานที่ นับคู่ที่ฝั่งใดฝั่งหนึ่งอยู่สถานที่นั้น
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

/**
 * อ่านผลตรวจเทียบของช่วงเวลา/สถานที่ที่ถาม
 * ยังไม่รองรับตัวกรองแผนก/ตำแหน่ง (ต้อง join ทะเบียน HR ทั้งสองฝั่ง) ผู้เรียกจึงไม่ควรเรียกเมื่อมีตัวกรอง
 */
export async function getBplusCrossCheck(query: AttendanceQuery): Promise<CrossCheckStat> {
  const pool = await getMssqlPool()
  const byLocation = query.location !== 'all'
  const request = pool
    .request()
    .input('start', sql.Date, query.period.start)
    .input('end', sql.Date, query.period.end)
    .input('tolerance', sql.Int, CROSS_CHECK_TIME_TOLERANCE_MIN)
  if (byLocation) request.input('location', sql.NVarChar(100), query.location)

  // PERSONALINFO อาจมีหลายแถวต่อ PRS_EMP (หลาย PRS_NO) จึงรวมเหลือแถวเดียวก่อน join ไม่ให้นับซ้ำ
  const result = await request.query<CrossCheckRow>(`
    WITH pinfo AS (
      SELECT Location, PRS_EMP, MAX(NULLIF(LTRIM(RTRIM(PRS_E_CARD)), '')) AS Card
        FROM dbo.AttendancePersonalInfo
       GROUP BY Location, PRS_EMP
    ),
    bpRaw AS (
      SELECT t.Location, t.TMT_DATE AS D, p.Card,
             COALESCE(t.TMT_STAMP_IN, t.TMT_STAMP_1) AS TimeIn,
             COALESCE(t.UpdatedAt, t.SyncedAt)      AS SyncedAt
        FROM dbo.AttendanceTmTran t
        LEFT JOIN pinfo p ON p.Location = t.Location AND p.PRS_EMP = t.TMT_EMP
       WHERE t.TMT_DATE >= @start AND t.TMT_DATE <= @end
         AND COALESCE(t.TMT_STAMP_IN, t.TMT_STAMP_OUT, t.TMT_STAMP_1) IS NOT NULL
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
      SELECT EnrollNumber, CheckDate AS D, LocationIn AS Loc,
             CAST(CheckDate AS datetime) + CAST(CheckTimeIn AS datetime) AS TimeIn
        FROM dbo.AttendanceDaily
       WHERE CheckDate >= @start AND CheckDate <= @end
    ),
    pairs AS (
      SELECT s.EnrollNumber AS ScanEmp, b.EnrollNumber AS BpEmp, s.TimeIn AS ScanIn, b.TimeIn AS BpIn
        FROM scan s
        FULL OUTER JOIN bp b ON b.EnrollNumber = s.EnrollNumber AND b.D = s.D
       WHERE COALESCE(s.D, b.D) IN (SELECT D FROM bpDays)
         ${byLocation ? 'AND (s.Loc = @location OR b.Loc = @location)' : ''}
    )
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
