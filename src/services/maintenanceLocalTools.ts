import { listActiveGroups } from './groups'
import { alertToText, buildAlertCard, normalizeAlert, type GroupAlert } from './maintenanceFlex'
import type { McpToolInfo } from './maintenanceMcp'
import { sendAndLog } from './messaging'

// ---------------------------------------------------------------------------
// tool ฝั่งแอป (ไม่ได้มาจาก MCP) ที่ให้โมเดลของแชทบอทซ่อมบำรุงเรียกได้
//   notify_line_group : ส่งการ์ดแจ้งเตือนเข้าไลน์กลุ่มที่บอท MT อยู่ ผ่าน OA ของเราเอง
//                       (บันทึกใน message_logs และเห็นใน dashboard เหมือนข้อความส่งออกอื่น ๆ)
// ทำไมไม่ใช้ Send* ของ MCP: ตัวนั้นส่งเข้าคิว RabbitMQ / ผู้รับที่ตั้งไว้ฝั่งเซิร์ฟเวอร์ ซึ่งเราไม่รู้ว่าไปถึงกลุ่มไหน
// ---------------------------------------------------------------------------

export const NOTIFY_GROUP_TOOL = 'notify_line_group'

export const LOCAL_TOOLS: McpToolInfo[] = [
  {
    name: NOTIFY_GROUP_TOOL,
    description:
      'ส่งการ์ดแจ้งเตือนเข้าไลน์กลุ่มของทีมซ่อมบำรุง (ผ่าน LINE OA ของบอทเอง) ใช้เมื่อผู้ใช้แจ้งเรื่อง/ยื่นคำขอ ' +
      'หรือสั่งให้ "แจ้ง/ประกาศ/ส่งเข้ากลุ่ม" ระบบจะแนบชื่อผู้แจ้งและเวลาให้เอง คืนรายชื่อกลุ่มที่ส่งถึงและสถานะ',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'หัวเรื่องสั้น ๆ ไม่เกิน 60 ตัวอักษร เช่น "แจ้งซ่อมด่วน รถบัส Hino"' },
        message: { type: 'string', description: 'รายละเอียดที่ทีมต้องรู้ 1-3 ประโยค (อาการ สถานที่ ต้องการภายในเมื่อไร)' },
        severity: { type: 'string', enum: ['urgent', 'warning', 'info'], description: 'urgent = ต้องทำทันที, warning = ควรจัดการเร็ว, info = แจ้งทราบ' },
        details: {
          type: 'array',
          description:
            'รายละเอียดแบบ หัวข้อ/ค่า (ไม่บังคับ) แสดงเป็นตารางอ่านง่าย เช่น [{"label":"รถ","value":"VH-07 Hilux"},{"label":"ปลายทาง","value":"ระยอง"}]',
          items: {
            type: 'object',
            properties: { label: { type: 'string' }, value: { type: 'string' } },
            required: ['label', 'value']
          }
        },
        items: { type: 'array', items: { type: 'string' }, description: 'รายการย่อยแบบข้อความอิสระ (ไม่บังคับ) เช่น สิ่งที่ต้องเตรียม' },
        reference: { type: 'string', description: 'เลขอ้างอิง เช่น เลขที่งานซ่อม ทะเบียนรถ (ไม่บังคับ)' },
        group: { type: 'string', description: 'ชื่อกลุ่มบางส่วน เมื่อต้องการส่งเฉพาะกลุ่มนั้น (ไม่ระบุ = ทุกกลุ่มที่บอทอยู่)' }
      },
      required: ['title', 'message', 'severity']
    }
  }
]

export function isLocalTool(name: string): boolean {
  return LOCAL_TOOLS.some((t) => t.name === name)
}

export interface GroupPushResult {
  group: string
  groupId: string
  status: string
  error?: string
}

/**
 * ส่งการ์ดแจ้งเตือนเข้าทุกกลุ่มที่บอท MT อยู่ (ใช้ร่วมกันระหว่าง tool ในแชทและ consumer ของ RabbitMQ)
 * filter = ชื่อกลุ่มบางส่วน หรือ groupId ตรง ๆ (ไม่ระบุ = ทุกกลุ่ม)
 */
export async function pushAlertToGroups(
  alert: GroupAlert,
  sentBy: string,
  filter?: string | null
): Promise<{ targets: number; sent: GroupPushResult[]; availableGroups: string[] }> {
  const groups = await listActiveGroups('mt')
  const needle = (filter ?? '').trim().toLowerCase()
  const targets = needle
    ? groups.filter((g) => g.group_id.toLowerCase() === needle || (g.group_name ?? '').toLowerCase().includes(needle))
    : groups
  const availableGroups = groups.map((g) => g.group_name ?? g.group_id)
  if (targets.length === 0) return { targets: 0, sent: [], availableGroups }

  const contents = buildAlertCard(alert)
  const altText = alertToText(alert).slice(0, 400)
  const sent: GroupPushResult[] = []
  for (const g of targets) {
    const result = await sendAndLog({
      targetType: 'group',
      targetId: g.group_id,
      targetName: g.group_name ?? undefined,
      kind: 'flex',
      altText,
      contents,
      sentBy,
      channel: 'mt'
    })
    sent.push({ group: g.group_name ?? g.group_id, groupId: g.group_id, status: result.status, error: result.error })
  }
  return { targets: targets.length, sent, availableGroups }
}

export async function callLocalTool(
  name: string,
  args: Record<string, unknown>,
  ctx: { requestedBy: string; displayName: string | null }
): Promise<{ text: string; isError: boolean }> {
  if (name !== NOTIFY_GROUP_TOOL) return { text: `ไม่รู้จัก tool ${name}`, isError: true }

  const filter = typeof args.group === 'string' ? args.group : ''
  const alert = normalizeAlert(args, ctx.displayName ?? ctx.requestedBy)
  const { targets, sent, availableGroups } = await pushAlertToGroups(alert, `mt-bot:alert:${ctx.requestedBy}`, filter)
  if (targets === 0) {
    return {
      text: JSON.stringify({
        success: false,
        error: filter
          ? `ไม่พบกลุ่มที่ชื่อมีคำว่า "${filter}" ที่บอทอยู่ (กลุ่มที่มี: ${availableGroups.join(', ') || 'ไม่มี'})`
          : 'บอทยังไม่ได้อยู่ในไลน์กลุ่มใดเลย ให้เชิญ OA "MT Notification" เข้ากลุ่มก่อน'
      }),
      isError: true
    }
  }
  const ok = sent.filter((s) => s.status === 'sent' || s.status === 'mock')
  return {
    text: JSON.stringify({ success: ok.length > 0, sent, alert_text: alertToText(alert) }),
    isError: ok.length === 0
  }
}
