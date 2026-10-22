-- =====================================================
-- Schema version 9: purchasing (reorder lists, purchase orders, deliveries).
--   po_counters       one row per year, so purchase order numbers (PO-2026-0001) are never repeated or skipped
--                     by two owners clicking at once (same idea as receipt_counters).
--   purchase_orders.cancel_reason  why an order was cancelled
--   reorder_lists.rejected_reason  why the owner rejected a suggested list
-- Written for MySQL 8 and MariaDB 10.4+ (XAMPP).
-- =====================================================
CREATE TABLE po_counters (
  counter_year INT PRIMARY KEY,
  last_number INT NOT NULL DEFAULT 0,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

ALTER TABLE purchase_orders
  ADD COLUMN cancel_reason VARCHAR(255) NULL AFTER notes,
  ADD INDEX idx_po_status (status),
  ADD INDEX idx_po_created (created_at);

ALTER TABLE reorder_lists
  ADD COLUMN rejected_reason VARCHAR(255) NULL AFTER notes,
  ADD INDEX idx_reorder_status (status);