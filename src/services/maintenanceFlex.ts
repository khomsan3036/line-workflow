import { config } from '../config'

// ---------------------------------------------------------------------------
// Flex Message ของแชทบอททีมซ่อมบำรุง
//
// แนวคิดดีไซน์
//   - โมเดลไม่ได้เขียน Flex เอง แต่ตอบเป็น "การ์ด" โครงสร้างง่าย ๆ (title/สรุป/ตัวเลข/รายการ)
//     แล้วไฟล์นี้แปลงเป็น bubble ให้หน้าตาเหมือนกันทุกครั้ง ปลอดภัยจาก JSON ที่ LINE ไม่รับ
//   - หัวการ์ดเปลี่ยนสีตามสถานะ (เขียว = เรียบร้อย, เหลือง = ต้องจับตา, แดง = ด่วน, น้ำเงิน = ข้อมูลทั่วไป)
//   - ตัวเลขสำคัญเป็นกล่องใหญ่อ่านได้ทันที รายการที่ต้องทำเป็น bullet พร้อมป้ายสี
//   - ปุ่ม quick reply ใต้ช่องพิมพ์ = คำถามถัดไปที่เกี่ยวข้อง ไม่ต้องพิมพ์เอง
// ทดลองแก้ดีไซน์ได้ที่ https://developers.line.biz/flex-simulator/
//
// ข้อจำกัดของ LINE for PC (renderer คนละตัวกับมือถือ) ที่เคยทำให้การ์ดสูงผิดปกติและตัวหนังสือหาย
//   - ห้ามใช้สีแบบมี alpha (#RRGGBBAA) -> ใช้สีทึบเท่านั้น
//   - ห้ามใช้ box ที่ contents ว่าง (เคยใช้เป็นแถบสี) -> PC ขยายเต็มความสูง
//   - เลี่ยง offsetStart/offsetTop และ alignItems -> ใช้ padding ของ box แทน
//   - ข้อความทุกชิ้นใส่ wrap: true และไม่ใช้ flex: 0 กับ text ที่ต้องตัดบรรทัด
//
// กติกาเรื่องอ่านง่ายบนมือถือ (กติกาเดียวกับการ์ดเวลาเข้างานของ OA HR)
//   - หัวการ์ดใช้สีโทนเข้ม (700) ให้ตัวหนังสือขาวอ่านชัด ไม่ใช้เขียว/เหลืองสดเป็นพื้นตัวหนังสือ
//   - ป้ายสถานะ/badge ใช้พื้นอ่อน + ตัวอักษรเข้มโทนเดียวกัน (contrast > 4.5:1)
//   - ตัวอักษรเล็กสุดคือ xs และสีจางสุดคือ MUTED (#6B7280)
// ---------------------------------------------------------------------------

const NAVY = '#0C1628'
const GREEN = '#06C755'
const INK = '#111827'
const MUTED = '#6B7280'
const TRACK = '#E5E7EB'
const CARD = '#F8FAFC'
const WHITE = '#FFFFFF'
// สีตัวหนังสือรองบนพื้นหัวการ์ดสี (แทน white+alpha ที่ PC ไม่รองรับ)
const ON_COLOR_SOFT = '#F1F5F9'

// สีพื้นหัวการ์ดตามสถานะ (โทนเข้ม ตัวหนังสือขาวอ่านชัด) และสีตัวอักษรบนพื้นขาว/พื้นอ่อน
const GREEN_DEEP = '#047857'
const BLUE_DEEP = '#1D4ED8'
const AMBER_DEEP = '#B45309'
const RED_DEEP = '#B91C1C'
// พื้นอ่อนสำหรับป้าย/badge
const GREEN_SOFT = '#ECFDF5'
const BLUE_SOFT = '#EFF6FF'
const AMBER_SOFT = '#FFFBEB'
const RED_SOFT = '#FEF2F2'
const GRAY_SOFT = '#F3F4F6'

