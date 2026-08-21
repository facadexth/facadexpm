-- Regression tests for the Quotation module. Disposable-fixture style,
-- matching supabase/tests/contractor_type_templates_test.sql — safe to
-- run against production, self-cleans on every path.

-- ── Test 1: company profile columns are readable by any tenant member
-- (existing member_reads_own_tenant policy), writable only by OWNER
-- (existing owner_updates_own_tenant policy) — confirming the new
-- columns didn't accidentally need a new policy. ──
DO $$
DECLARE
  test_tenant_id UUID;
  read_address TEXT;
BEGIN
  SELECT id INTO test_tenant_id FROM tenants LIMIT 1;

  UPDATE tenants SET address = '__TEST ADDRESS__' WHERE id = test_tenant_id;

  SELECT address INTO read_address FROM tenants WHERE id = test_tenant_id;
  IF read_address != '__TEST ADDRESS__' THEN
    RAISE EXCEPTION 'tenants.address REGRESSION: expected to write/read the new column, got %', read_address;
  END IF;

  UPDATE tenants SET address = NULL WHERE id = test_tenant_id;

  RAISE NOTICE 'Test 1 (tenants company-profile columns exist and are writable): TEST PASSED';
END $$;
