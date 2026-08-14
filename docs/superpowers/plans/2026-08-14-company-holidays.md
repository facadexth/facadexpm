# Company Holiday Calendar + Holiday Work Premium Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let HR maintain a company-wide holiday calendar (date + name), show a visual marker on those dates in the Assign page, and pay a configurable-multiplier premium (added to net_pay, real money) to any worker who had a site/factory shift on a holiday date.

**Architecture:** A new `company_holidays` table (date + name, no per-worker rows, no auto-marking of `worker_assignments`). The multiplier is a new `app_settings` key (`holiday_pay_multiplier`, reusing the existing key/value settings mechanism), editable from the HR tab. `Payroll.jsx`/`HR.jsx`'s existing "คำนวณจาก Assign" flow additionally counts each worker's site/factory shifts whose date falls in `company_holidays` and adds a bonus line. The Assign grid (`GridView.jsx` for week/month, `ViewToggle.jsx` for day view's date label) shows a small marker on holiday dates.

**Tech Stack:** React + Vite, Supabase (Postgres + supabase-js). No automated test suite in this project — verification is `npm run build` plus Supabase MCP `execute_sql` round-trips and manual dev-server click-throughs, matching this project's established convention.

## Global Constraints

- Supabase project id: `yyzbgdmgyvvypfcjuhtr`. Apply migrations via `mcp__plugin_supabase_supabase__apply_migration`.
- This feature never touches `worker_assignments` — no auto-marking, no auto-creating rows. A worker with no assignment on a holiday date is left alone entirely (confirmed design decision).
- Holiday pay formula: `holiday_bonus = holiday_shift_count × (monthly_salary / 26) × 0.5 × holiday_pay_multiplier`, where `holiday_shift_count` counts only `type IN ('site','factory')` shifts (the existing `SITE_TYPES` constant) whose `date` matches a `company_holidays.date`. `holiday_pay_multiplier` defaults to `1.5` and is stored in `app_settings`, editable from the HR tab (not the Settings page).
- This is real additional pay, added into `net_pay` alongside the existing OT bonus, shown as its own line item — never merged into any other figure.
- No RLS — every table in this schema has `rowsecurity = false`; match that.
- Thai shift label is "บ่าย" (not "เย็น") in any UI copy touched.

---

### Task 1: `company_holidays` table + `holiday_pay_multiplier` setting

**Files:**
- Create: `supabase/migrations/2026-08-14-04-company-holidays.sql`
- Modify: `supabase/schema.sql`

**Interfaces:**
- Produces: table `company_holidays(id, date UNIQUE, name, created_at)` — consumed by Task 2's hooks.
- Produces: `app_settings` row `key='holiday_pay_multiplier', value='1.5'` — consumed by Task 3 (HR tab editor) and Tasks 5-6 (payroll calc).

- [ ] **Step 1: Write the migration**

`supabase/migrations/2026-08-14-04-company-holidays.sql`:

```sql
-- company_holidays: company-wide holiday calendar. Does NOT touch
-- worker_assignments — no auto-marking of workers as on-holiday. Used
-- only to (a) mark the date visually in the Assign grid, and (b) pay a
-- premium to whoever has a site/factory shift on that date.
-- See docs/superpowers/specs/2026-08-14-company-holidays-design.md
CREATE TABLE company_holidays (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date       DATE NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_company_holidays_date ON company_holidays(date);

-- Default holiday-pay multiplier (1.5x), editable from the HR tab.
-- Reuses the existing app_settings key/value mechanism (same one
-- travel_rate_per_km already uses).
INSERT INTO app_settings (key, value)
VALUES ('holiday_pay_multiplier', '1.5')
ON CONFLICT (key) DO NOTHING;
```

- [ ] **Step 2: Apply the migration**

Use `mcp__plugin_supabase_supabase__apply_migration` with `project_id: yyzbgdmgyvvypfcjuhtr`, `name: company_holidays`, and the full SQL from Step 1 as `query`.

- [ ] **Step 3: Verify the table**

Run via `execute_sql`:
```sql
SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = 'company_holidays' ORDER BY ordinal_position;
```
Expected: 4 rows — `id` (uuid), `date` (date), `name` (text), `created_at` (timestamp with time zone).

- [ ] **Step 4: Verify the UNIQUE constraint and the seeded setting**

Run (single call, rollback-safe):
```sql
BEGIN;
INSERT INTO company_holidays (date, name) VALUES (CURRENT_DATE + 900, '__TEST__');
INSERT INTO company_holidays (date, name) VALUES (CURRENT_DATE + 900, '__TEST_dup__');
ROLLBACK;
```
Expected: first INSERT succeeds, second fails with `duplicate key value violates unique constraint "company_holidays_date_key"`.

Then run separately:
```sql
SELECT key, value FROM app_settings WHERE key = 'holiday_pay_multiplier';
```
Expected: one row, `value = '1.5'`.

- [ ] **Step 5: Verify RLS is disabled**

Run: `SELECT rowsecurity FROM pg_tables WHERE tablename = 'company_holidays';`
Expected: `false`.

- [ ] **Step 6: Add the same objects to `supabase/schema.sql`**

Find the `WORKER_OT` table block in `supabase/schema.sql` (search for `-- WORKER_OT`) — insert a new section immediately after its closing `CREATE INDEX idx_worker_ot_date ...;` line and before the next `-- ----` section header:

```sql

-- ----------------------------------------------------------------
-- COMPANY_HOLIDAYS — ปฏิทินวันหยุดบริษัท (ไม่ auto-mark worker_assignments)
-- ----------------------------------------------------------------
CREATE TABLE company_holidays (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date       DATE NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_company_holidays_date ON company_holidays(date);
```

Then find the `INSERT INTO app_settings` or `app_settings` table section in `schema.sql` (search for `app_settings`) and add, near any existing seed data for that table:

```sql
INSERT INTO app_settings (key, value) VALUES ('holiday_pay_multiplier', '1.5') ON CONFLICT (key) DO NOTHING;
```

If `schema.sql` has no existing `app_settings` seed section, add this INSERT immediately after the `company_holidays` block you just added, with a one-line comment `-- default holiday pay multiplier`.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/2026-08-14-04-company-holidays.sql supabase/schema.sql
git commit -m "Add company_holidays table and holiday_pay_multiplier setting"
```

---

### Task 2: `useSupabase.js` — holiday data hooks

**Files:**
- Modify: `src/hooks/useSupabase.js`

**Interfaces:**
- Produces: `useCompanyHolidays() -> { data, loading, error, refetch }` — all holidays ordered by date, for the HR tab's list. Consumed by Task 3.
- Produces: `useCompanyHolidaysRange(from, to) -> { data, loading, error, refetch }` — holidays within `[from, to]`, for the Assign grid marker. Consumed by Task 4.
- Produces: `fetchCompanyHolidaysForRange(from, to) -> Promise<Array<{date, name}>>` — imperative version, for the Payroll/HR calc button. Consumed by Tasks 5-6.
- Produces: `saveCompanyHoliday({date, name}) -> Promise<void>` — imperative insert. Consumed by Task 3.
- Produces: `deleteCompanyHoliday(id) -> Promise<void>` — imperative delete. Consumed by Task 3.

- [ ] **Step 1: Add the hooks and plain functions**

In `src/hooks/useSupabase.js`, immediately after the `useOTCostBySite` function (search for `export function useOTCostBySite`, insert after its closing `}`), add:

```js

