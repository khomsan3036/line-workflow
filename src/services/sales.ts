import { config } from '../config'
import { query, queryOne } from '../db'

// ---------------------------------------------------------------------------
// ข้อมูลยอดขายจำลอง สำหรับ Workshop 5 (Capstone) - รายงานผู้บริหาร
// ---------------------------------------------------------------------------

export interface DailySales {
  date: string
  totalAmount: number
  orderCount: number
  avgOrder: number
  prevAmount: number | null
  changePct: number | null
  branches: { branch: string; amount: number; orders: number }[]
  channels: { channel: string; amount: number; orders: number }[]
  topProducts: { product: string; qty: number; amount: number }[]
}

export interface Anomaly {
  title: string
  detail: string
  orderNo: string
}

/** วันที่ล่าสุดที่มีข้อมูลขาย (เผื่อ seed ยังไม่ถึงวันนี้) */
export async function latestSalesDate(): Promise<string | null> {
  const row = await queryOne<{ d: string }>(
    `SELECT to_char(MAX(order_date), 'YYYY-MM-DD') AS d FROM sales_orders`
  )
  return row?.d ?? null
}

export async function getDailySales(date: string): Promise<DailySales> {
  const totals = await queryOne<{ amount: string; orders: string }>(
    `SELECT COALESCE(SUM(amount), 0) AS amount, COUNT(*) AS orders
       FROM sales_orders
      WHERE order_date = $1::date AND status <> 'cancelled'`,
    [date]
  )
  const prev = await queryOne<{ amount: string }>(
    `SELECT COALESCE(SUM(amount), 0) AS amount
       FROM sales_orders
      WHERE order_date = $1::date - 1 AND status <> 'cancelled'`,
    [date]
  )

  const branches = await query<{ branch: string; amount: string; orders: string }>(
    `SELECT branch, SUM(amount) AS amount, COUNT(*) AS orders
       FROM sales_orders
      WHERE order_date = $1::date AND status <> 'cancelled'
      GROUP BY branch ORDER BY SUM(amount) DESC`,
    [date]
  )
  const channels = await query<{ channel: string; amount: string; orders: string }>(
    `SELECT channel, SUM(amount) AS amount, COUNT(*) AS orders
       FROM sales_orders
      WHERE order_date = $1::date AND status <> 'cancelled'
      GROUP BY channel ORDER BY SUM(amount) DESC`,
    [date]
  )
  const products = await query<{ product: string; qty: string; amount: string }>(
    `SELECT product, SUM(qty) AS qty, SUM(amount) AS amount
       FROM sales_orders
      WHERE order_date = $1::date AND status <> 'cancelled'
      GROUP BY product ORDER BY SUM(amount) DESC LIMIT 5`,
    [date]
  )

  const totalAmount = Number(totals?.amount ?? 0)
  const orderCount = Number(totals?.orders ?? 0)
  const prevAmount = prev ? Number(prev.amount) : null

  return {
    date,
    totalAmount,
    orderCount,
    avgOrder: orderCount > 0 ? totalAmount / orderCount : 0,
    prevAmount,
    changePct: prevAmount && prevAmount !== 0 ? ((totalAmount - prevAmount) / prevAmount) * 100 : null,
    branches: branches.map((b) => ({ branch: b.branch, amount: Number(b.amount), orders: Number(b.orders) })),
    channels: channels.map((c) => ({ channel: c.channel, amount: Number(c.amount), orders: Number(c.orders) })),
    topProducts: products.map((p) => ({ product: p.product, qty: Number(p.qty), amount: Number(p.amount) }))
  }
}

/**
 * ตรวจหารายการผิดปกติของวันที่ระบุ 4 แบบ
 *   1) ยอดต่อบิลสูงเกินเกณฑ์
 *   2) ราคาต่อหน่วยผิดปกติ (ต่างจากค่ากลางของสินค้าเดียวกันเกิน 3 เท่า)
 *   3) ยอดติดลบ
 *   4) รายการซ้ำ (สาขา/สินค้า/จำนวน/ยอด เหมือนกันในวันเดียวกัน)
 */
