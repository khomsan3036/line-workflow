import { config } from '../config'
import { isValidPrsNo, normalizePrsNo } from './manpowerApi'

// ---------------------------------------------------------------------------
// ไคลเอนต์ของบริการยืนยันตัวตนกลาง QTEC (qtecintegra) และสมุดรายชื่อพนักงาน
// พอร์ตมาจาก qtec-integra/lib/api/auth-api.ts เฉพาะส่วนที่บอทใช้
//
//   POST {AUTH_API}/api/v1/auth/LineLogin   { idToken }          -> token (ถ้าเคยผูก LINE แล้ว) หรือ null
//   POST {AUTH_API}/api/v1/auth/login       { username, password } -> token
//   POST {AUTH_API}/api/v1/auth/LineLink    { idToken } + Bearer  -> ผูก LINE กับบัญชีที่ล็อกอินอยู่
//   GET  {AUTH_API}/api/v1/Auth/Profile     Bearer                -> โปรไฟล์ (username = รหัสพนักงาน)
//   GET  {EMP_AUTH_API}?code=S69-1-003                            -> ข้อมูลพนักงานจาก HR
//
// บริการนี้ตอบ HTTP 200 พร้อม isSuccess=true แม้รหัสผ่านผิด (token จะเป็น null) ต้องตรวจเอง
// ---------------------------------------------------------------------------

interface AuthEnvelope<T> {
  statusCode: number
  isSuccess: boolean
  email: string | null
  errorMessages: string[]
  result: T | null
}

interface LoginResult {
  status: string
  message: string
  token: string | null
  expiration: string | null
}

export interface AuthProfile {
  id: string
  /** ชื่อล็อกอิน = รหัสพนักงาน (prs_no) สำหรับบัญชีที่พนักงานสมัครเอง */
  username?: string
  email: string
  firstName: string
  photoUrl: string
  roles: string
  company: string
}

export interface AuthSession {
  token: string
  expiration: string | null
}

/** ข้อมูลพนักงานจากสมุดรายชื่อ HR (ชื่อฟิลด์ตาม backend) */
export interface EmpInfo {
  prS_NO: string
  title: string
  name: string
  surname: string
  position: string
  dept: string
  emP_TYPE: string
  email: string | null
}

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly status?: number
  ) {
    super(message)
    this.name = 'AuthError'
  }
}

function extractErrorMessage(envelope: AuthEnvelope<unknown> | null, fallback: string, status: number): string {
  const fromMessages = envelope?.errorMessages?.find((m) => typeof m === 'string' && m.trim().length > 0)
  if (fromMessages) return fromMessages.trim()
  if (typeof envelope?.result === 'string' && envelope.result.trim()) return envelope.result.trim()
  const problem = envelope as Record<string, unknown> | null
  const errors = problem?.['errors']
  if (errors && typeof errors === 'object') {
    const flat = Object.values(errors as Record<string, unknown>)
      .flat()
      .filter((m): m is string => typeof m === 'string' && m.trim().length > 0)
    if (flat.length) return flat.join(' ')
  }
  if (typeof problem?.['title'] === 'string' && problem['title'].trim()) return problem['title'].trim()
  return `${fallback} (${status})`
}

async function request(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(config.auth.timeoutMs) })
  } catch (err) {
    throw new AuthError(`ติดต่อบริการยืนยันตัวตนไม่ได้ (${err instanceof Error ? err.message : String(err)})`)
  }
}

async function readEnvelope<T>(res: Response, fallback: string): Promise<T> {
  let envelope: AuthEnvelope<T> | null = null
  try {
    envelope = (await res.json()) as AuthEnvelope<T>
  } catch {
    envelope = null
  }
  if (!res.ok || !envelope?.isSuccess || envelope.result == null) {
    throw new AuthError(extractErrorMessage(envelope, fallback, res.status), res.status)
  }
  return envelope.result
}

const JSON_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json' }

