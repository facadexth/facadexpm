-- Rolled-back check for supabase/migrations/2026-10-26-05-apply-movement-replay-balance.sql
-- (controller runs it AFTER migrations -01 .. -04 are live, or with their bodies prepended
-- inside the same transaction; always rolls back; prints one PASS/FAIL row per check).
-- Runs the migration body verbatim, then on the FacadeX tenant, one job site, one
-- throw-away item: a manual adjustment DOWN on a 2-lot card -> balance = replay (oldest lot
-- consumed, not the blended WAC), stored row unchanged (delta at stored WAC); a purchase_in
-- returns the replay values, equal to the blend; sale_out / purchase_return / adjustment up
-- likewise; whitelist + validations + grants unchanged.
BEGIN;

-- ===== migration body =====================================================
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
-- ===== end migration body =================================================

-- ===== probes =============================================================
CREATE TEMP TABLE _results (n int, check_name text, ok boolean, detail text);

-- fixture helper: one raw ledger row (no balance write)
CREATE FUNCTION pg_temp.t08_mv(p_tenant uuid, p_item uuid, p_site uuid, p_type text, p_qty numeric, p_cost numeric,
                               p_at timestamptz)
RETURNS uuid LANGUAGE sql AS $f$
  INSERT INTO stock_movements (tenant_id, inventory_item_id, site_id, movement_type, quantity, unit_cost,
                               reference_type, reference_id, notes, created_by, created_at)
  VALUES (p_tenant, p_item, p_site, p_type, p_qty, p_cost, 'dryrun', NULL, 'dryrun 08', 'dryrun', p_at)
  RETURNING id
$f$;

-- remaining qty of one lot in the card's FIFO replay (0 when the lot is not there)
CREATE FUNCTION pg_temp.t08_lot(p_item uuid, p_site uuid, p_lot uuid)
RETURNS numeric LANGUAGE sql AS $f$
  SELECT coalesce((SELECT (e->>'qty')::numeric
                     FROM jsonb_array_elements((public._replay_stock_lots(p_item, p_site)).lots) e
                    WHERE (e->>'movement_id')::uuid = p_lot), 0)
$f$;

-- stored balance equals the FIFO replay (qty, fifo_value / qty)
CREATE FUNCTION pg_temp.t08_bal_ok(p_item uuid, p_site uuid)
RETURNS boolean LANGUAGE sql AS $f$
  SELECT coalesce(b.quantity_on_hand = r.qty
                  AND b.weighted_average_cost = CASE WHEN r.qty > 0 THEN r.fifo_value / r.qty ELSE 0 END, false)
    FROM public._replay_stock_lots(p_item, p_site) r
    LEFT JOIN public.inventory_stock_balances b ON b.inventory_item_id = p_item AND b.site_id = p_site
$f$;

CREATE FUNCTION pg_temp.t08_card(p_item uuid, p_site uuid)
RETURNS text LANGUAGE sql AS $f$
  SELECT format('bal qty=%s wac=%s | replay qty=%s value=%s lots=%s',
                b.quantity_on_hand, b.weighted_average_cost, r.qty, r.fifo_value, r.lots)
    FROM public._replay_stock_lots(p_item, p_site) r
    LEFT JOIN public.inventory_stock_balances b ON b.inventory_item_id = p_item AND b.site_id = p_site
$f$;

