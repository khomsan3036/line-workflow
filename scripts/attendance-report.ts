import { pool } from '../src/db'
import { closeMssqlPool } from '../src/dbMssql'
import { printAttendanceReport, runAttendanceReport } from '../src/jobs/attendanceReport'
import type { LocationFilter, PeriodKey } from '../src/services/attendanceQuery'

// ---------------------------------------------------------------------------
// CLI สำหรับส่งการ์ด "สรุปการเข้างาน" (ตรรกะจริงอยู่ใน src/jobs/attendanceReport.ts)
//
//   npm run attendance-report -- --dry-run                 ประกอบการ์ดแต่ไม่ส่ง
//   npm run attendance-report -- --to=Cxxxx,Uxxxx           ระบุปลายทาง (กลุ่ม C... หรือผู้ใช้ U... ไว้ทดสอบ)
//   npm run attendance-report -- --period=yesterday         today | yesterday | thisWeek | lastWeek | thisMonth | lastMonth
//   npm run attendance-report -- --location=workshop        all | workshop | site
// ---------------------------------------------------------------------------

function arg(name: string): string | undefined {
  return process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))?.split('=')[1]
}

const dryRun = process.argv.includes('--dry-run')

async function main(): Promise<void> {
  console.log(`\n[attendance-report] สรุปการเข้างาน${dryRun ? ' (โหมด dry-run)' : ''}`)
  const location = (arg('location') ?? '').toLowerCase()
  const outcome = await runAttendanceReport({
    period: arg('period') as PeriodKey | undefined,
    location: location === 'workshop' ? 'Workshop' : location === 'site' ? 'Site' : location === 'all' ? 'all' : undefined,
    targets: arg('to')?.split(',').map((s) => s.trim()).filter(Boolean),
    dryRun,
    sentBy: 'script:attendance-report'
  })

  if (outcome.sendStatus === 'not-configured') {
    console.log('  [i] ยังไม่ได้ตั้ง DATABASE_URL_MSSQL (ฐานข้อมูลเครื่องสแกนนิ้ว) จึงยังไม่ส่ง\n')
    return
  }
  if (outcome.summary) printAttendanceReport(outcome)
  if (outcome.sendStatus === 'no-target') {
    console.log('  [i] ไม่มีปลายทาง (ใส่ --to=Cxxxx หรือตั้ง REPORT_GROUP_IDS / DEFAULT_GROUP_ID ใน .env) จึงยังไม่ส่ง\n')
    return
  }
  console.log(`  ผลรวม: ${outcome.sendStatus}\n`)
}

main()
  .then(async () => {
    await pool.end()
    await closeMssqlPool()
  })
  .catch(async (err) => {
    console.error('[attendance-report] ผิดพลาด:', err instanceof Error ? err.message : err)
    await pool.end()
    await closeMssqlPool()
    process.exit(1)
  })
