-- supabase/migrations/2026-09-28-03-fix-pending-actions-checkin-checkout.sql
--
-- Real, pre-existing bug found live: line_pending_actions' own action
-- CHECK constraint only ever allowed 'issue_report', 'material_request',
-- 'leave', 'site_photo', 'job_done_pick', 'job_done' -- it never
-- included 'check_in_location'/'check_out_location', even though
-- line-webhook/index.ts's handleCheckInStart/handleCheckOutStart have
-- upserted rows with exactly those two action values since the
-- geofenced check-in/check-out two-step flow was built (see the
-- 2026-09-23 migrations referenced in that code's own comments).
--
-- Effect in production: EVERY check-in/check-out attempt via LINE has
-- silently failed since that feature shipped. The upsert throws a
-- 23514 check-constraint violation, which handleCheckInStart/
-- handleCheckOutStart only console.error -- they still send the
-- "press below to share your location" prompt regardless. The worker
-- shares their location; since no pending row was ever actually
-- created, the webhook's `if (pending)` branch finds nothing and the
-- location message matches no other branch either -- total silence,
-- no error shown to the worker, no evidence anything went wrong except
-- server-side logs. Caught via a live screenshot + function_logs
-- (2026-09-28): "new row for relation \"line_pending_actions\" violates
-- check constraint \"line_pending_actions_action_check\"" firing on
-- every เช็คอิน tap.

ALTER TABLE line_pending_actions DROP CONSTRAINT line_pending_actions_action_check;

ALTER TABLE line_pending_actions ADD CONSTRAINT line_pending_actions_action_check
  CHECK (action = ANY (ARRAY[
    'issue_report', 'material_request', 'leave', 'site_photo', 'job_done_pick', 'job_done',
    'check_in_location', 'check_out_location'
  ]));
