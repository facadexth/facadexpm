# SaaS Multi-Tenancy + Signup Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the single-tenant FacadeX Dashboard into a multi-tenant SaaS product: every table scoped by `tenant_id`, paid add-on modules gated by a `tenant_modules` entitlement table, and a self-serve signup flow that provisions a new tenant with a 14-day free trial (no card required).

**Architecture:** Add `tenants` + `tenant_modules` tables. Add `tenant_id` to all 19 existing RLS-protected tables, defaulted via a `current_tenant_id()` SQL function so existing frontend insert code needs no changes. Rewrite every RLS policy to add tenant scoping on top of the existing role checks, and add a `has_module_access()` gate to the 7 tables that belong to paid modules. A rewritten `handle_new_user()` trigger creates a new tenant (self-serve signup) or joins an existing one (admin-invited teammate), distinguished via `auth.users.raw_user_meta_data`.

**Tech Stack:** Supabase (Postgres + PostgREST + Auth), React 18, Vite. No automated test framework exists in this repo — SQL correctness is verified with disposable-fixture `DO $$` blocks (see `supabase/tests/financial_views_test.sql` for the established pattern); frontend correctness is verified manually against the running dev server (see `docs/superpowers/specs/2026-08-16-saas-multitenancy-signup-design.md` and prior plans in this repo for the same convention).

## Global Constraints

- Design source of truth: `docs/superpowers/specs/2026-08-16-saas-multitenancy-signup-design.md`.
- Tenancy model: 1 user = 1 tenant, resolved via `user_roles.user_email = auth.email()`. No company-switcher.
- Core (always-on, no module check): Dashboard, Sites, Expenses, Income, Clients, Suppliers, Categories.
- Paid modules: `payroll` (workers, worker_assignments, worker_ot, salary_records), `labor_subcontractors` (labor_subcontractors, labor_contracts, labor_payments).
- Trial: 14 days from signup, no credit card, **all modules unlocked** during an active trial.
- Trial expiry (no plan purchased): full block on module-gated tables (not partial read/write split) — matches the spec's RLS design, not a new decision.
- This project applies migrations directly to the live Supabase project (`yyzbgdmgyvvypfcjuhtr`) via `mcp__plugin_supabase_supabase__apply_migration` — there is no local Supabase stack in this repo's established workflow. This plan touches RLS on all 19 production tables containing real FacadeX data (2747 expense rows, 116 sites, etc.) — apply each task's migration individually and verify before moving to the next task, exactly as the original 2026-08-15 RLS rollout did.
- Billing/Stripe and tenant-admin/invites are explicitly out of scope (future specs) — do not build UI for changing `plan` away from `trial`/`active` by hand in this plan beyond what's needed for the bootstrap backfill.

---

## File Structure

**New SQL migrations** (`supabase/migrations/`):
- `2026-08-16-06-tenants-and-modules-tables.sql` — `tenants`, `tenant_modules` tables (Task 1)
- `2026-08-16-07-tenant-id-backfill.sql` — `tenant_id` on all 19 tables + `current_tenant_id()` (Task 2)
- `2026-08-16-08-tenant-rls-helpers.sql` — `has_module_access()` + RLS on `tenants`/`tenant_modules` (Task 3)
- `2026-08-16-09-tenant-scoped-rls-core.sql` — tenant scoping on the 12 core tables (Task 4)
- `2026-08-16-10-tenant-scoped-rls-modules.sql` — tenant + module scoping on the 7 module tables (Task 5)
- `2026-08-16-11-signup-trigger.sql` — rewritten `handle_new_user()` (Task 6)

**New/modified frontend files:**
- Modify: `src/pages/UserManagement.jsx` — pass `invited_tenant_id` on teammate signup (Task 6)
- Create: `src/hooks/useTenant.js` (Task 7)
- Modify: `src/pages/Login.jsx` — add signup mode (Task 8)
- Create: `src/components/TrialBanner.jsx` (Task 9)
- Modify: `src/App.jsx` — module-gated `TABS`, mount `TrialBanner` (Task 9)

**New test file:**
- Create: `supabase/tests/tenant_scoping_test.sql` — disposable-fixture regression tests, appended to across Tasks 2–5, mirroring `supabase/tests/financial_views_test.sql`'s existing style.

**Schema doc:**
- Modify: `supabase/schema.sql` — keep in sync after each SQL task, matching how prior migrations in this session updated it.

---

### Task 1: `tenants` + `tenant_modules` tables

**Files:**
- Create: `supabase/migrations/2026-08-16-06-tenants-and-modules-tables.sql`
- Modify: `supabase/schema.sql` (append table definitions)

**Interfaces:**
- Produces: `tenants(id, company_name, owner_user_id, plan, trial_ends_at, created_at)`, `tenant_modules(tenant_id, module_key, enabled_at)` — consumed by Tasks 2, 3, 5, 6, 7.
- No RLS policies yet on these two tables (added in Task 3, once `current_tenant_id()` exists — see Task 2).

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/2026-08-16-06-tenants-and-modules-tables.sql
--
-- Foundation tables for multi-tenancy. RLS is intentionally NOT added
-- here — current_tenant_id() (needed by any policy on these tables)
-- can't be created until user_roles.tenant_id exists, which happens
-- in the next migration. RLS for these two tables lands in
-- 2026-08-16-08-tenant-rls-helpers.sql.

CREATE TABLE tenants (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_name  TEXT NOT NULL,
  owner_user_id UUID NOT NULL REFERENCES auth.users(id),
  plan          TEXT NOT NULL DEFAULT 'trial' CHECK (plan IN ('trial','active','expired')),
  trial_ends_at TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE tenant_modules (
  tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  module_key TEXT NOT NULL CHECK (module_key IN ('payroll','labor_subcontractors')),
  enabled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, module_key)
);
```

- [ ] **Step 2: Apply the migration**

Use `mcp__plugin_supabase_supabase__apply_migration` with `project_id: yyzbgdmgyvvypfcjuhtr`, `name: tenants_and_modules_tables`, and the SQL from Step 1 as `query`.

- [ ] **Step 3: Verify the tables exist and are empty**

Run via `mcp__plugin_supabase_supabase__execute_sql`:

```sql
SELECT count(*) FROM tenants;
SELECT count(*) FROM tenant_modules;
```

Expected: both return `0`.

- [ ] **Step 4: Update schema.sql**

Append the two `CREATE TABLE` statements from Step 1 to `supabase/schema.sql`, placed near the existing `user_roles` table definition (they're conceptually related — both are identity/access tables).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/2026-08-16-06-tenants-and-modules-tables.sql supabase/schema.sql
git commit -m "feat: add tenants and tenant_modules tables"
```

---

### Task 2: `tenant_id` backfill across all 19 tables + `current_tenant_id()`

**Files:**
- Create: `supabase/migrations/2026-08-16-07-tenant-id-backfill.sql`
- Create: `supabase/tests/tenant_scoping_test.sql`
- Modify: `supabase/schema.sql`

