-- ============================================================
-- Supplier tax invoice per delivery: RPCs (migration 05 of 2026-10-09). Requires 2026-10-09-04.
-- Spec: docs/superpowers/specs/2026-10-08-per-delivery-tax-invoice-design.md · Plan: 2026-10-08-per-delivery-tax-invoice-plan.md (Task 4)
-- 'po' mode is unchanged: _sti_check / _sti_receipt_movements bodies move VERBATIM to _sti_check_po / _sti_receipt_movements_po
-- (the old names become dispatchers by link kind); save_supplier_tax_invoice_draft (2026-10-08-02) and post / void
-- (2026-10-09-03, their latest definitions) are re-created verbatim plus marked lines. The verbatim section is generated
-- by the plan's builder script and proved by diff. Same signatures and grants: the deployed client is unaffected.
-- Lock order unchanged: invoice -> PO rows by id -> balances by (item, site) -> expenses by id.
-- ============================================================

SET LOCAL lock_timeout = '5s';

-- ── _sti_check_po: verbatim body of _sti_check (2026-10-08-02 lines 45-147) + 1 marked line ──
CREATE OR REPLACE FUNCTION _sti_check_po(p_id UUID, p_tenant UUID) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  inv supplier_tax_invoices%ROWTYPE;
  v_today DATE := (now() AT TIME ZONE 'Asia/Bangkok')::date;
  c JSONB := '[]'::jsonb;
  p RECORD;
  v_posum NUMERIC := 0; v_lines NUMERIC; v_diff NUMERIC; v_npos INT := 0;
  v_has_moves BOOLEAN;
