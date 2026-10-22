import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { getPool, withTransaction } from '../config/db.js'
import { HttpError } from '../utils/httpError.js'
import { computeTotals, round2, toIso, type CustomerType } from '../utils/pos.js'
import { logAudit } from './audit.service.js'
import type { OwnerApproval } from './auth.service.js'
import { SYSTEM_TERMINAL_ID } from './session.service.js'

// Store data for the workspace screens (src/store/StoreContext.tsx), shaped like the UI's own types
// (src/data/types.ts) so the UI only has to add colours and supplier ids. IDs are prefixed the same
// way the UI does it: p12 = product 12, t5 = transaction 5, u3 = user 3, w7 = waste 7, q2 = request 2.

type Db = PoolConnection | ReturnType<typeof getPool>

/** Who is acting: a cashier on a terminal session, or the owner on the server PC (session on PC-00). */
export interface Actor {
  user_id: number
  session_id: number
  terminal_id: string
  ip_address: string | null
}

/** Same windows as src/data/mockData.ts: itemised receipts for the last 7 days, daily totals for 12 weeks before. */
const DETAIL_DAYS = 7
const HISTORY_DAYS = 85

const PAYMENT_TO_UI = { cash: 'Cash', gcash: 'GCash', maya: 'Maya', card: 'Card' } as const
const PAYMENT_TO_DB = { Cash: 'cash', GCash: 'gcash', Maya: 'maya', Card: 'card' } as const
const CUSTOMER_TO_UI = { regular: 'Regular', senior: 'Senior', pwd: 'PWD' } as const
const STATUS_TO_UI = { completed: 'Completed', voided: 'Voided', refunded: 'Refunded', partially_refunded: 'Partially refunded' } as const
export const WASTE_TO_UI = { damaged: 'Damaged', expired: 'Expired', spoiled: 'Spoiled', theft: 'Theft / Shrink', customer_return: 'Customer return', other: 'Other' } as const
export const WASTE_TO_DB = { Damaged: 'damaged', Expired: 'expired', Spoiled: 'spoiled', 'Theft / Shrink': 'theft', 'Customer return': 'customer_return', Other: 'other' } as const
export const REQUEST_TO_UI = { pending: 'New', reviewing: 'Reviewing', ordered: 'Ordered', available: 'Stocked', declined: 'Declined', closed: 'Stocked' } as const
export const REQUEST_TO_DB = { New: 'pending', Reviewing: 'reviewing', Ordered: 'ordered', Stocked: 'available', Declined: 'declined' } as const

export type PaymentMethodUi = keyof typeof PAYMENT_TO_DB
export type WasteReasonUi = keyof typeof WASTE_TO_DB
export type RequestStatusUi = keyof typeof REQUEST_TO_DB

const productNumber = (id: number | string) => Number(String(id).replace(/^p/, ''))

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** The store's name, set by the owner (first launch or Settings); shown on every PC and receipt. */
export async function storeName(db: Db = getPool()): Promise<string> {
  const [rows] = await db.query<RowDataPacket[]>("SELECT setting_value FROM system_settings WHERE setting_key = 'business_name'")
  return String(rows[0]?.setting_value ?? '')
}

/** Name, TIN and address printed on every receipt. TIN and address are empty until the owner fills them in. */
export interface BusinessInfo {
  name: string
  tin: string
  address: string
}

export async function businessInfo(db: Db = getPool()): Promise<BusinessInfo> {
  const [rows] = await db.query<RowDataPacket[]>("SELECT setting_key, setting_value FROM system_settings WHERE setting_key IN ('business_name', 'business_tin', 'business_address')")
  const value = (key: string) => String(rows.find((row) => row.setting_key === key)?.setting_value ?? '')
  return { name: value('business_name'), tin: value('business_tin'), address: value('business_address') }
}

const SETTING_DESCRIPTIONS = { business_name: 'Business name for receipts', business_tin: 'BIR TIN', business_address: 'Business address' } as const

