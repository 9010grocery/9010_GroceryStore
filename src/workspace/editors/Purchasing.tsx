import { useState } from 'react'
import type { PurchaseOrder } from '../../data/types'
import { useServerData } from '../../hooks/useServerData'
import { peso, shortDate } from '../../lib/format'
import {
  apiErrorMessage, getPurchaseOrders, getRecommendations, getReorderList, getReorderLists, postApproveReorderList, postCancelOrder, postCloseOrder, postPurchaseOrders,
  postReceiveOrder, postRejectReorderList, postReorderList, type Recommendation, type ReceiveLinePayload, type ReorderListSummary,
} from '../../services/api'
import { useStore } from '../../store/StoreContext'
import { Empty, Field, Modal, Segmented, StatusPill } from '../ui'

const supplierName = (name: string | null | undefined) => name || 'No supplier'
const today = () => new Date().toISOString().slice(0, 10)

// ---------------------------------------------------------------------------
// Suggestions + reorder lists
// ---------------------------------------------------------------------------

export function PurchasingPanel() {
  const { state } = useStore()
  const live = state.source === 'live'
  const [tab, setTab] = useState<'Suggestions' | 'Reorder lists'>('Suggestions')
  const [openList, setOpenList] = useState<string | null>(null)

  return <div className="module-panel">
    <div className="module-intro"><div><span className="eyebrow">AI-ASSISTED REPLENISHMENT</span><h2>Purchasing</h2>
      <p>Suggestions only: nothing is ordered automatically. Put the products you want on a reorder list, approve it (change quantities if you like), then turn it into purchase orders.</p></div>
      <Segmented label="View" options={['Suggestions', 'Reorder lists'] as const} value={tab} onChange={setTab} /></div>
    {!live ? <Empty>Purchasing needs the store database. Connect this PC to the store server to see suggestions.</Empty>
      : tab === 'Suggestions' ? <Suggestions onCreated={(id) => { setTab('Reorder lists'); setOpenList(id) }} /> : <ReorderLists openId={openList} onOpen={setOpenList} />}
  </div>
}

