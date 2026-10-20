import type { RowDataPacket } from 'mysql2/promise'
import { getPool } from '../config/db.js'
import { REQUEST_TO_DB, loadRequests, type RequestStatusUi } from './store.service.js'

// Read side of customer requests. Writing is addRequest / setRequestStatus / updateRequest in store.service.ts.

export interface RequestFilters {
  /** 'Open' = New + Reviewing, or one status, or 'All'. */
  status?: 'Open' | 'All' | RequestStatusUi
  q?: string
  from?: string
  to?: string
  limit: number
}

export async function listRequests(filters: RequestFilters) {
  const where: string[] = ['1 = 1']
  const params: unknown[] = []
  if (filters.status === 'Open') where.push("q.status IN ('pending', 'reviewing')")
  else if (filters.status && filters.status !== 'All') { where.push('q.status = ?'); params.push(REQUEST_TO_DB[filters.status]) }
  if (filters.q) { where.push('(q.product_name_requested LIKE ? OR q.requested_by LIKE ?)'); params.push(`%${filters.q}%`, `%${filters.q}%`) }
  if (filters.from) { where.push('q.request_date >= ?'); params.push(filters.from) }
  if (filters.to) { where.push('q.request_date < DATE_ADD(?, INTERVAL 1 DAY)'); params.push(filters.to) }
  const requests = await loadRequests(getPool(), where.join(' AND '), params)
  return requests.slice(0, filters.limit)
}

/** Counts per status, and the items asked for most in the last `days` days (similar names are merged by the screen). */
export async function requestsSummary(days: number) {
  const [byStatus] = await getPool().query<RowDataPacket[]>('SELECT status, COUNT(*) AS n FROM customer_requests GROUP BY status')
  const [top] = await getPool().query<RowDataPacket[]>(
    `SELECT LOWER(TRIM(product_name_requested)) AS item, MIN(product_name_requested) AS label, COUNT(*) AS n,
            SUM(status IN ('pending', 'reviewing')) AS open_count, MAX(request_date) AS latest
       FROM customer_requests WHERE request_date >= DATE_SUB(NOW(), INTERVAL ? DAY)
      GROUP BY LOWER(TRIM(product_name_requested)) ORDER BY n DESC, latest DESC LIMIT 10`,
    [days],
  )
  const count = (...statuses: string[]) => byStatus.filter((r) => statuses.includes(r.status)).reduce((sum, r) => sum + Number(r.n), 0)
  return {
    total: byStatus.reduce((sum, r) => sum + Number(r.n), 0),
    open: count('pending', 'reviewing'),
    byStatus: { New: count('pending'), Reviewing: count('reviewing'), Ordered: count('ordered'), Stocked: count('available', 'closed'), Declined: count('declined') },
    topItems: top.map((r) => ({ item: r.label as string, count: Number(r.n), open: Number(r.open_count), latest: r.latest as string })),
  }
}
