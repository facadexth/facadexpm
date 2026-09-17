-- supabase/migrations/2026-09-17-03-add-phase-tasks.sql
--
-- Kanban task board for site phases (spec:
-- docs/superpowers/specs/2026-09-17-site-gantt-kanban-design.md).
-- phase_tasks = one Kanban card. phase_task_workers = many-to-many
-- assignees (0, 1, or many workers per card). A phase's Gantt status
-- becomes derived from its tasks once it has >=1 row here -- see
-- src/pages/sites/phaseTasksCalc.js -- the site_phases.status column
-- and its existing manual editor are untouched and still used as the
-- fallback for phases with zero tasks.

CREATE TABLE phase_tasks (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  phase_id    UUID NOT NULL REFERENCES site_phases(id) ON DELETE CASCADE,
  site_id     UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  tenant_id   UUID NOT NULL,
  name        TEXT NOT NULL,
  zone        TEXT,
  status      TEXT NOT NULL DEFAULT 'not_started'
              CHECK (status IN ('not_started','in_progress','done')),
  due_date    DATE,
  sort_order  INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_phase_tasks_phase_id ON phase_tasks(phase_id);
CREATE INDEX idx_phase_tasks_site_id ON phase_tasks(site_id);

CREATE TABLE phase_task_workers (
  task_id   UUID NOT NULL REFERENCES phase_tasks(id) ON DELETE CASCADE,
  worker_id UUID NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, worker_id)
);

CREATE INDEX idx_phase_task_workers_worker_id ON phase_task_workers(worker_id);

ALTER TABLE phase_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE phase_task_workers ENABLE ROW LEVEL SECURITY;

-- phase_tasks: ADMIN/OWNER full access (tenant-scoped, same shape as
-- site_phases' own policies) + a worker can read/update ONLY tasks
-- they're an assignee of. Row-level only (no column-level GRANT,
-- matching this codebase's existing worker_assignments precedent) --
-- the app UI is what limits a worker's edit form to status alone.
CREATE POLICY admin_reads ON phase_tasks FOR SELECT TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id());
CREATE POLICY admin_inserts ON phase_tasks FOR INSERT TO authenticated
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write());
CREATE POLICY admin_updates ON phase_tasks FOR UPDATE TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write())
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write());
CREATE POLICY admin_deletes ON phase_tasks FOR DELETE TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write());

CREATE POLICY worker_reads_own ON phase_tasks FOR SELECT TO authenticated
  USING (id IN (
    SELECT ptw.task_id FROM phase_task_workers ptw
    JOIN workers w ON w.id = ptw.worker_id
    WHERE w.email = (select auth.email())
  ));
CREATE POLICY worker_updates_own ON phase_tasks FOR UPDATE TO authenticated
  USING (id IN (
    SELECT ptw.task_id FROM phase_task_workers ptw
    JOIN workers w ON w.id = ptw.worker_id
    WHERE w.email = (select auth.email())
  ) AND tenant_can_write())
  WITH CHECK (id IN (
    SELECT ptw.task_id FROM phase_task_workers ptw
    JOIN workers w ON w.id = ptw.worker_id
    WHERE w.email = (select auth.email())
  ) AND tenant_can_write());

-- phase_task_workers: ADMIN/OWNER manage assignments (tenant-scoped via
-- the parent phase_tasks row, since this junction table has no tenant_id
-- column of its own). A worker can read rows for tasks they're assigned
-- to -- needed so usePhaseTasks()'s embedded phase_task_workers(worker_id)
-- select returns their own assignee row alongside the task.
CREATE POLICY admin_reads ON phase_task_workers FOR SELECT TO authenticated
  USING (is_admin_or_owner() AND EXISTS (
    SELECT 1 FROM phase_tasks pt WHERE pt.id = phase_task_workers.task_id AND pt.tenant_id = current_tenant_id()
  ));
CREATE POLICY admin_inserts ON phase_task_workers FOR INSERT TO authenticated
  WITH CHECK (is_admin_or_owner() AND tenant_can_write() AND EXISTS (
    SELECT 1 FROM phase_tasks pt WHERE pt.id = phase_task_workers.task_id AND pt.tenant_id = current_tenant_id()
  ));
CREATE POLICY admin_deletes ON phase_task_workers FOR DELETE TO authenticated
  USING (is_admin_or_owner() AND tenant_can_write() AND EXISTS (
    SELECT 1 FROM phase_tasks pt WHERE pt.id = phase_task_workers.task_id AND pt.tenant_id = current_tenant_id()
  ));
CREATE POLICY worker_reads_own ON phase_task_workers FOR SELECT TO authenticated
  USING (worker_id IN (SELECT id FROM workers WHERE email = (select auth.email())));

-- get_my_site_names(): extend the existing WORKER-safe site-name lookup
-- (2026-09-03-09-worker-safe-site-names.sql) to also cover a site the
-- worker only reaches via a Kanban task assignment (no same-day
-- worker_assignments row necessarily exists yet). CREATE OR REPLACE
-- keeps the same signature/grants -- no need to re-grant EXECUTE.
CREATE OR REPLACE FUNCTION get_my_site_names()
RETURNS TABLE(id UUID, site_number TEXT, name TEXT)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT s.id, s.site_number, s.name
  FROM sites s
  JOIN worker_assignments wa ON wa.site_id = s.id AND wa.tenant_id = current_tenant_id()
  JOIN workers w ON w.id = wa.worker_id AND w.tenant_id = current_tenant_id()
  WHERE w.email = auth.email() AND s.tenant_id = current_tenant_id()
  UNION
  SELECT DISTINCT s.id, s.site_number, s.name
  FROM sites s
  JOIN phase_tasks pt ON pt.site_id = s.id AND pt.tenant_id = current_tenant_id()
  JOIN phase_task_workers ptw ON ptw.task_id = pt.id
  JOIN workers w ON w.id = ptw.worker_id AND w.tenant_id = current_tenant_id()
  WHERE w.email = auth.email() AND s.tenant_id = current_tenant_id();
$$;

-- get_my_team_today(): a WORKER's own RLS on worker_assignments only
-- lets them read THEIR OWN rows (worker_reads_own policy in
-- 2026-08-16-05-security-advisor-fixes.sql), so there is no direct path
-- for MySchedule.jsx's new "team today" section to see teammates'
-- assignments. Mirrors get_my_site_names()'s SECURITY DEFINER pattern:
-- returns only name/nickname for workers sharing a site+date with the
-- caller today, nothing else.
CREATE OR REPLACE FUNCTION get_my_team_today()
RETURNS TABLE(id UUID, name TEXT, nickname TEXT)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT w2.id, w2.name, w2.nickname
  FROM worker_assignments wa_me
  JOIN workers w_me ON w_me.id = wa_me.worker_id AND w_me.tenant_id = current_tenant_id()
  JOIN worker_assignments wa2 ON wa2.site_id = wa_me.site_id AND wa2.date = wa_me.date AND wa2.tenant_id = current_tenant_id()
  JOIN workers w2 ON w2.id = wa2.worker_id AND w2.tenant_id = current_tenant_id()
  WHERE w_me.email = auth.email()
    AND wa_me.date = CURRENT_DATE
    AND wa_me.type = 'site'
    AND wa2.type = 'site';
$$;

REVOKE EXECUTE ON FUNCTION get_my_team_today() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION get_my_team_today() TO authenticated;
