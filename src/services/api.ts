import axios, { AxiosError, type AxiosInstance } from 'axios'
import type { CustomerRequest, Employee, PaymentMethod, RequestStatus, Transaction, WasteEntry, WasteReason } from '../data/types'
import type { DesktopConfig } from '../types/desktop'

// One axios instance for the whole UI. The server address comes from the Electron settings
// (never hardcoded); in a plain browser it falls back to VITE_API_BASE_URL or this PC.
const BROWSER_FALLBACK = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? 'http://127.0.0.1:4010'

export const api: AxiosInstance = axios.create({
  timeout: 15_000,
  headers: { 'Content-Type': 'application/json' },
})

let baseUrlReady: Promise<void> | null = null

function ensureBaseUrl(): Promise<void> {
  baseUrlReady ??= (window.desktop ? window.desktop.getConfig().then((c: DesktopConfig) => c.apiBaseUrl) : Promise.resolve(BROWSER_FALLBACK)).then(
    (url) => {
      api.defaults.baseURL = url
    },
  )
  return baseUrlReady
}

// Credentials attached to every request. Set by AuthContext (owner) and TerminalContext (terminal).
let ownerToken: string | null = null
let terminalId: string | null = null
let terminalSessionToken: string | null = null
let onOwnerUnauthorized: (() => void) | null = null

export function setOwnerToken(token: string | null): void {
  ownerToken = token
}
export function setTerminalIdentity(id: string | null): void {
  terminalId = id
}
export function setTerminalSessionToken(token: string | null): void {
  terminalSessionToken = token
}
export function setOnOwnerUnauthorized(handler: (() => void) | null): void {
  onOwnerUnauthorized = handler
}
export const getTerminalSessionToken = () => terminalSessionToken

/** One id per app window, kept across reloads of that window, so the server can tell windows apart on the same PC. */
const windowId: string = (() => {
  const key = 'pos9010.windowId'
  try {
    const existing = sessionStorage.getItem(key)
    if (existing) return existing
    const id = crypto.randomUUID()
    sessionStorage.setItem(key, id)
    return id
  } catch {
    return crypto.randomUUID()
  }
})()

api.interceptors.request.use(async (request) => {
  await ensureBaseUrl()
  request.headers.set('X-Client-Id', windowId)
  request.baseURL = api.defaults.baseURL
  if (ownerToken && !request.headers.has('Authorization')) request.headers.set('Authorization', `Bearer ${ownerToken}`)
  if (terminalId) request.headers.set('X-Terminal-Id', terminalId)
  // A cashier terminal proves which shift it is on; store routes record sales under that session.
  if (terminalSessionToken && !ownerToken) request.headers.set('X-Session-Token', terminalSessionToken)
  return request
})

api.interceptors.response.use(undefined, (error: unknown) => {
  // An expired or revoked owner token signs the owner out everywhere. A wrong owner PIN is also a 401, but it
  // reports attempts_left and must not sign the owner out (e.g. a mistyped PIN when approving a void).
  const wrongPin = error instanceof AxiosError && (error.response?.data as ApiErrorBody | undefined)?.details !== undefined
    && typeof (error.response?.data as { details?: { attempts_left?: unknown } }).details?.attempts_left === 'number'
  if (error instanceof AxiosError && error.response?.status === 401 && !wrongPin && error.config?.headers?.Authorization && ownerToken) onOwnerUnauthorized?.()
  return Promise.reject(error)
})

/** Error shape every API route returns. */
export interface ApiErrorBody {
  error: string
  details?: unknown
}

/** Turns any request failure into a message a cashier or the owner can act on. */
export function apiErrorMessage(error: unknown): string {
  if (error instanceof AxiosError) {
    if (!error.response) return 'Cannot reach the store server. Check the LAN cable and that the server PC is on.'
    const body = error.response.data as Partial<ApiErrorBody> | undefined
    return body?.error ?? `Request failed (${error.response.status})`
  }
  return error instanceof Error ? error.message : String(error)
}

