-- Add billing_date / due_date to expenses, for the new "credit" payment
-- method: a credit purchase's due date is anchored to the supplier's
-- billing date (วันวางบิล), not the order date. Mirrors check_date's
-- existing pattern of a plain, directly-editable date column.
ALTER TABLE expenses
  ADD COLUMN IF NOT EXISTS billing_date DATE,
  ADD COLUMN IF NOT EXISTS due_date     DATE;

ALTER TABLE expenses DROP CONSTRAINT expenses_payment_method_check;
ALTER TABLE expenses ADD CONSTRAINT expenses_payment_method_check
  CHECK (payment_method IN ('transfer','check','cash','credit'));
