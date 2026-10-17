-- Negative-stock guard of post_invoice_stock_deduction compares against
-- each card's own history instead of zero (see the note on the function).
-- Run after 2026-10-17-10.

-- Same as migration 10, except the negative-stock guard: it now refuses
-- only when this cut makes a card dip LOWER than it already did. 13 job-
-- site cards (บ้านคุณนัตตี้, บ้านปูน สระบุรี, Sep 2026) already dip below
-- zero in their history (a receipt reversal dated before its receipt);
-- a net-zero transfer_in + sale_out on such a card is harmless but was
-- refused by the plain "never below zero" check.
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
  v_min_before jsonb := '{}'::jsonb;
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

  -- each touched card's lowest running qty BEFORE this cut
  FOR p IN
    SELECT DISTINCT (e->>'inventory_item_id')::uuid AS item_id, (e->>'site_id')::uuid AS site_id
    FROM jsonb_array_elements(p_movements) e
  LOOP
    r := _replay_stock_balance(p.item_id, p.site_id);
    v_min_before := v_min_before || jsonb_build_object(p.item_id || '|' || p.site_id, r.min_qty);
  END LOOP;

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
    IF r.min_qty < least((v_min_before->>(p.item_id || '|' || p.site_id))::numeric, 0) - 0.0001 THEN
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