BEGIN
  SELECT * INTO inv FROM supplier_tax_invoices WHERE id = p_id AND tenant_id = p_tenant;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('checks', jsonb_build_array(jsonb_build_object('code', 'invoice_not_found', 'blocking', true)));
  END IF;
  IF inv.status <> 'draft' THEN c := c || jsonb_build_object('code', 'not_draft', 'blocking', true); END IF;
  IF NOT EXISTS (SELECT 1 FROM supplier_tax_invoice_items WHERE invoice_id = p_id AND tenant_id = p_tenant) THEN
    c := c || jsonb_build_object('code', 'no_items', 'blocking', true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM supplier_tax_invoice_pos WHERE invoice_id = p_id AND tenant_id = p_tenant) THEN
    c := c || jsonb_build_object('code', 'no_pos', 'blocking', true);
  END IF;
  IF inv.invoice_date > v_today THEN c := c || jsonb_build_object('code', 'invoice_date_in_future', 'blocking', true); END IF;

  FOR p IN
    SELECT l.po_id AS link_po, po.id, po.supplier_id, po.status, po.date AS po_date, po.stock_from_invoice, po.expense_id
      FROM supplier_tax_invoice_pos l
      LEFT JOIN purchase_orders po ON po.id = l.po_id AND po.tenant_id = p_tenant
     WHERE l.invoice_id = p_id AND l.tenant_id = p_tenant
     ORDER BY l.po_id
  LOOP
    IF p.id IS NULL THEN
      c := c || jsonb_build_object('code', 'po_not_found', 'blocking', true, 'po_id', p.link_po);
      CONTINUE;
    END IF;
    v_npos := v_npos + 1;
    IF p.supplier_id IS DISTINCT FROM inv.supplier_id THEN c := c || jsonb_build_object('code', 'po_wrong_supplier', 'blocking', true, 'po_id', p.id); END IF;
    IF p.status <> 'received' THEN c := c || jsonb_build_object('code', 'po_not_received', 'blocking', true, 'po_id', p.id); END IF;
    IF EXISTS (SELECT 1 FROM purchase_orders x WHERE x.id = p.id AND x.tax_invoice_mode = 'delivery') THEN c := c || jsonb_build_object('code', 'po_is_delivery_mode', 'blocking', true, 'po_id', p.id); END IF;   -- 2026-10-09-05
    IF EXISTS (SELECT 1 FROM supplier_tax_invoice_pos o WHERE o.po_id = p.id AND o.active AND o.invoice_id <> p_id) THEN
      c := c || jsonb_build_object('code', 'po_linked_elsewhere', 'blocking', true, 'po_id', p.id);
    END IF;
    -- Defence in depth: normally unreachable (a PO's reversals belong to a posted invoice that keeps the PO's
    -- link active, so po_linked_elsewhere fires first). Kept in case a link is ever deactivated by hand.
    IF EXISTS (SELECT 1 FROM supplier_tax_invoice_reversals r JOIN supplier_tax_invoices i ON i.id = r.invoice_id
                WHERE r.po_id = p.id AND i.status = 'posted' AND i.id <> p_id) THEN
      c := c || jsonb_build_object('code', 'po_already_reversed', 'blocking', true, 'po_id', p.id);
    END IF;
    -- warnings (never block)
    IF EXISTS (SELECT 1 FROM supplier_credit_notes cn WHERE cn.po_id = p.id AND cn.tenant_id = p_tenant AND cn.status = 'confirmed') THEN
      c := c || jsonb_build_object('code', 'po_has_credit_note', 'blocking', false, 'po_id', p.id);
    END IF;
    v_has_moves := EXISTS (SELECT 1 FROM stock_movements m WHERE m.tenant_id = p_tenant AND m.reference_type = 'purchase_order'
                             AND m.reference_id = p.id AND m.movement_type = 'purchase_in');
    IF NOT v_has_moves THEN
      c := c || jsonb_build_object('code', CASE WHEN p.stock_from_invoice THEN 'po_stock_from_invoice' ELSE 'po_no_receipt_movements' END,
                                   'blocking', false, 'po_id', p.id);
    ELSIF p.stock_from_invoice THEN
      c := c || jsonb_build_object('code', 'po_stock_flag_but_received_stock', 'blocking', false, 'po_id', p.id);
    END IF;
    IF date_trunc('month', p.po_date) <> date_trunc('month', inv.invoice_date) THEN
      c := c || jsonb_build_object('code', 'po_outside_month', 'blocking', false, 'po_id', p.id);
    END IF;
    IF EXISTS (SELECT 1 FROM po_deposit_applications a WHERE a.po_id = p.id AND a.tenant_id = p_tenant) THEN
      c := c || jsonb_build_object('code', 'po_has_deposit', 'blocking', false, 'po_id', p.id);
    END IF;
    IF p.expense_id IS NULL THEN c := c || jsonb_build_object('code', 'po_no_expense', 'blocking', false, 'po_id', p.id); END IF;
    v_posum := v_posum + COALESCE(_po_goods_subtotal(p.id, p_tenant), 0);
  END LOOP;

  IF EXISTS (SELECT 1 FROM supplier_tax_invoice_items i
              WHERE i.invoice_id = p_id AND i.inventory_item_id IS NOT NULL
                AND (NOT EXISTS (SELECT 1 FROM inventory_items x WHERE x.id = i.inventory_item_id AND x.tenant_id = p_tenant)
                     OR NOT EXISTS (SELECT 1 FROM sites s WHERE s.id = i.site_id AND s.tenant_id = p_tenant))) THEN
    c := c || jsonb_build_object('code', 'stock_line_invalid', 'blocking', true);
  END IF;

  SELECT COALESCE(SUM(amount), 0) INTO v_lines FROM supplier_tax_invoice_items WHERE invoice_id = p_id AND tenant_id = p_tenant;
  -- Non-finite PO data (a PO line total, or a receipt movement's quantity/unit cost) must never reach the maths.
  IF NOT _sti_finite(v_posum)
     OR EXISTS (SELECT 1 FROM _sti_receipt_movements(p_id, p_tenant) r WHERE NOT (_sti_finite(r.quantity) AND _sti_finite(r.unit_cost))) THEN
    c := c || jsonb_build_object('code', 'po_data_not_finite', 'blocking', true);
    RETURN jsonb_build_object('checks', c, 'po_sum', 0, 'diff', 0, 'tolerance', 0, 'lines_sum', 0);
  END IF;
  -- Non-finite invoice totals (NaN/Infinity) are blocked with bad_header.
  IF NOT (_sti_finite(v_lines) AND _sti_finite(inv.net_before_vat)) THEN
    c := c || jsonb_build_object('code', 'bad_header', 'blocking', true);
    RETURN jsonb_build_object('checks', c, 'po_sum', 0, 'diff', 0, 'tolerance', 0, 'lines_sum', 0);
  END IF;
  IF abs(v_lines - inv.net_before_vat) > _sti_tolerance(inv.net_before_vat) + 0.005 THEN
    c := c || jsonb_build_object('code', 'lines_total_mismatch', 'blocking', true, 'detail', round(v_lines, 2)::text);
  END IF;

  v_posum := round(v_posum, 2);
  v_diff := round(inv.net_before_vat - v_posum, 2);
  IF v_npos > 0 AND abs(v_diff) > _sti_tolerance(v_posum) + 0.005 THEN
    IF COALESCE(btrim(inv.match_note), '') = '' THEN
      c := c || jsonb_build_object('code', 'match_note_required', 'blocking', true, 'detail', v_diff::text);
    ELSE
      c := c || jsonb_build_object('code', 'match_outside_tolerance', 'blocking', false, 'detail', v_diff::text);
    END IF;
  END IF;

  RETURN jsonb_build_object('checks', c, 'po_sum', v_posum, 'diff', v_diff, 'tolerance', _sti_tolerance(v_posum), 'lines_sum', round(v_lines, 2));
END $$;

-- ── _sti_receipt_movements_po: verbatim body of _sti_receipt_movements (2026-10-08-02 lines 20-30) ──
CREATE OR REPLACE FUNCTION _sti_receipt_movements_po(p_id UUID, p_tenant UUID)
RETURNS TABLE(po_id UUID, po_number TEXT, movement_id UUID, inventory_item_id UUID, site_id UUID, quantity NUMERIC, unit_cost NUMERIC)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p.id, p.po_number::text, m.id, m.inventory_item_id, m.site_id, m.quantity, COALESCE(m.unit_cost, 0)
    FROM supplier_tax_invoice_pos l
    JOIN purchase_orders p ON p.id = l.po_id AND p.tenant_id = p_tenant
    JOIN stock_movements m ON m.tenant_id = p_tenant AND m.reference_type = 'purchase_order'
                          AND m.reference_id = p.id AND m.movement_type = 'purchase_in'
   WHERE l.invoice_id = p_id AND l.tenant_id = p_tenant
   ORDER BY p.id, m.created_at, m.id
$$;

-- ── save_supplier_tax_invoice_draft: verbatim (2026-10-08-02 lines 150-233) + 2 marked lines ──
CREATE OR REPLACE FUNCTION save_supplier_tax_invoice_draft(p_id UUID, p_header JSONB, p_items JSONB, p_po_ids UUID[])
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tenant UUID := current_tenant_id();
  v_today DATE := (now() AT TIME ZONE 'Asia/Bangkok')::date;
  v_id UUID := p_id;
  v_sup UUID; v_no TEXT; v_date DATE; v_net NUMERIC; v_vat NUMERIC; v_note TEXT; v_status TEXT;
  it JSONB; ord BIGINT;
  v_desc TEXT; v_qty NUMERIC; v_price NUMERIC; v_disc NUMERIC; v_amt NUMERIC; v_item UUID; v_site UUID; v_base NUMERIC;
  v_po UUID; v_psup UUID; v_pstatus TEXT;
BEGIN
  IF NOT (is_admin_or_owner() AND has_module_access('purchase_orders') AND tenant_can_write()) THEN RAISE EXCEPTION 'insufficient_privilege'; END IF;
  BEGIN
    v_sup  := (p_header->>'supplier_id')::uuid;
    v_no   := btrim(p_header->>'invoice_no');
    v_date := (p_header->>'invoice_date')::date;
    v_net  := round((p_header->>'net_before_vat')::numeric, 2);
    v_vat  := round(COALESCE((p_header->>'vat')::numeric, 0), 2);
    v_note := NULLIF(btrim(p_header->>'match_note'), '');
  EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'bad_header';
  END;
  IF v_sup IS NULL OR COALESCE(v_no, '') = '' OR v_date IS NULL OR NOT (_sti_finite(v_net) AND _sti_finite(v_vat)) OR v_net < 0 OR v_vat < 0 THEN
    RAISE EXCEPTION 'bad_header';
  END IF;
  IF v_date > v_today THEN RAISE EXCEPTION 'invoice_date_in_future'; END IF;
  IF NOT EXISTS (SELECT 1 FROM suppliers WHERE id = v_sup AND tenant_id = v_tenant) THEN RAISE EXCEPTION 'cross_tenant_reference'; END IF;
  IF jsonb_typeof(COALESCE(p_items, '[]'::jsonb)) <> 'array' THEN RAISE EXCEPTION 'bad_item'; END IF;

  IF v_id IS NULL THEN
    INSERT INTO supplier_tax_invoices (tenant_id, supplier_id, invoice_no, invoice_date, net_before_vat, vat, grand_total, match_note, created_by)
    VALUES (v_tenant, v_sup, v_no, v_date, v_net, v_vat, round(v_net + v_vat, 2), v_note, auth.email())
    RETURNING id INTO v_id;
  ELSE
    SELECT status INTO v_status FROM supplier_tax_invoices WHERE id = v_id AND tenant_id = v_tenant FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'invoice_not_found'; END IF;
    IF v_status <> 'draft' THEN RAISE EXCEPTION 'not_draft'; END IF;
    UPDATE supplier_tax_invoices
       SET supplier_id = v_sup, invoice_no = v_no, invoice_date = v_date, net_before_vat = v_net, vat = v_vat,
           grand_total = round(v_net + v_vat, 2), match_note = v_note, revision = revision + 1
     WHERE id = v_id;
    DELETE FROM supplier_tax_invoice_items WHERE invoice_id = v_id;
    DELETE FROM supplier_tax_invoice_pos WHERE invoice_id = v_id;
    DELETE FROM supplier_tax_invoice_receipts WHERE invoice_id = v_id;   -- 2026-10-09-05
  END IF;

  FOR it, ord IN SELECT value, ordinality FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) WITH ORDINALITY LOOP
    BEGIN
      v_desc  := btrim(it->>'description');
      v_qty   := (it->>'qty')::numeric;
      v_price := COALESCE((it->>'unit_price')::numeric, 0);
      v_disc  := COALESCE((it->>'discount_pct')::numeric, 0);
      v_item  := NULLIF(it->>'inventory_item_id', '')::uuid;
      v_site  := NULLIF(it->>'site_id', '')::uuid;
      v_base  := NULLIF(it->>'base_qty', '')::numeric;
    EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'bad_item';
    END;
    IF COALESCE(v_desc, '') = '' OR NOT (_sti_finite(v_qty) AND _sti_finite(v_price) AND _sti_finite(v_disc))
       OR (v_base IS NOT NULL AND NOT _sti_finite(v_base))
       OR v_qty <= 0 OR v_price < 0 OR v_disc < 0 OR v_disc > 100 THEN RAISE EXCEPTION 'bad_item'; END IF;
    v_amt := round(v_qty * v_price * (1 - v_disc / 100), 2);
    IF v_item IS NULL THEN
      v_site := NULL; v_base := NULL;
    ELSE
      IF v_site IS NULL OR v_base IS NULL OR v_base <= 0 THEN RAISE EXCEPTION 'stock_line_incomplete'; END IF;
      IF NOT EXISTS (SELECT 1 FROM inventory_items WHERE id = v_item AND tenant_id = v_tenant)
         OR NOT EXISTS (SELECT 1 FROM sites WHERE id = v_site AND tenant_id = v_tenant) THEN
        RAISE EXCEPTION 'cross_tenant_reference';
      END IF;
    END IF;
    INSERT INTO supplier_tax_invoice_items (tenant_id, invoice_id, sort_order, description, qty, unit, unit_price, discount_pct,
                                            amount, inventory_item_id, site_id, base_qty, base_unit_cost)
    VALUES (v_tenant, v_id, ord, v_desc, v_qty, NULLIF(btrim(it->>'unit'), ''), v_price, v_disc,
            v_amt, v_item, v_site, v_base, CASE WHEN v_item IS NULL THEN NULL ELSE v_amt / v_base END);
  END LOOP;

  FOR v_po IN SELECT DISTINCT u FROM unnest(COALESCE(p_po_ids, '{}'::uuid[])) AS u WHERE u IS NOT NULL ORDER BY u LOOP
    SELECT supplier_id, status INTO v_psup, v_pstatus FROM purchase_orders WHERE id = v_po AND tenant_id = v_tenant;
    IF NOT FOUND OR v_psup IS DISTINCT FROM v_sup OR v_pstatus <> 'received' THEN RAISE EXCEPTION 'po_not_eligible'; END IF;
    IF EXISTS (SELECT 1 FROM purchase_orders WHERE id = v_po AND tenant_id = v_tenant AND tax_invoice_mode = 'delivery') THEN RAISE EXCEPTION 'po_is_delivery_mode'; END IF;   -- 2026-10-09-05
    IF EXISTS (SELECT 1 FROM supplier_tax_invoice_pos WHERE po_id = v_po AND active AND invoice_id <> v_id) THEN
      RAISE EXCEPTION 'po_linked_elsewhere';
    END IF;
    INSERT INTO supplier_tax_invoice_pos (tenant_id, invoice_id, po_id) VALUES (v_tenant, v_id, v_po);
  END LOOP;
  RETURN v_id;
