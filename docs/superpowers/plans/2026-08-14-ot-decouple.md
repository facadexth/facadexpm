# OT Decoupled From Shift — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let OT (overtime) be recorded independently of the morning/evening shift structure in the Assign page — tied to a site and a start/end time range, capped at one entry per worker per day, surfaced everywhere OT currently shows (DayView, GridView, copy-for-LINE, Payroll, HR).

**Architecture:** A new `worker_ot` table (separate from `worker_assignments`) holds one row per worker per day: `site_id`, `start_time`, `end_time`, a pre-rounded `ot_hours`, and `notes`. A pure module (`otMath.js`) computes hours-from-times (rounded to nearest 0.5) and OT cost (`hours × hourly_rate × 1.5`) so the same formula is used for live preview in the entry form and for site-level cost cards. The existing `CellEditPopup` gains a "+OT" section (entry point stays option B, already decided) that saves to the new table via new handlers in `Assign.jsx`, alongside the existing shift-row save/delete. Historical OT already stored on `worker_assignments.ot_hours` is left untouched; Payroll/HR sum OT from both sources going forward.

**Tech Stack:** React + Vite, Supabase (Postgres + supabase-js), no automated test runner in this project — verification is `npm run build` (catches syntax/import errors) plus Supabase MCP `execute_sql` round-trips for schema changes and manual dev-server click-throughs for UI changes, matching the existing convention in `docs/superpowers/plans/2026-07-10-form-draft-persistence.md`.

## Global Constraints

- Supabase project id: `yyzbgdmgyvvypfcjuhtr`. Apply migrations via the `mcp__plugin_supabase_supabase__apply_migration` tool, not manual SQL editor steps.
- OT rate formula (unchanged, must match exactly): `ot_hours × (monthly_salary / 26 / 8) × 1.5`.
- OT hours are always rounded to the nearest 0.5 at save time (not on every read).
- At most one `worker_ot` row per `(worker_id, date)` — enforced by a UNIQUE constraint, not just app logic.
- `worker_ot.site_id` is a plain FK to `sites` — no `type` column; OT cost attribution doesn't distinguish `site` vs `factory` regular-shift type, matching how `labor_cost_by_site` already treats both the same.
- No RLS policies — every other table in this schema has `rowsecurity = false`; match that.
- Historical `worker_assignments.ot_hours` values are never migrated or rewritten by this work.
- Thai shift label is "บ่าย" (already renamed from "เย็น" in a prior change) — use "บ่าย" in any new UI copy, not "เย็น".

---

### Task 1: `worker_ot` table + `ot_cost_by_site` view

**Files:**
- Create: `supabase/migrations/2026-08-14-01-worker-ot-table.sql`
- Modify: `supabase/schema.sql` (insert after the `worker_assignments` table definition, and after the `labor_cost_by_site` view)

