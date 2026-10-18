# LINE Payslip Request Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A worker taps ยื่นคำขอ → 🧾 ขอสลิปเงินเดือน in LINE. They get a 30-minute link to a page that lists their closed-month slips from the last 12 months and shows the A5 slip.

**Architecture:**
- New token type `payslip` and command key `payslip_request`.
- The webhook issues the link.
- field-form gets two read-only actions: `info` (month list) and `slip` (one month's data).
- FieldFormPage renders the existing `PayslipSheet` from injected data.

**Tech Stack:** React 18 + Vite, Deno edge functions, Supabase Postgres, vitest.

**Spec:** docs/superpowers/specs/2026-10-18-line-payslip-design.md

## Global Constraints
- LINE: reply only, never push.
- The worker and tenant come from the token only; every service-role query filters by tenant_id.
- Only `payroll_periods.status = 'closed'` months. Window = the current Bangkok month and the 11 before it.
- A payslip token is never marked used. It is valid only while `expires_at > now()`, and the token's tenant_id must equal the worker's tenant_id.
- Thai copy is verbatim from the spec.
- Subagents never call DB tools.
- Commit trailer:
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Vgp2hHNnpbtTgWxnfhrgKK

## Review Focus
1. A request for another month or year outside the window, or a draft or confirmed month, gets no data: a 404-style `{reason:'no_slip'}`.
2. An expired token gets `{reason:'expired'}`. A used token: payslip tokens are never used, but loadToken's used_at check must not break.
3. A worker with zero closed slips sees `ยังไม่มีสลิปที่ปิดงวดแล้วใน 12 เดือนล่าสุด`.
4. The existing chips and the matcher order are unchanged for ขอลา / ขอเบิกของ / เบิกเงิน / ยอดเบิก.
5. The app's PayslipModal still renders exactly as before.

---

### Task 1: Command, token type, bot reply

**Files:**
- Create: `supabase/migrations/2026-10-20-02-line-payslip.sql`
- Modify: `supabase/functions/_shared/advance-logic.ts` + `src/lib/payroll/advanceRules.js` (mirror)
- Modify: `supabase/functions/_shared/line-command-match.ts`
- Modify: the `ADVANCE_COMMAND_KEYS` lists in `src/lib/lineCommandSettings.js` and its _shared mirror
- Modify: `src/pages/CommunicationCenter.jsx`, if it needs a label for the key
- Modify: `supabase/functions/line-webhook/index.ts`
- Tests: `src/lib/payroll/advanceRules.test.js`, `src/lib/lineCommandMatch.test.js`, `src/lib/lineCommandSettings.test.js` (if it exists)

**Interfaces:**
- Migration:
  - Recreate `line_deep_link_tokens_action_type_check` = live list + `'payslip'`. The live list is `material_request, leave, check_in, check_out, advance`.
  - Recreate `line_command_settings_command_key_check` = live list + `'payslip_request'`. The live list is `today_job, tomorrow_job, this_week_job, next_week_job, issue_report, material_request, leave, check_in, check_out, site_photo, job_done_start, advance_request, advance_status, request_menu, request_status`.
  - Write it as DROP CONSTRAINT IF EXISTS + ADD.
- `ADVANCE_PHRASES.payslip_request = ['ขอสลิป']`. `matchAdvanceAction` returns `'payslip_request'` for any text containing ขอสลิป. Put it first in CHECK_ORDER. The leave-keyword guard still applies first.
- Group: `groupAdvanceHint` returns `'ignore'` for payslip_request.
- `requestMenuChips({..., payslipOn, payslipPhrase})` adds `{label:'🧾 ขอสลิปเงินเดือน', text: payslipPhrase === 'ขอสลิป' ? 'ขอสลิปเงินเดือน' : payslipPhrase}` after เบิกเงิน and before ยกเลิก. Only when `payslipOn && payslipPhrase`.
- Webhook:
  - `payslipOn = hasPayroll && resolveEnabled('payslip_request', settings, 'dm')`.
  - The DM action `payslip_request` behaves as follows:
    - payslip is not on → reply `ยังขอสลิปผ่าน LINE ไม่ได้ ติดต่อแอดมินครับ`;
    - otherwise `issueFieldFormLink(tenant, worker, 'payslip')` → reply `🧾 กดลิงก์นี้เพื่อดูสลิปเงินเดือนครับ (ใช้ได้ 30 นาที)\n<link>`;
    - if the link fails → reply the existing `⚠️ ระบบขัดข้อง กรุณาแจ้งแอดมินโดยตรง`.
  - Widen the actionType union.
- Add `payslip_request` to ADVANCE_COMMAND_KEYS. It is then covered by the pending-action interrupt list and the CommunicationCenter DM-only editor. Add `ADVANCE_PHRASES.payslip_request` to the interrupt list next to the money phrases.
- Throttle: issuing counts in the existing daily token limit. Include 'payslip' wherever that limit lists the action types.

- [ ] Step 1: Write failing tests:
  - matchAdvanceAction('ขอสลิปเงินเดือน') = 'payslip_request', in both JS and TS (parity);
  - 'ขอลา ขอสลิป' → null;
  - groupAdvanceHint → 'ignore';
  - requestMenuChips with payslipOn → the chip order is ขอลา, เบิกของ, เบิกเงิน, ขอสลิปเงินเดือน, ยกเลิก;
  - payslipOn false → no chip;
  - matchDMAction('ขอสลิปเงินเดือน') does not return material or leave.
- [ ] Step 2: Implement. Then run `npx vitest run`, `npx vite build`, and esbuild-bundle the webhook (see Task verification).
- [ ] Step 3: Commit `feat(line): ขอสลิปเงินเดือน command and link`

### Task 2: field-form payslip actions + injectable PayslipSheet

**Files:**
- Modify: `supabase/functions/field-form/index.ts`
- Create: `supabase/functions/_shared/payslip-data.ts`, pure helpers, vitest-importable: `payslipWindow(todayIso)`, `pickYtd(lines)`
- Modify: `src/pages/hr/Payslip.jsx`
- Tests: `src/lib/payslipData.test.js` (imports the _shared file); `src/pages/hr/Payslip.test.js`, extended

**Interfaces:**
- `payslipWindow('2026-10-18')` → `{from:{year:2025,month:11}, to:{year:2026,month:10}}`. The comparison key is year*12+month.
- **info** for a `payslip` token, in this order:
  1. Run the same eligibility as advance (active, linked, payroll module). On failure return `{reason:'payroll_disabled'}`.
  2. Return `{actionType:'payslip', workerName, months:[{year, month, netPay}]}`, newest first. The months are this worker's salary_records joined to payroll_periods with status 'closed', inside the window, tenant-filtered.
- **action `slip`** `{token, year, month}`:
  - Validate integers.
  - Look up the record, which must be in `months` by the same rules; otherwise return `{reason:'no_slip'}` with status 200.
  - Return:
    ```
    {
      tenant:{company_name, tax_id},
      worker:{name, nickname, employee_code, position, bank_account_name},
      record:{worker_id, net_pay, paid_date, facts, salary_record_lines:[{id, pay_item_id, name, side, sort_order, amount, quantity, rate, note}]},
      period:{status, paid_date},
      otItem:{id, name, sort_order}|null,
      ytd:{earnings, sso, contrib}
    }
    ```
  - otItem is the tenant's active pay_item with method 'ot'.
  - ytd uses the same rule as `useYearToDate`: closed months of that year, month ≤ the requested month, earning lines; sso = pay_items.method 'sso'; contrib = system_key 'contribution_deduct'.
  - Never mark the token used.
- `loadToken` stays as it is. Payslip tokens never get used_at, so the used check is harmless.
- **PayslipSheet** gains optional props `tenantOverride`, `otItemOverride`, `ytdOverride` (`undefined` = use the hooks).
  - React hooks can't be conditional, so the hooks still run. In the public page there is no session, so their results are ignored when overrides are given.
  - Make sure the public page doesn't call supabase.from for YTD when ytdOverride is given: pass a `skip` flag to useYearToDate.
  - For usePayItems / useTenant, check what they do with no session. If they would throw or error, split PayslipSheet into a pure `PayslipSheetView` (all data via props) plus the existing wrapper. The split is the preferred design.
- [ ] Steps: tests for payslipWindow, pickYtd and PayslipSheetView render (a closed month has no ร่าง watermark; the OT 0 row is added from otItem) → implement → vitest/build/esbuild → commit `feat(line): payslip data from field-form; pure PayslipSheetView`

### Task 3: FieldFormPage payslip branch

**Files:** `src/FieldFormPage.jsx`, `src/FieldFormPage.payslip.test.jsx`

- Title `🧾 สลิปเงินเดือน`. Below it, the list: one button per month, `<MONTHS_TH> <year+543> · สุทธิ <fmt(netPay)> บาท`.
- Empty state: `ยังไม่มีสลิปที่ปิดงวดแล้วใน 12 เดือนล่าสุด`.
- Tapping a month calls `slip`, then shows PayslipSheetView, plus `← เลือกเดือนอื่น` and `⬇️ บันทึก PDF` buttons. The PDF uses `downloadPDF('payslip-a5', 'สลิปเงินเดือน_<name>_<MONTHS_TH><year+543>.pdf', {format:'a5', orientation:'landscape', margin:0})`.
- Fit to screen: a wrapper scales the 794px sheet to the container width with a CSS transform and a computed height. Remove the transform while downloadPDF runs, then restore it.
- `{reason:'no_slip'}` → `ไม่พบสลิปเดือนนี้`. Other reasons go through REASON_MESSAGES as they do today. `expired` already exists.
- Tests:
  - the month list renders with labels;
  - the empty state;
  - tapping a month calls invoke with `{action:'slip', token, year, month}`;
  - the slip shows the worker name and net pay.
- [ ] Commit `feat(line): payslip page in the LINE form`

### Verification (every task)
- `npx vitest run`
- `npx vite build`
- eslint no-undef: `npx --yes --package eslint@8.57.0 eslint --no-eslintrc --no-ignore -c /Users/plfx/.claude/jobs/bdd54219/tmp/eslint-deno.json --parser-options=ecmaFeatures:{jsx:true} <changed js/jsx>`
- For edge function changes: `npx --yes esbuild@0.21.5 supabase/functions/<fn>/index.ts --bundle --format=esm --platform=neutral "--external:npm:*" "--external:jsr:*" "--external:https://*" --log-level=warning --outfile=/Users/plfx/.claude/jobs/bdd54219/tmp/<fn>.js`, then run the eslint command on that output.
