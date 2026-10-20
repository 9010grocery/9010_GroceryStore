import { useEffect, useState } from 'react'
import type { CustomerRequest, Employee, RequestStatus, Role, WasteReason } from '../../data/types'
import { netTotal, requestDemand } from '../../lib/ai'
import { daysBetween, initials, peso, relativeDay, time } from '../../lib/format'
import { apiErrorMessage, getEmployeeActivity, getEmployees, getRequests, getRequestsSummary, getWaste, getWasteSummary, type EmployeeActivity, type EmployeeRow, type RequestsSummary, type WasteRow } from '../../services/api'
import { allowedWorkspaces, useAnalytics, useCurrentUser, useStore } from '../../store/StoreContext'
import { BarList, Empty, Field, Metric, Modal, SERIES, Segmented, SectionHeading, StatusPill } from '../ui'

/** Loads data from the server (live mode only) and reloads whenever `deps` change. Demo mode gets `null` and computes locally. */
function useServerData<T>(enabled: boolean, load: () => Promise<T>, deps: unknown[]): { data: T | null; error: string | null } {
  const [result, setResult] = useState<{ data: T | null; error: string | null }>({ data: null, error: null })
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    load().then((data) => { if (!cancelled) setResult({ data, error: null }) }, (error) => { if (!cancelled) setResult((r) => ({ data: r.data, error: apiErrorMessage(error) })) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ...deps])
  return enabled ? result : { data: null, error: null }
}

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const daysAgo = (n: number) => ymd(new Date(Date.now() - n * 86_400_000))

// ---------- Waste ----------

const wasteReasons: WasteReason[] = ['Expired', 'Damaged', 'Spoiled', 'Theft / Shrink', 'Customer return', 'Other']

