import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { withTransaction } from '../config/db.js'
import { HttpError } from '../utils/httpError.js'
import { computeTotals, round2, type CustomerType } from '../utils/pos.js'
import { logAudit } from './audit.service.js'
import { SYSTEM_TERMINAL_ID } from './session.service.js'
import { changeStock, splitName, vatRate, type Actor } from './store.service.js'

// Imports data exported from the old system (CSV / Excel). The browser reads the file and maps its columns
// to the field names below; every row is then checked and saved here. A preview (dry run) does exactly the
// same work inside a transaction and rolls it back, so its counts and errors match the real import.

export const IMPORT_KINDS = ['products', 'employees', 'sales', 'waste', 'requests'] as const
export type ImportKind = (typeof IMPORT_KINDS)[number]

/** One spreadsheet row after column mapping. `_row` is its line number in the file, for error messages. */
export type ImportRow = Record<string, unknown> & { _row?: number }

export interface ImportResult {
  kind: ImportKind
  dry_run: boolean
  total_rows: number
  inserted: number
  updated: number
  skipped: number
  errors: { row: number; message: string }[]
  notes: string[]
}

class RowError extends Error {}
class DryRunDone extends Error {
  constructor(readonly result: ImportResult) {
    super('dry run')
  }
}

// ---------------------------------------------------------------------------
// Cell parsing — old systems export numbers and flags in many shapes
// ---------------------------------------------------------------------------

function str(value: unknown, max = 255): string | null {
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  return text ? text.slice(0, max) : null
}

function num(value: unknown, field: string, { required = false, min = 0 } = {}): number | null {
  if (value === null || value === undefined || String(value).trim() === '') {
    if (required) throw new RowError(`${field} is missing`)
    return null
  }
  if (typeof value === 'number') return value
  const cleaned = String(value).replace(/[₱,\s]|PHP|php|Php/g, '').replace(/^\((.*)\)$/, '-$1')
  const n = Number(cleaned)
  if (!Number.isFinite(n)) throw new RowError(`${field} "${String(value)}" is not a number`)
  if (n < min) throw new RowError(`${field} can't be below ${min}`)
  return n
}

function int(value: unknown, field: string, options?: { required?: boolean; min?: number }): number | null {
  const n = num(value, field, options)
  return n === null ? null : Math.round(n)
}

function bool(value: unknown): boolean | null {
  const text = str(value)?.toLowerCase()
  if (!text) return null
  if (['1', 'y', 'yes', 'true', 'active', 'enabled', 'available'].includes(text)) return true
  if (['0', 'n', 'no', 'false', 'inactive', 'disabled', 'discontinued', 'deleted'].includes(text)) return false
  return null
}

/** The browser sends dates as "YYYY-MM-DD" or "YYYY-MM-DD HH:MM[:SS]" (store time). */
function date(value: unknown, field: string, required = false): string | null {
  const text = str(value)
  if (!text) {
    if (required) throw new RowError(`${field} is missing`)
    return null
  }
  const match = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2})(?::(\d{2}))?)?$/.exec(text)
  if (!match || Number.isNaN(new Date(`${match[1]}T00:00:00`).getTime())) throw new RowError(`${field} "${text}" is not a date the importer understands`)
  return `${match[1]} ${match[2] ?? '00:00'}:${match[3] ?? '00'}`
}

const lower = (value: string | null) => value?.toLowerCase() ?? ''

// ---------------------------------------------------------------------------
// Lookups shared by the kinds that point at products or people
// ---------------------------------------------------------------------------

interface ProductRef { product_id: number; product_name: string; unit_price: number }

