# Site Gantt + S-curve (Phase 1 of the Gantt+Kanban spec) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Gantt timeline view (with soft dependency arrows) and a per-site S-curve (plan/actual-income/cost) to the Sites page, using the `site_phases` table that is already live in production but has never been driven by any UI.

**Architecture:** `site_phases` (table, RLS, and the `depends_on_phase_id` column) already exist in production — no schema migration needed for the table itself, only a data-hygiene cleanup for a pre-existing duplicate-row bug. A view-mode toggle is added to the existing `Sites.jsx` list page (`Table` / `Gantt`, matching the page's current single-page-with-toggle pattern — there is no per-site detail route in this app, so this plan does **not** introduce one, despite the design spec's mockups showing a "site detail page with tabs"; that was illustrative, not an architectural commitment). Selecting a site row in Gantt mode reveals its S-curve below, built from `site_phases` (plan line) plus the existing `useIncomes`/`useExpenses` hooks (actual/cost lines). Phase `status` stays a manually-set dropdown in this phase — the spec's plan to make it computed from `phase_tasks` happens in the *next* plan (Kanban), once `phase_tasks` exists to compute it from.

**Tech Stack:** React (existing), Supabase (existing), `recharts` (existing dependency, no new packages).

**Spec:** [`docs/superpowers/specs/2026-09-17-site-gantt-kanban-design.md`](../specs/2026-09-17-site-gantt-kanban-design.md) — this plan implements that spec's items 1 (Gantt) and 2 (S-curve) only. Items 3–5 (Kanban, Worker Dashboard, Day View) are separate future plans. Also supersedes (does not extend — that branch is 563 commits stale) [`docs/superpowers/plans/2026-07-06-sites-gantt-scurve.md`](2026-07-06-sites-gantt-scurve.md), whose proven code this plan reuses where still valid.

## Global Constraints

