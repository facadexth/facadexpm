# Company Holiday Calendar + Holiday Work Premium — Design

## Problem

There's no company-wide holiday calendar. `worker_assignments.type` has a
`'holiday'` value, but it's per-worker-per-day — HR would have to manually
mark every worker as on holiday, for every holiday, individually. There's
also no way to pay a premium when someone genuinely works (has a site/
factory shift) on a day that turns out to be a public/company holiday.

## Scope Decision

Confirmed with the user: this feature does **not** touch
`worker_assignments` or auto-mark anyone. A worker with no assignment on a
holiday date is left alone — no row created, no action taken. The feature
is purely: (1) a calendar HR can maintain, (2) a visual marker on the
Assign grid so the date is visibly a holiday, and (3) a pay premium added
to Payroll/HR for whoever happens to have a site/factory shift on that
date.

## Data Model

```sql
CREATE TABLE company_holidays (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date       DATE NOT NULL UNIQUE,
  name       TEXT NOT NULL,           -- เช่น "วันแรงงาน", "วันปีใหม่"
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

One row per holiday date, company-wide (not per-worker, not per-site).

**Holiday pay multiplier** is configurable, not hardcoded — reuses the
existing `app_settings` key/value table (same mechanism already used for
`travel_rate_per_km`), under a new key `holiday_pay_multiplier` (default
`'1.5'`). The control to edit it lives in the **HR tab** (not Settings),
per the user's explicit request.

## Holiday Pay Premium Formula

For every site/factory shift (morning or evening) a worker worked whose
`date` matches a `company_holidays.date`, add a bonus to that worker's
`net_pay`:

```
holiday_bonus = holiday_shift_count × (monthly_salary / 26) × 0.5 × holiday_pay_multiplier
```

This mirrors the OT formula's shape (`portion × rate × multiplier`) — here
"portion" is the 0.5-day-per-shift figure already used everywhere else in
this codebase for labor cost, and "multiplier" is the configurable
`holiday_pay_multiplier` (default 1.5). Example: monthly salary 26,000,
worked one shift on a holiday → `26000/26 × 0.5 × 1.5 = 750` baht bonus.

This is **real additional pay** — it's added into `net_pay` in both
`Payroll.jsx` and `HR.jsx`'s "คำนวณจาก Assign" calculation, shown as its
own line item (e.g. "โบนัสวันหยุด") separate from OT, matching how OT is
already broken out from base salary and leave deduction.

## UI Changes

- **HR tab**: a small "วันหยุดประจำปี" section — list of configured
  holiday dates (date + name), add/delete controls, and the holiday pay
  multiplier input (defaults to 1.5, editable).
- **Assign grid header** (`GridView.jsx`'s day-column `<th>`, and
  `DayView.jsx`'s day header): a small marker (e.g. 🎌) on dates that are
  configured holidays, with the holiday's name as a tooltip.
- **Payroll.jsx / HR.jsx** calculation preview and saved record: new
  "โบนัสวันหยุด" column/line, alongside the existing OT column.

## Data Flow

`handleCalcFromAssign` (in both Payroll.jsx and HR.jsx) already fetches
`worker_assignments` for the month and `worker_ot` for OT. It additionally
fetches `company_holidays` rows whose `date` falls in the same month,
builds a `Set` of holiday date strings, and — while iterating the
`worker_assignments` rows already being summed for leave/OT — also counts,
per worker, how many `type IN ('site','factory')` shifts have a `date` in
that holiday-date set. That count feeds the formula above.

## Out of Scope

- Auto-marking workers as on holiday when they have no assignment.
- Recurring/annual holidays (e.g. "every Jan 1") — each year's dates are
  entered individually; no auto-repeat logic.
- Retroactively recalculating already-saved `salary_records` when a
  holiday is added/removed after the fact — same existing limitation as
  OT/leave: "คำนวณจาก Assign" must be re-run manually.
