// ---------------------------------------------------------------------------
// การ์ด Flex "แผน PM เกินกำหนด / ใกล้ถึงรอบ" ที่ maintenance-pm-service ส่งมา
// (routing key maintenance.line.notification, category = pm_schedule)
//
// ที่มา: ตัวตั้งเวลาของแอปนี้ (pmScheduleDispatch.ts) สั่ง POST /api/pm-plans/notifications/dispatch
// ทุกเช้า ฝั่ง pm-service คิดว่าเครื่องไหนเกินกำหนด/ใกล้ถึงรอบ (ตามจำนวนวัน/กม./ชม. ที่ตั้งไว้ในหน้า
// "ตั้งค่าแจ้งเตือน" ของเว็บ) แล้ว publish digest หนึ่งชิ้นต่อหนึ่งกลุ่มปลายทาง consumer
// (maintenanceEvents.ts) รับมาทำการ์ดนี้
//
// ทำไมต้องมีการ์ดเฉพาะ ไม่ใช้ buildAlertCard ทั่วไป:
//   การ์ดทั่วไปจะโชว์ "ประเภท: pm_schedule" และซ่อน "เกิน/เหลืออีกเท่าไร" ไว้ในข้อความ
//   ทั้งที่คนอ่านต้องเห็นจำนวนที่เกินกำหนดและเครื่องที่ต้องเข้าก่อนเป็นอย่างแรก
//
// ดีไซน์ยึดตาม maintenanceFlex.ts / documentExpiryFlex.ts:
//   - สีทึบเท่านั้น ห้าม #RRGGBBAA, ไม่มี box ที่ contents ว่าง (ใช้ filler), ไม่ใช้ alignItems/offset
//   - หัวการ์ดสีเข้มตามความด่วน ตัวหนังสือขาว ป้ายพื้นอ่อนตัวเข้ม
//   - ตัวอักษรเล็กสุด xs (ยกเว้นคำอธิบายจุดสี xxs ตามการ์ดเอกสาร) สีจางสุด MUTED
//   - อ่านจบใน 3 วินาที: หัวข้อ -> ตัวเลข 3 ช่อง -> รายการเครื่อง -> ปุ่ม
// ---------------------------------------------------------------------------

const INK = '#111827'
const MUTED = '#6B7280'
const WHITE = '#FFFFFF'
const TRACK = '#E5E7EB'
const CARD = '#F8FAFC'
const NAVY = '#0C1628'
const ON_COLOR_SOFT = '#F1F5F9'

const RED_DEEP = '#B91C1C'
const RED_SOFT = '#FEF2F2'
const AMBER_DEEP = '#B45309'
const AMBER_SOFT = '#FFFBEB'
const BLUE_DEEP = '#1D4ED8'
const BLUE_SOFT = '#EFF6FF'

/** หนึ่งเครื่องในการ์ด (ถอดมาจาก metadata.rows ที่ pm-service ส่งมา) */
export interface PmRow {
  planCode: string
  /** "Generator · AIRMAN" */
  equipment: string
  code?: string | null
  location?: string | null
  /** "ทุก 250 ชม." */
  cycle: string
  /** "เกินกำหนด 12 วัน" / "เหลือ 20 ชม." */
  due: string
  /** Overdue | DueSoon */
  status: string
  priority?: string | null
}

export interface PmDigest {
  overdueCount: number
  dueSoonCount: number
  inProgressCount: number
  leadDays: number
  leadKm: number
  leadHours: number
  responsible: string[]
  message: string
  rows: PmRow[]
  /** ลิงก์หน้าเว็บระบบซ่อมบำรุง (ว่าง = ไม่มีปุ่ม) */
  webUrl?: string
}