/** Saves the store name, TIN and/or address (only the ones given). Every PC and receipt reads them from here. */
export async function saveBusinessInfo(actor: Actor | null, changes: { store_name?: string; business_tin?: string; business_address?: string }, db: Db = getPool()): Promise<void> {
  for (const key of ['business_name', 'business_tin', 'business_address'] as const) {
    const value = key === 'business_name' ? changes.store_name : changes[key]
    if (value === undefined) continue
    await db.query(
      `INSERT INTO system_settings (setting_key, setting_value, description) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
      [key, value, SETTING_DESCRIPTIONS[key]],
    )
  }
  if (actor) await logAudit({ user_id: actor.user_id, session_id: actor.session_id, terminal_id: actor.terminal_id, ip_address: actor.ip_address, action: 'UPDATE_BUSINESS_INFO', module: 'SETTINGS', details: changes }, db)
}

/** Discount percent a cashier may give without the owner's PIN (system_settings.discount_threshold, 20 by default). */
export async function discountThreshold(db: Db = getPool()): Promise<number> {
  const [rows] = await db.query<RowDataPacket[]>("SELECT setting_value FROM system_settings WHERE setting_key = 'discount_threshold'")
  const percent = Number(rows[0]?.setting_value)
  return Number.isFinite(percent) && percent >= 0 ? percent : 20
}

export async function vatRate(db: Db = getPool()): Promise<number> {
  const [rows] = await db.query<RowDataPacket[]>("SELECT setting_value FROM system_settings WHERE setting_key = 'vat_rate'")
  const percent = Number(rows[0]?.setting_value)
  return Number.isFinite(percent) && percent >= 0 ? percent / 100 : 0.12
}

/**
 * The owner's session on PC-00, opened on first use and kept open. Sales the owner rings up on the
 * server PC are recorded against it (transactions always need a session and a terminal).
 */
export async function ownerSession(connection: PoolConnection, ownerId: number): Promise<number> {
  const find = async () => {
    const [rows] = await connection.query<RowDataPacket[]>('SELECT session_id FROM sessions WHERE user_id = ? AND terminal_id = ? AND is_active = TRUE', [
      ownerId,
      SYSTEM_TERMINAL_ID,
    ])
    return rows[0]?.session_id as number | undefined
  }
  const existing = await find()
  if (existing) return existing
  try {
    const [result] = await connection.execute<ResultSetHeader>('INSERT INTO sessions (user_id, terminal_id, assigned_by, login_time) VALUES (?, ?, ?, NOW())', [
      ownerId,
      SYSTEM_TERMINAL_ID,
      ownerId,
    ])
    return result.insertId
  } catch (error) {
    // Two owner requests at once: the other one opened it.
    const raced = await find()
    if (raced) return raced
    throw error
  }
}

/**
 * Changes a product's stock across its inventory batches and records each change in inventory_adjustments.
 * Removals take the soonest-expiring batch first and stop at zero (like the UI). Returns the first batch touched.
 */
export async function changeStock(
  connection: PoolConnection,
  productId: number,
  delta: number,
  log: {
    user_id: number
    session_id: number | null
    type: 'sale' | 'receive' | 'waste' | 'adjustment' | 'void_return'
    reason: string
    reference_id?: number | null
    /** Refuse to remove more than is on hand (stock never goes below zero). Without it, removals just stop at zero. */
    strict?: { productName: string }
  },
): Promise<number> {
  let [batches] = await connection.query<RowDataPacket[]>(
    `SELECT inventory_id, quantity_on_hand FROM inventory WHERE product_id = ?
      ORDER BY expiry_date IS NULL, expiry_date, inventory_id FOR UPDATE`,
    [productId],
  )
  if (!batches.length) {
    const [created] = await connection.execute<ResultSetHeader>('INSERT INTO inventory (product_id, quantity_on_hand) VALUES (?, 0)', [productId])
    batches = [{ inventory_id: created.insertId, quantity_on_hand: 0 } as RowDataPacket]
  }
  const record = (inventoryId: number, change: number) =>
    connection.execute(
      'INSERT INTO inventory_adjustments (inventory_id, user_id, session_id, quantity_change, reason, adjustment_type, reference_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [inventoryId, log.user_id, log.session_id, change, log.reason.slice(0, 255), log.type, log.reference_id ?? null],
    )

  if (delta >= 0) {
    // Additions go to the newest batch.
    const target = batches[batches.length - 1]
    if (delta > 0) {
      await connection.execute('UPDATE inventory SET quantity_on_hand = quantity_on_hand + ? WHERE inventory_id = ?', [delta, target.inventory_id])
      await record(target.inventory_id, delta)
    }
    return target.inventory_id
  }

  let remaining = -delta
  if (log.strict) {
    const available = batches.reduce((sum, batch) => sum + Math.max(0, Number(batch.quantity_on_hand)), 0)
    if (available < remaining) {
      throw HttpError.conflict(available > 0 ? `Only ${available} ${log.strict.productName} in stock` : `${log.strict.productName} is out of stock`, { product_id: productId, available })
    }
  }
  for (const batch of batches) {
    if (remaining <= 0) break
    const take = Math.min(remaining, Math.max(0, Number(batch.quantity_on_hand)))
    if (take <= 0) continue
    await connection.execute('UPDATE inventory SET quantity_on_hand = quantity_on_hand - ? WHERE inventory_id = ?', [take, batch.inventory_id])
    await record(batch.inventory_id, -take)
    remaining -= take
  }
  return batches[0].inventory_id
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function loadProducts(db: Db = getPool(), productId?: number) {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT p.product_id, p.barcode, p.product_code, p.product_name, p.category, p.supplier_name, p.unit_of_measure,
            p.unit_price, p.cost_price, p.reorder_level, p.lead_time_days, p.is_active, p.senior_pwd_eligible,
            p.promo_percent, DATE_FORMAT(p.promo_start, '%Y-%m-%d') AS promo_start, DATE_FORMAT(p.promo_end, '%Y-%m-%d') AS promo_end,
            (p.promo_percent IS NOT NULL AND CURDATE() BETWEEN p.promo_start AND p.promo_end) AS promo_running,
            COALESCE(SUM(i.quantity_on_hand), 0) AS stock,
            MIN(CASE WHEN i.quantity_on_hand > 0 THEN i.expiry_date END) AS expiry
       FROM products p LEFT JOIN inventory i ON i.product_id = p.product_id
      WHERE p.deleted_at IS NULL ${productId ? 'AND p.product_id = ?' : ''}
      GROUP BY p.product_id
      ORDER BY p.product_name`,
    productId ? [productId] : [],
  )
  // In-stock batches in the order they are sold (soonest expiry first), so the POS can price a batch markdown.
  const [batchRows] = await db.query<RowDataPacket[]>(
    `SELECT inventory_id, product_id, quantity_on_hand, markdown_percent FROM inventory
      WHERE quantity_on_hand > 0 ${productId ? 'AND product_id = ?' : ''} ORDER BY product_id, expiry_date IS NULL, expiry_date, inventory_id`,
    productId ? [productId] : [],
  )
  const batchesOf = new Map<number, { qty: number; markdownPercent: number }[]>()
  for (const b of batchRows) batchesOf.set(b.product_id, [...(batchesOf.get(b.product_id) ?? []), { qty: Number(b.quantity_on_hand), markdownPercent: Number(b.markdown_percent ?? 0) }])
  return rows.map((row) => ({
    id: `p${row.product_id}`,
    sku: row.product_code ?? '',
    barcode: row.barcode ?? '',
    name: row.product_name as string,
    category: row.category ?? 'Uncategorized',
    supplierName: (row.supplier_name as string | null) ?? null,
    unit: row.unit_of_measure ?? 'pc',
    price: Number(row.unit_price),
    cost: Number(row.cost_price ?? 0),
    stock: Number(row.stock),
    reorderPoint: Number(row.reorder_level ?? 0),
    leadTimeDays: Number(row.lead_time_days ?? 3),
    expiry: toIso(row.expiry),
    active: Boolean(row.is_active),
    seniorPwdEligible: Boolean(row.senior_pwd_eligible),
    batches: batchesOf.get(row.product_id as number) ?? [],
    promo: row.promo_percent === null || !row.promo_start || !row.promo_end ? null : { percent: Number(row.promo_percent), start: row.promo_start as string, end: row.promo_end as string },
    /** Percent off right now (0 when there is no promo or it is outside its dates). */
    promoPercent: Number(row.promo_running) ? Number(row.promo_percent) : 0,
  }))
}

/** Receipts with their items and refunds, shaped like the UI's Transaction. */
async function loadTransactions(db: Db, where: string, params: unknown[]) {
  const [txns] = await db.query<RowDataPacket[]>(`SELECT t.* FROM transactions t WHERE ${where} ORDER BY t.transaction_date, t.transaction_id`, params)
  if (!txns.length) return []
  const ids = txns.map((t) => t.transaction_id)
  const [items] = await db.query<RowDataPacket[]>('SELECT * FROM transaction_items WHERE transaction_id IN (?) ORDER BY transaction_item_id', [ids])
  const [refundRows] = await db.query<RowDataPacket[]>(
    `SELECT r.refund_id, r.transaction_id, r.reason, r.refund_amount, r.refunded_at, r.processed_by,
            ri.product_id, ri.quantity, ri.amount, ri.restocked
       FROM refunds r JOIN refund_items ri ON ri.refund_id = r.refund_id
      WHERE r.transaction_id IN (?) ORDER BY r.refund_id, ri.refund_item_id`,
    [ids],
  )
  const refundsByTxn = new Map<number, Map<number, { id: string; date: string; lines: { productId: string; qty: number; amount: number }[]; reason: string; restocked: boolean; amount: number; by: string }>>()
  for (const row of refundRows) {
    const byId = refundsByTxn.get(row.transaction_id) ?? new Map()
    refundsByTxn.set(row.transaction_id, byId)
    const refund = byId.get(row.refund_id) ?? {
      id: `r${row.refund_id}`, date: toIso(row.refunded_at) ?? '', lines: [], reason: row.reason, restocked: Boolean(row.restocked), amount: Number(row.refund_amount), by: `u${row.processed_by}`,
    }
    refund.lines.push({ productId: `p${row.product_id}`, qty: Number(row.quantity), amount: Number(row.amount) })
    byId.set(row.refund_id, refund)
  }
  const itemsByTxn = new Map<number, RowDataPacket[]>()
  for (const item of items) itemsByTxn.set(item.transaction_id, [...(itemsByTxn.get(item.transaction_id) ?? []), item])

  return txns.map((t) => {
    const customerType = CUSTOMER_TO_UI[t.customer_type as keyof typeof CUSTOMER_TO_UI] ?? 'Regular'
    const gross = Number(t.subtotal)
    const vatExempt = Number(t.vat_exempt_sales)
    const vatable = Number(t.vatable_sales ?? 0)
    const method = PAYMENT_TO_UI[t.payment_method as keyof typeof PAYMENT_TO_UI] ?? 'Cash'
    return {
      id: `t${t.transaction_id}`,
      number: t.receipt_number as string,
      date: toIso(t.transaction_date) ?? '',
      cashierId: `u${t.cashier_id}`,
      terminalId: t.terminal_id as string,
      customerType,
      seniorPwdId: (t.senior_pwd_id as string | null) ?? null,
      seniorPwdName: (t.senior_pwd_name as string | null) ?? null,
      discountPercent: t.discount_percent === null || t.discount_percent === undefined ? null : Number(t.discount_percent),
      reprintCount: Number(t.reprint_count ?? 0),
      lines: (itemsByTxn.get(t.transaction_id) ?? []).map((item) => ({ productId: `p${item.product_id}`, name: item.product_name, qty: Number(item.quantity), price: Number(item.unit_price),
        discountPercent: item.discount_percent === null || item.discount_percent === undefined ? null : Number(item.discount_percent),
        net: item.net_amount === null || item.net_amount === undefined ? null : Number(item.net_amount) })),
      gross,
      lessVat: customerType === 'Regular' ? 0 : round2(gross - vatable - Number(t.tax_amount ?? 0) - vatExempt),
      discount: Number(t.discount_total ?? 0),
      vat: Number(t.tax_amount ?? 0),
      vatExempt,
      total: Number(t.total_amount),
      payment: { method, tendered: Number(t.amount_received ?? t.total_amount), change: Number(t.change_given ?? 0), reference: t.payment_reference ?? undefined },
      status: STATUS_TO_UI[t.status as keyof typeof STATUS_TO_UI] ?? 'Completed',
      refunds: [...(refundsByTxn.get(t.transaction_id)?.values() ?? [])],
    }
  })
}

export async function loadTransaction(db: Db, transactionId: number) {
  const [txn] = await loadTransactions(db, 't.transaction_id = ?', [transactionId])
  if (!txn) throw HttpError.notFound('Receipt not found')
  return txn
}

export async function loadWaste(db: Db, where = 'w.waste_date >= DATE_SUB(CURDATE(), INTERVAL 90 DAY)', params: unknown[] = []) {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT w.*, p.cost_price FROM waste_records w JOIN products p ON p.product_id = w.product_id WHERE ${where} ORDER BY w.waste_date, w.waste_id`,
    params,
  )
  return rows.map((row) => ({
    id: `w${row.waste_id}`,
    productId: `p${row.product_id}`,
    qty: Number(row.quantity),
    reason: WASTE_TO_UI[row.reason as keyof typeof WASTE_TO_UI] ?? 'Other',
    value: round2(Number(row.quantity) * Number(row.cost_price ?? 0)),
    date: toIso(row.waste_date) ?? '',
    by: `u${row.user_id}`,
    notes: row.notes ?? '',
  }))
}

export async function loadRequests(db: Db, where = '1 = 1', params: unknown[] = []) {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT q.*, CONCAT(u.first_name, ' ', u.last_name) AS cashier_name
       FROM customer_requests q LEFT JOIN users u ON u.user_id = q.cashier_id
      WHERE ${where} ORDER BY q.request_date DESC, q.request_id DESC LIMIT 1000`,
    params,
  )
  return rows.map((row) => ({
    id: `q${row.request_id}`,
    item: row.product_name_requested as string,
    category: row.category ?? '',
    requestedBy: row.requested_by ?? row.cashier_name ?? '',
    contact: row.contact ?? '',
    date: toIso(row.request_date) ?? '',
    status: REQUEST_TO_UI[row.status as keyof typeof REQUEST_TO_UI] ?? 'New',
    notes: row.notes ?? '',
  }))
}