END $$;

-- ── post_supplier_tax_invoice: verbatim (2026-10-09-03 lines 103-228) + 2 marked lines ──
CREATE OR REPLACE FUNCTION post_supplier_tax_invoice(p_id UUID, p_expected_revision INT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tenant UUID := current_tenant_id();
  inv supplier_tax_invoices%ROWTYPE;
  v_chk JSONB; v_block TEXT; v_keys JSONB; v_result JSONB; v_created JSONB := '[]'::jsonb;
  v_at TIMESTAMPTZ;
  l RECORD; r RECORD; k RECORD; mv RECORD; rv RECORD;
  v_prev TEXT; v_sub NUMERIC; v_warns JSONB := '[]'::jsonb;
  v_lines INT := 0; v_revs INT := 0; v_stamped INT := 0;
BEGIN
  IF NOT (is_admin_or_owner() AND has_module_access('purchase_orders') AND tenant_can_write()) THEN RAISE EXCEPTION 'insufficient_privilege'; END IF;
  SELECT * INTO inv FROM supplier_tax_invoices WHERE id = p_id AND tenant_id = v_tenant FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'invoice_not_found'; END IF;
  IF inv.status <> 'draft' THEN RAISE EXCEPTION 'not_draft'; END IF;
  -- the draft changed after the preview the user looked at (or no revision was passed)
  IF p_expected_revision IS DISTINCT FROM inv.revision THEN RAISE EXCEPTION 'stale_preview'; END IF;

  -- fixed lock order: invoice -> POs by id -> balances by (item, site)
  PERFORM 1 FROM purchase_orders
   WHERE tenant_id = v_tenant AND id IN (SELECT po_id FROM supplier_tax_invoice_pos WHERE invoice_id = p_id)
   ORDER BY id FOR UPDATE;
  PERFORM 1 FROM purchase_orders WHERE tenant_id = v_tenant AND id IN (SELECT po_id FROM supplier_tax_invoice_receipts WHERE invoice_id = p_id AND tenant_id = v_tenant) ORDER BY id FOR UPDATE;   -- 2026-10-09-05
  SELECT COALESCE(jsonb_agg(jsonb_build_object('item', t.inventory_item_id, 'site', t.site_id)), '[]'::jsonb)
    INTO v_keys FROM _sti_touched_keys(p_id, v_tenant) t;
  -- Make sure every touched (item, site) has a balance row BEFORE locking, in (item, site) order: the locks below then
  -- always land on existing rows (no lost update / deadlock between two posts on a brand-new key). `created` remembers
  -- which rows we made, so the snapshot still says "did not exist" (before 0@0, no stamp) and void restores exactly that.
  WITH ins AS (
    INSERT INTO inventory_stock_balances (tenant_id, inventory_item_id, site_id, quantity_on_hand, weighted_average_cost, updated_at)
    SELECT v_tenant, t.inventory_item_id, t.site_id, 0, 0, now() FROM _sti_touched_keys(p_id, v_tenant) t
     ORDER BY t.inventory_item_id, t.site_id
    ON CONFLICT (inventory_item_id, site_id) DO NOTHING
    RETURNING inventory_item_id, site_id)
  SELECT COALESCE(jsonb_agg(jsonb_build_object('item', ins.inventory_item_id, 'site', ins.site_id)), '[]'::jsonb) INTO v_created FROM ins;
  PERFORM 1 FROM inventory_stock_balances b
   WHERE b.tenant_id = v_tenant
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(v_keys) e
                  WHERE (e->>'item')::uuid = b.inventory_item_id AND (e->>'site')::uuid = b.site_id)
   ORDER BY b.inventory_item_id, b.site_id FOR UPDATE;

  v_chk := _sti_check(p_id, v_tenant);
  SELECT t.e->>'code' INTO v_block
    FROM jsonb_array_elements(v_chk->'checks') WITH ORDINALITY AS t(e, ord)
   WHERE (t.e->>'blocking')::boolean ORDER BY t.ord LIMIT 1;
  IF v_block IS NOT NULL THEN RAISE EXCEPTION '%', v_block; END IF;

  v_at := (inv.invoice_date + time '12:00') AT TIME ZONE 'Asia/Bangkok';   -- ruling A4

  -- Snapshot the pre-post balance of every touched (item, site) so void can restore it exactly (ruling C1).
  -- Void exactness needs: no stock movement on these keys between post and void (else void_inexact).
  INSERT INTO supplier_tax_invoice_snapshots (tenant_id, invoice_id, inventory_item_id, site_id, before_qty, before_wac, before_updated_at)
  SELECT v_tenant, p_id, t.inventory_item_id, t.site_id, COALESCE(b.quantity_on_hand, 0), COALESCE(b.weighted_average_cost, 0),
         CASE WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(v_created) e
                            WHERE (e->>'item')::uuid = t.inventory_item_id AND (e->>'site')::uuid = t.site_id)
              THEN NULL ELSE b.updated_at END
    FROM _sti_touched_keys(p_id, v_tenant) t
    LEFT JOIN inventory_stock_balances b ON b.inventory_item_id = t.inventory_item_id AND b.site_id = t.site_id AND b.tenant_id = v_tenant;

  -- (a) invoice lines first, so the common case never dips below zero
  FOR l IN SELECT * FROM _sti_stock_lines(p_id, v_tenant) LOOP
    SELECT * INTO mv FROM record_stock_movement(l.inventory_item_id, l.site_id, 'purchase_in', l.base_qty, l.base_unit_cost,
                                                'supplier_tax_invoice', p_id, 'ใบกำกับ ' || inv.invoice_no);
    UPDATE stock_movements SET created_at = v_at WHERE id = mv.movement_id AND tenant_id = v_tenant;
    UPDATE supplier_tax_invoice_items SET posted_movement_id = mv.movement_id WHERE id = l.line_id AND tenant_id = v_tenant;
    v_lines := v_lines + 1;
  END LOOP;

  -- (b) reverse the linked POs' real receipts at their original cost
  FOR r IN SELECT * FROM _sti_receipt_movements(p_id, v_tenant) LOOP
    SELECT * INTO rv FROM _stock_receipt_reversal(v_tenant, r.inventory_item_id, r.site_id, r.quantity, r.unit_cost,
      'supplier_tax_invoice', p_id, 'กลับรายการรับเข้า ' || r.po_number || ' (ใบกำกับ ' || inv.invoice_no || ')', v_at);
    INSERT INTO supplier_tax_invoice_reversals (tenant_id, invoice_id, po_id, source_movement_id, reversal_movement_id,
                                                inventory_item_id, site_id, quantity, unit_cost)
    VALUES (v_tenant, p_id, r.po_id, r.movement_id, rv.movement_id, r.inventory_item_id, r.site_id, r.quantity, r.unit_cost);
    v_revs := v_revs + 1;
  END LOOP;

  -- Stamp every touched balance row with a post-unique updated_at, then record the post-post state incl. that stamp.
  UPDATE inventory_stock_balances b SET updated_at = clock_timestamp()
    FROM supplier_tax_invoice_snapshots s
   WHERE s.invoice_id = p_id AND s.tenant_id = v_tenant AND b.tenant_id = v_tenant
     AND b.inventory_item_id = s.inventory_item_id AND b.site_id = s.site_id;
  UPDATE supplier_tax_invoice_snapshots s
     SET after_qty = COALESCE((SELECT b.quantity_on_hand FROM inventory_stock_balances b
                                WHERE b.inventory_item_id = s.inventory_item_id AND b.site_id = s.site_id AND b.tenant_id = v_tenant), 0),
         after_wac = COALESCE((SELECT b.weighted_average_cost FROM inventory_stock_balances b
                                WHERE b.inventory_item_id = s.inventory_item_id AND b.site_id = s.site_id AND b.tenant_id = v_tenant), 0),
         after_updated_at = (SELECT b.updated_at FROM inventory_stock_balances b
                              WHERE b.inventory_item_id = s.inventory_item_id AND b.site_id = s.site_id AND b.tenant_id = v_tenant)
   WHERE s.invoice_id = p_id AND s.tenant_id = v_tenant;

  -- (c) stamp the invoice number on each PO's expense; amounts untouched (ruling A6)
  FOR k IN SELECT l2.id AS link_id, p.id AS po_id, p.expense_id
             FROM supplier_tax_invoice_pos l2 JOIN purchase_orders p ON p.id = l2.po_id AND p.tenant_id = v_tenant
            WHERE l2.invoice_id = p_id ORDER BY p.id LOOP
    v_sub := _po_goods_subtotal(k.po_id, v_tenant);
    UPDATE supplier_tax_invoice_pos SET po_subtotal = v_sub WHERE id = k.link_id;
    IF k.expense_id IS NOT NULL THEN
      SELECT invoice_no INTO v_prev FROM expenses WHERE id = k.expense_id AND tenant_id = v_tenant FOR UPDATE;
      IF FOUND THEN
        UPDATE expenses
           SET invoice_no = inv.invoice_no,
               notes = concat_ws(' | ', NULLIF(btrim(notes), ''),
                         'ใบกำกับภาษี ' || inv.invoice_no || ' (เลขเดิม: ' || COALESCE(NULLIF(btrim(v_prev), ''), '-') || ')')
         WHERE id = k.expense_id AND tenant_id = v_tenant;
        UPDATE supplier_tax_invoice_pos
           SET expense_id = k.expense_id, prev_invoice_no = v_prev, stamped_invoice_no = inv.invoice_no
         WHERE id = k.link_id;
        v_stamped := v_stamped + 1;
      ELSE
        -- the PO points at an expense that no longer exists: say so instead of silently skipping
        v_warns := v_warns || jsonb_build_object('code', 'expense_missing', 'blocking', false, 'po_id', k.po_id);
      END IF;
    END IF;
  END LOOP;
  v_stamped := v_stamped + _sti_stamp_other_bills(p_id, v_tenant, inv.invoice_no);   -- 2026-10-09-03
  v_stamped := v_stamped + _sti_stamp_receipt_bills(p_id, v_tenant, inv.invoice_no);   -- 2026-10-09-05

  v_result := jsonb_build_object(
    'lines_posted', v_lines, 'receipts_reversed', v_revs, 'expenses_stamped', v_stamped,
    'po_sum', v_chk->'po_sum', 'diff', v_chk->'diff', 'checks', (v_chk->'checks') || v_warns,
    'negative', _sti_negatives(v_tenant, v_keys));
  UPDATE supplier_tax_invoices
     SET status = 'posted', posted_at = now(), posted_by = auth.email(), match_diff = (v_chk->>'diff')::numeric, post_result = v_result
   WHERE id = p_id;
  RETURN v_result;
