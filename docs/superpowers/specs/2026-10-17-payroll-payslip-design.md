# Payroll rework: configurable pay items, periods, advances, payslip, bank export

Date: 2026-10-17. Status: draft for owner review.
Branch: `worktree-feat-payroll-payslip` (from origin/main `b914dc6f`).
Mockup: https://claude.ai/artifact/ToTC4HTXzpgfsxqka2cDjC

## Goal

Make CHANG's monthly payroll correct, and let each tenant shape its own earnings
and deductions instead of using columns fixed in code. The benchmark is the
owner's September 2026 payroll sheet for FacadeX (12 people). Every person's net
pay must come out of the system to the baht.

This is job 1 of 2. Job 2, requesting an advance and checking its status over
LINE, comes later. It will reuse the advances table built here and is not part
of this spec.

## Decisions taken with the owner (2026-10-16/17)

- Priority is correct calculation first, then the payslip.
- The daily rate is **salary ÷ 30 everywhere**, SQL costing views included.
- Pay items are tenant-configurable. A tenant can add, rename, hide and reorder
  items, and each item picks its calculation method from a fixed list. This is
  "approach A" storage: one row per item per worker per month.
- A month goes through three states, **draft → confirmed → closed**. Only the
  owner can reopen a closed month.
- Daily-wage workers are supported. Days worked are counted the way payroll
  already counts shifts (Assign shifts, check-in confirmation and the OT table).
  They earn OT at daily wage ÷ 8 × 1.5 and are paid monthly with everyone else.
- Social security is 5% of the items ticked "counts toward the SSO base", capped
  at 875. Workers without social security are skipped by a per-worker flag.
  On FacadeX that is 4 foreign workers: ชาลิต, ซึง, อ่อง, นิด.
- The daily rate for unpaid leave is salary ÷ 30 **rounded up** to whole baht.
- Fixed items such as ค่าบ้าน (house) are set once per worker and repeat monthly.
- Advances are requested, then approved by the **owner only**, then deducted
  automatically over N months. Employees can see their own status in the app.
- The payslip is A5 landscape, viewed and downloaded as a PDF in the app. There
  is no batch print. It carries the employee code and bank account, and the
  signature area shows the payer's and payee's typed names.
- After a month is confirmed, admins can export a payroll file for bank upload
  (SCB Business Anywhere, KBank). The owner will supply sample files from each bank.

## What exists today (verified 2026-10-16)

- The live payroll UI is in `src/pages/HR.jsx`. `src/pages/Payroll.jsx` is dead
  code that nothing imports.
- `salary_records` has one row per worker per month and fixed money columns:
  base_salary, contribution, phone_allowance, ot_amount (which also carries the
  holiday bonus), special_allowance, advance_deduction, social_security_ded,
  leave_deduction and loan_deduction. It also has net_pay, paid_date and notes.
  Nothing locks a row once written.
- No SQL view reads `salary_records` columns. The only SQL writer outside the app
  is the demo-tenant seed (`2026-10-15-01-demo-tenant-seed.sql`).
- `workers` has `monthly_salary`, `monthly_contribution` (a fixed amount) and
  `has_social_security`. It has no employee code, bank fields, pay type or daily
  wage.
- The existing payslip is a modal at HR.jsx:299-363 that renders an HTML PDF.

Bugs found and checked against the code:

1. **The last day of every month is dropped.** `new Date(year, month, 0).toISOString()`
   is converted to UTC, so under UTC+7 October ends on the 30th (HR.jsx:726).
   Payroll.jsx:251 has the same line.
2. **Recalculating corrupts net pay.** It upserts a partial row. The manual
   advance/loan/phone/special amounts stay in the row, but the new net_pay leaves
   them out (HR.jsx:779).
3. **Workers with no shifts in the month get no record**, although they are owed
   their full salary.
4. **Payroll and costing use different divisors.** Payroll uses ÷30, but
   `workers_with_rate.daily_rate`, `labor_cost_by_site` and `ot_cost_by_site`
   use ÷26.
5. **The SSO cap is 750**, but the owner's sheet uses 875.

## Calculation rules, reverse-engineered from the September sheet

