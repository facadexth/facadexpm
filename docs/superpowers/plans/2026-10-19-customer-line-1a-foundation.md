# Customer LINE service — Phase 1a (foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A tenant connects its own customer LINE OA (FacadeX: @facadex) and invites a client by QR or code. The linked customer then uses a 6-button rich menu: `สถานะงาน` and `ติดต่อเรา` work for real, and the other buttons give stand-in replies until the later phases ship.

**Architecture:**
- A new edge function, `customer-line-webhook`, serves every tenant's OA. It finds the tenant from `?t=<webhook_key>`, then checks the signature with that tenant's secret.
- The secret and token live in Supabase Vault. They are written by an owner-only SECURITY DEFINER RPC and read only by service-role RPCs.
- A customer account is one LINE user per client. It is created by atomically claiming a one-time invite code.
- All reply text and command matching lives in pure `_shared/*.ts` modules so vitest can test it.
- The crew bot (`line-webhook`, @changpm) is not touched.

**Tech Stack:** React 18 + Vite (src/), Supabase Postgres + Vault, Deno edge functions, vitest 4, `qrcode` npm package (new).

**Spec:** `docs/superpowers/specs/2026-10-19-customer-line-service-design.md`. Read the whole spec, and especially its last section, "Changed after the mockup review". Mockup: https://claude.ai/artifact/KUmuM4Env22zgk7ypm6c5u (boards 1–4 are this phase).

## Global Constraints
- Every UI string is in Thai. Build the UI to match mockup boards 1–4 (Warm Oak tokens from `src/index.css`, the existing `card` / `btn` classes).
- Workers keep using @changpm exactly as today. Do not touch `supabase/functions/line-webhook/` or `LINE_PUSH_ENABLED`.
- The customer never sees money, costs, another client's sites, worker names or internal notes.
- The tenant's OA secret and token must never appear in the browser, in logs, or in any API or RPC response readable by `authenticated`/`anon`.
- Account model: **one account per client**. It sees all of that client's sites (1 client → many sites).
- Invitation code: 6 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, one-time use, expires **7 days** after it is created.
- Phase 1a sends **no push**. Every bot message is a reply to a reply token.
- Every service-role query filters by `tenant_id`.
- **Subagents never call DB/MCP tools.** They write the migration plus a `BEGIN … ROLLBACK` dry-run script. The controller runs the dry run on CHANG and reports the result. Nothing is applied, deployed or merged without the owner's explicit OK.
- Migrations follow the RLS style of `2026-10-17-02-rls-initplan-wrap.sql`: `(SELECT is_admin_or_owner())`, `tenant_id = (SELECT current_tenant_id())`, and `(SELECT tenant_can_write())` on writes. Functions use `SET search_path = public` and `REVOKE ALL … FROM PUBLIC, anon`, then explicit GRANTs.
- Run the tests from the worktree root: `npx vitest run <file>`. The full suite is `npm test`.

## Review Focus
1. **A newer invite must cancel older unused invites for the same client.** Otherwise, after a re-invite, an old code shared earlier could still take over the account. Tested in Task 2.
2. **A code from tenant A sent to tenant B's OA must never link** (the claim filters by tenant), and an expired or used code returns `invalid`. Tested in Task 2.
3. **When the tenant loses the `line_bot` module or has invalid credentials,** the webhook still returns 200 to LINE, sends nothing, and does not throw. When the signature is bad it returns 401. Tested in Task 5 via `handleCustomerEvent` with a stubbed `deps`.
4. **A site with no `client_id`** cannot be invited from (the button is disabled with an explanation, and the RPC raises `site_has_no_client`). A client with no active sites gets "ยังไม่มีงานที่กำลังดำเนินการ", never an empty message. Tested in Tasks 2 and 4.
5. **Customer text that looks like a code** (e.g. a linked customer types `THANKS`) must not get an error reply. Only unlinked users get the invalid-code reply. Tested in Task 5.

---

## File map

| File | Responsibility |
|---|---|
| `supabase/migrations/2026-10-20-06-customer-line-channel.sql` | `customer_line_channels`, Vault save RPC, service-role readers |
| `supabase/migrations/2026-10-20-07-customer-line-accounts.sql` | `customer_line_accounts`, `customer_line_invites`, create/claim RPCs |
| `supabase/migrations/2026-10-20-08-customer-line-requests-photos.sql` | `customer_line_requests`, `pending_counts()` + 1 key, `customer_visible` flags + setter RPC |
| `supabase/tests/2026-10-20-0{6,7,8}-*.dryrun.sql` | BEGIN … ROLLBACK scripts with assertions |
| `supabase/functions/_shared/customer-line-commands.ts` | `matchCustomerCommand`, `looksLikeInviteCode` (pure) |
| `supabase/functions/_shared/customer-line-replies.ts` | every reply text builder (pure) |
| `supabase/functions/_shared/line-reply.ts` | `sendLineReplyMessages` (multi-message reply, pure, fetch injected) |
| `supabase/functions/_shared/customer-line-handler.ts` | `handleCustomerEvent(event, ctx, deps)` (pure orchestration, deps injected) |
| `supabase/functions/customer-line-webhook/index.ts` | HTTP shell: key → creds → signature → loop events → real deps |
| `supabase/functions/customer-line-test/index.ts` | owner-only connection test |
| `src/lib/customerLine.js` | `buildWebhookUrl`, `buildOaInviteLink` (pure) |
| `src/components/CustomerLineSettings.jsx` | Settings card (mockup board 1) |
| `src/components/CustomerInviteModal.jsx` | invite modal (board 2) |
| `src/pages/SiteDetail.jsx`, `src/pages/Settings.jsx`, `src/pages/CommunicationCenter.jsx`, `src/pages/sites/PhaseKanbanBoard.jsx`, `src/components/AttachmentsSection.jsx`, `src/lib/pendingItems.js` | wiring |
| `docs/line/customer-richmenu.html`, `.png`, `.md` | rich menu image + OA Manager setup steps |
| tests: `src/lib/customerLineCommands.test.js`, `customerLineReplies.test.js`, `lineReply.test.js`, `customerLineHandler.test.js`, `customerLine.test.js` | vitest |

