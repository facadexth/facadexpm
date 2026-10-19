# Repair tickets (งานซ่อม) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- A customer reports a problem through the company's LINE OA, with text, photos, video or PDF.
- Staff review the report and run the repair from a new main tab, "🔧 งานซ่อม". The tab has a Kanban view, scheduling with crew assignment, and close-out with before/after photos.
- The customer is notified at each step by LINE: appointment, a reminder the day before at 13:00, and a report.
- The site's status never changes.

**Architecture:**
- New tables: `repair_tickets`, `repair_ticket_media`, `customer_line_repair_sessions`, plus the private bucket `repair-media`.
- Crew is assigned through ordinary `worker_assignments` rows on the ticket's site, with the new column `repair_ticket_id`. Check-in, payroll and labour cost are unchanged, and costs land on the original site.
- Customer pushes go through a new `_shared/customer-push.ts`. It uses the tenant OA token, a tenant switch, and its own daily budget. It is called by a new edge function, `repair-push` (staff actions plus a cron reminder).
- All texts and Flex JSON are pure `_shared` modules, tested by vitest.

**Tech Stack:** React 18 + Vite, Supabase (Postgres, Storage, pg_cron, Vault), Deno edge functions, vitest.

**Spec:** `docs/superpowers/specs/2026-10-20-repair-tickets-design.md` (parent: `2026-10-19-customer-line-service-design.md`). Mockup boards 12–15: https://claude.ai/artifact/KUmuM4Env22zgk7ypm6c5u.

## Global Constraints
- **UI and copy:** all UI is Thai. Dates are dd/mm/พ.ศ., formatted with `formatThaiDate` from `supabase/functions/_shared/thai-date.ts` (`src/lib/thaiDate.js` in the app). "Today" is the Bangkok date.
- **Statuses:** `pending_review → received → scheduled → in_progress → done`, plus `declined`. Thai labels: รอพิจารณา / รับเรื่อง / นัดเข้า / กำลังซ่อม / เสร็จ / ไม่รับ.
- **Customer report window:** the 30-minute session window, closed early by the quick reply "ส่งครบแล้ว". "ยกเลิก" discards the session's ticket and its media.
- **Reminder:** pg_cron `0 6 * * *` UTC, which is 13:00 Bangkok. It reminds about tickets scheduled for tomorrow (Bangkok).
- **Customer push:**
  - Only when the tenant setting `customer_line_push_enabled` is not `'false'` (default ON).
  - Within the budget `consume_customer_push(p_tenant)`: 100 per Bangkok day per tenant.
  - Never through the crew `LINE_PUSH_ENABLED`.
  - Pushes are sent only to the ticket's `line_user_id`. A staff-created ticket has no `line_user_id`, so it gets no push unless the client has a linked LINE account. In that case use `customer_line_accounts.line_user_id` for the ticket's client.
- **Never shown to the customer:** costs, workers' names or internal notes. The report holds the description, fix note, dates and photos only.
- **Tenant scoping:**
  - Every service-role query filters on `tenant_id`.
  - The RP number generator filters `tenant_id = NEW.tenant_id` explicitly.
  - RLS on the new tables is admin/owner, read and write, own tenant.
  - Storage `repair-media` follows the same pattern as the `site-attachments` policy (`site_attachments_tenant_access`): first folder = `current_tenant_id()`.
- **Migrations** copy any live function verbatim. The controller provides live definitions; `pending_counts` gets one new key only. Every migration ships with a BEGIN…ROLLBACK dry-run.
- **Subagents** never call DB/MCP tools, never `git add -f`, and never commit `.superpowers/`.
- **Do not touch** `supabase/functions/line-webhook/` (crew bot) or `_shared/line.ts`.
- **Webhook resilience:** the customer webhook must keep returning 200 and must never leak tokens or user ids into logs.

## Review Focus
1. **Customer sends media without being in a repair session.** Image, video or file outside a session → no reply, nothing stored, no error. A linked customer sending a photo while chatting with staff must not create tickets. Tested in Task 3.
2. **Two sessions, or a session for a site of another client.** The session's ticket must belong to the account's client and tenant. The site-pick reply must only offer that client's sites. Tested in Task 3.
3. **Push guards.**
   - Notify-schedule twice (staff re-saves the date) → one push per save. Each save of a changed date re-notifies, and `notified_schedule_at` updates.
   - The reminder must send at most once (`reminded_at`).
   - The report must send at most once (`reported_at`).
   - Tested in Task 4.
