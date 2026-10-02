# LINE Bot Hybrid Privacy Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the shared LINE bot store nothing new about a user's chat by default (`secure_bot`), and record messages/photos only while the user has explicitly opened a `chat_with_admin` session that only the platform owner can read and answer.

**Architecture:** A pure routing module (`line-admin-chat-logic.ts`, unit-tested by vitest) decides what to do with each DM event given the user's mode. A thin DB helper module does the reads/writes. `line-webhook` calls both once, right after tenant resolution, before any existing DM flow. Two new edge functions serve the owner's reply/end actions (JWT + `platform_admins` check) and idle expiry (cron secret). A platform-admin-only React page reads/writes through RLS-protected tables.

**Tech Stack:** Supabase (Postgres, RLS, Storage, pg_cron, Edge Functions on Deno/TypeScript), React 18 + Vite, vitest.

**Spec:** `docs/superpowers/specs/2026-10-02-line-hybrid-privacy-design.md` (read its "Amendments" section too; it overrides the body where they differ).

## Global Constraints

- Work only on branch `worktree-line-privacy-chat` in `.claude/worktrees/line-privacy-chat`. Never commit to `main` from this plan. Do not merge until every task is done.
- **Do NOT apply any migration (`apply_migration`) or deploy any edge function until the Supabase region relocation cutover is finished.** Migrations take effect the instant they are applied. Before cutover, validate SQL only inside a transaction that ends in `ROLLBACK` (via `execute_sql`).
- Start notice text, verbatim: `กำลังเชื่อมต่อกับเจ้าหน้าที่ ข้อมูลต่อจากนี้จะได้รับการบันทึกเพื่อให้แอดมินช่วยเหลือท่าน`
- End notice text, verbatim: `จบบทสนทนากับแอดมินแล้ว ข้อมูลต่อไปของคุณจะไม่ถูกบันทึกและแอดมินจะไม่เห็น` — it must NEVER claim encryption (no "เข้ารหัส").
- Trigger phrases are exact-match after trim, never substring: start `คุยกับแอดมิน`, end `จบการสนทนา`.
- `secure_bot` is the default and the fail-closed state: if the mode lookup errors, behave as `secure_bot`.
- In `secure_bot` the new code writes nothing and logs no message content. Existing tenant work flows (site photos, issue reports, etc.) are unchanged.
- Chat is DM-only; group messages never enter `chat_with_admin`.
- Access to the new tables and bucket: members of `platform_admins` only (policy expression `EXISTS (SELECT 1 FROM platform_admins WHERE user_email = auth.email())`). The webhook and cron use the service role.
- `upsert` `onConflict` must name the table's real PK/unique index exactly (known past bug).
- Version bump + `src/changelog.json` entry in the last task, following the existing entries' shape.
- Existing test command: `npm test` (vitest). Currently 301 tests pass; all must still pass.

## File Structure

| File | Responsibility |
|---|---|
| `supabase/functions/_shared/line-admin-chat-logic.ts` (create) | Pure: phrases, notices, `routeDmEvent`, `isSessionExpired`, `safeErrorSummary`, `logSafeError`. No Deno/DB imports so vitest can import it. |
| `src/lib/lineAdminChatLogic.test.js` (create) | vitest tests for the above. |
| `src/lib/lineCommandSettings.js` (modify) | Add the two phrases to `RESERVED_PHRASES`. |
| `supabase/migrations/2026-10-02-04-line-admin-chat.sql` (create) | 3 tables, RLS, private bucket + storage policy. |
| `supabase/functions/_shared/line-admin-chat.ts` (create) | DB helpers taking the service-role client. |
| `supabase/functions/line-webhook/index.ts` (modify) | Call routing once after tenant resolution; swap `console.error` for `logSafeError`. |
| `supabase/functions/line-admin-chat-send/index.ts` (create) | Owner reply / end / delete via JWT + platform admin check. |
| `supabase/functions/line-admin-chat-expire/index.ts` (create) | Cron: end idle sessions and notify users. |
| `supabase/migrations/2026-10-02-05-line-admin-chat-expire-cron.sql` (create) | Schedules the expire function. |
| `src/hooks/useSupabase.js` (modify) | `useAdminChatSessions`, `useAdminChatMessages`, `useAdminChatConfig`. |
| `src/pages/LineAdminChat.jsx` (create) | Platform-owner page. |
| `src/App.jsx` (modify) | Register the tab (`platformAdminOnly`). |

---

### Task 1: Pure routing logic and tests

**Files:**
- Create: `supabase/functions/_shared/line-admin-chat-logic.ts`
- Create: `src/lib/lineAdminChatLogic.test.js`
- Modify: `src/lib/lineCommandSettings.js:69-72`

**Interfaces:**
- Produces (used by Tasks 3, 4, 5, 6):
  - `type ChatMode = 'secure_bot' | 'chat_with_admin'`
  - `type DmRoute = 'start_chat' | 'end_chat' | 'record_text' | 'record_image' | 'normal_flow'`
  - `ADMIN_CHAT_START_PHRASE`, `ADMIN_CHAT_END_PHRASE`, `ADMIN_CHAT_START_NOTICE`, `ADMIN_CHAT_END_NOTICE` (strings)
  - `routeDmEvent(input: { mode: ChatMode; msgType: 'text' | 'image'; text?: string }): DmRoute`
  - `isSessionExpired(lastActivityMs: number, idleHours: number, nowMs: number): boolean`
  - `safeErrorSummary(err: unknown): { code: string | null; message: string }`
  - `logSafeError(label: string, err: unknown): void`

- [ ] **Step 1: Write the failing test**

Create `src/lib/lineAdminChatLogic.test.js`:

