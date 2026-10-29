import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { getPool, withTransaction } from '../config/db.js'
import { HttpError } from '../utils/httpError.js'
import { logAudit } from './audit.service.js'

// Reports (spec Module 10). Every report is built into the same shape (`ReportDoc`), so the screen, the CSV file and
// the PDF all print the same numbers.
//
// What the numbers mean:
//   gross       = the price tags added up (VAT included), before any discount
//   less VAT    = the VAT taken off Senior/PWD purchases
//   discounts   = Senior/PWD 20%, and cashier discounts on regular sales
//   voids       = receipts cancelled after the sale (shown on their own, not in the other columns)
//   refunds     = money handed back for returned items
//   net sales   = gross - less VAT - discounts - refunds
// A refund belongs to the receipt it came from in the sales reports, and to the shift / day it was paid out in
// the X and Z readings.

type Db = Pool | PoolConnection

export type Kind = 'text' | 'int' | 'money' | 'pct'
export type Cell = string | number | null
export interface Column { label: string; kind: Kind }
export interface ReportTable { title?: string; columns: Column[]; rows: Cell[][]; totals?: Cell[] }
export interface ReportDoc {
  type: string
  title: string
  /** "2026-10-01 to 2026-10-07", or the single date / shift the reading covers. */
  period: string
  business: { name: string; tin: string; address: string }
  generated_at: string
  generated_by: string
  summary: { label: string; value: Cell; kind: Kind }[]
  tables: ReportTable[]
  /** Filters that were applied, for the printout. */
  filters: string[]
  /** X / Z readings only: the stored reading's number and id, and the figures the owner is expected to keep. */
  reading?: { reading_id: number | null; reading_no: number | null; kind: 'X' | 'Z'; stored: boolean; source: string | null; payload: ReadingFigures }
}

export interface Filters { from: string; to: string; product_id?: number; cashier_id?: number; terminal_id?: string }

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
const num = (v: unknown) => Number(v ?? 0)
const money = (v: unknown) => round2(num(v))
/** The owner's own PC; also where a Z-Reading (all terminals together) is filed. */
const SYSTEM_TERMINAL_ID = 'PC-00'
/** Shown on reports until the owner types the store name in Settings. */
const DEFAULT_STORE_NAME = '9010 Grocery Store'
const NO_BUSINESS = { name: '', tin: '', address: '' }

const PAY_LABEL: Record<string, string> = { cash: 'Cash', gcash: 'GCash', maya: 'Maya', card: 'Card' }

const NOT_VOID = "t.status <> 'voided'"
const WITH_REFUNDS = 'LEFT JOIN (SELECT transaction_id, SUM(refund_amount) AS refunded FROM refunds GROUP BY transaction_id) r ON r.transaction_id = t.transaction_id'
const LESS_VAT = '(t.subtotal - t.discount_total - t.total_amount)'

async function business(db: Db): Promise<ReportDoc['business']> {
  const [rows] = await db.query<RowDataPacket[]>("SELECT setting_key, setting_value FROM system_settings WHERE setting_key IN ('business_name', 'business_tin', 'business_address')")
  const get = (k: string) => String(rows.find((r) => r.setting_key === k)?.setting_value ?? '')
  return { ...NO_BUSINESS, name: get('business_name').trim() || DEFAULT_STORE_NAME, tin: get('business_tin'), address: get('business_address') }
}

async function vatRate(db: Db): Promise<number> {
  const [rows] = await db.query<RowDataPacket[]>("SELECT setting_value FROM system_settings WHERE setting_key = 'vat_rate'")
  const v = Number(rows[0]?.setting_value)
  return Number.isFinite(v) && v >= 0 ? v / 100 : 0.12
}

async function header(db: Db, type: string, title: string, period: string, generatedBy: string, filters: string[] = []): Promise<ReportDoc> {
  return { type, title, period, business: await business(db), generated_at: new Date().toISOString(), generated_by: generatedBy, summary: [], tables: [], filters }
}

const periodOf = (f: Filters) => (f.from === f.to ? f.from : `${f.from} to ${f.to}`)

/** Describes the filters in words, for the printout. */
async function filterNotes(db: Db, f: Filters): Promise<string[]> {
  const notes: string[] = []
  if (f.product_id) { const [r] = await db.query<RowDataPacket[]>('SELECT product_name FROM products WHERE product_id = ?', [f.product_id]); notes.push(`Product: ${r[0]?.product_name ?? f.product_id}`) }
  if (f.cashier_id) { const [r] = await db.query<RowDataPacket[]>("SELECT CONCAT(first_name, ' ', last_name) AS n FROM users WHERE user_id = ?", [f.cashier_id]); notes.push(`Employee: ${r[0]?.n ?? f.cashier_id}`) }
  if (f.terminal_id) notes.push(`Terminal: ${f.terminal_id}`)
  return notes
}

/** WHERE parts for receipts (`t`) in the date range and the filters. */
function receiptWhere(f: Filters, dateColumn = 't.transaction_date'): { sql: string; params: (string | number)[] } {
  const parts = [`DATE(${dateColumn}) BETWEEN ? AND ?`]
  const params: (string | number)[] = [f.from, f.to]
  if (f.cashier_id) { parts.push('t.cashier_id = ?'); params.push(f.cashier_id) }
  if (f.terminal_id) { parts.push('t.terminal_id = ?'); params.push(f.terminal_id) }
  if (f.product_id) { parts.push('EXISTS (SELECT 1 FROM transaction_items fi WHERE fi.transaction_id = t.transaction_id AND fi.product_id = ?)'); params.push(f.product_id) }
  return { sql: parts.join(' AND '), params }
}

// ---------------------------------------------------------------------------
// Sales
// ---------------------------------------------------------------------------

export type SalesGroup = 'day' | 'cashier' | 'terminal' | 'payment' | 'product'
const GROUP_LABEL: Record<SalesGroup, string> = { day: 'Date', cashier: 'Cashier', terminal: 'Terminal', payment: 'Payment method', product: 'Product' }