async function productIndex(connection: PoolConnection) {
  const [rows] = await connection.query<RowDataPacket[]>('SELECT product_id, barcode, product_code, product_name, unit_price FROM products WHERE deleted_at IS NULL')
  const byBarcode = new Map<string, ProductRef>()
  const bySku = new Map<string, ProductRef>()
  const byName = new Map<string, ProductRef>()
  const add = (row: { product_id: number; barcode: string | null; product_code: string | null; product_name: string; unit_price: number }) => {
    const ref = { product_id: row.product_id, product_name: row.product_name, unit_price: Number(row.unit_price) }
    if (row.barcode) byBarcode.set(lower(row.barcode), ref)
    if (row.product_code) bySku.set(lower(row.product_code), ref)
    byName.set(lower(row.product_name), ref)
  }
  for (const row of rows) add(row as never)
  const find = (row: ImportRow): ProductRef | undefined =>
    byBarcode.get(lower(str(row.barcode))) ?? bySku.get(lower(str(row.sku))) ?? byName.get(lower(str(row.name ?? row.product)))
  const require = (row: ImportRow): ProductRef => {
    const found = find(row)
    if (found) return found
    const label = str(row.barcode) ?? str(row.sku) ?? str(row.name ?? row.product)
    if (!label) throw new RowError('No product given (barcode, SKU or name)')
    throw new RowError(`Product "${label}" not found. Import products first, or check the barcode/SKU/name.`)
  }
  return { find, require, add }
}

async function firstBatch(connection: PoolConnection, productId: number, actor: Actor): Promise<number> {
  const [rows] = await connection.query<RowDataPacket[]>('SELECT inventory_id FROM inventory WHERE product_id = ? ORDER BY inventory_id LIMIT 1', [productId])
  return rows[0]?.inventory_id ?? changeStock(connection, productId, 0, { user_id: actor.user_id, session_id: actor.session_id, type: 'adjustment', reason: 'Import' })
}

// ---------------------------------------------------------------------------
// One function per kind. Each handles one row (or one receipt) and reports what it did.
// ---------------------------------------------------------------------------

type Outcome = 'inserted' | 'updated' | 'skipped'

