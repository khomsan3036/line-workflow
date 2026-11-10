// ---------------------------------------------------------------------------
// Flex Message ของคำขอเพิ่มรหัสสินค้าใหม่ (Good Code Master — qtec-integra integra-costcode-service) ส่งด้วย OA HR
//
// หน้าตาตามแบบ exemple/LINE Flex – ขอเพิ่มรหัสสินค้า.html (bubble mega กว้าง 300 px, แก้ล่าสุด 2026-11-05 17:04)
//   1 · แจ้งคำขอใหม่ (ผู้อนุมัติ)            = kind 'submitted'  หัวน้ำเงิน + ป้าย "รออนุมัติ" ปุ่มอนุมัติ/ไม่อนุมัติ/ดูรายละเอียด
//   2 · แจ้งผลกลับ (ผู้ขอ)                  = kind 'approved'   หัวเขียว ✓ + กล่องเขียว "รหัสสินค้าใหม่" ปุ่มดูรายละเอียดคำขอ
//   3 · แจ้งผลกลับ – ไม่อนุมัติ (ผู้ขอ)      = kind 'rejected'   หัวแดง ✕ + กล่องแดง "เหตุผลที่ไม่อนุมัติ" ลิงก์ดูรายละเอียดคำขอ
//
// กติกาเดียวกับ storeRequestFlex.ts / complaintFlex.ts (LINE for PC):
//   สีทึบเท่านั้น, wrap ทุก text, ไม่มี box ว่าง, ไม่ใช้ offset*/alignItems
// ปุ่ม "อนุมัติ"/"ไม่อนุมัติ" เปิดหน้า Good Code Master (แท็บคำขอ) พร้อม request=<id>&action=… ให้หน้าเว็บเปิดกล่องตัดสิน
//   (การอนุมัติต้องใช้สิทธิ์ good-code:approve ของผู้ใช้ที่ล็อกอิน แอปนี้ไม่ได้ตัดสินแทน)
// ---------------------------------------------------------------------------

const ACCENT = '#1F4FD1'
const APPROVE = '#067A3B'
const REJECT = '#B42318'
const REJECT_HEAD = '#ECBAB5' // แบบใช้ #D76F66 ทึบ 48% บนพื้นขาว — การ์ดใช้สีทึบเท่านั้น จึงผสมเป็นสีนี้
const REJECT_MARK = '#E84E40'
const REJECT_INK = '#3D0F0A'
const REJECT_TEXT = '#A8352B'
const REJECT_SOFT = '#FEF0EE'
const REJECT_LINE = '#F9C4BE'
const APPROVE_INK = '#055C2D'
const APPROVE_SOFT = '#E8F5EC'
const APPROVE_LINE = '#9FD8B3'
const APPROVED_CHIP = '#C8F0D6'
const INK = '#111111'
const BODY = '#333333'
const MUTED = '#6B6B6B'
const SOFT = '#F5F6F8'
const WHITE = '#FFFFFF'
const PENDING_BG = '#FFE3A3'
const PENDING_FG = '#7A4B00'
const PANEL_LINE = '#E3E6EB'

export type GoodCodeCardKind = 'submitted' | 'approved' | 'rejected'
export const GOOD_CODE_CARD_KINDS: GoodCodeCardKind[] = ['submitted', 'approved', 'rejected']

/** ข้อมูลคำขอหลังรวม event + รายละเอียดจาก API แล้ว (ทุกช่องอาจว่างถ้า API ถามไม่ได้) */
export interface GoodCodeRequestView {
  requestId: string
  /** เลขที่คำขอจากฐานข้อมูล TblGoodCodeRequest.RequestNo เช่น GCR-2611-0011 (ว่างถ้า API ถามไม่ได้) */
  requestNo?: string | null
  goodCode: string
  /** New | Edit | Correction | Archive */
  type: string
  goodName?: string | null
  goodNameEng?: string | null
  goodTypeCode?: string | null
  goodTypeName?: string | null
  goodCateCode?: string | null
  goodCateName?: string | null
  goodGroupCode?: string | null
  goodGroupName?: string | null
  unitName?: string | null
  /** รหัสพนักงานผู้ขอ (เช่น 56-1-715) */
  requestedBy?: string | null
  requesterName?: string | null
  department?: string | null
  requestedAt?: string | null
  reason?: string | null
  decidedBy?: string | null
  deciderName?: string | null
  decidedAt?: string | null
  decisionReason?: string | null
}

