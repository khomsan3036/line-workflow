import fs from 'node:fs'
import path from 'node:path'
import { config, reportScheduleNote } from '../config'
import { flexExecutiveReport } from '../services/flex'
import { sendAndLog } from '../services/messaging'
import {
  detectAnomalies,
  getDailySales,
  latestSalesDate,
  salesTrend,
  type Anomaly,
  type DailySales
} from '../services/sales'

// ---------------------------------------------------------------------------
// งาน: รายงานยอดขายประจำวันส่งเข้ากลุ่มผู้บริหาร (Capstone ของหลักสูตร)
// เรียกได้จาก CLI, ตัวตั้งเวลาในตัว และหน้า /sales ของ dashboard
// ---------------------------------------------------------------------------

export interface DailyReportOptions {
  date?: string
  groupId?: string
  dryRun?: boolean
  writeHtml?: boolean
  alertOnly?: boolean
  sentBy?: string
}

export interface DailyReportOutcome {
  date: string
  sales: DailySales
  anomalies: Anomaly[]
  sendStatus: 'sent' | 'mock' | 'failed' | 'skipped' | 'no-target' | 'no-data'
  error?: string
  htmlPath?: string
  latestAvailableDate?: string | null
}

export function yesterdayISO(): string {
  const now = new Date()
  now.setDate(now.getDate() - 1)
  return now.toLocaleDateString('en-CA', { timeZone: config.timezone })
}

const money = (n: number) => `${Math.round(n).toLocaleString('th-TH')} บาท`

export async function runDailyReport(options: DailyReportOptions = {}): Promise<DailyReportOutcome> {
  const date = options.date ?? yesterdayISO()
  const groupId = options.groupId ?? config.defaultGroupId
  const dryRun = options.dryRun ?? false

  const sales = await getDailySales(date)

  if (sales.orderCount === 0) {
    return {
      date,
      sales,
      anomalies: [],
      sendStatus: 'no-data',
      latestAvailableDate: await latestSalesDate()
    }
  }

  const anomalies = await detectAnomalies(date)

  let htmlPath: string | undefined
  if (options.writeHtml) {
    const trend = await salesTrend(date, 14)
    // ใช้ cwd เพราะ __dirname ต่างกันระหว่างรันด้วย tsx (src/) กับรันหลัง build (dist/src/)
    const dir = path.join(process.cwd(), 'reports')
    fs.mkdirSync(dir, { recursive: true })
    htmlPath = path.join(dir, `daily-report-${date}.html`)
    fs.writeFileSync(htmlPath, buildHtml(date, sales, anomalies, trend), 'utf8')
  }

  // โหมด alert-only: ไม่มีอะไรผิดปกติก็ไม่ต้องรบกวนกลุ่มผู้บริหาร
  if (options.alertOnly && anomalies.length === 0) {
    return { date, sales, anomalies, sendStatus: 'skipped', htmlPath }
  }

  if (!groupId) {
    return { date, sales, anomalies, sendStatus: 'no-target', htmlPath }
  }

  const result = await sendAndLog({
    targetType: 'group',
    targetId: groupId,
    kind: 'flex',
    altText: `รายงานยอดขายวันที่ ${date} - ${money(sales.totalAmount)}`,
    contents: flexExecutiveReport({
      dateLabel: new Date(`${date}T00:00:00`).toLocaleDateString('th-TH', {
        day: 'numeric',
        month: 'short',
        year: 'numeric'
      }),
      totalAmount: sales.totalAmount,
      orderCount: sales.orderCount,
      avgOrder: sales.avgOrder,
      changePct: sales.changePct,
      branches: sales.branches,
      channels: sales.channels,
      anomalies,
      footerNote: reportScheduleNote() ? `รายงานอัตโนมัติ · ${reportScheduleNote()}` : undefined
    }),
    sentBy: options.sentBy ?? 'job:daily-report',
    dryRun
  })

  return {
    date,
    sales,
    anomalies,
    sendStatus: result.status,
    error: result.error,
    htmlPath
  }
}

/** พิมพ์สรุปลง console ให้อ่านง่าย (ใช้ทั้ง CLI และ log ของ scheduler) */
export function printReport(outcome: DailyReportOutcome): void {
  const { sales, anomalies } = outcome
  console.log('  ---------------------------------------------')
  console.log(`  ยอดขายรวม      : ${money(sales.totalAmount)}`)
  console.log(`  จำนวนบิล        : ${sales.orderCount.toLocaleString('th-TH')}`)
  console.log(`  ยอดเฉลี่ย/บิล   : ${money(sales.avgOrder)}`)
  console.log(
    `  เทียบวันก่อน    : ${
      sales.changePct === null ? 'ไม่มีข้อมูล' : `${sales.changePct >= 0 ? '+' : ''}${sales.changePct.toFixed(1)}%`
    }`
  )
  console.log('  สาขา:')
  for (const b of sales.branches) console.log(`    - ${b.branch}: ${money(b.amount)} (${b.orders} บิล)`)
  console.log('  ช่องทาง:')
  for (const c of sales.channels) console.log(`    - ${c.channel}: ${money(c.amount)}`)
  if (anomalies.length > 0) {
    console.log(`  [!] พบรายการผิดปกติ ${anomalies.length} รายการ`)
    for (const a of anomalies) console.log(`    - ${a.title}: ${a.detail}`)
  } else {
    console.log('  ไม่พบรายการผิดปกติ')
  }
  console.log('  ---------------------------------------------')
}