END $$;

-- ── void_supplier_tax_invoice: verbatim (2026-10-09-03 lines 231-317) + 2 marked lines ──
CREATE OR REPLACE FUNCTION void_supplier_tax_invoice(p_id UUID, p_reason TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tenant UUID := current_tenant_id();
  inv supplier_tax_invoices%ROWTYPE;
  v_keys JSONB; v_warn JSONB := '[]'::jsonb; v_exact JSONB := '[]'::jsonb;
  r RECORD; m RECORD; k RECORD; mv RECORD; sn RECORD; q NUMERIC; w NUMERIC; u TIMESTAMPTZ;
BEGIN
  IF NOT (is_admin_or_owner() AND has_module_access('purchase_orders') AND tenant_can_write()) THEN RAISE EXCEPTION 'insufficient_privilege'; END IF;
  IF COALESCE(btrim(p_reason), '') = '' THEN RAISE EXCEPTION 'void_reason_required'; END IF;
  SELECT * INTO inv FROM supplier_tax_invoices WHERE id = p_id AND tenant_id = v_tenant FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'invoice_not_found'; END IF;
  IF inv.status <> 'posted' THEN RAISE EXCEPTION 'not_posted'; END IF;

  PERFORM 1 FROM purchase_orders
   WHERE tenant_id = v_tenant AND id IN (SELECT po_id FROM supplier_tax_invoice_pos WHERE invoice_id = p_id)
   ORDER BY id FOR UPDATE;
  PERFORM 1 FROM purchase_orders WHERE tenant_id = v_tenant AND id IN (SELECT po_id FROM supplier_tax_invoice_receipts WHERE invoice_id = p_id AND tenant_id = v_tenant) ORDER BY id FOR UPDATE;   -- 2026-10-09-05
  SELECT COALESCE(jsonb_agg(jsonb_build_object('item', x.inventory_item_id, 'site', x.site_id)), '[]'::jsonb) INTO v_keys
    FROM (SELECT inventory_item_id, site_id FROM supplier_tax_invoice_reversals WHERE invoice_id = p_id AND tenant_id = v_tenant
          UNION
          SELECT inventory_item_id, site_id FROM supplier_tax_invoice_items
           WHERE invoice_id = p_id AND tenant_id = v_tenant AND posted_movement_id IS NOT NULL) x;
  PERFORM 1 FROM inventory_stock_balances b
   WHERE b.tenant_id = v_tenant AND EXISTS (SELECT 1 FROM jsonb_array_elements(v_keys) e
                  WHERE (e->>'item')::uuid = b.inventory_item_id AND (e->>'site')::uuid = b.site_id)
   ORDER BY b.inventory_item_id, b.site_id FOR UPDATE;

  -- Exactness (ruling C1): a key whose balance still equals the post-post snapshot is restored to the pre-post
  -- snapshot after the compensating movements are written. A key that moved since is voided by the formulas
  -- and reported as void_inexact (never blocks).
  FOR sn IN SELECT * FROM supplier_tax_invoice_snapshots WHERE invoice_id = p_id AND tenant_id = v_tenant
             ORDER BY inventory_item_id, site_id LOOP
    SELECT quantity_on_hand, weighted_average_cost, updated_at INTO q, w, u FROM inventory_stock_balances
     WHERE inventory_item_id = sn.inventory_item_id AND site_id = sn.site_id AND tenant_id = v_tenant;
    IF NOT FOUND THEN q := 0; w := 0; u := NULL; END IF;
    -- exact only if nothing touched the balance since post: numbers AND the post-unique stamp must match
    IF sn.after_qty IS NOT NULL AND q = sn.after_qty AND w = sn.after_wac AND u IS NOT DISTINCT FROM sn.after_updated_at THEN
      v_exact := v_exact || jsonb_build_object('item', sn.inventory_item_id, 'site', sn.site_id);
    ELSE
      v_warn := v_warn || jsonb_build_object('code', 'void_inexact', 'blocking', false, 'inventory_item_id', sn.inventory_item_id, 'site_id', sn.site_id);
    END IF;
  END LOOP;

  -- (1) put the PO receipts back at their original cost, newest reversal first
  FOR r IN SELECT * FROM supplier_tax_invoice_reversals WHERE invoice_id = p_id AND tenant_id = v_tenant ORDER BY seq DESC LOOP
    SELECT * INTO mv FROM record_stock_movement(r.inventory_item_id, r.site_id, 'purchase_in', r.quantity, r.unit_cost,
                                                'supplier_tax_invoice_void', p_id, 'ยกเลิกใบกำกับ ' || inv.invoice_no || ' (คืนรับเข้าใบสั่งซื้อ)');
    UPDATE supplier_tax_invoice_reversals SET restored_movement_id = mv.movement_id WHERE id = r.id;
  END LOOP;

  -- (2) take the invoice lines back out (exact inverse)
  -- BY THE MOVEMENT IDS post stored on the lines (a hand-made movement carrying the invoice reference is never touched)
  FOR m IN SELECT sm.id, sm.inventory_item_id, sm.site_id, sm.quantity, sm.unit_cost
             FROM supplier_tax_invoice_items i
             JOIN stock_movements sm ON sm.id = i.posted_movement_id AND sm.tenant_id = v_tenant
            WHERE i.invoice_id = p_id AND i.tenant_id = v_tenant
            ORDER BY sm.created_at DESC, sm.id DESC LOOP
    PERFORM _stock_receipt_reversal(v_tenant, m.inventory_item_id, m.site_id, m.quantity, m.unit_cost,
                                    'supplier_tax_invoice_void', p_id, 'ยกเลิกใบกำกับ ' || inv.invoice_no, now());
  END LOOP;

  UPDATE inventory_stock_balances b
     SET quantity_on_hand = s.before_qty, weighted_average_cost = s.before_wac, updated_at = COALESCE(s.before_updated_at, now())
    FROM supplier_tax_invoice_snapshots s
   WHERE s.invoice_id = p_id AND s.tenant_id = v_tenant AND b.tenant_id = v_tenant
     AND b.inventory_item_id = s.inventory_item_id AND b.site_id = s.site_id
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(v_exact) e
                  WHERE (e->>'item')::uuid = s.inventory_item_id AND (e->>'site')::uuid = s.site_id);

  -- (3) restore expense numbers only where still ours (ruling A6)
  FOR k IN SELECT * FROM supplier_tax_invoice_pos
            WHERE invoice_id = p_id AND tenant_id = v_tenant AND expense_id IS NOT NULL AND stamped_invoice_no IS NOT NULL
            ORDER BY po_id LOOP
    UPDATE expenses
       SET invoice_no = k.prev_invoice_no,
           notes = concat_ws(' | ', NULLIF(btrim(notes), ''), 'ยกเลิกใบกำกับภาษี ' || inv.invoice_no)
     WHERE id = k.expense_id AND tenant_id = v_tenant AND invoice_no IS NOT DISTINCT FROM k.stamped_invoice_no;
    IF NOT FOUND THEN v_warn := v_warn || jsonb_build_object('code', 'expense_changed', 'blocking', false, 'po_id', k.po_id); END IF;
  END LOOP;
  v_warn := v_warn || _sti_unstamp_other_bills(p_id, v_tenant, inv.invoice_no);   -- 2026-10-09-03

  UPDATE supplier_tax_invoice_pos SET active = false WHERE invoice_id = p_id AND tenant_id = v_tenant;
  UPDATE supplier_tax_invoice_receipts SET active = false WHERE invoice_id = p_id AND tenant_id = v_tenant;   -- 2026-10-09-05
  UPDATE supplier_tax_invoices
     SET status = 'void', voided_at = now(), voided_by = auth.email(), void_reason = btrim(p_reason)
   WHERE id = p_id;
  RETURN jsonb_build_object('warnings', v_warn, 'negative', _sti_negatives(v_tenant, v_keys));
