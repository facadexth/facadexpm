-- Refit the posted WAC invoice cuts as FIFO under an MO (FIFO + MO/OB stock documents,
-- task 13, the last datafix). Run AFTER migrations 2026-10-26-01 .. -04, the task-11
-- switch-over (-05) and the task-12 FacadeX OB (-06). Run the .dryrun.sql copy first:
-- same body, it only reports (never aborts on a FAIL row) and ends in ROLLBACK.
--
-- TARGETS (discovered at run time, nothing hard-coded): every invoice, any tenant, that
-- has a DM or DP stock document but NO MO document. On 2026-10-26 that is only
-- FacadeX IN2601-001 (DM2601-001 + DP2601-001); cuts the owner posts before ship are
-- picked up the same way. An invoice whose DM/DP have no movements at all is NOT a cut:
-- it is reported (WARN) and left untouched.
--
-- Owner decisions applied:
--   * The old WAC documents and ALL their movements are removed for good ("ไม่เก็บ
--     ฉบับเก่า") and the SAME DM/DP numbers are issued again.
--   * The cut's economic size is unchanged: per-category targets = the ORIGINAL cut's
--     per-category deducted totals; only prices (FIFO lots) and documents change.
--   * Finished goods value = what the re-cut actually issued.
--
-- REMOVAL SET, per target invoice (exact): every stock_movements row with
-- reference_type = 'invoice' AND reference_id = the invoice (the whole cut: raw-material
-- sale_out, central transfer_out / transfer_in, finished-goods purchase_in + sale_out
-- incl. the legacy PI-/PO- noted rows), then the invoice's DM / DP stock_documents rows.
-- The statements are spliced in EXECUTE: the SQL runner rejects any statement text that
-- carries a row/table-removing keyword, so none appears literally in this file.
--
-- RE-PICK (the client's computeInvoiceDeductionPlan rules, FIFO lots as of the invoice
-- date from inventory_lots_as_of, after the old cut is gone):
--   phase 1  per ORIGINAL raw-material item: target = that item's original issued value
--            (Σ sale_out qty x unit_cost). Its lots at the job site first (oldest first,
--            one sale_out per lot, linked to the lot), then ส่วนกลาง lots as adjacent
--            transfer_out (linked) / transfer_in / sale_out (server-linked) triplets.
--            A drained lot uses its exact qty; only the last lot is taken partly
--            (qty = remaining value / lot price). Cost-less lots are skipped; stock is
--            never fabricated.
--   phase 2  per category, only if phase 1 left the category short (FIFO older lots can
--            be cheaper than the old WAC, so the same value can need more qty than the
--            card can give): top up from the category's OTHER lots exactly like the
--            client's category planner (job site cards first in FIFO item order =
--            first receipt then item id, then ส่วนกลาง cards with triplets).
--   Per-item preservation implies per-category preservation; phase 2 only exists so a
--   short item cannot shrink its category's total.
--   Finished goods: one purchase_in + sale_out pair per ORIGINAL FG item (same item, site
--   and qty), notes NULL; values scaled so Σ FG = Σ raw material actually issued, split
--   in proportion to the original FG values (an FG-only cut keeps its values).
--   Posted through post_invoice_stock_deduction v2 (issues MO -> DM -> DP, links lots,
--   replays the touched balances), as a FacadeX-style OWNER/ADMIN of that tenant via a
--   transaction-local request.jwt.claims (same pattern as the proven dry-runs).
--   MO targets: target_total = Σ original per-category values, target_splits =
--   {categoryId: pct of target_total} (the client's format), so the MO report's
--   per-category target = target_total x pct / 100 = the original category value.
--   After the post, each new FG sale_out is linked to the FG purchase_in of the same
--   pair (the client cannot: the lot must exist before the call), so it never eats an
--   older FG layer.
--
-- NUMBER REUSE. _issue_stock_document takes max+1 per tenant + prefix. All targets'
-- documents are removed first, then targets are re-posted in post order (invoice date,
-- old DM number, old DP number). The script simulates the numbering BEFORE removing
-- anything (kept max per prefix + rank of each target that will issue that type) and
-- asserts every old DM/DP number comes back; after each post it asserts the returned
-- MO/DM/DP numbers equal the simulated ones. Any mismatch RAISEs (real run) -> nothing
-- is changed; the controller investigates (e.g. another invoice already holds a later
-- DM of the same month).
--
-- GUARDS (always RAISE): a cut row of an unexpected type / tenant / document, raw
-- material sold at more than one site, an FG item whose in/out quantities differ, a
-- tenant with no OWNER/ADMIN email or no default site, and ANY foreign key from outside
-- the removal set pointing INTO it (lot links of other rows, child documents, ...:
-- checked generically from pg_constraint).
--
-- VERIFICATION (one result set; the real run RAISEs if any row is FAIL):
--   per invoice  NUMBERS   old DM/DP vs new MO/DM/DP (and the simulated ones)
--                CATEGORY  old vs new issued value per category      (FAIL > 0.01)
--                ITEM      old vs new issued value per item          (FAIL > 0.01 when a
--                          category of that invoice is off too; WARN when phase 2 made
--                          every category whole)
--                RM_TOTAL  old vs new DM total
--                FG        Σ FG new vs Σ raw material issued         (FAIL > 0.01)
--                MO        target_total / splits as stored           (FAIL when off)
--                LINKS     new raw-material out-rows without a lot   (FAIL > 0)
--   per tenant   BALANCES  cards whose balance <> _replay_stock_lots (FAIL if any touched
--                          card is off, or the tenant count grew)
--                MIN_QTY   cards whose lowest running qty is now deeper than before
--                UNLINKED  out-rows without a lot whose layers were NOT all empty and that
--                          are not finished goods (FAIL if the count grew)
--
-- Scratch state lives in session temp tables / pg_temp functions (emptied at the start).

BEGIN;

-- ===== settings ==============================================================
CREATE TEMP TABLE IF NOT EXISTS _rf_cfg (abort_on_fail boolean NOT NULL);

-- ===== scratch ===============================================================
CREATE TEMP TABLE IF NOT EXISTS _rf_target (
  inv uuid PRIMARY KEY, tenant uuid, inv_number text, inv_date date, inv_status text, inv_site uuid,
  sale_site uuid, central uuid, email text, post_ord int, empty boolean DEFAULT false,
  dm_old text, dp_old text, has_rm boolean, has_fg boolean,
  mo_expected text, dm_expected text, dp_expected text,
  mo_new text, dm_new text, dp_new text,
  rm_old numeric, rm_new numeric, fg_old numeric, fg_new numeric, n_old int, n_new int);
CREATE TEMP TABLE IF NOT EXISTS _rf_old (
  id uuid PRIMARY KEY, inv uuid, tenant uuid, item uuid, site uuid, mtype text, qty numeric, cost numeric,
  is_fg boolean, category uuid, created_at timestamptz, doc uuid, lot uuid);
CREATE TEMP TABLE IF NOT EXISTS _rf_old_docs (id uuid PRIMARY KEY, inv uuid, tenant uuid, doc_type text, doc_number text);
CREATE TEMP TABLE IF NOT EXISTS _rf_keys (tenant uuid, item uuid, site uuid, PRIMARY KEY (item, site));
CREATE TEMP TABLE IF NOT EXISTS _rf_snap (
  phase text, tenant uuid, item uuid, site uuid, qty numeric, val numeric, min_qty numeric,
  bal_qty numeric, bal_val numeric, PRIMARY KEY (phase, item, site));
CREATE TEMP TABLE IF NOT EXISTS _rf_unl (phase text, tenant uuid, movement_id uuid, reason text, PRIMARY KEY (phase, movement_id));
CREATE TEMP TABLE IF NOT EXISTS _rf_lots (
  movement_id uuid PRIMARY KEY, item uuid, site uuid, category uuid, unit_cost numeric, qty_left numeric,
  ord int, first_at timestamptz);
CREATE TEMP TABLE IF NOT EXISTS _rf_steps (
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, inv uuid, item uuid, sale_site uuid, src_site uuid,
  lot uuid, unit_cost numeric, qty numeric, category uuid, phase int);
CREATE TEMP TABLE IF NOT EXISTS _rf_new (
  id uuid PRIMARY KEY, inv uuid, item uuid, site uuid, mtype text, qty numeric, cost numeric,
  is_fg boolean, category uuid, doc uuid, lot uuid);
CREATE TEMP TABLE IF NOT EXISTS _rf_report (
  tenant uuid, post_ord int, sec int, section text, result text, key text, name text,
  old_value numeric, new_value numeric, delta numeric, detail text);
DO $$ BEGIN
  EXECUTE 'TRUN' || 'CATE _rf_cfg, _rf_target, _rf_old, _rf_old_docs, _rf_keys, _rf_snap, _rf_unl, '
       || '_rf_lots, _rf_steps, _rf_new, _rf_report RESTART IDENTITY';
END $$;

INSERT INTO _rf_cfg VALUES (true);   -- real run: any FAIL aborts everything

-- ===== helpers (session-local) ===============================================
-- Takes up to p_want baht of one item's lots at p_src_site (oldest first), recording one
-- step per lot slice. p_src_site = p_sale_site -> sale_out rows; else central triplets.
-- Same arithmetic as computeInvoiceDeductionPlan's take().
CREATE OR REPLACE FUNCTION pg_temp._rf_take(p_inv uuid, p_item uuid, p_sale_site uuid, p_src_site uuid,
                                            p_want numeric, p_phase int)
RETURNS numeric LANGUAGE plpgsql AS $f$
DECLARE l record; v_got numeric := 0; v_rem numeric; v_val numeric; v_q numeric;
BEGIN
  IF p_want IS NULL OR p_want <= 1e-9 THEN RETURN 0; END IF;
  FOR l IN SELECT movement_id, unit_cost, qty_left, category FROM _rf_lots
           WHERE item = p_item AND site = p_src_site AND qty_left > 0 AND unit_cost > 0
           ORDER BY ord LOOP
    v_rem := p_want - v_got;
    EXIT WHEN v_rem <= 1e-9;
    v_val := l.qty_left * l.unit_cost;
    IF v_val <= v_rem + 1e-9 THEN
      v_q := l.qty_left; v_got := v_got + v_val;
    ELSE
      v_q := v_rem / l.unit_cost; v_got := p_want;
    END IF;
    UPDATE _rf_lots SET qty_left = qty_left - v_q WHERE movement_id = l.movement_id;
    INSERT INTO _rf_steps (inv, item, sale_site, src_site, lot, unit_cost, qty, category, phase)
    VALUES (p_inv, p_item, p_sale_site, p_src_site, l.movement_id, l.unit_cost, v_q, l.category, p_phase);
  END LOOP;
  RETURN v_got;
END $f$;

-- Replays every card of p_tenant that has an out-row without a lot, and classifies each
-- such row: 'deficit' (every layer was empty -- nothing to name), 'finished_goods' (FG
-- sale_out posted by the v2 client, which cannot name its pair; oldest-first by design),
-- 'UNEXPECTED' (layers existed but the row names none). Same replay as _replay_stock_lots.
CREATE OR REPLACE FUNCTION pg_temp._rf_unlinked(p_tenant uuid)
RETURNS TABLE (movement_id uuid, reason text) LANGUAGE plpgsql AS $f$
DECLARE
  m record; c record; k_item uuid; k_site uuid;
  d numeric; deficit numeric; absorb numeric; i int; v_any boolean;
  l_id uuid[]; l_qty numeric[];
BEGIN
  FOR m IN
    SELECT sm.inventory_item_id, sm.site_id, sm.id, sm.movement_type, sm.quantity, sm.lot_movement_id,
           coalesce(ii.item_kind = 'finished_goods', false) AS is_fg
    FROM stock_movements sm
    JOIN inventory_items ii ON ii.id = sm.inventory_item_id
    WHERE sm.tenant_id = p_tenant
      AND (sm.inventory_item_id, sm.site_id) IN (
        SELECT x.inventory_item_id, x.site_id FROM stock_movements x
        WHERE x.tenant_id = p_tenant AND x.lot_movement_id IS NULL AND x.quantity > 0
          AND x.movement_type IN ('sale_out', 'transfer_out', 'purchase_return', 'receipt_reversal'))
    ORDER BY sm.inventory_item_id, sm.site_id, sm.created_at, sm.id
  LOOP
    IF k_item IS DISTINCT FROM m.inventory_item_id OR k_site IS DISTINCT FROM m.site_id THEN
      k_item := m.inventory_item_id; k_site := m.site_id;
      deficit := 0; l_id := '{}'; l_qty := '{}';
    END IF;
    d := CASE WHEN m.movement_type IN ('purchase_in', 'transfer_in', 'sale_reversal', 'adjustment')
              THEN coalesce(m.quantity, 0) ELSE -coalesce(m.quantity, 0) END;
    IF d > 0 THEN
      absorb := least(deficit, d);
      deficit := deficit - absorb;
      IF d - absorb > 0 THEN l_id := l_id || m.id; l_qty := l_qty || (d - absorb); END IF;
    ELSIF d < 0 THEN
      IF m.lot_movement_id IS NULL
         AND m.movement_type IN ('sale_out', 'transfer_out', 'purchase_return', 'receipt_reversal') THEN
        v_any := false;
        FOR i IN 1 .. coalesce(array_length(l_qty, 1), 0) LOOP
          IF l_qty[i] > 0 THEN v_any := true; EXIT; END IF;
        END LOOP;
        movement_id := m.id;
        reason := CASE WHEN NOT v_any THEN 'deficit' WHEN m.is_fg THEN 'finished_goods' ELSE 'UNEXPECTED' END;
        RETURN NEXT;
      END IF;
      SELECT * INTO c FROM _fifo_consume(l_id, l_qty,
        CASE WHEN m.movement_type = 'adjustment' THEN NULL ELSE m.lot_movement_id END, -d);
      l_qty := c.qtys;
      deficit := deficit + c.shortfall;
    END IF;
  END LOOP;
END $f$;

-- Snapshot of every card of the in-scope tenants: replay (qty, FIFO value, lowest qty)
-- next to the stored balance.
CREATE OR REPLACE FUNCTION pg_temp._rf_snapshot(p_phase text)
RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  INSERT INTO _rf_keys (tenant, item, site)
  SELECT DISTINCT ON (item, site) tenant, item, site FROM (
    SELECT b.tenant_id AS tenant, b.inventory_item_id AS item, b.site_id AS site
    FROM inventory_stock_balances b WHERE b.tenant_id IN (SELECT tenant FROM _rf_target)
    UNION ALL
    SELECT sm.tenant_id, sm.inventory_item_id, sm.site_id
    FROM stock_movements sm WHERE sm.tenant_id IN (SELECT tenant FROM _rf_target)
  ) s
  ORDER BY item, site
  ON CONFLICT (item, site) DO NOTHING;

  INSERT INTO _rf_snap (phase, tenant, item, site, qty, val, min_qty, bal_qty, bal_val)
  SELECT p_phase, k.tenant, k.item, k.site, r.qty, CASE WHEN r.qty > 0 THEN r.fifo_value ELSE 0 END, r.min_qty,
         coalesce(b.quantity_on_hand, 0), coalesce(b.quantity_on_hand, 0) * coalesce(b.weighted_average_cost, 0)
  FROM _rf_keys k
  CROSS JOIN LATERAL _replay_stock_lots(k.item, k.site) r
  LEFT JOIN inventory_stock_balances b ON b.inventory_item_id = k.item AND b.site_id = k.site;

  INSERT INTO _rf_unl (phase, tenant, movement_id, reason)
  SELECT p_phase, t.tenant, u.movement_id, u.reason
  FROM (SELECT DISTINCT tenant FROM _rf_target) t
  CROSS JOIN LATERAL pg_temp._rf_unlinked(t.tenant) u;
END $f$;

-- ===== 1. discover, capture, guard, simulate the numbering ===================
DO $$
DECLARE
  v_abort boolean := (SELECT abort_on_fail FROM _rf_cfg);
  tg record; fk record; n int; v_ids uuid[]; v_excl uuid[]; v_msg text;
BEGIN
  INSERT INTO _rf_target (inv, tenant, inv_number, inv_date, inv_status, inv_site)
  SELECT i.id, i.tenant_id, i.invoice_number, i.date, i.status, i.site_id
  FROM invoices i
  WHERE EXISTS (SELECT 1 FROM stock_documents d WHERE d.invoice_id = i.id AND d.doc_type IN ('DM', 'DP'))
    AND NOT EXISTS (SELECT 1 FROM stock_documents d WHERE d.invoice_id = i.id AND d.doc_type = 'MO');

  IF NOT EXISTS (SELECT 1 FROM _rf_target) THEN
    RAISE NOTICE 'refit: no invoice has DM/DP without MO -- nothing to do';
    INSERT INTO _rf_report (tenant, post_ord, sec, section, result, detail)
    VALUES (NULL, 0, 0, 'DISCOVERED', 'PASS', 'no invoice has DM/DP without MO -- nothing to do');
    RETURN;
  END IF;

  SELECT count(*) INTO n FROM _rf_target WHERE inv_date IS NULL;
  IF n > 0 THEN RAISE EXCEPTION 'refit aborted: % target invoice(s) have no date', n; END IF;

  -- the old documents
  INSERT INTO _rf_old_docs (id, inv, tenant, doc_type, doc_number)
  SELECT d.id, d.invoice_id, d.tenant_id, d.doc_type, d.doc_number
  FROM stock_documents d JOIN _rf_target t ON t.inv = d.invoice_id;
  SELECT count(*) INTO n FROM _rf_old_docs o JOIN _rf_target t ON t.inv = o.inv
  WHERE o.tenant IS DISTINCT FROM t.tenant OR o.doc_type NOT IN ('DM', 'DP');
  IF n > 0 THEN RAISE EXCEPTION 'refit aborted: % old document(s) of another tenant or type', n; END IF;

  -- the old cut (removal set)
  INSERT INTO _rf_old (id, inv, tenant, item, site, mtype, qty, cost, is_fg, category, created_at, doc, lot)
  SELECT sm.id, t.inv, sm.tenant_id, sm.inventory_item_id, sm.site_id, sm.movement_type, sm.quantity,
         coalesce(sm.unit_cost, 0), coalesce(ii.item_kind = 'finished_goods', false), ii.category_id,
         sm.created_at, sm.stock_document_id, sm.lot_movement_id
  FROM _rf_target t
  JOIN stock_movements sm ON sm.reference_type = 'invoice' AND sm.reference_id = t.inv
  JOIN inventory_items ii ON ii.id = sm.inventory_item_id;

  -- documents with no movements at all are not a cut: report and leave them alone
  UPDATE _rf_target t SET empty = true
  WHERE NOT EXISTS (SELECT 1 FROM _rf_old o WHERE o.inv = t.inv);
  INSERT INTO _rf_report (tenant, post_ord, sec, section, result, key, name, detail)
  SELECT t.tenant, 0, 0, 'EMPTY', 'WARN', t.inv_number, NULL,
         format('documents %s have no movements -- left untouched',
                (SELECT string_agg(doc_number, ', ' ORDER BY doc_number) FROM _rf_old_docs o WHERE o.inv = t.inv))
  FROM _rf_target t WHERE t.empty;
  UPDATE _rf_target SET post_ord = NULL WHERE empty;

  -- guards on the cut rows
  SELECT count(*) INTO n FROM _rf_old o JOIN _rf_target t ON t.inv = o.inv WHERE o.tenant IS DISTINCT FROM t.tenant;
  IF n > 0 THEN RAISE EXCEPTION 'refit aborted: % cut row(s) belong to another tenant than the invoice', n; END IF;

  SELECT count(*) INTO n FROM _rf_old
  WHERE NOT ((NOT is_fg AND mtype IN ('sale_out', 'transfer_out', 'transfer_in'))
          OR (is_fg AND mtype IN ('purchase_in', 'sale_out')))
     OR qty IS NULL OR qty <= 0;
  IF n > 0 THEN
    SELECT string_agg(DISTINCT mtype || CASE WHEN is_fg THEN ' (FG)' ELSE ' (RM)' END, ', ') INTO v_msg FROM _rf_old
    WHERE NOT ((NOT is_fg AND mtype IN ('sale_out', 'transfer_out', 'transfer_in'))
            OR (is_fg AND mtype IN ('purchase_in', 'sale_out'))) OR qty IS NULL OR qty <= 0;
    RAISE EXCEPTION 'refit aborted: % cut row(s) of an unexpected type or qty: %', n, v_msg;
  END IF;

  SELECT count(*) INTO n FROM _rf_old o
  WHERE o.doc IS NOT NULL AND NOT EXISTS (SELECT 1 FROM _rf_old_docs d WHERE d.id = o.doc AND d.inv = o.inv);
  IF n > 0 THEN RAISE EXCEPTION 'refit aborted: % cut row(s) cite a document that is not this invoice''s DM/DP', n; END IF;

  FOR tg IN SELECT inv, inv_number FROM _rf_target WHERE NOT empty LOOP
    SELECT count(DISTINCT site) INTO n FROM _rf_old WHERE inv = tg.inv AND NOT is_fg AND mtype = 'sale_out';
    IF n > 1 THEN RAISE EXCEPTION 'refit aborted: % sells raw material at % sites', tg.inv_number, n; END IF;
    SELECT count(*) INTO n FROM (
      SELECT item, site FROM _rf_old WHERE inv = tg.inv AND is_fg GROUP BY item, site
      HAVING abs(sum(qty) FILTER (WHERE mtype = 'purchase_in') - coalesce(sum(qty) FILTER (WHERE mtype = 'sale_out'), 0)) > 0.000001
          OR count(*) FILTER (WHERE mtype = 'purchase_in') = 0) x;
    IF n > 0 THEN RAISE EXCEPTION 'refit aborted: % has % finished-goods item(s) whose in / out qty differ', tg.inv_number, n; END IF;
  END LOOP;

  -- nothing outside the removal set may point into it (lot links, child documents, ...)
  FOR fk IN
    SELECT c.conrelid::regclass AS tbl, a.attname AS col, c.confrelid::regclass AS target
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
    WHERE c.contype = 'f' AND array_length(c.conkey, 1) = 1
      AND c.confrelid IN ('public.stock_movements'::regclass, 'public.stock_documents'::regclass)
  LOOP
    IF fk.target = 'public.stock_movements'::regclass THEN
      v_ids := (SELECT coalesce(array_agg(id), '{}') FROM _rf_old);
    ELSE
      v_ids := (SELECT coalesce(array_agg(o.id), '{}') FROM _rf_old_docs o JOIN _rf_target t ON t.inv = o.inv WHERE NOT t.empty);
    END IF;
    v_excl := CASE
      WHEN fk.tbl = 'public.stock_movements'::regclass THEN (SELECT coalesce(array_agg(id), '{}') FROM _rf_old)
      WHEN fk.tbl = 'public.stock_documents'::regclass THEN
        (SELECT coalesce(array_agg(o.id), '{}') FROM _rf_old_docs o JOIN _rf_target t ON t.inv = o.inv WHERE NOT t.empty)
      ELSE '{}'::uuid[] END;
    EXECUTE format('SELECT count(*) FROM %s x WHERE x.%I = ANY ($1)%s', fk.tbl, fk.col,
                   CASE WHEN fk.tbl IN ('public.stock_movements'::regclass, 'public.stock_documents'::regclass)
                        THEN ' AND NOT (x.id = ANY ($2))' ELSE '' END)
      INTO n USING v_ids, v_excl;
    IF n > 0 THEN
      RAISE EXCEPTION 'refit aborted: % row(s) of %.% point into the cut being replaced', n, fk.tbl, fk.col;
    END IF;
  END LOOP;

  -- raw material with no category cannot be re-targeted
  SELECT count(DISTINCT item) INTO n FROM _rf_old WHERE NOT is_fg AND mtype = 'sale_out' AND category IS NULL;
  IF n > 0 THEN
    INSERT INTO _rf_report (tenant, post_ord, sec, section, result, key, name, detail)
    SELECT o.tenant, NULL, 0, 'GUARD', 'FAIL', NULL, NULL,
           format('%s raw-material item(s) in the old cut have no category (cannot be part of target_splits)', n)
    FROM _rf_old o WHERE NOT o.is_fg AND o.category IS NULL LIMIT 1;
    IF v_abort THEN RAISE EXCEPTION 'refit aborted: % raw-material item(s) in the old cut have no category', n; END IF;
  END IF;

  -- per target: sites, caller, sizes
  UPDATE _rf_target t SET
    sale_site = coalesce(
      (SELECT min(o.site::text)::uuid FROM _rf_old o WHERE o.inv = t.inv AND NOT o.is_fg AND o.mtype = 'sale_out'),
      (SELECT min(o.site::text)::uuid FROM _rf_old o WHERE o.inv = t.inv AND o.is_fg),
      t.inv_site),
    central = (SELECT s.id FROM sites s WHERE s.tenant_id = t.tenant AND s.is_default),
    email = (SELECT ur.user_email FROM user_roles ur
             WHERE ur.tenant_id = t.tenant AND ur.role IN ('OWNER', 'ADMIN')
             ORDER BY ur.role DESC, ur.user_email LIMIT 1),
    rm_old = coalesce((SELECT sum(o.qty * o.cost) FROM _rf_old o WHERE o.inv = t.inv AND NOT o.is_fg AND o.mtype = 'sale_out'), 0),
    fg_old = coalesce((SELECT sum(o.qty * o.cost) FROM _rf_old o WHERE o.inv = t.inv AND o.is_fg AND o.mtype = 'purchase_in'), 0),
    has_fg = EXISTS (SELECT 1 FROM _rf_old o WHERE o.inv = t.inv AND o.is_fg),
    n_old = (SELECT count(*) FROM _rf_old o WHERE o.inv = t.inv),
    dm_old = (SELECT d.doc_number FROM _rf_old_docs d WHERE d.inv = t.inv AND d.doc_type = 'DM'),
    dp_old = (SELECT d.doc_number FROM _rf_old_docs d WHERE d.inv = t.inv AND d.doc_type = 'DP')
  WHERE NOT t.empty;
  UPDATE _rf_target SET has_rm = rm_old > 0 WHERE NOT empty;

  SELECT count(*) INTO n FROM _rf_target WHERE NOT empty AND (email IS NULL OR central IS NULL);
  IF n > 0 THEN RAISE EXCEPTION 'refit aborted: % target(s) whose tenant has no OWNER/ADMIN email or no default site', n; END IF;
  IF EXISTS (SELECT 1 FROM _rf_target WHERE NOT empty AND sale_site IS DISTINCT FROM inv_site) THEN
    RAISE NOTICE 'refit: some cuts were posted at another site than the invoice''s current site -- re-cut keeps the cut''s site';
  END IF;

  -- post order per tenant
  UPDATE _rf_target t SET post_ord = x.rn
  FROM (SELECT inv, row_number() OVER (PARTITION BY tenant ORDER BY inv_date, dm_old NULLS LAST, dp_old NULLS LAST, inv) AS rn
        FROM _rf_target WHERE NOT empty) x
  WHERE x.inv = t.inv;

  -- numbering simulation: removing every target's DM/DP first, then posting in post_ord,
  -- each issuing type gets kept max (of that tenant + prefix) + its rank.
  WITH part AS (
    SELECT t.inv, t.tenant, t.post_ord, dt.doc_type, dt.doc_type || to_char(t.inv_date, 'YYMM') || '-' AS prefix
    FROM _rf_target t
    CROSS JOIN (VALUES ('MO'), ('DM'), ('DP')) dt(doc_type)
    WHERE NOT t.empty
      AND (dt.doc_type = 'MO' OR (dt.doc_type = 'DM' AND t.has_rm) OR (dt.doc_type = 'DP' AND t.has_fg))
  ), sim AS (
    SELECT p.inv, p.doc_type,
           p.prefix || lpad((coalesce((
             SELECT max(substring(d.doc_number FROM length(p.prefix) + 1)::int)
             FROM stock_documents d
             WHERE d.tenant_id = p.tenant AND d.doc_number LIKE p.prefix || '%'
               AND d.id NOT IN (SELECT o.id FROM _rf_old_docs o JOIN _rf_target tt ON tt.inv = o.inv WHERE NOT tt.empty)
           ), 0) + row_number() OVER (PARTITION BY p.tenant, p.prefix ORDER BY p.post_ord))::text, 3, '0') AS expected
    FROM part p
  )
  UPDATE _rf_target t SET
    mo_expected = (SELECT expected FROM sim WHERE sim.inv = t.inv AND sim.doc_type = 'MO'),
    dm_expected = (SELECT expected FROM sim WHERE sim.inv = t.inv AND sim.doc_type = 'DM'),
    dp_expected = (SELECT expected FROM sim WHERE sim.inv = t.inv AND sim.doc_type = 'DP')
  WHERE NOT t.empty;

  INSERT INTO _rf_report (tenant, post_ord, sec, section, result, key, name, detail)
  SELECT t.tenant, t.post_ord, 1, 'DISCOVERED', NULL, t.inv_number, NULL,
         format('date %s, status %s, %s old rows, old docs DM=%s DP=%s -> will issue MO=%s DM=%s DP=%s',
                t.inv_date, t.inv_status, t.n_old, coalesce(t.dm_old, '-'), coalesce(t.dp_old, '-'),
                coalesce(t.mo_expected, '-'), coalesce(t.dm_expected, '-'), coalesce(t.dp_expected, '-'))
  FROM _rf_target t WHERE NOT t.empty;

  SELECT string_agg(format('%s: old DM=%s DP=%s, simulated DM=%s DP=%s', inv_number,
                           coalesce(dm_old, '-'), coalesce(dp_old, '-'), coalesce(dm_expected, '-'), coalesce(dp_expected, '-')), '; ')
    INTO v_msg
  FROM _rf_target
  WHERE NOT empty
    AND ((dm_old IS NOT NULL AND dm_old IS DISTINCT FROM dm_expected)
      OR (dp_old IS NOT NULL AND dp_old IS DISTINCT FROM dp_expected));
  IF v_msg IS NOT NULL THEN
    INSERT INTO _rf_report (tenant, post_ord, sec, section, result, key, name, detail)
    VALUES (NULL, 0, 0, 'NUMBER_PRECHECK', 'FAIL', NULL, NULL, 'old numbers would NOT come back: ' || v_msg);
    IF v_abort THEN RAISE EXCEPTION 'refit aborted before any change: old numbers would not come back: %', v_msg; END IF;
  ELSE
    INSERT INTO _rf_report (tenant, post_ord, sec, section, result, key, name, detail)
    VALUES (NULL, 0, 0, 'NUMBER_PRECHECK', 'PASS', NULL, NULL, 'every old DM/DP number is the one max+1 will issue again');
  END IF;

  -- pre-refit snapshot (every card of every in-scope tenant)
  PERFORM pg_temp._rf_snapshot('pre');
END $$;

-- ===== 2. remove the old cuts (all targets first, so the numbers free up) ======
DO $$
DECLARE t record; n int; v_expect int;
BEGIN
  FOR t IN SELECT inv, inv_number FROM _rf_target WHERE NOT empty ORDER BY tenant, post_ord LOOP
    EXECUTE 'DE' || 'LETE FROM stock_movements WHERE reference_type = ''invoice'' AND reference_id = $1' USING t.inv;
    GET DIAGNOSTICS n = ROW_COUNT;
    SELECT count(*) INTO v_expect FROM _rf_old WHERE inv = t.inv;
    IF n <> v_expect THEN
      RAISE EXCEPTION 'refit aborted: % removed % movement(s), captured %', t.inv_number, n, v_expect;
    END IF;

    EXECUTE 'DE' || 'LETE FROM stock_documents WHERE invoice_id = $1 AND doc_type IN (''DM'', ''DP'')' USING t.inv;
    GET DIAGNOSTICS n = ROW_COUNT;
    SELECT count(*) INTO v_expect FROM _rf_old_docs WHERE inv = t.inv;
    IF n <> v_expect THEN
      RAISE EXCEPTION 'refit aborted: % removed % document(s), captured %', t.inv_number, n, v_expect;
    END IF;
  END LOOP;

  -- the old cut's cards now replay without it (cards the re-cut does not touch again
  -- would otherwise keep a stale balance)
  UPDATE inventory_stock_balances b
     SET quantity_on_hand = r.qty,
         weighted_average_cost = CASE WHEN r.qty > 0 THEN r.fifo_value / r.qty ELSE 0 END,
         updated_at = now()
    FROM (SELECT DISTINCT item, site FROM _rf_old) k
    CROSS JOIN LATERAL _replay_stock_lots(k.item, k.site) r
   WHERE b.inventory_item_id = k.item AND b.site_id = k.site;
