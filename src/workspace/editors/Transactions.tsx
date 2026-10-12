import { useState } from 'react'
import type { PaymentMethod, Transaction } from '../../data/types'
import { netTotal } from '../../lib/ai'
import { daysBetween, downloadCsv, peso, relativeDay, shortDate, time } from '../../lib/format'
import { OwnerPinModal } from '../../components/OwnerPinModal'
import { apiErrorMessage } from '../../services/api'
import { useStore } from '../../store/StoreContext'
import { Empty, Field, Segmented, StatusPill } from '../ui'
import { Receipt } from './PointOfSale'

const PAGE = 12

export function TransactionsPanel() {
  const { state, actions } = useStore()
  const [range, setRange] = useState<'Today' | '7 days'>('Today')
  const [method, setMethod] = useState<PaymentMethod | 'All'>('All')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)
  const [confirmVoid, setConfirmVoid] = useState<Transaction | null>(null)
  const [reprinting, setReprinting] = useState(false)
  const now = new Date()
  const q = query.trim().toLowerCase()
  const rows = [...state.transactions].reverse().filter((t) => (range === 'Today' ? daysBetween(t.date, now) === 0 : true) && (method === 'All' || t.payment.method === method) && (!q || t.number.toLowerCase().includes(q) || t.lines.some((l) => l.name.toLowerCase().includes(q))))
  const pages = Math.max(1, Math.ceil(rows.length / PAGE))
  const visible = rows.slice(page * PAGE, page * PAGE + PAGE)
  const selected = state.transactions.find((t) => t.id === state.ui.selectedTxnId) ?? null
  const net = rows.reduce((s, t) => s + netTotal(t), 0)
  const cashierName = (id: string) => state.employees.find((e) => e.id === id)?.name ?? '—'
  // Any terminal can void a same-day sale, but only with the owner's PIN and a reason.
  const canVoid = (t: Transaction) => t.status === 'Completed' && daysBetween(t.date, now) === 0

  // The server counts the reprint (the copy is marked REPRINT) and logs it; then the browser's print dialog opens.
  async function reprint(t: Transaction) {
    setReprinting(true)
    try {
      await actions.reprintReceipt(t.id)
      window.setTimeout(() => window.print(), 80)
    } catch (error) {
      actions.toast(`Could not reprint: ${apiErrorMessage(error)}`, 'error')
    } finally {
      setReprinting(false)
    }
  }

  return <div className={selected ? 'module-panel split-detail' : 'module-panel'}>
    <div className="split-main">
      <div className="module-intro"><div><span className="eyebrow">SALES JOURNAL</span><h2>Transactions</h2><p>{rows.length} receipts · {peso(net)} net sales</p></div>
        <button className="outline-button" onClick={() => downloadCsv(`transactions-${range.replace(' ', '')}.csv`, ['Receipt', 'Date', 'Cashier', 'Customer', 'Items', 'Method', 'Total', 'Status'], rows.map((t) => [t.number, new Date(t.date).toLocaleString('en-PH'), cashierName(t.cashierId), t.customerType, t.lines.reduce((s, l) => s + l.qty, 0), t.payment.method, t.total.toFixed(2), t.status]))}>↓ EXPORT CSV</button></div>
      <div className="table-toolbar">
        <label className="search-field compact"><span>⌕</span><input placeholder="Receipt # or item" value={query} onChange={(e) => { setQuery(e.target.value); setPage(0) }} /></label>
        <div><Segmented label="Date range" options={['Today', '7 days'] as const} value={range} onChange={(v) => { setRange(v); setPage(0) }} />
          <select className="select" value={method} onChange={(e) => { setMethod(e.target.value as PaymentMethod | 'All'); setPage(0) }} aria-label="Payment method">{['All', 'Cash', 'GCash', 'Card', 'Maya'].map((m) => <option key={m}>{m}</option>)}</select></div>
      </div>
      <div className="data-table-wrap"><table className="data-table clickable"><thead><tr>{['RECEIPT', 'TIME', 'CASHIER', 'ITEMS', 'PAYMENT', 'TOTAL', 'STATUS'].map((h) => <th key={h}>{h}</th>)}</tr></thead>
        <tbody>{visible.map((t) => <tr key={t.id} className={selected?.id === t.id ? 'selected' : ''} onClick={() => actions.setUi({ selectedTxnId: t.id })}>
          <td><b>{t.number}</b><small>{t.customerType !== 'Regular' ? t.customerType.toUpperCase() : 'REGULAR'}</small></td>
          <td>{range === 'Today' ? time(t.date) : relativeDay(t.date)}</td><td>{cashierName(t.cashierId)}</td><td>{t.lines.reduce((s, l) => s + l.qty, 0)}</td><td>{t.payment.method}</td><td><b>{peso(t.total)}</b></td><td><StatusPill value={t.status} /></td>
        </tr>)}</tbody></table>
        {rows.length === 0 && <Empty>No transactions match these filters.</Empty>}
      </div>
      <div className="table-foot"><span>SHOWING {visible.length} OF {rows.length}</span><Pager page={page} pages={pages} onPage={setPage} /></div>
    </div>
    {selected && <aside className="detail-pane">
      <div className="detail-head"><span className="eyebrow">RECEIPT DETAIL</span><button className="modal-close" aria-label="Close detail" onClick={() => actions.setUi({ selectedTxnId: null })}>✕</button></div>
      <Receipt txn={selected} />
      <div className="detail-actions">
        <button className="outline-button" disabled={reprinting} onClick={() => void reprint(selected)}>{reprinting ? 'PREPARING…' : 'REPRINT ⎙'}</button>
        <button className="outline-button" disabled={selected.status === 'Voided' || selected.status === 'Refunded'} onClick={() => actions.navigate('Transactions', { returnTxnId: selected.id })}>RETURN / REFUND</button>
        {canVoid(selected) && <button className="danger-button" onClick={() => setConfirmVoid(selected)}>VOID</button>}
      </div>
      {selected.refunds.length > 0 && <div className="refund-history"><span className="eyebrow">REFUNDS</span>{selected.refunds.map((r) => <div key={r.id}><b>{peso(r.amount)}</b><small>{relativeDay(r.date)} · {r.reason} · {r.restocked ? 'restocked' : 'written off'}</small></div>)}</div>}
    </aside>}
    {confirmVoid && <OwnerPinModal title={`Void ${confirmVoid.number}?`} purpose="void" requireReason confirmLabel="VOID SALE"
      description={`Cancels the whole sale of ${peso(confirmVoid.total)} and returns all items to stock. Voids are only allowed on the same business day and are recorded in the e-journal.`}
      onClose={() => setConfirmVoid(null)}
      perform={(pin, reason) => actions.voidTransaction(confirmVoid.id, pin, reason)}
      onApproved={({ owner_name }) => { actions.toast(`${confirmVoid.number} voided · approved by ${owner_name}`); setConfirmVoid(null) }} />}
  </div>
}

