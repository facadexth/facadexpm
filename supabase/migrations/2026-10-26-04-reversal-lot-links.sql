-- FIFO + MO/OB stock documents, step 4: voids and returns cancel their own lots
-- (owner-approved design 2026-10-26). Run after 2026-10-26-01, -02 and -03.
-- Bodies below are the LIVE CHANG bodies of 2026-10-26 (pulled by the controller)
-- plus the marked changes; repo files 2026-10-08/09 may be older.
--
--   _stock_receipt_reversal       gains p_lot uuid DEFAULT NULL: the receipt_reversal row
--                                 stores it as lot_movement_id (must be a movement of the
--                                 same tenant, item and site). Its balance write is now
--                                 the FIFO replay (as post_invoice_stock_deduction v2):
--                                 qty = replayed qty, WAC = fifo_value / qty (0 at qty <= 0).
--                                 The old 9-argument version is replaced (keeping it would
--                                 make every 9-argument call ambiguous).
--   void_supplier_tax_invoice     each invoice-line reversal links the purchase_in row it
--                                 takes back (supplier_tax_invoice_items.posted_movement_id).
--                                 The exact / inexact classification, the void_inexact
--                                 warnings, the snapshot restore and every non-stock step
--                                 are unchanged; after them every touched (item, site) gets
--                                 qty / WAC from _replay_stock_lots (supersedes both the
--                                 snapshot's pre-FIFO before_wac and the incremental WAC of
--                                 the re-posted PO receipts). updated_at is left as the
--                                 restore / movement writers set it, so the exactness stamps
--                                 of other invoices keep their meaning.
--   po_unreceive_reverse_stock    each reversal slice links the receipt row it reverses.
--                                 (Balances already finish by replay inside the helper.)
--   confirm_supplier_credit_note  a purchase_return links the credited tax invoice's own
--                                 purchase_in lot when: the note names an original invoice
--                                 number that matches a POSTED supplier tax invoice of the
--                                 same supplier, that invoice has a stocked line for the
--                                 item at the note's site, and that lot's replayed remainder
--                                 is >= the return qty (oldest such lot first). The row then
--                                 stores the lot's unit cost. Otherwise no link (replay takes
--                                 oldest-first) and the old stored cost (current WAC) stays.
--                                 Touched balances finish by replay.
--   void_supplier_credit_note     re-posts stay NEW lots (no link); touched balances finish
--                                 by replay.
--   record_stock_movement         NOT changed. Callers that need a link post the row through
--                                 it and then UPDATE the new row's lot_movement_id (and cost),
--                                 the same pattern as post_invoice_stock_deduction v2.
--
-- Not changed here (reported to the controller): post_supplier_tax_invoice still calls the
-- helper without p_lot, so the PO-receipt reversals it writes stay unlinked (replay takes
-- them oldest-first).

-- ---------------------------------------------------------------------------
-- _stock_receipt_reversal
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public._stock_receipt_reversal(uuid, uuid, uuid, numeric, numeric, text, uuid, text, timestamptz);

CREATE OR REPLACE FUNCTION public._stock_receipt_reversal(
  p_tenant uuid, p_item uuid, p_site uuid, p_qty numeric, p_unit_cost numeric,
  p_reference_type text, p_reference_id uuid, p_notes text, p_at timestamp with time zone,
  p_lot uuid DEFAULT NULL)
 RETURNS TABLE(movement_id uuid, new_quantity_on_hand numeric, new_weighted_average_cost numeric)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_id UUID; v_wac NUMERIC; rp RECORD;