END $$;

-- ===== 3. re-pick + re-post each target ======================================
DO $$
DECLARE
  v_abort boolean := (SELECT abort_on_fail FROM _rf_cfg);
  t record; it record; c record; cd record;
  v_lots jsonb; v_sites uuid[]; v_got numeric; v_short numeric;
  v_mv jsonb; v_fg jsonb; v_total numeric; v_splits jsonb; v_res jsonb; v_rm_new numeric;
  v_bad text;
BEGIN
  FOR t IN SELECT * FROM _rf_target WHERE NOT empty ORDER BY tenant, post_ord LOOP
    PERFORM set_config('request.jwt.claims',
      json_build_object('email', t.email, 'role', 'authenticated')::text, true);
    IF current_tenant_id() IS DISTINCT FROM t.tenant OR NOT is_admin_or_owner()
       OR NOT has_module_access('purchase_orders') THEN
      RAISE EXCEPTION 'refit aborted: % does not resolve to an OWNER/ADMIN of the tenant of % with stock access',
        t.email, t.inv_number;
    END IF;

    -- lots as of the invoice date (the old cut is already gone)
    EXECUTE 'TRUN' || 'CATE _rf_lots';
    v_sites := CASE WHEN t.central = t.sale_site THEN ARRAY[t.sale_site] ELSE ARRAY[t.sale_site, t.central] END;
    v_lots := coalesce(inventory_lots_as_of(t.inv_date, v_sites), '[]'::jsonb);
    INSERT INTO _rf_lots (movement_id, item, site, category, unit_cost, qty_left, ord, first_at)
    SELECT (l.value->>'movement_id')::uuid, (e->>'inventory_item_id')::uuid, (e->>'site_id')::uuid, ii.category_id,
           (l.value->>'unit_cost')::numeric, (l.value->>'qty')::numeric, l.ordinality::int,
           (e->>'first_received_at')::timestamptz
    FROM jsonb_array_elements(v_lots) e
    CROSS JOIN LATERAL jsonb_array_elements(e->'lots') WITH ORDINALITY l(value, ordinality)
    JOIN inventory_items ii ON ii.id = (e->>'inventory_item_id')::uuid
    WHERE ii.item_kind IS DISTINCT FROM 'finished_goods'
      AND (l.value->>'qty')::numeric > 0 AND (l.value->>'unit_cost')::numeric > 0;

    -- phase 1: each original item for its original value, job site first then central
    FOR it IN
      SELECT o.item, o.category, sum(o.qty * o.cost) AS v,
             (SELECT min(l.first_at) FROM _rf_lots l WHERE l.item = o.item AND l.site = t.sale_site) AS first_at
      FROM _rf_old o
      WHERE o.inv = t.inv AND NOT o.is_fg AND o.mtype = 'sale_out'
      GROUP BY o.item, o.category
      ORDER BY o.category NULLS LAST, 4 NULLS LAST, o.item
    LOOP
      v_got := pg_temp._rf_take(t.inv, it.item, t.sale_site, t.sale_site, it.v, 1);
      IF it.v - v_got > 1e-9 AND t.central <> t.sale_site THEN
        v_got := v_got + pg_temp._rf_take(t.inv, it.item, t.sale_site, t.central, it.v - v_got, 1);
      END IF;
    END LOOP;

    -- phase 2: a category phase 1 left short is topped up like the category planner
    FOR c IN
      SELECT o.category, sum(o.qty * o.cost) AS target
      FROM _rf_old o
      WHERE o.inv = t.inv AND NOT o.is_fg AND o.mtype = 'sale_out' AND o.category IS NOT NULL
      GROUP BY o.category ORDER BY o.category
    LOOP
      v_short := c.target - coalesce((SELECT sum(s.qty * s.unit_cost) FROM _rf_steps s
                                      WHERE s.inv = t.inv AND s.category = c.category), 0);
      FOR cd IN
        SELECT x.site, x.item FROM (
          SELECT l.site, l.item, min(l.first_at) AS first_at, CASE WHEN l.site = t.sale_site THEN 0 ELSE 1 END AS site_ord
          FROM _rf_lots l
          WHERE l.category = c.category AND l.qty_left > 0
            AND (l.site = t.sale_site OR l.site = t.central)
          GROUP BY l.site, l.item) x
        ORDER BY x.site_ord, x.first_at NULLS LAST, x.item
      LOOP
        EXIT WHEN v_short <= 1e-9;
        v_short := v_short - pg_temp._rf_take(t.inv, cd.item, t.sale_site, cd.site, v_short, 2);
      END LOOP;
    END LOOP;

    -- movements: steps in pick order (central = adjacent triplet), then the FG pairs
    SELECT coalesce(jsonb_agg(x.m ORDER BY x.seq, x.sub), '[]'::jsonb) INTO v_mv
    FROM (
      SELECT s.seq, 1 AS sub, jsonb_build_object('inventory_item_id', s.item, 'site_id', s.src_site,
               'movement_type', CASE WHEN s.src_site = s.sale_site THEN 'sale_out' ELSE 'transfer_out' END,
               'quantity', s.qty, 'unit_cost', s.unit_cost, 'notes', NULL, 'lot_movement_id', s.lot) AS m
      FROM _rf_steps s WHERE s.inv = t.inv
      UNION ALL
      SELECT s.seq, 2, jsonb_build_object('inventory_item_id', s.item, 'site_id', s.sale_site,
               'movement_type', 'transfer_in', 'quantity', s.qty, 'unit_cost', s.unit_cost, 'notes', NULL,
               'lot_movement_id', NULL)
      FROM _rf_steps s WHERE s.inv = t.inv AND s.src_site <> s.sale_site
      UNION ALL
      SELECT s.seq, 3, jsonb_build_object('inventory_item_id', s.item, 'site_id', s.sale_site,
               'movement_type', 'sale_out', 'quantity', s.qty, 'unit_cost', s.unit_cost, 'notes', NULL,
               'lot_movement_id', NULL)
      FROM _rf_steps s WHERE s.inv = t.inv AND s.src_site <> s.sale_site
    ) x;

    v_rm_new := coalesce((SELECT sum(s.qty * s.unit_cost) FROM _rf_steps s WHERE s.inv = t.inv), 0);

    -- FG: same items / sites / qty; Σ value = raw material actually issued
    SELECT coalesce(jsonb_agg(x.m ORDER BY x.first_at, x.item, x.sub), '[]'::jsonb) INTO v_fg
    FROM (
      SELECT g.item, g.first_at, k.sub,
             jsonb_build_object('inventory_item_id', g.item, 'site_id', g.site,
               'movement_type', CASE k.sub WHEN 1 THEN 'purchase_in' ELSE 'sale_out' END,
               'quantity', g.qty,
               'unit_cost', CASE WHEN t.rm_old > 0 AND t.fg_old > 0 THEN g.val * v_rm_new / t.fg_old ELSE g.val END / g.qty,
               'notes', NULL) AS m
      FROM (
        SELECT o.item, o.site, min(o.created_at) AS first_at,
               sum(o.qty) FILTER (WHERE o.mtype = 'purchase_in') AS qty,
               sum(o.qty * o.cost) FILTER (WHERE o.mtype = 'purchase_in') AS val
        FROM _rf_old o WHERE o.inv = t.inv AND o.is_fg
        GROUP BY o.item, o.site) g
      CROSS JOIN (VALUES (1), (2)) k(sub)
    ) x;
    v_mv := v_mv || v_fg;

    IF jsonb_array_length(v_mv) = 0 THEN
      INSERT INTO _rf_report (tenant, post_ord, sec, section, result, key, detail)
      VALUES (t.tenant, t.post_ord, 2, 'POST', 'FAIL', t.inv_number, 'nothing could be re-cut (no lots as of the invoice date)');
      IF v_abort THEN RAISE EXCEPTION 'refit aborted: % has nothing to re-post', t.inv_number; END IF;
      CONTINUE;
    END IF;

    -- MO targets = the original per-category values, in the client's {category: pct} form
    IF t.rm_old > 0 THEN
      v_total := t.rm_old;
      SELECT jsonb_object_agg(x.category::text, 100 * x.v / v_total) INTO v_splits
      FROM (SELECT o.category, sum(o.qty * o.cost) AS v FROM _rf_old o
            WHERE o.inv = t.inv AND NOT o.is_fg AND o.mtype = 'sale_out' AND o.category IS NOT NULL
            GROUP BY o.category) x;
    ELSE
      v_total := NULL; v_splits := NULL;
    END IF;

    v_res := post_invoice_stock_deduction(t.inv, v_mv, v_total, v_splits);

    -- a new FG sale_out names the purchase_in of its own pair
    UPDATE stock_movements so SET lot_movement_id = pi.id
      FROM stock_movements pi
     WHERE so.reference_type = 'invoice' AND so.reference_id = t.inv
       AND so.movement_type = 'sale_out' AND so.lot_movement_id IS NULL
       AND pi.reference_type = 'invoice' AND pi.reference_id = t.inv AND pi.movement_type = 'purchase_in'
       AND pi.inventory_item_id = so.inventory_item_id AND pi.site_id = so.site_id
       AND EXISTS (SELECT 1 FROM inventory_items ii WHERE ii.id = so.inventory_item_id AND ii.item_kind = 'finished_goods')
       AND (SELECT count(*) FROM stock_movements z
            WHERE z.reference_type = 'invoice' AND z.reference_id = t.inv AND z.movement_type = 'purchase_in'
              AND z.inventory_item_id = so.inventory_item_id AND z.site_id = so.site_id) = 1;

    UPDATE _rf_target SET mo_new = v_res->>'mo', dm_new = v_res->>'dm', dp_new = v_res->>'dp', rm_new = v_rm_new
     WHERE inv = t.inv;

    -- number assertion: exactly the simulated numbers, i.e. the old DM/DP numbers again
    v_bad := NULL;
    IF (v_res->>'mo') IS DISTINCT FROM t.mo_expected
       OR (v_res->>'dm') IS DISTINCT FROM coalesce(t.dm_old, t.dm_expected)
       OR (v_res->>'dp') IS DISTINCT FROM coalesce(t.dp_old, t.dp_expected) THEN
      v_bad := format('%s: got MO=%s DM=%s DP=%s, expected MO=%s DM=%s DP=%s (old DM=%s DP=%s)', t.inv_number,
                      coalesce(v_res->>'mo', '-'), coalesce(v_res->>'dm', '-'), coalesce(v_res->>'dp', '-'),
                      coalesce(t.mo_expected, '-'), coalesce(coalesce(t.dm_old, t.dm_expected), '-'),
                      coalesce(coalesce(t.dp_old, t.dp_expected), '-'), coalesce(t.dm_old, '-'), coalesce(t.dp_old, '-'));
      IF v_abort THEN RAISE EXCEPTION 'refit aborted: number not reused -- %', v_bad; END IF;
    END IF;
    INSERT INTO _rf_report (tenant, post_ord, sec, section, result, key, detail)
    VALUES (t.tenant, t.post_ord, 2, 'NUMBERS', CASE WHEN v_bad IS NULL THEN 'PASS' ELSE 'FAIL' END, t.inv_number,
            coalesce(v_bad, format('old DM=%s DP=%s -> new MO=%s DM=%s DP=%s (%s rows posted)',
                                   coalesce(t.dm_old, '-'), coalesce(t.dp_old, '-'), coalesce(v_res->>'mo', '-'),
                                   coalesce(v_res->>'dm', '-'), coalesce(v_res->>'dp', '-'), v_res->>'rows')));
  END LOOP;
