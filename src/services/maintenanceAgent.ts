import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { config, maintenanceModelLabel, maintenanceProviderOrder } from '../config'
import { callMaintenanceTool, getMaintenanceTools, type McpToolInfo } from './maintenanceMcp'
import type { ConversationTurn } from './directMessages'
import { cardToText, normalizeCard, type AgentReply } from './maintenanceFlex'
import { LOCAL_TOOLS, callLocalTool, isLocalTool } from './maintenanceLocalTools'

// ---------------------------------------------------------------------------
// แชทบอททีมซ่อมบำรุง: รับคำถามภาษาไทยจาก LINE -> โมเดลเลือกเรียก tool จาก MCP server
// -> วนจนโมเดลตอบเป็นข้อความ (agentic loop แบบเขียนเอง เพราะรายชื่อ tool มาจาก MCP
//    ตอนรันไทม์ และต้องแทรก requestedBy จากฝั่งเซิร์ฟเวอร์เพื่อ audit trail)
//
// ผู้ให้บริการโมเดล (MAINTENANCE_AI_PROVIDER) - โปรเจกต์นี้ใช้ OpenAI เป็นหลัก
//   auto (ค่าเริ่มต้น) = ใช้ OpenAI ถ้ามี OPENAI_API_KEY ถ้า OpenAI ปฏิเสธเพราะ key/เครดิต
//                        และมี ANTHROPIC_API_KEY จะสลับไป Claude ให้เอง (เฉพาะก่อนเรียก tool ใด ๆ)
//   openai / anthropic  = บังคับใช้ตัวนั้นตัวเดียว
// ---------------------------------------------------------------------------

export interface AgentRequest {
  userId: string
  displayName: string | null
  text: string
  history: ConversationTurn[]
  /** มาจากกลุ่มไหน (null = แชท 1:1) */
  groupId?: string | null
}

export interface AgentAnswer {
  /** ข้อความล้วน (ใช้เก็บประวัติ/ log / altText) */
  text: string
  /** รูปแบบที่จะส่งเข้า LINE: การ์ด Flex หรือข้อความ */
  reply: AgentReply
  toolsUsed: string[]
  model: string
  /** true เมื่อคำตอบเป็นข้อความขออภัยจากระบบ (ไม่ใช่คำตอบจริง) */
  failed: boolean
}

