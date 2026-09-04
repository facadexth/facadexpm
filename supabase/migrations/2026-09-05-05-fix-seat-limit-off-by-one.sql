-- supabase/migrations/2026-09-05-05-fix-seat-limit-off-by-one.sql
-- Real bug, confirmed live: a Free-tier tenant (max_sites=1) with ZERO
-- existing sites could not create their first (and only allowed) site --
-- "Package sites limit exceeded for this tenant", even though 1 is
-- exactly their allowance. Same class of bug affects the last allowed
-- admin (user_roles) and the last allowed worker on any tiered plan, not
-- just sites on Free specifically -- Free's max_sites=1 just makes it
-- maximally visible, since "first" and "last" allowed site are the same
-- seat.
--
-- Root cause: tenant_under_seat_limit(p_kind) is called from two
-- different points in the row's lifecycle with two different correct
-- semantics, but only ever computed one way (v_count < v_limit):
--   1. RLS INSERT policy's WITH CHECK (sites/user_roles/workers'
--      admin_inserts / owner_inserts / admin_writes_workers policies) --
--      evaluated against the row about to be inserted, which doesn't
--      exist yet, so "count of rows BEFORE this one < limit" is the
--      correct gate: creating the tenant's 1st site on a 1-site plan is
--      count=0 < limit=1 -> true -> allowed. Correct as originally
--      written.
--   2. check_seat_limit_after_statement(), an AFTER INSERT/UPDATE
--      statement-level trigger added later specifically to close a
--      batch-insert bypass (sibling rows in one multi-row INSERT can't
--      see each other's pending changes during RLS WITH CHECK, so they
--      could each individually pass a per-row check while collectively
--      exceeding the limit -- see the trigger's own original comment).
--      This fires AFTER the row(s) are already committed and counted, so
--      re-running the SAME "< limit" check here means the newly-inserted
--      row now counts toward v_count too -- creating the tenant's 1st
--      site on a 1-site plan is now count=1 < limit=1 -> FALSE ->
--      rejected. The batch-bypass fix accidentally shrank the real
--      effective cap by one seat for every tiered resource.
--
-- Fix: tenant_under_seat_limit() takes a new p_inclusive flag (default
-- false, preserving the RLS pre-check's existing "<" behavior
-- unchanged) -- the AFTER-statement trigger now passes true, switching
-- to "<=" (count, now including the just-inserted row(s), may legally
-- equal the limit).
--
-- Adding a parameter with CREATE OR REPLACE does NOT replace the old
-- signature in Postgres -- function identity includes parameter types,
-- so tenant_under_seat_limit(text) and tenant_under_seat_limit(text,
-- boolean) are two separate function objects, both left live, only one
-- of them actually fixed. Harmless by accident (exact-arity calls prefer
-- the exact match over one needing a default substituted), but a real
-- future-maintenance trap -- someone changing the fixed one later could
-- easily not notice the stale duplicate is still what 5 RLS policies
-- actually call. This migration drops the old single-arg overload
-- (CASCADE, since 5 policies reference it by exact signature at CREATE
-- POLICY time) and recreates those 5 policies unchanged, so there's
-- exactly one tenant_under_seat_limit() function again.
--
-- Verified live: a Free-tier test tenant with 0 existing sites,
-- tested through a real authenticated session (not a service-role
-- bypass, which would give a false pass regardless of the bug),
-- successfully created its first site after this fix -- confirmed it
-- failed with the exact same "Package sites limit exceeded" error
-- before the fix was applied, isolating this as the actual cause.
-- Confirmed exactly one function overload remains afterward.
DROP FUNCTION IF EXISTS tenant_under_seat_limit(TEXT) CASCADE;
DROP FUNCTION IF EXISTS tenant_under_seat_limit(TEXT, BOOLEAN) CASCADE;

CREATE FUNCTION tenant_under_seat_limit(p_kind TEXT, p_inclusive BOOLEAN DEFAULT false)
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

  RETURN CASE WHEN p_inclusive THEN v_count <= v_limit ELSE v_count < v_limit END;
END;
$$;

REVOKE EXECUTE ON FUNCTION tenant_under_seat_limit(TEXT, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION tenant_under_seat_limit(TEXT, BOOLEAN) TO authenticated;

CREATE OR REPLACE FUNCTION check_seat_limit_after_statement()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_kind TEXT := TG_ARGV[0];
BEGIN
  IF NOT tenant_under_seat_limit(v_kind, true) THEN
    RAISE EXCEPTION 'Package % limit exceeded for this tenant', v_kind
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
REVOKE EXECUTE ON FUNCTION check_seat_limit_after_statement() FROM PUBLIC, anon, authenticated;

CREATE POLICY owner_inserts ON user_roles FOR INSERT TO authenticated
  WITH CHECK (
    is_owner() AND tenant_id = current_tenant_id() AND tenant_can_write()
    AND (role NOT IN ('OWNER','ADMIN') OR tenant_under_seat_limit('admins'))
  );

CREATE POLICY admin_writes_workers ON workers FOR INSERT TO authenticated
  WITH CHECK (
    is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('payroll')
    AND tenant_under_seat_limit('workers')
  );

CREATE POLICY admin_inserts ON sites FOR INSERT TO authenticated
  WITH CHECK (
    is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write()
    AND tenant_under_seat_limit('sites')
  );

CREATE POLICY owner_updates ON user_roles FOR UPDATE TO authenticated
  USING (is_owner() AND tenant_id = current_tenant_id() AND tenant_can_write())
  WITH CHECK (
    is_owner() AND tenant_id = current_tenant_id() AND tenant_can_write()
    AND (
      role NOT IN ('OWNER','ADMIN')
      OR EXISTS (SELECT 1 FROM user_roles old WHERE old.id = user_roles.id AND old.role IN ('OWNER','ADMIN'))
      OR tenant_under_seat_limit('admins')
    )
  );

CREATE POLICY admin_updates ON sites FOR UPDATE TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write())
  WITH CHECK (
    is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write()
    AND (
      status IS DISTINCT FROM 'Ongoing'
      OR EXISTS (SELECT 1 FROM sites old WHERE old.id = sites.id AND old.status = 'Ongoing')
      OR tenant_under_seat_limit('sites')
    )
  );
