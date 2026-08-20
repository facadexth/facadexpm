# Assign Roster Visibility + Leave in the Assign Wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let ADMIN+ hide a worker from the Assign scheduling roster (settable from HR, without deleting any data or affecting that worker's own self-service schedule view), and let the main "+ Assign งาน" wizard assign ลาป่วย/ลากิจ directly instead of only through the single-cell edit popup.

**Architecture:** Part A adds one boolean column to `workers` (+ the `workers_with_rate` view that fronts it), a query-level filter in `useWorkers()`, a new `useAllActiveWorkers()` hook carve-out for `MySchedule.jsx` (which must stay unfiltered by this flag), and a checkbox in HR's existing worker form. Part B extends `AssignWizard.jsx`'s type picker and conditionally hides its site-selection step, mirroring logic `CellEditPopup.jsx` already has for the same two leave types. The two parts touch different files end-to-end (Part A: `useSupabase.js` + `HR.jsx` + `MySchedule.jsx`; Part B: `AssignWizard.jsx` only) and can be built/reviewed independently.

**Tech Stack:** Supabase (Postgres), React 18.

## Global Constraints

- Every new/modified Postgres view must carry `WITH (security_invoker = true)` — this codebase had a real cross-tenant RLS leak from a view that omitted it (`sites_progress`); non-negotiable project-wide rule.
- The new `show_in_assign` flag must default `true` so every existing worker keeps appearing in Assign exactly as today when this ships — never introduce it as an opt-in default.
- Un-ticking `show_in_assign` must never delete, archive, or otherwise touch a worker's existing `worker_assignments`/OT rows — it is a read-side filter only, applied nowhere near any write/delete path.
- `MySchedule.jsx` must remain completely unaffected by `show_in_assign` — a worker hidden from the admin roster still finds and manages their own schedule normally.
- `AssignWizard.jsx`'s leave-type handling (no site required, `site_id: null` in the submitted row) must match `CellEditPopup.jsx`'s existing behavior for the same two type keys (`leave_sick`, `leave_personal`) exactly — same `SITE_TYPES` constant, same semantics.
- Never write to the live Supabase database as a side effect of "manual verification" — this codebase has a hard rule against this after a past incident. Read-only `SELECT`/`information_schema` checks are fine; `INSERT`/`UPDATE`/`DELETE` against the live project are not part of any step in this plan.

---

### Task 1: Schema — `show_in_assign` column + view + hooks

**Files:**
- Create: `supabase/migrations/2026-08-20-01-assign-roster-visibility.sql`
- Modify: `supabase/schema.sql`
- Modify: `src/hooks/useSupabase.js`

**Interfaces:**
- Produces (used by Tasks 2 and 3):
  - `workers.show_in_assign` — `BOOLEAN NOT NULL DEFAULT true`
  - `workers_with_rate` view — gains `show_in_assign` in its `SELECT` list
  - `export function useWorkers()` in `src/hooks/useSupabase.js` — unchanged signature, now additionally filters `.eq('show_in_assign', true)`
  - `export function useAllActiveWorkers()` in `src/hooks/useSupabase.js` — new, `() => { data, loading, error, refetch }`, same shape as `useWorkers()` but WITHOUT the `show_in_assign` filter (only `status='active'`)

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/2026-08-20-01-assign-roster-visibility.sql`:
```sql
-- Not every HR employee needs day-to-day site scheduling (office staff,
-- management, etc.) -- this lets ADMIN+ hide a worker from the Assign
-- roster (picker UI only) without touching their HR record or any of
-- their existing worker_assignments/OT history. Defaults true so every
-- existing worker keeps appearing exactly as before this ships.
ALTER TABLE workers ADD COLUMN show_in_assign BOOLEAN NOT NULL DEFAULT true;

