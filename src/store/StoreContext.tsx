import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { allWorkspaces, colorForCategory, defaultSettings, emptyStoreData, OWNER_ONLY_WORKSPACES, type StoreData } from '../data/defaults'
import type {
  CartDiscount, CartLine, CustomerRequest, CustomerType, Employee, HeldCart, PaymentMethod, Product, RequestStatus, Role, Settings, Transaction, WasteEntry, WasteReason, WorkspaceName,
} from '../data/types'
import { actingTerminalId } from '../lib/actingTerminal'
import { abcClasses, analyseProduct, buildInsights, type Insight, type ProductAnalysis } from '../lib/ai'
import { dateKey } from '../lib/format'
import { computeTotals } from '../lib/pos'
import {
  apiErrorDetails, apiErrorMessage, apiStatus, deleteStoreProduct, getAuthStatus, getReceipt, getStoreSnapshot, patchRequestStatus, postEmployee, postEmployeeActive, postProduct, postReceive, postRefund,
  postRequest, postSale, postStockChange, postVoid, postWaste, putEmployee, putProduct, putStoreSettings, verifyOwnerPin,
  type ProductPayload, type ReceivePayload, type StoreProduct, type StoreSnapshot,
} from '../services/api'

export interface UiState {
  forecastProductId: string
  settingsSection: SettingsSection
  selectedTxnId: string | null
  returnTxnId: string | null
  inventoryFilter: 'All' | 'Low stock' | 'Near expiry' | 'Out of stock'
}

export type SettingsSection = 'My account' | 'Business profile' | 'Tax & receipts' | 'Payment methods' | 'Inventory & AI' | 'Notifications' | 'Access & roles' | 'Data' | 'Testing'

export interface Toast { id: number; message: string; tone: 'success' | 'error' | 'info' }

/**
 * Where the screens' data comes from. "live": the store's MySQL database through the API (products, stock,
 * sales, refunds, waste, requests, employees); every change is saved there. "demo": no server reached yet, so the
 * screens are empty. Purchase orders and the cash drawer are still kept on each PC.
 */
export type DataSource = 'demo' | 'live'

interface StoreState extends StoreData {
  employees: Employee[]
  settings: Settings
  cart: CartLine[]
  customerType: CustomerType
  /** The cashier's own discount on the sale being rung up (Regular customers only). */
  discount: CartDiscount | null
  heldCarts: HeldCart[]
  sessionId: string | null
  ui: UiState
  source: DataSource
  /** When the live data was last loaded from the server, and the last error if a refresh failed. */
  liveSyncedAt: string | null
  liveError: string | null
}

// v3: the generated demo dataset is gone; older saved state (which held it) is discarded.
// A window acting as a terminal keeps its own copy, so its cart doesn't mix with the owner window's (same PC, same storage).
const STORAGE_KEY = `pos9010-state-v3${actingTerminalId() ? `:${actingTerminalId()}` : ''}`
const defaultUi: UiState = { forecastProductId: '', settingsSection: 'Business profile', selectedTxnId: null, returnTxnId: null, inventoryFilter: 'All' }
/** Live data is reloaded this often, so sales on other terminals and stock changes show up. */
const LIVE_REFRESH_MS = 20_000
/** Which database this PC's saved data belongs to (see the install-id check in useStoreValue). */
const INSTALL_KEY = 'pos9010.installId'

function freshState(): StoreState {
  return {
    ...emptyStoreData(),
    employees: [],
    settings: defaultSettings,
    cart: [],
    customerType: 'Regular',
    discount: null,
    heldCarts: [],
    sessionId: null,
    ui: defaultUi,
    source: 'demo',
    liveSyncedAt: null,
    liveError: null,
  }
}

function loadState(): StoreState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const saved = JSON.parse(raw) as StoreState
      // Shown straight away, then refreshed from the server.
      return { ...saved, discount: saved.discount ?? null, settings: { ...defaultSettings, ...saved.settings }, ui: { ...defaultUi, ...saved.ui }, source: saved.source ?? 'demo', liveSyncedAt: saved.liveSyncedAt ?? null, liveError: null }
    }
  } catch { /* storage unavailable or corrupt: fall back to the seed */ }
  return freshState()
}

