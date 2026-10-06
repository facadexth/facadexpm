-- ============================================================
-- Supplier tax invoice RPCs. Requires 2026-10-08-01.
-- Definer rights: the four tables are SELECT-only for clients. Each public RPC
-- re-checks role, module and tenant (and tenant_can_write() when it writes).
-- preview and post share _sti_check / _sti_stock_lines / _sti_receipt_movements
-- so the preview always shows what post will do. Each plpgsql call is atomic.
-- ============================================================

-- Stock lines in posting order.
CREATE OR REPLACE FUNCTION _sti_stock_lines(p_id UUID, p_tenant UUID)
RETURNS TABLE(line_id UUID, inventory_item_id UUID, site_id UUID, base_qty NUMERIC, base_unit_cost NUMERIC)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT i.id, i.inventory_item_id, i.site_id, i.base_qty, i.base_unit_cost
    FROM supplier_tax_invoice_items i
   WHERE i.invoice_id = p_id AND i.tenant_id = p_tenant AND i.inventory_item_id IS NOT NULL
   ORDER BY i.sort_order, i.id
$$;

-- The linked POs' real receipt movements (ruling A1), in reversal order.
CREATE OR REPLACE FUNCTION _sti_receipt_movements(p_id UUID, p_tenant UUID)
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

-- Every (item, site) the post would touch, in lock order.
CREATE OR REPLACE FUNCTION _sti_touched_keys(p_id UUID, p_tenant UUID)
RETURNS TABLE(inventory_item_id UUID, site_id UUID)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT DISTINCT k.inventory_item_id, k.site_id FROM (
    SELECT s.inventory_item_id, s.site_id FROM _sti_stock_lines(p_id, p_tenant) s
    UNION ALL
    SELECT r.inventory_item_id, r.site_id FROM _sti_receipt_movements(p_id, p_tenant) r) k
  ORDER BY 1, 2
$$;

-- Single source of truth for blocking checks and warnings (order = priority).
-- Returns {checks:[{code, blocking, po_id, detail}], po_sum, diff, tolerance, lines_sum}.
CREATE OR REPLACE FUNCTION _sti_check(p_id UUID, p_tenant UUID) RETURNS JSONB
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

-- ── save / delete draft (atomic; ruling A7, A8) ──
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
    IF EXISTS (SELECT 1 FROM supplier_tax_invoice_pos WHERE po_id = v_po AND active AND invoice_id <> v_id) THEN
      RAISE EXCEPTION 'po_linked_elsewhere';
    END IF;
    INSERT INTO supplier_tax_invoice_pos (tenant_id, invoice_id, po_id) VALUES (v_tenant, v_id, v_po);
  END LOOP;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION delete_supplier_tax_invoice_draft(p_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant UUID := current_tenant_id(); v_status TEXT;
BEGIN
  IF NOT (is_admin_or_owner() AND has_module_access('purchase_orders') AND tenant_can_write()) THEN RAISE EXCEPTION 'insufficient_privilege'; END IF;
  SELECT status INTO v_status FROM supplier_tax_invoices WHERE id = p_id AND tenant_id = v_tenant FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'invoice_not_found'; END IF;
  IF v_status <> 'draft' THEN RAISE EXCEPTION 'not_draft'; END IF;
  DELETE FROM supplier_tax_invoices WHERE id = p_id AND tenant_id = v_tenant;   -- items + links cascade
END $$;

-- ── preview (read-only; simulates post with the same helpers and order) ──
CREATE OR REPLACE FUNCTION preview_supplier_tax_invoice(p_id UUID) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tenant UUID := current_tenant_id();
  v_chk JSONB; v_state JSONB := '{}'::jsonb; v_rows JSONB;
  r RECORD; k TEXT; st JSONB; q NUMERIC; w NUMERIC;
BEGIN
  IF NOT (is_admin_or_owner() AND has_module_access('purchase_orders')) THEN RAISE EXCEPTION 'insufficient_privilege'; END IF;
  v_chk := _sti_check(p_id, v_tenant);
  IF (v_chk->'checks'->0->>'code') = 'invoice_not_found' THEN RETURN v_chk || jsonb_build_object('rows', '[]'::jsonb); END IF;
  -- non-finite data cannot be simulated (jsonb has no NaN): report the blocking check only
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_chk->'checks') e WHERE e->>'code' IN ('po_data_not_finite', 'bad_header')) THEN
    RETURN v_chk || jsonb_build_object('rows', '[]'::jsonb);
  END IF;

  FOR r IN SELECT * FROM _sti_touched_keys(p_id, v_tenant) LOOP
    k := r.inventory_item_id::text || '|' || r.site_id::text;
    SELECT quantity_on_hand, weighted_average_cost INTO q, w FROM inventory_stock_balances
     WHERE inventory_item_id = r.inventory_item_id AND site_id = r.site_id AND tenant_id = v_tenant;
    IF NOT FOUND THEN q := 0; w := 0; END IF;
    v_state := v_state || jsonb_build_object(k, jsonb_build_object('item', r.inventory_item_id, 'site', r.site_id,
      'before_qty', q, 'before_wac', w, 'add_qty', 0, 'remove_qty', 0, 'qty', q, 'wac', w));
  END LOOP;

  FOR r IN SELECT * FROM _sti_stock_lines(p_id, v_tenant) LOOP
    k := r.inventory_item_id::text || '|' || r.site_id::text; st := v_state->k;
    q := (st->>'qty')::numeric; w := (st->>'wac')::numeric;
    st := st || jsonb_build_object('wac', _sti_wac_after_in(q, w, r.base_qty, r.base_unit_cost),
                                   'qty', q + r.base_qty, 'add_qty', (st->>'add_qty')::numeric + r.base_qty);
    v_state := v_state || jsonb_build_object(k, st);
  END LOOP;

  FOR r IN SELECT * FROM _sti_receipt_movements(p_id, v_tenant) LOOP
    k := r.inventory_item_id::text || '|' || r.site_id::text; st := v_state->k;
    q := (st->>'qty')::numeric; w := (st->>'wac')::numeric;
    st := st || jsonb_build_object('wac', _sti_wac_after_reversal(q, w, r.quantity, r.unit_cost),
                                   'qty', q - r.quantity, 'remove_qty', (st->>'remove_qty')::numeric + r.quantity);
    v_state := v_state || jsonb_build_object(k, st);
  END LOOP;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'inventory_item_id', t.val->'item', 'site_id', t.val->'site', 'item_name', ii.name, 'base_unit', ii.base_unit, 'site_name', s.name,
           'before_qty', t.val->'before_qty', 'before_wac', t.val->'before_wac', 'add_qty', t.val->'add_qty', 'remove_qty', t.val->'remove_qty',
           'after_qty', t.val->'qty', 'after_wac', t.val->'wac', 'negative', (t.val->>'qty')::numeric < 0)
         ORDER BY ii.name, s.name), '[]'::jsonb)
    INTO v_rows
    FROM jsonb_each(v_state) AS t(key, val)
    JOIN inventory_items ii ON ii.id = (t.val->>'item')::uuid AND ii.tenant_id = v_tenant
    JOIN sites s ON s.id = (t.val->>'site')::uuid AND s.tenant_id = v_tenant;

  -- revision: the client passes it back to post; a save in between makes post raise stale_preview
  RETURN v_chk || jsonb_build_object('rows', v_rows, 'revision', (SELECT revision FROM supplier_tax_invoices WHERE id = p_id AND tenant_id = v_tenant));