**Interfaces:**
- Produces: table `worker_ot(id, worker_id, site_id, date, start_time, end_time, ot_hours, notes, created_at)`, unique on `(worker_id, date)`, `CHECK (end_time > start_time)` — consumed by Task 3's hooks and Task 5/6's save/delete handlers.
- Produces: view `ot_cost_by_site(site_id, site_name, site_number, worker_id, worker_name, nickname, ot_hours, ot_cost)` — consumed by Task 6 (`Assign.jsx`'s all-time `costBySite` card).

- [ ] **Step 1: Write the migration file**

`supabase/migrations/2026-08-14-01-worker-ot-table.sql`:

```sql
-- worker_ot: OT decoupled from the morning/evening shift structure in
-- worker_assignments. Tied to a site (for per-site cost attribution) and a
-- time range, capped at one entry per worker per day.
-- See docs/superpowers/specs/2026-08-14-ot-decouple-design.md
CREATE TABLE worker_ot (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id   UUID NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  site_id     UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  date        DATE NOT NULL,
  start_time  TIME NOT NULL,
  end_time    TIME NOT NULL,
  ot_hours    NUMERIC NOT NULL,
  notes       TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (worker_id, date),
  CHECK (end_time > start_time)
);

CREATE INDEX idx_worker_ot_site ON worker_ot(site_id);
CREATE INDEX idx_worker_ot_date ON worker_ot(date);

-- ต้นทุน OT ต่อไซท์ (all-time) — mirrors labor_cost_by_site's shape/grouping
CREATE VIEW ot_cost_by_site AS
SELECT
  o.site_id,
  s.name AS site_name,
  s.site_number,
  o.worker_id,
  w.name AS worker_name,
  w.nickname,
  SUM(o.ot_hours) AS ot_hours,
  ROUND(SUM(o.ot_hours * (w.monthly_salary / 26 / 8) * 1.5), 2) AS ot_cost
FROM worker_ot o
JOIN workers w ON o.worker_id = w.id
JOIN sites s ON o.site_id = s.id
GROUP BY o.site_id, s.name, s.site_number, o.worker_id, w.name, w.nickname;
```

- [ ] **Step 2: Apply the migration**

Use `mcp__plugin_supabase_supabase__apply_migration` with `project_id: yyzbgdmgyvvypfcjuhtr`, `name: worker_ot_table`, and the full SQL from Step 1 as `query`.

- [ ] **Step 3: Verify the table and view via `execute_sql`**

Run:
```sql
SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = 'worker_ot' ORDER BY ordinal_position;
```
Expected: 9 rows — `id` (uuid), `worker_id` (uuid), `site_id` (uuid), `date` (date), `start_time` (time without time zone), `end_time` (time without time zone), `ot_hours` (numeric), `notes` (text), `created_at` (timestamp with time zone).

- [ ] **Step 4: Verify the unique constraint and CHECK via a rollback-safe insert**

Run (single `execute_sql` call, one transaction):
```sql
BEGIN;
INSERT INTO worker_ot (worker_id, site_id, date, start_time, end_time, ot_hours)
SELECT w.id, s.id, CURRENT_DATE + 300, '17:30', '19:45', 2.5
FROM workers w, sites s LIMIT 1
RETURNING ot_hours;

-- second insert for the same worker+date must fail (unique violation)
INSERT INTO worker_ot (worker_id, site_id, date, start_time, end_time, ot_hours)
SELECT w.id, s.id, CURRENT_DATE + 300, '20:00', '21:00', 1.0
FROM workers w, sites s LIMIT 1;
ROLLBACK;
```
Expected: first INSERT returns `ot_hours: 2.5`; second INSERT fails with `duplicate key value violates unique constraint "worker_ot_worker_id_date_key"`.

- [ ] **Step 5: Verify the CHECK constraint rejects end_time <= start_time**

Run:
```sql
BEGIN;
INSERT INTO worker_ot (worker_id, site_id, date, start_time, end_time, ot_hours)
SELECT w.id, s.id, CURRENT_DATE + 301, '19:00', '18:00', 1.0
FROM workers w, sites s LIMIT 1;
ROLLBACK;
```
Expected: fails with `new row for relation "worker_ot" violates check constraint "worker_ot_check"`.

- [ ] **Step 6: Verify RLS is disabled (matches every other table)**

Run:
```sql
SELECT rowsecurity FROM pg_tables WHERE tablename = 'worker_ot';
```
Expected: `false`.

- [ ] **Step 7: Verify `ot_cost_by_site` computes correctly**

Run (rollback-safe):
```sql
BEGIN;
INSERT INTO worker_ot (worker_id, site_id, date, start_time, end_time, ot_hours)
SELECT w.id, s.id, CURRENT_DATE + 302, '17:00', '19:00', 2.0
FROM workers w, sites s WHERE w.monthly_salary = 26000 LIMIT 1;
SELECT ot_hours, ot_cost FROM ot_cost_by_site WHERE ot_hours = 2.0 ORDER BY ot_cost DESC LIMIT 1;
ROLLBACK;
```
Expected: `ot_cost` = `2.0 × (26000/26/8) × 1.5` = `2.0 × 125 × 1.5` = `375.00`. If no worker has `monthly_salary = 26000`, adjust the WHERE clause to any existing worker and hand-check the arithmetic against their `monthly_salary` instead.

- [ ] **Step 8: Add the same objects to `supabase/schema.sql`**

In `supabase/schema.sql`, insert immediately after the `worker_assignments` table's closing `);` (currently ends around the `UNIQUE (worker_id, date, shift)` line, before the `SALARY_RECORDS` section header):

```sql

-- ----------------------------------------------------------------
-- WORKER_OT — OT รายวัน (แยกจาก shift เช้า/บ่าย)
-- ----------------------------------------------------------------
CREATE TABLE worker_ot (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id   UUID NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  site_id     UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  date        DATE NOT NULL,
  start_time  TIME NOT NULL,
  end_time    TIME NOT NULL,
  ot_hours    NUMERIC NOT NULL,
  notes       TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (worker_id, date),
  CHECK (end_time > start_time)
);

CREATE INDEX idx_worker_ot_site ON worker_ot(site_id);
CREATE INDEX idx_worker_ot_date ON worker_ot(date);
```

Then, in the VIEWS section, immediately after the `labor_cost_by_site` view (ends at the line `GROUP BY wa.site_id, s.name, s.site_number, wa.worker_id, w.name, w.nickname, w.monthly_salary;`), insert:

```sql

-- ต้นทุน OT ต่อไซท์ (all-time) — mirrors labor_cost_by_site's shape/grouping
CREATE VIEW ot_cost_by_site AS
SELECT
  o.site_id,
  s.name AS site_name,
  s.site_number,
  o.worker_id,
  w.name AS worker_name,
  w.nickname,
  SUM(o.ot_hours) AS ot_hours,
  ROUND(SUM(o.ot_hours * (w.monthly_salary / 26 / 8) * 1.5), 2) AS ot_cost
FROM worker_ot o
JOIN workers w ON o.worker_id = w.id
JOIN sites s ON o.site_id = s.id
GROUP BY o.site_id, s.name, s.site_number, o.worker_id, w.name, w.nickname;
```

- [ ] **Step 9: Commit**

```bash
git add supabase/migrations/2026-08-14-01-worker-ot-table.sql supabase/schema.sql
git commit -m "Add worker_ot table and ot_cost_by_site view"
```

---

### Task 2: `otMath.js` — pure OT hours/cost helpers

**Files:**
- Create: `src/pages/assign/otMath.js`

**Interfaces:**
- Produces: `computeOTHours(start: string, end: string) -> number|null` — takes `"HH:MM"` strings, returns hours rounded to nearest 0.5, or `null` if either input is missing/invalid or `end <= start`. Consumed by Task 5 (`CellEditPopup.jsx` live preview).
- Produces: `otCost(monthlySalary: number, otHours: number) -> number` — returns `otHours × (monthlySalary/26/8) × 1.5` rounded to 2 decimals, or `0` if `otHours` is falsy. Consumed by Task 7 (`DayView.jsx`).

- [ ] **Step 1: Write the module**

`src/pages/assign/otMath.js`:

```js
// ============================================================
// otMath — pure helpers for OT hour/cost computation, shared by
// the +OT entry form (live preview) and the per-site day cards
// (OT cost line). Formula must match Payroll.jsx/HR.jsx exactly:
// ot_hours × (monthly_salary / 26 / 8) × 1.5
// ============================================================

/** "HH:MM" (or "HH:MM:SS") -> minutes since midnight, or null if unparseable. */
function toMinutes(t) {
  if (!t) return null
  const [h, m] = t.split(':').map(Number)
  if (Number.isNaN(h) || Number.isNaN(m)) return null
  return h * 60 + m
}

/**
 * Compute OT hours from start/end time-of-day strings, rounded to the
 * nearest 0.5 hour. Returns null if either time is missing/invalid or
 * end is not after start (no overnight OT support).
 */
export function computeOTHours(start, end) {
  const startMin = toMinutes(start)
  const endMin = toMinutes(end)
  if (startMin == null || endMin == null || endMin <= startMin) return null
  const hours = (endMin - startMin) / 60
  return Math.round(hours * 2) / 2
}

/** OT pay for a given monthly salary and OT hours, rounded to 2 decimals. */
export function otCost(monthlySalary, otHours) {
  if (!otHours) return 0
  const hourlyRate = (monthlySalary || 0) / 26 / 8
  return Math.round(hourlyRate * 1.5 * otHours * 100) / 100
}
```

- [ ] **Step 2: Verify with a scratch script**

`otMath.js` has no imports of its own (no transitive dependency on Vite-only
globals like `import.meta.env`), so it can be `require()`'d directly —
Node's CJS loader auto-detects and evaluates `export`-syntax files as ESM
under the hood.

Run:
```bash
node -e "
const { computeOTHours, otCost } = require('./src/pages/assign/otMath.js')
console.log(computeOTHours('17:30', '19:45'))  // expect 2.5
console.log(computeOTHours('17:00', '17:20'))  // expect 0.5 (0.333h rounds to 0.5)
console.log(computeOTHours('19:00', '18:00'))  // expect null (end before start)
console.log(computeOTHours('', '19:00'))       // expect null (missing start)
console.log(otCost(26000, 2))                  // expect 375
console.log(otCost(0, 2))                      // expect 0
console.log(otCost(26000, 0))                  // expect 0
"
```
Expected output (seven lines): `2.5`, `0.5`, `null`, `null`, `375`, `0`, `0`.

- [ ] **Step 3: Commit**

```bash
git add src/pages/assign/otMath.js
git commit -m "Add otMath pure helpers for OT hours/cost computation"
```

---

### Task 3: `useSupabase.js` — OT data hooks

**Files:**
- Modify: `src/hooks/useSupabase.js`

**Interfaces:**
- Consumes: `supabase` client, `useQuery` (both already in this file).
- Produces: `useWorkerOTRange(from: string, to: string) -> { data, loading, error, refetch }` where `data` is an array of `{ id, worker_id, site_id, date, start_time, end_time, ot_hours, notes, workers: {name, nickname, monthly_salary}, sites: {name, site_number} }` — consumed by Task 6 (`Assign.jsx`).
- Produces: `useOTCostBySite() -> { data, loading, error, refetch }` where `data` is an array of `ot_cost_by_site` view rows — consumed by Task 6 (`Assign.jsx`'s all-time `costBySite`).
- Produces: `fetchWorkerOTForRange(from: string, to: string) -> Promise<Array>` — a plain (non-hook) async function returning the same row shape as `useWorkerOTRange`, for imperative calls inside click handlers. Consumed by Task 10 (`Payroll.jsx`) and Task 11 (`HR.jsx`).

- [ ] **Step 1: Add the hooks and plain fetch function**

In `src/hooks/useSupabase.js`, immediately after `useLaborCost` (which ends at line 164 with the closing `}`), insert:

```js

/** OT entries ในช่วงวันที่ — ใช้กับมุมมอง Day/Week/Month และ copy-for-LINE */
export function useWorkerOTRange(from, to) {
  return useQuery(async () => {
    if (!from || !to) return []
    const { data, error } = await supabase
      .from('worker_ot')
      .select('id, worker_id, site_id, date, start_time, end_time, ot_hours, notes, workers(name, nickname, monthly_salary), sites(name, site_number)')
      .gte('date', from)
      .lte('date', to)
      .order('date')
    if (error) throw error
    return data
  }, [from, to])
}

/** เหมือน useWorkerOTRange แต่เรียกแบบ imperative (ไม่ใช่ hook) — ใช้ใน Payroll/HR handleCalcFromAssign */
export async function fetchWorkerOTForRange(from, to) {
  const { data, error } = await supabase
    .from('worker_ot')
    .select('worker_id, ot_hours, workers(id, name, nickname, monthly_salary, monthly_contribution, has_social_security)')
    .gte('date', from)
    .lte('date', to)
  if (error) throw error
  return data
}

/** ต้นทุน OT ต่อไซท์ (all-time) */
export function useOTCostBySite() {
  return useQuery(async () => {
    const { data, error } = await supabase.from('ot_cost_by_site').select('*')
    if (error) throw error
    return data
  })
}
```

- [ ] **Step 2: Verify the file still parses correctly**

Run: `npm run build`
Expected: built, no errors.

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useSupabase.js
git commit -m "Add useWorkerOTRange, useOTCostBySite, fetchWorkerOTForRange hooks"
```

---

### Task 4: `otMerge.js` — shared Payroll/HR OT-merging helper

**Files:**
- Create: `src/lib/otMerge.js`

**Interfaces:**
- Produces: `mergeWorkerOT(wmap: object, otRows: Array) -> object` — mutates and returns `wmap` (the `{ [worker_id]: { worker, leave, ot_hours } }` accumulator already built by `Payroll.jsx`/`HR.jsx` from `worker_assignments`), adding each `otRows` entry's `ot_hours` into the matching worker (creating the entry if the worker had no `worker_assignments` rows that month). Consumed by Task 10 (`Payroll.jsx`) and Task 11 (`HR.jsx`).

- [ ] **Step 1: Write the module**

`src/lib/otMerge.js`:

```js
// ============================================================
// otMerge — folds worker_ot rows into the { worker, leave, ot_hours }
// accumulator that Payroll.jsx and HR.jsx build from worker_assignments,
// so a worker's monthly OT total counts both the legacy per-shift
// ot_hours (worker_assignments) and the new decoupled worker_ot entries.
// ============================================================

/** Mutates and returns wmap: { [worker_id]: { worker, leave, ot_hours } } */
export function mergeWorkerOT(wmap, otRows) {
  ;(otRows || []).forEach(o => {
    const w = o.workers
    if (!w) return
    if (!wmap[o.worker_id]) wmap[o.worker_id] = { worker: w, leave: 0, ot_hours: 0 }
    wmap[o.worker_id].ot_hours += (o.ot_hours || 0)
  })
  return wmap
}
```

- [ ] **Step 2: Verify with a scratch script**

Run:
```bash
node -e "
const { mergeWorkerOT } = require('./src/lib/otMerge.js')
const wmap = { w1: { worker: { name: 'A' }, leave: 1, ot_hours: 2 } }
const otRows = [
  { worker_id: 'w1', ot_hours: 1.5, workers: { name: 'A' } },  // existing worker: hours add on top
  { worker_id: 'w2', ot_hours: 3,   workers: { name: 'B' } },  // new worker: entry gets created
]
mergeWorkerOT(wmap, otRows)
console.log(wmap.w1.ot_hours)  // expect 3.5 (2 + 1.5)
console.log(wmap.w2.ot_hours)  // expect 3 (created fresh)
console.log(wmap.w2.leave)     // expect 0 (default, this worker had no worker_assignments leave)
"
```
Expected output (three lines): `3.5`, `3`, `0`.

- [ ] **Step 3: Commit**

```bash
git add src/lib/otMerge.js
git commit -m "Add mergeWorkerOT helper shared by Payroll and HR"
```

---

### Task 5: `CellEditPopup.jsx` — add the "+OT" section

**Files:**
- Modify: `src/pages/assign/CellEditPopup.jsx`

**Interfaces:**
- Consumes: `computeOTHours` from `../assign/otMath.js` (Task 2).
- Consumes new props: `target.existingOT` (`{ id, site_id, start_time, end_time, notes }|null`), `onSaveOT(row)`, `onDeleteOT()` — all provided by Task 6 (`Assign.jsx`).
- Produces: calls `onSaveOT({ worker_id, date, site_id, start_time, end_time, ot_hours, notes })` when the OT fields are filled in and the form is submitted; calls `onDeleteOT()` when the "ลบ OT" button is clicked.

- [ ] **Step 1: Replace the file with the +OT section added**

`src/pages/assign/CellEditPopup.jsx` (full file):

```jsx
// ============================================================
// CellEditPopup — edit one worker×date×shift assignment, plus an
// optional OT entry for that worker+date (independent of shift;
// see docs/superpowers/specs/2026-08-14-ot-decouple-design.md).
// onSave(row), onDelete(), onSaveOT(row), onDeleteOT(), onClose
// ============================================================
import { useState } from 'react'
import { Modal } from '../../components/Modal.jsx'
import SearchableSelect from '../../components/SearchableSelect.jsx'
import { SITE_TYPES } from './constants.js'
import { computeOTHours } from './otMath.js'

const TYPE_OPTS = [
  { k: 'site',    l: '🏗️ งานไซท์' },
  { k: 'factory', l: '🏭 โรงงาน' },
  { k: 'office',  l: '🏢 ออฟฟิศ' },
  { k: 'leave',   l: '🏖️ ลา' },
  { k: 'holiday', l: '🎌 หยุด' },
]

export default function CellEditPopup({ target, sites = [], onSave, onDelete, onSaveOT, onDeleteOT, onClose, saving }) {
  const { worker, date, shift, existing, existingOT } = target
  const [type, setType]     = useState(existing?.type || 'site')
  const [siteId, setSiteId] = useState(existing?.site_id || '')
  const [notes, setNotes]   = useState(existing?.notes || '')

  const [otSiteId, setOtSiteId] = useState(existingOT?.site_id || existing?.site_id || '')
  const [otStart, setOtStart]   = useState(existingOT?.start_time?.slice(0, 5) || '')
  const [otEnd, setOtEnd]       = useState(existingOT?.end_time?.slice(0, 5) || '')
  const [otNotes, setOtNotes]   = useState(existingOT?.notes || '')

  const needsSite = SITE_TYPES.includes(type)
  const otHours = computeOTHours(otStart, otEnd)
  const otStarted = otSiteId || otStart || otEnd  // user has begun filling in OT

  const save = () => {
    if (needsSite && !siteId) return alert('เลือกไซท์งาน')
    if (otStarted && (!otSiteId || !otStart || !otEnd)) {
      return alert('กรอกไซท์งาน เวลาเริ่ม และเวลาจบของ OT ให้ครบ')
    }
    if (otStart && otEnd && otHours == null) {
      return alert('เวลาจบ OT ต้องอยู่หลังเวลาเริ่ม')
    }
    onSave({
      worker_id: worker.id, date, shift,
      type, site_id: needsSite ? siteId : null,
      notes: notes || null,
    })
    if (otStarted && otHours != null) {
      onSaveOT({
        worker_id: worker.id, date,
        site_id: otSiteId, start_time: otStart, end_time: otEnd,
        ot_hours: otHours, notes: otNotes || null,
      })
    }
  }

  const siteOptions = sites.map(s => ({ value: s.id, label: `${s.site_number} · ${s.name}`, keywords: `${s.site_number} ${s.name}` }))

  return (
    <Modal title={`${worker.nickname || worker.name} · ${date} · ${shift === 'morning' ? 'เช้า' : 'บ่าย'}`} onClose={onClose} maxWidth={420}>
      <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
        <div>
          <label className="label">ประเภท</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {TYPE_OPTS.map(o => (
              <button key={o.k} type="button" onClick={() => setType(o.k)}
                className={`btn btn-sm ${type === o.k ? 'btn-primary' : 'btn-ghost'}`}>{o.l}</button>
            ))}
          </div>
        </div>
        {needsSite && (
          <div>
            <label className="label">ไซท์งาน</label>
            <SearchableSelect
              value={siteId} onChange={setSiteId} placeholder="— เลือกไซท์ —"
              options={siteOptions}
            />
          </div>
        )}
        <div>
          <label className="label">รายละเอียดเพิ่มเติม</label>
          <textarea className="textarea" rows={2} value={notes} onChange={e => setNotes(e.target.value)} placeholder="เช่น เอาบันไดมาด้วย" />
        </div>

        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
          <label className="label">⚡ OT (ไม่ผูกกับกะเช้า/บ่าย — สูงสุด 1 ช่วง/คน/วัน)</label>
          <div style={{ marginBottom: 8 }}>
            <SearchableSelect
              value={otSiteId} onChange={setOtSiteId} placeholder="— เลือกไซท์งาน OT —"
              options={siteOptions}
            />
          </div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
            <div style={{ flex: 1 }}>
              <label className="label" style={{ fontSize: 11 }}>เวลาเริ่ม</label>
              <input type="time" className="input" value={otStart} onChange={e => setOtStart(e.target.value)} />
            </div>
            <div style={{ flex: 1 }}>
              <label className="label" style={{ fontSize: 11 }}>เวลาจบ</label>
              <input type="time" className="input" value={otEnd} onChange={e => setOtEnd(e.target.value)} />
            </div>
          </div>
          {otStart && otEnd && (
            <div style={{ fontSize: 12, color: otHours != null ? 'var(--yellow)' : 'var(--red)', marginBottom: 6 }}>
              {otHours != null ? `= ${otHours} ชม.` : 'เวลาจบต้องอยู่หลังเวลาเริ่ม'}
            </div>
          )}
          <input className="input" style={{ marginBottom: 6 }} value={otNotes} onChange={e => setOtNotes(e.target.value)} placeholder="หมายเหตุ OT (ถ้ามี)" />
          {existingOT && (
            <button type="button" className="btn btn-sm btn-danger" onClick={onDeleteOT} disabled={saving}>🗑️ ลบ OT</button>
          )}
        </div>
      </div>
      <div className="modal-footer" style={{ justifyContent: 'space-between' }}>
        <div>
          {existing && <button className="btn btn-sm btn-danger" onClick={onDelete} disabled={saving}>🗑️ ลบ</button>}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost" onClick={onClose}>ยกเลิก</button>
          <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? '⏳...' : '✅ บันทึก'}</button>
        </div>
      </div>
    </Modal>
  )
}
```

Note the OT hours input from the old per-shift model (`ot` state, "OT (ชั่วโมง)" field previously shown when `type === 'site'`) is removed entirely — OT now only enters through the +OT section. `onSave`'s payload no longer includes `ot_hours`, so updating a shift row never touches its (possibly legacy nonzero) `ot_hours` value.

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: built, no errors.

- [ ] **Step 3: Commit**

```bash
git add src/pages/assign/CellEditPopup.jsx
git commit -m "Add +OT section to CellEditPopup, remove old per-shift OT input"
```

---

### Task 6: `Assign.jsx` — wire OT fetch/save/delete and pass data down

**Files:**
- Modify: `src/pages/Assign.jsx`

**Interfaces:**
- Consumes: `useWorkerOTRange`, `useOTCostBySite` (Task 3).
- Produces: `otLookup[worker_id][date] -> { id, site_id, site_number, site_name, start_time, end_time, ot_hours, notes }` — consumed by Task 8 (`GridView`/`AssignCell`).
- Produces: passes `otEntries` (the raw `useWorkerOTRange` rows for the visible range) to `DayView` (Task 7) and `buildLineText` (Task 9).
- Produces: passes `otCostBySite` data merged into `costBySite`'s per-site `otCost` field — consumed by this same file's render (Task 6 also updates the cost-card JSX).

- [ ] **Step 1: Add the new hooks and merge OT cost into `costBySite`**

In `src/pages/Assign.jsx`, update the import line:

```js
import { useWorkers, useSites, useAssignmentsRange, useLaborCost, useSiteTravelCost, useAppSetting, useWorkerOTRange, useOTCostBySite } from '../hooks/useSupabase.js'
```

Add the new hook calls right after `const { data: travelData } = useSiteTravelCost()`:

```js
  const { data: otEntries, refetch: refetchOT } = useWorkerOTRange(from, to)
  const { data: otCostData } = useOTCostBySite()
```

Update the `costBySite` `useMemo` to fold in OT cost as its own field (do not add it into `labor`):

```js
  // labor + travel + OT cost per site (all-time)
  const costBySite = useMemo(() => {
    const m = {}
    ;(laborData || []).forEach(l => {
      const g = m[l.site_id] || (m[l.site_id] = { site_number: l.site_number, site_name: l.site_name, labor: 0, travel: 0, ot: 0, workers: [] })
      g.labor += l.labor_cost || 0
      g.workers.push({ name: l.worker_name, days: l.days_worked, cost: l.labor_cost })
    })
    ;(travelData || []).forEach(t => {
      const g = m[t.site_id] || (m[t.site_id] = { site_number: '', site_name: '', labor: 0, travel: 0, ot: 0, workers: [] })
      g.travel += t.travel_cost || 0
    })
    ;(otCostData || []).forEach(o => {
      const g = m[o.site_id] || (m[o.site_id] = { site_number: o.site_number, site_name: o.site_name, labor: 0, travel: 0, ot: 0, workers: [] })
      g.ot += o.ot_cost || 0
    })
    return Object.values(m).sort((a, b) => (b.labor + b.travel + b.ot) - (a.labor + a.travel + a.ot))
  }, [laborData, travelData, otCostData])
```

- [ ] **Step 2: Add `otLookup`**

Immediately after the existing `cellLookup` `useMemo` (ends with `}, [assignments])`), add:

```js

  // otLookup[worker_id][iso] = { id, site_id, site_number, site_name, start_time, end_time, ot_hours, notes }
  const otLookup = useMemo(() => {
    const m = {}
    ;(otEntries || []).forEach(o => {
      const w = m[o.worker_id] || (m[o.worker_id] = {})
      w[o.date] = { id: o.id, site_id: o.site_id, site_number: o.sites?.site_number, site_name: o.sites?.name, start_time: o.start_time, end_time: o.end_time, ot_hours: o.ot_hours || 0, notes: o.notes || '' }
    })
    return m
  }, [otEntries])
