import { Router } from 'express'
import { z } from 'zod'
import { requireAuth } from '../middleware/auth.js'
import { requireRole } from '../middleware/rbac.js'
import { actorFor } from '../middleware/storeAuth.js'
import { IMPORT_KINDS, importData, type ImportRow } from '../services/import.service.js'
import {
  assignTerminal,
  createTerminal,
  deleteTerminal,
  endShift,
  pauseShift,
  resumeShift,
  listActiveSessions,
  listEmployees,
  listTerminals,
  lockAllTerminals,
  updateTerminal,
} from '../services/session.service.js'
import { assignBody, createTerminalBody, endShiftBody, terminalParams, updateTerminalBody } from '../utils/validators.js'
import { clientIp } from '../utils/ip.js'

// Admin Station — owner only.
export const adminRoutes = Router()
adminRoutes.use(requireAuth, requireRole('Owner'))

adminRoutes.get('/employees', async (_req, res) => {
  res.json(await listEmployees())
})

adminRoutes.get('/terminals', async (_req, res) => {
  res.json(await listTerminals())
})

/** Body: { terminal_id: "PC-04", terminal_name? } → terminal */
adminRoutes.post('/terminals', async (req, res) => {
  const body = createTerminalBody.parse(req.body)
  req.auditLogged = true
  res.status(201).json(await createTerminal(req.user!.user_id, body, { ip_address: clientIp(req) }))
})

/** Body: { terminal_name?, is_active? } → terminal */
adminRoutes.patch('/terminals/:terminal_id', async (req, res) => {
  const { terminal_id } = terminalParams.parse(req.params)
  const changes = updateTerminalBody.parse(req.body)
  req.auditLogged = true
  res.json(await updateTerminal(req.user!.user_id, terminal_id, changes, { ip_address: clientIp(req) }))
})

/** Only for a terminal with no shift or sales history; otherwise disable it with PATCH. */
adminRoutes.delete('/terminals/:terminal_id', async (req, res) => {
  const { terminal_id } = terminalParams.parse(req.params)
  req.auditLogged = true
  await deleteTerminal(req.user!.user_id, terminal_id, { ip_address: clientIp(req) })
  res.json({ ok: true })
})

/**
 * Body: { rows: [{ _row, …fields }], dry_run } — rows already mapped to the importer's field names by the browser.
 * dry_run: true checks everything and reports what would happen without saving.
 */
adminRoutes.post('/import/:kind', async (req, res) => {
  const kind = z.enum(IMPORT_KINDS).parse(req.params.kind)
  const { rows, dry_run } = z.object({ rows: z.array(z.record(z.string(), z.unknown())).max(50_000, 'Split files over 50,000 rows'), dry_run: z.boolean() }).parse(req.body)
  req.auditLogged = true
  res.json(await importData(await actorFor(req), kind, rows as ImportRow[], dry_run))
})

adminRoutes.get('/active-sessions', async (_req, res) => {
  res.json(await listActiveSessions())
})

/** Body: { user_id, terminal_id } → session */
adminRoutes.post('/assign', async (req, res) => {
  const { user_id, terminal_id } = assignBody.parse(req.body)
  req.auditLogged = true
  const session = await assignTerminal(req.user!.user_id, user_id, terminal_id, { ip_address: clientIp(req) })
  res.status(201).json(session)
})

/** Body: { session_id } */
adminRoutes.post('/end-shift', async (req, res) => {
  const { session_id } = endShiftBody.parse(req.body)
  req.auditLogged = true
  const session = await endShift(req.user!.user_id, session_id, { ip_address: clientIp(req) })
  res.json({ ok: true, session })
})

/** Body: { session_id } — locks the terminal but keeps the shift open. */
adminRoutes.post('/pause-shift', async (req, res) => {
  const { session_id } = endShiftBody.parse(req.body)
  req.auditLogged = true
  res.json({ ok: true, session: await pauseShift(req.user!.user_id, session_id, { ip_address: clientIp(req) }, 'owner') })
})

/** Body: { session_id } — unlocks a paused terminal. */
adminRoutes.post('/resume-shift', async (req, res) => {
  const { session_id } = endShiftBody.parse(req.body)
  req.auditLogged = true
  res.json({ ok: true, session: await resumeShift(req.user!.user_id, session_id, { ip_address: clientIp(req) }) })
})

/** Ends every active session. */
adminRoutes.post('/lock-all', async (req, res) => {
  req.auditLogged = true
  const result = await lockAllTerminals(req.user!.user_id, { ip_address: clientIp(req) })
  res.json({ ok: true, ended_count: result.ended.length, ended: result.ended })
})
