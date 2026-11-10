import { pool } from '../src/db'
import { config } from '../src/config'
import { deliverGoodCodeCard, fetchRequestById, fetchRequestsByCode, toView } from '../src/services/goodCodeEvents'
import { buildGoodCodeCard, sampleGoodCodeRequest, GOOD_CODE_CARD_KINDS, type GoodCodeCardKind, type GoodCodeRequestView } from '../src/services/goodCodeFlex'

// ---------------------------------------------------------------------------
// ทดสอบการ์ดคำขอเพิ่มรหัสสินค้าใหม่ (Good Code Master) โดยไม่ต้องรอ event จาก RabbitMQ
// ของจริงมาจาก src/services/goodCodeEvents.ts (good-code.* ของ integra-costcode-service)
//
//   npm run good-code-card -- --to=Uxxxx                                   ข้อมูลตัวอย่าง ทุกชนิด (submitted/approved/rejected)
//   npm run good-code-card -- --to=Uxxxx --kind=submitted                  ชนิดเดียว (คั่นด้วยจุลภาคได้)
//   npm run good-code-card -- --to=Uxxxx --good-code=0080001-0484          คำขอจริงของรหัสนี้ (ถาม GOOD_CODE_API_URL) ชนิดตามสถานะคำขอ
//   npm run good-code-card -- --to=Uxxxx --request-id=<guid>               คำขอจริงตาม id
//   npm run good-code-card -- --kind=submitted --json                      พิมพ์ Flex JSON (วางใน Flex Simulator ได้) ไม่ส่ง
//   npm run good-code-card -- --dry-run                                    ไม่ใส่ --to = GOOD_CODE_LINE_TARGETS
// ---------------------------------------------------------------------------

function arg(name: string): string | undefined {
  return process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=')
}

function parseKinds(v: string | undefined): GoodCodeCardKind[] {
  if (!v || v.toLowerCase() === 'all') return GOOD_CODE_CARD_KINDS
  const kinds = v.split(',').map((s) => s.trim().toLowerCase()).filter((k): k is GoodCodeCardKind => (GOOD_CODE_CARD_KINDS as string[]).includes(k))
  if (kinds.length === 0) throw new Error(`--kind ต้องเป็น all หรือ ${GOOD_CODE_CARD_KINDS.join(' | ')}`)
  return kinds
}

/** ชนิดการ์ดจากสถานะคำขอจริง (ไม่ได้ระบุ --kind) */
function kindOfStatus(status: string | undefined): GoodCodeCardKind {
  const s = (status ?? '').toLowerCase()
  return s === 'approved' ? 'approved' : s === 'rejected' ? 'rejected' : 'submitted'
}

async function main(): Promise<void> {
  const goodCode = arg('good-code')?.trim()
  const requestId = arg('request-id')?.trim()
  const dryRun = process.argv.includes('--dry-run')
  const json = process.argv.includes('--json')

  // คำขอจริงจาก integra-costcode-service หรือข้อมูลตัวอย่าง
  let cards: Array<{ kind: GoodCodeCardKind; view: GoodCodeRequestView }> = []
  if (goodCode || requestId) {
    if (!config.goodCode.apiUrl) throw new Error('ต้องตั้ง GOOD_CODE_API_URL ใน .env ก่อน (เช่น http://localhost:5312)')
    const dto = requestId
      ? await fetchRequestById(requestId)
      : (await fetchRequestsByCode(goodCode!)).sort((a, b) => String(b.requestedAt ?? '').localeCompare(String(a.requestedAt ?? '')))[0] ?? null
    if (!dto) throw new Error(`ไม่พบคำขอ ${requestId ?? goodCode} ใน ${config.goodCode.apiUrl}`)
    const view = await toView(dto, null)
    const kinds = arg('kind') ? parseKinds(arg('kind')) : [kindOfStatus(dto.status)]
    console.log(`[good-code-card] คำขอ ${dto.id} ${dto.type} ${dto.goodCode} "${view.goodName ?? '-'}" สถานะ ${dto.status} ผู้ขอ ${view.requesterName ?? '-'} (${view.requestedBy ?? '-'})`)
    cards = kinds.map((kind) => ({ kind, view }))
  } else {
    cards = parseKinds(arg('kind')).map((kind) => ({ kind, view: sampleGoodCodeRequest(kind) }))
  }

  if (json) {
    for (const c of cards) console.log(JSON.stringify(buildGoodCodeCard(c.kind, c.view, config.goodCode.webUrl).contents, null, 2))
    return
  }

  const targets = arg('to')?.split(',').map((s) => s.trim()).filter(Boolean) ?? config.goodCode.targets
  if (targets.length === 0) {
    console.log('[good-code-card] ไม่มีปลายทาง (ใส่ --to=Uxxxx หรือตั้ง GOOD_CODE_LINE_TARGETS ใน .env)')
    return
  }
  for (const c of cards) {
    const results = await deliverGoodCodeCard({ kind: c.kind, view: c.view, targets, sentBy: 'script:good-code-card', dryRun })
    for (const r of results) console.log(`  ${c.kind.padEnd(9)} -> ${r.targetId.slice(0, 8)}…: ${r.status}${r.error ? ` (${r.error})` : ''}`)
  }
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error('[good-code-card] ผิดพลาด:', err instanceof Error ? err.message : err)
    await pool.end()
    process.exit(1)
  })
