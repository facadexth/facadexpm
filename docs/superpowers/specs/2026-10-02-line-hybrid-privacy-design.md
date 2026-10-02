# LINE Bot Hybrid Privacy Mode — Design

**Date:** 2026-10-02
**Branch:** `worktree-line-privacy-chat` (worktree: `.claude/worktrees/line-privacy-chat`)
**Status:** Draft for review — no code written yet

## Problem

The LINE bot is one shared platform bot used by every tenant (see
`2026-10-01-shared-line-bot-design.md`). Today the platform owner (the person who owns the
LINE OA and the Supabase project) can see more of the bot's users' activity than they should:
messages in the OA Manager chat inbox, and potentially content in tables and logs.

**Goal:** the platform owner must not see bot users' messages, photos or Rich Menu usage, in
1:1 chats or in groups, **except** when a user explicitly asks to talk to the admin.

**Scope of "admin":** the platform owner only. Each tenant's own admins keep seeing their own
tenant's data in the app as they do today (site photos, issue reports), governed by existing RLS.

## Non-goals

- Cryptographic guarantees. Message content must reach our edge function to be processed, so
  "not stored, not logged, not shown" is enforced by code, config and tests, **not** by
  encryption. User-facing copy must not claim encryption (see Copy below).
- Per-tenant OA/bot separation (rejected: contradicts the shared-bot decision, heavy per-tenant
  setup and message-quota cost).
- Column-level encryption of existing tenant data (deferred; revisit only if a tenant demands it).
- Changing what tenant-owned work data the existing flows store (e.g. crew-group photos filed
  to a site). That is tenant business data, not platform-visible chat.

## Two modes, per user

State is looked up from `event.source.userId` on every event.

| Mode | When | Persistence of user content |
|---|---|---|
| `secure_bot` (default) | Always, unless the user opted in | None beyond the existing tenant work flows. No new rows, no files, no content in logs. Nothing shown on any admin screen. |
| `chat_with_admin` | User taps "คุยกับแอดมิน" (Rich Menu) or types the trigger phrase | Text and images are stored so the admin can read and reply. |

A user with no session row is in `secure_bot`.

## Data model (migration, new tables only)

`line_chat_sessions`
- `line_user_id text primary key`
- `tenant_id uuid null` — resolved from existing worker/user_role link when known
- `mode text not null default 'secure_bot'` — `secure_bot | chat_with_admin`
- `started_at timestamptz`, `last_activity_at timestamptz`
- Holds state and timestamps only. Never message content.

`line_admin_messages`
- `id uuid pk`, `line_user_id text`, `direction text` (`user | admin`)
- `body text null`, `storage_path text null` (images, in a **new** bucket `line-admin-chat`,
  separate from `line-site-photos`)
- `line_event_id text unique null` — LINE's webhook event id, used for idempotency
- `created_at timestamptz`
- Rows are only ever written while the session's mode is `chat_with_admin`.

`app_settings` (existing) gains `line_admin_chat_idle_hours` (default 24), editable in Settings.

**RLS:** both tables and the bucket are readable/writable only by the platform-owner role,
via membership in the existing `platform_admins` table (the same gate the tenant management page uses). Tenant
admins and workers get no policy at all. Writes from the webhook use the service role.

## Webhook behavior (`supabase/functions/line-webhook/index.ts`)

1. Verify signature (unchanged). Return `200` immediately; process the event after.
2. Dedupe on `line_event_id` before acting (LINE retries on slow responses).
3. Load session by `event.source.userId`.
4. Route:
   - **Trigger to start chat** (Rich Menu postback or phrase): upsert session to
     `chat_with_admin`, reply with the connect notice, notify the admin (see Admin UI).
   - **`chat_with_admin` + text/image:** insert into `line_admin_messages` (image bytes →
     `line-admin-chat`), bump `last_activity_at`, do not run the work-flow handlers.
   - **User ends chat** (button/phrase): end session (see below).
   - **`secure_bot`:** existing crew/office flows unchanged. Their tenant-owned outputs
     continue to be written as today. Nothing new is added.
5. Group messages never enter `chat_with_admin`; chat-with-admin is 1:1 only.
6. On any processing failure: reply with a generic error. No message body in the error path.

**Ending a session** (user, admin button, or idle timeout) does, in one transaction:
set `mode = 'secure_bot'`, then send the end notice by push message.

## Idle expiry

