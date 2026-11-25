// ---------------------------------------------------------------------------
// การ์ด Flex "สรุปขอเติมน้ำมันตามรอบ" ที่ maintenance-fuel-service ส่งมา
// (routing key maintenance.line.notification, category = fuel_request_digest)
//
// ที่มา: หน้าเว็บ Maintenance > การตั้งค่า > การแจ้งเตือน LINE ตั้งได้ว่าคำขอเติมน้ำมันจะแจ้ง "ทุกครั้ง"
// หรือ "สรุปตามรอบ" (ค่าเริ่มต้น 10:00 / 15:00 / 18:00) ฝั่ง fuel-service เป็นเจ้าของทั้งเวลา เนื้อหา และ
// กลุ่มปลายทาง: ถึงเวลาแต่ละรอบจะ publish สรุปหนึ่งชิ้นต่อหนึ่งกลุ่ม consumer (maintenanceEvents.ts)
// รับมาทำการ์ดนี้ ส่วนการ์ดรายคำขอ (fuelRequestFlex.ts) จะถูกข้ามเมื่อ event fuel.requested มี
// suppressLineCard = true
//
// เนื้อหา: คำขอใหม่ตั้งแต่รอบก่อน (รอบแรกของวันย้อนไปถึงรอบสุดท้ายของเมื่อวาน) + ยอดสะสมของวันนี้
//
// ดีไซน์ยึดตาม pmScheduleFlex.ts / documentExpiryFlex.ts:
//   - สีทึบเท่านั้น ห้าม #RRGGBBAA, ไม่มี box ที่ contents ว่าง (ใช้ filler), ไม่ใช้ alignItems/offset
//   - ตัวหนังสือขาวเฉพาะบนพื้นเข้ม ป้ายสถานะเป็นตัวเข้มบนพื้นอ่อนโทนเดียวกัน
//   - ตัวอักษรเล็กสุด xs สีจางสุด MUTED และ wrap ทุก text
//   - อ่านจบใน 3 วินาที: คำขอใหม่กี่รายการ -> ยอดวันนี้ 3 ช่อง -> รายการ -> ปุ่ม
// ---------------------------------------------------------------------------

const INK = '#111827'
const MUTED = '#6B7280'
const WHITE = '#FFFFFF'
const TRACK = '#E5E7EB'
const CARD = '#F8FAFC'
const NAVY = '#0C1628'
const ON_COLOR_SOFT = '#F1F5F9'

const RED_DEEP = '#B91C1C'
const AMBER_DEEP = '#B45309'
const AMBER_SOFT = '#FFFBEB'
const BLUE_DEEP = '#1D4ED8'
const BLUE_SOFT = '#EFF6FF'
const GREEN_DEEP = '#047857'
const GREEN_SOFT = '#ECFDF5'

/** จำนวนคำขอที่แสดงเป็นแถวบนการ์ด ที่เหลือสรุปเป็น "และอีก N รายการ" */
const MAX_SHOWN = 8

/** หนึ่งคำขอในการ์ด (ถอดมาจาก metadata.rows ที่ fuel-service ส่งมา) */
export interface FuelDigestRow {
  requestNo: string
  vehicleCode: string | null
  vehicleName: string | null
  requester: string | null
  project: string | null
  liters: number
  /** pending | approved | fulfilled | rejected */
  status: string
  /** Workshop | Site */
  location: string | null
  /** HH:mm ที่ยื่นคำขอ */
  time: string
}

export interface FuelDigest {
  test: boolean
  /** รอบของการ์ด เช่น "10:00" */
  slot: string
  /** วันของรอบ YYYY-MM-DD */
  date: string
  windowStart: string
  windowEnd: string
  newCount: number
  newLiters: number
  newWorkshop: number
  newSite: number
  dayCount: number
  dayLiters: number
  dayPending: number
  dayApproved: number
  dayFulfilled: number
  dayRejected: number
  rows: FuelDigestRow[]
  /** ลิงก์หน้าเว็บระบบซ่อมบำรุง (ว่าง = ไม่มีปุ่ม) */
  webUrl?: string
}

