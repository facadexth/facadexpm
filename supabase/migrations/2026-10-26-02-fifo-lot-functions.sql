-- FIFO + MO/OB stock documents, step 2: lot replay + lots-as-of RPC
-- (owner-approved design 2026-10-26). Read-only functions; nothing is written.
--
--   _fifo_consume          pure helper: take an amount out of a set of layers
--                          (named layer first, then oldest-first), never below 0
--   _fifo_pickable_lots    pure helper: the layers a cut may take, as jsonb
--   _replay_stock_lots     one item/site's ledger replayed oldest first into
--                          FIFO layers (parallels _replay_stock_balance)
--   inventory_lots_as_of   what an invoice dated p_date may take, per lot
--                          (parallels inventory_balances_as_of)
--
-- Replay rules (ORDER BY created_at, id), as a signed delta d per row:
--   purchase_in / transfer_in / sale_reversal   d = +quantity
--   adjustment                                  d = quantity (stored signed)
--   sale_out / transfer_out / purchase_return /
--   receipt_reversal                            d = -quantity
--   d > 0  pushes a layer at the row's unit_cost (id = the row's id)
--   d < 0  consumes |d|: from the row's lot_movement_id layer first (adjustments
--          ignore the link and go oldest-first), then oldest-first.
-- An out that overshoots its layer is clamped at 0 and the rest is taken oldest-
-- first; legacy data can be inconsistent, so nothing here ever raises on it.
-- If every layer is empty the unmatched amount is remembered as a deficit and the
-- next in-row pays it back before its layer opens, so Σ layers always equals
-- max(running qty, 0) -- the same qty the WAC replay reports.
--
-- Because an out names its lot, a purchase back-dated in front of an already-posted
-- out lands as an older layer but does not change which lot (and so which price)
-- that out consumed -- only future picks see it.

-- Takes p_amount out of the layers p_qty (parallel to p_ids, oldest first): the
-- p_link layer first when it is present, then oldest-first. A layer never goes
-- below 0. shortfall = what could not be taken (every layer empty).
CREATE OR REPLACE FUNCTION public._fifo_consume(
  p_ids uuid[], p_qty numeric[], p_link uuid, p_amount numeric,
  OUT qtys numeric[], OUT shortfall numeric)
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'public'
AS $function$
DECLARE i int; take numeric;
BEGIN
  qtys := coalesce(p_qty, '{}');
  shortfall := greatest(coalesce(p_amount, 0), 0);
  IF shortfall = 0 THEN RETURN; END IF;

  IF p_link IS NOT NULL THEN
    i := array_position(p_ids, p_link);
    IF i IS NOT NULL AND qtys[i] > 0 THEN
      take := least(shortfall, qtys[i]);
      qtys[i] := qtys[i] - take;
      shortfall := shortfall - take;
    END IF;
  END IF;

  FOR i IN 1 .. coalesce(array_length(qtys, 1), 0) LOOP
    EXIT WHEN shortfall <= 0;
    IF qtys[i] > 0 THEN
      take := least(shortfall, qtys[i]);
      qtys[i] := qtys[i] - take;
      shortfall := shortfall - take;
    END IF;
  END LOOP;
END;
$function$;

REVOKE ALL ON FUNCTION public._fifo_consume(uuid[], numeric[], uuid, numeric) FROM PUBLIC, anon, authenticated;

-- The layers a cut may take, oldest first: layers with no stock or a unit_cost
-- <= 0 are skipped (a cost-less layer is not free stock -- same rule as the old
-- weighted_average_cost > 0 filter), and the total is capped at p_cap by
-- trimming the NEWEST layers, so the oldest stay pickable (FIFO).
-- Shape: [{"movement_id","received_at","unit_cost","qty"}].
CREATE OR REPLACE FUNCTION public._fifo_pickable_lots(
  p_ids uuid[], p_at timestamptz[], p_cost numeric[], p_qty numeric[], p_cap numeric)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'public'
AS $function$
DECLARE i int; left_ numeric := greatest(coalesce(p_cap, 0), 0); take numeric; v_out jsonb := '[]';
BEGIN
  FOR i IN 1 .. coalesce(array_length(p_ids, 1), 0) LOOP
    EXIT WHEN left_ <= 0;
    IF p_qty[i] > 0 AND p_cost[i] > 0 THEN
      take := least(p_qty[i], left_);
      left_ := left_ - take;
      v_out := v_out || jsonb_build_array(jsonb_build_object(
        'movement_id', p_ids[i], 'received_at', p_at[i], 'unit_cost', p_cost[i], 'qty', take));
    END IF;
  END LOOP;
  RETURN v_out;
