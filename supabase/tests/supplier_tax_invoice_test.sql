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

  -- ── Part B (Task 3) goes here ──

  RESET role;
  RAISE EXCEPTION 'RESULT: supplier_tax_invoice_test ALL PASSED';
END $$;

ROLLBACK;
