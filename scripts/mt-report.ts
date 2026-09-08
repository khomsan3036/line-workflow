import { pool } from '../src/db'
import { printMaintenanceReport, runMaintenanceReport, type MaintenanceReportKind } from '../src/jobs/maintenanceReport'

// ---------------------------------------------------------------------------
// CLI สำหรับการ์ดตั้งเวลาของ OA ทีมซ่อมบำรุง (ตรรกะจริงอยู่ใน src/jobs/maintenanceReport.ts)
//
//   npm run mt-report -- --kind=pending --dry-run        "งานซ่อมค้างวันนี้" (ประกอบการ์ดแต่ไม่ส่ง)
//   npm run mt-report -- --kind=urgent --always          "แจ้งเตือนงานซ่อมเร่งด่วน" (ส่งแม้ไม่มีเรื่องด่วน)
//   npm run mt-report -- --kind=pending --to=Cxxxx,Uxxxx  ระบุปลายทาง (กลุ่ม C... หรือผู้ใช้ U... ไว้ทดสอบ)
// ---------------------------------------------------------------------------

function arg(name: string): string | undefined {
  return process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))?.split('=')[1]
}

async function main(): Promise<void> {
  const kind = (arg('kind') ?? 'pending') as MaintenanceReportKind
  if (kind !== 'pending' && kind !== 'urgent') throw new Error('--kind ต้องเป็น pending หรือ urgent')
  const dryRun = process.argv.includes('--dry-run')
  console.log(`\n[mt-report] ${kind}${dryRun ? ' (โหมด dry-run)' : ''}`)

  const outcome = await runMaintenanceReport({
    kind,
    targets: arg('to')?.split(',').map((s) => s.trim()).filter(Boolean),
    dryRun,
    alwaysSend: process.argv.includes('--always'),
    sentBy: `script:mt-report:${kind}`
  })

  if (outcome.sendStatus === 'disabled') {
    console.log('  [i] ยังไม่ได้ตั้ง CHANNEL_ACCESS_TOKEN_MT / CHANNEL_SECRET_MT จึงไม่มี OA ทีมซ่อมบำรุงให้ส่ง\n')
    return
  }
  if (outcome.sendStatus === 'agent-failed') {
    console.log(`  [x] แชทบอทตอบไม่ได้: ${outcome.text}\n`)
    process.exitCode = 1
    return
  }
  printMaintenanceReport(outcome)
  if (outcome.sendStatus === 'skipped') console.log('  ไม่มีเรื่องด่วน (การ์ดไม่ใช่ critical) จึงไม่ส่ง ใส่ --always เพื่อส่งทดสอบ')
  if (outcome.sendStatus === 'no-target') console.log('  [i] ไม่มีปลายทาง (บอท MT ยังไม่ได้อยู่ในกลุ่มใด หรือใส่ --to=Cxxxx / ตั้ง MT_REPORT_GROUP_IDS)')
  console.log(`  ผลรวม: ${outcome.sendStatus}\n`)
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error('[mt-report] ผิดพลาด:', err instanceof Error ? err.message : err)
    await pool.end()
    process.exit(1)
  })
