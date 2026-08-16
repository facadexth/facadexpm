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
