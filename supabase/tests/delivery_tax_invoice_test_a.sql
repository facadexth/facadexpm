-- ================================================================
-- Tests for 2026-10-09-04-delivery-tax-invoice.sql. Part A of 2.
-- Dry-run only: BEGIN; SET LOCAL lock_timeout='5s'; 2026-10-09-04; this body (BEGIN;/ROLLBACK; stripped); ROLLBACK;
-- Success = an ERROR containing 'RESULT: delivery_tax_invoice_test_a ALL PASSED'. Anything else = failure.
-- ================================================================
BEGIN;
DO $$
DECLARE
  t_owner UUID; t_tenant UUID; t2 UUID; t_site UUID; t_sup UUID; t_cat UUID; t_item UUID;
  email TEXT := '__test_dtia_owner__@example.com'; email2 TEXT := '__test_dtia_owner2__@example.com';
  poD UUID; d1 UUID; d2 UUID; poP UUID; p1 UUID; rc1 UUID; bill1 UUID; inv1 UUID; inv2 UUID; inv3 UUID; j JSONB;
  poR UUID; poQ UUID; q1 UUID; rcQ UUID; inv5 UUID;
  v_bkk DATE := (now() AT TIME ZONE 'Asia/Bangkok')::date; v_msg TEXT; v_n INT;
