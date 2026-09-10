// ---------------------------------------------------------------------------
// แยกหัวข้อข้อความเมื่อใช้ OA ตัวเดียว (บอทตัวเดียวในกลุ่ม) ตอบได้หลายเรื่อง: HR, ซ่อมบำรุง (MT) และเรื่องอื่นในอนาคต
//   - เพิ่มหัวข้อใหม่ = เพิ่ม 1 รายการใน TOPICS (คำหลัก, ชื่อเรียกหลัง @, ตัวอย่างคำถาม) แล้วเพิ่มทางไปตอบใน routes/webhook.ts
//   - ลำดับการตัดสิน (resolveTopic): ชื่อที่ผู้ใช้เรียกหลัง @ (@HR / @MT) > คำนำหน้าต้นข้อความ ("HR: ..." "MT ...") > นับคำหลัก
//   - ไม่ชัด = 'unknown' -> ผู้เรียกไม่เดา แต่ส่งข้อความแนะนำ + quick reply ให้เลือก (buildTopicHelp / topicQuickReply)
// คำไทยเทียบแบบมีอยู่ในข้อความ (ไม่มีช่องว่างคั่นคำ) คำอังกฤษจับทั้งคำ; นับจำนวนคำที่เจอ ฝั่งไหนมากกว่าชนะ เสมอกันให้ HR
// ---------------------------------------------------------------------------

export type TopicKey = 'hr' | 'maintenance'
export type ChatTopic = TopicKey | 'unknown'

/** ตัวอย่างคำถาม: label ต้องไม่เกิน 20 ตัวอักษร (ข้อจำกัด quick reply ของ LINE) text คือข้อความที่ส่งเข้ามาจริง */
export interface TopicSample {
  label: string
  text: string
}

export interface TopicDef {
  key: TopicKey
  /** ชื่อที่แสดงในข้อความแนะนำ */
  label: string
  /** ชื่อเรียกหลัง @ ในกลุ่ม และคำนำหน้าต้นข้อความ (ตัวพิมพ์เล็ก) */
  aliases: string[]
  words: string[]
  wordsEn: string[]
  /** ตัวอย่างคำถามในแชท 1:1 */
  samples: TopicSample[]
  /** ตัวอย่างคำถามในกลุ่ม (ถ้าไม่ระบุใช้ samples) */
  groupSamples?: TopicSample[]
  /** หมายเหตุท้ายบรรทัดแนะนำในกลุ่ม */
  groupNote?: string
}

const s = (label: string, text: string = label): TopicSample => ({ label, text })

/** ชื่อเรียกบอทแบบไม่ระบุหัวข้อ ("@ผู้ช่วย ...") */
export const GENERIC_BOT_ALIASES = ['ผู้ช่วย', 'บอท']

export const TOPICS: TopicDef[] = [
  {
    key: 'hr',
    label: 'HR',
    aliases: ['hr', 'ฝ่ายบุคคล', 'บุคคล'],
    /** ไม่ใส่คำสั้น ๆ เช่น "ลา" "สาย" เพราะไปตรงกับคำอื่นได้ง่าย */
    words: [
      'ประกาศ', 'เอกสาร', 'หนังสือรับรอง', 'ฝ่ายบุคคล', 'บุคคล',
      'แจ้งลา', 'ลาป่วย', 'ลากิจ', 'ลาพักร้อน', 'ลาคลอด', 'วันลา', 'ใบลา', 'ขอลา', 'ลาหยุด', 'ลาออก',
      'เบอร์', 'ติดต่อ', 'เงินเดือน', 'สลิป', 'โบนัส', 'สวัสดิการ', 'ประกันสังคม', 'ประกันกลุ่ม', 'ภาษี', 'กองทุน',
      'โอที', 'ล่วงเวลา', 'เข้างาน', 'เลิกงาน', 'ลงเวลา', 'สแกนนิ้ว', 'ขาดงาน', 'มาสาย', 'วันหยุด', 'เวลาทำงาน', 'ตารางงาน', 'เข้ากะ',
      'พนักงาน', 'รหัสพนักงาน', 'บัตรพนักงาน', 'สัญญาจ้าง', 'ทดลองงาน', 'ประเมิน', 'ฝึกอบรม', 'สมัครงาน', 'รับสมัคร', 'เครื่องแบบ', 'ยูนิฟอร์ม'
    ],
    wordsEn: ['hr', 'payroll', 'salary', 'leave', 'holiday', 'attendance', 'welfare', 'ot', 'overtime', 'timesheet', 'payslip'],
    samples: [s('เวลาเข้างานของฉัน', 'เวลาเข้างานของฉัน วันนี้'), s('สรุปพนักงาน วันนี้'), s('สรุปพนักงาน ตามแผนก')],
    groupSamples: [s('สรุปพนักงาน วันนี้'), s('สรุปพนักงาน ตามแผนก'), s('สรุปพนักงาน เมื่อวาน')],
    groupNote: 'เวลาเข้างานของฉัน ทักผมแบบ 1:1'
  },
  {
    key: 'maintenance',
    label: 'ซ่อมบำรุง (MT)',
    aliases: ['mt', 'maintenance', 'mt notification', 'ซ่อมบำรุง', 'ช่าง'],
    words: [
      'ซ่อม', 'บำรุง', 'เสีย', 'ชำรุด', 'พัง', 'ขัดข้อง', 'ช่าง',
      'น้ำมัน', 'เติมน้ำมัน', 'เบิกน้ำมัน', 'ดีเซล', 'เบนซิน',
      'รถ', 'จองรถ', 'ขอรถ', 'ใช้รถ', 'ยานพาหนะ', 'ทะเบียน', 'คนขับ', 'เดินทางไป',
      'เครื่องจักร', 'เครื่องมือ', 'อะไหล่', 'เครน', 'รถยก', 'โฟล์คลิฟท์', 'ฟอร์คลิฟท์', 'ปั๊ม', 'มอเตอร์', 'คอมเพรสเซอร์', 'เครื่องเชื่อม',
      'งานค้าง', 'เร่งด่วน', 'ใบแจ้งซ่อม', 'ใบสั่งงาน'
    ],
    wordsEn: ['maintenance', 'repair', 'fuel', 'vehicle', 'car', 'truck', 'machine', 'crane', 'forklift', 'pm', 'breakdown', 'spare', 'mt', 'work order'],
    samples: [s('สรุปงานซ่อมวันนี้'), s('งานซ่อมเร่งด่วน'), s('รถว่างวันนี้'), s('แจ้งซ่อม')]
  }
]

