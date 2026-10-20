import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { getPool, withTransaction } from '../config/db.js'
import { HttpError } from '../utils/httpError.js'
import { logAudit } from './audit.service.js'
import { signTerminalToken, type RoleName } from './auth.service.js'

/**
 * Not a real cashier PC: owner sales on the server PC and imported history are recorded on it
 * (database/migrations/002). Hidden from Admin Station and terminal setup; never assignable.
 */
export const SYSTEM_TERMINAL_ID = 'PC-00'

/** A terminal counts as online if it polled within this many seconds (terminals poll every 2 s). */
export const ONLINE_WITHIN_SECONDS = 10

export interface RequestInfo {
  ip_address: string | null
}

export interface SessionSummary {
  session_id: number
  user_id: number
  cashier_name: string
  terminal_id: string
  assigned_at: string
  login_time: string | null
  assigned_by: number
  /** Terminal locked but the shift is still open (see pauseShift). */
  is_paused: boolean
  paused_at: string | null
}

export interface TerminalSummary {
  terminal_id: string
  terminal_name: string | null
  ip_address: string | null
  is_active: boolean
  last_seen: string | null
  online: boolean
  session: SessionSummary | null
}

export interface EmployeeSummary {
  user_id: number
  first_name: string
  last_name: string
  name: string
  email: string | null
  phone: string | null
  role: RoleName
  is_active: boolean
  assigned_terminal: string | null
  session_id: number | null
  assigned_at: string | null
}

export interface TerminalStatus {
  terminal_id: string
  terminal_name: string | null
  assigned: boolean
  is_locked: boolean
  session_id: number | null
  user: { user_id: number; name: string } | null
  assigned_at: string | null
  login_time: string | null
  /** The cashier's shift is paused: the terminal is locked, and only the owner can resume it. */
  paused: boolean
  /** Sent while assigned; the POS uses it to act on behalf of this session. */
  session_token: string | null
  server_time: string
}

const isDuplicate = (error: unknown) => (error as { code?: string })?.code === 'ER_DUP_ENTRY'

const SESSION_SELECT = `s.session_id, s.user_id, CONCAT(u.first_name, ' ', u.last_name) AS cashier_name, s.terminal_id,
  s.assigned_at, s.login_time, s.assigned_by, s.is_paused, s.paused_at`

function toSession(row: RowDataPacket): SessionSummary {
  return {
    session_id: row.session_id,
    user_id: row.user_id,
    cashier_name: row.cashier_name,
    terminal_id: row.terminal_id,
    assigned_at: row.assigned_at,
    login_time: row.login_time,
    assigned_by: row.assigned_by,
    is_paused: Boolean(row.is_paused),
    paused_at: row.paused_at ?? null,
  }
}

// ---------------------------------------------------------------------------
// Admin Station (owner)
// ---------------------------------------------------------------------------

export async function listTerminals(): Promise<TerminalSummary[]> {
  const [rows] = await getPool().query<RowDataPacket[]>(
    // t.terminal_id comes after the session columns so it is not overwritten by NULL when there is no session.
    `SELECT ${SESSION_SELECT},
            t.terminal_id, t.terminal_name, t.ip_address, t.is_active, t.last_seen,
            TIMESTAMPDIFF(SECOND, t.last_seen, NOW()) AS seconds_since_seen
       FROM terminals t
       LEFT JOIN sessions s ON s.terminal_id = t.terminal_id AND s.is_active = TRUE
       LEFT JOIN users u ON u.user_id = s.user_id
      WHERE t.terminal_id <> ?
      ORDER BY t.terminal_id`,
    [SYSTEM_TERMINAL_ID],
  )
  return rows.map((row) => ({
    terminal_id: row.terminal_id,
    terminal_name: row.terminal_name,
    ip_address: row.ip_address,
    is_active: Boolean(row.is_active),
    last_seen: row.last_seen,
    online: row.seconds_since_seen !== null && Number(row.seconds_since_seen) <= ONLINE_WITHIN_SECONDS,
    session: row.session_id ? toSession(row) : null,
  }))
}

