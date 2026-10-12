import type { RowDataPacket } from 'mysql2/promise'
import { getPool } from '../config/db.js'
import { expiring, lowStock } from './inventory.service.js'

// Dashboard numbers computed in SQL (spec Module 3), so the browser no longer has to crunch the whole snapshot.
// "Sales" are net: a voided receipt counts as nothing and refunds are taken off the receipt they came from,
// the same as the Transactions screen.

/** Net amount of one receipt: its total minus refunds, and nothing for a voided one. */
const NET_SALES = `CASE WHEN t.status = 'voided' THEN 0 ELSE t.total_amount - COALESCE(r.refunded, 0) END`
const WITH_REFUNDS = `LEFT JOIN (SELECT transaction_id, SUM(refund_amount) AS refunded FROM refunds GROUP BY transaction_id) r ON r.transaction_id = t.transaction_id`

const change = (now: number, before: number) => (before ? (now - before) / before : 0)

export const DEFAULT_EXPIRY_DAYS = 7

export async function summary(expiryDays = DEFAULT_EXPIRY_DAYS) {
  const db = getPool()
  const [[today], [yesterday], [top], [stock], [week]] = await Promise.all([
    db.query<RowDataPacket[]>(
      `SELECT COALESCE(SUM(${NET_SALES}), 0) AS sales, SUM(t.status <> 'voided') AS receipts
         FROM transactions t ${WITH_REFUNDS} WHERE DATE(t.transaction_date) = CURDATE()`,
    ),
    // Yesterday up to the same time of day, so "vs. yesterday" compares like with like.
    db.query<RowDataPacket[]>(
      `SELECT COALESCE(SUM(${NET_SALES}), 0) AS sales, SUM(t.status <> 'voided') AS receipts
         FROM transactions t ${WITH_REFUNDS}
        WHERE DATE(t.transaction_date) = DATE_SUB(CURDATE(), INTERVAL 1 DAY) AND TIME(t.transaction_date) <= CURTIME()`,
    ),
    db.query<RowDataPacket[]>(
      `SELECT ti.product_id, ti.product_name, SUM(ti.quantity) AS units, SUM(ti.subtotal) AS revenue
         FROM transaction_items ti JOIN transactions t ON t.transaction_id = ti.transaction_id
        WHERE DATE(t.transaction_date) = CURDATE() AND t.status <> 'voided'
        GROUP BY ti.product_id, ti.product_name ORDER BY revenue DESC, units DESC LIMIT 5`,
    ),
    db.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS active, SUM(stock <= 0) AS out_of_stock, SUM(stock > 0 AND stock <= reorder_level) AS low
         FROM (SELECT p.product_id, p.reorder_level, COALESCE(SUM(i.quantity_on_hand), 0) AS stock
                 FROM products p LEFT JOIN inventory i ON i.product_id = p.product_id
                WHERE p.is_active = TRUE AND p.deleted_at IS NULL GROUP BY p.product_id) s`,
    ),
    db.query<RowDataPacket[]>(
      `SELECT DATEDIFF(CURDATE(), DATE(t.transaction_date)) AS days_ago, COALESCE(SUM(${NET_SALES}), 0) AS sales
         FROM transactions t ${WITH_REFUNDS}
        WHERE t.transaction_date >= DATE_SUB(CURDATE(), INTERVAL 6 DAY) GROUP BY days_ago`,
    ),
  ])
  const expiringBatches = await expiring(expiryDays)
  const sales = Number(today[0].sales)
  const receipts = Number(today[0].receipts ?? 0)
  const prevSales = Number(yesterday[0].sales)
  const prevReceipts = Number(yesterday[0].receipts ?? 0)
  const daily = new Array<number>(7).fill(0)
  for (const row of week) daily[6 - Number(row.days_ago)] = Number(row.sales)
  const expiringProducts = new Set(expiringBatches.map((batch) => batch.productId))
  return {
    today: { sales, receipts, averageBasket: receipts ? sales / receipts : 0 },
    yesterdaySameTime: { sales: prevSales, receipts: prevReceipts },
    salesChange: change(sales, prevSales),
    receiptsChange: change(receipts, prevReceipts),
    last7Days: daily,
    topSellers: top.map((row) => ({ productId: `p${row.product_id}`, name: row.product_name as string, units: Number(row.units), revenue: Number(row.revenue) })),
    inventory: {
      activeProducts: Number(stock[0].active ?? 0),
      outOfStock: Number(stock[0].out_of_stock ?? 0),
      lowStock: Number(stock[0].low ?? 0),
      /** Low + out of stock: the "reorder needed" tile. */
      needReorder: Number(stock[0].out_of_stock ?? 0) + Number(stock[0].low ?? 0),
      nearExpiryProducts: expiringProducts.size,
      nearExpiryUnits: expiringBatches.reduce((sum, batch) => sum + batch.qty, 0),
      expiryDays,
    },
    generatedAt: new Date().toISOString(),
  }
}

/** The lists behind the "needs attention" panel and the banner: low / out-of-stock products and batches near expiry. */
export async function alerts(expiryDays = DEFAULT_EXPIRY_DAYS) {
  const [low, soon] = await Promise.all([lowStock(), expiring(expiryDays)])
  return {
    lowStock: low,
    expiring: soon,
    counts: {
      outOfStock: low.filter((item) => item.outOfStock).length,
      lowStock: low.filter((item) => !item.outOfStock).length,
      expiringBatches: soon.length,
      expired: soon.filter((batch) => batch.expired).length,
    },
    expiryDays,
  }
}

/** Daily net sales for the last `days` days, and today's sales by hour next to the average of the 6 days before. */
export async function salesTrend(days: number) {
  const db = getPool()
  const [daily] = await db.query<RowDataPacket[]>(
    `SELECT DATE(t.transaction_date) AS day, COALESCE(SUM(${NET_SALES}), 0) AS sales, SUM(t.status <> 'voided') AS receipts
       FROM transactions t ${WITH_REFUNDS}
      WHERE t.transaction_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY) GROUP BY day ORDER BY day`,
    [days - 1],
  )
  const [hourly] = await db.query<RowDataPacket[]>(
    `SELECT DATEDIFF(CURDATE(), DATE(t.transaction_date)) AS days_ago, HOUR(t.transaction_date) AS hour, COALESCE(SUM(${NET_SALES}), 0) AS sales
       FROM transactions t ${WITH_REFUNDS}
      WHERE t.transaction_date >= DATE_SUB(CURDATE(), INTERVAL 6 DAY) GROUP BY days_ago, hour`,
  )
  const todayByHour = new Array<number>(24).fill(0)
  const pastTotals = new Array<number>(24).fill(0)
  for (const row of hourly) {
    if (Number(row.days_ago) === 0) todayByHour[Number(row.hour)] += Number(row.sales)
    else pastTotals[Number(row.hour)] += Number(row.sales)
  }
  return {
    days,
    daily: daily.map((row) => ({ date: String(row.day).slice(0, 10), sales: Number(row.sales), receipts: Number(row.receipts ?? 0) })),
    hourly: { today: todayByHour, average6Days: pastTotals.map((total) => total / 6) },
  }
}