-- workers_with_rate has an explicit column list (not SELECT *), so the
-- new column must be added here too or useWorkers() can never see it.
-- security_invoker = true is required on every view in this app -- a view
-- without it runs as its owner (a superuser), bypassing the querying
-- user's RLS entirely. This exact mistake caused a real cross-tenant data
-- leak in sites_progress (see 2026-08-18-01-fix-sites-progress-cross-tenant-leak.sql).
CREATE OR REPLACE VIEW workers_with_rate WITH (security_invoker = true) AS
SELECT
  id, name, nickname, position, monthly_salary, has_social_security,
  annual_leave_days, monthly_contribution, status, created_at, updated_at,
  ROUND(monthly_salary / 26, 2) AS daily_rate,
  ROUND(monthly_salary * 0.05 / 100 * 750, 0) AS social_security_amount,
  email, show_in_assign
FROM workers;
```

- [ ] **Step 2: Apply the migration to the live database**

Use `mcp__plugin_supabase_supabase__apply_migration` with:
- `project_id`: `yyzbgdmgyvvypfcjuhtr` (this project's id, used by every prior migration this session)
- `name`: `assign_roster_visibility`
- `query`: the full SQL from Step 1

- [ ] **Step 3: Verify the migration (read-only checks only)**

Run via `mcp__plugin_supabase_supabase__execute_sql` (SELECT-only — do not run any statement that writes data):
```sql
SELECT column_name, data_type, column_default FROM information_schema.columns
WHERE table_name = 'workers' AND column_name = 'show_in_assign';

SELECT column_name FROM information_schema.columns
WHERE table_name = 'workers_with_rate' AND column_name = 'show_in_assign';

SELECT show_in_assign, count(*) FROM workers_with_rate GROUP BY show_in_assign;

SELECT relname, reloptions FROM pg_class WHERE relname = 'workers_with_rate';
```

Expected: first query returns 1 row (`boolean`, default `true`); second returns 1 row; third shows every current worker with `show_in_assign = true` (confirms the default applied retroactively to existing rows, per the `ALTER TABLE ... DEFAULT true` semantics, not just to future inserts); fourth shows `reloptions` containing `security_invoker=true`.

Then run `mcp__plugin_supabase_supabase__get_advisors` (type: `security`) and confirm no new warnings versus before this migration.

- [ ] **Step 4: Mirror into `supabase/schema.sql`**

In `supabase/schema.sql`, the `workers` table definition currently reads:
```sql
CREATE TABLE workers (
  id                    UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name                  TEXT NOT NULL,
  nickname              TEXT,
  position              TEXT,
  monthly_salary        NUMERIC DEFAULT 0,
  has_social_security   BOOLEAN DEFAULT TRUE,
  annual_leave_days     INT DEFAULT 6,           -- วันลากิจที่ได้รับต่อปี (โควต้า leave_personal)
  monthly_contribution  NUMERIC DEFAULT 0,
  status                TEXT DEFAULT 'active' CHECK (status IN ('active','inactive')),
  email                 TEXT,                    -- ผูกกับ user_roles.user_email (login account)
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW(),
  tenant_id             UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id)
);
```
Add a new line immediately after the `email` line:
```sql
  email                 TEXT,                    -- ผูกกับ user_roles.user_email (login account)
  show_in_assign        BOOLEAN NOT NULL DEFAULT true, -- ซ่อนจาก roster ของ Assign โดยไม่กระทบข้อมูล assignment เดิม
  created_at            TIMESTAMPTZ DEFAULT NOW(),
```

Find `CREATE OR REPLACE VIEW workers_with_rate` (search for that exact string) and change its `SELECT` list from:
```sql
SELECT
  id, name, nickname, position, monthly_salary, has_social_security,
  annual_leave_days, monthly_contribution, status, created_at, updated_at,
  ROUND(monthly_salary / 26, 2) AS daily_rate,
  ROUND(monthly_salary * 0.05 / 100 * 750, 0) AS social_security_amount,
  email
FROM workers;
```
to:
```sql
SELECT
  id, name, nickname, position, monthly_salary, has_social_security,
  annual_leave_days, monthly_contribution, status, created_at, updated_at,
  ROUND(monthly_salary / 26, 2) AS daily_rate,
  ROUND(monthly_salary * 0.05 / 100 * 750, 0) AS social_security_amount,
  email, show_in_assign
