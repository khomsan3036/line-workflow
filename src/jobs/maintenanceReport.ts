import { config } from '../config'
import { listActiveGroups } from '../services/groups'
import { answerMaintenanceQuestion } from '../services/maintenanceAgent'
import { buildMaintenanceCard, cardToText, type MaintenanceCard } from '../services/maintenanceFlex'
import { sendAndLog } from '../services/messaging'

// ---------------------------------------------------------------------------
// งานตั้งเวลาของ OA ทีมซ่อมบำรุง (MT): ส่งการ์ดสรุปเข้ากลุ่มโดยไม่ต้องมีคนถาม
//
//   pending : "งานซ่อมค้างวันนี้"        - งานที่ยังไม่เสร็จ แยกเกินกำหนด/เร่งด่วน (ทุกเช้าตาม MT_PENDING_CRON)
//   urgent  : "แจ้งเตือนงานซ่อมเร่งด่วน" - ส่งเฉพาะเมื่อมีเรื่องด่วนจริง (การ์ด status = critical) ตาม MT_URGENT_CRON
//
// ใช้แชทบอทตัวเดียวกับที่ตอบในแชท (โมเดล + MCP tool) จึงได้การ์ดหน้าตาเดียวกันและตัวเลขจากระบบจริง
// ต่างกันแค่ผู้ถามคือ "scheduler" และหัวเรื่องถูกกำหนดตายตัวให้จำง่าย
// ปลายทาง: MT_REPORT_GROUP_IDS (C... กลุ่ม / U... ผู้ใช้ไว้ทดสอบ) ว่าง = ทุกกลุ่มที่บอท MT อยู่
// ส่วน "สรุปประชุมกลุ่มวันนี้" ของกลุ่ม MT ใช้งาน SUMMARY_CRON เดียวกับ OA HR (ส่งด้วย OA ของกลุ่มนั้นเอง)
// ---------------------------------------------------------------------------

export type MaintenanceReportKind = 'pending' | 'urgent'

const KINDS: Record<MaintenanceReportKind, { title: string; question: string; sentBy: string }> = {
  pending: {
    title: 'งานซ่อมค้างวันนี้',
    question:
      'สรุปงานซ่อมค้างวันนี้ (งานที่ยังไม่เสร็จทั้งหมด) แยกจำนวนงานเกินกำหนด งานเร่งด่วน งานกำลังทำ และงานรอคิว ' +
      'ยกรายการเกินกำหนดและเร่งด่วนขึ้นก่อน พร้อมเลขที่งานและทรัพย์สิน',
    sentBy: 'mt-report:pending'
  },
  urgent: {
    title: 'แจ้งเตือนงานซ่อมเร่งด่วน',
    question:
      'ตอนนี้มีงานซ่อมฉุกเฉิน เร่งด่วน หรือเกินกำหนดที่ต้องรีบจัดการไหม ถ้ามีให้ระบุเลขที่งาน ทรัพย์สิน อาการ และค้างมานานเท่าไร ' +
      'ถ้าไม่มีให้ตอบว่าไม่มีเรื่องด่วนและใช้ status ok',
    sentBy: 'mt-report:urgent'
  }
}

export interface MaintenanceReportOptions {
  kind: MaintenanceReportKind
  /** ปลายทาง (override .env) */
  targets?: string[]
  dryRun?: boolean
  sentBy?: string
  /** urgent: ส่งแม้ไม่มีเรื่องด่วน (ปกติข้ามเมื่อการ์ดไม่ใช่ critical) */
  alwaysSend?: boolean
}

export interface MaintenanceReportTarget {
  id: string
  name: string
  status: string
  error?: string
}

export interface MaintenanceReportOutcome {
  kind: MaintenanceReportKind
  title: string
  /** ข้อความล้วนของการ์ด (ไว้ log) */
  text: string
  cardStatus: MaintenanceCard['status'] | 'text'
  toolsUsed: string[]
  model: string
  targets: MaintenanceReportTarget[]
  sendStatus: 'sent' | 'mock' | 'dry-run' | 'failed' | 'partial' | 'skipped' | 'no-target' | 'agent-failed' | 'disabled'
}

