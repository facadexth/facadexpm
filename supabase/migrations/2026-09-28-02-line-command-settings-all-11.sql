-- supabase/migrations/2026-09-28-02-line-command-settings-all-11.sql
--
-- Widens line_command_settings' command_key CHECK constraint from just
-- the 4 read-only schedule commands to all 11 crew bot commands, per
-- explicit user ask: "ทำให้มีเปิด-ปิดทุก feature เลยได้ไหม" (make every
-- feature toggleable, not just the 4 schedule ones). Renaming
-- (custom_phrase) stays UI-scoped to the schedule 4 only -- this
-- migration only widens which command_key values are legal rows; it
-- doesn't add rename support for the other 7 (see
-- src/lib/lineCommandSettings.js for the full rationale).
--
-- No data migration needed: a missing row for any command_key already
-- means "enabled" (resolveEnabled's fallback), so existing tenants see
-- no behavior change until an OWNER actually toggles one of the newly
-- exposed 7 off.

ALTER TABLE line_command_settings DROP CONSTRAINT line_command_settings_command_key_check;

ALTER TABLE line_command_settings ADD CONSTRAINT line_command_settings_command_key_check
  CHECK (command_key = ANY (ARRAY[
    'today_job', 'tomorrow_job', 'this_week_job', 'next_week_job',
    'issue_report', 'material_request', 'leave', 'check_in', 'check_out', 'site_photo', 'job_done_start'
  ]));
