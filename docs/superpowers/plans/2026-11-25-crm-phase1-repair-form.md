# CRM Phase 1 — LINE repair form (items table) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tapping แจ้งซ่อม in customer OA @facadex gives the customer a no-login form link. The form collects one or more items (location, symptom, ≥1 photo, optional video) plus up to 3 preferred days. Sending it creates ONE `pending_review` repair ticket with an item table, which staff see in the existing repair modal.

**Architecture:**
- A new table `repair_ticket_items` plus a nullable `repair_ticket_media.item_id` holds the items.
- A new `customer_link_tokens` table holds the single-use 24 h link.
- A new public edge function `customer-form` serves the `/r/<token>` page. Photos upload straight to the `repair-media` bucket through signed upload URLs.
- On submit, one SECURITY DEFINER RPC writes the ticket, its items and its media in a single transaction.
- Validation rules live in one pure module shared by the page and the function.
- The old chat flow stays, reachable from a "แจ้งทางแชท" quick reply.

**Tech Stack:** React 18 (Vite), Supabase Postgres + Storage + Deno edge functions, LINE Messaging API (reply, plus one budgeted push), vitest 4.

**Spec:** `docs/superpowers/specs/2026-11-24-crm-design.md` (sections "E — repair form", "Data changes › Phase 1", "Components"). Mockup: https://claude.ai/artifact/3VWucQKx39dGLWgV7TpAdA

## Global Constraints

