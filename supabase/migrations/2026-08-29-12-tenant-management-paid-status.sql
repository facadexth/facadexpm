-- supabase/migrations/2026-08-29-12-tenant-management-paid-status.sql
-- Phase 2 of tenant management -- see
-- docs/superpowers/specs/2026-08-29-tenant-management-page-design.md.
-- Manual paid-status tracking: no payment gateway exists, so a platform
-- admin just toggles plan + picks an expiry date by hand. No amount or
-- payment-channel tracking (confirmed with the user) -- tenant_status_log
-- is purely a "who changed what, when" audit trail, not a ledger.

ALTER TABLE tenants ADD COLUMN plan_expires_at TIMESTAMPTZ;

CREATE TABLE tenant_status_log (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  plan             TEXT NOT NULL CHECK (plan IN ('trial','active','expired')),
  plan_expires_at  TIMESTAMPTZ,
  changed_by       TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- No current_tenant_id() scoping on this table (it's platform-admin
-- meta-data about tenants, not tenant-owned data) -- readable directly
-- by any platform admin, same shape as packages/package_modules in
-- Phase 1. No SECURITY DEFINER wrapper needed for reads.
ALTER TABLE tenant_status_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY platform_admin_full_access ON tenant_status_log FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM platform_admins WHERE user_email = auth.email()))
  WITH CHECK (EXISTS (SELECT 1 FROM platform_admins WHERE user_email = auth.email()));

CREATE INDEX idx_tenant_status_log_tenant_id ON tenant_status_log(tenant_id);

-- Writing to `tenants` itself still needs a SECURITY DEFINER function --
-- same reasoning as platform_set_tenant_package in Phase 1: tenants' own
-- RLS is scoped to current_tenant_id() with no platform-admin write
-- policy, so a direct UPDATE from the app would be blocked for everyone.
CREATE FUNCTION platform_set_tenant_status(p_tenant_id UUID, p_plan TEXT, p_plan_expires_at TIMESTAMPTZ)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM platform_admins WHERE user_email = auth.email()) THEN
    RAISE EXCEPTION 'not a platform admin';
  END IF;

  UPDATE tenants SET plan = p_plan, plan_expires_at = p_plan_expires_at WHERE id = p_tenant_id;

  INSERT INTO tenant_status_log (tenant_id, plan, plan_expires_at, changed_by)
  VALUES (p_tenant_id, p_plan, p_plan_expires_at, auth.email());
END;
$$;

REVOKE EXECUTE ON FUNCTION platform_set_tenant_status(UUID, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION platform_set_tenant_status(UUID, TEXT, TIMESTAMPTZ) TO authenticated;

-- platform_list_tenants() needs plan_expires_at now too. CREATE OR
-- REPLACE can't change a function's return columns, so drop first.
DROP FUNCTION platform_list_tenants();

CREATE FUNCTION platform_list_tenants()
RETURNS TABLE (
  id UUID, company_name TEXT, plan TEXT, trial_ends_at TIMESTAMPTZ, plan_expires_at TIMESTAMPTZ,
  package_id UUID, package_name TEXT, created_at TIMESTAMPTZ
)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public
AS $$
  SELECT t.id, t.company_name, t.plan, t.trial_ends_at, t.plan_expires_at, t.package_id, p.name, t.created_at
  FROM tenants t
  LEFT JOIN packages p ON p.id = t.package_id
  WHERE EXISTS (SELECT 1 FROM platform_admins WHERE user_email = auth.email())
  ORDER BY t.company_name;
$$;

REVOKE EXECUTE ON FUNCTION platform_list_tenants() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION platform_list_tenants() TO authenticated;
