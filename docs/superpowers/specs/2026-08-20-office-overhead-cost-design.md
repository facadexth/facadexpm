# Office Assign + Overhead Cost — Design Spec

## Overview

Two related additions to FacadeXPM's Assign (ช่าง scheduling) and HR/Payroll systems:

**A. "ออฟฟิศ" in the bulk Assign wizard.** `office` (🏢 ออฟฟิศ) already exists as a selectable type in the single-cell edit popup (`CellEditPopup.jsx`), but the bulk "+ Assign งาน" wizard (`AssignWizard.jsx`) doesn't offer it — it currently only has งานไซท์/ผลิตที่โรงงาน/ลาป่วย/ลากิจ. Add it for parity.

**B. Automatic overhead cost tracking.** Today, a worker assigned `office` for a day contributes zero cost anywhere in the app (`labor_cost_by_site` only counts `site`/`factory` types). The user wants the labor cost of office days automatically computed and shown as "ค่าใช้จ่ายส่วนกลาง" (overhead/central cost) in HR's payroll tab (ตารางเงินเดือน) — purely as a cost-attribution figure, the same relationship `labor_cost_by_site` already has to site billing: informational, not a payroll deduction or an `expenses` table entry.

## Part A: Office in the Assign Wizard

### Goals

- `AssignWizard.jsx`'s type-picker gains a 5th button: 🏢 ออฟฟิศ, matching `CellEditPopup.jsx`'s existing `TYPE_OPTS` label exactly.
- Like the two leave types (already shipped), selecting ออฟฟิศ skips the site-selection step and writes `site_id: null` — `office` is not in `SITE_TYPES` (`['site', 'factory']`), so this falls out of the same `SITE_TYPES.includes(form.type)` conditional Task 3 already built; no new branching logic needed.

### Non-Goals

- No change to `CellEditPopup.jsx` — it already handles `office` correctly.
- No change to `SITE_TYPES` itself.

### Design

`AssignWizard.jsx`'s type-picker array gains `{ k: 'office', l: '🏢 ออฟฟิศ' }` alongside the existing 4 entries. The existing `SITE_TYPES.includes(form.type)` conditional (site step visibility, submit validation, `site_id` in the row-building loop) already treats any non-site-type type correctly with zero further changes — this is purely adding one more button to an already-generalized picker.

## Part B: Overhead Cost Tracking

### Goals

- The monthly payroll calculation (`handleCalcFromAssign` in `src/pages/HR.jsx`, triggered by the "🔄 คำนวณจาก Assign" button) additionally counts each worker's `office`-type shifts for the selected month and computes an overhead cost using the same formula `labor_cost_by_site` uses for site labor: `(monthly_salary / 26) × office_days`.
- This is persisted on `salary_records` (two new columns: `office_days`, `office_cost`) and displayed in both the calc-preview modal and the saved payroll table (`ตารางเงินเดือน` — the table driven by `visibleRecords`/`useSalary`), as two new columns: "วันออฟฟิศ" and "ค่าใช้จ่ายส่วนกลาง".
- A new KPI card, "ค่าใช้จ่ายส่วนกลางรวม" (total overhead), sits alongside the existing เงินเดือนรวม / OT / ประกันสังคม / จ่ายสุทธิรวม cards at the top of the payroll tab, summing `office_cost` across `visibleRecords` for the selected month — same pattern as the existing `totalBase`/`totalOT`/`totalSSO`/`totalNet` `useMemo`s.

### Non-Goals

