-- Undo IN2601-001's stock deduction (2026-10-17, old "spread over every
-- central item" plan: 7,181 movements across 2,393 items). Owner asked to
-- undo it and re-cut with the new FIFO plan.
--
-- Effect per movement type:
--   transfer_out (central)  -> add the quantity back to central; central WAC
--                              is unchanged by outs, so it needs no repair.
--   transfer_in + sale_out (Novotel site), purchase_in + sale_out (finished
--                              goods)   -> net 0 qty; the balance row is
--                              deleted if this invoice is the only thing that
--                              ever moved that item at that site.
-- Guard: aborts if any affected item/site moved after this cut for another
-- document (then the balances can't be restored by simple arithmetic).
DO $$
DECLARE
  v_inv uuid := '0b28b845-9dae-4c5e-b37a-77c8c4e5b7df';
  v_later int;
  v_moves int;
  v_central int;
  v_deleted_bal int;
BEGIN
  SELECT count(*) INTO v_later
  FROM stock_movements m
  WHERE (m.inventory_item_id, m.site_id) IN (SELECT inventory_item_id, site_id FROM stock_movements WHERE reference_id = v_inv)
    AND m.reference_id IS DISTINCT FROM v_inv
    AND m.created_at > (SELECT min(created_at) FROM stock_movements WHERE reference_id = v_inv);
  IF v_later > 0 THEN
    RAISE EXCEPTION 'ABORT: % later movements on affected item/site pairs', v_later;
  END IF;

  -- 1. give transfer_out quantities back to central
  WITH back AS (
    SELECT inventory_item_id, site_id, sum(quantity) AS qty
    FROM stock_movements
    WHERE reference_type = 'invoice' AND reference_id = v_inv AND movement_type = 'transfer_out'
    GROUP BY 1, 2
  )
  UPDATE inventory_stock_balances b
     SET quantity_on_hand = b.quantity_on_hand + back.qty, updated_at = now()
    FROM back
   WHERE b.inventory_item_id = back.inventory_item_id AND b.site_id = back.site_id;
  GET DIAGNOSTICS v_central = ROW_COUNT;

  -- 2. balance rows that only exist because of this invoice (net 0 qty)
  WITH only_this AS (
    SELECT inventory_item_id, site_id
    FROM stock_movements
    WHERE (inventory_item_id, site_id) IN (
      SELECT inventory_item_id, site_id FROM stock_movements
      WHERE reference_id = v_inv AND movement_type <> 'transfer_out')
    GROUP BY 1, 2
    HAVING bool_and(reference_id IS NOT DISTINCT FROM v_inv)
  )
  DELETE FROM inventory_stock_balances b
   USING only_this o
   WHERE b.inventory_item_id = o.inventory_item_id AND b.site_id = o.site_id
     AND abs(b.quantity_on_hand) < 0.000001;
  GET DIAGNOSTICS v_deleted_bal = ROW_COUNT;

  -- 3. remove the movements themselves
  DELETE FROM stock_movements WHERE reference_type = 'invoice' AND reference_id = v_inv;
  GET DIAGNOSTICS v_moves = ROW_COUNT;

  RAISE NOTICE 'UNDO movements_deleted=% central_rows_restored=% site_balance_rows_deleted=%', v_moves, v_central, v_deleted_bal;
END $$;