-- One throw-away item on a FacadeX job site: L1 5 @10 (Jan 1), L2 5 @20 (Jan 2), stored
-- balance 10 @15 (the WAC blend = replay value 150 / 10). Then, through
-- _apply_stock_movement (the path record_stock_movement and the batch take):
--   1 adjustment to count 7 (down 3): row stores delta -3 at the stored WAC 15 (unchanged
--     rule); balance = replay: oldest lot L1 consumed -> L1 2, L2 5 -> 7 @ 120/7 (the old
--     incremental write would have left 7 @15)
--   2 purchase_in 3 @30: row 3 @30; replay 10 @21 = the blend (7 x 120/7 + 90) / 10 = 21
--   3 sale_out 4 (unlinked): replay oldest-first -> L2 3, L3 3 -> 6 @25 (old: WAC kept 21)
--   4 purchase_return 1: row stores the stored WAC 25 (caller's 99 ignored, unchanged rule);
--     replay -> L2 2, L3 3 -> 5 @26
--   5 adjustment UP to 8 at 40: row +3 @40; replay adds a 3 @40 layer -> 8 @ 250/8
--   6 refusals unchanged: receipt_reversal type, purchase_return beyond stock, negative count
DO $$
DECLARE
  v_tenant uuid := '1b9affc4-2136-4ed1-b168-a36e6624e743';  -- FacadeX
  v_s uuid; v_it uuid; v_l1 uuid; v_l2 uuid; v_l3 uuid;
  rv record; x record; v_err text; v_n int;
  t_jan1 timestamptz := timestamptz '2026-01-01 10:00+07';
BEGIN
  SELECT id INTO v_s FROM sites WHERE tenant_id = v_tenant AND NOT is_default ORDER BY id LIMIT 1;
  INSERT INTO _results VALUES (1, 'setup: FacadeX has a job site', v_s IS NOT NULL, v_s::text);

  INSERT INTO inventory_items (tenant_id, name, base_unit) VALUES (v_tenant, 'dryrun-08-A', 'pcs') RETURNING id INTO v_it;
  v_l1 := pg_temp.t08_mv(v_tenant, v_it, v_s, 'purchase_in', 5, 10, t_jan1);
  v_l2 := pg_temp.t08_mv(v_tenant, v_it, v_s, 'purchase_in', 5, 20, timestamptz '2026-01-02 10:00+07');
  INSERT INTO inventory_stock_balances (tenant_id, inventory_item_id, site_id, quantity_on_hand, weighted_average_cost, updated_at)
  VALUES (v_tenant, v_it, v_s, 10, 15, now());

  -- 1 adjustment down on a 2-lot card
  SELECT * INTO rv FROM _apply_stock_movement(v_tenant, v_it, v_s, 'adjustment', 7, NULL, 'dryrun', NULL,
                                               'dryrun 08 count', 'dryrun', timestamptz '2026-01-03 10:00+07');
  SELECT * INTO x FROM stock_movements WHERE id = rv.movement_id;
  INSERT INTO _results VALUES (2, 'adjustment down 10 -> 7: row unchanged (delta -3 at stored WAC 15)',
    x.movement_type = 'adjustment' AND x.quantity = -3 AND x.unit_cost = 15 AND x.lot_movement_id IS NULL,
    format('q=%s c=%s lot=%s', x.quantity, x.unit_cost, x.lot_movement_id));
  INSERT INTO _results VALUES (3, 'adjustment down: balance = replay, OLDEST lot consumed (L1 2, L2 5) -> 7 @ 120/7, not 7 @15; return = replay',
    pg_temp.t08_bal_ok(v_it, v_s) AND pg_temp.t08_lot(v_it, v_s, v_l1) = 2 AND pg_temp.t08_lot(v_it, v_s, v_l2) = 5
      AND rv.new_quantity_on_hand = 7 AND abs(rv.new_weighted_average_cost - 120.0 / 7) < 1e-9
      AND (SELECT weighted_average_cost <> 15 FROM inventory_stock_balances WHERE inventory_item_id = v_it AND site_id = v_s),
    format('ret q=%s w=%s | %s', rv.new_quantity_on_hand, rv.new_weighted_average_cost, pg_temp.t08_card(v_it, v_s)));

  -- 2 purchase_in
  SELECT * INTO rv FROM _apply_stock_movement(v_tenant, v_it, v_s, 'purchase_in', 3, 30, 'dryrun', NULL,
                                               'dryrun 08 in', 'dryrun', timestamptz '2026-01-04 10:00+07');
  v_l3 := rv.movement_id;
  SELECT * INTO x FROM stock_movements WHERE id = rv.movement_id;
  INSERT INTO _results VALUES (4, 'purchase_in 3 @30: row 3 @30; return = replay 10 @21 (= the blended value); balance = replay',
    x.quantity = 3 AND x.unit_cost = 30 AND rv.new_quantity_on_hand = 10 AND rv.new_weighted_average_cost = 21
      AND pg_temp.t08_bal_ok(v_it, v_s),
    format('ret q=%s w=%s | %s', rv.new_quantity_on_hand, rv.new_weighted_average_cost, pg_temp.t08_card(v_it, v_s)));

  -- 3 sale_out, unlinked
  SELECT * INTO rv FROM _apply_stock_movement(v_tenant, v_it, v_s, 'sale_out', 4, 21, 'dryrun', NULL,
                                               'dryrun 08 out', 'dryrun', timestamptz '2026-01-05 10:00+07');
  INSERT INTO _results VALUES (5, 'sale_out 4: row 4 @21 (caller cost); replay oldest-first L1 gone, L2 3, L3 3 -> 6 @25 (old write kept 21)',
    (SELECT quantity = 4 AND unit_cost = 21 FROM stock_movements WHERE id = rv.movement_id)
      AND pg_temp.t08_lot(v_it, v_s, v_l1) = 0 AND pg_temp.t08_lot(v_it, v_s, v_l2) = 3 AND pg_temp.t08_lot(v_it, v_s, v_l3) = 3
      AND rv.new_quantity_on_hand = 6 AND rv.new_weighted_average_cost = 25 AND pg_temp.t08_bal_ok(v_it, v_s),
    format('ret q=%s w=%s | %s', rv.new_quantity_on_hand, rv.new_weighted_average_cost, pg_temp.t08_card(v_it, v_s)));

  -- 4 purchase_return: stored cost = stored WAC (unchanged rule)
  SELECT * INTO rv FROM _apply_stock_movement(v_tenant, v_it, v_s, 'purchase_return', 1, 99, 'dryrun', NULL,
                                               'dryrun 08 return', 'dryrun', timestamptz '2026-01-06 10:00+07');
  INSERT INTO _results VALUES (6, 'purchase_return 1: row stores the stored WAC 25 (caller 99 ignored); replay -> L2 2, L3 3 = 5 @26',
    (SELECT quantity = 1 AND unit_cost = 25 FROM stock_movements WHERE id = rv.movement_id)
      AND rv.new_quantity_on_hand = 5 AND rv.new_weighted_average_cost = 26 AND pg_temp.t08_bal_ok(v_it, v_s),
    format('ret q=%s w=%s | %s', rv.new_quantity_on_hand, rv.new_weighted_average_cost, pg_temp.t08_card(v_it, v_s)));

  -- 5 adjustment up with a cost
  SELECT * INTO rv FROM _apply_stock_movement(v_tenant, v_it, v_s, 'adjustment', 8, 40, 'dryrun', NULL,
                                               'dryrun 08 count up', 'dryrun', timestamptz '2026-01-07 10:00+07');
  INSERT INTO _results VALUES (7, 'adjustment up 5 -> 8 at 40: row +3 @40; replay adds a 3 @40 layer -> 8 @ 250/8',
    (SELECT quantity = 3 AND unit_cost = 40 FROM stock_movements WHERE id = rv.movement_id)
      AND pg_temp.t08_lot(v_it, v_s, rv.movement_id) = 3
      AND rv.new_quantity_on_hand = 8 AND rv.new_weighted_average_cost = 250.0 / 8 AND pg_temp.t08_bal_ok(v_it, v_s),
    format('ret q=%s w=%s | %s', rv.new_quantity_on_hand, rv.new_weighted_average_cost, pg_temp.t08_card(v_it, v_s)));

  -- 6 refusals unchanged, nothing written
  SELECT count(*) INTO v_n FROM stock_movements WHERE inventory_item_id = v_it;
  v_err := NULL;
  BEGIN
    PERFORM _apply_stock_movement(v_tenant, v_it, v_s, 'receipt_reversal', 1, 10, 'dryrun', NULL, NULL, 'dryrun', now());
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  INSERT INTO _results VALUES (8, 'whitelist kept: receipt_reversal refused', v_err = 'unsupported_movement_type: receipt_reversal', v_err);
  v_err := NULL;
  BEGIN
    PERFORM _apply_stock_movement(v_tenant, v_it, v_s, 'purchase_return', 9, 10, 'dryrun', NULL, NULL, 'dryrun', now());
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  INSERT INTO _results VALUES (9, 'purchase_return beyond the stored qty refused (insufficient_stock)', v_err = 'insufficient_stock', v_err);
  v_err := NULL;
  BEGIN
    PERFORM _apply_stock_movement(v_tenant, v_it, v_s, 'adjustment', -1, NULL, 'dryrun', NULL, NULL, 'dryrun', now());
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  INSERT INTO _results VALUES (10, 'negative adjustment count refused; no row written by any refusal',
    v_err = 'adjustment quantity (new absolute count) must be zero or positive'
      AND (SELECT count(*) FROM stock_movements WHERE inventory_item_id = v_it) = v_n, v_err);

  INSERT INTO _results VALUES (11, 'grants unchanged: no client role may call _apply_stock_movement',
    NOT has_function_privilege('authenticated', 'public._apply_stock_movement(uuid, uuid, uuid, text, numeric, numeric, text, uuid, text, text, timestamptz)', 'EXECUTE')
      AND NOT has_function_privilege('anon', 'public._apply_stock_movement(uuid, uuid, uuid, text, numeric, numeric, text, uuid, text, text, timestamptz)', 'EXECUTE'),
    NULL);
END $$;

SELECT n, CASE WHEN coalesce(ok, false) THEN 'PASS' ELSE 'FAIL' END AS result, check_name, detail
FROM _results ORDER BY n;

ROLLBACK;
