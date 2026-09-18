-- supabase/migrations/2026-09-18-04-phase-subtasks-tenant-id-default.sql
--
-- Whole-branch review finding: phase_subtasks (see -03) repeats the exact
-- same omission phase_tasks had before it was fixed in
-- 2026-09-17-06-phase-tasks-tenant-id-default.sql -- tenant_id is NOT NULL
-- with no DEFAULT, and GanttView.jsx's insert payload for a new subtask
-- never set tenant_id itself (matching the established convention: other
-- inserts against site_phases from GanttView.jsx/PhaseManageModal.jsx
-- never pass tenant_id either), so it would arrive NULL and fail
-- admin_inserts' WITH CHECK (tenant_id = current_tenant_id()) the first
-- time anyone tried to add a real subtask.
--
-- site_phases and phase_tasks (phase_subtasks' sibling tables, same
-- tenant-scoping shape) both already have
-- `tenant_id UUID NOT NULL DEFAULT current_tenant_id()` -- match them here
-- instead of pushing a tenant_id lookup into the client.

ALTER TABLE phase_subtasks ALTER COLUMN tenant_id SET DEFAULT current_tenant_id();
