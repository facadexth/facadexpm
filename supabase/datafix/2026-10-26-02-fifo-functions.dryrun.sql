-- Rolled-back check for supabase/migrations/2026-10-26-02-fifo-lot-functions.sql
-- (controller runs it; always rolls back; prints one PASS/FAIL row per check).
-- Runs the migration body verbatim, then on the FacadeX tenant creates five
-- throw-away inventory items (fresh items isolate the ledgers; an existing FacadeX
-- site is reused rather than creating a temp tenant/site, which carry quota and
-- signup plumbing this check does not need):
--   I1  Review Focus 2: lot A (day 1, 10 @100), out 4 linked to A, THEN a lot B
--       back-dated to day 0 (10 @80). The out must still have consumed A: A = 6,
--       B = 10 intact, value 1400 -- the out's price did not move.
--   I2  control: same rows but the out carries no link (legacy) -> oldest-first
--       takes B instead (B = 6, A = 10). Proves the I1 asserts can fail.
--   I3  overshoot past every layer: no throw, deficit paid back by the next lot.
--   I4  linked overshoot -> remainder oldest-first; adjustment -/+; receipt_reversal
--       whose linked layer is already empty.
--   I5  inventory_lots_as_of: zero-cost layer excluded; min-after cap trims the
--       NEWEST layer.
-- Plus inventory_lots_as_of on I1 at day 0 / day 1 / before any stock, the exact
-- jsonb key names of both functions, and grants. inventory_lots_as_of runs as a
-- FacadeX OWNER/ADMIN via a transaction-local request.jwt.claims.
-- No object-removal keyword appears anywhere (the SQL runner rejects it).
BEGIN;

-- ===== migration body =====================================================
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
-- ===== end migration body =================================================

-- ===== probes =============================================================
CREATE TEMP TABLE _results (n int, check_name text, ok boolean, detail text);

DO $$
DECLARE
  v_tenant uuid := '1b9affc4-2136-4ed1-b168-a36e6624e743';  -- FacadeX
  v_site uuid;
  v_email text;
  i1 uuid; i2 uuid; i3 uuid; i4 uuid; i5 uuid;
  a1 uuid; b1 uuid; o1 uuid; a2 uuid; b2 uuid;
  x3 uuid; y3 uuid; p4 uuid; q4 uuid; r4 uuid; z5 uuid; l15 uuid; l25 uuid;
  r0 record; r1 record; r2 record; r3 record; r4r record;
  e jsonb;
