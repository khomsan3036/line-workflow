import type { AttendanceSummary, DayStat, GroupStat, LocationStat } from './attendance'
import { UNKNOWN_GROUP } from './attendance'
import { CROSS_CHECK_TIME_TOLERANCE_MIN, crossCheckRate, type CrossCheckStat } from './attendanceCrossCheck'
import {
  GROUP_LABELS,
  GROUP_UNITS,
  LOCATION_LABELS,
  formatThaiDateShort,
  nowTimeLocal,
  type AttendanceQuery,
  type GroupBy,
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
const TRACK = '#E5E7EB'
const CARD = '#F8FAFC'
// ตัวอักษรสีเข้มสำหรับพื้นขาว (เขียวสด #06C755 ใช้กับแถบ/จุดสีเท่านั้น เพราะตัวอักษรสีนี้อ่านยากบนมือถือ)
const GREEN_INK = '#047857'
// ป้ายบนหัวการ์ด: พื้นอ่อน + ตัวอักษรเข้ม (ตัวขาวบนเขียว/ฟ้าสดอ่านไม่ชัด)
const CHIP_TONES: Record<string, { bg: string; fg: string }> = {
  Workshop: { bg: '#ECFDF5', fg: GREEN_INK },
  Site: { bg: '#EFF6FF', fg: '#1D4ED8' }
}

const LOCATION_COLORS: Record<string, string> = {
  Workshop: GREEN,
  Site: BLUE
}

// ผลตรวจเทียบ bPlus: ป้ายพื้นอ่อน + ตัวอักษรเข้มสีเดียวกัน (คู่สีเดียวกับ myAttendanceFlex.ts)
type Tone = { bg: string; fg: string }
const AMBER_INK = '#B45309'
const RED_INK = '#B91C1C'
const BLUE_INK = '#1D4ED8'
const TONE_GREEN: Tone = { bg: '#ECFDF5', fg: GREEN_INK }
const TONE_AMBER: Tone = { bg: '#FFFBEB', fg: AMBER_INK }
const TONE_RED: Tone = { bg: '#FEF2F2', fg: RED_INK }
const TONE_GRAY: Tone = { bg: '#F3F4F6', fg: '#374151' }

/** เกณฑ์ % ที่ตรงกัน: ตั้งแต่ OK = ตรงกันดี, ตั้งแต่ WARN = ต่างกันเล็กน้อย, ต่ำกว่านั้น = ควรตรวจสอบ */
const MATCH_OK_PCT = 98
const MATCH_WARN_PCT = 90

interface CrossCheckStatus {
  pending: boolean
  rate: number | null
  label: string
  tone: Tone
  barColor: string
}

function crossCheckStatus(c: CrossCheckStat): CrossCheckStatus {
  const rate = crossCheckRate(c)
  if (c.comparedDays === 0 || rate === null) {
    return { pending: true, rate: null, label: 'รอข้อมูล bPlus', tone: TONE_GRAY, barColor: TRACK }
  }
  if (rate >= MATCH_OK_PCT) return { pending: false, rate, label: 'ตรงกันดี', tone: TONE_GREEN, barColor: GREEN }
  if (rate >= MATCH_WARN_PCT) return { pending: false, rate, label: 'ต่างกันเล็กน้อย', tone: TONE_AMBER, barColor: AMBER }
  return { pending: false, rate, label: 'ควรตรวจสอบ', tone: TONE_RED, barColor: '#EF4444' }
}

/** 97.5 -> "97.5", 100 -> "100" */
function fmtRate(rate: number): string {
  return Number.isInteger(rate) ? String(rate) : rate.toFixed(1)
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

function groupPhrase(groupBy: GroupBy): string {
  return groupBy === 'location' ? '' : ` ${GROUP_LABELS[groupBy]}`
}

/** ตัวกรองแผนก/ตำแหน่งของคำถาม ส่งต่อไปยังปุ่มและ quick reply เพื่อคงตัวกรองไว้ */
type Filters = Pick<AttendanceQuery, 'department' | 'position'>

function filterPhrase(f: Filters): string {
  return `${f.department ? ` แผนก ${f.department}` : ''}${f.position ? ` ตำแหน่ง ${f.position}` : ''}`
}

/** ข้อความที่ parser (attendanceQuery.ts) อ่านกลับได้ เช่น "สรุปพนักงาน วันนี้ site แผนก IT ตามตำแหน่ง" */
function queryText(period: string, location: LocationFilter, groupBy: GroupBy = 'location', filters: Filters = {}): string {
  return `สรุปพนักงาน ${period}${locationPhrase(location)}${filterPhrase(filters)}${groupPhrase(groupBy)}`.trim()
}

/** ป้ายตัวกรองสั้น ๆ เช่น "แผนก IT · ตำแหน่ง Fitter A" (ว่างเมื่อไม่กรอง) */
function filterLabel(f: Filters): string {
  return [f.department ? `แผนก ${f.department}` : '', f.position ? `ตำแหน่ง ${f.position}` : ''].filter(Boolean).join(' · ')
}

/** บรรทัดรองใต้หัวการ์ด: ช่วงเวลา · แผนก/ตำแหน่ง (ถ้ากรอง) · มุมมอง (ถ้าไม่ใช่ตามสถานที่) */
function subtitle(query: AttendanceQuery): string {
  const parts = [query.period.label]
  const f = filterLabel(query)
  if (f) parts.push(f)
  if (query.groupBy !== 'location') parts.push(GROUP_LABELS[query.groupBy])
  return parts.join(' · ')
}

/** จำนวนแผนก/ตำแหน่งสูงสุดที่แสดงในการ์ด ที่เหลือรวมเป็น "อื่น ๆ" (การ์ดยาวเกินอ่านยากบนมือถือ) */
const MAX_GROUP_ROWS = 10

// ---------------------------------------------------------------------------
// ชิ้นส่วนย่อย
// ---------------------------------------------------------------------------

function chip(text: string, tone: { bg: string; fg: string }) {
  return {
    type: 'box',
    layout: 'vertical',
    backgroundColor: tone.bg,
    cornerRadius: '999px',
    paddingStart: '12px',
    paddingEnd: '12px',
    paddingTop: '4px',
    paddingBottom: '4px',
    flex: 0,
    contents: [{ type: 'text', text, size: 'xs', color: tone.fg, weight: 'bold', wrap: true }]
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

/** ป้ายชิดซ้าย กว้างเท่าข้อความ (filler กินที่เหลือ ป้ายไม่ยืดเต็มแถวและไม่ถูกตัดเป็น "...") */
function chipRow(text: string, tone: Tone, margin = 'sm') {
  return { type: 'box', layout: 'horizontal', margin, contents: [chip(text, tone), { type: 'filler' }] }
}

/** ป้ายสรุปผลเทียบ bPlus บนหัวการ์ด ให้เห็นทันทีว่าตัวเลขเชื่อถือได้แค่ไหน */
function crossCheckBadge(c: CrossCheckStat) {
  const s = crossCheckStatus(c)
  if (s.pending) return chipRow('bPlus · รอข้อมูลเพื่อเทียบ', s.tone, 'md')
  const text = `ตรงกับ bPlus ${fmtRate(s.rate ?? 0)}%`
  return chipRow(s.tone === TONE_GREEN ? text : `${text} · ${s.label}`, s.tone, 'md')
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
        contents: [
          { type: 'text', text: 'สรุปการเข้างาน', size: 'xs', color: '#CBD5E1', weight: 'bold', flex: 1, gravity: 'center', wrap: true },
          chip(
            LOCATION_LABELS[query.location],
            query.location === 'all' ? { bg: NAVY_SOFT, fg: '#FFFFFF' } : CHIP_TONES[query.location]
          )
        ]
      },
      { type: 'text', text: 'พนักงานสแกนเข้างาน', size: 'lg', weight: 'bold', color: '#FFFFFF', wrap: true },
      { type: 'text', text: subtitle(query), size: 'xs', color: '#CBD5E1', wrap: true },
      ...(summary.crossCheck ? [crossCheckBadge(summary.crossCheck)] : [])
    ]
  }
}

/** แถวผลเทียบ: จุดสี + คำอธิบาย (ตัดบรรทัดได้) + ตัวเลขชิดขวา */
function checkRow(label: string, value: number, dotColor: string, valueColor = INK) {
  return {
    type: 'box',
    layout: 'horizontal',
    margin: 'md',
    contents: [
      { type: 'text', text: '●', size: 'xs', color: dotColor, flex: 0, gravity: 'center' },
      { type: 'text', text: label, size: 'sm', color: INK, margin: 'sm', flex: 1, wrap: true, gravity: 'center' },
      { type: 'text', text: fmt(value), size: 'sm', color: valueColor, weight: 'bold', align: 'end', flex: 0, margin: 'md', gravity: 'center' }
    ]
  }
}

/** "2026-09-14 10:30" -> "จ. 14 ก.ย. 10:30 น." */
function formatSyncAt(value: string): string {
  const [date, time] = value.split(' ')
  return `${formatThaiDateShort(date)} ${time ?? ''} น.`.replace(/\s+/g, ' ').trim()
}

/**
 * ส่วน "ตรวจเทียบกับระบบ bPlus": % ที่ตรงกันตัวใหญ่ + ป้ายสถานะ + แถบ แล้วแจกแจงว่าไม่ตรงเพราะอะไร
 * คำอธิบายเป็นภาษาคน (สแกนแล้วแต่ไม่มีใน bPlus / มีใน bPlus แต่ไม่พบสแกน) ให้ HR รู้ว่าต้องไปดูฝั่งไหน
 */
function crossCheckSection(summary: AttendanceSummary): unknown[] {
  const c = summary.crossCheck
  if (!c) return []
  const s = crossCheckStatus(c)
  const unit = summary.query.period.single ? 'คน' : 'คน-วัน'
  const syncLine = c.lastSyncAt ? `bPlus ซิงก์ล่าสุด ${formatSyncAt(c.lastSyncAt)}` : ''

  if (s.pending) {
    return [
      sectionTitle('ตรวจเทียบกับระบบ bPlus'),
      {
        type: 'box',
        layout: 'vertical',
        margin: 'sm',
        backgroundColor: CARD,
        cornerRadius: '10px',
        paddingAll: '14px',
        contents: [
          chipRow(s.label, s.tone, 'none'),
          { type: 'text', text: 'bPlus ยังไม่มีเวลาลงงานของช่วงนี้', size: 'sm', color: INK, weight: 'bold', margin: 'md', wrap: true },
          {
            type: 'text',
            text: 'ปกติ bPlus นำเข้าเวลาช้ากว่าเครื่องสแกน ระบบจะเทียบให้อัตโนมัติเมื่อข้อมูลเข้าแล้ว',
            size: 'xs',
            color: MUTED,
            margin: 'xs',
            wrap: true
          },
          ...(syncLine ? [{ type: 'text', text: syncLine, size: 'xs', color: MUTED, margin: 'sm', wrap: true }] : [])
        ]
      }
    ]
  }

  const rate = s.rate ?? 0
  const compared = c.matched + c.scanOnly + c.bplusOnly
  const rows: unknown[] = [
    checkRow('ตรงกันทั้งสองระบบ', c.matched, GREEN, GREEN_INK),
    checkRow('สแกนนิ้วแล้ว แต่ไม่มีใน bPlus', c.scanOnly, AMBER, c.scanOnly > 0 ? AMBER_INK : INK),
    checkRow('มีใน bPlus แต่ไม่พบการสแกนนิ้ว', c.bplusOnly, BLUE, c.bplusOnly > 0 ? BLUE_INK : INK)
  ]
  if (c.timeDiff > 0) rows.push(checkRow(`ตรงกัน แต่เวลาเข้าต่างกันเกิน ${CROSS_CHECK_TIME_TOLERANCE_MIN} นาที`, c.timeDiff, '#9CA3AF'))
  if (c.unlinked > 0) rows.push(checkRow('ใน bPlus ไม่มีเลขบัตร (จับคู่ไม่ได้)', c.unlinked, '#9CA3AF', MUTED))

  // ช่วงหลายวัน: บอกว่าเทียบได้กี่วัน (วันที่ bPlus ยังไม่นำเข้าไม่นับว่าไม่ตรง)
  const waitingDays = Math.max(0, c.scanDays - c.comparedDays)
  const notes = [
    summary.query.period.single ? '' : `เทียบได้ ${fmt(c.comparedDays)} วัน${waitingDays > 0 ? ` · รอ bPlus อีก ${fmt(waitingDays)} วัน` : ''}`,
    syncLine
  ].filter(Boolean)

  return [
    sectionTitle('ตรวจเทียบกับระบบ bPlus'),
    {
      type: 'box',
      layout: 'vertical',
      margin: 'sm',
      backgroundColor: CARD,
      cornerRadius: '10px',
      paddingAll: '14px',
      contents: [
        {
          type: 'box',
          layout: 'horizontal',
          contents: [
            {
              type: 'box',
              layout: 'vertical',
              flex: 1,
              contents: [
                {
                  type: 'box',
                  layout: 'baseline',
                  contents: [
                    { type: 'text', text: `${fmtRate(rate)}%`, size: 'xxl', weight: 'bold', color: s.tone.fg, flex: 0 },
                    { type: 'text', text: 'ตรงกัน', size: 'sm', color: MUTED, margin: 'sm', flex: 0 }
                  ]
                },
                { type: 'text', text: `${fmt(c.matched)} จาก ${fmt(compared)} ${unit}`, size: 'xs', color: MUTED, wrap: true }
              ]
            },
            // ป้ายสถานะชิดบนขวา (filler ด้านล่างกันป้ายยืดสูงเท่าแถว)
            { type: 'box', layout: 'vertical', flex: 0, contents: [chip(s.label, s.tone), { type: 'filler' }] }
          ]
        },
        bar(rate <= 0 ? 0 : Math.max(2, Math.round(rate)), s.barColor),
        { type: 'separator', margin: 'lg', color: TRACK },
        ...rows,
        ...(notes.length > 0
          ? [{ type: 'text', text: notes.join(' · '), size: 'xs', color: MUTED, margin: 'lg', wrap: true }]
          : [])
      ]
    }
  ]
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
      { type: 'text', text: filterLabel(summary.query) ? `สแกนเข้างานแล้ว · ${filterLabel(summary.query)}` : 'สแกนเข้างานแล้ว', size: 'sm', color: MUTED, margin: 'xs', wrap: true },
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
          statCell('สแกนออกแล้ว', fmt(summary.totalCheckedOut), summary.totalCheckedOut > 0 ? GREEN_INK : INK)
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
          { type: 'text', text: l.location, size: 'sm', color: INK, weight: 'bold', margin: 'sm', flex: 1, gravity: 'center' },
          { type: 'text', text: `${fmt(l.people)} คน`, size: 'sm', color: INK, weight: 'bold', align: 'end', flex: 0, gravity: 'center' },
          {
            type: 'text',
            text: `${pct(l.people, total)}%`,
            size: 'xs',
            color: MUTED,
            align: 'end',
            flex: 0,
            margin: 'sm',
            gravity: 'center'
          }
        ]
      },
      bar(pct(l.people, total), locationColor(l.location)),
      {
        type: 'text',
        text: `สแกนแรก ${l.earliestIn ?? '-'} · ล่าสุด ${l.latestIn ?? '-'} · ออกแล้ว ${fmt(l.checkedOut)}`,
        size: 'xs',
        color: MUTED,
        margin: 'xs',
        wrap: true
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
      margin: 'sm',
      contents: [
        { type: 'text', text: label, size: 'xs', color: empty ? MUTED : INK, flex: 3, gravity: 'center' },
        {
          type: 'box',
          layout: 'vertical',
          flex: 6,
          justifyContent: 'center',
          contents: [bar(empty ? 0 : pct(d.people, max), color)]
        },
        {
          type: 'text',
          text: empty ? 'ไม่มีข้อมูล' : fmt(d.people),
          size: 'xs',
          color: empty ? MUTED : INK,
          weight: empty ? 'regular' : 'bold',
          align: 'end',
          flex: 3,
          gravity: 'center'
        }
      ]
    }
  })
}