```js
import { describe, it, expect } from 'vitest'
import {
  routeDmEvent, isSessionExpired, safeErrorSummary,
  ADMIN_CHAT_START_PHRASE, ADMIN_CHAT_END_PHRASE,
  ADMIN_CHAT_START_NOTICE, ADMIN_CHAT_END_NOTICE,
} from '../../supabase/functions/_shared/line-admin-chat-logic.ts'
import { RESERVED_PHRASES } from './lineCommandSettings.js'

describe('routeDmEvent in secure_bot mode', () => {
  it('opens a chat only on the exact start phrase (trim allowed)', () => {
    expect(routeDmEvent({ mode: 'secure_bot', msgType: 'text', text: 'คุยกับแอดมิน' })).toBe('start_chat')
    expect(routeDmEvent({ mode: 'secure_bot', msgType: 'text', text: '  คุยกับแอดมิน \n' })).toBe('start_chat')
  })
  it('does NOT open a chat when the phrase is merely inside a longer sentence', () => {
    expect(routeDmEvent({ mode: 'secure_bot', msgType: 'text', text: 'ผมอยากคุยกับแอดมินหน่อย' })).toBe('normal_flow')
  })
  it('sends everything else down the normal flow', () => {
    expect(routeDmEvent({ mode: 'secure_bot', msgType: 'text', text: 'งานวันนี้' })).toBe('normal_flow')
    expect(routeDmEvent({ mode: 'secure_bot', msgType: 'image' })).toBe('normal_flow')
  })
  it('never routes to a record_* action (nothing is stored in secure_bot)', () => {
    const inputs = [
      { msgType: 'text', text: 'hello' }, { msgType: 'text', text: '' },
      { msgType: 'text', text: 'จบการสนทนา' }, { msgType: 'image' },
    ]
    for (const i of inputs) {
      expect(['record_text', 'record_image']).not.toContain(routeDmEvent({ mode: 'secure_bot', ...i }))
    }
  })
})

describe('routeDmEvent in chat_with_admin mode', () => {
  it('records text and images', () => {
    expect(routeDmEvent({ mode: 'chat_with_admin', msgType: 'text', text: 'สวัสดี' })).toBe('record_text')
    expect(routeDmEvent({ mode: 'chat_with_admin', msgType: 'image' })).toBe('record_image')
  })
  it('ends only on the exact end phrase', () => {
    expect(routeDmEvent({ mode: 'chat_with_admin', msgType: 'text', text: 'จบการสนทนา' })).toBe('end_chat')
    expect(routeDmEvent({ mode: 'chat_with_admin', msgType: 'text', text: 'ขอจบการสนทนาครับ' })).toBe('record_text')
  })
  it('records the start phrase if sent again while already chatting', () => {
    expect(routeDmEvent({ mode: 'chat_with_admin', msgType: 'text', text: 'คุยกับแอดมิน' })).toBe('record_text')
  })
})

describe('isSessionExpired', () => {
  const HOUR = 3600 * 1000
  it('is false at exactly the limit and true just past it', () => {
    expect(isSessionExpired(0, 24, 24 * HOUR)).toBe(false)
    expect(isSessionExpired(0, 24, 24 * HOUR + 1)).toBe(true)
  })
})

describe('safeErrorSummary', () => {
  it('keeps code and message but drops details/hint (which can echo row values)', () => {
    const err = { code: '23505', message: 'duplicate key value violates unique constraint "x"', details: 'Key (body)=(secret text) already exists.', hint: 'secret' }
    const out = safeErrorSummary(err)
    expect(out).toEqual({ code: '23505', message: 'duplicate key value violates unique constraint "x"' })
    expect(JSON.stringify(out)).not.toContain('secret')
  })
  it('tolerates non-error input', () => {
    expect(safeErrorSummary(null)).toEqual({ code: null, message: 'unknown error' })
  })
})

describe('copy and reserved phrases', () => {
  it('uses the agreed notices and never claims encryption', () => {
    expect(ADMIN_CHAT_START_NOTICE).toBe('กำลังเชื่อมต่อกับเจ้าหน้าที่ ข้อมูลต่อจากนี้จะได้รับการบันทึกเพื่อให้แอดมินช่วยเหลือท่าน')
    expect(ADMIN_CHAT_END_NOTICE).toBe('จบบทสนทนากับแอดมินแล้ว ข้อมูลต่อไปของคุณจะไม่ถูกบันทึกและแอดมินจะไม่เห็น')
    expect(ADMIN_CHAT_END_NOTICE).not.toContain('เข้ารหัส')
  })
  it('reserves both phrases so a tenant custom command phrase cannot collide', () => {
    expect(RESERVED_PHRASES).toContain(ADMIN_CHAT_START_PHRASE)
    expect(RESERVED_PHRASES).toContain(ADMIN_CHAT_END_PHRASE)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/lineAdminChatLogic.test.js`
Expected: FAIL — cannot resolve `line-admin-chat-logic.ts`.

- [ ] **Step 3: Write the logic module**

Create `supabase/functions/_shared/line-admin-chat-logic.ts`:

```ts
// supabase/functions/_shared/line-admin-chat-logic.ts
// Pure decision logic for LINE "hybrid privacy mode" (see
// docs/superpowers/specs/2026-10-02-line-hybrid-privacy-design.md).
// No Deno or DB imports on purpose: vitest imports this file directly
// (src/lib/lineAdminChatLogic.test.js), so the logic is written once and
// tested, instead of ported line-for-line like the older LINE modules.

export type ChatMode = 'secure_bot' | 'chat_with_admin'
export type DmRoute = 'start_chat' | 'end_chat' | 'record_text' | 'record_image' | 'normal_flow'

// The Rich Menu button sends this exact text (all existing buttons work
// that way). Exact-match only, never substring: an ordinary sentence
// must never be able to opt a user into being recorded.
export const ADMIN_CHAT_START_PHRASE = 'คุยกับแอดมิน'
export const ADMIN_CHAT_END_PHRASE = 'จบการสนทนา'

export const ADMIN_CHAT_START_NOTICE = 'กำลังเชื่อมต่อกับเจ้าหน้าที่ ข้อมูลต่อจากนี้จะได้รับการบันทึกเพื่อให้แอดมินช่วยเหลือท่าน'
// Deliberately NOT "เข้ารหัส": the system does not encrypt, and telling
// users it does would itself be a PDPA problem.
export const ADMIN_CHAT_END_NOTICE = 'จบบทสนทนากับแอดมินแล้ว ข้อมูลต่อไปของคุณจะไม่ถูกบันทึกและแอดมินจะไม่เห็น'

export function routeDmEvent(input: { mode: ChatMode; msgType: 'text' | 'image'; text?: string }): DmRoute {
  const trimmed = input.msgType === 'text' ? (input.text ?? '').trim() : ''
  if (input.mode === 'chat_with_admin') {
    if (input.msgType === 'image') return 'record_image'
    return trimmed === ADMIN_CHAT_END_PHRASE ? 'end_chat' : 'record_text'
  }
  return input.msgType === 'text' && trimmed === ADMIN_CHAT_START_PHRASE ? 'start_chat' : 'normal_flow'
}

export function isSessionExpired(lastActivityMs: number, idleHours: number, nowMs: number): boolean {
  return nowMs - lastActivityMs > idleHours * 3600 * 1000
}

// PostgREST errors carry `details`/`hint`, which can echo row values
// (e.g. a duplicate-key message includes the offending value). Log only
// the code and message so message content can never reach function logs.
export function safeErrorSummary(err: unknown): { code: string | null; message: string } {
  const e = (err ?? {}) as { code?: unknown; message?: unknown }
  return {
    code: typeof e.code === 'string' ? e.code : null,
    message: typeof e.message === 'string' ? e.message : 'unknown error',
  }
}

export function logSafeError(label: string, err: unknown): void {
  console.error(label, safeErrorSummary(err))
}
```

- [ ] **Step 4: Reserve the phrases**

In `src/lib/lineCommandSettings.js`, change the `RESERVED_PHRASES` block to:

```js
export const RESERVED_PHRASES = [
  ...Object.values(FIXED_COMMAND_PHRASES).flat(),
  'ไม่มีปัญหา', 'ไม่ปัญหา', 'เสร็จแล้ว',
  // Hybrid privacy mode triggers -- must equal ADMIN_CHAT_START_PHRASE /
  // ADMIN_CHAT_END_PHRASE in supabase/functions/_shared/line-admin-chat-logic.ts
  // (lineAdminChatLogic.test.js asserts they stay in sync).
  'คุยกับแอดมิน', 'จบการสนทนา',
]
```

- [ ] **Step 5: Run the tests**

Run: `npm test`
Expected: all pass (previous 301 + the new ones).

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/_shared/line-admin-chat-logic.ts src/lib/lineAdminChatLogic.test.js src/lib/lineCommandSettings.js
git commit -m "feat: pure routing logic for LINE hybrid privacy mode"
```

---

### Task 2: Migration (tables, RLS, private bucket) — validate only, do not apply

**Files:**
- Create: `supabase/migrations/2026-10-02-04-line-admin-chat.sql`

**Interfaces:**
- Produces: tables `line_chat_sessions(line_user_id PK, tenant_id, mode, started_at, last_activity_at)`, `line_admin_messages(id, line_user_id, direction, body, storage_path, line_event_id UNIQUE, created_at)`, `line_admin_chat_config(id, idle_hours)`; private bucket `line-admin-chat`.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/2026-10-02-04-line-admin-chat.sql
-- LINE hybrid privacy mode (docs/superpowers/specs/2026-10-02-line-hybrid-privacy-design.md).
-- Additive only: three new tables + one private bucket, no change to
-- existing tables. Readable/writable by platform_admins only; the
-- webhook and cron use the service role, which bypasses RLS.

CREATE TABLE line_chat_sessions (
  line_user_id     text PRIMARY KEY,
  tenant_id        uuid,  -- informational, resolved from the worker/user link; no content
  mode             text NOT NULL DEFAULT 'secure_bot' CHECK (mode IN ('secure_bot', 'chat_with_admin')),
  started_at       timestamptz NOT NULL DEFAULT now(),
  last_activity_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE line_admin_messages (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  line_user_id   text NOT NULL REFERENCES line_chat_sessions(line_user_id) ON DELETE CASCADE,
  direction      text NOT NULL CHECK (direction IN ('user', 'admin')),
  body           text,
  storage_path   text,
  line_event_id  text UNIQUE,  -- LINE message id; a redelivered event cannot insert twice
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (body IS NOT NULL OR storage_path IS NOT NULL)
);
CREATE INDEX line_admin_messages_user_created_idx ON line_admin_messages (line_user_id, created_at);

CREATE TABLE line_admin_chat_config (
  id         boolean PRIMARY KEY DEFAULT true CHECK (id),  -- single-row table
  idle_hours integer NOT NULL DEFAULT 24 CHECK (idle_hours BETWEEN 1 AND 720)
);
INSERT INTO line_admin_chat_config (id) VALUES (true);

ALTER TABLE line_chat_sessions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE line_admin_messages   ENABLE ROW LEVEL SECURITY;
ALTER TABLE line_admin_chat_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY platform_admin_all ON line_chat_sessions FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM platform_admins WHERE user_email = auth.email()))
  WITH CHECK (EXISTS (SELECT 1 FROM platform_admins WHERE user_email = auth.email()));
CREATE POLICY platform_admin_all ON line_admin_messages FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM platform_admins WHERE user_email = auth.email()))
  WITH CHECK (EXISTS (SELECT 1 FROM platform_admins WHERE user_email = auth.email()));
CREATE POLICY platform_admin_all ON line_admin_chat_config FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM platform_admins WHERE user_email = auth.email()))
  WITH CHECK (EXISTS (SELECT 1 FROM platform_admins WHERE user_email = auth.email()));
-- No policy for anon or for tenant users: RLS denies them by default.

INSERT INTO storage.buckets (id, name, public) VALUES ('line-admin-chat', 'line-admin-chat', false)
  ON CONFLICT (id) DO NOTHING;
CREATE POLICY line_admin_chat_platform_admin_all ON storage.objects FOR ALL TO authenticated
  USING (bucket_id = 'line-admin-chat' AND EXISTS (SELECT 1 FROM platform_admins WHERE user_email = auth.email()))
  WITH CHECK (bucket_id = 'line-admin-chat' AND EXISTS (SELECT 1 FROM platform_admins WHERE user_email = auth.email()));
```

