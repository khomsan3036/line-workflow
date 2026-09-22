import { config } from '../config'
import { attendanceAvailable } from './attendance'
import { listCrossCheckPeople, parseCrossCheckPostback } from './attendanceCrossCheck'
import { CROSS_CHECK_KIND_LABELS, flexCrossCheckList } from './attendanceFlex'
import { getEmployeeLink, isVerifiedLink, type EmployeeLink } from './employeeLinks'
import { replyAndLog, sendAndLog } from './messaging'
import { pushVerifyCard } from './myAttendanceHandler'

// ---------------------------------------------------------------------------
// ปุ่ม "ดูรายชื่อ" บนการ์ดสรุปการเข้างาน (ส่วนตรวจเทียบ bPlus)
//
//   - ดูได้เฉพาะผู้ที่ยืนยันตัวตนผ่าน LINE Login แล้ว และอยู่แผนกใน CROSS_CHECK_LIST_DEPTS (ค่าเริ่มต้น HR)
//     หรือมีรหัสพนักงานใน CROSS_CHECK_LIST_PRS_NOS
//   - รายชื่อเป็นข้อมูลส่วนบุคคล จึงส่งเข้าแชทส่วนตัวของคนที่กดเสมอ แม้จะกดจากการ์ดในกลุ่ม
//     (กดในกลุ่มแล้วส่งส่วนตัวไม่ได้ เช่น ยังไม่ได้เพิ่มเพื่อน OA จึงตอบในกลุ่มเป็นข้อความสั้น ๆ ไม่มีรายชื่อ)
// ---------------------------------------------------------------------------

export interface CrossCheckListInput {
  data: string
  replyToken: string
  userId: string
  /** กดจากการ์ดในกลุ่ม = groupId, จากแชท 1:1 = null */
  groupId: string | null
}

type Message = { text: string } | { altText: string; contents: unknown }

const NOT_ALLOWED_TEXT = [
  'รายชื่อผลตรวจเทียบกับ bPlus เปิดให้ดูเฉพาะฝ่าย HR ครับ',
  'ถ้าต้องใช้ข้อมูลนี้ กรุณาติดต่อฝ่าย HR หรือให้ผู้ดูแลระบบเพิ่มสิทธิ์ให้'
].join('\n')

const NEED_VERIFY_TEXT = 'รายชื่อนี้เปิดให้เฉพาะฝ่าย HR ที่ยืนยันตัวตนแล้ว กรุณายืนยันตัวตนด้วย LINE ก่อนครับ'

const DB_ERROR_TEXT = 'ขออภัยครับ ตอนนี้อ่านข้อมูลเครื่องสแกน/bPlus ไม่ได้ชั่วคราว ลองใหม่อีกครั้งในอีกสักครู่'

export function canViewCrossCheckList(link: EmployeeLink | null): boolean {
  if (!link || !isVerifiedLink(link)) return false
  const dept = (link.dept ?? '').trim().toLowerCase()
  return (dept !== '' && config.crossCheckList.depts.includes(dept)) || config.crossCheckList.prsNos.includes(link.prs_no.toUpperCase())
}

/** ส่งเข้าแชทส่วนตัวของคนที่กด: 1:1 ใช้ reply token, จากกลุ่มใช้ push (ไม่ให้รายชื่อไปโผล่ในกลุ่ม) */
async function deliver(input: CrossCheckListInput, message: Message, sentBy: string): Promise<boolean> {
  const flex = 'contents' in message
  if (!input.groupId) {
    const result = await replyAndLog({
      replyToken: input.replyToken,
      targetType: 'user',
      targetId: input.userId,
      ...(flex ? { kind: 'flex' as const, text: message.altText, contents: message.contents } : { text: message.text }),
      sentBy
    })
    return result.status !== 'failed'
  }

  const result = await sendAndLog({
    targetType: 'user',
    targetId: input.userId,
    ...(flex ? { kind: 'flex' as const, altText: message.altText, contents: message.contents } : { kind: 'text' as const, text: message.text }),
    sentBy
  })
  if (result.status !== 'failed') return true

  await replyAndLog({
    replyToken: input.replyToken,
    targetType: 'group',
    targetId: input.groupId,
    text: 'ส่งรายชื่อทางแชทส่วนตัวไม่สำเร็จครับ กรุณาเพิ่มเพื่อนกับ OA นี้ก่อน แล้วกดดูรายชื่ออีกครั้ง',
    sentBy: `${sentBy}:push-failed`
  })
  return false
}

/** คืน false เมื่อ postback นี้ไม่ใช่ปุ่ม "ดูรายชื่อ" ให้ผู้เรียกทำอย่างอื่นต่อ */
export async function handleCrossCheckListPostback(input: CrossCheckListInput): Promise<boolean> {
  const req = parseCrossCheckPostback(input.data)
  if (!req) return false

  const link = await getEmployeeLink(input.userId)
  const where = input.groupId ? `กลุ่ม ${input.groupId}` : '1:1'

  if (!isVerifiedLink(link)) {
    console.log(`[ตรวจเทียบ] ${input.userId} ยังไม่ยืนยันตัวตน (${where}) -> ขอให้ยืนยันก่อน`)
    const sent = await deliver(input, { text: NEED_VERIFY_TEXT }, 'cross-check:need-verify')
    if (sent && config.lineLogin.enabled) await pushVerifyCard(input.userId)
    return true
  }

  if (!canViewCrossCheckList(link)) {
    console.log(`[ตรวจเทียบ] ${link?.prs_no} (${link?.dept ?? 'ไม่ทราบแผนก'}) ไม่มีสิทธิ์ดูรายชื่อ (${where})`)
    await deliver(input, { text: NOT_ALLOWED_TEXT }, 'cross-check:denied')
    return true
  }

  if (!attendanceAvailable()) {
    await deliver(input, { text: DB_ERROR_TEXT }, 'cross-check:not-configured')
    return true
  }

  try {
    const people = await listCrossCheckPeople(req, req.kind)
    const label = CROSS_CHECK_KIND_LABELS[req.kind]
    if (people.length === 0) {
      await deliver(input, { text: `ตอนนี้ไม่มีรายชื่อ "${label}" แล้วครับ (ข้อมูลอาจอัปเดตหลังส่งการ์ด)` }, 'cross-check:list-empty')
      return true
    }
    const card = flexCrossCheckList(req, people)
    const sent = await deliver(input, card, `cross-check:list:${link?.prs_no}`)
    console.log(
      `[ตรวจเทียบ] ${link?.prs_no} ดูรายชื่อ ${req.kind} ${req.start}..${req.end} ${req.location} หน้า ${req.page + 1}: ${people.length} รายการ (${where}, ${sent ? 'sent' : 'failed'})`
    )
  } catch (err) {
    console.error('[ตรวจเทียบ] อ่านรายชื่อไม่สำเร็จ:', err instanceof Error ? err.message : err)
    await deliver(input, { text: DB_ERROR_TEXT }, 'cross-check:error')
  }
  return true
}
