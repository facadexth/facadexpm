# Leave Type Split (Sick / Personal) + Quota Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the single "leave" assignment type into sick leave (ลาป่วย, fully paid, no quota) and personal leave (ลากิจ, deducts pay, deducts from `workers.annual_leave_days` quota), and show quota usage in the HR tab.

**Architecture:** Extend `worker_assignments.type`'s CHECK constraint with two new values (`leave_sick`, `leave_personal`), keeping the old `'leave'` value for historical rows. The UI only offers the two new types going forward. Quota usage is computed on demand — a query counting `leave_personal` assignment-days in the current calendar year per worker — never a stored running counter.

**Tech Stack:** React + Vite, Supabase (Postgres + supabase-js). No automated test suite in this project — verification is `npm run build` plus Supabase MCP `execute_sql` round-trips and manual dev-server click-throughs.

## Global Constraints

- Supabase project id: `yyzbgdmgyvvypfcjuhtr`. Apply migrations via `mcp__plugin_supabase_supabase__apply_migration`.
- **Sequencing dependency:** this plan assumes `docs/superpowers/plans/2026-08-14-company-holidays.md` has already been fully implemented and merged. Tasks 6 and 7 below edit the exact `handleCalcFromAssign` code blocks that plan's Tasks 5 and 6 produce (which include `holiday_shifts`/`holiday_bonus` logic). If Company Holidays has not been merged yet, stop and merge that plan first — the `old_string` blocks in Tasks 6-7 will not match otherwise.
- Pay deduction table (confirmed):
  | | Deducts pay? | Counts against quota? |
  |---|---|---|
  | `leave_sick` | No | No |
  | `leave_personal` | Yes (`leave_personal_days × monthly_salary/26`) | Yes (`annual_leave_days`) |
- Legacy `worker_assignments.type = 'leave'` rows (created before this feature) are never migrated and the UI never creates new ones — but when `handleCalcFromAssign` recalculates a historical month that contains old `'leave'` rows, those rows are treated as `leave_personal` (same pay-deducting behavior they always had) so that recalculating a past month doesn't silently change already-paid figures. New leave in the UI is always explicitly sick or personal.
- No RLS — every table in this schema has `rowsecurity = false`; match that.
- Thai shift label is "บ่าย" (not "เย็น") in any UI copy touched.

---

### Task 1: Extend `worker_assignments.type` CHECK constraint

**Files:**
- Create: `supabase/migrations/2026-08-14-05-leave-type-split.sql`
- Modify: `supabase/schema.sql`

**Interfaces:**
- Produces: `worker_assignments.type` now accepts `'leave_sick'` and `'leave_personal'` in addition to the existing values. Consumed by all later tasks.

- [ ] **Step 1: Write the migration**

`supabase/migrations/2026-08-14-05-leave-type-split.sql`:

```sql
-- Split 'leave' into leave_sick (paid, no quota) and leave_personal
-- (deducts pay, deducts workers.annual_leave_days quota). Old 'leave'
-- value is kept for historical rows — not migrated, not removed.
-- See docs/superpowers/specs/2026-08-14-leave-type-quota-design.md
ALTER TABLE worker_assignments DROP CONSTRAINT worker_assignments_type_check;
ALTER TABLE worker_assignments ADD CONSTRAINT worker_assignments_type_check
  CHECK (type IN ('site','leave','office','holiday','subcontract','factory','leave_sick','leave_personal'));
```

- [ ] **Step 2: Apply the migration**

Use `mcp__plugin_supabase_supabase__apply_migration` with `project_id: yyzbgdmgyvvypfcjuhtr`, `name: leave_type_split`, and the full SQL from Step 1 as `query`.

- [ ] **Step 3: Verify the constraint accepts the new values and rejects invalid ones**

Run (rollback-safe — requires an existing worker row; substitute a real `id` from `SELECT id FROM workers LIMIT 1` if this fails):

```sql
BEGIN;
INSERT INTO worker_assignments (worker_id, date, shift, type)
  SELECT id, CURRENT_DATE + 950, 'morning', 'leave_sick' FROM workers LIMIT 1;
INSERT INTO worker_assignments (worker_id, date, shift, type)
  SELECT id, CURRENT_DATE + 951, 'morning', 'leave_personal' FROM workers LIMIT 1;
SELECT type FROM worker_assignments WHERE date IN (CURRENT_DATE + 950, CURRENT_DATE + 951) ORDER BY date;
ROLLBACK;
```
Expected: both inserts succeed, the SELECT returns `leave_sick` then `leave_personal`.

