-- DRY RUN of supabase/datafix/2026-10-26-05-fifo-switchover.sql -- always rolls back.
-- Controller runs it on CHANG AFTER migrations 2026-10-26-01 .. -05 are live, as ONE call.
-- Body between BEGIN and the VERIFICATION marker is the real file verbatim (its header
-- comment explains every step). Prints ONE result set:
--   TOTAL / SUMMARY / DELTA   the report the owner reads before the real run
--   CHECK  (result PASS/FAIL) per tenant: out-rows still unlinked, bucketed (deficit /
--          negative adjustment / unexplained = must be 0); every balance equals a fresh
--          _replay_stock_lots. Global: generic links changed no card's replay; every lot
--          link names an in-row of the same tenant/item/site; STI exact-link coverage.
--   SAMPLE the 5 largest-delta cards per tenant with min running qty + remaining lots.
-- Any guard RAISE in the body aborts the call with its message (that is a FAIL too).
BEGIN;

-- ===== scratch ===============================================================
CREATE TEMP TABLE IF NOT EXISTS _fx_keys (tenant_id uuid, item uuid, site uuid, PRIMARY KEY (item, site));
CREATE TEMP TABLE IF NOT EXISTS _fx_before (item uuid, site uuid, qty numeric, wac numeric, PRIMARY KEY (item, site));
CREATE TEMP TABLE IF NOT EXISTS _fx_links (movement_id uuid PRIMARY KEY, tenant_id uuid, how text);
CREATE TEMP TABLE IF NOT EXISTS _fx_unlinked (movement_id uuid PRIMARY KEY, tenant_id uuid, reason text);
CREATE TEMP TABLE IF NOT EXISTS _fx_pre (item uuid, site uuid, qty numeric, fifo_value numeric, PRIMARY KEY (item, site));
CREATE TEMP TABLE IF NOT EXISTS _fx_after (tenant_id uuid, item uuid, site uuid, qty numeric, fifo_value numeric,
  wac numeric, min_qty numeric, lots jsonb, PRIMARY KEY (item, site));
CREATE TEMP TABLE IF NOT EXISTS _fx_report (tenant_sort int, tenant_name text, sec int, section text, ord numeric,
  result text, item_code text, item_name text, site_name text, old_qty numeric, new_qty numeric,
  old_value numeric, new_value numeric, delta numeric, detail text, tenant_id uuid);
DO $$ BEGIN EXECUTE 'TRUN' || 'CATE _fx_keys, _fx_before, _fx_links, _fx_unlinked, _fx_pre, _fx_after, _fx_report'; END $$;

-- ===== 1. every card + its pre-fix stored balance ============================
-- A card = (item, site). Tenant from the balance row when there is one, else from the ledger.
INSERT INTO _fx_keys (tenant_id, item, site)
SELECT DISTINCT ON (item, site) tenant_id, item, site
FROM (
  SELECT tenant_id, inventory_item_id AS item, site_id AS site, 0 AS prio FROM inventory_stock_balances
  UNION ALL
  SELECT tenant_id, inventory_item_id, site_id, 1 FROM stock_movements
) s
ORDER BY item, site, prio;

INSERT INTO _fx_before (item, site, qty, wac)
SELECT inventory_item_id, site_id, coalesce(quantity_on_hand, 0), coalesce(weighted_average_cost, 0)
FROM inventory_stock_balances;

-- ===== 2a. exact: STI post PO-receipt reversals ==============================
WITH u AS (
  UPDATE stock_movements sm
     SET lot_movement_id = r.source_movement_id
    FROM supplier_tax_invoice_reversals r
    JOIN stock_movements src ON src.id = r.source_movement_id
   WHERE sm.id = r.reversal_movement_id
     AND sm.tenant_id = r.tenant_id
     AND sm.movement_type = 'receipt_reversal'
     AND sm.lot_movement_id IS NULL
     AND src.tenant_id = sm.tenant_id
     AND src.inventory_item_id = sm.inventory_item_id
     AND src.site_id = sm.site_id
  RETURNING sm.id, sm.tenant_id)
INSERT INTO _fx_links (movement_id, tenant_id, how)
SELECT id, tenant_id, 'sti_post' FROM u
ON CONFLICT (movement_id) DO NOTHING;

