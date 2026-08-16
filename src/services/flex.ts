// ---------------------------------------------------------------------------
// ตัวช่วยสร้าง Flex Message
// ทุกฟังก์ชันคืนค่าเป็น plain object ตามสเปกของ LINE
// ทดลองแก้ดีไซน์ได้ที่ https://developers.line.biz/flex-simulator/
// ---------------------------------------------------------------------------

const LINE_GREEN = '#06C755'
const NAVY = '#0C1628'
const RED = '#C8281E'
const AMBER = '#D97706'
const GRAY = '#8A94A6'

function textRow(label: string, value: string, valueColor = '#111827') {
  return {
    type: 'box',
    layout: 'horizontal',
    spacing: 'sm',
    contents: [
      { type: 'text', text: label, size: 'sm', color: GRAY, flex: 4, wrap: true },
      { type: 'text', text: value, size: 'sm', color: valueColor, flex: 5, align: 'end', wrap: true, weight: 'bold' }
    ]
  }
}

function header(title: string, subtitle: string, color: string) {
  return {
    type: 'box',
    layout: 'vertical',
    backgroundColor: color,
    paddingAll: '16px',
    contents: [
      { type: 'text', text: title, color: '#FFFFFF', weight: 'bold', size: 'lg', wrap: true },
      { type: 'text', text: subtitle, color: '#E5E7EB', size: 'xs', margin: 'xs', wrap: true }
    ]
  }
}

/** รายงานสรุปแชทกลุ่มประจำวัน (Workshop 4) */
export function flexDailySummary(input: {
  groupName: string
  dateLabel: string
  messageCount: number
  topTalkers: { name: string; count: number }[]
  topics: string[]
  tasks: { assignee: string; task: string; due?: string }[]
}) {
  const topicItems = input.topics.slice(0, 5).map((t, i) => ({
    type: 'text',
    text: `${i + 1}. ${t}`,
    size: 'sm',
    wrap: true,
    color: '#111827',
    margin: 'xs'
  }))

  const taskItems = input.tasks.slice(0, 6).map((t) => ({
    type: 'box',
    layout: 'baseline',
    spacing: 'sm',
    margin: 'xs',
    contents: [
      { type: 'text', text: '•', size: 'sm', color: LINE_GREEN, flex: 0 },
      {
        type: 'text',
        text: `${t.assignee}: ${t.task}${t.due ? ` (${t.due})` : ''}`,
        size: 'sm',
        wrap: true,
        color: '#111827'
      }
    ]
  }))

  return {
    type: 'bubble',
    size: 'mega',
    header: header('สรุปประชุมกลุ่มวันนี้', `${input.groupName} · ${input.dateLabel}`, NAVY),
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'md',
      paddingAll: '16px',
      contents: [
        textRow('จำนวนข้อความ', `${input.messageCount.toLocaleString('th-TH')} ข้อความ`),
        ...(input.topTalkers.length > 0
          ? [
              { type: 'separator', margin: 'md' },
              { type: 'text', text: 'คนที่คุยมากที่สุด', size: 'xs', color: GRAY, margin: 'md' },
              ...input.topTalkers.slice(0, 3).map((p, i) =>
                textRow(`${i + 1}. ${p.name}`, `${p.count} ข้อความ`)
              )
            ]
          : []),
        ...(topicItems.length > 0
          ? [
              { type: 'separator', margin: 'md' },
              { type: 'text', text: 'ประเด็นสำคัญ', size: 'xs', color: GRAY, margin: 'md' },
              ...topicItems
            ]
          : []),
        ...(taskItems.length > 0
          ? [
              { type: 'separator', margin: 'md' },
              { type: 'text', text: 'งานที่มีคนรับไปทำ', size: 'xs', color: GRAY, margin: 'md' },
              ...taskItems
            ]
          : [])
      ]
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '12px',
      contents: [
        {
          type: 'text',
          text: 'สร้างอัตโนมัติโดย AI Agent · ข้อมูลจากบทสนทนาในกลุ่มนี้',
          size: 'xxs',
          color: GRAY,
          align: 'center',
          wrap: true
        }
      ]
    }
  }
}

/** ประกาศภายในองค์กร / งาน HR (Workshop 1) */
export function flexAnnouncement(input: {
  title: string
  category: string
  body: string
  bullets?: string[]
  buttonLabel?: string
  buttonUrl?: string
}) {
  const bullets = (input.bullets ?? []).filter((b) => b.trim() !== '')
  return {
    type: 'bubble',
    header: header(input.title, input.category, LINE_GREEN),
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'md',
      paddingAll: '16px',
      contents: [
        { type: 'text', text: input.body, size: 'sm', wrap: true, color: '#111827' },
        ...(bullets.length > 0
          ? [
              { type: 'separator', margin: 'md' },
              ...bullets.map((b) => ({
                type: 'box',
                layout: 'baseline',
                spacing: 'sm',
                margin: 'sm',
                contents: [
                  { type: 'text', text: '•', size: 'sm', color: LINE_GREEN, flex: 0 },
                  { type: 'text', text: b, size: 'sm', wrap: true, color: '#374151' }
                ]
              }))
            ]
          : [])
      ]
    },
    ...(input.buttonLabel && input.buttonUrl
      ? {
          footer: {
            type: 'box',
            layout: 'vertical',
            paddingAll: '12px',
            contents: [
              {
                type: 'button',
                style: 'primary',
                color: LINE_GREEN,
                action: { type: 'uri', label: input.buttonLabel, uri: input.buttonUrl }
              }
            ]
          }
        }
      : {})
  }
}

