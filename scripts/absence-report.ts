import { pool } from '../src/db'
import { closeMssqlPool } from '../src/dbMssql'
import { runAbsenceReport } from '../src/jobs/absenceReport'
import { absenceText, flexConsecutiveAbsence } from '../src/services/absenceFlex'

// ---------------------------------------------------------------------------
// CLI ส่งการ์ด "ขาดงานติดต่อกัน" แยก Workshop / Site (ตรรกะจริงอยู่ใน src/jobs/absenceReport.ts ซึ่ง ABSENCE_REPORT_CRON ใช้ด้วย)
//
//   npm run absence-report -- --dry-run              ประกอบการ์ดแต่ไม่ส่ง (พิมพ์รายชื่อให้ดู)
//   npm run absence-report -- --to=Uxxxx             ส่งให้ผู้ใช้ (ทดสอบ) หรือกลุ่ม C... คั่นหลายปลายทางด้วยจุลภาค
//                                                    ไม่ใส่ = ABSENCE_REPORT_GROUP_IDS ใน .env
//   npm run absence-report -- --date=2026-10-05      ตรวจถึงวันที่ (ค่าเริ่มต้น = เมื่อวาน)
//   npm run absence-report -- --min=3 --active=14    ขาดกี่วันขึ้นไป / สแกนล่าสุดไม่เกินกี่วันจึงนับว่ายังเคลื่อนไหว
//   npm run absence-report -- --top=5                จำนวนรายชื่อต่อสถานที่ (ค่าเริ่มต้นตาม ABSENCE_REPORT_TOP = 10)
//   npm run absence-report -- --json                 พิมพ์ Flex JSON (ไปวางใน Flex Simulator ได้)
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
  const outcome = await runAbsenceReport({
    asOf: date,
    minDays: positiveInt(arg('min')),
    activeDays: positiveInt(arg('active')),
    top: positiveInt(arg('top')),
    targets: arg('to')?.split(',').map((s) => s.trim()).filter(Boolean),
    dryRun: process.argv.includes('--dry-run'),
    sentBy: 'script:absence-report'
  })
  if (!outcome.report) {
    console.log('[absence-report] ยังไม่ได้ตั้ง DATABASE_URL_MSSQL จึงอ่านข้อมูลสแกนไม่ได้')
    return
  }
  console.log(`\n${absenceText(outcome.report)}\n`)
  const flex = flexConsecutiveAbsence(outcome.report, positiveInt(arg('top')))
  console.log(`  การ์ด ${flex.contents.length} ใบ, ${Buffer.byteLength(JSON.stringify(flex)).toLocaleString('en-US')} bytes`)
  if (process.argv.includes('--json')) console.log(JSON.stringify(flex, null, 2))
  if (outcome.sendStatus === 'no-target') {
    console.log('  [i] ไม่มีปลายทาง (ใส่ --to=Uxxxx หรือตั้ง ABSENCE_REPORT_GROUP_IDS ใน .env) จึงยังไม่ส่ง\n')
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
    console.error('[absence-report] ผิดพลาด:', err instanceof Error ? err.message : err)
    await pool.end()
    await closeMssqlPool()
    process.exit(1)
  })
