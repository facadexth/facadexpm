// src/lib/platformLineBot.js
// Mirrors the bot_user_id/basic_id constants in
// supabase/functions/_shared/line.ts -- every tenant connects to this
// ONE LINE OA now (see docs/superpowers/specs/2026-10-01-shared-line-bot-design.md).
// Neither value is secret: LINE's own Get Bot Info response and the
// public @handle are both discoverable by anyone who messages the bot.
export const PLATFORM_BOT_BASIC_ID = 'changpm' // must match LINE_BASIC_ID in _shared/line.ts exactly
// The name people see for the bot in LINE. Keep it null until the LINE account
// is actually renamed (planned: 'ADMIN CHANG'): the app must never show a name
// that does not match what LINE shows, or people cannot find the bot. Until
// then the screens show the @ID, which always finds it.
export const PLATFORM_BOT_NAME = null

export function platformBotLabel(name = PLATFORM_BOT_NAME, basicId = PLATFORM_BOT_BASIC_ID) {
  return name ? `${name} (@${basicId})` : `@${basicId}`
}