**Interfaces:**
- Consumes: `tenants` table (Task 1).
- Produces: `tenant_id UUID NOT NULL` column (indexed, FK'd to `tenants`) on all 19 tables listed below; `current_tenant_id() RETURNS UUID` — consumed by Tasks 3, 4, 5.

The 19 tables (confirmed via `mcp__plugin_supabase_supabase__list_tables` against the live project): `sites`, `expense_categories`, `expenses`, `incomes`, `app_settings`, `company_holidays`, `workers`, `worker_assignments`, `worker_ot`, `clients`, `suppliers`, `labor_subcontractors`, `labor_contracts`, `labor_payments`, `calendar_sync`, `site_phases`, `audit_logs`, `salary_records`, `user_roles`.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/2026-08-16-07-tenant-id-backfill.sql
--
-- Adds tenant_id to every company-scoped table. Existing FacadeX
-- production data is backfilled into one bootstrap tenant owned by
-- its current OWNER user, with plan='active' (not 'trial' — this is
-- an existing paying customer being migrated, not a new signup).
--
-- Order matters: tenant_id must exist on user_roles BEFORE
-- current_tenant_id() can be created (it selects from user_roles),
-- and current_tenant_id() must exist BEFORE it can be used as a
-- column DEFAULT on the other 18 tables. Hence three passes below.

-- ── Pass 1: bootstrap tenant for existing FacadeX data ──
INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at)
SELECT 'Facade X', au.id, 'active', now() - interval '1 day'
FROM auth.users au
JOIN user_roles ur ON ur.user_email = au.email
WHERE ur.role = 'OWNER'
ORDER BY ur.created_at ASC
LIMIT 1;

-- ── Pass 2: add tenant_id (nullable), backfill, lock down, index ──
DO $$
DECLARE
  t TEXT;
  bootstrap_tenant_id UUID;
BEGIN
  SELECT id INTO bootstrap_tenant_id FROM tenants WHERE company_name = 'Facade X';

  FOREACH t IN ARRAY ARRAY['sites','expense_categories','expenses','incomes','app_settings',
                            'company_holidays','workers','worker_assignments','worker_ot',
                            'clients','suppliers','labor_subcontractors','labor_contracts',
                            'labor_payments','calendar_sync','site_phases','audit_logs',
                            'salary_records','user_roles']
  LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN tenant_id UUID', t);
    EXECUTE format('UPDATE %I SET tenant_id = $1', t) USING bootstrap_tenant_id;
    EXECUTE format('ALTER TABLE %I ALTER COLUMN tenant_id SET NOT NULL', t);
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (tenant_id) REFERENCES tenants(id)',
      t, t || '_tenant_id_fkey');
    EXECUTE format('CREATE INDEX %I ON %I (tenant_id)', 'idx_' || t || '_tenant_id', t);
  END LOOP;
END $$;

-- ── app_settings needs a composite PK now (was a global singleton
-- keyed only by `key`; each tenant needs its own travel_rate_per_km
-- etc.) ──
ALTER TABLE app_settings DROP CONSTRAINT app_settings_pkey;
ALTER TABLE app_settings ADD PRIMARY KEY (tenant_id, key);

-- ── Pass 3: current_tenant_id(), now that user_roles.tenant_id
-- exists, then set it as DEFAULT on the 18 tables where a new row's
-- tenant should always be the inserting user's own tenant. user_roles
-- itself is excluded: a brand-new signup has no user_roles row yet,
-- so current_tenant_id() would resolve to NULL at exactly the moment
-- the signup trigger needs to create that first row — it must set
-- tenant_id explicitly instead (see Task 6). ──
CREATE OR REPLACE FUNCTION current_tenant_id()
RETURNS UUID
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public
AS $$
  SELECT tenant_id FROM user_roles WHERE user_email = auth.email();
$$;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['sites','expense_categories','expenses','incomes','app_settings',
                            'company_holidays','workers','worker_assignments','worker_ot',
                            'clients','suppliers','labor_subcontractors','labor_contracts',
                            'labor_payments','calendar_sync','site_phases','audit_logs',
                            'salary_records']
  LOOP
    EXECUTE format('ALTER TABLE %I ALTER COLUMN tenant_id SET DEFAULT current_tenant_id()', t);
  END LOOP;
END $$;
```

- [ ] **Step 2: Apply the migration**

Use `mcp__plugin_supabase_supabase__apply_migration` with `name: tenant_id_backfill` and the SQL from Step 1.

- [ ] **Step 3: Verify backfill correctness**

Run via `execute_sql`:

```sql
SELECT
  (SELECT count(*) FROM tenants) AS tenant_count,
  (SELECT count(*) FROM sites WHERE tenant_id IS NULL) AS sites_null,
  (SELECT count(*) FROM expenses WHERE tenant_id IS NULL) AS expenses_null,
  (SELECT count(*) FROM user_roles WHERE tenant_id IS NULL) AS roles_null,
  (SELECT count(DISTINCT tenant_id) FROM expenses) AS expenses_distinct_tenants;
```

Expected: `tenant_count=1`, all `*_null` columns `0`, `expenses_distinct_tenants=1`.

- [ ] **Step 4: Write and run the fixture test**

Create `supabase/tests/tenant_scoping_test.sql`:

```sql
-- ================================================================
-- Regression tests for multi-tenancy: tenant_id backfill, defaults,
-- current_tenant_id() resolution, and (once later tasks land) RLS
-- isolation between tenants and module-gated access.
--
-- Disposable-fixture style, matching supabase/tests/financial_views_test.sql
-- — safe to run against production, self-cleans on every path.
-- ================================================================

-- ── Test 1: current_tenant_id() resolves per-session via
-- user_roles.user_email = auth.email(), and DEFAULT current_tenant_id()
-- on a table auto-fills the inserting user's own tenant. ──
DO $$
DECLARE
  test_tenant_id UUID;
  test_owner_id UUID;
  resolved_tenant_id UUID;
  inserted_site_tenant_id UUID;
  test_site_id UUID;
BEGIN
  -- tenants.owner_user_id is NOT NULL REFERENCES auth.users(id), so a
  -- fabricated gen_random_uuid() would violate the FK. Borrow a real
  -- user's id instead — owner_user_id has no uniqueness constraint, so
  -- this has no side effects on that user's own data.
  SELECT id INTO test_owner_id FROM auth.users ORDER BY created_at ASC LIMIT 1;

  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at)
  VALUES ('__TEST TENANT scoping__', test_owner_id, 'trial', now() + interval '14 days')
  RETURNING id INTO test_tenant_id;

  INSERT INTO user_roles (user_email, role, status, tenant_id)
  VALUES ('__test_tenant_scoping__@example.com', 'OWNER', 'approved', test_tenant_id);

  SET LOCAL role = 'authenticated';
  SET LOCAL request.jwt.claims = '{"email":"__test_tenant_scoping__@example.com"}';

  SELECT current_tenant_id() INTO resolved_tenant_id;
  IF resolved_tenant_id != test_tenant_id THEN
    RAISE EXCEPTION 'current_tenant_id() REGRESSION: expected %, got %', test_tenant_id, resolved_tenant_id;
  END IF;

  INSERT INTO sites (site_number, name) VALUES ('__TEST-TS-001__', '__TEST SITE tenant default__')
  RETURNING id, tenant_id INTO test_site_id, inserted_site_tenant_id;

  IF inserted_site_tenant_id != test_tenant_id THEN
    RAISE EXCEPTION 'DEFAULT current_tenant_id() REGRESSION: expected %, got %', test_tenant_id, inserted_site_tenant_id;
  END IF;

  RESET role;
  DELETE FROM sites WHERE id = test_site_id;
  DELETE FROM user_roles WHERE user_email = '__test_tenant_scoping__@example.com';
  DELETE FROM tenants WHERE id = test_tenant_id;

  RAISE NOTICE 'Test 1 (current_tenant_id + DEFAULT): TEST PASSED';