/** อ่านสรุปออกจาก payload; คืน null ถ้าไม่ใช่สรุปขอเติมน้ำมัน */
export function parseFuelDigest(e: Record<string, unknown>, webUrl: string): FuelDigest | null {
  if (e.category !== 'fuel_request_digest') return null

  const meta = (e.metadata ?? {}) as Record<string, unknown>
  const num = (v: unknown): number => {
    const n = Number(typeof v === 'string' ? v.trim() : v)
    return Number.isFinite(n) ? n : 0
  }
  const text = (v: unknown): string | null => (v == null || String(v).trim() === '' ? null : String(v).trim())

  let rows: FuelDigestRow[] = []
  // rows มาเป็น JSON string (metadata ของ contract เป็น Dictionary<string,string>)
  if (typeof meta.rows === 'string' && meta.rows.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(meta.rows)
      if (Array.isArray(parsed)) {
        rows = parsed
          .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
          .map((r) => ({
            requestNo: text(r.requestNo) ?? '-',
            vehicleCode: text(r.vehicleCode),
            vehicleName: text(r.vehicleName),
            requester: text(r.requester),
            project: text(r.project),
            liters: num(r.liters),
            status: String(r.status ?? 'pending'),
            location: text(r.location),
            time: text(r.time) ?? ''
          }))
      }
    } catch {
      // metadata เสีย ไม่ควรทำให้การ์ดหายทั้งใบ — แสดงเฉพาะตัวเลข
      rows = []
    }
  }

  return {
    test: String(meta.test ?? '') === 'true',
    slot: text(meta.slot) ?? '',
    date: text(meta.date) ?? '',
    windowStart: text(meta.windowStart) ?? '',
    windowEnd: text(meta.windowEnd) ?? '',
    newCount: num(meta.newCount),
    newLiters: num(meta.newLiters),
    newWorkshop: num(meta.newWorkshop),
    newSite: num(meta.newSite),
    dayCount: num(meta.dayCount),
    dayLiters: num(meta.dayLiters),
    dayPending: num(meta.dayPending),
    dayApproved: num(meta.dayApproved),
    dayFulfilled: num(meta.dayFulfilled),
    dayRejected: num(meta.dayRejected),
    rows,
    webUrl: /^https:\/\/\S+$/.test(webUrl) ? webUrl : undefined
  }
}

function fmt(n: number): string {
  return n.toLocaleString('th-TH', { maximumFractionDigits: 0 })
}

function liters(n: number): string {
  return n.toLocaleString('th-TH', { maximumFractionDigits: 1 })
}

/** "2026-11-25T10:00:00" -> { date: "25/11", time: "10:00" } (เวลาไทยจาก fuel-service ไม่มี offset อ่านเป็นข้อความตรง ๆ) */
function stampParts(iso: string): { date: string; time: string } {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso)
  return m ? { date: `${m[3]}/${m[2]}`, time: `${m[4]}:${m[5]}` } : { date: '', time: '' }
}

/** "18:00 (24/11) – 10:00" หรือ "10:00 – 15:00" เมื่ออยู่ในวันเดียวกัน */
function windowLabel(d: FuelDigest): string {
  const from = stampParts(d.windowStart)
  const to = stampParts(d.windowEnd)
  if (!from.time || !to.time) return ''
  return from.date === to.date ? `${from.time} – ${to.time} น.` : `${from.time} (${from.date}) – ${to.time} น.`
}

const STATUS: Record<string, { label: string; tone: string }> = {
  pending: { label: 'รออนุมัติ', tone: AMBER_DEEP },
  approved: { label: 'อนุมัติแล้ว', tone: BLUE_DEEP },
  fulfilled: { label: 'เติมแล้ว', tone: GREEN_DEEP },
  rejected: { label: 'ไม่อนุมัติ', tone: RED_DEEP }
}

const LOCATION: Record<string, string> = { Workshop: 'Workshop', Site: 'หน้างาน' }

/** ป้ายเล็กมุมขวาของหัวการ์ด */
function chip(text: string, bg: string, color: string) {
  return {
    type: 'box',
    layout: 'vertical',
    backgroundColor: bg,
    cornerRadius: '14px',
    paddingAll: '5px',
    paddingStart: '10px',
    paddingEnd: '10px',
    flex: 0,
    contents: [{ type: 'text', text, size: 'xs', color, weight: 'bold', align: 'center', wrap: true }]
  }
}