| Item | Side | Method | Rule | Rounding |
|---|---|---|---|---|
| เงินเดือน | earning | system: base pay | monthly: `monthly_salary`; daily: days worked × daily_wage | none |
| สมทบ | earning | percent of item | 5% of เงินเดือน | 2 dp |
| โทรศัพท์ | earning | fixed per worker | worker's amount | none |
| OT | earning | system: OT | hours × (rate÷8) × 1.5, plus holiday shifts × rate × 0.5 × holiday multiplier | **ceil to baht** |
| เงินพิเศษค่าจอดรถ | earning | fixed per worker | worker's amount | none |
| ประกันสังคม | deduction | system: SSO | 5% × Σ(items ticked SSO-base), cap 875 | round half-up to baht |
| ค่าบ้าน | deduction | fixed per worker | worker's amount | none |
| เบิกล่วงหน้า | deduction | system: advances | Σ approved advance installments due this month | none |
| กยศ | deduction | manual monthly | typed in the monthly grid | none |
| ลาไม่รับค่าจ้าง | deduction | system: unpaid leave | leave_personal days × ceil(salary÷30) | ceil on the daily rate |
| หักเงินสมทบ | deduction | percent of item | 100% of สมทบ | 2 dp |

In the table, `rate` is salary÷30 for monthly workers and daily_wage for daily
workers. The SSO base is เงินเดือน + สมทบ + โทรศัพท์.

Evidence from the sheet:

- สมทบ: 25,145 × 5% = 1,257.25.
- SSO: กอล์ฟ (14,980 + 749 + 500) × 5% = 811.45 → 811.
- Unpaid leave: กร 2 × 839 = 1,678 and ต้น 2 × 642 = 1,284.
- OT, which must be ceiled: กอล์ฟ 1.5 h × 93.625 = 140.44 → 141, and ชัย 1.5 h ×
  157.16 = 235.73 → 236.

Sick leave never deducts. Daily workers get no unpaid-leave line, because they
are simply not paid for days not worked.

The SSO base ignores unpaid leave: everyone with leave in September was still
charged the full 875. This spec matches the sheet. The owner can change that
later.

Net pay = Σ earnings − Σ deductions. It is always derived from the lines and
can never be typed in.

## Design

### Data model (new or changed)

- **`pay_items`** (per tenant) holds:
  - `id`, `tenant_id`, `name`, `side` (`earning`/`deduction`), `method`,
    `params jsonb`, `sso_base bool`, `rounding`, `sort_order`, `active`, `system_key`.
  - `method` is one of `fixed_per_worker`, `manual_monthly`, `percent_of_item`,
    `base_pay`, `ot`, `sso`, `unpaid_leave`, `advances`.
  - `params` holds the method's settings, e.g. `{percent:5, of_item_id}` or
    `{rate:0.05, cap:875}`.
  - The system methods `base_pay`, `ot`, `sso`, `unpaid_leave` and `advances`
    each appear at most once per tenant (partial unique index). They can be
    renamed and reordered but not deleted.
  - A seed function creates the 11 defaults above for every existing and new
    tenant, wired into tenant signup.
- **`worker_pay_item_amounts`** stores the per-worker amount for each
  `fixed_per_worker` item: `(worker_id, pay_item_id) → amount`.
- **`workers`** gets `employee_code`, `bank_code`, `bank_account_no`,
  `bank_account_name`, `pay_type` (`monthly`/`daily`, default monthly) and
  `daily_wage`.
- **`payroll_periods`** stores `(tenant_id, year, month)` unique, `status`
  (`draft`/`confirmed`/`closed`), `confirmed_by/at`, `closed_by/at`, `paid_date`,
  and the reason from the last reopen.
- **`salary_records`** stays the per-worker-per-month header row. It gets
  `period_id` and keeps `net_pay`, which a trigger recomputes from the lines. Once
  the lines replace them, the old fixed money columns are no longer written; they
  are dropped in a later release, not in this one.
- **`salary_record_lines`** stores:
  - `salary_record_id`, `pay_item_id` (nullable), and a snapshot of `name`,
    `side` and `sort_order`;
  - `amount`, plus `quantity` and `rate` for display (e.g. "2 days × 839"), and `note`;
  - `advance_id` (nullable).
  - The name snapshot means a slip from a past month always reads as it did then.
- **`salary_advances`** stores `worker_id`, `title`, `amount`, `installments`,
  `start_year/month`, `status` (`pending`/`approved`/`rejected`/`settled`),
  `requested_by`, `approved_by/at` and `reject_reason`. Deducted-so-far is
  Σ lines with that `advance_id` in closed periods. The remainder is
  `amount − deducted`. The monthly installment is `amount ÷ installments`, and
  the last installment takes the rounding remainder.

### Database guards (not just hidden buttons)

- A trigger on `salary_records` and `salary_record_lines` rejects
  insert/update/delete when the record's period is `confirmed` or `closed`.
- Period transitions go through `SECURITY DEFINER` RPCs that check the role:
  - `confirm_payroll_period` and `unconfirm_payroll_period`: admin or owner.
  - `close_payroll_period(paid_date)`: admin or owner.
  - `reopen_payroll_period(reason)`: owner only, and writes the audit log.
