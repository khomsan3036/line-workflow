// ---------------------------------------------------------------------------
// ตอบกลับอัตโนมัติสำหรับแชท 1:1 กับ Official Account (Workshop 2)
//
// Rich Menu ที่สร้างใน Workshop 2 ใช้ action ชนิด "message" เป็นหลัก
// คือพอผู้ใช้กดปุ่ม LINE จะส่งข้อความนั้นเข้ามาที่ webhook เหมือนผู้ใช้พิมพ์เอง
// ไฟล์นี้คือฝั่งที่ "ฟัง" ข้อความเหล่านั้นแล้วตอบกลับ
//
// ทำไมต้องแยกไฟล์: ผู้เรียนจะได้แก้เมนู/คำตอบที่เดียว ไม่ต้องไปยุ่งกับ webhook.ts
// อยากเพิ่มปุ่มใหม่ ก็เพิ่ม 1 รายการใน MENU_REPLIES แล้วเพิ่มช่องใน Rich Menu ให้ตรงกัน
// ---------------------------------------------------------------------------

/** ประกาศภายในองค์กร (ของจริงควรดึงจากฐานข้อมูลหรือ intranet) */
const ANNOUNCEMENTS = [
  'วันหยุดพิเศษ 10 ส.ค. 2569',
  'รับสมัครงานภายใน 2 ตำแหน่ง',
  'อบรมความปลอดภัย 15 ส.ค.'
]

const INTERNAL_CONTACTS = [
  ['ฝ่ายบุคคล (HR)', '101'],
  ['ฝ่ายจัดซื้อ', '102'],
  ['คลังสินค้า', '103'],
  ['ฝ่ายจัดส่ง', '104'],
  ['ไอที (แจ้งปัญหาระบบ)', '105']
]

export interface MenuReply {
  /** คีย์ที่ใช้กับ action ชนิด postback (data = menu=<key>) */
  key: string
  /** ข้อความที่ Rich Menu ส่งเข้ามาเมื่อกด (action ชนิด message) */
  keywords: string[]
  /** ข้อความที่บอทจะตอบกลับ */
  reply: () => string
}

export const MENU_REPLIES: MenuReply[] = [
  {
    key: 'announcements',
    keywords: ['ดูประกาศบริษัท', 'ประกาศบริษัท', 'ประกาศ'],
    reply: () =>
      [
        `ประกาศล่าสุด ${ANNOUNCEMENTS.length} รายการ`,
        ...ANNOUNCEMENTS.map((a, i) => `${i + 1}. ${a}`)
      ].join('\n')
  },
  {
    key: 'hr-document',
    keywords: ['ขอเอกสาร HR', 'ขอเอกสาร', 'เอกสาร hr'],
    reply: () =>
      [
        'เอกสารที่ขอได้ผ่านระบบ',
        '1. หนังสือรับรองเงินเดือน',
        '2. หนังสือรับรองการทำงาน',
        '3. สลิปเงินเดือนย้อนหลัง',
        '',
        'พิมพ์เลขข้อที่ต้องการ แล้วฝ่ายบุคคลจะติดต่อกลับภายใน 2 วันทำการ'
      ].join('\n')
  },
  {
    key: 'leave',
    keywords: ['แจ้งลา', 'ลาป่วย', 'แจ้งลา / ลาป่วย', 'ลากิจ'],
    reply: () =>
      [
        'แจ้งลาผ่านระบบ',
        '1. ลาป่วย แจ้งได้ถึง 09:00 น. ของวันที่ลา',
        '2. ลากิจ ต้องแจ้งล่วงหน้าอย่างน้อย 1 วันทำการ',
        '3. ลาพักร้อน แจ้งล่วงหน้า 7 วัน',
        '',
        'พิมพ์รูปแบบนี้ได้เลยครับ: ลาป่วย 12 ส.ค. เหตุผล ไข้หวัด'
      ].join('\n')
  },
  {
    key: 'contacts',
    keywords: ['เบอร์ติดต่อภายใน', 'เบอร์ภายใน', 'เบอร์ติดต่อ'],
    reply: () =>
      ['เบอร์ติดต่อภายใน', ...INTERNAL_CONTACTS.map(([name, ext]) => `- ${name} ต่อ ${ext}`)].join('\n')
  },
  {
    key: 'hr-contact',
    keywords: ['ติดต่อฝ่ายบุคคล', 'ติดต่อ hr', 'ติดต่อ HR'],
    reply: () =>
      [
        'ติดต่อฝ่ายบุคคล (HR)',
        '- โทรภายใน ต่อ 101',
        '- เวลาทำการ จันทร์-ศุกร์ 08:30-17:30 น.',
        '',
        'พิมพ์เรื่องที่ต้องการติดต่อไว้ได้เลยครับ เจ้าหน้าที่จะตอบกลับในเวลาทำการ'
      ].join('\n')
  }
]

