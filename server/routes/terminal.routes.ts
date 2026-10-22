import { Router, type Request } from 'express'
import { verifyTerminalToken } from '../services/auth.service.js'
import { endOwnShift, getTerminalStatus, heartbeat, listTerminalChoices, pauseShift } from '../services/session.service.js'
import { HttpError } from '../utils/httpError.js'
import { terminalParams } from '../utils/validators.js'
import { clientIp } from '../utils/ip.js'

// Called by cashier terminals. No credentials: a terminal only learns who the owner assigned to it.
export const terminalRoutes = Router()

/** Enabled terminal IDs and names, so a new cashier PC can pick its own during setup. */
/** Identifies the app window (not the PC) making the request; see listTerminalChoices. */
const clientIdOf = (req: Request) => {
  const id = req.header('x-client-id')
  return id && /^[A-Za-z0-9-]{8,64}$/.test(id) ? id : null
}

terminalRoutes.get('/', async (req, res) => {
  res.set('Cache-Control', 'no-store')
  res.json(await listTerminalChoices(clientIdOf(req)))
})

terminalRoutes.get('/:terminal_id/status', async (req, res) => {
  const { terminal_id } = terminalParams.parse(req.params)
  res.set('Cache-Control', 'no-store')
  res.json(await getTerminalStatus(terminal_id, { ip_address: clientIp(req), client_id: clientIdOf(req) }))
})

terminalRoutes.post('/:terminal_id/heartbeat', async (req, res) => {
  const { terminal_id } = terminalParams.parse(req.params)
  req.auditLogged = true // heartbeats are routine; not worth an audit row every 30 s
  res.json(await heartbeat(terminal_id, { ip_address: clientIp(req) }))
})

/** The cashier on this terminal (proved by X-Session-Token) acts on their own shift. */
function ownShift(req: Request, terminalId: string) {
  const token = req.header('x-session-token')
  if (!token) throw HttpError.unauthorized()
  const claims = verifyTerminalToken(token)
  if (claims.terminal_id !== terminalId) throw HttpError.forbidden('That shift belongs to another terminal')
  return claims
}

/** Locks this terminal until the owner resumes it; the shift stays open. */
terminalRoutes.post('/:terminal_id/pause', async (req, res) => {
  const { terminal_id } = terminalParams.parse(req.params)
  const claims = ownShift(req, terminal_id)
  req.auditLogged = true
  res.json({ ok: true, session: await pauseShift(claims.user_id, claims.session_id, { ip_address: clientIp(req) }, 'cashier', terminal_id) })
})

/** The cashier ends their own shift; the end time shows in the Employees table. */
terminalRoutes.post('/:terminal_id/end-shift', async (req, res) => {
  const { terminal_id } = terminalParams.parse(req.params)
  const claims = ownShift(req, terminal_id)
  req.auditLogged = true
  res.json({ ok: true, session: await endOwnShift(claims.session_id, terminal_id, { ip_address: clientIp(req) }) })
})