function Suggestions({ onCreated }: { onCreated: (listId: string) => void }) {
  const { actions } = useStore()
  const recs = useServerData(true, getRecommendations, [])
  const [overrides, setOverrides] = useState<Record<string, number>>({})
  const [excluded, setExcluded] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const items = recs.data?.items ?? []
  const qtyFor = (r: Recommendation) => overrides[r.productId] ?? r.suggestedQty
  const chosen = items.filter((r) => !excluded.has(r.productId) && qtyFor(r) > 0)
  const total = chosen.reduce((sum, r) => sum + qtyFor(r) * r.unitCost, 0)
  const models = recs.data ? [...new Set(items.filter((r) => r.model !== 'Reorder level').map((r) => r.model))] : []
  const fallback = items.filter((r) => r.model === 'Reorder level').length

  async function create() {
    setBusy(true); setError(null)
    try {
      const list = await postReorderList({ items: chosen.map((r) => ({ product_id: r.productId, qty: qtyFor(r), reason: `${r.model}: ${r.reason}` })) })
      actions.toast(`Reorder list created with ${list.itemCount} items. Review and approve it.`)
      setOverrides({}); setExcluded(new Set())
      onCreated(list.id)
    } catch (e) { setError(apiErrorMessage(e)) } finally { setBusy(false) }
  }

  return <>
    <div className="purchasing-toolbar">
      <span className="muted-text">{recs.data ? `${items.length} product${items.length === 1 ? '' : 's'} need ordering${recs.data.summary.urgent ? ` · ${recs.data.summary.urgent} urgent` : ''}` : 'Working out suggestions…'}</span>
      <div><button className="outline-button" disabled={recs.loading} onClick={recs.reload}>{recs.loading ? 'REFRESHING…' : '↻ REFRESH'}</button>
        <button className="primary-button" disabled={!chosen.length || busy} onClick={() => void create()}>{busy ? 'CREATING…' : `＋ CREATE REORDER LIST · ${chosen.length} ITEM${chosen.length === 1 ? '' : 'S'} · ${peso(total, 0)}`}</button></div>
    </div>
    {(error || recs.error) && <p className="form-error">{error ?? recs.error}</p>}
    {recs.data && items.length === 0 ? <Empty>Every product is above its reorder level. Nothing to buy right now.</Empty> : <div className="data-table-wrap"><table className="data-table"><thead><tr>{['', 'PRODUCT', 'ON HAND', 'ON ORDER', 'FORECAST / WK', 'COVER', 'ORDER QTY', 'SUPPLIER', 'COST', 'BASED ON'].map((h) => <th key={h}>{h}</th>)}</tr></thead>
      <tbody>{items.map((r) => {
        const qty = qtyFor(r)
        const on = !excluded.has(r.productId)
        return <tr key={r.productId} className={on ? '' : 'muted-row'}>
          <td><input type="checkbox" aria-label={`Include ${r.name}`} checked={on} onChange={() => setExcluded((s) => { const n = new Set(s); if (on) n.add(r.productId); else n.delete(r.productId); return n })} /></td>
          <td><b>{r.name}</b><small className={`priority ${r.priority}`}>{r.priority === 'urgent' ? '⚠ STOCK-OUT BEFORE DELIVERY' : r.priority === 'high' ? 'BELOW REORDER LEVEL' : 'LOW COVER'}{r.onList ? ' · ON A LIST' : ''}</small><small className="reason-line" title={r.reason}>{r.reason}</small></td>
          <td>{r.onHand}</td><td>{r.onOrder || '—'}</td><td>{r.forecastDaily > 0 ? r.forecastWeekly.toFixed(1) : '—'}</td>
          <td className={r.priority === 'urgent' ? 'text-red' : ''}>{r.daysOfCover === null ? '—' : `${r.daysOfCover.toFixed(1)} d`}</td>
          <td><input className="cell-input" type="number" min={0} aria-label={`Order quantity for ${r.name}`} value={qty} onChange={(e) => setOverrides({ ...overrides, [r.productId]: Math.max(0, Math.floor(Number(e.target.value))) })} />{qty !== r.suggestedQty && <small>Suggested: {r.suggestedQty}</small>}</td>
          <td>{supplierName(r.supplier)}<small>{r.leadTimeDays}D LEAD TIME</small></td>
          <td>{peso(qty * r.unitCost, 0)}</td>
          <td><span className={`model-chip ${r.model === 'Reorder level' ? 'fallback' : ''}`}>{r.model}</span><small>{r.historyDays} d of sales</small></td>
        </tr>
      })}</tbody></table></div>}
    {recs.data && <div className="wma-evidence"><span className="evidence-icon">⌁</span><div><b>{models.length ? `Forecast by ${models.join(', ')}` : 'Forecast by weighted moving average'}{fallback ? ` · ${fallback} on the reorder-level rule` : ''}</b>
      <small>{recs.data.ml.available ? (recs.data.ml.error ? `AI model service problem: ${recs.data.ml.error}. Using the moving average instead.` : `${recs.data.ml.used} product${recs.data.ml.used === 1 ? '' : 's'} forecast by the AI model service.`) : 'The AI model service is not installed on this PC yet, so a weighted moving average is used.'} Products with fewer than {recs.data.minSamples} days of sales use their reorder level.</small></div></div>}
  </>
}

