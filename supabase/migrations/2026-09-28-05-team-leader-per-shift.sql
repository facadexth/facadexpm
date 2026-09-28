-- supabase/migrations/2026-09-28-05-team-leader-per-shift.sql
--
-- Adds a "team leader" (🅒 hard-hat badge) concept scoped to one site +
-- date + shift, set from the Assign Wizard when scheduling a crew --
-- distinct from the existing per-Kanban-card หัวหน้าทีม
-- (phase_task_workers.is_lead, 2026-09-18-01), which stays a completely
-- separate concept. The unique index (not just an app-level rule, since
-- this flag carries real authority in the LINE bot's งานเสร็จ flow --
-- see line-webhook/index.ts) guarantees at most one leader per shift.

ALTER TABLE worker_assignments ADD COLUMN is_team_leader boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX worker_assignments_one_leader_per_shift
  ON worker_assignments (tenant_id, site_id, date, shift)
  WHERE is_team_leader AND site_id IS NOT NULL;