export async function salesReport(f: Filters, group: SalesGroup, generatedBy: string): Promise<ReportDoc> {
  const db = getPool()
  const doc = await header(db, 'sales', `Sales report by ${group === 'payment' ? 'payment method' : group}`, periodOf(f), generatedBy, await filterNotes(db, f))

  if (group === 'product') {
    const where = receiptWhere(f)
    const productFilter = f.product_id ? ' AND ti.product_id = ?' : ''
    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT ti.product_id, ti.product_name, COALESCE(MAX(p.category), '') AS category,
              SUM(ti.quantity - COALESCE(ri.q, 0)) AS units,
              SUM(COALESCE(ti.net_amount, ti.subtotal) - COALESCE(ri.a, 0)) AS revenue,
              SUM((ti.quantity - COALESCE(ri.q, 0)) * COALESCE(p.cost_price, 0)) AS cost
         FROM transaction_items ti
         JOIN transactions t ON t.transaction_id = ti.transaction_id
         LEFT JOIN products p ON p.product_id = ti.product_id
         LEFT JOIN (SELECT transaction_item_id, SUM(quantity) AS q, SUM(amount) AS a FROM refund_items GROUP BY transaction_item_id) ri ON ri.transaction_item_id = ti.transaction_item_id
        WHERE ${NOT_VOID} AND ${where.sql}${productFilter}
        GROUP BY ti.product_id, ti.product_name ORDER BY revenue DESC, units DESC`,
      [...where.params, ...(f.product_id ? [f.product_id] : [])],
    )
    const vat = await vatRate(db)
    const body = rows.map((r) => {
      const revenue = money(r.revenue), cost = money(r.cost), exVat = round2(revenue / (1 + vat))
      return [String(r.product_name), String(r.category), num(r.units), revenue, cost, round2(exVat - cost)] as Cell[]
    })
    const sum = (i: number) => round2(body.reduce((a, row) => a + num(row[i]), 0))
    doc.summary = [
      { label: 'Products sold', value: body.length, kind: 'int' }, { label: 'Units', value: sum(2), kind: 'int' },
      { label: 'Net revenue', value: sum(3), kind: 'money' }, { label: 'Cost of goods', value: sum(4), kind: 'money' }, { label: 'Margin (ex-VAT)', value: sum(5), kind: 'money' },
    ]
    doc.tables = [{ columns: [{ label: 'Product', kind: 'text' }, { label: 'Category', kind: 'text' }, { label: 'Units', kind: 'int' }, { label: 'Revenue', kind: 'money' }, { label: 'Cost', kind: 'money' }, { label: 'Margin (ex-VAT)', kind: 'money' }], rows: body, totals: ['Total', '', sum(2), sum(3), sum(4), sum(5)] }]
    return doc
  }

  const keyExpr = { day: 'DATE(t.transaction_date)', cashier: "CONCAT(u.first_name, ' ', u.last_name)", terminal: 'CONCAT(t.terminal_id, COALESCE(CONCAT(" · ", tm.terminal_name), ""))', payment: 't.payment_method' }[group]
  const where = receiptWhere(f)
  const [rows] = await getPool().query<RowDataPacket[]>(
    `SELECT ${keyExpr} AS k,
            SUM(${NOT_VOID}) AS receipts,
            SUM(IF(${NOT_VOID}, t.subtotal, 0)) AS gross,
            SUM(IF(${NOT_VOID}, ${LESS_VAT}, 0)) AS less_vat,
            SUM(IF(${NOT_VOID}, t.discount_total, 0)) AS discounts,
            SUM(IF(${NOT_VOID}, COALESCE(r.refunded, 0), 0)) AS refunds,
            SUM(IF(${NOT_VOID}, t.total_amount - COALESCE(r.refunded, 0), 0)) AS net,
            SUM(IF(${NOT_VOID}, 0, t.total_amount)) AS voids
       FROM transactions t ${WITH_REFUNDS}
       JOIN users u ON u.user_id = t.cashier_id
       LEFT JOIN terminals tm ON tm.terminal_id = t.terminal_id
      WHERE ${where.sql}
      GROUP BY k ORDER BY k`,
    where.params,
  )
  const body = rows.map((r) => [group === 'payment' ? (PAY_LABEL[String(r.k)] ?? String(r.k)) : String(r.k instanceof Date ? r.k.toISOString().slice(0, 10) : r.k), num(r.receipts), money(r.gross), money(r.less_vat), money(r.discounts), money(r.refunds), money(r.voids), money(r.net)] as Cell[])
  const sum = (i: number) => round2(body.reduce((a, row) => a + num(row[i]), 0))
  doc.summary = [
    { label: 'Receipts', value: sum(1), kind: 'int' }, { label: 'Gross sales', value: sum(2), kind: 'money' }, { label: 'Discounts + less VAT', value: round2(sum(3) + sum(4)), kind: 'money' },
    { label: 'Refunds', value: sum(5), kind: 'money' }, { label: 'Voids', value: sum(6), kind: 'money' }, { label: 'Net sales', value: sum(7), kind: 'money' },
  ]
  doc.tables = [{
    columns: [{ label: GROUP_LABEL[group], kind: 'text' }, { label: 'Receipts', kind: 'int' }, { label: 'Gross', kind: 'money' }, { label: 'Less VAT (SC/PWD)', kind: 'money' }, { label: 'Discounts', kind: 'money' }, { label: 'Refunds', kind: 'money' }, { label: 'Voids', kind: 'money' }, { label: 'Net sales', kind: 'money' }],
    rows: body, totals: ['Total', sum(1), sum(2), sum(3), sum(4), sum(5), sum(6), sum(7)],
  }]
  return doc
}

// ---------------------------------------------------------------------------
// Inventory, waste, purchasing, customer requests
// ---------------------------------------------------------------------------

export async function inventoryReport(f: Filters, generatedBy: string): Promise<ReportDoc> {
  const db = getPool()
  const doc = await header(db, 'inventory', 'Inventory report', periodOf(f), generatedBy, await filterNotes(db, f))
  const [stock] = await db.query<RowDataPacket[]>(
    `SELECT p.product_id, p.product_name, COALESCE(p.category, '') AS category, p.reorder_level,
            COALESCE(SUM(i.quantity_on_hand), 0) AS stock, COALESCE(p.cost_price, 0) AS cost, p.unit_price AS price
       FROM products p LEFT JOIN inventory i ON i.product_id = p.product_id
      WHERE p.deleted_at IS NULL AND p.is_active = TRUE ${f.product_id ? 'AND p.product_id = ?' : ''}
      GROUP BY p.product_id ORDER BY p.category, p.product_name`,
    f.product_id ? [f.product_id] : [],
  )
  const stockRows = stock.map((r) => {
    const qty = num(r.stock), reorder = num(r.reorder_level)
    return [String(r.product_name), String(r.category), qty, reorder, qty <= 0 ? 'Out of stock' : qty <= reorder ? 'Low' : 'OK', round2(qty * num(r.cost)), round2(qty * num(r.price))] as Cell[]
  })
  const stockSum = (i: number) => round2(stockRows.reduce((a, row) => a + num(row[i]), 0))

  const params: (string | number)[] = [f.from, f.to]
  let extra = ''
  if (f.product_id) { extra += ' AND i.product_id = ?'; params.push(f.product_id) }
  if (f.cashier_id) { extra += ' AND a.user_id = ?'; params.push(f.cashier_id) }
  const [moves] = await db.query<RowDataPacket[]>(
    `SELECT a.adjustment_date, p.product_name, a.adjustment_type, a.quantity_change, a.reason, CONCAT(u.first_name, ' ', u.last_name) AS who
       FROM inventory_adjustments a JOIN inventory i ON i.inventory_id = a.inventory_id JOIN products p ON p.product_id = i.product_id JOIN users u ON u.user_id = a.user_id
      WHERE DATE(a.adjustment_date) BETWEEN ? AND ?${extra}
      ORDER BY a.adjustment_date DESC, a.adjustment_id DESC LIMIT 2000`,
    params,
  )
  const typeLabel: Record<string, string> = { sale: 'Sale', receive: 'Delivery received', waste: 'Waste', adjustment: 'Adjustment', void_return: 'Void / refund return' }
  const moveRows = moves.map((r) => [dt(r.adjustment_date), String(r.product_name), typeLabel[String(r.adjustment_type)] ?? String(r.adjustment_type), num(r.quantity_change), String(r.reason ?? ''), String(r.who)] as Cell[])

  doc.summary = [
    { label: 'Products', value: stockRows.length, kind: 'int' }, { label: 'Units in stock', value: stockSum(2), kind: 'int' },
    { label: 'Stock value at cost', value: stockSum(5), kind: 'money' }, { label: 'Stock value at retail', value: stockSum(6), kind: 'money' },
    { label: 'Low or out', value: stockRows.filter((r) => r[4] !== 'OK').length, kind: 'int' }, { label: 'Stock movements', value: moveRows.length, kind: 'int' },
  ]
  doc.tables = [
    { title: 'Stock on hand now', columns: [{ label: 'Product', kind: 'text' }, { label: 'Category', kind: 'text' }, { label: 'On hand', kind: 'int' }, { label: 'Reorder level', kind: 'int' }, { label: 'Status', kind: 'text' }, { label: 'Value at cost', kind: 'money' }, { label: 'Value at retail', kind: 'money' }], rows: stockRows, totals: ['Total', '', stockSum(2), '', '', stockSum(5), stockSum(6)] },
    { title: 'Stock movements in the period', columns: [{ label: 'Date', kind: 'text' }, { label: 'Product', kind: 'text' }, { label: 'Type', kind: 'text' }, { label: 'Change', kind: 'int' }, { label: 'Reason', kind: 'text' }, { label: 'By', kind: 'text' }], rows: moveRows },
  ]
  return doc
}

export async function wasteReport(f: Filters, generatedBy: string): Promise<ReportDoc> {
  const db = getPool()
  const doc = await header(db, 'waste', 'Waste report', periodOf(f), generatedBy, await filterNotes(db, f))
  const params: (string | number)[] = [f.from, f.to]
  let extra = ''
  if (f.product_id) { extra += ' AND w.product_id = ?'; params.push(f.product_id) }
  if (f.cashier_id) { extra += ' AND w.user_id = ?'; params.push(f.cashier_id) }
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT w.waste_date, p.product_name, w.quantity, w.reason, w.notes, COALESCE(p.cost_price, 0) * w.quantity AS value, CONCAT(u.first_name, ' ', u.last_name) AS who
       FROM waste_records w JOIN products p ON p.product_id = w.product_id JOIN users u ON u.user_id = w.user_id
      WHERE DATE(w.waste_date) BETWEEN ? AND ?${extra} ORDER BY w.waste_date DESC, w.waste_id DESC`,
    params,
  )
  const reasonLabel: Record<string, string> = { damaged: 'Damaged', expired: 'Expired', spoiled: 'Spoiled', theft: 'Theft / Shrink', customer_return: 'Customer return', other: 'Other' }
  const body = rows.map((r) => [dt(r.waste_date), String(r.product_name), num(r.quantity), reasonLabel[String(r.reason)] ?? String(r.reason), money(r.value), String(r.notes ?? ''), String(r.who)] as Cell[])
  const total = round2(body.reduce((a, r) => a + num(r[4]), 0))
  const byReason = new Map<string, { n: number; qty: number; value: number }>()
  for (const r of body) { const x = byReason.get(String(r[3])) ?? { n: 0, qty: 0, value: 0 }; x.n += 1; x.qty += num(r[2]); x.value = round2(x.value + num(r[4])); byReason.set(String(r[3]), x) }
  doc.summary = [{ label: 'Entries', value: body.length, kind: 'int' }, { label: 'Units written off', value: body.reduce((a, r) => a + num(r[2]), 0), kind: 'int' }, { label: 'Loss at cost', value: total, kind: 'money' }]
  doc.tables = [
    { title: 'By reason', columns: [{ label: 'Reason', kind: 'text' }, { label: 'Entries', kind: 'int' }, { label: 'Units', kind: 'int' }, { label: 'Loss at cost', kind: 'money' }], rows: [...byReason].sort((a, b) => b[1].value - a[1].value).map(([k, x]) => [k, x.n, x.qty, x.value] as Cell[]) },
    { title: 'Entries', columns: [{ label: 'Date', kind: 'text' }, { label: 'Product', kind: 'text' }, { label: 'Qty', kind: 'int' }, { label: 'Reason', kind: 'text' }, { label: 'Loss at cost', kind: 'money' }, { label: 'Notes', kind: 'text' }, { label: 'Recorded by', kind: 'text' }], rows: body, totals: ['Total', '', body.reduce((a, r) => a + num(r[2]), 0), '', total, '', ''] },
  ]
  return doc
}

