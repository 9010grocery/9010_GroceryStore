import fs from 'node:fs'
import path from 'node:path'
import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { getPool, withTransaction } from '../config/db.js'
import { loadEnv } from '../config/env.js'
import { HttpError } from '../utils/httpError.js'
import { round2 } from '../utils/pos.js'
import { logAudit } from './audit.service.js'
import { callML, MLServiceError } from './forecast.service.js'
import { loadProducts, loadPurchaseOrders, PO_TO_DB, receiveStockTx, type Actor, type PurchaseOrderStatusUi } from './store.service.js'

// Purchasing support (spec Module 9). Everything here is advice until the owner approves a reorder list;
// nothing is ordered automatically. Writing stock (deliveries) goes through receiveStockTx in store.service.ts.

const HISTORY_DAYS = 90
const WEEKS = 12
const DEFAULT_LEAD_DAYS = 3
const COVER_DAYS = 7 // stock to hold beyond the reorder level
const Z_SERVICE = 1.645 // 95% service level
const WMA_WEIGHTS = [0.5, 0.3, 0.2]
const ML_CONCURRENCY = 3
const ML_CALL_TIMEOUT_MS = 30_000

const audit = (actor: Actor, action: string, details: Record<string, unknown>, connection?: PoolConnection) =>
  logAudit({ user_id: actor.user_id, session_id: actor.session_id, terminal_id: actor.terminal_id, ip_address: actor.ip_address, action, module: 'PURCHASING', details }, connection)

// ---------------------------------------------------------------------------
// Recommendations
// ---------------------------------------------------------------------------

export type ForecastModel = string // 'WMA', 'Reorder level', or the ML model name (e.g. 'XGBoost')

export interface Recommendation {
  productId: string
  name: string
  unit: string
  supplier: string | null
  onHand: number
  onOrder: number
  reorderPoint: number
  leadTimeDays: number
  /** Forecast units per day / per week. 0 when there is too little history (the reorder-level fallback is used). */
  forecastDaily: number
  forecastWeekly: number
  safetyStock: number
  daysOfCover: number | null
  suggestedQty: number
  unitCost: number
  lineCost: number
  model: ForecastModel
  historyDays: number
  reason: string
  priority: 'urgent' | 'high' | 'normal'
  /** Already on a reorder list that is waiting for the owner or not yet turned into a purchase order. */
  onList: boolean
}

async function mlMinSamples(): Promise<number> {
  const [rows] = await getPool().query<RowDataPacket[]>("SELECT setting_value FROM system_settings WHERE setting_key = 'ml_min_samples'")
  const value = Number(rows[0]?.setting_value)
  return Number.isFinite(value) && value > 0 ? value : 30
}

function mlAvailable(): boolean {
  try {
    return fs.existsSync(path.join(loadEnv().ML_SERVICE_DIR, 'predict.py'))
  } catch {
    return false
  }
}

/** Weighted moving average of the last complete weeks, plus the error of that method on the same history (for the safety stock). */
function weeklyWma(daily: number[]): { weekly: number; rmse: number } {
  const complete = daily.slice(0, -1).slice(-WEEKS * 7) // today is a partial day
  const weeks: number[] = []
  for (let i = 0; i < complete.length; i += 7) weeks.push(complete.slice(i, i + 7).reduce((a, b) => a + b, 0))
  const total = WMA_WEIGHTS.reduce((a, b) => a + b, 0)
  const at = (end: number) => WMA_WEIGHTS.reduce((sum, w, j) => sum + w * (weeks[end - 1 - j] ?? 0), 0) / total
  const errors: number[] = []
  for (let t = WMA_WEIGHTS.length; t < weeks.length; t++) errors.push(weeks[t] - at(t))
  const rmse = errors.length ? Math.sqrt(errors.reduce((sum, e) => sum + e * e, 0) / errors.length) : 0
  return { weekly: at(weeks.length), rmse }
}

interface Candidate {
  productId: number
  name: string
  unit: string
  supplier: string | null
  cost: number
  reorderLevel: number
  lead: number
  stock: number
  onOrder: number
  onList: boolean
  daily: number[] // oldest first, last = today (partial)
  historyDays: number
}

