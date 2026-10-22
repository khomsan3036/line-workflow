import { config } from '../config'
import { addDays, dayOfWeek, todayLocal } from '../services/attendanceQuery'
import { buildCleaningDayCard, type CleaningDayNotice, type CleaningDaySlot } from '../services/cleaningDayFlex'
import { getGroup } from '../services/groups'
import { claimForSend } from '../services/maintenanceEvents'
import { sendAndLog } from '../services/messaging'

// ---------------------------------------------------------------------------
// ประกาศ "Monthly Cleaning Day" = วันเสาร์สุดท้ายของเดือน
// CLEANING_DAY_CRON (ค่าเริ่มต้น 08:00 และ 17:00 ทุกวัน) เรียก runCleaningDayReminder แล้วงานนี้ตัดสินเองว่าวันนี้ต้องส่งอะไร:
//   N วันก่อน ... 1 วันก่อน  -> การ์ดนับถอยหลัง 1/N ... N/N (N = CLEANING_DAY_DAYS_BEFORE ค่าเริ่มต้น 3)
//   วันเสาร์นั้น เช้า / เย็น  -> "วันนี้คือ Cleaning Day" / "ขอบคุณทุกคน"
//   วันเสาร์นั้น slot "start" -> "อีก 15 นาทีเริ่มแล้ว" ส่งโดย cron แยก (CLEANING_DAY_START_TIME ลบ CLEANING_DAY_START_LEAD_MIN
//                               ค่าเริ่มต้น 15:30 - 15 = 15:15 ทุกวันเสาร์ งานนี้ส่งเฉพาะเสาร์สุดท้ายของเดือน)
//   วันอื่น (รวมถึงหลังวันเสาร์สุดท้ายไปแล้ว) -> ไม่ส่ง จนถึงช่วงแจ้งของเดือนหน้า
// ทุกวันที่คิดเป็นสตริง YYYY-MM-DD ตาม config.timezone (ไม่ใช้เวลาเครื่อง)
// ---------------------------------------------------------------------------

/** วันเสาร์สุดท้ายของเดือนที่ ymd อยู่ */
export function lastSaturdayOfMonth(ymd: string): string {
  const [y, m] = ymd.split('-').map(Number)
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const end = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
  return addDays(end, -((dayOfWeek(end) + 1) % 7))
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
}

/** ช่วงเวลาปัจจุบันตาม TZ: ก่อนเที่ยง = เช้า */
export function currentSlot(): CleaningDaySlot {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: config.timezone, hour: '2-digit', hourCycle: 'h23' }).format(new Date()))
  return hour < 12 ? 'morning' : 'evening'
}

/** วันนี้ต้องแจ้งอะไร (null = ไม่ต้องส่ง) */
export function cleaningDayNoticeFor(date: string, slot: CleaningDaySlot, daysBefore = config.scheduler.cleaningDayDaysBefore): CleaningDayNotice | null {
  const eventDate = lastSaturdayOfMonth(date)
  const daysLeft = daysBetween(date, eventDate)
  if (daysLeft < 0 || daysLeft > daysBefore) return null
  // รอบ "ก่อนเริ่ม" มีเฉพาะวันกิจกรรม วันอื่นไม่ส่ง
  if (slot === 'start') {
    if (daysLeft !== 0) return null
    return { kind: 'starting', eventDate, startTime: config.scheduler.cleaningDayStartTime, minutesLeft: config.scheduler.cleaningDayStartLeadMin, slot }
  }
  if (daysLeft === 0) {
    if (slot === 'morning') return { kind: 'today', eventDate, slot }
    return { kind: 'thanks', eventDate, nextEventDate: lastSaturdayOfMonth(addDays(eventDate, 7)), slot }
  }
  return { kind: 'countdown', eventDate, step: daysBefore - daysLeft + 1, total: daysBefore, daysLeft, slot }
}

export interface CleaningDayOptions {
  /** จำลองวันที่ YYYY-MM-DD (ค่าเริ่มต้น = วันนี้) */
  date?: string
  slot?: CleaningDaySlot
  targets?: string[]
  dryRun?: boolean
  /** ตัวตั้งเวลาเปิดไว้: กันส่งซ้ำเมื่อรันหลาย instance หรือ restart ในนาทีเดียวกัน */
  dedupe?: boolean
  sentBy?: string
}

export interface CleaningDayOutcome {
  notice: CleaningDayNotice | null
  card: { contents: unknown; altText: string } | null
  targets: { id: string; name: string; status: string; error?: string }[]
}

export async function runCleaningDayReminder(options: CleaningDayOptions = {}): Promise<CleaningDayOutcome> {
  const date = options.date ?? todayLocal()
  // วันที่ผิดรูปแบบทำให้นับวันได้ NaN แล้วการ์ดขึ้น "แจ้งเตือน NaN/3" จึงหยุดก่อนส่ง
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) throw new Error(`วันที่ไม่ถูกต้อง: "${date}" (ต้องเป็น YYYY-MM-DD)`)
  const slot = options.slot ?? currentSlot()
  const notice = cleaningDayNoticeFor(date, slot)
  if (!notice) return { notice: null, card: null, targets: [] }

  const card = buildCleaningDayCard(notice, config.scheduler.cleaningDayMessage)
  const targets: CleaningDayOutcome['targets'] = []
  for (const id of options.targets ?? config.scheduler.cleaningDayTargets) {
    const isUser = id.startsWith('U')
    const group = isUser ? null : await getGroup(id)
    const name = group?.group_name ?? id
    if (options.dedupe && !options.dryRun && !(await claimForSend(`cleaning-day:${date}:${slot}:${id}`, 6))) {
      targets.push({ id, name, status: 'skipped', error: 'ส่งรอบนี้ไปแล้ว' })
      continue
    }
    const result = await sendAndLog({
      targetType: isUser ? 'user' : 'group',
      targetId: id,
      targetName: name,
      kind: 'flex',
      altText: card.altText,
      contents: card.contents,
      sentBy: options.sentBy ?? 'job:cleaning-day',
      dryRun: options.dryRun,
      channel: group?.channel ?? 'hr'
    })
    targets.push({ id, name, status: options.dryRun ? 'dry-run' : result.status, error: result.error })
  }
  return { notice, card, targets }
}
