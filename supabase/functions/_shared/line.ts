// supabase/functions/_shared/line.ts
// Shared LINE Messaging API primitives -- every function that talks to
// LINE (line-webhook, and Task 4's four scheduled push functions) goes
// through these three, so there is exactly one implementation of
// signature verification and exactly one of "send a message" to keep
// in sync with LINE's API, not five copies.

import { timingSafeEqual } from './timing-safe.ts'

const LINE_API = 'https://api.line.me/v2/bot/message'

// Shared platform bot credentials (see
// docs/superpowers/specs/2026-10-01-shared-line-bot-design.md) -- every
// tenant connects to this ONE LINE OA now, instead of providing their
// own Channel ID/Secret/Access Token. channel_access_token and
// channel_secret are real secrets (Edge Function secrets, set via the
// Supabase dashboard or `supabase secrets set` -- never hardcoded,
// never logged). bot_user_id and basic_id are NOT secret (LINE's own
// Get Bot Info response and the public @handle are both discoverable
// by anyone who messages the bot) -- plain constants, safe to also
// mirror in the frontend (see src/lib/platformLineBot.js, Task 4).
// Fail loudly at module load, not silently at call time -- the bare `!`
// assertion below is erased by TypeScript at runtime, so an unset secret
// used to mean every function importing this file would HMAC-sign with
// the literal string "undefined" and push with `Authorization: Bearer
// undefined`, with nothing in the logs explaining why every request
// failed. Every one of the 9 functions that import this file will now
// refuse to even start instead, which is the correct failure mode for a
// genuine misconfiguration (missing Supabase Edge Function secrets).
const rawAccessToken = Deno.env.get('LINE_CHANNEL_ACCESS_TOKEN')
const rawChannelSecret = Deno.env.get('LINE_CHANNEL_SECRET')
if (!rawAccessToken || !rawChannelSecret) {
  throw new Error('LINE_CHANNEL_ACCESS_TOKEN / LINE_CHANNEL_SECRET not configured -- set them as Supabase Edge Function secrets before deploying any function that imports _shared/line.ts')
}
// Neither value can legitimately contain whitespace, but a secret pasted from a
// wrapped terminal/web page can carry stray newlines or spaces. A newline inside
// the token makes `Authorization: Bearer <token>` an invalid header, so every
// reply throws (found live on 2026-10-03 right after the region cutover).
// Strip all whitespace instead of trusting the paste.
export const LINE_CHANNEL_ACCESS_TOKEN = rawAccessToken.replace(/\s+/g, '')
export const LINE_CHANNEL_SECRET = rawChannelSecret.replace(/\s+/g, '')
export const LINE_BOT_USER_ID = 'Uc21ab4c845be0f5d3b90e0daa1f5cf72'
export const LINE_BASIC_ID = 'changpm'

export async function verifyLineSignature(channelSecret: string, rawBody: string, signatureHeader: string | null): Promise<boolean> {
  if (!signatureHeader) return false
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(channelSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody))
  const expected = btoa(String.fromCharCode(...new Uint8Array(sig)))
  return timingSafeEqual(expected, signatureHeader)
}

// quickReplyItems works exactly as in sendLineReply: tappable chips under the
// message, each sending `text` back as if the user typed it.
export async function sendLinePush(
  accessToken: string,
  to: string,
  text: string,
  quickReplyItems?: Array<{ label: string; text: string }>,
): Promise<{ ok: boolean; status: number }> {
  const message: Record<string, unknown> = { type: 'text', text }
  if (quickReplyItems && quickReplyItems.length > 0) {
    message.quickReply = {
      items: quickReplyItems.map((item) => ({ type: 'action', action: { type: 'message', label: item.label, text: item.text } })),
    }
  }
  const res = await fetch(`${LINE_API}/push`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ to, messages: [message] }),
  })
  return { ok: res.ok, status: res.status }
}

// quickReplyItems, when given, attaches tappable chips below the
// message. A text chip ({label, text}, the common case) sends `text`
// back exactly as if the user had typed it -- built for low-literacy
// crew members: tapping a task name is far easier than typing a number
// or the name itself. `label` (what's shown on the chip) and `text`
// (what's actually sent on tap) are DELIBERATELY separate fields, not
// one value reused for both -- LINE caps a label at 20 characters, but
// a real task name can be longer; keeping `text` full-length means a
// caller that exact-matches the tapped reply against an untruncated
// name (e.g. งานเสร็จ's task picker) still works correctly even when
// the visible chip had to be shortened. A caller with nothing to
// truncate just passes the same string for both. A location chip
// ({label, location: true}) opens LINE's native location picker
// instead, sending back a `location`-type message -- used by the
// geofenced เช็คอิน/เช็คเอาท์ flow, which needs real coordinates.
export async function sendLineReply(
  accessToken: string,
  replyToken: string,
  text: string,
  quickReplyItems?: Array<{ label: string; text: string } | { label: string; location: true }>,
): Promise<{ ok: boolean; status: number }> {
  const message: Record<string, unknown> = { type: 'text', text }
  if (quickReplyItems && quickReplyItems.length > 0) {
    message.quickReply = {
      items: quickReplyItems.map((item) =>
        'location' in item
          ? { type: 'action', action: { type: 'location', label: item.label } }
          : { type: 'action', action: { type: 'message', label: item.label, text: item.text } },
      ),
    }
  }
  const res = await fetch(`${LINE_API}/reply`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ replyToken, messages: [message] }),
  })
  return { ok: res.ok, status: res.status }
}
