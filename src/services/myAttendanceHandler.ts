import { config } from '../config'
import { todayLocal, type DatePeriod } from './attendanceQuery'
import {
  deleteEmployeeLink,
  getEmployeeLink,
  isVerifiedLink,
  refreshEmployeeInfo,
  saveEmployeeLink,
  type EmployeeLink
} from './employeeLinks'
import { createLoginState, verifyStartUrl } from './lineLogin'
import { EmployeeNotFoundError, fetchManpower, type ManpowerResult } from './manpowerApi'
import {
  evaluateDay,
  flexMyAttendanceDay,
  flexMyAttendanceRange,
  flexVerifyIdentity,
  myAttendanceAltText,
  myAttendanceQuickReply
} from './myAttendanceFlex'
import { parseMyAttendanceCommand } from './myAttendanceQuery'
import { replyAndLog, sendAndLog, type SendResult } from './messaging'

// ---------------------------------------------------------------------------
// ตัวจัดการ "เวลาเข้างานของฉัน" (time attendance รายบุคคล) - ใช้เฉพาะแชท 1:1
//
//   1) แปลงข้อความ -> คำสั่ง (ดู / พิมพ์รหัส / ยกเลิกรหัส)     -> myAttendanceQuery.ts
//   2) ด่านตรวจสิทธิ์: ต้องมีรหัสพนักงานที่ "ยืนยันแล้ว" ผ่าน LINE Login
//      (ตาราง line_employee_links, verified_at ไม่เป็น NULL)      -> employeeLinks.ts / lineLogin.ts
//   3) เรียก API ระบบ HR                                       -> manpowerApi.ts
//   4) ประกอบ Flex แล้วตอบพร้อม log                            -> myAttendanceFlex.ts
//
// ข้อมูลเวลาเข้า-ออกเป็นข้อมูลส่วนบุคคล จึงตอบเฉพาะในแชท 1:1 และเฉพาะของเจ้าของรหัสที่ยืนยันแล้ว
// การพิมพ์รหัสพนักงานเองใช้ได้เฉพาะเมื่อตั้ง MY_ATTENDANCE_ALLOW_UNVERIFIED=true (ตอนพัฒนา)
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

const UNLINKED_TEXT = 'ลบรหัสพนักงานที่จำไว้แล้วครับ เมื่อต้องการดูเวลาเข้างานอีกครั้ง ให้ยืนยันตัวตนใหม่ผ่านปุ่มที่บอทส่งให้'
const NOTHING_TO_UNLINK_TEXT = 'ยังไม่มีรหัสพนักงานที่จำไว้ครับ พิมพ์ "เวลาเข้างานของฉัน" เพื่อเริ่มยืนยันตัวตน'

const NOT_CONFIGURED_TEXT = [
  'ขออภัยครับ ระบบยืนยันตัวตนยังไม่พร้อมใช้งาน',
  'จึงยังแสดงเวลาเข้างานให้ไม่ได้ กรุณาแจ้งฝ่ายไอที ต่อ 105'
].join('\n')

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

