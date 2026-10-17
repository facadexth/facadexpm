-- Batch stock-movement posting with a document date.
--
-- Invoice stock deduction used to call record_stock_movement once per
-- movement from the browser (~3 calls per central-stock item, ~7,200 round
-- trips for one invoice, 30+ minutes, half-posted if the tab closed). This
-- posts the whole list in ONE transaction (all or nothing) and stamps every
-- row with the document's date instead of the click time, so the stock card
-- puts the deduction in the invoice's month.
--
-- The balance math moves into _apply_stock_movement (no permission checks,
-- callable only from the SECURITY DEFINER wrappers below). The per-row
-- tenant/permission/item/site lookups in record_stock_movement made a 5,400
-- row batch take ~5 s against the 8 s statement_timeout; the batch does those
-- checks once per call instead.

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

  INSERT INTO inventory_stock_balances (tenant_id, inventory_item_id, site_id, quantity_on_hand, weighted_average_cost, updated_at)
  VALUES (p_tenant_id, p_inventory_item_id, p_site_id, v_new_qty, v_new_wac, now())
  ON CONFLICT (inventory_item_id, site_id) DO UPDATE
    SET quantity_on_hand = v_new_qty, weighted_average_cost = v_new_wac, updated_at = now();

  RETURN QUERY SELECT v_movement_id, v_new_qty, v_new_wac;
END;
$function$;

REVOKE ALL ON FUNCTION public._apply_stock_movement(uuid, uuid, uuid, text, numeric, numeric, text, uuid, text, text, timestamptz) FROM PUBLIC, anon, authenticated;

-- Same signature and checks as before; the math now lives in the helper.
CREATE OR REPLACE FUNCTION public.record_stock_movement(p_inventory_item_id uuid, p_site_id uuid, p_movement_type text, p_quantity numeric, p_unit_cost numeric, p_reference_type text, p_reference_id uuid, p_notes text)
RETURNS TABLE(movement_id uuid, new_quantity_on_hand numeric, new_weighted_average_cost numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant_id UUID := current_tenant_id();
BEGIN
  IF NOT (is_admin_or_owner() AND has_module_access('purchase_orders')) THEN
    RAISE EXCEPTION 'insufficient_privilege';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM inventory_items WHERE id = p_inventory_item_id AND tenant_id = v_tenant_id) THEN
    RAISE EXCEPTION 'inventory_item not found for this tenant';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM sites WHERE id = p_site_id AND tenant_id = v_tenant_id) THEN
    RAISE EXCEPTION 'site not found for this tenant';
  END IF;

  RETURN QUERY SELECT * FROM _apply_stock_movement(v_tenant_id, p_inventory_item_id, p_site_id, p_movement_type,
    p_quantity, p_unit_cost, p_reference_type, p_reference_id, p_notes, auth.email(), now());
END;
$function$;

-- p_movements: json array of {inventory_item_id, site_id, movement_type,
-- quantity, unit_cost, reference_type, reference_id, notes}, posted in order.
-- p_movement_at: the document timestamp; row N gets p_movement_at + N µs so
-- rows keep their posting order on the stock card.
CREATE OR REPLACE FUNCTION public.record_stock_movements_batch(p_movements jsonb, p_movement_at timestamptz)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant_id UUID := current_tenant_id();
  v_email TEXT := auth.email();
  v_row record;
  v_n integer := 0;
BEGIN
  IF NOT (is_admin_or_owner() AND has_module_access('purchase_orders')) THEN
    RAISE EXCEPTION 'insufficient_privilege';
  END IF;
  IF p_movements IS NULL OR jsonb_typeof(p_movements) <> 'array' THEN
    RAISE EXCEPTION 'p_movements must be a json array';
  END IF;
  IF p_movement_at IS NULL THEN
    RAISE EXCEPTION 'p_movement_at is required';
  END IF;

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

  FOR v_row IN SELECT value AS m, ordinality AS ord FROM jsonb_array_elements(p_movements) WITH ORDINALITY ORDER BY ordinality LOOP
    PERFORM _apply_stock_movement(v_tenant_id,
      (v_row.m->>'inventory_item_id')::uuid,
      (v_row.m->>'site_id')::uuid,
      v_row.m->>'movement_type',
      (v_row.m->>'quantity')::numeric,
      (v_row.m->>'unit_cost')::numeric,
      v_row.m->>'reference_type',
      (v_row.m->>'reference_id')::uuid,
      v_row.m->>'notes',
      v_email,
      p_movement_at + (v_row.ord * interval '1 microsecond'));
    v_n := v_n + 1;
  END LOOP;

  RETURN v_n;
END;
$function$;

REVOKE ALL ON FUNCTION public.record_stock_movements_batch(jsonb, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_stock_movements_batch(jsonb, timestamptz) TO authenticated;

-- FIFO order for invoice stock deduction (owner decision 2026-10-17): the
-- deduction plan takes items oldest-first by the date each was first
-- received at a site. security_invoker keeps stock_movements' tenant RLS.
CREATE OR REPLACE VIEW public.inventory_first_receipts WITH (security_invoker = true) AS
SELECT inventory_item_id, site_id, min(created_at) AS first_received_at
FROM stock_movements
WHERE movement_type IN ('purchase_in', 'transfer_in', 'sale_reversal')
   OR (movement_type = 'adjustment' AND quantity > 0)
GROUP BY inventory_item_id, site_id;

REVOKE ALL ON public.inventory_first_receipts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.inventory_first_receipts TO authenticated;