- [ ] **Step 2: Validate the SQL without persisting anything**

Using `mcp__plugin_supabase_supabase__execute_sql` against the live project, run the file's full contents wrapped like this (one call, so the transaction never commits):

```sql
BEGIN;
-- paste the whole migration here
-- RLS check as a non-platform-admin authenticated user:
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"email":"someone-else@example.com","role":"authenticated"}';
SELECT count(*) AS sessions_visible FROM line_chat_sessions;   -- expect 0 rows visible / no error
INSERT INTO line_chat_sessions (line_user_id) VALUES ('U-test'); -- expect: new row violates row-level security policy
ROLLBACK;
```

Expected: the `SELECT` returns 0 and the `INSERT` errors with "row-level security". If the migration itself errors (e.g. a name collision), fix the file and repeat. Confirm afterwards with `list_tables` that none of the three tables exist (nothing persisted).

- [ ] **Step 3: Commit (do not apply)**

```bash
git add supabase/migrations/2026-10-02-04-line-admin-chat.sql
git commit -m "feat: migration for LINE admin chat tables, RLS and private bucket (not applied)"
```

---

### Task 3: DB helper module

**Files:**
- Create: `supabase/functions/_shared/line-admin-chat.ts`

**Interfaces:**
- Consumes: Task 1's `ChatMode`, `ADMIN_CHAT_END_NOTICE`, `logSafeError`; `sendLinePush` from `./line.ts`.
- Produces (all take the service-role client `admin: SupabaseClient` first):
  - `getChatMode(admin, lineUserId): Promise<ChatMode>` — fails closed to `'secure_bot'`
  - `startChatSession(admin, lineUserId, tenantId: string | null): Promise<void>`
  - `endChatSession(admin, lineUserId): Promise<boolean>` — true only if a session was actually open and is now ended
  - `endChatAndPush(admin, accessToken, lineUserId): Promise<boolean>` — ends, then pushes the end notice only if it really ended
  - `recordUserText(admin, lineUserId, messageId, text): Promise<void>`
  - `recordUserImage(admin, lineUserId, messageId, content: Uint8Array | ArrayBuffer): Promise<void>`
  - `recordAdminText(admin, lineUserId, text): Promise<void>`

- [ ] **Step 1: Write the module**

```ts
// supabase/functions/_shared/line-admin-chat.ts
// DB access for LINE hybrid privacy mode. Every function takes the
// service-role client so callers (line-webhook, the send/expire
// functions) share one implementation. Decision logic lives in
// ./line-admin-chat-logic.ts (pure, unit-tested).
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { sendLinePush } from './line.ts'
import { ADMIN_CHAT_END_NOTICE, logSafeError, type ChatMode } from './line-admin-chat-logic.ts'

const DUPLICATE_KEY = '23505'

export async function getChatMode(admin: SupabaseClient, lineUserId: string): Promise<ChatMode> {
  const { data, error } = await admin.from('line_chat_sessions').select('mode').eq('line_user_id', lineUserId).maybeSingle()
  if (error) {
    // Fail closed: if we cannot tell, nothing gets recorded.
    logSafeError('line_chat_sessions mode lookup failed', error)
    return 'secure_bot'
  }
  return data?.mode === 'chat_with_admin' ? 'chat_with_admin' : 'secure_bot'
}

export async function startChatSession(admin: SupabaseClient, lineUserId: string, tenantId: string | null): Promise<void> {
  const nowIso = new Date().toISOString()
  const { error } = await admin.from('line_chat_sessions').upsert(
    { line_user_id: lineUserId, tenant_id: tenantId, mode: 'chat_with_admin', started_at: nowIso, last_activity_at: nowIso },
    { onConflict: 'line_user_id' },
  )
  if (error) logSafeError('line_chat_sessions start upsert failed', error)
}

export async function endChatSession(admin: SupabaseClient, lineUserId: string): Promise<boolean> {
  const { data, error } = await admin.from('line_chat_sessions')
    .update({ mode: 'secure_bot' })
    .eq('line_user_id', lineUserId)
    .eq('mode', 'chat_with_admin')
    .select('line_user_id')
  if (error) {
    logSafeError('line_chat_sessions end update failed', error)
    return false
  }
  return (data?.length ?? 0) > 0
}

export async function endChatAndPush(admin: SupabaseClient, accessToken: string, lineUserId: string): Promise<boolean> {
  const ended = await endChatSession(admin, lineUserId)
  if (ended) await sendLinePush(accessToken, lineUserId, ADMIN_CHAT_END_NOTICE)
  return ended
}

async function touchSession(admin: SupabaseClient, lineUserId: string): Promise<void> {
  const { error } = await admin.from('line_chat_sessions').update({ last_activity_at: new Date().toISOString() }).eq('line_user_id', lineUserId)
  if (error) logSafeError('line_chat_sessions touch failed', error)
}

export async function recordUserText(admin: SupabaseClient, lineUserId: string, messageId: string, text: string): Promise<void> {
  const { error } = await admin.from('line_admin_messages').insert({ line_user_id: lineUserId, direction: 'user', body: text, line_event_id: messageId })
  if (error && error.code !== DUPLICATE_KEY) { logSafeError('line_admin_messages text insert failed', error); return }
  await touchSession(admin, lineUserId)
}

export async function recordUserImage(admin: SupabaseClient, lineUserId: string, messageId: string, content: Uint8Array | ArrayBuffer): Promise<void> {
  const path = `${lineUserId}/${messageId}.jpg`
  const { error: uploadError } = await admin.storage.from('line-admin-chat').upload(path, content, { contentType: 'image/jpeg', upsert: true })
  if (uploadError) { logSafeError('line-admin-chat upload failed', uploadError); return }
  const { error } = await admin.from('line_admin_messages').insert({ line_user_id: lineUserId, direction: 'user', storage_path: path, line_event_id: messageId })
  if (error && error.code !== DUPLICATE_KEY) { logSafeError('line_admin_messages image insert failed', error); return }
  await touchSession(admin, lineUserId)
}

export async function recordAdminText(admin: SupabaseClient, lineUserId: string, text: string): Promise<void> {
  const { error } = await admin.from('line_admin_messages').insert({ line_user_id: lineUserId, direction: 'admin', body: text })
  if (error) { logSafeError('line_admin_messages admin insert failed', error); return }
  await touchSession(admin, lineUserId)
}
```