const uid = (prefix: string) => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

// ----- Live data: server shapes ↔ UI shapes -----

/** Suppliers are identified by name (there is no supplier list yet), so supplierId holds the supplier's name. */
function toUiProduct({ supplierName, ...product }: StoreProduct): Product {
  return {
    ...product,
    supplierId: supplierName ?? '',
    color: colorForCategory(product.category),
    symbol: (product.name.trim()[0] ?? '?').toUpperCase(),
  }
}

function toPayload(product: Product): ProductPayload {
  return {
    name: product.name,
    sku: product.sku,
    barcode: product.barcode,
    category: product.category,
    supplier_name: product.supplierId,
    unit: product.unit,
    price: product.price,
    cost: product.cost,
    reorder_point: Math.round(product.reorderPoint),
    lead_time_days: Math.round(product.leadTimeDays),
    stock: Math.round(product.stock),
    expiry: product.expiry ? dateKey(product.expiry) : null,
    active: product.active,
    senior_pwd_eligible: product.seniorPwdEligible !== false,
    promo_percent: product.promo && product.promo.percent > 0 ? product.promo.percent : null,
    promo_start: product.promo && product.promo.percent > 0 ? product.promo.start || null : null,
    promo_end: product.promo && product.promo.percent > 0 ? product.promo.end || null : null,
  }
}

function applySnapshot(s: StoreState, snap: StoreSnapshot): Partial<StoreState> {
  const products = snap.products.map(toUiProduct)
  const known = new Set(products.map((p) => p.id))
  const firstLoad = s.source !== 'live'
  const keepLines = (lines: CartLine[]) => lines.filter((line) => known.has(line.productId))
  return {
    source: 'live',
    liveSyncedAt: snap.serverTime,
    liveError: null,
    seededOn: snap.serverTime,
    products,
    transactions: snap.transactions,
    history: snap.history,
    waste: snap.waste,
    requests: snap.requests,
    employees: snap.employees,
    // The store name is set on the server (first launch or Settings) so every PC and receipt shows the same one.
    // TIN and address are kept on the server too, so every receipt on every PC prints the same ones.
    settings: {
      ...s.settings, vatRate: snap.vatRate, tin: snap.storeTin, address: snap.storeAddress, discountThreshold: snap.discountThreshold,
      ...(snap.storeName ? { storeName: snap.storeName, businessName: snap.storeName } : {}),
    },
    // Carts and purchase orders saved before the first load may point at products that don't exist, so they go.
    cart: firstLoad ? [] : keepLines(s.cart),
    discount: firstLoad ? null : s.discount,
    heldCarts: firstLoad ? [] : s.heldCarts.map((h) => ({ ...h, lines: keepLines(h.lines) })).filter((h) => h.lines.length),
    purchaseOrders: snap.purchaseOrders ?? [],
    ui: {
      ...s.ui,
      forecastProductId: known.has(s.ui.forecastProductId) ? s.ui.forecastProductId : products.find((p) => p.active)?.id ?? s.ui.forecastProductId,
      selectedTxnId: snap.transactions.some((t) => t.id === s.ui.selectedTxnId) ? s.ui.selectedTxnId : null,
      returnTxnId: snap.transactions.some((t) => t.id === s.ui.returnTxnId) ? s.ui.returnTxnId : null,
    },
  }
}