/** บรรทัดที่ต่อท้าย FALLBACK_TEXT เมื่อ OA เดียวตอบเรื่องซ่อมบำรุงด้วย */
export const MAINTENANCE_HINT_LINE = '- ถามเรื่องงานซ่อม น้ำมัน หรือรถ เช่น "สรุปงานซ่อมวันนี้" "งานซ่อมเร่งด่วน" "รถว่างวันนี้"'

function topicDef(key: TopicKey): TopicDef {
  return TOPICS.find((t) => t.key === key) as TopicDef
}

/**
 * ชื่อทั้งหมดที่ใช้เรียกบอทหลัง @ (ชื่อกลาง + ชื่อของหัวข้อที่เลือก) ให้ maintenanceHandler.extractAddressed ใช้
 * ไม่ระบุ = ทุกหัวข้อ (โหมด OA เดียว) ; OA MT แยกส่งเฉพาะ ['maintenance']
 */
export function botAliases(topics: TopicKey[] = TOPICS.map((t) => t.key)): string[] {
  return [...GENERIC_BOT_ALIASES, ...TOPICS.filter((t) => topics.includes(t.key)).flatMap((t) => t.aliases)]
}

/** หัวข้อจากชื่อที่ผู้ใช้เรียกหลัง @ ("@HR" -> hr, "@MT" -> maintenance, "@ผู้ช่วย"/ชื่อ OA -> unknown) */
export function topicFromAlias(alias: string | null | undefined): ChatTopic {
  const a = (alias ?? '').trim().toLowerCase()
  if (a === '') return 'unknown'
  return TOPICS.find((t) => t.aliases.includes(a))?.key ?? 'unknown'
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * คำนำหน้าระบุหัวข้อที่ต้นข้อความ เช่น "HR: สรุปพนักงาน" "MT รถเสีย" "ซ่อมบำรุง: ..." -> หัวข้อนั้น + ข้อความที่ตัดคำนำหน้าออก
 * คำอังกฤษต้องเป็นคำเต็ม คำไทยต้องตามด้วยช่องว่างหรือเครื่องหมาย (กันไปตัด "ช่างไฟ" เป็น "ไฟ")
 */
export function stripTopicPrefix(text: string): { topic: ChatTopic; text: string } {
  const raw = text.trim()
  for (const t of TOPICS) {
    for (const alias of [...t.aliases].sort((a, b) => b.length - a.length)) {
      const en = /^[a-z0-9 ]+$/.test(alias)
      const re = new RegExp(`^${escapeRegExp(alias)}${en ? '(?![a-z0-9])' : ''}\\s*[:：,\\-]?${en ? '' : '(?=\\s|$|[:：,\\-])'}\\s*(.*)$`, 'is')
      const m = re.exec(raw)
      if (m) return { topic: t.key, text: m[1].trim() }
    }
  }
  return { topic: 'unknown', text: raw }
}

function countHits(text: string, thaiWords: string[], enWords: string[]): number {
  let n = 0
  for (const w of thaiWords) if (text.includes(w)) n++
  for (const w of enWords) if (new RegExp(`(^|[^a-z])${w.replace(/\s+/g, '\\s+')}($|[^a-z])`).test(text)) n++
  return n
}

/** แยกหัวข้อจากคำหลักในข้อความอย่างเดียว (ไม่ดู @ หรือคำนำหน้า) */
export function detectTopic(text: string): ChatTopic {
  const t = text.toLowerCase().replace(/\s+/g, ' ').trim()
  if (t === '') return 'unknown'
  const scores = TOPICS.map((d) => ({ key: d.key, hits: countHits(t, d.words, d.wordsEn) }))
  const best = scores.reduce((a, b) => (b.hits > a.hits ? b : a))
  return best.hits === 0 ? 'unknown' : best.key
}

/**
 * ตัดสินหัวข้อของข้อความที่ส่งถึงบอท
 *   alias = ชื่อที่ผู้ใช้เรียกหลัง @ (จาก extractAddressed) ถ้าระบุหัวข้อชัด (@HR / @MT) ใช้เลย
 *   ไม่งั้นดูคำนำหน้าต้นข้อความ แล้วค่อยนับคำหลัก  คืนข้อความที่ตัดคำนำหน้าออกแล้วด้วย
 */
export function resolveTopic(input: { text: string; alias?: string | null }): { topic: ChatTopic; text: string } {
  const byAlias = topicFromAlias(input.alias)
  if (byAlias !== 'unknown') return { topic: byAlias, text: input.text.trim() }
  const prefixed = stripTopicPrefix(input.text)
  if (prefixed.topic !== 'unknown') return prefixed
  return { topic: detectTopic(prefixed.text), text: prefixed.text }
}

/**
 * quick reply รวมตัวอย่างคำถามของหัวข้อที่เลือก (ไม่ระบุ = ทุกหัวข้อ)
 * ในกลุ่มต้องเติม "@ผู้ช่วย " หน้าข้อความ ไม่งั้นบอทจะไม่ตอบ (ตอบเฉพาะเมื่อถูกเรียก)
 */
export function topicQuickReply(opts: { inGroup: boolean; topic?: TopicKey }): { items: unknown[] } {
  const defs = opts.topic ? [topicDef(opts.topic)] : TOPICS
  const items = defs
    .flatMap((d) => (opts.inGroup ? (d.groupSamples ?? d.samples) : d.samples))
    .slice(0, 13)
    .map((x) => ({
      type: 'action',
      action: { type: 'message', label: x.label, text: opts.inGroup ? `@${GENERIC_BOT_ALIASES[0]} ${x.text}` : x.text }
    }))
  return { items }
}

function topicLine(d: TopicDef, inGroup: boolean): string {
  const examples = (inGroup ? (d.groupSamples ?? d.samples) : d.samples).map((x) => x.text).join(' / ')
  return `• ${d.label}: ${examples}${inGroup && d.groupNote ? ` (${d.groupNote})` : ''}`
}

/**
 * ข้อความแนะนำ + quick reply เมื่อไม่ชัดว่าถามเรื่องอะไร (topic ไม่ระบุ)
 * หรือรู้หัวข้อแล้วแต่ยังไม่มีฟีเจอร์ตอบคำถามนั้น (topic ระบุ) -> แนะนำเฉพาะเรื่องที่หัวข้อนั้นตอบได้
 */
export function buildTopicHelp(opts: { inGroup: boolean; topic?: TopicKey }): { text: string; quickReply: { items: unknown[] } } {
  const call = `@${GENERIC_BOT_ALIASES[0]}`
  const names = TOPICS.map((t) => t.label).join(' หรือ ')
  const lines: string[] = []
  if (opts.topic) {
    lines.push(`เรื่อง ${topicDef(opts.topic).label} ที่ผมตอบได้ตอนนี้ครับ เลือกจากปุ่มด้านล่างได้เลย`)
    lines.push(topicLine(topicDef(opts.topic), opts.inGroup))
  } else {
    lines.push(
      opts.inGroup
        ? `ยังไม่แน่ใจว่าเป็นเรื่อง ${names} ครับ เลือกจากปุ่มด้านล่าง หรือพิมพ์ ${call} ตามด้วยคำถามให้ชัดขึ้น`
        : `ยังไม่แน่ใจว่าเป็นเรื่อง ${names} ครับ เลือกจากปุ่มด้านล่าง หรือพิมพ์คำถามให้ชัดขึ้น`
    )
    for (const d of TOPICS) lines.push(topicLine(d, opts.inGroup))
    const [hr, mt] = ['hr', 'maintenance'].map((k) => topicDef(k as TopicKey).aliases[0].toUpperCase())
    lines.push(
      opts.inGroup
        ? `ระบุหัวข้อเองได้ เช่น "@${hr} สรุปพนักงานวันนี้" หรือ "@${mt} รถเสีย"`
        : `ระบุหัวข้อเองได้ เช่น "${hr} สรุปพนักงานวันนี้" หรือ "${mt} รถเสีย"`
    )
  }
  return { text: lines.join('\n'), quickReply: topicQuickReply(opts) }
}
