import { useEffect, useState } from 'react'
import { iconRegistry } from '../../icons/iconRegistry'
import { hourlySales, netTotal } from '../../lib/ai'
import { DAY_MS, daysBetween, num, pct, peso } from '../../lib/format'
import { getDashboardAlerts, getDashboardSummary, getSalesTrend, type DashboardAlerts, type DashboardSummary, type SalesTrend } from '../../services/api'
import { allowedWorkspaces, useAnalytics, useCurrentUser, useStore } from '../../store/StoreContext'
import type { WorkspaceName } from '../../data/types'
import { BarList, ComboChart, Legend, Metric, SERIES, SectionHeading } from '../ui'
import { InsightCard } from './Insights'

interface AttentionItem { key: string; name: string; detail: string; kind: 'out' | 'low' | 'expiry'; label: string }

export function DashboardPanel() {
  const { state, actions } = useStore()
  const { analyses, insights } = useAnalytics()
  const user = useCurrentUser()
  const live = state.source === 'live'
  const expiryDays = state.settings.expiryWarningDays
  const [server, setServer] = useState<{ summary: DashboardSummary; alerts: DashboardAlerts; trend: SalesTrend } | null>(null)
  const [loadError, setLoadError] = useState(false)

  // Live mode: every number comes from the server's SQL. Re-fetched whenever the store snapshot refreshes (every 20 s).
  useEffect(() => {
    if (!live) return
    let cancelled = false
    Promise.all([getDashboardSummary(expiryDays), getDashboardAlerts(expiryDays), getSalesTrend(7)])
      .then(([summary, alerts, trend]) => { if (!cancelled) { setServer({ summary, alerts, trend }); setLoadError(false) } })
      .catch(() => { if (!cancelled) setLoadError(true) })
    return () => { cancelled = true }
  }, [live, expiryDays, state.liveSyncedAt])

  const now = new Date()
  const hour = now.getHours()
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
  const allowed = allowedWorkspaces(state.settings, user?.role ?? 'Owner')
  const shortcuts = (['Point of Sale', 'Inventory', 'AI Insights', 'Waste', 'Reports', 'Settings'] as WorkspaceName[]).filter((w) => allowed.includes(w))
  const shortcutText: Partial<Record<WorkspaceName, string>> = { 'Point of Sale': 'Start a transaction', Inventory: 'Manage stock and reorders', 'AI Insights': 'Forecasts, trends & basket analysis', Waste: 'Track losses', Reports: 'X/Z readings, VAT & BIR', Settings: 'Store preferences' }

  // Demo mode (no server): the same numbers worked out in the browser, as before.
  const demo = (() => {
    const today = state.transactions.filter((t) => daysBetween(t.date, now) === 0 && t.status !== 'Voided')
    const prev = state.transactions.filter((t) => daysBetween(t.date, now) === 1 && t.status !== 'Voided' && new Date(t.date).getTime() + DAY_MS <= now.getTime())
    const sales = today.reduce((s, t) => s + netTotal(t), 0)
    const prevSales = prev.reduce((s, t) => s + netTotal(t), 0)
    const todayHourly = hourlySales(state.transactions, now)
    const pastDays = [1, 2, 3, 4, 5, 6].map((d) => hourlySales(state.transactions, new Date(now.getTime() - d * DAY_MS)))
    const topToday = new Map<string, number>()
    today.forEach((t) => t.lines.forEach((l) => topToday.set(l.name, (topToday.get(l.name) ?? 0) + l.qty * l.price)))
    const urgent = analyses.filter((a) => a.urgency === 'Urgent')
    const expiring = analyses.filter((a) => a.expiryDays !== null && a.expiryDays <= expiryDays)
    const attention: AttentionItem[] = [...urgent, ...expiring.filter((e) => !urgent.includes(e))].slice(0, 4).map((a) => a.urgency === 'Urgent'
      ? { key: a.product.id, name: a.product.name, detail: `${a.product.stock} ${a.product.unit}s left · ~${Math.max(0, a.daysOfCover).toFixed(1)} days of cover`, kind: 'low', label: 'LOW STOCK' }
      : { key: a.product.id, name: a.product.name, detail: `${a.product.stock} ${a.product.unit}s left · expires in ${a.expiryDays} day(s)`, kind: 'expiry', label: 'EXPIRING' })
    return {
      sales, receipts: today.length, salesChange: prevSales ? (sales - prevSales) / prevSales : 0,
      receiptsChange: prev.length ? (today.length - prev.length) / prev.length : 0,
      last7: Array.from({ length: 7 }, (_, i) => state.transactions.filter((t) => daysBetween(t.date, now) === 6 - i).reduce((s, t) => s + netTotal(t), 0)),
      todayHourly, avgHourly: todayHourly.map((_, h) => pastDays.reduce((s, day) => s + day[h], 0) / pastDays.length),
      top: [...topToday].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([label, value]) => ({ label, value })),
      reorder: analyses.filter((a) => a.urgency !== 'OK' || a.product.stock <= a.product.reorderPoint).length,
      reorderNote: `${urgent.length} urgent`, reorderSub: 'reorder level',
      expiringProducts: expiring.length, expiringUnits: expiring.reduce((s, e) => s + e.product.stock, 0),
      alertTitle: urgent.length + expiring.length,
      alertText: `${urgent.length} predicted stock-out${urgent.length === 1 ? '' : 's'} and ${expiring.length} near-expiry product${expiring.length === 1 ? '' : 's'}.`,
      attention,
    }
  })()

  const fromServer = (() => {
    if (!server) return null
    const { summary: s, alerts: a, trend } = server
    const attention: AttentionItem[] = [
      ...a.lowStock.filter((x) => x.outOfStock).map((x): AttentionItem => ({ key: `o${x.productId}`, name: x.name, detail: `Out of stock · reorder at ${x.reorderPoint} ${x.unit}`, kind: 'out', label: 'OUT OF STOCK' })),
      ...a.expiring.map((x): AttentionItem => ({ key: `e${x.batchId}`, name: x.name, detail: x.expired ? `${x.qty} ${x.unit}${x.qty === 1 ? '' : 's'} expired ${Math.abs(x.daysLeft)} day(s) ago${x.batchNumber ? ` · batch ${x.batchNumber}` : ''}` : `${x.qty} ${x.unit}${x.qty === 1 ? '' : 's'} expire${x.qty === 1 ? 's' : ''} in ${x.daysLeft} day(s)${x.batchNumber ? ` · batch ${x.batchNumber}` : ''}`, kind: 'expiry', label: x.expired ? 'EXPIRED' : 'EXPIRING' })),
      ...a.lowStock.filter((x) => !x.outOfStock).map((x): AttentionItem => ({ key: `l${x.productId}`, name: x.name, detail: `${x.stock} ${x.unit} left · reorder at ${x.reorderPoint}`, kind: 'low', label: 'LOW STOCK' })),
    ].slice(0, 4)
    const pad = (values: number[]) => Array.from({ length: 24 }, (_, h) => values[h] ?? 0)
    return {
      sales: s.today.sales, receipts: s.today.receipts, salesChange: s.salesChange, receiptsChange: s.receiptsChange,
      last7: s.last7Days, todayHourly: pad(trend.hourly.today), avgHourly: pad(trend.hourly.average6Days),
      top: s.topSellers.slice(0, 5).map((t) => ({ label: t.name, value: t.revenue })),
      reorder: s.inventory.needReorder, reorderNote: `${s.inventory.outOfStock} out of stock`, reorderSub: 'at or below reorder level',
      expiringProducts: s.inventory.nearExpiryProducts, expiringUnits: s.inventory.nearExpiryUnits,
      alertTitle: a.counts.outOfStock + a.counts.expiringBatches,
      alertText: [a.counts.outOfStock > 0 ? `${a.counts.outOfStock} out of stock` : '', a.counts.expiringBatches > 0 ? `${a.counts.expiringBatches} batch${a.counts.expiringBatches === 1 ? '' : 'es'} expired or expiring within ${a.expiryDays} days` : ''].filter(Boolean).join(' and ') + '.',
      attention,
    }
  })()

  const view = live ? fromServer : demo
  if (!view) return <div className="dashboard-panel"><p className="muted-text pad dashboard-loading">{loadError ? 'Could not load the dashboard from the server. Retrying with the next refresh…' : 'Loading the dashboard…'}</p></div>
  const { sales, receipts, todayHourly, avgHourly, attention } = view
  const hours = Array.from({ length: 15 }, (_, i) => i + 7)

  return <div className="dashboard-panel">
    {view.alertTitle > 0 && <div className="alert-banner"><span className="alert-mark">!</span><div><b>{view.alertTitle} item{view.alertTitle === 1 ? '' : 's'} need attention</b><span>{view.alertText}</span></div>{allowed.includes('Inventory') && <button onClick={() => actions.navigate('Inventory', { inventoryFilter: 'Low stock' })}>REVIEW INVENTORY <span>↗</span></button>}</div>}
    <div className="dashboard-heading"><div><span className="eyebrow">{now.toLocaleDateString('en-PH', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).toUpperCase()}</span><h1>{greeting}, {user?.name.split(' ')[0] ?? 'there'}.</h1><p>Here’s how {state.settings.storeName} is performing today.</p></div><span className="open-status"><i /> {hour >= 7 && hour < 21 ? 'STORE OPEN' : 'STORE CLOSED'}</span></div>
    <div className="metric-grid">
      <Metric label="Today's sales" value={peso(sales, 0)} change={pct(view.salesChange)} note="vs. yesterday, same time" accent="green" spark={view.last7} />
      <Metric label="Transactions" value={num(receipts)} change={pct(view.receiptsChange)} note={`avg basket ${peso(receipts ? sales / receipts : 0, 0)}`} accent="orange" />
      <Metric label="Reorder needed" value={String(view.reorder).padStart(2, '0')} change={view.reorderNote} note={view.reorderSub} accent="red" />
      <Metric label="Near expiry" value={String(view.expiringProducts).padStart(2, '0')} change={`next ${expiryDays} days`} note={`${view.expiringUnits} units`} accent="blue" />
    </div>
    <div className="dashboard-lower">
      <section className="dashboard-module"><SectionHeading title="SALES BY HOUR · TODAY VS 6-DAY AVERAGE" />
        <div className="module-body">
          <Legend items={[{ name: 'Today', color: SERIES[0], kind: 'bar' }, { name: '6-day average', color: SERIES[2], kind: 'line' }]} />
          <ComboChart height={190} labels={hours.map((h) => `${h % 12 || 12}${h < 12 ? 'a' : 'p'}`)} bars={{ name: 'Today', color: SERIES[0], values: hours.map((h) => (h <= hour ? todayHourly[h] : null)) }} lines={[{ name: '6-day average', color: SERIES[2], values: hours.map((h) => avgHourly[h]) }]} format={(v) => (v >= 1000 ? `₱${(v / 1000).toFixed(1)}k` : `₱${v.toFixed(0)}`)} />
        </div>
      </section>
      <section className="dashboard-module"><SectionHeading title="TOP SELLERS TODAY" />
        <div className="module-body">{view.top.length ? <BarList items={view.top} format={(v) => peso(v, 0)} /> : <p className="muted-text">No sales yet today.</p>}</div>
      </section>
    </div>
    <div className="dashboard-lower">
      <section className="dashboard-module"><SectionHeading title="AI INSIGHTS" action={allowed.includes('AI Insights') ? 'ALL INSIGHTS' : undefined} onAction={() => actions.navigate('AI Insights')} />
        <div className="insight-list compact">{insights.slice(0, 3).map((insight) => <InsightCard key={insight.id} insight={insight} />)}</div>
      </section>
      <section className="dashboard-module attention-module"><SectionHeading title="NEEDS ATTENTION" action={allowed.includes('Inventory') ? 'VIEW ALL' : undefined} onAction={() => actions.navigate('Inventory')} />
        {attention.length === 0 && <p className="muted-text pad">All stock levels look healthy.</p>}
        {attention.map((a) => <div className="attention-item" key={a.key}>
          <span className={a.kind === 'expiry' ? 'attention-symbol expiry' : a.kind === 'out' ? 'attention-symbol out' : 'attention-symbol warning'}>{a.kind === 'expiry' ? '◷' : '!'}</span>
          <div><b>{a.name}</b><small>{a.detail}</small></div>
          <span className="attention-count">{a.label}</span>
        </div>)}
        <div className="shortcut-grid">
          {shortcuts.map((name, index) => <button key={name} className="shortcut" onClick={() => actions.navigate(name)}><span className={`shortcut-icon tone-${index}`}>{iconRegistry.shortcuts[name] ?? '↗'}</span><span><b>{name}</b><small>{shortcutText[name]}</small></span><i>→</i></button>)}
        </div>
      </section>
    </div>
  </div>
}