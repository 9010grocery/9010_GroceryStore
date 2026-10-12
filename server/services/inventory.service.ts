import type { RowDataPacket } from 'mysql2/promise'
import { getPool } from '../config/db.js'
import { HttpError } from '../utils/httpError.js'
import { toIso } from '../utils/pos.js'

// Read-only inventory views. Changing stock lives in store.service.ts (receiveStock, adjustProductStock, deleteProduct).

const MOVEMENT_LABELS = { sale: 'Sale', receive: 'Delivery', waste: 'Waste', adjustment: 'Adjustment', void_return: 'Return to stock' } as const

/** Active products at or below their reorder level, worst first. Out-of-stock items come before low ones. */
export async function lowStock() {
  const [rows] = await getPool().query<RowDataPacket[]>(
    `SELECT * FROM (
       SELECT p.product_id, p.product_name, p.category, p.supplier_name, p.unit_of_measure, p.reorder_level, p.lead_time_days,
              COALESCE(SUM(i.quantity_on_hand), 0) AS stock
         FROM products p LEFT JOIN inventory i ON i.product_id = p.product_id
        WHERE p.is_active = TRUE AND p.deleted_at IS NULL
        GROUP BY p.product_id
     ) s
      WHERE stock <= reorder_level
      ORDER BY stock <= 0 DESC, stock / GREATEST(reorder_level, 1), product_name`,
  )
  return rows.map((row) => ({
    productId: `p${row.product_id}`,
    name: row.product_name as string,
    category: (row.category as string | null) ?? 'Uncategorized',
    supplierName: (row.supplier_name as string | null) ?? null,
    unit: (row.unit_of_measure as string | null) ?? 'pc',
    stock: Number(row.stock),
    reorderPoint: Number(row.reorder_level ?? 0),
    shortfall: Math.max(0, Number(row.reorder_level ?? 0) - Number(row.stock)),
    leadTimeDays: row.lead_time_days === null ? null : Number(row.lead_time_days),
    outOfStock: Number(row.stock) <= 0,
  }))
}

/** Batches with stock that expire within `days` days (or already have), soonest first. */
export async function expiring(days: number) {
  const [rows] = await getPool().query<RowDataPacket[]>(
    `SELECT i.inventory_id, i.product_id, p.product_name, p.unit_of_measure, i.batch_number, i.expiry_date, i.quantity_on_hand,
            DATEDIFF(i.expiry_date, CURDATE()) AS days_left
       FROM inventory i JOIN products p ON p.product_id = i.product_id
      WHERE i.quantity_on_hand > 0 AND i.expiry_date IS NOT NULL AND p.deleted_at IS NULL AND p.is_active = TRUE
        AND i.expiry_date <= DATE_ADD(CURDATE(), INTERVAL ? DAY)
      ORDER BY i.expiry_date, p.product_name`,
    [days],
  )
  return rows.map((row) => ({
    batchId: `b${row.inventory_id}`,
    productId: `p${row.product_id}`,
    name: row.product_name as string,
    unit: (row.unit_of_measure as string | null) ?? 'pc',
    batchNumber: (row.batch_number as string | null) ?? null,
    expiry: String(row.expiry_date).slice(0, 10),
    qty: Number(row.quantity_on_hand),
    daysLeft: Number(row.days_left),
    expired: Number(row.days_left) < 0,
  }))
}

/** Stock movements for one product, newest first. Page back with `before` = the last adjustmentId you got. */
export async function movements(productId: number, options: { limit: number; before?: number }) {
  const [product] = await getPool().query<RowDataPacket[]>(
    `SELECT p.product_name, p.unit_of_measure, COALESCE((SELECT SUM(i.quantity_on_hand) FROM inventory i WHERE i.product_id = p.product_id), 0) AS stock
       FROM products p WHERE p.product_id = ?`,
    [productId],
  )
  if (!product[0]) throw HttpError.notFound('Product not found')
  const [rows] = await getPool().query<RowDataPacket[]>(
    `SELECT a.adjustment_id, a.quantity_change, a.reason, a.adjustment_type, a.reference_id, a.adjustment_date,
            i.batch_number, i.expiry_date, CONCAT(u.first_name, ' ', u.last_name) AS user_name
       FROM inventory_adjustments a
       JOIN inventory i ON i.inventory_id = a.inventory_id
       JOIN users u ON u.user_id = a.user_id
      WHERE i.product_id = ? ${options.before ? 'AND a.adjustment_id < ?' : ''}
      ORDER BY a.adjustment_id DESC
      LIMIT ?`,
    options.before ? [productId, options.before, options.limit + 1] : [productId, options.limit + 1],
  )
  const page = rows.slice(0, options.limit)
  return {
    productId: `p${productId}`,
    name: product[0].product_name as string,
    unit: (product[0].unit_of_measure as string | null) ?? 'pc',
    stock: Number(product[0].stock),
    hasMore: rows.length > options.limit,
    movements: page.map((row) => ({
      adjustmentId: Number(row.adjustment_id),
      date: toIso(row.adjustment_date) ?? '',
      type: row.adjustment_type as keyof typeof MOVEMENT_LABELS,
      label: MOVEMENT_LABELS[row.adjustment_type as keyof typeof MOVEMENT_LABELS] ?? String(row.adjustment_type),
      change: Number(row.quantity_change),
      reason: (row.reason as string | null) ?? '',
      batchNumber: (row.batch_number as string | null) ?? null,
      expiry: row.expiry_date ? String(row.expiry_date).slice(0, 10) : null,
      by: String(row.user_name ?? '').trim(),
      reference: row.reference_id === null ? null : Number(row.reference_id),
    })),
  }
}
