-- Reconstructed from the live database: applied directly on 2026-09-13
-- (migration version 20260913043315, "add_offline_mode_to_tenant_modules_check")
-- via an MCP tool call rather than a committed file, ahead of the
-- worktree-offline-support branch. This file backfills that gap so
-- `supabase/migrations/` matches production history.
--
-- New 'offline_mode' module (see
-- docs/superpowers/specs/2026-09-12-offline-support-design.md). Unlike
-- most modules, this one is NOT added to package_modules -- following the
-- 'estimation' precedent (2026-09-10-10-estimation-rollout-allowlist.sql),
-- it ships allowlist-only via direct tenant_modules grants, so no tenant
-- gets it automatically by package tier while the feature is still new.
ALTER TABLE tenant_modules DROP CONSTRAINT tenant_modules_module_key_check;
ALTER TABLE tenant_modules ADD CONSTRAINT tenant_modules_module_key_check
  CHECK (module_key IN ('payroll','labor_subcontractors','purchase_orders','client_deposits','quotations','invoices','cheque_tracking','estimation','offline_mode'));

INSERT INTO tenant_modules (tenant_id, module_key)
SELECT id, 'offline_mode' FROM tenants WHERE company_name = 'บริษัท ฟาซาด เอ๊กซ์ จำกัด'
ON CONFLICT (tenant_id, module_key) DO NOTHING;
