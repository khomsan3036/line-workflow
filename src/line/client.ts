import { messagingApi } from '@line/bot-sdk'
import { config } from '../config'

// ---------------------------------------------------------------------------
// ห่อ LINE Messaging API ไว้ชั้นเดียว เพื่อ
//   1) รองรับโหมด MOCK (ไม่ยิง API จริง) ให้ทดสอบ dashboard ได้โดยไม่ต้องมี OA
//   2) รวมการจัดการ error ไว้ที่เดียว ไม่ต้อง try/catch กระจายทั้งโปรเจกต์
// ---------------------------------------------------------------------------

const { MessagingApiClient, MessagingApiBlobClient } = messagingApi

export const lineClient = config.channelAccessToken
  ? new MessagingApiClient({ channelAccessToken: config.channelAccessToken })
  : null

// client แยกสำหรับดึงไฟล์ เพราะใช้คนละโดเมน (api-data.line.me)
export const lineBlobClient = config.channelAccessToken
  ? new MessagingApiBlobClient({ channelAccessToken: config.channelAccessToken })
  : null

export type SendStatus = 'sent' | 'mock' | 'failed'

export interface SendOutcome {
  status: SendStatus
  error?: string
}

function mockLog(action: string, detail: unknown): SendOutcome {
  console.log(`[MOCK LINE] ${action}`, typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 300))
  return { status: 'mock' }
}

/** ส่งข้อความ text เข้ากลุ่มหรือถึงผู้ใช้ (to = groupId หรือ userId) */
export async function pushText(to: string, text: string): Promise<SendOutcome> {
  if (config.mockLine || !lineClient) return mockLog(`pushText -> ${to}`, text)
  try {
    await lineClient.pushMessage({ to, messages: [{ type: 'text', text }] })
    return { status: 'sent' }
  } catch (err) {
    return { status: 'failed', error: extractLineError(err) }
  }
}

/** ส่ง Flex Message (contents = JSON ของ bubble หรือ carousel) */
export async function pushFlex(to: string, altText: string, contents: unknown): Promise<SendOutcome> {
  if (config.mockLine || !lineClient) return mockLog(`pushFlex -> ${to} (${altText})`, contents)
  try {
    await lineClient.pushMessage({
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
export async function getGroupMemberName(groupId: string, userId: string): Promise<string | null> {
  if (config.mockLine || !lineClient) return null
  try {
    const profile = await lineClient.getGroupMemberProfile(groupId, userId)
    return profile.displayName ?? null
  } catch (err) {
    console.error('[Profile] ดึงชื่อผู้ส่งไม่สำเร็จ:', extractLineError(err))
    return null
  }
}

/** จำนวนสมาชิกในกลุ่ม */
export async function getGroupMemberCount(groupId: string): Promise<number | null> {
  if (config.mockLine || !lineClient) return null
  try {
    const res = await lineClient.getGroupMemberCount(groupId)
    return res.count ?? null
  } catch {
    return null
  }
}

/** ตอบกลับข้อความด้วย replyToken (ใช้ได้ครั้งเดียวและหมดอายุเร็ว) */
export async function replyText(replyToken: string, text: string): Promise<SendOutcome> {
  if (config.mockLine || !lineClient) return mockLog('replyText', text)
  try {
    await lineClient.replyMessage({ replyToken, messages: [{ type: 'text', text }] })
    return { status: 'sent' }
  } catch (err) {
    return { status: 'failed', error: extractLineError(err) }
  }
}

/** ดึงข้อความ error จาก LINE ให้อ่านรู้เรื่อง (ปกติซ้อนอยู่หลายชั้น) */
function extractLineError(err: unknown): string {
  if (err && typeof err === 'object') {
    const anyErr = err as Record<string, any>
    const body = anyErr.body ?? anyErr.originalError?.response?.data
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

/** ดาวน์โหลดไฟล์ต้นฉบับด้วย messageId ที่ได้จาก webhook */
export async function getMessageContent(messageId: string): Promise<ContentResult> {
  if (config.mockLine || !lineBlobClient) {
    throw new Error('อยู่ในโหมด MOCK จึงดึงไฟล์จริงจาก LINE ไม่ได้ (ใช้ npm run seed:media เพื่อสร้างไฟล์ตัวอย่าง)')
  }
  const res = await lineBlobClient.getMessageContentWithHttpInfo(messageId)
  const buffer = await streamToBuffer(res.body as unknown as NodeJS.ReadableStream)
  return { buffer, contentType: res.httpResponse.headers.get('content-type') }
}

/** ดาวน์โหลดภาพย่อของรูปหรือวิดีโอ (ขนาดเล็กกว่า ใช้ทำ thumbnail ในแกลเลอรี) */
export async function getMessageContentPreview(messageId: string): Promise<ContentResult> {
  if (config.mockLine || !lineBlobClient) throw new Error('อยู่ในโหมด MOCK')
  const res = await lineBlobClient.getMessageContentPreviewWithHttpInfo(messageId)
  const buffer = await streamToBuffer(res.body as unknown as NodeJS.ReadableStream)
  return { buffer, contentType: res.httpResponse.headers.get('content-type') }
}

/**
 * วิดีโอและไฟล์เสียงต้องรอ LINE แปลงไฟล์ให้เสร็จก่อนจึงจะดาวน์โหลดได้
 * คืนค่า 'succeeded' | 'processing' | 'failed'
 */
export async function getContentTranscodingStatus(messageId: string): Promise<string | null> {
  if (config.mockLine || !lineBlobClient) return null
  try {
    const res = await lineBlobClient.getMessageContentTranscodingByMessageId(messageId)
    return res.status ?? null
  } catch {
    return null
  }
}
