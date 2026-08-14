# OT Decoupled From Shift — Design

## Problem

OT (overtime) is currently stored as an `ot_hours` column on `worker_assignments`,
one row per `(worker_id, date, shift)` where `shift` is `morning` or `evening`.
This forces every OT entry to piggyback on an existing morning/evening shift row:

- A worker can't log OT without first having a morning or evening assignment
  that day, even if the OT itself happens outside those blocks.
- Every `type IN ('site','factory')` shift row automatically contributes
  `0.5 × (monthly_salary / 26)` to that site's labor cost (see `DayView.jsx`,
  `Assign.jsx`'s `costBySite`). If a shift row is used only to carry an OT
  value, it silently double-counts a half-day of labor cost the worker didn't
  actually work.
- OT can currently only be entered when `type === 'site'` (see
  `CellEditPopup.jsx`), not `factory`.

## Goal

Let OT be recorded independently of the morning/evening shift structure —
tied to a site (for per-site cost attribution) and a time range, not to
"which half of the day."

## Data Model

New table, separate from `worker_assignments`:

```sql
CREATE TABLE worker_ot (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id   UUID NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  site_id     UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  date        DATE NOT NULL,
  start_time  TIME NOT NULL,
  end_time    TIME NOT NULL,
  ot_hours    NUMERIC NOT NULL,   -- computed from start/end at save time, rounded to nearest 0.5
  notes       TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (worker_id, date)
);
```

Design decisions:

- **Separate table, not a third `shift` value.** OT is a different concept
  from "which half of the day was worked" — it's always tied to a site
  (never `leave`/`office`/`holiday`), always has a time range, and is capped
  at one entry per worker per day. Reusing `worker_assignments` would mean
  relaxing its `shift` CHECK constraint and teaching `DayView`/`GridView` —
  which assume every row is `morning` or `evening` for column layout — to
  filter out a third kind of row. A separate table keeps the existing
  shift-grid code untouched.
- **`site_id` is a plain FK, not type-specific.** It works the same whether
  the worker's regular shift that day was `type='site'` or `type='factory'`
  — matching how `labor_cost_by_site` already attributes both shift types to
  a site without distinguishing between them. No `type` column is needed on
  `worker_ot`.
- **`UNIQUE (worker_id, date)`** enforces "at most one OT entry per worker
  per day" at the DB level, matching the confirmed requirement. Saves use
  `upsert(..., { onConflict: 'worker_id,date' })`, same pattern as
  `worker_assignments`.
- **`ot_hours` is stored, not computed on read.** Rounding to the nearest
  0.5 hour happens once at save time (`Math.round((end-start)/60/0.5)*0.5`
  in hours), so Payroll/HR can `SUM(ot_hours)` directly without re-deriving
  the rounding rule in multiple places.
- **No overnight OT.** `end_time` must be after `start_time` on the same
  calendar day; OT crossing midnight is out of scope for this design.
- **Historical `worker_assignments.ot_hours` is left as-is, not migrated.**
  Past payroll runs already used it; changing it retroactively would alter
  historical payroll numbers. Going forward, Payroll/HR sum OT from *both*
  sources (see below), so old and new data both count.

## UI/UX

**Entry point:** a "+OT" button inside the existing `CellEditPopup` (opened
by clicking a worker's morning or evening cell) — not a separate popup
reached a different way. The OT being added/edited belongs to the worker+date
the popup is already open for, independent of which shift (morning/evening)
was clicked to open it.

Form fields inside the +OT section:

- ไซท์งาน — `SearchableSelect`, defaults to the site of the shift that was
  clicked (if `type` is `site`/`factory`), otherwise required with no default
- เวลาเริ่ม / เวลาจบ — `<input type="time">` × 2
- Computed hours shown read-only (e.g. "= 2.5 ชม.") right below the time
  inputs, recalculated live, rounded to nearest 0.5
- ลบ OT — shown only if an OT entry already exists for this worker+date

Validation: site required, both times required, `end_time > start_time`.

## Cost Attribution (per-site cards)

`DayView.jsx`'s per-site card and `Assign.jsx`'s `costBySite` aggregation
currently show one labor figure per site, computed as
`0.5 × (monthly_salary/26)` per site/factory shift. OT must **not** be
folded into that figure using the same half-day math — it's real
incremental pay, calculated purely on hours:

```
ot_cost = ot_hours × (monthly_salary / 26 / 8) × 1.5
```

Site cost cards show OT as its own line, separate from "ค่าแรง", e.g.:

```
แรง 3,500 · เดินทาง 800 · OT 450
รวม 4,750
```

`รวม` (total) sums all three. This is the same formula Payroll.jsx/HR.jsx
already use for OT pay — no new formula, just applied per-site instead of
per-worker-per-month.

## Other Surfaces

- **`DayView.jsx`** — within each site's card, an OT line listing who did OT
  there that day: `⚡ OT: ชาย (17:30–19:45, 2.5ชม.)`.
- **`GridView.jsx`** (week/month) — a small ⚡ indicator on a worker's day
  cell when they have an OT entry that day. Clicking the cell opens the same
  `CellEditPopup` (with the +OT section already populated).
- **`lineExport.js`** (copy for LINE) — OT shown as its own line per site,
  after the เช้า/บ่าย lines, rather than appended inline to a worker's shift
  entry as it is today: `⚡ OT: ชาย (17:30-19:45)`.
- **`Payroll.jsx` / `HR.jsx`** — OT totals per worker per month become
  `SUM(worker_assignments.ot_hours WHERE type='site') + SUM(worker_ot.ot_hours)`,
  fetched as an additional query against `worker_ot` for the same date range
  already used for `worker_assignments`, merged before the existing
  `ot_hours × hourly_rate × 1.5` calculation.

## Out of Scope

- Migrating historical `ot_hours` off `worker_assignments` into `worker_ot`.
- Multiple OT entries per worker per day.
- OT spanning midnight.
- Leave-type quotas (sick/personal leave) — tracked separately as its own
  design, not part of this change.

## Testing

No automated test suite exists in this project (Vite/React app with manual
verification via dev server + Supabase MCP `execute_sql` round-trips, as
used throughout this session). Verification plan:

1. `execute_sql` insert/rollback against `worker_ot` to confirm the schema,
   unique constraint, and FK behavior.
2. Manual click-through in the dev server: open a cell, add OT via +OT,
   confirm it appears in DayView/GridView/costBySite/lineExport, confirm
   editing and deleting work, confirm the unique-per-day constraint blocks
   a second entry for the same worker+date (surfaces as a clear error, not
   a silent overwrite of unrelated data).
3. Confirm Payroll/HR OT totals for a worker with both legacy
   (`worker_assignments.ot_hours`) and new (`worker_ot`) entries in the same
   month sum correctly.
