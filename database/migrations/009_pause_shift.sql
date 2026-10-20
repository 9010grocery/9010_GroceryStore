-- A cashier (or the owner) can pause a shift: the terminal locks but the shift stays open, so nothing is ended
-- and the cashier keeps the same session when the owner resumes it.
ALTER TABLE sessions
  ADD COLUMN is_paused BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN paused_at DATETIME NULL;
