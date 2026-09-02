import { attendanceAvailable, getAttendanceSummary } from './attendance'
import { attendanceAltText, attendanceQuickReply, flexAttendanceEmpty, flexAttendanceSummary } from './attendanceFlex'
import { parseAttendanceQuery, todayLocal } from './attendanceQuery'
import { replyAndLog, type SendResult } from './messaging'

// ---------------------------------------------------------------------------
// ตัวจัดการคำถาม "สรุปพนักงานเข้างาน" จากแชท (ใช้ได้ทั้ง 1:1 และในกลุ่ม)
//
//   1) แปลงข้อความเป็นคำถาม (ช่วงเวลา + สถานที่)  -> attendanceQuery.ts
//   2) อ่านตัวเลขจาก SQL Server ของ HR             -> attendance.ts
//   3) ประกอบเป็น Flex แล้วตอบกลับพร้อม log        -> attendanceFlex.ts + messaging.ts
//
// คืน null เมื่อข้อความไม่ใช่คำถามเรื่องเข้างาน ให้ผู้เรียกไปทำ menu/fallback ต่อ
// ---------------------------------------------------------------------------

export interface AttendanceReplyInput {
  text: string
  replyToken: string
  targetType: 'user' | 'group'
  targetId?: string
}

export interface AttendanceReplyResult {
  result: SendResult
  /** สรุปสั้น ๆ ไว้เก็บลง direct_messages / log */
  summaryText: string
}

const NOT_CONFIGURED_TEXT = [
  'ยังไม่ได้เชื่อมต่อฐานข้อมูลเครื่องสแกนนิ้วครับ',
  'ผู้ดูแลระบบต้องตั้งค่า DATABASE_URL_MSSQL ในไฟล์ .env ก่อน'
].join('\n')

const DB_ERROR_TEXT = [
  'ขออภัยครับ ตอนนี้ต่อฐานข้อมูล HR ไม่ได้ชั่วคราว',
  'ลองใหม่อีกครั้งในอีกสักครู่ หรือแจ้งฝ่ายไอที ต่อ 105'
].join('\n')

export async function handleAttendanceQuestion(input: AttendanceReplyInput): Promise<AttendanceReplyResult | null> {
  const query = parseAttendanceQuery(input.text)
  if (!query) return null

  const base = { replyToken: input.replyToken, targetType: input.targetType, targetId: input.targetId }

  if (!attendanceAvailable()) {
    const result = await replyAndLog({ ...base, text: NOT_CONFIGURED_TEXT, sentBy: 'attendance:not-configured' })
    return { result, summaryText: NOT_CONFIGURED_TEXT }
  }

  try {
    const summary = await getAttendanceSummary(query)
    const altText = attendanceAltText(summary)
    const contents = summary.totalPeople > 0 ? flexAttendanceSummary(summary, todayLocal()) : flexAttendanceEmpty(query)

    const result = await replyAndLog({
      ...base,
      kind: 'flex',
      text: altText,
      contents,
      quickReply: attendanceQuickReply(query),
      sentBy: 'attendance:summary'
    })
    console.log(`[เข้างาน] ${query.period.label} / ${query.location} -> ${summary.totalPeople} คน (${result.status})`)
    return { result, summaryText: altText }
  } catch (err) {
    console.error('[เข้างาน] อ่านข้อมูลไม่สำเร็จ:', err instanceof Error ? err.message : err)
    const result = await replyAndLog({ ...base, text: DB_ERROR_TEXT, sentBy: 'attendance:error' })
    return { result, summaryText: DB_ERROR_TEXT }
  }
}
