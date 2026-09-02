import { detectPeriod, todayLocal, type DatePeriod } from './attendanceQuery'
import { isValidPrsNo, normalizePrsNo } from './manpowerApi'

// ---------------------------------------------------------------------------
// แปลงข้อความในแชท 1:1 เป็นคำสั่งเกี่ยวกับ "เวลาเข้างานของฉัน"
//
//   "สรุป time attendance ประจำวันของฉัน"  -> ดูของฉัน วันนี้
//   "เวลาเข้างานของฉัน อาทิตย์ที่แล้ว"    -> ดูของฉัน สัปดาห์ก่อน
//   "S69-1-003"                          -> ผูกรหัสพนักงาน (แล้วแสดงวันนี้ให้เลย)
//   "รหัสพนักงาน S69-1-003 เดือนนี้"      -> ผูกรหัส + ดูเดือนนี้
//   "ยกเลิกรหัสพนักงาน"                   -> ลบรหัสที่จำไว้
//
// คืน null เมื่อไม่เกี่ยว (ให้ตัวจัดการอื่นทำต่อ)
// ---------------------------------------------------------------------------

export type MyAttendanceCommand =
  | { kind: 'view'; period: DatePeriod; prsNo: string | null }
  | { kind: 'link'; period: DatePeriod; prsNo: string }
  | { kind: 'unlink' }

// คำที่บอกว่าเป็นเรื่อง "ของฉัน" (เวลาเข้า-ออกส่วนตัว)
const MINE_WORDS = [
  'ของฉัน',
  'ของผม',
  'ของดิฉัน',
  'ของหนู',
  'ของเรา',
  'ของตัวเอง',
  'time attendance',
  'timeattendance',
  'my attendance',
  'my time',
  'ลงเวลา',
  'ตอกบัตร',
  'เวลาเข้าออก',
  'เวลาเข้า-ออก',
  'เวลาเข้า ออก',
  'เวลาทำงานของ',
  'ฉันเข้างาน',
  'ผมเข้างาน',
  'เข้างานกี่โมง',
  'ออกงานกี่โมง',
  'สแกนกี่โมง'
]

const UNLINK_WORDS = ['ยกเลิกรหัสพนักงาน', 'ลบรหัสพนักงาน', 'เปลี่ยนรหัสพนักงาน', 'ลืมรหัสพนักงาน', 'unlink', 'ยกเลิกรหัส']

// รหัสพนักงาน เช่น S69-1-003, 20-1-026 (ต้องมีขีดสองตัว กันชนกับวันที่ 28-8-2026)
const PRS_NO_PATTERN = /\b([A-Za-z]{0,3}\d{1,3}-\d{1,2}-\d{3,4})\b/

function normalize(text: string): string {
  return text.trim().replace(/\s+/g, ' ')
}

/** ดึงรหัสพนักงานออกจากข้อความ (ถ้ามี) */
export function extractPrsNo(text: string): string | null {
  const m = normalize(text).match(PRS_NO_PATTERN)
  if (!m) return null
  const code = normalizePrsNo(m[1])
  return isValidPrsNo(code) ? code : null
}

export function isMineIntent(text: string): boolean {
  const t = normalize(text).toLowerCase()
  return MINE_WORDS.some((w) => t.includes(w))
}

export function parseMyAttendanceCommand(text: string, today = todayLocal()): MyAttendanceCommand | null {
  const raw = normalize(text)
  const lower = raw.toLowerCase()

  if (UNLINK_WORDS.some((w) => lower.includes(w))) return { kind: 'unlink' }

  const prsNo = extractPrsNo(raw)
  const period = detectPeriod(lower, today)

  // มีรหัสพนักงานในข้อความ (เช่น "S69-1-003", "รหัสพนักงาน 20-1-026 เดือนนี้") = ผูกรหัสแล้วแสดงผลทันที
  if (prsNo) return { kind: 'link', period, prsNo }

  if (isMineIntent(raw)) return { kind: 'view', period, prsNo: null }
  return null
}