/**
 * แถวแผนก/ตำแหน่ง: ชื่อ (ตัดบรรทัดได้) + จำนวน + % + แถบสัดส่วน และบรรทัดย่อยบอก Workshop/Site หรือสแกนออก
 * ใช้สีเดียวกับสถานที่ที่กรอง (ทุกสถานที่ = น้ำเงินเข้ม) ให้ต่างจากแถวสถานที่ที่ใช้เขียว/ฟ้า
 */
function groupRows(groups: GroupStat[], summary: AttendanceSummary) {
  const { query } = summary
  const total = summary.totalPeople
  const color = query.location === 'all' ? NAVY_SOFT : locationColor(query.location)
  const perDay = !query.period.single && summary.activeDays > 0
  const shown = groups.slice(0, MAX_GROUP_ROWS)
  const rest = groups.slice(MAX_GROUP_ROWS)

  const rows: unknown[] = shown.map((g) => {
    const unknown = g.name === UNKNOWN_GROUP
    const value = perDay ? `${fmt(Math.round(g.people / summary.activeDays))} คน/วัน` : `${fmt(g.people)} คน`
    const detail =
      query.location === 'all'
        ? Object.entries(g.byLocation)
            .sort((a, b) => b[1] - a[1])
            .map(([loc, n]) => `${loc} ${fmt(n)}`)
            .join(' · ')
        : `สแกนออกแล้ว ${fmt(g.checkedOut)} จาก ${fmt(g.people)}`
    return {
      type: 'box',
      layout: 'vertical',
      margin: 'md',
      contents: [
        {
          type: 'box',
          layout: 'horizontal',
          contents: [
            { type: 'text', text: g.name, size: 'sm', color: unknown ? MUTED : INK, weight: 'bold', flex: 5, wrap: true, gravity: 'center' },
            { type: 'text', text: value, size: 'sm', color: INK, weight: 'bold', align: 'end', flex: 3, gravity: 'center', wrap: true },
            { type: 'text', text: `${pct(g.people, total)}%`, size: 'xs', color: MUTED, align: 'end', flex: 1, margin: 'sm', gravity: 'center' }
          ]
        },
        bar(pct(g.people, total), unknown ? '#9CA3AF' : color),
        { type: 'text', text: detail, size: 'xs', color: MUTED, margin: 'xs', wrap: true }
      ]
    }
  })

  if (rest.length > 0) {
    const restPeople = rest.reduce((s, g) => s + g.people, 0)
    const unit = GROUP_UNITS[query.groupBy]
    rows.push({
      type: 'text',
      text: `อื่น ๆ อีก ${fmt(rest.length)} ${unit} · ${fmt(restPeople)} ${perDay ? 'คน-วัน' : 'คน'} (${pct(restPeople, total)}%)`,
      size: 'xs',
      color: MUTED,
      margin: 'md',
      wrap: true
    })
  }
  return rows
}

