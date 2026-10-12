ALTER TABLE products
  ADD COLUMN promo_percent DECIMAL(5,2) NULL AFTER senior_pwd_eligible,
  ADD COLUMN promo_start DATE NULL AFTER promo_percent,
  ADD COLUMN promo_end DATE NULL AFTER promo_start;
 