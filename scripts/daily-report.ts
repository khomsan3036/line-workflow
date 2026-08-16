import { pool } from '../src/db'
import { printReport, runDailyReport, yesterdayISO } from '../src/jobs/dailyReport'

// ---------------------------------------------------------------------------
// CLI สำหรับรายงานยอดขายประจำวัน (ตรรกะจริงอยู่ใน src/jobs/dailyReport.ts)
//
//   npm run daily-report -- --dry-run              ทดสอบ ไม่ส่งออกจริง
//   npm run daily-report -- --group=Cxxxxxxxx      ระบุกลุ่มผู้บริหาร
//   npm run daily-report -- --date=2026-08-08      ระบุวันที่ (ค่าเริ่มต้น = เมื่อวาน)
//   npm run daily-report -- --html                 เขียนรายงาน HTML ลงโฟลเดอร์ reports/
//   npm run daily-report -- --alert-only           ส่งเฉพาะเมื่อพบรายการผิดปกติ
// ---------------------------------------------------------------------------

function arg(name: string): string | undefined {
  return process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))?.split('=')[1]
}

const dryRun = process.argv.includes('--dry-run')

async function main(): Promise<void> {
  const date = arg('date') ?? yesterdayISO()
  console.log(`\n[daily-report] รายงานวันที่ ${date}${dryRun ? ' (โหมด dry-run)' : ''}`)

  const outcome = await runDailyReport({
    date,
    groupId: arg('group'),
    dryRun,
    writeHtml: process.argv.includes('--html'),
    alertOnly: process.argv.includes('--alert-only'),
    sentBy: 'script:daily-report'
  })

  if (outcome.sendStatus === 'no-data') {
    console.log(`[daily-report] ไม่พบข้อมูลขายของวันที่ ${date}`)
    if (outcome.latestAvailableDate) {
      console.log(`               วันที่ล่าสุดที่มีข้อมูลคือ ${outcome.latestAvailableDate} (ลองใส่ --date=${outcome.latestAvailableDate})`)
    } else {
      console.log('               ยังไม่มีข้อมูลขายเลย ลองรัน npm run seed:sales')
    }
    return
  }

  printReport(outcome)
  if (outcome.htmlPath) console.log(`  เขียนไฟล์รายงาน HTML: ${outcome.htmlPath}`)

  if (outcome.sendStatus === 'no-target') {
    console.log('  [i] ไม่ได้ระบุกลุ่มปลายทาง (ใส่ --group=Cxxxx หรือตั้ง DEFAULT_GROUP_ID ใน .env) จึงยังไม่ส่งออก\n')
    return
  }
  if (outcome.sendStatus === 'skipped') {
    console.log('  โหมด alert-only: ไม่พบรายการผิดปกติ จึงไม่ส่งเข้ากลุ่ม\n')
    return
  }

  console.log(`  ส่งรายงาน: ${outcome.sendStatus}${outcome.error ? ` (${outcome.error})` : ''}\n`)
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error('[daily-report] ผิดพลาด:', err instanceof Error ? err.message : err)
    await pool.end()
    process.exit(1)
  })