- Approving an advance goes through `approve_salary_advance` /
  `reject_salary_advance`, owner only. An employee can insert only their own
  `pending` request and read only their own advances.
- Saving a recalculation goes through a single RPC that replaces a draft
  period's records and lines in one transaction. It saves everyone or no one.
  The current per-row upsert loop that ignores errors goes away.
- RLS follows the existing payroll pattern: tenant-scoped, admin/owner
  read/write, and a worker reads only their own rows. A worker sees records only
  in `confirmed`/`closed` periods, so they never see a draft.
- Every new function gets explicit `GRANT`/`REVOKE`. Anon gets no access (lesson
  from the CHANG restore).

### Calculation engine

`src/lib/payroll/calc.js` holds pure functions with no Supabase access:
`calculatePayroll({ items, worker, workerAmounts, shifts, otRows, holidays,
advancesDue, manualEntries, settings, year, month })` returns
`{ lines, net, warnings }`.

- Date ranges are built from strings in local time. No `toISOString()` and no
  `new Date(dateString).getDay()`.
- `percent_of_item` items are resolved in dependency order, and a cycle is a
  validation error.
- A data-loading layer (`src/lib/payroll/load.js`) fetches the inputs for a month
  and feeds the engine. The UI never computes money itself.

**Golden test.** The September sheet becomes a fixture of 12 workers' inputs. The
test asserts every line and every net pay to the satang, including the column
totals (net total 186,328.00). The input data for the fixture, i.e. shifts and OT
hours, is derived from the sheet itself, not from the live DB.

### Monthly flow (UI in HR → เงินเดือน)

1. **Draft.**
   - "คำนวณ" computes every active worker, including those with no shifts.
   - It shows a preview. On a recalculation, the preview shows only the changed
     amounts per worker and item, and the user saves.
   - The month is shown as a grid like the owner's sheet: one row per worker,
     one column per active item, with totals.
   - `manual_monthly` cells can be edited in the grid. Recalculating keeps them.
2. **Confirmed** (admin/owner presses "ยืนยันเงินเดือน").
   - Nothing can be edited. "กลับไปแก้ไข" returns the month to draft.
   - Slips become visible to employees.
   - Bank export is enabled.
   - Pre-confirm warnings:
     - a daily worker with no daily_wage;
     - negative net pay;
     - a worker with no bank account (warning only).
3. **Closed** ("ปิดงวด" with a paid date, after the transfer).
   - Everything is locked.
   - Advances whose installments are all deducted move to `settled`.
   - Reopening is owner only, needs a reason, writes the audit log, and
     recomputes advance balances automatically because they are derived from lines.

### Settings → เงินเดือน

The pay item editor follows mockup screen 2: add, rename, hide, drag to reorder,
pick a method and set its params, and tick the SSO-base box.

Hiding an item affects future calculations only. Past lines keep their snapshot.

Fixed-per-worker amounts, pay type, daily wage, employee code and bank fields
are edited in the worker form.

### Advances

The UI follows mockup screen 3.

- An employee creates a request for themself from "เบิกล่วงหน้า". An admin can
  create one on a worker's behalf. Both start as `pending`.
- The owner approves or rejects it. An approved advance shows up in the
  `advances` line of each month from its start month until it is fully deducted.
- To skip a month, an admin moves the start month or edits that month's draft
  line. The remaining installments shift later automatically, because the
  balance comes from what was actually deducted.
- The slip shows each advance under the เบิกล่วงหน้า line, e.g. "ค่าตำรวจ งวด
  5/10 · คงเหลือ 5,000".

### Payslip

A5 landscape (mockup screen 1), rendered with the existing `downloadPDF` and
text-layer path. It shows:

- company and tax ID, the period date range and the paid date;
- the worker's name, nickname, position, employee code and masked bank account;
- earnings and deductions side by side (zero lines hidden);
- facts: days worked, leave days, OT hours and holiday shifts;
- year-to-date earnings and SSO from closed periods of the same calendar year;
- net pay in figures and in Thai words;
- the payer's and payee's typed names.

It is available to the employee under "สลิปของฉัน" and to admins per worker. It
replaces `SalarySlipModal`. Slips for old months come from their backfilled lines.

### Bank export

"Export ไฟล์ธนาคาร" is available on a confirmed or closed period. It produces the
upload file for SCB Business Anywhere or KBank payroll: account, name and net
amount per worker, with an option to split by the worker's bank. Workers with no
account are listed and left out.

