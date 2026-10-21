// ---------------------------------------------------------------------------
// Flex Message ของใบขอเบิก/ขอยืม (Store Control — qtec-integra integra-store-service) ส่งด้วย OA HR
//
// กติกาเดียวกับ complaintFlex.ts / maintenanceFlex.ts (LINE for PC):
//   สีทึบเท่านั้น, wrap ทุก text, ไม่มี box ว่าง, ไม่ใช้ offset*/alignItems
//   หัวการ์ดใช้สีเข้ม (ตัวอักษรขาวต้องอ่านออก ≥ 4.5:1) ข้อความเล็กสุด xs สีจางสุด #6B7280
// การ์ดแสดง "ต้องเตรียมอะไร" (รายการ + จำนวน) ให้ทีมสโตร์เห็นทันทีโดยไม่ต้องเปิดระบบ
// ---------------------------------------------------------------------------

const INK = '#111827'
const MUTED = '#6B7280'
const TRACK = '#E5E7EB'
const CARD = '#F8FAFC'
const WHITE = '#FFFFFF'
const ON_COLOR_SOFT = '#EDE9FE'

/** ชนิดการ์ด = ชนิด event หลังแยก decided เป็นอนุมัติ/ไม่อนุมัติ (ใช้ใน STORE_REQUEST_LINE_EVENTS ด้วย) */
export type StoreRequestKind = 'submitted' | 'approved' | 'rejected' | 'fulfilled' | 'cancelled'
export const STORE_REQUEST_KINDS: StoreRequestKind[] = ['submitted', 'approved', 'rejected', 'fulfilled', 'cancelled']

export interface StoreRequestItem {
  itemCode?: string
  itemName?: string
  itemSize?: string | null
  unit?: string
  issueMode?: string
  qty?: number
  issuedQty?: number
  remainingQty?: number
}

/** payload ของ store.request.* (camelCase จาก System.Text.Json แบบ Web) — ทุกช่องอาจไม่มีใน event รุ่นเก่า */
export interface StoreRequestEvent {
  eventId?: string
  occurredAt?: string
  reqId: string
  by?: string
  requesterName?: string
  empId?: string
  empName?: string
  department?: string | null
  storeCode?: string
  storeName?: string
  projectNo?: string | null
  lines?: number
  totalQty?: number
  purpose?: string | null
  needByDate?: string | null
  status?: string
  items?: StoreRequestItem[]
  // decided
  decision?: string
  decidedBy?: string
  comment?: string | null
  // cancelled
  reason?: string
  cancelledBy?: string
  // fulfilled
  docNos?: string[]
  issuedQty?: number
  fulfilledBy?: string
}

const MAX_ITEMS = 10

