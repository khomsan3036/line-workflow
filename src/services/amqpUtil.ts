import { existsSync } from 'node:fs'
import type { ChannelModel } from 'amqplib'

// ---------------------------------------------------------------------------
// ตัวช่วยร่วมของ consumer RabbitMQ ทั้งสามตัว (MT / ร้องเรียน / ใบขอเบิกสโตร์)
// ---------------------------------------------------------------------------

/**
 * ข้อความ error ของการต่อ RabbitMQ ที่อ่านรู้เรื่อง
 *
 * Node ต่อ host ที่มีทั้ง IPv6 และ IPv4 (เช่น localhost -> ::1 และ 127.0.0.1) พร้อมกัน ถ้าล้มทั้งคู่จะ throw
 * AggregateError ที่ message ว่างเปล่า รายละเอียดจริง ("connect ECONNREFUSED 127.0.0.1:5672") อยู่ใน errors[]
 * ทำให้ log เดิมขึ้นแค่ "เชื่อมต่อ RabbitMQ ไม่ได้ ()" — ฟังก์ชันนี้ดึงรายละเอียดนั้นออกมา
 */
export function describeAmqpError(err: unknown): string {
  if (err instanceof AggregateError) {
    const parts = err.errors.map((e) => (e instanceof Error ? e.message : String(e))).filter(Boolean)
    if (parts.length > 0) return parts.join(' / ')
  }
  if (err instanceof Error) {
    if (err.message) return err.message
    const code = (err as NodeJS.ErrnoException).code
    return code ? `${err.name} (${code})` : err.name
  }
  return String(err)
}

/**
 * ปิด connection ที่ต่อ broker ได้แล้วแต่ตั้งค่าต่อไม่สำเร็จ (assertExchange/assertQueue/consume ล้ม)
 * ไม่งั้นทุกครั้งที่ลองใหม่จะมี connection ค้างเพิ่มขึ้นทีละตัว
 * ถอด listener 'close' ก่อน เพื่อไม่ให้ handler ของ consumer นัดลองใหม่ซ้ำกับ connectWithRetry
 */
export async function closeAbandonedConnection(conn: ChannelModel): Promise<void> {
  conn.removeAllListeners('close')
  conn.removeAllListeners('error')
  conn.on('error', () => {
    /* กำลังทิ้งอยู่แล้ว */
  })
  try {
    await conn.close()
  } catch {
    /* ปิดไม่ได้ก็ปล่อย (socket อาจตายไปแล้ว) */
  }
}

/** รันอยู่ใน container หรือไม่ (Docker สร้าง /.dockerenv ให้ทุก container) */
function inContainer(): boolean {
  try {
    return existsSync('/.dockerenv')
  } catch {
    return false
  }
}

/**
 * เตือนตั้งแต่ตอนเริ่ม consumer ถ้า URL ของ broker ชี้ localhost ทั้งที่แอปรันใน Docker:
 * ใน container "localhost" คือตัว container เอง ไม่ใช่เครื่อง Windows ที่ RabbitMQ อยู่ ต่อไม่ติดแน่นอน
 * (production 2026-10-21: STORE_EVENTS_RABBITMQ_URL คัดลอกค่า localhost มาจากเครื่อง dev)
 */
export function warnIfLocalhostBrokerInContainer(label: string, url: string, envName: string): void {
  if (!inContainer()) return
  let host = ''
  try {
    host = new URL(url).hostname
  } catch {
    return
  }
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') {
    console.warn(
      `[${label}] ${envName} ชี้ไปที่ ${host} แต่แอปรันใน Docker ซึ่ง localhost คือตัว container เอง ` +
        'จะต่อ RabbitMQ ไม่ได้ — ใช้ host.docker.internal (broker อยู่บนเครื่อง Windows เดียวกัน) หรือ IP ของเครื่องที่ broker อยู่'
    )
  }
}