async function loadCandidates(): Promise<Candidate[]> {
  const db = getPool()
  const [products] = await db.query<RowDataPacket[]>(
    `SELECT p.product_id, p.product_name, p.unit_of_measure, p.supplier_name, p.cost_price, p.reorder_level, p.lead_time_days,
            COALESCE((SELECT SUM(i.quantity_on_hand) FROM inventory i WHERE i.product_id = p.product_id), 0) AS stock
       FROM products p WHERE p.is_active = TRUE AND p.deleted_at IS NULL ORDER BY p.product_name`,
  )
  const [sales] = await db.query<RowDataPacket[]>(
    `SELECT ti.product_id, DATEDIFF(CURDATE(), DATE(t.transaction_date)) AS days_ago, SUM(ti.quantity) AS units
       FROM transaction_items ti JOIN transactions t ON t.transaction_id = ti.transaction_id
      WHERE t.status <> 'voided' AND t.transaction_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
      GROUP BY ti.product_id, days_ago`,
    [HISTORY_DAYS - 1],
  )
  const [ordered] = await db.query<RowDataPacket[]>(
    `SELECT i.product_id, SUM(i.ordered_quantity - i.received_quantity) AS open_qty
       FROM purchase_order_items i JOIN purchase_orders po ON po.po_id = i.po_id
      WHERE po.status IN ('pending', 'partially_received') GROUP BY i.product_id`,
  )
  const [listed] = await db.query<RowDataPacket[]>(
    `SELECT DISTINCT ri.product_id FROM reorder_items ri JOIN reorder_lists rl ON rl.reorder_list_id = ri.reorder_list_id
      WHERE rl.status IN ('pending', 'approved')`,
  )
  const onOrder = new Map(ordered.map((r) => [Number(r.product_id), Math.max(0, Number(r.open_qty))]))
  const onList = new Set(listed.map((r) => Number(r.product_id)))
  const byProduct = new Map<number, number[]>()
  for (const row of sales) {
    const arr = byProduct.get(Number(row.product_id)) ?? new Array(HISTORY_DAYS).fill(0)
    const index = HISTORY_DAYS - 1 - Number(row.days_ago)
    if (index >= 0 && index < HISTORY_DAYS) arr[index] += Number(row.units)
    byProduct.set(Number(row.product_id), arr)
  }
  return products.map((p) => {
    const daily = byProduct.get(Number(p.product_id)) ?? new Array(HISTORY_DAYS).fill(0)
    const first = daily.findIndex((v) => v > 0)
    return {
      productId: Number(p.product_id),
      name: p.product_name as string,
      unit: (p.unit_of_measure as string | null) ?? 'pc',
      supplier: (p.supplier_name as string | null) ?? null,
      cost: Number(p.cost_price ?? 0),
      reorderLevel: Number(p.reorder_level ?? 0),
      lead: p.lead_time_days === null ? DEFAULT_LEAD_DAYS : Number(p.lead_time_days),
      stock: Number(p.stock),
      onOrder: onOrder.get(Number(p.product_id)) ?? 0,
      onList: onList.has(Number(p.product_id)),
      daily,
      // Days since the first sale in the window (a product that never sold has no history).
      historyDays: first < 0 ? 0 : HISTORY_DAYS - first,
    }
  })
}

interface MlResult { model: string; daily: number }

/** Asks the Python service for a per-day forecast. Returns null (never throws) so the WMA / reorder-level fallback takes over. */
async function mlForecast(c: Candidate, minSamples: number): Promise<{ result: MlResult | null; error: string | null }> {
  const today = new Date()
  const history = c.daily.slice(0, -1).map((sales, i) => ({ date: new Date(today.getTime() - (HISTORY_DAYS - 1 - i) * 86_400_000).toISOString().slice(0, 10), sales }))
  const horizon = Math.min(28, Math.max(7, c.lead + COVER_DAYS))
  try {
    const out = await callML<{ model?: string; model_name?: string; forecast?: number[]; daily_forecast?: number[]; predicted_demand?: number }>(
      { action: 'forecast', product_id: c.productId, history, horizon, min_samples: minSamples },
      ML_CALL_TIMEOUT_MS,
    )
    const series = out.daily_forecast ?? out.forecast
    const daily = Array.isArray(series) && series.length ? series.reduce((a, b) => a + Number(b), 0) / series.length : typeof out.predicted_demand === 'number' ? out.predicted_demand / horizon : NaN
    const model = out.model ?? out.model_name
    if (!Number.isFinite(daily) || daily < 0 || !model || model.toLowerCase() === 'fallback') return { result: null, error: null }
    return { result: { model, daily }, error: null }
  } catch (error) {
    return { result: null, error: error instanceof MLServiceError ? error.message : error instanceof Error ? error.message : String(error) }
  }
}