/** รายงานผู้บริหารประจำวัน (Capstone) */
export function flexExecutiveReport(input: {
  dateLabel: string
  totalAmount: number
  orderCount: number
  avgOrder: number
  changePct: number | null
  branches: { branch: string; amount: number }[]
  channels: { channel: string; amount: number }[]
  anomalies: { title: string; detail: string }[]
  /** ข้อความท้ายการ์ด เช่น "รายงานอัตโนมัติ · ส่งทุกเช้า 08:00 น." */
  footerNote?: string
}) {
  const money = (n: number) => `${Math.round(n).toLocaleString('th-TH')} บาท`
  const changeText =
    input.changePct === null
      ? 'ไม่มีข้อมูลเปรียบเทียบ'
      : `${input.changePct >= 0 ? '▲' : '▼'} ${Math.abs(input.changePct).toFixed(1)}% เทียบวันก่อน`
  const changeColor = input.changePct === null ? GRAY : input.changePct >= 0 ? '#0F8B5E' : RED

  return {
    type: 'bubble',
    size: 'mega',
    header: header('รายงานยอดขายประจำวัน', `สยามสมาร์ทเทรด · ข้อมูลวันที่ ${input.dateLabel}`, NAVY),
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'md',
      paddingAll: '16px',
      contents: [
        { type: 'text', text: money(input.totalAmount), size: 'xxl', weight: 'bold', color: NAVY },
        { type: 'text', text: changeText, size: 'xs', color: changeColor },
        { type: 'separator', margin: 'md' },
        textRow('จำนวนบิล', `${input.orderCount.toLocaleString('th-TH')} บิล`),
        textRow('ยอดเฉลี่ยต่อบิล', money(input.avgOrder)),
        { type: 'separator', margin: 'md' },
        { type: 'text', text: 'ยอดขายตามสาขา', size: 'xs', color: GRAY, margin: 'md' },
        ...input.branches.slice(0, 5).map((b) => textRow(b.branch, money(b.amount))),
        { type: 'separator', margin: 'md' },
        { type: 'text', text: 'ยอดขายตามช่องทาง', size: 'xs', color: GRAY, margin: 'md' },
        ...input.channels.slice(0, 5).map((c) => textRow(c.channel, money(c.amount))),
        ...(input.anomalies.length > 0
          ? [
              {
                type: 'box',
                layout: 'vertical',
                margin: 'lg',
                paddingAll: '12px',
                cornerRadius: '8px',
                backgroundColor: '#FEF2F2',
                borderWidth: '1px',
                borderColor: RED,
                contents: [
                  {
                    type: 'text',
                    text: `พบรายการผิดปกติ ${input.anomalies.length} รายการ`,
                    size: 'sm',
                    weight: 'bold',
                    color: RED
                  },
                  ...input.anomalies.slice(0, 5).map((a) => ({
                    type: 'text',
                    text: `• ${a.title} - ${a.detail}`,
                    size: 'xs',
                    color: '#7F1D1D',
                    wrap: true,
                    margin: 'sm'
                  }))
                ]
              }
            ]
          : [
              {
                type: 'box',
                layout: 'vertical',
                margin: 'lg',
                paddingAll: '10px',
                cornerRadius: '8px',
                backgroundColor: '#ECFDF5',
                contents: [
                  { type: 'text', text: 'ไม่พบรายการผิดปกติ', size: 'xs', color: '#065F46', align: 'center' }
                ]
              }
            ])
      ]
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '12px',
      contents: [
        {
          type: 'text',
          text: input.footerNote ?? 'รายงานอัตโนมัติ · ข้อมูลจำลองเพื่อการอบรม',
          size: 'xxs',
          color: GRAY,
          align: 'center',
          wrap: true
        }
      ]
    }
  }
}

/** การ์ดเตือนงานค้าง (ใช้จากหน้า Tasks) */
export function flexTaskReminder(input: {
  groupName: string
  tasks: { assignee: string; task: string; due?: string }[]
}) {
  return {
    type: 'bubble',
    header: header('เตือนงานค้าง', input.groupName, AMBER),
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      paddingAll: '16px',
      contents:
        input.tasks.length === 0
          ? [{ type: 'text', text: 'ไม่มีงานค้างแล้ว เยี่ยมมาก', size: 'sm', color: '#065F46' }]
          : input.tasks.slice(0, 10).map((t, i) => ({
              type: 'box',
              layout: 'baseline',
              spacing: 'sm',
              contents: [
                { type: 'text', text: `${i + 1}.`, size: 'sm', color: AMBER, flex: 0 },
                {
                  type: 'text',
                  text: `${t.assignee}: ${t.task}${t.due ? ` (${t.due})` : ''}`,
                  size: 'sm',
                  wrap: true,
                  color: '#111827'
                }
              ]
            }))
    }
  }
}
