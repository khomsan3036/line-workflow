import { pool } from '../src/db'
import { deleteMediaOlderThan } from '../src/services/media'

// ---------------------------------------------------------------------------
// ลบไฟล์เก่าตามนโยบายเก็บข้อมูลขององค์กร (data retention)
//
//   npm run media:cleanup -- --days=90            ดูว่าจะลบกี่ไฟล์ (ยังไม่ลบจริง)
//   npm run media:cleanup -- --days=90 --yes      ลบจริง
//
// การเก็บข้อมูลอย่างมีความรับผิดชอบต้องมีวันหมดอายุเสมอ
// ไม่ใช่เก็บทุกอย่างไว้ตลอดกาลโดยไม่มีเหตุผล
// ---------------------------------------------------------------------------

function arg(name: string): string | undefined {
  return process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))?.split('=')[1]
}

const days = Number(arg('days') ?? 90)
const confirmed = process.argv.includes('--yes')

async function main(): Promise<void> {
  console.log(`\n[media:cleanup] ไฟล์ที่เก่ากว่า ${days} วัน`)

  if (!confirmed) {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS c, COALESCE(SUM(size_bytes), 0)::bigint AS b
         FROM media_files
        WHERE status = 'stored' AND sent_at < now() - ($1 || ' days')::interval`,
      [days]
    )
    const mb = Number(rows[0].b) / 1024 / 1024
    console.log(`               จะถูกลบ ${rows[0].c} ไฟล์ (${mb.toFixed(1)} MB)`)
    console.log('               ใส่ --yes เพื่อลบจริง\n')
    return
  }

  const removed = await deleteMediaOlderThan(days)
  console.log(`[media:cleanup] ลบแล้ว ${removed} ไฟล์\n`)
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error('[media:cleanup] ผิดพลาด:', err instanceof Error ? err.message : err)
    await pool.end()
    process.exit(1)
  })
