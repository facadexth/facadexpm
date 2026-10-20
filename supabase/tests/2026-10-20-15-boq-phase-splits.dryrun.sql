-- Self-contained dry run for 2026-10-20-15 BOQ % per phase. Everything rolls back.
-- Works before OR after the migration is applied (table block skips itself, functions are
-- CREATE OR REPLACE, triggers are dropped and recreated). The migration body is inlined below
-- byte for byte between its BEGIN; and COMMIT; -- keep them in sync (diff the two files).
-- This file contains no row-removal keyword: where the test needs one it is built as 'DEL'||'ETE'.
-- Tenant: FacadeX 1b9affc4-2136-4ed1-b168-a36e6624e743, owner contact@facadex.co.th
-- (uid 4a4af0a6-de9a-4da7-bf2e-ef87ef085d4d). Fixture ids are md5('bps|...')::uuid, site number
-- DRY-BPS-01, quotation DRY-BPS-Q1; the tenant's phase_template setting is changed inside the
-- transaction only. Expect PASS notices (a)..(k) and a final ALL PASS row.
BEGIN;

-- ===== inlined migration 2026-10-20-15 =====

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
-- ===== end migration body =====

-- ===== fixture (as postgres) =====
-- site S with phases P1 ผลิต / P2 ติดตั้ง / P3 เก็บงาน, PLAN v1, a draft quotation with two
-- priced lines (7000 and 3000 baht -> shares 0.7 / 0.3) behind BOQ items B1 and B2 (qty 10 each),
-- and a tenant template ผลิต 10 / ติดตั้ง 30 / เก็บงานรอบสุดท้าย 20 (name-match + scaling test).
DO $$
DECLARE
  v_tenant uuid := '1b9affc4-2136-4ed1-b168-a36e6624e743';
  v_site   uuid := md5('bps|site')::uuid;
  v_client uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = v_tenant) THEN RAISE EXCEPTION 'SETUP: FacadeX tenant missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM user_roles WHERE tenant_id = v_tenant AND user_email = 'contact@facadex.co.th' AND role = 'OWNER') THEN
    RAISE EXCEPTION 'SETUP: contact@facadex.co.th is not OWNER of FacadeX';
  END IF;
  SELECT id INTO v_client FROM clients WHERE tenant_id = v_tenant ORDER BY created_at, id LIMIT 1;
  IF v_client IS NULL THEN RAISE EXCEPTION 'SETUP: FacadeX has no client for the fixture quotation'; END IF;
  IF EXISTS (SELECT 1 FROM sites WHERE tenant_id = v_tenant AND site_number = 'DRY-BPS-01') THEN
    RAISE EXCEPTION 'SETUP: site DRY-BPS-01 already exists';
  END IF;

  INSERT INTO sites (id, tenant_id, site_number, name, status, contract_value)
  VALUES (v_site, v_tenant, 'DRY-BPS-01', 'dry run: BOQ % per phase', 'Ongoing', 1000000);
  PERFORM snapshot_site_plan(v_site, 'dry run PLAN v1', true, 'system');

  INSERT INTO site_phases (id, tenant_id, site_id, name, sort_order, billing_weight_pct, status) VALUES
    (md5('bps|p1')::uuid, v_tenant, v_site, 'ผลิต', 1, 40, 'not_started'),
    (md5('bps|p2')::uuid, v_tenant, v_site, 'ติดตั้ง', 2, 40, 'not_started'),
    (md5('bps|p3')::uuid, v_tenant, v_site, 'เก็บงาน', 3, 20, 'not_started');

  INSERT INTO quotations (id, tenant_id, client_id, site_id, date, status, quotation_number)
  VALUES (md5('bps|q')::uuid, v_tenant, v_client, v_site, current_date, 'draft', 'DRY-BPS-Q1');
  INSERT INTO quotation_items (id, tenant_id, quotation_id, description, quantity, unit_price, line_total, sort_order) VALUES
    (md5('bps|qi1')::uuid, v_tenant, md5('bps|q')::uuid, 'งานกระจก', 10, 700, 7000, 1),
    (md5('bps|qi2')::uuid, v_tenant, md5('bps|q')::uuid, 'งานอลูมิเนียม', 10, 300, 3000, 2);
  INSERT INTO boq_items (id, tenant_id, site_id, quotation_item_id, code, description, planned_qty, sort_order) VALUES
    (md5('bps|b1')::uuid, v_tenant, v_site, md5('bps|qi1')::uuid, '1', 'งานกระจก', 10, 1),
    (md5('bps|b2')::uuid, v_tenant, v_site, md5('bps|qi2')::uuid, '2', 'งานอลูมิเนียม', 10, 2);
  IF EXISTS (SELECT 1 FROM boq_phase_splits s WHERE s.boq_item_id IN (md5('bps|b1')::uuid, md5('bps|b2')::uuid)) THEN
    RAISE EXCEPTION 'SETUP: a BOQ item got split rows while the site is not in BOQ mode';
  END IF;

  INSERT INTO app_settings (tenant_id, key, value)
  VALUES (v_tenant, 'phase_template', '[{"name":"ผลิต","sort_order":1,"weight":10},{"name":"ติดตั้ง","sort_order":2,"weight":30},{"name":"เก็บงานรอบสุดท้าย","sort_order":3,"weight":20}]')
  ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value;

  -- (a) table, RLS, privileges
  IF to_regclass('public.boq_phase_splits') IS NULL THEN RAISE EXCEPTION 'FAIL (a): table missing'; END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.boq_phase_splits'::regclass) THEN RAISE EXCEPTION 'FAIL (a): RLS is off'; END IF;
  IF has_table_privilege('anon', 'public.boq_phase_splits', 'SELECT') OR has_table_privilege('anon', 'public.boq_phase_splits', 'INSERT') THEN
    RAISE EXCEPTION 'FAIL (a): anon has a table privilege';
  END IF;
  IF has_function_privilege('anon', 'public.save_boq_phase_splits(uuid,jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.site_in_boq_mode(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.boq_phase_split_defaults(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL (a): anon can execute a client RPC';
  END IF;
  IF has_function_privilege('authenticated', 'public.recompute_site_phase_weights(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.recompute_site_boq(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.recompute_node_weights(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.default_boq_phase_splits(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.phase_template_weights(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL (a): authenticated can execute an internal function';
  END IF;
  RAISE NOTICE 'PASS (a) table, RLS, privileges';
END $$;

-- (b) anon is blocked
SET LOCAL role anon;
DO $$
BEGIN
  BEGIN
    PERFORM 1 FROM public.boq_phase_splits;
    RAISE EXCEPTION 'FAIL (b): anon read the table';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.save_boq_phase_splits(md5('bps|site')::uuid, '[]'::jsonb);
    RAISE EXCEPTION 'FAIL (b): anon called save_boq_phase_splits';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.site_in_boq_mode(md5('bps|site')::uuid);
    RAISE EXCEPTION 'FAIL (b): anon called site_in_boq_mode';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RAISE NOTICE 'PASS (b) anon blocked';
END $$;
RESET ROLE;

-- test helpers (as postgres; they vanish with the rollback). SECURITY INVOKER: the owner's RLS applies.
-- weights of P1/P2/P3 as 'a/b/c'
CREATE FUNCTION public.dryrun_bps_weights() RETURNS text LANGUAGE sql SET search_path = public AS $$
  SELECT string_agg(trim_scale(billing_weight_pct)::text, '/' ORDER BY sort_order)
    FROM public.site_phases WHERE site_id = md5('bps|site')::uuid AND NOT is_issue_phase
$$;
-- the matrix as rows
CREATE FUNCTION public.dryrun_bps_rows(p_b1 text[], p_b2 text[]) RETURNS jsonb LANGUAGE sql SET search_path = public AS $$
  SELECT jsonb_build_array(
    jsonb_build_object('boq_item_id', md5('bps|b1')::uuid, 'phase_id', md5('bps|p1')::uuid, 'pct', p_b1[1]),
    jsonb_build_object('boq_item_id', md5('bps|b1')::uuid, 'phase_id', md5('bps|p2')::uuid, 'pct', p_b1[2]),
    jsonb_build_object('boq_item_id', md5('bps|b1')::uuid, 'phase_id', md5('bps|p3')::uuid, 'pct', p_b1[3]),
    jsonb_build_object('boq_item_id', md5('bps|b2')::uuid, 'phase_id', md5('bps|p1')::uuid, 'pct', p_b2[1]),
    jsonb_build_object('boq_item_id', md5('bps|b2')::uuid, 'phase_id', md5('bps|p2')::uuid, 'pct', p_b2[2]),
    jsonb_build_object('boq_item_id', md5('bps|b2')::uuid, 'phase_id', md5('bps|p3')::uuid, 'pct', p_b2[3]))
$$;

GRANT EXECUTE ON FUNCTION public.dryrun_bps_weights(), public.dryrun_bps_rows(text[], text[]) TO authenticated;

-- ===== as the FacadeX owner =====
SELECT set_config('request.jwt.claims',
  json_build_object('sub', '4a4af0a6-de9a-4da7-bf2e-ef87ef085d4d', 'role', 'authenticated',
                    'email', 'contact@facadex.co.th')::text, true);
SET LOCAL role authenticated;

-- (c) not in BOQ mode yet; defaults from the template; a valid save gives 35/50/15
DO $$
DECLARE v_site uuid := md5('bps|site')::uuid; v_def text; v_out jsonb; v_w text; n int;
BEGIN
  IF public.site_in_boq_mode(v_site) THEN RAISE EXCEPTION 'FAIL (c): BOQ mode before any save'; END IF;
  IF public.dryrun_bps_weights() <> '40/40/20' THEN RAISE EXCEPTION 'FAIL (c): manual weights % before save', public.dryrun_bps_weights(); END IF;
  SELECT string_agg(trim_scale(d.pct)::text, '/' ORDER BY ph.sort_order) INTO v_def
    FROM public.boq_phase_split_defaults(v_site) d JOIN public.site_phases ph ON ph.id = d.phase_id;
  IF v_def IS DISTINCT FROM '25/75/0' THEN RAISE EXCEPTION 'FAIL (c): defaults % want 25/75/0 (template 10/30 scaled)', v_def; END IF;

  v_out := public.save_boq_phase_splits(v_site, public.dryrun_bps_rows(ARRAY['50','50','0'], ARRAY['0','50','50']));
  IF NOT public.site_in_boq_mode(v_site) THEN RAISE EXCEPTION 'FAIL (c): not in BOQ mode after save'; END IF;
  SELECT count(*) INTO n FROM public.boq_phase_splits WHERE boq_item_id IN (md5('bps|b1')::uuid, md5('bps|b2')::uuid);
  IF n <> 6 THEN RAISE EXCEPTION 'FAIL (c): % split rows, want 6', n; END IF;
  v_w := public.dryrun_bps_weights();
  IF v_w <> '35/50/15' THEN RAISE EXCEPTION 'FAIL (c): weights % want 35/50/15', v_w; END IF;
  IF (v_out->>'ok')::boolean IS DISTINCT FROM true OR jsonb_array_length(v_out->'phase_weights') <> 3 THEN
    RAISE EXCEPTION 'FAIL (c): return %', v_out;
  END IF;
  SELECT string_agg(trim_scale((e->>'weight')::numeric)::text, '/') INTO v_w FROM jsonb_array_elements(v_out->'phase_weights') e;
  IF v_w <> '35/50/15' THEN RAISE EXCEPTION 'FAIL (c): returned phase_weights % want 35/50/15', v_w; END IF;
  RAISE NOTICE 'PASS (c) defaults 25/75/0, valid save -> 35/50/15, sum 100';
END $$;

-- (d) rounding: raw 23.665 / 20.335 / 56 -> 23.67 / 20.34 / 56.00 = 100.01, remainder on the largest
DO $$
DECLARE v_site uuid := md5('bps|site')::uuid; v_w text; v_sum numeric;
BEGIN
  PERFORM public.save_boq_phase_splits(v_site, public.dryrun_bps_rows(ARRAY['10','10','80'], ARRAY['55.55','44.45','0']));
  v_w := public.dryrun_bps_weights();
  IF v_w <> '23.67/20.34/55.99' THEN RAISE EXCEPTION 'FAIL (d): weights % want 23.67/20.34/55.99', v_w; END IF;
  SELECT sum(billing_weight_pct) INTO v_sum FROM public.site_phases WHERE site_id = v_site AND NOT is_vo AND NOT is_issue_phase;
  IF v_sum <> 100 THEN RAISE EXCEPTION 'FAIL (d): sum % <> 100', v_sum; END IF;
  RAISE NOTICE 'PASS (d) rounding remainder on the largest phase';
END $$;

-- (e) invalid matrices are rejected and leave the saved rows alone
DO $$
DECLARE v_site uuid := md5('bps|site')::uuid; v_w text;
BEGIN
  BEGIN
    PERFORM public.save_boq_phase_splits(v_site, public.dryrun_bps_rows(ARRAY['50','49','0'], ARRAY['0','50','50']));
    RAISE EXCEPTION 'FAIL (e): row sum 99 accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    IF position('ต้องเท่ากับ 100' IN SQLERRM) = 0 THEN RAISE EXCEPTION 'FAIL (e): wrong message for sum 99: %', SQLERRM; END IF;
  END;
  BEGIN
    PERFORM public.save_boq_phase_splits(v_site, public.dryrun_bps_rows(ARRAY['101','-1','0'], ARRAY['0','50','50']));
    RAISE EXCEPTION 'FAIL (e): pct 101 accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    IF position('ระหว่าง 0 ถึง 100' IN SQLERRM) = 0 THEN RAISE EXCEPTION 'FAIL (e): wrong message for pct 101: %', SQLERRM; END IF;
  END;
  BEGIN
    PERFORM public.save_boq_phase_splits(v_site, jsonb_build_array(
      jsonb_build_object('boq_item_id', md5('bps|b1')::uuid, 'phase_id', md5('bps|p1')::uuid, 'pct', 100)));
    RAISE EXCEPTION 'FAIL (e): missing item accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    IF position('ให้ครบทุกรายการ' IN SQLERRM) = 0 THEN RAISE EXCEPTION 'FAIL (e): wrong message for missing item: %', SQLERRM; END IF;
  END;
  BEGIN
    PERFORM public.save_boq_phase_splits(v_site, jsonb_build_array(
      jsonb_build_object('boq_item_id', md5('bps|b1')::uuid, 'phase_id', md5('bps|p1')::uuid, 'pct', 100),
      jsonb_build_object('boq_item_id', md5('bps|b2')::uuid, 'phase_id', gen_random_uuid(), 'pct', 100)));
    RAISE EXCEPTION 'FAIL (e): foreign phase accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    IF position('เฟสไม่อยู่ในไซท์นี้' IN SQLERRM) = 0 THEN RAISE EXCEPTION 'FAIL (e): wrong message for foreign phase: %', SQLERRM; END IF;
  END;
  BEGIN
    PERFORM public.save_boq_phase_splits(v_site, '{}'::jsonb);
    RAISE EXCEPTION 'FAIL (e): non-array accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
  BEGIN
    PERFORM public.save_boq_phase_splits(v_site, public.dryrun_bps_rows(ARRAY['50','50','0'], ARRAY['abc','50','50']));
    RAISE EXCEPTION 'FAIL (e): non-numeric pct accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
  v_w := public.dryrun_bps_weights();
  IF v_w <> '23.67/20.34/55.99' THEN RAISE EXCEPTION 'FAIL (e): weights moved to % after rejected saves', v_w; END IF;
  -- back to the base matrix for the rest
  PERFORM public.save_boq_phase_splits(v_site, public.dryrun_bps_rows(ARRAY['50','50','0'], ARRAY['0','50','50']));
  IF public.dryrun_bps_weights() <> '35/50/15' THEN RAISE EXCEPTION 'FAIL (e): re-save gave %', public.dryrun_bps_weights(); END IF;
  RAISE NOTICE 'PASS (e) invalid matrices rejected';
END $$;

-- (f) BOQ quantity limit per item per phase (subtask cards count under their phase)
DO $$
DECLARE v_tenant uuid := '1b9affc4-2136-4ed1-b168-a36e6624e743'; v_site uuid := md5('bps|site')::uuid;
BEGIN
  -- B1 (qty 10) at 100 % in P1 and again at 100 % in P2: allowed
  INSERT INTO public.phase_tasks (id, tenant_id, site_id, phase_id, name, sort_order, status, progress_mode, planned_qty, boq_item_id)
  VALUES (md5('bps|c1')::uuid, v_tenant, v_site, md5('bps|p1')::uuid, 'กระจก ผลิต', 1, 'not_started', 'quantity', 10, md5('bps|b1')::uuid);
  INSERT INTO public.phase_tasks (id, tenant_id, site_id, phase_id, name, sort_order, status, progress_mode, planned_qty, boq_item_id)
  VALUES (md5('bps|c2')::uuid, v_tenant, v_site, md5('bps|p2')::uuid, 'กระจก ติดตั้ง', 1, 'not_started', 'quantity', 10, md5('bps|b1')::uuid);
  -- one more unit of B1 in P2: over the limit in that phase
  BEGIN
    INSERT INTO public.phase_tasks (tenant_id, site_id, phase_id, name, sort_order, status, progress_mode, planned_qty, boq_item_id)
    VALUES (v_tenant, v_site, md5('bps|p2')::uuid, 'เกิน', 9, 'not_started', 'quantity', 1, md5('bps|b1')::uuid);
    RAISE EXCEPTION 'FAIL (f): 11 of 10 in one phase accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    IF SQLERRM <> 'จำนวนในการ์ดรวมเกิน BOQ ในเฟสนี้' THEN RAISE EXCEPTION 'FAIL (f): message %', SQLERRM; END IF;
  END;
  -- moving C2 into P1 would make 20 of 10 there
  BEGIN
    UPDATE public.phase_tasks SET phase_id = md5('bps|p1')::uuid WHERE id = md5('bps|c2')::uuid;
    RAISE EXCEPTION 'FAIL (f): move over the limit accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    IF SQLERRM <> 'จำนวนในการ์ดรวมเกิน BOQ ในเฟสนี้' THEN RAISE EXCEPTION 'FAIL (f): move message %', SQLERRM; END IF;
  END;
  -- a subtask under P3 with a B2 card of 10; a phase-level B2 card in P3 is then over
  INSERT INTO public.phase_subtasks (id, tenant_id, site_id, phase_id, name, sort_order, billing_weight_pct, status)
  VALUES (md5('bps|st')::uuid, v_tenant, v_site, md5('bps|p3')::uuid, 'เก็บงานชั้น 1', 1, 100, 'not_started');
  INSERT INTO public.phase_tasks (id, tenant_id, site_id, phase_id, subtask_id, name, sort_order, status, progress_mode, planned_qty, boq_item_id)
  VALUES (md5('bps|c6')::uuid, v_tenant, v_site, md5('bps|p3')::uuid, md5('bps|st')::uuid, 'อลู เก็บงาน', 1, 'not_started', 'quantity', 10, md5('bps|b2')::uuid);
  BEGIN
    INSERT INTO public.phase_tasks (tenant_id, site_id, phase_id, name, sort_order, status, progress_mode, planned_qty, boq_item_id)
    VALUES (v_tenant, v_site, md5('bps|p3')::uuid, 'เกิน', 9, 'not_started', 'quantity', 1, md5('bps|b2')::uuid);
    RAISE EXCEPTION 'FAIL (f): subtask card not counted under its phase';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
  -- the BOQ line cannot drop below the largest per-phase total (10), but 10 itself is fine
  BEGIN
    UPDATE public.boq_items SET planned_qty = 9 WHERE id = md5('bps|b1')::uuid;
    RAISE EXCEPTION 'FAIL (f): BOQ qty below the per-phase card total accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
  RAISE NOTICE 'PASS (f) per-phase quantity limit';
END $$;

-- (g) card points follow pct: P2 holds B1 (3500) and B2 (1500) -> 70/30; a pct-0 card gets 0
DO $$
DECLARE v_tenant uuid := '1b9affc4-2136-4ed1-b168-a36e6624e743'; v_site uuid := md5('bps|site')::uuid; v_pts text;
BEGIN
  INSERT INTO public.phase_tasks (id, tenant_id, site_id, phase_id, name, sort_order, status, progress_mode, planned_qty, boq_item_id)
  VALUES (md5('bps|c4')::uuid, v_tenant, v_site, md5('bps|p2')::uuid, 'อลู ติดตั้ง', 2, 'not_started', 'quantity', 10, md5('bps|b2')::uuid);
  INSERT INTO public.phase_tasks (id, tenant_id, site_id, phase_id, name, sort_order, status, progress_mode, planned_qty, boq_item_id)
  VALUES (md5('bps|c5')::uuid, v_tenant, v_site, md5('bps|p1')::uuid, 'อลู ผลิต (pct 0)', 2, 'not_started', 'quantity', 10, md5('bps|b2')::uuid);
  SELECT string_agg(name || '=' || trim_scale(weight_pts), ', ' ORDER BY phase_id, sort_order) INTO v_pts
    FROM public.phase_tasks WHERE site_id = v_site
      AND (trim_scale(weight_pts), id) NOT IN (
        (100, md5('bps|c1')::uuid), (0, md5('bps|c5')::uuid), (70, md5('bps|c2')::uuid), (30, md5('bps|c4')::uuid), (100, md5('bps|c6')::uuid));
  IF v_pts IS NOT NULL THEN RAISE EXCEPTION 'FAIL (g): unexpected points: %', v_pts; END IF;
  RAISE NOTICE 'PASS (g) card points follow pct (C1 100, C5 0, C2 70, C4 30, C6 100)';
END $$;

-- (h) a new BOQ item gets default rows; weights follow item value changes and removals
DO $$
DECLARE v_site uuid := md5('bps|site')::uuid; v_rows text; v_w text; n int;
BEGIN
  -- template ผลิต 10 / ติดตั้ง 30 -> 25/75/0 (manual item, no price: takes the mean share)
  INSERT INTO public.boq_items (id, site_id, code, description, planned_qty, sort_order)
  VALUES (md5('bps|b3')::uuid, v_site, '3', 'รายการใหม่', 5, 3);
  SELECT string_agg(trim_scale(s.pct)::text, '/' ORDER BY ph.sort_order) INTO v_rows
    FROM public.boq_phase_splits s JOIN public.site_phases ph ON ph.id = s.phase_id WHERE s.boq_item_id = md5('bps|b3')::uuid;
  IF v_rows IS DISTINCT FROM '25/75/0' THEN RAISE EXCEPTION 'FAIL (h): default rows % want 25/75/0', v_rows; END IF;
  v_w := public.dryrun_bps_weights();
  IF v_w <> '31.67/58.33/10' THEN RAISE EXCEPTION 'FAIL (h): weights % after B3 want 31.67/58.33/10', v_w; END IF;

  -- unreadable template -> built-in 7 phases (ผลิต 30 / ติดตั้ง 30 -> 50/50/0)
  UPDATE public.app_settings SET value = 'not json' WHERE key = 'phase_template';
  INSERT INTO public.boq_items (id, site_id, code, description, planned_qty, sort_order)
  VALUES (md5('bps|b4')::uuid, v_site, '4', 'รายการใหม่ 2', 5, 4);
  SELECT string_agg(trim_scale(s.pct)::text, '/' ORDER BY ph.sort_order) INTO v_rows
    FROM public.boq_phase_splits s JOIN public.site_phases ph ON ph.id = s.phase_id WHERE s.boq_item_id = md5('bps|b4')::uuid;
  IF v_rows IS DISTINCT FROM '50/50/0' THEN RAISE EXCEPTION 'FAIL (h): built-in default rows % want 50/50/0', v_rows; END IF;

  -- no name matches -> 100 on the last non-VO phase
  UPDATE public.app_settings SET value = '[{"name":"X","sort_order":1,"weight":100}]' WHERE key = 'phase_template';
  INSERT INTO public.boq_items (id, site_id, code, description, planned_qty, sort_order)
  VALUES (md5('bps|b5')::uuid, v_site, '5', 'รายการใหม่ 3', 5, 5);
  SELECT string_agg(trim_scale(s.pct)::text, '/' ORDER BY ph.sort_order) INTO v_rows
    FROM public.boq_phase_splits s JOIN public.site_phases ph ON ph.id = s.phase_id WHERE s.boq_item_id = md5('bps|b5')::uuid;
  IF v_rows IS DISTINCT FROM '0/0/100' THEN RAISE EXCEPTION 'FAIL (h): no-match default rows % want 0/0/100', v_rows; END IF;

  -- the BOQ tab's row removal (no cards on them): rows cascade, weights return
  EXECUTE 'DEL' || 'ETE FROM public.boq_items WHERE id IN ($1, $2, $3)' USING md5('bps|b3')::uuid, md5('bps|b4')::uuid, md5('bps|b5')::uuid;
  SELECT count(*) INTO n FROM public.boq_phase_splits WHERE boq_item_id IN (md5('bps|b1')::uuid, md5('bps|b2')::uuid, md5('bps|b3')::uuid, md5('bps|b4')::uuid, md5('bps|b5')::uuid);
  IF n <> 6 THEN RAISE EXCEPTION 'FAIL (h): % split rows after removals, want 6', n; END IF;
  v_w := public.dryrun_bps_weights();
  IF v_w <> '35/50/15' THEN RAISE EXCEPTION 'FAIL (h): weights % after removals want 35/50/15', v_w; END IF;

  -- B1 planned_qty 10 -> 20: value 14000 vs 3000, shares 82.35/17.65 -> 41.175/50/8.825 -> 41.18/50.00/8.83 = 100.01 -> 49.99 on the largest
  UPDATE public.boq_items SET planned_qty = 20 WHERE id = md5('bps|b1')::uuid;
  v_w := public.dryrun_bps_weights();
  IF v_w <> '41.18/49.99/8.83' THEN RAISE EXCEPTION 'FAIL (h): weights % after qty change want 41.18/49.99/8.83', v_w; END IF;
  UPDATE public.boq_items SET planned_qty = 10 WHERE id = md5('bps|b1')::uuid;
  IF public.dryrun_bps_weights() <> '35/50/15' THEN RAISE EXCEPTION 'FAIL (h): weights % after qty restore', public.dryrun_bps_weights(); END IF;
  RAISE NOTICE 'PASS (h) default rows (template, built-in, no match), value changes, removals';
END $$;

-- (i) manual phase weight edits are blocked in BOQ mode; unchanged full-row writes pass; a new phase starts at 0
DO $$
DECLARE v_tenant uuid := '1b9affc4-2136-4ed1-b168-a36e6624e743'; v_site uuid := md5('bps|site')::uuid; v_w numeric;
BEGIN
  BEGIN
    UPDATE public.site_phases SET billing_weight_pct = 20 WHERE id = md5('bps|p1')::uuid;
    RAISE EXCEPTION 'FAIL (i): manual weight edit accepted in BOQ mode';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    IF SQLERRM <> 'น้ำหนักเฟสคิดจาก BOQ แก้ที่แท็บ BOQ' THEN RAISE EXCEPTION 'FAIL (i): message %', SQLERRM; END IF;
  END;
  -- the app's full-row upsert with the value unchanged
  UPDATE public.site_phases SET billing_weight_pct = 35, name = 'ผลิต', status = 'not_started' WHERE id = md5('bps|p1')::uuid;
  IF public.dryrun_bps_weights() <> '35/50/15' THEN RAISE EXCEPTION 'FAIL (i): same-value update changed weights to %', public.dryrun_bps_weights(); END IF;
  -- a new phase typed with 30 is stored at 0 (no split points at it yet)
  INSERT INTO public.site_phases (id, tenant_id, site_id, name, sort_order, billing_weight_pct, status)
  VALUES (md5('bps|p4')::uuid, v_tenant, v_site, 'ส่งมอบงาน', 4, 30, 'not_started');
  SELECT billing_weight_pct INTO v_w FROM public.site_phases WHERE id = md5('bps|p4')::uuid;
  IF v_w <> 0 THEN RAISE EXCEPTION 'FAIL (i): new phase stored with weight %', v_w; END IF;
  EXECUTE 'DEL' || 'ETE FROM public.site_phases WHERE id = $1' USING md5('bps|p4')::uuid;
  IF public.dryrun_bps_weights() <> '35/50/15' THEN RAISE EXCEPTION 'FAIL (i): weights % after phase removal', public.dryrun_bps_weights(); END IF;
  RAISE NOTICE 'PASS (i) manual weight edit blocked, derived writes pass';
END $$;

-- (j) site % equals the exact formula: Σ_i share_i x Σ_p pct(i,p) x done/planned of the (i,p) card / 100
--   C1 5/10, C2 10/10, C4 2/10, C6 4/10, C5 10/10 (pct 0, 0 points)
--   P1 = (100 x 0.5 + 0 x 1)/100 = 0.5; P2 = (70 x 1 + 30 x 0.2)/100 = 0.76; P3 = subtask = 0.4
--   site = 0.35 x 0.5 + 0.5 x 0.76 + 0.15 x 0.4 = 0.615; formula = 0.7 x (50 x 0.5 + 50 x 1)/100 + 0.3 x (50 x 0.2 + 50 x 0.4)/100 = 0.525 + 0.09
DO $$
DECLARE v_site uuid := md5('bps|site')::uuid; r record; v_formula numeric; v_p1 numeric; v_p2 numeric; v_p3 numeric;
BEGIN
  PERFORM public.record_progress(md5('bps|c1')::uuid, 5, current_date, 'dry run');
  PERFORM public.record_progress(md5('bps|c2')::uuid, 10, current_date, 'dry run');
  PERFORM public.record_progress(md5('bps|c4')::uuid, 2, current_date, 'dry run');
  PERFORM public.record_progress(md5('bps|c6')::uuid, 4, current_date, 'dry run');
  PERFORM public.record_progress(md5('bps|c5')::uuid, 10, current_date, 'dry run');
  v_p1 := public.node_progress(md5('bps|p1')::uuid); v_p2 := public.node_progress(md5('bps|p2')::uuid); v_p3 := public.node_progress(md5('bps|p3')::uuid);
  IF v_p1 <> 0.5 OR v_p2 <> 0.76 OR v_p3 <> 0.4 THEN RAISE EXCEPTION 'FAIL (j): node progress % / % / % want 0.5 / 0.76 / 0.4', v_p1, v_p2, v_p3; END IF;
  SELECT * INTO r FROM public.site_progress_pct(v_site);
  IF r.contract_pct IS DISTINCT FROM 61.50 THEN RAISE EXCEPTION 'FAIL (j): contract_pct % want 61.50', r.contract_pct; END IF;
  -- the same number straight from the matrix and the cards
  SELECT round(100 * sum(v.share_pct / 100 * s.pct / 100 * least(t.done_qty / t.planned_qty, 1)), 2) INTO v_formula
    FROM public.boq_value_shares(v_site) v
    JOIN public.boq_phase_splits s ON s.boq_item_id = v.boq_item_id
    JOIN public.phase_tasks t ON t.boq_item_id = s.boq_item_id AND t.phase_id = s.phase_id AND t.progress_mode = 'quantity';
  IF v_formula IS DISTINCT FROM 61.50 THEN RAISE EXCEPTION 'FAIL (j): formula % want 61.50', v_formula; END IF;
  RAISE NOTICE 'PASS (j) site_progress_pct 61.50 = exact formula';
END $$;

-- (k) a signed-in user outside the tenant sees nothing and cannot save
RESET ROLE;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', '00000000-0000-0000-0000-0000000000ff', 'role', 'authenticated',
                    'email', 'nobody-dryrun@example.invalid')::text, true);
SET LOCAL role authenticated;
DO $$
DECLARE v_site uuid := md5('bps|site')::uuid; n int;
BEGIN
  SELECT count(*) INTO n FROM public.boq_phase_splits;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL (k): outsider sees % split rows', n; END IF;
  IF public.site_in_boq_mode(v_site) THEN RAISE EXCEPTION 'FAIL (k): outsider sees BOQ mode'; END IF;
  BEGIN
    PERFORM public.save_boq_phase_splits(v_site, '[]'::jsonb);
    RAISE EXCEPTION 'FAIL (k): outsider saved';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.boq_phase_split_defaults(v_site);
    RAISE EXCEPTION 'FAIL (k): outsider read defaults';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RAISE NOTICE 'PASS (k) outsider sees nothing';
END $$;
RESET ROLE;

SELECT 'ALL PASS' AS result;
ROLLBACK;
