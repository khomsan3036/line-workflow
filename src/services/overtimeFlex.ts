import { formatThaiDateShort, type PeriodKey } from './attendanceQuery'
import type { OtLocation, OtLocationRanking, OtPerson, OtRanking, PersonalOvertime } from './overtime'

// ---------------------------------------------------------------------------
// Flex Message "Top 10 OT สะสม" (จำนวนอันดับตาม OtRanking.limit) - carousel 2 ใบ (Workshop / Site)
//
// แนวคิดดีไซน์
//   - หัวการ์ดสีเข้มตามสถานที่ (เขียว Workshop / น้ำเงิน Site แบบเดียวกับการ์ดสรุปการเข้างาน) ปัดดูอีกสถานที่ได้ทันที
//   - แถบตัวเลขรวม (OT รวม / คนทำ OT / เฉลี่ย) ให้เห็นภาพรวมก่อนดูรายคน
//   - อันดับ 1 อยู่ในกรอบสีทองอ่อนให้เด่น อันดับ 1-3 ใช้เหรียญ 🥇🥈🥉 อันดับถัดไปเป็นเลขในวงกลมเทา
//   - ชั่วโมงตัวใหญ่ชิดขวา บรรทัดรองบอกแผนก · ตำแหน่ง และวันที่ทำ OT + ตัวคูณ (ให้ HR ตรวจที่มาได้)
// กติกาเดียวกับการ์ดอื่น (LINE for PC + อ่านง่ายบนมือถือ): สีทึบเท่านั้น ไม่มี box ว่างเป็นแถบสี ไม่ใช้ offset/alignItems
// ทุกข้อความ wrap: true ตัวเล็กสุด xs สีจางสุด MUTED และไม่มีตัวขาวบนสีสด
// ---------------------------------------------------------------------------

const INK = '#111827'
const MUTED = '#6B7280'
const TRACK = '#E5E7EB'
const CARD = '#F8FAFC'
const HEADER_SUB = '#E2E8F0'

const GOLD_SOFT = '#FFFBEB'
const GOLD_LINE = '#FDE68A'
const GOLD_INK = '#B45309'

interface Theme {
  label: string
  /** พื้นหัวการ์ด (สีเข้ม ตัวขาวอ่านชัด) */
  header: string
  /** ป้ายบนหัวการ์ด */
  chipBg: string
  chipFg: string
  /** สีตัวเลขชั่วโมง */
  ink: string
}

const THEMES: Record<OtLocation, Theme> = {
  Workshop: { label: '🏭 Workshop', header: '#065F46', chipBg: '#ECFDF5', chipFg: '#047857', ink: '#047857' },
  Site: { label: '🏗️ Site', header: '#1E3A8A', chipBg: '#EFF6FF', chipFg: '#1D4ED8', ink: '#1D4ED8' }
}

const MEDALS: Record<number, string> = { 1: '🥇', 2: '🥈', 3: '🥉' }

const TITLES: Record<PeriodKey, string> = {
  today: 'ขยันสุดประจำวัน',
  yesterday: 'ขยันสุดประจำวัน',
  date: 'ขยันสุดประจำวัน',
  thisWeek: 'ขยันสุดประจำสัปดาห์',
  lastWeek: 'ขยันสุดประจำสัปดาห์',
  thisMonth: 'ขยันสุดประจำเดือน',
  lastMonth: 'ขยันสุดประจำเดือน'
}

/** ชั่วโมง: หลักร้อยขึ้นไปเป็นจำนวนเต็มมีจุลภาค ต่ำกว่านั้นทศนิยมไม่เกิน 1 ตำแหน่ง */
function fmtHours(h: number): string {
  if (h >= 100) return Math.round(h).toLocaleString('en-US')
  return (Math.round(h * 10) / 10).toLocaleString('en-US', { maximumFractionDigits: 1 })
}

function chip(text: string, bg: string, fg: string) {
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
    contents: [{ type: 'text', text, size: 'xs', color: fg, weight: 'bold', wrap: true }]
  }
}

