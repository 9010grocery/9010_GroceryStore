-- =====================================================
-- Schema version 4: finish POS + Inventory, Dashboard from the server (Step 3).
--   * receipt numbers INV-YYYY-NNNNNN from a counter row locked inside the sale transaction
--   * accumulated grand total (BIR): sales only ever add to it; voids and refunds are recorded
--     separately and do NOT reduce it
--   * reprint counter, manual discount percent and grand total snapshot on each receipt
--   * product soft delete
--   * the business TIN / address / receipt prefix / discount threshold settings are guaranteed to exist
-- Written for MySQL 8 and MariaDB 10.4+ (XAMPP).
-- =====================================================

-- One counter row per calendar year; the sale transaction locks it, so two terminals can't
-- take the same number and a rolled-back sale leaves no gap.
CREATE TABLE receipt_counters (
  counter_year INT PRIMARY KEY,
  last_number INT NOT NULL DEFAULT 0,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Accumulated grand total: sales add to accumulated_total. Voids and refunds are tracked in their own
-- columns so the Z-Reading (Step 6) can show them, and accumulated_total never goes down.
ALTER TABLE grand_total
  ADD COLUMN accumulated_voids DECIMAL(14,2) NOT NULL DEFAULT 0 AFTER accumulated_total,
  ADD COLUMN accumulated_refunds DECIMAL(14,2) NOT NULL DEFAULT 0 AFTER accumulated_voids;

INSERT IGNORE INTO grand_total (id, accumulated_total) VALUES (1, 0);

-- Receipts: manual discount percent (regular customers), how many times it was reprinted, and the
-- accumulated grand total right after the sale (for the beginning/ending totals on the Z-Reading).
ALTER TABLE transactions
  ADD COLUMN discount_percent DECIMAL(5,2) NULL AFTER discount_total,
  ADD COLUMN reprint_count INT NOT NULL DEFAULT 0 AFTER void_reason,
  ADD COLUMN grand_total_after DECIMAL(14,2) NULL AFTER reprint_count;

-- Products are never removed (receipts and movements point at them); "deleted" hides them everywhere.
ALTER TABLE products
  ADD COLUMN deleted_at DATETIME NULL AFTER is_active,
  ADD INDEX idx_deleted (deleted_at);

-- Delivery batches are looked up by product + batch number.
ALTER TABLE inventory
  ADD INDEX idx_product_batch (product_id, batch_number);

-- Settings the POS reads. Seeded by seed.sql on new databases; this makes sure older ones have them too.
INSERT IGNORE INTO system_settings (setting_key, setting_value, description) VALUES
  ('business_tin', '', 'BIR TIN'),
  ('business_address', '', 'Business address'),
  ('receipt_prefix', 'INV', 'Receipt number prefix'),
  ('discount_threshold', '20', 'Discount % requiring owner approval');