---

### Task 1: Channel table + Vault credentials

**Files:**
- Create: `supabase/migrations/2026-10-20-06-customer-line-channel.sql`
- Create: `supabase/tests/2026-10-20-06-customer-line-channel.dryrun.sql`

**Interfaces:**
- Produces:
  - table `customer_line_channels`:
    - `tenant_id uuid PK → tenants`
    - `channel_id text NOT NULL`
    - `webhook_key text UNIQUE NOT NULL`
    - `secret_vault_id uuid`, `token_vault_id uuid`
    - `basic_id text`, `display_name text`
    - `contact_phone text`, `contact_hours text`
    - `verified_at timestamptz`
    - `created_at`, `updated_at`
  - `save_customer_line_credentials(p_channel_id text, p_channel_secret text, p_access_token text) RETURNS text`. It returns the webhook_key. GRANT authenticated.
  - `customer_line_creds_by_key(p_key text)` and `customer_line_creds_by_tenant(p_tenant uuid)`. Both return `TABLE(tenant_id uuid, channel_secret text, access_token text)` and are GRANTed to service_role ONLY.

- [ ] **Step 1: Write the migration.**
  - **Table RLS:**
    - SELECT for `is_owner()` in the own tenant.
    - UPDATE for owner + `tenant_can_write()`. A column-level `GRANT UPDATE (contact_phone, contact_hours, basic_id, display_name, verified_at)` to authenticated. Owners edit the contact info; the test function writes the rest with service role.
    - No INSERT/DELETE for authenticated.
  - **The save RPC (SECURITY DEFINER, `SET search_path = public, vault`):**
    - Raises `not_owner` unless `is_owner()`.
    - Raises `module_missing` unless `has_module_access('line_bot')`.
    - Raises `read_only` unless `tenant_can_write()`.
    - Creates the row on the first save, with `webhook_key = encode(gen_random_bytes(12),'hex')`.
    - Writes the secret and token with `vault.create_secret(value, 'customer_line_secret_'||tenant)` on first save, and `vault.update_secret(id, value)` later.
    - Treats a NULL or blank `p_channel_secret`/`p_access_token` as "keep the existing one". On first save all three values are required, else raise `missing_credentials`.
    - Any credential change sets `verified_at = NULL`.
  - **The two readers (SECURITY DEFINER):** they join `vault.decrypted_secrets` by id.
- [ ] **Step 2: Write the dry-run script.**
  - It runs `BEGIN;`, the migration body, then `SET LOCAL role authenticated` with `request.jwt.claims` for a real CHANG owner. The controller fills the owner's email/tenant in.
  - Then it runs DO-block assertions that `RAISE EXCEPTION` on failure:
    - (a) the save returns a 24-char key;
    - (b) `SELECT * FROM customer_line_channels` as authenticated returns no column named secret or token;
    - (c) calling `customer_line_creds_by_key` as authenticated fails with `permission denied`;
    - (d) as postgres, `customer_line_creds_by_key(key)` returns the saved secret;
    - (e) a second save with blank secret/token keeps the old values.
  - It ends with `ROLLBACK;`.
- [ ] **Step 3: Controller runs the dry run on CHANG.** Expected: completes with no exception and nothing persisted. Paste the result in the task report.
- [ ] **Step 4: Commit.** `git add supabase/migrations/2026-10-20-06-* supabase/tests/2026-10-20-06-* && git commit -m "feat(db): customer LINE channel with Vault-held credentials"`

### Task 2: Accounts + invites

**Files:**
- Create: `supabase/migrations/2026-10-20-07-customer-line-accounts.sql`
- Create: `supabase/tests/2026-10-20-07-customer-line-accounts.dryrun.sql`

