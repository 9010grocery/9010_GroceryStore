/**
 * On-device analytics for the prototype. Everything here is plain statistics
 * (weighted moving average, exponential smoothing, regression, association
 * rules) computed in the browser from the mock dataset, so it can be swapped
 * for a backend model service later without changing the screens.
 */
import { DETAIL_DAYS, HISTORY_DAYS } from '../data/defaults'
import type { CustomerRequest, ForecastMethod, Product, PurchaseOrder, Settings, Transaction, WasteEntry, WorkspaceName } from '../data/types'
import { DAY_MS, daysBetween, peso, pct, startOfDay } from './format'

export const WEEKS = 12

// ---------- Series ----------

/** Units sold per day, oldest first; the last element is today (partial). */
export function dailyUnits(productId: string, history: Record<string, number[]>, transactions: Transaction[], now = new Date()) {
  const older = history[productId] ?? new Array(HISTORY_DAYS - DETAIL_DAYS).fill(0)
  const recent = new Array(DETAIL_DAYS).fill(0)
  for (const txn of transactions) {
    if (txn.status === 'Voided') continue
    const offset = daysBetween(txn.date, now)
    if (offset < 0 || offset >= DETAIL_DAYS) continue
    for (const line of txn.lines) {
      if (line.productId !== productId) continue
      const refunded = txn.refunds.reduce((sum, refund) => sum + refund.lines.filter((l) => l.productId === productId).reduce((s, l) => s + l.qty, 0), 0)
      recent[DETAIL_DAYS - 1 - offset] += Math.max(0, line.qty - refunded)
    }
  }
  return [...older, ...recent]
}

/** Twelve complete weeks (today excluded), oldest first. */
export function weeklyFromDaily(daily: number[]) {
  const complete = daily.slice(0, -1).slice(-WEEKS * 7)
  const weeks: number[] = []
  for (let i = 0; i < complete.length; i += 7) weeks.push(complete.slice(i, i + 7).reduce((a, b) => a + b, 0))
  return weeks
}

export function weekLabels(now = new Date()) {
  return Array.from({ length: WEEKS }, (_, index) => {
    const end = new Date(startOfDay(now).getTime() - (WEEKS - 1 - index) * 7 * DAY_MS - DAY_MS)
    return end.toLocaleDateString('en-PH', { month: 'short', day: 'numeric' })
  })
}

// ---------- Forecasting ----------

export interface ForecastResult {
  method: ForecastMethod
  fitted: (number | null)[]
  forecast: number[]
  lower: number[]
  upper: number[]
  mae: number
  mape: number
  rmse: number
  accuracy: number
  confidence: 'High' | 'Medium' | 'Low'
}

function errorStats(actual: number[], fitted: (number | null)[]) {
  const pairs = actual.map((value, i) => [value, fitted[i]] as const).filter((pair): pair is readonly [number, number] => pair[1] !== null)
  if (pairs.length === 0) return { mae: 0, mape: 0, rmse: 0 }
  const mae = pairs.reduce((sum, [a, f]) => sum + Math.abs(a - f), 0) / pairs.length
  const rmse = Math.sqrt(pairs.reduce((sum, [a, f]) => sum + (a - f) ** 2, 0) / pairs.length)
  const scored = pairs.filter(([a]) => a > 0)
  const mape = scored.length ? scored.reduce((sum, [a, f]) => sum + Math.abs(a - f) / a, 0) / scored.length : 0
  return { mae, mape, rmse }
}

