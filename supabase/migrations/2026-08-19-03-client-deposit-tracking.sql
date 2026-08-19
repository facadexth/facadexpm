-- Client deposit (มัดจำ) tracking -- see
-- docs/superpowers/specs/2026-08-19-client-deposit-tracking-design.md.
-- A deposit is recorded as a real incomes row (income_type = 'มัดจำ');
-- every subsequent 'ปกติ' row for that site auto-deducts a % of its own
-- pre-VAT amount against the deposit balance until it's exhausted (see
-- src/lib/depositCalc.js). This is a separate money flow from client
-- retention (site_retention_summary) and from the labor subcontractor
-- retention system (contractor_summary) -- neither is touched here.
ALTER TABLE sites ADD COLUMN default_deposit_pct NUMERIC DEFAULT 0;

ALTER TABLE incomes ADD COLUMN income_type TEXT NOT NULL DEFAULT 'ปกติ'
  CHECK (income_type IN ('ปกติ', 'มัดจำ'));
ALTER TABLE incomes ADD COLUMN deposit_deduction NUMERIC DEFAULT 0;

-- security_invoker = true is required on every view in this app -- a view
-- without it runs as its owner (a superuser), bypassing the querying
-- user's RLS entirely. This exact mistake caused a real cross-tenant data
-- leak in sites_progress (see 2026-08-18-01-fix-sites-progress-cross-tenant-leak.sql).
CREATE VIEW site_deposit_summary WITH (security_invoker = true) AS
SELECT
  s.id AS site_id,
  s.site_number,
  s.name,
  s.default_deposit_pct,
  COALESCE(SUM(i.amount_no_vat) FILTER (WHERE i.income_type = 'มัดจำ'), 0) AS total_deposit,
  COALESCE(SUM(i.deposit_deduction), 0)                                    AS total_deducted,
  COALESCE(SUM(i.amount_no_vat) FILTER (WHERE i.income_type = 'มัดจำ'), 0)
    - COALESCE(SUM(i.deposit_deduction), 0)                                AS remaining_balance
FROM sites s
LEFT JOIN incomes i ON i.site_id = s.id
GROUP BY s.id, s.site_number, s.name, s.default_deposit_pct;

-- Widen the module gate to add this paid module, same shape as
-- 2026-08-17-03-purchase-orders-module-key.sql. Not seeding it for any
-- tenant here -- granting access is a separate business decision the
-- user will make later, unlike purchase_orders which had to be seeded
-- immediately for the live FacadeX tenant to avoid locking them out.
ALTER TABLE tenant_modules DROP CONSTRAINT tenant_modules_module_key_check;
ALTER TABLE tenant_modules ADD CONSTRAINT tenant_modules_module_key_check
  CHECK (module_key IN ('payroll','labor_subcontractors','purchase_orders','client_deposits'));
