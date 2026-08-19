# Retention Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each site have its own client-retention period, compute a due date from it, surface upcoming due dates on the Dashboard, and add a dedicated Retention tab to view/release status per site.

**Architecture:** Two new nullable columns and one new release-tracking pair on `sites`, one new read-only view (`site_retention_summary`) aggregating retention held per site with a computed due date, one shared React hook consuming that view, a new field in the existing Sites form, a new KPI card on Dashboard, and a new lazy-loaded top-level tab.

**Tech Stack:** React 18 + Vite (existing app), Supabase/Postgres (existing app), no new dependencies.

## Global Constraints

- Do not modify the labor subcontractor retention system (`labor_contracts`, `labor_payments`, `contractor_summary`'s hardcoded 6-month logic) — unrelated, out of scope, must stay untouched.
- `default_retention_period_days` has no default value and is nullable — never backfill a guessed value onto existing sites.
- Retention is tracked and released as one lump sum per site, anchored to `sites.end_date` — not per income row, no partial-release tracking.
- No automated reminders (email/LINE/etc.) — the Dashboard KPI card is the entire notification mechanism.
- `npm test` (25 existing Vitest tests) must continue passing unmodified throughout.
- Every view in this app since 2026-08-18 uses `WITH (security_invoker = true)` — required here too (a view without it runs as its owner, bypassing the querying user's RLS — this exact mistake caused a real cross-tenant data leak earlier in this project's history).

---

### Task 1: Database migration, view, and shared hook

**Files:**
- Create: `supabase/migrations/2026-08-19-02-site-retention-tracking.sql`
- Modify: `supabase/schema.sql` (mirror the migration, same convention as every prior migration in this repo)
- Modify: `src/hooks/useSupabase.js`

**Interfaces:**
- Consumes: nothing from other tasks (first task).
- Produces: Postgres view `site_retention_summary` with columns `site_id, site_number, name, end_date, default_retention_period_days, retention_released, retention_released_date, total_retention, due_date`. React hook `useSiteRetentionSummary()` (no arguments) returning `{ data, loading, error, refetch }` where `data` is an array of rows shaped exactly like the view's columns (camelCase is NOT applied — Supabase returns raw snake_case column names, e.g. `row.total_retention`, `row.due_date`, `row.retention_released`). Tasks 3 and 4 both call this hook directly.

- [ ] **Step 1: Write the migration file**

Create `supabase/migrations/2026-08-19-02-site-retention-tracking.sql`:

```sql
-- Client retention (เงินประกันผลงาน) withheld from income/billing already has
-- an amount (incomes.retention) but no due date and no release tracking.
-- This is the client-side equivalent of the existing labor subcontractor
-- retention system (labor_contracts/labor_payments), which hardcodes its
-- due date as site.end_date + 6 months and is NOT touched by this migration
-- -- separate money flow, separate system.
--
-- default_retention_period_days has no default -- a wrong guessed due date
-- on financial data is worse than no due date, so existing sites simply
-- have no computed due date until someone sets this explicitly.
ALTER TABLE sites ADD COLUMN default_retention_period_days INTEGER;
ALTER TABLE sites ADD COLUMN retention_released BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE sites ADD COLUMN retention_released_date DATE;

-- security_invoker = true is required on every view in this app -- a view
-- without it runs as its owner (a superuser), bypassing the querying
-- user's RLS entirely. This exact mistake caused a real cross-tenant data
-- leak in sites_progress (see 2026-08-18-01-fix-sites-progress-cross-tenant-leak.sql).
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
    -- due_date doesn't carry a spurious 00:00:00 time component.
    THEN (s.end_date + (s.default_retention_period_days || ' days')::INTERVAL)::DATE
    ELSE NULL
  END AS due_date
FROM sites s
LEFT JOIN incomes i ON i.site_id = s.id
GROUP BY s.id, s.site_number, s.name, s.end_date, s.default_retention_period_days,
         s.retention_released, s.retention_released_date;
```

- [ ] **Step 2: Apply the migration to the live database**

Use the Supabase MCP tool `mcp__plugin_supabase_supabase__apply_migration` with `project_id` set to this project's id (check `.env`'s `VITE_SUPABASE_URL` for the project ref, or ask if not visible), `name: "site_retention_tracking"`, and `query` set to the exact SQL from Step 1 (both `ALTER TABLE` statements and the `CREATE VIEW` statement, in that order, in one call).

