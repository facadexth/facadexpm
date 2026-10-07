-- ================================================================
-- Tests for 2026-10-09-02-po-receipt-rpcs.sql. Part B of 3.
-- Dry-run only: BEGIN; SET LOCAL lock_timeout='5s'; 2026-10-09-01; 2026-10-09-02; this body (BEGIN;/ROLLBACK; stripped); ROLLBACK;
-- Success = an ERROR containing 'RESULT: po_receipt_test_b ALL PASSED'. Anything else = failure.
-- Concurrency cannot be tested in one session; B4 is the sequential stand-in (the PO row lock serialises real double clicks).
-- ================================================================
BEGIN;
DO $$
DECLARE
  t_owner UUID; t_tenant UUID; t_site UUID; t_sup UUID; t_sup2 UUID; t_cat UUID; t_item UUID;
  email TEXT := '__test_prb_owner__@example.com'; w_email TEXT := '__test_prb_worker__@example.com';
  t2_tenant UUID; t2_site UUID; t2_sup UUID; t2_cat UUID; t2_po UUID; t2_exp UUID; t2_dep UUID;
  t3_tenant UUID; t3_site UUID; t3_sup UUID; t3_cat UUID; t3_po UUID; email3 TEXT := '__test_prb_owner3__@example.com';
  poA UUID; a1 UUID; a2 UUID; poT UUID; t1 UUID; poI UUID; i1 UUID; i2 UUID; poC UUID; c1 UUID; poF UUID; f1 UUID; poS UUID; s1 UUID; poL UUID; l1 UUID; poP UUID; p1 UUID;
  v_bkk DATE := (now() AT TIME ZONE 'Asia/Bangkok')::date;
  j JSONB; r RECORD; v_msg TEXT; v_cnt INT; depA UUID; depT UUID; depC UUID; e_leg UUID; d_leg UUID; e_leg2 UUID; d_leg2 UUID;
  bill1 UUID; bill2 UUID; rem1 UUID; rem2 UUID;
  poR UUID; rr1 UUID; rr2 UUID; poD UUID; dd1 UUID; v_ti UUID; e_leg3 UUID; d_leg3 UUID;
  poO UUID; oo1 UUID; e_leg4 UUID; d_leg4 UUID; poV UUID; vv1 UUID; e_v UUID; d_v UUID; poN UUID; nn1 UUID; nn2 UUID;
