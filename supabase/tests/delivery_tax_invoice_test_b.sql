-- ================================================================
-- Tests for 2026-10-09-05-delivery-tax-invoice-rpcs.sql. Part B of 2.
-- Dry-run only: BEGIN; SET LOCAL lock_timeout='5s'; 2026-10-09-04; 2026-10-09-05; this body (BEGIN;/ROLLBACK; stripped); ROLLBACK;
-- Success = an ERROR containing 'RESULT: delivery_tax_invoice_test_b ALL PASSED'. Anything else = failure.
-- One transaction: now() is constant, so posted_at equals the created_at of every later split (the >= filter keeps them).
-- Bills carry NON-NULL prior numbers ('DN-…') so a wrong restore is visible.
-- ================================================================
BEGIN;
DO $$
DECLARE
  t_owner UUID; t_tenant UUID; t2 UUID; t_site UUID; t_sup UUID; t_sup2 UUID; t_cat UUID; site_t2 UUID; sup_t2 UUID; cat_t2 UUID;
  iI UUID; iJ UUID; iK UUID; iL UUID; iM UUID;
  email TEXT := '__test_dtib_owner__@example.com'; w_email TEXT := '__test_dtib_worker__@example.com';
  poD1 UUID; a1 UUID; a2 UUID; poD2 UUID; b1 UUID; poX UUID; x1 UUID; poP UUID; p1 UUID; poD3 UUID; k1 UUID; k2 UUID; poF UUID; f1 UUID; poT2 UUID;
  rc1 UUID; rc2 UUID; rc3 UUID; rcX UUID; rcP UUID; rcK1 UUID; rcK2 UUID; rcF UUID; rcT2 UUID;
  bill1 UUID; bill2 UUID; bill3 UUID; billP UUID; c3 UUID; g2 UUID; x_exp UUID; mv1 UUID;
  inv1 UUID; inv2 UUID; inv4 UUID; invM UUID; invP UUID; invF UUID; invK UUID; invL UUID; invN UUID; invS UUID; itN JSONB;
  j JSONB; e JSONB; hdr JSONB; v_rev INT; v_msg TEXT; v_q NUMERIC; v_w NUMERIC;
  v_bkk DATE := (now() AT TIME ZONE 'Asia/Bangkok')::date;
