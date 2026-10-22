import { CARD, HEADER_SUB, INK, MUTED, THEMES, TRACK, bubble, chip, text, type Theme } from './absenceFlex'
import { formatThaiDate } from './attendanceQuery'
import type { PerfectAttendanceReport, PerfectLocationReport, PerfectPerson } from './perfectAttendance'

// ---------------------------------------------------------------------------
// Flex Message "พนักงานเข้างานดีเด่นประจำเดือน" - carousel 2 ใบ (Workshop / Site) ใบละ Top N (ค่าเริ่มต้น 10)
//
// แนวคิดดีไซน์ (การ์ดชื่นชม ไม่ใช่การ์ดติดตาม จึงโทนอุ่น เป็นมิตร แต่ยังอยู่ในชุดเดียวกับการ์ดขาดงาน/มาสาย)
//   - หัวการ์ดสีเข้มตามสถานที่ (เขียว Workshop / น้ำเงิน Site) ป้าย 🏆 + ชื่อเดือน ปัดดูอีกสถานที่ได้ทันที
//   - ภาพรวม: ตัวเลขใหญ่ "กี่คน" ผ่านครบทุกเกณฑ์ + สัดส่วน แล้ว 3 ช่องเกณฑ์ ✅ ไม่ขาด / ⏰ ไม่สาย / 🌴 ไม่ลา
//     สีเขียวอ่อนตัวเข้มเดียวกัน บอกเกณฑ์ให้เห็นในแวบเดียวโดยไม่ต้องอ่านหมายเหตุ
//   - รายชื่อ: อันดับ 1-3 เป็นเหรียญ 🥇🥈🥉 บนพื้นทอง/เงิน/ทองแดงอ่อน ที่เหลือเป็นตัวเลขบนพื้นเทาอ่อน
//     ขวาคือชื่อ (ชื่อเล่น) แผนก · ตำแหน่ง · รหัส และบรรทัดเด่น "มาก่อนเวลาเฉลี่ย X นาที · สแกนเฉลี่ย HH:mm"
//   - ท้ายการ์ด: และอีกกี่คนที่ผ่านเกณฑ์ (ทุกคนได้เครดิต ไม่ใช่แค่ 10 คน) + กล่องขอบคุณ
//   - ไม่มีใครผ่าน = การ์ดให้กำลังใจ ไม่ใช่การ์ดว่าง
// กติกา LINE for PC + อ่านง่ายบนมือถือ: สีทึบเท่านั้น ไม่มี box ว่าง ไม่ใช้ offset/alignItems ทุกข้อความ wrap
// ตัวเล็กสุด xs สีจางสุด MUTED ไม่มีตัวขาวบนสีสด
// ---------------------------------------------------------------------------

export const PERFECT_TOP_DEFAULT = 10

const THAI_MONTHS = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม']

/** พื้น/ตัวของเหรียญอันดับ 1-3 และอันดับอื่น */
const MEDALS: { emoji: string; bg: string; fg: string }[] = [
  { emoji: '🥇', bg: '#FEF3C7', fg: '#B45309' },
  { emoji: '🥈', bg: '#F1F5F9', fg: '#475569' },
  { emoji: '🥉', bg: '#FFEDD5', fg: '#C2410C' }
]
const RANK_BG = '#F3F4F6'
const RANK_FG = '#374151'
const PASS_BG = '#ECFDF5'
const PASS_FG = '#047857'
const GOLD_BG = '#FFFBEB'
const GOLD_FG = '#92400E'

function fmt(n: number): string {
  return n.toLocaleString('en-US')
}

/** "กันยายน 2569" */
export function thaiMonthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number)
  return `${THAI_MONTHS[m - 1]} ${y + 543}`
}

function header(theme: Theme, report: PerfectAttendanceReport, loc: PerfectLocationReport) {
  const range = report.partial ? `ข้อมูลถึง ${formatThaiDate(report.end)} (ยังไม่จบเดือน)` : `วันทำงาน ${fmt(loc.workdays)} วัน`
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
          text('🏆 พนักงานเข้างานดีเด่น', { size: 'xs', color: HEADER_SUB, weight: 'bold', flex: 1, gravity: 'center' }),
          chip(theme.label, theme.chipBg, theme.chipFg)
        ]
      },
      text('ไม่ขาด · ไม่สาย · ไม่ลา', { size: 'xl', weight: 'bold', color: '#FFFFFF', margin: 'sm' }),
      text(`ประจำเดือน${thaiMonthLabel(report.month)} · ${range}`, { size: 'xs', color: HEADER_SUB })
    ]
  }
}