- [ ] **Step 2: Type-check what we can**

Run: `npx tsc --noEmit --allowImportingTsExtensions --target es2022 --moduleResolution bundler --skipLibCheck supabase/functions/_shared/line-admin-chat-logic.ts`
Expected: no errors for the pure module. (The Deno-only imports in `line-admin-chat.ts` cannot be checked with plain `tsc`; they get exercised in Task 8's live verification and by `supabase functions serve` if the CLI is available.)

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/_shared/line-admin-chat.ts
git commit -m "feat: DB helpers for LINE admin chat sessions and messages"
```

---

### Task 4: Wire routing into `line-webhook` and sweep error logging

**Files:**
- Modify: `supabase/functions/line-webhook/index.ts` (imports at ~105-107; insert before the `if (!sourceGroupId) {` DM branch that follows `const settings = {...}`; every `console.error('…', err)` call)

**Interfaces:**
- Consumes: Task 1 (`routeDmEvent`, notices, `logSafeError`), Task 3 (`getChatMode`, `startChatSession`, `endChatSession`, `recordUserText`, `recordUserImage`). Uses the webhook's existing `fetchLineImageContent(accessToken, messageId)` and `sendLineReply`.

- [ ] **Step 1: Add the imports**

After the existing `tenantHasModuleAccess` import:

```ts
import { routeDmEvent, logSafeError, ADMIN_CHAT_START_NOTICE, ADMIN_CHAT_END_NOTICE } from '../_shared/line-admin-chat-logic.ts'
import { getChatMode, startChatSession, endChatSession, recordUserText, recordUserImage } from '../_shared/line-admin-chat.ts'
```

- [ ] **Step 2: Insert the routing block**

Directly after the line `const settings = { tenant_id: tenantId, channel_access_token: LINE_CHANNEL_ACCESS_TOKEN }` and **before** `if (!sourceGroupId) {` (the DM branch), add:

```ts
    // Hybrid privacy mode (docs/superpowers/specs/2026-10-02-line-hybrid-privacy-design.md).
    // DM-only. In the default secure_bot mode this changes nothing and
    // stores nothing; chat_with_admin is entered only by the user's own
    // exact trigger phrase, and only then are messages/photos recorded.
    if (!sourceGroupId) {
      const route = routeDmEvent({ mode: await getChatMode(admin, lineUserId), msgType, text })
      if (route === 'start_chat') {
        await startChatSession(admin, lineUserId, tenantId)
        await sendLineReply(settings.channel_access_token, event.replyToken, ADMIN_CHAT_START_NOTICE)
        continue
      }
      if (route === 'end_chat') {
        await endChatSession(admin, lineUserId)
        await sendLineReply(settings.channel_access_token, event.replyToken, ADMIN_CHAT_END_NOTICE)
        continue
      }
      if (route === 'record_text') {
        await recordUserText(admin, lineUserId, messageId, text!)
        continue
      }
      if (route === 'record_image') {
        const content = await fetchLineImageContent(settings.channel_access_token, messageId)
        if (content) await recordUserImage(admin, lineUserId, messageId, content)
        continue
      }
      // 'normal_flow' falls through to the existing DM handling below, unchanged.
    }
```

- [ ] **Step 3: Sweep `console.error` calls so no row values can reach logs**

Run:

```bash
sed -i '' -E "s/console\.error\(('[^']*'), ([A-Za-z]+)\)/logSafeError(\1, \2)/" supabase/functions/line-webhook/index.ts
grep -n "console\.\(error\|log\|warn\)" supabase/functions/line-webhook/index.ts
```

Expected: the grep prints nothing, or only calls you inspect and convert by hand (any call that passes more than a label and an error object). Convert each remaining one to `logSafeError('<label>', <errorVar>)`. There must be **no** `console.log` of any message text, display name or payload.

- [ ] **Step 4: Sanity-check the file parses**

Run: `deno check supabase/functions/line-webhook/index.ts` if `deno` is installed; otherwise run `npx esbuild supabase/functions/line-webhook/index.ts --format=esm --log-level=error > /dev/null` (syntax check only; `esbuild` ships with vite).
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/line-webhook/index.ts
git commit -m "feat: route LINE DMs by privacy mode and stop logging row values"
```

---

### Task 5: Owner reply/end/delete edge function

**Files:**
- Create: `supabase/functions/line-admin-chat-send/index.ts`

**Interfaces:**
- Consumes: Task 3 helpers, `sendLinePush`, `LINE_CHANNEL_ACCESS_TOKEN`.
- Produces: HTTP `POST` body `{ action: 'reply'|'end'|'delete', lineUserId: string, text?: string }` → `{ ok: true }` or `{ error }` with 400/401/403/409. Called from the browser by Task 7 via `supabase.functions.invoke('line-admin-chat-send', { body })`.

- [ ] **Step 1: Write the function**

```ts
// supabase/functions/line-admin-chat-send/index.ts
// Platform-owner actions on a LINE admin-chat session: reply, end, delete.
// verify_jwt is ON (gateway check), but that only proves "some valid
// project JWT" -- the anon key is one. The REAL access control is the
// platform_admins membership check below, run before anything else.
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { sendLinePush, LINE_CHANNEL_ACCESS_TOKEN } from '../_shared/line.ts'
import { endChatAndPush, getChatMode, recordAdminText } from '../_shared/line-admin-chat.ts'
import { logSafeError } from '../_shared/line-admin-chat-logic.ts'

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const token = (req.headers.get('authorization') ?? '').replace('Bearer ', '')
  const { data: { user }, error: userError } = await admin.auth.getUser(token)
  if (userError || !user?.email) return json({ error: 'Unauthorized' }, 401)
  const { data: pa } = await admin.from('platform_admins').select('user_email').eq('user_email', user.email).maybeSingle()
  if (!pa) return json({ error: 'Forbidden' }, 403)

  let body: { action?: string; lineUserId?: string; text?: string }
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400) }
  const { action, lineUserId, text } = body
  if (!lineUserId) return json({ error: 'lineUserId required' }, 400)

  if (action === 'reply') {
    const trimmed = (text ?? '').trim()
    if (!trimmed) return json({ error: 'text required' }, 400)
    if ((await getChatMode(admin, lineUserId)) !== 'chat_with_admin') return json({ error: 'Session is not open' }, 409)
    const push = await sendLinePush(LINE_CHANNEL_ACCESS_TOKEN, lineUserId, trimmed)
    if (!push.ok) return json({ error: `LINE push failed (${push.status})` }, 502)
    await recordAdminText(admin, lineUserId, trimmed)
    return json({ ok: true })
  }

  if (action === 'end') {
    await endChatAndPush(admin, LINE_CHANNEL_ACCESS_TOKEN, lineUserId)
    return json({ ok: true })
  }

  if (action === 'delete') {
    // Remove stored photos first, then the messages (the session row stays; it holds no content).
    const { data: files } = await admin.storage.from('line-admin-chat').list(lineUserId)
    if (files?.length) {
      const { error } = await admin.storage.from('line-admin-chat').remove(files.map((f) => `${lineUserId}/${f.name}`))
      if (error) { logSafeError('line-admin-chat remove failed', error); return json({ error: 'Could not delete photos' }, 500) }
    }
    const { error } = await admin.from('line_admin_messages').delete().eq('line_user_id', lineUserId)
    if (error) { logSafeError('line_admin_messages delete failed', error); return json({ error: 'Could not delete messages' }, 500) }
    return json({ ok: true })
  }

  return json({ error: 'Unknown action' }, 400)
})
```

- [ ] **Step 2: Syntax check**

Run: `npx esbuild supabase/functions/line-admin-chat-send/index.ts --format=esm --log-level=error > /dev/null`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/line-admin-chat-send/index.ts
git commit -m "feat: platform-owner reply/end/delete edge function for LINE admin chat"
```

---

### Task 6: Idle-expiry function and cron (do not deploy/apply yet)

**Files:**
- Create: `supabase/functions/line-admin-chat-expire/index.ts`
- Create: `supabase/migrations/2026-10-02-05-line-admin-chat-expire-cron.sql`

**Interfaces:**
- Consumes: Task 1 `isSessionExpired`; Task 3 `endChatAndPush`; DB RPC `verify_cron_secret(provided)` (exists, see `2026-09-19-04-line-push-cron-secret-verify-fn.sql`); Vault secrets `line_push_cron_auth_key` and `line_push_cron_shared_secret` (exist).

- [ ] **Step 1: Write the function**

```ts
// supabase/functions/line-admin-chat-expire/index.ts
// Scheduled (see 2026-10-02-05-line-admin-chat-expire-cron.sql). Ends any
// chat_with_admin session idle longer than line_admin_chat_config.idle_hours
// so a forgotten session cannot keep recording indefinitely, and tells
// the user their data is no longer being recorded. Auth: x-cron-secret
// via public.verify_cron_secret(), same as the line-push-* functions.
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { LINE_CHANNEL_ACCESS_TOKEN } from '../_shared/line.ts'
import { endChatAndPush } from '../_shared/line-admin-chat.ts'
import { isSessionExpired, logSafeError } from '../_shared/line-admin-chat-logic.ts'

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

Deno.serve(async (req) => {
  const provided = req.headers.get('x-cron-secret')
  if (!provided) return json({ error: 'Unauthorized' }, 401)
  const { data: ok, error: rpcError } = await admin.rpc('verify_cron_secret', { provided })
  if (rpcError) { logSafeError('verify_cron_secret RPC failed', rpcError); return json({ error: 'Unauthorized' }, 401) }
  if (ok !== true) return json({ error: 'Unauthorized' }, 401)

  const { data: config } = await admin.from('line_admin_chat_config').select('idle_hours').eq('id', true).maybeSingle()
  const idleHours = config?.idle_hours ?? 24

  const { data: open, error } = await admin.from('line_chat_sessions').select('line_user_id, last_activity_at').eq('mode', 'chat_with_admin')
  if (error) { logSafeError('open sessions query failed', error); return json({ error: 'query failed' }, 500) }

  const now = Date.now()
  let ended = 0
  for (const s of open ?? []) {
    if (!isSessionExpired(new Date(s.last_activity_at).getTime(), idleHours, now)) continue
    if (await endChatAndPush(admin, LINE_CHANNEL_ACCESS_TOKEN, s.line_user_id)) ended++
  }
  return json({ ok: true, ended })
})
```

- [ ] **Step 2: Write the cron migration**

First get the live project URL with `mcp__plugin_supabase_supabase__get_project_url` (it differs before vs. after the region cutover; use whichever project is live when this is applied).

```sql
-- supabase/migrations/2026-10-02-05-line-admin-chat-expire-cron.sql
-- Runs the idle-expiry function every 15 minutes. Same auth shape as
-- 2026-09-19-02-line-push-cron.sql. REPLACE <PROJECT_URL> with the live
-- project's URL (get_project_url) at apply time -- it is project-specific.
select cron.schedule(
  'line-admin-chat-expire', '*/15 * * * *',
  $$
  select net.http_post(
    url := '<PROJECT_URL>/functions/v1/line-admin-chat-expire',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'line_push_cron_auth_key'),
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'line_push_cron_shared_secret'),
      'Content-Type', 'application/json'
    )
  )
  $$
);
```

- [ ] **Step 3: Syntax check and commit**

Run: `npx esbuild supabase/functions/line-admin-chat-expire/index.ts --format=esm --log-level=error > /dev/null`
Expected: no output.

```bash
git add supabase/functions/line-admin-chat-expire supabase/migrations/2026-10-02-05-line-admin-chat-expire-cron.sql
git commit -m "feat: idle-expiry function and cron for LINE admin chat (not applied)"
```

---

### Task 7: Platform-owner page

**Files:**
- Modify: `src/hooks/useSupabase.js` (append at end of file)
- Create: `src/pages/LineAdminChat.jsx`
- Modify: `src/App.jsx` (lazy import near line 48; tab entry after line 91; render case after line 363)

**Interfaces:**
- Consumes: tables from Task 2 via RLS; edge function from Task 5.
- Produces: tab id `line_admin_chat`, visible only when `usePlatformAdmin()` is true.

- [ ] **Step 1: Add the hooks**

Append to `src/hooks/useSupabase.js` (it already imports `supabase` and defines `useQuery`):

```js
// ---- LINE admin chat (platform owner only; RLS enforces it) ----
export function useAdminChatSessions() {
  return useQuery(async () => {
    const { data, error } = await supabase.from('line_chat_sessions').select('*').order('last_activity_at', { ascending: false })
    if (error) throw error
    return data
  }, [])
}