async function terminalById(terminalId: string): Promise<TerminalSummary> {
  const terminal = (await listTerminals()).find((t) => t.terminal_id === terminalId)
  if (!terminal) throw HttpError.notFound(`Terminal ${terminalId} does not exist`)
  return terminal
}

/** Adds a cashier PC (e.g. PC-04). The PC itself is set up with the same ID on first launch. */
export async function createTerminal(ownerId: number, input: { terminal_id: string; terminal_name: string | null }, info: RequestInfo): Promise<TerminalSummary> {
  await withTransaction(async (connection) => {
    try {
      await connection.execute('INSERT INTO terminals (terminal_id, terminal_name) VALUES (?, ?)', [input.terminal_id, input.terminal_name])
    } catch (error) {
      if (isDuplicate(error)) throw HttpError.conflict(`${input.terminal_id} already exists`)
      throw error
    }
    await logAudit(
      { user_id: ownerId, action: 'CREATE_TERMINAL', module: 'ADMIN', terminal_id: input.terminal_id, ip_address: info.ip_address, details: { terminal_name: input.terminal_name } },
      connection,
    )
  })
  return terminalById(input.terminal_id)
}

/** Renames a terminal or enables/disables it. A terminal with a cashier on shift cannot be disabled. */
export async function updateTerminal(
  ownerId: number,
  terminalId: string,
  changes: { terminal_name?: string | null; is_active?: boolean },
  info: RequestInfo,
): Promise<TerminalSummary> {
  await withTransaction(async (connection) => {
    const [rows] = await connection.query<RowDataPacket[]>('SELECT terminal_name, is_active FROM terminals WHERE terminal_id = ? FOR UPDATE', [terminalId])
    if (!rows[0]) throw HttpError.notFound(`Terminal ${terminalId} does not exist`)
    if (changes.is_active === false) {
      const [busy] = await connection.query<RowDataPacket[]>('SELECT session_id FROM sessions WHERE terminal_id = ? AND is_active = TRUE', [terminalId])
      if (busy.length) throw HttpError.conflict(`${terminalId} has a cashier on shift. End that shift first.`)
    }
    const name = changes.terminal_name === undefined ? rows[0].terminal_name : changes.terminal_name
    const active = changes.is_active === undefined ? Boolean(rows[0].is_active) : changes.is_active
    await connection.execute('UPDATE terminals SET terminal_name = ?, is_active = ? WHERE terminal_id = ?', [name, active, terminalId])
    await logAudit(
      {
        user_id: ownerId,
        action: 'UPDATE_TERMINAL',
        module: 'ADMIN',
        terminal_id: terminalId,
        ip_address: info.ip_address,
        details: { before: { terminal_name: rows[0].terminal_name, is_active: Boolean(rows[0].is_active) }, after: { terminal_name: name, is_active: active } },
      },
      connection,
    )
  })
  return terminalById(terminalId)
}

/**
 * Removes a terminal that was added by mistake. Once a terminal has shifts or sales it is kept for the records
 * (sessions, sales and readings point at it), so the owner disables it instead.
 */
export async function deleteTerminal(ownerId: number, terminalId: string, info: RequestInfo): Promise<void> {
  await withTransaction(async (connection) => {
    const [rows] = await connection.query<RowDataPacket[]>('SELECT terminal_id FROM terminals WHERE terminal_id = ? FOR UPDATE', [terminalId])
    if (!rows[0]) throw HttpError.notFound(`Terminal ${terminalId} does not exist`)
    try {
      await connection.execute('DELETE FROM terminals WHERE terminal_id = ?', [terminalId])
    } catch (error) {
      if ((error as { code?: string })?.code === 'ER_ROW_IS_REFERENCED_2') {
        throw HttpError.conflict(`${terminalId} has shift or sales history, so it can't be deleted. Disable it instead.`)
      }
      throw error
    }
    await logAudit({ user_id: ownerId, action: 'DELETE_TERMINAL', module: 'ADMIN', terminal_id: terminalId, ip_address: info.ip_address }, connection)
  })
}

