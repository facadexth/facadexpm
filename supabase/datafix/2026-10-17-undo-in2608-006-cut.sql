-- Undo IN2608-006's stock deduction (cut 24-26 Sep 2026 under its old
-- number IN2608-065: 25 site sale_outs, 3 central->site transfers, 1 FG
-- produce+sell pair; 33 movements). Owner, 2026-10-17: "ยกเลิกยอดนี้ไปเลย"
-- -- nobody knows what was really cut or when, and re-dating it to the
-- invoice date (25 Aug) would have sent 17 stock cards negative.
--
-- Unlike IN2601-001, goods were received at the same item/sites AFTER this
-- cut, and the transfers blended the site's WAC, so balances can't be fixed
-- by adding quantities back. Instead every affected item/site balance is
-- rebuilt by replaying its ledger without this invoice's rows, using
-- record_stock_movement's rules. Checked 2026-10-17: replaying WITH the rows
-- reproduces all 28 current balances exactly (qty and WAC).
-- Replays one item/site's ledger (oldest first) with record_stock_movement's
-- rules and returns the resulting qty + WAC. p_skip_ref: a reference_id whose
-- movements are left out (the cut being undone), or NULL for none.
CREATE OR REPLACE FUNCTION pg_temp.replay_balance(p_item uuid, p_site uuid, p_skip_ref uuid, OUT qty numeric, OUT wac numeric)
LANGUAGE plpgsql AS $f$
DECLARE m record; nq numeric;
BEGIN
  qty := 0; wac := 0;
  FOR m IN SELECT * FROM stock_movements WHERE inventory_item_id = p_item AND site_id = p_site
             AND reference_id IS DISTINCT FROM COALESCE(p_skip_ref, '00000000-0000-0000-0000-000000000000'::uuid)
           ORDER BY created_at, id LOOP
    IF m.movement_type IN ('purchase_in','transfer_in','sale_reversal') THEN
      nq := qty + m.quantity;
      wac := CASE WHEN nq = 0 THEN 0 ELSE (qty * wac + m.quantity * COALESCE(m.unit_cost, 0)) / nq END;
      qty := nq;
    ELSIF m.movement_type = 'adjustment' THEN
      qty := qty + m.quantity; wac := m.unit_cost;
    ELSIF m.movement_type = 'receipt_reversal' THEN
      wac := _sti_wac_after_reversal(qty, wac, m.quantity, m.unit_cost);
      qty := qty - m.quantity;
    ELSE -- sale_out, transfer_out, purchase_return
      qty := qty - m.quantity;
    END IF;
  END LOOP;
END $f$;

DO $$
DECLARE
  v_inv uuid := '539993ea-bdab-4705-a37b-1a76a61b34a9';
  p record;
  r record;
  v_check int;
  v_updated int := 0;
  v_deleted_bal int := 0;
  v_moves int;
BEGIN
  -- guard: the replay must still reproduce today's balances before we trust it
  SELECT count(*) INTO v_check
  FROM (SELECT DISTINCT inventory_item_id, site_id FROM stock_movements WHERE reference_id = v_inv) x
  LEFT JOIN inventory_stock_balances b USING (inventory_item_id, site_id)
  CROSS JOIN LATERAL pg_temp.replay_balance(x.inventory_item_id, x.site_id, NULL) rp
  WHERE abs(rp.qty - coalesce(b.quantity_on_hand, 0)) > 0.0001 OR abs(rp.wac - coalesce(b.weighted_average_cost, 0)) > 0.0001;
  IF v_check > 0 THEN RAISE EXCEPTION 'ABORT: replay disagrees with % current balances', v_check; END IF;

  FOR p IN SELECT DISTINCT inventory_item_id, site_id FROM stock_movements WHERE reference_id = v_inv LOOP
    r := pg_temp.replay_balance(p.inventory_item_id, p.site_id, v_inv);
    IF NOT EXISTS (SELECT 1 FROM stock_movements WHERE inventory_item_id = p.inventory_item_id AND site_id = p.site_id
                   AND reference_id IS DISTINCT FROM v_inv) THEN
      DELETE FROM inventory_stock_balances WHERE inventory_item_id = p.inventory_item_id AND site_id = p.site_id;
      v_deleted_bal := v_deleted_bal + 1;
    ELSE
      UPDATE inventory_stock_balances SET quantity_on_hand = r.qty, weighted_average_cost = r.wac, updated_at = now()
       WHERE inventory_item_id = p.inventory_item_id AND site_id = p.site_id;
      v_updated := v_updated + 1;
    END IF;
  END LOOP;

  DELETE FROM stock_movements WHERE reference_type = 'invoice' AND reference_id = v_inv;
  GET DIAGNOSTICS v_moves = ROW_COUNT;

  RAISE NOTICE 'UNDO IN2608-006 movements_deleted=% balances_rebuilt=% balance_rows_deleted=%', v_moves, v_updated, v_deleted_bal;
END $$;
