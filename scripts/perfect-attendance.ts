import { pool } from '../src/db'
import { closeMssqlPool } from '../src/dbMssql'
import { runPerfectAttendanceReport } from '../src/jobs/perfectAttendanceReport'
import { flexPerfectAttendance, perfectAttendanceText } from '../src/services/perfectAttendanceFlex'

// ---------------------------------------------------------------------------
// CLI ส่งการ์ด "พนักงานเข้างานดีเด่นประจำเดือน" (ไม่ขาด ไม่สาย ไม่ลา) แยก Workshop / Site
// (ตรรกะจริงอยู่ใน src/jobs/perfectAttendanceReport.ts ซึ่ง PERFECT_REPORT_CRON ใช้ด้วย)
//
//   npm run perfect-attendance -- --dry-run            ประกอบการ์ดแต่ไม่ส่ง (พิมพ์รายชื่อให้ดู)
//   npm run perfect-attendance -- --to=Uxxxx           ส่งให้ผู้ใช้ (ทดสอบ) หรือกลุ่ม C... คั่นหลายปลายทางด้วยจุลภาค
//                                                      ไม่ใส่ = PERFECT_REPORT_GROUP_IDS ใน .env
//   npm run perfect-attendance -- --month=2026-09      เดือนที่ดู (ค่าเริ่มต้น = เดือนที่แล้ว) เดือนปัจจุบัน = ถึงเมื่อวาน
//   npm run perfect-attendance -- --top=5              จำนวนรายชื่อต่อสถานที่
//   npm run perfect-attendance -- --json               พิมพ์ Flex JSON (ไปวางใน Flex Simulator ได้)
// เวลาเข้างานใช้ค่าเดียวกับการ์ดมาสาย: LATE_WORKSHOP_TIME (08:00) / LATE_SITE_TIME (07:40)
// ---------------------------------------------------------------------------

function arg(name: string): string | undefined {
  return process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))?.split('=')[1]
}

function positiveInt(value: string | undefined): number | undefined {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : undefined
}

async function main(): Promise<void> {
  const month = arg('month')
  if (month && !/^\d{4}-\d{2}$/.test(month)) throw new Error('--month ต้องเป็น YYYY-MM')
  const top = positiveInt(arg('top'))
  const outcome = await runPerfectAttendanceReport({
    month,
    top,
    targets: arg('to')?.split(',').map((s) => s.trim()).filter(Boolean),
    dryRun: process.argv.includes('--dry-run'),
    sentBy: 'script:perfect-attendance'
  })
  if (!outcome.report) {
    console.log('[perfect-attendance] ยังไม่ได้ตั้ง DATABASE_URL_MSSQL จึงอ่านข้อมูลสแกนไม่ได้')
    return
  }
  console.log(`\n${perfectAttendanceText(outcome.report)}\n`)
  const flex = flexPerfectAttendance(outcome.report, top)
  console.log(`  การ์ด ${flex.contents.length} ใบ, ${Buffer.byteLength(JSON.stringify(flex)).toLocaleString('en-US')} bytes`)
  if (process.argv.includes('--json')) console.log(JSON.stringify(flex, null, 2))
  if (outcome.sendStatus === 'no-target') {
    console.log('  [i] ไม่มีปลายทาง (ใส่ --to=Uxxxx หรือตั้ง PERFECT_REPORT_GROUP_IDS ใน .env) จึงยังไม่ส่ง\n')
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
    console.error('[perfect-attendance] ผิดพลาด:', err instanceof Error ? err.message : err)
    await pool.end()
    await closeMssqlPool()
    process.exit(1)
  })
