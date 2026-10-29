-- =====================================================
-- Schema version 11: Reports (Step 6).
--   * a Z-Reading covers a whole day on every terminal, so readings.session_id may be empty
--   * who generated a reading, how (button or automatic at end of shift), and its running number per type
--   * a day can have only one stored Z-Reading
-- Written for MySQL 8 and MariaDB 10.4+ (XAMPP).
-- =====================================================

ALTER TABLE readings
  MODIFY COLUMN session_id INT NULL,
  ADD COLUMN reading_no INT NOT NULL DEFAULT 0 AFTER reading_type,
  ADD COLUMN generated_by INT NULL AFTER cashier_id,
  ADD COLUMN source VARCHAR(20) NOT NULL DEFAULT 'manual' AFTER generated_by,
  ADD INDEX idx_reading_type_date (reading_type, reading_date);