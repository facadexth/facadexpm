-- supabase/migrations/2026-08-30-05-fix-incomes-view-missing-columns.sql
-- incomes_view was defined as `SELECT i.*, s.name, s.site_number` at
-- creation time, but Postgres freezes a view's output column list at
-- CREATE/REPLACE time -- it does NOT retroactively pick up columns added
-- to the base table afterward via ALTER TABLE. tenant_id, income_type,
-- deposit_deduction, and source_invoice_id were all added to `incomes`
-- later and silently never made it into this view.
--
-- Real-world impact, found live: the Income table's "หักมัดจำ" column
-- always showed "-" regardless of actual deposit deductions (the field
-- was undefined client-side, not just zero) -- for every tenant, since
-- whenever this view was last replaced. Worse: Income.jsx's edit form
-- reads `editRow.income_type` to prefill the ปกติ/มัดจำ selector: editing
-- ANY existing "มัดจำ" row and saving would silently flip it back to
-- "ปกติ", since the field was always undefined -> falls back to the
-- form's default. This was a real data-corruption risk on save, not just
-- a display bug.
--
-- Explicit column list (not i.*) preserving the exact existing output
-- order first, appending the 4 missing columns at the end -- CREATE OR
-- REPLACE VIEW cannot reorder/rename existing output columns.
CREATE OR REPLACE VIEW incomes_view WITH (security_invoker = true) AS
SELECT
  i.id, i.invoice_no, i.date, i.site_id, i.client_name, i.description,
  i.amount_no_vat, i.vat, i.tax_withheld, i.retention, i.received_amount,
  i.created_at, i.updated_at,
  s.name AS site_name, s.site_number,
  i.tenant_id, i.income_type, i.deposit_deduction, i.source_invoice_id
FROM incomes i
LEFT JOIN sites s ON i.site_id = s.id;