export function forecastSeries(series: number[], method: ForecastMethod, settings: Pick<Settings, 'wmaWeights' | 'sesAlpha'>, horizon = 4): ForecastResult {
  const fitted: (number | null)[] = []
  let forecast: number[] = []

  if (method === 'WMA') {
    const weights = settings.wmaWeights
    const total = weights.reduce((a, b) => a + b, 0) || 1
    const wma = (end: number) => weights.reduce((sum, w, j) => sum + w * (series[end - 1 - j] ?? 0), 0) / total
    for (let t = 0; t < series.length; t++) fitted.push(t >= weights.length ? wma(t) : null)
    const next = wma(series.length)
    forecast = new Array(horizon).fill(next)
  } else if (method === 'SES') {
    const alpha = settings.sesAlpha
    let level = series[0] ?? 0
    for (let t = 0; t < series.length; t++) {
      fitted.push(t === 0 ? null : level)
      level = alpha * series[t] + (1 - alpha) * level
    }
    forecast = new Array(horizon).fill(level)
  } else {
    const alpha = settings.sesAlpha
    const beta = 0.2
    let level = series[0] ?? 0
    let trend = (series[1] ?? level) - level
    for (let t = 0; t < series.length; t++) {
      fitted.push(t < 2 ? null : level + trend)
      const previous = level
      level = alpha * series[t] + (1 - alpha) * (level + trend)
      trend = beta * (level - previous) + (1 - beta) * trend
    }
    forecast = Array.from({ length: horizon }, (_, h) => Math.max(0, level + (h + 1) * trend))
  }

  const { mae, mape, rmse } = errorStats(series, fitted)
  const lower = forecast.map((value, h) => Math.max(0, value - 1.28 * rmse * Math.sqrt(h + 1)))
  const upper = forecast.map((value, h) => value + 1.28 * rmse * Math.sqrt(h + 1))
  const accuracy = Math.max(0, 1 - mape)
  return { method, fitted, forecast, lower, upper, mae, mape, rmse, accuracy, confidence: mape < 0.15 ? 'High' : mape < 0.3 ? 'Medium' : 'Low' }
}

/** Picks the method with the lowest error on the product's own history. */
export function bestMethod(series: number[], settings: Pick<Settings, 'wmaWeights' | 'sesAlpha'>) {
  return (['WMA', 'SES', 'Holt'] as ForecastMethod[])
    .map((method) => forecastSeries(series, method, settings))
    .sort((a, b) => a.mape - b.mape)[0]
}

// ---------- Trend ----------

export function linearTrend(series: number[]) {
  const n = series.length
  const meanX = (n - 1) / 2
  const meanY = series.reduce((a, b) => a + b, 0) / (n || 1)
  let num = 0
  let den = 0
  series.forEach((y, x) => { num += (x - meanX) * (y - meanY); den += (x - meanX) ** 2 })
  const slope = den ? num / den : 0
  return { slope, mean: meanY, slopePct: meanY ? slope / meanY : 0 }
}

export function periodChange(series: number[], window = 4) {
  const recent = series.slice(-window).reduce((a, b) => a + b, 0)
  const prior = series.slice(-window * 2, -window).reduce((a, b) => a + b, 0)
  return prior ? (recent - prior) / prior : 0
}

export type TrendDirection = 'Rising' | 'Falling' | 'Stable'
export const trendDirection = (change: number): TrendDirection => (change > 0.06 ? 'Rising' : change < -0.06 ? 'Falling' : 'Stable')

// ---------- Inventory planning ----------

const zForService = (level: number) => (level >= 0.99 ? 2.33 : level >= 0.975 ? 1.96 : level >= 0.95 ? 1.645 : level >= 0.9 ? 1.28 : 0.84)

export interface ProductAnalysis {
  product: Product
  daily: number[]
  weekly: number[]
  forecast: ForecastResult
  weeklyDemand: number
  dailyDemand: number
  change: number
  direction: TrendDirection
  daysOfCover: number
  stockoutDate: Date | null
  onOrder: number
  safetyStock: number
  reorderLevel: number
  suggestedQty: number
  urgency: 'Urgent' | 'Reorder' | 'OK'
  expiryDays: number | null
  atRiskUnits: number
  markdown: number
  revenue28: number
  units28: number
}