END $$;
```

Run the whole file via `execute_sql`.

Expected: `NOTICE: Test 1 (current_tenant_id + DEFAULT): TEST PASSED`, no `ERROR`.

- [ ] **Step 5: Update schema.sql**

Add `tenant_id` columns (with `DEFAULT current_tenant_id()` where applicable) to each of the 19 table definitions in `supabase/schema.sql`, add the `current_tenant_id()` function definition near the existing `current_user_role()` definition, and update `app_settings`'s primary key to `(tenant_id, key)`.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/2026-08-16-07-tenant-id-backfill.sql supabase/tests/tenant_scoping_test.sql supabase/schema.sql
git commit -m "feat: backfill tenant_id across all tables, add current_tenant_id()"
```

---

### Task 3: `has_module_access()` + RLS on `tenants`/`tenant_modules`

**Files:**
- Create: `supabase/migrations/2026-08-16-08-tenant-rls-helpers.sql`
- Modify: `supabase/tests/tenant_scoping_test.sql` (append Test 2)
- Modify: `supabase/schema.sql`

**Interfaces:**
- Consumes: `current_tenant_id()`, `tenants`, `tenant_modules` (Tasks 1, 2).
- Produces: `has_module_access(p_module_key TEXT) RETURNS BOOLEAN` — consumed by Task 5. `tenant_can_write() RETURNS BOOLEAN` — consumed by Task 4 (per spec §4: trial-expired tenants keep read access to core tables but lose write access until they're on an active plan). RLS policies on `tenants`/`tenant_modules` — consumed by `useTenant.js` (Task 7), which reads both tables directly.

- [ ] **Step 1: Write the migration**

```sql
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
```

- [ ] **Step 2: Apply the migration**

Use `mcp__plugin_supabase_supabase__apply_migration` with `name: tenant_rls_helpers` and the SQL from Step 1.

- [ ] **Step 3: Append and run the fixture test**

Append to `supabase/tests/tenant_scoping_test.sql`:

```sql
-- ── Test 2: has_module_access() — true during an active trial
-- regardless of tenant_modules contents, true when the module is
-- explicitly enabled post-trial, false otherwise. Also confirms
-- tenants/tenant_modules RLS lets a member read only their own
-- tenant's rows. ──
DO $$
DECLARE
  trial_tenant_id UUID;
  expired_tenant_id UUID;
  real_user_id UUID;
  result BOOLEAN;
  visible_count INT;
BEGIN
  -- tenants.owner_user_id is NOT NULL REFERENCES auth.users(id) — a
  -- fabricated gen_random_uuid() violates the FK. Borrow one real user's
  -- id for both test tenants (owner_user_id has no uniqueness constraint).
  SELECT id INTO real_user_id FROM auth.users ORDER BY created_at ASC LIMIT 1;

  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at)
  VALUES ('__TEST TENANT trial__', real_user_id, 'trial', now() + interval '14 days')
  RETURNING id INTO trial_tenant_id;

  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at)
  VALUES ('__TEST TENANT expired__', real_user_id, 'expired', now() - interval '1 day')
  RETURNING id INTO expired_tenant_id;

  INSERT INTO tenant_modules (tenant_id, module_key) VALUES (expired_tenant_id, 'payroll');

  INSERT INTO user_roles (user_email, role, status, tenant_id) VALUES
    ('__test_trial__@example.com', 'OWNER', 'approved', trial_tenant_id),
    ('__test_expired__@example.com', 'OWNER', 'approved', expired_tenant_id);

  -- Active trial: every module unlocked, including one never purchased.
  SET LOCAL role = 'authenticated';
  SET LOCAL request.jwt.claims = '{"email":"__test_trial__@example.com"}';
  SELECT has_module_access('labor_subcontractors') INTO result;
  IF NOT result THEN
    RAISE EXCEPTION 'has_module_access() REGRESSION: trial tenant should have all-module access, got false';
  END IF;

  SELECT count(*) INTO visible_count FROM tenants;
  IF visible_count != 1 THEN
    RAISE EXCEPTION 'tenants RLS REGRESSION: expected 1 visible tenant row, got %', visible_count;
  END IF;
  RESET role;

  -- Expired, module purchased: access granted for that module only.
  SET LOCAL role = 'authenticated';
  SET LOCAL request.jwt.claims = '{"email":"__test_expired__@example.com"}';
  SELECT has_module_access('payroll') INTO result;
  IF NOT result THEN
    RAISE EXCEPTION 'has_module_access() REGRESSION: expired tenant with payroll purchased should have access, got false';
  END IF;

  SELECT has_module_access('labor_subcontractors') INTO result;
  IF result THEN
    RAISE EXCEPTION 'has_module_access() REGRESSION: expired tenant without labor_subcontractors should NOT have access, got true';
  END IF;
  RESET role;

  DELETE FROM user_roles WHERE user_email IN ('__test_trial__@example.com', '__test_expired__@example.com');
  DELETE FROM tenant_modules WHERE tenant_id = expired_tenant_id;
  DELETE FROM tenants WHERE id IN (trial_tenant_id, expired_tenant_id);

  RAISE NOTICE 'Test 2 (has_module_access + tenants/tenant_modules RLS): TEST PASSED';
END $$;
```

Run the whole file via `execute_sql`.

Expected: both `TEST PASSED` notices, no `ERROR`.

- [ ] **Step 4: Update schema.sql**

Add `has_module_access()` and the `tenants`/`tenant_modules` RLS policies to `supabase/schema.sql`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/2026-08-16-08-tenant-rls-helpers.sql supabase/tests/tenant_scoping_test.sql supabase/schema.sql
git commit -m "feat: add has_module_access() and RLS for tenants/tenant_modules"
```

---

### Task 4: Tenant-scope RLS on the 12 core tables

**Files:**
- Create: `supabase/migrations/2026-08-16-09-tenant-scoped-rls-core.sql`
- Modify: `supabase/tests/tenant_scoping_test.sql` (append Test 3)
- Modify: `supabase/schema.sql`

**Interfaces:**
- Consumes: `current_tenant_id()`, `tenant_can_write()`, `is_admin_or_owner()`, `is_owner()` (existing / Task 3).
- Produces: no new interface — rewrites existing policies in place.

Core tables split into 4 groups by existing policy shape (see `supabase/migrations/2026-08-15-01-enable-rls.sql`): **Group A** (9 tables, single `admin_full_access`): `sites`, `expense_categories`, `expenses`, `incomes`, `app_settings`, `clients`, `suppliers`, `calendar_sync`, `site_phases`. **Group B** (`company_holidays`: staff read + admin write). **Group C** (`audit_logs`: admin read + system insert). **Group D** (`user_roles`: read-all + owner write — **this migration fixes a real cross-tenant data leak**: today's `read_all_roles` policy is `USING (true)`, so any authenticated user of ANY tenant can currently read every other tenant's email+role roster once multi-tenancy is live).

Per spec §4, reads stay open regardless of plan state (an expired trial can still view its data), but every write (INSERT/UPDATE/DELETE) additionally requires `tenant_can_write()` — this is why each group below has 4 separate single-command policies instead of one `FOR ALL` policy: `FOR ALL` can't apply a stricter check to writes than reads.

- [ ] **Step 1: Write the migration**

```sql
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
```

- [ ] **Step 2: Apply the migration**

Use `mcp__plugin_supabase_supabase__apply_migration` with `name: tenant_scoped_rls_core` and the SQL from Step 1.

- [ ] **Step 3: Log into the live app as the real FacadeX OWNER and confirm nothing broke**

Open the deployed app (or `npm run dev` locally), log in, and check: Dashboard loads with correct totals, Sites/Expenses/Income/Clients/Suppliers/Categories all list their existing rows, HR's holiday calendar still shows. This table set was already ADMIN-only or staff-readable before this task — this step only confirms the added `tenant_id = current_tenant_id()` clause doesn't accidentally hide the bootstrap tenant's own data from itself.

- [ ] **Step 4: Append and run the fixture test — cross-tenant isolation**

Append to `supabase/tests/tenant_scoping_test.sql`:

```sql
-- ── Test 3: a user in tenant A cannot see tenant B's core-table rows
-- (sites, and user_roles' post-fix scoping) even though both rows
-- pass the pre-existing role check. ──
DO $$
DECLARE
  tenant_a UUID;
  tenant_b UUID;
  real_user_id UUID;
  site_a UUID;
  site_b UUID;
  visible_sites INT;
  visible_roles INT;
BEGIN
  -- tenants.owner_user_id is NOT NULL REFERENCES auth.users(id) — a
  -- fabricated gen_random_uuid() violates the FK. Borrow one real user's
  -- id for both test tenants (owner_user_id has no uniqueness constraint).
  SELECT id INTO real_user_id FROM auth.users ORDER BY created_at ASC LIMIT 1;

  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at)
  VALUES ('__TEST TENANT A__', real_user_id, 'active', now() + interval '365 days')
  RETURNING id INTO tenant_a;
  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at)
  VALUES ('__TEST TENANT B__', real_user_id, 'active', now() + interval '365 days')
  RETURNING id INTO tenant_b;

  INSERT INTO user_roles (user_email, role, status, tenant_id) VALUES
    ('__test_iso_a__@example.com', 'ADMIN', 'approved', tenant_a),
    ('__test_iso_b__@example.com', 'ADMIN', 'approved', tenant_b);

  INSERT INTO sites (site_number, name, tenant_id) VALUES ('__TEST-ISO-A__', '__TEST SITE A__', tenant_a)
    RETURNING id INTO site_a;
  INSERT INTO sites (site_number, name, tenant_id) VALUES ('__TEST-ISO-B__', '__TEST SITE B__', tenant_b)
    RETURNING id INTO site_b;

  SET LOCAL role = 'authenticated';
  SET LOCAL request.jwt.claims = '{"email":"__test_iso_a__@example.com"}';

  SELECT count(*) INTO visible_sites FROM sites WHERE id IN (site_a, site_b);
  IF visible_sites != 1 THEN
    RAISE EXCEPTION 'sites RLS cross-tenant REGRESSION: tenant A should see exactly 1 of 2 test sites, got %', visible_sites;
  END IF;

  SELECT count(*) INTO visible_roles FROM user_roles
  WHERE user_email IN ('__test_iso_a__@example.com', '__test_iso_b__@example.com');
  IF visible_roles != 1 THEN
    RAISE EXCEPTION 'user_roles RLS cross-tenant REGRESSION: tenant A should see exactly 1 of 2 test users, got %', visible_roles;
  END IF;

  RESET role;
  DELETE FROM sites WHERE id IN (site_a, site_b);
  DELETE FROM user_roles WHERE user_email IN ('__test_iso_a__@example.com', '__test_iso_b__@example.com');
  DELETE FROM tenants WHERE id IN (tenant_a, tenant_b);

  RAISE NOTICE 'Test 3 (core-table cross-tenant isolation): TEST PASSED';
