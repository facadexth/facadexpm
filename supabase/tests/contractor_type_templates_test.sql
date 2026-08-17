-- ================================================================
-- Regression tests for contractor-type starter templates.
-- Disposable-fixture style, matching supabase/tests/tenant_scoping_test.sql
-- — safe to run against production, self-cleans on every path.
-- ================================================================

-- ── Test 1: an authenticated user with no tenant yet (mid-signup) can
-- still read contractor_types — the RLS policy must not require
-- current_tenant_id() to resolve. ──
DO $$
DECLARE
  visible_count INT;
  test_type_id UUID;
BEGIN
  INSERT INTO contractor_types (key, label_th, sort_order)
  VALUES ('__test_type__', '__TEST TYPE__', 999)
  RETURNING id INTO test_type_id;

  SET LOCAL role = 'authenticated';
  SET LOCAL request.jwt.claims = '{"email":"__no_tenant_yet__@example.com"}';

  SELECT count(*) INTO visible_count FROM contractor_types WHERE id = test_type_id;
  IF visible_count != 1 THEN
    RAISE EXCEPTION 'contractor_types RLS REGRESSION: expected 1 visible row for a user with no tenant, got %', visible_count;
  END IF;

  RESET role;
  DELETE FROM contractor_types WHERE id = test_type_id;

  RAISE NOTICE 'Test 1 (contractor_types readable pre-tenant): TEST PASSED';
END $$;

-- ── Test 2: a category with zero contractor_type_category_suppliers
-- rows (a labor category) is distinguishable from one with a row
-- (a material category) purely by the join — no flag needed. ──
DO $$
DECLARE
  test_type_id UUID;
  material_cat_id UUID;
  labor_cat_id UUID;
  supplier_count_material INT;
  supplier_count_labor INT;
BEGIN
  INSERT INTO contractor_types (key, label_th, sort_order)
  VALUES ('__test_type_2__', '__TEST TYPE 2__', 999)
  RETURNING id INTO test_type_id;

  INSERT INTO contractor_type_categories (contractor_type_id, name, color, sort_order)
  VALUES (test_type_id, '__TEST material cat__', '#FFFFFF', 1)
  RETURNING id INTO material_cat_id;

  INSERT INTO contractor_type_categories (contractor_type_id, name, color, sort_order)
  VALUES (test_type_id, '__TEST labor cat__', '#FFFFFF', 2)
  RETURNING id INTO labor_cat_id;

  INSERT INTO contractor_type_category_suppliers (category_template_id, supplier_name, sort_order)
  VALUES (material_cat_id, '__TEST SUPPLIER__', 1);
  -- deliberately no supplier row for labor_cat_id

  SELECT count(*) INTO supplier_count_material FROM contractor_type_category_suppliers WHERE category_template_id = material_cat_id;
  SELECT count(*) INTO supplier_count_labor FROM contractor_type_category_suppliers WHERE category_template_id = labor_cat_id;

  IF supplier_count_material != 1 THEN
    RAISE EXCEPTION 'REGRESSION: material category should have 1 supplier, got %', supplier_count_material;
  END IF;
  IF supplier_count_labor != 0 THEN
    RAISE EXCEPTION 'REGRESSION: labor category should have 0 suppliers, got %', supplier_count_labor;
  END IF;

  DELETE FROM contractor_type_category_suppliers WHERE category_template_id = material_cat_id;
  DELETE FROM contractor_type_categories WHERE id IN (material_cat_id, labor_cat_id);
  DELETE FROM contractor_types WHERE id = test_type_id;

  RAISE NOTICE 'Test 2 (labor category has no supplier row): TEST PASSED';
END $$;
