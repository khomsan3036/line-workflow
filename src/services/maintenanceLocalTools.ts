import { config } from '../config'
import { getGroup, listActiveGroups } from './groups'
import { alertToText, buildAlertCard, normalizeAlert, type GroupAlert } from './maintenanceFlex'
import type { McpToolInfo } from './maintenanceMcp'
import { sendAndLog } from './messaging'

// ---------------------------------------------------------------------------
// tool ฝั่งแอป (ไม่ได้มาจาก MCP) ที่ให้โมเดลของแชทบอทซ่อมบำรุงเรียกได้
//   notify_line_group : ส่งการ์ดแจ้งเตือนเข้าไลน์กลุ่มของทีมซ่อมบำรุง (listMaintenanceGroups) ผ่าน OA ของเราเอง
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
        group: {
          type: 'string',
          description: 'ชื่อกลุ่มบางส่วน เฉพาะเมื่อผู้ใช้ระบุชื่อกลุ่มเอง (ไม่ระบุ = ส่งเข้ากลุ่มของทีมซ่อมบำรุง; ถ้าถามจากในกลุ่มของทีมซ่อมบำรุงเองจะส่งเฉพาะกลุ่มนั้น)'
        }
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

export interface MaintenanceGroup {
  group_id: string
  group_name: string | null
}

/**
 * ชื่อกลุ่มมีคำใดคำหนึ่งใน MT_GROUP_KEYWORDS หรือไม่ (ไม่สนตัวพิมพ์เล็กใหญ่)
 * คำภาษาอังกฤษ/ตัวเลขต้องเป็นคำเต็ม (มีช่องว่าง เครื่องหมาย หรืออักษรไทยคั่น) เพื่อไม่ให้ "MT" ไปตรงกับ "Comtech"
 * ส่วนคำไทยไม่มีช่องว่างคั่นคำอยู่แล้ว จึงเทียบแบบมีคำนั้นอยู่ในชื่อ
 */
export function isMaintenanceGroupName(name: string | null, keywords: string[] = config.maintenance.groupKeywords): boolean {
  const lower = (name ?? '').toLowerCase()
  if (lower === '') return false
  return keywords.some((raw) => {
    const k = raw.trim().toLowerCase()
    if (k === '') return false
    if (!/^[a-z0-9]+$/.test(k)) return lower.includes(k)
    return new RegExp(`(?<![a-z0-9])${k}(?![a-z0-9])`).test(lower)
  })
}

/**
 * กลุ่มปลายทางของทีมซ่อมบำรุง (ใช้ร่วมกันระหว่าง notify_line_group, consumer ของ RabbitMQ และรายงาน MT)
 *   1) MT_ALERT_GROUP_IDS / MT_REPORT_GROUP_IDS ตั้งไว้ -> เฉพาะ id เหล่านั้น (ชื่อดึงจากทะเบียนถ้ามี)
 *   2) ไม่ได้ตั้ง -> เฉพาะกลุ่มที่บอทอยู่และชื่อมีคำใน MT_GROUP_KEYWORDS (MT / ซ่อมบำรุง / maintenance)
 * ไม่มีกลุ่มไหนชื่อตรงเลย = ไม่ส่ง (คืนรายการว่าง) ไม่ถอยไปส่งทุกกลุ่มที่บอทอยู่ แม้จะมี OA MT แยก
 * เพราะ OA MT ถูกเชิญเข้ากลุ่มอื่นที่ไม่ใช่ทีมช่างได้ และการ์ดแจ้งซ่อมไม่ควรไปรบกวนกลุ่มเหล่านั้น
 */
export async function listMaintenanceGroups(): Promise<MaintenanceGroup[]> {
  const groups = await listActiveGroups(config.maintenance.channel)
  const ids = config.maintenance.alertGroupIds
  if (ids.length > 0) {
    return ids.map((id) => ({ group_id: id, group_name: groups.find((g) => g.group_id === id)?.group_name ?? null }))
  }
  return groups.filter((g) => isMaintenanceGroupName(g.group_name))
}