function clean(v: unknown, max: number, fallback = '-'): string {
  const s = v === null || v === undefined ? '' : String(v).replace(/\s+/g, ' ').trim()
  if (!s) return fallback
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/** เวลาไทยจาก integra (ไม่มี timezone = Asia/Bangkok อยู่แล้ว) — null ถ้าอ่านไม่ได้ */
function bangkokParts(d: string | null | undefined): Record<string, string> | null {
  if (!d) return null
  const iso = /(Z|[+-]\d{2}:?\d{2})$/.test(d) ? d : `${d.replace(/(\.\d{3})\d+$/, '$1')}+07:00`
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Bangkok',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(date)
  const out: Record<string, string> = {}
  for (const p of parts) out[p.type] = p.value
  return out
}

/**
 * เลขที่คำขอจริง GCR-YYMM-#### จากฐานข้อมูล (TblGoodCodeRequest.RequestNo ผ่าน API/event)
 * ถามไม่ได้ = #8 ตัวแรกของ GUID (ให้รู้ว่าไม่ใช่เลขที่จริง)
 */
export function requestNo(v: Pick<GoodCodeRequestView, 'requestNo' | 'requestId'>): string {
  const no = clean(v.requestNo, 20, '')
  if (no) return no
  const id = (v.requestId ?? '').replace(/-/g, '').trim().toUpperCase()
  return id ? `#${id.slice(0, 8)}` : '-'
}

/** DD/MM/YYYY HH:mm (Asia/Bangkok) */
export function thaiDateTime(d: string | null | undefined): string {
  const t = bangkokParts(d)
  return t ? `${t.day}/${t.month}/${t.year} ${t.hour}:${t.minute}` : ''
}

/** ชื่อคนอย่างเดียว (ไม่โชว์รหัสพนักงาน) — ไม่รู้ชื่อจึงค่อยใช้รหัส */
function person(name?: string | null, code?: string | null): string {
  return clean(name, 60, '') || clean(code, 20, '') || '-'
}

/** LINE รับ uri action เฉพาะ http/https (ยาวไม่เกิน 1000) — http ใช้ได้เพื่อทดสอบกับ localhost */
function isWebUrl(u: string | undefined | null): u is string {
  return typeof u === 'string' && /^https?:\/\/\S+$/.test(u) && u.length <= 1000
}

/** แถว "ป้าย : ค่า" (ป้ายกว้างราว 76 px ของการ์ด 300 px = 1 : 2) */
function row(label: string, value: string) {
  return {
    type: 'box',
    layout: 'horizontal',
    spacing: 'sm',
    contents: [
      { type: 'text', text: label, size: 'sm', color: MUTED, flex: 1, wrap: true },
      { type: 'text', text: value, size: 'sm', color: INK, weight: 'bold', flex: 2, wrap: true }
    ]
  }
}

/** ค่าแบบ "รหัส · ชื่อ" (ไม่มีรหัส = ชื่ออย่างเดียว) */
function codedValue(code: string | null | undefined, name: string | null | undefined): string {
  const c = clean(code, 20, '')
  const n = clean(name, 80)
  return c ? `${c} · ${n}` : n
}

/** กล่องขอบเทา (border #E3E6EB มุม 10 px) ครอบแถวข้อมูล */
function panel(rows: unknown[]) {
  return {
    type: 'box',
    layout: 'vertical',
    borderWidth: '1px',
    borderColor: PANEL_LINE,
    cornerRadius: '10px',
    paddingAll: '10px',
    paddingStart: '12px',
    paddingEnd: '12px',
    spacing: 'sm',
    contents: rows
  }
}

function chip(text: string, bg: string, fg: string) {
  return {
    type: 'box',
    layout: 'vertical',
    backgroundColor: bg,
    cornerRadius: '999px',
    paddingAll: '3px',
    paddingStart: '8px',
    paddingEnd: '8px',
    flex: 0,
    contents: [{ type: 'text', text, size: 'xxs', color: fg, weight: 'bold', wrap: true }]
  }
}

/** วงกลมขาว 44 px ใส่เครื่องหมาย ✓ / ✕ สีของผล (หัวการ์ดผล) */
function resultMark(mark: string, color: string) {
  return {
    type: 'box',
    layout: 'vertical',
    flex: 0,
    width: '44px',
    height: '44px',
    backgroundColor: WHITE,
    cornerRadius: '999px',
    paddingAll: '10px',
    contents: [{ type: 'text', text: mark, size: 'lg', weight: 'bold', color, align: 'center', wrap: true }]
  }
}

/** ปุ่มเปิดหน้าเว็บ (ตัดทิ้งถ้า URL ไม่ใช่ http/https เพราะ LINE ไม่รับ) */
function uriButton(label: string, uri: string, style: 'primary' | 'secondary' | 'link', color: string) {
  if (!isWebUrl(uri)) return null
  return { type: 'button', style, color, height: 'sm', action: { type: 'uri', label, uri } }
}

export type GoodCodePageLink = { requestId?: string; action?: 'approve' | 'reject' }

/**
 * หน้า Good Code Master ของ qtec-integra
 * request=<id> ให้แท็บคำขอเลื่อนไปที่คำขอนั้น และ action=approve|reject เปิดกล่องอนุมัติ/ไม่อนุมัติให้เลย
 * (good-code-workspace.tsx / good-code-requests.tsx ของ qtec-integra อ่านพารามิเตอร์เหล่านี้ตอนเปิดหน้า)
 */
export function goodCodePageUrl(webUrl: string, view: 'register' | 'requests' = 'requests', link: GoodCodePageLink = {}): string {
  if (!webUrl) return ''
  const q = new URLSearchParams({ view })
  if (link.requestId) q.set('request', link.requestId)
  if (link.requestId && link.action) q.set('action', link.action)
  return `${webUrl.replace(/\/+$/, '')}/good-code?${q.toString()}`
}

function requestTitle(type: string): string {
  switch ((type || '').toLowerCase()) {
    case 'edit':
      return 'มีคำขอแก้ไขข้อมูลสินค้า'
    case 'correction':
      return 'มีคำขอแก้ไขรหัสสินค้า'
    case 'archive':
      return 'มีคำขอยกเลิกรหัสสินค้า'
    default:
      return 'มีคำขอเพิ่มรหัสสินค้าใหม่'
  }
}

/** 1 · แจ้งคำขอใหม่ (ผู้อนุมัติ) */
function submittedCard(v: GoodCodeRequestView, webUrl: string): unknown {
  const url = goodCodePageUrl(webUrl, 'requests', { requestId: v.requestId })
  const approveUrl = goodCodePageUrl(webUrl, 'requests', { requestId: v.requestId, action: 'approve' })
  const rejectUrl = goodCodePageUrl(webUrl, 'requests', { requestId: v.requestId, action: 'reject' })
  const requester = v.department ? `${person(v.requesterName, v.requestedBy)} · ${clean(v.department, 40)}` : person(v.requesterName, v.requestedBy)
  const reject = isWebUrl(rejectUrl)
    ? [
        {
          type: 'box',
          layout: 'vertical',
          flex: 1,
          borderWidth: '1px',
          borderColor: REJECT_TEXT,
          cornerRadius: '10px',
          paddingAll: '10px',
          action: { type: 'uri', label: 'ไม่อนุมัติ', uri: rejectUrl },
          contents: [{ type: 'text', text: 'ไม่อนุมัติ', size: 'sm', weight: 'bold', color: REJECT, align: 'center', wrap: true }]
        }
      ]
    : []
  const approve = uriButton('อนุมัติ', approveUrl, 'primary', APPROVE)
  const detail = uriButton('ดูรายละเอียดคำขอ', url, 'link', ACCENT)
  const footer = [...(approve ? [{ type: 'box', layout: 'horizontal', spacing: 'sm', contents: [approve, ...reject] }] : []), ...(detail ? [detail] : [])]

  return {
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: ACCENT,
      paddingAll: '18px',
      paddingStart: '20px',
      paddingEnd: '20px',
      paddingBottom: '16px',
      spacing: 'sm',
      contents: [
        {
          type: 'box',
          layout: 'horizontal',
          spacing: 'sm',
          contents: [
            { type: 'text', text: 'GOODCODE REQUEST', size: 'xs', weight: 'bold', color: WHITE, flex: 1, wrap: true },
            chip('รออนุมัติ', PENDING_BG, PENDING_FG)
          ]
        },
        { type: 'text', text: requestTitle(v.type), size: 'lg', weight: 'bold', color: WHITE, wrap: true },
        { type: 'text', text: `เลขที่ ${requestNo(v)}`, size: 'sm', color: WHITE, wrap: true }
      ]
    },
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '20px',
      paddingTop: '16px',
      spacing: 'md',
      contents: [
        {
          type: 'box',
          layout: 'vertical',
          spacing: 'xs',
          contents: [
            { type: 'text', text: 'รหัสสินค้า', size: 'xs', color: MUTED, wrap: true },
            { type: 'text', text: clean(v.goodCode, 30), size: 'xxl', weight: 'bold', color: ACCENT, wrap: true },
            { type: 'text', text: clean(v.goodName, 120), size: 'md', color: BODY, wrap: true }
          ]
        },
        panel([
          row('ประเภทสินค้า', codedValue(v.goodTypeCode, v.goodTypeName)),
          row('หมวดสินค้า', codedValue(v.goodCateCode, v.goodCateName)),
          row('กลุ่มสินค้า', codedValue(v.goodGroupCode, v.goodGroupName)),
          row('หน่วยนับ', clean(v.unitName, 30))
        ]),
        panel([row('ผู้ขอ', requester), row('วันที่ขอ', thaiDateTime(v.requestedAt) || '-')]),
        {
          type: 'box',
          layout: 'vertical',
          backgroundColor: SOFT,
          cornerRadius: '10px',
          paddingAll: '10px',
          paddingStart: '12px',
          paddingEnd: '12px',
          spacing: 'xs',
          contents: [
            { type: 'text', text: 'เหตุผล', size: 'xs', color: MUTED, wrap: true },
            { type: 'text', text: clean(v.reason, 300), size: 'sm', color: INK, wrap: true }
          ]
        }
      ]
    },
    ...(footer.length > 0
      ? { footer: { type: 'box', layout: 'vertical', paddingAll: '20px', paddingTop: '4px', paddingBottom: '18px', spacing: 'sm', contents: footer } }
      : {})
  }
}