function header(theme: Theme, ranking: OtRanking) {
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
          { type: 'text', text: `🏆 TOP ${ranking.limit} OT สะสม`, size: 'xs', color: HEADER_SUB, weight: 'bold', flex: 1, gravity: 'center', wrap: true },
          chip(theme.label, theme.chipBg, theme.chipFg)
        ]
      },
      { type: 'text', text: TITLES[ranking.period.key], size: 'xl', weight: 'bold', color: '#FFFFFF', margin: 'sm', wrap: true },
      { type: 'text', text: ranking.period.label, size: 'xs', color: HEADER_SUB, wrap: true }
    ]
  }
}

function statCell(value: string, label: string, color = INK) {
  return {
    type: 'box',
    layout: 'vertical',
    flex: 1,
    contents: [
      { type: 'text', text: value, size: 'md', weight: 'bold', color, align: 'center', wrap: true },
      { type: 'text', text: label, size: 'xs', color: MUTED, align: 'center', margin: 'xs', wrap: true }
    ]
  }
}

function stats(theme: Theme, loc: OtLocationRanking) {
  const avg = loc.people > 0 ? loc.totalHours / loc.people : 0
  return {
    type: 'box',
    layout: 'horizontal',
    backgroundColor: CARD,
    cornerRadius: '12px',
    paddingAll: '12px',
    contents: [
      statCell(fmtHours(loc.totalHours), 'OT รวม (ชม.)', theme.ink),
      { type: 'separator', color: TRACK },
      statCell(loc.people.toLocaleString('en-US'), 'คนทำ OT'),
      { type: 'separator', color: TRACK },
      statCell(fmtHours(avg), 'เฉลี่ย ชม./คน')
    ]
  }
}

/** ช่องอันดับด้านซ้าย: เหรียญสำหรับ 1-3, เลขในวงกลมเทาสำหรับอันดับถัดไป */
function rankBadge(rank: number) {
  const medal = MEDALS[rank]
  if (medal) {
    return {
      type: 'box',
      layout: 'vertical',
      width: '36px',
      flex: 0,
      contents: [{ type: 'text', text: medal, size: 'xxl', align: 'center', gravity: 'center', wrap: true }]
    }
  }
  return {
    type: 'box',
    layout: 'vertical',
    width: '36px',
    flex: 0,
    paddingTop: '4px',
    contents: [
      {
        type: 'box',
        layout: 'vertical',
        width: '30px',
        height: '30px',
        cornerRadius: '999px',
        backgroundColor: '#F3F4F6',
        paddingTop: '5px',
        contents: [{ type: 'text', text: String(rank), size: 'sm', weight: 'bold', color: '#374151', align: 'center', wrap: true }]
      }
    ]
  }
}

function subLine(p: OtPerson): string {
  const parts = [p.department, p.position].filter((x): x is string => !!x)
  // ตำแหน่งมักขึ้นต้นด้วยชื่อแผนก ("HSE" + "HSE Officer") ไม่ต้องพูดซ้ำ
  if (parts.length === 2 && parts[1].toLowerCase().startsWith(parts[0].toLowerCase())) parts.shift()
  return parts.length > 0 ? parts.join(' · ') : `รหัส ${p.empCode}`
}

function rateLine(p: OtPerson): string {
  const rates = Object.entries(p.byRate).map(([rate, h]) => `${rate} ${fmtHours(h)}`)
  return [`${p.days} วัน`, ...rates].join(' · ')
}

