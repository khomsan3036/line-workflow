import type { WebhookEvent } from '@line/bot-sdk'
import { config } from '../config'
import {
  getBotInfo,
  getGroupMemberCount,
  getGroupMemberName,
  getGroupName,
  getUserProfileName,
  isReplyTokenError,
  showLoadingAnimation
} from '../line/client'
import { listRecentConversation, saveDirectMessage } from './directMessages'
import { upsertGroup } from './groups'
import { groupNameIfMissing, recordGroupMessage } from './groupMessages'
import { handleUnsend } from './unsend'
import { answerMaintenanceQuestion } from './maintenanceAgent'
import { buildMaintenanceCard, buildQuickReply, buildWelcomeCard, type AgentReply } from './maintenanceFlex'
import { replyAndLog, sendAndLog } from './messaging'

// ---------------------------------------------------------------------------
// webhook ของ OA ทีมซ่อมบำรุง (Maintenance Team) - POST /webhook/mt
//   - แชท 1:1: ทุกข้อความ text ส่งให้แชทบอท (Claude + MCP tool) ตอบ
//   - ในกลุ่ม: บันทึกทุกข้อความลง line_messages และเก็บไฟล์สื่อลง media_files (เหมือน OA HR)
//     แต่ตอบเฉพาะเมื่อมีคน mention บอท (กันรบกวนแชทปกติ)
//   - บันทึกคู่ถาม-ตอบลง direct_messages (channel = mt) เพื่อคุยต่อเนื่องและดูย้อนหลังใน dashboard
// ---------------------------------------------------------------------------

const CHANNEL = 'mt' as const

export const MT_WELCOME_TEXT = 'สวัสดีครับ ผมคือผู้ช่วยทีมซ่อมบำรุง QTEC ถามเรื่องงานซ่อม น้ำมัน และรถได้เลยครับ'

/** ปุ่มลัดใต้ช่องพิมพ์ (quick reply) - กดแล้ว LINE ส่งข้อความนั้นเข้ามาเหมือนพิมพ์เอง */
export const MT_QUICK_REPLY = buildQuickReply([])

const NON_TEXT_REPLY = 'ตอนนี้ผมรับเฉพาะข้อความตัวอักษรครับ พิมพ์คำถามมาได้เลย เช่น "สรุปงานซ่อมวันนี้"'

/** ส่งคำตอบ (ข้อความหรือการ์ด Flex) ด้วย reply token ก่อน ถ้าหมดอายุ (โมเดลคิดนาน) ค่อย push แทน */
async function deliver(params: {
  replyToken: string
  targetType: 'user' | 'group'
  targetId: string
  reply: AgentReply
  sentBy: string
  /** แนบ quick reply หรือไม่ (ใช้เฉพาะแชท 1:1) */
  withQuickReply: boolean
}): Promise<void> {
  const { reply } = params
  const isCard = reply.kind === 'card'
  const text = isCard ? `${reply.card.title}\n${reply.card.summary ?? ''}`.trim() : reply.text
  const contents = isCard ? buildMaintenanceCard(reply.card) : undefined
  const suggestions = isCard ? reply.card.suggestions : reply.suggestions
  const quickReply = params.withQuickReply ? buildQuickReply(suggestions) : undefined

  const sent = await replyAndLog({
    replyToken: params.replyToken,
    targetType: params.targetType,
    targetId: params.targetId,
    kind: isCard ? 'flex' : 'text',
    text,
    contents,
    quickReply,
    sentBy: params.sentBy,
    channel: CHANNEL
  })
  if (sent.status === 'failed' && isReplyTokenError(sent.error)) {
    console.warn('[MT-bot] reply token ใช้ไม่ได้แล้ว จะ push แทน')
    await sendAndLog({
      targetType: params.targetType,
      targetId: params.targetId,
      kind: isCard ? 'flex' : 'text',
      text,
      altText: text,
      contents,
      sentBy: `${params.sentBy}:push`,
      channel: CHANNEL
    })
  }
}

/**
 * ชื่อเรียกบอทที่ยอมรับเมื่อพิมพ์ "@ชื่อ" เป็นตัวอักษรธรรมดา (ไม่ได้เลือกจากรายการ mention ของ LINE)
 * ปัญหาที่พบจริง: OA ชื่อ "MT Notification" แต่การ์ดต้อนรับบอกให้พิมพ์ "@ผู้ช่วย" ซึ่ง LINE ไม่รู้จัก
 * ข้อความจึงมาแบบไม่มี mention object และบอทเงียบ -> ต้องรับแบบข้อความด้วย
 */