**Interfaces:**
- Produces:
  - `customer_line_accounts`:
    - columns `id uuid PK`, `tenant_id`, `client_id → clients ON DELETE CASCADE`, `line_user_id text`, `line_display_name text`, `linked_at timestamptz default now()`, `last_seen_at timestamptz`;
    - `UNIQUE(tenant_id, client_id)` and `UNIQUE(tenant_id, line_user_id)`.
  - `customer_line_invites`:
    - columns `id`, `tenant_id`, `client_id`, `site_id`, `code text`, `expires_at`, `used_at`, `revoked_at`, `created_by text` (auth.email()), `created_at`;
    - a partial unique index on `(tenant_id, code) WHERE used_at IS NULL AND revoked_at IS NULL`.
  - `create_customer_invite(p_site_id uuid) RETURNS TABLE(code text, expires_at timestamptz, client_id uuid, client_name text)`, GRANT authenticated.
  - `claim_customer_invite(p_tenant uuid, p_code text, p_line_user_id text, p_display_name text) RETURNS TABLE(status text, client_id uuid, client_name text)`, service_role only. `status ∈ {'ok','invalid'}`.
  - RLS: admin/owner/PM SELECT on both tables in the own tenant; admin/owner DELETE on accounts (this is the unlink).

- [ ] **Step 1: Write the migration.**
  - **`create_customer_invite`:**
    - Allowed for `is_admin_or_owner() OR is_pm()`, plus `tenant_can_write()` and `has_module_access('line_bot')`.
    - Raises `site_has_no_client` when `sites.client_id IS NULL`.
    - Sets `revoked_at = now()` on every unused, unrevoked invite of the same client.
    - Generates the code with `gen_random_bytes` mapped onto the 31-char alphabet, retrying on a unique clash.
    - `expires_at = now() + interval '7 days'`.
  - **`claim_customer_invite`, in ONE statement chain:**
    - `UPDATE … SET used_at = now() WHERE tenant_id = p_tenant AND code = upper(trim(p_code)) AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now() RETURNING client_id`.
    - If no row was updated, return `'invalid'`.
    - Otherwise delete any account for that client or for that line user in the tenant, insert the new account, and return `'ok'` with `clients.name`.
- [ ] **Step 2: Write the dry run.** Assertions:
  - (a) an owner creates an invite and gets a 6-char code matching `^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$` that expires in 7 days ±1 min;
  - (b) a second invite for the same client revokes the first; claiming the first returns `invalid`;
  - (c) claiming the second returns `ok` and creates an account;
  - (d) claiming it again returns `invalid`;
  - (e) a claim with the right code but another tenant's uuid returns `invalid`;
  - (f) a new invite claimed by a different line user replaces the account, so the client still has exactly 1 row;
  - (g) a site with NULL client_id raises `site_has_no_client`. Create a temp site inside the transaction.
- [ ] **Step 3: Controller runs the dry run on CHANG.** Expected: no exception.
- [ ] **Step 4: Commit.** `feat(db): customer LINE accounts and one-time invites`

### Task 3: Requests (bell) + customer-visible photos

**Files:**
- Create: `supabase/migrations/2026-10-20-08-customer-line-requests-photos.sql`
- Create: `supabase/tests/2026-10-20-08-customer-line-requests-photos.dryrun.sql`
- Modify: `src/lib/pendingItems.js`
- Modify: `src/lib/pendingRules.js` (only if it lists keys)

**Interfaces:**
- Produces:
  - `customer_line_requests`:
    - columns `id`, `tenant_id`, `line_user_id text`, `client_id uuid NULL`, `kind text CHECK (kind IN ('quote','repair'))`, `display_name text`, `created_at`, `handled_at`, `handled_by text`;
    - a partial unique index on `(tenant_id, line_user_id, kind) WHERE handled_at IS NULL`, so there is at most one open request per person per kind;
    - RLS: admin/owner SELECT, and UPDATE of `handled_at`/`handled_by` only.
  - `pending_counts()` gains the key `customer_requests_open` (count of `handled_at IS NULL` in the tenant, for admin/owner only; 0 otherwise).
  - `line_site_photos.customer_visible boolean NOT NULL DEFAULT false` and `site_attachments.customer_visible boolean NOT NULL DEFAULT false`.
  - `set_customer_visible(p_kind text, p_id uuid, p_visible boolean) RETURNS void`:
    - `p_kind ∈ {'line_site_photo','site_attachment'}`;
    - allowed for `is_admin_or_owner() OR is_pm()`, plus `tenant_can_write()`;
    - it checks that the row belongs to the current tenant;
    - GRANT authenticated.
  - `PENDING_ITEMS` gains `{ key: 'customer_requests_open', icon: '💬', label: 'ลูกค้าทักทาง LINE', tab: <the same tab/fallbackTabs as the offboarded_in_group entry> }`.

- [ ] **Step 1: Controller fetches the live `pg_get_functiondef('pending_counts'::regproc)` from CHANG and hands it to the implementer.** The migration must copy it verbatim and only add the new key. Rule from `2026-10-20-05`: change a live function by copying it from live.
- [ ] **Step 2: Controller lists views over `line_site_photos` / `site_attachments`** (`SELECT viewname FROM pg_views WHERE definition ILIKE '%line_site_photos%' OR definition ILIKE '%site_attachments%'`). Any view built with `x.*` must be recreated in this migration so it picks up `customer_visible`. This is the "view e.* column freeze" lesson.
- [ ] **Step 3: Write the migration and the dry run.** Assertions:
  - (a) inserting the same open request twice, with `ON CONFLICT DO NOTHING`, leaves 1 row;
  - (b) `pending_counts()->>'customer_requests_open'` = 1 for the owner;
  - (c) after setting `handled_at` it is 0;
  - (d) `set_customer_visible('line_site_photo', <a photo of another tenant>, true)` raises;
  - (e) for an own photo it flips the flag.