```

- [ ] **Step 3: Add OT save/delete handlers**

Immediately after `handleCellDelete` (ends with `finally { setSaving(false) }\n  }`), add:

```js

  const handleOTSave = async (row) => {
    setSaving(true)
    try {
      const { error } = await supabase.from('worker_ot')
        .upsert(row, { onConflict: 'worker_id,date' })
      if (error) throw error
      refetchOT()
    } catch (e) { alert('Error: ' + e.message) }
    finally { setSaving(false) }
  }

  const handleOTDelete = async () => {
    if (!cellTarget?.existingOT?.id) return
    setSaving(true)
    try {
      const { error } = await supabase.from('worker_ot').delete().eq('id', cellTarget.existingOT.id)
      if (error) throw error
      setCellTarget(t => t ? { ...t, existingOT: null } : t)
      refetchOT()
    } catch (e) { alert('Error: ' + e.message) }
    finally { setSaving(false) }
  }
```

Note `handleOTSave` deliberately does not `setCellTarget(null)` or otherwise close the popup — the main `handleCellSave` (triggered by the same "บันทึก" click) still owns closing the popup on success. If the shift-row save fails, `CellEditPopup.save()` still attempts the OT save (they're independent calls); this is acceptable because a failed shift save already surfaces its own `alert`, and OT failures surface their own separately.

- [ ] **Step 4: Update `openCell` to include `existingOT`**

Replace:

```js
  const openCell = (worker, date, shift) => {
    const existing = cellLookup[worker.id]?.[date]?.[shift] || null
    setCellTarget({ worker, date, shift, existing })
  }