const SYSTEM_PROMPT = `คุณคือ "ผู้ช่วยทีมซ่อมบำรุง" ของบริษัท QTEC ตอบผ่านแชท LINE
หน้าที่: ตอบคำถามเกี่ยวกับงานซ่อม (repair) การเบิกน้ำมัน (fuel) และรถ/ยานพาหนะ (vehicle)
โดยดึงข้อมูลจริงจาก tool ที่ให้ไว้เท่านั้น ห้ามเดาตัวเลขหรือแต่งข้อมูลเอง

บุคลิก: เป็นเพื่อนร่วมทีมที่สุภาพ เป็นกันเอง กระชับ แทนตัวเองว่า "ผม" ลงท้ายประโยคด้วย "ครับ" เสมอ
(ห้ามใช้ ค่ะ/คะ/ฉัน/ดิฉัน) ทักทายสั้น ๆ แล้วชวนถามเรื่องงานได้เลย ไม่ต้องอธิบายยาว

การใช้ tool
- คำถามเกี่ยวกับสรุป ยอด งานค้าง แจ้งเตือน หรือภาพรวม ให้เรียก tool ที่ตรงที่สุดก่อนตอบเสมอ
- period ใช้ค่า today | yesterday | this_week | last_week | this_month | last_month (เวลาไทย)
  แปลงจากภาษาไทย: วันนี้=today, เมื่อวาน=yesterday, สัปดาห์นี้=this_week, สัปดาห์ที่แล้ว=last_week,
  เดือนนี้=this_month, เดือนที่แล้ว=last_month ถ้าผู้ใช้ไม่ระบุช่วงเวลา ให้ใช้ today
- ถ้าผู้ใช้ระบุสาขา/แผนก ให้ใส่ branch ถ้าระบุเลขที่งาน ทะเบียนรถ หรือคำค้น ให้ใส่ keyword
- ระบบจะใส่ requestedBy ให้อัตโนมัติ ไม่ต้องถามผู้ใช้
- แจ้งเตือนเข้าไลน์กลุ่มทีม: เมื่อผู้ใช้ "แจ้งเรื่อง/ยื่นคำขอ" (เช่น แจ้งซ่อม รถเสีย ขอเบิกน้ำมันด่วน)
  หรือสั่งให้ "แจ้ง/ประกาศ/ส่งเข้ากลุ่ม" ให้เรียก notify_line_group หนึ่งครั้ง โดยเรียบเรียง title/message ให้ทีมอ่านแล้วทำต่อได้
  (ใส่เลขที่งาน ทะเบียนรถ อาการ สถานที่ กำหนดเวลา ที่ผู้ใช้บอกมา ห้ามแต่งเพิ่ม) แล้วตอบยืนยันว่าส่งเข้ากลุ่มไหนแล้ว
  ถ้าข้อมูลไม่พอจะแจ้ง (ไม่รู้ว่าเรื่องอะไร/รถคันไหน) ให้ถามกลับสั้น ๆ ก่อน ไม่ต้องเดา
- tool กลุ่ม Send* ของระบบซ่อมบำรุง (ส่งเข้าคิวแจ้งเตือนกลาง) ให้เรียกเฉพาะเมื่อผู้ใช้ระบุชัดว่าต้องการส่งผ่านระบบกลาง
  และเมื่อส่งแล้วให้บอกว่าส่งอะไรไปทางไหน
- ผลลัพธ์ tool เป็น JSON {success, tool, period, data | error, meta} ถ้า success เป็น true ให้ใช้ค่าใน data ตอบได้เลย
  (ตัวเลข 0 หรือ details ว่าง แปลว่าไม่มีรายการ ไม่ใช่ระบบขัดข้อง) และ meta.period_range คือช่วงวันที่ที่ดึงจริง
- ถ้า tool ตอบ error (success เป็น false หรือมี error) ให้บอกผู้ใช้ตรง ๆ ว่าดึงข้อมูลไม่ได้ พร้อมสาเหตุสั้น ๆ อย่าแต่งคำตอบแทน

รูปแบบคำตอบ (สำคัญมาก: คำตอบสุดท้ายต้องเป็น JSON object เดียว ไม่มีข้อความอื่น ไม่มี code fence)
ระบบจะนำ JSON ไปวาดเป็นการ์ดใน LINE ให้เอง ห้ามใช้ markdown ในทุกช่อง

แบบที่ 1 ข้อความสั้น (ทักทาย ถามกลับ คำถามนอกเรื่อง หรือแจ้งว่าดึงข้อมูลไม่ได้):
{"kind":"text","text":"ข้อความ","suggestions":["คำถามถัดไป"]}

แบบที่ 2 การ์ดข้อมูล (ทุกครั้งที่ตอบด้วยข้อมูลจาก tool):
{"kind":"card",
 "title":"หัวเรื่องสั้น ๆ เช่น สรุปงานซ่อมวันนี้",
 "subtitle":"ช่วงเวลาหรือสาขา เช่น 6 ก.ย. 2569 · ทุกสาขา",
 "status":"ok | info | warning | critical",
 "summary":"สรุปใจความ 1-2 ประโยค บอกสิ่งสำคัญที่สุดก่อน",
 "metrics":[{"label":"ชื่อตัวเลข","value":"12","unit":"รายการ","tone":"neutral | good | warn | bad"}],
 "sections":[{"heading":"หัวข้อ เช่น เร่งด่วน","items":[{"text":"รายการ","detail":"รายละเอียดสั้น (ไม่บังคับ)","badge":"ป้ายสั้น เช่น ด่วน","tone":"bad"}]}],
 "note":"คำแนะนำหรือข้อสังเกตปิดท้าย (ไม่บังคับ)",
 "suggestions":["คำถามถัดไป 2-4 ข้อ"]}

กติกาของการ์ด
- ภาษาไทย สุภาพ กระชับ ทุกช่องเป็นข้อความสั้น (title ไม่เกิน 40 ตัวอักษร, summary ไม่เกิน 2 ประโยค)
- status: critical เมื่อมีรายการด่วน/เกินกำหนด, warning เมื่อมีงานค้างหรือสิ่งที่ควรจับตา, ok เมื่อเรียบร้อยไม่มีอะไรค้าง, info เมื่อเป็นข้อมูลทั่วไป
- metrics 2-6 ตัวเลขที่สำคัญที่สุด value เป็นตัวเลขล้วน (คั่นหลักพันได้) ใส่หน่วยใน unit เช่น รายการ ลิตร บาท คัน
  tone: bad = ด่วน/เกินกำหนด/ผิดปกติ, warn = ค้าง/รอ, good = เสร็จ/ปกติ, neutral = อื่น ๆ
- sections ไม่เกิน 3 หัวข้อ หัวข้อละไม่เกิน 5 รายการ ยกรายการเร่งด่วน/ค้างนานขึ้นก่อน ระบุเลขที่งานหรือทะเบียนรถถ้ามี
  ถ้าไม่มีรายการให้ไม่ต้องใส่ sections
- suggestions เป็นคำถามสั้น ๆ (ไม่เกิน 20 ตัวอักษร) ที่ผู้ใช้น่าจะถามต่อ เช่น "งานซ่อมค้าง" "สรุปน้ำมันเดือนนี้"
- ถ้าคำถามไม่เกี่ยวกับงานซ่อมบำรุง น้ำมัน หรือรถ ให้ตอบแบบที่ 1 ว่าช่วยได้เฉพาะเรื่องเหล่านี้ พร้อม suggestions ตัวอย่าง`

