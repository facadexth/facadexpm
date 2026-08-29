-- supabase/migrations/2026-08-29-16-tenant-seat-status-rpc.sql
-- Read-only seat usage/limits for the caller's own tenant, callable by any
-- authenticated tenant member (not just OWNER/ADMIN) -- lets UserManagement.jsx
-- /HR.jsx/Sites.jsx render a friendly pre-submit warning without exposing the
-- `packages` table itself (which stays platform-admin-only).
CREATE OR REPLACE FUNCTION tenant_seat_status()
RETURNS TABLE(kind TEXT, used BIGINT, max_allowed INT)
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID := current_tenant_id();
  v_max_admins INT;
  v_max_workers INT;
  v_max_sites INT;
BEGIN
  SELECT p.max_admins, p.max_workers, p.max_sites
  INTO v_max_admins, v_max_workers, v_max_sites
  FROM tenants t LEFT JOIN packages p ON p.id = t.package_id
  WHERE t.id = v_tenant_id;

  RETURN QUERY SELECT 'admins'::TEXT,
    (SELECT count(*) FROM user_roles WHERE tenant_id = v_tenant_id AND role IN ('OWNER','ADMIN')), v_max_admins
  UNION ALL SELECT 'workers'::TEXT,
    (SELECT count(*) FROM workers WHERE tenant_id = v_tenant_id), v_max_workers
  UNION ALL SELECT 'sites'::TEXT,
    (SELECT count(*) FROM sites WHERE tenant_id = v_tenant_id AND status = 'Ongoing'), v_max_sites;
END;
$$;

REVOKE EXECUTE ON FUNCTION tenant_seat_status() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION tenant_seat_status() TO authenticated;