4. **Crew assignment collisions.** `worker_assignments` is unique on `(worker_id, date, shift)`. Assigning a worker who already has an assignment that shift must fail with a clear Thai message, not overwrite the existing work. Tested in Task 6 (pure planner) and the Task 1 dry-run.
5. **Large video.** LINE content can be tens of MB. Store it streaming or as a single upload. Cap at 50 MB: above the cap, skip the file and reply once "ไฟล์ใหญ่เกินไป ส่งทางแชทให้เจ้าหน้าที่แทนได้ครับ". The cap is unit-tested via the pure size check in Task 2.

---

### Task 1: Migration — tables, bucket, numbering, assignments link, bell key, push budget
**Files:**
- `supabase/migrations/2026-10-20-11-repair-tickets.sql`
- `supabase/tests/2026-10-20-11-repair-tickets.dryrun.sql`

**Interfaces (Produces):**

The tables from the spec, with these details:
- `repair_tickets.status` CHECK.
- `ticket_number` unique per `(tenant_id, ticket_number)`. A BEFORE INSERT trigger `generate_repair_ticket_number()` produces `RP{YYMM}-{nnn}` using Bangkok `now()`, scoped by `tenant_id`.
- `updated_at` trigger.
- Indexes on `(tenant_id, status)` and `(tenant_id, site_id)`.

The other objects:
- `repair_ticket_media` (FK → `repair_tickets` ON DELETE CASCADE).
- `customer_line_repair_sessions`: PK `(tenant_id, line_user_id)`, FK `ticket_id` ON DELETE CASCADE, `expires_at timestamptz NOT NULL`.
- `worker_assignments.repair_ticket_id uuid NULL` REFERENCES `repair_tickets` ON DELETE SET NULL.
- Storage bucket `repair-media` (private), with a tenant-folder policy cloned from `site_attachments_tenant_access`. The controller supplies its live definition.
- `pending_counts()`: the live copy plus `'repair_pending', CASE WHEN is_admin_or_owner() THEN (count of repair_tickets WHERE tenant_id = current_tenant_id() AND status='pending_review') ELSE 0 END`.
- `customer_push_log(tenant_id, day date, n int, PK(tenant_id, day))`.
- `consume_customer_push(p_tenant uuid) RETURNS boolean`: SECURITY DEFINER, service_role only. It increments when under 100 and returns true. Atomic, using the same ON CONFLICT pattern as `claim_customer_welcome`.
- RLS: `repair_tickets` and `repair_ticket_media` get admin/owner ALL in their own tenant. Sessions and the push log are REVOKE ALL, with no policies.

Steps:
- [ ] **Step 1:** Controller provides the live `pending_counts` and the `site_attachments_tenant_access` policy SQL (in the SDD workspace).
- [ ] **Step 2:** Write the migration and a self-contained dry-run (demo tenant `8b61c890-…`, `demo-owner@facadex.co.th`). Assertions:
  - (a) two inserts in one tenant give consecutive RP numbers, and another tenant starts at 001;
  - (b) a bad status is rejected;
  - (c) `pending_counts()->>'repair_pending'` counts for the owner, and every existing key is still present;
  - (d) `consume_customer_push` is true 100 times, then false;
  - (e) authenticated cannot read `customer_line_repair_sessions` or `customer_push_log`;
  - (f) the assignment link column exists, and deleting the ticket sets it to null;
  - (g) a second tenant's owner cannot see the first tenant's ticket.
- [ ] **Step 3:** Controller dry-runs it. Commit `feat(db): repair tickets, media, sessions, push budget`.

### Task 2: Pure repair module (texts, Flex, rules)
**Files:**
- `supabase/functions/_shared/repair.ts`
- Test: `src/lib/repair.test.js`

**Produces:**
- `REPAIR_STATUS` labels and `REPAIR_STEPS = ['received','scheduled','in_progress','done']`.
- `canMove(from, to): boolean`. Allowed moves:
  - pending_review→received|declined
  - received→scheduled|declined
  - scheduled→in_progress|received
  - in_progress→done|scheduled
  - done→in_progress (reopen)
  - Everything else is false.