function build(c: Candidate, forecast: { model: ForecastModel; daily: number; rmse: number } | null): Recommendation {
  const stockPlusOrder = c.stock + c.onOrder
  let daily = 0
  let safety = 0
  let reorderLevel = c.reorderLevel
  let target: number
  let model: ForecastModel = 'Reorder level'
  let reason: string
  if (forecast) {
    model = forecast.model
    daily = forecast.daily
    safety = Z_SERVICE * (forecast.rmse / Math.sqrt(7)) * Math.sqrt(c.lead)
    reorderLevel = Math.max(c.reorderLevel, daily * c.lead + safety)
    target = reorderLevel + daily * COVER_DAYS
    reason = stockPlusOrder < reorderLevel
      ? `Stock ${c.stock}${c.onOrder ? ` + ${c.onOrder} on order` : ''} is below the level of ${Math.ceil(reorderLevel)} needed for ${c.lead}d lead time at ~${daily.toFixed(1)}/day (${model}).`
      : 'Above its reorder level.'
  } else {
    // Not enough history to forecast: keep twice the reorder level on the shelf.
    target = Math.max(c.reorderLevel * 2, c.reorderLevel + 1)
    reason = stockPlusOrder <= reorderLevel
      ? `At or below the reorder level of ${c.reorderLevel} and only ${c.historyDays} day(s) of sales history, so the reorder level is used instead of a forecast.`
      : 'Above its reorder level.'
  }
  const needs = forecast ? stockPlusOrder < reorderLevel : stockPlusOrder <= reorderLevel
  const suggestedQty = needs ? Math.max(1, Math.ceil(target - stockPlusOrder)) : 0
  const cover = daily > 0 ? c.stock / daily : null
  const priority: Recommendation['priority'] = suggestedQty === 0 ? 'normal' : c.stock <= 0 || (cover !== null && cover <= c.lead) ? 'urgent' : c.stock <= c.reorderLevel ? 'high' : 'normal'
  return {
    productId: `p${c.productId}`,
    name: c.name,
    unit: c.unit,
    supplier: c.supplier,
    onHand: c.stock,
    onOrder: c.onOrder,
    reorderPoint: c.reorderLevel,
    leadTimeDays: c.lead,
    forecastDaily: round2(daily),
    forecastWeekly: round2(daily * 7),
    safetyStock: Math.ceil(safety),
    daysOfCover: cover === null ? null : round2(cover),
    suggestedQty,
    unitCost: c.cost,
    lineCost: round2(suggestedQty * c.cost),
    model,
    historyDays: c.historyDays,
    reason,
    priority,
    onList: c.onList,
  }
}

const PRIORITY_RANK = { urgent: 0, high: 1, normal: 2 } as const

/** What to buy now. Products with enough sales history use the ML forecast when the Python service answers, else a weighted moving average; the rest use the reorder level. */
export async function recommendations() {
  const [candidates, minSamples] = await Promise.all([loadCandidates(), mlMinSamples()])
  const ml = { available: mlAvailable(), used: 0, error: null as string | null }
  const results = new Map<number, Recommendation>()
  const wma = new Map<number, { weekly: number; rmse: number }>()
  const pending: Candidate[] = []

  for (const c of candidates) {
    if (c.historyDays < minSamples) {
      results.set(c.productId, build(c, null))
      continue
    }
    const w = weeklyWma(c.daily)
    wma.set(c.productId, w)
    const rec = build(c, { model: 'WMA', daily: w.weekly / 7, rmse: w.rmse })
    results.set(c.productId, rec)
    // Only the products that might need an order are worth a Python call.
    if (ml.available && (rec.suggestedQty > 0 || rec.onHand <= Math.max(rec.reorderPoint, rec.forecastDaily * (rec.leadTimeDays + COVER_DAYS)))) pending.push(c)
  }

  let next = 0
  const worker = async () => {
    while (next < pending.length) {
      const c = pending[next++]
      const { result, error } = await mlForecast(c, minSamples)
      if (error && !ml.error) ml.error = error
      if (!result) continue
      ml.used++
      results.set(c.productId, build(c, { model: result.model, daily: result.daily, rmse: wma.get(c.productId)?.rmse ?? 0 }))
    }
  }
  await Promise.all(Array.from({ length: Math.min(ML_CONCURRENCY, pending.length) }, worker))

  const items = [...results.values()]
    .filter((r) => r.suggestedQty > 0)
    .sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || (a.daysOfCover ?? Infinity) - (b.daysOfCover ?? Infinity) || a.name.localeCompare(b.name))
  return {
    generatedAt: new Date().toISOString(),
    minSamples,
    ml,
    summary: { count: items.length, urgent: items.filter((i) => i.priority === 'urgent').length, totalCost: round2(items.reduce((sum, i) => sum + i.lineCost, 0)) },
    items,
  }
}

