-- ================================================================
-- Tests for supplier tax invoice matching (migrations 2026-10-08-01 / -02).
--
-- !!! NOT RUN against any database !!!
-- Written without applying anything. Fixture column lists follow
-- supabase/tests/po_deposit_test.sql and may need a tweak on first run.
-- Run only where 2026-10-06-01..03, 2026-10-07-01..02 and 2026-10-08-01..02 are applied.
-- Success ends with: ERROR: RESULT: supplier_tax_invoice_test ALL PASSED
-- (the RAISE rolls everything back). Any other error text = a failure.
-- ================================================================
BEGIN;

DO $$
DECLARE
  t_owner UUID; t_tenant UUID; s1 UUID; s2 UUID; sa UUID; sb UUID; t_cat UUID; x UUID; y UUID;
  email TEXT := '__test_sti_owner__@example.com';
  t2_tenant UUID; t2_site UUID; t2_sup UUID; t2_cat UUID; t2_po UUID; t2_inv UUID;
  po1 UUID; po2 UUID; po3 UUID; po4 UUID; po5 UUID; po6 UUID; po7 UUID;
  e1 UUID; e2 UUID; e1_amt NUMERIC; e1_net NUMERIC; e1_vat NUMERIC; e2_amt NUMERIC; e1_prev TEXT;
  inv1 UUID; inv2 UUID; inv3 UUID; inv4 UUID; inv5 UUID; inv6 UUID; inv7 UUID; tmp UUID;
  d_exp UUID; d_dep UUID;
  v_bkk DATE := (now() AT TIME ZONE 'Asia/Bangkok')::date;
  v_j JSONB; v_q NUMERIC; v_w NUMERIC; v_cnt INT; v_msg TEXT; v_state TEXT; v_txt TEXT;
