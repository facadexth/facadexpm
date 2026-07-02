# Assign Page Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the Assign page with Day/Week/Month views, a multi-day multi-worker assignment wizard, morning/evening half-day shifts, a new "factory production" assignment type, per-site-per-day travel cost, plus Google Maps links and a wider popup.

**Architecture:** React + Vite SPA talking directly to Supabase (no backend). DB changes are SQL migrations applied to the live project via the Supabase MCP / SQL editor. New shift model splits each assignment into morning/evening half-day rows. Travel cost is derived per site from site distance × 2 × a configurable rate. UI changes are in `src/pages/Assign.jsx`, `src/pages/Sites.jsx`, `src/pages/Settings.jsx`, `src/components/Modal.jsx`.

**Tech Stack:** React 18, Vite 5, Supabase JS, date-fns, existing `SearchableSelect`/`Modal` components.

## Global Constraints

- No test runner exists — "verify" = run the exact SQL/`npm run build`/visual check named in the step. Never claim pass without running it.
- All DB migrations must be defensive & idempotent: `ADD COLUMN IF NOT EXISTS`, `CREATE OR REPLACE VIEW`, guarded constraint drops. They run on a **live DB with real data**.
- `supabase/schema.sql` is stale — never trust it for column names; confirm against live schema (Task 1).
- Shift model: `shift ∈ ('morning','evening')`, 1 shift = 0.5 working day.
- Assignment types: `site`,`factory`,`subcontract`,`office`,`leave`,`holiday`. Labor cost counts `type IN ('site','factory')`. Travel counts `type = 'site'` only.
- Travel cost per site per day = `distance_km × 2 × travel_rate_per_km`, counted once per distinct date that has a `site` assignment.
- Week starts Monday; Sunday shown but disabled for assignment.
- Preserve historical labor totals: migration splits each existing row into morning+evening (OT kept on morning only).
- Keep existing Thai UI copy style and inline-style conventions already in the files.
- Commit after each task. Repo may not be initialized — if `git status` fails, skip commits and note it; do not init without asking.

---

## Phase A — Database

### Task 1: Introspect & record the live schema

**Files:**
- Create: `docs/superpowers/plans/_schema-actuals.md` (scratch record of real column names/constraints)

**Interfaces:**
- Produces: confirmed real column list for `sites`, `worker_assignments`, real definition of view `labor_cost_by_site`, and how `Settings.jsx` persists values (table name + shape).

- [ ] **Step 1: Read how the app connects & how Settings persists**

Read `src/lib/supabase.js` and `src/pages/Settings.jsx`. Determine whether settings are stored in a DB table (name it) or elsewhere. Record findings.

- [ ] **Step 2: Query live schema via Supabase MCP (supabase skill)**

Use the `supabase:supabase` skill / Supabase MCP to run:

```sql
select column_name, data_type from information_schema.columns
where table_name = 'worker_assignments' order by ordinal_position;

select column_name, data_type from information_schema.columns
where table_name = 'sites' order by ordinal_position;

select conname, pg_get_constraintdef(oid)
from pg_constraint where conrelid = 'worker_assignments'::regclass;

select pg_get_viewdef('labor_cost_by_site', true);
```

- [ ] **Step 3: Record actuals**

Write the confirmed columns, the current unique constraint name on `worker_assignments`, whether `ot_hours` exists, the real `sites` location/distance columns, and the settings storage into `_schema-actuals.md`. Every later Task A migration must match these names.

- [ ] **Step 4: Commit** (`docs: record live schema actuals for assign redesign`)

---

### Task 2: Migration — shift column, factory type, unique constraint, data split

**Files:**
- Create: `supabase/migrations/2026-07-02-01-assign-shifts.sql`

**Interfaces:**
- Consumes: constraint name + `ot_hours` presence from Task 1.
- Produces: `worker_assignments.shift`, type CHECK incl. `factory`, unique `(worker_id,date,shift)`, every historical row duplicated into morning+evening.

- [ ] **Step 1: Write the migration**

Use the real constraint name from Task 1 in place of `<UNIQUE_CONSTRAINT_NAME>`.

