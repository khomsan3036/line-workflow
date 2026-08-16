import bcrypt from 'bcryptjs'
import type { NextFunction, Request, Response } from 'express'
import { config } from '../config'

// ---------------------------------------------------------------------------
// ระบบล็อกอินง่าย ๆ สำหรับ Admin Dashboard
//   - เก็บบัญชีไว้ในไฟล์ .env (เหมาะกับงานอบรม/ระบบภายในทีมเล็ก)
//   - รองรับทั้งรหัสผ่านธรรมดา (ADMIN_PASSWORD) และ bcrypt hash (ADMIN_PASSWORD_HASH)
//   - ของจริงที่มีผู้ใช้หลายคน ควรย้ายไปเก็บในตาราง users + hash เสมอ
// ---------------------------------------------------------------------------

declare module 'express-session' {
  interface SessionData {
    user?: string
    flash?: { type: 'success' | 'error'; text: string }
  }
}

export function verifyCredentials(username: string, password: string): boolean {
  if (username !== config.admin.username) return false
  if (config.admin.passwordHash) return bcrypt.compareSync(password, config.admin.passwordHash)
  return password === config.admin.password
}

/** ต้องล็อกอินก่อนจึงเข้าหน้านี้ได้ */
export function requireLogin(req: Request, res: Response, next: NextFunction): void {
  if (req.session?.user) {
    next()
    return
  }
  if (req.path.startsWith('/api/')) {
    res.status(401).json({ error: 'ต้องเข้าสู่ระบบก่อน' })
    return
  }
  res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`)
}

/** ใส่ข้อความแจ้งเตือนไว้ให้แสดงในหน้าถัดไป */
export function setFlash(req: Request, type: 'success' | 'error', text: string): void {
  if (req.session) req.session.flash = { type, text }
}

export function takeFlash(req: Request): { type: string; text: string } | null {
  const flash = req.session?.flash ?? null
  if (req.session) req.session.flash = undefined
  return flash ?? null
}
