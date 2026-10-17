-- Rolled-back check for supabase/migrations/2026-10-17-09-gantt-progress-data.sql.
-- Run: npx supabase db query --linked -f supabase/tests/2026-10-17-09-gantt-progress-data.test.sql
-- 04/05/06 are already applied live. The 07, 08 and 09 bodies are inlined below,
-- byte-identical to their files between BEGIN; and COMMIT;. Keep them in sync.
-- Before the 09 body, today's count-based % per phase and a card/phase fingerprint are
-- kept in temp tables, so the DO block can report every phase whose % changes under the
-- card-kinds rules (RESULT keys phases_changed and pct_change_report) for the owner.
-- The fixture block in the DO is the output of: node scripts/gen-progress-fixture-sql.mjs
-- The DO block ends in RAISE EXCEPTION 'RESULT ...', so nothing persists.
-- Expected: *_MUST<value> holds that value; *_MUST22023 / 42501 is that SQLSTATE
-- (with the message); *_MUSTok is 'ok'; *_MUSTnull is null.
BEGIN;
-- ===== inlined 2026-10-17-07-gantt-progress-schema.sql body =====

CREATE OR REPLACE FUNCTION public.can_manage_plan() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT COALESCE(current_user_role() IN ('OWNER','PM'), false) $$;
REVOKE ALL ON FUNCTION public.can_manage_plan() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_manage_plan() TO authenticated;

CREATE TABLE public.boq_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT current_tenant_id(),
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  quotation_item_id uuid NULL REFERENCES quotation_items(id) ON DELETE SET NULL,
  code text NOT NULL,
  description text NOT NULL,
  unit text,
  planned_qty numeric NOT NULL CHECK (planned_qty > 0),
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id, quotation_item_id)
);
CREATE INDEX boq_items_site_idx ON boq_items(site_id);
-- quotation price changes look up the BOQ lines of one quotation item (migration 08)
CREATE INDEX boq_items_quotation_item_idx ON boq_items(quotation_item_id) WHERE quotation_item_id IS NOT NULL;

ALTER TABLE phase_tasks
  ADD COLUMN weight_pts numeric(6,2) NOT NULL DEFAULT 0 CHECK (weight_pts >= 0),
  ADD COLUMN progress_mode text NOT NULL DEFAULT 'status' CHECK (progress_mode IN ('status','quantity')),
  ADD COLUMN parent_task_id uuid NULL REFERENCES phase_tasks(id) ON DELETE CASCADE,
  ADD COLUMN boq_item_id uuid NULL REFERENCES boq_items(id) ON DELETE RESTRICT,
  ADD COLUMN planned_qty numeric NULL CHECK (planned_qty IS NULL OR planned_qty > 0),
  ADD COLUMN done_qty numeric NOT NULL DEFAULT 0,
  ADD CONSTRAINT phase_tasks_boq_card_needs_line
    CHECK (progress_mode = 'status' OR (boq_item_id IS NOT NULL AND planned_qty IS NOT NULL)),
  -- and a general card holds neither (migration 08 clears them; this is the backstop), so it
  -- never uses up BOQ quantity or blocks deleting a BOQ line
  ADD CONSTRAINT phase_tasks_general_card_no_line
    CHECK (progress_mode = 'quantity' OR (boq_item_id IS NULL AND planned_qty IS NULL));
CREATE INDEX phase_tasks_parent_idx ON phase_tasks(parent_task_id) WHERE parent_task_id IS NOT NULL;
CREATE INDEX phase_tasks_boq_item_idx ON phase_tasks(boq_item_id) WHERE boq_item_id IS NOT NULL;

ALTER TABLE site_phases
  ADD COLUMN is_vo boolean NOT NULL DEFAULT false,
  ADD COLUMN vo_ref text NULL;
-- A VO's baht value is money: kept out of site_phases (which PM reads) and readable
-- only by OWNER/ADMIN, so PM cannot work out contract_value from % รวม VO.
CREATE TABLE public.phase_vo_values (
  phase_id uuid PRIMARY KEY REFERENCES site_phases(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL DEFAULT current_tenant_id(),
  vo_value numeric NOT NULL CHECK (vo_value >= 0)
);

CREATE TABLE public.progress_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT current_tenant_id(),
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES phase_tasks(id) ON DELETE CASCADE,
  qty numeric NOT NULL CHECK (qty > 0),
  work_date date NOT NULL DEFAULT current_date,
  note text,
  source text NOT NULL DEFAULT 'web' CHECK (source IN ('web')),
  cancelled_at timestamptz,
  cancelled_by text,
  created_by text DEFAULT auth.email(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX progress_reports_task_idx ON progress_reports(task_id);

CREATE TABLE public.site_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT current_tenant_id(),
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  version int NOT NULL,
  note text NOT NULL,
  is_auto boolean NOT NULL DEFAULT false,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id, version)
);
CREATE TABLE public.site_plan_items (
  plan_id uuid NOT NULL REFERENCES site_plans(id) ON DELETE CASCADE,
  level text NOT NULL CHECK (level IN ('phase','subtask','task')),
  ref_id uuid NOT NULL,
  parent_ref_id uuid,
  name text NOT NULL,
  start_date date,
  end_date date,
  weight numeric,
  planned_qty numeric,
  is_vo boolean NOT NULL DEFAULT false,
  PRIMARY KEY (plan_id, level, ref_id)
);

ALTER TABLE boq_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE progress_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_plan_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE phase_vo_values ENABLE ROW LEVEL SECURITY;

-- boq_items: site staff read/write within tenant
CREATE POLICY site_staff_all ON boq_items FOR ALL
  USING (( SELECT is_site_staff() ) AND tenant_id = ( SELECT current_tenant_id() ))
  WITH CHECK (( SELECT is_site_staff() ) AND tenant_id = ( SELECT current_tenant_id() ) AND ( SELECT tenant_can_write() ));
-- phase_vo_values: money, OWNER/ADMIN only (PM never reads money)
CREATE POLICY money_roles_all ON phase_vo_values FOR ALL
  USING (( SELECT is_admin_or_owner() ) AND tenant_id = ( SELECT current_tenant_id() ))
  WITH CHECK (( SELECT is_admin_or_owner() ) AND tenant_id = ( SELECT current_tenant_id() ) AND ( SELECT tenant_can_write() ));
-- progress_reports: site staff read; OWNER/PM insert and cancel (update), never delete
CREATE POLICY site_staff_reads ON progress_reports FOR SELECT
  USING (( SELECT is_site_staff() ) AND tenant_id = ( SELECT current_tenant_id() ));
CREATE POLICY plan_managers_insert ON progress_reports FOR INSERT
  WITH CHECK (( SELECT can_manage_plan() ) AND tenant_id = ( SELECT current_tenant_id() ) AND ( SELECT tenant_can_write() ));
CREATE POLICY plan_managers_cancel ON progress_reports FOR UPDATE
  USING (( SELECT can_manage_plan() ) AND tenant_id = ( SELECT current_tenant_id() ) AND cancelled_at IS NULL)
  WITH CHECK (( SELECT can_manage_plan() ) AND tenant_id = ( SELECT current_tenant_id() ) AND cancelled_at IS NOT NULL);
-- site_plans / items: read only; rows are created by SECURITY DEFINER RPC (Task 2)
CREATE POLICY site_staff_reads ON site_plans FOR SELECT
  USING (( SELECT is_site_staff() ) AND tenant_id = ( SELECT current_tenant_id() ));
-- reads site_plans (a different table), so it does not recurse
CREATE POLICY site_staff_reads ON site_plan_items FOR SELECT
  USING (EXISTS (SELECT 1 FROM site_plans p WHERE p.id = site_plan_items.plan_id
                 AND p.tenant_id = ( SELECT current_tenant_id() )) AND ( SELECT is_site_staff() ));
REVOKE INSERT, UPDATE, DELETE ON site_plans, site_plan_items FROM authenticated, anon;
REVOKE DELETE ON progress_reports FROM authenticated, anon;
REVOKE TRUNCATE ON phase_vo_values FROM authenticated, anon;

-- a BOQ line with cards cannot be deleted: say why before the FK does (deleting the whole
-- site still cascades, the site row is already gone by then)
CREATE OR REPLACE FUNCTION public.block_boq_delete_with_cards() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM phase_tasks WHERE boq_item_id = OLD.id AND tenant_id = OLD.tenant_id)
     AND EXISTS (SELECT 1 FROM sites WHERE id = OLD.site_id) THEN
    RAISE EXCEPTION 'รายการ BOQ นี้มีการ์ดผูกอยู่ ย้ายหรือลบการ์ดก่อน' USING ERRCODE = '22023';
  END IF;
  RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION public.block_boq_delete_with_cards() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER trg_block_boq_delete_with_cards BEFORE DELETE ON boq_items
  FOR EACH ROW EXECUTE FUNCTION block_boq_delete_with_cards();
-- ===== inlined 2026-10-17-08-gantt-progress-logic.sql body =====

-- ===== helpers =====
CREATE OR REPLACE FUNCTION public.site_has_plan(p_site_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT EXISTS (SELECT 1 FROM site_plans WHERE site_id = p_site_id) $$;
REVOKE ALL ON FUNCTION public.site_has_plan(uuid) FROM PUBLIC, anon, authenticated;

-- 1. snapshot: internal, granted to no one
CREATE OR REPLACE FUNCTION public.snapshot_site_plan(p_site_id uuid, p_note text, p_is_auto boolean, p_by text)
  RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_tenant uuid; v_version int; v_plan uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_site_id::text));
  SELECT tenant_id INTO v_tenant FROM sites WHERE id = p_site_id;
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'ไม่พบไซท์' USING ERRCODE = 'P0002'; END IF;
  SELECT COALESCE(max(version), 0) + 1 INTO v_version FROM site_plans WHERE site_id = p_site_id;
  INSERT INTO site_plans (tenant_id, site_id, version, note, is_auto, created_by)
    VALUES (v_tenant, p_site_id, v_version, p_note, p_is_auto, p_by) RETURNING id INTO v_plan;

  INSERT INTO site_plan_items (plan_id, level, ref_id, parent_ref_id, name, start_date, end_date, weight, is_vo)
  SELECT v_plan, 'phase', ph.id, NULL, ph.name, ph.start_date, ph.end_date, ph.billing_weight_pct, ph.is_vo
    FROM site_phases ph
   WHERE ph.site_id = p_site_id AND ph.tenant_id = v_tenant AND NOT ph.is_issue_phase;

  INSERT INTO site_plan_items (plan_id, level, ref_id, parent_ref_id, name, start_date, end_date, weight)
  SELECT v_plan, 'subtask', s.id, COALESCE(s.parent_subtask_id, s.phase_id), s.name, s.start_date, s.end_date, s.billing_weight_pct
    FROM phase_subtasks s JOIN site_phases ph ON ph.id = s.phase_id
   WHERE s.site_id = p_site_id AND s.tenant_id = v_tenant AND NOT ph.is_issue_phase;

  INSERT INTO site_plan_items (plan_id, level, ref_id, parent_ref_id, name, start_date, end_date, weight, planned_qty)
  SELECT v_plan, 'task', t.id, COALESCE(t.parent_task_id, t.subtask_id, t.phase_id), t.name, NULL, t.due_date, t.weight_pts, t.planned_qty
    FROM phase_tasks t JOIN site_phases ph ON ph.id = t.phase_id
   WHERE t.site_id = p_site_id AND t.tenant_id = v_tenant AND t.issue_report_id IS NULL AND NOT ph.is_issue_phase;

  RETURN v_version;
END $$;
REVOKE ALL ON FUNCTION public.snapshot_site_plan(uuid, text, boolean, text) FROM PUBLIC, anon, authenticated;

-- 2. save a PLAN version (OWNER/PM)
CREATE OR REPLACE FUNCTION public.save_site_plan(p_site_id uuid, p_note text)
  RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_name text; v_sum numeric;
BEGIN
  IF NOT can_manage_plan() OR NOT tenant_can_write() THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์บันทึก PLAN' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM sites WHERE id = p_site_id AND tenant_id = current_tenant_id()) THEN
    RAISE EXCEPTION 'ไม่พบไซท์' USING ERRCODE = 'P0002';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM site_phases WHERE site_id = p_site_id AND NOT is_vo AND NOT is_issue_phase) THEN
    RAISE EXCEPTION 'ยังไม่มีเฟส' USING ERRCODE = '22023';
  END IF;
  SELECT name INTO v_name FROM site_phases
   WHERE site_id = p_site_id AND NOT is_vo AND NOT is_issue_phase AND (start_date IS NULL OR end_date IS NULL)
   ORDER BY sort_order, created_at LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'เฟส % ยังไม่มีวันเริ่ม/วันจบ', v_name USING ERRCODE = '22023';
  END IF;
  SELECT COALESCE(sum(billing_weight_pct), 0) INTO v_sum FROM site_phases
   WHERE site_id = p_site_id AND NOT is_vo AND NOT is_issue_phase;
  IF abs(v_sum - 100) > 0.01 THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'น้ำหนักเฟสรวม ' || trim_scale(round(v_sum, 2)) || '% ต้องเท่ากับ 100%';
  END IF;
  IF btrim(COALESCE(p_note, '')) = '' THEN
    RAISE EXCEPTION 'ต้องใส่เหตุผล' USING ERRCODE = '22023';
  END IF;
  RETURN snapshot_site_plan(p_site_id, p_note, false, auth.email());
END $$;
REVOKE ALL ON FUNCTION public.save_site_plan(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_site_plan(uuid, text) TO authenticated;

-- 3. PLAN gate: no progress before PLAN v1 (issue phases/cards exempt).
-- Status changes and inserts already in_progress/done are both gated. Derived writes
-- (app.derived_status = '1': quantity sync, parent sync, split, demo seed) pass.
CREATE OR REPLACE FUNCTION public.require_site_plan() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF current_setting('app.derived_status', true) = '1' THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME = 'phase_tasks' THEN
    IF NEW.issue_report_id IS NOT NULL OR NEW.status NOT IN ('in_progress', 'done')
       OR EXISTS (SELECT 1 FROM site_phases WHERE id = NEW.phase_id AND is_issue_phase) THEN
      RETURN NEW;
    END IF;
  ELSIF TG_TABLE_NAME = 'site_phases' THEN
    IF NEW.is_issue_phase THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME = 'phase_subtasks' THEN
    IF EXISTS (SELECT 1 FROM site_phases WHERE id = NEW.phase_id AND is_issue_phase) THEN RETURN NEW; END IF;
  END IF;
  -- progress_reports: always gated (site_id was set from the card by trg_a_progress_report_refs)
  IF NOT site_has_plan(NEW.site_id) THEN
    RAISE EXCEPTION 'บันทึก PLAN v1 ของไซท์นี้ก่อนเริ่มบันทึกความคืบหน้า' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.require_site_plan() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER trg_require_site_plan BEFORE UPDATE OF status ON phase_tasks
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION require_site_plan();
CREATE TRIGGER trg_require_site_plan BEFORE UPDATE OF status ON site_phases
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION require_site_plan();
CREATE TRIGGER trg_require_site_plan BEFORE UPDATE OF status ON phase_subtasks
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION require_site_plan();
CREATE TRIGGER trg_require_site_plan_ins BEFORE INSERT ON phase_tasks
  FOR EACH ROW WHEN (NEW.status IN ('in_progress', 'done')) EXECUTE FUNCTION require_site_plan();
CREATE TRIGGER trg_require_site_plan_ins BEFORE INSERT ON site_phases
  FOR EACH ROW WHEN (NEW.status IN ('in_progress', 'done')) EXECUTE FUNCTION require_site_plan();
CREATE TRIGGER trg_require_site_plan_ins BEFORE INSERT ON phase_subtasks
  FOR EACH ROW WHEN (NEW.status IN ('in_progress', 'done')) EXECUTE FUNCTION require_site_plan();
CREATE TRIGGER trg_b_require_site_plan BEFORE INSERT ON progress_reports
  FOR EACH ROW EXECUTE FUNCTION require_site_plan();

-- cross-tenant references (controller ruling): boq_items.site_id / quotation_item_id
CREATE OR REPLACE FUNCTION public.check_boq_item_refs() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM sites WHERE id = NEW.site_id AND tenant_id = NEW.tenant_id) THEN
    RAISE EXCEPTION 'ไซท์ไม่อยู่ในบริษัทนี้' USING ERRCODE = '42501';
  END IF;
  IF NEW.quotation_item_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM quotation_items WHERE id = NEW.quotation_item_id AND tenant_id = NEW.tenant_id) THEN
    RAISE EXCEPTION 'รายการใบเสนอราคาไม่อยู่ในบริษัทนี้' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.check_boq_item_refs() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER trg_check_boq_item_refs BEFORE INSERT OR UPDATE ON boq_items
  FOR EACH ROW EXECUTE FUNCTION check_boq_item_refs();

-- cross-tenant references: phase_tasks.boq_item_id (same tenant + site), parent_task_id (same tenant + site)
CREATE OR REPLACE FUNCTION public.check_task_refs() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NEW.boq_item_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM boq_items WHERE id = NEW.boq_item_id AND tenant_id = NEW.tenant_id AND site_id = NEW.site_id) THEN
    RAISE EXCEPTION 'รายการ BOQ ไม่อยู่ในไซท์นี้' USING ERRCODE = '42501';
  END IF;
  IF NEW.parent_task_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM phase_tasks WHERE id = NEW.parent_task_id AND tenant_id = NEW.tenant_id AND site_id = NEW.site_id) THEN
    RAISE EXCEPTION 'งานหลักไม่อยู่ในไซท์นี้' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.check_task_refs() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER trg_check_task_refs BEFORE INSERT OR UPDATE OF boq_item_id, parent_task_id, site_id, tenant_id ON phase_tasks
  FOR EACH ROW EXECUTE FUNCTION check_task_refs();

-- cross-tenant references: phase_vo_values.phase_id must be a phase of the row's tenant
CREATE OR REPLACE FUNCTION public.check_phase_vo_refs() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM site_phases WHERE id = NEW.phase_id AND tenant_id = NEW.tenant_id) THEN
    RAISE EXCEPTION 'เฟสนี้ไม่อยู่ในบริษัทนี้' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.check_phase_vo_refs() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER trg_check_phase_vo_refs BEFORE INSERT OR UPDATE ON phase_vo_values
  FOR EACH ROW EXECUTE FUNCTION check_phase_vo_refs();

