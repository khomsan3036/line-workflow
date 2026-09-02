import { todayLocal, type DatePeriod } from './attendanceQuery'
import { deleteEmployeeLink, getEmployeeLink, saveEmployeeLink } from './employeeLinks'
import { EmployeeNotFoundError, fetchManpower, type ManpowerResult } from './manpowerApi'
import {
  evaluateDay,
  flexMyAttendanceDay,
  flexMyAttendanceRange,
  myAttendanceAltText,
  myAttendanceQuickReply
} from './myAttendanceFlex'
import { parseMyAttendanceCommand } from './myAttendanceQuery'
import { replyAndLog, type SendResult } from './messaging'

// ---------------------------------------------------------------------------
// ตัวจัดการ "เวลาเข้างานของฉัน" (time attendance รายบุคคล) - ใช้เฉพาะแชท 1:1
//
//   1) แปลงข้อความ -> คำสั่ง (ดู / ผูกรหัส / ยกเลิกรหัส)   -> myAttendanceQuery.ts
//   2) หา prs_no: จากข้อความ หรือที่จำไว้ในตาราง line_employee_links
//   3) เรียก API ระบบ HR                                  -> manpowerApi.ts
//   4) ประกอบ Flex แล้วตอบพร้อม log                       -> myAttendanceFlex.ts
//
// ข้อมูลเวลาเข้า-ออกเป็นข้อมูลส่วนบุคคล จึงตอบเฉพาะในแชท 1:1 ไม่ตอบในกลุ่ม
// ---------------------------------------------------------------------------

export interface MyAttendanceInput {
  text: string
  replyToken: string
  userId: string
}

export interface MyAttendanceResult {
  result: SendResult
  summaryText: string
}

const ASK_CODE_TEXT = [
  'ผมยังไม่รู้รหัสพนักงานของคุณครับ',
  'พิมพ์รหัสพนักงานส่งมาได้เลย เช่น S69-1-003',
  '',
  'บอทจะจำไว้ให้ ครั้งต่อไปพิมพ์ "เวลาเข้างานของฉัน" ได้ทันที'
].join('\n')

const UNLINKED_TEXT = 'ลบรหัสพนักงานที่จำไว้แล้วครับ พิมพ์รหัสใหม่ส่งมาได้เลยเมื่อต้องการดูเวลาเข้างาน'
const NOTHING_TO_UNLINK_TEXT = 'ยังไม่มีรหัสพนักงานที่จำไว้ครับ พิมพ์รหัสพนักงาน เช่น S69-1-003 เพื่อเริ่มใช้งาน'

const API_ERROR_TEXT = [
  'ขออภัยครับ ตอนนี้ต่อระบบ HR ไม่ได้ชั่วคราว',
  'ลองใหม่อีกครั้งในอีกสักครู่ หรือแจ้งฝ่ายไอที ต่อ 105'
].join('\n')

function notFoundText(prsNo: string): string {
  return [
    `ไม่พบรหัสพนักงาน ${prsNo} ในระบบ HR ครับ`,
    'ตรวจรูปแบบอีกครั้ง เช่น S69-1-003 หรือ 20-1-026',
    'ถ้ายังไม่พบ ติดต่อฝ่ายบุคคล ต่อ 101'
  ].join('\n')
}

async function replyWithSummary(
  input: MyAttendanceInput,
  data: ManpowerResult,
  period: DatePeriod,
  note?: string
): Promise<MyAttendanceResult> {
  const today = todayLocal()
  // ไม่แสดงวันในอนาคต (สัปดาห์นี้/เดือนนี้ที่ยังมาไม่ถึง)
  const views = data.records.filter((r) => r.date <= today).map((r) => evaluateDay(r, today))

  const contents = period.single
    ? flexMyAttendanceDay(
        data.employee,
        period,
        views[0] ?? evaluateDay({ ...emptyRecord(period.start) }, today),
        note
      )
    : flexMyAttendanceRange(data.employee, period, views, note)

  const altText = myAttendanceAltText(data.employee, period, views)
  const result = await replyAndLog({
    replyToken: input.replyToken,
    targetType: 'user',
    targetId: input.userId,
    kind: 'flex',
    text: altText,
    contents,
    quickReply: myAttendanceQuickReply(period),
    sentBy: 'my-attendance:summary'
  })
  console.log(`[เข้างานของฉัน] ${data.employee.prsNo} ${period.label} (${result.status})`)
  return { result, summaryText: altText }
}

function emptyRecord(date: string) {
  return {
    date,
    stampIn: null,
    stampOut: null,
    shiftStart: null,
    shiftEnd: null,
    shiftCode: null,
    shiftHours: null,
    hasLog: false,
    scans: [],
    leave: false,
    absent: false,
    remark: null
  }
}

async function replyText(input: MyAttendanceInput, text: string, sentBy: string): Promise<MyAttendanceResult> {
  const result = await replyAndLog({
    replyToken: input.replyToken,
    targetType: 'user',
    targetId: input.userId,
    text,
    sentBy
  })
  return { result, summaryText: text }
}

/** คืน null เมื่อข้อความไม่ใช่เรื่องเวลาเข้างานของฉัน */
export async function handleMyAttendance(input: MyAttendanceInput): Promise<MyAttendanceResult | null> {
  const cmd = parseMyAttendanceCommand(input.text)
  if (!cmd) return null

  if (cmd.kind === 'unlink') {
    const removed = await deleteEmployeeLink(input.userId)
    return replyText(input, removed ? UNLINKED_TEXT : NOTHING_TO_UNLINK_TEXT, 'my-attendance:unlink')
  }

  let prsNo = cmd.prsNo
  if (!prsNo) {
    const link = await getEmployeeLink(input.userId)
    prsNo = link?.prs_no ?? null
  }
  if (!prsNo) return replyText(input, ASK_CODE_TEXT, 'my-attendance:ask-code')

  try {
    const data = await fetchManpower(prsNo, cmd.period.start, cmd.period.end)

    let note: string | undefined
    if (cmd.kind === 'link') {
      await saveEmployeeLink(input.userId, data.employee)
      note = `จำรหัสพนักงาน ${data.employee.prsNo} ไว้แล้ว ครั้งต่อไปพิมพ์ "เวลาเข้างานของฉัน" ได้เลย (พิมพ์ "ยกเลิกรหัสพนักงาน" เพื่อลบ)`
    }
    return await replyWithSummary(input, data, cmd.period, note)
  } catch (err) {
    if (err instanceof EmployeeNotFoundError) {
      return replyText(input, notFoundText(err.prsNo), 'my-attendance:not-found')
    }
    console.error('[เข้างานของฉัน] เรียก API ไม่สำเร็จ:', err instanceof Error ? err.message : err)
    return replyText(input, API_ERROR_TEXT, 'my-attendance:error')
  }
}
