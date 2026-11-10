import { pool } from '../src/db'
import { config } from '../src/config'
import { runAbsenceStoreReport } from '../src/jobs/absenceStoreReport'
import { absenceStoreAltText, absenceStoreText, flexAbsenceStore, flexAbsenceStoreDetail } from '../src/services/absenceStoreFlex'
import { sendAndLog } from '../src/services/messaging'
import type { AbsentBacklogReport, AbsentHolder } from '../src/services/storeMcp'

// ---------------------------------------------------------------------------
// CLI ส่งการ์ด "ขาดงานแต่ยังมีของค้างคืน" (ตรรกะจริงอยู่ใน src/jobs/absenceStoreReport.ts ซึ่ง ABSENCE_STORE_CRON ใช้ด้วย)
// ต้องตั้ง STORE_MCP_URL + STORE_MCP_USERNAME / STORE_MCP_PASSWORD (บัญชีที่เปิด Employee Backlogs ได้)
//
//   npm run absence-store-report -- --dry-run          ประกอบการ์ดแต่ไม่ส่ง (พิมพ์รายชื่อ + รายการของ)
//   npm run absence-store-report -- --to=Uxxxx         ส่งให้ผู้ใช้ (ทดสอบ) หรือกลุ่ม C... ไม่ใส่ = ABSENCE_STORE_GROUP_IDS
//   npm run absence-store-report -- --date=2026-11-04  ตรวจถึงวันที่ (ค่าเริ่มต้น = เมื่อวาน)
//   npm run absence-store-report -- --min=3 --top=5
//   npm run absence-store-report -- --json             พิมพ์ Flex JSON
//   npm run absence-store-report -- --sample --to=U…   ส่งการ์ดหลัก + การ์ดรายละเอียดด้วยข้อมูลตัวอย่าง (ชื่อสมมติ ไม่ต้องมีบัญชี / store MCP)
// ---------------------------------------------------------------------------

function arg(name: string): string | undefined {
  return process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))?.split('=')[1]
}

function positiveInt(value: string | undefined): number | undefined {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : undefined
}

/** ข้อมูลสมมติทั้งหมด (ชื่อ "ตัวอย่าง ...", รหัส 69-9-xxx) สำหรับดูหน้าตาการ์ด: สถานที่ละ 12 คนที่มีของค้าง */
function sampleReports(): AbsentBacklogReport[] {
  const first = ['สมชาย', 'วิชัย', 'มานพ', 'ประเสริฐ', 'สุรชัย', 'อนุชา', 'ธีรพงษ์', 'กิตติ', 'สมศักดิ์', 'ณรงค์', 'บุญมี', 'ชัยวัฒน์']
  const last = ['ใจดี', 'มั่นคง', 'ขยันยิ่ง', 'รักงาน', 'ทองดี', 'สุขใจ', 'แก้วงาม', 'ศรีสุข', 'บุญมาก', 'เจริญผล', 'พรหมมา', 'วงศ์ใหญ่']
  const roles: Array<[string, string]> = [['Production', 'Fitter A'], ['Production', 'Welder Pipe'], ['QA/QC', 'QC Inspector'], ['HSE', 'Safety Officer'], ['Production', 'Rigger']]
  const tools: Array<[string, string | undefined, string, string | undefined]> = [
    ['เครื่องเจียร์ไฟฟ้า', '4"', 'เครื่อง', 'GR-0123'], ['สายเชื่อม', '50 sq.mm', 'เส้น', undefined],
    ['หน้ากากเชื่อมปรับแสงอัตโนมัติ', undefined, 'ชิ้น', 'WM-0456'], ['เวอร์เนียร์ดิจิตอล', '150 mm', 'อัน', 'VN-0789'],
    ['ตู้เชื่อมอินเวอร์เตอร์', undefined, 'เครื่อง', 'WD-0101'], ['แคลมป์จับชิ้นงาน', '6"', 'ตัว', undefined], ['รอกโซ่', '1 ตัน', 'ตัว', 'CH-0202']
  ]
  const base = { asOf: '2026-11-04', minDays: 2, project: 'J-401', counted: 'borrowed and issued items still held' }
  const build = (location: 'Workshop' | 'Site', absent: number, active: number, seed: number): AbsentBacklogReport => {
    const people: AbsentHolder[] = Array.from({ length: 12 }, (_, k) => {
      const n = (k * 3) % 4 + 1 + (k % 2)
      const items = Array.from({ length: Math.min(n, 3) }, (_, j) => {
        const [itemName, size, unit, asset] = tools[(k + j + seed) % tools.length]
        const daysOut = 60 - k * 3 - j * 7
        return { itemCode: `ITM-${k}${j}`, itemName, size, unit, assetCode: asset, qty: asset ? 1 : 2, since: `2026-${daysOut > 34 ? '09' : '10'}-${String(10 + j).padStart(2, '0')}`, daysOut, overdue: j === 0 && k % 3 === 0 }
      })
      const [department, position] = roles[(k + seed) % roles.length]
      return {
        empCode: `69-9-${String(seed * 100 + k + 1).padStart(3, '0')}`, name: `ตัวอย่าง ${first[(k + seed) % 12]} ${last[(k * 5 + seed) % 12]}`,
        department, position, location, daysAbsent: Math.max(2, 12 - k), lastScan: '2026-10-24', absentSince: '2026-10-25',
        lines: n, qty: n, overdueLines: items.filter((i) => i.overdue).length, maxDaysOut: items[0].daysOut, items, moreLines: Math.max(0, n - 3)
      }
    })
    const lines = people.reduce((s, p) => s + p.lines, 0)
    return {
      ...base,
      totals: { absent, withBacklog: people.length, lines, qty: lines, overdueLines: people.reduce((s, p) => s + p.overdueLines, 0) },
      byLocation: [{ location, activePeople: active, absent, stale: 1, withBacklog: people.length, lines, qty: lines }],
      people: people.slice(0, config.storeAbsence.top),
      morePeople: Math.max(0, people.length - config.storeAbsence.top)
    }
  }
  return [build('Workshop', 22, 212, 0), build('Site', 100, 1851, 1)]
}

