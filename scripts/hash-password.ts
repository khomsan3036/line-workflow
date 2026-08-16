import bcrypt from 'bcryptjs'

// ---------------------------------------------------------------------------
// สร้าง bcrypt hash ของรหัสผ่าน admin เพื่อเอาไปใส่ ADMIN_PASSWORD_HASH ใน .env
// วิธีใช้:  npm run hash-password -- รหัสผ่านที่ต้องการ
// ---------------------------------------------------------------------------

const password = process.argv[2]

if (!password) {
  console.log('วิธีใช้: npm run hash-password -- <รหัสผ่าน>')
  process.exit(1)
}

const hash = bcrypt.hashSync(password, 10)
console.log('')
console.log('คัดลอกบรรทัดนี้ไปใส่ในไฟล์ .env')
console.log('')
console.log(`ADMIN_PASSWORD_HASH=${hash}`)
console.log('')
console.log('แล้วลบค่า ADMIN_PASSWORD ออก (ระบบจะใช้ hash เป็นหลักเมื่อมีค่านี้)')
console.log('')