FROM workers;
```

- [ ] **Step 5: Update `useWorkers()` and add `useAllActiveWorkers()`**

In `src/hooks/useSupabase.js`, `useWorkers()` currently reads:
```js
export function useWorkers() {
  return useQuery(async () => {
    const { data, error } = await supabase
      .from('workers_with_rate')
      .select('*')
      .eq('status', 'active')
      .order('name')
    if (error) throw error
    return data
  })
}
```
Change it to add the roster filter, and add the new unfiltered variant immediately after it:
```js
export function useWorkers() {
  return useQuery(async () => {
    const { data, error } = await supabase
      .from('workers_with_rate')
      .select('*')
      .eq('status', 'active')
      .eq('show_in_assign', true)
      .order('name')
    if (error) throw error
    return data
  })
}

// Same as useWorkers() but WITHOUT the show_in_assign filter -- used by
// MySchedule.jsx, which must let a worker find and manage their own
// schedule even if an admin has hidden them from the Assign roster.
export function useAllActiveWorkers() {
  return useQuery(async () => {
    const { data, error } = await supabase
      .from('workers_with_rate')
      .select('*')
      .eq('status', 'active')
      .order('name')
    if (error) throw error
    return data
  })
}
```

- [ ] **Step 6: Build and test**

Run: `npm test`
Expected: all 41 existing tests pass (no new test file — both hooks are thin Supabase query wrappers with no branching logic, matching the existing convention of zero dedicated tests for this style of hook in this codebase).

Run: `npm run build`
Expected: succeeds with no new errors.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/2026-08-20-01-assign-roster-visibility.sql supabase/schema.sql src/hooks/useSupabase.js
git commit -m "feat: add show_in_assign flag to workers (schema + view + hooks)"
```

---

### Task 2: HR form — roster visibility checkbox

**Files:**
- Modify: `src/pages/HR.jsx`

**Interfaces:**
- Consumes: `workers.show_in_assign` column (Task 1) — this task only writes to it via the existing `workers` insert/update payload, no new hook needed.

- [ ] **Step 1: Add `show_in_assign` to `EMPTY_WORKER`**

In `src/pages/HR.jsx`, `EMPTY_WORKER` currently reads:
```js
const EMPTY_WORKER = {
  name: '', nickname: '', position: '',
  monthly_salary: '', status: 'active',
  has_social_security: true, annual_leave_days: 6, monthly_contribution: '', email: ''
}
```
Change to:
```js
const EMPTY_WORKER = {
  name: '', nickname: '', position: '',
  monthly_salary: '', status: 'active',
  has_social_security: true, annual_leave_days: 6, monthly_contribution: '', email: '',
  show_in_assign: true,
}
```

- [ ] **Step 2: Add the checkbox to `WorkerForm`**

The "สถานะ" field currently sits inside a `form-grid-2` alongside "ตำแหน่ง":
```jsx
        <div className="form-grid-2">
          <div>
            <label className="label">ตำแหน่ง</label>
            <input className="input" value={form.position} onChange={e => set('position', e.target.value)} placeholder="ช่างกระจก, ช่างอลูมิเนียม..." />
          </div>
          <div>
            <label className="label">สถานะ</label>
            <select className="select" value={form.status} onChange={e => set('status', e.target.value)}>
              <option value="active">Active</option>
              <option value="inactive">Inactive (ออกแล้ว)</option>
            </select>
          </div>
        </div>
```
Add the checkbox immediately after this block:
```jsx
        <div className="form-grid-2">
          <div>
            <label className="label">ตำแหน่ง</label>
            <input className="input" value={form.position} onChange={e => set('position', e.target.value)} placeholder="ช่างกระจก, ช่างอลูมิเนียม..." />
          </div>
          <div>
            <label className="label">สถานะ</label>
            <select className="select" value={form.status} onChange={e => set('status', e.target.value)}>
              <option value="active">Active</option>
              <option value="inactive">Inactive (ออกแล้ว)</option>
            </select>
          </div>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
          <input type="checkbox" checked={form.show_in_assign} onChange={e => set('show_in_assign', e.target.checked)} style={{ width: 16, height: 16 }} />
          แสดงในตาราง Assign (ปิดสำหรับพนักงานที่ไม่ต้อง assign วันทำงาน เช่น ออฟฟิศ)
        </label>
```

