-- ================================================================
-- Tests for 2026-10-09-06-po-unreceive-stock-reversal.sql.
-- Dry-run only: BEGIN; SET LOCAL lock_timeout='5s'; migration 2026-10-09-06; this body (its BEGIN;/ROLLBACK; stripped); ROLLBACK;
-- Success = an ERROR whose text contains 'RESULT: po_unreceive_stock_test ALL PASSED' (the RAISE rolls everything back).
-- Any other error text = failure. Requires 2026-10-07-01..02, 2026-10-08-01..02, 2026-10-09-01..02 (live).
-- Concurrency (lock order) cannot be tested in one session.
-- ================================================================
BEGIN;
DO $$
DECLARE
  t_owner UUID; t_tenant UUID; s1 UUID; t_sup UUID; t_cat UUID; x UUID; y UUID;
  email TEXT := '__test_pur_owner__@example.com';
  email2 TEXT := '__test_pur_owner2__@example.com';
  t2_tenant UUID; t2_site UUID; t2_sup UUID; t2_cat UUID; t2_item UUID; t2_po UUID;
  po1 UUID; po2 UUID; po3 UUID; po_r UUID; po_r_item UUID; po_s UUID; r1 UUID;
  v_q NUMERIC; v_w NUMERIC; v_cnt INT; v_msg TEXT; v_det TEXT; v_status TEXT; v_n INT;