- No test runner in this repo — "verify" means running the exact SQL query / `npm run build` / browser walkthrough named in the step. Never claim a step passed without running it.
- No new npm dependencies — Gantt is hand-built divs/CSS (matching `src/pages/assign/`'s custom grid views); S-curve uses `recharts`, already installed.
- Dates are plain `DATE` columns (`YYYY-MM-DD` strings) — compare via `localeCompare` or `new Date(...)`, consistently per module.
- `billing_weight_pct` sums are not DB-enforced to equal 100 — the UI warns, never blocks saving.
- `depends_on_phase_id` is a **soft** hint only — it draws an arrow, it never blocks saving a phase or disables any control. There is no cycle-detection requirement in this phase (a self-referencing or circular dependency just draws a visually odd arrow — acceptable, not worth the complexity to prevent yet).
- Follow existing style: inline `style={{...}}` plus theme CSS variables (`var(--text3)`, `var(--yellow)`, `var(--green)`, `var(--accent)`, etc.) — see any existing block in `Sites.jsx` for the pattern.
- Supabase project id for all migrations/queries: `yyzbgdmgyvvypfcjuhtr`.

---

### Task 1: Data-hygiene migration — de-duplicate `site_phases`

**Files:**
- Create: `supabase/migrations/2026-09-17-01-dedupe-site-phases.sql`

**Interfaces:**
- Produces: a `site_phases` table with exactly one row per `(site_id, name)` — consumed implicitly by every later task (a clean Gantt row needs no duplicate bars).

- [ ] **Step 1: Confirm the current duplicate count (baseline, before fixing)**

Run via the Supabase MCP `execute_sql` tool (project `yyzbgdmgyvvypfcjuhtr`):
```sql
SELECT COUNT(*) AS total_rows, COUNT(DISTINCT site_id) AS distinct_sites FROM site_phases;
```
Expected (as of 2026-09-17): `total_rows = 966`, `distinct_sites = 136`. If these numbers differ, someone already touched this data — stop and re-investigate before continuing, don't assume the fix below still applies cleanly.

```sql
SELECT COUNT(*) AS sites_with_dupes FROM (
  SELECT site_id FROM site_phases GROUP BY site_id, name HAVING COUNT(*) > 1
) x;
```
Expected: `14`.

- [ ] **Step 2: Write the migration**

`supabase/migrations/2026-09-17-01-dedupe-site-phases.sql`:
```sql
-- Fixes a pre-existing double-seed bug: 14 of 136 sites ended up with
-- duplicate site_phases rows (same site_id + name), most likely from the
-- seed trigger firing twice on some site-creation path. Keeps the
-- earliest-created row per (site_id, name) group, deletes the rest.
-- Verified against production 2026-09-17: 966 total rows, 136 distinct
-- sites, 14 sites with duplicate phase names before this runs.

WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY site_id, name ORDER BY created_at ASC, id ASC
  ) AS rn
  FROM site_phases
)
DELETE FROM site_phases WHERE id IN (SELECT id FROM ranked WHERE rn > 1);
```

- [ ] **Step 3: Apply the migration**

Apply via the Supabase MCP `apply_migration` tool (name: `dedupe_site_phases`, project id `yyzbgdmgyvvypfcjuhtr`), passing the SQL above.

- [ ] **Step 4: Verify no duplicates remain**

```sql
SELECT COUNT(*) AS sites_with_dupes FROM (
  SELECT site_id FROM site_phases GROUP BY site_id, name HAVING COUNT(*) > 1
) x;
```
Expected: `0`.

```sql
SELECT COUNT(*) AS total_rows FROM site_phases;
```
Expected: fewer than 966 (exact number depends on how many extra rows each of the 14 sites had — just confirm it dropped and no site now has 0 phases: `SELECT COUNT(*) FROM sites s WHERE NOT EXISTS (SELECT 1 FROM site_phases sp WHERE sp.site_id = s.id)` should still be `0`).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/2026-09-17-01-dedupe-site-phases.sql
git commit -m "Remove duplicate site_phases rows from double-seed bug"
```

---

### Task 2: `useSitePhases()` hook

**Files:**
- Modify: `src/hooks/useSupabase.js`

**Interfaces:**
- Produces: `useSitePhases()` returning `{ data, loading, error, refetch }` (same shape as the file's existing `useQuery`-based hooks, e.g. `useLaborCost`), where `data` is every `site_phases` row across all sites, ordered `site_id, sort_order` — consumed by Task 4 (`GanttView.jsx`), Task 5 (`PhaseManageModal.jsx`), Task 7 (`SCurveChart.jsx`), Task 8 (`Sites.jsx`).

- [ ] **Step 1: Read the existing `useLaborCost` hook for the pattern to match**

Find it in `src/hooks/useSupabase.js` (search for `export function useLaborCost`) — it's the file's simplest `useQuery`-wrapped hook, e.g.:
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

- [ ] **Step 4: Verify the hook returns real, de-duplicated data**

Start the dev server (`npm run dev`), open the browser console on the Sites page, and run:
```js
fetch(`${import.meta.env.VITE_SUPABASE_URL}/rest/v1/site_phases?select=site_id,name&limit=1000`, {
  headers: { apikey: import.meta.env.VITE_SUPABASE_ANON_KEY }
}).then(r => r.json()).then(rows => {
  const seen = new Set()
  const dupes = rows.filter(r => { const k = r.site_id + r.name; if (seen.has(k)) return true; seen.add(k); return false })
  console.log('total rows:', rows.length, 'duplicate rows found:', dupes.length)
})
```
Expected: `duplicate rows found: 0` (confirms Task 1's cleanup took effect and this hook's query returns clean data).

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useSupabase.js
git commit -m "Add useSitePhases hook"
```

---

### Task 3: Gantt timeline + dependency-arrow math module

**Files:**
- Create: `src/pages/sites/ganttTimeline.js`

**Interfaces:**
- Produces: `computeTimelineRange(sites, phasesBySite) -> {start: Date, end: Date} | null`, `positionPercent(dateStr, range) -> number|null`, `barStyle(phase, range) -> {left: string, width: string}|null`, `computeDependencyArrows(phases, range) -> Array<{fromX: number, toX: number}>`, `STATUS_COLOR: {not_started, in_progress, done}` — consumed by Task 4 (`GanttView.jsx`).

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
//   "ติดตั้ง".depends_on_phase_id = "ผลิต".id -> arrow from x=47.4% to x=52.6%
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

/**
 * One site's phases -> arrow endpoints (in 0-100 x-coordinates) for every
 * phase whose depends_on_phase_id points at another phase that ALSO has
 * both dates set. Soft/informational only: a phase with no dependency, or
 * whose dependency has no dates yet, is silently skipped (no arrow drawn,
 * never an error).
 */
export function computeDependencyArrows(phases, range) {
  const byId = {}
  phases.forEach((p) => { byId[p.id] = p })
  const arrows = []
  phases.forEach((p) => {
    if (!p.depends_on_phase_id) return
    const dep = byId[p.depends_on_phase_id]
    if (!dep) return
    const depBar = barStyle(dep, range)
    const thisBar = barStyle(p, range)
    if (!depBar || !thisBar) return
    const fromX = parseFloat(depBar.left) + parseFloat(depBar.width)
    const toX = parseFloat(thisBar.left)
    arrows.push({ fromX, toX })
  })
  return arrows
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: built, no errors.

- [ ] **Step 3: Hand-verify against the worked example in the file's header comment**

With `range = { start: new Date('2026-08-01'), end: new Date('2026-08-20') }` (19 days):
- `positionPercent('2026-08-01', range)` → `0`
- `positionPercent('2026-08-10', range)` → `9/19*100` ≈ `47.4`
- `positionPercent('2026-08-11', range)` → `10/19*100` ≈ `52.6`
- `positionPercent('2026-08-20', range)` → `100`

For `computeDependencyArrows` with phases `[{id:1, start_date:'2026-08-01', end_date:'2026-08-10', depends_on_phase_id:null}, {id:2, start_date:'2026-08-11', end_date:'2026-08-20', depends_on_phase_id:1}]`: phase 2's bar has `left≈52.6, width≈47.4`; phase 1's bar has `left=0, width≈47.4`. Arrow = `{fromX: 0+47.4=47.4, toX: 52.6}` — matches the header comment. No code changes needed, this is a manual trace to catch arithmetic mistakes before Task 4 wires it in.

- [ ] **Step 4: Commit**

```bash
git add src/pages/sites/ganttTimeline.js
git commit -m "Add Gantt timeline positioning and dependency-arrow math"
```

---

### Task 4: `GanttView.jsx` component

**Files:**
- Create: `src/pages/sites/GanttView.jsx`

**Interfaces:**
- Consumes: `useSitePhases()` (Task 2), `computeTimelineRange`/`barStyle`/`computeDependencyArrows`/`STATUS_COLOR` (Task 3).
- Produces: `<GanttView sites={filteredSites} navigateTo={navigateTo} onManagePhases={(site) => void} selectedSiteId={string|null} onSelectSite={(siteId) => void} />` — consumed by Task 8 (`Sites.jsx`).

- [ ] **Step 1: Write the component**

`src/pages/sites/GanttView.jsx`:
```jsx
// ============================================================
// GanttView — 1 แถวต่อไซท์ แสดงแท่งขั้นตอนงานตามช่วงเวลา + ลูกศร dependency (soft)
// ============================================================
import { useMemo } from 'react'
import { useSitePhases } from '../../hooks/useSupabase.js'
import { computeTimelineRange, barStyle, computeDependencyArrows, STATUS_COLOR } from './ganttTimeline.js'

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
        const arrows = computeDependencyArrows(phases, range)
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
              {arrows.length > 0 && (
                <svg
                  style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
                  preserveAspectRatio="none" viewBox="0 0 100 28"
                >
                  {arrows.map((a, i) => (
                    <line
                      key={i}
                      x1={a.fromX} y1={14} x2={a.toX} y2={14}
                      stroke="var(--text3)" strokeWidth="0.6" strokeDasharray="1.5 1"
                    />
                  ))}
                </svg>
              )}
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

This is a throwaway check, not the final integration. In `src/pages/Sites.jsx`, temporarily add near the top of the file (after the existing imports):
```js
import GanttView from './sites/GanttView.jsx'
```
and temporarily render `<GanttView sites={filtered} navigateTo={navigateTo} onManagePhases={() => {}} selectedSiteId={null} onSelectSite={() => {}} />` right above the `{/* ── Table ── */}` comment. Run `npm run dev`, open the Sites page.

Expected: one row per visible site, each showing coloured bars for phases that have both dates set (freshly seeded phases have no dates yet, so bars are invisible until Task 5 lets you set them — expected, not a bug). Confirm clicking a site's name navigates to Assign (existing behavior), and the "📋 จัดการขั้นตอน" button is visible (does nothing yet — wired in Task 8).

- [ ] **Step 4: Revert the throwaway wiring**

Remove the temporary import and the temporary `<GanttView>` render added in Step 3. Confirm `git diff src/pages/Sites.jsx` shows no changes before moving on.

- [ ] **Step 5: Commit**

```bash
git add src/pages/sites/GanttView.jsx
git commit -m "Add GanttView component with dependency arrows"
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
// status ยังตั้งเองได้ตรงๆ ในเฟสนี้ (จะกลายเป็นค่าคำนวณจาก phase_tasks
// ในแผนถัดไปตอนทำ Kanban -- ดู docs/superpowers/specs/2026-09-17-site-gantt-kanban-design.md)
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
    { id: nextTempId(), site_id: site.id, name: '', sort_order: rs.length + 1, start_date: '', end_date: '', status: 'not_started', billing_weight_pct: 0, depends_on_phase_id: '' },
  ])
  const removeRow = (id) => setRows((rs) => rs.filter((r) => r.id !== id))

  const totalWeight = rows.reduce((s, r) => s + (parseFloat(r.billing_weight_pct) || 0), 0)

  const handleSave = async () => {
    setSaving(true)
    try {
      const clean = (r) => ({
        site_id: site.id,
        name: r.name,
        sort_order: r.sort_order,
        start_date: r.start_date || null,
        end_date: r.end_date || null,
        status: r.status,
        billing_weight_pct: parseFloat(r.billing_weight_pct) || 0,
        depends_on_phase_id: r.depends_on_phase_id || null,
      })
      const toUpdate = rows.filter((r) => r.id > 0).map((r) => ({ id: r.id, ...clean(r) }))
      const toInsert = rows.filter((r) => r.id < 0).map((r) => clean(r))
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
    <Modal title={`จัดการขั้นตอน: ${site.name}`} onClose={onClose} maxWidth={860}>
      <div className="modal-body" style={{ display: 'grid', gap: 10 }}>
        {rows.map((r) => (
          <div key={r.id} style={{ display: 'grid', gridTemplateColumns: '1.6fr 1fr 1fr 1fr 70px 1.3fr 32px', gap: 6, alignItems: 'center' }}>
            <input className="input input-sm" value={r.name} onChange={(e) => setRow(r.id, { name: e.target.value })} placeholder="ชื่อขั้นตอน" />
            <input type="date" className="input input-sm" value={r.start_date || ''} onChange={(e) => setRow(r.id, { start_date: e.target.value })} />
            <input type="date" className="input input-sm" value={r.end_date || ''} onChange={(e) => setRow(r.id, { end_date: e.target.value })} />
            <select className="select" value={r.status} onChange={(e) => setRow(r.id, { status: e.target.value })}>
              {STATUS_OPTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
            <input type="number" className="input input-sm" min="0" max="100" value={r.billing_weight_pct}
              onChange={(e) => setRow(r.id, { billing_weight_pct: e.target.value })} placeholder="%" />
            <select className="select" value={r.depends_on_phase_id || ''} onChange={(e) => setRow(r.id, { depends_on_phase_id: e.target.value })}>
              <option value="">— ไม่ขึ้นกับขั้นตอนอื่น —</option>
              {rows.filter((other) => other.id !== r.id && other.id > 0).map((other) => (
                <option key={other.id} value={other.id}>{other.name || '(ยังไม่ตั้งชื่อ)'}</option>
              ))}
            </select>
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

Note: the "ขึ้นกับ" (depends-on) dropdown only lists rows already saved (`other.id > 0`) — a brand-new unsaved row (`id < 0`) can't be selected as a dependency target until it's saved once, since there's no real `id` for it yet. This is an accepted limitation (soft feature, not core), not a bug to fix in this task.

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: built, no errors.

- [ ] **Step 3: Manual verification (after Task 8 wires this in)**

Deferred to Task 8 Step 4 — this component has no meaningful standalone render without a `site`/`phases` prop from the parent.

- [ ] **Step 4: Commit**

```bash
git add src/pages/sites/PhaseManageModal.jsx
git commit -m "Add PhaseManageModal component with dependency picker"
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
// Worked example used to hand-verify this file (see Task 7 Step 3):
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

Trace `buildPlanSeries` with the example phases: first phase (`ผลิต`, ends 2026-08-10, weight 30) contributes `0.30 * 1,000,000 = 300,000` → `{date:'2026-08-10', value:300000}`. Second phase (`ติดตั้ง`, ends 2026-08-20, weight 30) adds another `300,000` → `{date:'2026-08-20', value:600000}` — matches the header comment. Trace `buildActualSeries`: single income row → `{date:'2026-08-05', value:214000}`. Trace `buildCostSeries`: two expense rows → `{date:'2026-08-01', value:50000}`, `{date:'2026-08-15', value:80000}`. No code changes needed — this is a manual check to catch arithmetic mistakes before Task 7 wires it into a chart.

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
- Consumes: `useSitePhases()` (Task 2), `useIncomes`/`useExpenses` from `../../hooks/useSupabase.js` (existing, both accept `{ siteId }` — verified present 2026-09-17), `buildPlanSeries`/`buildActualSeries`/`buildCostSeries`/`mergeCumulativeSeries` (Task 6), `fmt` from `../../lib/supabase.js` (existing).
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

Deferred to Task 8 Step 4.

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

**Current file structure (verified 2026-09-17, cite exact lines when editing — re-check with `grep -n` first if this plan is executed much later, in case the file moved again):**
- Line 12: `import { useSites, useLaborCost, useClients, useSeatStatus, useCategories, useSiteCostEstimates, saveSiteCostEstimates } from '../hooks/useSupabase.js'`
- Line 428: `export default function Sites({ navigateTo, openSiteOverview }) {`
- Line 453: `const [sortDir, setSortDir] = useState('desc')`
- Lines 534–547: toolbar `<div>` (add/import/template buttons, search input, status filter buttons)
- Line 559: `{/* ── Table ── */}` comment, followed by `<div className="card"><div className="table-wrap"><table>...`
- Lines 692–694: table's closing `</table></div></div>`
- Line 696: `{/* ── Add/Edit Modal ── */}`

- [ ] **Step 1: Add imports**

Change line 12 from:
```js
import { useSites, useLaborCost, useClients, useSeatStatus, useCategories, useSiteCostEstimates, saveSiteCostEstimates } from '../hooks/useSupabase.js'
```
to:
```js
import { useSites, useLaborCost, useClients, useSeatStatus, useCategories, useSiteCostEstimates, saveSiteCostEstimates, useSitePhases } from '../hooks/useSupabase.js'
```
Then add three new import lines right after it:
```js
import GanttView from './sites/GanttView.jsx'
import PhaseManageModal from './sites/PhaseManageModal.jsx'
import SCurveChart from './sites/SCurveChart.jsx'
```

- [ ] **Step 2: Add state for view mode, selected site, and the phase-manage modal**

After line 453 (`const [sortDir, setSortDir] = useState('desc')`), add:
```js
const [viewMode,      setViewMode]      = useState('table') // 'table' | 'gantt'
const [selectedSiteId, setSelectedSiteId] = useState(null)
const [managePhasesSite, setManagePhasesSite] = useState(null) // site object or null
const { data: allPhases, refetch: refetchPhases } = useSitePhases()
```

- [ ] **Step 3: Add the view toggle and Gantt/S-curve branch**

In the toolbar `<div>` (lines 534–547), add a view toggle right after the status-filter buttons block (after the closing `</div>` of the `{['All', ...STATUS_OPTS].map(...)}` block, still inside the toolbar's outer `<div>`):
```jsx
<div style={{ display: 'flex', gap: 4 }}>
  <button className={`btn btn-sm ${viewMode === 'table' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setViewMode('table')}>📋 ตาราง</button>
  <button className={`btn btn-sm ${viewMode === 'gantt' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setViewMode('gantt')}>📊 Gantt</button>
</div>
```

Wrap the existing Table block in a condition. Change line 559-562 from:
```jsx
      {/* ── Table ── */}
      <div className="card">
        <div className="table-wrap">
          <table>
```
to:
```jsx
      {/* ── Table ── */}
      {viewMode === 'table' && (
      <div className="card">
        <div className="table-wrap">
          <table>
```

Change the closing (lines 692–695) from:
```jsx
          </table>
        </div>
      </div>

      {/* ── Add/Edit Modal ── */}
```
to:
```jsx
          </table>
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
1. Click "📊 Gantt" — table hides, Gantt rows appear (one per site, bars invisible for phases without dates yet).
2. Click "📋 จัดการขั้นตอน" on any site — modal opens showing its phases (7 rows, or fewer/more if manually edited later — should NOT show doubled rows, confirming Task 1's cleanup).
3. Set `start_date`/`end_date` on 2–3 phases, set one phase's "ขึ้นกับ" dropdown to point at an earlier phase, change one `status` to "กำลังทำ", save. Modal closes.
4. Confirm the Gantt row for that site now shows coloured bars positioned within the timeline, a dashed arrow connecting the dependency pair, and hovering a bar shows the tooltip (name, date range, status).
5. Click the site's row (not its name, not the manage button) — confirm an S-curve panel appears below with 3 lines ("แผนเบิกเงิน", "เบิกจริง", "ต้นทุนเรา"). If the site has no `incomes`/`expenses` rows yet, those two lines sit flat at 0 while "แผนเบิกเงิน" steps up at the phase end-dates you set — cross-check one step's height against `billing_weight_pct / 100 * contract_value` for that site.
6. Click "📋 ตาราง" — confirm it switches back cleanly and the existing table still works exactly as before (status filter, search, sort, edit, complete, delete all still functioning — confirms this task's changes didn't regress the pre-existing table).

- [ ] **Step 5: Commit**

```bash
git add src/pages/Sites.jsx
git commit -m "Wire Gantt view, phase management, and S-curve into Sites page"
```
