import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { config } from '../config'
import { login } from './authApi'

// ---------------------------------------------------------------------------
// MCP client สำหรับ integra-store-mcp-service (Store Control AI assistant ของ qtec-integra)
//   - เซิร์ฟเวอร์เป็น stateless: เปิด client ใหม่ทุกครั้งที่เรียก แล้วปิดทิ้ง (ไม่มี session ให้ดูแล)
//   - ทุก tool ตรวจสิทธิ์เมนูของผู้เรียกผ่าน auth service ด้วย bearer จึงล็อกอินด้วยบัญชีบริการ
//     (STORE_MCP_USERNAME / STORE_MCP_PASSWORD) บัญชีนั้นต้องเปิดแอป Employee Backlogs ได้
//   - token เก็บในหน่วยความจำจนใกล้หมดอายุ ถ้าเซิร์ฟเวอร์ตอบ NOT_SIGNED_IN จะล็อกอินใหม่หนึ่งครั้ง
// ---------------------------------------------------------------------------

export class StoreMcpError extends Error {}

let session: { token: string; expiresAt: number } | null = null

async function bearer(force = false): Promise<string> {
  const s = config.storeAbsence
  if (!s.username || !s.password) throw new StoreMcpError('ยังไม่ได้ตั้ง STORE_MCP_USERNAME / STORE_MCP_PASSWORD')
  if (!force && session && Date.now() < session.expiresAt) return session.token
  const result = await login(s.username, s.password)
  const exp = result.expiration ? Date.parse(result.expiration) : NaN
  // ต่ออายุก่อนหมด 5 นาที ไม่รู้วันหมดอายุ = ใช้ 30 นาที
  const expiresAt = Number.isFinite(exp) ? exp - 5 * 60_000 : Date.now() + 30 * 60_000
  session = { token: result.token, expiresAt }
  return result.token
}

async function callOnce(name: string, args: Record<string, unknown>, token: string) {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
  if (config.storeAbsence.project) headers['X-Store-Project'] = config.storeAbsence.project
  const transport = new StreamableHTTPClientTransport(new URL(config.storeAbsence.mcpUrl), { requestInit: { headers } })
  const client = new Client({ name: 'line-workflow-store', version: '1.0.0' })
  try {
    await client.connect(transport)
    return await client.callTool({ name, arguments: args }, undefined, { timeout: config.storeAbsence.timeoutMs })
  } finally {
    await client.close().catch(() => undefined)
  }
}

function textOf(result: unknown): string {
  const r = result as { content?: Array<{ type: string; text?: string }>; structuredContent?: unknown }
  const parts = (r.content ?? []).filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text as string)
  if (parts.length === 0 && r.structuredContent !== undefined) return JSON.stringify(r.structuredContent)
  return parts.join('\n')
}

/** เรียก tool แล้วคืนผลที่ parse เป็น JSON แล้ว (tool ตอบ error = โยน StoreMcpError พร้อมข้อความจากเซิร์ฟเวอร์) */
export async function callStoreTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
  let result = await callOnce(name, args, await bearer())
  let text = textOf(result)
  if ((result as { isError?: boolean }).isError && /NOT_SIGNED_IN/.test(text)) {
    result = await callOnce(name, args, await bearer(true))
    text = textOf(result)
  }
  if ((result as { isError?: boolean }).isError) throw new StoreMcpError(text || `${name} ตอบ error`)
  try {
    return JSON.parse(text) as T
  } catch {
    throw new StoreMcpError(`${name} ตอบกลับไม่ใช่ JSON: ${text.slice(0, 200)}`)
  }
}

// ---------------------------------------------------------------------------
// store_absent_employee_backlogs
// ---------------------------------------------------------------------------

export type StoreAbsenceLocation = 'Workshop' | 'Site'

export interface AbsentHolderItem {
  itemCode?: string
  itemName?: string
  size?: string
  unit?: string
  assetCode?: string
  codeNo?: string
  qty: number
  docNo?: string
  since?: string
  daysOut: number
  dueDate?: string
  overdue: boolean
  location?: string
}

export interface AbsentHolder {
  empCode: string
  name: string
  nickname?: string
  department?: string
  position?: string
  foreman?: string
  location: StoreAbsenceLocation
  daysAbsent: number
  lastScan: string
  absentSince: string
  /** รหัสที่ Store บันทึกไว้ (อาจมี S นำหน้า ต่างจากรหัส HR) */
  storeEmpCodes?: string[]
  lines: number
  qty: number
  overdueLines: number
  maxDaysOut: number
  items: AbsentHolderItem[]
  moreLines: number
}

export interface AbsentBacklogReport {
  asOf: string
  minDays: number
  project?: string
  handoutMode?: string
  counted?: string
  totals: { absent: number; withBacklog: number; lines: number; qty: number; overdueLines: number }
  byLocation: Array<{
    location: StoreAbsenceLocation
    activePeople: number
    absent: number
    stale: number
    withBacklog: number
    lines: number
    qty: number
  }>
  people: AbsentHolder[]
  morePeople: number
}

export interface AbsentBacklogOptions {
  asOf?: string
  minDays?: number
  workLocation?: StoreAbsenceLocation
  top?: number
  linesPerPerson?: number
  mode?: string
}

export function getAbsentEmployeeBacklogs(options: AbsentBacklogOptions = {}): Promise<AbsentBacklogReport> {
  const args: Record<string, unknown> = {}
  if (options.asOf) args.asOf = options.asOf
  if (options.minDays) args.minDays = options.minDays
  if (options.workLocation) args.workLocation = options.workLocation
  if (options.top) args.top = options.top
  if (options.linesPerPerson) args.linesPerPerson = options.linesPerPerson
  if (options.mode) args.mode = options.mode
  return callStoreTool<AbsentBacklogReport>('store_absent_employee_backlogs', args)
}

// ---------------------------------------------------------------------------
// store_employee_backlogs (คนเดียว) สำหรับการ์ดรายละเอียดเมื่อกด ›
// ---------------------------------------------------------------------------

export interface EmployeeBacklogResult {
  project?: string
  counted?: string
  result?: {
    items?: Array<AbsentHolderItem & { empCode?: string; empName?: string; locationName?: string }>
    totalCount?: number
  }
}

export function getEmployeeBacklog(empCode: string, pageSize = 10): Promise<EmployeeBacklogResult> {
  return callStoreTool<EmployeeBacklogResult>('store_employee_backlogs', { empCode, pageSize })
}
