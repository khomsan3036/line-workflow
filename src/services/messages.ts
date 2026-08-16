import { query, queryOne } from '../db'

// ---------------------------------------------------------------------------
// อ่าน/ค้นหาข้อความที่เก็บไว้ (ใช้ในหน้า "ประวัติแชท")
// ---------------------------------------------------------------------------

export interface MessageRow {
  id: number
  line_message_id: string | null
  group_id: string | null
  group_name: string | null
  user_id: string | null
  display_name: string | null
  message_type: string
  message_text: string | null
  sent_at: Date
}

export interface MessageFilter {
  groupId?: string
  keyword?: string
  sender?: string
  dateFrom?: string
  dateTo?: string
  messageType?: string
  page?: number
  pageSize?: number
}

interface WhereResult {
  clause: string
  params: unknown[]
}

function buildWhere(filter: MessageFilter): WhereResult {
  const conditions: string[] = []
  const params: unknown[] = []

  if (filter.groupId) {
    params.push(filter.groupId)
    conditions.push(`m.group_id = $${params.length}`)
  }
  if (filter.keyword) {
    params.push(`%${filter.keyword}%`)
    conditions.push(`m.message_text ILIKE $${params.length}`)
  }
  if (filter.sender) {
    params.push(`%${filter.sender}%`)
    conditions.push(`m.display_name ILIKE $${params.length}`)
  }
  if (filter.messageType) {
    params.push(filter.messageType)
    conditions.push(`m.message_type = $${params.length}`)
  }
  if (filter.dateFrom) {
    params.push(filter.dateFrom)
    conditions.push(`(m.sent_at AT TIME ZONE 'Asia/Bangkok')::date >= $${params.length}::date`)
  }
  if (filter.dateTo) {
    params.push(filter.dateTo)
    conditions.push(`(m.sent_at AT TIME ZONE 'Asia/Bangkok')::date <= $${params.length}::date`)
  }

  return {
    clause: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    params
  }
}

export async function searchMessages(filter: MessageFilter): Promise<{
  rows: MessageRow[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}> {
  const page = Math.max(1, filter.page ?? 1)
  const pageSize = Math.min(200, Math.max(10, filter.pageSize ?? 50))
  const { clause, params } = buildWhere(filter)

  const countRow = await queryOne<{ total: string }>(
    `SELECT COUNT(*) AS total FROM line_messages m ${clause}`,
    params
  )
  const total = Number(countRow?.total ?? 0)

  const rows = await query<MessageRow>(
    `SELECT m.id, m.line_message_id, m.group_id, g.group_name, m.user_id, m.display_name,
            m.message_type, m.message_text, m.sent_at
       FROM line_messages m
       LEFT JOIN line_groups g ON g.group_id = m.group_id
       ${clause}
      ORDER BY m.sent_at DESC
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
    params
  )

  return { rows, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) }
}

/** ดึงข้อความทั้งหมดตาม filter (ไม่แบ่งหน้า) สำหรับ export CSV และส่งให้ AI สรุป */
export async function fetchMessagesForExport(filter: MessageFilter, limit = 5000): Promise<MessageRow[]> {
  const { clause, params } = buildWhere(filter)
  return query<MessageRow>(
    `SELECT m.id, m.line_message_id, m.group_id, g.group_name, m.user_id, m.display_name,
            m.message_type, m.message_text, m.sent_at
       FROM line_messages m
       LEFT JOIN line_groups g ON g.group_id = m.group_id
       ${clause}
      ORDER BY m.sent_at ASC
      LIMIT ${limit}`,
    params
  )
}

/** ข้อความของกลุ่มในวันที่ระบุ (YYYY-MM-DD) เรียงตามเวลา ใช้ทำสรุป */
export async function messagesOfDay(groupId: string, date: string): Promise<MessageRow[]> {
  return query<MessageRow>(
    `SELECT m.id, m.line_message_id, m.group_id, g.group_name, m.user_id, m.display_name,
            m.message_type, m.message_text, m.sent_at
       FROM line_messages m
       LEFT JOIN line_groups g ON g.group_id = m.group_id
      WHERE m.group_id = $1
        AND (m.sent_at AT TIME ZONE 'Asia/Bangkok')::date = $2::date
      ORDER BY m.sent_at ASC`,
    [groupId, date]
  )
}

/** ข้อความย้อนหลัง N ชั่วโมง (ใช้ในสคริปต์ daily-summary) */
export async function messagesInLastHours(groupId: string, hours: number): Promise<MessageRow[]> {
  return query<MessageRow>(
    `SELECT m.id, m.line_message_id, m.group_id, g.group_name, m.user_id, m.display_name,
            m.message_type, m.message_text, m.sent_at
       FROM line_messages m
       LEFT JOIN line_groups g ON g.group_id = m.group_id
      WHERE m.group_id = $1
        AND m.sent_at >= now() - ($2 || ' hours')::interval
      ORDER BY m.sent_at ASC`,
    [groupId, hours]
  )
}

export function toCsv(rows: MessageRow[]): string {
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v)
    return `"${s.replace(/"/g, '""')}"`
  }
  const header = ['เวลา', 'กลุ่ม', 'ผู้ส่ง', 'ชนิด', 'ข้อความ'].map(esc).join(',')
  const body = rows.map((r) =>
    [
      new Date(r.sent_at).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' }),
      r.group_name ?? r.group_id,
      r.display_name ?? r.user_id,
      r.message_type,
      r.message_text
    ]
      .map(esc)
      .join(',')
  )
  // ใส่ BOM ให้ Excel เปิดไฟล์ภาษาไทยไม่เป็นตัวยึกยือ
  return '﻿' + [header, ...body].join('\r\n')
}
