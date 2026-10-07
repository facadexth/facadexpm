-- ================================================================
-- Tests for 2026-10-09-03-tax-invoice-multi-bill.sql. Part C of 3.
-- Dry-run only: BEGIN; SET LOCAL lock_timeout='5s'; 2026-10-09-01; -02; -03; this body (BEGIN;/ROLLBACK; stripped); ROLLBACK;
-- Success = an ERROR containing 'RESULT: tax_invoice_multi_bill_test ALL PASSED'.
-- Split tree of PO-TIMB-M used below (bill1 = purchase_orders.expense_id = the supplier_tax_invoice_pos branch):
--   bill1 'DN-1' --(after post)--> r1 --(after post)--> r2 --(after post)--> r3 (edited by hand before void)
--   bill2 'DN-2' --(BEFORE post)--> c2 --(after post)--> g2
-- Within one transaction now() is constant, so posted_at = every split's created_at; the posted_at filter of
-- _sti_unstamp_other_bills (pre-post splits detached from the PO) cannot be exercised here.
-- ================================================================
BEGIN;
DO $$
DECLARE
  t_owner UUID; t_tenant UUID; t_site UUID; t_sup UUID; t_cat UUID; t_item UUID;
  email TEXT := '__test_timb_owner__@example.com';
  poM UUID; m1 UUID; m2 UUID; poP UUID; p1 UUID; p2 UUID; inv UUID; j JSONB; v_rev INT; bill1 UUID; bill2 UUID;
  c2 UUID; r1 UUID; r2 UUID; r3 UUID; g2 UUID; x_exp UUID; x_notes TEXT; dep_exp UUID; dep_no TEXT; dep_notes TEXT;
  v_bkk DATE := (now() AT TIME ZONE 'Asia/Bangkok')::date; v_msg TEXT; r RECORD; v_cnt INT;
