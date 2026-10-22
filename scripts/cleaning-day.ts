import { pool } from '../src/db'
import { cleaningDayNoticeFor, lastSaturdayOfMonth, runCleaningDayReminder } from '../src/jobs/cleaningDayReminder'
import { config } from '../src/config'
import { formatThaiDate, todayLocal, addDays } from '../src/services/attendanceQuery'
import type { CleaningDaySlot } from '../src/services/cleaningDayFlex'

// ---------------------------------------------------------------------------
// CLI ประกาศ "Monthly Cleaning Day" (ตรรกะจริงอยู่ใน src/jobs/cleaningDayReminder.ts ซึ่ง CLEANING_DAY_CRON ใช้ด้วย)
//
//   npm run cleaning-day -- --dry-run                      ตรวจว่าวันนี้/รอบนี้ต้องแจ้งอะไร (ไม่ส่ง)
//   npm run cleaning-day -- --to=Cxxxx                     ส่งเข้ากลุ่ม/ผู้ใช้ (คั่นด้วยจุลภาค) ไม่ใส่ = CLEANING_DAY_GROUP_IDS
//   npm run cleaning-day -- --date=2026-10-28 --slot=morning   จำลองวันที่และรอบ (morning | start | evening)
//   npm run cleaning-day -- --date=2026-10-31 --slot=start --to=U...   การ์ด "อีก 15 นาทีเริ่ม" ของวันเสาร์นั้น
//   npm run cleaning-day -- --schedule                     แสดงตารางแจ้งเตือนของเดือนนี้และเดือนหน้า
//   npm run cleaning-day -- --json                         พิมพ์ Flex JSON (ไปวางใน Flex Simulator ได้)
// ---------------------------------------------------------------------------

function arg(name: string): string | undefined {
  return process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))?.split('=')[1]
}

/** เวลาส่งรอบก่อนเริ่ม = เวลาเริ่ม - นาทีที่แจ้งล่วงหน้า */
function startReminderTime(): string {
  const [h, m] = config.scheduler.cleaningDayStartTime.split(':').map(Number)
  const total = (h * 60 + m - config.scheduler.cleaningDayStartLeadMin + 1440) % 1440
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

function printSchedule(from: string): void {
  for (const monthStart of [from, addDays(lastSaturdayOfMonth(from), 7)]) {
    const event = lastSaturdayOfMonth(monthStart)
    console.log(`\nCleaning Day: ${formatThaiDate(event)}`)
    for (let d = addDays(event, -7); d <= event; d = addDays(d, 1)) {
      for (const slot of ['morning', 'start', 'evening'] as CleaningDaySlot[]) {
        const n = cleaningDayNoticeFor(d, slot)
        if (!n) continue
        const what =
          n.kind === 'countdown'
            ? `แจ้งเตือน ${n.step}/${n.total} (อีก ${n.daysLeft} วัน)`
            : n.kind === 'today'
              ? 'วันนี้คือ Cleaning Day'
              : n.kind === 'starting'
                ? `อีก ${n.minutesLeft} นาทีเริ่ม (เริ่ม ${n.startTime})`
                : 'ขอบคุณทุกคน'
        console.log(`  ${formatThaiDate(d)}  ${slot === 'morning' ? '08:00' : slot === 'evening' ? '17:00' : startReminderTime()}  ${what}`)
      }
    }
  }
  console.log('')
}

async function main(): Promise<void> {
  if (process.argv.includes('--schedule')) {
    printSchedule(arg('date') ?? todayLocal())
    return
  }
  const slot = arg('slot')
  const outcome = await runCleaningDayReminder({
    date: arg('date'),
    slot: slot === 'morning' || slot === 'evening' || slot === 'start' ? slot : undefined,
    targets: arg('to')?.split(',').map((s) => s.trim()).filter(Boolean),
    dryRun: process.argv.includes('--dry-run'),
    sentBy: 'script:cleaning-day'
  })
  if (!outcome.notice || !outcome.card) {
    console.log('[cleaning-day] วันนี้/รอบนี้ไม่ต้องแจ้ง (ดูตารางด้วย --schedule)')
    return
  }
  console.log(`\n${outcome.card.altText}\n`)
  if (process.argv.includes('--json')) console.log(JSON.stringify(outcome.card.contents, null, 2))
  if (outcome.targets.length === 0) console.log('  [i] ไม่มีปลายทาง (ใส่ --to=Cxxxx หรือตั้ง CLEANING_DAY_GROUP_IDS ใน .env) จึงยังไม่ส่ง\n')
  for (const t of outcome.targets) console.log(`  -> ${t.name}: ${t.status}${t.error ? ` (${t.error})` : ''}`)
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error('[cleaning-day] ผิดพลาด:', err instanceof Error ? err.message : err)
    await pool.end()
    process.exit(1)
  })
