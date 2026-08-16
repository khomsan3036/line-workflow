import { pool, query } from '../db'
import { deleteMediaByMessageId } from './media'

// ---------------------------------------------------------------------------
// จัดการเมื่อผู้ใช้กด "ยกเลิกส่ง" (unsend)
//
// เอกสาร LINE ระบุแนวปฏิบัติไว้ชัดเจนว่า
//   "we recommend that service providers respect the user's intent to unsend
//    a sent message and handle the message appropriately with the utmost care
//    so that the target message can't be seen or used in the future"
//   และให้ "Delete the target message stored in a database or other storage device"
//
// ระบบที่เก็บบทสนทนาไว้จึงต้องมีส่วนนี้เสมอ ไม่ใช่ทางเลือก
// จุดสอนสำคัญ: การเก็บข้อมูลอย่างมีความรับผิดชอบ คือเก็บได้และ "ลบเป็น" ด้วย
// ---------------------------------------------------------------------------

export interface UnsendResult {
  messageRemoved: boolean
  mediaRemoved: boolean
}

export async function handleUnsend(lineMessageId: string): Promise<UnsendResult> {
  // 1) ลบเนื้อความออกจากตารางข้อความ แต่คงแถวไว้พร้อมประทับเวลา
  //    เพื่อให้ยังตรวจสอบได้ว่ามีการยกเลิกส่งเกิดขึ้นเมื่อไหร่ (ไม่เหลือเนื้อหาเดิม)
  const res = await pool.query(
    `UPDATE line_messages
        SET message_text = NULL,
            message_type = 'unsent',
            unsent_at = now()
      WHERE line_message_id = $1`,
    [lineMessageId]
  )

  // 2) ลบไฟล์ที่เก็บไว้ออกจาก storage จริง
  const mediaRemoved = await deleteMediaByMessageId(lineMessageId, 'unsend')

  // 3) ลบงานที่ AI สกัดมาจากข้อความนั้น (ถ้ามี) จะได้ไม่เหลือเนื้อหาที่ถูกยกเลิก
  await query(`DELETE FROM group_tasks WHERE source_msg = $1`, [lineMessageId])

  const messageRemoved = (res.rowCount ?? 0) > 0
  console.log(
    `[ยกเลิกส่ง] ${lineMessageId} - ข้อความ ${messageRemoved ? 'ลบแล้ว' : 'ไม่พบ'}, ไฟล์ ${mediaRemoved ? 'ลบแล้ว' : 'ไม่มี'}`
  )
  return { messageRemoved, mediaRemoved }
}
