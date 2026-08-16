import path from 'node:path'
import { config } from '../config'
import { query, queryOne } from '../db'
import { getContentTranscodingStatus, getMessageContent, getMessageContentPreview } from '../line/client'
import { formatBytes, getStorage } from './storage'

// ---------------------------------------------------------------------------
// Media Archiver
//
// โจทย์: "ภาพและไฟล์ในไลน์กลุ่มหมดอายุ กดโหลดไม่ได้"
// วิธีแก้: ทันทีที่ webhook แจ้งว่ามีไฟล์เข้ากลุ่ม ให้ดาวน์โหลดมาเก็บใน storage
//         ของเราเอง แล้วบันทึกที่อยู่ไฟล์ลงตาราง media_files
//         ตั้งแต่นั้นไฟล์เป็นของเรา ไม่ผูกกับอายุของ LINE อีกต่อไป
// ---------------------------------------------------------------------------

export interface MediaRow {
  id: number
  line_message_id: string
  group_id: string | null
  group_name?: string | null
  user_id: string | null
  display_name: string | null
  media_type: string
  file_name: string | null
  caption: string | null
  content_type: string | null
  size_bytes: string | number | null
  storage_driver: string
  storage_key: string
  preview_key: string | null
  status: string
  error: string | null
  sent_at: Date | null
  archived_at: Date | null
}

export interface ArchiveInput {
  lineMessageId: string
  groupId: string
  userId: string | null
  displayName: string | null
  mediaType: 'image' | 'video' | 'audio' | 'file'
  fileName?: string | null
  fileSize?: number | null
  sentAt: Date
}

const EXT_BY_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'video/mp4': 'mp4',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/mpeg': 'mp3',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/csv': 'csv'
}

function pickExtension(contentType: string | null, fileName?: string | null): string {
  if (fileName && path.extname(fileName)) return path.extname(fileName).slice(1).toLowerCase()
  if (contentType) {
    const clean = contentType.split(';')[0].trim().toLowerCase()
    if (EXT_BY_TYPE[clean]) return EXT_BY_TYPE[clean]
    const sub = clean.split('/')[1]
    if (sub) return sub.replace(/[^a-z0-9]/g, '').slice(0, 8) || 'bin'
  }
  return 'bin'
}

/** นามสกุลเริ่มต้นเมื่อ LINE ไม่ได้บอก content-type มา */
const DEFAULT_EXT: Record<string, string> = { image: 'jpg', video: 'mp4', audio: 'm4a', file: 'dat' }
const NAME_PREFIX: Record<string, string> = { image: 'IMG', video: 'VID', audio: 'AUD', file: 'FILE' }

/**
 * ชื่อไฟล์ที่เอาไว้แสดงในแกลเลอรี
 *
 * ข้อเท็จจริงที่ผู้เรียนมักไม่รู้: LINE ส่ง fileName มาให้เฉพาะข้อความชนิด file เท่านั้น
 * รูปและวิดีโอไม่มีชื่อไฟล์ติดมาเลย เราจึงประกอบชื่อขึ้นเองจากเวลาที่ส่ง
 * ให้ได้รูปแบบคุ้นตาแบบ IMG_20260809_1042.jpg
 */
export function mediaFileLabel(row: {
  media_type: string
  file_name: string | null
  content_type: string | null
  sent_at: Date | string | null
  line_message_id: string
}): string {
  if (row.file_name) return row.file_name

  const ext = row.content_type ? pickExtension(row.content_type) : (DEFAULT_EXT[row.media_type] ?? 'dat')
  const prefix = NAME_PREFIX[row.media_type] ?? 'FILE'

  if (!row.sent_at) return `${prefix}_${row.line_message_id.slice(-8)}.${ext}`

  // en-CA + hourCycle h23 ให้ผลเป็น 2026-08-09, 10:42 เสมอ ไม่ว่าเครื่องจะตั้ง locale อะไร
  const parts = new Date(row.sent_at)
    .toLocaleString('en-CA', {
      timeZone: config.timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    })
    .replace(/[^0-9]/g, '')
  return `${prefix}_${parts.slice(0, 8)}_${parts.slice(8, 12)}.${ext}`
}