export type CardStatus = 'ok' | 'info' | 'warning' | 'critical'
export type Tone = 'neutral' | 'good' | 'warn' | 'bad'

export interface CardMetric {
  label: string
  value: string
  unit?: string
  tone?: Tone
}

export interface CardItem {
  text: string
  detail?: string
  badge?: string
  tone?: Tone
}

export interface CardSection {
  heading: string
  items: CardItem[]
}

/** การ์ดที่โมเดลตอบกลับมา (หลังผ่าน normalizeCard แล้วทุกช่องปลอดภัยสำหรับ LINE) */
export interface MaintenanceCard {
  title: string
  subtitle?: string
  status: CardStatus
  summary?: string
  metrics: CardMetric[]
  sections: CardSection[]
  note?: string
  suggestions: string[]
}

export type AgentReply = { kind: 'text'; text: string; suggestions: string[] } | { kind: 'card'; card: MaintenanceCard }

const STATUS_META: Record<CardStatus, { color: string; label: string }> = {
  ok: { color: GREEN_DEEP, label: 'เรียบร้อย' },
  info: { color: BLUE_DEEP, label: 'ข้อมูล' },
  warning: { color: AMBER_DEEP, label: 'ควรจับตา' },
  critical: { color: RED_DEEP, label: 'ต้องดำเนินการ' }
}

/** สีตัวอักษรของตัวเลข/ป้ายตามโทน (เข้มพอสำหรับพื้นขาวและพื้นอ่อน) */
const TONE_COLOR: Record<Tone, string> = { neutral: INK, good: GREEN_DEEP, warn: AMBER_DEEP, bad: RED_DEEP }
/** พื้นอ่อนของ badge ตามโทน */
const TONE_SOFT: Record<Tone, string> = { neutral: GRAY_SOFT, good: GREEN_SOFT, warn: AMBER_SOFT, bad: RED_SOFT }

/** ปุ่มลัดเริ่มต้นเมื่อโมเดลไม่ได้แนะนำคำถามถัดไป */
export const DEFAULT_SUGGESTIONS = [
  'สรุปภาพรวมวันนี้',
  'งานซ่อมค้าง',
  'เรื่องด่วนตอนนี้',
  'รายการที่ต้องจับตา',
  'สรุปซ่อมสัปดาห์นี้',
  'สรุปน้ำมันเดือนนี้',
  'สรุปรถวันนี้'
]

// ---------------------------------------------------------------------------
// ทำความสะอาดข้อมูลจากโมเดล: LINE ไม่รับ text ว่าง และมีเพดานความยาว/จำนวน
// ---------------------------------------------------------------------------

function clean(value: unknown, max: number, fallback = ''): string {
  const text = typeof value === 'string' || typeof value === 'number' ? String(value).replace(/\s+/g, ' ').trim() : ''
  if (!text) return fallback
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function cleanStatus(value: unknown): CardStatus {
  return value === 'ok' || value === 'info' || value === 'warning' || value === 'critical' ? value : 'info'
}

function cleanTone(value: unknown): Tone {
  return value === 'good' || value === 'warn' || value === 'bad' ? value : 'neutral'
}

function cleanSuggestions(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const v of value) {
    const text = clean(v, 20)
    if (!text || seen.has(text)) continue
    seen.add(text)
    out.push(text)
    if (out.length >= 6) break
  }
  return out
}