async function importProducts(connection: PoolConnection, actor: Actor, rows: ImportRow[], each: (row: ImportRow, work: () => Promise<Outcome>) => Promise<void>) {
  const index = await productIndex(connection)
  for (const row of rows) {
    await each(row, async () => {
      const name = str(row.name, 100)
      const barcode = str(row.barcode, 50)
      const sku = str(row.sku, 50)
      const price = num(row.price, 'Price')
      const cost = num(row.cost, 'Cost')
      const reorder = int(row.reorder_point, 'Reorder level')
      const lead = int(row.lead_time_days, 'Lead time')
      const stock = int(row.stock, 'Stock')
      const expiry = date(row.expiry, 'Expiry')?.slice(0, 10) ?? null
      const active = bool(row.active)
      const existing = index.find(row)

      if (!existing) {
        if (!name) throw new RowError('Product name is missing')
        if (price === null) throw new RowError('Price is missing')
        const [result] = await connection.execute<ResultSetHeader>(
          `INSERT INTO products (barcode, product_code, product_name, category, supplier_name, unit_of_measure, unit_price, cost_price, reorder_level, lead_time_days, is_active)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [barcode, sku, name, str(row.category, 50), str(row.supplier, 100), str(row.unit, 20), price, cost, reorder ?? 10, lead, active ?? true],
        )
        await connection.execute('INSERT INTO inventory (product_id, quantity_on_hand, expiry_date) VALUES (?, 0, ?)', [result.insertId, expiry])
        if (stock) await changeStock(connection, result.insertId, stock, { user_id: actor.user_id, session_id: actor.session_id, type: 'receive', reason: 'Opening stock (import)' })
        index.add({ product_id: result.insertId, barcode, product_code: sku, product_name: name, unit_price: price })
        return 'inserted'
      }

      // Existing product: only the columns present in the file change.
      const changes: [string, unknown][] = [
        ['barcode', barcode], ['product_code', sku], ['product_name', name], ['category', str(row.category, 50)], ['supplier_name', str(row.supplier, 100)],
        ['unit_of_measure', str(row.unit, 20)], ['unit_price', price], ['cost_price', cost], ['reorder_level', reorder], ['lead_time_days', lead], ['is_active', active],
      ].filter(([, value]) => value !== null) as [string, string | number | boolean][]
      if (changes.length) {
        await connection.query(`UPDATE products SET ${changes.map(([column]) => `${column} = ?`).join(', ')} WHERE product_id = ?`, [...changes.map(([, v]) => v), existing.product_id])
      }
      if (stock !== null) {
        const [current] = await connection.query<RowDataPacket[]>('SELECT COALESCE(SUM(quantity_on_hand), 0) AS stock FROM inventory WHERE product_id = ?', [existing.product_id])
        const diff = stock - Number(current[0].stock)
        if (diff) await changeStock(connection, existing.product_id, diff, { user_id: actor.user_id, session_id: actor.session_id, type: 'adjustment', reason: 'Stock count (import)' })
      }
      if (expiry) {
        await connection.execute(
          `UPDATE inventory SET expiry_date = ? WHERE inventory_id = (
             SELECT inventory_id FROM (SELECT inventory_id FROM inventory WHERE product_id = ? ORDER BY expiry_date IS NULL, expiry_date, inventory_id LIMIT 1) AS nearest)`,
          [expiry, existing.product_id],
        )
      }
      return changes.length || stock !== null || expiry ? 'updated' : 'skipped'
    })
  }
}

async function importEmployees(connection: PoolConnection, _actor: Actor, rows: ImportRow[], each: (row: ImportRow, work: () => Promise<Outcome>) => Promise<void>) {
  const [roleRows] = await connection.query<RowDataPacket[]>("SELECT role_id FROM roles WHERE role_name = 'Cashier'")
  const cashierRole = roleRows[0].role_id
  for (const row of rows) {
    await each(row, async () => {
      const first = str(row.first_name, 50)
      const last = str(row.last_name, 50)
      const full = str(row.name, 101) ?? [first, last].filter(Boolean).join(' ')
      if (!full) throw new RowError('Name is missing')
      const split = first || last ? { first: first ?? '', last: last ?? '' } : splitName(full)
      const email = str(row.email, 100)
      const phone = str(row.phone, 20)
      const status = lower(str(row.status))
      const onLeave = /leave/.test(status)
      const active = status ? !/inactive|resign|terminat|separat|former|disabled|no$/.test(status) : (bool(row.active) ?? true)

      const [matches] = await connection.query<RowDataPacket[]>(
        `SELECT u.user_id, r.role_name FROM users u JOIN roles r ON r.role_id = u.role_id
          WHERE (? IS NOT NULL AND u.email = ?) OR (? IS NOT NULL AND u.phone = ?) OR LOWER(CONCAT(u.first_name, ' ', u.last_name)) = ?
          ORDER BY (u.email = ?) DESC LIMIT 1`,
        [email, email, phone, phone, `${split.first} ${split.last}`.trim().toLowerCase(), email],
      )
      const match = matches[0]
      if (match?.role_name === 'Owner') return 'skipped'
      if (match) {
        await connection.execute(
          'UPDATE users SET first_name = ?, last_name = ?, email = COALESCE(?, email), phone = COALESCE(?, phone), is_active = ?, on_leave = ? WHERE user_id = ?',
          [split.first, split.last, email, phone, active, onLeave, match.user_id],
        )
        return 'updated'
      }
      await connection.execute('INSERT INTO users (role_id, first_name, last_name, email, phone, is_active, on_leave) VALUES (?, ?, ?, ?, ?, ?, ?)', [
        cashierRole, split.first, split.last, email, phone, active, onLeave,
      ])
      return 'inserted'
    })
  }
}

const PAYMENT_WORDS: [RegExp, 'cash' | 'gcash' | 'maya' | 'card'][] = [[/g\s*cash/i, 'gcash'], [/maya/i, 'maya'], [/card|credit|debit|visa|master/i, 'card'], [/cash/i, 'cash']]
const CUSTOMER_WORDS: [RegExp, CustomerType][] = [[/pwd|disab/i, 'PWD'], [/senior|sc\b|elder/i, 'Senior']]

async function importSales(connection: PoolConnection, actor: Actor, rows: ImportRow[], each: (row: ImportRow, work: () => Promise<Outcome>) => Promise<void>, notes: Set<string>) {
  const index = await productIndex(connection)
  const rate = await vatRate(connection)
  const [roleRows] = await connection.query<RowDataPacket[]>("SELECT role_id FROM roles WHERE role_name = 'Cashier'")
  const [people] = await connection.query<RowDataPacket[]>("SELECT user_id, LOWER(CONCAT(first_name, ' ', last_name)) AS name FROM users")
  const userByName = new Map(people.map((p) => [p.name as string, p.user_id as number]))
  const sessions = new Map<number, { session_id: number; first: string; last: string }>()

  // One receipt = every row with the same receipt number (one row per item).
  const receipts = new Map<string, ImportRow[]>()
  for (const row of rows) {
    const receipt = str(row.receipt, 30)
    const key = receipt ?? `__missing_${row._row}`
    receipts.set(key, [...(receipts.get(key) ?? []), row])
  }

  const cashierFor = async (name: string | null): Promise<number> => {
    if (!name) return actor.user_id
    const known = userByName.get(name.toLowerCase())
    if (known) return known
    // Someone who only appears in the old sales: kept as an inactive cashier so their sales stay attributed.
    const { first, last } = splitName(name)
    const [created] = await connection.execute<ResultSetHeader>('INSERT INTO users (role_id, first_name, last_name, is_active) VALUES (?, ?, ?, FALSE)', [roleRows[0].role_id, first, last])
    userByName.set(name.toLowerCase(), created.insertId)
    notes.add('Cashiers named in the sales but not found in Employees were added as inactive employees.')
    return created.insertId
  }

  const sessionFor = async (userId: number, when: string): Promise<number> => {
    const existing = sessions.get(userId)
    if (existing) {
      if (when < existing.first) existing.first = when
      if (when > existing.last) existing.last = when
      return existing.session_id
    }
    const [created] = await connection.execute<ResultSetHeader>(
      "INSERT INTO sessions (user_id, terminal_id, assigned_by, assigned_at, login_time, logout_time, is_active, end_reason) VALUES (?, ?, ?, ?, ?, ?, FALSE, 'imported')",
      [userId, SYSTEM_TERMINAL_ID, actor.user_id, when, when, when],
    )
    sessions.set(userId, { session_id: created.insertId, first: when, last: when })
    return created.insertId
  }

  for (const [receipt, lines] of receipts) {
    const head = lines[0]
    await each(head, async () => {
      if (receipt.startsWith('__missing_')) throw new RowError('Receipt number is missing')
      const [exists] = await connection.query<RowDataPacket[]>('SELECT 1 FROM transactions WHERE receipt_number = ?', [receipt])
      if (exists.length) return 'skipped'
      const when = date(head.date, 'Date', true)!
      const customerText = str(head.customer_type) ?? ''
      const customerType = CUSTOMER_WORDS.find(([pattern]) => pattern.test(customerText))?.[1] ?? 'Regular'
      const paymentText = str(head.payment_method)
      const payment = paymentText ? PAYMENT_WORDS.find(([pattern]) => pattern.test(paymentText))?.[1] : 'cash'
      if (!payment) notes.add('Receipts with a payment method other than cash, GCash, Maya or card were recorded as cash.')

      const items = lines.map((line) => {
        try {
          const product = index.require(line)
          const qty = int(line.qty, 'Quantity', { required: true, min: 1 })!
          const unit = num(line.unit_price, 'Unit price')
          const total = num(line.line_total, 'Line total')
          const price = unit ?? (total !== null ? total / qty : product.unit_price)
          return { product, qty, price: round2(price) }
        } catch (error) {
          throw new RowError(`Line ${line._row ?? '?'}: ${(error as Error).message}`)
        }
      })
      const totals = computeTotals(items, customerType, rate)
      let seniorId = customerType === 'Regular' ? null : str(head.senior_pwd_id, 50)
      let seniorName = customerType === 'Regular' ? null : str(head.senior_pwd_name, 100)
      if (customerType !== 'Regular' && (!seniorId || !seniorName)) {
        seniorId ??= 'NOT RECORDED'
        seniorName ??= 'Not recorded in old system'
        notes.add('Senior/PWD receipts without the ID number or name are marked "NOT RECORDED".')
      }
      const received = num(head.amount_received, 'Amount received') ?? totals.total
      const cashierId = await cashierFor(str(head.cashier, 101))
      const sessionId = await sessionFor(cashierId, when)

      const [result] = await connection.execute<ResultSetHeader>(
        `INSERT INTO transactions (receipt_number, cashier_id, session_id, terminal_id, transaction_date, customer_type, senior_pwd_id, senior_pwd_name,
           subtotal, discount_total, vatable_sales, vat_exempt_sales, tax_amount, total_amount, payment_method, payment_reference, amount_received, change_given)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          receipt, cashierId, sessionId, SYSTEM_TERMINAL_ID, when, customerType.toLowerCase(), seniorId, seniorName,
          totals.gross, totals.discount, customerType === 'Regular' ? round2(totals.gross - totals.vat) : 0, totals.vatExempt, totals.vat, totals.total,
          payment ?? 'cash', str(head.reference, 60), received, round2(Math.max(0, received - totals.total)),
        ],
      )
      for (const item of items) {
        await connection.execute('INSERT INTO transaction_items (transaction_id, product_id, product_name, quantity, unit_price, subtotal) VALUES (?, ?, ?, ?, ?, ?)', [
          result.insertId, item.product.product_id, item.product.product_name, item.qty, item.price, round2(item.price * item.qty),
        ])
      }
      return 'inserted'
    })
  }

  for (const session of sessions.values()) {
    await connection.execute('UPDATE sessions SET assigned_at = ?, login_time = ?, logout_time = ? WHERE session_id = ?', [session.first, session.first, session.last, session.session_id])
  }
  notes.add('Imported sales are history only: they do not change current stock. Import products with their current stock for that.')
}

