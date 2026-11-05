import { formatThaiDate, formatThaiDateShort } from './attendanceQuery'
import { bubble, CARD, chip, HEADER_SUB, INK, MUTED, text, THEMES, TRACK, type Theme } from './absenceFlex'
import type { AbsentBacklogReport, AbsentHolder, AbsentHolderItem, StoreAbsenceLocation } from './storeMcp'

// ---------------------------------------------------------------------------
// Flex "ขาดงานแต่ยังมีของค้างคืน" (ข้อมูลจาก integra-store-mcp-service, tool store_absent_employee_backlogs)
//
// การ์ดหลัก = หน้าตาเดียวกับการ์ด "ขาดงานติดต่อกัน" (absenceFlex.ts) carousel Workshop / Site ใบละ top 10 คน
//   แต่ละแถว: ช่องวันที่ขาด | ชื่อ แผนก รหัส สแกนล่าสุด + "📦 ค้างคืน N รายการ" | ปุ่มลูกศร ›
//   กดแถว/ลูกศร = postback asb=... -> บอทตอบการ์ดรายละเอียดของคนนั้น (absenceStoreHandler.ts)
// การ์ดรายละเอียด = รายการของทีละชิ้นบนแผงไล่สี + ปุ่มเปิดหน้า Employee History ของคนนั้นใน Store Control
//   (<webUrl>/store-control?view=employee&emp=<รหัส>)
// กติกา LINE for PC เดียวกับการ์ดอื่น: สีทึบ (gradient มี backgroundColor สำรอง) ไม่มี box ว่าง ไม่ใช้ offset/alignItems
// ทุกข้อความ wrap ตัวเล็กสุด xs สีจางสุด MUTED
// ---------------------------------------------------------------------------

const RED_BG = '#FEF2F2'
const RED_FG = '#B91C1C'
const ORANGE_BG = '#FFF7ED'
const ORANGE_FG = '#C2410C'
const AMBER_BG = '#FFFBEB'
const AMBER_FG = '#B45309'

/** เพดาน carousel ของ LINE 50 KB เผื่อไว้ให้ห่าง */
const MAX_FLEX_BYTES = 45_000

function fmt(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 })
}

function toneOf(days: number) {
  return days >= 7 ? { bg: RED_BG, fg: RED_FG } : days >= 4 ? { bg: ORANGE_BG, fg: ORANGE_FG } : { bg: AMBER_BG, fg: AMBER_FG }
}

/** "พฤ 24 ก.ย." -> "24 ก.ย." */
function shortDate(ymd: string): string {
  const s = formatThaiDateShort(ymd.slice(0, 10))
  const i = s.indexOf(' ')
  return i > 0 ? s.slice(i + 1) : s
}

/** หน้า Employee History ของคนนั้นใน Store Control */
export function employeePageUrl(webUrl: string, empCode: string): string {
  return `${webUrl}/store-control?view=employee&emp=${encodeURIComponent(empCode)}`
}

// ── postback ────────────────────────────────────────────────────────────────

export interface AbsenceStorePostback {
  /** รหัสพนักงานตามที่ Store บันทึก (อาจมี S นำหน้า) */
  empCode: string
  daysAbsent: number
  lastScan: string
  location: StoreAbsenceLocation
}

export function absenceStorePostbackData(p: AbsentHolder): string {
  const code = p.storeEmpCodes?.[0] || p.empCode
  return new URLSearchParams({ asb: code, d: String(p.daysAbsent), s: p.lastScan, l: p.location === 'Site' ? 'S' : 'W' }).toString()
}

export function parseAbsenceStorePostback(data: string): AbsenceStorePostback | null {
  if (!data.startsWith('asb=')) return null
  const q = new URLSearchParams(data)
  const empCode = (q.get('asb') ?? '').trim()
  if (!/^[A-Za-z0-9_\-/]{1,32}$/.test(empCode)) return null
  const lastScan = q.get('s') ?? ''
  return {
    empCode,
    daysAbsent: Math.max(0, Number(q.get('d')) || 0),
    lastScan: /^\d{4}-\d{2}-\d{2}$/.test(lastScan) ? lastScan : '',
    location: q.get('l') === 'S' ? 'Site' : 'Workshop'
  }
}

// ── การ์ดหลัก ────────────────────────────────────────────────────────────────

