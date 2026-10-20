import { useState, type ReactNode } from 'react'
import { netTotal } from '../lib/ai'
import { DAY_MS, daysBetween, num, pct, peso } from '../lib/format'
import { useAnalytics, useCurrentUser, useStore } from '../store/StoreContext'
import type { WorkspaceName } from '../data/types'

const tileInfo: Record<WorkspaceName, { icon: string; text: string }> = {
  'Point of Sale': { icon: '↗', text: 'Scan or search items, take payment' },
  Transactions: { icon: '≡', text: 'Receipt history, returns & refunds' },
  'Admin Station': { icon: '⇄', text: 'Manage PCs, assign cashiers & team' },
  Dashboard: { icon: '▦', text: 'Store overview' },
  Inventory: { icon: '▤', text: 'Products, batches, stock' },
  Purchasing: { icon: '☰', text: 'Reorder lists, purchase orders' },
  Waste: { icon: '⌁', text: 'Damaged, expired, spoiled' },
  Requests: { icon: '☷', text: 'Items customers asked for' },
  Reports: { icon: '▥', text: 'Sales reports, X/Z readings' },
  'AI Insights': { icon: '✦', text: 'Demand forecast, trends, anomalies' },
  Settings: { icon: '⚙', text: 'Store details, receipt, backup' },
}

const tileLabel: Partial<Record<WorkspaceName, string>> = { 'Point of Sale': 'Make a Sale', Requests: 'Item Requests', Reports: 'Report Center' }

const NOTES_KEY = 'main-menu-notes'
function loadNotes() { try { return localStorage.getItem(NOTES_KEY) ?? '' } catch { return '' } }
function saveNotes(value: string) { try { localStorage.setItem(NOTES_KEY, value) } catch { /* private window: notes just won't persist */ } }

function Tile({ workspace, foot, onOpen }: { workspace: WorkspaceName; foot?: ReactNode; onOpen: () => void }) {
  return <button className={workspace === 'Point of Sale' ? 'menu-tile primary' : 'menu-tile'} onClick={onOpen}>
    <span className="menu-tile-icon">{tileInfo[workspace].icon}</span>
    <b>{tileLabel[workspace] ?? workspace}</b>
    <span className="menu-tile-text">{tileInfo[workspace].text}</span>
    <span className="menu-tile-foot">{foot}</span>
  </button>
}