/** แปลง object ดิบจากโมเดลให้เป็น MaintenanceCard ที่ทุกช่องปลอดภัย */
export function normalizeCard(raw: Record<string, unknown>): MaintenanceCard {
  const metrics: CardMetric[] = []
  if (Array.isArray(raw.metrics)) {
    for (const m of raw.metrics as Array<Record<string, unknown>>) {
      if (!m || typeof m !== 'object') continue
      const value = clean(m.value, 12)
      const label = clean(m.label, 24)
      if (!value || !label) continue
      metrics.push({ label, value, unit: clean(m.unit, 10) || undefined, tone: cleanTone(m.tone) })
      if (metrics.length >= 6) break
    }
  }

  const sections: CardSection[] = []
  if (Array.isArray(raw.sections)) {
    for (const s of raw.sections as Array<Record<string, unknown>>) {
      if (!s || typeof s !== 'object' || !Array.isArray(s.items)) continue
      const items: CardItem[] = []
      for (const it of s.items as Array<Record<string, unknown> | string>) {
        const obj = typeof it === 'string' ? { text: it } : it
        if (!obj || typeof obj !== 'object') continue
        const text = clean(obj.text, 160)
        if (!text) continue
        items.push({
          text,
          detail: clean(obj.detail, 120) || undefined,
          badge: clean(obj.badge, 12) || undefined,
          tone: cleanTone(obj.tone)
        })
        if (items.length >= 6) break
      }
      if (items.length === 0) continue
      sections.push({ heading: clean(s.heading, 40, 'รายละเอียด'), items })
      if (sections.length >= 4) break
    }
  }

  return {
    title: clean(raw.title, 60, 'สรุปจากระบบซ่อมบำรุง'),
    subtitle: clean(raw.subtitle, 60) || undefined,
    status: cleanStatus(raw.status),
    summary: clean(raw.summary, 400) || undefined,
    metrics,
    sections,
    note: clean(raw.note, 300) || undefined,
    suggestions: cleanSuggestions(raw.suggestions)
  }
}

/** ข้อความล้วนของการ์ด ใช้เป็น altText, เก็บลง direct_messages และเป็นประวัติให้โมเดลอ่านรอบหน้า */
export function cardToText(card: MaintenanceCard): string {
  const lines: string[] = [card.title + (card.subtitle ? ` (${card.subtitle})` : '')]
  if (card.summary) lines.push(card.summary)
  if (card.metrics.length > 0) {
    lines.push(card.metrics.map((m) => `${m.label} ${m.value}${m.unit ? ` ${m.unit}` : ''}`).join(' | '))
  }
  for (const s of card.sections) {
    lines.push(`${s.heading}:`)
    for (const it of s.items) {
      lines.push(`- ${it.badge ? `[${it.badge}] ` : ''}${it.text}${it.detail ? ` (${it.detail})` : ''}`)
    }
  }
  if (card.note) lines.push(card.note)
  return lines.join('\n')
}

/** quick reply จากคำถามแนะนำของโมเดล (ถ้าไม่มีใช้ชุดเริ่มต้น) */
export function buildQuickReply(suggestions: string[]): unknown {
  const labels = suggestions.length > 0 ? suggestions : DEFAULT_SUGGESTIONS
  return {
    items: labels.map((label) => ({ type: 'action', action: { type: 'message', label, text: label } }))
  }
}

// ---------------------------------------------------------------------------
// ชิ้นส่วนของการ์ด
// ---------------------------------------------------------------------------

/**
 * ป้ายเล็กมุมโค้ง (พื้นสีทึบ ตัวหนังสือสีทึบ) - เลือกคู่สีให้ contrast พอ เช่น พื้นขาว+ตัวสีเข้ม หรือพื้นอ่อน+ตัวเข้ม
 * ห่อด้วย box แนวตั้ง + filler เพื่อให้ป้ายเกาะขอบบน ไม่ยืดสูงตามข้อความหลายบรรทัดข้าง ๆ
 */
function chip(text: string, backgroundColor: string, textColor: string = WHITE) {
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
        contents: [{ type: 'text', text, size: 'xs', color: textColor, weight: 'bold', align: 'center', wrap: true }]
      },
      { type: 'filler' }
    ]
  }
}