BEGIN
  SELECT id INTO t_owner FROM auth.users ORDER BY created_at ASC LIMIT 1;
  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at) VALUES ('__TEST prb__', t_owner, 'trial', now() + interval '14 days') RETURNING id INTO t_tenant;
  INSERT INTO user_roles (user_email, role, status, tenant_id) VALUES (email, 'OWNER', 'approved', t_tenant);
  INSERT INTO user_roles (user_email, role, status, tenant_id) VALUES (w_email, 'WORKER', 'approved', t_tenant);
  INSERT INTO sites (tenant_id, site_number, name) VALUES (t_tenant, '__PRB-1__', '__prb site__') RETURNING id INTO t_site;
  INSERT INTO suppliers (tenant_id, name) VALUES (t_tenant, '__prb sup__') RETURNING id INTO t_sup;
  INSERT INTO suppliers (tenant_id, name) VALUES (t_tenant, '__prb sup2__') RETURNING id INTO t_sup2;
  INSERT INTO expense_categories (tenant_id, name) VALUES (t_tenant, '__prb cat__') RETURNING id INTO t_cat;
  INSERT INTO inventory_items (tenant_id, name, base_unit) VALUES (t_tenant, '__prb item__', 'kg') RETURNING id INTO t_item;
  -- tenant 2 (isolation)
  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at) VALUES ('__TEST prb2__', t_owner, 'trial', now() + interval '14 days') RETURNING id INTO t2_tenant;
  INSERT INTO sites (tenant_id, site_number, name) VALUES (t2_tenant, '__PRB-2__', '__prb site2__') RETURNING id INTO t2_site;
  INSERT INTO suppliers (tenant_id, name) VALUES (t2_tenant, '__prb t2 sup__') RETURNING id INTO t2_sup;
  INSERT INTO expense_categories (tenant_id, name) VALUES (t2_tenant, '__prb t2 cat__') RETURNING id INTO t2_cat;
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status) VALUES (t2_tenant, 'PO-PRB-T2', t2_site, t2_sup, t2_cat, current_date, 'ordered') RETURNING id INTO t2_po;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total) VALUES (t2_tenant, t2_po, 'x', 1, 100, 100);
  INSERT INTO expenses (tenant_id, date, description, site_id, category_id, supplier_id, amount_no_vat, vat, amount, payment_method, status)
  VALUES (t2_tenant, current_date, 't2 dep', t2_site, t2_cat, t2_sup, 100, 7, 107, 'transfer', 'paid') RETURNING id INTO t2_exp;
  INSERT INTO supplier_deposits (tenant_id, expense_id, deposit_invoice_no) VALUES (t2_tenant, t2_exp, 'PRB-T2') RETURNING id INTO t2_dep;
  -- tenant 3: read-only (plan expired) but module kept
  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at) VALUES ('__TEST prb3__', t_owner, 'expired', now() - interval '1 day') RETURNING id INTO t3_tenant;
  INSERT INTO tenant_modules (tenant_id, module_key) VALUES (t3_tenant, 'purchase_orders');
  INSERT INTO user_roles (user_email, role, status, tenant_id) VALUES (email3, 'OWNER', 'approved', t3_tenant);
  INSERT INTO sites (tenant_id, site_number, name) VALUES (t3_tenant, '__PRB-3__', '__prb site3__') RETURNING id INTO t3_site;
  INSERT INTO suppliers (tenant_id, name) VALUES (t3_tenant, '__prb t3 sup__') RETURNING id INTO t3_sup;
  INSERT INTO expense_categories (tenant_id, name) VALUES (t3_tenant, '__prb t3 cat__') RETURNING id INTO t3_cat;
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status) VALUES (t3_tenant, 'PO-PRB-T3', t3_site, t3_sup, t3_cat, current_date, 'ordered') RETURNING id INTO t3_po;

  SET LOCAL role = 'authenticated';
  PERFORM set_config('request.jwt.claims', '{"email":"' || email || '"}', true);

  -- poA: 60,000 (stock) + 40,000 (no stock), VAT excl. -> 107,000
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status) VALUES (t_tenant, 'PO-PRB-A', t_site, t_sup, t_cat, v_bkk - 30, 'ordered') RETURNING id INTO poA;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total, inventory_item_id, sort_order) VALUES (t_tenant, poA, 'A1', 1, 60000, 60000, t_item, 0) RETURNING id INTO a1;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total, sort_order) VALUES (t_tenant, poA, 'A2', 1, 40000, 40000, 1) RETURNING id INTO a2;
  -- poT: ไทย-เยอรมัน replica 206,730 + 14,471.10
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status) VALUES (t_tenant, 'PO-PRB-T', t_site, t_sup, t_cat, v_bkk - 20, 'ordered') RETURNING id INTO poT;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total) VALUES (t_tenant, poT, 'glass', 1, 206730, 206730) RETURNING id INTO t1;
  -- poI: VAT-inclusive 100 + 200
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status, price_includes_vat) VALUES (t_tenant, 'PO-PRB-I', t_site, t_sup, t_cat, v_bkk, 'ordered', true) RETURNING id INTO poI;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total, sort_order) VALUES (t_tenant, poI, 'I1', 1, 100, 100, 0) RETURNING id INTO i1;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total, sort_order) VALUES (t_tenant, poI, 'I2', 1, 200, 200, 1) RETURNING id INTO i2;
  -- poC: for deduction errors (1,000 excl.)
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status) VALUES (t_tenant, 'PO-PRB-C', t_site, t_sup, t_cat, v_bkk, 'ordered') RETURNING id INTO poC;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total) VALUES (t_tenant, poC, 'C1', 1, 1000, 1000) RETURNING id INTO c1;
  -- poF: stock_from_invoice, stock line
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status, stock_from_invoice) VALUES (t_tenant, 'PO-PRB-F', t_site, t_sup, t_cat, v_bkk, 'ordered', true) RETURNING id INTO poF;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total, inventory_item_id) VALUES (t_tenant, poF, 'F1', 2, 50, 100, t_item) RETURNING id INTO f1;
  -- poS: stock line for plan errors
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status) VALUES (t_tenant, 'PO-PRB-S', t_site, t_sup, t_cat, v_bkk, 'ordered') RETURNING id INTO poS;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total, inventory_item_id) VALUES (t_tenant, poS, 'S1', 4, 25, 100, t_item) RETURNING id INTO s1;
  -- poL: legacy application (receipt_id NULL) on an ordered PO
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status) VALUES (t_tenant, 'PO-PRB-L', t_site, t_sup, t_cat, v_bkk, 'ordered') RETURNING id INTO poL;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total) VALUES (t_tenant, poL, 'L1', 1, 100, 100) RETURNING id INTO l1;
  -- poP: plain PO for the legacy RPC regression
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status) VALUES (t_tenant, 'PO-PRB-P', t_site, t_sup, t_cat, v_bkk, 'ordered') RETURNING id INTO poP;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total) VALUES (t_tenant, poP, 'P1', 1, 100, 100) RETURNING id INTO p1;
  -- poR: two plain lines, for the tax-invoice interplay (B17)
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status) VALUES (t_tenant, 'PO-PRB-R', t_site, t_sup, t_cat, v_bkk, 'ordered') RETURNING id INTO poR;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total, sort_order) VALUES (t_tenant, poR, 'R1', 1, 100, 100, 0) RETURNING id INTO rr1;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total, sort_order) VALUES (t_tenant, poR, 'R2', 1, 50, 50, 1) RETURNING id INTO rr2;
  -- poD: for the PO-linked deposit lock (B18)
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status) VALUES (t_tenant, 'PO-PRB-D', t_site, t_sup, t_cat, v_bkk, 'ordered') RETURNING id INTO poD;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total) VALUES (t_tenant, poD, 'D1', 1, 100, 100) RETURNING id INTO dd1;
  -- poO: legacy RPC with a legacy deposit (B20); poV: VAT fold capped by the deposit's VAT (B21); poN: discount line (B22)
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status) VALUES (t_tenant, 'PO-PRB-O', t_site, t_sup, t_cat, v_bkk, 'ordered') RETURNING id INTO poO;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total) VALUES (t_tenant, poO, 'O1', 1, 100, 100) RETURNING id INTO oo1;
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status) VALUES (t_tenant, 'PO-PRB-V', t_site, t_sup, t_cat, v_bkk, 'ordered') RETURNING id INTO poV;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total) VALUES (t_tenant, poV, 'V1', 1, 100, 100) RETURNING id INTO vv1;
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status) VALUES (t_tenant, 'PO-PRB-N', t_site, t_sup, t_cat, v_bkk, 'ordered') RETURNING id INTO poN;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total, sort_order) VALUES (t_tenant, poN, 'N1', 1, 100, 100, 0) RETURNING id INTO nn1;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total, sort_order) VALUES (t_tenant, poN, 'discount', 1, -10, -10, 1) RETURNING id INTO nn2;

  -- B1: create_po_deposit 30 % of poA
  j := create_po_deposit(poA, 'percent', 30, 'PRB-DEP-A', v_bkk - 25, 'transfer', 'paid');
  depA := (j->>'deposit_id')::uuid;
  IF (j->>'amount')::numeric <> 32100 OR (j->>'amount_no_vat')::numeric <> 30000 OR (j->>'vat')::numeric <> 2100 OR (j->>'pct_of_po')::numeric <> 30 THEN RAISE EXCEPTION 'B1 FAIL: %', j; END IF;
  SELECT * INTO r FROM expenses WHERE id = (j->>'expense_id')::uuid;
  IF r.po_id IS NOT NULL OR r.amount <> 32100 OR r.invoice_no <> 'PRB-DEP-A' OR r.status <> 'paid' OR r.date <> v_bkk - 25 OR r.supplier_id <> t_sup THEN RAISE EXCEPTION 'B1 FAIL: expense %', row_to_json(r); END IF;
  SELECT po_id, pct_of_po INTO r FROM supplier_deposits WHERE id = depA;
  IF r.po_id <> poA OR r.pct_of_po <> 30 THEN RAISE EXCEPTION 'B1 FAIL: deposit row'; END IF;

  -- B2: create_po_deposit errors
  BEGIN PERFORM create_po_deposit(poA, 'percent', 10, 'PRB-DEP-A2', v_bkk, 'transfer', 'paid'); RAISE EXCEPTION 'B2 FAIL: second deposit';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'po_has_deposit%' THEN RAISE EXCEPTION 'B2 FAIL: %', v_msg; END IF; END;
  BEGIN PERFORM create_po_deposit(poC, 'amount', 10, 'PRB-DEP-A', v_bkk, 'transfer', 'paid'); RAISE EXCEPTION 'B2 FAIL: duplicate number';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'deposit_invoice_no_taken%' THEN RAISE EXCEPTION 'B2 FAIL: %', v_msg; END IF; END;
  BEGIN PERFORM create_po_deposit(poC, 'amount', 1070.01, 'PRB-X1', v_bkk, 'transfer', 'paid'); RAISE EXCEPTION 'B2 FAIL: over PO';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'deposit_exceeds_po%' THEN RAISE EXCEPTION 'B2 FAIL: %', v_msg; END IF; END;
  BEGIN PERFORM create_po_deposit(poC, 'percent', 101, 'PRB-X1', v_bkk, 'transfer', 'paid'); RAISE EXCEPTION 'B2 FAIL: 101 pct';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'bad_deposit_value%' THEN RAISE EXCEPTION 'B2 FAIL: %', v_msg; END IF; END;
  BEGIN PERFORM create_po_deposit(poC, 'percent', 10, '  ', v_bkk, 'transfer', 'paid'); RAISE EXCEPTION 'B2 FAIL: blank number';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'deposit_invoice_no_required%' THEN RAISE EXCEPTION 'B2 FAIL: %', v_msg; END IF; END;
  BEGIN PERFORM create_po_deposit(poC, 'percent', 10, 'PRB-X1', v_bkk + 1, 'transfer', 'paid'); RAISE EXCEPTION 'B2 FAIL: future date';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'bad_deposit_date%' THEN RAISE EXCEPTION 'B2 FAIL: %', v_msg; END IF; END;
  BEGIN PERFORM create_po_deposit(poC, 'percent', 10, 'PRB-X1', v_bkk, 'credit', 'paid'); RAISE EXCEPTION 'B2 FAIL: method';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'bad_payment_method%' THEN RAISE EXCEPTION 'B2 FAIL: %', v_msg; END IF; END;

  -- B3: receive line A1 only, two days ago, own deposit 19,260 by value
  j := receive_po_lines(poA, ARRAY[a1], v_bkk - 2, jsonb_build_array(jsonb_build_object('deposit_id', depA, 'mode', 'value', 'value', 19260)),
                        60000, 4200, jsonb_build_array(jsonb_build_object('po_item_id', a1, 'base_qty', 1, 'unit_cost', 60000)));
  bill1 := (j->>'expense_id')::uuid;
  IF j->>'status' <> 'partially_received' OR (j->>'seq')::int <> 1 OR j->>'receipt_no' <> 'PO-PRB-A-R1' OR bill1 IS NULL THEN RAISE EXCEPTION 'B3 FAIL: %', j; END IF;
  SELECT * INTO r FROM expenses WHERE id = bill1;
  IF r.amount_no_vat <> 42000 OR r.vat <> 2940 OR r.amount <> 44940 OR r.po_id <> poA OR r.date <> v_bkk - 30 OR r.status <> 'pending' THEN RAISE EXCEPTION 'B3 FAIL: bill %', row_to_json(r); END IF;
  SELECT amount_no_vat, vat, receipt_id INTO r FROM po_deposit_applications WHERE deposit_id = depA;
  IF r.amount_no_vat <> 18000 OR r.vat <> 1260 OR r.receipt_id <> (j->>'receipt_id')::uuid THEN RAISE EXCEPTION 'B3 FAIL: application'; END IF;
  SELECT status, received_date, expense_id INTO r FROM purchase_orders WHERE id = poA;
  IF r.status <> 'partially_received' OR r.received_date <> v_bkk - 2 OR r.expense_id <> bill1 THEN RAISE EXCEPTION 'B3 FAIL: PO %', row_to_json(r); END IF;
  SELECT m.* INTO r FROM stock_movements m JOIN po_receipt_items pri ON pri.stock_movement_id = m.id WHERE pri.po_item_id = a1;
  IF r.quantity <> 1 OR r.unit_cost <> 60000 OR r.reference_type <> 'purchase_order' OR r.reference_id <> poA OR r.movement_type <> 'purchase_in'
     OR r.created_at <> ((v_bkk - 2) + time '12:00') AT TIME ZONE 'Asia/Bangkok' OR r.notes <> 'PO-PRB-A-R1' THEN RAISE EXCEPTION 'B3 FAIL: movement %', row_to_json(r); END IF;
  SELECT goods_subtotal, goods_vat INTO r FROM po_receipts WHERE id = (j->>'receipt_id')::uuid;
  IF r.goods_subtotal <> 60000 OR r.goods_vat <> 4200 THEN RAISE EXCEPTION 'B3 FAIL: receipt value'; END IF;

  -- B20: poA's own deposit (12,840 left) cannot be deducted on another PO of the same supplier, by either RPC
  BEGIN PERFORM receive_po_lines(poC, ARRAY[c1], v_bkk, jsonb_build_array(jsonb_build_object('deposit_id', depA, 'mode', 'value', 'value', 10)), 1000, 70, '[]'::jsonb);
        RAISE EXCEPTION 'B20 FAIL: new RPC used another PO''s deposit';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'deposit_other_po%' THEN RAISE EXCEPTION 'B20 FAIL: %', v_msg; END IF; END;
  BEGIN PERFORM receive_po_with_deposits(poC, jsonb_build_array(jsonb_build_object('deposit_id', depA, 'amount_no_vat', 10)), 1000, 70);
        RAISE EXCEPTION 'B20 FAIL: legacy RPC used another PO''s deposit';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'deposit_other_po%' THEN RAISE EXCEPTION 'B20 FAIL: %', v_msg; END IF; END;
  IF (SELECT status FROM purchase_orders WHERE id = poC) <> 'ordered' THEN RAISE EXCEPTION 'B20 FAIL: poC moved'; END IF;

  -- B4: the same line again (double click) and a stale total
  BEGIN PERFORM receive_po_lines(poA, ARRAY[a1], v_bkk, '[]'::jsonb, 60000, 4200, jsonb_build_array(jsonb_build_object('po_item_id', a1, 'base_qty', 1, 'unit_cost', 60000))); RAISE EXCEPTION 'B4 FAIL: line received twice';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'line_already_received%' THEN RAISE EXCEPTION 'B4 FAIL: %', v_msg; END IF; END;
  BEGIN PERFORM receive_po_lines(poA, ARRAY[a2], v_bkk, '[]'::jsonb, 40000.50, 2800, '[]'::jsonb); RAISE EXCEPTION 'B4 FAIL: totals';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'totals_mismatch%' THEN RAISE EXCEPTION 'B4 FAIL: %', v_msg; END IF; END;
  BEGIN PERFORM receive_po_lines(poA, ARRAY[a2, a2], v_bkk, '[]'::jsonb, 40000, 2800, '[]'::jsonb); RAISE EXCEPTION 'B4 FAIL: duplicate ids';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'bad_lines%' THEN RAISE EXCEPTION 'B4 FAIL: %', v_msg; END IF; END;
  BEGIN PERFORM receive_po_lines(poA, ARRAY[t1], v_bkk, '[]'::jsonb, 0, 0, '[]'::jsonb); RAISE EXCEPTION 'B4 FAIL: line of another PO';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'bad_lines%' THEN RAISE EXCEPTION 'B4 FAIL: %', v_msg; END IF; END;

  -- B5: final receipt A2, whole remaining deposit 12,840 -> deposit used up exactly
  j := receive_po_lines(poA, ARRAY[a2], v_bkk, jsonb_build_array(jsonb_build_object('deposit_id', depA, 'mode', 'value', 'value', 12840)), 40000, 2800, '[]'::jsonb);
  bill2 := (j->>'expense_id')::uuid;
  IF j->>'status' <> 'received' OR (j->>'seq')::int <> 2 THEN RAISE EXCEPTION 'B5 FAIL: %', j; END IF;
  SELECT * INTO r FROM expenses WHERE id = bill2;
  IF r.amount_no_vat <> 28000 OR r.vat <> 1960 OR r.amount <> 29960 THEN RAISE EXCEPTION 'B5 FAIL: bill %', row_to_json(r); END IF;
  SELECT sum(amount_no_vat) AS n, sum(vat) AS v INTO r FROM po_deposit_applications WHERE deposit_id = depA;
  IF r.n <> 30000 OR r.v <> 2100 THEN RAISE EXCEPTION 'B5 FAIL: deposit not used up exactly (% / %)', r.n, r.v; END IF;
  SELECT status, received_date, expense_id INTO r FROM purchase_orders WHERE id = poA;
  IF r.status <> 'received' OR r.received_date <> v_bkk OR r.expense_id <> bill1 THEN RAISE EXCEPTION 'B5 FAIL: PO %', row_to_json(r); END IF;
  SELECT sum(goods_subtotal) AS s, sum(goods_vat) AS v INTO r FROM po_receipts WHERE po_id = poA;
  IF r.s <> 100000 OR r.v <> 7000 THEN RAISE EXCEPTION 'B5 FAIL: receipts do not add up'; END IF;

  -- B6: a received PO cannot be received again
  BEGIN PERFORM receive_po_lines(poA, ARRAY[a2], v_bkk, '[]'::jsonb, 0, 0, '[]'::jsonb); RAISE EXCEPTION 'B6 FAIL';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'po_not_receivable%' THEN RAISE EXCEPTION 'B6 FAIL: %', v_msg; END IF; END;

  -- B7: ไทย-เยอรมัน: 50 % deposit, receive all, deduct it all
  j := create_po_deposit(poT, 'percent', 50, 'PRB-2602543', v_bkk - 15, 'transfer', 'paid');
  depT := (j->>'deposit_id')::uuid;
  IF (j->>'amount')::numeric <> 110600.55 OR (j->>'amount_no_vat')::numeric <> 103365 OR (j->>'vat')::numeric <> 7235.55 THEN RAISE EXCEPTION 'B7 FAIL: deposit %', j; END IF;
  j := receive_po_lines(poT, ARRAY[t1], v_bkk, jsonb_build_array(jsonb_build_object('deposit_id', depT, 'mode', 'value', 'value', 110600.55)), 206730, 14471.10, '[]'::jsonb);
  SELECT * INTO r FROM expenses WHERE id = (j->>'expense_id')::uuid;
  IF r.amount_no_vat <> 103365 OR r.vat <> 7235.55 OR r.amount <> 110600.55 OR j->>'status' <> 'received' THEN RAISE EXCEPTION 'B7 FAIL: bill %', row_to_json(r); END IF;

  -- B8: VAT-inclusive PO in two receipts adds up exactly
  j := receive_po_lines(poI, ARRAY[i1], v_bkk, '[]'::jsonb, 93.46, 6.54, '[]'::jsonb);
  j := receive_po_lines(poI, ARRAY[i2], v_bkk, '[]'::jsonb, 186.91, 13.09, '[]'::jsonb);
  SELECT sum(goods_subtotal) AS s, sum(goods_vat) AS v INTO r FROM po_receipts WHERE po_id = poI;
  IF r.s <> 280.37 OR r.v <> 19.63 THEN RAISE EXCEPTION 'B8 FAIL: % / %', r.s, r.v; END IF;

  -- B9: deduction errors (poC 1,070 incl. VAT), legacy deposit usable
  INSERT INTO expenses (date, description, site_id, category_id, supplier_id, amount_no_vat, vat, amount, payment_method, status)
  VALUES (v_bkk, 'legacy dep', t_site, t_cat, t_sup, 500, 35, 535, 'transfer', 'paid') RETURNING id INTO e_leg;
  INSERT INTO supplier_deposits (expense_id, deposit_invoice_no) VALUES (e_leg, 'PRB-LEG') RETURNING id INTO d_leg;
  INSERT INTO expenses (date, description, site_id, category_id, supplier_id, amount_no_vat, vat, amount, payment_method, status)
  VALUES (v_bkk, 'other sup dep', t_site, t_cat, t_sup2, 500, 35, 535, 'transfer', 'paid') RETURNING id INTO e_leg2;
  INSERT INTO supplier_deposits (expense_id, deposit_invoice_no) VALUES (e_leg2, 'PRB-LEG2') RETURNING id INTO d_leg2;
  BEGIN PERFORM receive_po_lines(poC, ARRAY[c1], v_bkk, jsonb_build_array(jsonb_build_object('deposit_id', d_leg, 'mode', 'value', 'value', 535.01)), 1000, 70, '[]'::jsonb); RAISE EXCEPTION 'B9 FAIL: over remaining';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'deposit_exceeds_remaining%' THEN RAISE EXCEPTION 'B9 FAIL: %', v_msg; END IF; END;
  BEGIN PERFORM receive_po_lines(poC, ARRAY[c1], v_bkk, jsonb_build_array(jsonb_build_object('deposit_id', d_leg, 'mode', 'percent', 'value', 101)), 1000, 70, '[]'::jsonb); RAISE EXCEPTION 'B9 FAIL: 101 pct';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'bad_deduction%' THEN RAISE EXCEPTION 'B9 FAIL: %', v_msg; END IF; END;
  BEGIN PERFORM receive_po_lines(poC, ARRAY[c1], v_bkk, jsonb_build_array(jsonb_build_object('deposit_id', d_leg2, 'mode', 'value', 'value', 10)), 1000, 70, '[]'::jsonb); RAISE EXCEPTION 'B9 FAIL: wrong supplier';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'deposit_wrong_supplier%' THEN RAISE EXCEPTION 'B9 FAIL: %', v_msg; END IF; END;
  BEGIN PERFORM receive_po_lines(poC, ARRAY[c1], v_bkk, jsonb_build_array(jsonb_build_object('deposit_id', t2_dep, 'mode', 'value', 'value', 10)), 1000, 70, '[]'::jsonb); RAISE EXCEPTION 'B9 FAIL: other tenant deposit';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'deposit_not_found%' THEN RAISE EXCEPTION 'B9 FAIL: %', v_msg; END IF; END;
  BEGIN PERFORM receive_po_lines(poC, ARRAY[c1], v_bkk, jsonb_build_array(jsonb_build_object('deposit_id', d_leg, 'mode', 'value', 'value', 0)), 1000, 70, '[]'::jsonb); RAISE EXCEPTION 'B9 FAIL: zero';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'bad_deduction%' THEN RAISE EXCEPTION 'B9 FAIL: %', v_msg; END IF; END;
  -- B9b: legacy deposit (pct_of_po NULL) by percent of the receipt: 50 % of 1,070 = 535 = the whole deposit
  j := receive_po_lines(poC, ARRAY[c1], v_bkk, jsonb_build_array(jsonb_build_object('deposit_id', d_leg, 'mode', 'percent', 'value', 50)), 1000, 70, '[]'::jsonb);
  SELECT amount_no_vat, vat INTO r FROM po_deposit_applications WHERE deposit_id = d_leg;
  IF r.amount_no_vat <> 500 OR r.vat <> 35 THEN RAISE EXCEPTION 'B9b FAIL: % / %', r.amount_no_vat, r.vat; END IF;

  -- B10: stock plan
  BEGIN PERFORM receive_po_lines(poS, ARRAY[s1], v_bkk, '[]'::jsonb, 100, 7, '[]'::jsonb); RAISE EXCEPTION 'B10 FAIL: missing plan';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'bad_stock_plan%' THEN RAISE EXCEPTION 'B10 FAIL: %', v_msg; END IF; END;
  BEGIN PERFORM receive_po_lines(poS, ARRAY[s1], v_bkk, '[]'::jsonb, 100, 7, jsonb_build_array(jsonb_build_object('po_item_id', s1, 'base_qty', 4, 'unit_cost', 30))); RAISE EXCEPTION 'B10 FAIL: cost';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'stock_cost_mismatch%' THEN RAISE EXCEPTION 'B10 FAIL: %', v_msg; END IF; END;
  BEGIN PERFORM receive_po_lines(poS, ARRAY[s1], v_bkk, '[]'::jsonb, 100, 7, jsonb_build_array(jsonb_build_object('po_item_id', s1, 'base_qty', 0, 'unit_cost', 25))); RAISE EXCEPTION 'B10 FAIL: zero qty';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'bad_stock_plan%' THEN RAISE EXCEPTION 'B10 FAIL: %', v_msg; END IF; END;
  BEGIN PERFORM receive_po_lines(poF, ARRAY[f1], v_bkk, '[]'::jsonb, 100, 7, jsonb_build_array(jsonb_build_object('po_item_id', f1, 'base_qty', 2, 'unit_cost', 50))); RAISE EXCEPTION 'B10 FAIL: plan on stock_from_invoice PO';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'bad_stock_plan%' THEN RAISE EXCEPTION 'B10 FAIL: %', v_msg; END IF; END;
  j := receive_po_lines(poF, ARRAY[f1], v_bkk, '[]'::jsonb, 100, 7, '[]'::jsonb);
  SELECT count(*) INTO v_cnt FROM stock_movements WHERE reference_id = poF;
  IF v_cnt <> 0 THEN RAISE EXCEPTION 'B10 FAIL: stock posted for a stock_from_invoice PO'; END IF;

  -- B11: received date
  BEGIN PERFORM receive_po_lines(poS, ARRAY[s1], v_bkk + 1, '[]'::jsonb, 100, 7, jsonb_build_array(jsonb_build_object('po_item_id', s1, 'base_qty', 4, 'unit_cost', 25))); RAISE EXCEPTION 'B11 FAIL: future';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'received_date_in_future%' THEN RAISE EXCEPTION 'B11 FAIL: %', v_msg; END IF; END;
  BEGIN PERFORM receive_po_lines(poS, ARRAY[s1], NULL, '[]'::jsonb, 100, 7, '[]'::jsonb); RAISE EXCEPTION 'B11 FAIL: null';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'bad_received_date%' THEN RAISE EXCEPTION 'B11 FAIL: %', v_msg; END IF; END;

  -- B16: legacy application on an ordered PO blocks the new receive
  RESET role;
  INSERT INTO po_deposit_applications (tenant_id, deposit_id, po_id, amount_no_vat, vat) VALUES (t_tenant, depT, poL, 0.01, 0);
  SET LOCAL role = 'authenticated';
  BEGIN PERFORM receive_po_lines(poL, ARRAY[l1], v_bkk, '[]'::jsonb, 100, 7, '[]'::jsonb); RAISE EXCEPTION 'B16 FAIL';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'po_has_deposit_applications%' THEN RAISE EXCEPTION 'B16 FAIL: %', v_msg; END IF; END;

  -- B15: the legacy RPC still receives a plain ordered PO
  PERFORM receive_po_with_deposits(poP, '[]'::jsonb, 100, 7);
  IF (SELECT status FROM purchase_orders WHERE id = poP) <> 'received' THEN RAISE EXCEPTION 'B15 FAIL'; END IF;
  -- B20b: a legacy deposit (po_id NULL) is still deductible by the legacy RPC
  INSERT INTO expenses (date, description, site_id, category_id, supplier_id, amount_no_vat, vat, amount, payment_method, status)
  VALUES (v_bkk, 'dep 4', t_site, t_cat, t_sup, 50, 3.5, 53.5, 'transfer', 'paid') RETURNING id INTO e_leg4;
  INSERT INTO supplier_deposits (expense_id, deposit_invoice_no) VALUES (e_leg4, 'PRB-LEG4') RETURNING id INTO d_leg4;
  PERFORM receive_po_with_deposits(poO, jsonb_build_array(jsonb_build_object('deposit_id', d_leg4, 'amount_no_vat', 50)), 100, 7);
  SELECT amount_no_vat, vat INTO r FROM po_deposit_applications WHERE deposit_id = d_leg4;
  IF r.amount_no_vat IS DISTINCT FROM 50::numeric OR r.vat IS DISTINCT FROM 3.5::numeric
     OR (SELECT status FROM purchase_orders WHERE id = poO) <> 'received' THEN RAISE EXCEPTION 'B20b FAIL'; END IF;

  -- B21: deposit 100 + 6.99 used in full on a 100 + 7 receipt: the 0.01 VAT gap is NOT folded above the deposit's VAT,
  -- it stays on a 0.01 bill. The deposit id is sent in upper case (lock order uses the cast uuid).
  INSERT INTO expenses (date, description, site_id, category_id, supplier_id, amount_no_vat, vat, amount, payment_method, status)
  VALUES (v_bkk, 'dep v', t_site, t_cat, t_sup, 100, 6.99, 106.99, 'transfer', 'paid') RETURNING id INTO e_v;
  INSERT INTO supplier_deposits (expense_id, deposit_invoice_no) VALUES (e_v, 'PRB-LEGV') RETURNING id INTO d_v;
  j := receive_po_lines(poV, ARRAY[vv1], v_bkk, jsonb_build_array(jsonb_build_object('deposit_id', upper(d_v::text), 'mode', 'value', 'value', 106.99)), 100, 7, '[]'::jsonb);
  SELECT amount_no_vat, vat INTO r FROM po_deposit_applications WHERE deposit_id = d_v;
  IF r.amount_no_vat <> 100 OR r.vat <> 6.99 THEN RAISE EXCEPTION 'B21 FAIL: application % / %', r.amount_no_vat, r.vat; END IF;
  SELECT * INTO r FROM expenses WHERE id = (j->>'expense_id')::uuid;
  IF NOT FOUND OR r.amount_no_vat <> 0 OR r.vat <> 0.01 OR r.amount <> 0.01 OR j->>'status' <> 'received' THEN RAISE EXCEPTION 'B21 FAIL: bill %', j; END IF;

  -- B22: a negative (discount) line is refused (v1 limit), alone or with others; positive lines still receivable
  BEGIN PERFORM receive_po_lines(poN, ARRAY[nn1, nn2], v_bkk, '[]'::jsonb, 90, 6.3, '[]'::jsonb); RAISE EXCEPTION 'B22 FAIL: discount line received';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'bad_lines%' THEN RAISE EXCEPTION 'B22 FAIL: %', v_msg; END IF; END;
  j := receive_po_lines(poN, ARRAY[nn1], v_bkk, '[]'::jsonb, 100, 7, '[]'::jsonb);
  IF j->>'status' <> 'partially_received' THEN RAISE EXCEPTION 'B22 FAIL: %', j; END IF;
  BEGIN PERFORM receive_po_lines(poN, ARRAY[nn2], v_bkk, '[]'::jsonb, -10, -0.7, '[]'::jsonb); RAISE EXCEPTION 'B22 FAIL: negative final receipt';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'bad_lines%' THEN RAISE EXCEPTION 'B22 FAIL: %', v_msg; END IF; END;

  -- B17: tax-invoice interplay (R7). A partially received PO cannot be linked to a tax invoice; a PO linked by hand
  -- to a posted invoice gets the clean code from receive_po_lines (before any write).
  j := receive_po_lines(poR, ARRAY[rr1], v_bkk, '[]'::jsonb, 100, 7, '[]'::jsonb);
  IF j->>'status' <> 'partially_received' THEN RAISE EXCEPTION 'B17 FAIL: %', j; END IF;
  BEGIN PERFORM save_supplier_tax_invoice_draft(NULL,
          jsonb_build_object('supplier_id', t_sup, 'invoice_no', 'PRB-TI-1', 'invoice_date', v_bkk, 'net_before_vat', 150, 'vat', 10.5),
          '[]'::jsonb, ARRAY[poR]);
        RAISE EXCEPTION 'B17 FAIL: partially received PO linked to a tax invoice';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'po_not_eligible%' THEN RAISE EXCEPTION 'B17 FAIL: %', v_msg; END IF; END;
  RESET role;
  INSERT INTO supplier_tax_invoices (tenant_id, supplier_id, invoice_no, invoice_date, net_before_vat, vat, grand_total, status)
  VALUES (t_tenant, t_sup, 'PRB-TI-2', v_bkk, 150, 10.5, 160.5, 'posted') RETURNING id INTO v_ti;
  INSERT INTO supplier_tax_invoice_pos (tenant_id, invoice_id, po_id) VALUES (t_tenant, v_ti, poR);
  SET LOCAL role = 'authenticated';
  BEGIN PERFORM receive_po_lines(poR, ARRAY[rr2], v_bkk, '[]'::jsonb, 50, 3.5, '[]'::jsonb); RAISE EXCEPTION 'B17 FAIL: tax-invoiced PO received';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'po_tax_invoiced%' THEN RAISE EXCEPTION 'B17 FAIL: %', v_msg; END IF; END;
  SELECT count(*) INTO v_cnt FROM po_receipts WHERE po_id = poR;
  IF v_cnt <> 1 THEN RAISE EXCEPTION 'B17 FAIL: % receipts', v_cnt; END IF;

  -- B18: a deposit linked to a PO keeps its expense and number (client UPDATE grant on those columns stays);
  -- a legacy unapplied deposit can still be renamed.
  j := create_po_deposit(poD, 'amount', 10, 'PRB-DEP-D', v_bkk, 'cash', 'paid');
  depC := (j->>'deposit_id')::uuid;
  BEGIN UPDATE supplier_deposits SET deposit_invoice_no = 'PRB-DEP-D2' WHERE id = depC; RAISE EXCEPTION 'B18 FAIL: linked deposit renamed';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'deposit_in_use%' THEN RAISE EXCEPTION 'B18 FAIL: %', v_msg; END IF; END;
  BEGIN UPDATE supplier_deposits SET expense_id = e_leg2 WHERE id = depC; RAISE EXCEPTION 'B18 FAIL: linked deposit re-pointed';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'deposit_in_use%' THEN RAISE EXCEPTION 'B18 FAIL: %', v_msg; END IF; END;
  UPDATE supplier_deposits SET deposit_invoice_no = 'PRB-LEG2-B' WHERE id = d_leg2;
  IF (SELECT deposit_invoice_no FROM supplier_deposits WHERE id = d_leg2) IS DISTINCT FROM 'PRB-LEG2-B' THEN RAISE EXCEPTION 'B18 FAIL: legacy rename blocked'; END IF;
  -- B23: a PO-linked deposit cannot be unregistered (deleted); an unlinked unapplied one still can
  BEGIN DELETE FROM supplier_deposits WHERE id = depC; RAISE EXCEPTION 'B23 FAIL: linked deposit deleted';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'deposit_linked_to_po%' THEN RAISE EXCEPTION 'B23 FAIL: %', v_msg; END IF; END;
  IF NOT EXISTS (SELECT 1 FROM supplier_deposits WHERE id = depC AND po_id = poD) THEN RAISE EXCEPTION 'B23 FAIL: link lost'; END IF;
  DELETE FROM supplier_deposits WHERE id = d_leg2;
  IF EXISTS (SELECT 1 FROM supplier_deposits WHERE id = d_leg2) THEN RAISE EXCEPTION 'B23 FAIL: legacy unregister blocked'; END IF;

  -- B19: under the lock, a deposit whose applications exceed its own VAT (data changed past the triggers) is refused
  INSERT INTO expenses (date, description, site_id, category_id, supplier_id, amount_no_vat, vat, amount, payment_method, status)
  VALUES (v_bkk, 'dep 3', t_site, t_cat, t_sup, 100, 7, 107, 'transfer', 'paid') RETURNING id INTO e_leg3;
  INSERT INTO supplier_deposits (expense_id, deposit_invoice_no) VALUES (e_leg3, 'PRB-LEG3') RETURNING id INTO d_leg3;
  RESET role;
  INSERT INTO po_deposit_applications (tenant_id, deposit_id, po_id, amount_no_vat, vat) VALUES (t_tenant, d_leg3, poL, 1, 8);
  SET LOCAL role = 'authenticated';
  BEGIN PERFORM receive_po_lines(poS, ARRAY[s1], v_bkk, jsonb_build_array(jsonb_build_object('deposit_id', d_leg3, 'mode', 'value', 'value', 10)), 100, 7,
                                 jsonb_build_array(jsonb_build_object('po_item_id', s1, 'base_qty', 4, 'unit_cost', 25))); RAISE EXCEPTION 'B19 FAIL';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'deposit_exceeds_remaining%' THEN RAISE EXCEPTION 'B19 FAIL: %', v_msg; END IF; END;

  -- B13: split_payment on bill1 (pending 44,940)
  j := split_payment(bill1, 20000, v_bkk, 'transfer');
  rem1 := (j->>'remaining_expense_id')::uuid;
  SELECT * INTO r FROM expenses WHERE id = bill1;
  IF r.amount <> 20000 OR r.amount_no_vat <> 18691.59 OR r.vat <> 1308.41 OR r.status <> 'paid' OR r.payment_method <> 'transfer' THEN RAISE EXCEPTION 'B13 FAIL: paid part %', row_to_json(r); END IF;
  SELECT * INTO r FROM expenses WHERE id = rem1;
  IF r.amount <> 24940 OR r.amount_no_vat <> 23308.41 OR r.vat <> 1631.59 OR r.status <> 'pending' OR r.po_id <> poA OR r.date <> v_bkk - 30 THEN RAISE EXCEPTION 'B13 FAIL: remainder %', row_to_json(r); END IF;
  SELECT count(*) INTO v_cnt FROM expense_splits WHERE source_expense_id = bill1 AND new_expense_id = rem1 AND paid_amount = 20000 AND paid_date = v_bkk;
  IF v_cnt <> 1 THEN RAISE EXCEPTION 'B13 FAIL: split row'; END IF;
  j := split_payment(rem1, 4940, v_bkk, 'cash');
  rem2 := (j->>'remaining_expense_id')::uuid;
  IF (SELECT amount FROM expenses WHERE id = rem2) <> 20000 THEN RAISE EXCEPTION 'B13 FAIL: second split'; END IF;
  BEGIN PERFORM split_payment(bill1, 1, v_bkk, 'cash'); RAISE EXCEPTION 'B13 FAIL: paid bill split';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'bill_not_pending%' THEN RAISE EXCEPTION 'B13 FAIL: %', v_msg; END IF; END;
  BEGIN PERFORM split_payment(rem2, 20000, v_bkk, 'cash'); RAISE EXCEPTION 'B13 FAIL: whole bill';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'bad_split_amount%' THEN RAISE EXCEPTION 'B13 FAIL: %', v_msg; END IF; END;
  BEGIN PERFORM split_payment(rem2, 10, v_bkk + 1, 'cash'); RAISE EXCEPTION 'B13 FAIL: future';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'bad_paid_date%' THEN RAISE EXCEPTION 'B13 FAIL: %', v_msg; END IF; END;
  BEGIN PERFORM split_payment(rem2, 10, v_bkk, 'credit'); RAISE EXCEPTION 'B13 FAIL: method';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'bad_payment_method%' THEN RAISE EXCEPTION 'B13 FAIL: %', v_msg; END IF; END;
  BEGIN PERFORM split_payment(e_leg, 10, v_bkk, 'cash'); RAISE EXCEPTION 'B13 FAIL: deposit expense';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'not_a_po_bill%' THEN RAISE EXCEPTION 'B13 FAIL: %', v_msg; END IF; END;
  BEGIN DELETE FROM expenses WHERE id = rem2; RAISE EXCEPTION 'B13 FAIL: split part deleted';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'expense_is_split_part%' THEN RAISE EXCEPTION 'B13 FAIL: %', v_msg; END IF; END;

  -- B12: role / tenant / read-only
  BEGIN PERFORM receive_po_lines(t2_po, '{}'::uuid[], v_bkk, '[]'::jsonb, 0, 0, '[]'::jsonb); RAISE EXCEPTION 'B12 FAIL: other tenant PO';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'po_not_found%' THEN RAISE EXCEPTION 'B12 FAIL: %', v_msg; END IF; END;
  PERFORM set_config('request.jwt.claims', '{"email":"' || w_email || '"}', true);
  BEGIN PERFORM create_po_deposit(poC, 'percent', 10, 'PRB-W', v_bkk, 'cash', 'paid'); RAISE EXCEPTION 'B12 FAIL: worker deposit';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'insufficient_privilege%' THEN RAISE EXCEPTION 'B12 FAIL: %', v_msg; END IF; END;
  BEGIN PERFORM receive_po_lines(poS, ARRAY[s1], v_bkk, '[]'::jsonb, 100, 7, '[]'::jsonb); RAISE EXCEPTION 'B12 FAIL: worker receive';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'insufficient_privilege%' THEN RAISE EXCEPTION 'B12 FAIL: %', v_msg; END IF; END;
  BEGIN PERFORM split_payment(rem2, 10, v_bkk, 'cash'); RAISE EXCEPTION 'B12 FAIL: worker split';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'insufficient_privilege%' THEN RAISE EXCEPTION 'B12 FAIL: %', v_msg; END IF; END;
  PERFORM set_config('request.jwt.claims', '{"email":"' || email3 || '"}', true);
  BEGIN PERFORM create_po_deposit(t3_po, 'percent', 10, 'PRB-RO', v_bkk, 'cash', 'paid'); RAISE EXCEPTION 'B12 FAIL: read-only tenant';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'insufficient_privilege%' THEN RAISE EXCEPTION 'B12 FAIL: %', v_msg; END IF; END;
  PERFORM set_config('request.jwt.claims', '{"email":"' || email || '"}', true);

  -- B14: ACL
  RESET role;
  IF has_function_privilege('anon', 'create_po_deposit(uuid,text,numeric,text,date,text,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'receive_po_lines(uuid,uuid[],date,jsonb,numeric,numeric,jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'split_payment(uuid,numeric,date,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'receive_po_lines(uuid,uuid[],date,jsonb,numeric,numeric,jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'create_po_deposit(uuid,text,numeric,text,date,text,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'split_payment(uuid,numeric,date,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', '_po_totals(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', '_po_receipt_value(uuid,uuid,uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'B14 FAIL: function grants';
  END IF;

  RAISE EXCEPTION 'RESULT: po_receipt_test_b ALL PASSED';
END $$;
ROLLBACK;
