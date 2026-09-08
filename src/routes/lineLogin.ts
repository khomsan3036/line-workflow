import type { Request, Response, Router } from 'express'
import { asyncRouter } from '../middleware/asyncRouter'
import { config } from '../config'
import {
  AuthError,
  empFullName,
  fetchEmpInfo,
  fetchProfile,
  lineLogin,
  linkLineAccount,
  login,
  prsNoFromProfile,
  type AuthProfile
} from '../services/authApi'
import { saveVerifiedEmployeeLink } from '../services/employeeLinks'
import {
  authorizeUrl,
  consumeLoginState,
  exchangeAndVerify,
  getLoginState,
  LineLoginError,
  stashIdentity,
  type LoginState
} from '../services/lineLogin'
import { isValidPrsNo, normalizePrsNo } from '../services/manpowerApi'
import { sendAndLog } from '../services/messaging'

// ---------------------------------------------------------------------------
// หน้ายืนยันตัวตนด้วย LINE Login (เปิดจากปุ่มในแชท 1:1 กับ OA)
//
//   GET  /line-login/start?s=<state>        ตรวจ state แล้วพาไปหน้าอนุญาตของ LINE
//   GET  /line-login/callback?code&state    LINE ส่งกลับ -> แลก code -> ถามบริการ auth กลาง
//                                            - เคยผูก LINE กับบัญชีแล้ว  -> ผูกรหัสพนักงานให้ทันที
//                                            - ยังไม่เคย                 -> แสดงฟอร์มรหัสพนักงาน + รหัสผ่าน
//   POST /line-login/link                    ล็อกอินด้วยรหัสผ่าน -> LineLink -> ผูกรหัสพนักงาน
//
// ทุกหน้าไม่ต้องล็อกอิน admin เพราะผู้ใช้คือพนักงานทั่วไป ความปลอดภัยอยู่ที่ state แบบใช้ครั้งเดียว
// และการตรวจ ID token กับ LINE / บริการ auth กลาง
// ---------------------------------------------------------------------------

interface ResultView {
  ok: boolean
  title: string
  message: string
  detail?: string
  employee?: { prsNo: string; fullName: string | null; position: string | null; dept: string | null }
}

function renderResult(res: Response, view: ResultView, status = 200): void {
  res.status(status).render('line-login/result', { ...view, title: view.title })
}

function notConfigured(res: Response): void {
  renderResult(
    res,
    {
      ok: false,
      title: 'ยังไม่เปิดใช้ LINE Login',
      message: 'ระบบยังไม่ได้ตั้งค่า LINE_LOGIN_CHANNEL_ID / LINE_LOGIN_CHANNEL_SECRET กรุณาแจ้งฝ่ายไอที'
    },
    503
  )
}

function invalidState(res: Response): void {
  renderResult(
    res,
    {
      ok: false,
      title: 'ลิงก์หมดอายุหรือถูกใช้ไปแล้ว',
      message: 'กลับไปที่แชทกับ HR Notification แล้วพิมพ์ "เวลาเข้างานของฉัน" เพื่อขอลิงก์ยืนยันตัวตนใหม่'
    },
    400
  )
}

/**
 * ผูกรหัสพนักงานให้ LINE userId ของแชท หลังรู้แล้วว่าเป็นบัญชีไหน
 * ดึงชื่อ/ตำแหน่ง/แผนกจากสมุดรายชื่อ HR แบบ best-effort (ไม่มีก็ผูกได้)
 */
