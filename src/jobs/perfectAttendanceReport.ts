import { config } from '../config'
import { getGroup } from '../services/groups'
import { sendAndLog } from '../services/messaging'
import { getPerfectAttendance, perfectAttendanceAvailable, type PerfectAttendanceReport } from '../services/perfectAttendance'
import { flexPerfectAttendance, perfectAttendanceAltText } from '../services/perfectAttendanceFlex'

// ---------------------------------------------------------------------------
// งาน: ส่งการ์ด "พนักงานเข้างานดีเด่นประจำเดือน" (Workshop / Site) ตามเวลาที่ตั้ง (PERFECT_REPORT_CRON ค่าเริ่มต้นวันที่ 1 เวลา 09:10)
// ปลายทาง PERFECT_REPORT_GROUP_IDS (C... กลุ่ม / U... ผู้ใช้ทดสอบ) เป็นการ์ดชื่นชม ส่งเข้ากลุ่มพนักงานได้
// แต่ละกลุ่มส่งด้วย OA ที่อยู่ในกลุ่มนั้น (line_groups.channel) ไม่รู้จักกลุ่ม = OA HR
// ---------------------------------------------------------------------------

export interface PerfectReportOptions {
  /** YYYY-MM (ค่าเริ่มต้น = เดือนที่แล้ว) */
  month?: string
  /** จำนวนรายชื่อต่อสถานที่ (ค่าเริ่มต้น PERFECT_REPORT_TOP = 10) */
  top?: number
  targets?: string[]
  dryRun?: boolean
  sentBy?: string
}

export interface PerfectReportOutcome {
  report: PerfectAttendanceReport | null
  targets: { id: string; name: string; status: string; error?: string }[]
  sendStatus: 'sent' | 'mock' | 'dry-run' | 'failed' | 'partial' | 'no-target' | 'not-configured'
}

export async function runPerfectAttendanceReport(options: PerfectReportOptions = {}): Promise<PerfectReportOutcome> {
  if (!perfectAttendanceAvailable()) return { report: null, targets: [], sendStatus: 'not-configured' }

  const report = await getPerfectAttendance({
    month: options.month,
    startTimes: { Workshop: config.scheduler.lateWorkshopTime, Site: config.scheduler.lateSiteTime }
  })
  const ids = options.targets ?? config.scheduler.perfectReportTargets
  if (ids.length === 0) return { report, targets: [], sendStatus: 'no-target' }

  const contents = flexPerfectAttendance(report, options.top ?? config.scheduler.perfectReportTop)
  const altText = perfectAttendanceAltText(report)
  const targets: PerfectReportOutcome['targets'] = []
  for (const id of ids) {
    const isUser = id.startsWith('U')
    const group = isUser ? null : await getGroup(id)
    const result = await sendAndLog({
      targetType: isUser ? 'user' : 'group',
      targetId: id,
      targetName: group?.group_name ?? id,
      kind: 'flex',
      altText,
      contents,
      sentBy: options.sentBy ?? 'job:perfect-attendance',
      dryRun: options.dryRun,
      channel: group?.channel ?? 'hr'
    })
    targets.push({ id, name: group?.group_name ?? id, status: options.dryRun ? 'dry-run' : result.status, error: result.error })
  }

  const statuses = new Set(targets.map((t) => t.status))
  const sendStatus = options.dryRun
    ? 'dry-run'
    : statuses.size === 1
      ? ([...statuses][0] as PerfectReportOutcome['sendStatus'])
      : statuses.has('failed')
        ? 'partial'
        : 'sent'
  return { report, targets, sendStatus }
}