export function WastePanel() {
  const { state, actions } = useStore()
  const { analyses } = useAnalytics()
  const live = state.source === 'live'
  const [from, setFrom] = useState(daysAgo(29))
  const [to, setTo] = useState(ymd(new Date()))
  const [productId, setProductId] = useState('')
  const [reason, setReason] = useState<'' | WasteReason>('')
  const [logging, setLogging] = useState<{ productId: string; qty: number; reason: WasteReason; notes: string } | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const rangeOk = !from || !to || from <= to
  const filter = { from: from || undefined, to: to || undefined, product_id: productId || undefined, reason: reason || undefined }
  const key = [from, to, productId, reason, state.waste.length, state.liveSyncedAt]
  const list = useServerData(live && rangeOk, () => getWaste({ ...filter, limit: 200 }), key)
  const summary = useServerData(live && rangeOk, () => getWasteSummary(filter), key)

  const product = (id: string) => state.products.find((p) => p.id === id)
  // Demo mode (no server): the same numbers worked out on this PC.
  const local: WasteRow[] = state.waste
    .filter((w) => (!from || ymd(new Date(w.date)) >= from) && (!to || ymd(new Date(w.date)) <= to) && (!productId || w.productId === productId) && (!reason || w.reason === reason))
    .sort((a, b) => b.date.localeCompare(a.date))
    .map((w) => ({ id: w.id, productId: w.productId, name: product(w.productId)?.name ?? w.productId, unit: product(w.productId)?.unit ?? '', qty: w.qty, reason: w.reason, value: w.value, date: w.date, by: w.by, byName: state.employees.find((e) => e.id === w.by)?.name ?? '—', notes: w.notes }))
  const rows = live ? list.data?.entries ?? [] : local
  const total = live ? summary.data?.totalValue ?? 0 : local.reduce((sum, w) => sum + w.value, 0)
  const count = live ? summary.data?.entries ?? 0 : local.length
  const byReason = live
    ? (summary.data?.byReason ?? []).map((r) => ({ label: r.reason, value: r.value }))
    : wasteReasons.map((r) => ({ label: r, value: local.filter((w) => w.reason === r).reduce((sum, w) => sum + w.value, 0) })).filter((r) => r.value > 0).sort((a, b) => b.value - a.value)
  const now = new Date()
  const localSales = state.transactions.filter((t) => (!from || ymd(new Date(t.date)) >= from) && (!to || ymd(new Date(t.date)) <= to)).reduce((sum, t) => sum + netTotal(t), 0)
  const shrink = live ? summary.data?.shrinkRatePercent ?? 0 : (total / (localSales || 1)) * 100
  const atRisk = analyses.filter((a) => a.atRiskUnits > 0).sort((a, b) => (a.expiryDays ?? 0) - (b.expiryDays ?? 0))
  const preset = (days: number) => { setFrom(daysAgo(days - 1)); setTo(ymd(now)) }
  const selected = logging ? product(logging.productId) : undefined

  function open() {
    const first = state.products.find((p) => p.stock > 0) ?? state.products[0]
    if (!first) return
    setFormError(null)
    setLogging({ productId: first.id, qty: 1, reason: 'Expired', notes: '' })
  }

  async function submit() {
    if (!logging) return
    setBusy(true)
    const problem = await actions.logWaste(logging)
    setBusy(false)
    if (problem) { setFormError(problem); return }
    actions.toast('Waste logged; stock reduced')
    setLogging(null)
  }

  return <div className="module-panel">
    <div className="module-intro"><div><span className="eyebrow">LOSS PREVENTION</span><h2>Waste &amp; spoilage</h2><p>Every write-off reduces stock (earliest-expiry batch first) and is valued at cost. The AI flags stock that is likely to expire before it sells.</p></div>
      <div className="intro-actions"><button className="primary-button" onClick={open}>＋ LOG WASTE</button></div></div>
    <div className="filter-bar">
      <label className="filter-field"><span>FROM</span><input type="date" aria-label="From date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} /></label>
      <label className="filter-field"><span>TO</span><input type="date" aria-label="To date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} /></label>
      <div className="filter-presets"><button className="outline-button" onClick={() => preset(7)}>7 DAYS</button><button className="outline-button" onClick={() => preset(30)}>30 DAYS</button></div>
      <label className="filter-field"><span>PRODUCT</span><select aria-label="Filter by product" value={productId} onChange={(e) => setProductId(e.target.value)}><option value="">All products</option>{state.products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      <label className="filter-field"><span>REASON</span><select aria-label="Filter by reason" value={reason} onChange={(e) => setReason(e.target.value as '' | WasteReason)}><option value="">All reasons</option>{wasteReasons.map((r) => <option key={r}>{r}</option>)}</select></label>
    </div>
    {!rangeOk && <p className="form-error">The start date is after the end date.</p>}
    {(list.error || summary.error) && <p className="form-error">{list.error ?? summary.error}</p>}
    <div className="metric-grid three">
      <Metric label="Written off" value={peso(total, 0)} change={`${count} entries`} note="valued at cost" accent="red" />
      <Metric label="Shrink rate" value={`${shrink.toFixed(2)}%`} change="of sales in this range" note="target < 1%" accent="orange" />
      <Metric label="Predicted to expire" value={String(atRisk.reduce((sum, a) => sum + a.atRiskUnits, 0))} change={peso(atRisk.reduce((sum, a) => sum + a.atRiskUnits * a.product.cost, 0), 0)} note="at risk (cost)" accent="blue" />
    </div>
    <div className="two-col">
      <section className="dashboard-module"><SectionHeading title="AI · EXPIRY RISK & MARKDOWN SUGGESTIONS" />
        {atRisk.length === 0 && <p className="muted-text pad">No stock is predicted to expire unsold.</p>}
        {atRisk.map((a) => <div className="risk-row" key={a.product.id}><div><b>{a.product.name}</b><small>{a.product.stock} on hand · sells ~{a.dailyDemand.toFixed(1)}/day · expires in {a.expiryDays}d</small></div><span className="risk-units">{a.atRiskUnits} at risk</span>
          <button className="outline-button" onClick={() => { actions.markdown(a.product.id, a.markdown); actions.toast(`${a.product.name} marked down ${Math.round(a.markdown * 100)}%`) }}>−{Math.round(a.markdown * 100)}% PRICE</button></div>)}
      </section>
      <section className="dashboard-module"><SectionHeading title="LOSS BY REASON" /><div className="module-body">{byReason.length ? <BarList items={byReason} format={(v) => peso(v, 0)} color={SERIES[2]} /> : <p className="muted-text">Nothing logged in this range.</p>}</div></section>
    </div>
    <div className="data-table-wrap"><table className="data-table"><thead><tr>{['PRODUCT', 'QUANTITY', 'REASON', 'VALUE', 'LOGGED', 'BY', 'NOTES'].map((h) => <th key={h}>{h}</th>)}</tr></thead>
      <tbody>{rows.map((w) => <tr key={w.id}><td><b>{w.name}</b></td><td>{w.qty} {w.unit}s</td><td><StatusPill value={w.reason} /></td><td>{peso(w.value)}</td><td>{relativeDay(w.date)}</td><td>{w.byName}</td><td className="notes-cell">{w.notes || '—'}</td></tr>)}</tbody></table>
      {rows.length === 0 && <Empty>No write-offs match these filters.</Empty>}</div>
    {logging && <Modal title="Log waste" eyebrow="WRITE-OFF" onClose={() => setLogging(null)} footer={<><button className="outline-button" onClick={() => setLogging(null)}>CANCEL</button><button className="primary-button" disabled={busy || logging.qty <= 0 || !selected || logging.qty > selected.stock} onClick={() => void submit()}>{busy ? 'SAVING…' : `LOG ${peso((selected?.cost ?? 0) * logging.qty)}`}</button></>}>
      <div className="form-grid">
        <Field label="PRODUCT"><select value={logging.productId} onChange={(e) => { setFormError(null); setLogging({ ...logging, productId: e.target.value, qty: 1 }) }}>{state.products.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.stock} on hand)</option>)}</select></Field>
        <Field label="QUANTITY" hint={selected ? `${selected.stock} in stock. A write-off can't be larger than that.` : undefined}><input type="number" min={1} max={selected?.stock} value={logging.qty} onChange={(e) => { setFormError(null); setLogging({ ...logging, qty: Math.max(0, Math.floor(Number(e.target.value))) }) }} /></Field>
        <Field label="REASON"><select value={logging.reason} onChange={(e) => setLogging({ ...logging, reason: e.target.value as WasteReason })}>{wasteReasons.map((r) => <option key={r}>{r}</option>)}</select></Field>
        <Field label="NOTES"><input value={logging.notes} maxLength={255} onChange={(e) => setLogging({ ...logging, notes: e.target.value })} placeholder="Optional" /></Field>
      </div>
      {selected && logging.qty > selected.stock && <p className="form-error">Only {selected.stock} {selected.name} in stock.</p>}
      {formError && <p className="form-error">{formError}</p>}
    </Modal>}
  </div>
}

