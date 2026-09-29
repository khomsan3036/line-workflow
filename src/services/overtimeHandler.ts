import { config } from '../config'
import { buildPeriod, detectPeriod, todayLocal, type DatePeriod } from './attendanceQuery'
import { getEmployeeLink, isVerifiedLink } from './employeeLinks'
import { replyAndLog, type SendResult } from './messaging'
import { replyVerifyCard } from './myAttendanceHandler'
import { getOvertimeRanking, getPersonalOvertime, overtimeAvailable, type OtLocation } from './overtime'
import {
  flexMyOvertime,
  flexOvertimeRanking,
  myOvertimeAltText,
  myOvertimeQuickReply,
  overtimeAltText,
  overtimeQuickReply
} from './overtimeFlex'

// ---------------------------------------------------------------------------
// ตอบคำถามเรื่อง OT จากแชท
//
// สิทธิ์ดู (ชื่อ + ชั่วโมง OT เป็นข้อมูลส่วนบุคคล)
//   - แชท 1:1: ดูได้เฉพาะ OT ของตัวเอง (ทุกคน รวมถึงคนในกลุ่ม HR) ต้องยืนยันตัวตนผ่าน LINE Login แบบเดียวกับ
//     "เวลาเข้างานของฉัน" (line_employee_links.verified_at) ยังไม่ยืนยัน = ส่งการ์ดยืนยันตัวตน
//   - กลุ่ม HR (config.scheduler.otAllowedGroupIds): การ์ดจัดอันดับ Top OT
//   - กลุ่มอื่น: ถ้า @บอท ตอบว่าอันดับดูได้เฉพาะกลุ่ม HR ถ้าไม่ได้ @ เงียบ (คืน null) ไม่รบกวนแชทของกลุ่มนั้น
//   - "OT ของฉัน" ในกลุ่ม: ไม่ตอบในกลุ่ม (ถ้า @บอท บอกให้ถามใน 1:1)
//
// ภาษาที่เข้าใจ (ช่วงเวลาใช้ detectPeriod ตัวเดียวกับสรุปการเข้างาน ไม่ระบุ = สัปดาห์นี้)
//   1:1  : ข้อความที่มีคำว่า OT / โอที / ล่วงเวลา เช่น "OT ของฉัน", "OT เดือนนี้"
//   กลุ่ม : "OT สัปดาห์นี้", "OT site เดือนที่แล้ว", "top 5 OT" - คัดเข้มกว่า เพราะบอทตอบโดยไม่ต้อง @
//          ต้องมีคำบอกช่วงเวลา/สถานที่/อันดับ หรือพิมพ์ "OT" คำเดียว และไม่ใช่ประโยคคำถามทั่วไป ("มี OT ไหม")
// คืน null เมื่อไม่ใช่คำถามนี้ ให้ผู้เรียกไปลองตัวจัดการถัดไป
// ---------------------------------------------------------------------------

export interface OvertimeQuery {
  period: DatePeriod
  location: OtLocation | 'all'
  limit: number
  /** ถามเรื่อง OT ของตัวเอง ("OT ของฉัน") */
  personal: boolean
}

const OT_WORD = /(?:^|[^a-z])(?:ot|overtime)(?![a-z])|โอที|ล่วงเวลา/
const RANK_WORD = /อันดับ|top|ท็อป|สูงสุด|มากที่สุด|เยอะสุด|สะสม|ขยัน/
const QUESTION_WORD = /กี่โมง|ไหม|มั้ย|หรือเปล่า|รึเปล่า|ยังไง|อย่างไร|เท่าไร|เท่าไหร่|\?/
const PERSONAL_WORD = /ของฉัน|ของผม|ของหนู|ของดิฉัน|ของเรา|ของตัวเอง/
const LOCATION_WORDS: Array<[OtLocation, RegExp]> = [
  ['Workshop', /workshop|เวิร์คช็อป|เวิร์กช็อป|เวิร์คชอป|โรงงาน/],
  ['Site', /(?:^|[^a-z])site(?![a-z])|ไซต์|ไซท์|หน้างาน/]
]
/** detectPeriod คืน "วันนี้" เมื่อไม่พบคำบอกช่วง จึงต้องดูว่าพิมพ์ว่าวันนี้จริงไหม */
const TODAY_WORD = /วันนี้|today/

