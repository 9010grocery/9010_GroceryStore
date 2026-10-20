import { Router } from 'express'
import { z } from 'zod'
import { actorFor, requireOwnerUser, requireStoreUser } from '../middleware/storeAuth.js'
import { employeeActivity, listEmployees } from '../services/employees.service.js'
import { loadEmployees, saveEmployee } from '../services/store.service.js'
import { getPool } from '../config/db.js'
import { HttpError } from '../utils/httpError.js'
import { prefixedId as id } from '../utils/ids.js'

// Staff accounts. Cashiers have no PIN; the owner assigns them to a terminal. Owner-only.
export const employeeRoutes = Router()
employeeRoutes.use(requireStoreUser, requireOwnerUser)

const text = (max: number) => z.string().trim().max(max)
const employeeBody = z.object({ name: text(101).min(1, 'Name is required'), email: text(100).nullish(), status: z.enum(['Active', 'On leave', 'Inactive']) })

employeeRoutes.get('/', async (req, res) => {
  res.set('Cache-Control', 'no-store')
  const q = z.object({ status: z.enum(['Active', 'On leave', 'Inactive']).optional(), q: text(100).optional() }).parse(req.query)
  res.json(await listEmployees(q))
})

/** Body: { name, email?, status } */
employeeRoutes.post('/', async (req, res) => {
  const body = employeeBody.parse(req.body)
  req.auditLogged = true
  res.status(201).json(await saveEmployee(await actorFor(req), null, body))
})

employeeRoutes.put('/:id', async (req, res) => {
  const body = employeeBody.parse(req.body)
  req.auditLogged = true
  res.json(await saveEmployee(await actorFor(req), id('u').parse(req.params.id), body))
})

async function setActive(req: import('express').Request, res: import('express').Response, status: 'Active' | 'Inactive') {
  const userId = id('u').parse(req.params.id)
  const [current] = await loadEmployees(getPool(), userId)
  if (!current) throw HttpError.notFound('Employee not found')
  req.auditLogged = true
  res.json(await saveEmployee(await actorFor(req), userId, { name: current.name, email: current.email, status }))
}

/** Locks the cashier out: an open shift is ended and the terminal goes back to waiting. The owner account can't be deactivated. */
employeeRoutes.post('/:id/deactivate', (req, res) => setActive(req, res, 'Inactive'))
employeeRoutes.post('/:id/activate', (req, res) => setActive(req, res, 'Active'))

/** Query: days (default 30). Shifts, sales, voids and refunds for one employee. */
employeeRoutes.get('/:id/activity', async (req, res) => {
  res.set('Cache-Control', 'no-store')
  const { days } = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }).parse(req.query)
  res.json(await employeeActivity(id('u').parse(req.params.id), days))
})
