-- ================================================================
-- Tests for PO deposit deduction (migrations 2026-10-07-01 / -02).
--
-- !!! NOT RUN against any database !!!
-- Written without applying anything. Fixture column lists (sites / suppliers /
-- expense_categories / purchase_orders / purchase_order_items) are best guesses
-- from a read-only schema check and may need a tweak on first run. Run only on a
-- database where both migrations are applied (or wrapped in a rolled-back dry run).
--
-- Style: single BEGIN ... ROLLBACK script; runs as `authenticated` on a scratch
-- tenant; each negative check uses a nested BEGIN..EXCEPTION block.
-- ================================================================
BEGIN;

DO $$
DECLARE
  t_owner UUID; t_tenant UUID; t_site UUID; t_sup UUID; t_sup2 UUID; t_cat UUID;
  email TEXT := '__test_pd_owner__@example.com';
  e_dep UUID; e_dep2 UUID; e_dep3 UUID; e_dep4 UUID; e_other UUID;
  d1 UUID; d2 UUID; d3 UUID; d4 UUID; d_other UUID;
  po1 UUID; po2 UUID; po4 UUID;
  v_exp UUID; v_cnt INT; v_msg TEXT; v_status TEXT; v_pexp UUID;
  r RECORD;
BEGIN
  -- ── fixtures (as the connecting superuser) ──
  SELECT id INTO t_owner FROM auth.users ORDER BY created_at ASC LIMIT 1;
  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at)
  VALUES ('__TEST TENANT pd__', t_owner, 'trial', now() + interval '14 days') RETURNING id INTO t_tenant;
  INSERT INTO user_roles (user_email, role, status, tenant_id) VALUES (email, 'OWNER', 'approved', t_tenant);
  INSERT INTO sites (tenant_id, site_number, name) VALUES (t_tenant, '__PD-1__', '__pd site__') RETURNING id INTO t_site;
  INSERT INTO suppliers (tenant_id, name) VALUES (t_tenant, '__pd supplier__') RETURNING id INTO t_sup;
  INSERT INTO suppliers (tenant_id, name) VALUES (t_tenant, '__pd supplier 2__') RETURNING id INTO t_sup2;
  INSERT INTO expense_categories (tenant_id, name) VALUES (t_tenant, '__pd cat__') RETURNING id INTO t_cat;

  SET LOCAL role = 'authenticated';
  PERFORM set_config('request.jwt.claims', '{"email":"' || email || '"}', true);

  -- deposit expenses (plain expenses with VAT split, no po_id) + registered deposits
  INSERT INTO expenses (date, description, site_id, category_id, supplier_id, amount_no_vat, vat, amount, payment_method, status)
  VALUES (current_date, 'deposit 1', t_site, t_cat, t_sup, 43939.80, 3075.79, 47015.59, 'transfer', 'paid') RETURNING id INTO e_dep;
  INSERT INTO supplier_deposits (expense_id, deposit_invoice_no) VALUES (e_dep, 'AI-T1') RETURNING id INTO d1;

  INSERT INTO expenses (date, description, site_id, category_id, supplier_id, amount_no_vat, vat, amount, payment_method, status)
  VALUES (current_date, 'deposit 2', t_site, t_cat, t_sup, 41004, 2870.28, 43874.28, 'transfer', 'paid') RETURNING id INTO e_dep2;
  INSERT INTO supplier_deposits (expense_id, deposit_invoice_no) VALUES (e_dep2, 'AI-T2') RETURNING id INTO d2;

  INSERT INTO expenses (date, description, site_id, category_id, supplier_id, amount_no_vat, vat, amount, payment_method, status)
  VALUES (current_date, 'deposit 3', t_site, t_cat, t_sup, 1000, 70, 1070, 'transfer', 'paid') RETURNING id INTO e_dep3;
  INSERT INTO supplier_deposits (expense_id, deposit_invoice_no) VALUES (e_dep3, 'AI-T3') RETURNING id INTO d3;

  INSERT INTO expenses (date, description, site_id, category_id, supplier_id, amount_no_vat, vat, amount, payment_method, status)
  VALUES (current_date, 'deposit 4 (big)', t_site, t_cat, t_sup, 50000, 3500, 53500, 'transfer', 'paid') RETURNING id INTO e_dep4;
  INSERT INTO supplier_deposits (expense_id, deposit_invoice_no) VALUES (e_dep4, 'AI-T4') RETURNING id INTO d4;

  INSERT INTO expenses (date, description, site_id, category_id, supplier_id, amount_no_vat, vat, amount, payment_method, status)
  VALUES (current_date, 'deposit other supplier', t_site, t_cat, t_sup2, 5000, 350, 5350, 'transfer', 'paid') RETURNING id INTO e_other;
  INSERT INTO supplier_deposits (expense_id, deposit_invoice_no) VALUES (e_other, 'AI-OTHER') RETURNING id INTO d_other;

  -- POs (VAT-exclusive, 7%). line_total given explicitly.
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status, has_vat, price_includes_vat)
  VALUES (t_tenant, 'PO-PD-1', t_site, t_sup, t_cat, current_date, 'ordered', true, false) RETURNING id INTO po1;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total) VALUES (t_tenant, po1, 'item', 1, 9786, 9786);

  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status, has_vat, price_includes_vat)
  VALUES (t_tenant, 'PO-PD-2', t_site, t_sup, t_cat, current_date, 'ordered', true, false) RETURNING id INTO po2;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total) VALUES (t_tenant, po2, 'item', 1, 41004, 41004);

  -- po4 stays 'ordered' throughout; negatives 4-7 all use it
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status, has_vat, price_includes_vat)
  VALUES (t_tenant, 'PO-PD-4', t_site, t_sup, t_cat, current_date, 'ordered', true, false) RETURNING id INTO po4;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total) VALUES (t_tenant, po4, 'item', 1, 9786, 9786);

  -- Test 1: partial deduction -> remainder expense 6850.20 / 479.51 / 7329.71, application VAT 205.51, PO received
  v_exp := receive_po_with_deposits(po1,
    jsonb_build_array(jsonb_build_object('deposit_id', d1, 'amount_no_vat', 2935.80)), 9786.00, 685.02);
  IF v_exp IS NULL THEN RAISE EXCEPTION 'Test 1 FAIL: no remainder expense'; END IF;
  SELECT amount_no_vat, vat, amount, po_id INTO r FROM expenses WHERE id = v_exp;
  IF r.amount_no_vat <> 6850.20 OR r.vat <> 479.51 OR r.amount <> 7329.71 OR r.po_id <> po1 THEN
    RAISE EXCEPTION 'Test 1 FAIL: expense % / % / %', r.amount_no_vat, r.vat, r.amount;
  END IF;
  SELECT amount_no_vat, vat INTO r FROM po_deposit_applications WHERE deposit_id = d1 AND po_id = po1;
  IF NOT FOUND OR r.amount_no_vat <> 2935.80 OR r.vat <> 205.51 THEN RAISE EXCEPTION 'Test 1 FAIL: application row'; END IF;
  SELECT status, expense_id INTO v_status, v_pexp FROM purchase_orders WHERE id = po1;
  IF v_status <> 'received' OR v_pexp IS DISTINCT FROM v_exp THEN RAISE EXCEPTION 'Test 1 FAIL: PO status % / expense link', v_status; END IF;
  RAISE NOTICE 'Test 1 (partial deduction): PASSED';

  -- Test 2: full deduction -> NULL, no expense for the PO, PO received with NULL expense_id
  v_exp := receive_po_with_deposits(po2,
    jsonb_build_array(jsonb_build_object('deposit_id', d2, 'amount_no_vat', 41004)), 41004, 2870.28);
  IF v_exp IS NOT NULL THEN RAISE EXCEPTION 'Test 2 FAIL: expected NULL, got %', v_exp; END IF;
  SELECT count(*) INTO v_cnt FROM expenses WHERE po_id = po2;
  IF v_cnt <> 0 THEN RAISE EXCEPTION 'Test 2 FAIL: expense created'; END IF;
  SELECT status, expense_id INTO v_status, v_pexp FROM purchase_orders WHERE id = po2;
  IF v_status <> 'received' OR v_pexp IS NOT NULL THEN RAISE EXCEPTION 'Test 2 FAIL: PO % / %', v_status, v_pexp; END IF;
  RAISE NOTICE 'Test 2 (full deduction, no expense): PASSED';

  -- Test 3: second receive of the same PO -> not_ordered
  BEGIN
    PERFORM receive_po_with_deposits(po1, '[]'::jsonb, 9786.00, 685.02);
    RAISE EXCEPTION 'Test 3 FAIL: second receive did not raise';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'not_ordered%' THEN RAISE EXCEPTION 'Test 3 FAIL: got %', v_msg; END IF;
  END;
  RAISE NOTICE 'Test 3 (not_ordered): PASSED';

  -- Test 4: deduction above the deposit's remaining -> deposit_exceeds_remaining, nothing written
  BEGIN
    PERFORM receive_po_with_deposits(po4,
      jsonb_build_array(jsonb_build_object('deposit_id', d3, 'amount_no_vat', 1000.01)), 9786.00, 685.02);
    RAISE EXCEPTION 'Test 4 FAIL: did not raise';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'deposit_exceeds_remaining%' THEN RAISE EXCEPTION 'Test 4 FAIL: got %', v_msg; END IF;
  END;
  SELECT count(*) INTO v_cnt FROM po_deposit_applications WHERE po_id = po4;
  SELECT status INTO v_status FROM purchase_orders WHERE id = po4;
  IF v_cnt <> 0 OR v_status <> 'ordered' OR EXISTS (SELECT 1 FROM expenses WHERE po_id = po4) THEN
    RAISE EXCEPTION 'Test 4 FAIL: rows written (apps=%, status=%)', v_cnt, v_status;
  END IF;
  RAISE NOTICE 'Test 4 (deposit_exceeds_remaining, nothing written): PASSED';

  -- Test 5: deduction above the PO subtotal -> deposit_exceeds_po
  BEGIN
    PERFORM receive_po_with_deposits(po4,
      jsonb_build_array(jsonb_build_object('deposit_id', d4, 'amount_no_vat', 9786.01)), 9786.00, 685.02);
    RAISE EXCEPTION 'Test 5 FAIL: did not raise';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'deposit_exceeds_po%' THEN RAISE EXCEPTION 'Test 5 FAIL: got %', v_msg; END IF;
  END;
  RAISE NOTICE 'Test 5 (deposit_exceeds_po): PASSED';

  -- Test 6: another supplier's deposit -> deposit_wrong_supplier
  BEGIN
    PERFORM receive_po_with_deposits(po4,
      jsonb_build_array(jsonb_build_object('deposit_id', d_other, 'amount_no_vat', 100)), 9786.00, 685.02);
    RAISE EXCEPTION 'Test 6 FAIL: did not raise';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'deposit_wrong_supplier%' THEN RAISE EXCEPTION 'Test 6 FAIL: got %', v_msg; END IF;
  END;
  RAISE NOTICE 'Test 6 (deposit_wrong_supplier): PASSED';

  -- Test 7: wrong expected totals -> totals_mismatch
  BEGIN
    PERFORM receive_po_with_deposits(po4, '[]'::jsonb, 9786.00, 600.00);
    RAISE EXCEPTION 'Test 7 FAIL: did not raise';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'totals_mismatch%' THEN RAISE EXCEPTION 'Test 7 FAIL: got %', v_msg; END IF;
  END;
  SELECT status INTO v_status FROM purchase_orders WHERE id = po4;
  IF v_status <> 'ordered' THEN RAISE EXCEPTION 'Test 7 FAIL: PO status %', v_status; END IF;
  RAISE NOTICE 'Test 7 (totals_mismatch): PASSED';

  -- Test 8: deposit d1 now has an application -> expense delete is an FK violation, amount edit is deposit_in_use
  BEGIN
    DELETE FROM expenses WHERE id = e_dep;
    RAISE EXCEPTION 'Test 8 FAIL: delete did not raise';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;
  BEGIN
    UPDATE expenses SET amount_no_vat = 1, amount = 1 + vat WHERE id = e_dep;
    RAISE EXCEPTION 'Test 8 FAIL: update did not raise';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'deposit_in_use%' THEN RAISE EXCEPTION 'Test 8 FAIL: got %', v_msg; END IF;
  END;
  RAISE NOTICE 'Test 8 (applied deposit locked): PASSED';

  -- Test 9: client cannot write applications directly
  BEGIN
    INSERT INTO po_deposit_applications (deposit_id, po_id, amount_no_vat, vat) VALUES (d4, po4, 1, 0);
    RAISE EXCEPTION 'Test 9 FAIL: client insert succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  RAISE NOTICE 'Test 9 (client insert on applications denied): PASSED';

  RESET role;
END $$;

ROLLBACK;