```sql
BEGIN;

-- 1. shift column (default morning so existing rows become the morning half)
ALTER TABLE worker_assignments
  ADD COLUMN IF NOT EXISTS shift TEXT NOT NULL DEFAULT 'morning'
  CHECK (shift IN ('morning','evening'));

-- 2. allow 'factory' type
ALTER TABLE worker_assignments DROP CONSTRAINT IF EXISTS worker_assignments_type_check;
ALTER TABLE worker_assignments
  ADD CONSTRAINT worker_assignments_type_check
  CHECK (type IN ('site','leave','office','holiday','subcontract','factory'));

-- 3. duplicate every existing row into an evening half (ot kept on morning only)
INSERT INTO worker_assignments (worker_id, site_id, date, type, ot_hours, notes, shift)
SELECT worker_id, site_id, date, type, 0, notes, 'evening'
FROM worker_assignments
WHERE shift = 'morning'
ON CONFLICT DO NOTHING;

-- 4. swap unique constraint to include shift
ALTER TABLE worker_assignments DROP CONSTRAINT IF EXISTS <UNIQUE_CONSTRAINT_NAME>;
ALTER TABLE worker_assignments
  ADD CONSTRAINT worker_assignments_worker_date_shift_key
  UNIQUE (worker_id, date, shift);

COMMIT;
```

If `ot_hours` does not exist per Task 1, drop it from the INSERT column list.

- [ ] **Step 2: Apply via Supabase MCP and verify the split**

```sql
-- expect: every (worker_id,date) has exactly 2 rows now
select count(*) filter (where shift='morning') as am,
       count(*) filter (where shift='evening') as pm
from worker_assignments;
```
Expected: `am = pm`.

- [ ] **Step 3: Verify no OT double-count**

```sql
select coalesce(sum(ot_hours),0) from worker_assignments where shift='evening';
```
Expected: `0`.

- [ ] **Step 4: Commit** (`feat(db): add shift half-days + factory type to worker_assignments`)

---

### Task 3: Migration — sites distance_km + map_url

**Files:**
- Create: `supabase/migrations/2026-07-02-02-sites-distance-map.sql`

**Interfaces:**
- Produces: `sites.distance_km NUMERIC`, `sites.map_url TEXT`.

- [ ] **Step 1: Write migration**

```sql
ALTER TABLE sites ADD COLUMN IF NOT EXISTS distance_km NUMERIC;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS map_url TEXT;
```

- [ ] **Step 2: Apply & verify**

```sql
select column_name from information_schema.columns
where table_name='sites' and column_name in ('distance_km','map_url');
```
Expected: 2 rows.

- [ ] **Step 3: Commit** (`feat(db): add distance_km and map_url to sites`)

---

### Task 4: Migration — travel rate setting

**Files:**
- Create: `supabase/migrations/2026-07-02-03-travel-rate.sql`

**Interfaces:**
- Consumes: settings storage shape from Task 1.
- Produces: a persisted `travel_rate_per_km` value (default 20), readable/writable by the app.

- [ ] **Step 1: Write migration matching the real settings store**

If Task 1 found a key/value settings table (e.g. `app_settings(key,value)`):

```sql
INSERT INTO app_settings (key, value)
VALUES ('travel_rate_per_km', '20')
ON CONFLICT (key) DO NOTHING;
```

If no settings table exists, create one:

```sql
CREATE TABLE IF NOT EXISTS app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
INSERT INTO app_settings (key, value) VALUES ('travel_rate_per_km','20')
ON CONFLICT (key) DO NOTHING;
```

- [ ] **Step 2: Apply & verify**

```sql
select value from app_settings where key='travel_rate_per_km';
```
Expected: `20`.

- [ ] **Step 3: Commit** (`feat(db): add travel_rate_per_km setting`)

---

### Task 5: Migration — rewrite labor_cost_by_site view + travel view

**Files:**
- Create: `supabase/migrations/2026-07-02-04-cost-views.sql`

**Interfaces:**
- Consumes: real current viewdef from Task 1 (keep its output columns; only change day math + WHERE + add factory).
- Produces: `labor_cost_by_site` with half-day counting; `site_travel_cost(site_id, travel_days, distance_km, travel_cost)`.

- [ ] **Step 1: Write view migration**

Preserve the existing SELECT column set from Task 1; the changes are `COUNT(*)*0.5` and `type IN ('site','factory')`.