function notOwnerText(link: EmployeeLink, requested: string): string {
  return [
    `ดูได้เฉพาะเวลาเข้างานของตัวเองครับ (รหัส ${link.prs_no})`,
    `รหัส ${requested} ไม่ใช่รหัสที่ยืนยันตัวตนไว้`,
    '',
    'ถ้ารหัสพนักงานของคุณเปลี่ยน พิมพ์ "ยกเลิกรหัสพนักงาน" แล้วยืนยันตัวตนใหม่'
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

// ---------------------------------------------------------------------------
// การ์ดยืนยันตัวตน (ใช้ทั้งตอนเพิ่มเพื่อน และตอนถามเวลาเข้างานโดยยังไม่ยืนยัน)
// ---------------------------------------------------------------------------

const VERIFY_FOOTNOTE = 'ลิงก์ใช้ได้ครั้งเดียวและมีอายุจำกัด ถ้าหมดอายุพิมพ์ "เวลาเข้างานของฉัน" เพื่อขอใหม่'

async function buildVerifyCard(userId: string, reason: 'follow' | 'ask') {
  const state = await createLoginState(userId)
  const url = verifyStartUrl(state)
  if (reason === 'follow') {
    return {
      altText: 'ยินดีต้อนรับ กรุณายืนยันตัวตนเพื่อใช้บริการเวลาเข้างานของฉัน',
      contents: flexVerifyIdentity({
        url,
        title: 'ยินดีต้อนรับครับ',
        lines: [
          'ขอบคุณที่เพิ่มเพื่อนกับ HR Notification',
          'กดปุ่มด้านล่างเพื่อยืนยันตัวตนด้วย LINE แล้วผูกกับรหัสพนักงานของคุณ ทำครั้งเดียวจบ',
          'หลังจากนั้นพิมพ์ "เวลาเข้างานของฉัน" ดูเวลาเข้า-ออกได้ทันที'
        ],
        footnote: VERIFY_FOOTNOTE
      })
    }
  }
  return {
    altText: 'กรุณายืนยันตัวตนก่อนดูเวลาเข้างานของฉัน',
    contents: flexVerifyIdentity({
      url,
      title: 'ยืนยันตัวตนก่อนครับ',
      lines: [
        'ยังไม่ได้ผูกรหัสพนักงานกับ LINE นี้ หรือการยืนยันเดิมถูกยกเลิกไป',
        'กดปุ่มด้านล่างเพื่อยืนยันด้วย LINE ครั้งแรกอาจต้องกรอกรหัสพนักงานและรหัสผ่านของระบบ qtecintegra'
      ],
      footnote: VERIFY_FOOTNOTE
    })
  }
}

/** ตอบการ์ดยืนยันตัวตนผ่าน reply token (ตอนผู้ใช้ถามเวลาเข้างาน หรือ "OT ของฉัน") */
export async function replyVerifyCard(input: MyAttendanceInput): Promise<MyAttendanceResult> {
  if (!config.lineLogin.enabled) return replyText(input, NOT_CONFIGURED_TEXT, 'my-attendance:not-configured')
  const card = await buildVerifyCard(input.userId, 'ask')
  const result = await replyAndLog({
    replyToken: input.replyToken,
    targetType: 'user',
    targetId: input.userId,
    kind: 'flex',
    text: card.altText,
    contents: card.contents,
    sentBy: 'my-attendance:verify'
  })
  return { result, summaryText: card.altText }
}

/**
 * ส่งการ์ดยืนยันตัวตนตอนผู้ใช้เพิ่มเพื่อน (follow event) ผ่าน reply token
 * คืน false เมื่อไม่ต้องส่ง (LINE Login ยังไม่ตั้งค่า หรือผู้ใช้ยืนยันไว้แล้ว) ให้ webhook ทักทายตามปกติ
 */
export async function replyVerifyOnFollow(userId: string, replyToken: string): Promise<boolean> {
  if (!config.lineLogin.enabled) return false
  const link = await getEmployeeLink(userId)
  if (isVerifiedLink(link)) return false
  const card = await buildVerifyCard(userId, 'follow')
  await replyAndLog({
    replyToken,
    targetType: 'user',
    targetId: userId,
    kind: 'flex',
    text: card.altText,
    contents: card.contents,
    sentBy: 'line-login:follow'
  })
  // reply token ใช้ได้ครั้งเดียว ส่งการ์ดไปแล้ว (สำเร็จหรือไม่ก็ตาม) ถือว่าจัดการ follow แล้ว
  return true
}

/** push การ์ดยืนยันตัวตนโดยไม่ต้องมี reply token (ใช้จาก dashboard/สคริปต์) */
export async function pushVerifyCard(userId: string): Promise<SendResult> {
  const card = await buildVerifyCard(userId, 'ask')
  return sendAndLog({
    targetType: 'user',
    targetId: userId,
    kind: 'flex',
    altText: card.altText,
    contents: card.contents,
    sentBy: 'line-login:push'
  })
}

// ---------------------------------------------------------------------------
// ตัวจัดการหลัก
// ---------------------------------------------------------------------------

/** คืน null เมื่อข้อความไม่ใช่เรื่องเวลาเข้างานของฉัน */
export async function handleMyAttendance(input: MyAttendanceInput): Promise<MyAttendanceResult | null> {
  const cmd = parseMyAttendanceCommand(input.text)
  if (!cmd) return null

  if (cmd.kind === 'unlink') {
    const removed = await deleteEmployeeLink(input.userId)
    return replyText(input, removed ? UNLINKED_TEXT : NOTHING_TO_UNLINK_TEXT, 'my-attendance:unlink')
  }

  const link = await getEmployeeLink(input.userId)
  const verified = link !== null && isVerifiedLink(link)

  // ---- ด่านตรวจสิทธิ์ -----------------------------------------------------
  let prsNo: string | null
  let linkAfterFetch = false

  if (link && verified) {
    // ยืนยันแล้ว: ดูได้เฉพาะรหัสของตัวเอง ถ้าพิมพ์รหัสคนอื่นมาให้ปฏิเสธ
    if (cmd.kind === 'link' && cmd.prsNo !== link.prs_no) {
      console.warn(`[เข้างานของฉัน] ${input.userId} (${link.prs_no}) พยายามดูรหัส ${cmd.prsNo} -> ปฏิเสธ`)
      return replyText(input, notOwnerText(link, cmd.prsNo), 'my-attendance:forbidden')
    }
    prsNo = link.prs_no
  } else if (config.myAttendanceAllowUnverified) {
    // โหมดพัฒนา: ใช้รหัสที่พิมพ์มาหรือที่จำไว้ (ไม่ยืนยัน)
    prsNo = cmd.kind === 'link' ? cmd.prsNo : (link?.prs_no ?? null)
    linkAfterFetch = cmd.kind === 'link'
    if (!prsNo) return replyText(input, ASK_CODE_TEXT, 'my-attendance:ask-code')
  } else {
    // ยังไม่ยืนยัน: ส่งการ์ดให้ไปยืนยันผ่าน LINE Login ก่อน (ไม่รับรหัสที่พิมพ์มา)
    if (cmd.kind === 'link') {
      console.warn(`[เข้างานของฉัน] ${input.userId} พิมพ์รหัส ${cmd.prsNo} โดยยังไม่ยืนยันตัวตน -> ส่งการ์ดยืนยัน`)
    }
    return replyVerifyCard(input)
  }

  // ---- ดึงข้อมูลและตอบ -----------------------------------------------------
  try {
    const data = await fetchManpower(prsNo, cmd.period.start, cmd.period.end)

    let note: string | undefined
    if (linkAfterFetch) {
      await saveEmployeeLink(input.userId, data.employee)
      note = `จำรหัสพนักงาน ${data.employee.prsNo} ไว้แล้ว (โหมดไม่ยืนยันตัวตน) พิมพ์ "ยกเลิกรหัสพนักงาน" เพื่อลบ`
    } else if (link && verified && !link.full_name) {
      // เติมชื่อ/แผนกจาก HR ให้แถวที่ยืนยันผ่าน LINE Login (ตอนยืนยันอาจได้แค่รหัส)
      await refreshEmployeeInfo(input.userId, data.employee)
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
