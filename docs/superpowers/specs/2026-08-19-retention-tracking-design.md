# Retention Tracking — Design Spec

## Problem

Client retention (เงินประกันผลงาน) withheld from income/billing is already tracked
as an amount (`incomes.retention`), but there's no concept of *when* it's due
back, and no way to see or act on that across the app. Users currently have
no visibility into upcoming retention due dates, and no record of whether a
site's retention has actually been paid back.

A parallel concept already exists for labor subcontractor retention
(`labor_contracts`/`labor_payments`), where the due date is a hardcoded
`site.end_date + 6 months` — not configurable, and specific to money FacadeX
withholds from subcontractors. This spec is the client-side equivalent (money
clients withhold from FacadeX), and deliberately does **not** touch the labor
retention system, which is unrelated and already works.

## Goals

- Let each site have its own retention period (days), since real contract
  terms vary — no single hardcoded number works for every client.
- Compute a retention due date per site once the site has both an end date
  and a configured retention period.
- Surface upcoming due dates on the Dashboard so they aren't easy to miss.
- Provide a dedicated place to see every site's retention status and record
  when it's actually been paid back.

## Non-Goals

- No change to labor subcontractor retention (`labor_contracts`,
  `labor_payments`, the existing `contractor_summary` view's hardcoded
  6-month logic) — separate system, separate money flow, out of scope.
- No per-invoice retention due dates. Retention is tracked and released as
  one lump sum per site, anchored to the site's own end date — not per
  income row. A site with retention split across many invoices still gets
  exactly one due date and one release action.
- No partial-release tracking (e.g. "60% of retention released so far"). The
  release action is a single toggle per site: not released → released, with
  a release date. If partial releases turn out to be a real need later,
  that's a separate follow-up, not built here.
- No automated reminders (email/LINE/etc.) — the Dashboard card is the
  entire notification mechanism for this iteration.

## Design

### 1. Data model

New migration, `sites` table:

```sql
ALTER TABLE sites ADD COLUMN default_retention_period_days INTEGER;
ALTER TABLE sites ADD COLUMN retention_released BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE sites ADD COLUMN retention_released_date DATE;
```

`default_retention_period_days` is nullable with no default — deliberately
not guessing a value for existing sites (this is financial data; a wrong
guessed due date is worse than no due date). A site with this left unset
simply has no computed due date anywhere in the feature until someone sets
it.

New view, `site_retention_summary` (`WITH (security_invoker = true)`,
matching every other view in this app's post-2026-08-18 convention):

```sql
CREATE VIEW site_retention_summary WITH (security_invoker = true) AS
SELECT
  s.id AS site_id,
  s.site_number,
  s.name,
  s.end_date,
  s.default_retention_period_days,
  s.retention_released,
  s.retention_released_date,
  COALESCE(SUM(i.retention), 0) AS total_retention,
  CASE
    WHEN s.end_date IS NOT NULL AND s.default_retention_period_days IS NOT NULL
    -- DATE + INTERVAL yields a timestamp, not a date -- cast back so
    -- due_date doesn't carry a spurious 00:00:00 time component into the UI.
    THEN (s.end_date + (s.default_retention_period_days || ' days')::INTERVAL)::DATE
    ELSE NULL
  END AS due_date
FROM sites s
LEFT JOIN incomes i ON i.site_id = s.id
GROUP BY s.id, s.site_number, s.name, s.end_date, s.default_retention_period_days,
         s.retention_released, s.retention_released_date;
```

Rows with `total_retention = 0` (no retention ever withheld for that site)
are still returned by this view — the UI filters them out (see section 3),
keeping the SQL simple rather than pushing a business-rule `HAVING` into the
view itself.

### 2. Sites form (`src/pages/Sites.jsx`)

Add a "ระยะเวลา retention (วัน)" number input immediately after the existing
`default_retention_pct` field (same `EMPTY_FORM`/`handleSave` pattern as the
three existing default-percentage fields — nullable, empty string → `null`
on save, matching lines 272-274's existing pattern exactly).

### 3. Dashboard KPI card (`src/pages/Dashboard.jsx`)

New small KPI card, same visual family as the existing KPI row. Query
`site_retention_summary`, filter client-side to rows where:
- `total_retention > 0`
- `retention_released = false`
- `due_date IS NOT NULL`
- `due_date <= today + 30 days`

Card shows the count of matching sites and the sum of their
`total_retention`. Clicking it calls `navigateTo('retention')` (the existing
cross-tab navigation helper already used throughout the app) to jump to the
new tab below.

### 4. New "Retention" tab

New page `src/pages/Retention.jsx`, new entry in `App.jsx`'s `TABS`/
`renderPage()`/lazy-import list (`id: 'retention', label: '🔒 Retention',
minRole: 'ADMIN', module: null` — core feature, not module-gated, same tier
as Income/Expenses). Lazy-loaded like the other 12 non-Dashboard pages
(consistent with the 2026-08-19 code-splitting work).

Table, one row per site from `site_retention_summary` where
`total_retention > 0`, columns: ไซท์งาน (name), วันจบงาน (end_date),
ยอด Retention (total_retention), วันครบกำหนด (due_date, or "ยังไม่ได้ตั้งค่า"
if null), สถานะ (badge: "คืนแล้ว" if released, "เกินกำหนด" if overdue,
"ใกล้ครบกำหนด" if due within 30 days, "รอครบกำหนด" otherwise, "ยังไม่ได้ตั้ง
ระยะเวลา" if `due_date` is null), and an action column with "✅ บันทึกว่า
คืนแล้ว" (opens a small confirm dialog to pick the release date, defaulting
to today) for unreleased rows, or the recorded release date as plain text
for released ones.

Default sort: unreleased rows first (by due_date ascending, nulls last),
released rows last.

## Testing

- Migration applies cleanly; `default_retention_period_days` defaults to
  `NULL` on existing rows, `retention_released` defaults to `false`.
- `site_retention_summary` returns correct `due_date` for a site with both
  `end_date` and `default_retention_period_days` set, and `NULL` for a site
  missing either.
- `total_retention` correctly sums `incomes.retention` across multiple
  income rows for the same site (this is exactly the fan-out risk this
  app already hit once before, in `site_financial_summary` — verify this
  new view doesn't introduce the same join-multiplication bug by testing
  a site with both multiple incomes AND confirming the aggregation is a
  simple single-table SUM via one LEFT JOIN, not a multi-join fan-out).
- Dashboard KPI card count/total matches manual calculation against a
  known set of test sites (some due soon, some not, some already released).
- Marking a site's retention as released updates `retention_released`/
  `retention_released_date`, and the site immediately drops out of the
  Dashboard KPI card's count (both the "due soon" filter and, more
  fundamentally, `retention_released = false` filter).
- `npm test` (existing Vitest suite) continues passing unmodified — no
  existing tests touch this area, so this is a regression check only.
- Manual click-through of the new Retention tab and the release-confirm
  dialog (this repo has no component-level test infra; matches how every
  other page in this app is verified).

## Rollout

Single feature, no independent sub-projects. Migration applied directly to
the live database (same workflow as every other schema change this
session), frontend changes committed and deployed via the existing
build/push/cPanel-or-zip-fallback pipeline.
