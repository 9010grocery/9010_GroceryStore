import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { getPool, withTransaction } from '../config/db.js'
import { HttpError } from '../utils/httpError.js'
import { logAudit } from './audit.service.js'
import { verifyOwnerPin } from './auth.service.js'
import { businessInfo, DISCOUNT_APPROVAL_MINUTES, discountThreshold, loadTransaction, type Actor } from './store.service.js'

// POS helpers that aren't part of ringing up the sale itself: reprinting a receipt, and the owner's approval
// for a discount above the threshold.

/** The receipt as printed: the sale, who rang it up, and the business name, TIN and address from Settings. */
export async function receiptData(actor: Actor, transactionId: number, options: { reprint: boolean }) {
  if (options.reprint) {
    const [updated] = await getPool().execute<ResultSetHeader>('UPDATE transactions SET reprint_count = reprint_count + 1 WHERE transaction_id = ?', [transactionId])
    if (!updated.affectedRows) throw HttpError.notFound('Receipt not found')
  }
  const transaction = await loadTransaction(getPool(), transactionId)
  const [cashier] = await getPool().query<RowDataPacket[]>("SELECT CONCAT(first_name, ' ', last_name) AS name FROM users WHERE user_id = ?", [Number(transaction.cashierId.replace(/^u/, ''))])
  if (options.reprint) {
    await logAudit({
      user_id: actor.user_id, session_id: actor.session_id, terminal_id: actor.terminal_id, ip_address: actor.ip_address, action: 'REPRINT_RECEIPT', module: 'POS',
      details: { receipt: transaction.number, reprint_count: transaction.reprintCount },
    })
  }
  return {
    transaction,
    business: await businessInfo(),
    cashier_name: String(cashier[0]?.name ?? '').trim(),
    reprint: options.reprint,
  }
}

export interface DiscountVerdict {
  /** The percent asked for is above the store's threshold, so the owner's PIN is needed. */
  requires_approval: boolean
  /** Safe to ring up now: either within the threshold, or the owner just approved it. */
  approved: boolean
  percent: number
  threshold: number
  /** Send this with the sale (discount_override_id). Only present after the owner's PIN was accepted. */
  override_id?: number
  approved_by?: string
  valid_minutes?: number
}

/**
 * Asks whether a cashier may give `percent` off. Within the threshold (Settings, 20% by default) no approval is needed.
 * Above it the owner's PIN is checked (shared lockout), an approval is recorded in supervisor_overrides, and its id is
 * returned for the sale to carry.
 */
export async function verifyDiscount(
  actor: Actor,
  input: { percent: number; owner_pin?: string; reason?: string },
  pinContext: { ip_address: string | null; terminal_id: string | null; session_id: number | null },
): Promise<DiscountVerdict> {
  const threshold = await discountThreshold()
  const percent = input.percent
  if (percent <= threshold) return { requires_approval: false, approved: true, percent, threshold }
  if (!input.owner_pin) return { requires_approval: true, approved: false, percent, threshold }

  const approval = await verifyOwnerPin(input.owner_pin, { ...pinContext, purpose: 'discount' })
  const overrideId = await withTransaction(async (connection) => {
    const [result] = await connection.execute<ResultSetHeader>(
      `INSERT INTO supervisor_overrides (session_id, terminal_id, requested_by, approved_by, action_type, reference_id, details, reason)
       VALUES (?, ?, ?, ?, 'discount', NULL, ?, ?)`,
      [actor.session_id, actor.terminal_id, actor.user_id, approval.owner_id, JSON.stringify({ percent, threshold }), (input.reason ?? '').slice(0, 255) || null],
    )
    await logAudit({
      user_id: actor.user_id, session_id: actor.session_id, terminal_id: actor.terminal_id, ip_address: actor.ip_address, action: 'DISCOUNT_APPROVED', module: 'POS',
      details: { percent, threshold, approved_by: approval.owner_id, override_id: result.insertId },
    }, connection)
    return result.insertId
  })
  return { requires_approval: true, approved: true, percent, threshold, override_id: overrideId, approved_by: approval.owner_name, valid_minutes: DISCOUNT_APPROVAL_MINUTES }
}
