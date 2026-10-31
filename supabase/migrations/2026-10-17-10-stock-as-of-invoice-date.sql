-- Invoice stock deduction works from the stock AS OF THE INVOICE DATE
-- (owner, 2026-10-17). The cut is dated to the invoice date, but the plan
-- used to be built from TODAY's balances: a back-dated invoice could take
-- stock that only arrived later (stock card negative in between, 17 cards
-- for IN2608-006) and used today's average cost instead of that day's.
--
--   _replay_stock_balance        one item/site's ledger replayed oldest
--                                first (record_stock_movement's rules)
--   inventory_balances_as_of     what the deduction plan may take
--   post_invoice_stock_deduction now rebuilds every touched balance from
--                                its ledger and refuses (all or nothing)
--                                if any stock card would go negative

-- Replays one item/site's ledger, oldest first. Returns the final qty and
-- WAC, and the lowest running qty along the way (negative = the card dips
-- below zero somewhere).
CREATE OR REPLACE FUNCTION public._replay_stock_balance(p_item uuid, p_site uuid, OUT qty numeric, OUT wac numeric, OUT min_qty numeric)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE m record; nq numeric;
BEGIN
  qty := 0; wac := 0; min_qty := 0;
  FOR m IN SELECT movement_type, quantity, unit_cost FROM stock_movements
           WHERE inventory_item_id = p_item AND site_id = p_site
           ORDER BY created_at, id LOOP
    IF m.movement_type IN ('purchase_in', 'transfer_in', 'sale_reversal') THEN
      nq := qty + m.quantity;
      wac := CASE WHEN nq = 0 THEN 0 ELSE (qty * wac + m.quantity * COALESCE(m.unit_cost, 0)) / nq END;
      qty := nq;
    ELSIF m.movement_type = 'adjustment' THEN
      qty := qty + m.quantity; wac := m.unit_cost;  -- stored as a signed delta; unit_cost is the new WAC
    ELSIF m.movement_type = 'receipt_reversal' THEN
      wac := _sti_wac_after_reversal(qty, wac, m.quantity, m.unit_cost);
      qty := qty - m.quantity;
    ELSE -- sale_out, transfer_out, purchase_return
      qty := qty - m.quantity;
    END IF;
    min_qty := least(min_qty, qty);
  END LOOP;
END;
$function$;

REVOKE ALL ON FUNCTION public._replay_stock_balance(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- Stock the deduction of an invoice dated p_date may take, per item/site
-- (only p_site_ids). A cut lands at p_date 23:59 Bangkok, so for each card:
--   quantity_on_hand      = min(qty at that moment, every later running qty)
--                           -- taking more would push the card negative
--                           somewhere between then and today
--   weighted_average_cost = the average cost at that moment
--   first_received_at     = first receipt up to that moment (FIFO order)
-- Only cards with stock and a cost come back. One jsonb array, so the
-- API's 1000-row cap never truncates it.
CREATE OR REPLACE FUNCTION public.inventory_balances_as_of(p_date date, p_site_ids uuid[])
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
  m record;
  k_item uuid; k_site uuid;
  qty numeric; wac numeric; nq numeric;
  at_qty numeric; at_wac numeric; min_after numeric; first_at timestamptz;
BEGIN
  IF NOT (is_admin_or_owner() AND has_module_access('purchase_orders')) THEN
    RAISE EXCEPTION 'insufficient_privilege';
  END IF;
  IF p_date IS NULL THEN RAISE EXCEPTION 'p_date is required'; END IF;

  FOR m IN
    SELECT inventory_item_id, site_id, movement_type, quantity, unit_cost, created_at
    FROM stock_movements
    WHERE tenant_id = v_tenant_id AND site_id = ANY (p_site_ids)
    ORDER BY inventory_item_id, site_id, created_at, id
  LOOP
    IF k_item IS DISTINCT FROM m.inventory_item_id OR k_site IS DISTINCT FROM m.site_id THEN
      IF k_item IS NOT NULL THEN
        IF at_qty IS NULL THEN at_qty := qty; at_wac := wac; END IF;
        IF least(at_qty, coalesce(min_after, at_qty)) > 0 AND at_wac > 0 THEN
          v_out := array_append(v_out, jsonb_build_object('inventory_item_id', k_item, 'site_id', k_site,
            'quantity_on_hand', least(at_qty, coalesce(min_after, at_qty)), 'weighted_average_cost', at_wac,
            'first_received_at', first_at));
        END IF;
      END IF;
      k_item := m.inventory_item_id; k_site := m.site_id;
      qty := 0; wac := 0; at_qty := NULL; at_wac := NULL; min_after := NULL; first_at := NULL;
    END IF;

    IF m.created_at > v_at AND at_qty IS NULL THEN
      at_qty := qty; at_wac := wac;  -- state at the invoice moment
    END IF;

    IF m.movement_type IN ('purchase_in', 'transfer_in', 'sale_reversal') THEN
      nq := qty + m.quantity;
      wac := CASE WHEN nq = 0 THEN 0 ELSE (qty * wac + m.quantity * COALESCE(m.unit_cost, 0)) / nq END;
      qty := nq;
    ELSIF m.movement_type = 'adjustment' THEN
      qty := qty + m.quantity; wac := m.unit_cost;
    ELSIF m.movement_type = 'receipt_reversal' THEN
      wac := _sti_wac_after_reversal(qty, wac, m.quantity, m.unit_cost);
      qty := qty - m.quantity;
    ELSE
      qty := qty - m.quantity;
    END IF;

    IF m.created_at <= v_at THEN
      IF first_at IS NULL AND (m.movement_type IN ('purchase_in', 'transfer_in', 'sale_reversal') OR (m.movement_type = 'adjustment' AND m.quantity > 0)) THEN
        first_at := m.created_at;
      END IF;
    ELSE
      min_after := least(coalesce(min_after, qty), qty);
    END IF;
  END LOOP;

  IF k_item IS NOT NULL THEN
    IF at_qty IS NULL THEN at_qty := qty; at_wac := wac; END IF;
    IF least(at_qty, coalesce(min_after, at_qty)) > 0 AND at_wac > 0 THEN
      v_out := array_append(v_out, jsonb_build_object('inventory_item_id', k_item, 'site_id', k_site,
        'quantity_on_hand', least(at_qty, coalesce(min_after, at_qty)), 'weighted_average_cost', at_wac,
        'first_received_at', first_at));
    END IF;
  END IF;

  RETURN to_jsonb(v_out);
END;
$function$;

REVOKE ALL ON FUNCTION public.inventory_balances_as_of(date, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inventory_balances_as_of(date, uuid[]) TO authenticated;

-- Same as migration 05, plus: after posting, every touched card's balance
-- is rebuilt from its ledger (the rows are back-dated, so the running
-- maths in _apply_stock_movement used today's state, not the invoice
-- day's), and the whole call is refused if any card dips below zero.
CREATE OR REPLACE FUNCTION public.post_invoice_stock_deduction(p_invoice_id uuid, p_movements jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant_id uuid := current_tenant_id();
  v_email text := auth.email();
  v_date date;
  v_at timestamptz;
  v_row record;
  v_mid uuid;
  v_dp uuid;
  v_dm uuid;
  v_n int := 0;
  p record;
  r record;
BEGIN
  IF NOT (is_admin_or_owner() AND has_module_access('purchase_orders')) THEN
    RAISE EXCEPTION 'insufficient_privilege';
  END IF;
  IF p_movements IS NULL OR jsonb_typeof(p_movements) <> 'array' OR jsonb_array_length(p_movements) = 0 THEN
    RAISE EXCEPTION 'p_movements must be a non-empty json array';
  END IF;

  SELECT date INTO v_date FROM invoices WHERE id = p_invoice_id AND tenant_id = v_tenant_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'invoice not found for this tenant'; END IF;
  IF v_date IS NULL THEN RAISE EXCEPTION 'invoice has no date'; END IF;
  v_at := (v_date + time '23:59') AT TIME ZONE 'Asia/Bangkok';

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_movements) m
    LEFT JOIN inventory_items ii ON ii.id = (m->>'inventory_item_id')::uuid AND ii.tenant_id = v_tenant_id
    WHERE ii.id IS NULL
  ) THEN
    RAISE EXCEPTION 'inventory_item not found for this tenant';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_movements) m
    LEFT JOIN sites s ON s.id = (m->>'site_id')::uuid AND s.tenant_id = v_tenant_id
    WHERE s.id IS NULL
  ) THEN
    RAISE EXCEPTION 'site not found for this tenant';
  END IF;

  FOR v_row IN
    SELECT e.value AS m, e.ordinality AS ord, ii.item_kind
    FROM jsonb_array_elements(p_movements) WITH ORDINALITY e
    JOIN inventory_items ii ON ii.id = (e.value->>'inventory_item_id')::uuid
    ORDER BY e.ordinality
  LOOP
    SELECT movement_id INTO v_mid FROM _apply_stock_movement(v_tenant_id,
      (v_row.m->>'inventory_item_id')::uuid,
      (v_row.m->>'site_id')::uuid,
      v_row.m->>'movement_type',
      (v_row.m->>'quantity')::numeric,
      (v_row.m->>'unit_cost')::numeric,
      'invoice',
      p_invoice_id,
      v_row.m->>'notes',
      v_email,
      v_at + (v_row.ord * interval '1 microsecond'));

    IF v_row.item_kind = 'finished_goods' THEN
      v_dp := coalesce(v_dp, _issue_stock_document(v_tenant_id, p_invoice_id, 'DP', v_date, v_email));
      UPDATE stock_movements SET stock_document_id = v_dp WHERE id = v_mid;
    ELSE
      v_dm := coalesce(v_dm, _issue_stock_document(v_tenant_id, p_invoice_id, 'DM', v_date, v_email));
      UPDATE stock_movements SET stock_document_id = v_dm WHERE id = v_mid;
    END IF;
    v_n := v_n + 1;
  END LOOP;

  FOR p IN
    SELECT DISTINCT (e->>'inventory_item_id')::uuid AS item_id, (e->>'site_id')::uuid AS site_id
    FROM jsonb_array_elements(p_movements) e
  LOOP
    r := _replay_stock_balance(p.item_id, p.site_id);
    IF r.min_qty < -0.0001 THEN
      RAISE EXCEPTION 'insufficient_stock_as_of: % (stock card would go to % on or after %)',
        (SELECT coalesce(code, name) FROM inventory_items WHERE id = p.item_id), round(r.min_qty, 4), v_date;
    END IF;
    UPDATE inventory_stock_balances SET quantity_on_hand = r.qty, weighted_average_cost = r.wac, updated_at = now()
     WHERE inventory_item_id = p.item_id AND site_id = p.site_id;
  END LOOP;

  RETURN jsonb_build_object(
    'rows', v_n,
    'dp', (SELECT doc_number FROM stock_documents WHERE id = v_dp),
    'dm', (SELECT doc_number FROM stock_documents WHERE id = v_dm));
END;
$function$;

REVOKE ALL ON FUNCTION public.post_invoice_stock_deduction(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_invoice_stock_deduction(uuid, jsonb) TO authenticated;