- [ ] **Step 4: Write the failing test in `src/lib/pendingItems.test.js`** (create it if absent): `it('has a bell entry for customer LINE requests', () => expect(PENDING_ITEMS.find(i => i.key === 'customer_requests_open')).toMatchObject({ label: 'ลูกค้าทักทาง LINE' }))`. Run it and expect FAIL. Add the entry, run it again and expect PASS.
- [ ] **Step 5: Controller runs the dry run on CHANG.** Expected: no exception.
- [ ] **Step 6: Commit.** `feat(db): customer LINE requests in the bell; customer-visible photo flag`

### Task 4: Pure command matching + reply texts

**Files:**
- Create: `supabase/functions/_shared/customer-line-commands.ts`
- Create: `supabase/functions/_shared/customer-line-replies.ts`
- Test: `src/lib/customerLineCommands.test.js`
- Test: `src/lib/customerLineReplies.test.js`

**Interfaces:**
- Produces:
  - `type CustomerCommand = 'quote'|'status'|'repair'|'repair_status'|'warranty'|'contact'`
  - `matchCustomerCommand(text: string): CustomerCommand|null`. It trims and removes inner spaces. Exact phrases: ขอใบเสนอราคา→quote, สถานะงาน→status, แจ้งซ่อม→repair, สถานะแจ้งซ่อม→repair_status, ประกันของฉัน→warranty, ติดต่อเรา→contact.
  - `looksLikeInviteCode(text: string): boolean`. It returns true when `trim().toUpperCase()` matches `^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$`.
  - `type SiteStatus = { name: string, status: 'Ongoing'|'On Hold'|'Completed'|'Cancelled', pct: number|null, phases: string[], endDate: string|null /* YYYY-MM-DD */ }`
  - The reply builders all return `string`:
    - `inviteOkText(clientName)`, `inviteInvalidText()`, `notLinkedText()`
    - `quoteText()`, `repairTempText()`, `repairStatusTempText()`
    - `warrantyTempText(sites: SiteStatus[])`
    - `contactText({ companyName, phone, hours })`
    - `statusText(sites: SiteStatus[], today: string)`

- [ ] **Step 1: Write the failing tests.** The exact copy that must be asserted:

```js
expect(inviteOkText('คุณบิ๊ก')).toBe('เชื่อมกับ คุณบิ๊ก เรียบร้อยครับ\nกดเมนู "สถานะงาน" เพื่อดูความคืบหน้าได้ตลอด')
expect(inviteInvalidText()).toBe('รหัสนี้ใช้ไม่ได้หรือหมดอายุแล้ว กรุณาขอรหัสใหม่จากบริษัท')
expect(notLinkedText()).toBe('ยังไม่มีงานที่เชื่อมกับไลน์นี้\nถ้าเป็นลูกค้าอยู่แล้ว ส่งรหัสเชิญ 6 ตัวที่ได้จากบริษัทมาได้เลย\nถ้าสนใจทำงานใหม่ กด "ขอใบเสนอราคา"')
expect(quoteText()).toBe('ขอบคุณที่สนใจครับ\nส่งแบบหรือรูปหน้างาน ขนาดคร่าวๆ ที่ตั้งหน้างาน และเบอร์โทรมาในแชทนี้ได้เลย\nเจ้าหน้าที่จะติดต่อกลับภายใน 1 วันทำการ')
expect(repairTempText()).toBe('พิมพ์อาการและส่งรูปมาในแชทนี้ได้เลยครับ\nเจ้าหน้าที่จะรับเรื่องและติดต่อกลับ')
expect(repairStatusTempText()).toBe('ยังไม่มีรายการแจ้งซ่อมในระบบ\nถ้าแจ้งไว้ทางแชท เจ้าหน้าที่จะตอบในแชทนี้')
expect(contactText({ companyName: 'FacadeX', phone: '02-000-0000', hours: 'จันทร์–เสาร์ 08:00–17:00' }))
  .toBe('FacadeX\nโทร 02-000-0000\nเวลาทำการ จันทร์–เสาร์ 08:00–17:00\nหรือพิมพ์ในแชทนี้ได้เลย เจ้าหน้าที่จะตอบในเวลาทำการ')
expect(contactText({ companyName: 'FacadeX', phone: null, hours: null }))
  .toBe('FacadeX\nหรือพิมพ์ในแชทนี้ได้เลย เจ้าหน้าที่จะตอบในเวลาทำการ')
const big = { name: 'บ้านคุณบิ๊ก', status: 'Ongoing', pct: 62, phases: ['ติดตั้งกระจก ชั้น 2'], endDate: '2026-11-15' }
expect(statusText([big], '2026-10-19')).toBe('สถานะงาน · อัปเดต 19/10/2026\n\nบ้านคุณบิ๊ก\nความคืบหน้ารวม 62%\nกำลังทำ: ติดตั้งกระจก ชั้น 2\nกำหนดเสร็จ: 15/11/2026')
expect(statusText([{ ...big, pct: null, phases: [], endDate: null }], '2026-10-19')).toBe('สถานะงาน · อัปเดต 19/10/2026\n\nบ้านคุณบิ๊ก\nยังไม่มีข้อมูลความคืบหน้า')
expect(statusText([], '2026-10-19')).toBe('ยังไม่มีงานที่กำลังดำเนินการ')
expect(statusText([{ ...big, status: 'Completed' }], '2026-10-19')).toBe('ยังไม่มีงานที่กำลังดำเนินการ') // only Ongoing / On Hold are listed
expect(warrantyTempText([big, { ...big, name: 'คอนโด A', status: 'Completed' }]))
  .toBe('บ้านคุณบิ๊ก: ยังไม่ส่งมอบงาน ประกันเริ่มนับจากวันส่งมอบ\nคอนโด A: ข้อมูลประกันกำลังจัดทำ สอบถามได้ที่แชทนี้')
expect(warrantyTempText([])).toBe('ยังไม่มีงานในระบบ')
```

  - `statusText` behaviour:
    - Several active sites are separated by a blank line.
    - `pct` is rounded to an integer.
    - At most 10 sites are listed.
    - Text is cut at 4,900 characters, because LINE's limit is 5,000.
  - `warrantyTempText` skips Cancelled sites.
  - Command tests:
    - `matchCustomerCommand(' สถานะ งาน ')==='status'`
    - `matchCustomerCommand('สวัสดี')===null`
    - `looksLikeInviteCode('k7p2qm')===true`
    - `looksLikeInviteCode('K7P2Q0')===false` (0 is not in the alphabet)
    - `looksLikeInviteCode('K7P2QMX')===false`
