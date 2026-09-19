-- Drop columns added for API-based per-user Rich Menu linking
-- (2026-09-19-07-line-pending-actions.sql), abandoned in favor of a
-- Rich Menu configured manually in LINE Official Account Manager --
-- the crew bot is internal-only, so a plain bot-wide default menu is
-- safe and needs no per-user linking. line_pending_actions itself
-- stays (still used by the two-step DM flow, now triggered by matched
-- text instead of postback events).
ALTER TABLE line_settings DROP COLUMN IF EXISTS crew_rich_menu_id;
ALTER TABLE workers DROP COLUMN IF EXISTS line_rich_menu_linked_at;