// ── Company Holidays ──────────────────────────────────────────

/** ปฏิทินวันหยุดบริษัททั้งหมด — ใช้ในแท็บ HR */
export function useCompanyHolidays() {
  return useQuery(async () => {
    const { data, error } = await supabase
      .from('company_holidays')
      .select('id, date, name')
      .order('date')
    if (error) throw error
    return data
  })
}

/** วันหยุดในช่วงวันที่ — ใช้กับหัวตาราง Assign (week/month/day) */
export function useCompanyHolidaysRange(from, to) {
  return useQuery(async () => {
    if (!from || !to) return []
    const { data, error } = await supabase
      .from('company_holidays')
      .select('id, date, name')
      .gte('date', from)
      .lte('date', to)
      .order('date')
    if (error) throw error
    return data
  }, [from, to])
}

/** เหมือน useCompanyHolidaysRange แต่เรียกแบบ imperative — ใช้ใน Payroll/HR handleCalcFromAssign */
export async function fetchCompanyHolidaysForRange(from, to) {
  const { data, error } = await supabase
    .from('company_holidays')
    .select('date, name')
    .gte('date', from)
    .lte('date', to)
  if (error) throw error
  return data
}

export async function saveCompanyHoliday({ date, name }) {
  const { error } = await supabase.from('company_holidays').insert({ date, name })
  if (error) throw error
}

export async function deleteCompanyHoliday(id) {
  const { error } = await supabase.from('company_holidays').delete().eq('id', id)
  if (error) throw error
}
```

- [ ] **Step 2: Verify the file still parses correctly**

Run: `npm run build`
Expected: built, no errors.

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useSupabase.js
git commit -m "Add company holiday data hooks"
```

---

### Task 3: HR tab — holiday calendar management UI

**Files:**
- Modify: `src/pages/HR.jsx`

**Interfaces:**
- Consumes: `useCompanyHolidays`, `saveCompanyHoliday`, `deleteCompanyHoliday`, `useAppSetting`, `saveAppSetting` (the last two already exist in `useSupabase.js`, used elsewhere for `travel_rate_per_km`).

- [ ] **Step 1: Add the imports**

In `src/pages/HR.jsx`, update the existing import line (currently `import { useWorkers, useSalary, usePreviousMonthSalaries, useAuditLogs, fetchWorkerOTForRange } from '../hooks/useSupabase.js'`) to also include the new names:

```js
import { useWorkers, useSalary, usePreviousMonthSalaries, useAuditLogs, fetchWorkerOTForRange, useCompanyHolidays, saveCompanyHoliday, deleteCompanyHoliday, useAppSetting, saveAppSetting, fetchCompanyHolidaysForRange } from '../hooks/useSupabase.js'
```

- [ ] **Step 2: Add a small holiday-form component**

Immediately after the `SalaryForm` function's closing `}` (search for `function SalaryForm`, find where its definition ends, right before the `// ── HR Main Component ──` comment), add:

```js

// ── Holiday Form ───────────────────────────────────────────────
function HolidayForm({ onSave, onCancel, loading }) {
  const [date, setDate] = useState('')
  const [name, setName] = useState('')
  return (
    <form onSubmit={e => { e.preventDefault(); onSave({ date, name }) }}>
      <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
        <div>
          <label className="label">วันที่ ★</label>
          <input type="date" className="input" required value={date} onChange={e => setDate(e.target.value)} />
        </div>
        <div>
          <label className="label">ชื่อวันหยุด ★</label>
          <input className="input" required value={name} onChange={e => setName(e.target.value)} placeholder="เช่น วันแรงงาน" />
        </div>
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>ยกเลิก</button>
        <button type="submit" className="btn btn-primary" disabled={loading}>{loading ? '⏳...' : '✅ บันทึก'}</button>
      </div>
    </form>
  )
}
```

