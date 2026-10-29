import cors from 'cors'
import express, { type Express } from 'express'
import { auditMutations, terminalContext } from './middleware/audit.js'
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js'
import { adminRoutes } from './routes/admin.routes.js'
import { authRoutes } from './routes/auth.routes.js'
import { dashboardRoutes } from './routes/dashboard.routes.js'
import { employeeRoutes } from './routes/employees.routes.js'
import { healthRoutes } from './routes/health.routes.js'
import { inventoryRoutes } from './routes/inventory.routes.js'
import { posRoutes } from './routes/pos.routes.js'
import { purchasingRoutes } from './routes/purchasing.routes.js'
import { reportRoutes } from './routes/reports.routes.js'
import { requestRoutes } from './routes/requests.routes.js'
import { storeRoutes } from './routes/store.routes.js'
import { terminalRoutes } from './routes/terminal.routes.js'
import { wasteRoutes } from './routes/waste.routes.js'

/** Builds the Express app without starting it, so tests can mount it directly. */
export function createApp(options: { appVersion: string }): Express {
  const app = express()

  app.disable('x-powered-by')
  app.set('trust proxy', false)
  // Terminals load the UI from disk (file://) or the Vite dev server and call this API across the LAN.
  // Access is controlled by owner JWTs and terminal sessions, not by origin.
  app.use(cors({ origin: true }))
  // Imports carry a whole spreadsheet; everything else stays small. (The first parser to run wins.)
  app.use('/api/admin/import', express.json({ limit: '30mb' }))
  app.use(express.json({ limit: '1mb' }))
  app.use(terminalContext)
  app.use(auditMutations)

  app.use('/api/health', healthRoutes(options.appVersion))
  app.use('/api/auth', authRoutes)
  app.use('/api/admin', adminRoutes)
  app.use('/api/terminal', terminalRoutes)
  app.use('/api/store', storeRoutes)
  app.use('/api/pos', posRoutes)
  app.use('/api/inventory', inventoryRoutes)
  app.use('/api/dashboard', dashboardRoutes)
  app.use('/api/waste', wasteRoutes)
  app.use('/api/requests', requestRoutes)
  app.use('/api/employees', employeeRoutes)
  app.use('/api/purchasing', purchasingRoutes)
  app.use('/api/reports', reportRoutes)

  app.use('/api', notFoundHandler)
  app.use(errorHandler)
  return app
}