BEGIN
  SELECT id INTO v_site FROM sites WHERE tenant_id = v_tenant ORDER BY id LIMIT 1;
  SELECT user_email INTO v_email FROM user_roles
   WHERE tenant_id = v_tenant AND role IN ('OWNER', 'ADMIN') ORDER BY role DESC LIMIT 1;

  INSERT INTO inventory_items (tenant_id, name, base_unit) VALUES (v_tenant, 'dryrun-fifo-I1', 'pcs') RETURNING id INTO i1;
  INSERT INTO inventory_items (tenant_id, name, base_unit) VALUES (v_tenant, 'dryrun-fifo-I2', 'pcs') RETURNING id INTO i2;
  INSERT INTO inventory_items (tenant_id, name, base_unit) VALUES (v_tenant, 'dryrun-fifo-I3', 'pcs') RETURNING id INTO i3;
  INSERT INTO inventory_items (tenant_id, name, base_unit) VALUES (v_tenant, 'dryrun-fifo-I4', 'pcs') RETURNING id INTO i4;
  INSERT INTO inventory_items (tenant_id, name, base_unit) VALUES (v_tenant, 'dryrun-fifo-I5', 'pcs') RETURNING id INTO i5;

  -- ---------- I1: Review Focus 2 ----------
  INSERT INTO stock_movements (tenant_id, inventory_item_id, site_id, movement_type, quantity, unit_cost, reference_type, created_by, created_at)
  VALUES (v_tenant, i1, v_site, 'purchase_in', 10, 100, 'dryrun', 'dryrun', timestamptz '2026-01-02 10:00+07') RETURNING id INTO a1;
  INSERT INTO stock_movements (tenant_id, inventory_item_id, site_id, movement_type, quantity, unit_cost, reference_type, created_by, created_at, lot_movement_id)
  VALUES (v_tenant, i1, v_site, 'sale_out', 4, 100, 'dryrun', 'dryrun', timestamptz '2026-01-02 11:00+07', a1) RETURNING id INTO o1;
  r0 := _replay_stock_lots(i1, v_site);   -- before the back-dated lot
  INSERT INTO stock_movements (tenant_id, inventory_item_id, site_id, movement_type, quantity, unit_cost, reference_type, created_by, created_at)
  VALUES (v_tenant, i1, v_site, 'purchase_in', 10, 80, 'dryrun', 'dryrun', timestamptz '2026-01-01 10:00+07') RETURNING id INTO b1;
  r1 := _replay_stock_lots(i1, v_site);   -- after

  INSERT INTO _results VALUES
    (1, 'I1 before back-date: one lot A with 6 left',
        jsonb_array_length(r0.lots) = 1 AND (r0.lots->0->>'movement_id')::uuid = a1 AND (r0.lots->0->>'qty')::numeric = 6,
        r0.lots::text),
    (2, 'I1 after back-date: lots oldest-first = [B, A]',
        jsonb_array_length(r1.lots) = 2 AND (r1.lots->0->>'movement_id')::uuid = b1 AND (r1.lots->1->>'movement_id')::uuid = a1,
        r1.lots::text),
    (3, 'I1 B intact at 10 @80',
        (r1.lots->0->>'qty')::numeric = 10 AND (r1.lots->0->>'unit_cost')::numeric = 80, (r1.lots->0)::text),
    (4, 'I1 A still consumed by exactly 4 (6 left @100), same as before the back-date',
        (r1.lots->1->>'qty')::numeric = 6 AND (r1.lots->1->>'unit_cost')::numeric = 100
          AND (r1.lots->1->>'qty')::numeric = (r0.lots->0->>'qty')::numeric, (r1.lots->1)::text),
    (5, 'I1 out row still names lot A, whose cost is 100 (out price did not move)',
        (SELECT sm.lot_movement_id = a1 AND l.unit_cost = 100
           FROM stock_movements sm JOIN stock_movements l ON l.id = sm.lot_movement_id WHERE sm.id = o1),
        NULL),
    (6, 'I1 qty 16, fifo_value 1400 (10x80 + 6x100), min_qty 0',
        r1.qty = 16 AND r1.fifo_value = 1400 AND r1.min_qty = 0,
        format('qty=%s value=%s min=%s', r1.qty, r1.fifo_value, r1.min_qty)),
    (7, '_replay_stock_lots lot keys = movement_id, created_at, unit_cost, qty',
        (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(r1.lots->0) k) = ARRAY['created_at', 'movement_id', 'qty', 'unit_cost'],
        (SELECT string_agg(k, ',' ORDER BY k) FROM jsonb_object_keys(r1.lots->0) k)),
    (8, 'I1 lot created_at = the in-row''s created_at',
        (r1.lots->0->>'created_at')::timestamptz = timestamptz '2026-01-01 10:00+07', r1.lots->0->>'created_at');

  -- ---------- I2: control (legacy out, no link) ----------
  INSERT INTO stock_movements (tenant_id, inventory_item_id, site_id, movement_type, quantity, unit_cost, reference_type, created_by, created_at)
  VALUES (v_tenant, i2, v_site, 'purchase_in', 10, 100, 'dryrun', 'dryrun', timestamptz '2026-01-02 10:00+07') RETURNING id INTO a2;
  INSERT INTO stock_movements (tenant_id, inventory_item_id, site_id, movement_type, quantity, unit_cost, reference_type, created_by, created_at)
  VALUES (v_tenant, i2, v_site, 'sale_out', 4, 100, 'dryrun', 'dryrun', timestamptz '2026-01-02 11:00+07');
  INSERT INTO stock_movements (tenant_id, inventory_item_id, site_id, movement_type, quantity, unit_cost, reference_type, created_by, created_at)
  VALUES (v_tenant, i2, v_site, 'purchase_in', 10, 80, 'dryrun', 'dryrun', timestamptz '2026-01-01 10:00+07') RETURNING id INTO b2;
  r2 := _replay_stock_lots(i2, v_site);
  INSERT INTO _results VALUES
    (9, 'I2 control: unlinked out goes oldest-first -> B 6, A 10, value 1480 (6x80 + 10x100)',
        (r2.lots->0->>'movement_id')::uuid = b2 AND (r2.lots->0->>'qty')::numeric = 6
          AND (r2.lots->1->>'movement_id')::uuid = a2 AND (r2.lots->1->>'qty')::numeric = 10
          AND r2.fifo_value = 1480,
        r2.lots::text);

  -- ---------- I3: overshoot past every layer ----------
  INSERT INTO stock_movements (tenant_id, inventory_item_id, site_id, movement_type, quantity, unit_cost, reference_type, created_by, created_at)
  VALUES (v_tenant, i3, v_site, 'purchase_in', 5, 10, 'dryrun', 'dryrun', timestamptz '2026-01-01 10:00+07') RETURNING id INTO x3;
  INSERT INTO stock_movements (tenant_id, inventory_item_id, site_id, movement_type, quantity, unit_cost, reference_type, created_by, created_at, lot_movement_id)
  VALUES (v_tenant, i3, v_site, 'sale_out', 8, 10, 'dryrun', 'dryrun', timestamptz '2026-01-01 11:00+07', x3);
  INSERT INTO stock_movements (tenant_id, inventory_item_id, site_id, movement_type, quantity, unit_cost, reference_type, created_by, created_at)
  VALUES (v_tenant, i3, v_site, 'purchase_in', 10, 20, 'dryrun', 'dryrun', timestamptz '2026-01-01 12:00+07') RETURNING id INTO y3;
  r3 := _replay_stock_lots(i3, v_site);
  INSERT INTO _results VALUES
    (10, 'I3 overshoot: no throw, min_qty -3, deficit 3 paid back -> one lot 7 @20, qty 7, value 140',
        r3.min_qty = -3 AND r3.qty = 7 AND r3.fifo_value = 140 AND jsonb_array_length(r3.lots) = 1
          AND (r3.lots->0->>'movement_id')::uuid = y3 AND (r3.lots->0->>'qty')::numeric = 7,
        format('qty=%s value=%s min=%s lots=%s', r3.qty, r3.fifo_value, r3.min_qty, r3.lots));

  -- ---------- I4: linked overshoot, adjustments, receipt_reversal ----------
  INSERT INTO stock_movements (tenant_id, inventory_item_id, site_id, movement_type, quantity, unit_cost, reference_type, created_by, created_at)
  VALUES (v_tenant, i4, v_site, 'purchase_in', 5, 10, 'dryrun', 'dryrun', timestamptz '2026-01-01 10:00+07') RETURNING id INTO p4;
  INSERT INTO stock_movements (tenant_id, inventory_item_id, site_id, movement_type, quantity, unit_cost, reference_type, created_by, created_at)
  VALUES (v_tenant, i4, v_site, 'purchase_in', 5, 20, 'dryrun', 'dryrun', timestamptz '2026-01-01 11:00+07') RETURNING id INTO q4;
  INSERT INTO stock_movements (tenant_id, inventory_item_id, site_id, movement_type, quantity, unit_cost, reference_type, created_by, created_at, lot_movement_id)
  VALUES (v_tenant, i4, v_site, 'sale_out', 7, 20, 'dryrun', 'dryrun', timestamptz '2026-01-01 12:00+07', q4);       -- Q 0, P 3
  INSERT INTO stock_movements (tenant_id, inventory_item_id, site_id, movement_type, quantity, unit_cost, reference_type, created_by, created_at)
  VALUES (v_tenant, i4, v_site, 'adjustment', -1, 10, 'dryrun', 'dryrun', timestamptz '2026-01-01 13:00+07');          -- P 2
  INSERT INTO stock_movements (tenant_id, inventory_item_id, site_id, movement_type, quantity, unit_cost, reference_type, created_by, created_at, lot_movement_id)
  VALUES (v_tenant, i4, v_site, 'receipt_reversal', 1, 20, 'dryrun', 'dryrun', timestamptz '2026-01-01 14:00+07', q4); -- Q empty -> P 1
  INSERT INTO stock_movements (tenant_id, inventory_item_id, site_id, movement_type, quantity, unit_cost, reference_type, created_by, created_at)
  VALUES (v_tenant, i4, v_site, 'adjustment', 2, 30, 'dryrun', 'dryrun', timestamptz '2026-01-01 15:00+07') RETURNING id INTO r4; -- new lot 2 @30
  r4r := _replay_stock_lots(i4, v_site);
  INSERT INTO _results VALUES
    (11, 'I4 lots = [P 1 @10, R 2 @30], qty 3, value 70, min_qty 0',
        jsonb_array_length(r4r.lots) = 2
          AND (r4r.lots->0->>'movement_id')::uuid = p4 AND (r4r.lots->0->>'qty')::numeric = 1
          AND (r4r.lots->1->>'movement_id')::uuid = r4 AND (r4r.lots->1->>'qty')::numeric = 2
          AND (r4r.lots->1->>'unit_cost')::numeric = 30
          AND r4r.qty = 3 AND r4r.fifo_value = 70 AND r4r.min_qty = 0,
        format('qty=%s value=%s min=%s lots=%s', r4r.qty, r4r.fifo_value, r4r.min_qty, r4r.lots));

  -- ---------- I5: as-of cap + zero-cost layer ----------
  INSERT INTO stock_movements (tenant_id, inventory_item_id, site_id, movement_type, quantity, unit_cost, reference_type, created_by, created_at)
  VALUES (v_tenant, i5, v_site, 'adjustment', 2, 0, 'dryrun', 'dryrun', timestamptz '2026-01-01 08:00+07') RETURNING id INTO z5;
  INSERT INTO stock_movements (tenant_id, inventory_item_id, site_id, movement_type, quantity, unit_cost, reference_type, created_by, created_at)
  VALUES (v_tenant, i5, v_site, 'purchase_in', 5, 10, 'dryrun', 'dryrun', timestamptz '2026-01-01 09:00+07') RETURNING id INTO l15;
  INSERT INTO stock_movements (tenant_id, inventory_item_id, site_id, movement_type, quantity, unit_cost, reference_type, created_by, created_at)
  VALUES (v_tenant, i5, v_site, 'purchase_in', 5, 20, 'dryrun', 'dryrun', timestamptz '2026-01-01 10:00+07') RETURNING id INTO l25;
  INSERT INTO stock_movements (tenant_id, inventory_item_id, site_id, movement_type, quantity, unit_cost, reference_type, created_by, created_at)
  VALUES (v_tenant, i5, v_site, 'sale_out', 7, 10, 'dryrun', 'dryrun', timestamptz '2026-01-03 10:00+07');  -- after the cutoff: 12 -> 5

  -- ---------- inventory_lots_as_of (as a FacadeX owner/admin) ----------
  PERFORM set_config('request.jwt.claims', json_build_object('email', v_email, 'role', 'authenticated')::text, true);
  INSERT INTO _results VALUES (12, 'caller resolves to FacadeX with stock access',
    current_tenant_id() = v_tenant AND is_admin_or_owner() AND has_module_access('purchase_orders'), v_email);

  -- I5 as of 2026-01-01: on hand Z 2 (@0), L1 5 (@10), L2 5 (@20) = 12; min after = 5
  -- -> Z skipped, cap 5 trims the newest (L2) -> [L1 5 @10]
  e := NULL;
  SELECT x INTO e FROM jsonb_array_elements(inventory_lots_as_of(date '2026-01-01', ARRAY[v_site])) x
   WHERE (x->>'inventory_item_id')::uuid = i5;
  INSERT INTO _results VALUES
    (13, 'I5 as of day 0: zero-cost lot excluded, cap 5 trims newest -> [L1 5 @10], quantity_on_hand 5',
        e IS NOT NULL AND (e->>'quantity_on_hand')::numeric = 5 AND jsonb_array_length(e->'lots') = 1
          AND (e->'lots'->0->>'movement_id')::uuid = l15 AND (e->'lots'->0->>'qty')::numeric = 5
          AND (e->'lots'->0->>'unit_cost')::numeric = 10,
        e::text),
    (14, 'I5 first_received_at = first receipt (the zero-cost adjustment, as inventory_balances_as_of counts it)',
        (e->>'first_received_at')::timestamptz = timestamptz '2026-01-01 08:00+07', e->>'first_received_at');

  -- I1 as of day 0 (2026-01-01): only B existed -> [B 10 @80]; later rows (A in, out 4) never dip below 10
  e := NULL;
  SELECT x INTO e FROM jsonb_array_elements(inventory_lots_as_of(date '2026-01-01', ARRAY[v_site])) x
   WHERE (x->>'inventory_item_id')::uuid = i1;
  INSERT INTO _results VALUES
    (15, 'I1 as of day 0: [B 10 @80] only, quantity_on_hand 10, site + received_at echoed',
        e IS NOT NULL AND (e->>'quantity_on_hand')::numeric = 10 AND jsonb_array_length(e->'lots') = 1
          AND (e->'lots'->0->>'movement_id')::uuid = b1 AND (e->'lots'->0->>'unit_cost')::numeric = 80
          AND (e->>'site_id')::uuid = v_site
          AND (e->'lots'->0->>'received_at')::timestamptz = timestamptz '2026-01-01 10:00+07',
        e::text),
    (16, 'inventory_lots_as_of element keys = inventory_item_id, site_id, quantity_on_hand, first_received_at, lots',
        (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(e) k)
          = ARRAY['first_received_at', 'inventory_item_id', 'lots', 'quantity_on_hand', 'site_id'],
        (SELECT string_agg(k, ',' ORDER BY k) FROM jsonb_object_keys(e) k)),
    (17, 'inventory_lots_as_of lot keys = movement_id, received_at, unit_cost, qty',
        (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(e->'lots'->0) k) = ARRAY['movement_id', 'qty', 'received_at', 'unit_cost'],
        (SELECT string_agg(k, ',' ORDER BY k) FROM jsonb_object_keys(e->'lots'->0) k));

  -- I1 as of day 1: [B 10, A 6], quantity_on_hand 16
  e := NULL;
  SELECT x INTO e FROM jsonb_array_elements(inventory_lots_as_of(date '2026-01-02', ARRAY[v_site])) x
   WHERE (x->>'inventory_item_id')::uuid = i1;
  INSERT INTO _results VALUES
    (18, 'I1 as of day 1: [B 10 @80, A 6 @100], quantity_on_hand 16',
        e IS NOT NULL AND (e->>'quantity_on_hand')::numeric = 16 AND jsonb_array_length(e->'lots') = 2
          AND (e->'lots'->0->>'movement_id')::uuid = b1 AND (e->'lots'->0->>'qty')::numeric = 10
          AND (e->'lots'->1->>'movement_id')::uuid = a1 AND (e->'lots'->1->>'qty')::numeric = 6,
        e::text);

  -- I1 before any of its stock: absent
  INSERT INTO _results VALUES
    (19, 'I1 as of 2025-12-31 (before its first lot): not returned',
        NOT EXISTS (SELECT 1 FROM jsonb_array_elements(inventory_lots_as_of(date '2025-12-31', ARRAY[v_site])) x
                    WHERE (x->>'inventory_item_id')::uuid = i1),
        NULL);

  -- I3 as of day 0: all three rows are before 23:59 -> the paid-back layer 7 @20
  e := NULL;
  SELECT x INTO e FROM jsonb_array_elements(inventory_lots_as_of(date '2026-01-01', ARRAY[v_site])) x
   WHERE (x->>'inventory_item_id')::uuid = i3;
  INSERT INTO _results VALUES
    (20, 'I3 as of day 0: [Y 7 @20] (deficit paid back), quantity_on_hand 7',
        e IS NOT NULL AND (e->>'quantity_on_hand')::numeric = 7 AND (e->'lots'->0->>'movement_id')::uuid = y3,
        e::text);

  -- whole-tenant smoke: the RPC runs over every real FacadeX site without raising
  INSERT INTO _results VALUES
    (21, 'inventory_lots_as_of over all FacadeX sites returns a jsonb array (no throw on legacy data)',
        jsonb_typeof(inventory_lots_as_of(current_date, (SELECT array_agg(id) FROM sites WHERE tenant_id = v_tenant))) = 'array',
        NULL);

  -- grants
  INSERT INTO _results VALUES
    (22, 'authenticated may call inventory_lots_as_of but not the helpers; anon may not call it',
        has_function_privilege('authenticated', 'public.inventory_lots_as_of(date, uuid[])', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.inventory_lots_as_of(date, uuid[])', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public._replay_stock_lots(uuid, uuid)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public._fifo_consume(uuid[], numeric[], uuid, numeric)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public._fifo_pickable_lots(uuid[], timestamptz[], numeric[], numeric[], numeric)', 'EXECUTE'),
        NULL);
END $$;

SELECT n, CASE WHEN coalesce(ok, false) THEN 'PASS' ELSE 'FAIL' END AS result, check_name, detail
FROM _results ORDER BY n;

ROLLBACK;
