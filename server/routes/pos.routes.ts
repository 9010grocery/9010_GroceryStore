import { Router } from 'express'
import { z } from 'zod'
import { actorFor, requireStoreUser } from '../middleware/storeAuth.js'
import { receiptData, verifyDiscount } from '../services/pos.service.js'
import { clientIp } from '../utils/ip.js'
import { prefixedId } from '../utils/ids.js'

// Point of sale helpers. Open to the owner and to cashier terminals with an active shift.
export const posRoutes = Router()
posRoutes.use(requireStoreUser)

const discountBody = z.object({
  percent: z.number().gt(0, 'Enter a discount above 0%').max(100, 'A discount can be at most 100%'),
  owner_pin: z.string().regex(/^\d{6}$/, 'PIN must be exactly 6 digits').optional(),
  reason: z.string().trim().max(255).optional(),
})

/** A receipt for printing. `?reprint=1` counts it as a reprint (shown on the copy, and written to the audit log). */
posRoutes.get('/receipt/:id', async (req, res) => {
  const id = prefixedId('t').parse(req.params.id)
  const reprint = req.query.reprint === '1' || req.query.reprint === 'true'
  if (reprint) req.auditLogged = true
  res.set('Cache-Control', 'no-store')
  res.json(await receiptData(await actorFor(req), id, { reprint }))
})

/** Body: { percent, owner_pin?, reason? }. Above the store's discount threshold the owner's PIN is required. */
posRoutes.post('/discount/verify', async (req, res) => {
  const body = discountBody.parse(req.body)
  req.auditLogged = true
  const actor = await actorFor(req)
  res.json(
    await verifyDiscount(actor, body, {
      ip_address: clientIp(req),
      terminal_id: req.terminalSession?.terminal_id ?? req.terminalId ?? null,
      session_id: req.terminalSession?.session_id ?? null,
    }),
  )
})
