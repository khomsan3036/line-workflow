import { config } from '../config'

// ---------------------------------------------------------------------------
// การ์ด "ขอเบิกน้ำมัน" แบบเฉพาะทาง (แทนการ์ดกลางของ maintenanceFlex)
//
// เพิ่มส่วน "การใช้น้ำมันและความคุ้มค่า" ของรถคันนั้นจากรายงาน fuel-usage-report ของระบบซ่อมบำรุง:
// อัตราสิ้นเปลืองจริง (กม./ลิตร หรือ ชม./ลิตร สำหรับเครื่องจักร) เทียบเป้าหมาย (ค่าตั้งต้น 10.0 กม./ลิตร)
// พร้อมป้ายประหยัด/เฝ้าระวัง/สิ้นเปลือง ระยะทางสะสม น้ำมันรวม และผลกระทบค่าใช้จ่าย
//
// กติกาการแสดงผล (ดู CLAUDE.md): หัวการ์ด gradient + backgroundColor ทึบสำรอง, ไม่มี box ว่างเป็นแถบสี
// (แถบเป้าหมายจึงเป็นจุด ●○ ในข้อความ), ไม่ใช้สี alpha/offset/alignItems, wrap ทุก text, ตัวอักษรเล็กสุด xs,
// ป้ายสถานะเป็นพื้นอ่อน + ตัวอักษรเข้มโทนเดียวกัน
// ---------------------------------------------------------------------------

export interface FuelUsageSummary {
  /** 'Odometer' = กม./ลิตร, 'WorkingHours' = ชม./ลิตร */
  basis: 'Odometer' | 'WorkingHours'
  kmPerLiter: number | null
  targetKmPerLiter: number
  kmDriven: number | null
  totalLiters: number
  requestCount: number
  /** ผลต่างเป็นบาท (+ ประหยัด / − เกินเป้า) */
  diffBaht: number | null
  /** green | yellow | red | check (เลขไมล์ผิดปกติ) จาก backend */
  badge: string | null
  /** เลขใบเบิกที่เลขไมล์ผิดปกติ (เมื่อ badge = check) */
  dataWarningRequestNo?: string | null
}

export interface FuelRequestCardInput {
  requestNo: string
  vehicle: string
  requester: string
  fuelType: string
  liters: number | null
  estimatedCost: number | null
  projectCode: string
  location: string
  odometer: number | null
  /** ข้อความสถานะภาษาไทย เช่น "รออนุมัติ" */
  status: string
  autoApproved: boolean
  usage: FuelUsageSummary | null
}

const WHITE = '#FFFFFF'
const INK = '#111827'
const MUTED = '#6B7280'
const TRACK = '#E5E7EB'
const CARD = '#F8FAFC'
const NAVY = '#0C1628'
const BLUE_DEEP = '#1D4ED8'
const INDIGO_DEEP = '#4338CA'
const BLUE_TINT = '#DBEAFE'
const GREEN_DEEP = '#047857'
const GREEN_SOFT = '#ECFDF5'
const AMBER_DEEP = '#B45309'
const AMBER_SOFT = '#FFFBEB'
const RED_DEEP = '#B91C1C'
const RED_SOFT = '#FEF2F2'
const GRAY_SOFT = '#F3F4F6'

