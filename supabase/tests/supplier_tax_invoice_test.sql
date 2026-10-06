-- ================================================================
-- Tests for supplier tax invoice matching (migrations 2026-10-08-01 / -02).
--
-- STATUS: dry-run only. This file has never been applied for real: it was executed against the CHANG database
-- (migrations 01 + 02 + this file in ONE transaction that always rolls back) on 2026-10-07 and ended with
-- ALL PASSED; nothing was persisted. It is NOT a regression suite that has run anywhere else.
-- Run only where 2026-10-06-01..03 and 2026-10-07-01..02 are applied; 2026-10-08-01..02 are applied first OR
-- (dry run) prepended in the same transaction.
-- Success ends with: ERROR: RESULT: supplier_tax_invoice_test ALL PASSED
-- (the RAISE rolls everything back). Any other error text = a failure.
-- Concurrency (lock order, deadlocks, FOR SHARE vs FOR UPDATE) cannot be tested in one session.
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
  t2_item UUID; z UUID; w1 UUID; w2 UUID; w3 UUID; w4 UUID; po10 UUID; po11 UUID; po12 UUID; po13 UUID; po14 UUID; po15 UUID; po16 UUID; po17 UUID;
  inv8 UUID; inv9 UUID; inv10 UUID; inv11 UUID; inv12 UUID; inv13 UUID; e_ec UUID; e_dp UUID; d_exp2 UUID; d_dep2 UUID; e_dp_amt NUMERIC; e_dp_prev TEXT;
  w_email TEXT := '__test_sti_worker__@example.com'; v_stmt TEXT;
  nk UUID; rk UUID; hm UUID; sl UUID; pq1 UUID; pq2 UUID; pq3 UUID; pq4 UUID; pq5 UUID; pq6 UUID; pq7 UUID;
  iq1 UUID; iq2 UUID; iq3 UUID; iq4 UUID; iq5 UUID; iq6 UUID; iq7 UUID; iq8 UUID; iq9 UUID; iq10 UUID; v_rev INT;
  f1 UUID; g1 UUID; po22 UUID; po23 UUID; po24 UUID; po25 UUID; po26 UUID; po27 UUID; inv14 UUID; inv15 UUID; inv16 UUID; inv17 UUID;
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
  INSERT INTO inventory_items (tenant_id, name, base_unit) VALUES (t2_tenant, '__sti2 item__', 'kg') RETURNING id INTO t2_item;
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
     OR has_table_privilege('authenticated', 'supplier_tax_invoice_snapshots', 'INSERT')
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
    jsonb_build_object('supplier_id', sa, 'invoice_no', 'STI-001', 'invoice_date', v_bkk - 40, 'net_before_vat', 2000, 'vat', 140),
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
  v_j := post_supplier_tax_invoice(inv1, (SELECT revision FROM supplier_tax_invoices WHERE id = inv1));
  SELECT quantity_on_hand, round(weighted_average_cost, 6) INTO v_q, v_w FROM inventory_stock_balances WHERE inventory_item_id = x AND site_id = s1;
  IF v_q <> 8 OR v_w <> 85 THEN RAISE EXCEPTION 'T5 FAIL: X % @ %', v_q, v_w; END IF;
  SELECT quantity_on_hand, round(weighted_average_cost, 6) INTO v_q, v_w FROM inventory_stock_balances WHERE inventory_item_id = y AND site_id = s1;
  IF v_q <> 4 OR v_w <> 230 THEN RAISE EXCEPTION 'T5 FAIL: Y % @ %', v_q, v_w; END IF;
  SELECT count(*) INTO v_cnt FROM stock_movements WHERE reference_type = 'supplier_tax_invoice' AND reference_id = inv1 AND movement_type = 'purchase_in';
  IF v_cnt <> 2 THEN RAISE EXCEPTION 'T5 FAIL: % invoice movements', v_cnt; END IF;
  SELECT count(*) INTO v_cnt FROM stock_movements WHERE reference_type = 'supplier_tax_invoice' AND reference_id = inv1 AND movement_type = 'receipt_reversal';
  IF v_cnt <> 2 THEN RAISE EXCEPTION 'T5 FAIL: % reversal movements', v_cnt; END IF;
  IF EXISTS (SELECT 1 FROM stock_movements WHERE reference_type = 'supplier_tax_invoice' AND reference_id = inv1
              AND (created_at AT TIME ZONE 'Asia/Bangkok')::date <> v_bkk - 40) THEN
    RAISE EXCEPTION 'T5 FAIL: movement not dated on the invoice date (v_bkk - 40)';
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
    PERFORM post_supplier_tax_invoice(inv1, (SELECT revision FROM supplier_tax_invoices WHERE id = inv1));
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
    PERFORM post_supplier_tax_invoice(inv1, (SELECT revision FROM supplier_tax_invoices WHERE id = inv1));
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
    PERFORM post_supplier_tax_invoice(inv2, (SELECT revision FROM supplier_tax_invoices WHERE id = inv2));
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
  v_j := post_supplier_tax_invoice(inv2, (SELECT revision FROM supplier_tax_invoices WHERE id = inv2));
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
  v_j := post_supplier_tax_invoice(inv3, (SELECT revision FROM supplier_tax_invoices WHERE id = inv3));
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
  PERFORM post_supplier_tax_invoice(inv4, (SELECT revision FROM supplier_tax_invoices WHERE id = inv4));
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
  PERFORM post_supplier_tax_invoice(inv5, (SELECT revision FROM supplier_tax_invoices WHERE id = inv5));
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
    PERFORM post_supplier_tax_invoice(inv6, (SELECT revision FROM supplier_tax_invoices WHERE id = inv6));
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
    PERFORM post_supplier_tax_invoice(t2_inv, (SELECT revision FROM supplier_tax_invoices WHERE id = t2_inv));
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
    PERFORM post_supplier_tax_invoice(inv7, (SELECT revision FROM supplier_tax_invoices WHERE id = inv7));
    RAISE EXCEPTION 'T18 FAIL: expired tenant posted';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'insufficient_privilege%' THEN RAISE EXCEPTION 'T18 FAIL: got %', v_msg; END IF;
  END;
  RESET role;
  UPDATE tenants SET trial_ends_at = now() + interval '14 days' WHERE id = t_tenant;
  SET LOCAL role = 'authenticated';
  RAISE NOTICE 'T18 (tenant_can_write): PASSED';

  -- ════════════ Fix round 1 tests ════════════
  -- T19: void is an exact inverse even when post drove the balance to <= 0 (ruling C1).
  -- New items/POs per scenario (superuser fixtures, then back to the tenant owner). Site s1 throughout.
  RESET role;
  INSERT INTO inventory_items (tenant_id, name, base_unit) VALUES (t_tenant, '__sti W1__', 'kg') RETURNING id INTO w1;
  INSERT INTO inventory_items (tenant_id, name, base_unit) VALUES (t_tenant, '__sti W2__', 'kg') RETURNING id INTO w2;
  INSERT INTO inventory_items (tenant_id, name, base_unit) VALUES (t_tenant, '__sti W3__', 'kg') RETURNING id INTO w3;
  INSERT INTO inventory_items (tenant_id, name, base_unit) VALUES (t_tenant, '__sti W4__', 'kg') RETURNING id INTO w4;
  INSERT INTO inventory_items (tenant_id, name, base_unit) VALUES (t_tenant, '__sti Z__', 'kg') RETURNING id INTO z;
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status, has_vat, price_includes_vat)
  VALUES (t_tenant, 'PO-STI-10', s1, sa, t_cat, v_bkk, 'ordered', true, false) RETURNING id INTO po10;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total) VALUES (t_tenant, po10, 'W1', 10, 100, 1000);
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status, has_vat, price_includes_vat)
  VALUES (t_tenant, 'PO-STI-11', s1, sa, t_cat, v_bkk, 'ordered', true, false) RETURNING id INTO po11;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total) VALUES (t_tenant, po11, 'W2', 10, 100, 1000);
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status, has_vat, price_includes_vat)
  VALUES (t_tenant, 'PO-STI-12', s1, sa, t_cat, v_bkk, 'ordered', true, false) RETURNING id INTO po12;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total) VALUES (t_tenant, po12, 'W3', 20, 100, 2000);
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status, has_vat, price_includes_vat)
  VALUES (t_tenant, 'PO-STI-13', s1, sa, t_cat, v_bkk, 'ordered', true, false) RETURNING id INTO po13;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total) VALUES (t_tenant, po13, 'W4', 10, 100, 1000);
  SET LOCAL role = 'authenticated';
  PERFORM set_config('request.jwt.claims', json_build_object('email', email, 'role', 'authenticated')::text, true);

  -- T19a: balance reaches EXACTLY zero. W1: receipt 10@100, sold 4 -> 6@100. Invoice line 4@90 (amount 360).
  --   post: line  q=6+4=10, wac=(6*100+4*90)/10 = 96;  reversal of 10@100 -> q=0, keeps wac 96  => 0@96.
  --   formulas alone would void to 6@106.67; the snapshot restore must give 6@100.
  PERFORM receive_po_with_deposits(po10, '[]'::jsonb, 1000, 70);
  PERFORM record_stock_movement(w1, s1, 'purchase_in', 10, 100, 'purchase_order', po10, NULL);
  PERFORM record_stock_movement(w1, s1, 'sale_out', 4, 100, 'invoice', NULL, NULL);
  inv8 := save_supplier_tax_invoice_draft(NULL,
    jsonb_build_object('supplier_id', sa, 'invoice_no', 'STI-ZERO', 'invoice_date', v_bkk, 'net_before_vat', 360, 'vat', 25.2, 'match_note', 'ทดสอบ'),
    jsonb_build_array(jsonb_build_object('description', 'W1', 'qty', 4, 'unit', 'kg', 'unit_price', 90, 'inventory_item_id', w1, 'site_id', s1, 'base_qty', 4)),
    ARRAY[po10]);
  PERFORM post_supplier_tax_invoice(inv8, (SELECT revision FROM supplier_tax_invoices WHERE id = inv8));
  SELECT quantity_on_hand, round(weighted_average_cost, 6) INTO v_q, v_w FROM inventory_stock_balances WHERE inventory_item_id = w1 AND site_id = s1;
  IF v_q <> 0 OR v_w <> 96 THEN RAISE EXCEPTION 'T19a FAIL: after post % @ % (want 0 @ 96)', v_q, v_w; END IF;
  v_j := void_supplier_tax_invoice(inv8, 'ทดสอบ');
  SELECT quantity_on_hand, weighted_average_cost INTO v_q, v_w FROM inventory_stock_balances WHERE inventory_item_id = w1 AND site_id = s1;
  IF v_q <> 6 OR v_w <> 100 THEN RAISE EXCEPTION 'T19a FAIL: void -> % @ % (want exactly 6 @ 100)', v_q, v_w; END IF;
  IF jsonb_array_length(v_j->'warnings') <> 0 THEN RAISE EXCEPTION 'T19a FAIL: unexpected warnings %', v_j; END IF;
  RAISE NOTICE 'T19a (zero balance, exact restore): PASSED';

  -- T19b: positive partial consumption, invoice cost != PO cost. W2: 10@100 sold 4 -> 6@100; invoice line 12@90 (1080).
  --   post: line q=18, wac=(600+1080)/18=93.3333; reversal 10@100: q=8, wac=(18*93.3333-1000)/8 = 85  => 8@85.
  PERFORM receive_po_with_deposits(po11, '[]'::jsonb, 1000, 70);
  PERFORM record_stock_movement(w2, s1, 'purchase_in', 10, 100, 'purchase_order', po11, NULL);
  PERFORM record_stock_movement(w2, s1, 'sale_out', 4, 100, 'invoice', NULL, NULL);
  inv9 := save_supplier_tax_invoice_draft(NULL,
    jsonb_build_object('supplier_id', sa, 'invoice_no', 'STI-POS', 'invoice_date', v_bkk, 'net_before_vat', 1080, 'vat', 75.6, 'match_note', 'ทดสอบ'),
    jsonb_build_array(jsonb_build_object('description', 'W2', 'qty', 12, 'unit', 'kg', 'unit_price', 90, 'inventory_item_id', w2, 'site_id', s1, 'base_qty', 12)),
    ARRAY[po11]);
  PERFORM post_supplier_tax_invoice(inv9, (SELECT revision FROM supplier_tax_invoices WHERE id = inv9));
  SELECT quantity_on_hand, round(weighted_average_cost, 6) INTO v_q, v_w FROM inventory_stock_balances WHERE inventory_item_id = w2 AND site_id = s1;
  IF v_q <> 8 OR v_w <> 85 THEN RAISE EXCEPTION 'T19b FAIL: after post % @ % (want 8 @ 85)', v_q, v_w; END IF;
  PERFORM void_supplier_tax_invoice(inv9, 'ทดสอบ');
  SELECT quantity_on_hand, weighted_average_cost INTO v_q, v_w FROM inventory_stock_balances WHERE inventory_item_id = w2 AND site_id = s1;
  IF v_q <> 6 OR v_w <> 100 THEN RAISE EXCEPTION 'T19b FAIL: void -> % @ % (want exactly 6 @ 100)', v_q, v_w; END IF;
  RAISE NOTICE 'T19b (positive, cost differs, exact restore): PASSED';

  -- T19c: balance goes NEGATIVE with invoice cost != PO cost. W3: 20@100 sold 18 -> 2@100; invoice line 5@90 (450).
  --   post: line q=7, wac=(200+450)/7=92.857143; reversal 20: q=-13 keeps wac => -13@92.857143 (reported as negative).
  --   formulas alone would void to 2@171.43; snapshot restore must give 2@100.
  PERFORM receive_po_with_deposits(po12, '[]'::jsonb, 2000, 140);
  PERFORM record_stock_movement(w3, s1, 'purchase_in', 20, 100, 'purchase_order', po12, NULL);
  PERFORM record_stock_movement(w3, s1, 'sale_out', 18, 100, 'invoice', NULL, NULL);
  inv10 := save_supplier_tax_invoice_draft(NULL,
    jsonb_build_object('supplier_id', sa, 'invoice_no', 'STI-NEG2', 'invoice_date', v_bkk, 'net_before_vat', 450, 'vat', 31.5, 'match_note', 'ทดสอบ'),
    jsonb_build_array(jsonb_build_object('description', 'W3', 'qty', 5, 'unit', 'kg', 'unit_price', 90, 'inventory_item_id', w3, 'site_id', s1, 'base_qty', 5)),
    ARRAY[po12]);
  v_j := post_supplier_tax_invoice(inv10, (SELECT revision FROM supplier_tax_invoices WHERE id = inv10));
  SELECT quantity_on_hand, round(weighted_average_cost, 6) INTO v_q, v_w FROM inventory_stock_balances WHERE inventory_item_id = w3 AND site_id = s1;
  IF v_q <> -13 OR v_w <> 92.857143 OR jsonb_array_length(v_j->'negative') <> 1 THEN RAISE EXCEPTION 'T19c FAIL: after post % @ % %', v_q, v_w, v_j->'negative'; END IF;
  PERFORM void_supplier_tax_invoice(inv10, 'ทดสอบ');
  SELECT quantity_on_hand, weighted_average_cost INTO v_q, v_w FROM inventory_stock_balances WHERE inventory_item_id = w3 AND site_id = s1;
  IF v_q <> 2 OR v_w <> 100 THEN RAISE EXCEPTION 'T19c FAIL: void -> % @ % (want exactly 2 @ 100)', v_q, v_w; END IF;
  RAISE NOTICE 'T19c (negative, exact restore): PASSED';

  -- T19d: stock moved AFTER post -> void still works by the formulas and warns void_inexact (never blocks).
  --   W4: receipt 10@100 (no consumption). Invoice line 12@90 (1080).
  --   post: line q=22, wac=(1000+1080)/22=94.545454; reversal 10@100: q=12, wac=(22*94.545454-1000)/12 = 90 => 12@90.
  --   then sale_out 3 -> 9@90. void by formulas: restore +10@100: q=19, wac=(9*90+10*100)/19=95.263158;
  --   remove line 12@90: q=7, wac=(19*95.263158-12*90)/7 = 104.285714.
  PERFORM receive_po_with_deposits(po13, '[]'::jsonb, 1000, 70);
  PERFORM record_stock_movement(w4, s1, 'purchase_in', 10, 100, 'purchase_order', po13, NULL);
  inv11 := save_supplier_tax_invoice_draft(NULL,
    jsonb_build_object('supplier_id', sa, 'invoice_no', 'STI-MOVED', 'invoice_date', v_bkk, 'net_before_vat', 1080, 'vat', 75.6, 'match_note', 'ทดสอบ'),
    jsonb_build_array(jsonb_build_object('description', 'W4', 'qty', 12, 'unit', 'kg', 'unit_price', 90, 'inventory_item_id', w4, 'site_id', s1, 'base_qty', 12)),
    ARRAY[po13]);
  PERFORM post_supplier_tax_invoice(inv11, (SELECT revision FROM supplier_tax_invoices WHERE id = inv11));
  PERFORM record_stock_movement(w4, s1, 'sale_out', 3, 90, 'invoice', NULL, NULL);
  v_j := void_supplier_tax_invoice(inv11, 'ทดสอบ');
  SELECT quantity_on_hand, round(weighted_average_cost, 6) INTO v_q, v_w FROM inventory_stock_balances WHERE inventory_item_id = w4 AND site_id = s1;
  IF v_q <> 7 OR v_w <> 104.285714 THEN RAISE EXCEPTION 'T19d FAIL: void -> % @ % (want 7 @ 104.285714)', v_q, v_w; END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j->'warnings') e WHERE e->>'code' = 'void_inexact')
     OR (SELECT status FROM supplier_tax_invoices WHERE id = inv11) <> 'void' THEN
    RAISE EXCEPTION 'T19d FAIL: void_inexact missing or not voided %', v_j;
  END IF;
  RAISE NOTICE 'T19d (void_inexact path): PASSED';

  -- T20: late receipt movement on a PO linked to a posted invoice is refused; other cases are untouched
  --   (po5 is linked to the posted inv4 from T14).
  BEGIN
    PERFORM record_stock_movement(y, s1, 'purchase_in', 1, 200, 'purchase_order', po5, NULL);
    RAISE EXCEPTION 'T20 FAIL: late receipt movement allowed';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'po_tax_invoiced%' THEN RAISE EXCEPTION 'T20 FAIL: got %', v_msg; END IF;
  END;
  RESET role;
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status, has_vat, price_includes_vat)
  VALUES (t_tenant, 'PO-STI-14', s1, sa, t_cat, v_bkk, 'ordered', true, false) RETURNING id INTO po14;
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status, has_vat, price_includes_vat, stock_from_invoice)
  VALUES (t_tenant, 'PO-STI-15', s1, sa, t_cat, v_bkk, 'ordered', true, false, true) RETURNING id INTO po15;
  SET LOCAL role = 'authenticated';
  PERFORM record_stock_movement(z, s1, 'purchase_in', 1, 10, 'purchase_order', po14, NULL);      -- unflagged, not invoiced
  PERFORM record_stock_movement(z, s1, 'purchase_in', 1, 10, 'purchase_order', po15, NULL);      -- flagged, not invoiced
  PERFORM record_stock_movement(z, s1, 'purchase_in', 1, 10, NULL, NULL, NULL);                  -- no reference at all
  PERFORM record_stock_movement(z, s1, 'sale_out', 1, 10, 'invoice', NULL, NULL);                -- other movement type
  SELECT quantity_on_hand INTO v_q FROM inventory_stock_balances WHERE inventory_item_id = z AND site_id = s1;
  IF v_q <> 2 THEN RAISE EXCEPTION 'T20 FAIL: ordinary movements affected, balance %', v_q; END IF;
  RAISE NOTICE 'T20 (late receipt guard): PASSED';

  -- T21: NaN / Infinity are rejected everywhere (ruling I2)
  FOREACH v_txt IN ARRAY ARRAY['NaN', 'Infinity', '-Infinity'] LOOP
    BEGIN
      PERFORM save_supplier_tax_invoice_draft(NULL,
        jsonb_build_object('supplier_id', sa, 'invoice_no', 'STI-NAN', 'invoice_date', v_bkk, 'net_before_vat', v_txt, 'vat', 0), '[]'::jsonb, '{}'::uuid[]);
      RAISE EXCEPTION 'T21 FAIL: header % accepted', v_txt;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
      IF v_msg NOT LIKE 'bad_header%' THEN RAISE EXCEPTION 'T21 FAIL: header % got %', v_txt, v_msg; END IF;
    END;
    BEGIN
      PERFORM save_supplier_tax_invoice_draft(NULL,
        jsonb_build_object('supplier_id', sa, 'invoice_no', 'STI-NAN', 'invoice_date', v_bkk, 'net_before_vat', 0, 'vat', v_txt), '[]'::jsonb, '{}'::uuid[]);
      RAISE EXCEPTION 'T21 FAIL: header vat % accepted', v_txt;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
      IF v_msg NOT LIKE 'bad_header%' THEN RAISE EXCEPTION 'T21 FAIL: header vat % got %', v_txt, v_msg; END IF;
    END;
    BEGIN
      PERFORM save_supplier_tax_invoice_draft(NULL,
        jsonb_build_object('supplier_id', sa, 'invoice_no', 'STI-NAN', 'invoice_date', v_bkk, 'net_before_vat', 0, 'vat', 0),
        jsonb_build_array(jsonb_build_object('description', 'n', 'qty', v_txt, 'unit_price', 1)), '{}'::uuid[]);
      RAISE EXCEPTION 'T21 FAIL: qty % accepted', v_txt;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
      IF v_msg NOT LIKE 'bad_item%' THEN RAISE EXCEPTION 'T21 FAIL: qty % got %', v_txt, v_msg; END IF;
    END;
    BEGIN
      PERFORM save_supplier_tax_invoice_draft(NULL,
        jsonb_build_object('supplier_id', sa, 'invoice_no', 'STI-NAN', 'invoice_date', v_bkk, 'net_before_vat', 0, 'vat', 0),
        jsonb_build_array(jsonb_build_object('description', 'n', 'qty', 1, 'unit_price', v_txt)), '{}'::uuid[]);
      RAISE EXCEPTION 'T21 FAIL: price % accepted', v_txt;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
      IF v_msg NOT LIKE 'bad_item%' THEN RAISE EXCEPTION 'T21 FAIL: price % got %', v_txt, v_msg; END IF;
    END;
    BEGIN
      PERFORM save_supplier_tax_invoice_draft(NULL,
        jsonb_build_object('supplier_id', sa, 'invoice_no', 'STI-NAN', 'invoice_date', v_bkk, 'net_before_vat', 0, 'vat', 0),
        jsonb_build_array(jsonb_build_object('description', 'n', 'qty', 1, 'unit_price', 1, 'discount_pct', v_txt)), '{}'::uuid[]);
      RAISE EXCEPTION 'T21 FAIL: discount % accepted', v_txt;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
      IF v_msg NOT LIKE 'bad_item%' THEN RAISE EXCEPTION 'T21 FAIL: discount % got %', v_txt, v_msg; END IF;
    END;
    BEGIN
      PERFORM save_supplier_tax_invoice_draft(NULL,
        jsonb_build_object('supplier_id', sa, 'invoice_no', 'STI-NAN', 'invoice_date', v_bkk, 'net_before_vat', 0, 'vat', 0),
        jsonb_build_array(jsonb_build_object('description', 'n', 'qty', 1, 'unit_price', 1, 'inventory_item_id', x, 'site_id', s1, 'base_qty', v_txt)), '{}'::uuid[]);
      RAISE EXCEPTION 'T21 FAIL: base_qty % accepted', v_txt;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
      IF v_msg NOT LIKE 'bad_item%' THEN RAISE EXCEPTION 'T21 FAIL: base_qty % got %', v_txt, v_msg; END IF;
    END;
  END LOOP;
  -- the table CHECKs are a second line of defence (as the superuser, bypassing the RPCs)
  RESET role;
  BEGIN
    INSERT INTO supplier_tax_invoices (tenant_id, supplier_id, invoice_no, invoice_date, net_before_vat, vat, grand_total)
    VALUES (t_tenant, sa, 'NAN-CHK', v_bkk, 'NaN'::numeric, 0, 'NaN'::numeric);
    RAISE EXCEPTION 'T21 FAIL: table accepted NaN';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO supplier_tax_invoices (tenant_id, supplier_id, invoice_no, invoice_date, net_before_vat, vat, grand_total)
    VALUES (t_tenant, sa, 'INF-CHK', v_bkk, 'Infinity'::numeric, 0, 'Infinity'::numeric);
    RAISE EXCEPTION 'T21 FAIL: table accepted Infinity';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  SET LOCAL role = 'authenticated';
  RAISE NOTICE 'T21 (NaN/Infinity rejected): PASSED';

  -- T22: a non-admin user and anon cannot call any public RPC
  RESET role;
  INSERT INTO user_roles (user_email, role, status, tenant_id) VALUES (w_email, 'WORKER', 'approved', t_tenant);
  SET LOCAL role = 'authenticated';
  PERFORM set_config('request.jwt.claims', json_build_object('email', w_email, 'role', 'authenticated')::text, true);
  FOREACH v_stmt IN ARRAY ARRAY[
    'SELECT save_supplier_tax_invoice_draft(NULL, ''{}''::jsonb, ''[]''::jsonb, ''{}''::uuid[])',
    'SELECT delete_supplier_tax_invoice_draft(gen_random_uuid())',
    'SELECT preview_supplier_tax_invoice(gen_random_uuid())',
    'SELECT post_supplier_tax_invoice(gen_random_uuid(), 1)',
    'SELECT void_supplier_tax_invoice(gen_random_uuid(), ''x'')'] LOOP
    BEGIN
      EXECUTE v_stmt;
      RAISE EXCEPTION 'T22 FAIL: worker allowed: %', v_stmt;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
      IF v_msg NOT LIKE 'insufficient_privilege%' THEN RAISE EXCEPTION 'T22 FAIL: worker % got %', v_stmt, v_msg; END IF;
    END;
  END LOOP;
  RESET role;
  SET LOCAL role = 'anon';
  FOREACH v_stmt IN ARRAY ARRAY[
    'SELECT save_supplier_tax_invoice_draft(NULL, ''{}''::jsonb, ''[]''::jsonb, ''{}''::uuid[])',
    'SELECT delete_supplier_tax_invoice_draft(gen_random_uuid())',
    'SELECT preview_supplier_tax_invoice(gen_random_uuid())',
    'SELECT post_supplier_tax_invoice(gen_random_uuid(), 1)',
    'SELECT void_supplier_tax_invoice(gen_random_uuid(), ''x'')'] LOOP
    BEGIN
      EXECUTE v_stmt;
      RAISE EXCEPTION 'T22 FAIL: anon allowed: %', v_stmt;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
      IF v_state <> '42501' THEN RAISE EXCEPTION 'T22 FAIL: anon % got sqlstate %', v_stmt, v_state; END IF;
    END;
  END LOOP;
  RESET role;
  SET LOCAL role = 'authenticated';
  PERFORM set_config('request.jwt.claims', json_build_object('email', email, 'role', 'authenticated')::text, true);
  RAISE NOTICE 'T22 (non-admin / anon denied): PASSED';

  -- T23: cross-tenant references, other tenant's invoice
  BEGIN
    PERFORM save_supplier_tax_invoice_draft(NULL,
      jsonb_build_object('supplier_id', t2_sup, 'invoice_no', 'STI-XS', 'invoice_date', v_bkk, 'net_before_vat', 0, 'vat', 0), '[]'::jsonb, '{}'::uuid[]);
    RAISE EXCEPTION 'T23 FAIL: other tenant supplier accepted';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'cross_tenant_reference%' THEN RAISE EXCEPTION 'T23 FAIL: supplier got %', v_msg; END IF;
  END;
  BEGIN
    PERFORM save_supplier_tax_invoice_draft(NULL,
      jsonb_build_object('supplier_id', sa, 'invoice_no', 'STI-XI', 'invoice_date', v_bkk, 'net_before_vat', 0, 'vat', 0),
      jsonb_build_array(jsonb_build_object('description', 'n', 'qty', 1, 'unit_price', 1, 'inventory_item_id', t2_item, 'site_id', s1, 'base_qty', 1)), '{}'::uuid[]);
    RAISE EXCEPTION 'T23 FAIL: other tenant item accepted';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'cross_tenant_reference%' THEN RAISE EXCEPTION 'T23 FAIL: item got %', v_msg; END IF;
  END;
  BEGIN
    PERFORM save_supplier_tax_invoice_draft(NULL,
      jsonb_build_object('supplier_id', sa, 'invoice_no', 'STI-XT', 'invoice_date', v_bkk, 'net_before_vat', 0, 'vat', 0),
      jsonb_build_array(jsonb_build_object('description', 'n', 'qty', 1, 'unit_price', 1, 'inventory_item_id', x, 'site_id', t2_site, 'base_qty', 1)), '{}'::uuid[]);
    RAISE EXCEPTION 'T23 FAIL: other tenant site accepted';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'cross_tenant_reference%' THEN RAISE EXCEPTION 'T23 FAIL: site got %', v_msg; END IF;
  END;
  v_j := preview_supplier_tax_invoice(t2_inv);
  IF (v_j->'checks'->0->>'code') <> 'invoice_not_found' OR jsonb_array_length(v_j->'rows') <> 0 THEN
    RAISE EXCEPTION 'T23 FAIL: preview of another tenant invoice %', v_j;
  END IF;
  BEGIN
    PERFORM void_supplier_tax_invoice(t2_inv, 'x');
    RAISE EXCEPTION 'T23 FAIL: voided another tenant invoice';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'invoice_not_found%' THEN RAISE EXCEPTION 'T23 FAIL: void got %', v_msg; END IF;
  END;
  BEGIN
    PERFORM delete_supplier_tax_invoice_draft(t2_inv);
    RAISE EXCEPTION 'T23 FAIL: deleted another tenant invoice';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'invoice_not_found%' THEN RAISE EXCEPTION 'T23 FAIL: delete got %', v_msg; END IF;
  END;
  RAISE NOTICE 'T23 (cross-tenant): PASSED';

  -- T24: void when the expense's invoice number was edited after posting -> expense_changed warning, number left alone
  RESET role;
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status, has_vat, price_includes_vat)
  VALUES (t_tenant, 'PO-STI-16', s1, sa, t_cat, v_bkk, 'ordered', true, false) RETURNING id INTO po16;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total) VALUES (t_tenant, po16, 'misc', 1, 100, 100);
  SET LOCAL role = 'authenticated';
  e_ec := receive_po_with_deposits(po16, '[]'::jsonb, 100, 7);
  inv12 := save_supplier_tax_invoice_draft(NULL,
    jsonb_build_object('supplier_id', sa, 'invoice_no', 'STI-EC', 'invoice_date', v_bkk, 'net_before_vat', 100, 'vat', 7),
    jsonb_build_array(jsonb_build_object('description', 'misc', 'qty', 1, 'unit_price', 100)), ARRAY[po16]);
  v_j := post_supplier_tax_invoice(inv12, (SELECT revision FROM supplier_tax_invoices WHERE id = inv12));
  IF (v_j->>'expenses_stamped')::int <> 1 OR (SELECT invoice_no FROM expenses WHERE id = e_ec) <> 'STI-EC' THEN RAISE EXCEPTION 'T24 FAIL: not stamped %', v_j; END IF;
  RESET role;
  UPDATE expenses SET invoice_no = 'EDITED-BY-HAND' WHERE id = e_ec;
  SET LOCAL role = 'authenticated';
  v_j := void_supplier_tax_invoice(inv12, 'ทดสอบ');
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j->'warnings') e WHERE e->>'code' = 'expense_changed' AND (e->>'po_id')::uuid = po16)
     OR (SELECT invoice_no FROM expenses WHERE id = e_ec) <> 'EDITED-BY-HAND'
     OR (SELECT status FROM supplier_tax_invoices WHERE id = inv12) <> 'void' THEN
    RAISE EXCEPTION 'T24 FAIL: expense_changed path %', v_j;
  END IF;
  RAISE NOTICE 'T24 (expense_changed): PASSED';

  -- T25: deposit PO that still has a remainder expense: stamping must pass expenses_block_deposit_edit_trg
  --   (only invoice_no / notes change; amounts untouched), and void restores the number.
  RESET role;
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status, has_vat, price_includes_vat)
  VALUES (t_tenant, 'PO-STI-17', s1, sa, t_cat, v_bkk, 'ordered', true, false) RETURNING id INTO po17;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total) VALUES (t_tenant, po17, 'misc', 1, 1000, 1000);
  SET LOCAL role = 'authenticated';
  INSERT INTO expenses (date, description, site_id, category_id, supplier_id, amount_no_vat, vat, amount, payment_method, status)
  VALUES (v_bkk, 'มัดจำ 2', s1, t_cat, sa, 400, 28, 428, 'transfer', 'paid') RETURNING id INTO d_exp2;
  INSERT INTO supplier_deposits (expense_id, deposit_invoice_no) VALUES (d_exp2, 'AI-STI-2') RETURNING id INTO d_dep2;
  e_dp := receive_po_with_deposits(po17, jsonb_build_array(jsonb_build_object('deposit_id', d_dep2, 'amount_no_vat', 400)), 1000, 70);
  IF e_dp IS NULL THEN RAISE EXCEPTION 'T25 FAIL: no remainder expense'; END IF;
  SELECT amount, invoice_no INTO e_dp_amt, e_dp_prev FROM expenses WHERE id = e_dp;
  inv13 := save_supplier_tax_invoice_draft(NULL,
    jsonb_build_object('supplier_id', sa, 'invoice_no', 'STI-DEPREM', 'invoice_date', v_bkk, 'net_before_vat', 1000, 'vat', 70),
    jsonb_build_array(jsonb_build_object('description', 'misc', 'qty', 1, 'unit_price', 1000)), ARRAY[po17]);
  v_j := post_supplier_tax_invoice(inv13, (SELECT revision FROM supplier_tax_invoices WHERE id = inv13));
  IF (v_j->>'expenses_stamped')::int <> 1 OR (v_j->>'diff')::numeric <> 0
     OR NOT EXISTS (SELECT 1 FROM expenses WHERE id = e_dp AND invoice_no = 'STI-DEPREM' AND amount = e_dp_amt)
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j->'checks') e WHERE e->>'code' = 'po_has_deposit') THEN
    RAISE EXCEPTION 'T25 FAIL: remainder expense stamping %', v_j;
  END IF;
  PERFORM void_supplier_tax_invoice(inv13, 'ทดสอบ');
  IF (SELECT invoice_no FROM expenses WHERE id = e_dp) IS DISTINCT FROM e_dp_prev OR (SELECT amount FROM expenses WHERE id = e_dp) <> e_dp_amt THEN
    RAISE EXCEPTION 'T25 FAIL: remainder expense not restored';
  END IF;
  RAISE NOTICE 'T25 (deposit remainder expense): PASSED';

  -- ════════════ Fix round 2 tests ════════════
  -- T19e/T19f: two invoices on the SAME item can end on identical (qty, wac). Void must not restore a stale snapshot.
  -- Item F1: POs po22 + po23 each received 10@100 (20 on hand), 25 sold -> -5@100.
  --   I1 (po22, line 10@80): line q=-5+10=5, wac=(-5*100+10*80)/5=60; reversal 10@100: q=-5, wac kept 60  => -5@60.
  --   I2 (po23, line 10@60): line q=5, wac=(-5*60+10*60)/5=60; reversal: q=-5, wac kept 60                => -5@60 (same as I1's after!).
  RESET role;
  INSERT INTO inventory_items (tenant_id, name, base_unit) VALUES (t_tenant, '__sti F1__', 'kg') RETURNING id INTO f1;
  INSERT INTO inventory_items (tenant_id, name, base_unit) VALUES (t_tenant, '__sti G1__', 'kg') RETURNING id INTO g1;
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status, has_vat, price_includes_vat)
  VALUES (t_tenant, 'PO-STI-22', s1, sa, t_cat, v_bkk, 'ordered', true, false) RETURNING id INTO po22;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total) VALUES (t_tenant, po22, 'F1', 10, 100, 1000);
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status, has_vat, price_includes_vat)
  VALUES (t_tenant, 'PO-STI-23', s1, sa, t_cat, v_bkk, 'ordered', true, false) RETURNING id INTO po23;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total) VALUES (t_tenant, po23, 'F1', 10, 100, 1000);
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status, has_vat, price_includes_vat)
  VALUES (t_tenant, 'PO-STI-24', s1, sa, t_cat, v_bkk, 'ordered', true, false) RETURNING id INTO po24;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total) VALUES (t_tenant, po24, 'G1', 10, 100, 1000);
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status, has_vat, price_includes_vat)
  VALUES (t_tenant, 'PO-STI-25', s1, sa, t_cat, v_bkk, 'ordered', true, false) RETURNING id INTO po25;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total) VALUES (t_tenant, po25, 'G1', 10, 100, 1000);
  SET LOCAL role = 'authenticated';
  PERFORM set_config('request.jwt.claims', json_build_object('email', email, 'role', 'authenticated')::text, true);

  PERFORM receive_po_with_deposits(po22, '[]'::jsonb, 1000, 70);
  PERFORM record_stock_movement(f1, s1, 'purchase_in', 10, 100, 'purchase_order', po22, NULL);
  PERFORM receive_po_with_deposits(po23, '[]'::jsonb, 1000, 70);
  PERFORM record_stock_movement(f1, s1, 'purchase_in', 10, 100, 'purchase_order', po23, NULL);
  PERFORM record_stock_movement(f1, s1, 'sale_out', 25, 100, 'invoice', NULL, NULL);
  SELECT quantity_on_hand, round(weighted_average_cost, 6) INTO v_q, v_w FROM inventory_stock_balances WHERE inventory_item_id = f1 AND site_id = s1;
  IF v_q <> -5 OR v_w <> 100 THEN RAISE EXCEPTION 'T19e FAIL: setup % @ % (want -5 @ 100)', v_q, v_w; END IF;
  inv14 := save_supplier_tax_invoice_draft(NULL,
    jsonb_build_object('supplier_id', sa, 'invoice_no', 'STI-F1', 'invoice_date', v_bkk, 'net_before_vat', 800, 'vat', 56, 'match_note', 'ทดสอบ'),
    jsonb_build_array(jsonb_build_object('description', 'F1', 'qty', 10, 'unit', 'kg', 'unit_price', 80, 'inventory_item_id', f1, 'site_id', s1, 'base_qty', 10)), ARRAY[po22]);
  inv15 := save_supplier_tax_invoice_draft(NULL,
    jsonb_build_object('supplier_id', sa, 'invoice_no', 'STI-F2', 'invoice_date', v_bkk, 'net_before_vat', 600, 'vat', 42, 'match_note', 'ทดสอบ'),
    jsonb_build_array(jsonb_build_object('description', 'F1', 'qty', 10, 'unit', 'kg', 'unit_price', 60, 'inventory_item_id', f1, 'site_id', s1, 'base_qty', 10)), ARRAY[po23]);
  PERFORM post_supplier_tax_invoice(inv14, (SELECT revision FROM supplier_tax_invoices WHERE id = inv14));
  SELECT quantity_on_hand, round(weighted_average_cost, 6) INTO v_q, v_w FROM inventory_stock_balances WHERE inventory_item_id = f1 AND site_id = s1;
  IF v_q <> -5 OR v_w <> 60 THEN RAISE EXCEPTION 'T19e FAIL: after I1 % @ % (want -5 @ 60)', v_q, v_w; END IF;
  PERFORM post_supplier_tax_invoice(inv15, (SELECT revision FROM supplier_tax_invoices WHERE id = inv15));
  SELECT quantity_on_hand, round(weighted_average_cost, 6) INTO v_q, v_w FROM inventory_stock_balances WHERE inventory_item_id = f1 AND site_id = s1;
  IF v_q <> -5 OR v_w <> 60 THEN RAISE EXCEPTION 'T19e FAIL: after I2 % @ % (want -5 @ 60, identical to I1)', v_q, v_w; END IF;
  -- FIFO: void I1 while I2 is posted. The balance LOOKS like I1's post-state, but I2 touched it since -> must warn.
  --   by formulas: restore po22 receipt +10@100: q=5, wac=(-5*60+10*100)/5=140; remove line 10@80: q=-5 keeps 140 => -5@140.
  v_j := void_supplier_tax_invoice(inv14, 'ทดสอบ');
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j->'warnings') e WHERE e->>'code' = 'void_inexact') THEN
    RAISE EXCEPTION 'T19e FAIL: stale snapshot restored silently %', v_j;
  END IF;
  SELECT quantity_on_hand, round(weighted_average_cost, 6) INTO v_q, v_w FROM inventory_stock_balances WHERE inventory_item_id = f1 AND site_id = s1;
  IF v_q <> -5 OR v_w <> 140 THEN RAISE EXCEPTION 'T19e FAIL: void I1 -> % @ % (want -5 @ 140)', v_q, v_w; END IF;
  -- then void I2: still inexact (state moved again). restore po23 receipt +10@100: q=5, wac=(-5*140+1000)/5=60; remove line 10@60: -5 keeps 60.
  v_j := void_supplier_tax_invoice(inv15, 'ทดสอบ');
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j->'warnings') e WHERE e->>'code' = 'void_inexact') THEN
    RAISE EXCEPTION 'T19e FAIL: second FIFO void did not warn %', v_j;
  END IF;
  SELECT quantity_on_hand, round(weighted_average_cost, 6) INTO v_q, v_w FROM inventory_stock_balances WHERE inventory_item_id = f1 AND site_id = s1;
  IF v_q <> -5 OR v_w <> 60 THEN RAISE EXCEPTION 'T19e FAIL: void I2 -> % @ % (want -5 @ 60)', v_q, v_w; END IF;
  RAISE NOTICE 'T19e (FIFO void warns, no stale snapshot): PASSED';

  -- T19f: LIFO on item G1 with the same numbers: void the LAST post first -> exact, no warning; then the first -> exact.
  PERFORM receive_po_with_deposits(po24, '[]'::jsonb, 1000, 70);
  PERFORM record_stock_movement(g1, s1, 'purchase_in', 10, 100, 'purchase_order', po24, NULL);
  PERFORM receive_po_with_deposits(po25, '[]'::jsonb, 1000, 70);
  PERFORM record_stock_movement(g1, s1, 'purchase_in', 10, 100, 'purchase_order', po25, NULL);
  PERFORM record_stock_movement(g1, s1, 'sale_out', 25, 100, 'invoice', NULL, NULL);
  inv16 := save_supplier_tax_invoice_draft(NULL,
    jsonb_build_object('supplier_id', sa, 'invoice_no', 'STI-G1', 'invoice_date', v_bkk, 'net_before_vat', 800, 'vat', 56, 'match_note', 'ทดสอบ'),
    jsonb_build_array(jsonb_build_object('description', 'G1', 'qty', 10, 'unit', 'kg', 'unit_price', 80, 'inventory_item_id', g1, 'site_id', s1, 'base_qty', 10)), ARRAY[po24]);
  inv17 := save_supplier_tax_invoice_draft(NULL,
    jsonb_build_object('supplier_id', sa, 'invoice_no', 'STI-G2', 'invoice_date', v_bkk, 'net_before_vat', 600, 'vat', 42, 'match_note', 'ทดสอบ'),
    jsonb_build_array(jsonb_build_object('description', 'G1', 'qty', 10, 'unit', 'kg', 'unit_price', 60, 'inventory_item_id', g1, 'site_id', s1, 'base_qty', 10)), ARRAY[po25]);
  PERFORM post_supplier_tax_invoice(inv16, (SELECT revision FROM supplier_tax_invoices WHERE id = inv16));
  PERFORM post_supplier_tax_invoice(inv17, (SELECT revision FROM supplier_tax_invoices WHERE id = inv17));
  v_j := void_supplier_tax_invoice(inv17, 'ทดสอบ');
  IF jsonb_array_length(v_j->'warnings') <> 0 THEN RAISE EXCEPTION 'T19f FAIL: LIFO void warned %', v_j; END IF;
  SELECT quantity_on_hand, weighted_average_cost INTO v_q, v_w FROM inventory_stock_balances WHERE inventory_item_id = g1 AND site_id = s1;
  IF v_q <> -5 OR round(v_w, 6) <> 60 THEN RAISE EXCEPTION 'T19f FAIL: void I4 -> % @ % (want -5 @ 60 = state after I3)', v_q, v_w; END IF;
  v_j := void_supplier_tax_invoice(inv16, 'ทดสอบ');
  IF jsonb_array_length(v_j->'warnings') <> 0 THEN RAISE EXCEPTION 'T19f FAIL: second LIFO void warned %', v_j; END IF;
  SELECT quantity_on_hand, weighted_average_cost INTO v_q, v_w FROM inventory_stock_balances WHERE inventory_item_id = g1 AND site_id = s1;
  IF v_q <> -5 OR v_w <> 100 THEN RAISE EXCEPTION 'T19f FAIL: void I3 -> % @ % (want exactly -5 @ 100)', v_q, v_w; END IF;
  RAISE NOTICE 'T19f (LIFO void exact): PASSED';

  -- T26: non-finite PO data is reported as po_data_not_finite (not bad_header) and blocks post
  RESET role;
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status, has_vat, price_includes_vat)
  VALUES (t_tenant, 'PO-STI-26', s1, sa, t_cat, v_bkk, 'received', false, false) RETURNING id INTO po26;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total) VALUES (t_tenant, po26, 'nan', 1, 1, 'NaN'::numeric);
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status, has_vat, price_includes_vat)
  VALUES (t_tenant, 'PO-STI-27', s1, sa, t_cat, v_bkk, 'received', false, false) RETURNING id INTO po27;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total) VALUES (t_tenant, po27, 'ok', 1, 100, 100);
  INSERT INTO stock_movements (tenant_id, inventory_item_id, site_id, movement_type, quantity, unit_cost, reference_type, reference_id)
  VALUES (t_tenant, z, s1, 'purchase_in', 'NaN'::numeric, 1, 'purchase_order', po27);
  SET LOCAL role = 'authenticated';
  FOREACH v_txt IN ARRAY ARRAY['26', '27'] LOOP
    tmp := save_supplier_tax_invoice_draft(NULL,
      jsonb_build_object('supplier_id', sa, 'invoice_no', 'STI-NANPO-' || v_txt, 'invoice_date', v_bkk, 'net_before_vat', 100, 'vat', 0),
      jsonb_build_array(jsonb_build_object('description', 'x', 'qty', 1, 'unit_price', 100)),
      ARRAY[CASE WHEN v_txt = '26' THEN po26 ELSE po27 END]);
    v_j := preview_supplier_tax_invoice(tmp);
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j->'checks') e WHERE e->>'code' = 'po_data_not_finite' AND (e->>'blocking')::boolean)
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_j->'checks') e WHERE e->>'code' = 'bad_header') THEN
      RAISE EXCEPTION 'T26 FAIL: PO % preview %', v_txt, v_j->'checks';
    END IF;
    BEGIN
      PERFORM post_supplier_tax_invoice(tmp, (SELECT revision FROM supplier_tax_invoices WHERE id = tmp));
      RAISE EXCEPTION 'T26 FAIL: PO % posted', v_txt;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
      IF v_msg NOT LIKE 'po_data_not_finite%' THEN RAISE EXCEPTION 'T26 FAIL: PO % got %', v_txt, v_msg; END IF;
    END;
  END LOOP;
  RAISE NOTICE 'T26 (po_data_not_finite): PASSED';

  -- ════════════ Final-review tests ════════════
  -- Fixtures (superuser): items nk/rk/hm/sl, POs pq1..pq7. Back to the tenant owner afterwards.
  RESET role;
  INSERT INTO inventory_items (tenant_id, name, base_unit) VALUES (t_tenant, '__sti NK__', 'kg') RETURNING id INTO nk;
  INSERT INTO inventory_items (tenant_id, name, base_unit) VALUES (t_tenant, '__sti RK__', 'kg') RETURNING id INTO rk;
  INSERT INTO inventory_items (tenant_id, name, base_unit) VALUES (t_tenant, '__sti HM__', 'kg') RETURNING id INTO hm;
  INSERT INTO inventory_items (tenant_id, name, base_unit) VALUES (t_tenant, '__sti SL__', 'kg') RETURNING id INTO sl;
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status, has_vat, price_includes_vat)
  VALUES (t_tenant, 'PO-STI-30', s1, sa, t_cat, v_bkk, 'ordered', true, false) RETURNING id INTO pq1;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total) VALUES (t_tenant, pq1, 'misc', 1, 100, 100);
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status, has_vat, price_includes_vat)
  VALUES (t_tenant, 'PO-STI-31', s1, sa, t_cat, v_bkk, 'ordered', true, false) RETURNING id INTO pq2;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total) VALUES (t_tenant, pq2, 'NK', 6, 50, 300);
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status, has_vat, price_includes_vat)
  VALUES (t_tenant, 'PO-STI-32', s1, sa, t_cat, v_bkk, 'ordered', true, false) RETURNING id INTO pq3;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total) VALUES (t_tenant, pq3, 'RK', 10, 100, 1000);
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status, has_vat, price_includes_vat)
  VALUES (t_tenant, 'PO-STI-33', s1, sa, t_cat, v_bkk, 'ordered', true, false) RETURNING id INTO pq4;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total) VALUES (t_tenant, pq4, 'HM', 10, 100, 1000);
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status, has_vat, price_includes_vat)
  VALUES (t_tenant, 'PO-STI-34', s1, sa, t_cat, v_bkk, 'ordered', true, false) RETURNING id INTO pq5;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total) VALUES (t_tenant, pq5, 'misc', 1, 100, 100);
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status, has_vat, price_includes_vat)
  VALUES (t_tenant, 'PO-STI-35', s1, sa, t_cat, v_bkk - 70, 'ordered', true, false) RETURNING id INTO pq6;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total) VALUES (t_tenant, pq6, 'misc', 1, 100, 100);
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status, has_vat, price_includes_vat)
  VALUES (t_tenant, 'PO-STI-36', s1, sa, t_cat, v_bkk, 'ordered', true, false) RETURNING id INTO pq7;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total) VALUES (t_tenant, pq7, 'misc', 1, 100, 100);
  SET LOCAL role = 'authenticated';
  PERFORM set_config('request.jwt.claims', json_build_object('email', email, 'role', 'authenticated')::text, true);
  PERFORM receive_po_with_deposits(pq1, '[]'::jsonb, 100, 7);
  PERFORM receive_po_with_deposits(pq2, '[]'::jsonb, 300, 21);          -- NO stock movement recorded (like a backfilled month)
  PERFORM receive_po_with_deposits(pq3, '[]'::jsonb, 1000, 70);
  PERFORM record_stock_movement(rk, s1, 'purchase_in', 10, 100, 'purchase_order', pq3, NULL);
  PERFORM receive_po_with_deposits(pq4, '[]'::jsonb, 1000, 70);
  PERFORM record_stock_movement(hm, s1, 'purchase_in', 10, 100, 'purchase_order', pq4, NULL);
  PERFORM receive_po_with_deposits(pq5, '[]'::jsonb, 100, 7);
  PERFORM receive_po_with_deposits(pq6, '[]'::jsonb, 100, 7);
  PERFORM receive_po_with_deposits(pq7, '[]'::jsonb, 100, 7);

  -- T27: server-side stale preview. preview returns the revision; every save bumps it; post must pass the previewed one.
  iq1 := save_supplier_tax_invoice_draft(NULL,
    jsonb_build_object('supplier_id', sa, 'invoice_no', 'STI-REV', 'invoice_date', v_bkk, 'net_before_vat', 100, 'vat', 7),
    jsonb_build_array(jsonb_build_object('description', 'misc', 'qty', 1, 'unit_price', 100)), ARRAY[pq1]);
  SELECT revision INTO v_rev FROM supplier_tax_invoices WHERE id = iq1;
  v_j := preview_supplier_tax_invoice(iq1);
  IF v_rev <> 1 OR (v_j->>'revision')::int <> v_rev THEN RAISE EXCEPTION 'T27 FAIL: revision % preview %', v_rev, v_j->>'revision'; END IF;
  PERFORM save_supplier_tax_invoice_draft(iq1,
    jsonb_build_object('supplier_id', sa, 'invoice_no', 'STI-REV', 'invoice_date', v_bkk, 'net_before_vat', 100, 'vat', 7),
    jsonb_build_array(jsonb_build_object('description', 'misc', 'qty', 1, 'unit_price', 100)), ARRAY[pq1]);
  IF (SELECT revision FROM supplier_tax_invoices WHERE id = iq1) <> v_rev + 1 THEN RAISE EXCEPTION 'T27 FAIL: save did not bump the revision'; END IF;
  BEGIN
    PERFORM post_supplier_tax_invoice(iq1, v_rev);
    RAISE EXCEPTION 'T27 FAIL: posted with an old revision';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'stale_preview%' THEN RAISE EXCEPTION 'T27 FAIL: got %', v_msg; END IF;
  END;
  BEGIN
    PERFORM post_supplier_tax_invoice(iq1, NULL);
    RAISE EXCEPTION 'T27 FAIL: posted without a revision';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'stale_preview%' THEN RAISE EXCEPTION 'T27 FAIL: null revision got %', v_msg; END IF;
  END;
  IF (SELECT status FROM supplier_tax_invoices WHERE id = iq1) <> 'draft' THEN RAISE EXCEPTION 'T27 FAIL: stale post changed the status'; END IF;
  PERFORM post_supplier_tax_invoice(iq1, v_rev + 1);
  IF (SELECT status FROM supplier_tax_invoices WHERE id = iq1) <> 'posted' THEN RAISE EXCEPTION 'T27 FAIL: current revision did not post'; END IF;
  PERFORM void_supplier_tax_invoice(iq1, 'ทดสอบ');
  RAISE NOTICE 'T27 (stale_preview): PASSED';

  -- T28: brand-new balance key (M1) + post -> void -> re-link the same PO -> post again.
  --   NK has no balance row. PO pq2 has no receipt movement (po_no_receipt_movements warning, nothing to reverse).
  --   Invoice line 6 kg @ 50 = 300. post: row created (0@0), +6@50 => 6@50. Snapshot says "did not exist": before 0@0, no stamp.
  SELECT count(*) INTO v_cnt FROM inventory_stock_balances WHERE inventory_item_id = nk;
  IF v_cnt <> 0 THEN RAISE EXCEPTION 'T28 FAIL: NK already has a balance row'; END IF;
  iq2 := save_supplier_tax_invoice_draft(NULL,
    jsonb_build_object('supplier_id', sa, 'invoice_no', 'STI-NK', 'invoice_date', v_bkk, 'net_before_vat', 300, 'vat', 21),
    jsonb_build_array(jsonb_build_object('description', 'NK', 'qty', 6, 'unit', 'kg', 'unit_price', 50, 'inventory_item_id', nk, 'site_id', s1, 'base_qty', 6)), ARRAY[pq2]);
  v_j := preview_supplier_tax_invoice(iq2);
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j->'checks') e WHERE e->>'code' = 'po_no_receipt_movements' AND NOT (e->>'blocking')::boolean) THEN
    RAISE EXCEPTION 'T28 FAIL: double-count warning missing %', v_j->'checks';
  END IF;
  PERFORM post_supplier_tax_invoice(iq2, (SELECT revision FROM supplier_tax_invoices WHERE id = iq2));
  SELECT quantity_on_hand, round(weighted_average_cost, 6) INTO v_q, v_w FROM inventory_stock_balances WHERE inventory_item_id = nk AND site_id = s1;
  IF v_q <> 6 OR v_w <> 50 THEN RAISE EXCEPTION 'T28 FAIL: after post % @ % (want 6 @ 50)', v_q, v_w; END IF;
  IF NOT EXISTS (SELECT 1 FROM supplier_tax_invoice_snapshots WHERE invoice_id = iq2 AND inventory_item_id = nk
                  AND before_qty = 0 AND before_wac = 0 AND before_updated_at IS NULL AND after_qty = 6) THEN
    RAISE EXCEPTION 'T28 FAIL: snapshot of a brand-new key';
  END IF;
  v_j := void_supplier_tax_invoice(iq2, 'ทดสอบ');
  SELECT quantity_on_hand, weighted_average_cost INTO v_q, v_w FROM inventory_stock_balances WHERE inventory_item_id = nk AND site_id = s1;
  IF v_q <> 0 OR v_w <> 0 OR jsonb_array_length(v_j->'warnings') <> 0 THEN RAISE EXCEPTION 'T28 FAIL: void -> % @ % %', v_q, v_w, v_j->'warnings'; END IF;
  iq3 := save_supplier_tax_invoice_draft(NULL,
    jsonb_build_object('supplier_id', sa, 'invoice_no', 'STI-NK2', 'invoice_date', v_bkk, 'net_before_vat', 300, 'vat', 21),
    jsonb_build_array(jsonb_build_object('description', 'NK', 'qty', 6, 'unit', 'kg', 'unit_price', 50, 'inventory_item_id', nk, 'site_id', s1, 'base_qty', 6)), ARRAY[pq2]);
  PERFORM post_supplier_tax_invoice(iq3, (SELECT revision FROM supplier_tax_invoices WHERE id = iq3));
  SELECT quantity_on_hand, round(weighted_average_cost, 6) INTO v_q, v_w FROM inventory_stock_balances WHERE inventory_item_id = nk AND site_id = s1;
  IF v_q <> 6 OR v_w <> 50 THEN RAISE EXCEPTION 'T28 FAIL: re-post % @ % (want 6 @ 50)', v_q, v_w; END IF;
  PERFORM void_supplier_tax_invoice(iq3, 'ทดสอบ');
  RAISE NOTICE 'T28 (brand-new key, void, re-post): PASSED';

  -- T29: post -> void -> re-link the same PO -> post again WITH a PO receipt to reverse (numbers at every step).
  --   RK: PO receipt 10@100 => 10@100. Invoice line 12 kg @ 90 (1080, note needed: PO goods value is 1000).
  --   post: line q=22, wac=(1000+1080)/22=94.545454; reversal 10@100: q=12, wac=(22*94.545454-1000)/12=90 => 12@90.
  --   void (exact): 10@100.  Again post => 12@90.
  iq4 := save_supplier_tax_invoice_draft(NULL,
    jsonb_build_object('supplier_id', sa, 'invoice_no', 'STI-RK1', 'invoice_date', v_bkk, 'net_before_vat', 1080, 'vat', 75.6, 'match_note', 'ทดสอบ'),
    jsonb_build_array(jsonb_build_object('description', 'RK', 'qty', 12, 'unit', 'kg', 'unit_price', 90, 'inventory_item_id', rk, 'site_id', s1, 'base_qty', 12)), ARRAY[pq3]);
  PERFORM post_supplier_tax_invoice(iq4, (SELECT revision FROM supplier_tax_invoices WHERE id = iq4));
  SELECT quantity_on_hand, round(weighted_average_cost, 6) INTO v_q, v_w FROM inventory_stock_balances WHERE inventory_item_id = rk AND site_id = s1;
  IF v_q <> 12 OR v_w <> 90 THEN RAISE EXCEPTION 'T29 FAIL: post 1 % @ % (want 12 @ 90)', v_q, v_w; END IF;
  PERFORM void_supplier_tax_invoice(iq4, 'ทดสอบ');
  SELECT quantity_on_hand, weighted_average_cost INTO v_q, v_w FROM inventory_stock_balances WHERE inventory_item_id = rk AND site_id = s1;
  IF v_q <> 10 OR v_w <> 100 THEN RAISE EXCEPTION 'T29 FAIL: void 1 % @ % (want exactly 10 @ 100)', v_q, v_w; END IF;
  iq5 := save_supplier_tax_invoice_draft(NULL,
    jsonb_build_object('supplier_id', sa, 'invoice_no', 'STI-RK2', 'invoice_date', v_bkk, 'net_before_vat', 1080, 'vat', 75.6, 'match_note', 'ทดสอบ'),
    jsonb_build_array(jsonb_build_object('description', 'RK', 'qty', 12, 'unit', 'kg', 'unit_price', 90, 'inventory_item_id', rk, 'site_id', s1, 'base_qty', 12)), ARRAY[pq3]);
  PERFORM post_supplier_tax_invoice(iq5, (SELECT revision FROM supplier_tax_invoices WHERE id = iq5));
  SELECT quantity_on_hand, round(weighted_average_cost, 6) INTO v_q, v_w FROM inventory_stock_balances WHERE inventory_item_id = rk AND site_id = s1;
  IF v_q <> 12 OR v_w <> 90 THEN RAISE EXCEPTION 'T29 FAIL: post 2 % @ % (want 12 @ 90)', v_q, v_w; END IF;
  IF (SELECT count(*) FROM supplier_tax_invoice_reversals WHERE invoice_id = iq5) <> 1 THEN RAISE EXCEPTION 'T29 FAIL: reversal rows of the second post'; END IF;
  PERFORM void_supplier_tax_invoice(iq5, 'ทดสอบ');
  RAISE NOTICE 'T29 (post, void, re-link, post): PASSED';

  -- T30: void reverses BY the movement ids post stored (M3). A hand-made purchase_in that merely carries the invoice
  --   reference is never touched. HM: 10@100; invoice line 10@100 => post: 20@100 then reversal => 10@100.
  iq6 := save_supplier_tax_invoice_draft(NULL,
    jsonb_build_object('supplier_id', sa, 'invoice_no', 'STI-HM', 'invoice_date', v_bkk, 'net_before_vat', 1000, 'vat', 70),
    jsonb_build_array(jsonb_build_object('description', 'HM', 'qty', 10, 'unit', 'kg', 'unit_price', 100, 'inventory_item_id', hm, 'site_id', s1, 'base_qty', 10)), ARRAY[pq4]);
  PERFORM post_supplier_tax_invoice(iq6, (SELECT revision FROM supplier_tax_invoices WHERE id = iq6));
  IF (SELECT count(*) FROM supplier_tax_invoice_items WHERE invoice_id = iq6 AND posted_movement_id IS NOT NULL) <> 1 THEN
    RAISE EXCEPTION 'T30 FAIL: post did not store the line movement id';
  END IF;
  RESET role;
  INSERT INTO stock_movements (tenant_id, inventory_item_id, site_id, movement_type, quantity, unit_cost, reference_type, reference_id)
  VALUES (t_tenant, hm, s1, 'purchase_in', 3, 100, 'supplier_tax_invoice', iq6);
  SET LOCAL role = 'authenticated';
  PERFORM void_supplier_tax_invoice(iq6, 'ทดสอบ');
  IF (SELECT count(*) FROM stock_movements WHERE reference_id = iq6 AND reference_type = 'supplier_tax_invoice_void' AND movement_type = 'receipt_reversal') <> 1
     OR (SELECT quantity FROM stock_movements WHERE reference_id = iq6 AND reference_type = 'supplier_tax_invoice_void' AND movement_type = 'receipt_reversal') <> 10 THEN
    RAISE EXCEPTION 'T30 FAIL: void reversed something other than the stored line movement';
  END IF;
  IF (SELECT count(*) FROM stock_movements WHERE reference_id = iq6 AND reference_type = 'supplier_tax_invoice' AND movement_type = 'purchase_in' AND quantity = 3) <> 1 THEN
    RAISE EXCEPTION 'T30 FAIL: the hand-made movement was altered';
  END IF;
  SELECT quantity_on_hand, weighted_average_cost INTO v_q, v_w FROM inventory_stock_balances WHERE inventory_item_id = hm AND site_id = s1;
  IF v_q <> 10 OR v_w <> 100 THEN RAISE EXCEPTION 'T30 FAIL: HM balance % @ % (want 10 @ 100)', v_q, v_w; END IF;
  RAISE NOTICE 'T30 (void by stored movement ids): PASSED';

  -- T31: duplicate invoice number (case/space-insensitive) among non-void invoices of one supplier
  iq7 := save_supplier_tax_invoice_draft(NULL,
    jsonb_build_object('supplier_id', sa, 'invoice_no', ' INV-DUP ', 'invoice_date', v_bkk, 'net_before_vat', 0, 'vat', 0), '[]'::jsonb, '{}'::uuid[]);
  BEGIN
    PERFORM save_supplier_tax_invoice_draft(NULL,
      jsonb_build_object('supplier_id', sa, 'invoice_no', 'inv-dup', 'invoice_date', v_bkk, 'net_before_vat', 0, 'vat', 0), '[]'::jsonb, '{}'::uuid[]);
    RAISE EXCEPTION 'T31 FAIL: duplicate number accepted';
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE '%sti_invoice_no_active_uq%' THEN RAISE EXCEPTION 'T31 FAIL: got %', v_msg; END IF;
  END;
  PERFORM save_supplier_tax_invoice_draft(NULL,   -- another supplier may reuse the number
    jsonb_build_object('supplier_id', sb, 'invoice_no', 'INV-DUP', 'invoice_date', v_bkk, 'net_before_vat', 0, 'vat', 0), '[]'::jsonb, '{}'::uuid[]);
  PERFORM delete_supplier_tax_invoice_draft(iq7);
  RAISE NOTICE 'T31 (duplicate invoice number): PASSED';

  -- T32: PO with a confirmed credit note -> non-blocking po_has_credit_note
  RESET role;
  INSERT INTO supplier_credit_notes (tenant_id, supplier_id, site_id, doc_number, doc_date, po_id, category_id, amount_no_vat, vat, amount, status)
  VALUES (t_tenant, sa, s1, 'CN-STI-1', v_bkk, pq5, t_cat, 10, 0.7, 10.7, 'confirmed');
  SET LOCAL role = 'authenticated';
  iq8 := save_supplier_tax_invoice_draft(NULL,
    jsonb_build_object('supplier_id', sa, 'invoice_no', 'STI-CN', 'invoice_date', v_bkk, 'net_before_vat', 100, 'vat', 7),
    jsonb_build_array(jsonb_build_object('description', 'misc', 'qty', 1, 'unit_price', 100)), ARRAY[pq5]);
  v_j := preview_supplier_tax_invoice(iq8);
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j->'checks') e WHERE e->>'code' = 'po_has_credit_note' AND NOT (e->>'blocking')::boolean)
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_j->'checks') e WHERE (e->>'blocking')::boolean) THEN
    RAISE EXCEPTION 'T32 FAIL: credit note warning %', v_j->'checks';
  END IF;
  RAISE NOTICE 'T32 (po_has_credit_note): PASSED';

  -- T33: PO dated 70 days ago -> po_outside_month (warning); the invoice's supplier changed behind our back -> po_wrong_supplier blocks
  iq9 := save_supplier_tax_invoice_draft(NULL,
    jsonb_build_object('supplier_id', sa, 'invoice_no', 'STI-OM', 'invoice_date', v_bkk, 'net_before_vat', 100, 'vat', 7),
    jsonb_build_array(jsonb_build_object('description', 'misc', 'qty', 1, 'unit_price', 100)), ARRAY[pq6]);
  v_j := preview_supplier_tax_invoice(iq9);
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j->'checks') e WHERE e->>'code' = 'po_outside_month' AND NOT (e->>'blocking')::boolean) THEN
    RAISE EXCEPTION 'T33 FAIL: outside-month warning %', v_j->'checks';
  END IF;
  RESET role;
  UPDATE supplier_tax_invoices SET supplier_id = sb WHERE id = iq9;
  SET LOCAL role = 'authenticated';
  v_j := preview_supplier_tax_invoice(iq9);
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j->'checks') e WHERE e->>'code' = 'po_wrong_supplier' AND (e->>'blocking')::boolean) THEN
    RAISE EXCEPTION 'T33 FAIL: wrong-supplier check %', v_j->'checks';
  END IF;
  BEGIN
    PERFORM post_supplier_tax_invoice(iq9, (SELECT revision FROM supplier_tax_invoices WHERE id = iq9));
    RAISE EXCEPTION 'T33 FAIL: posted with a wrong-supplier PO';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'po_wrong_supplier%' THEN RAISE EXCEPTION 'T33 FAIL: got %', v_msg; END IF;
  END;
  RAISE NOTICE 'T33 (po_outside_month, po_wrong_supplier): PASSED';

  -- T34: stock_line_invalid (a line's site belongs to another tenant) blocks, and the brand-new-row insert of M1 rolls back
  iq10 := save_supplier_tax_invoice_draft(NULL,
    jsonb_build_object('supplier_id', sa, 'invoice_no', 'STI-SL', 'invoice_date', v_bkk, 'net_before_vat', 100, 'vat', 7),
    jsonb_build_array(jsonb_build_object('description', 'SL', 'qty', 1, 'unit', 'kg', 'unit_price', 100, 'inventory_item_id', sl, 'site_id', s1, 'base_qty', 1)), ARRAY[pq7]);
  RESET role;
  UPDATE supplier_tax_invoice_items SET site_id = t2_site WHERE invoice_id = iq10;
  SET LOCAL role = 'authenticated';
  v_j := preview_supplier_tax_invoice(iq10);
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j->'checks') e WHERE e->>'code' = 'stock_line_invalid' AND (e->>'blocking')::boolean) THEN
    RAISE EXCEPTION 'T34 FAIL: stock_line_invalid not reported %', v_j->'checks';
  END IF;
  BEGIN
    PERFORM post_supplier_tax_invoice(iq10, (SELECT revision FROM supplier_tax_invoices WHERE id = iq10));
    RAISE EXCEPTION 'T34 FAIL: posted with an invalid stock line';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'stock_line_invalid%' THEN RAISE EXCEPTION 'T34 FAIL: got %', v_msg; END IF;
  END;
  IF EXISTS (SELECT 1 FROM inventory_stock_balances WHERE inventory_item_id = sl) THEN RAISE EXCEPTION 'T34 FAIL: failed post left a balance row'; END IF;
  RAISE NOTICE 'T34 (stock_line_invalid): PASSED';

  RESET role;
  RAISE EXCEPTION 'RESULT: supplier_tax_invoice_test ALL PASSED';
END $$;

ROLLBACK;
