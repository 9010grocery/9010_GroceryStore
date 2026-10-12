import { Router } from 'express'
import { z } from 'zod'
import { requireStoreUser } from '../middleware/storeAuth.js'
import { alerts, DEFAULT_EXPIRY_DAYS, salesTrend, summary } from '../services/dashboard.service.js'

// Dashboard numbers (spec Module 3), computed in SQL. Open to whoever the role settings let open the Dashboard.
export const dashboardRoutes = Router()
dashboardRoutes.use(requireStoreUser)

const expiryQuery = z.object({ expiry_days: z.coerce.number().int().min(0).max(365).default(DEFAULT_EXPIRY_DAYS) })

dashboardRoutes.get('/summary', async (req, res) => {
  const { expiry_days } = expiryQuery.parse(req.query)
  res.set('Cache-Control', 'no-store')
  res.json(await summary(expiry_days))
})

dashboardRoutes.get('/alerts', async (req, res) => {
  const { expiry_days } = expiryQuery.parse(req.query)
  res.set('Cache-Control', 'no-store')
  res.json(await alerts(expiry_days))
})

dashboardRoutes.get('/sales-trend', async (req, res) => {
  const { days } = z.object({ days: z.coerce.number().int().min(1).max(90).default(7) }).parse(req.query)
  res.set('Cache-Control', 'no-store')
  res.json(await salesTrend(days))
})