END $$;

-- ── Test 4: tenant_can_write() — an expired-trial tenant on no plan
-- can still SELECT its own core-table rows, but INSERT/UPDATE/DELETE
-- are rejected (spec §4: read-only lockout, not a full block). ──
DO $$
DECLARE
  tenant_id_expired UUID;
  real_user_id UUID;
  site_row_id UUID;
  visible_sites INT;
  insert_failed BOOLEAN := false;
BEGIN
  -- tenants.owner_user_id is NOT NULL REFERENCES auth.users(id) — a
  -- fabricated gen_random_uuid() violates the FK. Borrow a real user's id.
  SELECT id INTO real_user_id FROM auth.users ORDER BY created_at ASC LIMIT 1;

  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at)
  VALUES ('__TEST TENANT expired writes__', real_user_id, 'expired', now() - interval '1 day')
  RETURNING id INTO tenant_id_expired;

  INSERT INTO user_roles (user_email, role, status, tenant_id)
  VALUES ('__test_expired_writes__@example.com', 'OWNER', 'approved', tenant_id_expired);

  INSERT INTO sites (site_number, name, tenant_id)
  VALUES ('__TEST-EW-001__', '__TEST SITE expired writes__', tenant_id_expired)
  RETURNING id INTO site_row_id;

  SET LOCAL role = 'authenticated';
  SET LOCAL request.jwt.claims = '{"email":"__test_expired_writes__@example.com"}';

  -- Read must still succeed.
  SELECT count(*) INTO visible_sites FROM sites WHERE id = site_row_id;
  IF visible_sites != 1 THEN
    RAISE EXCEPTION 'tenant_can_write() REGRESSION: expired tenant should still be able to READ its own sites row, got % visible', visible_sites;
  END IF;

  -- Write must fail. RLS violations raise an error rather than
  -- silently no-op, so this uses an exception handler to convert
  -- "it correctly failed" into a passing assertion.
  BEGIN
    UPDATE sites SET name = '__TEST SITE should not update__' WHERE id = site_row_id;
  EXCEPTION WHEN OTHERS THEN
    insert_failed := true;
  END;

  IF NOT insert_failed THEN
    RAISE EXCEPTION 'tenant_can_write() REGRESSION: expired tenant should NOT be able to UPDATE sites, but the update succeeded';
  END IF;

  RESET role;
  DELETE FROM sites WHERE id = site_row_id;
  DELETE FROM user_roles WHERE user_email = '__test_expired_writes__@example.com';
  DELETE FROM tenants WHERE id = tenant_id_expired;

  RAISE NOTICE 'Test 4 (tenant_can_write core read-only lockout): TEST PASSED';
END $$;
```

Run the whole file via `execute_sql`. Expected: four `TEST PASSED` notices, no `ERROR`.

- [ ] **Step 5: Update schema.sql**

Update the policy definitions for the 12 core tables in `supabase/schema.sql` to match.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/2026-08-16-09-tenant-scoped-rls-core.sql supabase/tests/tenant_scoping_test.sql supabase/schema.sql
git commit -m "feat: tenant-scope RLS on core tables, fix user_roles cross-tenant leak"
```

---

### Task 5: Tenant + module scoping on the 7 module-gated tables

**Files:**
- Create: `supabase/migrations/2026-08-16-10-tenant-scoped-rls-modules.sql`
- Modify: `supabase/tests/tenant_scoping_test.sql` (append Test 4)
- Modify: `supabase/schema.sql`

**Interfaces:**
- Consumes: `current_tenant_id()`, `has_module_access()` (Tasks 2, 3).
- Produces: no new interface — rewrites existing policies in place.

