-- supabase/migrations/2026-08-30-07-tenant-downgrade-to-free.sql
-- Self-service function for the tenant-facing UpgradeModal: an admin/owner
-- who explicitly declines the tier picker gets downgraded to Free
-- immediately (per explicit product decision -- decline = auto-downgrade,
-- not a soft no-op). Free is genuinely free forever, so plan='active'
-- with plan_expires_at=NULL, not 'expired' -- matches the existing
-- "Free tier is free forever" design. Mirrors
-- platform_set_tenant_package()'s module-sync exactly, but doesn't
-- require platform_admins membership (unlike that function) since this is
-- a legitimate tenant self-service action, not an admin override.
CREATE OR REPLACE FUNCTION tenant_downgrade_to_free()
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID := current_tenant_id();
  v_free_package_id UUID;
BEGIN
  IF NOT is_admin_or_owner() THEN
    RAISE EXCEPTION 'only an admin/owner can change the tenant package';
  END IF;

  SELECT id INTO v_free_package_id FROM packages WHERE name = 'Free';
  IF v_free_package_id IS NULL THEN
    RAISE EXCEPTION 'Free package not found';
  END IF;

  UPDATE tenants SET package_id = v_free_package_id, plan = 'active', plan_expires_at = NULL
  WHERE id = v_tenant_id;

  DELETE FROM tenant_modules
  WHERE tenant_id = v_tenant_id
    AND module_key NOT IN (SELECT module_key FROM package_modules WHERE package_id = v_free_package_id);

  INSERT INTO tenant_modules (tenant_id, module_key)
  SELECT v_tenant_id, module_key FROM package_modules WHERE package_id = v_free_package_id
  ON CONFLICT (tenant_id, module_key) DO NOTHING;

  INSERT INTO tenant_status_log (tenant_id, plan, plan_expires_at, changed_by)
  VALUES (v_tenant_id, 'active', NULL, auth.email() || ' (self-service downgrade)');
END;
$$;

REVOKE EXECUTE ON FUNCTION tenant_downgrade_to_free() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION tenant_downgrade_to_free() TO authenticated;