Then run separately (confirms invalid values are still rejected):
```sql
BEGIN;
INSERT INTO worker_assignments (worker_id, date, shift, type)
  SELECT id, CURRENT_DATE + 952, 'morning', 'not_a_real_type' FROM workers LIMIT 1;
ROLLBACK;
```
Expected: fails with `violates check constraint "worker_assignments_type_check"`.

- [ ] **Step 4: Add the same constraint change to `supabase/schema.sql`**

Find the `worker_assignments` table definition in `supabase/schema.sql` (search for `CREATE TABLE worker_assignments`) and locate its `type` column's inline `CHECK` clause or a separate `ADD CONSTRAINT worker_assignments_type_check` statement. Update whichever form is present so the allowed list reads exactly:

```sql
CHECK (type IN ('site','leave','office','holiday','subcontract','factory','leave_sick','leave_personal'))
```

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/2026-08-14-05-leave-type-split.sql supabase/schema.sql
git commit -m "Extend worker_assignments.type to support leave_sick/leave_personal"
```

---

### Task 2: `constants.js` and `lineExport.js` — new type metadata

**Files:**
- Modify: `src/pages/assign/constants.js`
- Modify: `src/pages/assign/lineExport.js`

**Interfaces:**
- Produces: `TYPE_COLOR.leave_sick`, `TYPE_COLOR.leave_personal`, `TYPE_LABEL.leave_sick`, `TYPE_LABEL.leave_personal` — consumed by `AssignCell.jsx`/`DayView.jsx`/`Assign.jsx` (already generic over these maps, no changes needed there). `OTHER_TYPE_LABEL.leave_sick`, `OTHER_TYPE_LABEL.leave_personal` — consumed by `lineExport.js`'s own `formatDayBlock`.

- [ ] **Step 1: Update `TYPE_COLOR` in `constants.js`**

Replace:

```js
export const TYPE_COLOR = {
  site:        { bg: 'rgba(108,99,255,0.25)', color: 'var(--accent)' },
  factory:     { bg: 'rgba(0,212,170,0.25)',  color: 'var(--green)' },
  office:      { bg: 'rgba(78,205,196,0.25)',  color: 'var(--blue)' },
  leave:       { bg: 'rgba(255,107,107,0.25)', color: 'var(--red)' },
  holiday:     { bg: 'rgba(94,97,128,0.25)',   color: 'var(--text3)' },
  subcontract: { bg: 'rgba(255,209,102,0.25)', color: 'var(--yellow)' },
}
```

with:

```js
export const TYPE_COLOR = {
  site:            { bg: 'rgba(108,99,255,0.25)', color: 'var(--accent)' },
  factory:         { bg: 'rgba(0,212,170,0.25)',  color: 'var(--green)' },
  office:          { bg: 'rgba(78,205,196,0.25)',  color: 'var(--blue)' },
  leave:           { bg: 'rgba(255,107,107,0.25)', color: 'var(--red)' },
  leave_sick:      { bg: 'rgba(255,159,67,0.25)',  color: '#ff9f43' },
  leave_personal:  { bg: 'rgba(255,71,87,0.25)',   color: '#ff4757' },
  holiday:         { bg: 'rgba(94,97,128,0.25)',   color: 'var(--text3)' },
  subcontract:     { bg: 'rgba(255,209,102,0.25)', color: 'var(--yellow)' },
}
```

- [ ] **Step 2: Update `TYPE_LABEL` in `constants.js`**

Replace:

```js
export const TYPE_LABEL = { site: '', factory: 'รง', office: 'OF', leave: 'LA', holiday: 'HO', subcontract: 'SC' }
```

with:

```js
export const TYPE_LABEL = { site: '', factory: 'รง', office: 'OF', leave: 'LA', leave_sick: 'LS', leave_personal: 'LP', holiday: 'HO', subcontract: 'SC' }
```

- [ ] **Step 3: Update `TYPE_LEGEND` in `constants.js`**

Replace:

```js
export const TYPE_LEGEND = [
  { type: 'site',        label: '🏗️ ไซท์' },
  { type: 'factory',     label: '🏭 โรงงาน' },
  { type: 'subcontract', label: '🔧 Sub' },
  { type: 'office',      label: '🏢 ออฟฟิศ' },
  { type: 'leave',       label: '🏖️ ลา' },
  { type: 'holiday',     label: '🎌 หยุด' },
]
```

with:

```js
export const TYPE_LEGEND = [
  { type: 'site',            label: '🏗️ ไซท์' },
  { type: 'factory',         label: '🏭 โรงงาน' },
  { type: 'subcontract',     label: '🔧 Sub' },
  { type: 'office',          label: '🏢 ออฟฟิศ' },
  { type: 'leave_sick',      label: '🤒 ลาป่วย' },
  { type: 'leave_personal',  label: '🏖️ ลากิจ' },
  { type: 'holiday',         label: '🎌 หยุด' },
]
```

Note: `'leave'` is intentionally dropped from `TYPE_LEGEND` (no new rows use it going forward) but kept in `TYPE_COLOR`/`TYPE_LABEL` so historical rows still render with a color and badge instead of falling back to undefined styling.

- [ ] **Step 4: Update `OTHER_TYPE_LABEL` in `lineExport.js`**

Replace:

```js
const OTHER_TYPE_LABEL = { office: 'ออฟฟิศ', leave: 'ลา', holiday: 'หยุด' }
```

with:

```js
const OTHER_TYPE_LABEL = { office: 'ออฟฟิศ', leave: 'ลา', leave_sick: 'ลาป่วย', leave_personal: 'ลากิจ', holiday: 'หยุด' }
```

- [ ] **Step 5: Verify build**

Run: `npm run build`
Expected: built, no errors.

- [ ] **Step 6: Commit**

```bash
git add src/pages/assign/constants.js src/pages/assign/lineExport.js
git commit -m "Add leave_sick/leave_personal color, label, and legend entries"
```

---

### Task 3: `CellEditPopup.jsx` — split the leave type picker

**Files:**
- Modify: `src/pages/assign/CellEditPopup.jsx`

**Interfaces:**
- Consumes: nothing new (pure UI change to the existing `TYPE_OPTS` array).

- [ ] **Step 1: Replace the single "ลา" option with two options**

Replace:

```js
const TYPE_OPTS = [
  { k: 'site',    l: '🏗️ งานไซท์' },
  { k: 'factory', l: '🏭 โรงงาน' },
  { k: 'office',  l: '🏢 ออฟฟิศ' },
  { k: 'leave',   l: '🏖️ ลา' },
  { k: 'holiday', l: '🎌 หยุด' },
]
```

with:

```js
const TYPE_OPTS = [
  { k: 'site',            l: '🏗️ งานไซท์' },
  { k: 'factory',         l: '🏭 โรงงาน' },
  { k: 'office',          l: '🏢 ออฟฟิศ' },
  { k: 'leave_sick',      l: '🤒 ลาป่วย' },
  { k: 'leave_personal',  l: '🏖️ ลากิจ' },
  { k: 'holiday',         l: '🎌 หยุด' },
]
```

Nothing else in this file changes: `needsSite = SITE_TYPES.includes(type)` already correctly evaluates to `false` for both new type keys (`SITE_TYPES` is `['site', 'factory']`, untouched), and `wantsShiftSave` already treats `type !== 'site'` as shift-save-worthy regardless of which non-site type is selected. A cell that already has `existing.type === 'leave'` (a historical row) still opens with that value pre-selected via `useState(existing?.type || 'site')` — the type buttons row simply won't have a highlighted button for it since `'leave'` is no longer in `TYPE_OPTS`, which is acceptable: editing a historical `'leave'` row and clicking "บันทึก" without touching the type buttons would incorrectly save it as `'site'` (the `useState` initializer's fallback), so this must be corrected in Step 2.

- [ ] **Step 2: Ensure historical `'leave'` rows don't silently change type on save**

Replace:

```js
  const { worker, date, shift, existing, existingOT } = target
  const [type, setType]     = useState(existing?.type || 'site')
