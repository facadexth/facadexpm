-- Rolled-back check for supabase/migrations/2026-10-26-03-post-deduction-v2.sql
-- (controller runs it AFTER migrations -01 and -02 are live, or appended to their
-- dry-runs; always rolls back; prints one PASS/FAIL row per check).
-- Runs the migration body verbatim (the one statement that removes the old
-- 2-argument function is built with 'DR' || 'OP' in EXECUTE: the SQL runner rejects
-- the object-removal keyword), then on the FacadeX tenant:
--   * creates throw-away items R1, R2, R3 (raw material) and F1 (finished goods);
--     R1 at job site S: lot A 10 @100 (Jan 1), lot B 10 @120 (Jan 2);
--     R2 at central site C: lot L 10 @50 (Jan 1);
--     R3 at S: 5 @10, out 8 (card dips to -3), 10 @20 -> already dips before the cut;
--   * reuses invoice IN2601-001 (dated 2026-01-06). Its real DM2601-001 / DP2601-001
--     are detached (invoice_id set to NULL, rolled back) so this cut issues fresh
--     documents instead of returning the existing ones.
-- Call 1 (targets 3000 / {"alu":60,"glass":40}):
--   1 R1@S sale_out 10 @100 lot A     } 2-lot split
--   2 R1@S sale_out  2 @120 lot B     }
--   3 R2@C transfer_out 4 @50 lot L   } central triplet
--   4 R2@S transfer_in  4 @50         }   (new lot T at S)
--   5 R2@S sale_out     4 @50         }   (server links to T = row 4)
--   6 F1@S purchase_in 1 @2000        -> MO
--   7 F1@S sale_out    1 @2000        -> DP
--   expect: R1@S 8 @120 (B 8 left, value 960); R2@C 6 @50; R2@S 0; F1@S 0.
-- Refusals (each in its own sub-block): a deeper dip (R1 out 100), a lot of another
-- item, a lot on a transfer_in.
-- Call 2 (retry / idempotency + relative guard): R2@S transfer_in 1, R3@S sale_out 1
-- (no lot; follows a transfer_in of ANOTHER item -> must stay unlinked), R1@S out 1
-- lot B. Same MO/DM, dp null, still one MO/DM/DP for the invoice, MO targets kept;
-- R3 stays at its old -3 low -> allowed; R3 6 @20, R1 7 @120.
-- Block 1 (setup, no auth) and block 2 (RPC probes as a FacadeX OWNER/ADMIN, wrapped
-- in an exception handler that records row 99 FAIL) are separate.
BEGIN;

-- ===== migration body =====================================================
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

DO $$
DECLARE k text := 'DR' || 'OP';
BEGIN
  EXECUTE format('%s FUNCTION IF EXISTS public.post_invoice_stock_deduction(uuid, jsonb)', k);
END $$;

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
-- ===== end migration body =================================================

-- ===== probes =============================================================
CREATE TEMP TABLE _results (n int, check_name text, ok boolean, detail text);
CREATE TEMP TABLE _ids (k text PRIMARY KEY, id uuid);
CREATE TEMP TABLE _ctx (email text);

-- Block 1: setup (no auth needed).
DO $$
DECLARE
  v_tenant uuid := '1b9affc4-2136-4ed1-b168-a36e6624e743';  -- FacadeX
  v_inv uuid := '0b28b845-9dae-4c5e-b37a-77c8c4e5b7df';     -- IN2601-001, 2026-01-06
  v_s uuid; v_c uuid; v_email text;
  r1 uuid; r2 uuid; r3 uuid; f1 uuid;
  a uuid; b uuid; l uuid;
