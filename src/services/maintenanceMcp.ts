import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { config } from '../config'

// ---------------------------------------------------------------------------
// MCP client ฝั่งแอป สำหรับ MCP server ของระบบซ่อมบำรุง (Streamable HTTP)
//   - ต่อครั้งเดียวแล้วใช้ session เดิมไปเรื่อย ๆ ถ้าหลุดจะต่อใหม่ให้เองในครั้งถัดไป
//   - แคชรายชื่อ tool ไว้ (เซิร์ฟเวอร์ประกาศ listChanged ก็ล้างแคช)
//   - แปลงผลลัพธ์ของ tool เป็นข้อความ เพื่อส่งกลับให้โมเดลอ่านต่อ
// ---------------------------------------------------------------------------

export interface McpToolInfo {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface McpToolCallResult {
  text: string
  isError: boolean
}

const TOOLS_CACHE_TTL_MS = 10 * 60 * 1000
// ผลลัพธ์ tool ที่ยาวเกินนี้จะถูกตัด กันโทเคนบานโดยไม่จำเป็น (JSON สรุปปกติสั้นกว่านี้มาก)
const MAX_RESULT_CHARS = 30000

let client: Client | null = null
let transport: StreamableHTTPClientTransport | null = null
let connecting: Promise<Client> | null = null
let toolsCache: { tools: McpToolInfo[]; fetchedAt: number } | null = null

/** ตรวจว่าชื่อ tool ตรงกับรายการที่อนุญาตใน MAINTENANCE_MCP_TOOLS หรือไม่ (รองรับ * ท้ายชื่อ) */
export function isToolAllowed(name: string): boolean {
  const patterns = config.maintenance.mcpTools
  if (patterns.length === 0 || patterns.includes('*')) return true
  return patterns.some((p) => {
    if (p.endsWith('*')) return name.toLowerCase().startsWith(p.slice(0, -1).toLowerCase())
    return name.toLowerCase() === p.toLowerCase()
  })
}

async function connect(): Promise<Client> {
  if (client) return client
  if (connecting) return connecting

  connecting = (async () => {
    const headers: Record<string, string> = {}
    if (config.maintenance.mcpAuthHeader) {
      // รูปแบบ "Header-Name: value" เช่น "Authorization: Bearer xxx"
      const idx = config.maintenance.mcpAuthHeader.indexOf(':')
      if (idx > 0) {
        headers[config.maintenance.mcpAuthHeader.slice(0, idx).trim()] = config.maintenance.mcpAuthHeader
          .slice(idx + 1)
          .trim()
      }
    }

    const nextTransport = new StreamableHTTPClientTransport(new URL(config.maintenance.mcpUrl), {
      requestInit: Object.keys(headers).length > 0 ? { headers } : undefined
    })
    const nextClient = new Client({ name: 'line-workflow-maintenance-bot', version: '1.0.0' })

    nextClient.onclose = () => {
      // session หลุด (เซิร์ฟเวอร์ restart ฯลฯ) -> ทิ้ง client นี้ ครั้งหน้าต่อใหม่
      if (client === nextClient) {
        client = null
        transport = null
        toolsCache = null
      }
    }
    nextClient.onerror = (err) => {
      console.error('[MCP] error:', err instanceof Error ? err.message : err)
    }
    // เซิร์ฟเวอร์แจ้งว่ารายการ tool เปลี่ยน -> ล้างแคช
    nextClient.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      toolsCache = null
    })

    await nextClient.connect(nextTransport)
    client = nextClient
    transport = nextTransport
    console.log(`[MCP] เชื่อมต่อ ${config.maintenance.mcpUrl} สำเร็จ (session ${nextTransport.sessionId ?? '-'})`)
    return nextClient
  })()

  try {
    return await connecting
  } finally {
    connecting = null
  }
}

/** ทิ้งการเชื่อมต่อปัจจุบัน (ใช้เมื่อเรียกแล้ว error เพื่อให้ครั้งถัดไปต่อใหม่) */
async function reset(): Promise<void> {
  const current = client
  client = null
  transport = null
  toolsCache = null
  try {
    await current?.close()
  } catch {
    // ปิดไม่ได้ก็ไม่เป็นไร
  }
}

