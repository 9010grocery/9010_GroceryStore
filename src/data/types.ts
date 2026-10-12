export type Role = 'Owner' | 'Cashier'

export type WorkspaceName =
  | 'Admin Station'
  | 'Dashboard'
  | 'Point of Sale'
  | 'Transactions'
  | 'Inventory'
  | 'Purchasing'
  | 'AI Insights'
  | 'Reports'
  | 'Waste'
  | 'Requests'
  | 'Settings'

export interface Product {
  id: string
  sku: string
  barcode: string
  name: string
  category: string
  unit: string
  price: number // VAT-inclusive shelf price
  cost: number
  stock: number
  reorderPoint: number
  leadTimeDays: number
  supplierId: string
  expiry: string | null // ISO date of the nearest-expiring batch
  color: string
  symbol: string
  active: boolean
  /** Gets the Senior/PWD discount. Undefined (older saved data) counts as yes. */
  seniorPwdEligible?: boolean
  /** In-stock batches in selling order; a markdownPercent above 0 is the owner's discount on that batch. */
  batches?: { qty: number; markdownPercent: number }[]
  /** Owner's promotion: a percent off every unit between two dates (YYYY-MM-DD). */
  promo?: { percent: number; start: string; end: string } | null
  /** The promo percent that applies today (0 when none or outside its dates). Set by the server. */
  promoPercent?: number
}

export interface Supplier {
  id: string
  name: string
  contact: string
  leadTimeDays: number
}

export interface Employee {
  id: string
  name: string
  email: string
  role: Role
  status: 'Active' | 'On leave' | 'Inactive'
  lastActive: string
}

export type PaymentMethod = 'Cash' | 'GCash' | 'Card' | 'Maya'
export type CustomerType = 'Regular' | 'Senior' | 'PWD'

export interface SaleLine {
  productId: string
  name: string
  qty: number
  price: number
  /** Cashier's percent off this item. */
  discountPercent?: number | null
  /** What the customer paid for the line after every discount (refunds give back its share). */
  net?: number | null
}

export interface Refund {
  id: string
  date: string
  lines: { productId: string; qty: number; amount: number }[]
  reason: string
  restocked: boolean
  amount: number
  by: string
}

export interface Transaction {
  id: string
  number: string
  date: string
  cashierId: string
  /** Register the sale was rung up on (PC-00 = the server PC). */
  terminalId?: string
  customerType: CustomerType
  /** Senior Citizen / PWD ID number and name printed on the receipt. */
  seniorPwdId?: string | null
  seniorPwdName?: string | null
  /** Cashier's own discount on a Regular sale, in percent. */
  discountPercent?: number | null
  /** How many times this receipt was reprinted (0 = only the original). */
  reprintCount?: number
  lines: SaleLine[]
  gross: number // sum of shelf prices (VAT inclusive)
  lessVat: number // VAT removed for VAT-exempt (Senior/PWD) sales
  discount: number
  vat: number
  vatExempt: number
  total: number
  payment: { method: PaymentMethod; tendered: number; change: number; reference?: string }
  status: 'Completed' | 'Refunded' | 'Partially refunded' | 'Voided'
  refunds: Refund[]
}

export type WasteReason = 'Expired' | 'Damaged' | 'Spoiled' | 'Theft / Shrink' | 'Customer return' | 'Other'

export interface WasteEntry {
  id: string
  productId: string
  qty: number
  reason: WasteReason
  value: number
  date: string
  by: string
  notes: string
}

export type RequestStatus = 'New' | 'Reviewing' | 'Ordered' | 'Stocked' | 'Declined'

export interface CustomerRequest {
  id: string
  item: string
  category: string
  requestedBy: string
  contact: string
  date: string
  status: RequestStatus
  notes: string
}

export interface PurchaseOrder {
  id: string
  number: string
  supplierId: string
  created: string
  expected: string
  status: 'Draft' | 'Sent' | 'Received' | 'Cancelled'
  lines: { productId: string; qty: number; cost: number }[]
  source: 'AI suggestion' | 'Manual'
}

export interface CashMovement {
  id: string
  date: string
  type: 'Cash in' | 'Cash out'
  amount: number
  reason: string
  by: string
}

export interface Shift {
  id: string
  openedAt: string
  openedBy: string
  openingFloat: number
  movements: CashMovement[]
  closedAt?: string
  countedCash?: number
}

export type ForecastMethod = 'WMA' | 'SES' | 'Holt'

export interface Settings {
  businessName: string
  storeName: string
  tin: string
  storeCode: string
  address: string
  vatRate: number
  receiptHeader: string
  receiptFooter: string
  machineSerial: string
  permitNumber: string
  payments: Record<PaymentMethod, boolean>
  /** Discount percent a cashier may give without the owner's PIN. Set on the server (Settings in Step 8); read-only here. */
  discountThreshold: number
  forecastMethod: ForecastMethod
  wmaWeights: number[]
  sesAlpha: number
  serviceLevel: number // e.g. 0.95
  coverDays: number // target days of stock after lead time
  expiryWarningDays: number
  notifications: Record<'lowStock' | 'expiry' | 'requests' | 'aiDigest' | 'shiftReminder', boolean>
  rolePermissions: Record<Role, WorkspaceName[]>
}

export interface CartLine {
  productId: string
  qty: number
  /** The cashier's discount on this item only (Regular customers). Above the store's threshold it needs the owner's PIN. */
  discountPercent?: number
}

/** A cashier's own discount on the current sale. Above the threshold it carries the owner's PIN approval. */
export interface CartDiscount {
  percent: number
  /** From POST /api/pos/discount/verify; null for a discount within the threshold. */
  overrideId: number | null
  approvedBy: string | null
}

export interface HeldCart {
  id: string
  label: string
  lines: CartLine[]
  customerType: CustomerType
  heldAt: string
}