function useStoreValue() {
  const [state, setState] = useState<StoreState>(loadState)
  const [toasts, setToasts] = useState<Toast[]>([])
  const saveTimer = useRef<number | undefined>(undefined)
  const stateRef = useRef(state)

  useEffect(() => { stateRef.current = state }, [state])

  useEffect(() => {
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)) } catch { /* ignore quota / private mode */ }
    }, 300)
  }, [state])

  const toast = useCallback((message: string, tone: Toast['tone'] = 'success') => {
    const id = Date.now() + Math.random()
    setToasts((current) => [...current, { id, message, tone }])
    window.setTimeout(() => setToasts((current) => current.filter((t) => t.id !== id)), 3200)
  }, [])

  /** Loads everything from the server. Returns false when the server can't be reached (the screens then keep what they have). */
  const refreshLive = useCallback(async (): Promise<boolean> => {
    try {
      const snap = await getStoreSnapshot()
      setState((s) => ({ ...s, ...applySnapshot(s, snap) }))
      return true
    } catch (error) {
      setState((s) => (s.source === 'live' ? { ...s, liveError: apiErrorMessage(error) } : s))
      return false
    }
  }, [])

  // Once someone is signed in (owner) or assigned (cashier), switch to the server's data and keep it fresh.
  // Retries with a growing delay while the server is unreachable, so a plain browser without the API stays on demo data.
  useEffect(() => {
    if (!state.sessionId) return
    let stopped = false
    let timer: number | undefined
    let retry = 1_000
    const tick = async () => {
      const ok = await refreshLive()
      if (stopped) return
      retry = ok ? 1_000 : Math.min(retry * 2, 30_000)
      timer = window.setTimeout(tick, ok ? LIVE_REFRESH_MS : retry)
    }
    void tick()
    const onFocus = () => { void refreshLive() }
    window.addEventListener('focus', onFocus)
    return () => {
      stopped = true
      window.clearTimeout(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [state.sessionId, refreshLive])

  // The server's database was reset (or this PC now talks to another one): drop everything this PC saved for the
  // old database — cached data, carts, settings, remembered username, sign-in — and start clean.
  useEffect(() => {
    getAuthStatus().then(({ install_id }) => {
      if (!install_id) return
      let known: string | null = null
      try { known = localStorage.getItem(INSTALL_KEY) } catch { return }
      if (known === install_id) return
      try {
        localStorage.setItem(INSTALL_KEY, install_id)
        if (known === null && !Object.keys(localStorage).some((key) => key.startsWith('pos9010'))) return
        for (const key of Object.keys(localStorage)) if (key.startsWith('pos9010') && key !== INSTALL_KEY) localStorage.removeItem(key)
        for (const key of Object.keys(sessionStorage)) if (key.startsWith('pos9010')) sessionStorage.removeItem(key)
      } catch { return }
      window.location.reload()
    }).catch(() => undefined)
  }, [])

  const actions = useMemo(() => {
    const update = (fn: (s: StoreState) => Partial<StoreState>) => setState((s) => ({ ...s, ...fn(s) }))
    const changeStock = (products: Product[], productId: string, delta: number) => products.map((p) => (p.id === productId ? { ...p, stock: Math.max(0, p.stock + delta) } : p))
    const live = () => stateRef.current.source === 'live'
    const replaceProduct = (saved: StoreProduct, oldId = saved.id) => update((s) => ({ products: s.products.map((p) => (p.id === oldId ? toUiProduct(saved) : p)) }))
    const replaceTxn = (txn: Transaction) => update((s) => ({ transactions: s.transactions.some((t) => t.id === txn.id) ? s.transactions.map((t) => (t.id === txn.id ? txn : t)) : [...s.transactions, txn] }))
    /**
     * Live mode: the screen has already changed (so it feels instant); this saves the change on the server.
     * If the server refuses it, the error is shown and the data is reloaded, which undoes the change on screen.
     */
    const save = (what: string, work: () => Promise<unknown>) => {
      work().catch((error) => {
        toast(`${what} was not saved: ${apiErrorMessage(error)}`, 'error')
        void refreshLive()
      })
    }

    return {
      refreshLive,
      navigate(workspace: WorkspaceName, ui?: Partial<UiState>) {
        if (ui) update((s) => ({ ui: { ...s.ui, ...ui } }))
        window.dispatchEvent(new CustomEvent('workspace-navigate', { detail: workspace }))
      },
      setUi: (ui: Partial<UiState>) => update((s) => ({ ui: { ...s.ui, ...ui } })),
      /** Called when the owner signs in or the owner assigns a cashier to this terminal. Adds the person to the local employee list if needed. */
      login: (person: { id: string; name: string; role: Role }) => update((s) => {
        const now = new Date().toISOString()
        const exists = s.employees.some((e) => e.id === person.id)
        const employees = exists
          ? s.employees.map((e) => (e.id === person.id ? { ...e, name: person.name, role: person.role, lastActive: now } : e))
          : [...s.employees, { id: person.id, name: person.name, email: '', role: person.role, status: 'Active' as const, lastActive: now }]
        return { sessionId: person.id, employees }
      }),
      logout: () => update(() => ({ sessionId: null })),

      // ----- Cart -----
      addToCart: (productId: string, qty = 1) => update((s) => {
        const existing = s.cart.find((line) => line.productId === productId)
        return { cart: existing ? s.cart.map((line) => (line.productId === productId ? { ...line, qty: line.qty + qty } : line)) : [...s.cart, { productId, qty }] }
      }),
      setCartQty: (productId: string, qty: number) => update((s) => ({ cart: qty <= 0 ? s.cart.filter((l) => l.productId !== productId) : s.cart.map((l) => (l.productId === productId ? { ...l, qty } : l)) })),
      clearCart: () => update(() => ({ cart: [], customerType: 'Regular', discount: null })),
      // Senior/PWD get their discount by law, so a cashier discount can't be stacked on top.
      setCustomerType: (customerType: CustomerType) => update((s) => (customerType === 'Regular' ? { customerType } : { customerType, discount: null, cart: s.cart.map(({ discountPercent: _dropped, ...line }) => line) })),
      /** Records the owner's PIN approval for the biggest item discount in the cart (null to forget it). */
      setDiscount: (discount: CartDiscount | null) => update(() => ({ discount })),
      /** Discount on one item of the sale (percent), or null to take it off. */
      setLineDiscount: (productId: string, percent: number | null) => update((s) => ({
        cart: s.cart.map((line) => {
          if (line.productId !== productId) return line
          const { discountPercent: _old, ...rest } = line
          return percent && percent > 0 ? { ...rest, discountPercent: percent } : rest
        }),
      })),
      /** The same discount on every item of the sale. */
      setAllDiscount: (percent: number | null) => update((s) => ({
        cart: s.cart.map(({ discountPercent: _old, ...line }) => (percent && percent > 0 ? { ...line, discountPercent: percent } : line)),
      })),
      // A held sale doesn't keep its discount: the owner's approval is only good for a few minutes.
      holdCart: (label: string) => update((s) => (s.cart.length ? { heldCarts: [...s.heldCarts, { id: uid('h'), label, lines: s.cart, customerType: s.customerType, heldAt: new Date().toISOString() }], cart: [], customerType: 'Regular', discount: null } : {})),
      resumeCart: (id: string) => update((s) => {
        const held = s.heldCarts.find((h) => h.id === id)
        if (!held) return {}
        const parked = s.cart.length ? [{ id: uid('h'), label: 'Parked sale', lines: s.cart, customerType: s.customerType, heldAt: new Date().toISOString() }] : []
        return { cart: held.lines, customerType: held.customerType, discount: null, heldCarts: [...s.heldCarts.filter((h) => h.id !== id), ...parked] }
      }),
      discardHeld: (id: string) => update((s) => ({ heldCarts: s.heldCarts.filter((h) => h.id !== id) })),

      /**
       * Completes the sale. Live: the server prices it, numbers the receipt and takes the stock; resolves to the
       * saved receipt, or throws with the server's reason. Senior/PWD sales need the ID number and name (RA 9994 / RA 10754).
       */
      async checkout(payment: { method: PaymentMethod; tendered: number; reference?: string; seniorPwd?: { id: string; name: string } }): Promise<Transaction | null> {
        const s = stateRef.current
        if (!s.cart.length) return null
        if (live()) {
          let txn: Transaction
          try {
            txn = await postSale({
              lines: s.cart.map((line) => ({ product_id: line.productId, qty: line.qty, ...(s.customerType === 'Regular' && line.discountPercent ? { discount_percent: line.discountPercent } : {}) })),
              customer_type: s.customerType,
              senior_pwd_id: payment.seniorPwd?.id,
              senior_pwd_name: payment.seniorPwd?.name,
              payment_method: payment.method,
              amount_received: payment.tendered,
              payment_reference: payment.reference,
              discount_override_id: s.customerType === 'Regular' && s.discount?.overrideId ? s.discount.overrideId : undefined,
            })
          } catch (error) {
            // The owner's approval was refused (expired, already used): the cashier has to get it again.
            if (apiStatus(error) === 403 && apiErrorDetails<{ code?: string }>(error)?.code === 'OWNER_PIN_REQUIRED') {
              update((current) => ({ discount: current.discount ? { ...current.discount, overrideId: null, approvedBy: null } : null }))
            }
            throw error
          }
          update((current) => {
            let products = current.products
            for (const line of txn.lines) products = changeStock(products, line.productId, -line.qty)
            return { products, transactions: [...current.transactions, txn], cart: [], customerType: 'Regular', discount: null }
          })
          return txn
        }
        const lines = s.cart.map((line) => {
          const product = s.products.find((p) => p.id === line.productId)!
          return { productId: product.id, name: product.name, qty: line.qty, price: product.price, discountable: product.seniorPwdEligible !== false, discountPercent: s.customerType === 'Regular' ? line.discountPercent ?? 0 : 0 }
        })
        const { lineNets, ...totals } = computeTotals(lines, s.customerType, s.settings.vatRate)
        const txn: Transaction = {
          id: uid('t'), number: `INV-${new Date().getFullYear()}-${String(s.nextReceipt).padStart(6, '0')}`, date: new Date().toISOString(), cashierId: s.sessionId ?? 'e1',
          customerType: s.customerType, lines: lines.map(({ discountable: _d, ...line }, i) => ({ ...line, net: lineNets[i] })), ...totals,
          payment: { method: payment.method, tendered: payment.tendered, reference: payment.reference, change: Math.max(0, Math.round((payment.tendered - totals.total) * 100) / 100) },
          status: 'Completed', refunds: [],
        }
        update((current) => {
          let products = current.products
          for (const line of lines) products = changeStock(products, line.productId, -line.qty)
          return { products, transactions: [...current.transactions, txn], nextReceipt: current.nextReceipt + 1, cart: [], customerType: 'Regular', discount: null }
        })
        return txn
      },

      /** Returns items from a sale. The owner's PIN is checked by the server; resolves to the approving owner's name. */
      async refund(txnId: string, lines: { productId: string; qty: number }[], reason: string, restock: boolean, ownerPin: string): Promise<string> {
        if (live()) {
          const result = await postRefund(txnId, ownerPin, { reason, restock, lines: lines.filter((l) => l.qty > 0).map((l) => ({ product_id: l.productId, qty: l.qty })) })
          replaceTxn(result.transaction)
          void refreshLive()
          return result.approved_by
        }
        const approval = await verifyOwnerPin(ownerPin, 'refund')
        update((s) => {
          const txn = s.transactions.find((t) => t.id === txnId)
          if (!txn) return {}
          const ratio = txn.gross ? txn.total / txn.gross : 1
          const refundLines = lines.filter((l) => l.qty > 0).map((l) => {
            const sale = txn.lines.find((x) => x.productId === l.productId)!
            return { productId: l.productId, qty: l.qty, amount: Math.round(sale.price * l.qty * ratio * 100) / 100 }
          })
          const amount = refundLines.reduce((sum, l) => sum + l.amount, 0)
          const refunds = [...txn.refunds, { id: uid('r'), date: new Date().toISOString(), lines: refundLines, reason, restocked: restock, amount, by: s.sessionId ?? 'e1' }]
          const returnedAll = txn.lines.every((line) => refunds.flatMap((r) => r.lines).filter((l) => l.productId === line.productId).reduce((sum, l) => sum + l.qty, 0) >= line.qty)
          let products = s.products
          let waste = s.waste
          for (const l of refundLines) {
            if (restock) products = changeStock(products, l.productId, l.qty)
            else {
              const product = s.products.find((p) => p.id === l.productId)
              if (product) waste = [...waste, { id: uid('w'), productId: l.productId, qty: l.qty, reason: 'Customer return', value: product.cost * l.qty, date: new Date().toISOString(), by: s.sessionId ?? 'e1', notes: `${txn.number}: ${reason}` }]
            }
          }
          return { products, waste, transactions: s.transactions.map((t) => (t.id === txnId ? { ...t, refunds, status: returnedAll ? 'Refunded' : 'Partially refunded' } : t)) }
        })
        return approval.owner_name
      },

      /** Cancels a whole sale and restocks it. The owner's PIN is checked by the server; resolves to the approving owner's name. */
      async voidTransaction(txnId: string, ownerPin: string, reason: string): Promise<string> {
        if (live()) {
          const result = await postVoid(txnId, ownerPin, reason)
          replaceTxn(result.transaction)
          void refreshLive()
          return result.approved_by
        }
        const approval = await verifyOwnerPin(ownerPin, 'void')
        update((s) => {
          const txn = s.transactions.find((t) => t.id === txnId)
          if (!txn || txn.status === 'Voided') return {}
          let products = s.products
          for (const line of txn.lines) products = changeStock(products, line.productId, line.qty)
          return { products, transactions: s.transactions.map((t) => (t.id === txnId ? { ...t, status: 'Voided' } : t)) }
        })
        return approval.owner_name
      },

      // ----- Inventory -----
      saveProduct: (product: Product) => {
        const isNew = !stateRef.current.products.some((p) => p.id === product.id)
        update((s) => ({ products: isNew ? [...s.products, product] : s.products.map((p) => (p.id === product.id ? product : p)) }))
        if (live()) save(product.name, async () => replaceProduct(isNew ? await postProduct(toPayload(product)) : await putProduct(product.id, toPayload(product)), product.id))
      },
      adjustStock: (productId: string, delta: number, reason = '') => {
        update((s) => ({ products: changeStock(s.products, productId, delta) }))
        if (live()) save('Stock change', async () => replaceProduct(await postStockChange(productId, delta, reason)))
      },
      /** Books a delivery as its own batch (batch number + expiry). Not optimistic: resolves once the server has saved it, or throws with its reason. */
      async receiveStock(delivery: ReceivePayload): Promise<Product> {
        const saved = await postReceive(delivery)
        replaceProduct(saved)
        return toUiProduct(saved)
      },
      /** Removes a product from the catalog (owner; only when nothing is on hand). Throws with the server's reason. */
      async deleteProduct(productId: string): Promise<void> {
        await deleteStoreProduct(productId)
        update((s) => ({ products: s.products.filter((p) => p.id !== productId), cart: s.cart.filter((l) => l.productId !== productId) }))
      },
      /** Fetches a receipt for printing and counts it as a reprint on the server. Resolves to the saved receipt. */
      async reprintReceipt(txnId: string): Promise<Transaction> {
        const { transaction } = await getReceipt(txnId, true)
        replaceTxn(transaction)
        return transaction
      },
      /** Resolves to null when saved, or the reason it was refused (for example "Only 3 Cola in stock"). */
      async logWaste(entry: { productId: string; qty: number; reason: WasteReason; notes: string }): Promise<string | null> {
        const product = stateRef.current.products.find((p) => p.id === entry.productId)
        if (!product) return 'Product not found'
        if (entry.qty > product.stock) return `Only ${product.stock} ${product.name} in stock`
        if (live()) {
          try {
            const saved = await postWaste({ product_id: entry.productId, qty: entry.qty, reason: entry.reason, notes: entry.notes })
            update((s) => ({ waste: [...s.waste, saved.entry] }))
            replaceProduct(saved.product)
          } catch (error) {
            return apiErrorMessage(error)
          }
          return null
        }
        const record: WasteEntry = { ...entry, id: uid('w'), value: product.cost * entry.qty, date: new Date().toISOString(), by: stateRef.current.sessionId ?? 'e1' }
        update((s) => ({ waste: [...s.waste, record], products: changeStock(s.products, entry.productId, -entry.qty) }))
        return null
      },
      markdown: (productId: string, percent: number) => {
        const product = stateRef.current.products.find((p) => p.id === productId)
        if (!product) return
        const marked = { ...product, price: Math.round(product.price * (1 - percent) * 4) / 4 }
        update((s) => ({ products: s.products.map((p) => (p.id === productId ? marked : p)) }))
        if (live()) save('Markdown', async () => replaceProduct(await putProduct(productId, toPayload(marked))))
      },

      // ----- Requests -----
      addRequest: (request: Omit<CustomerRequest, 'id' | 'date' | 'status'>) => {
        const tempId = uid('q')
        update((s) => ({ requests: [{ ...request, id: tempId, date: new Date().toISOString(), status: 'New' }, ...s.requests] }))
        if (live()) {
          save('Customer request', async () => {
            const saved = await postRequest({ item: request.item, category: request.category, requested_by: request.requestedBy, contact: request.contact, notes: request.notes })
            update((s) => ({ requests: s.requests.map((r) => (r.id === tempId ? saved : r)) }))
          })
        }
      },
      /** Resolves once the server has the change (live mode), so a screen that lists requests from the server can reload. */
      async setRequestStatus(ids: string[], status: RequestStatus): Promise<void> {
        update((s) => ({ requests: s.requests.map((r) => (ids.includes(r.id) ? { ...r, status } : r)) }))
        if (!live()) return
        try { await patchRequestStatus(ids, status) } catch (error) {
          toast(`Request status was not saved: ${apiErrorMessage(error)}`, 'error')
          void refreshLive()
        }
      },

      // ----- People -----
      async saveEmployee(employee: Employee): Promise<void> {
        const isNew = !stateRef.current.employees.some((e) => e.id === employee.id)
        update((s) => ({ employees: isNew ? [...s.employees, employee] : s.employees.map((e) => (e.id === employee.id ? employee : e)) }))
        if (!live()) return
        try {
          const body = { name: employee.name, email: employee.email, status: employee.status }
          const { endedShiftOn, ...saved } = (isNew ? await postEmployee(body) : await putEmployee(employee.id, body)) as Employee & { endedShiftOn?: string | null }
          update((s) => ({ employees: s.employees.map((e) => (e.id === employee.id ? saved : e)) }))
          if (endedShiftOn) toast(`${saved.name} deactivated. Shift ended; ${endedShiftOn} is locked.`)
        } catch (error) {
          toast(`${employee.name} was not saved: ${apiErrorMessage(error)}`, 'error')
          void refreshLive()
        }
      },
      /** Turns an employee on or off. Turning a cashier off also ends their open shift, which locks the terminal they were on. */
      async setEmployeeActive(employeeId: string, active: boolean): Promise<string | null> {
        const current = stateRef.current.employees.find((e) => e.id === employeeId)
        if (!current) return 'Employee not found'
        if (live()) {
          try {
            const { endedShiftOn, ...saved } = await postEmployeeActive(employeeId, active)
            update((s) => ({ employees: s.employees.map((e) => (e.id === employeeId ? saved : e)) }))
            toast(active ? `${saved.name} is active again` : endedShiftOn ? `${saved.name} deactivated. Shift ended; ${endedShiftOn} is locked.` : `${saved.name} deactivated`)
          } catch (error) {
            return apiErrorMessage(error)
          }
          return null
        }
        update((s) => ({ employees: s.employees.map((e) => (e.id === employeeId ? { ...e, status: active ? 'Active' : 'Inactive' } : e)) }))
        toast(active ? `${current.name} is active again` : `${current.name} deactivated`)
        return null
      },

      // ----- Shift / drawer (kept on this PC for now) -----
      cashMovement: (type: 'Cash in' | 'Cash out', amount: number, reason: string) => update((s) => ({ shift: { ...s.shift, movements: [...s.shift.movements, { id: uid('m'), date: new Date().toISOString(), type, amount, reason, by: s.sessionId ?? 'e1' }] } })),
      closeShift: (countedCash: number) => update((s) => ({ shift: { ...s.shift, closedAt: new Date().toISOString(), countedCash } })),
      openShift: (openingFloat: number) => update((s) => ({ shift: { id: uid('sh'), openedAt: new Date().toISOString(), openedBy: s.sessionId ?? 'e1', openingFloat, movements: [] } })),

      updateSettings: (settings: Partial<Settings>) => {
        const before = stateRef.current.settings
        update((s) => ({ settings: { ...s.settings, ...settings } }))
        // The store name, TIN and address are shared through the server (every receipt prints them); the other settings stay on this PC for now.
        if (!live()) return
        const changes: { store_name?: string; business_tin?: string; business_address?: string } = {}
        if (settings.storeName && settings.storeName !== before.storeName) changes.store_name = settings.storeName.trim()
        if (settings.tin !== undefined && settings.tin !== before.tin) changes.business_tin = settings.tin.trim()
        if (settings.address !== undefined && settings.address !== before.address) changes.business_address = settings.address.trim()
        if (Object.keys(changes).length) save('Store details', () => putStoreSettings(changes))
      },
      toast,
    }
  }, [toast, refreshLive])

  return { state, actions, toasts }
}

type StoreValue = ReturnType<typeof useStoreValue>

export interface Analytics {
  analyses: ProductAnalysis[]
  byId: Map<string, ProductAnalysis>
  insights: Insight[]
  abc: Map<string, 'A' | 'B' | 'C'>
}

const StoreContext = createContext<StoreValue | null>(null)
const AnalyticsContext = createContext<Analytics | null>(null)

export function StoreProvider({ children }: { children: ReactNode }) {
  const value = useStoreValue()
  const { products, history, transactions, purchaseOrders, settings, waste, requests } = value.state
  const analytics = useMemo<Analytics>(() => {
    const now = new Date()
    const analyses = products.filter((p) => p.active).map((product) => analyseProduct(product, history, transactions, purchaseOrders, settings, now))
    return { analyses, byId: new Map(analyses.map((a) => [a.product.id, a])), insights: buildInsights(analyses, transactions, waste, requests, now), abc: abcClasses(analyses) }
  }, [products, history, transactions, purchaseOrders, settings, waste, requests])

  return <StoreContext.Provider value={value}><AnalyticsContext.Provider value={analytics}>{children}</AnalyticsContext.Provider></StoreContext.Provider>
}

export function useStore() {
  const value = useContext(StoreContext)
  if (!value) throw new Error('useStore must be used inside <StoreProvider>')
  return value
}

export function useAnalytics() {
  const value = useContext(AnalyticsContext)
  if (!value) throw new Error('useAnalytics must be used inside <StoreProvider>')
  return value
}

/** Workspaces a role may open: the role settings, minus owner-only workspaces for everyone but the owner. */
export function allowedWorkspaces(settings: Settings, role: Role): WorkspaceName[] {
  // Tabs always follow allWorkspaces' order. Saved settings can still name a workspace that has since been
  // merged into another (e.g. Employees into Admin Station); those are dropped.
  const saved = settings.rolePermissions[role] ?? []
  // Settings saved before 'Waste' became 'Write-offs' still say 'Waste'.
  const savedNames: string[] = saved.map((w) => (w as string) === 'Waste' ? 'Write-offs' : w)
  const configured = allWorkspaces.filter((w) => savedNames.includes(w))
  return role === 'Owner' ? configured : configured.filter((w) => !OWNER_ONLY_WORKSPACES.includes(w))
}

export function useCurrentUser() {
  const { state } = useStore()
  return state.employees.find((e) => e.id === state.sessionId) ?? null
}