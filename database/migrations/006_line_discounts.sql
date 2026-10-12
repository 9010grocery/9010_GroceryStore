-- =====================================================
-- Schema version 6: per-item discounts (a cashier discounts only some items of a sale).
--   discount_percent  the cashier's percent off this item (Regular customers), NULL when none
--   net_amount        what the customer paid for this line after every discount, so a refund gives back
--                     exactly that (NULL on receipts made before this version: the old proportional refund applies)
-- Written for MySQL 8 and MariaDB 10.4+ (XAMPP).
-- =====================================================
ALTER TABLE transaction_items
  ADD COLUMN discount_percent DECIMAL(5,2) NULL AFTER subtotal,
  ADD COLUMN net_amount DECIMAL(12,2) NULL AFTER discount_percent;
