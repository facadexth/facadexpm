-- ================================================================
-- Tests for supplier credit notes (migrations 2026-10-06-01 / -02).
--
-- !!! HAS NOT BEEN RUN AGAINST ANY DATABASE !!!
-- The migrations were unapplied when this was written. Fixture column lists
-- for sites / suppliers / expense_categories are best guesses and may need a
-- tweak on first run. Run only on a database where both migrations are applied.
--
-- Style: a single BEGIN ... ROLLBACK script, so nothing persists even on
-- success. Runs as the `authenticated` role (via request.jwt.claims) on a
-- scratch tenant; each negative check uses a nested BEGIN..EXCEPTION block.
-- ================================================================
BEGIN;

DO $$
DECLARE
  t_owner UUID; t_tenant UUID; t_site UUID; t_sup UUID; t_cat UUID; t_item UUID;
  email TEXT := '__test_scn_owner__@example.com';
  n1 UUID; n2 UUID; n3 UUID; n4 UUID;
  v_exp UUID; v_qty NUMERIC; v_cnt INT; v_msg TEXT; v_state TEXT; v_status TEXT;
BEGIN
  -- ── fixtures (as the connecting superuser) ──
  SELECT id INTO t_owner FROM auth.users ORDER BY created_at ASC LIMIT 1;
  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at)
  VALUES ('__TEST TENANT scn__', t_owner, 'trial', now() + interval '14 days') RETURNING id INTO t_tenant;
  INSERT INTO user_roles (user_email, role, status, tenant_id) VALUES (email, 'OWNER', 'approved', t_tenant);
  INSERT INTO sites (tenant_id, site_number, name) VALUES (t_tenant, '__SCN-1__', '__scn site__') RETURNING id INTO t_site;
  INSERT INTO suppliers (tenant_id, name) VALUES (t_tenant, '__scn supplier__') RETURNING id INTO t_sup;
  INSERT INTO expense_categories (tenant_id, name) VALUES (t_tenant, '__scn cat__') RETURNING id INTO t_cat;
  INSERT INTO inventory_items (tenant_id, name, base_unit) VALUES (t_tenant, '__scn item__', 'kg') RETURNING id INTO t_item;
  INSERT INTO inventory_stock_balances (tenant_id, inventory_item_id, site_id, quantity_on_hand, weighted_average_cost)
  VALUES (t_tenant, t_item, t_site, 10, 100);

  SET LOCAL role = 'authenticated';
  PERFORM set_config('request.jwt.claims', '{"email":"' || email || '"}', true);

  -- helper-free: build drafts inline
  INSERT INTO supplier_credit_notes (supplier_id, site_id, doc_number, doc_date, category_id, amount_no_vat, vat, amount)
  VALUES (t_sup, t_site, 'CN-OVER', current_date, t_cat, 1100, 0, 1100) RETURNING id INTO n1;
  INSERT INTO supplier_credit_note_items (credit_note_id, inventory_item_id, description, quantity, unit, unit_price)
  VALUES (n1, t_item, 'over', 11, 'kg', 100);

  -- Test 1: over-quantity confirm raises insufficient_stock, leaves no stock/expense rows
  BEGIN
    PERFORM confirm_supplier_credit_note(n1);
    RAISE EXCEPTION 'Test 1 FAIL: confirm with over-quantity did not raise';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'insufficient_stock%' THEN RAISE EXCEPTION 'Test 1 FAIL: got %', v_msg; END IF;
  END;
  SELECT quantity_on_hand INTO v_qty FROM inventory_stock_balances WHERE inventory_item_id = t_item AND site_id = t_site;
  SELECT count(*) INTO v_cnt FROM expenses WHERE invoice_no = 'CN-OVER';
  IF v_qty <> 10 OR v_cnt <> 0 THEN RAISE EXCEPTION 'Test 1 FAIL: stock=% expenses=%', v_qty, v_cnt; END IF;
  SELECT count(*) INTO v_cnt FROM stock_movements WHERE reference_id = n1;
  IF v_cnt <> 0 THEN RAISE EXCEPTION 'Test 1 FAIL: stray stock_movements %', v_cnt; END IF;
  RAISE NOTICE 'Test 1 (over-quantity confirm rolls back): PASSED';

  -- Test 2: no items -> no_items
  INSERT INTO supplier_credit_notes (supplier_id, site_id, doc_number, doc_date, category_id, amount_no_vat, vat, amount)
  VALUES (t_sup, t_site, 'CN-EMPTY', current_date, t_cat, 0, 0, 0) RETURNING id INTO n2;
  BEGIN
    PERFORM confirm_supplier_credit_note(n2);
    RAISE EXCEPTION 'Test 2 FAIL: confirm of empty note did not raise';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'no_items%' THEN RAISE EXCEPTION 'Test 2 FAIL: got %', v_msg; END IF;
  END;
  RAISE NOTICE 'Test 2 (no_items): PASSED';

  -- Test 3: valid confirm, then second confirm raises not_draft
  INSERT INTO supplier_credit_notes (supplier_id, site_id, doc_number, doc_date, category_id, amount_no_vat, vat, amount)
  VALUES (t_sup, t_site, 'CN-OK', current_date, t_cat, 400, 0, 400) RETURNING id INTO n3;
  INSERT INTO supplier_credit_note_items (credit_note_id, inventory_item_id, description, quantity, unit, unit_price)
  VALUES (n3, t_item, 'ok', 4, 'kg', 100);
  v_exp := confirm_supplier_credit_note(n3);
  SELECT quantity_on_hand INTO v_qty FROM inventory_stock_balances WHERE inventory_item_id = t_item AND site_id = t_site;
  IF v_qty <> 6 THEN RAISE EXCEPTION 'Test 3 FAIL: expected 6 on hand, got %', v_qty; END IF;
  IF NOT EXISTS (SELECT 1 FROM expenses WHERE id = v_exp AND amount = -400) THEN
    RAISE EXCEPTION 'Test 3 FAIL: negative expense missing';
  END IF;
  BEGIN
    PERFORM confirm_supplier_credit_note(n3);
    RAISE EXCEPTION 'Test 3 FAIL: second confirm did not raise';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'not_draft%' THEN RAISE EXCEPTION 'Test 3 FAIL: got %', v_msg; END IF;
  END;
  RAISE NOTICE 'Test 3 (confirm deducts + books expense; second confirm not_draft): PASSED';

  -- Test 4: client UPDATE of status raises credit_note_locked
  BEGIN
    UPDATE supplier_credit_notes SET status = 'draft' WHERE id = n3;
    RAISE EXCEPTION 'Test 4 FAIL: client status update did not raise';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'credit_note_locked%' THEN RAISE EXCEPTION 'Test 4 FAIL: got %', v_msg; END IF;
  END;
  RAISE NOTICE 'Test 4 (credit_note_locked): PASSED';

  -- Test 5: deleting the note's expense is blocked by the FK (RESTRICT)
  BEGIN
    DELETE FROM expenses WHERE id = v_exp;
    RAISE EXCEPTION 'Test 5 FAIL: expense delete did not raise';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;
  RAISE NOTICE 'Test 5 (expense delete -> FK violation): PASSED';

  -- Test 6: void restores the balance and removes the expense
  PERFORM void_supplier_credit_note(n3);
  SELECT quantity_on_hand INTO v_qty FROM inventory_stock_balances WHERE inventory_item_id = t_item AND site_id = t_site;
  IF v_qty <> 10 THEN RAISE EXCEPTION 'Test 6 FAIL: expected 10 on hand after void, got %', v_qty; END IF;
  IF EXISTS (SELECT 1 FROM expenses WHERE id = v_exp) THEN RAISE EXCEPTION 'Test 6 FAIL: expense still present'; END IF;
  SELECT status INTO v_status FROM supplier_credit_notes WHERE id = n3;
  IF v_status <> 'void' THEN RAISE EXCEPTION 'Test 6 FAIL: status %', v_status; END IF;
  RAISE NOTICE 'Test 6 (void restores stock, removes expense): PASSED';

  -- Test 7: a voided note's doc_number can be reused
  INSERT INTO supplier_credit_notes (supplier_id, site_id, doc_number, doc_date, category_id, amount_no_vat, vat, amount)
  VALUES (t_sup, t_site, 'CN-OK', current_date, t_cat, 100, 0, 100) RETURNING id INTO n4;
  -- ...but an active duplicate is still rejected
  BEGIN
    INSERT INTO supplier_credit_notes (supplier_id, site_id, doc_number, doc_date, category_id, amount_no_vat, vat, amount)
    VALUES (t_sup, t_site, 'CN-OK', current_date, t_cat, 100, 0, 100);
    RAISE EXCEPTION 'Test 7 FAIL: active duplicate doc_number accepted';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;
  RAISE NOTICE 'Test 7 (voided number reusable, active duplicate rejected): PASSED';

  -- Test 8: deleting a draft with items succeeds (items cascade)
  INSERT INTO supplier_credit_note_items (credit_note_id, inventory_item_id, description, quantity, unit, unit_price)
  VALUES (n4, t_item, 'draft item', 1, 'kg', 100);
  DELETE FROM supplier_credit_notes WHERE id = n4;
  SELECT count(*) INTO v_cnt FROM supplier_credit_note_items WHERE credit_note_id = n4;
  IF v_cnt <> 0 OR EXISTS (SELECT 1 FROM supplier_credit_notes WHERE id = n4) THEN
    RAISE EXCEPTION 'Test 8 FAIL: draft or items remain';
  END IF;
  RAISE NOTICE 'Test 8 (delete draft with items): PASSED';

  RESET role;
END $$;

ROLLBACK;