- [ ] **Step 3: Include it in the save payload**

`handleSaveWorker`'s payload currently reads:
```js
      const payload = {
        name: form.name, nickname: form.nickname || null,
        position: form.position || null,
        monthly_salary: parseFloat(form.monthly_salary) || 0,
        status: form.status,
        has_social_security: form.has_social_security,
        annual_leave_days: parseInt(form.annual_leave_days) || 0,
        monthly_contribution: parseFloat(form.monthly_contribution) || null,
        email: form.email || null,
      }
```
Add one line:
```js
      const payload = {
        name: form.name, nickname: form.nickname || null,
        position: form.position || null,
        monthly_salary: parseFloat(form.monthly_salary) || 0,
        status: form.status,
        has_social_security: form.has_social_security,
        annual_leave_days: parseInt(form.annual_leave_days) || 0,
        monthly_contribution: parseFloat(form.monthly_contribution) || null,
        email: form.email || null,
        show_in_assign: form.show_in_assign,
      }
```

- [ ] **Step 4: Switch `MySchedule.jsx` to the unfiltered hook**

In `src/pages/assign/MySchedule.jsx`, the import currently reads:
```js
import { useWorkers, useAssignmentsRange, useWorkerOTRange, useSitesProgress, useLeaveQuotaUsage } from '../../hooks/useSupabase.js'
```
Change to:
```js
import { useAllActiveWorkers, useAssignmentsRange, useWorkerOTRange, useSitesProgress, useLeaveQuotaUsage } from '../../hooks/useSupabase.js'
```
And the call site currently reads:
```js
  const { data: workers } = useWorkers()
```
Change to:
```js
  const { data: workers } = useAllActiveWorkers()
```

- [ ] **Step 5: Verify**

Run: `npm test`
Expected: all 41 tests pass.

Run: `npm run build`
Expected: succeeds with no new errors.

Do NOT verify by writing to the live database (this codebase's hard rule) — verification here is structural: confirm by reading the diff that `MySchedule.jsx` no longer imports or calls `useWorkers()` anywhere (`grep -n "useWorkers" src/pages/assign/MySchedule.jsx` should return zero matches, only `useAllActiveWorkers`), and that every OTHER Assign-facing file (`Assign.jsx`, `GridView.jsx`, `AssignWizard.jsx`, `AssignOTWizard.jsx`, `DayView.jsx`) still calls `useWorkers()` unchanged (this task doesn't touch any of those files).

Manually confirm in the dev server (documented limitation: no test login credentials available, note this in your report): unticking "แสดงในตาราง Assign" for a worker in HR, saving, then checking the Assign tab shows that worker no longer appears in the day-grid roster or either wizard's worker list; the same worker's own MySchedule view (if you can log in as them) is unaffected; re-ticking the checkbox brings them back, and any assignment history from while they were hidden is still intact (nothing was deleted).

- [ ] **Step 6: Commit**

```bash
git add src/pages/HR.jsx src/pages/assign/MySchedule.jsx
git commit -m "feat: add Assign roster visibility checkbox to the HR worker form"
```

---

### Task 3: Leave options in the main Assign wizard

**Files:**
- Modify: `src/pages/assign/AssignWizard.jsx`

**Interfaces:**
- Consumes: `SITE_TYPES` from `./constants.js` (already exists, already imported by `CellEditPopup.jsx` for the identical purpose — `SITE_TYPES = ['site', 'factory']`).

- [ ] **Step 1: Import `SITE_TYPES`**

