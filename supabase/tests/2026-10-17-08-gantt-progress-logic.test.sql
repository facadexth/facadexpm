-- Rolled-back check for supabase/migrations/2026-10-17-08-gantt-progress-logic.sql.
-- Run: npx supabase db query --linked -f supabase/tests/2026-10-17-08-gantt-progress-logic.test.sql
-- 04/05/06 are already applied live. The 07 and 08 bodies are inlined below,
-- byte-identical to their files between BEGIN; and COMMIT;. Keep them in sync.
-- The DO block ends in RAISE EXCEPTION 'RESULT ...', so nothing persists.
-- Expected: *_MUST<value> holds that value; *_MUST22023_<tag> is 22023 with the
-- brief's Thai message; *_MUSTok is 'ok'. Fixtures: demo tenant, fresh site.
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

ALTER TABLE phase_tasks
  ADD COLUMN weight_pts numeric(6,2) NOT NULL DEFAULT 0 CHECK (weight_pts >= 0),
  ADD COLUMN progress_mode text NOT NULL DEFAULT 'status' CHECK (progress_mode IN ('status','quantity')),
  ADD COLUMN parent_task_id uuid NULL REFERENCES phase_tasks(id) ON DELETE CASCADE,
  ADD COLUMN boq_item_id uuid NULL REFERENCES boq_items(id) ON DELETE SET NULL,
  ADD COLUMN planned_qty numeric NULL CHECK (planned_qty IS NULL OR planned_qty > 0),
  ADD COLUMN done_qty numeric NOT NULL DEFAULT 0,
  ADD CONSTRAINT phase_tasks_quantity_needs_plan CHECK (progress_mode = 'status' OR planned_qty IS NOT NULL);
CREATE INDEX phase_tasks_parent_idx ON phase_tasks(parent_task_id) WHERE parent_task_id IS NOT NULL;

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

-- 4. point limits (re-summed under a lock on the node's phase row)
CREATE OR REPLACE FUNCTION public.check_node_weights() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_sum numeric; v_parent phase_tasks%ROWTYPE;
BEGIN
  PERFORM 1 FROM site_phases WHERE id = NEW.phase_id FOR NO KEY UPDATE;
  IF NEW.parent_task_id IS NULL THEN
    IF NEW.issue_report_id IS NULL THEN
      SELECT COALESCE(sum(weight_pts), 0) INTO v_sum FROM phase_tasks
       WHERE tenant_id = NEW.tenant_id AND parent_task_id IS NULL AND issue_report_id IS NULL
         AND COALESCE(subtask_id, phase_id) = COALESCE(NEW.subtask_id, NEW.phase_id);
      IF v_sum > 100.005 THEN
        RAISE EXCEPTION 'แต้มในเฟสนี้รวมเกิน 100' USING ERRCODE = '22023';
      END IF;
    END IF;
    -- NEW may itself be a parent whose points were lowered
    SELECT sum(weight_pts) INTO v_sum FROM phase_tasks WHERE tenant_id = NEW.tenant_id AND parent_task_id = NEW.id;
    IF v_sum IS NOT NULL AND v_sum > NEW.weight_pts + 0.005 THEN
      RAISE EXCEPTION 'แต้มงานย่อยรวมเกินแต้มงานหลัก' USING ERRCODE = '22023';
    END IF;
  ELSE
    SELECT * INTO v_parent FROM phase_tasks WHERE id = NEW.parent_task_id AND tenant_id = NEW.tenant_id;
    IF v_parent.parent_task_id IS NOT NULL
       OR EXISTS (SELECT 1 FROM phase_tasks WHERE tenant_id = NEW.tenant_id AND parent_task_id = NEW.id) THEN
      RAISE EXCEPTION 'แตกงานได้ชั้นเดียว' USING ERRCODE = '22023';
    END IF;
    SELECT COALESCE(sum(weight_pts), 0) INTO v_sum FROM phase_tasks
     WHERE tenant_id = NEW.tenant_id AND parent_task_id = NEW.parent_task_id;
    IF v_sum > v_parent.weight_pts + 0.005 THEN
      RAISE EXCEPTION 'แต้มงานย่อยรวมเกินแต้มงานหลัก' USING ERRCODE = '22023';
    END IF;
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.check_node_weights() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER trg_check_node_weights AFTER INSERT OR UPDATE OF weight_pts, parent_task_id, phase_id, subtask_id ON phase_tasks
  FOR EACH ROW EXECUTE FUNCTION check_node_weights();

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
-- (a WORKER may update an assigned card's status, never its points or structure).
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

-- 10. split a card one level (SECURITY INVOKER)
CREATE OR REPLACE FUNCTION public.split_task(p_task_id uuid, p_children jsonb)
  RETURNS void LANGUAGE plpgsql SET search_path = public
AS $$
DECLARE t phase_tasks%ROWTYPE; v_sum numeric; c record;
BEGIN
  SELECT * INTO t FROM phase_tasks WHERE id = p_task_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบการ์ดนี้' USING ERRCODE = 'P0002'; END IF;
  IF t.parent_task_id IS NOT NULL THEN
    RAISE EXCEPTION 'แตกงานได้ชั้นเดียว' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM phase_tasks WHERE parent_task_id = t.id) THEN
    RAISE EXCEPTION 'การ์ดนี้แตกงานแล้ว' USING ERRCODE = '22023';
  END IF;
  IF t.progress_mode = 'quantity' THEN
    RAISE EXCEPTION 'การ์ดที่นับจำนวนแตกงานไม่ได้' USING ERRCODE = '22023';
  END IF;
  IF t.issue_report_id IS NOT NULL THEN
    RAISE EXCEPTION 'การ์ดปัญหาแตกงานไม่ได้' USING ERRCODE = '22023';
  END IF;
  -- a started card would drop to 0 % once its children (all not_started) take over
  IF t.status <> 'not_started' THEN
    RAISE EXCEPTION 'แตกงานได้เฉพาะงานที่ยังไม่เริ่ม' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_children) IS DISTINCT FROM 'array' OR jsonb_array_length(p_children) < 2 THEN
    RAISE EXCEPTION 'ต้องแตกอย่างน้อย 2 งาน' USING ERRCODE = '22023';
  END IF;
  SELECT sum((e->>'weight_pts')::numeric) INTO v_sum FROM jsonb_array_elements(p_children) e;
  IF v_sum IS NULL OR abs(v_sum - t.weight_pts) > 0.01 THEN
    RAISE EXCEPTION 'แต้มงานย่อยรวม % ต้องเท่ากับแต้มงานหลัก %', trim_scale(COALESCE(v_sum, 0)), trim_scale(t.weight_pts)
      USING ERRCODE = '22023';
  END IF;
  FOR c IN SELECT e->>'name' AS name, (e->>'weight_pts')::numeric AS w, ord
             FROM jsonb_array_elements(p_children) WITH ORDINALITY AS x(e, ord) LOOP
    IF btrim(COALESCE(c.name, '')) = '' THEN
      RAISE EXCEPTION 'ต้องใส่ชื่องานย่อย' USING ERRCODE = '22023';
    END IF;
    INSERT INTO phase_tasks (phase_id, subtask_id, site_id, tenant_id, zone, name, status, weight_pts, sort_order, parent_task_id)
      VALUES (t.phase_id, t.subtask_id, t.site_id, t.tenant_id, t.zone, btrim(c.name), 'not_started', c.w,
              t.sort_order + c.ord::int, t.id);
  END LOOP;
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