function metricBox(m: CardMetric) {
  return {
    type: 'box',
    layout: 'vertical',
    backgroundColor: CARD,
    cornerRadius: '10px',
    paddingAll: '10px',
    spacing: 'xs',
    contents: [
      // ตัวเลขยาว (เช่น 12,500) ลดขนาดลงเพื่อไม่ให้ตัดบรรทัดในช่องแคบ
      {
        type: 'text',
        text: m.value,
        size: m.value.length > 7 ? 'md' : m.value.length > 4 ? 'lg' : 'xl',
        weight: 'bold',
        color: TONE_COLOR[m.tone ?? 'neutral'],
        wrap: true
      },
      { type: 'text', text: m.unit ? `${m.label} (${m.unit})` : m.label, size: 'xs', color: MUTED, wrap: true }
    ]
  }
}

/** จัดกล่องตัวเลขเป็นแถว แถวละ 2-3 กล่อง (4 กล่อง = 2+2, 5 กล่อง = 3+2) */
function metricRows(metrics: CardMetric[]) {
  const rows: CardMetric[][] = []
  const perRow = metrics.length === 4 || metrics.length === 2 ? 2 : 3
  for (let i = 0; i < metrics.length; i += perRow) rows.push(metrics.slice(i, i + perRow))
  return rows.map((row) => ({ type: 'box', layout: 'horizontal', spacing: 'sm', contents: row.map(metricBox) }))
}

function sectionBlock(section: CardSection) {
  return {
    type: 'box',
    layout: 'vertical',
    spacing: 'sm',
    contents: [
      { type: 'separator', color: TRACK },
      { type: 'text', text: section.heading, size: 'sm', weight: 'bold', color: NAVY, wrap: true },
      ...section.items.map((it) => ({
        type: 'box',
        layout: 'vertical',
        spacing: 'xs',
        paddingStart: '8px',
        contents: [
          {
            type: 'box',
            layout: 'horizontal',
            spacing: 'sm',
            contents: [
              { type: 'text', text: `• ${it.text}`, size: 'sm', color: INK, wrap: true, flex: 1 },
              ...(it.badge ? [chip(it.badge, TONE_SOFT[it.tone ?? 'neutral'], TONE_COLOR[it.tone ?? 'neutral'])] : [])
            ]
          },
          ...(it.detail
            ? [
                {
                  type: 'box',
                  layout: 'vertical',
                  paddingStart: '12px',
                  contents: [{ type: 'text', text: it.detail, size: 'xs', color: MUTED, wrap: true }]
                }
              ]
            : [])
        ]
      }))
    ]
  }
}

function nowLabel(): string {
  return new Date().toLocaleTimeString('th-TH', { timeZone: config.timezone, hour: '2-digit', minute: '2-digit' })
}

// ---------------------------------------------------------------------------
// การ์ดคำตอบ
// ---------------------------------------------------------------------------

export function buildMaintenanceCard(card: MaintenanceCard): unknown {
  const meta = STATUS_META[card.status]
  const body: unknown[] = []

  if (card.summary) body.push({ type: 'text', text: card.summary, size: 'sm', color: INK, wrap: true })
  if (card.metrics.length > 0) body.push({ type: 'box', layout: 'vertical', spacing: 'sm', contents: metricRows(card.metrics) })
  for (const section of card.sections) body.push(sectionBlock(section))
  if (card.note) {
    body.push({ type: 'separator', color: TRACK })
    body.push({ type: 'text', text: card.note, size: 'xs', color: MUTED, wrap: true })
  }
  if (body.length === 0) body.push({ type: 'text', text: 'ไม่มีรายละเอียดเพิ่มเติม', size: 'sm', color: MUTED })

  return {
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: meta.color,
      paddingAll: '16px',
      spacing: 'xs',
      contents: [
        {
          type: 'box',
          layout: 'horizontal',
          contents: [
            { type: 'text', text: 'ผู้ช่วยทีมซ่อมบำรุง', size: 'xs', color: ON_COLOR_SOFT, flex: 1, wrap: true },
            chip(meta.label, WHITE, meta.color)
          ]
        },
        { type: 'text', text: card.title, size: 'lg', weight: 'bold', color: WHITE, wrap: true },
        ...(card.subtitle ? [{ type: 'text', text: card.subtitle, size: 'xs', color: ON_COLOR_SOFT, wrap: true }] : [])
      ]
    },
    body: { type: 'box', layout: 'vertical', paddingAll: '16px', spacing: 'lg', contents: body },
    footer: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '12px',
      paddingTop: '0px',
      contents: [
        {
          type: 'text',
          text: `อัปเดต ${nowLabel()} น. · ข้อมูลจากระบบซ่อมบำรุง · พิมพ์ถามต่อได้เลย`,
          size: 'xs',
          color: MUTED,
          wrap: true
        }
      ]
    },
    styles: { footer: { separator: true, separatorColor: TRACK } }
  }
}

