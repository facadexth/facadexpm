# Shared Platform LINE Bot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move every tenant off per-tenant LINE Official Account credentials onto one platform-owned, rebranded LINE bot, with tenant resolved per-event instead of per-request.

**Architecture:** Credentials (`channel_access_token`, `channel_secret`) become Supabase Edge Function secrets shared by every function; `bot_user_id`/`basic_id` become plain constants. `line_settings` keeps only `crew_group_id` as tenant-varying data, plus a new `group_link_code` column for the code-based group-claim flow that replaces the old "browse unclaimed groups" admin UI (removed because, in a shared bot, an unclaimed group has no tenant to safely attribute it to until a code proves ownership).

**Tech Stack:** Deno Edge Functions (Supabase), React/Vite frontend, Postgres/Supabase.

**Spec:** `docs/superpowers/specs/2026-10-01-shared-line-bot-design.md`

## Global Constraints

- Every downstream handler function in `line-webhook/index.ts` (`resolveWorker`, `alertOwnersOfInactiveWorker`, `handleAction`, `handleGroupInfoQuery`, every `handle*` function) already consumes only `settings: { tenant_id: string; channel_access_token: string }` — never touch their signatures or bodies. The rewrite's job is to keep supplying that exact shape, reconstructed per-event instead of once per request.
- `line_unlinked_senders` capture (a stranger inside an ALREADY-matched crew group) needs **zero changes** — tenant is already known there from the group match. Do not touch it. Only `line_unrecognized_groups` capture is removed.
- `workers.line_user_id` and `user_roles.line_user_id` already carry a platform-wide unique index each — a lookup by either, with no tenant filter, returns at most one row. This is what makes per-event tenant resolution for DMs correct.
- **Deployment ordering, not a task of its own:** none of this plan's edge-function code will work in production until two Supabase Edge Function secrets exist — `LINE_CHANNEL_ACCESS_TOKEN` and `LINE_CHANNEL_SECRET`, set to the real tenant's EXISTING values (read them from that tenant's current `line_settings` row in Settings/Communication Center, or the Supabase dashboard's table editor — never have an agent print or log the raw values). This is an action only the user can take (Supabase dashboard → Edge Functions → Secrets, or `supabase secrets set` via CLI). Task 5 cannot be verified live until this is done; say so explicitly when Task 5 is reached rather than silently skipping live verification.

---

### Task 1: Database migration + shared constants

**Files:**
- Create: `supabase/migrations/2026-10-01-04-shared-line-bot.sql`
- Modify: `supabase/functions/_shared/line.ts`

**Interfaces:**
- Produces: `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_CHANNEL_SECRET`, `LINE_BOT_USER_ID`, `LINE_BASIC_ID` — four exported constants from `_shared/line.ts`, consumed by every other task in this plan.

- [ ] **Step 1: Write the migration**

```sql
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
```

- [ ] **Step 2: Add the shared constants to `_shared/line.ts`**

Add near the top of the file, after the existing `LINE_API` constant:

```ts
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
export const LINE_CHANNEL_ACCESS_TOKEN = Deno.env.get('LINE_CHANNEL_ACCESS_TOKEN')!
export const LINE_CHANNEL_SECRET = Deno.env.get('LINE_CHANNEL_SECRET')!
export const LINE_BOT_USER_ID = 'REPLACE_WITH_REAL_BOT_USER_ID'
export const LINE_BASIC_ID = 'REPLACE_WITH_REAL_BASIC_ID'
```