export function analyseProduct(product: Product, history: Record<string, number[]>, transactions: Transaction[], purchaseOrders: PurchaseOrder[], settings: Settings, now = new Date()): ProductAnalysis {
  const daily = dailyUnits(product.id, history, transactions, now)
  const weekly = weeklyFromDaily(daily)
  const forecast = forecastSeries(weekly, settings.forecastMethod, settings)
  const weeklyDemand = forecast.forecast[0]
  const dailyDemand = weeklyDemand / 7
  const change = periodChange(weekly)
  const onOrder = purchaseOrders.filter((po) => po.status === 'Pending' || po.status === 'Partially received').flatMap((po) => po.lines).filter((line) => line.productId === product.id).reduce((sum, line) => sum + Math.max(0, line.qty - line.received), 0)
  const sdDaily = forecast.rmse / Math.sqrt(7)
  const safetyStock = zForService(settings.serviceLevel) * sdDaily * Math.sqrt(product.leadTimeDays)
  const reorderLevel = Math.max(product.reorderPoint, dailyDemand * product.leadTimeDays + safetyStock)
  const target = reorderLevel + dailyDemand * settings.coverDays
  const suggestedQty = product.stock + onOrder < reorderLevel ? Math.max(0, Math.ceil(target - product.stock - onOrder)) : 0
  const daysOfCover = dailyDemand > 0 ? product.stock / dailyDemand : Infinity
  const stockoutDate = Number.isFinite(daysOfCover) ? new Date(now.getTime() + daysOfCover * DAY_MS) : null
  const urgency = suggestedQty > 0 && (daysOfCover <= product.leadTimeDays || product.stock <= 0) ? 'Urgent' : suggestedQty > 0 ? 'Reorder' : 'OK'
  const expiryDays = product.expiry ? daysBetween(now, product.expiry) : null
  const sellable = expiryDays === null ? Infinity : dailyDemand * Math.max(0, expiryDays)
  const atRiskUnits = expiryDays === null ? 0 : Math.max(0, Math.round(product.stock - sellable))
  const riskShare = product.stock ? atRiskUnits / product.stock : 0
  const markdown = riskShare > 0.5 ? 0.3 : riskShare > 0.2 ? 0.15 : riskShare > 0 ? 0.1 : 0
  const units28 = daily.slice(-29, -1).reduce((a, b) => a + b, 0)
  return {
    product, daily, weekly, forecast, weeklyDemand, dailyDemand, change, direction: trendDirection(change), daysOfCover, stockoutDate, onOrder,
    safetyStock, reorderLevel, suggestedQty, urgency, expiryDays, atRiskUnits, markdown, units28, revenue28: units28 * product.price,
  }
}

// ---------- Store-level analytics ----------

export interface BasketRule { a: string; b: string; together: number; support: number; confidence: number; lift: number }

export function basketRules(transactions: Transaction[], minTogether = 6): BasketRule[] {
  const valid = transactions.filter((txn) => txn.status !== 'Voided')
  const single = new Map<string, number>()
  const pairs = new Map<string, number>()
  for (const txn of valid) {
    const ids = [...new Set(txn.lines.map((line) => line.productId))].sort()
    ids.forEach((id) => single.set(id, (single.get(id) ?? 0) + 1))
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const key = `${ids[i]}|${ids[j]}`
      pairs.set(key, (pairs.get(key) ?? 0) + 1)
    }
  }
  const n = valid.length || 1
  const rules: BasketRule[] = []
  for (const [key, together] of pairs) {
    if (together < minTogether) continue
    const [x, y] = key.split('|')
    // Express the rule from the item that more often leads to the other.
    const cx = together / (single.get(x) ?? 1)
    const cy = together / (single.get(y) ?? 1)
    const [a, b, confidence] = cx >= cy ? [x, y, cx] : [y, x, cy]
    const lift = confidence / ((single.get(b) ?? 1) / n)
    rules.push({ a, b, together, support: together / n, confidence, lift })
  }
  return rules.sort((p, q) => q.lift - p.lift)
}

