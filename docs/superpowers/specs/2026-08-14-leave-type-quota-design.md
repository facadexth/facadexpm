# Leave Type Split (Sick / Personal) + Quota — Design

## Problem

`worker_assignments.type = 'leave'` doesn't distinguish sick leave
(ลาป่วย) from personal leave (ลากิจ). `workers.annual_leave_days` already
exists as a per-worker quota field, but nothing in the app ever reads or
enforces it — it's stored and displayed, never checked against actual
usage. The request: split leave into two types, and make personal leave
consume the quota while sick leave does not.

## OPEN QUESTION — needs your confirmation before implementation

The existing payroll formula deducts pay for **any** leave day:
`leave_deduction = leave_days × (monthly_salary / 26)`, regardless of
reason. You asked for sick leave to not deduct from the **quota** — but
quota (a day-count limit) and **pay deduction** (money taken off net_pay)
are two different things, and you didn't say whether sick leave should
also stop reducing pay.

This design currently assumes: **the pay deduction formula stays exactly
as it is today for both leave types — only quota tracking changes.**
Sick leave and personal leave both still reduce `net_pay` by
`leave_days × (monthly_salary / 26)`, same as now. Only personal leave
additionally counts against `annual_leave_days`.

If sick leave should actually be **paid leave** (no pay deduction, only
personal leave deducts pay), say so before this gets implemented — that
changes the payroll formula, not just the quota-tracking logic, and I did
not want to guess on a change that affects real payroll amounts.

## Data Model Changes

Extend `worker_assignments.type`'s CHECK constraint to add two new values,
**keeping** the old `'leave'` value (don't remove it — historical rows
already use it, and per this codebase's established pattern for this kind
of change, old data is left as-is rather than migrated):

```sql
ALTER TABLE worker_assignments DROP CONSTRAINT worker_assignments_type_check;
ALTER TABLE worker_assignments ADD CONSTRAINT worker_assignments_type_check
  CHECK (type IN ('site','leave','office','holiday','subcontract','factory','leave_sick','leave_personal'));
```

Going forward, the UI only offers `leave_sick` / `leave_personal` as
choices (the old undifferentiated `leave` type option is removed from the
picker, mirroring how the OT decoupling work removed the old per-shift OT
input from the UI while leaving historical data alone).

No new table needed for quota — `workers.annual_leave_days` (already
exists) is the quota limit. "Quota used" is computed on demand: count of
`type = 'leave_personal'` assignment-days (0.5 per shift, matching the
existing leave-day counting convention) for that worker within the
current calendar year.

## UI Changes

- **`CellEditPopup.jsx`**: `TYPE_OPTS` replaces the single "🏖️ ลา" button
  with two buttons: "🤒 ลาป่วย" (`leave_sick`) and "🏖️ ลากิจ"
  (`leave_personal`).
- **`src/pages/assign/constants.js`**: `TYPE_COLOR`, `TYPE_LABEL`,
  `TYPE_LEGEND` each get entries for both new types (distinct colors so
  they're visually distinguishable in the grid — sick leave and personal
  leave shouldn't look identical at a glance).
- **`src/pages/assign/lineExport.js`**: `OTHER_TYPE_LABEL` gets both new
  types' Thai labels for the copy-for-LINE output.
- **HR tab, worker list**: next to the existing `annual_leave_days`
  column, add a computed "ใช้ไปแล้ว (ปีนี้)" (used this year) and
  "คงเหลือ" (remaining) column, sourced from the personal-leave-day count
  described above. Sick leave is not counted against the quota, so it
  doesn't appear in this column (no cap to display it against).
- **`Payroll.jsx` / `HR.jsx`**: `handleCalcFromAssign`'s leave counting
  splits into two accumulators (`leave_sick`, `leave_personal`) instead of
  one `leave`. Under the current assumption above, both still feed the
  same `leave_deduction` formula — the split only matters for the
  HR-tab quota display, not for this specific calculation. If the "sick
  leave shouldn't deduct pay" question above resolves differently, this
  is the formula that changes.

## Data Flow

Quota usage is a **read-only computed value**, not a stored counter — it's
derived by querying `worker_assignments` for
`type = 'leave_personal' AND date BETWEEN <year-start> AND <year-end>`
per worker, each time the HR tab's worker list renders (or on demand via a
dedicated hook `useLeaveQuotaUsage(year)`), rather than incrementing/
decrementing a stored balance. This avoids the class of bug where a stored
counter drifts out of sync with the actual assignment rows (e.g. if a
leave day is later deleted or edited) — matching how `costBySite` and
other cost aggregates in this codebase are already always computed fresh
from source rows, never cached as a mutable running total.

## Out of Scope

- Enforcing the quota (blocking a personal-leave assignment once the
  quota is exhausted) — this design only **displays** used/remaining, it
  doesn't prevent over-booking. Confirm if blocking is actually wanted;
  it weakens gracefully to "just informational" if not specified.
- A cap/quota on sick leave days.
- Carrying over unused quota to the next year, or pro-rating quota for
  workers who joined mid-year.
