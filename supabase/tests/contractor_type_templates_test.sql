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

-- ── Test 3: every seeded contractor type has at least one category,
-- and every category with a name NOT containing 'แรง' (the labor-cost
-- naming convention used throughout this seed and the rest of the app)
-- has exactly one supplier — catches a mistyped type_key or
-- category_name in the VALUES lists silently producing an orphaned
-- row that the JOIN in Task 2's migration would have dropped. ──
DO $$
DECLARE
  types_without_categories INT;
  material_categories_without_supplier INT;
BEGIN
  SELECT count(*) INTO types_without_categories
  FROM contractor_types ct
  WHERE NOT EXISTS (SELECT 1 FROM contractor_type_categories cc WHERE cc.contractor_type_id = ct.id)
    AND ct.key NOT LIKE '\_\_test%';

  IF types_without_categories != 0 THEN
    RAISE EXCEPTION 'CONTENT REGRESSION: % contractor type(s) have zero categories (a type_key typo in the seed VALUES list silently drops the JOIN)', types_without_categories;
  END IF;

  SELECT count(*) INTO material_categories_without_supplier
  FROM contractor_type_categories cc
  WHERE cc.name NOT LIKE '%แรง%'
    AND NOT EXISTS (SELECT 1 FROM contractor_type_category_suppliers s WHERE s.category_template_id = cc.id)
    AND cc.name NOT LIKE '\_\_TEST%';

  IF material_categories_without_supplier != 0 THEN
    RAISE EXCEPTION 'CONTENT REGRESSION: % non-labor categor(y/ies) have zero suppliers (a category_name typo in the seed VALUES list silently drops the JOIN)', material_categories_without_supplier;
  END IF;

  RAISE NOTICE 'Test 3 (seed content integrity): TEST PASSED';
END $$;

-- ── Test 4: a new signup with contractor_type_id='painting' gets
-- exactly 3 seeded categories and 2 seeded suppliers (the labor
-- category gets none). Run inside an explicit transaction that's
-- rolled back, not committed — the established pattern for testing
-- auth.users triggers without leaving artifacts. Run this block as its
-- OWN execute_sql call, separate from Tests 1–3: its ROLLBACK would
-- otherwise discard Tests 1–3's inserts if they shared the same
-- implicit transaction. ──
BEGIN;
DO $$
DECLARE
  v_painting_type_id UUID;
  v_tenant_id UUID;
  v_category_count INT;
  v_supplier_count INT;
BEGIN
  SELECT id INTO v_painting_type_id FROM contractor_types WHERE key = 'painting';

  INSERT INTO auth.users (id, email, raw_user_meta_data)
  VALUES (
    gen_random_uuid(), '__test_contractor_seed__@example.com',
    jsonb_build_object('company_name', 'Test Painting Co', 'contractor_type_id', v_painting_type_id::text)
  );

  SELECT tenant_id INTO v_tenant_id FROM user_roles WHERE user_email = '__test_contractor_seed__@example.com';
  SELECT count(*) INTO v_category_count FROM expense_categories WHERE tenant_id = v_tenant_id;
  SELECT count(*) INTO v_supplier_count FROM suppliers WHERE tenant_id = v_tenant_id;

  IF v_category_count != 3 THEN
    RAISE EXCEPTION 'Test 4 REGRESSION: expected 3 seeded categories for painting, got %', v_category_count;
  END IF;
  IF v_supplier_count != 2 THEN
    RAISE EXCEPTION 'Test 4 REGRESSION: expected 2 seeded suppliers for painting, got %', v_supplier_count;
  END IF;

  RAISE NOTICE 'Test 4 (signup trigger seeds categories + suppliers): TEST PASSED';
END $$;
ROLLBACK;
