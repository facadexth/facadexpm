-- ================================================================
-- Tests for PO deposit deduction (migrations 2026-10-07-01 / -02).
--
-- !!! NOT RUN against any database !!!
-- Written without applying anything. Fixture INSERT columns were re-checked against
-- the live schema with read-only information_schema SELECTs (NOT NULL columns,
-- defaults, CHECK constraints), but the script itself has never executed. Run only
-- on a database where both migrations are applied (or in ONE rolled-back dry-run
-- transaction: BEGIN; migration 01; migration 02; this file -- it ends in ROLLBACK).
-- Success = the NOTICE lines "Test N ...: PASSED" for every test, no ERROR.
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
  po1 UUID; po2 UUID; po4 UUID; po10 UUID; po11 UUID;
  t2_tenant UUID; t2_site UUID; t2_sup UUID; t2_cat UUID; t2_exp UUID; t2_dep UUID; t2_po UUID;
  e5 UUID; d5 UUID; e6 UUID; d6 UUID; e7 UUID; d7 UUID; e8 UUID; d8 UUID;
  v_bkk DATE := (now() AT TIME ZONE 'Asia/Bangkok')::date; v_vsum NUMERIC;
  v_exp UUID; v_cnt INT; v_msg TEXT; v_status TEXT; v_pexp UUID;
  r RECORD;
  t3_tenant UUID; t3_site UUID; t3_sup UUID; t3_cat UUID; t3_exp UUID; t3_po UUID; email3 TEXT := '__test_pd_owner3__@example.com';
  e9 UUID; d9 UUID; po12 UUID; po13 UUID; po14 UUID; po15 UUID; po16 UUID; e10 UUID; d10 UUID; e11 UUID; d11 UUID; e12 UUID;
  v_bool BOOLEAN;
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

  -- second tenant (cross-tenant check), built as superuser
  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at)
  VALUES ('__TEST TENANT pd2__', t_owner, 'trial', now() + interval '14 days') RETURNING id INTO t2_tenant;
  INSERT INTO sites (tenant_id, site_number, name) VALUES (t2_tenant, '__PD-2__', '__pd site2__') RETURNING id INTO t2_site;
  INSERT INTO suppliers (tenant_id, name) VALUES (t2_tenant, '__pd t2 supplier__') RETURNING id INTO t2_sup;
  INSERT INTO expense_categories (tenant_id, name) VALUES (t2_tenant, '__pd t2 cat__') RETURNING id INTO t2_cat;
  INSERT INTO expenses (tenant_id, date, description, site_id, category_id, supplier_id, amount_no_vat, vat, amount, payment_method, status)
  VALUES (t2_tenant, current_date, 't2 deposit', t2_site, t2_cat, t2_sup, 100, 7, 107, 'transfer', 'paid') RETURNING id INTO t2_exp;
  INSERT INTO supplier_deposits (tenant_id, expense_id, deposit_invoice_no) VALUES (t2_tenant, t2_exp, 'AI-T2TENANT') RETURNING id INTO t2_dep;
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status, has_vat, price_includes_vat)
  VALUES (t2_tenant, 'PO-PD-T2', t2_site, t2_sup, t2_cat, current_date, 'ordered', true, false) RETURNING id INTO t2_po;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total) VALUES (t2_tenant, t2_po, 'item', 1, 100, 100);

  -- third tenant: trial ended, plan expired (tenant_can_write() = false) but module access kept via tenant_modules
  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at)
  VALUES ('__TEST TENANT pd3__', t_owner, 'expired', now() - interval '1 day') RETURNING id INTO t3_tenant;
  INSERT INTO tenant_modules (tenant_id, module_key) VALUES (t3_tenant, 'purchase_orders');
  INSERT INTO user_roles (user_email, role, status, tenant_id) VALUES (email3, 'OWNER', 'approved', t3_tenant);
  INSERT INTO sites (tenant_id, site_number, name) VALUES (t3_tenant, '__PD-3__', '__pd site3__') RETURNING id INTO t3_site;
  INSERT INTO suppliers (tenant_id, name) VALUES (t3_tenant, '__pd t3 supplier__') RETURNING id INTO t3_sup;
  INSERT INTO expense_categories (tenant_id, name) VALUES (t3_tenant, '__pd t3 cat__') RETURNING id INTO t3_cat;
  INSERT INTO expenses (tenant_id, date, description, site_id, category_id, supplier_id, amount_no_vat, vat, amount, payment_method, status)
  VALUES (t3_tenant, current_date, 't3 deposit', t3_site, t3_cat, t3_sup, 100, 7, 107, 'transfer', 'paid') RETURNING id INTO t3_exp;
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status, has_vat, price_includes_vat)
  VALUES (t3_tenant, 'PO-PD-T3', t3_site, t3_sup, t3_cat, current_date, 'ordered', true, false) RETURNING id INTO t3_po;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total) VALUES (t3_tenant, t3_po, 'item', 1, 100, 100);

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
  SELECT status, payment_method, date INTO r FROM expenses WHERE id = v_exp;
  IF r.status <> 'pending' OR r.payment_method <> 'transfer' OR r.date <> v_bkk THEN
    RAISE EXCEPTION 'Test 1 FAIL: status=% method=% date=% (expected pending/transfer/%)', r.status, r.payment_method, r.date, v_bkk;
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
  IF EXISTS (SELECT 1 FROM po_deposit_applications WHERE deposit_id = d4) OR EXISTS (SELECT 1 FROM expenses WHERE po_id = po4)
     OR (SELECT status FROM purchase_orders WHERE id = po4) <> 'ordered' THEN
    RAISE EXCEPTION 'Test 5 FAIL: something was written';
  END IF;
  RAISE NOTICE 'Test 5 (deposit_exceeds_po, nothing written): PASSED';

  -- Test 6: another supplier's deposit -> deposit_wrong_supplier
  BEGIN
    PERFORM receive_po_with_deposits(po4,
      jsonb_build_array(jsonb_build_object('deposit_id', d_other, 'amount_no_vat', 100)), 9786.00, 685.02);
    RAISE EXCEPTION 'Test 6 FAIL: did not raise';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'deposit_wrong_supplier%' THEN RAISE EXCEPTION 'Test 6 FAIL: got %', v_msg; END IF;
  END;
  IF EXISTS (SELECT 1 FROM po_deposit_applications WHERE deposit_id = d_other) OR EXISTS (SELECT 1 FROM expenses WHERE po_id = po4)
     OR (SELECT status FROM purchase_orders WHERE id = po4) <> 'ordered' THEN
    RAISE EXCEPTION 'Test 6 FAIL: something was written';
  END IF;
  RAISE NOTICE 'Test 6 (deposit_wrong_supplier, nothing written): PASSED';

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

  -- Test 8: deposit d1 now has an application -> deleting the deposit row is an FK violation, expense amount edit is deposit_in_use
  BEGIN
    DELETE FROM supplier_deposits WHERE id = d1;
    RAISE EXCEPTION 'Test 8 FAIL: deposit delete did not raise';
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

  -- Test 10: cross-tenant -> po_not_found / deposit_not_found
  BEGIN
    PERFORM receive_po_with_deposits(t2_po, '[]'::jsonb, 100, 7);
    RAISE EXCEPTION 'Test 10 FAIL: other tenant PO received';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'po_not_found%' THEN RAISE EXCEPTION 'Test 10 FAIL: got %', v_msg; END IF;
  END;
  BEGIN
    PERFORM receive_po_with_deposits(po4,
      jsonb_build_array(jsonb_build_object('deposit_id', t2_dep, 'amount_no_vat', 10)), 9786.00, 685.02);
    RAISE EXCEPTION 'Test 10 FAIL: other tenant deposit applied';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'deposit_not_found%' THEN RAISE EXCEPTION 'Test 10 FAIL: got %', v_msg; END IF;
  END;
  RAISE NOTICE 'Test 10 (cross-tenant): PASSED';

  -- Test 11: deposit expense that lost its VAT split (edited before any application) -> deposit_expense_needs_vat_split
  INSERT INTO expenses (date, description, site_id, category_id, supplier_id, amount_no_vat, vat, amount, payment_method, status)
  VALUES (current_date, 'deposit 5', t_site, t_cat, t_sup, 500, 35, 535, 'transfer', 'paid') RETURNING id INTO e5;
  INSERT INTO supplier_deposits (expense_id, deposit_invoice_no) VALUES (e5, 'AI-T5') RETURNING id INTO d5;
  UPDATE expenses SET amount_no_vat = NULL WHERE id = e5;
  BEGIN
    PERFORM receive_po_with_deposits(po4,
      jsonb_build_array(jsonb_build_object('deposit_id', d5, 'amount_no_vat', 100)), 9786.00, 685.02);
    RAISE EXCEPTION 'Test 11 FAIL: did not raise';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'deposit_expense_needs_vat_split%' THEN RAISE EXCEPTION 'Test 11 FAIL: got %', v_msg; END IF;
  END;
  IF EXISTS (SELECT 1 FROM po_deposit_applications WHERE deposit_id = d5) OR EXISTS (SELECT 1 FROM expenses WHERE po_id = po4)
     OR (SELECT status FROM purchase_orders WHERE id = po4) <> 'ordered' THEN
    RAISE EXCEPTION 'Test 11 FAIL: something was written';
  END IF;
  RAISE NOTICE 'Test 11 (deposit_expense_needs_vat_split, nothing written): PASSED';

  -- Test 12: one-satang rounding. Two deposits 1000.80 net / 70.06 VAT vs PO 2001.60 / 140.11
  -- -> no expense, application VAT sums to exactly the PO VAT (last application adjusted by 0.01)
  INSERT INTO expenses (date, description, site_id, category_id, supplier_id, amount_no_vat, vat, amount, payment_method, status)
  VALUES (current_date, 'deposit 6', t_site, t_cat, t_sup, 1000.80, 70.06, 1070.86, 'transfer', 'paid') RETURNING id INTO e6;
  INSERT INTO supplier_deposits (expense_id, deposit_invoice_no) VALUES (e6, 'AI-T6') RETURNING id INTO d6;
  INSERT INTO expenses (date, description, site_id, category_id, supplier_id, amount_no_vat, vat, amount, payment_method, status)
  VALUES (current_date, 'deposit 7', t_site, t_cat, t_sup, 1000.80, 70.06, 1070.86, 'transfer', 'paid') RETURNING id INTO e7;
  INSERT INTO supplier_deposits (expense_id, deposit_invoice_no) VALUES (e7, 'AI-T7') RETURNING id INTO d7;
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status, has_vat, price_includes_vat)
  VALUES (t_tenant, 'PO-PD-10', t_site, t_sup, t_cat, current_date, 'ordered', true, false) RETURNING id INTO po10;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total) VALUES (t_tenant, po10, 'item', 1, 2001.60, 2001.60);
  v_exp := receive_po_with_deposits(po10, jsonb_build_array(
      jsonb_build_object('deposit_id', d6, 'amount_no_vat', 1000.80),
      jsonb_build_object('deposit_id', d7, 'amount_no_vat', 1000.80)), 2001.60, 140.11);
  IF v_exp IS NOT NULL OR EXISTS (SELECT 1 FROM expenses WHERE po_id = po10) THEN RAISE EXCEPTION 'Test 12 FAIL: dust expense created'; END IF;
  SELECT SUM(vat) INTO v_vsum FROM po_deposit_applications WHERE po_id = po10;
  IF v_vsum <> 140.11 THEN RAISE EXCEPTION 'Test 12 FAIL: application VAT sum %', v_vsum; END IF;
  IF (SELECT status FROM purchase_orders WHERE id = po10) <> 'received' THEN RAISE EXCEPTION 'Test 12 FAIL: PO not received'; END IF;
  RAISE NOTICE 'Test 12 (one-satang rounding, no dust expense): PASSED';

  -- Test 13: a real VAT excess (0.50) still raises deposit_vat_exceeds_po
  INSERT INTO expenses (date, description, site_id, category_id, supplier_id, amount_no_vat, vat, amount, payment_method, status)
  VALUES (current_date, 'deposit 8', t_site, t_cat, t_sup, 100, 7.50, 107.50, 'transfer', 'paid') RETURNING id INTO e8;
  INSERT INTO supplier_deposits (expense_id, deposit_invoice_no) VALUES (e8, 'AI-T8') RETURNING id INTO d8;
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status, has_vat, price_includes_vat)
  VALUES (t_tenant, 'PO-PD-11', t_site, t_sup, t_cat, current_date, 'ordered', true, false) RETURNING id INTO po11;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total) VALUES (t_tenant, po11, 'item', 1, 100, 100);
  BEGIN
    PERFORM receive_po_with_deposits(po11,
      jsonb_build_array(jsonb_build_object('deposit_id', d8, 'amount_no_vat', 100)), 100, 7);
    RAISE EXCEPTION 'Test 13 FAIL: did not raise';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'deposit_vat_exceeds_po%' THEN RAISE EXCEPTION 'Test 13 FAIL: got %', v_msg; END IF;
  END;
  IF EXISTS (SELECT 1 FROM po_deposit_applications WHERE po_id = po11) OR (SELECT status FROM purchase_orders WHERE id = po11) <> 'ordered' THEN
    RAISE EXCEPTION 'Test 13 FAIL: something was written';
  END IF;
  RAISE NOTICE 'Test 13 (deposit_vat_exceeds_po on real excess): PASSED';

  -- Test 14 (C1): a received PO that carries deposit applications cannot be un-received or cancelled;
  -- ordinary edits still work; a received PO WITHOUT applications can still be reverted as before.
  BEGIN
    UPDATE purchase_orders SET status = 'ordered', received_date = NULL, expense_id = NULL WHERE id = po1;
    RAISE EXCEPTION 'Test 14 FAIL: un-receive did not raise';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'po_has_deposit_applications%' THEN RAISE EXCEPTION 'Test 14 FAIL: un-receive got %', v_msg; END IF;
  END;
  BEGIN
    UPDATE purchase_orders SET status = 'cancelled' WHERE id = po2;
    RAISE EXCEPTION 'Test 14 FAIL: cancel did not raise';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'po_has_deposit_applications%' THEN RAISE EXCEPTION 'Test 14 FAIL: cancel got %', v_msg; END IF;
  END;
  SELECT status INTO v_status FROM purchase_orders WHERE id = po1;
  IF v_status <> 'received' THEN RAISE EXCEPTION 'Test 14 FAIL: PO status changed to %', v_status; END IF;
  UPDATE purchase_orders SET notes = 'edited after receive' WHERE id = po1;   -- non-status edit is fine
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status, has_vat, price_includes_vat)
  VALUES (t_tenant, 'PO-PD-12', t_site, t_sup, t_cat, current_date, 'ordered', true, false) RETURNING id INTO po12;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total) VALUES (t_tenant, po12, 'item', 1, 100, 100);
  v_exp := receive_po_with_deposits(po12, '[]'::jsonb, 100, 7);
  IF v_exp IS NULL THEN RAISE EXCEPTION 'Test 14 FAIL: no-deposit receive made no expense'; END IF;
  UPDATE purchase_orders SET status = 'ordered', received_date = NULL WHERE id = po12;   -- no applications: allowed
  SELECT status INTO v_status FROM purchase_orders WHERE id = po12;
  IF v_status <> 'ordered' THEN RAISE EXCEPTION 'Test 14 FAIL: plain un-receive blocked'; END IF;
  RAISE NOTICE 'Test 14 (un-receive guard): PASSED';

  -- Test 15 (C1): the RPC refuses a PO that already carries applications even if it is 'ordered' again
  -- (simulated by a superuser bypassing the guard trigger inside this rolled-back transaction).
  RESET role;
  ALTER TABLE purchase_orders DISABLE TRIGGER po_block_unreceive_with_deposits_trg;
  UPDATE purchase_orders SET status = 'ordered', received_date = NULL, expense_id = NULL WHERE id = po1;
  ALTER TABLE purchase_orders ENABLE TRIGGER po_block_unreceive_with_deposits_trg;
  SET LOCAL role = 'authenticated';
  BEGIN
    PERFORM receive_po_with_deposits(po1, '[]'::jsonb, 9786.00, 685.02);
    RAISE EXCEPTION 'Test 15 FAIL: re-receive did not raise';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'po_has_deposit_applications%' THEN RAISE EXCEPTION 'Test 15 FAIL: got %', v_msg; END IF;
  END;
  RAISE NOTICE 'Test 15 (re-receive guard): PASSED';

  -- Test 16: second application on a partly used deposit, last-use VAT path.
  -- Deposit 333.33 / 23.33. PO A (100 / 7.00) takes 100 -> VAT 7.00 (pro-rated). PO B (233.33 / 16.33) takes the
  -- remaining 233.33 -> VAT = remaining 16.33 exactly, so applications sum to the deposit VAT and no expense is created.
  INSERT INTO expenses (date, description, site_id, category_id, supplier_id, amount_no_vat, vat, amount, payment_method, status)
  VALUES (current_date, 'deposit 9', t_site, t_cat, t_sup, 333.33, 23.33, 356.66, 'transfer', 'paid') RETURNING id INTO e9;
  INSERT INTO supplier_deposits (expense_id, deposit_invoice_no) VALUES (e9, 'AI-T9') RETURNING id INTO d9;
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status, has_vat, price_includes_vat)
  VALUES (t_tenant, 'PO-PD-13', t_site, t_sup, t_cat, current_date, 'ordered', true, false) RETURNING id INTO po13;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total) VALUES (t_tenant, po13, 'item', 1, 100, 100);
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status, has_vat, price_includes_vat)
  VALUES (t_tenant, 'PO-PD-14', t_site, t_sup, t_cat, current_date, 'ordered', true, false) RETURNING id INTO po14;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total) VALUES (t_tenant, po14, 'item', 1, 233.33, 233.33);
  v_exp := receive_po_with_deposits(po13, jsonb_build_array(jsonb_build_object('deposit_id', d9, 'amount_no_vat', 100)), 100, 7);
  IF v_exp IS NOT NULL THEN RAISE EXCEPTION 'Test 16 FAIL: PO A should be fully covered, expense %', v_exp; END IF;
  SELECT amount_no_vat, vat INTO r FROM po_deposit_applications WHERE po_id = po13;
  IF r.amount_no_vat <> 100 OR r.vat <> 7.00 THEN RAISE EXCEPTION 'Test 16 FAIL: first application % / %', r.amount_no_vat, r.vat; END IF;
  v_exp := receive_po_with_deposits(po14, jsonb_build_array(jsonb_build_object('deposit_id', d9, 'amount_no_vat', 233.33)), 233.33, 16.33);
  IF v_exp IS NOT NULL THEN RAISE EXCEPTION 'Test 16 FAIL: PO B should be fully covered, expense %', v_exp; END IF;
  SELECT amount_no_vat, vat INTO r FROM po_deposit_applications WHERE po_id = po14;
  IF r.amount_no_vat <> 233.33 OR r.vat <> 16.33 THEN RAISE EXCEPTION 'Test 16 FAIL: last application % / %', r.amount_no_vat, r.vat; END IF;
  SELECT SUM(vat) INTO v_vsum FROM po_deposit_applications WHERE deposit_id = d9;
  IF (SELECT SUM(amount_no_vat) FROM po_deposit_applications WHERE deposit_id = d9) <> 333.33 OR v_vsum <> 23.33 THEN
    RAISE EXCEPTION 'Test 16 FAIL: deposit not consumed exactly';
  END IF;
  -- a third use of the exhausted deposit is rejected
  BEGIN
    PERFORM receive_po_with_deposits(po4, jsonb_build_array(jsonb_build_object('deposit_id', d9, 'amount_no_vat', 0.01)), 9786.00, 685.02);
    RAISE EXCEPTION 'Test 16 FAIL: exhausted deposit accepted';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'deposit_exceeds_remaining%' THEN RAISE EXCEPTION 'Test 16 FAIL: got %', v_msg; END IF;
  END;
  RAISE NOTICE 'Test 16 (second application, last-use VAT): PASSED';

  -- Test 17: VAT-inclusive PO (107 incl. VAT -> 100.00 / 7.00) with a 40 / 2.80 deposit -> remainder 60.00 / 4.20 / 64.20
  INSERT INTO expenses (date, description, site_id, category_id, supplier_id, amount_no_vat, vat, amount, payment_method, status)
  VALUES (current_date, 'deposit 10', t_site, t_cat, t_sup, 40, 2.80, 42.80, 'transfer', 'paid') RETURNING id INTO e10;
  INSERT INTO supplier_deposits (expense_id, deposit_invoice_no) VALUES (e10, 'AI-T10') RETURNING id INTO d10;
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status, has_vat, price_includes_vat)
  VALUES (t_tenant, 'PO-PD-15', t_site, t_sup, t_cat, current_date, 'ordered', true, true) RETURNING id INTO po15;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total) VALUES (t_tenant, po15, 'item', 1, 107, 107);
  v_exp := receive_po_with_deposits(po15, jsonb_build_array(jsonb_build_object('deposit_id', d10, 'amount_no_vat', 40)), 100, 7);
  SELECT amount_no_vat, vat, amount INTO r FROM expenses WHERE id = v_exp;
  IF v_exp IS NULL OR r.amount_no_vat <> 60 OR r.vat <> 4.20 OR r.amount <> 64.20 THEN
    RAISE EXCEPTION 'Test 17 FAIL: expense % / % / %', r.amount_no_vat, r.vat, r.amount;
  END IF;
  RAISE NOTICE 'Test 17 (VAT-inclusive PO): PASSED';

  -- Test 18: no-VAT PO (500) with a VAT-free 200 deposit -> remainder 300.00 / 0 / 300.00
  INSERT INTO expenses (date, description, site_id, category_id, supplier_id, amount_no_vat, vat, amount, payment_method, status)
  VALUES (current_date, 'deposit 11', t_site, t_cat, t_sup, 200, 0, 200, 'transfer', 'paid') RETURNING id INTO e11;
  INSERT INTO supplier_deposits (expense_id, deposit_invoice_no) VALUES (e11, 'AI-T11') RETURNING id INTO d11;
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status, has_vat, price_includes_vat)
  VALUES (t_tenant, 'PO-PD-16', t_site, t_sup, t_cat, current_date, 'ordered', false, false) RETURNING id INTO po16;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total) VALUES (t_tenant, po16, 'item', 1, 500, 500);
  v_exp := receive_po_with_deposits(po16, jsonb_build_array(jsonb_build_object('deposit_id', d11, 'amount_no_vat', 200)), 500, 0);
  SELECT amount_no_vat, vat, amount INTO r FROM expenses WHERE id = v_exp;
  IF v_exp IS NULL OR r.amount_no_vat <> 300 OR r.vat <> 0 OR r.amount <> 300 THEN
    RAISE EXCEPTION 'Test 18 FAIL: expense % / % / %', r.amount_no_vat, r.vat, r.amount;
  END IF;
  RAISE NOTICE 'Test 18 (no-VAT PO): PASSED';

  -- Test 19: an applied deposit (d1) keeps its expense, number and id
  BEGIN
    UPDATE supplier_deposits SET expense_id = e_dep3 WHERE id = d1;
    RAISE EXCEPTION 'Test 19 FAIL: expense_id update did not raise';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'deposit_in_use%' THEN RAISE EXCEPTION 'Test 19 FAIL: expense_id got %', v_msg; END IF;
  END;
  BEGIN
    UPDATE supplier_deposits SET deposit_invoice_no = 'AI-RENAMED' WHERE id = d1;
    RAISE EXCEPTION 'Test 19 FAIL: deposit_invoice_no update did not raise';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'deposit_in_use%' THEN RAISE EXCEPTION 'Test 19 FAIL: invoice no got %', v_msg; END IF;
  END;
  RAISE NOTICE 'Test 19 (applied deposit identity locked): PASSED';

  -- Test 20: setting po_id on a deposit expense is rejected (unapplied deposit e_dep3; applied deposit e_dep)
  BEGIN
    UPDATE expenses SET po_id = po4 WHERE id = e_dep3;
    RAISE EXCEPTION 'Test 20 FAIL: po_id on registered deposit expense accepted';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'deposit_expense_is_po_generated%' THEN RAISE EXCEPTION 'Test 20 FAIL: got %', v_msg; END IF;
  END;
  BEGIN
    UPDATE expenses SET po_id = po4 WHERE id = e_dep;
    RAISE EXCEPTION 'Test 20 FAIL: po_id on applied deposit expense accepted';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'deposit_in_use%' THEN RAISE EXCEPTION 'Test 20 FAIL: applied got %', v_msg; END IF;
  END;
  RAISE NOTICE 'Test 20 (po_id on deposit expense rejected): PASSED';

  -- Test 21 (I1): an applied deposit's expense still allows status / date / notes changes (money fields stay locked: Test 8)
  UPDATE expenses SET status = 'pending', notes = 'status change after apply', date = current_date - 1 WHERE id = e_dep;
  SELECT status, notes INTO r FROM expenses WHERE id = e_dep;
  IF r.status <> 'pending' OR r.notes <> 'status change after apply' THEN RAISE EXCEPTION 'Test 21 FAIL: edit not applied'; END IF;
  UPDATE expenses SET status = 'paid' WHERE id = e_dep;
  RAISE NOTICE 'Test 21 (applied deposit expense: status/notes/date editable): PASSED';

  -- Test 22: tenant_can_write() = false (expired tenant that still has the module) -> RPC and deposit writes rejected
  PERFORM set_config('request.jwt.claims', '{"email":"' || email3 || '"}', true);
  IF NOT (is_admin_or_owner() AND has_module_access('purchase_orders') AND NOT tenant_can_write()) THEN
    RAISE EXCEPTION 'Test 22 FAIL: fixture does not isolate tenant_can_write (admin=%, module=%, can_write=%)',
      is_admin_or_owner(), has_module_access('purchase_orders'), tenant_can_write();
  END IF;
  BEGIN
    PERFORM receive_po_with_deposits(t3_po, '[]'::jsonb, 100, 7);
    RAISE EXCEPTION 'Test 22 FAIL: read-only tenant received a PO';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'insufficient_privilege%' THEN RAISE EXCEPTION 'Test 22 FAIL: got %', v_msg; END IF;
  END;
  BEGIN
    INSERT INTO supplier_deposits (expense_id, deposit_invoice_no) VALUES (t3_exp, 'AI-T3RO');
    RAISE EXCEPTION 'Test 22 FAIL: read-only tenant registered a deposit';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  PERFORM set_config('request.jwt.claims', '{"email":"' || email || '"}', true);
  RAISE NOTICE 'Test 22 (tenant_can_write false rejected): PASSED';

  -- Test 23: anon cannot execute the receive RPC
  IF has_function_privilege('anon', 'receive_po_with_deposits(uuid,jsonb,numeric,numeric)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'receive_po_with_deposits(uuid,jsonb,numeric,numeric)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Test 23 FAIL: EXECUTE grants wrong';
  END IF;
  BEGIN
    SET LOCAL role = 'anon';
    PERFORM receive_po_with_deposits(po4, '[]'::jsonb, 9786.00, 685.02);
    RAISE EXCEPTION 'Test 23 FAIL: anon call succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  SET LOCAL role = 'authenticated';
  RAISE NOTICE 'Test 23 (anon EXECUTE denied): PASSED';

  RAISE NOTICE 'ALL PO DEPOSIT TESTS PASSED';

  RESET role;
END $$;

ROLLBACK;
