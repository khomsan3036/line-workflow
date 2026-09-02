import type { AttendanceSummary, DayStat, LocationStat } from './attendance'
import {
  LOCATION_LABELS,
  formatThaiDateShort,
  nowTimeLocal,
  type AttendanceQuery,
  type LocationFilter,
  type PeriodKey
} from './attendanceQuery'

// ---------------------------------------------------------------------------
// Flex Message สำหรับสรุปพนักงานเข้างาน (ข้อมูลจากเครื่องสแกนนิ้ว)
//
// แนวคิดดีไซน์
//   - ตัวเลขใหญ่ตัวเดียวตอบคำถามหลัก "วันนี้มากี่คน" ทันทีที่เปิดอ่าน
//   - แถบสัดส่วนช่วยให้เทียบสถานที่ / วันในสัปดาห์ได้โดยไม่ต้องอ่านตัวเลขทุกตัว
//   - ปุ่มด้านล่าง + quick reply ให้กดถามช่วงอื่น/สถานที่อื่นต่อได้โดยไม่ต้องพิมพ์
// ทดลองแก้ดีไซน์ได้ที่ https://developers.line.biz/flex-simulator/
// ---------------------------------------------------------------------------

const NAVY = '#0C1628'
const NAVY_SOFT = '#1E293B'
const GREEN = '#06C755'
const BLUE = '#3B82F6'
const AMBER = '#F59E0B'
const INK = '#111827'
const MUTED = '#6B7280'
const FAINT = '#9CA3AF'
const TRACK = '#E5E7EB'
const CARD = '#F8FAFC'

const LOCATION_COLORS: Record<string, string> = {
  Workshop: GREEN,
  Site: BLUE
}

function fmt(n: number): string {
  return n.toLocaleString('en-US')
}

function pct(part: number, whole: number): number {
  if (whole <= 0) return 0
  return Math.max(2, Math.round((part / whole) * 100))
}

function locationColor(name: string): string {
  return LOCATION_COLORS[name] ?? AMBER
}

/** วลีที่ parser เข้าใจ ใช้ประกอบข้อความของปุ่ม */
const PERIOD_PHRASES: Record<PeriodKey, string> = {
  today: 'วันนี้',
  yesterday: 'เมื่อวาน',
  thisWeek: 'อาทิตย์นี้',
  lastWeek: 'อาทิตย์ที่แล้ว',
  thisMonth: 'เดือนนี้',
  lastMonth: 'เดือนที่แล้ว',
  date: ''
}

function periodPhrase(query: AttendanceQuery): string {
  if (query.period.key !== 'date') return PERIOD_PHRASES[query.period.key]
  const [y, m, d] = query.period.start.split('-')
  return `${Number(d)}/${Number(m)}/${y}`
}

function locationPhrase(location: LocationFilter): string {
  return location === 'all' ? '' : ` ${location.toLowerCase()}`
}

function queryText(period: string, location: LocationFilter): string {
  return `สรุปพนักงาน ${period}${locationPhrase(location)}`.trim()
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
    paddingTop: '3px',
    paddingBottom: '3px',
    flex: 0,
    contents: [{ type: 'text', text, size: 'xxs', color: '#FFFFFF', weight: 'bold' }]
  }
}

function bar(percent: number, color: string) {
  return {
    type: 'box',
    layout: 'vertical',
    backgroundColor: TRACK,
    height: '6px',
    cornerRadius: '3px',
    margin: 'sm',
    contents: [
      {
        type: 'box',
        layout: 'vertical',
        width: `${percent}%`,
        height: '6px',
        backgroundColor: color,
        cornerRadius: '3px',
        contents: []
      }
    ]
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

function header(summary: AttendanceSummary) {
  const { query } = summary
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
          { type: 'text', text: 'สรุปการเข้างาน', size: 'xxs', color: '#94A3B8', weight: 'bold', flex: 1 },
          chip(LOCATION_LABELS[query.location], query.location === 'all' ? NAVY_SOFT : locationColor(query.location))
        ]
      },
      { type: 'text', text: 'พนักงานสแกนเข้างาน', size: 'lg', weight: 'bold', color: '#FFFFFF', wrap: true },
      { type: 'text', text: query.period.label, size: 'xs', color: '#CBD5E1', wrap: true }
    ]
  }
}