export async function listEmployees(): Promise<EmployeeSummary[]> {
  const [rows] = await getPool().query<RowDataPacket[]>(
    `SELECT u.user_id, u.first_name, u.last_name, u.email, u.phone, u.is_active, r.role_name,
            s.session_id, s.terminal_id, s.assigned_at
       FROM users u
       JOIN roles r ON r.role_id = u.role_id
       LEFT JOIN sessions s ON s.user_id = u.user_id AND s.is_active = TRUE
      ORDER BY u.is_active DESC, r.role_name = 'Owner' DESC, u.last_name, u.first_name`,
  )
  return rows.map((row) => ({
    user_id: row.user_id,
    first_name: row.first_name,
    last_name: row.last_name,
    name: `${row.first_name} ${row.last_name}`,
    email: row.email,
    phone: row.phone,
    role: row.role_name,
    is_active: Boolean(row.is_active),
    assigned_terminal: row.terminal_id ?? null,
    session_id: row.session_id ?? null,
    assigned_at: row.assigned_at ?? null,
  }))
}

export async function listActiveSessions(): Promise<SessionSummary[]> {
  const [rows] = await getPool().query<RowDataPacket[]>(
    `SELECT ${SESSION_SELECT} FROM sessions s JOIN users u ON u.user_id = s.user_id WHERE s.is_active = TRUE ORDER BY s.terminal_id`,
  )
  return rows.map(toSession)
}

/** Assigns a cashier to a terminal. One active session per terminal and per cashier (also enforced by the database). */
export async function assignTerminal(ownerId: number, userId: number, terminalId: string, info: RequestInfo): Promise<SessionSummary> {
  return withTransaction(async (connection) => {
    const [terminals] = await connection.query<RowDataPacket[]>('SELECT terminal_id, is_active FROM terminals WHERE terminal_id = ? FOR UPDATE', [terminalId])
    if (!terminals[0]) throw HttpError.notFound(`Terminal ${terminalId} does not exist`)
    if (!terminals[0].is_active) throw HttpError.conflict(`Terminal ${terminalId} is disabled`)

    const [users] = await connection.query<RowDataPacket[]>(
      `SELECT u.user_id, u.first_name, u.last_name, u.is_active, r.role_name
         FROM users u JOIN roles r ON r.role_id = u.role_id WHERE u.user_id = ? FOR UPDATE`,
      [userId],
    )
    const user = users[0]
    if (!user) throw HttpError.notFound('Employee not found')
    if (!user.is_active) throw HttpError.conflict(`${user.first_name} ${user.last_name} is inactive`)
    if (user.role_name !== 'Cashier') throw HttpError.conflict('Only cashiers can be assigned to a terminal')

    const [busy] = await connection.query<RowDataPacket[]>(
      `SELECT ${SESSION_SELECT} FROM sessions s JOIN users u ON u.user_id = s.user_id
        WHERE s.is_active = TRUE AND (s.terminal_id = ? OR s.user_id = ?)`,
      [terminalId, userId],
    )
    const onTerminal = busy.find((row) => row.terminal_id === terminalId)
    if (onTerminal) throw HttpError.conflict(`${terminalId} is already assigned to ${onTerminal.cashier_name}. End that shift first.`)
    const elsewhere = busy.find((row) => row.user_id === userId)
    if (elsewhere) throw HttpError.conflict(`${elsewhere.cashier_name} is already on ${elsewhere.terminal_id}. End that shift first.`)

    let sessionId: number
    try {
      const [result] = await connection.execute<ResultSetHeader>('INSERT INTO sessions (user_id, terminal_id, assigned_by) VALUES (?, ?, ?)', [
        userId,
        terminalId,
        ownerId,
      ])
      sessionId = result.insertId
    } catch (error) {
      if (isDuplicate(error)) throw HttpError.conflict('That terminal or cashier was just assigned by someone else. Refresh and try again.')
      throw error
    }

    await logAudit(
      {
        user_id: ownerId,
        session_id: sessionId,
        action: 'ASSIGN_TERMINAL',
        module: 'ADMIN',
        terminal_id: terminalId,
        ip_address: info.ip_address,
        details: { cashier_id: userId, cashier_name: `${user.first_name} ${user.last_name}` },
      },
      connection,
    )
    const [rows] = await connection.query<RowDataPacket[]>(`SELECT ${SESSION_SELECT} FROM sessions s JOIN users u ON u.user_id = s.user_id WHERE s.session_id = ?`, [sessionId])
    return toSession(rows[0]!)
  })
}

