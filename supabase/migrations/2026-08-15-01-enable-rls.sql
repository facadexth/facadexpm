-- ================================================================
-- Enable Row Level Security across all 18 currently-unprotected
-- tables, with policies matching the app's own existing role model
-- (OWNER > ADMIN > WORKER, from user_roles + useUserRole.js).
--
-- ⚠️ NOT YET APPLIED. This is a draft for review before running
-- against production — see README §7-8 / the accompanying chat
-- explanation for the reasoning and the open judgment calls.
--
-- Design principle (refined): WORKER gets NO access to financial data
-- at all — no sites, expenses, incomes, expense_categories, app_settings,
-- or the Tier 2/3 admin tables. WORKER's Dashboard instead reads the
-- separate, additive sites_progress view (see the migration for Task 1
-- of the implementation plan, not touched here), which exposes only
-- non-financial progress fields. For workers/worker_assignments/
-- worker_ot/salary_records, WORKER can read ONLY their own row(s)
-- (matched via workers.email = auth.email()), with no write access to
-- any of the three — ADMIN+ owns all writes. WORKER retains read-all
-- access to company_holidays (a shared calendar, not financial data)
-- and user_roles (just email+role pairs, needed for UI pairing lookups
-- and harmless to read). This migration also closes two real gaps the
-- previous draft still had: salary_records (a WORKER could previously
-- query every worker's salary_records row directly via the API even
-- though the UI hid it) and user_roles (a WORKER could previously
-- promote themselves to OWNER directly via the API even though the UI
-- hid that button).
--
-- Apply and verify ONE TABLE AT A TIME, not as a single blind run —
-- see the verification block after each ALTER TABLE. If anything
-- breaks the live app, the instant rollback for that table is:
--   ALTER TABLE <table> DISABLE ROW LEVEL SECURITY;
-- ================================================================

-- ── Helper: current user's role, reusable in every policy below ──
-- SECURITY DEFINER + fixed search_path so it can read user_roles
-- regardless of the calling user's own row-level access to that table.
CREATE OR REPLACE FUNCTION current_user_role()
RETURNS TEXT
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public
AS $$
  SELECT role FROM user_roles WHERE user_email = auth.email();
$$;

CREATE OR REPLACE FUNCTION is_admin_or_owner()
RETURNS BOOLEAN
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public
AS $$
  SELECT COALESCE(current_user_role() IN ('ADMIN','OWNER'), false);
$$;

CREATE OR REPLACE FUNCTION is_owner()
RETURNS BOOLEAN
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public
AS $$
  SELECT COALESCE(current_user_role() = 'OWNER', false);
$$;

-- ── ADMIN+ only: financial base tables (WORKER reads sites_progress
-- view instead — see Task 1/2/3 of the implementation plan) ──
-- sites, expense_categories, expenses, incomes, app_settings
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['sites','expense_categories','expenses','incomes','app_settings']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY admin_full_access ON %I FOR ALL TO authenticated USING (is_admin_or_owner()) WITH CHECK (is_admin_or_owner())', t);
  END LOOP;
END $$;

-- ── company_holidays: any staff member reads; only ADMIN+ writes ──
ALTER TABLE company_holidays ENABLE ROW LEVEL SECURITY;
CREATE POLICY staff_reads ON company_holidays FOR SELECT TO authenticated USING (true);
CREATE POLICY admin_writes_holidays ON company_holidays FOR INSERT TO authenticated WITH CHECK (is_admin_or_owner());
CREATE POLICY admin_updates_holidays ON company_holidays FOR UPDATE TO authenticated USING (is_admin_or_owner()) WITH CHECK (is_admin_or_owner());
CREATE POLICY admin_deletes_holidays ON company_holidays FOR DELETE TO authenticated USING (is_admin_or_owner());

-- ── workers: WORKER reads only their own row; ADMIN+ reads/writes all ──
ALTER TABLE workers ENABLE ROW LEVEL SECURITY;
CREATE POLICY worker_reads_own_profile ON workers FOR SELECT TO authenticated
  USING (is_admin_or_owner() OR email = auth.email());
CREATE POLICY admin_writes_workers ON workers FOR INSERT TO authenticated WITH CHECK (is_admin_or_owner());
CREATE POLICY admin_updates_workers ON workers FOR UPDATE TO authenticated USING (is_admin_or_owner()) WITH CHECK (is_admin_or_owner());
CREATE POLICY admin_deletes_workers ON workers FOR DELETE TO authenticated USING (is_admin_or_owner());

