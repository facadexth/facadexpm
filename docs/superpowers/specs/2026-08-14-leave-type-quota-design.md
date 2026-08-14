# Leave Type Split (Sick / Personal) + Quota — Design

## Problem

`worker_assignments.type = 'leave'` doesn't distinguish sick leave
(ลาป่วย) from personal leave (ลากิจ). `workers.annual_leave_days` already
exists as a per-worker quota field, but nothing in the app ever reads or
enforces it — it's stored and displayed, never checked against actual
usage. The request: split leave into two types, and make personal leave
consume the quota while sick leave does not.

## Pay Deduction Rule (confirmed)

Sick leave (ลาป่วย) is **paid leave** — matching Thai labor law (paid sick
leave, up to the legal cap) — so it does **not** deduct pay. Personal leave
(ลากิจ) keeps the existing deduction behavior. The two leave types now
diverge on both axes:

| | Deducts pay? | Counts against quota? |
|---|---|---|
| `leave_sick` | No | No |
| `leave_personal` | Yes (`leave_days × monthly_salary/26`) | Yes (`annual_leave_days`) |

This replaces the single `leave_deduction` accumulator in
`Payroll.jsx`/`HR.jsx` with logic that only sums `leave_personal` days into
the deduction — `leave_sick` days are counted (for display / record-
keeping) but excluded from the money formula entirely.

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
  splits into two accumulators, `leave_sick_days` and
  `leave_personal_days`, instead of one `leave`. Only
  `leave_personal_days` feeds `leave_deduction`
  (`leave_personal_days × monthly_salary/26`); `leave_sick_days` is
  carried through to the results row for display (e.g. a "ลาป่วย (จ่าย
  เต็ม)" column) but excluded from any deduction math. `net_pay` formula
  becomes `base_salary − social_security − leave_deduction + ot_amount
  + holiday_bonus` (holiday_bonus from the companion company-holidays
  design).

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