async function finishLink(
  row: LoginState,
  profile: AuthProfile,
  verifiedBy: 'line-login' | 'line-login+password'
): Promise<ResultView> {
  const prsNo = prsNoFromProfile(profile)
  if (!prsNo) {
    return {
      ok: false,
      title: 'บัญชีนี้ไม่ได้ผูกกับรหัสพนักงาน',
      message: `บัญชี "${profile.username ?? profile.email ?? '-'}" ไม่ได้ใช้รหัสพนักงานเป็นชื่อล็อกอิน จึงดูเวลาเข้างานไม่ได้`,
      detail: 'กรุณาเข้าสู่ระบบด้วยบัญชีที่สมัครด้วยรหัสพนักงาน (เช่น S69-1-003) หรือติดต่อฝ่ายบุคคล ต่อ 101'
    }
  }

  let fullName: string | null = profile.firstName?.trim() || null
  let position: string | null = null
  let dept: string | null = null
  try {
    const emp = await fetchEmpInfo(prsNo)
    if (emp) {
      fullName = empFullName(emp) || fullName
      position = emp.position?.trim() || null
      dept = emp.dept?.trim() || null
    }
  } catch (err) {
    console.warn('[LINE Login] ดึงข้อมูลพนักงานไม่สำเร็จ (ข้าม):', err instanceof Error ? err.message : err)
  }

  await saveVerifiedEmployeeLink(row.line_user_id, {
    prsNo,
    fullName,
    position,
    dept,
    verifiedBy,
    authUserId: profile.id ?? null,
    authUsername: profile.username ?? null,
    lineDisplayName: row.display_name
  })
  await consumeLoginState(row.state)
  console.log(`[LINE Login] ผูก ${row.line_user_id} -> ${prsNo} (${verifiedBy})`)

  // แจ้งในแชทว่าผูกสำเร็จ (push ไปที่ userId ของ Messaging API ซึ่งเป็นคนที่กดปุ่ม)
  await sendAndLog({
    targetType: 'user',
    targetId: row.line_user_id,
    targetName: fullName ?? prsNo,
    kind: 'text',
    text: [
      `ยืนยันตัวตนสำเร็จครับ ผูก LINE นี้กับรหัสพนักงาน ${prsNo}${fullName ? ` (${fullName})` : ''} แล้ว`,
      'พิมพ์ "เวลาเข้างานของฉัน" เพื่อดูเวลาเข้า-ออกวันนี้ได้เลย',
      'ถ้าต้องการยกเลิก พิมพ์ "ยกเลิกรหัสพนักงาน"'
    ].join('\n'),
    sentBy: 'line-login:linked'
  })

  return {
    ok: true,
    title: 'ยืนยันตัวตนสำเร็จ',
    message: 'ผูก LINE ของคุณกับรหัสพนักงานเรียบร้อยแล้ว กลับไปที่แชทแล้วพิมพ์ "เวลาเข้างานของฉัน" ได้เลย',
    employee: { prsNo, fullName, position, dept }
  }
}

