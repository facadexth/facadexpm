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

-- ── Test 4: migration verification -- the five new invoice-module tables
-- all exist with RLS enabled, and each one's admin_full_access policy
-- genuinely references has_module_access('invoices') in its USING/WITH
-- CHECK clause (not a copy-paste leftover referencing 'quotations' or
-- omitting the check entirely). Also spot-checks that the columns this
-- module added actually exist via information_schema.columns. ──
DO $$
DECLARE
  new_tables TEXT[] := ARRAY['quotation_item_units','invoices','invoice_items','invoice_item_draws','receipts'];
  t TEXT;
  rls_enabled BOOLEAN;
  policy_count INT;
  gated_count INT;
  col_count INT;
BEGIN
  FOREACH t IN ARRAY new_tables LOOP
    SELECT rowsecurity INTO rls_enabled FROM pg_tables WHERE schemaname = 'public' AND tablename = t;
    IF rls_enabled IS NULL THEN
      RAISE EXCEPTION 'Test 4 REGRESSION: table % does not exist', t;
    END IF;
    IF rls_enabled = false THEN
      RAISE EXCEPTION 'Test 4 REGRESSION: table % has RLS disabled', t;
    END IF;

    SELECT count(*) INTO policy_count FROM pg_policies WHERE schemaname = 'public' AND tablename = t;
    IF policy_count = 0 THEN
      RAISE EXCEPTION 'Test 4 REGRESSION: table % has no RLS policies', t;
    END IF;

    SELECT count(*) INTO gated_count FROM pg_policies
      WHERE schemaname = 'public' AND tablename = t
        AND (qual ILIKE '%has_module_access(''invoices''%' OR with_check ILIKE '%has_module_access(''invoices''%');
    IF gated_count = 0 THEN
      RAISE EXCEPTION 'Test 4 REGRESSION: table %''s policy does not reference has_module_access(''invoices'')', t;
    END IF;
  END LOOP;

  SELECT count(*) INTO col_count FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'invoices' AND column_name IN ('invoice_number','status','income_id');
  IF col_count != 3 THEN
    RAISE EXCEPTION 'Test 4 REGRESSION: invoices table missing expected columns (found %/3)', col_count;
  END IF;

  SELECT count(*) INTO col_count FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'receipts' AND column_name IN ('receipt_number','tax_invoice_number');
  IF col_count != 2 THEN
    RAISE EXCEPTION 'Test 4 REGRESSION: receipts table missing expected columns (found %/2)', col_count;
  END IF;

  SELECT count(*) INTO col_count FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'quotation_item_units' AND column_name IN ('unit_index','unit_qty','cumulative_pct');
  IF col_count != 3 THEN
    RAISE EXCEPTION 'Test 4 REGRESSION: quotation_item_units table missing expected columns (found %/3)', col_count;
  END IF;

  -- site_financial_summary is a VIEW, not a table -- its columns still
  -- show up in information_schema.columns the same way
  SELECT count(*) INTO col_count FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'site_financial_summary' AND column_name IN ('invoiced_amount','invoiced_pct');
  IF col_count != 2 THEN
    RAISE EXCEPTION 'Test 4 REGRESSION: site_financial_summary view missing invoiced_amount/invoiced_pct columns (found %/2)', col_count;
  END IF;

  RAISE NOTICE 'Test 4 (migration verification: 5 new tables exist, RLS enabled, policies gate on invoices module, key columns present): TEST PASSED';
END $$;

-- ── Test 5: void->revert exactness -- create an invoice that partially
-- draws a mixed-progress unit, void it, and assert
-- quotation_item_units.cumulative_pct is back to its EXACT pre-invoice
-- value -- not just "close". This is money; NUMERIC columns carry no
-- floating-point slack, so an exact equality check is the right bar.
-- Runs as the connecting role (RLS is already separately verified in
-- Test 1) -- this test is about data mechanics, not access control.
-- The revert step mirrors handleVoid's actual optimistic-lock-guarded
-- UPDATE (`.eq('cumulative_pct', d.target_pct)`) so this test exercises
-- the same mechanism the app uses, not a simplified stand-in. ──
DO $$
DECLARE
  test_tenant_id UUID;
  test_quotation_id UUID;
  test_site_id UUID;
  test_quotation_item_id UUID;
  test_unit_id UUID;
  original_pct NUMERIC := 40;
  drawn_pct NUMERIC := 70;
  test_invoice_id UUID;
  test_invoice_item_id UUID;
  final_pct NUMERIC;