// ---------------------------------------------------------------------------
// Reorder lists
// ---------------------------------------------------------------------------

const toId = (prefix: string, id: unknown) => `${prefix}${id}`

async function listRows(where: string, params: unknown[]) {
  const [rows] = await getPool().query<RowDataPacket[]>(
    `SELECT rl.reorder_list_id, rl.status, rl.created_date, rl.approval_date, rl.notes, rl.rejected_reason,
            CONCAT(c.first_name, ' ', c.last_name) AS created_by_name, CONCAT(a.first_name, ' ', a.last_name) AS approved_by_name,
            (SELECT COUNT(*) FROM reorder_items ri WHERE ri.reorder_list_id = rl.reorder_list_id) AS item_count,
            (SELECT COALESCE(SUM(ri.suggested_quantity * COALESCE(p.cost_price, 0)), 0) FROM reorder_items ri JOIN products p ON p.product_id = ri.product_id WHERE ri.reorder_list_id = rl.reorder_list_id) AS suggested_cost,
            (SELECT COALESCE(SUM(ri.approved_quantity * COALESCE(p.cost_price, 0)), 0) FROM reorder_items ri JOIN products p ON p.product_id = ri.product_id WHERE ri.reorder_list_id = rl.reorder_list_id AND ri.is_approved = TRUE) AS approved_cost,
            (SELECT COUNT(*) FROM purchase_orders po WHERE po.reorder_list_id = rl.reorder_list_id) AS po_count
       FROM reorder_lists rl JOIN users c ON c.user_id = rl.created_by LEFT JOIN users a ON a.user_id = rl.approved_by
      WHERE ${where} ORDER BY rl.reorder_list_id DESC`,
    params,
  )
  return rows.map((r) => ({
    id: toId('rl', r.reorder_list_id),
    status: r.status as 'pending' | 'approved' | 'rejected' | 'completed',
    createdAt: new Date(r.created_date as string).toISOString(),
    createdBy: r.created_by_name as string,
    decidedAt: r.approval_date ? new Date(r.approval_date as string).toISOString() : null,
    decidedBy: (r.approved_by_name as string | null) ?? null,
    notes: (r.notes as string | null) ?? '',
    rejectedReason: (r.rejected_reason as string | null) ?? null,
    itemCount: Number(r.item_count),
    suggestedCost: round2(Number(r.suggested_cost)),
    approvedCost: round2(Number(r.approved_cost)),
    purchaseOrders: Number(r.po_count),
  }))
}

export const listReorderLists = (filters: { status?: 'pending' | 'approved' | 'rejected' | 'completed' }) =>
  listRows(filters.status ? 'rl.status = ?' : '1 = 1', filters.status ? [filters.status] : [])

export async function getReorderList(listId: number) {
  const [list] = await listRows('rl.reorder_list_id = ?', [listId])
  if (!list) throw HttpError.notFound('Reorder list not found')
  const [items] = await getPool().query<RowDataPacket[]>(
    `SELECT ri.reorder_item_id, ri.product_id, ri.suggested_quantity, ri.approved_quantity, ri.is_approved, ri.reason, p.product_name, p.unit_of_measure, p.supplier_name, p.cost_price, p.reorder_level,
            COALESCE((SELECT SUM(i.quantity_on_hand) FROM inventory i WHERE i.product_id = p.product_id), 0) AS stock
       FROM reorder_items ri JOIN products p ON p.product_id = ri.product_id WHERE ri.reorder_list_id = ? ORDER BY ri.reorder_item_id`,
    [listId],
  )
  return {
    ...list,
    items: items.map((i) => ({
      itemId: Number(i.reorder_item_id),
      productId: toId('p', i.product_id),
      name: i.product_name as string,
      unit: (i.unit_of_measure as string | null) ?? 'pc',
      supplier: (i.supplier_name as string | null) ?? null,
      onHand: Number(i.stock),
      reorderPoint: Number(i.reorder_level ?? 0),
      unitCost: Number(i.cost_price ?? 0),
      suggestedQty: Number(i.suggested_quantity),
      approvedQty: i.approved_quantity === null ? null : Number(i.approved_quantity),
      approved: Boolean(i.is_approved),
      reason: (i.reason as string | null) ?? '',
    })),
  }
}