BEGIN
  -- ── fixtures (as the connecting superuser) ──
  SELECT id INTO t_owner FROM auth.users ORDER BY created_at ASC LIMIT 1;
  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at)
  VALUES ('__TEST TENANT sti__', t_owner, 'trial', now() + interval '14 days') RETURNING id INTO t_tenant;
  INSERT INTO user_roles (user_email, role, status, tenant_id) VALUES (email, 'OWNER', 'approved', t_tenant);
  INSERT INTO sites (tenant_id, site_number, name) VALUES (t_tenant, '__STI-1__', '__sti site 1__') RETURNING id INTO s1;
  INSERT INTO sites (tenant_id, site_number, name) VALUES (t_tenant, '__STI-2__', '__sti site 2__') RETURNING id INTO s2;
  INSERT INTO suppliers (tenant_id, name) VALUES (t_tenant, '__sti supplier A__') RETURNING id INTO sa;
  INSERT INTO suppliers (tenant_id, name) VALUES (t_tenant, '__sti supplier B__') RETURNING id INTO sb;
  INSERT INTO expense_categories (tenant_id, name) VALUES (t_tenant, '__sti cat__') RETURNING id INTO t_cat;
  INSERT INTO inventory_items (tenant_id, name, base_unit) VALUES (t_tenant, '__sti X__', 'kg') RETURNING id INTO x;
  INSERT INTO inventory_items (tenant_id, name, base_unit) VALUES (t_tenant, '__sti Y__', 'แผ่น') RETURNING id INTO y;

  -- second tenant (cross-tenant checks)
  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at)
  VALUES ('__TEST TENANT sti2__', t_owner, 'trial', now() + interval '14 days') RETURNING id INTO t2_tenant;
  INSERT INTO sites (tenant_id, site_number, name) VALUES (t2_tenant, '__STI2-1__', '__sti2 site__') RETURNING id INTO t2_site;
  INSERT INTO suppliers (tenant_id, name) VALUES (t2_tenant, '__sti2 supplier__') RETURNING id INTO t2_sup;
  INSERT INTO expense_categories (tenant_id, name) VALUES (t2_tenant, '__sti2 cat__') RETURNING id INTO t2_cat;
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status, has_vat, price_includes_vat)
  VALUES (t2_tenant, 'PO-STI-T2', t2_site, t2_sup, t2_cat, v_bkk, 'received', false, false) RETURNING id INTO t2_po;
  INSERT INTO supplier_tax_invoices (tenant_id, supplier_id, invoice_no, invoice_date, net_before_vat, vat, grand_total)
  VALUES (t2_tenant, t2_sup, 'T2-INV', v_bkk, 0, 0, 0) RETURNING id INTO t2_inv;

  -- ── Part A: helpers (run as superuser; they are not granted to clients) ──
  IF _sti_tolerance(2000) <> 5 OR _sti_tolerance(100) <> 1 OR _sti_tolerance(0) <> 0 THEN
    RAISE EXCEPTION 'A1 FAIL: tolerance % % %', _sti_tolerance(2000), _sti_tolerance(100), _sti_tolerance(0);
  END IF;
  IF round(_sti_wac_after_in(6, 100, 12, 90), 6) <> round(1680::numeric / 18, 6) OR _sti_wac_after_in(-10, 50, 10, 100) <> 0 THEN
    RAISE EXCEPTION 'A2 FAIL: wac_after_in';
  END IF;
  IF round(_sti_wac_after_reversal(18, 1680::numeric / 18, 10, 100), 6) <> 85
     OR _sti_wac_after_reversal(10, 100, 10, 100) <> 100
     OR _sti_wac_after_reversal(7, 100, 20, 100) <> 100
     OR _sti_wac_after_reversal(10, 10, 5, 100) <> 0 THEN
    RAISE EXCEPTION 'A3 FAIL: wac_after_reversal';
  END IF;
  RAISE NOTICE 'Part A helpers: PASSED';

  -- PO fixtures (superuser, explicit tenant): all supplier A, PO date = today (Bangkok)
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status, has_vat, price_includes_vat)
  VALUES (t_tenant, 'PO-STI-1', s1, sa, t_cat, v_bkk, 'ordered', true, false) RETURNING id INTO po1;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total, inventory_item_id) VALUES (t_tenant, po1, 'X', 10, 100, 1000, x);
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status, has_vat, price_includes_vat)
  VALUES (t_tenant, 'PO-STI-2', s1, sa, t_cat, v_bkk, 'ordered', true, false) RETURNING id INTO po2;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total, inventory_item_id) VALUES (t_tenant, po2, 'Y', 5, 200, 1000, y);
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status, has_vat, price_includes_vat)
  VALUES (t_tenant, 'PO-STI-3', s2, sa, t_cat, v_bkk, 'ordered', true, false) RETURNING id INTO po3;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total, inventory_item_id) VALUES (t_tenant, po3, 'X', 20, 100, 2000, x);
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status, has_vat, price_includes_vat)
  VALUES (t_tenant, 'PO-STI-4', s1, sa, t_cat, v_bkk, 'ordered', true, false) RETURNING id INTO po4;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total, inventory_item_id) VALUES (t_tenant, po4, 'X', 5, 100, 500, x);
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status, has_vat, price_includes_vat, stock_from_invoice)
  VALUES (t_tenant, 'PO-STI-5', s1, sa, t_cat, v_bkk, 'ordered', true, false, true) RETURNING id INTO po5;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total, inventory_item_id) VALUES (t_tenant, po5, 'Y', 3, 200, 600, y);
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status, has_vat, price_includes_vat, stock_from_invoice)
  VALUES (t_tenant, 'PO-STI-6', s1, sa, t_cat, v_bkk, 'ordered', true, false, true) RETURNING id INTO po6;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total) VALUES (t_tenant, po6, 'misc', 1, 100, 100);
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status, has_vat, price_includes_vat, stock_from_invoice)
  VALUES (t_tenant, 'PO-STI-7', s1, sa, t_cat, v_bkk, 'ordered', true, false, true) RETURNING id INTO po7;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total, inventory_item_id) VALUES (t_tenant, po7, 'Y', 2, 200, 400, y);

  IF _po_goods_subtotal(po1, t_tenant) <> 1000 OR _po_goods_subtotal(po1, t2_tenant) IS NOT NULL THEN
    RAISE EXCEPTION 'A4 FAIL: _po_goods_subtotal';
  END IF;
  RAISE NOTICE 'Part A PO subtotal: PASSED';

  -- ── act as the tenant owner ──
  SET LOCAL role = 'authenticated';
  PERFORM set_config('request.jwt.claims', json_build_object('email', email, 'role', 'authenticated')::text, true);

  -- A5: helpers are NOT callable by clients
  BEGIN
    PERFORM _stock_receipt_reversal(t_tenant, x, s1, 1, 1, 'x', NULL, NULL, now());
    RAISE EXCEPTION 'A5 FAIL: client could call _stock_receipt_reversal';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM _sti_wac_after_in(1, 1, 1, 1);
    RAISE EXCEPTION 'A5 FAIL: client could call _sti_wac_after_in';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  -- A6: tables are read-only for clients
  BEGIN
    INSERT INTO supplier_tax_invoices (supplier_id, invoice_no, invoice_date, net_before_vat, vat, grand_total)
    VALUES (sa, 'FORGED', v_bkk, 0, 0, 0);
    RAISE EXCEPTION 'A6 FAIL: client insert allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  -- A6b: no INSERT/UPDATE/DELETE privilege on any of the four tables
  IF has_table_privilege('authenticated', 'supplier_tax_invoices', 'INSERT')
     OR has_table_privilege('authenticated', 'supplier_tax_invoice_items', 'INSERT')
     OR has_table_privilege('authenticated', 'supplier_tax_invoice_pos', 'INSERT')
     OR has_table_privilege('authenticated', 'supplier_tax_invoice_reversals', 'INSERT')
     OR has_table_privilege('authenticated', 'supplier_tax_invoices', 'UPDATE')
     OR has_table_privilege('authenticated', 'supplier_tax_invoices', 'DELETE') THEN
    RAISE EXCEPTION 'A6b FAIL: authenticated has write privilege on a tax invoice table';
  END IF;
  -- A7: positive control (own-tenant row IS visible), then the other tenant's row is NOT
  RESET role;
  INSERT INTO supplier_tax_invoices (tenant_id, supplier_id, invoice_no, invoice_date, net_before_vat, vat, grand_total)
  VALUES (t_tenant, sa, 'OWN-CONTROL', v_bkk, 0, 0, 0) RETURNING id INTO tmp;
  SET LOCAL role = 'authenticated';
  PERFORM set_config('request.jwt.claims', json_build_object('email', email, 'role', 'authenticated')::text, true);
  SELECT count(*) INTO v_cnt FROM supplier_tax_invoices WHERE id = tmp;
  IF v_cnt <> 1 THEN RAISE EXCEPTION 'A7 FAIL: own-tenant row not visible (control)'; END IF;
  SELECT count(*) INTO v_cnt FROM supplier_tax_invoices WHERE id = t2_inv;
  IF v_cnt <> 0 THEN RAISE EXCEPTION 'A7 FAIL: cross-tenant row visible'; END IF;
  RAISE NOTICE 'Part A grants/RLS: PASSED';

  -- NOTE (concurrency, not testable in one session): poi_block_when_tax_invoiced takes the parent PO
  -- row lock FOR SHARE before checking _po_tax_invoiced, so an item edit cannot slip past a concurrent
  -- post (which holds the PO FOR UPDATE). Verify by hand with two sessions if in doubt.

  -- receive POs the way the app does: RPC, then the client's record_stock_movement loop
  PERFORM receive_po_with_deposits(po1, '[]'::jsonb, 1000, 70);
  PERFORM record_stock_movement(x, s1, 'purchase_in', 10, 100, 'purchase_order', po1, NULL);
  PERFORM receive_po_with_deposits(po2, '[]'::jsonb, 1000, 70);
  PERFORM record_stock_movement(y, s1, 'purchase_in', 5, 200, 'purchase_order', po2, NULL);
  PERFORM record_stock_movement(x, s1, 'sale_out', 4, 100, 'invoice', NULL, NULL);       -- COGS consumed 4
  SELECT expense_id INTO e1 FROM purchase_orders WHERE id = po1;
  SELECT expense_id INTO e2 FROM purchase_orders WHERE id = po2;
  SELECT amount, amount_no_vat, vat, invoice_no INTO e1_amt, e1_net, e1_vat, e1_prev FROM expenses WHERE id = e1;
  SELECT amount INTO e2_amt FROM expenses WHERE id = e2;

  -- T2: save a draft (2 POs, invoice items differ from PO items)
  inv1 := save_supplier_tax_invoice_draft(NULL,
    jsonb_build_object('supplier_id', sa, 'invoice_no', 'STI-001', 'invoice_date', v_bkk, 'net_before_vat', 2000, 'vat', 140),
    jsonb_build_array(
      jsonb_build_object('description', 'อลู X', 'qty', 12, 'unit', 'kg', 'unit_price', 90, 'inventory_item_id', x, 'site_id', s1, 'base_qty', 12),
      jsonb_build_object('description', 'กระจก Y', 'qty', 4, 'unit', 'แผ่น', 'unit_price', 230, 'inventory_item_id', y, 'site_id', s1, 'base_qty', 4)),
    ARRAY[po1, po2]);
  IF (SELECT grand_total FROM supplier_tax_invoices WHERE id = inv1) <> 2140
     OR (SELECT count(*) FROM supplier_tax_invoice_pos WHERE invoice_id = inv1 AND active) <> 2
     OR (SELECT amount FROM supplier_tax_invoice_items WHERE invoice_id = inv1 AND inventory_item_id = x) <> 1080
     OR (SELECT base_unit_cost FROM supplier_tax_invoice_items WHERE invoice_id = inv1 AND inventory_item_id = y) <> 230 THEN
    RAISE EXCEPTION 'T2 FAIL: draft not saved as expected';
  END IF;
  RAISE NOTICE 'T2 (save draft): PASSED';

  -- T3: a PO cannot be in two non-void invoices
  BEGIN
    PERFORM save_supplier_tax_invoice_draft(NULL,
      jsonb_build_object('supplier_id', sa, 'invoice_no', 'STI-002', 'invoice_date', v_bkk, 'net_before_vat', 1000, 'vat', 70),
      '[]'::jsonb, ARRAY[po1]);
    RAISE EXCEPTION 'T3 FAIL: PO linked twice';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'po_linked_elsewhere%' THEN RAISE EXCEPTION 'T3 FAIL: got %', v_msg; END IF;
  END;
  IF EXISTS (SELECT 1 FROM supplier_tax_invoices WHERE invoice_no = 'STI-002') THEN RAISE EXCEPTION 'T3 FAIL: half-saved draft'; END IF;
  RAISE NOTICE 'T3 (PO linked twice rejected): PASSED';

  -- T4: preview = exactly what post will do (same numbers as vitest simulateStock)
  v_j := preview_supplier_tax_invoice(inv1);
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_j->'checks') e WHERE (e->>'blocking')::boolean) THEN
    RAISE EXCEPTION 'T4 FAIL: unexpected blocking check %', v_j->'checks';
  END IF;
  SELECT (r->>'after_qty')::numeric, round((r->>'after_wac')::numeric, 6) INTO v_q, v_w
    FROM jsonb_array_elements(v_j->'rows') r WHERE (r->>'inventory_item_id')::uuid = x;
  IF v_q <> 8 OR v_w <> 85 THEN RAISE EXCEPTION 'T4 FAIL: X preview % @ %', v_q, v_w; END IF;
  IF (v_j->>'po_sum')::numeric <> 2000 OR (v_j->>'diff')::numeric <> 0 THEN RAISE EXCEPTION 'T4 FAIL: match %', v_j; END IF;
  RAISE NOTICE 'T4 (preview): PASSED';

  -- T5: post: lines first, then reversals; expenses stamped, amounts unchanged; dated invoice date
  v_j := post_supplier_tax_invoice(inv1);
  SELECT quantity_on_hand, round(weighted_average_cost, 6) INTO v_q, v_w FROM inventory_stock_balances WHERE inventory_item_id = x AND site_id = s1;
  IF v_q <> 8 OR v_w <> 85 THEN RAISE EXCEPTION 'T5 FAIL: X % @ %', v_q, v_w; END IF;
  SELECT quantity_on_hand, round(weighted_average_cost, 6) INTO v_q, v_w FROM inventory_stock_balances WHERE inventory_item_id = y AND site_id = s1;
  IF v_q <> 4 OR v_w <> 230 THEN RAISE EXCEPTION 'T5 FAIL: Y % @ %', v_q, v_w; END IF;
  SELECT count(*) INTO v_cnt FROM stock_movements WHERE reference_type = 'supplier_tax_invoice' AND reference_id = inv1 AND movement_type = 'purchase_in';
  IF v_cnt <> 2 THEN RAISE EXCEPTION 'T5 FAIL: % invoice movements', v_cnt; END IF;
  SELECT count(*) INTO v_cnt FROM stock_movements WHERE reference_type = 'supplier_tax_invoice' AND reference_id = inv1 AND movement_type = 'receipt_reversal';
  IF v_cnt <> 2 THEN RAISE EXCEPTION 'T5 FAIL: % reversal movements', v_cnt; END IF;
  IF EXISTS (SELECT 1 FROM stock_movements WHERE reference_type = 'supplier_tax_invoice' AND reference_id = inv1
              AND (created_at AT TIME ZONE 'Asia/Bangkok')::date <> v_bkk) THEN
    RAISE EXCEPTION 'T5 FAIL: movement not dated on the invoice date';
  END IF;
  IF (SELECT count(*) FROM supplier_tax_invoice_reversals WHERE invoice_id = inv1) <> 2 THEN RAISE EXCEPTION 'T5 FAIL: reversal rows'; END IF;
  IF NOT EXISTS (SELECT 1 FROM expenses WHERE id = e1 AND invoice_no = 'STI-001' AND amount = e1_amt AND amount_no_vat = e1_net AND vat = e1_vat)
     OR NOT EXISTS (SELECT 1 FROM expenses WHERE id = e2 AND invoice_no = 'STI-001' AND amount = e2_amt) THEN
    RAISE EXCEPTION 'T5 FAIL: expense stamp/amount';
  END IF;
  IF (SELECT status FROM supplier_tax_invoices WHERE id = inv1) <> 'posted' OR (v_j->>'receipts_reversed')::int <> 2 THEN
    RAISE EXCEPTION 'T5 FAIL: status/result %', v_j;
  END IF;
  RAISE NOTICE 'T5 (post): PASSED';

  -- T6: second post -> not_draft, nothing written
  SELECT count(*) INTO v_cnt FROM stock_movements WHERE reference_id = inv1;
  BEGIN
    PERFORM post_supplier_tax_invoice(inv1);
    RAISE EXCEPTION 'T6 FAIL: posted twice';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'not_draft%' THEN RAISE EXCEPTION 'T6 FAIL: got %', v_msg; END IF;
  END;
  IF (SELECT count(*) FROM stock_movements WHERE reference_id = inv1) <> v_cnt THEN RAISE EXCEPTION 'T6 FAIL: extra movements'; END IF;
  RAISE NOTICE 'T6 (idempotent post): PASSED';

  -- T7: a PO linked to a posted invoice is locked (header and items)
  BEGIN
    UPDATE purchase_orders SET status = 'cancelled' WHERE id = po1;
    RAISE EXCEPTION 'T7 FAIL: PO status changed';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'po_tax_invoiced%' THEN RAISE EXCEPTION 'T7 FAIL: got %', v_msg; END IF;
  END;
  BEGIN
    UPDATE purchase_order_items SET unit_price = 1 WHERE po_id = po1;
    RAISE EXCEPTION 'T7 FAIL: PO item changed';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'po_tax_invoiced%' THEN RAISE EXCEPTION 'T7 FAIL: got %', v_msg; END IF;
  END;
  RAISE NOTICE 'T7 (PO lock): PASSED';

  -- T8: the client cannot forge the posted state
  BEGIN
    UPDATE supplier_tax_invoices SET status = 'draft' WHERE id = inv1;
    RAISE EXCEPTION 'T8 FAIL: client update allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM supplier_tax_invoice_reversals WHERE invoice_id = inv1;
    RAISE EXCEPTION 'T8 FAIL: client delete allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RAISE NOTICE 'T8 (no forging): PASSED';

  -- T9: void restores balances/WAC exactly and the expenses' invoice numbers
  BEGIN
    PERFORM void_supplier_tax_invoice(inv1, '  ');
    RAISE EXCEPTION 'T9 FAIL: void without reason';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'void_reason_required%' THEN RAISE EXCEPTION 'T9 FAIL: got %', v_msg; END IF;
  END;
  v_j := void_supplier_tax_invoice(inv1, 'ทดสอบ');
  SELECT quantity_on_hand, round(weighted_average_cost, 6) INTO v_q, v_w FROM inventory_stock_balances WHERE inventory_item_id = x AND site_id = s1;
  IF v_q <> 6 OR v_w <> 100 THEN RAISE EXCEPTION 'T9 FAIL: X % @ % (want 6 @ 100)', v_q, v_w; END IF;
  SELECT quantity_on_hand, round(weighted_average_cost, 6) INTO v_q, v_w FROM inventory_stock_balances WHERE inventory_item_id = y AND site_id = s1;
  IF v_q <> 5 OR v_w <> 200 THEN RAISE EXCEPTION 'T9 FAIL: Y % @ % (want 5 @ 200)', v_q, v_w; END IF;
  IF (SELECT invoice_no FROM expenses WHERE id = e1) IS DISTINCT FROM e1_prev
     OR (SELECT notes FROM expenses WHERE id = e1) NOT LIKE '%ยกเลิกใบกำกับภาษี STI-001%'
     OR (SELECT amount FROM expenses WHERE id = e1) <> e1_amt THEN
    RAISE EXCEPTION 'T9 FAIL: expense not restored';
  END IF;
  IF EXISTS (SELECT 1 FROM supplier_tax_invoice_pos WHERE invoice_id = inv1 AND active)
     OR (SELECT status FROM supplier_tax_invoices WHERE id = inv1) <> 'void'
     OR EXISTS (SELECT 1 FROM supplier_tax_invoice_reversals WHERE invoice_id = inv1 AND restored_movement_id IS NULL) THEN
    RAISE EXCEPTION 'T9 FAIL: links/status/restored ids';
  END IF;
  RAISE NOTICE 'T9 (void restores): PASSED';

  -- T10: void twice / post a void -> refused
  BEGIN
    PERFORM void_supplier_tax_invoice(inv1, 'again');
    RAISE EXCEPTION 'T10 FAIL: voided twice';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'not_posted%' THEN RAISE EXCEPTION 'T10 FAIL: got %', v_msg; END IF;
  END;
  BEGIN
    PERFORM post_supplier_tax_invoice(inv1);
    RAISE EXCEPTION 'T10 FAIL: posted a void';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'not_draft%' THEN RAISE EXCEPTION 'T10 FAIL: got %', v_msg; END IF;
  END;
  RAISE NOTICE 'T10 (idempotent void): PASSED';

  -- T11: after void, the number and the PO are free again; draft delete works
  tmp := save_supplier_tax_invoice_draft(NULL,
    jsonb_build_object('supplier_id', sa, 'invoice_no', ' sti-001 ', 'invoice_date', v_bkk, 'net_before_vat', 1000, 'vat', 70),
    '[]'::jsonb, ARRAY[po1]);
  PERFORM delete_supplier_tax_invoice_draft(tmp);
  IF EXISTS (SELECT 1 FROM supplier_tax_invoices WHERE id = tmp) OR EXISTS (SELECT 1 FROM supplier_tax_invoice_pos WHERE invoice_id = tmp) THEN
    RAISE EXCEPTION 'T11 FAIL: draft not deleted';
  END IF;
  RAISE NOTICE 'T11 (reuse after void, delete draft): PASSED';

  -- T12: consumed stock -> negative balance allowed and reported; match note needed; void restores
  PERFORM receive_po_with_deposits(po3, '[]'::jsonb, 2000, 140);
  PERFORM record_stock_movement(x, s2, 'purchase_in', 20, 100, 'purchase_order', po3, NULL);
  PERFORM record_stock_movement(x, s2, 'sale_out', 18, 100, 'invoice', NULL, NULL);       -- 2 left
  inv2 := save_supplier_tax_invoice_draft(NULL,
    jsonb_build_object('supplier_id', sa, 'invoice_no', 'STI-NEG', 'invoice_date', v_bkk, 'net_before_vat', 500, 'vat', 35),
    jsonb_build_array(jsonb_build_object('description', 'X', 'qty', 5, 'unit', 'kg', 'unit_price', 100, 'inventory_item_id', x, 'site_id', s2, 'base_qty', 5)),
    ARRAY[po3]);
  BEGIN
    PERFORM post_supplier_tax_invoice(inv2);
    RAISE EXCEPTION 'T12 FAIL: posted without match note';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'match_note_required%' THEN RAISE EXCEPTION 'T12 FAIL: got %', v_msg; END IF;
  END;
  IF (SELECT quantity_on_hand FROM inventory_stock_balances WHERE inventory_item_id = x AND site_id = s2) <> 2
     OR EXISTS (SELECT 1 FROM stock_movements WHERE reference_id = inv2) THEN
    RAISE EXCEPTION 'T12 FAIL: failed post wrote something';
  END IF;
  PERFORM save_supplier_tax_invoice_draft(inv2,
    jsonb_build_object('supplier_id', sa, 'invoice_no', 'STI-NEG', 'invoice_date', v_bkk, 'net_before_vat', 500, 'vat', 35, 'match_note', 'ส่งของไม่ครบ'),
    jsonb_build_array(jsonb_build_object('description', 'X', 'qty', 5, 'unit', 'kg', 'unit_price', 100, 'inventory_item_id', x, 'site_id', s2, 'base_qty', 5)),
    ARRAY[po3]);
  v_j := post_supplier_tax_invoice(inv2);
  IF jsonb_array_length(v_j->'negative') <> 1 OR ((v_j->'negative'->0)->>'qty')::numeric <> -13 THEN
    RAISE EXCEPTION 'T12 FAIL: negative not reported %', v_j;
  END IF;
  SELECT quantity_on_hand, round(weighted_average_cost, 6) INTO v_q, v_w FROM inventory_stock_balances WHERE inventory_item_id = x AND site_id = s2;
  IF v_q <> -13 OR v_w <> 100 THEN RAISE EXCEPTION 'T12 FAIL: % @ %', v_q, v_w; END IF;
  IF (SELECT match_diff FROM supplier_tax_invoices WHERE id = inv2) <> -1500 THEN RAISE EXCEPTION 'T12 FAIL: match_diff'; END IF;
  PERFORM void_supplier_tax_invoice(inv2, 'ทดสอบ');
  SELECT quantity_on_hand, round(weighted_average_cost, 6) INTO v_q, v_w FROM inventory_stock_balances WHERE inventory_item_id = x AND site_id = s2;
  IF v_q <> 2 OR v_w <> 100 THEN RAISE EXCEPTION 'T12 FAIL: void -> % @ %', v_q, v_w; END IF;
  RAISE NOTICE 'T12 (negative allowed + reported, void restores): PASSED';

  -- T13: deposit-covered PO (no expense): match on goods value, stamping skipped with a warning
  INSERT INTO expenses (date, description, site_id, category_id, supplier_id, amount_no_vat, vat, amount, payment_method, status)
  VALUES (v_bkk, 'มัดจำ', s1, t_cat, sa, 500, 35, 535, 'transfer', 'paid') RETURNING id INTO d_exp;
  INSERT INTO supplier_deposits (expense_id, deposit_invoice_no) VALUES (d_exp, 'AI-STI-1') RETURNING id INTO d_dep;
  IF receive_po_with_deposits(po4, jsonb_build_array(jsonb_build_object('deposit_id', d_dep, 'amount_no_vat', 500)), 500, 35) IS NOT NULL THEN
    RAISE EXCEPTION 'T13 FAIL: deposit fixture created an expense';
  END IF;
  PERFORM record_stock_movement(x, s1, 'purchase_in', 5, 100, 'purchase_order', po4, NULL);
  inv3 := save_supplier_tax_invoice_draft(NULL,
    jsonb_build_object('supplier_id', sa, 'invoice_no', 'STI-DEP', 'invoice_date', v_bkk, 'net_before_vat', 500, 'vat', 35),
    jsonb_build_array(jsonb_build_object('description', 'X', 'qty', 5, 'unit', 'kg', 'unit_price', 100, 'inventory_item_id', x, 'site_id', s1, 'base_qty', 5)),
    ARRAY[po4]);
  v_j := post_supplier_tax_invoice(inv3);
  IF (v_j->>'diff')::numeric <> 0 OR (v_j->>'expenses_stamped')::int <> 0
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j->'checks') e WHERE e->>'code' = 'po_no_expense')
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j->'checks') e WHERE e->>'code' = 'po_has_deposit') THEN
    RAISE EXCEPTION 'T13 FAIL: %', v_j;
  END IF;
  PERFORM void_supplier_tax_invoice(inv3, 'ทดสอบ');
  RAISE NOTICE 'T13 (deposit-covered PO): PASSED';

  -- T14: stock_from_invoice PO: no receipt movement -> nothing reversed; flag locked once posted / received
  PERFORM receive_po_with_deposits(po5, '[]'::jsonb, 600, 42);       -- the app skips the stock loop for this PO
  SELECT quantity_on_hand INTO v_q FROM inventory_stock_balances WHERE inventory_item_id = y AND site_id = s1;   -- 5
  inv4 := save_supplier_tax_invoice_draft(NULL,
    jsonb_build_object('supplier_id', sa, 'invoice_no', 'STI-FLAG', 'invoice_date', v_bkk, 'net_before_vat', 600, 'vat', 42),
    jsonb_build_array(jsonb_build_object('description', 'Y', 'qty', 3, 'unit', 'แผ่น', 'unit_price', 200, 'inventory_item_id', y, 'site_id', s1, 'base_qty', 3)),
    ARRAY[po5]);
  v_j := preview_supplier_tax_invoice(inv4);
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j->'checks') e WHERE e->>'code' = 'po_stock_from_invoice') THEN
    RAISE EXCEPTION 'T14 FAIL: flag check missing %', v_j->'checks';
  END IF;
  PERFORM post_supplier_tax_invoice(inv4);
  IF (SELECT quantity_on_hand FROM inventory_stock_balances WHERE inventory_item_id = y AND site_id = s1) <> v_q + 3
     OR EXISTS (SELECT 1 FROM supplier_tax_invoice_reversals WHERE invoice_id = inv4) THEN
    RAISE EXCEPTION 'T14 FAIL: flagged PO stock';
  END IF;
  BEGIN
    UPDATE purchase_orders SET stock_from_invoice = false WHERE id = po5;
    RAISE EXCEPTION 'T14 FAIL: flag changed on a posted-linked PO';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'po_tax_invoiced%' THEN RAISE EXCEPTION 'T14 FAIL: got %', v_msg; END IF;
  END;
  PERFORM receive_po_with_deposits(po6, '[]'::jsonb, 100, 7);
  BEGIN
    UPDATE purchase_orders SET stock_from_invoice = false WHERE id = po6;
    RAISE EXCEPTION 'T14 FAIL: flag changed after receive';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'po_stock_flag_locked%' THEN RAISE EXCEPTION 'T14 FAIL: got %', v_msg; END IF;
  END;
  RAISE NOTICE 'T14 (stock_from_invoice): PASSED';

  -- T14b: flagged PO received by a stale client (stock posted anyway) -> the real movement is reversed
  PERFORM receive_po_with_deposits(po7, '[]'::jsonb, 400, 28);
  PERFORM record_stock_movement(y, s1, 'purchase_in', 2, 200, 'purchase_order', po7, NULL);
  inv5 := save_supplier_tax_invoice_draft(NULL,
    jsonb_build_object('supplier_id', sa, 'invoice_no', 'STI-STALE', 'invoice_date', v_bkk, 'net_before_vat', 400, 'vat', 28),
    jsonb_build_array(jsonb_build_object('description', 'Y', 'qty', 2, 'unit', 'แผ่น', 'unit_price', 200, 'inventory_item_id', y, 'site_id', s1, 'base_qty', 2)),
    ARRAY[po7]);
  v_j := preview_supplier_tax_invoice(inv5);
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j->'checks') e WHERE e->>'code' = 'po_stock_flag_but_received_stock') THEN
    RAISE EXCEPTION 'T14b FAIL: %', v_j->'checks';
  END IF;
  SELECT quantity_on_hand INTO v_q FROM inventory_stock_balances WHERE inventory_item_id = y AND site_id = s1;
  PERFORM post_supplier_tax_invoice(inv5);
  IF (SELECT quantity_on_hand FROM inventory_stock_balances WHERE inventory_item_id = y AND site_id = s1) <> v_q
     OR (SELECT count(*) FROM supplier_tax_invoice_reversals WHERE invoice_id = inv5) <> 1 THEN
    RAISE EXCEPTION 'T14b FAIL: stale receipt not reversed';
  END IF;
  RAISE NOTICE 'T14b (stale-client receipt reversed): PASSED';

  -- T15: lines must add up to net (ruling A9, no override)
  inv6 := save_supplier_tax_invoice_draft(NULL,
    jsonb_build_object('supplier_id', sa, 'invoice_no', 'STI-LINES', 'invoice_date', v_bkk, 'net_before_vat', 1000, 'vat', 70, 'match_note', 'x'),
    jsonb_build_array(jsonb_build_object('description', 'ค่าของ', 'qty', 1, 'unit_price', 900)),
    ARRAY[po1]);
  BEGIN
    PERFORM post_supplier_tax_invoice(inv6);
    RAISE EXCEPTION 'T15 FAIL: posted with lines != net';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'lines_total_mismatch%' THEN RAISE EXCEPTION 'T15 FAIL: got %', v_msg; END IF;
  END;
  RAISE NOTICE 'T15 (lines_total_mismatch): PASSED';

  -- T16: tolerance boundary on PO1 (subtotal 1000 -> tol 5): 1005.00 passes, 1005.02 needs a note
  PERFORM save_supplier_tax_invoice_draft(inv6,
    jsonb_build_object('supplier_id', sa, 'invoice_no', 'STI-LINES', 'invoice_date', v_bkk, 'net_before_vat', 1005, 'vat', 70.35),
    jsonb_build_array(jsonb_build_object('description', 'ค่าของ', 'qty', 1, 'unit_price', 1005)), ARRAY[po1]);
  v_j := preview_supplier_tax_invoice(inv6);
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_j->'checks') e WHERE (e->>'blocking')::boolean) THEN RAISE EXCEPTION 'T16 FAIL: 5.00 blocked %', v_j->'checks'; END IF;
  PERFORM save_supplier_tax_invoice_draft(inv6,
    jsonb_build_object('supplier_id', sa, 'invoice_no', 'STI-LINES', 'invoice_date', v_bkk, 'net_before_vat', 1005.02, 'vat', 70.35),
    jsonb_build_array(jsonb_build_object('description', 'ค่าของ', 'qty', 1, 'unit_price', 1005.02)), ARRAY[po1]);
  v_j := preview_supplier_tax_invoice(inv6);
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j->'checks') e WHERE e->>'code' = 'match_note_required') THEN RAISE EXCEPTION 'T16 FAIL: 5.02 passed'; END IF;
  PERFORM delete_supplier_tax_invoice_draft(inv6);
  RAISE NOTICE 'T16 (tolerance boundary): PASSED';

  -- T17: future date, cross-tenant PO, other tenant's invoice
  BEGIN
    PERFORM save_supplier_tax_invoice_draft(NULL,
      jsonb_build_object('supplier_id', sa, 'invoice_no', 'STI-FUT', 'invoice_date', v_bkk + 1, 'net_before_vat', 0, 'vat', 0), '[]'::jsonb, '{}'::uuid[]);
    RAISE EXCEPTION 'T17 FAIL: future date accepted';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'invoice_date_in_future%' THEN RAISE EXCEPTION 'T17 FAIL: got %', v_msg; END IF;
  END;
  BEGIN
    PERFORM save_supplier_tax_invoice_draft(NULL,
      jsonb_build_object('supplier_id', sa, 'invoice_no', 'STI-X', 'invoice_date', v_bkk, 'net_before_vat', 0, 'vat', 0), '[]'::jsonb, ARRAY[t2_po]);
    RAISE EXCEPTION 'T17 FAIL: other tenant PO linked';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'po_not_eligible%' THEN RAISE EXCEPTION 'T17 FAIL: got %', v_msg; END IF;
  END;
  BEGIN
    PERFORM post_supplier_tax_invoice(t2_inv);
    RAISE EXCEPTION 'T17 FAIL: posted another tenant invoice';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'invoice_not_found%' THEN RAISE EXCEPTION 'T17 FAIL: got %', v_msg; END IF;
  END;
  RAISE NOTICE 'T17 (date/cross-tenant): PASSED';

  -- T18: expired tenant cannot write
  inv7 := save_supplier_tax_invoice_draft(NULL,
    jsonb_build_object('supplier_id', sa, 'invoice_no', 'STI-EXP', 'invoice_date', v_bkk, 'net_before_vat', 1000, 'vat', 70),
    jsonb_build_array(jsonb_build_object('description', 'ค่าของ', 'qty', 1, 'unit_price', 1000)), ARRAY[po1]);
  RESET role;
  UPDATE tenants SET trial_ends_at = now() - interval '1 day' WHERE id = t_tenant;
  SET LOCAL role = 'authenticated';
  BEGIN
    PERFORM post_supplier_tax_invoice(inv7);
    RAISE EXCEPTION 'T18 FAIL: expired tenant posted';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'insufficient_privilege%' THEN RAISE EXCEPTION 'T18 FAIL: got %', v_msg; END IF;
  END;
  RESET role;
  UPDATE tenants SET trial_ends_at = now() + interval '14 days' WHERE id = t_tenant;
  SET LOCAL role = 'authenticated';
  RAISE NOTICE 'T18 (tenant_can_write): PASSED';

  RESET role;
  RAISE EXCEPTION 'RESULT: supplier_tax_invoice_test ALL PASSED';
END $$;

ROLLBACK;
