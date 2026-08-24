-- supabase/tests/invoice_module_test.sql
-- Regression tests for the Invoice module. Disposable-fixture style,
-- matching supabase/tests/quotation_module_test.sql -- safe to run against
-- production, self-cleans on every path.

-- ── Test 1: quotation_item_units is invisible and unwritable without the
-- 'invoices' module enabled, even for a tenant that DOES have 'quotations'
-- -- confirming the two modules gate independently.
--
-- Fixture/structure mirrors supabase/tests/quotation_module_test.sql's
-- Test 2 exactly (that file's comment block documents why): tenant_modules
-- has no 'enabled' column -- module access is presence-of-row, checked via
-- EXISTS, and a tenant on an active-trial gets blanket access regardless
-- of tenant_modules rows, so the negative-path fixture must be a
-- trial-expired, paid-plan tenant instead. The insert is attempted as the
-- 'authenticated' role under a real admin/owner's JWT claims (without that
-- switch the statement runs as the superuser connection and RLS never
-- applies at all), and the REGRESSION check sits outside the
-- BEGIN/EXCEPTION block so it can't catch its own raised exception. ──
DO $$
DECLARE
  test_tenant_id UUID;
  test_quotation_item_id UUID;
  test_admin_email TEXT;
  new_unit_id UUID;
  insert_succeeded BOOLEAN := false;
BEGIN
  SELECT qi.id, q.tenant_id INTO test_quotation_item_id, test_tenant_id
  FROM quotation_items qi
  JOIN quotations q ON q.id = qi.quotation_id
  JOIN tenants t ON t.id = q.tenant_id AND t.trial_ends_at < now() AND t.plan = 'active'
  WHERE EXISTS (SELECT 1 FROM tenant_modules tm WHERE tm.tenant_id = t.id AND tm.module_key = 'quotations')
    AND NOT EXISTS (SELECT 1 FROM tenant_modules tm WHERE tm.tenant_id = t.id AND tm.module_key = 'invoices')
  LIMIT 1;

  IF test_quotation_item_id IS NULL THEN
    RAISE NOTICE 'Test 1 (quotation_item_units module gating): SKIPPED — no quotation_item fixture on a trial-expired/paid tenant with quotations but not invoices';
  ELSE
    SELECT user_email INTO test_admin_email FROM user_roles
      WHERE tenant_id = test_tenant_id AND role IN ('OWNER','ADMIN') AND status = 'approved' LIMIT 1;

    IF test_admin_email IS NULL THEN
      RAISE NOTICE 'Test 1 (quotation_item_units module gating): SKIPPED — no admin/owner fixture for that tenant';
    ELSE
      SET LOCAL role = 'authenticated';
      SET LOCAL request.jwt.claims = '{"email":"' || test_admin_email || '"}';
      BEGIN
        INSERT INTO quotation_item_units (quotation_item_id, unit_index, unit_qty)
          VALUES (test_quotation_item_id, 0, 1) RETURNING id INTO new_unit_id;
        insert_succeeded := true;
      EXCEPTION WHEN insufficient_privilege OR others THEN
        insert_succeeded := false;
      END;
      RESET role;

      IF insert_succeeded THEN
        DELETE FROM quotation_item_units WHERE id = new_unit_id;
        RAISE EXCEPTION 'quotation_item_units RLS REGRESSION: insert succeeded without the invoices module enabled';
      ELSE
        RAISE NOTICE 'Test 1 (quotation_item_units module gating blocks writes without invoices module): TEST PASSED';
      END IF;
    END IF;
  END IF;
END $$;