export function Pager({ page, pages, onPage }: { page: number; pages: number; onPage: (page: number) => void }) {
  const numbers = Array.from({ length: pages }, (_, i) => i).filter((i) => i === 0 || i === pages - 1 || Math.abs(i - page) <= 1)
  return <div><button disabled={page === 0} onClick={() => onPage(page - 1)} aria-label="Previous page">‹</button>
    {numbers.map((i, index) => <span key={i} className="pager-group">{index > 0 && i - numbers[index - 1] > 1 && <span>…</span>}{i === page ? <b>{i + 1}</b> : <button onClick={() => onPage(i)}>{i + 1}</button>}</span>)}
    <button disabled={page >= pages - 1} onClick={() => onPage(page + 1)} aria-label="Next page">›</button></div>
}

const reasons = ['Damaged / defective', 'Expired on purchase', 'Wrong item', 'Changed mind', 'Overcharged'] as const

export function ReturnsPanel() {
  const { state, actions } = useStore()
  const [lookup, setLookup] = useState('')
  const [qty, setQty] = useState<Record<string, number>>({})
  const [reason, setReason] = useState<(typeof reasons)[number]>(reasons[0])
  const [restock, setRestock] = useState(false)
  const [approving, setApproving] = useState(false)
  const txn = state.transactions.find((t) => t.id === state.ui.returnTxnId) ?? null
  const now = new Date()

  function find() {
    const q = lookup.trim().toUpperCase()
    // Full number (INV-2026-000123, or an older OR-000123), or just the digits at the end: newest match first.
    const tail = /^\d+$/.test(q) ? q.padStart(6, '0') : null
    const match = [...state.transactions].reverse().find((t) => t.number === q || (tail !== null && t.number.endsWith(`-${tail}`)))
    if (!match) { actions.toast(`No receipt ${lookup}`, 'error'); return }
    actions.setUi({ returnTxnId: match.id })
    setQty({})
  }

  const returned = (productId: string) => txn?.refunds.flatMap((r) => r.lines).filter((l) => l.productId === productId).reduce((s, l) => s + l.qty, 0) ?? 0
  const ratio = txn && txn.gross ? txn.total / txn.gross : 1
  // What one returned unit gives back: its share of what the customer paid for the line (older receipts: shared in proportion).
  const unitRefund = (l: { qty: number; price: number; net?: number | null }) => (l.net !== null && l.net !== undefined && l.qty ? l.net / l.qty : l.price * ratio)
  const amount = txn ? txn.lines.reduce((s, l) => s + (qty[l.productId] ?? 0) * unitRefund(l), 0) : 0
  const count = Object.values(qty).reduce((a, b) => a + b, 0)
  const age = txn ? daysBetween(txn.date, now) : 0

  // Every refund needs the owner's PIN (high-risk action). The refund is sent with the PIN; this runs once both are accepted.
  function submitted(ownerName: string) {
    if (!txn) return
    actions.toast(`Refunded ${peso(amount)} on ${txn.number} · approved by ${ownerName}`)
    setQty({})
    setApproving(false)
  }

  const recent = state.transactions.flatMap((t) => t.refunds.map((r) => ({ ...r, number: t.number }))).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 6)

  return <div className="module-panel">
    <div className="module-intro"><div><span className="eyebrow">AFTER-SALES</span><h2>Returns &amp; refunds</h2><p>Look up a receipt, choose the items being returned, and decide whether they go back on the shelf.</p></div></div>
    <div className="lookup-row"><label className="search-field compact"><span>⌕</span><input placeholder="Receipt number, e.g. INV-2026-000123" value={lookup} onChange={(e) => setLookup(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') find() }} /></label><button className="primary-button" onClick={find}>FIND RECEIPT</button></div>
    {!txn && <Empty>Search a receipt, or pick one in the Transactions panel and press “Return / Refund”.</Empty>}
    {txn && <div className="return-form">
      <div className="return-head"><div><b>{txn.number}</b><small>{shortDate(txn.date)} {time(txn.date)} · {txn.payment.method} · {peso(txn.total)}</small></div><StatusPill value={txn.status} /></div>
      {age > 7 && <div className="advisory-banner"><span>!</span><p><b>Outside the 7-day return window</b><small>This sale is {age} days old. Check with the owner before refunding.</small></p></div>}
      {txn.status === 'Voided' ? <Empty>This sale was voided and cannot be refunded.</Empty> : <>
        <table className="data-table"><thead><tr><th>ITEM</th><th>SOLD</th><th>RETURNED</th><th>RETURN NOW</th><th>REFUND</th></tr></thead><tbody>
          {txn.lines.map((line) => {
            const available = line.qty - returned(line.productId)
            const value = qty[line.productId] ?? 0
            return <tr key={line.productId}><td><b>{line.name}</b><small>{peso(line.price)} each{line.discountPercent ? ` · ${line.discountPercent}% off` : ''}</small></td><td>{line.qty}</td><td>{returned(line.productId)}</td>
              <td><div className="quantity-control"><button disabled={value <= 0} onClick={() => setQty({ ...qty, [line.productId]: value - 1 })}>−</button><span>{value}</span><button disabled={value >= available} onClick={() => setQty({ ...qty, [line.productId]: value + 1 })}>+</button></div></td>
              <td>{peso(value * unitRefund(line))}</td></tr>
          })}
        </tbody></table>
        <div className="form-grid">
          <Field label="REASON"><select value={reason} onChange={(e) => { const r = e.target.value as (typeof reasons)[number]; setReason(r); setRestock(r === 'Wrong item' || r === 'Changed mind' || r === 'Overcharged') }}>{reasons.map((r) => <option key={r}>{r}</option>)}</select></Field>
          <Field label="ITEM CONDITION"><label className="toggle"><input type="checkbox" checked={restock} onChange={(e) => setRestock(e.target.checked)} /><span>{restock ? 'Return to shelf (restock)' : 'Write off to waste log'}</span></label></Field>
        </div>
        <div className="form-actions"><span>{count} ITEM{count === 1 ? '' : 'S'} · REFUND VIA {txn.payment.method.toUpperCase()}</span><button className="primary-button" disabled={!count} onClick={() => setApproving(true)}>REFUND {peso(amount)}</button></div>
      </>}
    </div>}
    {approving && txn && <OwnerPinModal title={`Refund ${peso(amount)}?`} purpose="refund" confirmLabel="APPROVE REFUND"
      description={`${count} item${count === 1 ? '' : 's'} from ${txn.number} · ${reason} · ${restock ? 'returned to shelf' : 'written off'}. Refunds need the owner's PIN.`}
      onClose={() => setApproving(false)}
      perform={(pin) => actions.refund(txn.id, Object.entries(qty).map(([productId, q]) => ({ productId, qty: q })), reason, restock, pin)}
      onApproved={({ owner_name }) => submitted(owner_name)} />}
    <div className="subsection"><span className="eyebrow">RECENT REFUNDS</span>
      {recent.map((r) => <div className="list-row" key={r.id}><div><b>{r.number}</b><small>{relativeDay(r.date)} · {r.reason}</small></div><span>{r.restocked ? 'Restocked' : 'Written off'}</span><strong>{peso(r.amount)}</strong></div>)}
    </div>
  </div>
}
