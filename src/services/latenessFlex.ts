import { CARD, HEADER_SUB, INK, MUTED, THEMES, TRACK, bubble, chip, text, type Theme } from './absenceFlex'
import { formatThaiDate, formatThaiDateShort } from './attendanceQuery'
import type { LatePerson, LatenessLocationReport, LatenessReport } from './lateness'

// ---------------------------------------------------------------------------
// Flex Message "มาสายติดต่อกัน" - carousel 2 ใบ (Workshop / Site) ใบละ Top N คนที่สายติดกันนานสุด (ค่าเริ่มต้น 10)
//
// แนวคิดดีไซน์ (ชุดเดียวกับการ์ด "ขาดงานติดต่อกัน" ใน absenceFlex.ts)
//   - หัวการ์ดสีเข้มตามสถานที่ บอกเวลาเข้างานของที่นั้นให้ชัด (Workshop 08:00 / Site 07:40)
//   - ภาพรวม: กี่คนสายติดต่อกัน + วันทำงานล่าสุดสายกี่คนจากที่มากี่คน แล้วแยกระดับสีอ่อน ตัวเข้มสีเดียวกัน
//     2 วัน (เหลือง) / 3-4 วัน (ส้ม) / 5 วันขึ้นไป (แดง)
//   - แต่ละคน: ช่องซ้ายคือจำนวนวันที่สายติดกัน ขวาคือชื่อ แผนก · ตำแหน่ง, สายเฉลี่ยกี่นาที (ตัวหนาสีตามระดับ)
//     และเวลาสแกนแต่ละวัน ให้หัวหน้าเห็นรูปแบบทันทีว่าสายนิดหน่อยหรือสายมาก
//   - ไม่มีใครสายติดกัน = การ์ดชื่นชม ท้ายการ์ดชวนคุยแบบเป็นมิตร ไม่ใช่ประจาน
// กติกา LINE for PC + อ่านง่ายบนมือถือ: สีทึบ ไม่มี box ว่าง ไม่ใช้ offset/alignItems ทุกข้อความ wrap ตัวเล็กสุด xs
// ---------------------------------------------------------------------------

export const LATENESS_TOP_DEFAULT = 10
/** แสดงเวลาสแกนย้อนหลังกี่วันในแถวของแต่ละคน */
const DAYS_SHOWN = 5

interface Tier {
  label: string
  min: number
  bg: string
  fg: string
}

const TIERS: Tier[] = [
  { label: '5 วันขึ้นไป', min: 5, bg: '#FEF2F2', fg: '#B91C1C' },
  { label: '3-4 วัน', min: 3, bg: '#FFF7ED', fg: '#C2410C' },
  { label: '2 วัน', min: 0, bg: '#FFFBEB', fg: '#B45309' }
]

function tierOf(streak: number): Tier {
  return TIERS.find((t) => streak >= t.min) ?? TIERS[TIERS.length - 1]
}

function fmt(n: number): string {
  return n.toLocaleString('en-US')
}

function header(theme: Theme, report: LatenessReport, loc: LatenessLocationReport) {
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
          text('⏰ ติดตามการมาสาย', { size: 'xs', color: HEADER_SUB, weight: 'bold', flex: 1, gravity: 'center' }),
          chip(theme.label, theme.chipBg, theme.chipFg)
        ]
      },
      text('มาสายติดต่อกัน', { size: 'xl', weight: 'bold', color: '#FFFFFF', margin: 'sm' }),
      text(`เข้างานหลัง ${loc.startTime} น. ตั้งแต่ ${report.minDays} วันขึ้นไป · ข้อมูลถึง ${formatThaiDate(report.asOf)}`, {
        size: 'xs',
        color: HEADER_SUB
      })
    ]
  }
}

function tierTile(tier: Tier, people: LatePerson[]) {
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

function hero(theme: Theme, loc: LatenessLocationReport) {
  const lastDay = loc.lastWorkday ? formatThaiDateShort(loc.lastWorkday) : '-'
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
              text(`${fmt(loc.people.length)} คน`, { size: '3xl', weight: 'bold', color: theme.ink }),
              text('มาสายติดต่อกัน', { size: 'xs', color: MUTED })
            ]
          },
          {
            type: 'box',
            layout: 'vertical',
            flex: 0,
            contents: [
              text(`${fmt(loc.lateOnLastDay)} คน`, { size: 'xl', weight: 'bold', color: INK, align: 'end' }),
              text(`สาย ${lastDay}`, { size: 'xs', color: MUTED, align: 'end' }),
              text(`จาก ${fmt(loc.attended)} คนที่มา`, { size: 'xs', color: MUTED, align: 'end' })
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

function personRow(p: LatePerson, first: boolean) {
  const tier = tierOf(p.streak)
  const name = p.nickname ? `${p.name} (${p.nickname})` : p.name
  const role = [p.department, p.position].filter((x): x is string => !!x)
  if (role.length === 2 && role[1].toLowerCase().startsWith(role[0].toLowerCase())) role.shift()
  const lead = [`สายเฉลี่ย ${p.avgLateMinutes} นาที`]
  if (p.foreman && p.foreman.replace(/\s+/g, '') !== p.name.replace(/\s+/g, '')) lead.push(`หัวหน้า ${p.foreman}`)
  const times = p.days
    .slice(0, DAYS_SHOWN)
    .map((d) => `${formatThaiDateShort(d.date)} ${d.time}`)
    .join(' · ')

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
          text(`${role.length > 0 ? role.join(' · ') : 'ไม่ระบุแผนก'} · ${p.empCode}`, { size: 'xs', color: MUTED }),
          text(lead.join(' · '), { size: 'xs', weight: 'bold', color: tier.fg, margin: 'xs' }),
          text(`🕗 ${times}${p.days.length > DAYS_SHOWN ? ' …' : ''}`, { size: 'xs', color: MUTED })
        ]
      }
    ]
  }
}

