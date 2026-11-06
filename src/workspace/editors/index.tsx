import type { ComponentType } from 'react'
import type { WorkspaceName } from '../../data/types'
import { AdminStationPanel } from '../../pages/AdminStation'
import { DashboardPanel } from './Dashboard'
import { DataImportPanel } from './DataImport'
import { BasketPanel, InsightsFeedPanel, SalesHistoryPanel, TrendPanel } from './Insights'
import { InventoryMetrics, InventoryTable } from './Inventory'
import { EmployeesPanel, RequestsPanel, ShiftPanel, WastePanel } from './Operations'
import { CartPanel, ProductGrid } from './PointOfSale'
import { PurchaseOrdersPanel, PurchasingPanel } from './Purchasing'
import { ReportsPanel } from './Reports'
import { SettingsNav, SettingsPanel } from './Settings'
import { ReturnsPanel, TransactionsPanel } from './Transactions'

export const editors = {
  'Admin Station': AdminStationPanel,
  'Data Import': DataImportPanel,
  Dashboard: DashboardPanel,
  'Product Grid': ProductGrid,
  Cart: CartPanel,
  Transactions: TransactionsPanel,
  'Returns & Refunds': ReturnsPanel,
  'Shift & Cash Drawer': ShiftPanel,
  'Inventory Metrics': InventoryMetrics,
  'Inventory Table': InventoryTable,
  Purchasing: PurchasingPanel,
  'Purchase Orders': PurchaseOrdersPanel,
  'Write-off Log': WastePanel,
  'AI Insights': InsightsFeedPanel,
  'Sales History': SalesHistoryPanel,
  'Trend Analysis': TrendPanel,
  'Basket Analysis': BasketPanel,
  'Customer Requests': RequestsPanel,
  Employees: EmployeesPanel,
  Reports: ReportsPanel,
  'Settings Navigation': SettingsNav,
  'Business Settings': SettingsPanel,
} satisfies Record<string, ComponentType>

export type Editor = keyof typeof editors

export const editorGroups: { category: string; items: Editor[] }[] = [
  { category: 'Owner', items: ['Admin Station', 'Employees', 'Data Import'] },
  { category: 'Sales', items: ['Dashboard', 'Product Grid', 'Cart', 'Transactions', 'Returns & Refunds', 'Shift & Cash Drawer'] },
  { category: 'Stock', items: ['Inventory Metrics', 'Inventory Table', 'Purchasing', 'Purchase Orders', 'Write-off Log'] },
  { category: 'AI & Analytics', items: ['AI Insights', 'Sales History', 'Trend Analysis', 'Basket Analysis', 'Reports'] },
  { category: 'Store', items: ['Customer Requests', 'Settings Navigation', 'Business Settings'] },
]

/** Which workspace(s) each editor belongs to. A role can only open an editor if it may open one of these workspaces. */
export const editorWorkspaces: Record<Editor, WorkspaceName[]> = {
  'Admin Station': ['Admin Station'],
  'Data Import': ['Admin Station'],
  Dashboard: ['Dashboard'],
  'Product Grid': ['Point of Sale'],
  Cart: ['Point of Sale'],
  Transactions: ['Transactions'],
  'Returns & Refunds': ['Transactions'],
  'Shift & Cash Drawer': ['Transactions', 'Admin Station'],
  'Inventory Metrics': ['Inventory'],
  'Inventory Table': ['Inventory'],
  Purchasing: ['Purchasing', 'Inventory'],
  'Purchase Orders': ['Purchasing'],
  'Write-off Log': ['Write-offs'],
  'AI Insights': ['AI Insights'],
  'Sales History': ['AI Insights'],
  'Trend Analysis': ['AI Insights'],
  'Basket Analysis': ['AI Insights'],
  'Customer Requests': ['Requests'],
  Employees: ['Admin Station'],
  Reports: ['Reports'],
  'Settings Navigation': ['Settings'],
  'Business Settings': ['Settings'],
}