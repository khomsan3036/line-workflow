import { dayOfWeek, formatThaiDateShort, nowTimeLocal, type DatePeriod, type PeriodKey } from './attendanceQuery'
import { isLeaveShiftCode, type EmployeeInfo, type TimeRecord } from './manpowerApi'

// ---------------------------------------------------------------------------
// Flex Message "เวลาเข้างานของฉัน" (time attendance รายบุคคล)
//
// แนวคิดดีไซน์
//   - วันเดียว: เวลาเข้า/ออกตัวใหญ่สองช่อง + ป้ายสถานะสีเดียวบอกว่าวันนี้โอเคไหม
//   - หลายวัน: การ์ดสรุป (มาทำงาน/สาย/ไม่พบสแกน) แล้วตามด้วยรายวันแบบอ่านไล่ได้เร็ว
//   - ปุ่มด้านล่าง + quick reply สลับช่วงเวลาได้โดยไม่ต้องพิมพ์
// ทดลองแก้ดีไซน์ได้ที่ https://developers.line.biz/flex-simulator/
//
// กติกาเรื่องอ่านง่ายบนมือถือ (บทเรียนจากการ์ดรุ่นแรกที่พนักงานบอกว่า "สถานะอ่านไม่ออก")
//   - ป้ายสถานะใช้พื้นอ่อน + ตัวอักษรสีเข้มโทนเดียวกัน (contrast > 4.5:1) ไม่ใช้ตัวขาวบนเขียว/เหลืองสด
//   - ตัวอักษรเล็กสุดคือ xs และสีจางสุดคือ MUTED (#6B7280) ไม่ใช้ #9CA3AF กับข้อความที่ต้องอ่าน
//   - ข้อความสถานะทุกชิ้น wrap: true และป้ายอยู่บนแถวของตัวเองพร้อม filler ไม่ให้ถูกตัดเป็น "..."
//   - ไม่ใช้ alignItems (LINE for PC เรนเดอร์เพี้ยน) ใช้ padding/gravity แทน
// ---------------------------------------------------------------------------

const NAVY = '#0C1628'
const GREEN = '#06C755'
const INK = '#111827'
const MUTED = '#6B7280'
const TRACK = '#E5E7EB'
const CARD = '#F8FAFC'
const GREEN_SOFT = '#ECFDF5'

// สีตัวอักษรโทนเข้มสำหรับตัวเลข/สถานะบนพื้นขาว (อ่านชัดบนมือถือ)
const GREEN_INK = '#047857'
const RED_INK = '#B91C1C'
const AMBER_INK = '#B45309'
const BLUE_INK = '#1D4ED8'
const PURPLE_INK = '#6D28D9'
const GRAY_INK = '#4B5563'

/** คู่สีของป้ายสถานะ: พื้นอ่อน + ตัวอักษรเข้มโทนเดียวกัน */
interface Tone {
  bg: string
  fg: string
}
const TONE_GREEN: Tone = { bg: GREEN_SOFT, fg: GREEN_INK }
const TONE_RED: Tone = { bg: '#FEF2F2', fg: RED_INK }
const TONE_AMBER: Tone = { bg: '#FFFBEB', fg: AMBER_INK }
const TONE_BLUE: Tone = { bg: '#EFF6FF', fg: BLUE_INK }
const TONE_PURPLE: Tone = { bg: '#F5F3FF', fg: PURPLE_INK }
const TONE_GRAY: Tone = { bg: '#F3F4F6', fg: GRAY_INK }

export type DayStatus = 'ok' | 'late' | 'noOut' | 'inProgress' | 'noLog' | 'dayOff' | 'leave'

export interface DayView {
  record: TimeRecord
  status: DayStatus
  /** นาทีที่สาย (เมื่อ status = late) */
  lateMinutes: number
  /** ชั่วโมงทำงานจริงจากเวลาสแกน (นาที) */
  workedMinutes: number | null
}

const STATUS_META: Record<DayStatus, { label: string; tone: Tone }> = {
  ok: { label: 'ปกติ', tone: TONE_GREEN },
  late: { label: 'สาย', tone: TONE_RED },
  noOut: { label: 'ไม่ได้สแกนออก', tone: TONE_AMBER },
  inProgress: { label: 'กำลังทำงาน', tone: TONE_BLUE },
  noLog: { label: 'ไม่พบการสแกน', tone: TONE_AMBER },
  dayOff: { label: 'วันหยุด', tone: TONE_GRAY },
  leave: { label: 'ลา', tone: TONE_PURPLE }
}