const MY_ATTENDANCE_LABEL = 'เวลาเข้างานของฉัน'
const MY_ATTENDANCE_TEXT = 'เวลาเข้างานของฉัน วันนี้'

/** มุมมองที่ยังมีความหมายเมื่อมีตัวกรอง (กรองแผนกแล้วไม่ต้องแยกตามแผนกอีก ฯลฯ) */
function availableViews(query: AttendanceQuery): GroupBy[] {
  const all: GroupBy[] = ['location', 'department', 'position']
  return all.filter((g) => !(g === 'department' && query.department) && !(g === 'position' && query.position))
}

/** ปุ่ม/quick reply ล้างตัวกรอง: ตัดตัวกรองนั้นออกแล้วกลับไปมุมมองแยกตามมิตินั้น */
function clearFilterActions(query: AttendanceQuery): Array<{ label: string; text: string }> {
  const period = periodPhrase(query)
  const actions: Array<{ label: string; text: string }> = []
  if (query.department) actions.push({ label: 'ทุกแผนก', text: queryText(period, query.location, 'department', { position: query.position }) })
  if (query.position) actions.push({ label: 'ทุกตำแหน่ง', text: queryText(period, query.location, 'position', { department: query.department }) })
  return actions
}

function secondaryButton(label: string, text: string, flex = 2) {
  return {
    type: 'button',
    style: 'secondary',
    height: 'sm',
    color: '#F1F5F9',
    flex,
    action: { type: 'message', label, text }
  }
}

