import { dayOfWeek, formatThaiDateShort, nowTimeLocal, type DatePeriod, type PeriodKey } from './attendanceQuery'
import type { EmployeeInfo, TimeRecord } from './manpowerApi'

// ---------------------------------------------------------------------------
// Flex Message "เวลาเข้างานของฉัน" (time attendance รายบุคคล)
//
// แนวคิดดีไซน์
//   - วันเดียว: เวลาเข้า/ออกตัวใหญ่สองช่อง + ป้ายสถานะสีเดียวบอกว่าวันนี้โอเคไหม
//   - หลายวัน: การ์ดสรุป (มาทำงาน/สาย/ไม่พบสแกน) แล้วตามด้วยรายวันแบบอ่านไล่ได้เร็ว
//   - ปุ่มด้านล่าง + quick reply สลับช่วงเวลาได้โดยไม่ต้องพิมพ์
// ทดลองแก้ดีไซน์ได้ที่ https://developers.line.biz/flex-simulator/
// ---------------------------------------------------------------------------

const NAVY = '#0C1628'
const GREEN = '#06C755'
const RED = '#DC2626'
const AMBER = '#F59E0B'
const BLUE = '#3B82F6'
const PURPLE = '#7C3AED'
const INK = '#111827'
const MUTED = '#6B7280'
const FAINT = '#9CA3AF'
const TRACK = '#E5E7EB'
const CARD = '#F8FAFC'
const GREEN_SOFT = '#ECFDF5'

export type DayStatus = 'ok' | 'late' | 'noOut' | 'inProgress' | 'noLog' | 'dayOff' | 'leave'

export interface DayView {
  record: TimeRecord
  status: DayStatus
  /** นาทีที่สาย (เมื่อ status = late) */
  lateMinutes: number
  /** ชั่วโมงทำงานจริงจากเวลาสแกน (นาที) */
  workedMinutes: number | null
}

const STATUS_META: Record<DayStatus, { label: string; color: string }> = {
  ok: { label: 'ปกติ', color: GREEN },
  late: { label: 'สาย', color: RED },
  noOut: { label: 'ไม่ได้สแกนออก', color: AMBER },
  inProgress: { label: 'กำลังทำงาน', color: BLUE },
  noLog: { label: 'ไม่พบการสแกน', color: AMBER },
  dayOff: { label: 'วันหยุด', color: FAINT },
  leave: { label: 'ลา', color: PURPLE }
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
  if (view.status === 'inProgress' && view.lateMinutes > 0) return `กำลังทำงาน · สาย ${view.lateMinutes} น.`
  if (view.status === 'noOut' && view.lateMinutes > 0) return `ไม่ได้สแกนออก · สาย ${view.lateMinutes} น.`
  return meta.label
}

// ---------------------------------------------------------------------------
// ชิ้นส่วนย่อย
// ---------------------------------------------------------------------------

function chip(text: string, color: string) {
  return {
    type: 'box',
    layout: 'baseline',
    backgroundColor: color,
    cornerRadius: '999px',
    paddingStart: '10px',
    paddingEnd: '10px',
    paddingTop: '4px',
    paddingBottom: '4px',
    flex: 0,
    contents: [{ type: 'text', text, size: 'xs', color: '#FFFFFF', weight: 'bold' }]
  }
}

function sectionTitle(text: string) {
  return { type: 'text', text, size: 'xs', color: FAINT, weight: 'bold', margin: 'lg' }
}

function statCell(label: string, value: string, valueColor = INK) {
  return {
    type: 'box',
    layout: 'vertical',
    flex: 1,
    contents: [
      { type: 'text', text: value, size: 'sm', weight: 'bold', color: valueColor, align: 'center' },
      { type: 'text', text: label, size: 'xxs', color: MUTED, align: 'center', margin: 'xs' }
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
        alignItems: 'center',
        contents: [
          { type: 'text', text: 'เวลาเข้างานของฉัน', size: 'xxs', color: '#94A3B8', weight: 'bold', flex: 1 },
          chip(employee.prsNo, '#1E293B')
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
      { type: 'text', text: label, size: 'xs', color: MUTED },
      { type: 'text', text: value ?? '--:--', size: 'xxl', weight: 'bold', color: value ? color : FAINT, margin: 'xs' },
      { type: 'text', text: shift ? `กะ ${shift}` : ' ', size: 'xxs', color: FAINT, margin: 'xs' }
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
    contents: [{ type: 'text', text, size: 'xs', color: '#047857', wrap: true }]
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
    size: 'xxs',
    color: FAINT,
    margin: 'md'
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

  const body: unknown[] = [
    {
      type: 'box',
      layout: 'horizontal',
      alignItems: 'center',
      contents: [
        { type: 'text', text: 'สถานะวันนี้', size: 'sm', color: MUTED, flex: 1 },
        chip(statusLabel(view), meta.color)
      ]
    },
    {
      type: 'box',
      layout: 'horizontal',
      spacing: 'md',
      margin: 'lg',
      contents: [
        timeCell('สแกนเข้า', record.stampIn, record.shiftStart, view.lateMinutes > 0 ? RED : GREEN),
        timeCell('สแกนออก', record.stampOut, record.shiftEnd, record.stampOut ? INK : FAINT)
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
    alignItems: 'center',
    margin: 'sm',
    contents: [
      { type: 'text', text: formatThaiDateShort(record.date), size: 'xs', color: quiet ? FAINT : INK, flex: 3 },
      { type: 'text', text: times, size: 'xs', color: quiet ? FAINT : INK, weight: quiet ? 'regular' : 'bold', flex: 4 },
      {
        type: 'text',
        text: statusLabel(view),
        size: 'xxs',
        color: meta.color,
        weight: 'bold',
        align: 'end',
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
        statCell('มาทำงาน', `${worked.length} วัน`, GREEN),
        statCell('สาย', `${late.length} ครั้ง`, late.length > 0 ? RED : INK),
        statCell('ไม่พบสแกน', `${missing.length} วัน`, missing.length > 0 ? AMBER : INK)
      ]
    },
    sectionTitle(compact && dayOff.length > 0 ? `รายวัน (ไม่แสดงวันหยุด ${dayOff.length} วัน)` : 'รายวัน'),
    ...rows
  ]

  if (rows.length === 0) {
    body.push({ type: 'text', text: 'ยังไม่มีข้อมูลในช่วงนี้', size: 'sm', color: MUTED, margin: 'sm' })
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