END $$;

-- ── delivery check (mirrored by evaluateDeliveryMatch in src/lib/deliveryTaxInvoice.js) ──
-- Same header checks, line checks and output keys as _sti_check_po, plus sum_incl / diff_excl / diff_incl / basis.
-- Match: invoice net vs Σ goods_subtotal; else invoice total vs Σ(goods_subtotal + goods_vat) (supplier documents mix both bases).
CREATE OR REPLACE FUNCTION _sti_check_delivery(p_id UUID, p_tenant UUID) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  inv supplier_tax_invoices%ROWTYPE;
  v_today DATE := (now() AT TIME ZONE 'Asia/Bangkok')::date;
  c JSONB := '[]'::jsonb;
  rc RECORD; v_no TEXT; v_ref JSONB;
  v_sum NUMERIC := 0; v_vat NUMERIC := 0; v_sumi NUMERIC; v_lines NUMERIC; v_dex NUMERIC; v_din NUMERIC; v_n INT := 0;
  v_basis TEXT; v_diff NUMERIC; v_tol NUMERIC; v_vexp NUMERIC;
BEGIN
  SELECT * INTO inv FROM supplier_tax_invoices WHERE id = p_id AND tenant_id = p_tenant;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('checks', jsonb_build_array(jsonb_build_object('code', 'invoice_not_found', 'blocking', true)));
  END IF;
  IF inv.status <> 'draft' THEN c := c || jsonb_build_object('code', 'not_draft', 'blocking', true); END IF;
  IF NOT EXISTS (SELECT 1 FROM supplier_tax_invoice_items WHERE invoice_id = p_id AND tenant_id = p_tenant) THEN
    c := c || jsonb_build_object('code', 'no_items', 'blocking', true);
  END IF;
  IF inv.invoice_date > v_today THEN c := c || jsonb_build_object('code', 'invoice_date_in_future', 'blocking', true); END IF;

  FOR rc IN
    SELECT l.receipt_id AS link_rc, r.id, r.seq, r.received_date, r.goods_subtotal, r.goods_vat, r.expense_id,
           po.id AS po_id, po.po_number, po.supplier_id, po.tax_invoice_mode, po.stock_from_invoice
      FROM supplier_tax_invoice_receipts l
      LEFT JOIN po_receipts r ON r.id = l.receipt_id AND r.tenant_id = p_tenant
      LEFT JOIN purchase_orders po ON po.id = r.po_id AND po.tenant_id = p_tenant
     WHERE l.invoice_id = p_id AND l.tenant_id = p_tenant
     ORDER BY l.receipt_id
  LOOP
    IF rc.id IS NULL OR rc.po_id IS NULL THEN
      c := c || jsonb_build_object('code', 'receipt_not_found', 'blocking', true, 'receipt_id', rc.link_rc);
      CONTINUE;
    END IF;
    v_n := v_n + 1;
    v_no := rc.po_number || '-R' || rc.seq;
    v_ref := jsonb_build_object('po_id', rc.po_id, 'receipt_id', rc.id, 'receipt_no', v_no);
    IF rc.supplier_id IS DISTINCT FROM inv.supplier_id THEN c := c || (jsonb_build_object('code', 'receipt_wrong_supplier', 'blocking', true) || v_ref); END IF;
    IF rc.tax_invoice_mode IS DISTINCT FROM 'delivery' THEN c := c || (jsonb_build_object('code', 'receipt_po_not_delivery', 'blocking', true) || v_ref); END IF;
    IF EXISTS (SELECT 1 FROM supplier_tax_invoice_receipts o WHERE o.receipt_id = rc.id AND o.active AND o.invoice_id <> p_id) THEN
      c := c || (jsonb_build_object('code', 'receipt_linked_elsewhere', 'blocking', true) || v_ref);
    END IF;
    -- defence in depth (normally unreachable: a posted invoice keeps its receipt link active)
    IF EXISTS (SELECT 1 FROM supplier_tax_invoice_reversals v JOIN supplier_tax_invoices i ON i.id = v.invoice_id
                 JOIN po_receipt_items pri ON pri.stock_movement_id = v.source_movement_id
                WHERE pri.receipt_id = rc.id AND i.status = 'posted' AND i.id <> p_id) THEN
      c := c || (jsonb_build_object('code', 'receipt_already_reversed', 'blocking', true) || v_ref);
    END IF;
    -- warnings (never block)
    IF EXISTS (SELECT 1 FROM supplier_credit_notes cn WHERE cn.po_id = rc.po_id AND cn.tenant_id = p_tenant AND cn.status = 'confirmed') THEN
      c := c || (jsonb_build_object('code', 'po_has_credit_note', 'blocking', false) || v_ref);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM po_receipt_items i WHERE i.receipt_id = rc.id AND i.tenant_id = p_tenant AND i.stock_movement_id IS NOT NULL) THEN
      c := c || (jsonb_build_object('code', CASE WHEN rc.stock_from_invoice THEN 'receipt_stock_from_invoice' ELSE 'receipt_no_stock_movements' END, 'blocking', false) || v_ref);
    END IF;
    IF date_trunc('month', rc.received_date) <> date_trunc('month', inv.invoice_date) THEN
      c := c || (jsonb_build_object('code', 'receipt_outside_month', 'blocking', false) || v_ref);
    END IF;
    IF EXISTS (SELECT 1 FROM po_deposit_applications a WHERE a.receipt_id = rc.id AND a.tenant_id = p_tenant) THEN
      c := c || (jsonb_build_object('code', 'receipt_has_deposit', 'blocking', false) || v_ref);
    END IF;
    IF rc.expense_id IS NULL THEN c := c || (jsonb_build_object('code', 'receipt_no_expense', 'blocking', false) || v_ref); END IF;
    -- the receipt names a bill that _sti_stamp_receipt_bills will not stamp (deleted, moved off the PO, or a
    -- deposit / credit-note row): same condition as that function's tree root. Reported here so preview and
    -- post_result both carry it (post's body is verbatim and only adds the stamp count).
    IF rc.expense_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM expenses e WHERE e.id = rc.expense_id AND e.tenant_id = p_tenant AND e.po_id = rc.po_id
                         AND NOT EXISTS (SELECT 1 FROM supplier_deposits sd WHERE sd.expense_id = e.id)
                         AND NOT EXISTS (SELECT 1 FROM supplier_credit_notes cn WHERE cn.expense_id = e.id)) THEN
      c := c || (jsonb_build_object('code', 'expense_missing', 'blocking', false, 'expense_id', rc.expense_id) || v_ref);
    END IF;
    v_sum := v_sum + COALESCE(rc.goods_subtotal, 0);
    v_vat := v_vat + COALESCE(rc.goods_vat, 0);
  END LOOP;

  IF EXISTS (SELECT 1 FROM supplier_tax_invoice_items i
              WHERE i.invoice_id = p_id AND i.inventory_item_id IS NOT NULL
                AND (NOT EXISTS (SELECT 1 FROM inventory_items x WHERE x.id = i.inventory_item_id AND x.tenant_id = p_tenant)
                     OR NOT EXISTS (SELECT 1 FROM sites s WHERE s.id = i.site_id AND s.tenant_id = p_tenant))) THEN
    c := c || jsonb_build_object('code', 'stock_line_invalid', 'blocking', true);
  END IF;

  SELECT COALESCE(SUM(amount), 0) INTO v_lines FROM supplier_tax_invoice_items WHERE invoice_id = p_id AND tenant_id = p_tenant;
  IF NOT (_sti_finite(v_sum) AND _sti_finite(v_vat))
     OR EXISTS (SELECT 1 FROM _sti_receipt_movements(p_id, p_tenant) r WHERE NOT (_sti_finite(r.quantity) AND _sti_finite(r.unit_cost))) THEN
    c := c || jsonb_build_object('code', 'po_data_not_finite', 'blocking', true);
    RETURN jsonb_build_object('checks', c, 'po_sum', 0, 'diff', 0, 'tolerance', 0, 'lines_sum', 0);
  END IF;
  IF NOT (_sti_finite(v_lines) AND _sti_finite(inv.net_before_vat) AND _sti_finite(inv.grand_total)) THEN
    c := c || jsonb_build_object('code', 'bad_header', 'blocking', true);
    RETURN jsonb_build_object('checks', c, 'po_sum', 0, 'diff', 0, 'tolerance', 0, 'lines_sum', 0);
  END IF;
  IF abs(v_lines - inv.net_before_vat) > _sti_tolerance(inv.net_before_vat) + 0.005 THEN
    c := c || jsonb_build_object('code', 'lines_total_mismatch', 'blocking', true, 'detail', round(v_lines, 2)::text);
  END IF;
  -- header VAT vs 7% of the header net, beyond max(1 baht, 1% of that 7%): a typo or a wrong rate (warning only).
  -- Skipped when neither the invoice nor the linked receipts carry any VAT (a non-VAT supplier).
  v_vexp := round(inv.net_before_vat * 0.07, 2);
  IF (inv.vat <> 0 OR v_vat <> 0) AND abs(inv.vat - v_vexp) > GREATEST(1, abs(v_vexp) * 0.01) THEN
    c := c || jsonb_build_object('code', 'vat_rate_mismatch', 'blocking', false, 'detail', v_vexp::text);
  END IF;

  v_sumi := round(v_sum + v_vat, 2);
  v_sum := round(v_sum, 2);
  v_dex := round(inv.net_before_vat - v_sum, 2);
  v_din := round(inv.grand_total - v_sumi, 2);
  IF abs(v_dex) <= _sti_tolerance(v_sum) + 0.005 THEN
    v_basis := 'excl'; v_diff := v_dex; v_tol := _sti_tolerance(v_sum);
  ELSIF abs(v_din) <= _sti_tolerance(v_sumi) + 0.005 THEN
    v_basis := 'incl'; v_diff := v_din; v_tol := _sti_tolerance(v_sumi);
    -- detail = the ex-VAT difference the user would otherwise not see (the matched incl. difference is diff/diff_incl)
    c := c || jsonb_build_object('code', 'match_vat_inclusive', 'blocking', false, 'detail', v_dex::text);
  ELSE
    v_basis := 'none'; v_diff := v_dex; v_tol := _sti_tolerance(v_sum);
    IF v_n > 0 THEN
      IF COALESCE(btrim(inv.match_note), '') = '' THEN
        c := c || jsonb_build_object('code', 'match_note_required', 'blocking', true, 'detail', v_dex::text);
      ELSE
        c := c || jsonb_build_object('code', 'match_outside_tolerance', 'blocking', false, 'detail', v_dex::text);
      END IF;
    END IF;
  END IF;

  RETURN jsonb_build_object('checks', c, 'po_sum', v_sum, 'diff', v_diff, 'tolerance', v_tol, 'lines_sum', round(v_lines, 2),
                            'sum_incl', v_sumi, 'diff_excl', v_dex, 'diff_incl', v_din, 'basis', v_basis);
