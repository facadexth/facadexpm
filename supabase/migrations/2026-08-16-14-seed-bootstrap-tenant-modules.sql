-- supabase/migrations/2026-08-16-14-seed-bootstrap-tenant-modules.sql
--
-- Backfills a migration-file record of a live data fix that was applied
-- directly via execute_sql (never captured as a migration): the FacadeX
-- bootstrap tenant created in 2026-08-16-07-tenant-id-backfill.sql has
-- plan='active' but an EXPIRED trial_ends_at, so has_module_access()
-- alone does not grant it payroll/labor_subcontractors — those are paid
-- add-on modules, not something an active plan implies (see the
-- has_module_access() comment added below). Without an explicit
-- tenant_modules row, the real FacadeX company would be locked out of
-- Payroll/HR/Assign and ผู้รับเหมาค่าแรง entirely, both at the RLS layer
-- and in the frontend TABS list.
--
-- Idempotent via ON CONFLICT DO NOTHING (PK is (tenant_id, module_key))
-- so this is safe to apply even though both rows already exist live —
-- replaying all migrations from scratch (disaster recovery, a new
-- environment, a review checkout) now reproduces the current working
-- production state instead of silently locking FacadeX out.
INSERT INTO tenant_modules (tenant_id, module_key)
SELECT id, 'payroll' FROM tenants WHERE company_name = 'Facade X'
UNION ALL
SELECT id, 'labor_subcontractors' FROM tenants WHERE company_name = 'Facade X'
ON CONFLICT (tenant_id, module_key) DO NOTHING;

-- Clarify intent for future readers: plan='active' is a billing/lockout
-- gate (see tenant_can_write()), not a module grant. Modules are paid
-- add-ons layered on top of the base plan — an active plan with no
-- tenant_modules rows and an expired trial has NO module access, by
-- design. A future billing/plan-upgrade flow converting a trial to a
-- paid plan with modules MUST also write the corresponding
-- tenant_modules rows, or it will silently lock out functionality
-- exactly like this bug did.
COMMENT ON FUNCTION has_module_access(TEXT) IS
  'True during an active trial (trial_ends_at > now()) for every module, '
  'regardless of tenant_modules contents. Once the trial ends, true ONLY '
  'for modules explicitly enabled in tenant_modules — plan=''active'' alone '
  'does NOT grant module access; modules are paid add-ons on top of the '
  'base plan, not automatically included when a plan is active. A '
  'billing/plan-upgrade flow that converts a trial to a paid plan with '
  'modules must also INSERT the matching tenant_modules rows.';