/** Creates a pending list. Without `items`, every current recommendation goes on it. */
export async function createReorderList(actor: Actor, input: { items?: { product_id: number; qty: number; reason?: string | null }[]; notes?: string | null }) {
  let lines: { product_id: number; qty: number; reason: string }[]
  if (input.items?.length) {
    const ids = [...new Set(input.items.map((i) => i.product_id))]
    if (ids.length !== input.items.length) throw HttpError.badRequest('A product is on the list twice')
    const [found] = await getPool().query<RowDataPacket[]>('SELECT product_id FROM products WHERE product_id IN (?) AND is_active = TRUE AND deleted_at IS NULL', [ids])
    if (found.length !== ids.length) throw HttpError.notFound('One of the products was not found')
    lines = input.items.map((i) => ({ product_id: i.product_id, qty: i.qty, reason: i.reason?.trim() || 'Added by the owner' }))
  } else {
    const recs = await recommendations()
    lines = recs.items.map((r) => ({ product_id: Number(r.productId.slice(1)), qty: r.suggestedQty, reason: `${r.model}: ${r.reason}` }))
    if (!lines.length) throw HttpError.badRequest('Nothing needs reordering right now')
  }
  const listId = await withTransaction(async (connection) => {
    const [created] = await connection.execute<ResultSetHeader>('INSERT INTO reorder_lists (created_by, notes) VALUES (?, ?)', [actor.user_id, input.notes?.trim() || null])
    for (const line of lines) {
      await connection.execute('INSERT INTO reorder_items (reorder_list_id, product_id, suggested_quantity, reason) VALUES (?, ?, ?, ?)', [created.insertId, line.product_id, line.qty, line.reason.slice(0, 255)])
    }
    await audit(actor, 'CREATE_REORDER_LIST', { reorder_list_id: created.insertId, items: lines.length }, connection)
    return created.insertId
  })
  return getReorderList(listId)
}

/** The owner approves a pending list, optionally changing quantities (0 drops a line). Nothing is ordered yet. */
export async function approveReorderList(actor: Actor, listId: number, changes: { item_id: number; qty: number }[]) {
  await withTransaction(async (connection) => {
    const [lists] = await connection.query<RowDataPacket[]>('SELECT status FROM reorder_lists WHERE reorder_list_id = ? FOR UPDATE', [listId])
    if (!lists[0]) throw HttpError.notFound('Reorder list not found')
    if (lists[0].status !== 'pending') throw HttpError.conflict(`This list is already ${lists[0].status}`)
    const [items] = await connection.query<RowDataPacket[]>(
      'SELECT ri.reorder_item_id, ri.suggested_quantity, p.cost_price FROM reorder_items ri JOIN products p ON p.product_id = ri.product_id WHERE ri.reorder_list_id = ? FOR UPDATE',
      [listId],
    )
    const known = new Set(items.map((i) => Number(i.reorder_item_id)))
    const override = new Map<number, number>()
    for (const change of changes) {
      if (!known.has(change.item_id)) throw HttpError.badRequest('A line does not belong to this list')
      if (override.has(change.item_id)) throw HttpError.badRequest('A line is listed twice')
      override.set(change.item_id, change.qty)
    }
    let approvedLines = 0
    let modified = 0
    for (const item of items) {
      const id = Number(item.reorder_item_id)
      const qty = override.get(id) ?? Number(item.suggested_quantity)
      if (qty !== Number(item.suggested_quantity)) modified++
      if (qty > 0) approvedLines++
      await connection.execute('UPDATE reorder_items SET approved_quantity = ?, is_approved = ?, actual_cost = ? WHERE reorder_item_id = ?', [qty, qty > 0, round2(qty * Number(item.cost_price ?? 0)), id])
    }
    if (!approvedLines) throw HttpError.badRequest('Every line is at 0. Reject the list instead, or keep at least one item.')
    await connection.execute("UPDATE reorder_lists SET status = 'approved', approved_by = ?, approval_date = NOW() WHERE reorder_list_id = ?", [actor.user_id, listId])
    await audit(actor, 'APPROVE_REORDER_LIST', { reorder_list_id: listId, approved_lines: approvedLines, modified_lines: modified }, connection)
  })
  return getReorderList(listId)
}

export async function rejectReorderList(actor: Actor, listId: number, reason: string) {
  await withTransaction(async (connection) => {
    const [lists] = await connection.query<RowDataPacket[]>('SELECT status FROM reorder_lists WHERE reorder_list_id = ? FOR UPDATE', [listId])
    if (!lists[0]) throw HttpError.notFound('Reorder list not found')
    if (lists[0].status !== 'pending') throw HttpError.conflict(`This list is already ${lists[0].status}`)
    await connection.execute("UPDATE reorder_lists SET status = 'rejected', approved_by = ?, approval_date = NOW(), rejected_reason = ? WHERE reorder_list_id = ?", [actor.user_id, reason.slice(0, 255), listId])
    await audit(actor, 'REJECT_REORDER_LIST', { reorder_list_id: listId, reason }, connection)
  })
  return getReorderList(listId)
}

