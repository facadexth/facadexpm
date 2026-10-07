-- ================================================================
-- Tests for 2026-10-09-03-tax-invoice-multi-bill.sql. Part C of 3.
-- Dry-run only: BEGIN; SET LOCAL lock_timeout='5s'; 2026-10-09-01; -02; -03; this body (BEGIN;/ROLLBACK; stripped); ROLLBACK;
-- Success = an ERROR containing 'RESULT: tax_invoice_multi_bill_test ALL PASSED'.
-- ================================================================
BEGIN;
DO $$
DECLARE
  t_owner UUID; t_tenant UUID; t_site UUID; t_sup UUID; t_cat UUID; t_item UUID;
  email TEXT := '__test_timb_owner__@example.com';
  poM UUID; m1 UUID; m2 UUID; poP UUID; p1 UUID; p2 UUID; inv UUID; j JSONB; v_rev INT; bill1 UUID; bill2 UUID; rem UUID;
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

  -- poM received in two receipts -> two bills, two purchase_in movements
  j := receive_po_lines(poM, ARRAY[m1], v_bkk - 1, '[]'::jsonb, 600, 42, jsonb_build_array(jsonb_build_object('po_item_id', m1, 'base_qty', 2, 'unit_cost', 300)));
  bill1 := (j->>'expense_id')::uuid;
  j := receive_po_lines(poM, ARRAY[m2], v_bkk, '[]'::jsonb, 400, 28, jsonb_build_array(jsonb_build_object('po_item_id', m2, 'base_qty', 4, 'unit_cost', 100)));
  bill2 := (j->>'expense_id')::uuid;
  -- C1: receipts add up to _po_goods_subtotal (helper is not executable by clients: check as superuser)
  RESET role;
  IF (SELECT sum(goods_subtotal) FROM po_receipts WHERE po_id = poM) <> _po_goods_subtotal(poM, t_tenant) THEN RAISE EXCEPTION 'C1 FAIL: receipts vs _po_goods_subtotal'; END IF;
  SET LOCAL role = 'authenticated';
  -- poP stays partially received
  PERFORM receive_po_lines(poP, ARRAY[p1], v_bkk, '[]'::jsonb, 10, 0.70, '[]'::jsonb);

  -- C2 (R7): a partially received PO cannot be linked
  BEGIN
    PERFORM save_supplier_tax_invoice_draft(NULL, jsonb_build_object('supplier_id', t_sup, 'invoice_no', 'TIMB-X', 'invoice_date', v_bkk, 'net_before_vat', 10, 'vat', 0.7), '[]'::jsonb, ARRAY[poP]);
    RAISE EXCEPTION 'C2 FAIL: partially received PO linked';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'po_not_eligible%' THEN RAISE EXCEPTION 'C2 FAIL: %', v_msg; END IF; END;

  -- C3: post reverses BOTH receipt movements and stamps BOTH bills
  inv := save_supplier_tax_invoice_draft(NULL,
    jsonb_build_object('supplier_id', t_sup, 'invoice_no', 'TIMB-1', 'invoice_date', v_bkk, 'net_before_vat', 1000, 'vat', 70),
    jsonb_build_array(jsonb_build_object('description', 'all', 'qty', 1, 'unit_price', 1000)), ARRAY[poM]);
  v_rev := ((preview_supplier_tax_invoice(inv))->>'revision')::int;
  j := post_supplier_tax_invoice(inv, v_rev);
  IF (j->>'receipts_reversed')::int <> 2 OR (j->>'expenses_stamped')::int <> 2 THEN RAISE EXCEPTION 'C3 FAIL: %', j; END IF;
  IF (SELECT invoice_no FROM expenses WHERE id = bill1) <> 'TIMB-1' OR (SELECT invoice_no FROM expenses WHERE id = bill2) <> 'TIMB-1' THEN RAISE EXCEPTION 'C3 FAIL: not stamped'; END IF;
  SELECT count(*) INTO v_cnt FROM supplier_tax_invoice_expense_stamps WHERE invoice_id = inv AND expense_id = bill2;
  IF v_cnt <> 1 THEN RAISE EXCEPTION 'C3 FAIL: stamp row'; END IF;

  -- C4: split bill2 after the post (the remainder copies the stamped number), then void restores all three
  j := split_payment(bill2, 100, v_bkk, 'transfer');
  rem := (j->>'remaining_expense_id')::uuid;
  IF (SELECT invoice_no FROM expenses WHERE id = rem) <> 'TIMB-1' THEN RAISE EXCEPTION 'C4 FAIL: split did not copy the number'; END IF;
  j := void_supplier_tax_invoice(inv, 'test');
  IF (SELECT invoice_no FROM expenses WHERE id = bill1) IS NOT NULL OR (SELECT invoice_no FROM expenses WHERE id = bill2) IS NOT NULL
     OR (SELECT invoice_no FROM expenses WHERE id = rem) IS NOT NULL THEN RAISE EXCEPTION 'C4 FAIL: not restored'; END IF;
  IF jsonb_array_length(j->'warnings') <> 0 THEN RAISE EXCEPTION 'C4 FAIL: warnings %', j; END IF;

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
