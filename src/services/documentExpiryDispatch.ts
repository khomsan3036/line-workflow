// ---------------------------------------------------------------------------
// ตัวตั้งเวลา "แจ้งเตือนเอกสารใกล้หมดอายุ" ทุกเช้า
//
// ทำอะไร: เรียก POST /api/document-alerts/dispatch ที่ maintenance-asset-service
// ฝั่งนั้นจะคิดว่าหมวดไหนเข้าเงื่อนไขแจ้งเตือน (ตามจำนวนวันที่ตั้งไว้ของแต่ละหมวด)
// แล้ว publish เข้า exchange "maintenance" ด้วย routing key maintenance.line.notification
// ซึ่ง consumer ของแอปนี้ (maintenanceEvents.ts) รับไปทำการ์ด Flex ส่งเข้ากลุ่มเอง
//
// ทำไมเรียก dispatch ไม่ใช่ /due แล้วส่งเอง:
//   - ส่งอีเมลกับ LINE ด้วยคำสั่งเดียว ไม่ต้องมีสองที่คิดว่า "วันนี้ต้องแจ้งอะไร"
//   - ข้อความ/การ์ด/การกันซ้ำ ใช้ทางเดิมที่ทดสอบแล้วทั้งหมด
//   - asset service เป็นเจ้าของเนื้อหา แอปนี้เป็นเจ้าของ "เวลา" กับ "ปลายทาง" เท่านั้น
//
// ไม่ได้ส่งอะไรเองในไฟล์นี้ ถ้า consumer ไม่ทำงานก็จะไม่มีการ์ด (เห็นได้จาก log ทั้งสองฝั่ง)
// ---------------------------------------------------------------------------

import { config } from '../config'

/** ผลของการสั่ง dispatch หนึ่งหมวด (ตรงกับ AlertDispatchResultDto ฝั่ง .NET) */
interface DispatchResult {
  category: string
  alerts: number
  lineMessages: number
  emailRecipients: number
  emailsSent: number
  emailsFailed: number
  emailErrors?: string[]
  skipped?: string | null
}

export interface DocExpiryRunSummary {
  ok: boolean
  /** ข้อความสรุปบรรทัดเดียว สำหรับ log และหน้า admin */
  text: string
  results: DispatchResult[]
  error?: string
}

/**
 * สั่งให้ระบบซ่อมบำรุงยิงแจ้งเตือนเอกสารใกล้หมดอายุของวันนี้
 *
 * ไม่ throw: ตัวตั้งเวลาต้องไม่ล้มทั้งตัวเพราะ service เดียวตอบไม่ได้ จึงคืน ok=false
 * พร้อมเหตุผลให้ caller เขียน log เอง
 */
export async function runDocumentExpiryDispatch(trigger = 'scheduler'): Promise<DocExpiryRunSummary> {
  const baseUrl = config.maintenance.apiUrl
  if (!baseUrl) {
    return {
      ok: false,
      text: 'ยังไม่ได้ตั้ง MAINTENANCE_API_URL จึงสั่ง dispatch ไม่ได้',
      results: [],
      error: 'MAINTENANCE_API_URL ว่าง'
    }
  }

  const url = `${baseUrl}/api/document-alerts/dispatch`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), config.maintenance.docExpiryTimeoutMs)

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // ฝั่ง asset service ใช้ค่านี้ลง audit ว่าใครสั่ง (ไม่ใช่ user จริง)
        'X-User': `line-workflow:${trigger}`
      },
      signal: controller.signal
    })

    const body = (await res.json().catch(() => null)) as { success?: boolean; message?: string; data?: DispatchResult[] } | null

    if (!res.ok || body?.success === false) {
      const reason = body?.message ?? `HTTP ${res.status}`
      return { ok: false, text: `สั่ง dispatch ไม่สำเร็จ: ${reason}`, results: [], error: reason }
    }

    const results = Array.isArray(body?.data) ? body!.data! : []
    const sentCategories = results.filter((r) => r.lineMessages > 0 || r.emailsSent > 0)
    const alerts = results.reduce((sum, r) => sum + r.alerts, 0)
    const lineMessages = results.reduce((sum, r) => sum + r.lineMessages, 0)
    const emailsSent = results.reduce((sum, r) => sum + r.emailsSent, 0)
    const emailsFailed = results.reduce((sum, r) => sum + r.emailsFailed, 0)

    // "ไม่มีอะไรต้องแจ้ง" เป็นผลลัพธ์ที่ถูกต้อง ไม่ใช่ความผิดพลาด — เขียน log ให้ต่างกันชัดเจน
    const text =
      sentCategories.length === 0
        ? `ไม่มีเอกสารเข้าเงื่อนไขแจ้งเตือนวันนี้ (ตรวจ ${results.length} หมวด)`
        : `แจ้งเตือน ${sentCategories.length} หมวด (${alerts} รายการ): LINE ${lineMessages} ข้อความ, อีเมล ${emailsSent} ฉบับ` +
          (emailsFailed > 0 ? `, อีเมลล้มเหลว ${emailsFailed}` : '')

    return { ok: emailsFailed === 0, text, results }
  } catch (err) {
    const reason =
      err instanceof Error && err.name === 'AbortError'
        ? `หมดเวลารอ ${config.maintenance.docExpiryTimeoutMs} ms`
        : err instanceof Error
          ? err.message
          : String(err)
    return { ok: false, text: `เรียก ${url} ไม่สำเร็จ: ${reason}`, results: [], error: reason }
  } finally {
    clearTimeout(timeout)
  }
}

/** พิมพ์ผลแบบละเอียดลง log (ใช้ตอนรันมือและตอน cron ทำงาน) */
export function printDocumentExpiryRun(summary: DocExpiryRunSummary): void {
  console.log(`[doc-expiry] ${summary.text}`)
  for (const r of summary.results) {
    if (r.skipped) {
      console.log(`[doc-expiry]   ${r.category}: ข้าม (${r.skipped})`)
      continue
    }
    console.log(
      `[doc-expiry]   ${r.category}: ${r.alerts} รายการ -> LINE ${r.lineMessages}, อีเมล ${r.emailsSent}/${r.emailRecipients}` +
        (r.emailsFailed > 0 ? ` (ล้มเหลว ${r.emailsFailed}: ${(r.emailErrors ?? []).join('; ')})` : '')
    )
  }
}
