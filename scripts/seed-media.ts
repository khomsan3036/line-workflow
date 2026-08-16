import { config } from '../src/config'
import { pool, query } from '../src/db'
import { archiveMedia } from '../src/services/media'
import { getStorage } from '../src/services/storage'

// ---------------------------------------------------------------------------
// สร้างไฟล์ตัวอย่างในแกลเลอรี สำหรับใช้ตอนเรียนเมื่อยังไม่มี LINE OA จริง
//
//   npm run seed:media
//   npm run seed:media -- --group=Cxxxx --count=18
//
// ไฟล์ที่สร้างเป็น SVG และ CSV ที่โปรแกรมเขียนขึ้นเอง ไม่ได้ดึงจาก LINE
// จึงไม่มีข้อมูลของบุคคลจริงใด ๆ ทั้งสิ้น
// ---------------------------------------------------------------------------

function arg(name: string): string | undefined {
  return process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))?.split('=')[1]
}

const SENDERS = [
  'ปิยะ (หัวหน้าทีม)',
  'นภา (คลังสินค้า)',
  'วีระ (จัดส่ง)',
  'มินตรา (ลูกค้าสัมพันธ์)'
]

const PHOTO_TOPICS = [
  ['ใบเสร็จค่าขนส่ง', '#1855A3'],
  ['สลิปโอนเงินลูกค้า', '#0F8B5E'],
  ['ภาพสินค้าเสียหาย', '#C8281E'],
  ['สต๊อกแอร์ในคลัง', '#D97706'],
  ['ป้ายทะเบียนรถส่งของ', '#5B21B6'],
  ['ใบส่งของสาขาขอนแก่น', '#0C1628'],
  ['หน้างานติดตั้ง', '#0E7490'],
  ['บิลค่าน้ำมัน', '#BE185D']
]

const FILES = [
  ['รายงานสต๊อกประจำสัปดาห์.csv', 'text/csv'],
  ['สรุปเคสร้องเรียน-2สัปดาห์.csv', 'text/csv'],
  ['รายชื่อลูกค้ารอจัดส่ง.csv', 'text/csv'],
  ['บันทึกประชุมทีมปฏิบัติการ.txt', 'text/plain']
]

/** วาดภาพตัวอย่างเป็น SVG (ไม่ต้องพึ่ง library ใด ๆ) */
function makeSvg(title: string, color: string, index: number): Buffer {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800" viewBox="0 0 800 800">
  <rect width="800" height="800" fill="${color}"/>
  <circle cx="640" cy="160" r="190" fill="#ffffff" opacity="0.10"/>
  <circle cx="150" cy="660" r="240" fill="#000000" opacity="0.10"/>
  <text x="60" y="360" font-family="sans-serif" font-size="46" font-weight="700" fill="#ffffff">${title}</text>
  <text x="60" y="420" font-family="sans-serif" font-size="26" fill="#ffffff" opacity="0.85">ภาพตัวอย่างสำหรับการอบรม</text>
  <text x="60" y="470" font-family="sans-serif" font-size="24" fill="#ffffff" opacity="0.7">IMG-${String(index).padStart(4, '0')}</text>
  <rect x="60" y="640" width="300" height="6" rx="3" fill="#ffffff" opacity="0.55"/>
</svg>`
  return Buffer.from(svg, 'utf8')
}

function makeCsv(name: string): Buffer {
  const rows = [
    'รายการ,จำนวน,หน่วย,หมายเหตุ',
    'เครื่องปรับอากาศ 12000 BTU,8,เครื่อง,ต่ำกว่าจุดสั่งซื้อ',
    'ตู้เย็น 2 ประตู 9 คิว,14,เครื่อง,ปกติ',
    'เครื่องซักผ้าฝาหน้า 9 กก.,6,เครื่อง,รอเข้าเพิ่ม',
    'หม้อทอดไร้น้ำมัน,52,เครื่อง,ปกติ'
  ]
  return Buffer.from('﻿' + rows.join('\r\n') + `\r\n# ${name} (ข้อมูลจำลองเพื่อการอบรม)\r\n`, 'utf8')
}

