import { config } from '../config'
import { flexAbsenceStoreDetail, parseAbsenceStorePostback } from './absenceStoreFlex'
import { getEmployeeLink, isVerifiedLink } from './employeeLinks'
import { replyAndLog } from './messaging'
import { replyVerifyCard } from './myAttendanceHandler'
import { getEmployeeBacklog, StoreMcpError, type StoreAbsenceLocation } from './storeMcp'

// ---------------------------------------------------------------------------
// การ์ด "ของค้างคืนกับ Store" ของพนักงานคนเดียว (ข้อมูลจาก integra-store-mcp-service, store_employee_backlogs)
//
// เปิดได้ 2 ทาง
//   1. ปุ่ม › บนการ์ด "ขาดงานแต่ยังมีของค้างคืน" (postback asb=<รหัส>&d=&s=&l=W|S) ตอบในแชทที่กด
//   2. พิมพ์ถาม "ดูของค้างคืน 69-2-073" / "ของค้างยืม S69-2-073" / "@บอท ของค้าง 69-2-073"
//      - กลุ่ม Store (ABSENCE_STORE_QUERY_GROUP_IDS ว่าง = กลุ่ม C... ใน ABSENCE_STORE_GROUP_IDS + STORE_REQUEST_LINE_TARGETS)
//        ถามรหัสใครก็ได้ ไม่ต้อง @บอท
//      - กลุ่มอื่น: เงียบ (ถ้า @บอท ตอบสั้น ๆ ว่าถามได้ในกลุ่ม Store)
//      - แชท 1:1: ดูได้เฉพาะของตัวเอง และต้องยืนยันตัวตน (LINE Login) แล้วเหมือน OT ของฉัน
//        ยกเว้นผู้ใช้ใน ABSENCE_STORE_QUERY_USER_IDS ถามของใครก็ได้
// ---------------------------------------------------------------------------

/** รหัสพนักงาน QTEC (69-2-073, S69-2-073) หรือรหัสสมมติของ store (dummy-emp-00870) */
const CODE = String.raw`([Ss]?\d{2}-\d-\d{3,4}|dummy-emp-\d+)`
const QUESTION = new RegExp(String.raw`^(?:ขอ)?(?:ดู|เช็ค|เช็ก|ตรวจ)?\s*(?:รายการ)?ของ\s*ค้าง\s*(?:คืน|ยืม)?\s*(?:ของ)?\s*(?:รหัส|พนักงาน)?\s*:?\s*${CODE}\s*$`, 'i')

/** รหัสพนักงานจากข้อความ "ดูของค้างคืน 69-2-073" ไม่ใช่รูปแบบนี้คืน null */
export function parseBacklogQuestion(text: string): string | null {
  const m = QUESTION.exec(text.trim().replace(/\s+/g, ' '))
  return m ? m[1] : null
}

/** กลุ่มที่พิมพ์ถามของค้างของใครก็ได้ */
export function backlogQueryGroupIds(): string[] {
  const set = config.storeAbsence.queryGroupIds.length > 0
    ? config.storeAbsence.queryGroupIds
    : [...config.storeAbsence.targets, ...config.storeRequest.targets]
  return [...new Set(set.filter((id) => id.startsWith('C')))]
}

const baseCode = (c: string) => (/^[Ss]\d/.test(c) ? c.slice(1) : c)

interface DetailTarget {
  replyToken: string
  targetType: 'group' | 'user'
  targetId?: string
  empCode: string
  daysAbsent?: number
  lastScan?: string
  location?: StoreAbsenceLocation
  sentBy: string
}