export async function purchasingReport(f: Filters, generatedBy: string): Promise<ReportDoc> {
  const db = getPool()
  const doc = await header(db, 'purchasing', 'Purchasing report', periodOf(f), generatedBy, await filterNotes(db, f))
  const params: (string | number)[] = [f.from, f.to]
  let extra = ''
  if (f.product_id) { extra += ' AND EXISTS (SELECT 1 FROM purchase_order_items fi WHERE fi.po_id = po.po_id AND fi.product_id = ?)'; params.push(f.product_id) }
  if (f.cashier_id) { extra += ' AND po.created_by = ?'; params.push(f.cashier_id) }
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT po.po_number, COALESCE(po.supplier, '') AS supplier, po.status, po.created_at, po.expected_delivery, po.completed_at,
            COUNT(poi.po_item_id) AS line_count, COALESCE(SUM(poi.ordered_quantity), 0) AS ordered, COALESCE(SUM(poi.received_quantity), 0) AS received,
            COALESCE(SUM(poi.ordered_quantity * COALESCE(poi.unit_cost, 0)), 0) AS value, CONCAT(u.first_name, ' ', u.last_name) AS who
       FROM purchase_orders po LEFT JOIN purchase_order_items poi ON poi.po_id = po.po_id JOIN users u ON u.user_id = po.created_by
      WHERE DATE(po.created_at) BETWEEN ? AND ?${extra} GROUP BY po.po_id ORDER BY po.created_at DESC, po.po_id DESC`,
    params,
  )
  const statusLabel: Record<string, string> = { pending: 'Pending', partially_received: 'Partially received', completed: 'Completed', cancelled: 'Cancelled' }
  const body = rows.map((r) => [String(r.po_number), String(r.supplier), statusLabel[String(r.status)] ?? String(r.status), dt(r.created_at), r.expected_delivery ? day(r.expected_delivery) : '', num(r.line_count), num(r.ordered), num(r.received), money(r.value), String(r.who)] as Cell[])
  const open = rows.filter((r) => r.status === 'pending' || r.status === 'partially_received')
  doc.summary = [
    { label: 'Purchase orders', value: body.length, kind: 'int' }, { label: 'Still open', value: open.length, kind: 'int' }, { label: 'Completed', value: rows.filter((r) => r.status === 'completed').length, kind: 'int' },
    { label: 'Cancelled', value: rows.filter((r) => r.status === 'cancelled').length, kind: 'int' }, { label: 'Value ordered (excl. cancelled)', value: round2(rows.filter((r) => r.status !== 'cancelled').reduce((a, r) => a + num(r.value), 0)), kind: 'money' },
  ]
  doc.tables = [{ columns: [{ label: 'PO', kind: 'text' }, { label: 'Supplier', kind: 'text' }, { label: 'Status', kind: 'text' }, { label: 'Created', kind: 'text' }, { label: 'Expected', kind: 'text' }, { label: 'Lines', kind: 'int' }, { label: 'Ordered', kind: 'int' }, { label: 'Received', kind: 'int' }, { label: 'Value', kind: 'money' }, { label: 'Created by', kind: 'text' }], rows: body }]
  return doc
}

export async function requestsReport(f: Filters, generatedBy: string): Promise<ReportDoc> {
  const db = getPool()
  const doc = await header(db, 'requests', 'Customer requests report', periodOf(f), generatedBy, await filterNotes(db, f))
  const params: (string | number)[] = [f.from, f.to]
  let extra = ''
  if (f.cashier_id) { extra += ' AND q.cashier_id = ?'; params.push(f.cashier_id) }
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT q.request_date, q.product_name_requested, COALESCE(q.category, '') AS category, q.quantity_requested, q.status, COALESCE(q.notes, '') AS notes, CONCAT(u.first_name, ' ', u.last_name) AS who
       FROM customer_requests q JOIN users u ON u.user_id = q.cashier_id WHERE DATE(q.request_date) BETWEEN ? AND ?${extra} ORDER BY q.request_date DESC, q.request_id DESC`,
    params,
  )
  const statusLabel: Record<string, string> = { pending: 'New', reviewing: 'Reviewing', ordered: 'Ordered', available: 'Now in stock', declined: 'Declined', closed: 'Closed' }
  const body = rows.map((r) => [dt(r.request_date), String(r.product_name_requested), String(r.category), r.quantity_requested === null ? null : num(r.quantity_requested), statusLabel[String(r.status)] ?? String(r.status), String(r.who), String(r.notes)] as Cell[])
  const byStatus = new Map<string, number>()
  for (const r of body) byStatus.set(String(r[4]), (byStatus.get(String(r[4])) ?? 0) + 1)
  const byItem = new Map<string, { n: number; qty: number }>()
  for (const r of rows) { const k = String(r.product_name_requested).trim().toLowerCase(); const x = byItem.get(k) ?? { n: 0, qty: 0 }; x.n += 1; x.qty += num(r.quantity_requested); byItem.set(k, x) }
  doc.summary = [{ label: 'Requests', value: body.length, kind: 'int' }, ...[...byStatus].map(([k, n]) => ({ label: k, value: n, kind: 'int' as Kind }))]
  doc.tables = [
    { title: 'Most requested', columns: [{ label: 'Item', kind: 'text' }, { label: 'Times asked', kind: 'int' }, { label: 'Total qty', kind: 'int' }], rows: [...byItem].sort((a, b) => b[1].n - a[1].n).slice(0, 15).map(([k, x]) => [k, x.n, x.qty] as Cell[]) },
    { title: 'All requests', columns: [{ label: 'Date', kind: 'text' }, { label: 'Item', kind: 'text' }, { label: 'Category', kind: 'text' }, { label: 'Qty', kind: 'int' }, { label: 'Status', kind: 'text' }, { label: 'Logged by', kind: 'text' }, { label: 'Notes', kind: 'text' }], rows: body },
  ]
  return doc
}