- `stepIndex(status): number`.
- Texts, as exact Thai strings asserted in the tests:
  - `repairStartText(siteName)` = `แจ้งปัญหาของงาน ${siteName} ได้เลยครับ 🙏\nพิมพ์อาการ และส่งรูป / วิดีโอ / PDF ได้หลายอย่าง\nส่งครบแล้วกด "ส่งครบแล้ว" (หรือรอ 30 นาที ระบบจะรวมให้เอง)`, sent with quick replies `ส่งครบแล้ว` and `ยกเลิก`.
  - `repairPickSiteText()` = `แจ้งซ่อมงานไหนครับ?`, sent with quick replies of up to 13 site names.
  - `repairReceivedText(ticketNumber, siteName, counts)` = `รับเรื่องแล้วครับ เลขที่ ${n}\n${site} · ข้อความ ${t} · รูป ${i} · วิดีโอ ${v} · PDF ${f}\nเจ้าหน้าที่จะตรวจสอบและแจ้งนัดหมายกลับในแชทนี้\nติดตามได้ที่ "สถานะแจ้งซ่อม"`. Omit the zero counts.
  - `repairCancelledText()` = `ยกเลิกการแจ้งซ่อมแล้วครับ`.
  - `repairTooBigText()` = `ไฟล์ใหญ่เกินไป ส่งทางแชทให้เจ้าหน้าที่แทนได้ครับ`.
  - `repairNoTicketsText()` = `ยังไม่มีรายการแจ้งซ่อมครับ หากพบปัญหา กด "แจ้งซ่อม" ได้ตลอด`.
  - `scheduleText(t)` = `📅 นัดเข้าซ่อม ${n}\n${site}\n${วัน} ${dd/mm/พ.ศ.} ${HH:MM}–${end} (ประมาณ ${h} ชม.)\nหากไม่สะดวก ตอบกลับในแชทนี้ได้เลยครับ`. The Thai short weekday is computed from the date.
  - `reminderText(t)` = `🔔 พรุ่งนี้ ทีมช่างจะเข้าซ่อมที่ ${site}\n${วัน} ${date} · ${start}–${end}\nรบกวนเตรียมพื้นที่หน้างานให้ด้วยนะครับ 🙏`.
- `repairStatusFlex(tickets, today)`: a carousel with at most 10 bubbles, open tickets first, then tickets done in the last 30 days.
  - Each bubble has:
    - a header colour per status: received `#B7791F`, scheduled `#2B6CB0`, in_progress `#6B46C1`, done `#2F6B3F`;
    - a 4-dot stepper;
    - the appointment box, if scheduled;
    - the warranty line, from `warrantyStatus`: "อยู่ในประกัน · ไม่มีค่าใช้จ่าย" or "นอกระยะประกัน · เจ้าหน้าที่จะแจ้งค่าใช้จ่าย";
    - a button "ติดต่อเรา / ขอเลื่อนนัด" that sends the message `ติดต่อเรา`.
  - altText = a plain summary, at most 400 codepoints.
- `repairReportFlex(t, beforeUrls, afterUrls, warrantyEnd)`: a green header "ซ่อมเสร็จเรียบร้อย ✓". The body has ปัญหา and แก้ไข, a 2-column image row (the first before image and the first after image, labelled ก่อน/หลัง; a missing side is omitted), the repair date, and "ประกันยังเหลือถึง". The footer has "ยังพบปัญหา? แจ้งซ่อม", which sends `แจ้งซ่อม`.
- `mediaTooBig(bytes): boolean`, true above 50 MB.

Steps:
- [ ] **Step 1:** Write the failing tests: every exact text, `canMove` truth-table rows, step indices, Flex walkers (no empty text, valid sizes, ≤ 10 bubbles, altText ≤ 400), and `mediaTooBig` at the boundary.
- [ ] **Step 2:** Implement until they pass. Commit `feat(line): repair texts, flex cards and status rules`.

### Task 3: Customer bot intake + สถานะแจ้งซ่อม
**Files:**
- Modify `supabase/functions/_shared/customer-line-handler.ts` and `supabase/functions/customer-line-webhook/index.ts`
- Tests: `src/lib/customerLineHandler.test.js`

