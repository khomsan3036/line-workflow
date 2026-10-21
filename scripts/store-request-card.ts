import { pool } from '../src/db'
import { config } from '../src/config'
import { deliverStoreRequestCard } from '../src/services/storeRequestEvents'
import { buildStoreRequestCard, sampleStoreRequestEvent, STORE_REQUEST_KINDS, type StoreRequestKind } from '../src/services/storeRequestFlex'

// ---------------------------------------------------------------------------
// ทดสอบหน้าตาการ์ดใบขอเบิก/ขอยืม (Store Control) ด้วยข้อมูลตัวอย่าง — ไม่ต้องมี RabbitMQ
// ของจริงมาจาก src/services/storeRequestEvents.ts (event store.request.* ของ integra-store-service)
//
//   npm run store-request-card -- --to=Uxxxx                    ส่งทุกชนิด (submitted/approved/rejected/fulfilled/cancelled)
//   npm run store-request-card -- --to=Uxxxx --kind=approved    ชนิดเดียว (คั่นด้วยจุลภาคได้)
//   npm run store-request-card -- --kind=approved --json        พิมพ์ Flex JSON (วางใน Flex Simulator ได้) ไม่ส่ง
//   npm run store-request-card -- --dry-run                     ไม่ใส่ --to = STORE_REQUEST_LINE_TARGETS
// ---------------------------------------------------------------------------

function arg(name: string): string | undefined {
  return process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))?.split('=')[1]
}

async function main(): Promise<void> {
  const kinds = (arg('kind') ?? 'all').toLowerCase() === 'all'
    ? STORE_REQUEST_KINDS
    : (arg('kind') ?? '').split(',').map((s) => s.trim().toLowerCase()).filter((k): k is StoreRequestKind => (STORE_REQUEST_KINDS as string[]).includes(k))
  if (kinds.length === 0) throw new Error(`--kind ต้องเป็น all หรือ ${STORE_REQUEST_KINDS.join(' | ')}`)

  if (process.argv.includes('--json')) {
    for (const k of kinds) console.log(JSON.stringify(buildStoreRequestCard(k, sampleStoreRequestEvent(k), config.storeRequest.webUrl).contents, null, 2))
    return
  }

  const targets = arg('to')?.split(',').map((s) => s.trim()).filter(Boolean) ?? config.storeRequest.targets
  if (targets.length === 0) {
    console.log('[store-request-card] ไม่มีปลายทาง (ใส่ --to=Uxxxx หรือตั้ง STORE_REQUEST_LINE_TARGETS ใน .env)')
    return
  }
  for (const kind of kinds) {
    const event = sampleStoreRequestEvent(kind)
    const results = await deliverStoreRequestCard({ kind, event, targets, sentBy: 'script:store-request-card', dryRun: process.argv.includes('--dry-run') })
    for (const r of results) console.log(`  ${kind.padEnd(9)} -> ${r.targetId.slice(0, 8)}…: ${r.status}${r.error ? ` (${r.error})` : ''}`)
  }
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error('[store-request-card] ผิดพลาด:', err instanceof Error ? err.message : err)
    await pool.end()
    process.exit(1)
  })
