-- Addresses Supabase security advisor findings.
--
-- NOT fixed here, and why: sites_progress remains SECURITY DEFINER
-- (flagged ERROR by the linter) — this is intentional, not an oversight.
-- It's what lets WORKER role read site progress %% without RLS access to
-- the underlying sites/incomes tables. Reviewed and confirmed live during
-- the RLS-worker-view rollout (2026-08-15). Flipping it to
-- security_invoker would silently break the WORKER dashboard again — see
-- 2026-08-15-04-fix-sites-progress-invoker-chain.sql for the prior
-- incident this exact change caused.
--
-- NOT fixable via migration: "Leaked Password Protection Disabled" is a
-- Supabase Auth dashboard toggle (Authentication > Policies), not a DB
-- object — enable it manually.

-- 1. Function search_path mutable (defense-in-depth: a fixed search_path
-- prevents a malicious same-named object in another schema from being
-- resolved instead of the intended public.* one).
ALTER FUNCTION generate_site_number() SET search_path = public;
ALTER FUNCTION generate_invoice_no() SET search_path = public;
ALTER FUNCTION generate_client_number() SET search_path = public;
ALTER FUNCTION generate_supplier_number() SET search_path = public;
ALTER FUNCTION generate_subcontractor_number() SET search_path = public;
ALTER FUNCTION generate_payment_number() SET search_path = public;
ALTER FUNCTION seed_site_phases() SET search_path = public;
ALTER FUNCTION propagate_supplier_payment_method() SET search_path = public;

-- 2. Trigger-only functions exposed on the public RPC surface unintentionally.
-- These are only ever invoked by Postgres's own trigger machinery (which
-- runs as the function owner regardless of EXECUTE grants) — no role needs
-- direct EXECUTE to call them via /rest/v1/rpc/*. Confirmed no frontend
-- code calls .rpc() anywhere in this app.
--
-- Note: `REVOKE ... FROM PUBLIC` alone is not enough on a Supabase project.
-- Supabase's own bootstrap grants EXECUTE directly to anon/authenticated
-- (and re-applies it to new functions via ALTER DEFAULT PRIVILEGES),
-- separately from the PUBLIC pseudo-role — confirmed empirically via
-- has_function_privilege() after an initial FROM-PUBLIC-only revoke had
-- no effect. Must revoke from anon/authenticated explicitly.
REVOKE EXECUTE ON FUNCTION handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION handle_auth_user_deleted() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION handle_user_role_deleted() FROM PUBLIC, anon, authenticated;

-- 3. RLS-helper functions (current_user_role/is_admin_or_owner/is_owner)
-- must stay executable by `authenticated`, since every RLS policy that
-- references them evaluates under the querying role's own privileges.
-- `anon` has no legitimate reason to call these directly — every policy
-- in this schema is scoped `TO authenticated`, so anon queries never
-- trigger these functions via RLS in the first place.
REVOKE EXECUTE ON FUNCTION current_user_role() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION is_admin_or_owner() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION is_owner() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION current_user_role() TO authenticated;
GRANT EXECUTE ON FUNCTION is_admin_or_owner() TO authenticated;
GRANT EXECUTE ON FUNCTION is_owner() TO authenticated;

-- 4. Missing indexes on foreign keys used in routine filters/joins
-- (Suppliers page, Expenses category/supplier filters, sites-by-client).
CREATE INDEX IF NOT EXISTS idx_expenses_category_id ON expenses(category_id);
CREATE INDEX IF NOT EXISTS idx_expenses_supplier_id ON expenses(supplier_id);
CREATE INDEX IF NOT EXISTS idx_site_phases_depends_on ON site_phases(depends_on_phase_id);
CREATE INDEX IF NOT EXISTS idx_sites_client_id ON sites(client_id);

-- 5. RLS policies re-evaluating auth.email() per row instead of once per
-- query. Wrapping in `(select auth.email())` lets the planner treat it as
-- a stable InitPlan instead of re-running for every row scanned — matters
-- once these tables have thousands of rows. is_admin_or_owner() itself is
-- already STABLE with no per-row args, so the planner already hoists it;
-- only the raw auth.email() calls inside these four policies needed this.
DROP POLICY worker_reads_own_profile ON workers;
CREATE POLICY worker_reads_own_profile ON workers FOR SELECT TO authenticated
  USING (is_admin_or_owner() OR email = (select auth.email()));

DROP POLICY worker_reads_own ON worker_assignments;
CREATE POLICY worker_reads_own ON worker_assignments FOR SELECT TO authenticated
  USING (is_admin_or_owner() OR worker_id IN (SELECT id FROM workers WHERE email = (select auth.email())));

DROP POLICY worker_reads_own ON worker_ot;
CREATE POLICY worker_reads_own ON worker_ot FOR SELECT TO authenticated
  USING (is_admin_or_owner() OR worker_id IN (SELECT id FROM workers WHERE email = (select auth.email())));

DROP POLICY worker_reads_own ON salary_records;
CREATE POLICY worker_reads_own ON salary_records FOR SELECT TO authenticated
  USING (is_admin_or_owner() OR worker_id IN (SELECT id FROM workers WHERE email = (select auth.email())));