**Interfaces:**
- New deps:
  - `getRepairSession(uid) → {ticketId, siteName, expiresAt} | null`
  - `listClientSites(clientId) → {id, name}[]`: the client's non-Cancelled sites
  - `startRepair(clientId, siteId, uid, displayName) → {ticketId, siteName}`: creates the ticket with `pending_review`, source `line`, and the session expiring now+30 min
  - `appendRepairText(ticketId, text)`
  - `storeRepairMedia(ticketId, messageId, mediaType, fileName?) → 'ok'|'too_big'|'error'`
  - `finishRepair(uid) → {ticketNumber, siteName, counts} | null`: deletes the session
  - `cancelRepair(uid)`: deletes the session's ticket (its media cascades) and its storage objects
  - `listRepairTickets(clientId) → ticket rows + site names + warranty fields`
- Remove the old `openRequest('repair')` path and `repairTempText`/`repairStatusTempText`. Quote requests keep `openRequest('quote')`.

**Handler behaviour (linked accounts only; unlinked users keep `notLinkedText`):**
- **แจ้งซ่อม:**
  - If the client has more than one site and no `postback`/text site choice, reply with `repairPickSiteText` and quick replies. Each quick reply is the text `แจ้งซ่อม:<site name>`, and the handler parses it.
  - If the client has exactly one site, start immediately.
  - Starting replies with `repairStartText(siteName)`.
- **While a session is active** (`expires_at > now`):
  - "ส่งครบแล้ว" → finish and reply `repairReceivedText`.
  - "ยกเลิก" → cancel and reply `repairCancelledText`.
  - Menu commands interrupt the session: the session stays open and the command is answered.
  - Any other text → `appendRepairText`, with no reply.
  - Image, video or file → `storeRepairMedia`, with no reply, except `too_big`, which replies `repairTooBigText` once per message.
- **Expired session** + any message → treat as no session. The ticket stays `pending_review` with whatever arrived. Finish lazily: the next start or a 'ส่งครบแล้ว' text after expiry just deletes the stale session.
- **สถานะแจ้งซ่อม** → `[repairStatusFlex(...)]`, or the text `repairNoTicketsText` when there are no tickets.

**Webhook:**
- Download media from `https://api-data.line.me/v2/bot/message/{id}/content` with the tenant token.
- Check the `content-length` header before reading. Above 50 MB, return `too_big` without downloading.
- Upload to `repair-media/{tenant}/{ticket}/{ts}-{messageId}.{ext}` with the response content-type. ext comes from the mime type, or the file name for files.
- Insert a `repair_ticket_media` row with role `customer`.
- Every query filters on tenant.

Steps:
- [ ] **Step 1:** Write failing handler tests:
  - pick-site flow (2 sites → quick replies; parse `แจ้งซ่อม:<name>`; reject a name that is not the client's site, which re-asks);
  - single-site start;
  - text appended with no reply;
  - image stored with no reply;
  - too big → reply;
  - ส่งครบแล้ว → summary;
  - ยกเลิก;
  - a menu command during the session answers normally;
  - media with no session → `[]` and no store call (Review Focus 1);
  - unlinked แจ้งซ่อม → `notLinkedText`;
  - สถานะแจ้งซ่อม with tickets → flex, and none → text.
- [ ] **Step 2:** Implement the handler and the webhook deps.
- [ ] **Step 3:** Run `npm test && npm run build`. Commit `feat(line): customers report repairs with photos, video and files`.

### Task 4: Customer push + `repair-push` edge function + reminder cron
**Files:**
- `supabase/functions/_shared/customer-push.ts` + test `src/lib/customerPush.test.js`
- `supabase/functions/repair-push/index.ts`
- Migration `supabase/migrations/2026-10-20-12-repair-reminder-cron.sql`: the cron schedule, applied after the function is deployed

**Produces:**
- `pushToCustomer(deps, tenantId, to, messages) → {sent:boolean, skipped?: 'off'|'budget'|'no_recipient'|'error', status?}`. The order is: check the setting, then `consume_customer_push`, then POST `https://api.line.me/v2/bot/message/push` with the tenant token. Deps are injected for tests.
- `repair-push` (JWT, OWNER/ADMIN) takes `POST {action:'schedule'|'report', ticket_id}`. It loads the ticket in the caller's tenant, resolves the recipient (`line_user_id`, else the client's linked account), builds `scheduleText`/`repairReportFlex`, pushes, and sets `notified_schedule_at`/`reported_at`. Report: refuse if `reported_at` is already set, unless `{force:true}`.
- `repair-push` cron mode: `x-cron-secret` (`verify_cron_secret`) and `{action:'reminders'}`. For each tenant, it takes tickets with `status='scheduled'`, `scheduled_date` = Bangkok tomorrow and `reminded_at IS NULL`, pushes `reminderText`, then sets `reminded_at`.
- Cron: `cron.schedule('repair-reminders', '0 6 * * *', net.http_post(...CHANG URL https://kntspldhvcjeaubtqtkn.supabase.co/functions/v1/repair-push, the vault auth key + shared secret, body {"action":"reminders"}))`. Copy the header pattern from `supabase/region-migration/create-cron-vault-chang.sql`.

