import { pool } from '../src/db'
import { closeMssqlPool } from '../src/dbMssql'
import { parseOtPeriod, runOvertimeReport } from '../src/jobs/overtimeReport'
import { flexOvertimeRanking, overtimeText } from '../src/services/overtimeFlex'

// ---------------------------------------------------------------------------
// CLI ส่งการ์ด "Top OT สะสม" แยก Workshop / Site (ตรรกะจริงอยู่ใน src/jobs/overtimeReport.ts ซึ่ง OT_REPORT_CRON ใช้ด้วย)
//
//   npm run ot-report -- --dry-run                     ประกอบการ์ดแต่ไม่ส่ง (พิมพ์อันดับให้ดู)
//   npm run ot-report -- --to=Uxxxx                    ส่งให้ผู้ใช้ (ทดสอบ) หรือกลุ่ม C... คั่นหลายปลายทางด้วยจุลภาค
//                                                      ไม่ใส่ = OT_REPORT_GROUP_IDS ใน .env
//   npm run ot-report -- --period=thisWeek             lastWeek (ค่าเริ่มต้นตาม OT_REPORT_PERIOD) | thisWeek | thisMonth | lastMonth
//   npm run ot-report -- --top=5                       จำนวนอันดับต่อสถานที่ (ค่าเริ่มต้นตาม OT_REPORT_TOP = 10)
//   npm run ot-report -- --json                        พิมพ์ Flex JSON (ไปวางใน Flex Simulator ได้)
// ---------------------------------------------------------------------------

function arg(name: string): string | undefined {
  return process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))?.split('=')[1]
}

async function main(): Promise<void> {
  const top = Number(arg('top'))
  const outcome = await runOvertimeReport({
    period: arg('period') ? parseOtPeriod(arg('period')) : undefined,
    targets: arg('to')?.split(',').map((s) => s.trim()).filter(Boolean),
    limit: Number.isInteger(top) && top > 0 ? Math.min(top, 10) : undefined,
    dryRun: process.argv.includes('--dry-run'),
    sentBy: 'script:ot-report'
  })
  if (!outcome.ranking) {
    console.log('[ot-report] ยังไม่ได้ตั้ง DATABASE_URL_MSSQL จึงอ่านข้อมูล OT ไม่ได้')
    return
  }
  console.log(`\n${overtimeText(outcome.ranking)}\n`)
  if (process.argv.includes('--json')) console.log(JSON.stringify(flexOvertimeRanking(outcome.ranking), null, 2))
  if (outcome.sendStatus === 'no-target') {
    console.log('  [i] ไม่มีปลายทาง (ใส่ --to=Uxxxx หรือตั้ง OT_REPORT_GROUP_IDS ใน .env) จึงยังไม่ส่ง\n')
    return
  }
  for (const t of outcome.targets) console.log(`  -> ${t.name}: ${t.status}${t.error ? ` (${t.error})` : ''}`)
  console.log(`  ผลรวม: ${outcome.sendStatus}\n`)
}

main()
  .then(async () => {
    await pool.end()
    await closeMssqlPool()
  })
  .catch(async (err) => {
    console.error('[ot-report] ผิดพลาด:', err instanceof Error ? err.message : err)
    await pool.end()
    await closeMssqlPool()
    process.exit(1)
  })