// ---------------------------------------------------------------------------
// e-Journal and VAT summary
// ---------------------------------------------------------------------------

export async function eJournal(f: Filters, generatedBy: string): Promise<ReportDoc> {
  const db = getPool()
  const doc = await header(db, 'e-journal', 'e-Journal', periodOf(f), generatedBy, await filterNotes(db, f))
  const where = receiptWhere(f)
  const [sales] = await db.query<RowDataPacket[]>(
    `SELECT t.transaction_id, t.transaction_date, t.receipt_number, t.terminal_id, CONCAT(u.first_name, ' ', u.last_name) AS who, t.customer_type, t.payment_method,
            t.subtotal, t.discount_total, t.tax_amount, t.total_amount, t.status, t.void_reason, t.reprint_count
       FROM transactions t JOIN users u ON u.user_id = t.cashier_id WHERE ${where.sql} ORDER BY t.transaction_date, t.transaction_id LIMIT 5000`,
    where.params,
  )
  const rParams: (string | number)[] = [f.from, f.to]
  let rExtra = ''
  if (f.cashier_id) { rExtra += ' AND rf.processed_by = ?'; rParams.push(f.cashier_id) }
  if (f.terminal_id) { rExtra += ' AND rf.terminal_id = ?'; rParams.push(f.terminal_id) }
  if (f.product_id) { rExtra += ' AND EXISTS (SELECT 1 FROM refund_items fi WHERE fi.refund_id = rf.refund_id AND fi.product_id = ?)'; rParams.push(f.product_id) }
  const [refunds] = await db.query<RowDataPacket[]>(
    `SELECT rf.refund_id, rf.refunded_at, t.receipt_number, rf.terminal_id, CONCAT(u.first_name, ' ', u.last_name) AS who, rf.refund_method, rf.refund_amount, rf.reason
       FROM refunds rf JOIN transactions t ON t.transaction_id = rf.transaction_id JOIN users u ON u.user_id = rf.processed_by
      WHERE DATE(rf.refunded_at) BETWEEN ? AND ?${rExtra} ORDER BY rf.refunded_at LIMIT 5000`,
    rParams,
  )
  const custLabel: Record<string, string> = { regular: 'Regular', senior: 'Senior', pwd: 'PWD' }
  const entries: { at: number; row: Cell[] }[] = []
  for (const r of sales) {
    const voided = r.status === 'voided'
    entries.push({ at: new Date(r.transaction_date).getTime() + r.transaction_id / 1e6, row: [dt(r.transaction_date), String(r.receipt_number), String(r.terminal_id), String(r.who), voided ? 'VOID' : 'SALE', custLabel[String(r.customer_type)] ?? '', String(r.payment_method).toUpperCase(), money(r.subtotal), money(r.discount_total), money(r.tax_amount), voided ? 0 : money(r.total_amount), voided ? `Voided: ${r.void_reason ?? ''}` : r.reprint_count > 0 ? `Reprinted ${r.reprint_count}x` : ''] })
  }
  for (const r of refunds) {
    entries.push({ at: new Date(r.refunded_at).getTime() + r.refund_id / 1e6, row: [dt(r.refunded_at), String(r.receipt_number), String(r.terminal_id), String(r.who), 'REFUND', '', String(r.refund_method).toUpperCase(), null, null, null, -money(r.refund_amount), String(r.reason ?? '')] })
  }
  entries.sort((a, b) => a.at - b.at)
  const body = entries.map((e) => e.row)
  const saleRows = sales.filter((r) => r.status !== 'voided')
  doc.summary = [
    { label: 'Sales', value: saleRows.length, kind: 'int' }, { label: 'Voids', value: sales.length - saleRows.length, kind: 'int' }, { label: 'Refunds', value: refunds.length, kind: 'int' },
    { label: 'Sales total', value: round2(saleRows.reduce((a, r) => a + num(r.total_amount), 0)), kind: 'money' }, { label: 'Refunded', value: round2(refunds.reduce((a, r) => a + num(r.refund_amount), 0)), kind: 'money' },
  ]
  doc.tables = [{ columns: [{ label: 'Date / time', kind: 'text' }, { label: 'Receipt', kind: 'text' }, { label: 'Terminal', kind: 'text' }, { label: 'Cashier', kind: 'text' }, { label: 'Entry', kind: 'text' }, { label: 'Customer', kind: 'text' }, { label: 'Payment', kind: 'text' }, { label: 'Gross', kind: 'money' }, { label: 'Discount', kind: 'money' }, { label: 'VAT', kind: 'money' }, { label: 'Amount', kind: 'money' }, { label: 'Remarks', kind: 'text' }], rows: body }]
  return doc
}