BEGIN
  SELECT id INTO t_owner FROM auth.users ORDER BY created_at ASC LIMIT 1;
  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at) VALUES ('__TEST dtia__', t_owner, 'trial', now() + interval '14 days') RETURNING id INTO t_tenant;
  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at) VALUES ('__TEST dtia 2__', t_owner, 'trial', now() + interval '14 days') RETURNING id INTO t2;
  INSERT INTO user_roles (user_email, role, status, tenant_id) VALUES (email, 'OWNER', 'approved', t_tenant), (email2, 'OWNER', 'approved', t2);
  INSERT INTO sites (tenant_id, site_number, name) VALUES (t_tenant, '__DTIA-1__', '__dtia site__') RETURNING id INTO t_site;
  INSERT INTO suppliers (tenant_id, name) VALUES (t_tenant, '__dtia sup__') RETURNING id INTO t_sup;
  INSERT INTO expense_categories (tenant_id, name) VALUES (t_tenant, '__dtia cat__') RETURNING id INTO t_cat;
  INSERT INTO inventory_items (tenant_id, name, base_unit) VALUES (t_tenant, '__dtia item__', 'kg') RETURNING id INTO t_item;
  -- poR: an ordered 'po' PO that still has a purchase_order stock movement (a legacy receive reverted by hand)
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status) VALUES (t_tenant, 'PO-DTIA-R', t_site, t_sup, t_cat, v_bkk, 'ordered') RETURNING id INTO poR;
  INSERT INTO stock_movements (tenant_id, inventory_item_id, site_id, movement_type, quantity, unit_cost, reference_type, reference_id, notes)
  VALUES (t_tenant, t_item, t_site, 'purchase_in', 1, 10, 'purchase_order', poR, '__dtia legacy receive__');
  -- A1 defaults
  IF (SELECT default_tax_invoice_mode FROM suppliers WHERE id = t_sup) <> 'po' THEN RAISE EXCEPTION 'A1 FAIL: supplier default'; END IF;

  SET LOCAL role = 'authenticated';
  PERFORM set_config('request.jwt.claims', json_build_object('email', email, 'role', 'authenticated')::text, true);
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status) VALUES (t_tenant, 'PO-DTIA-D', t_site, t_sup, t_cat, v_bkk, 'ordered') RETURNING id INTO poD;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total, inventory_item_id, sort_order) VALUES (t_tenant, poD, 'D1', 2, 300, 600, t_item, 0) RETURNING id INTO d1;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total, inventory_item_id, sort_order) VALUES (t_tenant, poD, 'D2', 4, 100, 400, t_item, 1) RETURNING id INTO d2;
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status) VALUES (t_tenant, 'PO-DTIA-P', t_site, t_sup, t_cat, v_bkk, 'ordered') RETURNING id INTO poP;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total) VALUES (t_tenant, poP, 'P1', 1, 10, 10) RETURNING id INTO p1;
  IF (SELECT tax_invoice_mode FROM purchase_orders WHERE id = poD) <> 'po' THEN RAISE EXCEPTION 'A1 FAIL: PO default'; END IF;

  -- A2 CHECK constraints
  BEGIN UPDATE purchase_orders SET tax_invoice_mode = 'lot' WHERE id = poD; RAISE EXCEPTION 'A2 FAIL: bad PO mode accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE suppliers SET default_tax_invoice_mode = 'lot' WHERE id = t_sup; RAISE EXCEPTION 'A2 FAIL: bad supplier mode accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;

  -- A3 free while ordered without receipts; the client sets both columns
  UPDATE suppliers SET default_tax_invoice_mode = 'delivery' WHERE id = t_sup;
  UPDATE purchase_orders SET tax_invoice_mode = 'delivery' WHERE id = poD;
  UPDATE purchase_orders SET tax_invoice_mode = 'po' WHERE id = poD;
  UPDATE purchase_orders SET tax_invoice_mode = 'delivery' WHERE id = poD;
  IF (SELECT tax_invoice_mode FROM purchase_orders WHERE id = poD) <> 'delivery' OR (SELECT default_tax_invoice_mode FROM suppliers WHERE id = t_sup) <> 'delivery' THEN
    RAISE EXCEPTION 'A3 FAIL: client could not set the modes';
  END IF;
  -- A3b the supplier default never rewrites an existing PO
  IF (SELECT tax_invoice_mode FROM purchase_orders WHERE id = poP) <> 'po' THEN RAISE EXCEPTION 'A3b FAIL: supplier default propagated'; END IF;
  -- A3c an ordered PO with purchase_order stock movements keeps its mode (flipping it would post the stock twice)
  BEGIN UPDATE purchase_orders SET tax_invoice_mode = 'delivery' WHERE id = poR; RAISE EXCEPTION 'A3c FAIL: mode changed on a PO with stock movements';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'po_mode_locked%' THEN RAISE EXCEPTION 'A3c FAIL: got %', v_msg; END IF; END;

  -- A5 a delivery PO is never received the old whole-PO way (no receipt row would exist to invoice)
  BEGIN UPDATE purchase_orders SET status = 'received' WHERE id = poD; RAISE EXCEPTION 'A5 FAIL: direct status change accepted';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'po_delivery_needs_receipt%' THEN RAISE EXCEPTION 'A5 FAIL: got %', v_msg; END IF; END;
  BEGIN PERFORM receive_po_with_deposits(poD, '[]'::jsonb, 1000, 70); RAISE EXCEPTION 'A5 FAIL: legacy receive accepted';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'po_delivery_needs_receipt%' THEN RAISE EXCEPTION 'A5 FAIL: legacy got %', v_msg; END IF; END;
  -- A5b nor created already received (INSERT branch)
  BEGIN INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status, tax_invoice_mode) VALUES (t_tenant, 'PO-DTIA-X', t_site, t_sup, t_cat, v_bkk, 'received', 'delivery');
    RAISE EXCEPTION 'A5b FAIL: delivery PO inserted as received';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'po_delivery_needs_receipt%' THEN RAISE EXCEPTION 'A5b FAIL: got %', v_msg; END IF; END;

  -- A4 lot 1 through receive_po_lines works; then the mode is locked
  j := receive_po_lines(poD, ARRAY[d1], v_bkk, '[]'::jsonb, 600, 42, jsonb_build_array(jsonb_build_object('po_item_id', d1, 'base_qty', 2, 'unit_cost', 300)));
  rc1 := (j->>'receipt_id')::uuid; bill1 := (j->>'expense_id')::uuid;
  IF (SELECT status FROM purchase_orders WHERE id = poD) <> 'partially_received' THEN RAISE EXCEPTION 'A4 FAIL: status'; END IF;
  BEGIN UPDATE purchase_orders SET tax_invoice_mode = 'po' WHERE id = poD; RAISE EXCEPTION 'A4 FAIL: mode changed after a receipt';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'po_mode_locked%' THEN RAISE EXCEPTION 'A4 FAIL: got %', v_msg; END IF; END;
  -- A4b a 'po' PO received the legacy way (still allowed for 'po') is locked too
  UPDATE purchase_orders SET status = 'received' WHERE id = poP;
  BEGIN UPDATE purchase_orders SET tax_invoice_mode = 'delivery' WHERE id = poP; RAISE EXCEPTION 'A4b FAIL: mode changed on a received PO';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'po_mode_locked%' THEN RAISE EXCEPTION 'A4b FAIL: got %', v_msg; END IF; END;
  -- A4c a receipt of a 'po' PO (receive_po_lines works for both modes); used by A16
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status) VALUES (t_tenant, 'PO-DTIA-Q', t_site, t_sup, t_cat, v_bkk, 'ordered') RETURNING id INTO poQ;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total) VALUES (t_tenant, poQ, 'Q1', 1, 100, 100) RETURNING id INTO q1;
  j := receive_po_lines(poQ, ARRAY[q1], v_bkk, '[]'::jsonb, 100, 7, '[]'::jsonb);
  rcQ := (j->>'receipt_id')::uuid;
  IF rcQ IS NULL OR (SELECT tax_invoice_mode FROM purchase_orders WHERE id = poQ) <> 'po' THEN RAISE EXCEPTION 'A4c FAIL: po-mode receipt'; END IF;

  -- A6 clients read the link table but never write it
  inv1 := save_supplier_tax_invoice_draft(NULL, jsonb_build_object('supplier_id', t_sup, 'invoice_no', 'DTIA-1', 'invoice_date', v_bkk, 'net_before_vat', 600, 'vat', 42), '[]'::jsonb, '{}'::uuid[]);
  BEGIN INSERT INTO supplier_tax_invoice_receipts (tenant_id, invoice_id, receipt_id, po_id) VALUES (t_tenant, inv1, rc1, poD); RAISE EXCEPTION 'A6 FAIL: client insert accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  PERFORM 1 FROM supplier_tax_invoice_receipts;
  -- A7 anon cannot read it
  SET LOCAL role = 'anon';
  BEGIN PERFORM 1 FROM supplier_tax_invoice_receipts; RAISE EXCEPTION 'A7 FAIL: anon read';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  SET LOCAL role = 'authenticated';
  -- A11 a receipt bill still cannot be deleted
  BEGIN DELETE FROM expenses WHERE id = bill1; GET DIAGNOSTICS v_n = ROW_COUNT; RAISE EXCEPTION 'A11 FAIL: delete not refused (% rows)', v_n;
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'expense_is_receipt_bill%' THEN RAISE EXCEPTION 'A11 FAIL: got %', v_msg; END IF; END;
  -- A14 a fully received 'delivery' PO is never linked as a whole PO through the live draft RPC
  j := receive_po_lines(poD, ARRAY[d2], v_bkk, '[]'::jsonb, 400, 28, jsonb_build_array(jsonb_build_object('po_item_id', d2, 'base_qty', 4, 'unit_cost', 100)));
  IF (SELECT status FROM purchase_orders WHERE id = poD) <> 'received' THEN RAISE EXCEPTION 'A14 FAIL: final lot status'; END IF;
  BEGIN PERFORM save_supplier_tax_invoice_draft(NULL, jsonb_build_object('supplier_id', t_sup, 'invoice_no', 'DTIA-4', 'invoice_date', v_bkk, 'net_before_vat', 1000, 'vat', 70), '[]'::jsonb, ARRAY[poD]);
    RAISE EXCEPTION 'A14 FAIL: delivery PO linked as a whole PO';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'po_is_delivery_mode%' THEN RAISE EXCEPTION 'A14 FAIL: got %', v_msg; END IF; END;

  -- A8-A10 guards, as the RPCs will write (superuser)
  RESET role;
  INSERT INTO supplier_tax_invoice_receipts (tenant_id, invoice_id, receipt_id, po_id) VALUES (t_tenant, inv1, rc1, poD);
  BEGIN INSERT INTO supplier_tax_invoice_pos (tenant_id, invoice_id, po_id) VALUES (t_tenant, inv1, poP); RAISE EXCEPTION 'A8 FAIL: PO link added to a receipt invoice';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'invoice_mixed_links%' THEN RAISE EXCEPTION 'A8 FAIL: got %', v_msg; END IF; END;
  INSERT INTO supplier_tax_invoices (tenant_id, supplier_id, invoice_no, invoice_date, net_before_vat, vat, grand_total) VALUES (t_tenant, t_sup, 'DTIA-2', v_bkk, 10, 0, 10) RETURNING id INTO inv2;
  INSERT INTO supplier_tax_invoice_pos (tenant_id, invoice_id, po_id) VALUES (t_tenant, inv2, poP);
  BEGIN INSERT INTO supplier_tax_invoice_receipts (tenant_id, invoice_id, receipt_id, po_id) VALUES (t_tenant, inv2, rc1, poD); RAISE EXCEPTION 'A8 FAIL: receipt link added to a PO invoice';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'invoice_mixed_links%' THEN RAISE EXCEPTION 'A8 FAIL: reverse got %', v_msg; END IF; END;
  INSERT INTO supplier_tax_invoices (tenant_id, supplier_id, invoice_no, invoice_date, net_before_vat, vat, grand_total) VALUES (t_tenant, t_sup, 'DTIA-3', v_bkk, 10, 0, 10) RETURNING id INTO inv3;
  BEGIN INSERT INTO supplier_tax_invoice_receipts (tenant_id, invoice_id, receipt_id, po_id) VALUES (t_tenant, inv3, rc1, poP); RAISE EXCEPTION 'A9 FAIL: wrong po_id accepted';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'cross_tenant_reference%' THEN RAISE EXCEPTION 'A9 FAIL: got %', v_msg; END IF; END;
  BEGIN INSERT INTO supplier_tax_invoice_receipts (tenant_id, invoice_id, receipt_id, po_id) VALUES (t2, inv3, rc1, poD); RAISE EXCEPTION 'A9 FAIL: other tenant accepted';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'cross_tenant_reference%' THEN RAISE EXCEPTION 'A9 FAIL: tenant got %', v_msg; END IF; END;
  BEGIN INSERT INTO supplier_tax_invoice_receipts (tenant_id, invoice_id, receipt_id, po_id) VALUES (t_tenant, inv3, rc1, poD); RAISE EXCEPTION 'A10 FAIL: receipt in two active invoices';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  UPDATE supplier_tax_invoice_receipts SET active = false WHERE invoice_id = inv1;
  INSERT INTO supplier_tax_invoice_receipts (tenant_id, invoice_id, receipt_id, po_id) VALUES (t_tenant, inv3, rc1, poD);   -- allowed once inactive

  -- A16 receipt links only for 'delivery' POs; A17 whole-PO links never for 'delivery' POs (superuser path)
  INSERT INTO supplier_tax_invoices (tenant_id, supplier_id, invoice_no, invoice_date, net_before_vat, vat, grand_total) VALUES (t_tenant, t_sup, 'DTIA-5', v_bkk, 10, 0, 10) RETURNING id INTO inv5;
  BEGIN INSERT INTO supplier_tax_invoice_receipts (tenant_id, invoice_id, receipt_id, po_id) VALUES (t_tenant, inv5, rcQ, poQ); RAISE EXCEPTION 'A16 FAIL: receipt of a po-mode PO linked';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'receipt_po_not_delivery%' THEN RAISE EXCEPTION 'A16 FAIL: got %', v_msg; END IF; END;
  BEGIN INSERT INTO supplier_tax_invoice_pos (tenant_id, invoice_id, po_id) VALUES (t_tenant, inv5, poD); RAISE EXCEPTION 'A17 FAIL: delivery PO linked as a whole PO';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'po_is_delivery_mode%' THEN RAISE EXCEPTION 'A17 FAIL: got %', v_msg; END IF; END;
  IF EXISTS (SELECT 1 FROM supplier_tax_invoice_receipts WHERE invoice_id = inv5) OR EXISTS (SELECT 1 FROM supplier_tax_invoice_pos WHERE invoice_id = inv5) THEN
    RAISE EXCEPTION 'A16/A17 FAIL: a refused link remained';
  END IF;

  -- A12 grants, RLS, function privileges
  IF has_table_privilege('authenticated', 'supplier_tax_invoice_receipts', 'INSERT') OR has_table_privilege('authenticated', 'supplier_tax_invoice_receipts', 'UPDATE')
     OR has_table_privilege('authenticated', 'supplier_tax_invoice_receipts', 'DELETE') OR NOT has_table_privilege('authenticated', 'supplier_tax_invoice_receipts', 'SELECT')
     OR has_table_privilege('anon', 'supplier_tax_invoice_receipts', 'SELECT') THEN RAISE EXCEPTION 'A12 FAIL: table grants'; END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.supplier_tax_invoice_receipts'::regclass) THEN RAISE EXCEPTION 'A12 FAIL: RLS off'; END IF;
  IF has_function_privilege('authenticated', 'po_tax_invoice_mode_guard()', 'EXECUTE') OR has_function_privilege('anon', 'po_tax_invoice_mode_guard()', 'EXECUTE')
     OR has_function_privilege('anon', 'sti_link_kind_guard()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'sti_link_kind_guard()', 'EXECUTE') THEN RAISE EXCEPTION 'A12 FAIL: trigger function executable'; END IF;

  -- A13 tenant isolation of reads: positive control first (tenant 1 sees its two links: inv1 inactive, inv3 active)
  SET LOCAL role = 'authenticated';
  PERFORM set_config('request.jwt.claims', json_build_object('email', email, 'role', 'authenticated')::text, true);
  SELECT count(*) INTO v_n FROM supplier_tax_invoice_receipts;
  IF v_n <> 2 THEN RAISE EXCEPTION 'A13 FAIL: owner sees % links, expected 2', v_n; END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('email', email2, 'role', 'authenticated')::text, true);
  IF EXISTS (SELECT 1 FROM supplier_tax_invoice_receipts) THEN RAISE EXCEPTION 'A13 FAIL: other tenant sees links'; END IF;

  -- A18 deleting a draft invoice (live RPC) cascades its receipt links and frees the receipt
  PERFORM set_config('request.jwt.claims', json_build_object('email', email, 'role', 'authenticated')::text, true);
  PERFORM delete_supplier_tax_invoice_draft(inv3);
  RESET role;
  IF EXISTS (SELECT 1 FROM supplier_tax_invoices WHERE id = inv3) OR EXISTS (SELECT 1 FROM supplier_tax_invoice_receipts WHERE invoice_id = inv3) THEN
    RAISE EXCEPTION 'A18 FAIL: draft or its receipt links remain';
  END IF;
  IF EXISTS (SELECT 1 FROM supplier_tax_invoice_receipts WHERE receipt_id = rc1 AND active) THEN RAISE EXCEPTION 'A18 FAIL: receipt still held'; END IF;
  IF NOT EXISTS (SELECT 1 FROM supplier_tax_invoice_receipts WHERE invoice_id = inv1) THEN RAISE EXCEPTION 'A18 FAIL: other invoice link lost'; END IF;

  RAISE EXCEPTION 'RESULT: delivery_tax_invoice_test_a ALL PASSED';
END $$;
ROLLBACK;
