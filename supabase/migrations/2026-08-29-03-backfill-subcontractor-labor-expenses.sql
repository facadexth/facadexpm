-- supabase/migrations/2026-08-29-03-backfill-subcontractor-labor-expenses.sql
-- One-time data backfill: 2026-08-29-02 made handleMarkPaid create a real
-- `expenses` row whenever a subcontractor payment is marked paid GOING
-- FORWARD, but every labor_payments row that was already 'paid' before
-- that change shipped has no such row -- so their cost is silently
-- missing from the Expenses page and site_financial_summary. This
-- inserts the missing rows for every already-paid payment, using the
-- exact same shape/formula (gross_amount - retention_amount, category
-- "ค่าแรง", is_subcontract = true, invoice_no = payment_number) so they're
-- indistinguishable from ones the app creates itself.
--
-- Idempotent: only inserts where no expenses row with that invoice_no
-- exists yet (same guard the app-code path uses), so re-running this
-- migration (or it overlapping with app-created rows from a payment
-- someone pays in the UI at the same time) is safe.

-- 1. Ensure "ค่าแรง" exists per tenant that has a paid labor_payment.
INSERT INTO expense_categories (name, tenant_id)
SELECT DISTINCT 'ค่าแรง', lc.tenant_id
FROM labor_payments lp
JOIN labor_contracts lc ON lc.id = lp.contract_id
WHERE lp.status = 'paid'
  AND NOT EXISTS (
    SELECT 1 FROM expense_categories ec WHERE ec.tenant_id = lc.tenant_id AND ec.name = 'ค่าแรง'
  );

-- 2. Insert the missing expense rows.
INSERT INTO expenses (date, description, site_id, category_id, supplier, amount, status, is_subcontract, invoice_no, tenant_id)
SELECT
  COALESCE(lp.paid_date, lp.payment_date),
  'ค่าแรง Sub-contract — ' || ls.name
    || CASE WHEN lp.work_description IS NOT NULL AND lp.work_description <> ''
            THEN ' (' || lp.work_description || ')' ELSE '' END,
  lc.site_id,
  ec.id,
  ls.name,
  ROUND(lp.gross_amount - COALESCE(lp.retention_amount, 0), 2),
  'paid',
  true,
  lp.payment_number,
  lc.tenant_id
FROM labor_payments lp
JOIN labor_contracts lc ON lc.id = lp.contract_id
JOIN labor_subcontractors ls ON ls.id = lc.subcontractor_id
JOIN expense_categories ec ON ec.tenant_id = lc.tenant_id AND ec.name = 'ค่าแรง'
WHERE lp.status = 'paid'
  AND NOT EXISTS (SELECT 1 FROM expenses e WHERE e.invoice_no = lp.payment_number);
