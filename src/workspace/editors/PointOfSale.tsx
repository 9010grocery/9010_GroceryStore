import { Fragment, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { OwnerPinModal } from '../../components/OwnerPinModal'
import type { CustomerRequest, PaymentMethod, Transaction } from '../../data/types'
import { basketRules } from '../../lib/ai'
import { peso, shortDate, time } from '../../lib/format'
import { batchMarkdown, batchMarkdownUnits, computeTotals, quickCashOptions } from '../../lib/pos'
import { useHorizontalScroll } from '../../hooks/useHorizontalScroll'
import { useScannerWedge } from '../../hooks/useScannerWedge'
import { apiErrorMessage, postDiscountVerify } from '../../services/api'
import { useCurrentUser, useStore } from '../../store/StoreContext'
import { ConfirmModal, Field, Modal, SearchField, Segmented } from '../ui'
import { RequestFields } from './Operations'

export function ProductGrid() {
  const { state, actions } = useStore()
  const user = useCurrentUser()
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('All items')
  const inputRef = useRef<HTMLInputElement>(null)
  const pills = useHorizontalScroll<HTMLDivElement>()
  const products = state.products.filter((p) => p.active)
  const categories = ['All items', ...new Set(products.map((p) => p.category))]
  const q = query.trim().toLowerCase()
  // A scanner types its code in a fast burst. While that is happening the grid is left alone (no flicker as digits arrive)
  // and the code is added to the cart when the scanner presses Enter.
  const [scanning, setScanning] = useState(false)
  const lastKey = useRef(0)
  const scanTimer = useRef<number | undefined>(undefined)
  const shown = scanning ? '' : q
  const filtered = products.filter((p) => (category === 'All items' || p.category === category) && (!shown || p.name.toLowerCase().includes(shown) || p.sku.toLowerCase() === shown || p.barcode.includes(shown)))
  const inCart = new Map(state.cart.map((l) => [l.productId, l.qty]))
  const [requesting, setRequesting] = useState<Omit<CustomerRequest, 'id' | 'date' | 'status'> | null>(null)

  function add(productId: string) {
    const product = state.products.find((p) => p.id === productId)
    if (!product) return
    if ((inCart.get(productId) ?? 0) >= product.stock) {
      actions.toast(`Only ${product.stock} ${product.name} in stock`, 'error')
      return
    }
    actions.addToCart(productId)
  }

  // A barcode scanner (keyboard wedge) works even when the search box isn't focused, e.g. after tapping a product tile.
  useScannerWedge((code) => {
    const scanned = code.trim().toLowerCase()
    const hit = products.find((p) => (p.barcode && p.barcode === scanned) || p.sku.toLowerCase() === scanned)
    if (!hit) actions.toast(`No product with barcode ${code.trim()}`, 'error')
    else add(hit.id)
  })

  function onSearchKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') { window.clearTimeout(scanTimer.current); setScanning(false); onScan() }
    else if (e.key === 'Escape') { window.clearTimeout(scanTimer.current); setScanning(false); setQuery('') }
    else if (e.key.length === 1) {
      const now = performance.now()
      if (now - lastKey.current < 70) setScanning(true)
      lastKey.current = now
      window.clearTimeout(scanTimer.current)
      scanTimer.current = window.setTimeout(() => setScanning(false), 300)
    }
  }

  function onScan() {
    const exact = products.find((p) => p.barcode === q || p.sku.toLowerCase() === q)
    const target = exact ?? (filtered.length === 1 ? filtered[0] : null)
    if (target) {
      add(target.id)
      setQuery('')
    } else if (q) actions.toast(`No single product matches “${query}”`, 'error')
  }

  return <div className="pos-products">
    <div className="panel-toolbar">
      <SearchField inputRef={inputRef} autoFocus placeholder="Search products, type SKU or scan barcode, then Enter" value={query} onChange={setQuery} onKeyDown={onSearchKey} />
      {state.settings.simulateBarcodeScan && <button className="scan-button" title="Simulate barcode scan" aria-label="Simulate barcode scan" onClick={() => { const p = products[Math.floor(Math.random() * products.length)]; if (p) add(p.id); inputRef.current?.focus() }}>▥</button>}
    </div>
    <div className="category-pills" ref={pills.attach}>{categories.map((item) => <button key={item} className={category === item ? 'selected' : ''} onClick={() => setCategory(item)}>{item}</button>)}</div>
    <div className="product-grid">{filtered.map((product) => <button className={product.stock <= 0 ? 'product-card sold-out' : 'product-card'} disabled={product.stock <= 0} key={product.id} onClick={() => add(product.id)}>
      <span className={`product-image ${product.color}`}><i>{product.symbol}</i><small>{product.category.toUpperCase()}</small></span>
      <span className="product-info"><b>{product.name}</b><span>{peso(product.price)}{product.promoPercent ? <i className="product-promo-badge">PROMO −{product.promoPercent}%</i> : null}</span><small className={product.stock <= product.reorderPoint ? 'stock-low' : ''}>{product.stock <= 0 ? 'Out of stock' : `${product.stock} in stock`}</small></span>
      {inCart.has(product.id) ? <span className="product-add in-cart">{inCart.get(product.id)}</span> : <span className="product-add">+</span>}
    </button>)}</div>
    <div className="results-count">SHOWING {filtered.length} OF {products.length} PRODUCTS <span className="results-actions"><button className="request-item-button" onClick={() => setRequesting({ item: q.length > 1 ? query.trim() : '', category: 'Pantry', requestedBy: 'Walk-in', contact: '', notes: '' })}>＋ REQUEST ITEM</button>{user?.role !== 'Cashier' && <button onClick={() => actions.navigate('Inventory')}>MANAGE CATALOG ↗</button>}</span></div>
    {requesting && <Modal title="Customer asked for an item" eyebrow="NOT ON THE SHELF?" onClose={() => setRequesting(null)} footer={<><button className="outline-button" onClick={() => setRequesting(null)}>CANCEL</button><button className="primary-button" disabled={!requesting.item.trim()} onClick={() => { actions.addRequest(requesting); actions.toast('Request sent to the owner'); setRequesting(null) }}>SEND REQUEST</button></>}>
      <RequestFields value={requesting} onChange={setRequesting} />
    </Modal>}
  </div>
}

