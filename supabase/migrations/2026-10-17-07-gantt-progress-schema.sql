-- Gantt weighted progress: schema. Spec docs/superpowers/specs/2026-10-17-gantt-weighted-progress-design.md §3-§6
-- Tables boq_items, progress_reports, site_plans, site_plan_items, phase_vo_values;
-- weight and quantity columns on phase_tasks; is_vo/vo_ref on site_phases; helper
-- can_manage_plan() (OWNER/PM). progress_reports.qty is > 0 (spec said <> 0):
-- a wrong entry is cancelled, never offset by a negative row.
-- Two card kinds (owner decision 2026-10-18), told apart by progress_mode:
--   'quantity' = BOQ card: needs a BOQ line and a planned_qty, counts toward progress;
--   'status'   = general card: 0 points, never counts (migration 08 forces the 0).
-- A BOQ line with cards cannot be deleted (trigger message + FK), so a BOQ card never
-- loses its line and the CHECK below always holds.
-- Rolled-back check: supabase/tests/2026-10-17-07-gantt-progress-schema.test.sql
BEGIN;

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
    CHECK (progress_mode = 'status' OR (boq_item_id IS NOT NULL AND planned_qty IS NOT NULL));
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
COMMIT;
