-- The new two-step geofenced เช็คอิน/เช็คเอาท์ flow asks the worker to
-- share their LINE location, then needs to remember which site that
-- location is being validated against once the location message
-- arrives (a separate webhook event, no other state to carry it).
-- task_id already serves this "extra context for a pending action"
-- role for job_done_pick; site_id is the same idea for check-in/out.
alter table line_pending_actions add column site_id uuid references sites(id);