export function useAdminChatMessages(lineUserId) {
  return useQuery(async () => {
    if (!lineUserId) return []
    const { data, error } = await supabase.from('line_admin_messages').select('*').eq('line_user_id', lineUserId).order('created_at', { ascending: true })
    if (error) throw error
    return data
  }, [lineUserId])
}

export function useAdminChatConfig() {
  return useQuery(async () => {
    const { data, error } = await supabase.from('line_admin_chat_config').select('idle_hours').eq('id', true).maybeSingle()
    if (error) throw error
    return data
  }, [])
}
```

- [ ] **Step 2: Write the page**

Create `src/pages/LineAdminChat.jsx`:

```jsx
// ============================================================
// LineAdminChat — platform-owner-only inbox for LINE "คุยกับแอดมิน"
// sessions. Messages exist ONLY for users who opened a chat themselves
// (see docs/superpowers/specs/2026-10-02-line-hybrid-privacy-design.md).
// Access is enforced by RLS (platform_admins), not just by hiding the tab.
// ============================================================
import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { useAdminChatSessions, useAdminChatMessages, useAdminChatConfig } from '../hooks/useSupabase.js'

const POLL_MS = 10_000

async function callSend(body) {
  const { data, error } = await supabase.functions.invoke('line-admin-chat-send', { body })
  if (error) throw new Error(error.message)
  if (data?.error) throw new Error(data.error)
}