```sql
CREATE OR REPLACE VIEW labor_cost_by_site AS
SELECT
  wa.site_id, s.name AS site_name, s.site_number,
  wa.worker_id, w.name AS worker_name, w.nickname,
  COUNT(*) * 0.5 AS days_worked,
  ROUND(w.monthly_salary / 26 * (COUNT(*) * 0.5), 2) AS labor_cost
FROM worker_assignments wa
JOIN workers w ON wa.worker_id = w.id
JOIN sites s   ON wa.site_id = s.id
WHERE wa.type IN ('site','factory')
GROUP BY wa.site_id, s.name, s.site_number, wa.worker_id, w.name, w.nickname, w.monthly_salary;

-- travel: one trip per distinct date that has a 'site' assignment
CREATE OR REPLACE VIEW site_travel_cost AS
SELECT
  wa.site_id,
  COUNT(DISTINCT wa.date) AS travel_days,
  s.distance_km,
  ROUND(COUNT(DISTINCT wa.date) * COALESCE(s.distance_km,0) * 2
        * (SELECT value::numeric FROM app_settings WHERE key='travel_rate_per_km'), 2) AS travel_cost
FROM worker_assignments wa
JOIN sites s ON wa.site_id = s.id
WHERE wa.type = 'site'
GROUP BY wa.site_id, s.distance_km;
```

- [ ] **Step 2: Apply & verify totals unchanged for labor**

```sql
select site_id, sum(labor_cost) from labor_cost_by_site group by site_id order by site_id;
```
Expected: matches pre-migration labor totals (half-day count × 2 rows = same as before).

- [ ] **Step 3: Verify travel view returns rows**

```sql
select * from site_travel_cost order by travel_cost desc limit 5;
```
Expected: rows with `travel_cost` computed (0 where distance_km is null).

- [ ] **Step 4: Commit** (`feat(db): half-day labor view + site_travel_cost view`)

---

## Phase B — Small UI wins (independent, low risk)

### Task 6: Modal width fix + SearchableSelect overflow guard

