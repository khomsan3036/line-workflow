import { pool } from '../src/db'
import { config } from '../src/config'
import type { ChannelKey } from '../src/line/client'
import { getGroup } from '../src/services/groups'
import { sendAndLog } from '../src/services/messaging'
import { buildFuelDigestCard, fuelDigestToText, parseFuelDigest } from '../src/services/fuelDigestFlex'

// ---------------------------------------------------------------------------
// ทดสอบหน้าตาการ์ด "สรุปขอเติมน้ำมันตามรอบ" ด้วยข้อมูลตัวอย่าง — ไม่ต้องมี RabbitMQ และ fuel-service
// ของจริงมาจาก maintenance-fuel-service (category fuel_request_digest) ผ่าน src/services/maintenanceEvents.ts
//
//   npm run fuel-digest-card -- --to=Cxxxx                ส่งการ์ดตัวอย่าง (มีคำขอใหม่ 11 รายการ) เข้ากลุ่ม/ผู้ใช้นั้น
//   npm run fuel-digest-card -- --to=Cxxxx --empty        การ์ดของรอบที่ไม่มีคำขอใหม่
//   npm run fuel-digest-card -- --to=Cxxxx --channel=hr   บังคับ OA ที่ใช้ส่ง (ปกติ: OA ที่ทะเบียนกลุ่มบันทึกไว้ ไม่มีในทะเบียน = OA ของทีมซ่อมบำรุง)
//   npm run fuel-digest-card -- --json                    พิมพ์ Flex JSON (วางใน Flex Simulator ได้) ไม่ส่ง
//   npm run fuel-digest-card -- --to=Cxxxx --dry-run      ไม่ส่งจริง
//
// ต้องระบุ --to เสมอ: ไม่มีปลายทางตั้งต้น เพื่อไม่ให้การ์ดทดสอบหลุดเข้ากลุ่มทีมซ่อมบำรุงจริง
// ---------------------------------------------------------------------------

function arg(name: string): string | undefined {
  return process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))?.split('=')[1]
}

const STATUSES = ['pending', 'pending', 'approved', 'fulfilled', 'pending', 'approved', 'rejected', 'fulfilled', 'approved', 'pending', 'approved']
const VEHICLES: [string, string][] = [
  ['50-0040-20-0002', 'รถกระบะ ISUZU D-max'],
  ['TRU-RENT-26-032', '6 ล้อ เช่า'],
  ['ME-26-0018', 'Generator No.70022492'],
  ['30-5800-23-0011', 'เครื่องกำเนิดไฟฟ้า SDEC'],
  ['50-0050-12-0001', 'รถตู้ Toyota Commuter'],
  ['TRU-RENT-26-029', '6 ล้อ เช่า'],
  ['ME-25-0008', 'Generator No.70022192'],
  ['TRU-RENT-26-014', '6 ล้อ เช่า'],
  ['50-0040-26-0002', 'รถกระบะ TOYOTA'],
  ['30-1303-21-0001', 'Generator 50 kVA'],
  ['40-0427-25-0001', 'Mobile Tank 1,000 ลิตร']
]

/** payload ตัวอย่างรูปแบบเดียวกับที่ fuel-service ส่ง (metadata เป็น string ทั้งหมด) */
function samplePayload(empty: boolean): Record<string, unknown> {
  const rows = empty
    ? []
    : VEHICLES.map(([code, name], i) => ({
        requestNo: `FUEL-TEST-${String(i + 1).padStart(4, '0')}`,
        vehicleCode: code,
        vehicleName: name,
        requester: `ผู้ทดสอบ ${i + 1}`,
        project: i % 2 ? 'J-400' : 'M-019',
        fuelType: 'Diesel',
        liters: 30 + i * 12.5,
        status: STATUSES[i],
        location: i % 3 === 0 ? 'Workshop' : 'Site',
        time: `${String(7 + Math.floor(i / 4)).padStart(2, '0')}:${String((i * 13) % 60).padStart(2, '0')}`
      }))
  const counted = rows.filter((r) => r.status !== 'rejected')
  const litersSum = counted.reduce((s, r) => s + r.liters, 0)
  const count = (status: string) => rows.filter((r) => r.status === status).length
  return {
    category: 'fuel_request_digest',
    metadata: {
      test: 'true',
      slot: empty ? '15:00' : '10:00',
      date: '2026-11-25',
      windowStart: empty ? '2026-11-25T10:00:00' : '2026-11-24T18:00:00',
      windowEnd: empty ? '2026-11-25T15:00:00' : '2026-11-25T10:00:00',
      newCount: String(rows.length),
      newLiters: String(litersSum),
      newWorkshop: String(rows.filter((r) => r.location === 'Workshop').length),
      newSite: String(rows.filter((r) => r.location === 'Site').length),
      dayCount: empty ? '11' : String(rows.length),
      dayLiters: empty ? '987.5' : String(litersSum),
      dayPending: empty ? '2' : String(count('pending')),
      dayApproved: empty ? '5' : String(count('approved')),
      dayFulfilled: empty ? '3' : String(count('fulfilled')),
      dayRejected: empty ? '1' : String(count('rejected')),
      rows: JSON.stringify(rows)
    }
  }
}

async function main(): Promise<void> {
  const digest = parseFuelDigest(samplePayload(process.argv.includes('--empty')), config.maintenance.webUrl)
  if (!digest) throw new Error('สร้างข้อมูลตัวอย่างไม่สำเร็จ')
  const contents = buildFuelDigestCard(digest)

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(contents, null, 2))
    return
  }

  const targets = arg('to')?.split(',').map((s) => s.trim()).filter(Boolean) ?? []
  if (targets.length === 0) {
    console.log('[fuel-digest-card] ต้องระบุปลายทาง: --to=Cxxxx (กลุ่ม) หรือ --to=Uxxxx (ผู้ใช้)')
    return
  }
  const forced = arg('channel')
  if (forced && forced !== 'hr' && forced !== 'mt') throw new Error('--channel ต้องเป็น hr หรือ mt')

  for (const id of targets) {
    const isGroup = id.startsWith('C')
    const group = isGroup ? await getGroup(id) : null
    // group id ผูกกับ OA: ส่งด้วย OA ที่ทะเบียนบอกว่าอยู่ในกลุ่มนั้น ไม่งั้น LINE ตอบ "Failed to send messages"
    const channel = (forced as ChannelKey | undefined) ?? group?.channel ?? config.maintenance.channel
    const result = await sendAndLog({
      targetType: isGroup ? 'group' : 'user',
      targetId: id,
      targetName: group?.group_name ?? undefined,
      kind: 'flex',
      altText: fuelDigestToText(digest).slice(0, 400),
      contents,
      sentBy: 'script:fuel-digest-card',
      dryRun: process.argv.includes('--dry-run'),
      channel
    })
    console.log(`  ${id.slice(0, 8)}… (${group?.group_name ?? 'ไม่อยู่ในทะเบียนกลุ่ม'}, OA ${channel}): ${result.status}${result.error ? ` (${result.error})` : ''}`)
  }
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error('[fuel-digest-card] ผิดพลาด:', err instanceof Error ? err.message : err)
    await pool.end()
    process.exit(1)
  })