const WASTE_WORDS: [RegExp, string][] = [
  [/expir/i, 'expired'], [/damag|broke|crush|dent|leak/i, 'damaged'], [/spoil|rot|mold|mould|bad/i, 'spoiled'],
  [/theft|stol|shrink|missing|lost/i, 'theft'], [/return/i, 'customer_return'],
]

async function importWaste(connection: PoolConnection, actor: Actor, rows: ImportRow[], each: (row: ImportRow, work: () => Promise<Outcome>) => Promise<void>, notes: Set<string>) {
  const index = await productIndex(connection)
  for (const row of rows) {
    await each(row, async () => {
      const product = index.require(row)
      const qty = int(row.qty, 'Quantity', { required: true, min: 1 })!
      const when = date(row.date, 'Date', true)!
      const reasonText = str(row.reason) ?? ''
      const reason = WASTE_WORDS.find(([pattern]) => pattern.test(reasonText))?.[1] ?? 'other'
      const [dupe] = await connection.query<RowDataPacket[]>('SELECT 1 FROM waste_records WHERE product_id = ? AND waste_date = ? AND quantity = ? AND reason = ?', [product.product_id, when, qty, reason])
      if (dupe.length) return 'skipped'
      const notesText = [reason === 'other' && reasonText ? reasonText : null, str(row.notes)].filter(Boolean).join(' · ').slice(0, 255) || null
      await connection.execute('INSERT INTO waste_records (product_id, inventory_id, user_id, quantity, reason, notes, waste_date) VALUES (?, ?, ?, ?, ?, ?, ?)', [
        product.product_id, await firstBatch(connection, product.product_id, actor), actor.user_id, qty, reason, notesText, when,
      ])
      return 'inserted'
    })
  }
  notes.add('Imported waste is history only: it does not change current stock.')
}