export async function vatSummary(f: Filters, generatedBy: string): Promise<ReportDoc> {
  const db = getPool()
  const doc = await header(db, 'vat-summary', 'VAT summary', periodOf(f), generatedBy, await filterNotes(db, f))
  const where = receiptWhere(f)
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT DATE(t.transaction_date) AS d, COUNT(*) AS receipts,
            SUM(t.vatable_sales) AS vatable, SUM(t.tax_amount) AS vat, SUM(t.vat_exempt_sales) AS exempt,
            SUM(IF(t.customer_type = 'regular', 0, ${LESS_VAT})) AS less_vat, SUM(IF(t.customer_type = 'regular', 0, t.discount_total)) AS scpwd, SUM(t.total_amount) AS total
       FROM transactions t WHERE ${NOT_VOID} AND ${where.sql} GROUP BY d ORDER BY d`,
    where.params,
  )
  const body = rows.map((r) => [day(r.d), num(r.receipts), money(r.vatable), money(r.vat), money(r.exempt), money(r.less_vat), money(r.scpwd), money(r.total)] as Cell[])
  const sum = (i: number) => round2(body.reduce((a, row) => a + num(row[i]), 0))
  doc.summary = [{ label: 'VATable sales (excl. VAT)', value: sum(2), kind: 'money' }, { label: 'Output VAT', value: sum(3), kind: 'money' }, { label: 'VAT-exempt sales', value: sum(4), kind: 'money' }, { label: 'Less VAT (SC/PWD)', value: sum(5), kind: 'money' }, { label: 'SC/PWD 20% discount', value: sum(6), kind: 'money' }, { label: 'Total sales', value: sum(7), kind: 'money' }]
  doc.tables = [{ columns: [{ label: 'Date', kind: 'text' }, { label: 'Receipts', kind: 'int' }, { label: 'VATable sales', kind: 'money' }, { label: 'Output VAT', kind: 'money' }, { label: 'VAT-exempt sales', kind: 'money' }, { label: 'Less VAT (SC/PWD)', kind: 'money' }, { label: 'SC/PWD discount', kind: 'money' }, { label: 'Total sales', kind: 'money' }], rows: body, totals: ['Total', sum(1), sum(2), sum(3), sum(4), sum(5), sum(6), sum(7)] }]
  doc.filters.push('Before refunds; voided receipts are left out')
  return doc
}

// ---------------------------------------------------------------------------
// X-Reading (one shift) and Z-Reading (one day)
// ---------------------------------------------------------------------------

export interface ReadingFigures {
  scope: 'shift' | 'day'
  date: string
  terminal_id: string
  terminals: string[]
  cashier: string | null
  shift_start: string | null
  shift_end: string | null
  beginning_invoice: string | null
  ending_invoice: string | null
  transaction_count: number
  gross_sales: number
  less_vat_sc_pwd: number
  discount_sc_pwd: number
  discount_other: number
  voids_count: number
  voids: number
  refunds_count: number
  refunds: number
  net_sales: number
  vatable_sales: number
  vat_amount: number
  vat_exempt_sales: number
  payments: { method: string; count: number; amount: number; refunds: number }[]
  cash_expected: number
  /** Z only: the accumulated grand total before the first and after the last sale of the day. */
  beginning_grand_total: number | null
  ending_grand_total: number | null
  per_terminal: { terminal_id: string; count: number; gross: number; net: number }[]
}

interface Scope { session_id?: number; date?: string }

async function compute(db: Db, scope: Scope): Promise<ReadingFigures> {
  const byShift = scope.session_id !== undefined
  const txWhere = byShift ? 't.session_id = ?' : 'DATE(t.transaction_date) = ?'
  const rfWhere = byShift ? 'rf.session_id = ?' : 'DATE(rf.refunded_at) = ?'
  const arg = byShift ? scope.session_id! : scope.date!

  const [[tot], [pay], [rf], [first], [last], [terms]] = await Promise.all([
    db.query<RowDataPacket[]>(
      `SELECT SUM(${NOT_VOID}) AS n, SUM(IF(${NOT_VOID}, t.subtotal, 0)) AS gross,
              SUM(IF(${NOT_VOID} AND t.customer_type <> 'regular', ${LESS_VAT}, 0)) AS less_vat,
              SUM(IF(${NOT_VOID} AND t.customer_type <> 'regular', t.discount_total, 0)) AS d_scpwd,
              SUM(IF(${NOT_VOID} AND t.customer_type = 'regular', t.discount_total, 0)) AS d_other,
              SUM(IF(${NOT_VOID}, 0, 1)) AS void_n, SUM(IF(${NOT_VOID}, 0, t.total_amount)) AS voids,
              SUM(IF(${NOT_VOID}, t.total_amount, 0)) AS sales_total,
              SUM(IF(${NOT_VOID}, t.vatable_sales, 0)) AS vatable, SUM(IF(${NOT_VOID}, t.tax_amount, 0)) AS vat, SUM(IF(${NOT_VOID}, t.vat_exempt_sales, 0)) AS exempt
         FROM transactions t WHERE ${txWhere}`, [arg]),
    db.query<RowDataPacket[]>(`SELECT t.payment_method AS m, COUNT(*) AS n, SUM(t.total_amount) AS amount FROM transactions t WHERE ${NOT_VOID} AND ${txWhere} GROUP BY t.payment_method`, [arg]),
    db.query<RowDataPacket[]>(`SELECT rf.refund_method AS m, COUNT(*) AS n, SUM(rf.refund_amount) AS amount FROM refunds rf WHERE ${rfWhere} GROUP BY rf.refund_method`, [arg]),
    db.query<RowDataPacket[]>(`SELECT t.receipt_number, t.total_amount, t.grand_total_after, t.transaction_date FROM transactions t WHERE ${txWhere} ORDER BY t.transaction_id ASC LIMIT 1`, [arg]),
    db.query<RowDataPacket[]>(`SELECT t.receipt_number, t.grand_total_after, t.transaction_date FROM transactions t WHERE ${txWhere} ORDER BY t.transaction_id DESC LIMIT 1`, [arg]),
    db.query<RowDataPacket[]>(
      `SELECT t.terminal_id, SUM(${NOT_VOID}) AS n, SUM(IF(${NOT_VOID}, t.subtotal, 0)) AS gross, SUM(IF(${NOT_VOID}, t.total_amount, 0)) AS sales
         FROM transactions t WHERE ${txWhere} GROUP BY t.terminal_id ORDER BY t.terminal_id`, [arg]),
  ])
  const t = tot[0] ?? {}
  const refundTotal = round2(rf.reduce((a, r) => a + num(r.amount), 0))
  const refundByTerminal = new Map<string, number>()
  if (!byShift) {
    const [rows] = await db.query<RowDataPacket[]>(`SELECT rf.terminal_id, SUM(rf.refund_amount) AS amount FROM refunds rf WHERE ${rfWhere} GROUP BY rf.terminal_id`, [arg])
    for (const r of rows) refundByTerminal.set(String(r.terminal_id), money(r.amount))
  }
  const methods = ['cash', 'gcash', 'maya', 'card']
  const payments = methods.map((m) => {
    const p = pay.find((r) => r.m === m), q = rf.find((r) => r.m === m)
    return { method: m, count: num(p?.n), amount: money(p?.amount), refunds: money(q?.amount) }
  })
  const cash = payments.find((p) => p.method === 'cash')!

  let cashier: string | null = null, terminal = SYSTEM_TERMINAL_ID, start: string | null = null, end: string | null = null, date = scope.date ?? ''
  if (byShift) {
    const [[s]] = await Promise.all([db.query<RowDataPacket[]>(
      `SELECT s.terminal_id, s.assigned_at, s.login_time, s.logout_time, s.is_active, DATE(COALESCE(s.login_time, s.assigned_at)) AS d, CONCAT(u.first_name, ' ', u.last_name) AS who
         FROM sessions s JOIN users u ON u.user_id = s.user_id WHERE s.session_id = ?`, [scope.session_id])])
    const row = s[0]
    if (!row) throw HttpError.notFound('Shift not found')
    cashier = String(row.who); terminal = String(row.terminal_id); start = iso(row.login_time ?? row.assigned_at); end = row.logout_time ? iso(row.logout_time) : null
    date = day(row.d)
  }

  const gross = money(t.gross), lessVat = money(t.less_vat), dScpwd = money(t.d_scpwd), dOther = money(t.d_other)
  const salesTotal = money(t.sales_total)
  const figures: ReadingFigures = {
    scope: byShift ? 'shift' : 'day', date, terminal_id: byShift ? terminal : 'ALL', terminals: terms.map((r) => String(r.terminal_id)), cashier, shift_start: start, shift_end: end,
    beginning_invoice: first[0]?.receipt_number ?? null, ending_invoice: last[0]?.receipt_number ?? null,
    transaction_count: num(t.n), gross_sales: gross, less_vat_sc_pwd: lessVat, discount_sc_pwd: dScpwd, discount_other: dOther,
    voids_count: num(t.void_n), voids: money(t.voids), refunds_count: rf.reduce((a, r) => a + num(r.n), 0), refunds: refundTotal,
    net_sales: round2(salesTotal - refundTotal), vatable_sales: money(t.vatable), vat_amount: money(t.vat), vat_exempt_sales: money(t.exempt),
    payments, cash_expected: round2(cash.amount - cash.refunds),
    beginning_grand_total: null, ending_grand_total: null,
    per_terminal: terms.map((r) => ({ terminal_id: String(r.terminal_id), count: num(r.n), gross: money(r.gross), net: round2(num(r.sales) - (refundByTerminal.get(String(r.terminal_id)) ?? 0)) })),
  }
  if (!byShift) {
    // The accumulated total only ever goes up, so the day starts where the first sale left it minus that sale, and ends where the last one left it.
    if (first[0]?.grand_total_after !== null && first[0]) {
      figures.beginning_grand_total = round2(num(first[0].grand_total_after) - num(first[0].total_amount))
      figures.ending_grand_total = money(last[0]?.grand_total_after)
    } else {
      const [prev] = await db.query<RowDataPacket[]>('SELECT grand_total_after FROM transactions WHERE DATE(transaction_date) < ? AND grand_total_after IS NOT NULL ORDER BY transaction_id DESC LIMIT 1', [scope.date])
      const before = prev[0] ? money(prev[0].grand_total_after) : 0
      figures.beginning_grand_total = before
      figures.ending_grand_total = before
    }
  }
  return figures
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v))
const day = (v: unknown) => {
  if (v instanceof Date) { const p = (n: number) => String(n).padStart(2, '0'); return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}` }
  return String(v).slice(0, 10)
}
function dt(v: unknown): string {
  if (!(v instanceof Date)) return String(v ?? '')
  const p = (n: number) => String(n).padStart(2, '0')
  return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())} ${p(v.getHours())}:${p(v.getMinutes())}`
}


function readingDoc(base: ReportDoc, kind: 'X' | 'Z', p: ReadingFigures, meta: { reading_id: number | null; reading_no: number | null; stored: boolean; source: string | null }): ReportDoc {
  const text = (label: string, value: Cell): ReportDoc['summary'][number] => ({ label, value, kind: 'text' })
  const m = (label: string, value: number): ReportDoc['summary'][number] => ({ label, value, kind: 'money' })
  base.summary = kind === 'X'
    ? [text('Cashier', p.cashier), text('Terminal', p.terminal_id), text('Shift start', p.shift_start ? dt(new Date(p.shift_start)) : '—'), text('Shift end', p.shift_end ? dt(new Date(p.shift_end)) : 'still open'),
        text('Beginning invoice', p.beginning_invoice ?? '—'), text('Ending invoice', p.ending_invoice ?? '—'), { label: 'Transactions', value: p.transaction_count, kind: 'int' }]
    : [text('Terminals', p.terminals.join(', ') || '—'), text('First invoice', p.beginning_invoice ?? '—'), text('Last invoice', p.ending_invoice ?? '—'), { label: 'Transactions', value: p.transaction_count, kind: 'int' },
        m('Beginning accumulated grand total', p.beginning_grand_total ?? 0), m('Ending accumulated grand total', p.ending_grand_total ?? 0)]
  const rows: Cell[][] = [
    ['Gross sales', p.gross_sales], ['Less VAT (Senior/PWD)', -p.less_vat_sc_pwd], ['Senior/PWD discounts (20%)', -p.discount_sc_pwd], ['Other discounts', -p.discount_other],
    [`Refunds (${p.refunds_count})`, -p.refunds], ['NET SALES', p.net_sales], ['', null],
    ['VATable sales', p.vatable_sales], ['Output VAT', p.vat_amount], ['VAT-exempt sales', p.vat_exempt_sales], ['', null],
    [`Voided receipts (${p.voids_count}) — not included above`, p.voids],
  ]
  base.tables = [
    { title: 'Sales', columns: [{ label: 'Item', kind: 'text' }, { label: 'Amount', kind: 'money' }], rows },
    { title: 'Payments', columns: [{ label: 'Method', kind: 'text' }, { label: 'Transactions', kind: 'int' }, { label: 'Sales', kind: 'money' }, { label: 'Refunds paid', kind: 'money' }, { label: 'Net', kind: 'money' }], rows: p.payments.map((x) => [PAY_LABEL[x.method] ?? x.method, x.count, x.amount, x.refunds, round2(x.amount - x.refunds)] as Cell[]), totals: ['Total', p.payments.reduce((a, x) => a + x.count, 0), round2(p.payments.reduce((a, x) => a + x.amount, 0)), round2(p.payments.reduce((a, x) => a + x.refunds, 0)), round2(p.payments.reduce((a, x) => a + x.amount - x.refunds, 0))] },
    { title: 'Cash drawer', columns: [{ label: 'Item', kind: 'text' }, { label: 'Amount', kind: 'money' }], rows: [['Cash expected in drawer (cash sales minus cash refunds)', p.cash_expected]] },
  ]
  if (kind === 'Z') base.tables.push({ title: 'By terminal', columns: [{ label: 'Terminal', kind: 'text' }, { label: 'Transactions', kind: 'int' }, { label: 'Gross', kind: 'money' }, { label: 'Net', kind: 'money' }], rows: p.per_terminal.map((x) => [x.terminal_id, x.count, x.gross, x.net] as Cell[]) })
  base.reading = { ...meta, kind, payload: p }
  return base
}

async function nextReadingNo(connection: PoolConnection, kind: 'X' | 'Z'): Promise<number> {
  // Z-Readings are closed under the grand total lock (see closeDay), so they can't take the same number. X-Readings only need to be roughly in order.
  const [rows] = await connection.query<RowDataPacket[]>('SELECT COALESCE(MAX(reading_no), 0) + 1 AS n FROM readings WHERE reading_type = ?', [kind])
  return num(rows[0]?.n)
}

function rowToDoc(row: RowDataPacket): ReadingFigures {
  const d = typeof row.details === 'string' ? JSON.parse(row.details) : row.details
  return d as ReadingFigures
}

/** The X-Reading of one shift. A stored one (made when the owner ended the shift, or saved by hand) is shown as it was; otherwise it is worked out now. */
export async function xReading(sessionId: number, generatedBy: string, preferStored = false): Promise<ReportDoc> {
  const db = getPool()
  const [stored] = await db.query<RowDataPacket[]>("SELECT * FROM readings WHERE reading_type = 'X' AND session_id = ? ORDER BY reading_id DESC LIMIT 1", [sessionId])
  const [live] = await db.query<RowDataPacket[]>('SELECT is_active FROM sessions WHERE session_id = ?', [sessionId])
  if (!live[0]) throw HttpError.notFound('Shift not found')
  const useStored = stored[0] && (preferStored || !live[0].is_active)
  const figures = useStored ? rowToDoc(stored[0]!) : await compute(db, { session_id: sessionId })
  const doc = await header(db, 'x-reading', 'X-Reading', `${figures.date} · ${figures.cashier ?? ''} · ${figures.terminal_id}`, generatedBy)
  return readingDoc(doc, 'X', figures, useStored ? { reading_id: num(stored[0]!.reading_id), reading_no: num(stored[0]!.reading_no), stored: true, source: String(stored[0]!.source) } : { reading_id: null, reading_no: null, stored: false, source: null })
}

/** Saves an X-Reading for the shift (inside the caller's transaction when given one). */
export async function storeXReading(connection: PoolConnection, sessionId: number, generatedBy: number, source: 'manual' | 'end_of_shift'): Promise<{ reading_id: number; reading_no: number }> {
  const figures = await compute(connection, { session_id: sessionId })
  const [[s]] = await Promise.all([connection.query<RowDataPacket[]>('SELECT user_id, terminal_id FROM sessions WHERE session_id = ?', [sessionId])])
  if (!s[0]) throw HttpError.notFound('Shift not found')
  const no = await nextReadingNo(connection, 'X')
  const [res] = await connection.execute<ResultSetHeader>(
    `INSERT INTO readings (reading_type, reading_no, terminal_id, cashier_id, generated_by, source, session_id, reading_date, gross_sales, discounts, voids, net_sales, transaction_count, payment_breakdown, details)
     VALUES ('X', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [no, s[0].terminal_id, s[0].user_id, generatedBy, source, sessionId, figures.date, figures.gross_sales, round2(figures.discount_sc_pwd + figures.discount_other), figures.voids, figures.net_sales, figures.transaction_count, JSON.stringify(figures.payments), JSON.stringify(figures)],
  )
  await logAudit({ user_id: generatedBy, session_id: sessionId, action: 'X_READING', module: 'REPORTS', terminal_id: String(s[0].terminal_id), details: { reading_id: res.insertId, reading_no: no, source, net_sales: figures.net_sales } }, connection)
  return { reading_id: res.insertId, reading_no: no }
}