/** กล่องตัวเลขหนึ่งช่องของยอดสะสมวันนี้ */
function metric(label: string, value: string, deep: string, soft: string) {
  return {
    type: 'box',
    layout: 'vertical',
    backgroundColor: soft,
    cornerRadius: '10px',
    paddingAll: '10px',
    flex: 1,
    spacing: 'none',
    contents: [
      { type: 'text', text: value, size: 'xl', weight: 'bold', color: deep, align: 'center', wrap: true },
      { type: 'text', text: label, size: 'xs', color: deep, align: 'center', wrap: true }
    ]
  }
}

/** หนึ่งคำขอ: แถบสีตามสถานะ + รถ + (เลขที่ · ผู้ขอ · เวลา · สถานที่) + ลิตร/สถานะชิดขวา */
function rowBox(row: FuelDigestRow) {
  const status = STATUS[row.status] ?? STATUS.pending
  const vehicle = [row.vehicleCode, row.vehicleName].filter(Boolean).join(' ') || row.requestNo
  const sub = [row.requestNo, row.requester, row.time ? `${row.time} น.` : '', row.location ? (LOCATION[row.location] ?? row.location) : '']
    .filter(Boolean)
    .join(' · ')
  return {
    type: 'box',
    layout: 'horizontal',
    spacing: 'md',
    contents: [
      {
        type: 'box',
        layout: 'vertical',
        width: '3px',
        backgroundColor: status.tone,
        cornerRadius: '2px',
        flex: 0,
        contents: [{ type: 'filler' }]
      },
      {
        type: 'box',
        layout: 'vertical',
        spacing: 'none',
        flex: 6,
        contents: [
          { type: 'text', text: vehicle, size: 'sm', weight: 'bold', color: INK, wrap: true },
          { type: 'text', text: sub || '-', size: 'xs', color: MUTED, wrap: true }
        ]
      },
      {
        type: 'box',
        layout: 'vertical',
        spacing: 'none',
        flex: 3,
        contents: [
          { type: 'text', text: `${liters(row.liters)} ลิตร`, size: 'sm', weight: 'bold', color: INK, align: 'end', wrap: true },
          { type: 'text', text: status.label, size: 'xs', weight: 'bold', color: status.tone, align: 'end', wrap: true }
        ]
      }
    ]
  }
}

/**
 * การ์ดสรุปขอเติมน้ำมันหนึ่งรอบ
 * โครงการ์ด: หัว (รอบ + จำนวนคำขอใหม่ + ช่วงเวลา) -> ยอดสะสมวันนี้ 3 ช่อง + แยกสถานะ ->
 * รายการคำขอใหม่ (ไม่เกิน MAX_SHOWN + "และอีก N") -> ปุ่มเปิดหน้ารายการคำขอ
 */