export function apiErrorDetails<T>(error: unknown): T | undefined {
  return error instanceof AxiosError ? ((error.response?.data as Partial<ApiErrorBody> | undefined)?.details as T | undefined) : undefined
}

export const apiStatus = (error: unknown): number | undefined => (error instanceof AxiosError ? error.response?.status : undefined)

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export interface HealthReport {
  status: 'ok' | 'error'
  db: 'connected' | 'disconnected'
  ml: 'available' | 'missing_packages' | 'unavailable'
  version: string
  schema_version: number | null
  uptime_seconds: number
  server_time: string
  errors?: { db?: string; ml?: string }
}

/** A 503 still carries a report (database down), so it is returned instead of thrown. */
export async function getHealth(): Promise<HealthReport> {
  const response = await api.get<HealthReport>('/api/health', { validateStatus: (s) => s === 200 || s === 503 })
  return response.data
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export interface OwnerUser {
  user_id: number
  username: string | null
  name: string
  first_name: string
  last_name: string
  role: 'Owner' | 'Cashier'
  /** Still the default admin (admin / 000000): only Settings → My account works until this is false. */
  must_change_credentials: boolean
}

export const loginOwner = (username: string, pin: string) =>
  api.post<{ token: string; expires_at: string; user: OwnerUser }>('/api/auth/login', { username, pin }).then((r) => r.data)

export const logoutOwner = () => api.post('/api/auth/logout').then(() => undefined)

/** True while the system still has the default admin account, so the sign-in screen can say so. */
export const getAuthStatus = () => api.get<{ first_sign_in: boolean; install_id: string | null }>('/api/auth/status', { timeout: 5_000 }).then((r) => r.data)

export interface AccountChange {
  username: string
  first_name: string
  last_name: string
  current_pin: string
  new_pin?: string
}

/** The signed-in owner's own username, name and PIN (required on the first sign-in). */
export const putAccount = (change: AccountChange) => api.put<OwnerUser>('/api/auth/account', change).then((r) => r.data)

export const getMe = (token: string) => api.get<OwnerUser>('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.data)

export interface OwnerApprovalResult {
  valid: true
  owner_id: number
  owner_name: string
}

/** Checks the owner PIN typed at a terminal for a high-risk action. 401 = wrong PIN, 423 = locked. */
export const verifyOwnerPin = (pin: string, purpose: string) =>
  api.post<OwnerApprovalResult>('/api/auth/verify-owner-pin', { pin, purpose }).then((r) => r.data)

// ---------------------------------------------------------------------------
// Admin Station
// ---------------------------------------------------------------------------

export interface SessionSummary {
  session_id: number
  user_id: number
  cashier_name: string
  terminal_id: string
  assigned_at: string
  login_time: string | null
  assigned_by: number
  is_paused: boolean
  paused_at: string | null
}

export interface TerminalSummary {
  terminal_id: string
  terminal_name: string | null
  ip_address: string | null
  is_active: boolean
  last_seen: string | null
  online: boolean
  session: SessionSummary | null
}

export interface EmployeeSummary {
  user_id: number
  first_name: string
  last_name: string
  name: string
  email: string | null
  phone: string | null
  role: 'Owner' | 'Cashier'
  is_active: boolean
  assigned_terminal: string | null
  session_id: number | null
  assigned_at: string | null
}

export const getAdminTerminals = () => api.get<TerminalSummary[]>('/api/admin/terminals').then((r) => r.data)
export const getAdminEmployees = () => api.get<EmployeeSummary[]>('/api/admin/employees').then((r) => r.data)
export const assignTerminal = (user_id: number, terminal_id: string) => api.post<SessionSummary>('/api/admin/assign', { user_id, terminal_id }).then((r) => r.data)
export const endShift = (session_id: number) => api.post<{ ok: true; session: SessionSummary }>('/api/admin/end-shift', { session_id }).then((r) => r.data)
export const pauseShift = (session_id: number) => api.post<{ ok: true; session: SessionSummary }>('/api/admin/pause-shift', { session_id }).then((r) => r.data)
export const resumeShift = (session_id: number) => api.post<{ ok: true; session: SessionSummary }>('/api/admin/resume-shift', { session_id }).then((r) => r.data)
export const lockAllTerminals = () => api.post<{ ok: true; ended_count: number }>('/api/admin/lock-all').then((r) => r.data)
export const createTerminal = (terminal_id: string, terminal_name: string) =>
  api.post<TerminalSummary>('/api/admin/terminals', { terminal_id, terminal_name }).then((r) => r.data)
export const updateTerminal = (terminal_id: string, changes: { terminal_name?: string; is_active?: boolean }) =>
  api.patch<TerminalSummary>(`/api/admin/terminals/${terminal_id}`, changes).then((r) => r.data)
export const deleteTerminal = (terminal_id: string) => api.delete(`/api/admin/terminals/${terminal_id}`).then(() => undefined)

// ---------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------

export interface TerminalStatus {
  terminal_id: string
  terminal_name: string | null
  assigned: boolean
  is_locked: boolean
  session_id: number | null
  user: { user_id: number; name: string } | null
  assigned_at: string | null
  login_time: string | null
  paused: boolean
  session_token: string | null
  server_time: string
}

export const getTerminalStatus = (id: string) => api.get<TerminalStatus>(`/api/terminal/${id}/status`, { timeout: 5_000 }).then((r) => r.data)
/** The cashier on this terminal locks it (owner resumes) or ends their own shift. */
export const pauseOwnShift = (id: string) => api.post(`/api/terminal/${id}/pause`).then(() => undefined)
export const endOwnShift = (id: string) => api.post(`/api/terminal/${id}/end-shift`).then(() => undefined)
export const sendHeartbeat = (id: string) => api.post(`/api/terminal/${id}/heartbeat`, undefined, { timeout: 5_000 }).then(() => undefined)

// ---------------------------------------------------------------------------
// Store data (MySQL) behind the workspace screens — server/routes/store.routes.ts
// ---------------------------------------------------------------------------

/** A product as the server sends it: the UI's Product without its colour, symbol and supplier id. */
export interface StoreProduct {
  id: string
  sku: string
  barcode: string
  name: string
  category: string
  supplierName: string | null
  unit: string
  price: number
  cost: number
  stock: number
  reorderPoint: number
  leadTimeDays: number
  expiry: string | null
  active: boolean
  seniorPwdEligible: boolean
  /** In-stock batches in the order they sell; markdownPercent 0 = full price. */
  batches: { qty: number; markdownPercent: number }[]
  /** The promo as set by the owner (any dates), and the percent that applies right now (0 outside its dates). */
  promo: { percent: number; start: string; end: string } | null
  promoPercent: number
}

export interface StoreSnapshot {
  products: StoreProduct[]
  transactions: Transaction[]
  history: Record<string, number[]>
  waste: WasteEntry[]
  requests: CustomerRequest[]
  employees: Employee[]
  vatRate: number
  /** Empty until the owner names the store. */
  storeName: string
  /** BIR TIN and registered address printed on receipts; empty until the owner fills them in. */
  storeTin: string
  storeAddress: string
  /** Discount percent a cashier may give without the owner's PIN. */
  discountThreshold: number
  serverTime: string
}

export interface ProductPayload {
  name: string
  sku: string
  barcode: string
  category: string
  supplier_name: string
  unit: string
  price: number
  cost: number
  reorder_point: number
  lead_time_days: number
  stock: number
  expiry: string | null
  active: boolean
  senior_pwd_eligible: boolean
  promo_percent: number | null
  promo_start: string | null
  promo_end: string | null
}

export interface SalePayload {
  /** `discount_percent`: the cashier's discount on that item only (Regular customers). */
  lines: { product_id: string; qty: number; discount_percent?: number }[]
  customer_type: 'Regular' | 'Senior' | 'PWD'
  senior_pwd_id?: string
  senior_pwd_name?: string
  payment_method: PaymentMethod
  amount_received: number
  payment_reference?: string
  /** Above the threshold, `discount_override_id` is the owner's approval for the biggest item discount. */
  discount_percent?: number
  discount_override_id?: number
}

/** Saves the details printed on receipts. Send only the ones that changed. */
export const putStoreSettings = (changes: { store_name?: string; business_tin?: string; business_address?: string }) => api.put('/api/store/settings', changes).then(() => undefined)
export const getStoreSnapshot = () => api.get<StoreSnapshot>('/api/store/snapshot', { timeout: 30_000 }).then((r) => r.data)
export const postSale = (sale: SalePayload) => api.post<Transaction>('/api/store/sales', sale).then((r) => r.data)
export const postVoid = (id: string, owner_pin: string, reason: string) =>
  api.post<{ transaction: Transaction; approved_by: string }>(`/api/store/sales/${id}/void`, { owner_pin, reason }).then((r) => r.data)
export const postRefund = (id: string, owner_pin: string, body: { reason: string; restock: boolean; lines: { product_id: string; qty: number }[] }) =>
  api.post<{ transaction: Transaction; approved_by: string }>(`/api/store/sales/${id}/refunds`, { owner_pin, ...body }).then((r) => r.data)
export const postProduct = (product: ProductPayload) => api.post<StoreProduct>('/api/store/products', product).then((r) => r.data)
export const putProduct = (id: string, product: ProductPayload) => api.put<StoreProduct>(`/api/store/products/${id}`, product).then((r) => r.data)
export const postStockChange = (id: string, delta: number, reason: string) => api.post<StoreProduct>(`/api/store/products/${id}/stock`, { delta, reason }).then((r) => r.data)
export const postWaste = (entry: { product_id: string; qty: number; reason: WasteReason; notes: string }) =>
  api.post<{ entry: WasteEntry; product: StoreProduct }>('/api/store/waste', entry).then((r) => r.data)
export const postRequest = (request: { item: string; category: string; requested_by: string; contact: string; notes: string }) =>
  api.post<CustomerRequest>('/api/store/requests', request).then((r) => r.data)
export const patchRequestStatus = (ids: string[], status: RequestStatus) => api.patch<CustomerRequest[]>('/api/store/requests/status', { ids, status }).then((r) => r.data)
export const postEmployee = (employee: { name: string; email: string; status: Employee['status'] }) => api.post<Employee>('/api/store/employees', employee).then((r) => r.data)
export const putEmployee = (id: string, employee: { name: string; email: string; status: Employee['status'] }) => api.put<Employee>(`/api/store/employees/${id}`, employee).then((r) => r.data)

// ---------------------------------------------------------------------------
// Import from the old system — server/services/import.service.ts
// ---------------------------------------------------------------------------

export type ImportKind = 'products' | 'employees' | 'sales' | 'waste' | 'requests'

export interface ImportResult {
  kind: ImportKind
  dry_run: boolean
  total_rows: number
  inserted: number
  updated: number
  skipped: number
  errors: { row: number; message: string }[]
  notes: string[]
}

export const postImport = (kind: ImportKind, rows: Record<string, unknown>[], dryRun: boolean) =>
  api.post<ImportResult>(`/api/admin/import/${kind}`, { rows, dry_run: dryRun }, { timeout: 300_000 }).then((r) => r.data)

/** Enabled registers (public: used before anyone signs in). */
export interface TerminalChoice {
  terminal_id: string
  terminal_name: string | null
  /** A cashier is assigned there now: the register is taken. */
  on_shift: boolean
  /** Another window is showing this register (e.g. its lock screen), but nobody is assigned. */
  open_elsewhere: boolean
}

export const getTerminalChoices = () => api.get<TerminalChoice[]>('/api/terminal', { timeout: 5_000 }).then((r) => r.data)

// ---------------------------------------------------------------------------
// POS, inventory and dashboard — server/routes/{pos,inventory,dashboard}.routes.ts
// ---------------------------------------------------------------------------

export interface DiscountVerdict {
  requires_approval: boolean
  approved: boolean
  percent: number
  threshold: number
  override_id?: number
  approved_by?: string
  valid_minutes?: number
}

/** Asks whether `percent` off is allowed. Above the store's threshold, send the owner's PIN to get an approval for the sale. */
export const postDiscountVerify = (percent: number, owner_pin?: string, reason?: string) =>
  api.post<DiscountVerdict>('/api/pos/discount/verify', { percent, owner_pin, reason }).then((r) => r.data)

export interface ReceiptData {
  transaction: Transaction
  business: { name: string; tin: string; address: string }
  cashier_name: string
  reprint: boolean
}

/** A receipt for printing. `reprint: true` counts it as a reprint (marked on the copy and logged). */
export const getReceipt = (id: string, reprint = false) => api.get<ReceiptData>(`/api/pos/receipt/${id}`, { params: reprint ? { reprint: 1 } : undefined }).then((r) => r.data)

export interface ReceivePayload {
  product_id: string
  qty: number
  batch_number?: string
  expiry_date?: string | null
  unit_cost?: number | null
  note?: string
}

export const postReceive = (delivery: ReceivePayload) => api.post<StoreProduct>('/api/inventory/receive', delivery).then((r) => r.data)
export interface BatchRow { batchId: string; batchNumber: string | null; expiry: string | null; daysLeft: number | null; qty: number; markdownPercent: number | null }
export const getBatches = (productId: string) => api.get<BatchRow[]>(`/api/inventory/batches/${productId}`).then((r) => r.data)
export const putBatchMarkdown = (batchId: string, percent: number | null) => api.put<{ ok: true }>(`/api/inventory/batches/${batchId}/markdown`, { percent }).then((r) => r.data)
export const putBatchExpiry = (batchId: string, expiry: string | null) => api.put<{ ok: true }>(`/api/inventory/batches/${batchId}/expiry`, { expiry_date: expiry }).then((r) => r.data)
export const deleteStoreProduct = (id: string) => api.delete<{ ok: true; id: string }>(`/api/inventory/products/${id}`).then((r) => r.data)

export interface StockMovement {
  adjustmentId: number
  date: string
  type: 'sale' | 'receive' | 'waste' | 'adjustment' | 'void_return'
  label: string
  change: number
  reason: string
  batchNumber: string | null
  expiry: string | null
  by: string
  reference: number | null
}

export interface MovementsPage {
  productId: string
  name: string
  unit: string
  stock: number
  hasMore: boolean
  movements: StockMovement[]
}

export const getMovements = (productId: string, before?: number) =>
  api.get<MovementsPage>(`/api/inventory/movements/${productId}`, { params: { limit: 25, before } }).then((r) => r.data)

export interface DashboardSummary {
  today: { sales: number; receipts: number; averageBasket: number }
  yesterdaySameTime: { sales: number; receipts: number }
  salesChange: number
  receiptsChange: number
  last7Days: number[]
  topSellers: { productId: string; name: string; units: number; revenue: number }[]
  inventory: { activeProducts: number; outOfStock: number; lowStock: number; needReorder: number; nearExpiryProducts: number; nearExpiryUnits: number; expiryDays: number }
  generatedAt: string
}

export interface DashboardAlerts {
  lowStock: { productId: string; name: string; unit: string; stock: number; reorderPoint: number; shortfall: number; outOfStock: boolean }[]
  expiring: { batchId: string; productId: string; name: string; unit: string; batchNumber: string | null; expiry: string; qty: number; daysLeft: number; expired: boolean }[]
  counts: { outOfStock: number; lowStock: number; expiringBatches: number; expired: number }
  expiryDays: number
}

export interface SalesTrend {
  days: number
  daily: { date: string; sales: number; receipts: number }[]
  hourly: { today: number[]; average6Days: number[] }
}

export const getDashboardSummary = (expiryDays: number) => api.get<DashboardSummary>('/api/dashboard/summary', { params: { expiry_days: expiryDays } }).then((r) => r.data)
export const getDashboardAlerts = (expiryDays: number) => api.get<DashboardAlerts>('/api/dashboard/alerts', { params: { expiry_days: expiryDays } }).then((r) => r.data)
export const getSalesTrend = (days = 7) => api.get<SalesTrend>('/api/dashboard/sales-trend', { params: { days } }).then((r) => r.data)