/** "Save this X-Reading" from the Reports screen. */
export async function saveXReading(sessionId: number, ownerId: number, ownerName: string): Promise<ReportDoc> {
  await withTransaction((c) => storeXReading(c, sessionId, ownerId, 'manual'))
  return xReading(sessionId, ownerName, true)
}

/** The Z-Reading of one day, all terminals together. Shows the stored one when the day has been closed, else a live preview. */
export async function zReading(date: string, generatedBy: string): Promise<ReportDoc> {
  const db = getPool()
  const [stored] = await db.query<RowDataPacket[]>("SELECT * FROM readings WHERE reading_type = 'Z' AND reading_date = ? ORDER BY reading_id DESC LIMIT 1", [date])
  const figures = stored[0] ? rowToDoc(stored[0]) : await compute(db, { date })
  const doc = await header(db, 'z-reading', 'Z-Reading', date, generatedBy)
  return readingDoc(doc, 'Z', figures, stored[0] ? { reading_id: num(stored[0].reading_id), reading_no: num(stored[0].reading_no), stored: true, source: String(stored[0].source) } : { reading_id: null, reading_no: null, stored: false, source: null })
}

/** Closes the day: stores the Z-Reading once per date and stamps the grand total. Asking again for a closed day just returns it. */
export async function closeDay(date: string, ownerId: number, ownerName: string, ip: string | null): Promise<ReportDoc & { already_closed: boolean }> {
  const today = day(new Date())
  if (date > today) throw HttpError.badRequest('That day has not happened yet')
  const result = await withTransaction(async (connection) => {
    await connection.query('SELECT id FROM grand_total WHERE id = 1 FOR UPDATE')
    const [existing] = await connection.query<RowDataPacket[]>("SELECT reading_id FROM readings WHERE reading_type = 'Z' AND reading_date = ? LIMIT 1", [date])
    if (existing[0]) return false
    const [open] = await connection.query<RowDataPacket[]>(
      "SELECT s.terminal_id, CONCAT(u.first_name, ' ', u.last_name) AS who FROM sessions s JOIN users u ON u.user_id = s.user_id WHERE s.is_active = TRUE AND s.terminal_id <> 'PC-00' AND DATE(COALESCE(s.login_time, s.assigned_at)) <= ?", [date])
    if (open.length) throw HttpError.conflict(`End these shifts first: ${open.map((o) => `${o.who} (${o.terminal_id})`).join(', ')}`)
    const figures = await compute(connection, { date })
    const no = await nextReadingNo(connection, 'Z')
    const [res] = await connection.execute<ResultSetHeader>(
      `INSERT INTO readings (reading_type, reading_no, terminal_id, cashier_id, generated_by, source, session_id, reading_date, gross_sales, discounts, voids, net_sales, transaction_count, payment_breakdown, details)
       VALUES ('Z', ?, ?, ?, ?, 'manual', NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [no, SYSTEM_TERMINAL_ID, ownerId, ownerId, date, figures.gross_sales, round2(figures.discount_sc_pwd + figures.discount_other), figures.voids, figures.net_sales, figures.transaction_count, JSON.stringify(figures.payments), JSON.stringify(figures)],
    )
    await connection.execute('UPDATE grand_total SET last_z_reading_at = NOW() WHERE id = 1')
    await logAudit({ user_id: ownerId, action: 'Z_READING', module: 'REPORTS', terminal_id: SYSTEM_TERMINAL_ID, ip_address: ip, details: { reading_id: res.insertId, reading_no: no, date, net_sales: figures.net_sales, ending_grand_total: figures.ending_grand_total } }, connection)
    return true
  })
  return { ...(await zReading(date, ownerName)), already_closed: !result }
}

/** Recent stored readings, for the list on the Reports screen. */
export async function listReadings(kind: 'X' | 'Z', limit = 30) {
  const [rows] = await getPool().query<RowDataPacket[]>(
    `SELECT r.reading_id, r.reading_no, r.reading_type, r.reading_date, r.generated_at, r.source, r.session_id, r.terminal_id, r.net_sales, r.transaction_count, CONCAT(u.first_name, ' ', u.last_name) AS cashier
       FROM readings r JOIN users u ON u.user_id = r.cashier_id WHERE r.reading_type = ? ORDER BY r.reading_id DESC LIMIT ?`, [kind, limit])
  return rows.map((r) => ({ reading_id: num(r.reading_id), reading_no: num(r.reading_no), kind: String(r.reading_type), date: day(r.reading_date), generated_at: iso(r.generated_at), source: String(r.source), session_id: r.session_id === null ? null : num(r.session_id), terminal_id: String(r.terminal_id), cashier: String(r.cashier), net_sales: money(r.net_sales), transaction_count: num(r.transaction_count) }))
}

/** Shifts that overlap the range (started before it and still open, or ended inside it), newest first. */
export async function listShifts(from: string, to: string) {
  const [rows] = await getPool().query<RowDataPacket[]>(
    `SELECT s.session_id, s.terminal_id, s.is_active, s.login_time, s.assigned_at, s.logout_time, s.end_reason, CONCAT(u.first_name, ' ', u.last_name) AS cashier,
            (SELECT COUNT(*) FROM transactions t WHERE t.session_id = s.session_id AND t.status <> 'voided') AS receipts,
            EXISTS (SELECT 1 FROM readings x WHERE x.session_id = s.session_id AND x.reading_type = 'X') AS has_reading
       FROM sessions s JOIN users u ON u.user_id = s.user_id
      WHERE s.terminal_id <> ? AND DATE(COALESCE(s.login_time, s.assigned_at)) <= ?
        AND (s.is_active = TRUE OR DATE(COALESCE(s.logout_time, s.login_time, s.assigned_at)) >= ?)
      ORDER BY s.session_id DESC LIMIT 200`, [SYSTEM_TERMINAL_ID, to, from])
  return rows.map((r) => ({ session_id: num(r.session_id), terminal_id: String(r.terminal_id), cashier: String(r.cashier), active: Boolean(r.is_active), start: iso(r.login_time ?? r.assigned_at), end: r.logout_time ? iso(r.logout_time) : null, end_reason: r.end_reason ? String(r.end_reason) : null, receipts: num(r.receipts), has_reading: Boolean(r.has_reading) }))
}

/** The running BIR totals. Sales only ever add to the accumulated total; voids and refunds are kept apart. */
export async function grandTotal() {
  const [rows] = await getPool().query<RowDataPacket[]>('SELECT accumulated_total, accumulated_voids, accumulated_refunds, last_z_reading_at FROM grand_total WHERE id = 1')
  const [last] = await getPool().query<RowDataPacket[]>("SELECT reading_date, reading_no FROM readings WHERE reading_type = 'Z' ORDER BY reading_id DESC LIMIT 1")
  const r = rows[0]
  return {
    accumulated_total: money(r?.accumulated_total), accumulated_voids: money(r?.accumulated_voids), accumulated_refunds: money(r?.accumulated_refunds),
    last_z_reading_at: r?.last_z_reading_at ? iso(r.last_z_reading_at) : null,
    last_z_date: last[0] ? day(last[0].reading_date) : null, last_z_no: last[0] ? num(last[0].reading_no) : null,
  }
}