export function CartPanel() {
  const { state, actions } = useStore()
  const user = useCurrentUser()
  const [paying, setPaying] = useState(false)
  const [receipt, setReceipt] = useState<Transaction | null>(null)
  const [showHeld, setShowHeld] = useState(false)
  // Anything that removes or discards waits here until the cashier confirms it.
  const [confirming, setConfirming] = useState<{ title: string; message: string; label: string; run: () => void } | null>(null)
  // What the discount window is for: every item ('all') or one product id.
  const [discounting, setDiscounting] = useState<'all' | string | null>(null)
  const [approving, setApproving] = useState<number | null>(null)
  const approvedId = useRef<number | null>(null)
  const lines = state.cart.map((line) => ({ ...line, product: state.products.find((p) => p.id === line.productId)! })).filter((l) => l.product)
  const threshold = state.settings.discountThreshold
  const isRegular = state.customerType === 'Regular'
  const percentOf = (l: { discountPercent?: number }) => (isRegular ? l.discountPercent ?? 0 : 0)
  const biggest = Math.max(0, ...lines.map(percentOf))
  const discountedCount = lines.filter((l) => percentOf(l) > 0).length
  const approval = isRegular ? state.discount : null
  // A discount above the threshold can't be charged until the owner has typed their PIN for the biggest one.
  const approved = Boolean(approval?.overrideId && approval.percent >= biggest)
  const needsApproval = biggest > threshold && !approved
  // Batch markdown (owner-set on a batch near its expiry date) is applied by the system; it doesn't stack with the
  // cashier's percent: the bigger saving wins. Mirrors the server.
  const money = (n: number) => Math.round(n * 100) / 100
  const lineInfo = lines.map((l) => {
    const gross = money(l.product.price * l.qty)
    const markdown = isRegular ? batchMarkdown(l.product, l.qty) : 0
    const promoPercent = isRegular ? l.product.promoPercent ?? 0 : 0
    const promo = promoPercent > 0 ? money(gross * (promoPercent / 100)) : 0
    const manual = percentOf(l) > 0 ? money(gross * (percentOf(l) / 100)) : 0
    const amount = Math.min(gross, Math.max(manual, markdown, promo))
    const kind: 'manual' | 'promo' | 'batch' = amount <= 0 || manual >= Math.max(markdown, promo) ? 'manual' : promo >= markdown ? 'promo' : 'batch'
    const auto = kind === 'batch'
    const marked = auto ? batchMarkdownUnits(l.product, l.qty) : null
    return { amount, auto, kind, marked, shown: amount <= 0 ? 0 : kind === 'manual' ? percentOf(l) : kind === 'promo' ? promoPercent : money((amount / gross) * 100) }
  })
  const { lineNets, ...totals } = computeTotals(lines.map((l, i) => ({ price: l.product.price, qty: l.qty, discountable: l.product.seniorPwdEligible !== false, discountPercent: percentOf(l), discountAmount: isRegular ? lineInfo[i].amount : undefined })), state.customerType, state.settings.vatRate)
  const uniformPercent = lines.length > 0 && lineInfo.every((x) => x.shown > 0 && x.shown === lineInfo[0].shown) ? lineInfo[0].shown : 0
  const discountTarget = discounting === 'all' ? null : lines.find((l) => l.productId === discounting)

  /** Gives the item(s) the discount; if the biggest one in the cart now needs the owner's PIN, asks for it. */
  function applyDiscount(percent: number) {
    const target = discounting
    setDiscounting(null)
    if (target === null) return
    let nextBiggest = percent
    if (target === 'all') actions.setAllDiscount(percent)
    else {
      actions.setLineDiscount(target, percent)
      nextBiggest = Math.max(percent, ...lines.filter((l) => l.productId !== target).map(percentOf))
    }
    const covered = Boolean(approval?.overrideId && approval.percent >= nextBiggest)
    if (nextBiggest > threshold && !covered) setApproving(nextBiggest)
  }
  function removeDiscount() {
    const target = discounting
    setConfirming({
      title: 'Remove this discount?',
      message: target === 'all' ? 'Every item goes back to its full price.' : 'This item goes back to its full price.',
      label: 'REMOVE DISCOUNT',
      run: () => {
        setDiscounting(null)
        if (target === 'all') actions.setAllDiscount(null)
        else if (target) actions.setLineDiscount(target, null)
      },
    })
  }
  const rules = useMemo(() => basketRules(state.transactions), [state.transactions])
  const cartIds = new Set(state.cart.map((l) => l.productId))
  const suggestion = rules.find((r) => cartIds.has(r.a) && !cartIds.has(r.b) && (state.products.find((p) => p.id === r.b)?.stock ?? 0) > 0)
  const suggested = suggestion ? state.products.find((p) => p.id === suggestion.b) : undefined

  return <div className="cart-panel">
    <div className="cart-meta"><span>NEW SALE <b>· receipt no. is given when paid</b> · {user?.name ?? 'Cashier'}</span><div><button onClick={() => setShowHeld(true)}>HELD ({state.heldCarts.length})</button><button disabled={!lines.length} onClick={() => { actions.holdCart(`Sale ${state.heldCarts.length + 1} · ${time(new Date())}`); actions.toast('Sale put on hold', 'info') }}>HOLD</button><button disabled={!lines.length} onClick={() => setConfirming({ title: 'Clear this sale?', message: `All ${lines.reduce((n, l) => n + l.qty, 0)} items are removed from the cart. This can't be undone.`, label: 'CLEAR SALE', run: actions.clearCart })}>CLEAR</button></div></div>
    <div className="cart-customer"><span className="eyebrow">CUSTOMER</span><Segmented label="Customer type" options={['Regular', 'Senior/PWD'] as const} value={state.customerType === 'Regular' ? 'Regular' : 'Senior/PWD'} onChange={(kind) => actions.setCustomerType(kind === 'Regular' ? 'Regular' : 'Senior')} /></div>
    {isRegular && <div className="cart-discount">
      <span className="eyebrow">DISCOUNT</span>
      {biggest > 0 ? <span className={needsApproval ? 'applied needs-approval' : 'applied'}>
        <b>{discountedCount} item{discountedCount === 1 ? '' : 's'} · up to {biggest}%{approved && approval?.approvedBy ? ` · approved by ${approval.approvedBy}` : needsApproval ? ' · owner PIN needed' : ''}</b>
        {needsApproval && <button onClick={() => setApproving(biggest)}>GET APPROVAL</button>}
        <button className="remove" aria-label="Remove all discounts" onClick={() => setConfirming({ title: 'Remove all discounts?', message: 'Every item goes back to its full price.', label: 'REMOVE DISCOUNTS', run: () => { actions.setAllDiscount(null); actions.setDiscount(null) } })}>✕</button>
      </span> : <small className="discount-hint">Tap ％ on an item, or</small>}
      <button disabled={!lines.length} onClick={() => setDiscounting('all')}>{biggest > 0 ? 'ALL ITEMS' : '＋ ALL ITEMS'}</button>
    </div>}
    <div className="cart-lines">
      {lines.length > 0 ? lines.map(({ product, qty }, index) => <div className="cart-line" key={product.id}>
        <span className="cart-line-index">{String(index + 1).padStart(2, '0')}</span>
        <div className="cart-item-name"><b>{product.name}</b><small>{peso(product.price)} / {product.unit}</small>
          {isRegular && <span className="line-discount"><button aria-label={`Discount ${product.name}`} title="Discount this item" onClick={() => setDiscounting(product.id)}>％</button>{lineInfo[index].shown ? <em title={lineInfo[index].kind === 'manual' ? undefined : lineInfo[index].kind === 'promo' ? 'Promotion set by the owner' : 'Batch markdown set by the owner'}>{lineInfo[index].kind === 'promo' ? `PROMO −${lineInfo[index].shown}%` : lineInfo[index].kind === 'batch' ? (lineInfo[index].marked?.percent ? `NEAR EXPIRY · ${lineInfo[index].marked!.units === qty ? 'all ' : `${lineInfo[index].marked!.units} of `}${qty} at −${lineInfo[index].marked!.percent}%` : `NEAR EXPIRY · avg −${lineInfo[index].shown}%`) : `−${lineInfo[index].shown}%`}</em> : null}</span>}
        </div>
        <div className="quantity-control">
          <button aria-label={`Remove one ${product.name}`} onClick={() => qty > 1 ? actions.setCartQty(product.id, qty - 1) : setConfirming({ title: `Remove ${product.name}?`, message: 'It is taken out of this sale.', label: 'REMOVE ITEM', run: () => actions.setCartQty(product.id, 0) })}>−</button>
          <input aria-label={`${product.name} quantity`} value={qty} inputMode="numeric" onChange={(e) => { const value = Number(e.target.value.replace(/\D/g, '')); actions.setCartQty(product.id, Math.max(1, Math.min(product.stock, value))) }} />
          <button aria-label={`Add one ${product.name}`} disabled={qty >= product.stock} onClick={() => actions.setCartQty(product.id, qty + 1)}>+</button>
        </div>
        <strong>{isRegular && lineInfo[index].shown ? <><s>{peso(product.price * qty)}</s><br />{peso(lineNets[index])}</> : peso(product.price * qty)}</strong>
      </div>) : <div className="empty-cart">Scan or tap a product to begin.</div>}
    </div>
    {suggested && suggestion && <button className="upsell" onClick={() => actions.addToCart(suggested.id)}><span>AI</span><div><b>Suggest: {suggested.name}</b><small>{Math.round(suggestion.confidence * 100)}% of customers buying {state.products.find((p) => p.id === suggestion.a)?.name} also buy this</small></div><i>+ {peso(suggested.price)}</i></button>}
    <div className="cart-bottom">
      <div className="cart-totals">
        <div><span>Subtotal ({lines.reduce((s, l) => s + l.qty, 0)} items)</span><b>{peso(totals.gross)}</b></div>
        {state.customerType !== 'Regular' ? <>
          <div><span>Less VAT (exempt)</span><b>−{peso(totals.lessVat)}</b></div>
          <div><span>Senior/PWD discount 20%</span><b>−{peso(totals.discount)}</b></div>
        </> : <>
          {totals.discount > 0 && <div className="discount-line"><span>{uniformPercent ? `Discount ${uniformPercent}%` : 'Item discounts'}</span><b>−{peso(totals.discount)}</b></div>}
          <div><span>VAT included ({Math.round(state.settings.vatRate * 100)}%)</span><b>{peso(totals.vat)}</b></div>
        </>}
        <div className="total-due"><span>TOTAL DUE</span><strong>{peso(totals.total)}</strong></div>
      </div>
      <button className="complete-sale" disabled={lines.length === 0 || needsApproval} onClick={() => setPaying(true)}>CHARGE {peso(totals.total)} <span>→</span></button>
      {needsApproval && <div className="payment-hint warn">A discount above {threshold}% needs the owner's PIN before you can charge.</div>}
      <div className="payment-hint">{Object.entries(state.settings.payments).filter(([, on]) => on).map(([m]) => m.toUpperCase()).join(' · ')}</div>
    </div>
    {discounting !== null && <DiscountModal threshold={threshold} subject={discountTarget ? discountTarget.product.name : 'every item'} initial={discountTarget ? discountTarget.discountPercent : undefined} onClose={() => setDiscounting(null)} onApply={applyDiscount} onRemove={discountTarget?.discountPercent ? removeDiscount : undefined} />}
    {approving !== null && <OwnerPinModal title={`Approve ${approving}% discount`} purpose="discount" requireReason confirmLabel="APPROVE DISCOUNT"
      description={`Discounts above ${threshold}% need the owner's PIN. The approval covers up to ${approving}% on this sale, for 15 minutes.`}
      onClose={() => setApproving(null)}
      perform={async (pin, reason) => {
        const verdict = await postDiscountVerify(approving, pin, reason)
        if (!verdict.approved || !verdict.override_id) throw new Error('The discount was not approved')
        approvedId.current = verdict.override_id
        return verdict.approved_by ?? 'Owner'
      }}
      onApproved={({ owner_name }) => {
        actions.setDiscount({ percent: approving, overrideId: approvedId.current, approvedBy: owner_name })
        approvedId.current = null
        setApproving(null)
        actions.toast(`Discounts up to ${approving}% approved by ${owner_name}`)
      }} />}
    {paying && <PaymentModal total={totals.total} onClose={() => setPaying(false)} onPaid={(txn) => { setPaying(false); setReceipt(txn) }} />}
    {receipt && <ReceiptModal txn={receipt} onClose={() => setReceipt(null)} />}
    {showHeld && <Modal title="Held sales" eyebrow="PARKED TRANSACTIONS" onClose={() => setShowHeld(false)}>
      {state.heldCarts.length === 0 && <p className="muted-text">No sales on hold.</p>}
      <div className="held-list">{state.heldCarts.map((held) => <div className="held-row" key={held.id}><div><b>{held.label}</b><small>{held.lines.reduce((s, l) => s + l.qty, 0)} items · {held.customerType}</small></div><button className="outline-button" onClick={() => setConfirming({ title: `Discard ${held.label}?`, message: 'This held sale is deleted and its items are not restored. This cannot be undone.', label: 'DISCARD SALE', run: () => actions.discardHeld(held.id) })}>DISCARD</button><button className="primary-button" onClick={() => { actions.resumeCart(held.id); setShowHeld(false) }}>RESUME</button></div>)}</div>
    </Modal>}
    {confirming && <ConfirmModal title={confirming.title} message={<p>{confirming.message}</p>} confirmLabel={confirming.label} onCancel={() => setConfirming(null)} onConfirm={() => { const run = confirming.run; setConfirming(null); run() }} />}
  </div>
}

const QUICK_DISCOUNTS = [5, 10, 15, 20, 25, 30, 50]

function DiscountModal({ threshold, initial, subject, onClose, onApply, onRemove }: { threshold: number; initial?: number; subject: string; onClose: () => void; onApply: (percent: number) => void; onRemove?: () => void }) {
  const [value, setValue] = useState(initial ? String(initial) : '')
  const percent = Number(value)
  const valid = percent > 0 && percent <= 100
  return <Modal title={`Discount · ${subject}`} eyebrow="CASHIER DISCOUNT" onClose={onClose} footer={<>{onRemove && <button className="danger-button" onClick={onRemove}>REMOVE</button>}<span className="spacer" /><button className="outline-button" onClick={onClose}>CANCEL</button><button className="primary-button" disabled={!valid} onClick={() => onApply(Math.round(percent * 100) / 100)}>{valid && percent > threshold ? 'ASK OWNER TO APPROVE →' : 'APPLY DISCOUNT'}</button></>}>
    <p className="muted-text">Take a percentage off {subject === 'every item' ? 'every item in the sale' : <b>{subject}</b>} (for example, an item close to its expiry date). Up to {threshold}% needs no approval; anything higher needs the owner's PIN. Senior Citizen and PWD sales already get their discount by law.</p>
    <div className="discount-quick">{QUICK_DISCOUNTS.map((p) => <button key={p} className={percent === p ? 'selected' : ''} onClick={() => setValue(String(p))}>{p}%</button>)}</div>
    <Field label="DISCOUNT (%)"><input autoFocus inputMode="decimal" value={value} placeholder="0" onChange={(e) => setValue(e.target.value.replace(/[^\d.]/g, ''))} onKeyDown={(e) => { if (e.key === 'Enter' && valid) onApply(Math.round(percent * 100) / 100) }} /></Field>
  </Modal>
}

function PaymentModal({ total, onClose, onPaid }: { total: number; onClose: () => void; onPaid: (txn: Transaction) => void }) {
  const { state, actions } = useStore()
  const methods = (Object.keys(state.settings.payments) as PaymentMethod[]).filter((m) => state.settings.payments[m])
  const [method, setMethod] = useState<PaymentMethod>(methods[0] ?? 'Cash')
  const [tendered, setTendered] = useState('')
  const [reference, setReference] = useState('')
  // Senior/PWD sales must record the ID number and name on the card (RA 9994 / RA 10754).
  const discounted = state.customerType !== 'Regular'
  const [seniorPwd, setSeniorPwd] = useState({ id: '', name: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const cash = Number(tendered) || 0
  const cents = (n: number) => Math.round(n * 100)
  const enough = cents(cash) >= cents(total)
  const valid = (method === 'Cash' ? enough : reference.trim().length >= 4) && (!discounted || (seniorPwd.id.trim().length >= 3 && seniorPwd.name.trim().length >= 2))

  async function pay() {
    if (!valid || busy) return
    setBusy(true)
    setError(null)
    try {
      const txn = await actions.checkout({
        method,
        tendered: method === 'Cash' ? cash : total,
        reference: method === 'Cash' ? undefined : reference.trim(),
        seniorPwd: discounted ? { id: seniorPwd.id.trim(), name: seniorPwd.name.trim() } : undefined,
      })
      if (txn) onPaid(txn)
    } catch (err) {
      setError(`Sale not completed: ${apiErrorMessage(err)}`)
    } finally {
      setBusy(false)
    }
  }

  return <Modal title={`Collect ${peso(total)}`} eyebrow="PAYMENT" onClose={onClose} footer={<><button className="outline-button" disabled={busy} onClick={onClose}>CANCEL</button><button className="primary-button" disabled={!valid || busy} onClick={() => void pay()}>{busy ? 'SAVING…' : 'COMPLETE SALE →'}</button></>}>
    {discounted && <div className="form-row">
      <Field label="SENIOR / PWD ID NO."><input value={seniorPwd.id} maxLength={50} onChange={(e) => setSeniorPwd({ ...seniorPwd, id: e.target.value })} /></Field>
      <Field label="NAME ON ID"><input value={seniorPwd.name} maxLength={100} onChange={(e) => setSeniorPwd({ ...seniorPwd, name: e.target.value })} /></Field>
    </div>}
    <div className="pay-methods">{methods.map((m) => <button key={m} className={method === m ? 'selected' : ''} onClick={() => setMethod(m)}><b>{m === 'Cash' ? '₱' : m === 'Card' ? '▭' : '◉'}</b>{m}</button>)}</div>
    {method === 'Cash' ? <>
      <Field label="CASH RECEIVED"><input autoFocus inputMode="decimal" value={tendered} placeholder="0.00" onChange={(e) => setTendered(e.target.value.replace(/[^\d.]/g, ''))} onKeyDown={(e) => { if (e.key === 'Enter') void pay() }} /></Field>
      <div className="quick-cash"><button onClick={() => setTendered(String(total))}>EXACT {peso(total)}</button>{quickCashOptions(total).filter((amount) => cents(amount) !== cents(total)).map((amount) => <button key={amount} onClick={() => setTendered(String(amount))}>{peso(amount, amount % 1 ? 2 : 0)}</button>)}</div>
      <div className={enough ? 'change-due ok' : 'change-due'}><span>{enough ? 'CHANGE DUE' : 'REMAINING'}</span><strong>{peso(Math.abs(cents(cash) - cents(total)) / 100)}</strong></div>
    </> : <Field label={method === 'Card' ? 'APPROVAL CODE' : `${method.toUpperCase()} REFERENCE NO.`} hint="Enter the reference shown on the customer's confirmation (min. 4 characters)."><input autoFocus value={reference} onChange={(e) => setReference(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void pay() }} /></Field>}
    {error && <p className="pin-error" role="alert">{error}</p>}
  </Modal>
}

export function ReceiptModal({ txn, onClose }: { txn: Transaction; onClose: () => void }) {
  return <Modal title={`Receipt ${txn.number}`} eyebrow={txn.status === 'Completed' ? 'SALE COMPLETE' : txn.status.toUpperCase()} onClose={onClose} footer={<><button className="outline-button" onClick={() => window.print()}>PRINT ⎙</button><button className="primary-button" autoFocus onClick={onClose}>NEW SALE →</button></>}>
    <Receipt txn={txn} />
  </Modal>
}

export function Receipt({ txn }: { txn: Transaction }) {
  const { state } = useStore()
  const s = state.settings
  const cashier = state.employees.find((e) => e.id === txn.cashierId)?.name ?? '—'
  const refunded = txn.refunds.reduce((sum, r) => sum + r.amount, 0)
  const reprints = txn.reprintCount ?? 0
  const discounted = txn.customerType !== 'Regular'
  return <div className="receipt print-area">
    <div className="receipt-head">
      <b>{s.businessName}</b>
      {s.storeName && s.storeName !== s.businessName && <span>{s.storeName}</span>}
      {s.address && <span>{s.address}</span>}
      {s.tin && <span>VAT REG TIN {s.tin}</span>}
      {(s.machineSerial || s.permitNumber) && <span>{[s.machineSerial && `MIN ${s.machineSerial}`, s.permitNumber && `PTU ${s.permitNumber}`].filter(Boolean).join(' · ')}</span>}
    </div>
    {reprints > 0 && <div className="receipt-reprint">REPRINT · COPY {reprints}</div>}
    <div className="receipt-meta"><span>{txn.number}</span><span>{shortDate(txn.date)} {time(txn.date)}</span><span>Cashier: {cashier}</span><span>{txn.terminalId && txn.terminalId !== 'PC-00' ? `Terminal ${txn.terminalId}` : txn.customerType === 'Regular' ? 'Regular' : 'Senior/PWD'}</span></div>
    {discounted && (txn.seniorPwdId || txn.seniorPwdName) && <div className="receipt-id-block"><span>SC/PWD ID: {txn.seniorPwdId}</span><span>Name: {txn.seniorPwdName}</span></div>}
    <div className="receipt-lines">{txn.lines.map((line) => <Fragment key={line.productId}>
      <div><span>{line.name}</span><span>{line.qty} × {line.price.toFixed(2)}</span><b>{(line.qty * line.price).toFixed(2)}</b></div>
      {!discounted && line.discountPercent ? <div className="receipt-line-discount"><span>Less {line.discountPercent}%</span><span /><b>-{(line.net !== null && line.net !== undefined ? line.qty * line.price - line.net : (line.qty * line.price * line.discountPercent) / 100).toFixed(2)}</b></div> : null}
    </Fragment>)}</div>
    <div className="receipt-totals">
      <div><span>Subtotal</span><b>{txn.gross.toFixed(2)}</b></div>
      {discounted && <><div><span>Less VAT</span><b>-{txn.lessVat.toFixed(2)}</b></div><div><span>SC/PWD disc. 20%</span><b>-{txn.discount.toFixed(2)}</b></div></>}
      {!discounted && txn.discount > 0 && <div><span>Discount{txn.discountPercent ? ` ${txn.discountPercent}%` : ''}</span><b>-{txn.discount.toFixed(2)}</b></div>}
      <div className="grand"><span>TOTAL</span><b>{peso(txn.total)}</b></div>
      <div><span>{txn.payment.method}{txn.payment.reference ? ` · ${txn.payment.reference}` : ''}</span><b>{txn.payment.tendered.toFixed(2)}</b></div>
      {txn.payment.method === 'Cash' && <div><span>Change</span><b>{txn.payment.change.toFixed(2)}</b></div>}
      <div className="sub"><span>VATable sales</span><b>{(txn.customerType === 'Regular' ? txn.total - txn.vat : txn.gross - txn.lessVat - txn.vatExempt - txn.vat).toFixed(2)}</b></div>
      <div className="sub"><span>VAT ({Math.round(s.vatRate * 100)}%)</span><b>{txn.vat.toFixed(2)}</b></div>
      <div className="sub"><span>VAT-exempt sales</span><b>{txn.vatExempt.toFixed(2)}</b></div>
      {refunded > 0 && <div className="refund"><span>Refunded</span><b>-{refunded.toFixed(2)}</b></div>}
      {txn.status === 'Voided' && <div className="refund"><span>VOIDED</span><b>{txn.total.toFixed(2)}</b></div>}
    </div>
    <div className="receipt-foot"><span>{s.receiptHeader}</span><span>{s.receiptFooter}</span></div>
  </div>
}