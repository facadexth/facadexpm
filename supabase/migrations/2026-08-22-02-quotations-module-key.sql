-- supabase/migrations/2026-08-22-02-quotations-module-key.sql
-- Widen the module gate to add the new paid Quotation module, same shape
-- as 2026-08-19-03-client-deposit-tracking.sql. Not seeding it for any
-- tenant here — granting access is a separate business decision the user
-- will make later, same as client_deposits.
ALTER TABLE tenant_modules DROP CONSTRAINT tenant_modules_module_key_check;
ALTER TABLE tenant_modules ADD CONSTRAINT tenant_modules_module_key_check
  CHECK (module_key IN ('payroll','labor_subcontractors','purchase_orders','client_deposits','quotations'));
