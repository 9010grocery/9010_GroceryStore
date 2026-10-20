import { useState } from 'react'
import type { CustomerRequest, Employee, RequestStatus, Role, WasteReason } from '../../data/types'
import { netTotal, requestDemand } from '../../lib/ai'
import { daysBetween, initials, peso, relativeDay, time } from '../../lib/format'
import { allowedWorkspaces, useAnalytics, useCurrentUser, useStore } from '../../store/StoreContext'
import { BarList, Empty, Field, Metric, Modal, SERIES, Segmented, SectionHeading, StatusPill } from '../ui'

// ---------- Waste ----------

const wasteReasons: WasteReason[] = ['Expired', 'Damaged', 'Spoiled', 'Theft / Shrink', 'Customer return', 'Other']

export function WastePanel() {
  const { state, actions } = useStore()
  const { analyses } = useAnalytics()
  const [range, setRange] = useState<'7 days' | '30 days'>('30 days')
  const [logging, setLogging] = useState<{ productId: string; qty: number; reason: WasteReason } | null>(null)
  const now = new Date()
  const entries = state.waste.filter((w) => daysBetween(w.date, now) < (range === '7 days' ? 7 : 30)).sort((a, b) => b.date.localeCompare(a.date))
  const total = entries.reduce((s, w) => s + w.value, 0)
  const byReason = wasteReasons.map((reason) => ({ label: reason, value: entries.filter((w) => w.reason === reason).reduce((s, w) => s + w.value, 0) })).filter((r) => r.value > 0).sort((a, b) => b.value - a.value)
  const atRisk = analyses.filter((a) => a.atRiskUnits > 0).sort((a, b) => (a.expiryDays ?? 0) - (b.expiryDays ?? 0))
  const product = (id: string) => state.products.find((p) => p.id === id)
  const sales = state.transactions.filter((t) => daysBetween(t.date, now) < 7).reduce((s, t) => s + netTotal(t), 0)
  const weekWaste = state.waste.filter((w) => daysBetween(w.date, now) < 7).reduce((s, w) => s + w.value, 0)

  return <div className="module-panel">
    <div className="module-intro"><div><span className="eyebrow">LOSS PREVENTION</span><h2>Waste &amp; spoilage</h2><p>Every write-off reduces stock and is valued at cost. The AI flags stock that is likely to expire before it sells.</p></div>
      <div className="intro-actions"><Segmented label="Range" options={['7 days', '30 days'] as const} value={range} onChange={setRange} /><button className="primary-button" onClick={() => setLogging({ productId: state.products[0].id, qty: 1, reason: 'Expired' })}>＋ LOG WASTE</button></div></div>
    <div className="metric-grid three">
      <Metric label={`Written off (${range})`} value={peso(total, 0)} change={`${entries.length} entries`} note="valued at cost" accent="red" />
      <Metric label="Shrink rate (7 days)" value={`${((weekWaste / (sales || 1)) * 100).toFixed(2)}%`} change="of net sales" note="target < 1%" accent="orange" />
      <Metric label="Predicted to expire" value={String(atRisk.reduce((s, a) => s + a.atRiskUnits, 0))} change={peso(atRisk.reduce((s, a) => s + a.atRiskUnits * a.product.cost, 0), 0)} note="at risk (cost)" accent="blue" />
    </div>
    <div className="two-col">
      <section className="dashboard-module"><SectionHeading title="AI · EXPIRY RISK & MARKDOWN SUGGESTIONS" />
        {atRisk.length === 0 && <p className="muted-text pad">No stock is predicted to expire unsold.</p>}
        {atRisk.map((a) => <div className="risk-row" key={a.product.id}><div><b>{a.product.name}</b><small>{a.product.stock} on hand · sells ~{a.dailyDemand.toFixed(1)}/day · expires in {a.expiryDays}d</small></div><span className="risk-units">{a.atRiskUnits} at risk</span>
          <button className="outline-button" onClick={() => { actions.markdown(a.product.id, a.markdown); actions.toast(`${a.product.name} marked down ${Math.round(a.markdown * 100)}%`) }}>−{Math.round(a.markdown * 100)}% PRICE</button></div>)}
      </section>
      <section className="dashboard-module"><SectionHeading title="LOSS BY REASON" /><div className="module-body">{byReason.length ? <BarList items={byReason} format={(v) => peso(v, 0)} color={SERIES[2]} /> : <p className="muted-text">Nothing logged.</p>}</div></section>
    </div>
    <div className="data-table-wrap"><table className="data-table"><thead><tr>{['PRODUCT', 'QUANTITY', 'REASON', 'VALUE', 'LOGGED', 'BY', 'NOTES'].map((h) => <th key={h}>{h}</th>)}</tr></thead>
      <tbody>{entries.map((w) => <tr key={w.id}><td><b>{product(w.productId)?.name ?? w.productId}</b></td><td>{w.qty} {product(w.productId)?.unit}s</td><td><StatusPill value={w.reason} /></td><td>{peso(w.value)}</td><td>{relativeDay(w.date)}</td><td>{state.employees.find((e) => e.id === w.by)?.name ?? '—'}</td><td className="notes-cell">{w.notes || '—'}</td></tr>)}</tbody></table></div>
    {logging && <Modal title="Log waste" eyebrow="WRITE-OFF" onClose={() => setLogging(null)} footer={<><button className="outline-button" onClick={() => setLogging(null)}>CANCEL</button><button className="primary-button" disabled={logging.qty <= 0} onClick={() => { const notes = (document.getElementById('waste-notes') as HTMLInputElement | null)?.value ?? ''; actions.logWaste({ ...logging, notes }); actions.toast('Waste logged; stock reduced'); setLogging(null) }}>LOG {peso((product(logging.productId)?.cost ?? 0) * logging.qty)}</button></>}>
      <div className="form-grid">
        <Field label="PRODUCT"><select value={logging.productId} onChange={(e) => setLogging({ ...logging, productId: e.target.value })}>{state.products.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.stock} on hand)</option>)}</select></Field>
        <Field label="QUANTITY"><input type="number" min={1} max={product(logging.productId)?.stock} value={logging.qty} onChange={(e) => setLogging({ ...logging, qty: Math.max(0, Math.min(product(logging.productId)?.stock ?? 0, Number(e.target.value))) })} /></Field>
        <Field label="REASON"><select value={logging.reason} onChange={(e) => setLogging({ ...logging, reason: e.target.value as WasteReason })}>{wasteReasons.map((r) => <option key={r}>{r}</option>)}</select></Field>
        <Field label="NOTES"><input id="waste-notes" placeholder="Optional" /></Field>
      </div>
    </Modal>}
  </div>
}