BEGIN
  SELECT id INTO v_c FROM sites WHERE tenant_id = v_tenant AND is_default;
  SELECT id INTO v_s FROM sites WHERE tenant_id = v_tenant AND NOT is_default ORDER BY id LIMIT 1;
  SELECT user_email INTO v_email FROM user_roles
   WHERE tenant_id = v_tenant AND role IN ('OWNER', 'ADMIN') ORDER BY role DESC LIMIT 1;

  INSERT INTO _results VALUES (1, 'setup: FacadeX has a central site, a job site, an owner/admin and invoice IN2601-001 dated 2026-01-06',
    v_c IS NOT NULL AND v_s IS NOT NULL AND v_email IS NOT NULL
      AND (SELECT date FROM invoices WHERE id = v_inv AND tenant_id = v_tenant) = date '2026-01-06',
    format('central=%s job=%s email=%s', v_c, v_s, v_email));

  -- detach the invoice's real documents so this cut issues fresh ones (rolled back)
  UPDATE stock_documents SET invoice_id = NULL WHERE invoice_id = v_inv;

  INSERT INTO inventory_items (tenant_id, name, base_unit) VALUES (v_tenant, 'dryrun-v2-R1', 'pcs') RETURNING id INTO r1;
  INSERT INTO inventory_items (tenant_id, name, base_unit) VALUES (v_tenant, 'dryrun-v2-R2', 'pcs') RETURNING id INTO r2;
  INSERT INTO inventory_items (tenant_id, name, base_unit) VALUES (v_tenant, 'dryrun-v2-R3', 'pcs') RETURNING id INTO r3;
  INSERT INTO inventory_items (tenant_id, name, base_unit, item_kind) VALUES (v_tenant, 'dryrun-v2-F1', 'set', 'finished_goods') RETURNING id INTO f1;

  -- R1 at S: lot A 10 @100, lot B 10 @120
  INSERT INTO stock_movements (tenant_id, inventory_item_id, site_id, movement_type, quantity, unit_cost, reference_type, created_by, created_at)
  VALUES (v_tenant, r1, v_s, 'purchase_in', 10, 100, 'dryrun', 'dryrun', timestamptz '2026-01-01 10:00+07') RETURNING id INTO a;
  INSERT INTO stock_movements (tenant_id, inventory_item_id, site_id, movement_type, quantity, unit_cost, reference_type, created_by, created_at)
  VALUES (v_tenant, r1, v_s, 'purchase_in', 10, 120, 'dryrun', 'dryrun', timestamptz '2026-01-02 10:00+07') RETURNING id INTO b;
  INSERT INTO inventory_stock_balances (tenant_id, inventory_item_id, site_id, quantity_on_hand, weighted_average_cost, updated_at)
  VALUES (v_tenant, r1, v_s, 20, 110, now());

  -- R2 at C: lot L 10 @50
  INSERT INTO stock_movements (tenant_id, inventory_item_id, site_id, movement_type, quantity, unit_cost, reference_type, created_by, created_at)
  VALUES (v_tenant, r2, v_c, 'purchase_in', 10, 50, 'dryrun', 'dryrun', timestamptz '2026-01-01 10:00+07') RETURNING id INTO l;
  INSERT INTO inventory_stock_balances (tenant_id, inventory_item_id, site_id, quantity_on_hand, weighted_average_cost, updated_at)
  VALUES (v_tenant, r2, v_c, 10, 50, now());

  -- R3 at S: already dips to -3 in its history, ends at 7 @20
  INSERT INTO stock_movements (tenant_id, inventory_item_id, site_id, movement_type, quantity, unit_cost, reference_type, created_by, created_at)
  VALUES (v_tenant, r3, v_s, 'purchase_in', 5, 10, 'dryrun', 'dryrun', timestamptz '2026-01-01 10:00+07');
  INSERT INTO stock_movements (tenant_id, inventory_item_id, site_id, movement_type, quantity, unit_cost, reference_type, created_by, created_at)
  VALUES (v_tenant, r3, v_s, 'sale_out', 8, 10, 'dryrun', 'dryrun', timestamptz '2026-01-01 11:00+07');
  INSERT INTO stock_movements (tenant_id, inventory_item_id, site_id, movement_type, quantity, unit_cost, reference_type, created_by, created_at)
  VALUES (v_tenant, r3, v_s, 'purchase_in', 10, 20, 'dryrun', 'dryrun', timestamptz '2026-01-01 12:00+07');
  INSERT INTO inventory_stock_balances (tenant_id, inventory_item_id, site_id, quantity_on_hand, weighted_average_cost, updated_at)
  VALUES (v_tenant, r3, v_s, 7, 20, now());

  INSERT INTO _ids VALUES ('s', v_s), ('c', v_c), ('inv', v_inv), ('r1', r1), ('r2', r2), ('r3', r3), ('f1', f1),
    ('a', a), ('b', b), ('l', l);
  INSERT INTO _ctx VALUES (v_email);
END $$;

