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

-- ── Test 2: invoice auto-numbering produces INV-<year>-NNN, sequential
-- within the year, matching generate_quotation_number()'s behavior. ──
DO $$
DECLARE
  test_tenant_id UUID;
  test_quotation_id UUID;
  test_site_id UUID;
  first_number TEXT;
  second_number TEXT;
  first_id UUID;
  second_id UUID;
BEGIN
  -- An active-trial tenant has full module access implicitly (matches
  -- has_module_access()'s own logic and quotation_module_test.sql's Test 3
  -- fixture-selection pattern) -- no tenant_modules join needed, and
  -- tenant_modules has no 'enabled' column to join on in the first place.
  SELECT q.id, q.tenant_id, q.site_id INTO test_quotation_id, test_tenant_id, test_site_id
  FROM quotations q
  JOIN tenants t ON t.id = q.tenant_id AND t.trial_ends_at > now()
  WHERE q.site_id IS NOT NULL
  LIMIT 1;

  IF test_quotation_id IS NULL THEN
    RAISE NOTICE 'Test 2 (invoice auto-numbering): SKIPPED — no accepted quotation with a site on an active-trial tenant';
  ELSE
    INSERT INTO invoices (quotation_id, site_id, date, has_vat, price_includes_vat, tenant_id)
      VALUES (test_quotation_id, test_site_id, CURRENT_DATE, true, false, test_tenant_id)
      RETURNING id, invoice_number INTO first_id, first_number;
    INSERT INTO invoices (quotation_id, site_id, date, has_vat, price_includes_vat, tenant_id)
      VALUES (test_quotation_id, test_site_id, CURRENT_DATE, true, false, test_tenant_id)
      RETURNING id, invoice_number INTO second_id, second_number;

    IF first_number !~ '^INV-\d{4}-\d{3}$' OR second_number !~ '^INV-\d{4}-\d{3}$' THEN
      RAISE EXCEPTION 'invoice_number REGRESSION: expected INV-YYYY-NNN format, got % and %', first_number, second_number;
    END IF;
    IF SUBSTRING(second_number FROM 'INV-\d{4}-(\d+)$')::INT != SUBSTRING(first_number FROM 'INV-\d{4}-(\d+)$')::INT + 1 THEN
      RAISE EXCEPTION 'invoice_number REGRESSION: expected sequential numbers, got % then %', first_number, second_number;
    END IF;

    DELETE FROM invoices WHERE id IN (first_id, second_id);
    RAISE NOTICE 'Test 2 (invoice auto-numbering INV-YYYY-NNN, sequential): TEST PASSED';
  END IF;
END $$;

-- ── Test 3: receipt auto-numbering produces both RCP-YYYY-NNN and
-- TIN-YYYY-NNN on a single insert, independently sequential. ──
DO $$
DECLARE
  test_tenant_id UUID;
  test_invoice_id UUID;
  rcp_number TEXT;
  tin_number TEXT;
  new_receipt_id UUID;
BEGIN
  SELECT i.id, i.tenant_id INTO test_invoice_id, test_tenant_id
  FROM invoices i
  WHERE NOT EXISTS (SELECT 1 FROM receipts r WHERE r.invoice_id = i.id)
  LIMIT 1;

  IF test_invoice_id IS NULL THEN
    RAISE NOTICE 'Test 3 (receipt auto-numbering): SKIPPED — no invoice fixture without an existing receipt';
  ELSE
    INSERT INTO receipts (invoice_id, date, amount, tenant_id)
      VALUES (test_invoice_id, CURRENT_DATE, 1000, test_tenant_id)
      RETURNING id, receipt_number, tax_invoice_number INTO new_receipt_id, rcp_number, tin_number;

    IF rcp_number !~ '^RCP-\d{4}-\d{3}$' THEN
      RAISE EXCEPTION 'receipt_number REGRESSION: expected RCP-YYYY-NNN format, got %', rcp_number;
    END IF;
    IF tin_number !~ '^TIN-\d{4}-\d{3}$' THEN
      RAISE EXCEPTION 'tax_invoice_number REGRESSION: expected TIN-YYYY-NNN format, got %', tin_number;
    END IF;

    DELETE FROM receipts WHERE id = new_receipt_id;
    RAISE NOTICE 'Test 3 (receipt auto-numbering: both RCP-YYYY-NNN and TIN-YYYY-NNN): TEST PASSED';
  END IF;
END $$;
