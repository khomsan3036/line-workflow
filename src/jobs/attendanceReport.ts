import { config } from '../config'
import { attendanceAvailable, getAttendanceSummary, type AttendanceSummary } from '../services/attendance'
import { attendanceAltText, flexAttendanceEmpty, flexAttendanceSummary } from '../services/attendanceFlex'
import { buildPeriod, todayLocal, type AttendanceQuery, type LocationFilter, type PeriodKey } from '../services/attendanceQuery'
import { getGroup } from '../services/groups'
import { sendAndLog } from '../services/messaging'

// ---------------------------------------------------------------------------
// งาน: ส่งการ์ด "สรุปการเข้างาน" (จำนวนพนักงานสแกนเข้างาน จากเครื่องสแกนนิ้ว) เข้ากลุ่มตามเวลาที่ตั้ง
//
// เป็นงานที่ REPORT_CRON เรียก (แทนรายงานยอดขายจำลองของหลักสูตร ซึ่งยังใช้ได้จาก CLI/หน้า /sales)
// การ์ดเป็นใบเดียวกับที่บอทตอบเมื่อพิมพ์ "สรุปพนักงาน วันนี้" จึงหน้าตาเหมือนกันทุกช่องทาง
//
// ปลายทาง: REPORT_GROUP_IDS (คั่นด้วยจุลภาค) ถ้าว่างใช้ DEFAULT_GROUP_ID
//   - id ขึ้นต้นด้วย C = กลุ่ม, U = ผู้ใช้ (ใส่ userId ตัวเองไว้ทดสอบก่อนส่งเข้ากลุ่มจริงได้)
//   - ส่งด้วย OA ที่อยู่ในกลุ่มนั้น (line_groups.channel) ถ้าไม่รู้จักกลุ่มใช้ OA HR
// ---------------------------------------------------------------------------

export interface AttendanceReportOptions {
  /** ช่วงเวลาที่สรุป ค่าเริ่มต้นตาม REPORT_PERIOD (today) */
  period?: PeriodKey
  /** สถานที่ ค่าเริ่มต้นตาม REPORT_LOCATION (all) */
  location?: LocationFilter
  /** ปลายทาง (override ค่าใน .env) */
  targets?: string[]
  dryRun?: boolean
  sentBy?: string
}

export interface AttendanceReportTarget {
  id: string
  name: string
  status: string
  error?: string
}

export interface AttendanceReportOutcome {
  query: AttendanceQuery
  summary: AttendanceSummary | null
  targets: AttendanceReportTarget[]
  sendStatus: 'sent' | 'mock' | 'dry-run' | 'failed' | 'partial' | 'no-target' | 'not-configured'
}

function parsePeriod(value: string | undefined): PeriodKey {
  const keys: PeriodKey[] = ['today', 'yesterday', 'thisWeek', 'lastWeek', 'thisMonth', 'lastMonth']
  return keys.includes(value as PeriodKey) ? (value as PeriodKey) : 'today'
}

function parseLocation(value: string | undefined): LocationFilter {
  const v = (value ?? '').trim().toLowerCase()
  if (v === 'workshop') return 'Workshop'
  if (v === 'site') return 'Site'
  return 'all'
}

/** ปลายทางที่ตั้งไว้ใน .env (REPORT_GROUP_IDS หรือ DEFAULT_GROUP_ID) */
export function configuredReportTargets(): string[] {
  const ids = config.scheduler.reportTargets.length > 0 ? config.scheduler.reportTargets : [config.defaultGroupId]
  return ids.map((s) => s.trim()).filter(Boolean)
}

export async function runAttendanceReport(options: AttendanceReportOptions = {}): Promise<AttendanceReportOutcome> {
  const query: AttendanceQuery = {
    period: buildPeriod(options.period ?? parsePeriod(config.scheduler.reportPeriod)),
    location: options.location ?? parseLocation(config.scheduler.reportLocation)
  }
  const targetIds = options.targets && options.targets.length > 0 ? options.targets : configuredReportTargets()
  const dryRun = options.dryRun ?? false
  const sentBy = options.sentBy ?? 'job:attendance-report'

  if (!attendanceAvailable()) return { query, summary: null, targets: [], sendStatus: 'not-configured' }
  // ไม่มีปลายทาง: โหมด dry-run ยังอ่านตัวเลขมาให้ดูได้ (ไว้ตรวจข้อมูลก่อนตั้งกลุ่ม) โหมดจริงหยุดเลย
  if (targetIds.length === 0 && !dryRun) return { query, summary: null, targets: [], sendStatus: 'no-target' }

  const summary = await getAttendanceSummary(query)
  if (targetIds.length === 0) return { query, summary, targets: [], sendStatus: 'no-target' }
  const altText = attendanceAltText(summary)
  const contents = summary.totalPeople > 0 ? flexAttendanceSummary(summary, todayLocal()) : flexAttendanceEmpty(query)

  const targets: AttendanceReportTarget[] = []
  for (const id of targetIds) {
    const isUser = id.startsWith('U')
    const group = isUser ? null : await getGroup(id)
    const name = group?.group_name ?? id
    const result = await sendAndLog({
      targetType: isUser ? 'user' : 'group',
      targetId: id,
      targetName: name,
      kind: 'flex',
      altText,
      contents,
      sentBy,
      dryRun,
      channel: group?.channel ?? 'hr'
    })
    targets.push({ id, name, status: result.status, error: result.error })
  }

  const ok = targets.filter((t) => t.status === 'sent' || t.status === 'mock' || t.status === 'dry-run').length
  const sendStatus: AttendanceReportOutcome['sendStatus'] =
    dryRun ? 'dry-run' : ok === 0 ? 'failed' : ok < targets.length ? 'partial' : config.mockLine ? 'mock' : 'sent'
  return { query, summary, targets, sendStatus }
}

/** พิมพ์สรุปลง console (ใช้ทั้ง CLI และ log ของ scheduler) */
export function printAttendanceReport(outcome: AttendanceReportOutcome): void {
  const { query, summary } = outcome
  console.log(`  ช่วงเวลา : ${query.period.label} · ${query.location === 'all' ? 'ทุกสถานที่' : query.location}`)
  if (summary) {
    console.log(`  สแกนเข้า : ${summary.totalPeople.toLocaleString('th-TH')} คน (ออกแล้ว ${summary.totalCheckedOut.toLocaleString('th-TH')})`)
    for (const l of summary.byLocation) console.log(`    - ${l.location}: ${l.people} คน (แรก ${l.earliestIn ?? '-'} ล่าสุด ${l.latestIn ?? '-'})`)
  }
  const label = (s: string) => (outcome.sendStatus === 'dry-run' ? 'dry-run (ไม่ส่งจริง)' : s)
  for (const t of outcome.targets) console.log(`  -> ${t.name}: ${label(t.status)}${t.error ? ` (${t.error})` : ''}`)
}