async function endOne(connection: PoolConnection, actorId: number, session: SessionSummary, info: RequestInfo, via: 'end_shift' | 'lock_all' | 'cashier') {
  await connection.execute('UPDATE sessions SET is_active = FALSE, is_paused = FALSE, logout_time = NOW(), end_reason = ? WHERE session_id = ?', [
    via === 'cashier' ? 'cashier_logout' : 'owner_ended',
    session.session_id,
  ])
  await logAudit(
    {
      user_id: actorId,
      session_id: session.session_id,
      action: 'END_SHIFT',
      module: via === 'cashier' ? 'TERMINAL' : 'ADMIN',
      terminal_id: session.terminal_id,
      ip_address: info.ip_address,
      details: { cashier_id: session.user_id, cashier_name: session.cashier_name, via },
    },
    connection,
  )
}

/** Ends one cashier session; the terminal locks on its next poll. */
export async function endShift(ownerId: number, sessionId: number, info: RequestInfo): Promise<SessionSummary> {
  return withTransaction(async (connection) => {
    const [rows] = await connection.query<RowDataPacket[]>(
      `SELECT ${SESSION_SELECT}, s.is_active FROM sessions s JOIN users u ON u.user_id = s.user_id WHERE s.session_id = ? FOR UPDATE`,
      [sessionId],
    )
    const row = rows[0]
    if (!row) throw HttpError.notFound('Session not found')
    if (!row.is_active) throw HttpError.conflict('That shift has already ended')
    const session = toSession(row)
    await endOne(connection, ownerId, session, info, 'end_shift')
    return session
  })
}

/** The cashier ends their own shift from the terminal; it locks on its next poll and the end time is recorded. */
export async function endOwnShift(sessionId: number, terminalId: string, info: RequestInfo): Promise<SessionSummary> {
  return withTransaction(async (connection) => {
    const [rows] = await connection.query<RowDataPacket[]>(
      `SELECT ${SESSION_SELECT}, s.is_active FROM sessions s JOIN users u ON u.user_id = s.user_id WHERE s.session_id = ? AND s.terminal_id = ? FOR UPDATE`,
      [sessionId, terminalId],
    )
    const row = rows[0]
    if (!row) throw HttpError.notFound('Session not found')
    if (!row.is_active) throw HttpError.conflict('That shift has already ended')
    const session = toSession(row)
    await endOne(connection, session.user_id, session, info, 'cashier')
    return session
  })
}

/**
 * Locks the terminal without ending the shift (cashier stepping away, or the owner locking it). The session stays
 * active and keeps its cashier; sales are refused until the owner resumes it.
 */
export async function pauseShift(actorId: number, sessionId: number, info: RequestInfo, by: 'owner' | 'cashier', terminalId?: string): Promise<SessionSummary> {
  return withTransaction(async (connection) => {
    const [rows] = await connection.query<RowDataPacket[]>(
      `SELECT ${SESSION_SELECT}, s.is_active FROM sessions s JOIN users u ON u.user_id = s.user_id WHERE s.session_id = ? FOR UPDATE`,
      [sessionId],
    )
    const row = rows[0]
    if (!row || (terminalId && row.terminal_id !== terminalId)) throw HttpError.notFound('Session not found')
    if (!row.is_active) throw HttpError.conflict('That shift has already ended')
    if (!row.is_paused) {
      await connection.execute('UPDATE sessions SET is_paused = TRUE, paused_at = NOW() WHERE session_id = ?', [sessionId])
      await logAudit(
        { user_id: actorId, session_id: sessionId, action: 'PAUSE_SHIFT', module: by === 'owner' ? 'ADMIN' : 'TERMINAL', terminal_id: row.terminal_id, ip_address: info.ip_address, details: { cashier_id: row.user_id, cashier_name: row.cashier_name, by } },
        connection,
      )
    }
    const [after] = await connection.query<RowDataPacket[]>(`SELECT ${SESSION_SELECT} FROM sessions s JOIN users u ON u.user_id = s.user_id WHERE s.session_id = ?`, [sessionId])
    return toSession(after[0]!)
  })
}