// ---------- Customer requests ----------

const requestStatuses: RequestStatus[] = ['New', 'Reviewing', 'Ordered', 'Stocked', 'Declined']

export function RequestsPanel() {
  const { state, actions } = useStore()
  const user = useCurrentUser()
  const [status, setStatus] = useState<'Open' | 'All'>('Open')
  const [query, setQuery] = useState('')
  const [adding, setAdding] = useState<Omit<CustomerRequest, 'id' | 'date' | 'status'> | null>(null)
  const demand = requestDemand(state.requests)
  const q = query.trim().toLowerCase()
  const rows = [...state.requests].sort((a, b) => b.date.localeCompare(a.date)).filter((r) => (status === 'All' || r.status === 'New' || r.status === 'Reviewing') && (!q || r.item.toLowerCase().includes(q) || r.requestedBy.toLowerCase().includes(q)))

  return <div className="module-panel">
    <div className="module-intro"><div><span className="eyebrow">CUSTOMER DEMAND</span><h2>Customer item requests</h2><p>Log what shoppers ask for. Similar requests are grouped automatically to reveal unmet demand.</p></div><button className="primary-button" onClick={() => setAdding({ item: '', category: 'Pantry', requestedBy: 'Walk-in', contact: '', notes: '' })}>＋ ADD REQUEST</button></div>
    <section className="dashboard-module"><SectionHeading title="AI · DEMAND SIGNALS (LAST 30 DAYS)" />
      <div className="demand-grid">{demand.slice(0, 4).map((group) => <div key={group.key} className={group.count >= 3 ? 'demand-card hot' : 'demand-card'}>
        <strong>{group.count}×</strong><div><b>{group.label}</b><small>{group.count >= 3 ? 'Strong signal — consider stocking' : 'Watch'} · last {relativeDay(group.latest)}</small></div>
        {group.open > 0 && user?.role !== 'Cashier' && <button className="link-button" onClick={() => { actions.setRequestStatus(group.ids, 'Ordered'); actions.toast(`${group.count} requests marked as ordered`) }}>MARK ORDERED</button>}
      </div>)}</div>
    </section>
    <div className="table-toolbar"><label className="search-field compact"><span>⌕</span><input placeholder="Search requests" value={query} onChange={(e) => setQuery(e.target.value)} /></label><Segmented label="Status" options={['Open', 'All'] as const} value={status} onChange={setStatus} /></div>
    <div className="data-table-wrap"><table className="data-table"><thead><tr>{['REQUESTED ITEM', 'CATEGORY', 'REQUESTED BY', 'DATE', 'STATUS'].map((h) => <th key={h}>{h}</th>)}</tr></thead>
      <tbody>{rows.map((r) => <tr key={r.id}><td><b>{r.item}</b>{r.notes && <small>{r.notes}</small>}</td><td>{r.category}</td><td>{r.requestedBy}{r.contact && <small>{r.contact}</small>}</td><td>{relativeDay(r.date)}</td>
        <td><select className={`status-select ${r.status.toLowerCase()}`} value={r.status} aria-label={`Status of ${r.item}`} onChange={(e) => actions.setRequestStatus([r.id], e.target.value as RequestStatus)}>{requestStatuses.map((s) => <option key={s}>{s}</option>)}</select></td></tr>)}</tbody></table>
      {rows.length === 0 && <Empty>No requests.</Empty>}</div>
    {adding && <Modal title="New customer request" eyebrow="CUSTOMER DEMAND" onClose={() => setAdding(null)} footer={<><button className="outline-button" onClick={() => setAdding(null)}>CANCEL</button><button className="primary-button" disabled={!adding.item.trim()} onClick={() => { actions.addRequest(adding); actions.toast('Request logged'); setAdding(null) }}>SAVE REQUEST</button></>}>
      <div className="form-grid">
        <Field label="ITEM REQUESTED"><input autoFocus value={adding.item} onChange={(e) => setAdding({ ...adding, item: e.target.value })} placeholder="e.g. Oat milk 1L" /></Field>
        <Field label="CATEGORY"><input value={adding.category} onChange={(e) => setAdding({ ...adding, category: e.target.value })} /></Field>
        <Field label="CUSTOMER NAME"><input value={adding.requestedBy} onChange={(e) => setAdding({ ...adding, requestedBy: e.target.value })} /></Field>
        <Field label="CONTACT (OPTIONAL)"><input value={adding.contact} onChange={(e) => setAdding({ ...adding, contact: e.target.value })} placeholder="Mobile number to notify" /></Field>
        <Field label="NOTES"><input value={adding.notes} onChange={(e) => setAdding({ ...adding, notes: e.target.value })} /></Field>
      </div>
    </Modal>}
  </div>
}

