import { messagingApi } from '@line/bot-sdk'
import { config } from '../config'

// ---------------------------------------------------------------------------
// ห่อ LINE Messaging API ไว้ชั้นเดียว เพื่อ
//   1) รองรับโหมด MOCK (ไม่ยิง API จริง) ให้ทดสอบ dashboard ได้โดยไม่ต้องมี OA
//   2) รวมการจัดการ error ไว้ที่เดียว ไม่ต้อง try/catch กระจายทั้งโปรเจกต์
// ---------------------------------------------------------------------------

const { MessagingApiClient, MessagingApiBlobClient } = messagingApi

// ---------------------------------------------------------------------------
// รองรับหลาย Official Account ในโปรเซสเดียว
//   hr = OA หลัก (HR Notification) ใช้ทุกฟีเจอร์เดิม (ค่าเริ่มต้นของทุกฟังก์ชัน)
//   mt = OA ทีมซ่อมบำรุง (Maintenance Team) ใช้กับแชทบอท MCP
// ---------------------------------------------------------------------------
export type ChannelKey = 'hr' | 'mt'

interface ChannelClients {
  api: InstanceType<typeof MessagingApiClient> | null
  blob: InstanceType<typeof MessagingApiBlobClient> | null
  mock: boolean
}

function buildChannel(token: string, mock: boolean): ChannelClients {
  return {
    api: token ? new MessagingApiClient({ channelAccessToken: token }) : null,
    // client แยกสำหรับดึงไฟล์ เพราะใช้คนละโดเมน (api-data.line.me)
    blob: token ? new MessagingApiBlobClient({ channelAccessToken: token }) : null,
    mock
  }
}

const channels: Record<ChannelKey, ChannelClients> = {
  hr: buildChannel(config.channelAccessToken, config.mockLine),
  mt: buildChannel(config.maintenance.channelAccessToken, config.maintenance.mockLine)
}

/** client ของ channel ที่พร้อมยิง API จริง (null = อยู่ในโหมด mock หรือยังไม่ได้ใส่ token) */
function liveApi(channel: ChannelKey) {
  const ch = channels[channel]
  return ch.mock ? null : ch.api
}

/** blob client (api-data.line.me) ของ channel ที่พร้อมยิง API จริง - ใช้ดึงไฟล์ที่ส่งเข้ามาทาง OA นั้น */
function liveBlob(channel: ChannelKey) {
  const ch = channels[channel]
  return ch.mock ? null : ch.blob
}

export const lineClient = channels.hr.api
export const lineBlobClient = channels.hr.blob

export type SendStatus = 'sent' | 'mock' | 'failed'

export interface SendOutcome {
  status: SendStatus
  error?: string
}

function mockLog(action: string, detail: unknown, channel: ChannelKey = 'hr'): SendOutcome {
  const tag = channel === 'hr' ? '[MOCK LINE]' : `[MOCK LINE:${channel}]`
  console.log(`${tag} ${action}`, typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 300))
  return { status: 'mock' }
}

/** ส่งข้อความ text เข้ากลุ่มหรือถึงผู้ใช้ (to = groupId หรือ userId) */
export async function pushText(to: string, text: string, channel: ChannelKey = 'hr'): Promise<SendOutcome> {
  const client = liveApi(channel)
  if (!client) return mockLog(`pushText -> ${to}`, text, channel)
  try {
    await client.pushMessage({ to, messages: [{ type: 'text', text }] })
    return { status: 'sent' }
  } catch (err) {
    return { status: 'failed', error: extractLineError(err) }
  }
}

/** ส่ง Flex Message (contents = JSON ของ bubble หรือ carousel) */
export async function pushFlex(
  to: string,
  altText: string,
  contents: unknown,
  channel: ChannelKey = 'hr'
): Promise<SendOutcome> {
  const client = liveApi(channel)
  if (!client) return mockLog(`pushFlex -> ${to} (${altText})`, contents, channel)
  try {
    await client.pushMessage({
      to,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      messages: [{ type: 'flex', altText, contents: contents as any }]
    })
    return { status: 'sent' }
  } catch (err) {
    return { status: 'failed', error: extractLineError(err) }
  }
}

