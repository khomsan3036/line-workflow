import cron from 'node-cron'
import { config } from './config'
import { runDailySummary } from './jobs/dailySummary'
import { printAttendanceReport, runAttendanceReport } from './jobs/attendanceReport'
import { printMaintenanceReport, runMaintenanceReport, type MaintenanceReportKind } from './jobs/maintenanceReport'
import { runOvertimeReport } from './jobs/overtimeReport'
import { runCleaningDayReminder } from './jobs/cleaningDayReminder'
import { runAbsenceReport } from './jobs/absenceReport'
import { runLatenessReport } from './jobs/latenessReport'
import { runComplaintDigest } from './services/complaintChat'
import { printDocumentExpiryRun, runDocumentExpiryDispatch } from './services/documentExpiryDispatch'

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

  // REPORT_CRON ใส่ได้หลายรอบคั่นด้วย ; (เช่น 10:30 และ 20:00) แต่ละรอบตั้งงานแยกกัน รอบที่รูปแบบผิดข้ามไปรอบเดียว
  for (const reportCron of config.scheduler.reportCrons) {
    if (!cron.validate(reportCron)) {
      console.error(`[scheduler] รูปแบบ REPORT_CRON ไม่ถูกต้อง: ${reportCron}`)
      continue
    }
    cron.schedule(
      reportCron,
      async () => {
        console.log(`[scheduler] เริ่มงานสรุปการเข้างาน ${new Date().toLocaleString('th-TH', { timeZone: tz })}`)
        try {
          const outcome = await runAttendanceReport({ sentBy: 'scheduler:attendance-report' })
          if (outcome.sendStatus === 'not-configured') {
            console.warn('[scheduler]   ข้าม: ยังไม่ได้ตั้ง DATABASE_URL_MSSQL (ฐานข้อมูลเครื่องสแกนนิ้ว)')
            return
          }
          if (outcome.sendStatus === 'no-target') {
            console.warn('[scheduler]   ข้าม: ยังไม่ได้ตั้ง REPORT_GROUP_IDS หรือ DEFAULT_GROUP_ID')
            return
          }
          printAttendanceReport(outcome)
          console.log(`[scheduler]   ส่งสรุปการเข้างาน: ${outcome.sendStatus}`)
        } catch (err) {
          console.error('[scheduler] งานสรุปการเข้างานผิดพลาด:', err instanceof Error ? err.message : err)
        }
      },
      { timezone: tz }
    )
    console.log(`[scheduler] ตั้งงานสรุปการเข้างานไว้ที่ "${reportCron}" (${tz})`)
  }

  // การ์ด "Top OT สะสม" (ค่าเริ่มต้นทุกวันจันทร์ 10:30 สรุปสัปดาห์ที่แล้ว) ว่าง = ปิด
  const otCron = config.scheduler.otReportCron
  if (otCron && !cron.validate(otCron)) {
    console.error(`[scheduler] รูปแบบ OT_REPORT_CRON ไม่ถูกต้อง: ${otCron}`)
  } else if (otCron) {
    cron.schedule(
      otCron,
      async () => {
        console.log(`[scheduler] เริ่มงาน Top OT ${new Date().toLocaleString('th-TH', { timeZone: tz })}`)
        try {
          const outcome = await runOvertimeReport({ sentBy: 'scheduler:ot-report' })
          if (outcome.sendStatus === 'not-configured') {
            console.warn('[scheduler]   ข้าม: ยังไม่ได้ตั้ง DATABASE_URL_MSSQL')
            return
          }
          if (outcome.sendStatus === 'no-target') {
            console.warn('[scheduler]   ข้าม: ยังไม่ได้ตั้ง OT_REPORT_GROUP_IDS')
            return
          }
          for (const t of outcome.targets) console.log(`[scheduler]   Top OT -> ${t.name}: ${t.status}${t.error ? ` (${t.error})` : ''}`)
        } catch (err) {
          console.error('[scheduler] งาน Top OT ผิดพลาด:', err instanceof Error ? err.message : err)
        }
      },
      { timezone: tz }
    )
    console.log(`[scheduler] ตั้งงาน Top OT ไว้ที่ "${otCron}" (${tz}) -> ${config.scheduler.otReportTargets.length} ปลายทาง`)
  }

  // การ์ด "ขาดงานติดต่อกัน" (ค่าเริ่มต้น จ.-ส. 09:00 ตรวจถึงเมื่อวาน) ว่าง / ไม่มีปลายทาง = ปิด
  const absenceCron = config.scheduler.absenceReportCron
  if (absenceCron && !cron.validate(absenceCron)) {
    console.error(`[scheduler] รูปแบบ ABSENCE_REPORT_CRON ไม่ถูกต้อง: ${absenceCron}`)
  } else if (absenceCron && config.scheduler.absenceReportTargets.length > 0) {
    cron.schedule(
      absenceCron,
      async () => {
        console.log(`[scheduler] เริ่มงานขาดงานติดต่อกัน ${new Date().toLocaleString('th-TH', { timeZone: tz })}`)
        try {
          const outcome = await runAbsenceReport({ sentBy: 'scheduler:absence-report' })
          if (outcome.sendStatus === 'not-configured') {
            console.warn('[scheduler]   ข้าม: ยังไม่ได้ตั้ง DATABASE_URL_MSSQL')
            return
          }
          for (const t of outcome.targets) console.log(`[scheduler]   ขาดงาน -> ${t.name}: ${t.status}${t.error ? ` (${t.error})` : ''}`)
        } catch (err) {
          console.error('[scheduler] งานขาดงานติดต่อกันผิดพลาด:', err instanceof Error ? err.message : err)
        }
      },
      { timezone: tz }
    )
    console.log(`[scheduler] ตั้งงานขาดงานติดต่อกันไว้ที่ "${absenceCron}" (${tz}) -> ${config.scheduler.absenceReportTargets.length} ปลายทาง`)
  }

  // การ์ด "มาสายติดต่อกัน" (ค่าเริ่มต้น จ.-ส. 09:05 ตรวจถึงเมื่อวาน) ว่าง / ไม่มีปลายทาง = ปิด
  const lateCron = config.scheduler.lateReportCron
  if (lateCron && !cron.validate(lateCron)) {
    console.error(`[scheduler] รูปแบบ LATE_REPORT_CRON ไม่ถูกต้อง: ${lateCron}`)
  } else if (lateCron && config.scheduler.lateReportTargets.length > 0) {
    cron.schedule(
      lateCron,
      async () => {
        console.log(`[scheduler] เริ่มงานมาสายติดต่อกัน ${new Date().toLocaleString('th-TH', { timeZone: tz })}`)
        try {
          const outcome = await runLatenessReport({ sentBy: 'scheduler:late-report' })
          if (outcome.sendStatus === 'not-configured') {
            console.warn('[scheduler]   ข้าม: ยังไม่ได้ตั้ง DATABASE_URL_MSSQL')
            return
          }
          for (const t of outcome.targets) console.log(`[scheduler]   มาสาย -> ${t.name}: ${t.status}${t.error ? ` (${t.error})` : ''}`)
        } catch (err) {
          console.error('[scheduler] งานมาสายติดต่อกันผิดพลาด:', err instanceof Error ? err.message : err)
        }
      },
      { timezone: tz }
    )
    console.log(`[scheduler] ตั้งงานมาสายติดต่อกันไว้ที่ "${lateCron}" (${tz}) -> ${config.scheduler.lateReportTargets.length} ปลายทาง`)
  }

  // ประกาศ "Monthly Cleaning Day": ตรวจทุกรอบ (ค่าเริ่มต้น 08:00 และ 17:00) งานตัดสินเองว่าวันนี้ต้องแจ้งไหม ว่าง = ปิด
  const cleaningCron = config.scheduler.cleaningDayCron
  if (cleaningCron && !cron.validate(cleaningCron)) {
    console.error(`[scheduler] รูปแบบ CLEANING_DAY_CRON ไม่ถูกต้อง: ${cleaningCron}`)
  } else if (cleaningCron && config.scheduler.cleaningDayTargets.length > 0) {
    cron.schedule(
      cleaningCron,
      async () => {
        try {
          const outcome = await runCleaningDayReminder({ dedupe: true, sentBy: 'scheduler:cleaning-day' })
          if (!outcome.notice) return
          for (const t of outcome.targets) console.log(`[scheduler]   Cleaning Day -> ${t.name}: ${t.status}${t.error ? ` (${t.error})` : ''}`)
        } catch (err) {
          console.error('[scheduler] งานประกาศ Cleaning Day ผิดพลาด:', err instanceof Error ? err.message : err)
        }
      },
      { timezone: tz }
    )
    console.log(`[scheduler] ตั้งงานประกาศ Cleaning Day ไว้ที่ "${cleaningCron}" (${tz}) -> ${config.scheduler.cleaningDayTargets.length} ปลายทาง`)
  }

  // OA ทีมซ่อมบำรุง: การ์ด "งานซ่อมค้างวันนี้" และ "แจ้งเตือนงานซ่อมเร่งด่วน" (ว่าง = ปิดงานนั้น)
  if (config.maintenance.enabled) {
    const mtJobs: Array<{ kind: MaintenanceReportKind; cron: string; label: string; env: string }> = [
      { kind: 'pending', cron: config.scheduler.mtPendingCron, label: 'งานซ่อมค้างวันนี้', env: 'MT_PENDING_CRON' },
      { kind: 'urgent', cron: config.scheduler.mtUrgentCron, label: 'แจ้งเตือนงานซ่อมเร่งด่วน', env: 'MT_URGENT_CRON' }
    ]
    for (const job of mtJobs) {
      if (!job.cron) continue
      if (!cron.validate(job.cron)) {
        console.error(`[scheduler] รูปแบบ ${job.env} ไม่ถูกต้อง: ${job.cron}`)
        continue
      }
      cron.schedule(
        job.cron,
        async () => {
          console.log(`[scheduler] เริ่มงาน MT ${job.label} ${new Date().toLocaleString('th-TH', { timeZone: tz })}`)
          try {
            const outcome = await runMaintenanceReport({ kind: job.kind, sentBy: `scheduler:mt-${job.kind}` })
            if (outcome.sendStatus === 'agent-failed') {
              console.error(`[scheduler]   แชทบอทตอบไม่ได้: ${outcome.text}`)
              return
            }
            if (outcome.sendStatus === 'no-target') {
              console.warn('[scheduler]   ข้าม: บอท MT ยังไม่ได้อยู่ในกลุ่มใด (หรือ MT_REPORT_GROUP_IDS ว่าง)')
              return
            }
            printMaintenanceReport(outcome)
            console.log(`[scheduler]   ${job.label}: ${outcome.sendStatus === 'skipped' ? 'ไม่มีเรื่องด่วน ไม่ส่ง' : outcome.sendStatus}`)
          } catch (err) {
            console.error(`[scheduler] งาน MT ${job.label} ผิดพลาด:`, err instanceof Error ? err.message : err)
          }
        },
        { timezone: tz }
      )
      console.log(`[scheduler] ตั้งงาน MT ${job.label} ไว้ที่ "${job.cron}" (${tz})`)
    }
  }

  // แจ้งเตือนเอกสารใกล้หมดอายุทุกเช้า: สั่ง maintenance-asset-service ให้ dispatch
  // (มันจะ publish เข้า maintenance.line.notification -> consumer ของแอปนี้ทำการ์ด Flex ส่งเข้ากลุ่ม
  //  และส่งอีเมลให้ผู้รับของแต่ละหมวดด้วยในคำสั่งเดียว)
  const docExpiryCron = config.scheduler.docExpiryCron
  if (docExpiryCron && config.maintenance.apiUrl) {
    if (!cron.validate(docExpiryCron)) {
      console.error(`[scheduler] รูปแบบ MT_DOC_EXPIRY_CRON ไม่ถูกต้อง: ${docExpiryCron}`)
    } else {
      cron.schedule(
        docExpiryCron,
        async () => {
          console.log(`[scheduler] เริ่มงานแจ้งเตือนเอกสารใกล้หมดอายุ ${new Date().toLocaleString('th-TH', { timeZone: tz })}`)
          // runDocumentExpiryDispatch ไม่ throw: ตัวตั้งเวลาต้องไม่ล้มเพราะปลายทางตอบไม่ได้
          const summary = await runDocumentExpiryDispatch('cron')
          printDocumentExpiryRun(summary)
          if (!summary.ok && summary.error) {
            console.error(`[scheduler]   แจ้งเตือนเอกสารไม่สมบูรณ์: ${summary.error}`)
          }
        },
        { timezone: tz }
      )
      console.log(`[scheduler] ตั้งงานแจ้งเตือนเอกสารใกล้หมดอายุไว้ที่ "${docExpiryCron}" (${tz}) -> ${config.maintenance.apiUrl}`)
    }
  } else if (docExpiryCron && !config.maintenance.apiUrl) {
    // ตั้งเวลาไว้แต่ไม่รู้จะเรียกใคร: บอกให้ชัด ดีกว่าเงียบแล้วไม่มีการ์ดมาทุกเช้า
    console.warn('[scheduler] ข้ามงานแจ้งเตือนเอกสารใกล้หมดอายุ: ยังไม่ได้ตั้ง MAINTENANCE_API_URL')
  }

  // ระบบรับเรื่องร้องเรียน: การ์ดสรุปเรื่องค้าง -> COMPLAINT_DIGEST_GROUP_IDS (ว่าง = ปิด)
  const digestCron = config.complaint.digestCron
  if (digestCron) {
    if (!cron.validate(digestCron)) console.error(`[scheduler] รูปแบบ COMPLAINT_DIGEST_CRON ไม่ถูกต้อง: ${digestCron}`)
    else {
      cron.schedule(
        digestCron,
        async () => {
          console.log(`[scheduler] เริ่มงานสรุปเรื่องร้องเรียนค้าง ${new Date().toLocaleString('th-TH', { timeZone: tz })}`)
          try {
            await runComplaintDigest()
          } catch (err) {
            console.error('[scheduler] งานสรุปเรื่องร้องเรียนผิดพลาด:', err instanceof Error ? err.message : err)
          }
        },
        { timezone: tz }
      )
      console.log(`[scheduler] ตั้งงานสรุปเรื่องร้องเรียนค้างไว้ที่ "${digestCron}" (${tz})`)
    }
  }
}
