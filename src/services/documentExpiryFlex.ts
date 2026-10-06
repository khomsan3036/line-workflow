// ---------------------------------------------------------------------------
// การ์ด Flex สำหรับ "เอกสารใกล้หมดอายุ" ที่ระบบ maintenance-asset-service ส่งมา
// (routing key maintenance.line.notification, category = document_expiry_*)
//
// ทำไมต้องมีการ์ดเฉพาะ ไม่ใช้ buildAlertCard ทั่วไป:
//   การ์ดทั่วไปจะโชว์ "ประเภท: document_expiry_sticker" ซึ่งอ่านไม่รู้เรื่อง และเอาเลข
//   "เหลือกี่วัน" ไปซ่อนในบรรทัดข้อความ ทั้งที่มันเป็นข้อมูลเดียวที่คนอ่านต้องเห็นก่อน
//
// หลักการออกแบบ (ยึดตาม maintenanceFlex.ts เดิม):
//   - สีทึบเท่านั้น ห้าม #RRGGBBAA (LINE ไม่รองรับ alpha)
//   - ตัวอักษรเล็กสุด xs สีจางสุด MUTED
//   - อ่านจบได้ใน 3 วินาที: หัวข้อ -> ตัวเลขใหญ่ -> รายการ -> ปุ่ม
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
const GREEN_DEEP = '#047857'

/** แถวหนึ่งรายการในการ์ด (ถอดมาจาก metadata.rows ที่ asset service ส่งมา) */
export interface ExpiryRow {
  docType: string
  owner: string
  code?: string | null
  expiry: string
  daysLeft: number
}

export interface ExpiryDigest {
  categoryLabel: string
  leadDays: number
  dueCount: number
  expiredCount: number
  message: string
  rows: ExpiryRow[]
  /** ลิงก์หน้าเอกสารในเว็บ (ว่าง = ไม่มีปุ่ม) */
  webUrl?: string
}

/** อ่าน digest ออกจาก payload; คืน null ถ้าไม่ใช่ event เอกสารหมดอายุ */
export function parseExpiryDigest(e: Record<string, unknown>, webUrl: string): ExpiryDigest | null {
  const category = typeof e.category === 'string' ? e.category : ''
  if (!category.startsWith('document_expiry_')) return null

  const meta = (e.metadata ?? {}) as Record<string, unknown>
  const num = (v: unknown, fallback = 0): number => {
    const n = Number(typeof v === 'string' ? v.trim() : v)
    return Number.isFinite(n) ? n : fallback
  }

  let rows: ExpiryRow[] = []
  // rows มาเป็น JSON string (contract ของ metadata เป็น Dictionary<string,string>)
  if (typeof meta.rows === 'string' && meta.rows.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(meta.rows)
      if (Array.isArray(parsed)) {
        rows = parsed
          .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
          .map((r) => ({
            docType: String(r.docType ?? '-'),
            owner: String(r.owner ?? '-'),
            code: r.code == null ? null : String(r.code),
            expiry: String(r.expiry ?? '-'),
            daysLeft: num(r.daysLeft)
          }))
      }
    } catch {
      // metadata เสีย ไม่ควรทำให้การ์ดหายไปทั้งใบ — ตกไปใช้ items แทน
      rows = []
    }
  }

  return {
    categoryLabel: String(meta.categoryLabel ?? category.replace('document_expiry_', '')),
    leadDays: num(meta.leadDays, 30),
    dueCount: num(meta.dueCount, rows.length),
    expiredCount: num(meta.expiredCount),
    message: typeof e.message === 'string' ? e.message : '',
    rows,
    webUrl: /^https:\/\/\S+$/.test(webUrl) ? webUrl : undefined
  }
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
    contents: [{ type: 'text', text, size: 'xs', color, weight: 'bold', align: 'center', wrap: false }]
  }
}

/**
 * ตัวเลขใหญ่ "เหลือกี่วัน" ของรายการที่ด่วนที่สุด — คนอ่านเห็นอันนี้ก่อนทุกอย่าง
 * ติดลบ = เกินกำหนด แสดงเป็นบวกพร้อมคำว่า "เกินกำหนด"
 */