```

with:

```js
  const { worker, date, shift, existing, existingOT } = target
  // Historical rows may still carry the old undifferentiated 'leave' type
  // (no longer offered in TYPE_OPTS going forward). Falling back to 'site'
  // for it here would silently reclassify the row as a work day the
  // instant someone reopens and saves it without touching the type
  // buttons — treat it as leave_personal instead, matching how
  // handleCalcFromAssign already treats legacy 'leave' rows for payroll.
  const [type, setType]     = useState(existing?.type === 'leave' ? 'leave_personal' : (existing?.type || 'site'))
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: built, no errors.

- [ ] **Step 4: Commit**

```bash
git add src/pages/assign/CellEditPopup.jsx
git commit -m "Split leave type picker into sick/personal, migrate legacy rows on edit"
```

---

### Task 4: `useSupabase.js` — leave quota usage hook

**Files:**
- Modify: `src/hooks/useSupabase.js`

**Interfaces:**
- Produces: `useLeaveQuotaUsage(year) -> { data, loading, error, refetch }` where `data` is `{ [worker_id]: usedDays }` for `type = 'leave_personal'` assignment-days in that calendar year. Consumed by Task 5.

- [ ] **Step 1: Add the hook**

In `src/hooks/useSupabase.js`, immediately after the `deleteCompanyHoliday` function (added in the Company Holidays plan — search for `export async function deleteCompanyHoliday`, insert after its closing `}`), add:

```js

// ── Leave Quota ────────────────────────────────────────────────

/** วันลากิจที่ใช้ไปแล้วในปีนั้นๆ ต่อคน (ลาป่วยไม่หักโควต้าจึงไม่นับ) */
export function useLeaveQuotaUsage(year) {
  return useQuery(async () => {
    const from = `${year}-01-01`
    const to   = `${year}-12-31`
    const { data, error } = await supabase
      .from('worker_assignments')
      .select('worker_id')
      .eq('type', 'leave_personal')
      .gte('date', from).lte('date', to)
    if (error) throw error
    const used = {}
    ;(data || []).forEach(r => { used[r.worker_id] = (used[r.worker_id] || 0) + 0.5 })
    return used
  }, [year])
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: built, no errors.

- [ ] **Step 3: Verify the aggregation via SQL**

Run (rollback-safe — substitute a real worker id if the `LIMIT 1` subselect pattern fails in your environment):
```sql
BEGIN;
INSERT INTO worker_assignments (worker_id, date, shift, type)
  SELECT id, '2026-03-01', 'morning', 'leave_personal' FROM workers LIMIT 1;
INSERT INTO worker_assignments (worker_id, date, shift, type)
  SELECT id, '2026-03-01', 'evening', 'leave_personal' FROM workers LIMIT 1;
SELECT worker_id, count(*) FROM worker_assignments
  WHERE type = 'leave_personal' AND date BETWEEN '2026-01-01' AND '2026-12-31'
  GROUP BY worker_id;
ROLLBACK;
```
Expected: one row with `count = 2` — confirms two shift-rows on the same date (0.5 + 0.5 = 1.0 day) aggregate correctly, matching what `useLeaveQuotaUsage`'s reduce does client-side.

- [ ] **Step 4: Commit**

```bash
git add src/hooks/useSupabase.js
git commit -m "Add useLeaveQuotaUsage hook for personal-leave quota tracking"
```

---

### Task 5: HR tab — show quota usage in the worker list

**Files:**
- Modify: `src/pages/HR.jsx`

**Interfaces:**
- Consumes: `useLeaveQuotaUsage` (Task 4).

- [ ] **Step 1: Add the import**

Update the existing import line in `src/pages/HR.jsx` (which, after the Company Holidays plan, reads `import { useWorkers, useSalary, usePreviousMonthSalaries, useAuditLogs, fetchWorkerOTForRange, useCompanyHolidays, saveCompanyHoliday, deleteCompanyHoliday, useAppSetting, saveAppSetting, fetchCompanyHolidaysForRange } from '../hooks/useSupabase.js'`) to also include `useLeaveQuotaUsage`:

```js
import { useWorkers, useSalary, usePreviousMonthSalaries, useAuditLogs, fetchWorkerOTForRange, useCompanyHolidays, saveCompanyHoliday, deleteCompanyHoliday, useAppSetting, saveAppSetting, fetchCompanyHolidaysForRange, useLeaveQuotaUsage } from '../hooks/useSupabase.js'
```

If the Company Holidays plan has not added those other names yet, add `useLeaveQuotaUsage` to whatever the current import line is instead — the exact set of other names doesn't matter to this task, only that `useLeaveQuotaUsage` joins the list.

- [ ] **Step 2: Call the hook in the HR component**

Immediately after the line `const { data: workers, refetch: refetchWorkers } = useWorkers()`, add:

```js
  const { data: leaveUsed } = useLeaveQuotaUsage(now.getFullYear())