The two `REPLACE_WITH_REAL_*` placeholders are the literal `bot_user_id`/`basic_id` values already sitting in the real tenant's current `line_settings` row (read via Settings → Communication Center, or a `SELECT bot_user_id, basic_id FROM line_settings` in Supabase's table editor) — fill in the real values, they are not secret and are safe to commit. If Task 1's implementer doesn't have DB read access to fetch them, leave the placeholders and flag it as a blocker in the task report rather than guessing.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/2026-10-01-04-shared-line-bot.sql supabase/functions/_shared/line.ts
git commit -m "feat: schema + shared constants for platform LINE bot"
```

---

### Task 2: `line-webhook/index.ts` — per-event tenant resolution + claim-code flow

**Files:**
- Modify: `supabase/functions/line-webhook/index.ts`

**Interfaces:**
- Consumes: `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_CHANNEL_SECRET` from Task 1's `_shared/line.ts`.
- Produces: no change to any existing function's signature — `resolveWorker`, `alertOwnersOfInactiveWorker`, `handleAction`, `handleGroupInfoQuery`, and every other `handle*` function are consumed exactly as they are today by later code in this same file.

This task touches only the top of `Deno.serve` (roughly `line-webhook/index.ts:944–1150` today) — the request-level setup, the DM 6-digit-code check, and the group "is this the right crew group" check. Nothing below `matchGroupInfoAction`'s handling (today's `line-webhook/index.ts:1155` onward) changes at all.

- [ ] **Step 1: Replace request-level settings/signature resolution**

Find (today, `line-webhook/index.ts:944-966`):

```ts
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const rawBody = await req.text()
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }
  const destination = payload.destination as string | undefined
  if (!destination) return json({ error: 'destination required' }, 400)

  const { data: settings } = await admin.from('line_settings').select('*').eq('bot_user_id', destination).maybeSingle()
  if (!settings) return json({ error: 'unknown channel' }, 404)

  const signatureOk = await verifyLineSignature(settings.channel_secret, rawBody, req.headers.get('x-line-signature'))
  if (!signatureOk) return json({ error: 'invalid signature' }, 401)

  // Real gap closed 2026-10-01: ... [the tenantHasModuleAccess block added earlier today]
  const hasLineAccess = await tenantHasModuleAccess(admin, settings.tenant_id, 'line_bot')
  if (!hasLineAccess) return json({ ok: true, skipped: 'line_bot module not enabled for this tenant' })

  const { data: commandSettingsRows } = await admin.from('line_command_settings').select('command_key, enabled_dm, enabled_group, custom_phrase').eq('tenant_id', settings.tenant_id)
  const commandSettingsByKey: CommandSettingsByKey = Object.fromEntries((commandSettingsRows ?? []).map((r: any) => [r.command_key, r]))

  const events = (payload.events as Array<Record<string, any>>) ?? []
  for (const event of events) {
```

Replace with:

```ts
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const rawBody = await req.text()
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }

  // destination is now the same constant bot_user_id for every tenant --
  // it identifies OUR bot, not which tenant sent this. Signature
  // verification moves to the one global channel_secret; tenant
  // resolution moves inside the per-event loop below (see
  // docs/superpowers/specs/2026-10-01-shared-line-bot-design.md §4).
  const signatureOk = await verifyLineSignature(LINE_CHANNEL_SECRET, rawBody, req.headers.get('x-line-signature'))
  if (!signatureOk) return json({ error: 'invalid signature' }, 401)

  // Per-tenant line_command_settings now loaded lazily per resolved
  // tenant, cached here so a request with several events from the same
  // tenant (common -- LINE batches events) only queries once.
  const commandSettingsCache = new Map<string, CommandSettingsByKey>()
  async function loadCommandSettings(tenantId: string): Promise<CommandSettingsByKey> {
    const cached = commandSettingsCache.get(tenantId)
    if (cached) return cached
    const { data: rows } = await admin.from('line_command_settings').select('command_key, enabled_dm, enabled_group, custom_phrase').eq('tenant_id', tenantId)
    const byKey: CommandSettingsByKey = Object.fromEntries((rows ?? []).map((r: any) => [r.command_key, r]))
    commandSettingsCache.set(tenantId, byKey)
    return byKey
  }

  const events = (payload.events as Array<Record<string, any>>) ?? []
  for (const event of events) {
```

- [ ] **Step 2: Insert per-event tenant resolution, right after the existing early `msgType`/`lineUserId`/`sourceGroupId` extraction**

The existing lines (today, `line-webhook/index.ts:975-979`):

```ts
    const text: string | undefined = msgType === 'text' ? event.message.text : undefined
    const messageId: string = event.message.id
    const lineUserId: string | undefined = event.source?.userId
    const sourceGroupId: string | undefined = event.source?.groupId
    if (!lineUserId) continue
```

stay exactly as they are. Immediately after them, insert:

```ts
    // Resolve the tenant for THIS event specifically -- see spec §4.
    // DM code-check happens first (a typed 6-digit code IS the
    // identification for a never-before-seen sender, so it must be
    // checked before concluding "unrecognized").
    let tenantId: string | null = null
    let claimedViaCode = false

    if (!sourceGroupId && msgType === 'text' && text) {
      const trimmed = text.trim()
      // No tenant filter here -- unlike today's per-tenant version,
      // we don't know the tenant yet, that's what this lookup resolves.
      // Collision across two different tenants' simultaneously-valid
      // codes is practically impossible (30^6 combinations, same
      // assumption the pre-existing per-tenant version already made).
      const { data: pendingRoleCode } = await admin.from('user_roles').select('id, tenant_id').eq('line_link_code', trimmed).maybeSingle()
      if (pendingRoleCode) {
        const { error } = await admin.from('user_roles').update({ line_user_id: lineUserId, line_link_code: null }).eq('id', pendingRoleCode.id)
        if (error) {
          console.error('user_roles line-link update failed', error)
          await sendLineReply(LINE_CHANNEL_ACCESS_TOKEN, event.replyToken, '⚠️ เชื่อมต่อไม่สำเร็จ กรุณาลองใหม่หรือแจ้งแอดมิน')
        } else {
          await sendLineReply(LINE_CHANNEL_ACCESS_TOKEN, event.replyToken, '✅ เชื่อมต่อ LINE เรียบร้อยแล้วครับ')
        }
        continue
      }
      const { data: pendingWorkerCode } = await admin.from('workers').select('id, tenant_id').eq('line_link_code', trimmed).maybeSingle()
      if (pendingWorkerCode) {
        const { error } = await admin.from('workers').update({ line_user_id: lineUserId, line_link_code: null }).eq('id', pendingWorkerCode.id)
        if (error) {
          console.error('workers line-link update failed', error)
          await sendLineReply(LINE_CHANNEL_ACCESS_TOKEN, event.replyToken, '⚠️ เชื่อมต่อไม่สำเร็จ กรุณาลองใหม่หรือแจ้งแอดมิน')
        } else {
          await sendLineReply(LINE_CHANNEL_ACCESS_TOKEN, event.replyToken, '✅ เชื่อมต่อ LINE เรียบร้อยแล้วครับ')
        }
        continue
      }
    }

    if (sourceGroupId) {
      const { data: match } = await admin.from('line_settings').select('tenant_id').eq('crew_group_id', sourceGroupId).maybeSingle()
      tenantId = (match?.tenant_id as string | undefined) ?? null
    } else {
      const { data: w } = await admin.from('workers').select('tenant_id').eq('line_user_id', lineUserId).maybeSingle()
      tenantId = (w?.tenant_id as string | undefined) ?? null
      if (!tenantId) {
        const { data: u } = await admin.from('user_roles').select('tenant_id').eq('line_user_id', lineUserId).maybeSingle()
        tenantId = (u?.tenant_id as string | undefined) ?? null
      }
    }

    if (!tenantId) {
      if (sourceGroupId && msgType === 'text' && text) {
        // Group-claim code check (spec §5) -- a group with no owner yet
        // whose message matches SOME tenant's outstanding
        // group_link_code gets claimed for that tenant.
        const trimmed = text.trim()
        const { data: claimant } = await admin.from('line_settings').select('tenant_id').eq('group_link_code', trimmed).maybeSingle()
        if (claimant) {
          const { error } = await admin.from('line_settings').update({ crew_group_id: sourceGroupId, group_link_code: null }).eq('tenant_id', claimant.tenant_id)
          if (error) {
            console.error('line_settings group claim failed', error)
            await sendLineReply(LINE_CHANNEL_ACCESS_TOKEN, event.replyToken, '⚠️ ตั้งกลุ่มไม่สำเร็จ กรุณาลองใหม่หรือแจ้งแอดมิน')
          } else {
            await sendLineReply(LINE_CHANNEL_ACCESS_TOKEN, event.replyToken, '✅ ตั้งกลุ่มนี้เป็นกลุ่มทีมงานเรียบร้อยแล้ว')
          }
        }
        // No match at all -- not a claim code (or an expired/already-used
        // one), and no way to tell the difference without revealing
        // whether some other tenant's code once existed. Silently ignore,
        // same as any other unrecognized group text today.
      } else if (!sourceGroupId && msgType === 'text' && text) {
        // DM from a never-linked account -- see spec §6. Pure addition,
        // not a replacement: today this is a silent `continue` with no
        // reply at all.
        await sendLineReply(LINE_CHANNEL_ACCESS_TOKEN, event.replyToken, 'ยังไม่พบบัญชีนี้ในระบบ — กรุณาติดต่อแอดมินของบริษัทคุณเพื่อขอรหัสเชื่อมต่อ 6 หลัก')
      }
      continue
    }

    const hasLineAccess = await tenantHasModuleAccess(admin, tenantId, 'line_bot')
    if (!hasLineAccess) continue

    const commandSettingsByKey = await loadCommandSettings(tenantId)
    const settings = { tenant_id: tenantId, channel_access_token: LINE_CHANNEL_ACCESS_TOKEN }
```

Everything from this point to the end of the `for` loop body — the `if (!sourceGroupId) { ... }` DM-handling block's resolveWorker/pending-action/matchDMAction logic, and the group-handling block's `matchGroupInfoAction`/`resolveWorker`/`matchGroupAction` logic — **stays completely unchanged**, now reading the locally-constructed `settings` and `commandSettingsByKey` instead of the old request-level ones. Do not edit any of it.

- [ ] **Step 2b: Remove the now-dead "unrecognized group" capture block**

Delete this block entirely (today, `line-webhook/index.ts:1136-1149`) — it's unreachable now: by the time code reaches this point in the group branch, `tenantId` was already resolved from a `crew_group_id` match, so `sourceGroupId === settings.crew_group_id` is always true.

```ts
    if (sourceGroupId !== settings.crew_group_id) {
      // ... line_unrecognized_groups upsert, then continue ...
    }
```

Leave the two lines directly above it in place (`if (msgType !== 'text' || !text) continue`) — that guard still applies.

- [ ] **Step 3: Remove the now-unused `tenantHasModuleAccess` import line if it was duplicated, and update the top-of-file import to add the new constants**

```ts
import { verifyLineSignature, sendLineReply, sendLinePush, LINE_CHANNEL_ACCESS_TOKEN, LINE_CHANNEL_SECRET } from '../_shared/line.ts'
```

(keep the existing `tenantHasModuleAccess` import from `../_shared/tenant-access.ts` as-is.)

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/line-webhook/index.ts
git commit -m "feat: per-event tenant resolution + group-claim-code flow in line-webhook"
```

---

### Task 3: Credential swap in the other 8 LINE-adjacent functions

**Files:**
- Modify: `supabase/functions/field-form/index.ts`
- Modify: `supabase/functions/leave-notify/index.ts`
- Modify: `supabase/functions/line-test-group/index.ts`
- Modify: `supabase/functions/line-worker-offboarded/index.ts`
- Modify: `supabase/functions/line-push-daily-assignments/index.ts`
- Modify: `supabase/functions/line-push-quotation-followups/index.ts`
- Modify: `supabase/functions/line-push-cheque-reminders/index.ts`
- Modify: `supabase/functions/line-push-invoice-due/index.ts`

**Interfaces:**
- Consumes: `LINE_CHANNEL_ACCESS_TOKEN` from `_shared/line.ts` (Task 1).

Same mechanical change in all 8 files: add `LINE_CHANNEL_ACCESS_TOKEN` to each file's existing `import { ... } from '../_shared/line.ts'` line, then remove every `channel_access_token` DB read and replace its use in `sendLinePush(...)` with the constant directly.

- [ ] **Step 1: `field-form/index.ts`**

In `notifyAdmins`, replace:

```ts
async function notifyAdmins(tenantId: string, text: string) {
  const { data: settings } = await admin.from('line_settings').select('channel_access_token').eq('tenant_id', tenantId).maybeSingle()
  if (!settings?.channel_access_token) return
  const { data: admins } = await admin.from('user_roles').select('line_user_id').eq('tenant_id', tenantId).in('role', ['OWNER', 'ADMIN']).not('line_user_id', 'is', null)
  for (const a of admins ?? []) {
    await sendLinePush(settings.channel_access_token, a.line_user_id as string, text).catch((e) => console.error('notifyAdmins push failed', e))
  }
}
```

with:

```ts
async function notifyAdmins(tenantId: string, text: string) {
  const { data: admins } = await admin.from('user_roles').select('line_user_id').eq('tenant_id', tenantId).in('role', ['OWNER', 'ADMIN']).not('line_user_id', 'is', null)
  for (const a of admins ?? []) {
    await sendLinePush(LINE_CHANNEL_ACCESS_TOKEN, a.line_user_id as string, text).catch((e) => console.error('notifyAdmins push failed', e))
  }
}
```

In `notifyWorker`, replace:

```ts
async function notifyWorker(tenantId: string, lineUserId: string | null | undefined, text: string) {
  if (!lineUserId) return
  const { data: settings } = await admin.from('line_settings').select('channel_access_token').eq('tenant_id', tenantId).maybeSingle()
  if (!settings?.channel_access_token) return
  await sendLinePush(settings.channel_access_token, lineUserId, text).catch((e) => console.error('notifyWorker push failed', e))
}
```

with:

```ts
async function notifyWorker(tenantId: string, lineUserId: string | null | undefined, text: string) {
  if (!lineUserId) return
  await sendLinePush(LINE_CHANNEL_ACCESS_TOKEN, lineUserId, text).catch((e) => console.error('notifyWorker push failed', e))
}
```

(the `tenantId` parameter on both functions is now unused by the body but keep it — every call site still passes it, and removing it would be a pointless signature churn for zero benefit.)

Update the import: `import { sendLinePush, LINE_CHANNEL_ACCESS_TOKEN } from '../_shared/line.ts'`

- [ ] **Step 2: `leave-notify/index.ts`**

Replace:

```ts
  const { data: settings } = await admin.from('line_settings').select('channel_access_token').eq('tenant_id', req_.tenant_id).maybeSingle()
  if (!settings?.channel_access_token) return json({ ok: true, skipped: 'no_line_settings' })
```

(and the two lines around it that reference `settings.channel_access_token`) — delete this block entirely, and change:

```ts
  const result = await sendLinePush(settings.channel_access_token, lineUserId, text)
```

to:

```ts
  const result = await sendLinePush(LINE_CHANNEL_ACCESS_TOKEN, lineUserId, text)
```

Update the import: `import { sendLinePush, LINE_CHANNEL_ACCESS_TOKEN } from '../_shared/line.ts'`

- [ ] **Step 3: `line-test-group/index.ts`**

Replace:

```ts
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  const { data: settings } = await admin.from('line_settings').select('channel_access_token').eq('tenant_id', tenantId).maybeSingle()
  if (!settings?.channel_access_token) return json({ ok: false, error: 'ยังไม่ได้ตั้งค่า Channel Access Token กรุณาบันทึกการเชื่อมต่อก่อน' })

  const res = await fetch(`https://api.line.me/v2/bot/group/${encodeURIComponent(groupId)}/summary`, {
    headers: { Authorization: `Bearer ${settings.channel_access_token}` },
  })
