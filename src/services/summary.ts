import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { config } from '../config'
import { query } from '../db'
import type { MessageRow } from './messages'

// ---------------------------------------------------------------------------
// สรุปบทสนทนากลุ่ม
//   - ถ้าตั้ง OPENAI_API_KEY ไว้ จะเรียก OpenAI ให้สรุปและสกัดงาน (ตัวหลัก)
//   - ถ้าไม่ได้ตั้ง แต่มี ANTHROPIC_API_KEY จะใช้ Claude API แทน
//   - ถ้าไม่มีเลย (หรือเรียกไม่สำเร็จ) จะใช้ตัวสรุปแบบ rule-based ในเครื่อง
//     ซึ่งทำงานได้ทันทีแบบออฟไลน์
// จุดสอน: ระบบที่ดีควรมี fallback ไม่ล้มทั้งระบบเพราะขาด API key หรือเครดิตหมด
// ---------------------------------------------------------------------------

export interface ExtractedTask {
  assignee: string
  task: string
  due?: string
}

export interface SummaryResult {
  summaryText: string
  topics: string[]
  tasks: ExtractedTask[]
  model: string
  messageCount: number
}

/** แปลงข้อความเป็น transcript บรรทัดเดียวต่อข้อความ ให้ AI อ่านง่าย */
export function buildTranscript(messages: MessageRow[]): string {
  return messages
    .filter((m) => m.message_type === 'text' && m.message_text)
    .map((m) => {
      const time = new Date(m.sent_at).toLocaleTimeString('th-TH', {
        timeZone: 'Asia/Bangkok',
        hour: '2-digit',
        minute: '2-digit'
      })
      return `[${time}] ${m.display_name ?? 'ไม่ทราบชื่อ'}: ${m.message_text}`
    })
    .join('\n')
}

const SYSTEM_PROMPT = `คุณเป็นผู้ช่วยสรุปการประชุมของทีมงานไทย
หน้าที่ของคุณคืออ่านบทสนทนาจากไลน์กลุ่มแล้วสรุปอย่างกระชับและตรงประเด็น
ตอบกลับเป็น JSON เท่านั้น ไม่ต้องมีคำอธิบายอื่นใด ไม่ต้องใส่ markdown code fence
รูปแบบ JSON:
{
  "summary": "สรุปภาพรวมไม่เกิน 8 บรรทัด แต่ละบรรทัดขึ้นต้นด้วย - ",
  "topics": ["หัวข้อที่คุยกัน", "..."],
  "tasks": [{"assignee": "ชื่อผู้รับผิดชอบ", "task": "งานที่ต้องทำ", "due": "กำหนดเวลาถ้ามี"}]
}
ข้อกำหนด:
- ใช้ภาษาไทยที่เป็นทางการพอประมาณ อ่านง่าย
- topics ไม่เกิน 5 หัวข้อ เรียงตามความสำคัญ
- tasks เอาเฉพาะงานที่มีคนรับปากหรือถูกมอบหมายชัดเจน ไม่เดาเอง
- ถ้าไม่มีงานที่มอบหมาย ให้ tasks เป็น []
- ห้ามใส่ข้อมูลที่ไม่ปรากฏในบทสนทนา`

export async function summarizeMessages(messages: MessageRow[]): Promise<SummaryResult> {
  const textMessages = messages.filter((m) => m.message_type === 'text' && m.message_text)
  if (textMessages.length === 0) {
    return {
      summaryText: '- ยังไม่มีข้อความในช่วงเวลาที่เลือก',
      topics: [],
      tasks: [],
      model: 'none',
      messageCount: 0
    }
  }

  if (config.openai.apiKey) {
    try {
      return await summarizeWithOpenAI(textMessages)
    } catch (err) {
      console.error('[AI] เรียก OpenAI API ไม่สำเร็จ ใช้ตัวสรุปในเครื่องแทน:', describeAiError(err))
    }
  } else if (config.anthropic.apiKey) {
    try {
      return await summarizeWithClaude(textMessages)
    } catch (err) {
      console.error('[AI] เรียก Claude API ไม่สำเร็จ ใช้ตัวสรุปในเครื่องแทน:', describeAiError(err))
    }
  }
  return summarizeLocally(textMessages)
}

/** ดึงข้อความ error ที่อ่านรู้เรื่องออกมา และเติมคำแนะนำสำหรับกรณีที่เจอบ่อย */
function describeAiError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  if (/insufficient_quota|credit balance is too low|quota/i.test(message)) {
    return `${message}\n      -> เครดิต/โควตาของผู้ให้บริการหมด ให้เติมเงินหรือสลับไปใช้ผู้ให้บริการอื่นใน .env`
  }
  if (/invalid[_ ]api[_ ]key|401|Incorrect API key/i.test(message)) {
    return `${message}\n      -> API key ไม่ถูกต้อง ตรวจค่า OPENAI_API_KEY / ANTHROPIC_API_KEY ใน .env`
  }
  return message
}

