-- Add 'awaiting_billing' to expenses.status allowed values — a manual
-- status for credit/cheque expenses that haven't been billed yet.

ALTER TABLE expenses DROP CONSTRAINT expenses_status_check;
ALTER TABLE expenses ADD CONSTRAINT expenses_status_check
  CHECK (status IN ('awaiting_billing','paid','pending','check_issued','check_cleared'));