```

with:

```ts
  const res = await fetch(`https://api.line.me/v2/bot/group/${encodeURIComponent(groupId)}/summary`, {
    headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` },
  })
```

(the `admin`/`is_owner`/`current_tenant_id` auth-gate calls above this stay — this function still correctly requires the caller to be an OWNER, it just no longer needs `tenantId` for a credential lookup. `tenantId` itself can stay unused or the whole `current_tenant_id()` RPC call can be dropped since nothing downstream needs it anymore — dropping it is a reasonable simplification, keeping it is also fine; implementer's judgment, not worth a separate review cycle either way.)

Add the import: `import { LINE_CHANNEL_ACCESS_TOKEN } from '../_shared/line.ts'`

- [ ] **Step 4: `line-worker-offboarded/index.ts`**

Replace:

```ts
  const { data: settings } = await admin.from('line_settings').select('channel_access_token').eq('tenant_id', worker.tenant_id).maybeSingle()
  if (!settings) return json({ ok: true, skipped: 'no line_settings for this tenant' })
```

with: delete entirely (no longer meaningful — every tenant now shares the same bot regardless of whether they have a `line_settings` row at all; the real gate is whether the worker has any OWNER with a linked `line_user_id`, checked by the very next query already in this file).

Replace:

```ts
    await sendLinePush(settings.channel_access_token, owner.line_user_id as string, `⚠️ ${worker.name} ถูกเปลี่ยนสถานะเป็นพ้นสภาพพนักงาน กรุณาลบออกจากกลุ่มทีมงานใน LINE ด้วยครับ`)
```

with:

```ts
    await sendLinePush(LINE_CHANNEL_ACCESS_TOKEN, owner.line_user_id as string, `⚠️ ${worker.name} ถูกเปลี่ยนสถานะเป็นพ้นสภาพพนักงาน กรุณาลบออกจากกลุ่มทีมงานใน LINE ด้วยครับ`)
```

Add the import: `import { sendLinePush, LINE_CHANNEL_ACCESS_TOKEN } from '../_shared/line.ts'` (adjust to match whatever that file already imports from `_shared/line.ts`, if anything).

- [ ] **Step 5: The four `line-push-*` functions**

Identical change in `line-push-daily-assignments/index.ts`, `line-push-quotation-followups/index.ts`, `line-push-cheque-reminders/index.ts`, `line-push-invoice-due/index.ts`:

1. Add `LINE_CHANNEL_ACCESS_TOKEN` to each file's `import { sendLinePush } from '../_shared/line.ts'` line.
2. In each file's `settingsRows` query, drop `channel_access_token` from the `.select(...)` column list (keep `tenant_id`, `crew_group_id`, and anything else already selected).
3. Every `sendLinePush(settings.channel_access_token, ...)` call in each file becomes `sendLinePush(LINE_CHANNEL_ACCESS_TOKEN, ...)`.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/field-form/index.ts supabase/functions/leave-notify/index.ts supabase/functions/line-test-group/index.ts supabase/functions/line-worker-offboarded/index.ts supabase/functions/line-push-daily-assignments/index.ts supabase/functions/line-push-quotation-followups/index.ts supabase/functions/line-push-cheque-reminders/index.ts supabase/functions/line-push-invoice-due/index.ts
git commit -m "feat: swap per-tenant LINE credential reads for the shared platform bot constant"
```

---

### Task 4: Communication Center — remove credential form, add platform-bot connect flow

**Files:**
- Create: `src/lib/platformLineBot.js`
- Modify: `src/pages/CommunicationCenter.jsx`

**Interfaces:**
- Produces: `PLATFORM_BOT_BASIC_ID`, `PLATFORM_BOT_NAME` from `src/lib/platformLineBot.js`, consumed by `CommunicationCenter.jsx`.

- [ ] **Step 1: Create the frontend constants file**

```js
// src/lib/platformLineBot.js
// Mirrors the bot_user_id/basic_id constants in
// supabase/functions/_shared/line.ts -- every tenant connects to this
// ONE LINE OA now (see docs/superpowers/specs/2026-10-01-shared-line-bot-design.md).
// Neither value is secret: LINE's own Get Bot Info response and the
// public @handle are both discoverable by anyone who messages the bot.
export const PLATFORM_BOT_BASIC_ID = 'REPLACE_WITH_REAL_BASIC_ID' // must match LINE_BASIC_ID in _shared/line.ts exactly
export const PLATFORM_BOT_NAME = 'FacadeXPM'
```

- [ ] **Step 2: Remove the credential input fields**

In `CommunicationCenter.jsx`, delete the Channel ID / Channel Secret / Channel Access Token / Basic ID `<input>` blocks (today, roughly lines 590-609) and their corresponding `connForm` state keys (`channel_id`, `channel_secret`, `channel_access_token`, `basic_id`) — `crew_group_id` is the only field left to manage by hand here, and even that gets replaced by the claim-code flow in Step 4 below. Delete `handleSaveConnection`'s credential-insert path (the `if (!lineSettings) { ...insert channel_id/channel_secret/channel_access_token... }` branch) and its required-fields alert at the top of that function.

- [ ] **Step 3: Replace the connection card's content with the platform-bot connect UI**

Where the credential form used to render, show instead:

```jsx
<div style={{ padding: 16 }}>
  <div style={{ fontSize: 12.5, color: 'var(--text3)', marginBottom: 12 }}>
    เพิ่มเพื่อนบอท <b>{PLATFORM_BOT_NAME}</b> ก่อน แล้วเพิ่มเข้ากลุ่มทีมงานของคุณ
  </div>
  <a className="btn btn-ghost" href={`https://line.me/R/ti/p/@${PLATFORM_BOT_BASIC_ID}`} target="_blank" rel="noreferrer">
    ➕ เพิ่มเพื่อน {PLATFORM_BOT_NAME}
  </a>
</div>
```

(`https://line.me/R/ti/p/@<basic_id>` is LINE's standard add-friend link format — opens LINE directly to that OA's add-friend screen.)

- [ ] **Step 4: Add the group-claim-code flow, replacing the plain `crew_group_id` text input**

```jsx
const [groupClaimCode, setGroupClaimCode] = useState(null)
const [generatingGroupCode, setGeneratingGroupCode] = useState(false)
const handleGenerateGroupCode = async () => {
  setGeneratingGroupCode(true)
  try {
    const code = generateLinkCode()
    const { error } = await supabase.from('line_settings').update({ group_link_code: code }).eq('tenant_id', tenant.id)
    if (error) throw error
    setGroupClaimCode(code)
  } catch (e) {
    alert('Error: ' + e.message)
  } finally {
    setGeneratingGroupCode(false)
  }
}
```

```jsx
<div style={{ marginTop: 14 }}>
  <label className="label">กลุ่มทีมงาน</label>
  {lineSettings?.crew_group_id ? (
    <div style={{ fontSize: 12.5, color: 'var(--green)' }}>✅ ตั้งค่าแล้ว</div>
  ) : (
    <div style={{ fontSize: 12.5, color: 'var(--text3)' }}>ยังไม่ได้ตั้งค่า</div>
  )}
  <button type="button" className="btn btn-ghost btn-sm" disabled={generatingGroupCode} onClick={handleGenerateGroupCode} style={{ marginTop: 6 }}>
    {generatingGroupCode ? '⏳...' : lineSettings?.crew_group_id ? '🔄 เปลี่ยนกลุ่มทีมงาน' : '➕ เพิ่มกลุ่มทีมงาน'}
  </button>
  {groupClaimCode && (
    <div style={{ fontSize: 12, marginTop: 8, padding: '8px 12px', background: 'var(--surface-2)', borderRadius: 8 }}>
      เพิ่มบอทเข้ากลุ่มของคุณ แล้วพิมพ์รหัสนี้ในกลุ่ม:
      <div style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: 16, letterSpacing: 2, marginTop: 4 }}>{groupClaimCode}</div>
    </div>
  )}
</div>
```

Remove the old `handleTestGroupId`/`line-test-group` invoke button from this card (optional to keep elsewhere — the claim-code flow makes a successful claim self-verifying: the bot's own "✅ ตั้งกลุ่มนี้เป็นกลุ่มทีมงานเรียบร้อยแล้ว" reply, visible to the whole group, already proves it worked).

- [ ] **Step 5: Remove the "ยังไม่มี Bot User ID" warning**

Delete the block (today, roughly lines 624-628):

```jsx
{!lineSettings?.bot_user_id && lineSettings && (
  <div className="alert alert-warning" style={{ fontSize: 12 }}>
    ⚠️ ยังไม่มี Bot User ID — บอทจะไม่ตอบข้อความจนกว่าผู้ดูแลระบบจะตั้งค่านี้ให้ (ดึงจาก LINE Get Bot Info API)
  </div>
)}
```

— there is no more per-tenant `bot_user_id` to be missing.

- [ ] **Step 6: Leave everything else in the file unchanged**

`line_command_settings` (the "📖 คำสั่งที่พิมพ์ได้ในไลน์" card), the "🙋 เชื่อมต่อ LINE ส่วนตัว" card (OWNER/ADMIN's own `user_roles.line_link_code`), the "👷 การเชื่อมต่อ LINE ของทีมงาน" card (worker linking), the "❓ ผู้ส่งข้อความที่ยังไม่รู้จัก" card (`line_unlinked_senders` — per the spec correction, this needs no change), and the iOS Shortcuts tip card added earlier today are all completely unaffected by this task — do not touch them. The "👥 กลุ่มไลน์ที่ยังไม่ตั้งเป็นกลุ่มทีมงาน" card (`line_unrecognized_groups`) should be **removed** — that table is no longer populated by anything after Task 2, so this card would only ever show an empty list.

- [ ] **Step 7: Build and verify**

```bash
npm run build
```

Expected: builds clean, no references to the removed `connForm` keys or deleted functions remain.

- [ ] **Step 8: Commit**

```bash
git add src/lib/platformLineBot.js src/pages/CommunicationCenter.jsx
git commit -m "feat: Communication Center connects to the shared platform bot via claim codes"
```

---

### Task 5: Final verification

**Files:** none (verification only).

- [ ] **Step 1: Confirm the prerequisite secrets are set**

Before any live test, confirm with the user that `LINE_CHANNEL_ACCESS_TOKEN` and `LINE_CHANNEL_SECRET` have been set as real Supabase Edge Function secrets (see this plan's Global Constraints). If not yet done, stop here and report that live verification is blocked on that — do not attempt to fake or skip it.

- [ ] **Step 2: Full build**

```bash
npm run build
```

Expected: clean build, no errors.

- [ ] **Step 3: Deploy all 9 touched edge functions + apply the migration**

(Via Supabase MCP once authenticated, or the user applying `supabase/migrations/2026-10-01-04-shared-line-bot.sql` + redeploying `line-webhook`, `field-form`, `leave-notify`, `line-test-group`, `line-worker-offboarded`, and the four `line-push-*` functions through the Supabase dashboard.)

- [ ] **Step 4: Live verification, as the real tenant's OWNER**

1. Open Communication Center — confirm the old credential fields are gone, the add-friend link renders, and (since this tenant's `crew_group_id` is already set — see spec §2, no re-linking needed) the group shows "✅ ตั้งค่าแล้ว" without generating any claim code.
2. In the real crew group, type "งานวันนี้" — confirm a reply arrives (proves event-level tenant resolution + signature verification against the global secret both work end-to-end).
3. DM the bot a nonsense message from an account with no linked worker/admin (a second personal LINE account, or ask a teammate) — confirm the new "ยังไม่พบบัญชีนี้ในระบบ..." reply arrives instead of silence.
4. Generate a group-claim code for a throwaway/test LINE group (not the real crew group — don't disturb it), add the bot, type the code, confirm the "✅ ตั้งกลุ่มนี้เป็นกลุ่มทีมงานเรียบร้อยแล้ว" reply and that `line_settings.crew_group_id` updated for the right tenant. Then release/delete that test claim (clear `crew_group_id` back, or leave it — test tenant's choice) so it doesn't collide with later testing.

- [ ] **Step 5: Version bump, changelog, manual**

Bump `package.json` + add a `src/changelog.json` entry (patch version) describing the LINE bot connection flow change. Update `public/manual/index.html`'s LINE bot section (`#page-line-bot`) to describe the new add-friend + claim-code flow instead of Channel ID/Secret/Token setup, and sync the same change into the Claude Artifact manual copy (`https://claude.ai/artifact/XTuSvCZRTdN8kDztUKed7G`) per the project's existing "update manual on push" convention — read it first, apply the matching edit, republish to the same URL.

- [ ] **Step 6: Final commit + push**

```bash
git add package.json src/changelog.json public/manual/index.html
git commit -m "docs: update manual for the shared platform LINE bot connect flow"
git push origin worktree-gantt-kanban:main
```

## Self-Review Notes

- **Spec coverage:** §1 (credentials) → Task 1. §2 (no re-linking) → noted, no task needed (nothing to do). §3 (unique index) → Task 1. §4 (event-level resolution) → Task 2. §5 (group claim flow) → Task 2 (webhook side) + Task 4 (UI side). §6 (DM reply, `line_unlinked_senders` unchanged) → Task 2, explicitly called out as "don't touch" in Global Constraints. §7 (other functions) → Task 3. §8 (branding) → mentioned in Task 5 Step 4 context (rename via LINE OA Manager is a user action outside this codebase, not a code task). §9 (UI changes) → Task 4.
- **Placeholder scan:** two literal `REPLACE_WITH_REAL_*` placeholders are deliberate (real secret/id values that must come from the live `line_settings` row, not guessable or safe to hardcode sight-unseen) — each has an explicit instruction for what to do if the implementer can't fill it in (flag as a blocker), not a silent TODO.
- **Type/interface consistency:** `settings: { tenant_id: string; channel_access_token: string }`'s shape is checked against every consumer named in Global Constraints and confirmed identical across `resolveWorker`, `alertOwnersOfInactiveWorker`, and all `handle*` functions during spec research — no drift introduced.