export async function loadEmployees(db: Db, userId?: number) {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT u.user_id, u.first_name, u.last_name, u.email, u.phone, u.is_active, u.on_leave, u.last_login, u.created_at, r.role_name,
            (SELECT MAX(s.assigned_at) FROM sessions s WHERE s.user_id = u.user_id) AS last_session,
            ls.terminal_id AS shift_terminal, ls.assigned_at AS shift_assigned_at, ls.logout_time AS shift_ended_at,
            ls.is_active AS shift_active, ls.is_paused AS shift_paused, ls.paused_at AS shift_paused_at, ls.end_reason AS shift_end_reason
       FROM users u JOIN roles r ON r.role_id = u.role_id
       LEFT JOIN sessions ls ON ls.session_id = (SELECT MAX(s2.session_id) FROM sessions s2 WHERE s2.user_id = u.user_id AND s2.terminal_id <> ?)
      ${userId ? 'WHERE u.user_id = ?' : ''}
      ORDER BY u.user_id`,
    userId ? [SYSTEM_TERMINAL_ID, userId] : [SYSTEM_TERMINAL_ID],
  )
  return rows.map((row) => ({
    id: `u${row.user_id}`,
    name: `${row.first_name} ${row.last_name}`.trim(),
    email: row.email ?? row.phone ?? '',
    role: row.role_name === 'Owner' ? ('Owner' as const) : ('Cashier' as const),
    status: !row.is_active ? ('Inactive' as const) : row.on_leave ? ('On leave' as const) : ('Active' as const),
    lastActive: toIso([row.last_login, row.last_session].filter(Boolean).sort().pop() ?? row.created_at) ?? '',
    // The cashier's latest shift on a real terminal: on it now, paused, or ended (and when, and by whom).
    shift: row.role_name === 'Owner' || !row.shift_terminal ? null : {
      state: row.shift_active ? (row.shift_paused ? ('paused' as const) : ('on' as const)) : ('ended' as const),
      terminal: row.shift_terminal as string,
      startedAt: toIso(row.shift_assigned_at),
      pausedAt: row.shift_active && row.shift_paused ? toIso(row.shift_paused_at) : null,
      endedAt: row.shift_active ? null : toIso(row.shift_ended_at),
      endedBy: row.shift_active ? null : row.shift_end_reason === 'cashier_logout' ? ('cashier' as const) : ('owner' as const),
    },
  }))
}

export type PurchaseOrderStatusUi = 'Pending' | 'Partially received' | 'Completed' | 'Cancelled'
export const PO_TO_UI: Record<string, PurchaseOrderStatusUi> = { pending: 'Pending', partially_received: 'Partially received', completed: 'Completed', cancelled: 'Cancelled' }
export const PO_TO_DB: Record<PurchaseOrderStatusUi, string> = { Pending: 'pending', 'Partially received': 'partially_received', Completed: 'completed', Cancelled: 'cancelled' }

/** Purchase orders with their lines. `where` is plain SQL over `po` (purchase_orders); `params` are its values. */
export async function loadPurchaseOrders(db: Db, where = "po.status IN ('pending', 'partially_received')", params: unknown[] = []) {
  const [orders] = await db.query<RowDataPacket[]>(
    `SELECT po.po_id, po.po_number, po.reorder_list_id, po.supplier, po.expected_delivery, po.status, po.created_at, po.completed_at, po.notes, po.cancel_reason,
            CONCAT(u.first_name, ' ', u.last_name) AS created_by_name
       FROM purchase_orders po JOIN users u ON u.user_id = po.created_by
      WHERE ${where} ORDER BY po.po_id DESC`,
    params,
  )
  if (!orders.length) return []
  const [items] = await db.query<RowDataPacket[]>(
    `SELECT i.po_item_id, i.po_id, i.product_id, i.ordered_quantity, i.received_quantity, i.unit_cost, p.product_name, p.unit_of_measure
       FROM purchase_order_items i JOIN products p ON p.product_id = i.product_id
      WHERE i.po_id IN (?) ORDER BY i.po_item_id`,
    [orders.map((o) => o.po_id)],
  )
  return orders.map((o) => {
    const lines = items.filter((i) => i.po_id === o.po_id).map((i) => ({
      itemId: Number(i.po_item_id),
      productId: `p${i.product_id}`,
      name: i.product_name as string,
      unit: (i.unit_of_measure as string | null) ?? 'pc',
      qty: Number(i.ordered_quantity),
      received: Number(i.received_quantity),
      cost: Number(i.unit_cost ?? 0),
    }))
    return {
      id: `po${o.po_id}`,
      number: o.po_number as string,
      supplierId: (o.supplier as string | null) ?? '',
      created: toIso(o.created_at) ?? '',
      expected: o.expected_delivery ? String(o.expected_delivery).slice(0, 10) : '',
      status: PO_TO_UI[o.status as string] ?? 'Pending',
      lines,
      source: o.reorder_list_id ? ('AI suggestion' as const) : ('Manual' as const),
      reorderListId: o.reorder_list_id ? `rl${o.reorder_list_id}` : null,
      notes: (o.notes as string | null) ?? '',
      cancelReason: (o.cancel_reason as string | null) ?? null,
      completedAt: o.completed_at ? toIso(o.completed_at) : null,
      createdBy: o.created_by_name as string,
      total: round2(lines.reduce((sum, l) => sum + l.qty * l.cost, 0)),
    }
  })
}

/** Daily units per product for the 12 weeks before the itemised receipts, oldest first (like mockData history). */
async function loadHistory(db: Db) {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ti.product_id, DATEDIFF(CURDATE(), DATE(t.transaction_date)) AS days_ago, SUM(ti.quantity) AS units
       FROM transaction_items ti JOIN transactions t ON t.transaction_id = ti.transaction_id
      WHERE t.status <> 'voided'
        AND t.transaction_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
        AND t.transaction_date < DATE_SUB(CURDATE(), INTERVAL ? DAY)
      GROUP BY ti.product_id, days_ago`,
    [HISTORY_DAYS - 1, DETAIL_DAYS - 1],
  )
  const length = HISTORY_DAYS - DETAIL_DAYS
  const history: Record<string, number[]> = {}
  for (const row of rows) {
    const key = `p${row.product_id}`
    history[key] ??= new Array(length).fill(0)
    const index = HISTORY_DAYS - 1 - Number(row.days_ago)
    if (index >= 0 && index < length) history[key][index] = Number(row.units)
  }
  return history
}

