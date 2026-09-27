-- supabase/migrations/2026-09-27-06-line-command-settings.sql
-- Lets an OWNER enable/disable and rename the trigger phrase for the 4
-- read-only schedule-query commands (งานวันนี้/งานวันพรุ่งนี้/
-- งานอาทิตย์นี้/งานอาทิตย์หน้า) from Communication Center, per the
-- user's own scoped-down ask ("owner role, can add more command or
-- cherry pick command that fit with the team") -- deliberately NOT a
-- generic command engine: command_key is constrained to this fixed
-- set, and the 7 write-action commands (แจ้งปัญหา/เบิกของ/ขอลา/
-- เช็คอิน/เช็คเอาท์/รูปภาพ/งานเสร็จ) are untouched by this table on
-- purpose -- those are core workflow, not something to cherry-pick.
--
-- A missing row for a given (tenant_id, command_key) means "enabled,
-- default phrase" -- so every existing tenant keeps working with zero
-- migration/backfill needed. custom_phrase NULL means "use the
-- built-in default phrase too" even when a row exists (e.g. a
-- disabled-then-re-enabled command with no rename).
CREATE TABLE line_command_settings (
  id             UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  command_key    TEXT NOT NULL CHECK (command_key IN ('today_job', 'tomorrow_job', 'this_week_job', 'next_week_job')),
  enabled        BOOLEAN NOT NULL DEFAULT true,
  custom_phrase  TEXT,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_line_command_settings_tenant_key ON line_command_settings(tenant_id, command_key);

ALTER TABLE line_command_settings ENABLE ROW LEVEL SECURITY;
-- OWNER-only both ways, same sensitivity tier as line_settings itself
-- (this table controls what the bot responds to, same category of
-- risk as the channel credentials it sits next to on the same page).
CREATE POLICY owner_reads ON line_command_settings FOR SELECT TO authenticated
  USING (is_owner() AND tenant_id = current_tenant_id());
CREATE POLICY owner_writes ON line_command_settings FOR ALL TO authenticated
  USING (is_owner() AND tenant_id = current_tenant_id() AND tenant_can_write())
  WITH CHECK (is_owner() AND tenant_id = current_tenant_id() AND tenant_can_write());