async function summarizeWithOpenAI(messages: MessageRow[]): Promise<SummaryResult> {
  const client = new OpenAI({ apiKey: config.openai.apiKey })
  const transcript = buildTranscript(messages)

  const response = await client.chat.completions.create({
    model: config.openai.model,
    max_completion_tokens: 2000,
    // บังคับให้ตอบเป็น JSON ที่ parse ได้เสมอ (SYSTEM_PROMPT มีคำว่า JSON อยู่แล้วตามที่ API กำหนด)
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `บทสนทนาในไลน์กลุ่ม:\n\n${transcript}` }
    ]
  })

  const raw = response.choices[0]?.message?.content ?? ''
  return parseSummaryJson(raw, config.openai.model, messages.length)
}

async function summarizeWithClaude(messages: MessageRow[]): Promise<SummaryResult> {
  const client = new Anthropic({ apiKey: config.anthropic.apiKey })
  const transcript = buildTranscript(messages)

  const response = await client.messages.create({
    model: config.anthropic.model,
    max_tokens: 2000,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: `บทสนทนาในไลน์กลุ่ม:\n\n${transcript}` }]
  })

  const raw = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('')

  return parseSummaryJson(raw, config.anthropic.model, messages.length)
}

/** แปลงคำตอบ JSON จากโมเดลให้เป็น SummaryResult (ใช้ร่วมกันทุกผู้ให้บริการ) */
function parseSummaryJson(raw: string, model: string, messageCount: number): SummaryResult {
  // เผื่อโมเดลใส่ code fence มาให้ ตัดออกก่อน parse
  const cleaned = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  const parsed = JSON.parse(cleaned) as {
    summary?: string
    topics?: string[]
    tasks?: ExtractedTask[]
  }

  return {
    summaryText: parsed.summary ?? '',
    topics: Array.isArray(parsed.topics) ? parsed.topics.slice(0, 5) : [],
    tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
    model,
    messageCount
  }
}

// ---------------------------------------------------------------------------
// ตัวสรุปแบบ rule-based (ไม่ต้องมี API key)
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  'ครับ', 'ค่ะ', 'คะ', 'นะ', 'แล้ว', 'ที่', 'ให้', 'ได้', 'ไม่', 'เป็น', 'ของ', 'กับ', 'จะ', 'มี', 'ว่า',
  'อยู่', 'ต้อง', 'ก็', 'ยัง', 'มา', 'ไป', 'นี้', 'นั้น', 'เลย', 'อีก', 'ด้วย', 'เรื่อง', 'ขอ', 'ทุก',
  'รับทราบ', 'ขอบคุณ', 'โอเค', 'เดี๋ยว', 'ผม', 'ดิฉัน', 'เรา', 'ทาง', 'มาก', 'พอ', 'ถ้า', 'จาก', 'ตาม'
])

const ASSIGN_PATTERNS = [/ช่วย/, /ฝาก/, /รบกวน/, /ขอให้/, /มอบหมาย/, /ทำ.*ส่ง/]
const COMMIT_PATTERNS = [/เดี๋ยว(ผม|ดิฉัน|เรา)?/, /จะ.*(ให้|ครับ|ค่ะ)/, /รับทราบ.*(จะ|ส่ง)/, /ผมจะ/, /ดิฉันจะ/]
const DUE_PATTERN =
  /(ภายในวันนี้|ก่อนเลิกงาน|วันนี้|พรุ่งนี้|มะรืน|สัปดาห์นี้|สัปดาห์หน้า|สิ้นเดือน|วันจันทร์|วันอังคาร|วันพุธ|วันพฤหัส|วันศุกร์|วันเสาร์|วันอาทิตย์|จันทร์|อังคาร|พุธ|พฤหัส|ศุกร์|เสาร์|อาทิตย์|บ่ายนี้|เช้านี้|เที่ยง|\d{1,2}\s*โมง)/

