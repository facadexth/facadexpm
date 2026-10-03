// src/lib/platformLineBot.js
// Mirrors the bot_user_id/basic_id constants in
// supabase/functions/_shared/line.ts -- every tenant connects to this
// ONE LINE OA now (see docs/superpowers/specs/2026-10-01-shared-line-bot-design.md).
// Neither value is secret: LINE's own Get Bot Info response and the
// public @handle are both discoverable by anyone who messages the bot.
export const PLATFORM_BOT_BASIC_ID = '302yljzw' // must match LINE_BASIC_ID in _shared/line.ts exactly
export const PLATFORM_BOT_NAME = 'CHANG'