-- 4. card structure and point invariants (under a lock on the node's phase row).
-- Split is one level deep and only between general cards. Points: general cards, split
-- children and issue cards are 0 (trg_a_card_weight forces it); a node's BOQ cards sum to
-- 100 by construction (recompute_node_weights), so the over-100 check is only a backstop.
CREATE OR REPLACE FUNCTION public.check_node_weights() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_sum numeric; v_parent phase_tasks%ROWTYPE;
BEGIN
  -- a card moving between phases locks both phase rows in id order (two opposite moves
  -- would otherwise deadlock); the recompute below then finds them already locked
  PERFORM 1 FROM site_phases
   WHERE id IN (NEW.phase_id, CASE WHEN TG_OP = 'UPDATE' THEN OLD.phase_id END)
   ORDER BY id FOR NO KEY UPDATE;
  IF NEW.parent_task_id IS NULL THEN
    IF NEW.issue_report_id IS NULL THEN
      SELECT COALESCE(sum(weight_pts), 0) INTO v_sum FROM phase_tasks
       WHERE tenant_id = NEW.tenant_id AND parent_task_id IS NULL AND issue_report_id IS NULL
         AND COALESCE(subtask_id, phase_id) = COALESCE(NEW.subtask_id, NEW.phase_id);
      IF v_sum > 100.005 THEN
        RAISE EXCEPTION 'แต้มในเฟสนี้รวมเกิน 100' USING ERRCODE = '22023';
      END IF;
    END IF;
    -- NEW may itself be a parent: a BOQ card never is
    IF NEW.progress_mode = 'quantity'
       AND EXISTS (SELECT 1 FROM phase_tasks WHERE tenant_id = NEW.tenant_id AND parent_task_id = NEW.id) THEN
      RAISE EXCEPTION 'แตกงานได้เฉพาะงานทั่วไป' USING ERRCODE = '22023';
    END IF;
  ELSE
    SELECT * INTO v_parent FROM phase_tasks WHERE id = NEW.parent_task_id AND tenant_id = NEW.tenant_id;
    IF v_parent.parent_task_id IS NOT NULL
       OR EXISTS (SELECT 1 FROM phase_tasks WHERE tenant_id = NEW.tenant_id AND parent_task_id = NEW.id) THEN
      RAISE EXCEPTION 'แตกงานได้ชั้นเดียว' USING ERRCODE = '22023';
    END IF;
    IF NEW.progress_mode = 'quantity' OR v_parent.progress_mode = 'quantity' THEN
      RAISE EXCEPTION 'แตกงานได้เฉพาะงานทั่วไป' USING ERRCODE = '22023';
    END IF;
  END IF;
  IF NEW.weight_pts <> 0
     AND (NEW.progress_mode = 'status' OR NEW.parent_task_id IS NOT NULL OR NEW.issue_report_id IS NOT NULL) THEN
    RAISE EXCEPTION 'งานทั่วไปไม่มีแต้ม' USING ERRCODE = '22023';
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.check_node_weights() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER trg_check_node_weights
  AFTER INSERT OR UPDATE OF weight_pts, parent_task_id, phase_id, subtask_id, progress_mode ON phase_tasks
  FOR EACH ROW EXECUTE FUNCTION check_node_weights();

-- 4b. BOQ card points
-- A card's node: its subtask, else its phase.
CREATE OR REPLACE FUNCTION public.node_of(t phase_tasks) RETURNS uuid
  LANGUAGE sql IMMUTABLE SET search_path = public
AS $$ SELECT COALESCE(t.subtask_id, t.phase_id) $$;
REVOKE ALL ON FUNCTION public.node_of(phase_tasks) FROM PUBLIC, anon, authenticated;

-- 100 points over ids in order, by value. A value of 0 is a real price (0 points); a NULL or
-- negative value is unpriced and takes the mean of the priced ones. With nothing priced, or
-- every value 0, each id gets an equal share. Shares are rounded to 2 dp and the first id
-- takes the remainder, so the result sums to exactly 100. If rounding would push that
-- remainder below 0, shares are rounded down instead (remainder then >= 0).
CREATE OR REPLACE FUNCTION public.point_shares(p_ids uuid[], p_values numeric[])
  RETURNS TABLE(id uuid, pts numeric) LANGUAGE sql IMMUTABLE SET search_path = public
AS $$
  WITH x AS (SELECT u.cid, u.cv, u.ord FROM unnest(p_ids, p_values) WITH ORDINALITY AS u(cid, cv, ord)),
  e0 AS (SELECT x.cid, x.ord, CASE WHEN x.cv >= 0 THEN x.cv ELSE a.avg_v END AS ev
           FROM x CROSS JOIN (SELECT avg(cv) FILTER (WHERE cv >= 0) AS avg_v FROM x) a),
  e AS (SELECT e0.cid, e0.ord, CASE WHEN COALESCE(t.total, 0) = 0 THEN 1 ELSE e0.ev END AS ev
          FROM e0 CROSS JOIN (SELECT sum(ev) AS total FROM e0) t),
  r AS (SELECT e.cid, e.ord, 100 * e.ev / sum(e.ev) OVER () AS raw FROM e),
  k AS (SELECT sum(round(raw, 2)) - 100 <= min(round(raw, 2)) FILTER (WHERE ord = 1) AS use_round FROM r),
  p AS (SELECT r.cid, r.ord, CASE WHEN k.use_round THEN round(r.raw, 2) ELSE trunc(r.raw, 2) END AS sp
          FROM r CROSS JOIN k)
  SELECT p.cid, CASE WHEN p.ord = 1 THEN p.sp + 100 - sum(p.sp) OVER () ELSE p.sp END FROM p
$$;
REVOKE ALL ON FUNCTION public.point_shares(uuid[], numeric[]) FROM PUBLIC, anon, authenticated;

-- Re-split the node's BOQ cards (top-level, not issue cards). Card value = planned_qty x
-- line_total / quantity of the quotation item behind its BOQ line; a manual line (or a
-- quantity of 0) has no value. Internal: runs as owner, granted to no one. Locks the node's
-- phase row first, so two transactions adding cards to one phase recompute one after the other.
CREATE OR REPLACE FUNCTION public.recompute_node_weights(p_node uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_tenant uuid; v_phase uuid; v_is_phase boolean := true;
        v_prev text := current_setting('app.derived_status', true);
BEGIN
  SELECT tenant_id, id INTO v_tenant, v_phase FROM site_phases WHERE id = p_node;
  IF NOT FOUND THEN
    v_is_phase := false;
    SELECT tenant_id, phase_id INTO v_tenant, v_phase FROM phase_subtasks WHERE id = p_node;
    IF NOT FOUND THEN RETURN; END IF;  -- node gone (cascading delete)
  END IF;
  PERFORM 1 FROM site_phases WHERE id = v_phase FOR NO KEY UPDATE;
  PERFORM set_config('app.derived_status', '1', true);
  WITH c AS (
    SELECT t.id, t.sort_order, t.created_at, t.planned_qty * qi.line_total / qi.quantity AS v
      FROM phase_tasks t
      LEFT JOIN boq_items b ON b.id = t.boq_item_id AND b.tenant_id = t.tenant_id
      LEFT JOIN quotation_items qi ON qi.id = b.quotation_item_id AND qi.tenant_id = t.tenant_id AND qi.quantity > 0
     WHERE t.tenant_id = v_tenant AND t.progress_mode = 'quantity' AND t.parent_task_id IS NULL AND t.issue_report_id IS NULL
       AND CASE WHEN v_is_phase THEN t.phase_id = p_node AND t.subtask_id IS NULL ELSE t.subtask_id = p_node END
  )
  UPDATE phase_tasks t SET weight_pts = s.pts
    FROM point_shares((SELECT array_agg(c.id ORDER BY c.sort_order, c.created_at, c.id) FROM c),
                      (SELECT array_agg(c.v ORDER BY c.sort_order, c.created_at, c.id) FROM c)) s
   WHERE t.id = s.id AND t.tenant_id = v_tenant AND t.weight_pts IS DISTINCT FROM s.pts;
  PERFORM set_config('app.derived_status', COALESCE(v_prev, ''), true);
END $$;
REVOKE ALL ON FUNCTION public.recompute_node_weights(uuid) FROM PUBLIC, anon, authenticated;

-- Points are never taken from the client. General cards, split children and issue cards are
-- forced to 0. A BOQ card starts at 0 and otherwise keeps its points; only the recompute
-- (under the derived flag) writes them. A general card also drops any BOQ line and planned
-- quantity (a BOQ -> general flip frees the line; the guard already demands no live reports
-- for a flip, so done_qty is 0). Named trg_a_* so it runs before the other BEFORE triggers
-- (guard_derived_status then never sees a client-sent point change).
CREATE OR REPLACE FUNCTION public.force_card_weight() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public
AS $$
BEGIN
  IF NEW.progress_mode = 'status' THEN
    NEW.boq_item_id := NULL;
    NEW.planned_qty := NULL;
  END IF;
  IF NEW.progress_mode = 'status' OR NEW.parent_task_id IS NOT NULL OR NEW.issue_report_id IS NOT NULL THEN
    NEW.weight_pts := 0;
  ELSIF current_setting('app.derived_status', true) IS DISTINCT FROM '1' THEN
    NEW.weight_pts := CASE WHEN TG_OP = 'INSERT' THEN 0 ELSE OLD.weight_pts END;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.force_card_weight() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER trg_a_card_weight BEFORE INSERT OR UPDATE ON phase_tasks
  FOR EACH ROW EXECUTE FUNCTION force_card_weight();

-- After a card joins, leaves or changes inside a node, re-split that node's points (old and
-- new node when it moves; both phase rows are locked in id order first). Only BOQ cards
-- count, so general-card writes cost nothing. The recompute itself writes weight_pts only,
-- which is not in these column lists: no re-fire.
CREATE OR REPLACE FUNCTION public.recompute_card_weights() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_old uuid; v_new uuid;
BEGIN
  IF TG_OP <> 'INSERT' AND OLD.progress_mode = 'quantity' AND OLD.parent_task_id IS NULL AND OLD.issue_report_id IS NULL THEN
    v_old := node_of(OLD);
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.progress_mode = 'quantity' AND NEW.parent_task_id IS NULL AND NEW.issue_report_id IS NULL THEN
    v_new := node_of(NEW);
  END IF;
  IF v_old IS NOT NULL AND v_new IS NOT NULL AND v_old IS DISTINCT FROM v_new THEN
    PERFORM 1 FROM site_phases WHERE id IN (OLD.phase_id, NEW.phase_id) ORDER BY id FOR NO KEY UPDATE;
  END IF;
  IF v_old IS NOT NULL AND v_old IS DISTINCT FROM v_new THEN
    PERFORM recompute_node_weights(v_old);
  END IF;
  IF v_new IS NOT NULL THEN
    PERFORM recompute_node_weights(v_new);
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.recompute_card_weights() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER trg_recompute_card_weights AFTER INSERT OR DELETE ON phase_tasks
  FOR EACH ROW EXECUTE FUNCTION recompute_card_weights();
CREATE TRIGGER trg_recompute_card_weights_upd
  AFTER UPDATE OF progress_mode, planned_qty, boq_item_id, phase_id, subtask_id, parent_task_id, issue_report_id ON phase_tasks
  FOR EACH ROW WHEN ((OLD.progress_mode, OLD.planned_qty, OLD.boq_item_id, OLD.phase_id, OLD.subtask_id, OLD.parent_task_id, OLD.issue_report_id)
                     IS DISTINCT FROM (NEW.progress_mode, NEW.planned_qty, NEW.boq_item_id, NEW.phase_id, NEW.subtask_id, NEW.parent_task_id, NEW.issue_report_id))
  EXECUTE FUNCTION recompute_card_weights();

-- A BOQ line's quotation link changed, or the price of the quotation item behind it: re-split
-- the nodes of the BOQ cards on that line only. (A BOQ line's own planned_qty does not change
-- any card value -- a card's value uses the card's planned_qty -- so it triggers nothing.)
-- Nodes are visited in phase id order, so the phase locks are always taken in one order.
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
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.recompute_line_weights() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER trg_recompute_line_weights AFTER UPDATE OF quotation_item_id ON boq_items
  FOR EACH ROW WHEN (OLD.quotation_item_id IS DISTINCT FROM NEW.quotation_item_id)
  EXECUTE FUNCTION recompute_line_weights();
CREATE TRIGGER trg_recompute_line_weights AFTER UPDATE OF line_total, quantity ON quotation_items
  FOR EACH ROW WHEN (OLD.line_total IS DISTINCT FROM NEW.line_total OR OLD.quantity IS DISTINCT FROM NEW.quantity)
  EXECUTE FUNCTION recompute_line_weights();

-- 5. BOQ quantity limit
CREATE OR REPLACE FUNCTION public.check_boq_qty() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_limit numeric; v_sum numeric;
BEGIN
  IF NEW.boq_item_id IS NULL THEN RETURN NULL; END IF;
  SELECT planned_qty INTO v_limit FROM boq_items WHERE id = NEW.boq_item_id AND tenant_id = NEW.tenant_id FOR NO KEY UPDATE;
  SELECT COALESCE(sum(planned_qty), 0) INTO v_sum FROM phase_tasks
   WHERE tenant_id = NEW.tenant_id AND boq_item_id = NEW.boq_item_id;
  IF v_sum > v_limit THEN
    RAISE EXCEPTION 'จำนวนในการ์ดรวมเกิน BOQ' USING ERRCODE = '22023';
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.check_boq_qty() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER trg_check_boq_qty AFTER INSERT OR UPDATE OF planned_qty, boq_item_id ON phase_tasks
  FOR EACH ROW EXECUTE FUNCTION check_boq_qty();

-- 7a. progress_reports insert: card must be this tenant's quantity card; site_id comes from the card
CREATE OR REPLACE FUNCTION public.progress_report_refs() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE t phase_tasks%ROWTYPE;
BEGIN
  SELECT * INTO t FROM phase_tasks WHERE id = NEW.task_id AND tenant_id = NEW.tenant_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ไม่พบการ์ดนี้' USING ERRCODE = '42501';
  END IF;
  NEW.site_id := t.site_id;
  IF t.progress_mode <> 'quantity' THEN
    RAISE EXCEPTION 'การ์ดนี้ไม่ได้นับจำนวน' USING ERRCODE = '22023';
  END IF;
  IF t.done_qty + NEW.qty > t.planned_qty THEN
    RAISE EXCEPTION 'เกินจำนวนที่เหลือ %', trim_scale(t.planned_qty - t.done_qty) USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.progress_report_refs() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER trg_a_progress_report_refs BEFORE INSERT ON progress_reports
  FOR EACH ROW EXECUTE FUNCTION progress_report_refs();

-- 7b. progress_reports update: only a one-way cancel (cancelled_at/cancelled_by) is allowed
CREATE OR REPLACE FUNCTION public.progress_report_cancel_only() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public
AS $$
BEGIN
  IF (to_jsonb(NEW) - 'cancelled_at' - 'cancelled_by') IS DISTINCT FROM (to_jsonb(OLD) - 'cancelled_at' - 'cancelled_by') THEN
    RAISE EXCEPTION 'แก้รายการบันทึกยอดไม่ได้ ให้ยกเลิกแล้วบันทึกใหม่' USING ERRCODE = '22023';
  END IF;
  IF OLD.cancelled_at IS NOT NULL
     AND (NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at OR NEW.cancelled_by IS DISTINCT FROM OLD.cancelled_by) THEN
    RAISE EXCEPTION 'รายการนี้ถูกยกเลิกแล้ว' USING ERRCODE = '22023';
  END IF;
  -- who cancelled is the caller, never a value sent by the client
  IF OLD.cancelled_at IS NULL THEN
    NEW.cancelled_by := CASE WHEN NEW.cancelled_at IS NULL THEN NULL ELSE auth.email() END;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.progress_report_cancel_only() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER trg_progress_report_cancel_only BEFORE UPDATE ON progress_reports
  FOR EACH ROW EXECUTE FUNCTION progress_report_cancel_only();

-- 6. quantity drives done_qty and status
CREATE OR REPLACE FUNCTION public.sync_task_qty() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_done numeric; v_prev text := current_setting('app.derived_status', true);
BEGIN
  SELECT COALESCE(sum(qty), 0) INTO v_done FROM progress_reports
   WHERE task_id = NEW.task_id AND tenant_id = NEW.tenant_id AND cancelled_at IS NULL;
  PERFORM set_config('app.derived_status', '1', true);
  UPDATE phase_tasks
     SET done_qty = v_done,
         status = CASE WHEN v_done = 0 THEN 'not_started' WHEN v_done < planned_qty THEN 'in_progress' ELSE 'done' END
   WHERE id = NEW.task_id AND tenant_id = NEW.tenant_id;
  PERFORM set_config('app.derived_status', COALESCE(v_prev, ''), true);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.sync_task_qty() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER trg_sync_task_qty AFTER INSERT OR UPDATE OF cancelled_at ON progress_reports
  FOR EACH ROW EXECUTE FUNCTION sync_task_qty();

-- 7c. RPCs (SECURITY INVOKER: RLS applies)
CREATE OR REPLACE FUNCTION public.record_progress(p_task_id uuid, p_qty numeric, p_work_date date, p_note text)
  RETURNS uuid LANGUAGE plpgsql SET search_path = public
AS $$
DECLARE t phase_tasks%ROWTYPE; v_id uuid;
BEGIN
  IF NOT can_manage_plan() OR NOT tenant_can_write() THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์บันทึกยอด' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO t FROM phase_tasks WHERE id = p_task_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบการ์ดนี้' USING ERRCODE = 'P0002'; END IF;
  IF t.progress_mode <> 'quantity' THEN
    RAISE EXCEPTION 'การ์ดนี้ไม่ได้นับจำนวน' USING ERRCODE = '22023';
  END IF;
  IF p_qty IS NULL OR p_qty <= 0 OR t.done_qty + p_qty > t.planned_qty THEN
    RAISE EXCEPTION 'เกินจำนวนที่เหลือ %', trim_scale(t.planned_qty - t.done_qty) USING ERRCODE = '22023';
  END IF;
  INSERT INTO progress_reports (site_id, task_id, qty, work_date, note)
    VALUES (t.site_id, t.id, p_qty, COALESCE(p_work_date, current_date), p_note)
    RETURNING id INTO v_id;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION public.record_progress(uuid, numeric, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_progress(uuid, numeric, date, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.cancel_progress(p_report_id uuid)
  RETURNS void LANGUAGE plpgsql SET search_path = public
AS $$
BEGIN
  IF NOT can_manage_plan() OR NOT tenant_can_write() THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ยกเลิกยอด' USING ERRCODE = '42501';
  END IF;
  UPDATE progress_reports SET cancelled_at = now(), cancelled_by = auth.email()
   WHERE id = p_report_id AND cancelled_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบรายการนี้ หรือถูกยกเลิกแล้ว' USING ERRCODE = 'P0002'; END IF;
END $$;
REVOKE ALL ON FUNCTION public.cancel_progress(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_progress(uuid) TO authenticated;

-- 8. quantity cards and parent cards only move through derived updates.
-- Also guards done_qty (derived only), progress_mode (staff only, no live reports,
-- no children) and planned_qty (staff only; on a quantity card >= done_qty, status re-derived here,
-- in NEW, so no extra UPDATE). OLD or NEW quantity mode counts, so flipping the mode
-- in the same UPDATE as the status cannot bypass the guard. Once a card has recorded
-- quantity, only OWNER/PM may change planned_qty or progress_mode (ADMIN could otherwise
-- finish it by lowering planned_qty). weight_pts, parent_task_id and boq_item_id are staff only
-- (a WORKER may update an assigned card's status, never its points or structure). A client
-- never changes weight_pts at all (trg_a_card_weight runs first); that check is a backstop.
CREATE OR REPLACE FUNCTION public.guard_derived_status() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_mode_changed boolean := NEW.progress_mode IS DISTINCT FROM OLD.progress_mode;
BEGIN
  IF current_setting('app.derived_status', true) IS DISTINCT FROM '1' THEN
    IF NEW.done_qty IS DISTINCT FROM OLD.done_qty THEN
      RAISE EXCEPTION 'ยอดที่ติดแล้วคิดจากรายการบันทึกยอด ให้ PM บันทึกยอดในแอป' USING ERRCODE = '22023';
    END IF;
    -- a WORKER could otherwise lower planned_qty to done_qty and so mark the card done
    IF NEW.planned_qty IS DISTINCT FROM OLD.planned_qty AND NOT is_site_staff() THEN
      RAISE EXCEPTION 'แก้จำนวนในการ์ดได้เฉพาะ OWNER/ADMIN/PM' USING ERRCODE = '22023';
    END IF;
    IF (NEW.planned_qty IS DISTINCT FROM OLD.planned_qty OR v_mode_changed) AND OLD.done_qty > 0
       AND NOT can_manage_plan() THEN
      RAISE EXCEPTION 'เฉพาะ OWNER/PM แก้จำนวนการ์ดที่มียอดแล้ว' USING ERRCODE = '22023';
    END IF;
    IF (NEW.weight_pts IS DISTINCT FROM OLD.weight_pts OR NEW.parent_task_id IS DISTINCT FROM OLD.parent_task_id
        OR NEW.boq_item_id IS DISTINCT FROM OLD.boq_item_id) AND NOT is_site_staff() THEN
      RAISE EXCEPTION 'แก้แต้ม/งานหลัก/รายการ BOQ ของการ์ดได้เฉพาะ OWNER/ADMIN/PM' USING ERRCODE = '22023';
    END IF;
    IF v_mode_changed THEN
      IF NOT is_site_staff() THEN
        RAISE EXCEPTION 'เปลี่ยนวิธีนับงานได้เฉพาะ OWNER/ADMIN/PM' USING ERRCODE = '22023';
      END IF;
      IF EXISTS (SELECT 1 FROM progress_reports WHERE task_id = NEW.id AND tenant_id = NEW.tenant_id AND cancelled_at IS NULL) THEN
        RAISE EXCEPTION 'การ์ดนี้มีรายการบันทึกยอดแล้ว เปลี่ยนวิธีนับไม่ได้' USING ERRCODE = '22023';
      END IF;
      IF EXISTS (SELECT 1 FROM phase_tasks WHERE tenant_id = NEW.tenant_id AND parent_task_id = NEW.id) THEN
        RAISE EXCEPTION 'งานหลักเปลี่ยนวิธีนับไม่ได้' USING ERRCODE = '22023';
      END IF;
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      IF OLD.progress_mode = 'quantity' OR NEW.progress_mode = 'quantity' THEN
        RAISE EXCEPTION 'งานนี้นับเป็นจำนวน ให้ PM บันทึกยอดในแอป' USING ERRCODE = '22023';
      END IF;
      IF EXISTS (SELECT 1 FROM phase_tasks WHERE tenant_id = NEW.tenant_id AND parent_task_id = NEW.id) THEN
        RAISE EXCEPTION 'สถานะงานหลักคิดจากงานย่อย' USING ERRCODE = '22023';
      END IF;
    END IF;
  END IF;
  IF NEW.progress_mode = 'quantity' AND (v_mode_changed OR NEW.planned_qty IS DISTINCT FROM OLD.planned_qty) THEN
    IF NEW.planned_qty < NEW.done_qty THEN
      RAISE EXCEPTION 'จำนวนในการ์ดน้อยกว่ายอดที่ติดแล้ว' USING ERRCODE = '22023';
    END IF;
    NEW.status := CASE WHEN NEW.done_qty = 0 THEN 'not_started'
                       WHEN NEW.done_qty < NEW.planned_qty THEN 'in_progress' ELSE 'done' END;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_derived_status() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER trg_guard_derived_status
  BEFORE UPDATE OF status, done_qty, progress_mode, planned_qty, weight_pts, parent_task_id, boq_item_id ON phase_tasks
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.done_qty IS DISTINCT FROM NEW.done_qty
                     OR OLD.progress_mode IS DISTINCT FROM NEW.progress_mode OR OLD.planned_qty IS DISTINCT FROM NEW.planned_qty
                     OR OLD.weight_pts IS DISTINCT FROM NEW.weight_pts OR OLD.parent_task_id IS DISTINCT FROM NEW.parent_task_id
                     OR OLD.boq_item_id IS DISTINCT FROM NEW.boq_item_id)
  EXECUTE FUNCTION guard_derived_status();

-- 9. parent status follows its children
CREATE OR REPLACE FUNCTION public.set_parent_status_from_children(p_parent_id uuid, p_tenant_id uuid)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_status text; v_prev text := current_setting('app.derived_status', true);
BEGIN
  SELECT CASE WHEN bool_and(status = 'done') THEN 'done'
              WHEN bool_or(status <> 'not_started') THEN 'in_progress'
              ELSE 'not_started' END
    INTO v_status FROM phase_tasks WHERE tenant_id = p_tenant_id AND parent_task_id = p_parent_id;
  IF v_status IS NULL THEN RETURN; END IF;  -- no children left: keep the parent's status
  PERFORM set_config('app.derived_status', '1', true);
  UPDATE phase_tasks SET status = v_status
   WHERE id = p_parent_id AND tenant_id = p_tenant_id AND status IS DISTINCT FROM v_status;
  PERFORM set_config('app.derived_status', COALESCE(v_prev, ''), true);
END $$;
REVOKE ALL ON FUNCTION public.set_parent_status_from_children(uuid, uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.sync_parent_status() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM set_parent_status_from_children(OLD.parent_task_id, OLD.tenant_id);
  ELSE
    PERFORM set_parent_status_from_children(NEW.parent_task_id, NEW.tenant_id);
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.sync_parent_status() FROM PUBLIC, anon, authenticated;
-- planned_qty/progress_mode: guard_derived_status may re-derive a quantity child's status in NEW
CREATE TRIGGER trg_sync_parent_status AFTER INSERT OR UPDATE OF status, weight_pts, planned_qty, progress_mode ON phase_tasks
  FOR EACH ROW WHEN (NEW.parent_task_id IS NOT NULL) EXECUTE FUNCTION sync_parent_status();
CREATE TRIGGER trg_sync_parent_status_del AFTER DELETE ON phase_tasks
  FOR EACH ROW WHEN (OLD.parent_task_id IS NOT NULL) EXECUTE FUNCTION sync_parent_status();

-- 9b. a card with recorded quantity keeps its history: it cannot be deleted while its site
-- exists (cancelled reports count too). Deleting the whole site still cascades.
CREATE OR REPLACE FUNCTION public.keep_progress_history() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM progress_reports WHERE task_id = OLD.id AND tenant_id = OLD.tenant_id)
     AND EXISTS (SELECT 1 FROM sites WHERE id = OLD.site_id) THEN
    RAISE EXCEPTION 'ยกเลิกยอดให้หมดก่อนลบการ์ด' USING ERRCODE = '22023';
  END IF;
  RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION public.keep_progress_history() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER trg_keep_progress_history BEFORE DELETE ON phase_tasks
  FOR EACH ROW EXECUTE FUNCTION keep_progress_history();

-- 10. split a general card one level (SECURITY INVOKER), at any status. The children are
-- general cards too (0 points) and start with the parent's status, so the parent's derived
-- status and the node's % do not move. p_children: [{"name": ...}, ...], at least 2.
-- The inserts run under the derived flag (children of a started card may start in_progress/done).
CREATE OR REPLACE FUNCTION public.split_task(p_task_id uuid, p_children jsonb)
  RETURNS void LANGUAGE plpgsql SET search_path = public
AS $$
DECLARE t phase_tasks%ROWTYPE; c record; v_prev text := current_setting('app.derived_status', true);
BEGIN
  SELECT * INTO t FROM phase_tasks WHERE id = p_task_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบการ์ดนี้' USING ERRCODE = 'P0002'; END IF;
  IF t.progress_mode = 'quantity' THEN
    RAISE EXCEPTION 'แตกงานได้เฉพาะงานทั่วไป' USING ERRCODE = '22023';
  END IF;
  IF t.parent_task_id IS NOT NULL THEN
    RAISE EXCEPTION 'แตกงานได้ชั้นเดียว' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM phase_tasks WHERE parent_task_id = t.id) THEN
    RAISE EXCEPTION 'การ์ดนี้แตกงานแล้ว' USING ERRCODE = '22023';
  END IF;
  IF t.issue_report_id IS NOT NULL THEN
    RAISE EXCEPTION 'การ์ดปัญหาแตกงานไม่ได้' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_children) IS DISTINCT FROM 'array' OR jsonb_array_length(p_children) < 2 THEN
    RAISE EXCEPTION 'ต้องแตกอย่างน้อย 2 งาน' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_children) e WHERE btrim(COALESCE(e->>'name', '')) = '') THEN
    RAISE EXCEPTION 'ต้องใส่ชื่องานย่อย' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('app.derived_status', '1', true);
  FOR c IN SELECT e->>'name' AS name, ord
             FROM jsonb_array_elements(p_children) WITH ORDINALITY AS x(e, ord) LOOP
    INSERT INTO phase_tasks (phase_id, subtask_id, site_id, tenant_id, zone, name, status, weight_pts, sort_order, parent_task_id)
      VALUES (t.phase_id, t.subtask_id, t.site_id, t.tenant_id, t.zone, btrim(c.name), t.status, 0,
              t.sort_order + c.ord::int, t.id);
  END LOOP;
  PERFORM set_config('app.derived_status', COALESCE(v_prev, ''), true);