function footerButtons(query: AttendanceQuery) {
  const period = periodPhrase(query)
  // แถวบน: ปุ่มแรก = ดูเวลาเข้า-ออกของตัวเอง ตามด้วยช่วงเวลาอื่นของมุมมองเดิม
  const candidates: PeriodKey[] = ['today', 'yesterday', 'thisWeek', 'lastWeek']
  const others = candidates.filter((k) => k !== query.period.key).slice(0, 2)
  const top = {
    type: 'box',
    layout: 'horizontal',
    spacing: 'sm',
    contents: [
      {
        type: 'button',
        style: 'primary',
        height: 'sm',
        color: NAVY_SOFT,
        flex: 3,
        action: { type: 'message', label: MY_ATTENDANCE_LABEL, text: MY_ATTENDANCE_TEXT }
      },
      ...others.map((k) => secondaryButton(PERIOD_PHRASES[k], queryText(PERIOD_PHRASES[k], query.location, query.groupBy, query)))
    ]
  }
  // แถวล่าง: สลับมุมมอง ตามสถานที่ / ตามแผนก / ตามตำแหน่ง (ช่วงเวลาและสถานที่เดิม)
  // มุมมองที่ซ้ำกับตัวกรองไม่แสดง แต่แทนด้วยปุ่มล้างตัวกรอง "ทุกแผนก" / "ทุกตำแหน่ง"
  const views = availableViews(query)
  const bottom = {
    type: 'box',
    layout: 'horizontal',
    spacing: 'sm',
    margin: 'sm',
    contents: [
      ...views.filter((g) => g !== query.groupBy).map((g) => secondaryButton(GROUP_LABELS[g], queryText(period, query.location, g, query), 1)),
      ...clearFilterActions(query).map((a) => secondaryButton(a.label, a.text, 1))
    ]
  }
  return { type: 'box', layout: 'vertical', paddingAll: '12px', contents: [top, bottom] }
}