const PERIOD_PHRASES: Record<PeriodKey, string> = {
  today: 'วันนี้',
  yesterday: 'เมื่อวาน',
  thisWeek: 'อาทิตย์นี้',
  lastWeek: 'อาทิตย์ที่แล้ว',
  thisMonth: 'เดือนนี้',
  lastMonth: 'เดือนที่แล้ว',
  date: ''
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

function minutesLabel(total: number): string {
  const h = Math.floor(total / 60)
  const m = total % 60
  if (h === 0) return `${m} นาที`
  return m === 0 ? `${h} ชม.` : `${h} ชม. ${m} น.`
}

function queryText(period: string): string {
  return `เวลาเข้างานของฉัน ${period}`.trim()
}

// ---------------------------------------------------------------------------
// ประเมินสถานะของแต่ละวัน
// ---------------------------------------------------------------------------

export function evaluateDay(record: TimeRecord, today: string): DayView {
  const base = { record, lateMinutes: 0, workedMinutes: null as number | null }

  if (record.leave) return { ...base, status: 'leave' }

  if (!record.hasLog || !record.stampIn) {
    const weekend = dayOfWeek(record.date) === 0 || dayOfWeek(record.date) === 6
    return { ...base, status: weekend ? 'dayOff' : 'noLog' }
  }

  const lateMinutes = record.shiftStart ? Math.max(0, toMinutes(record.stampIn) - toMinutes(record.shiftStart)) : 0
  const workedMinutes = record.stampOut ? Math.max(0, toMinutes(record.stampOut) - toMinutes(record.stampIn)) : null

  if (!record.stampOut) {
    return { ...base, lateMinutes, status: record.date === today ? 'inProgress' : 'noOut' }
  }
  return { ...base, lateMinutes, workedMinutes, status: lateMinutes > 0 ? 'late' : 'ok' }
}

function statusLabel(view: DayView): string {
  const meta = STATUS_META[view.status]
  if (view.status === 'late') return `สาย ${view.lateMinutes} นาที`
  // บอกประเภทการลาตามรหัสกะของ bPlus เช่น "ลากิจจ่าย" แทนคำว่า "ลา" เฉย ๆ
  if (view.status === 'leave' && isLeaveShiftCode(view.record.shiftCode)) return view.record.shiftCode!.trim()
  if (view.status === 'inProgress' && view.lateMinutes > 0) return `กำลังทำงาน · สาย ${view.lateMinutes} น.`
  if (view.status === 'noOut' && view.lateMinutes > 0) return `ไม่ได้สแกนออก · สาย ${view.lateMinutes} น.`
  return meta.label
}

// ---------------------------------------------------------------------------
// ชิ้นส่วนย่อย
// ---------------------------------------------------------------------------

/**
 * ป้ายสถานะ (pill) - พื้นอ่อน ตัวอักษรเข้ม ขนาด sm และ wrap ได้
 * ใช้คู่กับ chipRow() เสมอ เพื่อให้ป้ายกว้างเท่าข้อความและไม่ถูกตัดเป็น "..."
 */
function chip(text: string, tone: Tone, size: 'xs' | 'sm' = 'sm') {
  return {
    type: 'box',
    layout: 'vertical',
    backgroundColor: tone.bg,
    cornerRadius: '999px',
    paddingStart: '12px',
    paddingEnd: '12px',
    paddingTop: '5px',
    paddingBottom: '5px',
    flex: 0,
    contents: [{ type: 'text', text, size, color: tone.fg, weight: 'bold', wrap: true }]
  }
}

/** แถวที่มีป้ายชิดซ้าย: filler กินพื้นที่ที่เหลือ ป้ายจึงกว้างเท่าข้อความ (ไม่ยืดเต็มแถว) */
function chipRow(chipBox: unknown, margin = 'sm') {
  return { type: 'box', layout: 'horizontal', margin, contents: [chipBox, { type: 'filler' }] }
}

function sectionTitle(text: string) {
  return { type: 'text', text, size: 'xs', color: MUTED, weight: 'bold', margin: 'lg', wrap: true }
}

function statCell(label: string, value: string, valueColor = INK) {
  return {
    type: 'box',
    layout: 'vertical',
    flex: 1,
    contents: [
      { type: 'text', text: value, size: 'sm', weight: 'bold', color: valueColor, align: 'center', wrap: true },
      { type: 'text', text: label, size: 'xs', color: MUTED, align: 'center', margin: 'xs', wrap: true }
    ]
  }
}

function header(employee: EmployeeInfo, period: DatePeriod) {
  const role = [employee.position, employee.dept].filter(Boolean).join(' · ')
  return {
    type: 'box',
    layout: 'vertical',
    backgroundColor: NAVY,
    paddingAll: '18px',
    spacing: 'xs',
    contents: [
      {
        type: 'box',
        layout: 'horizontal',
        contents: [
          { type: 'text', text: 'เวลาเข้างานของฉัน', size: 'xs', color: '#CBD5E1', weight: 'bold', flex: 1, gravity: 'center', wrap: true },
          chip(employee.prsNo, { bg: '#1E293B', fg: '#FFFFFF' }, 'xs')
        ]
      },
      { type: 'text', text: employee.fullName, size: 'lg', weight: 'bold', color: '#FFFFFF', wrap: true },
      ...(role ? [{ type: 'text', text: role, size: 'xs', color: '#CBD5E1', wrap: true }] : []),
      { type: 'text', text: period.label, size: 'xs', color: '#94A3B8', wrap: true, margin: 'sm' }
    ]
  }
}

function timeCell(label: string, value: string | null, shift: string | null, color: string) {
  return {
    type: 'box',
    layout: 'vertical',
    flex: 1,
    backgroundColor: CARD,
    cornerRadius: '12px',
    paddingAll: '14px',
    contents: [
      { type: 'text', text: label, size: 'xs', color: MUTED, wrap: true },
      { type: 'text', text: value ?? '--:--', size: 'xxl', weight: 'bold', color: value ? color : MUTED, margin: 'xs' },
      { type: 'text', text: shift ? `กะ ${shift}` : ' ', size: 'xs', color: MUTED, margin: 'xs', wrap: true }
    ]
  }
}

function noteBox(text: string) {
  return {
    type: 'box',
    layout: 'baseline',
    backgroundColor: GREEN_SOFT,
    cornerRadius: '8px',
    paddingAll: '10px',
    margin: 'lg',
    contents: [{ type: 'text', text, size: 'xs', color: GREEN_INK, wrap: true }]
  }
}

function footerButtons(period: DatePeriod) {
  const candidates: PeriodKey[] = ['today', 'yesterday', 'thisWeek', 'thisMonth']
  const others = candidates.filter((k) => k !== period.key).slice(0, 3)
  return {
    type: 'box',
    layout: 'horizontal',
    spacing: 'sm',
    paddingAll: '12px',
    contents: others.map((k) => ({
      type: 'button',
      style: 'secondary',
      height: 'sm',
      color: '#F1F5F9',
      action: { type: 'message', label: PERIOD_PHRASES[k], text: queryText(PERIOD_PHRASES[k]) }
    }))
  }
}

function footerNote() {
  return {
    type: 'text',
    text: `ข้อมูล ณ ${nowTimeLocal()} น. · จากระบบ HR`,
    size: 'xs',
    color: MUTED,
    margin: 'md',
    wrap: true
  }
}

// ---------------------------------------------------------------------------
// วันเดียว
// ---------------------------------------------------------------------------

export function flexMyAttendanceDay(
  employee: EmployeeInfo,
  period: DatePeriod,
  view: DayView,
  note?: string
) {
  const { record } = view
  const meta = STATUS_META[view.status]
  const scanned = record.scans.length > 0 ? record.scans.join(' · ') : record.stampIn ? [record.stampIn, record.stampOut].filter(Boolean).join(' · ') : '-'

  // ป้ายสถานะอยู่แถวของตัวเองใต้หัวข้อ จะได้มีความกว้างเต็มการ์ดสำหรับป้ายยาว ๆ เช่น "ไม่ได้สแกนออก · สาย 12 น."
  const body: unknown[] = [
    { type: 'text', text: 'สถานะวันนี้', size: 'xs', color: MUTED, wrap: true },
    chipRow(chip(statusLabel(view), meta.tone)),
    {
      type: 'box',
      layout: 'horizontal',
      spacing: 'md',
      margin: 'lg',
      contents: [
        timeCell('สแกนเข้า', record.stampIn, record.shiftStart, view.lateMinutes > 0 ? RED_INK : GREEN),
        timeCell('สแกนออก', record.stampOut, record.shiftEnd, record.stampOut ? INK : MUTED)
      ]
    },
    {
      type: 'box',
      layout: 'horizontal',
      margin: 'lg',
      contents: [
        statCell('ชั่วโมงทำงาน', view.workedMinutes !== null ? minutesLabel(view.workedMinutes) : '-'),
        statCell('กะทำงาน', record.shiftCode ?? '-'),
        statCell('สแกนทั้งหมด', `${record.scans.length || (record.stampIn ? 1 : 0)} ครั้ง`)
      ]
    },
    sectionTitle('เวลาสแกน'),
    { type: 'text', text: scanned, size: 'sm', color: INK, wrap: true, margin: 'sm' }
  ]

  if (view.status === 'noLog') {
    body.push({
      type: 'text',
      text: 'ไม่พบการสแกนในวันนี้ ถ้ามาทำงานแต่ลืมสแกน แจ้งฝ่ายบุคคล ต่อ 101 ได้เลยครับ',
      size: 'xs',
      color: MUTED,
      wrap: true,
      margin: 'md'
    })
  }
  if (record.remark) {
    body.push({ type: 'text', text: `หมายเหตุ: ${record.remark}`, size: 'xs', color: MUTED, wrap: true, margin: 'md' })
  }
  if (note) body.push(noteBox(note))

  body.push({ type: 'separator', margin: 'lg', color: TRACK })
  body.push(footerNote())

  return {
    type: 'bubble',
    size: 'mega',
    header: header(employee, period),
    body: { type: 'box', layout: 'vertical', paddingAll: '18px', contents: body },
    footer: footerButtons(period),
    styles: { footer: { separator: true, separatorColor: TRACK } }
  }
}

// ---------------------------------------------------------------------------
// หลายวัน (สัปดาห์ / เดือน)
// ---------------------------------------------------------------------------

function dayRow(view: DayView) {
  const { record } = view
  const meta = STATUS_META[view.status]
  const quiet = view.status === 'dayOff'
  const times = record.stampIn ? `${record.stampIn} - ${record.stampOut ?? '--:--'}` : '-'
  return {
    type: 'box',
    layout: 'horizontal',
    margin: 'md',
    contents: [
      { type: 'text', text: formatThaiDateShort(record.date), size: 'xs', color: quiet ? MUTED : INK, flex: 3, gravity: 'center', wrap: true },
      { type: 'text', text: times, size: 'xs', color: quiet ? MUTED : INK, weight: quiet ? 'regular' : 'bold', flex: 4, gravity: 'center' },
      {
        type: 'text',
        text: statusLabel(view),
        size: 'xs',
        color: meta.tone.fg,
        weight: 'bold',
        align: 'end',
        gravity: 'center',
        flex: 4,
        wrap: true
      }
    ]
  }
}

export function flexMyAttendanceRange(
  employee: EmployeeInfo,
  period: DatePeriod,
  views: DayView[],
  note?: string
) {
  const worked = views.filter((v) => ['ok', 'late', 'noOut', 'inProgress'].includes(v.status))
  const late = views.filter((v) => v.lateMinutes > 0)
  const missing = views.filter((v) => v.status === 'noLog')
  const dayOff = views.filter((v) => v.status === 'dayOff')

  // เดือน: ซ่อนวันหยุดที่ไม่มีสแกน ให้รายการสั้นลง (บอกจำนวนไว้ในบรรทัดสรุปแทน)
  const compact = views.length > 10
  const rows = (compact ? views.filter((v) => v.status !== 'dayOff') : views).map(dayRow)

  const body: unknown[] = [
    {
      type: 'box',
      layout: 'horizontal',
      backgroundColor: CARD,
      cornerRadius: '10px',
      paddingAll: '12px',
      contents: [
        statCell('มาทำงาน', `${worked.length} วัน`, GREEN_INK),
        statCell('สาย', `${late.length} ครั้ง`, late.length > 0 ? RED_INK : INK),
        statCell('ไม่พบสแกน', `${missing.length} วัน`, missing.length > 0 ? AMBER_INK : INK)
      ]
    },
    sectionTitle(compact && dayOff.length > 0 ? `รายวัน (ไม่แสดงวันหยุด ${dayOff.length} วัน)` : 'รายวัน'),
    ...rows
  ]

  if (rows.length === 0) {
    body.push({ type: 'text', text: 'ยังไม่มีข้อมูลในช่วงนี้', size: 'sm', color: MUTED, margin: 'sm', wrap: true })
  }
  if (note) body.push(noteBox(note))
  body.push({ type: 'separator', margin: 'lg', color: TRACK })
  body.push(footerNote())

  return {
    type: 'bubble',
    size: 'mega',
    header: header(employee, period),
    body: { type: 'box', layout: 'vertical', paddingAll: '18px', contents: body },
    footer: footerButtons(period),
    styles: { footer: { separator: true, separatorColor: TRACK } }
  }
}

// ---------------------------------------------------------------------------
// altText + quick reply
// ---------------------------------------------------------------------------

export function myAttendanceAltText(employee: EmployeeInfo, period: DatePeriod, views: DayView[]): string {
  if (period.single && views[0]) {
    const v = views[0]
    const times = v.record.stampIn ? `เข้า ${v.record.stampIn} ออก ${v.record.stampOut ?? '-'}` : 'ไม่พบการสแกน'
    return `เวลาเข้างาน ${period.label}: ${times} (${statusLabel(v)})`
  }
  const worked = views.filter((v) => ['ok', 'late', 'noOut', 'inProgress'].includes(v.status)).length
  const late = views.filter((v) => v.lateMinutes > 0).length
  return `เวลาเข้างาน ${period.label}: มาทำงาน ${worked} วัน สาย ${late} ครั้ง`
}

export function myAttendanceQuickReply(period: DatePeriod) {
  // ปุ่มแรกเสมอ = "เวลาเข้างานของฉัน" (วันนี้) ตามด้วยช่วงเวลาอื่น เริ่มจาก "เมื่อวาน"
  const items: unknown[] = [
    { type: 'action', action: { type: 'message', label: 'เวลาเข้างานของฉัน', text: queryText('วันนี้') } }
  ]
  const periods: PeriodKey[] = ['yesterday', 'thisWeek', 'lastWeek', 'thisMonth', 'lastMonth']
  for (const k of periods) {
    if (k === period.key) continue
    items.push({ type: 'action', action: { type: 'message', label: PERIOD_PHRASES[k], text: queryText(PERIOD_PHRASES[k]) } })
  }
  items.push({ type: 'action', action: { type: 'message', label: 'สรุปพนักงานทั้งหมด', text: 'สรุปพนักงาน วันนี้' } })
  return { items }
}

// ---------------------------------------------------------------------------
// การ์ด "ยืนยันตัวตน" ส่งเมื่อผู้ใช้ยังไม่ได้ผูกรหัสพนักงานผ่าน LINE Login
// ปุ่มเป็น uri action เปิดหน้า /line-login/start ในเบราว์เซอร์ของ LINE
// ---------------------------------------------------------------------------

export interface VerifyCardOptions {
  /** ลิงก์ปุ่มยืนยันตัวตน (มี state ใช้ครั้งเดียว) */
  url: string
  /** หัวเรื่อง เช่น "ยินดีต้อนรับ" ตอนเพิ่มเพื่อน หรือ "ยืนยันตัวตนก่อน" ตอนถามเวลาเข้างาน */
  title: string
  /** ข้อความอธิบาย (บรรทัดละ 1 รายการ) */
  lines: string[]
  /** ข้อความเล็กท้ายการ์ด */
  footnote?: string
}

export function flexVerifyIdentity(opts: VerifyCardOptions) {
  return {
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: NAVY,
      paddingAll: '20px',
      contents: [
        { type: 'text', text: 'HR NOTIFICATION', size: 'xs', color: '#A5B4FC', weight: 'bold', wrap: true },
        { type: 'text', text: opts.title, size: 'xl', color: '#FFFFFF', weight: 'bold', margin: 'sm', wrap: true }
      ]
    },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'md',
      paddingAll: '20px',
      contents: [
        ...opts.lines.map((text) => ({ type: 'text', text, size: 'sm', color: INK, wrap: true })),
        {
          type: 'box',
          layout: 'vertical',
          backgroundColor: GREEN_SOFT,
          cornerRadius: 'md',
          paddingAll: '12px',
          margin: 'md',
          contents: [
            { type: 'text', text: 'ทำไมต้องยืนยัน', size: 'xs', color: GREEN_INK, weight: 'bold', wrap: true },
            {
              type: 'text',
              text: 'ข้อมูลเวลาเข้า-ออกเป็นข้อมูลส่วนบุคคล บอทจะแสดงให้เฉพาะเจ้าของรหัสพนักงานที่ยืนยันแล้วเท่านั้น',
              size: 'xs',
              color: MUTED,
              wrap: true,
              margin: 'xs'
            }
          ]
        }
      ]
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      paddingAll: '16px',
      contents: [
        {
          type: 'button',
          style: 'primary',
          color: GREEN,
          height: 'sm',
          action: { type: 'uri', label: 'ยืนยันตัวตนด้วย LINE', uri: opts.url }
        },
        ...(opts.footnote
          ? [{ type: 'text', text: opts.footnote, size: 'xs', color: MUTED, wrap: true, align: 'center', margin: 'sm' }]
          : [])
      ]
    }
  }
}
