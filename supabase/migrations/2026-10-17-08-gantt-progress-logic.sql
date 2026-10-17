-- Gantt weighted progress: integrity triggers and RPCs. Spec docs/superpowers/specs/2026-10-17-gantt-weighted-progress-design.md
-- Needs migration 07. Rules layer: PLAN snapshot/save/gate, point limits, BOQ quantity
-- limits, quantity-driven status, split, quotation -> BOQ, cross-tenant reference checks.
-- Thai messages are matched by the app (Task 9): change them only together.
-- Trigger functions that must see rows the caller's RLS hides (WORKER moving an
-- assigned card, parent/child sums) are SECURITY DEFINER and always filter by
-- the row's own tenant_id. Status triggers use WHEN (status changed) because the
-- app sends full-row upserts (PhaseManageModal) that list status unchanged.
-- Rolled-back check: supabase/tests/2026-10-17-08-gantt-progress-logic.test.sql
BEGIN;

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

-- 3. PLAN gate: no progress before PLAN v1 (issue phases/cards exempt)
CREATE OR REPLACE FUNCTION public.require_site_plan() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
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

-- 4. point limits (re-summed under a lock on the node's phase row)
CREATE OR REPLACE FUNCTION public.check_node_weights() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_sum numeric; v_parent phase_tasks%ROWTYPE;
BEGIN
  PERFORM 1 FROM site_phases WHERE id = NEW.phase_id FOR UPDATE;
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
  SELECT planned_qty INTO v_limit FROM boq_items WHERE id = NEW.boq_item_id AND tenant_id = NEW.tenant_id FOR UPDATE;
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
  SELECT * INTO t FROM phase_tasks WHERE id = NEW.task_id AND tenant_id = NEW.tenant_id FOR UPDATE;
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
  SELECT * INTO t FROM phase_tasks WHERE id = p_task_id FOR UPDATE;
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
-- in the same UPDATE as the status cannot bypass the guard.
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
CREATE TRIGGER trg_guard_derived_status BEFORE UPDATE OF status, done_qty, progress_mode, planned_qty ON phase_tasks
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.done_qty IS DISTINCT FROM NEW.done_qty
                     OR OLD.progress_mode IS DISTINCT FROM NEW.progress_mode OR OLD.planned_qty IS DISTINCT FROM NEW.planned_qty)
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

-- 10. split a card one level (SECURITY INVOKER)
CREATE OR REPLACE FUNCTION public.split_task(p_task_id uuid, p_children jsonb)
  RETURNS void LANGUAGE plpgsql SET search_path = public
AS $$
DECLARE t phase_tasks%ROWTYPE; v_sum numeric; c record; v_prev text := current_setting('app.derived_status', true);
BEGIN
  SELECT * INTO t FROM phase_tasks WHERE id = p_task_id FOR UPDATE;
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
  -- children start not_started; the parent follows them (same rule as sync_parent_status)
  PERFORM set_config('app.derived_status', '1', true);
  UPDATE phase_tasks SET status = 'not_started' WHERE id = t.id AND status <> 'not_started';
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
  FOR EACH ROW WHEN (NEW.status = 'accepted' AND NEW.site_id IS NOT NULL) EXECUTE FUNCTION boq_from_quotation();

-- deferred minor from Task 1 review
REVOKE TRUNCATE ON site_plans, site_plan_items, progress_reports FROM authenticated, anon;
COMMIT;
