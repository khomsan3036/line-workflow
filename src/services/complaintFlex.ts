// ---------------------------------------------------------------------------
// Flex Message ของระบบรับเรื่องร้องเรียน (complaint-system) ส่งด้วย OA HR
//
// กติกาเดียวกับ maintenanceFlex.ts: สีทึบเท่านั้น (PC renderer), wrap ทุก text, ไม่มี box ว่าง
// การ์ด "ไม่มีรายละเอียด/ชื่อผู้ร้อง" โดยเจตนา - รายละเอียดอยู่ในระบบ (ต้องล็อกอิน)
//   - hero = thumbnail รูปแรก (signed URL อายุจำกัด ออกโดย Complaint.Api) แตะแล้วเปิด console
//   - หมวด Restricted ไม่มีรูป และฝั่ง Complaint.Api ตัด groupId ออกไปแล้ว
// ---------------------------------------------------------------------------

const INK = '#111827'
const MUTED = '#6B7280'
const TRACK = '#E5E7EB'
const CARD = '#F8FAFC'
const WHITE = '#FFFFFF'
const ON_COLOR_SOFT = '#F1F5F9'
const NAVY = '#0C1628'

const SEVERITY: Record<string, { color: string; soft: string; label: string }> = {
  Critical: { color: '#B91C1C', soft: '#FEF2F2', label: 'วิกฤต' },
  High: { color: '#B45309', soft: '#FFFBEB', label: 'สูง' },
  Medium: { color: '#1D4ED8', soft: '#EFF6FF', label: 'ปานกลาง' },
  Low: { color: '#047857', soft: '#ECFDF5', label: 'ต่ำ' }
}

const STATUS_TH: Record<string, string> = {
  Submitted: 'ได้รับเรื่องแล้ว',
  Acknowledged: 'มีผู้รับผิดชอบแล้ว',
  Investigating: 'กำลังตรวจสอบ',
  Resolved: 'ดำเนินการแล้ว',
  Closed: 'ปิดเรื่อง',
  Rejected: 'ไม่รับเรื่อง',
  Duplicate: 'เรื่องซ้ำ'
}

export interface ComplaintRecipient {
  targetId: string
  targetName?: string | null
  role: string
}

export interface ComplaintSubmitted {
  eventId: string
  complaintId: string
  ticketNo: string
  categoryCode: string
  categoryName: string
  subCategoryName: string
  severity: string
  confidentiality: string
  subjectKind: string
  vehiclePlate?: string | null
  vehicleDriver?: string | null
  submittedAt: string
  ackDueAt: string
  ackSlaHours: number
  recipients: ComplaintRecipient[]
  heroImage?: { thumbUrl: string; expiresAt: string; totalImages: number } | null
  consoleUrl: string
}

export interface ComplaintStatusChanged {
  eventId: string
  ticketNo: string
  categoryName: string
  fromStatus: string
  toStatus: string
  actorName?: string | null
  publicNote?: string | null
  recipients: ComplaintRecipient[]
  consoleUrl: string
}

export interface ComplaintSlaBreached {
  eventId: string
  ticketNo: string
  categoryName: string
  slaKind: 'Ack' | 'Resolve' | string
  dueAt: string
  status: string
  assigneeName?: string | null
  recipients: ComplaintRecipient[]
  consoleUrl: string
}

