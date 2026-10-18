# LINE Salary Advance Request Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A linked worker types "เบิกเงิน" to the CHANG LINE bot in a 1:1 chat. The bot replies with a one-time form. Submitting it creates a pending `salary_advances` row. The owner approves it in HR → เบิกล่วงหน้า, seeing the worker's outstanding balance, salary, and remaining limit, and can edit the amount, installments and start month. The worker types "ยอดเบิก" and gets a free reply with their status.

**Architecture:**
- Pure rules live twice, under one parity test:
  - `src/lib/payroll/advanceRules.js` for the app.
  - `supabase/functions/_shared/advance-logic.ts` for the edge functions (matching, summary, limit, start month, reply text).
- Edge function changes:
  - `line-webhook` routes the two new DM commands.
  - `field-form` serves and accepts the `advance` form.
- One migration adds:
  - the `advance` token type and command keys;
  - columns that keep the original requested amount and installments;
  - an owner-only "approve with changes" RPC;
  - an `advances_pending` bell count.
- AdvancesPanel gains a pending-cards section and an approve editor.

**Tech Stack:** React 18 + Vite, Supabase Postgres (RLS, plpgsql SECURITY DEFINER), Deno edge functions, vitest.

**Spec:** `docs/superpowers/specs/2026-10-17-line-advance-request-design.md`

## Global Constraints

- No LINE push of any kind (`LINE_PUSH_ENABLED=false` stays). Use replies (`sendLineReply`) and Web Push only.
- The advance commands work in the **1:1 DM only**. In a group, "เบิกเงิน" phrases get one fixed reply, `ขอเบิกเงินทางแชตส่วนตัวกับบอทนะครับ`, and never open a material form.
- Tenant and worker always come from the linked LINE user or the token, never from the request body.
- Eligibility:
  - LINE linked;
  - `workers.status='active'`;
  - the tenant has module `payroll`.
  Otherwise the reply is `ยังขอเบิกเงินผ่าน LINE ไม่ได้ ติดต่อแอดมินครับ`.
- Worker form installments: integers 1–6, default 1. Owner editor installments: 1–60.
- Limit: `ยังเบิกได้อีก = เงินเดือน − ยอดคืนคงเหลือ − รออนุมัติอื่น`.
  - เงินเดือน = `monthly_salary`, or `daily_wage × 30` when `pay_type='daily'`.
  - ยอดคืนคงเหลือ = Σ(amount − closed-period deductions) over approved advances.
  - รออนุมัติอื่น = Σ amount of the worker's other pending requests.
  - Going over the limit is allowed. It shows a red warning.
- Default start month: the first month, starting from the current Bangkok month, whose `payroll_periods` row is missing or `draft`.
- PM never sees any of this: tab gating `canSeeMoney` / `showSalary`, the Web Push audience `'money'`, and the `pending_counts` value set to 0 unless `is_admin_or_owner()`.
- Thai copy is short and plain. `requested_by` for LINE requests = `'line:' || worker_id`.
- Subagents do not call DB tools. Every migration ships with a BEGIN…ROLLBACK dry-run script the controller runs. Apply and deploy need the owner's go.
- Deploy follows the owner's checklist:
  - read `https://changpm.app/build-info.json`;
  - merge the live commit;
  - set a version above live, with a changelog entry;
  - ask.
  Edge functions: `line-webhook` with `--no-verify-jwt`, `field-form` with `--no-verify-jwt`.

## Review Focus

1. "ขอเบิกเงิน" / "อยากเบิกเงิน" route to the advance flow, and "ขอเบิกปูน" / "เบิกของ" still route to the material request. A wrong route sends the worker the wrong form. → Task 2 matcher tests.
2. Amount typed as "5,000", "5000.50", "0", "-1", "abc", or above 1,000,000. Commas are accepted, 2 decimals are kept, and the rest are rejected with a Thai message. → Task 2 `parseAdvanceAmount` tests, used by Task 4 and Task 5.
3. The current month is already confirmed when the worker submits, so the start becomes next month. A December request rolls the year over. → Task 2 `defaultStartMonth` tests.
4. The owner picks a start month that is confirmed or closed. The RPC refuses with `เดือนที่เริ่มหักยืนยันหรือปิดงวดแล้ว เลือกเดือนถัดไป`. → Task 1 dry-run check.
5. A worker with no salary set (0 or null): the limit shows 0, the request shows red, nothing crashes. A daily worker uses `daily_wage × 30`. → Task 2 `advanceLimit` tests.