-- deferred minor from Task 1 review
REVOKE TRUNCATE ON site_plans, site_plan_items, progress_reports FROM authenticated, anon;
-- ===== end of inlined bodies =====

DO $$
DECLARE
  v_tenant uuid; r jsonb := '{}'; n int; b boolean; v text; x numeric;
  v_pm text := 'gantt-test-pm@example.invalid'; v_admin text := 'gantt-test-admin@example.invalid';
  v_wk text := 'gantt-test-worker@example.invalid'; v_owner text;
  v_site uuid; v_site2 uuid; v_p1 uuid; v_p2 uuid; v_pi uuid; v_s1 uuid; v_rep_issue uuid; v_issue_card uuid;
  v_a uuid; v_b uuid; v_c1 uuid; v_c2 uuid; v_q uuid; v_boq uuid; v_boq_other_site uuid; v_boq_foreign uuid;
  v_ftenant uuid; v_fsite uuid; v_fcard uuid; v_r45 uuid; v_r75 uuid; v_rep uuid; v_worker uuid; v_wcard uuid;
  v_client uuid; v_quot uuid; v_qi1 uuid; v_qi2 uuid; v_ver int; v_f uuid; v_q3 uuid;
  v_rep_issue2 uuid; v_tmp uuid; v_dsite uuid; v_dphase uuid; v_dcard uuid;