// ---------------------------------------------------------------------------
// การ์ดแจ้งเตือนเข้ากลุ่ม (บอทส่งเมื่อผู้ใช้แจ้งเรื่อง/สั่งให้ประกาศ)
// ---------------------------------------------------------------------------

export type AlertSeverity = 'urgent' | 'warning' | 'info'

/** รายละเอียดแบบ "หัวข้อ: ค่า" แสดงเป็นตารางสองคอลัมน์ (อ่านไล่ได้เร็วกว่า bullet) */
export interface AlertDetail {
  label: string
  value: string
}

/** ปุ่มท้ายการ์ด (เปิดลิงก์ในเบราว์เซอร์) เช่น "เปิดหน้าอนุมัติ" */
export interface AlertAction {
  label: string
  uri: string
}

export interface GroupAlert {
  title: string
  message: string
  severity: AlertSeverity
  /** ข้อความอิสระเป็น bullet (ใช้เมื่อไม่ใช่คู่หัวข้อ/ค่า) */
  items: string[]
  /** คู่หัวข้อ/ค่า เช่น ผู้ขอ, รถ, ปลายทาง */
  details: AlertDetail[]
  actions: AlertAction[]
  reference?: string
  /** ชื่อผู้แจ้ง (แสดงท้ายการ์ด) */
  requestedBy: string
  /**
   * การ์ด Flex ที่สร้างไว้เองสำหรับ event ชนิดนั้นโดยเฉพาะ (ถ้ามี buildAlertCard จะใช้อันนี้แทน)
   * ใช้เมื่อการ์ดกลางสื่อไม่ตรง เช่น เอกสารหมดอายุที่ต้องเน้นตัวเลข "เหลือกี่วัน" เป็นพระเอก
   * — ยังต้องใส่ title/message/items ไว้ด้วย เพราะเป็น altText และข้อความสำรอง
   */
  custom?: unknown
  /** ข้อความสำรองที่เขียนเองคู่กับ custom (ว่าง = ใช้ alertToText ปกติ) */
  customText?: string
  /**
   * รูปประกอบ (https) เช่น รูปก่อนซ่อมที่ผู้แจ้งถ่ายไว้ — รูปแรกเป็น hero ของการ์ด ที่เหลือเป็น thumbnail
   * แต่ละรูปแตะแล้วเปิดดูเต็มจอ (ซูมได้) ผ่าน openUri ถ้ามี ไม่มีก็เปิด url รูปนั้นเอง
   * ข้อจำกัดของ LINE: รูปใน Flex ต้อง ≤ 1024×1024 px และ ≤ 1 MB — ใช้ URL ที่ย่อแล้วเสมอ
   */
  images: AlertImage[]
}

export interface AlertImage {
  /** URL รูปที่ย่อแล้ว (แสดงในการ์ด) */
  url: string
  /** URL ที่เปิดเมื่อแตะ (รูปเต็ม) ว่าง = url เดิม */
  openUri?: string
  /** คำอธิบายสั้น ๆ เช่น ชื่อไฟล์ (ใช้ใน altText) */
  label?: string
}

/** จำนวนรูปสูงสุดบนการ์ด (hero 1 + thumbnail) */
export const MAX_ALERT_IMAGES = 4