BEGIN
  IF p_tenant IS NULL OR p_tenant IS DISTINCT FROM current_tenant_id() THEN RAISE EXCEPTION 'insufficient_privilege'; END IF;
  IF p_qty IS NULL OR p_qty <= 0 THEN RAISE EXCEPTION 'quantity must be positive'; END IF;
  IF NOT EXISTS (SELECT 1 FROM inventory_items WHERE id = p_item AND tenant_id = p_tenant) THEN
    RAISE EXCEPTION 'inventory_item not found for this tenant';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM sites WHERE id = p_site AND tenant_id = p_tenant) THEN
    RAISE EXCEPTION 'site not found for this tenant';
  END IF;
  -- [2026-10-26-04] the lot must be a row of this tenant, item and site
  IF p_lot IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM stock_movements sm
        WHERE sm.id = p_lot AND sm.tenant_id = p_tenant AND sm.inventory_item_id = p_item AND sm.site_id = p_site) THEN
    RAISE EXCEPTION 'lot_movement_id not found for this item and site';
  END IF;
  PERFORM 1 FROM inventory_stock_balances
    WHERE inventory_item_id = p_item AND site_id = p_site AND tenant_id = p_tenant FOR UPDATE;

  INSERT INTO stock_movements (tenant_id, inventory_item_id, site_id, movement_type, quantity, unit_cost,
                               reference_type, reference_id, notes, created_by, created_at, lot_movement_id)
  VALUES (p_tenant, p_item, p_site, 'receipt_reversal', p_qty, COALESCE(p_unit_cost, 0),
          p_reference_type, p_reference_id, p_notes, auth.email(), COALESCE(p_at, now()), p_lot)
  RETURNING id INTO v_id;

  -- [2026-10-26-04] balance = FIFO replay of the card
  rp := _replay_stock_lots(p_item, p_site);
  v_wac := CASE WHEN rp.qty > 0 THEN rp.fifo_value / rp.qty ELSE 0 END;
  INSERT INTO inventory_stock_balances (tenant_id, inventory_item_id, site_id, quantity_on_hand, weighted_average_cost, updated_at)
  VALUES (p_tenant, p_item, p_site, rp.qty, v_wac, now())
  ON CONFLICT (inventory_item_id, site_id) DO UPDATE
    SET quantity_on_hand = rp.qty, weighted_average_cost = v_wac, updated_at = now();

  RETURN QUERY SELECT v_id, rp.qty, v_wac;
END $function$;