// ---------- Customer requests ----------

const requestStatuses: RequestStatus[] = ['New', 'Reviewing', 'Ordered', 'Stocked', 'Declined']

export function RequestsPanel() {
  const { state, actions } = useStore()
  const user = useCurrentUser()
  const owner = user?.role !== 'Cashier'
  const live = state.source === 'live'
  const [status, setStatus] = useState<'Open' | 'All'>('Open')
  const [query, setQuery] = useState('')
  const [version, setVersion] = useState(0)
  const [adding, setAdding] = useState<Omit<CustomerRequest, 'id' | 'date' | 'status'> | null>(null)
  const demand = requestDemand(state.requests)
  const q = query.trim().toLowerCase()
  const key = [status, q, version, state.requests.length, state.liveSyncedAt]
  const list = useServerData(live, () => getRequests({ status, q: q || undefined }), key)
  const counts = useServerData<RequestsSummary>(live, () => getRequestsSummary(30), key)
  const localRows = [...state.requests].sort((a, b) => b.date.localeCompare(a.date)).filter((r) => (status === 'All' || r.status === 'New' || r.status === 'Reviewing') && (!q || r.item.toLowerCase().includes(q) || r.requestedBy.toLowerCase().includes(q)))
  const rows = live ? list.data ?? [] : localRows
  const byStatus = live ? counts.data?.byStatus : Object.fromEntries(requestStatuses.map((s) => [s, state.requests.filter((r) => r.status === s).length]))

  async function change(ids: string[], next: RequestStatus) {
    await actions.setRequestStatus(ids, next)
    setVersion((v) => v + 1)
  }

  return <div className="module-panel">
    <div className="module-intro"><div><span className="eyebrow">CUSTOMER DEMAND</span><h2>Customer item requests</h2><p>Log what shoppers ask for. Similar requests are grouped automatically to reveal unmet demand.{!owner && ' The owner updates the status.'}</p></div><button className="primary-button" onClick={() => setAdding({ item: '', category: 'Pantry', requestedBy: 'Walk-in', contact: '', notes: '' })}>＋ ADD REQUEST</button></div>
    {byStatus && <div className="status-chips" aria-label="Requests by status">{requestStatuses.map((s) => <span key={s} className={`status-chip ${s.toLowerCase()}`}><b>{byStatus[s] ?? 0}</b> {s}</span>)}</div>}
    <section className="dashboard-module"><SectionHeading title="AI · DEMAND SIGNALS (LAST 30 DAYS)" />
      <div className="demand-grid">{demand.slice(0, 4).map((group) => <div key={group.key} className={group.count >= 3 ? 'demand-card hot' : 'demand-card'}>
        <strong>{group.count}×</strong><div><b>{group.label}</b><small>{group.count >= 3 ? 'Strong signal — consider stocking' : 'Watch'} · last {relativeDay(group.latest)}</small></div>
        {group.open > 0 && owner && <button className="link-button" onClick={() => { void change(group.ids, 'Ordered'); actions.toast(`${group.count} requests marked as ordered`) }}>MARK ORDERED</button>}
      </div>)}{demand.length === 0 && <p className="muted-text pad">No requests yet.</p>}</div>
    </section>
    <div className="table-toolbar"><label className="search-field compact"><span>⌕</span><input placeholder="Search requests" value={query} onChange={(e) => setQuery(e.target.value)} /></label><Segmented label="Status" options={['Open', 'All'] as const} value={status} onChange={setStatus} /></div>
    {list.error && <p className="form-error">{list.error}</p>}
    <div className="data-table-wrap"><table className="data-table"><thead><tr>{['REQUESTED ITEM', 'CATEGORY', 'REQUESTED BY', 'DATE', 'STATUS'].map((h) => <th key={h}>{h}</th>)}</tr></thead>
      <tbody>{rows.map((r) => <tr key={r.id}><td><b>{r.item}</b>{r.notes && <small>{r.notes}</small>}</td><td>{r.category}</td><td>{r.requestedBy}{r.contact && <small>{r.contact}</small>}</td><td>{relativeDay(r.date)}</td>
        <td>{owner ? <select className={`status-select ${r.status.toLowerCase()}`} value={r.status} aria-label={`Status of ${r.item}`} onChange={(e) => void change([r.id], e.target.value as RequestStatus)}>{requestStatuses.map((s) => <option key={s}>{s}</option>)}</select> : <StatusPill value={r.status} />}</td></tr>)}</tbody></table>
      {rows.length === 0 && <Empty>No requests.</Empty>}</div>
    {adding && <Modal title="New customer request" eyebrow="CUSTOMER DEMAND" onClose={() => setAdding(null)} footer={<><button className="outline-button" onClick={() => setAdding(null)}>CANCEL</button><button className="primary-button" disabled={!adding.item.trim()} onClick={() => { actions.addRequest(adding); actions.toast('Request logged'); setAdding(null); window.setTimeout(() => setVersion((v) => v + 1), 600) }}>SAVE REQUEST</button></>}>
      <RequestFields value={adding} onChange={setAdding} />
    </Modal>}
  </div>
}