- [ ] **Step 2: Run** `npx vitest run src/lib/customerLineCommands.test.js src/lib/customerLineReplies.test.js`. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement both modules.** No Deno imports.
- [ ] **Step 4: Run again.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(line): customer command matching and reply texts`

### Task 5: Webhook (handler + HTTP shell + multi-message reply)

**Files:**
- Create: `supabase/functions/_shared/line-reply.ts`
- Create: `supabase/functions/_shared/customer-line-handler.ts`
- Create: `supabase/functions/customer-line-webhook/index.ts`
- Test: `src/lib/lineReply.test.js`
- Test: `src/lib/customerLineHandler.test.js`

**Interfaces:**
- Consumes: Task 4's modules; `claim_customer_invite` (Task 2); `customer_line_creds_by_key` (Task 1); `customer_line_requests` (Task 3); `verifyLineSignature` from `_shared/line.ts`; `tenantHasModuleAccess` from `_shared/tenant-access.ts`.
- Produces:
  - `type LineMessage = { type: 'text', text: string } | { type: 'image', originalContentUrl: string, previewImageUrl: string }`
  - `sendLineReplyMessages(accessToken: string, replyToken: string, messages: LineMessage[], fetchImpl = fetch): Promise<{ ok: boolean, status: number }>`. It posts to `https://api.line.me/v2/bot/message/reply`, sends at most 5 messages (it truncates the list), and never throws: a network error returns `{ok:false,status:0}`.
  - `handleCustomerEvent(event, ctx: { tenantId: string, today: string }, deps): Promise<LineMessage[]>`. It returns the messages to reply; an empty array means stay silent. `deps` holds:
    - `getAccount(lineUserId) → { clientId, clientName } | null`
    - `claimInvite(code, lineUserId, displayName) → { status, clientName }`
    - `getDisplayName(lineUserId) → string|null`
    - `loadSites(clientId) → SiteStatus[]`
    - `loadPhotos(clientId) → { url: string }[]`: at most 3 signed HTTPS JPEG/PNG urls of `customer_visible` photos, but only when the client has exactly one active site; otherwise `[]`
    - `getContact() → { companyName, phone, hours }`
    - `openRequest(kind, lineUserId, clientId|null, displayName) → void`
    - `touchAccount(lineUserId) → void`

- [ ] **Step 1: Write the failing `lineReply.test.js`.**
  - With a stub fetch, check that the body is `{ replyToken, messages }`, the header is `Authorization: Bearer tok`, and 7 messages are truncated to 5.
  - A fetch that throws gives `{ok:false,status:0}`.
- [ ] **Step 2: Write the failing `customerLineHandler.test.js`** with stub deps:
  - Unlinked + `K7P2QM`, claim ok → `[text inviteOkText('คุณบิ๊ก')]`.
  - Unlinked + `K7P2QM`, claim invalid → `[text inviteInvalidText()]`.
  - Linked + `THANKS`, claim invalid → `[]`. This is Review Focus 5.
  - Linked + `K7P2QM`, claim ok → the invite reply. Re-linking is allowed.
  - Unlinked + `สถานะงาน` → `[notLinkedText()]`. The same for repair / repair_status / warranty.
  - Unlinked + `ขอใบเสนอราคา` → `[quoteText()]`, and `openRequest('quote', uid, null, name)` is called once.
  - Linked + `แจ้งซ่อม` → `[repairTempText()]`, and `openRequest('repair', uid, clientId, name)` is called.
  - Linked + `สถานะงาน`, with 1 active site and 2 photos → `[text statusText(...), image, image]`, where each image has `originalContentUrl === previewImageUrl === url`.
  - Anyone + `ติดต่อเรา` → `[contactText(getContact())]`.
  - Linked + `สวัสดี` → `[]`.
  - A non-text event (image, sticker, follow) → `[]`.
  - When the user is linked, `touchAccount` is called on every text event.