`payroll` module tables: `workers` (read-own shape), `worker_assignments`/`worker_ot` (looped, read-own shape), `salary_records` (read-own shape). `labor_subcontractors` module tables: `labor_subcontractors`, `labor_contracts`, `labor_payments` (looped, `admin_full_access` shape).

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/2026-08-16-10-tenant-scoped-rls-modules.sql

-- ── workers (payroll module) ──
DROP POLICY IF EXISTS worker_reads_own_profile ON workers;
CREATE POLICY worker_reads_own_profile ON workers FOR SELECT TO authenticated
  USING (
    tenant_id = current_tenant_id() AND has_module_access('payroll')
    AND (is_admin_or_owner() OR email = auth.email())
  );

DROP POLICY IF EXISTS admin_writes_workers ON workers;
CREATE POLICY admin_writes_workers ON workers FOR INSERT TO authenticated
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('payroll'));

DROP POLICY IF EXISTS admin_updates_workers ON workers;
CREATE POLICY admin_updates_workers ON workers FOR UPDATE TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('payroll'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('payroll'));

DROP POLICY IF EXISTS admin_deletes_workers ON workers;
CREATE POLICY admin_deletes_workers ON workers FOR DELETE TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('payroll'));

-- ── worker_assignments, worker_ot (payroll module) ──
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['worker_assignments','worker_ot']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS worker_reads_own ON %I', t);
    EXECUTE format($p$CREATE POLICY worker_reads_own ON %I FOR SELECT TO authenticated
      USING (
        tenant_id = current_tenant_id() AND has_module_access('payroll')
        AND (is_admin_or_owner() OR worker_id IN (SELECT id FROM workers WHERE email = auth.email()))
      )$p$, t);
    EXECUTE format('DROP POLICY IF EXISTS admin_inserts ON %I', t);
    EXECUTE format($p$CREATE POLICY admin_inserts ON %I FOR INSERT TO authenticated
      WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('payroll'))$p$, t);
    EXECUTE format('DROP POLICY IF EXISTS admin_updates ON %I', t);
    EXECUTE format($p$CREATE POLICY admin_updates ON %I FOR UPDATE TO authenticated
      USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('payroll'))
      WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('payroll'))$p$, t);
    EXECUTE format('DROP POLICY IF EXISTS admin_deletes ON %I', t);
    EXECUTE format($p$CREATE POLICY admin_deletes ON %I FOR DELETE TO authenticated
      USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('payroll'))$p$, t);
  END LOOP;
END $$;

-- ── salary_records (payroll module) ──
DROP POLICY IF EXISTS worker_reads_own ON salary_records;
CREATE POLICY worker_reads_own ON salary_records FOR SELECT TO authenticated
  USING (
    tenant_id = current_tenant_id() AND has_module_access('payroll')
    AND (is_admin_or_owner() OR worker_id IN (SELECT id FROM workers WHERE email = auth.email()))
  );

DROP POLICY IF EXISTS admin_writes ON salary_records;
CREATE POLICY admin_writes ON salary_records FOR INSERT TO authenticated
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('payroll'));

DROP POLICY IF EXISTS admin_updates ON salary_records;
CREATE POLICY admin_updates ON salary_records FOR UPDATE TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('payroll'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('payroll'));

DROP POLICY IF EXISTS admin_deletes ON salary_records;
CREATE POLICY admin_deletes ON salary_records FOR DELETE TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('payroll'));

-- ── labor_subcontractors, labor_contracts, labor_payments (labor_subcontractors module) ──
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['labor_subcontractors','labor_contracts','labor_payments']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS admin_full_access ON %I', t);
    EXECUTE format($p$CREATE POLICY admin_full_access ON %I FOR ALL TO authenticated
      USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('labor_subcontractors'))
      WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('labor_subcontractors'))$p$, t);
  END LOOP;
END $$;
```

- [ ] **Step 2: Apply the migration**

Use `mcp__plugin_supabase_supabase__apply_migration` with `name: tenant_scoped_rls_modules` and the SQL from Step 1.

- [ ] **Step 3: Confirm the bootstrap tenant still has access**

The bootstrap tenant (FacadeX) was backfilled with `plan='active'` and `trial_ends_at` in the past (Task 2, Pass 1) — it has **no** rows in `tenant_modules`, so `has_module_access()` for it currently evaluates via the trial branch (`trial_ends_at > now()`), which is `false` for the bootstrap tenant. This would incorrectly lock FacadeX out of Payroll/HR and Labor Subcontractors, which it uses today. Run via `execute_sql`:

```sql
INSERT INTO tenant_modules (tenant_id, module_key)
SELECT id, 'payroll' FROM tenants WHERE company_name = 'Facade X'
UNION ALL
SELECT id, 'labor_subcontractors' FROM tenants WHERE company_name = 'Facade X';
```

Then log into the live app as the real OWNER and confirm the HR tab, Assign tab, and ผู้รับเหมาค่าแรง tab all still load their existing data.

- [ ] **Step 4: Append and run the fixture test — module gate**

Append to `supabase/tests/tenant_scoping_test.sql`:

```sql
-- ── Test 5: workers table (payroll module) blocks a tenant with an
-- expired trial and no payroll purchase, even for an ADMIN who passes
-- every other check. ──
DO $$
DECLARE
  tenant_id_expired UUID;
  real_user_id UUID;
  worker_row_id UUID;
  visible_workers INT;
BEGIN
  -- tenants.owner_user_id is NOT NULL REFERENCES auth.users(id) — a
  -- fabricated gen_random_uuid() violates the FK. Borrow a real user's id.
  SELECT id INTO real_user_id FROM auth.users ORDER BY created_at ASC LIMIT 1;

  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at)
  VALUES ('__TEST TENANT no payroll__', real_user_id, 'expired', now() - interval '1 day')
  RETURNING id INTO tenant_id_expired;

  INSERT INTO user_roles (user_email, role, status, tenant_id)
  VALUES ('__test_no_payroll__@example.com', 'ADMIN', 'approved', tenant_id_expired);

  INSERT INTO workers (name, monthly_salary, tenant_id)
  VALUES ('__TEST WORKER blocked__', 20000, tenant_id_expired)
  RETURNING id INTO worker_row_id;

  SET LOCAL role = 'authenticated';
  SET LOCAL request.jwt.claims = '{"email":"__test_no_payroll__@example.com"}';

  SELECT count(*) INTO visible_workers FROM workers WHERE id = worker_row_id;
  IF visible_workers != 0 THEN
    RAISE EXCEPTION 'workers module-gate REGRESSION: expired tenant without payroll module should see 0 rows, got %', visible_workers;
  END IF;

  RESET role;
  DELETE FROM workers WHERE id = worker_row_id;
  DELETE FROM user_roles WHERE user_email = '__test_no_payroll__@example.com';
  DELETE FROM tenants WHERE id = tenant_id_expired;

  RAISE NOTICE 'Test 5 (module-gated RLS blocks unpaid module): TEST PASSED';
END $$;
```

Run the whole file via `execute_sql`. Expected: five `TEST PASSED` notices, no `ERROR`.

- [ ] **Step 5: Update schema.sql**

Update the policy definitions for the 7 module tables in `supabase/schema.sql`.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/2026-08-16-10-tenant-scoped-rls-modules.sql supabase/tests/tenant_scoping_test.sql supabase/schema.sql
git commit -m "feat: tenant + module-gate RLS on payroll and labor_subcontractors tables"
```

---

### Task 6: Signup trigger — new tenant vs. invited teammate

