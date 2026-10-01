-- supabase/migrations/2026-10-01-04-shared-line-bot.sql
-- Supports the shared-platform-bot migration (see
-- docs/superpowers/specs/2026-10-01-shared-line-bot-design.md). Two
-- changes, both additive -- no existing column is dropped or altered,
-- since the real tenant's existing line_settings row stays valid
-- (its credential columns just stop being read by any function after
-- this plan's later tasks land).

-- A LINE group can only ever belong to one tenant once every tenant
-- shares one real bot (today nothing enforces this -- each tenant's
-- bot is a separate real channel so collisions can't happen in
-- practice, but that stops being true once the bot is shared).
CREATE UNIQUE INDEX idx_line_settings_crew_group_id ON line_settings(crew_group_id) WHERE crew_group_id IS NOT NULL;

-- Code-based group-claim flow (spec §5): same single-column shape
-- workers.line_link_code / user_roles.line_link_code already use for
-- an identical "short-lived claim code" purpose -- no expiry column,
-- consumed-until-replaced, matching that exact precedent.
ALTER TABLE line_settings ADD COLUMN group_link_code TEXT;