const REQUEST_WORDS: [RegExp, string][] = [
  [/declin|reject|cancel|not avail/i, 'declined'], [/order/i, 'ordered'], [/review|check/i, 'reviewing'],
  [/stock|avail|done|fulfil|closed|complete/i, 'available'], [/new|pending|open/i, 'pending'],
]

async function importRequests(connection: PoolConnection, _actor: Actor, rows: ImportRow[], each: (row: ImportRow, work: () => Promise<Outcome>) => Promise<void>) {
  for (const row of rows) {
    await each(row, async () => {
      const item = str(row.item, 100)
      if (!item) throw new RowError('Requested item is missing')
      const when = date(row.date, 'Date') ?? null
      const by = str(row.requested_by, 100)
      const statusText = str(row.status) ?? ''
      const status = REQUEST_WORDS.find(([pattern]) => pattern.test(statusText))?.[1] ?? 'pending'
      const [dupe] = await connection.query<RowDataPacket[]>(
        'SELECT 1 FROM customer_requests WHERE LOWER(product_name_requested) = ? AND request_date <=> ? AND requested_by <=> ?',
        [item.toLowerCase(), when, by],
      )
      if (dupe.length) return 'skipped'
      await connection.execute(
        'INSERT INTO customer_requests (cashier_id, product_name_requested, category, requested_by, contact, quantity_requested, request_date, status, notes) VALUES (NULL, ?, ?, ?, ?, ?, COALESCE(?, NOW()), ?, ?)',
        [item, str(row.category, 50), by, str(row.contact, 100), int(row.quantity, 'Quantity'), when, status, str(row.notes)],
      )
      return 'inserted'
    })
  }
}

