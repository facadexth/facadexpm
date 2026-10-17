-- Rolled-back check for supabase/migrations/2026-10-17-07-gantt-progress-schema.sql.
-- Run: npx supabase db query --linked -f supabase/tests/2026-10-17-07-gantt-progress-schema.test.sql
-- 04/05/06 are already applied live, so only the 07 body is inlined below,
-- byte-identical to its file between BEGIN; and COMMIT;. Keep them in sync.
-- The DO block ends in RAISE EXCEPTION 'RESULT ...', so nothing persists.
-- Expected: *_MUST0 is 0, *_MUSTfalse is false, *_MUSTtrue is true,
-- *_MUST42501 is '42501', w_* writes 'ok'.
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
  ADD COLUMN vo_value numeric NULL CHECK (vo_value IS NULL OR vo_value >= 0),
  ADD COLUMN vo_ref text NULL;

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

-- boq_items: site staff read/write within tenant
CREATE POLICY site_staff_all ON boq_items FOR ALL
  USING (( SELECT is_site_staff() ) AND tenant_id = ( SELECT current_tenant_id() ))
  WITH CHECK (( SELECT is_site_staff() ) AND tenant_id = ( SELECT current_tenant_id() ) AND ( SELECT tenant_can_write() ));
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
-- ===== end of 07 body =====

DO $$
DECLARE
  v_tenant uuid; r jsonb := '{}'; n int; b boolean;
  v_pm text := 'gantt-test-pm@example.invalid'; v_admin text := 'gantt-test-admin@example.invalid';
  v_wk text := 'gantt-test-worker@example.invalid'; v_owner text; cols jsonb;
  v_site uuid; v_task uuid; v_task_site uuid; v_plan uuid; v_boq uuid; v_rep uuid;