// ---------- Employees ----------

const roles: Role[] = ['Owner', 'Cashier']

export function EmployeesPanel() {
  const { state, actions } = useStore()
  const [editing, setEditing] = useState<Employee | null>(null)
  const now = new Date()
  const salesBy = (id: string) => state.transactions.filter((t) => t.cashierId === id && daysBetween(t.date, now) < 7)

  return <div className="module-panel">
    <div className="module-intro"><div><span className="eyebrow">PEOPLE &amp; ACCESS</span><h2>Team members</h2><p>Cashiers have no PIN or password: the owner assigns them to a terminal from the Admin Station. Their role decides which workspaces they see.</p></div>
      <button className="primary-button" onClick={() => setEditing({ id: `e${Date.now().toString(36)}`, name: '', email: '', role: 'Cashier', status: 'Active', lastActive: new Date().toISOString() })}>＋ ADD EMPLOYEE</button></div>
    <div className="data-table-wrap"><table className="data-table clickable"><thead><tr>{['EMPLOYEE', 'ROLE', 'STATUS', 'SHIFT', 'SALES (7 DAYS)', 'RECEIPTS', 'LAST ACTIVE'].map((h) => <th key={h}>{h}</th>)}</tr></thead>
      <tbody>{state.employees.map((e) => { const sales = salesBy(e.id); return <tr key={e.id} onClick={() => setEditing(e)}>
        <td><div className="person-cell"><span className="avatar">{initials(e.name)}</span><div><b>{e.name}</b><small>{e.email}</small></div></div></td>
        <td>{e.role}</td><td><StatusPill value={e.status} /></td><td><ShiftCell employee={e} /></td><td>{peso(sales.reduce((s, t) => s + netTotal(t), 0), 0)}</td><td>{sales.length}</td><td>{relativeDay(e.lastActive)}</td></tr> })}</tbody></table></div>
    {editing && <EmployeeModal employee={editing} isNew={!state.employees.some((e) => e.id === editing.id)} onClose={() => setEditing(null)} onSave={(e) => { actions.saveEmployee(e); actions.toast('Employee saved'); setEditing(null) }} />}
  </div>
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
  return <Modal title={isNew ? 'Add employee' : draft.name} eyebrow="TEAM MEMBER" onClose={onClose} footer={<><button className="outline-button" onClick={onClose}>CANCEL</button><button className="primary-button" disabled={!valid} onClick={() => onSave(draft)}>SAVE</button></>}>
    <div className="form-grid">
      <Field label="FULL NAME"><input autoFocus value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field>
      <Field label="EMAIL"><input type="email" value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} /></Field>
      <Field label="ROLE"><select value={draft.role} onChange={(e) => setDraft({ ...draft, role: e.target.value as Role })}>{roles.map((r) => <option key={r}>{r}</option>)}</select></Field>
      <Field label="STATUS"><select value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value as Employee['status'] })}>{['Active', 'On leave', 'Inactive'].map((s) => <option key={s}>{s}</option>)}</select></Field>
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