function heroSingleDay(summary: AttendanceSummary) {
  return {
    type: 'box',
    layout: 'vertical',
    contents: [
      {
        type: 'box',
        layout: 'baseline',
        contents: [
          { type: 'text', text: fmt(summary.totalPeople), size: '4xl', weight: 'bold', color: INK, flex: 0 },
          { type: 'text', text: 'คน', size: 'md', color: MUTED, margin: 'sm', flex: 0 }
        ]
      },
      { type: 'text', text: 'สแกนเข้างานแล้ว', size: 'sm', color: MUTED, margin: 'xs' },
      {
        type: 'box',
        layout: 'horizontal',
        margin: 'lg',
        backgroundColor: CARD,
        cornerRadius: '10px',
        paddingAll: '12px',
        contents: [
          statCell('สแกนแรก', summary.earliestIn ?? '-'),
          statCell('สแกนล่าสุด', summary.latestIn ?? '-'),
          statCell('สแกนออกแล้ว', fmt(summary.totalCheckedOut), summary.totalCheckedOut > 0 ? GREEN : INK)
        ]
      }
    ]
  }
}

function heroRange(summary: AttendanceSummary) {
  const avg = summary.activeDays > 0 ? Math.round(summary.totalPeople / summary.activeDays) : 0
  return {
    type: 'box',
    layout: 'vertical',
    contents: [
      {
        type: 'box',
        layout: 'baseline',
        contents: [
          { type: 'text', text: fmt(avg), size: '4xl', weight: 'bold', color: INK, flex: 0 },
          { type: 'text', text: 'คน/วัน', size: 'md', color: MUTED, margin: 'sm', flex: 0 }
        ]
      },
      {
        type: 'text',
        text: `เฉลี่ยจาก ${summary.activeDays} วันที่มีการสแกน`,
        size: 'sm',
        color: MUTED,
        margin: 'xs'
      },
      {
        type: 'box',
        layout: 'horizontal',
        margin: 'lg',
        backgroundColor: CARD,
        cornerRadius: '10px',
        paddingAll: '12px',
        contents: [
          statCell('รวม (คน-วัน)', fmt(summary.totalPeople)),
          statCell('พนักงานไม่ซ้ำ', fmt(summary.uniquePeople)),
          statCell('สูงสุด/วัน', fmt(Math.max(0, ...summary.days.map((d) => d.people))))
        ]
      }
    ]
  }
}

function locationRows(locations: LocationStat[], total: number) {
  return locations.map((l) => ({
    type: 'box',
    layout: 'vertical',
    margin: 'md',
    contents: [
      {
        type: 'box',
        layout: 'horizontal',
        alignItems: 'center',
        contents: [
          {
            type: 'box',
            layout: 'vertical',
            width: '10px',
            height: '10px',
            cornerRadius: '5px',
            backgroundColor: locationColor(l.location),
            flex: 0,
            contents: []
          },
          { type: 'text', text: l.location, size: 'sm', color: INK, weight: 'bold', margin: 'sm', flex: 1 },
          { type: 'text', text: `${fmt(l.people)} คน`, size: 'sm', color: INK, weight: 'bold', align: 'end', flex: 0 },
          {
            type: 'text',
            text: `${pct(l.people, total)}%`,
            size: 'xs',
            color: FAINT,
            align: 'end',
            flex: 0,
            margin: 'sm'
          }
        ]
      },
      bar(pct(l.people, total), locationColor(l.location)),
      {
        type: 'text',
        text: `สแกนแรก ${l.earliestIn ?? '-'} · ล่าสุด ${l.latestIn ?? '-'} · ออกแล้ว ${fmt(l.checkedOut)}`,
        size: 'xxs',
        color: MUTED,
        margin: 'xs'
      }
    ]
  }))
}