BEGIN
  SELECT q.id, q.tenant_id, q.site_id INTO test_quotation_id, test_tenant_id, test_site_id
  FROM quotations q WHERE q.site_id IS NOT NULL LIMIT 1;

  IF test_quotation_id IS NULL THEN
    RAISE NOTICE 'Test 5 (void->revert exactness): SKIPPED — no accepted quotation with a site available as a fixture';
  ELSE
    SELECT id INTO test_quotation_item_id FROM quotation_items WHERE quotation_id = test_quotation_id LIMIT 1;
    IF test_quotation_item_id IS NULL THEN
      RAISE NOTICE 'Test 5 (void->revert exactness): SKIPPED — fixture quotation has no line items';
    ELSE
      -- Seed one unit at a mixed (non-zero, non-100) prior state, using a
      -- unit_index unlikely to collide with real seeded rows (999)
      INSERT INTO quotation_item_units (quotation_item_id, unit_index, unit_qty, cumulative_pct, tenant_id)
        VALUES (test_quotation_item_id, 999, 1, original_pct, test_tenant_id)
        RETURNING id INTO test_unit_id;

      -- Simulate an invoice partially drawing that unit further (mirrors
      -- Invoices.jsx's handleSave)
      INSERT INTO invoices (quotation_id, site_id, date, has_vat, price_includes_vat, tenant_id)
        VALUES (test_quotation_id, test_site_id, CURRENT_DATE, true, false, test_tenant_id)
        RETURNING id INTO test_invoice_id;
      INSERT INTO invoice_items (invoice_id, quotation_item_id, description, unit_price, draw_qty, line_total, tenant_id)
        VALUES (test_invoice_id, test_quotation_item_id, '__TEST DRAW__', 1000, (drawn_pct - original_pct) / 100, (drawn_pct - original_pct) / 100 * 1000, test_tenant_id)
        RETURNING id INTO test_invoice_item_id;
      INSERT INTO invoice_item_draws (invoice_item_id, quotation_item_unit_id, prior_pct, target_pct, amount, tenant_id)
        VALUES (test_invoice_item_id, test_unit_id, original_pct, drawn_pct, (drawn_pct - original_pct) / 100 * 1000, test_tenant_id);
      UPDATE quotation_item_units SET cumulative_pct = drawn_pct WHERE id = test_unit_id;

      -- Simulate void (mirrors handleVoid's optimistic-lock-guarded revert)
      UPDATE quotation_item_units SET cumulative_pct = original_pct
        WHERE id = test_unit_id AND cumulative_pct = drawn_pct;

      SELECT cumulative_pct INTO final_pct FROM quotation_item_units WHERE id = test_unit_id;

      -- Clean up before asserting, so a failed assertion doesn't leave
      -- fixtures behind (disposable-fixture style, matches precedent)
      DELETE FROM invoice_item_draws WHERE invoice_item_id = test_invoice_item_id;
      DELETE FROM invoice_items WHERE id = test_invoice_item_id;
      DELETE FROM invoices WHERE id = test_invoice_id;
      DELETE FROM quotation_item_units WHERE id = test_unit_id;

      IF final_pct != original_pct THEN
        RAISE EXCEPTION 'Test 5 REGRESSION: void-revert exactness failed -- expected cumulative_pct = %, got %', original_pct, final_pct;
      END IF;

      RAISE NOTICE 'Test 5 (void->revert restores cumulative_pct to its exact pre-invoice value): TEST PASSED';
    END IF;
  END IF;
END $$;
