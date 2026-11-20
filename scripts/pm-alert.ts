// รันมือ: สั่ง pm-service ส่งการ์ด "แผน PM เกินกำหนด / ใกล้ถึงรอบ" ของวันนี้ (เหมือนตัวตั้งเวลา MT_PM_CRON)
//   npm run pm-alert
// การ์ดจะไปถึงกลุ่มก็ต่อเมื่อ consumer ของแอปนี้ (npm run dev) ทำงานอยู่ และกันซ้ำวันละครั้งต่อกลุ่ม
import 'dotenv/config'
import { runPmScheduleDispatch } from '../src/services/pmScheduleDispatch'

runPmScheduleDispatch('manual')
  .then((summary) => {
    console.log(`[pm-alert] ${summary.text}`)
    process.exit(summary.ok ? 0 : 1)
  })
  .catch((err) => {
    console.error('[pm-alert] ผิดพลาด:', err instanceof Error ? err.message : err)
    process.exit(1)
  })
