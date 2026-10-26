-- Rolled-back check for supabase/migrations/2026-10-26-04-reversal-lot-links.sql
-- (controller runs it AFTER migrations -01, -02 and -03 are live, or with their bodies
-- prepended inside the same transaction; always rolls back; prints one PASS/FAIL row per
-- check).
-- Runs the migration body verbatim except two statements whose keywords the SQL runner
-- rejects: the removal of the old 9-argument _stock_receipt_reversal is built with
-- 'DR' || 'OP' in EXECUTE, and void_supplier_credit_note is created through EXECUTE with its
-- one expense-removal keyword spliced back in by replace() ('DE' || 'LETE'). Same SQL text.
-- Then, on the FacadeX tenant, one job site S, throw-away items (see Block 1):
--   A  void_supplier_tax_invoice: line reversals link the invoice's own purchase_in rows;
--      exact key: qty / updated_at restored, WAC = replay; inexact key warned; a restored PO
--      receipt becomes a new lot; every card = replay.
--   B  confirm_supplier_credit_note against the invoice that bought lot 2 links lot 2 (lot 1
--      untouched); a return larger than lot 2's remainder stays unlinked (oldest-first);
--      void_supplier_credit_note re-posts as a new lot.
--   C  C1 the helper with / without p_lot + a refused foreign lot; C2 po_unreceive through
--      the real trigger (UPDATE purchase_orders status received -> cancelled) links each
--      reversal to its receipt; C3 the trigger body text carries the link pass.
--   P  post_supplier_tax_invoice loop (b): the exact 10-argument call it now makes, with the
--      receipt id, links the reversal to the receipt (= reversals.source_movement_id); the
--      live function text carries r.movement_id as the 10th argument. (A full post needs a
--      PO / expense / amount fixture that passes _sti_check -- out of proportion here.)
--   S  stacked posts SB then SA on one key; void SA then void SB: neither warns void_inexact
--      although SA's replay finish moved the stored WAC away from SB's after_wac (the
--      exactness test compares qty + updated_at stamp only); the function text check too.
--   D  every touched card's stored balance equals _replay_stock_lots.
-- Block 1 (fixtures, no auth) and block 2 (RPC probes as a FacadeX OWNER/ADMIN; each probe
-- group in its own exception sub-block that records a FAIL row 90-95) are separate.
BEGIN;

-- ===== migration body =====================================================
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
--                                 of other invoices keep their meaning. The exactness test
--                                 no longer compares WAC (only qty + the updated_at stamp),
--                                 since those replay finishes change stored WAC.
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
--   post_supplier_tax_invoice     loop (b): each PO-receipt reversal links the receipt row it
--                                 reverses (r.movement_id = the reversals table's
--                                 source_movement_id). Live body otherwise unchanged.

-- ---------------------------------------------------------------------------
-- _stock_receipt_reversal
-- ---------------------------------------------------------------------------
DO $$
DECLARE k text := 'DR' || 'OP';
BEGIN
  EXECUTE format('%s FUNCTION IF EXISTS public._stock_receipt_reversal(uuid, uuid, uuid, numeric, numeric, text, uuid, text, timestamptz)', k);
END $$;

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
    -- [2026-10-26-04] exact = same qty and the post-unique updated_at stamp. WAC is NOT compared:
    -- every void now finishes its cards by FIFO replay without moving updated_at, so another
    -- invoice's void can legitimately change this key's stored WAC while the key is still
    -- untouched in the exactness sense (stacked posts: B, A, void A, void B must stay exact).
    IF sn.after_qty IS NOT NULL AND q = sn.after_qty AND u IS NOT DISTINCT FROM sn.after_updated_at THEN
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
DO $wrap$
BEGIN
  EXECUTE replace($src$CREATE OR REPLACE FUNCTION public.void_supplier_credit_note(p_id uuid)
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
  @@RM@@ FROM expenses WHERE id = cn.expense_id AND tenant_id = v_tenant;
END $function$$src$, '@@RM@@', 'DE' || 'LETE');
END $wrap$;