async function main(): Promise<void> {
  const count = Number(arg('count') ?? 14)
  let groupId = arg('group')

  if (!groupId) {
    const row = await query<{ group_id: string }>(
      `SELECT group_id FROM line_groups WHERE is_active ORDER BY last_message_at DESC NULLS LAST LIMIT 1`
    )
    groupId = row[0]?.group_id
  }
  if (!groupId) {
    console.error('ไม่พบกลุ่มในระบบ ให้รัน npm run seed:chat ก่อน หรือระบุ --group=Cxxxx')
    process.exit(1)
  }

  console.log(`\n[seed:media] สร้างไฟล์ตัวอย่าง ${count} ไฟล์ ให้กลุ่ม ${groupId}`)
  console.log(`             เก็บด้วยวิธี: ${config.media.driver === 'local' ? `ดิสก์ ${config.media.localDir}` : 's3'}\n`)

  const storage = getStorage()
  const now = Date.now()
  let stored = 0

  for (let i = 0; i < count; i += 1) {
    const isFile = i % 5 === 4
    const sentAt = new Date(now - i * 3600_000 * 5)
    const sender = SENDERS[i % SENDERS.length]
    const messageId = `seed-media-${now}-${i}`

    let buffer: Buffer
    let contentType: string
    let fileName: string | null
    let caption: string
    let mediaType: 'image' | 'file'

    if (isFile) {
      const [name, type] = FILES[i % FILES.length]
      buffer = makeCsv(name)
      contentType = type
      fileName = name
      caption = name.replace(/\.[a-z]+$/i, '')
      mediaType = 'file'
    } else {
      const [title, color] = PHOTO_TOPICS[i % PHOTO_TOPICS.length]
      buffer = makeSvg(title, color, i + 1)
      contentType = 'image/svg+xml'
      // รูปจาก LINE ไม่มีชื่อไฟล์ติดมา (จงใจปล่อยเป็น null ให้เหมือนของจริง)
      // สิ่งที่ทำให้ค้นเจอย้อนหลังคือ caption ที่แอดมินตั้งไว้
      fileName = null
      caption = title
      mediaType = 'image'
    }

    const yyyy = sentAt.getFullYear()
    const mm = String(sentAt.getMonth() + 1).padStart(2, '0')
    const ext = mediaType === 'file' ? (fileName ?? '').split('.').pop() ?? 'txt' : 'svg'
    const key = `${groupId.replace(/[^A-Za-z0-9_-]/g, '')}/${yyyy}/${mm}/${messageId}.${ext}`
    const put = await storage.put(key, buffer)

    // บันทึกทั้งข้อความและไฟล์ ให้เหมือนกับที่ webhook ทำจริง
    await query(
      `INSERT INTO line_messages
         (line_message_id, group_id, user_id, display_name, message_type, message_text, sent_at)
       VALUES ($1,$2,$3,$4,$5,NULL,$6)
       ON CONFLICT (line_message_id) DO NOTHING`,
      [messageId, groupId, `Useed${i % SENDERS.length}`, sender, mediaType, sentAt]
    )
    await query(
      `INSERT INTO media_files
         (line_message_id, group_id, user_id, display_name, media_type, file_name, caption, content_type,
          size_bytes, storage_driver, storage_key, preview_key, checksum, status, sent_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NULL,$12,'stored',$13)
       ON CONFLICT (line_message_id) DO NOTHING`,
      [
        messageId, groupId, `Useed${i % SENDERS.length}`, sender, mediaType, fileName, caption, contentType,
        put.size, storage.driver, put.key, put.checksum, sentAt
      ]
    )
    stored += 1
  }

  console.log(`[seed:media] เสร็จ สร้างไฟล์ ${stored} รายการ`)
  console.log('             เปิดดูได้ที่ http://localhost:3000/media\n')

  // กันเข้าใจผิด: ฟังก์ชันของจริงคือ archiveMedia() ที่ถูกเรียกจาก webhook
  void archiveMedia
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error('[seed:media] ผิดพลาด:', err instanceof Error ? err.message : err)
    await pool.end()
    process.exit(1)
  })