/** อ่านของค้างของคนนั้นจาก store แล้วตอบการ์ดรายละเอียด (ไม่เจอด้วยรหัสที่พิมพ์ ลองรหัสแบบมี/ไม่มี S อีกครั้ง) */
async function replyDetail(t: DetailTarget): Promise<void> {
  const reply = (text: string) =>
    replyAndLog({ replyToken: t.replyToken, text, targetType: t.targetType, targetId: t.targetId, sentBy: t.sentBy })

  if (!config.storeAbsence.configured) {
    await reply('ยังไม่ได้เชื่อมต่อระบบ Store (STORE_MCP_USERNAME / STORE_MCP_PASSWORD) จึงเปิดรายละเอียดไม่ได้')
    return
  }

  try {
    const pageSize = Math.max(10, config.storeAbsence.linesPerPerson)
    let code = t.empCode
    let res = await getEmployeeBacklog(code, pageSize)
    if ((res.result?.items ?? []).length === 0) {
      const other = code === baseCode(code) ? `S${code}` : baseCode(code)
      const alt = await getEmployeeBacklog(other, pageSize)
      if ((alt.result?.items ?? []).length > 0) {
        code = other
        res = alt
      }
    }
    const rows = res.result?.items ?? []
    const name = rows.find((r) => r.empName)?.empName ?? `รหัส ${t.empCode}`
    const location = t.location ?? (rows.some((r) => /site/i.test(r.locationName ?? '')) ? 'Site' : 'Workshop')
    const total = res.result?.totalCount ?? rows.length
    await replyAndLog({
      replyToken: t.replyToken,
      kind: 'flex',
      text: (rows.length > 0 ? `📦 ของค้างคืนของ ${name} (${code}) ${total} รายการ` : `📦 ${code} ไม่มีของค้างคืนกับ Store`).slice(0, 400),
      contents: flexAbsenceStoreDetail(
        {
          empCode: code,
          name,
          location,
          daysAbsent: t.daysAbsent ?? 0,
          lastScan: t.lastScan ?? '',
          items: [...rows].sort((a, b) => (b.daysOut ?? 0) - (a.daysOut ?? 0)),
          total,
          counted: res.counted,
          project: res.project
        },
        config.storeAbsence.webUrl
      ),
      targetType: t.targetType,
      targetId: t.targetId,
      sentBy: t.sentBy
    })
    console.log(`[absence-store] ของค้าง ${code}: ${total} รายการ -> ${t.targetType} ${t.targetId ?? ''}`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[absence-store] เปิดรายละเอียด ${t.empCode} ไม่สำเร็จ:`, message)
    await reply(
      err instanceof StoreMcpError && /NO_PERMISSION/.test(message)
        ? 'บัญชีที่เชื่อมกับ Store ไม่มีสิทธิ์เปิด Employee Backlogs แจ้ง System Admin'
        : 'ดึงข้อมูลจากระบบ Store ไม่ได้ในขณะนี้ ลองใหม่อีกครั้ง หรือเปิดดูในหน้า Store Control'
    )
  }
}

// ── 1. ปุ่ม › บนการ์ด ───────────────────────────────────────────────────────

export interface AbsenceStorePostbackInput {
  data: string
  replyToken: string
  targetType: 'group' | 'user'
  targetId?: string
}

/** true = จัดการ postback นี้แล้ว (เป็นของการ์ดนี้) */
export async function handleAbsenceStorePostback(input: AbsenceStorePostbackInput): Promise<boolean> {
  const pb = parseAbsenceStorePostback(input.data)
  if (!pb) return false
  await replyDetail({ ...input, ...pb, sentBy: 'absence-store:detail' })
  return true
}

// ── 2. พิมพ์ถาม "ดูของค้างคืน 69-2-073" ─────────────────────────────────────

export interface BacklogQuestionInput {
  text: string
  replyToken: string
  targetType: 'group' | 'user'
  /** groupId หรือ userId */
  targetId: string
  /** ผู้พิมพ์ (แชท 1:1 ใช้ตรวจว่าเป็นรหัสของตัวเอง) */
  userId?: string
  /** พิมพ์ @บอท นำหน้า (กลุ่มที่ไม่มีสิทธิ์จะได้คำตอบปฏิเสธแทนการเงียบ) */
  addressed?: boolean
}

/** true = ข้อความนี้เป็นคำถามของค้างและตอบแล้ว (หรือเงียบโดยตั้งใจในกลุ่มที่ไม่มีสิทธิ์) */
export async function handleBacklogQuestion(input: BacklogQuestionInput): Promise<boolean> {
  const empCode = parseBacklogQuestion(input.text)
  if (!empCode) return false
  const base = { replyToken: input.replyToken, targetType: input.targetType, targetId: input.targetId }

  if (input.targetType === 'group') {
    if (!backlogQueryGroupIds().includes(input.targetId)) {
      if (input.addressed) {
        await replyAndLog({ ...base, text: 'ดูของค้างคืนของพนักงานได้ในกลุ่ม Store หรือพิมพ์ถามของตัวเองในแชทส่วนตัวกับบอท', sentBy: 'absence-store:denied' })
      }
      console.log(`[absence-store] ไม่ตอบ "${input.text}" ในกลุ่ม ${input.targetId} (ไม่ใช่กลุ่ม Store)`)
      return input.addressed === true
    }
    await replyDetail({ ...base, empCode, sentBy: 'absence-store:question' })
    return true
  }

  // แชท 1:1: ผู้ใช้ใน ABSENCE_STORE_QUERY_USER_IDS ถามของใครก็ได้ คนอื่นต้องยืนยันตัวตนแล้ว และดูได้เฉพาะรหัสของตัวเอง
  const userId = input.userId ?? input.targetId
  if (config.storeAbsence.queryUserIds.includes(userId)) {
    await replyDetail({ ...base, empCode, sentBy: 'absence-store:question' })
    return true
  }
  const link = await getEmployeeLink(userId)
  if (!link || !isVerifiedLink(link)) {
    await replyVerifyCard({ text: input.text, replyToken: input.replyToken, userId })
    return true
  }
  if (baseCode(link.prs_no.trim()).toLowerCase() !== baseCode(empCode).toLowerCase()) {
    await replyAndLog({
      ...base,
      text: `ในแชทส่วนตัวดูได้เฉพาะของค้างคืนของตัวเอง (${link.prs_no}) ถ้าต้องการดูของคนอื่น ให้ถามในกลุ่ม Store`,
      sentBy: 'absence-store:denied'
    })
    return true
  }
  await replyDetail({ ...base, empCode, sentBy: 'absence-store:question' })
  return true
}
