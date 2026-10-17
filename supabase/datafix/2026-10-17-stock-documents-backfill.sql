-- Backfill DP/DM documents for invoices cut before migration
-- 2026-10-17-05 (on 2026-10-17 only IN2601-001 and IN2608-006, both tenant
-- 1b9affc4...), oldest invoice date first so numbers run in date order.
-- Also, for those invoices:
--   * re-date movements stamped with the click day to the invoice date at
--     23:59 Bangkok, keeping their order (IN2608-006: cut 24-26 Sep 2026,
--     invoice 25 Aug 2026). Balances are not touched.
--   * rewrite stale PI-/PO-<number> notes to the invoice's current number
--     (IN2608-006 was renumbered from IN2608-065 after its cut).
DO $$
DECLARE
  v_inv record;
  v_dp uuid;
  v_dm uuid;
  v_docs int := 0;
  v_tagged int := 0;
  v_redated int := 0;
  v_notes int := 0;
  v_n int;
BEGIN
  FOR v_inv IN
    SELECT i.id, i.tenant_id, i.date, i.invoice_number
    FROM invoices i
    WHERE EXISTS (SELECT 1 FROM stock_movements m WHERE m.reference_type = 'invoice' AND m.reference_id = i.id AND m.stock_document_id IS NULL)
    ORDER BY i.date, i.invoice_number
  LOOP
    IF v_inv.date IS NULL THEN RAISE EXCEPTION 'ABORT: invoice % has no date', v_inv.invoice_number; END IF;
    v_dp := NULL; v_dm := NULL;

    IF EXISTS (SELECT 1 FROM stock_movements m JOIN inventory_items ii ON ii.id = m.inventory_item_id
               WHERE m.reference_type = 'invoice' AND m.reference_id = v_inv.id AND ii.item_kind = 'finished_goods') THEN
      v_dp := _issue_stock_document(v_inv.tenant_id, v_inv.id, 'DP', v_inv.date, 'datafix 2026-10-17');
      v_docs := v_docs + 1;
    END IF;
    IF EXISTS (SELECT 1 FROM stock_movements m JOIN inventory_items ii ON ii.id = m.inventory_item_id
               WHERE m.reference_type = 'invoice' AND m.reference_id = v_inv.id AND ii.item_kind <> 'finished_goods') THEN
      v_dm := _issue_stock_document(v_inv.tenant_id, v_inv.id, 'DM', v_inv.date, 'datafix 2026-10-17');
      v_docs := v_docs + 1;
    END IF;

    UPDATE stock_movements m
       SET stock_document_id = CASE WHEN ii.item_kind = 'finished_goods' THEN v_dp ELSE v_dm END
      FROM inventory_items ii
     WHERE ii.id = m.inventory_item_id AND m.reference_type = 'invoice' AND m.reference_id = v_inv.id
       AND m.stock_document_id IS NULL;
    GET DIAGNOSTICS v_n = ROW_COUNT; v_tagged := v_tagged + v_n;

    WITH t AS (
      SELECT id, row_number() OVER (ORDER BY created_at, id) AS ord
      FROM stock_movements
      WHERE reference_type = 'invoice' AND reference_id = v_inv.id
        AND (created_at AT TIME ZONE 'Asia/Bangkok')::date <> v_inv.date
    )
    UPDATE stock_movements m
       SET created_at = ((v_inv.date + time '23:59') AT TIME ZONE 'Asia/Bangkok') + (t.ord * interval '1 microsecond')
      FROM t WHERE m.id = t.id;
    GET DIAGNOSTICS v_n = ROW_COUNT; v_redated := v_redated + v_n;

    UPDATE stock_movements
       SET notes = substring(notes FROM 1 FOR 3) || v_inv.invoice_number
     WHERE reference_type = 'invoice' AND reference_id = v_inv.id
       AND notes ~ '^P[IO]-' AND notes <> substring(notes FROM 1 FOR 3) || v_inv.invoice_number;
    GET DIAGNOSTICS v_n = ROW_COUNT; v_notes := v_notes + v_n;
  END LOOP;

  RAISE NOTICE 'BACKFILL documents=% movements_tagged=% redated=% notes_fixed=%', v_docs, v_tagged, v_redated, v_notes;
END $$;