function num(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '-'
  return v.toLocaleString('th-TH', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

function money(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '-'
  return `${v.toLocaleString('th-TH', { maximumFractionDigits: 0 })} บาท`
}

function text(value: string, extra: Record<string, unknown> = {}) {
  return { type: 'text', text: value || '-', wrap: true, ...extra }
}

function chip(label: string, backgroundColor: string, color: string) {
  return {
    type: 'box',
    layout: 'vertical',
    flex: 0,
    contents: [
      {
        type: 'box',
        layout: 'vertical',
        backgroundColor,
        cornerRadius: '12px',
        paddingTop: '4px',
        paddingBottom: '4px',
        paddingStart: '10px',
        paddingEnd: '10px',
        contents: [text(label, { size: 'xs', color, weight: 'bold', align: 'center' })]
      },
      { type: 'filler' }
    ]
  }
}

/** ช่องตัวเลข: ค่าตัวใหญ่ + หัวข้อเล็กใต้ (ใช้เรียงเป็นแถว 2–3 ช่อง) */
function tile(label: string, value: string, color = INK) {
  return {
    type: 'box',
    layout: 'vertical',
    flex: 1,
    backgroundColor: CARD,
    cornerRadius: '10px',
    paddingAll: '10px',
    spacing: 'xs',
    contents: [text(value, { size: 'md', weight: 'bold', color }), text(label, { size: 'xs', color: MUTED })]
  }
}

function row(label: string, value: string) {
  return {
    type: 'box',
    layout: 'horizontal',
    spacing: 'md',
    contents: [text(label, { size: 'xs', color: MUTED, flex: 3 }), text(value, { size: 'sm', color: INK, weight: 'bold', flex: 7 })]
  }
}

/** ป้ายประหยัด/เฝ้าระวัง/สิ้นเปลือง (สีอ่อน + ตัวเข้ม) จาก badge ของ backend */
function economyTone(badge: string | null): { label: string; bg: string; ink: string } {
  if (badge === 'green') return { label: 'ประหยัด ✓', bg: GREEN_SOFT, ink: GREEN_DEEP }
  if (badge === 'yellow') return { label: 'เฝ้าระวัง', bg: AMBER_SOFT, ink: AMBER_DEEP }
  if (badge === 'red') return { label: 'สิ้นเปลือง', bg: RED_SOFT, ink: RED_DEEP }
  // backend พบเลขไมล์ที่น่าจะพิมพ์ผิด (ต่ำกว่าครั้งก่อน หรืออัตราเกินจริง) — ไม่ให้คะแนน ให้ไปตรวจแทน
  if (badge === 'check') return { label: '⚠️ ตรวจสอบเลขไมล์', bg: AMBER_SOFT, ink: AMBER_DEEP }
  return { label: 'ยังไม่มีข้อมูล', bg: GRAY_SOFT, ink: MUTED }
}

/** แถบเทียบเป้าหมายเป็นจุด 10 จุด (เต็ม = ถึงเป้า) ตามกติกาไม่ใช้ box ว่างเป็นแถบสี */
function targetDots(ratio: number): string {
  const filled = Math.max(0, Math.min(10, Math.round(ratio * 10)))
  return '●'.repeat(filled) + '○'.repeat(10 - filled)
}

/** ส่วน "การใช้น้ำมันและความคุ้มค่า" */
function economySection(u: FuelUsageSummary) {
  const hours = u.basis === 'WorkingHours'
  const unit = hours ? 'ชม./ลิตร' : 'กม./ลิตร'
  const distanceUnit = hours ? 'ชม.' : 'กม.'
  const tone = economyTone(u.badge)
  const hasRate = u.kmPerLiter !== null && u.targetKmPerLiter > 0
  const ratio = hasRate ? (u.kmPerLiter as number) / u.targetKmPerLiter : 0
  const pct = hasRate ? Math.round(ratio * 100) : null
  const rateColor = u.badge === 'red' ? RED_DEEP : u.badge === 'yellow' || u.badge === 'check' ? AMBER_DEEP : u.badge === 'green' ? GREEN_DEEP : INK

  const contents: unknown[] = [
    {
      type: 'box',
      layout: 'horizontal',
      spacing: 'sm',
      contents: [text('⛽ การใช้น้ำมันและความคุ้มค่า', { size: 'xs', color: MUTED, weight: 'bold', flex: 1 }), chip(tone.label, tone.bg, tone.ink)]
    }
  ]

  if (hasRate) {
    contents.push(
      {
        type: 'box',
        layout: 'baseline',
        spacing: 'sm',
        contents: [
          text(num(u.kmPerLiter, 2), { size: 'xxl', weight: 'bold', color: rateColor, flex: 0 }),
          text(unit, { size: 'sm', color: MUTED, flex: 0 })
        ]
      },
      {
        type: 'box',
        layout: 'horizontal',
        spacing: 'sm',
        contents: [
          text(targetDots(ratio), { size: 'sm', color: rateColor, flex: 0 }),
          text(`${pct}% ของเป้าหมาย ${num(u.targetKmPerLiter, 1)} ${unit}`, { size: 'xs', color: MUTED, gravity: 'center' })
        ]
      }
    )
  } else {
    contents.push(
      text(`อัตราสิ้นเปลือง: ยังคำนวณไม่ได้ (ต้องมีการเติมอย่างน้อย 2 ครั้ง) · เป้าหมาย ${num(u.targetKmPerLiter, 1)} ${unit}`, {
        size: 'xs',
        color: MUTED
      })
    )
  }

  const diff = u.diffBaht
  const diffText = diff === null ? '-' : `${diff >= 0 ? '+' : '−'}${num(Math.abs(diff), 0)}`
  // หน่วยอยู่ในหัวข้อ ให้ตัวเลขอยู่บรรทัดเดียวในช่องแคบ ๆ
  contents.push({
    type: 'box',
    layout: 'horizontal',
    spacing: 'sm',
    contents: [
      tile(`${hours ? 'ชั่วโมงสะสม' : 'ระยะทางสะสม'} (${distanceUnit})`, u.kmDriven === null ? '-' : num(u.kmDriven, 0)),
      tile('น้ำมันรวม (ลิตร)', num(u.totalLiters, 0)),
      tile('ผลต่าง (บาท)', diffText, diff === null ? INK : diff >= 0 ? GREEN_DEEP : RED_DEEP)
    ]
  })
  contents.push(text(`จากการเบิก ${u.requestCount.toLocaleString('th-TH')} ครั้ง · ผลต่าง + = ประหยัดกว่าเป้า, − = ใช้เกินเป้า`, { size: 'xs', color: MUTED }))
  if (u.badge === 'check') {
    contents.push(
      text(
        `⚠️ เลขไมล์ในใบ ${u.dataWarningRequestNo || 'ล่าสุด'} ต่ำกว่าครั้งก่อนหรือได้อัตราเกินจริง — ตัวเลขข้างบนคิดเฉพาะช่วงที่เชื่อถือได้ กรุณาแก้เลขไมล์ในระบบ`,
        { size: 'xs', color: AMBER_DEEP }
      )
    )
  }

  return {
    type: 'box',
    layout: 'vertical',
    spacing: 'sm',
    paddingAll: '12px',
    cornerRadius: '12px',
    borderWidth: '1px',
    borderColor: TRACK,
    contents
  }
}

export function buildFuelRequestCard(c: FuelRequestCardInput): unknown {
  // ป้ายสถานะอยู่ในกล่องไฮไลต์ (พื้นอ่อน ตัวเข้ม); หัวการ์ดมีแค่ป้ายชนิดคำขอ ไม่ซ้ำกัน
  const statusChip = c.autoApproved ? chip('อนุมัติอัตโนมัติ ✓', GREEN_SOFT, GREEN_DEEP) : chip(c.status || 'รออนุมัติ', AMBER_SOFT, AMBER_DEEP)
  const webUrl = config.maintenance.webUrl
  const footer: unknown[] = []
  if (webUrl) {
    footer.push({
      type: 'button',
      style: 'primary',
      color: NAVY,
      height: 'sm',
      action: { type: 'uri', label: 'เปิดหน้าอนุมัติ', uri: `${webUrl}/services/fuel-request` }
    })
  }
  footer.push(
    text(`ขอโดย ${c.requester || 'ไม่ทราบชื่อ'} · ${new Date().toLocaleTimeString('th-TH', { timeZone: config.timezone, hour: '2-digit', minute: '2-digit' })} น.`, {
      size: 'xs',
      color: MUTED
    })
  )

  const body: unknown[] = [
    // ไฮไลต์: ปริมาณ + ประเภท + ประมาณการ
    {
      type: 'box',
      layout: 'horizontal',
      spacing: 'sm',
      backgroundColor: CARD,
      cornerRadius: '12px',
      paddingAll: '12px',
      contents: [
        {
          type: 'box',
          layout: 'vertical',
          flex: 1,
          spacing: 'xs',
          contents: [
            {
              type: 'box',
              layout: 'baseline',
              spacing: 'sm',
              contents: [text(num(c.liters, 1), { size: 'xxl', weight: 'bold', color: INK, flex: 0 }), text('ลิตร', { size: 'sm', color: MUTED, flex: 0 })]
            },
            text(`${c.fuelType || 'ไม่ระบุประเภท'} · ประมาณ ${money(c.estimatedCost)}`, { size: 'xs', color: MUTED })
          ]
        },
        statusChip
      ]
    },
    {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: [
        row('ผู้ขอ', c.requester),
        ...(c.projectCode ? [row('โครงการ', c.projectCode)] : []),
        ...(c.location ? [row('สถานที่', c.location)] : []),
        ...(c.odometer !== null && c.odometer > 0 ? [row('เลขไมล์', `${num(c.odometer, 0)} กม.`)] : []),
        row('สถานะ', c.autoApproved ? 'อนุมัติอัตโนมัติแล้ว' : c.status || 'รออนุมัติ')
      ]
    }
  ]
  if (c.usage) body.push(economySection(c.usage))

  return {
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: BLUE_DEEP,
      background: { type: 'linearGradient', angle: '135deg', startColor: BLUE_DEEP, endColor: INDIGO_DEEP },
      paddingAll: '18px',
      spacing: 'xs',
      contents: [
        {
          type: 'box',
          layout: 'horizontal',
          spacing: 'sm',
          contents: [chip('⛽ ขอเบิกน้ำมัน', BLUE_TINT, BLUE_DEEP), { type: 'filler' }, chip(c.autoApproved ? 'แจ้งทราบ' : 'ต้องอนุมัติ', WHITE, BLUE_DEEP)]
        },
        text(c.requestNo || 'คำขอเบิกน้ำมัน', { size: 'xl', weight: 'bold', color: WHITE, margin: 'md' }),
        text(c.vehicle || 'รถที่ไม่ระบุ', { size: 'sm', color: BLUE_TINT })
      ]
    },
    body: { type: 'box', layout: 'vertical', paddingAll: '16px', spacing: 'md', contents: body },
    footer: { type: 'box', layout: 'vertical', paddingAll: '12px', spacing: 'sm', contents: footer },
    styles: { footer: { separator: true, separatorColor: TRACK } }
  }
}

/** ข้อความสำรอง (altText / แชทที่ไม่แสดง Flex) */
export function fuelRequestCardToText(c: FuelRequestCardInput): string {
  const lines = [
    `⛽ ขอเบิกน้ำมัน ${c.requestNo}`,
    `${c.requester ? `คุณ${c.requester} ` : ''}ขอเบิก ${num(c.liters, 1)} ลิตร (${c.fuelType || '-'}) ให้ ${c.vehicle || 'รถที่ไม่ระบุ'}`,
    `สถานะ: ${c.autoApproved ? 'อนุมัติอัตโนมัติแล้ว' : c.status || 'รออนุมัติ'}`
  ]
  if (c.location) lines.push(`สถานที่: ${c.location}`)
  if (c.usage) {
    const hours = c.usage.basis === 'WorkingHours'
    const unit = hours ? 'ชม./ลิตร' : 'กม./ลิตร'
    lines.push(
      c.usage.kmPerLiter === null
        ? `อัตราสิ้นเปลือง: ยังคำนวณไม่ได้ · เป้าหมาย ${num(c.usage.targetKmPerLiter, 1)} ${unit}`
        : `อัตราสิ้นเปลือง ${num(c.usage.kmPerLiter, 2)} ${unit} · เป้าหมาย ${num(c.usage.targetKmPerLiter, 1)} ${unit} (${economyTone(c.usage.badge).label})`
    )
  }
  return lines.join('\n')
}
