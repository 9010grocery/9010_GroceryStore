import type { CustomerRequest, Product, PurchaseOrder, Settings, Shift, Transaction, WasteEntry } from './types'

// Configuration the screens need before any store data exists. The data itself (products, sales, people…)
// comes from the store database; with no server reachable the screens start empty.

export const HISTORY_DAYS = 85 // 12 complete weeks of daily sales plus today
export const DETAIL_DAYS = 7 // the most recent days are kept as itemised receipts

// Tile colours for product categories (src/index.css .product-image.*). Other categories use the first colour.
const categoryColor: Record<string, string> = {
  'Rice & Grains': 'rice', Dairy: 'milk', Produce: 'banana', Pantry: 'noodles', Condiments: 'oil', 'Canned Goods': 'canned',
  Bakery: 'bakery', Beverages: 'beverage', Baking: 'rice', 'Meat & Poultry': 'meat', Frozen: 'frozen', Household: 'household', Snacks: 'snack',
}

/** Suggested categories in the product editor, alongside the ones already used by products. */
export const categories = Object.keys(categoryColor)
export const colorForCategory = (category: string) => categoryColor[category] ?? 'rice'

/** Workspaces only the owner can open, whatever the role settings say (SRS 2.3: cashiers have no admin access). */
export const OWNER_ONLY_WORKSPACES: Settings['rolePermissions']['Owner'] = ['Admin Station', 'Settings']

// Tab order. Admin Station comes first for the owner; cashiers never see it.
export const allWorkspaces: Settings['rolePermissions']['Owner'] = ['Admin Station', 'Dashboard', 'Point of Sale', 'Transactions', 'Inventory', 'Waste', 'Purchasing', 'Requests', 'AI Insights', 'Reports', 'Settings']

/** Store details are placeholders until the owner fills them in under Settings → Business profile. */
export const defaultSettings: Settings = {
  businessName: '9010 Grocery Store',
  storeName: '9010 Grocery',
  tin: '',
  storeCode: '',
  address: '',
  vatRate: 0.12,
  receiptHeader: 'Thank you for shopping with us!',
  receiptFooter: 'This serves as your OFFICIAL RECEIPT. Keep for returns within 7 days.',
  machineSerial: '',
  permitNumber: '',
  payments: { Cash: true, GCash: true, Card: true, Maya: true },
  discountThreshold: 20,
  forecastMethod: 'WMA',
  wmaWeights: [0.5, 0.3, 0.2],
  sesAlpha: 0.4,
  serviceLevel: 0.95,
  coverDays: 7,
  expiryWarningDays: 7,
  notifications: { lowStock: true, expiry: true, requests: true, aiDigest: true, shiftReminder: false },
  rolePermissions: {
    Owner: allWorkspaces,
    Cashier: ['Point of Sale', 'Transactions', 'Requests'],
  },
}

export interface StoreData {
  seededOn: string
  products: Product[]
  history: Record<string, number[]> // daily units for days older than DETAIL_DAYS, oldest first
  transactions: Transaction[]
  waste: WasteEntry[]
  requests: CustomerRequest[]
  purchaseOrders: PurchaseOrder[]
  shift: Shift
  nextReceipt: number
}

/** No products, sales or people yet: what the screens show until the store database loads. */
export function emptyStoreData(now = new Date()): StoreData {
  return {
    seededOn: now.toISOString(),
    products: [],
    history: {},
    transactions: [],
    waste: [],
    requests: [],
    purchaseOrders: [],
    shift: { id: `sh${now.getTime().toString(36)}`, openedAt: now.toISOString(), openedBy: '', openingFloat: 0, movements: [] },
    nextReceipt: 1,
  }
}
