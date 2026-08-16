import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { config } from '../config'

// ---------------------------------------------------------------------------
// ชั้นเก็บไฟล์ (Storage layer)
//
// ออกแบบเป็น interface เดียว แล้วมีผู้ให้บริการหลายแบบข้างใต้
//   - LocalDiskStorage : เก็บลงดิสก์ในเครื่อง (ค่าเริ่มต้น เห็นไฟล์จริงได้ เหมาะกับตอนเรียน)
//   - S3Storage        : เก็บขึ้น object storage เช่น Cloudflare R2 / AWS S3 / MinIO
//
// จุดสอน: โค้ดส่วนอื่นของระบบเรียกผ่าน getStorage() เท่านั้น จึงย้ายจากดิสก์
// ขึ้น cloud ได้โดยแก้ไฟล์นี้ไฟล์เดียว ไม่ต้องแตะ webhook หรือ dashboard เลย
// ---------------------------------------------------------------------------

export interface PutResult {
  key: string
  size: number
  checksum: string
}

export interface Storage {
  readonly driver: 'local' | 's3'
  put(key: string, data: Buffer): Promise<PutResult>
  get(key: string): Promise<Buffer>
  delete(key: string): Promise<void>
  exists(key: string): Promise<boolean>
  /** ขนาดรวมที่ใช้ไปทั้งหมด (ไบต์) ใช้แสดงในหน้า dashboard */
  usage(): Promise<{ files: number; bytes: number }>
}

function sha256(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex')
}

// ---------------------------------------------------------------------------
// เก็บลงดิสก์ในเครื่อง
// ---------------------------------------------------------------------------
class LocalDiskStorage implements Storage {
  readonly driver = 'local' as const
  private root: string

  constructor(dir: string) {
    // path แบบ relative จะอิงจากโฟลเดอร์ที่รันโปรแกรม (cwd) เสมอ เพื่อให้ผลลัพธ์เดาได้
    this.root = path.isAbsolute(dir) ? dir : path.join(process.cwd(), dir)
    fs.mkdirSync(this.root, { recursive: true })
  }

  /** กัน path traversal: ห้าม key พาออกไปนอกโฟลเดอร์ที่กำหนด */
  private resolve(key: string): string {
    const full = path.resolve(this.root, key)
    if (!full.startsWith(this.root)) throw new Error(`storage key ไม่ถูกต้อง: ${key}`)
    return full
  }

  async put(key: string, data: Buffer): Promise<PutResult> {
    const full = this.resolve(key)
    await fs.promises.mkdir(path.dirname(full), { recursive: true })
    await fs.promises.writeFile(full, data)
    return { key, size: data.length, checksum: sha256(data) }
  }

  async get(key: string): Promise<Buffer> {
    return fs.promises.readFile(this.resolve(key))
  }

  async delete(key: string): Promise<void> {
    await fs.promises.rm(this.resolve(key), { force: true })
  }

  async exists(key: string): Promise<boolean> {
    try {
      await fs.promises.access(this.resolve(key))
      return true
    } catch {
      return false
    }
  }

  async usage(): Promise<{ files: number; bytes: number }> {
    let files = 0
    let bytes = 0
    const walk = async (dir: string): Promise<void> => {
      let entries: fs.Dirent[]
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        const full = path.join(dir, e.name)
        if (e.isDirectory()) await walk(full)
        else {
          const st = await fs.promises.stat(full)
          files += 1
          bytes += st.size
        }
      }
    }
    await walk(this.root)
    return { files, bytes }
  }
}

// ---------------------------------------------------------------------------
// เก็บขึ้น object storage (S3 / Cloudflare R2 / MinIO)
//
// วิธีเปิดใช้งาน
//   1) npm install @aws-sdk/client-s3
//   2) ตั้งค่าใน .env
//        MEDIA_STORAGE_DRIVER=s3
//        S3_BUCKET=line-media
//        S3_REGION=auto
//        S3_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com   (R2)
//        S3_ACCESS_KEY_ID=...
//        S3_SECRET_ACCESS_KEY=...
//   3) เอา comment ของโค้ดข้างล่างออก
//
// ตั้งใจไม่ใส่ @aws-sdk/client-s3 เป็น dependency ตั้งแต่ต้น เพราะผู้เรียนส่วนใหญ่
// ใช้ดิสก์ในเครื่องก็พอ ไม่ต้องโหลด package เพิ่มโดยไม่จำเป็น
// ---------------------------------------------------------------------------
class S3Storage implements Storage {
  readonly driver = 's3' as const

  constructor() {
    if (!config.media.s3.bucket) {
      throw new Error('ตั้ง MEDIA_STORAGE_DRIVER=s3 แล้วแต่ยังไม่ได้ใส่ S3_BUCKET ใน .env')
    }
    throw new Error(
      'ยังไม่ได้เปิดใช้งาน S3 driver: ติดตั้ง @aws-sdk/client-s3 แล้วเปิดโค้ดใน src/services/storage.ts ตามคอมเมนต์'
    )
  }

  /* ตัวอย่างการเขียนจริงเมื่อติดตั้ง @aws-sdk/client-s3 แล้ว

  private client = new S3Client({
    region: config.media.s3.region,
    endpoint: config.media.s3.endpoint || undefined,
    credentials: {
      accessKeyId: config.media.s3.accessKeyId,
      secretAccessKey: config.media.s3.secretAccessKey
    }
  })

  async put(key: string, data: Buffer): Promise<PutResult> {
    await this.client.send(new PutObjectCommand({
      Bucket: config.media.s3.bucket, Key: key, Body: data
    }))
    return { key, size: data.length, checksum: sha256(data) }
  }

  async get(key: string): Promise<Buffer> {
    const res = await this.client.send(new GetObjectCommand({
      Bucket: config.media.s3.bucket, Key: key
    }))
    return Buffer.from(await res.Body.transformToByteArray())
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({
      Bucket: config.media.s3.bucket, Key: key
    }))
  }

  */

  async put(): Promise<PutResult> {
    throw new Error('S3 driver ยังไม่เปิดใช้งาน')
  }
  async get(): Promise<Buffer> {
    throw new Error('S3 driver ยังไม่เปิดใช้งาน')
  }
  async delete(): Promise<void> {
    throw new Error('S3 driver ยังไม่เปิดใช้งาน')
  }
  async exists(): Promise<boolean> {
    return false
  }
  async usage(): Promise<{ files: number; bytes: number }> {
    // object storage นับขนาดรวมจากฐานข้อมูลแทน (ดู services/media.ts)
    return { files: 0, bytes: 0 }
  }
}

let instance: Storage | null = null

export function getStorage(): Storage {
  if (!instance) {
    instance = config.media.driver === 's3' ? new S3Storage() : new LocalDiskStorage(config.media.localDir)
  }
  return instance
}

/** แปลงไบต์เป็นข้อความอ่านง่าย เช่น 2.4 MB */
export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const value = bytes / Math.pow(1024, i)
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}