/** Transactions per weekday (rows, Sun..Sat) × hour (columns). */
export function trafficHeatmap(transactions: Transaction[]) {
  const grid = Array.from({ length: 7 }, () => new Array(24).fill(0))
  for (const txn of transactions) {
    if (txn.status === 'Voided') continue
    const date = new Date(txn.date)
    grid[date.getDay()][date.getHours()] += 1
  }
  return grid
}

export function hourlySales(transactions: Transaction[], day: Date) {
  const hours = new Array(24).fill(0)
  for (const txn of transactions) {
    if (txn.status === 'Voided' || daysBetween(txn.date, day) !== 0) continue
    hours[new Date(txn.date).getHours()] += netTotal(txn)
  }
  return hours
}

export const netTotal = (txn: Transaction) => (txn.status === 'Voided' ? 0 : txn.total - txn.refunds.reduce((sum, refund) => sum + refund.amount, 0))

export function abcClasses(analyses: ProductAnalysis[]) {
  const sorted = [...analyses].sort((a, b) => b.revenue28 - a.revenue28)
  const total = sorted.reduce((sum, item) => sum + item.revenue28, 0) || 1
  let running = 0
  const classes = new Map<string, 'A' | 'B' | 'C'>()
  for (const item of sorted) {
    running += item.revenue28
    classes.set(item.product.id, running / total <= 0.8 ? 'A' : running / total <= 0.95 ? 'B' : 'C')
  }
  return classes
}

export interface Anomaly { productId: string; daysAgo: number; value: number; expected: number; z: number }

export function detectAnomalies(analyses: ProductAnalysis[]): Anomaly[] {
  const anomalies: Anomaly[] = []
  for (const item of analyses) {
    const complete = item.daily.slice(0, -1)
    const baseline = complete.slice(-42, -14)
    const mean = baseline.reduce((a, b) => a + b, 0) / (baseline.length || 1)
    const sd = Math.sqrt(baseline.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (baseline.length || 1)) || 1
    complete.slice(-14).forEach((value, index) => {
      const z = (value - mean) / sd
      if (Math.abs(z) >= 3 && Math.abs(value - mean) >= 4) anomalies.push({ productId: item.product.id, daysAgo: 14 - index, value, expected: mean, z })
    })
  }
  return anomalies.sort((a, b) => Math.abs(b.z) - Math.abs(a.z))
}

export function normaliseRequest(item: string) {
  return item.toLowerCase().replace(/\(.*?\)/g, '').replace(/\b(1|2)\s?(l|kg|gal|gallon)\b|\b\d+\s?(ml|g)\b/g, '').replace(/[^a-z ]/g, ' ').replace(/\b(unsweetened|ligo|hot|gallon|gal)\b/g, '').replace(/\s+/g, ' ').trim()
}

export function requestDemand(requests: CustomerRequest[], now = new Date()) {
  const groups = new Map<string, { key: string; label: string; count: number; latest: string; ids: string[]; open: number }>()
  for (const request of requests) {
    if (daysBetween(request.date, now) > 30) continue
    const normalised = normaliseRequest(request.item)
    const words = new Set(normalised.split(' '))
    // Merge with an existing group when one request's words contain the other's ("soy sauce" ⊂ "silver swan soy sauce").
    const key = [...groups.keys()].find((k) => { const other = k.split(' '); return other.every((w) => words.has(w)) || [...words].every((w) => other.includes(w)) }) ?? normalised
    const group = groups.get(key) ?? { key, label: request.item, count: 0, latest: request.date, ids: [], open: 0 }
    group.count += 1
    group.ids.push(request.id)
    if (request.status === 'New' || request.status === 'Reviewing') group.open += 1
    if (request.date > group.latest) group.latest = request.date
    groups.set(key, group)
  }
  return [...groups.values()].sort((a, b) => b.count - a.count)
}

// ---------- Insight feed ----------

export interface Insight {
  id: string
  severity: 'critical' | 'warning' | 'opportunity' | 'info'
  title: string
  detail: string
  metric?: string
  action?: { label: string; workspace: WorkspaceName; productId?: string }
}