function ReorderLists({ openId, onOpen }: { openId: string | null; onOpen: (id: string | null) => void }) {
  const { state } = useStore()
  const [status, setStatus] = useState<'Open' | 'All'>('Open')
  const lists = useServerData<ReorderListSummary[]>(true, () => getReorderLists(), [state.liveSyncedAt])
  const rows = (lists.data ?? []).filter((l) => status === 'All' || l.status === 'pending' || l.status === 'approved')

  return <>
    <div className="table-toolbar"><span className="muted-text">Pending lists wait for your approval. Approved lists are ready to become purchase orders.</span><Segmented label="Status" options={['Open', 'All'] as const} value={status} onChange={setStatus} /></div>
    {lists.error && <p className="form-error">{lists.error}</p>}
    <div className="data-table-wrap"><table className="data-table clickable"><thead><tr>{['LIST', 'CREATED', 'ITEMS', 'ESTIMATED COST', 'STATUS', 'ORDERS'].map((h) => <th key={h}>{h}</th>)}</tr></thead>
      <tbody>{rows.map((l) => <tr key={l.id} onClick={() => onOpen(l.id)}>
        <td><b>List {l.id.slice(2)}</b>{l.notes && <small>{l.notes}</small>}</td><td>{shortDate(l.createdAt)}<small>{l.createdBy}</small></td><td>{l.itemCount}</td>
        <td>{peso(l.status === 'approved' || l.status === 'completed' ? l.approvedCost : l.suggestedCost, 0)}</td><td><StatusPill value={l.status === 'completed' ? 'Ordered' : l.status === 'pending' ? 'Pending approval' : l.status} /></td><td>{l.purchaseOrders || '—'}</td></tr>)}</tbody></table>
      {rows.length === 0 && <Empty>No reorder lists yet. Create one from the suggestions.</Empty>}</div>
    {openId && <ListModal id={openId} onClose={() => onOpen(null)} />}
  </>
}

function ListModal({ id, onClose }: { id: string; onClose: () => void }) {
  const { actions } = useStore()
  const list = useServerData(true, () => getReorderList(id), [id])
  const [qty, setQty] = useState<Record<number, number>>({})
  const [rejecting, setRejecting] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const data = list.data
  const pending = data?.status === 'pending'
  const qtyFor = (itemId: number, suggested: number) => qty[itemId] ?? suggested
  const total = data ? data.items.reduce((sum, i) => sum + (pending ? qtyFor(i.itemId, i.suggestedQty) : i.approved ? i.approvedQty ?? 0 : 0) * i.unitCost, 0) : 0

  async function run(work: () => Promise<string>) {
    setBusy(true); setError(null)
    try {
      const message = await work()
      actions.toast(message)
      void actions.refreshLive()
      list.reload()
    } catch (e) { setError(apiErrorMessage(e)) } finally { setBusy(false) }
  }

  return <Modal wide title={data ? `Reorder list ${id.slice(2)}` : 'Reorder list'} eyebrow="OWNER APPROVAL" onClose={onClose} footer={data && <>
    {pending && rejecting === null && <button className="danger-button" disabled={busy} onClick={() => setRejecting('')}>REJECT LIST</button>}
    <span className="spacer" />
    {pending && rejecting === null && <button className="primary-button" disabled={busy || !data.items.some((i) => qtyFor(i.itemId, i.suggestedQty) > 0)} onClick={() => void run(async () => {
      const changed = data.items.filter((i) => qtyFor(i.itemId, i.suggestedQty) !== i.suggestedQty).map((i) => ({ item_id: i.itemId, qty: qtyFor(i.itemId, i.suggestedQty) }))
      await postApproveReorderList(id, changed)
      return 'List approved. Create the purchase orders when you are ready.'
    })}>APPROVE · {peso(total, 0)}</button>}
    {data.status === 'approved' && <button className="primary-button" disabled={busy} onClick={() => void run(async () => {
      const orders = await postPurchaseOrders({ reorder_list_id: id })
      return `${orders.length} purchase order${orders.length === 1 ? '' : 's'} created: ${orders.map((o) => o.number).join(', ')}`
    })}>CREATE PURCHASE ORDERS</button>}
  </>}>
    {list.error && <p className="form-error">{list.error}</p>}
    {!data ? <p className="muted-text">Loading…</p> : <>
      <p className="muted-text">Created {shortDate(data.createdAt)} by {data.createdBy} · <StatusPill value={data.status === 'completed' ? 'Ordered' : data.status === 'pending' ? 'Pending approval' : data.status} />{data.decidedBy ? ` · ${data.status === 'rejected' ? 'rejected' : 'approved'} by ${data.decidedBy}` : ''}{data.rejectedReason ? ` · "${data.rejectedReason}"` : ''}</p>
      <table className="data-table"><thead><tr>{['PRODUCT', 'ON HAND', 'SUPPLIER', 'SUGGESTED', 'QUANTITY', 'COST'].map((h) => <th key={h}>{h}</th>)}</tr></thead><tbody>
        {data.items.map((i) => {
          const q = pending ? qtyFor(i.itemId, i.suggestedQty) : i.approvedQty ?? 0
          return <tr key={i.itemId} className={!pending && !i.approved ? 'muted-row' : ''}>
            <td><b>{i.name}</b><small className="reason-line" title={i.reason}>{i.reason}</small></td><td>{i.onHand}<small>reorder at {i.reorderPoint}</small></td><td>{supplierName(i.supplier)}</td><td>{i.suggestedQty}</td>
            <td>{pending ? <input className="cell-input" type="number" min={0} aria-label={`Quantity of ${i.name}`} value={q} onChange={(e) => setQty({ ...qty, [i.itemId]: Math.max(0, Math.floor(Number(e.target.value))) })} /> : i.approved ? q : 'Dropped'}{pending && q !== i.suggestedQty && <small>{q === 0 ? 'will be dropped' : 'changed'}</small>}</td>
            <td>{peso(q * i.unitCost, 0)}</td></tr>
        })}</tbody></table>
      <div className="form-actions"><span>{pending ? 'TOTAL IF APPROVED' : 'APPROVED TOTAL'}</span><b>{peso(total)}</b></div>
      {rejecting !== null && pending && <div className="inline-confirm"><Field label="WHY IS THIS LIST REJECTED?"><input autoFocus value={rejecting} maxLength={255} onChange={(e) => setRejecting(e.target.value)} placeholder="e.g. Already have enough stock" /></Field>
        <div><button className="outline-button" onClick={() => setRejecting(null)}>BACK</button><button className="danger-button" disabled={busy || !rejecting.trim()} onClick={() => void run(async () => { await postRejectReorderList(id, rejecting.trim()); setRejecting(null); return 'List rejected' })}>REJECT</button></div></div>}
      {error && <p className="form-error">{error}</p>}
    </>}
  </Modal>
}

