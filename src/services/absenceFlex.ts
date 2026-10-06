import { formatThaiDate, formatThaiDateShort } from './attendanceQuery'
import type { AbsenceLocation, AbsenceLocationReport, AbsenceReport, AbsentPerson } from './absence'

// ---------------------------------------------------------------------------
// Flex Message "ขาดงานติดต่อกัน" - carousel 2 ใบ (Workshop / Site) ใบละ Top N คนที่ขาดนานสุด (ค่าเริ่มต้น 10)
//
// แนวคิดดีไซน์
//   - หัวการ์ดสีเข้มตามสถานที่ (เขียว Workshop / น้ำเงิน Site เหมือนการ์ดเข้างานและ Top OT) ปัดดูอีกสถานที่ได้ทันที
//   - ตัวเลขใหญ่ "กี่คน" + สัดส่วนจากคนที่ทำงานอยู่ แล้วแยก 3 ระดับด้วยสีอ่อน ตัวเข้มสีเดียวกัน
//     2-3 วัน (เหลือง) / 4-6 วัน (ส้ม) / 7 วันขึ้นไป (แดง)
//   - แต่ละคน: ช่องซ้ายคือจำนวนวันที่ขาด (สีตามระดับ) ขวาคือชื่อ แผนก · ตำแหน่ง และสแกนล่าสุด · หัวหน้างาน
//     พอให้หัวหน้า/HR โทรตามได้ทันที เรียงขาดนานสุดก่อน
//   - ไม่มีใครขาด = การ์ดชื่นชม ไม่ใช่การ์ดว่าง
// กติกาเดียวกับการ์ดอื่น (LINE for PC + อ่านง่ายบนมือถือ): สีทึบเท่านั้น ไม่มี box ว่าง ไม่ใช้ offset/alignItems
// ทุกข้อความ wrap: true ตัวเล็กสุด xs สีจางสุด MUTED และไม่มีตัวขาวบนสีสด
// ---------------------------------------------------------------------------

export const INK = '#111827'
export const MUTED = '#6B7280'
export const TRACK = '#E5E7EB'
export const CARD = '#F8FAFC'
export const HEADER_SUB = '#E2E8F0'

/** จำนวนคนต่อสถานที่ค่าเริ่มต้น (10 คน x 2 ใบ ราว 20 KB ต่ำกว่าเพดาน carousel 50 KB ของ LINE มาก) */
export const ABSENCE_TOP_DEFAULT = 10

export interface Theme {
  label: string
  header: string
  chipBg: string
  chipFg: string
  ink: string
}

export const THEMES: Record<AbsenceLocation, Theme> = {
  Workshop: { label: '🏭 Workshop', header: '#065F46', chipBg: '#ECFDF5', chipFg: '#047857', ink: '#047857' },
  Site: { label: '🏗️ Site', header: '#1E3A8A', chipBg: '#EFF6FF', chipFg: '#1D4ED8', ink: '#1D4ED8' }
}

interface Tier {
  label: string
  min: number
  bg: string
  fg: string
}

/** ระดับความนาน เรียงจากนานสุด (ใช้หาสีของแต่ละคนด้วย) */
const TIERS: Tier[] = [
  { label: '7 วันขึ้นไป', min: 7, bg: '#FEF2F2', fg: '#B91C1C' },
  { label: '4-6 วัน', min: 4, bg: '#FFF7ED', fg: '#C2410C' },
  { label: '2-3 วัน', min: 0, bg: '#FFFBEB', fg: '#B45309' }
]

function tierOf(streak: number): Tier {
  return TIERS.find((t) => streak >= t.min) ?? TIERS[TIERS.length - 1]
}

export function text(value: string, extra: Record<string, unknown> = {}) {
  return { type: 'text', text: value || '-', wrap: true, ...extra }
}

export function chip(label: string, bg: string, fg: string) {
  return {
    type: 'box',
    layout: 'vertical',
    backgroundColor: bg,
    cornerRadius: '999px',
    paddingStart: '12px',
    paddingEnd: '12px',
    paddingTop: '4px',
    paddingBottom: '4px',
    flex: 0,
    contents: [text(label, { size: 'xs', color: fg, weight: 'bold' })]
  }
}

function header(theme: Theme, report: AbsenceReport) {
  return {
    type: 'box',
    layout: 'vertical',
    backgroundColor: theme.header,
    paddingAll: '18px',
    spacing: 'xs',
    contents: [
      {
        type: 'box',
        layout: 'horizontal',
        contents: [
          text('🔔 ติดตามการขาดงาน', { size: 'xs', color: HEADER_SUB, weight: 'bold', flex: 1, gravity: 'center' }),
          chip(theme.label, theme.chipBg, theme.chipFg)
        ]
      },
      text('ขาดงานติดต่อกัน', { size: 'xl', weight: 'bold', color: '#FFFFFF', margin: 'sm' }),
      text(`ตั้งแต่ ${report.minDays} วันทำงานขึ้นไป · ข้อมูลถึง ${formatThaiDate(report.asOf)}`, {
        size: 'xs',
        color: HEADER_SUB
      })
    ]
  }
}