export function RequestFields({ value, onChange }: { value: Omit<CustomerRequest, 'id' | 'date' | 'status'>; onChange: (next: Omit<CustomerRequest, 'id' | 'date' | 'status'>) => void }) {
  return <div className="form-grid">
    <Field label="ITEM REQUESTED"><input autoFocus value={value.item} maxLength={100} onChange={(e) => onChange({ ...value, item: e.target.value })} placeholder="e.g. Oat milk 1L" /></Field>
    <Field label="CATEGORY"><input value={value.category} maxLength={50} onChange={(e) => onChange({ ...value, category: e.target.value })} /></Field>
    <Field label="CUSTOMER NAME"><input value={value.requestedBy} maxLength={100} onChange={(e) => onChange({ ...value, requestedBy: e.target.value })} /></Field>
    <Field label="CONTACT (OPTIONAL)"><input value={value.contact} maxLength={100} onChange={(e) => onChange({ ...value, contact: e.target.value })} placeholder="Mobile number to notify" /></Field>
    <Field label="NOTES"><input value={value.notes} maxLength={255} onChange={(e) => onChange({ ...value, notes: e.target.value })} /></Field>
  </div>
}

// ---------- Employees ----------

const roles: Role[] = ['Owner', 'Cashier']

export function EmployeesPanel() {
  const { state, actions } = useStore()
  const live = state.source === 'live'
  const [editing, setEditing] = useState<Employee | null>(null)
  const [activityFor, setActivityFor] = useState<Employee | null>(null)
  const [confirming, setConfirming] = useState<{ employee: Employee; onTerminal: string | null } | null>(null)
  const [version, setVersion] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<'All' | 'Active' | 'Inactive'>('All')
  const now = new Date()
  const server = useServerData<EmployeeRow[]>(live, getEmployees, [version, state.liveSyncedAt, state.employees.length])
  const localRows: EmployeeRow[] = state.employees.map((e) => {
    const sales = state.transactions.filter((t) => t.cashierId === e.id && daysBetween(t.date, now) < 7)
    return { ...e, receiptsWeek: sales.length, salesWeek: sales.reduce((sum, t) => sum + netTotal(t), 0), onTerminal: null }
  })
  const all = live ? server.data ?? [] : localRows
  const rows = all.filter((e) => status === 'All' || (status === 'Active' ? e.status !== 'Inactive' : e.status === 'Inactive'))

  async function toggle(employee: Employee, active: boolean) {
    setError(null)
    const problem = await actions.setEmployeeActive(employee.id, active)
    if (problem) setError(problem)
    setConfirming(null)
    setVersion((v) => v + 1)
  }

  return <div className="module-panel">
    <div className="module-intro"><div><span className="eyebrow">PEOPLE &amp; ACCESS</span><h2>Team members</h2><p>Cashiers have no PIN or password: the owner assigns them to a terminal from the Admin Station. Deactivating a cashier ends their shift and locks their terminal.</p></div>
      <button className="primary-button" onClick={() => setEditing({ id: `e${Date.now().toString(36)}`, name: '', email: '', role: 'Cashier', status: 'Active', lastActive: new Date().toISOString() })}>＋ ADD EMPLOYEE</button></div>
    <div className="table-toolbar"><Segmented label="Show" options={['All', 'Active', 'Inactive'] as const} value={status} onChange={setStatus} /></div>
    {(error || server.error) && <p className="form-error">{error ?? server.error}</p>}
    <div className="data-table-wrap"><table className="data-table clickable"><thead><tr>{['EMPLOYEE', 'ROLE', 'STATUS', 'SHIFT', 'SALES (7 DAYS)', 'LAST ACTIVE', ''].map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
      <tbody>{rows.map((e) => <tr key={e.id} onClick={() => setEditing(e)}>
        <td><div className="person-cell"><span className="avatar">{initials(e.name)}</span><div><b>{e.name}</b><small>{e.email}</small></div></div></td>
        <td>{e.role}</td><td><StatusPill value={e.status} /></td><td><ShiftCell employee={e} /></td><td>{peso(e.salesWeek, 0)}<small>{e.receiptsWeek} receipt{e.receiptsWeek === 1 ? '' : 's'}</small></td><td>{relativeDay(e.lastActive)}</td>
        <td className="employee-actions" onClick={(event) => event.stopPropagation()}><div>
          <button className="outline-button" onClick={() => setActivityFor(e)}>ACTIVITY</button>
          {e.role !== 'Owner' && (e.status === 'Inactive'
            ? <button className="outline-button" onClick={() => void toggle(e, true)}>ACTIVATE</button>
            : <button className="danger-button" onClick={() => (e.onTerminal ? setConfirming({ employee: e, onTerminal: e.onTerminal }) : void toggle(e, false))}>DEACTIVATE</button>)}
        </div></td></tr>)}</tbody></table>
      {rows.length === 0 && <Empty>No employees.</Empty>}</div>
    {editing && <EmployeeModal employee={editing} isNew={!state.employees.some((e) => e.id === editing.id)} onClose={() => setEditing(null)} onSave={(e) => { void actions.saveEmployee(e).then(() => setVersion((v) => v + 1)); actions.toast('Employee saved'); setEditing(null) }} />}
    {activityFor && <ActivityModal employee={activityFor} onClose={() => setActivityFor(null)} />}
    {confirming && <Modal title={`Deactivate ${confirming.employee.name}?`} eyebrow="END SHIFT" onClose={() => setConfirming(null)} footer={<><button className="outline-button" onClick={() => setConfirming(null)}>CANCEL</button><button className="danger-button" onClick={() => void toggle(confirming.employee, false)}>END SHIFT &amp; DEACTIVATE</button></>}>
      <p>{confirming.employee.name} is working on <b>{confirming.onTerminal}</b>. Deactivating ends the shift now and locks that terminal until you assign someone else. Unfinished carts on that terminal are not saved.</p>
    </Modal>}
  </div>
}

function ActivityModal({ employee, onClose }: { employee: Employee; onClose: () => void }) {
  const { state } = useStore()
  const live = state.source === 'live'
  const [days, setDays] = useState<'7 days' | '30 days'>('30 days')
  const n = days === '7 days' ? 7 : 30
  const { data, error } = useServerData<EmployeeActivity>(live, () => getEmployeeActivity(employee.id, n), [employee.id, n])
  const now = new Date()
  const mine = state.transactions.filter((t) => t.cashierId === employee.id && daysBetween(t.date, now) < n)
  const t = data?.totals ?? { receipts: mine.length, sales: mine.reduce((sum, x) => sum + netTotal(x), 0), voids: 0, voidAmount: 0, refunds: 0, refundAmount: 0, discounts: 0 }
  return <Modal title={employee.name} eyebrow="EMPLOYEE ACTIVITY" wide onClose={onClose} footer={<><Segmented label="Range" options={['7 days', '30 days'] as const} value={days} onChange={setDays} /><span className="spacer" /><button className="primary-button" onClick={onClose}>DONE</button></>}>
    {error && <p className="form-error">{error}</p>}
    <div className="drawer-grid">
      <div><span>Sales ({n} days)</span><b>{peso(t.sales)}</b></div>
      <div><span>Receipts</span><b>{t.receipts}</b></div>
      <div><span>Discounts given</span><b>{peso(t.discounts)}</b></div>
      <div><span>Voids</span><b>{t.voids} · {peso(t.voidAmount)}</b></div>
      <div><span>Refunds</span><b>{t.refunds} · {peso(t.refundAmount)}</b></div>
    </div>
    {live && data && <>
      <div className="subsection"><span className="eyebrow">SHIFTS</span>
        {data.sessions.length === 0 && <p className="muted-text">No shifts in this range.</p>}
        {data.sessions.map((s) => <div className="list-row" key={s.id}><div><b>{s.terminalId}{s.active ? ' · on shift now' : ''}</b><small>{relativeDay(s.start)} {time(s.start)}{s.end ? ` → ${time(s.end)}` : ''}{s.endReason ? ` · ${s.endReason}` : ''}</small></div><span>{s.receipts} receipts</span><strong>{peso(s.sales)}</strong></div>)}
      </div>
      <div className="subsection"><span className="eyebrow">RECENT VOIDS</span>
        {data.recentVoids.length === 0 && <p className="muted-text">No voided receipts.</p>}
        {data.recentVoids.map((v) => <div className="list-row" key={v.receipt}><div><b>{v.receipt}</b><small>{v.reason || 'No reason given'} · {relativeDay(v.at)}</small></div><strong>{peso(v.amount)}</strong></div>)}
      </div>
    </>}
    {!live && <p className="muted-text">Shift and void history is available when the app is connected to the store database.</p>}
  </Modal>
}

/** Where a cashier's latest shift stands: on a terminal, paused, or ended (with the time it ended). */
function ShiftCell({ employee }: { employee: Employee }) {
  const shift = employee.shift
  if (!shift) return <span className="muted-text">{employee.role === 'Owner' ? '—' : 'No shift yet'}</span>
  const sameDay = (iso: string) => new Date(iso).toDateString() === new Date().toDateString()
  const stamp = (iso: string | null) => !iso ? '' : sameDay(iso) ? time(iso) : `${new Date(iso).toLocaleDateString('en-PH', { month: 'short', day: 'numeric' })}, ${time(iso)}`
  if (shift.state === 'on') return <div><b>On {shift.terminal}</b><small className="shift-sub">since {stamp(shift.startedAt)}</small></div>
  if (shift.state === 'paused') return <div><b>Paused · {shift.terminal}</b><small className="shift-sub">locked since {stamp(shift.pausedAt)}</small></div>
  return <div><b>Ended {stamp(shift.endedAt)}</b><small className="shift-sub">{shift.terminal} · {shift.endedBy === 'cashier' ? 'by the cashier' : 'by the owner'}</small></div>
}

function EmployeeModal({ employee, isNew, onClose, onSave }: { employee: Employee; isNew: boolean; onClose: () => void; onSave: (e: Employee) => void }) {
  const { state } = useStore()
  const [draft, setDraft] = useState(employee)
  const valid = Boolean(draft.name.trim())
  const isOwner = employee.role === 'Owner' && !isNew
  return <Modal title={isNew ? 'Add employee' : draft.name} eyebrow="TEAM MEMBER" onClose={onClose} footer={<><button className="outline-button" onClick={onClose}>CANCEL</button><button className="primary-button" disabled={!valid} onClick={() => onSave(draft)}>SAVE</button></>}>
    <div className="form-grid">
      <Field label="FULL NAME"><input autoFocus value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field>
      <Field label="EMAIL"><input type="email" value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} /></Field>
      <Field label="ROLE"><select value={draft.role} disabled={!isNew} onChange={(e) => setDraft({ ...draft, role: e.target.value as Role })}>{roles.map((r) => <option key={r}>{r}</option>)}</select></Field>
      <Field label="STATUS" hint={isOwner ? "The owner account can't be deactivated." : undefined}><select value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value as Employee['status'] })}>{['Active', 'On leave', 'Inactive'].filter((s) => !(isOwner && s === 'Inactive')).map((s) => <option key={s}>{s}</option>)}</select></Field>
    </div>
    <p className="muted-text">Can open: {allowedWorkspaces(state.settings, draft.role).join(', ')}</p>
  </Modal>
}

