import { config, type ReportTarget } from '../config'
import { attendanceAvailable, getAttendanceSummary, listDepartments, type AttendanceSummary } from '../services/attendance'
import { attendanceAltText, flexAttendanceEmpty, flexAttendanceSummary } from '../services/attendanceFlex'
import {
  buildPeriod,
  detectDepartment,
  todayLocal,
  type AttendanceQuery,
  type LocationFilter,
  type PeriodKey
} from '../services/attendanceQuery'
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
//
// การ์ดของแต่ละกลุ่มไม่จำเป็นต้องเหมือนกัน (ดู resolveDepartment):
//   - กลุ่มกลาง เช่น HR ("C123:all" หรือชื่อกลุ่มไม่ตรงแผนกไหน) -> ภาพรวมทุกสถานที่ แยกตามสถานที่
//   - กลุ่มของแผนก เช่น QTEC_INTEGRA_STORE -> เฉพาะแผนก Store ทุกสถานที่ แยกตามตำแหน่ง
// กลุ่มที่ได้การ์ดเหมือนกันใช้ผลอ่านฐานข้อมูลใบเดียวกัน (อ่าน SQL Server ครั้งเดียวต่อหนึ่งแผนก)
// ---------------------------------------------------------------------------

export interface AttendanceReportOptions {
  /** ช่วงเวลาที่สรุป ค่าเริ่มต้นตาม REPORT_PERIOD (today) */
  period?: PeriodKey
  /** สถานที่ ค่าเริ่มต้นตาม REPORT_LOCATION (all) */
  location?: LocationFilter
  /** ปลายทาง (override ค่าใน .env) รูปแบบเดียวกับ REPORT_GROUP_IDS คือใส่ ":แผนก" ต่อท้ายได้ */
  targets?: string[]
  /** บังคับแผนกให้ทุกปลายทางที่ระบุด้วย targets (ใช้ทดสอบการ์ดของแผนกหนึ่ง ๆ) */
  department?: string
  dryRun?: boolean
  sentBy?: string
}

export interface AttendanceReportTarget {
  id: string
  name: string
  status: string
  error?: string
}

/** การ์ดหนึ่งใบ (หนึ่งคำถาม) พร้อมปลายทางที่ได้รับใบนี้ */
export interface AttendanceReportCard {
  query: AttendanceQuery
  summary: AttendanceSummary
  targets: AttendanceReportTarget[]
}

