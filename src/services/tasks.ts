import { query, queryOne } from '../db'

// ---------------------------------------------------------------------------
// งานที่มอบหมายกันในกลุ่ม (AI สกัดให้ หรือ admin เพิ่มเอง)
// ---------------------------------------------------------------------------

export interface TaskRow {
  id: number
  group_id: string
  assignee: string | null
  task_text: string
  due_text: string | null
  due_date: Date | null
  status: string
  source: string
  created_at: Date
  updated_at: Date
}

export interface NewTask {
  groupId: string
  assignee?: string | null
  taskText: string
  dueText?: string | null
  source?: 'ai' | 'manual'
  sourceMsg?: string | null
}

export async function addTask(t: NewTask): Promise<number> {
  const row = await queryOne<{ id: number }>(
    `INSERT INTO group_tasks (group_id, assignee, task_text, due_text, source, source_msg)
     VALUES ($1, $2::text, $3, $4::text, COALESCE($5::text, 'manual'), $6::text)
     RETURNING id`,
    [t.groupId, t.assignee ?? null, t.taskText, t.dueText ?? null, t.source ?? null, t.sourceMsg ?? null]
  )
  return row?.id ?? 0
}

/** เพิ่มงานหลายรายการ ข้ามงานที่ข้อความซ้ำกับของเดิมในกลุ่มเดียวกัน */
export async function addTasksSkipDuplicate(groupId: string, items: NewTask[]): Promise<number> {
  let added = 0
  for (const item of items) {
    const dup = await queryOne<{ id: number }>(
      `SELECT id FROM group_tasks WHERE group_id = $1 AND task_text = $2 AND status <> 'cancelled' LIMIT 1`,
      [groupId, item.taskText]
    )
    if (dup) continue
    await addTask({ ...item, groupId })
    added += 1
  }
  return added
}

export async function listTasks(groupId?: string, status?: string): Promise<TaskRow[]> {
  return query<TaskRow>(
    `SELECT * FROM group_tasks
      WHERE ($1::text IS NULL OR group_id = $1)
        AND ($2::text IS NULL OR status = $2)
      ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'done' THEN 1 ELSE 2 END,
               created_at DESC`,
    [groupId ?? null, status ?? null]
  )
}

export async function setTaskStatus(id: number, status: 'open' | 'done' | 'cancelled'): Promise<void> {
  await query('UPDATE group_tasks SET status = $2, updated_at = now() WHERE id = $1', [id, status])
}

export async function deleteTask(id: number): Promise<void> {
  await query('DELETE FROM group_tasks WHERE id = $1', [id])
}
