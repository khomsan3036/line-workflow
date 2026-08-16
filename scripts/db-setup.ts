import fs from 'node:fs'
import path from 'node:path'
import { config } from '../src/config'
import { pool } from '../src/db'

// ---------------------------------------------------------------------------
// สร้างตารางและใส่ข้อมูลตัวอย่าง โดยรันไฟล์ในโฟลเดอร์ sql/ ตามลำดับ
//
//   npm run db:setup           รันทุกไฟล์ (schema + seed ยอดขาย + seed แชทจำลอง)
//   npm run db:reset           ลบตารางทั้งหมดก่อน แล้วสร้างใหม่
//   npm run seed:sales         รันเฉพาะไฟล์ 02
//   npm run seed:chat          รันเฉพาะไฟล์ 03
// ---------------------------------------------------------------------------

// หาโฟลเดอร์ sql ให้เจอทั้งตอนรันด้วย tsx และตอนรันจากไฟล์ที่ build แล้ว
const SQL_DIR = [
  path.join(process.cwd(), 'sql'),
  path.join(__dirname, '..', 'sql'),
  path.join(__dirname, '..', '..', 'sql')
].find((dir) => fs.existsSync(dir)) ?? path.join(process.cwd(), 'sql')

const DROP_SQL = `
  DROP VIEW IF EXISTS v_messages_today, v_daily_sales;
  DROP TABLE IF EXISTS line_messages, line_groups, message_logs, group_tasks, group_summaries, sales_orders;
`

async function run(): Promise<void> {
  const args = process.argv.slice(2)
  const reset = args.includes('--reset')
  const onlyArg = args.find((a) => a.startsWith('--only='))
  const only = onlyArg ? onlyArg.split('=')[1] : null

  console.log('')
  console.log('  ตั้งค่าฐานข้อมูล')
  console.log(`  ${config.databaseUrl.replace(/:[^:@/]*@/, ':****@')}`)
  console.log('')

  try {
    await pool.query('SELECT 1')
  } catch (err) {
    console.error('  [x] ต่อฐานข้อมูลไม่ได้:', err instanceof Error ? err.message : err)
    console.error('')
    console.error('  วิธีแก้')
    console.error('   1) ถ้ายังไม่มี PostgreSQL ในเครื่อง ใช้ Docker: docker compose up -d')
    console.error('   2) ถ้ามีแล้ว ให้สร้างฐานข้อมูลก่อน: psql -U postgres -c "CREATE DATABASE linechat;"')
    console.error('   3) ตรวจค่า DATABASE_URL ในไฟล์ .env ว่ารหัสผ่านและชื่อฐานข้อมูลถูกต้อง')
    console.error('')
    process.exit(1)
  }

  if (reset) {
    console.log('  - ลบตารางเดิมทั้งหมด (--reset)')
    await pool.query(DROP_SQL)
  }

  const files = fs
    .readdirSync(SQL_DIR)
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => (only ? f.startsWith(only) : true))
    .sort()

  if (files.length === 0) {
    console.log('  ไม่พบไฟล์ .sql ที่ตรงเงื่อนไข')
    await pool.end()
    return
  }

  for (const file of files) {
    const sql = fs.readFileSync(path.join(SQL_DIR, file), 'utf8')
    process.stdout.write(`  - รัน ${file} ... `)
    await pool.query(sql)
    console.log('เสร็จ')
  }

  const counts = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM line_messages) AS messages,
      (SELECT COUNT(*) FROM line_groups)   AS groups,
      (SELECT COUNT(*) FROM sales_orders)  AS sales
  `)
  const row = counts.rows[0]

  console.log('')
  console.log('  พร้อมใช้งาน')
  console.log(`   ข้อความในฐานข้อมูล : ${Number(row.messages).toLocaleString('th-TH')}`)
  console.log(`   กลุ่ม              : ${row.groups}`)
  console.log(`   รายการขาย          : ${Number(row.sales).toLocaleString('th-TH')}`)
  console.log('')
  console.log('  ขั้นต่อไป: npm run dev  แล้วเปิด http://localhost:3000')
  console.log('')

  await pool.end()
}

run().catch(async (err) => {
  console.error('  [x] ผิดพลาด:', err instanceof Error ? err.message : err)
  await pool.end()
  process.exit(1)
})