export interface AttendanceReportOutcome {
  /** การ์ดที่ส่งทั้งหมด (ภาพรวมก่อน แล้วจึงเรียงตามลำดับใน REPORT_GROUP_IDS) */
  cards: AttendanceReportCard[]
  /** ปลายทางทั้งหมดรวมทุกใบ ไว้สรุปผลรวม */
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
export function configuredReportTargets(): ReportTarget[] {
  if (config.scheduler.reportTargetList.length > 0) return config.scheduler.reportTargetList
  const fallback = config.defaultGroupId.trim()
  return fallback ? [{ id: fallback, overall: false }] : []
}

/** "C123:Store" -> { id, department } (ใช้กับ --to ของ CLI ให้เขียนได้เหมือนใน .env) */
function parseTargetArg(value: string, department?: string): ReportTarget {
  const [rawId, ...rest] = value.split(':')
  const suffix = rest.join(':').trim()
  const id = rawId.trim()
  if (suffix.toLowerCase() === 'all') return { id, overall: true }
  const dept = suffix || department
  return dept ? { id, department: dept, overall: false } : { id, overall: false }
}

/**
 * แผนกของปลายทางหนึ่ง ๆ (undefined = การ์ดภาพรวม)
 *   1) ":all" ใน REPORT_GROUP_IDS  -> ภาพรวมเสมอ
 *   2) ":<แผนก>" ที่ตั้งไว้เอง      -> ใช้ชื่อแผนกจริงในทะเบียน HR ที่ตรงกับที่พิมพ์ (ไม่ตรงเลย = เตือนแล้วส่งภาพรวม)
 *   3) ไม่ได้ตั้ง                   -> เดาจากชื่อกลุ่ม เช่น "QTEC_INTEGRA_STORE" -> Store
 * ชื่อกลุ่มที่สะกดไม่ตรงทะเบียน HR (เช่น QTEC_INTEGRA_MANTENANCE) เดาไม่ได้ ต้องตั้ง ":Maintenance" เอง
 */
function resolveDepartment(target: ReportTarget, groupName: string | null, departments: string[]): string | undefined {
  if (target.overall) return undefined
  if (target.department) {
    const typed = target.department
    const exact = departments.find((d) => d.toLowerCase() === typed.toLowerCase())
    const dept = exact ?? detectDepartment(typed, departments)
    if (!dept) console.warn(`[attendance-report] ไม่รู้จักแผนก "${typed}" (${target.id}) จึงส่งการ์ดภาพรวมแทน`)
    return dept
  }
  return groupName ? detectDepartment(groupName, departments) : undefined
}

export async function runAttendanceReport(options: AttendanceReportOptions = {}): Promise<AttendanceReportOutcome> {
  const period = buildPeriod(options.period ?? parsePeriod(config.scheduler.reportPeriod))
  const location = options.location ?? parseLocation(config.scheduler.reportLocation)
  const targetList =
    options.targets && options.targets.length > 0
      ? options.targets.map((t) => parseTargetArg(t, options.department))
      : configuredReportTargets()
  const dryRun = options.dryRun ?? false
  const sentBy = options.sentBy ?? 'job:attendance-report'
  const empty = { cards: [], targets: [] }

  if (!attendanceAvailable()) return { ...empty, sendStatus: 'not-configured' }
  // ไม่มีปลายทาง: โหมด dry-run ยังอ่านตัวเลขภาพรวมมาให้ดูได้ (ไว้ตรวจข้อมูลก่อนตั้งกลุ่ม) โหมดจริงหยุดเลย
  if (targetList.length === 0 && !dryRun) return { ...empty, sendStatus: 'no-target' }

  // รายชื่อแผนกจริงในทะเบียน HR (cache 10 นาที) ใช้เทียบทั้งชื่อกลุ่มและค่าที่ตั้งเอง
  const departments = await listDepartments()

  // จัดกลุ่มปลายทางตามแผนก ปลายทางที่ได้การ์ดเหมือนกันจะอ่านฐานข้อมูลครั้งเดียว
  const byDepartment = new Map<string, { department?: string; targets: { target: ReportTarget; name: string; channel: 'hr' | 'mt' }[] }>()
  for (const target of targetList) {
    const isUser = target.id.startsWith('U')
    const group = isUser ? null : await getGroup(target.id)
    const department = resolveDepartment(target, group?.group_name ?? null, departments)
    const key = department ?? ''
    const bucket = byDepartment.get(key) ?? { department, targets: [] }
    bucket.targets.push({ target, name: group?.group_name ?? target.id, channel: group?.channel ?? 'hr' })
    byDepartment.set(key, bucket)
  }

  // dry-run ที่ไม่มีปลายทาง: แสดงการ์ดภาพรวมใบเดียวให้ดู
  if (byDepartment.size === 0) byDepartment.set('', { department: undefined, targets: [] })

  const cards: AttendanceReportCard[] = []
  for (const bucket of byDepartment.values()) {
    // มีแผนก = ดูรายตำแหน่งในแผนกนั้น, ไม่มีแผนก = ภาพรวมแยกตามสถานที่
    const query: AttendanceQuery = bucket.department
      ? { period, location, groupBy: 'position', department: bucket.department }
      : { period, location, groupBy: 'location' }
    const summary = await getAttendanceSummary(query)
    const altText = attendanceAltText(summary)
    const contents = summary.totalPeople > 0 ? flexAttendanceSummary(summary, todayLocal()) : flexAttendanceEmpty(query)

    const targets: AttendanceReportTarget[] = []
    for (const t of bucket.targets) {
      const result = await sendAndLog({
        targetType: t.target.id.startsWith('U') ? 'user' : 'group',
        targetId: t.target.id,
        targetName: t.name,
        kind: 'flex',
        altText,
        contents,
        sentBy,
        dryRun,
        channel: t.channel
      })
      targets.push({ id: t.target.id, name: t.name, status: result.status, error: result.error })
    }
    cards.push({ query, summary, targets })
  }

  // ภาพรวมขึ้นก่อน แล้วจึงเป็นการ์ดรายแผนก (เรียงตามชื่อแผนก) ให้ log อ่านง่าย
  cards.sort((a, b) => (a.query.department ?? '').localeCompare(b.query.department ?? '', 'en'))

  const allTargets = cards.flatMap((c) => c.targets)
  if (allTargets.length === 0) return { cards, targets: [], sendStatus: 'no-target' }
  const ok = allTargets.filter((t) => t.status === 'sent' || t.status === 'mock' || t.status === 'dry-run').length
  const sendStatus: AttendanceReportOutcome['sendStatus'] =
    dryRun ? 'dry-run' : ok === 0 ? 'failed' : ok < allTargets.length ? 'partial' : config.mockLine ? 'mock' : 'sent'
  return { cards, targets: allTargets, sendStatus }
}

/** พิมพ์สรุปลง console (ใช้ทั้ง CLI และ log ของ scheduler) */
export function printAttendanceReport(outcome: AttendanceReportOutcome): void {
  const label = (s: string) => (outcome.sendStatus === 'dry-run' ? 'dry-run (ไม่ส่งจริง)' : s)
  for (const { query, summary, targets } of outcome.cards) {
    const scope = query.department ? `แผนก ${query.department} · ตามตำแหน่ง` : 'ทุกแผนก · ตามสถานที่'
    console.log(`  ช่วงเวลา : ${query.period.label} · ${query.location === 'all' ? 'ทุกสถานที่' : query.location} · ${scope}`)
    console.log(`  สแกนเข้า : ${summary.totalPeople.toLocaleString('th-TH')} คน (ออกแล้ว ${summary.totalCheckedOut.toLocaleString('th-TH')})`)
    if (query.department) {
      for (const g of summary.byGroup.slice(0, 5)) console.log(`    - ${g.name}: ${g.people} คน`)
      if (summary.byGroup.length > 5) console.log(`    - อื่น ๆ อีก ${summary.byGroup.length - 5} ตำแหน่ง`)
    } else {
      for (const l of summary.byLocation) console.log(`    - ${l.location}: ${l.people} คน (แรก ${l.earliestIn ?? '-'} ล่าสุด ${l.latestIn ?? '-'})`)
    }
    for (const t of targets) console.log(`  -> ${t.name}: ${label(t.status)}${t.error ? ` (${t.error})` : ''}`)
  }
}
