import { config } from '../src/config'
import { pool } from '../src/db'
import { runDailySummary } from '../src/jobs/dailySummary'

// ---------------------------------------------------------------------------
// CLI สำหรับสรุปบทสนทนากลุ่มประจำวัน (ตรรกะจริงอยู่ใน src/jobs/dailySummary.ts)
//
//   npm run daily-summary                        สรุปทุกกลุ่มที่ active ย้อนหลัง 24 ชม.
//   npm run daily-summary -- --dry-run           ทดสอบโดยไม่ส่งออกจริง
//   npm run daily-summary -- --group=Cxxxx       ระบุกลุ่มเดียว
//   npm run daily-summary -- --hours=12          เปลี่ยนช่วงเวลาย้อนหลัง
// ---------------------------------------------------------------------------

function arg(name: string): string | undefined {
  return process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))?.split('=')[1]
}

const dryRun = process.argv.includes('--dry-run')

async function main(): Promise<void> {
  const stamp = new Date().toLocaleString('th-TH', { timeZone: config.timezone })
  console.log(`\n[daily-summary] เริ่มทำงาน ${stamp}${dryRun ? ' (โหมด dry-run)' : ''}`)

  const results = await runDailySummary({
    hours: Number(arg('hours') ?? 24),
    groupId: arg('group'),
    dryRun,
    sentBy: 'script:daily-summary'
  })

  if (results.length === 0) {
    console.log('[daily-summary] ไม่พบกลุ่มที่ต้องสรุป')
  }

  for (const r of results) {
    if (r.skipped) {
      console.log(`  - ${r.groupName}: ไม่มีข้อความในช่วงเวลาที่กำหนด ข้าม`)
      continue
    }
    console.log(
      `  - ${r.groupName}: ${r.messageCount} ข้อความ, โมเดล ${r.model}, งานใหม่ ${r.tasksAdded} รายการ, ส่ง ${r.sendStatus}` +
        (r.error ? ` (${r.error})` : '')
    )
  }

  console.log('[daily-summary] เสร็จสิ้น\n')
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error('[daily-summary] ผิดพลาด:', err instanceof Error ? err.message : err)
    await pool.end()
    process.exit(1)
  })