function header(theme: Theme, report: AbsentBacklogReport) {
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
          text('📦 ติดตามของค้างคืน', { size: 'xs', color: HEADER_SUB, weight: 'bold', flex: 1, gravity: 'center' }),
          chip(theme.label, theme.chipBg, theme.chipFg)
        ]
      },
      text('ขาดงานแต่ยังมีของค้างคืน', { size: 'xl', weight: 'bold', color: '#FFFFFF', margin: 'sm' }),
      text(`ขาดติดต่อกันตั้งแต่ ${report.minDays} วันทำงาน · ข้อมูลถึง ${formatThaiDate(report.asOf)}`, { size: 'xs', color: HEADER_SUB })
    ]
  }
}

function tile(value: string, label: string, bg: string, fg: string) {
  return {
    type: 'box',
    layout: 'vertical',
    flex: 1,
    backgroundColor: bg,
    cornerRadius: '10px',
    paddingTop: '8px',
    paddingBottom: '8px',
    contents: [
      text(value, { size: 'lg', weight: 'bold', color: fg, align: 'center' }),
      text(label, { size: 'xs', color: fg, align: 'center' })
    ]
  }
}

interface LocationView {
  location: StoreAbsenceLocation
  absent: number
  withBacklog: number
  lines: number
  overdueLines: number
  people: AbsentHolder[]
}

function viewOf(report: AbsentBacklogReport, location: StoreAbsenceLocation): LocationView {
  const loc = report.byLocation.find((l) => l.location === location)
  const people = report.people.filter((p) => p.location === location)
  return {
    location,
    absent: loc?.absent ?? 0,
    withBacklog: loc?.withBacklog ?? people.length,
    lines: loc?.lines ?? people.reduce((s, p) => s + p.lines, 0),
    overdueLines: people.reduce((s, p) => s + p.overdueLines, 0),
    people
  }
}

function hero(theme: Theme, v: LocationView) {
  const pct = v.absent > 0 ? (v.withBacklog / v.absent) * 100 : 0
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
              text(`${fmt(v.withBacklog)} คน`, { size: '3xl', weight: 'bold', color: theme.ink }),
              text('ขาดงานและมีของค้างคืน', { size: 'xs', color: MUTED })
            ]
          },
          {
            type: 'box',
            layout: 'vertical',
            flex: 0,
            contents: [
              text(`${pct.toLocaleString('en-US', { maximumFractionDigits: 1 })}%`, { size: 'xl', weight: 'bold', color: INK, align: 'end' }),
              text(`จากคนขาดงาน ${fmt(v.absent)} คน`, { size: 'xs', color: MUTED, align: 'end' })
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
          tile(fmt(v.withBacklog), 'คนที่มีของค้าง', theme.chipBg, theme.chipFg),
          tile(fmt(v.lines), 'รายการค้างคืน', AMBER_BG, AMBER_FG),
          tile(fmt(v.overdueLines), 'เกินกำหนดคืน', RED_BG, RED_FG)
        ]
      }
    ]
  }
}

/** แถวคน: แบบเดียวกับการ์ดขาดงาน + บรรทัด "📦 ค้างคืน" + ลูกศรกดดูรายละเอียด (กดทั้งแถวได้) */
function personRow(theme: Theme, p: AbsentHolder, first: boolean) {
  const tone = toneOf(p.daysAbsent)
  const name = p.nickname ? `${p.name} (${p.nickname})` : p.name
  const role = [p.department, p.position].filter((x): x is string => !!x)
  if (role.length === 2 && role[1].toLowerCase().startsWith(role[0].toLowerCase())) role.shift()
  const backlog = `📦 ค้างคืน ${fmt(p.lines)} รายการ${p.overdueLines > 0 ? ` · ⚠️ เกินกำหนด ${fmt(p.overdueLines)}` : ''}`
  const action = { type: 'postback', label: 'ดูรายละเอียด', data: absenceStorePostbackData(p), displayText: `ดูของค้างคืน ${p.empCode}` }

  return {
    type: 'box',
    layout: 'horizontal',
    spacing: 'md',
    margin: first ? 'lg' : 'md',
    action,
    contents: [
      {
        type: 'box',
        layout: 'vertical',
        width: '48px',
        flex: 0,
        backgroundColor: tone.bg,
        cornerRadius: '10px',
        paddingTop: '6px',
        paddingBottom: '6px',
        contents: [
          text(String(p.daysAbsent), { size: 'lg', weight: 'bold', color: tone.fg, align: 'center' }),
          text('วัน', { size: 'xs', color: tone.fg, align: 'center' })
        ]
      },
      {
        type: 'box',
        layout: 'vertical',
        flex: 1,
        contents: [
          text(name, { size: 'sm', weight: 'bold', color: INK }),
          text(`${role.length > 0 ? role.join(' · ') : 'ไม่ระบุแผนก'} · ${p.empCode}\nสแกนล่าสุด ${formatThaiDateShort(p.lastScan)}`, {
            size: 'xs',
            color: MUTED
          }),
          text(backlog, { size: 'xs', weight: 'bold', color: p.overdueLines > 0 ? RED_FG : AMBER_FG, margin: 'xs' })
        ]
      },
      // ลูกศร › ชิดบนด้วย filler (ไม่ใช้ alignItems) action อยู่ที่ทั้งแถวแล้ว ไม่ซ้ำที่ลูกศร (ประหยัดขนาด)
      {
        type: 'box',
        layout: 'vertical',
        flex: 0,
        contents: [
          {
            type: 'box',
            layout: 'vertical',
            width: '30px',
            height: '30px',
            cornerRadius: '999px',
            backgroundColor: theme.chipBg,
            justifyContent: 'center',
            contents: [text('›', { size: 'lg', weight: 'bold', color: theme.chipFg, align: 'center' })]
          },
          { type: 'filler' }
        ]
      }
    ]
  }
}