REVOKE ALL ON FUNCTION public._stock_receipt_reversal(uuid, uuid, uuid, numeric, numeric, text, uuid, text, timestamptz, uuid)
  FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- void_supplier_tax_invoice
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.void_supplier_tax_invoice(p_id uuid, p_reason text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant UUID := current_tenant_id();
  inv supplier_tax_invoices%ROWTYPE;
  v_keys JSONB; v_warn JSONB := '[]'::jsonb; v_exact JSONB := '[]'::jsonb;
  r RECORD; m RECORD; k RECORD; mv RECORD; sn RECORD; q NUMERIC; w NUMERIC; u TIMESTAMPTZ;
  fk RECORD; rp RECORD;   -- [2026-10-26-04]
BEGIN
  IF NOT (is_admin_or_owner() AND has_module_access('purchase_orders') AND tenant_can_write()) THEN RAISE EXCEPTION 'insufficient_privilege'; END IF;
  IF COALESCE(btrim(p_reason), '') = '' THEN RAISE EXCEPTION 'void_reason_required'; END IF;
  SELECT * INTO inv FROM supplier_tax_invoices WHERE id = p_id AND tenant_id = v_tenant FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'invoice_not_found'; END IF;
  IF inv.status <> 'posted' THEN RAISE EXCEPTION 'not_posted'; END IF;

  PERFORM 1 FROM purchase_orders
   WHERE tenant_id = v_tenant AND id IN (SELECT po_id FROM supplier_tax_invoice_pos WHERE invoice_id = p_id)
   ORDER BY id FOR UPDATE;
  PERFORM 1 FROM purchase_orders WHERE tenant_id = v_tenant AND id IN (SELECT po_id FROM supplier_tax_invoice_receipts WHERE invoice_id = p_id AND tenant_id = v_tenant) ORDER BY id FOR UPDATE;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('item', x.inventory_item_id, 'site', x.site_id)), '[]'::jsonb) INTO v_keys
    FROM (SELECT inventory_item_id, site_id FROM supplier_tax_invoice_reversals WHERE invoice_id = p_id AND tenant_id = v_tenant
          UNION
          SELECT inventory_item_id, site_id FROM supplier_tax_invoice_items
           WHERE invoice_id = p_id AND tenant_id = v_tenant AND posted_movement_id IS NOT NULL) x;
  PERFORM 1 FROM inventory_stock_balances b
   WHERE b.tenant_id = v_tenant AND EXISTS (SELECT 1 FROM jsonb_array_elements(v_keys) e
                  WHERE (e->>'item')::uuid = b.inventory_item_id AND (e->>'site')::uuid = b.site_id)
   ORDER BY b.inventory_item_id, b.site_id FOR UPDATE;

  FOR sn IN SELECT * FROM supplier_tax_invoice_snapshots WHERE invoice_id = p_id AND tenant_id = v_tenant
             ORDER BY inventory_item_id, site_id LOOP
    SELECT quantity_on_hand, weighted_average_cost, updated_at INTO q, w, u FROM inventory_stock_balances
     WHERE inventory_item_id = sn.inventory_item_id AND site_id = sn.site_id AND tenant_id = v_tenant;
    IF NOT FOUND THEN q := 0; w := 0; u := NULL; END IF;
    IF sn.after_qty IS NOT NULL AND q = sn.after_qty AND w = sn.after_wac AND u IS NOT DISTINCT FROM sn.after_updated_at THEN
      v_exact := v_exact || jsonb_build_object('item', sn.inventory_item_id, 'site', sn.site_id);
    ELSE
      v_warn := v_warn || jsonb_build_object('code', 'void_inexact', 'blocking', false, 'inventory_item_id', sn.inventory_item_id, 'site_id', sn.site_id);
    END IF;
  END LOOP;

  FOR r IN SELECT * FROM supplier_tax_invoice_reversals WHERE invoice_id = p_id AND tenant_id = v_tenant ORDER BY seq DESC LOOP
    SELECT * INTO mv FROM record_stock_movement(r.inventory_item_id, r.site_id, 'purchase_in', r.quantity, r.unit_cost,
                                                'supplier_tax_invoice_void', p_id, 'ยกเลิกใบกำกับ ' || inv.invoice_no || ' (คืนรับเข้าใบสั่งซื้อ)');
    UPDATE supplier_tax_invoice_reversals SET restored_movement_id = mv.movement_id WHERE id = r.id;
  END LOOP;

  FOR m IN SELECT sm.id, sm.inventory_item_id, sm.site_id, sm.quantity, sm.unit_cost
             FROM supplier_tax_invoice_items i
             JOIN stock_movements sm ON sm.id = i.posted_movement_id AND sm.tenant_id = v_tenant
            WHERE i.invoice_id = p_id AND i.tenant_id = v_tenant
            ORDER BY sm.created_at DESC, sm.id DESC LOOP
    PERFORM _stock_receipt_reversal(v_tenant, m.inventory_item_id, m.site_id, m.quantity, m.unit_cost,
                                    'supplier_tax_invoice_void', p_id, 'ยกเลิกใบกำกับ ' || inv.invoice_no, now(),
                                    m.id);   -- [2026-10-26-04] cancel this line's own lot
  END LOOP;

  UPDATE inventory_stock_balances b
     SET quantity_on_hand = s.before_qty, weighted_average_cost = s.before_wac, updated_at = COALESCE(s.before_updated_at, now())
    FROM supplier_tax_invoice_snapshots s
   WHERE s.invoice_id = p_id AND s.tenant_id = v_tenant AND b.tenant_id = v_tenant
     AND b.inventory_item_id = s.inventory_item_id AND b.site_id = s.site_id
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(v_exact) e
                  WHERE (e->>'item')::uuid = s.inventory_item_id AND (e->>'site')::uuid = s.site_id);

  -- [2026-10-26-04] every touched card finishes at its FIFO replay (qty agrees with the
  -- snapshot restore on exact keys; the WAC is the lot truth). updated_at left as set above.
  FOR fk IN SELECT DISTINCT (e->>'item')::uuid AS item, (e->>'site')::uuid AS site
              FROM jsonb_array_elements(v_keys) e ORDER BY 1, 2 LOOP
    rp := _replay_stock_lots(fk.item, fk.site);
    UPDATE inventory_stock_balances
       SET quantity_on_hand = rp.qty,
           weighted_average_cost = CASE WHEN rp.qty > 0 THEN rp.fifo_value / rp.qty ELSE 0 END
     WHERE tenant_id = v_tenant AND inventory_item_id = fk.item AND site_id = fk.site;
  END LOOP;

  FOR k IN SELECT * FROM supplier_tax_invoice_pos
            WHERE invoice_id = p_id AND tenant_id = v_tenant AND expense_id IS NOT NULL AND stamped_invoice_no IS NOT NULL
            ORDER BY po_id LOOP
    UPDATE expenses
       SET invoice_no = k.prev_invoice_no,
           notes = concat_ws(' | ', NULLIF(btrim(notes), ''), 'ยกเลิกใบกำกับภาษี ' || inv.invoice_no)
     WHERE id = k.expense_id AND tenant_id = v_tenant AND invoice_no IS NOT DISTINCT FROM k.stamped_invoice_no;
    IF NOT FOUND THEN v_warn := v_warn || jsonb_build_object('code', 'expense_changed', 'blocking', false, 'po_id', k.po_id); END IF;
  END LOOP;
  v_warn := v_warn || _sti_unstamp_other_bills(p_id, v_tenant, inv.invoice_no);

  UPDATE supplier_tax_invoice_pos SET active = false WHERE invoice_id = p_id AND tenant_id = v_tenant;
  UPDATE supplier_tax_invoice_receipts SET active = false WHERE invoice_id = p_id AND tenant_id = v_tenant;
  UPDATE supplier_tax_invoices
     SET status = 'void', voided_at = now(), voided_by = auth.email(), void_reason = btrim(p_reason)
   WHERE id = p_id;
  RETURN jsonb_build_object('warnings', v_warn, 'negative', _sti_negatives(v_tenant, v_keys));
