-- FIFO + MO/OB stock documents, step 5: _apply_stock_movement finishes the balance by the
-- FIFO replay. Run after 2026-10-26-01 .. -04 (needs _replay_stock_lots from -02).
--
-- Why: every other stock writer of this arc (post_invoice_stock_deduction v2, the
-- reversal helpers, voids, credit notes, the switch-over) stores the balance as
-- qty / WAC = _replay_stock_lots (qty, fifo_value / qty). _apply_stock_movement --
-- behind record_stock_movement (manual adjustments, receipts, transfers) and the
-- per-row posting of record_stock_movements_batch -- still wrote an INCREMENTAL WAC
-- blend, so e.g. a manual count-down left the stored WAC at the blended average while the
-- replay consumed the oldest lot: the card drifted from its replay (and the refit's
-- BALANCES check would abort on any such card).
--
-- What changes: ONLY the inventory_stock_balances write and the RETURN values, which are
-- now the replay's qty and fifo_value / qty (0 at qty <= 0) after the row is inserted.
-- What does NOT change: the movement-type whitelist, the quantity validations, the
-- FOR UPDATE lock on the balance row, the purchase_return insufficient_stock check
-- (against the stored balance qty, which every writer now keeps = replay qty), and every
-- stored row field -- adjustment stores the delta (new count - stored qty) at
-- COALESCE(p_unit_cost, stored WAC); in-rows store the caller's cost; purchase_return
-- stores the stored WAC (caller's cost ignored); sale_out / transfer_out store the
-- caller's cost. Rows are byte-for-byte what the previous body wrote.
--
-- Cost (controller ruling 2026-10-26): one _replay_stock_lots per posted row (a full
-- scan of that card). Accepted at current volumes; a large batch through
-- record_stock_movements_batch / post_invoice_stock_deduction pays one card replay per
-- row.
--
-- Signature, SECURITY DEFINER, search_path and grants are unchanged (CREATE OR REPLACE).

CREATE OR REPLACE FUNCTION public._apply_stock_movement(
  p_tenant_id uuid, p_inventory_item_id uuid, p_site_id uuid, p_movement_type text,
  p_quantity numeric, p_unit_cost numeric, p_reference_type text, p_reference_id uuid,
  p_notes text, p_created_by text, p_created_at timestamptz)
RETURNS TABLE(movement_id uuid, new_quantity_on_hand numeric, new_weighted_average_cost numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_movement_id UUID;
  v_old_qty NUMERIC;
  v_old_wac NUMERIC;
  v_new_qty NUMERIC;
  v_new_wac NUMERIC;
  v_stored_qty NUMERIC;
  v_stored_cost NUMERIC;
  rp RECORD;   -- [2026-10-26-05]
BEGIN
  IF p_movement_type NOT IN ('purchase_in', 'transfer_in', 'transfer_out', 'adjustment', 'sale_out', 'sale_reversal', 'purchase_return') THEN
    RAISE EXCEPTION 'unsupported_movement_type: %', p_movement_type;
  END IF;

  IF p_movement_type = 'adjustment' THEN
    IF p_quantity IS NULL OR p_quantity < 0 THEN
      RAISE EXCEPTION 'adjustment quantity (new absolute count) must be zero or positive';
    END IF;
  ELSE
    IF p_quantity IS NULL OR p_quantity <= 0 THEN
      RAISE EXCEPTION 'quantity must be positive';
    END IF;
  END IF;

  SELECT quantity_on_hand, weighted_average_cost INTO v_old_qty, v_old_wac
  FROM inventory_stock_balances
  WHERE inventory_item_id = p_inventory_item_id AND site_id = p_site_id
  FOR UPDATE;

  IF NOT FOUND THEN
    v_old_qty := 0;
    v_old_wac := 0;
  END IF;

  -- the stored row's qty / cost (unchanged rules); v_new_* only feed the stored cost now
  IF p_movement_type = 'adjustment' THEN
    v_new_qty := p_quantity;
    v_new_wac := COALESCE(p_unit_cost, v_old_wac);
    v_stored_qty := p_quantity - v_old_qty;
    v_stored_cost := v_new_wac;
  ELSIF p_movement_type IN ('purchase_in', 'transfer_in', 'sale_reversal') THEN
    v_new_qty := v_old_qty + p_quantity;
    IF v_new_qty = 0 THEN
      v_new_wac := 0;
    ELSE
      v_new_wac := (v_old_qty * v_old_wac + p_quantity * COALESCE(p_unit_cost, 0)) / v_new_qty;
    END IF;
    v_stored_qty := p_quantity;
    v_stored_cost := p_unit_cost;
  ELSIF p_movement_type = 'purchase_return' THEN
    IF p_quantity > v_old_qty THEN
      RAISE EXCEPTION 'insufficient_stock';
    END IF;
    v_new_qty := v_old_qty - p_quantity;
    v_new_wac := v_old_wac;
    v_stored_qty := p_quantity;
    v_stored_cost := v_old_wac; -- caller-supplied cost is ignored on returns
  ELSE -- transfer_out, sale_out
    v_new_qty := v_old_qty - p_quantity;
    v_new_wac := v_old_wac;
    v_stored_qty := p_quantity;
    v_stored_cost := p_unit_cost;
  END IF;

  INSERT INTO stock_movements (tenant_id, inventory_item_id, site_id, movement_type, quantity, unit_cost, reference_type, reference_id, notes, created_by, created_at)
  VALUES (p_tenant_id, p_inventory_item_id, p_site_id, p_movement_type, v_stored_qty, v_stored_cost, p_reference_type, p_reference_id, p_notes, p_created_by, p_created_at)
  RETURNING id INTO v_movement_id;

  -- [2026-10-26-05] balance = FIFO replay of the card (the row above included)
  rp := _replay_stock_lots(p_inventory_item_id, p_site_id);
  v_new_qty := rp.qty;
  v_new_wac := CASE WHEN rp.qty > 0 THEN rp.fifo_value / rp.qty ELSE 0 END;

  INSERT INTO inventory_stock_balances (tenant_id, inventory_item_id, site_id, quantity_on_hand, weighted_average_cost, updated_at)
  VALUES (p_tenant_id, p_inventory_item_id, p_site_id, v_new_qty, v_new_wac, now())
  ON CONFLICT (inventory_item_id, site_id) DO UPDATE
    SET quantity_on_hand = v_new_qty, weighted_average_cost = v_new_wac, updated_at = now();

  RETURN QUERY SELECT v_movement_id, v_new_qty, v_new_wac;
END;
$function$;

REVOKE ALL ON FUNCTION public._apply_stock_movement(uuid, uuid, uuid, text, numeric, numeric, text, uuid, text, text, timestamptz) FROM PUBLIC, anon, authenticated;