-- ===== 2b. exact: STI void invoice-line reversals (unambiguous pairs only) ====
WITH cand AS (
  SELECT rv.id AS rv_id, src.id AS lot_id
  FROM stock_movements rv
  JOIN supplier_tax_invoice_items i
    ON i.invoice_id = rv.reference_id AND i.tenant_id = rv.tenant_id AND i.posted_movement_id IS NOT NULL
  JOIN stock_movements src
    ON src.id = i.posted_movement_id
   AND src.tenant_id = rv.tenant_id
   AND src.inventory_item_id = rv.inventory_item_id
   AND src.site_id = rv.site_id
   AND src.movement_type = 'purchase_in'
   AND src.quantity = rv.quantity
   AND coalesce(src.unit_cost, 0) = coalesce(rv.unit_cost, 0)
  WHERE rv.movement_type = 'receipt_reversal'
    AND rv.reference_type = 'supplier_tax_invoice_void'
    AND rv.lot_movement_id IS NULL
    -- a lot already claimed by an earlier run's void link is taken
    AND NOT EXISTS (SELECT 1 FROM stock_movements x
                     WHERE x.lot_movement_id = src.id AND x.movement_type = 'receipt_reversal'
                       AND x.reference_type = 'supplier_tax_invoice_void')
), uniq AS (
  SELECT rv_id, lot_id,
         count(*) OVER (PARTITION BY rv_id) AS n_rv,
         count(*) OVER (PARTITION BY lot_id) AS n_lot
  FROM cand
), u AS (
  UPDATE stock_movements sm
     SET lot_movement_id = q.lot_id
    FROM uniq q
   WHERE sm.id = q.rv_id AND q.n_rv = 1 AND q.n_lot = 1 AND sm.lot_movement_id IS NULL
  RETURNING sm.id, sm.tenant_id)
INSERT INTO _fx_links (movement_id, tenant_id, how)
SELECT id, tenant_id, 'sti_void' FROM u
ON CONFLICT (movement_id) DO NOTHING;

-- ===== replay of every card BEFORE the generic pass (for the proof in step 3) ==
INSERT INTO _fx_pre (item, site, qty, fifo_value)
SELECT k.item, k.site, r.qty, r.fifo_value
FROM _fx_keys k CROSS JOIN LATERAL _replay_stock_lots(k.item, k.site) r;