function hero(theme: Theme, loc: AbsenceLocationReport) {
  const pct = loc.activePeople > 0 ? (loc.people.length / loc.activePeople) * 100 : 0
  return {
    type: 'box',
    layout: 'vertical',
    backgroundColor: CARD,
    cornerRadius: '12px',
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
              text(`${loc.people.length.toLocaleString('en-US')} คน`, { size: '3xl', weight: 'bold', color: theme.ink }),
              text('ขาดงานติดต่อกัน', { size: 'xs', color: MUTED })
            ]
          },
          {
            type: 'box',
            layout: 'vertical',
            flex: 0,
            contents: [
              text(`${pct.toLocaleString('en-US', { maximumFractionDigits: 1 })}%`, { size: 'xl', weight: 'bold', color: INK, align: 'end' }),
              text(`จาก ${loc.activePeople.toLocaleString('en-US')} คน`, { size: 'xs', color: MUTED, align: 'end' })
            ]
          }
        ]
      },
      {
        type: 'box',
        layout: 'horizontal',
        spacing: 'sm',
        margin: 'md',
        contents: [...TIERS].reverse().map((t) => tierTile(t, loc.people))
      }
    ]
  }
}

function tierTile(tier: Tier, people: AbsentPerson[]) {
  const count = people.filter((p) => tierOf(p.streak) === tier).length
  return {
    type: 'box',
    layout: 'vertical',
    flex: 1,
    backgroundColor: tier.bg,
    cornerRadius: '10px',
    paddingTop: '8px',
    paddingBottom: '8px',
    contents: [
      text(String(count), { size: 'lg', weight: 'bold', color: tier.fg, align: 'center' }),
      text(tier.label, { size: 'xs', color: tier.fg, align: 'center' })
    ]
  }
}

function personRow(p: AbsentPerson, first: boolean) {
  const tier = tierOf(p.streak)
  const name = p.nickname ? `${p.name} (${p.nickname})` : p.name
  const role = [p.department, p.position].filter((x): x is string => !!x)
  // ตำแหน่งมักขึ้นต้นด้วยชื่อแผนก ("HSE" + "HSE Officer") ไม่ต้องพูดซ้ำ
  if (role.length === 2 && role[1].toLowerCase().startsWith(role[0].toLowerCase())) role.shift()
  const meta = [`สแกนล่าสุด ${formatThaiDateShort(p.lastScan)}`]
  // หัวหน้าที่เป็นตัวเองไม่ต้องบอก (โฟร์แมนของทีม)
  if (p.foreman && p.foreman.replace(/\s+/g, '') !== p.name.replace(/\s+/g, '')) meta.push(`หัวหน้า ${p.foreman}`)

  return {
    type: 'box',
    layout: 'horizontal',
    spacing: 'md',
    margin: first ? 'lg' : 'md',
    contents: [
      {
        type: 'box',
        layout: 'vertical',
        width: '48px',
        flex: 0,
        backgroundColor: tier.bg,
        cornerRadius: '10px',
        paddingTop: '6px',
        paddingBottom: '6px',
        contents: [
          text(String(p.streak), { size: 'lg', weight: 'bold', color: tier.fg, align: 'center' }),
          text('วัน', { size: 'xs', color: tier.fg, align: 'center' })
        ]
      },
      {
        type: 'box',
        layout: 'vertical',
        flex: 1,
        contents: [
          text(name, { size: 'sm', weight: 'bold', color: INK }),
          // 2 บรรทัดใน text เดียว (ขึ้นบรรทัดด้วย \n) ลดขนาด JSON ให้ส่งได้หลายสิบคนในข้อความเดียว
          text(`${role.length > 0 ? role.join(' · ') : 'ไม่ระบุแผนก'} · ${p.empCode}\n${meta.join(' · ')}`, { size: 'xs', color: MUTED })
        ]
      }
    ]
  }
}

function notes(report: AbsenceReport, loc: AbsenceLocationReport, hidden: AbsentPerson[]): unknown[] {
  const lines: string[] = []
  if (hidden.length > 0) {
    const lo = Math.min(...hidden.map((p) => p.streak))
    const hi = Math.max(...hidden.map((p) => p.streak))
    lines.push(`➕ และอีก ${hidden.length} คนที่ขาด ${lo === hi ? lo : `${lo}-${hi}`} วัน`)
  }
  if (loc.stale > 0) {
    lines.push(`ℹ️ อีก ${loc.stale} คนสถานะ HR ยังทำงานอยู่ แต่ไม่สแกนเกิน ${report.activeDays} วัน อาจออกไปแล้ว ช่วยตรวจสอบสถานะ`)
  }
  lines.push('นับเฉพาะวันทำงาน จ.-ส. (ไม่รวมวันหยุดบริษัท) เฉพาะพนักงานที่ยังทำงานอยู่ ยังไม่ได้หักวันลา')
  return [
    { type: 'separator', color: TRACK, margin: 'lg' },
    ...lines.map((line, i) => text(line, { size: 'xs', color: MUTED, margin: i === 0 ? 'md' : 'xs' })),
    {
      type: 'box',
      layout: 'vertical',
      backgroundColor: CARD,
      cornerRadius: '10px',
      paddingAll: '10px',
      margin: 'md',
      contents: [text('💬 ลองโทรถามไถ่กันก่อน อาจป่วยหรือมีเรื่องจำเป็น ถ้าลาหรือย้ายหน่วยงานแล้ว แจ้ง HR เพื่ออัปเดตข้อมูล', { size: 'xs', color: '#374151' })]
    }
  ]
}