export function createLineLoginRouter(): Router {
  const router = asyncRouter()

  // 1) ปุ่มในแชท -> ตรวจ state -> ไป LINE
  router.get('/line-login/start', async (req: Request, res: Response) => {
    if (!config.lineLogin.enabled) return notConfigured(res)
    const state = typeof req.query.s === 'string' ? req.query.s : ''
    const row = await getLoginState(state)
    if (!row) return invalidState(res)
    res.redirect(authorizeUrl(row))
  })

  // 2) LINE ส่งกลับมา
  router.get('/line-login/callback', async (req: Request, res: Response) => {
    if (!config.lineLogin.enabled) return notConfigured(res)

    const state = typeof req.query.state === 'string' ? req.query.state : ''
    const row = await getLoginState(state)
    if (!row) return invalidState(res)

    const lineError = typeof req.query.error === 'string' ? req.query.error : ''
    if (lineError) {
      return renderResult(
        res,
        {
          ok: false,
          title: lineError === 'access_denied' ? 'ยกเลิกการยืนยันตัวตน' : 'LINE ไม่อนุญาต',
          message:
            lineError === 'access_denied'
              ? 'คุณกดยกเลิกในหน้าอนุญาตของ LINE กลับไปที่แชทแล้วกดปุ่มยืนยันตัวตนอีกครั้งเมื่อพร้อม'
              : `LINE ตอบกลับ: ${lineError}`
        },
        400
      )
    }

    const code = typeof req.query.code === 'string' ? req.query.code : ''
    if (!code) return invalidState(res)

    // แลก code -> ID token ที่ LINE ตรวจแล้ว
    let identity
    try {
      identity = await exchangeAndVerify(code, row.nonce)
    } catch (err) {
      const msg = err instanceof LineLoginError ? err.userMessage : 'ติดต่อ LINE ไม่สำเร็จ'
      console.error('[LINE Login] แลก code ไม่สำเร็จ:', err instanceof Error ? err.message : err)
      return renderResult(res, { ok: false, title: 'ยืนยันกับ LINE ไม่ผ่าน', message: msg }, 401)
    }

    // กันคนอื่นเอาลิงก์ไปเปิด: userId ที่ล็อกอิน LINE ต้องเป็นคนเดียวกับที่กดปุ่มในแชท
    // (ใช้ได้เมื่อ Messaging API channel และ LINE Login channel อยู่ provider เดียวกัน)
    if (config.lineLogin.requireSameUser && identity.sub !== row.line_user_id) {
      console.warn(`[LINE Login] userId ไม่ตรง: แชท ${row.line_user_id} แต่ LINE Login ได้ ${identity.sub}`)
      return renderResult(
        res,
        {
          ok: false,
          title: 'บัญชี LINE ไม่ตรงกัน',
          message: 'บัญชี LINE ที่ใช้ยืนยันไม่ใช่บัญชีเดียวกับที่กดปุ่มในแชท กรุณาเปิดลิงก์จากในแอป LINE ของคุณเอง',
          detail:
            'ถ้าเป็นบัญชีเดียวกันแต่ยังขึ้นหน้านี้ แสดงว่า LINE Login channel กับ Messaging API channel อยู่คนละ provider ให้ฝ่ายไอทีตั้ง LINE_LOGIN_REQUIRE_SAME_USER=false'
        },
        403
      )
    }

    await stashIdentity(row.state, identity)

    // เคยผูก LINE กับบัญชีในระบบ auth กลางแล้ว -> ได้ token ทันที ไม่ต้องกรอกรหัสผ่าน
    try {
      const session = await lineLogin(identity.idToken)
      if (session) {
        const profile = await fetchProfile(session.token)
        const view = await finishLink({ ...row, display_name: identity.displayName }, profile, 'line-login')
        return renderResult(res, view, view.ok ? 200 : 403)
      }
    } catch (err) {
      // ตรวจไม่ผ่านหรือบริการล่ม -> ให้ลองทางรหัสผ่านต่อ ไม่ dead-end
      console.warn('[LINE Login] LineLogin ไม่สำเร็จ ให้กรอกรหัสผ่านแทน:', err instanceof Error ? err.message : err)
    }

    // ยังไม่เคยผูก -> ฟอร์มรหัสพนักงาน + รหัสผ่าน (ครั้งเดียว)
    res.render('line-login/link', {
      title: 'ผูกรหัสพนักงานกับ LINE',
      state: row.state,
      displayName: identity.displayName,
      pictureUrl: identity.pictureUrl,
      error: null,
      username: ''
    })
  })

  // 3) ฟอร์มครั้งแรก: ล็อกอินด้วยรหัสผ่าน แล้ว LineLink
  router.post('/line-login/link', async (req: Request, res: Response) => {
    if (!config.lineLogin.enabled) return notConfigured(res)

    const body = (req.body ?? {}) as Record<string, string>
    const state = typeof body.state === 'string' ? body.state : ''
    const row = await getLoginState(state)
    if (!row || !row.id_token) return invalidState(res)

    const username = normalizePrsNo(body.username ?? '')
    const password = body.password ?? ''

    const renderForm = (error: string, status = 400) =>
      res.status(status).render('line-login/link', {
        title: 'ผูกรหัสพนักงานกับ LINE',
        state: row.state,
        displayName: row.display_name ?? '',
        pictureUrl: null,
        error,
        username
      })

    if (!isValidPrsNo(username)) return renderForm('รูปแบบรหัสพนักงานไม่ถูกต้อง เช่น S69-1-003 หรือ 20-1-026')
    if (!password) return renderForm('กรุณากรอกรหัสผ่าน')

    let token: string
    try {
      token = (await login(username, password)).token
    } catch (err) {
      const msg = err instanceof AuthError ? err.message : 'เข้าสู่ระบบไม่สำเร็จ'
      console.warn(`[LINE Login] ล็อกอิน ${username} ไม่สำเร็จ: ${msg}`)
      return renderForm(
        err instanceof AuthError && err.status === 401
          ? 'รหัสพนักงานหรือรหัสผ่านไม่ถูกต้อง'
          : `เข้าสู่ระบบไม่สำเร็จ: ${msg}`,
        401
      )
    }

    // ผูก LINE กับบัญชีในระบบ auth กลาง (ครั้งต่อไปกดยืนยันได้โดยไม่ต้องกรอกรหัสผ่าน)
    try {
      await linkLineAccount(row.id_token, token)
    } catch (err) {
      console.warn('[LINE Login] LineLink ไม่สำเร็จ (ผูกฝั่งบอทต่อไป):', err instanceof Error ? err.message : err)
    }

    let profile: AuthProfile
    try {
      profile = await fetchProfile(token)
    } catch (err) {
      return renderForm(`โหลดโปรไฟล์ไม่สำเร็จ: ${err instanceof Error ? err.message : String(err)}`, 502)
    }

    // ป้องกันกรณี username ของโปรไฟล์ไม่ตรงกับที่กรอก (บัญชีล็อกอินด้วยอีเมล ฯลฯ)
    if (profile.username && normalizePrsNo(profile.username) !== username) {
      console.warn(`[LINE Login] username โปรไฟล์ ${profile.username} ไม่ตรงกับที่กรอก ${username}`)
    }

    const view = await finishLink(row, profile, 'line-login+password')
    renderResult(res, view, view.ok ? 200 : 403)
  })

  return router
}
