import 'dotenv/config'

// ---------------------------------------------------------------------------
// รวมค่า config ทั้งหมดไว้ที่เดียว อ่านจากไฟล์ .env
// ตั้งใจไม่ throw error ตอนเริ่มระบบ เพื่อให้ผู้เรียนเปิด dashboard ดูได้
// แม้ยังไม่ได้ตั้งค่า LINE (ระบบจะทำงานในโหมด MOCK ให้อัตโนมัติ)
// ---------------------------------------------------------------------------

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback
  return value.toLowerCase() === 'true' || value === '1'
}

const channelAccessToken = process.env.CHANNEL_ACCESS_TOKEN ?? ''
const channelSecret = process.env.CHANNEL_SECRET ?? ''

// ถ้าไม่ได้ตั้ง token ไว้ ให้บังคับเป็นโหมด mock เสมอ (ยิง API จริงไม่ได้อยู่ดี)
const mockLine = bool(process.env.MOCK_LINE, true) || channelAccessToken === ''

const nodeEnv = process.env.NODE_ENV ?? 'development'
const databaseUrl = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/linechat'

// ผู้ให้บริการฐานข้อมูลบน cloud (เช่น Neon, Supabase, Render) บังคับใช้ SSL
// ตรวจจากใน connection string ให้อัตโนมัติ หรือสั่งเปิดเองด้วย DATABASE_SSL=true
const databaseSsl = bool(process.env.DATABASE_SSL, /sslmode=(require|verify-ca|verify-full)/.test(databaseUrl))

export const config = {
  nodeEnv,
  isProduction: nodeEnv === 'production',
  port: Number(process.env.PORT ?? 3000),
  timezone: process.env.TZ ?? 'Asia/Bangkok',

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

  channelAccessToken,
  channelSecret,
  mockLine,
  defaultGroupId: process.env.DEFAULT_GROUP_ID ?? '',

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
    reportCron: process.env.REPORT_CRON ?? '0 8 * * *'
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
 * ประโยคบอกรอบการส่งรายงาน ใช้ทั้งท้ายการ์ด Flex และหน้า /sales
 * ถ้ายังไม่ได้เปิดตัวตั้งเวลา จะไม่โฆษณาว่าส่งอัตโนมัติ (กันผู้เรียนเข้าใจผิด)
 */
export function reportScheduleNote(): string | null {
  if (!config.scheduler.enabled) return null
  const label = cronTimeLabel(config.scheduler.reportCron)
  if (!label) return `ตั้งเวลาส่งอัตโนมัติไว้แล้ว (REPORT_CRON = ${config.scheduler.reportCron})`
  const hour = Number(label.slice(0, 2))
  return `ส่งอัตโนมัติ${hour < 12 ? 'ทุกเช้า' : 'ทุกวัน'} ${label}`
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
    `ฐานข้อมูล      : ${config.databaseUrl.replace(/:[^:@/]*@/, ':****@')}${config.databaseSsl ? ' (SSL)' : ''}`,
    `โหมด LINE      : ${config.mockLine ? 'MOCK (ไม่ยิง API จริง)' : 'LIVE (ส่งเข้า LINE จริง)'}`,
    `Channel secret : ${config.channelSecret ? 'ตั้งค่าแล้ว (ตรวจ signature)' : 'ยังไม่ตั้ง (webhook จะข้ามการตรวจ signature)'}`,
    `Session        : ${config.sessionInDatabase ? 'เก็บใน PostgreSQL' : 'เก็บใน memory (หายเมื่อ restart)'}`,
    `AI สรุปแชท     : ${aiProviderLabel()}`,
    `เก็บไฟล์สื่อ    : ${
      config.media.enabled
        ? `เปิด (${config.media.driver === 'local' ? `ดิสก์ ${config.media.localDir}` : 's3'}, สูงสุด ${config.media.maxSizeMb} MB/ไฟล์)`
        : 'ปิด'
    }`,
    `ตัวตั้งเวลา     : ${
      config.scheduler.enabled
        ? `เปิด (สรุป ${config.scheduler.summaryCron} / รายงาน ${config.scheduler.reportCron})`
        : 'ปิด (ใช้ Task Scheduler หรือ cron ภายนอก)'
    }`
  ]
  return lines.join('\n   ')
}