**Files:**
- Create: `supabase/migrations/2026-08-16-11-signup-trigger.sql`
- Modify: `src/pages/UserManagement.jsx:92-96` (signUp call)
- Modify: `supabase/schema.sql`

**Interfaces:**
- Consumes: `tenants` (Task 1), `handle_new_user()`'s existing trigger wiring (`on_auth_user_created`, unchanged — only the function body is replaced).
- Produces: signup behavior consumed by Task 8 (Login.jsx signup UI must pass `company_name` in `options.data`).

Today, `supabase.auth.signUp()` is called from two places: (1) not yet built self-serve signup (Task 8 adds it), and (2) `UserManagement.jsx`'s "create teammate" flow, which currently gets a default `WORKER` role from the trigger and then immediately overwrites it via a client-side `upsert`. Both paths fire the same `handle_new_user()` trigger on `auth.users` insert — it must distinguish them via `raw_user_meta_data`.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/2026-08-16-11-signup-trigger.sql
--
-- Two signup paths now share this trigger:
--   1. Self-serve company signup (Login.jsx signup mode, Task 8) —
--      raw_user_meta_data has NO invited_tenant_id → create a new
--      tenant with a 14-day trial, caller becomes its OWNER.
--   2. Admin-invited teammate (UserManagement.jsx) — passes
--      invited_tenant_id in auth.signUp's options.data → joins that
--      existing tenant as WORKER (UserManagement.jsx's own follow-up
--      upsert then sets the actually-chosen role, same as today).
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_tenant_id UUID;
  v_invited_tenant_id UUID;
BEGIN
  v_invited_tenant_id := (new.raw_user_meta_data->>'invited_tenant_id')::UUID;

  IF v_invited_tenant_id IS NOT NULL THEN
    v_tenant_id := v_invited_tenant_id;
  ELSE
    INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at)
    VALUES (
      COALESCE(new.raw_user_meta_data->>'company_name', new.email),
      new.id, 'trial', now() + interval '14 days'
    )
    RETURNING id INTO v_tenant_id;
  END IF;

  INSERT INTO public.user_roles (user_email, role, status, tenant_id)
  VALUES (
    new.email,
    CASE WHEN v_invited_tenant_id IS NULL THEN 'OWNER' ELSE 'WORKER' END,
    'approved',
    v_tenant_id
  )
  ON CONFLICT (user_email) DO NOTHING;

  RETURN new;
END;
$$;
```

- [ ] **Step 2: Apply the migration**

Use `mcp__plugin_supabase_supabase__apply_migration` with `name: signup_trigger_tenant_aware` and the SQL from Step 1.

- [ ] **Step 3: Update UserManagement.jsx to pass invited_tenant_id**

Read the file first to confirm current line numbers, then apply this change to the `handleSave` function's "Create mode" branch:

```javascript
        // Create auth user, tagged with our own tenant so the trigger
        // joins them to it instead of spinning up a new one
        const { data: { session } } = await supabase.auth.getSession()
        const { data: ownRole } = await supabase
          .from('user_roles')
          .select('tenant_id')
          .eq('user_email', session.user.email)
          .single()

        const { data, error: authError } = await supabase.auth.signUp({
          email: form.email,
          password: form.password,
          options: { data: { invited_tenant_id: ownRole.tenant_id } }
        })
```

This replaces the existing plain `supabase.auth.signUp({ email: form.email, password: form.password })` call. The rest of the function (the follow-up `upsert` that sets the chosen role) is unchanged.

- [ ] **Step 4: Manual verification**

Run `npm run dev`, log in as the real OWNER, go to ผู้ใช้งาน (User Management), create a test teammate account. Verify via `execute_sql`:

```sql
SELECT ur.user_email, ur.role, ur.tenant_id, t.company_name
FROM user_roles ur JOIN tenants t ON t.id = ur.tenant_id
WHERE ur.user_email = '<the test email you used>';
```

Expected: `tenant_id` matches the real OWNER's own tenant (`company_name = 'Facade X'`), not a newly-created one. Delete the test row afterward: `DELETE FROM user_roles WHERE user_email = '<test email>';` (this also requires deleting the corresponding `auth.users` row via the Supabase dashboard's Auth panel, since `handle_auth_user_deleted` only fires the other direction).

- [ ] **Step 5: Update schema.sql**

Replace the `handle_new_user()` definition in `supabase/schema.sql` with the new version from Step 1.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/2026-08-16-11-signup-trigger.sql src/pages/UserManagement.jsx supabase/schema.sql
git commit -m "feat: make signup trigger tenant-aware (new company vs. invited teammate)"
```

---

### Task 7: `useTenant.js` hook

**Files:**
- Create: `src/hooks/useTenant.js`

**Interfaces:**
- Consumes: `tenants`/`tenant_modules` tables via Supabase client (RLS from Task 3 scopes results automatically), `user_roles.tenant_id` (Task 2).
- Produces: `useTenant()` returning `{ tenant, enabledModules, loading, isTrialActive, trialDaysRemaining, hasModuleAccess }` — consumed by Task 9 (`App.jsx`, `TrialBanner.jsx`).

- [ ] **Step 1: Write the hook**

```javascript
// ============================================================
// useTenant — fetch current user's tenant + enabled modules
// Returns: { tenant, enabledModules, loading, isTrialActive, trialDaysRemaining, hasModuleAccess }
// ============================================================
import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase.js'

export function useTenant() {
  const [tenant, setTenant] = useState(null)
  const [enabledModules, setEnabledModules] = useState([])
  const [loading, setLoading] = useState(true)

  const fetchTenant = useCallback(async () => {
    setLoading(true)
    const { data: { session } } = await supabase.auth.getSession()

    if (!session?.user) {
      setTenant(null)
      setEnabledModules([])
      setLoading(false)
      return
    }

    const { data: roleRow } = await supabase
      .from('user_roles')
      .select('tenant_id')
      .eq('user_email', session.user.email)
      .single()

    if (!roleRow?.tenant_id) {
      setTenant(null)
      setEnabledModules([])
      setLoading(false)
      return
    }

    const [{ data: tenantRow }, { data: moduleRows }] = await Promise.all([
      supabase.from('tenants').select('*').eq('id', roleRow.tenant_id).single(),
      supabase.from('tenant_modules').select('module_key').eq('tenant_id', roleRow.tenant_id),
    ])

    setTenant(tenantRow ?? null)
    setEnabledModules((moduleRows || []).map(r => r.module_key))
    setLoading(false)
  }, [])

  useEffect(() => {
    fetchTenant()
    const { data: { subscription } } = supabase.auth.onAuthStateChange(() => {
      fetchTenant()
    })
    return () => subscription.unsubscribe()
  }, [fetchTenant])

  const isTrialActive = tenant ? new Date(tenant.trial_ends_at) > new Date() : false

  const trialDaysRemaining = tenant
    ? Math.max(0, Math.ceil((new Date(tenant.trial_ends_at) - new Date()) / 86400000))
    : 0

  /**
   * moduleKey === null/undefined means a core feature — always accessible.
   */
  const hasModuleAccess = (moduleKey) => {
    if (!moduleKey) return true
    if (isTrialActive) return true
    return enabledModules.includes(moduleKey)
  }

  return { tenant, enabledModules, loading, isTrialActive, trialDaysRemaining, hasModuleAccess }
}
```

- [ ] **Step 2: Manual verification**