/** อ่าน digest ออกจาก payload; คืน null ถ้าไม่ใช่ event แผน PM */
export function parsePmDigest(e: Record<string, unknown>, webUrl: string): PmDigest | null {
  if (e.category !== 'pm_schedule') return null

  const meta = (e.metadata ?? {}) as Record<string, unknown>
  const num = (v: unknown, fallback = 0): number => {
    const n = Number(typeof v === 'string' ? v.trim() : v)
    return Number.isFinite(n) ? n : fallback
  }
  const text = (v: unknown): string | null => (v == null || String(v).trim() === '' ? null : String(v).trim())

  let rows: PmRow[] = []
  // rows มาเป็น JSON string (metadata ของ contract เป็น Dictionary<string,string>)
  if (typeof meta.rows === 'string' && meta.rows.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(meta.rows)
      if (Array.isArray(parsed)) {
        rows = parsed
          .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
          .map((r) => ({
            planCode: String(r.planCode ?? ''),
            equipment: text(r.equipment) ?? '-',
            code: text(r.code),
            location: text(r.location),
            cycle: text(r.cycle) ?? '',
            due: text(r.due) ?? '',
            status: String(r.status ?? ''),
            priority: text(r.priority)
          }))
      }
    } catch {
      // metadata เสีย ไม่ควรทำให้การ์ดหายทั้งใบ — แสดงเฉพาะตัวเลขกับข้อความ
      rows = []
    }
  }

  const responsible = String(meta.responsible ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  return {
    overdueCount: num(meta.overdueCount),
    dueSoonCount: num(meta.dueSoonCount),
    inProgressCount: num(meta.inProgressCount),
    leadDays: num(meta.leadDays, 30),
    leadKm: num(meta.leadKm, 1000),
    leadHours: num(meta.leadHours, 25),
    responsible,
    message: typeof e.message === 'string' ? e.message : '',
    rows,
    webUrl: /^https:\/\/\S+$/.test(webUrl) ? webUrl : undefined
  }
}

function fmt(n: number): string {
  return n.toLocaleString('th-TH', { maximumFractionDigits: 0 })
}

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

/** กล่องตัวเลขหนึ่งช่อง: เกินกำหนด / ใกล้ถึงรอบ / กำลังทำ */
function metric(label: string, value: number, deep: string, soft: string) {
  return {
    type: 'box',
    layout: 'vertical',
    backgroundColor: soft,
    cornerRadius: '10px',
    paddingAll: '10px',
    flex: 1,
    spacing: 'none',
    contents: [
      { type: 'text', text: fmt(value), size: 'xl', weight: 'bold', color: deep, align: 'center', wrap: true },
      { type: 'text', text: label, size: 'xs', color: deep, align: 'center', wrap: true }
    ]
  }
}

/** หนึ่งเครื่อง: แถบสีตามความด่วน + ชื่อเครื่อง/รหัส + รอบ + ป้ายเกิน/เหลือ */
function rowBox(row: PmRow) {
  const tone = row.status === 'Overdue' ? RED_DEEP : AMBER_DEEP
  const sub = [row.code ?? 'ไม่มีรหัสทรัพย์สิน', row.location, row.cycle].filter(Boolean).join(' · ')
  return {
    type: 'box',
    layout: 'horizontal',
    spacing: 'md',
    contents: [
      {
        type: 'box',
        layout: 'vertical',
        width: '3px',
        backgroundColor: tone,
        cornerRadius: '2px',
        flex: 0,
        contents: [{ type: 'filler' }]
      },
      {
        type: 'box',
        layout: 'vertical',
        spacing: 'none',
        flex: 5,
        contents: [
          {
            type: 'text',
            text: row.priority ? `${row.equipment} (${row.priority})` : row.equipment,
            size: 'sm',
            weight: 'bold',
            color: INK,
            wrap: true
          },
          { type: 'text', text: sub, size: 'xs', color: MUTED, wrap: true }
        ]
      },
      { type: 'text', text: row.due, size: 'xs', weight: 'bold', color: tone, align: 'end', flex: 3, wrap: true }
    ]
  }
}

/**
 * การ์ด digest แผน PM ประจำวัน
 * โครงการ์ด: หัวสีตามความด่วน -> ตัวเลข 3 ช่อง -> ข้อความ -> รายการ (ไม่เกิน 6 + "และอีก N") ->
 * ผู้รับผิดชอบ -> ปุ่มเปิดหน้าแผน PM
 */