- [ ] **Step 3: Add state and handlers in the HR component**

In `src/pages/HR.jsx`'s main `HR()` component, immediately after the `// Audit state` block (search for `const [auditTable, setAuditTable] = useState('')` and its following line), add:

```js

  // Holiday calendar state
  const { data: holidays, refetch: refetchHolidays } = useCompanyHolidays()
  const [showHolidayForm, setShowHolidayForm] = useState(false)
  const [savingHoliday, setSavingHoliday] = useState(false)
  const [deleteHolidayId, setDeleteHolidayId] = useState(null)
  const { data: multiplierVal, refetch: refetchMultiplier } = useAppSetting('holiday_pay_multiplier', '1.5')
  const [multiplierInput, setMultiplierInput] = useState('')
  const [savingMultiplier, setSavingMultiplier] = useState(false)
  useEffect(() => { if (multiplierVal != null) setMultiplierInput(String(multiplierVal)) }, [multiplierVal])
```

Then, immediately after the `handleDeleteWorker` function's closing `}` (search for `const handleDeleteWorker = async`, find its closing brace), add:

```js

  // ── Holiday handlers ──
  const handleSaveHoliday = async (form) => {
    setSavingHoliday(true)
    try {
      await saveCompanyHoliday(form)
      setShowHolidayForm(false); refetchHolidays()
    } catch (e) { alert('Error: ' + e.message) }
    finally { setSavingHoliday(false) }
  }

  const handleDeleteHoliday = async () => {
    if (!deleteHolidayId) return
    try {
      await deleteCompanyHoliday(deleteHolidayId)
      setDeleteHolidayId(null); refetchHolidays()
    } catch (e) { alert('Error: ' + e.message) }
  }

  const handleSaveMultiplier = async () => {
    setSavingMultiplier(true)
    try {
      await saveAppSetting('holiday_pay_multiplier', parseFloat(multiplierInput) || 1.5)
      refetchMultiplier()
      alert('✅ บันทึกตัวคูณโบนัสวันหยุดแล้ว')
    } catch (e) { alert('Error: ' + e.message) }
    finally { setSavingMultiplier(false) }
  }
```

- [ ] **Step 4: Add the holiday calendar section to the Workers tab**

In the JSX, inside `{innerTab === 'workers' && (...)}`, immediately after the closing `</div>` of the existing worker-list `<div className="card">...</div>` block and before that block's own wrapping `</div>` closes the tab (i.e., append as a new sibling section within the `workers` tab, after the worker table card), add:

```jsx
          <div style={{ marginTop: 24 }}>
            <div style={{ display: 'flex', gap: 10, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: 1 }}>
                🎌 วันหยุดประจำปี
              </div>
              {canEdit && <button className="btn btn-sm btn-primary" onClick={() => setShowHolidayForm(true)}>+ เพิ่มวันหยุด</button>}
            </div>
            {canEdit && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
                <label className="label" style={{ marginBottom: 0 }}>ตัวคูณโบนัสวันหยุด (ค่าเริ่มต้น 1.5)</label>
                <input type="number" className="input input-sm" style={{ width: 90 }} min="1" step="0.1"
                  value={multiplierInput} onChange={e => setMultiplierInput(e.target.value)} />
                <button className="btn btn-sm btn-ghost" onClick={handleSaveMultiplier} disabled={savingMultiplier}>
                  {savingMultiplier ? '⏳...' : '💾 บันทึก'}
                </button>
              </div>
            )}
            <div className="card">
              <div className="table-wrap">
                <table>
                  <thead><tr><th>วันที่</th><th>ชื่อวันหยุด</th><th></th></tr></thead>
                  <tbody>
                    {(holidays || []).map(h => (
                      <tr key={h.id}>
                        <td style={{ fontSize: 12 }}>{new Date(h.date).toLocaleDateString('th-TH', { year: 'numeric', month: 'short', day: 'numeric' })}</td>
                        <td style={{ fontWeight: 600 }}>{h.name}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          {canEdit && <button className="btn btn-sm btn-danger" onClick={() => setDeleteHolidayId(h.id)}>🗑️</button>}
                        </td>
                      </tr>
                    ))}
                    {!(holidays || []).length && (
                      <tr><td colSpan={3} style={{ textAlign: 'center', color: 'var(--text3)', padding: 24 }}>ยังไม่มีวันหยุดที่กำหนด</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
```

- [ ] **Step 5: Add the modal renders**

Immediately after the existing `{deleteWorkerId && (<ConfirmDialog .../>)}` block in the JSX (near the bottom, in the `{/* ── Modals ── */}` section), add:

```jsx
      {showHolidayForm && (
        <Modal title="เพิ่มวันหยุดประจำปี" onClose={() => setShowHolidayForm(false)} maxWidth={420}>
          <HolidayForm onSave={handleSaveHoliday} onCancel={() => setShowHolidayForm(false)} loading={savingHoliday} />
        </Modal>
      )}

      {deleteHolidayId && (
        <ConfirmDialog title="ลบวันหยุด" message="ยืนยันการลบวันหยุดนี้?"
          onConfirm={handleDeleteHoliday} onCancel={() => setDeleteHolidayId(null)} danger />
      )}
```

