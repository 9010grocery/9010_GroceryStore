import type { RowDataPacket } from 'mysql2/promise'
import { withTransaction } from '../config/db.js'
import { HttpError } from '../utils/httpError.js'
import { logAudit } from './audit.service.js'
import { SYSTEM_TERMINAL_ID } from './session.service.js'
import type { Actor } from './store.service.js'

/** Everything that keeps a person's name on a business record. If any exist, the person can only be deactivated. */
const HISTORY: Array<{ label: string; sql: string; params: 1 | 2 | 3 }> = [
  { label: 'sale or void', sql: 'SELECT COUNT(*) AS n FROM transactions WHERE cashier_id = ? OR voided_by = ?', params: 2 },
  { label: 'refund', sql: 'SELECT COUNT(*) AS n FROM refunds WHERE processed_by = ? OR approved_by = ?', params: 2 },
  { label: 'stock movement', sql: 'SELECT COUNT(*) AS n FROM inventory_adjustments WHERE user_id = ?', params: 1 },
  { label: 'waste record', sql: 'SELECT COUNT(*) AS n FROM waste_records WHERE user_id = ?', params: 1 },
  { label: 'customer request', sql: 'SELECT COUNT(*) AS n FROM customer_requests WHERE cashier_id = ? OR reviewed_by = ?', params: 2 },
  { label: 'reorder list', sql: 'SELECT COUNT(*) AS n FROM reorder_lists WHERE created_by = ? OR approved_by = ?', params: 2 },
  { label: 'purchase order', sql: 'SELECT COUNT(*) AS n FROM purchase_orders WHERE created_by = ?', params: 1 },
  { label: 'supervisor override', sql: 'SELECT COUNT(*) AS n FROM supervisor_overrides WHERE requested_by = ? OR approved_by = ?', params: 2 },
  { label: 'X/Z reading', sql: 'SELECT COUNT(*) AS n FROM readings WHERE cashier_id = ?', params: 1 },
]

/**
 * Permanently deletes a cashier who has no business history. Their shifts (which carry no sales) are removed, an
 * open shift is ended, and audit entries that mention them are kept with the person detached; a DELETE_EMPLOYEE
 * entry records who they were. The owner account, and yourself, can never be deleted.
 */
export async function deleteEmployee(actor: Actor, userId: number) {
  return withTransaction(async (connection) => {
    const [rows] = await connection.query<RowDataPacket[]>(
      'SELECT u.first_name, u.last_name, u.email, r.role_name FROM users u JOIN roles r ON r.role_id = u.role_id WHERE u.user_id = ? FOR UPDATE',
      [userId],
    )
    const person = rows[0]
    if (!person) throw HttpError.notFound('Employee not found')
    const name = `${person.first_name} ${person.last_name ?? ''}`.trim()
    if (person.role_name === 'Owner') throw HttpError.conflict("The owner account can't be deleted")
    if (userId === actor.user_id) throw HttpError.conflict("You can't delete your own account")

    const found: string[] = []
    for (const check of HISTORY) {
      const [count] = await connection.query<RowDataPacket[]>(check.sql, Array(check.params).fill(userId))
      const n = Number(count[0]?.n ?? 0)
      if (n > 0) found.push(`${n} ${check.label}${n === 1 ? '' : 's'}`)
    }
    if (found.length) {
      throw HttpError.conflict(`${name} can't be deleted because they have ${found.join(', ')} on record. Deactivate them instead: that keeps the history and locks their access.`, { history: found })
    }

    const [open] = await connection.query<RowDataPacket[]>('SELECT terminal_id FROM sessions WHERE user_id = ? AND is_active = TRUE AND terminal_id <> ?', [userId, SYSTEM_TERMINAL_ID])
    const endedShiftOn = (open[0]?.terminal_id as string | undefined) ?? null

    await logAudit({
      user_id: actor.user_id, session_id: actor.session_id, terminal_id: actor.terminal_id, ip_address: actor.ip_address,
      action: 'DELETE_EMPLOYEE', module: 'ADMIN', details: { employee_id: userId, name, email: person.email ?? null, ended_shift_on: endedShiftOn },
    }, connection)
    // Keep the audit trail, but let go of the person and their shifts so the rows can be removed.
    await connection.execute('UPDATE audit_logs SET user_id = NULL WHERE user_id = ?', [userId])
    await connection.execute('UPDATE audit_logs SET session_id = NULL WHERE session_id IN (SELECT session_id FROM sessions WHERE user_id = ?)', [userId])
    await connection.execute('DELETE FROM sessions WHERE user_id = ?', [userId])
    try {
      await connection.execute('DELETE FROM users WHERE user_id = ?', [userId])
    } catch (error) {
      if ((error as { code?: string }).code === 'ER_ROW_IS_REFERENCED_2') throw HttpError.conflict(`${name} is still referenced by other records, so can't be deleted. Deactivate them instead.`)
      throw error
    }
    return { id: `u${userId}`, name, endedShiftOn }
  })
}