export function buildPmDigestCard(d: PmDigest): unknown {
  const anyOverdue = d.overdueCount > 0
  const tone = anyOverdue ? RED_DEEP : AMBER_DEEP
  const shown = d.rows.slice(0, 6)
  const rest = d.overdueCount + d.dueSoonCount - shown.length

  const body: unknown[] = [
    {
      type: 'box',
      layout: 'horizontal',
      spacing: 'sm',
      contents: [
        metric('เกินกำหนด', d.overdueCount, RED_DEEP, RED_SOFT),
        metric('ใกล้ถึงรอบ', d.dueSoonCount, AMBER_DEEP, AMBER_SOFT),
        metric('กำลังทำ', d.inProgressCount, BLUE_DEEP, BLUE_SOFT)
      ]
    }
  ]

  if (d.message) body.push({ type: 'text', text: d.message, size: 'sm', color: INK, wrap: true })

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
  }

  if (d.responsible.length > 0) {
    body.push({
      type: 'box',
      layout: 'baseline',
      spacing: 'sm',
      contents: [
        { type: 'text', text: 'ผู้รับผิดชอบ', size: 'xs', color: MUTED, flex: 3, wrap: true },
        { type: 'text', text: d.responsible.join(', '), size: 'xs', color: INK, weight: 'bold', flex: 7, wrap: true }
      ]
    })
  }

  const footer: unknown[] = []
  if (d.webUrl) {
    footer.push({
      type: 'button',
      style: 'primary',
      color: NAVY,
      height: 'sm',
      action: {
        type: 'uri',
        label: anyOverdue ? 'เปิดรายการที่เกินกำหนด' : 'เปิดแผน PM',
        uri: `${d.webUrl}/services/pm-schedule${anyOverdue ? '?status=Overdue' : '?status=DueSoon'}`
      }
    })
  }
  footer.push({
    type: 'text',
    text: `แจ้งล่วงหน้า ${fmt(d.leadDays)} วัน / ${fmt(d.leadKm)} กม. / ${fmt(d.leadHours)} ชม. · ระบบแผน PM`,
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
      backgroundColor: tone,
      paddingAll: '16px',
      spacing: 'sm',
      contents: [
        {
          type: 'box',
          layout: 'horizontal',
          contents: [
            { type: 'text', text: `${anyOverdue ? '🚨' : '🔔'} แผน PM · ทีมซ่อมบำรุง`, size: 'xs', color: ON_COLOR_SOFT, flex: 1, wrap: true },
            chip(anyOverdue ? 'ต้องเข้าซ่อมบำรุง' : 'เตรียมล่วงหน้า', WHITE, tone)
          ]
        },
        {
          type: 'text',
          text: anyOverdue ? `เกินกำหนด PM ${fmt(d.overdueCount)} รายการ` : `ใกล้ถึงรอบ PM ${fmt(d.dueSoonCount)} รายการ`,
          size: 'xl',
          weight: 'bold',
          color: WHITE,
          wrap: true
        }
      ]
    },
    body: { type: 'box', layout: 'vertical', paddingAll: '16px', spacing: 'lg', contents: body },
    footer: { type: 'box', layout: 'vertical', paddingAll: '12px', spacing: 'sm', contents: footer },
    styles: { footer: { separator: true, separatorColor: TRACK } }
  }
}

/** ข้อความสำรอง (เครื่องที่แสดง Flex ไม่ได้ และใช้เป็น altText) */
export function pmDigestToText(d: PmDigest): string {
  const lines = [
    `${d.overdueCount > 0 ? '🚨' : '🔔'} แผน PM: เกินกำหนด ${d.overdueCount} · ใกล้ถึงรอบ ${d.dueSoonCount} · กำลังทำ ${d.inProgressCount}`,
    d.message
  ]
  for (const r of d.rows.slice(0, 6)) {
    lines.push(`- ${r.equipment} · ${r.code ?? 'ไม่มีรหัส'} · ${r.due}`)
  }
  if (d.responsible.length > 0) lines.push(`ผู้รับผิดชอบ: ${d.responsible.join(', ')}`)
  lines.push(`แจ้งล่วงหน้า ${fmt(d.leadDays)} วัน / ${fmt(d.leadKm)} กม. / ${fmt(d.leadHours)} ชม. · ระบบแผน PM`)
  return lines.filter(Boolean).join('\n')
}