Formats come from the owner's bank templates (`DOC/KBank_Excel
Template_V2.6.2.xlsm`, `DOC/CPX_Toolkit_Template.xlsm`). They were read
statically and are documented record by record in
`docs/reference/bank-payroll-file-formats.md`, which is the source of truth for
the implementer.

**KBank**
- PCT ("KBank Payroll") pays KBank accounts only. It is a fixed-width `.txt`
  with a 178-char header and a 742-char line per employee.
- PCL ("SMART Payroll") pays other banks. It has an 82-char header and a
  738-char line per employee, including the receiving bank code and branch.
- Amounts are in satang. Lines end with CRLF and there is no trailer.
- The "Single Payment Format" variant puts PCT and PCL in one file. Which layout
  the company is registered for is an open item.

**SCB Business Anywhere (CPX)**
- The file is pipe-delimited UTF-8 with records `HEADER`, `BCHDET`, one `TXNDET`
  per employee, and `TRAILR`.
- PAY pays SCB accounts only and requires the SCB check digit. SPN (next day)
  and SPS (same day) pay any bank and need a 4-digit branch.
- A file holds one product.

**Generator**
- One pure module per bank: `src/lib/bankExport/kbank.js` and `scb.js`.
- Golden tests compare the output byte for byte against layouts built from the
  reference doc.
- KBank output is encoded TIS-620/CP874, because the fixed widths only line up
  in a single-byte Thai encoding.

**New data**
- A tenant bank-export setting stores the company name as registered with the
  bank, the debit account, the fee payer and the registered product per bank.
  For SCB it also stores the fee account and the optional System Reference ID.
- `workers` also gets `bank_branch_code`, which cross-bank transfers need.
- Input is validated in the worker form: account length per bank code and the
  SCB check digit.

**Open items before this task starts.** The rest of job 1 does not depend on
them.
1. Which bank or banks the company pays payroll from.
2. Which product it is registered for: SCB PAY or SPN/SPS; KBank PCT/PCL
   standard or Single Payment Format.
3. Which banks the employees' accounts are in.
4. One real file accepted by each portal, with names and accounts masked, to
   check the output against before going live.

### Fixes to existing code

- Use ÷30 in `workers_with_rate.daily_rate`, `labor_cost_by_site` and
  `ot_cost_by_site`. This lowers site labor cost by about 13% for every month,
  including past months, because these are live views. The owner accepted this.
  Check the `x.*` column freeze on every view that is recreated.
- Fix the month-end range, the recalculation that corrupts net pay, and the
  missing records for workers with no shifts. All three are fixed by moving the
  calculation into the engine and the save into the RPC.
- Delete `src/pages/Payroll.jsx`.
- Update the demo-tenant seed to write lines and periods.

### Migration of existing data

- Seed the default pay items for every tenant.
- Backfill `salary_record_lines` from the old columns of every existing
  `salary_records` row:
  - each old column maps to its default item;
  - `ot_amount` maps to the OT line;
  - `loan_deduction` maps to the กยศ line;
  - zeros are skipped.
- Create a `payroll_periods` row per tenant-month that has records. Months with
  a `paid_date` on every record are created as `closed`, the rest as `draft`.
- `workers.monthly_contribution`: before the backfill, check on CHANG whether
  every worker's value equals 5% of their salary.
  - If yes, สมทบ stays a percent item.
  - If any differ, list them for the owner before choosing.
- The backfill runs as a guarded datafix: dry-run counts and checksums first,
  then verify that Σ lines equals each old net_pay. Rows that do not match are
  reported, not forced.

## Out of scope

- Requesting an advance or checking its status over LINE (job 2).
- Withholding tax and ภ.ง.ด.1, and SSO filing (สปส.1-10) export.
- Batch printing of slips.
- Dropping the old `salary_records` money columns, which happens in a later
  release.

## Testing

- vitest:
  - the golden September test;
  - one unit test per method;
  - rounding edge cases;
  - date ranges for 28-, 29-, 30- and 31-day months under `TZ=Asia/Bangkok`;
  - percent-of-item ordering and cycle rejection;
  - advance installment remainder and settlement.
- SQL, run inside BEGIN/ROLLBACK on CHANG before applying:
  - the period lock trigger;
  - role checks on every RPC;
  - worker RLS: own rows only, never drafts;
  - the backfill dry-run on real data.
- Live check after deploy:
  - calculate October 2026 for the FacadeX tenant;
  - confirm, view one slip as a worker login, and unconfirm;
  - check the demo tenant still resets.

## Open items for the owner

- Bank sample files: SCB Business Anywhere and KBank payroll uploads, plus which
  banks the employees' accounts are in.
- ~~OT ceiled to whole baht~~ confirmed by the owner 2026-10-17.