function buildHtml(
  date: string,
  sales: DailySales,
  anomalies: Anomaly[],
  trend: { day: string; amount: number }[]
): string {
  const rows = (items: { label: string; amount: number }[]) =>
    items.map((i) => `<tr><td>${i.label}</td><td class="num">${money(i.amount)}</td></tr>`).join('')

  return `<!DOCTYPE html>
<html lang="th"><head><meta charset="utf-8">
<title>รายงานยอดขาย ${date}</title>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Thai:wght@400;600;700&display=swap" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<style>
 body{font-family:'IBM Plex Sans Thai',sans-serif;background:#f8fafc;margin:0;padding:32px;color:#0f172a}
 .wrap{max-width:900px;margin:0 auto}
 h1{font-size:22px;margin:0 0 4px}
 .sub{color:#64748b;font-size:13px;margin-bottom:24px}
 .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin-bottom:24px}
 .card{background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:16px}
 .card .k{font-size:12px;color:#64748b}
 .card .v{font-size:22px;font-weight:700;margin-top:4px}
 table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e2e8f0;border-radius:14px;overflow:hidden;margin-bottom:24px}
 th,td{padding:10px 14px;text-align:left;border-bottom:1px solid #f1f5f9;font-size:14px}
 th{background:#0C1628;color:#fff;font-size:12px}
 .num{text-align:right;font-weight:600}
 .alert{background:#fef2f2;border:1px solid #fecaca;color:#991b1b;border-radius:14px;padding:16px;margin-bottom:24px}
 .ok{background:#ecfdf5;border:1px solid #a7f3d0;color:#065f46;border-radius:14px;padding:16px;margin-bottom:24px}
</style></head><body><div class="wrap">
<h1>รายงานยอดขายประจำวัน</h1>
<div class="sub">สยามสมาร์ทเทรด · ข้อมูลวันที่ ${date} · ข้อมูลจำลองเพื่อการอบรม</div>
<div class="cards">
 <div class="card"><div class="k">ยอดขายรวม</div><div class="v">${money(sales.totalAmount)}</div></div>
 <div class="card"><div class="k">จำนวนบิล</div><div class="v">${sales.orderCount.toLocaleString('th-TH')}</div></div>
 <div class="card"><div class="k">ยอดเฉลี่ยต่อบิล</div><div class="v">${money(sales.avgOrder)}</div></div>
 <div class="card"><div class="k">เทียบวันก่อน</div><div class="v">${
   sales.changePct === null ? '-' : `${sales.changePct >= 0 ? '+' : ''}${sales.changePct.toFixed(1)}%`
 }</div></div>
</div>
<div class="card" style="margin-bottom:24px"><canvas id="c" height="90"></canvas></div>
${
  anomalies.length > 0
    ? `<div class="alert"><strong>พบรายการผิดปกติ ${anomalies.length} รายการ</strong><ul>${anomalies
        .map((a) => `<li>${a.title} - ${a.detail}</li>`)
        .join('')}</ul></div>`
    : '<div class="ok">ไม่พบรายการผิดปกติ</div>'
}
<table><thead><tr><th>สาขา</th><th style="text-align:right">ยอดขาย</th></tr></thead><tbody>
${rows(sales.branches.map((b) => ({ label: b.branch, amount: b.amount })))}
</tbody></table>
<table><thead><tr><th>ช่องทาง</th><th style="text-align:right">ยอดขาย</th></tr></thead><tbody>
${rows(sales.channels.map((c) => ({ label: c.channel, amount: c.amount })))}
</tbody></table>
<table><thead><tr><th>สินค้าขายดี</th><th style="text-align:right">ยอดขาย</th></tr></thead><tbody>
${rows(sales.topProducts.map((p) => ({ label: `${p.product} (${p.qty} ชิ้น)`, amount: p.amount })))}
</tbody></table>
<script>
new Chart(document.getElementById('c'), {
  type:'bar',
  data:{labels:${JSON.stringify(trend.map((t) => t.day.slice(5)))},
        datasets:[{label:'ยอดขาย',data:${JSON.stringify(trend.map((t) => t.amount))},backgroundColor:'#1855A3'}]},
  options:{plugins:{legend:{display:false}},scales:{y:{beginAtZero:true}}}
})
</script>
</div></body></html>`
}