/** 2 · แจ้งผลกลับ – อนุมัติ (ผู้ขอ) */
function approvedCard(v: GoodCodeRequestView, webUrl: string): unknown {
  const url = goodCodePageUrl(webUrl, 'requests', { requestId: v.requestId })
  const open = uriButton('ดูรายละเอียดคำขอ', url, 'primary', APPROVE)
  return {
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: APPROVE,
      paddingAll: '18px',
      paddingStart: '20px',
      paddingEnd: '20px',
      paddingBottom: '16px',
      spacing: 'md',
      contents: [
        {
          type: 'box',
          layout: 'horizontal',
          spacing: 'sm',
          contents: [
            { type: 'text', text: 'GOODCODE REQUEST', size: 'xs', weight: 'bold', color: WHITE, flex: 1, wrap: true },
            chip('อนุมัติแล้ว', APPROVED_CHIP, APPROVE_INK)
          ]
        },
        {
          type: 'box',
          layout: 'horizontal',
          spacing: 'md',
          contents: [
            resultMark('✓', APPROVE),
            {
              type: 'box',
              layout: 'vertical',
              flex: 1,
              spacing: 'xs',
              contents: [
                { type: 'text', text: 'อนุมัติรหัสสินค้าแล้ว', size: 'lg', weight: 'bold', color: WHITE, wrap: true },
                { type: 'text', text: `คำขอเลขที่ ${requestNo(v)}`, size: 'sm', color: WHITE, wrap: true }
              ]
            }
          ]
        }
      ]
    },
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '20px',
      paddingTop: '16px',
      spacing: 'md',
      contents: [
        {
          type: 'box',
          layout: 'vertical',
          backgroundColor: APPROVE_SOFT,
          borderWidth: '1px',
          borderColor: APPROVE_LINE,
          cornerRadius: '12px',
          paddingAll: '14px',
          spacing: 'xs',
          contents: [
            { type: 'text', text: 'รหัสสินค้าใหม่', size: 'xs', weight: 'bold', color: APPROVE_INK, align: 'center', wrap: true },
            { type: 'text', text: clean(v.goodCode, 30), size: 'xxl', weight: 'bold', color: APPROVE_INK, align: 'center', wrap: true }
          ]
        },
        panel([
          row('ชื่อสินค้า', clean(v.goodName, 120)),
          row('อนุมัติโดย', person(v.deciderName, v.decidedBy)),
          row('วันที่', thaiDateTime(v.decidedAt) || '-'),
          ...(v.decisionReason ? [row('หมายเหตุ', clean(v.decisionReason, 300))] : [])
        ])
      ]
    },
    ...(open ? { footer: { type: 'box', layout: 'vertical', paddingAll: '20px', paddingTop: '0px', paddingBottom: '18px', contents: [open] } } : {})
  }
}