END $$;

-- Negative balances among the touched keys (post and void report them; ruling R2).
CREATE OR REPLACE FUNCTION _sti_negatives(p_tenant UUID, p_keys JSONB) RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('inventory_item_id', b.inventory_item_id, 'site_id', b.site_id,
           'item_name', ii.name, 'site_name', s.name, 'qty', b.quantity_on_hand) ORDER BY ii.name, s.name), '[]'::jsonb)
    FROM inventory_stock_balances b
    JOIN inventory_items ii ON ii.id = b.inventory_item_id
    JOIN sites s ON s.id = b.site_id
   WHERE b.tenant_id = p_tenant AND b.quantity_on_hand < 0
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(p_keys) e
                  WHERE (e->>'item')::uuid = b.inventory_item_id AND (e->>'site')::uuid = b.site_id)
$$;

-- ── post (spec steps 1-5) ──
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

  v_result := jsonb_build_object(
    'lines_posted', v_lines, 'receipts_reversed', v_revs, 'expenses_stamped', v_stamped,
    'po_sum', v_chk->'po_sum', 'diff', v_chk->'diff', 'checks', (v_chk->'checks') || v_warns,
    'negative', _sti_negatives(v_tenant, v_keys));
  UPDATE supplier_tax_invoices
     SET status = 'posted', posted_at = now(), posted_by = auth.email(), match_diff = (v_chk->>'diff')::numeric, post_result = v_result
   WHERE id = p_id;
  RETURN v_result;
END $$;

-- ── void: exact undo in reverse order (ruling A3) ──
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

  UPDATE supplier_tax_invoice_pos SET active = false WHERE invoice_id = p_id AND tenant_id = v_tenant;
  UPDATE supplier_tax_invoices
     SET status = 'void', voided_at = now(), voided_by = auth.email(), void_reason = btrim(p_reason)
   WHERE id = p_id;
  RETURN jsonb_build_object('warnings', v_warn, 'negative', _sti_negatives(v_tenant, v_keys));
END $$;

REVOKE ALL ON FUNCTION save_supplier_tax_invoice_draft(UUID, JSONB, JSONB, UUID[]), delete_supplier_tax_invoice_draft(UUID),
  preview_supplier_tax_invoice(UUID), post_supplier_tax_invoice(UUID, INT), void_supplier_tax_invoice(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION save_supplier_tax_invoice_draft(UUID, JSONB, JSONB, UUID[]), delete_supplier_tax_invoice_draft(UUID),
  preview_supplier_tax_invoice(UUID), post_supplier_tax_invoice(UUID, INT), void_supplier_tax_invoice(UUID, TEXT) TO authenticated;
REVOKE ALL ON FUNCTION _sti_stock_lines(UUID, UUID), _sti_receipt_movements(UUID, UUID), _sti_touched_keys(UUID, UUID),
  _sti_check(UUID, UUID), _sti_negatives(UUID, JSONB) FROM PUBLIC, anon, authenticated;
