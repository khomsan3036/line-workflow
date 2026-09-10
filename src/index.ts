import path from 'node:path'
import connectPgSimple from 'connect-pg-simple'
import express, { type NextFunction, type Request, type Response } from 'express'
import session from 'express-session'
import { config, describeConfig } from './config'
import { checkDatabase, pool } from './db'
import { requireLogin } from './middleware/auth'
import { createAdminRouter } from './routes/admin'
import { createAuthRouter } from './routes/auth'
import { createLineLoginRouter } from './routes/lineLogin'
import { createWebhookRouter } from './routes/webhook'
import { startScheduler } from './scheduler'
import { maintenanceMcpStatus } from './services/maintenanceMcp'
import { maintenanceEventsStatus, startMaintenanceEventConsumer } from './services/maintenanceEvents'

// ---------------------------------------------------------------------------
// โครงสร้าง 2 ชั้น
//   root : รับทุกอย่างที่ต้องอยู่ที่ root เสมอ = /webhook (LINE) และ /health
//   app  : dashboard ทั้งหมด mount ไว้ใต้ BASE_PATH (ค่าว่าง = root เหมือนเดิม)
// ทำแบบนี้เพื่อให้วางหลัง nginx gateway ใต้ prefix เช่น /line-workflow/ ได้
// โดย webhook ยังเป็น /webhook ตามที่ nginx block ของ LINE ชี้มา
// ---------------------------------------------------------------------------
const root = express()
const app = express()

// อยู่หลัง reverse proxy (Render, Nginx, Cloudflare) ต้องเชื่อ header X-Forwarded-*
// ไม่งั้น cookie แบบ secure จะไม่ถูกส่งกลับ และ req.protocol จะเป็น http ตลอด
if (config.trustProxy) {
  root.set('trust proxy', 1)
  app.set('trust proxy', 1)
}

// ---------------------------------------------------------------------------
// 1) View engine (EJS)
// ---------------------------------------------------------------------------
app.set('view engine', 'ejs')
app.set('views', path.join(__dirname, 'views'))

// base path ให้ view ใช้ประกอบลิงก์: href="<%= base %>/messages"
app.locals.base = config.basePath
// มี OA ที่สอง (ทีมซ่อมบำรุง) ให้เลือกส่งหรือไม่ (หน้า /send)
// ป้าย/ตัวเลือก OA ในหน้าเว็บ แสดงเฉพาะเมื่อมี OA MT แยกจริง (ใช้ OA HR ร่วมกัน = มี OA เดียว ไม่ต้องให้เลือก)
app.locals.maintenanceEnabled = config.maintenance.enabled && !config.maintenance.sharedOa
app.locals.channelLabels = { hr: 'HR Notification', mt: 'MT Notification' }

// res.redirect('/x') ในทุก route ให้เติม base path ให้อัตโนมัติ
// (ไม่เติมซ้ำถ้า URL มี base path อยู่แล้ว เช่น next= จากหน้า login)
function withBasePath(url: string): string {
  const base = config.basePath
  if (!base) return url
  if (!url.startsWith('/') || url.startsWith('//')) return url
  if (url === base || url.startsWith(`${base}/`) || url.startsWith(`${base}?`)) return url
  return base + url
}
app.use((_req: Request, res: Response, next: NextFunction) => {
  const original = res.redirect.bind(res) as (...args: unknown[]) => void
  res.redirect = ((...args: unknown[]) => {
    const i = args.findIndex((a) => typeof a === 'string')
    if (i >= 0) args[i] = withBasePath(args[i] as string)
    return original(...args)
  }) as typeof res.redirect
  next()
})

// ---------------------------------------------------------------------------
// 2) Webhook อยู่ที่ root เสมอ และต้องมาก่อน express.json()
//    เพราะ middleware ตรวจ signature ของ @line/bot-sdk ต้องอ่าน raw body
// ---------------------------------------------------------------------------
root.use('/', createWebhookRouter())

// ---------------------------------------------------------------------------
// 3) middleware ทั่วไปสำหรับหน้าเว็บ
// ---------------------------------------------------------------------------
app.use(express.urlencoded({ extended: true, limit: '1mb' }))
app.use(express.json({ limit: '1mb' }))

// เก็บ session ไว้ที่ไหน
//   dev  : ใน memory พอ (ง่าย ไม่ต้องตั้งอะไร แต่ล็อกอินหลุดทุกครั้งที่ restart)
//   prod : ต้องเก็บใน PostgreSQL ไม่งั้นทุกครั้งที่ deploy ใหม่ผู้ใช้จะถูกเตะออก
//          และถ้ามีหลาย instance ผู้ใช้จะล็อกอินไม่ติดเพราะเจอ instance คนละตัว
const sessionStore = config.sessionInDatabase
  ? new (connectPgSimple(session))({ pool, tableName: 'user_sessions', createTableIfMissing: true })
  : undefined

