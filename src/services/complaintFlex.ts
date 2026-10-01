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
      // ปุ่มรับเรื่องจากในแชท (postback -> Complaint.Api ตรวจว่า LINE userId นี้เป็นเจ้าหน้าที่) + ปุ่มเปิดระบบ
      {
        type: 'box',
        layout: 'horizontal',
        spacing: 'sm',
        contents: [
          { type: 'button', style: 'primary', color: sev.color, height: 'sm', flex: 1, action: { type: 'postback', label: 'รับเรื่อง', data: `complaint=ack&t=${encodeURIComponent(e.ticketNo)}`, displayText: `รับเรื่อง ${e.ticketNo}` } },
          ...(isHttps(e.consoleUrl) ? [{ type: 'button', style: 'secondary', height: 'sm', flex: 1, action: { type: 'uri', label: 'เปิดในระบบ', uri: e.consoleUrl } }] : [])
        ]
      },
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

/** การ์ดถึงผู้ร้องเรียนที่ opt-in — ไม่มีชื่อเจ้าหน้าที่ ไม่มีบันทึกภายใน */
export function buildReporterUpdateCard(e: { ticketNo: string; toStatusTh: string; publicNote?: string | null; trackUrl: string }): { contents: unknown; altText: string } {
  const contents = {
    type: 'bubble',
    size: 'kilo',
    header: { type: 'box', layout: 'vertical', backgroundColor: '#1D4ED8', paddingAll: '14px', contents: [{ type: 'text', text: '📣 ความคืบหน้าเรื่องร้องเรียนของคุณ', size: 'sm', weight: 'bold', color: WHITE, wrap: true }] },
    body: {
      type: 'box', layout: 'vertical', paddingAll: '14px', spacing: 'md',
      contents: [
        { type: 'box', layout: 'vertical', spacing: 'sm', backgroundColor: CARD, cornerRadius: '10px', paddingAll: '12px', contents: [row('เลขที่', e.ticketNo), row('สถานะ', clean(e.toStatusTh, 60))] },
        ...(e.publicNote ? [{ type: 'text', text: clean(e.publicNote, 400), size: 'sm', color: INK, wrap: true }] : [])
      ]
    },
    footer: { type: 'box', layout: 'vertical', paddingAll: '12px', contents: isHttps(e.trackUrl) ? [button('ดูรายละเอียด', e.trackUrl)] : [] },
    styles: { footer: { separator: true, separatorColor: TRACK } }
  }
  return { contents, altText: `📣 ${e.ticketNo}: ${e.toStatusTh}`.slice(0, 400) }
}

/**
 * การ์ดสรุปเรื่องค้าง (งานตั้งเวลา) — ดีไซน์ใหม่
 *   - หัวการ์ดโทนเข้ม + ป้ายสถานะรวม ("เรียบร้อย / ต้องจับตา / ต้องรีบจัดการ") อ่านรู้เรื่องใน 1 วินาที
 *   - ตัวเลขหลัก 3 ช่องเป็น tile สีอ่อน ตัวเลขใหญ่ สีตามความหมาย (ไม่มีขอบ ไม่มีเส้น)
 *   - แถบสัดส่วน "รับเรื่องแล้ว" แบบ filler (ไม่ใช้ box ว่าง ซึ่ง LINE for PC จะยืดจนการ์ดพัง)
 *   - ตามหมวด = ชื่อ + chip ตัวเลขชิดขวา · เกินกำหนด = รายการการ์ดย่อยพื้นแดงอ่อน
 *   - สถานะ "ไม่มีเรื่องค้าง" มีหน้าตาเฉพาะ ไม่ใช่ตารางว่าง
 */