---

### Addendum (2026-10-18): rich menu "ยื่นคำขอ" / "สถานะคำขอ"

This addendum changes the tasks below. Spec section: "Rich menu".

- **Task 1:** the `command_key` CHECK also accepts `'request_menu'` and `'request_status'`.
- **Task 2:**
  - `ADVANCE_PHRASES` gains `request_menu: ['ยื่นคำขอ']` and `request_status: ['สถานะคำขอ']`.
  - `matchAdvanceAction` returns these two keys as well. Check order: `request_status`, `advance_status`, `request_menu`, `advance_request`.
  - Add `formatRequestStatusReply({leave: {recent: [{type, from, to, status}], personalLeft, sickLeft}, advances: summary}, fmt) → string`. Its text has a 🏖️ การลา section and a 💸 เบิกเงิน section.
  - Tests:
    - "สถานะคำขอ" → `request_status`;
    - "ยื่นคำขอ" → `request_menu`;
    - the leave section shows `ลากิจคงเหลือ 4 วัน · ลาป่วยคงเหลือ 28 วัน`;
    - with no leave and no advances the reply is `ยังไม่มีคำขอครับ`.
- **Task 3:**
  - `request_menu` replies `เลือกคำขอที่ต้องการครับ` with quick-reply chips (the `sendLineReply` quickReplyItems): `🏖️ ขอลา`→text `ขอลา`, `📦 เบิกของ`→`ขอเบิกของ`, `💸 เบิกเงิน`→`เบิกเงิน`, `ยกเลิก`→`ยกเลิก`.
  - `request_status` loads the worker's `leave_requests` from the last 60 days, the leave days left, and the advances, then replies with `formatRequestStatusReply`.
    - Get the days left the same way field-form `info` computes `remainingPersonal` / `remainingSick`. Move that helper to `_shared` if it is local.
  - Eligibility for `request_status` and `request_menu`: a linked active worker. The advances section and the เบิกเงิน chip only appear when the tenant has `payroll`.
  - Settings UI: add both keys.
  - `docs/line-rich-menu/README.md` is already updated (2026-10-18).

### Task 1: Migration — token type, command keys, original-request columns, approve-with-changes RPC, bell count

**Files:**
- Create: `supabase/migrations/2026-10-20-01-line-advance-request.sql`
- Create (gitignored workspace): the dry-run script `.superpowers/sdd/<plan>/task-1-dryrun.sql`

**Interfaces:**
- Produces:
  - `line_deep_link_tokens.action_type` accepts `'advance'`.
  - `line_command_settings.command_key` accepts `'advance_request'` and `'advance_status'`, in addition to every key the CHECK allows today.
  - `salary_advances.requested_amount NUMERIC NULL` and `salary_advances.requested_installments INT NULL`. These are filled at request time and keep the worker's original numbers.
  - RPC `approve_salary_advance_edit(p_id UUID, p_amount NUMERIC, p_installments INT, p_start_year INT, p_start_month INT) RETURNS VOID`, owner-only.
  - `pending_counts()` jsonb gains the key `advances_pending`.

- [ ] **Step 1: Get the live definitions.** The controller writes the live definitions into the workspace:
  - `pending_counts()`, via `pg_get_functiondef`;
  - the current CHECK definitions of `line_deep_link_tokens_action_type_check` and of the `line_command_settings` `command_key` CHECK, via `pg_get_constraintdef`.
  Copy them verbatim and only add to them.
