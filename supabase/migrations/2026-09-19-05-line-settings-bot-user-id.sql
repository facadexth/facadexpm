-- destination in LINE's webhook payload is the bot's own internal userId
-- (U + 32 hex chars, from LINE's GET /v2/bot/info), not the numeric
-- Channel ID shown in LINE's console -- these are two different LINE
-- identifiers. channel_id stays (still correct for its own purpose --
-- human-readable channel identity for the Settings UI); this adds the
-- separate id the webhook actually needs to match `destination` against.
ALTER TABLE line_settings ADD COLUMN bot_user_id TEXT;
CREATE UNIQUE INDEX idx_line_settings_bot_user_id ON line_settings(bot_user_id) WHERE bot_user_id IS NOT NULL;