async function sendSample(): Promise<void> {
  const reports = sampleReports()
  const ids = arg('to')?.split(',').map((s) => s.trim()).filter(Boolean) ?? []
  const contents = flexAbsenceStore(reports, config.storeAbsence.top, config.storeAbsence.webUrl)
  // การ์ดรายละเอียดที่บอทตอบเมื่อกด › (ตัวอย่างของคนอันดับ 1 Workshop)
  const p = reports[0].people[0]
  const detail = flexAbsenceStoreDetail(
    { empCode: p.empCode, name: p.name, location: p.location, daysAbsent: p.daysAbsent, lastScan: p.lastScan, items: p.items,
      total: p.lines, counted: reports[0].counted, project: reports[0].project },
    config.storeAbsence.webUrl
  )
  console.log(`\n${absenceStoreText(reports)}\n`)
  console.log(`  การ์ดหลัก ${contents.contents.length} ใบ, ${Buffer.byteLength(JSON.stringify(contents)).toLocaleString('en-US')} bytes · การ์ดรายละเอียด ${Buffer.byteLength(JSON.stringify(detail)).toLocaleString('en-US')} bytes`)
  if (process.argv.includes('--json')) console.log(JSON.stringify([contents, detail], null, 2))
  const messages = [
    { label: 'การ์ดหลัก', altText: `[ตัวอย่าง] ${absenceStoreAltText(reports)}`, contents },
    { label: 'การ์ดรายละเอียด (เมื่อกด ›)', altText: `[ตัวอย่าง] 📦 ของค้างคืนของ ${p.name}`, contents: detail }
  ]
  for (const id of ids) {
    for (const m of messages) {
      const result = await sendAndLog({
        targetType: id.startsWith('U') ? 'user' : 'group', targetId: id, targetName: id, kind: 'flex',
        altText: m.altText, contents: m.contents, sentBy: 'script:absence-store-report:sample',
        dryRun: process.argv.includes('--dry-run'), channel: 'hr'
      })
      console.log(`  -> ${id} (${m.label}): ${result.status}${result.error ? ` (${result.error})` : ''}`)
    }
  }
}

async function main(): Promise<void> {
  if (process.argv.includes('--sample')) return sendSample()
  const date = arg('date')
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('--date ต้องเป็น YYYY-MM-DD')
  const top = positiveInt(arg('top'))
  const outcome = await runAbsenceStoreReport({
    asOf: date,
    minDays: positiveInt(arg('min')),
    top,
    targets: arg('to')?.split(',').map((s) => s.trim()).filter(Boolean),
    dryRun: process.argv.includes('--dry-run'),
    sentBy: 'script:absence-store-report'
  })
  if (outcome.sendStatus === 'not-configured') {
    console.log('[absence-store-report] ยังไม่ได้ตั้ง STORE_MCP_URL / STORE_MCP_USERNAME / STORE_MCP_PASSWORD')
    return
  }
  console.log(`\n${absenceStoreText(outcome.reports)}\n`)
  const flex = flexAbsenceStore(outcome.reports, top ?? config.storeAbsence.top, config.storeAbsence.webUrl)
  console.log(`  การ์ด ${flex.contents.length} ใบ, ${Buffer.byteLength(JSON.stringify(flex)).toLocaleString('en-US')} bytes`)
  if (process.argv.includes('--json')) console.log(JSON.stringify(flex, null, 2))
  if (outcome.sendStatus === 'no-target') {
    console.log('  [i] ไม่มีปลายทาง (ใส่ --to=Uxxxx หรือตั้ง ABSENCE_STORE_GROUP_IDS ใน .env) จึงยังไม่ส่ง\n')
    return
  }
  for (const t of outcome.targets) console.log(`  -> ${t.name}: ${t.status}${t.error ? ` (${t.error})` : ''}`)
  console.log(`  ผลรวม: ${outcome.sendStatus}\n`)
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error('[absence-store-report] ผิดพลาด:', err instanceof Error ? err.message : err)
    await pool.end()
    process.exit(1)
  })
