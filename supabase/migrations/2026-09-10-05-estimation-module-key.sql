-- supabase/migrations/2026-09-10-05-estimation-module-key.sql
-- New 'estimation' module: the BOM Template Engine (see
-- docs/superpowers/specs/2026-09-10-bom-template-engine-design.md).
-- Same toggle-per-tenant pattern as every other module. Default tier
-- assignment follows the cheque_tracking precedent -- every paid tier,
-- not Free (business can narrow this later by editing package_modules).
ALTER TABLE tenant_modules DROP CONSTRAINT tenant_modules_module_key_check;
ALTER TABLE tenant_modules ADD CONSTRAINT tenant_modules_module_key_check
  CHECK (module_key IN ('payroll','labor_subcontractors','purchase_orders','client_deposits','quotations','invoices','cheque_tracking','estimation'));

ALTER TABLE package_modules DROP CONSTRAINT package_modules_module_key_check;
ALTER TABLE package_modules ADD CONSTRAINT package_modules_module_key_check
  CHECK (module_key IN ('payroll','labor_subcontractors','purchase_orders','client_deposits','quotations','invoices','cheque_tracking','estimation'));

INSERT INTO package_modules (package_id, module_key)
SELECT id, 'estimation' FROM packages WHERE name IN ('Solo','Pro Team','Business','Enterprise');

INSERT INTO tenant_modules (tenant_id, module_key)
SELECT t.id, 'estimation' FROM tenants t
JOIN package_modules pm ON pm.package_id = t.package_id AND pm.module_key = 'estimation'
ON CONFLICT (tenant_id, module_key) DO NOTHING;
