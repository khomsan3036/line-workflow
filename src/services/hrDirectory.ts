import { config } from '../config'

// ---------------------------------------------------------------------------
// แปลง "ผู้แจ้ง" ที่ระบบซ่อมบำรุงประทับไว้ (อีเมล เช่น apichai_c@qtec.co.th หรือ 69-1-018@qtec.co.th
// สำหรับบัญชีที่ลงทะเบียนด้วยรหัสพนักงาน) ให้เป็นชื่อคน เพื่อให้การ์ดอ่านง่าย
//
// แหล่งข้อมูล: ทะเบียนพนักงานของ HRMS (employee-master) โหลดทั้งก้อนครั้งเดียวแล้ว cache ไว้
// (MAINTENANCE_HR_DIRECTORY_TTL_MINUTES) ทำ map ทั้งจากอีเมลและรหัสพนักงาน -> ชื่อ
// ถ้าไม่เจอในทะเบียน และส่วนหน้า @ เป็นรหัสพนักงาน จะถาม /api/emp/auth?code= ทีละคน (จำผลไว้เช่นกัน)
// ทุกอย่าง best-effort: หาไม่ได้/HR ล่ม -> ใช้ข้อความเดิม การ์ดไม่พัง
// ---------------------------------------------------------------------------

interface MasterPerson {
  empId?: string | null
  firstName?: string | null
  lastName?: string | null
  email?: string | null
}

/** ชื่อตามรหัสพนักงาน / อีเมล (คีย์เป็นตัวพิมพ์เล็ก) */
let names = new Map<string, string>()
let loadedAt = 0
let inflight: Promise<void> | null = null
/** ผลการถาม emp/auth รายคน (รวมที่หาไม่เจอ = '') */
const byCode = new Map<string, string>()

const EMPLOYEE_NO = /^[a-z]?\d{2}-\d-\d{3}$/i
const PLACEHOLDER = 'อยู่ระหว่างอัพเดทข้อมูล'

function authHeaders(): Record<string, string> {
  const hr = config.maintenance.hr
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (hr.token) headers.Authorization = `Bearer ${hr.token}`
  if (hr.apiKey) headers['X-Api-Key'] = hr.apiKey
  return headers
}

async function loadMaster(): Promise<void> {
  const hr = config.maintenance.hr
  if (!hr.masterUrl) return
  const res = await fetch(hr.masterUrl, { headers: authHeaders(), signal: AbortSignal.timeout(hr.timeoutMs) })
  if (!res.ok) throw new Error(`employee-master ${res.status}`)
  const body = (await res.json()) as { people?: MasterPerson[] }
  const next = new Map<string, string>()
  for (const p of body.people ?? []) {
    const first = (p.firstName ?? '').trim()
    const last = (p.lastName ?? '').trim()
    if (!first || first === PLACEHOLDER) continue
    const name = `${first} ${last}`.trim()
    const code = (p.empId ?? '').trim().toLowerCase()
    const email = (p.email ?? '').trim().toLowerCase()
    if (code) next.set(code, name)
    if (email) next.set(email, name)
  }
  names = next
  loadedAt = Date.now()
}

/** โหลด/รีเฟรชทะเบียนเมื่อหมดอายุ (คนที่เรียกพร้อมกันรอตัวเดียว) ล้มเหลว = ใช้ของเดิม */
async function ensureMaster(): Promise<void> {
  const ttl = config.maintenance.hr.ttlMinutes * 60 * 1000
  if (names.size > 0 && Date.now() - loadedAt < ttl) return
  if (!inflight) {
    inflight = loadMaster()
      .catch((err) => {
        console.warn('[HR] โหลดทะเบียนพนักงานไม่สำเร็จ ใช้ชื่อเดิมไปก่อน:', err instanceof Error ? err.message : err)
        // อย่าถามซ้ำรัว ๆ ตอน HR ล่ม: ถือว่าเพิ่งโหลด (ของเดิมหรือว่าง) ไปอีกหนึ่งรอบ
        loadedAt = Date.now()
      })
      .finally(() => {
        inflight = null
      })
  }
  await inflight
}

/** ถาม /api/emp/auth?code= สำหรับรหัสพนักงานที่ไม่อยู่ในทะเบียนก้อนใหญ่ */
async function lookupByCode(code: string): Promise<string> {
  const key = code.toLowerCase()
  const cached = byCode.get(key)
  if (cached !== undefined) return cached
  const hr = config.maintenance.hr
  let name = ''
  if (hr.empAuthUrl) {
    try {
      const res = await fetch(`${hr.empAuthUrl}?code=${encodeURIComponent(code.toUpperCase())}`, {
        headers: authHeaders(),
        signal: AbortSignal.timeout(hr.timeoutMs)
      })
      if (res.ok) {
        const body = (await res.json()) as { isSuccess?: boolean; result?: { name?: string | null; surname?: string | null } | null }
        if (body.isSuccess && body.result) name = `${body.result.name ?? ''} ${body.result.surname ?? ''}`.trim()
      }
    } catch {
      // ไม่จำผลที่ล้มเหลวจาก network ไว้ จะได้ลองใหม่ครั้งหน้า
      return ''
    }
  }
  byCode.set(key, name)
  return name
}

/**
 * ชื่อคนจากอีเมล/รหัสพนักงานที่ประทับไว้ (null = หาไม่ได้)
 * รับทั้ง "apichai_c@qtec.co.th", "69-1-018@qtec.co.th" และ "69-1-018"
 */
export async function resolvePersonName(stamp: string | null | undefined): Promise<string | null> {
  const value = (stamp ?? '').trim()
  if (!value || !config.maintenance.hr.enabled) return null
  const local = value.split('@')[0] ?? value
  await ensureMaster()
  const hit = names.get(value.toLowerCase()) ?? names.get(local.toLowerCase())
  if (hit) return hit
  if (EMPLOYEE_NO.test(local)) {
    const name = await lookupByCode(local)
    if (name) return name
  }
  return null
}

/** สถานะสำหรับ /health */
export function hrDirectoryStatus(): Record<string, unknown> {
  const hr = config.maintenance.hr
  return { enabled: hr.enabled, people: names.size, loadedAt: loadedAt ? new Date(loadedAt).toISOString() : null }
}
