-- ================================================================
-- Tests for 2026-10-09-01-po-receipts.sql (schema + locks). Part A of 3.
-- Dry-run only: BEGIN; SET LOCAL lock_timeout='5s'; migration 2026-10-09-01; this body (its BEGIN;/ROLLBACK; stripped); ROLLBACK;
-- Success = an ERROR whose text contains 'RESULT: po_receipt_test_a ALL PASSED' (the RAISE rolls everything back).
-- Any other error text = failure. Requires 2026-10-07-01..02 and 2026-10-08-01..02 (live).
-- ================================================================
BEGIN;
DO $$
DECLARE
  t_owner UUID; t_tenant UUID; t_site UUID; t_sup UUID; t_sup2 UUID; t_cat UUID;
  email TEXT := '__test_pra_owner__@example.com';
  t2_tenant UUID; t2_site UUID; t2_sup UUID; t2_cat UUID; t2_po UUID;
  po_r UUID; po_r_item UUID; po_d UUID; po_l UUID; po_x UUID;
  e_dep UUID; d_dep UUID; e_dep2 UUID; e_bill UUID; e_split UUID; r1 UUID; v_msg TEXT; v_status TEXT; v_cnt INT;
BEGIN
  -- fixtures as superuser
  SELECT id INTO t_owner FROM auth.users ORDER BY created_at ASC LIMIT 1;
  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at) VALUES ('__TEST pra__', t_owner, 'trial', now() + interval '14 days') RETURNING id INTO t_tenant;
  INSERT INTO user_roles (user_email, role, status, tenant_id) VALUES (email, 'OWNER', 'approved', t_tenant);
  INSERT INTO sites (tenant_id, site_number, name) VALUES (t_tenant, '__PRA-1__', '__pra site__') RETURNING id INTO t_site;
  INSERT INTO suppliers (tenant_id, name) VALUES (t_tenant, '__pra sup__') RETURNING id INTO t_sup;
  INSERT INTO suppliers (tenant_id, name) VALUES (t_tenant, '__pra sup2__') RETURNING id INTO t_sup2;
  INSERT INTO expense_categories (tenant_id, name) VALUES (t_tenant, '__pra cat__') RETURNING id INTO t_cat;
  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at) VALUES ('__TEST pra2__', t_owner, 'trial', now() + interval '14 days') RETURNING id INTO t2_tenant;
  INSERT INTO sites (tenant_id, site_number, name) VALUES (t2_tenant, '__PRA-2__', '__pra site2__') RETURNING id INTO t2_site;
  INSERT INTO suppliers (tenant_id, name) VALUES (t2_tenant, '__pra t2 sup__') RETURNING id INTO t2_sup;
  INSERT INTO expense_categories (tenant_id, name) VALUES (t2_tenant, '__pra t2 cat__') RETURNING id INTO t2_cat;
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status) VALUES (t2_tenant, 'PO-PRA-T2', t2_site, t2_sup, t2_cat, current_date, 'ordered') RETURNING id INTO t2_po;

  -- po_r: has a receipt (made by superuser, as the RPC will)
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status) VALUES (t_tenant, 'PO-PRA-R', t_site, t_sup, t_cat, current_date, 'ordered') RETURNING id INTO po_r;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total) VALUES (t_tenant, po_r, 'a', 1, 100, 100) RETURNING id INTO po_r_item;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total) VALUES (t_tenant, po_r, 'b', 1, 50, 50);
  INSERT INTO expenses (tenant_id, date, description, site_id, category_id, supplier_id, amount_no_vat, vat, amount, payment_method, status, po_id)
  VALUES (t_tenant, current_date, 'bill', t_site, t_cat, t_sup, 100, 7, 107, 'transfer', 'pending', po_r) RETURNING id INTO e_bill;
  INSERT INTO po_receipts (tenant_id, po_id, seq, received_date, goods_subtotal, goods_vat, expense_id) VALUES (t_tenant, po_r, 1, current_date, 100, 7, e_bill) RETURNING id INTO r1;
  INSERT INTO po_receipt_items (tenant_id, receipt_id, po_item_id, quantity, line_total) VALUES (t_tenant, r1, po_r_item, 1, 100);
  PERFORM set_config('app.po_receipt_rpc', 'on', true);
  UPDATE purchase_orders SET status = 'partially_received', received_date = current_date, expense_id = e_bill WHERE id = po_r;
  PERFORM set_config('app.po_receipt_rpc', 'off', true);
  INSERT INTO expenses (tenant_id, date, description, site_id, category_id, supplier_id, amount, payment_method, status, po_id)
  VALUES (t_tenant, current_date, 'split part', t_site, t_cat, t_sup, 10, 'transfer', 'pending', po_r) RETURNING id INTO e_split;
  INSERT INTO expense_splits (tenant_id, source_expense_id, new_expense_id, paid_amount, paid_date, payment_method) VALUES (t_tenant, e_bill, e_split, 5, current_date, 'transfer');

  -- A1: status CHECK (flag on, so the lock trigger lets the row reach the CHECK; the failed block also reverts the flag)
  BEGIN
    PERFORM set_config('app.po_receipt_rpc', 'on', true);
    UPDATE purchase_orders SET status = 'bogus' WHERE id = po_r;
    RAISE EXCEPTION 'A1 FAIL: bogus status accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  IF COALESCE(current_setting('app.po_receipt_rpc', true), '') = 'on' THEN RAISE EXCEPTION 'A1 FAIL: flag leaked out of the failed block'; END IF;
  SELECT status INTO v_status FROM purchase_orders WHERE id = po_r;
  IF v_status <> 'partially_received' THEN RAISE EXCEPTION 'A1 FAIL: status %', v_status; END IF;

  SET LOCAL role = 'authenticated';
  PERFORM set_config('request.jwt.claims', '{"email":"' || email || '"}', true);

  -- POs as the tenant admin
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status) VALUES (t_tenant, 'PO-PRA-D', t_site, t_sup, t_cat, current_date, 'ordered') RETURNING id INTO po_d;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total) VALUES (t_tenant, po_d, 'd', 1, 1000, 1000);
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status) VALUES (t_tenant, 'PO-PRA-L', t_site, t_sup, t_cat, current_date, 'ordered') RETURNING id INTO po_l;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total) VALUES (t_tenant, po_l, 'l', 1, 100, 100);
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status) VALUES (t_tenant, 'PO-PRA-X', t_site, t_sup2, t_cat, current_date, 'ordered') RETURNING id INTO po_x;

  -- A2: clients read but never write the new tables; other tenant invisible
  BEGIN INSERT INTO po_receipts (po_id, seq, received_date, goods_subtotal) VALUES (po_d, 1, current_date, 1); RAISE EXCEPTION 'A2 FAIL: client wrote po_receipts';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN INSERT INTO po_receipt_items (receipt_id, po_item_id, quantity, line_total) VALUES (r1, po_r_item, 1, 1); RAISE EXCEPTION 'A2 FAIL: client wrote po_receipt_items';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN INSERT INTO expense_splits (source_expense_id, new_expense_id, paid_amount, paid_date, payment_method) VALUES (e_bill, e_bill, 1, current_date, 'cash'); RAISE EXCEPTION 'A2 FAIL: client wrote expense_splits';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN UPDATE po_receipts SET notes = 'x' WHERE id = r1; RAISE EXCEPTION 'A2 FAIL: client updated po_receipts';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  SELECT count(*) INTO v_cnt FROM po_receipts WHERE id = r1;
  IF v_cnt <> 1 THEN RAISE EXCEPTION 'A2 FAIL: owner cannot read own receipt'; END IF;
  SELECT count(*) INTO v_cnt FROM expense_splits WHERE new_expense_id = e_split;
  IF v_cnt <> 1 THEN RAISE EXCEPTION 'A2 FAIL: owner cannot read own split'; END IF;

  -- A4: items of a PO with receipts are frozen
  BEGIN UPDATE purchase_order_items SET quantity = 2 WHERE id = po_r_item; RAISE EXCEPTION 'A4 FAIL: item edit';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'po_has_receipts%' THEN RAISE EXCEPTION 'A4 FAIL: %', v_msg; END IF; END;
  BEGIN INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total) VALUES (t_tenant, po_r, 'c', 1, 1, 1); RAISE EXCEPTION 'A4 FAIL: item insert';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'po_has_receipts%' THEN RAISE EXCEPTION 'A4 FAIL: %', v_msg; END IF; END;
  BEGIN DELETE FROM purchase_order_items WHERE po_id = po_r; RAISE EXCEPTION 'A4 FAIL: item delete';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'po_has_receipts%' THEN RAISE EXCEPTION 'A4 FAIL: %', v_msg; END IF; END;

  -- A5: PO with receipts: status/money fields refused, notes allowed
  BEGIN UPDATE purchase_orders SET status = 'ordered' WHERE id = po_r; RAISE EXCEPTION 'A5 FAIL: un-receive';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'po_has_receipts%' THEN RAISE EXCEPTION 'A5 FAIL: %', v_msg; END IF; END;
  BEGIN UPDATE purchase_orders SET status = 'received' WHERE id = po_r; RAISE EXCEPTION 'A5 FAIL: client finished receive';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'po_has_receipts%' THEN RAISE EXCEPTION 'A5 FAIL: %', v_msg; END IF; END;
  BEGIN UPDATE purchase_orders SET has_vat = NOT has_vat WHERE id = po_r; RAISE EXCEPTION 'A5 FAIL: has_vat';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'po_has_receipts%' THEN RAISE EXCEPTION 'A5 FAIL: %', v_msg; END IF; END;
  BEGIN UPDATE purchase_orders SET expense_id = NULL WHERE id = po_r; RAISE EXCEPTION 'A5 FAIL: expense_id';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'po_has_receipts%' THEN RAISE EXCEPTION 'A5 FAIL: %', v_msg; END IF; END;
  BEGIN UPDATE purchase_orders SET received_date = current_date - 1 WHERE id = po_r; RAISE EXCEPTION 'A5 FAIL: received_date';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'po_has_receipts%' THEN RAISE EXCEPTION 'A5 FAIL: %', v_msg; END IF; END;
  UPDATE purchase_orders SET notes = 'ok' WHERE id = po_r;

  -- A7: a client can never set partially_received itself
  BEGIN UPDATE purchase_orders SET status = 'partially_received' WHERE id = po_l; RAISE EXCEPTION 'A7 FAIL';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'po_status_rpc_only%' THEN RAISE EXCEPTION 'A7 FAIL: %', v_msg; END IF; END;

  -- A8: deposit linked to a PO (as the RPC will do; clients may also insert supplier_deposits under RLS)
  INSERT INTO expenses (date, description, site_id, category_id, supplier_id, amount_no_vat, vat, amount, payment_method, status)
  VALUES (current_date, 'dep', t_site, t_cat, t_sup, 300, 21, 321, 'transfer', 'paid') RETURNING id INTO e_dep;
  -- A13: clients cannot set the PO link (column privileges); a plain register insert still works
  BEGIN INSERT INTO supplier_deposits (expense_id, deposit_invoice_no, po_id) VALUES (e_dep, 'PRA-D0', po_d); RAISE EXCEPTION 'A13 FAIL: client set po_id on insert';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  INSERT INTO supplier_deposits (expense_id, deposit_invoice_no, created_by) VALUES (e_dep, 'PRA-D1', email) RETURNING id INTO d_dep;
  BEGIN UPDATE supplier_deposits SET po_id = po_d WHERE id = d_dep; RAISE EXCEPTION 'A13 FAIL: client set po_id on update';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN UPDATE supplier_deposits SET pct_of_po = 30 WHERE id = d_dep; RAISE EXCEPTION 'A13 FAIL: client set pct_of_po on update';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  -- the link itself is made as the definer RPC would (superuser)
  RESET role;
  UPDATE supplier_deposits SET po_id = po_d, pct_of_po = 30 WHERE id = d_dep;
  SET LOCAL role = 'authenticated';
  -- A14: the linked deposit's expense is frozen for money/supplier
  BEGIN UPDATE expenses SET supplier_id = t_sup2 WHERE id = e_dep; RAISE EXCEPTION 'A14 FAIL: supplier changed';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'deposit_in_use%' THEN RAISE EXCEPTION 'A14 FAIL: %', v_msg; END IF; END;
  BEGIN UPDATE expenses SET amount = 1, amount_no_vat = 1, vat = 0 WHERE id = e_dep; RAISE EXCEPTION 'A14 FAIL: amount changed';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'deposit_in_use%' THEN RAISE EXCEPTION 'A14 FAIL: %', v_msg; END IF; END;
  INSERT INTO expenses (date, description, site_id, category_id, supplier_id, amount_no_vat, vat, amount, payment_method, status)
  VALUES (current_date, 'dep2', t_site, t_cat, t_sup, 10, 0.7, 10.7, 'transfer', 'paid') RETURNING id INTO e_dep2;
  RESET role;
  BEGIN INSERT INTO supplier_deposits (tenant_id, expense_id, deposit_invoice_no, po_id) VALUES (t_tenant, e_dep2, 'PRA-D2', po_d); RAISE EXCEPTION 'A8 FAIL: two deposits on one PO';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN INSERT INTO supplier_deposits (tenant_id, expense_id, deposit_invoice_no, po_id) VALUES (t_tenant, e_dep2, 'PRA-D2', po_x); RAISE EXCEPTION 'A8 FAIL: PO of another supplier';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'deposit_wrong_supplier%' THEN RAISE EXCEPTION 'A8 FAIL: %', v_msg; END IF; END;
  BEGIN INSERT INTO supplier_deposits (tenant_id, expense_id, deposit_invoice_no, po_id) VALUES (t_tenant, e_dep2, 'PRA-D2', t2_po); RAISE EXCEPTION 'A8 FAIL: PO of another tenant';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'cross_tenant_reference%' THEN RAISE EXCEPTION 'A8 FAIL: %', v_msg; END IF; END;
  BEGIN INSERT INTO supplier_deposits (tenant_id, expense_id, deposit_invoice_no, po_id, pct_of_po) VALUES (t_tenant, e_dep2, 'PRA-D2', po_l, 120); RAISE EXCEPTION 'A8 FAIL: pct 120';
  EXCEPTION WHEN check_violation THEN NULL; END;
  SET LOCAL role = 'authenticated';

  -- A6: PO with its own deposit: items, cancel and money fields refused; legacy ordered->received (old RPC) still allowed
  BEGIN INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total) VALUES (t_tenant, po_d, 'e', 1, 1, 1); RAISE EXCEPTION 'A6 FAIL: item insert';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'po_has_deposit%' THEN RAISE EXCEPTION 'A6 FAIL: %', v_msg; END IF; END;
  BEGIN UPDATE purchase_orders SET status = 'cancelled' WHERE id = po_d; RAISE EXCEPTION 'A6 FAIL: cancel';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'po_has_deposit%' THEN RAISE EXCEPTION 'A6 FAIL: %', v_msg; END IF; END;
  PERFORM receive_po_with_deposits(po_d, '[]'::jsonb, 1000, 70);
  SELECT status INTO v_status FROM purchase_orders WHERE id = po_d;
  IF v_status <> 'received' THEN RAISE EXCEPTION 'A6 FAIL: legacy receive blocked (%)', v_status; END IF;

  -- A9: an applied deposit keeps its PO link
  RESET role;
  INSERT INTO po_deposit_applications (tenant_id, deposit_id, po_id, amount_no_vat, vat) VALUES (t_tenant, d_dep, po_d, 10, 0.7);
  BEGIN UPDATE supplier_deposits SET po_id = po_l WHERE id = d_dep; RAISE EXCEPTION 'A9 FAIL';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'deposit_in_use%' THEN RAISE EXCEPTION 'A9 FAIL: %', v_msg; END IF; END;
  SET LOCAL role = 'authenticated';

  -- A10: receipt bills and split parts cannot be deleted
  BEGIN DELETE FROM expenses WHERE id = e_bill; RAISE EXCEPTION 'A10 FAIL: receipt bill deleted';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'expense_is_receipt_bill%' THEN RAISE EXCEPTION 'A10 FAIL: %', v_msg; END IF; END;
  BEGIN DELETE FROM expenses WHERE id = e_split; RAISE EXCEPTION 'A10 FAIL: split part deleted';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'expense_is_split_part%' THEN RAISE EXCEPTION 'A10 FAIL: %', v_msg; END IF; END;

  -- A12: plain legacy flow untouched: receive then un-receive a PO without receipts/deposit
  PERFORM receive_po_with_deposits(po_l, '[]'::jsonb, 100, 7);
  UPDATE purchase_orders SET status = 'ordered', received_date = NULL, expense_id = NULL WHERE id = po_l;
  SELECT status INTO v_status FROM purchase_orders WHERE id = po_l;
  IF v_status <> 'ordered' THEN RAISE EXCEPTION 'A12 FAIL: %', v_status; END IF;

  -- A11: ACL
  RESET role;
  IF has_table_privilege('anon', 'po_receipts', 'SELECT') OR has_table_privilege('anon', 'po_receipt_items', 'SELECT') OR has_table_privilege('anon', 'expense_splits', 'SELECT')
     OR has_table_privilege('authenticated', 'po_receipts', 'INSERT') OR NOT has_table_privilege('authenticated', 'po_receipts', 'SELECT') THEN
    RAISE EXCEPTION 'A11 FAIL: table grants';
  END IF;
  IF has_function_privilege('authenticated', 'po_block_when_receipted()', 'EXECUTE') OR has_function_privilege('anon', 'sd_validate_po()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'expenses_block_receipt_bill_delete()', 'EXECUTE') OR has_function_privilege('authenticated', 'poi_block_when_receipted()', 'EXECUTE') THEN
    RAISE EXCEPTION 'A11 FAIL: trigger function grants';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.po_receipts'::regclass)
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.expense_splits'::regclass) THEN RAISE EXCEPTION 'A11 FAIL: RLS off'; END IF;

  -- A3: a PO line is received at most once (unique), checked last because it aborts nothing else
  BEGIN INSERT INTO po_receipt_items (tenant_id, receipt_id, po_item_id, quantity, line_total) VALUES (t_tenant, r1, po_r_item, 1, 100); RAISE EXCEPTION 'A3 FAIL';
  EXCEPTION WHEN unique_violation THEN NULL; END;

  RAISE EXCEPTION 'RESULT: po_receipt_test_a ALL PASSED';
END $$;
ROLLBACK;