END $$;

-- ===== 4. balances, verification =============================================
DO $$
DECLARE
  v_abort boolean := (SELECT abort_on_fail FROM _rf_cfg);
  v_fails text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM _rf_target WHERE NOT empty) THEN RETURN; END IF;

  INSERT INTO _rf_new (id, inv, item, site, mtype, qty, cost, is_fg, category, doc, lot)
  SELECT sm.id, t.inv, sm.inventory_item_id, sm.site_id, sm.movement_type, sm.quantity, coalesce(sm.unit_cost, 0),
         coalesce(ii.item_kind = 'finished_goods', false), ii.category_id, sm.stock_document_id, sm.lot_movement_id
  FROM _rf_target t
  JOIN stock_movements sm ON sm.reference_type = 'invoice' AND sm.reference_id = t.inv
  JOIN inventory_items ii ON ii.id = sm.inventory_item_id
  WHERE NOT t.empty;

  UPDATE _rf_target t SET
    n_new = (SELECT count(*) FROM _rf_new n WHERE n.inv = t.inv),
    fg_new = coalesce((SELECT sum(n.qty * n.cost) FROM _rf_new n WHERE n.inv = t.inv AND n.is_fg AND n.mtype = 'purchase_in'), 0),
    rm_new = coalesce((SELECT sum(n.qty * n.cost) FROM _rf_new n WHERE n.inv = t.inv AND NOT n.is_fg AND n.mtype = 'sale_out'), 0)
  WHERE NOT t.empty;

  -- every card the old or the new cut touched = its replay (FG pair links included)
  UPDATE inventory_stock_balances b
     SET quantity_on_hand = r.qty,
         weighted_average_cost = CASE WHEN r.qty > 0 THEN r.fifo_value / r.qty ELSE 0 END,
         updated_at = now()
    FROM (SELECT item, site FROM _rf_old UNION SELECT item, site FROM _rf_new) k
    CROSS JOIN LATERAL _replay_stock_lots(k.item, k.site) r
   WHERE b.inventory_item_id = k.item AND b.site_id = k.site
     AND (b.quantity_on_hand IS DISTINCT FROM r.qty
       OR b.weighted_average_cost IS DISTINCT FROM CASE WHEN r.qty > 0 THEN r.fifo_value / r.qty ELSE 0 END);

  PERFORM pg_temp._rf_snapshot('post');

  -- CATEGORY: old vs new issued value
  INSERT INTO _rf_report (tenant, post_ord, sec, section, result, key, name, old_value, new_value, delta, detail)
  SELECT t.tenant, t.post_ord, 3, 'CATEGORY',
         CASE WHEN abs(coalesce(nw.v, 0) - coalesce(od.v, 0)) <= 0.01 THEN 'PASS' ELSE 'FAIL' END,
         t.inv_number, coalesce(ec.name, coalesce(od.category, nw.category)::text, '(no category)'),
         round(coalesce(od.v, 0), 2), round(coalesce(nw.v, 0), 2), round(coalesce(nw.v, 0) - coalesce(od.v, 0), 4),
         format('target splits pct %s', round(coalesce((mo.target_splits->>coalesce(od.category, nw.category)::text)::numeric, 0), 6))
  FROM _rf_target t
  JOIN (SELECT inv, category, sum(qty * cost) AS v FROM _rf_old WHERE NOT is_fg AND mtype = 'sale_out' GROUP BY inv, category) od
    ON od.inv = t.inv
  LEFT JOIN (SELECT inv, category, sum(qty * cost) AS v FROM _rf_new WHERE NOT is_fg AND mtype = 'sale_out' GROUP BY inv, category) nw
    ON nw.inv = od.inv AND nw.category IS NOT DISTINCT FROM od.category
  LEFT JOIN expense_categories ec ON ec.id = coalesce(od.category, nw.category)
  LEFT JOIN stock_documents mo ON mo.invoice_id = t.inv AND mo.doc_type = 'MO'
  WHERE NOT t.empty;
  -- categories only in the new cut (cannot happen: phase 2 stays inside old categories)
  INSERT INTO _rf_report (tenant, post_ord, sec, section, result, key, name, new_value, delta, detail)
  SELECT t.tenant, t.post_ord, 3, 'CATEGORY', 'FAIL', t.inv_number, coalesce(nw.category::text, '(no category)'),
         round(nw.v, 2), round(nw.v, 4), 'category issued by the re-cut but not by the old cut'
  FROM _rf_target t
  JOIN (SELECT inv, category, sum(qty * cost) AS v FROM _rf_new WHERE NOT is_fg AND mtype = 'sale_out' GROUP BY inv, category) nw
    ON nw.inv = t.inv
  WHERE NOT EXISTS (SELECT 1 FROM _rf_old o WHERE o.inv = t.inv AND NOT o.is_fg AND o.mtype = 'sale_out'
                     AND o.category IS NOT DISTINCT FROM nw.category);

  -- ITEM: old vs new issued value per item
  INSERT INTO _rf_report (tenant, post_ord, sec, section, result, key, name, old_value, new_value, delta, detail)
  SELECT t.tenant, t.post_ord, 4, 'ITEM',
         CASE WHEN abs(coalesce(x.nv, 0) - coalesce(x.ov, 0)) <= 0.01 THEN 'PASS'
              WHEN EXISTS (SELECT 1 FROM _rf_report r WHERE r.section = 'CATEGORY' AND r.key = t.inv_number
                             AND r.result = 'FAIL') THEN 'FAIL'
              ELSE 'WARN' END,
         t.inv_number, coalesce(ii.code, '') || ' ' || coalesce(ii.name, ''),
         round(coalesce(x.ov, 0), 2), round(coalesce(x.nv, 0), 2), round(coalesce(x.nv, 0) - coalesce(x.ov, 0), 4),
         format('old qty %s -> new qty %s', round(coalesce(x.oq, 0), 4), round(coalesce(x.nq, 0), 4))
  FROM _rf_target t
  JOIN (
    SELECT coalesce(o.inv, n.inv) AS inv, coalesce(o.item, n.item) AS item, o.v AS ov, o.q AS oq, n.v AS nv, n.q AS nq
    FROM (SELECT inv, item, sum(qty * cost) AS v, sum(qty) AS q FROM _rf_old WHERE NOT is_fg AND mtype = 'sale_out' GROUP BY inv, item) o
    FULL JOIN (SELECT inv, item, sum(qty * cost) AS v, sum(qty) AS q FROM _rf_new WHERE NOT is_fg AND mtype = 'sale_out' GROUP BY inv, item) n
      ON n.inv = o.inv AND n.item = o.item) x ON x.inv = t.inv
  LEFT JOIN inventory_items ii ON ii.id = x.item
  WHERE NOT t.empty;

  -- RM_TOTAL / FG / MO / LINKS per invoice
  INSERT INTO _rf_report (tenant, post_ord, sec, section, result, key, name, old_value, new_value, delta, detail)
  SELECT t.tenant, t.post_ord, 5, 'RM_TOTAL', CASE WHEN abs(t.rm_new - t.rm_old) <= 0.01 THEN 'PASS' ELSE 'FAIL' END,
         t.inv_number, coalesce(t.dm_old, '-') || ' -> ' || coalesce(t.dm_new, '-'),
         round(t.rm_old, 2), round(t.rm_new, 2), round(t.rm_new - t.rm_old, 4),
         format('rows old %s -> new %s (RM: sale_out %s -> %s, transfer_out %s -> %s)', t.n_old, t.n_new,
                (SELECT count(*) FROM _rf_old o WHERE o.inv = t.inv AND NOT o.is_fg AND o.mtype = 'sale_out'),
                (SELECT count(*) FROM _rf_new n WHERE n.inv = t.inv AND NOT n.is_fg AND n.mtype = 'sale_out'),
                (SELECT count(*) FROM _rf_old o WHERE o.inv = t.inv AND o.mtype = 'transfer_out'),
                (SELECT count(*) FROM _rf_new n WHERE n.inv = t.inv AND n.mtype = 'transfer_out'))
  FROM _rf_target t WHERE NOT t.empty
  UNION ALL
  SELECT t.tenant, t.post_ord, 6, 'FG',
         CASE WHEN NOT t.has_fg THEN 'PASS'
              WHEN t.rm_old > 0 AND abs(t.fg_new - t.rm_new) > 0.01 THEN 'FAIL'
              WHEN t.rm_old = 0 AND abs(t.fg_new - t.fg_old) > 0.01 THEN 'FAIL'
              ELSE 'PASS' END,
         t.inv_number, coalesce(t.dp_old, '-') || ' -> ' || coalesce(t.dp_new, '-'),
         round(t.fg_old, 2), round(t.fg_new, 2), round(t.fg_new - t.fg_old, 4),
         format('FG new %s vs raw material issued %s; FG rows with notes now %s',
                round(t.fg_new, 2), round(t.rm_new, 2),
                (SELECT count(*) FROM stock_movements sm JOIN _rf_new n ON n.id = sm.id
                 WHERE n.inv = t.inv AND n.is_fg AND sm.notes IS NOT NULL))
  FROM _rf_target t WHERE NOT t.empty
  UNION ALL
  SELECT t.tenant, t.post_ord, 7, 'MO',
         CASE WHEN mo.id IS NULL THEN 'FAIL'
              WHEN t.rm_old > 0 AND (abs(coalesce(mo.target_total, -1) - t.rm_old) > 0.01
                     OR abs(coalesce((SELECT sum(v::numeric) FROM jsonb_each_text(mo.target_splits) AS s(k, v)), 0) - 100) > 0.000001)
                THEN 'FAIL'
              WHEN (SELECT count(*) FROM stock_documents d WHERE d.invoice_id = t.inv AND d.doc_type IN ('DM', 'DP')
                      AND d.parent_document_id IS DISTINCT FROM mo.id) > 0 THEN 'FAIL'
              ELSE 'PASS' END,
         t.inv_number, mo.doc_number, round(t.rm_old, 2), round(mo.target_total, 2), NULL,
         format('target_total %s, splits %s, DM/DP parent = MO: %s', mo.target_total, mo.target_splits,
                (SELECT bool_and(d.parent_document_id = mo.id) FROM stock_documents d
                 WHERE d.invoice_id = t.inv AND d.doc_type IN ('DM', 'DP')))
  FROM _rf_target t
  LEFT JOIN stock_documents mo ON mo.invoice_id = t.inv AND mo.doc_type = 'MO'
  WHERE NOT t.empty
  UNION ALL
  SELECT t.tenant, t.post_ord, 8, 'LINKS',
         CASE WHEN count(n.id) FILTER (WHERE n.mtype IN ('sale_out', 'transfer_out') AND n.lot IS NULL) = 0
              THEN 'PASS' ELSE 'FAIL' END,
         t.inv_number, NULL, NULL, NULL, NULL,
         format('new out-rows without a lot: %s of %s (FG sale_out linked to its pair: %s)',
                count(n.id) FILTER (WHERE n.mtype IN ('sale_out', 'transfer_out') AND n.lot IS NULL),
                count(n.id) FILTER (WHERE n.mtype IN ('sale_out', 'transfer_out')),
                count(n.id) FILTER (WHERE n.is_fg AND n.mtype = 'sale_out' AND n.lot IS NOT NULL))
  FROM _rf_target t LEFT JOIN _rf_new n ON n.inv = t.inv
  WHERE NOT t.empty
  GROUP BY t.tenant, t.post_ord, t.inv_number;

  -- per tenant: balances = replay, no deeper dips, no new unexplained unlinked out-rows
  INSERT INTO _rf_report (tenant, post_ord, sec, section, result, key, name, old_value, new_value, delta, detail)
  SELECT x.tenant, 999, 10, 'BALANCES',
         CASE WHEN x.touched_bad = 0 AND x.post_bad <= x.pre_bad THEN 'PASS' ELSE 'FAIL' END,
         NULL, NULL, x.pre_bad, x.post_bad, NULL,
         format('cards whose balance <> replay: before %s, after %s (of them touched by the refit: %s)',
                x.pre_bad, x.post_bad, x.touched_bad)
  FROM (
    SELECT tn.tenant,
      (SELECT count(*) FROM _rf_snap s WHERE s.phase = 'pre' AND s.tenant = tn.tenant
        AND (abs(s.bal_qty - s.qty) > 0.0001 OR abs(s.bal_val - s.val) > 0.01)) AS pre_bad,
      (SELECT count(*) FROM _rf_snap s WHERE s.phase = 'post' AND s.tenant = tn.tenant
        AND (abs(s.bal_qty - s.qty) > 0.0001 OR abs(s.bal_val - s.val) > 0.01)) AS post_bad,
      (SELECT count(*) FROM _rf_snap s WHERE s.phase = 'post' AND s.tenant = tn.tenant
        AND (abs(s.bal_qty - s.qty) > 0.0001 OR abs(s.bal_val - s.val) > 0.01)
        AND (s.item, s.site) IN (SELECT item, site FROM _rf_old UNION SELECT item, site FROM _rf_new)) AS touched_bad
    FROM (SELECT DISTINCT tenant FROM _rf_target WHERE NOT empty) tn) x;

  INSERT INTO _rf_report (tenant, post_ord, sec, section, result, key, name, old_value, new_value, delta, detail)
  SELECT p.tenant, 999, 11, 'MIN_QTY', 'FAIL', NULL, coalesce(ii.code, '') || ' @ ' || coalesce(st.name, ''),
         round(coalesce(b.min_qty, 0), 4), round(p.min_qty, 4), round(p.min_qty - coalesce(b.min_qty, 0), 4),
         'lowest running qty is deeper than before the refit'
  FROM _rf_snap p
  LEFT JOIN _rf_snap b ON b.phase = 'pre' AND b.item = p.item AND b.site = p.site
  LEFT JOIN inventory_items ii ON ii.id = p.item
  LEFT JOIN sites st ON st.id = p.site
  WHERE p.phase = 'post' AND p.min_qty < coalesce(b.min_qty, 0) - 0.0001;
  INSERT INTO _rf_report (tenant, post_ord, sec, section, result, key, detail)
  SELECT tn.tenant, 999, 11, 'MIN_QTY', 'PASS', NULL, 'no card dips deeper than before the refit'
  FROM (SELECT DISTINCT tenant FROM _rf_target WHERE NOT empty) tn
  WHERE NOT EXISTS (SELECT 1 FROM _rf_report r WHERE r.section = 'MIN_QTY' AND r.tenant = tn.tenant);

  INSERT INTO _rf_report (tenant, post_ord, sec, section, result, key, name, old_value, new_value, delta, detail)
  SELECT tn.tenant, 999, 12, 'UNLINKED',
         CASE WHEN x.post_unexp <= x.pre_unexp THEN 'PASS' ELSE 'FAIL' END,
         NULL, NULL, x.pre_unexp, x.post_unexp, NULL,
         format('out-rows without a lot -- before: deficit %s, finished_goods %s, UNEXPECTED %s | after: deficit %s, finished_goods %s, UNEXPECTED %s',
                x.pre_def, x.pre_fg, x.pre_unexp, x.post_def, x.post_fg, x.post_unexp)
  FROM (SELECT DISTINCT tenant FROM _rf_target WHERE NOT empty) tn
  CROSS JOIN LATERAL (
    SELECT count(*) FILTER (WHERE phase = 'pre' AND reason = 'deficit') AS pre_def,
           count(*) FILTER (WHERE phase = 'pre' AND reason = 'finished_goods') AS pre_fg,
           count(*) FILTER (WHERE phase = 'pre' AND reason = 'UNEXPECTED') AS pre_unexp,
           count(*) FILTER (WHERE phase = 'post' AND reason = 'deficit') AS post_def,
           count(*) FILTER (WHERE phase = 'post' AND reason = 'finished_goods') AS post_fg,
           count(*) FILTER (WHERE phase = 'post' AND reason = 'UNEXPECTED') AS post_unexp
    FROM _rf_unl u WHERE u.tenant = tn.tenant) x;

  SELECT string_agg(format('%s %s %s', section, coalesce(key, ''), coalesce(name, '')), '; ') INTO v_fails
  FROM _rf_report WHERE result = 'FAIL';
  IF v_fails IS NOT NULL AND v_abort THEN
    RAISE EXCEPTION 'refit aborted, nothing committed -- FAIL: %', v_fails;
  END IF;
END $$;

-- ===== REPORT ================================================================
SELECT r.section, r.result, r.key AS invoice_or_doc, r.name AS item_or_category,
       r.old_value, r.new_value, r.delta, r.detail, coalesce(tn.company_name, r.tenant::text) AS tenant
FROM _rf_report r
LEFT JOIN tenants tn ON tn.id = r.tenant
ORDER BY tn.company_name NULLS FIRST, r.post_ord NULLS FIRST, r.sec, r.key, abs(coalesce(r.delta, 0)) DESC, r.name;

COMMIT;
