-- FIFO + MO/OB stock documents, step 3: post_invoice_stock_deduction v2
-- (owner-approved design 2026-10-26). Run after 2026-10-26-01 and -02.
--
-- Same as v1 (2026-10-17-11) except:
--   * Documents: one MO (ใบสั่งผลิต) per invoice is issued FIRST and stores the cut's
--     p_target_total / p_target_splits; then DM (raw material, parent = MO), then DP
--     (finished goods, parent = MO). Each is issued only when needed: DM only if the
--     cut has raw-material rows, DP only if it has finished-goods rows, MO whenever
--     either exists. Rows cite: raw material -> DM, FG purchase_in -> MO,
--     FG sale_out -> DP. created_at of DM / DP is nudged +1 / +2 microseconds when
--     they are new in this call, so MO -> DM -> DP also sort by time (all three
--     would otherwise share the transaction's now()).
--     An existing DM / DP without a parent (cut before MO existed) gets this MO as
--     its parent; a parent already set is never changed.
--     Retries stay idempotent: _issue_stock_document returns the existing document
--     per (invoice_id, doc_type); an existing MO keeps its stored targets.
--   * Lot links: each p_movements element may carry "lot_movement_id" (the in-row /
--     lot the out-row consumes). It must be a movement of the same tenant, item and
--     site, and only sale_out / transfer_out rows may carry one. Central-site take
--     triplet, in array order: transfer_out (carries the central lot) -> transfer_in
--     (no link; its own new row is a NEW lot at the job site) -> sale_out (no link
--     from the client; the server links it to the transfer_in row posted
--     immediately before it for the same item and site).
--   * The as-of guard and the final balance write read _replay_stock_lots (FIFO)
--     instead of _replay_stock_balance (WAC): quantity_on_hand = replayed qty,
--     weighted_average_cost = fifo_value / qty (0 when qty <= 0). The guard is
--     unchanged in meaning: refuse only a DEEPER dip than the card already had.
--
-- The 2-argument v1 is replaced (keeping it would make every 2-argument call
-- ambiguous against the new one with defaults).

DROP FUNCTION IF EXISTS public.post_invoice_stock_deduction(uuid, jsonb);

CREATE OR REPLACE FUNCTION public.post_invoice_stock_deduction(
  p_invoice_id uuid,
  p_movements jsonb,
  p_target_total numeric DEFAULT NULL,
  p_target_splits jsonb DEFAULT NULL)
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
  v_lot uuid;
  v_doc uuid;
  v_mo uuid;
  v_dp uuid;
  v_dm uuid;
  v_has_rm boolean;
  v_has_fg boolean;
  v_tin_id uuid;     -- transfer_in row posted by the PREVIOUS element (else NULL)
  v_tin_item uuid;
  v_tin_site uuid;
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
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_movements) m
    WHERE nullif(m->>'lot_movement_id', '') IS NOT NULL
      AND m->>'movement_type' NOT IN ('sale_out', 'transfer_out')
  ) THEN
    RAISE EXCEPTION 'lot_movement_id is only allowed on sale_out / transfer_out rows';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_movements) m
    WHERE nullif(m->>'lot_movement_id', '') IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM stock_movements sm
        WHERE sm.id = (m->>'lot_movement_id')::uuid
          AND sm.tenant_id = v_tenant_id
          AND sm.inventory_item_id = (m->>'inventory_item_id')::uuid
          AND sm.site_id = (m->>'site_id')::uuid)
  ) THEN
    RAISE EXCEPTION 'lot_movement_id not found for this item and site';
  END IF;

  -- each touched card's lowest running qty BEFORE this cut
  FOR p IN
    SELECT DISTINCT (e->>'inventory_item_id')::uuid AS item_id, (e->>'site_id')::uuid AS site_id
    FROM jsonb_array_elements(p_movements) e
  LOOP
    r := _replay_stock_lots(p.item_id, p.site_id);
    v_min_before := v_min_before || jsonb_build_object(p.item_id || '|' || p.site_id, r.min_qty);
  END LOOP;

  -- documents: MO first, then DM, then DP (each only when needed)
  SELECT bool_or(ii.item_kind IS DISTINCT FROM 'finished_goods'), bool_or(ii.item_kind = 'finished_goods')
    INTO v_has_rm, v_has_fg
  FROM jsonb_array_elements(p_movements) e
  JOIN inventory_items ii ON ii.id = (e->>'inventory_item_id')::uuid;

  v_mo := _issue_stock_document(v_tenant_id, p_invoice_id, 'MO', v_date, v_email,
                                NULL, p_target_total, p_target_splits);
  IF v_has_rm THEN
    v_dm := _issue_stock_document(v_tenant_id, p_invoice_id, 'DM', v_date, v_email, v_mo);
    UPDATE stock_documents
       SET parent_document_id = coalesce(parent_document_id, v_mo),
           created_at = CASE WHEN created_at = now() THEN now() + interval '1 microsecond' ELSE created_at END
     WHERE id = v_dm;
  END IF;
  IF v_has_fg THEN
    v_dp := _issue_stock_document(v_tenant_id, p_invoice_id, 'DP', v_date, v_email, v_mo);
    UPDATE stock_documents
       SET parent_document_id = coalesce(parent_document_id, v_mo),
           created_at = CASE WHEN created_at = now() THEN now() + interval '2 microseconds' ELSE created_at END
     WHERE id = v_dp;
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

    -- lot link: as sent; a central-triplet sale_out takes the transfer_in just posted
    v_lot := nullif(v_row.m->>'lot_movement_id', '')::uuid;
    IF v_lot IS NULL AND v_row.m->>'movement_type' = 'sale_out' AND v_tin_id IS NOT NULL
       AND v_tin_item = (v_row.m->>'inventory_item_id')::uuid
       AND v_tin_site = (v_row.m->>'site_id')::uuid THEN
      v_lot := v_tin_id;
    END IF;
    IF v_row.m->>'movement_type' = 'transfer_in' THEN
      v_tin_id := v_mid;
      v_tin_item := (v_row.m->>'inventory_item_id')::uuid;
      v_tin_site := (v_row.m->>'site_id')::uuid;
    ELSE
      v_tin_id := NULL; v_tin_item := NULL; v_tin_site := NULL;
    END IF;

    IF v_row.item_kind = 'finished_goods' THEN
      v_doc := CASE WHEN v_row.m->>'movement_type' = 'purchase_in' THEN v_mo ELSE v_dp END;
    ELSE
      v_doc := v_dm;
    END IF;
    UPDATE stock_movements SET stock_document_id = v_doc, lot_movement_id = v_lot WHERE id = v_mid;
    v_n := v_n + 1;
  END LOOP;

  FOR p IN
    SELECT DISTINCT (e->>'inventory_item_id')::uuid AS item_id, (e->>'site_id')::uuid AS site_id
    FROM jsonb_array_elements(p_movements) e
  LOOP
    r := _replay_stock_lots(p.item_id, p.site_id);
    IF r.min_qty < least((v_min_before->>(p.item_id || '|' || p.site_id))::numeric, 0) - 0.0001 THEN
      RAISE EXCEPTION 'insufficient_stock_as_of: % (stock card would go to % on or after %)',
        (SELECT coalesce(code, name) FROM inventory_items WHERE id = p.item_id), round(r.min_qty, 4), v_date;
    END IF;
    UPDATE inventory_stock_balances
       SET quantity_on_hand = r.qty,
           weighted_average_cost = CASE WHEN r.qty > 0 THEN r.fifo_value / r.qty ELSE 0 END,
           updated_at = now()
     WHERE inventory_item_id = p.item_id AND site_id = p.site_id;
  END LOOP;

  RETURN jsonb_build_object(
    'rows', v_n,
    'mo', (SELECT doc_number FROM stock_documents WHERE id = v_mo),
    'dm', (SELECT doc_number FROM stock_documents WHERE id = v_dm),
    'dp', (SELECT doc_number FROM stock_documents WHERE id = v_dp));
END;
$function$;

REVOKE ALL ON FUNCTION public.post_invoice_stock_deduction(uuid, jsonb, numeric, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_invoice_stock_deduction(uuid, jsonb, numeric, jsonb) TO authenticated;
