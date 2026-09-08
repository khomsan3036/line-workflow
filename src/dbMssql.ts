import sql from 'mssql'
import { config } from './config'

// ---------------------------------------------------------------------------
// เชื่อมต่อ SQL Server ของระบบ HR (ตาราง AttendanceDaily จากเครื่องสแกนนิ้ว)
//
// เปิด pool แบบ lazy: ต่อครั้งแรกเมื่อมีคนถามข้อมูล ไม่ต่อตอนเริ่มระบบ
// เพื่อให้ dashboard และ webhook ทำงานได้แม้เครื่อง HR ปิดอยู่
// ---------------------------------------------------------------------------

let poolPromise: Promise<sql.ConnectionPool> | null = null

export function mssqlEnabled(): boolean {
  return config.mssqlConnectionString.trim() !== ''
}

export async function getMssqlPool(): Promise<sql.ConnectionPool> {
  if (!mssqlEnabled()) throw new Error('ยังไม่ได้ตั้งค่า DATABASE_URL_MSSQL')

  if (!poolPromise) {
    poolPromise = new sql.ConnectionPool(config.mssqlConnectionString)
      .connect()
      .then((pool) => {
        pool.on('error', (err) => {
          console.error('[MSSQL] pool error:', err.message)
          poolPromise = null
        })
        return pool
      })
      .catch((err) => {
        // ต่อไม่สำเร็จ ให้ลองใหม่ในคำถามถัดไป
        poolPromise = null
        throw err
      })
  }
  return poolPromise
}

/** ปิด pool (ใช้ตอนจบสคริปต์ CLI ไม่งั้นโปรเซสไม่ออก) */
export async function closeMssqlPool(): Promise<void> {
  if (!poolPromise) return
  try {
    const pool = await poolPromise
    await pool.close()
  } catch {
    // ต่อไม่ติดตั้งแต่แรกก็ไม่มีอะไรต้องปิด
  }
  poolPromise = null
}

export { sql }