```

- [ ] **Step 3: Add the two new columns to the worker list table**

Replace the table header:

```jsx
                <thead>
                  <tr>
                    <th>ชื่อ</th><th>ชื่อเล่น</th><th>ตำแหน่ง</th>
                    <th>เงินเดือน</th><th>ค่าแรง/วัน</th>
                    <th>SSO</th><th>วันลา/ปี</th><th>สถานะ</th><th></th>
                  </tr>
                </thead>
```

with:

```jsx
                <thead>
                  <tr>
                    <th>ชื่อ</th><th>ชื่อเล่น</th><th>ตำแหน่ง</th>
                    <th>เงินเดือน</th><th>ค่าแรง/วัน</th>
                    <th>SSO</th><th>วันลา/ปี</th><th>ใช้ไปแล้ว (ปีนี้)</th><th>คงเหลือ</th><th>สถานะ</th><th></th>
                  </tr>
                </thead>
```

Replace the corresponding row (and its now-outdated `colSpan={9}` empty-state row):

```jsx
                <tbody>
                  {visibleWorkers.map(w => (
                    <tr key={w.id}>
                      <td style={{ fontWeight: 600 }}>{w.name}</td>
                      <td style={{ color: 'var(--text2)' }}>{w.nickname||'—'}</td>
                      <td style={{ fontSize: 12, color: 'var(--text3)' }}>{w.position||'—'}</td>
                      <td className="font-mono">{fmt(w.monthly_salary)}</td>
                      <td className="font-mono" style={{ color: 'var(--yellow)' }}>{fmt(w.daily_rate)}</td>
                      <td>{w.has_social_security ? <span className="badge badge-paid">✓ มี</span> : <span style={{ color: 'var(--text3)', fontSize: 11 }}>—</span>}</td>
                      <td style={{ textAlign: 'center' }}>{w.annual_leave_days}</td>
                      <td><span className={`badge ${w.status==='active'?'badge-paid':'badge-pending'}`}>{w.status}</span></td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {canEdit && (
                          <>
                            <button className="btn btn-sm btn-ghost" onClick={() => { setEditWorker(w); setShowWorkerForm(true) }}>✏️</button>
                            <button className="btn btn-sm btn-danger" onClick={() => setDeleteWorkerId(w.id)}>🗑️</button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                  {!visibleWorkers.length && (
                    <tr><td colSpan={9} style={{ textAlign: 'center', color: 'var(--text3)', padding: 24 }}>ยังไม่มีช่าง</td></tr>
                  )}
                </tbody>
```

with:

```jsx
                <tbody>
                  {visibleWorkers.map(w => {
                    const used = leaveUsed?.[w.id] || 0
                    const remaining = (w.annual_leave_days || 0) - used
                    return (
                    <tr key={w.id}>
                      <td style={{ fontWeight: 600 }}>{w.name}</td>
                      <td style={{ color: 'var(--text2)' }}>{w.nickname||'—'}</td>
                      <td style={{ fontSize: 12, color: 'var(--text3)' }}>{w.position||'—'}</td>
                      <td className="font-mono">{fmt(w.monthly_salary)}</td>
                      <td className="font-mono" style={{ color: 'var(--yellow)' }}>{fmt(w.daily_rate)}</td>
                      <td>{w.has_social_security ? <span className="badge badge-paid">✓ มี</span> : <span style={{ color: 'var(--text3)', fontSize: 11 }}>—</span>}</td>
                      <td style={{ textAlign: 'center' }}>{w.annual_leave_days}</td>
                      <td style={{ textAlign: 'center', color: used > 0 ? 'var(--red)' : 'var(--text3)' }}>{used || '—'}</td>
                      <td style={{ textAlign: 'center', fontWeight: 600, color: remaining < 0 ? 'var(--red)' : 'var(--text2)' }}>{remaining}</td>
                      <td><span className={`badge ${w.status==='active'?'badge-paid':'badge-pending'}`}>{w.status}</span></td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {canEdit && (
                          <>
                            <button className="btn btn-sm btn-ghost" onClick={() => { setEditWorker(w); setShowWorkerForm(true) }}>✏️</button>
                            <button className="btn btn-sm btn-danger" onClick={() => setDeleteWorkerId(w.id)}>🗑️</button>
                          </>
                        )}
                      </td>
                    </tr>
                    )
                  })}
                  {!visibleWorkers.length && (
                    <tr><td colSpan={11} style={{ textAlign: 'center', color: 'var(--text3)', padding: 24 }}>ยังไม่มีช่าง</td></tr>
                  )}
                </tbody>
```

- [ ] **Step 4: Verify build**

Run: `npm run build`
Expected: built, no errors.

- [ ] **Step 5: Commit**

```bash
git add src/pages/HR.jsx
git commit -m "Show personal-leave quota usage in HR worker list"
```

---

### Task 6: `Payroll.jsx` — split leave accumulators in `handleCalcFromAssign`

**Files:**
- Modify: `src/pages/Payroll.jsx`

**Interfaces:**
- Precondition: this task's `old_string` blocks match `src/pages/Payroll.jsx` **after** the Company Holidays plan's Task 5 has been applied (they include `holiday_shifts`/`holiday_bonus`/`holidayMultiplier`). If that plan hasn't been merged yet, stop — see Global Constraints.

- [ ] **Step 1: Split the wmap accumulation**

Replace:

```js
      // Group by worker
      const wmap = {}
      ;(assigns || []).forEach(a => {
        const w = a.workers
        if (!w) return
        if (!wmap[a.worker_id]) wmap[a.worker_id] = { worker: w, leave: 0, ot_hours: 0 }
        if (a.type === 'leave')  wmap[a.worker_id].leave += 0.5  // 1 กะ = 0.5 วัน (เช้า+บ่าย = 1 วัน)
        if (a.type === 'site')   wmap[a.worker_id].ot_hours += (a.ot_hours || 0)  // legacy OT stored on the shift row
      })
```

with:

```js
      // Group by worker. Legacy 'leave' rows (created before the sick/
      // personal split) are treated as leave_personal so recalculating a
      // historical month doesn't silently change an already-paid deduction.
      const wmap = {}
      ;(assigns || []).forEach(a => {
        const w = a.workers
        if (!w) return
        if (!wmap[a.worker_id]) wmap[a.worker_id] = { worker: w, leave_sick: 0, leave_personal: 0, ot_hours: 0 }
        if (a.type === 'leave_sick')                          wmap[a.worker_id].leave_sick += 0.5
        if (a.type === 'leave_personal' || a.type === 'leave') wmap[a.worker_id].leave_personal += 0.5  // 1 กะ = 0.5 วัน (เช้า+บ่าย = 1 วัน)
        if (a.type === 'site')                                 wmap[a.worker_id].ot_hours += (a.ot_hours || 0)  // legacy OT stored on the shift row
      })
```

- [ ] **Step 2: Update the results map to use `leave_personal` for the deduction and expose both counts**

Replace:

```js
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

with:

```js
      const results = Object.entries(wmap).map(([worker_id, d]) => {
        const daily_rate     = (d.worker.monthly_salary || 0) / 26
        const leave_ded      = parseFloat((d.leave_personal * daily_rate).toFixed(2))
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
          leave_sick_days:     d.leave_sick,
          leave_personal_days: d.leave_personal,
          leave_deduction: leave_ded,
          ot_hours:        d.ot_hours,
          ot_amount:       ot_amt,
          holiday_shifts:  d.holiday_shifts || 0,
          holiday_bonus,
          net_pay:         net,
        }
      })
```

- [ ] **Step 3: Update the preview table header**

Replace:

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

with:

```jsx
                <thead>
                  <tr>
                    <th>พนักงาน</th><th>เงินเดือน</th>
                    <th>ลาป่วย</th><th>ลากิจ</th><th>หักลา</th>
                    <th>OT (ชม.)</th><th>OT (บาท)</th>
                    <th>กะวันหยุด</th><th>โบนัสวันหยุด</th>
                    <th>ประกันสังคม</th><th>รับสุทธิ</th>
                  </tr>
                </thead>
```

- [ ] **Step 4: Update the preview table row**

Replace:

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

with:

```jsx
                  {calcPreview.map((r, i) => (
                    <tr key={i}>
                      <td style={{ fontWeight: 600 }}>{r.name}{r.nickname ? ` (${r.nickname})` : ''}</td>
                      <td className="font-mono">{fmt(r.base_salary)}</td>
                      <td style={{ textAlign: 'center', color: r.leave_sick_days > 0 ? 'var(--yellow)' : 'var(--text3)' }}>{r.leave_sick_days || '—'}</td>
                      <td style={{ textAlign: 'center', color: r.leave_personal_days > 0 ? 'var(--red)' : 'var(--text3)' }}>{r.leave_personal_days || '—'}</td>
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

- [ ] **Step 5: Verify build**

Run: `npm run build`
Expected: built, no errors.

- [ ] **Step 6: Commit**

```bash
git add src/pages/Payroll.jsx
git commit -m "Split Payroll leave calculation into sick (unpaid deduction) and personal"
```

---

### Task 7: `HR.jsx` — split leave accumulators in `handleCalcFromAssign`

**Files:**
- Modify: `src/pages/HR.jsx`

**Interfaces:**
- Precondition: same as Task 6 — assumes the Company Holidays plan's Task 6 has already been applied to this file.

- [ ] **Step 1: Split the wmap accumulation**

Replace:

```js
      const wmap = {}
      ;(assigns||[]).forEach(a => {
        const w = a.workers; if (!w) return
        if (!wmap[a.worker_id]) wmap[a.worker_id] = { worker: w, leave: 0, ot_hours: 0 }
        if (a.type === 'leave') wmap[a.worker_id].leave += 0.5  // 1 กะ = 0.5 วัน (เช้า+บ่าย = 1 วัน)
        if (a.type === 'site')  wmap[a.worker_id].ot_hours += (a.ot_hours||0)  // legacy OT stored on the shift row
      })
```

with:

```js
      // Legacy 'leave' rows (created before the sick/personal split) are
      // treated as leave_personal so recalculating a historical month
      // doesn't silently change an already-paid deduction.
      const wmap = {}
      ;(assigns||[]).forEach(a => {
        const w = a.workers; if (!w) return
        if (!wmap[a.worker_id]) wmap[a.worker_id] = { worker: w, leave_sick: 0, leave_personal: 0, ot_hours: 0 }
        if (a.type === 'leave_sick')                          wmap[a.worker_id].leave_sick += 0.5
        if (a.type === 'leave_personal' || a.type === 'leave') wmap[a.worker_id].leave_personal += 0.5  // 1 กะ = 0.5 วัน (เช้า+บ่าย = 1 วัน)
        if (a.type === 'site')                                 wmap[a.worker_id].ot_hours += (a.ot_hours||0)  // legacy OT stored on the shift row
      })
```

- [ ] **Step 2: Update the results map**

Replace:

```js
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

with:

```js
      const results = Object.entries(wmap).map(([worker_id, d]) => {
        const dr  = (d.worker.monthly_salary||0) / 26
        const lv  = parseFloat((d.leave_personal * dr).toFixed(2))
        const ot  = parseFloat((d.ot_hours * dr / 8 * 1.5).toFixed(2))
        const hb  = parseFloat(((d.holiday_shifts||0) * dr * 0.5 * holidayMultiplier).toFixed(2))
        const sso = d.worker.has_social_security ? parseFloat(Math.min(750,(d.worker.monthly_salary||0)*0.05).toFixed(2)) : 0
        return {
          worker_id, name: d.worker.name, nickname: d.worker.nickname,
          base_salary: d.worker.monthly_salary||0,
          contribution: d.worker.monthly_contribution||0,
          social_security_ded: sso,
          leave_sick_days: d.leave_sick, leave_personal_days: d.leave_personal,
          leave_deduction: lv, ot_hours: d.ot_hours, ot_amount: ot,
          holiday_shifts: d.holiday_shifts||0, holiday_bonus: hb,
          net_pay: parseFloat(((d.worker.monthly_salary||0) - sso - lv + ot + hb).toFixed(2)),
        }
      })
```

- [ ] **Step 3: Update `handleCopyPrevMonth`'s reset fields to match the renamed fields**

Replace:

```js
      // reset variable fields
      ot_amount: 0,
      advance_deduction: 0,
      loan_deduction: 0,
      leave_deduction: 0,
      leave_days: 0,
      ot_hours: 0,
```

with:

```js
      // reset variable fields
      ot_amount: 0,
      advance_deduction: 0,
      loan_deduction: 0,
      leave_deduction: 0,
      leave_sick_days: 0,
      leave_personal_days: 0,
      ot_hours: 0,
```

- [ ] **Step 4: Update the calc preview table header**

Replace:

```jsx
                <thead><tr><th>พนักงาน</th><th>เงินเดือน</th><th>วันลา</th><th>หักลา</th><th>OT ชม.</th><th>OT บาท</th><th>กะวันหยุด</th><th>โบนัสวันหยุด</th><th>SSO</th><th>สุทธิ</th></tr></thead>
```

with:

```jsx
                <thead><tr><th>พนักงาน</th><th>เงินเดือน</th><th>ลาป่วย</th><th>ลากิจ</th><th>หักลา</th><th>OT ชม.</th><th>OT บาท</th><th>กะวันหยุด</th><th>โบนัสวันหยุด</th><th>SSO</th><th>สุทธิ</th></tr></thead>
```

- [ ] **Step 5: Update the calc preview table row**

Replace:

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

with:

```jsx
                  {calcPreview.map((r,i) => (
                    <tr key={i}>
                      <td style={{ fontWeight: 600 }}>{r.name}{r.nickname?` (${r.nickname})`:''}</td>
                      <td className="font-mono">{fmt(r.base_salary)}</td>
                      <td style={{ textAlign: 'center', color: r.leave_sick_days>0?'var(--yellow)':'var(--text3)' }}>{r.leave_sick_days||'—'}</td>
                      <td style={{ textAlign: 'center', color: r.leave_personal_days>0?'var(--red)':'var(--text3)' }}>{r.leave_personal_days||'—'}</td>
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

- [ ] **Step 6: Verify build**

Run: `npm run build`
Expected: built, no errors.

- [ ] **Step 7: Commit**

```bash
git add src/pages/HR.jsx
git commit -m "Split HR leave calculation into sick (unpaid deduction) and personal"
```

---

### Task 8: End-to-end manual verification

**Files:** none (verification only)

- [ ] **Step 1: Start the dev server**

Run: `npm run dev`
Expected: Vite starts, prints a local URL.

- [ ] **Step 2: Assign sick leave and confirm no pay deduction**

On the Assign page, open a cell for a worker on an empty date, select type "🤒 ลาป่วย", save. Go to HR tab → Payroll, select that month, click "🔄 คำนวณจาก Assign". Confirm the worker's row shows `ลาป่วย: 1` (or `0.5` if only one shift), `ลากิจ: —`, and `หักลา: —` (no deduction) — sick leave must not reduce `net_pay`.

- [ ] **Step 3: Assign personal leave and confirm pay deduction + quota usage**

Assign the same or another worker to "🏖️ ลากิจ" on a different date. Re-run "🔄 คำนวณจาก Assign". Confirm that row shows `ลากิจ: 1`, and `หักลา` shows a nonzero figure equal to `leave_personal_days × monthly_salary/26` — verify by hand for one worker. Then go to HR tab → Workers, find that worker's row, confirm "ใช้ไปแล้ว (ปีนี้)" increased and "คงเหลือ" decreased by the same amount, and that it matches `annual_leave_days − used`.

- [ ] **Step 4: Confirm a historical `'leave'` row still deducts pay when recalculated**

Run via `execute_sql` (rollback-unsafe intentionally — this is a real historical-compatibility check, not a throwaway test; use a real worker id and a date in the currently-selected payroll month so it survives to the next step, then clean it up manually afterward):
```sql
INSERT INTO worker_assignments (worker_id, date, shift, type)
  SELECT id, date_trunc('month', CURRENT_DATE)::date + 3, 'morning', 'leave' FROM workers LIMIT 1
  RETURNING id, worker_id, date, type;
```
Note the returned `id`. In the HR or Payroll UI, re-run "🔄 คำนวณจาก Assign" for the current month. Confirm that worker's row now also reflects this legacy row as personal leave (added to `ลากิจ`/`หักลา`, not `ลาป่วย`). Then delete the test row:
```sql
DELETE FROM worker_assignments WHERE id = '<the returned id>';
```

- [ ] **Step 5: Confirm the CellEditPopup type picker only offers the two new options**

Open any empty Assign cell. Confirm the type button row shows "🤒 ลาป่วย" and "🏖️ ลากิจ" — no plain "🏖️ ลา" button.

- [ ] **Step 6: Verify the LINE-copy export uses the new labels**

Assign a worker to "🤒 ลาป่วย" or "🏖️ ลากิจ" on a date within the current week view. Click "copy for LINE" on that view. Confirm the generated text shows "ลาป่วย" or "ลากิจ" (not a raw type key like `leave_sick`) next to that worker's name.

- [ ] **Step 7: Clean up test assignments**

Delete any test assignments created in Steps 2-3 via the Assign page UI (not SQL) to also exercise the delete path once more, unless you intend to keep them as real data.

- [ ] **Step 8: Final build check**

Run: `npm run build`
Expected: built, no errors, `build-info.json` reports the latest commit.