function clean(v: unknown, max: number, fallback = '-'): string {
  const s = v === null || v === undefined ? '' : String(v).replace(/\s+/g, ' ').trim()
  if (!s) return fallback
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

function qty(n: unknown): string {
  const v = Number(n)
  if (!Number.isFinite(v)) return '-'
  return v.toLocaleString('en-US', { maximumFractionDigits: 2 })
}

function thaiDate(d: string | null | undefined): string {
  if (!d) return ''
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T00:00:00+07:00` : d)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString('th-TH', { timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short', year: '2-digit' })
}

/** "นาย ก (67-1-010)" — ชื่ออย่างเดียวถ้าไม่มีรหัส, รหัสอย่างเดียวถ้าไม่มีชื่อ */
function person(name?: string | null, code?: string | null): string {
  const n = clean(name, 60, '')
  const c = clean(code, 20, '')
  if (n && c && !n.includes(c)) return `${n} (${c})`
  return n || c || '-'
}

function isHttps(u: string | undefined | null): u is string {
  return typeof u === 'string' && /^https:\/\/\S+$/.test(u) && u.length <= 1000
}

function row(label: string, value: string) {
  return {
    type: 'box',
    layout: 'horizontal',
    spacing: 'md',
    contents: [
      { type: 'text', text: label, size: 'xs', color: MUTED, flex: 3, wrap: true },
      { type: 'text', text: value, size: 'sm', color: INK, weight: 'bold', flex: 7, wrap: true }
    ]
  }
}

function chip(text: string, bg: string, fg: string) {
  return {
    type: 'box',
    layout: 'vertical',
    backgroundColor: bg,
    cornerRadius: '999px',
    paddingAll: '4px',
    paddingStart: '10px',
    paddingEnd: '10px',
    flex: 0,
    contents: [{ type: 'text', text, size: 'xs', color: fg, weight: 'bold', wrap: true }]
  }
}

interface Tone {
  color: string
  icon: string
  title: string
}

function toneOf(kind: StoreRequestKind, e: StoreRequestEvent): Tone {
  switch (kind) {
    case 'submitted':
      return { color: '#3730A3', icon: '📝', title: 'ใบขอใหม่ — รออนุมัติ' }
    case 'approved':
      return { color: '#5B21B6', icon: '📦', title: 'ใบขออนุมัติแล้ว — รอสโตร์จ่ายของ' }
    case 'rejected':
      return { color: '#4B5563', icon: '⛔', title: 'ใบขอไม่ได้รับอนุมัติ' }
    case 'fulfilled':
      return e.status === 'PARTIAL'
        ? { color: '#B45309', icon: '🟡', title: 'จ่ายของบางส่วนแล้ว' }
        : { color: '#047857', icon: '✅', title: 'จ่ายของครบแล้ว' }
    case 'cancelled':
      return { color: '#4B5563', icon: '🚫', title: 'ใบขอถูกยกเลิก' }
  }
}

function itemRows(kind: StoreRequestKind, items: StoreRequestItem[]): unknown[] {
  const shown = items.slice(0, MAX_ITEMS).map((it) => {
    const borrow = (it.issueMode ?? '').toUpperCase() === 'BORROW'
    const name = clean(`${it.itemName ?? it.itemCode ?? ''}${it.itemSize ? ` ${it.itemSize}` : ''}`, 70)
    const unit = clean(it.unit, 12, '')
    // หลังจ่าย: แสดง "จ่ายแล้ว/ขอ" ให้เห็นว่ายังเหลืออะไร
    const amount =
      kind === 'fulfilled' && it.qty !== undefined && it.issuedQty !== undefined
        ? `${qty(it.issuedQty)}/${qty(it.qty)} ${unit}`
        : `${qty(it.qty)} ${unit}`
    return {
      type: 'box',
      layout: 'horizontal',
      spacing: 'md',
      contents: [
        {
          type: 'box',
          layout: 'vertical',
          flex: 7,
          contents: [
            { type: 'text', text: name, size: 'sm', color: INK, wrap: true },
            { type: 'text', text: `${borrow ? 'ยืม (ต้องคืน)' : 'เบิก'}${it.itemCode ? ` · ${clean(it.itemCode, 30)}` : ''}`, size: 'xs', color: MUTED, wrap: true }
          ]
        },
        { type: 'text', text: amount.trim(), size: 'sm', color: INK, weight: 'bold', flex: 3, align: 'end', wrap: true }
      ]
    }
  })
  const rest = items.length - shown.length
  return rest > 0 ? [...shown, { type: 'text', text: `และอีก ${rest} รายการ (ดูในระบบ)`, size: 'xs', color: MUTED, wrap: true }] : shown
}

/** การ์ดของ event หนึ่งรายการ */
export function buildStoreRequestCard(kind: StoreRequestKind, e: StoreRequestEvent, webUrl: string): { contents: unknown; altText: string } {
  const tone = toneOf(kind, e)
  const items = Array.isArray(e.items) ? e.items : []
  const lineCount = items.length || Number(e.lines ?? 0)

  const info: unknown[] = [
    row('ผู้ขอ', person(e.requesterName, e.by)),
    ...(e.empId && e.empId !== e.by ? [row('ผู้รับของ', person(e.empName, e.empId))] : []),
    row('สโตร์', clean(e.storeName || e.storeCode, 60)),
    ...(e.projectNo ? [row('โครงการ', clean(e.projectNo, 40))] : []),
    ...(thaiDate(e.needByDate) ? [row('ต้องการภายใน', thaiDate(e.needByDate))] : []),
    ...(e.purpose ? [row('ใช้สำหรับ', clean(e.purpose, 120))] : [])
  ]

  const outcome: unknown[] = []
  if (kind === 'approved' || kind === 'rejected') {
    if (e.decidedBy) outcome.push(row(kind === 'approved' ? 'อนุมัติโดย' : 'ไม่อนุมัติโดย', clean(e.decidedBy, 60)))
    if (e.comment) outcome.push(row('หมายเหตุ', clean(e.comment, 200)))
  } else if (kind === 'fulfilled') {
    if (e.docNos?.length) outcome.push(row('เอกสาร', clean(e.docNos.join(', '), 120)))
    if (e.issuedQty !== undefined) outcome.push(row('จ่ายครั้งนี้', `${qty(e.issuedQty)} ชิ้น`))
    if (e.fulfilledBy) outcome.push(row('จ่ายโดย', clean(e.fulfilledBy, 60)))
  } else if (kind === 'cancelled') {
    if (e.reason) outcome.push(row('เหตุผล', clean(e.reason, 200)))
    if (e.cancelledBy) outcome.push(row('ยกเลิกโดย', clean(e.cancelledBy, 60)))
  }

  const body: unknown[] = [
    { type: 'box', layout: 'vertical', spacing: 'sm', backgroundColor: CARD, cornerRadius: '10px', paddingAll: '12px', contents: info },
    ...(outcome.length ? [{ type: 'box', layout: 'vertical', spacing: 'sm', paddingStart: '4px', paddingEnd: '4px', contents: outcome }] : [])
  ]
  if (items.length) {
    body.push(
      { type: 'separator', color: TRACK },
      {
        type: 'box',
        layout: 'horizontal',
        contents: [
          { type: 'text', text: `รายการ ${lineCount} รายการ`, size: 'sm', color: INK, weight: 'bold', flex: 1, wrap: true },
          { type: 'text', text: `รวม ${qty(e.totalQty)} ชิ้น`, size: 'xs', color: MUTED, flex: 0, wrap: true }
        ]
      },
      { type: 'box', layout: 'vertical', spacing: 'md', contents: itemRows(kind, items) }
    )
  } else if (lineCount) {
    body.push({ type: 'text', text: `${lineCount} รายการ · รวม ${qty(e.totalQty)} ชิ้น`, size: 'sm', color: INK, wrap: true })
  }

  const tab = kind === 'approved' || kind === 'fulfilled' ? 'queue' : 'all'
  const url = webUrl ? `${webUrl}/store-control?view=request&tab=${tab}` : ''
  const footer = {
    type: 'box',
    layout: 'vertical',
    paddingAll: '12px',
    spacing: 'sm',
    contents: [
      ...(isHttps(url)
        ? [{ type: 'button', style: 'primary', color: tone.color, height: 'sm', action: { type: 'uri', label: kind === 'approved' ? 'เปิดคิวจ่ายของ' : 'เปิดใบขอในระบบ', uri: url } }]
        : []),
      { type: 'text', text: 'QTEC INTEGRA · ระบบควบคุมสโตร์', size: 'xs', color: MUTED, wrap: true, align: 'center' }
    ]
  }

  const contents = {
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: tone.color,
      paddingAll: '16px',
      spacing: 'xs',
      contents: [
        {
          type: 'box',
          layout: 'horizontal',
          spacing: 'sm',
          contents: [
            { type: 'text', text: `${tone.icon} ${tone.title}`, size: 'sm', color: ON_COLOR_SOFT, weight: 'bold', flex: 1, wrap: true },
            ...(kind === 'approved' && thaiDate(e.needByDate) ? [chip(`ภายใน ${thaiDate(e.needByDate)}`, WHITE, tone.color)] : [])
          ]
        },
        { type: 'text', text: clean(e.reqId, 30), size: 'xl', weight: 'bold', color: WHITE, wrap: true }
      ]
    },
    body: { type: 'box', layout: 'vertical', paddingAll: '16px', spacing: 'md', contents: body },
    footer,
    styles: { footer: { separator: true, separatorColor: TRACK } }
  }

  const firstItems = items
    .slice(0, 3)
    .map((it) => `${clean(it.itemName ?? it.itemCode, 30)} ${qty(it.qty)}`)
    .join(', ')
  const altText = `${tone.icon} ${clean(e.reqId, 30)} ${tone.title} · ${person(e.requesterName, e.by)}${firstItems ? ` · ${firstItems}${items.length > 3 ? ' …' : ''}` : ''}`.slice(0, 400)
  return { contents, altText }
}

/** ตัวอย่าง payload สำหรับทดสอบหน้าตาการ์ด (scripts/store-request-card.ts) */
export function sampleStoreRequestEvent(kind: StoreRequestKind): StoreRequestEvent {
  const base: StoreRequestEvent = {
    reqId: 'RQ-2610-0099',
    by: '67-1-010',
    requesterName: 'นาย ทรงธรรม ศรีสร้างคอม',
    empId: '67-1-009',
    empName: 'นาย ตัวอย่าง ลูกทีม',
    department: 'Production',
    storeCode: '401',
    storeName: 'Store 401',
    projectNo: 'J-401',
    lines: 3,
    totalQty: 6,
    purpose: 'งานเชื่อมท่อ Unit 3 กะเช้า',
    needByDate: new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10),
    status: kind === 'approved' ? 'APPROVED' : kind === 'rejected' ? 'REJECTED' : kind === 'cancelled' ? 'CANCELLED' : kind === 'fulfilled' ? 'PARTIAL' : 'SUBMITTED',
    items: [
      { itemCode: 'PPE-HLM-01', itemName: 'หมวกนิรภัย', itemSize: 'สีขาว', unit: 'ใบ', issueMode: 'ISSUE', qty: 2, issuedQty: kind === 'fulfilled' ? 2 : 0, remainingQty: kind === 'fulfilled' ? 0 : 2 },
      { itemCode: 'TL-GRD-04', itemName: 'เครื่องเจียร 4 นิ้ว', unit: 'เครื่อง', issueMode: 'BORROW', qty: 1, issuedQty: kind === 'fulfilled' ? 1 : 0, remainingQty: kind === 'fulfilled' ? 0 : 1 },
      { itemCode: 'PPE-FRB-01', itemName: 'ผ้ากันไฟ', unit: 'ผืน', issueMode: 'BORROW', qty: 3, issuedQty: kind === 'fulfilled' ? 1 : 0, remainingQty: kind === 'fulfilled' ? 2 : 3 }
    ]
  }
  if (kind === 'approved') return { ...base, decision: 'approved', decidedBy: '56-1-001' }
  if (kind === 'rejected') return { ...base, decision: 'rejected', decidedBy: '56-1-001', comment: 'ใช้ของในไซต์ก่อน' }
  if (kind === 'fulfilled') return { ...base, docNos: ['GI-2610-0099', 'BR-2610-0099'], issuedQty: 4, fulfilledBy: 'store-clerk' }
  if (kind === 'cancelled') return { ...base, reason: 'เปลี่ยนแผนงาน', cancelledBy: '67-1-010' }
  return base
}