END $$;

-- ── dispatcher: an invoice with receipt links is checked by _sti_check_delivery, every other invoice exactly as before ──
CREATE OR REPLACE FUNCTION _sti_check(p_id UUID, p_tenant UUID) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v JSONB; v_r BOOLEAN; v_p BOOLEAN;
BEGIN
  v_r := EXISTS (SELECT 1 FROM supplier_tax_invoice_receipts WHERE invoice_id = p_id AND tenant_id = p_tenant);
  v_p := EXISTS (SELECT 1 FROM supplier_tax_invoice_pos WHERE invoice_id = p_id AND tenant_id = p_tenant);
  IF v_r THEN v := _sti_check_delivery(p_id, p_tenant); ELSE v := _sti_check_po(p_id, p_tenant); END IF;
  -- defence in depth (sti_link_kind_guard prevents it): mixed links block first
  IF v_r AND v_p THEN
    v := jsonb_set(v, '{checks}', jsonb_build_array(jsonb_build_object('code', 'invoice_mixed_links', 'blocking', true)) || (v->'checks'));
  END IF;
  RETURN v;
END $$;

-- ── the linked receipts' real stock movements (po_receipt_items.stock_movement_id), in reversal order ──
-- po_number carries the receipt number (PO-R<n>) so post's reversal note names the lot.
CREATE OR REPLACE FUNCTION _sti_receipt_movements_delivery(p_id UUID, p_tenant UUID)
RETURNS TABLE(po_id UUID, po_number TEXT, movement_id UUID, inventory_item_id UUID, site_id UUID, quantity NUMERIC, unit_cost NUMERIC)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT r.po_id, (p.po_number || '-R' || r.seq)::text, m.id, m.inventory_item_id, m.site_id, m.quantity, COALESCE(m.unit_cost, 0)
    FROM supplier_tax_invoice_receipts l
    JOIN po_receipts r ON r.id = l.receipt_id AND r.tenant_id = p_tenant
    JOIN purchase_orders p ON p.id = r.po_id AND p.tenant_id = p_tenant
    JOIN po_receipt_items i ON i.receipt_id = r.id AND i.tenant_id = p_tenant AND i.stock_movement_id IS NOT NULL
    JOIN stock_movements m ON m.id = i.stock_movement_id AND m.tenant_id = p_tenant AND m.movement_type = 'purchase_in'
   WHERE l.invoice_id = p_id AND l.tenant_id = p_tenant
   ORDER BY p.id, m.created_at, m.id
