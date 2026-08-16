-- supabase/migrations/2026-08-16-09-tenant-scoped-rls-core.sql
--
-- Adds tenant scoping to the 12 core (non-module) tables' RLS
-- policies. SECURITY NOTE: user_roles' read_all_roles policy today is
-- USING (true) — under multi-tenancy that leaks every tenant's user
-- roster to every authenticated user. Fixed below.
--
-- Reads are tenant-scoped only (an expired trial can still view its
-- own data, per spec §4). Writes are additionally gated by
-- tenant_can_write() — this is why FOR ALL policies are split into
-- 4 single-command policies per table instead of reused.

-- ── Group A: sites, expense_categories, expenses, incomes,
-- app_settings, clients, suppliers, calendar_sync, site_phases ──
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['sites','expense_categories','expenses','incomes','app_settings',
                            'clients','suppliers','calendar_sync','site_phases']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS admin_full_access ON %I', t);
    EXECUTE format($p$CREATE POLICY admin_reads ON %I FOR SELECT TO authenticated
      USING (is_admin_or_owner() AND tenant_id = current_tenant_id())$p$, t);
    EXECUTE format($p$CREATE POLICY admin_inserts ON %I FOR INSERT TO authenticated
      WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write())$p$, t);
    EXECUTE format($p$CREATE POLICY admin_updates ON %I FOR UPDATE TO authenticated
      USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write())
      WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write())$p$, t);
    EXECUTE format($p$CREATE POLICY admin_deletes ON %I FOR DELETE TO authenticated
      USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write())$p$, t);
  END LOOP;
END $$;

-- ── Group B: company_holidays ──
DROP POLICY IF EXISTS staff_reads ON company_holidays;
CREATE POLICY staff_reads ON company_holidays FOR SELECT TO authenticated
  USING (tenant_id = current_tenant_id());

DROP POLICY IF EXISTS admin_writes_holidays ON company_holidays;
CREATE POLICY admin_writes_holidays ON company_holidays FOR INSERT TO authenticated
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write());

DROP POLICY IF EXISTS admin_updates_holidays ON company_holidays;
CREATE POLICY admin_updates_holidays ON company_holidays FOR UPDATE TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write())
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write());

DROP POLICY IF EXISTS admin_deletes_holidays ON company_holidays;
CREATE POLICY admin_deletes_holidays ON company_holidays FOR DELETE TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write());

-- ── Group C: audit_logs ──
DROP POLICY IF EXISTS admin_read ON audit_logs;
CREATE POLICY admin_read ON audit_logs FOR SELECT TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id());

DROP POLICY IF EXISTS system_insert ON audit_logs;
CREATE POLICY system_insert ON audit_logs FOR INSERT TO authenticated
  WITH CHECK (tenant_id = current_tenant_id() AND tenant_can_write());

-- ── Group D: user_roles — SECURITY FIX (see header note) ──
DROP POLICY IF EXISTS read_all_roles ON user_roles;
CREATE POLICY read_all_roles ON user_roles FOR SELECT TO authenticated
  USING (tenant_id = current_tenant_id());

DROP POLICY IF EXISTS owner_inserts ON user_roles;
CREATE POLICY owner_inserts ON user_roles FOR INSERT TO authenticated
  WITH CHECK (is_owner() AND tenant_id = current_tenant_id() AND tenant_can_write());

DROP POLICY IF EXISTS owner_updates ON user_roles;
CREATE POLICY owner_updates ON user_roles FOR UPDATE TO authenticated
  USING (is_owner() AND tenant_id = current_tenant_id() AND tenant_can_write())
  WITH CHECK (is_owner() AND tenant_id = current_tenant_id() AND tenant_can_write());

DROP POLICY IF EXISTS owner_deletes ON user_roles;
CREATE POLICY owner_deletes ON user_roles FOR DELETE TO authenticated
  USING (is_owner() AND tenant_id = current_tenant_id() AND tenant_can_write());