/**
 * ส่งการ์ดแจ้งเตือนเข้ากลุ่มของทีมซ่อมบำรุง (ดู listMaintenanceGroups) ใช้ร่วมกันระหว่าง tool ในแชทและ consumer ของ RabbitMQ
 * filter = groupId ตรง ๆ (ส่งได้ทุกกลุ่มที่บอทอยู่ เพราะเป็นการระบุปลายทางชัดเจน เช่น AlertNotifications:GroupId ของ MCP)
 *          หรือชื่อกลุ่มบางส่วน (ค้นเฉพาะในกลุ่มของทีมซ่อมบำรุง)   ไม่ระบุ = ทุกกลุ่มของทีมซ่อมบำรุง
 */
export async function pushAlertToGroups(
  alert: GroupAlert,
  sentBy: string,
  filter?: string | null
): Promise<{ targets: number; sent: GroupPushResult[]; availableGroups: string[] }> {
  const pool = await listMaintenanceGroups()
  const needle = (filter ?? '').trim().toLowerCase()
  let targets: MaintenanceGroup[] = pool
  if (needle) {
    targets = pool.filter((g) => g.group_id.toLowerCase() === needle || (g.group_name ?? '').toLowerCase().includes(needle))
    if (targets.length === 0 && /^c[0-9a-f]{32}$/.test(needle)) {
      targets = (await listActiveGroups(config.maintenance.channel)).filter((g) => g.group_id.toLowerCase() === needle)
    }
  }
  const availableGroups = pool.map((g) => g.group_name ?? g.group_id)
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
      channel: config.maintenance.channel
    })
    sent.push({ group: g.group_name ?? g.group_id, groupId: g.group_id, status: result.status, error: result.error })
  }
  return { targets: targets.length, sent, availableGroups }
}

export async function callLocalTool(
  name: string,
  args: Record<string, unknown>,
  ctx: { requestedBy: string; displayName: string | null; groupId?: string | null }
): Promise<{ text: string; isError: boolean }> {
  if (name !== NOTIFY_GROUP_TOOL) return { text: `ไม่รู้จัก tool ${name}`, isError: true }

  // บอทตัวเดียวอยู่ทั้งกลุ่ม HR และกลุ่มช่าง การ์ดแจ้งซ่อมต้องไปถึงทีมซ่อมบำรุงเสมอ ไม่ใช่กลุ่มที่ผู้ใช้บังเอิญถามมา
  //   ถามจากในกลุ่มของทีมซ่อมบำรุงเอง -> ส่งเฉพาะกลุ่มนั้น (ไม่กระจายไปกลุ่มช่างอื่น)
  //   ถามจากกลุ่มอื่น (เช่นกลุ่ม HR) หรือ 1:1 -> ส่งเข้ากลุ่มของทีมซ่อมบำรุงทุกกลุ่ม (listMaintenanceGroups)
  //   ผู้ใช้ระบุชื่อกลุ่มเอง -> ค้นชื่อนั้นเฉพาะในกลุ่มของทีมซ่อมบำรุง
  // (โมเดลมักใส่ชื่อกลุ่มที่กำลังคุยอยู่มาใน group ถ้าชื่อนั้นคือกลุ่มต้นทางก็ให้ถือว่าไม่ได้ระบุ)
  const wanted = typeof args.group === 'string' ? args.group.trim() : ''
  let filter = wanted
  if (ctx.groupId) {
    const origin = await getGroup(ctx.groupId)
    const originName = (origin?.group_name ?? '').toLowerCase()
    const needle = wanted.toLowerCase()
    const sameGroup =
      needle === '' || needle === ctx.groupId.toLowerCase() || (originName !== '' && (originName.includes(needle) || needle.includes(originName)))
    if (sameGroup) {
      const pool = await listMaintenanceGroups()
      filter = pool.some((g) => g.group_id === ctx.groupId) ? ctx.groupId : ''
    }
  }
  const alert = normalizeAlert(args, ctx.displayName ?? ctx.requestedBy)
  const { targets, sent, availableGroups } = await pushAlertToGroups(alert, `mt-bot:alert:${ctx.requestedBy}`, filter)
  if (targets === 0) {
    return {
      text: JSON.stringify({
        success: false,
        error: filter
          ? `ไม่พบกลุ่มทีมซ่อมบำรุงที่ชื่อมีคำว่า "${filter}" (กลุ่มที่มี: ${availableGroups.join(', ') || 'ไม่มี'})`
          : 'ยังไม่มีกลุ่มทีมซ่อมบำรุงให้ส่ง: เชิญบอทเข้ากลุ่มที่ชื่อมีคำว่า MT/ซ่อมบำรุง หรือตั้ง MT_ALERT_GROUP_IDS'
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
