import { Router } from 'express'
import { z } from 'zod'
import { actorFor, requireOwnerUser, requireStoreUser } from '../middleware/storeAuth.js'
import { expiring, lowStock, movements } from '../services/inventory.service.js'
import { deleteProduct, productBatches, receiveStock, setBatchExpiry, setBatchMarkdown } from '../services/store.service.js'
import { prefixedId } from '../utils/ids.js'

// Stock views and deliveries. Anyone on the store network with a session can look; receiving and deleting are owner-only.
export const inventoryRoutes = Router()
inventoryRoutes.use(requireStoreUser)

const receiveBody = z.object({
  product_id: prefixedId('p'),
  qty: z.number().int().positive().max(1_000_000),
  batch_number: z.string().trim().max(50).nullish(),
  expiry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date format YYYY-MM-DD').nullish(),
  unit_cost: z.number().min(0).max(10_000_000).nullish(),
  note: z.string().trim().max(200).nullish(),
})

inventoryRoutes.get('/low-stock', async (_req, res) => {
  res.set('Cache-Control', 'no-store')
  res.json(await lowStock())
})

inventoryRoutes.get('/expiring', async (req, res) => {
  const { days } = z.object({ days: z.coerce.number().int().min(0).max(365).default(7) }).parse(req.query)
  res.set('Cache-Control', 'no-store')
  res.json(await expiring(days))
})

inventoryRoutes.get('/movements/:product_id', async (req, res) => {
  const productId = prefixedId('p').parse(req.params.product_id)
  const query = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), before: z.coerce.number().int().positive().optional() }).parse(req.query)
  res.set('Cache-Control', 'no-store')
  res.json(await movements(productId, query))
})

/** Body: { product_id, qty, batch_number?, expiry_date?, unit_cost?, note? }: a delivery, booked as its own batch. */
inventoryRoutes.post('/receive', requireOwnerUser, async (req, res) => {
  const { product_id, ...input } = receiveBody.parse(req.body)
  req.auditLogged = true
  res.status(201).json(await receiveStock(await actorFor(req), product_id, input))
})

inventoryRoutes.get('/batches/:product_id', async (req, res) => {
  res.set('Cache-Control', 'no-store')
  res.json(await productBatches(prefixedId('p').parse(req.params.product_id)))
})

/** Body: { percent: number | null }. The owner marks down one batch (for example the one close to its expiry date). */
inventoryRoutes.put('/batches/:batch_id/markdown', requireOwnerUser, async (req, res) => {
  const { percent } = z.object({ percent: z.number().gt(0).max(90).nullable() }).parse(req.body)
  req.auditLogged = true
  res.json(await setBatchMarkdown(await actorFor(req), prefixedId('b').parse(req.params.batch_id), percent))
})

/** Body: { expiry_date: 'YYYY-MM-DD' | null }. Fixes a wrong or missing expiry date on one batch. */
inventoryRoutes.put('/batches/:batch_id/expiry', requireOwnerUser, async (req, res) => {
  const { expiry_date } = z.object({ expiry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date format YYYY-MM-DD').nullable() }).parse(req.body)
  req.auditLogged = true
  res.json(await setBatchExpiry(await actorFor(req), prefixedId('b').parse(req.params.batch_id), expiry_date))
})

inventoryRoutes.delete('/products/:id', requireOwnerUser, async (req, res) => {
  req.auditLogged = true
  res.json(await deleteProduct(await actorFor(req), prefixedId('p').parse(req.params.id)))
})