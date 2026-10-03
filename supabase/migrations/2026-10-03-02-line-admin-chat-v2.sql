-- supabase/migrations/2026-10-03-02-line-admin-chat-v2.sql
-- v2 of LINE admin chat: the idle limit is in MINUTES (default 30, was 24 hours)
-- and each session remembers whether the user was already acknowledged for the
-- first message and warned before expiry. Additive on line_chat_sessions; the
-- single config row switches units.
ALTER TABLE line_admin_chat_config
  ADD COLUMN idle_minutes integer NOT NULL DEFAULT 30 CHECK (idle_minutes BETWEEN 5 AND 1440);
UPDATE line_admin_chat_config SET idle_minutes = 30;
ALTER TABLE line_admin_chat_config DROP COLUMN idle_hours;

ALTER TABLE line_chat_sessions
  ADD COLUMN ack_sent_at timestamptz,   -- set once the "sent to admin" reply went out for this session
  ADD COLUMN warned_at   timestamptz;   -- set once the "ends in 10 minutes" push went out; cleared by new activity
