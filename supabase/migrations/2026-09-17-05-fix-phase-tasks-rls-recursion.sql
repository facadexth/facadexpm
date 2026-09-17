-- supabase/migrations/2026-09-17-05-fix-phase-tasks-rls-recursion.sql
--
-- Bug found live-verifying Task 3 (Kanban board UI): the very first
-- phase_tasks INSERT ever performed against this table (via
-- PhaseKanbanBoard.jsx's "+ เพิ่มงาน") failed with "infinite recursion
-- detected in policy for relation phase_tasks". Root cause is in
-- 2026-09-17-03-add-phase-tasks.sql (tenant-scoped by -04): phase_tasks'
-- worker_reads_own/worker_updates_own policies subquery
-- phase_task_workers directly, and phase_task_workers' admin_reads/
-- admin_inserts/admin_deletes/worker_reads_own policies subquery
-- phase_tasks right back (EXISTS ... FROM phase_tasks). Each table's RLS
-- has to evaluate the other table's RLS to resolve that subquery -- a
-- two-table cycle. It never surfaced against an empty table (a 0-row
-- scan never evaluates the per-row USING clause), which is why -03/-04
-- both looked fine at migration time -- it only fires once a query has
-- to check visibility of an actual row, e.g. insert(...).select().single().
--
-- Fix: resolve "task ids I'm assigned to" through a SECURITY DEFINER
-- function instead of a raw subquery on the other RLS-protected table --
-- same bypass-RLS-inside pattern already proven by get_my_site_names()/
-- get_my_team_today() in -03, which join worker_assignments/workers
-- (both RLS-enabled) without any recursion. This only needs to change
-- the phase_tasks side to break the cycle -- phase_task_workers' own
-- policies keep subquerying phase_tasks, but phase_tasks no longer
-- subqueries phase_task_workers back, so the chain now terminates.

CREATE OR REPLACE FUNCTION my_assigned_phase_task_ids()
RETURNS SETOF UUID
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public
AS $$
  SELECT ptw.task_id FROM phase_task_workers ptw
  JOIN workers w ON w.id = ptw.worker_id AND w.tenant_id = current_tenant_id()
  WHERE w.email = (select auth.email());
$$;
REVOKE EXECUTE ON FUNCTION my_assigned_phase_task_ids() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_assigned_phase_task_ids() TO authenticated;

DROP POLICY worker_reads_own ON phase_tasks;
CREATE POLICY worker_reads_own ON phase_tasks FOR SELECT TO authenticated
  USING (tenant_id = current_tenant_id() AND id IN (SELECT my_assigned_phase_task_ids()));

DROP POLICY worker_updates_own ON phase_tasks;
CREATE POLICY worker_updates_own ON phase_tasks FOR UPDATE TO authenticated
  USING (tenant_id = current_tenant_id() AND id IN (SELECT my_assigned_phase_task_ids()) AND tenant_can_write())
  WITH CHECK (tenant_id = current_tenant_id() AND id IN (SELECT my_assigned_phase_task_ids()) AND tenant_can_write());
