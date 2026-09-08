import amqp from 'amqplib'
import { randomUUID } from 'node:crypto'
import { config } from '../src/config'

// ---------------------------------------------------------------------------
// จำลอง event จากระบบซ่อมบำรุง (เหมือนที่ repair/fuel/vehicle service publish) เพื่อทดสอบว่า
// consumer ใน src/services/maintenanceEvents.ts แจ้งเข้าไลน์กลุ่มได้
//
//   npm run mt:publish-test                 # ส่งครบทั้ง 3 แบบ
//   npm run mt:publish-test -- repair       # เฉพาะ repair.requested | fuel | vehicle | mcp
// ต้องตั้ง RABBITMQ_URL ใน .env และมีแอป (npm run dev) รันอยู่จึงจะเห็นการ์ดในกลุ่ม
// ระวัง: ส่งเข้ากลุ่มจริงถ้า MOCK_LINE=false
// ---------------------------------------------------------------------------

const now = new Date().toISOString().replace('Z', '')
const samples: Record<string, [string, Record<string, unknown>]> = {
  repair: [
    'repair.requested',
    {
      eventId: randomUUID(), occurredAt: now, repairRequestId: randomUUID(), assetId: randomUUID(),
      assetCode: '30-1303-10-0001', severity: 0 /* Emergency */,
      symptom: '(ทดสอบ) รถบัส Hino เบรกมีเสียงดังและจับไม่อยู่ ขอช่างตรวจก่อนเที่ยง', by: 'tester'
    }
  ],
  fuel: [
    'fuel.requested',
    {
      eventId: randomUUID(), occurredAt: now, fuelRequestId: randomUUID(), requestNo: 'FR-TEST-0001',
      vehicleId: randomUUID(), vehicleCode: '50-0040-10-0001', vehicleName: 'Pickup 4-door',
      requesterName: 'ผู้ทดสอบ', requesterEmail: 'tester@qtec.co.th', projectCode: 'M-019', fuelType: 'Diesel',
      requestedLiters: 45.5, estimatedCost: 1520.75, odometer: 128430, autoApproved: false,
      requestStatus: 2 /* PendingApproval */, by: 'tester'
    }
  ],
  vehicle: [
    'vehicle.booking.requested',
    {
      eventId: randomUUID(), occurredAt: now, bookingId: randomUUID(), bookingNo: 'BK-TEST-0001',
      vehicleId: randomUUID(), vehicleCode: 'VH-07', vehicleName: 'Toyota Hilux Revo', vehiclePlate: 'ฮข 1234 กทม.',
      requesterName: 'สมชาย ใจดี', requesterEmail: 'tester@qtec.co.th', department: 'Engineering', projectCode: 'PRJ-2026-014',
      purpose: 'ส่งอุปกรณ์และตรวจงานหน้างาน', destination: 'ไซต์งานบางนา', passengers: 3,
      startAt: '2026-09-08T08:30:00', endAt: '2026-09-08T17:00:00', by: 'tester'
    }
  ],
  mcp: [
    'maintenance.line.notification',
    {
      id: randomUUID().replace(/-/g, ''), type: 'alert', severity: 'warning', service: 'repair', category: 'overdue_repair',
      period: 'today', title: '(ทดสอบ) งานซ่อมเกินกำหนด 5 รายการ', message: 'มีงานซ่อมที่เกินกำหนดค้างอยู่ ควรติดตามกับช่างที่รับผิดชอบ',
      reference: 'REP-202608-0003', assetCode: '30-1303-10-0001', action: 'ตรวจสอบความคืบหน้า', requestedBy: 'maintenance-mcp-service',
      createdAt: now, metadata: {}
    }
  ]
}

async function main(): Promise<void> {
  if (!config.maintenance.events.enabled) {
    console.error('ยังไม่ได้ตั้ง RABBITMQ_URL ใน .env')
    process.exit(1)
  }
  const wanted = process.argv.slice(2).filter((a) => a in samples)
  const keys = wanted.length > 0 ? wanted : ['repair', 'fuel', 'vehicle']
  const conn = await amqp.connect(config.maintenance.events.url)
  const ch = await conn.createConfirmChannel()
  await ch.assertExchange(config.maintenance.events.exchange, 'topic', { durable: true })
  for (const k of keys) {
    const [routingKey, body] = samples[k]
    ch.publish(config.maintenance.events.exchange, routingKey, Buffer.from(JSON.stringify(body)), {
      contentType: 'application/json', persistent: true, messageId: randomUUID(), type: routingKey
    })
    console.log(`published ${routingKey}`)
  }
  await ch.waitForConfirms()
  await conn.close()
  console.log('เสร็จแล้ว ดูผลใน log ของแอปและหน้า /send (message_logs sent_by = mt-events:*)')
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
