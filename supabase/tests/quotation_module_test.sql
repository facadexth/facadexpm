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

-- ── Test 2: quotations/catalog_items/quotation_items are invisible and
-- unwritable without the 'quotations' module enabled (and outside an
-- active trial) — has_module_access() gate matches purchase_orders'.
--
-- Deviates from the plan doc's literal SQL in two ways, both fixing real
-- bugs rather than style:
--   1. Adds SET LOCAL role='authenticated' + JWT claims for a real
--      ADMIN/OWNER of the fixture tenant before attempting the insert.
--      Without it the statement runs as the connecting (superuser) role,
--      which bypasses RLS entirely — the exact class of bug Task 1's
--      review round already caught once in this file (see
--      task-1-report.md, "RLS test not exercising RLS").
--   2. Moves the "insert succeeded" assertion outside the
--      BEGIN/EXCEPTION block that catches the insert's own error. As
--      written in the plan, `RAISE EXCEPTION '...REGRESSION...'` sat
--      inside the same block as `EXCEPTION WHEN insufficient_privilege
--      OR others`, so that handler caught its own deliberately-raised
--      exception and unconditionally printed "TEST PASSED" no matter
--      what the insert actually did. ──
DO $$
DECLARE
  test_tenant_id UUID;
  test_client_id UUID;
  test_admin_email TEXT;
  new_quotation_id UUID;
  insert_succeeded BOOLEAN := false;
BEGIN
  SELECT id INTO test_tenant_id FROM tenants WHERE trial_ends_at < now() AND plan = 'active' LIMIT 1;
  IF test_tenant_id IS NULL THEN
    RAISE NOTICE 'Test 2 (quotations module gating): SKIPPED — no expired-trial/active-plan tenant fixture available';
  ELSE
    SELECT id INTO test_client_id FROM clients WHERE tenant_id = test_tenant_id LIMIT 1;
    SELECT user_email INTO test_admin_email FROM user_roles
      WHERE tenant_id = test_tenant_id AND role IN ('OWNER','ADMIN') AND status = 'approved' LIMIT 1;

    IF test_client_id IS NULL THEN
      RAISE NOTICE 'Test 2 (quotations module gating): SKIPPED — no client fixture for that tenant';
    ELSIF test_admin_email IS NULL THEN
      RAISE NOTICE 'Test 2 (quotations module gating): SKIPPED — no admin/owner fixture for that tenant';
    ELSE
      SET LOCAL role = 'authenticated';
      SET LOCAL request.jwt.claims = '{"email":"' || test_admin_email || '"}';
      BEGIN
        INSERT INTO quotations (client_id, date, tenant_id) VALUES (test_client_id, CURRENT_DATE, test_tenant_id)
          RETURNING id INTO new_quotation_id;
        insert_succeeded := true;
      EXCEPTION WHEN insufficient_privilege OR others THEN
        insert_succeeded := false;
      END;
      RESET role;

      IF insert_succeeded THEN
        DELETE FROM quotations WHERE id = new_quotation_id;
        RAISE EXCEPTION 'quotations RLS REGRESSION: insert succeeded without the quotations module enabled';
      ELSE
        RAISE NOTICE 'Test 2 (quotations module gating blocks writes without the module): TEST PASSED';
      END IF;
    END IF;
  END IF;
END $$;

-- ── Test 3: quotation auto-numbering produces QT-<year>-NNN, sequential
-- within the year, matching generate_po_number()'s behavior. ──
DO $$
DECLARE
  test_tenant_id UUID;
  test_client_id UUID;
  first_number TEXT;
  second_number TEXT;
  first_id UUID;
  second_id UUID;
BEGIN
  SELECT id INTO test_tenant_id FROM tenants WHERE trial_ends_at > now() LIMIT 1;
  IF test_tenant_id IS NULL THEN
    RAISE NOTICE 'Test 3 (quotation auto-numbering): SKIPPED — no active-trial tenant fixture available';
  ELSE
    SELECT id INTO test_client_id FROM clients WHERE tenant_id = test_tenant_id LIMIT 1;
    IF test_client_id IS NULL THEN
      RAISE NOTICE 'Test 3 (quotation auto-numbering): SKIPPED — no client fixture for that tenant';
    ELSE
      INSERT INTO quotations (client_id, date, tenant_id) VALUES (test_client_id, CURRENT_DATE, test_tenant_id)
        RETURNING id, quotation_number INTO first_id, first_number;
      INSERT INTO quotations (client_id, date, tenant_id) VALUES (test_client_id, CURRENT_DATE, test_tenant_id)
        RETURNING id, quotation_number INTO second_id, second_number;

      IF first_number !~ '^QT-\d{4}-\d{3}$' OR second_number !~ '^QT-\d{4}-\d{3}$' THEN
        RAISE EXCEPTION 'quotation_number REGRESSION: expected QT-YYYY-NNN format, got % and %', first_number, second_number;
      END IF;
      IF SUBSTRING(second_number FROM 'QT-\d{4}-(\d+)$')::INT != SUBSTRING(first_number FROM 'QT-\d{4}-(\d+)$')::INT + 1 THEN
        RAISE EXCEPTION 'quotation_number REGRESSION: expected sequential numbers, got % then %', first_number, second_number;
      END IF;

      DELETE FROM quotations WHERE id IN (first_id, second_id);
      RAISE NOTICE 'Test 3 (quotation auto-numbering QT-YYYY-NNN, sequential): TEST PASSED';
    END IF;
  END IF;
END $$;