function criteriaTile(emoji: string, label: string, detail: string) {
  return {
    type: 'box',
    layout: 'vertical',
    flex: 1,
    backgroundColor: PASS_BG,
    cornerRadius: '10px',
    paddingTop: '8px',
    paddingBottom: '8px',
    paddingStart: '4px',
    paddingEnd: '4px',
    contents: [
      text(`${emoji} ${label}`, { size: 'sm', weight: 'bold', color: PASS_FG, align: 'center' }),
      text(detail, { size: 'xs', color: PASS_FG, align: 'center' })
    ]
  }
}

function hero(theme: Theme, loc: PerfectLocationReport) {
  const pct = loc.staff > 0 ? (loc.people.length / loc.staff) * 100 : 0
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
              text('ผ่านครบทุกเกณฑ์ทั้งเดือน', { size: 'xs', color: MUTED })
            ]
          },
          {
            type: 'box',
            layout: 'vertical',
            flex: 0,
            contents: [
              text(`${pct.toLocaleString('en-US', { maximumFractionDigits: 1 })}%`, { size: 'xl', weight: 'bold', color: INK, align: 'end' }),
              text(`จาก ${fmt(loc.staff)} คน`, { size: 'xs', color: MUTED, align: 'end' })
            ]
          }
        ]
      },
      {
        type: 'box',
        layout: 'horizontal',
        spacing: 'sm',
        margin: 'md',
        contents: [
          criteriaTile('✅', 'ไม่ขาด', `ครบ ${fmt(loc.workdays)} วัน`),
          criteriaTile('⏰', 'ไม่สาย', `ก่อน ${loc.startTime} น.`),
          criteriaTile('🌴', 'ไม่ลา', '0 วัน')
        ]
      }
    ]
  }
}

function rankBadge(rank: number) {
  const medal = MEDALS[rank - 1]
  return {
    type: 'box',
    layout: 'vertical',
    width: '48px',
    flex: 0,
    backgroundColor: medal?.bg ?? RANK_BG,
    cornerRadius: '10px',
    paddingTop: '6px',
    paddingBottom: '6px',
    contents: medal
      ? [text(medal.emoji, { size: 'xl', align: 'center' }), text(`#${rank}`, { size: 'xs', weight: 'bold', color: medal.fg, align: 'center' })]
      : [text(String(rank), { size: 'lg', weight: 'bold', color: RANK_FG, align: 'center' }), text('อันดับ', { size: 'xs', color: RANK_FG, align: 'center' })]
  }
}

function personRow(theme: Theme, p: PerfectPerson, first: boolean) {
  const name = p.nickname ? `${p.name} (${p.nickname})` : p.name
  const role = [p.department, p.position].filter((x): x is string => !!x)
  // ตำแหน่งมักขึ้นต้นด้วยชื่อแผนก ("HSE" + "HSE Officer") ไม่ต้องพูดซ้ำ
  if (role.length === 2 && role[1].toLowerCase().startsWith(role[0].toLowerCase())) role.shift()
  const highlight = p.avgEarlyMinutes > 0 ? `มาก่อนเวลาเฉลี่ย ${fmt(p.avgEarlyMinutes)} นาที` : 'มาตรงเวลาทุกวัน'
  const extra = p.scanDays > p.workdays ? ` · มาเพิ่ม ${fmt(p.scanDays - p.workdays)} วันหยุด` : ''
  const medal = MEDALS[p.rank - 1]

  return {
    type: 'box',
    layout: 'horizontal',
    spacing: 'md',
    margin: first ? 'lg' : 'md',
    contents: [
      rankBadge(p.rank),
      {
        type: 'box',
        layout: 'vertical',
        flex: 1,
        contents: [
          text(name, { size: 'sm', weight: 'bold', color: INK }),
          text(`${role.length > 0 ? role.join(' · ') : 'ไม่ระบุแผนก'} · ${p.empCode}`, { size: 'xs', color: MUTED }),
          text(highlight, { size: 'xs', weight: 'bold', color: medal?.fg ?? theme.ink, margin: 'xs' }),
          text(`🕖 สแกนเฉลี่ย ${p.avgTimeIn} น. · เช้าสุด ${p.earliestTimeIn} น.${extra}`, { size: 'xs', color: MUTED })
        ]
      }
    ]
  }
}

function thanksBox(message: string) {
  return {
    type: 'box',
    layout: 'vertical',
    backgroundColor: GOLD_BG,
    cornerRadius: '10px',
    paddingAll: '10px',
    margin: 'md',
    contents: [text(message, { size: 'xs', color: GOLD_FG })]
  }
}