- [ ] **Step 2: Write the migration.**
  - Drop and re-add both CHECKs with the new values.
  - `ALTER TABLE salary_advances ADD COLUMN requested_amount NUMERIC, ADD COLUMN requested_installments INT`.
  - `CREATE OR REPLACE FUNCTION pending_counts()`: the live body plus `'advances_pending', CASE WHEN is_admin_or_owner() THEN (SELECT count(*) FROM salary_advances WHERE tenant_id = current_tenant_id() AND status = 'pending') ELSE 0 END`.
  - `approve_salary_advance_edit`:
    - SECURITY DEFINER, `SET search_path = public, pg_temp`.
    - Check `is_owner() AND has_module_access('payroll')`. On failure, raise `อนุมัติได้เฉพาะเจ้าของ` (insufficient_privilege).
    - Validate `p_amount > 0`, `p_installments BETWEEN 1 AND 60`, `p_start_month BETWEEN 1 AND 12`.
    - If `payroll_periods` for (tenant, start) exists with status `confirmed` or `closed`, raise `เดือนที่เริ่มหักยืนยันหรือปิดงวดแล้ว เลือกเดือนถัดไป` (check_violation).
    - Set `requested_amount = COALESCE(requested_amount, amount)` and `requested_installments = COALESCE(requested_installments, installments)`.
    - Then set amount, installments, start and `status='approved'`, `approved_by=auth.email()`, `approved_at=now()`, `WHERE id=p_id AND tenant_id=current_tenant_id() AND status='pending'`.
    - If no row matched, raise `ไม่พบคำขอที่รออนุมัติ`.
    - `REVOKE ALL … FROM PUBLIC, anon; GRANT EXECUTE … TO authenticated`.
    - Keep `approve_salary_advance` as it is.
- [ ] **Step 3: Write the dry-run script.** BEGIN + the migration + DO-block checks that RAISE on failure. Run as the demo owner (`demo-owner@facadex.co.th`, tenant `8b61c890-0a90-4223-91d3-b5f8f4e89908`, impersonated like `demo_impersonate`):
  - (a) An advance edited to 3,000 × 2 from a pending 5,000 × 1 ends `approved`, with `requested_amount=5000`, `requested_installments=1`.
  - (b) A start month whose period is `confirmed` raises the start-month message.
  - (c) As demo-admin the RPC raises insufficient_privilege.
  - (d) `pending_counts()->>'advances_pending'` is 1 as owner with one pending row, and 0 when impersonating a WORKER.
  - (e) Inserting a token with `action_type='advance'` succeeds.
  - Then a final `SELECT 'ALL CHECKS PASSED'` and `ROLLBACK;`.
- [ ] **Step 4: Commit** (migration only): `feat(db): LINE advance request — token type, command keys, approve with changes, bell count`

### Task 2: Pure advance rules (app + edge) with parity tests

**Files:**
- Create: `src/lib/payroll/advanceRules.js`, `supabase/functions/_shared/advance-logic.ts`
- Test: `src/lib/payroll/advanceRules.test.js` (tests both modules on the same fixtures)

**Interfaces:**
- Produces, with the same names in both files:
  - `ADVANCE_PHRASES = { advance_request: ['เบิกเงิน'], advance_status: ['ยอดเบิก'] }`
  - `matchAdvanceAction(text: string, phrasesByKey?: {advance_request?: string[], advance_status?: string[]}) → 'advance_request' | 'advance_status' | null`. It does a substring match, checks `advance_status` first, and treats custom phrases like the other commands.
  - `parseAdvanceAmount(raw: string|number) → {ok: true, amount: number} | {ok: false, error: string}`. It strips commas and spaces, keeps 2 decimals, and requires 0 < amount ≤ 1,000,000. The errors are `กรุณาใส่จำนวนเงิน` and `จำนวนเงินต้องมากกว่า 0 และไม่เกิน 1,000,000 บาท`.
  - `workerMonthlyPay(worker: {pay_type, monthly_salary, daily_wage}) → number`.
  - `summarizeAdvances(advances: Row[], closedLines: {advance_id, amount}[], exceptId?: string) → {outstanding, pendingOther, items: [{id, title, amount, installments, status, deducted, remaining, paidInstallments}]}`. Only approved rows count toward `outstanding`. Pending rows other than `exceptId` count toward `pendingOther`.
  - `advanceLimit({monthlyPay, outstanding, pendingOther}) → number`, which can be negative.
  - `defaultStartMonth(periodsByKey: {['YYYY-M']: status}, today: {year, month}) → {year, month}`.
  - `formatAdvanceStatusReply(summary, fmt) → string`, the Thai reply text. If there is nothing to show, it returns `ยังไม่มีรายการเบิกเงินครับ`. Each line looks like `• <title> <amount> บาท — <status Thai>` plus `หักแล้ว x/y งวด` when approved. The last line is `ยอดคืนคงเหลือ <outstanding> บาท`.