A scheduled job (pg_cron, same pattern as the existing `line-push-*` jobs, authenticated with
`x-cron-secret`) ends sessions where `now() - last_activity_at > line_admin_chat_idle_hours`
and sends the end notice. This stops a forgotten session from recording indefinitely.

## Admin UI (platform owner only)

New page, visible only to the platform-owner role (not tenant ADMIN/OWNER):
- List of open sessions with last message and time.
- Conversation view: read, reply (sent as LINE push), "จบการสนทนา" button.
- Admin is notified of a new request via the page's list (and optionally a push to the
  owner's own linked LINE account — decide in plan).
- Past ended conversations: retention policy to confirm at plan time (default: keep until the
  owner deletes; offer delete per conversation).

## User-facing copy

- Start: `กำลังเชื่อมต่อกับเจ้าหน้าที่ ข้อมูลต่อจากนี้จะได้รับการบันทึกเพื่อให้แอดมินช่วยเหลือท่าน`
- End: `จบบทสนทนากับแอดมินแล้ว ข้อมูลต่อไปของคุณจะไม่ถูกบันทึกและแอดมินจะไม่เห็น`
  (deliberately **not** "เข้ารหัสอัตโนมัติ" — the system does not encrypt, and telling users it
  does would itself be a PDPA problem.)

## Logging audit (part of this work)

Existing `console.error` calls in `line-webhook` log Supabase error objects, not message text,
which is good. But PostgREST error `details`/`hint` can echo row values (e.g. duplicate-key
messages). The plan includes a sweep to ensure no error path logs user-supplied content, plus
a small `safeLogError()` helper that logs only the error code and message, never `details`.

## Manual configuration (outside the code)

In LINE Official Account Manager, set response mode to **Bot** and turn **Chat** off, so
1:1 messages do not appear in the OA Manager inbox. This is a precondition; the owner does it.

## Testing

- Unit: state machine (start, user end, admin end, idle expiry) and routing by mode.
- Unit: in `secure_bot`, handlers perform **no** insert/upload to `line_admin_messages` or
  `line-admin-chat`, and no logging call receives message content.
- Unit: idempotency — replaying the same `line_event_id` writes once.
- RLS (run against a Supabase branch): tenant admin, worker and anon cannot read or write
  `line_chat_sessions`, `line_admin_messages` or `line-admin-chat`.
- Live verification steps are spelled out in the plan, since migrations take effect the
  moment they are applied (test on a Supabase branch, not prod).

## Rollout and risk

- Develop entirely on `worktree-line-privacy-chat`; do not merge until the whole arc
  (webhook, admin page, cron, Settings field, tests) is done.
- New tables only, no changes to existing tables, so the migration is additive and low risk.
- The webhook is shared by all tenants, so the change ships behind the existing safe default:
  with no session rows everyone is `secure_bot`, i.e. today's behavior plus nothing new.

## Open questions for the plan stage

1. Retention of ended admin conversations (keep vs. auto-purge after N days).
2. Whether the admin gets a LINE push on new chat requests, or only sees them in the page.
3. Exact Rich Menu wiring for the "คุยกับแอดมิน" button (Rich Menu is configured manually
   in LINE today; the postback data string needs agreeing).

## Amendments (2026-10-02, found while writing the plan)

1. **Idle-hours setting lives in its own table, not `app_settings`.** `app_settings` is per-tenant;
   this value is a platform-owner concern. New single-row table `line_admin_chat_config`
   (`idle_hours`, default 24), edited from the platform-owner chat page, not tenant Settings.
2. **No change to webhook response timing.** The existing 1,400-line webhook processes events
   synchronously and works live; making it respond-then-process is out of scope. Idempotency is
   handled where it matters: `line_admin_messages.line_event_id` is unique (LINE message id), so a
   redelivered event cannot insert twice.
3. **Open questions resolved:** (1) ended conversations are kept until the platform owner deletes
   them (per-conversation delete button); (2) no LINE push to the owner on new requests, the page
   polls every 10 s; (3) the Rich Menu button sends fixed TEXT (that is how every existing button
   works), so the trigger is the exact message `คุยกับแอดมิน` and the user-side end phrase is
   `จบการสนทนา`. Exact-match only, never substring, so ordinary sentences can never opt a user in.
4. **Availability:** chat is offered to linked DM senders only (workers, admins, owners). An
   unlinked sender still gets the existing "account not found" reply.
5. **Sequencing:** do not apply any migration or deploy any function until the Supabase region
   relocation cutover is done; the cron job URL and the LINE webhook URL are project-specific.