/** Everything the workspace screens show, in one request. */
export async function loadSnapshot() {
  const db = getPool()
  const [products, transactions, history, waste, requests, employees, rate, business, threshold, purchaseOrders] = await Promise.all([
    loadProducts(db),
    loadTransactions(db, 't.transaction_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)', [DETAIL_DAYS - 1]),
    loadHistory(db),
    loadWaste(db),
    loadRequests(db),
    loadEmployees(db),
    vatRate(db),
    businessInfo(db),
    discountThreshold(db),
    loadPurchaseOrders(db),
  ])
  return {
    products, transactions, history, waste, requests, employees, purchaseOrders, vatRate: rate,
    storeName: business.name, storeTin: business.tin, storeAddress: business.address, discountThreshold: threshold,
    serverTime: new Date().toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Sales, voids and refunds
// ---------------------------------------------------------------------------

/**
 * The next receipt number, e.g. INV-2026-000123. The year's counter row is locked until the sale commits, so two
 * terminals can't get the same number, and a sale that fails and rolls back doesn't use one up.
 */
async function nextReceiptNumber(connection: PoolConnection): Promise<string> {
  const [clock] = await connection.query<RowDataPacket[]>('SELECT YEAR(NOW()) AS year')
  const year = Number(clock[0].year)
  const lockRow = async () => {
    const [rows] = await connection.query<RowDataPacket[]>('SELECT last_number FROM receipt_counters WHERE counter_year = ? FOR UPDATE', [year])
    return rows[0] as RowDataPacket | undefined
  }
  let row = await lockRow()
  if (!row) {
    // First sale of the year. INSERT IGNORE so a terminal that loses the race just uses the other one's row.
    await connection.execute('INSERT IGNORE INTO receipt_counters (counter_year, last_number) VALUES (?, 0)', [year])
    row = await lockRow()
  }
  const next = Number(row?.last_number ?? 0) + 1
  await connection.execute('UPDATE receipt_counters SET last_number = ? WHERE counter_year = ?', [next, year])
  const [prefixRow] = await connection.query<RowDataPacket[]>("SELECT setting_value FROM system_settings WHERE setting_key = 'receipt_prefix'")
  const prefix = String(prefixRow[0]?.setting_value ?? '').trim().replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'INV'
  return `${prefix}-${year}-${String(next).padStart(6, '0')}`
}

/** Adds to the accumulated grand total. Always the LAST write of a sale/void/refund, so concurrent ones lock rows in the same order. */
async function addToGrandTotal(connection: PoolConnection, column: 'accumulated_total' | 'accumulated_voids' | 'accumulated_refunds', amount: number): Promise<number> {
  await connection.execute(`UPDATE grand_total SET ${column} = COALESCE(${column}, 0) + ? WHERE id = 1`, [amount])
  const [rows] = await connection.query<RowDataPacket[]>('SELECT accumulated_total FROM grand_total WHERE id = 1')
  return Number(rows[0]?.accumulated_total ?? 0)
}

export interface SaleInput {
  /** `discount_percent` is the cashier's discount on that item only (Regular customers). */
  lines: { product_id: number; qty: number; discount_percent?: number | null }[]
  customer_type: CustomerType
  senior_pwd_id?: string | null
  senior_pwd_name?: string | null
  payment_method: PaymentMethodUi
  amount_received: number
  payment_reference?: string | null
  /** Discount in percent for every line that has none of its own (Regular sales). Above the store's threshold it needs `discount_override_id`. */
  discount_percent?: number | null
  /** From POST /api/pos/discount/verify: the owner's PIN approval for this discount. Used once. */
  discount_override_id?: number | null
}

/** How long an owner's discount approval stays valid for ringing up the sale. */
export const DISCOUNT_APPROVAL_MINUTES = 15

/** Checks the owner approval sent with a discounted sale. Returns the override row to attach to the receipt. */
async function checkDiscountApproval(connection: PoolConnection, actor: Actor, percent: number, overrideId: number | null | undefined, threshold: number): Promise<number | null> {
  if (percent <= threshold) return null
  if (!overrideId) throw new HttpError(403, `A discount above ${threshold}% needs the owner's PIN`, { code: 'OWNER_PIN_REQUIRED', threshold })
  const [rows] = await connection.query<RowDataPacket[]>(
    `SELECT override_id, session_id, requested_by, action_type, reference_id, details,
            override_time >= DATE_SUB(NOW(), INTERVAL ? MINUTE) AS fresh
       FROM supervisor_overrides WHERE override_id = ? FOR UPDATE`,
    [DISCOUNT_APPROVAL_MINUTES, overrideId],
  )
  const override = rows[0]
  const approvedPercent = override ? Number((typeof override.details === 'string' ? JSON.parse(override.details) : override.details)?.percent) : NaN
  if (!override || override.action_type !== 'discount' || override.session_id !== actor.session_id || override.requested_by !== actor.user_id || override.reference_id !== null) {
    throw new HttpError(403, "That discount approval can't be used for this sale. Ask the owner to approve it again.", { code: 'OWNER_PIN_REQUIRED', threshold })
  }
  if (!override.fresh) throw new HttpError(403, `The owner's approval expired (it is good for ${DISCOUNT_APPROVAL_MINUTES} minutes). Ask the owner to approve it again.`, { code: 'OWNER_PIN_REQUIRED', threshold })
  if (!(approvedPercent >= percent)) throw new HttpError(403, `The owner approved ${approvedPercent}%, not ${percent}%`, { code: 'OWNER_PIN_REQUIRED', threshold })
  return override.override_id as number
}

/**
 * Peso amount of batch markdown on `qty` units of a product: walks the batches in the order stock is taken
 * (soonest expiry first) and applies each batch's markdown_percent to the units that come out of it.
 */
async function batchMarkdown(connection: PoolConnection, productId: number, qty: number, price: number): Promise<number> {
  const [batches] = await connection.query<RowDataPacket[]>(
    'SELECT quantity_on_hand, markdown_percent FROM inventory WHERE product_id = ? AND quantity_on_hand > 0 ORDER BY expiry_date IS NULL, expiry_date, inventory_id FOR UPDATE',
    [productId],
  )
  let remaining = qty
  let amount = 0
  for (const batch of batches) {
    if (remaining <= 0) break
    const take = Math.min(remaining, Number(batch.quantity_on_hand))
    amount += take * price * (Number(batch.markdown_percent ?? 0) / 100)
    remaining -= take
  }
  return round2(amount)
}

/** Records a sale at the server's prices, takes the items out of stock, and returns the receipt. */
export async function createSale(actor: Actor, input: SaleInput) {
  if (input.customer_type !== 'Regular' && (!input.senior_pwd_id?.trim() || !input.senior_pwd_name?.trim())) {
    throw HttpError.badRequest(`${input.customer_type} sales need the ID number and name on the ${input.customer_type === 'PWD' ? 'PWD' : 'Senior Citizen'} ID`)
  }
  const defaultPercent = input.discount_percent && input.discount_percent > 0 ? round2(input.discount_percent) : 0
  const percentFor = (line: { discount_percent?: number | null }) => {
    const own = line.discount_percent && line.discount_percent > 0 ? round2(line.discount_percent) : 0
    return own || defaultPercent
  }
  if (input.customer_type !== 'Regular' && input.lines.some((line) => percentFor(line) > 0)) {
    throw HttpError.badRequest('Senior Citizen and PWD sales already get their discount by law; no extra discount can be added')
  }
  for (let attempt = 0; ; attempt++) {
    try {
      const transactionId = await withTransaction(async (connection) => {
        // One entry per product (the cart never repeats one); if it does, quantities add up and the larger discount wins.
        const quantities = new Map<number, { qty: number; percent: number }>()
        for (const line of input.lines) {
          const entry = quantities.get(line.product_id) ?? { qty: 0, percent: 0 }
          quantities.set(line.product_id, { qty: entry.qty + line.qty, percent: Math.max(entry.percent, percentFor(line)) })
        }
        const [products] = await connection.query<RowDataPacket[]>(
          'SELECT product_id, product_name, unit_price, is_active, senior_pwd_eligible, IF(promo_percent IS NOT NULL AND CURDATE() BETWEEN promo_start AND promo_end, promo_percent, 0) AS promo_now FROM products WHERE product_id IN (?) AND deleted_at IS NULL',
          [[...quantities.keys()]],
        )
        const lines: { productId: number; name: string; qty: number; price: number; discountable: boolean; manualPercent: number; discountPercent: number; discountAmount: number | undefined; markdown: boolean; promo: boolean }[] = []
        for (const [productId, { qty, percent }] of quantities) {
          const product = products.find((p) => p.product_id === productId)
          if (!product) throw HttpError.badRequest(`Product ${productId} no longer exists`)
          if (!product.is_active) throw HttpError.conflict(`${product.product_name} is no longer sold`)
          const price = Number(product.unit_price)
          const gross = round2(price * qty)
          // A batch markdown (owner-set, e.g. bread close to its date) applies to the units that come out of that batch.
          // It does not stack with the cashier's percent: the bigger saving wins. Senior/PWD sales don't use it.
          const markdown = input.customer_type === 'Regular' ? await batchMarkdown(connection, productId, qty, price) : 0
          const promoPercent = input.customer_type === 'Regular' ? Number(product.promo_now) : 0
          const promo = promoPercent > 0 ? round2(gross * (promoPercent / 100)) : 0
          const manual = percent > 0 ? round2(gross * (percent / 100)) : 0
          const amount = Math.min(gross, Math.max(manual, markdown, promo))
          const shown = amount <= 0 ? 0 : manual >= Math.max(markdown, promo) ? percent : promo >= markdown ? promoPercent : round2((amount / gross) * 100)
          lines.push({ productId, name: product.product_name as string, qty, price, discountable: Boolean(product.senior_pwd_eligible), manualPercent: percent, discountPercent: shown, discountAmount: input.customer_type === 'Regular' ? amount : undefined, markdown: markdown > Math.max(manual, promo), promo: promo > Math.max(manual, markdown) })
        }
        const biggest = Math.max(0, ...lines.map((line) => line.manualPercent))
        // Every line is below the threshold, or the owner approved at least the biggest one.
        const discountPercent = lines.length && lines.every((line) => line.discountPercent === lines[0].discountPercent) ? lines[0].discountPercent : 0
        const overrideId = biggest > 0 ? await checkDiscountApproval(connection, actor, biggest, input.discount_override_id, await discountThreshold(connection)) : null
        const totals = computeTotals(lines, input.customer_type, await vatRate(connection))
        if (input.payment_method === 'Cash' && input.amount_received + 0.001 < totals.total) throw HttpError.badRequest('Cash received is less than the total')
        const received = input.payment_method === 'Cash' ? input.amount_received : totals.total
        const receipt = await nextReceiptNumber(connection)
        const [result] = await connection.execute<ResultSetHeader>(
          `INSERT INTO transactions (receipt_number, cashier_id, session_id, terminal_id, customer_type, senior_pwd_id, senior_pwd_name,
             subtotal, discount_total, discount_percent, vatable_sales, vat_exempt_sales, tax_amount, total_amount, payment_method, payment_reference, amount_received, change_given)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            receipt, actor.user_id, actor.session_id, actor.terminal_id, input.customer_type.toLowerCase(),
            input.customer_type === 'Regular' ? null : input.senior_pwd_id!.trim(), input.customer_type === 'Regular' ? null : input.senior_pwd_name!.trim(),
            totals.gross, totals.discount, discountPercent || null, input.customer_type === 'Regular' ? round2(totals.total - totals.vat) : round2(totals.total - (totals.vatExempt - totals.discount) - totals.vat), totals.vatExempt, totals.vat, totals.total,
            PAYMENT_TO_DB[input.payment_method], input.payment_reference?.trim() || null, received, round2(Math.max(0, received - totals.total)),
          ],
        )
        const transactionIdNew = result.insertId
        for (const [index, line] of lines.entries()) {
          await connection.execute(
            'INSERT INTO transaction_items (transaction_id, product_id, product_name, quantity, unit_price, subtotal, discount_percent, net_amount) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [transactionIdNew, line.productId, line.name, line.qty, line.price, round2(line.price * line.qty), input.customer_type === 'Regular' && line.discountPercent > 0 ? line.discountPercent : null, totals.lineNets[index]],
          )
          await changeStock(connection, line.productId, -line.qty, {
            user_id: actor.user_id, session_id: actor.session_id, type: 'sale', reason: receipt, reference_id: transactionIdNew, strict: { productName: line.name },
          })
        }
        // The owner's approval belongs to this receipt now and can't be used again.
        if (overrideId) await connection.execute('UPDATE supervisor_overrides SET reference_id = ? WHERE override_id = ?', [transactionIdNew, overrideId])
        const grandTotal = await addToGrandTotal(connection, 'accumulated_total', totals.total)
        await connection.execute('UPDATE transactions SET grand_total_after = ? WHERE transaction_id = ?', [grandTotal, transactionIdNew])
        await logAudit({
          user_id: actor.user_id, session_id: actor.session_id, terminal_id: actor.terminal_id, ip_address: actor.ip_address, action: 'SALE', module: 'POS',
          details: { receipt, total: totals.total, ...(biggest ? { discount_percent_max: biggest, items_discounted: lines.filter((l) => l.discountPercent > 0).length, approved_override: overrideId } : {}), ...(lines.some((l) => l.markdown) ? { batch_markdown_items: lines.filter((l) => l.markdown).length } : {}), ...(lines.some((l) => l.promo) ? { promo_items: lines.filter((l) => l.promo).length } : {}) },
        }, connection)
        return transactionIdNew
      })
      return await loadTransaction(getPool(), transactionId)
    } catch (error) {
      // Two terminals took the same receipt number at once, or MySQL picked this sale as the loser of a lock cycle: try again.
      const code = (error as { code?: string }).code
      if ((code === 'ER_DUP_ENTRY' || code === 'ER_LOCK_DEADLOCK') && attempt < 3) continue
      throw error
    }
  }
}

async function recordOverride(connection: PoolConnection, actor: Actor, approval: OwnerApproval, action: 'void' | 'refund', transactionId: number, reason: string, details: unknown) {
  const [result] = await connection.execute<ResultSetHeader>(
    'INSERT INTO supervisor_overrides (session_id, terminal_id, requested_by, approved_by, action_type, reference_id, details, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [actor.session_id, actor.terminal_id, actor.user_id, approval.owner_id, action, transactionId, JSON.stringify(details), reason.slice(0, 255)],
  )
  return result.insertId
}

/**
 * Cancels a whole sale (owner PIN required) and puts every item back in stock.
 * The accumulated grand total is NOT reduced: the void is added to accumulated_voids instead.
 */
export async function voidSale(actor: Actor, approval: OwnerApproval, transactionId: number, reason: string) {
  await withTransaction(async (connection) => {
    const [rows] = await connection.query<RowDataPacket[]>('SELECT receipt_number, status, total_amount FROM transactions WHERE transaction_id = ? FOR UPDATE', [transactionId])
    const txn = rows[0]
    if (!txn) throw HttpError.notFound('Receipt not found')
    if (txn.status !== 'completed') throw HttpError.conflict(`${txn.receipt_number} can't be voided because it is ${String(txn.status).replace('_', ' ')}`)
    const [items] = await connection.query<RowDataPacket[]>('SELECT product_id, quantity FROM transaction_items WHERE transaction_id = ?', [transactionId])
    await recordOverride(connection, actor, approval, 'void', transactionId, reason, { receipt: txn.receipt_number })
    await connection.execute("UPDATE transactions SET status = 'voided', voided_by = ?, void_reason = ?, voided_at = NOW() WHERE transaction_id = ?", [
      approval.owner_id, reason.slice(0, 255) || null, transactionId,
    ])
    for (const item of items) {
      await changeStock(connection, item.product_id, Number(item.quantity), { user_id: actor.user_id, session_id: actor.session_id, type: 'void_return', reason: `Void ${txn.receipt_number}`, reference_id: transactionId })
    }
    await addToGrandTotal(connection, 'accumulated_voids', Number(txn.total_amount))
    await logAudit({ user_id: actor.user_id, session_id: actor.session_id, terminal_id: actor.terminal_id, ip_address: actor.ip_address, action: 'VOID_SALE', module: 'POS', details: { receipt: txn.receipt_number, approved_by: approval.owner_id, reason } }, connection)
  })
  return loadTransaction(getPool(), transactionId)
}

/** Returns some or all items of a sale (owner PIN required): back to stock, or written off as waste. */
export async function refundSale(actor: Actor, approval: OwnerApproval, transactionId: number, input: { lines: { product_id: number; qty: number }[]; reason: string; restock: boolean }) {
  await withTransaction(async (connection) => {
    const [rows] = await connection.query<RowDataPacket[]>('SELECT * FROM transactions WHERE transaction_id = ? FOR UPDATE', [transactionId])
    const txn = rows[0]
    if (!txn) throw HttpError.notFound('Receipt not found')
    if (txn.status === 'voided' || txn.status === 'refunded') throw HttpError.conflict(`${txn.receipt_number} is already ${txn.status}`)
    const [items] = await connection.query<RowDataPacket[]>(
      `SELECT ti.transaction_item_id, ti.product_id, ti.quantity, ti.unit_price, ti.net_amount,
              COALESCE((SELECT SUM(ri.quantity) FROM refund_items ri WHERE ri.transaction_item_id = ti.transaction_item_id), 0) AS returned
         FROM transaction_items ti WHERE ti.transaction_id = ?`,
      [transactionId],
    )
    const ratio = Number(txn.subtotal) ? Number(txn.total_amount) / Number(txn.subtotal) : 1
    const lines = input.lines.filter((line) => line.qty > 0).map((line) => {
      const item = items.find((i) => i.product_id === line.product_id)
      if (!item) throw HttpError.badRequest('That item is not on this receipt')
      if (line.qty > Number(item.quantity) - Number(item.returned)) throw HttpError.conflict('Cannot return more than was sold')
      // New receipts remember what each line really cost after discounts; older ones share the discount in proportion.
      const amount = item.net_amount !== null && item.net_amount !== undefined
        ? round2((Number(item.net_amount) * line.qty) / Number(item.quantity))
        : round2(Number(item.unit_price) * line.qty * ratio)
      return { item, qty: line.qty, amount }
    })
    if (!lines.length) throw HttpError.badRequest('Choose at least one item to return')
    const amount = round2(lines.reduce((sum, line) => sum + line.amount, 0))

    const overrideId = await recordOverride(connection, actor, approval, 'refund', transactionId, input.reason, { receipt: txn.receipt_number, amount })
    const [refund] = await connection.execute<ResultSetHeader>(
      'INSERT INTO refunds (transaction_id, session_id, terminal_id, processed_by, approved_by, override_id, reason, refund_method, refund_amount) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [transactionId, actor.session_id, actor.terminal_id, actor.user_id, approval.owner_id, overrideId, input.reason.slice(0, 255) || 'Return', txn.payment_method, amount],
    )
    for (const line of lines) {
      await connection.execute('INSERT INTO refund_items (refund_id, transaction_item_id, product_id, quantity, amount, restocked) VALUES (?, ?, ?, ?, ?, ?)', [
        refund.insertId, line.item.transaction_item_id, line.item.product_id, line.qty, line.amount, input.restock,
      ])
      if (input.restock) {
        await changeStock(connection, line.item.product_id, line.qty, { user_id: actor.user_id, session_id: actor.session_id, type: 'void_return', reason: `Refund ${txn.receipt_number}`, reference_id: refund.insertId })
      } else {
        const [batch] = await connection.query<RowDataPacket[]>('SELECT inventory_id FROM inventory WHERE product_id = ? ORDER BY inventory_id LIMIT 1', [line.item.product_id])
        const inventoryId = batch[0]?.inventory_id ?? (await changeStock(connection, line.item.product_id, 0, { user_id: actor.user_id, session_id: actor.session_id, type: 'adjustment', reason: 'Batch for write-off' }))
        await connection.execute("INSERT INTO waste_records (product_id, inventory_id, user_id, quantity, reason, notes) VALUES (?, ?, ?, ?, 'customer_return', ?)", [
          line.item.product_id, inventoryId, actor.user_id, line.qty, `${txn.receipt_number}: ${input.reason}`.slice(0, 255),
        ])
      }
    }
    const remaining = items.reduce((sum, item) => sum + Number(item.quantity) - Number(item.returned), 0) - lines.reduce((sum, line) => sum + line.qty, 0)
    await connection.execute('UPDATE transactions SET status = ? WHERE transaction_id = ?', [remaining <= 0 ? 'refunded' : 'partially_refunded', transactionId])
    await addToGrandTotal(connection, 'accumulated_refunds', amount)
    await logAudit({ user_id: actor.user_id, session_id: actor.session_id, terminal_id: actor.terminal_id, ip_address: actor.ip_address, action: 'REFUND', module: 'POS', details: { receipt: txn.receipt_number, amount, restock: input.restock, approved_by: approval.owner_id } }, connection)
  })
  return loadTransaction(getPool(), transactionId)
}

// ---------------------------------------------------------------------------
// Catalog and stock (owner)
// ---------------------------------------------------------------------------

export interface ProductInput {
  name: string
  sku?: string | null
  barcode?: string | null
  category?: string | null
  supplier_name?: string | null
  unit?: string | null
  price: number
  cost?: number | null
  reorder_point?: number | null
  lead_time_days?: number | null
  stock?: number | null
  expiry?: string | null // YYYY-MM-DD
  active?: boolean
  senior_pwd_eligible?: boolean
  promo_percent?: number | null
  promo_start?: string | null // YYYY-MM-DD
  promo_end?: string | null
}

function duplicateProduct(error: unknown): never {
  const message = String((error as { sqlMessage?: string }).sqlMessage ?? '')
  if ((error as { code?: string }).code === 'ER_DUP_ENTRY') {
    throw HttpError.conflict(message.includes('barcode') ? 'Another product already has that barcode' : 'Another product already has that SKU')
  }
  throw error
}

export async function saveProduct(actor: Actor, productId: number | null, input: ProductInput) {
  const hasPromo = Boolean(input.promo_percent && input.promo_percent > 0)
  if (hasPromo) {
    if (!input.promo_start || !input.promo_end) throw HttpError.badRequest('A promo needs a start date and an end date')
    if (input.promo_end < input.promo_start) throw HttpError.badRequest('The promo end date is before its start date')
  }
  const id = await withTransaction(async (connection) => {
    const values = [
      input.barcode?.trim() || null, input.sku?.trim() || null, input.name.trim(), input.category?.trim() || null, input.supplier_name?.trim() || null,
      input.unit?.trim() || null, input.price, input.cost ?? null, input.reorder_point ?? 10, input.lead_time_days ?? null, input.active ?? true, input.senior_pwd_eligible ?? true,
      hasPromo ? round2(input.promo_percent!) : null, hasPromo ? input.promo_start! : null, hasPromo ? input.promo_end! : null,
    ]
    let savedId = productId
    try {
      if (savedId === null) {
        const [result] = await connection.execute<ResultSetHeader>(
          `INSERT INTO products (barcode, product_code, product_name, category, supplier_name, unit_of_measure, unit_price, cost_price, reorder_level, lead_time_days, is_active, senior_pwd_eligible, promo_percent, promo_start, promo_end)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          values,
        )
        savedId = result.insertId
        await connection.execute('INSERT INTO inventory (product_id, quantity_on_hand, expiry_date) VALUES (?, 0, ?)', [savedId, input.expiry ?? null])
      } else {
        const [result] = await connection.execute<ResultSetHeader>(
          `UPDATE products SET barcode = ?, product_code = ?, product_name = ?, category = ?, supplier_name = ?, unit_of_measure = ?, unit_price = ?,
             cost_price = ?, reorder_level = ?, lead_time_days = ?, is_active = ?, senior_pwd_eligible = ?, promo_percent = ?, promo_start = ?, promo_end = ? WHERE product_id = ? AND deleted_at IS NULL`,
          [...values, savedId],
        )
        if (!result.affectedRows) throw HttpError.notFound('Product not found')
      }
    } catch (error) {
      duplicateProduct(error)
    }
    const [current] = await loadProducts(connection, savedId!)
    const [nearest] = await connection.query<RowDataPacket[]>('SELECT MIN(CASE WHEN quantity_on_hand > 0 THEN expiry_date END) AS expiry FROM inventory WHERE product_id = ?', [savedId])
    if (input.stock !== undefined && input.stock !== null && input.stock !== current.stock) {
      await changeStock(connection, savedId!, input.stock - current.stock, { user_id: actor.user_id, session_id: actor.session_id, type: 'adjustment', reason: 'Stock count from product editor' })
    }
    if (input.expiry !== undefined && (input.expiry ?? null) !== (nearest[0]?.expiry ?? null)) {
      // The nearest-expiring batch is the one the editor shows.
      await connection.execute(
        `UPDATE inventory SET expiry_date = ? WHERE inventory_id = (
           SELECT inventory_id FROM (SELECT inventory_id FROM inventory WHERE product_id = ? ORDER BY quantity_on_hand <= 0, expiry_date IS NULL, expiry_date, inventory_id LIMIT 1) AS nearest)`,
        [input.expiry ?? null, savedId],
      )
    }
    await logAudit({ user_id: actor.user_id, session_id: actor.session_id, terminal_id: actor.terminal_id, ip_address: actor.ip_address, action: productId === null ? 'CREATE_PRODUCT' : 'UPDATE_PRODUCT', module: 'INVENTORY', details: { product_id: savedId, name: input.name, price: input.price } }, connection)
    return savedId!
  })
  const [product] = await loadProducts(getPool(), id)
  return product
}

/**
 * Corrects a product's stock by a positive or negative amount (a count correction, a write-off). It never takes stock
 * below zero: asking to remove more than is on hand is refused. New deliveries go through receiveStock instead.
 */
export async function adjustProductStock(actor: Actor, productId: number, delta: number, reason: string) {
  await withTransaction(async (connection) => {
    const [rows] = await connection.query<RowDataPacket[]>('SELECT product_name FROM products WHERE product_id = ? AND deleted_at IS NULL', [productId])
    if (!rows[0]) throw HttpError.notFound('Product not found')
    await changeStock(connection, productId, delta, {
      user_id: actor.user_id, session_id: actor.session_id, type: 'adjustment', reason: reason || 'Manual adjustment', strict: { productName: rows[0].product_name as string },
    })
    await logAudit({ user_id: actor.user_id, session_id: actor.session_id, terminal_id: actor.terminal_id, ip_address: actor.ip_address, action: 'ADJUST_STOCK', module: 'INVENTORY', details: { product_id: productId, delta, reason } }, connection)
  })
  const [product] = await loadProducts(getPool(), productId)
  return product
}

export interface ReceiveInput {
  qty: number
  batch_number?: string | null
  expiry_date?: string | null // YYYY-MM-DD
  unit_cost?: number | null
  note?: string | null
}

/**
 * Books a delivery as stock in its own batch (batch number + expiry date), so the oldest-expiry batch is sold first.
 * Receiving the same batch number again (a second part of one delivery) tops that batch up; its expiry date must match.
 * A unit cost, when given, becomes the product's current cost.
 */
export async function receiveStock(actor: Actor, productId: number, input: ReceiveInput) {
  await withTransaction((connection) => receiveStockTx(connection, actor, productId, input))
  const [product] = await loadProducts(getPool(), productId)
  return product
}

/** The body of receiveStock, for callers that already hold a transaction (a purchase order delivery books several products at once). */
export async function receiveStockTx(connection: PoolConnection, actor: Actor, productId: number, input: ReceiveInput): Promise<void> {
  const batchNumber = input.batch_number?.trim() || null
  const note = input.note?.trim() || ''
  // Locking the product row makes two deliveries for it wait for each other.
  const [products] = await connection.query<RowDataPacket[]>('SELECT product_name, cost_price FROM products WHERE product_id = ? AND deleted_at IS NULL FOR UPDATE', [productId])
  const product = products[0]
  if (!product) throw HttpError.notFound('Product not found')
  if (input.expiry_date) {
    const [past] = await connection.query<RowDataPacket[]>('SELECT ? < CURDATE() AS expired', [input.expiry_date])
    if (Number(past[0].expired)) throw HttpError.badRequest('That expiry date has already passed. Check the date on the box.')
    await assertSaneExpiry(connection, input.expiry_date)
  }

  const label = `Delivery${batchNumber ? ` · batch ${batchNumber}` : ''}${note ? `: ${note}` : ''}`
  let inventoryId: number
  const existing = batchNumber
    ? (await connection.query<RowDataPacket[]>('SELECT inventory_id, expiry_date FROM inventory WHERE product_id = ? AND batch_number = ? ORDER BY inventory_id LIMIT 1 FOR UPDATE', [productId, batchNumber]))[0][0]
    : undefined
  if (existing) {
    const currentExpiry = (existing.expiry_date as string | null)?.slice(0, 10) ?? null
    if (currentExpiry !== (input.expiry_date ?? null)) {
      throw HttpError.conflict(`Batch ${batchNumber} is already on file with ${currentExpiry ? `expiry ${currentExpiry}` : 'no expiry date'}. Use a different batch number if this is a different lot.`)
    }
    inventoryId = existing.inventory_id as number
    await connection.execute('UPDATE inventory SET quantity_on_hand = quantity_on_hand + ? WHERE inventory_id = ?', [input.qty, inventoryId])
  } else {
    const [created] = await connection.execute<ResultSetHeader>('INSERT INTO inventory (product_id, quantity_on_hand, batch_number, expiry_date) VALUES (?, ?, ?, ?)', [
      productId, input.qty, batchNumber, input.expiry_date ?? null,
    ])
    inventoryId = created.insertId
  }
  await connection.execute(
    'INSERT INTO inventory_adjustments (inventory_id, user_id, session_id, quantity_change, reason, adjustment_type) VALUES (?, ?, ?, ?, ?, ?)',
    [inventoryId, actor.user_id, actor.session_id, input.qty, label.slice(0, 255), 'receive'],
  )
  const costChanged = input.unit_cost !== undefined && input.unit_cost !== null && Number(product.cost_price ?? 0) !== input.unit_cost
  if (costChanged) await connection.execute('UPDATE products SET cost_price = ? WHERE product_id = ?', [input.unit_cost ?? null, productId])
  await logAudit({
    user_id: actor.user_id, session_id: actor.session_id, terminal_id: actor.terminal_id, ip_address: actor.ip_address, action: 'RECEIVE_STOCK', module: 'INVENTORY',
    details: { product_id: productId, qty: input.qty, batch_number: batchNumber, expiry_date: input.expiry_date ?? null, ...(costChanged ? { old_cost: Number(product.cost_price ?? 0), new_cost: input.unit_cost } : {}) },
  }, connection)
}

/**
 * Removes a product from the catalog, the POS and the reports' product lists. The row stays (old receipts and stock movements
 * point at it); its barcode and SKU are freed so they can be used again. Only a product with nothing on hand can be deleted.
 */
export async function deleteProduct(actor: Actor, productId: number) {
  await withTransaction(async (connection) => {
    const [rows] = await connection.query<RowDataPacket[]>(
      `SELECT p.product_name, p.barcode, p.product_code, COALESCE((SELECT SUM(i.quantity_on_hand) FROM inventory i WHERE i.product_id = p.product_id), 0) AS stock
         FROM products p WHERE p.product_id = ? AND p.deleted_at IS NULL FOR UPDATE`,
      [productId],
    )
    const product = rows[0]
    if (!product) throw HttpError.notFound('Product not found')
    if (Number(product.stock) > 0) throw HttpError.conflict(`${product.product_name} still has ${Number(product.stock)} on hand. Write it off or adjust the stock to zero before deleting it.`)
    await connection.execute('UPDATE products SET deleted_at = NOW(), is_active = FALSE, barcode = NULL, product_code = NULL WHERE product_id = ?', [productId])
    await logAudit({
      user_id: actor.user_id, session_id: actor.session_id, terminal_id: actor.terminal_id, ip_address: actor.ip_address, action: 'DELETE_PRODUCT', module: 'INVENTORY',
      details: { product_id: productId, name: product.product_name, barcode: product.barcode, sku: product.product_code },
    }, connection)
  })
  return { ok: true as const, id: `p${productId}` }
}

/** A date that doesn't exist (2026-02-31) or is more than 10 years away is almost surely a typo. */
async function assertSaneExpiry(connection: PoolConnection, date: string) {
  const parsed = new Date(`${date}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) throw HttpError.badRequest(`${date} is not a real date`)
  const [far] = await connection.query<RowDataPacket[]>('SELECT ? > DATE_ADD(CURDATE(), INTERVAL 10 YEAR) AS too_far', [date])
  if (Number(far[0].too_far)) throw HttpError.badRequest(`${date} is more than 10 years away. Check the year on the box.`)
}

/** Owner fixes (or clears) the expiry date of one batch, e.g. after a typo when it was received. */
export async function setBatchExpiry(actor: Actor, inventoryId: number, expiry: string | null) {
  await withTransaction(async (connection) => {
    const [rows] = await connection.query<RowDataPacket[]>(
      `SELECT i.product_id, i.batch_number, i.expiry_date, p.product_name FROM inventory i JOIN products p ON p.product_id = i.product_id
        WHERE i.inventory_id = ? AND p.deleted_at IS NULL FOR UPDATE`,
      [inventoryId],
    )
    const batch = rows[0]
    if (!batch) throw HttpError.notFound('Batch not found')
    if (expiry) await assertSaneExpiry(connection, expiry)
    await connection.execute('UPDATE inventory SET expiry_date = ? WHERE inventory_id = ?', [expiry, inventoryId])
    await logAudit({
      user_id: actor.user_id, session_id: actor.session_id, terminal_id: actor.terminal_id, ip_address: actor.ip_address, action: 'BATCH_EXPIRY', module: 'INVENTORY',
      details: { product_id: batch.product_id, name: batch.product_name, batch_number: batch.batch_number, old_expiry: batch.expiry_date ? String(batch.expiry_date).slice(0, 10) : null, new_expiry: expiry },
    }, connection)
  })
  return { ok: true as const }
}

/** Batches of one product that still have stock, in the order they sell (soonest expiry first). */
export async function productBatches(productId: number) {
  const [rows] = await getPool().query<RowDataPacket[]>(
    `SELECT i.inventory_id, i.batch_number, i.expiry_date, i.quantity_on_hand, i.markdown_percent, DATEDIFF(i.expiry_date, CURDATE()) AS days_left
       FROM inventory i WHERE i.product_id = ? AND i.quantity_on_hand > 0
      ORDER BY i.expiry_date IS NULL, i.expiry_date, i.inventory_id`,
    [productId],
  )
  return rows.map((row) => ({
    batchId: `b${row.inventory_id}`,
    batchNumber: (row.batch_number as string | null) ?? null,
    expiry: row.expiry_date ? String(row.expiry_date).slice(0, 10) : null,
    daysLeft: row.days_left === null ? null : Number(row.days_left),
    qty: Number(row.quantity_on_hand),
    markdownPercent: row.markdown_percent === null ? null : Number(row.markdown_percent),
  }))
}

/** Owner sets (or clears, with null) a percent off for the items of one batch. The POS applies it automatically. */
export async function setBatchMarkdown(actor: Actor, inventoryId: number, percent: number | null) {
  await withTransaction(async (connection) => {
    const [rows] = await connection.query<RowDataPacket[]>(
      `SELECT i.product_id, i.batch_number, i.expiry_date, p.product_name FROM inventory i JOIN products p ON p.product_id = i.product_id
        WHERE i.inventory_id = ? AND p.deleted_at IS NULL FOR UPDATE`,
      [inventoryId],
    )
    const batch = rows[0]
    if (!batch) throw HttpError.notFound('Batch not found')
    await connection.execute('UPDATE inventory SET markdown_percent = ? WHERE inventory_id = ?', [percent && percent > 0 ? round2(percent) : null, inventoryId])
    await logAudit({
      user_id: actor.user_id, session_id: actor.session_id, terminal_id: actor.terminal_id, ip_address: actor.ip_address, action: 'BATCH_MARKDOWN', module: 'INVENTORY',
      details: { product_id: batch.product_id, name: batch.product_name, batch_number: batch.batch_number, expiry: batch.expiry_date ? String(batch.expiry_date).slice(0, 10) : null, markdown_percent: percent && percent > 0 ? round2(percent) : null },
    }, connection)
  })
  return { ok: true as const }
}

// ---------------------------------------------------------------------------
// Waste, customer requests, employees
// ---------------------------------------------------------------------------

export async function logWaste(actor: Actor, input: { product_id: number; qty: number; reason: WasteReasonUi; notes?: string | null }) {
  const wasteId = await withTransaction(async (connection) => {
    const [rows] = await connection.query<RowDataPacket[]>('SELECT product_name FROM products WHERE product_id = ? AND deleted_at IS NULL', [input.product_id])
    if (!rows[0]) throw HttpError.notFound('Product not found')
    // A write-off can't be bigger than what is on hand (409 with the available quantity).
    const inventoryId = await changeStock(connection, input.product_id, -input.qty, { user_id: actor.user_id, session_id: actor.session_id, type: 'waste', reason: input.reason, strict: { productName: rows[0].product_name as string } })
    const [result] = await connection.execute<ResultSetHeader>(
      'INSERT INTO waste_records (product_id, inventory_id, user_id, quantity, reason, notes) VALUES (?, ?, ?, ?, ?, ?)',
      [input.product_id, inventoryId, actor.user_id, input.qty, WASTE_TO_DB[input.reason], input.notes?.trim().slice(0, 255) || null],
    )
    await logAudit({ user_id: actor.user_id, session_id: actor.session_id, terminal_id: actor.terminal_id, ip_address: actor.ip_address, action: 'LOG_WASTE', module: 'INVENTORY', details: { product_id: input.product_id, qty: input.qty, reason: input.reason } }, connection)
    return result.insertId
  })
  const [entry] = await loadWaste(getPool(), 'w.waste_id = ?', [wasteId])
  const [product] = await loadProducts(getPool(), input.product_id)
  return { entry, product }
}

export async function addRequest(actor: Actor, input: { item: string; category?: string | null; requested_by?: string | null; contact?: string | null; notes?: string | null }) {
  const [result] = await getPool().execute<ResultSetHeader>(
    'INSERT INTO customer_requests (cashier_id, product_name_requested, category, requested_by, contact, notes) VALUES (?, ?, ?, ?, ?, ?)',
    [actor.user_id, input.item.trim(), input.category?.trim() || null, input.requested_by?.trim() || null, input.contact?.trim() || null, input.notes?.trim() || null],
  )
  const [request] = await loadRequests(getPool(), 'q.request_id = ?', [result.insertId])
  return request
}

export async function setRequestStatus(actor: Actor, ids: number[], status: RequestStatusUi) {
  await getPool().query('UPDATE customer_requests SET status = ?, reviewed_by = ?, reviewed_at = NOW() WHERE request_id IN (?)', [REQUEST_TO_DB[status], actor.user_id, ids])
  return loadRequests(getPool(), 'q.request_id IN (?)', [ids])
}

/** Owner edits one request: its status and/or notes. */
export async function updateRequest(actor: Actor, requestId: number, input: { status?: RequestStatusUi; notes?: string | null }) {
  const [found] = await getPool().query<RowDataPacket[]>('SELECT request_id FROM customer_requests WHERE request_id = ?', [requestId])
  if (!found[0]) throw HttpError.notFound('Request not found')
  const sets: string[] = ['reviewed_by = ?', 'reviewed_at = NOW()']
  const params: unknown[] = [actor.user_id]
  if (input.status) { sets.push('status = ?'); params.push(REQUEST_TO_DB[input.status]) }
  if (input.notes !== undefined) { sets.push('notes = ?'); params.push(input.notes?.trim() || null) }
  await getPool().execute(`UPDATE customer_requests SET ${sets.join(', ')} WHERE request_id = ?`, [...params, requestId] as never[])
  await logAudit({ user_id: actor.user_id, session_id: actor.session_id, terminal_id: actor.terminal_id, ip_address: actor.ip_address, action: 'UPDATE_REQUEST', module: 'REQUESTS', details: { request_id: requestId, status: input.status ?? null } })
  const [request] = await loadRequests(getPool(), 'q.request_id = ?', [requestId])
  return request
}

/** Splits "Juan Dela Cruz" into first "Juan" and last "Dela Cruz" for the users table. */
export function splitName(name: string): { first: string; last: string } {
  const parts = name.trim().split(/\s+/)
  if (parts.length === 1) return { first: parts[0], last: '' }
  // Filipino surnames often start with a particle: Dela Cruz, De Leon, Del Rosario, San Jose, Santa Maria.
  const particles = new Set(['de', 'dela', 'del', 'delos', 'de los', 'san', 'santa', 'sta.', 'sto.', 'santo', 'la', 'van', 'von', 'di', 'da'])
  let start = parts.length - 1
  while (start > 1 && particles.has(parts[start - 1].toLowerCase())) start--
  return { first: parts.slice(0, start).join(' '), last: parts.slice(start).join(' ') }
}

export async function saveEmployee(actor: Actor, userId: number | null, input: { name: string; email?: string | null; status: 'Active' | 'On leave' | 'Inactive' }) {
  const { first, last } = splitName(input.name)
  const email = input.email?.trim() || null
  const isActive = input.status !== 'Inactive'
  const onLeave = input.status === 'On leave'
  let endedOn: string | null = null
  const id = await withTransaction(async (connection) => {
    let savedId = userId
    if (savedId === null) {
      const [role] = await connection.query<RowDataPacket[]>("SELECT role_id FROM roles WHERE role_name = 'Cashier'")
      const [result] = await connection.execute<ResultSetHeader>('INSERT INTO users (role_id, first_name, last_name, email, is_active, on_leave) VALUES (?, ?, ?, ?, ?, ?)', [
        role[0].role_id, first, last, email, isActive, onLeave,
      ])
      savedId = result.insertId
    } else {
      const [rows] = await connection.query<RowDataPacket[]>('SELECT r.role_name FROM users u JOIN roles r ON r.role_id = u.role_id WHERE u.user_id = ? FOR UPDATE', [savedId])
      if (!rows[0]) throw HttpError.notFound('Employee not found')
      if (rows[0].role_name === 'Owner' && !isActive) throw HttpError.conflict("The owner account can't be deactivated here")
      if (!isActive) endedOn = await endActiveShifts(connection, actor, savedId, 'deactivated')
      await connection.execute('UPDATE users SET first_name = ?, last_name = ?, email = ?, is_active = ?, on_leave = ? WHERE user_id = ?', [first, last, email, isActive, onLeave, savedId])
    }
    await logAudit({ user_id: actor.user_id, session_id: actor.session_id, terminal_id: actor.terminal_id, ip_address: actor.ip_address, action: userId === null ? 'CREATE_EMPLOYEE' : 'UPDATE_EMPLOYEE', module: 'ADMIN', details: { employee_id: savedId, name: input.name, status: input.status } }, connection)
    return savedId!
  })
  const [employee] = await loadEmployees(getPool(), id)
  // endedShiftOn: the terminal that was locked because this cashier was deactivated while on shift.
  return { ...employee, endedShiftOn: endedOn }
}

/** Ends the cashier's open shift (if any) so their terminal locks on its next poll. Returns the terminal it was on. */
async function endActiveShifts(connection: PoolConnection, actor: Actor, userId: number, reason: string): Promise<string | null> {
  const [open] = await connection.query<RowDataPacket[]>('SELECT session_id, terminal_id FROM sessions WHERE user_id = ? AND is_active = TRUE AND terminal_id <> ? FOR UPDATE', [userId, SYSTEM_TERMINAL_ID])
  for (const row of open) {
    await connection.execute('UPDATE sessions SET is_active = FALSE, logout_time = NOW(), end_reason = ? WHERE session_id = ?', [reason, row.session_id])
    await logAudit({ user_id: actor.user_id, session_id: row.session_id, terminal_id: row.terminal_id, ip_address: actor.ip_address, action: 'END_SHIFT', module: 'ADMIN', details: { cashier_id: userId, via: reason } }, connection)
  }
  return open[0]?.terminal_id ?? null
}

export { productNumber }