- [ ] **Step 1: Write the failing tests.** For each export, run the same cases against both modules:
  - matcher: "ขอเบิกเงิน 3000" → `advance_request`; "อยากเบิกเงิน" → `advance_request`; "ยอดเบิก" → `advance_status`; "ขอเบิกปูน" → null; "เบิกของ" → null.
  - `parseAdvanceAmount`: "5,000" → 5000; "5000.505" → 5000.51; "0", "-1", "abc", "" and "2000000" → `{ok: false}`.
  - `workerMonthlyPay`: daily 200 → 6000; monthly 25145 → 25145; null → 0.
  - `summarizeAdvances`: approved 5000 with closed lines 2000 → outstanding 3000; one pending 1000 plus another pending 500 with `exceptId` of the first → pendingOther 500; a rejected row → ignored.
  - `advanceLimit`: 25145 − 3000 − 500 = 21645.
  - `defaultStartMonth`: `{'2026-10':'confirmed'}` with today 2026-10 → 2026-11; `{'2026-12':'closed'}` with today 2026-12 → 2027-1; `{}` → the current month.
  - `formatAdvanceStatusReply`: an empty summary gives the empty message.
- [ ] **Step 2: Run and see it fail:** `npx vitest run src/lib/payroll/advanceRules.test.js`
- [ ] **Step 3: Implement both modules.** The `.ts` must have no Deno or jsr imports, so vitest can import it.
- [ ] **Step 4: Run and see it pass**, then the full `npx vitest run`.
- [ ] **Step 5: Commit:** `feat(payroll): advance request rules shared by app and LINE`

### Task 3: line-webhook — route "เบิกเงิน" and "ยอดเบิก"

**Files:**
- Modify: `supabase/functions/line-webhook/index.ts`
  - `DMOnlyActionType` (≈170)
  - `matchDMAction` (≈316)
  - `issueFieldFormLink` union (≈141)
  - the DM dispatch (≈1499–1550)
  - the group path (≈1620)
- Modify: `src/lib/lineCommandSettings.js`, `src/pages/CommunicationCenter.jsx`. Add the two keys with their default phrases, as DM-only. Hide the group toggle for them.

**Interfaces:**
- Consumes: `matchAdvanceAction`, `summarizeAdvances`, `formatAdvanceStatusReply` from Task 2. Also `linkRequestsThrottled`, `THROTTLED_LINK_MESSAGE` from `_shared/form-throttle.ts`, and `sendLineReply`.
- Produces: DM actions `'advance_request' | 'advance_status'`, and a token `action_type 'advance'`.

- [ ] **Step 1: Route the DM.** In `matchDMAction`, call `matchAdvanceAction(text, phrases from commandSettings)` **before** `matchGroupAction`. Add both keys to `DMOnlyActionType`.
- [ ] **Step 2: Add the dispatch branch, above the generic pending-action branch.** Apply `resolveEnabled` as today, then:
  - Check eligibility. The worker is already active via `resolveWorker`. Also check the tenant `payroll` module with the same helper field-form uses (move it to `_shared` if it is local). If ineligible, reply with the Global Constraints text.
  - `advance_request`: throttle, then `issueFieldFormLink(tenant, worker, 'advance')`. Reply `💸 กดลิงก์นี้เพื่อกรอกขอเบิกเงินครับ (ใช้ได้ 30 นาที)\n${link}`. A null link gets the existing error reply.
  - `advance_status`: with the service role, load the worker's `salary_advances` (tenant + worker) and the closed-period lines for their approved ids, using the same join `useAdvances` uses. Then reply with `formatAdvanceStatusReply(summarizeAdvances(...))`.