/** Owner unlocks a paused terminal; the cashier carries on in the same shift. */
export async function resumeShift(ownerId: number, sessionId: number, info: RequestInfo): Promise<SessionSummary> {
  return withTransaction(async (connection) => {
    const [rows] = await connection.query<RowDataPacket[]>(
      `SELECT ${SESSION_SELECT}, s.is_active FROM sessions s JOIN users u ON u.user_id = s.user_id WHERE s.session_id = ? FOR UPDATE`,
      [sessionId],
    )
    const row = rows[0]
    if (!row) throw HttpError.notFound('Session not found')
    if (!row.is_active) throw HttpError.conflict('That shift has already ended')
    if (row.is_paused) {
      await connection.execute('UPDATE sessions SET is_paused = FALSE, paused_at = NULL WHERE session_id = ?', [sessionId])
      await logAudit(
        { user_id: ownerId, session_id: sessionId, action: 'RESUME_SHIFT', module: 'ADMIN', terminal_id: row.terminal_id, ip_address: info.ip_address, details: { cashier_id: row.user_id, cashier_name: row.cashier_name } },
        connection,
      )
    }
    const [after] = await connection.query<RowDataPacket[]>(`SELECT ${SESSION_SELECT} FROM sessions s JOIN users u ON u.user_id = s.user_id WHERE s.session_id = ?`, [sessionId])
    return toSession(after[0]!)
  })
}

/** Ends every active session (e.g. closing time or an emergency). */
export async function lockAllTerminals(ownerId: number, info: RequestInfo): Promise<{ ended: SessionSummary[] }> {
  return withTransaction(async (connection) => {
    const [rows] = await connection.query<RowDataPacket[]>(
      `SELECT ${SESSION_SELECT} FROM sessions s JOIN users u ON u.user_id = s.user_id WHERE s.is_active = TRUE FOR UPDATE`,
    )
    const sessions = rows.map(toSession)
    for (const session of sessions) await endOne(connection, ownerId, session, info, 'lock_all')
    await logAudit(
      { user_id: ownerId, action: 'LOCK_ALL', module: 'ADMIN', ip_address: info.ip_address, details: { ended_sessions: sessions.map((s) => s.session_id) } },
      connection,
    )
    return { ended: sessions }
  })
}

// ---------------------------------------------------------------------------
// Cashier terminals (no credentials — identified by terminal ID)
// ---------------------------------------------------------------------------

/**
 * Which app window last polled each terminal (X-Client-Id, one id per window). Kept in memory: it only tells a
 * window that the register it is looking at is open on *another* screen, so losing it on restart is harmless.
 */
const lastPoller = new Map<string, string>()

/**
 * Enabled terminal IDs, for the setup screen on a new cashier PC and the "I am a cashier" choice on the server PC.
 * `on_shift`: a cashier is assigned there right now (the register is taken).
 * `open_elsewhere`: another window showed this register in the last few seconds (e.g. its lock screen), not counting
 * the window asking — so a register you just switched away from isn't reported as busy.
 */