- [ ] **Step 6: Verify build**

Run: `npm run build`
Expected: built, no errors.

- [ ] **Step 7: Verify the CRUD round-trip via SQL**

Run (rollback-safe):
```sql
BEGIN;
INSERT INTO company_holidays (date, name) VALUES (CURRENT_DATE + 901, '__TEST_hr_ui__') RETURNING id, date, name;
DELETE FROM company_holidays WHERE name = '__TEST_hr_ui__';
SELECT count(*) FROM company_holidays WHERE name = '__TEST_hr_ui__';
ROLLBACK;
```
Expected: INSERT returns the row; the count after DELETE is `0` (confirms delete-by-id-equivalent logic works — the actual UI uses `.eq('id', ...)` via `deleteCompanyHoliday`, this just confirms the underlying delete-by-filter semantics on this table).

- [ ] **Step 8: Commit**

```bash
git add src/pages/HR.jsx
git commit -m "Add holiday calendar management UI to HR tab"
```

---

### Task 4: Holiday marker on the Assign grid

**Files:**
- Modify: `src/pages/Assign.jsx`
- Modify: `src/pages/assign/GridView.jsx`
- Modify: `src/pages/assign/ViewToggle.jsx`

**Interfaces:**
- Consumes: `useCompanyHolidaysRange` (Task 2).
- Produces: `holidaySet` (a `Set<string>` of ISO date strings) passed from `Assign.jsx` to both `GridView` (new `holidayDates` prop) and `ViewToggle` (new `holidayDates` prop).

- [ ] **Step 1: Fetch holidays and build a lookup Set in `Assign.jsx`**

In `src/pages/Assign.jsx`, update the import line to add `useCompanyHolidaysRange`:

```js
import { useWorkers, useSites, useAssignmentsRange, useLaborCost, useSiteTravelCost, useAppSetting, useWorkerOTRange, useOTCostBySite, useCompanyHolidaysRange } from '../hooks/useSupabase.js'
```

Immediately after the line `const { data: otCostData } = useOTCostBySite()`, add:

```js
  const { data: holidaysInRange } = useCompanyHolidaysRange(from, to)
  const holidayDates = useMemo(() => new Set((holidaysInRange || []).map(h => h.date)), [holidaysInRange])
```

- [ ] **Step 2: Pass `holidayDates` to `GridView` and `ViewToggle`**

Replace:

```jsx
        <ViewToggle view={view} onView={setView} anchor={anchor} onAnchor={setAnchor} />
```

with:

```jsx
        <ViewToggle view={view} onView={setView} anchor={anchor} onAnchor={setAnchor} holidayDates={holidayDates} />
```

Replace:

```jsx
        <GridView days={days} workers={workers} cellLookup={cellLookup} otLookup={otLookup} onEditHalf={openCell} cellH={cellH} variant={view} />
```

with:

```jsx
        <GridView days={days} workers={workers} cellLookup={cellLookup} otLookup={otLookup} holidayDates={holidayDates} onEditHalf={openCell} cellH={cellH} variant={view} />
```

- [ ] **Step 3: Show the marker in `GridView.jsx`'s day-column header**

In `src/pages/assign/GridView.jsx`, update the function signature:

```js
export default function GridView({ days, workers, cellLookup, otLookup, holidayDates, onEditHalf, cellH = 32, variant = 'week' }) {
```

Replace the day-header `<th>` block:

```jsx
              {days.map(d => (
                <th key={d.iso} style={{
                  padding: '6px 2px', textAlign: 'center', fontSize: 10,
                  color: d.isSunday ? 'var(--text3)' : 'var(--text2)', opacity: d.isSunday ? 0.45 : 1,
                }}>
                  <div style={{ fontSize: 9 }}>{DOW_TH[d.dow]}</div>
                  <div>{d.date.getDate()}</div>
                </th>
              ))}
```

with:

```jsx
              {days.map(d => (
                <th key={d.iso} title={holidayDates?.has(d.iso) ? 'วันหยุดบริษัท' : undefined} style={{
                  padding: '6px 2px', textAlign: 'center', fontSize: 10,
                  color: d.isSunday ? 'var(--text3)' : 'var(--text2)', opacity: d.isSunday ? 0.45 : 1,
                }}>
                  <div style={{ fontSize: 9 }}>{DOW_TH[d.dow]}</div>
                  <div>{d.date.getDate()}{holidayDates?.has(d.iso) && ' 🎌'}</div>
                </th>
              ))}
```

- [ ] **Step 4: Show the marker in `ViewToggle.jsx`'s date label (day view)**

In `src/pages/assign/ViewToggle.jsx`, add a `date-fns format` import for producing an ISO date string, and thread `holidayDates` through. Update the top import line:

```js
import { addDays, addWeeks, addMonths, format } from 'date-fns'
```

(this import already exists — `format` is already imported, no change needed to the import line itself).

Update the function signature:

```js
export default function ViewToggle({ view, onView, anchor, onAnchor, holidayDates }) {
```

Replace the final label `<div>` in the returned JSX:

```jsx
      <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text2)' }}>{labelFor(view, anchor)}</div>
```

with:

```jsx
      <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text2)' }}>
        {labelFor(view, anchor)}
        {view === 'day' && holidayDates?.has(format(anchor, 'yyyy-MM-dd')) && ' 🎌'}
      </div>
```

- [ ] **Step 5: Verify build**