function emptyBody(theme: Theme, loc: AbsenceLocationReport, report: AbsenceReport): unknown[] {
  const body: unknown[] = [
    {
      type: 'box',
      layout: 'vertical',
      backgroundColor: theme.chipBg,
      cornerRadius: '12px',
      paddingAll: '18px',
      contents: [
        text('🎉', { size: '3xl', align: 'center' }),
        text('ไม่มีใครขาดงานติดต่อกัน', { size: 'md', weight: 'bold', color: theme.chipFg, align: 'center', margin: 'sm' }),
        text(`พนักงาน ${loc.activePeople.toLocaleString('en-US')} คนมาทำงานครบ ขอบคุณทุกคนครับ`, {
          size: 'xs',
          color: '#374151',
          align: 'center',
          margin: 'xs'
        })
      ]
    }
  ]
  if (loc.stale > 0) {
    body.push(
      { type: 'separator', color: TRACK, margin: 'lg' },
      text(`ℹ️ อีก ${loc.stale} คนสถานะ HR ยังทำงานอยู่ แต่ไม่สแกนเกิน ${report.activeDays} วัน ช่วยตรวจสอบสถานะ`, {
        size: 'xs',
        color: MUTED,
        margin: 'md'
      })
    )
  }
  return body
}

export function bubble(headerBox: unknown, body: unknown[]) {
  return {
    type: 'bubble',
    size: 'mega',
    header: headerBox,
    body: { type: 'box', layout: 'vertical', paddingAll: '16px', contents: body }
  }
}

/** ใบการ์ดของสถานที่เดียว: ภาพรวมนับทุกคน รายชื่อเฉพาะ top คนที่ขาดนานสุด */
function locationBubble(report: AbsenceReport, loc: AbsenceLocationReport, top: number) {
  const theme = THEMES[loc.location]
  if (loc.people.length === 0) return bubble(header(theme, report), emptyBody(theme, loc, report))

  const shown = loc.people.slice(0, top)
  const title = loc.people.length > top ? `${top} อันดับที่ขาดนานสุด` : 'รายชื่อ (ขาดนานสุดก่อน)'
  const body: unknown[] = [hero(theme, loc), text(title, { size: 'xs', color: MUTED, weight: 'bold', margin: 'lg' })]
  shown.forEach((p, i) => body.push(personRow(p, i === 0)))
  body.push(...notes(report, loc, loc.people.slice(top)))
  return bubble(header(theme, report), body)
}

/** carousel: Workshop แล้วต่อด้วย Site */
export function flexConsecutiveAbsence(report: AbsenceReport, top = ABSENCE_TOP_DEFAULT) {
  return { type: 'carousel', contents: report.locations.map((loc) => locationBubble(report, loc, top)) }
}

export function absenceAltText(report: AbsenceReport): string {
  const parts = report.locations.map((l) => `${l.location} ${l.people.length} คน`)
  return `🔔 ขาดงานติดต่อกัน ${report.minDays} วันขึ้นไป (ถึง ${formatThaiDateShort(report.asOf)}): ${parts.join(' · ')}`.slice(0, 400)
}

/** ข้อความสรุปสำหรับพิมพ์ใน CLI */
export function absenceText(report: AbsenceReport): string {
  const lines = [`ขาดงานติดต่อกัน >= ${report.minDays} วันทำงาน (ข้อมูลถึง ${report.asOf}, ยังเคลื่อนไหว = สแกนใน ${report.activeDays} วัน)`]
  for (const loc of report.locations) {
    lines.push(`  ${loc.location}: ${loc.people.length} คน จาก ${loc.activePeople} คน (ไม่สแกนเกิน ${report.activeDays} วันอีก ${loc.stale} คน)`)
    for (const p of loc.people) {
      lines.push(`    ${String(p.streak).padStart(2)} วัน  ${p.empCode}  ${p.name}  ${p.department ?? '-'} / ${p.position ?? '-'}  สแกนล่าสุด ${p.lastScan}${p.foreman ? `  หัวหน้า ${p.foreman}` : ''}`)
    }
  }
  return lines.join('\n')
}