- [ ] **Step 3: Handle the group path.** If `matchAdvanceAction(text)` returns an action, reply once with the DM-only hint and stop, before `matchGroupAction`.
- [ ] **Step 4: Settings UI.** The two new keys appear in the LINE command settings with rename and DM on/off. `phrasesCollide` must flag a custom phrase that collides with material-request phrases. Add a test in the existing lineCommandSettings test, or a new one.
- [ ] **Step 5: Verify.** Run `npx vitest run` and `deno check supabase/functions/line-webhook/index.ts` if deno is available. If not, note it in the report.
- [ ] **Step 6: Commit:** `feat(line): เบิกเงิน / ยอดเบิก DM commands`

### Task 4: field-form — `advance` info and submit

**Files:**
- Modify: `supabase/functions/field-form/index.ts`: `info` (≈167), `submit` (≈214), daily-limit condition (≈221)
- Modify: `supabase/functions/_shared/web-push-messages.ts` (add `advanceRequestPush`), its test `src/lib/webPushMessages.test.js`, and `src/lib/webPushToggles.js` (key `web_push_advance_request`, label `แจ้งเมื่อมีคำขอเบิกเงิน`)

**Interfaces:**
- Consumes: from Task 2, `parseAdvanceAmount`, `summarizeAdvances` and `defaultStartMonth`; also `dailySubmitLimitReached` and `sendWebPushToTenantAdmins(admin, tenantId, payload, 'money')`.
- Produces:
  - `info` for `advance`: `{actionType:'advance', workerName, outstanding, pendingOther, installmentOptions:[1,2,3,4,5,6]}`. When payroll is off it returns `{reason:'payroll_disabled'}`.
  - `submit` for `advance`: the body is `{action:'submit', token, amount, installments, title}`, and it returns `{ok:true, workerName}`.
  - `advanceRequestPush(workerName, amount)` returns `{title:'ขอเบิกเงิน', body:'<name> ขอเบิก <amount> บาท', tab:'hr', pending:'advances_pending'}`.

- [ ] **Step 1: Write the failing test** for `advanceRequestPush` in `webPushMessages.test.js`.
- [ ] **Step 2: Implement `info` and `submit`.**
  - Validate amount with `parseAdvanceAmount` and installments as integers 1–6. `title` is trimmed, max 100, default `เบิกเงินล่วงหน้า`. On a validation failure return `{error: <Thai message>}` with status 400.
  - Compute the start month from the tenant's `payroll_periods`, as Bangkok today, using `defaultStartMonth`.
  - Insert `salary_advances` with:
    - `tenant_id` and `worker_id` from the token;
    - `title`, `amount`, `installments`, `start_year`, `start_month`;
    - `status:'pending'`, `requested_by: 'line:'+worker_id`;
    - `requested_amount: amount`, `requested_installments: installments`.
  - Mark the token used. Gate Web Push on `isPushEnabled(admin, tenant, 'web_push_advance_request')`. **No LINE push.**
  - Add `'advance'` to the daily-limit condition.
- [ ] **Step 3: Verify.** Run `npx vitest run`, plus `deno check` if available.
- [ ] **Step 4: Commit:** `feat(line): advance request field form`

### Task 5: FieldFormPage — advance form

**Files:**
- Modify: `src/FieldFormPage.jsx`: the title (≈287), the submit body (≈215), the form branch, the success text (≈265), and `REASON_MESSAGES` (add `payroll_disabled`)

**Interfaces:**
- Consumes: the `info` / `submit` shapes from Task 4, and `parseAdvanceAmount` from `src/lib/payroll/advanceRules.js`.

- [ ] **Step 1: Turn the binary branches into a three-way branch.**
  - Material and leave keep their current behaviour.
  - Advance shows:
    - title `💸 ขอเบิกเงิน`;
    - amount field (`inputMode="decimal"`);
    - เหตุผล (optional);
    - installments select 1–6, with `ผ่อน n เดือน (เดือนละ ~x บาท)`;
    - a read-only line `ยอดคืนคงเหลือของคุณ <outstanding> บาท`, plus `รออนุมัติ <pendingOther> บาท` when > 0.
  - The submit button is disabled until `parseAdvanceAmount` is ok.
  - Success text: `ส่งคำขอแล้ว รอเจ้าของอนุมัติ พิมพ์ "ยอดเบิก" ในแชตเพื่อดูสถานะ`.