function dayRows(allDays: DayStat[], color: string, today: string) {
  // ไม่แสดงวันในอนาคต (สัปดาห์นี้/เดือนนี้ที่ยังมาไม่ถึง)
  const days = allDays.filter((d) => d.date <= today)
  const max = Math.max(1, ...days.map((d) => d.people))
  return days.map((d) => {
    const empty = d.people === 0
    const label = formatThaiDateShort(d.date)
    return {
      type: 'box',
      layout: 'horizontal',
      alignItems: 'center',
      margin: 'sm',
      contents: [
        { type: 'text', text: label, size: 'xs', color: empty ? FAINT : INK, flex: 3 },
        {
          type: 'box',
          layout: 'vertical',
          flex: 6,
          contents: [bar(empty ? 0 : pct(d.people, max), color)]
        },
        {
          type: 'text',
          text: empty ? 'ไม่มีข้อมูล' : fmt(d.people),
          size: 'xs',
          color: empty ? FAINT : INK,
          weight: empty ? 'regular' : 'bold',
          align: 'end',
          flex: 3
        }
      ]
    }
  })
}

const MY_ATTENDANCE_LABEL = 'เวลาเข้างานของฉัน'
const MY_ATTENDANCE_TEXT = 'เวลาเข้างานของฉัน วันนี้'

function footerButtons(query: AttendanceQuery) {
  // ปุ่มแรก = ดูเวลาเข้า-ออกของตัวเอง ตามด้วยช่วงเวลาอื่นของสรุปทั้งบริษัท
  const candidates: PeriodKey[] = ['today', 'yesterday', 'thisWeek', 'lastWeek']
  const others = candidates.filter((k) => k !== query.period.key).slice(0, 2)
  return {
    type: 'box',
    layout: 'horizontal',
    spacing: 'sm',
    paddingAll: '12px',
    contents: [
      {
        type: 'button',
        style: 'primary',
        height: 'sm',
        color: NAVY_SOFT,
        flex: 3,
        action: { type: 'message', label: MY_ATTENDANCE_LABEL, text: MY_ATTENDANCE_TEXT }
      },
      ...others.map((k) => ({
        type: 'button',
        style: 'secondary',
        height: 'sm',
        color: '#F1F5F9',
        flex: 2,
        action: {
          type: 'message',
          label: PERIOD_PHRASES[k],
          text: queryText(PERIOD_PHRASES[k], query.location)
        }
      }))
    ]
  }
}

// ---------------------------------------------------------------------------
// ส่วนประกอบหลัก
// ---------------------------------------------------------------------------

/** Flex bubble สรุปการเข้างาน */
export function flexAttendanceSummary(summary: AttendanceSummary, today: string) {
  const { query } = summary
  const single = query.period.single
  const body: unknown[] = [single ? heroSingleDay(summary) : heroRange(summary)]

  if (query.location === 'all' && summary.byLocation.length > 0) {
    body.push(sectionTitle('แยกตามสถานที่'))
    body.push(...locationRows(summary.byLocation, summary.totalPeople))
  } else if (query.location !== 'all' && single && summary.byLocation[0]) {
    const l = summary.byLocation[0]
    body.push(sectionTitle('รายละเอียด'))
    body.push({
      type: 'text',
      text: `ข้อมูลเฉพาะ ${l.location} · สแกนออกแล้ว ${fmt(l.checkedOut)} จาก ${fmt(l.people)} คน`,
      size: 'xs',
      color: MUTED,
      wrap: true,
      margin: 'sm'
    })
  }

  if (!single) {
    body.push(sectionTitle('รายวัน'))
    body.push(...dayRows(summary.days, query.location === 'all' ? NAVY_SOFT : locationColor(query.location), today))
  }

  body.push({ type: 'separator', margin: 'lg', color: TRACK })
  body.push({
    type: 'text',
    text: `ข้อมูล ณ ${nowTimeLocal()} น. · จากเครื่องสแกนนิ้ว`,
    size: 'xxs',
    color: FAINT,
    margin: 'md'
  })

  return {
    type: 'bubble',
    size: 'mega',
    header: header(summary),
    body: { type: 'box', layout: 'vertical', paddingAll: '18px', contents: body },
    footer: footerButtons(query),
    styles: { footer: { separator: true, separatorColor: TRACK } }
  }
}

