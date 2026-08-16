import { query, queryOne } from '../db'

// ---------------------------------------------------------------------------
// ทะเบียนกลุ่ม LINE ที่บอทเข้าร่วม
// ---------------------------------------------------------------------------

export interface GroupRow {
  group_id: string
  group_name: string | null
  member_count: number | null
  is_active: boolean
  consent_at: Date | null
  joined_at: Date
  last_message_at: Date | null
  note: string | null
  message_count?: number
}

/** เพิ่ม/อัปเดตกลุ่ม เรียกจาก webhook ทุกครั้งที่มีข้อความเข้า */
export async function upsertGroup(groupId: string, patch: {
  groupName?: string | null
  memberCount?: number | null
  isActive?: boolean
  touchLastMessage?: boolean
} = {}): Promise<void> {
  await query(
    `INSERT INTO line_groups (group_id, group_name, member_count, is_active, last_message_at)
     VALUES ($1, $2::text, $3::integer, COALESCE($4::boolean, true),
             CASE WHEN $5::boolean THEN now() ELSE NULL END)
     ON CONFLICT (group_id) DO UPDATE SET
        group_name      = COALESCE(EXCLUDED.group_name, line_groups.group_name),
        member_count    = COALESCE(EXCLUDED.member_count, line_groups.member_count),
        is_active       = COALESCE($4::boolean, line_groups.is_active),
        last_message_at = CASE WHEN $5::boolean THEN now() ELSE line_groups.last_message_at END`,
    [groupId, patch.groupName ?? null, patch.memberCount ?? null, patch.isActive ?? null, patch.touchLastMessage ?? false]
  )
}

/** รายชื่อกลุ่มพร้อมจำนวนข้อความที่เก็บได้ */
export async function listGroups(): Promise<GroupRow[]> {
  return query<GroupRow>(
    `SELECT g.*,
            COALESCE(c.cnt, 0)::int AS message_count
       FROM line_groups g
       LEFT JOIN (
            SELECT group_id, COUNT(*) AS cnt FROM line_messages GROUP BY group_id
       ) c ON c.group_id = g.group_id
      ORDER BY g.last_message_at DESC NULLS LAST, g.joined_at DESC`
  )
}

export async function getGroup(groupId: string): Promise<GroupRow | null> {
  return queryOne<GroupRow>('SELECT * FROM line_groups WHERE group_id = $1', [groupId])
}

export async function updateGroup(groupId: string, patch: {
  groupName?: string
  note?: string
  consent?: boolean
}): Promise<void> {
  await query(
    `UPDATE line_groups SET
        group_name = COALESCE($2::text, group_name),
        note       = COALESCE($3::text, note),
        consent_at = CASE WHEN $4::boolean IS NULL THEN consent_at
                          WHEN $4::boolean THEN COALESCE(consent_at, now())
                          ELSE NULL END
      WHERE group_id = $1`,
    [groupId, patch.groupName ?? null, patch.note ?? null, patch.consent ?? null]
  )
}

/** กลุ่มที่ควรเลือกเป็นค่าเริ่มต้นใน dropdown */
export async function defaultGroupId(): Promise<string | null> {
  const row = await queryOne<{ group_id: string }>(
    `SELECT group_id FROM line_groups WHERE is_active ORDER BY last_message_at DESC NULLS LAST LIMIT 1`
  )
  return row?.group_id ?? null
}