- [ ] **Step 3: Run both test files.** Expected: FAIL.
- [ ] **Step 4: Implement `line-reply.ts` and `customer-line-handler.ts`.** They are pure: no Deno, no supabase imports.
- [ ] **Step 5: Run both test files.** Expected: PASS.
- [ ] **Step 6: Implement `customer-line-webhook/index.ts`, the shell.** It is not unit-tested; the logic lives in the handler.
  - **Request checks, in order:**
    - Non-POST → 405.
    - Read `t` from the URL; no `t` → 404.
    - Call `admin.rpc('customer_line_creds_by_key', { p_key: t })`; no row → 404.
    - `verifyLineSignature(secret, rawBody, x-line-signature)` fails → 401.
    - `tenantHasModuleAccess(admin, tenantId, 'line_bot')` is false → return 200 and do nothing.
  - **For each event:** run `handleCustomerEvent`. If it returns messages, call `sendLineReplyMessages(token, event.replyToken, msgs)`.
  - **Real deps, each with its own `.eq('tenant_id', tenantId)`:**
    - `loadSites`: `sites` where `client_id` and status ≠ Cancelled. `pct` comes from `admin.rpc('site_progress_pct', { p_site_id })`, using `.contract_pct`. `phases` are the names of `site_phases` with `status='in_progress'`. `endDate` is `sites.end_date`.
    - `loadPhotos`: the newest 3 rows of `line_site_photos` (`customer_visible`, bucket `line-site-photos`) and `site_attachments` (`customer_visible`, bucket `site-attachments`, file name ending .jpg/.jpeg/.png). Each gets `createSignedUrl(path, 604800)`.
    - `getDisplayName`: `GET https://api.line.me/v2/bot/profile/{userId}`; null on failure.
    - `getContact`: `customer_line_channels.contact_phone/contact_hours`, falling back to `tenants.phone`, plus `tenants.company_name`.
    - `openRequest`: insert with `onConflict: 'tenant_id,line_user_id,kind'` and `ignoreDuplicates: true`. The partial unique index needs `ON CONFLICT DO NOTHING`. If supabase-js cannot target a partial index, use `.insert()` and ignore error code `23505`.
  - **Always return 200 after the loop.** Wrap each event in try/catch with `console.error('customer-line event failed', e.message)`. Never log tokens, secrets or bodies.
  - `today` = Asia/Bangkok date (`toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' })`).
- [ ] **Step 7: Run** `npm test`. Expected: the whole suite PASSES.
- [ ] **Step 8: Commit.** `feat(line): customer-line-webhook for tenant OAs`

### Task 6: Connection test function

**Files:**
- Create: `supabase/functions/customer-line-test/index.ts`

**Interfaces:**
- Consumes: `customer_line_creds_by_tenant` (Task 1).
- Produces: `POST /functions/v1/customer-line-test` with the user's JWT. It returns `{ ok: boolean, basicId?: string, displayName?: string, webhook?: { success: boolean, statusCode?: number, reason?: string }, error?: 'not_configured'|'bad_token'|'forbidden' }`. The body NEVER contains the secret or token.

- [ ] **Step 1: Implement it.**
  - **Auth:** copy the pattern of `route-distance/index.ts:23-28`, but allow `role === 'OWNER'` only.
  - **Check the token:** `GET https://api.line.me/v2/bot/info`. If it is not ok, return `bad_token`.
  - **Check the webhook:** `POST https://api.line.me/v2/bot/channel/webhook/test` with `{ endpoint: <SUPABASE_URL>/functions/v1/customer-line-webhook?t=<webhook_key> }`.
  - **Save the result** with the service role: `basic_id` (strip the leading `@`), `display_name`, and `verified_at = now()` only if `webhook.success`.
  - CORS is the same as route-distance.
- [ ] **Step 2: Commit.** `feat(line): owner-only customer OA connection test`

### Task 7: Settings card (mockup board 1)

**Files:**
- Create: `src/lib/customerLine.js`
- Test: `src/lib/customerLine.test.js`
- Create: `src/components/CustomerLineSettings.jsx`
- Modify: `src/pages/Settings.jsx` (communication section, about L622-670)

**Interfaces:**
- Produces:
  - `buildWebhookUrl(supabaseUrl: string, key: string): string` returns `${supabaseUrl}/functions/v1/customer-line-webhook?t=${key}` (any trailing slash on the URL is stripped).
  - `buildOaInviteLink(basicId: string, code: string): string` returns `https://line.me/R/oaMessage/@${basicId.replace(/^@/,'')}/?${code}`.

