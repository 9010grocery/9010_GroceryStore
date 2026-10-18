import type { RowDataPacket } from 'mysql2/promise'
import { getPool } from '../config/db.js'
import { round2, toIso } from '../utils/pos.js'
import { WASTE_TO_DB, WASTE_TO_UI, type WasteReasonUi } from './store.service.js'

// Read side of the Waste log. Writing (and the stock deduction) is logWaste in store.service.ts.

export interface WasteFilters {
  /** First and last day, inclusive (YYYY-MM-DD). Default: the last 30 days. */
  from?: string
  to?: string
  product_id?: number
  reason?: WasteReasonUi
  limit: number
  offset: number
}

const RANGE_DEFAULT_DAYS = 30

function rangeSql(filters: Pick<WasteFilters, 'from' | 'to' | 'product_id' | 'reason'>) {
  const where: string[] = []
  const params: unknown[] = []
  if (filters.from) { where.push('w.waste_date >= ?'); params.push(filters.from) } else { where.push(`w.waste_date >= DATE_SUB(CURDATE(), INTERVAL ${RANGE_DEFAULT_DAYS - 1} DAY)`) }
  if (filters.to) { where.push('w.waste_date < DATE_ADD(?, INTERVAL 1 DAY)'); params.push(filters.to) }
  if (filters.product_id) { where.push('w.product_id = ?'); params.push(filters.product_id) }
  if (filters.reason) { where.push('w.reason = ?'); params.push(WASTE_TO_DB[filters.reason]) }
  return { where: where.join(' AND '), params }
}

/** Write-offs, newest first, with the product and who logged each one. Values are quantity × the product's cost. */
export async function listWaste(filters: WasteFilters) {
  const { where, params } = rangeSql(filters)
  const [rows] = await getPool().query<RowDataPacket[]>(
    `SELECT w.waste_id, w.product_id, w.quantity, w.reason, w.notes, w.waste_date, w.user_id, p.product_name, p.unit_of_measure, p.cost_price,
            CONCAT(u.first_name, ' ', u.last_name) AS user_name
       FROM waste_records w JOIN products p ON p.product_id = w.product_id JOIN users u ON u.user_id = w.user_id
      WHERE ${where} ORDER BY w.waste_date DESC, w.waste_id DESC LIMIT ? OFFSET ?`,
    [...params, filters.limit, filters.offset],
  )
  const [totals] = await getPool().query<RowDataPacket[]>(
    `SELECT COUNT(*) AS entries, COALESCE(SUM(w.quantity), 0) AS qty, COALESCE(SUM(w.quantity * COALESCE(p.cost_price, 0)), 0) AS value
       FROM waste_records w JOIN products p ON p.product_id = w.product_id WHERE ${where}`,
    params,
  )
  return {
    entries: rows.map((row) => ({
      id: `w${row.waste_id}`,
      productId: `p${row.product_id}`,
      name: row.product_name as string,
      unit: (row.unit_of_measure as string | null) ?? 'pc',
      qty: Number(row.quantity),
      reason: WASTE_TO_UI[row.reason as keyof typeof WASTE_TO_UI] ?? 'Other',
      value: round2(Number(row.quantity) * Number(row.cost_price ?? 0)),
      date: toIso(row.waste_date) ?? '',
      by: `u${row.user_id}`,
      byName: row.user_name as string,
      notes: (row.notes as string | null) ?? '',
    })),
    total: { entries: Number(totals[0].entries), qty: Number(totals[0].qty), value: round2(Number(totals[0].value)) },
    hasMore: filters.offset + rows.length < Number(totals[0].entries),
  }
}

/** Loss by reason, the worst products, and the shrink rate (write-offs at cost ÷ sales) for the same range and filters. */
export async function wasteSummary(filters: Pick<WasteFilters, 'from' | 'to' | 'product_id' | 'reason'>) {
  const { where, params } = rangeSql(filters)
  const [byReason] = await getPool().query<RowDataPacket[]>(
    `SELECT w.reason, COUNT(*) AS entries, SUM(w.quantity) AS qty, SUM(w.quantity * COALESCE(p.cost_price, 0)) AS value
       FROM waste_records w JOIN products p ON p.product_id = w.product_id WHERE ${where} GROUP BY w.reason ORDER BY value DESC`,
    params,
  )
  const [byProduct] = await getPool().query<RowDataPacket[]>(
    `SELECT w.product_id, p.product_name, SUM(w.quantity) AS qty, SUM(w.quantity * COALESCE(p.cost_price, 0)) AS value
       FROM waste_records w JOIN products p ON p.product_id = w.product_id WHERE ${where} GROUP BY w.product_id, p.product_name ORDER BY value DESC LIMIT 5`,
    params,
  )
  // Sales over the same days, for the shrink rate.
  const salesWhere: string[] = ["t.status <> 'voided'"]
  const salesParams: unknown[] = []
  if (filters.from) { salesWhere.push('t.transaction_date >= ?'); salesParams.push(filters.from) } else { salesWhere.push(`t.transaction_date >= DATE_SUB(CURDATE(), INTERVAL ${RANGE_DEFAULT_DAYS - 1} DAY)`) }
  if (filters.to) { salesWhere.push('t.transaction_date < DATE_ADD(?, INTERVAL 1 DAY)'); salesParams.push(filters.to) }
  const [sales] = await getPool().query<RowDataPacket[]>(`SELECT COALESCE(SUM(t.total_amount), 0) AS total FROM transactions t WHERE ${salesWhere.join(' AND ')}`, salesParams)
  const totalValue = round2(byReason.reduce((sum, row) => sum + Number(row.value), 0))
  const salesTotal = Number(sales[0].total)
  return {
    totalValue,
    totalQty: byReason.reduce((sum, row) => sum + Number(row.qty), 0),
    entries: byReason.reduce((sum, row) => sum + Number(row.entries), 0),
    sales: round2(salesTotal),
    shrinkRatePercent: salesTotal > 0 ? round2((totalValue / salesTotal) * 100) : 0,
    byReason: byReason.map((row) => ({ reason: WASTE_TO_UI[row.reason as keyof typeof WASTE_TO_UI] ?? 'Other', entries: Number(row.entries), qty: Number(row.qty), value: round2(Number(row.value)) })),
    topProducts: byProduct.map((row) => ({ productId: `p${row.product_id}`, name: row.product_name as string, qty: Number(row.qty), value: round2(Number(row.value)) })),
  }
}