app.use(
  session({
    store: sessionStore,
    secret: config.sessionSecret,
    // ชื่อ cookie เฉพาะของแอปนี้ + จำกัด path ไว้ที่ base path
    // จะได้ไม่ชนกับ cookie ของแอปอื่นที่อยู่บนโดเมนเดียวกันหลัง gateway
    name: 'lineworkflow.sid',
    resave: false,
    saveUninitialized: false,
    proxy: config.trustProxy,
    cookie: {
      path: config.basePath || '/',
      httpOnly: true,
      sameSite: 'lax',
      // secure = ส่ง cookie เฉพาะผ่าน HTTPS เปิดได้เมื่อขึ้น production ที่มี HTTPS แล้ว
      secure: config.cookieSecure,
      maxAge: 1000 * 60 * 60 * 8
    }
  })
)

// helper ใช้ใน view ทุกหน้า
app.locals.formatDateTime = (value: Date | string | null): string => {
  if (!value) return '-'
  return new Date(value).toLocaleString('th-TH', {
    timeZone: config.timezone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}
app.locals.formatDate = (value: Date | string | null): string => {
  if (!value) return '-'
  return new Date(value).toLocaleDateString('th-TH', {
    timeZone: config.timezone,
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  })
}
app.locals.formatNumber = (value: number | null | undefined): string =>
  value === null || value === undefined ? '-' : Number(value).toLocaleString('th-TH')
app.locals.formatMoney = (value: number | null | undefined): string =>
  value === null || value === undefined ? '-' : `${Math.round(Number(value)).toLocaleString('th-TH')} บาท`

// ---------------------------------------------------------------------------
// 4) ไฟล์คงที่ (โลโก้ รูปภาพ) จากโฟลเดอร์ public/ เปิดได้โดยไม่ต้องล็อกอิน
//    ใช้ process.cwd() เพื่อให้หาเจอทั้งตอน dev (tsx) และตอนรันจาก dist/
// ---------------------------------------------------------------------------
app.use(express.static(path.join(process.cwd(), 'public'), { maxAge: '7d' }))

// ---------------------------------------------------------------------------
// 4.1) health check (เปิดได้โดยไม่ต้องล็อกอิน ใช้ตรวจว่าระบบยังดีอยู่)
//      อยู่ที่ root เสมอ (Docker healthcheck ใช้) และมีใต้ base path ด้วยเพื่อความสะดวก
// ---------------------------------------------------------------------------
async function healthHandler(_req: Request, res: Response): Promise<void> {
  const db = await checkDatabase()
  if (!db.ok) {
    res.status(500).json({ status: 'error', database: 'down', message: db.error })
    return
  }
  const result = await pool.query('SELECT COUNT(*)::int AS count FROM line_messages')
  res.json({
    status: 'ok',
    messagesStored: result.rows[0].count,
    lineMode: config.mockLine ? 'mock' : 'live',
    maintenance: config.maintenance.enabled
      ? { lineMode: config.maintenance.mockLine ? 'mock' : 'live', mcp: maintenanceMcpStatus(), events: maintenanceEventsStatus() }
      : 'off',
    basePath: config.basePath || '/'
  })
}
root.get('/health', healthHandler)
app.get('/health', healthHandler)

// ---------------------------------------------------------------------------
// 5) หน้าเว็บ
// ---------------------------------------------------------------------------
app.use('/', createAuthRouter())
// หน้ายืนยันตัวตนด้วย LINE Login (พนักงานเปิดจากปุ่มในแชท) ไม่ต้องล็อกอิน admin
app.use('/', createLineLoginRouter())
app.use('/', requireLogin, createAdminRouter())

// ---------------------------------------------------------------------------
// 5.1) mount dashboard ใต้ base path
// ---------------------------------------------------------------------------
if (config.basePath) {
  root.use(config.basePath, app)
  // เปิด / ตรง ๆ (เช่นทดสอบในเครื่อง) ให้เด้งไปหน้า dashboard
  // หลัง nginx gateway / เป็นของแอปอื่น คำขอนี้จะไม่มาถึงที่นี่อยู่แล้ว
  root.get('/', (_req: Request, res: Response) => res.redirect(`${config.basePath}/`))
} else {
  root.use(app)
}

// ---------------------------------------------------------------------------
// 6) 404 และ error handler
// ---------------------------------------------------------------------------
app.use((req: Request, res: Response) => {
  if (req.path.startsWith('/api/')) {
    res.status(404).json({ error: 'ไม่พบ endpoint นี้' })
    return
  }
  res.status(404).render('error', {
    title: 'ไม่พบหน้านี้',
    message: `ไม่พบหน้า ${req.path}`,
    user: req.session?.user,
    groups: [],
    selectedGroup: '',
    flash: null,
    mockLine: config.mockLine,
    currentPath: req.path
  })
})

// error handler ใช้ร่วมกันทั้ง app (dashboard) และ root (webhook)
const errorHandler = (err: Error, req: Request, res: Response, _next: NextFunction): void => {
  console.error('[Error]', err.message)

  // error จาก middleware ตรวจ signature ของ LINE
  if (err.message?.toLowerCase().includes('signature')) {
    res.status(401).send('signature validation failed')
    return
  }

  // body ที่ส่งมาที่ /webhook หรือ /webhook/mt ไม่ใช่ JSON ที่ถูกต้อง (ไม่ใช่คำขอจาก LINE)
  // ตอบสั้น ๆ ไม่ต้อง render หน้า HTML เพราะปลายทางเป็นเครื่อง ไม่ใช่คน
  if (req.path === '/webhook' || req.path.startsWith('/webhook/')) {
    res.status(400).json({ error: 'invalid request body' })
    return
  }

  res.status(500).render('error', {
    title: 'เกิดข้อผิดพลาด',
    message: err.message,
    hint:
      err.message.includes('ECONNREFUSED') || err.message.includes('does not exist')
        ? 'ดูเหมือนต่อฐานข้อมูลไม่ได้ ตรวจว่า PostgreSQL รันอยู่ และ DATABASE_URL ในไฟล์ .env ถูกต้อง แล้วรัน npm run db:setup'
        : undefined,
    user: req.session?.user,
    groups: [],
    selectedGroup: '',
    flash: null,
    mockLine: config.mockLine,
    currentPath: req.path
  })
}
app.use(errorHandler)
root.use(errorHandler)

// ---------------------------------------------------------------------------
// 7) กันเซิร์ฟเวอร์ล่มจาก error ที่หลุดรอดออกมา
//    (ปกติ asyncRouter จับให้แล้ว นี่คือตาข่ายชั้นสุดท้าย)
// ---------------------------------------------------------------------------
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason instanceof Error ? reason.message : reason)
})
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err.message)
})

