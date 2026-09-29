import { config } from '../config'
import { buildPeriod, type PeriodKey } from '../services/attendanceQuery'
import { getGroup } from '../services/groups'
import { sendAndLog } from '../services/messaging'
import { getOvertimeRanking, overtimeAvailable, type OtRanking } from '../services/overtime'
import { flexOvertimeRanking, overtimeAltText } from '../services/overtimeFlex'

// ---------------------------------------------------------------------------
// งาน: ส่งการ์ด "Top OT สะสม" (Workshop / Site) เข้ากลุ่มตามเวลาที่ตั้ง (OT_REPORT_CRON, ค่าเริ่มต้นจันทร์ 10:30)
// การ์ดใบเดียวกับที่บอทตอบเมื่อพิมพ์ "OT สัปดาห์ที่แล้ว" ปลายทาง OT_REPORT_GROUP_IDS (C... กลุ่ม / U... ผู้ใช้ทดสอบ)
// แต่ละกลุ่มส่งด้วย OA ที่อยู่ในกลุ่มนั้น (line_groups.channel) ไม่รู้จักกลุ่ม = OA HR
// ---------------------------------------------------------------------------

export interface OvertimeReportOptions {
  period?: PeriodKey
  targets?: string[]
  limit?: number
  dryRun?: boolean
  sentBy?: string
}

export interface OvertimeReportOutcome {
  ranking: OtRanking | null
  targets: { id: string; name: string; status: string; error?: string }[]
  sendStatus: 'sent' | 'mock' | 'dry-run' | 'failed' | 'partial' | 'no-target' | 'not-configured'
}

const PERIODS: PeriodKey[] = ['thisWeek', 'lastWeek', 'thisMonth', 'lastMonth']

export function parseOtPeriod(value: string | undefined): PeriodKey {
  return PERIODS.includes(value as PeriodKey) ? (value as PeriodKey) : 'lastWeek'
}

export async function runOvertimeReport(options: OvertimeReportOptions = {}): Promise<OvertimeReportOutcome> {
  if (!overtimeAvailable()) return { ranking: null, targets: [], sendStatus: 'not-configured' }

  const ranking = await getOvertimeRanking(
    buildPeriod(options.period ?? parseOtPeriod(config.scheduler.otReportPeriod)),
    options.limit ?? config.scheduler.otReportTop
  )
  const ids = options.targets ?? config.scheduler.otReportTargets
  if (ids.length === 0) return { ranking, targets: [], sendStatus: 'no-target' }

  const contents = flexOvertimeRanking(ranking)
  const altText = overtimeAltText(ranking)
  const targets: OvertimeReportOutcome['targets'] = []
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
      sentBy: options.sentBy ?? 'job:ot-report',
      dryRun: options.dryRun,
      channel: group?.channel ?? 'hr'
    })
    targets.push({ id, name: group?.group_name ?? id, status: options.dryRun ? 'dry-run' : result.status, error: result.error })
  }

  const statuses = new Set(targets.map((t) => t.status))
  const sendStatus = options.dryRun
    ? 'dry-run'
    : statuses.size === 1
      ? ([...statuses][0] as OvertimeReportOutcome['sendStatus'])
      : statuses.has('failed')
        ? 'partial'
        : 'sent'
  return { ranking, targets, sendStatus }
}
