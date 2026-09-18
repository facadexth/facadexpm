-- supabase/migrations/2026-09-18-01-phase-task-workers-lead-flag.sql
--
-- Lets one of a task's (many-to-many) assignees be marked "หัวหน้าทีม"
-- (team leader) -- a single, fixed point of accountability for that card,
-- while the rest of the team roster can rotate freely day to day. Purely
-- a label: does not change who can edit/drag the card (still ADMIN+ only,
-- same as every other phase_task_workers write) -- "delegated edit
-- permission for a non-admin team leader" was explicitly discussed and
-- NOT what was asked for here.
--
-- At most one lead per task is an application-level rule (enforced in
-- PhaseKanbanBoard.jsx's save logic, which always clears any other lead
-- flag on the same task before setting a new one) rather than a DB
-- constraint -- matches this schema's existing style of keeping
-- constraints in the write path, not partial-unique-index enforcement.

ALTER TABLE phase_task_workers ADD COLUMN is_lead BOOLEAN NOT NULL DEFAULT false;

-- phase_task_workers had no UPDATE policy at all until now (Task 3's fix
-- round worked around this with upsert+delete for the assignee list
-- itself, which never needed to change an existing row's other columns).
-- Toggling is_lead on an already-assigned worker IS an update to an
-- existing row's column, so a real UPDATE policy is needed -- same
-- tenant-scoping shape (via EXISTS on the parent phase_tasks row, since
-- this junction table has no tenant_id of its own) as admin_reads/
-- admin_inserts/admin_deletes on this same table.
CREATE POLICY admin_updates ON phase_task_workers FOR UPDATE TO authenticated
  USING (is_admin_or_owner() AND tenant_can_write() AND EXISTS (
    SELECT 1 FROM phase_tasks pt WHERE pt.id = phase_task_workers.task_id AND pt.tenant_id = current_tenant_id()
  ))
  WITH CHECK (is_admin_or_owner() AND tenant_can_write() AND EXISTS (
    SELECT 1 FROM phase_tasks pt WHERE pt.id = phase_task_workers.task_id AND pt.tenant_id = current_tenant_id()
  ));
