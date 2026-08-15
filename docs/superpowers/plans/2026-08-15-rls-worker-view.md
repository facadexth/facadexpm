# RLS + Restricted WORKER View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give WORKER-role users a restricted Dashboard (site progress %, no baht figures) and a personal "my schedule" view on the Assign page (own days/shifts/OT/leave quota, no team grid, no cost breakdown), then enforce all of it at the database level with Row Level Security so the restriction can't be bypassed via the Supabase API directly.

**Architecture:** Two halves that must ship in this order, not together:
1. **Frontend first** (Tasks 1-5): new `sites_progress` view (pure additive, safe to apply immediately) + role-conditional rendering in `Dashboard.jsx`/`Assign.jsx` that queries only what WORKER should see. This alone achieves the UX goal and is safe to deploy — RLS is still off, so nothing that currently works can break.
2. **RLS enforcement last** (Task 6-7): once the frontend already only asks for WORKER-appropriate data, turning on RLS should be invisible to a correctly-updated app and only blocks illegitimate direct-API access. Applying RLS before the frontend ships would break the *current* production Dashboard/Assign pages for WORKER users (they'd suddenly see empty tables), so this ordering is load-bearing, not arbitrary.

**Tech Stack:** React + Vite, Supabase (Postgres + supabase-js + RLS policies). No automated test suite — verification is `npm run build`, Supabase MCP `execute_sql` round-trips, and manual dev-server click-throughs (this project has no browser automation tool available in-session, so Task 7's UI checks are for the human to run).

## Global Constraints

- Supabase project id: `yyzbgdmgyvvypfcjuhtr`. Apply migrations via `mcp__plugin_supabase_supabase__apply_migration`.
- Role hierarchy (from `src/hooks/useUserRole.js`): `OWNER(3) > ADMIN(2) > WORKER(1)`, `isAtLeast(role)` helper already exists and is the established pattern — reuse it, don't invent a new role-check.
- Confirmed access model (from user, do not deviate without asking):
  | Table/view | WORKER | ADMIN | OWNER |
  |---|---|---|---|
  | `sites_progress` (new view: site_number, name, status, dates, billing_pct — no money) | read | read | read |
  | `sites`, `expenses`, `incomes`, `expense_categories`, `app_settings` (base tables) | none | read+write | read+write |
  | `workers` | read own row only | read+write all | read+write all |
  | `worker_assignments`, `worker_ot` | read own rows only, no write | read+write all | read+write all |
  | `company_holidays` | read | read+write | read+write |
  | `salary_records` | read own row only, no write | read+write all | read+write all |
  | `clients`, `suppliers`, `labor_subcontractors`, `labor_contracts`, `labor_payments`, `audit_logs`, `calendar_sync`, `site_phases` | none | read+write (audit_logs: read only) | read+write |
  | `user_roles` | read all rows (email+role only, no salary data) | read all, cannot change roles | full control |
- WORKER must never see: `contract_value`, `cost_*` columns on `sites`, any row from `expenses`/`incomes`, any other worker's `salary_records`/`monthly_salary`/schedule/OT.
- WORKER must see: their own `annual_leave_days` and personal-leave quota usage (reuse the existing `useLeaveQuotaUsage` hook from `src/hooks/useSupabase.js` — already computes exactly this, do not duplicate it).
- Thai UI copy throughout, matching the project's existing tone (see any current page for reference — direct, no fluff).
- Dark theme only, using the existing CSS custom properties in `src/index.css` (`--bg`, `--bg2`, `--bg3`, `--accent`, `--green`, `--red`, `--yellow`, `--blue`, `--text`, `--text2`, `--text3`, `--border`) — do not introduce new colors.
- The approved visual design lives at the artifact preview shared with the user during design (mockup file, not part of this repo) — Tasks 3 and 4 transcribe that mockup's structure into real React using the existing component patterns below, not a fresh redesign.

---

### Task 1: `sites_progress` view

**Files:**
- Create: `supabase/migrations/2026-08-15-02-sites-progress-view.sql`
- Modify: `supabase/schema.sql`

**Interfaces:**
- Produces: view `sites_progress(id, site_number, name, status, start_date, end_date, billing_pct)` — consumed by Task 2's hook.

- [ ] **Step 1: Write the migration**

`supabase/migrations/2026-08-15-02-sites-progress-view.sql`:

```sql
-- sites_progress: WORKER-safe view of site info — exposes the billing
-- percentage (income received / contract value) as a progress proxy,
-- but never the underlying money figures themselves. Built on top of
-- site_financial_summary (already computes billing_pct) rather than
-- duplicating that math.
-- See docs/superpowers/plans/2026-08-15-rls-worker-view.md
CREATE OR REPLACE VIEW sites_progress AS
SELECT
  id,
  site_number,
  name,
  status,
  start_date,
  end_date,
  billing_pct
FROM site_financial_summary;
```

- [ ] **Step 2: Apply the migration**

Use `mcp__plugin_supabase_supabase__apply_migration` with `project_id: yyzbgdmgyvvypfcjuhtr`, `name: sites_progress_view`, and the full SQL from Step 1 as `query`.

- [ ] **Step 3: Verify the view**

Run via `execute_sql`:
```sql
SELECT column_name FROM information_schema.columns WHERE table_name = 'sites_progress' ORDER BY ordinal_position;
```
Expected: exactly 6 columns — `id, site_number, name, status, start_date, end_date, billing_pct` — no money columns.

Then:
```sql
SELECT site_number, name, status, billing_pct FROM sites_progress LIMIT 3;
```
Expected: real rows, `billing_pct` populated (or null) matching what `site_financial_summary` already shows for those sites.

- [ ] **Step 4: Add the view to `supabase/schema.sql`**

Find the `site_financial_summary` view definition in `supabase/schema.sql` (search for `CREATE OR REPLACE VIEW site_financial_summary`) and add the new view immediately after its closing `;`, before the `payment_forecast` view section:

```sql

-- WORKER-safe site info — billing_pct as a progress proxy, no money columns
CREATE OR REPLACE VIEW sites_progress AS
SELECT
  id,
  site_number,
  name,
  status,
  start_date,
  end_date,
  billing_pct
FROM site_financial_summary;
```

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/2026-08-15-02-sites-progress-view.sql supabase/schema.sql
git commit -m "Add sites_progress view exposing billing_pct without money columns"
```

---

### Task 2: `useSupabase.js` — WORKER-facing data hooks

**Files:**
- Modify: `src/hooks/useSupabase.js`

**Interfaces:**
- Produces: `useSitesProgress() -> { data, loading, error, refetch }` — all sites' safe info, ordered by site_number. Consumed by Task 3.
- Consumes (already exist, do not modify): `useLeaveQuotaUsage(year)`, `useAssignmentsRange(from, to)`, `useWorkerOTRange(from, to)`, `useWorkers()`, `useUserRole()`.

- [ ] **Step 1: Add the hook**

In `src/hooks/useSupabase.js`, immediately after the `useLeaveQuotaUsage` function (search for `export function useLeaveQuotaUsage`, insert after its closing `}`), add:

```js

// ── Sites Progress (WORKER-safe) ──────────────────────────────

/** ข้อมูลไซท์งานแบบไม่มีตัวเลขการเงิน (สำหรับ WORKER) — site_number, name, status, billing_pct */
export function useSitesProgress() {
  return useQuery(async () => {
    const { data, error } = await supabase
      .from('sites_progress')
      .select('id, site_number, name, status, start_date, end_date, billing_pct')
      .order('site_number')
    if (error) throw error
    return data
  })
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: built, no errors.

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useSupabase.js
git commit -m "Add useSitesProgress hook for WORKER-facing site data"
```

---

### Task 3: `Dashboard.jsx` — restricted view for WORKER

**Files:**
- Modify: `src/pages/Dashboard.jsx`

**Interfaces:**
- Consumes: `useSitesProgress` (Task 2), `useUserRole` (existing, from `src/hooks/useUserRole.js`).

- [ ] **Step 1: Add imports**

Replace:

```js
import { useSites, useExpenses, useIncomes, usePaymentForecast } from '../hooks/useSupabase.js'
```

with:

```js
import { useSites, useExpenses, useIncomes, usePaymentForecast, useSitesProgress } from '../hooks/useSupabase.js'
import { useUserRole } from '../hooks/useUserRole.js'
```

- [ ] **Step 2: Read the role and branch early for WORKER**

Immediately after the line `export default function Dashboard({ navigateTo }) {`, add:

```js
  const { isAtLeast } = useUserRole()
  const canSeeFinancials = isAtLeast('ADMIN')
```

Then, immediately before the final `return (` statement of the component (search for the last `return (` in the file — the one that starts the main JSX, after all the `useMemo`/`useState` calls), insert an early return for WORKER. Find this exact block (the start of the existing return statement):

```js
  return (
    <div>
      {/* ── Period Selector ── */}
```

Replace it with:

```js
  if (!canSeeFinancials) {
    return <WorkerSiteProgress />
  }

  return (
    <div>
      {/* ── Period Selector ── */}
```

- [ ] **Step 3: Add the `WorkerSiteProgress` component**

Immediately after the `Kpi` function's closing `}` (search for `function Kpi({ label, value, sub, color = 'var(--accent)', cls = '' }) {`, find where that function ends), add:

```js

function WorkerSiteProgress() {
  const { data: sites } = useSitesProgress()
  const ongoing = (sites || []).filter(s => s.status === 'Ongoing')

  return (
    <div>
      <div style={{ color: 'var(--text3)', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 12 }}>
        ไซท์งาน Ongoing ({ongoing.length} ไซท์)
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 12 }}>
        {ongoing.map(s => (
          <div key={s.id} className="card card-body" style={{ padding: '14px 16px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
              <div>
                <div style={{ fontSize: 10.5, color: 'var(--accent)', fontWeight: 700, marginBottom: 2 }}>{s.site_number}</div>
                <div style={{ fontSize: 14, fontWeight: 700 }}>{s.name}</div>
              </div>
              <span className="badge badge-paid">{s.status}</span>
            </div>
            <div style={{ marginTop: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text2)', marginBottom: 5 }}>
                <span>ความคืบหน้างาน</span>
                <strong style={{ color: 'var(--blue)' }}>{s.billing_pct != null ? `${s.billing_pct.toFixed(1)}%` : '—'}</strong>
              </div>
              <div style={{ height: 6, borderRadius: 999, background: 'var(--bg4)', overflow: 'hidden' }}>
                <div style={{ height: '100%', borderRadius: 999, background: 'linear-gradient(90deg, var(--accent), var(--blue))', width: `${Math.min(100, s.billing_pct || 0)}%` }} />
              </div>
            </div>
          </div>
        ))}
        {!ongoing.length && <div style={{ color: 'var(--text3)', fontSize: 13 }}>ไม่มีไซท์งาน Ongoing</div>}
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Verify build**

Run: `npm run build`
Expected: built, no errors.

- [ ] **Step 5: Commit**

```bash
git add src/pages/Dashboard.jsx
git commit -m "Show restricted site-progress cards to WORKER on Dashboard"
```

---

### Task 4: `MySchedule.jsx` — WORKER's personal Assign view

**Files:**
- Create: `src/pages/assign/MySchedule.jsx`

**Interfaces:**
- Consumes: `useAssignmentsRange(from, to)`, `useWorkerOTRange(from, to)`, `useWorkers()`, `useLeaveQuotaUsage(year)`, `useUserRole()` (all existing hooks, no changes needed to any of them), `useSitesProgress` (Task 2, for resolving site names without the base `sites` table).
- Produces: default export `MySchedule({ from, to, days })` — a personal schedule list for the logged-in WORKER. Consumed by Task 5.

- [ ] **Step 1: Write the component**

`src/pages/assign/MySchedule.jsx`:

```jsx
// ============================================================
// MySchedule — WORKER's personal view of the Assign page: their
// own days/shifts/OT for the current range, plus their leave quota.
// No team grid, no cost figures — RLS also enforces this at the
// database level, this component is the matching restricted UI.
// ============================================================
import { useMemo } from 'react'
import { useUserRole } from '../../hooks/useUserRole.js'
import { useWorkers, useAssignmentsRange, useWorkerOTRange, useSitesProgress, useLeaveQuotaUsage } from '../../hooks/useSupabase.js'
import { DOW_TH } from './constants.js'

const OTHER_TYPE_LABEL = { office: 'ออฟฟิศ', leave: 'ลา', leave_sick: 'ลาป่วย', leave_personal: 'ลากิจ', holiday: 'หยุด' }

export default function MySchedule({ from, to, days }) {
  const { user } = useUserRole()
  const { data: workers } = useWorkers()
  const { data: assignments } = useAssignmentsRange(from, to)
  const { data: otEntries } = useWorkerOTRange(from, to)
  const { data: sites } = useSitesProgress()
  const now = new Date()
  const { data: leaveUsed } = useLeaveQuotaUsage(now.getFullYear())

  const me = useMemo(() => (workers || []).find(w => w.email === user?.email), [workers, user])

  const siteById = useMemo(() => {
    const m = {}
    ;(sites || []).forEach(s => { m[s.id] = s })
    return m
  }, [sites])

  const myAssignmentsByDate = useMemo(() => {
    const m = {}
    ;(assignments || []).forEach(a => {
      if (a.worker_id !== me?.id) return
      ;(m[a.date] ||= []).push(a)
    })
    return m
  }, [assignments, me])

  const myOtByDate = useMemo(() => {
    const m = {}
    ;(otEntries || []).forEach(o => {
      if (o.worker_id !== me?.id) return
      m[o.date] = o
    })
    return m
  }, [otEntries, me])

  if (!me) {
    return <div style={{ color: 'var(--text3)', fontSize: 13 }}>ไม่พบข้อมูลพนักงานที่ผูกกับบัญชีนี้</div>
  }

  const used = leaveUsed?.[me.id] || 0
  const remaining = (me.annual_leave_days || 0) - used

  return (
    <div>
      <div style={{ display: 'flex', gap: 12, marginBottom: 18, flexWrap: 'wrap' }}>
        <div className="kpi-card kpi-sm">
          <div className="kpi-label">วันลากิจใช้ไปแล้ว (ปีนี้)</div>
          <div className="kpi-value" style={{ color: used > 0 ? 'var(--red)' : 'var(--text)' }}>{used}</div>
        </div>
        <div className="kpi-card kpi-sm">
          <div className="kpi-label">คงเหลือ</div>
          <div className="kpi-value" style={{ color: remaining < 0 ? 'var(--red)' : 'var(--green)' }}>{remaining}</div>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {days.map(d => {
          const dayAssignments = myAssignmentsByDate[d.iso] || []
          const ot = myOtByDate[d.iso]
          const morning = dayAssignments.find(a => a.shift === 'morning')
          const evening = dayAssignments.find(a => a.shift === 'evening')
          const isToday = d.iso === new Date().toISOString().slice(0, 10)
          const primary = morning || evening

          return (
            <div key={d.iso} style={{
              display: 'grid', gridTemplateColumns: '56px 1fr auto', alignItems: 'center', gap: 14,
              background: 'var(--bg2)', border: `1px solid ${isToday ? 'var(--accent)' : 'var(--border)'}`,
              borderRadius: 9, padding: '12px 14px',
            }}>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 10.5, color: 'var(--text3)' }}>{DOW_TH[d.dow]}</div>
                <div style={{ fontSize: 20, fontWeight: 800, lineHeight: 1.1 }}>{d.date.getDate()}</div>
              </div>
              <div>
                {primary ? (
                  <>
                    <div style={{ fontWeight: 700, fontSize: 13.5, marginBottom: 3 }}>
                      {['site', 'factory'].includes(primary.type)
                        ? `${primary.type === 'factory' ? '🏭' : '🏗️'} ${siteById[primary.site_id]?.site_number || ''} · ${siteById[primary.site_id]?.name || '—'}`
                        : (OTHER_TYPE_LABEL[primary.type] || primary.type)}
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      {morning && <span style={{ fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: 'rgba(255,209,102,.16)', color: 'var(--yellow)' }}>เช้า</span>}
                      {evening && <span style={{ fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: 'rgba(108,99,255,.18)', color: '#b8b0ff' }}>บ่าย</span>}
                    </div>
                  </>
                ) : (
                  <div style={{ color: 'var(--text3)' }}>— ไม่มีงาน —</div>
                )}
              </div>
              {ot && (
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--green)', background: 'rgba(0,212,170,.13)', borderRadius: 999, padding: '5px 10px', whiteSpace: 'nowrap' }}>
                  ⚡ OT {ot.ot_hours} ชม.
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: built, no errors.

- [ ] **Step 3: Commit**

```bash
git add src/pages/assign/MySchedule.jsx
git commit -m "Add MySchedule component for WORKER's personal Assign view"
```

---

### Task 5: `Assign.jsx` — wire in the restricted WORKER view

**Files:**
- Modify: `src/pages/Assign.jsx`

**Interfaces:**
- Consumes: `MySchedule` (Task 4), `isAtLeast` (already imported/used in this file — confirm before adding a duplicate import).

- [ ] **Step 1: Confirm `canEdit`/`isAtLeast` already exists**

`src/pages/Assign.jsx` already has (do not re-add):
```js
  const { isAtLeast } = useUserRole()
  const canEdit = isAtLeast('ADMIN')
```
If this exact pattern isn't present under a different name, stop and report — the rest of this task assumes `canEdit` is a boolean already in scope in the component body.

- [ ] **Step 2: Add the import**

Add this import line near the other `./assign/*` component imports (e.g. next to `import GridView from './assign/GridView.jsx'`):

```js
import MySchedule from './assign/MySchedule.jsx'
```

- [ ] **Step 3: Branch the main view render for non-ADMIN**

Locate:

```jsx
      {/* ── View ── */}
      {view === 'day' ? (
        <DayView dayIso={from} assignments={assignments} otEntries={otEntries} sites={sites} travelRate={travelRate} onEditHalf={openCell} />
      ) : (
        <GridView days={days} workers={workers} cellLookup={cellLookup} otLookup={otLookup} holidayDates={holidayDates} onEditHalf={openCell} cellH={cellH} variant={view} />
      )}

      {/* ── Labor + Travel cost per site ── */}
      <div style={{ marginBottom: 8, color: 'var(--text3)', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1 }}>
        ค่าแรง + ค่าเดินทาง ต่อไซท์งาน (ทุกช่วงเวลา)
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12, marginBottom: 24 }}>
```

Replace with:

```jsx
      {/* ── View ── */}
      {!canEdit ? (
        <MySchedule from={from} to={to} days={days} />
      ) : view === 'day' ? (
        <DayView dayIso={from} assignments={assignments} otEntries={otEntries} sites={sites} travelRate={travelRate} onEditHalf={openCell} />
      ) : (
        <GridView days={days} workers={workers} cellLookup={cellLookup} otLookup={otLookup} holidayDates={holidayDates} onEditHalf={openCell} cellH={cellH} variant={view} />
      )}

      {/* ── Labor + Travel cost per site (ADMIN+ only — reveals per-worker cost) ── */}
      {canEdit && (
      <>
      <div style={{ marginBottom: 8, color: 'var(--text3)', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1 }}>
        ค่าแรง + ค่าเดินทาง ต่อไซท์งาน (ทุกช่วงเวลา)
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12, marginBottom: 24 }}>
```

Then find the end of that cost section — locate:

```jsx
        {!costBySite.length && <div style={{ color: 'var(--text3)', fontSize: 13 }}>ยังไม่มีข้อมูล assignment</div>}
      </div>
```

Replace with:

```jsx
        {!costBySite.length && <div style={{ color: 'var(--text3)', fontSize: 13 }}>ยังไม่มีข้อมูล assignment</div>}
      </div>
      </>
      )}
```

Note: the `{canEdit && <button ...>+ Assign งาน</button>}` and `{canEdit && <button ...>⚡ Assign OT</button>}` buttons earlier in this file are already correctly gated — no change needed there.

- [ ] **Step 4: Verify build**

Run: `npm run build`
Expected: built, no errors.

- [ ] **Step 5: Commit**

```bash
git add src/pages/Assign.jsx
git commit -m "Show MySchedule instead of team grid + cost breakdown for non-ADMIN"
```

---

### Task 6: Finalize the RLS policy migration (draft — do not apply yet)

**Files:**
- Modify: `supabase/migrations/2026-08-15-01-enable-rls.sql` (already exists on `main` as a draft, carried into this branch)

**Interfaces:**
- Produces: the final, ready-to-apply RLS policy SQL. This task only edits the file — **do not run `apply_migration` in this task**, that happens in Task 8 after the human has reviewed the frontend changes from Tasks 1-5 running against real data.

- [ ] **Step 1: Read the current draft**

Read `supabase/migrations/2026-08-15-01-enable-rls.sql` in full — it already has the `current_user_role()`/`is_admin_or_owner()`/`is_owner()` helper functions, the `salary_records` and `user_roles` policies (these are correct as-is per the confirmed access model — no changes needed to those two sections), and a "Tier 1: staff_full_access" block that is now **too permissive** and must be split per the refined access model in this plan's Global Constraints table.

- [ ] **Step 2: Replace the over-permissive Tier 1 block**

Find this block (the `DO $$ ... FOREACH t IN ARRAY ARRAY['sites','expense_categories','expenses','incomes', 'workers','worker_assignments','worker_ot', 'company_holidays','app_settings'] ...`):

```sql
-- ── Tier 1: any authenticated staff member reads + writes freely ──
-- (matches current behavior exactly — see design principle above)
-- sites, expense_categories, expenses, incomes, workers,
-- worker_assignments, worker_ot, company_holidays, app_settings
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['sites','expense_categories','expenses','incomes',
                            'workers','worker_assignments','worker_ot',
                            'company_holidays','app_settings']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY staff_full_access ON %I FOR ALL TO authenticated USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;
```

Replace it with:

```sql
-- ── ADMIN+ only: financial base tables (WORKER reads sites_progress
-- view instead — see Task 1/2/3 of the implementation plan) ──
-- sites, expense_categories, expenses, incomes, app_settings
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['sites','expense_categories','expenses','incomes','app_settings']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY admin_full_access ON %I FOR ALL TO authenticated USING (is_admin_or_owner()) WITH CHECK (is_admin_or_owner())', t);
  END LOOP;
END $$;

-- ── company_holidays: any staff member reads; only ADMIN+ writes ──
ALTER TABLE company_holidays ENABLE ROW LEVEL SECURITY;
CREATE POLICY staff_reads ON company_holidays FOR SELECT TO authenticated USING (true);
CREATE POLICY admin_writes_holidays ON company_holidays FOR INSERT TO authenticated WITH CHECK (is_admin_or_owner());
CREATE POLICY admin_updates_holidays ON company_holidays FOR UPDATE TO authenticated USING (is_admin_or_owner()) WITH CHECK (is_admin_or_owner());
CREATE POLICY admin_deletes_holidays ON company_holidays FOR DELETE TO authenticated USING (is_admin_or_owner());

-- ── workers: WORKER reads only their own row; ADMIN+ reads/writes all ──
ALTER TABLE workers ENABLE ROW LEVEL SECURITY;
CREATE POLICY worker_reads_own_profile ON workers FOR SELECT TO authenticated
  USING (is_admin_or_owner() OR email = auth.email());
CREATE POLICY admin_writes_workers ON workers FOR INSERT TO authenticated WITH CHECK (is_admin_or_owner());
CREATE POLICY admin_updates_workers ON workers FOR UPDATE TO authenticated USING (is_admin_or_owner()) WITH CHECK (is_admin_or_owner());
CREATE POLICY admin_deletes_workers ON workers FOR DELETE TO authenticated USING (is_admin_or_owner());

-- ── worker_assignments / worker_ot: WORKER reads only their own rows,
-- cannot self-assign (INSERT/UPDATE/DELETE ADMIN+ only) ──
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['worker_assignments','worker_ot']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY worker_reads_own ON %I FOR SELECT TO authenticated
      USING (is_admin_or_owner() OR worker_id IN (SELECT id FROM workers WHERE email = auth.email()))$p$, t);
    EXECUTE format('CREATE POLICY admin_inserts ON %I FOR INSERT TO authenticated WITH CHECK (is_admin_or_owner())', t);
    EXECUTE format('CREATE POLICY admin_updates ON %I FOR UPDATE TO authenticated USING (is_admin_or_owner()) WITH CHECK (is_admin_or_owner())', t);
    EXECUTE format('CREATE POLICY admin_deletes ON %I FOR DELETE TO authenticated USING (is_admin_or_owner())', t);
  END LOOP;
END $$;
```

- [ ] **Step 3: Confirm the rest of the file is unchanged**

The "Tier 2: ADMIN+ only" block (clients/suppliers/labor_subcontractors/labor_contracts/labor_payments), "Tier 3" (calendar_sync/site_phases), `audit_logs`, `salary_records`, and `user_roles` sections all already match the confirmed access model — leave them exactly as they are in the existing draft.

- [ ] **Step 4: Update the file's header comment**

Update the comment block at the top of the file (the one starting `-- Enable Row Level Security across all 18...`) to reflect the refined design: WORKER gets read-own-row access to `workers`/`worker_assignments`/`worker_ot`/`salary_records`, read-all access to `company_holidays`/`user_roles`, no access to `sites`/`expenses`/`incomes`/`expense_categories`/`app_settings`/the Tier 2/3 tables, and reads site info exclusively through the `sites_progress` view (Task 1) which this migration does not touch (it's a separate, already-additive migration).

- [ ] **Step 5: Verify the SQL is syntactically sound**

This cannot be applied yet (see Task 8), but sanity-check it. **Note:** a plain `grep -c` undercounts, because several `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` statements are generated inside `DO $$ ... FOREACH t IN ARRAY [...] LOOP ... END LOOP; END $$;` blocks, where the literal string appears once per loop regardless of how many tables that loop covers. Verify correctly by manually enumerating every `FOREACH ... ARRAY[...]` list plus every standalone `ALTER TABLE` statement in the file and counting the distinct table names — expect exactly 18 (one per previously-unprotected table: sites, expense_categories, expenses, incomes, app_settings, company_holidays, workers, worker_assignments, worker_ot, clients, suppliers, labor_subcontractors, labor_contracts, labor_payments, calendar_sync, site_phases, audit_logs, salary_records — `user_roles` already has RLS enabled from before, this migration only replaces its policies, not its `ENABLE ROW LEVEL SECURITY` statement). A raw `grep -c` on this file will show `8` (one per loop/standalone-statement, not per table) — that is expected and not a sign of missing coverage.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/2026-08-15-01-enable-rls.sql
git commit -m "Refine RLS draft: workers/assignments/OT read-own for WORKER, financial tables ADMIN+ only"
```

---

### Task 7: Fix RLS-bypassing views (security_invoker)

**Files:**
- Create: `supabase/migrations/2026-08-15-03-view-security-invoker.sql`
- Modify: `supabase/schema.sql`

**Interfaces:**
- Depends on: Task 6 (the base-table RLS policies these views must now respect).
- Produces: 9 views that respect RLS on their underlying base tables. Does NOT touch `sites_progress` (Task 1), which must keep its owner-rights bypass by design.

**Why this task exists (discovered by the whole-branch review, not anticipated when Tasks 1-6 were written):** Postgres views default to running with the view *owner's* privileges (`security_invoker = false`), not the querying user's — this has been true since views existed, and Postgres 15+ added the `security_invoker` reloption to opt out of it, defaulting to off for backward compatibility. This project's Supabase instance runs Postgres 17. None of the 10 pre-existing views in this schema set `security_invoker`, so RLS on a base table (e.g. `workers`, from Task 6) is **completely invisible** to any query that goes through a view built on that table instead of the table directly — and `src/hooks/useSupabase.js`'s `useWorkers()` queries `workers_with_rate` (a view), not `workers` (the base table). Since `MySchedule.jsx` (Task 4) calls `useWorkers()` on the WORKER-reachable Assign page, every WORKER's browser would still download every colleague's `monthly_salary`, `daily_rate`, and `social_security_amount` even after Task 6's RLS goes live — Task 6's core security guarantee would be silently defeated by this one hook, and the same gap exists for every other financial view (`site_financial_summary`, `expenses_view`, `incomes_view`, `labor_cost_by_site`, `ot_cost_by_site`, `site_travel_cost`, `payment_forecast`, `labor_contract_summary`), all directly queryable via the anon key regardless of what the current frontend happens to call.

The fix is `security_invoker = true` on each of those 9 views, which makes Postgres re-check the *querying user's own* privileges (and therefore RLS) against the view's underlying tables, instead of the view owner's. This requires **zero frontend code changes** — `useWorkers()` keeps querying `workers_with_rate` exactly as before; the view itself now correctly inherits `workers`' RLS.

**`sites_progress` must NOT get this flag.** It's built as `SELECT ... FROM site_financial_summary`, and WORKER has zero base-table RLS access to `site_financial_summary`'s own sources (`sites`, `expenses`, `incomes`). `sites_progress` deliberately relies on running as its owner (which bypasses RLS) so a WORKER session can read it at all — that's exactly what makes Task 3's restricted Dashboard work. Postgres resolves this correctly: `security_invoker` is checked independently at each view layer using whatever the *current effective role* is at that point in the plan. Since `sites_progress` stays at the default (`security_invoker = false`), everything it internally touches — including `site_financial_summary`, even after `site_financial_summary` itself gets `security_invoker = true` — is evaluated as `sites_progress`'s own owner, not as the original human user, because `sites_progress` never delegates back to the invoking session. Only a *direct* top-level query against `site_financial_summary` (bypassing `sites_progress`) will actually re-check the querying user's own RLS.

- [ ] **Step 1: Write the migration**

`supabase/migrations/2026-08-15-03-view-security-invoker.sql`:

```sql
-- Make every financial/salary view respect RLS on its underlying base
-- tables, by re-checking the QUERYING user's own privileges instead of
-- the view owner's (Postgres views default to owner-rights, which is
-- why Task 6's base-table RLS alone doesn't actually protect anything
-- queried through these views — see Task 7 of
-- docs/superpowers/plans/2026-08-15-rls-worker-view.md for the full
-- explanation).
--
-- sites_progress is DELIBERATELY EXCLUDED — it must keep owner-rights
-- so WORKER (who has zero base-table access to sites/expenses/incomes)
-- can still read it. Do not add security_invoker to that view.
ALTER VIEW expenses_view          SET (security_invoker = true);
ALTER VIEW incomes_view           SET (security_invoker = true);
ALTER VIEW site_financial_summary SET (security_invoker = true);
ALTER VIEW payment_forecast       SET (security_invoker = true);
ALTER VIEW labor_cost_by_site     SET (security_invoker = true);
ALTER VIEW ot_cost_by_site        SET (security_invoker = true);
ALTER VIEW site_travel_cost       SET (security_invoker = true);
ALTER VIEW workers_with_rate      SET (security_invoker = true);
ALTER VIEW labor_contract_summary SET (security_invoker = true);
```

- [ ] **Step 2: Apply the migration**

Use `mcp__plugin_supabase_supabase__apply_migration` with `project_id: yyzbgdmgyvvypfcjuhtr`, `name: view_security_invoker`, and the full SQL from Step 1 as `query`. This is safe to apply immediately regardless of whether Task 6's RLS is live yet — `security_invoker = true` on a view whose underlying tables have NO RLS enabled (the current state, since Task 6 hasn't been applied) has no observable effect at all (there's no RLS to newly respect), so applying this now is inert and low-risk, and removes one variable from Task 8's live-RLS-apply step.

- [ ] **Step 3: Verify the flag is set correctly on all 9, and NOT on `sites_progress`**

Run via `execute_sql`:
```sql
SELECT c.relname, c.reloptions
FROM pg_class c
WHERE c.relkind = 'v' AND c.relnamespace = 'public'::regnamespace
ORDER BY c.relname;
```
Expected: `expenses_view`, `incomes_view`, `site_financial_summary`, `payment_forecast`, `labor_cost_by_site`, `ot_cost_by_site`, `site_travel_cost`, `workers_with_rate`, `labor_contract_summary` each show `{security_invoker=true}` in `reloptions`. `sites_progress` must show `reloptions` as `NULL` (or otherwise absent the flag) — if `sites_progress` shows `security_invoker=true`, STOP: that means Task 3's Dashboard will break once Task 6's RLS goes live, and this migration must be corrected before proceeding.

- [ ] **Step 4: Functional check — this migration alone should change nothing yet**

Since Task 6's RLS isn't live yet, confirm the app still works exactly as before for every role (quick spot check, not the full Task 8 checklist):
```sql
SELECT count(*) FROM workers_with_rate;
SELECT count(*) FROM site_financial_summary;
```
Expected: same row counts as before this migration (12 and however many sites exist) — `security_invoker` with no RLS on the underlying tables yet is a no-op, this just confirms the `ALTER VIEW` didn't break the view definitions themselves.

- [ ] **Step 5: Add the same flags to `supabase/schema.sql`**

For each of the 9 views, change `CREATE OR REPLACE VIEW <name> AS` to `CREATE OR REPLACE VIEW <name> WITH (security_invoker = true) AS` in `supabase/schema.sql` (search for each `CREATE OR REPLACE VIEW` statement — they're all in the `-- VIEWS` section). Leave `sites_progress`'s `CREATE OR REPLACE VIEW sites_progress AS` unchanged (no `WITH (...)` clause).

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/2026-08-15-03-view-security-invoker.sql supabase/schema.sql
git commit -m "Set security_invoker on financial views so base-table RLS actually applies"
```

---

### Task 8: Manual verification, then apply RLS to production

**Files:** none (verification + one live database action)

This task requires the human, both for the UI click-through (no browser tool in this environment) and for the final production RLS apply (a live security change to a database real people use for payroll right now — must not be run unattended).

- [ ] **Step 1: Start the dev server and log in as different roles**

Run: `npm run dev`. Log in as a WORKER-role account, then separately as an ADMIN-role account (or use the User Management page to temporarily check both, if only one test account exists).

- [ ] **Step 2: Verify the Dashboard for WORKER**

As WORKER: confirm the Dashboard shows site cards with name/status/progress bar, no baht figures anywhere, no KPI row, no chart, no ongoing-sites table with money columns.

As ADMIN/OWNER: confirm the Dashboard is unchanged from before this plan (full KPIs, chart, table with all money columns).

- [ ] **Step 3: Verify the Assign page for WORKER**

As WORKER: confirm the Assign page shows "ตารางงานของฉัน" (MySchedule) — own days only, own shifts, own OT hours, the leave-quota cards at the top, no team grid, no cost-per-site section, no "+ Assign งาน"/"⚡ Assign OT" buttons.

As ADMIN/OWNER: confirm the Assign page is unchanged (full team grid, cost breakdown, both buttons).

- [ ] **Step 4: Verify leave quota numbers are correct**

Pick a WORKER account with at least one `leave_personal` assignment this year. Confirm the "วันลากิจใช้ไปแล้ว" number on MySchedule matches what HR tab (as ADMIN) shows for that same worker's "ใช้ไปแล้ว (ปีนี้)" column.

- [ ] **Step 5: Apply the RLS migration to production**

Only after Steps 2-4 all pass. Use `mcp__plugin_supabase_supabase__apply_migration` with `project_id: yyzbgdmgyvvypfcjuhtr`, `name: enable_rls`, and the full contents of `supabase/migrations/2026-08-15-01-enable-rls.sql` as `query`.

- [ ] **Step 6: Re-verify immediately after applying**

Repeat Steps 2-4 exactly. Also spot-check that anon (logged-out) access is now blocked — both on the base tables AND on the views (Task 7 made the views respect RLS; this confirms it actually held once RLS is live, not just when the views were inert):
```sql
SET ROLE anon;
SELECT * FROM sites LIMIT 1;
SELECT * FROM salary_records LIMIT 1;
SELECT * FROM workers_with_rate LIMIT 1;
SELECT * FROM site_financial_summary LIMIT 1;
RESET ROLE;
```
Expected: all four return 0 rows (not an error — RLS silently filters, it doesn't throw).

Then confirm `sites_progress` is the one deliberate exception — it must still return rows even as `anon` (this is what makes the WORKER Dashboard work at all):
```sql
SET ROLE anon;
SELECT count(*) FROM sites_progress;
RESET ROLE;
```
Expected: a nonzero count (or at least no error) — if this returns 0 rows or errors, Task 3's Dashboard will show an empty state for every WORKER; check that `sites_progress` genuinely was excluded from Task 7's `security_invoker` migration.

If anything in Step 6 breaks that worked in Step 2-4, roll back immediately for the specific table:
```sql
ALTER TABLE <table> DISABLE ROW LEVEL SECURITY;
```

- [ ] **Step 7: Merge to main**

Once Step 6 passes cleanly, use the `finishing-a-development-branch` skill to merge this branch to `main` and push.
