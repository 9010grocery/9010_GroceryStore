-- =====================================================
-- Schema version 7: markdown on one batch (e.g. the Gardenia bread that expires soon, not the fresh delivery).
--   markdown_percent  percent off the items of THIS batch, set by the owner; NULL = full price.
-- The POS applies it automatically to units taken from that batch (soonest-expiring batch sells first).
-- Written for MySQL 8 and MariaDB 10.4+ (XAMPP).
-- =====================================================
ALTER TABLE inventory ADD COLUMN markdown_percent DECIMAL(5,2) NULL AFTER expiry_date;
