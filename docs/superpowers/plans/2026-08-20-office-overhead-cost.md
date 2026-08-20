# Office Assign + Overhead Cost Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add "ออฟฟิศ" as a selectable type in the bulk Assign wizard (matching the single-cell popup), and automatically compute + display an overhead-cost figure for office days in HR's payroll tab.

**Architecture:** Part A is a one-line addition to an already-generalized type picker (`AssignWizard.jsx`'s `SITE_TYPES.includes(form.type)` conditional already treats any non-site type correctly). Part B adds two new `salary_records` columns, extends the existing per-worker monthly aggregation in `handleCalcFromAssign` with an `office` counter (mirroring how `leave_sick`/`leave_personal` are already counted), and threads the two new values through the preview modal, the saved payroll table, and a new KPI card — the same wiring the existing OT/leave/holiday columns already use.

**Tech Stack:** React 18, Vite, Supabase (Postgres + PostgREST), vitest.

## Global Constraints

- `office_cost` is purely informational — it must NEVER be added to or subtracted from `net_pay`.
- `office_cost` is NEVER written to the `expenses` table — no new `expenses` rows, ever, as part of this feature.
- Every Postgres view touched must preserve `WITH (security_invoker = true)` if modified (none are modified by this plan — `salary_records` is a table, not a view, and no view depends on its new columns).
- `office_days` uses `NUMERIC`, not `INT` — days are counted in 0.5 increments (one shift = 0.5 day), matching the existing `leave_sick`/`leave_personal` counting convention in `handleCalcFromAssign`.
- Never write to the live Supabase database except via `apply_migration` (for this plan's own migration) and read-only `SELECT`/`information_schema`/`get_advisors` verification queries.
- Work happens in `/Users/plfx/code/FacadeXPM/facadex-app` (the main repo checkout, branch `main`) — commits go directly onto `main`, matching every prior plan shipped this session.

---

### Task 1: Add "office" to the bulk Assign wizard

**Files:**
- Modify: `src/pages/assign/AssignWizard.jsx:67-75`

**Interfaces:**
- Consumes: nothing new — `SITE_TYPES` is already imported (`src/pages/assign/constants.js`, `['site', 'factory']`) and the existing `SITE_TYPES.includes(form.type)` conditionals (site-step visibility, submit validation, `site_id` in the row-building loop) already generalize correctly to any type not in `SITE_TYPES`.
- Produces: nothing new for later tasks — this task is fully self-contained.

- [ ] **Step 1: Add the office button to the type-picker array**

In `src/pages/assign/AssignWizard.jsx`, find the type-picker array (inside the `2 · ประเภทงาน` block):

```jsx
            {[
              { k: 'site', l: '🏗️ งานไซท์' },
              { k: 'factory', l: '🏭 ผลิตที่โรงงาน' },
              { k: 'leave_sick', l: '🤒 ลาป่วย' },
              { k: 'leave_personal', l: '🏖️ ลากิจ' },
            ].map(o => (
```

Replace with:

```jsx
            {[
              { k: 'site', l: '🏗️ งานไซท์' },
              { k: 'factory', l: '🏭 ผลิตที่โรงงาน' },
              { k: 'office', l: '🏢 ออฟฟิศ' },
              { k: 'leave_sick', l: '🤒 ลาป่วย' },
              { k: 'leave_personal', l: '🏖️ ลากิจ' },
            ].map(o => (
```

This label/emoji must match `src/pages/assign/CellEditPopup.jsx`'s existing `TYPE_OPTS` entry for `office` character-for-character: `{ k: 'office', l: '🏢 ออฟฟิศ' }`.

No other change is needed in this file. `SITE_TYPES` (`['site', 'factory']`) does not include `'office'`, so the existing conditionals at line 81 (`{SITE_TYPES.includes(form.type) && (...)}`, hides the site step), line 39 (`if (needsSite && !form.siteId) return alert(...)`, skips the site requirement), and line 41 (`const siteId = needsSite ? form.siteId : null`, writes `site_id: null`) all already treat `office` correctly with zero further changes — this is the same mechanism that already makes `leave_sick`/`leave_personal` work.

- [ ] **Step 2: Run the existing test suite**

Run: `npm test`
Expected: all existing tests still pass (this change touches no tested logic — it's a static array literal).

- [ ] **Step 3: Run the build**

Run: `npm run build`
Expected: succeeds with no new errors.

- [ ] **Step 4: Commit**

```bash
git add src/pages/assign/AssignWizard.jsx
git commit -m "feat: add ออฟฟิศ as a type option in the bulk Assign wizard"
```

---

### Task 2: Schema — office_days/office_cost columns on salary_records

**Files:**
- Create: `supabase/migrations/2026-08-20-03-office-overhead-cost.sql`
- Modify: `supabase/schema.sql` (mirror the `CREATE TABLE salary_records` block)

**Interfaces:**
- Produces: `salary_records.office_days NUMERIC DEFAULT 0` and `salary_records.office_cost NUMERIC DEFAULT 0` — Task 3 reads and writes both by these exact names via the Supabase JS client (`supabase.from('salary_records')`), no view or RPC involved.

- [ ] **Step 1: Write the migration file**

Create `supabase/migrations/2026-08-20-03-office-overhead-cost.sql`:

```sql
-- Overhead cost tracking: a worker assigned type='office' contributes zero
-- cost anywhere in the app today (labor_cost_by_site only counts
-- site/factory). These two columns let HR's payroll calc attribute a
-- cost-informational figure to office days, mirroring labor_cost_by_site's
-- own formula (monthly_salary / 26 * days). NUMERIC (not INT) because days
-- are counted in 0.5 increments (one shift = 0.5 day), matching how
-- leave_sick/leave_personal are already counted in handleCalcFromAssign.
--
-- This is purely informational -- it must never be added to or subtracted
-- from net_pay, and must never be written to the expenses table.
ALTER TABLE salary_records ADD COLUMN office_days NUMERIC DEFAULT 0;
ALTER TABLE salary_records ADD COLUMN office_cost NUMERIC DEFAULT 0;
```

- [ ] **Step 2: Apply the migration to the live database**

Use the `apply_migration` Supabase MCP tool with:
- `project_id`: `yyzbgdmgyvvypfcjuhtr`
- `name`: `office_overhead_cost`
- `query`: the exact SQL from Step 1

- [ ] **Step 3: Verify the columns exist with the correct defaults (read-only)**

Run this read-only query via the `execute_sql` Supabase MCP tool:

```sql
SELECT column_name, data_type, column_default, is_nullable
FROM information_schema.columns
WHERE table_name = 'salary_records' AND column_name IN ('office_days', 'office_cost');
```

Expected: two rows, both `data_type = 'numeric'`, both `column_default = '0'`.

Also verify no existing `salary_records` rows were disturbed:

```sql
SELECT office_days, office_cost, count(*) FROM salary_records GROUP BY office_days, office_cost;
```

Expected: a single group, `office_days = 0, office_cost = 0`, count equal to the total row count of `salary_records` (every existing row backfilled to the column default).

- [ ] **Step 4: Mirror into supabase/schema.sql**

In `supabase/schema.sql`, find the `CREATE TABLE salary_records` block:

```sql
CREATE TABLE salary_records (
  id                    UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  worker_id             UUID NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  month                 INT NOT NULL CHECK (month BETWEEN 1 AND 12),
  year                  INT NOT NULL,
  base_salary           NUMERIC DEFAULT 0,
  contribution          NUMERIC DEFAULT 0,
  phone_allowance       NUMERIC DEFAULT 0,
  ot_amount             NUMERIC DEFAULT 0,       -- also carries the holiday-work bonus (no dedicated column)
  special_allowance     NUMERIC DEFAULT 0,
  advance_deduction     NUMERIC DEFAULT 0,
  social_security_ded   NUMERIC DEFAULT 0,
  leave_deduction       NUMERIC DEFAULT 0,       -- leave_personal only; leave_sick never deducts
  loan_deduction        NUMERIC DEFAULT 0,
  net_pay               NUMERIC DEFAULT 0,
  paid_date             DATE,
  notes                 TEXT,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  tenant_id             UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  UNIQUE (worker_id, month, year)
);
```

Replace with (two new columns added before `paid_date`):

```sql
CREATE TABLE salary_records (
  id                    UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  worker_id             UUID NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  month                 INT NOT NULL CHECK (month BETWEEN 1 AND 12),
  year                  INT NOT NULL,
  base_salary           NUMERIC DEFAULT 0,
  contribution          NUMERIC DEFAULT 0,
  phone_allowance       NUMERIC DEFAULT 0,
  ot_amount             NUMERIC DEFAULT 0,       -- also carries the holiday-work bonus (no dedicated column)
  special_allowance     NUMERIC DEFAULT 0,
  advance_deduction     NUMERIC DEFAULT 0,
  social_security_ded   NUMERIC DEFAULT 0,
  leave_deduction       NUMERIC DEFAULT 0,       -- leave_personal only; leave_sick never deducts
  loan_deduction        NUMERIC DEFAULT 0,
  office_days           NUMERIC DEFAULT 0,       -- informational only -- never affects net_pay, never written to expenses
  office_cost           NUMERIC DEFAULT 0,       -- monthly_salary/26 * office_days, same formula as labor_cost_by_site
  net_pay               NUMERIC DEFAULT 0,
  paid_date             DATE,
  notes                 TEXT,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  tenant_id             UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  UNIQUE (worker_id, month, year)
);
```

- [ ] **Step 5: Run the existing test suite**

Run: `npm test`
Expected: all existing tests still pass (no JS code changed yet in this task).

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/2026-08-20-03-office-overhead-cost.sql supabase/schema.sql
git commit -m "feat: add office_days/office_cost columns to salary_records"
```

---

### Task 3: Compute and display overhead cost in HR payroll

**Files:**
- Modify: `src/pages/HR.jsx` (multiple locations — see steps below)

**Interfaces:**
- Consumes: `salary_records.office_days` / `salary_records.office_cost` (Task 2). `worker_assignments.type = 'office'` rows (already written today via `CellEditPopup.jsx` and, after Task 1, `AssignWizard.jsx`).
- Produces: nothing further downstream — this is the final task in the plan.

- [ ] **Step 1: Count office shifts in `handleCalcFromAssign`'s per-worker aggregation**

In `src/pages/HR.jsx`, find the `wmap` aggregation loop inside `handleCalcFromAssign`:

```jsx
      const wmap = {}
      ;(assigns||[]).forEach(a => {
        const w = a.workers; if (!w) return
        if (!wmap[a.worker_id]) wmap[a.worker_id] = { worker: w, leave_sick: 0, leave_personal: 0, ot_hours: 0 }
        if (a.type === 'leave_sick')                          wmap[a.worker_id].leave_sick += 0.5
        if (a.type === 'leave_personal' || a.type === 'leave') wmap[a.worker_id].leave_personal += 0.5  // 1 กะ = 0.5 วัน (เช้า+บ่าย = 1 วัน)
        if (a.type === 'site')                                 wmap[a.worker_id].ot_hours += (a.ot_hours||0)  // legacy OT stored on the shift row
      })
```

Replace with (adds an `office: 0` initializer and an `office` counter, same shape as the existing `leave_sick`/`leave_personal` counters):

```jsx
      const wmap = {}
      ;(assigns||[]).forEach(a => {
        const w = a.workers; if (!w) return
        if (!wmap[a.worker_id]) wmap[a.worker_id] = { worker: w, leave_sick: 0, leave_personal: 0, office: 0, ot_hours: 0 }
        if (a.type === 'leave_sick')                          wmap[a.worker_id].leave_sick += 0.5
        if (a.type === 'leave_personal' || a.type === 'leave') wmap[a.worker_id].leave_personal += 0.5  // 1 กะ = 0.5 วัน (เช้า+บ่าย = 1 วัน)
        if (a.type === 'office')                               wmap[a.worker_id].office += 0.5  // 1 กะ = 0.5 วัน, เหมือน leave
        if (a.type === 'site')                                 wmap[a.worker_id].ot_hours += (a.ot_hours||0)  // legacy OT stored on the shift row
      })
```

- [ ] **Step 2: Compute `office_cost` and include it in the `results` row**

Find the `results` map at the end of `handleCalcFromAssign`:

```jsx
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

Replace with (adds `office_days`/`office_cost` to the returned row; `net_pay`'s formula is unchanged — `office_cost` is deliberately not part of it):

```jsx
      const results = Object.entries(wmap).map(([worker_id, d]) => {
        const dr  = (d.worker.monthly_salary||0) / 26
        const lv  = parseFloat((d.leave_personal * dr).toFixed(2))
        const ot  = parseFloat((d.ot_hours * dr / 8 * 1.5).toFixed(2))
        const hb  = parseFloat(((d.holiday_shifts||0) * dr * 0.5 * holidayMultiplier).toFixed(2))
        const oc  = parseFloat((d.office * dr).toFixed(2))
        const sso = d.worker.has_social_security ? parseFloat(Math.min(750,(d.worker.monthly_salary||0)*0.05).toFixed(2)) : 0
        return {
          worker_id, name: d.worker.name, nickname: d.worker.nickname,
          base_salary: d.worker.monthly_salary||0,
          contribution: d.worker.monthly_contribution||0,
          social_security_ded: sso,
          leave_sick_days: d.leave_sick, leave_personal_days: d.leave_personal,
          leave_deduction: lv, ot_hours: d.ot_hours, ot_amount: ot,
          holiday_shifts: d.holiday_shifts||0, holiday_bonus: hb,
          office_days: d.office, office_cost: oc,
          net_pay: parseFloat(((d.worker.monthly_salary||0) - sso - lv + ot + hb).toFixed(2)),
        }
      })
```

- [ ] **Step 3: Persist `office_days`/`office_cost` in `handleConfirmCalc`'s upsert payload**

Find:

```jsx
        const payload = {
          worker_id: r.worker_id, month, year,
          base_salary: r.base_salary, contribution: r.contribution,
          ot_amount: r.ot_amount + (r.holiday_bonus || 0), social_security_ded: r.social_security_ded,
          leave_deduction: r.leave_deduction, net_pay: r.net_pay,
        }
```

Replace with:

```jsx
        const payload = {
          worker_id: r.worker_id, month, year,
          base_salary: r.base_salary, contribution: r.contribution,
          ot_amount: r.ot_amount + (r.holiday_bonus || 0), social_security_ded: r.social_security_ded,
          leave_deduction: r.leave_deduction, net_pay: r.net_pay,
          office_days: r.office_days || 0, office_cost: r.office_cost || 0,
        }
```

- [ ] **Step 4: Reset `office_days`/`office_cost` to 0 in `handleCopyPrevMonth`**

Find the reset block inside `handleCopyPrevMonth`:

```jsx
      // reset variable fields
      ot_amount: 0,
      advance_deduction: 0,
      loan_deduction: 0,
      leave_deduction: 0,
      leave_sick_days: 0,
      leave_personal_days: 0,
      ot_hours: 0,
```

Replace with:

```jsx
      // reset variable fields
      ot_amount: 0,
      advance_deduction: 0,
      loan_deduction: 0,
      leave_deduction: 0,
      leave_sick_days: 0,
      leave_personal_days: 0,
      office_days: 0,
      office_cost: 0,
      ot_hours: 0,
```

- [ ] **Step 5: Add the two columns to the calc-preview modal table**

Find the preview table header:

```jsx
                <thead><tr><th>พนักงาน</th><th>เงินเดือน</th><th>ลาป่วย</th><th>ลากิจ</th><th>หักลา</th><th>OT ชม.</th><th>OT บาท</th><th>กะวันหยุด</th><th>โบนัสวันหยุด</th><th>SSO</th><th>สุทธิ</th></tr></thead>
```

Replace with (two new columns after "โบนัสวันหยุด", before "SSO"):

```jsx
                <thead><tr><th>พนักงาน</th><th>เงินเดือน</th><th>ลาป่วย</th><th>ลากิจ</th><th>หักลา</th><th>OT ชม.</th><th>OT บาท</th><th>กะวันหยุด</th><th>โบนัสวันหยุด</th><th>วันออฟฟิศ</th><th>ค่าใช้จ่ายส่วนกลาง</th><th>SSO</th><th>สุทธิ</th></tr></thead>
```

Find the row cell for "โบนัสวันหยุด" (to insert the two new cells right after it):

```jsx
                      <td className="font-mono" style={{ color: 'var(--accent)' }}>{r.holiday_bonus>0?fmt(r.holiday_bonus):'—'}</td>
                      <td className="font-mono" style={{ color: 'var(--red)', fontSize: 12 }}>{r.social_security_ded>0?`(${fmt(r.social_security_ded)})`:'—'}</td>
```

Replace with:

```jsx
                      <td className="font-mono" style={{ color: 'var(--accent)' }}>{r.holiday_bonus>0?fmt(r.holiday_bonus):'—'}</td>
                      <td style={{ textAlign: 'center', color: r.office_days>0?'var(--blue)':'var(--text3)' }}>{r.office_days||'—'}</td>
                      <td className="font-mono" style={{ color: 'var(--blue)' }}>{r.office_cost>0?fmt(r.office_cost):'—'}</td>
                      <td className="font-mono" style={{ color: 'var(--red)', fontSize: 12 }}>{r.social_security_ded>0?`(${fmt(r.social_security_ded)})`:'—'}</td>
```

- [ ] **Step 6: Add a `totalOfficeCost` memo alongside the existing payroll totals**

Find:

```jsx
  const totalBase = useMemo(() => visibleRecords.reduce((s,r)=>s+(r.base_salary||0),0),[visibleRecords])
  const totalNet  = useMemo(() => visibleRecords.reduce((s,r)=>s+(r.net_pay||0),0),[visibleRecords])
  const totalOT   = useMemo(() => visibleRecords.reduce((s,r)=>s+(r.ot_amount||0),0),[visibleRecords])
  const totalSSO  = useMemo(() => visibleRecords.reduce((s,r)=>s+(r.social_security_ded||0),0),[visibleRecords])
```

Replace with:

```jsx
  const totalBase = useMemo(() => visibleRecords.reduce((s,r)=>s+(r.base_salary||0),0),[visibleRecords])
  const totalNet  = useMemo(() => visibleRecords.reduce((s,r)=>s+(r.net_pay||0),0),[visibleRecords])
  const totalOT   = useMemo(() => visibleRecords.reduce((s,r)=>s+(r.ot_amount||0),0),[visibleRecords])
  const totalSSO  = useMemo(() => visibleRecords.reduce((s,r)=>s+(r.social_security_ded||0),0),[visibleRecords])
  const totalOfficeCost = useMemo(() => visibleRecords.reduce((s,r)=>s+(r.office_cost||0),0),[visibleRecords])
```

- [ ] **Step 7: Add the new KPI card**

Find the KPI card row:

```jsx
          <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
            <div className="kpi-card kpi-sm"><div className="kpi-label">เงินเดือนรวม</div><div className="kpi-value">{fmt(totalBase)}</div></div>
            <div className="kpi-card kpi-sm"><div className="kpi-label">OT</div><div className="kpi-value" style={{ color: 'var(--yellow)' }}>{fmt(totalOT)}</div></div>
            <div className="kpi-card kpi-sm"><div className="kpi-label">ประกันสังคม</div><div className="kpi-value">{fmt(totalSSO)}</div></div>
            <div className="kpi-card kpi-sm green"><div className="kpi-label">จ่ายสุทธิรวม</div><div className="kpi-value" style={{ color: 'var(--green)' }}>{fmt(totalNet)}</div></div>
          </div>
```

Replace with (new card inserted after "ประกันสังคม", before "จ่ายสุทธิรวม"):

```jsx
          <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
            <div className="kpi-card kpi-sm"><div className="kpi-label">เงินเดือนรวม</div><div className="kpi-value">{fmt(totalBase)}</div></div>
            <div className="kpi-card kpi-sm"><div className="kpi-label">OT</div><div className="kpi-value" style={{ color: 'var(--yellow)' }}>{fmt(totalOT)}</div></div>
            <div className="kpi-card kpi-sm"><div className="kpi-label">ประกันสังคม</div><div className="kpi-value">{fmt(totalSSO)}</div></div>
            <div className="kpi-card kpi-sm blue"><div className="kpi-label">ค่าใช้จ่ายส่วนกลางรวม</div><div className="kpi-value" style={{ color: 'var(--blue)' }}>{fmt(totalOfficeCost)}</div></div>
            <div className="kpi-card kpi-sm green"><div className="kpi-label">จ่ายสุทธิรวม</div><div className="kpi-value" style={{ color: 'var(--green)' }}>{fmt(totalNet)}</div></div>
          </div>
```

- [ ] **Step 8: Add the two columns to the saved payroll table**

Find the saved table header:

```jsx
                <thead>
                  <tr>
                    <th>พนักงาน</th><th>เงินเดือน</th><th>OT</th>
                    <th>ประกันสังคม</th><th>หักลา</th><th>เบิกล่วงหน้า</th>
                    <th>จ่ายสุทธิ</th><th>วันจ่าย</th><th></th>
                  </tr>
                </thead>
```

Replace with (two new columns after "เงินเดือน", before "OT"):

```jsx
                <thead>
                  <tr>
                    <th>พนักงาน</th><th>เงินเดือน</th><th>วันออฟฟิศ</th><th>ค่าใช้จ่ายส่วนกลาง</th><th>OT</th>
                    <th>ประกันสังคม</th><th>หักลา</th><th>เบิกล่วงหน้า</th>
                    <th>จ่ายสุทธิ</th><th>วันจ่าย</th><th></th>
                  </tr>
                </thead>
```

Find the corresponding row cells:

```jsx
                      <td className="font-mono">{fmt(r.base_salary)}</td>
                      <td className="font-mono" style={{ color: r.ot_amount>0?'var(--yellow)':'var(--text3)' }}>{r.ot_amount>0?fmt(r.ot_amount):'—'}</td>
```

Replace with:

```jsx
                      <td className="font-mono">{fmt(r.base_salary)}</td>
                      <td style={{ textAlign: 'center', color: r.office_days>0?'var(--blue)':'var(--text3)' }}>{r.office_days||'—'}</td>
                      <td className="font-mono" style={{ color: r.office_cost>0?'var(--blue)':'var(--text3)' }}>{r.office_cost>0?fmt(r.office_cost):'—'}</td>
                      <td className="font-mono" style={{ color: r.ot_amount>0?'var(--yellow)':'var(--text3)' }}>{r.ot_amount>0?fmt(r.ot_amount):'—'}</td>
```

Find the empty-state colspan (must grow by 2 to match the new column count):

```jsx
                  {!visibleRecords.length && (
                    <tr><td colSpan={9} style={{ textAlign: 'center', color: 'var(--text3)', padding: 32 }}>
                      ยังไม่มีข้อมูลเงินเดือน {MONTHS[month-1]} {year+543}
                    </td></tr>
                  )}
```

Replace with:

```jsx
                  {!visibleRecords.length && (
                    <tr><td colSpan={11} style={{ textAlign: 'center', color: 'var(--text3)', padding: 32 }}>
                      ยังไม่มีข้อมูลเงินเดือน {MONTHS[month-1]} {year+543}
                    </td></tr>
                  )}
```

- [ ] **Step 9: Add `office_cost` to the totals footer row (and fix a pre-existing column-alignment bug while touching this block)**

Find:

```jsx
                  <tfoot>
                    <tr style={{ borderTop: '2px solid var(--border)', fontWeight: 700 }}>
                      <td style={{ color: 'var(--text3)', fontSize: 12 }}>รวม</td>
                      <td className="font-mono">{fmt(totalBase)}</td>
                      <td className="font-mono" style={{ color: 'var(--yellow)' }}>{fmt(totalOT)}</td>
                      <td className="font-mono" style={{ color: 'var(--red)' }}>{fmt(totalSSO)}</td>
                      <td colSpan={3} />
                      <td className="font-mono" style={{ color: 'var(--green)' }}>{fmt(totalNet)}</td>
                      <td colSpan={2} />
                    </tr>
                  </tfoot>
```

The original 9-column header (พนักงาน, เงินเดือน, OT, ประกันสังคม, หักลา, เบิกล่วงหน้า, จ่ายสุทธิ, วันจ่าย, actions) doesn't actually line up with this footer: counting cell-by-cell, `รวม`(1) `totalBase`(2) `totalOT`(3) `totalSSO`(4) `colSpan=3`(5-7) `totalNet`(8) `colSpan=2`(9-10) — `totalNet` lands under "วันจ่าย" (position 8) instead of "จ่ายสุทธิ" (position 7), and the row totals 10 column-widths against a 9-column header. This plan is already editing this exact block to insert two new columns, so fix the alignment in the same edit rather than compounding it onto a now-11-column header.

Replace with (correctly aligned against the new 11-column header: พนักงาน, เงินเดือน, วันออฟฟิศ, ค่าใช้จ่ายส่วนกลาง, OT, ประกันสังคม, หักลา, เบิกล่วงหน้า, จ่ายสุทธิ, วันจ่าย, actions):

```jsx
                  <tfoot>
                    <tr style={{ borderTop: '2px solid var(--border)', fontWeight: 700 }}>
                      <td style={{ color: 'var(--text3)', fontSize: 12 }}>รวม</td>
                      <td className="font-mono">{fmt(totalBase)}</td>
                      <td />
                      <td className="font-mono" style={{ color: 'var(--blue)' }}>{fmt(totalOfficeCost)}</td>
                      <td className="font-mono" style={{ color: 'var(--yellow)' }}>{fmt(totalOT)}</td>
                      <td className="font-mono" style={{ color: 'var(--red)' }}>{fmt(totalSSO)}</td>
                      <td colSpan={2} />
                      <td className="font-mono" style={{ color: 'var(--green)' }}>{fmt(totalNet)}</td>
                      <td colSpan={2} />
                    </tr>
                  </tfoot>
```

Column-by-column check against the 11-column header: `รวม`@พนักงาน(1), `totalBase`@เงินเดือน(2), blank@วันออฟฟิศ(3), `totalOfficeCost`@ค่าใช้จ่ายส่วนกลาง(4), `totalOT`@OT(5), `totalSSO`@ประกันสังคม(6), `colSpan=2`@หักลา+เบิกล่วงหน้า(7-8), `totalNet`@จ่ายสุทธิ(9) — now correctly aligned — `colSpan=2`@วันจ่าย+actions(10-11). Total: 1+1+1+1+1+1+2+1+2 = 11, matching the header exactly.

- [ ] **Step 10: Run the test suite**

Run: `npm test`
Expected: all existing tests pass (no pure-logic function changed shape — `office_cost = office_days * dr` is the same formula shape as the existing `leave_deduction` calc, no new test file needed per the spec's Testing section).

- [ ] **Step 11: Run the build**

Run: `npm run build`
Expected: succeeds with no new errors.

- [ ] **Step 12: Commit**

```bash
git add src/pages/HR.jsx
git commit -m "feat: compute and display overhead cost for office days in payroll"
```

---

## Manual Verification (documented limitation — no test login credentials this session)

- Part A: open Assign ช่าง → "+ Assign งาน" → select ออฟฟิศ → confirm the site-selection step disappears → submit for a worker/day → confirm the resulting cell renders in the grid the same way a `CellEditPopup`-created office row does today.
- Part B: assign a worker `office` for a few days in the current month (via either entry point) → HR → เงินเดือน tab → "🔄 คำนวณจาก Assign" → confirm the preview modal shows the correct `office_days`/`office_cost` → confirm on save → confirm the saved table and the new "ค่าใช้จ่ายส่วนกลางรวม" KPI card show the correct values → confirm `net_pay` is unchanged from what it would be without the office days.