function notes(report: PerfectAttendanceReport, loc: PerfectLocationReport, hidden: PerfectPerson[]): unknown[] {
  const lines: string[] = []
  if (hidden.length > 0) lines.push(`➕ และอีก ${fmt(hidden.length)} คนที่ผ่านครบทุกเกณฑ์เช่นกัน เก่งมากทุกคน`)
  lines.push(
    `เรียงจากมาก่อนเวลาเข้างานเฉลี่ยมากสุด นับจากสแกนนิ้วทุกวันทำงาน จ.-ส. (ไม่รวมวันหยุดบริษัท) ไม่มีวันลาใน bPlus เฉพาะพนักงานที่ยังทำงานอยู่`
  )
  return [
    { type: 'separator', color: TRACK, margin: 'lg' },
    ...lines.map((line, i) => text(line, { size: 'xs', color: MUTED, margin: i === 0 ? 'md' : 'xs' })),
    thanksBox(
      report.partial
        ? '💪 เดือนนี้ยังไม่จบ รักษาสถิติไว้ให้ถึงสิ้นเดือนนะครับ ขอบคุณที่มาทำงานสม่ำเสมอและตรงเวลา'
        : '🎉 ขอบคุณทุกคนที่มาทำงานสม่ำเสมอและตรงเวลาตลอดทั้งเดือน ความตั้งใจของคุณคือพลังของทีม'
    )
  ]
}

function emptyBody(theme: Theme, loc: PerfectLocationReport, report: PerfectAttendanceReport): unknown[] {
  return [
    {
      type: 'box',
      layout: 'vertical',
      backgroundColor: theme.chipBg,
      cornerRadius: '12px',
      paddingAll: '18px',
      contents: [
        text('🌱', { size: '3xl', align: 'center' }),
        text('เดือนนี้ยังไม่มีใครผ่านครบทุกเกณฑ์', { size: 'md', weight: 'bold', color: theme.chipFg, align: 'center', margin: 'sm' }),
        text(
          `จากพนักงาน ${fmt(loc.staff)} คน วันทำงาน ${fmt(loc.workdays)} วัน เริ่มใหม่เดือนหน้าได้เลย มาครบ มาทัน ${loc.startTime} น. ก็ติดอันดับแล้ว`,
          { size: 'xs', color: '#374151', align: 'center', margin: 'xs' }
        )
      ]
    },
    thanksBox(report.partial ? '💪 เดือนนี้ยังไม่จบ ยังมีโอกาสครับ' : '🙏 ขอบคุณทุกคนที่ตั้งใจทำงาน เดือนหน้ามาลุ้นกันใหม่')
  ]
}

function locationBubble(report: PerfectAttendanceReport, loc: PerfectLocationReport, top: number) {
  const theme = THEMES[loc.location]
  if (loc.people.length === 0) return bubble(header(theme, report, loc), emptyBody(theme, loc, report))
  const shown = loc.people.slice(0, top)
  const title = loc.people.length > top ? `${top} อันดับแรก (มาก่อนเวลามากสุด)` : 'รายชื่อ (มาก่อนเวลามากสุดก่อน)'
  const body: unknown[] = [hero(theme, loc), text(title, { size: 'xs', color: MUTED, weight: 'bold', margin: 'lg' })]
  shown.forEach((p, i) => body.push(personRow(theme, p, i === 0)))
  body.push(...notes(report, loc, loc.people.slice(top)))
  return bubble(header(theme, report, loc), body)
}

/** carousel: Workshop แล้วต่อด้วย Site */
export function flexPerfectAttendance(report: PerfectAttendanceReport, top = PERFECT_TOP_DEFAULT) {
  return { type: 'carousel', contents: report.locations.map((loc) => locationBubble(report, loc, top)) }
}

export function perfectAttendanceAltText(report: PerfectAttendanceReport): string {
  const parts = report.locations.map((l) => `${l.location} ${l.people.length} คน`)
  return `🏆 พนักงานเข้างานดีเด่น ${thaiMonthLabel(report.month)} (ไม่ขาด ไม่สาย ไม่ลา): ${parts.join(' · ')}`.slice(0, 400)
}

/** ข้อความสรุปสำหรับพิมพ์ใน CLI */
export function perfectAttendanceText(report: PerfectAttendanceReport): string {
  const lines = [`พนักงานเข้างานดีเด่น ${thaiMonthLabel(report.month)} (${report.start} ถึง ${report.end}${report.partial ? ', ยังไม่จบเดือน' : ''})`]
  for (const loc of report.locations) {
    lines.push(
      `  ${loc.location} (เข้างาน ${loc.startTime}, วันทำงาน ${loc.workdays} วัน): ผ่าน ${loc.people.length} จาก ${loc.staff} คน | ไม่ผ่าน: ขาด ${loc.missed.absent} สาย ${loc.missed.late} ลา ${loc.missed.leave}`
    )
    for (const p of loc.people) {
      lines.push(
        `    #${String(p.rank).padStart(2)}  ${p.empCode}  ${p.name}  ${p.department ?? '-'} / ${p.position ?? '-'}  ก่อนเวลาเฉลี่ย ${p.avgEarlyMinutes} นาที  สแกนเฉลี่ย ${p.avgTimeIn}  มา ${p.scanDays} วัน`
      )
    }
  }
  return lines.join('\n')
}
