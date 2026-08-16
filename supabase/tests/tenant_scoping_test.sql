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
  -- tenants.owner_user_id is NOT NULL REFERENCES auth.users(id) (Task 1),
  -- so the test fixture must reuse a real auth.users row rather than a
  -- fabricated UUID. owner_user_id has no uniqueness constraint, so
  -- borrowing an existing user's id for this disposable test tenant is
  -- safe and has no side effects on that user's real data.
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

  -- sites has a seed_site_phases trigger (SECURITY INVOKER) that inserts
  -- into site_phases relying on its own DEFAULT current_tenant_id(),
  -- which resolves via auth.email() = request.jwt.claims ->> 'email' —
  -- not via the connection's Postgres role. Set the claim (without yet
  -- switching to the `authenticated` role, so these setup inserts still
  -- bypass RLS as this session's normal elevated role) before each site
  -- insert so the trigger seeds the right tenant instead of failing
  -- site_phases' tenant_id NOT NULL constraint on a NULL resolution.
  SET LOCAL request.jwt.claims = '{"email":"__test_iso_a__@example.com"}';
  INSERT INTO sites (site_number, name, tenant_id) VALUES ('__TEST-ISO-A__', '__TEST SITE A__', tenant_a)
    RETURNING id INTO site_a;

  SET LOCAL request.jwt.claims = '{"email":"__test_iso_b__@example.com"}';
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
  rows_updated INT;
BEGIN
  -- tenants.owner_user_id is NOT NULL REFERENCES auth.users(id) — a
  -- fabricated gen_random_uuid() violates the FK. Borrow a real user's id.
  SELECT id INTO real_user_id FROM auth.users ORDER BY created_at ASC LIMIT 1;

  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at)
  VALUES ('__TEST TENANT expired writes__', real_user_id, 'expired', now() - interval '1 day')
  RETURNING id INTO tenant_id_expired;

  INSERT INTO user_roles (user_email, role, status, tenant_id)
  VALUES ('__test_expired_writes__@example.com', 'OWNER', 'approved', tenant_id_expired);

  -- sites has a seed_site_phases trigger (SECURITY INVOKER) that inserts
  -- into site_phases relying on its own DEFAULT current_tenant_id(),
  -- which resolves via auth.email() = request.jwt.claims ->> 'email' —
  -- not via the connection's Postgres role. Set the claim (without yet
  -- switching to the `authenticated` role) before the site insert so the
  -- trigger seeds the right tenant. This insert must also happen before
  -- switching to `authenticated`: this tenant is expired/write-locked,
  -- so the same INSERT would be rejected by sites' own admin_inserts
  -- RLS policy (tenant_can_write()) once impersonation is active — the
  -- fixture row has to be seeded by the elevated setup role, same as
  -- the tenant/user_roles rows above.
  SET LOCAL request.jwt.claims = '{"email":"__test_expired_writes__@example.com"}';
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

  -- Write must fail. tenant_can_write() is part of the UPDATE policy's
  -- USING clause (not just WITH CHECK), so a blocked write does NOT
  -- raise an exception — Postgres simply excludes the row from the
  -- match, identically to updating a nonexistent id. Assert via
  -- ROW_COUNT rather than an exception handler (confirmed live: an
  -- exception-handler version of this assertion false-passed, since
  -- no exception is ever thrown in this path).
  UPDATE sites SET name = '__TEST SITE should not update__' WHERE id = site_row_id;
  GET DIAGNOSTICS rows_updated = ROW_COUNT;

  IF rows_updated != 0 THEN
    RAISE EXCEPTION 'tenant_can_write() REGRESSION: expired tenant should NOT be able to UPDATE sites, but % row(s) were updated', rows_updated;
  END IF;

  RESET role;
  DELETE FROM sites WHERE id = site_row_id;
  DELETE FROM user_roles WHERE user_email = '__test_expired_writes__@example.com';
  DELETE FROM tenants WHERE id = tenant_id_expired;

  RAISE NOTICE 'Test 4 (tenant_can_write core read-only lockout): TEST PASSED';
END $$;

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