Steps:
- [ ] **Step 1:** Write failing tests for `pushToCustomer`:
  - off → skipped `off` with no budget call;
  - budget false → `budget` with no send;
  - no recipient → `no_recipient`;
  - send ok;
  - send 4xx → `error` with the status;
  - the token is never in the returned object.
- [ ] **Step 2:** Implement; write the function (it has no unit test, so read it carefully) and the cron migration with a dry-run that only asserts the job row exists inside a rollback.
- [ ] **Step 3:** Commit `feat(line): repair notifications to customers (schedule, reminder at 13:00, report)`.

### Task 5: Main tab "🔧 งานซ่อม" + Kanban board + bell
**Files:**
- `src/pages/Repairs.jsx`
- Modify `src/App.jsx` (TABS: a top-level `{ id:'repairs', label:'🔧 งานซ่อม', minRole:'ADMIN', module:'line_bot' }`, placed after ไซท์งาน, plus the renderPage case)
- Modify `src/lib/permissions.js` (PAGE_LABELS and DEFAULT_PERMISSIONS for `repairs`, following the existing keys)
- Modify `src/lib/pendingItems.js` (`{ key:'repair_pending', icon:'🔧', label:'งานซ่อมรอพิจารณา', tab:'repairs' }`, with a test)

**Behaviour:** match mockup board 14, file `/private/tmp/claude-501/-Users-plfx-code-FacadeXPM-facadex-app/e5c8bafe-afbe-4dfc-bbb4-099a64903baf/scratchpad/clmock/project/RepairBoard.dc.html`.
- Five columns: รอพิจารณา, รับเรื่อง, นัดเข้า, กำลังซ่อม, เสร็จ (done in the last 60 days). A filter shows ไม่รับ.
- Each card shows:
  - the site, the description (2 lines), and the warranty badge from `warrantyStatus`;
  - up to 3 media thumbnails (signed URLs; video and file shown as icons);
  - source and age;
  - for scheduled tickets, the appointment and crew count, plus "✓ แจ้งลูกค้าแล้ว".
- รอพิจารณา cards have the buttons "เปิดงานซ่อม" (→ received) and "ไม่รับ" (→ declined after a confirm).
- Native HTML5 drag-and-drop between columns, allowed only when `canMove` permits it. Dropping onto นัดเข้า opens the detail modal (Task 6) instead of moving.
- Clicking a card opens the detail modal.
- Filter chips: ในประกัน / หมดประกัน. A "+ เปิดงานซ่อมเอง" button.

Steps:
- [ ] **Step 1:** Write a pure board helper `groupTickets(tickets, today)` (with a test) and the PENDING_ITEMS test.
- [ ] **Step 2:** Build the page. Run `npm test && npm run build`. Commit `feat(repairs): main tab with a Kanban of all repair tickets`.

### Task 6: Ticket detail — schedule with crew, close with before/after, create by staff
**Files:**
- `src/components/RepairTicketModal.jsx`
- `src/components/NewRepairTicketModal.jsx`
- `src/lib/repairAssign.js` + test

**Produces:**
- `planRepairAssignments({ workerIds, date, start, durationHours, existing }) → { rows, conflicts }`.
  - Shift is morning when start < 12:00, evening otherwise.
  - Add the second shift when the window crosses 12:00 (start < 12 and start + duration > 12).
  - `existing` holds the workers' current assignments that day. Any `(worker, date, shift)` already taken goes into `conflicts`, never into `rows`.