function keywordScore(messages: MessageRow[]): Map<string, number> {
  const freq = new Map<string, number>()
  for (const m of messages) {
    // ตัดคำแบบง่าย: แยกด้วยช่องว่างและอักขระที่ไม่ใช่ตัวอักษร
    const words = (m.message_text ?? '').split(/[\s,.!?()"'\/\-]+/)
    for (const w of words) {
      const word = w.trim()
      if (word.length < 3 || STOP_WORDS.has(word)) continue
      freq.set(word, (freq.get(word) ?? 0) + 1)
    }
  }
  return freq
}

export function summarizeLocally(messages: MessageRow[]): SummaryResult {
  const freq = keywordScore(messages)
  const topKeywords = [...freq.entries()]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([w]) => w)

  // เลือกข้อความตัวแทนของแต่ละคำสำคัญ = ข้อความแรกที่มีคำนั้นและยาวพอสมควร
  const topics: string[] = []
  const used = new Set<number>()
  for (const kw of topKeywords) {
    if (topics.length >= 5) break
    const idx = messages.findIndex(
      (m, i) => !used.has(i) && (m.message_text ?? '').includes(kw) && (m.message_text ?? '').length >= 20
    )
    if (idx >= 0) {
      used.add(idx)
      const text = (messages[idx].message_text ?? '').replace(/\s+/g, ' ').trim()
      topics.push(text.length > 70 ? `${text.slice(0, 70)}...` : text)
    }
  }

  const tasks: ExtractedTask[] = []
  for (const m of messages) {
    const text = m.message_text ?? ''
    const assigned = ASSIGN_PATTERNS.some((p) => p.test(text))
    const committed = COMMIT_PATTERNS.some((p) => p.test(text))
    if (!assigned && !committed) continue
    if (text.length < 15) continue

    // ถ้าเป็นการมอบหมาย ให้เดาผู้รับจากชื่อที่ปรากฏในข้อความ ถ้าไม่พบใช้ผู้ส่ง
    let assignee = m.display_name ?? 'ไม่ระบุ'
    if (assigned) {
      const names = [...new Set(messages.map((x) => (x.display_name ?? '').split(' ')[0]).filter(Boolean))]
      const found = names.find((n) => n !== '' && text.includes(n))
      if (found) assignee = found
    }

    const due = text.match(DUE_PATTERN)?.[1]
    const task = text.replace(/\s+/g, ' ').trim()
    tasks.push({ assignee, task: task.length > 90 ? `${task.slice(0, 90)}...` : task, due })
    if (tasks.length >= 8) break
  }

  const speakers = new Map<string, number>()
  for (const m of messages) {
    const name = m.display_name ?? 'ไม่ทราบชื่อ'
    speakers.set(name, (speakers.get(name) ?? 0) + 1)
  }
  const top = [...speakers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)

  const lines = [
    `- กลุ่มมีข้อความทั้งหมด ${messages.length} ข้อความจากผู้พูด ${speakers.size} คน`,
    `- ผู้พูดมากที่สุด: ${top.map(([n, c]) => `${n} (${c})`).join(', ')}`,
    ...topics.map((t) => `- ${t}`),
    tasks.length > 0
      ? `- พบงานที่มีคนรับไปทำ ${tasks.length} รายการ`
      : '- ไม่พบงานที่มอบหมายกันชัดเจนในช่วงเวลานี้'
  ]

  return {
    summaryText: lines.join('\n'),
    topics,
    tasks,
    model: 'local-rule-based',
    messageCount: messages.length
  }
}

// ---------------------------------------------------------------------------
// บันทึก/อ่านประวัติสรุป
// ---------------------------------------------------------------------------

/**
 * บันทึกสรุปของกลุ่มในวันหนึ่ง ๆ
 *
 * หนึ่งกลุ่มมีสรุปได้วันละใบเดียว (บังคับด้วย unique index ใน 01_schema.sql)
 * สั่งสรุปวันเดิมซ้ำจึงเป็นการ "ทับของเดิม" ไม่ใช่เพิ่มใบใหม่
 * ไม่งั้นการกดปุ่มซ้ำหรือตัวตั้งเวลาทำงานซ้ำจะทำให้หน้า /summaries
 * มีการ์ดของวันเดียวกันซ้อนกันหลายใบ
 */
export async function saveSummary(groupId: string, date: string, result: SummaryResult): Promise<number> {
  const rows = await query<{ id: number }>(
    `INSERT INTO group_summaries (group_id, summary_date, message_count, summary_text, topics, model)
     VALUES ($1, $2::date, $3, $4, $5::jsonb, $6)
     ON CONFLICT (group_id, summary_date) DO UPDATE
        SET message_count = EXCLUDED.message_count,
            summary_text  = EXCLUDED.summary_text,
            topics        = EXCLUDED.topics,
            model         = EXCLUDED.model,
            created_at    = now()
     RETURNING id`,
    [groupId, date, result.messageCount, result.summaryText, JSON.stringify(result.topics), result.model]
  )
  return rows[0]?.id ?? 0
}

export interface SummaryRow {
  id: number
  group_id: string
  summary_date: Date
  message_count: number | null
  summary_text: string | null
  topics: string[] | null
  model: string | null
  created_at: Date
}

export async function listSummaries(groupId?: string, limit = 30): Promise<SummaryRow[]> {
  return query<SummaryRow>(
    `SELECT * FROM group_summaries
      WHERE ($1::text IS NULL OR group_id = $1)
      ORDER BY summary_date DESC, created_at DESC
      LIMIT $2`,
    [groupId ?? null, limit]
  )
}
