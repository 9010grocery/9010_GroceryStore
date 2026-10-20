import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { categories, colorForCategory } from '../../data/defaults'
import type { Product } from '../../data/types'
import { compactPeso, dateKey, downloadCsv, num, peso, shortDate, time } from '../../lib/format'
import { apiErrorMessage, getBatches, getMovements, putBatchExpiry, putBatchMarkdown, type BatchRow, type MovementsPage, type StockMovement } from '../../services/api'
import { useAnalytics, useCurrentUser, useStore, type UiState } from '../../store/StoreContext'
import { Empty, Field, Metric, Modal, Segmented, StatusPill } from '../ui'
import { Pager } from './Transactions'

export function InventoryMetrics() {
  const { state } = useStore()
  const { analyses } = useAnalytics()
  const value = state.products.reduce((s, p) => s + p.stock * p.cost, 0)
  const retail = state.products.reduce((s, p) => s + p.stock * p.price, 0)
  const low = analyses.filter((a) => a.urgency !== 'OK')
  const expiring = analyses.filter((a) => a.expiryDays !== null && a.expiryDays <= state.settings.expiryWarningDays)
  const out = state.products.filter((p) => p.stock <= 0).length
  return <div className="inventory-metrics"><div className="inventory-heading"><div><span className="eyebrow">STOCK OVERVIEW</span><h2>Inventory at a glance</h2></div>
    <button className="outline-button" onClick={() => downloadCsv('inventory.csv', ['SKU', 'Product', 'Category', 'On hand', 'Unit cost', 'Price', 'Value at cost', 'Expiry'], state.products.map((p) => [p.sku, p.name, p.category, p.stock, p.cost, p.price, (p.cost * p.stock).toFixed(2), p.expiry ? shortDate(p.expiry) : '']))}>↓ EXPORT</button></div>
    <div className="inventory-metric-grid">
      <Metric label="Active products" value={num(state.products.filter((p) => p.active).length)} change={`${out} out`} note="of stock" accent="green" />
      <Metric label="Inventory value" value={compactPeso(value)} change={compactPeso(retail)} note="at retail" accent="blue" />
      <Metric label="Below AI reorder level" value={String(low.length).padStart(2, '0')} change={`${low.filter((l) => l.urgency === 'Urgent').length} urgent`} note="forecast-driven" accent="red" />
      <Metric label="Near expiry" value={String(expiring.length).padStart(2, '0')} change={`next ${state.settings.expiryWarningDays} days`} note={`${analyses.filter((a) => a.atRiskUnits > 0).length} at risk`} accent="orange" />
    </div></div>
}

type SortKey = 'name' | 'stock' | 'cover' | 'expiry' | 'value'
const PAGE = 10