export function buildInsights(analyses: ProductAnalysis[], transactions: Transaction[], waste: WasteEntry[], requests: CustomerRequest[], now = new Date()): Insight[] {
  const insights: Insight[] = []
  const urgent = analyses.filter((a) => a.urgency === 'Urgent').sort((a, b) => a.daysOfCover - b.daysOfCover)
  for (const item of urgent.slice(0, 3)) {
    insights.push({
      id: `stockout-${item.product.id}`, severity: 'critical',
      title: `${item.product.name} will run out in ${item.daysOfCover < 1 ? 'under a day' : `${Math.floor(item.daysOfCover)} day${Math.floor(item.daysOfCover) === 1 ? '' : 's'}`}`,
      detail: `Forecast demand is ${item.weeklyDemand.toFixed(1)} ${item.product.unit}s/week but only ${item.product.stock} are on hand and supplier lead time is ${item.product.leadTimeDays} day(s). Order ${item.suggestedQty} now.`,
      metric: `${item.suggestedQty} to order`, action: { label: 'Review reorder', workspace: 'Purchasing', productId: item.product.id },
    })
  }
  const reorder = analyses.filter((a) => a.urgency === 'Reorder')
  if (reorder.length) insights.push({ id: 'reorder', severity: 'warning', title: `${reorder.length} more item${reorder.length > 1 ? 's' : ''} below the AI reorder level`, detail: reorder.slice(0, 4).map((a) => a.product.name).join(', ') + (reorder.length > 4 ? '…' : ''), metric: `${reorder.length} items`, action: { label: 'Open purchasing', workspace: 'Purchasing' } })

  const expiring = analyses.filter((a) => a.atRiskUnits > 0).sort((a, b) => b.atRiskUnits * b.product.cost - a.atRiskUnits * a.product.cost)
  for (const item of expiring.slice(0, 2)) {
    insights.push({
      id: `expiry-${item.product.id}`, severity: 'warning',
      title: `${item.atRiskUnits} ${item.product.name} likely to expire unsold`,
      detail: `Expires in ${item.expiryDays} day(s); expected sales before then are ~${Math.round(item.dailyDemand * Math.max(0, item.expiryDays ?? 0))}. A ${Math.round(item.markdown * 100)}% markdown could recover ${peso(item.atRiskUnits * item.product.price * (1 - item.markdown), 0)}.`,
      metric: `${peso(item.atRiskUnits * item.product.cost, 0)} at risk`, action: { label: 'Open waste', workspace: 'Waste', productId: item.product.id },
    })
  }

  const movers = [...analyses].filter((a) => a.units28 > 10).sort((a, b) => b.change - a.change)
  const riser = movers[0]
  if (riser && riser.change > 0.08) insights.push({ id: 'riser', severity: 'opportunity', title: `${riser.product.name} demand is up ${pct(riser.change, 0)}`, detail: `Last 4 weeks vs the 4 before. Consider a larger facing or bundle; forecast next week: ${riser.weeklyDemand.toFixed(0)} units.`, metric: pct(riser.change, 0), action: { label: 'See forecast', workspace: 'AI Insights', productId: riser.product.id } })
  const faller = movers[movers.length - 1]
  if (faller && faller.change < -0.08) insights.push({ id: 'faller', severity: 'info', title: `${faller.product.name} demand is down ${pct(Math.abs(faller.change), 0, false)}`, detail: 'Reduce the next order quantity or run a promotion to avoid overstock.', metric: pct(faller.change, 0), action: { label: 'See forecast', workspace: 'AI Insights', productId: faller.product.id } })

  const rules = basketRules(transactions)
  const rule = rules[0]
  if (rule) {
    const a = analyses.find((x) => x.product.id === rule.a)?.product
    const b = analyses.find((x) => x.product.id === rule.b)?.product
    if (a && b) insights.push({ id: 'basket', severity: 'opportunity', title: `${Math.round(rule.confidence * 100)}% of ${a.name} buyers also buy ${b.name}`, detail: `These items are bought together ${rule.lift.toFixed(1)}× more often than chance. Place them near each other or bundle them.`, metric: `${rule.lift.toFixed(1)}× lift`, action: { label: 'Basket analysis', workspace: 'AI Insights' } })
  }

  const anomalies = detectAnomalies(analyses)
  const anomaly = anomalies[0]
  if (anomaly) {
    const product = analyses.find((x) => x.product.id === anomaly.productId)?.product
    if (product) insights.push({ id: 'anomaly', severity: 'info', title: `Unusual spike: ${product.name} ${anomaly.daysAgo} days ago`, detail: `Sold ${anomaly.value} vs ~${anomaly.expected.toFixed(0)} normally (${anomaly.z.toFixed(1)}σ). The model down-weights one-off events like fiestas.`, metric: `${anomaly.z.toFixed(1)}σ` })
  }

  const demand = requestDemand(requests, now).filter((group) => group.count >= 3 && group.open > 0)
  for (const group of demand.slice(0, 1)) insights.push({ id: `request-${group.key}`, severity: 'opportunity', title: `"${group.label}" requested ${group.count}× this month`, detail: 'Repeated customer requests suggest unmet demand. Consider adding it to the catalog.', metric: `${group.count} requests`, action: { label: 'Open requests', workspace: 'Requests' } })

  const monthWaste = waste.filter((entry) => daysBetween(entry.date, now) <= 30)
  const wasteValue = monthWaste.reduce((sum, entry) => sum + entry.value, 0)
  const sales30 = transactions.reduce((sum, txn) => sum + netTotal(txn), 0) / DETAIL_DAYS * 30
  if (wasteValue > 0) insights.push({ id: 'waste', severity: wasteValue / sales30 > 0.01 ? 'warning' : 'info', title: `Shrink is ${(wasteValue / (sales30 || 1) * 100).toFixed(2)}% of sales this month`, detail: `${peso(wasteValue, 0)} written off across ${monthWaste.length} entries. ${mostCommon(monthWaste.map((e) => e.reason))} is the top reason.`, metric: peso(wasteValue, 0), action: { label: 'Waste log', workspace: 'Waste' } })

  return insights
}

