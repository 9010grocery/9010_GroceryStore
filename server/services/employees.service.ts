import type { RowDataPacket } from 'mysql2/promise'
import { getPool } from '../config/db.js'
import { HttpError } from '../utils/httpError.js'
import { round2, toIso } from '../utils/pos.js'
import { loadEmployees } from './store.service.js'
import { SYSTEM_TERMINAL_ID } from './session.service.js'

// Read side of the Employees screen. Creating, editing and (de)activating is saveEmployee in store.service.ts.

/** Everyone, with what they sold in the last 7 days and the terminal they are on right now. */
export async function listEmployees(filters: { status?: 'Active' | 'On leave' | 'Inactive'; q?: string }) {
  const all = await loadEmployees(getPool())
  const [stats] = await getPool().query<RowDataPacket[]>(
    `SELECT t.cashier_id, COUNT(*) AS receipts, COALESCE(SUM(t.total_amount), 0) AS total
       FROM transactions t WHERE t.status <> 'voided' AND t.transaction_date >= DATE_SUB(NOW(), INTERVAL 7 DAY) GROUP BY t.cashier_id`,
  )
  const [open] = await getPool().query<RowDataPacket[]>('SELECT user_id, terminal_id FROM sessions WHERE is_active = TRUE AND terminal_id <> ?', [SYSTEM_TERMINAL_ID])
  const q = filters.q?.trim().toLowerCase()
  return all
    .filter((e) => (!filters.status || e.status === filters.status) && (!q || e.name.toLowerCase().includes(q) || e.email.toLowerCase().includes(q)))
    .map((e) => {
      const uid = Number(e.id.slice(1))
      const s = stats.find((r) => r.cashier_id === uid)
      return { ...e, receiptsWeek: Number(s?.receipts ?? 0), salesWeek: round2(Number(s?.total ?? 0)), onTerminal: (open.find((r) => r.user_id === uid)?.terminal_id as string | undefined) ?? null }
    })
}

/** One employee's shifts, sales and voids over the last `days` days. */
export async function employeeActivity(userId: number, days: number) {
  const [employee] = await loadEmployees(getPool(), userId)
  if (!employee) throw HttpError.notFound('Employee not found')
  const [sessions] = await getPool().query<RowDataPacket[]>(
    `SELECT s.session_id, s.terminal_id, s.assigned_at, s.login_time, s.logout_time, s.is_active, s.end_reason,
            (SELECT COUNT(*) FROM transactions t WHERE t.session_id = s.session_id AND t.status <> 'voided') AS receipts,
            (SELECT COALESCE(SUM(t.total_amount), 0) FROM transactions t WHERE t.session_id = s.session_id AND t.status <> 'voided') AS sales
       FROM sessions s WHERE s.user_id = ? AND s.assigned_at >= DATE_SUB(NOW(), INTERVAL ? DAY) ORDER BY s.assigned_at DESC LIMIT 30`,
    [userId, days],
  )
  const [totals] = await getPool().query<RowDataPacket[]>(
    `SELECT COUNT(CASE WHEN t.status <> 'voided' THEN 1 END) AS receipts,
            COALESCE(SUM(CASE WHEN t.status <> 'voided' THEN t.total_amount END), 0) AS sales,
            COUNT(CASE WHEN t.status = 'voided' THEN 1 END) AS voids,
            COALESCE(SUM(CASE WHEN t.status = 'voided' THEN t.total_amount END), 0) AS void_amount,
            COALESCE(SUM(CASE WHEN t.status <> 'voided' THEN t.discount_total END), 0) AS discounts
       FROM transactions t WHERE t.cashier_id = ? AND t.transaction_date >= DATE_SUB(NOW(), INTERVAL ? DAY)`,
    [userId, days],
  )
  const [refunds] = await getPool().query<RowDataPacket[]>(
    `SELECT COUNT(*) AS n, COALESCE(SUM(r.refund_amount), 0) AS amount FROM refunds r JOIN transactions t ON t.transaction_id = r.transaction_id
      WHERE t.cashier_id = ? AND r.refunded_at >= DATE_SUB(NOW(), INTERVAL ? DAY)`,
    [userId, days],
  )
  const [voids] = await getPool().query<RowDataPacket[]>(
    `SELECT t.receipt_number, t.total_amount, t.void_reason, t.voided_at FROM transactions t
      WHERE t.cashier_id = ? AND t.status = 'voided' AND t.voided_at >= DATE_SUB(NOW(), INTERVAL ? DAY) ORDER BY t.voided_at DESC LIMIT 10`,
    [userId, days],
  )
  const t = totals[0]
  return {
    employee,
    days,
    totals: {
      receipts: Number(t.receipts), sales: round2(Number(t.sales)), voids: Number(t.voids), voidAmount: round2(Number(t.void_amount)),
      refunds: Number(refunds[0].n), refundAmount: round2(Number(refunds[0].amount)), discounts: round2(Number(t.discounts)),
    },
    sessions: sessions.map((s) => ({
      id: `s${s.session_id}`,
      terminalId: s.terminal_id as string,
      start: toIso(s.login_time ?? s.assigned_at) ?? '',
      end: s.logout_time ? toIso(s.logout_time) : null,
      active: Boolean(s.is_active),
      endReason: (s.end_reason as string | null) ?? null,
      receipts: Number(s.receipts),
      sales: round2(Number(s.sales)),
    })),
    recentVoids: voids.map((v) => ({ receipt: v.receipt_number as string, amount: round2(Number(v.total_amount)), reason: (v.void_reason as string | null) ?? '', at: toIso(v.voided_at) ?? '' })),
  }
}