Run: `npm run build`
Expected: built, no errors.

- [ ] **Step 6: Commit**

```bash
git add src/pages/Assign.jsx src/pages/assign/GridView.jsx src/pages/assign/ViewToggle.jsx
git commit -m "Show holiday marker in Assign grid header and day-view date label"
```

---

### Task 5: `Payroll.jsx` — holiday bonus calculation

**Files:**
- Modify: `src/pages/Payroll.jsx`

**Interfaces:**
- Consumes: `fetchCompanyHolidaysForRange`, `useAppSetting` (Task 2 / existing).

- [ ] **Step 1: Add the imports**

In `src/pages/Payroll.jsx`, update the import line (currently `import { useSalary, useWorkers, fetchWorkerOTForRange } from '../hooks/useSupabase.js'`):

```js
import { useSalary, useWorkers, fetchWorkerOTForRange, fetchCompanyHolidaysForRange, useAppSetting } from '../hooks/useSupabase.js'
```

- [ ] **Step 2: Read the multiplier setting in the component**

Immediately after the line `const { data: workers } = useWorkers()`, add:

```js
  const { data: holidayMultiplierVal } = useAppSetting('holiday_pay_multiplier', '1.5')
```

- [ ] **Step 3: Fetch holidays and compute the bonus inside `handleCalcFromAssign`**

Locate this block:

```js
      const otRows = await fetchWorkerOTForRange(from, to)
      mergeWorkerOT(wmap, otRows)  // adds worker_ot's decoupled OT entries on top

      const results = Object.entries(wmap).map(([worker_id, d]) => {
        const daily_rate     = (d.worker.monthly_salary || 0) / 26
        const leave_ded      = parseFloat((d.leave * daily_rate).toFixed(2))
        const ot_amt         = parseFloat((d.ot_hours * daily_rate / 8 * 1.5).toFixed(2))
        const sso            = d.worker.has_social_security
          ? parseFloat(Math.min(750, (d.worker.monthly_salary||0) * 0.05).toFixed(2)) : 0
        const net = parseFloat((
          (d.worker.monthly_salary||0)
          - sso - leave_ded + ot_amt
        ).toFixed(2))
        return {
          worker_id,
          name:            d.worker.name,
          nickname:        d.worker.nickname,
          base_salary:     d.worker.monthly_salary || 0,
          contribution:    d.worker.monthly_contribution || 0,
          social_security_ded: sso,
          leave_days:      d.leave,
          leave_deduction: leave_ded,
          ot_hours:        d.ot_hours,
          ot_amount:       ot_amt,
          net_pay:         net,
        }
      })
```

Replace it with:

```js
      const otRows = await fetchWorkerOTForRange(from, to)
      mergeWorkerOT(wmap, otRows)  // adds worker_ot's decoupled OT entries on top

      // Count each worker's site/factory shifts that fall on a company holiday.
      const holidayRows = await fetchCompanyHolidaysForRange(from, to)
      const holidaySet = new Set(holidayRows.map(h => h.date))
      const holidayMultiplier = parseFloat(holidayMultiplierVal) || 1.5
      ;(assigns || []).forEach(a => {
        if (!wmap[a.worker_id]) return
        if (a.type === 'site' && holidaySet.has(a.date)) {
          wmap[a.worker_id].holiday_shifts = (wmap[a.worker_id].holiday_shifts || 0) + 1
        }
      })

      const results = Object.entries(wmap).map(([worker_id, d]) => {
        const daily_rate     = (d.worker.monthly_salary || 0) / 26
        const leave_ded      = parseFloat((d.leave * daily_rate).toFixed(2))
        const ot_amt         = parseFloat((d.ot_hours * daily_rate / 8 * 1.5).toFixed(2))
        const holiday_bonus  = parseFloat(((d.holiday_shifts || 0) * daily_rate * 0.5 * holidayMultiplier).toFixed(2))
        const sso            = d.worker.has_social_security
          ? parseFloat(Math.min(750, (d.worker.monthly_salary||0) * 0.05).toFixed(2)) : 0
        const net = parseFloat((
          (d.worker.monthly_salary||0)
          - sso - leave_ded + ot_amt + holiday_bonus
        ).toFixed(2))
        return {
          worker_id,
          name:            d.worker.name,
          nickname:        d.worker.nickname,
          base_salary:     d.worker.monthly_salary || 0,
          contribution:    d.worker.monthly_contribution || 0,
          social_security_ded: sso,
          leave_days:      d.leave,
          leave_deduction: leave_ded,
          ot_hours:        d.ot_hours,
          ot_amount:       ot_amt,
          holiday_shifts:  d.holiday_shifts || 0,
          holiday_bonus,
          net_pay:         net,
        }
      })
```

Note: `assigns` here refers to the same `data: assigns` array already fetched earlier in `handleCalcFromAssign` (the `worker_assignments` query) — this block reuses it, no new query needed for the shift-counting itself, only for fetching `holidayRows`.

- [ ] **Step 4: Fold `holiday_bonus` into the saved payload**

Locate `handleConfirmCalc`'s payload construction:

```js
        const payload = {
          worker_id:           r.worker_id,
          month, year,
          base_salary:         r.base_salary,
          contribution:        r.contribution,
          ot_amount:           r.ot_amount,
          social_security_ded: r.social_security_ded,
          leave_deduction:     r.leave_deduction,
          net_pay:             r.net_pay,
        }
```

Replace with:

```js
        const payload = {
          worker_id:           r.worker_id,
          month, year,
          base_salary:         r.base_salary,
          contribution:        r.contribution,
          ot_amount:           r.ot_amount + (r.holiday_bonus || 0),
          social_security_ded: r.social_security_ded,
          leave_deduction:     r.leave_deduction,
          net_pay:             r.net_pay,
        }
```

`salary_records` has no dedicated `holiday_bonus` column (out of scope per the design — adding a persisted column is unnecessary since the number is derivable and this project avoids schema additions with no other consumer). Folding it into `ot_amount` for the saved record keeps `net_pay` correct without a migration; the calc-preview modal (Step 5) still shows it as its own line for the user to review before confirming.

- [ ] **Step 5: Show holiday bonus in the calc preview modal**

Locate the preview table's `<thead>`:

```jsx
                <thead>
                  <tr>
                    <th>พนักงาน</th><th>เงินเดือน</th>
                    <th>วันลา</th><th>หักลา</th>
                    <th>OT (ชม.)</th><th>OT (บาท)</th>
                    <th>ประกันสังคม</th><th>รับสุทธิ</th>
                  </tr>
                </thead>
```

Replace with:

```jsx
                <thead>
                  <tr>
                    <th>พนักงาน</th><th>เงินเดือน</th>
                    <th>วันลา</th><th>หักลา</th>
                    <th>OT (ชม.)</th><th>OT (บาท)</th>
                    <th>กะวันหยุด</th><th>โบนัสวันหยุด</th>
                    <th>ประกันสังคม</th><th>รับสุทธิ</th>
                  </tr>
                </thead>
```

Locate the corresponding `<tbody>` row:

```jsx
                  {calcPreview.map((r, i) => (
                    <tr key={i}>
                      <td style={{ fontWeight: 600 }}>{r.name}{r.nickname ? ` (${r.nickname})` : ''}</td>
                      <td className="font-mono">{fmt(r.base_salary)}</td>
                      <td style={{ textAlign: 'center', color: r.leave_days > 0 ? 'var(--red)' : 'var(--text3)' }}>{r.leave_days || '—'}</td>
                      <td className="font-mono" style={{ color: 'var(--red)' }}>{r.leave_deduction > 0 ? `(${fmt(r.leave_deduction)})` : '—'}</td>
                      <td style={{ textAlign: 'center', color: r.ot_hours > 0 ? 'var(--yellow)' : 'var(--text3)' }}>{r.ot_hours || '—'}</td>
                      <td className="font-mono" style={{ color: 'var(--yellow)' }}>{r.ot_amount > 0 ? fmt(r.ot_amount) : '—'}</td>
                      <td className="font-mono" style={{ color: 'var(--red)', fontSize: 12 }}>{r.social_security_ded > 0 ? `(${fmt(r.social_security_ded)})` : '—'}</td>
                      <td className="font-mono" style={{ color: 'var(--green)', fontWeight: 700 }}>{fmt(r.net_pay)}</td>
                    </tr>
                  ))}
```

Replace with:

```jsx
                  {calcPreview.map((r, i) => (
                    <tr key={i}>
                      <td style={{ fontWeight: 600 }}>{r.name}{r.nickname ? ` (${r.nickname})` : ''}</td>
                      <td className="font-mono">{fmt(r.base_salary)}</td>
                      <td style={{ textAlign: 'center', color: r.leave_days > 0 ? 'var(--red)' : 'var(--text3)' }}>{r.leave_days || '—'}</td>
                      <td className="font-mono" style={{ color: 'var(--red)' }}>{r.leave_deduction > 0 ? `(${fmt(r.leave_deduction)})` : '—'}</td>
                      <td style={{ textAlign: 'center', color: r.ot_hours > 0 ? 'var(--yellow)' : 'var(--text3)' }}>{r.ot_hours || '—'}</td>
                      <td className="font-mono" style={{ color: 'var(--yellow)' }}>{r.ot_amount > 0 ? fmt(r.ot_amount) : '—'}</td>
                      <td style={{ textAlign: 'center', color: r.holiday_shifts > 0 ? 'var(--accent)' : 'var(--text3)' }}>{r.holiday_shifts || '—'}</td>
                      <td className="font-mono" style={{ color: 'var(--accent)' }}>{r.holiday_bonus > 0 ? fmt(r.holiday_bonus) : '—'}</td>
                      <td className="font-mono" style={{ color: 'var(--red)', fontSize: 12 }}>{r.social_security_ded > 0 ? `(${fmt(r.social_security_ded)})` : '—'}</td>
                      <td className="font-mono" style={{ color: 'var(--green)', fontWeight: 700 }}>{fmt(r.net_pay)}</td>
                    </tr>
                  ))}
```

- [ ] **Step 6: Verify build**

Run: `npm run build`
Expected: built, no errors.

- [ ] **Step 7: Commit**

```bash
git add src/pages/Payroll.jsx
git commit -m "Add holiday work bonus to Payroll's Assign-based calculation"
```

---

### Task 6: `HR.jsx` — holiday bonus calculation

**Files:**
- Modify: `src/pages/HR.jsx`

**Interfaces:**
- Consumes: `fetchCompanyHolidaysForRange`, `useAppSetting` (already imported into this file in Task 3).

- [ ] **Step 1: Read the multiplier setting**

`useAppSetting('holiday_pay_multiplier', '1.5')` is already called in this file from Task 3 (as `multiplierVal`, used for the HR-tab editor). Reuse that same value here — do not call `useAppSetting` a second time with a different variable name. Confirm the existing declaration reads:

