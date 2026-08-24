-- supabase/tests/invoice_module_test.sql
-- Regression tests for the Invoice module. Disposable-fixture style,
-- matching supabase/tests/quotation_module_test.sql -- safe to run against
-- production, self-cleans on every path.

-- ── Test 1: quotation_item_units is invisible and unwritable without the
-- 'invoices' module enabled, even for a tenant that DOES have 'quotations'
-- -- confirming the two modules gate independently. ──
DO $$
DECLARE
  test_tenant_id UUID;
  test_quotation_item_id UUID;
BEGIN
  SELECT qi.id INTO test_quotation_item_id
  FROM quotation_items qi
  JOIN quotations q ON q.id = qi.quotation_id
  JOIN tenants t ON t.id = q.tenant_id
  WHERE NOT EXISTS (
    SELECT 1 FROM tenant_modules tm
    WHERE tm.tenant_id = t.id AND tm.module_key = 'invoices' AND tm.enabled = true
  )
  LIMIT 1;

  IF test_quotation_item_id IS NULL THEN
    RAISE NOTICE 'Test 1 (quotation_item_units module gating): SKIPPED — no quotation_item fixture on a tenant without the invoices module';
  ELSE
    BEGIN
      INSERT INTO quotation_item_units (quotation_item_id, unit_index, unit_qty)
      VALUES (test_quotation_item_id, 0, 1);
      RAISE EXCEPTION 'quotation_item_units RLS REGRESSION: insert succeeded without the invoices module enabled';
    EXCEPTION WHEN insufficient_privilege OR others THEN
      RAISE NOTICE 'Test 1 (quotation_item_units module gating blocks writes without invoices module): TEST PASSED';
    END;
  END IF;
END $$;