/** รายชื่อ tool ที่บอทเรียกได้ (กรองตาม MAINTENANCE_MCP_TOOLS แล้ว) */
export async function getMaintenanceTools(): Promise<McpToolInfo[]> {
  if (toolsCache && Date.now() - toolsCache.fetchedAt < TOOLS_CACHE_TTL_MS) return toolsCache.tools

  const run = async (): Promise<McpToolInfo[]> => {
    const c = await connect()
    const res = await c.listTools(undefined, { timeout: config.maintenance.mcpTimeoutMs })
    return res.tools
      .filter((t) => isToolAllowed(t.name))
      .map((t) => ({
        name: t.name,
        description: t.description ?? '',
        inputSchema: (t.inputSchema ?? { type: 'object' }) as Record<string, unknown>
      }))
  }

  let tools: McpToolInfo[]
  try {
    tools = await run()
  } catch (err) {
    // ลองต่อใหม่หนึ่งครั้ง (กรณี session เดิมหมดอายุ)
    console.warn('[MCP] listTools ไม่สำเร็จ จะเชื่อมต่อใหม่:', err instanceof Error ? err.message : err)
    await reset()
    tools = await run()
  }
  toolsCache = { tools, fetchedAt: Date.now() }
  return tools
}

/** เรียก tool บน MCP server แล้วคืนผลเป็นข้อความสำหรับส่งให้โมเดล */
export async function callMaintenanceTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
  if (!isToolAllowed(name)) {
    return { text: `tool "${name}" ไม่ได้รับอนุญาตให้เรียกจากแชทบอทนี้`, isError: true }
  }

  const run = async () => {
    const c = await connect()
    return c.callTool({ name, arguments: args }, undefined, { timeout: config.maintenance.mcpTimeoutMs })
  }

  let result: Awaited<ReturnType<typeof run>>
  try {
    result = await run()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // session หลุด/หมดอายุ -> ต่อใหม่แล้วลองอีกครั้งเดียว
    if (/session|404|not found|closed|ECONN|fetch failed/i.test(message)) {
      console.warn(`[MCP] ${name} ล้มเหลว (${message}) จะเชื่อมต่อใหม่แล้วลองอีกครั้ง`)
      await reset()
      try {
        result = await run()
      } catch (err2) {
        return { text: `เรียก ${name} ไม่สำเร็จ: ${err2 instanceof Error ? err2.message : String(err2)}`, isError: true }
      }
    } else {
      return { text: `เรียก ${name} ไม่สำเร็จ: ${message}`, isError: true }
    }
  }

  return { text: truncate(resultToText(result)), isError: Boolean((result as { isError?: boolean }).isError) }
}

function resultToText(result: unknown): string {
  const r = result as {
    content?: Array<{ type: string; text?: string; mimeType?: string; uri?: string }>
    structuredContent?: unknown
  }
  const parts: string[] = []
  for (const block of r.content ?? []) {
    if (block.type === 'text' && typeof block.text === 'string') parts.push(decodeJsonText(block.text))
    else if (block.type === 'resource' && block.uri) parts.push(`[resource ${block.uri}]`)
    else parts.push(`[${block.type}]`)
  }
  if (parts.length === 0 && r.structuredContent !== undefined) parts.push(JSON.stringify(r.structuredContent))
  return parts.join('\n') || '(ไม่มีข้อมูลตอบกลับ)'
}

/**
 * เซิร์ฟเวอร์ (.NET) ส่ง JSON ที่หนีอักษรไทยเป็น \u0E23\u0E30... โมเดลอ่านแล้วมักเข้าใจว่าข้อมูลเสีย
 * จึง parse แล้ว stringify ใหม่ให้เป็นตัวอักษรไทยจริง (สั้นลงด้วย) ถ้าไม่ใช่ JSON ก็คืนตามเดิม
 */
function decodeJsonText(text: string): string {
  const trimmed = text.trim()
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return text
  try {
    return JSON.stringify(JSON.parse(trimmed))
  } catch {
    return text
  }
}

function truncate(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text
  return `${text.slice(0, MAX_RESULT_CHARS)}\n...[ตัดข้อความส่วนที่เหลือออก ${text.length - MAX_RESULT_CHARS} ตัวอักษร]`
}

/** สถานะสำหรับ /health */
export function maintenanceMcpStatus(): { url: string; connected: boolean; sessionId: string | null; tools: number | null } {
  return {
    url: config.maintenance.mcpUrl,
    connected: client !== null,
    sessionId: transport?.sessionId ?? null,
    tools: toolsCache?.tools.length ?? null
  }
}
