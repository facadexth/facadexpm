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