END;
$function$;

REVOKE ALL ON FUNCTION public._fifo_pickable_lots(uuid[], timestamptz[], numeric[], numeric[], numeric)
  FROM PUBLIC, anon, authenticated;

-- Replays one item/site's ledger, oldest first, into FIFO layers. Returns:
--   qty        final running qty (same as _replay_stock_balance)
--   fifo_value Σ remaining layer qty × unit_cost
--   min_qty    lowest running qty along the way (negative = the card dips below 0)
--   lots       remaining layers oldest first: [{"movement_id","created_at","unit_cost","qty"}]
CREATE OR REPLACE FUNCTION public._replay_stock_lots(p_item uuid, p_site uuid,
  OUT qty numeric, OUT fifo_value numeric, OUT min_qty numeric, OUT lots jsonb)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  m record; c record;
  l_id uuid[] := '{}'; l_at timestamptz[] := '{}'; l_cost numeric[] := '{}'; l_qty numeric[] := '{}';
  deficit numeric := 0; d numeric; absorb numeric; i int;
BEGIN
  qty := 0; fifo_value := 0; min_qty := 0; lots := '[]';
  FOR m IN SELECT id, movement_type, quantity, unit_cost, created_at, lot_movement_id
           FROM stock_movements
           WHERE inventory_item_id = p_item AND site_id = p_site
           ORDER BY created_at, id LOOP
    d := CASE WHEN m.movement_type IN ('purchase_in', 'transfer_in', 'sale_reversal', 'adjustment')
              THEN coalesce(m.quantity, 0)
              ELSE -coalesce(m.quantity, 0) END;  -- sale_out, transfer_out, purchase_return, receipt_reversal
    qty := qty + d;

    IF d > 0 THEN
      -- stock taken while the card was empty is paid back before the new layer opens
      absorb := least(deficit, d);
      deficit := deficit - absorb;
      IF d - absorb > 0 THEN
        l_id := l_id || m.id; l_at := l_at || m.created_at;
        l_cost := l_cost || coalesce(m.unit_cost, 0); l_qty := l_qty || (d - absorb);
      END IF;
    ELSIF d < 0 THEN
      SELECT * INTO c FROM _fifo_consume(l_id, l_qty,
        CASE WHEN m.movement_type = 'adjustment' THEN NULL ELSE m.lot_movement_id END, -d);
      l_qty := c.qtys;
      deficit := deficit + c.shortfall;
    END IF;

    min_qty := least(min_qty, qty);
  END LOOP;

  FOR i IN 1 .. coalesce(array_length(l_id, 1), 0) LOOP
    IF l_qty[i] > 0 THEN
      fifo_value := fifo_value + l_qty[i] * l_cost[i];
      lots := lots || jsonb_build_array(jsonb_build_object(
        'movement_id', l_id[i], 'created_at', l_at[i], 'unit_cost', l_cost[i], 'qty', l_qty[i]));
    END IF;
  END LOOP;
END;
$function$;

