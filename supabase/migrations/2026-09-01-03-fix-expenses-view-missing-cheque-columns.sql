-- supabase/migrations/2026-09-01-03-fix-expenses-view-missing-cheque-columns.sql
-- expenses_view used e.* -- CREATE OR REPLACE VIEW freezes the output
-- column list at (re)creation time and never picks up columns added to
-- the base table afterward, even with e.*. cheque_id (added in
-- 2026-09-01-02-cheque-tracking.sql) was silently missing from every
-- SELECT until this fix -- same class of bug as incomes_view's
-- 2026-08-30-05 fix. Explicit column list, preserving the exact prior
-- order (CREATE OR REPLACE VIEW cannot reorder/rename/remove existing
-- output columns), with cheque_id and the joined cheque_no/bank/status
-- appended at the very end.
CREATE OR REPLACE VIEW expenses_view WITH (security_invoker = true) AS
SELECT
  e.id, e.date, e.description, e.site_id, e.category_id, e.supplier, e.amount,
  e.payment_method, e.check_date, e.status, e.payer, e.invoice_no, e.notes,
  e.is_subcontract, e.created_at, e.updated_at, e.supplier_id, e.billing_date,
  e.due_date, e.amount_no_vat, e.vat, e.tenant_id, e.po_id,
  s.name              AS site_name,
  s.site_number,
  s.status            AS site_status,
  ec.name             AS category_name,
  ec.color            AS category_color,
  sup.name            AS supplier_name,
  sup.supplier_number,
  sup.category        AS supplier_category,
  e.cheque_id,
  c.cheque_no,
  c.bank              AS cheque_bank,
  c.status            AS cheque_status
FROM expenses e
LEFT JOIN sites s ON e.site_id = s.id
LEFT JOIN expense_categories ec ON e.category_id = ec.id
LEFT JOIN suppliers sup ON e.supplier_id = sup.id
LEFT JOIN cheques c ON e.cheque_id = c.id;