/** broadcast ถึงผู้ติดตาม OA ทุกคน (ใช้โควต้าเยอะ ระวังตอนทดสอบ) */
export async function broadcastText(text: string): Promise<SendOutcome> {
  if (config.mockLine || !lineClient) return mockLog('broadcastText', text)
  try {
    await lineClient.broadcast({ messages: [{ type: 'text', text }] })
    return { status: 'sent' }
  } catch (err) {
    return { status: 'failed', error: extractLineError(err) }
  }
}

/** โควต้าข้อความคงเหลือของเดือนนี้ (Free plan = 200 ข้อความ/เดือน) */
export async function getQuota(): Promise<{ limit: number | null; used: number | null; mock: boolean }> {
  if (config.mockLine || !lineClient) return { limit: 200, used: 12, mock: true }
  try {
    const quota = await lineClient.getMessageQuota()
    const consumption = await lineClient.getMessageQuotaConsumption()
    return { limit: quota.value ?? null, used: consumption.totalUsage ?? null, mock: false }
  } catch {
    return { limit: null, used: null, mock: false }
  }
}

/** ชื่อผู้ส่งในกลุ่ม (ใช้ตอนบันทึกข้อความจาก webhook) */
export async function getGroupMemberName(
  groupId: string,
  userId: string,
  channel: ChannelKey = 'hr'
): Promise<string | null> {
  const client = liveApi(channel)
  if (!client) return null
  try {
    const profile = await client.getGroupMemberProfile(groupId, userId)
    return profile.displayName ?? null
  } catch (err) {
    console.error('[Profile] ดึงชื่อผู้ส่งไม่สำเร็จ:', extractLineError(err))
    return null
  }
}

/** ชื่อโปรไฟล์ของผู้ใช้ที่แชท 1:1 กับ OA (ต้องเป็นเพื่อนกับ OA อยู่) */
export async function getUserProfileName(userId: string, channel: ChannelKey = 'hr'): Promise<string | null> {
  const client = liveApi(channel)
  if (!client) return null
  try {
    const profile = await client.getProfile(userId)
    return profile.displayName ?? null
  } catch (err) {
    console.error('[Profile] ดึงชื่อผู้ใช้ไม่สำเร็จ:', extractLineError(err))
    return null
  }
}

/**
 * บอทของ channel นี้ยังอยู่ในกลุ่มหรือไม่ (LINE ตอบ 404 เมื่อบอทไม่ได้เป็นสมาชิก)
 * คืน null เมื่อตรวจไม่ได้ (โหมด mock หรือ error อื่น)
 */
export async function isBotInGroup(groupId: string, channel: ChannelKey = 'hr'): Promise<boolean | null> {
  const client = liveApi(channel)
  if (!client) return null
  try {
    await client.getGroupSummary(groupId)
    return true
  } catch (err) {
    const status = (err as { status?: number }).status
    if (status === 404) return false
    return null
  }
}

/** ชื่อกลุ่มตามที่ LINE รู้จัก (ใช้ตั้งชื่อในทะเบียนกลุ่มอัตโนมัติตอนบอทเข้ากลุ่ม) */
export async function getGroupName(groupId: string, channel: ChannelKey = 'hr'): Promise<string | null> {
  const client = liveApi(channel)
  if (!client) return null
  try {
    const summary = await client.getGroupSummary(groupId)
    return summary.groupName ?? null
  } catch {
    return null
  }
}

/** จำนวนสมาชิกในกลุ่ม */
export async function getGroupMemberCount(groupId: string, channel: ChannelKey = 'hr'): Promise<number | null> {
  const client = liveApi(channel)
  if (!client) return null
  try {
    const res = await client.getGroupMemberCount(groupId)
    return res.count ?? null
  } catch {
    return null
  }
}