// ---------------------------------------------------------------------------

export async function importData(actor: Actor, kind: ImportKind, rows: ImportRow[], dryRun: boolean): Promise<ImportResult> {
  if (!rows.length) throw HttpError.badRequest('The file has no rows to import')
  const result: ImportResult = { kind, dry_run: dryRun, total_rows: rows.length, inserted: 0, updated: 0, skipped: 0, errors: [], notes: [] }
  const notes = new Set<string>()

  try {
    await withTransaction(async (connection) => {
      // Each row (or receipt) gets a savepoint, so a bad row is undone on its own and the rest still import.
      let n = 0
      const each = async (row: ImportRow, work: () => Promise<Outcome>) => {
        const savepoint = `row_${n++}`
        await connection.query(`SAVEPOINT ${savepoint}`)
        try {
          result[await work()]++
          await connection.query(`RELEASE SAVEPOINT ${savepoint}`)
        } catch (error) {
          await connection.query(`ROLLBACK TO SAVEPOINT ${savepoint}`)
          if (!(error instanceof RowError) && !(error as { sqlMessage?: string }).sqlMessage) throw error
          const message = error instanceof RowError ? error.message : `Database rejected this row: ${(error as { sqlMessage: string }).sqlMessage}`
          if (result.errors.length < 500) result.errors.push({ row: Number(row._row ?? 0), message })
        }
      }
      if (kind === 'products') await importProducts(connection, actor, rows, each)
      else if (kind === 'employees') await importEmployees(connection, actor, rows, each)
      else if (kind === 'sales') await importSales(connection, actor, rows, each, notes)
      else if (kind === 'waste') await importWaste(connection, actor, rows, each, notes)
      else await importRequests(connection, actor, rows, each)

      result.notes = [...notes]
      if (dryRun) throw new DryRunDone(result)
      await logAudit(
        { user_id: actor.user_id, session_id: actor.session_id, terminal_id: actor.terminal_id, ip_address: actor.ip_address, action: 'IMPORT_DATA', module: 'ADMIN',
          details: { kind, rows: rows.length, inserted: result.inserted, updated: result.updated, skipped: result.skipped, errors: result.errors.length } },
        connection,
      )
    })
  } catch (error) {
    if (error instanceof DryRunDone) return error.result
    throw error
  }
  return result
}