// ---------- Shift & cash drawer ----------

export function ShiftPanel() {
  const { state, actions } = useStore()
  const [movement, setMovement] = useState<{ type: 'Cash in' | 'Cash out'; amount: string; reason: string } | null>(null)
  const [counted, setCounted] = useState('')
  const [float, setFloat] = useState('3000')
  const shift = state.shift
  const shiftTxns = state.transactions.filter((t) => t.date >= shift.openedAt && (!shift.closedAt || t.date <= shift.closedAt))
  const cashSales = shiftTxns.filter((t) => t.payment.method === 'Cash').reduce((s, t) => s + netTotal(t), 0)
  const nonCash = shiftTxns.filter((t) => t.payment.method !== 'Cash').reduce((s, t) => s + netTotal(t), 0)
  const cashIn = shift.movements.filter((m) => m.type === 'Cash in').reduce((s, m) => s + m.amount, 0)
  const cashOut = shift.movements.filter((m) => m.type === 'Cash out').reduce((s, m) => s + m.amount, 0)
  const expected = shift.openingFloat + cashSales + cashIn - cashOut
  const variance = shift.countedCash !== undefined ? shift.countedCash - expected : null
  const opener = state.employees.find((e) => e.id === shift.openedBy)?.name ?? '—'

  return <div className="module-panel">
    <div className="module-intro"><div><span className="eyebrow">CASH DRAWER</span><h2>{shift.closedAt ? 'Shift closed' : 'Current shift'}</h2><p>Opened {relativeDay(shift.openedAt)} by {opener}{shift.closedAt ? ` · closed ${time(shift.closedAt)}` : ''}</p></div>
      {!shift.closedAt && <div className="intro-actions"><button className="outline-button" onClick={() => setMovement({ type: 'Cash in', amount: '', reason: '' })}>＋ CASH IN</button><button className="outline-button" onClick={() => setMovement({ type: 'Cash out', amount: '', reason: '' })}>− CASH OUT</button></div>}</div>
    <div className="drawer-grid">
      <div><span>Opening float</span><b>{peso(shift.openingFloat)}</b></div>
      <div><span>Cash sales ({shiftTxns.filter((t) => t.payment.method === 'Cash').length})</span><b>{peso(cashSales)}</b></div>
      <div><span>Cash in / out</span><b>{peso(cashIn - cashOut)}</b></div>
      <div className="strong"><span>Expected in drawer</span><b>{peso(expected)}</b></div>
      <div><span>Non-cash (GCash, card, Maya)</span><b>{peso(nonCash)}</b></div>
      <div><span>Total shift sales</span><b>{peso(cashSales + nonCash)}</b></div>
    </div>
    {shift.movements.length > 0 && <div className="subsection"><span className="eyebrow">DRAWER MOVEMENTS</span>{shift.movements.map((m) => <div className="list-row" key={m.id}><div><b>{m.reason}</b><small>{time(m.date)} · {state.employees.find((e) => e.id === m.by)?.name}</small></div><span>{m.type}</span><strong>{m.type === 'Cash out' ? '−' : '+'}{peso(m.amount)}</strong></div>)}</div>}
    {!shift.closedAt ? <div className="close-shift">
      <Field label="COUNTED CASH" hint="Count the drawer, then close the shift to print the Z-reading."><input inputMode="decimal" value={counted} placeholder={expected.toFixed(2)} onChange={(e) => setCounted(e.target.value.replace(/[^\d.]/g, ''))} /></Field>
      {counted && <div className={Math.abs(Number(counted) - expected) < 1 ? 'variance ok' : 'variance'}>{Number(counted) - expected >= 0 ? 'OVER' : 'SHORT'} {peso(Math.abs(Number(counted) - expected))}</div>}
      <button className="primary-button" disabled={!counted} onClick={() => { actions.closeShift(Number(counted)); actions.toast('Shift closed') }}>CLOSE SHIFT</button>
    </div> : <div className="close-shift">
      <div className={variance !== null && Math.abs(variance) < 1 ? 'variance ok' : 'variance'}>Counted {peso(shift.countedCash ?? 0)} · {variance !== null && variance >= 0 ? 'over' : 'short'} {peso(Math.abs(variance ?? 0))}</div>
      <Field label="OPENING FLOAT FOR NEXT SHIFT"><input inputMode="decimal" value={float} onChange={(e) => setFloat(e.target.value.replace(/[^\d.]/g, ''))} /></Field>
      <button className="primary-button" onClick={() => { actions.openShift(Number(float) || 0); actions.toast('New shift opened') }}>OPEN NEW SHIFT</button>
      <button className="outline-button" onClick={() => actions.navigate('Reports')}>VIEW Z-READING ↗</button>
    </div>}
    {movement && <Modal title={movement.type} eyebrow="DRAWER MOVEMENT" onClose={() => setMovement(null)} footer={<><button className="outline-button" onClick={() => setMovement(null)}>CANCEL</button><button className="primary-button" disabled={!Number(movement.amount) || !movement.reason.trim()} onClick={() => { actions.cashMovement(movement.type, Number(movement.amount), movement.reason.trim()); setMovement(null) }}>SAVE</button></>}>
      <div className="form-grid"><Field label="AMOUNT"><input autoFocus inputMode="decimal" value={movement.amount} onChange={(e) => setMovement({ ...movement, amount: e.target.value.replace(/[^\d.]/g, '') })} /></Field><Field label="REASON"><input value={movement.reason} onChange={(e) => setMovement({ ...movement, reason: e.target.value })} placeholder={movement.type === 'Cash out' ? 'e.g. Paid delivery' : 'e.g. Change fund top-up'} /></Field></div>
    </Modal>}
  </div>
}
