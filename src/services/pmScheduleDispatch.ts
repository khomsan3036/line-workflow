// ---------------------------------------------------------------------------
// ตัวตั้งเวลา "แจ้งเตือนแผน PM เกินกำหนด / ใกล้ถึงรอบ" ทุกเช้า
//
// ทำอะไร: เรียก POST /api/pm-plans/notifications/dispatch ที่ maintenance-pm-service
// ฝั่งนั้นคิดว่าเครื่องไหนเกินกำหนด/ใกล้ถึงรอบ (ตามจำนวนวัน/กม./ชม. ที่ตั้งในหน้าเว็บ "ตั้งค่าแจ้งเตือน")
// แล้ว publish เข้า exchange "maintenance" ด้วย routing key maintenance.line.notification
// consumer ของแอปนี้ (maintenanceEvents.ts) รับไปทำการ์ด Flex (pmScheduleFlex.ts) ส่งเข้ากลุ่มเอง
//
// แบ่งหน้าที่แบบเดียวกับเอกสารใกล้หมดอายุ (documentExpiryDispatch.ts):
//   pm-service เป็นเจ้าของ "อะไรถึงรอบ" และ "ส่งให้กลุ่มไหน" / แอปนี้เป็นเจ้าของ "เวลา" และ "การส่ง LINE"
// ไฟล์นี้ไม่ได้ส่ง LINE เอง ถ้า consumer ไม่ทำงานก็จะไม่มีการ์ด (เห็นได้จาก log ทั้งสองฝั่ง)
// ---------------------------------------------------------------------------

import { config } from '../config'

/** ผลของการสั่ง dispatch (ตรงกับ PmDispatchResult ฝั่ง .NET) */
interface PmDispatchResult {
  overdue: number
  dueSoon: number
  inProgress: number
  lineMessages: number
  skipped?: string | null
}

export interface PmRunSummary {
  ok: boolean
  /** ข้อความสรุปบรรทัดเดียว สำหรับ log */
  text: string
  result?: PmDispatchResult
  error?: string
}

/**
 * สั่งให้ pm-service ยิงแจ้งเตือนแผน PM ของวันนี้
 * ไม่ throw: ตัวตั้งเวลาต้องไม่ล้มเพราะ service เดียวตอบไม่ได้ จึงคืน ok=false พร้อมเหตุผล
 */
export async function runPmScheduleDispatch(trigger = 'scheduler'): Promise<PmRunSummary> {
  const baseUrl = config.maintenance.pmApiUrl
  if (!baseUrl) {
    return { ok: false, text: 'ยังไม่ได้ตั้ง MAINTENANCE_PM_API_URL จึงสั่งแจ้งเตือนแผน PM ไม่ได้', error: 'MAINTENANCE_PM_API_URL ว่าง' }
  }

  const url = `${baseUrl}/api/pm-plans/notifications/dispatch`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), config.maintenance.pmTimeoutMs)

  try {
    const res = await fetch(url, {
      method: 'POST',
      // ฝั่ง pm-service ใช้ค่านี้ลง log ว่าใครสั่ง (ไม่ใช่ user จริง)
      headers: { 'Content-Type': 'application/json', 'X-User': `line-workflow:${trigger}` },
      signal: controller.signal
    })
    const body = (await res.json().catch(() => null)) as { success?: boolean; message?: string; data?: PmDispatchResult } | null

    if (!res.ok || body?.success === false || !body?.data) {
      const reason = body?.message ?? `HTTP ${res.status}`
      return { ok: false, text: `สั่งแจ้งเตือนแผน PM ไม่สำเร็จ: ${reason}`, error: reason }
    }

    const r = body.data
    // "ไม่มีอะไรถึงรอบ" เป็นผลที่ถูกต้อง ไม่ใช่ความผิดพลาด
    const text = r.skipped
      ? `ไม่ได้ส่งการ์ดแผน PM (${r.skipped}) — เกินกำหนด ${r.overdue}, ใกล้ถึงรอบ ${r.dueSoon}`
      : `ส่งการ์ดแผน PM ${r.lineMessages} ข้อความ — เกินกำหนด ${r.overdue}, ใกล้ถึงรอบ ${r.dueSoon}, กำลังทำ ${r.inProgress}`
    return { ok: true, text, result: r }
  } catch (err) {
    const reason =
      err instanceof Error && err.name === 'AbortError'
        ? `หมดเวลารอ ${config.maintenance.pmTimeoutMs} ms`
        : err instanceof Error
          ? err.message
          : String(err)
    return { ok: false, text: `เรียก ${url} ไม่สำเร็จ: ${reason}`, error: reason }
  } finally {
    clearTimeout(timeout)
  }
}