function personRow(p: OtPerson, theme: Theme, first: boolean) {
  const champion = p.rank === 1
  const displayName = p.nickname ? `${p.name} (${p.nickname})` : p.name
  const row = {
    type: 'box',
    layout: 'horizontal',
    spacing: 'md',
    contents: [
      rankBadge(p.rank),
      {
        type: 'box',
        layout: 'vertical',
        flex: 1,
        contents: [
          { type: 'text', text: displayName, size: 'sm', weight: 'bold', color: INK, wrap: true },
          { type: 'text', text: subLine(p), size: 'xs', color: MUTED, margin: 'xs', wrap: true },
          { type: 'text', text: rateLine(p), size: 'xs', color: MUTED, wrap: true }
        ]
      },
      {
        type: 'box',
        layout: 'vertical',
        flex: 0,
        contents: [
          {
            type: 'text',
            text: fmtHours(p.hours),
            size: champion ? 'xxl' : 'xl',
            weight: 'bold',
            color: champion ? GOLD_INK : theme.ink,
            align: 'end',
            wrap: true
          },
          { type: 'text', text: 'ชม.', size: 'xs', color: MUTED, align: 'end', wrap: true }
        ]
      }
    ]
  }
  if (!champion) return { ...row, margin: first ? 'lg' : 'md' }
  // อันดับ 1 อยู่ในกรอบสีทองอ่อน
  return {
    type: 'box',
    layout: 'vertical',
    margin: first ? 'lg' : 'md',
    backgroundColor: GOLD_SOFT,
    borderColor: GOLD_LINE,
    borderWidth: '1px',
    cornerRadius: '12px',
    paddingAll: '12px',
    contents: [row]
  }
}

function footnote(ranking: OtRanking, loc: OtLocationRanking): unknown[] {
  const notes: string[] = []
  const last = loc.top.at(-1)
  if (loc.tiedOut > 0 && last) notes.push(`มีอีก ${loc.tiedOut} คนที่ได้ ${fmtHours(last.hours)} ชม. เท่ากับอันดับ ${last.rank}`)
  if (ranking.lastDataDate && ranking.lastDataDate < ranking.period.end && ranking.lastDataDate >= ranking.period.start) {
    notes.push(`ข้อมูล OT ถึงวันที่ ${formatThaiDateShort(ranking.lastDataDate)}`)
  }
  notes.push('นับ OT x1 · x1.5 · x2 · x3 ที่ bPlus คำนวณแล้ว แต่ละวันนับตามสถานที่ที่สแกนเข้างาน')
  return [
    { type: 'separator', color: TRACK, margin: 'lg' },
    ...notes.map((text, i) => ({ type: 'text', text, size: 'xs', color: MUTED, margin: i === 0 ? 'md' : 'xs', wrap: true }))
  ]
}

function locationBubble(ranking: OtRanking, loc: OtLocationRanking) {
  const theme = THEMES[loc.location]
  const body: unknown[] = [stats(theme, loc)]
  if (loc.top.length === 0) {
    body.push({
      type: 'text',
      text: 'ยังไม่มีข้อมูล OT ในช่วงนี้',
      size: 'sm',
      color: MUTED,
      align: 'center',
      margin: 'xl',
      wrap: true
    })
  } else {
    body.push({ type: 'text', text: `${ranking.limit} อันดับสูงสุด`, size: 'xs', color: MUTED, weight: 'bold', margin: 'lg', wrap: true })
    loc.top.forEach((p, i) => {
      if (i > 0 && loc.top[i - 1].rank !== 1) body.push({ type: 'separator', color: TRACK, margin: 'md' })
      body.push(personRow(p, theme, i === 0))
    })
  }
  body.push(...footnote(ranking, loc))

  return {
    type: 'bubble',
    size: 'mega',
    header: header(theme, ranking),
    body: { type: 'box', layout: 'vertical', paddingAll: '16px', contents: body }
  }
}

/** carousel: Workshop แล้วต่อด้วย Site */
export function flexOvertimeRanking(ranking: OtRanking) {
  return { type: 'carousel', contents: ranking.locations.map((loc) => locationBubble(ranking, loc)) }
}

export function overtimeAltText(ranking: OtRanking): string {
  const leaders = ranking.locations
    .map((l) => (l.top[0] ? `${l.location}: ${l.top[0].name.split(' ')[0]} ${fmtHours(l.top[0].hours)} ชม.` : null))
    .filter(Boolean)
  return [`🏆 Top ${ranking.limit} OT ${ranking.period.label}`, ...leaders].join(' · ').slice(0, 400)
}

/** คำถามที่บอทเข้าใจ (ใช้ทั้ง quick reply และตัวอย่างในข้อความช่วยเหลือ) */
export const OT_QUESTION_SAMPLES = ['OT สัปดาห์นี้', 'OT สัปดาห์ที่แล้ว', 'OT เดือนนี้']