END $$;
REVOKE ALL ON FUNCTION public.split_task(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.split_task(uuid, jsonb) TO authenticated;

-- 11. accepted quotation -> BOQ lines (internal, granted to no one)
CREATE OR REPLACE FUNCTION public.boq_insert_for_quotation(p_quotation_id uuid)
  RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE q quotations%ROWTYPE; v_max int; n int;
BEGIN
  SELECT * INTO q FROM quotations WHERE id = p_quotation_id;
  IF q.site_id IS NULL OR NOT EXISTS (SELECT 1 FROM sites WHERE id = q.site_id AND tenant_id = q.tenant_id) THEN
    RETURN 0;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('boq:' || q.site_id::text));
  SELECT COALESCE(max(code::int), 0) INTO v_max FROM boq_items WHERE site_id = q.site_id AND code ~ '^[0-9]{1,9}$';
  INSERT INTO boq_items (tenant_id, site_id, quotation_item_id, code, description, unit, planned_qty, sort_order)
  SELECT q.tenant_id, q.site_id, qi.id,
         (v_max + row_number() OVER (ORDER BY qi.sort_order, qi.id))::text,
         left(btrim(split_part(replace(qi.description, E'\r', ''), E'\n', 1)), 200),
         qi.unit, qi.quantity, qi.sort_order
    FROM quotation_items qi
   WHERE qi.quotation_id = q.id AND qi.tenant_id = q.tenant_id AND qi.item_type = 'item' AND qi.quantity > 0
     AND NOT EXISTS (SELECT 1 FROM boq_items b WHERE b.site_id = q.site_id AND b.quotation_item_id = qi.id)
  ON CONFLICT (site_id, quotation_item_id) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.boq_insert_for_quotation(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.boq_from_quotation() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  PERFORM boq_insert_for_quotation(NEW.id);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.boq_from_quotation() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER trg_boq_from_quotation AFTER UPDATE OF status, site_id ON quotations
  FOR EACH ROW WHEN (NEW.status = 'accepted' AND NEW.site_id IS NOT NULL
                     AND (OLD.status IS DISTINCT FROM NEW.status OR OLD.site_id IS DISTINCT FROM NEW.site_id))
  EXECUTE FUNCTION boq_from_quotation();

-- 12. re-pull BOQ lines from the site's accepted quotations (BOQ tab button).
-- Definer so a PM (who cannot read quotations) can use it; returns only a count, never a price.
CREATE OR REPLACE FUNCTION public.boq_refresh_from_quotations(p_site_id uuid)
  RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE q record; n int := 0;
BEGIN
  IF NOT is_site_staff() THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ดึง BOQ จากใบเสนอราคา' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM sites WHERE id = p_site_id AND tenant_id = current_tenant_id()) THEN
    RAISE EXCEPTION 'ไม่พบไซต์งาน' USING ERRCODE = 'P0002';
  END IF;
  FOR q IN SELECT id FROM quotations
            WHERE site_id = p_site_id AND tenant_id = current_tenant_id() AND status = 'accepted'
            ORDER BY created_at, id LOOP
    n := n + boq_insert_for_quotation(q.id);
  END LOOP;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.boq_refresh_from_quotations(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.boq_refresh_from_quotations(uuid) TO authenticated;

-- 13. each BOQ line's share of the site's BOQ value, in % (BOQ tab). Definer so PM can see
-- relative size without reading a price: returns percentages only (2 dp, summing to 100 per
-- site), split like card points (point_shares: unpriced lines take the mean, no prices -> equal).
CREATE OR REPLACE FUNCTION public.boq_value_shares(p_site_id uuid)
  RETURNS TABLE(boq_item_id uuid, share_pct numeric)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT is_site_staff() THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ดูสัดส่วนงาน BOQ' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM sites WHERE id = p_site_id AND tenant_id = current_tenant_id()) THEN
    RAISE EXCEPTION 'ไม่พบไซต์งาน' USING ERRCODE = 'P0002';
  END IF;
  RETURN QUERY
  WITH c AS (
    SELECT b.id, b.sort_order, b.created_at, b.planned_qty * qi.line_total / qi.quantity AS v
      FROM boq_items b
      LEFT JOIN quotation_items qi ON qi.id = b.quotation_item_id AND qi.tenant_id = b.tenant_id AND qi.quantity > 0
     WHERE b.site_id = p_site_id AND b.tenant_id = current_tenant_id()
  )
  SELECT s.id, s.pts
    FROM point_shares((SELECT array_agg(c.id ORDER BY c.sort_order, c.created_at, c.id) FROM c),
                      (SELECT array_agg(c.v ORDER BY c.sort_order, c.created_at, c.id) FROM c)) s;
END $$;
REVOKE ALL ON FUNCTION public.boq_value_shares(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.boq_value_shares(uuid) TO authenticated;

-- deferred minor from Task 1 review
REVOKE TRUNCATE ON site_plans, site_plan_items, progress_reports FROM authenticated, anon;
-- ===== before the 09 data steps =====
-- today's phase % in the app: round(100 * done / total) over top-level, non-issue cards
CREATE TEMP TABLE gt_old_pct ON COMMIT DROP AS
SELECT t.site_id, t.phase_id, count(*) AS cards,
       round(100.0 * count(*) FILTER (WHERE t.status = 'done') / count(*)) AS old_pct
  FROM phase_tasks t JOIN site_phases ph ON ph.id = t.phase_id
 WHERE t.parent_task_id IS NULL AND t.issue_report_id IS NULL AND NOT ph.is_issue_phase
 GROUP BY t.site_id, t.phase_id;
CREATE TEMP TABLE gt_cards_before ON COMMIT DROP AS
SELECT id, status, done_qty, progress_mode, planned_qty, parent_task_id, phase_id, subtask_id, weight_pts, updated_at FROM phase_tasks;
CREATE TEMP TABLE gt_phases_before ON COMMIT DROP AS
SELECT id, status, billing_weight_pct, updated_at FROM site_phases;
-- ===== inlined 2026-10-17-09-gantt-progress-data.sql body =====

-- ===== progress maths (SECURITY INVOKER: RLS applies to the caller) =====
CREATE OR REPLACE FUNCTION public.task_progress(p_task_id uuid) RETURNS numeric
  LANGUAGE plpgsql STABLE SET search_path = public
AS $$
DECLARE t phase_tasks%ROWTYPE; v_n int; v_wp numeric; v_avg numeric;
BEGIN
  SELECT * INTO t FROM phase_tasks WHERE id = p_task_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF t.progress_mode = 'quantity' THEN
    RETURN least(t.done_qty / t.planned_qty, 1);
  END IF;
  SELECT count(*), sum(c.w * c.p), avg(c.p) INTO v_n, v_wp, v_avg
    FROM (SELECT weight_pts AS w, task_progress(id) AS p FROM phase_tasks
           WHERE tenant_id = t.tenant_id AND parent_task_id = t.id) c;
  IF v_n > 0 THEN
    RETURN CASE WHEN t.weight_pts > 0 THEN v_wp / t.weight_pts ELSE v_avg END;
  END IF;
  RETURN CASE WHEN t.status = 'done' THEN 1 ELSE 0 END;
END $$;
REVOKE ALL ON FUNCTION public.task_progress(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.task_progress(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.node_progress(p_node_id uuid) RETURNS numeric
  LANGUAGE plpgsql STABLE SET search_path = public
AS $$
DECLARE v_tenant uuid; v_status text; v_is_phase boolean := true; v_n int; v_w numeric; v_wp numeric; v_avg numeric;
        v_gen_n int; v_gen_done boolean;
BEGIN
  SELECT tenant_id, status INTO v_tenant, v_status FROM site_phases WHERE id = p_node_id;
  IF NOT FOUND THEN
    v_is_phase := false;
    SELECT tenant_id, status INTO v_tenant, v_status FROM phase_subtasks WHERE id = p_node_id;
    IF NOT FOUND THEN RETURN NULL; END IF;
  END IF;
  -- child subtasks: a phase's top-level subtasks, or a subtask's children
  SELECT count(*), sum(c.w), sum(c.w * c.p), avg(c.p) INTO v_n, v_w, v_wp, v_avg
    FROM (SELECT billing_weight_pct AS w, node_progress(id) AS p FROM phase_subtasks
           WHERE tenant_id = v_tenant
             AND CASE WHEN v_is_phase THEN phase_id = p_node_id AND parent_subtask_id IS NULL
                      ELSE parent_subtask_id = p_node_id END) c;
  IF v_n > 0 THEN
    RETURN CASE WHEN v_w > 0 THEN v_wp / v_w ELSE v_avg END;
  END IF;
  -- top-level cards that are not issue cards: BOQ cards count by points (they sum to 100);
  -- with no BOQ card, the general cards count as one: all done 1, else 0
  SELECT count(*) FILTER (WHERE c.mode = 'quantity'), sum(c.w * c.p) FILTER (WHERE c.mode = 'quantity'),
         count(*) FILTER (WHERE c.mode = 'status'), bool_and(c.done) FILTER (WHERE c.mode = 'status')
    INTO v_n, v_wp, v_gen_n, v_gen_done
    FROM (SELECT progress_mode AS mode, weight_pts AS w, COALESCE(status = 'done', false) AS done,
                 CASE WHEN progress_mode = 'quantity' THEN task_progress(id) END AS p
            FROM phase_tasks
           WHERE tenant_id = v_tenant AND parent_task_id IS NULL AND issue_report_id IS NULL
             AND CASE WHEN v_is_phase THEN phase_id = p_node_id AND subtask_id IS NULL
                      ELSE subtask_id = p_node_id END) c;
  IF v_n > 0 THEN
    RETURN v_wp / 100;
  END IF;
  IF v_gen_n > 0 THEN
    RETURN CASE WHEN v_gen_done THEN 1 ELSE 0 END;
  END IF;
  RETURN CASE WHEN v_status = 'done' THEN 1 ELSE 0 END;
END $$;
REVOKE ALL ON FUNCTION public.node_progress(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.node_progress(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.site_progress_pct(p_site_id uuid)
  RETURNS TABLE(contract_pct numeric, total_pct numeric)
  LANGUAGE plpgsql STABLE SET search_path = public
AS $$
DECLARE v_tenant uuid; v_cv numeric; v_n int; v_w numeric; v_wp numeric; v_avg numeric; v_contract numeric;
        v_vo_n int; v_vo_sum numeric; v_vo_wp numeric;
BEGIN
  SELECT tenant_id, contract_value INTO v_tenant, v_cv FROM sites WHERE id = p_site_id;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT count(*), sum(c.w), sum(c.w * c.p), avg(c.p) INTO v_n, v_w, v_wp, v_avg
    FROM (SELECT billing_weight_pct AS w, node_progress(id) AS p FROM site_phases
           WHERE site_id = p_site_id AND tenant_id = v_tenant AND NOT is_vo AND NOT is_issue_phase) c;
  v_contract := CASE WHEN v_w > 0 THEN v_wp / v_w WHEN v_n > 0 THEN v_avg ELSE 0 END;
  SELECT count(*), COALESCE(sum(c.v), 0), COALESCE(sum(c.v * c.p), 0) INTO v_vo_n, v_vo_sum, v_vo_wp
    FROM (SELECT COALESCE(vv.vo_value, 0) AS v, node_progress(ph.id) AS p
            FROM site_phases ph
            LEFT JOIN phase_vo_values vv ON vv.phase_id = ph.id AND vv.tenant_id = ph.tenant_id
           WHERE ph.site_id = p_site_id AND ph.tenant_id = v_tenant AND ph.is_vo AND NOT ph.is_issue_phase) c;
  contract_pct := round(v_contract * 100, 2);
  total_pct := CASE WHEN COALESCE(v_cv, 0) > 0 AND v_vo_n > 0
                    THEN round((v_cv * v_contract + v_vo_wp) / (v_cv + v_vo_sum) * 100, 2) END;
  RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION public.site_progress_pct(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.site_progress_pct(uuid) TO authenticated;

-- ===== daily snapshots (S-curve actual line) =====
-- % ตามสัญญา: site staff (incl. PM)
CREATE TABLE public.site_progress_daily (
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL,
  day date NOT NULL,
  contract_pct numeric,
  PRIMARY KEY (site_id, day)
);
ALTER TABLE site_progress_daily ENABLE ROW LEVEL SECURITY;
CREATE POLICY site_staff_reads ON site_progress_daily FOR SELECT
  USING (( SELECT is_site_staff() ) AND tenant_id = ( SELECT current_tenant_id() ));
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON site_progress_daily FROM authenticated, anon;
-- % รวม VO: with contract_pct and the VO values it gives away contract_value, so OWNER/ADMIN only
CREATE TABLE public.site_progress_daily_money (
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL,
  day date NOT NULL,
  total_pct numeric,
  PRIMARY KEY (site_id, day)
);
ALTER TABLE site_progress_daily_money ENABLE ROW LEVEL SECURITY;
CREATE POLICY money_roles_read ON site_progress_daily_money FOR SELECT
  USING (( SELECT is_admin_or_owner() ) AND tenant_id = ( SELECT current_tenant_id() ));
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON site_progress_daily_money FROM authenticated, anon;

-- today's rows (Asia/Bangkok date) in both tables for every site with a phase that is not an
-- issue phase; returns the number of sites
CREATE OR REPLACE FUNCTION public.snapshot_site_progress() RETURNS int
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE n int; v_day date := (now() AT TIME ZONE 'Asia/Bangkok')::date;
BEGIN
  -- one pass over the sites; both INSERTs in the WITH run exactly once
  WITH p AS MATERIALIZED (
    SELECT s.id AS site_id, s.tenant_id, x.contract_pct, x.total_pct
      FROM sites s CROSS JOIN LATERAL site_progress_pct(s.id) x
     WHERE EXISTS (SELECT 1 FROM site_phases ph WHERE ph.site_id = s.id AND ph.tenant_id = s.tenant_id AND NOT ph.is_issue_phase)
  ), d AS (
    INSERT INTO site_progress_daily (site_id, tenant_id, day, contract_pct)
    SELECT site_id, tenant_id, v_day, contract_pct FROM p
    ON CONFLICT (site_id, day) DO UPDATE SET tenant_id = EXCLUDED.tenant_id, contract_pct = EXCLUDED.contract_pct
    RETURNING 1
  ), m AS (
    INSERT INTO site_progress_daily_money (site_id, tenant_id, day, total_pct)
    SELECT site_id, tenant_id, v_day, total_pct FROM p
    ON CONFLICT (site_id, day) DO UPDATE SET tenant_id = EXCLUDED.tenant_id, total_pct = EXCLUDED.total_pct
    RETURNING 1
  )
  SELECT count(*) INTO n FROM d;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.snapshot_site_progress() FROM PUBLIC, anon, authenticated;

-- 23:55 Asia/Bangkok = 16:55 UTC. cron.schedule with an existing name replaces that job.
SELECT cron.schedule('site-progress-snapshot', '55 16 * * *', $cron$SELECT public.snapshot_site_progress()$cron$);

-- ===== BOQ line cannot drop below what its cards already hold (controller ruling) =====
CREATE OR REPLACE FUNCTION public.check_boq_planned_qty() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_sum numeric;
BEGIN
  SELECT COALESCE(sum(planned_qty), 0) INTO v_sum FROM phase_tasks
   WHERE tenant_id = NEW.tenant_id AND boq_item_id = NEW.id;
  IF NEW.planned_qty < v_sum THEN
    RAISE EXCEPTION 'จำนวน BOQ น้อยกว่าที่แจกให้การ์ดแล้ว' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.check_boq_planned_qty() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER trg_check_boq_planned_qty BEFORE UPDATE OF planned_qty ON boq_items
  FOR EACH ROW WHEN (NEW.planned_qty IS DISTINCT FROM OLD.planned_qty) EXECUTE FUNCTION check_boq_planned_qty();

-- ===== demo seed: live definition (2026-10-15-01) + derived flag around the site loop + one final step =====
-- The seed inserts phases/cards already in_progress/done before any PLAN exists, so the site
-- loop runs under app.derived_status = '1' (require_site_plan lets it pass); the prior value
-- is restored before the PLAN snapshot step.
CREATE OR REPLACE FUNCTION public.demo_seed_core(p_tenant uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_bank UUID; v_client UUID; v_site UUID; v_phase UUID; i INT; j INT; k INT;
  v_phase_names TEXT[] := ARRAY['งานเตรียมการและฐานราก','งานโครงสร้าง','งานสถาปัตย์และระบบ','งานตกแต่งและส่งมอบ'];
  v_task_names TEXT[][] := ARRAY[
    ARRAY['รังวัดและวางผัง','ขุดดินและเทฐานราก','ตอกเข็ม/คานคอดิน'],
    ARRAY['เสาและคาน ชั้น 1','พื้นและเสา ชั้น 2','โครงหลังคา'],
    ARRAY['ก่ออิฐฉาบปูน','เดินระบบไฟฟ้า-ประปา','มุงหลังคา/ฝ้า'],
    ARRAY['ปูกระเบื้องและทาสี','ติดตั้งประตู-หน้าต่าง','ทำความสะอาดและส่งมอบ']];
  -- name, status, start month-offset, duration months, contract, client idx, lat, lng, location, deposit_pct, progress(0..1)
  v_sites TEXT[][] := ARRAY[
    ARRAY['บ้านคุณวิชัย ลาดพร้าว','Ongoing','5','7','4850000','1','13.8166','100.5972','ลาดพร้าว 71 กรุงเทพฯ','30','0.85'],
    ARRAY['อาคารพาณิชย์ 3 ชั้น งามวงศ์วาน','Ongoing','4','8','7200000','6','13.8520','100.5450','งามวงศ์วาน นนทบุรี','30','0.70'],
    ARRAY['คลับเฮาส์ หมู่บ้านพฤกษา','Ongoing','3','6','3600000','4','13.9120','100.4210','บางบัวทอง นนทบุรี','0','0.45'],
    ARRAY['โกดังสินค้า บางบัวทอง','Ongoing','2','6','5900000','7','13.9350','100.3980','บางบัวทอง นนทบุรี','30','0.30'],
    ARRAY['รีโนเวทบ้าน คุณนภา','Ongoing','1','3','1250000','2','13.8880','100.4890','เมืองนนทบุรี','0','0.15'],
    ARRAY['บ้านพักอาศัย 2 ชั้น ปากเกร็ด','Completed','8','6','3900000','3','13.9100','100.5000','ปากเกร็ด นนทบุรี','0','1'],
    ARRAY['ร้านกาแฟ เดอะ การ์เด้น','Completed','7','4','1850000','8','13.8700','100.5200','รัตนาธิเบศร์ นนทบุรี','0','1'],
    ARRAY['ต่อเติมครัว คุณสมศักดิ์','Completed','6','2','480000','1','13.8300','100.5700','ลาดพร้าว กรุงเทพฯ','0','1'],
    ARRAY['สำนักงานขาย โครงการเดอะพาร์ค','On Hold','3','5','2900000','5','13.9600','100.4500','ไทรน้อย นนทบุรี','0','0.20'],
    ARRAY['ศาลาริมน้ำ วัดบางพูด','Cancelled','4','3','650000','2','13.9300','100.5100','ปากเกร็ด นนทบุรี','0','0']];
  v_client_names TEXT[] := ARRAY['คุณวิชัย ศรีสุข','คุณนภา พงศ์ไพบูลย์','คุณอรุณ ตั้งใจดี','บจก. พฤกษา พร็อพเพอร์ตี้','บจก. เดอะพาร์ค ดีเวลลอปเมนท์','บจก. งามวงศ์วาน เทรดดิ้ง','หจก. บางบัวทอง โลจิสติกส์','คุณสมศักดิ์ มั่นคง'];
  v_client_types TEXT[] := ARRAY['ENDUSER','ENDUSER','ENDUSER','DEVELOPER','DEVELOPER','ENDUSER','ENDUSER','ENDUSER'];
  v_client_tax TEXT[] := ARRAY[NULL,NULL,NULL,'0105540000011','0105550000022','0125560000033','0123570000044',NULL];
  v_sup TEXT[][] := ARRAY[
    ARRAY['บจก. ไทยวัสดุก่อสร้าง','ปูน/ทราย/หิน','30','transfer'],
    ARRAY['ร้านเจริญเหล็ก','เหล็กเส้น/เหล็กรูปพรรณ','0','transfer'],
    ARRAY['หจก. ปูนดี ซัพพลาย','ปูนซีเมนต์','15','check'],
    ARRAY['ร้านไฟฟ้าสมบูรณ์','อุปกรณ์ไฟฟ้า','0','transfer'],
    ARRAY['บจก. สุขภัณฑ์ไทย','สุขภัณฑ์/ท่อ','30','transfer'],
    ARRAY['ร้านสีสวย','สี/เคมีภัณฑ์','0','transfer'],
    ARRAY['บจก. เครื่องมือช่าง โปร','เครื่องมือ','0','check'],
    ARRAY['ร้านอิฐบล็อก บางใหญ่','อิฐ/บล็อก','7','transfer']];
  v_cat TEXT[][] := ARRAY[
    ARRAY['งานโครงสร้าง (ปูน/เหล็ก)','#8B5E3C','STR','t'],
    ARRAY['งานสถาปัตย์','#C9A227','ARC','t'],
    ARRAY['ไฟฟ้า/ประปา','#2E7D9A','MEP','t'],
    ARRAY['วัสดุสิ้นเปลือง','#7A7A7A','SUP','t'],
    ARRAY['ค่าแรง','#B23A48','', 'f'],
    ARRAY['ค่าเดินทาง','#4F7942','', 'f'],
    ARRAY['เครื่องมือ','#5A4E8C','', 'f'],
    ARRAY['เบ็ดเตล็ด','#999999','', 'f']];
  v_catalog TEXT[][] := ARRAY[
    ARRAY['งานฐานรากและเสาเข็ม','งาน','380000'], ARRAY['งานโครงสร้าง ค.ส.ล.','ตร.ม.','4200'],
    ARRAY['งานก่ออิฐฉาบปูน','ตร.ม.','650'], ARRAY['งานโครงหลังคาและมุงหลังคา','ตร.ม.','1850'],
    ARRAY['งานระบบไฟฟ้า','จุด','1200'], ARRAY['งานระบบประปา-สุขาภิบาล','จุด','1500'],
    ARRAY['งานทาสีภายใน-ภายนอก','ตร.ม.','180'], ARRAY['งานปูกระเบื้อง','ตร.ม.','550'],
    ARRAY['งานฝ้าเพดาน','ตร.ม.','420'], ARRAY['งานประตู-หน้าต่าง','ชุด','8500'],
    ARRAY['งานสุขภัณฑ์','ชุด','12000'], ARRAY['งานรั้วและประตูรั้ว','เมตร','3200'],
    ARRAY['งานถนนและลานจอดรถ','ตร.ม.','950'], ARRAY['งานรื้อถอน','งาน','45000'],
    ARRAY['ค่าดำเนินการและกำไร','งาน','1']];
  v_start DATE; v_end DATE; v_status TEXT; v_prog NUMERIC; v_dur INT;
  v_prev_derived TEXT := current_setting('app.derived_status', true);
BEGIN
  -- default site: the T1 reset deletes it, later sections need it (signup trigger creates it with no status)
  IF NOT EXISTS (SELECT 1 FROM sites WHERE tenant_id = p_tenant AND is_default) THEN
    INSERT INTO sites (tenant_id, site_number, name, is_default) VALUES (p_tenant, 'SD-0000-000', 'ส่วนกลาง', true);
  END IF;

  -- company profile
  UPDATE tenants SET
    trial_ends_at = least(trial_ends_at, now() - interval '1 day'),   -- never show the free-trial banner
    address = '99/12 หมู่ 5 ถ.รัตนาธิเบศร์ ต.บางกระสอ อ.เมืองนนทบุรี จ.นนทบุรี 11000',
    tax_id = '0125599000001', phone = '02-000-0000', website = 'www.sangdee-demo.co.th',
    default_payment_terms = 'ชำระมัดจำ 30% เมื่อเซ็นสัญญา ส่วนที่เหลือแบ่งจ่ายตามงวดงาน หักประกันผลงาน 5% คืนภายใน 90 วันหลังส่งมอบ',
    default_notes = 'ราคานี้ยังไม่รวมค่าขออนุญาตก่อสร้างและค่าธรรมเนียมราชการ',
    document_template_key = 'classic'
  WHERE id = p_tenant;

  INSERT INTO bank_accounts (tenant_id, bank_name, account_name, account_no, vat_category, is_default, active)
  VALUES (p_tenant, 'ธนาคารกสิกรไทย', 'บจก. สร้างดี คอนสตรัคชั่น', '012-3-45678-9', 'vat', true, true) RETURNING id INTO v_bank;

  -- replace the signup defaults (aluminium-flavoured) with contractor categories
  DELETE FROM expense_categories WHERE tenant_id = p_tenant;
  FOR i IN 1..8 LOOP
    INSERT INTO expense_categories (tenant_id, name, color, sort_order, use_for_cost_deduction, code_prefix)
    VALUES (p_tenant, v_cat[i][1], v_cat[i][2], i, v_cat[i][4] = 't', NULLIF(v_cat[i][3], ''));
  END LOOP;
  INSERT INTO units (tenant_id, name) SELECT p_tenant, u FROM unnest(ARRAY['งาน','ตร.ม.','จุด','ชุด','เมตร','ถุง','เส้น','ก้อน','คิว','กล่อง']) u;

  FOR i IN 1..8 LOOP
    INSERT INTO clients (tenant_id, client_number, name, client_type, tax_id, phone, address, province, contact_person)
    VALUES (p_tenant, 'CL-' || to_char(current_date, 'YYYY') || '-' || lpad(i::text, 3, '0'), v_client_names[i], v_client_types[i], v_client_tax[i], '08' || lpad((10000000 + i * 1234567)::text, 8, '0'),
            (ARRAY['12/3 ซ.ลาดพร้าว 71 แขวงวังทองหลาง กรุงเทพฯ 10310','45 ม.2 ต.บางกระสอ อ.เมืองนนทบุรี 11000','88/9 ม.7 ต.บางพูด อ.ปากเกร็ด นนทบุรี 11120','1 อาคารพฤกษา ถ.แจ้งวัฒนะ ปากเกร็ด นนทบุรี 11120','55 ถ.บางกรวย-ไทรน้อย อ.ไทรน้อย นนทบุรี 11150','210 ถ.งามวงศ์วาน อ.เมืองนนทบุรี 11000','9/9 ม.4 ต.ละหาร อ.บางบัวทอง นนทบุรี 11110','23 ซ.ลาดพร้าว 101 แขวงคลองจั่น กรุงเทพฯ 10240'])[i],
            (ARRAY['กรุงเทพมหานคร','นนทบุรี','นนทบุรี','นนทบุรี','นนทบุรี','นนทบุรี','นนทบุรี','กรุงเทพมหานคร'])[i],
            CASE WHEN v_client_types[i] = 'DEVELOPER' THEN 'คุณประสิทธิ์ (ฝ่ายจัดซื้อ)' ELSE NULL END);
  END LOOP;

  FOR i IN 1..8 LOOP
    INSERT INTO suppliers (tenant_id, supplier_number, name, category, credit_days, default_payment_method, phone, payment_terms, tax_id)
    VALUES (p_tenant, 'SP-' || to_char(current_date, 'YYYY') || '-' || lpad(i::text, 3, '0'), v_sup[i][1], to_jsonb(ARRAY[v_sup[i][2]]), v_sup[i][3]::int, v_sup[i][4], '02-5' || lpad((10000 + i * 777)::text, 5, '0'),
            CASE WHEN v_sup[i][3]::int > 0 THEN 'เครดิต ' || v_sup[i][3] || ' วัน' ELSE 'เงินสด' END,
            '01255' || lpad((60000000 + i * 1111)::text, 8, '0'));
  END LOOP;

  FOR i IN 1..15 LOOP
    INSERT INTO catalog_items (tenant_id, name, unit, default_unit_price, active)
    VALUES (p_tenant, v_catalog[i][1], v_catalog[i][2], v_catalog[i][3]::numeric, true);
  END LOOP;

  -- sites, phases, tasks
  PERFORM set_config('app.derived_status', '1', true);
  FOR i IN 1..10 LOOP
    v_status := v_sites[i][2]; v_dur := v_sites[i][4]::int; v_prog := v_sites[i][11]::numeric;
    v_start := demo_m(v_sites[i][3]::int) + (i * 3);
    v_end := (v_start + make_interval(months => v_dur))::date;
    SELECT id INTO v_client FROM clients WHERE tenant_id = p_tenant AND name = v_client_names[v_sites[i][6]::int];
    INSERT INTO sites (tenant_id, site_number, name, status, start_date, end_date, contract_value, contract_value_no_vat, has_vat,
                       default_vat_pct, default_tax_withheld_pct, default_retention_pct, default_retention_period_days, default_deposit_pct,
                       retention_released, retention_released_date, client_id, client_name, location, lat, lng, distance_km, travel_minutes, is_default, notes)
    VALUES (p_tenant, 'SD-' || to_char(v_start, 'YYYY') || '-' || lpad(i::text, 3, '0'), v_sites[i][1], v_status, v_start,
            CASE WHEN v_status = 'Cancelled' THEN NULL ELSE v_end END,
            v_sites[i][5]::numeric * 1.07, v_sites[i][5]::numeric, true, 7, 3, 5, 90, v_sites[i][10]::numeric,
            (i = 8), CASE WHEN i = 8 THEN (v_end + 90) ELSE NULL END,
            v_client, v_client_names[v_sites[i][6]::int], v_sites[i][9], v_sites[i][7]::numeric, v_sites[i][8]::numeric,
            8 + i * 2.5, 20 + i * 4, false,
            CASE v_status WHEN 'On Hold' THEN 'ลูกค้าขอชะลอรอใบอนุญาต' WHEN 'Cancelled' THEN 'ลูกค้ายกเลิกก่อนเริ่มงาน' ELSE NULL END)
    RETURNING id INTO v_site;
    FOR j IN 1..4 LOOP
      INSERT INTO site_phases (tenant_id, site_id, name, sort_order, start_date, end_date, billing_weight_pct, status)
      VALUES (p_tenant, v_site, v_phase_names[j], j,
              (v_start + ((j - 1) * v_dur * 30 / 4))::date, (v_start + (j * v_dur * 30 / 4) - 1)::date, 25,
              CASE WHEN v_prog >= j * 0.25 THEN 'done' WHEN v_prog > (j - 1) * 0.25 THEN 'in_progress' ELSE 'not_started' END)
      RETURNING id INTO v_phase;
      FOR k IN 1..3 LOOP
        INSERT INTO phase_tasks (tenant_id, site_id, phase_id, name, sort_order, due_date, status)
        VALUES (p_tenant, v_site, v_phase, v_task_names[j][k], k, (v_start + ((j - 1) * v_dur * 30 / 4) + k * v_dur * 10 / 4)::date,
                CASE WHEN v_prog >= (j - 1) * 0.25 + k * 0.25 / 3 THEN 'done'
                     WHEN v_prog > (j - 1) * 0.25 + (k - 1) * 0.25 / 3 THEN 'in_progress' ELSE 'not_started' END);
      END LOOP;
    END LOOP;
  END LOOP;
  PERFORM set_config('app.derived_status', COALESCE(v_prev_derived, ''), true);

  -- Gantt weighted progress (2026-10-17-09): an auto PLAN v1 per seeded site, so a demo reset
  -- is never stuck behind the PLAN gate (seeded cards are general cards, 0 points)
  PERFORM snapshot_site_plan(s.id, 'สร้างอัตโนมัติตอนสร้างข้อมูลตัวอย่าง', true, 'system')
     FROM sites s
    WHERE s.tenant_id = p_tenant
      AND EXISTS (SELECT 1 FROM site_phases ph WHERE ph.site_id = s.id AND NOT ph.is_issue_phase)
      AND NOT EXISTS (SELECT 1 FROM site_plans sp WHERE sp.site_id = s.id);

  RETURN jsonb_build_object(
    'clients', (SELECT count(*) FROM clients WHERE tenant_id = p_tenant),
    'suppliers', (SELECT count(*) FROM suppliers WHERE tenant_id = p_tenant),
    'catalog_items', (SELECT count(*) FROM catalog_items WHERE tenant_id = p_tenant),
    'expense_categories', (SELECT count(*) FROM expense_categories WHERE tenant_id = p_tenant),
    'sites', (SELECT count(*) FROM sites WHERE tenant_id = p_tenant AND NOT is_default),
    'site_phases', (SELECT count(*) FROM site_phases WHERE tenant_id = p_tenant),
    'phase_tasks', (SELECT count(*) FROM phase_tasks WHERE tenant_id = p_tenant));
END $function$;
REVOKE ALL ON FUNCTION public.demo_seed_core(uuid) FROM PUBLIC, anon, authenticated;

-- ===== data migration (runs as the table owner; no card is changed) =====
-- Existing cards stay general cards with 0 points (no equal-points step any more).
-- 1. BOQ backfill from accepted quotations, 2. PLAN v1 for every site with a non-issue phase
DO $$
DECLARE q record;
BEGIN
  FOR q IN SELECT id FROM quotations WHERE status = 'accepted' AND site_id IS NOT NULL ORDER BY created_at, id LOOP
    PERFORM boq_insert_for_quotation(q.id);
  END LOOP;
  FOR q IN SELECT s.id FROM sites s
            WHERE EXISTS (SELECT 1 FROM site_phases ph WHERE ph.site_id = s.id AND NOT ph.is_issue_phase)
              AND NOT EXISTS (SELECT 1 FROM site_plans sp WHERE sp.site_id = s.id)
            ORDER BY s.created_at, s.id LOOP
    PERFORM snapshot_site_plan(q.id, 'สร้างอัตโนมัติตอนเปิดใช้ระบบ ' || to_char(current_date, 'YYYY-MM-DD'), true, 'system');
  END LOOP;
END $$;

-- 3. first snapshot
SELECT snapshot_site_progress();
-- ===== end of inlined bodies =====

DO $$
DECLARE
  v_tenant uuid; r jsonb := '{}'; n int; m int; b boolean; v text; x numeric; v_fx_bad int := 0;
  v_pm text := 'gantt-test-pm@example.invalid'; v_wk text := 'gantt-test-worker@example.invalid';
  v_admin text := 'gantt-test-admin@example.invalid'; v_phase uuid; v_fphase uuid;
  v_owner text; b2 bigint; v_boq uuid; v_card uuid; v_summary jsonb; v_report jsonb;
  v_today date := (now() AT TIME ZONE 'Asia/Bangkok')::date;
BEGIN
  SELECT id INTO v_tenant FROM tenants WHERE company_name ILIKE '%สร้างดี%' LIMIT 1;
  r := r || jsonb_build_object('fixtures_found_MUSTtrue', v_tenant IS NOT NULL);

  -- ===== (b) report for the owner: phases whose % changes (today's count-based % -> card kinds) =====
  -- Every existing card stays a general card with 0 points, so a phase with cards now shows 100
  -- only when all its cards are done (subtask phases: weighted subtasks), else 0.
  SELECT count(DISTINCT site_id), sum(cards) INTO n, x FROM gt_old_pct;
  r := r || jsonb_build_object('b_sites_with_cards', n, 'b_cards_compared', x);
  SELECT count(*), count(*) FILTER (WHERE old_pct IS DISTINCT FROM round(node_progress(phase_id) * 100)) INTO n, m FROM gt_old_pct;
  r := r || jsonb_build_object('b_phases_compared', n, 'phases_changed', m);
  SELECT COALESCE(jsonb_agg(jsonb_build_object('site_number', q.site_number, 'phase', q.phase, 'old_pct', q.old_pct, 'new_pct', q.new_pct)
                            ORDER BY q.site_number, q.sort_order, q.phase), '[]'::jsonb)
    INTO v_report FROM (
    SELECT s.site_number, ph.name AS phase, ph.sort_order, o.old_pct,
           trim_scale(round(node_progress(o.phase_id) * 100, 2)) AS new_pct
      FROM gt_old_pct o JOIN sites s ON s.id = o.site_id JOIN site_phases ph ON ph.id = o.phase_id
     WHERE o.old_pct IS DISTINCT FROM round(node_progress(o.phase_id) * 100)) q;
  r := r || jsonb_build_object('pct_change_report', v_report,
                               'b_report_rows_equal_phases_changed_MUSTtrue', jsonb_array_length(v_report) = m);
  SELECT count(*) INTO n FROM phase_tasks WHERE weight_pts <> 0 OR progress_mode <> 'status';
  r := r || jsonb_build_object('b_cards_not_general_zero_MUST0', n);
  SELECT count(*) INTO n FROM gt_cards_before o JOIN phase_tasks t USING (id)
   WHERE (o.status, o.done_qty, o.progress_mode, o.planned_qty, o.parent_task_id, o.phase_id, o.subtask_id, o.weight_pts, o.updated_at)
         IS DISTINCT FROM (t.status, t.done_qty, t.progress_mode, t.planned_qty, t.parent_task_id, t.phase_id, t.subtask_id, t.weight_pts, t.updated_at);
  SELECT n + (SELECT count(*) FROM phase_tasks) - (SELECT count(*) FROM gt_cards_before) INTO n;
  r := r || jsonb_build_object('b_cards_changed_MUST0', n);
  SELECT count(*) INTO n FROM gt_phases_before o JOIN site_phases p USING (id)
   WHERE (o.status, o.billing_weight_pct, o.updated_at) IS DISTINCT FROM (p.status, p.billing_weight_pct, p.updated_at);
  r := r || jsonb_build_object('b_phases_changed_MUST0', n);
  SELECT count(*) INTO n FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'set_equal_card_weights';
  r := r || jsonb_build_object('b_no_equal_weights_function_MUST0', n);

  -- ===== (c) PLAN v1 for every site with a non-issue phase =====
  SELECT count(*) INTO n FROM site_plans
   WHERE version = 1 AND is_auto AND created_by = 'system'
     AND note = 'สร้างอัตโนมัติตอนเปิดใช้ระบบ ' || to_char(current_date, 'YYYY-MM-DD');
  SELECT count(DISTINCT site_id) INTO m FROM site_phases WHERE NOT is_issue_phase;
  r := r || jsonb_build_object('c_plan_v1_rows', n, 'c_sites_with_phase', m, 'c_plan_v1_equals_sites_MUSTtrue', n = m AND n > 0);
  SELECT count(*) INTO n FROM site_plans WHERE version > 1;
  r := r || jsonb_build_object('c_plans_above_v1_MUST0', n);
  SELECT (SELECT count(*) FROM site_plan_items WHERE level = 'task')
       = (SELECT count(*) FROM phase_tasks t JOIN site_phases ph ON ph.id = t.phase_id WHERE t.issue_report_id IS NULL AND NOT ph.is_issue_phase)
     AND (SELECT count(*) FROM site_plan_items WHERE level = 'phase') = (SELECT count(*) FROM site_phases WHERE NOT is_issue_phase)
    INTO b;
  r := r || jsonb_build_object('c_plan_items_match_MUSTtrue', b);
  SELECT count(*) INTO n FROM site_plan_items i JOIN phase_tasks t ON t.id = i.ref_id WHERE i.level = 'task' AND i.weight IS DISTINCT FROM t.weight_pts;
  r := r || jsonb_build_object('c_plan_task_weight_differs_MUST0', n);

  -- ===== (d) BOQ backfill =====
  SELECT count(*) INTO n FROM boq_items;
  r := r || jsonb_build_object('d_boq_rows', n, 'd_boq_rows_at_least_1_MUSTtrue', n >= 1);
  SELECT count(*) INTO n FROM boq_items b JOIN sites s ON s.id = b.site_id WHERE s.tenant_id <> b.tenant_id;
  r := r || jsonb_build_object('d_boq_tenant_mismatch_MUST0', n);
  SELECT COALESCE(sum(boq_insert_for_quotation(id)), 0) INTO n FROM quotations WHERE status = 'accepted' AND site_id IS NOT NULL;
  r := r || jsonb_build_object('d_rerun_rows_MUST0', n);

  -- ===== (e) snapshot rows for today =====
  SELECT count(*) INTO n FROM site_progress_daily WHERE day = v_today;
  SELECT count(DISTINCT site_id) INTO m FROM site_phases WHERE NOT is_issue_phase;
  r := r || jsonb_build_object('e_today_rows', n, 'e_today_rows_equal_sites_MUSTtrue', n = m AND n > 0);
  SELECT count(*) INTO n FROM site_progress_daily_money WHERE day = v_today;
  r := r || jsonb_build_object('e_today_money_rows_equal_sites_MUSTtrue', n = m);
  SELECT count(*) INTO n FROM site_progress_daily d
    JOIN site_progress_daily_money mo ON mo.site_id = d.site_id AND mo.day = d.day
    CROSS JOIN LATERAL site_progress_pct(d.site_id) p
   WHERE d.day = v_today AND ((d.contract_pct, mo.total_pct) IS DISTINCT FROM (p.contract_pct, p.total_pct)
                              OR d.tenant_id <> (SELECT tenant_id FROM sites WHERE id = d.site_id)
                              OR mo.tenant_id <> d.tenant_id);
  r := r || jsonb_build_object('e_rows_differ_from_live_MUST0', n);
  SELECT snapshot_site_progress() INTO n;
  SELECT count(*) INTO x FROM site_progress_daily;
  SELECT count(*) INTO b2 FROM site_progress_daily_money;
  r := r || jsonb_build_object('e_rerun_upserts_same_rows_MUSTtrue', n = m AND x = m AND b2 = m);
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name IN ('site_progress_daily', 'site_phases') AND column_name IN ('total_pct', 'vo_value');
  r := r || jsonb_build_object('e_no_money_columns_on_staff_tables_MUST0', n);

  -- ===== (f) cron job =====
  SELECT count(*) INTO n FROM cron.job
   WHERE jobname = 'site-progress-snapshot' AND schedule = '55 16 * * *' AND command = 'SELECT public.snapshot_site_progress()';
  r := r || jsonb_build_object('f_cron_job_MUST1', n);

  -- ===== (a) fixtures: generated by scripts/gen-progress-fixture-sql.mjs =====
  -- fixture 1: general cards partly done count zero
  INSERT INTO sites (id, tenant_id, site_number, name, contract_value) VALUES (md5('gpf|1|site')::uuid, v_tenant, 'GT-PF-01', 'progress fixture: general cards partly done count zero', 0);
  PERFORM snapshot_site_plan(md5('gpf|1|site')::uuid, 'progress fixture', true, 'system');
  INSERT INTO site_phases (id, tenant_id, site_id, name, sort_order, billing_weight_pct, status, is_vo, is_issue_phase) VALUES (md5('gpf|1|A')::uuid, v_tenant, md5('gpf|1|site')::uuid, 'A', 1, 100, 'in_progress', false, false);
  INSERT INTO phase_tasks (id, tenant_id, site_id, phase_id, subtask_id, parent_task_id, name, sort_order, status, progress_mode, planned_qty, done_qty, boq_item_id, issue_report_id) VALUES (md5('gpf|1|a1')::uuid, v_tenant, md5('gpf|1|site')::uuid, md5('gpf|1|A')::uuid, NULL, NULL, 'a1', 1, 'done', 'status', NULL, 0, NULL, NULL);
  INSERT INTO phase_tasks (id, tenant_id, site_id, phase_id, subtask_id, parent_task_id, name, sort_order, status, progress_mode, planned_qty, done_qty, boq_item_id, issue_report_id) VALUES (md5('gpf|1|a2')::uuid, v_tenant, md5('gpf|1|site')::uuid, md5('gpf|1|A')::uuid, NULL, NULL, 'a2', 2, 'in_progress', 'status', NULL, 0, NULL, NULL);
  INSERT INTO phase_tasks (id, tenant_id, site_id, phase_id, subtask_id, parent_task_id, name, sort_order, status, progress_mode, planned_qty, done_qty, boq_item_id, issue_report_id) VALUES (md5('gpf|1|a3')::uuid, v_tenant, md5('gpf|1|site')::uuid, md5('gpf|1|A')::uuid, NULL, NULL, 'a3', 3, 'not_started', 'status', NULL, 0, NULL, NULL);
  x := round(node_progress(md5('gpf|1|A')::uuid) * 100, 2);
  r := r || jsonb_build_object('fx1_general_cards_partly_done_count_zero_phase_A_MUST0', x);
  IF x IS DISTINCT FROM 0::numeric THEN v_fx_bad := v_fx_bad + 1; END IF;
  x := (SELECT contract_pct FROM site_progress_pct(md5('gpf|1|site')::uuid));
  r := r || jsonb_build_object('fx1_general_cards_partly_done_count_zero_contract_MUST0', x);
  IF x IS DISTINCT FROM 0::numeric THEN v_fx_bad := v_fx_bad + 1; END IF;
  x := (SELECT total_pct FROM site_progress_pct(md5('gpf|1|site')::uuid));
  r := r || jsonb_build_object('fx1_general_cards_partly_done_count_zero_total_MUSTnull', x);
  IF x IS DISTINCT FROM NULL THEN v_fx_bad := v_fx_bad + 1; END IF;
  -- fixture 2: general cards all done count full
  INSERT INTO sites (id, tenant_id, site_number, name, contract_value) VALUES (md5('gpf|2|site')::uuid, v_tenant, 'GT-PF-02', 'progress fixture: general cards all done count full', 0);
  PERFORM snapshot_site_plan(md5('gpf|2|site')::uuid, 'progress fixture', true, 'system');
  INSERT INTO site_phases (id, tenant_id, site_id, name, sort_order, billing_weight_pct, status, is_vo, is_issue_phase) VALUES (md5('gpf|2|A')::uuid, v_tenant, md5('gpf|2|site')::uuid, 'A', 1, 100, 'in_progress', false, false);
  INSERT INTO phase_tasks (id, tenant_id, site_id, phase_id, subtask_id, parent_task_id, name, sort_order, status, progress_mode, planned_qty, done_qty, boq_item_id, issue_report_id) VALUES (md5('gpf|2|a1')::uuid, v_tenant, md5('gpf|2|site')::uuid, md5('gpf|2|A')::uuid, NULL, NULL, 'a1', 1, 'done', 'status', NULL, 0, NULL, NULL);
  INSERT INTO phase_tasks (id, tenant_id, site_id, phase_id, subtask_id, parent_task_id, name, sort_order, status, progress_mode, planned_qty, done_qty, boq_item_id, issue_report_id) VALUES (md5('gpf|2|a2')::uuid, v_tenant, md5('gpf|2|site')::uuid, md5('gpf|2|A')::uuid, NULL, NULL, 'a2', 2, 'done', 'status', NULL, 0, NULL, NULL);
  x := round(node_progress(md5('gpf|2|A')::uuid) * 100, 2);
  r := r || jsonb_build_object('fx2_general_cards_all_done_count_full_phase_A_MUST100', x);
  IF x IS DISTINCT FROM 100::numeric THEN v_fx_bad := v_fx_bad + 1; END IF;
  x := (SELECT contract_pct FROM site_progress_pct(md5('gpf|2|site')::uuid));
  r := r || jsonb_build_object('fx2_general_cards_all_done_count_full_contract_MUST100', x);
  IF x IS DISTINCT FROM 100::numeric THEN v_fx_bad := v_fx_bad + 1; END IF;
  x := (SELECT total_pct FROM site_progress_pct(md5('gpf|2|site')::uuid));
  r := r || jsonb_build_object('fx2_general_cards_all_done_count_full_total_MUSTnull', x);
  IF x IS DISTINCT FROM NULL THEN v_fx_bad := v_fx_bad + 1; END IF;
  -- fixture 3: boq cards by value share
  INSERT INTO sites (id, tenant_id, site_number, name, contract_value) VALUES (md5('gpf|3|site')::uuid, v_tenant, 'GT-PF-03', 'progress fixture: boq cards by value share', 0);
  PERFORM snapshot_site_plan(md5('gpf|3|site')::uuid, 'progress fixture', true, 'system');
  INSERT INTO site_phases (id, tenant_id, site_id, name, sort_order, billing_weight_pct, status, is_vo, is_issue_phase) VALUES (md5('gpf|3|A')::uuid, v_tenant, md5('gpf|3|site')::uuid, 'A', 1, 100, 'in_progress', false, false);
  INSERT INTO quotations (id, tenant_id, client_id, site_id, date, status, quotation_number) VALUES (md5('gpf|3|quotation')::uuid, v_tenant, (SELECT id FROM clients WHERE tenant_id = v_tenant ORDER BY created_at, id LIMIT 1), md5('gpf|3|site')::uuid, current_date, 'draft', 'GT-PF-Q03');
  INSERT INTO quotation_items (id, tenant_id, quotation_id, description, quantity, unit_price, line_total, sort_order) VALUES (md5('gpf|3|qi|L1')::uuid, v_tenant, md5('gpf|3|quotation')::uuid, 'L1', 10, 700, 7000, 1);
  INSERT INTO boq_items (id, tenant_id, site_id, quotation_item_id, code, description, planned_qty, sort_order) VALUES (md5('gpf|3|L1')::uuid, v_tenant, md5('gpf|3|site')::uuid, md5('gpf|3|qi|L1')::uuid, 'L1', 'L1', 10, 1);
  INSERT INTO quotation_items (id, tenant_id, quotation_id, description, quantity, unit_price, line_total, sort_order) VALUES (md5('gpf|3|qi|L2')::uuid, v_tenant, md5('gpf|3|quotation')::uuid, 'L2', 10, 150, 1500, 2);
  INSERT INTO boq_items (id, tenant_id, site_id, quotation_item_id, code, description, planned_qty, sort_order) VALUES (md5('gpf|3|L2')::uuid, v_tenant, md5('gpf|3|site')::uuid, md5('gpf|3|qi|L2')::uuid, 'L2', 'L2', 10, 2);
  INSERT INTO quotation_items (id, tenant_id, quotation_id, description, quantity, unit_price, line_total, sort_order) VALUES (md5('gpf|3|qi|L3')::uuid, v_tenant, md5('gpf|3|quotation')::uuid, 'L3', 10, 150, 1500, 3);
  INSERT INTO boq_items (id, tenant_id, site_id, quotation_item_id, code, description, planned_qty, sort_order) VALUES (md5('gpf|3|L3')::uuid, v_tenant, md5('gpf|3|site')::uuid, md5('gpf|3|qi|L3')::uuid, 'L3', 'L3', 10, 3);
  INSERT INTO phase_tasks (id, tenant_id, site_id, phase_id, subtask_id, parent_task_id, name, sort_order, status, progress_mode, planned_qty, done_qty, boq_item_id, issue_report_id) VALUES (md5('gpf|3|q1')::uuid, v_tenant, md5('gpf|3|site')::uuid, md5('gpf|3|A')::uuid, NULL, NULL, 'q1', 1, 'done', 'quantity', 10, 10, md5('gpf|3|L1')::uuid, NULL);
  INSERT INTO phase_tasks (id, tenant_id, site_id, phase_id, subtask_id, parent_task_id, name, sort_order, status, progress_mode, planned_qty, done_qty, boq_item_id, issue_report_id) VALUES (md5('gpf|3|q2')::uuid, v_tenant, md5('gpf|3|site')::uuid, md5('gpf|3|A')::uuid, NULL, NULL, 'q2', 2, 'in_progress', 'quantity', 10, 5, md5('gpf|3|L2')::uuid, NULL);
  INSERT INTO phase_tasks (id, tenant_id, site_id, phase_id, subtask_id, parent_task_id, name, sort_order, status, progress_mode, planned_qty, done_qty, boq_item_id, issue_report_id) VALUES (md5('gpf|3|q3')::uuid, v_tenant, md5('gpf|3|site')::uuid, md5('gpf|3|A')::uuid, NULL, NULL, 'q3', 3, 'not_started', 'quantity', 10, 0, md5('gpf|3|L3')::uuid, NULL);
  x := (SELECT weight_pts FROM phase_tasks WHERE id = md5('gpf|3|q1')::uuid);
  r := r || jsonb_build_object('fx3_boq_cards_by_value_share_pts_q1_MUST70', x);
  IF x IS DISTINCT FROM 70::numeric THEN v_fx_bad := v_fx_bad + 1; END IF;
  x := (SELECT weight_pts FROM phase_tasks WHERE id = md5('gpf|3|q2')::uuid);
  r := r || jsonb_build_object('fx3_boq_cards_by_value_share_pts_q2_MUST15', x);
  IF x IS DISTINCT FROM 15::numeric THEN v_fx_bad := v_fx_bad + 1; END IF;
  x := (SELECT weight_pts FROM phase_tasks WHERE id = md5('gpf|3|q3')::uuid);
  r := r || jsonb_build_object('fx3_boq_cards_by_value_share_pts_q3_MUST15', x);
  IF x IS DISTINCT FROM 15::numeric THEN v_fx_bad := v_fx_bad + 1; END IF;
  x := round(node_progress(md5('gpf|3|A')::uuid) * 100, 2);
  r := r || jsonb_build_object('fx3_boq_cards_by_value_share_phase_A_MUST77.5', x);
  IF x IS DISTINCT FROM 77.5::numeric THEN v_fx_bad := v_fx_bad + 1; END IF;
  x := (SELECT contract_pct FROM site_progress_pct(md5('gpf|3|site')::uuid));
  r := r || jsonb_build_object('fx3_boq_cards_by_value_share_contract_MUST77.5', x);
  IF x IS DISTINCT FROM 77.5::numeric THEN v_fx_bad := v_fx_bad + 1; END IF;
  x := (SELECT total_pct FROM site_progress_pct(md5('gpf|3|site')::uuid));
  r := r || jsonb_build_object('fx3_boq_cards_by_value_share_total_MUSTnull', x);
  IF x IS DISTINCT FROM NULL THEN v_fx_bad := v_fx_bad + 1; END IF;
  -- fixture 4: unpriced card takes the mean value
  INSERT INTO sites (id, tenant_id, site_number, name, contract_value) VALUES (md5('gpf|4|site')::uuid, v_tenant, 'GT-PF-04', 'progress fixture: unpriced card takes the mean value', 0);
  PERFORM snapshot_site_plan(md5('gpf|4|site')::uuid, 'progress fixture', true, 'system');
  INSERT INTO site_phases (id, tenant_id, site_id, name, sort_order, billing_weight_pct, status, is_vo, is_issue_phase) VALUES (md5('gpf|4|A')::uuid, v_tenant, md5('gpf|4|site')::uuid, 'A', 1, 100, 'in_progress', false, false);
  INSERT INTO quotations (id, tenant_id, client_id, site_id, date, status, quotation_number) VALUES (md5('gpf|4|quotation')::uuid, v_tenant, (SELECT id FROM clients WHERE tenant_id = v_tenant ORDER BY created_at, id LIMIT 1), md5('gpf|4|site')::uuid, current_date, 'draft', 'GT-PF-Q04');
  INSERT INTO quotation_items (id, tenant_id, quotation_id, description, quantity, unit_price, line_total, sort_order) VALUES (md5('gpf|4|qi|L1')::uuid, v_tenant, md5('gpf|4|quotation')::uuid, 'L1', 10, 300, 3000, 1);
  INSERT INTO boq_items (id, tenant_id, site_id, quotation_item_id, code, description, planned_qty, sort_order) VALUES (md5('gpf|4|L1')::uuid, v_tenant, md5('gpf|4|site')::uuid, md5('gpf|4|qi|L1')::uuid, 'L1', 'L1', 10, 1);
  INSERT INTO quotation_items (id, tenant_id, quotation_id, description, quantity, unit_price, line_total, sort_order) VALUES (md5('gpf|4|qi|L2')::uuid, v_tenant, md5('gpf|4|quotation')::uuid, 'L2', 10, 100, 1000, 2);
  INSERT INTO boq_items (id, tenant_id, site_id, quotation_item_id, code, description, planned_qty, sort_order) VALUES (md5('gpf|4|L2')::uuid, v_tenant, md5('gpf|4|site')::uuid, md5('gpf|4|qi|L2')::uuid, 'L2', 'L2', 10, 2);
  INSERT INTO boq_items (id, tenant_id, site_id, quotation_item_id, code, description, planned_qty, sort_order) VALUES (md5('gpf|4|L3')::uuid, v_tenant, md5('gpf|4|site')::uuid, NULL, 'L3', 'L3', 10, 3);
  INSERT INTO phase_tasks (id, tenant_id, site_id, phase_id, subtask_id, parent_task_id, name, sort_order, status, progress_mode, planned_qty, done_qty, boq_item_id, issue_report_id) VALUES (md5('gpf|4|q1')::uuid, v_tenant, md5('gpf|4|site')::uuid, md5('gpf|4|A')::uuid, NULL, NULL, 'q1', 1, 'not_started', 'quantity', 10, 0, md5('gpf|4|L1')::uuid, NULL);
  INSERT INTO phase_tasks (id, tenant_id, site_id, phase_id, subtask_id, parent_task_id, name, sort_order, status, progress_mode, planned_qty, done_qty, boq_item_id, issue_report_id) VALUES (md5('gpf|4|q2')::uuid, v_tenant, md5('gpf|4|site')::uuid, md5('gpf|4|A')::uuid, NULL, NULL, 'q2', 2, 'done', 'quantity', 10, 10, md5('gpf|4|L2')::uuid, NULL);
  INSERT INTO phase_tasks (id, tenant_id, site_id, phase_id, subtask_id, parent_task_id, name, sort_order, status, progress_mode, planned_qty, done_qty, boq_item_id, issue_report_id) VALUES (md5('gpf|4|q3')::uuid, v_tenant, md5('gpf|4|site')::uuid, md5('gpf|4|A')::uuid, NULL, NULL, 'q3', 3, 'in_progress', 'quantity', 10, 3, md5('gpf|4|L3')::uuid, NULL);
  x := (SELECT weight_pts FROM phase_tasks WHERE id = md5('gpf|4|q1')::uuid);
  r := r || jsonb_build_object('fx4_unpriced_card_takes_the_mean_value_pts_q1_MUST50', x);
  IF x IS DISTINCT FROM 50::numeric THEN v_fx_bad := v_fx_bad + 1; END IF;
  x := (SELECT weight_pts FROM phase_tasks WHERE id = md5('gpf|4|q2')::uuid);
  r := r || jsonb_build_object('fx4_unpriced_card_takes_the_mean_value_pts_q2_MUST16.67', x);
  IF x IS DISTINCT FROM 16.67::numeric THEN v_fx_bad := v_fx_bad + 1; END IF;
  x := (SELECT weight_pts FROM phase_tasks WHERE id = md5('gpf|4|q3')::uuid);
  r := r || jsonb_build_object('fx4_unpriced_card_takes_the_mean_value_pts_q3_MUST33.33', x);
  IF x IS DISTINCT FROM 33.33::numeric THEN v_fx_bad := v_fx_bad + 1; END IF;
  x := round(node_progress(md5('gpf|4|A')::uuid) * 100, 2);
  r := r || jsonb_build_object('fx4_unpriced_card_takes_the_mean_value_phase_A_MUST26.67', x);
  IF x IS DISTINCT FROM 26.67::numeric THEN v_fx_bad := v_fx_bad + 1; END IF;
  x := (SELECT contract_pct FROM site_progress_pct(md5('gpf|4|site')::uuid));
  r := r || jsonb_build_object('fx4_unpriced_card_takes_the_mean_value_contract_MUST26.67', x);
  IF x IS DISTINCT FROM 26.67::numeric THEN v_fx_bad := v_fx_bad + 1; END IF;
  x := (SELECT total_pct FROM site_progress_pct(md5('gpf|4|site')::uuid));
  r := r || jsonb_build_object('fx4_unpriced_card_takes_the_mean_value_total_MUSTnull', x);
  IF x IS DISTINCT FROM NULL THEN v_fx_bad := v_fx_bad + 1; END IF;
  -- fixture 5: no priced card equal shares
  INSERT INTO sites (id, tenant_id, site_number, name, contract_value) VALUES (md5('gpf|5|site')::uuid, v_tenant, 'GT-PF-05', 'progress fixture: no priced card equal shares', 0);
  PERFORM snapshot_site_plan(md5('gpf|5|site')::uuid, 'progress fixture', true, 'system');
  INSERT INTO site_phases (id, tenant_id, site_id, name, sort_order, billing_weight_pct, status, is_vo, is_issue_phase) VALUES (md5('gpf|5|A')::uuid, v_tenant, md5('gpf|5|site')::uuid, 'A', 1, 100, 'in_progress', false, false);
  INSERT INTO boq_items (id, tenant_id, site_id, quotation_item_id, code, description, planned_qty, sort_order) VALUES (md5('gpf|5|L1')::uuid, v_tenant, md5('gpf|5|site')::uuid, NULL, 'L1', 'L1', 10, 1);
  INSERT INTO boq_items (id, tenant_id, site_id, quotation_item_id, code, description, planned_qty, sort_order) VALUES (md5('gpf|5|L2')::uuid, v_tenant, md5('gpf|5|site')::uuid, NULL, 'L2', 'L2', 10, 2);
  INSERT INTO boq_items (id, tenant_id, site_id, quotation_item_id, code, description, planned_qty, sort_order) VALUES (md5('gpf|5|L3')::uuid, v_tenant, md5('gpf|5|site')::uuid, NULL, 'L3', 'L3', 10, 3);
  INSERT INTO phase_tasks (id, tenant_id, site_id, phase_id, subtask_id, parent_task_id, name, sort_order, status, progress_mode, planned_qty, done_qty, boq_item_id, issue_report_id) VALUES (md5('gpf|5|q1')::uuid, v_tenant, md5('gpf|5|site')::uuid, md5('gpf|5|A')::uuid, NULL, NULL, 'q1', 1, 'done', 'quantity', 10, 10, md5('gpf|5|L1')::uuid, NULL);
  INSERT INTO phase_tasks (id, tenant_id, site_id, phase_id, subtask_id, parent_task_id, name, sort_order, status, progress_mode, planned_qty, done_qty, boq_item_id, issue_report_id) VALUES (md5('gpf|5|q2')::uuid, v_tenant, md5('gpf|5|site')::uuid, md5('gpf|5|A')::uuid, NULL, NULL, 'q2', 2, 'not_started', 'quantity', 10, 0, md5('gpf|5|L2')::uuid, NULL);
  INSERT INTO phase_tasks (id, tenant_id, site_id, phase_id, subtask_id, parent_task_id, name, sort_order, status, progress_mode, planned_qty, done_qty, boq_item_id, issue_report_id) VALUES (md5('gpf|5|q3')::uuid, v_tenant, md5('gpf|5|site')::uuid, md5('gpf|5|A')::uuid, NULL, NULL, 'q3', 3, 'not_started', 'quantity', 10, 0, md5('gpf|5|L3')::uuid, NULL);
  x := (SELECT weight_pts FROM phase_tasks WHERE id = md5('gpf|5|q1')::uuid);
  r := r || jsonb_build_object('fx5_no_priced_card_equal_shares_pts_q1_MUST33.34', x);
  IF x IS DISTINCT FROM 33.34::numeric THEN v_fx_bad := v_fx_bad + 1; END IF;
  x := (SELECT weight_pts FROM phase_tasks WHERE id = md5('gpf|5|q2')::uuid);
  r := r || jsonb_build_object('fx5_no_priced_card_equal_shares_pts_q2_MUST33.33', x);
  IF x IS DISTINCT FROM 33.33::numeric THEN v_fx_bad := v_fx_bad + 1; END IF;
  x := (SELECT weight_pts FROM phase_tasks WHERE id = md5('gpf|5|q3')::uuid);
  r := r || jsonb_build_object('fx5_no_priced_card_equal_shares_pts_q3_MUST33.33', x);
  IF x IS DISTINCT FROM 33.33::numeric THEN v_fx_bad := v_fx_bad + 1; END IF;
  x := round(node_progress(md5('gpf|5|A')::uuid) * 100, 2);
  r := r || jsonb_build_object('fx5_no_priced_card_equal_shares_phase_A_MUST33.34', x);
  IF x IS DISTINCT FROM 33.34::numeric THEN v_fx_bad := v_fx_bad + 1; END IF;
  x := (SELECT contract_pct FROM site_progress_pct(md5('gpf|5|site')::uuid));
  r := r || jsonb_build_object('fx5_no_priced_card_equal_shares_contract_MUST33.34', x);
  IF x IS DISTINCT FROM 33.34::numeric THEN v_fx_bad := v_fx_bad + 1; END IF;
  x := (SELECT total_pct FROM site_progress_pct(md5('gpf|5|site')::uuid));
  r := r || jsonb_build_object('fx5_no_priced_card_equal_shares_total_MUSTnull', x);
  IF x IS DISTINCT FROM NULL THEN v_fx_bad := v_fx_bad + 1; END IF;
  -- fixture 6: boq and general cards general ignored
  INSERT INTO sites (id, tenant_id, site_number, name, contract_value) VALUES (md5('gpf|6|site')::uuid, v_tenant, 'GT-PF-06', 'progress fixture: boq and general cards general ignored', 0);
  PERFORM snapshot_site_plan(md5('gpf|6|site')::uuid, 'progress fixture', true, 'system');
  INSERT INTO site_phases (id, tenant_id, site_id, name, sort_order, billing_weight_pct, status, is_vo, is_issue_phase) VALUES (md5('gpf|6|A')::uuid, v_tenant, md5('gpf|6|site')::uuid, 'A', 1, 100, 'in_progress', false, false);
  INSERT INTO quotations (id, tenant_id, client_id, site_id, date, status, quotation_number) VALUES (md5('gpf|6|quotation')::uuid, v_tenant, (SELECT id FROM clients WHERE tenant_id = v_tenant ORDER BY created_at, id LIMIT 1), md5('gpf|6|site')::uuid, current_date, 'draft', 'GT-PF-Q06');
  INSERT INTO quotation_items (id, tenant_id, quotation_id, description, quantity, unit_price, line_total, sort_order) VALUES (md5('gpf|6|qi|L1')::uuid, v_tenant, md5('gpf|6|quotation')::uuid, 'L1', 10, 200, 2000, 1);
  INSERT INTO boq_items (id, tenant_id, site_id, quotation_item_id, code, description, planned_qty, sort_order) VALUES (md5('gpf|6|L1')::uuid, v_tenant, md5('gpf|6|site')::uuid, md5('gpf|6|qi|L1')::uuid, 'L1', 'L1', 10, 1);
  INSERT INTO quotation_items (id, tenant_id, quotation_id, description, quantity, unit_price, line_total, sort_order) VALUES (md5('gpf|6|qi|L2')::uuid, v_tenant, md5('gpf|6|quotation')::uuid, 'L2', 10, 200, 2000, 2);
  INSERT INTO boq_items (id, tenant_id, site_id, quotation_item_id, code, description, planned_qty, sort_order) VALUES (md5('gpf|6|L2')::uuid, v_tenant, md5('gpf|6|site')::uuid, md5('gpf|6|qi|L2')::uuid, 'L2', 'L2', 10, 2);
  INSERT INTO phase_tasks (id, tenant_id, site_id, phase_id, subtask_id, parent_task_id, name, sort_order, status, progress_mode, planned_qty, done_qty, boq_item_id, issue_report_id) VALUES (md5('gpf|6|q1')::uuid, v_tenant, md5('gpf|6|site')::uuid, md5('gpf|6|A')::uuid, NULL, NULL, 'q1', 1, 'done', 'quantity', 10, 10, md5('gpf|6|L1')::uuid, NULL);
  INSERT INTO phase_tasks (id, tenant_id, site_id, phase_id, subtask_id, parent_task_id, name, sort_order, status, progress_mode, planned_qty, done_qty, boq_item_id, issue_report_id) VALUES (md5('gpf|6|q2')::uuid, v_tenant, md5('gpf|6|site')::uuid, md5('gpf|6|A')::uuid, NULL, NULL, 'q2', 2, 'not_started', 'quantity', 10, 0, md5('gpf|6|L2')::uuid, NULL);
  INSERT INTO phase_tasks (id, tenant_id, site_id, phase_id, subtask_id, parent_task_id, name, sort_order, status, progress_mode, planned_qty, done_qty, boq_item_id, issue_report_id) VALUES (md5('gpf|6|g1')::uuid, v_tenant, md5('gpf|6|site')::uuid, md5('gpf|6|A')::uuid, NULL, NULL, 'g1', 3, 'not_started', 'status', NULL, 0, NULL, NULL);
  INSERT INTO phase_tasks (id, tenant_id, site_id, phase_id, subtask_id, parent_task_id, name, sort_order, status, progress_mode, planned_qty, done_qty, boq_item_id, issue_report_id) VALUES (md5('gpf|6|g2')::uuid, v_tenant, md5('gpf|6|site')::uuid, md5('gpf|6|A')::uuid, NULL, NULL, 'g2', 4, 'done', 'status', NULL, 0, NULL, NULL);
  x := (SELECT weight_pts FROM phase_tasks WHERE id = md5('gpf|6|q1')::uuid);
  r := r || jsonb_build_object('fx6_boq_and_general_cards_general_ignored_pts_q1_MUST50', x);
  IF x IS DISTINCT FROM 50::numeric THEN v_fx_bad := v_fx_bad + 1; END IF;
  x := (SELECT weight_pts FROM phase_tasks WHERE id = md5('gpf|6|q2')::uuid);
  r := r || jsonb_build_object('fx6_boq_and_general_cards_general_ignored_pts_q2_MUST50', x);
  IF x IS DISTINCT FROM 50::numeric THEN v_fx_bad := v_fx_bad + 1; END IF;
  x := round(node_progress(md5('gpf|6|A')::uuid) * 100, 2);
  r := r || jsonb_build_object('fx6_boq_and_general_cards_general_ignored_phase_A_MUST50', x);
  IF x IS DISTINCT FROM 50::numeric THEN v_fx_bad := v_fx_bad + 1; END IF;
  x := (SELECT contract_pct FROM site_progress_pct(md5('gpf|6|site')::uuid));
  r := r || jsonb_build_object('fx6_boq_and_general_cards_general_ignored_contract_MUST50', x);
  IF x IS DISTINCT FROM 50::numeric THEN v_fx_bad := v_fx_bad + 1; END IF;
  x := (SELECT total_pct FROM site_progress_pct(md5('gpf|6|site')::uuid));
  r := r || jsonb_build_object('fx6_boq_and_general_cards_general_ignored_total_MUSTnull', x);
  IF x IS DISTINCT FROM NULL THEN v_fx_bad := v_fx_bad + 1; END IF;
  -- fixture 7: split general parent counts by its status
  INSERT INTO sites (id, tenant_id, site_number, name, contract_value) VALUES (md5('gpf|7|site')::uuid, v_tenant, 'GT-PF-07', 'progress fixture: split general parent counts by its status', 0);
  PERFORM snapshot_site_plan(md5('gpf|7|site')::uuid, 'progress fixture', true, 'system');
  INSERT INTO site_phases (id, tenant_id, site_id, name, sort_order, billing_weight_pct, status, is_vo, is_issue_phase) VALUES (md5('gpf|7|A')::uuid, v_tenant, md5('gpf|7|site')::uuid, 'A', 1, 100, 'in_progress', false, false);
  INSERT INTO phase_tasks (id, tenant_id, site_id, phase_id, subtask_id, parent_task_id, name, sort_order, status, progress_mode, planned_qty, done_qty, boq_item_id, issue_report_id) VALUES (md5('gpf|7|p')::uuid, v_tenant, md5('gpf|7|site')::uuid, md5('gpf|7|A')::uuid, NULL, NULL, 'p', 1, 'in_progress', 'status', NULL, 0, NULL, NULL);
  INSERT INTO phase_tasks (id, tenant_id, site_id, phase_id, subtask_id, parent_task_id, name, sort_order, status, progress_mode, planned_qty, done_qty, boq_item_id, issue_report_id) VALUES (md5('gpf|7|p1')::uuid, v_tenant, md5('gpf|7|site')::uuid, md5('gpf|7|A')::uuid, NULL, md5('gpf|7|p')::uuid, 'p1', 2, 'done', 'status', NULL, 0, NULL, NULL);
  INSERT INTO phase_tasks (id, tenant_id, site_id, phase_id, subtask_id, parent_task_id, name, sort_order, status, progress_mode, planned_qty, done_qty, boq_item_id, issue_report_id) VALUES (md5('gpf|7|p2')::uuid, v_tenant, md5('gpf|7|site')::uuid, md5('gpf|7|A')::uuid, NULL, md5('gpf|7|p')::uuid, 'p2', 3, 'not_started', 'status', NULL, 0, NULL, NULL);
  INSERT INTO phase_tasks (id, tenant_id, site_id, phase_id, subtask_id, parent_task_id, name, sort_order, status, progress_mode, planned_qty, done_qty, boq_item_id, issue_report_id) VALUES (md5('gpf|7|a2')::uuid, v_tenant, md5('gpf|7|site')::uuid, md5('gpf|7|A')::uuid, NULL, NULL, 'a2', 4, 'done', 'status', NULL, 0, NULL, NULL);
  x := round(node_progress(md5('gpf|7|A')::uuid) * 100, 2);
  r := r || jsonb_build_object('fx7_split_general_parent_counts_by_its_status_phase_A_MUST0', x);
  IF x IS DISTINCT FROM 0::numeric THEN v_fx_bad := v_fx_bad + 1; END IF;
  x := (SELECT contract_pct FROM site_progress_pct(md5('gpf|7|site')::uuid));
  r := r || jsonb_build_object('fx7_split_general_parent_counts_by_its_status_contract_MUST0', x);
  IF x IS DISTINCT FROM 0::numeric THEN v_fx_bad := v_fx_bad + 1; END IF;
  x := (SELECT total_pct FROM site_progress_pct(md5('gpf|7|site')::uuid));
  r := r || jsonb_build_object('fx7_split_general_parent_counts_by_its_status_total_MUSTnull', x);
  IF x IS DISTINCT FROM NULL THEN v_fx_bad := v_fx_bad + 1; END IF;
  -- fixture 8: no cards uses status
  INSERT INTO sites (id, tenant_id, site_number, name, contract_value) VALUES (md5('gpf|8|site')::uuid, v_tenant, 'GT-PF-08', 'progress fixture: no cards uses status', 0);
  PERFORM snapshot_site_plan(md5('gpf|8|site')::uuid, 'progress fixture', true, 'system');
  INSERT INTO site_phases (id, tenant_id, site_id, name, sort_order, billing_weight_pct, status, is_vo, is_issue_phase) VALUES (md5('gpf|8|A')::uuid, v_tenant, md5('gpf|8|site')::uuid, 'A', 1, 30, 'done', false, false);
  INSERT INTO site_phases (id, tenant_id, site_id, name, sort_order, billing_weight_pct, status, is_vo, is_issue_phase) VALUES (md5('gpf|8|B')::uuid, v_tenant, md5('gpf|8|site')::uuid, 'B', 2, 70, 'in_progress', false, false);
  x := round(node_progress(md5('gpf|8|A')::uuid) * 100, 2);
  r := r || jsonb_build_object('fx8_no_cards_uses_status_phase_A_MUST100', x);
  IF x IS DISTINCT FROM 100::numeric THEN v_fx_bad := v_fx_bad + 1; END IF;
  x := round(node_progress(md5('gpf|8|B')::uuid) * 100, 2);
  r := r || jsonb_build_object('fx8_no_cards_uses_status_phase_B_MUST0', x);
  IF x IS DISTINCT FROM 0::numeric THEN v_fx_bad := v_fx_bad + 1; END IF;
  x := (SELECT contract_pct FROM site_progress_pct(md5('gpf|8|site')::uuid));
  r := r || jsonb_build_object('fx8_no_cards_uses_status_contract_MUST30', x);
  IF x IS DISTINCT FROM 30::numeric THEN v_fx_bad := v_fx_bad + 1; END IF;
  x := (SELECT total_pct FROM site_progress_pct(md5('gpf|8|site')::uuid));
  r := r || jsonb_build_object('fx8_no_cards_uses_status_total_MUSTnull', x);
  IF x IS DISTINCT FROM NULL THEN v_fx_bad := v_fx_bad + 1; END IF;
  -- fixture 9: vo two numbers
  INSERT INTO sites (id, tenant_id, site_number, name, contract_value) VALUES (md5('gpf|9|site')::uuid, v_tenant, 'GT-PF-09', 'progress fixture: vo two numbers', 900000);
  PERFORM snapshot_site_plan(md5('gpf|9|site')::uuid, 'progress fixture', true, 'system');
  INSERT INTO site_phases (id, tenant_id, site_id, name, sort_order, billing_weight_pct, status, is_vo, is_issue_phase) VALUES (md5('gpf|9|A')::uuid, v_tenant, md5('gpf|9|site')::uuid, 'A', 1, 100, 'done', false, false);
  INSERT INTO site_phases (id, tenant_id, site_id, name, sort_order, billing_weight_pct, status, is_vo, is_issue_phase) VALUES (md5('gpf|9|B')::uuid, v_tenant, md5('gpf|9|site')::uuid, 'B', 2, 0, 'not_started', true, false);
  INSERT INTO phase_vo_values (phase_id, tenant_id, vo_value) VALUES (md5('gpf|9|B')::uuid, v_tenant, 100000);
  INSERT INTO phase_tasks (id, tenant_id, site_id, phase_id, subtask_id, parent_task_id, name, sort_order, status, progress_mode, planned_qty, done_qty, boq_item_id, issue_report_id) VALUES (md5('gpf|9|a1')::uuid, v_tenant, md5('gpf|9|site')::uuid, md5('gpf|9|A')::uuid, NULL, NULL, 'a1', 1, 'done', 'status', NULL, 0, NULL, NULL);
  INSERT INTO phase_tasks (id, tenant_id, site_id, phase_id, subtask_id, parent_task_id, name, sort_order, status, progress_mode, planned_qty, done_qty, boq_item_id, issue_report_id) VALUES (md5('gpf|9|b1')::uuid, v_tenant, md5('gpf|9|site')::uuid, md5('gpf|9|B')::uuid, NULL, NULL, 'b1', 2, 'not_started', 'status', NULL, 0, NULL, NULL);
  x := round(node_progress(md5('gpf|9|A')::uuid) * 100, 2);
  r := r || jsonb_build_object('fx9_vo_two_numbers_phase_A_MUST100', x);
  IF x IS DISTINCT FROM 100::numeric THEN v_fx_bad := v_fx_bad + 1; END IF;
  x := round(node_progress(md5('gpf|9|B')::uuid) * 100, 2);
  r := r || jsonb_build_object('fx9_vo_two_numbers_phase_B_MUST0', x);
  IF x IS DISTINCT FROM 0::numeric THEN v_fx_bad := v_fx_bad + 1; END IF;
  x := (SELECT contract_pct FROM site_progress_pct(md5('gpf|9|site')::uuid));
  r := r || jsonb_build_object('fx9_vo_two_numbers_contract_MUST100', x);
  IF x IS DISTINCT FROM 100::numeric THEN v_fx_bad := v_fx_bad + 1; END IF;
  x := (SELECT total_pct FROM site_progress_pct(md5('gpf|9|site')::uuid));
  r := r || jsonb_build_object('fx9_vo_two_numbers_total_MUST90', x);
  IF x IS DISTINCT FROM 90::numeric THEN v_fx_bad := v_fx_bad + 1; END IF;
  -- fixture 10: vo without contract value
  INSERT INTO sites (id, tenant_id, site_number, name, contract_value) VALUES (md5('gpf|10|site')::uuid, v_tenant, 'GT-PF-10', 'progress fixture: vo without contract value', 0);
  PERFORM snapshot_site_plan(md5('gpf|10|site')::uuid, 'progress fixture', true, 'system');
  INSERT INTO site_phases (id, tenant_id, site_id, name, sort_order, billing_weight_pct, status, is_vo, is_issue_phase) VALUES (md5('gpf|10|A')::uuid, v_tenant, md5('gpf|10|site')::uuid, 'A', 1, 100, 'done', false, false);
  INSERT INTO site_phases (id, tenant_id, site_id, name, sort_order, billing_weight_pct, status, is_vo, is_issue_phase) VALUES (md5('gpf|10|B')::uuid, v_tenant, md5('gpf|10|site')::uuid, 'B', 2, 0, 'not_started', true, false);
  INSERT INTO phase_vo_values (phase_id, tenant_id, vo_value) VALUES (md5('gpf|10|B')::uuid, v_tenant, 100000);
  INSERT INTO phase_tasks (id, tenant_id, site_id, phase_id, subtask_id, parent_task_id, name, sort_order, status, progress_mode, planned_qty, done_qty, boq_item_id, issue_report_id) VALUES (md5('gpf|10|a1')::uuid, v_tenant, md5('gpf|10|site')::uuid, md5('gpf|10|A')::uuid, NULL, NULL, 'a1', 1, 'done', 'status', NULL, 0, NULL, NULL);
  INSERT INTO phase_tasks (id, tenant_id, site_id, phase_id, subtask_id, parent_task_id, name, sort_order, status, progress_mode, planned_qty, done_qty, boq_item_id, issue_report_id) VALUES (md5('gpf|10|b1')::uuid, v_tenant, md5('gpf|10|site')::uuid, md5('gpf|10|B')::uuid, NULL, NULL, 'b1', 2, 'not_started', 'status', NULL, 0, NULL, NULL);
  x := round(node_progress(md5('gpf|10|A')::uuid) * 100, 2);
  r := r || jsonb_build_object('fx10_vo_without_contract_value_phase_A_MUST100', x);
  IF x IS DISTINCT FROM 100::numeric THEN v_fx_bad := v_fx_bad + 1; END IF;
  x := round(node_progress(md5('gpf|10|B')::uuid) * 100, 2);
  r := r || jsonb_build_object('fx10_vo_without_contract_value_phase_B_MUST0', x);
  IF x IS DISTINCT FROM 0::numeric THEN v_fx_bad := v_fx_bad + 1; END IF;
  x := (SELECT contract_pct FROM site_progress_pct(md5('gpf|10|site')::uuid));
  r := r || jsonb_build_object('fx10_vo_without_contract_value_contract_MUST100', x);
  IF x IS DISTINCT FROM 100::numeric THEN v_fx_bad := v_fx_bad + 1; END IF;
  x := (SELECT total_pct FROM site_progress_pct(md5('gpf|10|site')::uuid));
  r := r || jsonb_build_object('fx10_vo_without_contract_value_total_MUSTnull', x);
  IF x IS DISTINCT FROM NULL THEN v_fx_bad := v_fx_bad + 1; END IF;
  -- fixture 11: issue excluded
  INSERT INTO sites (id, tenant_id, site_number, name, contract_value) VALUES (md5('gpf|11|site')::uuid, v_tenant, 'GT-PF-11', 'progress fixture: issue excluded', 0);
  PERFORM snapshot_site_plan(md5('gpf|11|site')::uuid, 'progress fixture', true, 'system');
  INSERT INTO site_phases (id, tenant_id, site_id, name, sort_order, billing_weight_pct, status, is_vo, is_issue_phase) VALUES (md5('gpf|11|A')::uuid, v_tenant, md5('gpf|11|site')::uuid, 'A', 1, 100, 'done', false, false);
  INSERT INTO site_phases (id, tenant_id, site_id, name, sort_order, billing_weight_pct, status, is_vo, is_issue_phase) VALUES (md5('gpf|11|I')::uuid, v_tenant, md5('gpf|11|site')::uuid, 'I', 2, 0, 'not_started', false, true);
  INSERT INTO line_issue_reports (id, tenant_id, site_id, message) VALUES (md5('gpf|11|R1')::uuid, v_tenant, md5('gpf|11|site')::uuid, 'progress fixture issue R1');
  INSERT INTO phase_tasks (id, tenant_id, site_id, phase_id, subtask_id, parent_task_id, name, sort_order, status, progress_mode, planned_qty, done_qty, boq_item_id, issue_report_id) VALUES (md5('gpf|11|a1')::uuid, v_tenant, md5('gpf|11|site')::uuid, md5('gpf|11|A')::uuid, NULL, NULL, 'a1', 1, 'done', 'status', NULL, 0, NULL, NULL);
  INSERT INTO phase_tasks (id, tenant_id, site_id, phase_id, subtask_id, parent_task_id, name, sort_order, status, progress_mode, planned_qty, done_qty, boq_item_id, issue_report_id) VALUES (md5('gpf|11|i1')::uuid, v_tenant, md5('gpf|11|site')::uuid, md5('gpf|11|I')::uuid, NULL, NULL, 'i1', 2, 'not_started', 'status', NULL, 0, NULL, md5('gpf|11|R1')::uuid);
  x := round(node_progress(md5('gpf|11|A')::uuid) * 100, 2);
  r := r || jsonb_build_object('fx11_issue_excluded_phase_A_MUST100', x);
  IF x IS DISTINCT FROM 100::numeric THEN v_fx_bad := v_fx_bad + 1; END IF;
  x := (SELECT contract_pct FROM site_progress_pct(md5('gpf|11|site')::uuid));
  r := r || jsonb_build_object('fx11_issue_excluded_contract_MUST100', x);
  IF x IS DISTINCT FROM 100::numeric THEN v_fx_bad := v_fx_bad + 1; END IF;
  x := (SELECT total_pct FROM site_progress_pct(md5('gpf|11|site')::uuid));
  r := r || jsonb_build_object('fx11_issue_excluded_total_MUSTnull', x);
  IF x IS DISTINCT FROM NULL THEN v_fx_bad := v_fx_bad + 1; END IF;
  -- fixture 12: issue card in a boq node ignored
  INSERT INTO sites (id, tenant_id, site_number, name, contract_value) VALUES (md5('gpf|12|site')::uuid, v_tenant, 'GT-PF-12', 'progress fixture: issue card in a boq node ignored', 0);
  PERFORM snapshot_site_plan(md5('gpf|12|site')::uuid, 'progress fixture', true, 'system');
  INSERT INTO site_phases (id, tenant_id, site_id, name, sort_order, billing_weight_pct, status, is_vo, is_issue_phase) VALUES (md5('gpf|12|A')::uuid, v_tenant, md5('gpf|12|site')::uuid, 'A', 1, 100, 'in_progress', false, false);
  INSERT INTO boq_items (id, tenant_id, site_id, quotation_item_id, code, description, planned_qty, sort_order) VALUES (md5('gpf|12|L1')::uuid, v_tenant, md5('gpf|12|site')::uuid, NULL, 'L1', 'L1', 10, 1);
  INSERT INTO line_issue_reports (id, tenant_id, site_id, message) VALUES (md5('gpf|12|R1')::uuid, v_tenant, md5('gpf|12|site')::uuid, 'progress fixture issue R1');
  INSERT INTO phase_tasks (id, tenant_id, site_id, phase_id, subtask_id, parent_task_id, name, sort_order, status, progress_mode, planned_qty, done_qty, boq_item_id, issue_report_id) VALUES (md5('gpf|12|q1')::uuid, v_tenant, md5('gpf|12|site')::uuid, md5('gpf|12|A')::uuid, NULL, NULL, 'q1', 1, 'in_progress', 'quantity', 10, 5, md5('gpf|12|L1')::uuid, NULL);
  INSERT INTO phase_tasks (id, tenant_id, site_id, phase_id, subtask_id, parent_task_id, name, sort_order, status, progress_mode, planned_qty, done_qty, boq_item_id, issue_report_id) VALUES (md5('gpf|12|i1')::uuid, v_tenant, md5('gpf|12|site')::uuid, md5('gpf|12|A')::uuid, NULL, NULL, 'i1', 2, 'done', 'status', NULL, 0, NULL, md5('gpf|12|R1')::uuid);
  x := (SELECT weight_pts FROM phase_tasks WHERE id = md5('gpf|12|q1')::uuid);
  r := r || jsonb_build_object('fx12_issue_card_in_a_boq_node_ignored_pts_q1_MUST100', x);
  IF x IS DISTINCT FROM 100::numeric THEN v_fx_bad := v_fx_bad + 1; END IF;
  x := round(node_progress(md5('gpf|12|A')::uuid) * 100, 2);
  r := r || jsonb_build_object('fx12_issue_card_in_a_boq_node_ignored_phase_A_MUST50', x);
  IF x IS DISTINCT FROM 50::numeric THEN v_fx_bad := v_fx_bad + 1; END IF;
  x := (SELECT contract_pct FROM site_progress_pct(md5('gpf|12|site')::uuid));
  r := r || jsonb_build_object('fx12_issue_card_in_a_boq_node_ignored_contract_MUST50', x);
  IF x IS DISTINCT FROM 50::numeric THEN v_fx_bad := v_fx_bad + 1; END IF;
  x := (SELECT total_pct FROM site_progress_pct(md5('gpf|12|site')::uuid));
  r := r || jsonb_build_object('fx12_issue_card_in_a_boq_node_ignored_total_MUSTnull', x);
  IF x IS DISTINCT FROM NULL THEN v_fx_bad := v_fx_bad + 1; END IF;
  -- fixture 13: subtasks weighted
  INSERT INTO sites (id, tenant_id, site_number, name, contract_value) VALUES (md5('gpf|13|site')::uuid, v_tenant, 'GT-PF-13', 'progress fixture: subtasks weighted', 0);
  PERFORM snapshot_site_plan(md5('gpf|13|site')::uuid, 'progress fixture', true, 'system');
  INSERT INTO site_phases (id, tenant_id, site_id, name, sort_order, billing_weight_pct, status, is_vo, is_issue_phase) VALUES (md5('gpf|13|A')::uuid, v_tenant, md5('gpf|13|site')::uuid, 'A', 1, 100, 'in_progress', false, false);
  INSERT INTO phase_subtasks (id, tenant_id, site_id, phase_id, parent_subtask_id, name, sort_order, billing_weight_pct, status) VALUES (md5('gpf|13|S1')::uuid, v_tenant, md5('gpf|13|site')::uuid, md5('gpf|13|A')::uuid, NULL, 'S1', 1, 25, 'done');
  INSERT INTO phase_subtasks (id, tenant_id, site_id, phase_id, parent_subtask_id, name, sort_order, billing_weight_pct, status) VALUES (md5('gpf|13|S2')::uuid, v_tenant, md5('gpf|13|site')::uuid, md5('gpf|13|A')::uuid, NULL, 'S2', 2, 75, 'in_progress');
  INSERT INTO quotations (id, tenant_id, client_id, site_id, date, status, quotation_number) VALUES (md5('gpf|13|quotation')::uuid, v_tenant, (SELECT id FROM clients WHERE tenant_id = v_tenant ORDER BY created_at, id LIMIT 1), md5('gpf|13|site')::uuid, current_date, 'draft', 'GT-PF-Q13');
  INSERT INTO quotation_items (id, tenant_id, quotation_id, description, quantity, unit_price, line_total, sort_order) VALUES (md5('gpf|13|qi|L1')::uuid, v_tenant, md5('gpf|13|quotation')::uuid, 'L1', 10, 50, 500, 1);
  INSERT INTO boq_items (id, tenant_id, site_id, quotation_item_id, code, description, planned_qty, sort_order) VALUES (md5('gpf|13|L1')::uuid, v_tenant, md5('gpf|13|site')::uuid, md5('gpf|13|qi|L1')::uuid, 'L1', 'L1', 10, 1);
  INSERT INTO phase_tasks (id, tenant_id, site_id, phase_id, subtask_id, parent_task_id, name, sort_order, status, progress_mode, planned_qty, done_qty, boq_item_id, issue_report_id) VALUES (md5('gpf|13|s2a')::uuid, v_tenant, md5('gpf|13|site')::uuid, md5('gpf|13|A')::uuid, md5('gpf|13|S2')::uuid, NULL, 's2a', 1, 'in_progress', 'quantity', 10, 4, md5('gpf|13|L1')::uuid, NULL);
  INSERT INTO phase_tasks (id, tenant_id, site_id, phase_id, subtask_id, parent_task_id, name, sort_order, status, progress_mode, planned_qty, done_qty, boq_item_id, issue_report_id) VALUES (md5('gpf|13|s2g')::uuid, v_tenant, md5('gpf|13|site')::uuid, md5('gpf|13|A')::uuid, md5('gpf|13|S2')::uuid, NULL, 's2g', 2, 'done', 'status', NULL, 0, NULL, NULL);
  x := (SELECT weight_pts FROM phase_tasks WHERE id = md5('gpf|13|s2a')::uuid);
  r := r || jsonb_build_object('fx13_subtasks_weighted_pts_s2a_MUST100', x);
  IF x IS DISTINCT FROM 100::numeric THEN v_fx_bad := v_fx_bad + 1; END IF;
  x := round(node_progress(md5('gpf|13|A')::uuid) * 100, 2);
  r := r || jsonb_build_object('fx13_subtasks_weighted_phase_A_MUST55', x);
  IF x IS DISTINCT FROM 55::numeric THEN v_fx_bad := v_fx_bad + 1; END IF;
  x := (SELECT contract_pct FROM site_progress_pct(md5('gpf|13|site')::uuid));
  r := r || jsonb_build_object('fx13_subtasks_weighted_contract_MUST55', x);
  IF x IS DISTINCT FROM 55::numeric THEN v_fx_bad := v_fx_bad + 1; END IF;
  x := (SELECT total_pct FROM site_progress_pct(md5('gpf|13|site')::uuid));
  r := r || jsonb_build_object('fx13_subtasks_weighted_total_MUSTnull', x);
  IF x IS DISTINCT FROM NULL THEN v_fx_bad := v_fx_bad + 1; END IF;
  -- fixture 14: all contract weights zero uses mean
  INSERT INTO sites (id, tenant_id, site_number, name, contract_value) VALUES (md5('gpf|14|site')::uuid, v_tenant, 'GT-PF-14', 'progress fixture: all contract weights zero uses mean', 0);
  PERFORM snapshot_site_plan(md5('gpf|14|site')::uuid, 'progress fixture', true, 'system');
  INSERT INTO site_phases (id, tenant_id, site_id, name, sort_order, billing_weight_pct, status, is_vo, is_issue_phase) VALUES (md5('gpf|14|A')::uuid, v_tenant, md5('gpf|14|site')::uuid, 'A', 1, 0, 'done', false, false);
  INSERT INTO site_phases (id, tenant_id, site_id, name, sort_order, billing_weight_pct, status, is_vo, is_issue_phase) VALUES (md5('gpf|14|B')::uuid, v_tenant, md5('gpf|14|site')::uuid, 'B', 2, 0, 'not_started', false, false);
  x := round(node_progress(md5('gpf|14|A')::uuid) * 100, 2);
  r := r || jsonb_build_object('fx14_all_contract_weights_zero_uses_mean_phase_A_MUST100', x);
  IF x IS DISTINCT FROM 100::numeric THEN v_fx_bad := v_fx_bad + 1; END IF;
  x := round(node_progress(md5('gpf|14|B')::uuid) * 100, 2);
  r := r || jsonb_build_object('fx14_all_contract_weights_zero_uses_mean_phase_B_MUST0', x);
  IF x IS DISTINCT FROM 0::numeric THEN v_fx_bad := v_fx_bad + 1; END IF;
  x := (SELECT contract_pct FROM site_progress_pct(md5('gpf|14|site')::uuid));
  r := r || jsonb_build_object('fx14_all_contract_weights_zero_uses_mean_contract_MUST50', x);
  IF x IS DISTINCT FROM 50::numeric THEN v_fx_bad := v_fx_bad + 1; END IF;
  x := (SELECT total_pct FROM site_progress_pct(md5('gpf|14|site')::uuid));
  r := r || jsonb_build_object('fx14_all_contract_weights_zero_uses_mean_total_MUSTnull', x);
  IF x IS DISTINCT FROM NULL THEN v_fx_bad := v_fx_bad + 1; END IF;
  -- fixture 15: only an issue phase
  INSERT INTO sites (id, tenant_id, site_number, name, contract_value) VALUES (md5('gpf|15|site')::uuid, v_tenant, 'GT-PF-15', 'progress fixture: only an issue phase', 900000);
  PERFORM snapshot_site_plan(md5('gpf|15|site')::uuid, 'progress fixture', true, 'system');
  INSERT INTO site_phases (id, tenant_id, site_id, name, sort_order, billing_weight_pct, status, is_vo, is_issue_phase) VALUES (md5('gpf|15|I')::uuid, v_tenant, md5('gpf|15|site')::uuid, 'I', 1, 0, 'not_started', false, true);
  INSERT INTO line_issue_reports (id, tenant_id, site_id, message) VALUES (md5('gpf|15|R1')::uuid, v_tenant, md5('gpf|15|site')::uuid, 'progress fixture issue R1');
  INSERT INTO phase_tasks (id, tenant_id, site_id, phase_id, subtask_id, parent_task_id, name, sort_order, status, progress_mode, planned_qty, done_qty, boq_item_id, issue_report_id) VALUES (md5('gpf|15|i1')::uuid, v_tenant, md5('gpf|15|site')::uuid, md5('gpf|15|I')::uuid, NULL, NULL, 'i1', 1, 'not_started', 'status', NULL, 0, NULL, md5('gpf|15|R1')::uuid);
  x := (SELECT contract_pct FROM site_progress_pct(md5('gpf|15|site')::uuid));
  r := r || jsonb_build_object('fx15_only_an_issue_phase_contract_MUST0', x);
  IF x IS DISTINCT FROM 0::numeric THEN v_fx_bad := v_fx_bad + 1; END IF;
  x := (SELECT total_pct FROM site_progress_pct(md5('gpf|15|site')::uuid));
  r := r || jsonb_build_object('fx15_only_an_issue_phase_total_MUSTnull', x);
  IF x IS DISTINCT FROM NULL THEN v_fx_bad := v_fx_bad + 1; END IF;
  -- fixture 16: vo without a vo value counts zero
  INSERT INTO sites (id, tenant_id, site_number, name, contract_value) VALUES (md5('gpf|16|site')::uuid, v_tenant, 'GT-PF-16', 'progress fixture: vo without a vo value counts zero', 900000);
  PERFORM snapshot_site_plan(md5('gpf|16|site')::uuid, 'progress fixture', true, 'system');
  INSERT INTO site_phases (id, tenant_id, site_id, name, sort_order, billing_weight_pct, status, is_vo, is_issue_phase) VALUES (md5('gpf|16|A')::uuid, v_tenant, md5('gpf|16|site')::uuid, 'A', 1, 100, 'in_progress', false, false);
  INSERT INTO site_phases (id, tenant_id, site_id, name, sort_order, billing_weight_pct, status, is_vo, is_issue_phase) VALUES (md5('gpf|16|C')::uuid, v_tenant, md5('gpf|16|site')::uuid, 'C', 2, 0, 'done', true, false);
  INSERT INTO phase_tasks (id, tenant_id, site_id, phase_id, subtask_id, parent_task_id, name, sort_order, status, progress_mode, planned_qty, done_qty, boq_item_id, issue_report_id) VALUES (md5('gpf|16|a1')::uuid, v_tenant, md5('gpf|16|site')::uuid, md5('gpf|16|A')::uuid, NULL, NULL, 'a1', 1, 'not_started', 'status', NULL, 0, NULL, NULL);
  INSERT INTO phase_tasks (id, tenant_id, site_id, phase_id, subtask_id, parent_task_id, name, sort_order, status, progress_mode, planned_qty, done_qty, boq_item_id, issue_report_id) VALUES (md5('gpf|16|c1')::uuid, v_tenant, md5('gpf|16|site')::uuid, md5('gpf|16|C')::uuid, NULL, NULL, 'c1', 2, 'done', 'status', NULL, 0, NULL, NULL);
  x := round(node_progress(md5('gpf|16|A')::uuid) * 100, 2);
  r := r || jsonb_build_object('fx16_vo_without_a_vo_value_counts_zero_phase_A_MUST0', x);
  IF x IS DISTINCT FROM 0::numeric THEN v_fx_bad := v_fx_bad + 1; END IF;
  x := round(node_progress(md5('gpf|16|C')::uuid) * 100, 2);
  r := r || jsonb_build_object('fx16_vo_without_a_vo_value_counts_zero_phase_C_MUST100', x);
  IF x IS DISTINCT FROM 100::numeric THEN v_fx_bad := v_fx_bad + 1; END IF;
  x := (SELECT contract_pct FROM site_progress_pct(md5('gpf|16|site')::uuid));
  r := r || jsonb_build_object('fx16_vo_without_a_vo_value_counts_zero_contract_MUST0', x);
  IF x IS DISTINCT FROM 0::numeric THEN v_fx_bad := v_fx_bad + 1; END IF;
  x := (SELECT total_pct FROM site_progress_pct(md5('gpf|16|site')::uuid));
  r := r || jsonb_build_object('fx16_vo_without_a_vo_value_counts_zero_total_MUST0', x);
  IF x IS DISTINCT FROM 0::numeric THEN v_fx_bad := v_fx_bad + 1; END IF;
  -- fixture 17: zero price line gets zero points
  INSERT INTO sites (id, tenant_id, site_number, name, contract_value) VALUES (md5('gpf|17|site')::uuid, v_tenant, 'GT-PF-17', 'progress fixture: zero price line gets zero points', 0);
  PERFORM snapshot_site_plan(md5('gpf|17|site')::uuid, 'progress fixture', true, 'system');
  INSERT INTO site_phases (id, tenant_id, site_id, name, sort_order, billing_weight_pct, status, is_vo, is_issue_phase) VALUES (md5('gpf|17|A')::uuid, v_tenant, md5('gpf|17|site')::uuid, 'A', 1, 100, 'in_progress', false, false);
  INSERT INTO quotations (id, tenant_id, client_id, site_id, date, status, quotation_number) VALUES (md5('gpf|17|quotation')::uuid, v_tenant, (SELECT id FROM clients WHERE tenant_id = v_tenant ORDER BY created_at, id LIMIT 1), md5('gpf|17|site')::uuid, current_date, 'draft', 'GT-PF-Q17');
  INSERT INTO quotation_items (id, tenant_id, quotation_id, description, quantity, unit_price, line_total, sort_order) VALUES (md5('gpf|17|qi|L1')::uuid, v_tenant, md5('gpf|17|quotation')::uuid, 'L1', 10, 0, 0, 1);
  INSERT INTO boq_items (id, tenant_id, site_id, quotation_item_id, code, description, planned_qty, sort_order) VALUES (md5('gpf|17|L1')::uuid, v_tenant, md5('gpf|17|site')::uuid, md5('gpf|17|qi|L1')::uuid, 'L1', 'L1', 10, 1);
  INSERT INTO quotation_items (id, tenant_id, quotation_id, description, quantity, unit_price, line_total, sort_order) VALUES (md5('gpf|17|qi|L2')::uuid, v_tenant, md5('gpf|17|quotation')::uuid, 'L2', 10, 100, 1000, 2);
  INSERT INTO boq_items (id, tenant_id, site_id, quotation_item_id, code, description, planned_qty, sort_order) VALUES (md5('gpf|17|L2')::uuid, v_tenant, md5('gpf|17|site')::uuid, md5('gpf|17|qi|L2')::uuid, 'L2', 'L2', 10, 2);
  INSERT INTO phase_tasks (id, tenant_id, site_id, phase_id, subtask_id, parent_task_id, name, sort_order, status, progress_mode, planned_qty, done_qty, boq_item_id, issue_report_id) VALUES (md5('gpf|17|q1')::uuid, v_tenant, md5('gpf|17|site')::uuid, md5('gpf|17|A')::uuid, NULL, NULL, 'q1', 1, 'done', 'quantity', 10, 10, md5('gpf|17|L1')::uuid, NULL);
  INSERT INTO phase_tasks (id, tenant_id, site_id, phase_id, subtask_id, parent_task_id, name, sort_order, status, progress_mode, planned_qty, done_qty, boq_item_id, issue_report_id) VALUES (md5('gpf|17|q2')::uuid, v_tenant, md5('gpf|17|site')::uuid, md5('gpf|17|A')::uuid, NULL, NULL, 'q2', 2, 'in_progress', 'quantity', 10, 5, md5('gpf|17|L2')::uuid, NULL);
  x := (SELECT weight_pts FROM phase_tasks WHERE id = md5('gpf|17|q1')::uuid);
  r := r || jsonb_build_object('fx17_zero_price_line_gets_zero_points_pts_q1_MUST0', x);
  IF x IS DISTINCT FROM 0::numeric THEN v_fx_bad := v_fx_bad + 1; END IF;
  x := (SELECT weight_pts FROM phase_tasks WHERE id = md5('gpf|17|q2')::uuid);
  r := r || jsonb_build_object('fx17_zero_price_line_gets_zero_points_pts_q2_MUST100', x);
  IF x IS DISTINCT FROM 100::numeric THEN v_fx_bad := v_fx_bad + 1; END IF;
  x := round(node_progress(md5('gpf|17|A')::uuid) * 100, 2);
  r := r || jsonb_build_object('fx17_zero_price_line_gets_zero_points_phase_A_MUST50', x);
  IF x IS DISTINCT FROM 50::numeric THEN v_fx_bad := v_fx_bad + 1; END IF;
  x := (SELECT contract_pct FROM site_progress_pct(md5('gpf|17|site')::uuid));
  r := r || jsonb_build_object('fx17_zero_price_line_gets_zero_points_contract_MUST50', x);
  IF x IS DISTINCT FROM 50::numeric THEN v_fx_bad := v_fx_bad + 1; END IF;
  x := (SELECT total_pct FROM site_progress_pct(md5('gpf|17|site')::uuid));
  r := r || jsonb_build_object('fx17_zero_price_line_gets_zero_points_total_MUSTnull', x);
  IF x IS DISTINCT FROM NULL THEN v_fx_bad := v_fx_bad + 1; END IF;
  -- fixture 18: all zero prices equal shares
  INSERT INTO sites (id, tenant_id, site_number, name, contract_value) VALUES (md5('gpf|18|site')::uuid, v_tenant, 'GT-PF-18', 'progress fixture: all zero prices equal shares', 0);
  PERFORM snapshot_site_plan(md5('gpf|18|site')::uuid, 'progress fixture', true, 'system');
  INSERT INTO site_phases (id, tenant_id, site_id, name, sort_order, billing_weight_pct, status, is_vo, is_issue_phase) VALUES (md5('gpf|18|A')::uuid, v_tenant, md5('gpf|18|site')::uuid, 'A', 1, 100, 'in_progress', false, false);
  INSERT INTO quotations (id, tenant_id, client_id, site_id, date, status, quotation_number) VALUES (md5('gpf|18|quotation')::uuid, v_tenant, (SELECT id FROM clients WHERE tenant_id = v_tenant ORDER BY created_at, id LIMIT 1), md5('gpf|18|site')::uuid, current_date, 'draft', 'GT-PF-Q18');
  INSERT INTO quotation_items (id, tenant_id, quotation_id, description, quantity, unit_price, line_total, sort_order) VALUES (md5('gpf|18|qi|L1')::uuid, v_tenant, md5('gpf|18|quotation')::uuid, 'L1', 10, 0, 0, 1);
  INSERT INTO boq_items (id, tenant_id, site_id, quotation_item_id, code, description, planned_qty, sort_order) VALUES (md5('gpf|18|L1')::uuid, v_tenant, md5('gpf|18|site')::uuid, md5('gpf|18|qi|L1')::uuid, 'L1', 'L1', 10, 1);
  INSERT INTO quotation_items (id, tenant_id, quotation_id, description, quantity, unit_price, line_total, sort_order) VALUES (md5('gpf|18|qi|L2')::uuid, v_tenant, md5('gpf|18|quotation')::uuid, 'L2', 10, 0, 0, 2);
  INSERT INTO boq_items (id, tenant_id, site_id, quotation_item_id, code, description, planned_qty, sort_order) VALUES (md5('gpf|18|L2')::uuid, v_tenant, md5('gpf|18|site')::uuid, md5('gpf|18|qi|L2')::uuid, 'L2', 'L2', 10, 2);
  INSERT INTO phase_tasks (id, tenant_id, site_id, phase_id, subtask_id, parent_task_id, name, sort_order, status, progress_mode, planned_qty, done_qty, boq_item_id, issue_report_id) VALUES (md5('gpf|18|q1')::uuid, v_tenant, md5('gpf|18|site')::uuid, md5('gpf|18|A')::uuid, NULL, NULL, 'q1', 1, 'done', 'quantity', 10, 10, md5('gpf|18|L1')::uuid, NULL);
  INSERT INTO phase_tasks (id, tenant_id, site_id, phase_id, subtask_id, parent_task_id, name, sort_order, status, progress_mode, planned_qty, done_qty, boq_item_id, issue_report_id) VALUES (md5('gpf|18|q2')::uuid, v_tenant, md5('gpf|18|site')::uuid, md5('gpf|18|A')::uuid, NULL, NULL, 'q2', 2, 'not_started', 'quantity', 10, 0, md5('gpf|18|L2')::uuid, NULL);
  x := (SELECT weight_pts FROM phase_tasks WHERE id = md5('gpf|18|q1')::uuid);
  r := r || jsonb_build_object('fx18_all_zero_prices_equal_shares_pts_q1_MUST50', x);
  IF x IS DISTINCT FROM 50::numeric THEN v_fx_bad := v_fx_bad + 1; END IF;
  x := (SELECT weight_pts FROM phase_tasks WHERE id = md5('gpf|18|q2')::uuid);
  r := r || jsonb_build_object('fx18_all_zero_prices_equal_shares_pts_q2_MUST50', x);
  IF x IS DISTINCT FROM 50::numeric THEN v_fx_bad := v_fx_bad + 1; END IF;
  x := round(node_progress(md5('gpf|18|A')::uuid) * 100, 2);
  r := r || jsonb_build_object('fx18_all_zero_prices_equal_shares_phase_A_MUST50', x);
  IF x IS DISTINCT FROM 50::numeric THEN v_fx_bad := v_fx_bad + 1; END IF;
  x := (SELECT contract_pct FROM site_progress_pct(md5('gpf|18|site')::uuid));
  r := r || jsonb_build_object('fx18_all_zero_prices_equal_shares_contract_MUST50', x);
  IF x IS DISTINCT FROM 50::numeric THEN v_fx_bad := v_fx_bad + 1; END IF;
  x := (SELECT total_pct FROM site_progress_pct(md5('gpf|18|site')::uuid));
  r := r || jsonb_build_object('fx18_all_zero_prices_equal_shares_total_MUSTnull', x);
  IF x IS DISTINCT FROM NULL THEN v_fx_bad := v_fx_bad + 1; END IF;
  r := r || jsonb_build_object('a_fixture_mismatches_MUST0', v_fx_bad);

  -- ===== card kinds on the fixture sites =====
  -- a general card added to a BOQ node (even sending 50 points, even done) changes nothing
  INSERT INTO phase_tasks (tenant_id, site_id, phase_id, name, sort_order, weight_pts, status)
    VALUES (v_tenant, md5('gpf|3|site')::uuid, md5('gpf|3|A')::uuid, 'general in boq node', 9, 50, 'done') RETURNING id INTO v_card;
  SELECT weight_pts INTO x FROM phase_tasks WHERE id = v_card;
  r := r || jsonb_build_object('k_general_card_in_boq_node_pts_MUST0', x);
  x := round(node_progress(md5('gpf|3|A')::uuid) * 100, 2);
  r := r || jsonb_build_object('k_general_card_in_boq_node_pct_MUST77.5', x);
  SELECT sum(weight_pts) INTO x FROM phase_tasks WHERE phase_id = md5('gpf|3|A')::uuid;
  r := r || jsonb_build_object('k_boq_node_points_sum_MUST100', x);
  -- splitting a done general card keeps the node at 100; an in-progress one keeps it at 0
  BEGIN
    PERFORM split_task(md5('gpf|2|a1')::uuid, '[{"name":"a1-1"},{"name":"a1-2"}]');
    x := round(node_progress(md5('gpf|2|A')::uuid) * 100, 2);
    r := r || jsonb_build_object('k_split_done_general_card_node_pct_MUST100', x);
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('k_split_done_general_card_node_pct_MUST100', SQLSTATE || ' ' || SQLERRM);
  END;
  BEGIN
    PERFORM split_task(md5('gpf|1|a2')::uuid, '[{"name":"a2-1"},{"name":"a2-2"}]');
    x := round(node_progress(md5('gpf|1|A')::uuid) * 100, 2);
    r := r || jsonb_build_object('k_split_in_progress_general_card_node_pct_MUST0', x);
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('k_split_in_progress_general_card_node_pct_MUST0', SQLSTATE || ' ' || SQLERRM);
  END;
  BEGIN
    PERFORM split_task(md5('gpf|3|q1')::uuid, '[{"name":"x"},{"name":"y"}]');
    r := r || jsonb_build_object('k_split_boq_card_MUST22023', 'no error');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('k_split_boq_card_MUST22023', SQLSTATE || ' ' || SQLERRM);
  END;

  -- ===== ruling 2: a BOQ line cannot drop below its cards =====
  INSERT INTO boq_items (tenant_id, site_id, code, description, planned_qty)
    VALUES (v_tenant, md5('gpf|1|site')::uuid, 'R2', 'ruling 2 line', 50) RETURNING id INTO v_boq;
  INSERT INTO phase_tasks (tenant_id, site_id, phase_id, name, weight_pts, progress_mode, planned_qty, boq_item_id)
    VALUES (v_tenant, md5('gpf|1|site')::uuid, md5('gpf|1|A')::uuid, 'R2 card', 0, 'quantity', 30, v_boq) RETURNING id INTO v_card;
  BEGIN
    UPDATE boq_items SET planned_qty = 29.5 WHERE id = v_boq;
    r := r || jsonb_build_object('r2_boq_below_cards_MUST22023', 'no error');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('r2_boq_below_cards_MUST22023', SQLSTATE || ' ' || SQLERRM);
  END;
  BEGIN
    UPDATE boq_items SET planned_qty = 30 WHERE id = v_boq;
    r := r || jsonb_build_object('r2_boq_equal_to_cards_MUSTok', 'ok');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('r2_boq_equal_to_cards_MUSTok', SQLSTATE || ' ' || SQLERRM);
  END;
  BEGIN
    UPDATE boq_items SET planned_qty = 80, description = 'ruling 2 line raised' WHERE id = v_boq;
    r := r || jsonb_build_object('r2_boq_raised_MUSTok', 'ok');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('r2_boq_raised_MUSTok', SQLSTATE || ' ' || SQLERRM);
  END;
  SELECT trim_scale(planned_qty)::text INTO v FROM boq_items WHERE id = v_boq;
  r := r || jsonb_build_object('r2_boq_final_MUST80', v);

  -- ===== review fix 1: phase_vo_values must point at a phase of its own tenant =====
  SELECT ph.id INTO v_fphase FROM site_phases ph WHERE ph.tenant_id <> v_tenant ORDER BY ph.created_at LIMIT 1;
  BEGIN
    INSERT INTO phase_vo_values (phase_id, tenant_id, vo_value) VALUES (v_fphase, v_tenant, 1);
    r := r || jsonb_build_object('x_vo_value_foreign_phase_MUST42501', 'no error');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('x_vo_value_foreign_phase_MUST42501', SQLSTATE || ' ' || SQLERRM);
  END;

  -- ===== RLS and privileges =====
  INSERT INTO user_roles (user_email, role, tenant_id, status) VALUES
    (v_pm, 'PM', v_tenant, 'approved'), (v_wk, 'WORKER', v_tenant, 'approved'), (v_admin, 'ADMIN', v_tenant, 'approved');
  SELECT user_email INTO v_owner FROM user_roles WHERE tenant_id = v_tenant AND role = 'OWNER' AND status = 'approved' ORDER BY created_at LIMIT 1;
  PERFORM set_config('request.jwt.claims', json_build_object('email', v_owner, 'role', 'authenticated', 'sub', gen_random_uuid())::text, true);
  SET LOCAL ROLE authenticated;
  SELECT contract_pct INTO x FROM site_progress_pct(md5('gpf|3|site')::uuid);
  r := r || jsonb_build_object('rls_owner_site_progress_pct_MUST77.5', x);
  SELECT total_pct INTO x FROM site_progress_pct(md5('gpf|9|site')::uuid);
  r := r || jsonb_build_object('rls_owner_vo_total_pct_MUST90', x);
  SELECT count(*) INTO n FROM phase_vo_values;
  r := r || jsonb_build_object('rls_owner_vo_values_MUST2', n);
  SELECT count(*), count(*) FILTER (WHERE tenant_id <> v_tenant) INTO n, m FROM site_progress_daily_money;
  r := r || jsonb_build_object('rls_owner_reads_money_rows_MUSTtrue', n > 0 AND m = 0);
  SELECT count(*) INTO n FROM site_progress_daily;
  r := r || jsonb_build_object('rls_owner_reads_daily_rows_MUSTtrue', n > 0);
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', json_build_object('email', v_admin, 'role', 'authenticated', 'sub', gen_random_uuid())::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO n FROM phase_vo_values;
  r := r || jsonb_build_object('rls_admin_vo_values_MUST2', n);
  SELECT count(*), count(*) FILTER (WHERE tenant_id <> v_tenant) INTO n, m FROM site_progress_daily_money;
  r := r || jsonb_build_object('rls_admin_reads_money_rows_MUSTtrue', n > 0 AND m = 0);
  SELECT count(*) INTO n FROM site_progress_daily;
  r := r || jsonb_build_object('rls_admin_reads_daily_rows_MUSTtrue', n > 0);
  BEGIN
    UPDATE phase_vo_values SET vo_value = 200000 WHERE phase_id = md5('gpf|10|B')::uuid;
    GET DIAGNOSTICS n = ROW_COUNT;
    r := r || jsonb_build_object('rls_admin_vo_value_update_rows_MUST1', n);
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('rls_admin_vo_value_update_rows_MUST1', SQLSTATE || ' ' || SQLERRM);
  END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', json_build_object('email', v_pm, 'role', 'authenticated', 'sub', gen_random_uuid())::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*), count(*) FILTER (WHERE tenant_id <> v_tenant) INTO n, m FROM site_progress_daily;
  r := r || jsonb_build_object('rls_pm_reads_own_rows_MUSTtrue', n > 0 AND m = 0);
  SELECT count(*) INTO n FROM site_progress_daily_money;
  r := r || jsonb_build_object('rls_pm_money_rows_MUST0', n);
  SELECT count(*) INTO n FROM phase_vo_values;
  r := r || jsonb_build_object('rls_pm_vo_values_MUST0', n);
  BEGIN
    INSERT INTO phase_vo_values (phase_id, vo_value) VALUES (md5('gpf|16|C')::uuid, 5);
    r := r || jsonb_build_object('rls_pm_vo_value_insert_MUST42501', 'no error');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('rls_pm_vo_value_insert_MUST42501', SQLSTATE);
  END;
  SELECT count(*) INTO n FROM site_progress_pct(md5('gpf|9|site')::uuid);
  r := r || jsonb_build_object('rls_pm_site_progress_pct_rows_MUST0', n);
  BEGIN
    INSERT INTO site_progress_daily (site_id, tenant_id, day, contract_pct) VALUES (md5('gpf|1|site')::uuid, v_tenant, '2000-01-01', 1);
    r := r || jsonb_build_object('rls_pm_insert_daily_MUST42501', 'no error');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('rls_pm_insert_daily_MUST42501', SQLSTATE);
  END;
  BEGIN
    PERFORM snapshot_site_progress();
    r := r || jsonb_build_object('rls_pm_call_snapshot_MUST42501', 'no error');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('rls_pm_call_snapshot_MUST42501', SQLSTATE);
  END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', json_build_object('email', v_wk, 'role', 'authenticated', 'sub', gen_random_uuid())::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO n FROM site_progress_daily;
  r := r || jsonb_build_object('rls_worker_rows_MUST0', n);
  SELECT count(*) INTO n FROM site_progress_daily_money;
  r := r || jsonb_build_object('rls_worker_money_rows_MUST0', n);
  SELECT count(*) INTO n FROM phase_vo_values;
  r := r || jsonb_build_object('rls_worker_vo_values_MUST0', n);
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);
  SELECT bool_or(has_function_privilege('anon', p.oid, 'EXECUTE')) INTO b FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('task_progress','node_progress','site_progress_pct','snapshot_site_progress','check_boq_planned_qty','demo_seed_core','check_phase_vo_refs');
  r := r || jsonb_build_object('priv_anon_execute_any_MUSTfalse', b);
  SELECT has_function_privilege('authenticated', 'public.snapshot_site_progress()', 'EXECUTE')
      OR has_function_privilege('authenticated', 'public.check_boq_planned_qty()', 'EXECUTE')
      OR has_function_privilege('authenticated', 'public.demo_seed_core(uuid)', 'EXECUTE') INTO b;
  r := r || jsonb_build_object('priv_authenticated_internal_MUSTfalse', b);
  SELECT has_function_privilege('authenticated', 'public.task_progress(uuid)', 'EXECUTE')
     AND has_function_privilege('authenticated', 'public.node_progress(uuid)', 'EXECUTE')
     AND has_function_privilege('authenticated', 'public.site_progress_pct(uuid)', 'EXECUTE') INTO b;
  r := r || jsonb_build_object('priv_authenticated_progress_fns_MUSTtrue', b);
  SELECT has_table_privilege('authenticated', 'public.site_progress_daily', 'INSERT')
      OR has_table_privilege('authenticated', 'public.site_progress_daily', 'UPDATE')
      OR has_table_privilege('authenticated', 'public.site_progress_daily', 'DELETE')
      OR has_table_privilege('authenticated', 'public.site_progress_daily', 'TRUNCATE')
      OR has_table_privilege('anon', 'public.site_progress_daily', 'INSERT')
      OR has_table_privilege('authenticated', 'public.site_progress_daily_money', 'INSERT')
      OR has_table_privilege('authenticated', 'public.site_progress_daily_money', 'UPDATE')
      OR has_table_privilege('authenticated', 'public.site_progress_daily_money', 'DELETE')
      OR has_table_privilege('authenticated', 'public.site_progress_daily_money', 'TRUNCATE')
      OR has_table_privilege('authenticated', 'public.phase_vo_values', 'TRUNCATE') INTO b;
  r := r || jsonb_build_object('priv_daily_writes_MUSTfalse', b);
  SELECT prosecdef INTO b FROM pg_proc WHERE oid = 'public.node_progress(uuid)'::regprocedure;
  r := r || jsonb_build_object('priv_node_progress_definer_MUSTfalse', b);

  -- ===== ruling 1: the demo seed gives every seeded site a PLAN v1; its cards are general (0 points) =====
  -- reset_demo_tenant() is stuck live on system pay_items rows (unrelated to 07-09), so the
  -- redefined demo_seed_core runs on a fresh tenant, the way seed_demo_tenant() calls it.
  INSERT INTO tenants (company_name, trial_ends_at) VALUES ('gantt demo seed test', now() + interval '30 days') RETURNING id INTO v_tenant;
  v_owner := 'gantt-test-demo-owner@example.invalid';
  INSERT INTO user_roles (user_email, role, tenant_id, status) VALUES (v_owner, 'OWNER', v_tenant, 'approved');
  PERFORM demo_impersonate(v_tenant);
  BEGIN
    PERFORM demo_seed_core(v_tenant);
    r := r || jsonb_build_object('demo_seed_core_MUSTok', 'ok');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('demo_seed_core_MUSTok', SQLSTATE || ' ' || SQLERRM);
  END;
  PERFORM set_config('request.jwt.claims', '', true);
  SELECT count(*) INTO n FROM sites s WHERE s.tenant_id = v_tenant
     AND EXISTS (SELECT 1 FROM site_phases ph WHERE ph.site_id = s.id AND NOT ph.is_issue_phase);
  SELECT count(*) INTO m FROM sites s WHERE s.tenant_id = v_tenant
     AND EXISTS (SELECT 1 FROM site_plans p WHERE p.site_id = s.id AND p.version = 1 AND p.is_auto AND p.created_by = 'system');
  r := r || jsonb_build_object('demo_sites_with_phase_MUST10', n, 'demo_sites_with_plan_v1_MUSTtrue', n = m AND n > 0);
  SELECT count(*) INTO n FROM phase_tasks WHERE tenant_id = v_tenant AND (weight_pts <> 0 OR progress_mode <> 'status');
  r := r || jsonb_build_object('demo_cards_not_general_zero_MUST0', n);
  SELECT count(*), count(*) FILTER (WHERE q.all_done_pct IS DISTINCT FROM node_progress(q.phase_id) * 100) INTO n, m FROM (
    SELECT t.phase_id, CASE WHEN bool_and(t.status = 'done') THEN 100 ELSE 0 END AS all_done_pct
      FROM phase_tasks t WHERE t.tenant_id = v_tenant AND t.parent_task_id IS NULL AND t.issue_report_id IS NULL
     GROUP BY t.phase_id) q;
  r := r || jsonb_build_object('demo_phases_compared_MUST40', n, 'demo_phase_pct_all_done_rule_mismatches_MUST0', m);
  SELECT (SELECT count(*) FROM site_plan_items i JOIN site_plans p ON p.id = i.plan_id WHERE p.tenant_id = v_tenant AND i.level = 'task')
       = (SELECT count(*) FROM phase_tasks WHERE tenant_id = v_tenant AND issue_report_id IS NULL) INTO b;
  r := r || jsonb_build_object('demo_plan_task_items_match_MUSTtrue', b);
  -- the PLAN gate (a trigger, so the role does not matter) now lets a seeded card move
  SELECT t.id INTO v_card FROM phase_tasks t WHERE t.tenant_id = v_tenant AND t.status = 'not_started' AND t.issue_report_id IS NULL ORDER BY t.created_at LIMIT 1;
  BEGIN
    UPDATE phase_tasks SET status = 'done' WHERE id = v_card;
    SELECT status INTO v FROM phase_tasks WHERE id = v_card;
    r := r || jsonb_build_object('demo_card_moves_after_seed_MUSTdone', v);
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('demo_card_moves_after_seed_MUSTdone', SQLSTATE || ' ' || SQLERRM);
  END;
  -- final-review fix I1: the seed ran its site loop under the derived flag and restored it
  r := r || jsonb_build_object('demo_flag_restored_MUSTtrue', COALESCE(current_setting('app.derived_status', true), '') = '');
  SELECT count(*) INTO n FROM phase_tasks WHERE tenant_id = v_tenant AND status IN ('in_progress', 'done');
  r := r || jsonb_build_object('demo_seeded_started_cards_MUSTtrue', n > 0);

  -- check: this RAISE is load-bearing. It aborts the DO block so none of the
  -- rows written above survive, and it is how the RESULT reaches the output.
  -- The ROLLBACK below then undoes the inlined DDL. Never remove either.
  RAISE EXCEPTION 'RESULT %', r;
END $$;
ROLLBACK;