const BOT_ALIASES = ['ผู้ช่วย', 'บอท', 'mt notification', 'mt', 'maintenance', 'ซ่อมบำรุง']

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * ข้อความในกลุ่มที่พูดกับบอทหรือไม่ และตัดส่วนที่เรียกชื่อบอทออก (คืน null = ไม่ได้พูดกับบอท)
 *   1) mention จริงของ LINE (เลือกชื่อบอทจากรายการ @) -> mentionees[].isSelf หรือ userId ตรงกับบอท
 *   2) พิมพ์ "@ผู้ช่วย ..." / "@MT Notification ..." เป็นตัวอักษรธรรมดาไว้ต้นข้อความ
 */
export function extractAddressedText(
  message: { text: string; mention?: unknown },
  bot: { userId?: string; displayName?: string } | null
): string | null {
  const mention = message.mention as
    | { mentionees?: Array<{ index: number; length: number; isSelf?: boolean; type?: string; userId?: string }> }
    | undefined
  const self =
    mention?.mentionees?.filter((m) => m.isSelf || (bot?.userId !== undefined && m.userId === bot.userId)) ?? []
  if (self.length > 0) {
    let text = message.text
    // ตัดจากท้ายก่อน เพื่อให้ index ที่เหลือยังถูกต้อง
    for (const m of [...self].sort((a, b) => b.index - a.index)) {
      text = text.slice(0, m.index) + text.slice(m.index + m.length)
    }
    return text.replace(/\s+/g, ' ').trim()
  }

  const names = [...BOT_ALIASES, ...(bot?.displayName ? [bot.displayName] : [])]
    .map((n) => n.trim())
    .filter(Boolean)
    // ชื่อยาวก่อน ไม่ให้ "mt" ไปตัด "mt notification" ครึ่งเดียว
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|')
  const re = new RegExp(`^\\s*@\\s*(?:${names})\\s*[:,]?\\s*(.*)$`, 'is')
  const match = re.exec(message.text)
  return match ? match[1].trim() : null
}

export async function handleMaintenanceEvent(event: WebhookEvent): Promise<void> {
  // 1) เพิ่มเพื่อน -> แนะนำตัว
  if (event.type === 'follow') {
    await replyAndLog({
      replyToken: event.replyToken,
      targetId: event.source.userId,
      kind: 'flex',
      text: MT_WELCOME_TEXT,
      contents: buildWelcomeCard(false),
      quickReply: MT_QUICK_REPLY,
      sentBy: 'mt-bot:follow',
      channel: CHANNEL
    })
    console.log('[MT Follow] มีผู้ใช้เพิ่มเพื่อนกับ OA ทีมซ่อมบำรุง')
    return
  }

  // 2) ถูกเชิญเข้ากลุ่ม -> ลงทะเบียนกลุ่ม (channel = mt ให้หน้า "ส่งข้อความ" เลือก OA ถูกตัว) + บอกวิธีเรียกใช้
  if (event.type === 'join' && event.source.type === 'group') {
    const groupId = event.source.groupId
    const [groupName, memberCount] = await Promise.all([getGroupName(groupId, CHANNEL), getGroupMemberCount(groupId, CHANNEL)])
    await upsertGroup(groupId, { groupName, memberCount, isActive: true, channel: CHANNEL })
    await replyAndLog({
      replyToken: event.replyToken,
      targetType: 'group',
      targetId: event.source.groupId,
      kind: 'flex',
      text: 'สวัสดีครับ ผมคือผู้ช่วยทีมซ่อมบำรุง ในกลุ่มนี้ให้พิมพ์ @ผู้ช่วย ตามด้วยคำถาม เช่น "@ผู้ช่วย สรุปงานซ่อมวันนี้" ครับ',
      contents: buildWelcomeCard(true, (await getBotInfo(CHANNEL))?.displayName),
      sentBy: 'mt-bot:join',
      channel: CHANNEL
    })
    console.log(`[MT Join] บอทเข้าร่วมกลุ่ม ${groupId} (${groupName ?? 'ไม่ทราบชื่อ'})`)
    return
  }

  // 2.1) ถูกเชิญออกจากกลุ่ม -> ทำเครื่องหมายว่าไม่ active
  if (event.type === 'leave' && event.source.type === 'group') {
    await upsertGroup(event.source.groupId, { isActive: false, channel: CHANNEL })
    console.log(`[MT Leave] บอทออกจากกลุ่ม ${event.source.groupId}`)
    return
  }

  // 2.2) ผู้ใช้กดยกเลิกส่ง (unsend) -> ลบข้อความ/ไฟล์ที่เก็บไว้ ตามข้อกำหนดของ LINE
  if (event.type === 'unsend') {
    await handleUnsend(event.unsend.messageId)
    return
  }

  // 3) postback จาก Rich Menu: data=q=<คำถาม> ให้ถือเป็นคำถาม
  if (event.type === 'postback') {
    const params = new URLSearchParams(event.postback.data)
    const question = params.get('q')
    const userId = event.source.userId
    if (!question || !userId) return
    await answerAndReply({
      replyToken: event.replyToken,
      userId,
      groupId: event.source.type === 'group' ? event.source.groupId : null,
      text: question,
      lineMessageId: `postback-${event.webhookEventId ?? event.timestamp}`,
      timestamp: event.timestamp
    })
    return
  }

  if (event.type !== 'message') return

  // 4) ในกลุ่ม: จำกลุ่มไว้ในทะเบียน (เผื่อบอทถูกเชิญเข้ากลุ่มก่อนที่ระบบจะรัน) แล้วบันทึกทุกข้อความลง line_messages
  //    และเก็บไฟล์สื่อลง media_files เช่นเดียวกับ OA HR (ทำก่อนตรวจ userId เพราะข้อความจากผู้ใช้ที่ไม่เปิดเผยตัว
  //    ก็ต้องถูกบันทึกเหมือนกัน)
  if (event.source.type === 'group') {
    const groupId = event.source.groupId
    const known = await groupNameIfMissing(groupId, CHANNEL)
    await recordGroupMessage(event, groupId, CHANNEL, { isActive: true, groupName: known })
  }

  const userId = event.source.userId
  if (!userId) return

  // 5) แชท 1:1
  if (event.source.type === 'user') {
    if (event.message.type !== 'text') {
      await deliver({
        replyToken: event.replyToken,
        targetType: 'user',
        targetId: userId,
        reply: { kind: 'text', text: NON_TEXT_REPLY, suggestions: [] },
        sentBy: 'mt-bot:non-text',
        withQuickReply: true
      })
      await saveDirectMessage({
        lineMessageId: event.message.id,
        userId,
        displayName: await getUserProfileName(userId, CHANNEL),
        messageType: event.message.type,
        messageText: null,
        replyText: NON_TEXT_REPLY,
        replyMatched: false,
        sentAt: new Date(event.timestamp),
        channel: CHANNEL
      })
      return
    }
    await answerAndReply({
      replyToken: event.replyToken,
      userId,
      groupId: null,
      text: event.message.text,
      lineMessageId: event.message.id,
      timestamp: event.timestamp
    })
    return
  }

  // 6) ในกลุ่ม: ตอบเฉพาะเมื่อถูก mention (กันรบกวนแชทปกติ)
  if (event.source.type === 'group' && event.message.type === 'text') {
    const text = extractAddressedText(event.message, await getBotInfo(CHANNEL))
    if (text === null) return
    await answerAndReply({
      replyToken: event.replyToken,
      userId,
      groupId: event.source.groupId,
      text: text || 'สรุปภาพรวมวันนี้',
      lineMessageId: event.message.id,
      timestamp: event.timestamp
    })
  }
}

