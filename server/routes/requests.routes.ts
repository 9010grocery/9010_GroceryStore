import { Router } from 'express'
import { z } from 'zod'
import { actorFor, requireOwnerUser, requireStoreUser } from '../middleware/storeAuth.js'
import { addRequest, setRequestStatus, updateRequest } from '../services/store.service.js'
import { listRequests, requestsSummary } from '../services/requests.service.js'
import { prefixedId as id } from '../utils/ids.js'

// Customer requests: any signed-in store user (including a cashier at the POS) can log and read them; only the owner changes status.
export const requestRoutes = Router()
requestRoutes.use(requireStoreUser)

const text = (max: number) => z.string().trim().max(max)
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine((v) => { const d = new Date(`${v}T00:00:00Z`); return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v) }, 'Not a real date')
const status = z.enum(['New', 'Reviewing', 'Ordered', 'Stocked', 'Declined'])
const listQuery = z.object({
  status: z.union([z.literal('Open'), z.literal('All'), status]).optional(),
  q: text(100).optional(),
  from: day.optional(),
  to: day.optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
})
const requestBody = z.object({
  item: text(100).min(1, 'What did the customer ask for?'),
  category: text(50).nullish(),
  requested_by: text(100).nullish(),
  contact: text(100).nullish(),
  notes: text(255).nullish(),
})
const updateBody = z.object({ status: status.optional(), notes: text(255).nullish() })
  .refine((b) => b.status !== undefined || b.notes !== undefined, 'Nothing to save')
const bulkBody = z.object({ ids: z.array(id('q')).min(1).max(1000), status })

requestRoutes.get('/', async (req, res) => {
  res.set('Cache-Control', 'no-store')
  res.json(await listRequests(listQuery.parse(req.query)))
})

/** Query: days (default 30). Counts per status and the most-asked-for items. */
requestRoutes.get('/summary', async (req, res) => {
  res.set('Cache-Control', 'no-store')
  const { days } = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }).parse(req.query)
  res.json(await requestsSummary(days))
})

/** Body: { item, category?, requested_by?, contact?, notes? } */
requestRoutes.post('/', async (req, res) => {
  const body = requestBody.parse(req.body)
  res.status(201).json(await addRequest(await actorFor(req), body))
})

/** Body: { ids, status }: move several requests at once (the demand-signal groups). */
requestRoutes.patch('/status', requireOwnerUser, async (req, res) => {
  const { ids, status } = bulkBody.parse(req.body)
  res.json(await setRequestStatus(await actorFor(req), ids, status))
})

/** Body: { status?, notes? } */
requestRoutes.put('/:id', requireOwnerUser, async (req, res) => {
  const body = updateBody.parse(req.body)
  req.auditLogged = true
  res.json(await updateRequest(await actorFor(req), id('q').parse(req.params.id), body))
})
