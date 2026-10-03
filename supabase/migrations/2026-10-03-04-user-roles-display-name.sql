-- A person's name for each login (shown in User Management; the OWNER sets
-- their own in Settings). Nullable on purpose: existing rows have none, and
-- no view selects user_roles.* so there is no frozen column list to refresh.
ALTER TABLE user_roles ADD COLUMN IF NOT EXISTS display_name TEXT;
