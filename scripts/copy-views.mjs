// ---------------------------------------------------------------------------
// tsc คอมไพล์แต่ไฟล์ .ts ไม่คัดลอกไฟล์ .ejs ไปด้วย
// สคริปต์นี้จึงคัดลอกโฟลเดอร์ src/views ไปไว้ที่ dist/src/views หลัง build
// เรียกอัตโนมัติจาก npm run build
// ---------------------------------------------------------------------------
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const from = path.join(here, '..', 'src', 'views')
const to = path.join(here, '..', 'dist', 'src', 'views')

if (!fs.existsSync(from)) {
  console.error(`[copy-views] ไม่พบโฟลเดอร์ ${from}`)
  process.exit(1)
}

fs.rmSync(to, { recursive: true, force: true })
fs.cpSync(from, to, { recursive: true })

const count = fs.readdirSync(to, { recursive: true }).filter((f) => String(f).endsWith('.ejs')).length
console.log(`[copy-views] คัดลอก view ${count} ไฟล์ไปที่ dist/src/views แล้ว`)