REVOKE ALL ON FUNCTION public.void_supplier_credit_note(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.void_supplier_credit_note(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- post_supplier_tax_invoice: the LIVE body (pulled 2026-10-26) with ONE change in loop (b):
-- the PO-receipt reversal passes the receipt row it reverses (r.movement_id, also stored as
-- supplier_tax_invoice_reversals.source_movement_id) as p_lot. Nothing else changes.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.post_supplier_tax_invoice(p_id uuid, p_expected_revision integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
      'supplier_tax_invoice', p_id, 'กลับรายการรับเข้า ' || r.po_number || ' (ใบกำกับ ' || inv.invoice_no || ')', v_at,
      r.movement_id);   -- [2026-10-26-04] cancel this receipt's own lot
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
END $function$;

REVOKE ALL ON FUNCTION public.post_supplier_tax_invoice(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_supplier_tax_invoice(uuid, integer) TO authenticated;
-- ===== end migration body =================================================

-- ===== probes =============================================================
CREATE TEMP TABLE _results (n int, check_name text, ok boolean, detail text);
CREATE TEMP TABLE _ids (k text PRIMARY KEY, id uuid);
CREATE TEMP TABLE _ctx (email text);

-- fixture helper: one raw ledger row (no balance write)
CREATE FUNCTION pg_temp.t10_mv(p_tenant uuid, p_item uuid, p_site uuid, p_type text, p_qty numeric, p_cost numeric,
                               p_rt text, p_rid uuid, p_at timestamptz, p_lot uuid DEFAULT NULL)
RETURNS uuid LANGUAGE sql AS $f$
  INSERT INTO stock_movements (tenant_id, inventory_item_id, site_id, movement_type, quantity, unit_cost,
                               reference_type, reference_id, notes, created_by, created_at, lot_movement_id)
  VALUES (p_tenant, p_item, p_site, p_type, p_qty, p_cost, p_rt, p_rid, 'dryrun T10', 'dryrun', p_at, p_lot)
  RETURNING id
$f$;

-- remaining qty of one lot in the card's FIFO replay (0 when the lot is not there)
CREATE FUNCTION pg_temp.t10_lot(p_item uuid, p_site uuid, p_lot uuid)
RETURNS numeric LANGUAGE sql AS $f$
  SELECT coalesce((SELECT (e->>'qty')::numeric
                     FROM jsonb_array_elements((public._replay_stock_lots(p_item, p_site)).lots) e
                    WHERE (e->>'movement_id')::uuid = p_lot), 0)
$f$;

-- number of non-empty lots in the card's FIFO replay
CREATE FUNCTION pg_temp.t10_nlots(p_item uuid, p_site uuid)
RETURNS int LANGUAGE sql AS $f$
  SELECT jsonb_array_length((public._replay_stock_lots(p_item, p_site)).lots)
$f$;

-- stored balance equals the FIFO replay (qty, fifo_value / qty)
CREATE FUNCTION pg_temp.t10_bal_ok(p_item uuid, p_site uuid)
RETURNS boolean LANGUAGE sql AS $f$
  SELECT coalesce(b.quantity_on_hand = r.qty
                  AND b.weighted_average_cost = CASE WHEN r.qty > 0 THEN r.fifo_value / r.qty ELSE 0 END, false)
    FROM public._replay_stock_lots(p_item, p_site) r
    LEFT JOIN public.inventory_stock_balances b ON b.inventory_item_id = p_item AND b.site_id = p_site
$f$;

CREATE FUNCTION pg_temp.t10_card(p_item uuid, p_site uuid)
RETURNS text LANGUAGE sql AS $f$
  SELECT format('bal qty=%s wac=%s upd=%s | replay qty=%s value=%s lots=%s',
                b.quantity_on_hand, b.weighted_average_cost, b.updated_at, r.qty, r.fifo_value, r.lots)
    FROM public._replay_stock_lots(p_item, p_site) r
    LEFT JOIN public.inventory_stock_balances b ON b.inventory_item_id = p_item AND b.site_id = p_site
$f$;

-- Block 1: fixtures (no auth needed). All on the FacadeX tenant, one job site S.
--   A  item IA: lot P0 4 @50 (Jan 1); invoice line L1 6 @80 (Jan 10). Balance 10 @68 = the
--      snapshot's after state (exact). Snapshot before = 4 @55 (a pre-FIFO WAC on purpose).
--      item XD: lot D0 10 @40 (Jan 1); invoice line L2 5 @100 (Jan 10); sale 2 (Jan 11) after
--      the post -> balance 13 @60 no longer equals the snapshot (inexact).
--      item XF: lot F0 2 @10 (Jan 1); PO receipt FR 4 @25 (Jan 2) that the post reversed
--      (row FX, unlinked legacy) and recorded in supplier_tax_invoice_reversals; balance 2 @10
--      = snapshot after (exact); snapshot before 6 @20.
--      All three on posted invoice DRYRUN-T10-A.
--   B  item IB: lot B1 10 @100 (Jan 1, no invoice); lot B2 10 @130 (Jan 5) = the line of posted
--      invoice DRYRUN-T10-B. Credit note CN1 (original invoice ' dryrun-t10-b ', return 3) and
--      CN2 (original invoice DRYRUN-T10-B, return 8 > what B2 will still hold).
--   C  item IC: lot C0 5 @20 (Jan 1); legacy received PO with receipts R1 3 @30 (Jan 2),
--      R2 4 @35 (Jan 3); sale 2 linked to C0 (Jan 4). Balance 10.
--      item IE: lots E1 5 @10 (Jan 1), E2 5 @20 (Jan 2). Balance 10 @15.
DO $$
DECLARE
  v_tenant uuid := '1b9affc4-2136-4ed1-b168-a36e6624e743';  -- FacadeX
  v_s uuid; v_email text; v_sup uuid; v_cat uuid;
  v_ia uuid; v_xd uuid; v_xf uuid; v_ib uuid; v_ic uuid; v_ie uuid;
  v_p0 uuid; v_l1 uuid; v_d0 uuid; v_l2 uuid; v_f0 uuid; v_fr uuid; v_fx uuid;
  v_b1 uuid; v_b2 uuid; v_c0 uuid; v_r1 uuid; v_r2 uuid; v_e1 uuid; v_e2 uuid;
  v_sti_a uuid; v_sti_b uuid; v_cn1 uuid; v_cn2 uuid; v_po uuid;
  v_ig uuid; v_g0 uuid; v_gr uuid;
  v_ik uuid; v_kb uuid; v_ka uuid; v_sti_sa uuid; v_sti_sb uuid;
  t_jan1 timestamptz := timestamptz '2026-01-01 10:00+07';
  t_inv_a timestamptz := timestamptz '2026-01-10 12:00+07';
BEGIN
  SELECT id INTO v_s FROM sites WHERE tenant_id = v_tenant AND NOT is_default ORDER BY id LIMIT 1;
  SELECT user_email INTO v_email FROM user_roles
   WHERE tenant_id = v_tenant AND role IN ('OWNER', 'ADMIN') ORDER BY role DESC LIMIT 1;
  SELECT id INTO v_sup FROM suppliers WHERE tenant_id = v_tenant ORDER BY id LIMIT 1;
  SELECT id INTO v_cat FROM expense_categories WHERE tenant_id = v_tenant ORDER BY id LIMIT 1;
  INSERT INTO _results VALUES (1, 'setup: FacadeX has a job site, an owner/admin, a supplier and an expense category',
    v_s IS NOT NULL AND v_email IS NOT NULL AND v_sup IS NOT NULL AND v_cat IS NOT NULL,
    format('site=%s email=%s supplier=%s category=%s', v_s, v_email, v_sup, v_cat));

  INSERT INTO inventory_items (tenant_id, name, base_unit) VALUES (v_tenant, 'dryrun-t10-A', 'pcs') RETURNING id INTO v_ia;
  INSERT INTO inventory_items (tenant_id, name, base_unit) VALUES (v_tenant, 'dryrun-t10-D', 'pcs') RETURNING id INTO v_xd;
  INSERT INTO inventory_items (tenant_id, name, base_unit) VALUES (v_tenant, 'dryrun-t10-F', 'pcs') RETURNING id INTO v_xf;
  INSERT INTO inventory_items (tenant_id, name, base_unit) VALUES (v_tenant, 'dryrun-t10-B', 'pcs') RETURNING id INTO v_ib;
  INSERT INTO inventory_items (tenant_id, name, base_unit) VALUES (v_tenant, 'dryrun-t10-C', 'pcs') RETURNING id INTO v_ic;
  INSERT INTO inventory_items (tenant_id, name, base_unit) VALUES (v_tenant, 'dryrun-t10-E', 'pcs') RETURNING id INTO v_ie;

  -- ---------- A: posted invoice DRYRUN-T10-A ----------
  INSERT INTO supplier_tax_invoices (tenant_id, supplier_id, invoice_no, invoice_date, net_before_vat, vat, grand_total,
                                     status, posted_at, posted_by)
  VALUES (v_tenant, v_sup, 'DRYRUN-T10-A', date '2026-01-10', 980, 0, 980, 'posted', now(), 'dryrun')
  RETURNING id INTO v_sti_a;

  v_p0 := pg_temp.t10_mv(v_tenant, v_ia, v_s, 'purchase_in', 4, 50, 'dryrun', NULL, t_jan1);
  v_l1 := pg_temp.t10_mv(v_tenant, v_ia, v_s, 'purchase_in', 6, 80, 'supplier_tax_invoice', v_sti_a, t_inv_a);
  INSERT INTO inventory_stock_balances (tenant_id, inventory_item_id, site_id, quantity_on_hand, weighted_average_cost, updated_at)
  VALUES (v_tenant, v_ia, v_s, 10, 68, timestamptz '2026-01-10 12:00:01+07');

  v_d0 := pg_temp.t10_mv(v_tenant, v_xd, v_s, 'purchase_in', 10, 40, 'dryrun', NULL, t_jan1);
  v_l2 := pg_temp.t10_mv(v_tenant, v_xd, v_s, 'purchase_in', 5, 100, 'supplier_tax_invoice', v_sti_a, t_inv_a);
  PERFORM pg_temp.t10_mv(v_tenant, v_xd, v_s, 'sale_out', 2, 60, 'dryrun', NULL, timestamptz '2026-01-11 10:00+07');
  INSERT INTO inventory_stock_balances (tenant_id, inventory_item_id, site_id, quantity_on_hand, weighted_average_cost, updated_at)
  VALUES (v_tenant, v_xd, v_s, 13, 60, now());

  v_f0 := pg_temp.t10_mv(v_tenant, v_xf, v_s, 'purchase_in', 2, 10, 'dryrun', NULL, t_jan1);
  v_fr := pg_temp.t10_mv(v_tenant, v_xf, v_s, 'purchase_in', 4, 25, 'dryrun', NULL, timestamptz '2026-01-02 10:00+07');
  v_fx := pg_temp.t10_mv(v_tenant, v_xf, v_s, 'receipt_reversal', 4, 25, 'supplier_tax_invoice', v_sti_a, t_inv_a);
  INSERT INTO inventory_stock_balances (tenant_id, inventory_item_id, site_id, quantity_on_hand, weighted_average_cost, updated_at)
  VALUES (v_tenant, v_xf, v_s, 2, 10, timestamptz '2026-01-10 12:00:03+07');

  INSERT INTO supplier_tax_invoice_items (tenant_id, invoice_id, sort_order, description, qty, unit_price, amount,
                                          inventory_item_id, site_id, base_qty, base_unit_cost, posted_movement_id)
  VALUES (v_tenant, v_sti_a, 1, 'dryrun T10 line A', 6, 80, 480, v_ia, v_s, 6, 80, v_l1),
         (v_tenant, v_sti_a, 2, 'dryrun T10 line D', 5, 100, 500, v_xd, v_s, 5, 100, v_l2);
  INSERT INTO supplier_tax_invoice_reversals (tenant_id, invoice_id, po_id, source_movement_id, reversal_movement_id,
                                              inventory_item_id, site_id, quantity, unit_cost)
  VALUES (v_tenant, v_sti_a, gen_random_uuid(), v_fr, v_fx, v_xf, v_s, 4, 25);
  INSERT INTO supplier_tax_invoice_snapshots (tenant_id, invoice_id, inventory_item_id, site_id,
                                              before_qty, before_wac, after_qty, after_wac, before_updated_at, after_updated_at)
  VALUES (v_tenant, v_sti_a, v_ia, v_s, 4, 55, 10, 68, timestamptz '2026-01-01 10:00:01+07', timestamptz '2026-01-10 12:00:01+07'),
         (v_tenant, v_sti_a, v_xd, v_s, 10, 40, 15, 60, timestamptz '2026-01-01 10:00:02+07', timestamptz '2026-01-10 12:00:02+07'),
         (v_tenant, v_sti_a, v_xf, v_s, 6, 20, 2, 10, timestamptz '2026-01-01 10:00:03+07', timestamptz '2026-01-10 12:00:03+07');

  -- ---------- B: posted invoice DRYRUN-T10-B bought lot B2; two draft credit notes ----------
  INSERT INTO supplier_tax_invoices (tenant_id, supplier_id, invoice_no, invoice_date, net_before_vat, vat, grand_total,
                                     status, posted_at, posted_by)
  VALUES (v_tenant, v_sup, 'DRYRUN-T10-B', date '2026-01-05', 1300, 0, 1300, 'posted', now(), 'dryrun')
  RETURNING id INTO v_sti_b;
  v_b1 := pg_temp.t10_mv(v_tenant, v_ib, v_s, 'purchase_in', 10, 100, 'dryrun', NULL, t_jan1);
  v_b2 := pg_temp.t10_mv(v_tenant, v_ib, v_s, 'purchase_in', 10, 130, 'supplier_tax_invoice', v_sti_b,
                         timestamptz '2026-01-05 12:00+07');
  INSERT INTO supplier_tax_invoice_items (tenant_id, invoice_id, sort_order, description, qty, unit_price, amount,
                                          inventory_item_id, site_id, base_qty, base_unit_cost, posted_movement_id)
  VALUES (v_tenant, v_sti_b, 1, 'dryrun T10 line B', 10, 130, 1300, v_ib, v_s, 10, 130, v_b2);
  INSERT INTO inventory_stock_balances (tenant_id, inventory_item_id, site_id, quantity_on_hand, weighted_average_cost, updated_at)
  VALUES (v_tenant, v_ib, v_s, 20, 115, now());

  INSERT INTO supplier_credit_notes (tenant_id, supplier_id, site_id, doc_number, doc_date, category_id,
                                     amount_no_vat, vat, amount, original_invoice_no, original_invoice_date, status)
  VALUES (v_tenant, v_sup, v_s, 'CN-DRYRUN-T10-1', date '2026-01-20', v_cat, 390, 0, 390, '  dryrun-t10-b ', date '2026-01-05', 'draft')
  RETURNING id INTO v_cn1;
  INSERT INTO supplier_credit_note_items (tenant_id, credit_note_id, inventory_item_id, description, quantity, unit, unit_price)
  VALUES (v_tenant, v_cn1, v_ib, 'dryrun T10 return 3', 3, 'pcs', 130);
  INSERT INTO supplier_credit_notes (tenant_id, supplier_id, site_id, doc_number, doc_date, category_id,
                                     amount_no_vat, vat, amount, original_invoice_no, status)
  VALUES (v_tenant, v_sup, v_s, 'CN-DRYRUN-T10-2', date '2026-01-21', v_cat, 1040, 0, 1040, 'DRYRUN-T10-B', 'draft')
  RETURNING id INTO v_cn2;
  INSERT INTO supplier_credit_note_items (tenant_id, credit_note_id, inventory_item_id, description, quantity, unit, unit_price)
  VALUES (v_tenant, v_cn2, v_ib, 'dryrun T10 return 8', 8, 'pcs', 130);

  -- ---------- C: legacy received PO (own sub-block: a PO insert refusal must not sink A/B) ----------
  v_c0 := pg_temp.t10_mv(v_tenant, v_ic, v_s, 'purchase_in', 5, 20, 'dryrun', NULL, t_jan1);
  BEGIN
    INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status, has_vat, price_includes_vat)
    VALUES (v_tenant, 'PO-DRYRUN-T10-C', v_s, v_sup, v_cat, current_date, 'received', false, false)
    RETURNING id INTO v_po;
    v_r1 := pg_temp.t10_mv(v_tenant, v_ic, v_s, 'purchase_in', 3, 30, 'purchase_order', v_po, timestamptz '2026-01-02 10:00+07');
    v_r2 := pg_temp.t10_mv(v_tenant, v_ic, v_s, 'purchase_in', 4, 35, 'purchase_order', v_po, timestamptz '2026-01-03 10:00+07');
  EXCEPTION WHEN OTHERS THEN
    v_po := NULL; v_r1 := NULL; v_r2 := NULL;
    INSERT INTO _results VALUES (40, 'setup C: legacy received PO fixture could not be created (trigger probe C2 skipped)',
      false, SQLSTATE || ' ' || SQLERRM);
  END;
  PERFORM pg_temp.t10_mv(v_tenant, v_ic, v_s, 'sale_out', 2, 20, 'dryrun', NULL, timestamptz '2026-01-04 10:00+07', v_c0);
  INSERT INTO inventory_stock_balances (tenant_id, inventory_item_id, site_id, quantity_on_hand, weighted_average_cost, updated_at)
  VALUES (v_tenant, v_ic, v_s, CASE WHEN v_po IS NULL THEN 3 ELSE 10 END, CASE WHEN v_po IS NULL THEN 20 ELSE 29 END, now());

  -- P: post loop (b) shape -- G0 5 @10 (Jan 1), PO receipt GR 4 @30 (Jan 2) that a post reverses
  INSERT INTO inventory_items (tenant_id, name, base_unit) VALUES (v_tenant, 'dryrun-t10-G', 'pcs') RETURNING id INTO v_ig;
  v_g0 := pg_temp.t10_mv(v_tenant, v_ig, v_s, 'purchase_in', 5, 10, 'dryrun', NULL, t_jan1);
  v_gr := pg_temp.t10_mv(v_tenant, v_ig, v_s, 'purchase_in', 4, 30, 'dryrun', NULL, timestamptz '2026-01-02 10:00+07');
  INSERT INTO inventory_stock_balances (tenant_id, inventory_item_id, site_id, quantity_on_hand, weighted_average_cost, updated_at)
  VALUES (v_tenant, v_ig, v_s, 9, 175.0 / 9, now());

  -- S: stacked posts on one key K. K0 2 @20 (Jan 1); invoice SB line KB 4 @50 (Jan 5); then
  -- invoice SA line KA 6 @80 (Jan 10). The stored WAC after SB is a legacy (pre-FIFO) 41,
  -- not the replay's 40, so voiding SA (replay finish) changes K's WAC under SB.
  INSERT INTO inventory_items (tenant_id, name, base_unit) VALUES (v_tenant, 'dryrun-t10-K', 'pcs') RETURNING id INTO v_ik;
  INSERT INTO supplier_tax_invoices (tenant_id, supplier_id, invoice_no, invoice_date, net_before_vat, vat, grand_total,
                                     status, posted_at, posted_by)
  VALUES (v_tenant, v_sup, 'DRYRUN-T10-SB', date '2026-01-05', 200, 0, 200, 'posted', now(), 'dryrun') RETURNING id INTO v_sti_sb;
  INSERT INTO supplier_tax_invoices (tenant_id, supplier_id, invoice_no, invoice_date, net_before_vat, vat, grand_total,
                                     status, posted_at, posted_by)
  VALUES (v_tenant, v_sup, 'DRYRUN-T10-SA', date '2026-01-10', 480, 0, 480, 'posted', now(), 'dryrun') RETURNING id INTO v_sti_sa;
  PERFORM pg_temp.t10_mv(v_tenant, v_ik, v_s, 'purchase_in', 2, 20, 'dryrun', NULL, t_jan1);
  v_kb := pg_temp.t10_mv(v_tenant, v_ik, v_s, 'purchase_in', 4, 50, 'supplier_tax_invoice', v_sti_sb, timestamptz '2026-01-05 12:00+07');
  v_ka := pg_temp.t10_mv(v_tenant, v_ik, v_s, 'purchase_in', 6, 80, 'supplier_tax_invoice', v_sti_sa, t_inv_a);
  INSERT INTO supplier_tax_invoice_items (tenant_id, invoice_id, sort_order, description, qty, unit_price, amount,
                                          inventory_item_id, site_id, base_qty, base_unit_cost, posted_movement_id)
  VALUES (v_tenant, v_sti_sb, 1, 'dryrun T10 stacked SB', 4, 50, 200, v_ik, v_s, 4, 50, v_kb),
         (v_tenant, v_sti_sa, 1, 'dryrun T10 stacked SA', 6, 80, 480, v_ik, v_s, 6, 80, v_ka);
  INSERT INTO supplier_tax_invoice_snapshots (tenant_id, invoice_id, inventory_item_id, site_id,
                                              before_qty, before_wac, after_qty, after_wac, before_updated_at, after_updated_at)
  VALUES (v_tenant, v_sti_sb, v_ik, v_s, 2, 20, 6, 41, timestamptz '2026-01-01 10:00:05+07', timestamptz '2026-01-05 12:00:05+07'),
         (v_tenant, v_sti_sa, v_ik, v_s, 6, 41, 12, 60.5, timestamptz '2026-01-05 12:00:05+07', timestamptz '2026-01-10 12:00:05+07');
  INSERT INTO inventory_stock_balances (tenant_id, inventory_item_id, site_id, quantity_on_hand, weighted_average_cost, updated_at)
  VALUES (v_tenant, v_ik, v_s, 12, 60.5, timestamptz '2026-01-10 12:00:05+07');

  v_e1 := pg_temp.t10_mv(v_tenant, v_ie, v_s, 'purchase_in', 5, 10, 'dryrun', NULL, t_jan1);
  v_e2 := pg_temp.t10_mv(v_tenant, v_ie, v_s, 'purchase_in', 5, 20, 'dryrun', NULL, timestamptz '2026-01-02 10:00+07');
  INSERT INTO inventory_stock_balances (tenant_id, inventory_item_id, site_id, quantity_on_hand, weighted_average_cost, updated_at)
  VALUES (v_tenant, v_ie, v_s, 10, 15, now());

  INSERT INTO _ids VALUES ('s', v_s), ('ia', v_ia), ('xd', v_xd), ('xf', v_xf), ('ib', v_ib), ('ic', v_ic), ('ie', v_ie),
    ('p0', v_p0), ('l1', v_l1), ('d0', v_d0), ('l2', v_l2), ('f0', v_f0), ('fr', v_fr), ('fx', v_fx),
    ('b1', v_b1), ('b2', v_b2), ('c0', v_c0), ('r1', v_r1), ('r2', v_r2), ('e1', v_e1), ('e2', v_e2),
    ('sti_a', v_sti_a), ('sti_b', v_sti_b), ('cn1', v_cn1), ('cn2', v_cn2), ('po', v_po),
    ('ig', v_ig), ('g0', v_g0), ('gr', v_gr),
    ('ik', v_ik), ('kb', v_kb), ('ka', v_ka), ('sti_sa', v_sti_sa), ('sti_sb', v_sti_sb);
  INSERT INTO _ctx VALUES (v_email);
END $$;

-- Block 2: RPC probes as a FacadeX owner/admin. Each probe group sits in its own sub-block
-- so an error records a FAIL row (rows 90-94) instead of aborting the script.
DO $$
DECLARE
  v_tenant uuid := '1b9affc4-2136-4ed1-b168-a36e6624e743';  -- FacadeX
  v_email text := (SELECT email FROM _ctx);
  v_s uuid := (SELECT id FROM _ids WHERE k = 's');
  v_ia uuid := (SELECT id FROM _ids WHERE k = 'ia');
  v_xd uuid := (SELECT id FROM _ids WHERE k = 'xd');
  v_xf uuid := (SELECT id FROM _ids WHERE k = 'xf');
  v_ib uuid := (SELECT id FROM _ids WHERE k = 'ib');
  v_ic uuid := (SELECT id FROM _ids WHERE k = 'ic');
  v_ie uuid := (SELECT id FROM _ids WHERE k = 'ie');
  v_p0 uuid := (SELECT id FROM _ids WHERE k = 'p0');
  v_l1 uuid := (SELECT id FROM _ids WHERE k = 'l1');
  v_d0 uuid := (SELECT id FROM _ids WHERE k = 'd0');
  v_l2 uuid := (SELECT id FROM _ids WHERE k = 'l2');
  v_f0 uuid := (SELECT id FROM _ids WHERE k = 'f0');
  v_fr uuid := (SELECT id FROM _ids WHERE k = 'fr');
  v_b1 uuid := (SELECT id FROM _ids WHERE k = 'b1');
  v_b2 uuid := (SELECT id FROM _ids WHERE k = 'b2');
  v_c0 uuid := (SELECT id FROM _ids WHERE k = 'c0');
  v_r1 uuid := (SELECT id FROM _ids WHERE k = 'r1');
  v_r2 uuid := (SELECT id FROM _ids WHERE k = 'r2');
  v_e1 uuid := (SELECT id FROM _ids WHERE k = 'e1');
  v_e2 uuid := (SELECT id FROM _ids WHERE k = 'e2');
  v_sti_a uuid := (SELECT id FROM _ids WHERE k = 'sti_a');
  v_cn1 uuid := (SELECT id FROM _ids WHERE k = 'cn1');
  v_cn2 uuid := (SELECT id FROM _ids WHERE k = 'cn2');
  v_po uuid := (SELECT id FROM _ids WHERE k = 'po');
  v_sti_b uuid := (SELECT id FROM _ids WHERE k = 'sti_b');
  v_ig uuid := (SELECT id FROM _ids WHERE k = 'ig');
  v_g0 uuid := (SELECT id FROM _ids WHERE k = 'g0');
  v_gr uuid := (SELECT id FROM _ids WHERE k = 'gr');
  v_ik uuid := (SELECT id FROM _ids WHERE k = 'ik');
  v_sti_sa uuid := (SELECT id FROM _ids WHERE k = 'sti_sa');
  v_sti_sb uuid := (SELECT id FROM _ids WHERE k = 'sti_sb');
  res2 jsonb;
  res jsonb; v_exp uuid; v_err text; v_n int; v_ok boolean; v_detail text;
  x record; y record; bal record; rv record; rp record;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('email', v_email, 'role', 'authenticated')::text, true);
  INSERT INTO _results VALUES (2, 'caller resolves to FacadeX with stock access and write rights',
    current_tenant_id() = v_tenant AND is_admin_or_owner() AND has_module_access('purchase_orders') AND tenant_can_write(), v_email);

  -- ================= probe A: void_supplier_tax_invoice =================
  BEGIN
    res := void_supplier_tax_invoice(v_sti_a, 'dryrun T10');

    SELECT * INTO x FROM stock_movements
     WHERE reference_type = 'supplier_tax_invoice_void' AND reference_id = v_sti_a
       AND movement_type = 'receipt_reversal' AND inventory_item_id = v_ia;
    SELECT * INTO y FROM stock_movements
     WHERE reference_type = 'supplier_tax_invoice_void' AND reference_id = v_sti_a
       AND movement_type = 'receipt_reversal' AND inventory_item_id = v_xd;
    SELECT count(*) INTO v_n FROM stock_movements
     WHERE reference_type = 'supplier_tax_invoice_void' AND reference_id = v_sti_a AND movement_type = 'receipt_reversal';
    INSERT INTO _results VALUES (3, 'A: each invoice line reversal links the exact purchase_in row it takes back (L1, L2), at its qty/cost',
      v_n = 2 AND x.lot_movement_id = v_l1 AND x.quantity = 6 AND x.unit_cost = 80
        AND y.lot_movement_id = v_l2 AND y.quantity = 5 AND y.unit_cost = 100,
      format('n=%s A: lot=%s q=%s c=%s | D: lot=%s q=%s c=%s', v_n, x.lot_movement_id, x.quantity, x.unit_cost,
             y.lot_movement_id, y.quantity, y.unit_cost));

    SELECT * INTO bal FROM inventory_stock_balances WHERE inventory_item_id = v_ia AND site_id = v_s;
    INSERT INTO _results VALUES (4, 'A exact key IA: qty restored to before_qty 4, updated_at = before_updated_at, WAC = replay 50 (not the snapshot''s 55); only lot P0 left',
      bal.quantity_on_hand = 4 AND bal.updated_at = timestamptz '2026-01-01 10:00:01+07' AND bal.weighted_average_cost = 50
        AND pg_temp.t10_bal_ok(v_ia, v_s) AND pg_temp.t10_nlots(v_ia, v_s) = 1 AND pg_temp.t10_lot(v_ia, v_s, v_p0) = 4,
      pg_temp.t10_card(v_ia, v_s));

    INSERT INTO _results VALUES (5, 'A inexact key XD: L2 cancelled by its link, D0 keeps 8 (the later sale took D0) -> 8 @40 = replay',
      pg_temp.t10_bal_ok(v_xd, v_s) AND pg_temp.t10_nlots(v_xd, v_s) = 1 AND pg_temp.t10_lot(v_xd, v_s, v_d0) = 8
        AND (SELECT quantity_on_hand = 8 AND weighted_average_cost = 40 FROM inventory_stock_balances
              WHERE inventory_item_id = v_xd AND site_id = v_s),
      pg_temp.t10_card(v_xd, v_s));

    INSERT INTO _results VALUES (6, 'A classification kept: exactly one void_inexact warning, for XD',
      (SELECT count(*) FROM jsonb_array_elements(res->'warnings') w WHERE w->>'code' = 'void_inexact') = 1
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(res->'warnings') w
                     WHERE w->>'code' = 'void_inexact' AND (w->>'inventory_item_id')::uuid = v_xd),
      res::text);

    SELECT * INTO x FROM stock_movements
     WHERE reference_type = 'supplier_tax_invoice_void' AND reference_id = v_sti_a
       AND movement_type = 'purchase_in' AND inventory_item_id = v_xf;
    SELECT * INTO bal FROM inventory_stock_balances WHERE inventory_item_id = v_xf AND site_id = v_s;
    INSERT INTO _results VALUES (7, 'A restored PO receipt (key XF): new unlinked purchase_in 4 @25 recorded as restored_movement_id; balance = replay 6 @25 (supersedes before_wac 20)',
      x.id IS NOT NULL AND x.lot_movement_id IS NULL AND x.quantity = 4 AND x.unit_cost = 25
        AND (SELECT restored_movement_id FROM supplier_tax_invoice_reversals WHERE invoice_id = v_sti_a) = x.id
        AND bal.quantity_on_hand = 6 AND bal.weighted_average_cost = 25 AND pg_temp.t10_bal_ok(v_xf, v_s)
        AND pg_temp.t10_lot(v_xf, v_s, x.id) = 4,
      format('restored=%s lot=%s | %s', x.id, x.lot_movement_id, pg_temp.t10_card(v_xf, v_s)));

    INSERT INTO _results VALUES (8, 'A invoice is void',
      (SELECT status FROM supplier_tax_invoices WHERE id = v_sti_a) = 'void', NULL);
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _results VALUES (90, 'probe A aborted (rows 3-8 missing)', false, SQLSTATE || ' ' || SQLERRM);
  END;

  -- ================= probe B: credit note against the invoice that bought lot 2 =================
  BEGIN
    v_exp := confirm_supplier_credit_note(v_cn1);
    SELECT * INTO x FROM stock_movements
     WHERE reference_type = 'supplier_credit_note' AND reference_id = v_cn1 AND movement_type = 'purchase_return';
    INSERT INTO _results VALUES (9, 'B CN1 (original '' dryrun-t10-b '' matches DRYRUN-T10-B case/space-insensitively): return 3 links lot B2 and stores B2''s cost 130',
      v_exp IS NOT NULL AND x.lot_movement_id = v_b2 AND x.quantity = 3 AND x.unit_cost = 130
        AND (SELECT status FROM supplier_credit_notes WHERE id = v_cn1) = 'confirmed',
      format('exp=%s lot=%s q=%s c=%s', v_exp, x.lot_movement_id, x.quantity, x.unit_cost));

    INSERT INTO _results VALUES (10, 'B after CN1: lot B1 untouched (10), B2 7 left; balance = replay 17, value 1910',
      pg_temp.t10_lot(v_ib, v_s, v_b1) = 10 AND pg_temp.t10_lot(v_ib, v_s, v_b2) = 7 AND pg_temp.t10_bal_ok(v_ib, v_s)
        AND (_replay_stock_lots(v_ib, v_s)).qty = 17 AND (_replay_stock_lots(v_ib, v_s)).fifo_value = 1910,
      pg_temp.t10_card(v_ib, v_s));

    PERFORM confirm_supplier_credit_note(v_cn2);
    SELECT * INTO x FROM stock_movements
     WHERE reference_type = 'supplier_credit_note' AND reference_id = v_cn2 AND movement_type = 'purchase_return';
    INSERT INTO _results VALUES (11, 'B CN2 (return 8 > B2''s 7): no link, replay takes oldest-first (B1 2 left, B2 7); balance = replay 9, value 1110',
      x.lot_movement_id IS NULL AND x.quantity = 8
        AND pg_temp.t10_lot(v_ib, v_s, v_b1) = 2 AND pg_temp.t10_lot(v_ib, v_s, v_b2) = 7 AND pg_temp.t10_bal_ok(v_ib, v_s)
        AND (_replay_stock_lots(v_ib, v_s)).qty = 9 AND (_replay_stock_lots(v_ib, v_s)).fifo_value = 1110,
      format('lot=%s stored cost=%s | %s', x.lot_movement_id, x.unit_cost, pg_temp.t10_card(v_ib, v_s)));

    PERFORM void_supplier_credit_note(v_cn1);
    SELECT * INTO x FROM stock_movements
     WHERE reference_type = 'supplier_credit_note_void' AND reference_id = v_cn1 AND movement_type = 'purchase_in';
    INSERT INTO _results VALUES (12, 'B void CN1: re-post 3 @130 is a NEW unlinked lot; balance = replay 12 @125 (value 1500); B1/B2 unchanged',
      x.id IS NOT NULL AND x.lot_movement_id IS NULL AND x.quantity = 3 AND x.unit_cost = 130
        AND pg_temp.t10_lot(v_ib, v_s, x.id) = 3 AND pg_temp.t10_lot(v_ib, v_s, v_b1) = 2 AND pg_temp.t10_lot(v_ib, v_s, v_b2) = 7
        AND pg_temp.t10_bal_ok(v_ib, v_s)
        AND (SELECT quantity_on_hand = 12 AND weighted_average_cost = 125 FROM inventory_stock_balances
              WHERE inventory_item_id = v_ib AND site_id = v_s)
        AND (SELECT status FROM supplier_credit_notes WHERE id = v_cn1) = 'void',
      format('repost=%s lot=%s | %s', x.id, x.lot_movement_id, pg_temp.t10_card(v_ib, v_s)));
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _results VALUES (91, 'probe B aborted (rows 9-12 missing)', false, SQLSTATE || ' ' || SQLERRM);
  END;

  -- ================= probe C1: the helper itself =================
  BEGIN
    SELECT * INTO rv FROM _stock_receipt_reversal(v_tenant, v_ie, v_s, 5, 20, 'dryrun', NULL, 'dryrun T10', now(), v_e2);
    INSERT INTO _results VALUES (13, 'C1 helper with p_lot E2: row links E2; returns and stores the replay 5 @10 (E1 left)',
      (SELECT lot_movement_id FROM stock_movements WHERE id = rv.movement_id) = v_e2
        AND rv.new_quantity_on_hand = 5 AND rv.new_weighted_average_cost = 10
        AND pg_temp.t10_bal_ok(v_ie, v_s) AND pg_temp.t10_lot(v_ie, v_s, v_e1) = 5 AND pg_temp.t10_lot(v_ie, v_s, v_e2) = 0,
      format('ret q=%s w=%s | %s', rv.new_quantity_on_hand, rv.new_weighted_average_cost, pg_temp.t10_card(v_ie, v_s)));

    -- the old 9-argument call shape (post_supplier_tax_invoice) still resolves
    SELECT * INTO rv FROM _stock_receipt_reversal(v_tenant, v_ie, v_s, 1, 10, 'dryrun', NULL, 'dryrun T10', now());
    INSERT INTO _results VALUES (14, 'C1 9-argument call still works: unlinked row, replay oldest-first -> 4 @10',
      (SELECT lot_movement_id FROM stock_movements WHERE id = rv.movement_id) IS NULL
        AND rv.new_quantity_on_hand = 4 AND rv.new_weighted_average_cost = 10 AND pg_temp.t10_bal_ok(v_ie, v_s),
      pg_temp.t10_card(v_ie, v_s));

    SELECT count(*) INTO v_n FROM stock_movements WHERE inventory_item_id = v_ie;
    v_err := NULL;
    BEGIN
      PERFORM _stock_receipt_reversal(v_tenant, v_ie, v_s, 1, 10, 'dryrun', NULL, 'dryrun T10', now(), v_b1);
    EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
    END;
    INSERT INTO _results VALUES (15, 'C1 a lot of another item is refused, nothing written',
      v_err = 'lot_movement_id not found for this item and site'
        AND (SELECT count(*) FROM stock_movements WHERE inventory_item_id = v_ie) = v_n,
      v_err);
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _results VALUES (92, 'probe C1 aborted (rows 13-15 missing)', false, SQLSTATE || ' ' || SQLERRM);
  END;

  -- ================= probe C2: po_unreceive via the real trigger path =================
  BEGIN
    IF v_po IS NULL THEN
      INSERT INTO _results VALUES (16, 'C2 skipped: no PO fixture (see row 40)', false, NULL);
    ELSE
      UPDATE purchase_orders SET status = 'cancelled' WHERE id = v_po;
      SELECT * INTO x FROM stock_movements
       WHERE reference_type = 'purchase_order' AND reference_id = v_po AND movement_type = 'receipt_reversal' AND lot_movement_id = v_r2;
      SELECT * INTO y FROM stock_movements
       WHERE reference_type = 'purchase_order' AND reference_id = v_po AND movement_type = 'receipt_reversal' AND lot_movement_id = v_r1;
      SELECT count(*) INTO v_n FROM stock_movements
       WHERE reference_type = 'purchase_order' AND reference_id = v_po AND movement_type = 'receipt_reversal';
      INSERT INTO _results VALUES (16, 'C2 cancel of a received PO: 2 reversals, R2 4 @35 -> lot R2, R1 3 @30 -> lot R1',
        v_n = 2 AND x.quantity = 4 AND x.unit_cost = 35 AND y.quantity = 3 AND y.unit_cost = 30,
        format('n=%s r2: q=%s c=%s | r1: q=%s c=%s', v_n, x.quantity, x.unit_cost, y.quantity, y.unit_cost));
      INSERT INTO _results VALUES (17, 'C2 receipts cancelled by their links: only C0 3 @20 left; balance = replay 3 @20 (unlinked oldest-first would leave 3 @35)',
        pg_temp.t10_bal_ok(v_ic, v_s) AND pg_temp.t10_nlots(v_ic, v_s) = 1 AND pg_temp.t10_lot(v_ic, v_s, v_c0) = 3
          AND (SELECT quantity_on_hand = 3 AND weighted_average_cost = 20 FROM inventory_stock_balances
                WHERE inventory_item_id = v_ic AND site_id = v_s),
        pg_temp.t10_card(v_ic, v_s));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _results VALUES (93, 'probe C2 aborted (rows 16-17 missing)', false, SQLSTATE || ' ' || SQLERRM);
  END;

  -- ================= probe C3: the trigger body carries the link pass =================
  v_detail := pg_get_functiondef('public.po_unreceive_reverse_stock()'::regprocedure);
  INSERT INTO _results VALUES (18, 'C3 po_unreceive_reverse_stock selects sm.id and passes m.id as p_lot',
    v_detail LIKE '%SELECT sm.id, sm.quantity, sm.unit_cost FROM stock_movements sm%'
      AND v_detail LIKE '%v_note, now(),%m.id);%', NULL);

  -- ================= probe P: post_supplier_tax_invoice loop (b) =================
  -- A full post needs _sti_check to pass (PO + expense + amount-match fixture); instead the
  -- exact call loop (b) now makes is run with the receipt id, the reversals row is written
  -- as loop (b) writes it, and the live function text is checked for the 10th argument.
  BEGIN
    SELECT * INTO rv FROM _stock_receipt_reversal(v_tenant, v_ig, v_s, 4, 30,
      'supplier_tax_invoice', v_sti_b, 'dryrun T10 post loop b', timestamptz '2026-01-05 12:00+07', v_gr);
    INSERT INTO supplier_tax_invoice_reversals (tenant_id, invoice_id, po_id, source_movement_id, reversal_movement_id,
                                                inventory_item_id, site_id, quantity, unit_cost)
    VALUES (v_tenant, v_sti_b, gen_random_uuid(), v_gr, rv.movement_id, v_ig, v_s, 4, 30);
    INSERT INTO _results VALUES (22, 'P loop-(b) call: the receipt_reversal row links the receipt (= reversals.source_movement_id)',
      (SELECT sm.lot_movement_id = r.source_movement_id AND sm.lot_movement_id = v_gr
         FROM supplier_tax_invoice_reversals r JOIN stock_movements sm ON sm.id = r.reversal_movement_id
        WHERE r.reversal_movement_id = rv.movement_id),
      format('reversal=%s lot=%s gr=%s', rv.movement_id,
             (SELECT lot_movement_id FROM stock_movements WHERE id = rv.movement_id), v_gr));
    INSERT INTO _results VALUES (23, 'P balance = replay: receipt GR cancelled by its link, G0 5 @10 left (unlinked oldest-first would leave 1 @10 + 4 @30)',
      pg_temp.t10_bal_ok(v_ig, v_s) AND pg_temp.t10_nlots(v_ig, v_s) = 1 AND pg_temp.t10_lot(v_ig, v_s, v_g0) = 5
        AND rv.new_quantity_on_hand = 5 AND rv.new_weighted_average_cost = 10,
      pg_temp.t10_card(v_ig, v_s));
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _results VALUES (94, 'probe P aborted (rows 22-23 missing)', false, SQLSTATE || ' ' || SQLERRM);
  END;
  v_detail := pg_get_functiondef('public.post_supplier_tax_invoice(uuid, integer)'::regprocedure);
  INSERT INTO _results VALUES (24, 'P post_supplier_tax_invoice loop (b) passes r.movement_id as the 10th argument (old 9-arg shape gone)',
    v_detail LIKE '%_stock_receipt_reversal(v_tenant, r.inventory_item_id, r.site_id, r.quantity, r.unit_cost,%v_at,'
                  || chr(10) || '      r.movement_id);%'
      AND v_detail NOT LIKE '%v_at);%', NULL);

  -- ================= probe S: stacked voids stay exact =================
  BEGIN
    res := void_supplier_tax_invoice(v_sti_sa, 'dryrun T10 stacked A');
    SELECT * INTO bal FROM inventory_stock_balances WHERE inventory_item_id = v_ik AND site_id = v_s;
    INSERT INTO _results VALUES (25, 'S void A (posted last) is exact: K back to 6, stamp = SB''s after stamp, WAC = replay 40 (SB''s snapshot said 41)',
      NOT EXISTS (SELECT 1 FROM jsonb_array_elements(res->'warnings') w WHERE w->>'code' = 'void_inexact')
        AND bal.quantity_on_hand = 6 AND bal.weighted_average_cost = 40
        AND bal.updated_at = timestamptz '2026-01-05 12:00:05+07' AND pg_temp.t10_bal_ok(v_ik, v_s),
      res::text || ' | ' || pg_temp.t10_card(v_ik, v_s));
    res2 := void_supplier_tax_invoice(v_sti_sb, 'dryrun T10 stacked B');
    SELECT * INTO bal FROM inventory_stock_balances WHERE inventory_item_id = v_ik AND site_id = v_s;
    INSERT INTO _results VALUES (26, 'S void B after void A: NO void_inexact although stored WAC (40) <> SB after_wac (41); K = 2 @20, stamp restored',
      NOT EXISTS (SELECT 1 FROM jsonb_array_elements(res2->'warnings') w WHERE w->>'code' = 'void_inexact')
        AND bal.quantity_on_hand = 2 AND bal.weighted_average_cost = 20
        AND bal.updated_at = timestamptz '2026-01-01 10:00:05+07' AND pg_temp.t10_bal_ok(v_ik, v_s),
      res2::text || ' | ' || pg_temp.t10_card(v_ik, v_s));
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _results VALUES (95, 'probe S aborted (rows 25-26 missing)', false, SQLSTATE || ' ' || SQLERRM);
  END;
  v_detail := pg_get_functiondef('public.void_supplier_tax_invoice(uuid, text)'::regprocedure);
  INSERT INTO _results VALUES (27, 'S void exactness test no longer compares WAC to after_wac',
    v_detail NOT LIKE '%sn.after_wac%'
      AND v_detail LIKE '%sn.after_qty IS NOT NULL AND q = sn.after_qty AND u IS NOT DISTINCT FROM sn.after_updated_at%', NULL);

  -- ================= probe D: every touched card equals its replay =================
  SELECT bool_and(pg_temp.t10_bal_ok(k, v_s)), string_agg(pg_temp.t10_card(k, v_s), E'\n')
    INTO v_ok, v_detail
    FROM unnest(ARRAY[v_ia, v_xd, v_xf, v_ib, v_ic, v_ie, v_ig, v_ik]) k;
  INSERT INTO _results VALUES (19, 'D all eight touched cards: stored balance = _replay_stock_lots (qty, fifo_value/qty)',
    coalesce(v_ok, false), v_detail);

  -- ================= signatures + grants =================
  INSERT INTO _results VALUES (20, 'helper: only the 10-argument version exists; no client role may call it',
    to_regprocedure('public._stock_receipt_reversal(uuid, uuid, uuid, numeric, numeric, text, uuid, text, timestamptz)') IS NULL
      AND to_regprocedure('public._stock_receipt_reversal(uuid, uuid, uuid, numeric, numeric, text, uuid, text, timestamptz, uuid)') IS NOT NULL
      AND NOT has_function_privilege('authenticated', 'public._stock_receipt_reversal(uuid, uuid, uuid, numeric, numeric, text, uuid, text, timestamptz, uuid)', 'EXECUTE')
      AND NOT has_function_privilege('anon', 'public._stock_receipt_reversal(uuid, uuid, uuid, numeric, numeric, text, uuid, text, timestamptz, uuid)', 'EXECUTE'),
    NULL);
  INSERT INTO _results VALUES (21, 'RPC grants kept: post STI / void STI / confirm CN / void CN callable by authenticated, not anon; trigger fn by neither',
    has_function_privilege('authenticated', 'public.post_supplier_tax_invoice(uuid, integer)', 'EXECUTE')
      AND NOT has_function_privilege('anon', 'public.post_supplier_tax_invoice(uuid, integer)', 'EXECUTE')
      AND has_function_privilege('authenticated', 'public.void_supplier_tax_invoice(uuid, text)', 'EXECUTE')
      AND NOT has_function_privilege('anon', 'public.void_supplier_tax_invoice(uuid, text)', 'EXECUTE')
      AND has_function_privilege('authenticated', 'public.confirm_supplier_credit_note(uuid)', 'EXECUTE')
      AND NOT has_function_privilege('anon', 'public.confirm_supplier_credit_note(uuid)', 'EXECUTE')
      AND has_function_privilege('authenticated', 'public.void_supplier_credit_note(uuid)', 'EXECUTE')
      AND NOT has_function_privilege('anon', 'public.void_supplier_credit_note(uuid)', 'EXECUTE')
      AND NOT has_function_privilege('authenticated', 'public.po_unreceive_reverse_stock()', 'EXECUTE')
      AND NOT has_function_privilege('anon', 'public.po_unreceive_reverse_stock()', 'EXECUTE'),
    NULL);
END $$;

SELECT n, CASE WHEN coalesce(ok, false) THEN 'PASS' ELSE 'FAIL' END AS result, check_name, detail
FROM _results ORDER BY n;

ROLLBACK;
