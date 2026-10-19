# Site warranty + handover + follow-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- Each site carries a warranty period (default 12 months) and a handover date.
- Finishing a site records the handover.
- Staff get a reminder 30 days before a warranty ends, together with the retention amount to collect.
- The customer LINE bot answers "ประกันของฉัน" with real data.

**Architecture:**
- **Data:** three new `sites` columns, and a backfill of the already-Completed sites.
- **Shared date logic:** one pure warranty module, `supabase/functions/_shared/warranty.ts`. Both the web app (via vitest) and the webhook use it, so there is one rule for "end date" and "status".
- **SQL side:** the retention view and `pending_counts()` compute the same end with `handover_date + make_interval(months => warranty_months)`.

**Tech Stack:** React 18 + Vite, Supabase Postgres, Deno edge function `customer-line-webhook`, vitest.

**Spec:** `docs/superpowers/specs/2026-10-19-site-warranty-design.md` (parent: `docs/superpowers/specs/2026-10-19-customer-line-service-design.md`).

## Global Constraints
- **Copy:** all UI is Thai.
- **Dates:** shown as dd/mm/yyyy with a Gregorian year, like the rest of the app. "Today" is the Bangkok date.
- **Defaults and backfill:**
  - `warranty_months` defaults to **12**. Allowed range is 0–120; 0 means no warranty.
  - Backfill: Completed sites get `handover_date = end_date`, or **2025-10-14** when `end_date` is NULL.
- **Follow-up window:** 30 days before the warranty end, inclusive of today.
- **Retention:** the retention due date = the warranty end date. Hide "ระยะเวลา retention (วัน)" from the form, but do not drop the column.
- **No customer push.**
- **Migrations:**
  - Follow the RLS/function style of `2026-10-17-02-rls-initplan-wrap.sql`.
  - A view or function that is live gets **copied from the live definition**; the controller fetches it.
  - Views keep `WITH (security_invoker = true)`.
  - Every migration ships with a BEGIN … ROLLBACK dry run. The owner runs it in the SQL Editor if MCP rejects it.
- **Subagents** never call DB/MCP tools, never `git add -f`, never commit `.superpowers/`.
- **Run tests** from the worktree root: `npx vitest run <file>` and `npm test`.

## Review Focus
1. **Month-end dates:** handover 2026-01-31 + 1 month must give 2026-02-28 in BOTH the JS helper and SQL. If they disagree, the bell and the list will disagree. Tested in Task 2 (JS) and the Task 1 dry run (SQL).
2. **Editing the warranty or handover after a follow-up was marked must re-arm the reminder.** The `warranty_followup_at` reset is done by a trigger, so every edit path is covered. Tested in the Task 1 dry run.
3. **A site with `warranty_months = 0`** never appears in follow-ups, and the bot says it has no warranty instead of "ในประกัน ถึง <handover date>". Tested in Tasks 1, 2 and 6.
4. **Retention view rewrite must not change other columns.** The Retention page and the site overview read `site_retention_summary` with `select('*')`. Diff it against the live definition in Task 1.
5. **Finishing a site from either existing entry point** (the modal and the confirm dialog in `Sites.jsx`) must go through the same new dialog. Neither may silently skip the handover date. Checked in Task 4 review.

---

### Task 1: Migration — columns, backfill, retention due date, follow-up count

**Files:**
- Create: `supabase/migrations/2026-10-20-09-site-warranty.sql`
- Create: `supabase/tests/2026-10-20-09-site-warranty.dryrun.sql`