export function InventoryTable() {
  const { state, actions } = useStore()
  const { byId, abc } = useAnalytics()
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('All')
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'cover', dir: 1 })
  const [page, setPage] = useState(0)
  const [editing, setEditing] = useState<Product | 'new' | null>(null)
  const [adjusting, setAdjusting] = useState<Product | null>(null)
  const [receiving, setReceiving] = useState<Product | 'pick' | null>(null)
  const [history, setHistory] = useState<Product | null>(null)
  const [batching, setBatching] = useState<Product | null>(null)
  const owner = useCurrentUser()?.role === 'Owner'
  const filter = state.ui.inventoryFilter
  const q = query.trim().toLowerCase()

  const statusOf = (p: Product) => {
    const a = byId.get(p.id)
    if (p.stock <= 0) return 'Out of stock'
    if (a && a.expiryDays !== null && a.expiryDays <= state.settings.expiryWarningDays) return 'Near expiry'
    if (a && a.urgency !== 'OK') return 'Low stock'
    return 'In stock'
  }
  const rows = state.products
    .filter((p) => (category === 'All' || p.category === category) && (!q || p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q) || p.barcode.includes(q)))
    .filter((p) => filter === 'All' || statusOf(p) === filter)
    .sort((a, b) => {
      const ax = byId.get(a.id)
      const bx = byId.get(b.id)
      const value = (p: Product, x = byId.get(p.id)) => ({ name: p.name, stock: p.stock, cover: x?.daysOfCover ?? Infinity, expiry: p.expiry ? new Date(p.expiry).getTime() : Infinity, value: p.stock * p.cost })[sort.key]
      const va = value(a, ax)
      const vb = value(b, bx)
      return (typeof va === 'string' ? va.localeCompare(vb as string) : (va as number) - (vb as number)) * sort.dir
    })
  const pages = Math.max(1, Math.ceil(rows.length / PAGE))
  const visible = rows.slice(page * PAGE, page * PAGE + PAGE)
  const header = (label: string, key?: SortKey) => <th key={label}>{key ? <button className="th-sort" onClick={() => setSort({ key, dir: sort.key === key ? (sort.dir === 1 ? -1 : 1) : 1 })}>{label}{sort.key === key ? (sort.dir === 1 ? ' ↑' : ' ↓') : ''}</button> : label}</th>

  return <div className="table-panel">
    <div className="table-toolbar">
      <label className="search-field compact"><span>⌕</span><input placeholder="Filter by name, SKU or barcode" value={query} onChange={(e) => { setQuery(e.target.value); setPage(0) }} /></label>
      <div>
        <select className="select" aria-label="Category" value={category} onChange={(e) => { setCategory(e.target.value); setPage(0) }}><option>All</option>{[...new Set(state.products.map((p) => p.category))].map((c) => <option key={c}>{c}</option>)}</select>
        <div className="toolbar-actions">
          {owner && <button className="outline-button" onClick={() => setReceiving('pick')}>⇩ RECEIVE DELIVERY</button>}
          <button className="primary-button" onClick={() => setEditing('new')}>＋ ADD PRODUCT</button>
        </div>
      </div>
    </div>
    <Segmented label="Stock status" options={['All', 'Low stock', 'Near expiry', 'Out of stock'] as const} value={filter} onChange={(v: UiState['inventoryFilter']) => { actions.setUi({ inventoryFilter: v }); setPage(0) }} />
    <div className="data-table-wrap"><table className="data-table"><thead><tr>{[header('PRODUCT', 'name'), header('CATEGORY'), header('ON HAND', 'stock'), header('AI REORDER AT'), header('DAYS OF COVER', 'cover'), header('STATUS'), header('EXPIRY', 'expiry'), header('VALUE', 'value'), header('')]}</tr></thead>
      <tbody>{visible.map((p) => {
        const a = byId.get(p.id)
        return <tr key={p.id}>
          <td><b>{p.name}</b><small>{p.sku} · CLASS {abc.get(p.id) ?? '–'}</small></td>
          <td>{p.category}</td>
          <td>{p.stock} {p.unit}s</td>
          <td>{a ? Math.ceil(a.reorderLevel) : p.reorderPoint}</td>
          <td className={a && a.daysOfCover <= p.leadTimeDays ? 'text-red' : ''}>{a && Number.isFinite(a.daysOfCover) ? `${a.daysOfCover.toFixed(1)} d` : '—'}</td>
          <td><StatusPill value={statusOf(p)} /></td>
          <td>{p.expiry ? shortDate(p.expiry) : '—'}</td>
          <td>{peso(p.stock * p.cost, 0)}</td>
          <td className="row-actions"><button onClick={() => setAdjusting(p)} title="Count or remove stock">±</button><button onClick={() => setEditing(p)} title="Edit product">✎</button><RowMenu items={[
            ...(owner ? [{ label: 'Receive delivery', run: () => setReceiving(p) }, { label: 'Batch discount', run: () => setBatching(p) }] : []),
            { label: 'Stock history', run: () => setHistory(p) },
            { label: 'Open forecast', run: () => actions.navigate('AI Insights', { forecastProductId: p.id }) },
          ]} /></td>
        </tr>
      })}</tbody></table>
      {rows.length === 0 && <Empty>No products match.</Empty>}
    </div>
    <div className="table-foot"><span>SHOWING {visible.length} OF {rows.length} PRODUCTS</span><Pager page={page} pages={pages} onPage={setPage} /></div>
    {editing && <ProductModal product={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    {adjusting && <AdjustModal product={adjusting} onClose={() => setAdjusting(null)} />}
    {receiving && <ReceiveModal product={receiving === 'pick' ? null : receiving} onClose={() => setReceiving(null)} />}
    {history && <MovementsModal product={history} onClose={() => setHistory(null)} />}
    {batching && <BatchesModal product={batching} onClose={() => setBatching(null)} />}
  </div>
}

/** The less-used row actions, tucked behind one "⋯" button so the table stays readable. */
function RowMenu({ items }: { items: { label: string; run: () => void }[] }) {
  const [at, setAt] = useState<{ top: number; left: number } | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!at) return
    const close = (event: Event) => {
      const target = event.target as Node
      if (!menu.current?.contains(target) && !trigger.current?.contains(target)) setAt(null)
    }
    document.addEventListener('pointerdown', close)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    return () => {
      document.removeEventListener('pointerdown', close)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [at])

  function toggle() {
    if (at) return setAt(null)
    const bounds = trigger.current?.getBoundingClientRect()
    if (!bounds) return
    const height = items.length * 30 + 10
    const top = bounds.bottom + 4 + height > window.innerHeight ? bounds.top - height - 4 : bounds.bottom + 4
    setAt({ top: Math.max(8, top), left: Math.max(8, Math.min(bounds.right - 168, window.innerWidth - 176)) })
  }

  return <>
    <button ref={trigger} title="More actions" aria-haspopup="menu" aria-expanded={Boolean(at)} onClick={toggle}>⋯</button>
    {at && createPortal(<div ref={menu} className="row-menu" role="menu" style={at}>
      {items.map((item) => <button key={item.label} role="menuitem" onClick={() => { setAt(null); item.run() }}>{item.label}</button>)}
    </div>, document.body)}
  </>
}

