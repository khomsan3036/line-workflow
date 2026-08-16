import express, { type Request, type Response, type Router } from 'express'
import { asyncRouter } from '../middleware/asyncRouter'
import { setFlash, takeFlash, verifyCredentials } from '../middleware/auth'

export function createAuthRouter(): Router {
  const router = asyncRouter()

  router.get('/login', (req: Request, res: Response) => {
    if (req.session?.user) {
      res.redirect('/')
      return
    }
    res.render('login', {
      title: 'เข้าสู่ระบบ',
      flash: takeFlash(req),
      next: typeof req.query.next === 'string' ? req.query.next : '/'
    })
  })

  router.post('/login', (req: Request, res: Response) => {
    const { username, password, next: nextUrl } = req.body as Record<string, string>
    if (verifyCredentials(username ?? '', password ?? '')) {
      req.session.user = username
      res.redirect(nextUrl && nextUrl.startsWith('/') ? nextUrl : '/')
      return
    }
    setFlash(req, 'error', 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง')
    res.redirect('/login')
  })

  router.post('/logout', (req: Request, res: Response) => {
    req.session.destroy(() => res.redirect('/login'))
  })

  return router
}
