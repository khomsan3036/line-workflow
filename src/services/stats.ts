import { query, queryOne } from '../db'

// ---------------------------------------------------------------------------
// สถิติสำหรับหน้า Overview
// ---------------------------------------------------------------------------

export interface Overview {
  totalMessages: number
  todayMessages: number
  activeGroups: number
  openTasks: number
  sentToday: number
  firstMessageAt: Date | null
  lastMessageAt: Date | null
}

export async function getOverview(groupId?: string): Promise<Overview> {
  const g = groupId ?? null
  const row = await queryOne<Record<string, string | Date | null>>(
    `SELECT
       (SELECT COUNT(*) FROM line_messages m WHERE ($1::text IS NULL OR m.group_id = $1))                    AS total_messages,
       (SELECT COUNT(*) FROM line_messages m WHERE ($1::text IS NULL OR m.group_id = $1)
          AND (m.sent_at AT TIME ZONE 'Asia/Bangkok')::date = (now() AT TIME ZONE 'Asia/Bangkok')::date)     AS today_messages,
       (SELECT COUNT(*) FROM line_groups WHERE is_active)                                                    AS active_groups,
       (SELECT COUNT(*) FROM group_tasks t WHERE t.status = 'open'
          AND ($1::text IS NULL OR t.group_id = $1))                                                         AS open_tasks,
       (SELECT COUNT(*) FROM message_logs l
          WHERE (l.created_at AT TIME ZONE 'Asia/Bangkok')::date = (now() AT TIME ZONE 'Asia/Bangkok')::date) AS sent_today,
       (SELECT MIN(sent_at) FROM line_messages m WHERE ($1::text IS NULL OR m.group_id = $1))                AS first_at,
       (SELECT MAX(sent_at) FROM line_messages m WHERE ($1::text IS NULL OR m.group_id = $1))                AS last_at`,
    [g]
  )

  return {
    totalMessages: Number(row?.total_messages ?? 0),
    todayMessages: Number(row?.today_messages ?? 0),
    activeGroups: Number(row?.active_groups ?? 0),
    openTasks: Number(row?.open_tasks ?? 0),
    sentToday: Number(row?.sent_today ?? 0),
    firstMessageAt: (row?.first_at as Date) ?? null,
    lastMessageAt: (row?.last_at as Date) ?? null
  }
}

/** จำนวนข้อความรายวัน N วันย้อนหลัง (เติมวันที่ไม่มีข้อความด้วย 0) */
export async function dailyCounts(days = 14, groupId?: string): Promise<{ day: string; count: number }[]> {
  const rows = await query<{ day: string; count: string }>(
    `WITH d AS (
        SELECT generate_series(
                 (now() AT TIME ZONE 'Asia/Bangkok')::date - ($1::int - 1),
                 (now() AT TIME ZONE 'Asia/Bangkok')::date,
                 '1 day'
               )::date AS day
     )
     SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
            COUNT(m.id) AS count
       FROM d
       LEFT JOIN line_messages m
              ON (m.sent_at AT TIME ZONE 'Asia/Bangkok')::date = d.day
             AND ($2::text IS NULL OR m.group_id = $2)
      GROUP BY d.day
      ORDER BY d.day`,
    [days, groupId ?? null]
  )
  return rows.map((r) => ({ day: r.day, count: Number(r.count) }))
}

/** คนที่คุยมากที่สุด */
export async function topTalkers(limit = 5, groupId?: string, days = 30): Promise<{ name: string; count: number }[]> {
  const rows = await query<{ name: string; count: string }>(
    `SELECT COALESCE(display_name, user_id, 'ไม่ทราบผู้ส่ง') AS name, COUNT(*) AS count
       FROM line_messages
      WHERE sent_at >= now() - ($3 || ' days')::interval
        AND ($2::text IS NULL OR group_id = $2)
      GROUP BY 1
      ORDER BY COUNT(*) DESC
      LIMIT $1`,
    [limit, groupId ?? null, days]
  )
  return rows.map((r) => ({ name: r.name, count: Number(r.count) }))
}

/** ความคึกคักตามชั่วโมง 0-23 */
export async function hourlyActivity(groupId?: string, days = 30): Promise<number[]> {
  const rows = await query<{ hour: string; count: string }>(
    `SELECT EXTRACT(HOUR FROM sent_at AT TIME ZONE 'Asia/Bangkok')::int::text AS hour, COUNT(*) AS count
       FROM line_messages
      WHERE sent_at >= now() - ($2 || ' days')::interval
        AND ($1::text IS NULL OR group_id = $1)
      GROUP BY 1`,
    [groupId ?? null, days]
  )
  const buckets = new Array(24).fill(0)
  for (const r of rows) buckets[Number(r.hour)] = Number(r.count)
  return buckets
}

/** สัดส่วนชนิดข้อความ */
export async function messageTypeBreakdown(groupId?: string): Promise<{ type: string; count: number }[]> {
  const rows = await query<{ message_type: string; count: string }>(
    `SELECT message_type, COUNT(*) AS count
       FROM line_messages
      WHERE ($1::text IS NULL OR group_id = $1)
      GROUP BY message_type
      ORDER BY COUNT(*) DESC`,
    [groupId ?? null]
  )
  return rows.map((r) => ({ type: r.message_type, count: Number(r.count) }))
}