**Interfaces:**
- Produces:
  - `sites.warranty_months integer NOT NULL DEFAULT 12 CHECK (warranty_months BETWEEN 0 AND 120)`
  - `sites.handover_date date`
  - `sites.warranty_followup_at timestamptz`
  - The trigger `sites_warranty_followup_reset` (BEFORE UPDATE). It sets `NEW.warranty_followup_at := NULL` when `handover_date` or `warranty_months` changes.
  - `site_retention_summary.due_date = CASE WHEN s.handover_date IS NOT NULL AND s.warranty_months > 0 THEN (s.handover_date + make_interval(months => s.warranty_months))::date END`. Every other column stays identical to live.
  - `pending_counts()` gains the key `'warranty_followup'`: `CASE WHEN is_admin_or_owner() THEN (count of tenant sites WHERE status='Completed' AND handover_date IS NOT NULL AND warranty_months > 0 AND warranty_followup_at IS NULL AND (handover_date + make_interval(months => warranty_months))::date BETWEEN bkk_today AND bkk_today + 30) ELSE 0 END`, where `bkk_today = (now() AT TIME ZONE 'Asia/Bangkok')::date`.

- [ ] **Step 1: Controller fetches the live definitions** with `pg_get_viewdef('site_retention_summary'::regclass, true)` and `pg_get_functiondef('pending_counts'::regproc)`, and hands them over as files. The migration copies them verbatim and changes only `due_date` and the one added key. Use `CREATE OR REPLACE VIEW` with the same column list and order. If it cannot be replaced (column type change), DROP and recreate inside the migration with the same `security_invoker` and grants.
- [ ] **Step 2: Write the migration.** The backfill is two UPDATEs:
  - `UPDATE sites SET handover_date = end_date WHERE status='Completed' AND handover_date IS NULL AND end_date IS NOT NULL;`
  - `UPDATE sites SET handover_date = DATE '2025-10-14' WHERE status='Completed' AND handover_date IS NULL;`

  Create the trigger AFTER the backfill, so the backfill does not count as an edit. The trigger function uses `SET search_path = public` and is not SECURITY DEFINER.
- [ ] **Step 3: Write the dry run.** It is self-contained: `BEGIN;`, the migration body, the assertions, `SELECT 'ALL PASS'`, `ROLLBACK;`. It uses the demo tenant `8b61c890-0a90-4223-91d3-b5f8f4e89908` / `demo-owner@facadex.co.th` for JWT claims. Assertions:
  - (a) No Completed site has a NULL `handover_date` after the backfill.
  - (b) A temp site with handover 2026-01-31 and 1 month gets a `due_date` of 2026-02-28 in `site_retention_summary`.
  - (c) After setting `warranty_followup_at = now()` and then changing `warranty_months`, `warranty_followup_at` IS NULL.
  - (d) A temp Completed site whose end is today+10 makes `pending_counts()->>'warranty_followup'` go up by 1 for the owner. With `warranty_months=0` it does not count.
  - (e) The existing `pending_counts` keys are all still present.
- [ ] **Step 4: Controller has the dry run run.** Expected: ALL PASS. Commit `feat(db): site warranty, handover date, follow-up reminder count`.

### Task 2: Pure warranty module

**Files:**
- Create: `supabase/functions/_shared/warranty.ts`
- Test: `src/lib/warranty.test.js`

**Interfaces:**
- Produces:
  - `warrantyEnd(handoverDate: string|null, months: number): string|null`. It returns `YYYY-MM-DD`, or null when there is no handover or months ≤ 0. It uses calendar months clamped to the month's last day, the same as Postgres.
  - `warrantyStatus(handoverDate, months, today): { kind: 'not_handed_over'|'none'|'active'|'expired', end: string|null, daysLeft: number|null }`. `none` means months = 0. `active` means today ≤ end.
  - `followupDue(site: { status, handover_date, warranty_months, warranty_followup_at }, today): boolean`. It is true when the window is 30 days, as in the spec.

- [ ] **Step 1: Write the failing tests:**
  - `warrantyEnd('2026-01-31',1)==='2026-02-28'`
  - `warrantyEnd('2024-01-31',1)==='2024-02-29'`
  - `warrantyEnd('2025-10-14',12)==='2026-10-14'`
  - `warrantyEnd(null,12)===null`
  - `warrantyEnd('2025-10-14',0)===null`
  - `warrantyStatus('2025-10-14',12,'2026-10-14')` gives kind `active` and daysLeft 0.
  - `warrantyStatus('2025-10-14',12,'2026-10-15').kind==='expired'`
  - `warrantyStatus(null,12,'2026-10-19').kind==='not_handed_over'`
  - `warrantyStatus('2025-10-14',0,'2026-10-19').kind==='none'`
  - `followupDue` is true at 30 days left, false at 31, and false when `warranty_followup_at` is set or the status is not Completed.
