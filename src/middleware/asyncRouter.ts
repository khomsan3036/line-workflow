import express, { type NextFunction, type Request, type Response, type Router } from 'express'

// ---------------------------------------------------------------------------
// ทำไมต้องมีไฟล์นี้
//
// Express 4 ไม่รู้จัก async function ถ้า handler เป็น async แล้วเกิด error
// (เช่นฐานข้อมูลล่ม หรือ SQL ผิด) error นั้นจะกลายเป็น unhandled promise rejection
// ซึ่งใน Node.js 15 ขึ้นไปจะทำให้ process ดับทั้งตัว = เซิร์ฟเวอร์ล่ม
//
// asyncRouter() คือ Router ที่ห่อ handler ทุกตัวด้วย .catch(next) ให้อัตโนมัติ
// error จึงไหลไปที่ error handler กลางแทนที่จะทำให้ระบบล่ม
//
// (ถ้าย้ายไป Express 5 ในอนาคต ไม่ต้องใช้ไฟล์นี้ เพราะรองรับ async ในตัวแล้ว)
// ---------------------------------------------------------------------------

type Handler = (req: Request, res: Response, next: NextFunction) => unknown

function wrap(handler: Handler): Handler {
  return (req, res, next) => {
    try {
      const result = handler(req, res, next)
      if (result instanceof Promise) result.catch(next)
      return result
    } catch (err) {
      next(err)
      return undefined
    }
  }
}

export function asyncRouter(): Router {
  const router = express.Router()
  const methods = ['get', 'post', 'put', 'patch', 'delete', 'use'] as const

  for (const method of methods) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const original = (router as any)[method].bind(router)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(router as any)[method] = (...args: any[]) =>
      original(...args.map((arg) => (typeof arg === 'function' && arg.length < 4 ? wrap(arg) : arg)))
  }

  return router
}
