import { config } from '../config'
import { getGroup } from '../services/groups'
import { getConsecutiveLateness, latenessAvailable, type LatenessReport } from '../services/lateness'
import { flexConsecutiveLateness, latenessAltText } from '../services/latenessFlex'
import { sendAndLog } from '../services/messaging'

// ---------------------------------------------------------------------------
// งาน: ส่งการ์ด "มาสายติดต่อกัน" (Workshop / Site) ตามเวลาที่ตั้ง (LATE_REPORT_CRON)
// ปลายทาง LATE_REPORT_GROUP_IDS (C... กลุ่ม / U... ผู้ใช้ทดสอบ) มีรายชื่อพนักงาน จึงควรส่งเฉพาะกลุ่ม HR/หัวหน้างาน
// แต่ละกลุ่มส่งด้วย OA ที่อยู่ในกลุ่มนั้น (line_groups.channel) ไม่รู้จักกลุ่ม = OA HR
// ---------------------------------------------------------------------------

export interface LatenessReportOptions {
  asOf?: string
  minDays?: number
  /** จำนวนรายชื่อต่อสถานที่ (ค่าเริ่มต้น LATE_REPORT_TOP = 10) */
  top?: number
  targets?: string[]
  dryRun?: boolean
  sentBy?: string
}

export interface LatenessReportOutcome {
  report: LatenessReport | null
  targets: { id: string; name: string; status: string; error?: string }[]
  sendStatus: 'sent' | 'mock' | 'dry-run' | 'failed' | 'partial' | 'no-target' | 'not-configured'
}

export async function runLatenessReport(options: LatenessReportOptions = {}): Promise<LatenessReportOutcome> {
  if (!latenessAvailable()) return { report: null, targets: [], sendStatus: 'not-configured' }

  const report = await getConsecutiveLateness({
    asOf: options.asOf,
    minDays: options.minDays ?? config.scheduler.lateMinDays,
    startTimes: { Workshop: config.scheduler.lateWorkshopTime, Site: config.scheduler.lateSiteTime },
    maxTime: config.scheduler.lateMaxTime
  })
  const ids = options.targets ?? config.scheduler.lateReportTargets
  if (ids.length === 0) return { report, targets: [], sendStatus: 'no-target' }

  const contents = flexConsecutiveLateness(report, options.top ?? config.scheduler.lateReportTop)
  const altText = latenessAltText(report)
  const targets: LatenessReportOutcome['targets'] = []
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
      sentBy: options.sentBy ?? 'job:late-report',
      dryRun: options.dryRun,
      channel: group?.channel ?? 'hr'
    })
    targets.push({ id, name: group?.group_name ?? id, status: options.dryRun ? 'dry-run' : result.status, error: result.error })
  }

  const statuses = new Set(targets.map((t) => t.status))
  const sendStatus = options.dryRun
    ? 'dry-run'
    : statuses.size === 1
      ? ([...statuses][0] as LatenessReportOutcome['sendStatus'])
      : statuses.has('failed')
        ? 'partial'
        : 'sent'
  return { report, targets, sendStatus }
}