Add a temporary `console.log` call inside `App.jsx` (removed in Task 9's real integration) is unnecessary — instead, verify directly from the browser console after `npm run dev` + logging in:

```javascript
// paste in browser devtools console, on the running app
import('/src/hooks/useTenant.js')
```

This import-probe approach is unreliable for hooks (they need a component). Skip the standalone probe — this hook has no independently-testable output until it's wired into a component in Task 9. Defer verification of its actual data to Task 9, Step 3.

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useTenant.js
git commit -m "feat: add useTenant hook for tenant/module entitlement lookups"
```

---

### Task 8: Signup UI in Login.jsx

**Files:**
- Modify: `src/pages/Login.jsx` (full rewrite of the component body)

**Interfaces:**
- Consumes: `supabase.auth.signUp()` (Supabase client), the `handle_new_user()` trigger's `company_name` metadata field (Task 6).
- Produces: no new interface — this is a leaf UI component.

- [ ] **Step 1: Rewrite Login.jsx with a signup mode**

```javascript
// ============================================================
// Login — Supabase Auth (email + password), with a signup mode for
// self-serve new-company trial signup
// ============================================================
import { useState } from 'react'
import { supabase } from '../lib/supabase.js'

export default function Login() {
  const [mode,     setMode]     = useState('login') // 'login' | 'signup'
  const [companyName, setCompanyName] = useState('')
  const [email,    setEmail]    = useState('')
  const [password, setPassword] = useState('')
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState(null)
  const [signupDone, setSignupDone] = useState(false)

  const handleLogin = async (e) => {
    e.preventDefault()
    setLoading(true)
    setError(null)
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) setError(error.message)
    setLoading(false)
  }

  const handleSignup = async (e) => {
    e.preventDefault()
    setLoading(true)
    setError(null)
    const { error } = await supabase.auth.signUp({
      email, password,
      options: { data: { company_name: companyName } }
    })
    if (error) {
      setError(error.message)
      setLoading(false)
      return
    }
    setSignupDone(true)
    setLoading(false)
  }

  const switchMode = (next) => {
    setMode(next)
    setError(null)
    setSignupDone(false)
  }

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--bg)', padding: 24
    }}>
      <div style={{
        background: 'var(--bg2)', border: '1px solid var(--border)',
        borderRadius: 12, padding: '40px 36px', width: '100%', maxWidth: 380,
        boxShadow: '0 8px 32px rgba(0,0,0,0.3)'
      }}>
        {/* Logo */}
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div style={{ fontSize: 26, fontWeight: 800, color: 'var(--accent)', letterSpacing: 2, marginBottom: 6 }}>
            FACADE X
          </div>
          <div style={{ fontSize: 12, color: 'var(--text3)', letterSpacing: 1 }}>
            Construction Dashboard
          </div>
        </div>

        {signupDone ? (
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 14, color: 'var(--text)', marginBottom: 20, lineHeight: 1.6 }}>
              ✅ สร้างบัญชีสำเร็จ! ทดลองใช้ฟรี 14 วัน<br />เข้าสู่ระบบด้วยอีเมล/รหัสผ่านที่ตั้งไว้ได้เลย
            </div>
            <button
              type="button" className="btn btn-primary"
              style={{ height: 44, fontSize: 14, fontWeight: 700, width: '100%' }}
              onClick={() => switchMode('login')}
            >
              เข้าสู่ระบบ
            </button>
          </div>
        ) : (
          <form onSubmit={mode === 'login' ? handleLogin : handleSignup} style={{ display: 'grid', gap: 16 }}>
            {mode === 'signup' && (
              <div>
                <label className="label">ชื่อบริษัท</label>
                <input
                  type="text" className="input" required autoFocus
                  value={companyName} onChange={e => setCompanyName(e.target.value)}
                  placeholder="บริษัท ตัวอย่าง จำกัด"
                />
              </div>
            )}
            <div>
              <label className="label">อีเมล</label>
              <input
                type="email" className="input" required autoFocus={mode === 'login'}
                value={email} onChange={e => setEmail(e.target.value)}
                placeholder="your@email.com"
              />
            </div>
            <div>
              <label className="label">รหัสผ่าน</label>
              <input
                type="password" className="input" required minLength={6}
                value={password} onChange={e => setPassword(e.target.value)}
                placeholder="••••••••"
              />
            </div>

            {error && (
              <div style={{
                background: 'rgba(255,107,107,0.1)', border: '1px solid rgba(255,107,107,0.3)',
                borderRadius: 6, padding: '10px 14px', fontSize: 13, color: 'var(--red)'
              }}>
                {error === 'Invalid login credentials'
                  ? 'อีเมลหรือรหัสผ่านไม่ถูกต้อง'
                  : error}
              </div>
            )}

            <button
              type="submit" className="btn btn-primary"
              disabled={loading}
              style={{ marginTop: 4, height: 44, fontSize: 14, fontWeight: 700 }}
            >
              {loading
                ? '⏳ กำลังดำเนินการ...'
                : mode === 'login' ? 'เข้าสู่ระบบ' : 'เริ่มทดลองใช้ฟรี 14 วัน'}
            </button>
          </form>
        )}

        {!signupDone && (
          <div style={{ marginTop: 24, textAlign: 'center', fontSize: 12, color: 'var(--text3)' }}>
            {mode === 'login' ? (
              <>ยังไม่มีบัญชี? <a href="#" onClick={e => { e.preventDefault(); switchMode('signup') }} style={{ color: 'var(--accent)' }}>สร้างบัญชีใหม่ฟรี</a></>
            ) : (
              <>มีบัญชีอยู่แล้ว? <a href="#" onClick={e => { e.preventDefault(); switchMode('login') }} style={{ color: 'var(--accent)' }}>เข้าสู่ระบบ</a></>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Manual verification**

Run `npm run dev`, open the app while logged out. Confirm: (a) default view is the login form with a "สร้างบัญชีใหม่ฟรี" link; (b) clicking it switches to signup mode showing a company-name field; (c) submitting signup with a fresh test email shows the "สร้างบัญชีสำเร็จ" success screen; (d) clicking "เข้าสู่ระบบ" from there switches back to login mode; (e) logging in with that new email/password succeeds and lands in the app.

Verify the new tenant was created correctly via `execute_sql`:

```sql
SELECT t.company_name, t.plan, t.trial_ends_at, ur.role
FROM tenants t JOIN user_roles ur ON ur.tenant_id = t.id
WHERE ur.user_email = '<the test email you used>';
```

Expected: one row, `plan='trial'`, `trial_ends_at` ~14 days out, `role='OWNER'`. Clean up: delete the `user_roles` row, the `tenants` row, and the `auth.users` row (via Supabase dashboard Auth panel) for the test email.

- [ ] **Step 3: Commit**

```bash
git add src/pages/Login.jsx
git commit -m "feat: add self-serve signup mode to Login page"
```

---

### Task 9: Module-gated tabs + trial banner in App.jsx

**Files:**
- Create: `src/components/TrialBanner.jsx`
- Modify: `src/App.jsx`

**Interfaces:**
- Consumes: `useTenant()` (Task 7).
- Produces: no new interface — this is the top-level wiring task.

- [ ] **Step 1: Write TrialBanner.jsx**

```javascript
// ============================================================
// TrialBanner — shows trial countdown, or an expired-trial notice
// ============================================================
export default function TrialBanner({ tenant, isTrialActive, trialDaysRemaining }) {
  if (!tenant) return null

  if (isTrialActive) {
    return (
      <div style={{
        background: 'rgba(74,158,255,0.12)', borderBottom: '1px solid rgba(74,158,255,0.3)',
        padding: '8px 24px', fontSize: 13, color: 'var(--accent)', textAlign: 'center'
      }}>
        🎉 ทดลองใช้ฟรี เหลืออีก {trialDaysRemaining} วัน — ใช้งานได้ทุกฟีเจอร์ระหว่างทดลองใช้
      </div>
    )
  }

  if (tenant.plan !== 'active') {
    return (
      <div style={{
        background: 'rgba(255,107,107,0.12)', borderBottom: '1px solid rgba(255,107,107,0.3)',
        padding: '8px 24px', fontSize: 13, color: 'var(--red)', textAlign: 'center'
      }}>
        ⚠️ หมดระยะทดลองใช้แล้ว — ติดต่อเราเพื่ออัปเกรดแพ็กเกจและใช้งานต่อ
      </div>
    )
  }

  return null
}
```

- [ ] **Step 2: Wire module gating and the banner into App.jsx**

Modify `src/App.jsx`. First, add the import and hook call, and give each tab its `module` (`null` for core tabs):

```javascript
import { useTenant } from './hooks/useTenant.js'
import TrialBanner from './components/TrialBanner.jsx'

const TABS = [
  { id: 'dashboard',         label: '📊 ภาพรวม',              minRole: 'WORKER', module: null },
  { id: 'assign',            label: '📋 Assign ช่าง',          minRole: 'WORKER', module: 'payroll' },
  { id: 'hr',                label: '👷 HR',                   minRole: 'WORKER', module: 'payroll' },
  { id: 'sites',             label: '🏗️ ไซท์งาน',            minRole: 'ADMIN',  module: null },
  { id: 'expenses',          label: '💸 รายจ่าย',              minRole: 'ADMIN',  module: null },
  { id: 'income',            label: '💰 รายรับ',               minRole: 'ADMIN',  module: null },
  { id: 'categories',        label: '🏷️ หมวดหมู่',            minRole: 'ADMIN',  module: null },
  { id: 'clients',           label: '🏢 ลูกค้า',              minRole: 'ADMIN',  module: null },
  { id: 'suppliers',         label: '🏭 Supplier',             minRole: 'ADMIN',  module: null },
  { id: 'labor_contractors', label: '🔧 ผู้รับเหมาค่าแรง',    minRole: 'ADMIN',  module: 'labor_subcontractors' },
  { id: 'user_management',   label: '👤 ผู้ใช้งาน',           minRole: 'OWNER',  module: null },
  { id: 'settings',          label: '⚙️ ตั้งค่า',             minRole: 'OWNER',  module: null },
]
```

Inside `App()`, add the hook call alongside the existing `useUserRole()` call:

```javascript
  const { role, isAtLeast, loading: roleLoading } = useUserRole()
  const { tenant, isTrialActive, trialDaysRemaining, hasModuleAccess } = useTenant()
```

Update `visibleTabs` to also check module access:

```javascript
  const visibleTabs = TABS.filter(tab => {
    // First check role-based access
    if (!isAtLeast(tab.minRole)) return false

    // Then check module entitlement
    if (!hasModuleAccess(tab.module)) return false

    // Then check saved permissions (if any)
    const savedPermissions = getSavedPermissions()
    if (savedPermissions && role) {
      const pageKey = tab.id
      return savedPermissions[role]?.[pageKey] !== false
    }

    return true
  })
```

Mount the banner right after the opening `<div>` of the root return, before `<header>`:

```javascript
      <TrialBanner tenant={tenant} isTrialActive={isTrialActive} trialDaysRemaining={trialDaysRemaining} />
```

- [ ] **Step 3: Manual verification**

Run `npm run dev`, log in as the real FacadeX OWNER (bootstrap tenant, `plan='active'`, both modules granted in Task 5 Step 3). Confirm: (a) no banner shows (not in trial, plan is active); (b) all tabs including HR/Assign/ผู้รับเหมาค่าแรง are visible as before.

Then test the trial and blocked states by temporarily editing the bootstrap tenant via `execute_sql` (revert after each check):

```sql
-- Simulate active trial
UPDATE tenants SET trial_ends_at = now() + interval '5 days' WHERE company_name = 'Facade X';
```
Reload the app — expect the blue trial banner reading "เหลืออีก 5 วัน" and all tabs still visible.

```sql
-- Simulate expired trial with payroll module NOT purchased
UPDATE tenants SET trial_ends_at = now() - interval '1 day', plan = 'expired' WHERE company_name = 'Facade X';
DELETE FROM tenant_modules WHERE tenant_id = (SELECT id FROM tenants WHERE company_name = 'Facade X') AND module_key = 'payroll';
```
Reload the app — expect the red "หมดระยะทดลองใช้แล้ว" banner, and the Assign/HR tabs to disappear from the tab bar (labor_contractors module was left intact, so it should still show).

Revert both changes so the real FacadeX tenant is left correctly configured:

```sql
UPDATE tenants SET plan = 'active', trial_ends_at = now() - interval '1 day' WHERE company_name = 'Facade X';
INSERT INTO tenant_modules (tenant_id, module_key)
SELECT id, 'payroll' FROM tenants WHERE company_name = 'Facade X'
ON CONFLICT DO NOTHING;
```

- [ ] **Step 4: Commit**

```bash
git add src/components/TrialBanner.jsx src/App.jsx
git commit -m "feat: gate tabs by module entitlement, show trial status banner"
```

---

### Task 10: End-to-end manual verification checklist

**Files:** none (verification only)

- [ ] Fresh self-serve signup (Login.jsx signup mode) creates a new `tenants` row with `plan='trial'`, `trial_ends_at` ~14 days out, and a `user_roles` row with `role='OWNER'` pointing at it.
- [ ] Logging in as that new trial OWNER shows the blue trial banner and every tab (including payroll/labor_subcontractors modules) unlocked.
- [ ] That new trial tenant sees **zero** rows in every table when queried (fresh company, no data) — confirms no accidental visibility into the FacadeX bootstrap tenant's data.
- [ ] UserManagement.jsx's "create teammate" flow, run as the real FacadeX OWNER, creates a user in the **same** tenant (not a new one), with the chosen role applied.
- [ ] The real FacadeX OWNER's login still shows all their existing 116 sites, 2747 expenses, 346 suppliers, etc. — no data loss or hidden rows from the tenant-scoping rollout.
- [ ] Run the full `supabase/tests/tenant_scoping_test.sql` file one more time end-to-end via `execute_sql` — all 5 tests print `TEST PASSED`, no errors.
- [ ] As the real FacadeX OWNER (bootstrap tenant, `plan='active'`), confirm normal editing still works everywhere (add an expense, edit a site) — `tenant_can_write()` must resolve `true` for an active plan, not just an active trial.
- [ ] Run `mcp__plugin_supabase_supabase__get_advisors` (security type) — confirm no new findings introduced by this plan's migrations (new functions need `search_path` set — all of `current_tenant_id()`, `has_module_access()` already have `SET search_path = public` per Tasks 2/3, but re-check).

---

### Task 11: Final whole-branch review + finishing-a-development-branch

- [ ] Dispatch a final code-reviewer over the full branch diff (all 6 migrations + 5 frontend files).
- [ ] Use the `superpowers:finishing-a-development-branch` skill to verify test status and present merge/PR/keep/discard options.