const DEFAULT_LIMIT = 10

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * แปลงข้อความเป็นคำถาม OT - คืน null ถ้าไม่ใช่
 * inChat1to1 = แชท 1:1: ทุกข้อความที่พูดถึง OT ถือเป็นคำถาม OT ของตัวเอง
 */
export function parseOvertimeQuery(text: string, today = todayLocal(), inChat1to1 = false): OvertimeQuery | null {
  const t = normalize(text)
  if (!OT_WORD.test(t)) return null

  const detected = detectPeriod(t, today)
  const hasPeriod = detected.key !== 'today' || TODAY_WORD.test(t)
  const period = hasPeriod ? detected : buildPeriod('thisWeek', today)
  if (inChat1to1) return { period, location: 'all', limit: DEFAULT_LIMIT, personal: true }
  if (PERSONAL_WORD.test(t)) return { period, location: 'all', limit: DEFAULT_LIMIT, personal: true }

  const location = LOCATION_WORDS.find(([, re]) => re.test(t))?.[0] ?? 'all'
  const hasRank = RANK_WORD.test(t)
  const onlyOt = t.replace(OT_WORD, ' ').trim() === ''
  if (!hasRank && QUESTION_WORD.test(t)) return null
  if (!hasRank && !hasPeriod && location === 'all' && !onlyOt) return null

  const n = t.match(/(?:top|ท็อป)\s*(\d{1,2})|(\d{1,2})\s*อันดับ/)
  const limit = n ? Math.min(10, Math.max(1, Number(n[1] ?? n[2]))) : DEFAULT_LIMIT
  return { period, location, limit, personal: false }
}

/** คำบอกช่วงเวลาสำหรับประกอบข้อความ quick reply ให้ถามช่วงเดิมซ้ำได้ */
function periodText(period: DatePeriod): string {
  const phrases: Record<string, string> = {
    today: 'วันนี้',
    yesterday: 'เมื่อวาน',
    thisWeek: 'สัปดาห์นี้',
    lastWeek: 'สัปดาห์ที่แล้ว',
    thisMonth: 'เดือนนี้',
    lastMonth: 'เดือนที่แล้ว'
  }
  return phrases[period.key] ?? period.start
}

const NOT_CONFIGURED_TEXT = [
  'ยังไม่ได้เชื่อมต่อฐานข้อมูล HR (bPlus) ครับ',
  'ผู้ดูแลระบบต้องตั้งค่า DATABASE_URL_MSSQL ในไฟล์ .env ก่อน'
].join('\n')

const DB_ERROR_TEXT = [
  'ขออภัยครับ ตอนนี้อ่านข้อมูล OT จากฐาน HR ไม่ได้ชั่วคราว',
  'ลองใหม่อีกครั้งในอีกสักครู่ หรือแจ้งฝ่ายไอที ต่อ 105'
].join('\n')

const RANKING_DENIED_TEXT = [
  'การจัดอันดับ OT ดูได้เฉพาะในกลุ่ม HR ครับ 🙏',
  'ดู OT ของตัวเองได้ในแชทส่วนตัวกับบอท พิมพ์ "OT ของฉัน"'
].join('\n')

const PERSONAL_IN_GROUP_TEXT = 'OT ของแต่ละคนเป็นข้อมูลส่วนตัว ทักบอทในแชทส่วนตัวแล้วพิมพ์ "OT ของฉัน" ได้เลยครับ'

export interface OvertimeReplyInput {
  text: string
  replyToken: string
  targetType: 'user' | 'group'
  /** userId (แชท 1:1) หรือ groupId (กลุ่ม) */
  targetId?: string
  /** ข้อความในกลุ่มที่ @บอท มา (ตอบข้อความแนะนำแทนที่จะเงียบ) */
  addressed?: boolean
}

type OvertimeReply = { result: SendResult; summaryText: string }

