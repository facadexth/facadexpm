-- supabase/migrations/2026-08-17-03-purchase-orders-module-key.sql
-- Widen tenant_modules.module_key to allow 'purchase_orders', and seed
-- the existing FacadeX bootstrap tenant with it. Without this seed, the
-- real company is immediately locked out of this feature on deploy —
-- plan='active' alone does not grant module access (modules are paid
-- add-ons on top of the base plan), and FacadeX's trial already expired.
-- Same bug/fix shape as 2026-08-16-14-seed-bootstrap-tenant-modules.sql.

ALTER TABLE tenant_modules DROP CONSTRAINT tenant_modules_module_key_check;
ALTER TABLE tenant_modules ADD CONSTRAINT tenant_modules_module_key_check
  CHECK (module_key IN ('payroll','labor_subcontractors','purchase_orders'));

INSERT INTO tenant_modules (tenant_id, module_key)
SELECT id, 'purchase_orders' FROM tenants WHERE company_name = 'Facade X'
ON CONFLICT (tenant_id, module_key) DO NOTHING;
