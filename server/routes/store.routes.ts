import { Router, type Request } from 'express'
import { z } from 'zod'
import { requireOwnerPin } from '../middleware/ownerPin.js'
import { actorFor, requireOwnerUser, requireStoreUser } from '../middleware/storeAuth.js'
import {
  adjustProductStock,
  createSale,
  loadSnapshot,
  refundSale,
  saveBusinessInfo,
  saveProduct,
  voidSale,
} from '../services/store.service.js'
import { prefixedId as id } from '../utils/ids.js'

// Store data behind the workspace screens. The owner (server PC) and cashier terminals with an active
// session can read it and ring up sales; catalog, stock and employee changes are owner-only.
export const storeRoutes = Router()
storeRoutes.use(requireStoreUser)

const routeId = (req: Request, prefix: string) => id(prefix).parse(req.params.id)
const qty = z.number().int().positive().max(100_000)
const money = z.number().min(0).max(10_000_000)
const text = (max: number) => z.string().trim().max(max)

const saleBody = z.object({
  lines: z.array(z.object({ product_id: id('p'), qty, discount_percent: z.number().gt(0).max(100).nullish() })).min(1).max(500),
  customer_type: z.enum(['Regular', 'Senior', 'PWD']),
  senior_pwd_id: text(50).nullish(),
  senior_pwd_name: text(100).nullish(),
  payment_method: z.enum(['Cash', 'GCash', 'Maya', 'Card']),
  amount_received: money,
  payment_reference: text(60).nullish(),
  /** Discount for every line that has none of its own (Regular customers only). Above the store's threshold it must carry the owner's approval from /api/pos/discount/verify. */
  discount_percent: z.number().gt(0).max(100).nullish(),
  discount_override_id: z.number().int().positive().nullish(),
})

const voidBody = z.object({ reason: text(255).default('') })
const refundBody = z.object({
  reason: text(255).min(1, 'Give a reason for the return'),
  restock: z.boolean(),
  lines: z.array(z.object({ product_id: id('p'), qty })).min(1),
})

const productBody = z.object({
  name: text(100).min(1, 'Product name is required'),
  sku: text(50).nullish(),
  barcode: text(50).nullish(),
  category: text(50).nullish(),
  supplier_name: text(100).nullish(),
  unit: text(20).nullish(),
  price: money,
  cost: money.nullish(),
  reorder_point: z.number().int().min(0).max(1_000_000).nullish(),
  lead_time_days: z.number().int().min(0).max(365).nullish(),
  stock: z.number().int().min(0).max(10_000_000).nullish(),
  expiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  active: z.boolean().optional(),
  senior_pwd_eligible: z.boolean().optional(),
  promo_percent: z.number().gt(0).max(90).nullish(),
  promo_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  promo_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
})

const stockBody = z.object({ delta: z.number().int().refine((n) => n !== 0, 'Change must not be zero'), reason: text(255).default('') })

storeRoutes.get('/snapshot', async (_req, res) => {
  res.set('Cache-Control', 'no-store')
  res.json(await loadSnapshot())
})

storeRoutes.post('/sales', async (req, res) => {
  const body = saleBody.parse(req.body)
  req.auditLogged = true
  res.status(201).json(await createSale(await actorFor(req), body))
})

/** Body: { owner_pin, reason } */
storeRoutes.post('/sales/:id/void', requireOwnerPin('void'), async (req, res) => {
  const { reason } = voidBody.parse(req.body)
  req.auditLogged = true
  const transaction = await voidSale(await actorFor(req), req.ownerApproval!, routeId(req, 't'), reason)
  res.json({ transaction, approved_by: req.ownerApproval!.owner_name })
})

/** Body: { owner_pin, reason, restock, lines: [{ product_id, qty }] } */
storeRoutes.post('/sales/:id/refunds', requireOwnerPin('refund'), async (req, res) => {
  const body = refundBody.parse(req.body)
  req.auditLogged = true
  const transaction = await refundSale(await actorFor(req), req.ownerApproval!, routeId(req, 't'), body)
  res.status(201).json({ transaction, approved_by: req.ownerApproval!.owner_name })
})

storeRoutes.post('/products', requireOwnerUser, async (req, res) => {
  const body = productBody.parse(req.body)
  req.auditLogged = true
  res.status(201).json(await saveProduct(await actorFor(req), null, body))
})

storeRoutes.put('/products/:id', requireOwnerUser, async (req, res) => {
  const body = productBody.parse(req.body)
  req.auditLogged = true
  res.json(await saveProduct(await actorFor(req), routeId(req, 'p'), body))
})

storeRoutes.post('/products/:id/stock', requireOwnerUser, async (req, res) => {
  const { delta, reason } = stockBody.parse(req.body)
  req.auditLogged = true
  res.json(await adjustProductStock(await actorFor(req), routeId(req, 'p'), delta, reason))
})

// TIN as the BIR prints it (e.g. 123-456-789-00000); left empty until the owner has it.
const tin = text(30).regex(/^(\d[\d\s-]{7,28}\d)?$/, 'Enter the TIN with digits and dashes only, e.g. 123-456-789-00000')

/** Body: { store_name?, business_tin?, business_address? }: the details printed on every receipt. Send only what changed. */
storeRoutes.put('/settings', requireOwnerUser, async (req, res) => {
  const body = z.object({
    store_name: text(80).min(1, 'Store name is required').optional(),
    business_tin: tin.optional(),
    business_address: text(255).optional(),
  }).refine((b) => Object.values(b).some((value) => value !== undefined), 'Nothing to save').parse(req.body)
  req.auditLogged = true
  await saveBusinessInfo(await actorFor(req), body)
  res.json({ ok: true })
})
