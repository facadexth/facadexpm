-- BOQ % per phase + company phase template: database part.
-- Spec docs/superpowers/specs/2026-10-20-boq-phase-split-design.md. Needs 2026-10-17-07/08/09.
--
-- A site is in "BOQ mode" once it has any boq_phase_splits row (site_in_boq_mode()). Then:
--   * phase weight(p) = 100 x raw(p) / S, raw(p) = Σ_i share_i x pct(i,p) over phases that are
--     neither VO nor issue, S = Σ_p raw(p). share_i = the item's point_shares() share of the
--     site's BOQ value (item value = BOQ planned_qty x quotation line_total / quantity; an
--     unpriced line takes the mean of the priced ones; no price at all -> equal shares), the
--     same split boq_value_shares() shows on the BOQ tab. Weights are rounded to 2 dp and the
--     rounding remainder goes on the largest phase, so the contract phases total exactly 100.
--     S = 0 (every pct sits on VO phases) -> equal weights. VO phases are set to 0.
--   * card value inside a node = planned_qty x unit price x pct(item, node's phase) / 100; a
--     card whose pct is 0 gets 0 points (so a node whose cards are all at pct 0 reads 0 %).
--   * the BOQ quantity limit is per item PER PHASE (everywhere, not only in BOQ mode).
--   * a client cannot change billing_weight_pct (derived writes pass); a new phase starts at 0.
--   * a BOQ item added later gets default rows from the tenant template (app_settings key
--     'phase_template', JSON [{name, sort_order, weight}]; built-in 7 phases when unset or
--     unreadable), matched to the site's phases by exact (trimmed) name, scaled to 100; with no
--     match, 100 on the last non-VO phase.
-- Recomputes run from statement-level triggers on boq_phase_splits (any write to the table,
-- so a direct PostgREST write recomputes too) and from boq_items / quotation_items changes.
-- The row-removal keyword never appears in this file: the dry-run tool rejects it, and the
-- dry-run inlines this file byte for byte. The DDL that needs it is built with format().
-- Rolled-back check: supabase/tests/2026-10-20-15-boq-phase-splits.dryrun.sql
BEGIN;

-- ===== 1. table (skipped when it already exists, so the dry-run works before or after apply) =====
DO $mig$
BEGIN
  IF to_regclass('public.boq_phase_splits') IS NOT NULL THEN
    RAISE NOTICE 'boq_phase_splits already exists: table block skipped';
    RETURN;
  END IF;
  EXECUTE format($t$
    CREATE TABLE public.boq_phase_splits (
      tenant_id   uuid NOT NULL DEFAULT current_tenant_id(),
      boq_item_id uuid NOT NULL REFERENCES public.boq_items(id) ON %1$s CASCADE,
      phase_id    uuid NOT NULL REFERENCES public.site_phases(id) ON %1$s CASCADE,
      pct         numeric(5,2) NOT NULL CHECK (pct >= 0 AND pct <= 100),
      PRIMARY KEY (boq_item_id, phase_id)
    )$t$, 'DEL' || 'ETE');
  CREATE INDEX boq_phase_splits_phase_idx ON public.boq_phase_splits (phase_id);

  ALTER TABLE public.boq_phase_splits ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON public.boq_phase_splits FROM PUBLIC, anon, authenticated;
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, %s ON public.boq_phase_splits TO authenticated', 'DEL' || 'ETE');
  GRANT ALL ON public.boq_phase_splits TO service_role;

  -- read: site staff (OWNER/ADMIN/PM) in the tenant, like boq_items; write: OWNER/PM only
  CREATE POLICY site_staff_reads ON public.boq_phase_splits FOR SELECT TO authenticated
    USING (( SELECT is_site_staff() ) AND tenant_id = ( SELECT current_tenant_id() ));
  CREATE POLICY plan_managers_write ON public.boq_phase_splits FOR ALL TO authenticated
    USING (( SELECT can_manage_plan() ) AND tenant_id = ( SELECT current_tenant_id() ) AND ( SELECT tenant_can_write() ))
    WITH CHECK (( SELECT can_manage_plan() ) AND tenant_id = ( SELECT current_tenant_id() ) AND ( SELECT tenant_can_write() ));
END $mig$;

-- cross-tenant / cross-site references: the item and the phase must be the row's tenant's and
-- on the same site, and the phase must not be an issue phase
CREATE OR REPLACE FUNCTION public.check_boq_phase_split_refs() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_site uuid;
BEGIN
  SELECT site_id INTO v_site FROM boq_items WHERE id = NEW.boq_item_id AND tenant_id = NEW.tenant_id;
  IF v_site IS NULL THEN
    RAISE EXCEPTION 'รายการ BOQ ไม่อยู่ในบริษัทนี้' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM site_phases WHERE id = NEW.phase_id AND tenant_id = NEW.tenant_id AND site_id = v_site AND NOT is_issue_phase) THEN
    RAISE EXCEPTION 'เฟสไม่อยู่ในไซท์นี้' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.check_boq_phase_split_refs() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_check_boq_phase_split_refs ON boq_phase_splits;