REVOKE ALL ON FUNCTION public._replay_stock_lots(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- Lots the deduction of an invoice dated p_date may take, per item/site (only
-- p_site_ids). A cut lands at p_date 23:59 Bangkok, so for each card:
--   cap               = min(qty at that moment, every later running qty)
--                       -- taking more would push the card negative somewhere
--                       between then and today (same discipline as
--                       inventory_balances_as_of)
--   lots              = the layers on hand at that moment, cost-less ones
--                       skipped, total capped at `cap` by trimming the newest
--   quantity_on_hand  = Σ lots.qty (exactly what may be taken)
--   first_received_at = first receipt up to that moment (FIFO item order)
-- Only cards with something to take come back. One jsonb array, so the API's
-- 1000-row cap never truncates it. Shape per element:
--   {"inventory_item_id","site_id","quantity_on_hand","first_received_at",
--    "lots":[{"movement_id","received_at","unit_cost","qty"}]}
CREATE OR REPLACE FUNCTION public.inventory_lots_as_of(p_date date, p_site_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant_id uuid := current_tenant_id();
  v_at timestamptz := (p_date + time '23:59') AT TIME ZONE 'Asia/Bangkok';
  v_out jsonb[] := '{}';
  m record; c record;
  k_item uuid; k_site uuid;
  qty numeric; d numeric; deficit numeric; absorb numeric;
  l_id uuid[]; l_at timestamptz[]; l_cost numeric[]; l_qty numeric[];
  snapped boolean; at_qty numeric; at_qtys numeric[]; at_n int;
  min_after numeric; first_at timestamptz; v_lots jsonb; v_sum numeric;
BEGIN
  IF NOT (is_admin_or_owner() AND has_module_access('purchase_orders')) THEN
    RAISE EXCEPTION 'insufficient_privilege';
  END IF;
  IF p_date IS NULL THEN RAISE EXCEPTION 'p_date is required'; END IF;

  -- The extra NULL row at the end flushes the last card (no copy of the emit code).
  FOR m IN
    SELECT * FROM (
      SELECT inventory_item_id, site_id, id, movement_type, quantity, unit_cost, created_at, lot_movement_id, false AS sentinel
      FROM stock_movements
      WHERE tenant_id = v_tenant_id AND site_id = ANY (p_site_ids)
      UNION ALL
      SELECT NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, true
    ) s
    ORDER BY sentinel, inventory_item_id, site_id, created_at, id
  LOOP
    IF m.sentinel OR k_item IS DISTINCT FROM m.inventory_item_id OR k_site IS DISTINCT FROM m.site_id THEN
      IF k_item IS NOT NULL THEN
        IF NOT snapped THEN at_qty := qty; at_qtys := l_qty; at_n := coalesce(array_length(l_id, 1), 0); END IF;
        -- layers pushed after the cutoff (index > at_n) did not exist at that moment
        v_lots := _fifo_pickable_lots(l_id[1:at_n], l_at[1:at_n], l_cost[1:at_n], at_qtys[1:at_n],
                                      least(at_qty, coalesce(min_after, at_qty)));
        SELECT coalesce(sum((e->>'qty')::numeric), 0) INTO v_sum FROM jsonb_array_elements(v_lots) e;
        IF v_sum > 0 THEN
          v_out := array_append(v_out, jsonb_build_object('inventory_item_id', k_item, 'site_id', k_site,
            'quantity_on_hand', v_sum, 'first_received_at', first_at, 'lots', v_lots));
        END IF;
      END IF;
      EXIT WHEN m.sentinel;
      k_item := m.inventory_item_id; k_site := m.site_id;
      qty := 0; deficit := 0;
      l_id := '{}'; l_at := '{}'; l_cost := '{}'; l_qty := '{}';
      snapped := false; at_qty := NULL; at_qtys := NULL; at_n := 0; min_after := NULL; first_at := NULL;
    END IF;

    IF m.created_at > v_at AND NOT snapped THEN
      -- state at the invoice moment
      snapped := true; at_qty := qty; at_qtys := l_qty; at_n := coalesce(array_length(l_id, 1), 0);
    END IF;

    -- same replay as _replay_stock_lots
    d := CASE WHEN m.movement_type IN ('purchase_in', 'transfer_in', 'sale_reversal', 'adjustment')
              THEN coalesce(m.quantity, 0)
              ELSE -coalesce(m.quantity, 0) END;
    qty := qty + d;
    IF d > 0 THEN
      absorb := least(deficit, d);
      deficit := deficit - absorb;
      IF d - absorb > 0 THEN
        l_id := l_id || m.id; l_at := l_at || m.created_at;
        l_cost := l_cost || coalesce(m.unit_cost, 0); l_qty := l_qty || (d - absorb);
      END IF;
    ELSIF d < 0 THEN
      SELECT * INTO c FROM _fifo_consume(l_id, l_qty,
        CASE WHEN m.movement_type = 'adjustment' THEN NULL ELSE m.lot_movement_id END, -d);
      l_qty := c.qtys;
      deficit := deficit + c.shortfall;
    END IF;

    IF m.created_at <= v_at THEN
      IF first_at IS NULL AND (m.movement_type IN ('purchase_in', 'transfer_in', 'sale_reversal') OR (m.movement_type = 'adjustment' AND m.quantity > 0)) THEN
        first_at := m.created_at;
      END IF;
    ELSE
      min_after := least(coalesce(min_after, qty), qty);
    END IF;
  END LOOP;

  RETURN to_jsonb(v_out);
END;
$function$;

REVOKE ALL ON FUNCTION public.inventory_lots_as_of(date, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inventory_lots_as_of(date, uuid[]) TO authenticated;
