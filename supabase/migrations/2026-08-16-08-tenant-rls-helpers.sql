-- supabase/migrations/2026-08-16-08-tenant-rls-helpers.sql

CREATE OR REPLACE FUNCTION has_module_access(p_module_key TEXT)
RETURNS BOOLEAN
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT trial_ends_at > now() FROM tenants WHERE id = current_tenant_id())
    OR EXISTS (
      SELECT 1 FROM tenant_modules
      WHERE tenant_id = current_tenant_id() AND module_key = p_module_key
    ),
    false
  );
$$;

-- Spec §4: an expired trial (no active plan) can still READ core data
-- but loses WRITE access until a plan is purchased. Distinct from
-- has_module_access(), which fully blocks reads too — modules and
-- core tables degrade differently by design, not by accident.
CREATE OR REPLACE FUNCTION tenant_can_write()
RETURNS BOOLEAN
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT trial_ends_at > now() OR plan = 'active' FROM tenants WHERE id = current_tenant_id()),
    false
  );
$$;

-- ── tenants: any member of the tenant can read their own tenant row
-- (needed for the trial-countdown banner); only OWNER can update it
-- (plan changes land here once billing ships — sub-project 3, not
-- built yet, but least-privilege now costs nothing). No INSERT/DELETE
-- policy for `authenticated` — rows are only ever created by the
-- SECURITY DEFINER signup trigger (Task 6), which bypasses RLS. ──
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;

CREATE POLICY member_reads_own_tenant ON tenants FOR SELECT TO authenticated
  USING (id = current_tenant_id());

CREATE POLICY owner_updates_own_tenant ON tenants FOR UPDATE TO authenticated
  USING (is_owner() AND id = current_tenant_id())
  WITH CHECK (is_owner() AND id = current_tenant_id());

-- ── tenant_modules: any member can read their tenant's enabled
-- modules (needed by useTenant.js). No write policy for
-- `authenticated` yet — enabling a paid module is a billing-flow
-- action (sub-project 3, not built), so writes stay service-role-only
-- until that ships. ──
ALTER TABLE tenant_modules ENABLE ROW LEVEL SECURITY;

CREATE POLICY member_reads_own_modules ON tenant_modules FOR SELECT TO authenticated
  USING (tenant_id = current_tenant_id());
