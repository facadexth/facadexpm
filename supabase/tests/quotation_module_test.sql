-- Regression tests for the Quotation module. Disposable-fixture style,
-- matching supabase/tests/contractor_type_templates_test.sql — safe to
-- run against production, self-cleans on every path.

-- ── Test 1: company profile columns are readable by any tenant member
-- (via existing member_reads_own_tenant policy), writable only by OWNER
-- (via existing owner_updates_own_tenant policy) — confirming the new
-- columns don't need a new policy and RLS behavior is correct. ──
DO $$
DECLARE
  test_tenant_id UUID;
  test_owner_id UUID;
  test_owner_email TEXT;
  test_member_email TEXT;
  test_member_id UUID;
  read_address TEXT;
  affected_rows INT;
BEGIN
  -- Get a real auth.users row for owner_user_id FK
  SELECT id INTO test_owner_id FROM auth.users ORDER BY created_at ASC LIMIT 1;

  -- Create test tenant
  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at)
  VALUES ('__TEST TENANT quotation__', test_owner_id, 'trial', now() + interval '14 days')
  RETURNING id INTO test_tenant_id;

  -- Create owner and member user_roles fixtures
  test_owner_email := '__test_owner_quotation__@example.com';
  test_member_email := '__test_member_quotation__@example.com';
  INSERT INTO user_roles (user_email, role, status, tenant_id)
  VALUES (test_owner_email, 'OWNER', 'approved', test_tenant_id);
  INSERT INTO user_roles (user_email, role, status, tenant_id)
  VALUES (test_member_email, 'WORKER', 'approved', test_tenant_id);

  -- Test 1a: OWNER can read and write the address column
  SET LOCAL role = 'authenticated';
  SET LOCAL request.jwt.claims = '{"email":"' || test_owner_email || '"}';

  UPDATE tenants SET address = '__TEST ADDRESS OWNER__' WHERE id = test_tenant_id;

  SELECT address INTO read_address FROM tenants WHERE id = test_tenant_id;
  IF read_address != '__TEST ADDRESS OWNER__' THEN
    RAISE EXCEPTION 'Test 1a REGRESSION: owner expected to read address, got %', read_address;
  END IF;

  -- Test 1b: Non-owner WORKER can read the address column (via member_reads_own_tenant)
  SET LOCAL role = 'authenticated';
  SET LOCAL request.jwt.claims = '{"email":"' || test_member_email || '"}';

  SELECT address INTO read_address FROM tenants WHERE id = test_tenant_id;
  IF read_address != '__TEST ADDRESS OWNER__' THEN
    RAISE EXCEPTION 'Test 1b REGRESSION: member expected to read address, got %', read_address;
  END IF;

  -- Test 1c: Non-owner WORKER cannot write the address column (via owner_updates_own_tenant requiring is_owner())
  -- Postgres RLS silently affects 0 rows on failed USING check, so we verify by checking affected rows count
  UPDATE tenants SET address = '__TEST ADDRESS MEMBER__' WHERE id = test_tenant_id;
  GET DIAGNOSTICS affected_rows = ROW_COUNT;

  IF affected_rows != 0 THEN
    RAISE EXCEPTION 'Test 1c REGRESSION: member expected UPDATE to affect 0 rows (RLS block), got %', affected_rows;
  END IF;

  -- Verify the value did NOT change
  SELECT address INTO read_address FROM tenants WHERE id = test_tenant_id;
  IF read_address != '__TEST ADDRESS OWNER__' THEN
    RAISE EXCEPTION 'Test 1c REGRESSION: address should not have changed, got %', read_address;
  END IF;

  -- Cleanup
  RESET role;
  DELETE FROM user_roles WHERE user_email IN (test_owner_email, test_member_email);
  DELETE FROM tenants WHERE id = test_tenant_id;

  RAISE NOTICE 'Test 1 (tenants company-profile columns: read by members, write by owner only): TEST PASSED';
END $$;