export async function detectAnomalies(date: string): Promise<Anomaly[]> {
  const money = (n: number) => `${Math.round(n).toLocaleString('th-TH')} บาท`
  const anomalies: Anomaly[] = []

  const big = await query<{ order_no: string; branch: string; amount: string }>(
    `SELECT order_no, branch, amount FROM sales_orders
      WHERE order_date = $1::date AND amount > $2 AND status <> 'cancelled'
      ORDER BY amount DESC`,
    [date, config.anomalyAmountThreshold]
  )
  for (const r of big) {
    anomalies.push({
      orderNo: r.order_no,
      title: `ยอดสูงผิดปกติ (${r.order_no})`,
      detail: `${r.branch} ${money(Number(r.amount))} สูงกว่าเกณฑ์ ${money(config.anomalyAmountThreshold)}`
    })
  }

  const priceOff = await query<{ order_no: string; product: string; unit_price: string; median_price: string }>(
    `WITH med AS (
        SELECT product, percentile_cont(0.5) WITHIN GROUP (ORDER BY unit_price) AS median_price
          FROM sales_orders WHERE unit_price > 0 GROUP BY product
     )
     SELECT s.order_no, s.product, s.unit_price, m.median_price
       FROM sales_orders s JOIN med m ON m.product = s.product
      WHERE s.order_date = $1::date
        AND s.unit_price > m.median_price * 3`,
    [date]
  )
  for (const r of priceOff) {
    anomalies.push({
      orderNo: r.order_no,
      title: `ราคาต่อหน่วยผิดปกติ (${r.order_no})`,
      detail: `${r.product} คีย์ราคา ${money(Number(r.unit_price))} ปกติราว ${money(Number(r.median_price))}`
    })
  }

  const negative = await query<{ order_no: string; amount: string; product: string }>(
    `SELECT order_no, amount, product FROM sales_orders WHERE order_date = $1::date AND amount < 0`,
    [date]
  )
  for (const r of negative) {
    anomalies.push({
      orderNo: r.order_no,
      title: `ยอดติดลบ (${r.order_no})`,
      detail: `${r.product} ${money(Number(r.amount))} ควรออกเป็นใบลดหนี้ ไม่ใช่ยอดขายติดลบ`
    })
  }

  const dup = await query<{ order_nos: string; product: string; amount: string }>(
    `SELECT string_agg(order_no, ', ' ORDER BY order_no) AS order_nos, product, amount::text AS amount
       FROM sales_orders
      WHERE order_date = $1::date
      GROUP BY branch, channel, sales_person, customer_name, product, qty, amount
     HAVING COUNT(*) > 1`,
    [date]
  )
  for (const r of dup) {
    anomalies.push({
      orderNo: r.order_nos,
      title: 'รายการซ้ำ',
      detail: `${r.product} ${money(Number(r.amount))} ปรากฏซ้ำ (${r.order_nos})`
    })
  }

  return anomalies
}

/** ยอดขายรายวัน N วันย้อนหลังจากวันที่กำหนด สำหรับกราฟ */
export async function salesTrend(endDate: string, days = 14): Promise<{ day: string; amount: number }[]> {
  const rows = await query<{ day: string; amount: string }>(
    `WITH d AS (
        SELECT generate_series($1::date - ($2::int - 1), $1::date, '1 day')::date AS day
     )
     SELECT to_char(d.day, 'YYYY-MM-DD') AS day, COALESCE(SUM(s.amount), 0) AS amount
       FROM d LEFT JOIN sales_orders s ON s.order_date = d.day AND s.status <> 'cancelled'
      GROUP BY d.day ORDER BY d.day`,
    [endDate, days]
  )
  return rows.map((r) => ({ day: r.day, amount: Number(r.amount) }))
}