// ---------------------------------------------------------------------------
// Purchase orders
// ---------------------------------------------------------------------------

/** PO-2026-0001 style numbers. The year's counter row is locked until the order commits, so two orders never share a number. */
async function nextPoNumber(connection: PoolConnection): Promise<string> {
  const [clock] = await connection.query<RowDataPacket[]>('SELECT YEAR(NOW()) AS year')
  const year = Number(clock[0].year)
  const lockRow = async () => (await connection.query<RowDataPacket[]>('SELECT last_number FROM po_counters WHERE counter_year = ? FOR UPDATE', [year]))[0][0] as RowDataPacket | undefined
  let row = await lockRow()
  if (!row) {
    await connection.execute('INSERT IGNORE INTO po_counters (counter_year, last_number) VALUES (?, 0)', [year])
    row = await lockRow()
  }
  const next = Number(row?.last_number ?? 0) + 1
  await connection.execute('UPDATE po_counters SET last_number = ? WHERE counter_year = ?', [next, year])
  return `PO-${year}-${String(next).padStart(4, '0')}`
}

export interface PoInput {
  reorder_list_id?: number
  supplier?: string | null
  expected_delivery?: string | null
  notes?: string | null
  items?: { product_id: number; qty: number; unit_cost?: number | null }[]
}

/**
 * From an approved reorder list: one order per supplier, then the list is closed (completed).
 * Manual: one order for the given items. Returns the orders created.
 */
export async function createPurchaseOrders(actor: Actor, input: PoInput) {
  const ids = await withTransaction(async (connection) => {
    type Line = { product_id: number; qty: number; unit_cost: number; supplier: string | null; lead: number }
    let lines: Line[]
    if (input.reorder_list_id) {
      const [lists] = await connection.query<RowDataPacket[]>('SELECT status FROM reorder_lists WHERE reorder_list_id = ? FOR UPDATE', [input.reorder_list_id])
      if (!lists[0]) throw HttpError.notFound('Reorder list not found')
      if (lists[0].status !== 'approved') throw HttpError.conflict(lists[0].status === 'pending' ? 'Approve the reorder list first' : `This list is already ${lists[0].status}`)
      const [rows] = await connection.query<RowDataPacket[]>(
        `SELECT ri.product_id, ri.approved_quantity, p.cost_price, p.supplier_name, p.lead_time_days
           FROM reorder_items ri JOIN products p ON p.product_id = ri.product_id
          WHERE ri.reorder_list_id = ? AND ri.is_approved = TRUE AND ri.approved_quantity > 0 AND p.deleted_at IS NULL ORDER BY ri.reorder_item_id`,
        [input.reorder_list_id],
      )
      lines = rows.map((r) => ({ product_id: Number(r.product_id), qty: Number(r.approved_quantity), unit_cost: Number(r.cost_price ?? 0), supplier: (r.supplier_name as string | null) ?? null, lead: r.lead_time_days === null ? DEFAULT_LEAD_DAYS : Number(r.lead_time_days) }))
      if (!lines.length) throw HttpError.badRequest('No approved lines on this list')
    } else {
      if (!input.items?.length) throw HttpError.badRequest('Add at least one item')
      const pids = [...new Set(input.items.map((i) => i.product_id))]
      if (pids.length !== input.items.length) throw HttpError.badRequest('A product is on the order twice')
      const [rows] = await connection.query<RowDataPacket[]>('SELECT product_id, cost_price, supplier_name, lead_time_days FROM products WHERE product_id IN (?) AND is_active = TRUE AND deleted_at IS NULL', [pids])
      const byId = new Map(rows.map((r) => [Number(r.product_id), r]))
      lines = input.items.map((i) => {
        const p = byId.get(i.product_id)
        if (!p) throw HttpError.notFound('One of the products was not found')
        return { product_id: i.product_id, qty: i.qty, unit_cost: i.unit_cost ?? Number(p.cost_price ?? 0), supplier: (p.supplier_name as string | null) ?? null, lead: p.lead_time_days === null ? DEFAULT_LEAD_DAYS : Number(p.lead_time_days) }
      })
    }

    // Group into orders: by each product's supplier for a list; for a manual order the owner's supplier name wins.
    const groups = new Map<string, Line[]>()
    const manualSupplier = !input.reorder_list_id ? input.supplier?.trim() || null : null
    for (const line of lines) {
      const key = manualSupplier ?? line.supplier ?? ''
      groups.set(key, [...(groups.get(key) ?? []), line])
    }
    if (!input.reorder_list_id && !manualSupplier && groups.size > 1) throw HttpError.badRequest('These products have different suppliers. Enter a supplier name for this order, or order them separately.')

    const created: number[] = []
    for (const [supplier, group] of groups) {
      const number = await nextPoNumber(connection)
      const lead = Math.max(...group.map((l) => l.lead))
      let expected = input.expected_delivery ?? null
      if (expected) {
        const [past] = await connection.query<RowDataPacket[]>('SELECT ? < CURDATE() AS past', [expected])
        if (Number(past[0].past)) throw HttpError.badRequest('The expected delivery date is in the past')
      } else {
        const [d] = await connection.query<RowDataPacket[]>('SELECT DATE_ADD(CURDATE(), INTERVAL ? DAY) AS d', [lead])
        expected = String(d[0].d).slice(0, 10)
      }
      const [po] = await connection.execute<ResultSetHeader>(
        'INSERT INTO purchase_orders (po_number, reorder_list_id, supplier, expected_delivery, created_by, notes) VALUES (?, ?, ?, ?, ?, ?)',
        [number, input.reorder_list_id ?? null, supplier || null, expected, actor.user_id, input.notes?.trim() || null],
      )
      for (const line of group) {
        await connection.execute('INSERT INTO purchase_order_items (po_id, product_id, ordered_quantity, unit_cost) VALUES (?, ?, ?, ?)', [po.insertId, line.product_id, line.qty, line.unit_cost])
      }
      await audit(actor, 'CREATE_PO', { po_id: po.insertId, po_number: number, supplier: supplier || null, items: group.length, reorder_list_id: input.reorder_list_id ?? null }, connection)
      created.push(po.insertId)
    }
    if (input.reorder_list_id) await connection.execute("UPDATE reorder_lists SET status = 'completed' WHERE reorder_list_id = ?", [input.reorder_list_id])
    return created
  })
  return loadPurchaseOrders(getPool(), 'po.po_id IN (?)', [ids])
}