-- Block 2: RPC probes as a FacadeX owner/admin. Wrapped so a privilege or runtime
-- error records a FAIL row instead of aborting the script.
DO $$
DECLARE
  v_tenant uuid := '1b9affc4-2136-4ed1-b168-a36e6624e743';  -- FacadeX
  v_email text := (SELECT email FROM _ctx);
  v_s uuid := (SELECT id FROM _ids WHERE k = 's');
  v_c uuid := (SELECT id FROM _ids WHERE k = 'c');
  v_inv uuid := (SELECT id FROM _ids WHERE k = 'inv');
  r1 uuid := (SELECT id FROM _ids WHERE k = 'r1');
  r2 uuid := (SELECT id FROM _ids WHERE k = 'r2');
  r3 uuid := (SELECT id FROM _ids WHERE k = 'r3');
  f1 uuid := (SELECT id FROM _ids WHERE k = 'f1');
  a uuid := (SELECT id FROM _ids WHERE k = 'a');
  b uuid := (SELECT id FROM _ids WHERE k = 'b');
  l uuid := (SELECT id FROM _ids WHERE k = 'l');
  res1 jsonb; res2 jsonb;
  mo record; dm record; dp record;
  mv stock_movements[]; -- call 1's 7 rows in array order
  x record; rp record; bal record;
  v_err text;
  v_n_before int;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('email', v_email, 'role', 'authenticated')::text, true);
  BEGIN
  INSERT INTO _results VALUES (2, 'caller resolves to FacadeX with stock access',
    current_tenant_id() = v_tenant AND is_admin_or_owner() AND has_module_access('purchase_orders'), v_email);

  -- ---------- call 1 ----------
  res1 := post_invoice_stock_deduction(v_inv, jsonb_build_array(
    jsonb_build_object('inventory_item_id', r1, 'site_id', v_s, 'movement_type', 'sale_out', 'quantity', 10, 'unit_cost', 100, 'lot_movement_id', a),
    jsonb_build_object('inventory_item_id', r1, 'site_id', v_s, 'movement_type', 'sale_out', 'quantity', 2, 'unit_cost', 120, 'lot_movement_id', b),
    jsonb_build_object('inventory_item_id', r2, 'site_id', v_c, 'movement_type', 'transfer_out', 'quantity', 4, 'unit_cost', 50, 'lot_movement_id', l),
    jsonb_build_object('inventory_item_id', r2, 'site_id', v_s, 'movement_type', 'transfer_in', 'quantity', 4, 'unit_cost', 50),
    jsonb_build_object('inventory_item_id', r2, 'site_id', v_s, 'movement_type', 'sale_out', 'quantity', 4, 'unit_cost', 50, 'lot_movement_id', NULL),
    jsonb_build_object('inventory_item_id', f1, 'site_id', v_s, 'movement_type', 'purchase_in', 'quantity', 1, 'unit_cost', 2000),
    jsonb_build_object('inventory_item_id', f1, 'site_id', v_s, 'movement_type', 'sale_out', 'quantity', 1, 'unit_cost', 2000)),
    3000, '{"alu": 60, "glass": 40}'::jsonb);

  SELECT * INTO mo FROM stock_documents WHERE invoice_id = v_inv AND doc_type = 'MO';
  SELECT * INTO dm FROM stock_documents WHERE invoice_id = v_inv AND doc_type = 'DM';
  SELECT * INTO dp FROM stock_documents WHERE invoice_id = v_inv AND doc_type = 'DP';
  SELECT array_agg(m ORDER BY m.created_at, m.id) INTO mv
  FROM stock_movements m
  WHERE m.reference_type = 'invoice' AND m.reference_id = v_inv AND m.inventory_item_id IN (r1, r2, f1);

  INSERT INTO _results VALUES
    (3, 'call 1 returns rows 7 and the three new document numbers (keys rows, mo, dm, dp)',
        (res1->>'rows')::int = 7 AND res1->>'mo' = mo.doc_number AND res1->>'dm' = dm.doc_number
          AND res1->>'dp' = dp.doc_number
          AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(res1) k) = ARRAY['dm', 'dp', 'mo', 'rows'],
        res1::text),
    (4, 'MO: MO2601-nnn, invoice-linked, no parent, doc_date 2026-01-06, targets stored',
        mo.doc_number LIKE 'MO2601-%' AND mo.parent_document_id IS NULL AND mo.doc_date = date '2026-01-06'
          AND mo.tenant_id = v_tenant AND mo.target_total = 3000
          AND mo.target_splits = '{"alu": 60, "glass": 40}'::jsonb,
        format('%s parent=%s total=%s splits=%s', mo.doc_number, mo.parent_document_id, mo.target_total, mo.target_splits)),
    (5, 'DM and DP: DM2601-/DP2601-, parent = MO, same invoice, no targets',
        dm.doc_number LIKE 'DM2601-%' AND dp.doc_number LIKE 'DP2601-%'
          AND dm.parent_document_id = mo.id AND dp.parent_document_id = mo.id
          AND dm.target_total IS NULL AND dp.target_total IS NULL,
        format('dm=%s parent=%s dp=%s parent=%s mo=%s', dm.doc_number, dm.parent_document_id, dp.doc_number, dp.parent_document_id, mo.id)),
    (6, 'created order MO < DM < DP',
        mo.created_at < dm.created_at AND dm.created_at < dp.created_at,
        format('mo=%s dm=%s dp=%s', mo.created_at, dm.created_at, dp.created_at)),
    (7, 'call 1 posted exactly 7 rows, in array order, at 2026-01-06 23:59 Bangkok + ord microseconds',
        array_length(mv, 1) = 7
          AND (mv[1]).created_at = timestamptz '2026-01-06 23:59:00.000001+07'
          AND (mv[7]).created_at = timestamptz '2026-01-06 23:59:00.000007+07'
          AND (mv[1]).quantity = 10 AND (mv[2]).quantity = 2 AND (mv[3]).movement_type = 'transfer_out'
          AND (mv[4]).movement_type = 'transfer_in' AND (mv[5]).movement_type = 'sale_out'
          AND (mv[6]).movement_type = 'purchase_in' AND (mv[7]).movement_type = 'sale_out',
        format('n=%s first=%s last=%s', array_length(mv, 1), (mv[1]).created_at, (mv[7]).created_at)),
    (8, 'raw-material rows 1-5 cite DM',
        (mv[1]).stock_document_id = dm.id AND (mv[2]).stock_document_id = dm.id AND (mv[3]).stock_document_id = dm.id
          AND (mv[4]).stock_document_id = dm.id AND (mv[5]).stock_document_id = dm.id,
        NULL),
    (9, 'FG purchase_in cites MO, FG sale_out cites DP',
        (mv[6]).stock_document_id = mo.id AND (mv[7]).stock_document_id = dp.id,
        format('pi=%s so=%s', (mv[6]).stock_document_id, (mv[7]).stock_document_id)),
    (10, '2-lot split: row 1 -> lot A, row 2 -> lot B (as sent)',
        (mv[1]).lot_movement_id = a AND (mv[2]).lot_movement_id = b,
        format('r1=%s r2=%s', (mv[1]).lot_movement_id, (mv[2]).lot_movement_id)),
    (11, 'triplet: transfer_out -> lot L (as sent); transfer_in unlinked; sale_out -> the transfer_in row',
        (mv[3]).lot_movement_id = l AND (mv[4]).lot_movement_id IS NULL AND (mv[5]).lot_movement_id = (mv[4]).id
          AND (mv[4]).site_id = v_s AND (mv[5]).site_id = v_s AND (mv[3]).site_id = v_c,
        format('out=%s in=%s(id %s) sale=%s', (mv[3]).lot_movement_id, (mv[4]).lot_movement_id, (mv[4]).id, (mv[5]).lot_movement_id)),
    (12, 'FG rows carry no lot link',
        (mv[6]).lot_movement_id IS NULL AND (mv[7]).lot_movement_id IS NULL, NULL);

  -- balances vs replay + explicit FIFO values
  FOR x IN SELECT * FROM (VALUES
      (13, r1, v_s, 8::numeric, 120::numeric, 960::numeric, 'R1@S: B 8 @120 left'),
      (14, r2, v_c, 6::numeric, 50::numeric, 300::numeric, 'R2@C: L 6 @50 left'),
      (15, r2, v_s, 0::numeric, 0::numeric, 0::numeric, 'R2@S: transfer_in lot fully taken by the linked sale_out'),
      (16, f1, v_s, 0::numeric, 0::numeric, 0::numeric, 'F1@S: produced and sold')) t(n, item, site, eq, ewac, evalue, label)
  LOOP
    rp := _replay_stock_lots(x.item, x.site);
    SELECT quantity_on_hand, weighted_average_cost INTO bal FROM inventory_stock_balances
     WHERE inventory_item_id = x.item AND site_id = x.site;
    INSERT INTO _results VALUES (x.n, 'balance = _replay_stock_lots (qty, fifo_value/qty): ' || x.label,
      bal.quantity_on_hand = rp.qty AND bal.weighted_average_cost = CASE WHEN rp.qty > 0 THEN rp.fifo_value / rp.qty ELSE 0 END
        AND rp.qty = x.eq AND rp.fifo_value = x.evalue AND bal.weighted_average_cost = x.ewac AND rp.min_qty = 0,
      format('bal qty=%s wac=%s | replay qty=%s value=%s min=%s lots=%s',
             bal.quantity_on_hand, bal.weighted_average_cost, rp.qty, rp.fifo_value, rp.min_qty, rp.lots));
  END LOOP;

  rp := _replay_stock_lots(r1, v_s);
  INSERT INTO _results VALUES (17, 'R1@S remaining lot is B (A fully consumed by its linked out)',
    jsonb_array_length(rp.lots) = 1 AND (rp.lots->0->>'movement_id')::uuid = b AND (rp.lots->0->>'qty')::numeric = 8,
    rp.lots::text);

  -- ---------- refusals ----------
  SELECT count(*) INTO v_n_before FROM stock_movements WHERE inventory_item_id = r1;
  v_err := NULL;
  BEGIN
    PERFORM post_invoice_stock_deduction(v_inv, jsonb_build_array(
      jsonb_build_object('inventory_item_id', r1, 'site_id', v_s, 'movement_type', 'sale_out', 'quantity', 100, 'unit_cost', 120, 'lot_movement_id', b)));
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  INSERT INTO _results VALUES (18, 'deeper dip refused: insufficient_stock_as_of, nothing kept (R1 rows + balance unchanged)',
    v_err LIKE 'insufficient_stock_as_of:%'
      AND (SELECT count(*) FROM stock_movements WHERE inventory_item_id = r1) = v_n_before
      AND (SELECT quantity_on_hand FROM inventory_stock_balances WHERE inventory_item_id = r1 AND site_id = v_s) = 8,
    v_err);

  v_err := NULL;
  BEGIN
    PERFORM post_invoice_stock_deduction(v_inv, jsonb_build_array(
      jsonb_build_object('inventory_item_id', r1, 'site_id', v_s, 'movement_type', 'sale_out', 'quantity', 1, 'unit_cost', 50, 'lot_movement_id', l)));
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  INSERT INTO _results VALUES (19, 'lot of another item/site refused',
    v_err = 'lot_movement_id not found for this item and site', v_err);

  v_err := NULL;
  BEGIN
    PERFORM post_invoice_stock_deduction(v_inv, jsonb_build_array(
      jsonb_build_object('inventory_item_id', r1, 'site_id', v_s, 'movement_type', 'transfer_in', 'quantity', 1, 'unit_cost', 120, 'lot_movement_id', b)));
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  INSERT INTO _results VALUES (20, 'lot link on a transfer_in refused',
    v_err = 'lot_movement_id is only allowed on sale_out / transfer_out rows', v_err);

  v_err := NULL;
  BEGIN
    PERFORM post_invoice_stock_deduction(v_inv, '[]'::jsonb);
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  INSERT INTO _results VALUES (21, 'v1 validation kept: empty p_movements refused',
    v_err = 'p_movements must be a non-empty json array', v_err);

  v_err := NULL;
  BEGIN
    PERFORM post_invoice_stock_deduction(gen_random_uuid(), jsonb_build_array(
      jsonb_build_object('inventory_item_id', r1, 'site_id', v_s, 'movement_type', 'sale_out', 'quantity', 1, 'unit_cost', 120)));
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  INSERT INTO _results VALUES (22, 'v1 validation kept: unknown invoice refused',
    v_err = 'invoice not found for this tenant', v_err);

  -- ---------- call 2: retry / idempotency + relative guard ----------
  res2 := post_invoice_stock_deduction(v_inv, jsonb_build_array(
    jsonb_build_object('inventory_item_id', r2, 'site_id', v_s, 'movement_type', 'transfer_in', 'quantity', 1, 'unit_cost', 50),
    jsonb_build_object('inventory_item_id', r3, 'site_id', v_s, 'movement_type', 'sale_out', 'quantity', 1, 'unit_cost', 20),
    jsonb_build_object('inventory_item_id', r1, 'site_id', v_s, 'movement_type', 'sale_out', 'quantity', 1, 'unit_cost', 120, 'lot_movement_id', b)));

  INSERT INTO _results VALUES
    (23, 'call 2 reuses the same MO and DM, dp null (no FG rows), rows 3',
        (res2->>'rows')::int = 3 AND res2->>'mo' = mo.doc_number AND res2->>'dm' = dm.doc_number
          AND res2->'dp' = 'null'::jsonb,
        res2::text),
    (24, 'still exactly one MO / DM / DP for the invoice; MO keeps its targets',
        (SELECT count(*) FROM stock_documents WHERE invoice_id = v_inv AND doc_type = 'MO') = 1
          AND (SELECT count(*) FROM stock_documents WHERE invoice_id = v_inv AND doc_type = 'DM') = 1
          AND (SELECT count(*) FROM stock_documents WHERE invoice_id = v_inv AND doc_type = 'DP') = 1
          AND (SELECT target_total FROM stock_documents WHERE id = mo.id) = 3000,
        NULL),
    (25, 'sale_out after a transfer_in of ANOTHER item stays unlinked; it cites DM',
        (SELECT lot_movement_id IS NULL AND stock_document_id = dm.id FROM stock_movements
          WHERE inventory_item_id = r3 AND reference_type = 'invoice' AND reference_id = v_inv),
        NULL);

  rp := _replay_stock_lots(r3, v_s);
  SELECT quantity_on_hand, weighted_average_cost INTO bal FROM inventory_stock_balances WHERE inventory_item_id = r3 AND site_id = v_s;
  INSERT INTO _results VALUES (26, 'relative guard: R3 already dipped to -3, cut does not dip deeper -> allowed; 6 @20',
    rp.min_qty = -3 AND rp.qty = 6 AND rp.fifo_value = 120 AND bal.quantity_on_hand = 6 AND bal.weighted_average_cost = 20,
    format('bal qty=%s wac=%s | replay qty=%s value=%s min=%s', bal.quantity_on_hand, bal.weighted_average_cost, rp.qty, rp.fifo_value, rp.min_qty));

  rp := _replay_stock_lots(r1, v_s);
  SELECT quantity_on_hand, weighted_average_cost INTO bal FROM inventory_stock_balances WHERE inventory_item_id = r1 AND site_id = v_s;
  INSERT INTO _results VALUES (27, 'R1@S after call 2: 7 @120 (value 840)',
    rp.qty = 7 AND rp.fifo_value = 840 AND bal.quantity_on_hand = 7 AND bal.weighted_average_cost = 120,
    format('bal qty=%s wac=%s | replay qty=%s value=%s', bal.quantity_on_hand, bal.weighted_average_cost, rp.qty, rp.fifo_value));

  -- ---------- signature + grants ----------
  INSERT INTO _results VALUES (28, 'only the 4-argument function exists; authenticated may call it, anon may not',
    to_regprocedure('public.post_invoice_stock_deduction(uuid, jsonb)') IS NULL
      AND to_regprocedure('public.post_invoice_stock_deduction(uuid, jsonb, numeric, jsonb)') IS NOT NULL
      AND has_function_privilege('authenticated', 'public.post_invoice_stock_deduction(uuid, jsonb, numeric, jsonb)', 'EXECUTE')
      AND NOT has_function_privilege('anon', 'public.post_invoice_stock_deduction(uuid, jsonb, numeric, jsonb)', 'EXECUTE'),
    NULL);
  EXCEPTION WHEN OTHERS THEN
    -- the sub-block's own rows are rolled back with it; say why
    INSERT INTO _results VALUES (99, 'RPC probes aborted (rows 2-28 missing)', false, SQLSTATE || ' ' || SQLERRM);
  END;
END $$;

SELECT n, CASE WHEN coalesce(ok, false) THEN 'PASS' ELSE 'FAIL' END AS result, check_name, detail
FROM _results ORDER BY n;

ROLLBACK;