- [ ] **Step 2: Verify.** Run `npx vitest run` and `npx vite build`.
- [ ] **Step 3: Commit:** `feat(line): advance request form page`

### Task 6: AdvancesPanel — pending cards with numbers, approve editor, bell item

**Files:**
- Modify: `src/pages/hr/AdvancesPanel.jsx`, `src/hooks/usePayroll.js` (`useAdvances` also returns the workers' pay fields, and lines for pending rows' workers), `src/lib/payroll/load.js` (add `approveAdvanceEdit`), `src/lib/pendingItems.js` (add `{key:'advances_pending', icon:'💸', label:'คำขอเบิกเงินรออนุมัติ', tab:'hr'}`), and `src/pages/HR.jsx` (pending `advances_pending` opens the `advances` inner tab, in the same way `leave_pending` focuses the leave tab)
- Test: extend `src/lib/pendingItems.test.js` if it exists, or create it, with: a PM without `hr` money access does not see the item.

**Interfaces:**
- Consumes: `approve_salary_advance_edit` from Task 1; `summarizeAdvances`, `advanceLimit`, `workerMonthlyPay` and `defaultStartMonth` from Task 2.
- Produces: `approveAdvanceEdit(id, {amount, installments, startYear, startMonth})`.

- [ ] **Step 1: Pending section on top.** Show it only when there are pending rows. One card per pending request, showing:
  - name;
  - `ขอ <amount> บาท · ผ่อน <n> เดือน`;
  - reason;
  - a chip `ขอผ่าน LINE` when `requested_by` starts with `line:`;
  - four numbers: ยอดคืนคงเหลือ (ของเก่า), รออนุมัติอื่นอยู่, เงินเดือน, ยังเบิกได้อีก.
  - When amount > ยังเบิกได้อีก, show a red line `เกินวงเงินที่เบิกได้ <diff> บาท` and a red card border.
- [ ] **Step 2: Approve editor (owner only).**
  - A modal prefilled with amount, installments (1–60), and start month (from `defaultStartMonth` over the loaded periods).
  - It shows the original request when edited (`ขอมา 5,000 × 1`).
  - Confirm calls `approveAdvanceEdit`, then refetch. Errors are shown in the modal.
  - Reject keeps the existing flow. Replace `prompt()` with an inline reason field, since dialogs are blocked in some views.
- [ ] **Step 3: Bell.** Add the `PENDING_ITEMS` entry and the HR focus. Test that `visiblePendingItems` hides it when `canSeeTab('hr')` is false.
- [ ] **Step 4: Verify.**
  - Run `npx vitest run` and `npx vite build`.
  - Run eslint no-undef over the changed files: `npx --yes --package eslint@8.57.0 eslint --no-eslintrc` with `{"parserOptions":{"ecmaVersion":2022,"sourceType":"module","ecmaFeatures":{"jsx":true}},"env":{"browser":true,"es2022":true},"rules":{"no-undef":"error"}}`.
- [ ] **Step 5: Commit:** `feat(payroll): advance approval cards with balance, limit warning and editor`

### Task 7: Ship (owner gates)

- [ ] **Step 1:** Run the Task 1 dry-run script on CHANG (controller). Show the owner the result, then apply after their go.
- [ ] **Step 2:** Deploy edge functions `line-webhook` and `field-form`, after the owner's go: `npx supabase functions deploy <name> --project-ref kntspldhvcjeaubtqtkn --use-api --no-verify-jwt`.
- [ ] **Step 3:** Web deploy per the owner checklist (build-info.json, merge the live commit, version above live, changelog `ขอเบิกเงินผ่าน LINE: พิมพ์ "เบิกเงิน" กับบอท เจ้าของอนุมัติในแอป พิมพ์ "ยอดเบิก" ดูสถานะ`), after the owner's go.
- [ ] **Step 4:** Live check with the owner. A linked test worker DMs "เบิกเงิน", fills the form, and the owner sees the card and the bell item. Approve with an edited amount. The worker types "ยอดเบิก".
