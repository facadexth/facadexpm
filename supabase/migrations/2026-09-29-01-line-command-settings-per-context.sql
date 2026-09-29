-- supabase/migrations/2026-09-29-01-line-command-settings-per-context.sql
--
-- Splits line_command_settings' single `enabled` flag into `enabled_dm`
-- and `enabled_group`, per explicit user ask: "ทุก command ไลน์ ขอให้ทำ
-- toggle เปิด-ปิด สำหรับ pm/กลุ่มไลน์" (every LINE command needs a
-- separate on/off toggle for DM vs group chat). Previously one boolean
-- governed both contexts identically -- resolveEnabled had no context
-- parameter and every call site (DM handler, group-info handler,
-- group-direct handler) checked the same flag.
--
-- Backward-compatible split: both new columns start equal to the old
-- `enabled` value, so no tenant's existing on/off state silently
-- changes -- an OWNER only sees divergent DM/group state once they
-- actually toggle one context differently via the new UI.
ALTER TABLE line_command_settings ADD COLUMN enabled_dm    BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE line_command_settings ADD COLUMN enabled_group BOOLEAN NOT NULL DEFAULT true;

UPDATE line_command_settings SET enabled_dm = enabled, enabled_group = enabled;

ALTER TABLE line_command_settings DROP COLUMN enabled;
