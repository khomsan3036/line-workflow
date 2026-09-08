import { query, queryOne } from '../db'
import type { EmployeeInfo } from './manpowerApi'

// ---------------------------------------------------------------------------
// จำว่า LINE userId ไหนคือรหัสพนักงาน (prs_no) อะไร
//
// สองระดับความน่าเชื่อถือ
//   - verified_at เป็นค่า   = ผ่าน LINE Login + บริการ auth กลางแล้ว (ใช้ตอบ "เวลาเข้างานของฉัน" ได้)
//   - verified_at เป็น NULL = ผู้ใช้พิมพ์รหัสเอง (รูปแบบเดิม) ใช้ได้เฉพาะเมื่อ MY_ATTENDANCE_ALLOW_UNVERIFIED=true
// ---------------------------------------------------------------------------

export interface EmployeeLink {
  line_user_id: string
  prs_no: string
  full_name: string | null
  position: string | null
  dept: string | null
  linked_at: Date
  verified_at: Date | null
  verified_by: string | null
  auth_user_id: string | null
  auth_username: string | null
  line_display_name: string | null
}

export interface VerifiedLinkInput {
  prsNo: string
  fullName: string | null
  position: string | null
  dept: string | null
  /** line-login = เข้าด้วย LINE อย่างเดียว | line-login+password = ครั้งแรกที่กรอกรหัสผ่านด้วย */
  verifiedBy: 'line-login' | 'line-login+password'
  authUserId: string | null
  authUsername: string | null
  lineDisplayName: string | null
}

export function isVerifiedLink(link: EmployeeLink | null): boolean {
  return link !== null && link.verified_at !== null
}

export async function getEmployeeLink(lineUserId: string): Promise<EmployeeLink | null> {
  return queryOne<EmployeeLink>(
    `SELECT line_user_id, prs_no, full_name, position, dept, linked_at,
            verified_at, verified_by, auth_user_id, auth_username, line_display_name
       FROM line_employee_links
      WHERE line_user_id = $1`,
    [lineUserId]
  )
}

/** ผูกแบบพิมพ์รหัสเอง (ไม่ยืนยัน) - ล้างสถานะยืนยันเดิมทิ้งเพราะรหัสอาจเปลี่ยน */
export async function saveEmployeeLink(lineUserId: string, employee: EmployeeInfo): Promise<void> {
  await query(
    `INSERT INTO line_employee_links (line_user_id, prs_no, full_name, position, dept)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (line_user_id) DO UPDATE
        SET prs_no = EXCLUDED.prs_no,
            full_name = EXCLUDED.full_name,
            position = EXCLUDED.position,
            dept = EXCLUDED.dept,
            verified_at = NULL,
            verified_by = NULL,
            auth_user_id = NULL,
            auth_username = NULL,
            updated_at = now()`,
    [lineUserId, employee.prsNo, employee.fullName, employee.position, employee.dept]
  )
}

/** ผูกแบบยืนยันตัวตนแล้ว (ผ่าน LINE Login + บริการ auth กลาง) */
export async function saveVerifiedEmployeeLink(lineUserId: string, input: VerifiedLinkInput): Promise<void> {
  await query(
    `INSERT INTO line_employee_links
       (line_user_id, prs_no, full_name, position, dept,
        verified_at, verified_by, auth_user_id, auth_username, line_display_name)
     VALUES ($1, $2, $3, $4, $5, now(), $6, $7, $8, $9)
     ON CONFLICT (line_user_id) DO UPDATE
        SET prs_no = EXCLUDED.prs_no,
            full_name = COALESCE(EXCLUDED.full_name, line_employee_links.full_name),
            position = COALESCE(EXCLUDED.position, line_employee_links.position),
            dept = COALESCE(EXCLUDED.dept, line_employee_links.dept),
            verified_at = now(),
            verified_by = EXCLUDED.verified_by,
            auth_user_id = EXCLUDED.auth_user_id,
            auth_username = EXCLUDED.auth_username,
            line_display_name = EXCLUDED.line_display_name,
            updated_at = now()`,
    [
      lineUserId,
      input.prsNo,
      input.fullName,
      input.position,
      input.dept,
      input.verifiedBy,
      input.authUserId,
      input.authUsername,
      input.lineDisplayName
    ]
  )
}

/** เติมชื่อ/ตำแหน่ง/แผนกจากระบบ HR ให้แถวที่ผูกไว้ (ข้อมูลตอนยืนยันอาจยังไม่ครบ) */
export async function refreshEmployeeInfo(lineUserId: string, employee: EmployeeInfo): Promise<void> {
  await query(
    `UPDATE line_employee_links
        SET full_name = $2, position = $3, dept = $4, updated_at = now()
      WHERE line_user_id = $1 AND prs_no = $5`,
    [lineUserId, employee.fullName, employee.position, employee.dept, employee.prsNo]
  )
}

export async function deleteEmployeeLink(lineUserId: string): Promise<boolean> {
  const rows = await query<{ line_user_id: string }>(
    `DELETE FROM line_employee_links WHERE line_user_id = $1 RETURNING line_user_id`,
    [lineUserId]
  )
  return rows.length > 0
}