- [ ] **Step 1: Write the failing tests for both helpers** (trailing slash; a basicId with and without `@`). Run them and expect FAIL. Implement. Run them and expect PASS.
- [ ] **Step 2: Build `CustomerLineSettings.jsx`, matching board 1.**
  - **Data:** load `customer_line_channels` with named columns only: `channel_id, webhook_key, basic_id, display_name, contact_phone, contact_hours, verified_at`.
  - **Status badge:** "เชื่อมแล้ว · @{basic_id}" when `verified_at`, "ยังไม่ได้ทดสอบ" when there is a row but no `verified_at`, "ยังไม่เชื่อม" when there is no row.
  - **Credential inputs:** Channel ID is a text input. Secret and token are `type="password"`, always rendered empty, with the placeholder "บันทึกแล้ว — ใส่ใหม่เพื่อเปลี่ยน" once a row exists.
  - **บันทึก:** `supabase.rpc('save_customer_line_credentials', …)`, then clear the two password fields.
  - **ทดสอบการเชื่อมต่อ:** `supabase.functions.invoke('customer-line-test')`. Show "ทดสอบผ่าน" or the error in Thai: bad_token → "token ไม่ถูกต้อง", webhook failure → "LINE เรียก webhook ไม่ผ่าน (status X) — ตรวจว่าวาง URL และเปิด Use webhook แล้ว".
  - **Webhook URL block:** the URL plus a copy button. It appears only when `webhook_key` exists. Below it go the 4 steps from board 1.
  - **"ข้อมูลสำหรับปุ่มติดต่อเรา" card:** phone and hours, saved with `.update()` on the row.
  - **Errors:** surfaced with the same `alert('บันทึกไม่สำเร็จ: ' + e.message)` pattern as `LinePushSettings.jsx`. If the error is `module_missing` → "แพ็กเกจนี้ยังไม่มีโมดูล LINE".
- [ ] **Step 3: Render it in Settings.jsx's communication section** after `<LinePushSettings/>`. Show it when `isOwner && hasModuleAccess('line_bot')`, the same condition as `showLinePush`.
- [ ] **Step 4: Run** `npm test && npm run build`. Expected: both pass.
- [ ] **Step 5: Commit.** `feat(settings): connect the company's customer LINE OA`

### Task 8: Invite modal + SiteDetail button (mockup board 2)

**Files:**
- Modify: `package.json` (add `qrcode@^1.5.4`)
- Create: `src/components/CustomerInviteModal.jsx`
- Modify: `src/pages/SiteDetail.jsx` (header, about L54-59)

**Interfaces:**
- Consumes: `create_customer_invite` (Task 2), `buildOaInviteLink` (Task 7), `customer_line_accounts`, `customer_line_channels.basic_id`.

- [ ] **Step 1: Run** `npm install qrcode@^1.5.4`.
- [ ] **Step 2: Build the modal, matching board 2.**
  - **On open:** call `create_customer_invite(siteId)`. Show the code, "ใช้ได้ครั้งเดียว · หมดอายุ dd/mm/yyyy (7 วัน)", the QR made with `QRCode.toDataURL(link, { width: 480, margin: 1 })` of `buildOaInviteLink`, a copy-link button, and "บันทึกรูป QR" (an `<a download="invite-<code>.png">`).
  - **Share:** "แชร์ไปไลน์ลูกค้า" opens `https://line.me/R/share?text=` + encodeURIComponent(`สแกนหรือกดลิงก์นี้เพื่อติดตามงาน ${siteName}: ${link}`).
  - **Current account section:** read from `customer_line_accounts` for the site's client: line_display_name, "เชื่อมเมื่อ", "ล่าสุด" (last_seen_at). It is titled "บัญชีไลน์ของ client: {clientName} (เห็น N ไซท์)", where N is the count of the client's non-Cancelled sites.
  - **ยกเลิกการเชื่อม:** visible to admin/owner. It runs `.delete()` by id after `confirm('ยกเลิกการเชื่อมไลน์ของ client นี้?')`.
  - **Replacement warning:** if an account exists, show "ถ้ามีคนใหม่ใช้รหัสนี้ จะแทนที่บัญชีเดิม (1 บัญชีต่อ client)". The owner's confirmation is opening a new invite while that warning is shown, since creating an invite revokes the old codes.
  - **Errors:** `site_has_no_client` → "ไซท์นี้ยังไม่ได้ผูก client — แก้ไขไซท์แล้วเลือก client ก่อน". No `basic_id` (OA not tested) → "ยังไม่ได้เชื่อม LINE OA — ไปที่ ตั้งค่า › การสื่อสารและแจ้งเตือน".
- [ ] **Step 3: Add the "เชิญลูกค้า" button to the SiteDetail header.** It is shown when `canEdit && hasModuleAccess('line_bot')`, and disabled with a `title` hint when `!site.client_id`.
- [ ] **Step 4: Run** `npm test && npm run build`. Expected: both pass.
- [ ] **Step 5: Commit.** `feat(sites): invite a client to the company LINE OA`

### Task 9: Photo visibility toggles + customer requests card

**Files:**
- Modify: `src/pages/sites/PhaseKanbanBoard.jsx` (photo tray, about L264-495)
- Modify: `src/components/AttachmentsSection.jsx` (new optional prop)
- Modify: `src/pages/Sites.jsx:949`
- Modify: `src/pages/CommunicationCenter.jsx`

**Interfaces:**
- Consumes: `set_customer_visible` and `customer_line_requests` (Task 3).

- [ ] **Step 1: Kanban tray.**
  - Add `customer_visible` to the photo select.
  - Each photo gets a toggle button (`aria-label="ให้ลูกค้าเห็น"`) with an eye icon that is filled when the photo is on. It calls `rpc('set_customer_visible', { p_kind: 'line_site_photo', p_id, p_visible })` and updates local state.
  - Shown to PM/admin/owner only.