/** โครงที่เก็บไฟล์: <groupId>/<ปี>/<เดือน>/<messageId>.<นามสกุล> */
function buildKey(input: ArchiveInput, ext: string, preview = false): string {
  const d = input.sentAt
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const group = (input.groupId || 'unknown').replace(/[^A-Za-z0-9_-]/g, '')
  const suffix = preview ? '_preview.jpg' : `.${ext}`
  return `${group}/${yyyy}/${mm}/${input.lineMessageId}${suffix}`
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * ดึงไฟล์จาก LINE มาเก็บ
 * วิดีโอและเสียงต้องรอ LINE แปลงไฟล์เสร็จก่อน จึงมีการ retry ให้
 */
export async function archiveMedia(input: ArchiveInput): Promise<'stored' | 'skipped' | 'failed'> {
  if (!config.media.enabled) return 'skipped'
  if (!config.media.types.includes(input.mediaType)) return 'skipped'

  const maxBytes = config.media.maxSizeMb * 1024 * 1024
  if (input.fileSize && input.fileSize > maxBytes) {
    await recordFailure(input, `ไฟล์ใหญ่เกินกำหนด (${formatBytes(input.fileSize)} > ${config.media.maxSizeMb} MB)`, 'skipped')
    return 'skipped'
  }

  try {
    // วิดีโอ/เสียง: รอ LINE แปลงไฟล์ให้เสร็จก่อน (สูงสุดราว 15 วินาที)
    if (input.mediaType === 'video' || input.mediaType === 'audio') {
      for (let i = 0; i < 5; i += 1) {
        const status = await getContentTranscodingStatus(input.lineMessageId)
        if (status === null || status === 'succeeded') break
        if (status === 'failed') throw new Error('LINE แปลงไฟล์ไม่สำเร็จ (transcoding failed)')
        await sleep(3000)
      }
    }

    const content = await getMessageContent(input.lineMessageId)
    if (content.buffer.length > maxBytes) {
      await recordFailure(input, `ไฟล์ใหญ่เกินกำหนด (${formatBytes(content.buffer.length)})`, 'skipped')
      return 'skipped'
    }

    const storage = getStorage()
    const ext = pickExtension(content.contentType, input.fileName)
    const key = buildKey(input, ext)
    const put = await storage.put(key, content.buffer)

    // ภาพย่อสำหรับรูปและวิดีโอ (ถ้าดึงไม่ได้ก็ไม่เป็นไร ไม่ให้ทั้งงานล้ม)
    let previewKey: string | null = null
    if (config.media.savePreview && (input.mediaType === 'image' || input.mediaType === 'video')) {
      try {
        const preview = await getMessageContentPreview(input.lineMessageId)
        previewKey = buildKey(input, 'jpg', true)
        await storage.put(previewKey, preview.buffer)
      } catch {
        previewKey = null
      }
    }

    await query(
      `INSERT INTO media_files
         (line_message_id, group_id, user_id, display_name, media_type, file_name, content_type,
          size_bytes, storage_driver, storage_key, preview_key, checksum, status, sent_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'stored',$13)
       ON CONFLICT (line_message_id) DO NOTHING`,
      [
        input.lineMessageId, input.groupId, input.userId, input.displayName, input.mediaType,
        input.fileName ?? null, content.contentType, put.size, storage.driver, put.key,
        previewKey, put.checksum, input.sentAt
      ]
    )

    console.log(`[สื่อ] เก็บ ${input.mediaType} ${formatBytes(put.size)} -> ${put.key}`)
    return 'stored'
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[สื่อ] เก็บไม่สำเร็จ (${input.lineMessageId}):`, message)
    await recordFailure(input, message, 'failed')
    return 'failed'
  }
}

async function recordFailure(input: ArchiveInput, reason: string, status: 'failed' | 'skipped'): Promise<void> {
  try {
    await query(
      `INSERT INTO media_files
         (line_message_id, group_id, user_id, display_name, media_type, file_name,
          storage_driver, storage_key, status, error, sent_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'',$8,$9,$10)
       ON CONFLICT (line_message_id) DO NOTHING`,
      [
        input.lineMessageId, input.groupId, input.userId, input.displayName, input.mediaType,
        input.fileName ?? null, config.media.driver, status, reason, input.sentAt
      ]
    )
  } catch {
    /* ไม่ให้การบันทึก log ทำให้ระบบล้มซ้ำ */
  }
}

// ---------------------------------------------------------------------------
// อ่านข้อมูลสำหรับหน้าแกลเลอรี
// ---------------------------------------------------------------------------

export interface MediaFilter {
  groupId?: string
  mediaType?: string
  keyword?: string
  sender?: string
  dateFrom?: string
  dateTo?: string
  page?: number
  pageSize?: number
}

function buildWhere(filter: MediaFilter): { clause: string; params: unknown[] } {
  const conds = ["m.status = 'stored'"]
  const params: unknown[] = []
  if (filter.groupId) {
    params.push(filter.groupId)
    conds.push(`m.group_id = $${params.length}`)
  }
  if (filter.mediaType) {
    params.push(filter.mediaType)
    conds.push(`m.media_type = $${params.length}`)
  }
  if (filter.keyword) {
    params.push(`%${filter.keyword}%`)
    // ค้นได้ทั้งชื่อไฟล์เดิมและคำบรรยายที่แอดมินตั้งไว้
    conds.push(
      `(COALESCE(m.file_name, '') ILIKE $${params.length} OR COALESCE(m.caption, '') ILIKE $${params.length})`
    )
  }
  if (filter.sender) {
    params.push(`%${filter.sender}%`)
    conds.push(`COALESCE(m.display_name, '') ILIKE $${params.length}`)
  }
  if (filter.dateFrom) {
    params.push(filter.dateFrom)
    conds.push(`(m.sent_at AT TIME ZONE 'Asia/Bangkok')::date >= $${params.length}::date`)
  }
  if (filter.dateTo) {
    params.push(filter.dateTo)
    conds.push(`(m.sent_at AT TIME ZONE 'Asia/Bangkok')::date <= $${params.length}::date`)
  }
  return { clause: `WHERE ${conds.join(' AND ')}`, params }
}

export async function searchMedia(filter: MediaFilter): Promise<{
  rows: MediaRow[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}> {
  const page = Math.max(1, filter.page ?? 1)
  const pageSize = Math.min(120, Math.max(12, filter.pageSize ?? 24))
  const { clause, params } = buildWhere(filter)

  const countRow = await queryOne<{ total: string }>(
    `SELECT COUNT(*) AS total FROM media_files m ${clause}`,
    params
  )
  const total = Number(countRow?.total ?? 0)

  const rows = await query<MediaRow>(
    `SELECT m.*, g.group_name
       FROM media_files m
       LEFT JOIN line_groups g ON g.group_id = m.group_id
       ${clause}
      ORDER BY m.sent_at DESC NULLS LAST, m.id DESC
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
    params
  )

  return { rows, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) }
}

