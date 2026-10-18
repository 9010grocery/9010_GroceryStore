import { Router } from 'express'
import { z } from 'zod'
import { actorFor, requireOwnerUser, requireStoreUser } from '../middleware/storeAuth.js'
import { listWaste, wasteSummary } from '../services/waste.service.js'
import { logWaste } from '../services/store.service.js'
import { prefixedId as id } from '../utils/ids.js'

// Write-offs. Only the owner records and reviews waste; cashiers don't have this screen.
export const wasteRoutes = Router()
wasteRoutes.use(requireStoreUser, requireOwnerUser)

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine((v) => { const d = new Date(`${v}T00:00:00Z`); return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v) }, 'Not a real date')
const reason = z.enum(['Expired', 'Damaged', 'Spoiled', 'Theft / Shrink', 'Customer return', 'Other'])
const filters = z.object({ from: day.optional(), to: day.optional(), product_id: id('p').optional(), reason: reason.optional() })
const listQuery = filters.extend({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
})
const wasteBody = z.object({
  product_id: id('p'),
  qty: z.number().int().positive().max(100_000),
  reason,
  notes: z.string().trim().max(255).nullish(),
})

/** Query: from, to (YYYY-MM-DD, inclusive), product_id, reason, limit, offset. Default range is the last 30 days. */
wasteRoutes.get('/', async (req, res) => {
  res.set('Cache-Control', 'no-store')
  res.json(await listWaste(listQuery.parse(req.query)))
})

/** Same filters as the list: totals, loss by reason and the five costliest products. */
wasteRoutes.get('/summary', async (req, res) => {
  res.set('Cache-Control', 'no-store')
  res.json(await wasteSummary(filters.parse(req.query)))
})

/** Body: { product_id, qty, reason, notes? }. qty can't exceed what is in stock; batches are drained earliest-expiry first. */
wasteRoutes.post('/', async (req, res) => {
  const body = wasteBody.parse(req.body)
  req.auditLogged = true
  res.status(201).json(await logWaste(await actorFor(req), body))
})