- [ ] **Step 2: Run them.** They FAIL. Implement the module with no Deno imports and pure string/UTC-date math. Run them again; they PASS. Commit `feat: shared warranty date rules`.

### Task 3: Site form — warranty field, handover date, retention field removed

**Files:**
- Modify: `src/pages/Sites.jsx` (site form, around L29-100 for defaults and payload, around L270-400 for the fields)

**Interfaces:**
- Consumes: `warrantyEnd`, `warrantyStatus` (Task 2). Import them via `../../supabase/functions/_shared/warranty.ts`, using the pattern other `src` files use to import `_shared`. If Vite cannot import `.ts` from `src`, put a `src/lib/warranty.js` re-export.

- [ ] **Step 1:** Add `warranty_months: 12` to the empty form defaults, and include `warranty_months` (integer) and `handover_date` in the save payload.
- [ ] **Step 2:** Under the สถานะ / วันเริ่มต้น / วันจบงาน row, add a "การรับประกันผลงาน" block. It matches mockup board 8, file `/private/tmp/claude-501/-Users-plfx-code-FacadeXPM-facadex-app/e5c8bafe-afbe-4dfc-bbb4-099a64903baf/scratchpad/clmock/project/SiteWarranty.dc.html`. It contains:
  - "ระยะประกัน" as a number input with the unit "เดือน", plus chips 6/12/24/60.
  - When the status is Completed: a "วันส่งมอบ" date input, and the line "ประกันถึง dd/mm/yyyy" (or "ไม่มีประกัน" when months = 0).
  - When not Completed: the line "ประกันเริ่มนับเมื่อกด จบไซท์งาน".
- [ ] **Step 3:** Remove the "ระยะเวลา retention (วัน)" input and its label. Keep `default_retention_pct`. Stop sending `default_retention_period_days` in the payload.
- [ ] **Step 4:** Run `npm test && npm run build`, both green. Commit `feat(sites): warranty period and handover date on the site form`.

### Task 4: One "จบไซท์งาน" dialog for both entry points

**Files:**
- Create: `src/components/FinishSiteModal.jsx`
- Modify: `src/pages/Sites.jsx` (the existing finish modal around L480-530 and the `handleComplete` + ConfirmDialog around L640-670 and L960-966)

**Interfaces:**
- Produces: `<FinishSiteModal site={{ id, name, warranty_months }} onClose onDone />`.

- [ ] **Step 1:** Build it to match mockup board 9 (`.../clmock/project/FinishSite.dc.html`).
  - Inputs: วันส่งมอบงาน (default Bangkok today) and ระยะประกัน (prefilled from the site, editable).
  - It shows a live "ประกันถึง dd/mm/yyyy" from `warrantyEnd`.
  - The button reads "ยืนยันจบงานและส่งมอบ".
  - On save it runs one `update({ status: 'Completed', end_date: handover, handover_date: handover, warranty_months })`.
  - Errors use the house `alert('Error: ' + msg)` pattern.
- [ ] **Step 2:** Replace BOTH existing finish paths with this modal. The old modal component and the ConfirmDialog for completion are removed. Any extra content the old modal showed (read it first) is kept above the inputs.
- [ ] **Step 3:** Run `npm test && npm run build`, both green. Commit `feat(sites): finishing a site records handover and warranty`.

### Task 5: Warranty follow-up list + bell

**Files:**
- Create: `src/components/WarrantyFollowupCard.jsx`
- Modify: `src/pages/Sites.jsx` (render the card at the top of the list page when it has rows), `src/lib/pendingItems.js`
- Test: `src/lib/pendingItems.test.js`

**Interfaces:**
- Consumes: `followupDue`, `warrantyEnd` (Task 2); `site_retention_summary` (Task 1); `customer_line_accounts` (client_id → linked or not); `clients(name, phone)`.

