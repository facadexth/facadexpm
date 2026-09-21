-- งานเสร็จ crew action: closes a real Kanban card (phase_tasks.status)
-- from the field, with a required completion photo traceable to the
-- exact task it closed. Adds job_done/job_done_pick to the pending-
-- action state machine (job_done_pick is the "which task" disambiguation
-- step, resolved via LINE Quick Reply chips -- tap the task name, no
-- typing, per the low-literacy-crew UX constraint).
alter table line_site_photos add column task_id uuid references phase_tasks(id) on delete set null;
alter table line_pending_actions add column task_id uuid references phase_tasks(id) on delete cascade;

alter table line_pending_actions drop constraint line_pending_actions_action_check;
alter table line_pending_actions add constraint line_pending_actions_action_check
  check (action = any (array['issue_report'::text, 'material_request'::text, 'leave'::text, 'site_photo'::text, 'job_done_pick'::text, 'job_done'::text]));