function clean(v: unknown, max: number, fallback = '-'): string {
  const s = v === null || v === undefined ? '' : String(v).replace(/\s+/g, ' ').trim()
  if (!s) return fallback
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

function bangkok(iso: string): string {
  const d = new Date(iso.endsWith('Z') || /[+-]\d\d:\d\d$/.test(iso) ? iso : `${iso}+07:00`)
  if (Number.isNaN(d.getTime())) return '-'
  return d.toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
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
    contents: [{ type: 'text', text, size: 'xs', color: fg, weight: 'bold', wrap: true }]
  }
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

function button(label: string, uri: string, color = NAVY) {
  return { type: 'button', style: 'primary', color, height: 'sm', action: { type: 'uri', label, uri } }
}

function isHttps(u: string | undefined | null): u is string {
  return typeof u === 'string' && /^https:\/\/\S+$/.test(u) && u.length <= 1000
}

/** การ์ด "เรื่องร้องเรียนใหม่" */
export function buildComplaintNewCard(e: ComplaintSubmitted): { contents: unknown; altText: string } {
  const sev = SEVERITY[e.severity] ?? SEVERITY.Medium
  const subject =
    e.subjectKind === 'Vehicle' && e.vehiclePlate
      ? `${e.vehiclePlate}${e.vehicleDriver ? ` · ${e.vehicleDriver}` : ''}`
      : e.subjectKind === 'Person'
        ? 'บุคคล (ดูในระบบ)'
        : 'ไม่ระบุ'
  const body: unknown[] = [
    {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      backgroundColor: CARD,
      cornerRadius: '10px',
      paddingAll: '12px',
      contents: [
        row('เลขที่', e.ticketNo),
        row('หมวด', clean(e.categoryName, 60)),
        row('หัวข้อ', clean(e.subCategoryName, 80)),
        row(e.subjectKind === 'Vehicle' ? 'รถ' : 'เกี่ยวกับ', clean(subject, 80)),
        row('แจ้งเมื่อ', bangkok(e.submittedAt)),
        row('รับเรื่องภายใน', `${bangkok(e.ackDueAt)} (${e.ackSlaHours} ชม.)`)
      ]
    },
    {
      type: 'text',
      text: 'รายละเอียดและรูปทั้งหมดอยู่ในระบบ (ต้องล็อกอิน) การ์ดนี้ไม่แสดงข้อมูลผู้ร้องเรียน',
      size: 'xs',
      color: MUTED,
      wrap: true
    }
  ]

  // LINE hero image: ต้องเป็น https และตัวไฟล์ ≤ 1 MB (Complaint.Api ย่อให้แล้ว)
  const hero =
    e.heroImage && isHttps(e.heroImage.thumbUrl) && isHttps(e.consoleUrl)
      ? {
          type: 'image',
          url: e.heroImage.thumbUrl,
          size: 'full',
          aspectRatio: '20:13',
          aspectMode: 'cover',
          action: { type: 'uri', label: 'ดูในระบบ', uri: e.consoleUrl }
        }
      : undefined

  const header = {
    type: 'box',
    layout: 'vertical',
    backgroundColor: sev.color,
    paddingAll: '16px',
    spacing: 'xs',
    contents: [
      {
        type: 'box',
        layout: 'horizontal',
        contents: [
          { type: 'text', text: '🔔 เรื่องร้องเรียนใหม่', size: 'xs', color: ON_COLOR_SOFT, flex: 1, wrap: true },
          chip(`ความรุนแรง ${sev.label}`, WHITE, sev.color)
        ]
      },
      { type: 'text', text: e.ticketNo, size: 'xl', weight: 'bold', color: WHITE, wrap: true },
      ...(e.heroImage && e.heroImage.totalImages > 1
        ? [{ type: 'text', text: `📷 รูปแนบ ${e.heroImage.totalImages} รูป`, size: 'xs', color: ON_COLOR_SOFT, wrap: true }]
        : [])
    ]
  }

  const footer = {
    type: 'box',
    layout: 'vertical',
    paddingAll: '12px',
    spacing: 'sm',
    contents: [
      ...(isHttps(e.consoleUrl) ? [button('เปิดดูและรับเรื่อง', e.consoleUrl)] : []),
      { type: 'text', text: 'ระบบรับเรื่องร้องเรียน QTEC', size: 'xs', color: MUTED, wrap: true }
    ]
  }

  const contents = {
    type: 'bubble',
    size: 'mega',
    header,
    ...(hero ? { hero } : {}),
    body: { type: 'box', layout: 'vertical', paddingAll: '16px', spacing: 'md', contents: body },
    footer,
    styles: { footer: { separator: true, separatorColor: TRACK } }
  }
  const altText = `🔔 เรื่องร้องเรียนใหม่ ${e.ticketNo} · ${clean(e.categoryName, 40)} › ${clean(e.subCategoryName, 40)} · ${subject}`.slice(0, 400)
  return { contents, altText }
}

/** การ์ดสถานะเปลี่ยน (รับเรื่อง / ดำเนินการแล้ว / ไม่รับเรื่อง) */
export function buildComplaintStatusCard(e: ComplaintStatusChanged): { contents: unknown; altText: string } {
  const tone =
    e.toStatus === 'Resolved' ? { color: '#047857', icon: '✅' } : e.toStatus === 'Rejected' ? { color: '#6B7280', icon: '⛔' } : { color: '#1D4ED8', icon: '👤' }
  const to = STATUS_TH[e.toStatus] ?? e.toStatus
  const body: unknown[] = [
    {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      backgroundColor: CARD,
      cornerRadius: '10px',
      paddingAll: '12px',
      contents: [
        row('เลขที่', e.ticketNo),
        row('หมวด', clean(e.categoryName, 60)),
        row('สถานะ', to),
        ...(e.actorName ? [row('โดย', clean(e.actorName, 60))] : [])
      ]
    },
    ...(e.publicNote ? [{ type: 'text', text: clean(e.publicNote, 300), size: 'sm', color: INK, wrap: true }] : [])
  ]
  const contents = {
    type: 'bubble',
    size: 'kilo',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: tone.color,
      paddingAll: '14px',
      contents: [{ type: 'text', text: `${tone.icon} ${to}`, size: 'md', weight: 'bold', color: WHITE, wrap: true }]
    },
    body: { type: 'box', layout: 'vertical', paddingAll: '14px', spacing: 'md', contents: body },
    footer: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '12px',
      contents: isHttps(e.consoleUrl) ? [button('เปิดดูในระบบ', e.consoleUrl)] : [{ type: 'text', text: 'ระบบรับเรื่องร้องเรียน QTEC', size: 'xs', color: MUTED, wrap: true }]
    },
    styles: { footer: { separator: true, separatorColor: TRACK } }
  }
  return { contents, altText: `${tone.icon} ${e.ticketNo} ${to}`.slice(0, 400) }
}

