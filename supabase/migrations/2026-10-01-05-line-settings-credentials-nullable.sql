-- Final-review fix for the shared-platform-bot migration (see
-- docs/superpowers/specs/2026-10-01-shared-line-bot-design.md and
-- docs/superpowers/plans/2026-10-01-shared-line-bot-plan.md): Task 4
-- deleted the only code path that ever INSERTed a line_settings row
-- (the old credential form's handleSaveConnection). The new
-- group-claim-code flow (CommunicationCenter.jsx's
-- handleGenerateGroupCode) needs to create a row for a tenant that
-- doesn't have one yet, upserting on tenant_id -- but channel_id,
-- channel_access_token, and channel_secret are all NOT NULL, so that
-- upsert would fail for any tenant without a pre-existing row. The one
-- real production tenant already has a row (with real values in those
-- columns from before this migration), which is exactly why this gap
-- was invisible until reviewed against a SECOND tenant -- the whole
-- point of this migration was fixing onboarding for new tenants, and
-- this NOT NULL constraint silently blocked exactly that.
ALTER TABLE line_settings ALTER COLUMN channel_id DROP NOT NULL;
ALTER TABLE line_settings ALTER COLUMN channel_access_token DROP NOT NULL;
ALTER TABLE line_settings ALTER COLUMN channel_secret DROP NOT NULL;