After applying, verify with `mcp__plugin_supabase_supabase__execute_sql`:

```sql
SELECT column_name FROM information_schema.columns
WHERE table_name = 'sites' AND column_name IN
  ('default_retention_period_days', 'retention_released', 'retention_released_date');
```

Expected: 3 rows returned.

```sql
SELECT * FROM site_retention_summary LIMIT 1;
```

Expected: succeeds with no error (confirms the view is valid against the real `sites`/`incomes` tables), `total_retention` and `due_date` present as columns.

- [ ] **Step 3: Mirror the migration into schema.sql**

In `supabase/schema.sql`, find the `sites` table definition (search for `CREATE TABLE sites`). Immediately after the existing line:

```sql
  default_retention_pct     NUMERIC DEFAULT 0,
```

add:

```sql
  default_retention_period_days INTEGER,               -- client retention due date = end_date + this many days; NULL until set explicitly
  retention_released         BOOLEAN NOT NULL DEFAULT false,
  retention_released_date    DATE,
```

Then find where other views are defined in `schema.sql` (search for `WITH (security_invoker = true) AS` to see the existing convention and pick a location near other site-related views, e.g. after `site_financial_summary`). Add:

```sql
-- Client retention due-date tracking -- see
-- 2026-08-19-02-site-retention-tracking.sql. Deliberately separate from
-- the labor subcontractor retention system (contractor_summary), which
-- hardcodes site.end_date + 6 months and is untouched by this feature.
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
    THEN (s.end_date + (s.default_retention_period_days || ' days')::INTERVAL)::DATE
    ELSE NULL
  END AS due_date
FROM sites s
LEFT JOIN incomes i ON i.site_id = s.id
GROUP BY s.id, s.site_number, s.name, s.end_date, s.default_retention_period_days,
         s.retention_released, s.retention_released_date;
```

- [ ] **Step 4: Add the shared hook**

In `src/hooks/useSupabase.js`, find the `useSites`/`useSite` section (search for `// ── Sites ──`). Add immediately after `useSite`:

```js
/**
 * site_retention_summary: one row per site with end_date/
 * default_retention_period_days/retention_released state and the summed
 * retention amount held. Sorted unreleased-first (retention_released
 * ascending puts false before true), then soonest due date first within
 * each group (nulls last, since a site with no period set has nothing
 * useful to sort by).
 */
export function useSiteRetentionSummary() {
  return useQuery(async () => {
    const { data, error } = await supabase
      .from('site_retention_summary')
      .select('*')
      .order('retention_released', { ascending: true })
      .order('due_date', { ascending: true, nullsFirst: false })
    if (error) throw error
    return data
  })
}
```

- [ ] **Step 5: Build and test**

```bash
npm run build
npm test
```

Expected: build succeeds with no errors, `Tests 25 passed (25)` (this task adds no new JS logic requiring its own test — `useSiteRetentionSummary` is a thin wrapper around `useQuery`, already covered by this app's established pattern of verifying data hooks via manual/build-level checks, not unit tests, since there's no Supabase-mocking test infra in this repo).

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/2026-08-19-02-site-retention-tracking.sql supabase/schema.sql src/hooks/useSupabase.js
git commit -m "$(cat <<'EOF'
feat: add site retention due-date tracking (schema + view + hook)

New sites columns: default_retention_period_days (nullable, no default
-- never guess a due date for existing sites), retention_released,
retention_released_date. New view site_retention_summary sums
incomes.retention per site and computes due_date = end_date + period
(NULL if either input is missing).

Deliberately separate from the existing labor subcontractor retention
system (labor_contracts/labor_payments/contractor_summary's hardcoded
6-month logic) -- different money flow, not touched by this change.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Sites form — set the retention period per site

**Files:**
- Modify: `src/pages/Sites.jsx`

