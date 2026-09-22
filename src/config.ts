import 'dotenv/config'

// ---------------------------------------------------------------------------
// รวมค่า config ทั้งหมดไว้ที่เดียว อ่านจากไฟล์ .env
// ตั้งใจไม่ throw error ตอนเริ่มระบบ เพื่อให้ผู้เรียนเปิด dashboard ดูได้
// แม้ยังไม่ได้ตั้งค่า LINE (ระบบจะทำงานในโหมด MOCK ให้อัตโนมัติ)
// ---------------------------------------------------------------------------

/** ค่าคั่นด้วยจุลภาค -> array (ตัดช่องว่างและค่าว่างออก) */
function list(v: string | undefined): string[] {
  return (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** หลาย cron คั่นด้วย ; -> array เช่น "30 10 * * *;0 20 * * *" (จุลภาคเป็นส่วนหนึ่งของ cron จึงใช้คั่นไม่ได้) */
function splitCronList(v: string): string[] {
  return v
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback
  return value.toLowerCase() === 'true' || value === '1'
}

// LINE OA หลัก (HR Notification) - รับชื่อแบบมี _HR ต่อท้ายด้วย เพื่อให้ตั้งคู่กับ OA อื่นในไฟล์เดียวกันได้
const channelAccessToken = process.env.CHANNEL_ACCESS_TOKEN_HR ?? process.env.CHANNEL_ACCESS_TOKEN ?? ''
const channelSecret = process.env.CHANNEL_SECRET_HR ?? process.env.CHANNEL_SECRET ?? ''

// LINE OA ที่สอง (Maintenance Team) - แชทบอทถาม-ตอบข้อมูลซ่อมบำรุงผ่าน MCP server
const maintenanceTokenRaw = (process.env.CHANNEL_ACCESS_TOKEN_MT ?? '').trim()
const maintenanceSecretRaw = (process.env.CHANNEL_SECRET_MT ?? '').trim()
// ใช้ OA HR ตัวเดียวทำทั้งงาน HR และแชทบอทซ่อมบำรุง (ไม่มี OA MT แยก):
//   ตั้ง MAINTENANCE_USE_HR_OA=true หรือใส่ CHANNEL_ACCESS_TOKEN_MT เป็นค่าเดียวกับของ HR ก็ได้
// ในโหมดนี้ทุกอย่างของฝั่ง MT (ส่งข้อความ, ทะเบียนกลุ่ม, ประวัติแชท) ใช้ channel 'hr' และ webhook อยู่ที่ /webhook
const maintenanceUseHrOa =
  bool(process.env.MAINTENANCE_USE_HR_OA, false) ||
  (maintenanceTokenRaw !== '' && maintenanceTokenRaw === channelAccessToken.trim())
const maintenanceChannelAccessToken = maintenanceUseHrOa ? channelAccessToken : maintenanceTokenRaw
const maintenanceChannelSecret = maintenanceUseHrOa ? channelSecret : maintenanceSecretRaw

// ถ้าไม่ได้ตั้ง token ไว้ ให้บังคับเป็นโหมด mock เสมอ (ยิง API จริงไม่ได้อยู่ดี)
const mockLineFlag = bool(process.env.MOCK_LINE, true)
const mockLine = mockLineFlag || channelAccessToken === ''

const nodeEnv = process.env.NODE_ENV ?? 'development'

// เส้นทางฐาน (base path) เมื่อ dashboard อยู่หลัง reverse proxy ใต้ prefix เดียวกับแอปอื่น
// เช่น BASE_PATH=/line-workflow -> เปิดที่ https://qtecintegra.com/line-workflow/
// ค่าว่าง = อยู่ที่ root ตามปกติ (webhook และ /health อยู่ที่ root เสมอ ไม่ขึ้นกับค่านี้)
function normalizeBasePath(value: string | undefined): string {
  const trimmed = (value ?? '').trim()
  if (trimmed === '' || trimmed === '/') return ''
  return '/' + trimmed.replace(/^\/+|\/+$/g, '')
}
function stripSlash(value: string): string {
  return value.replace(/\/+$/, '')
}
// URL สาธารณะของแอป ใช้สร้างลิงก์ที่ส่งเข้าแชท (ตอนพัฒนาใช้ ngrok URL แทน localhost)
const publicUrl = stripSlash((process.env.PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 3000}`).trim())

const databaseUrl = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/linechat'

// ผู้ให้บริการฐานข้อมูลบน cloud (เช่น Neon, Supabase, Render) บังคับใช้ SSL
// ตรวจจากใน connection string ให้อัตโนมัติ หรือสั่งเปิดเองด้วย DATABASE_SSL=true
const databaseSsl = bool(process.env.DATABASE_SSL, /sslmode=(require|verify-ca|verify-full)/.test(databaseUrl))

export const config = {
  nodeEnv,
  isProduction: nodeEnv === 'production',
  port: Number(process.env.PORT ?? 3000),
  timezone: process.env.TZ ?? 'Asia/Bangkok',
  basePath: normalizeBasePath(process.env.BASE_PATH),

  databaseUrl,
  databaseSsl,
  // ปิดการตรวจใบรับรอง SSL (ใช้เฉพาะกรณีที่ผู้ให้บริการใช้ self-signed cert)
  databaseSslNoVerify: bool(process.env.DATABASE_SSL_NO_VERIFY, false),
  // จำนวน connection สูงสุดใน pool (ปรับลงได้ถ้าฐานข้อมูลจำกัด connection)
  poolMax: Number(process.env.PG_POOL_MAX ?? 10),

  // ฐานข้อมูล HR (SQL Server) ที่ระบบสแกนนิ้วเขียนตาราง AttendanceDaily ไว้
  // รูปแบบ: Server=host\instance;Database=...;User Id=...;Password=...;TrustServerCertificate=True;
  // ปล่อยว่างได้ บอทจะตอบว่ายังไม่ได้เชื่อมต่อเมื่อมีคนถามสรุปพนักงาน
  mssqlConnectionString: process.env.DATABASE_URL_MSSQL ?? '',

  // API ของระบบ HR (qtecintegra) สำหรับดูเวลาเข้า-ออกรายบุคคล (time attendance ของฉัน)
  manpowerApiUrl:
    process.env.MANPOWER_API_URL ?? 'https://qtecintegra.com/api/hr/api/v1/Manpower/GetManpowerByDate',
  manpowerApiTimeoutMs: Number(process.env.MANPOWER_API_TIMEOUT_MS ?? 15000),

  // URL สาธารณะของแอปนี้ (ไม่มี / ท้าย) ใช้ประกอบลิงก์ที่ส่งไปในแชท เช่น ปุ่ม "ยืนยันตัวตน"
  // production: https://qtecintegra.com (ร่วมกับ BASE_PATH=/line-workflow)
  publicUrl,

  // บริการยืนยันตัวตนกลางของ QTEC (qtecintegra) ใช้ผูก LINE userId กับบัญชีพนักงาน (prs_no)
  // รองรับชื่อตัวแปรแบบ NEXT_PUBLIC_* ด้วย เพื่อให้ใช้ค่าเดียวกับโปรเจกต์ qtec-integra ได้
  auth: {
    apiUrl: stripSlash(
      process.env.AUTH_API_URL ?? process.env.NEXT_PUBLIC_AUTH_API_URL ?? 'https://qtecintegra.com/api/auth'
    ),
    empApiUrl: stripSlash(
      process.env.EMP_AUTH_API_URL ?? process.env.NEXT_PUBLIC_EMP_AUTH_API_URL ?? 'https://qtecintegra.com/api/emp/auth'
    ),
    timeoutMs: Number(process.env.AUTH_API_TIMEOUT_MS ?? 15000)
  },

  // LINE Login (OAuth 2.1 + OpenID Connect) สำหรับยืนยันว่า LINE userId นี้เป็นพนักงานคนไหนจริง ๆ
  // ใช้ channel LINE Login เดียวกับ qtec-integra ได้ แต่ต้องเพิ่ม callback URL ของแอปนี้ใน LINE Developers Console
  lineLogin: {
    channelId: process.env.LINE_LOGIN_CHANNEL_ID ?? process.env.NEXT_PUBLIC_LINE_CHANNEL_ID ?? '',
    channelSecret: process.env.LINE_LOGIN_CHANNEL_SECRET ?? '',
    // ค่าเริ่มต้น = <PUBLIC_URL><BASE_PATH>/line-login/callback
    callbackUrl:
      process.env.LINE_LOGIN_CALLBACK_URL ?? `${publicUrl}${normalizeBasePath(process.env.BASE_PATH)}/line-login/callback`,
    // อายุของลิงก์ยืนยันตัวตนที่ส่งไปในแชท (นาที)
    stateTtlMinutes: Number(process.env.LINE_LOGIN_STATE_TTL_MINUTES ?? 30),
    // บังคับให้ userId จาก LINE Login ตรงกับ userId ของ Messaging API (ต้องอยู่ provider เดียวกันใน LINE Developers)
    // ปิดได้เมื่อ channel ทั้งสองอยู่คนละ provider (userId จะไม่ตรงกัน) โดยระบบจะเชื่อการผูกผ่านลิงก์ในแชทแทน
    requireSameUser: bool(process.env.LINE_LOGIN_REQUIRE_SAME_USER, true),
    timeoutMs: Number(process.env.LINE_LOGIN_TIMEOUT_MS ?? 10000),
    get enabled(): boolean {
      return this.channelId !== '' && this.channelSecret !== ''
    }
  },

  // "เวลาเข้างานของฉัน": อนุญาตให้พิมพ์รหัสพนักงานเองโดยไม่ยืนยันตัวตนหรือไม่
  // ค่าเริ่มต้น false = ต้องผ่าน LINE Login ก่อนเสมอ (ใช้ true เฉพาะตอนพัฒนาที่ยังไม่มี LINE Login channel)
  myAttendanceAllowUnverified: bool(process.env.MY_ATTENDANCE_ALLOW_UNVERIFIED, false),

  // ปุ่ม "ดูรายชื่อ" ผลตรวจเทียบ bPlus บนการ์ดสรุปการเข้างาน: เปิดให้เฉพาะผู้ที่ยืนยันตัวตนแล้ว
  // และอยู่แผนกใน CROSS_CHECK_LIST_DEPTS (ตาม MANPOWER_HR.DEPT ไม่สนตัวพิมพ์) หรือมีรหัสใน CROSS_CHECK_LIST_PRS_NOS
  crossCheckList: {
    depts: list(process.env.CROSS_CHECK_LIST_DEPTS ?? 'HR').map((d) => d.toLowerCase()),
    prsNos: list(process.env.CROSS_CHECK_LIST_PRS_NOS).map((d) => d.toUpperCase())
  },

  channelAccessToken,
  channelSecret,
  mockLine,
  defaultGroupId: process.env.DEFAULT_GROUP_ID ?? '',

  // ---------------------------------------------------------------------
  // Maintenance Team OA: แชทบอทที่ตอบคำถามเรื่องซ่อมบำรุง/น้ำมัน/รถ โดยเรียก tool
  // จาก MCP server ของระบบ maintenance (https://qtecintegra.com/maintenance/mcp)
  // webhook อยู่ที่ POST /webhook/mt (คนละ channel secret กับ OA หลัก)
  // ---------------------------------------------------------------------
  maintenance: {
    channelAccessToken: maintenanceChannelAccessToken,
    channelSecret: maintenanceChannelSecret,
    // true = ไม่มี OA MT แยก ใช้ OA HR ตอบแชทซ่อมบำรุงด้วย (ดูคำอธิบายที่ maintenanceUseHrOa)
    sharedOa: maintenanceUseHrOa,
    // channel ที่ใช้ส่งข้อความ/ลงทะเบียนกลุ่ม/เก็บประวัติของฝั่งซ่อมบำรุง ('mt' เมื่อมี OA แยก, 'hr' เมื่อใช้ร่วม)
    channel: (maintenanceUseHrOa ? 'hr' : 'mt') as 'hr' | 'mt',
    // โหมด mock ของ OA นี้: ตาม MOCK_LINE หรือเมื่อยังไม่ได้ใส่ token
    mockLine: mockLineFlag || maintenanceChannelAccessToken === '',
    mcpUrl: stripSlash((process.env.MAINTENANCE_MCP_URL ?? 'https://qtecintegra.com/maintenance/mcp').trim()),
    // header เพิ่มเติมตอนเรียก MCP (ถ้าเซิร์ฟเวอร์ต้องการ) เช่น Authorization: Bearer xxx
    mcpAuthHeader: process.env.MAINTENANCE_MCP_AUTH_HEADER ?? '',
    mcpTimeoutMs: Number(process.env.MAINTENANCE_MCP_TIMEOUT_MS ?? 60000),
    // URL หน้าเว็บระบบซ่อมบำรุง (ไม่มี / ท้าย) ใช้ทำปุ่ม "เปิดหน้าอนุมัติ" ในการ์ดแจ้งเตือน ปล่อยว่าง = ไม่มีปุ่ม
    webUrl: stripSlash((process.env.MAINTENANCE_WEB_URL ?? '').trim()),
    // จำกัดชื่อ tool ที่ให้บอทเรียกได้ (คั่นด้วยจุลภาค, รองรับ * เช่น Get*) ค่าว่างหรือ * = ทุก tool
    mcpTools: (process.env.MAINTENANCE_MCP_TOOLS ?? '*')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
    // ผู้ให้บริการโมเดล (โปรเจกต์นี้ใช้ OpenAI เป็นหลัก เหมือนฟีเจอร์สรุปแชท)
    //   auto = OpenAI ก่อน (OPENAI_API_KEY) แล้วสำรองด้วย Claude เมื่อ OpenAI ใช้ไม่ได้
    //   openai / anthropic = บังคับใช้ตัวนั้นตัวเดียว
    provider: (process.env.MAINTENANCE_AI_PROVIDER ?? 'auto') as 'auto' | 'anthropic' | 'openai',
    // โมเดล Claude ที่ใช้เมื่อสลับไป Anthropic (ฝั่ง OpenAI ใช้ OPENAI_MODEL)
    model: process.env.MAINTENANCE_AI_MODEL ?? 'claude-opus-5',
    // ความละเอียดในการคิด low | medium | high | xhigh | max (แชทถาม-ตอบใช้ medium พอ ตอบเร็วกว่า)
    effort: (process.env.MAINTENANCE_AI_EFFORT ?? 'medium') as 'low' | 'medium' | 'high' | 'xhigh' | 'max',
    // จำนวนรอบเรียก tool สูงสุดต่อคำถาม กันวนไม่รู้จบ
    maxToolRounds: Number(process.env.MAINTENANCE_AI_MAX_TOOL_ROUNDS ?? 8),
    // จำข้อความก่อนหน้าของผู้ใช้คนเดิมกี่คู่ (ถาม-ตอบ) เพื่อให้คุยต่อเนื่องได้
    historyPairs: Number(process.env.MAINTENANCE_AI_HISTORY_PAIRS ?? 6),
    // ประวัติที่เก่ากว่านี้ (นาที) ไม่นำมาใช้ต่อบทสนทนา
    historyMaxAgeMinutes: Number(process.env.MAINTENANCE_AI_HISTORY_MAX_AGE_MINUTES ?? 120),
    // เวลารวมสูงสุดต่อคำถาม (ms) เกินนี้จะตอบว่าขออภัย
    answerTimeoutMs: Number(process.env.MAINTENANCE_AI_TIMEOUT_MS ?? 120000),
    // true = log ผลลัพธ์ tool และคำตอบดิบของโมเดล (ใช้ตอนดีบักว่าโมเดลเห็นอะไร)
    debug: bool(process.env.MAINTENANCE_DEBUG, false),

    // -------------------------------------------------------------------
    // รับ event จากระบบซ่อมบำรุง (RabbitMQ topic exchange "maintenance") แล้วแจ้งเข้าไลน์กลุ่มด้วย OA MT
    // ปล่อย RABBITMQ_URL ว่าง = ปิด (บอทยังตอบแชทได้ตามปกติ)
    // -------------------------------------------------------------------
    events: {
      url: (process.env.RABBITMQ_URL ?? '').trim(),
      exchange: process.env.MAINTENANCE_EXCHANGE ?? 'maintenance',
      // ชื่อ queue ของแอปนี้ (durable) ถ้ารันหลาย instance จะแบ่งกันรับ ไม่ซ้ำ
      queue: process.env.MAINTENANCE_EVENT_QUEUE ?? 'line-workflow.maintenance-alerts',
      routingKeys: (
        process.env.MAINTENANCE_EVENT_ROUTING_KEYS ??
        'maintenance.line.notification,repair.requested,fuel.requested,vehicle.booking.requested'
      )
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean),
      // กันการ์ดซ้ำตามเนื้อหา (alertId / เลขที่คำขอ) ภายในกี่ชั่วโมง จำไว้ในตาราง maintenance_alert_dedupe (0 = ปิด)
      // ทำไมต้องมี: tool Get* ของ MCP server publish alert เดิมซ้ำทุกครั้งที่มีคนถาม (ฝั่งนั้นกันซ้ำแค่ 60 นาทีในหน่วยความจำ)
      dedupeHours: Number(process.env.MAINTENANCE_EVENT_DEDUPE_HOURS ?? 24),
      // ข้าม alert อัตโนมัติที่เกิดจากคำถามของแอปนี้เอง (แชทบอท/ตัวตั้งเวลา) เพราะผู้ถามได้การ์ดคำตอบอยู่แล้ว
      skipOwnAnalysisAlerts: bool(process.env.MAINTENANCE_EVENT_SKIP_OWN_ANALYSIS, true),
      get enabled(): boolean {
        return this.url !== ''
      }
    },
    // -------------------------------------------------------------------
    // กลุ่มปลายทางของการ์ดแจ้งเตือน MT (notify_line_group จากแชท + event จาก RabbitMQ)
    //   alertGroupIds : MT_ALERT_GROUP_IDS ระบุ groupId ตรง ๆ (ไม่ผูกกับ MT_REPORT_GROUP_IDS ซึ่งเป็นปลายทางทดสอบของรายงานเท่านั้น)
    //   groupKeywords : เมื่อไม่ได้ระบุ id ให้เลือกเฉพาะกลุ่มที่ชื่อมีคำเหล่านี้ (ค่าเริ่มต้น MT / ซ่อมบำรุง / maintenance)
    // ทำไมต้องมี: บอทถูกเชิญเข้ากลุ่มอื่นที่ไม่ใช่ทีมช่างได้ (และในโหมดใช้ OA HR ร่วมกัน ทะเบียนกลุ่ม channel = hr
    // มีทั้งกลุ่ม HR และกลุ่มช่าง) ถ้าส่ง "ทุกกลุ่มที่บอทอยู่" การ์ดซ่อมบำรุงจะไปรบกวนกลุ่มเหล่านั้น จึงไม่มีการถอยไปส่งทุกกลุ่ม
    // -------------------------------------------------------------------
    alertGroupIds: list(process.env.MT_ALERT_GROUP_IDS),
    groupKeywords: list(process.env.MT_GROUP_KEYWORDS ?? 'MT,ซ่อมบำรุง,maintenance'),
    get enabled(): boolean {
      return this.sharedOa || this.channelSecret !== '' || this.channelAccessToken !== ''
    }
  },

  admin: {
    username: process.env.ADMIN_USERNAME ?? 'admin',
    password: process.env.ADMIN_PASSWORD ?? 'admin1234',
    passwordHash: process.env.ADMIN_PASSWORD_HASH ?? ''
  },
  sessionSecret: process.env.SESSION_SECRET ?? 'workshop-dev-secret-change-me',
  // เก็บ session ลง PostgreSQL แทน memory (จำเป็นเมื่อ deploy จริง ไม่งั้นล็อกอินหลุดทุกครั้งที่ restart)
  sessionInDatabase: bool(process.env.SESSION_IN_DATABASE, nodeEnv === 'production'),
  // อยู่หลัง reverse proxy (Render, Nginx, Cloudflare) ต้องเปิดเพื่อให้ cookie secure ทำงานถูก
  trustProxy: bool(process.env.TRUST_PROXY, nodeEnv === 'production'),
  // ส่ง cookie เฉพาะผ่าน HTTPS (ค่าเริ่มต้น: เปิดเมื่อ production)
  // ถ้าจำเป็นต้องรัน production ผ่าน http ล้วน ให้ตั้ง COOKIE_SECURE=false ไม่งั้นจะล็อกอินไม่ได้
  cookieSecure: bool(process.env.COOKIE_SECURE, nodeEnv === 'production'),

  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY ?? '',
    model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-5'
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY ?? '',
    model: process.env.OPENAI_MODEL ?? 'gpt-4o'
  },

  anomalyAmountThreshold: Number(process.env.ANOMALY_AMOUNT_THRESHOLD ?? 300000),

  // ---------------------------------------------------------------------
  // Media Archiver: ดึงรูป วิดีโอ เสียง และไฟล์ที่ส่งในกลุ่มมาเก็บถาวร
  // เหตุผล: LINE ระบุว่าไฟล์ที่ผู้ใช้ส่ง "จะถูกลบอัตโนมัติหลังผ่านไประยะหนึ่ง"
  //         และไม่เปิดเผยว่ากี่วัน จึงต้องโหลดทันทีที่ webhook เข้ามา
  // ---------------------------------------------------------------------
  media: {
    enabled: bool(process.env.MEDIA_ARCHIVE_ENABLED, true),
    // local = เก็บลงดิสก์ในเครื่อง | s3 = เก็บขึ้น object storage (ดู src/services/storage.ts)
    driver: (process.env.MEDIA_STORAGE_DRIVER ?? 'local') as 'local' | 's3',
    localDir: process.env.MEDIA_LOCAL_DIR ?? 'storage/media',
    // ไม่โหลดไฟล์ที่ใหญ่เกินกำหนด (หน่วยเป็น MB) กันดิสก์เต็มโดยไม่ตั้งใจ
    maxSizeMb: Number(process.env.MEDIA_MAX_SIZE_MB ?? 25),
    // ชนิดที่จะเก็บ คั่นด้วยจุลภาค: image, video, audio, file
    types: (process.env.MEDIA_TYPES ?? 'image,video,audio,file').split(',').map((t) => t.trim()),
    // เก็บภาพย่อของรูป/วิดีโอไว้แสดงในแกลเลอรี (ประหยัดแบนด์วิดท์ตอนเปิดหน้า)
    savePreview: bool(process.env.MEDIA_SAVE_PREVIEW, true),
    s3: {
      bucket: process.env.S3_BUCKET ?? '',
      region: process.env.S3_REGION ?? 'auto',
      endpoint: process.env.S3_ENDPOINT ?? '',
      accessKeyId: process.env.S3_ACCESS_KEY_ID ?? '',
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? ''
    }
  },

  // ตัวตั้งเวลาในตัวโปรแกรม (ใช้แทน Windows Task Scheduler เมื่อ deploy บน cloud)
  scheduler: {
    enabled: bool(process.env.ENABLE_SCHEDULER, false),
    // รูปแบบ cron 5 ช่อง: นาที ชั่วโมง วันที่ เดือน วันในสัปดาห์ (เวลาตาม TZ ด้านบน)
    summaryCron: process.env.SUMMARY_CRON ?? '0 18 * * *',
    // REPORT_CRON ส่งการ์ด "สรุปการเข้างาน" (จำนวนพนักงานสแกนเข้างาน) ไม่ใช่รายงานยอดขายจำลองของหลักสูตรอีกต่อไป
    reportCron: process.env.REPORT_CRON ?? '0 8 * * *',
    // หลายรอบต่อวันที่นาทีไม่เท่ากัน (เช่น 10:30 และ 20:00) เขียนเป็น cron เดียวไม่ได้ จึงคั่นหลาย cron ด้วย ;
    // เช่น REPORT_CRON=30 10 * * *;0 20 * * *  (ห้ามใช้จุลภาค เพราะ cron ใช้จุลภาคในช่องอยู่แล้ว เช่น 0 10,14 * * *)
    reportCrons: splitCronList(process.env.REPORT_CRON ?? '0 8 * * *'),
    // ปลายทางของการ์ดสรุปการเข้างาน คั่นด้วยจุลภาค (C... = กลุ่ม, U... = ผู้ใช้สำหรับทดสอบ) ว่าง = ใช้ DEFAULT_GROUP_ID
    reportTargets: (process.env.REPORT_GROUP_IDS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    // ช่วงเวลาที่สรุป: today | yesterday | thisWeek | lastWeek | thisMonth | lastMonth
    reportPeriod: (process.env.REPORT_PERIOD ?? 'today').trim(),
    // สถานที่: all | workshop | site
    reportLocation: (process.env.REPORT_LOCATION ?? 'all').trim(),

    // OA ทีมซ่อมบำรุง (ใช้ได้เมื่อตั้ง OA MT แล้ว)
    //   MT_PENDING_CRON = การ์ด "งานซ่อมค้างวันนี้" ทุกเช้า
    //   MT_URGENT_CRON  = การ์ด "แจ้งเตือนงานซ่อมเร่งด่วน" ส่งเฉพาะเมื่อมีเรื่องด่วน (ว่าง = ปิด)
    mtPendingCron: (process.env.MT_PENDING_CRON ?? '30 8 * * *').trim(),
    mtUrgentCron: (process.env.MT_URGENT_CRON ?? '0 10,14 * * *').trim(),
    // ปลายทางของการ์ด MT คั่นด้วยจุลภาค (C... กลุ่ม / U... ผู้ใช้ทดสอบ) ว่าง = กลุ่มของทีมซ่อมบำรุง (listMaintenanceGroups)
    mtReportTargets: (process.env.MT_REPORT_GROUP_IDS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  }
}

/**
 * แปลง cron 5 ช่องที่ยิงวันละครั้ง ให้เป็นเวลาที่คนอ่านรู้เรื่อง เช่น "0 8 * * *" -> "08:00 น."
 * คืน null ถ้าเป็นรูปแบบที่ซับซ้อนกว่านั้น (เช่นทุก 30 นาที) เพราะสรุปเป็นเวลาเดียวไม่ได้
 */
export function cronTimeLabel(expr: string): string | null {
  const [minute, hour, ...rest] = expr.trim().split(/\s+/)
  if (rest.join(' ') !== '* * *') return null
  if (!/^\d{1,2}$/.test(minute) || !/^\d{1,2}$/.test(hour)) return null
  return `${hour.padStart(2, '0')}:${minute.padStart(2, '0')} น.`
}

/**
 * ประโยคบอกรอบการส่งการ์ดสรุปการเข้างาน (REPORT_CRON) ใช้ในหน้า dashboard และ log
 * ถ้ายังไม่ได้เปิดตัวตั้งเวลา จะไม่โฆษณาว่าส่งอัตโนมัติ (กันผู้เรียนเข้าใจผิด)
 */
export function reportScheduleNote(): string | null {
  if (!config.scheduler.enabled) return null
  const crons = config.scheduler.reportCrons
  const labels = crons.map(cronTimeLabel)
  if (crons.length === 0 || labels.some((l) => l === null)) {
    return `ตั้งเวลาส่งอัตโนมัติไว้แล้ว (REPORT_CRON = ${config.scheduler.reportCron})`
  }
  if (labels.length > 1) return `ส่งอัตโนมัติวันละ ${labels.length} รอบ ${labels.join(' และ ')}`
  const hour = Number(labels[0]!.slice(0, 2))
  return `ส่งอัตโนมัติ${hour < 12 ? 'ทุกเช้า' : 'ทุกวัน'} ${labels[0]}`
}

/** ผู้ให้บริการโมเดลของแชทบอทซ่อมบำรุงตามลำดับ (ตัวแรก = หลัก, ตัวถัดไป = สำรองเมื่อตัวแรกใช้ไม่ได้) */
export function maintenanceProviderOrder(): Array<'anthropic' | 'openai'> {
  const pref = config.maintenance.provider
  const has = { anthropic: config.anthropic.apiKey !== '', openai: config.openai.apiKey !== '' }
  if (pref === 'anthropic') return has.anthropic ? ['anthropic'] : []
  if (pref === 'openai') return has.openai ? ['openai'] : []
  const order: Array<'anthropic' | 'openai'> = []
  if (has.openai) order.push('openai')
  if (has.anthropic) order.push('anthropic')
  return order
}

/** ชื่อโมเดลที่แชทบอทซ่อมบำรุงจะใช้ (แสดงใน log ตอนเริ่มระบบ) */
export function maintenanceModelLabel(): string {
  const order = maintenanceProviderOrder()
  if (order.length === 0) return 'ยังไม่มี API key (ANTHROPIC_API_KEY หรือ OPENAI_API_KEY)'
  return order
    .map((p) => (p === 'anthropic' ? `Claude ${config.maintenance.model}` : `OpenAI ${config.openai.model}`))
    .join(' -> ')
}

/**
 * บอกว่าการสรุปแชทจะใช้อะไร โดยเรียงตามลำดับเดียวกับใน src/services/summary.ts
 * (OpenAI ก่อน แล้วค่อย Claude สุดท้ายคือ rule-based ในเครื่อง)
 */
export function aiProviderLabel(): string {
  if (config.openai.apiKey) return `OpenAI (${config.openai.model})`
  if (config.anthropic.apiKey) return `Claude (${config.anthropic.model})`
  return 'rule-based ในเครื่อง (ไม่ได้ใส่ OPENAI_API_KEY หรือ ANTHROPIC_API_KEY)'
}

export function describeConfig(): string {
  const lines = [
    `สภาพแวดล้อม   : ${config.nodeEnv}`,
    `Base path      : ${config.basePath || '/ (root)'}`,
    `ฐานข้อมูล      : ${config.databaseUrl.replace(/:[^:@/]*@/, ':****@')}${config.databaseSsl ? ' (SSL)' : ''}`,
    `โหมด LINE      : ${config.mockLine ? 'MOCK (ไม่ยิง API จริง)' : 'LIVE (ส่งเข้า LINE จริง)'}`,
    `Channel secret : ${config.channelSecret ? 'ตั้งค่าแล้ว (ตรวจ signature)' : 'ยังไม่ตั้ง (webhook จะข้ามการตรวจ signature)'}`,
    `Maintenance OA : ${
      config.maintenance.enabled
        ? `เปิด (${
            config.maintenance.sharedOa ? 'ใช้ OA HR ร่วมกัน ตอบที่ /webhook' : '/webhook/mt'
          }, ${config.maintenance.mockLine ? 'MOCK' : 'LIVE'}, MCP ${config.maintenance.mcpUrl}, โมเดล ${maintenanceModelLabel()})`
        : 'ยังไม่ตั้ง CHANNEL_ACCESS_TOKEN_MT/CHANNEL_SECRET_MT (หรือ MAINTENANCE_USE_HR_OA=true)'
    }`,
    `MT events      : ${
      config.maintenance.events.enabled
        ? `รับจาก RabbitMQ ${config.maintenance.events.url.replace(/:[^:@/]*@/, ':****@')} (${config.maintenance.events.routingKeys.join(', ')})`
        : 'ปิด (ไม่ได้ตั้ง RABBITMQ_URL)'
    }`,
    `MT กลุ่มแจ้งเตือน : ${
      config.maintenance.alertGroupIds.length > 0
        ? config.maintenance.alertGroupIds.join(', ')
        : `เฉพาะกลุ่มที่ชื่อมีคำว่า ${config.maintenance.groupKeywords.join(' / ')} (ไม่มี = ไม่ส่ง)`
    }`,
    `Session        : ${config.sessionInDatabase ? 'เก็บใน PostgreSQL' : 'เก็บใน memory (หายเมื่อ restart)'}`,
    `AI สรุปแชท     : ${aiProviderLabel()}`,
    `LINE Login     : ${
      config.lineLogin.enabled
        ? `เปิด (channel ${config.lineLogin.channelId}, callback ${config.lineLogin.callbackUrl})`
        : `ยังไม่ตั้ง LINE_LOGIN_CHANNEL_ID/SECRET${config.myAttendanceAllowUnverified ? ' (อนุญาตพิมพ์รหัสเองได้)' : ' (เวลาเข้างานของฉันจะใช้ไม่ได้)'}`
    }`,
    `เก็บไฟล์สื่อ    : ${
      config.media.enabled
        ? `เปิด (${config.media.driver === 'local' ? `ดิสก์ ${config.media.localDir}` : 's3'}, สูงสุด ${config.media.maxSizeMb} MB/ไฟล์)`
        : 'ปิด'
    }`,
    `ตัวตั้งเวลา     : ${
      config.scheduler.enabled
        ? `เปิด (สรุปแชท ${config.scheduler.summaryCron} / สรุปการเข้างาน ${config.scheduler.reportCron} -> ${
            config.scheduler.reportTargets.length > 0 ? config.scheduler.reportTargets.join(', ') : config.defaultGroupId || 'ยังไม่ได้ตั้งปลายทาง'
          }${
            config.maintenance.enabled
              ? ` / MT งานซ่อมค้าง ${config.scheduler.mtPendingCron || 'ปิด'} / MT เร่งด่วน ${config.scheduler.mtUrgentCron || 'ปิด'}`
              : ''
          })`
        : 'ปิด (ใช้ Task Scheduler หรือ cron ภายนอก)'
    }`
  ]
  return lines.join('\n   ')
}