/** ตอบกลับข้อความด้วย replyToken (ใช้ได้ครั้งเดียวและหมดอายุเร็ว) */
export async function replyText(
  replyToken: string,
  text: string,
  quickReply?: unknown,
  channel: ChannelKey = 'hr'
): Promise<SendOutcome> {
  const client = liveApi(channel)
  if (!client) return mockLog('replyText', text, channel)
  try {
    const message: Record<string, unknown> = { type: 'text', text }
    if (quickReply) message.quickReply = quickReply
    await client.replyMessage({ replyToken, messages: [message as never] })
    return { status: 'sent' }
  } catch (err) {
    return { status: 'failed', error: extractLineError(err) }
  }
}

/** ตอบกลับด้วย Flex Message (แนบ quick reply ใต้ช่องพิมพ์ได้) */
export async function replyFlex(
  replyToken: string,
  altText: string,
  contents: unknown,
  quickReply?: unknown,
  channel: ChannelKey = 'hr'
): Promise<SendOutcome> {
  const client = liveApi(channel)
  if (!client) return mockLog('replyFlex', altText, channel)
  try {
    const message: Record<string, unknown> = { type: 'flex', altText, contents }
    if (quickReply) message.quickReply = quickReply
    await client.replyMessage({ replyToken, messages: [message as never] })
    return { status: 'sent' }
  } catch (err) {
    return { status: 'failed', error: extractLineError(err) }
  }
}

/**
 * แสดงจุด "กำลังพิมพ์..." ในแชท 1:1 ระหว่างที่บอทกำลังคิด (ใช้ได้เฉพาะ chatId ที่เป็น userId)
 * LINE แสดงให้สูงสุด 60 วินาที หรือจนกว่าบอทจะส่งข้อความ ไม่กินโควตาข้อความ
 */
export async function showLoadingAnimation(userId: string, seconds = 60, channel: ChannelKey = 'hr'): Promise<void> {
  const client = liveApi(channel)
  if (!client) return
  try {
    // LINE รับเฉพาะค่า 5, 10, ..., 60
    const loadingSeconds = Math.min(60, Math.max(5, Math.round(seconds / 5) * 5))
    await client.showLoadingAnimation({ chatId: userId, loadingSeconds })
  } catch (err) {
    console.error('[Loading] แสดงสถานะกำลังพิมพ์ไม่สำเร็จ:', extractLineError(err))
  }
}

/** ข้อความ error ที่แปลว่า reply token ใช้ไม่ได้แล้ว (หมดอายุหรือถูกใช้ไปแล้ว) -> ต้องสลับไป push แทน */
export interface BotInfo {
  userId: string
  displayName: string
}

const botInfoCache: Partial<Record<ChannelKey, BotInfo | null>> = {}

/**
 * ข้อมูลของ OA เอง (userId + ชื่อที่แสดง) ใช้ตรวจว่าข้อความในกลุ่ม mention ถึงบอทหรือไม่
 * เรียก LINE ครั้งเดียวต่อ channel แล้วจำไว้ (ชื่อ OA แทบไม่เปลี่ยน) คืน null ในโหมด mock หรือเมื่อเรียกไม่ได้
 */
export async function getBotInfo(channel: ChannelKey = 'hr'): Promise<BotInfo | null> {
  if (channel in botInfoCache) return botInfoCache[channel] ?? null
  const client = liveApi(channel)
  if (!client) return null
  try {
    const info = await client.getBotInfo()
    botInfoCache[channel] = { userId: info.userId, displayName: info.displayName }
  } catch (err) {
    console.warn(`[LINE:${channel}] ดึงข้อมูลบอทไม่ได้:`, err instanceof Error ? err.message : err)
    // ไม่จำค่า null ไว้ถาวร เผื่อครั้งถัดไปเรียกได้
    return null
  }
  return botInfoCache[channel] ?? null
}

export function isReplyTokenError(error: string | undefined): boolean {
  return /reply token/i.test(error ?? '')
}