/** 3 · แจ้งผลกลับ – ไม่อนุมัติ (ผู้ขอ) */
function rejectedCard(v: GoodCodeRequestView, webUrl: string): unknown {
  const url = goodCodePageUrl(webUrl, 'requests', { requestId: v.requestId })
  const open = uriButton('ดูรายละเอียดคำขอ', url, 'link', ACCENT)
  return {
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: REJECT_HEAD,
      paddingAll: '18px',
      paddingStart: '20px',
      paddingEnd: '20px',
      paddingBottom: '16px',
      spacing: 'md',
      contents: [
        {
          type: 'box',
          layout: 'horizontal',
          spacing: 'sm',
          contents: [
            { type: 'text', text: 'GOODCODE REQUEST', size: 'xs', weight: 'bold', color: REJECT_INK, flex: 1, wrap: true },
            chip('ไม่อนุมัติ', WHITE, REJECT_TEXT)
          ]
        },
        {
          type: 'box',
          layout: 'horizontal',
          spacing: 'md',
          contents: [
            resultMark('✕', REJECT_MARK),
            {
              type: 'box',
              layout: 'vertical',
              flex: 1,
              spacing: 'xs',
              contents: [
                { type: 'text', text: 'ไม่อนุมัติคำขอรหัสสินค้า', size: 'lg', weight: 'bold', color: REJECT_INK, wrap: true },
                { type: 'text', text: `คำขอเลขที่ ${requestNo(v)}`, size: 'sm', color: REJECT_INK, wrap: true }
              ]
            }
          ]
        }
      ]
    },
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '20px',
      paddingTop: '16px',
      spacing: 'md',
      contents: [
        {
          type: 'box',
          layout: 'vertical',
          spacing: 'xs',
          contents: [
            { type: 'text', text: 'รหัสสินค้าที่ขอ', size: 'xs', color: MUTED, wrap: true },
            { type: 'text', text: clean(v.goodCode, 30), size: 'xxl', weight: 'bold', color: BODY, wrap: true }
          ]
        },
        {
          type: 'box',
          layout: 'vertical',
          backgroundColor: REJECT_SOFT,
          borderWidth: '1px',
          borderColor: REJECT_LINE,
          cornerRadius: '12px',
          paddingAll: '12px',
          paddingStart: '14px',
          paddingEnd: '14px',
          spacing: 'xs',
          contents: [
            { type: 'text', text: 'เหตุผลที่ไม่อนุมัติ', size: 'xs', weight: 'bold', color: REJECT_TEXT, wrap: true },
            { type: 'text', text: clean(v.decisionReason, 300), size: 'md', color: BODY, wrap: true }
          ]
        },
        panel([
          row('ชื่อสินค้า', clean(v.goodName, 120)),
          row('พิจารณาโดย', person(v.deciderName, v.decidedBy)),
          row('วันที่', thaiDateTime(v.decidedAt) || '-')
        ])
      ]
    },
    ...(open ? { footer: { type: 'box', layout: 'vertical', paddingAll: '20px', paddingTop: '0px', paddingBottom: '18px', contents: [open] } } : {})
  }
}

