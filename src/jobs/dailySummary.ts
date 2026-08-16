import { config } from '../config'
import { flexDailySummary } from '../services/flex'
import { listGroups } from '../services/groups'
import { messagesInLastHours } from '../services/messages'
import { sendAndLog } from '../services/messaging'
import { topTalkers } from '../services/stats'
import { saveSummary, summarizeMessages } from '../services/summary'
import { addTasksSkipDuplicate, listTasks } from '../services/tasks'

// ---------------------------------------------------------------------------
// งาน: สรุปบทสนทนากลุ่มย้อนหลัง N ชั่วโมง แล้วส่งกลับเข้ากลุ่มเป็น Flex Message
//
// ตรรกะอยู่ที่นี่ที่เดียว แต่เรียกใช้ได้ 3 ทาง
//   1) CLI          : npm run daily-summary
//   2) ตัวตั้งเวลาในตัว : src/scheduler.ts (ใช้เมื่อ deploy บน cloud)
//   3) Dashboard    : ปุ่มในหน้า /summaries
// นี่คือเหตุผลที่ services/ ไม่ import อะไรจาก express เลย
// ---------------------------------------------------------------------------

export interface DailySummaryOptions {
  hours?: number
  groupId?: string
  dryRun?: boolean
  sentBy?: string
}

export interface DailySummaryOutcome {
  groupId: string
  groupName: string
  messageCount: number
  model: string
  tasksAdded: number
  sendStatus: string
  error?: string
  skipped?: boolean
}

export async function runDailySummary(options: DailySummaryOptions = {}): Promise<DailySummaryOutcome[]> {
  const hours = options.hours ?? 24
  const dryRun = options.dryRun ?? false
  const sentBy = options.sentBy ?? 'job:daily-summary'

  const groups = (await listGroups()).filter(
    (g) => g.is_active && (!options.groupId || g.group_id === options.groupId)
  )

  const results: DailySummaryOutcome[] = []

  for (const group of groups) {
    const groupName = group.group_name ?? group.group_id
    const messages = await messagesInLastHours(group.group_id, hours)

    if (messages.length === 0) {
      results.push({
        groupId: group.group_id,
        groupName,
        messageCount: 0,
        model: 'none',
        tasksAdded: 0,
        sendStatus: 'skipped',
        skipped: true
      })
      continue
    }

    const summary = await summarizeMessages(messages)
    const today = new Date().toLocaleDateString('en-CA', { timeZone: config.timezone })
    await saveSummary(group.group_id, today, summary)

    const tasksAdded = await addTasksSkipDuplicate(
      group.group_id,
      summary.tasks.map((t) => ({
        groupId: group.group_id,
        assignee: t.assignee,
        taskText: t.task,
        dueText: t.due ?? null,
        source: 'ai' as const
      }))
    )

    const [openTasks, talkers] = await Promise.all([
      listTasks(group.group_id, 'open'),
      topTalkers(3, group.group_id, 1)
    ])

    const sent = await sendAndLog({
      targetType: 'group',
      targetId: group.group_id,
      targetName: groupName,
      kind: 'flex',
      altText: `สรุปประชุมกลุ่มวันนี้ (${summary.messageCount} ข้อความ)`,
      contents: flexDailySummary({
        groupName,
        dateLabel: new Date().toLocaleDateString('th-TH', {
          timeZone: config.timezone,
          day: 'numeric',
          month: 'short',
          year: 'numeric'
        }),
        messageCount: summary.messageCount,
        topTalkers: talkers,
        topics: summary.topics,
        tasks: openTasks.slice(0, 6).map((t) => ({
          assignee: t.assignee ?? 'ไม่ระบุ',
          task: t.task_text,
          due: t.due_text ?? undefined
        }))
      }),
      sentBy,
      dryRun
    })

    results.push({
      groupId: group.group_id,
      groupName,
      messageCount: summary.messageCount,
      model: summary.model,
      tasksAdded,
      sendStatus: sent.status,
      error: sent.error
    })
  }

  return results
}
