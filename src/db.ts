import { Pool, type QueryResultRow } from 'pg'
import { config } from './config'

// ---------------------------------------------------------------------------
// PostgreSQL connection pool
// ตั้ง time zone ของทุก connection เป็นเวลาไทย เพื่อให้การจัดกลุ่ม "รายวัน"
// ตรงกับความรู้สึกของผู้ใช้ (ไม่ใช่ UTC)
// ---------------------------------------------------------------------------
export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: config.poolMax,
  // ฐานข้อมูลบน cloud (Neon, Supabase, Render) บังคับ SSL
  // ปกติใบรับรองออกโดย CA สาธารณะ จึงตรวจสอบได้ตามปกติ
  ssl: config.databaseSsl ? { rejectUnauthorized: !config.databaseSslNoVerify } : undefined
})

pool.on('connect', (client) => {
  client.query(`SET TIME ZONE '${config.timezone}'`).catch(() => {
    /* ไม่ critical ถ้าตั้งไม่สำเร็จ */
  })
})

pool.on('error', (err) => {
  console.error('[DB] pool error:', err.message)
})

/** helper สั้น ๆ ใช้แทน pool.query เพื่อให้โค้ดอ่านง่ายและได้ type ของแถว */
export async function query<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  const result = await pool.query<T>(sql, params)
  return result.rows
}

/** คืนค่าแถวแรกหรือ null */
export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = []
): Promise<T | null> {
  const rows = await query<T>(sql, params)
  return rows[0] ?? null
}

/** ตรวจว่าเชื่อมฐานข้อมูลได้หรือไม่ ใช้ตอน start server และหน้า /health */
export async function checkDatabase(): Promise<{ ok: boolean; error?: string }> {
  try {
    await pool.query('SELECT 1')
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
