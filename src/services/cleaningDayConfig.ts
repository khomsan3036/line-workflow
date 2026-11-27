import { config } from '../config'

// ---------------------------------------------------------------------------
// อ่านการตั้งค่า Cleaning Day จาก Integra (integra-notification-service, เมนู "ตั้งค่า Cleaning Day")
//   GET {CLEANING_DAY_CONFIG_API_URL}?date=YYYY-MM-DD -> รายการที่เปิดใช้งาน + วันกิจกรรม 2 ครั้งถัดไป + Lead Team ของเดือนนั้น
// กฎวัน (เสาร์/ศุกร์สุดท้าย, วันที่ 28, รายปี) คำนวณที่ Integra ที่เดียว แอปนี้แค่ดูว่าวันนี้/เวลานี้ต้องส่งการ์ดอะไร
// อ่านไม่ได้ -> ใช้ผลล่าสุดที่อ่านได้ของวันเดียวกัน (ไม่เดาค่าเอง) ไม่มีเลย -> ไม่ส่งรอบนั้นและ log ไว้
// ---------------------------------------------------------------------------

export interface CleaningDayLeadFeed {
  empNo: string
  leadName: string
  position: string
}

export interface CleaningDayOccurrenceFeed {
  period: string
  eventDate: string
  leads: CleaningDayLeadFeed[]
}

export interface CleaningDayScheduleFeed {
  id: string
  name: string
  isEnabled: boolean
  recurrence: 'Monthly' | 'Yearly'
  daysBefore: number
  noticeTime: string
  startTime: string
  endTime: string
  startLeadMinutes: number
  thanksTime: string
  messageText: string
  targetIds: string[]
}

export interface CleaningDayFeedItem {
  schedule: CleaningDayScheduleFeed
  occurrences: CleaningDayOccurrenceFeed[]
}

const lastGood = new Map<string, CleaningDayFeedItem[]>()

export function cleaningDayConfigEnabled(): boolean {
  return config.scheduler.cleaningDayConfigUrl !== ''
}

export async function fetchCleaningDayFeed(date: string): Promise<CleaningDayFeedItem[]> {
  const url = `${config.scheduler.cleaningDayConfigUrl}?date=${encodeURIComponent(date)}`
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const body = (await res.json()) as { success?: boolean; data?: CleaningDayFeedItem[]; message?: string }
    if (!body.success || !Array.isArray(body.data)) throw new Error(body.message || 'คำตอบไม่ใช่ feed')
    lastGood.clear()
    lastGood.set(date, body.data)
    return body.data
  } catch (err) {
    const cached = lastGood.get(date)
    const why = err instanceof Error ? err.message : String(err)
    if (cached) {
      console.warn(`[cleaning-day] อ่านการตั้งค่าจาก Integra ไม่ได้ (${why}) ใช้ผลล่าสุดของวันนี้แทน`)
      return cached
    }
    throw new Error(`อ่านการตั้งค่า Cleaning Day จาก Integra ไม่ได้: ${why}`)
  }
}