/** ปลายทางที่ตั้งไว้ (MT_REPORT_GROUP_IDS) หรือทุกกลุ่มที่บอท MT อยู่ */
export async function configuredMaintenanceTargets(): Promise<Array<{ id: string; name: string }>> {
  if (config.scheduler.mtReportTargets.length > 0) {
    const groups = await listActiveGroups('mt')
    return config.scheduler.mtReportTargets.map((id) => ({ id, name: groups.find((g) => g.group_id === id)?.group_name ?? id }))
  }
  return (await listActiveGroups('mt')).map((g) => ({ id: g.group_id, name: g.group_name ?? g.group_id }))
}

export async function runMaintenanceReport(options: MaintenanceReportOptions): Promise<MaintenanceReportOutcome> {
  const spec = KINDS[options.kind]
  const dryRun = options.dryRun ?? false
  const sentBy = options.sentBy ?? spec.sentBy
  const base = { kind: options.kind, title: spec.title, text: '', cardStatus: 'text' as const, toolsUsed: [], model: '-', targets: [] }

  if (!config.maintenance.enabled) return { ...base, sendStatus: 'disabled' }

  const targets = options.targets && options.targets.length > 0
    ? options.targets.map((id) => ({ id, name: id }))
    : await configuredMaintenanceTargets()
  if (targets.length === 0 && !dryRun) return { ...base, sendStatus: 'no-target' }

  // ถามแชทบอทเหมือนผู้ใช้ถาม แต่ผู้ถามคือตัวตั้งเวลา (requestedBy ใน audit trail = "scheduler")
  const answer = await answerMaintenanceQuestion({
    userId: 'scheduler',
    displayName: 'scheduler',
    text: spec.question,
    history: [],
    groupId: null
  })
  if (answer.failed) return { ...base, text: answer.text, model: answer.model, sendStatus: 'agent-failed' }

  // หัวเรื่องคงที่ตามชนิดงาน จะได้จำง่ายว่าเป็นการ์ดรอบเช้า/แจ้งเตือน (โมเดลตั้งชื่อต่างกันไปทุกครั้ง)
  const card: MaintenanceCard | null = answer.reply.kind === 'card' ? { ...answer.reply.card, title: spec.title } : null
  const text = card ? cardToText(card) : answer.text
  const cardStatus: MaintenanceReportOutcome['cardStatus'] = card ? card.status : 'text'
  const outcome = { ...base, text, cardStatus, toolsUsed: answer.toolsUsed, model: answer.model }

  // แจ้งเตือนเร่งด่วน: ไม่มีเรื่องด่วนก็ไม่รบกวนกลุ่ม
  if (options.kind === 'urgent' && !options.alwaysSend && cardStatus !== 'critical') {
    return { ...outcome, sendStatus: 'skipped' }
  }
  if (targets.length === 0) return { ...outcome, sendStatus: 'no-target' }

  const results: MaintenanceReportTarget[] = []
  for (const t of targets) {
    const result = await sendAndLog({
      targetType: t.id.startsWith('U') ? 'user' : 'group',
      targetId: t.id,
      targetName: t.name,
      kind: card ? 'flex' : 'text',
      text,
      altText: text.slice(0, 400),
      contents: card ? buildMaintenanceCard(card) : undefined,
      sentBy,
      dryRun,
      channel: 'mt'
    })
    results.push({ id: t.id, name: t.name, status: result.status, error: result.error })
  }
  const ok = results.filter((r) => r.status === 'sent' || r.status === 'mock' || r.status === 'dry-run').length
  const sendStatus: MaintenanceReportOutcome['sendStatus'] =
    dryRun ? 'dry-run' : ok === 0 ? 'failed' : ok < results.length ? 'partial' : config.maintenance.mockLine ? 'mock' : 'sent'
  return { ...outcome, targets: results, sendStatus }
}

/** พิมพ์ผลลง console (CLI และ log ของ scheduler) */
export function printMaintenanceReport(outcome: MaintenanceReportOutcome): void {
  console.log(`  การ์ด    : ${outcome.title} (status ${outcome.cardStatus}, โมเดล ${outcome.model}, tools: ${outcome.toolsUsed.join(', ') || '-'})`)
  for (const line of outcome.text.split('\n').slice(0, 12)) console.log(`    ${line}`)
  const label = (s: string) => (outcome.sendStatus === 'dry-run' ? 'dry-run (ไม่ส่งจริง)' : s)
  for (const t of outcome.targets) console.log(`  -> ${t.name}: ${label(t.status)}${t.error ? ` (${t.error})` : ''}`)
}