```

with:

```js
  const openCell = (worker, date, shift) => {
    const existing = cellLookup[worker.id]?.[date]?.[shift] || null
    const existingOT = otLookup[worker.id]?.[date] || null
    setCellTarget({ worker, date, shift, existing, existingOT })
  }
```

- [ ] **Step 5: Pass `otEntries` to `DayView` and `buildLineText`, and `otLookup` to `GridView`**

Replace:

```js
      {view === 'day' ? (
        <DayView dayIso={from} assignments={assignments} sites={sites} travelRate={travelRate} onEditHalf={openCell} />
      ) : (
        <GridView days={days} workers={workers} cellLookup={cellLookup} onEditHalf={openCell} cellH={cellH} variant={view} />
      )}
```

with:

```js
      {view === 'day' ? (
        <DayView dayIso={from} assignments={assignments} otEntries={otEntries} sites={sites} travelRate={travelRate} onEditHalf={openCell} />
      ) : (
        <GridView days={days} workers={workers} cellLookup={cellLookup} otLookup={otLookup} onEditHalf={openCell} cellH={cellH} variant={view} />
      )}
```

Replace:

```js
  const handleCopyLine = async () => {
    const text = buildLineText(days, assignments, sites)
```

with:

```js
  const handleCopyLine = async () => {
    const text = buildLineText(days, assignments, sites, otEntries)
```

- [ ] **Step 6: Update the cost card JSX to show OT as its own line**

Replace:

```jsx
              <div style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                <div style={{ fontSize: 10, color: 'var(--text3)' }}>รวม</div>
                <div style={{ color: 'var(--yellow)', fontWeight: 800, fontSize: 18 }}>{fmt(s.labor + s.travel)}</div>
                <div style={{ fontSize: 10, color: 'var(--text3)' }}>แรง {fmt(s.labor)}{s.travel > 0 && <> · เดินทาง {fmt(s.travel)}</>}</div>
              </div>
```

with:

```jsx
              <div style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                <div style={{ fontSize: 10, color: 'var(--text3)' }}>รวม</div>
                <div style={{ color: 'var(--yellow)', fontWeight: 800, fontSize: 18 }}>{fmt(s.labor + s.travel + s.ot)}</div>
                <div style={{ fontSize: 10, color: 'var(--text3)' }}>แรง {fmt(s.labor)}{s.travel > 0 && <> · เดินทาง {fmt(s.travel)}</>}{s.ot > 0 && <> · OT {fmt(s.ot)}</>}</div>
              </div>
```

- [ ] **Step 7: Pass the new props to `CellEditPopup`**

Replace:

```jsx
      {cellTarget && (
        <CellEditPopup
          target={cellTarget}
          sites={ongoingSites}
          onSave={handleCellSave}
          onDelete={handleCellDelete}
          onClose={() => setCellTarget(null)}
          saving={saving}
        />
      )}
```

with:

```jsx
      {cellTarget && (
        <CellEditPopup
          target={cellTarget}
          sites={ongoingSites}
          onSave={handleCellSave}
          onDelete={handleCellDelete}
          onSaveOT={handleOTSave}
          onDeleteOT={handleOTDelete}
          onClose={() => setCellTarget(null)}
          saving={saving}
        />
      )}
```

- [ ] **Step 8: Verify build**

Run: `npm run build`
Expected: built, no errors. This project's JSX has no compile-time prop
validation (no TypeScript, no PropTypes), so passing `otEntries`/`otLookup`
to `DayView`/`GridView` here — before Tasks 7–8 add those components'
matching prop destructuring — does not fail the build; the extra props are
just inert until those components read them. A build failure at this step
means a real syntax/import error in `Assign.jsx` itself, not a missing prop
downstream.

- [ ] **Step 9: Commit**

```bash
git add src/pages/Assign.jsx
git commit -m "Wire OT fetch/save/delete into Assign.jsx"
```

---

### Task 7: `DayView.jsx` — OT line and OT cost per site card

**Files:**
- Modify: `src/pages/assign/DayView.jsx`

**Interfaces:**
- Consumes: new prop `otEntries` (array, same shape as `useWorkerOTRange`'s output) from `Assign.jsx` (Task 6).
- Consumes: `otCost` from `./otMath.js` (Task 2).

- [ ] **Step 1: Add the OT prop, filter it per day, and render the OT line + cost**

In `src/pages/assign/DayView.jsx`, update the import line:

```js
import { fmt } from '../../lib/supabase.js'
import { TYPE_COLOR, TYPE_LABEL, SITE_TYPES } from './constants.js'
import { otCost } from './otMath.js'
```

Update the function signature:

```js
export default function DayView({ dayIso, assignments, otEntries, sites, travelRate, onEditHalf }) {
```

Immediately after `const rows = (assignments || []).filter(a => a.date === dayIso)`, add:

```js
  const dayOT = (otEntries || []).filter(o => o.date === dayIso)
  const otBySite = {}
  dayOT.forEach(o => { (otBySite[o.site_id] ||= []).push(o) })
```

Update the `total` calculation inside the `siteIds.map(sid => {...})` block — replace:

```js
          const g = bySite[sid]
          const meta = siteMeta[sid] || {}
          const travel = g.hasSiteType ? (meta.distance_km || 0) * 2 * (travelRate || 0) : 0
          const total = g.labor + travel
```

with:

```js
          const g = bySite[sid]
          const meta = siteMeta[sid] || {}
          const travel = g.hasSiteType ? (meta.distance_km || 0) * 2 * (travelRate || 0) : 0
          const siteOT = otBySite[sid] || []
          const otTotal = siteOT.reduce((s, o) => s + otCost(o.workers?.monthly_salary, o.ot_hours), 0)
          const total = g.labor + travel + otTotal
```

Update the cost display — replace:

```jsx
                <div style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <div style={{ fontSize: 10, color: 'var(--text3)' }}>รวมวันนี้</div>
                  <div style={{ color: 'var(--yellow)', fontWeight: 800, fontSize: 16 }}>{fmt(total)}</div>
                  <div style={{ fontSize: 10, color: 'var(--text3)' }}>
                    แรง {fmt(g.labor)}{travel > 0 && <> · เดินทาง {fmt(travel)}</>}
                  </div>
                </div>
```

with:

```jsx
                <div style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <div style={{ fontSize: 10, color: 'var(--text3)' }}>รวมวันนี้</div>
                  <div style={{ color: 'var(--yellow)', fontWeight: 800, fontSize: 16 }}>{fmt(total)}</div>
                  <div style={{ fontSize: 10, color: 'var(--text3)' }}>
                    แรง {fmt(g.labor)}{travel > 0 && <> · เดินทาง {fmt(travel)}</>}{otTotal > 0 && <> · OT {fmt(otTotal)}</>}
                  </div>
                </div>
```

Add the OT line inside the card, after the existing เช้า/บ่าย `<div style={{ display: 'flex', gap: 8 }}>...</div>` block, still inside the same site card `<div key={sid} ...>`:

```jsx
              {siteOT.length > 0 && (
                <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border)' }}>
                  <div style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--yellow)', marginBottom: 4 }}>⚡ OT</div>
                  {siteOT.map(o => (
                    <span key={o.id} onClick={() => onEditHalf({ id: o.worker_id, name: o.workers?.name, nickname: o.workers?.nickname }, o.date, 'morning')}
                      title={`${o.workers?.name || ''} · ${o.start_time?.slice(0,5)}-${o.end_time?.slice(0,5)}`}
                      style={{ background: 'rgba(255,209,102,0.25)', color: 'var(--yellow)', borderRadius: 5, padding: '3px 8px', margin: 2, fontSize: 11, cursor: 'pointer', display: 'inline-block' }}>
                      {o.workers?.nickname || o.workers?.name} ({o.start_time?.slice(0,5)}-{o.end_time?.slice(0,5)})
                    </span>
                  ))}
                </div>
              )}
```

Clicking an OT chip opens the same `CellEditPopup` via `onEditHalf` (passing `'morning'` as a placeholder shift, since the popup's OT section doesn't depend on which shift value is passed — it looks up `existingOT` by worker+date regardless).

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: built, no errors.

- [ ] **Step 3: Commit**

```bash
git add src/pages/assign/DayView.jsx
git commit -m "Show OT line and OT cost in DayView per-site cards"
```

---

### Task 8: `AssignCell.jsx` + `GridView.jsx` — OT indicator on grid cells

**Files:**
- Modify: `src/pages/assign/AssignCell.jsx`
- Modify: `src/pages/assign/GridView.jsx`

**Interfaces:**
- Consumes: new prop `hasOT` (boolean) on `AssignCell`.
- Consumes: new prop `otLookup` (Task 6's shape) on `GridView`.

- [ ] **Step 1: Add the `hasOT` indicator to `AssignCell`**

In `src/pages/assign/AssignCell.jsx`, update the function signature:

```js
export default function AssignCell({ cell = {}, hasOT = false, onEdit, w = '100%', h = 32, variant = 'week' }) {
```

Wrap the existing return value so an OT badge can overlay it. Replace the full return block (both the `same` branch and the split branch) — the file currently is:

```jsx
  // full-day block (both shifts identical)
  if (same) {
    const info = segInfo(morning, variant)
    return (
      <div onClick={() => onEdit('morning')} title={info.title}
        style={{
          width: w, height: h, borderRadius: 4, display: 'flex', alignItems: 'center',
          justifyContent: 'center', cursor: 'pointer', fontSize, fontWeight: 700,
          background: info.bg, color: info.color, overflow: 'hidden', padding: '0 4px',
          whiteSpace: 'nowrap',
        }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{info.label}</span>
      </div>
    )
  }

  // split (or partially empty)
  return (
    <div style={{ width: w, height: h, borderRadius: 4, overflow: 'hidden', background: 'rgba(255,255,255,.03)' }}>
      <Half info={segInfo(morning, variant)} h={h / 2} fontSize={Math.max(8, fontSize - 1)} onClick={() => onEdit('morning')} />
      <Half info={segInfo(evening, variant)} h={h / 2} fontSize={Math.max(8, fontSize - 1)} onClick={() => onEdit('evening')} />
    </div>
  )
}
```

Replace it with:

```jsx
  const otBadge = hasOT && (
    <span title="มี OT" style={{
      position: 'absolute', top: -2, right: -2, fontSize: 9, lineHeight: 1,
      background: 'var(--bg)', borderRadius: '50%', padding: 1,
    }}>⚡</span>
  )

  // full-day block (both shifts identical)
  if (same) {
    const info = segInfo(morning, variant)
    return (
      <div style={{ position: 'relative', width: w, height: h }}>
        <div onClick={() => onEdit('morning')} title={info.title}
          style={{
            width: '100%', height: '100%', borderRadius: 4, display: 'flex', alignItems: 'center',
            justifyContent: 'center', cursor: 'pointer', fontSize, fontWeight: 700,
            background: info.bg, color: info.color, overflow: 'hidden', padding: '0 4px',
            whiteSpace: 'nowrap',
          }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{info.label}</span>
        </div>
        {otBadge}
      </div>
    )
  }

  // split (or partially empty)
  return (
    <div style={{ position: 'relative', width: w, height: h }}>
      <div style={{ width: '100%', height: '100%', borderRadius: 4, overflow: 'hidden', background: 'rgba(255,255,255,.03)' }}>
        <Half info={segInfo(morning, variant)} h={h / 2} fontSize={Math.max(8, fontSize - 1)} onClick={() => onEdit('morning')} />
        <Half info={segInfo(evening, variant)} h={h / 2} fontSize={Math.max(8, fontSize - 1)} onClick={() => onEdit('evening')} />
      </div>
      {otBadge}
    </div>
  )
}
```

- [ ] **Step 2: Pass `otLookup` through `GridView` to `AssignCell`**

In `src/pages/assign/GridView.jsx`, update the function signature:

```js
export default function GridView({ days, workers, cellLookup, otLookup, onEditHalf, cellH = 32, variant = 'week' }) {
```

Replace:

```jsx
                  {days.map(d => (
                    <td key={d.iso} style={{ padding: 2, textAlign: 'center', opacity: d.isSunday ? 0.5 : 1 }}>
                      <AssignCell
                        cell={row[d.iso] || {}}
                        w="100%" h={cellH} variant={variant}
                        onEdit={(shift) => !d.isSunday && onEditHalf(w, d.iso, shift)}
                      />
                    </td>
                  ))}
```

with:

```jsx
                  {days.map(d => (
                    <td key={d.iso} style={{ padding: 2, textAlign: 'center', opacity: d.isSunday ? 0.5 : 1 }}>
                      <AssignCell
                        cell={row[d.iso] || {}}
                        hasOT={!!otLookup?.[w.id]?.[d.iso]}
                        w="100%" h={cellH} variant={variant}
                        onEdit={(shift) => !d.isSunday && onEditHalf(w, d.iso, shift)}
                      />
                    </td>
                  ))}
```

(The outer `.map(w => {...})` already names its loop variable `w` for "worker" — `otLookup?.[w.id]?.[d.iso]` refers to that worker, not to be confused with the `w`/`h` width/height props on `AssignCell` itself, which are unrelated shorthand params in that component.)

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: built, no errors.

- [ ] **Step 4: Commit**

```bash
git add src/pages/assign/AssignCell.jsx src/pages/assign/GridView.jsx
git commit -m "Add OT indicator badge to Assign grid cells"
```

---

### Task 9: `lineExport.js` — OT line in copy-for-LINE output

**Files:**
- Modify: `src/pages/assign/lineExport.js`

**Interfaces:**
- Consumes: new parameter `otEntries` on `buildLineText(days, assignments, sites, otEntries)`.

- [ ] **Step 1: Thread `otEntries` through `buildLineText` and `formatDayBlock`, ensure sites with OT-only entries still get a card**

Replace the full file:

```js
// ============================================================
// lineExport — format the Assign roster (day or week) as plain
// text for copying into a LINE group manually. Stopgap ahead of
// the automated Calendar/LINE sync (docs/superpowers/plans/2026-07-03-calendar-line-sync.md).
// ============================================================
import { fmtDate } from '../../lib/supabase.js'
import { SITE_TYPES } from './constants.js'

const DOW_TH = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส']
const OTHER_TYPE_LABEL = { office: 'ออฟฟิศ', leave: 'ลา', holiday: 'หยุด' }

function workerLabel(a) {
  const name = a.workers?.nickname || a.workers?.name || '—'
  const extras = []
  if (a.ot_hours > 0) extras.push(`OT ${a.ot_hours}ชม.`)
  if (a.notes) extras.push(a.notes)
  return extras.length ? `${name} (${extras.join(', ')})` : name
}

function otLabel(o) {
  const name = o.workers?.nickname || o.workers?.name || '—'
  return `${name} (${o.start_time?.slice(0, 5)}-${o.end_time?.slice(0, 5)})`
}

function formatDayBlock(dateIso, dayAssignments, dayOT, siteMeta) {
  const dow = DOW_TH[new Date(dateIso).getDay()]
  const header = `📅 ${fmtDate(dateIso)} (${dow})`

  const bySite = {}
  const others = []
  dayAssignments.forEach(a => {
    if (a.site_id && (SITE_TYPES.includes(a.type) || a.type === 'subcontract')) {
      const g = bySite[a.site_id] ||= { morning: [], evening: [] }
      g[a.shift]?.push(a)
    } else {
      others.push(a)
    }
  })

  const otBySite = {}
  dayOT.forEach(o => {
    (otBySite[o.site_id] ||= []).push(o)
    if (!bySite[o.site_id]) bySite[o.site_id] = { morning: [], evening: [] }  // OT-only site still gets a card
  })

  const siteIds = Object.keys(bySite)
  if (!siteIds.length && !others.length) return `${header}\n— ไม่มีงาน —`

  const lines = [header]
  siteIds.forEach(sid => {
    const g = bySite[sid]
    const meta = siteMeta[sid] || {}
    lines.push('')
    lines.push(`🏗️ ${meta.site_number || ''} ${meta.name || ''}`.trim())
    if (meta.contact_person) lines.push(`👤 ผู้ติดต่อ: ${meta.contact_person}${meta.phone ? ` (${meta.phone})` : ''}`)
    if (meta.map_url) lines.push(`📍 ${meta.map_url}`)
    lines.push(`🌅 เช้า: ${g.morning.length ? g.morning.map(workerLabel).join(', ') : '— ว่าง —'}`)
    lines.push(`🌆 บ่าย: ${g.evening.length ? g.evening.map(workerLabel).join(', ') : '— ว่าง —'}`)
    const siteOT = otBySite[sid] || []
    if (siteOT.length) lines.push(`⚡ OT: ${siteOT.map(otLabel).join(', ')}`)
  })
  if (others.length) {
    lines.push('')
    lines.push('🏢 ลา / ออฟฟิศ / หยุด')
    others.forEach(a => {
      const label = OTHER_TYPE_LABEL[a.type] || a.type
      const shift = a.shift === 'morning' ? 'เช้า' : 'บ่าย'
      lines.push(`- ${workerLabel(a)} — ${label} (${shift})`)
    })
  }
  return lines.join('\n')
}

/**
 * @param {{iso:string}[]} days - one entry for day view, seven for week view
 * @param {Array} assignments - rows already scoped to the same date range as `days`
 * @param {Array} sites
 * @param {Array} otEntries - rows already scoped to the same date range as `days` (useWorkerOTRange shape)
 * @returns {string} plain text ready to paste into LINE
 */
export function buildLineText(days, assignments, sites, otEntries) {
  const siteMeta = {}
  ;(sites || []).forEach(s => {
    siteMeta[s.id] = {
      name: s.name, site_number: s.site_number, map_url: s.map_url,
      contact_person: s.client_contact_person, phone: s.client_phone,
    }
  })

  const byDate = {}
  ;(assignments || []).forEach(a => { (byDate[a.date] ||= []).push(a) })

  const otByDate = {}
  ;(otEntries || []).forEach(o => { (otByDate[o.date] ||= []).push(o) })

  return (days || [])
    .map(d => formatDayBlock(d.iso, byDate[d.iso] || [], otByDate[d.iso] || [], siteMeta))
    .join('\n\n' + '─'.repeat(20) + '\n\n')
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: built, no errors.

- [ ] **Step 3: Verify with a scratch script**

Run:
```bash
node -e "
const fs = require('fs')
let src = fs.readFileSync('src/pages/assign/lineExport.js', 'utf8')
src = src.replace(\"import { fmtDate } from '../../lib/supabase.js'\", \"const fmtDate = (d) => new Date(d).toLocaleDateString('th-TH', { year: 'numeric', month: 'short', day: 'numeric' })\")
src = src.replace(\"import { SITE_TYPES } from './constants.js'\", \"const SITE_TYPES = ['site', 'factory']\")
src = src.replace(/^export /gm, '')
const module = { exports: {} }
new Function('module', src + '\nmodule.exports = { buildLineText }')(module)
const { buildLineText } = module.exports

const sites = [{ id: 's1', name: 'โครงการทดสอบ A', site_number: 'FX-2026-001' }]
const assignments = [
  { date: '2026-08-14', site_id: 's1', type: 'site', shift: 'morning', ot_hours: 0, notes: '', workers: { name: 'สมชาย', nickname: 'ชาย' } },
]
const otEntries = [
  { id: 'ot1', date: '2026-08-14', site_id: 's1', start_time: '17:30:00', end_time: '19:45:00', workers: { name: 'สมชาย', nickname: 'ชาย' } },
]
const days = [{ iso: '2026-08-14' }]
console.log(buildLineText(days, assignments, sites, otEntries))
"
```
Expected output includes a `⚡ OT: ชาย (17:30-19:45)` line after the เช้า/บ่าย lines.

- [ ] **Step 4: Commit**

```bash
git add src/pages/assign/lineExport.js
git commit -m "Show OT as its own line per site in copy-for-LINE output"
```

---

### Task 10: `Payroll.jsx` — merge OT from `worker_ot`

**Files:**
- Modify: `src/pages/Payroll.jsx`

**Interfaces:**
- Consumes: `fetchWorkerOTForRange` (Task 3), `mergeWorkerOT` (Task 4).

- [ ] **Step 1: Add the import**

In `src/pages/Payroll.jsx`, find the existing imports near the top of the file and add:

```js
import { fetchWorkerOTForRange } from '../hooks/useSupabase.js'
import { mergeWorkerOT } from '../lib/otMerge.js'
```

(Add these alongside whatever `supabase`/hook imports already exist at the top of the file — check the file's current import block and place these with the others rather than assuming a specific line number, since other work this session may have touched this file's import list.)

- [ ] **Step 2: Fetch and merge OT inside `handleCalcFromAssign`**

Locate this block (around line 211–226):

```js
      const { data: assigns, error } = await supabase
        .from('worker_assignments')
        .select('worker_id, type, ot_hours, workers(id, name, nickname, monthly_salary, monthly_contribution, has_social_security)')
        .gte('date', from)
        .lte('date', to)
      if (error) throw error

      // Group by worker
      const wmap = {}
      ;(assigns || []).forEach(a => {
        const w = a.workers
        if (!w) return
        if (!wmap[a.worker_id]) wmap[a.worker_id] = { worker: w, leave: 0, ot_hours: 0 }
        if (a.type === 'leave')  wmap[a.worker_id].leave += 0.5  // 1 กะ = 0.5 วัน (เช้า+บ่าย = 1 วัน)
        if (a.type === 'site')   wmap[a.worker_id].ot_hours += (a.ot_hours || 0)
      })
```

Replace with:

```js
      const { data: assigns, error } = await supabase
        .from('worker_assignments')
        .select('worker_id, type, ot_hours, workers(id, name, nickname, monthly_salary, monthly_contribution, has_social_security)')
        .gte('date', from)
        .lte('date', to)
      if (error) throw error

      // Group by worker
      const wmap = {}
      ;(assigns || []).forEach(a => {
        const w = a.workers
        if (!w) return
        if (!wmap[a.worker_id]) wmap[a.worker_id] = { worker: w, leave: 0, ot_hours: 0 }
        if (a.type === 'leave')  wmap[a.worker_id].leave += 0.5  // 1 กะ = 0.5 วัน (เช้า+บ่าย = 1 วัน)
        if (a.type === 'site')   wmap[a.worker_id].ot_hours += (a.ot_hours || 0)  // legacy OT stored on the shift row
      })

      const otRows = await fetchWorkerOTForRange(from, to)
      mergeWorkerOT(wmap, otRows)  // adds worker_ot's decoupled OT entries on top
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: built, no errors.

- [ ] **Step 3: Commit**

```bash
git add src/pages/Payroll.jsx
git commit -m "Merge worker_ot OT hours into Payroll's monthly calculation"
```

---

### Task 11: `HR.jsx` — merge OT from `worker_ot`

**Files:**
- Modify: `src/pages/HR.jsx`

**Interfaces:**
- Consumes: `fetchWorkerOTForRange` (Task 3), `mergeWorkerOT` (Task 4).

- [ ] **Step 1: Add the import**

In `src/pages/HR.jsx`, add alongside the existing imports:

```js
import { fetchWorkerOTForRange } from '../hooks/useSupabase.js'
import { mergeWorkerOT } from '../lib/otMerge.js'
```

- [ ] **Step 2: Fetch and merge OT inside `handleCalcFromAssign`**

Locate this block (around line 370–381):

```js
      const { data: assigns, error } = await supabase
        .from('worker_assignments')
        .select('worker_id, type, ot_hours, workers(id, name, nickname, monthly_salary, monthly_contribution, has_social_security)')
        .gte('date', from).lte('date', to)
      if (error) throw error
      const wmap = {}
      ;(assigns||[]).forEach(a => {
        const w = a.workers; if (!w) return
        if (!wmap[a.worker_id]) wmap[a.worker_id] = { worker: w, leave: 0, ot_hours: 0 }
        if (a.type === 'leave') wmap[a.worker_id].leave += 0.5  // 1 กะ = 0.5 วัน (เช้า+บ่าย = 1 วัน)
        if (a.type === 'site')  wmap[a.worker_id].ot_hours += (a.ot_hours||0)
      })
```

Replace with:

```js
      const { data: assigns, error } = await supabase
        .from('worker_assignments')
        .select('worker_id, type, ot_hours, workers(id, name, nickname, monthly_salary, monthly_contribution, has_social_security)')
        .gte('date', from).lte('date', to)
      if (error) throw error
      const wmap = {}
      ;(assigns||[]).forEach(a => {
        const w = a.workers; if (!w) return
        if (!wmap[a.worker_id]) wmap[a.worker_id] = { worker: w, leave: 0, ot_hours: 0 }
        if (a.type === 'leave') wmap[a.worker_id].leave += 0.5  // 1 กะ = 0.5 วัน (เช้า+บ่าย = 1 วัน)
        if (a.type === 'site')  wmap[a.worker_id].ot_hours += (a.ot_hours||0)  // legacy OT stored on the shift row
      })

      const otRows = await fetchWorkerOTForRange(from, to)
      mergeWorkerOT(wmap, otRows)  // adds worker_ot's decoupled OT entries on top
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: built, no errors.

- [ ] **Step 3: Commit**

```bash
git add src/pages/HR.jsx
git commit -m "Merge worker_ot OT hours into HR's monthly calculation"
```

---

### Task 12: End-to-end manual verification

**Files:** none (verification only)

- [ ] **Step 1: Start the dev server**

Run: `npm run dev`
Expected: Vite starts, prints a local URL (e.g. `http://localhost:3000/`).

- [ ] **Step 2: Add an OT entry via the +OT section**

In the Assign page (day or week view), click a worker's morning or evening cell for a date where that worker has a site/factory assignment. In the popup, scroll to the "⚡ OT" section, pick a site, enter a start and end time (e.g. 17:00–19:00), confirm the "= 2.0 ชม." preview appears, click "✅ บันทึก". Confirm the popup closes without an error alert.

- [ ] **Step 3: Confirm the OT indicator appears in the grid**

Reopen the same cell (or its sibling shift cell for the same worker/date) — confirm a small ⚡ badge appears on the day cell in week/month view (`GridView`), and confirm the OT you entered appears pre-filled when you reopen the popup.

- [ ] **Step 4: Confirm the day view shows the OT line and cost**

Switch to day view for that date. Confirm the site's card shows an "⚡ OT" line listing the worker and time range, and that the card's total cost includes an "OT" figure separate from "แรง".

- [ ] **Step 5: Confirm copy-for-LINE includes the OT line**

Click "📋 คัดลอกสำหรับ LINE" for a day/week that includes the OT entry from Step 2, paste the clipboard contents somewhere (e.g. a scratch text field), confirm a `⚡ OT: <nickname> (17:00-19:00)` line appears under that site's block.

- [ ] **Step 6: Confirm the one-per-day constraint surfaces cleanly**

Try to add a second OT entry for the same worker on the same date (open the popup again, fill in different times, save). Confirm this either updates the existing entry (upsert) rather than erroring, or — if editing produces a distinct row somehow — that the resulting behavior matches "at most one OT per worker per day" (there should be exactly one `worker_ot` row for that worker+date; verify via `execute_sql`: `SELECT COUNT(*) FROM worker_ot WHERE worker_id = '<id>' AND date = '<date>'` — expect `1`).

- [ ] **Step 7: Delete the OT entry and confirm it clears everywhere**

Reopen the popup, click "🗑️ ลบ OT". Confirm: the ⚡ grid badge disappears, the day-view OT line disappears, and copy-for-LINE no longer includes the OT line for that site/date.

- [ ] **Step 8: Confirm Payroll/HR totals include both legacy and new OT**

Pick a worker+month that has at least one legacy `worker_assignments.ot_hours` value already stored (query via `execute_sql`: `SELECT worker_id, date, ot_hours FROM worker_assignments WHERE ot_hours > 0 LIMIT 1` to find one) and also add a `worker_ot` entry for that same worker in the same month via Step 2. In Payroll (or HR), run "คำนวณจาก Assign" for that month and confirm the worker's `ot_hours`/`ot_amount` in the preview equals the legacy value plus the new entry's rounded hours.

- [ ] **Step 9: Clean up test data**

Delete any test OT entries created in Steps 2–8 that aren't meant to persist, via the UI (🗑️ ลบ OT) or `execute_sql` `DELETE FROM worker_ot WHERE notes IS NULL AND date >= CURRENT_DATE` scoped tightly enough to only remove rows you just created — confirm with a `SELECT` first before running any `DELETE`.

- [ ] **Step 10: Final build check**

Run: `npm run build`
Expected: built, no errors, and `build-info.json` reports the latest commit.