/** เมื่อไม่มีข้อมูลในช่วงที่ถาม */
export function flexAttendanceEmpty(query: AttendanceQuery) {
  return {
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: NAVY,
      paddingAll: '18px',
      contents: [
        { type: 'text', text: 'สรุปการเข้างาน', size: 'xxs', color: '#94A3B8', weight: 'bold' },
        { type: 'text', text: 'ยังไม่มีข้อมูลการสแกน', size: 'lg', weight: 'bold', color: '#FFFFFF', wrap: true },
        { type: 'text', text: `${query.period.label} · ${LOCATION_LABELS[query.location]}`, size: 'xs', color: '#CBD5E1', wrap: true }
      ]
    },
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '18px',
      spacing: 'sm',
      contents: [
        { type: 'text', text: 'ยังไม่พบการสแกนเข้างานในช่วงนี้', size: 'sm', color: INK, wrap: true },
        {
          type: 'text',
          text: 'ข้อมูลจะปรากฏหลังเครื่องสแกนซิงก์เข้าระบบ (ปกติทุกไม่กี่นาที) หรือลองเลือกช่วงอื่นด้านล่าง',
          size: 'xs',
          color: MUTED,
          wrap: true
        }
      ]
    },
    footer: footerButtons(query),
    styles: { footer: { separator: true, separatorColor: TRACK } }
  }
}

/** ข้อความย่อสำหรับ notification / altText */
export function attendanceAltText(summary: AttendanceSummary): string {
  const where = summary.query.location === 'all' ? '' : ` (${summary.query.location})`
  if (summary.query.period.single) {
    return `พนักงานสแกนเข้างาน ${summary.query.period.label}${where}: ${fmt(summary.totalPeople)} คน`
  }
  const avg = summary.activeDays > 0 ? Math.round(summary.totalPeople / summary.activeDays) : 0
  return `พนักงานเข้างาน ${summary.query.period.label}${where}: เฉลี่ย ${fmt(avg)} คน/วัน`
}

/** ปุ่มลัดใต้ช่องพิมพ์ ให้สลับสถานที่/ช่วงเวลาได้ทันที */
export function attendanceQuickReply(query: AttendanceQuery) {
  const period = periodPhrase(query)
  const locations: LocationFilter[] = ['all', 'Workshop', 'Site']
  const items = locations
    .filter((l) => l !== query.location)
    .map((l) => ({
      type: 'action',
      action: {
        type: 'message',
        label: `${l === 'all' ? 'ทุกที่' : LOCATION_LABELS[l]} · ${period}`.slice(0, 20),
        text: queryText(period, l)
      }
    }))
  // "เวลาเข้างานของฉัน" อยู่ก่อนช่วงเวลาอื่น ๆ (ก่อน "เมื่อวาน")
  items.push({ type: 'action', action: { type: 'message', label: MY_ATTENDANCE_LABEL, text: MY_ATTENDANCE_TEXT } })
  const periods: PeriodKey[] = ['today', 'yesterday', 'thisWeek', 'lastWeek', 'thisMonth']
  for (const k of periods) {
    if (k === query.period.key) continue
    items.push({
      type: 'action',
      action: { type: 'message', label: PERIOD_PHRASES[k], text: queryText(PERIOD_PHRASES[k], query.location) }
    })
  }
  return { items: items.slice(0, 13) }
}