$$;

CREATE OR REPLACE FUNCTION _sti_receipt_movements(p_id UUID, p_tenant UUID)
RETURNS TABLE(po_id UUID, po_number TEXT, movement_id UUID, inventory_item_id UUID, site_id UUID, quantity NUMERIC, unit_cost NUMERIC)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM supplier_tax_invoice_receipts x WHERE x.invoice_id = p_id AND x.tenant_id = p_tenant) THEN
    RETURN QUERY SELECT * FROM _sti_receipt_movements_delivery(p_id, p_tenant);
  ELSE
    RETURN QUERY SELECT * FROM _sti_receipt_movements_po(p_id, p_tenant);
  END IF;
END $$;

-- ── receipt draft: header + items through the PO-mode save (same validation; it also clears this draft's links), then receipts ──
CREATE OR REPLACE FUNCTION save_supplier_tax_invoice_receipt_draft(p_id UUID, p_header JSONB, p_items JSONB, p_receipt_ids UUID[])
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tenant UUID := current_tenant_id();
  v_id UUID; v_sup UUID; v_rc UUID; rec RECORD;
BEGIN
  IF NOT (is_admin_or_owner() AND has_module_access('purchase_orders') AND tenant_can_write()) THEN RAISE EXCEPTION 'insufficient_privilege'; END IF;
  -- a delivery draft always has at least one lot (an empty one would reopen as a PO draft)
  IF NOT EXISTS (SELECT 1 FROM unnest(COALESCE(p_receipt_ids, '{}'::uuid[])) AS u WHERE u IS NOT NULL) THEN RAISE EXCEPTION 'no_receipts'; END IF;
  v_id := save_supplier_tax_invoice_draft(p_id, p_header, p_items, '{}'::uuid[]);
  SELECT supplier_id INTO v_sup FROM supplier_tax_invoices WHERE id = v_id AND tenant_id = v_tenant;
  FOR v_rc IN SELECT DISTINCT u FROM unnest(COALESCE(p_receipt_ids, '{}'::uuid[])) AS u WHERE u IS NOT NULL ORDER BY u LOOP
    SELECT r.id, r.po_id, po.supplier_id, po.tax_invoice_mode INTO rec
      FROM po_receipts r JOIN purchase_orders po ON po.id = r.po_id AND po.tenant_id = v_tenant
     WHERE r.id = v_rc AND r.tenant_id = v_tenant;
    IF NOT FOUND OR rec.supplier_id IS DISTINCT FROM v_sup OR rec.tax_invoice_mode IS DISTINCT FROM 'delivery' THEN RAISE EXCEPTION 'receipt_not_eligible'; END IF;
    IF EXISTS (SELECT 1 FROM supplier_tax_invoice_receipts WHERE receipt_id = v_rc AND active AND invoice_id <> v_id) THEN
      RAISE EXCEPTION 'receipt_linked_elsewhere';
    END IF;
    BEGIN
      INSERT INTO supplier_tax_invoice_receipts (tenant_id, invoice_id, receipt_id, po_id) VALUES (v_tenant, v_id, v_rc, rec.po_id);
    EXCEPTION WHEN unique_violation THEN
      -- two drafts saving the same lot at once: the loser gets the same code as the pre-check above
      RAISE EXCEPTION 'receipt_linked_elsewhere';
    END;
  END LOOP;
  RETURN v_id;
END $$;

-- Web readiness probe: exists only once this migration is live (the web keys every new choice on it, not on 04's table).
CREATE OR REPLACE FUNCTION delivery_tax_invoice_ready() RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$ SELECT true $$;

-- ── post step (c) for receipts: snapshot the matched values, stamp each linked receipt's bill and its split parts ──
-- Only that receipt's bill tree (expense_splits) still carrying the PO; deposit and credit-note rows are never bills.
-- Rows go to supplier_tax_invoice_expense_stamps, so _sti_unstamp_other_bills (void) restores them unchanged,
-- including parts split off AFTER the post. Expenses are locked in id order (after the balances).
-- A linked receipt whose bill this skips (deleted / moved off the PO / deposit / credit note) is reported by
-- _sti_check_delivery as the warning expense_missing {receipt_id, expense_id} (same root condition), which post
-- carries into post_result.checks: post's verbatim body only adds this function's INT count.
CREATE OR REPLACE FUNCTION _sti_stamp_receipt_bills(p_id UUID, p_tenant UUID, p_invoice_no TEXT) RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE k RECORD; v_n INT := 0;
BEGIN
  UPDATE supplier_tax_invoice_receipts l
     SET goods_subtotal = r.goods_subtotal, goods_vat = r.goods_vat
    FROM po_receipts r
   WHERE l.invoice_id = p_id AND l.tenant_id = p_tenant AND r.id = l.receipt_id AND r.tenant_id = p_tenant;
  FOR k IN
    WITH RECURSIVE tree AS (
      SELECT r.expense_id, r.po_id
        FROM supplier_tax_invoice_receipts l JOIN po_receipts r ON r.id = l.receipt_id AND r.tenant_id = p_tenant
       WHERE l.invoice_id = p_id AND l.tenant_id = p_tenant AND r.expense_id IS NOT NULL
      UNION
      SELECT s.new_expense_id, t.po_id
        FROM expense_splits s JOIN tree t ON s.source_expense_id = t.expense_id
       WHERE s.tenant_id = p_tenant)
    SELECT e.id, e.invoice_no, t.po_id
      FROM tree t JOIN expenses e ON e.id = t.expense_id AND e.tenant_id = p_tenant AND e.po_id = t.po_id
     WHERE NOT EXISTS (SELECT 1 FROM supplier_deposits sd WHERE sd.expense_id = e.id)
       AND NOT EXISTS (SELECT 1 FROM supplier_credit_notes cn WHERE cn.expense_id = e.id)
     ORDER BY e.id
     FOR UPDATE OF e
  LOOP
    UPDATE expenses
       SET invoice_no = p_invoice_no,
           notes = concat_ws(' | ', NULLIF(btrim(notes), ''),
                     'ใบกำกับภาษี ' || p_invoice_no || ' (เลขเดิม: ' || COALESCE(NULLIF(btrim(k.invoice_no), ''), '-') || ')')
     WHERE id = k.id;
    INSERT INTO supplier_tax_invoice_expense_stamps (tenant_id, invoice_id, po_id, expense_id, prev_invoice_no, stamped_invoice_no)
    VALUES (p_tenant, p_id, k.po_id, k.id, k.invoice_no, p_invoice_no);
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END $$;

-- receipt_already_reversed (_sti_check_delivery) looks reversals up by their source movement
CREATE INDEX idx_stir_source_movement ON supplier_tax_invoice_reversals(source_movement_id);

REVOKE ALL ON FUNCTION _sti_check_po(UUID, UUID), _sti_check_delivery(UUID, UUID), _sti_check(UUID, UUID),
  _sti_receipt_movements_po(UUID, UUID), _sti_receipt_movements_delivery(UUID, UUID), _sti_receipt_movements(UUID, UUID),
  _sti_stamp_receipt_bills(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION save_supplier_tax_invoice_draft(UUID, JSONB, JSONB, UUID[]), save_supplier_tax_invoice_receipt_draft(UUID, JSONB, JSONB, UUID[]),
  post_supplier_tax_invoice(UUID, INT), void_supplier_tax_invoice(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION save_supplier_tax_invoice_draft(UUID, JSONB, JSONB, UUID[]), save_supplier_tax_invoice_receipt_draft(UUID, JSONB, JSONB, UUID[]),
  post_supplier_tax_invoice(UUID, INT), void_supplier_tax_invoice(UUID, TEXT) TO authenticated;
REVOKE ALL ON FUNCTION delivery_tax_invoice_ready() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION delivery_tax_invoice_ready() TO authenticated;
