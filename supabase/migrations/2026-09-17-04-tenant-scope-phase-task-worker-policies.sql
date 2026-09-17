-- supabase/migrations/2026-09-17-04-tenant-scope-phase-task-worker-policies.sql
--
-- Closes a tenant-isolation gap in the worker-facing RLS policies added by
-- 2026-09-17-03-add-phase-tasks.sql: they matched workers.email = auth.email()
-- with no tenant scoping on the matched row or in the subquery. workers.email
-- has no unique constraint, so two tenants registering a worker with the same
-- email could let a session in one tenant read/update the other tenant's
-- phase_tasks rows. Fixed by tenant-scoping both the target row and the
-- identity-resolution subquery.

DROP POLICY worker_reads_own ON phase_tasks;
CREATE POLICY worker_reads_own ON phase_tasks FOR SELECT TO authenticated
  USING (tenant_id = current_tenant_id() AND id IN (
    SELECT ptw.task_id FROM phase_task_workers ptw
    JOIN workers w ON w.id = ptw.worker_id AND w.tenant_id = current_tenant_id()
    WHERE w.email = (select auth.email())
  ));

DROP POLICY worker_updates_own ON phase_tasks;
CREATE POLICY worker_updates_own ON phase_tasks FOR UPDATE TO authenticated
  USING (tenant_id = current_tenant_id() AND id IN (
    SELECT ptw.task_id FROM phase_task_workers ptw
    JOIN workers w ON w.id = ptw.worker_id AND w.tenant_id = current_tenant_id()
    WHERE w.email = (select auth.email())
  ) AND tenant_can_write())
  WITH CHECK (tenant_id = current_tenant_id() AND id IN (
    SELECT ptw.task_id FROM phase_task_workers ptw
    JOIN workers w ON w.id = ptw.worker_id AND w.tenant_id = current_tenant_id()
    WHERE w.email = (select auth.email())
  ) AND tenant_can_write());

DROP POLICY worker_reads_own ON phase_task_workers;
CREATE POLICY worker_reads_own ON phase_task_workers FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM phase_tasks pt WHERE pt.id = phase_task_workers.task_id AND pt.tenant_id = current_tenant_id())
    AND worker_id IN (SELECT id FROM workers WHERE email = (select auth.email()) AND tenant_id = current_tenant_id())
  );