- **Work location.** Worktree `.claude/worktrees/crm`, branch `feat/crm`. Never `cd` to the main repo, and never use bare `git stash`.
- **DB access.** Subagents make **no DB calls**. They write `*.dryrun.sql` (BEGIN … ROLLBACK) and the controller runs it. A migration goes live the moment it is applied.
- **Migration names.** `supabase/migrations/2026-11-25-0N-<name>.sql`, each paired with a `.dryrun.sql`.
- **Tenant RLS** follows `2026-10-20-11-repair-tickets.sql`: `(SELECT is_admin_or_owner()) AND tenant_id = (SELECT current_tenant_id())`, and writes also need `(SELECT tenant_can_write())`.
- **Service-role-only objects** (tokens, RPC) get no anon/authenticated grants: `REVOKE ALL … FROM PUBLIC, anon, authenticated`.
- **Bucket and paths.** The bucket is `repair-media` (private). The first path segment must be the tenant id, because the staff storage policy checks `foldername[1]`.
- **Location chips** (exact): `ห้องนอน`, `ห้องนั่งเล่น`, `ครัว`, `ห้องน้ำ`, `ระเบียง`, `ภายนอก`, `อื่นๆ`.
- **Symptom chips** (exact): `รั่วซึม`, `เปิดปิดยาก`, `กระจกร้าว-แตก`, `ซีลยางหลุด`, `มือจับ-กลอนเสีย`, `อื่นๆ`.
- **Per item:** ≥1 image is required; at most 5 images and 1 video; video ≤30 s; any file ≤50 MB.
- **Per ticket:** 1–20 items. Preferred days: 0–3 distinct dates, each from tomorrow up to +60 days (Bangkok). Slot is one of `morning` / `afternoon` / `all_day`, shown as เช้า / บ่าย / ทั้งวัน.
- **Links.** The token is valid for 24 h and claimed atomically on submit. The link is `${APP_URL}/r/<token>` (`_shared/app-url.ts`).
- **Gates.** Customer access needs the `line_bot` module (`tenantHasModuleAccess`), the same gate as customer-line-webhook.
- **Dates** shown to people use the Buddhist year (`formatThaiDate`).
- **Copy.** All user-facing text is Thai. The old chat flow (30 min + "ส่งครบแล้ว") must keep working unchanged.
- **Release.** Version 1.39.0 or higher than live, whichever is greater; check `build-info.json` on live before bumping. Update `src/changelog.json` and `public/manual/index.html` (#page-repairs). Warn the owner before deploying, because several worktrees deploy in parallel.

## Review Focus

1. **Customer sends twice** (double tap, or the back button then send again). Expect exactly one ticket. The second send says "ส่งแล้ว เลขที่ RP…", not an error and not a duplicate. → Task 2 dry-run case (b) + Task 3 test + Task 5 page test.
2. **Token belongs to client A but the payload names client B's site, or a storage path outside this token's folder.** Expect a refusal and nothing written. → Task 2 dry-run (c)(d) + Task 3 test.
3. **A photo upload fails midway or the phone loses signal.** Expect the items already entered to survive a reload (browser draft per token), and the send button to stay disabled while any upload is pending. → Task 5 test.
4. **An iPhone HEIC photo or a 4K video.** Expect HEIC to be converted by `resizeToJpeg` (falling back to the raw file if decoding fails). Expect a video over 30 s or 50 MB to be rejected on the item screen with a Thai message, never at submit. → Task 3 tests + Task 5 test.
5. **A customer with one site versus many, or with no non-cancelled site.** One site skips the site screen. No site shows "ยังไม่พบไซท์ของคุณ กรุณาติดต่อบริษัท" and offers no form. → Task 3 test (info `no_sites`) + Task 5 page test.

---

## File map

| File | Responsibility |
|---|---|
| `supabase/migrations/2026-11-25-01-repair-form.sql` (+ `.dryrun.sql`) | tables, columns, RLS, RPC `submit_repair_form` |
| `supabase/functions/_shared/repair-form.ts` | pure rules: chips, limits, `validateRepairForm`, `itemsDescription`, `preferredDayBounds` |
| `src/lib/repairForm.test.js` | tests for the module above |
| `supabase/functions/customer-form/index.ts` | public endpoint: `info`, `upload_url`, `submit` |
| `supabase/functions/_shared/customer-form-logic.ts` | pure handler `handleCustomerForm(body, deps)` so it can be unit-tested |
| `src/lib/customerForm.test.js` | tests for the logic module |
| `supabase/functions/_shared/customer-line-handler.ts` | แจ้งซ่อม → form-link Flex; "แจ้งทางแชท" → old flow |
| `supabase/functions/_shared/repair.ts` | `repairFormLinkFlex(url, siteCount)`, `repairFormDoneText(ticketNumber)` |
| `supabase/functions/customer-line-webhook/index.ts` | implements the new dep `createRepairFormLink` |
| `src/RepairFormPage.jsx` + `src/lib/repairFormState.js` | the `/r/<token>` page and its pure reducer |
| `src/lib/repairFormState.test.js`, `src/RepairFormPage.test.jsx` | tests |
| `src/main.jsx` | route `/r/<token>` (lazy, like `/f/`) |
| `src/components/RepairTicketModal.jsx` (+ test) | item table, preferred days, schedule prefill |

---

### Task 1: Pure rules module

**Files:**
- Create: `supabase/functions/_shared/repair-form.ts`
- Test: `src/lib/repairForm.test.js`

**Interfaces:**
- Produces:
  - `LOCATIONS: readonly string[]` and `SYMPTOMS: readonly string[]` (the exact chips above)
  - `LIMITS = { maxItems: 20, maxImages: 5, maxVideos: 1, maxVideoSeconds: 30, maxBytes: 50*1024*1024, maxPreferredDays: 3, maxDaysAhead: 60 }`
  - `SLOTS = { morning: 'เช้า', afternoon: 'บ่าย', all_day: 'ทั้งวัน' }`
  - `type FormFile = { path: string; mediaType: 'image'|'video'; bytes: number; seconds?: number }`
  - `type FormItem = { location: string; room?: string; symptom: string; note?: string; files: FormFile[] }`
  - `type FormPayload = { siteId: string; items: FormItem[]; preferredDays: string[] /* YYYY-MM-DD */; preferredSlot: 'morning'|'afternoon'|'all_day'|null; note?: string }`
  - `validateItem(item: FormItem): string[]` (Thai error messages; `[]` = ok)
  - `validateRepairForm(p: FormPayload, todayBangkok: string): string[]`
  - `preferredDayBounds(todayBangkok: string): { min: string; max: string }`
  - `itemsDescription(items: FormItem[]): string`, which builds the ticket `description` so old views and the LINE status card still show text

- [ ] **Step 1: Write the failing tests.** Cover each of these:
  - `validateItem` with no image → `['ต้องมีรูปอย่างน้อย 1 รูป']`
  - 6 images → contains `'รูปได้ไม่เกิน 5 รูป'`
  - 2 videos → contains `'วิดีโอได้ 1 คลิป'`
  - a video with `seconds: 31` → contains `'วิดีโอยาวได้ไม่เกิน 30 วินาที'`
  - `bytes: 50*1024*1024+1` → contains `'ไฟล์ใหญ่เกิน 50 MB'`
  - a location not in `LOCATIONS` → contains `'เลือกตำแหน่ง'`
  - a symptom not in `SYMPTOMS` → `'เลือกอาการ'`
  - `อื่นๆ` symptom with an empty note → `'อาการอื่นๆ กรุณาพิมพ์รายละเอียด'`
  - `validateRepairForm`:
    - 0 items → `'ยังไม่มีรายการ'`
    - 21 items → `'ได้ไม่เกิน 20 รายการ'`
    - today `2026-11-25` with day `2026-11-25` → `'เลือกวันตั้งแต่พรุ่งนี้'`
    - day `2027-01-25` (61 days) → `'เลือกได้ไม่เกิน 60 วัน'`
    - 4 days → `'เลือกได้ไม่เกิน 3 วัน'`
    - duplicate days → `'วันซ้ำกัน'`
    - days given with slot null → `'เลือกช่วงเวลา'`
    - no days and slot null → ok
    - item errors are prefixed `'รายการ 2: '`
  - `preferredDayBounds('2026-12-31')` → `{ min: '2027-01-01', max: '2027-03-01' }`
  - `itemsDescription`: two items → `'1. ห้องนอน (ห้องนอนใหญ่) — รั่วซึม: น้ำซึมตอนฝนตก\n2. ครัว — เปิดปิดยาก'`

- [ ] **Step 2: Run and see them fail.** Run `npx vitest run src/lib/repairForm.test.js`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `repair-form.ts`. Dates are plain `YYYY-MM-DD` strings; add days with UTC date math, with no Deno or supabase imports (vitest imports this file).
- [ ] **Step 4: Run again.** Expected: all PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(repair-form): validation rules shared by form page and function"`

### Task 2: Migration + RPC

**Files:**
- Create: `supabase/migrations/2026-11-25-01-repair-form.sql`
- Create: `supabase/migrations/2026-11-25-01-repair-form.dryrun.sql`

**Interfaces:**
- Produces the tables and columns listed in the spec, Phase 1:
  - **`repair_ticket_items`**
    - `id`, `tenant_id`, `ticket_id` (cascade), `seq int NOT NULL`
    - `location text NOT NULL`, `room`, `symptom text NOT NULL`, `note`
    - `result text CHECK (result IN ('fixed','partial','not_fixed'))`, `result_note`, `created_at`
    - `UNIQUE (ticket_id, seq)`
    - RLS select/insert/update/delete with the same admin policies as `repair_tickets`
  - **`repair_ticket_media.item_id uuid NULL REFERENCES repair_ticket_items(id) ON DELETE SET NULL`**, plus an index
  - **`repair_tickets`** gains:
    - `preferred_days date[]` with `CHECK (preferred_days IS NULL OR cardinality(preferred_days) <= 3)`
    - `preferred_slot text CHECK (preferred_slot IN ('morning','afternoon','all_day'))`
  - **`customer_link_tokens`**
    - `id`, `tenant_id NOT NULL`, `client_id NOT NULL → clients ON DELETE CASCADE`, `line_user_id text NOT NULL`
    - `purpose text NOT NULL CHECK (purpose IN ('repair_form','review'))`
    - `token text NOT NULL UNIQUE`, `ref_id uuid`, `expires_at timestamptz NOT NULL`, `used_at timestamptz`, `created_at`
    - RLS enabled; one `admin_reads` SELECT policy only
  - **`submit_repair_form(p_token text, p_payload jsonb) RETURNS jsonb`**, SECURITY DEFINER, `SET search_path = public`, granted to `service_role` only
    - Returns `{status:'ok', ticket_id, ticket_number}`, `{status:'already', ticket_number}`, or `{status:'invalid', reason}`.
    - Each `reason` is one of: `'expired'`, `'not_found'`, `'site'`, `'path'`, `'empty'`.

**RPC rules:**
- Lock the token row: `SELECT … FOR UPDATE`.
- If `used_at` is already set → `already`, with the ticket number from `ref_id`.
- If expired → `invalid/expired`.
- `site_id` must belong to the token's client and must not be Cancelled; otherwise `invalid/site`.
- Every media path must start with `<tenant_id>/form-<token_id>/`; otherwise `invalid/path`.
- Then insert the ticket:
  - `source 'line'`, `status 'pending_review'`, `client_id`, `line_user_id`
  - `description` = `p_payload->>'description'`, which the function fills from `itemsDescription`
  - the preferred days and slot
  - `created_by 'line-form'`
- Then insert the items with `seq` 1..n, and the media with `role 'customer'` and `item_id`.
- Finally set `used_at = now()` and `ref_id = ticket id`.

The bell count `repair_pending` already counts `pending_review`. Check that it needs no change.

- [ ] **Step 1: Write the migration**, copying the policy shape from `2026-10-20-11-repair-tickets.sql:106-120`. Also check whether any view selects `repair_tickets.*` or `repair_ticket_media.*` (`grep -rn "repair_tickets\b" supabase/migrations | grep -i view`). If one does, recreate it in this migration from its LIVE definition. Lesson: a view's `*` column list freezes when the view is created.
- [ ] **Step 2: Write the dry run.** It is `BEGIN;`, then the whole migration, then the cases below, then `ROLLBACK;`. Each case is a `DO $$ … ASSERT … $$`. Pick one real tenant, client, site and LINE user (controller supplies the ids), seed a token, then check:
  - (a) a valid payload with 2 items, 3 media → `ok`, 2 item rows, 3 media rows with `item_id` set, ticket `pending_review`, `description` set
  - (b) the same call again → `already` with the same ticket number, still exactly 1 ticket
  - (c) a fresh token with another client's site → `invalid/site`, 0 rows written
  - (d) a path under `<tenant>/form-<other-token>/` → `invalid/path`
  - (e) an expired token → `invalid/expired`
  - (f) as an `authenticated` admin (`SET LOCAL ROLE authenticated` + `request.jwt.claims`), `SELECT` and a real `UPDATE … SET result='fixed'` on `repair_ticket_items` succeed and return 1 row
  - (g) `anon` cannot `EXECUTE submit_repair_form`
- [ ] **Step 3: Controller runs the dry run** on CHANG. Expected: no ASSERT failure, ending in ROLLBACK.
- [ ] **Step 4: Commit** both files: `git commit -m "feat(db): repair_ticket_items, customer_link_tokens, submit_repair_form (not applied)"`. Apply later, in Task 7.

### Task 3: Edge-function logic + `customer-form` function

**Files:**
- Create: `supabase/functions/_shared/customer-form-logic.ts`
- Create: `supabase/functions/customer-form/index.ts`
- Test: `src/lib/customerForm.test.js`

**Interfaces:**
- Consumes from Task 1: `validateRepairForm`, `itemsDescription`, `LIMITS`, `preferredDayBounds`.
- Consumes from Task 2: the RPC `submit_repair_form`.
- Produces `handleCustomerForm(body: unknown, deps: CustomerFormDeps, now: number): Promise<{ status: number; body: object }>`, which dispatches on `body.action`:
  - **`info`** → `{ ok:true, clientName, brandName, sites:[{id,name}], bounds:{min,max}, locations, symptoms, limits, slots }`, or `{ reason }`.
    - `reason` is one of `'expired' | 'used' | 'not_found' | 'line_bot_disabled' | 'no_sites'`.
    - `used` also returns `ticketNumber`.
  - **`upload_url`** with `{ token, mediaType, mime, bytes }` → `{ path, signedUrl, uploadToken }`.
    - The path is `<tenant>/form-<tokenId>/<ms>-<rand6>.<ext>`.
    - The ext comes from the mime: `jpg` / `png` / `mp4` / `mov` / `webm`. Any other mime → 400 `bad_type`.
    - `bytes > LIMITS.maxBytes` → 400 `too_big`.
    - More than 120 upload URLs per token → 429 `too_many`.
  - **`submit`** with `{ token, payload }`:
    - Run `validateRepairForm`; errors → 400 `{ errors }`.
    - For every path, `deps.objectSize(path)` must be non-null and ≤ maxBytes; otherwise 400 `{ errors:['อัปโหลดรูปไม่สำเร็จ กรุณาลองใหม่'] }`.
    - Call the RPC with `description`, then `deps.pushReceived(lineUserId, ticketNumber)`. A push failure never fails the submit.
    - Return `{ ok:true, ticketNumber }`, or `{ ok:true, ticketNumber, already:true }`.
- `CustomerFormDeps`:
  - `loadToken(token) → {id, tenantId, clientId, lineUserId, purpose, expiresAt, usedAt, refTicketNumber} | null`
  - `hasModule(tenantId)`
  - `listSites(tenantId, clientId)`
  - `brand(tenantId) → {clientName, brandName}`
  - `countUploads(tokenId)`
  - `signUpload(path)`
  - `objectSize(path) → number | null`
  - `submitRpc(token, payload)`
  - `pushReceived(tenantId, lineUserId, ticketNumber)`

**Function shell (`index.ts`):**
- Follow `field-form/index.ts` for the CORS and `json()` helpers, the service-role client and the try/catch at the top.
- `signUpload` uses `admin.storage.from('repair-media').createSignedUploadUrl(path)`.
- `objectSize` uses `.list(dir, { search: file })` and reads `metadata.size`.
- `pushReceived` uses `pushToCustomer(customerPushDeps(admin), …)` with the single text `repairFormDoneText(ticketNumber)`, which this task adds to `_shared/repair.ts` with the exact text listed in Task 4. This push is budgeted and is skipped while `LINE_PUSH_ENABLED=false`. That is fine, because the done screen shows the number anyway.

- [ ] **Step 1: Write the failing tests** against `handleCustomerForm` with fake deps. Cover each of these:
  - `info` with an expired token → `{reason:'expired'}`
  - a used token → `{reason:'used', ticketNumber:'RP2611-007'}`
  - `hasModule` false → `line_bot_disabled`
  - 0 sites → `no_sites`
  - 1 site → `sites.length === 1`
  - `upload_url` with `image/heic` → 400 `bad_type`; the page always converts to JPEG first
  - `video/mp4`, 10 MB → path matches `/^t1\/form-tok1\/\d+-[a-z0-9]{6}\.mp4$/`
  - the 121st upload → 429
  - `submit` with a missing object (`objectSize` null) → 400 and `submitRpc` not called
  - RPC `already` → 200 with `already:true` and `pushReceived` not called (Review Focus 1)
  - RPC `invalid/site` → 400 `{errors:['ไซท์ไม่ถูกต้อง']}` (Review Focus 2)
  - `pushReceived` throws → still 200 ok
  - the payload sent to `submitRpc` includes `description === itemsDescription(items)`
- [ ] **Step 2: Run and see them fail.** Run `npx vitest run src/lib/customerForm.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** the logic module, then `index.ts` as a thin Deno shell around it.
- [ ] **Step 4: Run again.** Expected: PASS. Then run `deno check supabase/functions/customer-form/index.ts`. Expected: no errors.
- [ ] **Step 5: Commit.** `git commit -m "feat(customer-form): public repair form endpoint"`

### Task 4: LINE bot — แจ้งซ่อม gives the form link

**Files:**
- Modify: `supabase/functions/_shared/customer-line-handler.ts` (the `cmd === 'repair'` branch at ~line 144 of `handleCustomerEvent`, and the active-session branch at ~line 91)
- Modify: `supabase/functions/_shared/repair.ts`
- Modify: `supabase/functions/customer-line-webhook/index.ts` (deps object, near `startRepair` ~line 272)
- Test: `src/lib/customerLineHandler.test.js`, `src/lib/customerLineReplies.test.js`

**Interfaces:**
- New dep in `CustomerDeps`: `createRepairFormLink: (clientId: string, lineUserId: string) => Promise<{ url: string } | { throttled: true }>`.
  - It inserts a `customer_link_tokens` row with `purpose 'repair_form'`, a 24 h expiry and a token of `crypto.randomUUID()` with the dashes removed.
  - It is throttled at 6 links/hour per line user (count rows of the last hour).
- New exports in `repair.ts`:
  - `repairFormLinkFlex(url: string): LineMessage`. Its title is "แจ้งซ่อม", its body is "กรอกทีละรายการ ถ่ายรูป แล้วกดส่ง (ลิงก์ใช้ได้ 24 ชม.)", its uri button is "📝 เปิดฟอร์มแจ้งซ่อม", and `altText` is ≤ ALT_TEXT_MAX. It carries a quick reply item "แจ้งทางแชท".
  - (added in Task 3) `repairFormDoneText(ticketNumber)` → `รับเรื่องแจ้งซ่อมแล้ว เลขที่ ${ticketNumber} ทีมงานจะติดต่อกลับเพื่อนัดวันเข้าซ่อม`
  - `repairFormThrottledText()` → `ขอลิงก์บ่อยเกินไป กรุณาใช้ลิงก์ล่าสุดที่ส่งให้ไปแล้ว`
- New handler constant `CHAT_TEXT = 'แจ้งทางแชท'`.

**Behaviour:**
- `แจ้งซ่อม` with no active session:
  - no sites → the existing no-site reply, unchanged
  - otherwise → `[repairFormLinkFlex(url)]`, or the throttled text
- `แจ้งทางแชท` → what `แจ้งซ่อม` did before (`startOrPick`).
- During an active chat session, `แจ้งซ่อม` behaves as today (re-shows the session start).
- Redelivered events keep returning `[]`.

- [ ] **Step 1: Write the failing tests.** Add a `createRepairFormLink` mock to `deps()`. Cover each of these:
  - linked account with 2 sites + `แจ้งซ่อม` → one flex message whose uri equals the mocked url, and `startRepair` not called
  - `แจ้งทางแชท` → `listClientSites` then the pick-site reply (the old behaviour)
  - throttled → the throttled text
  - active session + `แจ้งซ่อม` → the session start reply, and `createRepairFormLink` not called
  - not linked → `notLinkedText`
  - `repairFormLinkFlex` altText length ≤ ALT_TEXT_MAX, and the uri starts with `https://`
  - Update any existing test that expected `แจ้งซ่อม` to start a chat session: it now sends `แจ้งทางแชท`.
- [ ] **Step 2: Run and see them fail.** Run `npx vitest run src/lib/customerLineHandler.test.js src/lib/customerLineReplies.test.js`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** the handler change, the reply builders and the webhook dep (using `APP_URL` from `_shared/app-url.ts`).
- [ ] **Step 4: Run the whole suite.** Run `npm test`. Expected: all PASS, including the old repair-chat tests.
- [ ] **Step 5: Commit.** `git commit -m "feat(customer-line): แจ้งซ่อม sends the repair form link, chat flow via แจ้งทางแชท"`

### Task 5: `/r/<token>` form page

**Files:**
- Create: `src/lib/repairFormState.js`, `src/RepairFormPage.jsx`
- Modify: `src/main.jsx` (add `repairFormMatch = /^\/r\/([^/]+)\/?$/` beside `fieldFormMatch`, lazy import, the same no-app-shell render)
- Test: `src/lib/repairFormState.test.js`, `src/RepairFormPage.test.jsx`

**Interfaces:**
- Consumes from Task 1: `validateItem`, `validateRepairForm`, `LIMITS`, `SLOTS`.
- Consumes from Task 3: the endpoint `${VITE_SUPABASE_URL}/functions/v1/customer-form` with the actions `info` / `upload_url` / `submit`. Follow how `FieldFormPage.jsx` calls `field-form`.
- Consumes `resizeToJpeg(file, 1600, 0.82)` from `src/lib/resizeImage.js`.
- Produces a reducer `repairFormReducer(state, action)`:
  - state: `{ step: 'site'|'item'|'list'|'confirm'|'done', siteId, items: FormItem[], draft: FormItem & { uploading: number }, editIndex: number|null, preferredDays: string[], preferredSlot, ticketNumber }`
  - actions: `pickSite`, `setDraft`, `fileUploaded`, `fileFailed`, `removeFile`, `confirmItem`, `editItem`, `deleteItem`, `addAnother`, `toConfirm`, `toggleDay`, `setSlot`, `submitted`
  - `initialFormState(info)` skips the `site` step when there is one site
- Also produces `loadDraft(token)` / `saveDraft(token, state)`. These use `localStorage` key `repair-form:<token>`, are wrapped in try/catch, and are never required.

**Screens** follow the mockup exactly:
- site → item (chips, room, note, 📷 ถ่ายรูป / 🎥 วิดีโอ / 🖼 เลือกจากเครื่อง) → list (table plus "+ เพิ่มรายการ") → confirm (summary, up to 3 days from `bounds`, slot chips, note) → done ("รับเรื่องแล้ว เลขที่ …").
- File inputs: camera `accept="image/*" capture="environment"`, video `accept="video/*" capture`, gallery `accept="image/*,video/*" multiple`.
- **Images.** `resizeToJpeg`; if it throws, upload the original file as long as its mime is jpeg or png. Otherwise show "ไฟล์รูปนี้เปิดไม่ได้ ลองถ่ายใหม่".
- **Videos.** Read the duration from a hidden `<video>` `loadedmetadata`. Reject anything over 30 s or 50 MB before uploading.
- **Uploading.** Each file → `upload_url` → `PUT`/`uploadToSignedUrl` → `fileUploaded` with the path.
- **Buttons.** "ยืนยันรายการนี้" is disabled while `validateItem` returns errors or `draft.uploading > 0`. "ส่งแจ้งซ่อม" is disabled while submitting.
- **Bad link.** The reasons `expired`, `used`, `line_bot_disabled` and `no_sites` show a full-page message:
  - expired: "ลิงก์หมดอายุ กดแจ้งซ่อมใน LINE อีกครั้ง"
  - used: "ส่งเรื่องนี้แล้ว เลขที่ …"
  - no_sites: "ยังไม่พบไซท์ของคุณ กรุณาติดต่อบริษัท"
- **Layout.** Phone-width first, 16 px gutter, no horizontal scroll.
- **No service worker cache.** Copy whatever `/f/` does to bypass the stale PWA (lesson 2026-10-18).

- [ ] **Step 1: Write the failing reducer tests.**
  - `initialFormState({sites:[s1]}).step === 'item'`; with 2 sites → `'site'`
  - `confirmItem` with no image is ignored (state unchanged)
  - `confirmItem` while `draft.uploading===1` is ignored
  - a valid confirm → `items.length===1`, `step==='list'`, empty draft
  - `editItem(0)` then `confirmItem` replaces index 0 rather than appending
  - `toggleDay` a 4th day is ignored
  - toggling the same day twice removes it
  - `saveDraft`/`loadDraft` round-trip; `loadDraft` returns null when `localStorage.getItem` throws (Review Focus 3)
- [ ] **Step 2: Write the failing page tests** (testing-library, mocked `fetch`; mirror `FieldFormPage.advance.test.jsx`):
  - info `expired` → shows "ลิงก์หมดอายุ"
  - one site → the first screen shows the location chips
  - a video file whose mocked duration is 31 → shows "วิดีโอยาวได้ไม่เกิน 30 วินาที" and makes no `upload_url` call (Review Focus 4)
  - a submit answered `{ok:true, ticketNumber:'RP2611-007'}` → the done screen shows `RP2611-007`
  - a submit answered `already:true` → the same done screen (Review Focus 1)
- [ ] **Step 3: Run and see them fail.** Run `npx vitest run src/lib/repairFormState.test.js src/RepairFormPage.test.jsx`. Expected: FAIL.
- [ ] **Step 4: Implement** the reducer, the page and the route.
- [ ] **Step 5: Run again.** Run `npm test`. Expected: all PASS.
- [ ] **Step 6: Commit.** `git commit -m "feat(repair-form): /r/<token> customer form page"`

### Task 6: Staff modal — item table + preferred days

**Files:**
- Modify: `src/components/RepairTicketModal.jsx`
- Test: `src/components/RepairTicketModal.test.jsx`

**Interfaces:**
- Consumes from Task 2: `repair_ticket_items`, `repair_ticket_media.item_id`, `repair_tickets.preferred_days` / `preferred_slot`.
- Consumes `SLOTS` from Task 1 (import it from `../../supabase/functions/_shared/repair-form.ts`).

**Behaviour:**
- **Loading.** Load the items (`order seq`) alongside the media. Add `item_id` to the media select.
- **Items exist.** Show the table "รายการแจ้งซ่อม" above the galleries:
  - columns: # / ตำแหน่ง (location + room) / อาการ (symptom + note) / รูปลูกค้า (thumbs of media with that `item_id`) / ผล
  - the ผล column is a select of `''` / `fixed` ซ่อมแล้ว / `partial` ซ่อมบางส่วน / `not_fixed` ซ่อมไม่ได้
  - the select is editable only when `status` is `in_progress` or `done` and `canEdit` is true
  - saving uses `.update().select()` and treats 0 returned rows as an error (lesson 2026-11-04: RLS can fail silently)
- **No items** (old chat tickets). Show nothing new; today's view stays as it is.
- **Preferred days.** When `preferred_days` is set, show "ลูกค้าสะดวก: <formatThaiDate each> · <SLOTS[slot]>" in the schedule section.
- **Schedule prefill.** When the ticket has no `scheduled_date` yet, prefill the date with `preferred_days[0]`. Prefill start with `13:00` when the slot is `afternoon`, otherwise keep the existing `'09:00'` default.
- **Galleries are unchanged.** The ก่อนซ่อม gallery still shows all customer media, including media that belongs to an item.

- [ ] **Step 1: Write the failing tests** (extend the existing Supabase mock in the test file):
  - a ticket with 2 items → the table shows `ห้องนอน (ห้องนอนใหญ่)` and `รั่วซึม`
  - status `pending_review` → the ผล select is absent or disabled
  - status `in_progress` and choosing `fixed` → the update is called with `{ result: 'fixed' }` on that item id
  - update returns `[]` → an error message is shown
  - `preferred_days ['2026-12-02','2026-12-04']`, slot `afternoon`, no scheduled_date → the date input is `2026-12-02`, start is `13:00`, and the text contains `2 ธ.ค. 2569`
  - a ticket without items → no "รายการแจ้งซ่อม" heading
- [ ] **Step 2: Run and see them fail.** Run `npx vitest run src/components/RepairTicketModal.test.jsx`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run again.** Run `npm test`. Expected: all PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(repairs): item table and customer preferred days in the ticket"`

### Task 7: Apply, deploy, live check (controller only)

**Files:**
- Modify: `package.json` (version), `src/changelog.json`, `public/manual/index.html` (#page-repairs: a new subsection "ฟอร์มแจ้งซ่อม" describing the steps and the "แจ้งทางแชท" fallback)

- [ ] **Step 1: Re-run the Task 2 dry run.** Expected: clean ROLLBACK. Then apply the migration with `apply_migration` and confirm the tables exist with `list_tables`.
- [ ] **Step 2: Deploy the functions** (follow the chang-ship skill):
  - deploy `customer-form` with `--no-verify-jwt`, because it is public, just like field-form
  - redeploy `customer-line-webhook`
- [ ] **Step 3: Release the web app.**
  - Check live `build-info.json` and bump the version above it.
  - Add the changelog entry and the manual section.
  - Warn the owner that a deploy is about to happen.
  - Then run `npm run build` and the deploy command.
  - Check live `build-info.json` shows the new version.
- [ ] **Step 4: Live walkthrough in Chrome** at phone width (dev server first, then live):
  - Generate a token with SQL for the demo tenant's linked test client and open `/r/<token>`.
  - Add 2 items with photos and 1 video, pick 2 days + บ่าย, and send. The done screen should show an RP number.
  - Open that ticket in งานซ่อม. Check the item table, the thumbs and "ลูกค้าสะดวก", and that the schedule date is prefilled.
  - Reopen the link. It should say "ส่งเรื่องนี้แล้ว เลขที่ …".
- [ ] **Step 5: Owner's real LINE test.** This needs `LINE_PUSH_ENABLED` on; see the memory note on the push master switch. The owner taps แจ้งซ่อม in @facadex, sends a form, and checks that "แจ้งทางแชท" still opens the old flow. Turn pushes back off afterwards if the owner wants.
- [ ] **Step 6: Commit and push.**
  - `git commit -m "chore(release): 1.39.x CRM phase 1 — LINE repair form"`
  - Push `feat/crm`. Do not merge to main until the CRM arc is done; see the memory note on branch merge timing.
  - Write a lessons note, as every job ends with one.

---

## Not in this plan (later phases)

- The work order PDF, the crew link and the quotation button (phase 2).
- Reviews (phase 3) and the review ↔ repair link (phase 4).
- Staff marking an item's after photo per item: phase 2 puts this on the work order. In phase 1 the after photos stay ticket-wide.
- Cleaning up orphan uploads from abandoned forms (`<tenant>/form-<token>/` with no media row). A small cron can come later. The volume is tiny and the bucket is private.