function notes(v: LocationView, shown: number, report: AbsentBacklogReport): unknown[] {
  const lines: string[] = []
  if (v.withBacklog > shown) lines.push(`➕ และอีก ${fmt(v.withBacklog - shown)} คนที่มีของค้าง (ดูทั้งหมดในหน้า Employee Backlogs)`)
  lines.push('👉 แตะชื่อหรือปุ่ม › เพื่อดูรายการของที่ค้างของคนนั้น')
  lines.push('ขาดงาน = ไม่สแกนนิ้วติดกันในวันทำงาน จ.-ส. (ไม่รวมวันหยุดบริษัท) ยังไม่ได้หักวันลา')
  if (report.counted) lines.push(`นับของค้าง: ${countedThai(report.counted, report.project)}`)
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
        text('💬 ประสานหัวหน้างานเพื่อติดตามของคืนก่อน ถ้าพนักงานลาออกหรือย้ายหน่วยงาน ให้ทำรายการคืน/โอนในระบบ Store', {
          size: 'xs',
          color: '#374151'
        })
      ]
    }
  ]
}

/** กติกานับของค้างที่ฝั่ง store ใช้ (ตามการตั้งค่าโครงการ เหมือนหน้าจอ) */
export function countedThai(counted: string, project?: string): string {
  const c = counted.toLowerCase()
  const what = c.startsWith('borrowed and issued') ? 'ของยืม + ของเบิกที่ยังถืออยู่' : c.startsWith('issued') ? 'ของเบิกที่ยังถืออยู่' : 'ของยืมที่ยังไม่คืน'
  return project ? `${what} (โครงการ ${project})` : what
}

function emptyBody(theme: Theme, v: LocationView): unknown[] {
  const headline = v.absent === 0 ? 'ไม่มีใครขาดงานติดต่อกัน' : 'คนที่ขาดงานไม่มีของค้างคืน'
  const detail = v.absent === 0 ? 'ไม่มีของค้างที่ต้องติดตามจากการขาดงาน' : `พนักงานที่ขาดงาน ${fmt(v.absent)} คน ไม่มีของค้างกับ Store`
  return [
    {
      type: 'box',
      layout: 'vertical',
      backgroundColor: theme.chipBg,
      cornerRadius: '12px',
      paddingAll: '18px',
      contents: [
        text('✅', { size: '3xl', align: 'center' }),
        text(headline, { size: 'md', weight: 'bold', color: theme.chipFg, align: 'center', margin: 'sm' }),
        text(detail, { size: 'xs', color: '#374151', align: 'center', margin: 'xs' })
      ]
    }
  ]
}

function linkFooter(label: string, uri: string) {
  return {
    type: 'box',
    layout: 'vertical',
    paddingAll: '12px',
    contents: [{ type: 'button', style: 'link', height: 'sm', action: { type: 'uri', label, uri } }]
  }
}