function ProductModal({ product, onClose }: { product: Product | null; onClose: () => void }) {
  const { state, actions } = useStore()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [draft, setDraft] = useState<Product>(() => product ?? {
    id: `p${Date.now().toString(36)}`, sku: `SKU-${String(state.products.length + 1).padStart(4, '0')}`, barcode: '', name: '', category: '', unit: 'pc', price: 0, cost: 0, stock: 0,
    reorderPoint: 5, leadTimeDays: 3, supplierId: '', expiry: null, color: colorForCategory(''), symbol: '', active: true, seniorPwdEligible: true,
  })
  const set = <K extends keyof Product>(key: K, value: Product[K]) => setDraft((d) => ({ ...d, [key]: value }))
  const margin = draft.price ? (draft.price / (1 + state.settings.vatRate) - draft.cost) / (draft.price / (1 + state.settings.vatRate)) : 0
  const promo = draft.promo ?? null
  const setPromo = (patch: Partial<{ percent: number; start: string; end: string }>) => {
    const next = { percent: 0, start: '', end: '', ...promo, ...patch }
    set('promo', next.percent > 0 || next.start || next.end ? next : null)
  }
  const promoProblem = !promo || !(promo.percent > 0) ? null
    : promo.percent > 90 ? 'A promo can be at most 90% off.'
    : !promo.start || !promo.end ? 'Pick the first and last day of the promo.'
    : promo.end < promo.start ? 'The promo cannot end before it starts.'
    : null
  const valid = draft.name.trim() && draft.price > 0 && !promoProblem
  // Suggestions: what other products already use, plus the usual grocery categories. Anything can be typed.
  const knownCategories = [...new Set([...state.products.map((p) => p.category), ...categories])].filter(Boolean).sort()
  const knownSuppliers = [...new Set(state.products.map((p) => p.supplierId))].filter(Boolean).sort()

  function save() {
    if (!valid) return
    const category = draft.category.trim() || 'Uncategorized'
    actions.saveProduct({ ...draft, name: draft.name.trim(), category, supplierId: draft.supplierId.trim(), symbol: draft.name.trim()[0].toUpperCase(), color: colorForCategory(category) })
    actions.toast(product ? 'Product updated' : 'Product added to catalog')
    onClose()
  }

  return <Modal title={product ? `Edit ${product.name}` : 'Add product'} eyebrow="CATALOG" wide onClose={onClose} footer={<>{product && <button className="outline-button" onClick={() => { actions.saveProduct({ ...draft, active: !draft.active }); onClose() }}>{draft.active ? 'ARCHIVE' : 'RESTORE'}</button>}{product && <button className="danger-button" onClick={() => setConfirmDelete(true)}>DELETE</button>}<span className="spacer" /><button className="outline-button" onClick={onClose}>CANCEL</button><button className="primary-button" disabled={!valid} onClick={save}>SAVE PRODUCT</button></>}>
    <div className="form-grid">
      <Field label="PRODUCT NAME"><input autoFocus value={draft.name} onChange={(e) => set('name', e.target.value)} /></Field>
      <Field label="CATEGORY"><input list="product-categories" value={draft.category} placeholder="e.g. Canned Goods" onChange={(e) => set('category', e.target.value)} /><datalist id="product-categories">{knownCategories.map((c) => <option key={c} value={c} />)}</datalist></Field>
      <Field label="SKU"><input value={draft.sku} onChange={(e) => set('sku', e.target.value)} /></Field>
      <Field label="BARCODE"><input value={draft.barcode} inputMode="numeric" onChange={(e) => set('barcode', e.target.value.replace(/\D/g, ''))} /></Field>
      <Field label="SELLING PRICE (VAT INCL.)"><input type="number" min={0} step={0.25} value={draft.price} onChange={(e) => set('price', Number(e.target.value))} /></Field>
      <Field label="UNIT COST" hint={`Gross margin ${(margin * 100).toFixed(1)}% (ex-VAT)`}><input type="number" min={0} step={0.25} value={draft.cost} onChange={(e) => set('cost', Number(e.target.value))} /></Field>
      <Field label="UNIT"><input value={draft.unit} onChange={(e) => set('unit', e.target.value)} /></Field>
      <Field label="ON HAND"><input type="number" min={0} value={draft.stock} onChange={(e) => set('stock', Number(e.target.value))} /></Field>
      <Field label="MIN. REORDER POINT" hint="AI raises this when forecast demand is higher."><input type="number" min={0} value={draft.reorderPoint} onChange={(e) => set('reorderPoint', Number(e.target.value))} /></Field>
      <Field label="SUPPLIER"><input list="product-suppliers" value={draft.supplierId} placeholder="Supplier name" onChange={(e) => set('supplierId', e.target.value)} /><datalist id="product-suppliers">{knownSuppliers.map((name) => <option key={name} value={name} />)}</datalist></Field>
      <Field label="LEAD TIME (DAYS)"><input type="number" min={0} value={draft.leadTimeDays} onChange={(e) => set('leadTimeDays', Number(e.target.value))} /></Field>
      <Field label="NEAREST EXPIRY"><input type="date" value={draft.expiry ? dateKey(draft.expiry) : ''} onChange={(e) => set('expiry', e.target.value ? new Date(`${e.target.value}T00:00:00`).toISOString() : null)} /></Field>
      <Field label="SENIOR / PWD DISCOUNT" hint="Untick items that don't qualify; they're charged in full on Senior/PWD sales."><label className="check-row"><input type="checkbox" checked={draft.seniorPwdEligible !== false} onChange={(e) => set('seniorPwdEligible', e.target.checked)} /> Eligible for the 20% discount</label></Field>
    </div>
    <div className="promo-box">
      <div className="promo-title">PROMOTION <small>Optional. A % off every unit of this product between two dates. It starts and stops by itself.</small></div>
      <div className="form-grid">
        <Field label="PROMO DISCOUNT (%)" hint="Leave empty for no promo"><span className="percent-input"><input type="number" min={0} max={90} step={1} placeholder="0" value={promo?.percent ? promo.percent : ''} onChange={(e) => setPromo({ percent: Number(e.target.value) })} /><i>%</i></span></Field>
        <Field label="FIRST DAY"><input type="date" value={promo?.start ?? ''} onChange={(e) => setPromo({ start: e.target.value })} /></Field>
        <Field label="LAST DAY (INCLUDED)"><input type="date" min={promo?.start || undefined} value={promo?.end ?? ''} onChange={(e) => setPromo({ end: e.target.value })} /></Field>
      </div>
      {promoProblem && <p className="pin-error" role="alert">{promoProblem}</p>}
      {draft.promoPercent ? <p className="batch-hint">Running now: {draft.promoPercent}% off.</p> : null}
    </div>
    {confirmDelete && product && <DeleteProductModal product={product} onClose={() => setConfirmDelete(false)} onDeleted={onClose} />}
  </Modal>
}

