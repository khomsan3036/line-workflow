import { config } from '../config'
import { absenceStoreAltText, flexAbsenceStore } from '../services/absenceStoreFlex'
import { getGroup } from '../services/groups'
import { claimForSend } from '../services/maintenanceEvents'
import { sendAndLog } from '../services/messaging'
import { getAbsentEmployeeBacklogs, type AbsentBacklogReport, type StoreAbsenceLocation } from '../services/storeMcp'

// ---------------------------------------------------------------------------
// งาน: ส่งการ์ด "ขาดงานแต่ยังมีของค้างคืน" (Workshop / Site) ตาม ABSENCE_STORE_CRON ไปยัง ABSENCE_STORE_GROUP_IDS
// ข้อมูลทั้งหมดมาจาก integra-store-mcp-service (tool store_absent_employee_backlogs) เรียกแยกสถานที่ละครั้ง
// เพื่อให้แต่ละใบได้ top คนของตัวเอง (ฝั่ง store แคชผลการขาดงาน 5 นาที จึงอ่าน bPlus ครั้งเดียว)
// ส่งจาก scheduler จะจอง absence-store:<asOf>:<id> ใน maintenance_alert_dedupe กันสอง instance ส่งซ้ำ
// ---------------------------------------------------------------------------

export interface AbsenceStoreOptions {
  asOf?: string
  minDays?: number
  top?: number
  linesPerPerson?: number
  targets?: string[]
  dryRun?: boolean
  dedupe?: boolean
  sentBy?: string
}

export interface AbsenceStoreOutcome {
  reports: AbsentBacklogReport[]
  targets: { id: string; name: string; status: string; error?: string }[]
  sendStatus: 'sent' | 'mock' | 'dry-run' | 'failed' | 'partial' | 'no-target' | 'not-configured'
}

const LOCATIONS: StoreAbsenceLocation[] = ['Workshop', 'Site']

export async function runAbsenceStoreReport(options: AbsenceStoreOptions = {}): Promise<AbsenceStoreOutcome> {
  const s = config.storeAbsence
  if (!s.configured) return { reports: [], targets: [], sendStatus: 'not-configured' }

  const top = options.top ?? s.top
  const reports: AbsentBacklogReport[] = []
  for (const workLocation of LOCATIONS) {
    reports.push(
      await getAbsentEmployeeBacklogs({
        asOf: options.asOf,
        minDays: options.minDays ?? config.scheduler.absenceMinDays,
        workLocation,
        top,
        linesPerPerson: options.linesPerPerson ?? 1,
        mode: s.mode || undefined
      })
    )
  }

  const ids = options.targets ?? s.targets
  if (ids.length === 0) return { reports, targets: [], sendStatus: 'no-target' }

  const contents = flexAbsenceStore(reports, top, s.webUrl)
  const altText = absenceStoreAltText(reports)
  const targets: AbsenceStoreOutcome['targets'] = []
  for (const id of ids) {
    const isUser = id.startsWith('U')
    const group = isUser ? null : await getGroup(id)
    const name = group?.group_name ?? id
    if (options.dedupe && !options.dryRun && !(await claimForSend(`absence-store:${reports[0].asOf}:${id}`, 20))) {
      targets.push({ id, name, status: 'skipped', error: 'ส่งไปแล้ววันนี้ (instance อื่น)' })
      continue
    }
    const result = await sendAndLog({
      targetType: isUser ? 'user' : 'group',
      targetId: id,
      targetName: name,
      kind: 'flex',
      altText,
      contents,
      sentBy: options.sentBy ?? 'job:absence-store',
      dryRun: options.dryRun,
      channel: group?.channel ?? 'hr'
    })
    targets.push({ id, name, status: options.dryRun ? 'dry-run' : result.status, error: result.error })
  }

  const statuses = new Set(targets.map((t) => t.status))
  const sendStatus = options.dryRun
    ? 'dry-run'
    : statuses.size === 1
      ? ([...statuses][0] as AbsenceStoreOutcome['sendStatus'])
      : statuses.has('failed')
        ? 'partial'
        : 'sent'
  return { reports, targets, sendStatus }
}