END $function$;

REVOKE ALL ON FUNCTION public.void_supplier_tax_invoice(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.void_supplier_tax_invoice(uuid, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- po_unreceive_reverse_stock (trigger function; the trigger itself is unchanged)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.po_unreceive_reverse_stock()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  k RECORD; m RECORD;
  v_left NUMERIC; v_take NUMERIC; v_bal NUMERIC; v_note TEXT;
BEGIN
  IF COALESCE(OLD.stock_from_invoice, false) THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM po_receipts WHERE po_id = OLD.id) THEN RETURN NULL; END IF;

  v_note := 'ยกเลิกรับของ ' || COALESCE(OLD.po_number, '') ||
            CASE WHEN NEW.status = 'cancelled' THEN ' (ยกเลิกใบสั่งซื้อ)' ELSE ' (กลับเป็นยังไม่รับของ)' END;

  PERFORM 1 FROM inventory_stock_balances b
   WHERE b.tenant_id = OLD.tenant_id
     AND (b.inventory_item_id, b.site_id) IN (
       SELECT sm.inventory_item_id, sm.site_id FROM stock_movements sm
        WHERE sm.tenant_id = OLD.tenant_id AND sm.reference_type = 'purchase_order' AND sm.reference_id = OLD.id
          AND sm.movement_type IN ('purchase_in', 'receipt_reversal'))
   ORDER BY b.inventory_item_id, b.site_id
   FOR UPDATE OF b;

  FOR k IN
    SELECT sm.inventory_item_id AS item, sm.site_id AS site,
           SUM(CASE WHEN sm.movement_type = 'purchase_in' THEN sm.quantity ELSE -sm.quantity END) AS net
      FROM stock_movements sm
     WHERE sm.tenant_id = OLD.tenant_id AND sm.reference_type = 'purchase_order' AND sm.reference_id = OLD.id
       AND sm.movement_type IN ('purchase_in', 'receipt_reversal')
     GROUP BY sm.inventory_item_id, sm.site_id
     ORDER BY sm.inventory_item_id, sm.site_id
  LOOP
    IF k.net <= 0 THEN CONTINUE; END IF;
    SELECT quantity_on_hand INTO v_bal FROM inventory_stock_balances
     WHERE tenant_id = OLD.tenant_id AND inventory_item_id = k.item AND site_id = k.site;
    v_bal := COALESCE(v_bal, 0);
    IF v_bal < k.net THEN
      RAISE EXCEPTION 'po_unreceive_stock_insufficient'
        USING DETAIL = format('po=%s item=%s site=%s on_hand=%s to_reverse=%s', OLD.po_number, k.item, k.site, v_bal, k.net);
    END IF;
  END LOOP;

  FOR k IN
    SELECT sm.inventory_item_id AS item, sm.site_id AS site,
           SUM(CASE WHEN sm.movement_type = 'purchase_in' THEN sm.quantity ELSE -sm.quantity END) AS net
      FROM stock_movements sm
     WHERE sm.tenant_id = OLD.tenant_id AND sm.reference_type = 'purchase_order' AND sm.reference_id = OLD.id
       AND sm.movement_type IN ('purchase_in', 'receipt_reversal')
     GROUP BY sm.inventory_item_id, sm.site_id
     ORDER BY sm.inventory_item_id, sm.site_id
  LOOP
    IF k.net <= 0 THEN CONTINUE; END IF;
    v_left := k.net;
    FOR m IN
      SELECT sm.id, sm.quantity, sm.unit_cost FROM stock_movements sm   -- [2026-10-26-04] + sm.id
       WHERE sm.tenant_id = OLD.tenant_id AND sm.reference_type = 'purchase_order' AND sm.reference_id = OLD.id
         AND sm.movement_type = 'purchase_in' AND sm.inventory_item_id = k.item AND sm.site_id = k.site
       ORDER BY sm.created_at DESC, sm.id DESC
    LOOP
      EXIT WHEN v_left <= 0;
      v_take := LEAST(m.quantity, v_left);
      IF v_take > 0 THEN
        PERFORM _stock_receipt_reversal(OLD.tenant_id, k.item, k.site, v_take, m.unit_cost,
                                        'purchase_order', OLD.id, v_note, now(),
                                        m.id);   -- [2026-10-26-04] cancel this receipt's own lot
        v_left := v_left - v_take;
      END IF;
    END LOOP;
  END LOOP;

  RETURN NULL;
END $function$;

REVOKE ALL ON FUNCTION public.po_unreceive_reverse_stock() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- confirm_supplier_credit_note
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.confirm_supplier_credit_note(p_id uuid)
 RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant UUID := current_tenant_id();
  cn supplier_credit_notes%ROWTYPE;
  it RECORD;
  v_exp UUID;
  -- [2026-10-26-04]
  v_sti UUID; v_lot UUID; v_lot_cost NUMERIC; v_items UUID[] := '{}';
  mv RECORD; rp RECORD; fk RECORD;
BEGIN
  IF NOT (is_admin_or_owner() AND has_module_access('purchase_orders')) THEN
    RAISE EXCEPTION 'insufficient_privilege';
  END IF;
  SELECT * INTO cn FROM supplier_credit_notes WHERE id = p_id AND tenant_id = v_tenant FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'credit_note_not_found'; END IF;
  IF cn.status <> 'draft' THEN RAISE EXCEPTION 'not_draft'; END IF;
  IF NOT EXISTS (SELECT 1 FROM supplier_credit_note_items WHERE credit_note_id = p_id AND tenant_id = v_tenant) THEN
    RAISE EXCEPTION 'no_items';
  END IF;

  -- [2026-10-26-04] the credited tax invoice: same supplier, same number, posted
  -- (sti_invoice_no_active_uq allows at most one non-void match)
  IF NULLIF(btrim(cn.original_invoice_no), '') IS NOT NULL THEN
    SELECT id INTO v_sti FROM supplier_tax_invoices
     WHERE tenant_id = v_tenant AND supplier_id = cn.supplier_id AND status = 'posted'
       AND lower(btrim(invoice_no)) = lower(btrim(cn.original_invoice_no))
     ORDER BY id LIMIT 1;
  END IF;

  FOR it IN SELECT * FROM supplier_credit_note_items
            WHERE credit_note_id = p_id AND tenant_id = v_tenant
              AND inventory_item_id IS NOT NULL LOOP
    -- [2026-10-26-04] that invoice's own lot for this item at the note's site, if it still holds the qty
    v_lot := NULL; v_lot_cost := NULL;
    IF v_sti IS NOT NULL THEN
      rp := _replay_stock_lots(it.inventory_item_id, cn.site_id);
      SELECT (e->>'movement_id')::uuid, (e->>'unit_cost')::numeric INTO v_lot, v_lot_cost
        FROM supplier_tax_invoice_items i
        JOIN stock_movements sm ON sm.id = i.posted_movement_id AND sm.tenant_id = v_tenant
        JOIN jsonb_array_elements(rp.lots) e ON (e->>'movement_id')::uuid = sm.id
       WHERE i.invoice_id = v_sti AND i.tenant_id = v_tenant
         AND sm.inventory_item_id = it.inventory_item_id AND sm.site_id = cn.site_id
         AND (e->>'qty')::numeric >= it.quantity
       ORDER BY sm.created_at, sm.id
       LIMIT 1;
    END IF;

    SELECT * INTO mv FROM record_stock_movement(it.inventory_item_id, cn.site_id, 'purchase_return',
      it.quantity, NULL, 'supplier_credit_note', p_id, 'ใบลดหนี้ ' || cn.doc_number);
    IF v_lot IS NOT NULL THEN
      UPDATE stock_movements SET lot_movement_id = v_lot, unit_cost = v_lot_cost WHERE id = mv.movement_id;
    END IF;
    v_items := v_items || it.inventory_item_id;
  END LOOP;

  -- [2026-10-26-04] touched balances = FIFO replay
  FOR fk IN SELECT DISTINCT x AS item FROM unnest(v_items) x ORDER BY 1 LOOP
    rp := _replay_stock_lots(fk.item, cn.site_id);
    UPDATE inventory_stock_balances
       SET quantity_on_hand = rp.qty,
           weighted_average_cost = CASE WHEN rp.qty > 0 THEN rp.fifo_value / rp.qty ELSE 0 END,
           updated_at = now()
     WHERE tenant_id = v_tenant AND inventory_item_id = fk.item AND site_id = cn.site_id;
  END LOOP;

  INSERT INTO expenses (tenant_id, date, site_id, category_id, supplier_id, description,
                        amount, amount_no_vat, vat, invoice_no, status, notes)
  VALUES (v_tenant, COALESCE(cn.expense_date, cn.doc_date), cn.site_id, cn.category_id, cn.supplier_id,
          'ใบลดหนี้ ' || cn.doc_number,
          -cn.amount, -cn.amount_no_vat, -cn.vat, cn.doc_number,
          CASE WHEN cn.settlement_status = 'owed' THEN 'pending' ELSE 'paid' END,
          cn.notes)
  RETURNING id INTO v_exp;

  UPDATE supplier_credit_notes
     SET status = 'confirmed', expense_id = v_exp, confirmed_at = now()
   WHERE id = p_id;
  RETURN v_exp;
END $function$;

REVOKE ALL ON FUNCTION public.confirm_supplier_credit_note(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirm_supplier_credit_note(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- void_supplier_credit_note
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.void_supplier_credit_note(p_id uuid)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant UUID := current_tenant_id();
  cn supplier_credit_notes%ROWTYPE;
  mv RECORD;
  v_items UUID[] := '{}'; rp RECORD; fk RECORD;   -- [2026-10-26-04]
BEGIN
  IF NOT (is_admin_or_owner() AND has_module_access('purchase_orders')) THEN
    RAISE EXCEPTION 'insufficient_privilege';
  END IF;
  SELECT * INTO cn FROM supplier_credit_notes WHERE id = p_id AND tenant_id = v_tenant FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'credit_note_not_found'; END IF;
  IF cn.status <> 'confirmed' THEN RAISE EXCEPTION 'not_confirmed'; END IF;

  -- re-posts are NEW lots (no link), at each return's stored cost
  FOR mv IN SELECT inventory_item_id, quantity, unit_cost FROM stock_movements
            WHERE tenant_id = v_tenant AND reference_type = 'supplier_credit_note'
              AND reference_id = p_id AND movement_type = 'purchase_return' LOOP
    PERFORM record_stock_movement(mv.inventory_item_id, cn.site_id, 'purchase_in',
      mv.quantity, mv.unit_cost, 'supplier_credit_note_void', p_id, 'ยกเลิกใบลดหนี้ ' || cn.doc_number);
    v_items := v_items || mv.inventory_item_id;
  END LOOP;

  -- [2026-10-26-04] touched balances = FIFO replay
  FOR fk IN SELECT DISTINCT x AS item FROM unnest(v_items) x ORDER BY 1 LOOP
    rp := _replay_stock_lots(fk.item, cn.site_id);
    UPDATE inventory_stock_balances
       SET quantity_on_hand = rp.qty,
           weighted_average_cost = CASE WHEN rp.qty > 0 THEN rp.fifo_value / rp.qty ELSE 0 END,
           updated_at = now()
     WHERE tenant_id = v_tenant AND inventory_item_id = fk.item AND site_id = cn.site_id;
  END LOOP;

  UPDATE supplier_credit_notes SET status = 'void', expense_id = NULL WHERE id = p_id;
  DELETE FROM expenses WHERE id = cn.expense_id AND tenant_id = v_tenant;
END $function$;

REVOKE ALL ON FUNCTION public.void_supplier_credit_note(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.void_supplier_credit_note(uuid) TO authenticated;
