# Sites — Gantt Chart + S-curve Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Gantt chart view to the Sites page showing each site's process-step schedule, plus a per-site S-curve comparing planned billing, actual billing, and cost over time.

**Architecture:** A new `site_phases` table (auto-seeded with a 7-step template per site via a DB trigger) drives a custom-built Gantt view toggled alongside the existing Sites table. Selecting a site in the Gantt view reveals a per-site S-curve built from `site_phases` (plan), `incomes` (actual billing), and `expenses` (cost) — all client-side computation via pure, framework-free calculation modules, rendered with `recharts` (already a dependency).

**Tech Stack:** React (existing), Supabase (existing), `recharts` (existing dependency, no new packages).

## Global Constraints

- No test runner exists in this repo — "verify" means running the exact SQL query / `npm run build` / browser walkthrough named in the step. Never claim a step passed without running it.
- No new npm dependencies — Gantt is hand-built with divs/CSS (matching the existing Assign page's custom grid views); the S-curve uses `recharts`, already installed.
- Timezone/date handling: all dates are plain `DATE` columns (`YYYY-MM-DD` strings) — comparisons use string comparison (`localeCompare`) or `new Date(...)`, consistently, per module.
- `billing_weight_pct` sums are not DB-enforced to equal 100 — the UI warns, never blocks saving.
- Follow existing code style: inline styles matching the surrounding file's conventions (this codebase does not use a CSS-in-JS library or Tailwind — see `Sites.jsx` for the pattern of `style={{...}}` plus theme CSS variables like `var(--text3)`, `var(--yellow)`, `var(--green)`, `var(--accent)`).

---

### Task 1: Supabase migration — `site_phases` table, seed trigger, backfill

**Files:**
- Create: `supabase/migrations/2026-07-06-01-site-phases-table.sql`

**Interfaces:**
- Produces: table `site_phases(id, site_id, name, sort_order, start_date, end_date, status, billing_weight_pct, created_at, updated_at)` — consumed by Task 2's hook.

- [ ] **Step 1: Write the migration**

```sql
-- site_phases: per-site process-step schedule (Gantt) + billing weight (S-curve plan line)
-- Applied to project yyzbgdmgyvvypfcjuhtr on 2026-07-06

CREATE TABLE site_phases (
  id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  site_id             UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  sort_order          INT NOT NULL DEFAULT 0,
  start_date          DATE,
  end_date            DATE,
  status              TEXT NOT NULL DEFAULT 'not_started'
                      CHECK (status IN ('not_started','in_progress','done')),
  billing_weight_pct  NUMERIC NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_site_phases_site_id ON site_phases(site_id);

-- Auto-seed the 7-step template whenever a new site is created (covers the
-- add-site form and Excel import — any insert path into `sites`).
CREATE OR REPLACE FUNCTION seed_site_phases() RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO site_phases (site_id, name, sort_order, billing_weight_pct) VALUES
    (NEW.id, 'ทำแบบเพื่อขออนุมัติ', 1, 5),
    (NEW.id, 'สั่งวัสดุ', 2, 15),
    (NEW.id, 'วัดหน้างานเพื่อผลิต', 3, 5),
    (NEW.id, 'ผลิต', 4, 30),
    (NEW.id, 'ติดตั้ง', 5, 30),
    (NEW.id, 'เก็บงานรอบสุดท้าย', 6, 10),
    (NEW.id, 'ส่งมอบงาน', 7, 5);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_seed_site_phases
  AFTER INSERT ON sites
  FOR EACH ROW EXECUTE FUNCTION seed_site_phases();

-- Backfill: sites created before this migration have no phases yet.
INSERT INTO site_phases (site_id, name, sort_order, billing_weight_pct)
SELECT s.id, p.name, p.sort_order, p.billing_weight_pct
FROM sites s
CROSS JOIN (VALUES
  ('ทำแบบเพื่อขออนุมัติ', 1, 5),
  ('สั่งวัสดุ', 2, 15),
  ('วัดหน้างานเพื่อผลิต', 3, 5),
  ('ผลิต', 4, 30),
  ('ติดตั้ง', 5, 30),
  ('เก็บงานรอบสุดท้าย', 6, 10),
  ('ส่งมอบงาน', 7, 5)
) AS p(name, sort_order, billing_weight_pct)
WHERE NOT EXISTS (SELECT 1 FROM site_phases sp WHERE sp.site_id = s.id);
```

- [ ] **Step 2: Apply the migration**

Apply via the Supabase MCP `apply_migration` tool (name: `site_phases_table`, project id `yyzbgdmgyvvypfcjuhtr`), passing the SQL above.

- [ ] **Step 3: Verify the table and trigger**

```sql
SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = 'site_phases' ORDER BY ordinal_position;
```
Expected: 9 rows (`id` uuid, `site_id` uuid, `name` text, `sort_order` integer, `start_date` date, `end_date` date, `status` text, `billing_weight_pct` numeric, `created_at`/`updated_at` timestamptz — 10 actually, count them all).

- [ ] **Step 4: Verify the backfill covered every existing site**

```sql
SELECT COUNT(*) AS sites_without_phases
FROM sites s WHERE NOT EXISTS (SELECT 1 FROM site_phases sp WHERE sp.site_id = s.id);
```
Expected: `0`.

- [ ] **Step 5: Verify the trigger fires on new inserts**

```sql
INSERT INTO sites (name, status) VALUES ('__test_gantt_trigger__', 'Ongoing') RETURNING id;
```
Note the returned `id`, then:
```sql
SELECT COUNT(*) FROM site_phases WHERE site_id = '<id from above>';
```
Expected: `7`. Clean up:
```sql
DELETE FROM sites WHERE name = '__test_gantt_trigger__';
```
(the `ON DELETE CASCADE` on `site_phases.site_id` removes its 7 seeded rows too — confirm with `SELECT COUNT(*) FROM site_phases WHERE site_id = '<id>'` returning `0` after the delete.)

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/2026-07-06-01-site-phases-table.sql
git commit -m "Add site_phases table with auto-seed trigger and backfill"
```

---

### Task 2: `useSitePhases()` hook

**Files:**
- Modify: `src/hooks/useSupabase.js`

**Interfaces:**
- Produces: `useSitePhases()` returning `{ data, loading, error, refetch }` (same shape as the file's existing `useQuery`-based hooks, e.g. `useLaborCost`) where `data` is every `site_phases` row across all sites, ordered `site_id, sort_order` — consumed by Task 4 (`GanttView.jsx`), Task 5 (`PhaseManageModal.jsx`), Task 7 (`SCurveChart.jsx`).

- [ ] **Step 1: Read the existing `useLaborCost` hook for the pattern to match**

`src/hooks/useSupabase.js:156-167` (existing):
```js
export function useLaborCost(siteId) {
  return useQuery(async () => {
    let q = supabase.from('labor_cost_by_site').select('*')
    if (siteId) q = q.eq('site_id', siteId)
    const { data, error } = await q
    if (error) throw error
    return data
  }, [siteId])
}
```

- [ ] **Step 2: Add `useSitePhases()` immediately after `useLaborCost`**

In `src/hooks/useSupabase.js`, after the `useLaborCost` function (the one shown above), add:

```js
/** ขั้นตอนงาน (Gantt) ทุกไซท์ — group ฝั่ง client ด้วย site_id */
export function useSitePhases() {
  return useQuery(async () => {
    const { data, error } = await supabase
      .from('site_phases')
      .select('*')
      .order('site_id', { ascending: true })
      .order('sort_order', { ascending: true })
    if (error) throw error
    return data
  })
}
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: built, no errors.

- [ ] **Step 4: Verify the hook returns real data**

Start the dev server (`npm run dev`), open the browser console on any page that already imports `useSupabase.js` (e.g. Sites), and run in the console:
```js
fetch(`${import.meta.env.VITE_SUPABASE_URL}/rest/v1/site_phases?select=*&limit=5`, {
  headers: { apikey: import.meta.env.VITE_SUPABASE_ANON_KEY }
}).then(r => r.json()).then(console.log)
```
Expected: an array of up to 5 phase rows with `name`, `sort_order`, `billing_weight_pct` fields populated (this confirms the REST path the hook uses is reachable and returns seeded data — the hook itself gets exercised properly once wired into a component in Task 4).

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useSupabase.js
git commit -m "Add useSitePhases hook"
```

---

### Task 3: Gantt timeline math module

**Files:**
- Create: `src/pages/sites/ganttTimeline.js`

**Interfaces:**
- Produces: `computeTimelineRange(sites, phasesBySite) -> {start: Date, end: Date} | null`, `positionPercent(dateStr, range) -> number|null`, `barStyle(phase, range) -> {left: string, width: string}|null`, `STATUS_COLOR: {not_started, in_progress, done}` — consumed by Task 4 (`GanttView.jsx`).

- [ ] **Step 1: Write the module**

`src/pages/sites/ganttTimeline.js`:

```js
// ============================================================
// Gantt timeline math — pure functions, no React/DOM dependency.
// Worked example used to hand-verify this file (see Task 4 Step 4):
//   site A: phase "ผลิต" 2026-08-01..2026-08-10, phase "ติดตั้ง" 2026-08-11..2026-08-20
//   range = { start: 2026-08-01, end: 2026-08-20 } (19 days total)
//   "ผลิต" bar: left 0%, width ~47.4% (9/19 days)
//   "ติดตั้ง" bar: left ~52.6%, width ~47.4%
// ============================================================

export const STATUS_COLOR = {
  not_started: 'var(--text3)',
  in_progress: 'var(--yellow)',
  done: 'var(--green)',
}

/**
 * Spans every site's phase dates (falling back to the site's own
 * start_date/end_date when it has no dated phases yet).
 */
export function computeTimelineRange(sites, phasesBySite) {
  const dates = []
  sites.forEach((site) => {
    const phases = phasesBySite[site.id] || []
    let sitePhaseDatesFound = false
    phases.forEach((p) => {
      if (p.start_date) { dates.push(new Date(p.start_date)); sitePhaseDatesFound = true }
      if (p.end_date)   { dates.push(new Date(p.end_date));   sitePhaseDatesFound = true }
    })
    if (!sitePhaseDatesFound) {
      if (site.start_date) dates.push(new Date(site.start_date))
      if (site.end_date)   dates.push(new Date(site.end_date))
    }
  })
  if (dates.length === 0) return null
  return {
    start: new Date(Math.min(...dates)),
    end: new Date(Math.max(...dates)),
  }
}

/** Where a date falls within [range.start, range.end], as 0-100. */
export function positionPercent(dateStr, range) {
  if (!dateStr || !range) return null
  const d = new Date(dateStr)
  const totalMs = range.end - range.start
  if (totalMs <= 0) return 0
  const offsetMs = d - range.start
  return Math.min(100, Math.max(0, (offsetMs / totalMs) * 100))
}

/** CSS left/width for one phase's bar, or null if it has no dates yet. */
export function barStyle(phase, range) {
  if (!phase.start_date || !phase.end_date || !range) return null
  const left = positionPercent(phase.start_date, range)
  const right = positionPercent(phase.end_date, range)
  return { left: `${left}%`, width: `${Math.max(right - left, 1)}%` }
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: built, no errors.

- [ ] **Step 3: Hand-verify against the worked example in the file's header comment**

With `range = { start: new Date('2026-08-01'), end: new Date('2026-08-20') }` (19 days = 1,641,600,000 ms):
- `positionPercent('2026-08-01', range)` → `0`
- `positionPercent('2026-08-10', range)` → `9 / 19 * 100` ≈ `47.4`
- `positionPercent('2026-08-20', range)` → `100`

These match the header comment's worked example — no code changes needed here, this step is a manual trace-through to catch arithmetic mistakes before Task 4 wires it into the UI where it'd otherwise be harder to isolate.

- [ ] **Step 4: Commit**

```bash
git add src/pages/sites/ganttTimeline.js
git commit -m "Add Gantt timeline positioning math"
```

---

### Task 4: `GanttView.jsx` component

**Files:**
- Create: `src/pages/sites/GanttView.jsx`

**Interfaces:**
- Consumes: `useSitePhases()` (Task 2), `computeTimelineRange`/`barStyle`/`STATUS_COLOR` (Task 3), `fmtDate`/`countdown` from `../../lib/supabase.js` (existing, already imported in `Sites.jsx`).
- Produces: `<GanttView sites={filteredSites} navigateTo={navigateTo} onManagePhases={(site) => void} selectedSiteId={string|null} onSelectSite={(siteId) => void} />` — consumed by Task 8 (`Sites.jsx`).

- [ ] **Step 1: Write the component**

`src/pages/sites/GanttView.jsx`:

```jsx
// ============================================================
// GanttView — 1 แถวต่อไซท์ แสดงแท่งขั้นตอนงานตามช่วงเวลา
// ============================================================
import { useMemo } from 'react'
import { useSitePhases } from '../../hooks/useSupabase.js'
import { computeTimelineRange, barStyle, STATUS_COLOR } from './ganttTimeline.js'

export default function GanttView({ sites, navigateTo, onManagePhases, selectedSiteId, onSelectSite }) {
  const { data: allPhases } = useSitePhases()

  const phasesBySite = useMemo(() => {
    const m = {}
    ;(allPhases || []).forEach((p) => {
      if (!m[p.site_id]) m[p.site_id] = []
      m[p.site_id].push(p)
    })
    return m
  }, [allPhases])

  const range = useMemo(() => computeTimelineRange(sites, phasesBySite), [sites, phasesBySite])

  if (!range) {
    return (
      <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--text3)' }}>
        ไม่มีไซท์ที่มีวันที่ให้แสดงบน Gantt
      </div>
    )
  }

  return (
    <div className="card">
      {sites.map((site) => {
        const phases = phasesBySite[site.id] || []
        const isSelected = selectedSiteId === site.id
        return (
          <div
            key={site.id}
            onClick={() => onSelectSite(site.id)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '10px 12px',
              borderBottom: '1px solid var(--border)',
              cursor: 'pointer',
              background: isSelected ? 'var(--bg2)' : 'transparent',
            }}
          >
            <div style={{ width: 180, flexShrink: 0 }}>
              <div
                style={{ fontWeight: 600, fontSize: 13, textDecoration: 'underline dotted' }}
                onClick={(e) => { e.stopPropagation(); navigateTo('assign', { siteId: site.id, siteName: site.name }) }}
                title="ไปหน้า Assign ของไซท์นี้"
              >
                {site.name}
              </div>
              <div style={{ fontSize: 11, color: 'var(--accent)' }}>{site.site_number}</div>
            </div>
            <div style={{ position: 'relative', flex: 1, height: 28, background: 'var(--bg2)', borderRadius: 4 }}>
              {phases.map((phase) => {
                const style = barStyle(phase, range)
                if (!style) return null
                return (
                  <div
                    key={phase.id}
                    title={`${phase.name}\n${phase.start_date} → ${phase.end_date}\nสถานะ: ${phase.status}`}
                    style={{
                      position: 'absolute',
                      top: 4,
                      bottom: 4,
                      left: style.left,
                      width: style.width,
                      background: STATUS_COLOR[phase.status] || STATUS_COLOR.not_started,
                      borderRadius: 3,
                    }}
                  />
                )
              })}
            </div>
            <button
              className="btn btn-sm btn-ghost"
              style={{ flexShrink: 0 }}
              onClick={(e) => { e.stopPropagation(); onManagePhases(site) }}
            >
              📋 จัดการขั้นตอน
            </button>
          </div>
        )
      })}
      {!sites.length && (
        <div style={{ padding: 32, textAlign: 'center', color: 'var(--text3)' }}>ไม่พบข้อมูลไซท์งาน</div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: built, no errors.

- [ ] **Step 3: Wire it in temporarily to check rendering (will be replaced properly in Task 8)**

This is a throwaway check, not the final integration. In `src/pages/Sites.jsx`, temporarily add near the top of the file:
```js
import GanttView from './sites/GanttView.jsx'
```
and temporarily render `<GanttView sites={filtered} navigateTo={navigateTo} onManagePhases={() => {}} selectedSiteId={null} onSelectSite={() => {}} />` right above the existing `{/* ── Table ── */}` comment block. Run `npm run dev`, open the Sites page.

Expected: one row per visible site, each showing coloured bars for phases that have both dates set (freshly seeded phases have no dates yet, so bars will be invisible until Task 5 lets you set them — that's expected, not a bug). Confirm clicking a site's name navigates to Assign (existing behavior), and confirm the "📋 จัดการขั้นตอน" button is visible (it won't do anything yet — wired in Task 8).

- [ ] **Step 4: Revert the throwaway wiring**

Remove the temporary import and the temporary `<GanttView>` render added in Step 3 — Task 8 does the real integration with proper state wiring. Confirm `git diff src/pages/Sites.jsx` shows no changes before moving on.

- [ ] **Step 5: Commit**

```bash
git add src/pages/sites/GanttView.jsx
git commit -m "Add GanttView component"
```

---

### Task 5: `PhaseManageModal.jsx` component

**Files:**
- Create: `src/pages/sites/PhaseManageModal.jsx`

**Interfaces:**
- Consumes: `Modal` from `../../components/Modal.jsx` (existing), `supabase` from `../../lib/supabase.js` (existing).
- Produces: `<PhaseManageModal site={site} phases={phasesForThisSite} onClose={() => void} onSaved={() => void} />` — consumed by Task 8 (`Sites.jsx`).

- [ ] **Step 1: Write the component**

`src/pages/sites/PhaseManageModal.jsx`:

```jsx
// ============================================================
// PhaseManageModal — เพิ่ม/แก้/ลบขั้นตอนงานของไซท์เดียว
// ============================================================
import { useState } from 'react'
import { supabase } from '../../lib/supabase.js'
import { Modal } from '../../components/Modal.jsx'

const STATUS_OPTS = [
  { value: 'not_started', label: 'ยังไม่เริ่ม' },
  { value: 'in_progress', label: 'กำลังทำ' },
  { value: 'done', label: 'เสร็จ' },
]

let tempIdCounter = 0
function nextTempId() { tempIdCounter -= 1; return tempIdCounter }

export default function PhaseManageModal({ site, phases, onClose, onSaved }) {
  const [rows, setRows] = useState(() => phases.map((p) => ({ ...p })))
  const [saving, setSaving] = useState(false)
  const originalIds = phases.map((p) => p.id)

  const setRow = (id, patch) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  const addRow = () => setRows((rs) => [
    ...rs,
    { id: nextTempId(), site_id: site.id, name: '', sort_order: rs.length + 1, start_date: '', end_date: '', status: 'not_started', billing_weight_pct: 0 },
  ])
  const removeRow = (id) => setRows((rs) => rs.filter((r) => r.id !== id))

  const totalWeight = rows.reduce((s, r) => s + (parseFloat(r.billing_weight_pct) || 0), 0)

  const handleSave = async () => {
    setSaving(true)
    try {
      const toUpdate = rows.filter((r) => r.id > 0).map((r) => ({
        id: r.id,
        site_id: site.id,
        name: r.name,
        sort_order: r.sort_order,
        start_date: r.start_date || null,
        end_date: r.end_date || null,
        status: r.status,
        billing_weight_pct: parseFloat(r.billing_weight_pct) || 0,
      }))
      const toInsert = rows.filter((r) => r.id < 0).map((r) => ({
        site_id: site.id,
        name: r.name,
        sort_order: r.sort_order,
        start_date: r.start_date || null,
        end_date: r.end_date || null,
        status: r.status,
        billing_weight_pct: parseFloat(r.billing_weight_pct) || 0,
      }))
      const keptIds = rows.filter((r) => r.id > 0).map((r) => r.id)
      const deletedIds = originalIds.filter((id) => !keptIds.includes(id))

      if (toUpdate.length) {
        const { error } = await supabase.from('site_phases').upsert(toUpdate)
        if (error) throw error
      }
      if (toInsert.length) {
        const { error } = await supabase.from('site_phases').insert(toInsert)
        if (error) throw error
      }
      if (deletedIds.length) {
        const { error } = await supabase.from('site_phases').delete().in('id', deletedIds)
        if (error) throw error
      }
      onSaved()
      onClose()
    } catch (e) {
      alert('บันทึกไม่สำเร็จ: ' + e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title={`จัดการขั้นตอน: ${site.name}`} onClose={onClose} maxWidth={760}>
      <div className="modal-body" style={{ display: 'grid', gap: 10 }}>
        {rows.map((r) => (
          <div key={r.id} style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr 80px 32px', gap: 6, alignItems: 'center' }}>
            <input className="input input-sm" value={r.name} onChange={(e) => setRow(r.id, { name: e.target.value })} placeholder="ชื่อขั้นตอน" />
            <input type="date" className="input input-sm" value={r.start_date || ''} onChange={(e) => setRow(r.id, { start_date: e.target.value })} />
            <input type="date" className="input input-sm" value={r.end_date || ''} onChange={(e) => setRow(r.id, { end_date: e.target.value })} />
            <select className="select" value={r.status} onChange={(e) => setRow(r.id, { status: e.target.value })}>
              {STATUS_OPTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
            <input type="number" className="input input-sm" min="0" max="100" value={r.billing_weight_pct}
              onChange={(e) => setRow(r.id, { billing_weight_pct: e.target.value })} placeholder="%" />
            <button type="button" className="btn btn-sm btn-danger" onClick={() => removeRow(r.id)}>✕</button>
          </div>
        ))}
        <button type="button" className="btn btn-sm btn-ghost" onClick={addRow}>+ เพิ่มขั้นตอน</button>
        <div style={{ fontSize: 12, color: totalWeight === 100 ? 'var(--text3)' : 'var(--yellow)' }}>
          รวม % เบิกเงิน: {totalWeight}% {totalWeight !== 100 && '(ควรรวมได้ 100%)'}
        </div>
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-ghost" onClick={onClose}>ยกเลิก</button>
        <button type="button" className="btn btn-primary" disabled={saving} onClick={handleSave}>
          {saving ? '⏳ กำลังบันทึก...' : '✅ บันทึก'}
        </button>
      </div>
    </Modal>
  )
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: built, no errors.

- [ ] **Step 3: Manual verification (after Task 8 wires this in)**

Deferred to Task 8 Step 4 — this component has no meaningful standalone render without a `site`/`phases` prop from the parent, so it's verified together with the integration.

- [ ] **Step 4: Commit**

```bash
git add src/pages/sites/PhaseManageModal.jsx
git commit -m "Add PhaseManageModal component"
```

---

### Task 6: S-curve calculation module

**Files:**
- Create: `src/pages/sites/scurveCalc.js`

**Interfaces:**
- Produces: `buildPlanSeries(phases, contractValue) -> Array<{date, value}>`, `buildActualSeries(incomes) -> Array<{date, value}>`, `buildCostSeries(expenses) -> Array<{date, value}>`, `mergeCumulativeSeries({plan, actual, cost}) -> Array<{date, plan, actual, cost}>` — consumed by Task 7 (`SCurveChart.jsx`).

- [ ] **Step 1: Write the module**

`src/pages/sites/scurveCalc.js`:

```js
// ============================================================
// S-curve calculations — pure functions, no React/DOM dependency.
// Worked example used to hand-verify this file (see Task 7 Step 4):
//   contract_value = 1,000,000
//   phase "ผลิต" end_date 2026-08-10, weight 30% -> plan jumps to 300,000
//   phase "ติดตั้ง" end_date 2026-08-20, weight 30% -> plan jumps to 600,000
//   incomes: 2026-08-05 amount_no_vat=200000 vat=14000 -> actual = 214,000 at that date
//   expenses: 2026-08-01 amount=50000, 2026-08-15 amount=30000 -> cost = 50,000 then 80,000
// ============================================================

/** Cumulative planned billing: jumps by billing_weight_pct% of contract_value at each phase's end_date. */
export function buildPlanSeries(phases, contractValue) {
  const withEndDate = phases
    .filter((p) => p.end_date)
    .slice()
    .sort((a, b) => a.end_date.localeCompare(b.end_date))
  let cumulative = 0
  return withEndDate.map((p) => {
    cumulative += ((Number(p.billing_weight_pct) || 0) / 100) * (Number(contractValue) || 0)
    return { date: p.end_date, value: cumulative }
  })
}

/** Generic cumulative-sum-by-date series builder. */
function buildCumulativeSeries(rows, dateKey, amountFn) {
  const sorted = rows.slice().sort((a, b) => a[dateKey].localeCompare(b[dateKey]))
  let cumulative = 0
  return sorted.map((r) => {
    cumulative += amountFn(r)
    return { date: r[dateKey], value: cumulative }
  })
}

/** Cumulative actual billing: invoice totals (ex-VAT + VAT) from incomes. */
export function buildActualSeries(incomes) {
  return buildCumulativeSeries(incomes, 'date', (r) => (Number(r.amount_no_vat) || 0) + (Number(r.vat) || 0))
}

/** Cumulative cost: expense amounts. */
export function buildCostSeries(expenses) {
  return buildCumulativeSeries(expenses, 'date', (r) => Number(r.amount) || 0)
}

/**
 * Merges the three cumulative series onto one shared, sorted date axis,
 * forward-filling each series' last known value at every date point so
 * recharts can draw continuous step lines without gaps.
 */
export function mergeCumulativeSeries({ plan, actual, cost }) {
  const allDates = [...new Set([...plan, ...actual, ...cost].map((p) => p.date))].sort()

  const forwardFill = (series) => {
    let idx = 0
    let last = 0
    const map = {}
    allDates.forEach((date) => {
      while (idx < series.length && series[idx].date <= date) {
        last = series[idx].value
        idx += 1
      }
      map[date] = last
    })
    return map
  }

  const planMap = forwardFill(plan)
  const actualMap = forwardFill(actual)
  const costMap = forwardFill(cost)

  return allDates.map((date) => ({
    date,
    plan: planMap[date],
    actual: actualMap[date],
    cost: costMap[date],
  }))
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: built, no errors.

- [ ] **Step 3: Hand-verify against the worked example in the file's header comment**

Trace through `buildPlanSeries` with the example phases: first phase (`ผลิต`, ends 2026-08-10, weight 30) contributes `0.30 * 1,000,000 = 300,000` → `{date: '2026-08-10', value: 300000}`. Second phase (`ติดตั้ง`, ends 2026-08-20, weight 30) contributes another `300,000` on top → `{date: '2026-08-20', value: 600000}`. This matches the header comment. Trace `buildActualSeries` similarly: single income row → `{date: '2026-08-05', value: 214000}`. Trace `buildCostSeries`: two expense rows → `{date: '2026-08-01', value: 50000}`, `{date: '2026-08-15', value: 80000}`. No code changes needed — this is a manual check to catch arithmetic mistakes before Task 7 wires it into a chart.

- [ ] **Step 4: Commit**

```bash
git add src/pages/sites/scurveCalc.js
git commit -m "Add S-curve calculation module"
```

---

### Task 7: `SCurveChart.jsx` component

**Files:**
- Create: `src/pages/sites/SCurveChart.jsx`

**Interfaces:**
- Consumes: `useSitePhases()` (Task 2), `useIncomes`/`useExpenses` from `../../hooks/useSupabase.js` (existing, both accept `{ siteId }` filter), `buildPlanSeries`/`buildActualSeries`/`buildCostSeries`/`mergeCumulativeSeries` (Task 6), `fmt` from `../../lib/supabase.js` (existing, used elsewhere in `Sites.jsx` for currency formatting).
- Produces: `<SCurveChart site={site} />` — consumed by Task 8 (`Sites.jsx`).

- [ ] **Step 1: Write the component**

`src/pages/sites/SCurveChart.jsx`:

```jsx
// ============================================================
// SCurveChart — แผน vs เบิกจริง vs ต้นทุน สะสม ต่อไซท์เดียว
// ============================================================
import { useMemo } from 'react'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts'
import { useSitePhases, useIncomes, useExpenses } from '../../hooks/useSupabase.js'
import { buildPlanSeries, buildActualSeries, buildCostSeries, mergeCumulativeSeries } from './scurveCalc.js'
import { fmt } from '../../lib/supabase.js'

export default function SCurveChart({ site }) {
  const { data: allPhases } = useSitePhases()
  const { data: incomes } = useIncomes({ siteId: site.id })
  const { data: expenses } = useExpenses({ siteId: site.id })

  const chartData = useMemo(() => {
    const phasesForSite = (allPhases || []).filter((p) => p.site_id === site.id)
    const plan = buildPlanSeries(phasesForSite, site.contract_value)
    const actual = buildActualSeries(incomes || [])
    const cost = buildCostSeries(expenses || [])
    return mergeCumulativeSeries({ plan, actual, cost })
  }, [allPhases, incomes, expenses, site.id, site.contract_value])

  if (!chartData.length) {
    return (
      <div className="card" style={{ padding: 24, textAlign: 'center', color: 'var(--text3)' }}>
        ยังไม่มีข้อมูลพอสำหรับกราฟ S-curve ของ {site.name} (ต้องมีวันที่ขั้นตอนงาน หรือรายรับ/รายจ่ายอย่างน้อย 1 รายการ)
      </div>
    )
  }

  return (
    <div className="card" style={{ padding: 16 }}>
      <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 12 }}>S-curve: {site.name}</div>
      <ResponsiveContainer width="100%" height={280}>
        <LineChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis dataKey="date" tick={{ fontSize: 11 }} />
          <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => fmt(v)} />
          <Tooltip formatter={(v) => fmt(v)} />
          <Legend />
          <Line type="monotone" dataKey="plan" name="แผนเบิกเงิน" stroke="var(--accent)" dot={false} />
          <Line type="monotone" dataKey="actual" name="เบิกจริง" stroke="var(--green)" dot={false} />
          <Line type="monotone" dataKey="cost" name="ต้นทุนเรา" stroke="var(--red)" dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: built, no errors.

- [ ] **Step 3: Manual verification (after Task 8 wires this in)**

Deferred to Task 8 Step 4 — verified together with the full integration once a site can actually be selected in the running app.

- [ ] **Step 4: Commit**

```bash
git add src/pages/sites/SCurveChart.jsx
git commit -m "Add SCurveChart component"
```

---

### Task 8: Wire Gantt + S-curve into `Sites.jsx`

**Files:**
- Modify: `src/pages/Sites.jsx`

**Interfaces:**
- Consumes: `GanttView` (Task 4), `PhaseManageModal` (Task 5), `SCurveChart` (Task 7), `useSitePhases` (Task 2).

- [ ] **Step 1: Add imports**

In `src/pages/Sites.jsx`, add near the top with the other imports (after the `SearchableSelect` import at line 17):

```js
import GanttView from './sites/GanttView.jsx'
import PhaseManageModal from './sites/PhaseManageModal.jsx'
import SCurveChart from './sites/SCurveChart.jsx'
import { useSitePhases } from '../hooks/useSupabase.js'
```

(`useSupabase.js` is already imported for `useSites, useLaborCost, useClients` at line 12 — add `useSitePhases` to that same existing import instead of a separate line: change line 12 from
```js
import { useSites, useLaborCost, useClients } from '../hooks/useSupabase.js'
```
to
```js
import { useSites, useLaborCost, useClients, useSitePhases } from '../hooks/useSupabase.js'
```
and drop the separate `useSitePhases` import line shown above.)

- [ ] **Step 2: Add state for view mode, selected site, and the phase-manage modal**

In the `Sites` component, after the existing `const [sortDir, setSortDir] = useState('asc')` line (around line 161), add:

```js
const [viewMode,      setViewMode]      = useState('table') // 'table' | 'gantt'
const [selectedSiteId, setSelectedSiteId] = useState(null)
const [managePhasesSite, setManagePhasesSite] = useState(null) // site object or null
const { data: allPhases, refetch: refetchPhases } = useSitePhases()
```

- [ ] **Step 3: Add the view toggle buttons and conditional rendering**

In the toolbar `<div>` (the one containing the status filter buttons, around line 246-252), add a view toggle right after the search input (after the `<input className="input input-sm" ... />` line, before the status filter `<div>`):

```jsx
<div style={{ display: 'flex', gap: 4 }}>
  <button className={`btn btn-sm ${viewMode === 'table' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setViewMode('table')}>📋 ตาราง</button>
  <button className={`btn btn-sm ${viewMode === 'gantt' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setViewMode('gantt')}>📊 Gantt</button>
</div>
```

Then wrap the existing `{/* ── Table ── */}` block (the `<div className="card">...</div>` containing the `<table>`, roughly lines 266-384) in a condition, and add the Gantt branch plus the S-curve panel. Replace:

```jsx
      {/* ── Table ── */}
      <div className="card">
        <div className="table-wrap">
          <table>
```

with:

```jsx
      {/* ── Table ── */}
      {viewMode === 'table' && (
      <div className="card">
        <div className="table-wrap">
          <table>
```

and find the matching closing of that table's `<div className="card">` block (the `</div>` right before `{/* ── Add/Edit Modal ── */}`), and change it from:

```jsx
        </div>
      </div>

      {/* ── Add/Edit Modal ── */}
```

to:

```jsx
        </div>
      </div>
      )}

      {viewMode === 'gantt' && (
        <>
          <GanttView
            sites={filtered}
            navigateTo={navigateTo}
            onManagePhases={(site) => setManagePhasesSite(site)}
            selectedSiteId={selectedSiteId}
            onSelectSite={setSelectedSiteId}
          />
          {selectedSiteId && (
            <div style={{ marginTop: 16 }}>
              <SCurveChart site={filtered.find((s) => s.id === selectedSiteId)} />
            </div>
          )}
        </>
      )}

      {managePhasesSite && (
        <PhaseManageModal
          site={managePhasesSite}
          phases={(allPhases || []).filter((p) => p.site_id === managePhasesSite.id)}
          onClose={() => setManagePhasesSite(null)}
          onSaved={refetchPhases}
        />
      )}

      {/* ── Add/Edit Modal ── */}
```

- [ ] **Step 4: Verify build, then full manual walkthrough**

Run: `npm run build` → Expected: built, no errors.

Start `npm run dev`, open the Sites page, and walk through:
1. Click "📊 Gantt" — table hides, Gantt rows appear (bars invisible for phases without dates yet, per Task 4 Step 3's note).
2. Click "📋 จัดการขั้นตอน" on any site — modal opens showing its 7 seeded phases with empty dates.
3. Set `start_date`/`end_date` on 2-3 phases, change one `status` to "กำลังทำ", save. Modal closes.
4. Confirm the Gantt row for that site now shows coloured bars positioned within the timeline, and hovering one shows the tooltip (name, date range, status).
5. Click the site's row (not its name, not the manage button) — confirm an S-curve panel appears below the Gantt with 3 lines. If the site has no `incomes`/`expenses` rows yet, "เบิกจริง"/"ต้นทุนเรา" should sit flat at 0 while "แผนเบิกเงิน" steps up at the phase end-dates you set — cross-check one step's height against `billing_weight_pct / 100 * contract_value` for that site (visible in the table view / edit form).
6. Click "📋 ตาราง" — confirm it switches back cleanly and the existing table still works exactly as before (status filter, search, sort, edit, complete, delete all still functioning — this confirms Task 8's changes didn't regress the pre-existing table).

- [ ] **Step 5: Commit**

```bash
git add src/pages/Sites.jsx
git commit -m "Wire Gantt view, phase management, and S-curve into Sites page"
```
