import { query, queryOne } from '../db'
import type { EmployeeInfo } from './manpowerApi'

// ---------------------------------------------------------------------------
// จำว่า LINE userId ไหนคือรหัสพนักงาน (prs_no) อะไร
// ผู้ใช้พิมพ์รหัสครั้งเดียว หลังจากนั้นถาม "เวลาเข้างานของฉัน" ได้เลย
// ---------------------------------------------------------------------------

export interface EmployeeLink {
  line_user_id: string
  prs_no: string
  full_name: string | null
  position: string | null
  dept: string | null
  linked_at: Date
}

export async function getEmployeeLink(lineUserId: string): Promise<EmployeeLink | null> {
  return queryOne<EmployeeLink>(
    `SELECT line_user_id, prs_no, full_name, position, dept, linked_at
       FROM line_employee_links
      WHERE line_user_id = $1`,
    [lineUserId]
  )
}

export async function saveEmployeeLink(lineUserId: string, employee: EmployeeInfo): Promise<void> {
  await query(
    `INSERT INTO line_employee_links (line_user_id, prs_no, full_name, position, dept)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (line_user_id) DO UPDATE
        SET prs_no = EXCLUDED.prs_no,
            full_name = EXCLUDED.full_name,
            position = EXCLUDED.position,
            dept = EXCLUDED.dept,
            updated_at = now()`,
    [lineUserId, employee.prsNo, employee.fullName, employee.position, employee.dept]
  )
}

export async function deleteEmployeeLink(lineUserId: string): Promise<boolean> {
  const rows = await query<{ line_user_id: string }>(
    `DELETE FROM line_employee_links WHERE line_user_id = $1 RETURNING line_user_id`,
    [lineUserId]
  )
  return rows.length > 0
}