// ---------------------------------------------------------------------------
// ส่วนประกอบหลัก
// ---------------------------------------------------------------------------

/** Flex bubble สรุปการเข้างาน */
export function flexAttendanceSummary(summary: AttendanceSummary, today: string) {
  const { query } = summary
  const single = query.period.single
  const body: unknown[] = [single ? heroSingleDay(summary) : heroRange(summary)]

  if (query.groupBy !== 'location') {
    // มุมมองแผนก/ตำแหน่ง: แสดงกลุ่มแทนสถานที่ (สถานที่ย่อยอยู่ในบรรทัดรองของแต่ละกลุ่ม) และไม่แสดงรายวันให้การ์ดสั้นพอ
    const unit = GROUP_UNITS[query.groupBy]
    const title =
      query.department && query.groupBy === 'position'
        ? `ตำแหน่งในแผนก ${query.department}`
        : query.position && query.groupBy === 'department'
          ? `แผนกของตำแหน่ง ${query.position}`
          : GROUP_LABELS[query.groupBy]
    body.push(sectionTitle(`${title} · ${fmt(summary.byGroup.length)} ${unit}${summary.byGroup.length > MAX_GROUP_ROWS ? ` (แสดง ${MAX_GROUP_ROWS} อันดับแรก)` : ''}`))
    if (summary.byGroup.length > 0) {
      body.push(...groupRows(summary.byGroup, summary))
    } else {
      body.push({ type: 'text', text: 'ไม่พบข้อมูลแผนก/ตำแหน่งของผู้ที่สแกน (ทะเบียนพนักงานยังไม่ซิงก์)', size: 'xs', color: MUTED, wrap: true, margin: 'sm' })
    }
  } else if (query.location === 'all' && summary.byLocation.length > 0) {
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

  // ตรวจเทียบ bPlus อยู่ก่อนรายวัน ให้เห็นโดยไม่ต้องเลื่อนผ่านรายการยาว ๆ
  body.push(...crossCheckSection(summary))

  if (!single && query.groupBy === 'location') {
    body.push(sectionTitle('รายวัน'))
    body.push(...dayRows(summary.days, query.location === 'all' ? NAVY_SOFT : locationColor(query.location), today))
  }

  body.push({ type: 'separator', margin: 'lg', color: TRACK })
  body.push({
    type: 'text',
    text: `ข้อมูล ณ ${nowTimeLocal()} น. · จากเครื่องสแกนนิ้ว${summary.crossCheck ? ' เทียบกับ bPlus' : ''}`,
    size: 'xs',
    color: MUTED,
    margin: 'md',
    wrap: true
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
        { type: 'text', text: 'สรุปการเข้างาน', size: 'xs', color: '#CBD5E1', weight: 'bold', wrap: true },
        { type: 'text', text: 'ยังไม่มีข้อมูลการสแกน', size: 'lg', weight: 'bold', color: '#FFFFFF', wrap: true },
        { type: 'text', text: `${subtitle(query)} · ${LOCATION_LABELS[query.location]}`, size: 'xs', color: '#CBD5E1', wrap: true }
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
  const { query } = summary
  const where = `${filterPhrase(query)}${query.location === 'all' ? '' : ` (${query.location})`}`
  const grouped =
    query.groupBy === 'location' ? '' : ` ${GROUP_LABELS[query.groupBy]} ${fmt(summary.byGroup.length)} ${GROUP_UNITS[query.groupBy]}`
  const check = summary.crossCheck ? crossCheckStatus(summary.crossCheck) : null
  const checked = check && !check.pending ? ` · ตรงกับ bPlus ${fmtRate(check.rate ?? 0)}%` : ''
  if (query.period.single) {
    return `พนักงานสแกนเข้างาน ${query.period.label}${where}: ${fmt(summary.totalPeople)} คน${grouped}${checked}`
  }
  const avg = summary.activeDays > 0 ? Math.round(summary.totalPeople / summary.activeDays) : 0
  return `พนักงานเข้างาน ${query.period.label}${where}: เฉลี่ย ${fmt(avg)} คน/วัน${grouped}${checked}`
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
        text: queryText(period, l, query.groupBy, query)
      }
    }))
  // สลับมุมมอง (ช่วงเวลาและสถานที่เดิม) และปุ่มล้างตัวกรอง "ทุกแผนก" / "ทุกตำแหน่ง" เมื่อกรองอยู่
  for (const g of availableViews(query)) {
    if (g === query.groupBy) continue
    items.push({ type: 'action', action: { type: 'message', label: GROUP_LABELS[g], text: queryText(period, query.location, g, query) } })
  }
  for (const a of clearFilterActions(query)) {
    items.push({ type: 'action', action: { type: 'message', label: a.label, text: a.text } })
  }
  // "เวลาเข้างานของฉัน" อยู่ก่อนช่วงเวลาอื่น ๆ (ก่อน "เมื่อวาน")
  items.push({ type: 'action', action: { type: 'message', label: MY_ATTENDANCE_LABEL, text: MY_ATTENDANCE_TEXT } })
  const periods: PeriodKey[] = ['today', 'yesterday', 'thisWeek', 'lastWeek', 'thisMonth']
  for (const k of periods) {
    if (k === query.period.key) continue
    items.push({
      type: 'action',
      action: { type: 'message', label: PERIOD_PHRASES[k], text: queryText(PERIOD_PHRASES[k], query.location, query.groupBy, query) }
    })
  }
  return { items: items.slice(0, 13) }
}