export function buildFuelDigestCard(d: FuelDigest): unknown {
  const shown = d.rows.slice(0, MAX_SHOWN)
  const rest = d.newCount - shown.length
  const window = windowLabel(d)
  const day = stampParts(d.windowEnd).date

  const body: unknown[] = [
    { type: 'text', text: `ยอดสะสมวันนี้${day ? ` (${day})` : ''}`, size: 'xs', weight: 'bold', color: MUTED, wrap: true },
    {
      type: 'box',
      layout: 'horizontal',
      spacing: 'sm',
      contents: [
        metric('คำขอ', fmt(d.dayCount), BLUE_DEEP, BLUE_SOFT),
        metric('ลิตร', fmt(d.dayLiters), GREEN_DEEP, GREEN_SOFT),
        metric('รออนุมัติ', fmt(d.dayPending), AMBER_DEEP, AMBER_SOFT)
      ]
    },
    {
      type: 'text',
      text: `อนุมัติแล้ว ${fmt(d.dayApproved)} · เติมแล้ว ${fmt(d.dayFulfilled)} · ไม่อนุมัติ ${fmt(d.dayRejected)}`,
      size: 'xs',
      color: MUTED,
      align: 'center',
      wrap: true
    },
    { type: 'separator', color: TRACK },
    { type: 'text', text: 'คำขอใหม่ในรอบนี้', size: 'xs', weight: 'bold', color: MUTED, wrap: true }
  ]

  if (shown.length > 0) {
    body.push({
      type: 'box',
      layout: 'vertical',
      spacing: 'md',
      backgroundColor: CARD,
      cornerRadius: '12px',
      paddingAll: '14px',
      contents: [
        ...shown.map(rowBox),
        ...(rest > 0
          ? [
              { type: 'separator', color: TRACK },
              { type: 'text', text: `และอีก ${fmt(rest)} รายการ — ดูทั้งหมดในระบบ`, size: 'xs', color: MUTED, align: 'center', wrap: true }
            ]
          : [])
      ]
    })
  } else {
    body.push({
      type: 'text',
      text: d.newCount > 0 ? `มีคำขอใหม่ ${fmt(d.newCount)} รายการ — ดูรายละเอียดในระบบ` : 'ไม่มีคำขอใหม่ในรอบนี้',
      size: 'sm',
      color: INK,
      align: 'center',
      wrap: true
    })
  }

  const footer: unknown[] = []
  if (d.webUrl) {
    footer.push({
      type: 'button',
      style: 'primary',
      color: NAVY,
      height: 'sm',
      action: { type: 'uri', label: d.dayPending > 0 ? 'เปิดรายการรออนุมัติ' : 'เปิดรายการคำขอ', uri: `${d.webUrl}/services/fuel-request/list` }
    })
  }
  footer.push({
    type: 'text',
    text: `คำขอใหม่: Workshop ${fmt(d.newWorkshop)} · หน้างาน ${fmt(d.newSite)} · ระบบเบิกน้ำมัน`,
    size: 'xs',
    color: MUTED,
    align: 'center',
    wrap: true
  })

  return {
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: NAVY,
      paddingAll: '16px',
      spacing: 'sm',
      contents: [
        {
          type: 'box',
          layout: 'horizontal',
          contents: [
            { type: 'text', text: '⛽ ขอเติมน้ำมัน · สรุปตามรอบ', size: 'xs', color: ON_COLOR_SOFT, flex: 1, wrap: true },
            chip(d.test ? 'ทดสอบ' : `รอบ ${d.slot} น.`, WHITE, NAVY)
          ]
        },
        {
          type: 'text',
          text: d.newCount > 0 ? `คำขอใหม่ ${fmt(d.newCount)} รายการ · ${liters(d.newLiters)} ลิตร` : 'ไม่มีคำขอใหม่',
          size: 'xl',
          weight: 'bold',
          color: WHITE,
          wrap: true
        },
        ...(window ? [{ type: 'text', text: `ช่วง ${window}`, size: 'xs', color: ON_COLOR_SOFT, wrap: true }] : [])
      ]
    },
    body: { type: 'box', layout: 'vertical', paddingAll: '16px', spacing: 'md', contents: body },
    footer: { type: 'box', layout: 'vertical', paddingAll: '12px', spacing: 'sm', contents: footer },
    styles: { footer: { separator: true, separatorColor: TRACK } }
  }
}

/** ข้อความสำรอง (เครื่องที่แสดง Flex ไม่ได้ และใช้เป็น altText) */
export function fuelDigestToText(d: FuelDigest): string {
  const window = windowLabel(d)
  const lines = [
    `⛽ ${d.test ? '[ทดสอบ] ' : ''}สรุปขอเติมน้ำมัน รอบ ${d.slot} น.: คำขอใหม่ ${d.newCount} รายการ ${liters(d.newLiters)} ลิตร`,
    window ? `ช่วง ${window}` : '',
    `วันนี้ ${d.dayCount} คำขอ ${liters(d.dayLiters)} ลิตร · รออนุมัติ ${d.dayPending} · อนุมัติแล้ว ${d.dayApproved} · เติมแล้ว ${d.dayFulfilled}`
  ]
  for (const r of d.rows.slice(0, MAX_SHOWN)) {
    lines.push(`- ${r.requestNo} · ${r.vehicleCode ?? '-'} · ${liters(r.liters)} ลิตร · ${(STATUS[r.status] ?? STATUS.pending).label}`)
  }
  if (d.newCount > Math.min(d.rows.length, MAX_SHOWN)) lines.push(`และอีก ${d.newCount - Math.min(d.rows.length, MAX_SHOWN)} รายการ`)
  return lines.filter(Boolean).join('\n')
}