/** ล็อกอินด้วยรหัสพนักงาน + รหัสผ่าน */
export async function login(username: string, password: string): Promise<AuthSession> {
  const res = await request(`${config.auth.apiUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ username, password })
  })
  const result = await readEnvelope<LoginResult>(res, 'เข้าสู่ระบบไม่สำเร็จ')
  if (!result.token) throw new AuthError(result.message || 'รหัสพนักงานหรือรหัสผ่านไม่ถูกต้อง', 401)
  return { token: result.token, expiration: result.expiration }
}

/**
 * เข้าสู่ระบบด้วย ID token จาก LINE Login (บริการจะตรวจกับ LINE ซ้ำเอง)
 * คืน null เมื่อยังไม่มีบัญชีไหนผูกกับ LINE นี้ (ต้องไปขั้นกรอกรหัสผ่านครั้งแรก)
 */
export async function lineLogin(idToken: string): Promise<AuthSession | null> {
  const res = await request(`${config.auth.apiUrl}/api/v1/auth/LineLogin`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ idToken })
  })
  const result = await readEnvelope<LoginResult>(res, 'เข้าสู่ระบบด้วย LINE ไม่สำเร็จ')
  if (!result.token) return null
  return { token: result.token, expiration: result.expiration }
}

/** ผูก LINE (จาก ID token) เข้ากับบัญชีที่ล็อกอินอยู่ ครั้งต่อไปจะเข้าด้วย LINE ได้ทันที */
export async function linkLineAccount(idToken: string, token: string): Promise<void> {
  const res = await request(`${config.auth.apiUrl}/api/v1/auth/LineLink`, {
    method: 'POST',
    headers: { ...JSON_HEADERS, Authorization: `Bearer ${token}` },
    body: JSON.stringify({ idToken })
  })
  await readEnvelope<unknown>(res, 'ผูกบัญชี LINE ไม่สำเร็จ')
}

/** โปรไฟล์ของบัญชีที่ล็อกอินอยู่ (username = รหัสพนักงาน) */
export async function fetchProfile(token: string): Promise<AuthProfile> {
  const res = await request(`${config.auth.apiUrl}/api/v1/Auth/Profile`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` }
  })
  return readEnvelope<AuthProfile>(res, 'โหลดโปรไฟล์ไม่สำเร็จ')
}

/**
 * ดึงรหัสพนักงานจากโปรไฟล์ (username) คืน null ถ้าบัญชีนี้ไม่ได้ใช้รหัสพนักงานเป็นชื่อล็อกอิน
 * (เช่น บัญชีผู้ดูแลที่ล็อกอินด้วยอีเมล) ซึ่งผูกกับข้อมูลเวลาเข้างานไม่ได้
 */
export function prsNoFromProfile(profile: AuthProfile): string | null {
  const username = (profile.username ?? '').trim()
  if (!username) return null
  const code = normalizePrsNo(username)
  return isValidPrsNo(code) ? code : null
}

/**
 * ค้นข้อมูลพนักงานจากสมุดรายชื่อ HR ตามรหัส คืน null เมื่อไม่พบ
 * throw เฉพาะเมื่อเซิร์ฟเวอร์ล่ม (5xx) หรือติดต่อไม่ได้
 */
export async function fetchEmpInfo(code: string): Promise<EmpInfo | null> {
  const res = await request(`${config.auth.empApiUrl}?code=${encodeURIComponent(code)}`, {
    headers: { Accept: 'application/json' }
  })
  if (res.status >= 400 && res.status < 500) return null
  let envelope: AuthEnvelope<EmpInfo> | null = null
  try {
    envelope = (await res.json()) as AuthEnvelope<EmpInfo>
  } catch {
    envelope = null
  }
  if (!res.ok) throw new AuthError(envelope?.errorMessages?.[0] ?? `ค้นหาพนักงานไม่สำเร็จ (${res.status})`, res.status)
  if (!envelope?.isSuccess || !envelope.result?.prS_NO) return null
  return envelope.result
}

/** ชื่อเต็มแบบไทย "น.ส.สมหญิง ใจดี" จากข้อมูลสมุดรายชื่อ */
export function empFullName(emp: EmpInfo): string {
  return `${emp.title ?? ''}${emp.name ?? ''} ${emp.surname ?? ''}`.trim()
}