function heroDays(daysLeft: number, tone: { deep: string; soft: string }) {
  const overdue = daysLeft < 0
  const value = Math.abs(daysLeft)
  const caption = overdue ? 'เกินกำหนดแล้ว' : daysLeft === 0 ? 'หมดอายุ' : 'เหลืออีก'
  const unit = daysLeft === 0 ? 'วันนี้' : 'วัน'

  return {
    type: 'box',
    layout: 'vertical',
    backgroundColor: tone.soft,
    cornerRadius: '12px',
    paddingAll: '12px',
    width: '104px',
    flex: 0,
    spacing: 'none',
    contents: [
      { type: 'text', text: caption, size: 'xs', color: tone.deep, align: 'center', wrap: false },
      {
        type: 'text',
        text: daysLeft === 0 ? '—' : String(value),
        size: '3xl',
        weight: 'bold',
        color: tone.deep,
        align: 'center',
        wrap: false
      },
      { type: 'text', text: unit, size: 'xs', color: tone.deep, align: 'center', wrap: false }
    ]
  }
}

/** แถบสัดส่วน "เกินกำหนด / ใกล้หมดอายุ" ให้เห็นภาพรวมเป็นสัดส่วน ไม่ใช่แค่ตัวเลข */
function ratioBar(expired: number, due: number) {
  const pct = due > 0 ? Math.round((expired / due) * 100) : 0
  const contents: unknown[] = []
  if (pct > 0) {
    contents.push({
      type: 'box',
      layout: 'vertical',
      width: `${Math.max(pct, 4)}%`,
      backgroundColor: RED_DEEP,
      cornerRadius: '4px',
      contents: [{ type: 'filler' }]
    })
  }
  if (pct < 100) {
    contents.push({
      type: 'box',
      layout: 'vertical',
      width: `${Math.max(100 - pct, 4)}%`,
      backgroundColor: AMBER_DEEP,
      cornerRadius: '4px',
      contents: [{ type: 'filler' }]
    })
  }
  return {
    type: 'box',
    layout: 'horizontal',
    height: '6px',
    spacing: 'xs',
    backgroundColor: TRACK,
    cornerRadius: '4px',
    contents: contents.length > 0 ? contents : [{ type: 'filler' }]
  }
}

/** หนึ่งรายการ: ทะเบียน/ชื่อ + ชนิดเอกสาร + วันหมดอายุ + ป้ายวันคงเหลือ */
function rowBox(row: ExpiryRow) {
  const overdue = row.daysLeft < 0
  const tone = overdue ? RED_DEEP : row.daysLeft <= 3 ? AMBER_DEEP : MUTED
  const badge = overdue
    ? `เกิน ${Math.abs(row.daysLeft)} วัน`
    : row.daysLeft === 0
      ? 'วันนี้'
      : `${row.daysLeft} วัน`

  return {
    type: 'box',
    layout: 'horizontal',
    spacing: 'md',
    alignItems: 'center',
    contents: [
      // เส้นสีด้านซ้าย = ระดับความด่วนของแถวนั้น อ่านไล่ลงมาได้เร็ว
      {
        type: 'box',
        layout: 'vertical',
        width: '3px',
        height: '34px',
        backgroundColor: tone,
        cornerRadius: '2px',
        flex: 0,
        contents: [{ type: 'filler' }]
      },
      {
        type: 'box',
        layout: 'vertical',
        spacing: 'none',
        flex: 1,
        contents: [
          { type: 'text', text: row.owner, size: 'sm', weight: 'bold', color: INK, wrap: true },
          {
            type: 'text',
            text: `${row.docType} · ${row.expiry}`,
            size: 'xs',
            color: MUTED,
            wrap: true
          }
        ]
      },
      { type: 'text', text: badge, size: 'xs', weight: 'bold', color: tone, align: 'end', flex: 0, wrap: false }
    ]
  }
}

/**
 * การ์ด digest ของหนึ่งหมวดเอกสาร
 *
 * โครงการ์ด: หัวสีตามความด่วน -> ตัวเลขวันที่ด่วนสุด + สรุปจำนวน -> แถบสัดส่วน ->
 * รายการ (ไม่เกิน 5 แถว + บอกว่าเหลืออีกกี่รายการ) -> ปุ่มเปิดหน้าเว็บ
 */