export async function listPurchaseOrders(filters: { status?: 'Open' | 'All' | PurchaseOrderStatusUi; q?: string }) {
  const where: string[] = ['1 = 1']
  const params: unknown[] = []
  if (!filters.status || filters.status === 'Open') where.push("po.status IN ('pending', 'partially_received')")
  else if (filters.status !== 'All') { where.push('po.status = ?'); params.push(PO_TO_DB[filters.status]) }
  if (filters.q) { where.push('(po.po_number LIKE ? OR po.supplier LIKE ?)'); params.push(`%${filters.q}%`, `%${filters.q}%`) }
  return loadPurchaseOrders(getPool(), where.join(' AND '), params)
}

export async function getPurchaseOrder(poId: number) {
  const [order] = await loadPurchaseOrders(getPool(), 'po.po_id = ?', [poId])
  if (!order) throw HttpError.notFound('Purchase order not found')
  return order
}

export interface ReceiveLine { item_id: number; qty: number; batch_number?: string | null; expiry_date?: string | null; unit_cost?: number | null }

/**
 * Books a delivery against an order, part or all of it. Each line becomes stock in its own batch (the PO number unless the
 * owner enters the supplier's lot number) with an inventory adjustment. The order turns partially_received, then completed
 * when every line is in. Afterwards, products still at or below their reorder level are reported so the owner can order again.
 */