/** https เท่านั้น และยาวไม่เกินที่ LINE รับ */
function cleanUri(value: unknown, max = 1000): string {
  const uri = typeof value === 'string' ? value.trim() : ''
  return /^https:\/\/\S+$/.test(uri) && uri.length <= max ? uri : ''
}

export function cleanImages(value: unknown): AlertImage[] {
  if (!Array.isArray(value)) return []
  const out: AlertImage[] = []
  const seen = new Set<string>()
  for (const v of value) {
    const raw = typeof v === 'string' ? { url: v } : v && typeof v === 'object' ? (v as Record<string, unknown>) : null
    if (!raw) continue
    const url = cleanUri(raw.url, 2000)
    if (!url || seen.has(url)) continue
    seen.add(url)
    const openUri = cleanUri(raw.openUri)
    out.push({ url, openUri: openUri || undefined, label: clean(raw.label, 60) || undefined })
    if (out.length >= MAX_ALERT_IMAGES) break
  }
  return out
}

const SEVERITY_META: Record<AlertSeverity, { color: string; label: string; icon: string }> = {
  urgent: { color: RED_DEEP, label: 'ด่วน', icon: '🚨' },
  warning: { color: AMBER_DEEP, label: 'แจ้งเตือน', icon: '⚠️' },
  info: { color: BLUE_DEEP, label: 'แจ้งทราบ', icon: '📢' }
}

export function normalizeAlert(raw: Record<string, unknown>, requestedBy: string): GroupAlert {
  const severity = raw.severity === 'urgent' || raw.severity === 'warning' || raw.severity === 'info' ? raw.severity : 'info'
  const items = Array.isArray(raw.items) ? raw.items.map((i) => clean(i, 160)).filter(Boolean).slice(0, 6) : []

  const details: AlertDetail[] = []
  if (Array.isArray(raw.details)) {
    for (const d of raw.details as Array<Record<string, unknown>>) {
      if (!d || typeof d !== 'object') continue
      const label = clean(d.label, 24)
      const value = clean(d.value, 200)
      if (label && value) details.push({ label, value })
      if (details.length >= 12) break
    }
  }

  const actions: AlertAction[] = []
  if (Array.isArray(raw.actions)) {
    for (const a of raw.actions as Array<Record<string, unknown>>) {
      if (!a || typeof a !== 'object') continue
      const label = clean(a.label, 20)
      const uri = typeof a.uri === 'string' ? a.uri.trim() : ''
      // LINE เปิดได้เฉพาะ https (และ uri ยาวได้ไม่เกิน 1000 ตัวอักษร)
      if (label && /^https:\/\/\S+$/.test(uri) && uri.length <= 1000) actions.push({ label, uri })
      if (actions.length >= 2) break
    }
  }

  return {
    title: clean(raw.title, 60, 'แจ้งเตือนจากทีมซ่อมบำรุง'),
    message: clean(raw.message, 600, '-'),
    severity,
    items,
    details,
    actions,
    reference: clean(raw.reference, 60) || undefined,
    requestedBy: clean(requestedBy, 60, 'ไม่ทราบชื่อ'),
    images: cleanImages(raw.images)
  }
}

export function alertToText(alert: GroupAlert): string {
  if (alert.customText) return alert.customText
  const meta = SEVERITY_META[alert.severity]
  const lines = [
    `${meta.icon} [${meta.label}] ${alert.title}`,
    alert.message,
    ...alert.details.map((d) => `${d.label}: ${d.value}`),
    ...alert.items.map((i) => `- ${i}`)
  ]
  if (alert.images.length > 0) lines.push(`📷 รูปประกอบ ${alert.images.length} รูป (แตะการ์ดเพื่อดู)`)
  if (alert.reference) lines.push(`อ้างอิง: ${alert.reference}`)
  lines.push(`แจ้งโดย ${alert.requestedBy}`)
  return lines.join('\n')
}

