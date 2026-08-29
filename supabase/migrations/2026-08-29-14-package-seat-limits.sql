-- supabase/migrations/2026-08-29-14-package-seat-limits.sql
-- Seat/site limits per package tier -- the first piece of the "still
-- unbuilt" limits flagged when pricing shipped. Deliberately scoped to
-- just totals (Admins/Workers/Sites), NOT the monthly document-count
-- limits (e.g. "10 ใบเสนอราคา/เดือน") from the external deck -- those are
-- a rolling time-window count, meaningfully harder, left for later.
--
-- "Admin" = user_roles rows with role IN ('OWNER','ADMIN') -- login
-- accounts with elevated access. "Worker" = the `workers` HR/payroll
-- table -- registered field employees, a completely separate concept
-- from a WORKER-role login account (which is uncounted here, per
-- explicit confirmation). "Site" = sites with status='Ongoing' only --
-- completed/cancelled projects don't count against the limit forever.
ALTER TABLE packages ADD COLUMN max_admins  INT; -- NULL = unlimited
ALTER TABLE packages ADD COLUMN max_workers INT;
ALTER TABLE packages ADD COLUMN max_sites   INT;

UPDATE packages SET max_admins = 1,  max_workers = 5,    max_sites = 1  WHERE name = 'Free';
UPDATE packages SET max_admins = 3,  max_workers = 20,   max_sites = 3  WHERE name = 'Solo';
UPDATE packages SET max_admins = 10, max_workers = NULL, max_sites = 10 WHERE name = 'Pro Team';
UPDATE packages SET max_admins = 25, max_workers = NULL, max_sites = NULL WHERE name = 'Business';
UPDATE packages SET max_admins = NULL, max_workers = NULL, max_sites = NULL WHERE name = 'Enterprise';

-- A tenant with no package assigned at all (package_id IS NULL, e.g.
-- still on trial before ever picking one) gets no limit -- the LEFT JOIN
-- below makes v_limit NULL for them, same as an explicitly-unlimited
-- tier. Never retroactively blocks anyone who predates package
-- assignment.
CREATE OR REPLACE FUNCTION tenant_under_seat_limit(p_kind TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID := current_tenant_id();
  v_limit NUMERIC;
  v_count NUMERIC;
BEGIN
  SELECT CASE p_kind
    WHEN 'admins'  THEN p.max_admins
    WHEN 'workers' THEN p.max_workers
    WHEN 'sites'   THEN p.max_sites
  END INTO v_limit
  FROM tenants t
  LEFT JOIN packages p ON p.id = t.package_id
  WHERE t.id = v_tenant_id;

  IF v_limit IS NULL THEN
    RETURN true;
  END IF;

  CASE p_kind
    WHEN 'admins' THEN
      SELECT count(*) INTO v_count FROM user_roles
      WHERE tenant_id = v_tenant_id AND role IN ('OWNER','ADMIN');
    WHEN 'workers' THEN
      SELECT count(*) INTO v_count FROM workers WHERE tenant_id = v_tenant_id;
    WHEN 'sites' THEN
      SELECT count(*) INTO v_count FROM sites
      WHERE tenant_id = v_tenant_id AND status = 'Ongoing';
  END CASE;

  RETURN v_count < v_limit;
END;
$$;

REVOKE EXECUTE ON FUNCTION tenant_under_seat_limit(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION tenant_under_seat_limit(TEXT) TO authenticated;

-- Admin-seat limit only applies when the new row is itself an
-- OWNER/ADMIN invite -- a WORKER-role login account is not an "Admin"
-- for this purpose and stays uncounted, matching the workers-table
-- limit being tracked completely separately below.
DROP POLICY owner_inserts ON user_roles;
CREATE POLICY owner_inserts ON user_roles FOR INSERT TO authenticated
  WITH CHECK (
    is_owner() AND tenant_id = current_tenant_id() AND tenant_can_write()
    AND (role NOT IN ('OWNER','ADMIN') OR tenant_under_seat_limit('admins'))
  );

DROP POLICY admin_writes_workers ON workers;
CREATE POLICY admin_writes_workers ON workers FOR INSERT TO authenticated
  WITH CHECK (
    is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('payroll')
    AND tenant_under_seat_limit('workers')
  );

DROP POLICY admin_inserts ON sites;
CREATE POLICY admin_inserts ON sites FOR INSERT TO authenticated
  WITH CHECK (
    is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write()
    AND tenant_under_seat_limit('sites')
  );