function mostCommon(values: string[]) {
  const counts = new Map<string, number>()
  values.forEach((v) => counts.set(v, (counts.get(v) ?? 0) + 1))
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'Other'
}

// ---------- Ask the assistant ----------

export interface AssistantAnswer { text: string; bullets?: string[]; action?: Insight['action'] }

export function askAssistant(question: string, analyses: ProductAnalysis[], transactions: Transaction[], now = new Date()): AssistantAnswer {
  const q = question.toLowerCase()
  const findProduct = () => analyses.find((a) => a.product.name.toLowerCase().split(/[\s(]+/).filter((w) => w.length > 3).some((word) => q.includes(word)))

  if (/reorder|restock|order|run out|stock ?out/.test(q)) {
    const list = analyses.filter((a) => a.suggestedQty > 0).sort((a, b) => a.daysOfCover - b.daysOfCover)
    if (!list.length) return { text: 'Nothing needs reordering right now — every product is above its AI reorder level.' }
    return { text: `${list.length} products should be reordered. Most urgent first:`, bullets: list.slice(0, 6).map((a) => `${a.product.name}: order ${a.suggestedQty} (${Number.isFinite(a.daysOfCover) ? a.daysOfCover.toFixed(1) : '∞'} days of cover)`), action: { label: 'Open purchasing', workspace: 'Purchasing' } }
  }
  if (/expir|spoil|waste|markdown/.test(q)) {
    const list = analyses.filter((a) => a.atRiskUnits > 0)
    if (!list.length) return { text: 'No stock is predicted to expire before it sells.' }
    return { text: 'These items are predicted to expire before they sell:', bullets: list.map((a) => `${a.product.name}: ${a.atRiskUnits} at risk in ${a.expiryDays}d — suggest ${Math.round(a.markdown * 100)}% off`), action: { label: 'Waste log', workspace: 'Waste' } }
  }
  if (/together|bundle|basket|pair/.test(q)) {
    const rules = basketRules(transactions).slice(0, 5)
    const name = (id: string) => analyses.find((a) => a.product.id === id)?.product.name ?? id
    return { text: 'Strongest product pairings from recent receipts:', bullets: rules.map((r) => `${name(r.a)} → ${name(r.b)} (${Math.round(r.confidence * 100)}% of the time, ${r.lift.toFixed(1)}× lift)`) }
  }
  if (/busy|peak|hour|staff/.test(q)) {
    const grid = trafficHeatmap(transactions)
    const hours = grid[0].map((_, h) => grid.reduce((sum, row) => sum + row[h], 0))
    const ranked = hours.map((count, hour) => ({ count, hour })).sort((a, b) => b.count - a.count).slice(0, 3)
    const days = grid.map((row, day) => ({ day, count: row.reduce((a, b) => a + b, 0) })).sort((a, b) => b.count - a.count)
    const dayName = (d: number) => ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d]
    return { text: `Busiest day is ${dayName(days[0].day)}; peak hours are:`, bullets: ranked.map((r) => `${String(r.hour).padStart(2, '0')}:00–${String(r.hour + 1).padStart(2, '0')}:00 · ${r.count} transactions this week`) }
  }
  if (/best|top|sell/.test(q) && !/worst|slow/.test(q)) {
    const list = [...analyses].sort((a, b) => b.revenue28 - a.revenue28).slice(0, 5)
    return { text: 'Top sellers by revenue over the last 28 days:', bullets: list.map((a) => `${a.product.name}: ${peso(a.revenue28, 0)} (${a.units28} units, ${pct(a.change, 0)} trend)`) }
  }
  if (/worst|slow|dead/.test(q)) {
    const list = [...analyses].sort((a, b) => a.units28 - b.units28).slice(0, 5)
    return { text: 'Slowest movers over the last 28 days:', bullets: list.map((a) => `${a.product.name}: ${a.units28} units, ${a.product.stock} on hand`) }
  }
  if (/trend|rising|falling|grow/.test(q)) {
    const sorted = [...analyses].sort((a, b) => b.change - a.change)
    return { text: 'Biggest demand shifts (last 4 weeks vs prior 4):', bullets: [...sorted.slice(0, 3), ...sorted.slice(-2)].map((a) => `${a.product.name}: ${pct(a.change, 0)} (${a.direction.toLowerCase()})`), action: { label: 'Trend analysis', workspace: 'AI Insights' } }
  }
  const product = findProduct()
  if (product || /forecast|predict|next week/.test(q)) {
    const target = product ?? [...analyses].sort((a, b) => b.revenue28 - a.revenue28)[0]
    return {
      text: `${target.product.name}: next week's forecast is ${target.weeklyDemand.toFixed(1)} ${target.product.unit}s (${target.forecast.method}, ${Math.round(target.forecast.accuracy * 100)}% backtest accuracy).`,
      bullets: [`On hand: ${target.product.stock} · ${Number.isFinite(target.daysOfCover) ? target.daysOfCover.toFixed(1) : '∞'} days of cover`, `Trend: ${pct(target.change, 0)} (${target.direction.toLowerCase()})`, target.suggestedQty ? `Recommended order: ${target.suggestedQty}` : 'No reorder needed yet'],
      action: { label: 'Open forecast', workspace: 'AI Insights', productId: target.product.id },
    }
  }
  if (/sales|revenue|today/.test(q)) {
    const today = transactions.filter((t) => daysBetween(t.date, now) === 0)
    return { text: `Today so far: ${peso(today.reduce((s, t) => s + netTotal(t), 0))} from ${today.length} transactions.` }
  }
  return { text: 'I can answer questions about reorders, expiring stock, trends, best/slow sellers, product forecasts, busy hours and items bought together. Try "What should I reorder?"' }
}