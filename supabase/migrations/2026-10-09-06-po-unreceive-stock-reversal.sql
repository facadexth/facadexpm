-- ============================================================
-- Un-receive / cancel of a legacy whole-PO receive reverses its stock (แก้ช่องโหว่ สต็อกค้างหลังยกเลิกรับของ).
--
-- The legacy receive (receive_po_with_deposits + the client's record_stock_movement loop) posts purchase_in
-- movements with reference_type = 'purchase_order', reference_id = <po id>. Moving that PO back from 'received'
-- to 'ordered' (Expenses: delete the bill -> "กลับไปเป็นยังไม่รับของ") or to 'cancelled' (PO page cancel, or
-- Expenses -> "ยกเลิกใบสั่งซื้อ") was a plain status update that left the stock behind (PO2610-037, PO2610-039).
--
-- This AFTER UPDATE trigger reverses, per (item, site), the PO's still-unreversed receipt:
--   net = sum(purchase_in) - sum(receipt_reversal), both reference_type 'purchase_order' AND reference_id = PO id.
-- Each reversal goes through _stock_receipt_reversal (2026-10-08-01), the exact WAC inverse of a receipt.
-- Reversing to exactly 0 keeps the old WAC (by design of _sti_wac_after_reversal).
-- If any balance is below its net, the whole status change is refused with 'po_unreceive_stock_insufficient'
-- (numbers in DETAIL) -- never a silent negative balance (the helper itself has no negative guard).
--
-- Not touched: POs with stock_from_invoice (stock comes from the tax invoice), POs with po_receipts rows
-- (new partial-receive flow; status changes are blocked by po_block_when_receipted anyway). POs with deposit
-- applications or a posted tax invoice are refused earlier by the BEFORE UPDATE triggers
-- (po_block_unreceive_with_deposits, po_block_when_tax_invoiced, po_block_when_receipted), which is why this is
-- AFTER: it only runs when those let the update through. Tax-invoice post/void movements use other reference
-- types and are left alone.
--
-- Admin SQL: _stock_receipt_reversal refuses p_tenant <> current_tenant_id(), so an un-receive run as a plain
-- superuser WITHOUT request.jwt.claims (email of a user of that tenant) fails with insufficient_privilege when the
-- PO has stock to reverse. Set the claims first (see supabase/tests/po_unreceive_stock_test.sql).
--
-- Lock order: the UPDATE already holds the PO row; balances are then locked in (item, site) order. The client's
-- receive loop locks balance -> PO (FOR SHARE, stock_movement_block_when_tax_invoiced), so a receive racing an
-- un-receive of the SAME PO can deadlock: Postgres aborts one side (40P01), data stays correct, user retries
-- (same accepted limit as 2026-10-08-01).
--
-- Also: po_unreceive_reverses_stock() -- a probe the web calls to show the "stock will be reversed" sentence
-- only once this migration is live.
-- Requires (live): 2026-10-08-01 (_stock_receipt_reversal, receipt_reversal type), 2026-10-09-01 (po_receipts).
-- ============================================================

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION po_unreceive_reverse_stock() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  k RECORD; m RECORD;
  v_left NUMERIC; v_take NUMERIC; v_bal NUMERIC; v_note TEXT;
BEGIN
  IF COALESCE(OLD.stock_from_invoice, false) THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM po_receipts WHERE po_id = OLD.id) THEN RETURN NULL; END IF;

  v_note := 'ยกเลิกรับของ ' || COALESCE(OLD.po_number, '') ||
            CASE WHEN NEW.status = 'cancelled' THEN ' (ยกเลิกใบสั่งซื้อ)' ELSE ' (กลับเป็นยังไม่รับของ)' END;

  -- lock every touched balance first, in (item, site) order
  PERFORM 1 FROM inventory_stock_balances b
   WHERE b.tenant_id = OLD.tenant_id
     AND (b.inventory_item_id, b.site_id) IN (
       SELECT sm.inventory_item_id, sm.site_id FROM stock_movements sm
        WHERE sm.tenant_id = OLD.tenant_id AND sm.reference_type = 'purchase_order' AND sm.reference_id = OLD.id
          AND sm.movement_type IN ('purchase_in', 'receipt_reversal'))
   ORDER BY b.inventory_item_id, b.site_id
   FOR UPDATE OF b;

  -- check all keys before writing anything (a refusal must leave nothing half-done; the RAISE rolls back anyway)
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
    -- newest receipts first, each reversed at its own unit cost (exact WAC inverse)
    FOR m IN
      SELECT sm.quantity, sm.unit_cost FROM stock_movements sm
       WHERE sm.tenant_id = OLD.tenant_id AND sm.reference_type = 'purchase_order' AND sm.reference_id = OLD.id
         AND sm.movement_type = 'purchase_in' AND sm.inventory_item_id = k.item AND sm.site_id = k.site
       ORDER BY sm.created_at DESC, sm.id DESC
    LOOP
      EXIT WHEN v_left <= 0;
      v_take := LEAST(m.quantity, v_left);
      IF v_take > 0 THEN
        PERFORM _stock_receipt_reversal(OLD.tenant_id, k.item, k.site, v_take, m.unit_cost,
                                        'purchase_order', OLD.id, v_note, now());
        v_left := v_left - v_take;
      END IF;
    END LOOP;
  END LOOP;

  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS po_unreceive_reverse_stock_trg ON purchase_orders;
CREATE TRIGGER po_unreceive_reverse_stock_trg AFTER UPDATE OF status ON purchase_orders
  FOR EACH ROW WHEN (OLD.status = 'received' AND NEW.status IN ('ordered', 'cancelled'))
  EXECUTE FUNCTION po_unreceive_reverse_stock();

REVOKE ALL ON FUNCTION po_unreceive_reverse_stock() FROM PUBLIC, anon, authenticated;

-- Probe for the web: exists only once this migration is live.
CREATE OR REPLACE FUNCTION po_unreceive_reverses_stock() RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = public AS $$ SELECT true $$;
REVOKE ALL ON FUNCTION po_unreceive_reverses_stock() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION po_unreceive_reverses_stock() TO authenticated;