function notes(report: LatenessReport, loc: LatenessLocationReport, hidden: LatePerson[]): unknown[] {
  const lines: string[] = []
  if (hidden.length > 0) {
    const lo = Math.min(...hidden.map((p) => p.streak))
    const hi = Math.max(...hidden.map((p) => p.streak))
    lines.push(`➕ และอีก ${hidden.length} คนที่สายติดกัน ${lo === hi ? lo : `${lo}-${hi}`} วัน`)
  }
  lines.push(
    `นับจากสแกนแรกของวัน หลัง ${loc.startTime} น. (สแกนแรกตั้งแต่ ${report.maxTime} น. ไม่นับ มักลืมสแกนเช้า) ข้ามวันที่ไม่ได้มาทำงาน เฉพาะพนักงานที่ยังทำงานอยู่`
  )
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
      contents: [
        text('☕ ลองชวนคุยกันเบา ๆ อาจติดเรื่องการเดินทางหรือธุระที่บ้าน ช่วยกันหาทางให้มาทันเวลา', { size: 'xs', color: '#374151' })
      ]
    }
  ]
}

function emptyBody(theme: Theme, loc: LatenessLocationReport): unknown[] {
  const lastDay = loc.lastWorkday ? formatThaiDateShort(loc.lastWorkday) : null
  return [
    {
      type: 'box',
      layout: 'vertical',
      backgroundColor: theme.chipBg,
      cornerRadius: '12px',
      paddingAll: '18px',
      contents: [
        text('⏰✨', { size: '3xl', align: 'center' }),
        text('ไม่มีใครมาสายติดต่อกัน', { size: 'md', weight: 'bold', color: theme.chipFg, align: 'center', margin: 'sm' }),
        text(
          lastDay
            ? `${lastDay} มา ${fmt(loc.attended)} คน สายเพียง ${fmt(loc.lateOnLastDay)} คน ขอบคุณที่มาตรงเวลาครับ`
            : 'ขอบคุณที่มาตรงเวลาครับ',
          { size: 'xs', color: '#374151', align: 'center', margin: 'xs' }
        )
      ]
    }
  ]
}

function locationBubble(report: LatenessReport, loc: LatenessLocationReport, top: number) {
  const theme = THEMES[loc.location]
  if (loc.people.length === 0) return bubble(header(theme, report, loc), emptyBody(theme, loc))
  const title = loc.people.length > top ? `${top} อันดับที่สายติดกันนานสุด` : 'รายชื่อ (สายติดกันนานสุดก่อน)'
  const body: unknown[] = [hero(theme, loc), text(title, { size: 'xs', color: MUTED, weight: 'bold', margin: 'lg' })]
  loc.people.slice(0, top).forEach((p, i) => body.push(personRow(p, i === 0)))
  body.push(...notes(report, loc, loc.people.slice(top)))
  return bubble(header(theme, report, loc), body)
}

/** carousel: Workshop แล้วต่อด้วย Site */
export function flexConsecutiveLateness(report: LatenessReport, top = LATENESS_TOP_DEFAULT) {
  return { type: 'carousel', contents: report.locations.map((loc) => locationBubble(report, loc, top)) }
}

export function latenessAltText(report: LatenessReport): string {
  const parts = report.locations.map((l) => `${l.location} ${l.people.length} คน`)
  return `⏰ มาสายติดต่อกัน ${report.minDays} วันขึ้นไป (ถึง ${formatThaiDateShort(report.asOf)}): ${parts.join(' · ')}`.slice(0, 400)
}

/** ข้อความสรุปสำหรับพิมพ์ใน CLI */
export function latenessText(report: LatenessReport): string {
  const lines = [`มาสายติดต่อกัน >= ${report.minDays} วันทำงาน (ข้อมูลถึง ${report.asOf}, สแกนแรกตั้งแต่ ${report.maxTime} ไม่นับ)`]
  for (const loc of report.locations) {
    lines.push(
      `  ${loc.location} (เข้างาน ${loc.startTime}): ${loc.people.length} คน | วันทำงานล่าสุด ${loc.lastWorkday ?? '-'} สาย ${loc.lateOnLastDay}/${loc.attended} คน`
    )
    for (const p of loc.people) {
      const days = p.days.map((d) => `${d.date.slice(5)} ${d.time}`).join(', ')
      lines.push(`    ${String(p.streak).padStart(2)} วัน  ${p.empCode}  ${p.name}  ${p.department ?? '-'} / ${p.position ?? '-'}  เฉลี่ย ${p.avgLateMinutes} นาที  [${days}]`)
    }
  }
  return lines.join('\n')
}