/** ดึงข้อความ error จาก LINE ให้อ่านรู้เรื่อง (ปกติซ้อนอยู่หลายชั้น) */
function extractLineError(err: unknown): string {
  if (err && typeof err === 'object') {
    const anyErr = err as Record<string, any>
    let body = anyErr.body ?? anyErr.originalError?.response?.data
    // SDK รุ่นใหม่ (HTTPFetchError) ให้ body มาเป็นข้อความ JSON ต้อง parse ก่อนจึงจะเห็นข้อความจริงจาก LINE
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body)
      } catch {
        body = undefined
      }
    }
    if (body?.message) {
      const details = Array.isArray(body.details) && body.details.length > 0
        ? ` (${body.details.map((d: any) => `${d.property}: ${d.message}`).join(', ')})`
        : ''
      return `${body.message}${details}`
    }
    if (anyErr.message) return String(anyErr.message)
  }
  return String(err)
}

// ---------------------------------------------------------------------------
// ดึงไฟล์ที่ผู้ใช้ส่ง (รูป วิดีโอ เสียง ไฟล์เอกสาร)
//
// สำคัญมาก: เอกสาร LINE ระบุว่าไฟล์ที่ผู้ใช้ส่งจะถูกลบอัตโนมัติหลังผ่านไประยะหนึ่ง
// และไม่บอกว่ากี่วัน จึงต้องเรียกฟังก์ชันนี้ทันทีที่ webhook เข้ามา
// ห้ามเก็บแค่ messageId ไว้แล้วค่อยมาโหลดวันหลัง
// ---------------------------------------------------------------------------

/** แปลง stream ที่ SDK คืนมาให้เป็น Buffer */
async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer))
  }
  return Buffer.concat(chunks)
}

export interface ContentResult {
  buffer: Buffer
  contentType: string | null
}

/**
 * ดาวน์โหลดไฟล์ต้นฉบับด้วย messageId ที่ได้จาก webhook
 *
 * ต้องใช้ token ของ OA เดียวกับที่รับ webhook นั้น: LINE ให้ดึง content ได้เฉพาะ channel ที่ได้รับข้อความ
 * (ใช้ token ของ HR ไปดึงไฟล์ที่ส่งเข้า OA ทีมซ่อมบำรุงจะได้ 404)
 */
export async function getMessageContent(messageId: string, channel: ChannelKey = 'hr'): Promise<ContentResult> {
  const blob = liveBlob(channel)
  if (!blob) {
    throw new Error('อยู่ในโหมด MOCK จึงดึงไฟล์จริงจาก LINE ไม่ได้ (ใช้ npm run seed:media เพื่อสร้างไฟล์ตัวอย่าง)')
  }
  const res = await blob.getMessageContentWithHttpInfo(messageId)
  const buffer = await streamToBuffer(res.body as unknown as NodeJS.ReadableStream)
  return { buffer, contentType: res.httpResponse.headers.get('content-type') }
}

/** ดาวน์โหลดภาพย่อของรูปหรือวิดีโอ (ขนาดเล็กกว่า ใช้ทำ thumbnail ในแกลเลอรี) */
export async function getMessageContentPreview(messageId: string, channel: ChannelKey = 'hr'): Promise<ContentResult> {
  const blob = liveBlob(channel)
  if (!blob) throw new Error('อยู่ในโหมด MOCK')
  const res = await blob.getMessageContentPreviewWithHttpInfo(messageId)
  const buffer = await streamToBuffer(res.body as unknown as NodeJS.ReadableStream)
  return { buffer, contentType: res.httpResponse.headers.get('content-type') }
}

/**
 * วิดีโอและไฟล์เสียงต้องรอ LINE แปลงไฟล์ให้เสร็จก่อนจึงจะดาวน์โหลดได้
 * คืนค่า 'succeeded' | 'processing' | 'failed'
 */
export async function getContentTranscodingStatus(messageId: string, channel: ChannelKey = 'hr'): Promise<string | null> {
  const blob = liveBlob(channel)
  if (!blob) return null
  try {
    const res = await blob.getMessageContentTranscodingByMessageId(messageId)
    return res.status ?? null
  } catch {
    return null
  }
}