export async function handleOvertimeQuestion(input: OvertimeReplyInput): Promise<OvertimeReply | null> {
  const inChat1to1 = input.targetType === 'user'
  const query = parseOvertimeQuery(input.text, todayLocal(), inChat1to1)
  if (!query) return null

  const base = { replyToken: input.replyToken, targetType: input.targetType, targetId: input.targetId }
  const reply = async (text: string, sentBy: string): Promise<OvertimeReply> => ({
    result: await replyAndLog({ ...base, text, sentBy }),
    summaryText: text
  })

  if (!inChat1to1) {
    if (query.personal) return input.addressed ? reply(PERSONAL_IN_GROUP_TEXT, 'overtime:personal-in-group') : null
    if (!config.scheduler.otAllowedGroupIds.includes(input.targetId ?? '')) {
      if (!input.addressed) return null
      console.log(`[OT] ปฏิเสธ: กลุ่ม ${input.targetId} ไม่มีสิทธิ์ดูอันดับ`)
      return reply(RANKING_DENIED_TEXT, 'overtime:denied')
    }
  }

  if (!overtimeAvailable()) return reply(NOT_CONFIGURED_TEXT, 'overtime:not-configured')
  return inChat1to1 ? replyMyOvertime(input, query) : replyRanking(input, query)
}

/** การ์ดจัดอันดับ (เฉพาะกลุ่ม HR) */
async function replyRanking(input: OvertimeReplyInput, query: OvertimeQuery): Promise<OvertimeReply> {
  const base = { replyToken: input.replyToken, targetType: input.targetType, targetId: input.targetId }
  try {
    const full = await getOvertimeRanking(query.period, query.limit)
    const ranking =
      query.location === 'all' ? full : { ...full, locations: full.locations.filter((l) => l.location === query.location) }
    const altText = overtimeAltText(ranking)
    const result = await replyAndLog({
      ...base,
      kind: 'flex',
      text: altText,
      contents: flexOvertimeRanking(ranking),
      quickReply: overtimeQuickReply(ranking, periodText(query.period)),
      sentBy: 'overtime:ranking'
    })
    console.log(`[OT] อันดับ ${query.period.label} / ${query.location} / top ${query.limit} (${result.status})`)
    return { result, summaryText: altText }
  } catch (err) {
    console.error('[OT] อ่านข้อมูลไม่สำเร็จ:', err instanceof Error ? err.message : err)
    return { result: await replyAndLog({ ...base, text: DB_ERROR_TEXT, sentBy: 'overtime:error' }), summaryText: DB_ERROR_TEXT }
  }
}

/** OT ของตัวเอง (แชท 1:1) ต้องยืนยันตัวตนแล้วเท่านั้น ไม่รับรหัสพนักงานที่พิมพ์มา */
async function replyMyOvertime(input: OvertimeReplyInput, query: OvertimeQuery): Promise<OvertimeReply> {
  const userId = input.targetId ?? ''
  const base = { replyToken: input.replyToken, targetType: 'user' as const, targetId: userId }
  const link = await getEmployeeLink(userId)
  const verified = link !== null && isVerifiedLink(link)
  // โหมดพัฒนา (MY_ATTENDANCE_ALLOW_UNVERIFIED) ใช้รหัสที่จำไว้โดยไม่ยืนยันได้ เหมือน "เวลาเข้างานของฉัน"
  if (!link || (!verified && !config.myAttendanceAllowUnverified)) {
    console.log(`[OT] ${userId} ยังไม่ยืนยันตัวตน -> ส่งการ์ดยืนยัน`)
    return replyVerifyCard({ text: input.text, replyToken: input.replyToken, userId })
  }

  try {
    const ot = await getPersonalOvertime(link.prs_no, query.period)
    const altText = myOvertimeAltText(ot)
    const result = await replyAndLog({
      ...base,
      kind: 'flex',
      text: altText,
      contents: flexMyOvertime(ot, link.full_name),
      quickReply: myOvertimeQuickReply(query.period.key),
      sentBy: 'overtime:mine'
    })
    console.log(`[OT] ของ ${link.prs_no} ${query.period.label} = ${ot.hours} ชม. (${result.status})`)
    return { result, summaryText: altText }
  } catch (err) {
    console.error('[OT] อ่าน OT ของพนักงานไม่สำเร็จ:', err instanceof Error ? err.message : err)
    return { result: await replyAndLog({ ...base, text: DB_ERROR_TEXT, sentBy: 'overtime:error' }), summaryText: DB_ERROR_TEXT }
  }
}