BEGIN
  SELECT id INTO t_owner FROM auth.users ORDER BY created_at ASC LIMIT 1;
  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at) VALUES ('__TEST dtib__', t_owner, 'trial', now() + interval '14 days') RETURNING id INTO t_tenant;
  INSERT INTO user_roles (user_email, role, status, tenant_id) VALUES (email, 'OWNER', 'approved', t_tenant), (w_email, 'WORKER', 'approved', t_tenant);
  INSERT INTO sites (tenant_id, site_number, name) VALUES (t_tenant, '__DTIB-1__', '__dtib site__') RETURNING id INTO t_site;
  INSERT INTO suppliers (tenant_id, name, default_tax_invoice_mode) VALUES (t_tenant, '__dtib cac__', 'delivery') RETURNING id INTO t_sup;
  INSERT INTO suppliers (tenant_id, name) VALUES (t_tenant, '__dtib other__') RETURNING id INTO t_sup2;
  INSERT INTO expense_categories (tenant_id, name) VALUES (t_tenant, '__dtib cat__') RETURNING id INTO t_cat;
  INSERT INTO inventory_items (tenant_id, name, base_unit) VALUES (t_tenant, '__dtib I__', 'kg') RETURNING id INTO iI;
  INSERT INTO inventory_items (tenant_id, name, base_unit) VALUES (t_tenant, '__dtib J__', 'kg') RETURNING id INTO iJ;
  INSERT INTO inventory_items (tenant_id, name, base_unit) VALUES (t_tenant, '__dtib K__', 'kg') RETURNING id INTO iK;
  INSERT INTO inventory_items (tenant_id, name, base_unit) VALUES (t_tenant, '__dtib L__', 'kg') RETURNING id INTO iL;
  INSERT INTO inventory_items (tenant_id, name, base_unit) VALUES (t_tenant, '__dtib M__', 'kg') RETURNING id INTO iM;
  -- tenant 2 owns one delivery receipt (cross-tenant probe)
  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at) VALUES ('__TEST dtib t2__', t_owner, 'trial', now() + interval '14 days') RETURNING id INTO t2;
  INSERT INTO sites (tenant_id, site_number, name) VALUES (t2, '__DTIB-T2__', '__dtib t2 site__') RETURNING id INTO site_t2;
  INSERT INTO suppliers (tenant_id, name) VALUES (t2, '__dtib t2 sup__') RETURNING id INTO sup_t2;
  INSERT INTO expense_categories (tenant_id, name) VALUES (t2, '__dtib t2 cat__') RETURNING id INTO cat_t2;
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status, tax_invoice_mode)
  VALUES (t2, 'PO-DTIB-T2', site_t2, sup_t2, cat_t2, v_bkk, 'ordered', 'delivery') RETURNING id INTO poT2;
  INSERT INTO po_receipts (tenant_id, po_id, seq, received_date, goods_subtotal, goods_vat) VALUES (t2, poT2, 1, v_bkk, 10, 0.7) RETURNING id INTO rcT2;

  SET LOCAL role = 'authenticated';
  PERFORM set_config('request.jwt.claims', json_build_object('email', email, 'role', 'authenticated')::text, true);
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status, tax_invoice_mode) VALUES (t_tenant, 'PO-DTIB-D1', t_site, t_sup, t_cat, v_bkk - 3, 'ordered', 'delivery') RETURNING id INTO poD1;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total, inventory_item_id, sort_order) VALUES (t_tenant, poD1, 'A1', 2, 300, 600, iI, 0) RETURNING id INTO a1;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total, inventory_item_id, sort_order) VALUES (t_tenant, poD1, 'A2', 4, 100, 400, iI, 1) RETURNING id INTO a2;
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status, tax_invoice_mode) VALUES (t_tenant, 'PO-DTIB-D2', t_site, t_sup, t_cat, v_bkk - 3, 'ordered', 'delivery') RETURNING id INTO poD2;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total, inventory_item_id, sort_order) VALUES (t_tenant, poD2, 'B1', 5, 200, 1000, iJ, 0) RETURNING id INTO b1;
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status, tax_invoice_mode) VALUES (t_tenant, 'PO-DTIB-X', t_site, t_sup2, t_cat, v_bkk, 'ordered', 'delivery') RETURNING id INTO poX;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total, sort_order) VALUES (t_tenant, poX, 'X1', 1, 100, 100, 0) RETURNING id INTO x1;
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status) VALUES (t_tenant, 'PO-DTIB-P', t_site, t_sup, t_cat, v_bkk, 'ordered') RETURNING id INTO poP;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total, inventory_item_id, sort_order) VALUES (t_tenant, poP, 'P1', 1, 50, 50, iM, 0) RETURNING id INTO p1;
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status, tax_invoice_mode) VALUES (t_tenant, 'PO-DTIB-D3', t_site, t_sup, t_cat, v_bkk, 'ordered', 'delivery') RETURNING id INTO poD3;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total, inventory_item_id, sort_order) VALUES (t_tenant, poD3, 'K1', 3, 100, 300, iK, 0) RETURNING id INTO k1;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total, inventory_item_id, sort_order) VALUES (t_tenant, poD3, 'L1', 1, 50, 50, iL, 1) RETURNING id INTO k2;
  INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status, tax_invoice_mode, stock_from_invoice) VALUES (t_tenant, 'PO-DTIB-F', t_site, t_sup, t_cat, v_bkk, 'ordered', 'delivery', true) RETURNING id INTO poF;
  INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit_price, line_total, inventory_item_id, sort_order) VALUES (t_tenant, poF, 'F1', 1, 100, 100, iI, 0) RETURNING id INTO f1;

  j := receive_po_lines(poD1, ARRAY[a1], v_bkk - 2, '[]'::jsonb, 600, 42, jsonb_build_array(jsonb_build_object('po_item_id', a1, 'base_qty', 2, 'unit_cost', 300)));
  rc1 := (j->>'receipt_id')::uuid; bill1 := (j->>'expense_id')::uuid;
  j := receive_po_lines(poD2, ARRAY[b1], v_bkk - 1, '[]'::jsonb, 1000, 70, jsonb_build_array(jsonb_build_object('po_item_id', b1, 'base_qty', 5, 'unit_cost', 200)));
  rc3 := (j->>'receipt_id')::uuid; bill3 := (j->>'expense_id')::uuid;
  j := receive_po_lines(poX, ARRAY[x1], v_bkk, '[]'::jsonb, 100, 7, '[]'::jsonb); rcX := (j->>'receipt_id')::uuid;
  j := receive_po_lines(poP, ARRAY[p1], v_bkk, '[]'::jsonb, 50, 3.5, jsonb_build_array(jsonb_build_object('po_item_id', p1, 'base_qty', 1, 'unit_cost', 50)));
  rcP := (j->>'receipt_id')::uuid; billP := (j->>'expense_id')::uuid;
  j := receive_po_lines(poD3, ARRAY[k1], v_bkk, '[]'::jsonb, 300, 21, jsonb_build_array(jsonb_build_object('po_item_id', k1, 'base_qty', 3, 'unit_cost', 100))); rcK1 := (j->>'receipt_id')::uuid;
  j := receive_po_lines(poD3, ARRAY[k2], v_bkk, '[]'::jsonb, 50, 3.5, jsonb_build_array(jsonb_build_object('po_item_id', k2, 'base_qty', 1, 'unit_cost', 50))); rcK2 := (j->>'receipt_id')::uuid;
  j := receive_po_lines(poF, ARRAY[f1], v_bkk, '[]'::jsonb, 100, 7, '[]'::jsonb); rcF := (j->>'receipt_id')::uuid;

  RESET role;
  UPDATE expenses SET invoice_no = 'DN-1' WHERE id = bill1;
  UPDATE expenses SET invoice_no = 'DN-3' WHERE id = bill3;
  UPDATE expenses SET invoice_no = 'DN-P' WHERE id = billP;
  -- an unrelated bill of the same supplier carrying the future invoice number: must never be touched
  INSERT INTO expenses (tenant_id, date, description, site_id, category_id, supplier_id, amount_no_vat, vat, amount, payment_method, status, invoice_no)
  VALUES (t_tenant, v_bkk, '__dtib other__', t_site, t_cat, t_sup, 10, 0.7, 10.7, 'transfer', 'pending', 'DTIB-2') RETURNING id INTO x_exp;
  SET LOCAL role = 'authenticated';

  -- B1 a receipt draft links one lot of a two-lot PO
  hdr := jsonb_build_object('supplier_id', t_sup, 'invoice_no', 'DTIB-1', 'invoice_date', v_bkk, 'net_before_vat', 600, 'vat', 42);
  inv1 := save_supplier_tax_invoice_receipt_draft(NULL, hdr,
    jsonb_build_array(jsonb_build_object('description', 'เหล็ก ล็อต 1', 'qty', 2.5, 'unit', 'kg', 'unit_price', 240, 'inventory_item_id', iI, 'site_id', t_site, 'base_qty', 2.5)),
    ARRAY[rc1]);
  IF (SELECT count(*) FROM supplier_tax_invoice_receipts WHERE invoice_id = inv1 AND receipt_id = rc1 AND po_id = poD1 AND active) <> 1 THEN RAISE EXCEPTION 'B1 FAIL: link row'; END IF;
  -- B1b not eligible: other supplier, 'po' mode PO, other tenant; B1c the same receipt twice
  BEGIN PERFORM save_supplier_tax_invoice_receipt_draft(NULL, jsonb_set(hdr, '{invoice_no}', '"DTIB-X"'), '[]'::jsonb, ARRAY[rcX]); RAISE EXCEPTION 'B1b FAIL: other supplier';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'receipt_not_eligible%' THEN RAISE EXCEPTION 'B1b FAIL: got %', v_msg; END IF; END;
  BEGIN PERFORM save_supplier_tax_invoice_receipt_draft(NULL, jsonb_set(hdr, '{invoice_no}', '"DTIB-X"'), '[]'::jsonb, ARRAY[rcP]); RAISE EXCEPTION 'B1b FAIL: po-mode receipt';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'receipt_not_eligible%' THEN RAISE EXCEPTION 'B1b FAIL: po got %', v_msg; END IF; END;
  BEGIN PERFORM save_supplier_tax_invoice_receipt_draft(NULL, jsonb_set(hdr, '{invoice_no}', '"DTIB-X"'), '[]'::jsonb, ARRAY[rcT2]); RAISE EXCEPTION 'B16 FAIL: other tenant receipt';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'receipt_not_eligible%' THEN RAISE EXCEPTION 'B16 FAIL: got %', v_msg; END IF; END;
  BEGIN PERFORM save_supplier_tax_invoice_receipt_draft(NULL, jsonb_set(hdr, '{invoice_no}', '"DTIB-Y"'), '[]'::jsonb, ARRAY[rc1]); RAISE EXCEPTION 'B1c FAIL: linked twice';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'receipt_linked_elsewhere%' THEN RAISE EXCEPTION 'B1c FAIL: got %', v_msg; END IF; END;

  -- B2 a delivery PO cannot be linked at PO level
  BEGIN PERFORM save_supplier_tax_invoice_draft(NULL, jsonb_set(hdr, '{invoice_no}', '"DTIB-Z"'), '[]'::jsonb, ARRAY[poD2]); RAISE EXCEPTION 'B2 FAIL: delivery PO linked whole';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'po_is_delivery_mode%' THEN RAISE EXCEPTION 'B2 FAIL: got %', v_msg; END IF; END;

  -- B3 re-saving a receipt draft as a PO draft drops its receipt links; deleting a draft frees its links
  invM := save_supplier_tax_invoice_receipt_draft(NULL, jsonb_set(hdr, '{invoice_no}', '"DTIB-M"'), '[]'::jsonb, ARRAY[rc3]);
  PERFORM save_supplier_tax_invoice_draft(invM, jsonb_set(hdr, '{invoice_no}', '"DTIB-M"'), '[]'::jsonb, ARRAY[poP]);
  IF EXISTS (SELECT 1 FROM supplier_tax_invoice_receipts WHERE invoice_id = invM) OR NOT EXISTS (SELECT 1 FROM supplier_tax_invoice_pos WHERE invoice_id = invM AND po_id = poP) THEN
    RAISE EXCEPTION 'B3 FAIL: kind switch';
  END IF;
  PERFORM delete_supplier_tax_invoice_draft(invM);
  IF EXISTS (SELECT 1 FROM supplier_tax_invoice_pos WHERE po_id = poP) THEN RAISE EXCEPTION 'B3 FAIL: links survived the delete'; END IF;

  -- B4 preview of lot 1: excl basis, stock add/remove per receipt
  j := preview_supplier_tax_invoice(inv1);
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(j->'checks') c WHERE (c->>'blocking')::boolean) THEN RAISE EXCEPTION 'B4 FAIL: blocking %', j->'checks'; END IF;
  IF (j->>'po_sum')::numeric <> 600 OR j->>'basis' <> 'excl' OR (j->>'diff')::numeric <> 0 THEN RAISE EXCEPTION 'B4 FAIL: match %', j; END IF;
  SELECT x INTO e FROM jsonb_array_elements(j->'rows') x WHERE x->>'inventory_item_id' = iI::text;
  IF (e->>'before_qty')::numeric <> 2 OR (e->>'add_qty')::numeric <> 2.5 OR (e->>'remove_qty')::numeric <> 2 OR (e->>'after_qty')::numeric <> 2.5 THEN RAISE EXCEPTION 'B4 FAIL: row %', e; END IF;
  -- B4b header VAT 42 = 7% of 600: no vat_rate_mismatch
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(j->'checks') c WHERE c->>'code' = 'vat_rate_mismatch') THEN RAISE EXCEPTION 'B4b FAIL: vat_rate_mismatch %', j->'checks'; END IF;
  v_rev := (j->>'revision')::int;

  -- B5 post lot 1: only that receipt's stock and bill; PO status unchanged
  j := post_supplier_tax_invoice(inv1, v_rev);
  IF (j->>'lines_posted')::int <> 1 OR (j->>'receipts_reversed')::int <> 1 OR (j->>'expenses_stamped')::int <> 1 THEN RAISE EXCEPTION 'B5 FAIL: result %', j; END IF;
  RESET role;
  SELECT quantity_on_hand, weighted_average_cost INTO v_q, v_w FROM inventory_stock_balances WHERE inventory_item_id = iI AND site_id = t_site;
  IF v_q <> 2.5 OR abs(v_w - 240) > 1e-9 THEN RAISE EXCEPTION 'B5 FAIL: I % @ %', v_q, v_w; END IF;
  IF (SELECT invoice_no FROM expenses WHERE id = bill1) <> 'DTIB-1' THEN RAISE EXCEPTION 'B5 FAIL: bill1 not stamped'; END IF;
  IF NOT EXISTS (SELECT 1 FROM supplier_tax_invoice_expense_stamps WHERE invoice_id = inv1 AND expense_id = bill1 AND po_id = poD1 AND prev_invoice_no = 'DN-1' AND stamped_invoice_no = 'DTIB-1') THEN
    RAISE EXCEPTION 'B5 FAIL: stamp row';
  END IF;
  IF (SELECT status FROM purchase_orders WHERE id = poD1) <> 'partially_received' THEN RAISE EXCEPTION 'B5 FAIL: PO status changed by post'; END IF;
  IF NOT EXISTS (SELECT 1 FROM supplier_tax_invoice_receipts WHERE invoice_id = inv1 AND goods_subtotal = 600 AND goods_vat = 42) THEN RAISE EXCEPTION 'B5 FAIL: snapshot'; END IF;
  SELECT stock_movement_id INTO mv1 FROM po_receipt_items WHERE receipt_id = rc1;
  IF NOT EXISTS (SELECT 1 FROM supplier_tax_invoice_reversals WHERE invoice_id = inv1 AND source_movement_id = mv1 AND quantity = 2 AND unit_cost = 300) THEN RAISE EXCEPTION 'B5 FAIL: reversal row'; END IF;
  SET LOCAL role = 'authenticated';

  -- B6 lot 2 is received after lot 1's invoice posted; its bill is not stamped
  j := receive_po_lines(poD1, ARRAY[a2], v_bkk, '[]'::jsonb, 400, 28, jsonb_build_array(jsonb_build_object('po_item_id', a2, 'base_qty', 4, 'unit_cost', 100)));
  rc2 := (j->>'receipt_id')::uuid; bill2 := (j->>'expense_id')::uuid;
  IF j->>'status' <> 'received' THEN RAISE EXCEPTION 'B6 FAIL: status %', j->>'status'; END IF;
  RESET role;
  UPDATE expenses SET invoice_no = 'DN-2' WHERE id = bill2;
  IF EXISTS (SELECT 1 FROM supplier_tax_invoice_expense_stamps WHERE expense_id = bill2) THEN RAISE EXCEPTION 'B6 FAIL: bill2 stamped'; END IF;
  SET LOCAL role = 'authenticated';

  -- B7 two lots of two POs in one invoice, VAT-inclusive basis; bill3 split BEFORE the post, bill2 split AFTER
  j := split_payment(bill3, 100, v_bkk, 'transfer'); c3 := (j->>'remaining_expense_id')::uuid;
  inv2 := save_supplier_tax_invoice_receipt_draft(NULL,
    jsonb_build_object('supplier_id', t_sup, 'invoice_no', 'DTIB-2', 'invoice_date', v_bkk, 'net_before_vat', 1390, 'vat', 108),
    jsonb_build_array(
      jsonb_build_object('description', 'เหล็ก ล็อต 2', 'qty', 4, 'unit', 'kg', 'unit_price', 97.5, 'inventory_item_id', iI, 'site_id', t_site, 'base_qty', 4),
      jsonb_build_object('description', 'J', 'qty', 5, 'unit', 'kg', 'unit_price', 200, 'inventory_item_id', iJ, 'site_id', t_site, 'base_qty', 5)),
    ARRAY[rc2, rc3]);
  j := preview_supplier_tax_invoice(inv2);
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(j->'checks') c WHERE (c->>'blocking')::boolean) THEN RAISE EXCEPTION 'B7 FAIL: blocking %', j->'checks'; END IF;
  IF j->>'basis' <> 'incl' OR (j->>'diff')::numeric <> 0 OR (j->>'diff_excl')::numeric <> -10 OR (j->>'sum_incl')::numeric <> 1498 THEN RAISE EXCEPTION 'B7 FAIL: match %', j; END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(j->'checks') c WHERE c->>'code' = 'match_vat_inclusive' AND NOT (c->>'blocking')::boolean) THEN RAISE EXCEPTION 'B7 FAIL: no match_vat_inclusive'; END IF;
  -- B7b the incl-basis warning carries the ex-VAT difference; header VAT 108 vs 7% of 1390 = 97.30 (> max(1, 0.973)): warned, not blocking
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(j->'checks') c WHERE c->>'code' = 'match_vat_inclusive' AND (c->>'detail')::numeric = -10) THEN RAISE EXCEPTION 'B7b FAIL: detail %', j->'checks'; END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(j->'checks') c WHERE c->>'code' = 'vat_rate_mismatch' AND NOT (c->>'blocking')::boolean AND (c->>'detail')::numeric = 97.3) THEN
    RAISE EXCEPTION 'B7b FAIL: no vat_rate_mismatch %', j->'checks';
  END IF;
  j := post_supplier_tax_invoice(inv2, (j->>'revision')::int);
  IF (j->>'receipts_reversed')::int <> 2 OR (j->>'expenses_stamped')::int <> 3 THEN RAISE EXCEPTION 'B7 FAIL: result %', j; END IF;
  j := split_payment(bill2, 100, v_bkk, 'transfer'); g2 := (j->>'remaining_expense_id')::uuid;
  RESET role;
  IF (SELECT count(*) FROM expenses WHERE id IN (bill2, bill3, c3, g2) AND invoice_no = 'DTIB-2') <> 4 THEN RAISE EXCEPTION 'B7 FAIL: not every part stamped'; END IF;
  IF (SELECT invoice_no FROM expenses WHERE id = x_exp) <> 'DTIB-2' OR (SELECT notes FROM expenses WHERE id = x_exp) IS NOT NULL THEN RAISE EXCEPTION 'B7 FAIL: unrelated expense touched'; END IF;
  IF (SELECT invoice_no FROM expenses WHERE id = bill1) <> 'DTIB-1' THEN RAISE EXCEPTION 'B7 FAIL: other invoice bill touched'; END IF;
  IF (SELECT match_diff FROM supplier_tax_invoices WHERE id = inv2) <> 0 THEN RAISE EXCEPTION 'B7 FAIL: match_diff'; END IF;
  SELECT quantity_on_hand, weighted_average_cost INTO v_q, v_w FROM inventory_stock_balances WHERE inventory_item_id = iI AND site_id = t_site;
  IF v_q <> 6.5 OR abs(v_w - 990 / 6.5) > 1e-9 THEN RAISE EXCEPTION 'B7 FAIL: I % @ %', v_q, v_w; END IF;
  SELECT quantity_on_hand, weighted_average_cost INTO v_q, v_w FROM inventory_stock_balances WHERE inventory_item_id = iJ AND site_id = t_site;
  IF v_q <> 5 OR abs(v_w - 200) > 1e-9 THEN RAISE EXCEPTION 'B7 FAIL: J % @ %', v_q, v_w; END IF;
  SET LOCAL role = 'authenticated';

  -- B8 a receipt in a posted invoice cannot be linked again
  BEGIN PERFORM save_supplier_tax_invoice_receipt_draft(NULL, jsonb_set(hdr, '{invoice_no}', '"DTIB-8"'), '[]'::jsonb, ARRAY[rc1]); RAISE EXCEPTION 'B8 FAIL: relinked';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'receipt_linked_elsewhere%' THEN RAISE EXCEPTION 'B8 FAIL: got %', v_msg; END IF; END;

  -- B9 void the 2-lot invoice: exact (nothing moved since), every part restored, the other invoice untouched
  j := void_supplier_tax_invoice(inv2, 'ทดสอบ');
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(j->'warnings') w WHERE w->>'code' IN ('void_inexact', 'expense_changed')) THEN RAISE EXCEPTION 'B9 FAIL: warnings %', j; END IF;
  RESET role;
  IF (SELECT invoice_no FROM expenses WHERE id = bill2) <> 'DN-2' OR (SELECT invoice_no FROM expenses WHERE id = g2) <> 'DN-2'
     OR (SELECT invoice_no FROM expenses WHERE id = bill3) <> 'DN-3' OR (SELECT invoice_no FROM expenses WHERE id = c3) <> 'DN-3' THEN
    RAISE EXCEPTION 'B9 FAIL: restore';
  END IF;
  IF (SELECT invoice_no FROM expenses WHERE id = bill1) <> 'DTIB-1' THEN RAISE EXCEPTION 'B9 FAIL: other invoice restored'; END IF;
  IF (SELECT invoice_no FROM expenses WHERE id = x_exp) <> 'DTIB-2' OR (SELECT notes FROM expenses WHERE id = x_exp) IS NOT NULL THEN RAISE EXCEPTION 'B9 FAIL: unrelated expense touched'; END IF;
  SELECT quantity_on_hand, weighted_average_cost INTO v_q, v_w FROM inventory_stock_balances WHERE inventory_item_id = iI AND site_id = t_site;
  IF v_q <> 6.5 OR abs(v_w - 1000 / 6.5) > 1e-9 THEN RAISE EXCEPTION 'B9 FAIL: I % @ %', v_q, v_w; END IF;
  SELECT quantity_on_hand, weighted_average_cost INTO v_q, v_w FROM inventory_stock_balances WHERE inventory_item_id = iJ AND site_id = t_site;
  IF v_q <> 5 OR abs(v_w - 200) > 1e-9 THEN RAISE EXCEPTION 'B9 FAIL: J % @ %', v_q, v_w; END IF;
  IF EXISTS (SELECT 1 FROM supplier_tax_invoice_receipts WHERE invoice_id = inv2 AND active) OR NOT EXISTS (SELECT 1 FROM supplier_tax_invoice_receipts WHERE invoice_id = inv1 AND active) THEN
    RAISE EXCEPTION 'B9 FAIL: links';
  END IF;
  SET LOCAL role = 'authenticated';

  -- B10 void lot 1's invoice after lot 2 moved the same item: inexact (by formulas), warned, bill restored exactly
  j := void_supplier_tax_invoice(inv1, 'ทดสอบ');
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(j->'warnings') w WHERE w->>'code' = 'void_inexact') THEN RAISE EXCEPTION 'B10 FAIL: expected void_inexact %', j; END IF;
  RESET role;
  SELECT quantity_on_hand, weighted_average_cost INTO v_q, v_w FROM inventory_stock_balances WHERE inventory_item_id = iI AND site_id = t_site;
  IF v_q <> 6 OR abs(v_w - 1000 / 6.0) > 1e-6 THEN RAISE EXCEPTION 'B10 FAIL: I % @ %', v_q, v_w; END IF;
  IF (SELECT invoice_no FROM expenses WHERE id = bill1) <> 'DN-1' THEN RAISE EXCEPTION 'B10 FAIL: bill1'; END IF;
  SET LOCAL role = 'authenticated';

  -- B11 after the void the lot is free again and its original movement is reversed again
  inv4 := save_supplier_tax_invoice_receipt_draft(NULL, jsonb_set(hdr, '{invoice_no}', '"DTIB-4"'),
    jsonb_build_array(jsonb_build_object('description', 'x', 'qty', 1, 'unit_price', 600)), ARRAY[rc1]);
  j := preview_supplier_tax_invoice(inv4);
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(j->'checks') c WHERE (c->>'blocking')::boolean) THEN RAISE EXCEPTION 'B11 FAIL: blocking %', j->'checks'; END IF;
  SELECT x INTO e FROM jsonb_array_elements(j->'rows') x WHERE x->>'inventory_item_id' = iI::text;
  IF (e->>'remove_qty')::numeric <> 2 THEN RAISE EXCEPTION 'B11 FAIL: row %', e; END IF;
  PERFORM delete_supplier_tax_invoice_draft(inv4);
  -- B11b deleting the draft freed the lot: it links again (then that draft is deleted too)
  inv4 := save_supplier_tax_invoice_receipt_draft(NULL, jsonb_set(hdr, '{invoice_no}', '"DTIB-4B"'),
    jsonb_build_array(jsonb_build_object('description', 'x', 'qty', 1, 'unit_price', 600)), ARRAY[rc1]);
  IF (SELECT count(*) FROM supplier_tax_invoice_receipts WHERE invoice_id = inv4 AND receipt_id = rc1 AND active) <> 1 THEN RAISE EXCEPTION 'B11b FAIL: relink'; END IF;
  PERFORM delete_supplier_tax_invoice_draft(inv4);

  -- B12 'po' mode is unchanged (short; the full regression runs separately)
  invP := save_supplier_tax_invoice_draft(NULL, jsonb_build_object('supplier_id', t_sup, 'invoice_no', 'DTIB-P', 'invoice_date', v_bkk, 'net_before_vat', 50, 'vat', 3.5),
    jsonb_build_array(jsonb_build_object('description', 'M', 'qty', 1, 'unit', 'kg', 'unit_price', 50, 'inventory_item_id', iM, 'site_id', t_site, 'base_qty', 1)), ARRAY[poP]);
  j := preview_supplier_tax_invoice(invP);
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(j->'checks') c WHERE (c->>'blocking')::boolean) OR j ? 'basis' THEN RAISE EXCEPTION 'B12 FAIL: preview %', j; END IF;
  j := post_supplier_tax_invoice(invP, (j->>'revision')::int);
  IF (j->>'receipts_reversed')::int <> 1 OR (j->>'expenses_stamped')::int <> 1 THEN RAISE EXCEPTION 'B12 FAIL: post %', j; END IF;
  RESET role; IF (SELECT invoice_no FROM expenses WHERE id = billP) <> 'DTIB-P' THEN RAISE EXCEPTION 'B12 FAIL: stamp'; END IF; SET LOCAL role = 'authenticated';
  PERFORM void_supplier_tax_invoice(invP, 'ทดสอบ');
  RESET role; IF (SELECT invoice_no FROM expenses WHERE id = billP) <> 'DN-P' THEN RAISE EXCEPTION 'B12 FAIL: restore'; END IF; SET LOCAL role = 'authenticated';

  -- B13 a lot of a "stock from invoice" PO: nothing to reverse, the invoice adds stock
  invF := save_supplier_tax_invoice_receipt_draft(NULL, jsonb_build_object('supplier_id', t_sup, 'invoice_no', 'DTIB-F', 'invoice_date', v_bkk, 'net_before_vat', 100, 'vat', 7),
    jsonb_build_array(jsonb_build_object('description', 'I', 'qty', 1, 'unit', 'kg', 'unit_price', 100, 'inventory_item_id', iI, 'site_id', t_site, 'base_qty', 1)), ARRAY[rcF]);
  j := preview_supplier_tax_invoice(invF);
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(j->'checks') c WHERE c->>'code' = 'receipt_stock_from_invoice' AND NOT (c->>'blocking')::boolean AND c->>'receipt_id' = rcF::text) THEN
    RAISE EXCEPTION 'B13 FAIL: checks %', j->'checks';
  END IF;
  j := post_supplier_tax_invoice(invF, (j->>'revision')::int);
  IF (j->>'receipts_reversed')::int <> 0 OR (j->>'lines_posted')::int <> 1 THEN RAISE EXCEPTION 'B13 FAIL: %', j; END IF;

  -- B14 reversal to exactly 0 (WAC kept) and below 0 (allowed, reported)
  PERFORM record_stock_movement(iK, t_site, 'sale_out', 2, 100, 'invoice', NULL, NULL);
  PERFORM record_stock_movement(iL, t_site, 'sale_out', 1, 50, 'invoice', NULL, NULL);
  invK := save_supplier_tax_invoice_receipt_draft(NULL, jsonb_build_object('supplier_id', t_sup, 'invoice_no', 'DTIB-K', 'invoice_date', v_bkk, 'net_before_vat', 200, 'vat', 14, 'match_note', 'ส่งไม่ครบ 1 ชิ้น'),
    jsonb_build_array(jsonb_build_object('description', 'K', 'qty', 2, 'unit', 'kg', 'unit_price', 100, 'inventory_item_id', iK, 'site_id', t_site, 'base_qty', 2)), ARRAY[rcK1]);
  j := preview_supplier_tax_invoice(invK);
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(j->'checks') c WHERE (c->>'blocking')::boolean)
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(j->'checks') c WHERE c->>'code' = 'match_outside_tolerance') THEN RAISE EXCEPTION 'B14 FAIL: K checks %', j->'checks'; END IF;
  j := post_supplier_tax_invoice(invK, (j->>'revision')::int);
  RESET role;
  SELECT quantity_on_hand, weighted_average_cost INTO v_q, v_w FROM inventory_stock_balances WHERE inventory_item_id = iK AND site_id = t_site;
  IF v_q <> 0 OR abs(v_w - 100) > 1e-9 THEN RAISE EXCEPTION 'B14 FAIL: K % @ %', v_q, v_w; END IF;
  SET LOCAL role = 'authenticated';
  invL := save_supplier_tax_invoice_receipt_draft(NULL, jsonb_build_object('supplier_id', t_sup, 'invoice_no', 'DTIB-L', 'invoice_date', v_bkk, 'net_before_vat', 50, 'vat', 3.5),
    jsonb_build_array(jsonb_build_object('description', 'ค่าขนส่ง', 'qty', 1, 'unit_price', 50)), ARRAY[rcK2]);
  j := preview_supplier_tax_invoice(invL);
  SELECT x INTO e FROM jsonb_array_elements(j->'rows') x WHERE x->>'inventory_item_id' = iL::text;
  IF (e->>'after_qty')::numeric <> -1 OR NOT (e->>'negative')::boolean THEN RAISE EXCEPTION 'B14 FAIL: L preview %', e; END IF;
  j := post_supplier_tax_invoice(invL, (j->>'revision')::int);
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(j->'negative') n WHERE n->>'inventory_item_id' = iL::text AND (n->>'qty')::numeric = -1) THEN RAISE EXCEPTION 'B14 FAIL: negative not reported %', j; END IF;

  -- B20 outside tolerance on both bases WITHOUT a note blocks (match_note_required); WITH a note it posts.
  -- rc3 (J 1000 + 70) is free again since B9. Invoice 900 + 63: diff_excl -100, diff_incl -107, tolerance 5.
  itN := jsonb_build_array(jsonb_build_object('description', 'J ส่งไม่ครบ', 'qty', 1, 'unit_price', 900));
  invN := save_supplier_tax_invoice_receipt_draft(NULL, jsonb_build_object('supplier_id', t_sup, 'invoice_no', 'DTIB-N', 'invoice_date', v_bkk, 'net_before_vat', 900, 'vat', 63), itN, ARRAY[rc3]);
  j := preview_supplier_tax_invoice(invN);
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(j->'checks') c WHERE c->>'code' = 'match_note_required' AND (c->>'blocking')::boolean)
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(j->'checks') c WHERE (c->>'blocking')::boolean AND c->>'code' <> 'match_note_required')
     OR j->>'basis' <> 'none' THEN
    RAISE EXCEPTION 'B20 FAIL: no-note checks %', j;
  END IF;
  BEGIN PERFORM post_supplier_tax_invoice(invN, (j->>'revision')::int); RAISE EXCEPTION 'B20 FAIL: posted without a note';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'match_note_required%' THEN RAISE EXCEPTION 'B20 FAIL: got %', v_msg; END IF; END;
  PERFORM save_supplier_tax_invoice_receipt_draft(invN,
    jsonb_build_object('supplier_id', t_sup, 'invoice_no', 'DTIB-N', 'invoice_date', v_bkk, 'net_before_vat', 900, 'vat', 63, 'match_note', 'ส่งไม่ครบ'), itN, ARRAY[rc3]);
  j := preview_supplier_tax_invoice(invN);
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(j->'checks') c WHERE (c->>'blocking')::boolean)
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(j->'checks') c WHERE c->>'code' = 'match_outside_tolerance') THEN
    RAISE EXCEPTION 'B20 FAIL: with-note checks %', j->'checks';
  END IF;
  j := post_supplier_tax_invoice(invN, (j->>'revision')::int);
  IF (j->>'receipts_reversed')::int <> 1 OR (j->>'expenses_stamped')::int <> 2 THEN RAISE EXCEPTION 'B20 FAIL: post %', j; END IF;
  RESET role;
  IF (SELECT count(*) FROM expenses WHERE id IN (bill3, c3) AND invoice_no = 'DTIB-N') <> 2 THEN RAISE EXCEPTION 'B20 FAIL: stamps'; END IF;
  IF (SELECT match_diff FROM supplier_tax_invoices WHERE id = invN) <> -100 THEN RAISE EXCEPTION 'B20 FAIL: match_diff'; END IF;

  -- B21 a stamped bill's number edited by hand after the post: void warns expense_changed (with expense_id) and keeps the hand value
  UPDATE expenses SET invoice_no = 'HAND-1' WHERE id = c3;
  SET LOCAL role = 'authenticated';
  j := void_supplier_tax_invoice(invN, 'ทดสอบ');
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(j->'warnings') w WHERE w->>'code' = 'expense_changed' AND w->>'expense_id' = c3::text) THEN
    RAISE EXCEPTION 'B21 FAIL: warnings %', j;
  END IF;
  RESET role;
  IF (SELECT invoice_no FROM expenses WHERE id = c3) <> 'HAND-1' THEN RAISE EXCEPTION 'B21 FAIL: hand value overwritten'; END IF;
  IF (SELECT invoice_no FROM expenses WHERE id = bill3) <> 'DN-3' THEN RAISE EXCEPTION 'B21 FAIL: bill3 not restored'; END IF;

  -- B22 a lot whose bill was moved off the PO: expense_missing {receipt_id, expense_id} in preview and in the post result;
  -- that bill is not stamped (its split remainder g2 still carries the PO, so it is the one stamped)
  UPDATE expenses SET po_id = NULL WHERE id = bill2;
  SET LOCAL role = 'authenticated';
  invS := save_supplier_tax_invoice_receipt_draft(NULL, jsonb_build_object('supplier_id', t_sup, 'invoice_no', 'DTIB-S', 'invoice_date', v_bkk, 'net_before_vat', 400, 'vat', 28),
    jsonb_build_array(jsonb_build_object('description', 'เหล็ก ล็อต 2', 'qty', 1, 'unit_price', 400)), ARRAY[rc2]);
  j := preview_supplier_tax_invoice(invS);
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(j->'checks') c WHERE (c->>'blocking')::boolean)
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(j->'checks') c WHERE c->>'code' = 'expense_missing' AND NOT (c->>'blocking')::boolean
                      AND c->>'receipt_id' = rc2::text AND c->>'expense_id' = bill2::text) THEN
    RAISE EXCEPTION 'B22 FAIL: preview checks %', j->'checks';
  END IF;
  j := post_supplier_tax_invoice(invS, (j->>'revision')::int);
  IF (j->>'expenses_stamped')::int <> 1
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(j->'checks') c WHERE c->>'code' = 'expense_missing' AND c->>'expense_id' = bill2::text) THEN
    RAISE EXCEPTION 'B22 FAIL: post %', j;
  END IF;
  RESET role;
  IF (SELECT invoice_no FROM expenses WHERE id = bill2) <> 'DN-2' OR (SELECT invoice_no FROM expenses WHERE id = g2) <> 'DTIB-S' THEN RAISE EXCEPTION 'B22 FAIL: stamps'; END IF;
  SET LOCAL role = 'authenticated';

  -- B18 a delivery draft needs at least one lot (client also refuses it)
  BEGIN PERFORM save_supplier_tax_invoice_receipt_draft(NULL, jsonb_set(hdr, '{invoice_no}', '"DTIB-E"'), '[]'::jsonb, '{}'::uuid[]); RAISE EXCEPTION 'B18 FAIL: empty accepted';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'no_receipts%' THEN RAISE EXCEPTION 'B18 FAIL: got %', v_msg; END IF; END;
  BEGIN PERFORM save_supplier_tax_invoice_receipt_draft(NULL, jsonb_set(hdr, '{invoice_no}', '"DTIB-E"'), '[]'::jsonb, ARRAY[NULL::uuid]); RAISE EXCEPTION 'B18 FAIL: null-only accepted';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'no_receipts%' THEN RAISE EXCEPTION 'B18 FAIL: null got %', v_msg; END IF; END;
  -- B19 readiness probe callable by clients
  IF delivery_tax_invoice_ready() IS DISTINCT FROM true THEN RAISE EXCEPTION 'B19 FAIL: probe'; END IF;

  -- B15 role gate
  PERFORM set_config('request.jwt.claims', json_build_object('email', w_email, 'role', 'authenticated')::text, true);
  BEGIN PERFORM save_supplier_tax_invoice_receipt_draft(NULL, hdr, '[]'::jsonb, '{}'::uuid[]); RAISE EXCEPTION 'B15 FAIL: worker allowed';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT; IF v_msg NOT LIKE 'insufficient_privilege%' THEN RAISE EXCEPTION 'B15 FAIL: got %', v_msg; END IF; END;
  PERFORM set_config('request.jwt.claims', json_build_object('email', email, 'role', 'authenticated')::text, true);

  -- B17 grants and search_path
  RESET role;
  IF has_function_privilege('anon', 'save_supplier_tax_invoice_receipt_draft(uuid,jsonb,jsonb,uuid[])', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'save_supplier_tax_invoice_receipt_draft(uuid,jsonb,jsonb,uuid[])', 'EXECUTE')
     OR has_function_privilege('anon', 'post_supplier_tax_invoice(uuid,integer)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'post_supplier_tax_invoice(uuid,integer)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'void_supplier_tax_invoice(uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'save_supplier_tax_invoice_draft(uuid,jsonb,jsonb,uuid[])', 'EXECUTE')
     OR has_function_privilege('authenticated', '_sti_check(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', '_sti_check_po(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', '_sti_check_delivery(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', '_sti_receipt_movements(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', '_sti_receipt_movements_po(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', '_sti_receipt_movements_delivery(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', '_sti_stamp_receipt_bills(uuid,uuid,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'delivery_tax_invoice_ready()', 'EXECUTE') OR NOT has_function_privilege('authenticated', 'delivery_tax_invoice_ready()', 'EXECUTE') THEN
    RAISE EXCEPTION 'B17 FAIL: function privileges';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname IN ('_sti_check', '_sti_check_po', '_sti_check_delivery', '_sti_receipt_movements', '_sti_receipt_movements_po',
               '_sti_receipt_movements_delivery', '_sti_stamp_receipt_bills', 'save_supplier_tax_invoice_receipt_draft', 'save_supplier_tax_invoice_draft',
               'post_supplier_tax_invoice', 'void_supplier_tax_invoice')
             AND (NOT prosecdef OR proconfig IS NULL OR NOT ('search_path=public' = ANY (proconfig)))) THEN
    RAISE EXCEPTION 'B17 FAIL: definer / search_path';
  END IF;

  RAISE EXCEPTION 'RESULT: delivery_tax_invoice_test_b ALL PASSED';
END $$;
ROLLBACK;