BEGIN
  -- ── fixtures (superuser) ──
  SELECT id INTO t_owner FROM auth.users ORDER BY created_at ASC LIMIT 1;
  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at) VALUES ('__TEST pur__', t_owner, 'trial', now() + interval '14 days') RETURNING id INTO t_tenant;
  INSERT INTO user_roles (user_email, role, status, tenant_id) VALUES (email, 'OWNER', 'approved', t_tenant);
  INSERT INTO sites (tenant_id, site_number, name) VALUES (t_tenant, '__PUR-1__', '__pur site__') RETURNING id INTO s1;
  INSERT INTO suppliers (tenant_id, name) VALUES (t_tenant, '__pur sup__') RETURNING id INTO t_sup;
  INSERT INTO expense_categories (tenant_id, name) VALUES (t_tenant, '__pur cat__') RETURNING id INTO t_cat;
  INSERT INTO inventory_items (tenant_id, name, base_unit) VALUES (t_tenant, '__pur X__', 'kg') RETURNING id INTO x;
  INSERT INTO inventory_items (tenant_id, name, base_unit) VALUES (t_tenant, '__pur Y__', 'แผ่น') RETURNING id INTO y;

  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at) VALUES ('__TEST pur2__', t_owner, 'trial', now() + interval '14 days') RETURNING id INTO t2_tenant;
  INSERT INTO user_roles (user_email, role, status, tenant_id) VALUES (email2, 'OWNER', 'approved', t2_tenant);
  INSERT INTO sites (tenant_id, site_number, name) VALUES (t2_tenant, '__PUR-2__', '__pur site2__') RETURNING id INTO t2_site;
  INSERT INTO suppliers (tenant_id, name) VALUES (t2_tenant, '__pur t2 sup__') RETURNING id INTO t2_sup;
  INSERT INTO expense_categories (tenant_id, name) VALUES (t2_tenant, '__pur t2 cat__') RETURNING id INTO t2_cat;
  INSERT INTO inventory_items (tenant_id, name, base_unit) VALUES (t2_tenant, '__pur t2 item__', 'kg') RETURNING id INTO t2_item;

  -- legacy POs (no VAT so the expected totals are the plain line sums)
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status, has_vat, price_includes_vat)
  VALUES (t_tenant, 'PO-PUR-1', s1, t_sup, t_cat, current_date, 'ordered', false, false) RETURNING id INTO po1;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total, inventory_item_id) VALUES (t_tenant, po1, 'X', 10, 100, 1000, x);
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total, inventory_item_id) VALUES (t_tenant, po1, 'Y', 6, 12.5, 75, y);
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status, has_vat, price_includes_vat)
  VALUES (t_tenant, 'PO-PUR-2', s1, t_sup, t_cat, current_date, 'ordered', false, false) RETURNING id INTO po2;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total, inventory_item_id) VALUES (t_tenant, po2, 'X', 5, 80, 400, x);
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status, has_vat, price_includes_vat)
  VALUES (t_tenant, 'PO-PUR-3', s1, t_sup, t_cat, current_date, 'ordered', false, false) RETURNING id INTO po3;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total, inventory_item_id) VALUES (t_tenant, po3, 'Y', 6, 12.5, 75, y);
  -- PO with a po_receipts row (new flow), already 'received'
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status, has_vat, price_includes_vat)
  VALUES (t_tenant, 'PO-PUR-R', s1, t_sup, t_cat, current_date, 'received', false, false) RETURNING id INTO po_r;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total, inventory_item_id) VALUES (t_tenant, po_r, 'X', 3, 100, 300, x) RETURNING id INTO po_r_item;
  INSERT INTO po_receipts (tenant_id, po_id, seq, received_date, goods_subtotal, goods_vat) VALUES (t_tenant, po_r, 1, current_date, 300, 0) RETURNING id INTO r1;
  INSERT INTO po_receipt_items (tenant_id, receipt_id, po_item_id, quantity, line_total) VALUES (t_tenant, r1, po_r_item, 3, 300);
  -- stock_from_invoice PO, already 'received'
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status, has_vat, price_includes_vat, stock_from_invoice)
  VALUES (t_tenant, 'PO-PUR-S', s1, t_sup, t_cat, current_date, 'received', false, false, true) RETURNING id INTO po_s;
  -- other tenant's legacy PO
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status, has_vat, price_includes_vat)
  VALUES (t2_tenant, 'PO-PUR-T2', t2_site, t2_sup, t2_cat, current_date, 'ordered', false, false) RETURNING id INTO t2_po;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total, inventory_item_id) VALUES (t2_tenant, t2_po, 'Z', 4, 10, 40, t2_item);

  -- ── act as the tenant owner ──
  SET LOCAL role = 'authenticated';
  PERFORM set_config('request.jwt.claims', json_build_object('email', email, 'role', 'authenticated')::text, true);

  -- prior balances (> 0): X 10@50, Y 4@30
  PERFORM record_stock_movement(x, s1, 'purchase_in', 10, 50, NULL, NULL, 'opening');
  PERFORM record_stock_movement(y, s1, 'purchase_in', 4, 30, NULL, NULL, 'opening');

  -- T1: legacy receive of 2 items, then cancel -> exact prior balance and WAC
  PERFORM receive_po_with_deposits(po1, '[]'::jsonb, 1075, 0);
  PERFORM record_stock_movement(x, s1, 'purchase_in', 10, 100, 'purchase_order', po1, NULL);
  PERFORM record_stock_movement(y, s1, 'purchase_in', 6, 12.5, 'purchase_order', po1, NULL);
  SELECT quantity_on_hand, round(weighted_average_cost, 6) INTO v_q, v_w FROM inventory_stock_balances WHERE inventory_item_id = x AND site_id = s1;
  IF v_q <> 20 OR v_w <> 75 THEN RAISE EXCEPTION 'T1 FAIL: X after receive % @ %', v_q, v_w; END IF;
  SELECT quantity_on_hand, round(weighted_average_cost, 6) INTO v_q, v_w FROM inventory_stock_balances WHERE inventory_item_id = y AND site_id = s1;
  IF v_q <> 10 OR v_w <> 19.5 THEN RAISE EXCEPTION 'T1 FAIL: Y after receive % @ %', v_q, v_w; END IF;
  UPDATE purchase_orders SET status = 'cancelled' WHERE id = po1;
  SELECT quantity_on_hand, round(weighted_average_cost, 6) INTO v_q, v_w FROM inventory_stock_balances WHERE inventory_item_id = x AND site_id = s1;
  IF v_q <> 10 OR v_w <> 50 THEN RAISE EXCEPTION 'T1 FAIL: X after cancel % @ % (want 10 @ 50)', v_q, v_w; END IF;
  SELECT quantity_on_hand, round(weighted_average_cost, 6) INTO v_q, v_w FROM inventory_stock_balances WHERE inventory_item_id = y AND site_id = s1;
  IF v_q <> 4 OR v_w <> 30 THEN RAISE EXCEPTION 'T1 FAIL: Y after cancel % @ % (want 4 @ 30)', v_q, v_w; END IF;
  SELECT count(*) INTO v_cnt FROM stock_movements WHERE reference_type = 'purchase_order' AND reference_id = po1 AND movement_type = 'receipt_reversal'
     AND notes = 'ยกเลิกรับของ PO-PUR-1 (ยกเลิกใบสั่งซื้อ)';
  IF v_cnt <> 2 THEN RAISE EXCEPTION 'T1 FAIL: % reversal movements with the cancel note', v_cnt; END IF;
  SELECT status INTO v_status FROM purchase_orders WHERE id = po1;
  IF v_status <> 'cancelled' THEN RAISE EXCEPTION 'T1 FAIL: status %', v_status; END IF;
  RAISE NOTICE 'T1 (cancel reverses 2 items exactly): PASSED';

  -- T2: revert to 'ordered' (Expenses reconcile) -> same exact reversal
  PERFORM receive_po_with_deposits(po2, '[]'::jsonb, 400, 0);
  PERFORM record_stock_movement(x, s1, 'purchase_in', 5, 80, 'purchase_order', po2, NULL);
  SELECT quantity_on_hand, round(weighted_average_cost, 6) INTO v_q, v_w FROM inventory_stock_balances WHERE inventory_item_id = x AND site_id = s1;
  IF v_q <> 15 OR v_w <> 60 THEN RAISE EXCEPTION 'T2 FAIL: X after receive % @ %', v_q, v_w; END IF;
  UPDATE purchase_orders SET status = 'ordered', received_date = NULL, expense_id = NULL WHERE id = po2;
  SELECT quantity_on_hand, round(weighted_average_cost, 6) INTO v_q, v_w FROM inventory_stock_balances WHERE inventory_item_id = x AND site_id = s1;
  IF v_q <> 10 OR v_w <> 50 THEN RAISE EXCEPTION 'T2 FAIL: X after revert % @ % (want 10 @ 50)', v_q, v_w; END IF;
  SELECT count(*) INTO v_cnt FROM stock_movements WHERE reference_type = 'purchase_order' AND reference_id = po2 AND movement_type = 'receipt_reversal'
     AND notes = 'ยกเลิกรับของ PO-PUR-2 (กลับเป็นยังไม่รับของ)' AND quantity = 5 AND unit_cost = 80;
  IF v_cnt <> 1 THEN RAISE EXCEPTION 'T2 FAIL: % reversal movements with the revert note', v_cnt; END IF;
  RAISE NOTICE 'T2 (revert to ordered reverses): PASSED';

  -- T3: idempotent -- a second received -> ordered with nothing left to reverse posts nothing
  UPDATE purchase_orders SET status = 'received' WHERE id = po2;   -- plain status flip, no stock
  UPDATE purchase_orders SET status = 'ordered' WHERE id = po2;
  SELECT count(*) INTO v_cnt FROM stock_movements WHERE reference_id = po2 AND movement_type = 'receipt_reversal';
  IF v_cnt <> 1 THEN RAISE EXCEPTION 'T3 FAIL: second transition posted again (% reversals)', v_cnt; END IF;
  SELECT quantity_on_hand, round(weighted_average_cost, 6) INTO v_q, v_w FROM inventory_stock_balances WHERE inventory_item_id = x AND site_id = s1;
  IF v_q <> 10 OR v_w <> 50 THEN RAISE EXCEPTION 'T3 FAIL: X % @ %', v_q, v_w; END IF;
  -- cancelled -> ordered never fires (OLD.status is not 'received')
  SELECT count(*) INTO v_n FROM stock_movements WHERE reference_id = po1;
  RESET role;
  UPDATE purchase_orders SET status = 'ordered' WHERE id = po1;
  UPDATE purchase_orders SET status = 'cancelled' WHERE id = po1;
  SET LOCAL role = 'authenticated';
  SELECT count(*) INTO v_cnt FROM stock_movements WHERE reference_id = po1;
  IF v_cnt <> v_n THEN RAISE EXCEPTION 'T3 FAIL: non-received transitions posted movements'; END IF;
  RAISE NOTICE 'T3 (idempotent): PASSED';

  -- T4: re-receive after revert posts again, and a later cancel reverses only the new receipt
  PERFORM receive_po_with_deposits(po2, '[]'::jsonb, 400, 0);
  PERFORM record_stock_movement(x, s1, 'purchase_in', 5, 80, 'purchase_order', po2, NULL);
  SELECT quantity_on_hand, round(weighted_average_cost, 6) INTO v_q, v_w FROM inventory_stock_balances WHERE inventory_item_id = x AND site_id = s1;
  IF v_q <> 15 OR v_w <> 60 THEN RAISE EXCEPTION 'T4 FAIL: X after re-receive % @ %', v_q, v_w; END IF;
  UPDATE purchase_orders SET status = 'cancelled' WHERE id = po2;
  SELECT quantity_on_hand, round(weighted_average_cost, 6) INTO v_q, v_w FROM inventory_stock_balances WHERE inventory_item_id = x AND site_id = s1;
  IF v_q <> 10 OR v_w <> 50 THEN RAISE EXCEPTION 'T4 FAIL: X after cancel % @ %', v_q, v_w; END IF;
  SELECT count(*) INTO v_cnt FROM stock_movements WHERE reference_id = po2 AND movement_type = 'receipt_reversal';
  IF v_cnt <> 2 THEN RAISE EXCEPTION 'T4 FAIL: % reversals (want 2)', v_cnt; END IF;
  RAISE NOTICE 'T4 (re-receive then cancel): PASSED';

  -- T5: stock already used -> the status change is refused, nothing changes
  PERFORM receive_po_with_deposits(po3, '[]'::jsonb, 75, 0);
  PERFORM record_stock_movement(y, s1, 'purchase_in', 6, 12.5, 'purchase_order', po3, NULL);   -- Y 10 @ 19.5
  PERFORM record_stock_movement(y, s1, 'sale_out', 8, 19.5, 'invoice', NULL, NULL);             -- Y 2 @ 19.5
  BEGIN
    UPDATE purchase_orders SET status = 'cancelled' WHERE id = po3;
    RAISE EXCEPTION 'T5 FAIL: cancel allowed with too little stock';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT, v_det = PG_EXCEPTION_DETAIL;
    IF v_msg NOT LIKE 'po_unreceive_stock_insufficient%' THEN RAISE EXCEPTION 'T5 FAIL: %', v_msg; END IF;
    IF v_det NOT LIKE '%on_hand=2%' OR v_det NOT LIKE '%to_reverse=6%' THEN RAISE EXCEPTION 'T5 FAIL: detail %', v_det; END IF;
  END;
  BEGIN
    UPDATE purchase_orders SET status = 'ordered', received_date = NULL, expense_id = NULL WHERE id = po3;
    RAISE EXCEPTION 'T5 FAIL: revert allowed with too little stock';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'po_unreceive_stock_insufficient%' THEN RAISE EXCEPTION 'T5 FAIL: %', v_msg; END IF;
  END;
  SELECT status INTO v_status FROM purchase_orders WHERE id = po3;
  IF v_status <> 'received' THEN RAISE EXCEPTION 'T5 FAIL: status %', v_status; END IF;
  SELECT quantity_on_hand, round(weighted_average_cost, 6) INTO v_q, v_w FROM inventory_stock_balances WHERE inventory_item_id = y AND site_id = s1;
  IF v_q <> 2 OR v_w <> 19.5 THEN RAISE EXCEPTION 'T5 FAIL: Y changed % @ %', v_q, v_w; END IF;
  SELECT count(*) INTO v_cnt FROM stock_movements WHERE reference_id = po3 AND movement_type = 'receipt_reversal';
  IF v_cnt <> 0 THEN RAISE EXCEPTION 'T5 FAIL: % reversal rows left', v_cnt; END IF;
  RAISE NOTICE 'T5 (insufficient stock blocks): PASSED';

  -- T6: PO with po_receipts -- clients still refused by po_block_when_receipted; even the RPC flag path posts nothing
  PERFORM record_stock_movement(x, s1, 'purchase_in', 3, 100, 'purchase_order', po_r, NULL);
  SELECT quantity_on_hand INTO v_q FROM inventory_stock_balances WHERE inventory_item_id = x AND site_id = s1;   -- 13
  BEGIN
    UPDATE purchase_orders SET status = 'cancelled' WHERE id = po_r;
    RAISE EXCEPTION 'T6 FAIL: client cancelled a receipted PO';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'po_has_receipts%' THEN RAISE EXCEPTION 'T6 FAIL: %', v_msg; END IF;
  END;
  RESET role;
  PERFORM set_config('app.po_receipt_rpc', 'on', true);
  UPDATE purchase_orders SET status = 'cancelled' WHERE id = po_r;
  PERFORM set_config('app.po_receipt_rpc', 'off', true);
  SET LOCAL role = 'authenticated';
  IF (SELECT quantity_on_hand FROM inventory_stock_balances WHERE inventory_item_id = x AND site_id = s1) <> v_q THEN RAISE EXCEPTION 'T6 FAIL: stock changed'; END IF;
  IF EXISTS (SELECT 1 FROM stock_movements WHERE reference_id = po_r AND movement_type = 'receipt_reversal') THEN RAISE EXCEPTION 'T6 FAIL: reversal posted'; END IF;
  RAISE NOTICE 'T6 (PO with receipts untouched): PASSED';

  -- T7: stock_from_invoice PO -- unchanged even if a PO-referenced purchase_in exists
  PERFORM record_stock_movement(y, s1, 'purchase_in', 2, 30, 'purchase_order', po_s, NULL);
  SELECT quantity_on_hand INTO v_q FROM inventory_stock_balances WHERE inventory_item_id = y AND site_id = s1;   -- 4
  UPDATE purchase_orders SET status = 'cancelled' WHERE id = po_s;
  IF (SELECT status FROM purchase_orders WHERE id = po_s) <> 'cancelled' THEN RAISE EXCEPTION 'T7 FAIL: not cancelled'; END IF;
  IF (SELECT quantity_on_hand FROM inventory_stock_balances WHERE inventory_item_id = y AND site_id = s1) <> v_q THEN RAISE EXCEPTION 'T7 FAIL: stock changed'; END IF;
  IF EXISTS (SELECT 1 FROM stock_movements WHERE reference_id = po_s AND movement_type = 'receipt_reversal') THEN RAISE EXCEPTION 'T7 FAIL: reversal posted'; END IF;
  RAISE NOTICE 'T7 (stock_from_invoice untouched): PASSED';

  -- T8: cross-tenant -- tenant 2 receives its PO; tenant 1 cannot cancel it; admin SQL without claims is refused
  PERFORM set_config('request.jwt.claims', json_build_object('email', email2, 'role', 'authenticated')::text, true);
  PERFORM receive_po_with_deposits(t2_po, '[]'::jsonb, 40, 0);
  PERFORM record_stock_movement(t2_item, t2_site, 'purchase_in', 4, 10, 'purchase_order', t2_po, NULL);
  PERFORM set_config('request.jwt.claims', json_build_object('email', email, 'role', 'authenticated')::text, true);
  UPDATE purchase_orders SET status = 'cancelled' WHERE id = t2_po;   -- RLS: 0 rows
  RESET role;
  IF (SELECT status FROM purchase_orders WHERE id = t2_po) <> 'received' THEN RAISE EXCEPTION 'T8 FAIL: other tenant cancelled the PO'; END IF;
  IF (SELECT quantity_on_hand FROM inventory_stock_balances WHERE inventory_item_id = t2_item AND site_id = t2_site) <> 4 THEN RAISE EXCEPTION 'T8 FAIL: other tenant stock changed'; END IF;
  -- tenant 1's claims on a superuser session: the helper refuses another tenant's stock
  BEGIN
    UPDATE purchase_orders SET status = 'cancelled' WHERE id = t2_po;
    RAISE EXCEPTION 'T8 FAIL: tenant-1 claims reversed tenant-2 stock';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'insufficient_privilege%' THEN RAISE EXCEPTION 'T8 FAIL: %', v_msg; END IF;
  END;
  -- no claims at all (plain admin SQL): refused too
  PERFORM set_config('request.jwt.claims', '', true);
  BEGIN
    UPDATE purchase_orders SET status = 'cancelled' WHERE id = t2_po;
    RAISE EXCEPTION 'T8 FAIL: admin SQL without claims reversed stock';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'insufficient_privilege%' THEN RAISE EXCEPTION 'T8 FAIL (no claims): %', v_msg; END IF;
  END;
  IF (SELECT quantity_on_hand FROM inventory_stock_balances WHERE inventory_item_id = t2_item AND site_id = t2_site) <> 4 THEN RAISE EXCEPTION 'T8 FAIL: stock changed after refusals'; END IF;
  -- tenant 2's own owner can cancel and gets its stock reversed
  SET LOCAL role = 'authenticated';
  PERFORM set_config('request.jwt.claims', json_build_object('email', email2, 'role', 'authenticated')::text, true);
  UPDATE purchase_orders SET status = 'cancelled' WHERE id = t2_po;
  IF (SELECT quantity_on_hand FROM inventory_stock_balances WHERE inventory_item_id = t2_item AND site_id = t2_site) <> 0 THEN RAISE EXCEPTION 'T8 FAIL: own-tenant cancel did not reverse'; END IF;
  RESET role;
  RAISE NOTICE 'T8 (cross-tenant): PASSED';

  -- T9: ACL -- trigger function not callable by clients; probe callable by authenticated only
  IF has_function_privilege('authenticated', 'po_unreceive_reverse_stock()', 'EXECUTE')
     OR has_function_privilege('anon', 'po_unreceive_reverse_stock()', 'EXECUTE') THEN
    RAISE EXCEPTION 'T9 FAIL: trigger function executable by a client role';
  END IF;
  IF NOT has_function_privilege('authenticated', 'po_unreceive_reverses_stock()', 'EXECUTE')
     OR has_function_privilege('anon', 'po_unreceive_reverses_stock()', 'EXECUTE') THEN
    RAISE EXCEPTION 'T9 FAIL: probe grants';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'po_unreceive_reverse_stock_trg' AND tgrelid = 'public.purchase_orders'::regclass AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'T9 FAIL: trigger missing';
  END IF;
  SET LOCAL role = 'authenticated';
  IF po_unreceive_reverses_stock() IS NOT TRUE THEN RAISE EXCEPTION 'T9 FAIL: probe value'; END IF;
  RESET role;
  RAISE NOTICE 'T9 (ACL): PASSED';

  RAISE EXCEPTION 'RESULT: po_unreceive_stock_test ALL PASSED';
END $$;
ROLLBACK;