function build(reports: AbsentBacklogReport[], top: number, webUrl: string) {
  const contents = reports.flatMap((report) =>
    report.byLocation.map((l) => {
      const theme = THEMES[l.location]
      const v = viewOf(report, l.location)
      if (v.people.length === 0) return bubble(header(theme, report), emptyBody(theme, v))
      const shown = v.people.slice(0, top)
      const title = v.withBacklog > shown.length ? `${shown.length} อันดับที่ขาดนานสุด` : 'รายชื่อ (ขาดนานสุดก่อน)'
      const b = bubble(header(theme, report), [
        hero(theme, v),
        text(title, { size: 'xs', color: MUTED, weight: 'bold', margin: 'lg' }),
        ...shown.map((p, i) => personRow(theme, p, i === 0)),
        ...notes(v, shown.length, report)
      ]) as Record<string, unknown>
      if (webUrl) b.footer = linkFooter('เปิด Employee Backlogs', `${webUrl}/store-control?view=backlog`)
      return b
    })
  )
  return { type: 'carousel', contents }
}

/** carousel Workshop แล้ว Site ใบละ top คน (ค่าเริ่มต้น 10) เกิน MAX_FLEX_BYTES ลดจำนวนคนลง (ที่ตัดยังนับใน "และอีก N คน") */
export function flexAbsenceStore(reports: AbsentBacklogReport[], top: number, webUrl: string) {
  let people = top
  let flex = build(reports, people, webUrl)
  while (Buffer.byteLength(JSON.stringify(flex)) > MAX_FLEX_BYTES && people > 3) flex = build(reports, --people, webUrl)
  return flex
}

export function absenceStoreAltText(reports: AbsentBacklogReport[]): string {
  const first = reports[0]
  const parts = reports.flatMap((r) => r.byLocation.map((l) => `${l.location} ${l.withBacklog} คน ${l.lines} รายการ`))
  return `📦 ขาดงาน ${first?.minDays ?? 2} วันขึ้นไปแต่ยังมีของค้างคืน (ถึง ${first ? formatThaiDateShort(first.asOf) : '-'}): ${parts.join(' · ')}`.slice(0, 400)
}

// ── การ์ดรายละเอียดของคนเดียว (ตอบเมื่อกด ›) ────────────────────────────────

/** รายการของ 1 ชิ้น = การ์ดขาวเล็กบนแผงไล่สี: ชื่อตัวหนา + ขนาด · จำนวน · รหัสทรัพย์สิน · ยืมเมื่อ, ขวา "41 วัน" */
function itemCard(i: AbsentHolderItem, first: boolean) {
  const name = i.itemName || i.itemCode || 'ไม่ระบุรายการ'
  const meta = [i.size, `${fmt(i.qty)} ${i.unit ?? ''}`.trim(), i.assetCode || i.codeNo, i.since ? `ยืม ${shortDate(i.since)}` : '']
    .filter(Boolean)
    .join(' · ')
  return {
    type: 'box',
    layout: 'horizontal',
    spacing: 'md',
    margin: first ? 'md' : 'sm',
    backgroundColor: '#FFFFFF',
    cornerRadius: '10px',
    paddingAll: '10px',
    contents: [
      {
        type: 'box',
        layout: 'vertical',
        flex: 1,
        contents: [text(name, { size: 'sm', weight: 'bold', color: INK }), text(meta, { size: 'xs', color: MUTED })]
      },
      text(i.overdue ? `⚠️ ${fmt(i.daysOut)} วัน` : `${fmt(i.daysOut)} วัน`, {
        size: 'xs',
        weight: 'bold',
        color: i.overdue ? RED_FG : '#374151',
        flex: 0,
        gravity: 'top'
      })
    ]
  }
}

export interface AbsenceStoreDetail {
  empCode: string
  name: string
  location: StoreAbsenceLocation
  daysAbsent: number
  lastScan: string
  items: AbsentHolderItem[]
  /** จำนวนรายการทั้งหมด (อาจมากกว่า items ที่ได้มา) */
  total: number
  counted?: string
  project?: string
}