// ---------------------------------------------------------------------------
// 8) เริ่มเซิร์ฟเวอร์
// ---------------------------------------------------------------------------
async function start(): Promise<void> {
  const db = await checkDatabase()

  if (config.isProduction && config.sessionSecret === 'workshop-dev-secret-change-me') {
    console.warn('[!] SESSION_SECRET ยังเป็นค่าเริ่มต้น ห้ามใช้บน production ให้ตั้งค่าใหม่เป็นข้อความสุ่มยาว ๆ')
  }

  // กันปัญหาที่วินิจฉัยยาก: cookie เป็น secure แต่เข้าผ่าน http ล้วน จะล็อกอินไม่ได้เลยแบบไม่มี error
  if (config.cookieSecure && !config.trustProxy) {
    console.warn('[!] cookie ตั้งเป็น secure แต่ TRUST_PROXY ปิดอยู่')
    console.warn('    ถ้าเข้าเว็บผ่าน https ที่มี reverse proxy (เช่น Render) ให้ตั้ง TRUST_PROXY=true')
    console.warn('    ถ้าจำเป็นต้องเข้าผ่าน http ล้วน ให้ตั้ง COOKIE_SECURE=false')
  }

  root.listen(config.port, () => {
    console.log('')
    console.log('  LINE Workflow Automation Workshop 2026')
    console.log('  ---------------------------------------------------------------')
    console.log(`   ${describeConfig()}`)
    console.log('  ---------------------------------------------------------------')
    console.log(`   Dashboard : http://localhost:${config.port}${config.basePath}/`)
    console.log(`   Webhook   : POST http://localhost:${config.port}/webhook`)
    console.log(`   Webhook MT: POST http://localhost:${config.port}/webhook/mt`)
    console.log(`   Health    : GET  http://localhost:${config.port}/health`)
    console.log('  ---------------------------------------------------------------')
    if (!db.ok) {
      console.log('')
      console.log('  [!] ต่อฐานข้อมูลไม่ได้:', db.error)
      console.log('      1) ตรวจว่า PostgreSQL รันอยู่ (หรือใช้ docker compose up -d)')
      console.log('      2) ตรวจค่า DATABASE_URL ในไฟล์ .env')
      console.log('      3) รัน npm run db:setup เพื่อสร้างตารางและใส่ข้อมูลตัวอย่าง')
    }
    console.log('')

    // ตัวตั้งเวลาในตัว (ใช้แทน Task Scheduler เมื่อ deploy บน cloud)
    if (db.ok) startScheduler()
    // รับ event จากระบบซ่อมบำรุงผ่าน RabbitMQ แล้วแจ้งเข้าไลน์กลุ่มด้วย OA MT
    if (db.ok && config.maintenance.enabled) startMaintenanceEventConsumer()
  })
}

start().catch((err) => {
  console.error('เริ่มเซิร์ฟเวอร์ไม่สำเร็จ:', err)
  process.exit(1)
})