BEGIN
  -- ===== as the table owner: fixtures in the demo tenant =====
  SELECT id INTO v_tenant FROM tenants WHERE company_name ILIKE '%สร้างดี%' LIMIT 1;
  SELECT id INTO v_site FROM sites WHERE tenant_id = v_tenant ORDER BY created_at LIMIT 1;
  SELECT id, site_id INTO v_task, v_task_site FROM phase_tasks WHERE tenant_id = v_tenant ORDER BY created_at LIMIT 1;
  SELECT user_email INTO v_owner FROM user_roles WHERE tenant_id = v_tenant AND role = 'OWNER' AND status = 'approved' LIMIT 1;
  r := r || jsonb_build_object('tenant', v_tenant, 'site_found_MUSTtrue', v_site IS NOT NULL,
         'task_found_MUSTtrue', v_task IS NOT NULL, 'owner_found_MUSTtrue', v_owner IS NOT NULL);
  INSERT INTO user_roles (user_email, role, tenant_id, status) VALUES
    (v_pm, 'PM', v_tenant, 'approved'), (v_admin, 'ADMIN', v_tenant, 'approved'), (v_wk, 'WORKER', v_tenant, 'approved');
  -- a PLAN row so the WORKER-sees-0 and staff-reads checks are not vacuous
  INSERT INTO site_plans (tenant_id, site_id, version, note, is_auto, created_by)
    VALUES (v_tenant, v_site, 1, 'test plan', true, 'test') RETURNING id INTO v_plan;
  INSERT INTO site_plan_items (plan_id, level, ref_id, name) VALUES (v_plan, 'task', v_task, 'test item');

  -- ===== new columns and defaults =====
  SELECT jsonb_object_agg(table_name || '.' || column_name,
           COALESCE(column_default, 'NULL') || CASE WHEN is_nullable = 'NO' THEN ' NOT NULL' ELSE '' END)
    INTO cols FROM information_schema.columns
    WHERE table_schema = 'public' AND (table_name, column_name) IN
      (('phase_tasks','weight_pts'),('phase_tasks','progress_mode'),('phase_tasks','parent_task_id'),('phase_tasks','boq_item_id'),
       ('phase_tasks','planned_qty'),('phase_tasks','done_qty'),('site_phases','is_vo'),('site_phases','vo_value'),('site_phases','vo_ref'));
  r := r || jsonb_build_object('columns', cols);
  SELECT count(*) = 9 INTO b FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND (
      (c.table_name = 'phase_tasks' AND c.column_name = 'weight_pts' AND c.column_default = '0' AND c.is_nullable = 'NO' AND c.numeric_precision = 6 AND c.numeric_scale = 2)
   OR (c.table_name = 'phase_tasks' AND c.column_name = 'progress_mode' AND c.column_default = '''status''::text' AND c.is_nullable = 'NO')
   OR (c.table_name = 'phase_tasks' AND c.column_name = 'parent_task_id' AND c.column_default IS NULL AND c.is_nullable = 'YES')
   OR (c.table_name = 'phase_tasks' AND c.column_name = 'boq_item_id' AND c.column_default IS NULL AND c.is_nullable = 'YES')
   OR (c.table_name = 'phase_tasks' AND c.column_name = 'planned_qty' AND c.column_default IS NULL AND c.is_nullable = 'YES')
   OR (c.table_name = 'phase_tasks' AND c.column_name = 'done_qty' AND c.column_default = '0' AND c.is_nullable = 'NO')
   OR (c.table_name = 'site_phases' AND c.column_name = 'is_vo' AND c.column_default = 'false' AND c.is_nullable = 'NO')
   OR (c.table_name = 'site_phases' AND c.column_name = 'vo_value' AND c.column_default IS NULL AND c.is_nullable = 'YES')
   OR (c.table_name = 'site_phases' AND c.column_name = 'vo_ref' AND c.column_default IS NULL AND c.is_nullable = 'YES'));
  r := r || jsonb_build_object('new_columns_with_defaults_MUSTtrue', b);
  -- existing cards pick up the defaults
  SELECT count(*) INTO n FROM phase_tasks WHERE weight_pts <> 0 OR progress_mode <> 'status' OR done_qty <> 0
    OR parent_task_id IS NOT NULL OR boq_item_id IS NOT NULL OR planned_qty IS NOT NULL;
  r := r || jsonb_build_object('existing_cards_not_default_MUST0', n);
  SELECT count(*) INTO n FROM site_phases WHERE is_vo OR vo_value IS NOT NULL OR vo_ref IS NOT NULL;
  r := r || jsonb_build_object('existing_phases_not_default_MUST0', n);
  SELECT relrowsecurity INTO b FROM pg_class WHERE oid = 'public.boq_items'::regclass;
  SELECT b AND bool_and(relrowsecurity) INTO b FROM pg_class
    WHERE oid IN ('public.progress_reports'::regclass, 'public.site_plans'::regclass, 'public.site_plan_items'::regclass);
  r := r || jsonb_build_object('rls_enabled_all_four_MUSTtrue', b);
  -- check constraints
  BEGIN
    UPDATE phase_tasks SET progress_mode = 'quantity' WHERE id = v_task;
    r := r || jsonb_build_object('quantity_without_plan_23514_MUSTtrue', false);
  EXCEPTION WHEN SQLSTATE '23514' THEN r := r || jsonb_build_object('quantity_without_plan_23514_MUSTtrue', true);
  END;

  -- no new policy reads its own table (42P17 recursion)
  SELECT count(*) INTO n FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
    WHERE c.relname IN ('boq_items','progress_reports','site_plans','site_plan_items')
      AND (COALESCE(pg_get_expr(p.polqual, p.polrelid), '') || ' ' || COALESCE(pg_get_expr(p.polwithcheck, p.polrelid), ''))
          ~* ('from\s+(public\.)?' || c.relname || '\M');
  r := r || jsonb_build_object('policies_self_reference_MUST0', n);
  SELECT count(*) INTO n FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
    WHERE c.relname IN ('boq_items','progress_reports','site_plans','site_plan_items');
  r := r || jsonb_build_object('policy_count', n);
  SELECT has_function_privilege('anon', 'public.can_manage_plan()', 'EXECUTE') INTO b;
  r := r || jsonb_build_object('anon_execute_can_manage_plan_MUSTfalse', b);
  SELECT has_table_privilege('authenticated', 'public.site_plans', 'UPDATE')
      OR has_table_privilege('authenticated', 'public.site_plans', 'DELETE')
      OR has_table_privilege('authenticated', 'public.site_plans', 'INSERT')
      OR has_table_privilege('authenticated', 'public.site_plan_items', 'UPDATE')
      OR has_table_privilege('authenticated', 'public.site_plan_items', 'DELETE')
      OR has_table_privilege('authenticated', 'public.site_plan_items', 'INSERT')
      OR has_table_privilege('authenticated', 'public.progress_reports', 'DELETE') INTO b;
  r := r || jsonb_build_object('authenticated_plan_write_or_report_delete_priv_MUSTfalse', b);

  -- ===== PM: boq_items read/write, progress_reports insert + cancel =====
  PERFORM set_config('request.jwt.claims', json_build_object('email', v_pm, 'role', 'authenticated', 'sub', gen_random_uuid())::text, true);
  SET LOCAL ROLE authenticated;
  r := r || jsonb_build_object('pm_current_tenant_ok_MUSTtrue', current_tenant_id() = v_tenant, 'pm_can_manage_plan_MUSTtrue', can_manage_plan());
  BEGIN
    INSERT INTO boq_items (site_id, code, description, unit, planned_qty) VALUES (v_site, 'T-01', 'test boq', 'ตร.ม.', 120)
      RETURNING id INTO v_boq;
    r := r || jsonb_build_object('w_pm_boq_insert', 'ok');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('w_pm_boq_insert', SQLSTATE || ' ' || SQLERRM);
  END;
  SELECT count(*) INTO n FROM boq_items WHERE id = v_boq AND tenant_id = v_tenant;
  r := r || jsonb_build_object('pm_boq_select_own_row_MUSTtrue', n = 1);
  BEGIN
    INSERT INTO progress_reports (site_id, task_id, qty, note) VALUES (v_task_site, v_task, 10, 'test') RETURNING id INTO v_rep;
    SELECT source = 'web' AND created_by = v_pm AND tenant_id = v_tenant INTO b FROM progress_reports WHERE id = v_rep;
    r := r || jsonb_build_object('w_pm_report_insert', 'ok', 'pm_report_defaults_MUSTtrue', b);
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('w_pm_report_insert', SQLSTATE || ' ' || SQLERRM);
  END;
  BEGIN
    INSERT INTO progress_reports (site_id, task_id, qty) VALUES (v_task_site, v_task, -1);
    r := r || jsonb_build_object('pm_report_negative_23514_MUSTtrue', false);
  EXCEPTION WHEN SQLSTATE '23514' THEN r := r || jsonb_build_object('pm_report_negative_23514_MUSTtrue', true);
  END;
  BEGIN
    INSERT INTO progress_reports (site_id, task_id, qty, source) VALUES (v_task_site, v_task, 1, 'line');
    r := r || jsonb_build_object('pm_report_source_line_23514_MUSTtrue', false);
  EXCEPTION WHEN SQLSTATE '23514' THEN r := r || jsonb_build_object('pm_report_source_line_23514_MUSTtrue', true);
  END;
  BEGIN
    DELETE FROM progress_reports WHERE id = v_rep;
    r := r || jsonb_build_object('pm_report_delete_MUST42501', 'no error');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('pm_report_delete_MUST42501', SQLSTATE);
  END;
  BEGIN
    UPDATE progress_reports SET cancelled_at = now(), cancelled_by = v_pm WHERE id = v_rep;
    GET DIAGNOSTICS n = ROW_COUNT;
    r := r || jsonb_build_object('w_pm_report_cancel', 'ok', 'pm_report_cancel_rows_MUSTtrue', n = 1);
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('w_pm_report_cancel', SQLSTATE || ' ' || SQLERRM);
  END;
  -- a cancelled row cannot be touched again (USING cancelled_at IS NULL)
  UPDATE progress_reports SET cancelled_by = 'again' WHERE id = v_rep;
  GET DIAGNOSTICS n = ROW_COUNT;
  r := r || jsonb_build_object('pm_report_recancel_rows_MUST0', n);
  SELECT count(*) INTO n FROM site_plans WHERE id = v_plan;
  r := r || jsonb_build_object('pm_reads_site_plan_MUSTtrue', n = 1);
  SELECT count(*) INTO n FROM site_plan_items WHERE plan_id = v_plan;
  r := r || jsonb_build_object('pm_reads_site_plan_items_MUSTtrue', n = 1);

  -- ===== ADMIN: reads progress_reports, cannot insert =====
  PERFORM set_config('request.jwt.claims', json_build_object('email', v_admin, 'role', 'authenticated', 'sub', gen_random_uuid())::text, true);
  r := r || jsonb_build_object('admin_can_manage_plan_MUSTfalse', can_manage_plan());
  SELECT count(*) INTO n FROM progress_reports WHERE id = v_rep;
  r := r || jsonb_build_object('admin_reads_report_MUSTtrue', n = 1);
  BEGIN
    INSERT INTO progress_reports (site_id, task_id, qty) VALUES (v_task_site, v_task, 5);
    r := r || jsonb_build_object('admin_report_insert_MUST42501', 'no error');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('admin_report_insert_MUST42501', SQLSTATE);
  END;
  SELECT count(*) INTO n FROM boq_items WHERE id = v_boq;
  r := r || jsonb_build_object('admin_reads_boq_MUSTtrue', n = 1);

  -- ===== WORKER: 0 rows of every new table =====
  PERFORM set_config('request.jwt.claims', json_build_object('email', v_wk, 'role', 'authenticated', 'sub', gen_random_uuid())::text, true);
  r := r || jsonb_build_object('worker_current_tenant_ok_MUSTtrue', current_tenant_id() = v_tenant);
  SELECT count(*) INTO n FROM boq_items;        r := r || jsonb_build_object('worker_boq_items_MUST0', n);
  SELECT count(*) INTO n FROM progress_reports; r := r || jsonb_build_object('worker_progress_reports_MUST0', n);
  SELECT count(*) INTO n FROM site_plans;       r := r || jsonb_build_object('worker_site_plans_MUST0', n);
  SELECT count(*) INTO n FROM site_plan_items;  r := r || jsonb_build_object('worker_site_plan_items_MUST0', n);
  BEGIN
    INSERT INTO boq_items (site_id, code, description, planned_qty) VALUES (v_site, 'W-01', 'worker boq', 1);
    r := r || jsonb_build_object('worker_boq_insert_MUST42501', 'no error');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('worker_boq_insert_MUST42501', SQLSTATE);
  END;

  -- ===== OWNER: cannot write site_plans / site_plan_items directly =====
  PERFORM set_config('request.jwt.claims', json_build_object('email', v_owner, 'role', 'authenticated', 'sub', gen_random_uuid())::text, true);
  r := r || jsonb_build_object('owner_current_tenant_ok_MUSTtrue', current_tenant_id() = v_tenant, 'owner_can_manage_plan_MUSTtrue', can_manage_plan());
  SELECT count(*) INTO n FROM site_plans WHERE id = v_plan;
  r := r || jsonb_build_object('owner_reads_site_plan_MUSTtrue', n = 1);
  BEGIN
    INSERT INTO site_plans (site_id, version, note) VALUES (v_site, 99, 'owner direct');
    r := r || jsonb_build_object('owner_site_plans_insert_MUST42501', 'no error');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('owner_site_plans_insert_MUST42501', SQLSTATE);
  END;
  BEGIN
    UPDATE site_plans SET note = 'owner edit' WHERE id = v_plan;
    r := r || jsonb_build_object('owner_site_plans_update_MUST42501', 'no error');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('owner_site_plans_update_MUST42501', SQLSTATE);
  END;
  BEGIN
    DELETE FROM site_plans WHERE id = v_plan;
    r := r || jsonb_build_object('owner_site_plans_delete_MUST42501', 'no error');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('owner_site_plans_delete_MUST42501', SQLSTATE);
  END;
  BEGIN
    UPDATE site_plan_items SET name = 'owner edit' WHERE plan_id = v_plan;
    r := r || jsonb_build_object('owner_site_plan_items_update_MUST42501', 'no error');
  EXCEPTION WHEN OTHERS THEN r := r || jsonb_build_object('owner_site_plan_items_update_MUST42501', SQLSTATE);
  END;

  -- check: this RAISE is load-bearing. It aborts the DO block so none of the
  -- rows written above survive, and it is how the RESULT reaches the output.
  -- The ROLLBACK below then undoes the inlined DDL. Never remove either.
  RAISE EXCEPTION 'RESULT %', r;
END $$;
ROLLBACK;