/** quick reply ใต้การ์ด: สลับช่วงเวลา / ดูเฉพาะสถานที่ (ช่วงเดิม) */
export function overtimeQuickReply(ranking: OtRanking, periodText: string) {
  const items: { label: string; text: string }[] = []
  const periods: Array<[PeriodKey, string]> = [
    ['thisWeek', 'สัปดาห์นี้'],
    ['lastWeek', 'สัปดาห์ที่แล้ว'],
    ['thisMonth', 'เดือนนี้'],
    ['lastMonth', 'เดือนที่แล้ว']
  ]
  for (const [key, phrase] of periods) {
    if (key !== ranking.period.key) items.push({ label: `OT ${phrase}`, text: `OT ${phrase}` })
  }
  if (ranking.locations.length > 1) {
    for (const loc of ranking.locations) items.push({ label: `OT ${loc.location}`, text: `OT ${loc.location} ${periodText}`.trim() })
  } else {
    items.push({ label: 'OT ทุกที่', text: `OT ${periodText}`.trim() })
  }
  return { items: items.map((i) => ({ type: 'action', action: { type: 'message', label: i.label.slice(0, 20), text: i.text } })) }
}

/** ข้อความสรุปสำหรับพิมพ์ใน CLI */
export function overtimeText(ranking: OtRanking): string {
  const lines = [`Top OT ${ranking.period.label} (ข้อมูลถึง ${ranking.lastDataDate ?? '-'})`]
  for (const loc of ranking.locations) {
    lines.push(`  ${loc.location}: OT รวม ${fmtHours(loc.totalHours)} ชม. / ${loc.people} คน`)
    for (const p of loc.top) {
      lines.push(`    ${p.rank}. ${p.name} [${p.empCode}] ${subLine(p)} - ${fmtHours(p.hours)} ชม. (${rateLine(p)})`)
    }
    if (loc.tiedOut > 0) lines.push(`    (+${loc.tiedOut} คนที่ชั่วโมงเท่ากับอันดับสุดท้าย)`)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// การ์ด "OT ของฉัน" (แชท 1:1 เท่านั้น): ยอดรวมตัวใหญ่ + ตัวคูณ + รายวัน
// ---------------------------------------------------------------------------

const NAVY = '#0C1628'
const MY_INK = '#1D4ED8'
const RATE_TONES: Record<string, { bg: string; fg: string }> = {
  x1: { bg: '#F3F4F6', fg: '#374151' },
  'x1.5': { bg: '#EFF6FF', fg: '#1D4ED8' },
  x2: { bg: '#F5F3FF', fg: '#6D28D9' },
  x3: { bg: GOLD_SOFT, fg: GOLD_INK }
}

function rateChips(byRate: Record<string, number>) {
  const chips = Object.entries(byRate).map(([rate, h]) => {
    const tone = RATE_TONES[rate] ?? RATE_TONES.x1
    return chip(`${rate} · ${fmtHours(h)} ชม.`, tone.bg, tone.fg)
  })
  // ป้ายกว้างเท่าข้อความ (filler กินที่เหลือ) ไม่ถูกตัดเป็น "..."
  return { type: 'box', layout: 'horizontal', spacing: 'sm', margin: 'md', contents: [...chips, { type: 'filler' }] }
}

function dayRow(d: PersonalOvertime['days'][number], first: boolean) {
  const rates = Object.entries(d.byRate)
    .map(([rate, h]) => `${rate} ${fmtHours(h)}`)
    .join(' · ')
  return {
    type: 'box',
    layout: 'horizontal',
    margin: first ? 'md' : 'sm',
    contents: [
      {
        type: 'box',
        layout: 'vertical',
        flex: 1,
        contents: [
          { type: 'text', text: formatThaiDateShort(d.date), size: 'sm', weight: 'bold', color: INK, wrap: true },
          { type: 'text', text: `${d.location} · ${rates}`, size: 'xs', color: MUTED, wrap: true }
        ]
      },
      { type: 'text', text: `${fmtHours(d.hours)} ชม.`, size: 'md', weight: 'bold', color: MY_INK, align: 'end', gravity: 'center', flex: 0, wrap: true }
    ]
  }
}

export function flexMyOvertime(ot: PersonalOvertime, name: string | null) {
  const body: unknown[] = []
  if (ot.days.length === 0) {
    body.push(
      { type: 'text', text: 'ยังไม่มี OT ในช่วงนี้', size: 'md', weight: 'bold', color: INK, align: 'center', wrap: true },
      {
        type: 'text',
        text: 'bPlus คำนวณ OT หลังวันทำงานผ่านไปแล้ว OT ของวันนี้จะขึ้นในวันถัดไป',
        size: 'xs',
        color: MUTED,
        align: 'center',
        margin: 'sm',
        wrap: true
      }
    )
  } else {
    body.push({
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
                { type: 'text', text: fmtHours(ot.hours), size: '3xl', weight: 'bold', color: MY_INK, wrap: true },
                { type: 'text', text: 'ชั่วโมง OT สะสม', size: 'xs', color: MUTED, wrap: true }
              ]
            },
            {
              type: 'box',
              layout: 'vertical',
              flex: 0,
              contents: [
                { type: 'text', text: String(ot.days.length), size: 'xl', weight: 'bold', color: INK, align: 'end', wrap: true },
                { type: 'text', text: 'วันที่มี OT', size: 'xs', color: MUTED, align: 'end', wrap: true }
              ]
            }
          ]
        },
        rateChips(ot.byRate)
      ]
    })
    body.push({ type: 'text', text: 'รายวัน', size: 'xs', color: MUTED, weight: 'bold', margin: 'lg', wrap: true })
    ot.days.forEach((d, i) => {
      if (i > 0) body.push({ type: 'separator', color: TRACK, margin: 'sm' })
      body.push(dayRow(d, i === 0))
    })
  }

  const notes: string[] = []
  if (ot.lastDataDate && ot.lastDataDate < ot.period.end && ot.lastDataDate >= ot.period.start) {
    notes.push(`ข้อมูล OT ถึงวันที่ ${formatThaiDateShort(ot.lastDataDate)}`)
  }
  notes.push('ชั่วโมงตามที่ bPlus คำนวณ ยอดเงินจริงดูที่สลิปเงินเดือน')
  body.push(
    { type: 'separator', color: TRACK, margin: 'lg' },
    ...notes.map((text, i) => ({ type: 'text', text, size: 'xs', color: MUTED, margin: i === 0 ? 'md' : 'xs', wrap: true }))
  )

  return {
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: NAVY,
      paddingAll: '18px',
      spacing: 'xs',
      contents: [
        { type: 'text', text: '⏱️ OT ของฉัน', size: 'xs', color: HEADER_SUB, weight: 'bold', wrap: true },
        { type: 'text', text: name ?? `รหัส ${ot.empCode}`, size: 'lg', weight: 'bold', color: '#FFFFFF', margin: 'sm', wrap: true },
        { type: 'text', text: ot.period.label, size: 'xs', color: HEADER_SUB, wrap: true }
      ]
    },
    body: { type: 'box', layout: 'vertical', paddingAll: '16px', contents: body }
  }
}

export function myOvertimeAltText(ot: PersonalOvertime): string {
  return ot.days.length === 0
    ? `OT ของฉัน ${ot.period.label}: ยังไม่มี OT`
    : `OT ของฉัน ${ot.period.label}: ${fmtHours(ot.hours)} ชม. (${ot.days.length} วัน)`
}

/** quick reply ของการ์ด OT ของฉัน: สลับช่วงเวลา */
export function myOvertimeQuickReply(current: PeriodKey) {
  const periods: Array<[PeriodKey, string]> = [
    ['thisWeek', 'สัปดาห์นี้'],
    ['lastWeek', 'สัปดาห์ที่แล้ว'],
    ['thisMonth', 'เดือนนี้'],
    ['lastMonth', 'เดือนที่แล้ว']
  ]
  return {
    items: periods
      .filter(([key]) => key !== current)
      .map(([, phrase]) => ({ type: 'action', action: { type: 'message', label: `OT ${phrase}`, text: `OT ของฉัน ${phrase}` } }))
  }
}