export function buildExpiryDigestCard(d: ExpiryDigest): unknown {
  const anyOverdue = d.expiredCount > 0
  const tone = anyOverdue ? { deep: RED_DEEP, soft: RED_SOFT } : { deep: AMBER_DEEP, soft: AMBER_SOFT }
  const sorted = [...d.rows].sort((a, b) => a.daysLeft - b.daysLeft)
  const worst = sorted[0]
  const shown = sorted.slice(0, 5)
  const rest = d.dueCount - shown.length

  const body: unknown[] = [
    {
      type: 'box',
      layout: 'horizontal',
      spacing: 'md',
      contents: [
        ...(worst ? [heroDays(worst.daysLeft, tone)] : []),
        {
          type: 'box',
          layout: 'vertical',
          spacing: 'sm',
          flex: 1,
          contents: [
            {
              type: 'box',
              layout: 'baseline',
              spacing: 'xs',
              contents: [
                { type: 'text', text: String(d.dueCount), size: 'xl', weight: 'bold', color: INK, flex: 0 },
                { type: 'text', text: 'รายการที่ต้องดูแล', size: 'xs', color: MUTED, flex: 1 }
              ]
            },
            ratioBar(d.expiredCount, d.dueCount),
            {
              type: 'box',
              layout: 'horizontal',
              spacing: 'sm',
              contents: [
                {
                  type: 'text',
                  text: `● เกินกำหนด ${d.expiredCount}`,
                  size: 'xxs',
                  color: RED_DEEP,
                  flex: 0,
                  wrap: false
                },
                {
                  type: 'text',
                  text: `● ใกล้หมดอายุ ${Math.max(d.dueCount - d.expiredCount, 0)}`,
                  size: 'xxs',
                  color: AMBER_DEEP,
                  wrap: false
                }
              ]
            }
          ]
        }
      ]
    }
  ]

  if (d.message) {
    body.push({ type: 'text', text: d.message, size: 'sm', color: INK, wrap: true })
  }

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
              {
                type: 'text',
                text: `และอีก ${rest} รายการ — ดูทั้งหมดในระบบ`,
                size: 'xs',
                color: MUTED,
                align: 'center',
                wrap: true
              }
            ]
          : [])
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
        label: 'เปิดหน้าเอกสารและวันหมดอายุ',
        uri: `${d.webUrl}/services/assets-control`
      }
    })
  }
  footer.push({
    type: 'text',
    text: `แจ้งล่วงหน้า ${d.leadDays} วัน · ระบบเอกสารและวันหมดอายุ`,
    size: 'xxs',
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
      backgroundColor: tone.deep,
      paddingAll: '16px',
      spacing: 'sm',
      contents: [
        {
          type: 'box',
          layout: 'horizontal',
          alignItems: 'center',
          contents: [
            {
              type: 'text',
              text: `${anyOverdue ? '🚨' : '🔔'} เอกสารใกล้หมดอายุ`,
              size: 'xs',
              color: ON_COLOR_SOFT,
              flex: 1,
              wrap: false
            },
            chip(anyOverdue ? 'ต้องทำวันนี้' : 'เตรียมล่วงหน้า', WHITE, tone.deep)
          ]
        },
        { type: 'text', text: d.categoryLabel, size: 'xl', weight: 'bold', color: WHITE, wrap: true }
      ]
    },
    body: { type: 'box', layout: 'vertical', paddingAll: '16px', spacing: 'lg', contents: body },
    footer: { type: 'box', layout: 'vertical', paddingAll: '12px', spacing: 'sm', contents: footer }
  }
}

/** ข้อความสำรอง (เครื่องที่แสดง Flex ไม่ได้ และใช้เป็น altText) */
export function expiryDigestToText(d: ExpiryDigest): string {
  const lines = [
    `${d.expiredCount > 0 ? '🚨' : '🔔'} ${d.categoryLabel}: ${d.dueCount} รายการต้องดูแล (เกินกำหนด ${d.expiredCount})`,
    d.message
  ]
  for (const r of [...d.rows].sort((a, b) => a.daysLeft - b.daysLeft).slice(0, 6)) {
    const left = r.daysLeft < 0 ? `เกินกำหนด ${Math.abs(r.daysLeft)} วัน` : r.daysLeft === 0 ? 'หมดอายุวันนี้' : `อีก ${r.daysLeft} วัน`
    lines.push(`- ${r.owner} · ${r.docType} · ${r.expiry} · ${left}`)
  }
  lines.push(`แจ้งล่วงหน้า ${d.leadDays} วัน · ระบบเอกสารและวันหมดอายุ`)
  return lines.filter(Boolean).join('\n')
}

export const EXPIRY_TONES = { RED_DEEP, AMBER_DEEP, GREEN_DEEP }