// ---------------------------------------------------------------------------
// Purchase orders
// ---------------------------------------------------------------------------

export function PurchaseOrdersPanel() {
  const { state } = useStore()
  const live = state.source === 'live'
  const [status, setStatus] = useState<'Open' | 'All'>('Open')
  const [viewing, setViewing] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const orders = useServerData<PurchaseOrder[]>(live, () => getPurchaseOrders({ status }), [status, state.liveSyncedAt])
  const rows = orders.data ?? []
  const received = (po: PurchaseOrder) => `${po.lines.filter((l) => l.received >= l.qty).length}/${po.lines.length}`

  return <div className="module-panel">
    <div className="module-intro"><div><span className="eyebrow">SUPPLIERS</span><h2>Purchase orders</h2><p>Record what arrives, in parts if needed. Each delivery becomes stock in its own batch with its expiry date.</p></div>
      <div className="intro-actions"><Segmented label="Status" options={['Open', 'All'] as const} value={status} onChange={setStatus} />{live && <button className="primary-button" onClick={() => setCreating(true)}>＋ NEW ORDER</button>}</div></div>
    {!live ? <Empty>Purchase orders need the store database.</Empty> : <>
      {orders.error && <p className="form-error">{orders.error}</p>}
      <div className="data-table-wrap"><table className="data-table clickable"><thead><tr>{['PO NUMBER', 'SUPPLIER', 'ITEMS IN', 'CREATED', 'EXPECTED', 'TOTAL', 'STATUS'].map((h) => <th key={h}>{h}</th>)}</tr></thead>
        <tbody>{rows.map((po) => <tr key={po.id} onClick={() => setViewing(po.id)}><td><b>{po.number}</b><small>{po.source.toUpperCase()}</small></td><td>{supplierName(po.supplierId)}</td><td>{received(po)}</td><td>{shortDate(po.created)}</td><td>{po.expected ? shortDate(po.expected) : '—'}</td><td>{peso(po.total ?? 0, 0)}</td><td><StatusPill value={po.status} /></td></tr>)}</tbody></table>
        {rows.length === 0 && <Empty>{status === 'Open' ? 'No open purchase orders.' : 'No purchase orders yet.'}</Empty>}</div>
      {viewing && <OrderModal key={viewing} id={viewing} onClose={() => setViewing(null)} onChanged={orders.reload} />}
      {creating && <NewOrderModal onClose={() => setCreating(false)} onCreated={(created) => { setCreating(false); orders.reload(); if (created[0]) setViewing(created[0].id) }} />}
    </>}
  </div>
}