-- ===== 3. generic pass: link each unlinked out-row to the first layer it eats ==
-- Mirrors _replay_stock_lots line for line (d, deficit pay-back, layer push, consume
-- via _fifo_consume with the row's link). One ordered scan over all cards; the extra
-- sentinel row flushes the last card. Links are written per card in one UPDATE.
DO $$
DECLARE
  m record; c record;
  k_item uuid; k_site uuid; k_tenant uuid;
  d numeric; deficit numeric; absorb numeric; i int; v_first int; v_link uuid;
  l_id uuid[]; l_qty numeric[];
  u_ids uuid[] := '{}'; u_lots uuid[] := '{}'; x_ids uuid[] := '{}';
BEGIN
  FOR m IN
    SELECT * FROM (
      SELECT tenant_id, inventory_item_id, site_id, id, movement_type, quantity, created_at, lot_movement_id,
             false AS sentinel
      FROM stock_movements
      UNION ALL
      SELECT NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid, NULL::text, NULL::numeric, NULL::timestamptz,
             NULL::uuid, true
    ) s
    ORDER BY sentinel, inventory_item_id, site_id, created_at, id
  LOOP
    IF m.sentinel OR k_item IS DISTINCT FROM m.inventory_item_id OR k_site IS DISTINCT FROM m.site_id THEN
      -- flush the finished card
      IF coalesce(array_length(u_ids, 1), 0) > 0 THEN
        WITH u AS (
          UPDATE stock_movements sm
             SET lot_movement_id = x.lot
            FROM unnest(u_ids, u_lots) AS x(id, lot)
           WHERE sm.id = x.id AND sm.lot_movement_id IS NULL
          RETURNING sm.id, sm.tenant_id)
        INSERT INTO _fx_links (movement_id, tenant_id, how)
        SELECT id, tenant_id, 'replay' FROM u
        ON CONFLICT (movement_id) DO NOTHING;
      END IF;
      IF coalesce(array_length(x_ids, 1), 0) > 0 THEN
        INSERT INTO _fx_unlinked (movement_id, tenant_id, reason)
        SELECT x, k_tenant, 'deficit' FROM unnest(x_ids) x
        ON CONFLICT (movement_id) DO NOTHING;
      END IF;
      EXIT WHEN m.sentinel;
      k_item := m.inventory_item_id; k_site := m.site_id; k_tenant := m.tenant_id;
      deficit := 0; l_id := '{}'; l_qty := '{}';
      u_ids := '{}'; u_lots := '{}'; x_ids := '{}';
    END IF;

    d := CASE WHEN m.movement_type IN ('purchase_in', 'transfer_in', 'sale_reversal', 'adjustment')
              THEN coalesce(m.quantity, 0)
              ELSE -coalesce(m.quantity, 0) END;

    IF d > 0 THEN
      absorb := least(deficit, d);
      deficit := deficit - absorb;
      IF d - absorb > 0 THEN
        l_id := l_id || m.id; l_qty := l_qty || (d - absorb);
      END IF;
    ELSIF d < 0 THEN
      v_link := CASE WHEN m.movement_type = 'adjustment' THEN NULL ELSE m.lot_movement_id END;
      IF m.lot_movement_id IS NULL
         AND m.movement_type IN ('sale_out', 'transfer_out', 'purchase_return', 'receipt_reversal') THEN
        v_first := NULL;
        FOR i IN 1 .. coalesce(array_length(l_qty, 1), 0) LOOP
          IF l_qty[i] > 0 THEN v_first := i; EXIT; END IF;
        END LOOP;
        IF v_first IS NOT NULL THEN
          v_link := l_id[v_first];
          u_ids := u_ids || m.id; u_lots := u_lots || v_link;
        ELSE
          x_ids := x_ids || m.id;   -- every layer empty: fully deficit, stays NULL
        END IF;
      END IF;
      SELECT * INTO c FROM _fifo_consume(l_id, l_qty, v_link, -d);
      l_qty := c.qtys;
      deficit := deficit + c.shortfall;
    END IF;
  END LOOP;
END $$;

-- ===== replay of every card AFTER the generic pass ===========================
INSERT INTO _fx_after (tenant_id, item, site, qty, fifo_value, wac, min_qty, lots)
SELECT k.tenant_id, k.item, k.site, r.qty, r.fifo_value,
       CASE WHEN r.qty > 0 THEN r.fifo_value / r.qty ELSE 0 END, r.min_qty, r.lots
FROM _fx_keys k CROSS JOIN LATERAL _replay_stock_lots(k.item, k.site) r;

-- Guards: the generic links must not change any card's replay, and every link this run
-- wrote must name an in-row (a pushed layer) of the same tenant, item and site.
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n
  FROM _fx_pre p JOIN _fx_after a USING (item, site)
  WHERE p.qty IS DISTINCT FROM a.qty OR p.fifo_value IS DISTINCT FROM a.fifo_value;
  IF n > 0 THEN
    RAISE EXCEPTION 'fifo switch-over aborted: % card(s) replay differently after the generic link pass', n;
  END IF;

  SELECT count(*) INTO n
  FROM _fx_links l
  JOIN stock_movements sm ON sm.id = l.movement_id
  LEFT JOIN stock_movements t ON t.id = sm.lot_movement_id
  WHERE t.id IS NULL
     OR t.tenant_id IS DISTINCT FROM sm.tenant_id
     OR t.inventory_item_id IS DISTINCT FROM sm.inventory_item_id
     OR t.site_id IS DISTINCT FROM sm.site_id
     OR NOT (CASE WHEN t.movement_type IN ('purchase_in', 'transfer_in', 'sale_reversal', 'adjustment')
                  THEN coalesce(t.quantity, 0) ELSE -coalesce(t.quantity, 0) END > 0);
  IF n > 0 THEN
    RAISE EXCEPTION 'fifo switch-over aborted: % link(s) do not name an in-row of the same tenant/item/site', n;
  END IF;
END $$;

-- ===== 4. balances = FIFO replay ============================================
INSERT INTO inventory_stock_balances (tenant_id, inventory_item_id, site_id, quantity_on_hand, weighted_average_cost, updated_at)
SELECT a.tenant_id, a.item, a.site, a.qty, a.wac, now()
FROM _fx_after a
ON CONFLICT (inventory_item_id, site_id) DO UPDATE
  SET quantity_on_hand = EXCLUDED.quantity_on_hand,
      weighted_average_cost = EXCLUDED.weighted_average_cost,
      updated_at = now()
  WHERE inventory_stock_balances.quantity_on_hand IS DISTINCT FROM EXCLUDED.quantity_on_hand
     OR inventory_stock_balances.weighted_average_cost IS DISTINCT FROM EXCLUDED.weighted_average_cost;

-- ===== 5. report =============================================================
-- old value = pre-fix qty x WAC; new value = replayed qty x FIFO WAC (both 0 when there
-- was / is no balance row). Values in baht, rounded to 2 places for reading.
WITH card AS (
  SELECT a.tenant_id, a.item, a.site,
         coalesce(b.qty, 0) AS old_qty, a.qty AS new_qty,
         coalesce(b.qty, 0) * coalesce(b.wac, 0) AS old_value,
         a.qty * a.wac AS new_value
  FROM _fx_after a LEFT JOIN _fx_before b USING (item, site)
), lk AS (
  SELECT tenant_id,
         count(*) FILTER (WHERE how = 'sti_post') AS n_post,
         count(*) FILTER (WHERE how = 'sti_void') AS n_void,
         count(*) FILTER (WHERE how = 'replay') AS n_replay
  FROM _fx_links GROUP BY tenant_id
), ul AS (
  SELECT tenant_id, count(*) AS n_deficit FROM _fx_unlinked GROUP BY tenant_id
), per_tenant AS (
  SELECT c.tenant_id, count(*) AS n_cards,
         count(*) FILTER (WHERE abs(c.new_value - c.old_value) > 0.01 OR c.new_qty <> c.old_qty) AS n_changed,
         sum(c.old_value) AS old_value, sum(c.new_value) AS new_value
  FROM card c GROUP BY c.tenant_id
)
INSERT INTO _fx_report (tenant_sort, tenant_name, sec, section, ord, result, item_code, item_name, site_name,
                        old_qty, new_qty, old_value, new_value, delta, detail, tenant_id)
SELECT 0, '(all tenants)'::text, 0, 'TOTAL', 0, NULL::text, NULL::text, NULL::text, NULL::text, NULL::numeric, NULL::numeric,
       round(sum(p.old_value), 2), round(sum(p.new_value), 2), round(sum(p.new_value - p.old_value), 2),
       format('tenants %s | cards %s (changed %s) | links STI-post %s, STI-void %s, replay %s | deficit (left unlinked) %s',
              count(*), sum(p.n_cards), sum(p.n_changed),
              coalesce(sum(lk.n_post), 0), coalesce(sum(lk.n_void), 0), coalesce(sum(lk.n_replay), 0),
              coalesce(sum(ul.n_deficit), 0)),
       NULL::uuid
FROM per_tenant p LEFT JOIN lk USING (tenant_id) LEFT JOIN ul USING (tenant_id)
UNION ALL
SELECT 1, coalesce(t.company_name, p.tenant_id::text), 1, 'SUMMARY', 0, NULL::text, NULL::text, NULL::text, NULL::text, NULL::numeric, NULL::numeric,
       round(p.old_value, 2), round(p.new_value, 2), round(p.new_value - p.old_value, 2),
       format('cards %s (changed %s) | links STI-post %s, STI-void %s, replay %s | deficit (left unlinked) %s',
              p.n_cards, p.n_changed, coalesce(lk.n_post, 0), coalesce(lk.n_void, 0), coalesce(lk.n_replay, 0),
              coalesce(ul.n_deficit, 0)),
       p.tenant_id
FROM per_tenant p
LEFT JOIN tenants t ON t.id = p.tenant_id
LEFT JOIN lk USING (tenant_id) LEFT JOIN ul USING (tenant_id)
UNION ALL
SELECT 1, coalesce(t.company_name, c.tenant_id::text), 2, 'DELTA', -abs(c.new_value - c.old_value), NULL::text,
       ii.code, ii.name, s.name,
       c.old_qty, c.new_qty, round(c.old_value, 2), round(c.new_value, 2), round(c.new_value - c.old_value, 2),
       CASE WHEN c.new_qty <> c.old_qty THEN 'qty changed too (stored qty did not match the ledger)'::text END,
       c.tenant_id
FROM card c
LEFT JOIN tenants t ON t.id = c.tenant_id
LEFT JOIN inventory_items ii ON ii.id = c.item
LEFT JOIN sites s ON s.id = c.site
WHERE abs(c.new_value - c.old_value) > 0.01;

-- ===== VERIFICATION (dry-run only) ===========================================
-- Rows go into the same report (sec 3 CHECK, sec 4 SAMPLE), so the one result set below
-- carries the report AND the checks. result = PASS / FAIL on every CHECK row.
WITH outs AS (
  -- out-rows that are still unlinked after the run, bucketed by why
  SELECT sm.tenant_id,
         CASE
           WHEN sm.movement_type = 'adjustment' THEN 'adjustment'
           WHEN u.movement_id IS NOT NULL THEN 'deficit'
           ELSE 'unexplained'
         END AS bucket
  FROM stock_movements sm
  LEFT JOIN _fx_unlinked u ON u.movement_id = sm.id
  WHERE sm.lot_movement_id IS NULL
    AND ((sm.movement_type IN ('sale_out', 'transfer_out', 'purchase_return', 'receipt_reversal') AND sm.quantity > 0)
         OR (sm.movement_type = 'adjustment' AND sm.quantity < 0))
), tn AS (
  SELECT DISTINCT tenant_id FROM _fx_keys
)
INSERT INTO _fx_report (tenant_sort, tenant_name, sec, section, ord, result, detail, tenant_id)
SELECT 1, coalesce(t.company_name, tn.tenant_id::text), 3, 'CHECK', 1,
       CASE WHEN coalesce(o.n_unexplained, 0) = 0 THEN 'PASS' ELSE 'FAIL' END,
       format('unlinked out-rows: deficit %s, negative adjustments %s (never linked), unexplained %s (must be 0)',
              coalesce(o.n_deficit, 0), coalesce(o.n_adjustment, 0), coalesce(o.n_unexplained, 0)),
       tn.tenant_id
FROM tn
LEFT JOIN tenants t ON t.id = tn.tenant_id
LEFT JOIN (
  SELECT tenant_id,
         count(*) FILTER (WHERE bucket = 'deficit') AS n_deficit,
         count(*) FILTER (WHERE bucket = 'adjustment') AS n_adjustment,
         count(*) FILTER (WHERE bucket = 'unexplained') AS n_unexplained
  FROM outs GROUP BY tenant_id
) o ON o.tenant_id = tn.tenant_id;

-- every stored balance = a FRESH replay (re-run here, not the copy in _fx_after)
INSERT INTO _fx_report (tenant_sort, tenant_name, sec, section, ord, result, detail, tenant_id)
SELECT 1, coalesce(t.company_name, x.tenant_id::text), 3, 'CHECK', 2,
       CASE WHEN x.n_bad = 0 THEN 'PASS' ELSE 'FAIL' END,
       format('balances equal _replay_stock_lots: %s of %s cards (mismatches %s, missing balance rows %s)',
              x.n - x.n_bad, x.n, x.n_bad, x.n_missing),
       x.tenant_id
FROM (
  SELECT k.tenant_id, count(*) AS n,
         count(*) FILTER (WHERE b.inventory_item_id IS NULL
                             OR b.quantity_on_hand IS DISTINCT FROM r.qty
                             OR abs(b.weighted_average_cost - CASE WHEN r.qty > 0 THEN r.fifo_value / r.qty ELSE 0 END) > 1e-9) AS n_bad,
         count(*) FILTER (WHERE b.inventory_item_id IS NULL) AS n_missing
  FROM _fx_keys k
  CROSS JOIN LATERAL _replay_stock_lots(k.item, k.site) r
  LEFT JOIN inventory_stock_balances b ON b.inventory_item_id = k.item AND b.site_id = k.site
  GROUP BY k.tenant_id
) x
LEFT JOIN tenants t ON t.id = x.tenant_id;

-- global checks
INSERT INTO _fx_report (tenant_sort, tenant_name, sec, section, ord, result, detail)
SELECT 0, '(all tenants)', 3, 'CHECK', 1,
       CASE WHEN n = 0 THEN 'PASS' ELSE 'FAIL' END,
       format('generic links leave every card''s replay (qty + FIFO value) unchanged: %s card(s) differ', n)
FROM (SELECT count(*) AS n FROM _fx_pre p JOIN _fx_after a USING (item, site)
      WHERE p.qty IS DISTINCT FROM a.qty OR p.fifo_value IS DISTINCT FROM a.fifo_value) z
UNION ALL
SELECT 0, '(all tenants)', 3, 'CHECK', 2,
       CASE WHEN n = 0 THEN 'PASS' ELSE 'FAIL' END,
       format('every lot link (all rows, old and new) names an in-row of the same tenant/item/site: %s bad', n)
FROM (SELECT count(*) AS n
        FROM stock_movements sm
        JOIN stock_movements t ON t.id = sm.lot_movement_id
       WHERE t.tenant_id <> sm.tenant_id OR t.inventory_item_id <> sm.inventory_item_id OR t.site_id <> sm.site_id
          OR NOT (CASE WHEN t.movement_type IN ('purchase_in', 'transfer_in', 'sale_reversal', 'adjustment')
                       THEN coalesce(t.quantity, 0) ELSE -coalesce(t.quantity, 0) END > 0)) z
UNION ALL
SELECT 0, '(all tenants)', 3, 'CHECK', 3,
       CASE WHEN n_lost = 0 THEN 'PASS' ELSE 'FAIL' END,
       format('STI exact links: post reversals linked to their source %s of %s; void line reversals linked %s of %s (unlinked = ambiguous or no match); post reversals pointing elsewhere %s',
              n_post_ok, n_post, n_void_ok, n_void, n_lost)
FROM (
  SELECT (SELECT count(*) FROM supplier_tax_invoice_reversals r
            JOIN stock_movements sm ON sm.id = r.reversal_movement_id) AS n_post,
         (SELECT count(*) FROM supplier_tax_invoice_reversals r
            JOIN stock_movements sm ON sm.id = r.reversal_movement_id
           WHERE sm.lot_movement_id = r.source_movement_id) AS n_post_ok,
         (SELECT count(*) FROM supplier_tax_invoice_reversals r
            JOIN stock_movements sm ON sm.id = r.reversal_movement_id
            JOIN stock_movements src ON src.id = r.source_movement_id
           WHERE sm.lot_movement_id IS DISTINCT FROM r.source_movement_id
             AND src.inventory_item_id = sm.inventory_item_id AND src.site_id = sm.site_id) AS n_lost,
         (SELECT count(*) FROM stock_movements
           WHERE movement_type = 'receipt_reversal' AND reference_type = 'supplier_tax_invoice_void') AS n_void,
         (SELECT count(*) FROM stock_movements sm
            JOIN stock_movements t ON t.id = sm.lot_movement_id
            JOIN supplier_tax_invoice_items i ON i.posted_movement_id = t.id AND i.invoice_id = sm.reference_id
           WHERE sm.movement_type = 'receipt_reversal' AND sm.reference_type = 'supplier_tax_invoice_void') AS n_void_ok
) z;

-- spot sample: the 5 largest |delta| cards per tenant, with their remaining lots
INSERT INTO _fx_report (tenant_sort, tenant_name, sec, section, ord, result, item_code, item_name, site_name,
                        old_qty, new_qty, old_value, new_value, delta, detail, tenant_id)
SELECT 1, coalesce(t.company_name, z.tenant_id::text), 4, 'SAMPLE', z.ord, NULL::text, ii.code, ii.name, s.name,
       z.old_qty, z.new_qty, round(z.old_value, 2), round(z.new_value, 2), round(z.new_value - z.old_value, 2),
       format('min running qty %s | lots %s', z.min_qty, z.lots::text),
       z.tenant_id
FROM (
  SELECT a.tenant_id, a.item, a.site, a.min_qty, a.lots,
         coalesce(b.qty, 0) AS old_qty, a.qty AS new_qty,
         coalesce(b.qty, 0) * coalesce(b.wac, 0) AS old_value, a.qty * a.wac AS new_value,
         -abs(a.qty * a.wac - coalesce(b.qty, 0) * coalesce(b.wac, 0)) AS ord,
         row_number() OVER (PARTITION BY a.tenant_id
                            ORDER BY abs(a.qty * a.wac - coalesce(b.qty, 0) * coalesce(b.wac, 0)) DESC, a.item, a.site) AS rn
  FROM _fx_after a LEFT JOIN _fx_before b USING (item, site)
) z
LEFT JOIN tenants t ON t.id = z.tenant_id
LEFT JOIN inventory_items ii ON ii.id = z.item
LEFT JOIN sites s ON s.id = z.site
WHERE z.rn <= 5 AND abs(z.new_value - z.old_value) > 0.01;

-- ===== REPORT ================================================================
SELECT tenant_name AS tenant, section, result, item_code, item_name, site_name AS site,
       old_qty, new_qty, old_value, new_value, delta, detail
FROM _fx_report
ORDER BY tenant_sort, tenant_name, tenant_id, sec, ord, item_code;


ROLLBACK;