- [ ] **Step 1:** Write a failing test: the `PENDING_ITEMS` entry `{ key: 'warranty_followup', label: 'ประกันใกล้หมด — ทักลูกค้า', icon: '🛡️' }` exists, with `tab` set to the Sites list tab key (find it in `src/lib/pendingItems.js` / App.jsx). Then add the entry and make the test pass.
- [ ] **Step 2:** Build the card to match mockup board 10 (`.../clmock/project/WarrantyReminder.dc.html`).
  - Load the tenant's Completed sites with `handover_date, warranty_months, warranty_followup_at, client_id, clients(name, phone)`, and filter them with `followupDue`.
  - Each row shows: site, client, "เชื่อม LINE แล้ว" or the phone, ส่งมอบ, ประกันถึง with "เหลือ N วัน", and the unreleased retention ("เรียกคืนเงินประกันผลงาน ฿X" from `site_retention_summary.total_retention` when `retention_released` is false and the total is > 0).
  - Each row also has a "คัดลอกข้อความ" button that copies `สวัสดีครับ ประกันงานของ {site} จะหมดวันที่ {dd/mm/yyyy} มีจุดไหนต้องการให้เข้าไปตรวจหรือแก้ไขไหมครับ`, plus a "ทักแล้ว" button that sets `warranty_followup_at = now()` and removes the row.
  - Show the card to admin/owner only.
- [ ] **Step 3:** Run `npm test && npm run build`, both green. Commit `feat(sites): warranty follow-up reminder list`.

### Task 6: Customer bot "ประกันของฉัน" with real data

**Files:**
- Modify: `supabase/functions/_shared/customer-line-replies.ts` (replace `warrantyTempText` with `warrantyText(sites, today)`), `supabase/functions/_shared/customer-line-handler.ts`, `supabase/functions/customer-line-webhook/index.ts` (loadSites also selects `handover_date, warranty_months`; `SiteStatus` gains `handoverDate: string|null`, `warrantyMonths: number`)
- Test: `src/lib/customerLineReplies.test.js`, `src/lib/customerLineHandler.test.js`

- [ ] **Step 1:** Write failing tests. The exact lines (Cancelled sites are skipped, as before; empty → `ยังไม่มีงานในระบบ`):
  - active: `บ้านคุณบิ๊ก: ในประกัน ถึง 19/10/2027`
  - expired: `คอนโด A: หมดประกันแล้ว (14/10/2026)`
  - not handed over: `บ้าน B: ยังไม่ส่งมอบงาน ประกันเริ่มนับจากวันส่งมอบ`
  - months 0: `บ้าน C: ไม่มีระยะประกัน`
- [ ] **Step 2:** Implement with `warrantyStatus` from `_shared/warranty.ts`, update the handler and webhook, and run the tests to PASS. Commit `feat(line): ประกันของฉัน shows the real warranty`.

### Task 7: Release prep (owner gates)

- [ ] **Step 1:** Re-check live `build-info.json` and `origin/main`, then bump to the next minor above live (expected **1.24.0**). Changelog (Thai):
  - "ตั้งระยะประกันผลงานได้ในหน้าแก้ไขไซท์ (ค่าเริ่มต้น 1 ปี)"
  - "กดจบไซท์งานแล้วบันทึกวันส่งมอบและวันหมดประกัน"
  - "แจ้งเตือนก่อนหมดประกัน 1 เดือน ให้ทักถามลูกค้า พร้อมยอดเงินประกันผลงานที่ต้องเรียกคืน"
  - "ลูกค้ากด ประกันของฉัน ในไลน์ เห็นวันหมดประกันจริง"

  Run `npm test && npm run build`. Commit.
- [ ] **Step 2:** Run the whole-branch review.
- [ ] **Step 3:** STOP and ask the owner, in order: apply -09 (via the SQL Editor if MCP rejects it), deploy `customer-line-webhook` (`--no-verify-jwt`), push to main, then `npm run deploy`. The owner runs the push and deploy commands if auto mode blocks them.
