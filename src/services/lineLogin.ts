import { randomBytes } from 'node:crypto'
import { config } from '../config'
import { query, queryOne } from '../db'

// ---------------------------------------------------------------------------
// LINE Login (OAuth 2.1 + OIDC) ฝั่งเซิร์ฟเวอร์ สำหรับยืนยันว่า LINE userId เป็นพนักงานคนไหน
//
//   1) บอทสร้าง state (สุ่ม, ใช้ครั้งเดียว, ผูกกับ userId ของแชท) แล้วส่งปุ่มลิงก์ /line-login/start?s=<state>
//   2) /start พาไป https://access.line.me/oauth2/v2.1/authorize พร้อม state + nonce
//   3) LINE กลับมาที่ /line-login/callback?code&state -> แลก code เป็น id_token ที่ api.line.me
//      แล้วให้ LINE ตรวจลายเซ็น/aud/exp/nonce ของ id_token ให้ (endpoint verify)
//   4) ส่ง id_token ให้บริการ auth กลาง (LineLogin / LineLink) เพื่อหาว่าเป็นบัญชีพนักงานไหน -> authApi.ts
//
// channel secret ของ LINE Login อยู่ที่นี่ที่เดียว ไม่ส่งไปเบราว์เซอร์
// ---------------------------------------------------------------------------

const LINE_AUTHORIZE_URL = 'https://access.line.me/oauth2/v2.1/authorize'
const LINE_TOKEN_URL = 'https://api.line.me/oauth2/v2.1/token'
const LINE_VERIFY_URL = 'https://api.line.me/oauth2/v2.1/verify'

export interface LoginState {
  state: string
  nonce: string
  line_user_id: string
  id_token: string | null
  line_sub: string | null
  display_name: string | null
  created_at: Date
  expires_at: Date
  used_at: Date | null
}

export interface LineIdentity {
  /** userId จาก ID token (sub) */
  sub: string
  displayName: string
  pictureUrl: string | null
  idToken: string
}

export class LineLoginError extends Error {
  constructor(
    message: string,
    /** ข้อความสำหรับแสดงให้ผู้ใช้ (ภาษาไทย) */
    public readonly userMessage: string
  ) {
    super(message)
    this.name = 'LineLoginError'
  }
}

function randomToken(bytes = 16): string {
  return randomBytes(bytes).toString('hex')
}

/** ลิงก์ที่ใส่ในปุ่ม "ยืนยันตัวตน" ในแชท */
export function verifyStartUrl(state: string): string {
  return `${config.publicUrl}${config.basePath}/line-login/start?s=${encodeURIComponent(state)}`
}

/** สร้าง state ใหม่ให้ผู้ใช้คนนี้ (ลบ state เก่าที่หมดอายุทิ้งไปด้วย) */
export async function createLoginState(lineUserId: string): Promise<string> {
  const state = randomToken()
  const nonce = randomToken()
  await query(`DELETE FROM line_login_states WHERE expires_at < now() - interval '1 day'`)
  await query(
    `INSERT INTO line_login_states (state, nonce, line_user_id, expires_at)
     VALUES ($1, $2, $3, now() + ($4 || ' minutes')::interval)`,
    [state, nonce, lineUserId, String(config.lineLogin.stateTtlMinutes)]
  )
  return state
}

/** state ที่ยังใช้ได้ (ไม่หมดอายุ ไม่ถูกใช้ไปแล้ว) */
export async function getLoginState(state: string): Promise<LoginState | null> {
  if (!state || state.length > 64) return null
  return queryOne<LoginState>(
    `SELECT * FROM line_login_states
      WHERE state = $1 AND used_at IS NULL AND expires_at > now()`,
    [state]
  )
}