/**
 * แปลงข้อความจากโมเดลเป็น AgentReply
 * โมเดลควรตอบ JSON ตาม prompt แต่ถ้าหลุด (มีข้อความหุ้ม / ไม่ใช่ JSON) ให้ถือเป็นข้อความธรรมดา ไม่ล้ม
 */
export function parseAgentReply(raw: string): AgentReply {
  const text = raw.trim()
  const candidates: string[] = []
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) candidates.push(fenced[1].trim())
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1))

  for (const candidate of candidates) {
    let parsed: unknown
    try {
      parsed = JSON.parse(candidate)
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== 'object') continue
    const obj = parsed as Record<string, unknown>
    if (obj.kind === 'card' || (obj.kind === undefined && (obj.title || obj.metrics || obj.sections))) {
      return { kind: 'card', card: normalizeCard(obj) }
    }
    if (typeof obj.text === 'string' && obj.text.trim()) {
      const suggestions = normalizeCard({ suggestions: obj.suggestions }).suggestions
      return { kind: 'text', text: obj.text.trim(), suggestions }
    }
  }
  // ไม่ใช่ JSON: ตัด code fence ทิ้งแล้วส่งเป็นข้อความ
  return { kind: 'text', text: text.replace(/```(?:json)?/gi, '').trim() || NO_ANSWER_TEXT, suggestions: [] }
}

function replyToText(reply: AgentReply): string {
  return reply.kind === 'card' ? cardToText(reply.card) : reply.text
}

function textReply(text: string): AgentReply {
  return { kind: 'text', text, suggestions: [] }
}

export const AGENT_APOLOGY = 'ขออภัยครับ ระบบขัดข้องชั่วคราว ยังตอบคำถามนี้ไม่ได้ กรุณาลองใหม่อีกครั้งในอีกสักครู่ครับ'
const NO_ANSWER_TEXT = 'ขออภัยครับ ผมยังสรุปคำตอบไม่ได้ ลองถามใหม่อีกครั้งครับ'
const TOO_MANY_ROUNDS_TEXT =
  'คำถามนี้ต้องดึงข้อมูลหลายรอบเกินกำหนดครับ ลองถามให้แคบลง เช่น ระบุช่วงเวลาหรือเรื่องที่ต้องการครับ'
const TIMEOUT_TEXT = 'ขออภัยครับ ระบบใช้เวลานานเกินกำหนด กรุณาถามใหม่โดยระบุช่วงเวลาให้แคบลงครับ'
const REFUSAL_TEXT = 'ขออภัยครับ คำถามนี้ผมตอบให้ไม่ได้ ลองถามเรื่องงานซ่อม น้ำมัน หรือรถแทนได้ครับ'

function bangkokNow(): string {
  return new Date().toLocaleString('th-TH', {
    timeZone: config.timezone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

/** ส่วนของ system prompt ที่เปลี่ยนทุกครั้ง (เวลา + ผู้ถาม) แยกไว้ท้ายเพื่อให้ส่วนคงที่ถูก cache ได้ */
function dynamicContext(req: AgentRequest): string {
  return `ตอนนี้คือ ${bangkokNow()} (เวลาไทย)\nผู้ถาม: ${req.displayName ?? 'ไม่ทราบชื่อ'}${
    req.groupId ? ' (ถามจากในกลุ่ม)' : ''
  }`
}

/**
 * ป้ายชื่อผู้ถามสำหรับ audit trail ของ MCP (requestedBy)
 * ต้องเป็น ASCII ล้วน เพราะ MCP server ส่งค่านี้ต่อเป็น HTTP header ไปยัง service ปลายทาง
 * (ชื่อไทยทำให้ upstream ตอบ "Request headers must contain only ASCII characters")
 */
export function requestedByLabel(req: Pick<AgentRequest, 'userId' | 'displayName'>): string {
  const asciiName = (req.displayName ?? '').replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, ' ').trim()
  return asciiName ? `${asciiName} (line:${req.userId})` : `line:${req.userId}`
}

/**
 * ใส่ requestedBy ลงใน argument ของ tool ทับค่าที่โมเดลใส่มา เพื่อให้ audit trail เชื่อถือได้
 * schema ของ MCP นี้ห่อพารามิเตอร์ไว้ใน request หรือ payload
 */
function injectRequestedBy(input: unknown, requestedBy: string): Record<string, unknown> {
  const args: Record<string, unknown> = input && typeof input === 'object' ? { ...(input as Record<string, unknown>) } : {}
  let touched = false
  for (const key of ['request', 'payload']) {
    if (key in args) {
      const inner = args[key]
      args[key] = { ...(inner && typeof inner === 'object' ? (inner as Record<string, unknown>) : {}), requestedBy }
      touched = true
    }
  }
  if (!touched) {
    // tool ที่ไม่ได้ห่อพารามิเตอร์ (เผื่ออนาคต) ใส่ที่ระดับบนสุด
    args.requestedBy = requestedBy
  }
  return args
}

/** บริบทที่ทั้งสองผู้ให้บริการใช้ร่วมกันในหนึ่งคำถาม */
interface RunContext {
  req: AgentRequest
  tools: McpToolInfo[]
  requestedBy: string
  toolsUsed: string[]
  signal: AbortSignal
}

async function executeTool(ctx: RunContext, name: string, input: unknown): Promise<{ text: string; isError: boolean }> {
  const args = injectRequestedBy(input, ctx.requestedBy)
  console.log(`[MT-bot] เรียก tool ${name} ${JSON.stringify(args).slice(0, 300)}`)
  const result = isLocalTool(name)
    ? await callLocalTool(name, args, { requestedBy: ctx.requestedBy, displayName: ctx.req.displayName })
    : await callMaintenanceTool(name, args)
  ctx.toolsUsed.push(name)
  if (result.isError) console.warn(`[MT-bot] tool ${name} ตอบ error: ${result.text.slice(0, 300)}`)
  else if (config.maintenance.debug) console.log(`[MT-bot:debug] ผล ${name} (${result.text.length} ตัวอักษร): ${result.text.slice(0, 1500)}`)
  return result
}

/** error ที่แปลว่า "ผู้ให้บริการนี้ใช้ไม่ได้" (key ผิด / เครดิตหมด / ไม่มีสิทธิ์) ไม่ใช่ปัญหาชั่วคราว */
function isProviderUnusable(err: unknown): boolean {
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) return true
  if (err instanceof Anthropic.BadRequestError && /credit balance|billing/i.test(err.message)) return true
  if (err instanceof OpenAI.AuthenticationError || err instanceof OpenAI.PermissionDeniedError) return true
  // OpenAI ตอบ 429 ทั้งกรณี rate limit ชั่วคราวและกรณีโควตา/เครดิตหมด แยกด้วยข้อความ
  if (err instanceof OpenAI.RateLimitError && /insufficient_quota|billing|exceeded your current quota/i.test(err.message)) return true
  return false
}

function describeError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return 'ANTHROPIC_API_KEY ไม่ถูกต้อง'
  if (err instanceof Anthropic.RateLimitError) return 'Claude ถูกจำกัดอัตราการเรียก (rate limit)'
  if (err instanceof Anthropic.APIError) return `Claude API ${err.status ?? ''}: ${err.message}`
  if (err instanceof OpenAI.AuthenticationError) return 'OPENAI_API_KEY ไม่ถูกต้อง'
  if (err instanceof OpenAI.RateLimitError) return 'OpenAI ถูกจำกัดอัตราการเรียก (rate limit)'
  if (err instanceof OpenAI.APIError) return `OpenAI API ${err.status ?? ''}: ${err.message}`
  if (err instanceof Error) return err.message
  return String(err)
}

// ---------------------------------------------------------------------------
// Claude (Anthropic Messages API + tools)
// ---------------------------------------------------------------------------
async function runWithAnthropic(ctx: RunContext): Promise<string> {
  const { model, effort, maxToolRounds, answerTimeoutMs } = config.maintenance
  const client = new Anthropic({ apiKey: config.anthropic.apiKey, timeout: answerTimeoutMs })

  const tools: Anthropic.Tool[] = ctx.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Tool.InputSchema
  }))

  const messages: Anthropic.MessageParam[] = []
  for (const turn of ctx.req.history) {
    messages.push({ role: 'user', content: turn.userText })
    messages.push({ role: 'assistant', content: turn.replyText })
  }
  messages.push({ role: 'user', content: ctx.req.text })

  const system: Anthropic.TextBlockParam[] = [
    // ส่วนคงที่ไว้ก่อน เพื่อให้ prompt cache ทำงาน (ลำดับ tools -> system -> messages)
    { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: dynamicContext(ctx.req) }
  ]

  let lastText = ''
  for (let round = 0; round <= maxToolRounds; round++) {
    const response = await client.messages.create(
      { model, max_tokens: 4096, system, tools, output_config: { effort }, messages },
      { signal: ctx.signal }
    )

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim()
    lastText = text || lastText

    if (response.stop_reason === 'refusal') return REFUSAL_TEXT

    if (response.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: response.content })
      continue
    }

    const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
    if (response.stop_reason !== 'tool_use' || toolUses.length === 0) break

    messages.push({ role: 'assistant', content: response.content })

    // เรียกทุก tool ในรอบนี้พร้อมกัน แล้วส่งผลกลับใน user message เดียว
    const results = await Promise.all(
      toolUses.map(async (tu): Promise<Anthropic.ToolResultBlockParam> => {
        const result = await executeTool(ctx, tu.name, tu.input)
        return { type: 'tool_result', tool_use_id: tu.id, content: result.text, is_error: result.isError }
      })
    )
    messages.push({ role: 'user', content: results })

    if (round === maxToolRounds) {
      console.warn(`[MT-bot] เรียก tool ครบ ${maxToolRounds} รอบแล้ว หยุดวน`)
      lastText = lastText || TOO_MANY_ROUNDS_TEXT
    }
  }
  return lastText || NO_ANSWER_TEXT
}

// ---------------------------------------------------------------------------
// OpenAI (Chat Completions + function calling)
// ---------------------------------------------------------------------------
async function runWithOpenAI(ctx: RunContext): Promise<string> {
  const { maxToolRounds, answerTimeoutMs } = config.maintenance
  const client = new OpenAI({ apiKey: config.openai.apiKey, timeout: answerTimeoutMs })

  const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = ctx.tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.inputSchema }
  }))

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: `${SYSTEM_PROMPT}\n\n${dynamicContext(ctx.req)}` }
  ]
  for (const turn of ctx.req.history) {
    messages.push({ role: 'user', content: turn.userText })
    messages.push({ role: 'assistant', content: turn.replyText })
  }
  messages.push({ role: 'user', content: ctx.req.text })

  let lastText = ''
  for (let round = 0; round <= maxToolRounds; round++) {
    const response = await client.chat.completions.create(
      // json_object บังคับให้คำตอบสุดท้ายเป็น JSON (ยังเรียก tool ได้ตามปกติ)
      { model: config.openai.model, max_completion_tokens: 4096, tools, messages, response_format: { type: 'json_object' } },
      { signal: ctx.signal }
    )
    const choice = response.choices[0]
    if (!choice) break
    const assistant = choice.message
    lastText = (assistant.content ?? '').trim() || lastText

    if (choice.finish_reason === 'content_filter') return REFUSAL_TEXT

    const calls = assistant.tool_calls ?? []
    if (calls.length === 0) break

    messages.push({ role: 'assistant', content: assistant.content ?? null, tool_calls: calls })

    const results = await Promise.all(
      calls.map(async (call): Promise<OpenAI.Chat.Completions.ChatCompletionToolMessageParam> => {
        if (call.type !== 'function') {
          return { role: 'tool', tool_call_id: call.id, content: 'ไม่รองรับ tool call ชนิดนี้' }
        }
        let input: unknown = {}
        try {
          input = call.function.arguments ? JSON.parse(call.function.arguments) : {}
        } catch {
          return { role: 'tool', tool_call_id: call.id, content: 'argument ไม่ใช่ JSON ที่ถูกต้อง' }
        }
        const result = await executeTool(ctx, call.function.name, input)
        return { role: 'tool', tool_call_id: call.id, content: result.isError ? `ERROR: ${result.text}` : result.text }
      })
    )
    messages.push(...results)

    if (round === maxToolRounds) {
      console.warn(`[MT-bot] เรียก tool ครบ ${maxToolRounds} รอบแล้ว หยุดวน`)
      lastText = lastText || TOO_MANY_ROUNDS_TEXT
    }
  }
  return lastText || NO_ANSWER_TEXT
}

// ---------------------------------------------------------------------------
// จุดเรียกใช้จาก webhook handler
// ---------------------------------------------------------------------------

/** ตอบคำถามผู้ใช้หนึ่งข้อ (เรียก MCP tool ตามที่โมเดลเลือก) */
export async function answerMaintenanceQuestion(req: AgentRequest): Promise<AgentAnswer> {
  const providers = maintenanceProviderOrder()
  const label = maintenanceModelLabel()

  const fail = (text: string, model: string, toolsUsed: string[] = []): AgentAnswer => ({
    text,
    reply: textReply(text),
    toolsUsed,
    model,
    failed: true
  })

  if (providers.length === 0) {
    return fail(
      'ยังไม่ได้ตั้งค่า API key ของโมเดล (ANTHROPIC_API_KEY หรือ OPENAI_API_KEY) จึงยังใช้ผู้ช่วยตอบคำถามไม่ได้ครับ แจ้งผู้ดูแลระบบให้ตั้งค่าก่อนครับ',
      label
    )
  }

  // 1) รายชื่อ tool จาก MCP
  let tools: McpToolInfo[]
  try {
    tools = [...(await getMaintenanceTools()), ...LOCAL_TOOLS]
  } catch (err) {
    console.error('[MT-bot] ดึงรายชื่อ tool จาก MCP ไม่ได้:', err instanceof Error ? err.message : err)
    return fail('ตอนนี้เชื่อมต่อระบบข้อมูลซ่อมบำรุงไม่ได้ครับ กรุณาลองใหม่อีกสักครู่ หรือแจ้งผู้ดูแลระบบครับ', label)
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.maintenance.answerTimeoutMs)
  const ctx: RunContext = { req, tools, requestedBy: requestedByLabel(req), toolsUsed: [], signal: controller.signal }

  try {
    for (let i = 0; i < providers.length; i++) {
      const provider = providers[i]
      const model = provider === 'anthropic' ? `Claude ${config.maintenance.model}` : `OpenAI ${config.openai.model}`
      try {
        const raw = provider === 'anthropic' ? await runWithAnthropic(ctx) : await runWithOpenAI(ctx)
        if (config.maintenance.debug) console.log(`[MT-bot:debug] คำตอบดิบจาก ${model}: ${raw.slice(0, 2000)}`)
        const reply = parseAgentReply(raw)
        return { text: replyToText(reply), reply, toolsUsed: ctx.toolsUsed, model, failed: false }
      } catch (err) {
        const aborted = controller.signal.aborted
        console.error(`[MT-bot] ${model} ตอบไม่สำเร็จ${aborted ? ' (หมดเวลา)' : ''}:`, describeError(err))
        // สลับไปตัวสำรองเฉพาะเมื่อผู้ให้บริการนี้ใช้ไม่ได้จริง ๆ และยังไม่ได้เรียก tool ใด (กันเรียกซ้ำ)
        const canFallback = !aborted && i < providers.length - 1 && isProviderUnusable(err) && ctx.toolsUsed.length === 0
        if (!canFallback) return fail(aborted ? TIMEOUT_TEXT : AGENT_APOLOGY, model, ctx.toolsUsed)
        console.warn(`[MT-bot] จะลองใช้ ${providers[i + 1]} แทน`)
      }
    }
    return fail(AGENT_APOLOGY, label, ctx.toolsUsed)
  } finally {
    clearTimeout(timer)
  }
}