/** แถว "หัวข้อ | ค่า" ในตารางรายละเอียด (ค่าตัวหนา ตัดบรรทัดได้ทั้งสองฝั่ง) */
function detailRow(d: AlertDetail) {
  return {
    type: 'box',
    layout: 'horizontal',
    spacing: 'md',
    contents: [
      { type: 'text', text: d.label, size: 'xs', color: MUTED, flex: 3, wrap: true },
      { type: 'text', text: d.value, size: 'sm', color: INK, weight: 'bold', flex: 7, wrap: true }
    ]
  }
}

/** แตะรูปแล้วเปิดดูเต็มจอใน LINE (in-app browser ซูมได้) */
function imageAction(img: AlertImage, label: string) {
  return { type: 'uri', label, uri: img.openUri ?? img.url }
}

/** รูปแรกเต็มความกว้างการ์ด (hero) */
function heroImage(img: AlertImage) {
  return {
    type: 'image',
    url: img.url,
    size: 'full',
    aspectRatio: '20:13',
    aspectMode: 'cover',
    action: imageAction(img, 'ดูรูป')
  }
}

/** แถว thumbnail ของรูปที่เหลือ (สูงสุด 3) แตะแต่ละรูปเปิดดูได้ */
function thumbnailRow(images: AlertImage[]) {
  return {
    type: 'box',
    layout: 'horizontal',
    spacing: 'sm',
    contents: images.map((img) => ({
      type: 'image',
      url: img.url,
      size: 'full',
      aspectRatio: '4:3',
      aspectMode: 'cover',
      flex: 1,
      action: imageAction(img, 'ดูรูป')
    }))
  }
}

export function buildAlertCard(alert: GroupAlert): unknown {
  // การ์ดเฉพาะทางของ event ชนิดนั้น (เช่น เอกสารหมดอายุ) ชนะการ์ดกลาง
  if (alert.custom) return alert.custom
  const meta = SEVERITY_META[alert.severity]
  const [hero, ...thumbs] = alert.images
  const body: unknown[] = [{ type: 'text', text: alert.message, size: 'sm', color: INK, wrap: true }]
  if (thumbs.length > 0) body.push(thumbnailRow(thumbs))
  if (alert.images.length > 0) {
    body.push({
      type: 'text',
      text: `📷 รูปประกอบ ${alert.images.length} รูป · แตะรูปเพื่อดูเต็มจอ`,
      size: 'xs',
      color: MUTED,
      wrap: true
    })
  }
  if (alert.details.length > 0) {
    body.push({
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      backgroundColor: CARD,
      cornerRadius: '10px',
      paddingAll: '12px',
      contents: alert.details.map(detailRow)
    })
  }
  if (alert.items.length > 0) {
    body.push({
      type: 'box',
      layout: 'vertical',
      spacing: 'xs',
      backgroundColor: CARD,
      cornerRadius: '10px',
      paddingAll: '12px',
      contents: alert.items.map((it) => ({ type: 'text', text: `• ${it}`, size: 'sm', color: INK, wrap: true }))
    })
  }
  if (alert.reference) {
    body.push({
      type: 'box',
      layout: 'baseline',
      spacing: 'sm',
      contents: [
        { type: 'text', text: 'อ้างอิง', size: 'xs', color: MUTED, flex: 2 },
        { type: 'text', text: alert.reference, size: 'xs', color: INK, weight: 'bold', wrap: true, flex: 8 }
      ]
    })
  }

  return {
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: meta.color,
      paddingAll: '16px',
      spacing: 'xs',
      contents: [
        {
          type: 'box',
          layout: 'horizontal',
          contents: [
            { type: 'text', text: `${meta.icon} ทีมซ่อมบำรุง`, size: 'xs', color: ON_COLOR_SOFT, flex: 1, wrap: true },
            chip(meta.label, WHITE, meta.color)
          ]
        },
        { type: 'text', text: alert.title, size: 'lg', weight: 'bold', color: WHITE, wrap: true }
      ]
    },
    ...(hero ? { hero: heroImage(hero) } : {}),
    body: { type: 'box', layout: 'vertical', paddingAll: '16px', spacing: 'md', contents: body },
    footer: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '12px',
      spacing: 'sm',
      contents: [
        ...alert.actions.map((a) => ({
          type: 'button',
          style: 'primary',
          color: NAVY,
          height: 'sm',
          action: { type: 'uri', label: a.label, uri: a.uri }
        })),
        {
          type: 'text',
          text: `แจ้งโดย ${alert.requestedBy} · ${nowLabel()} น. · พิมพ์ @ ผู้ช่วย เพื่อถามรายละเอียดเพิ่ม`,
          size: 'xs',
          color: MUTED,
          wrap: true
        }
      ]
    },
    styles: { footer: { separator: true, separatorColor: TRACK } }
  }
}