/** การ์ดเกิน SLA */
export function buildComplaintSlaCard(e: ComplaintSlaBreached): { contents: unknown; altText: string } {
  const what = e.slaKind === 'Ack' ? 'ยังไม่มีผู้รับเรื่อง' : 'ยังไม่ได้ดำเนินการให้เสร็จ'
  const body: unknown[] = [
    {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      backgroundColor: CARD,
      cornerRadius: '10px',
      paddingAll: '12px',
      contents: [
        row('เลขที่', e.ticketNo),
        row('หมวด', clean(e.categoryName, 60)),
        row('กำหนด', bangkok(e.dueAt)),
        row('สถานะ', STATUS_TH[e.status] ?? e.status),
        ...(e.assigneeName ? [row('ผู้รับผิดชอบ', clean(e.assigneeName, 60))] : [])
      ]
    }
  ]
  const contents = {
    type: 'bubble',
    size: 'kilo',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#B91C1C',
      paddingAll: '14px',
      contents: [{ type: 'text', text: `⏰ เกินกำหนด SLA — ${what}`, size: 'md', weight: 'bold', color: WHITE, wrap: true }]
    },
    body: { type: 'box', layout: 'vertical', paddingAll: '14px', spacing: 'md', contents: body },
    footer: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '12px',
      contents: isHttps(e.consoleUrl) ? [button('เปิดดูและดำเนินการ', e.consoleUrl, '#B91C1C')] : []
    },
    styles: { footer: { separator: true, separatorColor: TRACK } }
  }
  return { contents, altText: `⏰ เกิน SLA ${e.ticketNo} ${what}`.slice(0, 400) }
}