/** The home screen: one tile per workspace the signed-in role may open, plus a store overview. */
export function MainMenu({ workspaces, onOpen }: { workspaces: WorkspaceName[]; onOpen: (workspace: WorkspaceName) => void }) {
  const { state } = useStore()
  const { analyses } = useAnalytics()
  const user = useCurrentUser()
  const [notes, setNotes] = useState(loadNotes)
  const owner = user?.role === 'Owner'
  const now = new Date()
  const hour = now.getHours()
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
  const first = user?.name.split(' ')[0] ?? 'there'

  const live = state.transactions.filter((t) => t.status !== 'Voided')
  const salesOn = (daysAgo: number) => live.filter((t) => daysBetween(t.date, new Date(now.getTime() - daysAgo * DAY_MS)) === 0)
  const today = salesOn(0)
  const sales = today.reduce((s, t) => s + netTotal(t), 0)
  const yesterdaySales = salesOn(1).reduce((s, t) => s + netTotal(t), 0)
  const last7 = Array.from({ length: 7 }, (_, i) => salesOn(6 - i).reduce((s, t) => s + netTotal(t), 0))
  const maxDay = Math.max(1, ...last7)
  const firstDay = new Date(now.getTime() - 6 * DAY_MS).toLocaleDateString('en-PH', { weekday: 'short' })

  const shiftStart = new Date(state.shift.openedAt).getTime()
  const shiftSales = live.filter((t) => new Date(t.date).getTime() >= shiftStart)

  const lowStock = analyses.filter((a) => a.urgency !== 'OK' || a.product.stock <= a.product.reorderPoint)
  const expiring = analyses.filter((a) => a.expiryDays !== null && a.expiryDays <= state.settings.expiryWarningDays)
  const newRequests = state.requests.filter((r) => r.status === 'New').length
  const pendingOrders = state.purchaseOrders.filter((p) => p.status === 'Draft' || p.status === 'Sent').length
  const names = (list: typeof analyses) => list.slice(0, 2).map((a) => a.product.name).join(', ') + (list.length > 2 ? `, +${list.length - 2}` : '')
  const forecast = [...analyses].sort((a, b) => b.weeklyDemand - a.weeklyDemand).slice(0, 3)
  const can = (w: WorkspaceName) => workspaces.includes(w)

  const foot: Partial<Record<WorkspaceName, ReactNode>> = {
    Transactions: <>{num(today.length)} sales today</>,
    Inventory: lowStock.length > 0 ? <span className="menu-tag">{lowStock.length} low stock</span> : 'Stock levels look healthy',
    Purchasing: <>{pendingOrders} order{pendingOrders === 1 ? '' : 's'} pending</>,
    Waste: expiring.length > 0 ? <span className="menu-tag">{expiring.length} expiring soon</span> : 'Nothing expiring soon',
    Requests: <>{newRequests} pending</>,
  }

  return <section className="main-menu">
    <div className="menu-heading">
      <span className="eyebrow">MAIN MENU</span>
      <h1>{owner ? `${greeting}, ${first}` : `Hi ${first}, ready for the next customer?`}</h1>
    </div>
    <div className="menu-layout">
      <div className="menu-grid">
        {workspaces.map((workspace) => <Tile key={workspace} workspace={workspace} foot={foot[workspace]} onOpen={() => onOpen(workspace)} />)}
      </div>

      <aside className="menu-side">
        <div className="menu-panel-head"><span>{owner ? 'STORE OVERVIEW' : 'ALERTS & NOTIFICATIONS'}</span>{owner && can('Dashboard') && <button onClick={() => onOpen('Dashboard')}>Open Dashboard</button>}</div>

        {owner
          ? <div className="menu-stats">
            <div><small>TODAY'S SALES</small><strong>{peso(sales, 0)}</strong><span>{yesterdaySales ? `${pct((sales - yesterdaySales) / yesterdaySales)} vs yesterday` : 'No sales yesterday to compare'}</span></div>
            <div><small>TRANSACTIONS</small><strong>{num(today.length)}</strong><span>avg {peso(today.length ? sales / today.length : 0, 0)} per sale</span></div>
          </div>
          : <div className="menu-stats">
            <div><small>SALES THIS SHIFT</small><strong>{peso(shiftSales.reduce((s, t) => s + netTotal(t), 0), 0)}</strong></div>
            <div><small>CUSTOMERS</small><strong>{num(shiftSales.length)}</strong></div>
          </div>}

        {owner && <div className="menu-block">
          <small className="menu-label">LAST 7 DAYS</small>
          <div className="menu-bars">{last7.map((v, i) => <i key={i} className={i === 6 ? 'today' : ''} style={{ height: `${Math.max(4, (v / maxDay) * 100)}%` }} title={peso(v, 0)} />)}</div>
          <div className="menu-bars-labels"><span>{firstDay}</span><span>Today</span></div>
        </div>}

        <div className="menu-block">
          {owner && <small className="menu-label">ALERTS</small>}
          <ul className="menu-alert-list">
            {lowStock.length > 0 && <li className="warn"><b>{lowStock.length} product{lowStock.length === 1 ? '' : 's'} below reorder level</b><span>{names(lowStock)}</span></li>}
            {expiring.length > 0 && <li className="warn"><b>{expiring.length} product{expiring.length === 1 ? '' : 's'} expire within {state.settings.expiryWarningDays} days</b><span>{names(expiring)}</span></li>}
            {newRequests > 0 && <li className="info"><b>{newRequests} customer request{newRequests === 1 ? '' : 's'} pending</b><span>Open Item Requests to review</span></li>}
            {lowStock.length === 0 && expiring.length === 0 && newRequests === 0 && <li className="ok"><b>All clear</b><span>Nothing needs attention right now.</span></li>}
          </ul>
        </div>

        {owner && can('AI Insights') && <div className="menu-block">
          <small className="menu-label">DEMAND FORECAST · NEXT 7 DAYS</small>
          <ul className="menu-forecast">
            {forecast.map((a) => <li key={a.product.id}><span>{a.product.name}</span><b className={a.change > 0.02 ? 'up' : a.change < -0.02 ? 'down' : ''}>{a.change > 0.02 ? '↑' : a.change < -0.02 ? '↓' : '→'} {Math.round(a.weeklyDemand)} {a.product.unit}s</b></li>)}
            {forecast.length === 0 && <li><span>Not enough sales history yet.</span></li>}
          </ul>
        </div>}

        {owner && <div className="menu-block">
          <small className="menu-label">NOTES</small>
          <textarea className="menu-notes" rows={3} value={notes} placeholder="Jot a reminder for yourself or staff…" onChange={(event) => { setNotes(event.target.value); saveNotes(event.target.value) }} />
        </div>}
      </aside>
    </div>
  </section>
}