**Interfaces:**
- Consumes: nothing from other tasks directly (writes to the `sites` table columns Task 1 created; doesn't call `useSiteRetentionSummary`).
- Produces: nothing consumed by later tasks (Tasks 3/4 read the resulting data via the view, not via this form directly).

- [ ] **Step 1: Add the field to EMPTY_FORM**

In `src/pages/Sites.jsx`, find:

```js
const EMPTY_FORM = {
  name: '', client_id: '', location: '',
  distance_km: '', map_url: '',
  status: 'Ongoing', start_date: '', end_date: '',
  has_vat: true, contract_value_no_vat: '', notes: '',
  default_vat_pct: 7, default_tax_withheld_pct: 3, default_retention_pct: 0,
  ...Object.fromEntries(COST_TYPES.map(t => [t.key, '']))
}
```

Change the `default_retention_pct` line to add the new field right after it:

```js
  default_vat_pct: 7, default_tax_withheld_pct: 3, default_retention_pct: 0,
  default_retention_period_days: '',
```

- [ ] **Step 2: Add the input to the form**

Find this block (the "Income defaults" `form-grid-3` section):

```jsx
          <div className="form-grid-3">
            <div>
              <label className="label">VAT (%)</label>
              <input type="number" className="input input-sm" min="0" step="0.01"
                value={form.default_vat_pct} onChange={e => set('default_vat_pct', e.target.value)} placeholder="7" />
            </div>
            <div>
              <label className="label">Tax ถูกหัก (%)</label>
              <input type="number" className="input input-sm" min="0" step="0.01"
                value={form.default_tax_withheld_pct} onChange={e => set('default_tax_withheld_pct', e.target.value)} placeholder="3" />
            </div>
            <div>
              <label className="label">Retention (%)</label>
              <input type="number" className="input input-sm" min="0" step="0.01"
                value={form.default_retention_pct} onChange={e => set('default_retention_pct', e.target.value)} placeholder="0" />
            </div>
          </div>
```

Replace it with (changes `form-grid-3` to `form-grid-4` to fit the new field, adds the period input as the 4th):

```jsx
          <div className="form-grid-4">
            <div>
              <label className="label">VAT (%)</label>
              <input type="number" className="input input-sm" min="0" step="0.01"
                value={form.default_vat_pct} onChange={e => set('default_vat_pct', e.target.value)} placeholder="7" />
            </div>
            <div>
              <label className="label">Tax ถูกหัก (%)</label>
              <input type="number" className="input input-sm" min="0" step="0.01"
                value={form.default_tax_withheld_pct} onChange={e => set('default_tax_withheld_pct', e.target.value)} placeholder="3" />
            </div>
            <div>
              <label className="label">Retention (%)</label>
              <input type="number" className="input input-sm" min="0" step="0.01"
                value={form.default_retention_pct} onChange={e => set('default_retention_pct', e.target.value)} placeholder="0" />
            </div>
            <div>
              <label className="label">ระยะเวลา retention (วัน)</label>
              <input type="number" className="input input-sm" min="0" step="1"
                value={form.default_retention_period_days} onChange={e => set('default_retention_period_days', e.target.value)} placeholder="เช่น 90" />
            </div>
          </div>
```

- [ ] **Step 3: Save the field**

Find in `handleSave`:

```js
        default_retention_pct:     form.default_retention_pct === '' ? null : parseFloat(form.default_retention_pct),
```

Add immediately after it:

```js
        default_retention_period_days: form.default_retention_period_days === '' ? null : parseInt(form.default_retention_period_days, 10),
```

- [ ] **Step 4: Build and test**

```bash
npm run build
npm test
```

Expected: build succeeds, `Tests 25 passed (25)`.

- [ ] **Step 5: Manual verification**

Run `npm run preview -- --port 4174`, open the app, log in, go to ไซท์งาน tab, edit an existing site (one with an `end_date` set), enter a number (e.g. `90`) in the new "ระยะเวลา retention (วัน)" field, save. Then verify via `mcp__plugin_supabase_supabase__execute_sql`:

```sql
SELECT name, end_date, default_retention_period_days, due_date
FROM site_retention_summary WHERE default_retention_period_days = 90 LIMIT 1;
```

Expected: `due_date` is exactly `end_date + 90 days`.

- [ ] **Step 6: Commit**

```bash
git add src/pages/Sites.jsx
git commit -m "$(cat <<'EOF'
feat: add retention period field to the Sites form

Sets sites.default_retention_period_days (added in the prior commit's
migration) -- the number of days after a site's end_date that its
client retention is due back. Placed next to the existing Retention
(%) field, since both configure the same concept. Left blank by
default -- saves as NULL, matching the migration's "never guess a
due date" decision.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Dashboard KPI card

**Files:**
- Modify: `src/pages/Dashboard.jsx`
- Modify: `src/index.css`

**Interfaces:**
- Consumes: `useSiteRetentionSummary()` from Task 1 (`src/hooks/useSupabase.js`), returning `data` as an array of rows with `total_retention` (number), `retention_released` (boolean), `due_date` (string `'YYYY-MM-DD'` or `null`), `site_id`, `name`.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Add the CSS grid variant**

In `src/index.css`, find:

```css
.kpi-grid-5 { grid-template-columns: repeat(5, 1fr); }
```

Add immediately after it:

```css
.kpi-grid-6 { grid-template-columns: repeat(6, 1fr); }
```

Find:

```css
@media (max-width: 900px) {
  .kpi-grid-5 { grid-template-columns: repeat(3, 1fr); }
  .kpi-grid-4 { grid-template-columns: repeat(2, 1fr); }
```

Change to:

```css
@media (max-width: 900px) {
  .kpi-grid-6 { grid-template-columns: repeat(3, 1fr); }
  .kpi-grid-5 { grid-template-columns: repeat(3, 1fr); }
  .kpi-grid-4 { grid-template-columns: repeat(2, 1fr); }
```

Find:

```css
@media (max-width: 600px) {
  .kpi-grid-5, .kpi-grid-4, .kpi-grid-3 { grid-template-columns: 1fr 1fr; }
```

Change to:

```css
@media (max-width: 600px) {
  .kpi-grid-6, .kpi-grid-5, .kpi-grid-4, .kpi-grid-3 { grid-template-columns: 1fr 1fr; }
```

- [ ] **Step 2: Make the Kpi component support an optional click**

In `src/pages/Dashboard.jsx`, find:

```jsx
function Kpi({ label, value, sub, color = 'var(--accent)', cls = '' }) {
  return (
    <div className={`kpi-card ${cls}`}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value" style={{ color }}>{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  )
}
```

Replace with:

```jsx
function Kpi({ label, value, sub, color = 'var(--accent)', cls = '', onClick }) {
  return (
    <div
      className={`kpi-card ${cls}`}
      onClick={onClick}
      style={onClick ? { cursor: 'pointer' } : undefined}
    >
      <div className="kpi-label">{label}</div>
      <div className="kpi-value" style={{ color }}>{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  )
}
```

(`onClick` defaults to `undefined`, so every existing `<Kpi .../>` call without it is completely unaffected -- no `onClick` handler attached, no cursor style.)

- [ ] **Step 3: Import the hook and compute the due-soon summary**

Find:

```js
import { useSites, useExpenses, useIncomes, usePaymentForecast, useSitesProgress } from '../hooks/useSupabase.js'
```

Change to:

```js
import { useSites, useExpenses, useIncomes, usePaymentForecast, useSitesProgress, useSiteRetentionSummary } from '../hooks/useSupabase.js'
```

Find `export default function Dashboard({ navigateTo }) {` and, in its body (near the other data hooks — search for `const { data: sites } = useSites()` or similar to place it alongside), add:

```js
  const { data: retentionSummary } = useSiteRetentionSummary()

  const retentionDueSoon = useMemo(() => {
    const in30Days = new Date()
    in30Days.setDate(in30Days.getDate() + 30)
    const todayIso = new Date().toISOString().slice(0, 10)
    const in30IsoDate = in30Days.toISOString().slice(0, 10)
    const matching = (retentionSummary || []).filter(r =>
      r.total_retention > 0 &&
      !r.retention_released &&
      r.due_date != null &&
      r.due_date <= in30IsoDate
    )
    return {
      count: matching.length,
      total: matching.reduce((sum, r) => sum + r.total_retention, 0),
    }
  }, [retentionSummary])
```

(`useMemo` is already imported in this file — confirmed via the existing `import { useState, useMemo } from 'react'` line.)

- [ ] **Step 4: Add the KPI card**

Find:

```jsx
      {/* ── KPI Cards ── */}
      <div className="kpi-grid kpi-grid-5" style={{ marginBottom: 20 }}>
        <Kpi label="รายรับรวม"       value={fmtShort(totalIncome)}  sub={`${fmt(totalIncome)} บาท`}   cls="green" color="var(--green)" />
        <Kpi label="รายจ่ายรวม"      value={fmtShort(totalExpense)} sub={`${fmt(totalExpense)} บาท`}  cls="red"   color="var(--red)" />
        <Kpi label="กำไรเบื้องต้น"   value={fmtShort(profit)}       sub={profit >= 0 ? `+${(profit/totalIncome*100).toFixed(1)}%` : 'ขาดทุน'} cls={profit>=0?'green':'red'} color={profit>=0?'var(--green)':'var(--red)'} />
        <Kpi label={`ต้องชำระ ${format(new Date(), 'MMM yy', {locale:th})}`}
             value={fmtShort(dueThisMonth)} sub="ยอดค้างจ่ายเดือนนี้" cls="yellow" color="var(--yellow)" />
        <Kpi label={`ต้องชำระ ${format(addMonths(new Date(),1), 'MMM yy', {locale:th})}`}
             value={fmtShort(dueNextMonth)} sub="ยอดค้างจ่ายเดือนหน้า" cls="blue" color="var(--blue)" />
      </div>
```

Replace with:

```jsx
      {/* ── KPI Cards ── */}
      <div className="kpi-grid kpi-grid-6" style={{ marginBottom: 20 }}>
        <Kpi label="รายรับรวม"       value={fmtShort(totalIncome)}  sub={`${fmt(totalIncome)} บาท`}   cls="green" color="var(--green)" />
        <Kpi label="รายจ่ายรวม"      value={fmtShort(totalExpense)} sub={`${fmt(totalExpense)} บาท`}  cls="red"   color="var(--red)" />
        <Kpi label="กำไรเบื้องต้น"   value={fmtShort(profit)}       sub={profit >= 0 ? `+${(profit/totalIncome*100).toFixed(1)}%` : 'ขาดทุน'} cls={profit>=0?'green':'red'} color={profit>=0?'var(--green)':'var(--red)'} />
        <Kpi label={`ต้องชำระ ${format(new Date(), 'MMM yy', {locale:th})}`}
             value={fmtShort(dueThisMonth)} sub="ยอดค้างจ่ายเดือนนี้" cls="yellow" color="var(--yellow)" />
        <Kpi label={`ต้องชำระ ${format(addMonths(new Date(),1), 'MMM yy', {locale:th})}`}
             value={fmtShort(dueNextMonth)} sub="ยอดค้างจ่ายเดือนหน้า" cls="blue" color="var(--blue)" />
        <Kpi label="Retention ใกล้ครบกำหนด"
             value={String(retentionDueSoon.count)}
             sub={retentionDueSoon.count > 0 ? `${fmt(retentionDueSoon.total)} บาท ภายใน 30 วัน` : 'ไม่มีรายการ'}
             cls="blue" color="var(--blue)"
             onClick={() => navigateTo('retention')} />
      </div>
```

- [ ] **Step 5: Build and test**

```bash
npm run build
npm test
```

Expected: build succeeds, `Tests 25 passed (25)`. Note: `navigateTo('retention')` references a tab id Task 4 creates — this is expected to be a harmless no-op click target until Task 4 lands (clicking it before Task 4 exists will just fail to match any `TABS` entry and render the `default:` case in `renderPage()`, i.e. fall back to Dashboard — not a crash). Confirm this doesn't error at build/test time; it's a JS string literal, not an import, so it can't fail to resolve.

- [ ] **Step 6: Commit**

```bash
git add src/pages/Dashboard.jsx src/index.css
git commit -m "$(cat <<'EOF'
feat: add retention-due-soon KPI card to the Dashboard

Counts sites with unreleased retention due within 30 days (via
site_retention_summary, added in an earlier commit), shows the count
and total value, clicking navigates to the Retention tab (added in
the next commit). Kpi component now accepts an optional onClick --
existing calls are unaffected since it defaults to undefined.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Retention tab

**Files:**
- Create: `src/pages/Retention.jsx`
- Modify: `src/App.jsx`

**Interfaces:**
- Consumes: `useSiteRetentionSummary()` from Task 1 (same shape as Task 3's usage: `site_id, site_number, name, end_date, default_retention_period_days, retention_released, retention_released_date, total_retention, due_date`). `Modal`, `fmt`, `fmtDate` from their existing locations (`src/components/Modal.jsx`, `src/lib/supabase.js`) -- same imports every other page already uses.
- Produces: default export `Retention` component (props: `{ navigateTo, navState }`, matching every other page's signature in `renderPage()`), consumed only by `App.jsx` in this task.

- [ ] **Step 1: Create the page**

Create `src/pages/Retention.jsx`:

```jsx
// ============================================================
// Retention — สรุปสถานะเงินประกันผลงาน (client retention) ต่อไซท์งาน
// ✅ วันครบกำหนด = sites.end_date + default_retention_period_days
// ✅ บันทึกว่าคืนแล้ว (ทั้งก้อนต่อไซท์ ไม่แยกตามใบแจ้งหนี้)
// ============================================================
import { useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { useSiteRetentionSummary } from '../hooks/useSupabase.js'
import { fmt, fmtDate } from '../lib/supabase.js'
import { Modal } from '../components/Modal.jsx'

function statusFor(row) {
  if (row.retention_released) return { label: 'คืนแล้ว', cls: 'badge-paid' }
  if (!row.due_date) return { label: 'ยังไม่ได้ตั้งระยะเวลา', cls: 'badge-pending' }
  const today = new Date().toISOString().slice(0, 10)
  if (row.due_date < today) return { label: 'เกินกำหนด', cls: 'badge-status-cancelled' }
  const in30 = new Date()
  in30.setDate(in30.getDate() + 30)
  if (row.due_date <= in30.toISOString().slice(0, 10)) return { label: 'ใกล้ครบกำหนด', cls: 'badge-po-ordered' }
  return { label: 'รอครบกำหนด', cls: 'badge-pending' }
}

function ReleaseDialog({ row, onClose, onSaved }) {
  const [releaseDate, setReleaseDate] = useState(new Date().toISOString().slice(0, 10))
  const [saving, setSaving] = useState(false)

  const save = async () => {
    setSaving(true)
    const { error } = await supabase
      .from('sites')
      .update({ retention_released: true, retention_released_date: releaseDate })
      .eq('id', row.site_id)
    setSaving(false)
    if (error) { alert('Error: ' + error.message); return }
    onSaved()
  }

  return (
    <Modal title={`บันทึกว่าคืนแล้ว — ${row.name}`} onClose={onClose} maxWidth={420}>
      <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
        <div>ยอด Retention: <strong>{fmt(row.total_retention)} บาท</strong></div>
        <div>
          <label className="label">วันที่ได้รับคืน ★</label>
          <input type="date" className="input" required value={releaseDate} onChange={e => setReleaseDate(e.target.value)} />
        </div>
      </div>
      <div className="modal-footer">
        <button className="btn btn-ghost" onClick={onClose}>ยกเลิก</button>
        <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? '⏳...' : '✅ บันทึก'}</button>
      </div>
    </Modal>
  )
}

export default function Retention() {
  const { data: rows, refetch } = useSiteRetentionSummary()
  const [releaseRow, setReleaseRow] = useState(null)

  const visible = (rows || []).filter(r => r.total_retention > 0)

  return (
    <div>
      <div style={{ marginBottom: 14 }}>
        <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>🔒 Retention</h2>
        <p style={{ fontSize: 13, color: 'var(--text3)' }}>
          สรุปเงินประกันผลงานที่ถูกหักไว้ต่อไซท์งาน และวันครบกำหนดคืน (คำนวณจากวันจบงาน + ระยะเวลา retention ที่ตั้งไว้ในหน้าไซท์งาน)
        </p>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>ไซท์งาน</th>
                <th>วันจบงาน</th>
                <th>ยอด Retention</th>
                <th>วันครบกำหนด</th>
                <th>สถานะ</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {visible.map(row => {
                const status = statusFor(row)
                return (
                  <tr key={row.site_id}>
                    <td style={{ fontWeight: 600, fontSize: 13 }}>{row.name}</td>
                    <td style={{ fontSize: 12 }}>{row.end_date ? fmtDate(row.end_date) : '—'}</td>
                    <td className="font-mono" style={{ fontWeight: 700 }}>{fmt(row.total_retention)}</td>
                    <td style={{ fontSize: 12 }}>{row.due_date ? fmtDate(row.due_date) : '—'}</td>
                    <td><span className={`badge ${status.cls}`}>{status.label}</span></td>
                    <td>
                      {row.retention_released ? (
                        <span style={{ fontSize: 11, color: 'var(--text3)' }}>คืนวันที่ {fmtDate(row.retention_released_date)}</span>
                      ) : (
                        <button className="btn btn-sm btn-primary" onClick={() => setReleaseRow(row)}>✅ บันทึกว่าคืนแล้ว</button>
                      )}
                    </td>
                  </tr>
                )
              })}
              {!visible.length && (
                <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--text3)', padding: 32 }}>ยังไม่มีไซท์งานที่มี Retention</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {releaseRow && (
        <ReleaseDialog row={releaseRow} onClose={() => setReleaseRow(null)} onSaved={() => { setReleaseRow(null); refetch() }} />
      )}
    </div>
  )
}
```

(`badge-paid`, `badge-pending`, `badge-status-cancelled`, `badge-po-ordered` are existing CSS classes already used elsewhere in this app for status pills — reused here rather than adding new ones. Verified their actual colors in `src/index.css` before picking them: paid=green, pending=yellow, status-cancelled=red (NOT badge-po-cancelled, which is a muted gray meant for "this PO was cancelled," semantically wrong for "overdue"), po-ordered=accent/purple-blue for "in progress.")

- [ ] **Step 2: Wire it into App.jsx — lazy import**

In `src/App.jsx`, find:

```jsx
const Settings           = lazy(() => import('./pages/Settings.jsx'))
```

Add immediately after it:

```jsx
const Retention           = lazy(() => import('./pages/Retention.jsx'))
```

- [ ] **Step 3: Add the TABS entry**

Find the `TABS` array, specifically the `income` entry:

```jsx
  { id: 'income',            label: '💰 รายรับ',               minRole: 'ADMIN',  module: null },
```

Add immediately after it:

```jsx
  { id: 'retention',         label: '🔒 Retention',            minRole: 'ADMIN',  module: null },
```

- [ ] **Step 4: Add the renderPage() case**

Find:

```jsx
      case 'income':     return <ProtectedPage minRole="ADMIN"><Income     {...props} /></ProtectedPage>
```

Add immediately after it:

```jsx
      case 'retention':  return <ProtectedPage minRole="ADMIN"><Retention  {...props} /></ProtectedPage>
```

- [ ] **Step 5: Build and test**

```bash
npm run build
npm test
```

Expected: build succeeds, chunk output includes a new `Retention-*.js` chunk (confirm via the build output listing), `Tests 25 passed (25)`.

- [ ] **Step 6: Manual verification**

Run `npm run preview -- --port 4174`, log in, click the new "🔒 Retention" tab, confirm the table renders (empty-state message if no site has retention > 0 yet, or real rows if the test site from Task 2's Step 5 has income with retention recorded). Click "✅ บันทึกว่าคืนแล้ว" on a row, confirm the dialog opens, pick a date, save, confirm the row updates to show "คืนวันที่ ..." and the action button disappears. Go back to the Dashboard tab and confirm the retention KPI card's count dropped (the just-released site should no longer count toward it, per Task 3's `!r.retention_released` filter).

- [ ] **Step 7: Commit**

```bash
git add src/pages/Retention.jsx src/App.jsx
git commit -m "$(cat <<'EOF'
feat: add Retention tab to view and release retention status per site

New lazy-loaded tab (src/pages/Retention.jsx) listing every site with
retention > 0: amount, due date, status badge, and a per-site
"บันทึกว่าคืนแล้ว" action that records the release date on the site
row. Table and release dialog both read/write through
site_retention_summary / sites (added in earlier commits in this
plan) -- no new tables.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review Notes

(Completed during plan authoring — retained here for the record, not part of the executable plan.)

1. **Spec coverage:** Data model (Task 1) ✓. Sites form field (Task 2) ✓. Dashboard KPI card, 30-day threshold, click-through navigation (Task 3) ✓. Retention tab with table, status badges, release action (Task 4) ✓. Non-goals respected: no labor-retention changes anywhere in any task, no per-invoice due dates (view aggregates per site only), no partial-release UI (single boolean + date), no automated reminders (KPI card only).
2. **Placeholder scan:** none found — every step has literal code, exact file paths, exact commands.
3. **Type/name consistency:** `useSiteRetentionSummary` defined in Task 1, imported by that exact name in both Task 3 and Task 4. View column names (`total_retention`, `due_date`, `retention_released`, `retention_released_date`, `site_id`, `end_date`, `name`) used identically across Task 1's SQL, Task 3's filter logic, and Task 4's table/dialog. `navigateTo('retention')` (Task 3) matches the `id: 'retention'` TABS entry (Task 4) exactly. `Retention` component name matches its default export, its lazy-import binding name, and its `renderPage()` JSX usage, all in Task 4.