- [ ] **Step 2: AttachmentsSection.**
  - Add the optional prop `customerVisibleKind`. When it is set, image files (.jpg/.jpeg/.png) get a "ให้ลูกค้าเห็น" checkbox that calls the same RPC with that kind.
  - Pass `customerVisibleKind="site_attachment"` from `Sites.jsx:949` only. Other uses stay unchanged.
- [ ] **Step 3: CommunicationCenter "ลูกค้าทักทาง LINE" card.**
  - Place it at the top of the cards. It shows only when there are open requests or a channel row exists.
  - It lists the open `customer_line_requests`: kind label (quote → "ขอใบเสนอราคา", repair → "แจ้งซ่อม"), display_name, linked client name if any, and time.
  - Each row has a "ปิดเรื่อง" button that sets `handled_at = now(), handled_by = <email>`.
  - A hint line: "ตอบลูกค้าในแชท LINE OA Manager แล้วกดปิดเรื่อง".
  - The bell's `customer_requests_open` lands here.
- [ ] **Step 4: Run** `npm test && npm run build`. Expected: both pass.
- [ ] **Step 5: Commit.** `feat(line): customer-visible photo toggles and customer request list`

### Task 10: Rich menu image + OA Manager setup doc

**Files:**
- Create: `docs/line/customer-richmenu.html`
- Create: `docs/line/customer-richmenu.png`
- Create: `docs/line/customer-richmenu.md`

- [ ] **Step 1: Write `customer-richmenu.html`.** It is a static 2500×1686 page that reproduces mockup board 3 at 2× (3×2 tiles, Warm Oak), with the font from Google Fonts Noto Sans Thai. Copy the board's markup from the artifact. The controller reads it with `Artifact read path=project/RichMenu.dc.html` and hands it to the implementer.
- [ ] **Step 2: Controller renders the PNG** with Playwright at a 2500×1686 viewport → `customer-richmenu.png`. Expected: the file is under 1 MB (LINE's limit). If it is larger, use `pngquant` or re-export as JPEG.
- [ ] **Step 3: Write `customer-richmenu.md`** (Thai). It covers:
  - In LINE OA Manager › Rich menus › Create: the template "Large · 6 areas (3×2)", upload the PNG, and set each area's action to **Text**. Area texts, left→right and top→bottom: ขอใบเสนอราคา · สถานะงาน · แจ้งซ่อม · สถานะแจ้งซ่อม · ประกันของฉัน · ติดต่อเรา.
  - Menu bar text "เมนู", display period always, and the switch to make it the default menu.
  - In LINE Developers: paste the webhook URL and turn on "Use webhook".
  - In OA Manager › Response settings: keep Chat ON and turn auto-reply OFF, so it does not double-answer the menu texts.
- [ ] **Step 4: Commit.** `docs(line): @facadex customer rich menu image and setup steps`

### Task 11: Release prep (no deploy without the owner)

**Files:**
- Modify: `package.json` version, `src/changelog.json`

- [ ] **Step 1: Bump the version** to the next minor above the version live at that moment. Check `build-info.json` live first (it is 1.22.6 at plan time, so 1.23.0). Changelog notes (Thai):
  - "เชื่อม LINE OA ของบริษัทสำหรับลูกค้า (ตั้งค่า › การสื่อสารและแจ้งเตือน)"
  - "เชิญลูกค้าติดตามงานด้วย QR จากหน้าไซท์"
  - "ลูกค้ากด สถานะงาน ในไลน์ ดูความคืบหน้าและรูปที่เลือกให้ลูกค้าเห็นได้"
  - "คำขอจากลูกค้าทางไลน์ขึ้นกระดิ่งในแอป"
- [ ] **Step 2: Run** `npm test && npm run build`. Expected: both pass. Commit `chore(release): 1.23.0 customer LINE foundation`.
- [ ] **Step 3: Whole-branch review.** Dispatch a fresh reviewer over `main..HEAD` against this plan and the spec's anti-goals.
- [ ] **Step 4: STOP and ask the owner** before each of these: applying migrations -06/-07/-08 on CHANG, deploying `customer-line-webhook` (`--no-verify-jwt`) and `customer-line-test` (JWT on), deploying the web app (`npm run deploy` per the chang-ship skill, after warning about the parallel worktrees), and merging.
- [ ] **Step 5: Live verification, after the owner OKs and things are deployed:**
  1. The owner saves the @facadex credentials in Settings, then presses ทดสอบ. Expected: "ทดสอบผ่าน" and the badge reads @facadex.
  2. `SELECT` as the owner from the browser network tab shows no secret or token. As a controller check: `SELECT column_name FROM information_schema.columns WHERE table_name='customer_line_channels'` lists no secret column.
  3. Invite on a test site, scan it with a second LINE account, send the code. Expected: the "เชื่อมกับ …" reply.
  4. Tap each of the 6 rich-menu buttons. Expected: the Task 4 texts, and a bell count of +1 for ขอใบเสนอราคา / แจ้งซ่อม.
  5. Tick one kanban photo "ให้ลูกค้าเห็น", then tap สถานะงาน. Expected: the photo arrives.
  6. Send `งานวันนี้` to @changpm from a worker account. Expected: the crew bot is unchanged.
