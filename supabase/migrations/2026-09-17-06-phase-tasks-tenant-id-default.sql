-- supabase/migrations/2026-09-17-06-phase-tasks-tenant-id-default.sql
--
-- Second bug found live-verifying Task 3 (after -05 fixed the RLS
-- recursion): every insert into phase_tasks from PhaseKanbanBoard.jsx
-- now fails with "new row violates row-level security policy for table
-- phase_tasks" instead of hanging/recursing. Cause: phase_tasks.tenant_id
-- is NOT NULL with no DEFAULT (see -03), and the component's insert
-- payload -- { phase_id, site_id, name, zone, status, due_date,
-- sort_order } -- never sets tenant_id itself, so it arrives NULL and
-- fails admin_inserts' WITH CHECK (tenant_id = current_tenant_id()).
--
-- site_phases (phase_tasks' sibling table, same tenant-scoping shape)
-- already has `tenant_id UUID NOT NULL DEFAULT current_tenant_id()` --
-- confirmed live via pg_attrdef -- which is exactly why site_phases
-- inserts from GanttView.jsx/PhaseManageModal.jsx have always worked
-- without the client ever passing tenant_id. phase_tasks simply never
-- got the same default when it was created. Match it here instead of
-- pushing a tenant_id lookup into the client.

ALTER TABLE phase_tasks ALTER COLUMN tenant_id SET DEFAULT current_tenant_id();