function PhotoMessage({ path }) {
  const [url, setUrl] = useState(null)
  useEffect(() => {
    let alive = true
    supabase.storage.from('line-admin-chat').createSignedUrl(path, 300).then(({ data }) => { if (alive) setUrl(data?.signedUrl ?? null) })
    return () => { alive = false }
  }, [path])
  return url ? <img src={url} alt="" style={{ maxWidth: 240, borderRadius: 8 }} /> : <span>กำลังโหลดรูป…</span>
}

export default function LineAdminChat() {
  const { data: sessions, refetch: refetchSessions } = useAdminChatSessions()
  const { data: config, refetch: refetchConfig } = useAdminChatConfig()
  const [selected, setSelected] = useState(null)
  const { data: messages, refetch: refetchMessages } = useAdminChatMessages(selected)
  const [reply, setReply] = useState('')
  const [busy, setBusy] = useState(false)
  const [idleHours, setIdleHours] = useState('')

  useEffect(() => { if (config?.idle_hours != null) setIdleHours(String(config.idle_hours)) }, [config])

  useEffect(() => {
    const t = setInterval(() => { refetchSessions(); refetchMessages() }, POLL_MS)
    return () => clearInterval(t)
  }, [refetchSessions, refetchMessages])

  const current = (sessions ?? []).find((s) => s.line_user_id === selected)
  const isOpen = current?.mode === 'chat_with_admin'

  const run = async (fn) => {
    setBusy(true)
    try { await fn() } catch (e) { alert(e.message) } finally { setBusy(false) }
    refetchSessions(); refetchMessages()
  }

  const sendReply = () => run(async () => {
    await callSend({ action: 'reply', lineUserId: selected, text: reply })
    setReply('')
  })
  const endChat = () => run(() => callSend({ action: 'end', lineUserId: selected }))
  const deleteChat = () => {
    if (!window.confirm('ลบข้อความและรูปทั้งหมดของบทสนทนานี้อย่างถาวร?')) return
    return run(() => callSend({ action: 'delete', lineUserId: selected }))
  }
  const saveIdle = () => run(async () => {
    const n = parseInt(idleHours, 10)
    if (!(n >= 1 && n <= 720)) throw new Error('ใส่ตัวเลข 1-720 ชั่วโมง')
    const { error } = await supabase.from('line_admin_chat_config').update({ idle_hours: n }).eq('id', true)
    if (error) throw error
    refetchConfig()
  })

  return (
    <div style={{ padding: 16, display: 'grid', gridTemplateColumns: 'minmax(220px, 280px) 1fr', gap: 16 }}>
      <div>
        <h3 style={{ marginTop: 0 }}>💬 แชทแอดมิน</h3>
        <div style={{ marginBottom: 12, fontSize: 13 }}>
          หมดอายุหลังไม่มีกิจกรรม (ชม.){' '}
          <input value={idleHours} onChange={(e) => setIdleHours(e.target.value)} style={{ width: 56 }} />{' '}
          <button disabled={busy} onClick={saveIdle}>บันทึก</button>
        </div>
        {(sessions ?? []).length === 0 && <div style={{ opacity: 0.6 }}>ยังไม่มีบทสนทนา</div>}
        {(sessions ?? []).map((s) => (
          <div key={s.line_user_id} onClick={() => setSelected(s.line_user_id)}
            style={{ padding: 8, cursor: 'pointer', borderRadius: 6, background: s.line_user_id === selected ? 'rgba(127,127,127,0.2)' : 'transparent' }}>
            {s.mode === 'chat_with_admin' ? '🟢' : '⚪'} …{s.line_user_id.slice(-6)}
            <div style={{ fontSize: 12, opacity: 0.7 }}>{new Date(s.last_activity_at).toLocaleString('th-TH')}</div>
          </div>
        ))}
      </div>

      <div>
        {!selected && <div style={{ opacity: 0.6 }}>เลือกบทสนทนาทางซ้าย</div>}
        {selected && (
          <>
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              {isOpen && <button disabled={busy} onClick={endChat}>จบการสนทนา</button>}
              <button disabled={busy} onClick={deleteChat}>🗑 ลบบทสนทนา</button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: '55vh', overflowY: 'auto' }}>
              {(messages ?? []).map((m) => (
                <div key={m.id} style={{ alignSelf: m.direction === 'admin' ? 'flex-end' : 'flex-start', maxWidth: '75%', padding: 8, borderRadius: 8,
                  background: m.direction === 'admin' ? 'rgba(59,130,246,0.25)' : 'rgba(127,127,127,0.2)' }}>
                  {m.body && <div style={{ whiteSpace: 'pre-wrap' }}>{m.body}</div>}
                  {m.storage_path && <PhotoMessage path={m.storage_path} />}
                  <div style={{ fontSize: 11, opacity: 0.6 }}>{new Date(m.created_at).toLocaleString('th-TH')}</div>
                </div>
              ))}
            </div>
            {isOpen ? (
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <input value={reply} onChange={(e) => setReply(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && reply.trim() && sendReply()}
                  placeholder="พิมพ์ข้อความตอบกลับ" style={{ flex: 1 }} />
                <button disabled={busy || !reply.trim()} onClick={sendReply}>ส่ง</button>
              </div>
            ) : <div style={{ marginTop: 12, opacity: 0.6 }}>บทสนทนานี้จบแล้ว — ผู้ใช้ต้องกด "คุยกับแอดมิน" ใหม่จึงจะตอบได้</div>}
          </>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Register the tab in `src/App.jsx`**

Mirror how `tenant_management` is wired:

1. Next to `const TenantManagement = lazy(() => import('./pages/TenantManagement.jsx'))` add:
   `const LineAdminChat = lazy(() => import('./pages/LineAdminChat.jsx'))`
2. In `TABS`, right after the `tenant_management` entry, add:
   `{ id: 'line_admin_chat', label: '💬 แชทแอดมิน', minRole: 'WORKER', module: null, platformAdminOnly: true },`
3. In the render `switch`, after `case 'tenant_management': ...` add:
   `case 'line_admin_chat': return <LineAdminChat {...props} />`

- [ ] **Step 4: Build and run all tests**

Run: `npm test && npx vite build 2>&1 | tail -3 && npx playwright test 2>&1 | grep -E "passed|failed"`
Expected: vitest all pass, build succeeds, Playwright 4 passed.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useSupabase.js src/pages/LineAdminChat.jsx src/App.jsx
git commit -m "feat: platform-owner LINE admin chat page"
```

---

### Task 8: Version, changelog, and the go-live checklist

**Files:**
- Modify: `package.json` (version), `src/changelog.json`

The go-live checklist in Step 3 is run by a human after the region cutover; it is not a file.

- [ ] **Step 1: Bump the version and add a changelog entry**

Open `src/changelog.json`, copy the shape of the newest entry, and add a new entry above it with the next patch version and a Thai one-line summary ("เพิ่มโหมดความเป็นส่วนตัวของ LINE bot: ไม่บันทึกข้อความโดยปริยาย, แชทกับแอดมินเมื่อผู้ใช้กดเอง"). Set the same version in `package.json`.

- [ ] **Step 2: Run everything and commit**

Run: `npm test && npx vite build 2>&1 | tail -2`
Expected: pass.

```bash
git add package.json src/changelog.json
git commit -m "chore: bump version and changelog for LINE hybrid privacy mode"
```

- [ ] **Step 3 (human, after the region cutover): go-live checklist**

Do these in order. Stop and report on the first failure.

1. **LINE OA Manager (owner, no code):** set response mode to **Bot**, turn **Chat** off. Send the bot a DM from a personal account and confirm it does NOT appear in the OA Manager chat inbox.
2. **Apply** `2026-10-02-04-line-admin-chat.sql` with `apply_migration`; confirm `list_tables` shows the three tables with RLS on.
3. **Edit** `2026-10-02-05-line-admin-chat-expire-cron.sql`, replace `<PROJECT_URL>` using `get_project_url`, then apply it.
4. **Deploy** `line-webhook`, `line-admin-chat-send`, `line-admin-chat-expire` (same settings as the existing `line-push-*` functions; `verify_jwt` on for `-send` and `-expire`, off for `line-webhook` as today).
5. **Configure the Rich Menu** in LINE OA Manager: add a button whose action is "send text" `คุยกับแอดมิน`.
6. **Existing flows unchanged:** from a linked worker's DM send `งานวันนี้` — expect the normal reply; run
   `select count(*) from line_admin_messages;` — expect `0`.
7. **Secure by default:** send a normal sentence and a photo that are not part of a flow; re-run the count — still `0`.
8. **Opt in:** send `คุยกับแอดมิน` — expect the start notice verbatim. Send a text and a photo. Run
   `select direction, body is not null as has_text, storage_path is not null as has_photo from line_admin_messages;` — expect 2 rows. Open the new tab as a platform admin and confirm both show, the photo renders, and a tenant ADMIN account cannot see the tab and gets no rows when querying `line_admin_messages` directly.
9. **Reply and end:** reply from the page — the worker receives it. Press จบการสนทนา — the worker receives the end notice verbatim. Send another text — count of `line_admin_messages` does not grow.
10. **Idle expiry:** set idle hours to `1`; `update line_chat_sessions set last_activity_at = now() - interval '2 hours' where mode = 'chat_with_admin'` for a test session; wait for the next 15-minute run (or `invoke` the function once with the cron secret) — expect the end notice and `mode = 'secure_bot'`. Set idle hours back to `24`.
11. **Delete:** use 🗑 on the test conversation; confirm its messages and storage objects are gone.
12. **Logs:** in the edge function logs for `line-webhook`, confirm no message text or `details` fields appear.
13. Only now: ask about merging the branch (the whole arc is done).