async function answerAndReply(params: {
  replyToken: string
  userId: string
  groupId: string | null
  text: string
  lineMessageId: string
  timestamp: number
}): Promise<void> {
  const { replyToken, userId, groupId, text } = params
  const targetType = groupId ? 'group' : 'user'
  const targetId = groupId ?? userId
  const started = Date.now()

  // แสดง "กำลังพิมพ์..." ระหว่างคิด (ใช้ได้เฉพาะแชท 1:1)
  if (!groupId) void showLoadingAnimation(userId, 60, CHANNEL)

  const [displayName, history] = await Promise.all([
    groupId ? getGroupMemberName(groupId, userId, CHANNEL) : getUserProfileName(userId, CHANNEL),
    listRecentConversation(
      userId,
      CHANNEL,
      config.maintenance.historyPairs,
      config.maintenance.historyMaxAgeMinutes,
      groupId
    ).catch((err) => {
      console.error('[MT-bot] อ่านประวัติสนทนาไม่ได้:', err instanceof Error ? err.message : err)
      return []
    })
  ])

  const answer = await answerMaintenanceQuestion({ userId, displayName, text, history, groupId })
  const elapsed = ((Date.now() - started) / 1000).toFixed(1)
  console.log(
    `[MT-bot] "${text.slice(0, 80)}" -> ${answer.failed ? 'ล้มเหลว' : 'ตอบแล้ว'} (${elapsed}s, tools: ${
      answer.toolsUsed.join(', ') || '-'
    })`
  )

  await deliver({
    replyToken,
    targetType,
    targetId,
    reply: answer.reply,
    sentBy: answer.failed ? 'mt-bot:error' : 'mt-bot:answer',
    withQuickReply: !groupId
  })

  await saveDirectMessage({
    lineMessageId: params.lineMessageId,
    userId,
    displayName,
    messageType: 'text',
    messageText: text,
    // คำตอบที่ล้มเหลวไม่เก็บเป็นประวัติสนทนา (reply_text = NULL) จะได้ไม่ถูกส่งให้โมเดลรอบหน้า
    replyText: answer.failed ? null : answer.text,
    replyMatched: !answer.failed,
    sentAt: new Date(params.timestamp),
    channel: CHANNEL,
    groupId
  })
}