export async function getMedia(id: number): Promise<MediaRow | null> {
  return queryOne<MediaRow>('SELECT * FROM media_files WHERE id = $1', [id])
}

/**
 * ตั้งคำบรรยายไฟล์ (เช่น "ใบเสร็จค่าขนส่ง")
 * รูปจากไลน์ไม่มีชื่อไฟล์และไม่มีคำบรรยายติดมา การให้แอดมินตั้งเองคือวิธีเดียว
 * ที่จะทำให้ค้นหาไฟล์ย้อนหลังเจอด้วยคำที่คนจำได้
 */
export async function setMediaCaption(id: number, caption: string | null): Promise<void> {
  await query('UPDATE media_files SET caption = $2 WHERE id = $1', [id, caption?.slice(0, 255) ?? null])
}

export async function readMediaBuffer(row: MediaRow, preview = false): Promise<Buffer> {
  const key = preview && row.preview_key ? row.preview_key : row.storage_key
  return getStorage().get(key)
}

export interface MediaStats {
  total: number
  bytes: number
  byType: { type: string; count: number; bytes: number }[]
  failed: number
  oldest: Date | null
  newest: Date | null
}

export async function mediaStats(groupId?: string): Promise<MediaStats> {
  const rows = await query<{ media_type: string; c: string; b: string }>(
    `SELECT media_type, COUNT(*) AS c, COALESCE(SUM(size_bytes), 0) AS b
       FROM media_files
      WHERE status = 'stored' AND ($1::text IS NULL OR group_id = $1)
      GROUP BY media_type
      ORDER BY COUNT(*) DESC`,
    [groupId ?? null]
  )
  const extra = await queryOne<{ failed: string; oldest: Date | null; newest: Date | null }>(
    `SELECT COUNT(*) FILTER (WHERE status = 'failed') AS failed,
            MIN(sent_at) FILTER (WHERE status = 'stored') AS oldest,
            MAX(sent_at) FILTER (WHERE status = 'stored') AS newest
       FROM media_files
      WHERE ($1::text IS NULL OR group_id = $1)`,
    [groupId ?? null]
  )

  const byType = rows.map((r) => ({ type: r.media_type, count: Number(r.c), bytes: Number(r.b) }))
  return {
    total: byType.reduce((s, t) => s + t.count, 0),
    bytes: byType.reduce((s, t) => s + t.bytes, 0),
    byType,
    failed: Number(extra?.failed ?? 0),
    oldest: extra?.oldest ?? null,
    newest: extra?.newest ?? null
  }
}