**Modal:** match board 15, file `.../clmock/project/RepairCard.dc.html`.
- Header: ticket number, site, warranty badge, "สถานะไซท์: Completed (ไม่เปลี่ยน)", and a status pill row.
- **Customer section:** description and the media gallery (images via lightbox, video `<video controls>`, files as download links).
- **Schedule section:** date, start time, duration (hours), and workers (multi-select of active workers), plus the checkbox "ส่งไลน์แจ้งนัดให้ลูกค้าเมื่อบันทึก + เตือนก่อน 1 วัน (13:00)", default on.
  - Save: compute the plan.
    - If there are conflicts → alert listing the names, and save nothing.
    - Otherwise:
      1. delete this ticket's previous future assignments (`repair_ticket_id = id AND date >= today`);
      2. insert rows with `type 'site'`, `site_id`, `repair_ticket_id`, and notes `งานซ่อม RPxxxx`;
      3. update the ticket: status `scheduled`, the schedule fields, `reminded_at = null` if the date changed;
      4. if the box is ticked, call `repair-push {action:'schedule'}`.
- **Close section:** before/after uploads (images, compressed with the existing `photoUpload` helpers, to `repair-media/{tenant}/{ticket}/…` with role before/after), the fix note, and "ปิดงาน (เสร็จ) + ส่งรายงาน".
  - It requires at least one after photo.
  - It sets status `done` and `done_at`, then calls `repair-push {action:'report'}`.
- Buttons for the in-between status moves (`canMove`).
- **NewRepairTicketModal:** pick a site (any non-Cancelled site), description, optional photos. It creates `received`, source `staff`.
- Errors use the house alert. Every write filters on tenant through RLS.

Steps:
- [ ] **Step 1:** Write failing `planRepairAssignments` tests:
  - morning only;
  - evening only;
  - crossing noon → both shifts;
  - a conflict listed and excluded;
  - multiple workers.
- [ ] **Step 2:** Build both modals. Run `npm test && npm run build`. Commit `feat(repairs): schedule crew, close with before/after photos, staff-created tickets`.

### Task 7: Unblock crew paths + settings switch + docs
**Files:**
- `supabase/functions/field-form/index.ts`: in the material-request site list (around L253), also include sites with a ticket `scheduled`/`in_progress` whose `scheduled_date` is today.
- `src/pages/Assign.jsx`: show repair-linked assignments with a "🔧" marker. Do not make Completed sites selectable.
- `src/components/CustomerLineSettings.jsx`: the switch "ส่งไลน์แจ้งลูกค้าอัตโนมัติ (นัดซ่อม / เตือนก่อน 1 วัน / รายงานซ่อมเสร็จ)", stored in `app_settings` key `customer_line_push_enabled`, default on, via `saveAppSetting`.
- `docs/line/customer-richmenu.md`: describe แจ้งซ่อม and สถานะแจ้งซ่อม.

Steps:
- [ ] **Step 1:** Implement. Extract the field-form site list logic into a pure helper with a test if practical. Run `npm test && npm run build`. Commit.

### Task 8: Release prep (owner gates)
- [ ] **Step 1:** Re-check the live version, then bump to 1.25.0. Changelog in Thai:
  - "แท็บใหม่ 🔧 งานซ่อม รวมงานซ่อมทุกไซท์ (ไซท์ยังเป็น Completed)"
  - "ลูกค้าแจ้งซ่อมทางไลน์ ส่งรูป วิดีโอ PDF ได้ เก็บใน CHANG"
  - "นัดซ่อม จ่ายงานช่าง แจ้งลูกค้าทางไลน์ และเตือนก่อน 1 วัน (13:00)"
  - "ปิดงานซ่อมพร้อมรูปก่อน–หลัง ส่งรายงานให้ลูกค้า"
- [ ] **Step 2:** Whole-branch review.
- [ ] **Step 3:** Owner gates, in this order:
  1. apply -11;
  2. deploy `customer-line-webhook` + `repair-push` (JWT on) + `field-form`;
  3. apply -12 (cron);
  4. push to main + `npm run deploy`.