- **Does not affect `net_pay`.** A worker's pay is unaffected by how many of their days were office vs. site — this is a cost-attribution report, not a payroll deduction/addition, matching how site/factory labor cost already works today (an informational figure computed from the same daily rate, never subtracted from or added to what the worker is paid).
- **Does not write to the `expenses` table.** No new `expenses` rows are created automatically — explicitly declined by the user in favor of a computed summary, matching `labor_cost_by_site`'s existing read/display-only relationship to the `worker_assignments` data it's derived from.
- No change to `handleCopyPrevMonth` beyond resetting the two new fields to 0 (copying a previous month's payroll doesn't carry over last month's office days — matches how OT/leave already reset to 0 in that flow).
- No new page/tab — surfaces only in HR's existing payroll tab, per the user's explicit choice over Dashboard or Expenses.

### Design

**1. Schema.** `ALTER TABLE salary_records ADD COLUMN office_days NUMERIC DEFAULT 0; ALTER TABLE salary_records ADD COLUMN office_cost NUMERIC DEFAULT 0;`. (`NUMERIC` for `office_days`, not `INT`, because days are counted in 0.5 increments — one shift = 0.5 day — matching how the existing `leave_personal`/`leave_sick` day-counting in `handleCalcFromAssign` already works.)

**2. `handleCalcFromAssign` (src/pages/HR.jsx).** The existing per-worker aggregation loop (`wmap`) that already tracks `leave_sick`/`leave_personal`/`ot_hours` per worker from the month's `worker_assignments` rows gains a parallel `office` counter: `if (a.type === 'office') wmap[a.worker_id].office += 0.5`. The `results` map at the end computes `office_cost = office_days * dr` (`dr` = daily rate, `monthly_salary / 26`, already computed in that loop for the leave deduction) and includes `office_days`/`office_cost` in each result row. `net_pay`'s formula is unchanged — `office_cost` is not added to or subtracted from it.

**3. `handleConfirmCalc` (src/pages/HR.jsx).** The upsert payload to `salary_records` gains `office_days: r.office_days, office_cost: r.office_cost`.

**4. `handleCopyPrevMonth`.** The reset-to-0 block (which already zeroes `ot_amount`, `advance_deduction`, `loan_deduction`, `leave_deduction`, `leave_sick_days`, `leave_personal_days`, `ot_hours`) gains `office_days: 0, office_cost: 0`.

**5. Calc-preview modal table.** Two new columns "วันออฟฟิศ" / "ค่าใช้จ่ายส่วนกลาง" added to the preview table's header and rows, positioned after the existing "โบนัสวันหยุด" column and before "SSO" — same styling convention as the existing count/currency column pairs (e.g. `ลาป่วย`/`หักลา`: a centered count in a neutral/highlight color, a `font-mono` currency cell).

**6. Saved payroll table (ตารางเงินเดือน).** Two new columns "วันออฟฟิศ" / "ค่าใช้จ่ายส่วนกลาง" added to the table's header and `visibleRecords.map` row rendering, positioned after "เงินเดือน" and before "OT" (an "expenses attributed to this worker this month" grouping, ahead of the payroll-deduction columns). `tfoot`'s totals row gains a new `office_cost` sum matching the existing `totalOT`/`totalSSO`/`totalNet` cells' styling.

**7. New KPI card.** A `totalOfficeCost` `useMemo` (`visibleRecords.reduce((s,r)=>s+(r.office_cost||0),0)`, mirroring `totalBase`/`totalNet`/etc. exactly) feeds a new `kpi-card kpi-sm` titled "ค่าใช้จ่ายส่วนกลางรวม", inserted into the existing KPI row alongside เงินเดือนรวม/OT/ประกันสังคม/จ่ายสุทธิรวม.

## Testing

- No new pure-logic function in Part A — `SITE_TYPES.includes(form.type)` is an already-tested, already-generalized conditional; adding a 5th type button that isn't in `SITE_TYPES` needs no new logic, only a new picker entry.
- Part B's `office_cost = office_days * dr` calculation is the same formula shape as the existing, already-shipped `leave_deduction = leave_personal * dr` and `ot = ot_hours * dr / 8 * 1.5` calculations in `handleCalcFromAssign` — verification is `npm test`/`npm run build` regression plus a documented, disclosed manual-browser-check limitation (no test login credentials available to implementer/reviewer subagents this session, consistent with every other UI feature built this session).
- Manual verification checklist for Part A: selecting ออฟฟิศ in the main wizard hides the site-selection step and successfully submits an office assignment for multiple workers/days at once; the resulting rows show up in the day grid the same way a `CellEditPopup`-created office row does today.
- Manual verification checklist for Part B: assigning a worker `office` for N days in a month, then clicking "🔄 คำนวณจาก Assign" for that month, shows `office_days = N × 0.5` (per shift) and a correctly-computed `office_cost` in the preview modal; confirming the calc persists both fields to `salary_records` and displays them in the saved payroll table and the new KPI card; `net_pay` is unaffected by the presence of office days.
