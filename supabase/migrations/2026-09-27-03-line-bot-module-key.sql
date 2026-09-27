-- supabase/migrations/2026-09-27-03-line-bot-module-key.sql
-- Widen tenant_modules.module_key to allow 'line_bot', and gate the
-- whole LINE crew-bot surface (CommunicationCenter page + HR's
-- คำขอลา approval tab, see App.jsx/HR.jsx) behind it. Without this,
-- merging this branch to main would put an unfinished LINE-linking
-- card and an always-empty leave-request tab in front of every
-- tenant, not just the one that actually has a LINE bot configured.
-- Same shape as 2026-08-17-03-purchase-orders-module-key.sql.

ALTER TABLE tenant_modules DROP CONSTRAINT tenant_modules_module_key_check;
ALTER TABLE tenant_modules ADD CONSTRAINT tenant_modules_module_key_check
  CHECK (module_key IN ('payroll','labor_subcontractors','purchase_orders','client_deposits','quotations','invoices','cheque_tracking','estimation','offline_mode','line_bot'));

-- Named by id, not company_name -- the earlier purchase_orders-module
-- migration matched on company_name='Facade X', but the tenant has
-- since been renamed (now "บริษัท ฟาซาด เอ๊กซ์ จำกัด"), so that pattern
-- would silently match nothing here.
INSERT INTO tenant_modules (tenant_id, module_key)
VALUES ('1b9affc4-2136-4ed1-b168-a36e6624e743', 'line_bot')
ON CONFLICT (tenant_id, module_key) DO NOTHING;