export function buildComplaintDigestCard(d: {
  asOf: string; open: number; newToday: number; resolvedToday: number; unacknowledged: number; overdue: number
  byCategory: { category: string; count: number }[]
  overdueItems: { ticketNo: string; status: string; cat: string; assigneeName: string | null; vehiclePlate: string | null; severity: string; dueAt: string }[]
  consoleUrl: string
}): { contents: unknown; altText: string } {
  const level = d.overdue > 0 ? 'bad' : d.unacknowledged > 0 ? 'warn' : 'good'
  const theme = {
    good: { bg: '#047857', label: 'เรียบร้อย', icon: '✅', soft: '#ECFDF5', fg: '#047857' },
    warn: { bg: '#B45309', label: 'ต้องจับตา', icon: '👀', soft: '#FFFBEB', fg: '#B45309' },
    bad: { bg: '#B91C1C', label: 'ต้องรีบจัดการ', icon: '🚨', soft: '#FEF2F2', fg: '#B91C1C' }
  }[level]
  const acked = Math.max(0, d.open - d.unacknowledged)
  const pct = d.open > 0 ? Math.round((acked / d.open) * 100) : 100

  const tile = (value: number, label: string, fg: string, bg: string) => ({
    type: 'box', layout: 'vertical', flex: 1, backgroundColor: bg, cornerRadius: '12px', paddingAll: '12px', spacing: 'none',
    contents: [
      { type: 'text', text: String(value), size: 'xxl', weight: 'bold', color: fg, align: 'center', wrap: true },
      { type: 'text', text: label, size: 'xxs', color: MUTED, align: 'center', wrap: true, margin: 'xs' }
    ]
  })
  const countChip = (n: number, tone: 'neutral' | 'bad' = 'neutral') => ({
    type: 'box', layout: 'vertical', flex: 0, backgroundColor: tone === 'bad' ? '#FEF2F2' : '#F3F4F6', cornerRadius: '999px', paddingAll: '2px', paddingStart: '10px', paddingEnd: '10px',
    contents: [{ type: 'text', text: String(n), size: 'xs', weight: 'bold', color: tone === 'bad' ? '#B91C1C' : INK, wrap: true }]
  })
  // แถบสัดส่วนด้วย filler สองฝั่ง (ไม่มี box ว่าง): ส่วนเติม = box ที่มี text ว่างความสูง 8px
  const progress = (percent: number) => {
    const fill = Math.max(0, Math.min(100, percent))
    const segment = (bg: string, flex: number) =>
      flex === 0 ? null : { type: 'box', layout: 'vertical', flex, backgroundColor: bg, cornerRadius: '4px', height: '8px', contents: [{ type: 'text', text: ' ', size: 'xxs', color: bg }] }
    return {
      type: 'box', layout: 'horizontal', spacing: 'none', height: '8px', cornerRadius: '4px', backgroundColor: TRACK,
      contents: [segment(theme.fg, fill), segment(TRACK, 100 - fill)].filter(Boolean)
    }
  }

  const body: unknown[] = [
    { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [tile(d.open, 'เรื่องที่เปิดอยู่', INK, '#F3F4F6'), tile(d.unacknowledged, 'ยังไม่มีผู้รับ', d.unacknowledged > 0 ? '#B45309' : '#047857', d.unacknowledged > 0 ? '#FFFBEB' : '#ECFDF5'), tile(d.overdue, 'เกินกำหนด SLA', d.overdue > 0 ? '#B91C1C' : '#047857', d.overdue > 0 ? '#FEF2F2' : '#ECFDF5')] },
    {
      type: 'box', layout: 'vertical', spacing: 'xs', margin: 'md',
      contents: [
        { type: 'box', layout: 'horizontal', contents: [{ type: 'text', text: 'รับเรื่องแล้ว', size: 'xs', color: MUTED, flex: 1, wrap: true }, { type: 'text', text: `${acked}/${d.open} · ${pct}%`, size: 'xs', color: INK, weight: 'bold', align: 'end', wrap: true }] },
        progress(pct)
      ]
    },
    { type: 'text', text: `วันนี้ · รับใหม่ ${d.newToday} เรื่อง · ดำเนินการแล้ว ${d.resolvedToday} เรื่อง`, size: 'xs', color: MUTED, wrap: true, margin: 'sm' }
  ]

  if (d.open === 0) {
    body.push({
      type: 'box', layout: 'vertical', backgroundColor: '#ECFDF5', cornerRadius: '12px', paddingAll: '14px', margin: 'md', spacing: 'xs',
      contents: [
        { type: 'text', text: '🎉 ไม่มีเรื่องค้างเลย', size: 'sm', weight: 'bold', color: '#047857', align: 'center', wrap: true },
        { type: 'text', text: 'ขอบคุณทุกคนที่ดูแลเรื่องร้องเรียนอย่างรวดเร็ว', size: 'xs', color: '#047857', align: 'center', wrap: true }
      ]
    })
  }

  if (d.byCategory.length) {
    body.push({ type: 'text', text: 'ตามหมวด', size: 'xs', weight: 'bold', color: INK, margin: 'lg', wrap: true })
    body.push({
      type: 'box', layout: 'vertical', spacing: 'sm', margin: 'sm',
      contents: d.byCategory.slice(0, 6).map((c) => ({
        type: 'box', layout: 'horizontal', spacing: 'md',
        contents: [{ type: 'text', text: clean(c.category, 40), size: 'sm', color: INK, flex: 1, wrap: true, gravity: 'center' }, countChip(c.count)]
      }))
    })
  }

  if (d.overdueItems.length) {
    body.push({ type: 'text', text: `⏰ เกินกำหนด (${d.overdueItems.length})`, size: 'xs', weight: 'bold', color: '#B91C1C', margin: 'lg', wrap: true })
    body.push({
      type: 'box', layout: 'vertical', spacing: 'sm', margin: 'sm',
      contents: d.overdueItems.slice(0, 5).map((it) => ({
        type: 'box', layout: 'vertical', backgroundColor: '#FEF2F2', cornerRadius: '10px', paddingAll: '10px', spacing: 'xs',
        action: isHttps(d.consoleUrl) ? { type: 'uri', label: it.ticketNo, uri: `${d.consoleUrl}/complaints?search=${encodeURIComponent(it.ticketNo)}&all=true` } : undefined,
        contents: [
          { type: 'box', layout: 'horizontal', contents: [{ type: 'text', text: it.ticketNo, size: 'sm', weight: 'bold', color: '#B91C1C', flex: 1, wrap: true }, { type: 'text', text: clean(it.status, 20), size: 'xxs', color: '#B91C1C', align: 'end', wrap: true, gravity: 'center' }] },
          { type: 'text', text: `${clean(it.cat, 30)}${it.vehiclePlate ? ` · ${it.vehiclePlate}` : ''}`, size: 'xs', color: INK, wrap: true },
          { type: 'text', text: it.assigneeName ? `ผู้รับผิดชอบ ${clean(it.assigneeName, 30)} · ครบกำหนด ${bangkok(it.dueAt)}` : `ยังไม่มีผู้รับ · ครบกำหนด ${bangkok(it.dueAt)}`, size: 'xxs', color: MUTED, wrap: true }
        ]
      }))
    })
    if (d.overdueItems.length > 5) body.push({ type: 'text', text: `และอีก ${d.overdueItems.length - 5} เรื่อง — ดูทั้งหมดในกล่องงาน`, size: 'xxs', color: MUTED, wrap: true, margin: 'sm' })
  }

  const contents = {
    type: 'bubble', size: 'mega',
    header: {
      type: 'box', layout: 'vertical', backgroundColor: theme.bg, paddingAll: '16px', spacing: 'xs',
      contents: [
        {
          type: 'box', layout: 'horizontal',
          contents: [
            { type: 'text', text: 'สรุปเรื่องร้องเรียนค้าง', size: 'xs', color: ON_COLOR_SOFT, flex: 1, wrap: true, gravity: 'center' },
            { type: 'box', layout: 'vertical', flex: 0, backgroundColor: WHITE, cornerRadius: '999px', paddingAll: '3px', paddingStart: '10px', paddingEnd: '10px', contents: [{ type: 'text', text: `${theme.icon} ${theme.label}`, size: 'xxs', weight: 'bold', color: theme.fg, wrap: true }] }
          ]
        },
        { type: 'text', text: d.open === 0 ? 'ทุกเรื่องได้รับการดูแลแล้ว' : d.overdue > 0 ? `มี ${d.overdue} เรื่องเกินกำหนด SLA` : `มี ${d.unacknowledged} เรื่องรอผู้รับผิดชอบ`, size: 'lg', weight: 'bold', color: WHITE, wrap: true },
        { type: 'text', text: `ข้อมูล ณ ${bangkok(d.asOf)} น.`, size: 'xxs', color: ON_COLOR_SOFT, wrap: true }
      ]
    },
    body: { type: 'box', layout: 'vertical', paddingAll: '16px', spacing: 'none', contents: body },
    footer: {
      type: 'box', layout: 'vertical', paddingAll: '12px', spacing: 'sm',
      contents: [
        ...(isHttps(d.consoleUrl)
          ? [
              {
                type: 'box', layout: 'horizontal', spacing: 'sm',
                contents: [
                  { type: 'button', style: 'primary', color: theme.bg, height: 'sm', flex: 1, action: { type: 'uri', label: d.unacknowledged > 0 ? 'เรื่องที่รอรับ' : 'เปิดกล่องงาน', uri: d.unacknowledged > 0 ? `${d.consoleUrl}/complaints?status=Submitted` : `${d.consoleUrl}/complaints` } },
                  ...(d.overdue > 0 ? [{ type: 'button', style: 'secondary', height: 'sm', flex: 1, action: { type: 'uri', label: 'เกิน SLA', uri: `${d.consoleUrl}/complaints?overdue=true` } }] : [])
                ]
              }
            ]
          : []),
        { type: 'text', text: 'ส่งอัตโนมัติจากระบบรับเรื่องร้องเรียน QTEC', size: 'xxs', color: MUTED, align: 'center', wrap: true }
      ]
    },
    styles: { footer: { separator: true, separatorColor: TRACK } }
  }
  return { contents, altText: `${theme.icon} เรื่องร้องเรียนค้าง ${d.open} · ยังไม่มีผู้รับ ${d.unacknowledged} · เกิน SLA ${d.overdue}`.slice(0, 400) }
}
