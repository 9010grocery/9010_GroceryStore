import { Router } from 'express'
import { z } from 'zod'
import { actorFor, requireOwnerUser, requireStoreUser } from '../middleware/storeAuth.js'
import {
  approveReorderList, cancelPurchaseOrder, closePurchaseOrder, createPurchaseOrders, createReorderList, getPurchaseOrder, getReorderList,
  listPurchaseOrders, listReorderLists, receivePurchaseOrder, recommendations, rejectReorderList,
} from '../services/purchasing.service.js'
import { prefixedId as id } from '../utils/ids.js'

// Purchasing is the owner's. Cashiers have no Purchasing screen and no access here.
export const purchasingRoutes = Router()
purchasingRoutes.use(requireStoreUser, requireOwnerUser)

const text = (max: number) => z.string().trim().max(max)
const qty = z.number().int().positive().max(1_000_000)
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine((v) => { const d = new Date(`${v}T00:00:00Z`); return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v) }, 'Not a real date')
const noStore = (res: import('express').Response) => res.set('Cache-Control', 'no-store')

// ----- Recommendations -----

/** What to buy now: forecast (ML or weighted moving average) or the reorder-level fallback, with a reason and priority per product. */
purchasingRoutes.get('/recommendations', async (_req, res) => {
  noStore(res)
  res.json(await recommendations())
})

// ----- Reorder lists -----

const listStatus = z.enum(['pending', 'approved', 'rejected', 'completed'])

purchasingRoutes.get('/reorder-lists', async (req, res) => {
  noStore(res)
  const { status } = z.object({ status: listStatus.optional() }).parse(req.query)
  res.json(await listReorderLists({ status }))
})

/** Body: { items?: [{ product_id, qty, reason? }], notes? }. Without items, every current recommendation goes on the list. */
purchasingRoutes.post('/reorder-lists', async (req, res) => {
  const body = z.object({
    items: z.array(z.object({ product_id: id('p'), qty, reason: text(255).nullish() })).min(1).max(500).optional(),
    notes: text(500).nullish(),
  }).parse(req.body)
  req.auditLogged = true
  res.status(201).json(await createReorderList(await actorFor(req), body))
})

purchasingRoutes.get('/reorder-lists/:id', async (req, res) => {
  noStore(res)
  res.json(await getReorderList(id('rl').parse(req.params.id)))
})

/** Body: { items?: [{ item_id, qty }] }: quantities the owner changed (0 drops a line). Nothing is ordered by this. */
purchasingRoutes.post('/reorder-lists/:id/approve', async (req, res) => {
  const { items } = z.object({ items: z.array(z.object({ item_id: id('ri'), qty: z.number().int().min(0).max(1_000_000) })).max(500).default([]) }).parse(req.body ?? {})
  req.auditLogged = true
  res.json(await approveReorderList(await actorFor(req), id('rl').parse(req.params.id), items.map((i) => ({ item_id: i.item_id, qty: i.qty }))))
})

/** Body: { reason } */
purchasingRoutes.post('/reorder-lists/:id/reject', async (req, res) => {
  const { reason } = z.object({ reason: text(255).min(1, 'Say why the list is rejected') }).parse(req.body)
  req.auditLogged = true
  res.json(await rejectReorderList(await actorFor(req), id('rl').parse(req.params.id), reason))
})

// ----- Purchase orders -----

const poStatus = z.enum(['Open', 'All', 'Pending', 'Partially received', 'Completed', 'Cancelled'])

purchasingRoutes.get('/orders', async (req, res) => {
  noStore(res)
  const q = z.object({ status: poStatus.optional(), q: text(100).optional() }).parse(req.query)
  res.json(await listPurchaseOrders(q))
})

/**
 * Body: { reorder_list_id } to order an approved list (one order per supplier), or
 * { supplier?, items: [{ product_id, qty, unit_cost? }] } for a manual order. Optional: expected_delivery, notes.
 */
purchasingRoutes.post('/orders', async (req, res) => {
  const body = z.object({
    reorder_list_id: id('rl').optional(),
    supplier: text(100).nullish(),
    expected_delivery: day.nullish(),
    notes: text(500).nullish(),
    items: z.array(z.object({ product_id: id('p'), qty, unit_cost: z.number().min(0).max(10_000_000).nullish() })).min(1).max(500).optional(),
  }).refine((b) => b.reorder_list_id !== undefined || b.items !== undefined, 'Choose an approved reorder list or add items').parse(req.body)
  req.auditLogged = true
  res.status(201).json(await createPurchaseOrders(await actorFor(req), body))
})

purchasingRoutes.get('/orders/:id', async (req, res) => {
  noStore(res)
  res.json(await getPurchaseOrder(id('po').parse(req.params.id)))
})

/** Body: { lines: [{ item_id, qty, batch_number?, expiry_date?, unit_cost? }], note? }. Part of an order is fine. */
purchasingRoutes.post('/orders/:id/receive', async (req, res) => {
  const body = z.object({
    lines: z.array(z.object({
      item_id: id('poi'), qty, batch_number: text(50).nullish(), expiry_date: day.nullish(), unit_cost: z.number().min(0).max(10_000_000).nullish(),
    })).min(1).max(500),
    note: text(255).nullish(),
  }).parse(req.body)
  req.auditLogged = true
  res.json(await receivePurchaseOrder(await actorFor(req), id('po').parse(req.params.id), body))
})

/** Body: { reason? }. Only an order nothing was received on. */
purchasingRoutes.post('/orders/:id/cancel', async (req, res) => {
  const { reason } = z.object({ reason: text(255).default('') }).parse(req.body ?? {})
  req.auditLogged = true
  res.json(await cancelPurchaseOrder(await actorFor(req), id('po').parse(req.params.id), reason))
})

/** Body: { reason? }. The supplier won't deliver the rest of a partly received order. */
purchasingRoutes.post('/orders/:id/close', async (req, res) => {
  const { reason } = z.object({ reason: text(255).default('') }).parse(req.body ?? {})
  req.auditLogged = true
  res.json(await closePurchaseOrder(await actorFor(req), id('po').parse(req.params.id), reason))
})