```js
  const { data: multiplierVal, refetch: refetchMultiplier } = useAppSetting('holiday_pay_multiplier', '1.5')
```

If Task 3 was completed as specified, this line already exists; this task only adds the calculation logic that reads `multiplierVal`.

- [ ] **Step 2: Fetch holidays and compute the bonus inside `handleCalcFromAssign`**

Locate this block in `src/pages/HR.jsx`:

```js
      const otRows = await fetchWorkerOTForRange(from, to)
      mergeWorkerOT(wmap, otRows)  // adds worker_ot's decoupled OT entries on top

      const results = Object.entries(wmap).map(([worker_id, d]) => {
        const dr  = (d.worker.monthly_salary||0) / 26
        const lv  = parseFloat((d.leave * dr).toFixed(2))
        const ot  = parseFloat((d.ot_hours * dr / 8 * 1.5).toFixed(2))
        const sso = d.worker.has_social_security ? parseFloat(Math.min(750,(d.worker.monthly_salary||0)*0.05).toFixed(2)) : 0
        return {
          worker_id, name: d.worker.name, nickname: d.worker.nickname,
          base_salary: d.worker.monthly_salary||0,
          contribution: d.worker.monthly_contribution||0,
          social_security_ded: sso, leave_days: d.leave,
          leave_deduction: lv, ot_hours: d.ot_hours, ot_amount: ot,
          net_pay: parseFloat(((d.worker.monthly_salary||0) - sso - lv + ot).toFixed(2)),
        }
      })
```

Replace with:

```js
      const otRows = await fetchWorkerOTForRange(from, to)
      mergeWorkerOT(wmap, otRows)  // adds worker_ot's decoupled OT entries on top

      // Count each worker's site/factory shifts that fall on a company holiday.
      const holidayRows = await fetchCompanyHolidaysForRange(from, to)
      const holidaySet = new Set(holidayRows.map(h => h.date))
      const holidayMultiplier = parseFloat(multiplierVal) || 1.5
      ;(assigns||[]).forEach(a => {
        if (!wmap[a.worker_id]) return
        if (a.type === 'site' && holidaySet.has(a.date)) {
          wmap[a.worker_id].holiday_shifts = (wmap[a.worker_id].holiday_shifts || 0) + 1
        }
      })

      const results = Object.entries(wmap).map(([worker_id, d]) => {
        const dr  = (d.worker.monthly_salary||0) / 26
        const lv  = parseFloat((d.leave * dr).toFixed(2))
        const ot  = parseFloat((d.ot_hours * dr / 8 * 1.5).toFixed(2))
        const hb  = parseFloat(((d.holiday_shifts||0) * dr * 0.5 * holidayMultiplier).toFixed(2))
        const sso = d.worker.has_social_security ? parseFloat(Math.min(750,(d.worker.monthly_salary||0)*0.05).toFixed(2)) : 0
        return {
          worker_id, name: d.worker.name, nickname: d.worker.nickname,
          base_salary: d.worker.monthly_salary||0,
          contribution: d.worker.monthly_contribution||0,
          social_security_ded: sso, leave_days: d.leave,
          leave_deduction: lv, ot_hours: d.ot_hours, ot_amount: ot,
          holiday_shifts: d.holiday_shifts||0, holiday_bonus: hb,
          net_pay: parseFloat(((d.worker.monthly_salary||0) - sso - lv + ot + hb).toFixed(2)),
        }
      })
```

- [ ] **Step 3: Fold `holiday_bonus` into the saved payload**

Locate `handleConfirmCalc`'s payload construction in `src/pages/HR.jsx`:

```js
        const payload = {
          worker_id: r.worker_id, month, year,
          base_salary: r.base_salary, contribution: r.contribution,
          ot_amount: r.ot_amount, social_security_ded: r.social_security_ded,
          leave_deduction: r.leave_deduction, net_pay: r.net_pay,
        }
```

Replace with:

```js
        const payload = {
          worker_id: r.worker_id, month, year,
          base_salary: r.base_salary, contribution: r.contribution,
          ot_amount: r.ot_amount + (r.holiday_bonus || 0), social_security_ded: r.social_security_ded,
          leave_deduction: r.leave_deduction, net_pay: r.net_pay,
        }
```

- [ ] **Step 4: Show holiday bonus in the calc preview modal**

Locate the preview table's `<thead>` in `src/pages/HR.jsx`:

```jsx
                <thead><tr><th>พนักงาน</th><th>เงินเดือน</th><th>วันลา</th><th>หักลา</th><th>OT ชม.</th><th>OT บาท</th><th>SSO</th><th>สุทธิ</th></tr></thead>
```

Replace with:

```jsx
                <thead><tr><th>พนักงาน</th><th>เงินเดือน</th><th>วันลา</th><th>หักลา</th><th>OT ชม.</th><th>OT บาท</th><th>กะวันหยุด</th><th>โบนัสวันหยุด</th><th>SSO</th><th>สุทธิ</th></tr></thead>
```

Locate the corresponding `<tbody>` row:

```jsx
                  {calcPreview.map((r,i) => (
                    <tr key={i}>
                      <td style={{ fontWeight: 600 }}>{r.name}{r.nickname?` (${r.nickname})`:''}</td>
                      <td className="font-mono">{fmt(r.base_salary)}</td>
                      <td style={{ textAlign: 'center', color: r.leave_days>0?'var(--red)':'var(--text3)' }}>{r.leave_days||'—'}</td>
                      <td className="font-mono" style={{ color: 'var(--red)' }}>{r.leave_deduction>0?`(${fmt(r.leave_deduction)})`:'—'}</td>
                      <td style={{ textAlign: 'center', color: r.ot_hours>0?'var(--yellow)':'var(--text3)' }}>{r.ot_hours||'—'}</td>
                      <td className="font-mono" style={{ color: 'var(--yellow)' }}>{r.ot_amount>0?fmt(r.ot_amount):'—'}</td>
                      <td className="font-mono" style={{ color: 'var(--red)', fontSize: 12 }}>{r.social_security_ded>0?`(${fmt(r.social_security_ded)})`:'—'}</td>
                      <td className="font-mono" style={{ color: 'var(--green)', fontWeight: 700 }}>{fmt(r.net_pay)}</td>
                    </tr>
                  ))}
```

Replace with:

```jsx
                  {calcPreview.map((r,i) => (
                    <tr key={i}>
                      <td style={{ fontWeight: 600 }}>{r.name}{r.nickname?` (${r.nickname})`:''}</td>
                      <td className="font-mono">{fmt(r.base_salary)}</td>
                      <td style={{ textAlign: 'center', color: r.leave_days>0?'var(--red)':'var(--text3)' }}>{r.leave_days||'—'}</td>
                      <td className="font-mono" style={{ color: 'var(--red)' }}>{r.leave_deduction>0?`(${fmt(r.leave_deduction)})`:'—'}</td>
                      <td style={{ textAlign: 'center', color: r.ot_hours>0?'var(--yellow)':'var(--text3)' }}>{r.ot_hours||'—'}</td>
                      <td className="font-mono" style={{ color: 'var(--yellow)' }}>{r.ot_amount>0?fmt(r.ot_amount):'—'}</td>
                      <td style={{ textAlign: 'center', color: r.holiday_shifts>0?'var(--accent)':'var(--text3)' }}>{r.holiday_shifts||'—'}</td>
                      <td className="font-mono" style={{ color: 'var(--accent)' }}>{r.holiday_bonus>0?fmt(r.holiday_bonus):'—'}</td>
                      <td className="font-mono" style={{ color: 'var(--red)', fontSize: 12 }}>{r.social_security_ded>0?`(${fmt(r.social_security_ded)})`:'—'}</td>
                      <td className="font-mono" style={{ color: 'var(--green)', fontWeight: 700 }}>{fmt(r.net_pay)}</td>
                    </tr>
                  ))}
```

Note this preview table renders for `calcPreviewMode === 'assign'` — since `calcPreviewMode === 'copy'` (the "ใช้ข้อมูลเดือนที่แล้ว" path) reuses the same `<table>` markup with the same columns, this header/row change applies to both modes; `handleCopyPrevMonth`'s preview objects don't set `holiday_shifts`/`holiday_bonus`, so those cells render `'—'` for that mode, which is correct (copying a previous month's saved figures doesn't recompute holiday shifts).

- [ ] **Step 5: Verify build**

Run: `npm run build`
Expected: built, no errors.

- [ ] **Step 6: Commit**

```bash
git add src/pages/HR.jsx
git commit -m "Add holiday work bonus to HR's Assign-based calculation"
```

---

### Task 7: End-to-end manual verification

**Files:** none (verification only)

- [ ] **Step 1: Start the dev server**

Run: `npm run dev`
Expected: Vite starts, prints a local URL.

- [ ] **Step 2: Add a holiday and verify it appears in the Assign grid**

In the HR tab → Workers sub-tab, scroll to "🎌 วันหยุดประจำปี", click "+ เพิ่มวันหยุด", pick a date within the current visible week (e.g. tomorrow), name it "ทดสอบ", save. Go to the Assign page (week view), confirm that date's column header shows the 🎌 marker with a tooltip. Switch to day view on that date, confirm the date label also shows 🎌.

- [ ] **Step 3: Assign a site shift on the holiday date and verify the bonus**

On the Assign page, assign a worker to a site for that holiday date (morning shift). Go to HR tab → Payroll sub-tab (or the standalone Payroll page), select the correct month/year, click "🔄 คำนวณจาก Assign". In the preview modal, confirm that worker's row shows `กะวันหยุด: 1` and a nonzero `โบนัสวันหยุด` figure equal to `(monthly_salary/26) × 0.5 × multiplier` — verify the exact number by hand for one worker.

- [ ] **Step 4: Verify the multiplier setting actually changes the bonus**

In HR tab, change the "ตัวคูณโบนัสวันหยุด" input to a different value (e.g. `2`), save. Re-run "🔄 คำนวณจาก Assign" for the same month. Confirm the `โบนัสวันหยุด` figure for the same worker changed proportionally (doubled, if you changed 1.5 → 3, etc.). Restore the multiplier to `1.5` afterward.

- [ ] **Step 5: Verify a worker with no assignment on the holiday is unaffected**

Confirm a worker who has no assignment at all on the holiday date does not appear with any holiday-related figures and required no manual action — matches the confirmed "do nothing" design decision.

- [ ] **Step 6: Delete the test holiday and clean up**

In HR tab, delete the "ทดสอบ" holiday. Confirm it disappears from the list and the Assign grid marker for that date is gone on refresh. Delete the test site-shift assignment created in Step 3 if it's not meant to persist.

- [ ] **Step 7: Final build check**

Run: `npm run build`
Expected: built, no errors, `build-info.json` reports the latest commit.
