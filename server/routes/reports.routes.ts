import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import { requireOwnerUser, requireStoreUser } from '../middleware/storeAuth.js'
import { logAudit, requestContext } from '../services/audit.service.js'
import { toCsv, toPdf } from '../services/reportExport.service.js'
import * as reports from '../services/reports.service.js'
import { HttpError } from '../utils/httpError.js'
import { prefixedId as id } from '../utils/ids.js'

// Reports (spec Module 10). Owner only: they carry every cashier's sales and the BIR readings.
export const reportRoutes = Router()
reportRoutes.use(requireStoreUser, requireOwnerUser)

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine((v) => { const d = new Date(`${v}T00:00:00Z`); return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v) }, 'Not a real date')
const localDay = (d: Date) => { const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` }

const filterQuery = z.object({
  from: day.optional(), to: day.optional(),
  product_id: id('p').optional(), cashier_id: id('u').optional(), terminal_id: z.string().trim().min(1).max(20).optional(),
  group: z.enum(['day', 'cashier', 'terminal', 'payment', 'product']).default('day'),
  format: z.enum(['json', 'pdf', 'csv']).optional(),
})

/** Default range is the last 7 days including today. */
function filters(query: unknown): { f: reports.Filters; group: reports.SalesGroup } {
  const q = filterQuery.parse(query)
  const to = q.to ?? localDay(new Date())
  const from = q.from ?? localDay(new Date(Date.now() - 6 * 86_400_000))
  if (from > to) throw HttpError.badRequest('The start date is after the end date')
  if ((new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86_400_000 > 731) throw HttpError.badRequest('Pick a range of two years or less')
  return { f: { from, to, product_id: q.product_id, cashier_id: q.cashier_id, terminal_id: q.terminal_id }, group: q.group }
}

const who = (req: Request) => req.user?.name ?? 'Owner'

type Build = (req: Request) => Promise<reports.ReportDoc>
const builders: Record<string, Build> = {
  sales: (req) => { const { f, group } = filters(req.query); return reports.salesReport(f, group, who(req)) },
  inventory: (req) => reports.inventoryReport(filters(req.query).f, who(req)),
  waste: (req) => reports.wasteReport(filters(req.query).f, who(req)),
  purchasing: (req) => reports.purchasingReport(filters(req.query).f, who(req)),
  requests: (req) => reports.requestsReport(filters(req.query).f, who(req)),
  'e-journal': (req) => reports.eJournal(filters(req.query).f, who(req)),
  'vat-summary': (req) => reports.vatSummary(filters(req.query).f, who(req)),
  'x-reading': (req) => reports.xReading(sessionParam(req), who(req)),
  'z-reading': (req) => reports.zReading(dateParam(req), who(req)),
}

const sessionParam = (req: Request) => {
  const raw = req.params.session_id ?? req.query.session_id
  const parsed = id('s').safeParse(raw)
  if (!parsed.success) throw HttpError.badRequest('Pick a shift')
  return parsed.data
}
const dateParam = (req: Request) => {
  const parsed = day.default(localDay(new Date())).safeParse(req.query.date)
  if (!parsed.success) throw HttpError.badRequest('Use a date like 2026-10-23')
  return parsed.data
}

function route(path: string, type: string) {
  reportRoutes.get(path, async (req, res) => {
    res.set('Cache-Control', 'no-store')
    res.json(await builders[type]!(req))
  })
}
route('/sales', 'sales')
route('/inventory', 'inventory')
route('/waste', 'waste')
route('/purchasing', 'purchasing')
route('/requests', 'requests')
route('/e-journal', 'e-journal')
route('/vat-summary', 'vat-summary')
route('/x-reading/:session_id', 'x-reading')
route('/z-reading', 'z-reading')

/** The accumulated grand total (BIR) and the last Z-Reading. */
reportRoutes.get('/grand-total', async (_req, res) => {
  res.set('Cache-Control', 'no-store')
  res.json(await reports.grandTotal())
})

/** Shifts that can have an X-Reading (query: from, to), and the readings already stored. */
reportRoutes.get('/shifts', async (req, res) => {
  const { f } = filters(req.query)
  res.set('Cache-Control', 'no-store')
  res.json({ shifts: await reports.listShifts(f.from, f.to) })
})
reportRoutes.get('/readings', async (req, res) => {
  const kind = z.enum(['X', 'Z']).default('Z').parse(req.query.kind)
  res.set('Cache-Control', 'no-store')
  res.json({ readings: await reports.listReadings(kind) })
})

/** Keeps a copy of a shift's X-Reading (the same is done automatically when the owner ends a shift). */
reportRoutes.post('/x-reading/:session_id', async (req, res) => {
  const sessionId = sessionParam(req)
  req.auditLogged = true
  res.status(201).json(await reports.saveXReading(sessionId, req.user!.user_id, who(req)))
})

/** Closes the day: stores the Z-Reading for body.date (default today). Needs every shift ended first. Asking again returns the stored one. */
reportRoutes.post('/z-reading', async (req, res) => {
  const { date } = z.object({ date: day.default(localDay(new Date())) }).parse(req.body ?? {})
  req.auditLogged = true
  const doc = await reports.closeDay(date, req.user!.user_id, who(req), requestContext(req).ip_address)
  res.status(doc.already_closed ? 200 : 201).json(doc)
})

/** /export/sales?format=pdf|csv&from=&to=&group=...  /export/x-reading?session_id=  /export/z-reading?date= */
reportRoutes.get('/export/:type', async (req: Request, res: Response) => {
  const type = String(req.params.type)
  const build = builders[type]
  if (!build) throw HttpError.notFound('Unknown report')
  const format = z.enum(['pdf', 'csv']).default('pdf').parse(req.query.format)
  const doc = await build(req)
  const name = `${type}-${doc.period.replace(/[^0-9A-Za-z]+/g, '_').replace(/^_|_$/g, '')}`.slice(0, 80)
  await logAudit({ ...requestContext(req), action: 'EXPORT_REPORT', module: 'REPORTS', details: { type, format, period: doc.period } })
  res.set('Cache-Control', 'no-store')
  res.set('Content-Disposition', `attachment; filename="${name}.${format}"`)
  if (format === 'csv') { res.type('text/csv; charset=utf-8').send(toCsv(doc)); return }
  res.type('application/pdf').send(await toPdf(doc))
})