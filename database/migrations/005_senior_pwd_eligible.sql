
ALTER TABLE products
  ADD COLUMN senior_pwd_eligible TINYINT(1) NOT NULL DEFAULT 1 AFTER is_active;