/** การ์ดของคำขอหนึ่งรายการ */
export function buildGoodCodeCard(kind: GoodCodeCardKind, v: GoodCodeRequestView, webUrl: string): { contents: unknown; altText: string } {
  const contents = kind === 'submitted' ? submittedCard(v, webUrl) : kind === 'approved' ? approvedCard(v, webUrl) : rejectedCard(v, webUrl)
  const name = clean(v.goodName, 40, '')
  const no = requestNo(v)
  const altText =
    kind === 'submitted'
      ? `📝 ${requestTitle(v.type)} ${clean(v.goodCode, 30)}${name ? ` ${name}` : ''} · ผู้ขอ ${person(v.requesterName, v.requestedBy)} · รออนุมัติ (${no})`
      : `${kind === 'approved' ? '✅ อนุมัติรหัสสินค้าแล้ว' : '⛔ ไม่อนุมัติคำขอรหัสสินค้า'} ${clean(v.goodCode, 30)}${name ? ` ${name}` : ''} (${no})`
  return { contents, altText: altText.slice(0, 400) }
}

/** ตัวอย่างข้อมูลสำหรับดูหน้าตาการ์ด (scripts/good-code-card.ts) */
export function sampleGoodCodeRequest(kind: GoodCodeCardKind): GoodCodeRequestView {
  const base: GoodCodeRequestView = {
    requestId: 'ca436ca3-b080-449e-9ed7-d0b89701b65f',
    requestNo: 'GCR-2611-0011',
    goodCode: '0030012-0527',
    type: 'New',
    goodName: 'ทดสอบ21',
    goodNameEng: 'test21',
    goodTypeCode: '0030000',
    goodTypeName: 'วัตถุดิบทางตรง',
    goodCateCode: '0030012',
    goodCateName: 'ข้อต่อเหล็กกล้าคาร์บอน',
    goodGroupCode: '0030012',
    goodGroupName: 'ข้อต่อเหล็กกล้าคาร์บอน',
    unitName: 'EA',
    requestedBy: '56-1-715',
    requesterName: 'นาย ตัวอย่าง ผู้ขอ',
    department: 'Procurement',
    requestedAt: '2026-11-05T09:05:00',
    reason: 'ขอเพิ่มรหัสสินค้า'
  }
  if (kind === 'approved') return { ...base, decidedBy: '56-1-001', deciderName: 'นาย ตัวอย่าง ผู้อนุมัติ', decidedAt: '2026-11-05T10:41:00' }
  if (kind === 'rejected') return { ...base, decidedBy: '56-1-001', deciderName: 'นาย ตัวอย่าง ผู้อนุมัติ', decidedAt: '2026-11-05T10:41:00', decisionReason: 'มีรหัสเดิมใช้อยู่แล้ว ให้ใช้ 0030012-0120' }
  return base
}
