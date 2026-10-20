import type { Request, RequestHandler } from 'express'
import type { RowDataPacket } from 'mysql2/promise'
import { getPool, withTransaction } from '../config/db.js'
import { getActiveUser, verifyOwnerToken, verifyTerminalToken } from '../services/auth.service.js'
import { SYSTEM_TERMINAL_ID } from '../services/session.service.js'
import { ownerSession, type Actor } from '../services/store.service.js'
import { HttpError } from '../utils/httpError.js'
import { clientIp } from '../utils/ip.js'
import { bearerToken } from './auth.js'

/**
 * For store data (products, sales, waste, requests): either the signed-in owner (Authorization: Bearer)
 * or a cashier terminal with an active session (X-Session-Token, from the terminal's status poll).
 * The terminal token is re-checked against the sessions table, so ending a shift cuts access immediately.
 */
export const requireStoreUser: RequestHandler = async (req, _res, next) => {
  const ownerToken = bearerToken(req.headers.authorization)
  if (ownerToken) {
    const user = await getActiveUser(Number(verifyOwnerToken(ownerToken).sub))
    if (!user) throw HttpError.unauthorized('This account is no longer active')
    // The default admin (admin / 000000) can't touch store data until the owner has set up their own account.
    if (user.must_change_credentials) throw new HttpError(403, 'Finish setting up your account first', { code: 'ACCOUNT_SETUP_REQUIRED' })
    req.user = user
    return next()
  }

  const sessionToken = req.header('x-session-token')
  if (!sessionToken) throw HttpError.unauthorized()
  const claims = verifyTerminalToken(sessionToken)
  const [rows] = await getPool().query<RowDataPacket[]>(
    'SELECT is_paused FROM sessions WHERE session_id = ? AND terminal_id = ? AND user_id = ? AND is_active = TRUE',
    [claims.session_id, claims.terminal_id, claims.user_id],
  )
  if (!rows.length) throw HttpError.unauthorized('This shift has ended. Wait for the owner to assign a cashier.')
  if (rows[0]!.is_paused) throw HttpError.unauthorized('This shift is paused. Ask the owner to resume it.')
  req.terminalSession = claims
  next()
}

/** Use after requireStoreUser for owner-only store actions (editing the catalog, importing). */
export const requireOwnerUser: RequestHandler = (req, _res, next) => {
  if (req.user?.role !== 'Owner') throw HttpError.forbidden('Only the owner can do this')
  next()
}

/** Who a store change is recorded under: the cashier session on this terminal, or the owner's session on PC-00 (opened on first use). */
export async function actorFor(req: Request): Promise<Actor> {
  const ip_address = clientIp(req)
  if (req.terminalSession) return { ...req.terminalSession, ip_address }
  if (!req.user) throw HttpError.unauthorized()
  const userId = req.user.user_id
  const session_id = await withTransaction((connection) => ownerSession(connection, userId))
  return { user_id: userId, session_id, terminal_id: SYSTEM_TERMINAL_ID, ip_address }
}