// ---------------------------------------------------------------------------
// การลบ
// ---------------------------------------------------------------------------

/**
 * ลบไฟล์ที่ผูกกับข้อความหนึ่ง ๆ
 * ใช้เมื่อผู้ใช้กดยกเลิกส่ง (unsend) ซึ่ง LINE กำหนดให้ระบบที่เก็บข้อมูล
 * ลบข้อมูลนั้นออกจากฐานข้อมูลและ storage ด้วย
 */
export async function deleteMediaByMessageId(lineMessageId: string, reason: string): Promise<boolean> {
  const row = await queryOne<MediaRow>('SELECT * FROM media_files WHERE line_message_id = $1', [lineMessageId])
  if (!row) return false

  const storage = getStorage()
  for (const key of [row.storage_key, row.preview_key]) {
    if (!key) continue
    try {
      await storage.delete(key)
    } catch (err) {
      console.error('[สื่อ] ลบไฟล์ออกจาก storage ไม่สำเร็จ:', err instanceof Error ? err.message : err)
    }
  }

  await query(
    `UPDATE media_files
        SET status = 'deleted', deleted_at = now(), deleted_reason = $2,
            storage_key = '', preview_key = NULL
      WHERE line_message_id = $1`,
    [lineMessageId, reason]
  )
  return true
}

/** ลบไฟล์ที่เก่ากว่า N วัน ตามนโยบายเก็บข้อมูลขององค์กร */
export async function deleteMediaOlderThan(days: number): Promise<number> {
  const rows = await query<MediaRow>(
    `SELECT * FROM media_files
      WHERE status = 'stored' AND sent_at < now() - ($1 || ' days')::interval`,
    [days]
  )
  let removed = 0
  for (const row of rows) {
    if (await deleteMediaByMessageId(row.line_message_id, 'retention')) removed += 1
  }
  return removed
}