function DeleteProductModal({ product, onClose, onDeleted }: { product: Product; onClose: () => void; onDeleted: () => void }) {
  const { actions } = useStore()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function remove() {
    setBusy(true)
    setError(null)
    try {
      await actions.deleteProduct(product.id)
      actions.toast(`${product.name} deleted`)
      onDeleted()
    } catch (err) {
      setError(apiErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }
  return <Modal title={`Delete ${product.name}?`} eyebrow="CATALOG" onClose={onClose} footer={<><button className="outline-button" disabled={busy} onClick={onClose}>CANCEL</button><button className="danger-button" disabled={busy || product.stock > 0} onClick={() => void remove()}>{busy ? 'DELETING…' : 'DELETE PRODUCT'}</button></>}>
    <p className="muted-text">The product disappears from the catalog, the POS and the stock lists. Its past sales and stock movements stay on file, and its barcode and SKU can be used again. To hide it for a while instead, use ARCHIVE.</p>
    {product.stock > 0 && <p className="pin-error" role="alert">{product.stock} {product.unit}{product.stock === 1 ? '' : 's'} still on hand. Write the stock off (± button) or sell it first.</p>}
    {error && <p className="pin-error" role="alert">{error}</p>}
  </Modal>
}

function AdjustModal({ product, onClose }: { product: Product; onClose: () => void }) {
  const { actions } = useStore()
  const [mode, setMode] = useState<'Count' | 'Remove'>('Count')
  const [qty, setQty] = useState(product.stock)
  const [note, setNote] = useState('')
  // Stock never goes below zero: a removal is capped at what is on hand.
  const delta = mode === 'Remove' ? -Math.min(qty, product.stock) : qty - product.stock
  return <Modal title={`Adjust stock · ${product.name}`} eyebrow="STOCK MOVEMENT" onClose={onClose} footer={<><button className="outline-button" onClick={onClose}>CANCEL</button><button className="primary-button" disabled={delta === 0} onClick={() => { actions.adjustStock(product.id, delta, [mode, note.trim()].filter(Boolean).join(': ')); actions.toast(`${product.name}: ${delta > 0 ? '+' : ''}${delta} ${product.unit}s`); onClose() }}>APPLY {delta > 0 ? '+' : ''}{delta}</button></>}>
    <Segmented label="Adjustment type" options={['Count', 'Remove'] as const} value={mode} onChange={(m) => { setMode(m); setQty(m === 'Count' ? product.stock : 0) }} />
    <div className="form-grid">
      <Field label={mode === 'Count' ? 'COUNTED ON SHELF' : 'QUANTITY TO REMOVE'} hint={mode === 'Remove' ? `At most ${product.stock} (what is on hand)` : undefined}><input autoFocus type="number" min={0} max={mode === 'Remove' ? product.stock : undefined} value={qty} onChange={(e) => setQty(Math.max(0, Math.round(Number(e.target.value))))} /></Field>
      <Field label="NOTE"><input value={note} placeholder={mode === 'Remove' ? 'Use the Waste log for spoilage' : 'Count sheet, who counted…'} onChange={(e) => setNote(e.target.value)} /></Field>
    </div>
    <p className="muted-text">Current: <b>{product.stock}</b> → New: <b>{Math.max(0, product.stock + delta)}</b> {product.unit}s. A new delivery? Close this and use ⇩ RECEIVE so it gets its own batch and expiry date.</p>
  </Modal>
}

/** A delivery: its own batch with a batch number and expiry date, so the soonest-expiring batch sells first. */
function ReceiveModal({ product, onClose }: { product: Product | null; onClose: () => void }) {
  const { state, actions } = useStore()
  const [picked, setPicked] = useState<string>(product?.id ?? '')
  const chosen = product ?? state.products.find((p) => p.id === picked) ?? null
  const [qty, setQty] = useState('')
  const [batch, setBatch] = useState('')
  const [expiry, setExpiry] = useState('')
  const [cost, setCost] = useState(product && product.cost ? String(product.cost) : '')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const quantity = Math.round(Number(qty))
  const today = dateKey(new Date().toISOString())
  const expired = Boolean(expiry) && expiry < today
  const maxDate = `${Number(today.slice(0, 4)) + 10}${today.slice(4)}`
  const tooFar = Boolean(expiry) && expiry > maxDate
  // The product already has dated stock but this delivery has no date: make sure that's on purpose, not a skipped field.
  const missingDate = !expiry && Boolean(chosen?.expiry)
  const [noExpiry, setNoExpiry] = useState(false)
  const valid = Boolean(chosen) && quantity > 0 && !expired && !tooFar && (!missingDate || noExpiry)

  async function save() {
    if (!chosen || !valid || busy) return
    setBusy(true)
    setError(null)
    try {
      await actions.receiveStock({ product_id: chosen.id, qty: quantity, batch_number: batch.trim() || undefined, expiry_date: expiry || null, unit_cost: cost.trim() ? Number(cost) : null, note: note.trim() || undefined })
      actions.toast(`Received ${quantity} × ${chosen.name}${batch.trim() ? ` · batch ${batch.trim()}` : ''}`)
      onClose()
    } catch (err) {
      setError(apiErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return <Modal title={chosen ? `Receive delivery · ${chosen.name}` : 'Receive delivery'} eyebrow="STOCK IN" onClose={onClose} footer={<><button className="outline-button" disabled={busy} onClick={onClose}>CANCEL</button><button className="primary-button" disabled={!valid || busy} onClick={() => void save()}>{busy ? 'SAVING…' : `RECEIVE ${quantity > 0 ? `+${quantity}` : ''}`}</button></>}>
    <div className="form-grid">
      {!product && <Field label="PRODUCT"><select autoFocus value={picked} onChange={(e) => { setPicked(e.target.value); const p = state.products.find((x) => x.id === e.target.value); setCost(p && p.cost ? String(p.cost) : '') }}><option value="">Choose a product…</option>{state.products.filter((p) => p.active).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>}
      <Field label="QUANTITY RECEIVED"><input autoFocus={Boolean(product)} type="number" min={1} value={qty} onChange={(e) => setQty(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void save() }} /></Field>
      <Field label="BATCH / LOT NO." hint="From the box or delivery receipt. Leave blank if none."><input value={batch} maxLength={50} onChange={(e) => setBatch(e.target.value)} /></Field>
      <Field label="EXPIRY DATE" hint={expired ? 'That date has already passed' : tooFar ? 'More than 10 years away. Check the year' : 'Leave blank for items that do not expire'}><input type="date" min={today} max={maxDate} value={expiry} onChange={(e) => setExpiry(e.target.value)} /></Field>
      <Field label="UNIT COST (OPTIONAL)" hint="Updates the product's cost price"><input type="number" min={0} step={0.25} value={cost} onChange={(e) => setCost(e.target.value)} /></Field>
      <Field label="NOTE"><input value={note} maxLength={200} placeholder="Delivery receipt #, supplier…" onChange={(e) => setNote(e.target.value)} /></Field>
    </div>
    {missingDate && <label className="check-row"><input type="checkbox" checked={noExpiry} onChange={(e) => setNoExpiry(e.target.checked)} /> <span>This delivery really has no expiry date. {chosen?.name} has dated stock, and undated stock sells last and never shows in near-expiry alerts.</span></label>}
    {chosen && <p className="batch-hint">On hand now: <b>{chosen.stock}</b> → after delivery: <b>{chosen.stock + (quantity > 0 ? quantity : 0)}</b> {chosen.unit}s. Receiving the same batch number again adds to that batch (the expiry date must match).</p>}
    {error && <p className="pin-error" role="alert">{error}</p>}
  </Modal>
}

/** Every change to a product's stock, newest first, with the stock level after each one. */
function MovementsModal({ product, onClose }: { product: Product; onClose: () => void }) {
  const [pages, setPages] = useState<MovementsPage[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  async function load(before?: number) {
    setLoading(true)
    setError(null)
    try {
      const page = await getMovements(product.id, before)
      setPages((current) => (before ? [...current, page] : [page]))
    } catch (err) {
      setError(apiErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { void load() }, [product.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const rows = useMemo(() => {
    // The newest row ends at today's stock; each older row is what was left before the one above it.
    let balance = pages[0]?.stock ?? 0
    return pages.flatMap((page) => page.movements).map((m: StockMovement) => {
      const after = balance
      balance -= m.change
      return { ...m, after }
    })
  }, [pages])
  const last = pages[pages.length - 1]

  return <Modal wide title={`Stock history · ${product.name}`} eyebrow="MOVEMENTS" onClose={onClose} footer={<button className="primary-button" onClick={onClose}>CLOSE</button>}>
    {error && <p className="pin-error" role="alert">{error}</p>}
    {!error && !loading && rows.length === 0 && <Empty>No stock movements yet.</Empty>}
    {rows.length > 0 && <div className="data-table-wrap"><table className="data-table movement-table"><thead><tr><th>WHEN</th><th>TYPE</th><th>CHANGE</th><th>ON HAND AFTER</th><th>BATCH</th><th>NOTE</th><th>BY</th></tr></thead>
      <tbody>{rows.map((m) => <tr key={m.adjustmentId}>
        <td>{shortDate(m.date)}<small>{time(m.date)}</small></td>
        <td><StatusPill value={m.label} /></td>
        <td><span className={`movement-change ${m.change >= 0 ? 'plus' : 'minus'}`}>{m.change > 0 ? '+' : ''}{m.change}</span></td>
        <td>{m.after}</td>
        <td>{m.batchNumber ?? '—'}{m.expiry && <small>exp {shortDate(m.expiry)}</small>}</td>
        <td>{m.reason || '—'}</td>
        <td>{m.by || '—'}</td>
      </tr>)}</tbody></table></div>}
    {loading && <p className="dashboard-loading">Loading…</p>}
    {last?.hasMore && !loading && <button className="outline-button" onClick={() => void load(last.movements[last.movements.length - 1].adjustmentId)}>LOAD OLDER</button>}
  </Modal>
}

/** The owner marks down ONE batch (e.g. the bread close to its date); the POS then discounts only the units sold from it. */
function BatchesModal({ product, onClose }: { product: Product; onClose: () => void }) {
  const { actions } = useStore()
  const [batches, setBatches] = useState<BatchRow[] | null>(null)
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [dates, setDates] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = async () => {
    try {
      const rows = await getBatches(product.id)
      setBatches(rows)
      setDraft(Object.fromEntries(rows.map((b) => [b.batchId, b.markdownPercent ? String(b.markdownPercent) : ''])))
      setDates(Object.fromEntries(rows.map((b) => [b.batchId, b.expiry ?? ''])))
    } catch (err) {
      setError(apiErrorMessage(err))
    }
  }
  useEffect(() => { void load() }, [product.id]) // eslint-disable-line react-hooks/exhaustive-deps
  async function save(batch: BatchRow) {
    const text = (draft[batch.batchId] ?? '').trim()
    const percent = text === '' ? null : Number(text)
    if (percent !== null && !(percent > 0 && percent <= 90)) { setError('Enter a percent between 1 and 90, or leave it blank for full price.'); return }
    const date = dates[batch.batchId] ?? ''
    setBusy(batch.batchId)
    setError(null)
    try {
      if (date !== (batch.expiry ?? '')) await putBatchExpiry(batch.batchId, date || null)
      if (percent !== (batch.markdownPercent ?? null)) await putBatchMarkdown(batch.batchId, percent)
      actions.toast(percent ? `${product.name}${batch.batchNumber ? ` · batch ${batch.batchNumber}` : ''}: ${percent}% off` : 'Back to full price', 'info')
      await load()
      void actions.refreshLive()
    } catch (err) {
      setError(apiErrorMessage(err))
    } finally {
      setBusy(null)
    }
  }
  return <Modal title={`Batch discount · ${product.name}`} eyebrow="NEAR-EXPIRY MARKDOWN" wide onClose={onClose} footer={<><span className="spacer" /><button className="primary-button" onClick={onClose}>DONE</button></>}>
    <p className="muted-text">Wrong or missing date? Fix it here (the batch order follows the date). Give a discount to one batch only. The POS sells the soonest-expiring batch first and takes the percent off just the units that come from it; a fresh delivery stays at full price.</p>
    {error && <p className="pin-error" role="alert">{error}</p>}
    {!batches ? <p className="muted-text">Loading batches…</p> : batches.length === 0 ? <p className="muted-text">No stock on hand.</p> : <div className="batch-list">
      {batches.map((b, i) => {
        const dirty = (dates[b.batchId] ?? '') !== (b.expiry ?? '') || (draft[b.batchId] ?? '').trim() !== (b.markdownPercent ? String(b.markdownPercent) : '')
        return <div className={`batch-card${dirty ? ' dirty' : ''}`} key={b.batchId}>
          <div className="batch-card-head">
            <b>{b.batchNumber ? `Batch ${b.batchNumber}` : `Batch ${i + 1}`}</b>
            {i === 0 && <span className="batch-tag first">SELLS FIRST</span>}
            {!b.expiry && <span className="batch-tag warn">NO EXPIRY DATE</span>}
            {b.daysLeft !== null && b.daysLeft < 0 && <span className="batch-tag warn">EXPIRED</span>}
            {b.markdownPercent ? <span className="batch-tag sale">{b.markdownPercent}% OFF NOW</span> : null}
            <span className="spacer" />
            <span className="batch-onhand"><b>{b.qty}</b> on hand</span>
          </div>
          <div className="batch-card-fields">
            <Field label="EXPIRY DATE" hint={b.daysLeft === null ? 'Not set' : b.daysLeft < 0 ? 'Already expired' : `${b.daysLeft} day${b.daysLeft === 1 ? '' : 's'} left`}>
              <input aria-label={`Expiry date of batch ${b.batchNumber ?? i + 1}`} type="date" value={dates[b.batchId] ?? ''} onChange={(e) => setDates({ ...dates, [b.batchId]: e.target.value })} />
            </Field>
            <Field label="DISCOUNT FOR THIS BATCH" hint="Leave empty for full price">
              <span className="percent-input"><input aria-label={`Percent off batch ${b.batchNumber ?? i + 1}`} type="number" min={0} max={90} step={1} placeholder="0" value={draft[b.batchId] ?? ''} onChange={(e) => setDraft({ ...draft, [b.batchId]: e.target.value })} /><i>%</i></span>
            </Field>
            <button className="primary-button batch-save" disabled={busy !== null || !dirty} onClick={() => void save(b)}>{busy === b.batchId ? 'SAVING…' : dirty ? 'SAVE CHANGES' : 'SAVED'}</button>
          </div>
        </div>
      })}
    </div>}
  </Modal>
}