`AssignWizard.jsx` currently imports:
```js
import { useMemo } from 'react'
import { Modal } from '../../components/Modal.jsx'
import SearchableSelect from '../../components/SearchableSelect.jsx'
import MultiDayPicker from './MultiDayPicker.jsx'
import { useDraftForm } from '../../hooks/useDraftForm.js'
```
Add one import:
```js
import { useMemo } from 'react'
import { Modal } from '../../components/Modal.jsx'
import SearchableSelect from '../../components/SearchableSelect.jsx'
import MultiDayPicker from './MultiDayPicker.jsx'
import { useDraftForm } from '../../hooks/useDraftForm.js'
import { SITE_TYPES } from './constants.js'
```

- [ ] **Step 2: Extend the type picker**

The step-2 block currently reads:
```jsx
        {/* 2. type */}
        <div>
          <div className="label" style={{ marginBottom: 6 }}>2 · ประเภทงาน</div>
          <div style={{ display: 'flex', gap: 8 }}>
            {[{ k: 'site', l: '🏗️ งานไซท์' }, { k: 'factory', l: '🏭 ผลิตที่โรงงาน' }].map(o => (
              <button key={o.k} type="button" onClick={() => set('type', o.k)}
                className={`btn btn-sm ${form.type === o.k ? 'btn-primary' : 'btn-ghost'}`} style={{ flex: 1 }}>{o.l}</button>
            ))}
          </div>
          {form.type === 'factory' && <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4 }}>ผลิตที่โรงงานให้ไซท์นี้ — ลงค่าแรงให้ไซท์ แต่ไม่มีค่าเดินทาง</div>}
        </div>
```
Change the type-option array to include the two leave types (labels/emoji matching `CellEditPopup.jsx`'s `TYPE_OPTS` exactly):
```jsx
        {/* 2. type */}
        <div>
          <div className="label" style={{ marginBottom: 6 }}>2 · ประเภทงาน</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {[
              { k: 'site', l: '🏗️ งานไซท์' },
              { k: 'factory', l: '🏭 ผลิตที่โรงงาน' },
              { k: 'leave_sick', l: '🤒 ลาป่วย' },
              { k: 'leave_personal', l: '🏖️ ลากิจ' },
            ].map(o => (
              <button key={o.k} type="button" onClick={() => set('type', o.k)}
                className={`btn btn-sm ${form.type === o.k ? 'btn-primary' : 'btn-ghost'}`} style={{ flex: '1 1 45%' }}>{o.l}</button>
            ))}
          </div>
          {form.type === 'factory' && <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4 }}>ผลิตที่โรงงานให้ไซท์นี้ — ลงค่าแรงให้ไซท์ แต่ไม่มีค่าเดินทาง</div>}
        </div>
```
(`flex: '1 1 45%'` with `flexWrap: 'wrap'` lays four buttons out as a 2×2 grid instead of forcing four buttons into one cramped row — `flex: 1` on its own, unchanged, would squeeze four labels into a row sized for two.)

- [ ] **Step 3: Conditionally render the site step**

The step-3 block currently reads:
```jsx
        {/* 3. site */}
        <div>
          <div className="label" style={{ marginBottom: 6 }}>3 · ไซท์งาน</div>
          <SearchableSelect
            value={form.siteId} onChange={id => set('siteId', id)} placeholder="— เลือกไซท์ —"
            options={sites.map(s => ({ value: s.id, label: `${s.site_number} · ${s.name}`, keywords: `${s.site_number} ${s.name}` }))}
          />
        </div>
```
Wrap it in a `SITE_TYPES.includes(form.type)` conditional, and renumber the remaining step labels so they stay sequential when this step is hidden:
```jsx
        {/* 3. site (leave types don't need one) */}
        {SITE_TYPES.includes(form.type) && (
          <div>
            <div className="label" style={{ marginBottom: 6 }}>3 · ไซท์งาน</div>
            <SearchableSelect
              value={form.siteId} onChange={id => set('siteId', id)} placeholder="— เลือกไซท์ —"
              options={sites.map(s => ({ value: s.id, label: `${s.site_number} · ${s.name}`, keywords: `${s.site_number} ${s.name}` }))}
            />
          </div>
        )}
```
Then find step 4 ("4 · ช่าง...") and step 5 ("5 · รายละเอียดเพิ่มเติม...") and change their static number prefixes to shift down by one when the site step is hidden:
```jsx
        {/* 4. workers */}
        <div>
          <div className="label" style={{ marginBottom: 6 }}>{SITE_TYPES.includes(form.type) ? '4' : '3'} · ช่าง (เลือกหลายคน · ค่าเริ่มต้นเช้า+บ่าย)</div>
```
```jsx
        {/* 5. notes */}
        <div>
          <div className="label" style={{ marginBottom: 6 }}>{SITE_TYPES.includes(form.type) ? '5' : '4'} · รายละเอียดเพิ่มเติม (ถ้ามี — ใช้ร่วมกันทุกวัน/ทุกคนที่เลือก)</div>
```

- [ ] **Step 4: Make the site requirement conditional in `submit()`**

`submit()` currently reads:
```js
  const submit = () => {
    if (!days.size)        return alert('เลือกวันอย่างน้อย 1 วัน')
    if (!form.siteId)      return alert('เลือกไซท์งาน')
    if (!selCount)         return alert('เลือกช่างอย่างน้อย 1 คน')
    const rows = []
    for (const date of days) {
      for (const [worker_id, sh] of Object.entries(form.sel)) {
        if (sh.am) rows.push({ worker_id, date, shift: 'morning', site_id: form.siteId, type: form.type, notes: form.notes || null })
        if (sh.pm) rows.push({ worker_id, date, shift: 'evening', site_id: form.siteId, type: form.type, notes: form.notes || null })
      }
    }
    if (!rows.length) return alert('ทุกช่างถูกปิดกะทั้งเช้าและบ่าย')
    clearFormDraft()
    onSubmit(rows)
  }
```
Change to:
```js
  const submit = () => {
    const needsSite = SITE_TYPES.includes(form.type)
    if (!days.size)          return alert('เลือกวันอย่างน้อย 1 วัน')
    if (needsSite && !form.siteId) return alert('เลือกไซท์งาน')
    if (!selCount)           return alert('เลือกช่างอย่างน้อย 1 คน')
    const siteId = needsSite ? form.siteId : null
    const rows = []
    for (const date of days) {
      for (const [worker_id, sh] of Object.entries(form.sel)) {
        if (sh.am) rows.push({ worker_id, date, shift: 'morning', site_id: siteId, type: form.type, notes: form.notes || null })
        if (sh.pm) rows.push({ worker_id, date, shift: 'evening', site_id: siteId, type: form.type, notes: form.notes || null })
      }
    }
    if (!rows.length) return alert('ทุกช่างถูกปิดกะทั้งเช้าและบ่าย')
    clearFormDraft()
    onSubmit(rows)
  }
```

- [ ] **Step 5: Verify**

Run: `npm test`
Expected: all 41 tests pass (no new test file — this is UI wiring reusing an already-existing, already-tested-by-usage constant; `CellEditPopup.jsx` has no dedicated test file for its identical `needsSite` logic either, so this matches existing convention).

Run: `npm run build`
Expected: succeeds with no new errors.

Manually confirm in the dev server (documented limitation: no test login credentials available, note this in your report): opening "+ Assign งาน" and selecting 🤒 ลาป่วย or 🏖️ ลากิจ hides the "ไซท์งาน" step and lets you submit without picking a site; selecting 🏗️ งานไซท์ or 🏭 ผลิตที่โรงงาน still shows and requires the site step exactly as before; a submitted leave assignment shows up correctly in the day grid, matching how a `CellEditPopup`-created leave row already renders.

- [ ] **Step 6: Commit**

```bash
git add src/pages/assign/AssignWizard.jsx
git commit -m "feat: add leave options to the main Assign wizard"
```
