-- expenses_view was still using its original explicit column list from
-- before several later migrations added columns to expenses
-- (billing_date/due_date in 2026-07-15-01, amount_no_vat/vat in
-- 2026-08-15-05, tenant_id in the multi-tenant migrations). schema.sql
-- already declares the correct e.*-based view; this recreates it live to
-- match, so those columns are actually queryable through expenses_view.

-- CREATE OR REPLACE VIEW can't be used here: Postgres only allows
-- appending columns via REPLACE, and e.* now emits columns added after
-- the view's original column list (billing_date, due_date, amount_no_vat,
-- vat, tenant_id) in table order, not at the end — so the position of
-- pre-existing columns like site_name would shift. Drop and recreate
-- instead. No other views depend on expenses_view (checked via
-- pg_depend), and Supabase's default privileges re-grant
-- select/insert/update/delete to anon/authenticated/service_role on
-- recreate, matching the view's pre-existing grants.
DROP VIEW expenses_view;

CREATE VIEW expenses_view WITH (security_invoker = true) AS
SELECT
  e.*,
  s.name              AS site_name,
  s.site_number,
  s.status            AS site_status,
  ec.name             AS category_name,
  ec.color            AS category_color,
  sup.name            AS supplier_name,
  sup.supplier_number,
  sup.category        AS supplier_category
FROM expenses e
LEFT JOIN sites s ON e.site_id = s.id
LEFT JOIN expense_categories ec ON e.category_id = ec.id
LEFT JOIN suppliers sup ON e.supplier_id = sup.id;