BEGIN
  -- ===== as the table owner: fixtures =====
  SELECT id INTO v_tenant FROM tenants WHERE company_name ILIKE '%สร้างดี%' LIMIT 1;
  SELECT user_email INTO v_owner FROM user_roles WHERE tenant_id = v_tenant AND role = 'OWNER' AND status = 'approved' LIMIT 1;
  SELECT id INTO v_site2 FROM sites WHERE tenant_id = v_tenant ORDER BY created_at LIMIT 1;
  SELECT id INTO v_client FROM clients WHERE tenant_id = v_tenant ORDER BY created_at LIMIT 1;
  SELECT tenant_id, site_id, id INTO v_ftenant, v_fsite, v_fcard FROM phase_tasks WHERE tenant_id <> v_tenant ORDER BY created_at LIMIT 1;
  r := r || jsonb_build_object('fixtures_found_MUSTtrue',
         v_tenant IS NOT NULL AND v_owner IS NOT NULL AND v_site2 IS NOT NULL AND v_client IS NOT NULL AND v_fcard IS NOT NULL);
  INSERT INTO user_roles (user_email, role, tenant_id, status) VALUES
    (v_pm, 'PM', v_tenant, 'approved'), (v_admin, 'ADMIN', v_tenant, 'approved'), (v_wk, 'WORKER', v_tenant, 'approved');
  INSERT INTO sites (tenant_id, site_number, name) VALUES (v_tenant, 'GT-TEST-08', 'gantt test site') RETURNING id INTO v_site;
  INSERT INTO site_phases (tenant_id, site_id, name, sort_order, start_date, end_date, billing_weight_pct) VALUES
    (v_tenant, v_site, 'P1', 1, '2026-11-01', '2026-11-30', 60) RETURNING id INTO v_p1;
  INSERT INTO site_phases (tenant_id, site_id, name, sort_order, start_date, end_date, billing_weight_pct) VALUES
    (v_tenant, v_site, 'P2', 2, '2026-12-01', '2026-12-31', 30) RETURNING id INTO v_p2;
  INSERT INTO phase_subtasks (tenant_id, site_id, phase_id, name, sort_order) VALUES (v_tenant, v_site, v_p1, 'S1', 1) RETURNING id INTO v_s1;
  INSERT INTO line_issue_reports (tenant_id, site_id, message) VALUES (v_tenant, v_site, 'gantt test issue') RETURNING id INTO v_rep_issue;
  v_issue_card := create_issue_card(v_rep_issue);
  SELECT phase_id INTO v_pi FROM phase_tasks WHERE id = v_issue_card;
  INSERT INTO line_issue_reports (tenant_id, site_id, message) VALUES (v_tenant, v_site, 'gantt test issue 2') RETURNING id INTO v_rep_issue2;
  -- BOQ rows for cross-tenant checks: same tenant other site, and a foreign tenant
  INSERT INTO boq_items (tenant_id, site_id, code, description, planned_qty) VALUES (v_tenant, v_site2, 'X1', 'other site', 10) RETURNING id INTO v_boq_other_site;
  INSERT INTO boq_items (tenant_id, site_id, code, description, planned_qty) VALUES (v_ftenant, v_fsite, 'F1', 'foreign', 10) RETURNING id INTO v_boq_foreign;
  -- a worker assigned to a status card (item i)
  INSERT INTO workers (tenant_id, name, email) VALUES (v_tenant, 'gantt test worker', v_wk) RETURNING id INTO v_worker;
  r := r || jsonb_build_object('issue_card_created_MUSTtrue', v_issue_card IS NOT NULL);

  -- ===== PM =====
  PERFORM set_config('request.jwt.claims', json_build_object('email', v_pm, 'role', 'authenticated', 'sub', gen_random_uuid())::text, true);
  SET LOCAL ROLE authenticated;
  INSERT INTO phase_tasks (phase_id, site_id, name, weight_pts, sort_order) VALUES (v_p1, v_site, 'A', 20, 10) RETURNING id INTO v_a;
  INSERT INTO phase_tasks (phase_id, site_id, name, weight_pts, sort_order) VALUES (v_p1, v_site, 'B', 20, 20) RETURNING id INTO v_b;
  INSERT INTO phase_tasks (phase_id, site_id, name, weight_pts, sort_order) VALUES (v_p1, v_site, 'W', 5, 30) RETURNING id INTO v_wcard;

  -- (a) gate before PLAN v1
  BEGIN
    UPDATE phase_tasks SET status = 'done' WHERE id = v_a;
    r := r || jsonb_build_object('a_card_done_no_plan_MUST22023_gate', 'no error');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('a_card_done_no_plan_MUST22023_gate', SQLSTATE || ' ' || SQLERRM);
  END;
  BEGIN
    UPDATE phase_tasks SET status = 'done' WHERE id = v_issue_card;
    SELECT status INTO v FROM phase_tasks WHERE id = v_issue_card;
    r := r || jsonb_build_object('a_issue_card_done_no_plan_MUSTdone', v);
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('a_issue_card_done_no_plan_MUSTdone', SQLSTATE || ' ' || SQLERRM);
  END;
  BEGIN
    UPDATE site_phases SET status = 'in_progress' WHERE id = v_p1;
    r := r || jsonb_build_object('a_phase_status_no_plan_MUST22023_gate', 'no error');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('a_phase_status_no_plan_MUST22023_gate', SQLSTATE || ' ' || SQLERRM);
  END;
  BEGIN
    UPDATE phase_subtasks SET status = 'in_progress' WHERE id = v_s1;
    r := r || jsonb_build_object('a_subtask_status_no_plan_MUST22023_gate', 'no error');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('a_subtask_status_no_plan_MUST22023_gate', SQLSTATE || ' ' || SQLERRM);
  END;
  BEGIN
    UPDATE site_phases SET status = 'done' WHERE id = v_pi;
    r := r || jsonb_build_object('a_issue_phase_status_no_plan_MUSTok', 'ok');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('a_issue_phase_status_no_plan_MUSTok', SQLSTATE || ' ' || SQLERRM);
  END;
  -- full-row style update with status unchanged must not trip the gate
  BEGIN
    UPDATE site_phases SET status = status, name = name WHERE id = v_p1;
    r := r || jsonb_build_object('a_phase_same_status_no_plan_MUSTok', 'ok');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('a_phase_same_status_no_plan_MUSTok', SQLSTATE || ' ' || SQLERRM);
  END;
  -- final-review fix I1: the gate also covers inserts that start in_progress/done
  BEGIN
    INSERT INTO phase_tasks (phase_id, site_id, name, status) VALUES (v_p1, v_site, 'ins done', 'done');
    r := r || jsonb_build_object('a_insert_done_card_no_plan_MUST22023_gate', 'no error');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('a_insert_done_card_no_plan_MUST22023_gate', SQLSTATE || ' ' || SQLERRM);
  END;
  BEGIN
    INSERT INTO phase_tasks (phase_id, site_id, name, status) VALUES (v_p1, v_site, 'ins wip', 'in_progress');
    r := r || jsonb_build_object('a_insert_in_progress_card_no_plan_MUST22023_gate', 'no error');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('a_insert_in_progress_card_no_plan_MUST22023_gate', SQLSTATE || ' ' || SQLERRM);
  END;
  BEGIN
    INSERT INTO site_phases (site_id, name, sort_order, status) VALUES (v_site, 'ins done phase', 9, 'done');
    r := r || jsonb_build_object('a_insert_done_phase_no_plan_MUST22023_gate', 'no error');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('a_insert_done_phase_no_plan_MUST22023_gate', SQLSTATE || ' ' || SQLERRM);
  END;
  BEGIN
    INSERT INTO phase_subtasks (site_id, phase_id, name, sort_order, status) VALUES (v_site, v_p1, 'ins wip sub', 9, 'in_progress');
    r := r || jsonb_build_object('a_insert_in_progress_subtask_no_plan_MUST22023_gate', 'no error');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('a_insert_in_progress_subtask_no_plan_MUST22023_gate', SQLSTATE || ' ' || SQLERRM);
  END;
  -- a not_started card goes in; deleting it (no progress reports) is allowed (I3)
  BEGIN
    INSERT INTO phase_tasks (phase_id, site_id, name, status) VALUES (v_p1, v_site, 'ins new', 'not_started') RETURNING id INTO v_tmp;
    DELETE FROM phase_tasks WHERE id = v_tmp;
    GET DIAGNOSTICS n = ROW_COUNT;
    r := r || jsonb_build_object('a_insert_not_started_card_then_delete_MUST1', n);
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('a_insert_not_started_card_then_delete_MUST1', SQLSTATE || ' ' || SQLERRM);
  END;
  -- issue phase / issue card stay exempt (removed again so the PLAN item counts below hold)
  BEGIN
    INSERT INTO phase_tasks (phase_id, site_id, name, status, issue_report_id) VALUES (v_pi, v_site, 'issue done', 'done', v_rep_issue2) RETURNING id INTO v_tmp;
    DELETE FROM phase_tasks WHERE id = v_tmp;
    r := r || jsonb_build_object('a_insert_done_issue_card_no_plan_MUSTok', 'ok');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('a_insert_done_issue_card_no_plan_MUSTok', SQLSTATE || ' ' || SQLERRM);
  END;
  BEGIN
    INSERT INTO phase_tasks (phase_id, site_id, name, status) VALUES (v_pi, v_site, 'manual in issue phase', 'done') RETURNING id INTO v_tmp;
    DELETE FROM phase_tasks WHERE id = v_tmp;
    r := r || jsonb_build_object('a_insert_done_card_issue_phase_no_plan_MUSTok', 'ok');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('a_insert_done_card_issue_phase_no_plan_MUSTok', SQLSTATE || ' ' || SQLERRM);
  END;

  -- (d) point limits; node P2 then node S1
  BEGIN
    INSERT INTO phase_tasks (phase_id, site_id, name, weight_pts) VALUES
      (v_p2, v_site, 'D1', 33.33), (v_p2, v_site, 'D2', 33.33), (v_p2, v_site, 'D3', 33.34);
    r := r || jsonb_build_object('d_three_cards_100_MUSTok', 'ok');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('d_three_cards_100_MUSTok', SQLSTATE || ' ' || SQLERRM);
  END;
  BEGIN
    INSERT INTO phase_tasks (phase_id, site_id, name, weight_pts) VALUES (v_p2, v_site, 'D4', 0.01);
    r := r || jsonb_build_object('d_fourth_card_MUST22023_over100', 'no error');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('d_fourth_card_MUST22023_over100', SQLSTATE || ' ' || SQLERRM);
  END;
  BEGIN
    INSERT INTO phase_tasks (phase_id, subtask_id, site_id, name, weight_pts) VALUES
      (v_p1, v_s1, v_site, 'E1', 60), (v_p1, v_s1, v_site, 'E2', 41);
    r := r || jsonb_build_object('d_two_in_one_statement_101_MUST22023_over100', 'no error');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('d_two_in_one_statement_101_MUST22023_over100', SQLSTATE || ' ' || SQLERRM);
  END;
  SELECT count(*) INTO n FROM phase_tasks WHERE subtask_id = v_s1;
  r := r || jsonb_build_object('d_two_in_one_statement_rows_MUST0', n);

  -- (b) save_site_plan validation
  BEGIN
    v_ver := save_site_plan(v_site, 'first');
    r := r || jsonb_build_object('b_weights_90_MUST22023_sum', 'returned ' || v_ver);
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('b_weights_90_MUST22023_sum', SQLSTATE || ' ' || SQLERRM);
  END;
  UPDATE site_phases SET billing_weight_pct = 40 WHERE id = v_p2;
  UPDATE site_phases SET start_date = NULL WHERE id = v_p1;
  BEGIN
    v_ver := save_site_plan(v_site, 'first');
    r := r || jsonb_build_object('b_missing_date_MUST22023_dates', 'returned ' || v_ver);
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('b_missing_date_MUST22023_dates', SQLSTATE || ' ' || SQLERRM);
  END;
  UPDATE site_phases SET start_date = '2026-11-01' WHERE id = v_p1;
  BEGIN
    v_ver := save_site_plan(v_site, '  ');
    r := r || jsonb_build_object('b_no_note_MUST22023_note', 'returned ' || v_ver);
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('b_no_note_MUST22023_note', SQLSTATE || ' ' || SQLERRM);
  END;
  BEGIN
    v_ver := save_site_plan(v_fsite, 'x');
    r := r || jsonb_build_object('b_foreign_site_MUSTP0002', 'returned ' || v_ver);
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('b_foreign_site_MUSTP0002', SQLSTATE);
  END;
  v_ver := save_site_plan(v_site, 'PLAN v1');
  r := r || jsonb_build_object('b_first_save_MUST1', v_ver);
  v_ver := save_site_plan(v_site, 'PLAN v2');
  r := r || jsonb_build_object('b_second_save_MUST2', v_ver);
  SELECT tenant_id = v_tenant AND created_by = v_pm AND NOT is_auto AND note = 'PLAN v2' INTO b FROM site_plans WHERE site_id = v_site AND version = 2;
  r := r || jsonb_build_object('b_plan_row_tenant_by_note_MUSTtrue', b);
  SELECT count(*) FILTER (WHERE i.level = 'phase') = 2
     AND count(*) FILTER (WHERE i.level = 'subtask') = 1
     AND count(*) FILTER (WHERE i.level = 'task') = (SELECT count(*) FROM phase_tasks WHERE site_id = v_site AND issue_report_id IS NULL)
     AND count(*) FILTER (WHERE i.level = 'task') = 6
     AND NOT bool_or(i.ref_id IN (v_pi, v_issue_card))
    INTO b FROM site_plan_items i JOIN site_plans p ON p.id = i.plan_id WHERE p.site_id = v_site AND p.version = 2;
  r := r || jsonb_build_object('b_items_match_phases_and_cards_MUSTtrue', b);
  SELECT weight = 20 AND parent_ref_id = v_p1 AND start_date IS NULL INTO b
    FROM site_plan_items i JOIN site_plans p ON p.id = i.plan_id WHERE p.site_id = v_site AND p.version = 1 AND i.ref_id = v_a;
  r := r || jsonb_build_object('b_task_item_fields_MUSTtrue', b);
  SELECT weight = 60 AND start_date = '2026-11-01' AND end_date = '2026-11-30' INTO b
    FROM site_plan_items i JOIN site_plans p ON p.id = i.plan_id WHERE p.site_id = v_site AND p.version = 1 AND i.ref_id = v_p1;
  r := r || jsonb_build_object('b_phase_item_fields_MUSTtrue', b);

  -- (e) split (now the site has a PLAN); only a not_started card can be split
  UPDATE phase_tasks SET status = 'in_progress' WHERE id = v_a;
  BEGIN
    PERFORM split_task(v_a, '[{"name":"A-1","weight_pts":10},{"name":"A-2","weight_pts":10}]');
    r := r || jsonb_build_object('e_split_started_card_MUST22023_notstarted', 'no error');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('e_split_started_card_MUST22023_notstarted', SQLSTATE || ' ' || SQLERRM);
  END;
  UPDATE phase_tasks SET status = 'not_started' WHERE id = v_a;
  BEGIN
    PERFORM split_task(v_a, '[{"name":"A-1","weight_pts":10},{"name":"A-2","weight_pts":10}]');
    SELECT count(*) INTO n FROM phase_tasks WHERE parent_task_id = v_a AND status = 'not_started' AND phase_id = v_p1 AND site_id = v_site;
    SELECT status INTO v FROM phase_tasks WHERE id = v_a;
    r := r || jsonb_build_object('e_split_children_MUST2', n, 'e_parent_status_after_split_MUSTnot_started', v);
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('e_split_children_MUST2', SQLSTATE || ' ' || SQLERRM);
  END;
  SELECT id INTO v_c1 FROM phase_tasks WHERE parent_task_id = v_a ORDER BY sort_order LIMIT 1;
  SELECT id INTO v_c2 FROM phase_tasks WHERE parent_task_id = v_a ORDER BY sort_order DESC LIMIT 1;
  UPDATE phase_tasks SET status = 'done' WHERE id = v_c1;
  SELECT status INTO v FROM phase_tasks WHERE id = v_a;
  r := r || jsonb_build_object('e_parent_one_child_done_MUSTin_progress', v);
  UPDATE phase_tasks SET status = 'done' WHERE id = v_c2;
  SELECT status INTO v FROM phase_tasks WHERE id = v_a;
  r := r || jsonb_build_object('e_parent_all_children_done_MUSTdone', v);
  BEGIN
    UPDATE phase_tasks SET status = 'not_started' WHERE id = v_a;
    r := r || jsonb_build_object('e_parent_direct_status_MUST22023_parent', 'no error');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('e_parent_direct_status_MUST22023_parent', SQLSTATE || ' ' || SQLERRM);
  END;
  BEGIN
    PERFORM split_task(v_c1, '[{"name":"x","weight_pts":5},{"name":"y","weight_pts":5}]');
    r := r || jsonb_build_object('e_split_child_MUST22023', 'no error');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('e_split_child_MUST22023', SQLSTATE || ' ' || SQLERRM);
  END;
  BEGIN
    PERFORM split_task(v_b, '[{"name":"x","weight_pts":10},{"name":"y","weight_pts":9}]');
    r := r || jsonb_build_object('e_split_sum19_MUST22023', 'no error');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('e_split_sum19_MUST22023', SQLSTATE || ' ' || SQLERRM);
  END;
  BEGIN
    PERFORM split_task(v_b, '[{"name":"x","weight_pts":20}]');
    r := r || jsonb_build_object('e_split_one_child_MUST22023', 'no error');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('e_split_one_child_MUST22023', SQLSTATE || ' ' || SQLERRM);
  END;
  BEGIN
    PERFORM split_task(v_a, '[{"name":"x","weight_pts":10},{"name":"y","weight_pts":10}]');
    r := r || jsonb_build_object('e_split_parent_again_MUST22023', 'no error');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('e_split_parent_again_MUST22023', SQLSTATE || ' ' || SQLERRM);
  END;
  BEGIN
    INSERT INTO phase_tasks (phase_id, site_id, name, weight_pts, parent_task_id) VALUES (v_p1, v_site, 'A-3', 0.01, v_a);
    r := r || jsonb_build_object('e_child_over_parent_MUST22023_childsum', 'no error');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('e_child_over_parent_MUST22023_childsum', SQLSTATE || ' ' || SQLERRM);
  END;
  BEGIN
    INSERT INTO phase_tasks (phase_id, site_id, name, weight_pts, parent_task_id) VALUES (v_p1, v_site, 'A-1-1', 0, v_c1);
    r := r || jsonb_build_object('e_grandchild_MUST22023_onelevel', 'no error');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('e_grandchild_MUST22023_onelevel', SQLSTATE || ' ' || SQLERRM);
  END;

  -- (f) quantity card + BOQ
  INSERT INTO boq_items (site_id, code, description, unit, planned_qty) VALUES (v_site, '1', 'กระจก', 'ตร.ม.', 120) RETURNING id INTO v_boq;
  INSERT INTO phase_tasks (phase_id, site_id, name, weight_pts, progress_mode, planned_qty, boq_item_id)
    VALUES (v_p1, v_site, 'Q', 10, 'quantity', 120, v_boq) RETURNING id INTO v_q;
  v_r45 := record_progress(v_q, 45, NULL, 'day 1');
  SELECT done_qty || ' ' || status INTO v FROM phase_tasks WHERE id = v_q;
  r := r || jsonb_build_object('f_after_45_MUST45_in_progress', v);
  BEGIN
    PERFORM record_progress(v_q, 80, NULL, NULL);
    r := r || jsonb_build_object('f_record_80_MUST22023_remaining75', 'no error');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('f_record_80_MUST22023_remaining75', SQLSTATE || ' ' || SQLERRM);
  END;
  v_r75 := record_progress(v_q, 75, '2026-11-02', NULL);
  SELECT done_qty || ' ' || status INTO v FROM phase_tasks WHERE id = v_q;
  r := r || jsonb_build_object('f_after_75_MUST120_done', v);
  SELECT site_id = v_site AND work_date = '2026-11-02' AND created_by = v_pm INTO b FROM progress_reports WHERE id = v_r75;
  r := r || jsonb_build_object('f_report_fields_MUSTtrue', b);
  PERFORM cancel_progress(v_r75);
  SELECT done_qty || ' ' || status INTO v FROM phase_tasks WHERE id = v_q;
  r := r || jsonb_build_object('f_after_cancel_MUST45_in_progress', v);
  SELECT cancelled_by = v_pm AND cancelled_at IS NOT NULL INTO b FROM progress_reports WHERE id = v_r75;
  r := r || jsonb_build_object('f_cancel_fields_MUSTtrue', b);
  BEGIN
    PERFORM cancel_progress(v_r75);
    r := r || jsonb_build_object('f_cancel_twice_MUSTP0002', 'no error');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('f_cancel_twice_MUSTP0002', SQLSTATE);
  END;
  BEGIN
    UPDATE phase_tasks SET status = 'done' WHERE id = v_q;
    r := r || jsonb_build_object('f_direct_status_MUST22023_quantity', 'no error');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('f_direct_status_MUST22023_quantity', SQLSTATE || ' ' || SQLERRM);
  END;
  BEGIN
    INSERT INTO phase_tasks (phase_id, site_id, name, weight_pts, progress_mode, planned_qty, boq_item_id)
      VALUES (v_p1, v_site, 'Q2', 1, 'quantity', 1, v_boq);
    r := r || jsonb_build_object('f_second_card_over_boq_MUST22023_boq', 'no error');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('f_second_card_over_boq_MUST22023_boq', SQLSTATE || ' ' || SQLERRM);
  END;
  BEGIN
    PERFORM record_progress(v_b, 1, NULL, NULL);
    r := r || jsonb_build_object('f_record_on_status_card_MUST22023_notqty', 'no error');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('f_record_on_status_card_MUST22023_notqty', SQLSTATE || ' ' || SQLERRM);
  END;
  BEGIN
    INSERT INTO progress_reports (site_id, task_id, qty) VALUES (v_site, v_b, 1);
    r := r || jsonb_build_object('f_direct_insert_status_card_MUST22023_notqty', 'no error');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('f_direct_insert_status_card_MUST22023_notqty', SQLSTATE || ' ' || SQLERRM);
  END;
  BEGIN
    INSERT INTO progress_reports (site_id, task_id, qty) VALUES (v_site, v_q, 76);
    r := r || jsonb_build_object('f_direct_insert_over_MUST22023_remaining75', 'no error');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('f_direct_insert_over_MUST22023_remaining75', SQLSTATE || ' ' || SQLERRM);
  END;
  -- a forged site_id is replaced by the card's site
  INSERT INTO progress_reports (site_id, task_id, qty) VALUES (v_site2, v_q, 1) RETURNING id INTO v_rep;
  SELECT site_id = v_site INTO b FROM progress_reports WHERE id = v_rep;
  r := r || jsonb_build_object('f_forged_site_replaced_MUSTtrue', b);
  SELECT done_qty INTO x FROM phase_tasks WHERE id = v_q;
  r := r || jsonb_build_object('f_done_after_direct_MUST46', x);
  -- update lock (item 7)
  BEGIN
    UPDATE progress_reports SET qty = 2 WHERE id = v_r45;
    r := r || jsonb_build_object('f_update_qty_MUST22023', 'no error');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('f_update_qty_MUST22023', SQLSTATE || ' ' || SQLERRM);
  END;
  BEGIN
    UPDATE progress_reports SET cancelled_at = now(), cancelled_by = v_pm, note = 'sneaky' WHERE id = v_r45;
    r := r || jsonb_build_object('f_cancel_plus_note_MUST22023', 'no error');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('f_cancel_plus_note_MUST22023', SQLSTATE || ' ' || SQLERRM);
  END;

  -- fix round 1: progress_mode / done_qty / planned_qty guards (PM)
  INSERT INTO phase_tasks (phase_id, site_id, name, weight_pts, sort_order) VALUES (v_p1, v_site, 'F', 1, 40) RETURNING id INTO v_f;
  BEGIN
    UPDATE phase_tasks SET progress_mode = 'quantity', planned_qty = 10 WHERE id = v_f;
    SELECT progress_mode || ' ' || status INTO v FROM phase_tasks WHERE id = v_f;
    r := r || jsonb_build_object('r1_pm_mode_change_fresh_card_MUSTquantity_not_started', v);
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('r1_pm_mode_change_fresh_card_MUSTquantity_not_started', SQLSTATE || ' ' || SQLERRM);
  END;
  BEGIN
    UPDATE phase_tasks SET done_qty = 120 WHERE id = v_q;
    r := r || jsonb_build_object('r1_pm_done_qty_write_MUST22023', 'no error');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('r1_pm_done_qty_write_MUST22023', SQLSTATE || ' ' || SQLERRM);
  END;
  BEGIN
    UPDATE phase_tasks SET planned_qty = 40 WHERE id = v_q;
    r := r || jsonb_build_object('r1_planned_below_done_MUST22023_belowdone', 'no error');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('r1_planned_below_done_MUST22023_belowdone', SQLSTATE || ' ' || SQLERRM);
  END;
  INSERT INTO phase_tasks (phase_id, site_id, name, weight_pts, progress_mode, planned_qty, sort_order)
    VALUES (v_p1, v_site, 'Q3', 1, 'quantity', 10, 50) RETURNING id INTO v_q3;
  PERFORM record_progress(v_q3, 10, NULL, NULL);
  SELECT status INTO v FROM phase_tasks WHERE id = v_q3;
  r := r || jsonb_build_object('r1_q3_full_MUSTdone', v);
  BEGIN
    UPDATE phase_tasks SET planned_qty = 12 WHERE id = v_q3;
    SELECT done_qty || ' ' || status INTO v FROM phase_tasks WHERE id = v_q3;
    r := r || jsonb_build_object('r1_planned_raised_MUST10_in_progress', v);
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('r1_planned_raised_MUST10_in_progress', SQLSTATE || ' ' || SQLERRM);
  END;
  BEGIN
    UPDATE phase_tasks SET planned_qty = 10 WHERE id = v_q3;
    SELECT status INTO v FROM phase_tasks WHERE id = v_q3;
    r := r || jsonb_build_object('r1_planned_back_to_done_MUSTdone', v);
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('r1_planned_back_to_done_MUSTdone', SQLSTATE || ' ' || SQLERRM);
  END;
  BEGIN
    UPDATE phase_tasks SET progress_mode = 'quantity', planned_qty = 5 WHERE id = v_a;
    r := r || jsonb_build_object('r1_pm_mode_change_parent_MUST22023_parentmode', 'no error');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('r1_pm_mode_change_parent_MUST22023_parentmode', SQLSTATE || ' ' || SQLERRM);
  END;

  -- final-review fixes (PM)
  BEGIN
    UPDATE phase_tasks SET planned_qty = 110 WHERE id = v_q;
    SELECT trim_scale(planned_qty) || ' ' || status INTO v FROM phase_tasks WHERE id = v_q;
    r := r || jsonb_build_object('i2_pm_lowers_planned_with_done_MUST110_in_progress', v);
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('i2_pm_lowers_planned_with_done_MUST110_in_progress', SQLSTATE || ' ' || SQLERRM);
  END;
  BEGIN
    DELETE FROM phase_tasks WHERE id = v_q;
    r := r || jsonb_build_object('i3_delete_card_with_reports_MUST22023_history', 'no error');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('i3_delete_card_with_reports_MUST22023_history', SQLSTATE || ' ' || SQLERRM);
  END;
  BEGIN
    UPDATE progress_reports SET cancelled_at = now(), cancelled_by = 'forged@example.invalid' WHERE id = v_rep;
    SELECT cancelled_by INTO v FROM progress_reports WHERE id = v_rep;
    r := r || jsonb_build_object('d_cancelled_by_is_caller_MUSTtrue', v = v_pm);
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('d_cancelled_by_is_caller_MUSTtrue', SQLSTATE || ' ' || SQLERRM);
  END;

  -- cross-tenant references (controller ruling 1)
  BEGIN
    INSERT INTO boq_items (site_id, code, description, planned_qty) VALUES (v_fsite, 'Z', 'forged', 1);
    r := r || jsonb_build_object('x_boq_foreign_site_MUST42501_trigger', 'no error');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('x_boq_foreign_site_MUST42501_trigger', SQLSTATE || ' ' || SQLERRM);
  END;
  BEGIN
    INSERT INTO progress_reports (site_id, task_id, qty) VALUES (v_site, v_fcard, 1);
    r := r || jsonb_build_object('x_report_foreign_card_MUST42501_trigger', 'no error');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('x_report_foreign_card_MUST42501_trigger', SQLSTATE || ' ' || SQLERRM);
  END;
  BEGIN
    UPDATE phase_tasks SET boq_item_id = v_boq_foreign WHERE id = v_b;
    r := r || jsonb_build_object('x_card_foreign_boq_MUST42501_trigger', 'no error');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('x_card_foreign_boq_MUST42501_trigger', SQLSTATE || ' ' || SQLERRM);
  END;
  BEGIN
    UPDATE phase_tasks SET boq_item_id = v_boq_other_site WHERE id = v_b;
    r := r || jsonb_build_object('x_card_other_site_boq_MUST42501_trigger', 'no error');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('x_card_other_site_boq_MUST42501_trigger', SQLSTATE || ' ' || SQLERRM);
  END;
  BEGIN
    INSERT INTO phase_tasks (phase_id, site_id, name, weight_pts, parent_task_id) VALUES (v_p1, v_site, 'forged child', 0, v_fcard);
    r := r || jsonb_build_object('x_card_foreign_parent_MUST42501_trigger', 'no error');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('x_card_foreign_parent_MUST42501_trigger', SQLSTATE || ' ' || SQLERRM);
  END;

  -- ===== OWNER: (c) PLAN immutable; (h) quotation -> BOQ =====
  PERFORM set_config('request.jwt.claims', json_build_object('email', v_owner, 'role', 'authenticated', 'sub', gen_random_uuid())::text, true);
  BEGIN
    UPDATE site_plans SET note = 'owner edit' WHERE site_id = v_site;
    r := r || jsonb_build_object('c_owner_update_plan_MUST42501', 'no error');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('c_owner_update_plan_MUST42501', SQLSTATE);
  END;
  BEGIN
    DELETE FROM site_plans WHERE site_id = v_site;
    r := r || jsonb_build_object('c_owner_delete_plan_MUST42501', 'no error');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('c_owner_delete_plan_MUST42501', SQLSTATE);
  END;
  BEGIN
    DELETE FROM site_plan_items WHERE plan_id IN (SELECT id FROM site_plans WHERE site_id = v_site);
    r := r || jsonb_build_object('c_owner_delete_plan_items_MUST42501', 'no error');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('c_owner_delete_plan_items_MUST42501', SQLSTATE);
  END;
  BEGIN
    PERFORM snapshot_site_plan(v_site, 'direct', false, 'x');
    r := r || jsonb_build_object('c_owner_call_snapshot_MUST42501', 'no error');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('c_owner_call_snapshot_MUST42501', SQLSTATE);
  END;
  BEGIN
    PERFORM boq_insert_for_quotation(gen_random_uuid());
    r := r || jsonb_build_object('c_owner_call_boq_insert_MUST42501', 'no error');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('c_owner_call_boq_insert_MUST42501', SQLSTATE);
  END;

  -- ===== ADMIN: (g) =====
  PERFORM set_config('request.jwt.claims', json_build_object('email', v_admin, 'role', 'authenticated', 'sub', gen_random_uuid())::text, true);
  BEGIN
    PERFORM record_progress(v_q, 1, NULL, NULL);
    r := r || jsonb_build_object('g_admin_record_MUST42501', 'no error');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('g_admin_record_MUST42501', SQLSTATE);
  END;
  BEGIN
    PERFORM save_site_plan(v_site, 'admin');
    r := r || jsonb_build_object('g_admin_save_plan_MUST42501', 'no error');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('g_admin_save_plan_MUST42501', SQLSTATE);
  END;
  BEGIN
    PERFORM cancel_progress(v_r45);
    r := r || jsonb_build_object('g_admin_cancel_MUST42501', 'no error');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('g_admin_cancel_MUST42501', SQLSTATE);
  END;
  BEGIN
    UPDATE phase_tasks SET progress_mode = 'status' WHERE id = v_q;
    r := r || jsonb_build_object('r1_admin_mode_change_with_reports_MUST22023', 'no error');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('r1_admin_mode_change_with_reports_MUST22023', SQLSTATE || ' ' || SQLERRM);
  END;
  BEGIN
    UPDATE phase_tasks SET progress_mode = 'status', status = 'done' WHERE id = v_q;
    r := r || jsonb_build_object('r1_admin_flip_and_done_MUST22023', 'no error');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('r1_admin_flip_and_done_MUST22023', SQLSTATE || ' ' || SQLERRM);
  END;
  BEGIN
    UPDATE phase_tasks SET planned_qty = 45 WHERE id = v_q;
    r := r || jsonb_build_object('i2_admin_lowers_planned_with_done_MUST22023_ownerpm', 'no error');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('i2_admin_lowers_planned_with_done_MUST22023_ownerpm', SQLSTATE || ' ' || SQLERRM);
  END;
  BEGIN
    UPDATE phase_tasks SET planned_qty = 8 WHERE id = v_f;
    SELECT trim_scale(planned_qty)::text INTO v FROM phase_tasks WHERE id = v_f;
    r := r || jsonb_build_object('i2_admin_planned_no_done_MUST8', v);
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('i2_admin_planned_no_done_MUST8', SQLSTATE || ' ' || SQLERRM);
  END;

  -- ===== WORKER: (i) assigned status card on a site with a PLAN =====
  RESET ROLE;
  INSERT INTO phase_task_workers (task_id, worker_id) VALUES (v_wcard, v_worker), (v_q, v_worker);
  PERFORM set_config('request.jwt.claims', json_build_object('email', v_wk, 'role', 'authenticated', 'sub', gen_random_uuid())::text, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    UPDATE phase_tasks SET status = 'in_progress' WHERE id = v_wcard;
    GET DIAGNOSTICS n = ROW_COUNT;
    SELECT status INTO v FROM phase_tasks WHERE id = v_wcard;
    r := r || jsonb_build_object('i_worker_status_card_MUSTin_progress', v, 'i_worker_rows_MUST1', n);
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('i_worker_status_card_MUSTin_progress', SQLSTATE || ' ' || SQLERRM);
  END;
  BEGIN
    UPDATE phase_tasks SET status = 'done' WHERE id = v_q;
    r := r || jsonb_build_object('i_worker_quantity_card_MUST22023_quantity', 'no error');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('i_worker_quantity_card_MUST22023_quantity', SQLSTATE || ' ' || SQLERRM);
  END;
  BEGIN
    UPDATE phase_tasks SET progress_mode = 'status', status = 'done' WHERE id = v_q;
    r := r || jsonb_build_object('r1_worker_flip_and_done_MUST22023', 'no error');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('r1_worker_flip_and_done_MUST22023', SQLSTATE || ' ' || SQLERRM);
  END;
  BEGIN
    UPDATE phase_tasks SET done_qty = 120 WHERE id = v_q;
    r := r || jsonb_build_object('r1_worker_done_qty_write_MUST22023', 'no error');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('r1_worker_done_qty_write_MUST22023', SQLSTATE || ' ' || SQLERRM);
  END;
  BEGIN
    UPDATE phase_tasks SET planned_qty = 46 WHERE id = v_q;
    r := r || jsonb_build_object('r1_worker_planned_qty_MUST22023', 'no error');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('r1_worker_planned_qty_MUST22023', SQLSTATE || ' ' || SQLERRM);
  END;
  BEGIN
    UPDATE phase_tasks SET weight_pts = 6 WHERE id = v_wcard;
    r := r || jsonb_build_object('a2_worker_weight_MUST22023_staff', 'no error');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('a2_worker_weight_MUST22023_staff', SQLSTATE || ' ' || SQLERRM);
  END;
  BEGIN
    UPDATE phase_tasks SET boq_item_id = NULL WHERE id = v_q;
    r := r || jsonb_build_object('a2_worker_boq_item_MUST22023_staff', 'no error');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('a2_worker_boq_item_MUST22023_staff', SQLSTATE || ' ' || SQLERRM);
  END;
  BEGIN
    UPDATE phase_tasks SET parent_task_id = v_b WHERE id = v_wcard;
    r := r || jsonb_build_object('a2_worker_parent_MUST22023_staff', 'no error');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('a2_worker_parent_MUST22023_staff', SQLSTATE || ' ' || SQLERRM);
  END;

  -- ===== table owner: un-cancel lock, quotation -> BOQ, privileges =====
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);
  BEGIN
    UPDATE progress_reports SET cancelled_at = NULL, cancelled_by = NULL WHERE id = v_r75;
    r := r || jsonb_build_object('f_uncancel_as_table_owner_MUST22023', 'no error');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('f_uncancel_as_table_owner_MUST22023', SQLSTATE || ' ' || SQLERRM);
  END;
  INSERT INTO quotations (tenant_id, client_id, site_id, date, status, quotation_number)
    VALUES (v_tenant, v_client, v_site, current_date, 'sent', 'GT-Q-08') RETURNING id INTO v_quot;
  INSERT INTO quotation_items (tenant_id, quotation_id, description, unit, quantity, sort_order, item_type) VALUES
    (v_tenant, v_quot, E'ติดตั้งกระจก\nรายละเอียดบรรทัดสอง', 'ตร.ม.', 50, 1, 'item') RETURNING id INTO v_qi1;
  INSERT INTO quotation_items (tenant_id, quotation_id, description, unit, quantity, sort_order, item_type) VALUES
    (v_tenant, v_quot, 'หมายเหตุ ไม่ใช่งาน', NULL, 1, 2, 'note');
  INSERT INTO quotation_items (tenant_id, quotation_id, description, unit, quantity, sort_order, item_type) VALUES
    (v_tenant, v_quot, 'อลูมิเนียม', 'ม.', 12.5, 3, 'item') RETURNING id INTO v_qi2;
  PERFORM set_config('request.jwt.claims', json_build_object('email', v_owner, 'role', 'authenticated', 'sub', gen_random_uuid())::text, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    UPDATE quotations SET status = 'accepted' WHERE id = v_quot;
    GET DIAGNOSTICS n = ROW_COUNT;
    r := r || jsonb_build_object('h_owner_accept_rows_MUST1', n);
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('h_owner_accept_rows_MUST1', SQLSTATE || ' ' || SQLERRM);
  END;
  RESET ROLE;
  SELECT count(*) INTO n FROM boq_items WHERE site_id = v_site AND quotation_item_id IN (v_qi1, v_qi2);
  r := r || jsonb_build_object('h_boq_rows_MUST2', n);
  SELECT string_agg(code || '|' || description || '|' || COALESCE(unit, '') || '|' || planned_qty || '|' || (tenant_id = v_tenant)::text, ';' ORDER BY code)
    INTO v FROM boq_items WHERE site_id = v_site AND quotation_item_id IS NOT NULL;
  r := r || jsonb_build_object('h_boq_rows_detail', v);
  SELECT string_agg(code || '|' || description || '|' || COALESCE(unit, '') || '|' || trim_scale(planned_qty), ';' ORDER BY code) = '2|ติดตั้งกระจก|ตร.ม.|50;3|อลูมิเนียม|ม.|12.5'
    INTO b FROM boq_items WHERE site_id = v_site AND quotation_item_id IS NOT NULL;
  r := r || jsonb_build_object('h_boq_codes_desc_unit_qty_MUSTtrue', b);
  UPDATE quotations SET status = 'sent' WHERE id = v_quot;
  UPDATE quotations SET status = 'accepted' WHERE id = v_quot;
  SELECT count(*) INTO n FROM boq_items WHERE site_id = v_site AND quotation_item_id IS NOT NULL;
  r := r || jsonb_build_object('h_reaccept_no_duplicates_MUST2', n);
  SELECT boq_insert_for_quotation(v_quot) INTO n;
  r := r || jsonb_build_object('h_direct_rerun_rows_MUST0', n);

  -- ===== boq_refresh_from_quotations (BOQ tab button) =====
  INSERT INTO quotation_items (tenant_id, quotation_id, description, unit, quantity, sort_order, item_type)
    VALUES (v_tenant, v_quot, 'เพิ่มภายหลัง', 'ชุด', 3, 4, 'item');
  PERFORM set_config('request.jwt.claims', json_build_object('email', v_pm, 'role', 'authenticated', 'sub', gen_random_uuid())::text, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    SELECT boq_refresh_from_quotations(v_site) INTO n;
    r := r || jsonb_build_object('rf_pm_refresh_adds_MUST1', n);
    SELECT boq_refresh_from_quotations(v_site) INTO n;
    r := r || jsonb_build_object('rf_pm_rerun_adds_MUST0', n);
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('rf_pm_refresh_MUST1', SQLSTATE || ' ' || SQLERRM);
  END;
  BEGIN
    PERFORM boq_refresh_from_quotations(v_fsite);
    r := r || jsonb_build_object('rf_pm_foreign_site_MUSTP0002', 'no error');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('rf_pm_foreign_site_MUSTP0002', SQLSTATE);
  END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', json_build_object('email', v_wk, 'role', 'authenticated', 'sub', gen_random_uuid())::text, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM boq_refresh_from_quotations(v_site);
    r := r || jsonb_build_object('rf_worker_MUST42501', 'no error');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('rf_worker_MUST42501', SQLSTATE);
  END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);
  SELECT has_function_privilege('authenticated', 'public.boq_refresh_from_quotations(uuid)', 'EXECUTE')
     AND NOT has_function_privilege('anon', 'public.boq_refresh_from_quotations(uuid)', 'EXECUTE') INTO b;
  r := r || jsonb_build_object('rf_grants_MUSTtrue', b);

  -- (f) a quotation update that changes neither status nor site does not re-pull BOQ lines
  DELETE FROM boq_items WHERE site_id = v_site AND quotation_item_id = v_qi2;
  UPDATE quotations SET status = status, site_id = site_id, notes = 'touch' WHERE id = v_quot;
  SELECT count(*) INTO n FROM boq_items WHERE site_id = v_site AND quotation_item_id = v_qi2;
  r := r || jsonb_build_object('f2_quotation_touch_no_repull_MUST0', n);

  -- I3: deleting a whole site still cascades through a card with progress reports
  INSERT INTO sites (tenant_id, site_number, name) VALUES (v_tenant, 'GT-TEST-08D', 'gantt delete site') RETURNING id INTO v_dsite;
  INSERT INTO site_phases (tenant_id, site_id, name, sort_order, start_date, end_date, billing_weight_pct) VALUES
    (v_tenant, v_dsite, 'D', 1, '2026-11-01', '2026-11-30', 100) RETURNING id INTO v_dphase;
  PERFORM snapshot_site_plan(v_dsite, 'test', true, 'system');
  INSERT INTO phase_tasks (tenant_id, phase_id, site_id, name, weight_pts, progress_mode, planned_qty)
    VALUES (v_tenant, v_dphase, v_dsite, 'DQ', 100, 'quantity', 10) RETURNING id INTO v_dcard;
  INSERT INTO progress_reports (tenant_id, site_id, task_id, qty) VALUES (v_tenant, v_dsite, v_dcard, 3);
  BEGIN
    DELETE FROM phase_tasks WHERE id = v_dcard;
    r := r || jsonb_build_object('i3_owner_delete_card_with_reports_MUST22023_history', 'no error');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('i3_owner_delete_card_with_reports_MUST22023_history', SQLSTATE || ' ' || SQLERRM);
  END;
  BEGIN
    DELETE FROM sites WHERE id = v_dsite;
    SELECT count(*) INTO n FROM phase_tasks WHERE id = v_dcard;
    r := r || jsonb_build_object('i3_site_delete_cascades_card_MUST0', n);
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('i3_site_delete_cascades_card_MUST0', SQLSTATE || ' ' || SQLERRM);
  END;

  -- I4: no new trigger/RPC takes FOR UPDATE on a row a child FK key-share locks
  SELECT NOT bool_or(p.prosrc ~* 'for\s+update') AND bool_and(p.prosrc ~* 'for no key update') INTO b FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('check_node_weights','check_boq_qty','progress_report_refs','record_progress','split_task');
  r := r || jsonb_build_object('i4_no_key_update_locks_MUSTtrue', b);

  SELECT has_table_privilege('authenticated', 'public.site_plans', 'TRUNCATE')
      OR has_table_privilege('authenticated', 'public.site_plan_items', 'TRUNCATE')
      OR has_table_privilege('authenticated', 'public.progress_reports', 'TRUNCATE')
      OR has_table_privilege('anon', 'public.progress_reports', 'TRUNCATE') INTO b;
  r := r || jsonb_build_object('priv_truncate_MUSTfalse', b);
  SELECT bool_or(has_function_privilege('anon', p.oid, 'EXECUTE')) INTO b FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('site_has_plan','snapshot_site_plan','save_site_plan','require_site_plan',
     'check_boq_item_refs','check_task_refs','check_node_weights','check_boq_qty','progress_report_refs','progress_report_cancel_only',
     'sync_task_qty','record_progress','cancel_progress','guard_derived_status','set_parent_status_from_children','sync_parent_status',
     'split_task','boq_insert_for_quotation','boq_from_quotation','keep_progress_history');
  r := r || jsonb_build_object('priv_anon_execute_any_MUSTfalse', b);
  SELECT has_function_privilege('authenticated', 'public.snapshot_site_plan(uuid,text,boolean,text)', 'EXECUTE')
      OR has_function_privilege('authenticated', 'public.boq_insert_for_quotation(uuid)', 'EXECUTE')
      OR has_function_privilege('authenticated', 'public.site_has_plan(uuid)', 'EXECUTE') INTO b;
  r := r || jsonb_build_object('priv_authenticated_internal_MUSTfalse', b);
  SELECT has_function_privilege('authenticated', 'public.save_site_plan(uuid,text)', 'EXECUTE')
     AND has_function_privilege('authenticated', 'public.record_progress(uuid,numeric,date,text)', 'EXECUTE')
     AND has_function_privilege('authenticated', 'public.cancel_progress(uuid)', 'EXECUTE')
     AND has_function_privilege('authenticated', 'public.split_task(uuid,jsonb)', 'EXECUTE') INTO b;
  r := r || jsonb_build_object('priv_authenticated_rpcs_MUSTtrue', b);

  -- check: this RAISE is load-bearing. It aborts the DO block so none of the
  -- rows written above survive, and it is how the RESULT reaches the output.
  -- The ROLLBACK below then undoes the inlined DDL. Never remove either.
  RAISE EXCEPTION 'RESULT %', r;
END $$;
ROLLBACK;
