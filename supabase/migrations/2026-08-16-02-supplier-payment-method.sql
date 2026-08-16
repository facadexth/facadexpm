-- Adds a structured default payment method per supplier, replacing the
-- ambiguity of the old free-text payment_terms for this purpose (which
-- stays as-is, unused by this feature).
--
-- Three states requested by the business:
--   1. โอน (เงินสด)              -> default_payment_method='transfer', credit_days=NULL
--   2. จ่ายเช็ค (เครดิต N วัน)     -> default_payment_method='check',    credit_days=N
--   3. มีเครดิต แต่ใช้เป็นโอน (N วัน) -> default_payment_method='transfer', credit_days=N
--
-- credit_days counts from billing_date (วันวางบิล) to due_date
-- (วันครบกำหนด/จ่ายจริง), matching the existing expenses.billing_date /
-- expenses.due_date columns.
ALTER TABLE suppliers ADD COLUMN default_payment_method TEXT DEFAULT 'transfer'
  CHECK (default_payment_method IN ('transfer','check'));
ALTER TABLE suppliers ADD COLUMN credit_days INTEGER; -- NULL = no credit terms (immediate/cash-like)

-- When a supplier's default payment method or credit days changes, propagate
-- to that supplier's still-unpaid expenses only — rows already marked 'paid'
-- are a settled financial record and must not be silently rewritten.
-- billing_date is backfilled from the expense's order date if not already
-- set, then due_date is recomputed from the new credit_days (or cleared if
-- the supplier no longer has credit terms).
CREATE OR REPLACE FUNCTION propagate_supplier_payment_method()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.default_payment_method IS DISTINCT FROM OLD.default_payment_method)
     OR (NEW.credit_days IS DISTINCT FROM OLD.credit_days) THEN
    UPDATE expenses
    SET payment_method = NEW.default_payment_method,
        billing_date = COALESCE(billing_date, date),
        due_date = CASE
          WHEN NEW.credit_days IS NOT NULL THEN COALESCE(billing_date, date) + NEW.credit_days
          ELSE NULL
        END,
        updated_at = NOW()
    WHERE supplier_id = NEW.id
      AND status <> 'paid';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_propagate_supplier_payment_method ON suppliers;
CREATE TRIGGER trg_propagate_supplier_payment_method
AFTER UPDATE ON suppliers
FOR EACH ROW
EXECUTE FUNCTION propagate_supplier_payment_method();