export async function listTerminalChoices(clientId: string | null = null): Promise<{ terminal_id: string; terminal_name: string | null; on_shift: boolean; open_elsewhere: boolean }[]> {
  const [rows] = await getPool().query<RowDataPacket[]>(
    `SELECT t.terminal_id, t.terminal_name, TIMESTAMPDIFF(SECOND, t.last_seen, NOW()) AS seconds_since_seen,
            EXISTS (SELECT 1 FROM sessions s WHERE s.terminal_id = t.terminal_id AND s.is_active = TRUE) AS on_shift
       FROM terminals t WHERE t.is_active = TRUE AND t.terminal_id <> ? ORDER BY t.terminal_id`,
    [SYSTEM_TERMINAL_ID],
  )
  return rows.map((row) => ({
    terminal_id: row.terminal_id,
    terminal_name: row.terminal_name,
    on_shift: Boolean(row.on_shift),
    open_elsewhere:
      row.seconds_since_seen !== null && Number(row.seconds_since_seen) <= ONLINE_WITHIN_SECONDS && (!clientId || lastPoller.get(row.terminal_id) !== clientId),
  }))
}

async function touchTerminal(terminalId: string, info: RequestInfo): Promise<RowDataPacket> {
  const [result] = await getPool().execute<ResultSetHeader>('UPDATE terminals SET last_seen = NOW(), ip_address = ? WHERE terminal_id = ?', [
    info.ip_address,
    terminalId,
  ])
  if (result.affectedRows === 0) throw HttpError.notFound(`Terminal ${terminalId} is not registered. Ask the owner to add it.`)
  const [rows] = await getPool().query<RowDataPacket[]>('SELECT terminal_id, terminal_name, is_active FROM terminals WHERE terminal_id = ?', [terminalId])
  return rows[0]!
}

/**
 * Polled by each terminal every 2 seconds. Also registers the terminal (IP + last_seen).
 * The first poll after an assignment records login_time — the moment the terminal actually unlocked.
 */
export async function getTerminalStatus(terminalId: string, info: RequestInfo & { client_id?: string | null }): Promise<TerminalStatus> {
  const terminal = await touchTerminal(terminalId, info)
  if (info.client_id) lastPoller.set(terminalId, info.client_id)
  const [rows] = await getPool().query<RowDataPacket[]>(
    `SELECT ${SESSION_SELECT} FROM sessions s JOIN users u ON u.user_id = s.user_id WHERE s.terminal_id = ? AND s.is_active = TRUE`,
    [terminalId],
  )
  const session = rows[0] ? toSession(rows[0]) : null

  if (session && !session.login_time) {
    const [result] = await getPool().execute<ResultSetHeader>('UPDATE sessions SET login_time = NOW() WHERE session_id = ? AND login_time IS NULL', [
      session.session_id,
    ])
    if (result.affectedRows > 0) {
      await logAudit({
        user_id: session.user_id,
        session_id: session.session_id,
        action: 'TERMINAL_UNLOCKED',
        module: 'TERMINAL',
        terminal_id: terminalId,
        ip_address: info.ip_address,
      })
      const [again] = await getPool().query<RowDataPacket[]>('SELECT login_time FROM sessions WHERE session_id = ?', [session.session_id])
      session.login_time = again[0]?.login_time ?? null
    }
  }

  const paused = Boolean(session?.is_paused) && Boolean(terminal.is_active)
  const assigned = Boolean(session) && Boolean(terminal.is_active) && !paused
  return {
    terminal_id: terminal.terminal_id,
    terminal_name: terminal.terminal_name,
    assigned,
    is_locked: !assigned,
    session_id: assigned ? session!.session_id : null,
    paused,
    user: assigned || paused ? { user_id: session!.user_id, name: session!.cashier_name } : null,
    assigned_at: assigned ? session!.assigned_at : null,
    login_time: assigned ? session!.login_time : null,
    session_token: assigned ? signTerminalToken({ session_id: session!.session_id, terminal_id: terminalId, user_id: session!.user_id }) : null,
    server_time: new Date().toISOString(),
  }
}

export async function heartbeat(terminalId: string, info: RequestInfo): Promise<{ ok: true; terminal_id: string; server_time: string }> {
  await touchTerminal(terminalId, info)
  return { ok: true, terminal_id: terminalId, server_time: new Date().toISOString() }
}
