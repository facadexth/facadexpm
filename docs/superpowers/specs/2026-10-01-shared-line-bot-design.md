# Shared Platform LINE Bot — Design Spec

## Goal

Replace per-tenant LINE Official Account setup (each tenant provides their own Channel ID/Secret/Access Token, obtained from LINE Developers Console) with ONE platform-owned LINE OA that every tenant connects to. This directly fixes the hardest onboarding blocker found in the 2026-10-01 platform readiness review: `bot_user_id` currently has no self-service UI path at all, and Channel ID/Secret/Token setup requires knowledge no non-technical construction-company admin has. Also gives FacadeX full control of the bot's branding across every tenant's crew ("ได้ mkt ไปเต็มๆ" — full marketing reach, the user's stated reason for preferring this over per-tenant bots).

## Background / current architecture

- `line_settings`: one row per tenant (`tenant_id UUID PRIMARY KEY`), holding `channel_id`, `channel_access_token`, `channel_secret`, `crew_group_id`, `bot_user_id`, `basic_id`. `channel_id` has a global unique index; nothing else does.
- `line-webhook`'s `Deno.serve` resolves the calling tenant ONCE per HTTP request, from the payload's `destination` field (the bot's own LINE-internal user id) matched against `line_settings.bot_user_id`. Every event in that request is then processed using that one `settings`/`tenant_id`.
- `field-form` resolves tenant independently, from the worker attached to the deep-link token (`workers.tenant_id`) — never touches `line_settings` for routing, only to look up `channel_access_token` for sending.
- The four `line-push-*` cron functions loop over every row in `line_settings` (`settingsRows`), each row supplying both the tenant to act on and the credential to push with.
- `sendLinePush`/`verifyLineSignature` (`_shared/line.ts`) take the access token / channel secret as plain parameters — they have no opinion about where those values come from.
- Unrecognized senders/groups are captured per-tenant today (`line_unlinked_senders`, `line_unrecognized_groups`, both carrying `tenant_id` from `settings.tenant_id` at capture time) for an admin to manually pick from a list in Communication Center.
- `workers.line_user_id` and `user_roles.line_user_id` already carry a **global** unique index each (confirmed live, `idx_workers_line_user_id` / `idx_user_roles_line_user_id`) — one LINE account can only ever be one worker or one admin/owner, platform-wide, today. This fact is load-bearing for the design below.

## Target architecture

### 1. Credentials become global, not per-tenant

- `channel_access_token` and `channel_secret` move to Supabase Edge Function secrets (`LINE_CHANNEL_ACCESS_TOKEN`, `LINE_CHANNEL_SECRET`), the same pattern `ANTHROPIC_API_KEY` already uses. Never stored in a DB table, never reach the frontend.
- `bot_user_id` and `basic_id` are not secret (LINE's own `Get Bot Info` response and the public `@handle` are both discoverable by anyone who messages the bot anyway). They become plain constants: one copy in `_shared/line.ts` for the edge functions, one matching copy in a small `src/lib/platformLineBot.js` for the frontend (used to render the add-friend QR/link in Communication Center). Set once by whoever stands up the shared OA; never a per-tenant input again.
- `line_settings` keeps exactly one column that still varies per tenant: `crew_group_id`. The four credential columns (`channel_id`, `channel_access_token`, `channel_secret`, `bot_user_id`) stop being read anywhere in code. Left in place, not dropped — the real tenant's existing row already has real values in them, and leaving unused columns is strictly safer than a destructive migration for zero functional gain. A follow-up cleanup migration (nulling them out, or dropping the columns) can happen later once this is live and stable; out of scope for this spec.

### 2. The real existing tenant needs ZERO re-linking

Because the user chose to promote the current production OA to be the shared platform bot (reuse + rebrand, not a new OA), the one real tenant's `crew_group_id` is already correct — the bot is already in their real crew group. Nothing about their row needs to change. Only the *code* changes (stop reading their `channel_access_token`, start reading the global secret) — invisible to them.

### 3. Global uniqueness on `crew_group_id`

Today, nothing stops two different tenants' rows from holding the same `crew_group_id` string (harmless today, since each tenant's bot is a separate real LINE channel so the IDs can never actually collide in practice). Once every tenant shares one real bot, a given LINE group can only ever belong to one tenant. Add:

```sql
CREATE UNIQUE INDEX idx_line_settings_crew_group_id ON line_settings(crew_group_id) WHERE crew_group_id IS NOT NULL;
```

### 4. Webhook signature verification stays request-level, tenant resolution moves to event-level

`destination` is now the same constant bot_user_id for every tenant, so it can no longer be used to find "the" tenant for a request — there may not be one single tenant for a given webhook call if LINE batches events from more than one source group together. Signature verification still happens once per request (against the single global `channel_secret`). Tenant resolution moves **inside** the per-event loop:

- Event has `source.groupId` → `SELECT tenant_id FROM line_settings WHERE crew_group_id = :groupId`. Found → proceed as that tenant. Not found → this group has never been linked to anyone; see §5.
- Event has `source.userId` (DM) → `SELECT tenant_id FROM workers WHERE line_user_id = :userId` (globally unique, so at most one row), else `SELECT tenant_id FROM user_roles WHERE line_user_id = :userId`. Found → proceed as that tenant. Not found → this person has never linked their account; see §6.

Every event that fails to resolve a tenant is skipped (no reply, no write) except where §5/§6 specify an explicit response.

### 5. New crew-group linking flow — code-based, replaces "browse unclaimed groups"

**The problem with keeping today's flow:** today, an unrecognized group gets captured with `tenant_id` already known (from the per-tenant bot's own settings row) — an admin just confirms "yes, that's my group." In a shared bot, a brand-new unclaimed group has **no tenant to attribute it to at capture time** — captures would have to be global and shown to every admin on the platform until someone claims it, which means every admin could browse every other tenant's pending group names/sample messages. That is a real cross-tenant data exposure, not acceptable.

**New flow (mirrors the existing worker/admin linking-code mechanism, which already solves exactly this kind of "prove you're the right tenant" problem):**

Schema addition: `line_settings.group_link_code TEXT` (nullable) + `group_link_code_expires_at TIMESTAMPTZ`, the same two-column shape `workers.line_link_code`/`user_roles.line_link_code` already use for the identical "short-lived claim code" purpose. No new table needed.

1. Admin opens Communication Center → "➕ เพิ่ม/เปลี่ยนกลุ่มทีมงาน" → system generates a random 6-digit code, writes it (+ a short expiry, matching the existing deep-link-token convention) to their own tenant's `line_settings` row.
2. UI shows: "เพิ่มบอทเข้ากลุ่มของคุณ แล้วพิมพ์รหัสนี้ในกลุ่ม: `123456`".
3. Admin adds the shared bot to their real crew group, someone types the code in that group.
4. Webhook sees a group message matching an outstanding group-link code for a group with no current owner → sets `line_settings.crew_group_id` for that code's `tenant_id`, invalidates the code, replies "✅ ตั้งกลุ่มนี้เป็นกลุ่มทีมงานเรียบร้อยแล้ว" in the group.
5. A code typed in a group that's already claimed by someone else, or an expired/already-used code, gets no silent group-claim — reply explains why (code expired/already used) without revealing who currently owns the group.

This also naturally replaces "switching to a new group" (same flow — generating a new code and claiming a different group moves `crew_group_id`) and needs no separate UI path for that case, unlike today's two-mechanism setup (manual paste + unrecognized-groups list).

`line_unrecognized_groups` capture is removed from the webhook entirely — no group is ever captured without a claim code resolving it to exactly one tenant first. This is the ONLY capture table this spec removes — see the correction in §6 below.

### 6. What does NOT need to change: `line_unlinked_senders` stays exactly as-is

Re-reading the current code closely (important correction from an earlier draft of this spec): `line_unlinked_senders` is captured **only for a sender inside an already-matched crew group** (`sourceGroupId === <that tenant's> crew_group_id`, a stranger typing in a group whose tenant is already known) — never for a DM, and never for an unmatched group. Since §4's event-level routing resolves the tenant from `crew_group_id` before this capture would ever run, `tenant_id` is exactly as known here as it is today. **No change needed to this capture or to Communication Center's existing "ผู้ส่งข้อความที่ยังไม่รู้จัก" admin review list** — it was never part of the cross-tenant risk.

The one genuinely new gap is a **DM from an unrecognized `userId`** (today: silently dropped, `line-webhook/index.ts:1028`, `if (!worker) continue` — no reply, no capture, nothing). A DM sender who has never linked cannot be attributed to any tenant, so unlike the group case, there is no safe tenant-scoped place to capture them. Add an explicit reply at that exact spot instead of a silent `continue`:

> "ยังไม่พบบัญชีนี้ในระบบ — กรุณาติดต่อแอดมินของบริษัทคุณเพื่อขอรหัสเชื่อมต่อ 6 หลัก"
> ("This account isn't recognized yet — contact your company's admin for a 6-digit link code.")

This is a pure improvement over today's silent drop, not a replacement of an existing capture — nothing is removed here, only a reply is added.

### 7. `field-form` and the four `line-push-*` functions

These already resolve their tenant independently of `line_settings`/`destination` (worker's own `tenant_id`, or looping tenants directly) — **no routing logic changes**. The only edit: every `sendLinePush(settings.channel_access_token, ...)` call becomes `sendLinePush(LINE_CHANNEL_ACCESS_TOKEN, ...)` (the shared constant). The four push functions' `settingsRows` query (`SELECT ... FROM line_settings WHERE crew_group_id IS NOT NULL`) is unchanged — it's still exactly "which tenants have a crew group configured," which remains meaningful and per-tenant.

### 8. Branding

Reuses the existing production LINE OA (zero re-migration, per §2) — rename its **display name and profile photo** via LINE Official Account Manager to a neutral platform identity. Proposed name: **"FacadeXPM"** (placeholder — trivial to change later since renaming a LINE OA never touches credentials, webhook URL, or any linked group/account). Channel ID, webhook URL, `bot_user_id`, and every currently-linked group/worker/admin are completely unaffected by a display-name/photo change.

### 9. Communication Center UI changes

- Remove the Channel ID / Channel Secret / Channel Access Token / Basic ID input fields entirely — nothing left for a tenant admin to configure there.
- Replace with: the platform bot's QR code / add-friend link (built from the constant `basic_id`), one line of instruction ("เพิ่มเพื่อนบอทนี้ก่อน"), then the new code-based "➕ เพิ่ม/เปลี่ยนกลุ่มทีมงาน" flow from §5.
- The ⚠️ "ยังไม่มี Bot User ID" warning and its underlying problem disappear entirely — there is no more per-tenant `bot_user_id` to be missing.
- `line_command_settings` (per-tenant command enable/phrase customization) is untouched — still fully per-tenant, still works exactly as today.

## Isolation guarantee (summary)

1. **LINE's own platform** guarantees a group's members only ever see that group's messages — true regardless of how many tenants share one bot, not something this design can break even with a routing bug.
2. **Every webhook event is resolved to at most one tenant**, strictly via a global-unique lookup (`crew_group_id`, or `workers`/`user_roles.line_user_id`, all already-unique or newly made unique by §3) — never a lookup scoped to "the tenant we already think we're talking to."
3. **No cross-tenant list is ever shown to an admin.** `line_unrecognized_groups` (the one capture that genuinely had no safe tenant to attribute to) is replaced by code-based self-claiming (§5); `line_unlinked_senders` needs no change at all since it only ever fires inside an already-resolved tenant's group (§6). A DM from someone never linked gets an instructive reply instead of silent capture (§6) — an admin can only ever claim a group by proving tenant identity via a code generated inside their own already-authenticated session.
4. Every downstream DB query (sites, workers, leave_requests, etc.) is unchanged — still filtered by the resolved `tenant_id` exactly as today, and RLS remains the backstop it already is.

## Out of scope for this spec

- Per-tier LINE usage limits (`packages.max_line_messages_per_month`) — a real follow-up (flagged in the platform readiness review as priority #4), orthogonal to this migration. The shared bot changes *what credential* a push uses, not how many a tenant is allowed.
- Dropping/nulling the now-unused credential columns on `line_settings` — safe cleanup, not required for correctness, deferred.
- A tenant-configurable "use your own dedicated bot instead" option (mentioned as a possible Enterprise carve-out in the tier proposal) — would reintroduce per-tenant credentials as an opt-in path; not needed for the initial rollout with one real tenant.