BEGIN
  SELECT id INTO t_owner FROM auth.users ORDER BY created_at ASC LIMIT 1;
  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at) VALUES ('__TEST timb__', t_owner, 'trial', now() + interval '14 days') RETURNING id INTO t_tenant;
  INSERT INTO user_roles (user_email, role, status, tenant_id) VALUES (email, 'OWNER', 'approved', t_tenant);
  INSERT INTO sites (tenant_id, site_number, name) VALUES (t_tenant, '__TIMB-1__', '__timb site__') RETURNING id INTO t_site;
  INSERT INTO suppliers (tenant_id, name) VALUES (t_tenant, '__timb sup__') RETURNING id INTO t_sup;
  INSERT INTO expense_categories (tenant_id, name) VALUES (t_tenant, '__timb cat__') RETURNING id INTO t_cat;
  INSERT INTO inventory_items (tenant_id, name, base_unit) VALUES (t_tenant, '__timb item__', 'kg') RETURNING id INTO t_item;
  SET LOCAL role = 'authenticated';
  PERFORM set_config('request.jwt.claims', '{"email":"' || email || '"}', true);

  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status) VALUES (t_tenant, 'PO-TIMB-M', t_site, t_sup, t_cat, v_bkk, 'ordered') RETURNING id INTO poM;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total, inventory_item_id, sort_order) VALUES (t_tenant, poM, 'M1', 2, 300, 600, t_item, 0) RETURNING id INTO m1;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total, inventory_item_id, sort_order) VALUES (t_tenant, poM, 'M2', 4, 100, 400, t_item, 1) RETURNING id INTO m2;
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status) VALUES (t_tenant, 'PO-TIMB-P', t_site, t_sup, t_cat, v_bkk, 'ordered') RETURNING id INTO poP;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total) VALUES (t_tenant, poP, 'P1', 1, 10, 10) RETURNING id INTO p1;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total) VALUES (t_tenant, poP, 'P2', 1, 10, 10) RETURNING id INTO p2;

  -- poM's own deposit (10 % of 1,070 = 107.00, not deducted on any receipt): its expense has no po_id and must stay untouched
  j := create_po_deposit(poM, 'percent', 10, 'DEP-TIMB', v_bkk, 'transfer', 'paid');
  dep_exp := (j->>'expense_id')::uuid;
  SELECT invoice_no, notes INTO dep_no, dep_notes FROM expenses WHERE id = dep_exp;
  IF dep_no IS DISTINCT FROM 'DEP-TIMB' THEN RAISE EXCEPTION 'SETUP FAIL: deposit number %', dep_no; END IF;
  -- an unrelated bill of the same supplier that happens to carry the tax-invoice number, not linked to any PO
  INSERT INTO expenses (date, description, site_id, category_id, supplier_id, amount_no_vat, vat, amount, payment_method, status, invoice_no)
  VALUES (v_bkk, '__timb other__', t_site, t_cat, t_sup, 100, 7, 107, 'transfer', 'pending', 'TIMB-1') RETURNING id INTO x_exp;
  SELECT notes INTO x_notes FROM expenses WHERE id = x_exp;

  -- poM received in two receipts -> two bills, two purchase_in movements
  j := receive_po_lines(poM, ARRAY[m1], v_bkk - 1, '[]'::jsonb, 600, 42, jsonb_build_array(jsonb_build_object('po_item_id', m1, 'base_qty', 2, 'unit_cost', 300)));
  bill1 := (j->>'expense_id')::uuid;
  j := receive_po_lines(poM, ARRAY[m2], v_bkk, '[]'::jsonb, 400, 28, jsonb_build_array(jsonb_build_object('po_item_id', m2, 'base_qty', 4, 'unit_cost', 100)));
  bill2 := (j->>'expense_id')::uuid;
  IF (SELECT expense_id FROM purchase_orders WHERE id = poM) IS DISTINCT FROM bill1 THEN RAISE EXCEPTION 'SETUP FAIL: primary bill'; END IF;
  -- C1: receipts add up to _po_goods_subtotal (helper is not executable by clients: check as superuser)
  RESET role;
  IF (SELECT sum(goods_subtotal) FROM po_receipts WHERE po_id = poM) <> _po_goods_subtotal(poM, t_tenant) THEN RAISE EXCEPTION 'C1 FAIL: receipts vs _po_goods_subtotal'; END IF;
  -- distinct supplier document numbers on the two bills, so a wrong restore value is visible
  UPDATE expenses SET invoice_no = 'DN-1' WHERE id = bill1;
  UPDATE expenses SET invoice_no = 'DN-2' WHERE id = bill2;
  SET LOCAL role = 'authenticated';
  -- bill2 split BEFORE the post: the child c2 carries po_id and 'DN-2'
  j := split_payment(bill2, 100, v_bkk, 'transfer');
  c2 := (j->>'remaining_expense_id')::uuid;
  IF (SELECT invoice_no FROM expenses WHERE id = c2) IS DISTINCT FROM 'DN-2' OR (SELECT po_id FROM expenses WHERE id = c2) IS DISTINCT FROM poM THEN
    RAISE EXCEPTION 'SETUP FAIL: pre-post split';
  END IF;
  -- poP stays partially received
  PERFORM receive_po_lines(poP, ARRAY[p1], v_bkk, '[]'::jsonb, 10, 0.70, '[]'::jsonb);

  -- C2 (R7): a partially received PO cannot be linked
  BEGIN
    PERFORM save_supplier_tax_invoice_draft(NULL, jsonb_build_object('supplier_id', t_sup, 'invoice_no', 'TIMB-X', 'invoice_date', v_bkk, 'net_before_vat', 10, 'vat', 0.7), '[]'::jsonb, ARRAY[poP]);
    RAISE EXCEPTION 'C2 FAIL: partially received PO linked';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'po_not_eligible%' THEN RAISE EXCEPTION 'C2 FAIL: %', v_msg; END IF; END;

  -- C3: post reverses BOTH receipt movements and stamps EVERY bill (bill1 via step (c); bill2 and c2 via the helper)
  inv := save_supplier_tax_invoice_draft(NULL,
    jsonb_build_object('supplier_id', t_sup, 'invoice_no', 'TIMB-1', 'invoice_date', v_bkk, 'net_before_vat', 1000, 'vat', 70),
    jsonb_build_array(jsonb_build_object('description', 'all', 'qty', 1, 'unit_price', 1000)), ARRAY[poM]);
  v_rev := ((preview_supplier_tax_invoice(inv))->>'revision')::int;
  j := post_supplier_tax_invoice(inv, v_rev);
  IF (j->>'receipts_reversed')::int <> 2 OR (j->>'expenses_stamped')::int <> 3 THEN RAISE EXCEPTION 'C3 FAIL: %', j; END IF;
  IF (SELECT invoice_no FROM expenses WHERE id = bill1) IS DISTINCT FROM 'TIMB-1' OR (SELECT invoice_no FROM expenses WHERE id = bill2) IS DISTINCT FROM 'TIMB-1'
     OR (SELECT invoice_no FROM expenses WHERE id = c2) IS DISTINCT FROM 'TIMB-1' THEN RAISE EXCEPTION 'C3 FAIL: not stamped'; END IF;
  IF (SELECT prev_invoice_no FROM supplier_tax_invoice_pos WHERE invoice_id = inv AND po_id = poM) IS DISTINCT FROM 'DN-1' THEN RAISE EXCEPTION 'C3 FAIL: link prev'; END IF;
  SELECT count(*) INTO v_cnt FROM supplier_tax_invoice_expense_stamps WHERE invoice_id = inv;
  IF v_cnt <> 2
     OR (SELECT prev_invoice_no FROM supplier_tax_invoice_expense_stamps WHERE invoice_id = inv AND expense_id = bill2) IS DISTINCT FROM 'DN-2'
     OR (SELECT prev_invoice_no FROM supplier_tax_invoice_expense_stamps WHERE invoice_id = inv AND expense_id = c2) IS DISTINCT FROM 'DN-2'
     OR EXISTS (SELECT 1 FROM supplier_tax_invoice_expense_stamps WHERE invoice_id = inv AND expense_id = bill1) THEN
    RAISE EXCEPTION 'C3 FAIL: stamp rows';
  END IF;
  -- unrelated bill and the PO's deposit untouched by the post
  IF (SELECT invoice_no FROM expenses WHERE id = x_exp) IS DISTINCT FROM 'TIMB-1' OR (SELECT notes FROM expenses WHERE id = x_exp) IS DISTINCT FROM x_notes
     OR (SELECT invoice_no FROM expenses WHERE id = dep_exp) IS DISTINCT FROM dep_no OR (SELECT notes FROM expenses WHERE id = dep_exp) IS DISTINCT FROM dep_notes THEN
    RAISE EXCEPTION 'C3 FAIL: unrelated or deposit expense touched';
  END IF;

  -- C4: splits AFTER the post (each remainder copies the stamped number): bill1 -> r1 -> r2 -> r3 (nested), c2 -> g2
  j := split_payment(bill1, 100, v_bkk, 'transfer'); r1 := (j->>'remaining_expense_id')::uuid;
  j := split_payment(r1, 100, v_bkk, 'transfer');    r2 := (j->>'remaining_expense_id')::uuid;
  j := split_payment(r2, 100, v_bkk, 'transfer');    r3 := (j->>'remaining_expense_id')::uuid;
  j := split_payment(c2, 100, v_bkk, 'transfer');    g2 := (j->>'remaining_expense_id')::uuid;
  IF (SELECT count(*) FROM expenses WHERE id IN (r1, r2, r3, g2) AND invoice_no = 'TIMB-1') <> 4 THEN RAISE EXCEPTION 'C4 FAIL: split did not copy the number'; END IF;
  -- r3's number is edited by hand before the void: it must be left alone and reported
  RESET role;
  UPDATE expenses SET invoice_no = 'HAND' WHERE id = r3;
  SET LOCAL role = 'authenticated';
  j := void_supplier_tax_invoice(inv, 'test');
  IF (SELECT invoice_no FROM expenses WHERE id = bill1) IS DISTINCT FROM 'DN-1'
     OR (SELECT invoice_no FROM expenses WHERE id = r1) IS DISTINCT FROM 'DN-1'
     OR (SELECT invoice_no FROM expenses WHERE id = r2) IS DISTINCT FROM 'DN-1'
     OR (SELECT invoice_no FROM expenses WHERE id = bill2) IS DISTINCT FROM 'DN-2'
     OR (SELECT invoice_no FROM expenses WHERE id = c2) IS DISTINCT FROM 'DN-2'
     OR (SELECT invoice_no FROM expenses WHERE id = g2) IS DISTINCT FROM 'DN-2' THEN
    RAISE EXCEPTION 'C4 FAIL: not restored to the exact original numbers';
  END IF;
  IF (SELECT invoice_no FROM expenses WHERE id = r3) IS DISTINCT FROM 'HAND' THEN RAISE EXCEPTION 'C4 FAIL: hand-edited number overwritten'; END IF;
  IF jsonb_array_length(j->'warnings') <> 1
     OR j->'warnings'->0->>'code' IS DISTINCT FROM 'expense_changed'
     OR (j->'warnings'->0->>'expense_id')::uuid IS DISTINCT FROM r3
     OR (j->'warnings'->0->>'po_id')::uuid IS DISTINCT FROM poM THEN
    RAISE EXCEPTION 'C4 FAIL: warnings %', j;
  END IF;
  -- unrelated bill and the PO's deposit untouched by the void
  IF (SELECT invoice_no FROM expenses WHERE id = x_exp) IS DISTINCT FROM 'TIMB-1' OR (SELECT notes FROM expenses WHERE id = x_exp) IS DISTINCT FROM x_notes
     OR (SELECT invoice_no FROM expenses WHERE id = dep_exp) IS DISTINCT FROM dep_no OR (SELECT notes FROM expenses WHERE id = dep_exp) IS DISTINCT FROM dep_notes THEN
    RAISE EXCEPTION 'C4 FAIL: unrelated or deposit expense touched';
  END IF;

  -- C5: ACL
  RESET role;
  IF has_function_privilege('authenticated', '_sti_stamp_other_bills(uuid,uuid,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', '_sti_unstamp_other_bills(uuid,uuid,text)', 'EXECUTE')
     OR has_table_privilege('authenticated', 'supplier_tax_invoice_expense_stamps', 'INSERT')
     OR NOT has_table_privilege('authenticated', 'supplier_tax_invoice_expense_stamps', 'SELECT')
     OR NOT has_function_privilege('authenticated', 'post_supplier_tax_invoice(uuid,integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'post_supplier_tax_invoice(uuid,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'C5 FAIL: grants';
  END IF;

  RAISE EXCEPTION 'RESULT: tax_invoice_multi_bill_test ALL PASSED';
END $$;
ROLLBACK;
