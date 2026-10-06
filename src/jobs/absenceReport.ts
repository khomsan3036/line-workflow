import { config } from '../config'
import { getConsecutiveAbsence, absenceAvailable, type AbsenceReport } from '../services/absence'
import { absenceAltText, flexConsecutiveAbsence } from '../services/absenceFlex'
import { getGroup } from '../services/groups'
import { sendAndLog } from '../services/messaging'

// ---------------------------------------------------------------------------
// งาน: ส่งการ์ด "ขาดงานติดต่อกัน" (Workshop / Site) ตามเวลาที่ตั้ง (ABSENCE_REPORT_CRON)
// ปลายทาง ABSENCE_REPORT_GROUP_IDS (C... กลุ่ม / U... ผู้ใช้ทดสอบ) รายชื่อพนักงานจึงควรส่งเฉพาะกลุ่ม HR/หัวหน้างาน
// แต่ละกลุ่มส่งด้วย OA ที่อยู่ในกลุ่มนั้น (line_groups.channel) ไม่รู้จักกลุ่ม = OA HR
// ---------------------------------------------------------------------------

export interface AbsenceReportOptions {
  asOf?: string
  minDays?: number
  activeDays?: number
  /** จำนวนรายชื่อต่อสถานที่ (ค่าเริ่มต้น ABSENCE_REPORT_TOP = 10) */
  top?: number
  targets?: string[]
  dryRun?: boolean
  sentBy?: string
}

export interface AbsenceReportOutcome {
  report: AbsenceReport | null
  targets: { id: string; name: string; status: string; error?: string }[]
  sendStatus: 'sent' | 'mock' | 'dry-run' | 'failed' | 'partial' | 'no-target' | 'not-configured'
}

export async function runAbsenceReport(options: AbsenceReportOptions = {}): Promise<AbsenceReportOutcome> {
  if (!absenceAvailable()) return { report: null, targets: [], sendStatus: 'not-configured' }

  const report = await getConsecutiveAbsence({
    asOf: options.asOf,
    minDays: options.minDays ?? config.scheduler.absenceMinDays,
    activeDays: options.activeDays ?? config.scheduler.absenceActiveDays
  })
  const ids = options.targets ?? config.scheduler.absenceReportTargets
  if (ids.length === 0) return { report, targets: [], sendStatus: 'no-target' }

  const contents = flexConsecutiveAbsence(report, options.top ?? config.scheduler.absenceReportTop)
  const altText = absenceAltText(report)
  const targets: AbsenceReportOutcome['targets'] = []
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
      sentBy: options.sentBy ?? 'job:absence-report',
      dryRun: options.dryRun,
      channel: group?.channel ?? 'hr'
    })
    targets.push({ id, name: group?.group_name ?? id, status: options.dryRun ? 'dry-run' : result.status, error: result.error })
  }

  const statuses = new Set(targets.map((t) => t.status))
  const sendStatus = options.dryRun
    ? 'dry-run'
    : statuses.size === 1
      ? ([...statuses][0] as AbsenceReportOutcome['sendStatus'])
      : statuses.has('failed')
        ? 'partial'
        : 'sent'
  return { report, targets, sendStatus }
}