**Files:**
- Modify: `src/components/Modal.jsx` (support responsive/auto width; don't hard-cap)
- Modify: `src/components/SearchableSelect.jsx` (confirm ellipsis+title on trigger — already present; verify)

**Interfaces:**
- Produces: `Modal` accepts `maxWidth` but also never overflows viewport (`width: min(maxWidth, 92vw)`), body wraps long content.

- [ ] **Step 1: Read Modal.jsx** to see current width handling.

- [ ] **Step 2: Change modal container width** to `width: min(<maxWidth>px, 92vw)` and ensure `word-break`/wrapping for long titles (title uses ellipsis with `title` attr).

- [ ] **Step 3: Verify build** — `npm run build` → Expected: built, no errors.

- [ ] **Step 4: Visual check** — open Assign wizard with a long site name; confirm no horizontal overflow.

- [ ] **Step 5: Commit** (`fix(ui): responsive modal width, no overflow on long names`)

---

### Task 7: Sites — distance_km + map_url fields & 📍 button

**Files:**
- Modify: `src/pages/Sites.jsx` (EMPTY_FORM, SiteForm inputs, handleSave payload, table cell button)

**Interfaces:**
- Consumes: `sites.distance_km`, `sites.map_url` (Task 3).
- Produces: form persists both; table shows 📍 link when `map_url` present.

- [ ] **Step 1: Add to `EMPTY_FORM`**: `distance_km: '', map_url: ''`.

- [ ] **Step 2: Add inputs** in SiteForm (near location): number input "ระยะทางจากโรงงาน (กม.)" → `distance_km`; text input "ลิงก์ Google Maps" → `map_url`.

- [ ] **Step 3: Add to `handleSave` payload**: `distance_km: parseFloat(form.distance_km) || null, map_url: form.map_url || null`.

- [ ] **Step 4: Add 📍 button** in the site name cell: `{s.map_url && <a className="btn btn-sm btn-ghost" href={s.map_url} target="_blank" rel="noreferrer" title="เปิดแผนที่">📍</a>}`.

- [ ] **Step 5: Verify build** → `npm run build`. Then visual: edit a site, set distance + a maps URL, save, confirm 📍 opens it.

- [ ] **Step 6: Commit** (`feat(sites): distance + google maps link`)

---

### Task 8: Settings — editable travel rate

**Files:**
- Modify: `src/pages/Settings.jsx`
- Modify: `src/hooks/useSupabase.js` (add `useSetting`/`useTravelRate` reader if settings are DB-backed)

**Interfaces:**
- Consumes: settings store (Task 1/4).
- Produces: a number field "ค่าเดินทาง (บาท/กม.)" bound to `travel_rate_per_km`, saved to the settings store.

- [ ] **Step 1: Add a hook** to read `travel_rate_per_km` from the settings store (follow the store shape from Task 1).

- [ ] **Step 2: Add a field + save handler** in Settings.jsx that upserts `travel_rate_per_km`.

- [ ] **Step 3: Verify** — change to 25, reload, confirm persisted (`select value from app_settings where key='travel_rate_per_km'` → 25). Reset to 20.

- [ ] **Step 4: Commit** (`feat(settings): editable travel rate per km`)

---

## Phase C — Assign data layer

### Task 9: Date-range, shift-aware assignments hook

**Files:**
- Modify: `src/hooks/useSupabase.js` (add `useAssignmentsRange(from, to)` returning rows incl. `shift`; keep `useAssignments` for back-compat or refactor callers)

**Interfaces:**
- Produces: `useAssignmentsRange(fromISO, toISO)` → rows `{id, worker_id, site_id, date, type, shift, ot_hours, notes, sites:{name,site_number}, workers:{...}}`.

- [ ] **Step 1: Add hook** mirroring `useAssignments` but taking explicit `from`/`to` ISO dates and selecting `shift` in the column list.

- [ ] **Step 2: Verify** — temporary console log in Assign shows rows with `shift` populated after Phase A migration.

- [ ] **Step 3: Commit** (`feat(hooks): date-range shift-aware assignments`)

---

## Phase D — Assign views

> Assign.jsx will grow; split view rendering into small components under `src/pages/assign/`.

### Task 10: Extract view scaffolding + Day/Week/Month toggle + date nav

**Files:**
- Create: `src/pages/assign/ViewToggle.jsx`, `src/pages/assign/useAssignRange.js` (computes from/to for current view+anchor date, Monday-start)
- Modify: `src/pages/Assign.jsx` (add `view` state `'day'|'week'|'month'`, `anchor` date, prev/next/today nav; fetch via `useAssignmentsRange`)

**Interfaces:**
- Consumes: `useAssignmentsRange` (Task 9).
- Produces: `computeRange(view, anchor) → {from, to, days: Date[]}` with Monday-start weeks and Sunday flagged; `<ViewToggle value onChange>`.

- [ ] **Step 1: Write `useAssignRange.js`** — pure helper: for `day` → single day; `week` → Monday..Sunday of anchor; `month` → 1st..last. Return ISO `from`/`to` and a `days` array with `isSunday` flags.

- [ ] **Step 2: Add ViewToggle + nav** to Assign toolbar; wire `anchor`/`view` state; replace month/year selects.

- [ ] **Step 3: Verify build + visual** — toggle switches the fetched range; nav moves the anchor.

- [ ] **Step 4: Commit** (`feat(assign): day/week/month toggle + date nav`)

---

### Task 11: Shared matrix cell (full vs split) + Month & Week grids

**Files:**
- Create: `src/pages/assign/AssignCell.jsx` (renders a worker×date cell: full when both shifts same site+type, split top/bottom when different; empty dot otherwise; click handlers per half)
- Create: `src/pages/assign/GridView.jsx` (workers × days table used by both Month and Week; Sunday column dimmed/disabled)
- Modify: `src/pages/Assign.jsx` (use GridView for month & week)

**Interfaces:**
- Consumes: assignments range; a `byWorkerDate` lookup `map[worker_id][date] = {morning?, evening?}` each `{type, site_number, site_id, ot}`.
- Produces: `<AssignCell dayCell onEditHalf(shift) />`; `<GridView days workers cellLookup onEditHalf />`.

- [ ] **Step 1: Build the lookup** in Assign.jsx: `map[worker_id][YYYY-MM-DD] = { morning, evening }`.

- [ ] **Step 2: Write AssignCell** — if morning & evening exist with same `site_id`+`type` → one full block (site code / type label); else render two halves (top=morning, bottom=evening), each colored by type, empty half = faint dot. Colors reuse existing `TYPE_COLOR` (+ add `factory`).

- [ ] **Step 3: Write GridView** — sticky worker column, day headers (Week: `จ อ พ พฤ ศ ส อา` with dates; Sunday `opacity:.4`), totals column = `Σ shift × 0.5` days.

- [ ] **Step 4: Wire Month + Week** to GridView (Month = all month days, Week = 7 days).

- [ ] **Step 5: Verify build + visual** — split example shows two colors; full day shows one; Sunday dimmed.

- [ ] **Step 6: Commit** (`feat(assign): shared grid + split/full shift cell`)

---

### Task 12: Day view — grouped by site with morning/evening + cost

**Files:**
- Create: `src/pages/assign/DayView.jsx`
- Modify: `src/pages/Assign.jsx` (render DayView when `view==='day'`)
- Modify: `src/hooks/useSupabase.js` if a per-day cost read is easier via view; otherwise compute client-side.

**Interfaces:**
- Consumes: day's assignments; site `distance_km`; travel rate; worker daily rate (`monthly_salary/26`).
- Produces: per-site card: 🌅 เช้า / 🌆 เย็น worker chips + `ค่าแรงวันนี้` (`Σ 0.5×dailyRate` for site+factory) and travel line (`distance×2×rate` if any `site` assignment that day).

- [ ] **Step 1: Group day rows by site_id**, split into morning/evening worker chips.

- [ ] **Step 2: Compute per-site day cost** — labor = Σ over rows `0.5 × (monthly_salary/26)` for type∈(site,factory); travel = `distance_km×2×rate` if ≥1 `site` row that day, else 0.

- [ ] **Step 3: Render site cards** (layout from approved mockup: two columns เช้า/เย็น, cost top-right, travel as a small line).

- [ ] **Step 4: Verify build + visual** against mockup.

- [ ] **Step 5: Commit** (`feat(assign): day view grouped by site with cost+travel`)

---

## Phase E — Assignment wizard

### Task 13: Multi-day calendar picker (Sunday disabled)

**Files:**
- Create: `src/pages/assign/MultiDayPicker.jsx`

**Interfaces:**
- Produces: `<MultiDayPicker value:Set<ISO> onChange anchorMonth />` — month grid, Monday-start, Sundays not selectable, click toggles a date; shows selected chips.

- [ ] **Step 1: Render month grid** Monday-start; Sunday cells `disabled` + dimmed.

- [ ] **Step 2: Click toggles** date in a `Set`; render selected-day chips with remove.

- [ ] **Step 3: Verify build + visual** — can select several days; Sundays inert.

- [ ] **Step 4: Commit** (`feat(assign): multi-day picker`)

---

### Task 14: Wizard modal — type, site, multi-worker + per-worker shift

**Files:**
- Create: `src/pages/assign/AssignWizard.jsx`
- Modify: `src/pages/Assign.jsx` (replace old single modal with `<AssignWizard>`)

**Interfaces:**
- Consumes: `MultiDayPicker`, `SearchableSelect`, workers list, ongoing sites.
- Produces: wizard state `{ days:Set, type:'site'|'factory', site_id, workers: Map<worker_id,{am:bool,pm:bool}> }`; calls `onSubmit(rows)` where rows = expanded `{worker_id,date,shift,site_id,type}` for each selected day × worker × enabled shift.

- [ ] **Step 1: Build the single-panel layout** (approved mockup B): section 1 days, section 2 type toggle (🏗️ งานไซท์ / 🏭 ผลิตที่โรงงาน), section 3 site (SearchableSelect), section 4 worker checklist each with เช้า/เย็น toggles defaulting both on.

- [ ] **Step 2: Expand selection → rows** on submit (skip disabled shifts; skip if neither shift on).

- [ ] **Step 3: Verify build + visual** — layout matches mockup; wider responsive modal (Task 6).

- [ ] **Step 4: Commit** (`feat(assign): single-panel assignment wizard`)

---

### Task 15: Conflict check + overwrite upsert

**Files:**
- Modify: `src/pages/Assign.jsx` (submit handler), reuse `ConfirmDialog` from `Modal.jsx`

**Interfaces:**
- Consumes: wizard rows (Task 14), current range assignments (to detect conflicts).
- Produces: on submit, detect existing rows on any `(worker_id,date,shift)`; if any → `ConfirmDialog` listing "ช่าง X มีงาน Y (วันที่/กะ) อยู่แล้ว"; on confirm → `upsert(rows, { onConflict: 'worker_id,date,shift' })`; refetch.

- [ ] **Step 1: Detect conflicts** by cross-checking wizard rows against a `(worker_id|date|shift)` set built from fetched assignments (fetch the affected date span if outside current range).

- [ ] **Step 2: If conflicts, show ConfirmDialog** with the list; else save directly.

- [ ] **Step 3: Upsert on confirm** with `onConflict: 'worker_id,date,shift'`; then refetch.

- [ ] **Step 4: Verify** — assign onto an occupied shift → warning appears → confirm overwrites; new shift saves silently.

- [ ] **Step 5: Commit** (`feat(assign): conflict warning + overwrite on assign`)

---

## Phase F — Cell editing

### Task 16: Cell-click edit popup (type/site/OT/delete per shift)

**Files:**
- Create: `src/pages/assign/CellEditPopup.jsx`
- Modify: `src/pages/Assign.jsx` (open popup from GridView `onEditHalf` and DayView chips)

**Interfaces:**
- Consumes: `{worker_id, date, shift}` + existing row if any.
- Produces: set `type` (site/factory/office/leave/holiday), site (when site/factory), `ot_hours`; save = upsert one row `onConflict worker_id,date,shift`; delete = remove that row.

- [ ] **Step 1: Build popup** with type SearchableSelect/segmented, conditional site select, OT number, ลบ button.

- [ ] **Step 2: Wire save/delete** (upsert/delete single `(worker_id,date,shift)` row), refetch.

- [ ] **Step 3: Verify** — click a cell half → set 'ลา' → cell shows leave; set site → shows site; delete clears.

- [ ] **Step 4: Commit** (`feat(assign): per-shift cell edit popup`)

---

## Phase G — Cost display

### Task 17: Labor + travel cost per site cards

**Files:**
- Modify: `src/pages/Assign.jsx` (bottom "ค่าแรงช่างต่อไซท์" section)
- Modify: `src/hooks/useSupabase.js` (add `useSiteTravelCost()` reading `site_travel_cost`)

**Interfaces:**
- Consumes: `labor_cost_by_site` (already via `useLaborCost`), `site_travel_cost` (new).
- Produces: each site card shows ค่าแรง (labor) + ค่าเดินทาง (travel) = รวม; day counts may show `.5`.

- [ ] **Step 1: Add `useSiteTravelCost` hook** selecting from `site_travel_cost`.

- [ ] **Step 2: Merge by site_id** in the cards; render labor, travel, total lines; format fractional days.

- [ ] **Step 3: Verify build + visual** — a site with distance shows a nonzero travel line; totals = labor + travel.

- [ ] **Step 4: Commit** (`feat(assign): show labor + travel cost per site`)

---

## Phase H — Wrap up

### Task 18: Full build + regression sweep + schema.sql refresh

**Files:**
- Modify: `supabase/schema.sql` (bring the changed tables/views in line with the migrations so the reference file stops drifting further — additive only for the parts we touched)

- [ ] **Step 1: `npm run build`** → Expected: built, no errors.

- [ ] **Step 2: Manual regression** — Sites CRUD, Expenses/Income site selects, HR/Payroll (labor view unaffected), Assign all 3 views + wizard + cell edit.

- [ ] **Step 3: Update schema.sql** for `worker_assignments`, `sites`, the two views, and `app_settings` to match applied migrations (touched objects only).

- [ ] **Step 4: Commit** (`chore: refresh schema.sql for assign redesign`)

---

## Self-Review (spec coverage)

- Day/Week/Month + Monday start → Tasks 10,11,12 ✅
- Multi-day → site → multi-worker wizard → Tasks 13,14 ✅
- Morning/evening half-days, default both, manual split → Tasks 2,11,14 ✅
- Popup not dynamic (long names) → Task 6 ✅
- Google Maps link (Sites only) → Tasks 3,7 ✅
- Factory type, labor→site, no travel → Tasks 2,5,12,14 ✅
- Travel cost per site/day, ×2, rate in Settings → Tasks 3,4,5,8,12,17 ✅
- Conflict warn + overwrite → Task 15 ✅
- Click cell for leave/office/holiday → Task 16 ✅
- Half-day labor totals preserved → Tasks 2,5 ✅