/** เก็บผลจาก LINE ไว้กับ state (ใช้ต่อในขั้นกรอกรหัสผ่านครั้งแรก) และต่ออายุอีก 15 นาที */
export async function stashIdentity(state: string, identity: LineIdentity): Promise<void> {
  await query(
    `UPDATE line_login_states
        SET id_token = $2, line_sub = $3, display_name = $4,
            expires_at = GREATEST(expires_at, now() + interval '15 minutes')
      WHERE state = $1`,
    [state, identity.idToken, identity.sub, identity.displayName]
  )
}

/** ปิด state หลังผูกสำเร็จ (ลบ id_token ทิ้ง ไม่เก็บไว้เกินจำเป็น) */
export async function consumeLoginState(state: string): Promise<void> {
  await query(`UPDATE line_login_states SET used_at = now(), id_token = NULL WHERE state = $1`, [state])
}

/** URL หน้าอนุญาตของ LINE (ผู้ใช้ที่เปิดจากในแอป LINE จะผ่านอัตโนมัติ) */
export function authorizeUrl(row: LoginState): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.lineLogin.channelId,
    redirect_uri: config.lineLogin.callbackUrl,
    state: row.state,
    scope: 'profile openid',
    nonce: row.nonce,
    // ถ้ายังไม่ได้เป็นเพื่อนกับ OA ของ LINE Login channel ให้ชวนเพิ่มเพื่อนแบบไม่บังคับ
    bot_prompt: 'normal'
  })
  return `${LINE_AUTHORIZE_URL}?${params.toString()}`
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    const data: unknown = await res.json()
    if (data && typeof data === 'object') return data as Record<string, unknown>
  } catch {
    /* ไม่ใช่ JSON */
  }
  return {}
}

async function postForm(url: string, form: Record<string, string>): Promise<Response> {
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form),
      signal: AbortSignal.timeout(config.lineLogin.timeoutMs)
    })
  } catch (err) {
    throw new LineLoginError(
      `ติดต่อ LINE ไม่ได้: ${err instanceof Error ? err.message : String(err)}`,
      'ติดต่อ LINE ไม่ได้ในขณะนี้ กรุณาลองใหม่อีกครั้ง'
    )
  }
}

/**
 * แลก authorization code เป็น ID token แล้วให้ LINE ตรวจความถูกต้อง (ลายเซ็น, aud, exp, nonce)
 * คืนตัวตนที่ตรวจแล้ว
 */
export async function exchangeAndVerify(code: string, nonce: string): Promise<LineIdentity> {
  const tokenRes = await postForm(LINE_TOKEN_URL, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.lineLogin.callbackUrl,
    client_id: config.lineLogin.channelId,
    client_secret: config.lineLogin.channelSecret
  })
  const tokenData = await readJson(tokenRes)
  const idToken = tokenData['id_token']
  if (!tokenRes.ok || typeof idToken !== 'string' || !idToken) {
    throw new LineLoginError(
      `แลก code ไม่สำเร็จ (${tokenRes.status}): ${String(tokenData['error_description'] ?? tokenData['error'] ?? 'ไม่มี id_token')}`,
      'LINE ไม่ยอมรับรหัสเข้าสู่ระบบ (ลิงก์อาจถูกใช้ไปแล้ว) กรุณาขอลิงก์ใหม่จากแชท'
    )
  }

  const verifyRes = await postForm(LINE_VERIFY_URL, {
    id_token: idToken,
    client_id: config.lineLogin.channelId,
    nonce
  })
  const claims = await readJson(verifyRes)
  const sub = claims['sub']
  if (!verifyRes.ok || typeof sub !== 'string' || !sub) {
    throw new LineLoginError(
      `ตรวจ ID token ไม่ผ่าน (${verifyRes.status}): ${String(claims['error_description'] ?? claims['error'] ?? 'ไม่มี sub')}`,
      'ตรวจสอบตัวตนกับ LINE ไม่ผ่าน กรุณาขอลิงก์ใหม่จากแชท'
    )
  }

  return {
    sub,
    displayName: typeof claims['name'] === 'string' ? claims['name'] : '',
    pictureUrl: typeof claims['picture'] === 'string' ? claims['picture'] : null,
    idToken
  }
}