interface ReceiveDraft { qty: string; batch: string; expiry: string; cost: string }

function OrderModal({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { state, actions } = useStore()
  const [po, setPo] = useState<PurchaseOrder | null>(null)
  const load = useServerData<PurchaseOrder[]>(true, () => getPurchaseOrders({ status: 'All' }), [id])
  const order = po ?? load.data?.find((o) => o.id === id) ?? null
  const [draft, setDraft] = useState<Record<number, ReceiveDraft>>({})
  const [reason, setReason] = useState<{ kind: 'cancel' | 'close'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const open = order?.status === 'Pending' || order?.status === 'Partially received'
  const field = (itemId: number, remaining: number): ReceiveDraft => draft[itemId] ?? { qty: String(remaining), batch: '', expiry: '', cost: '' }
  const product = (pid: string) => state.products.find((p) => p.id === pid)

  const lines: ReceiveLinePayload[] = []
  let invalid: string | null = null
  if (order && open) {
    for (const l of order.lines) {
      const remaining = l.qty - l.received
      if (remaining <= 0 || l.itemId === undefined) continue
      const f = field(l.itemId, remaining)
      const q = Number(f.qty)
      if (f.qty.trim() === '' || q === 0) continue
      if (!Number.isInteger(q) || q < 0) { invalid = `Enter a whole number for ${l.name}`; continue }
      if (q > remaining) { invalid = `Only ${remaining} ${l.name} still expected`; continue }
      lines.push({ item_id: l.itemId, qty: q, ...(f.batch.trim() ? { batch_number: f.batch.trim() } : {}), ...(f.expiry ? { expiry_date: f.expiry } : {}), ...(f.cost.trim() && Number(f.cost) >= 0 ? { unit_cost: Number(f.cost) } : {}) })
    }
  }

  async function act(work: () => Promise<void>) {
    setBusy(true); setError(null)
    try { await work(); void actions.refreshLive(); onChanged() } catch (e) { setError(apiErrorMessage(e)) } finally { setBusy(false) }
  }

  const receive = () => act(async () => {
    if (!order) return
    const result = await postReceiveOrder(order.id, lines)
    setPo(result.order); setDraft({})
    actions.toast(result.order.status === 'Completed' ? `${result.order.number} received in full; stock updated` : `${result.order.number}: partial delivery recorded; stock updated`)
    if (result.belowReorder.length) setNotice(`Still at or below the reorder level: ${result.belowReorder.map((b) => `${b.name} (${b.stock}/${b.reorderPoint})`).join(', ')}. Consider another order.`)
  })

  return <Modal wide title={order?.number ?? 'Purchase order'} eyebrow={order ? supplierName(order.supplierId).toUpperCase() : 'PURCHASE ORDER'} onClose={onClose} footer={order && open && <>
    {order.status === 'Pending' && !reason && <button className="danger-button" disabled={busy} onClick={() => setReason({ kind: 'cancel', text: '' })}>CANCEL ORDER</button>}
    {order.status === 'Partially received' && !reason && <button className="outline-button" disabled={busy} onClick={() => setReason({ kind: 'close', text: '' })}>CLOSE: REST WON&apos;T ARRIVE</button>}
    <span className="spacer" />
    {!reason && <button className="primary-button" disabled={busy || !lines.length || Boolean(invalid)} onClick={() => void receive()}>{busy ? 'SAVING…' : `RECEIVE ${lines.length} ITEM${lines.length === 1 ? '' : 'S'}`}</button>}
  </>}>
    {load.error && <p className="form-error">{load.error}</p>}
    {!order ? <p className="muted-text">Loading…</p> : <>
      <p className="muted-text">Created {shortDate(order.created)}{order.createdBy ? ` by ${order.createdBy}` : ''} · expected {order.expected ? shortDate(order.expected) : 'no date'} · <StatusPill value={order.status} />{order.cancelReason ? ` · ${order.cancelReason}` : ''}{order.notes ? ` · ${order.notes}` : ''}</p>
      <table className="data-table"><thead><tr>{['PRODUCT', 'ORDERED', 'RECEIVED', ...(open ? ['RECEIVING NOW', 'BATCH / LOT', 'EXPIRY DATE', 'UNIT COST'] : ['UNIT COST', 'LINE TOTAL'])].map((h) => <th key={h}>{h}</th>)}</tr></thead><tbody>
        {order.lines.map((l) => {
          const remaining = l.qty - l.received
          const f = l.itemId !== undefined ? field(l.itemId, remaining) : null
          const set = (patch: Partial<ReceiveDraft>) => l.itemId !== undefined && setDraft({ ...draft, [l.itemId]: { ...field(l.itemId, remaining), ...patch } })
          return <tr key={l.productId} className={open && remaining <= 0 ? 'muted-row' : ''}>
            <td><b>{l.name ?? product(l.productId)?.name ?? l.productId}</b></td><td>{l.qty}</td><td>{l.received}{remaining > 0 && l.received > 0 ? <small>{remaining} to go</small> : null}</td>
            {open ? (remaining > 0 && f ? <>
              <td><input className="cell-input" type="number" min={0} max={remaining} aria-label={`Receiving now: ${l.name}`} value={f.qty} onChange={(e) => set({ qty: e.target.value })} /></td>
              <td><input className="cell-input wide" aria-label={`Batch of ${l.name}`} maxLength={50} placeholder={order.number} value={f.batch} onChange={(e) => set({ batch: e.target.value })} /></td>
              <td><input className="cell-input date" type="date" aria-label={`Expiry date of ${l.name}`} min={today()} value={f.expiry} onChange={(e) => set({ expiry: e.target.value })} /></td>
              <td><input className="cell-input" type="number" min={0} step="0.01" aria-label={`Unit cost of ${l.name}`} placeholder={l.cost.toFixed(2)} value={f.cost} onChange={(e) => set({ cost: e.target.value })} /></td></> : <td colSpan={4} className="muted-text">Received in full</td>) : <><td>{peso(l.cost)}</td><td>{peso(l.qty * l.cost)}</td></>}
          </tr>
        })}</tbody></table>
      <div className="form-actions"><span>ORDER TOTAL</span><b>{peso(order.total ?? order.lines.reduce((s, l) => s + l.qty * l.cost, 0))}</b></div>
      {open && <p className="muted-text">Leave the batch empty to use the PO number. Enter each product&apos;s expiry date so the oldest stock sells first. Set a quantity to 0 for anything that did not arrive.</p>}
      {reason && <div className="inline-confirm"><Field label={reason.kind === 'cancel' ? 'WHY IS THIS ORDER CANCELLED? (OPTIONAL)' : 'WHY IS THE REST NOT ARRIVING? (OPTIONAL)'}><input autoFocus value={reason.text} maxLength={255} onChange={(e) => setReason({ ...reason, text: e.target.value })} /></Field>
        <div><button className="outline-button" onClick={() => setReason(null)}>BACK</button><button className="danger-button" disabled={busy} onClick={() => void act(async () => {
          const updated = reason.kind === 'cancel' ? await postCancelOrder(order.id, reason.text.trim()) : await postCloseOrder(order.id, reason.text.trim())
          setPo(updated); setReason(null)
          actions.toast(reason.kind === 'cancel' ? `${updated.number} cancelled` : `${updated.number} closed`)
        })}>{reason.kind === 'cancel' ? 'CANCEL ORDER' : 'CLOSE ORDER'}</button></div></div>}
      {invalid && <p className="form-error">{invalid}</p>}
      {error && <p className="form-error">{error}</p>}
      {notice && <p className="reorder-notice">{notice}</p>}
    </>}
  </Modal>
}

interface NewLine { productId: string; qty: string; cost: string }

function NewOrderModal({ onClose, onCreated }: { onClose: () => void; onCreated: (orders: PurchaseOrder[]) => void }) {
  const { state, actions } = useStore()
  const products = state.products.filter((p) => p.active)
  const suppliers = [...new Set(products.map((p) => p.supplierId).filter(Boolean))]
  const [supplier, setSupplier] = useState('')
  const [expected, setExpected] = useState('')
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState<NewLine[]>([{ productId: products[0]?.id ?? '', qty: '1', cost: '' }])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const productOf = (id: string) => products.find((p) => p.id === id)
  const valid = lines.length > 0 && lines.every((l) => l.productId && Number.isInteger(Number(l.qty)) && Number(l.qty) > 0) && new Set(lines.map((l) => l.productId)).size === lines.length
  const total = lines.reduce((sum, l) => sum + Number(l.qty || 0) * (l.cost.trim() ? Number(l.cost) : productOf(l.productId)?.cost ?? 0), 0)
  const patch = (index: number, change: Partial<NewLine>) => setLines(lines.map((l, i) => (i === index ? { ...l, ...change } : l)))

  async function create() {
    setBusy(true); setError(null)
    try {
      const created = await postPurchaseOrders({
        ...(supplier.trim() ? { supplier: supplier.trim() } : {}), ...(expected ? { expected_delivery: expected } : {}), ...(notes.trim() ? { notes: notes.trim() } : {}),
        items: lines.map((l) => ({ product_id: l.productId, qty: Number(l.qty), ...(l.cost.trim() ? { unit_cost: Number(l.cost) } : {}) })),
      })
      actions.toast(`${created.map((o) => o.number).join(', ')} created`)
      void actions.refreshLive()
      onCreated(created)
    } catch (e) { setError(apiErrorMessage(e)) } finally { setBusy(false) }
  }

  return <Modal wide title="New purchase order" eyebrow="MANUAL ORDER" onClose={onClose} footer={<><button className="outline-button" onClick={onClose}>CANCEL</button><button className="primary-button" disabled={!valid || busy} onClick={() => void create()}>{busy ? 'CREATING…' : `CREATE ORDER · ${peso(total, 0)}`}</button></>}>
    <div className="form-grid">
      <Field label="SUPPLIER" hint="Leave empty to use the products' own supplier (they must share one)."><input list="supplier-names" value={supplier} maxLength={100} onChange={(e) => setSupplier(e.target.value)} /><datalist id="supplier-names">{suppliers.map((s) => <option key={s} value={s} />)}</datalist></Field>
      <Field label="EXPECTED DELIVERY (OPTIONAL)"><input type="date" min={today()} value={expected} onChange={(e) => setExpected(e.target.value)} /></Field>
      <Field label="NOTES"><input value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} /></Field>
    </div>
    <table className="data-table"><thead><tr>{['PRODUCT', 'QUANTITY', 'UNIT COST', ''].map((h) => <th key={h}>{h}</th>)}</tr></thead><tbody>
      {lines.map((l, i) => <tr key={i}>
        <td><select aria-label="Product" value={l.productId} onChange={(e) => { patch(i, { productId: e.target.value }); if (!supplier) setSupplier(productOf(e.target.value)?.supplierId ?? '') }}>{products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></td>
        <td><input className="cell-input" type="number" min={1} aria-label="Quantity" value={l.qty} onChange={(e) => patch(i, { qty: e.target.value })} /></td>
        <td><input className="cell-input" type="number" min={0} step="0.01" aria-label="Unit cost" placeholder={(productOf(l.productId)?.cost ?? 0).toFixed(2)} value={l.cost} onChange={(e) => patch(i, { cost: e.target.value })} /></td>
        <td>{lines.length > 1 && <button className="link-button" aria-label="Remove line" onClick={() => setLines(lines.filter((_, j) => j !== i))}>REMOVE</button>}</td></tr>)}
    </tbody></table>
    <button className="outline-button" onClick={() => setLines([...lines, { productId: products.find((p) => !lines.some((l) => l.productId === p.id))?.id ?? '', qty: '1', cost: '' }])}>＋ ADD PRODUCT</button>
    {new Set(lines.map((l) => l.productId)).size !== lines.length && <p className="form-error">A product is on the order twice.</p>}
    {error && <p className="form-error">{error}</p>}
  </Modal>
}