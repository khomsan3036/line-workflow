import { config } from '../config'
import { addDays, dayOfWeek, todayLocal } from '../services/attendanceQuery'
import { buildCleaningDayCard, type CleaningDayNotice, type CleaningDaySlot } from '../services/cleaningDayFlex'
import { fetchCleaningDayFeed, type CleaningDayFeedItem } from '../services/cleaningDayConfig'
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

// ---------------------------------------------------------------------------
// โหมดตั้งค่าจาก Integra (CLEANING_DAY_CONFIG_API_URL, Owner 2026-11-27)
// scheduler เรียกทุกนาที แต่ละรายการที่เปิดใช้งานตัดสินจากวันกิจกรรมที่ Integra คำนวณให้ + เวลาที่ handler ตั้ง:
//   1..N วันก่อน เวลา noticeTime                  -> การ์ดนับถอยหลัง 1/N ... N/N
//   วันงาน เวลา noticeTime                         -> "วันนี้คือ Cleaning Day"
//   วันงาน เวลา startTime - startLeadMinutes (>0)  -> "อีก N นาทีเริ่ม"
//   วันงาน เวลา thanksTime (ไม่ว่าง)               -> "ขอบคุณทุกคน" + วันครั้งถัดไป
// ทุกการ์ดมีบรรทัด "เจ้าภาพ นำทีม Cleaning Day โดย คุณ XX" เมื่อเดือนนั้นมี Lead Team
// ---------------------------------------------------------------------------

/** HH:mm ตอนนี้ตาม config.timezone */
export function currentTimeLocal(): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: config.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date())
}

function minusMinutes(hhmm: string, minutes: number): string {
  const [h, m] = hhmm.split(':').map(Number)
  const total = (h * 60 + m - minutes + 1440) % 1440
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

function slotForTime(hhmm: string): CleaningDaySlot {
  return Number(hhmm.slice(0, 2)) < 12 ? 'morning' : 'evening'
}

/** การ์ดที่รายการนี้ต้องส่ง ณ วันที่และเวลานี้ (null = ไม่ต้องส่ง) */
export function integraNoticeFor(item: CleaningDayFeedItem, date: string, time: string): CleaningDayNotice | null {
  const s = item.schedule
  const occ = item.occurrences.find((o) => o.eventDate >= date)
  if (!occ) return null
  const daysLeft = daysBetween(date, occ.eventDate)
  if (daysLeft < 0 || daysLeft > s.daysBefore) return null
  if (daysLeft > 0) {
    if (time !== s.noticeTime) return null
    return { kind: 'countdown', eventDate: occ.eventDate, step: s.daysBefore - daysLeft + 1, total: s.daysBefore, daysLeft, slot: slotForTime(time) }
  }
  if (time === s.noticeTime) return { kind: 'today', eventDate: occ.eventDate, slot: slotForTime(time) }
  if (s.startLeadMinutes > 0 && time === minusMinutes(s.startTime, s.startLeadMinutes)) {
    return { kind: 'starting', eventDate: occ.eventDate, startTime: s.startTime, minutesLeft: s.startLeadMinutes, slot: 'start' }
  }
  if (s.thanksTime && time === s.thanksTime) {
    const next = item.occurrences.find((o) => o.eventDate > occ.eventDate)
    if (!next) return null
    return { kind: 'thanks', eventDate: occ.eventDate, nextEventDate: next.eventDate, slot: 'evening' }
  }
  return null
}

export interface IntegraTickOptions {
  /** YYYY-MM-DD (ค่าเริ่มต้น = วันนี้) */
  date?: string
  /** HH:mm (ค่าเริ่มต้น = ตอนนี้) */
  time?: string
  targets?: string[]
  dryRun?: boolean
  dedupe?: boolean
  sentBy?: string
}

export interface IntegraTickOutcome {
  schedule: string
  notice: CleaningDayNotice
  card: { contents: unknown; altText: string }
  targets: CleaningDayOutcome['targets']
}

export async function runCleaningDayTick(options: IntegraTickOptions = {}): Promise<IntegraTickOutcome[]> {
  const date = options.date ?? todayLocal()
  const time = options.time ?? currentTimeLocal()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`วันที่ไม่ถูกต้อง: "${date}" (ต้องเป็น YYYY-MM-DD)`)
  if (!/^\d{2}:\d{2}$/.test(time)) throw new Error(`เวลาไม่ถูกต้อง: "${time}" (ต้องเป็น HH:mm)`)
  const feed = await fetchCleaningDayFeed(date)
  const outcomes: IntegraTickOutcome[] = []
  for (const item of feed) {
    const notice = integraNoticeFor(item, date, time)
    if (!notice) continue
    const s = item.schedule
    const occ = item.occurrences.find((o) => o.eventDate === notice.eventDate)
    const card = buildCleaningDayCard(notice, s.messageText || config.scheduler.cleaningDayMessage, {
      title: s.name,
      timeRange: s.endTime ? `${s.startTime} – ${s.endTime}` : s.startTime,
      leads: occ?.leads.map((l) => l.leadName) ?? []
    })
    const ids = options.targets ?? (s.targetIds.length > 0 ? s.targetIds : config.scheduler.cleaningDayTargets)
    const targets: CleaningDayOutcome['targets'] = []
    for (const id of ids) {
      const isUser = id.startsWith('U')
      const group = isUser ? null : await getGroup(id)
      const name = group?.group_name ?? id
      if (options.dedupe && !options.dryRun && !(await claimForSend(`cleaning-day:${s.id}:${date}:${notice.kind}:${id}`, 6))) {
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
    outcomes.push({ schedule: s.name, notice, card, targets })
  }
  return outcomes
}