export async function receivePurchaseOrder(actor: Actor, poId: number, input: { lines: ReceiveLine[]; note?: string | null }) {
  const productIds = await withTransaction(async (connection) => {
    const [orders] = await connection.query<RowDataPacket[]>('SELECT po_number, status FROM purchase_orders WHERE po_id = ? FOR UPDATE', [poId])
    const order = orders[0]
    if (!order) throw HttpError.notFound('Purchase order not found')
    if (order.status !== 'pending' && order.status !== 'partially_received') throw HttpError.conflict(`This order is ${String(order.status).replace('_', ' ')}`)
    const [items] = await connection.query<RowDataPacket[]>(
      'SELECT i.po_item_id, i.product_id, i.ordered_quantity, i.received_quantity, i.unit_cost, p.product_name FROM purchase_order_items i JOIN products p ON p.product_id = i.product_id WHERE i.po_id = ? FOR UPDATE',
      [poId],
    )
    const byId = new Map(items.map((i) => [Number(i.po_item_id), i]))
    const seen = new Set<number>()
    const touched: number[] = []
    for (const line of input.lines) {
      const item = byId.get(line.item_id)
      if (!item) throw HttpError.badRequest('A line does not belong to this order')
      if (seen.has(line.item_id)) throw HttpError.badRequest('A line is listed twice')
      seen.add(line.item_id)
      const outstanding = Number(item.ordered_quantity) - Number(item.received_quantity)
      if (line.qty > outstanding) throw HttpError.conflict(outstanding > 0 ? `Only ${outstanding} ${item.product_name} still expected on this order` : `${item.product_name} was already received in full`, { item_id: line.item_id, outstanding })
      await receiveStockTx(connection, actor, Number(item.product_id), {
        qty: line.qty,
        batch_number: line.batch_number?.trim() || (order.po_number as string),
        expiry_date: line.expiry_date || null,
        unit_cost: line.unit_cost ?? (item.unit_cost === null ? null : Number(item.unit_cost)),
        note: input.note?.trim() || `Received ${order.po_number}`,
      })
      await connection.execute('UPDATE purchase_order_items SET received_quantity = received_quantity + ?, unit_cost = COALESCE(?, unit_cost) WHERE po_item_id = ?', [line.qty, line.unit_cost ?? null, line.item_id])
      touched.push(Number(item.product_id))
    }
    const [after] = await connection.query<RowDataPacket[]>('SELECT SUM(received_quantity >= ordered_quantity) AS done, COUNT(*) AS total FROM purchase_order_items WHERE po_id = ?', [poId])
    const complete = Number(after[0].done) === Number(after[0].total)
    await connection.execute(
      complete ? "UPDATE purchase_orders SET status = 'completed', completed_at = NOW() WHERE po_id = ?" : "UPDATE purchase_orders SET status = 'partially_received' WHERE po_id = ?",
      [poId],
    )
    await audit(actor, 'RECEIVE_PO', { po_id: poId, po_number: order.po_number, lines: input.lines.length, units: input.lines.reduce((s, l) => s + l.qty, 0), complete }, connection)
    return touched
  })
  const order = await getPurchaseOrder(poId)
  const products = (await loadProducts(getPool())).filter((p) => productIds.includes(Number(p.id.slice(1))))
  // "Below reorder level after this delivery?" Nothing is ordered for the owner; this is the prompt to do it.
  const belowReorder = products.filter((p) => p.stock <= p.reorderPoint).map((p) => ({ productId: p.id, name: p.name, stock: p.stock, reorderPoint: p.reorderPoint }))
  return { order, products, belowReorder }
}

/** Cancels an order nothing has been received on. */
export async function cancelPurchaseOrder(actor: Actor, poId: number, reason: string) {
  await withTransaction(async (connection) => {
    const [orders] = await connection.query<RowDataPacket[]>('SELECT po_number, status FROM purchase_orders WHERE po_id = ? FOR UPDATE', [poId])
    const order = orders[0]
    if (!order) throw HttpError.notFound('Purchase order not found')
    if (order.status === 'partially_received') throw HttpError.conflict('Part of this order was already received. Close it instead.')
    if (order.status !== 'pending') throw HttpError.conflict(`This order is already ${order.status}`)
    await connection.execute("UPDATE purchase_orders SET status = 'cancelled', cancel_reason = ? WHERE po_id = ?", [reason.slice(0, 255) || null, poId])
    await audit(actor, 'CANCEL_PO', { po_id: poId, po_number: order.po_number, reason }, connection)
  })
  return getPurchaseOrder(poId)
}

/** The supplier will not deliver the rest: a partly received order is closed as completed. */
export async function closePurchaseOrder(actor: Actor, poId: number, reason: string) {
  await withTransaction(async (connection) => {
    const [orders] = await connection.query<RowDataPacket[]>('SELECT po_number, status FROM purchase_orders WHERE po_id = ? FOR UPDATE', [poId])
    const order = orders[0]
    if (!order) throw HttpError.notFound('Purchase order not found')
    if (order.status !== 'partially_received') throw HttpError.conflict('Only a partly received order can be closed')
    await connection.execute("UPDATE purchase_orders SET status = 'completed', completed_at = NOW(), cancel_reason = ? WHERE po_id = ?", [reason.slice(0, 255) || null, poId])
    await audit(actor, 'CLOSE_PO', { po_id: poId, po_number: order.po_number, reason }, connection)
  })
  return getPurchaseOrder(poId)
}