-- ── worker_assignments / worker_ot: WORKER reads only their own rows,
-- cannot self-assign (INSERT/UPDATE/DELETE ADMIN+ only) ──
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['worker_assignments','worker_ot']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY worker_reads_own ON %I FOR SELECT TO authenticated
      USING (is_admin_or_owner() OR worker_id IN (SELECT id FROM workers WHERE email = auth.email()))$p$, t);
    EXECUTE format('CREATE POLICY admin_inserts ON %I FOR INSERT TO authenticated WITH CHECK (is_admin_or_owner())', t);
    EXECUTE format('CREATE POLICY admin_updates ON %I FOR UPDATE TO authenticated USING (is_admin_or_owner()) WITH CHECK (is_admin_or_owner())', t);
    EXECUTE format('CREATE POLICY admin_deletes ON %I FOR DELETE TO authenticated USING (is_admin_or_owner())', t);
  END LOOP;
END $$;

-- ── Tier 2: ADMIN+ only (matches today''s ProtectedPage minRole="ADMIN") ──
-- clients, suppliers, labor_subcontractors, labor_contracts, labor_payments
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['clients','suppliers','labor_subcontractors',
                            'labor_contracts','labor_payments']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY admin_full_access ON %I FOR ALL TO authenticated USING (is_admin_or_owner()) WITH CHECK (is_admin_or_owner())', t);
  END LOOP;
END $$;

-- ── Tier 3: unused-on-main tables, ADMIN+ only until a page needs them ──
-- calendar_sync, site_phases
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['calendar_sync','site_phases']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY admin_full_access ON %I FOR ALL TO authenticated USING (is_admin_or_owner()) WITH CHECK (is_admin_or_owner())', t);
  END LOOP;
END $$;

-- ── audit_logs: ADMIN+ can read (matches today's canEdit-gated tab); nobody edits it by hand ──
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_read ON audit_logs FOR SELECT TO authenticated USING (is_admin_or_owner());
CREATE POLICY system_insert ON audit_logs FOR INSERT TO authenticated WITH CHECK (true);
-- no UPDATE/DELETE policy for anyone — audit log rows are append-only by design

-- ── salary_records: the one real, new restriction ──
-- WORKER reads only their own row (matched via workers.email); ADMIN+ reads/writes all.
ALTER TABLE salary_records ENABLE ROW LEVEL SECURITY;

CREATE POLICY worker_reads_own ON salary_records FOR SELECT TO authenticated
  USING (
    is_admin_or_owner()
    OR worker_id IN (SELECT id FROM workers WHERE email = auth.email())
  );

CREATE POLICY admin_writes ON salary_records FOR INSERT TO authenticated
  WITH CHECK (is_admin_or_owner());
CREATE POLICY admin_updates ON salary_records FOR UPDATE TO authenticated
  USING (is_admin_or_owner()) WITH CHECK (is_admin_or_owner());
CREATE POLICY admin_deletes ON salary_records FOR DELETE TO authenticated
  USING (is_admin_or_owner());

-- ── user_roles: replace the existing "any authenticated user, qual=true"
-- policies with real role checks. This closes the self-promotion gap. ──
DROP POLICY IF EXISTS read_all_roles   ON user_roles;
DROP POLICY IF EXISTS insert_user_role ON user_roles;
DROP POLICY IF EXISTS owner_can_update ON user_roles;
DROP POLICY IF EXISTS owner_can_delete ON user_roles;

-- Everyone can see the role list (needed for e.g. the worker↔login
-- pairing dropdown in HR.jsx's WorkerForm, which ADMIN+ already sees;
-- a WORKER reading it is harmless — it's just email+role pairs, no
-- salary data) but only OWNER can change anyone's role, and the
-- INSERT used by the auto-provisioning trigger below still needs to
-- work for the signup flow (handle_new_user runs as SECURITY DEFINER,
-- so it bypasses RLS entirely — this INSERT policy only governs
-- direct client-side inserts, e.g. UserManagement.jsx's admin-create-user flow).
CREATE POLICY read_all_roles ON user_roles FOR SELECT TO authenticated USING (true);
CREATE POLICY owner_inserts  ON user_roles FOR INSERT TO authenticated WITH CHECK (is_owner());
CREATE POLICY owner_updates  ON user_roles FOR UPDATE TO authenticated USING (is_owner()) WITH CHECK (is_owner());
CREATE POLICY owner_deletes  ON user_roles FOR DELETE TO authenticated USING (is_owner());

-- ================================================================
-- VERIFICATION — run after applying, while logged into the real app
-- as yourself (should still see everything you see today), AND via
-- SQL Editor as a sanity check that anon is now blocked:
--
--   SET ROLE anon;
--   SELECT * FROM sites LIMIT 1;        -- should return 0 rows, not an error
--   SELECT * FROM salary_records LIMIT 1; -- should return 0 rows
--   RESET ROLE;
--
-- If the live app breaks for a logged-in user after applying a given
-- table, roll back just that table instantly:
--   ALTER TABLE <table> DISABLE ROW LEVEL SECURITY;
-- ================================================================