/** ข้อความต้อนรับตอนมีคนกดเพิ่มเพื่อน (follow event) */
export const WELCOME_TEXT = 'สวัสดีครับ เลือกบริการที่ต้องการจากเมนูด้านล่างได้เลยครับ'

/** ข้อความเมื่อไม่เข้าเงื่อนไขข้อไหนเลย */
export const FALLBACK_TEXT = [
  'ขออภัยครับ ผมยังไม่เข้าใจข้อความนี้',
  'เลือกบริการจากเมนูด้านล่าง หรือพิมพ์คำเหล่านี้ได้ครับ',
  ...MENU_REPLIES.map((m) => `- ${m.keywords[0]}`),
  '- สรุปพนักงานเข้างาน วันนี้ / เมื่อวาน / อาทิตย์นี้ (ระบุ workshop หรือ site ได้)',
  '- เวลาเข้างานของฉัน วันนี้ / อาทิตย์นี้ / เดือนนี้ (ครั้งแรกพิมพ์รหัสพนักงาน เช่น S69-1-003)'
].join('\n')

/** ปุ่มลัดใต้ช่องพิมพ์ แนบไปกับข้อความตอบกลับธรรมดา ให้เข้าถึงฟีเจอร์เวลาเข้างานได้ในแตะเดียว */
export const SHORTCUT_QUICK_REPLY = {
  items: [
    { type: 'action', action: { type: 'message', label: 'เวลาเข้างานของฉัน', text: 'เวลาเข้างานของฉัน วันนี้' } },
    { type: 'action', action: { type: 'message', label: 'สรุปพนักงาน วันนี้', text: 'สรุปพนักงาน วันนี้' } },
    { type: 'action', action: { type: 'message', label: 'สรุปพนักงาน เมื่อวาน', text: 'สรุปพนักงาน เมื่อวาน' } }
  ]
}

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * หาคำตอบจากข้อความที่ผู้ใช้พิมพ์หรือกดจาก Rich Menu
 * คืน null เมื่อไม่ตรงกับเมนูใดเลย (ผู้เรียกตัดสินใจเองว่าจะตอบ fallback หรือเงียบ)
 */
export function replyForText(text: string): string | null {
  const t = normalize(text)
  if (t === '') return null
  const hit = MENU_REPLIES.find((m) => m.keywords.some((k) => normalize(k) === t))
  return hit ? hit.reply() : null
}

/**
 * หาคำตอบจาก postback data
 * รองรับทั้ง "menu=announcements" และ "announcements" เฉย ๆ
 */
export function replyForPostback(data: string): string | null {
  const raw = data.trim()
  if (raw === '') return null
  const key = raw.includes('=') ? (new URLSearchParams(raw).get('menu') ?? '') : raw
  const hit = MENU_REPLIES.find((m) => m.key === key.trim())
  return hit ? hit.reply() : null
}
