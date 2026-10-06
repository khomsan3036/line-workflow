import { pool } from '../src/db'
import { closeMssqlPool } from '../src/dbMssql'
import { runLatenessReport } from '../src/jobs/latenessReport'
import { flexConsecutiveLateness, latenessText } from '../src/services/latenessFlex'

// ---------------------------------------------------------------------------
// CLI ส่งการ์ด "มาสายติดต่อกัน" แยก Workshop / Site (ตรรกะจริงอยู่ใน src/jobs/latenessReport.ts ซึ่ง LATE_REPORT_CRON ใช้ด้วย)
//
//   npm run late-report -- --dry-run              ประกอบการ์ดแต่ไม่ส่ง (พิมพ์รายชื่อให้ดู)
//   npm run late-report -- --to=Uxxxx             ส่งให้ผู้ใช้ (ทดสอบ) หรือกลุ่ม C... คั่นหลายปลายทางด้วยจุลภาค
//                                                 ไม่ใส่ = LATE_REPORT_GROUP_IDS ใน .env
//   npm run late-report -- --date=2026-10-05      ตรวจถึงวันที่ (ค่าเริ่มต้น = เมื่อวาน)
//   npm run late-report -- --min=3 --top=5        สายติดกันกี่วันขึ้นไป / จำนวนรายชื่อต่อสถานที่
//   npm run late-report -- --json                 พิมพ์ Flex JSON (ไปวางใน Flex Simulator ได้)
// เวลาเข้างานตั้งใน .env: LATE_WORKSHOP_TIME (08:00) / LATE_SITE_TIME (07:40) / LATE_MAX_TIME (10:00)
// ---------------------------------------------------------------------------

function arg(name: string): string | undefined {
  return process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))?.split('=')[1]
}

function positiveInt(value: string | undefined): number | undefined {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : undefined
}

async function main(): Promise<void> {
  const date = arg('date')
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('--date ต้องเป็น YYYY-MM-DD')
  const top = positiveInt(arg('top'))
  const outcome = await runLatenessReport({
    asOf: date,
    minDays: positiveInt(arg('min')),
    top,
    targets: arg('to')?.split(',').map((s) => s.trim()).filter(Boolean),
    dryRun: process.argv.includes('--dry-run'),
    sentBy: 'script:late-report'
  })
  if (!outcome.report) {
    console.log('[late-report] ยังไม่ได้ตั้ง DATABASE_URL_MSSQL จึงอ่านข้อมูลสแกนไม่ได้')
    return
  }
  console.log(`\n${latenessText(outcome.report)}\n`)
  const flex = flexConsecutiveLateness(outcome.report, top)
  console.log(`  การ์ด ${flex.contents.length} ใบ, ${Buffer.byteLength(JSON.stringify(flex)).toLocaleString('en-US')} bytes`)
  if (process.argv.includes('--json')) console.log(JSON.stringify(flex, null, 2))
  if (outcome.sendStatus === 'no-target') {
    console.log('  [i] ไม่มีปลายทาง (ใส่ --to=Uxxxx หรือตั้ง LATE_REPORT_GROUP_IDS ใน .env) จึงยังไม่ส่ง\n')
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
    console.error('[late-report] ผิดพลาด:', err instanceof Error ? err.message : err)
    await pool.end()
    await closeMssqlPool()
    process.exit(1)
  })