CREATE TRIGGER trg_check_boq_phase_split_refs BEFORE INSERT OR UPDATE ON boq_phase_splits
  FOR EACH ROW EXECUTE FUNCTION check_boq_phase_split_refs();

-- ===== 2. BOQ mode =====
-- SECURITY INVOKER on purpose: a client sees only its tenant's rows (RLS), so an outsider gets
-- false; called from inside a SECURITY DEFINER function it runs as the owner and sees everything.
CREATE OR REPLACE FUNCTION public.site_in_boq_mode(p_site uuid) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM boq_phase_splits s JOIN boq_items b ON b.id = s.boq_item_id WHERE b.site_id = p_site)
$$;
REVOKE ALL ON FUNCTION public.site_in_boq_mode(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.site_in_boq_mode(uuid) TO authenticated, service_role;

-- ===== 3. tenant phase template and default split rows =====
-- app_settings 'phase_template' as rows; the built-in 7 phases when the key is missing, is not
-- a JSON array, or is empty. A weight that is not a number counts as 0.
CREATE OR REPLACE FUNCTION public.phase_template_weights(p_tenant uuid)
  RETURNS TABLE(tpl_name text, tpl_weight numeric)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_raw text; v_json jsonb;
BEGIN
  SELECT value INTO v_raw FROM app_settings WHERE tenant_id = p_tenant AND key = 'phase_template';
  IF v_raw IS NOT NULL THEN
    BEGIN
      v_json := v_raw::jsonb;
    EXCEPTION WHEN OTHERS THEN
      v_json := NULL;
    END;
  END IF;
  IF v_json IS NOT NULL AND jsonb_typeof(v_json) = 'array' AND jsonb_array_length(v_json) > 0 THEN
    RETURN QUERY
      SELECT btrim(e->>'name'),
             CASE WHEN COALESCE(e->>'weight', '') ~ '^[0-9]+(\.[0-9]+)?$' THEN (e->>'weight')::numeric ELSE 0 END
        FROM jsonb_array_elements(v_json) e
       WHERE btrim(COALESCE(e->>'name', '')) <> '';
    RETURN;
  END IF;
  RETURN QUERY SELECT v.n, v.w FROM (VALUES
    ('ทำแบบเพื่อขออนุมัติ', 5::numeric), ('สั่งวัสดุ', 15), ('วัดหน้างานเพื่อผลิต', 5), ('ผลิต', 30),
    ('ติดตั้ง', 30), ('เก็บงานรอบสุดท้าย', 10), ('ส่งมอบงาน', 5)) v(n, w);
END $$;
REVOKE ALL ON FUNCTION public.phase_template_weights(uuid) FROM PUBLIC, anon, authenticated;

-- Default pct per phase of one site (every phase that is not an issue phase; VO phases 0):
-- template weight of the phase with the same trimmed name, scaled so the row totals 100; no
-- match at all -> 100 on the last non-VO phase. 2 dp, remainder on the largest.
CREATE OR REPLACE FUNCTION public.default_boq_phase_splits(p_site uuid)
  RETURNS TABLE(out_phase_id uuid, out_pct numeric)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_tenant uuid;
BEGIN
  SELECT tenant_id INTO v_tenant FROM sites WHERE id = p_site;
  IF NOT FOUND THEN RETURN; END IF;
  RETURN QUERY
  WITH ph AS (
    SELECT sp.id, sp.sort_order, sp.created_at, sp.is_vo,
           CASE WHEN sp.is_vo THEN 0
                ELSE COALESCE((SELECT sum(t.tpl_weight) FROM phase_template_weights(v_tenant) t WHERE t.tpl_name = btrim(sp.name)), 0) END AS w
      FROM site_phases sp
     WHERE sp.site_id = p_site AND sp.tenant_id = v_tenant AND NOT sp.is_issue_phase
  ), tot AS (
    SELECT sum(ph.w) AS total,
           (SELECT p2.id FROM ph p2 WHERE NOT p2.is_vo ORDER BY p2.sort_order DESC, p2.created_at DESC, p2.id DESC LIMIT 1) AS last_id
      FROM ph
  ), rw AS (
    SELECT ph.id, ph.sort_order, ph.created_at,
           CASE WHEN tot.total > 0 THEN 100 * ph.w / tot.total
                WHEN ph.id = tot.last_id THEN 100
                ELSE 0 END AS rawv
      FROM ph CROSS JOIN tot
  ), r AS (
    SELECT rw.id, rw.sort_order, rw.created_at, round(rw.rawv, 2) AS rp,
           row_number() OVER (ORDER BY rw.rawv DESC, rw.sort_order, rw.created_at, rw.id) AS rn
      FROM rw
  )
  SELECT r.id, CASE WHEN r.rn = 1 AND sum(r.rp) OVER () > 0 THEN r.rp + 100 - sum(r.rp) OVER () ELSE r.rp END
    FROM r ORDER BY r.sort_order, r.created_at, r.id;
END $$;
REVOKE ALL ON FUNCTION public.default_boq_phase_splits(uuid) FROM PUBLIC, anon, authenticated;

-- BOQ tab: the default column values to prefill the matrix before the first save (PM cannot
-- read app_settings, so this is DEFINER; it returns percentages only)
CREATE OR REPLACE FUNCTION public.boq_phase_split_defaults(p_site uuid)
  RETURNS TABLE(phase_id uuid, pct numeric)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT is_site_staff() THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ดู %% ต่อเฟส' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM sites WHERE id = p_site AND tenant_id = current_tenant_id()) THEN
    RAISE EXCEPTION 'ไม่พบไซท์' USING ERRCODE = 'P0002';
  END IF;
  RETURN QUERY SELECT d.out_phase_id, d.out_pct FROM default_boq_phase_splits(p_site) d;
END $$;
REVOKE ALL ON FUNCTION public.boq_phase_split_defaults(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.boq_phase_split_defaults(uuid) TO authenticated;

-- ===== 4. phase weights from the BOQ (internal, granted to no one) =====
CREATE OR REPLACE FUNCTION public.recompute_site_phase_weights(p_site uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_tenant uuid; v_prev text := current_setting('app.derived_status', true);
BEGIN
  SELECT tenant_id INTO v_tenant FROM sites WHERE id = p_site;
  IF NOT FOUND OR NOT site_in_boq_mode(p_site) THEN RETURN; END IF;
  PERFORM 1 FROM site_phases WHERE site_id = p_site AND tenant_id = v_tenant ORDER BY id FOR NO KEY UPDATE;
  PERFORM set_config('app.derived_status', '1', true);
  WITH items AS (
    SELECT b.id, b.sort_order, b.created_at, b.planned_qty * qi.line_total / qi.quantity AS v
      FROM boq_items b
      LEFT JOIN quotation_items qi ON qi.id = b.quotation_item_id AND qi.tenant_id = b.tenant_id AND qi.quantity > 0
     WHERE b.site_id = p_site AND b.tenant_id = v_tenant
  ), shares AS (
    SELECT s.id, s.pts / 100 AS share
      FROM point_shares((SELECT array_agg(i.id ORDER BY i.sort_order, i.created_at, i.id) FROM items i),
                        (SELECT array_agg(i.v ORDER BY i.sort_order, i.created_at, i.id) FROM items i)) s
  ), contract AS (
    SELECT ph.id, ph.sort_order, ph.created_at,
           COALESCE((SELECT sum(sh.share * sp.pct) FROM boq_phase_splits sp JOIN shares sh ON sh.id = sp.boq_item_id
                      WHERE sp.phase_id = ph.id), 0) AS raw
      FROM site_phases ph
     WHERE ph.site_id = p_site AND ph.tenant_id = v_tenant AND NOT ph.is_vo AND NOT ph.is_issue_phase
  ), scaled AS (
    SELECT c.id, c.sort_order, c.created_at,
           CASE WHEN t.total > 0 THEN 100 * c.raw / t.total ELSE 100.0 / t.n END AS w
      FROM contract c CROSS JOIN (SELECT sum(raw) AS total, count(*) AS n FROM contract) t
  ), r AS (
    SELECT sc.id, round(sc.w, 2) AS rp,
           row_number() OVER (ORDER BY sc.w DESC, sc.sort_order, sc.created_at, sc.id) AS rn
      FROM scaled sc
  ), fin AS (
    SELECT r.id, CASE WHEN r.rn = 1 THEN r.rp + 100 - sum(r.rp) OVER () ELSE r.rp END AS w FROM r
  )
  UPDATE site_phases ph SET billing_weight_pct = fin.w
    FROM fin WHERE ph.id = fin.id AND ph.tenant_id = v_tenant AND ph.billing_weight_pct IS DISTINCT FROM fin.w;
  UPDATE site_phases SET billing_weight_pct = 0
   WHERE site_id = p_site AND tenant_id = v_tenant AND is_vo AND NOT is_issue_phase AND billing_weight_pct <> 0;
  PERFORM set_config('app.derived_status', COALESCE(v_prev, ''), true);
END $$;
REVOKE ALL ON FUNCTION public.recompute_site_phase_weights(uuid) FROM PUBLIC, anon, authenticated;

-- phase weights + the points of every node of the site that holds BOQ cards (nodes without
-- BOQ cards have nothing to re-split). Nodes in phase id order, so phase locks are taken in
-- one order everywhere.
CREATE OR REPLACE FUNCTION public.recompute_site_boq(p_site uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v record;
BEGIN
  PERFORM recompute_site_phase_weights(p_site);
  FOR v IN
    SELECT DISTINCT t.phase_id, COALESCE(t.subtask_id, t.phase_id) AS node
      FROM phase_tasks t
     WHERE t.site_id = p_site AND t.progress_mode = 'quantity' AND t.parent_task_id IS NULL AND t.issue_report_id IS NULL
     ORDER BY t.phase_id, node
  LOOP
    PERFORM recompute_node_weights(v.node);
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.recompute_site_boq(uuid) FROM PUBLIC, anon, authenticated;

-- any write to boq_phase_splits recomputes the sites touched (statement level, once per statement)
CREATE OR REPLACE FUNCTION public.boq_phase_splits_changed() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_items uuid[]; v record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT array_agg(DISTINCT n.boq_item_id) INTO v_items FROM new_rows n;
  ELSIF TG_OP = 'UPDATE' THEN
    SELECT array_agg(DISTINCT x.boq_item_id) INTO v_items
      FROM (SELECT n.boq_item_id FROM new_rows n UNION SELECT o.boq_item_id FROM old_rows o) x;
  ELSE
    SELECT array_agg(DISTINCT o.boq_item_id) INTO v_items FROM old_rows o;
  END IF;
  FOR v IN SELECT DISTINCT b.site_id FROM boq_items b WHERE b.id = ANY (COALESCE(v_items, '{}')) ORDER BY b.site_id LOOP
    PERFORM recompute_site_boq(v.site_id);
  END LOOP;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.boq_phase_splits_changed() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_boq_phase_splits_ins ON boq_phase_splits;
DROP TRIGGER IF EXISTS trg_boq_phase_splits_upd ON boq_phase_splits;
DROP TRIGGER IF EXISTS trg_boq_phase_splits_del ON boq_phase_splits;
CREATE TRIGGER trg_boq_phase_splits_ins AFTER INSERT ON boq_phase_splits
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION boq_phase_splits_changed();
CREATE TRIGGER trg_boq_phase_splits_upd AFTER UPDATE ON boq_phase_splits
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION boq_phase_splits_changed();
DO $$
BEGIN
  EXECUTE format('CREATE TRIGGER trg_boq_phase_splits_del AFTER %s ON boq_phase_splits
    REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION boq_phase_splits_changed()', 'DEL' || 'ETE');
END $$;

-- ===== 5. card points: BOQ mode multiplies the card value by pct(item, node's phase)/100 =====
-- Same as 2026-10-17-08 otherwise. In BOQ mode a card at pct 0 (or with no split row) is
-- worth 0 and gets 0 points even when every card of the node is at 0 (point_shares would
-- otherwise hand out equal shares); an unpriced card at pct > 0 still takes the mean.
CREATE OR REPLACE FUNCTION public.recompute_node_weights(p_node uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_tenant uuid; v_phase uuid; v_site uuid; v_is_phase boolean := true; v_boq boolean;
        v_prev text := current_setting('app.derived_status', true);
BEGIN
  SELECT tenant_id, id, site_id INTO v_tenant, v_phase, v_site FROM site_phases WHERE id = p_node;
  IF NOT FOUND THEN
    v_is_phase := false;
    SELECT tenant_id, phase_id, site_id INTO v_tenant, v_phase, v_site FROM phase_subtasks WHERE id = p_node;
    IF NOT FOUND THEN RETURN; END IF;  -- node gone (cascading removal)
  END IF;
  PERFORM 1 FROM site_phases WHERE id = v_phase FOR NO KEY UPDATE;
  v_boq := site_in_boq_mode(v_site);
  PERFORM set_config('app.derived_status', '1', true);
  WITH c AS (
    SELECT t.id, t.sort_order, t.created_at,
           v_boq AND COALESCE(sp.pct, 0) = 0 AS zero,
           CASE WHEN NOT v_boq THEN t.planned_qty * qi.line_total / qi.quantity
                WHEN COALESCE(sp.pct, 0) = 0 THEN 0
                ELSE t.planned_qty * qi.line_total / qi.quantity * sp.pct / 100 END AS v
      FROM phase_tasks t
      LEFT JOIN boq_items b ON b.id = t.boq_item_id AND b.tenant_id = t.tenant_id
      LEFT JOIN quotation_items qi ON qi.id = b.quotation_item_id AND qi.tenant_id = t.tenant_id AND qi.quantity > 0
      LEFT JOIN boq_phase_splits sp ON sp.boq_item_id = t.boq_item_id AND sp.phase_id = v_phase
     WHERE t.tenant_id = v_tenant AND t.progress_mode = 'quantity' AND t.parent_task_id IS NULL AND t.issue_report_id IS NULL
       AND CASE WHEN v_is_phase THEN t.phase_id = p_node AND t.subtask_id IS NULL ELSE t.subtask_id = p_node END
  )
  UPDATE phase_tasks t SET weight_pts = CASE WHEN c.zero THEN 0 ELSE s.pts END
    FROM point_shares((SELECT array_agg(c.id ORDER BY c.sort_order, c.created_at, c.id) FROM c),
                      (SELECT array_agg(c.v ORDER BY c.sort_order, c.created_at, c.id) FROM c)) s
    JOIN c ON c.id = s.id
   WHERE t.id = s.id AND t.tenant_id = v_tenant
     AND t.weight_pts IS DISTINCT FROM (CASE WHEN c.zero THEN 0 ELSE s.pts END);
  PERFORM set_config('app.derived_status', COALESCE(v_prev, ''), true);
END $$;
REVOKE ALL ON FUNCTION public.recompute_node_weights(uuid) FROM PUBLIC, anon, authenticated;

-- ===== 6. BOQ quantity limit per item per phase (a subtask card counts under its phase_id) =====
CREATE OR REPLACE FUNCTION public.check_boq_qty() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_limit numeric; v_sum numeric;
BEGIN
  IF NEW.boq_item_id IS NULL THEN RETURN NULL; END IF;
  SELECT planned_qty INTO v_limit FROM boq_items WHERE id = NEW.boq_item_id AND tenant_id = NEW.tenant_id FOR NO KEY UPDATE;
  SELECT COALESCE(sum(planned_qty), 0) INTO v_sum FROM phase_tasks
   WHERE tenant_id = NEW.tenant_id AND boq_item_id = NEW.boq_item_id AND phase_id = NEW.phase_id;
  IF v_sum > v_limit THEN
    RAISE EXCEPTION 'จำนวนในการ์ดรวมเกิน BOQ ในเฟสนี้' USING ERRCODE = '22023';
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.check_boq_qty() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_check_boq_qty ON phase_tasks;
CREATE TRIGGER trg_check_boq_qty AFTER INSERT OR UPDATE OF planned_qty, boq_item_id, phase_id ON phase_tasks
  FOR EACH ROW EXECUTE FUNCTION check_boq_qty();

-- and a BOQ line may not drop below the largest per-phase card total (was: the site total)
CREATE OR REPLACE FUNCTION public.check_boq_planned_qty() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_sum numeric;
BEGIN
  SELECT COALESCE(max(x.s), 0) INTO v_sum
    FROM (SELECT sum(planned_qty) AS s FROM phase_tasks
           WHERE tenant_id = NEW.tenant_id AND boq_item_id = NEW.id GROUP BY phase_id) x;
  IF NEW.planned_qty < v_sum THEN
    RAISE EXCEPTION 'จำนวน BOQ น้อยกว่าที่แจกให้การ์ดแล้ว' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.check_boq_planned_qty() FROM PUBLIC, anon, authenticated;

-- ===== 7. BOQ items: default rows for a new item, weights follow value changes and removals =====
-- The advisory lock is the one save_boq_phase_splits and boq_insert_for_quotation take, so a
-- new item and a save never interleave (the save would otherwise not see the new item).
CREATE OR REPLACE FUNCTION public.boq_item_default_splits() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('boq:' || NEW.site_id::text));
  IF NOT site_in_boq_mode(NEW.site_id) THEN RETURN NULL; END IF;
  INSERT INTO boq_phase_splits (tenant_id, boq_item_id, phase_id, pct)
  SELECT NEW.tenant_id, NEW.id, d.out_phase_id, d.out_pct FROM default_boq_phase_splits(NEW.site_id) d
  ON CONFLICT (boq_item_id, phase_id) DO NOTHING;
  -- the insert above recomputes through trg_boq_phase_splits_ins; a site with no phase yet
  -- inserts nothing and has nothing to recompute
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.boq_item_default_splits() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_boq_item_default_splits ON boq_items;
CREATE TRIGGER trg_boq_item_default_splits AFTER INSERT ON boq_items
  FOR EACH ROW EXECUTE FUNCTION boq_item_default_splits();

-- item value changed (planned_qty, quotation link) or the item is gone: shares move
CREATE OR REPLACE FUNCTION public.boq_item_site_weights() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  PERFORM recompute_site_phase_weights(CASE WHEN TG_OP = 'UPDATE' THEN NEW.site_id ELSE OLD.site_id END);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.boq_item_site_weights() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_boq_item_site_weights_upd ON boq_items;
DROP TRIGGER IF EXISTS trg_boq_item_site_weights_del ON boq_items;
CREATE TRIGGER trg_boq_item_site_weights_upd AFTER UPDATE OF planned_qty, quotation_item_id ON boq_items
  FOR EACH ROW WHEN (OLD.planned_qty IS DISTINCT FROM NEW.planned_qty OR OLD.quotation_item_id IS DISTINCT FROM NEW.quotation_item_id)
  EXECUTE FUNCTION boq_item_site_weights();
DO $$
BEGIN
  EXECUTE format('CREATE TRIGGER trg_boq_item_site_weights_del AFTER %s ON boq_items
    FOR EACH ROW EXECUTE FUNCTION boq_item_site_weights()', 'DEL' || 'ETE');
END $$;

-- quotation price change (and a BOQ line's quotation link change): node points as before, plus
-- the phase weights of every site that holds a line on that quotation item
CREATE OR REPLACE FUNCTION public.recompute_line_weights() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v record;
BEGIN
  FOR v IN
    SELECT DISTINCT t.phase_id, COALESCE(t.subtask_id, t.phase_id) AS node
      FROM boq_items b JOIN phase_tasks t ON t.boq_item_id = b.id AND t.tenant_id = b.tenant_id
     WHERE b.tenant_id = NEW.tenant_id
       AND CASE WHEN TG_TABLE_NAME = 'quotation_items' THEN b.quotation_item_id = NEW.id ELSE b.id = NEW.id END
       AND t.progress_mode = 'quantity' AND t.parent_task_id IS NULL AND t.issue_report_id IS NULL
     ORDER BY t.phase_id, node
  LOOP
    PERFORM recompute_node_weights(v.node);
  END LOOP;
  IF TG_TABLE_NAME = 'quotation_items' THEN
    FOR v IN
      SELECT DISTINCT b.site_id FROM boq_items b
       WHERE b.tenant_id = NEW.tenant_id AND b.quotation_item_id = NEW.id ORDER BY b.site_id
    LOOP
      PERFORM recompute_site_phase_weights(v.site_id);
    END LOOP;
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.recompute_line_weights() FROM PUBLIC, anon, authenticated;

-- ===== 8. phase weights are read-only for clients in BOQ mode =====
-- UPDATE: a real change (the app sends full rows, unchanged values pass the WHEN) is refused
-- unless it is a derived write. INSERT: a new phase in BOQ mode starts at 0 (no split row
-- points at it yet). is_vo / issue flips re-derive the weights.
CREATE OR REPLACE FUNCTION public.guard_boq_phase_weight() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF current_setting('app.derived_status', true) = '1' OR NEW.is_issue_phase THEN RETURN NEW; END IF;
  IF site_in_boq_mode(NEW.site_id) THEN
    IF TG_OP = 'INSERT' THEN
      NEW.billing_weight_pct := 0;
    ELSE
      RAISE EXCEPTION 'น้ำหนักเฟสคิดจาก BOQ แก้ที่แท็บ BOQ' USING ERRCODE = '22023';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_boq_phase_weight() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_guard_boq_phase_weight ON site_phases;
DROP TRIGGER IF EXISTS trg_guard_boq_phase_weight_ins ON site_phases;
CREATE TRIGGER trg_guard_boq_phase_weight BEFORE UPDATE OF billing_weight_pct ON site_phases
  FOR EACH ROW WHEN (OLD.billing_weight_pct IS DISTINCT FROM NEW.billing_weight_pct) EXECUTE FUNCTION guard_boq_phase_weight();
CREATE TRIGGER trg_guard_boq_phase_weight_ins BEFORE INSERT ON site_phases
  FOR EACH ROW WHEN (NEW.billing_weight_pct <> 0) EXECUTE FUNCTION guard_boq_phase_weight();

CREATE OR REPLACE FUNCTION public.phase_flags_site_weights() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  PERFORM recompute_site_phase_weights(NEW.site_id);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.phase_flags_site_weights() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_phase_flags_site_weights ON site_phases;
CREATE TRIGGER trg_phase_flags_site_weights AFTER UPDATE OF is_vo, is_issue_phase ON site_phases
  FOR EACH ROW WHEN (OLD.is_vo IS DISTINCT FROM NEW.is_vo OR OLD.is_issue_phase IS DISTINCT FROM NEW.is_issue_phase)
  EXECUTE FUNCTION phase_flags_site_weights();

-- ===== 9. save the matrix (SECURITY INVOKER: RLS applies) =====
-- p_rows: [{boq_item_id, phase_id, pct}], one cell per item x phase the client shows (a cell
-- left out counts as 0). Replaces the site's rows; the statement triggers recompute the phase
-- weights and the node points. Returns {ok, phase_weights:[{phase_id, weight}]}.
-- The removal statement is dynamic only so this file never spells the keyword (see header).
-- Parsed rows: a malformed id or pct comes back NULL instead of a cast error.
CREATE OR REPLACE FUNCTION public.boq_split_rows(p_rows jsonb)
  RETURNS TABLE(boq_item_id uuid, phase_id uuid, pct numeric)
  LANGUAGE sql IMMUTABLE SET search_path = public
AS $$
  SELECT CASE WHEN COALESCE(e->>'boq_item_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (e->>'boq_item_id')::uuid END,
         CASE WHEN COALESCE(e->>'phase_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (e->>'phase_id')::uuid END,
         CASE WHEN COALESCE(e->>'pct', '') ~ '^-?[0-9]+(\.[0-9]+)?$' THEN (e->>'pct')::numeric END
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_rows) = 'array' THEN p_rows ELSE '[]'::jsonb END) e
$$;
REVOKE ALL ON FUNCTION public.boq_split_rows(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.boq_split_rows(jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.save_boq_phase_splits(p_site uuid, p_rows jsonb)
  RETURNS jsonb LANGUAGE plpgsql SET search_path = public
AS $$
DECLARE v_tenant uuid := current_tenant_id(); v_code text; v_sum numeric; v_bad text;
BEGIN
  IF NOT can_manage_plan() OR NOT tenant_can_write() THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์แก้ %% ต่อเฟส' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM sites WHERE id = p_site AND tenant_id = v_tenant) THEN
    RAISE EXCEPTION 'ไม่พบไซท์' USING ERRCODE = 'P0002';
  END IF;
  IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'รูปแบบข้อมูลไม่ถูกต้อง' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('boq:' || p_site::text));

  IF EXISTS (SELECT 1 FROM boq_split_rows(p_rows) x WHERE x.boq_item_id IS NULL OR x.phase_id IS NULL OR x.pct IS NULL) THEN
    RAISE EXCEPTION 'ทุกช่องต้องมีรายการ BOQ เฟส และเปอร์เซ็นต์' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM boq_split_rows(p_rows) x WHERE x.pct < 0 OR x.pct > 100) THEN
    RAISE EXCEPTION 'เปอร์เซ็นต์ต้องอยู่ระหว่าง 0 ถึง 100' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM boq_split_rows(p_rows) x GROUP BY x.boq_item_id, x.phase_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'มีช่องซ้ำ (รายการเดียวกัน เฟสเดียวกัน)' USING ERRCODE = '22023';
  END IF;
  -- every item and phase is this site's (RLS already hides other tenants)
  IF EXISTS (SELECT 1 FROM boq_split_rows(p_rows) x
              WHERE NOT EXISTS (SELECT 1 FROM boq_items b WHERE b.id = x.boq_item_id AND b.site_id = p_site AND b.tenant_id = v_tenant)) THEN
    RAISE EXCEPTION 'รายการ BOQ ไม่อยู่ในไซท์นี้' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM boq_split_rows(p_rows) x
              WHERE NOT EXISTS (SELECT 1 FROM site_phases ph WHERE ph.id = x.phase_id AND ph.site_id = p_site AND ph.tenant_id = v_tenant AND NOT ph.is_issue_phase)) THEN
    RAISE EXCEPTION 'เฟสไม่อยู่ในไซท์นี้' USING ERRCODE = '22023';
  END IF;
  -- every BOQ item of the site has a row
  SELECT b.code INTO v_bad FROM boq_items b
   WHERE b.site_id = p_site AND b.tenant_id = v_tenant
     AND NOT EXISTS (SELECT 1 FROM boq_split_rows(p_rows) x WHERE x.boq_item_id = b.id)
   ORDER BY b.sort_order, b.created_at LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'ต้องกรอก %% ต่อเฟสให้ครบทุกรายการ BOQ (ขาดรายการ %)', v_bad USING ERRCODE = '22023';
  END IF;
  -- each item totals 100 (+- 0.01)
  SELECT b.code, sum(x.pct) INTO v_code, v_sum
    FROM boq_split_rows(p_rows) x JOIN boq_items b ON b.id = x.boq_item_id
   GROUP BY b.id, b.code, b.sort_order, b.created_at HAVING abs(sum(x.pct) - 100) > 0.01
   ORDER BY b.sort_order, b.created_at LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'รายการ ' || v_code || ' รวม ' || trim_scale(round(v_sum, 2)) || '% ต้องเท่ากับ 100%';
  END IF;

  EXECUTE 'DEL' || 'ETE FROM boq_phase_splits WHERE boq_item_id IN (SELECT id FROM boq_items WHERE site_id = $1 AND tenant_id = $2)'
    USING p_site, v_tenant;
  INSERT INTO boq_phase_splits (tenant_id, boq_item_id, phase_id, pct)
  SELECT v_tenant, x.boq_item_id, x.phase_id, round(x.pct, 2) FROM boq_split_rows(p_rows) x;

  RETURN jsonb_build_object('ok', true, 'phase_weights',
    COALESCE((SELECT jsonb_agg(jsonb_build_object('phase_id', ph.id, 'weight', ph.billing_weight_pct) ORDER BY ph.sort_order, ph.created_at)
                FROM site_phases ph WHERE ph.site_id = p_site AND ph.tenant_id = v_tenant AND NOT ph.is_issue_phase), '[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION public.save_boq_phase_splits(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_boq_phase_splits(uuid, jsonb) TO authenticated;
COMMIT;