export function flexAbsenceStoreDetail(d: AbsenceStoreDetail, webUrl: string) {
  const theme = THEMES[d.location]
  const tone = toneOf(d.daysAbsent)
  const overdue = d.items.filter((i) => i.overdue).length
  const start = overdue > 0 ? RED_BG : theme.chipBg
  const more = d.total - d.items.length
  const sub = [d.empCode, d.daysAbsent > 0 ? `ขาดงาน ${d.daysAbsent} วัน` : '', d.lastScan ? `สแกนล่าสุด ${formatThaiDateShort(d.lastScan)}` : '']
    .filter(Boolean)
    .join(' · ')

  const headerBox = {
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
          text('📦 ของค้างคืนกับ Store', { size: 'xs', color: HEADER_SUB, weight: 'bold', flex: 1, gravity: 'center' }),
          chip(theme.label, theme.chipBg, theme.chipFg)
        ]
      },
      text(d.name, { size: 'lg', weight: 'bold', color: '#FFFFFF', margin: 'sm' }),
      text(sub, { size: 'xs', color: HEADER_SUB })
    ]
  }

  const body: unknown[] =
    d.items.length === 0
      ? [
          {
            type: 'box',
            layout: 'vertical',
            backgroundColor: theme.chipBg,
            cornerRadius: '12px',
            paddingAll: '18px',
            contents: [
              text('✅', { size: '3xl', align: 'center' }),
              text('ไม่มีของค้างคืนแล้ว', { size: 'md', weight: 'bold', color: theme.chipFg, align: 'center', margin: 'sm' })
            ]
          }
        ]
      : [
          {
            type: 'box',
            layout: 'horizontal',
            spacing: 'sm',
            contents: [
              tile(fmt(d.total), 'รายการค้างคืน', AMBER_BG, AMBER_FG),
              tile(fmt(overdue), 'เกินกำหนดคืน', RED_BG, RED_FG),
              tile(d.daysAbsent > 0 ? fmt(d.daysAbsent) : '-', 'วันที่ขาดงาน', tone.bg, tone.fg)
            ]
          },
          {
            type: 'box',
            layout: 'vertical',
            margin: 'lg',
            cornerRadius: '12px',
            paddingAll: '10px',
            backgroundColor: start,
            background: { type: 'linearGradient', angle: '180deg', startColor: start, endColor: '#FFFFFF' },
            contents: [
              text('รายการที่ยังไม่คืน (ยืมนานสุดก่อน)', { size: 'sm', weight: 'bold', color: overdue > 0 ? RED_FG : theme.chipFg }),
              ...d.items.map((i, n) => itemCard(i, n === 0)),
              ...(more > 0
                ? [text(`และอีก ${fmt(more)} รายการ · ดูทั้งหมดในหน้า Employee History`, { size: 'xs', color: MUTED, align: 'center', margin: 'md' })]
                : [])
            ]
          },
          ...(d.counted ? [text(`นับของค้าง: ${countedThai(d.counted, d.project)}`, { size: 'xs', color: MUTED, margin: 'md' })] : [])
        ]

  const b = bubble(headerBox, body) as Record<string, unknown>
  if (webUrl) {
    b.footer = {
      type: 'box',
      layout: 'vertical',
      paddingAll: '12px',
      contents: [
        {
          type: 'button',
          style: 'primary',
          height: 'sm',
          color: theme.header,
          action: { type: 'uri', label: 'เปิดประวัติพนักงานใน Store', uri: employeePageUrl(webUrl, d.empCode) }
        }
      ]
    }
  }
  return b
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function itemLine(i: AbsentHolderItem): string {
  const name = [i.itemName || i.itemCode || 'ไม่ระบุรายการ', i.size].filter(Boolean).join(' ')
  const parts = [`${name} × ${fmt(i.qty)}${i.unit ? ` ${i.unit}` : ''}`, i.assetCode || i.codeNo, i.since ? `ยืม ${shortDate(i.since)}` : '', `${fmt(i.daysOut)} วัน`]
  return `${i.overdue ? '⚠️' : '•'} ${parts.filter(Boolean).join(' · ')}`
}

/** ข้อความสรุปสำหรับพิมพ์ใน CLI */
export function absenceStoreText(reports: AbsentBacklogReport[]): string {
  const lines: string[] = []
  for (const r of reports) {
    for (const l of r.byLocation) {
      lines.push(`${l.location} (ถึง ${r.asOf}, ขาด >= ${r.minDays} วัน): ขาดงาน ${l.absent} คน · มีของค้าง ${l.withBacklog} คน · ${l.lines} รายการ`)
      for (const p of r.people.filter((x) => x.location === l.location)) {
        lines.push(`  ${String(p.daysAbsent).padStart(2)} วัน  ${p.empCode}  ${p.name}  ค้าง ${p.lines} รายการ (เกินกำหนด ${p.overdueLines})`)
        for (const i of p.items) lines.push(`        ${itemLine(i)}${i.docNo ? `  [${i.docNo}]` : ''}`)
      }
    }
  }
  return lines.join('\n')
}