// ---------------------------------------------------------------------------
// การ์ดต้อนรับ (follow / เข้ากลุ่ม)
// ---------------------------------------------------------------------------

const WELCOME_BUTTONS: Array<{ label: string; text: string; primary?: boolean }> = [
  { label: 'สรุปภาพรวมวันนี้', text: 'สรุปภาพรวมวันนี้', primary: true },
  { label: 'งานซ่อมค้าง', text: 'งานซ่อมค้างมีอะไรบ้าง' },
  { label: 'เรื่องด่วนตอนนี้', text: 'มีเรื่องด่วนไหม' },
  { label: 'สรุปน้ำมันเดือนนี้', text: 'สรุปน้ำมันเดือนนี้' }
]

export function buildWelcomeCard(inGroup = false, botName?: string): unknown {
  const tips = inGroup
    ? [
        'ในกลุ่มนี้ให้พิมพ์ @ผู้ช่วย แล้วตามด้วยคำถาม เช่น "@ผู้ช่วย สรุปงานซ่อมวันนี้"',
        botName ? `หรือเลือกชื่อผม (${botName}) จากรายการ @ ก็ได้` : 'หรือเลือกชื่อผมจากรายการ @ ก็ได้'
      ]
    : ['พิมพ์ถามได้เลย หรือกดปุ่มด้านล่าง', 'ถามต่อเนื่องได้ ผมจำเรื่องที่คุยล่าสุดไว้ให้']

  return {
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: NAVY,
      paddingAll: '20px',
      spacing: 'sm',
      contents: [
        { type: 'text', text: 'QTEC MAINTENANCE', size: 'xs', color: ON_COLOR_SOFT, weight: 'bold', wrap: true },
        { type: 'text', text: 'สวัสดีครับ 👋', size: 'xl', weight: 'bold', color: WHITE },
        {
          type: 'text',
          text: 'ผมคือผู้ช่วยทีมซ่อมบำรุง ถามเรื่องงานซ่อม น้ำมัน และรถได้ทันที',
          size: 'sm',
          color: ON_COLOR_SOFT,
          wrap: true
        }
      ]
    },
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '16px',
      spacing: 'md',
      contents: [
        {
          type: 'box',
          layout: 'vertical',
          spacing: 'xs',
          contents: tips.map((t) => ({ type: 'text', text: t, size: 'sm', color: INK, wrap: true }))
        },
        { type: 'separator', color: TRACK },
        { type: 'text', text: 'ตัวอย่างที่ถามได้', size: 'sm', weight: 'bold', color: NAVY, wrap: true },
        {
          type: 'box',
          layout: 'vertical',
          spacing: 'sm',
          contents: WELCOME_BUTTONS.map((b) => ({
            type: 'button',
            style: b.primary ? 'primary' : 'secondary',
            color: b.primary ? GREEN : CARD,
            height: 'sm',
            action: { type: 'message', label: b.label, text: b.text }
          }))
        }
      ]
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '12px',
      paddingTop: '0px',
      contents: [
        {
          type: 'text',
          text: 'ระบบบันทึกบทสนทนาไว้เพื่อตอบต่อเนื่องและตรวจสอบย้อนหลัง',
          size: 'xs',
          color: MUTED,
          wrap: true
        }
      ]
    }
  }
}
