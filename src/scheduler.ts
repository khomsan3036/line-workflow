import cron from 'node-cron'
import { config } from './config'
import { runDailySummary } from './jobs/dailySummary'
import { printReport, runDailyReport } from './jobs/dailyReport'

// ---------------------------------------------------------------------------
// ตัวตั้งเวลาในตัวโปรแกรม (in-process scheduler)
//
// ใช้เมื่อ deploy บน cloud ที่เราไม่มี Windows Task Scheduler ให้ใช้
// เปิดด้วย ENABLE_SCHEDULER=true ในไฟล์ .env
//
// ข้อควรรู้
//   - ใช้ได้เฉพาะกับบริการที่รันค้างตลอด (เช่น Render Starter ขึ้นไป)
//     ถ้าเป็นแพลนที่ sleep เมื่อไม่มี traffic ตัวตั้งเวลาจะไม่ทำงานตอนหลับ
//   - ถ้ารันหลาย instance (scale > 1) งานจะถูกยิงซ้ำตามจำนวน instance
//     กรณีนั้นควรย้ายไปใช้ cron ภายนอกที่ยิงมาที่ endpoint เดียว
// ---------------------------------------------------------------------------

export function startScheduler(): void {
  if (!config.scheduler.enabled) return

  const tz = config.timezone

  if (!cron.validate(config.scheduler.summaryCron)) {
    console.error(`[scheduler] รูปแบบ SUMMARY_CRON ไม่ถูกต้อง: ${config.scheduler.summaryCron}`)
  } else {
    cron.schedule(
      config.scheduler.summaryCron,
      async () => {
        console.log(`[scheduler] เริ่มงานสรุปแชท ${new Date().toLocaleString('th-TH', { timeZone: tz })}`)
        try {
          const results = await runDailySummary({ sentBy: 'scheduler:daily-summary' })
          for (const r of results) {
            if (r.skipped) continue
            console.log(`[scheduler]   ${r.groupName}: ${r.messageCount} ข้อความ, ส่ง ${r.sendStatus}`)
          }
        } catch (err) {
          console.error('[scheduler] งานสรุปแชทผิดพลาด:', err instanceof Error ? err.message : err)
        }
      },
      { timezone: tz }
    )
    console.log(`[scheduler] ตั้งงานสรุปแชทไว้ที่ "${config.scheduler.summaryCron}" (${tz})`)
  }

  if (!cron.validate(config.scheduler.reportCron)) {
    console.error(`[scheduler] รูปแบบ REPORT_CRON ไม่ถูกต้อง: ${config.scheduler.reportCron}`)
  } else {
    cron.schedule(
      config.scheduler.reportCron,
      async () => {
        console.log(`[scheduler] เริ่มงานรายงานผู้บริหาร ${new Date().toLocaleString('th-TH', { timeZone: tz })}`)
        try {
          const outcome = await runDailyReport({ sentBy: 'scheduler:daily-report' })
          if (outcome.sendStatus === 'no-data') {
            console.log(`[scheduler]   ไม่พบข้อมูลขายของวันที่ ${outcome.date}`)
            return
          }
          printReport(outcome)
          console.log(`[scheduler]   ส่งรายงาน: ${outcome.sendStatus}`)
        } catch (err) {
          console.error('[scheduler] งานรายงานผิดพลาด:', err instanceof Error ? err.message : err)
        }
      },
      { timezone: tz }
    )
    console.log(`[scheduler] ตั้งงานรายงานผู้บริหารไว้ที่ "${config.scheduler.reportCron}" (${tz})`)
  }
}
