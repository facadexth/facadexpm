# Site Detail Page (Gantt+Kanban spec addendum) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the read-only `SiteOverviewModal` popup and the current list-embedded per-site Gantt management (`PhaseManageModal`, inline S-curve) with a real per-site detail page (`SiteDetail.jsx`, tabs: ภาพรวม / 📅 Gantt), reached by clicking a site's name in the Sites table. The Sites list's own "📊 Gantt" toggle becomes a read-only portfolio overview only — no more phase editing or S-curve drill-down from that view.

**Architecture:** Extract `SiteOverviewModal`'s inner content into a new presentational component (`SiteOverviewContent.jsx`) so both the modal (still used unmodified at its other 10 existing call sites) and the new page can render identical content without duplicating logic. The new page is a hidden route (`site_detail`) reached via the app's existing `navigateTo(tab, state)` pattern — not added to the visible nav (`TABS`), but added to the permission-gate list (`ALL_TAB_ENTRIES`) so it still gets a real ADMIN-level gate rather than silently falling back to Dashboard's looser one. `GanttView`/`SCurveChart`/`PhaseManageModal` (built in the prior plan) are reused as-is, scoped to a single site by passing `sites={[site]}`.

**Tech Stack:** React (existing), Supabase (existing). No new dependencies.

**Spec:** Design approved in chat during this session (not a separate written spec doc — this is a Bounded-scope addendum to [`docs/superpowers/specs/2026-09-17-site-gantt-kanban-design.md`](../specs/2026-09-17-site-gantt-kanban-design.md), which already covers the underlying Gantt/S-curve/PhaseManageModal components this plan reuses).

## Global Constraints

- No test runner exists in this repo — wait, this repo DOES have `vitest` (`npm test`, confirmed 163 passing tests on this branch as of the prior plan's finish). Run `npm test` after each task; it should stay green (this codebase's existing tests don't cover Sites.jsx/App.jsx routing directly, so a pass here means "no regression," not "this feature is covered" — manual/browser verification is still required per-task as specified below).
- `SiteOverviewModal.jsx` has 10 other call sites (`Assign.jsx`, `Income.jsx`, `Invoices.jsx`, `LaborContractors.jsx`, `Expenses.jsx`, `Quotations.jsx`, `PurchaseOrders.jsx`, `Deposits.jsx`, `Dashboard.jsx`, `Retention.jsx`) besides `Sites.jsx` — none of those 10 may change behavior. Only `Sites.jsx`'s own site-name click changes.
- The extracted `SiteOverviewContent` component must keep the original's `isAdmin` (`useUserRole().isAtLeast('ADMIN')`) safety check internally — this is defense-in-depth on top of the new page's own router-level ADMIN gate, matching the original file's explicit comment about this data never being shown to WORKER role.
- Follow existing style: inline `style={{...}}` plus theme CSS variables.
- Supabase project id (if any live queries need checking): `yyzbgdmgyvvypfcjuhtr`.

---

### Task 1: Extract `SiteOverviewContent.jsx` from `SiteOverviewModal.jsx`

**Files:**
- Create: `src/components/SiteOverviewContent.jsx`
- Modify: `src/components/SiteOverviewModal.jsx`

**Interfaces:**
- Produces: `<SiteOverviewContent siteId={string} />` — a presentational component with no `Modal` wrapper, no `onClose` — consumed by Task 2 (`SiteDetail.jsx`) and by this task's own updated `SiteOverviewModal.jsx`.
- Consumes (unchanged from the original file): `useSiteOverview`, `useSiteExpensesByCategory`, `useQuotations` from `../hooks/useSupabase.js`; `calcQuotationTotals` from `../lib/quotationCalc.js`; `fmt`, `fmtDate` from `../lib/supabase.js`; `depositStatusFor` from `../lib/depositCalc.js`; `retentionStatusFor` from `../lib/retentionStatus.js`; `CATEGORY_PALETTE`, `OTHER_LABEL`, `OTHER_COLOR`, `categoryBreakdown`, `groupSmallSlices` from `../lib/expenseChart.js`; `CategoryPieTooltip` from `./CategoryPieTooltip.jsx`; `useUserRole` from `../hooks/useUserRole.js`.

- [ ] **Step 1: Write `SiteOverviewContent.jsx`**

This is a mechanical extraction — move the existing modal's data-fetching, computation, and JSX body (everything currently inside `<div className="modal-body">...</div>`) into a new component, unchanged, minus the `Modal` wrapper and the footer close button.

`src/components/SiteOverviewContent.jsx`:
```jsx
// ============================================================
// SiteOverviewContent -- presentational body for one site's financial
// overview (contract/deposit/retention/expense breakdown). Extracted from
// SiteOverviewModal so both the popup (10 other call sites, unchanged)
// and the SiteDetail page can render identical content without
// duplicating fetch/compute logic in two places that could drift.
// ADMIN+ only -- kept as an internal check here too (defense-in-depth,
// on top of whatever gate the caller itself has).
// ============================================================
import { useMemo, useState } from 'react'
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts'
import { useSiteOverview, useSiteExpensesByCategory, useQuotations } from '../hooks/useSupabase.js'
import { calcQuotationTotals } from '../lib/quotationCalc.js'
import { fmt, fmtDate } from '../lib/supabase.js'
import { depositStatusFor } from '../lib/depositCalc.js'
import { retentionStatusFor } from '../lib/retentionStatus.js'
import { useUserRole } from '../hooks/useUserRole.js'
import { CATEGORY_PALETTE, OTHER_LABEL, OTHER_COLOR, categoryBreakdown, groupSmallSlices } from '../lib/expenseChart.js'
import CategoryPieTooltip from './CategoryPieTooltip.jsx'

export default function SiteOverviewContent({ siteId }) {
  const { isAtLeast } = useUserRole()
  const isAdmin = isAtLeast('ADMIN')
  const { data: site, error } = useSiteOverview(isAdmin ? siteId : null)
  const { data: siteExpenses } = useSiteExpensesByCategory(isAdmin ? siteId : null)
  const categoryData = useMemo(() => groupSmallSlices(categoryBreakdown(siteExpenses)), [siteExpenses])

  const [showContractBreakdown, setShowContractBreakdown] = useState(false)
  const { data: siteQuotations } = useQuotations(
    isAdmin && site?.id ? { siteId: site.id, status: 'accepted' } : { status: '__none__' }
  )
  const contractBreakdown = useMemo(() => (siteQuotations || [])
    .map(q => ({
      id: q.id, quotation_number: q.quotation_number, date: q.date,
      total: calcQuotationTotals(q.quotation_items, {
        hasVat: q.has_vat, priceIncludesVat: q.price_includes_vat,
        discountAmount: q.discount_amount, discountPct: q.discount_pct,
      }).total,
    }))
    .sort((a, b) => (a.date || '').localeCompare(b.date || '')), [siteQuotations])

  if (!isAdmin) return null

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {error ? (
        <div style={{ color: 'var(--red)', fontSize: 13 }}>โหลดข้อมูลไม่สำเร็จ: {error}</div>
      ) : !site ? (
        <div style={{ color: 'var(--text3)', fontSize: 13 }}>กำลังโหลด...</div>
      ) : (
        <>
          <div>
            <span className={`badge badge-status-${site.status?.toLowerCase().replace(' ', '-')}`}>{site.status}</span>
          </div>

          <div className="form-grid-3">
            <div>
              <div style={{ fontSize: 11, color: 'var(--text3)' }}>มูลค่าสัญญา</div>
              <div className="font-mono" style={{ fontWeight: 700 }}>{fmt(site.contract_value)}</div>
              {contractBreakdown.length > 1 && (
                <>
                  <button type="button" onClick={() => setShowContractBreakdown(v => !v)}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11, color: 'var(--accent)', cursor: 'pointer', background: 'none', border: 'none', padding: 0, marginTop: 5, fontFamily: 'inherit' }}>
                    ดูรายละเอียด ({contractBreakdown.length} ใบเสนอราคา)
                    <span style={{ display: 'inline-block', transition: 'transform .15s', transform: showContractBreakdown ? 'rotate(180deg)' : 'none' }}>▾</span>
                  </button>
                  {showContractBreakdown && (
                    <div style={{ marginTop: 8, display: 'grid', gap: 5 }}>
                      {contractBreakdown.map(q => (
                        <div key={q.id} style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, alignItems: 'center', background: 'var(--bg3)', borderRadius: 7, padding: '7px 10px', fontSize: 12 }}>
                          <div>
                            <div style={{ fontWeight: 600 }}>{q.quotation_number}</div>
                            <div style={{ fontSize: 10, color: 'var(--text3)' }}>รับเข้าไซท์งาน {fmtDate(q.date)}</div>
                          </div>
                          <div className="font-mono" style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{fmt(q.total)}</div>
                        </div>
                      ))}
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, borderTop: '1px dashed var(--border)', paddingTop: 8, marginTop: 2 }}>
                        <div style={{ color: 'var(--accent)', fontWeight: 800, fontSize: 12.5 }}>รวม</div>
                        <div className="font-mono" style={{ color: 'var(--accent)', fontWeight: 800, fontSize: 13.5 }}>{fmt(site.contract_value)}</div>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
            <div>
              <div style={{ fontSize: 11, color: 'var(--text3)' }}>รายรับ</div>
              <div className="font-mono" style={{ fontWeight: 700, color: 'var(--green)' }}>{fmt(site.total_income)}</div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: 'var(--text3)' }}>รายจ่าย</div>
              <div className="font-mono" style={{ fontWeight: 700, color: 'var(--red)' }}>{fmt(site.total_expense)}</div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: 'var(--text3)' }}>กำไร</div>
              <div className="font-mono" style={{ fontWeight: 700, color: (site.gross_profit || 0) >= 0 ? 'var(--green)' : 'var(--red)' }}>{fmt(site.gross_profit)}</div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: 'var(--text3)' }}>ค่าแรงพนักงาน</div>
              <div className="font-mono" style={{ fontWeight: 700 }}>{fmt(site.worker_labor_cost)}</div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: 'var(--text3)' }}>% เบิก</div>
              <div className="font-mono" style={{ fontWeight: 700 }}>{site.billing_pct != null ? `${site.billing_pct.toFixed(1)}%` : '—'}</div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: 'var(--text3)' }}>วันจบงาน</div>
              <div style={{ fontSize: 12 }}>{site.end_date ? fmtDate(site.end_date) : '—'}</div>
            </div>
          </div>

          {site.deposit?.total_deposit > 0 && (
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text3)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1 }}>
                💰 มัดจำ
              </div>
              <div className="form-grid-3">
                <div>
                  <div style={{ fontSize: 11, color: 'var(--text3)' }}>เก็บมัดจำ</div>
                  <div className="font-mono" style={{ fontWeight: 700 }}>{fmt(site.deposit.total_deposit)}</div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--text3)' }}>หักไปแล้ว</div>
                  <div className="font-mono" style={{ color: 'var(--yellow)' }}>{fmt(site.deposit.total_deducted)}</div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--text3)' }}>คงเหลือ</div>
                  <div className="font-mono" style={{ fontWeight: 700, color: 'var(--green)' }}>{fmt(site.deposit.remaining_balance)}</div>
                </div>
              </div>
              <div style={{ marginTop: 6 }}>
                <span className={`badge ${depositStatusFor(site.deposit).cls}`}>{depositStatusFor(site.deposit).label}</span>
              </div>
            </div>
          )}

          {site.retention?.total_retention > 0 && (
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text3)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1 }}>
                🔒 Retention
              </div>
              <div className="form-grid-3">
                <div>
                  <div style={{ fontSize: 11, color: 'var(--text3)' }}>ยอด Retention</div>
                  <div className="font-mono" style={{ fontWeight: 700 }}>{fmt(site.retention.total_retention)}</div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--text3)' }}>วันครบกำหนด</div>
                  <div style={{ fontSize: 12 }}>{!site.retention.end_date ? 'รอจบงาน' : (site.retention.due_date ? fmtDate(site.retention.due_date) : '—')}</div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--text3)' }}>สถานะ</div>
                  <span className={`badge ${retentionStatusFor(site.retention).cls}`}>{retentionStatusFor(site.retention).label}</span>
                </div>
              </div>
            </div>
          )}

          {categoryData.length > 0 && (
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text3)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1 }}>
                📊 ค่าใช้จ่ายตามหมวด
              </div>
              <ResponsiveContainer width="100%" height={220}>
                <PieChart>
                  <Pie data={categoryData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={75} label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}>
                    {categoryData.map((d, i) => <Cell key={i} fill={d.name === OTHER_LABEL ? OTHER_COLOR : CATEGORY_PALETTE[i % CATEGORY_PALETTE.length]} />)}
                  </Pie>
                  <Tooltip content={<CategoryPieTooltip />} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          )}
        </>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Rewrite `SiteOverviewModal.jsx` to delegate to the new component**

Replace the entire file with a thin wrapper that keeps its exact same external API (`{ siteId, onClose }`) so all 10 other call sites need zero changes:

```jsx
// ============================================================
// SiteOverviewModal -- popup summary for one site: contract/financials +
// มัดจำ (deposit) + retention, opened by clicking a site name in most of
// the app (Sites.jsx itself now navigates to a full SiteDetail page
// instead -- see src/pages/SiteDetail.jsx). Read-only; no edit actions.
// ============================================================
import { Modal } from './Modal.jsx'
import { useSiteOverview } from '../hooks/useSupabase.js'
import SiteOverviewContent from './SiteOverviewContent.jsx'

export default function SiteOverviewModal({ siteId, onClose }) {
  const { data: site } = useSiteOverview(siteId)
  return (
    <Modal title={site ? `${site.site_number} · ${site.name}` : 'ไซท์งาน'} onClose={onClose} maxWidth={560}>
      <div className="modal-body">
        <SiteOverviewContent siteId={siteId} />
      </div>
      <div className="modal-footer">
        <button className="btn btn-ghost" onClick={onClose}>ปิด</button>
      </div>
    </Modal>
  )
}
```

Note: this re-fetches `useSiteOverview(siteId)` once here purely to build the title string (existing behavior — the original file did the exact same fetch for the exact same reason), and `SiteOverviewContent` does its own separate fetch of the same data for the body. This is a small, acceptable duplication (one extra cheap single-row query, only while the modal is open) — not the same class of problem as the prior plan's Gantt/S-curve triple-fetch, since this is not simultaneously mounted 3 times on one page.

- [ ] **Step 3: Verify build**

Run: `npm run build` → Expected: built, no errors.
Run: `npm test` → Expected: 163 passed (unchanged).

- [ ] **Step 4: Live verification that the 10 existing modal callers still work identically**

Start `npm run dev`, load the browser tools (`ToolSearch` with query `"select:mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__computer,mcp__claude-in-chrome__tabs_create_mcp,mcp__claude-in-chrome__tabs_close_mcp,mcp__claude-in-chrome__read_console_messages"` if needed). Pick at least 2 of the 10 unchanged call sites (e.g. `Assign.jsx` and `Expenses.jsx` — check via `grep -n openSiteOverview` in each for the exact trigger element) and confirm clicking a site name there still opens the exact same popup with the exact same content as before (badge, financial grid, deposit/retention sections if applicable, expense pie chart). Check console for errors. This is the highest-risk step in this task — a mistake in the extraction would silently break 10 pages, not just the 1 you're actively changing.

- [ ] **Step 5: Commit**

```bash
git add src/components/SiteOverviewContent.jsx src/components/SiteOverviewModal.jsx
git commit -m "Extract SiteOverviewContent from SiteOverviewModal for reuse in SiteDetail page"
```

---

### Task 2: `SiteDetail.jsx` page

**Files:**
- Create: `src/pages/SiteDetail.jsx`

**Interfaces:**
- Consumes: `SiteOverviewContent` (Task 1), `GanttView`/`PhaseManageModal`/`SCurveChart` from `./sites/` (existing, from the prior plan), `useSites` or a way to resolve `site_number`/`contract_value` etc. for the single site (check `useSupabase.js` for a hook that returns one site's full row — `useSiteOverview(siteId)` already returns a rich row per Task 1's read of the original modal; reuse that same hook here rather than introducing a new one, since it already has everything `GanttView`/`SCurveChart`/`PhaseManageModal` need: `id`, `name`, `site_number`, `contract_value`).
- Produces: `<SiteDetail navState={{siteId, siteName}} navigateTo={fn} />` — consumed by Task 3 (`App.jsx`'s new `site_detail` case).

- [ ] **Step 1: Write the component**

`src/pages/SiteDetail.jsx`:
```jsx
// ============================================================
// SiteDetail -- per-site page (ภาพรวม / Gantt tabs). Reached via
// navigateTo('site_detail', { siteId, siteName }) from Sites.jsx's site
// name click. Not a visible nav tab -- see App.jsx's ALL_TAB_ENTRIES.
// ============================================================
import { useState } from 'react'
import { useSiteOverview } from '../hooks/useSupabase.js'
import { useUserRole } from '../hooks/useUserRole.js'
import { canEditPage } from '../lib/permissions.js'
import SiteOverviewContent from '../components/SiteOverviewContent.jsx'
import GanttView from './sites/GanttView.jsx'
import PhaseManageModal from './sites/PhaseManageModal.jsx'
import SCurveChart from './sites/SCurveChart.jsx'
import { useSitePhases } from '../hooks/useSupabase.js'

export default function SiteDetail({ navState, navigateTo }) {
  const siteId = navState?.siteId
  const siteName = navState?.siteName
  const [tab, setTab] = useState('overview') // 'overview' | 'gantt'
  const [showManageModal, setShowManageModal] = useState(false)
  const [phasesRefreshKey, setPhasesRefreshKey] = useState(0)

  const { isAtLeast, role } = useUserRole()
  const canEdit = isAtLeast('ADMIN') && canEditPage(role, 'sites')

  const { data: site } = useSiteOverview(siteId)
  const { data: allPhases, refetch: refetchPhases } = useSitePhases()

  if (!siteId) {
    return (
      <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--text3)' }}>
        ไม่พบไซท์งานที่เลือก — <button className="btn btn-sm btn-ghost" onClick={() => navigateTo('sites')}>กลับไปหน้าไซท์งาน</button>
      </div>
    )
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <button className="btn btn-sm btn-ghost" onClick={() => navigateTo('sites')}>← ไซท์งานทั้งหมด</button>
      </div>
      <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 14 }}>
        {site?.site_number ? `${site.site_number} · ` : ''}{site?.name || siteName || 'ไซท์งาน'}
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
        <button
          className={`btn btn-sm ${tab === 'overview' ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => setTab('overview')}
        >ภาพรวม</button>
        <button
          className={`btn btn-sm ${tab === 'gantt' ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => setTab('gantt')}
        >📅 Gantt</button>
      </div>

      {tab === 'overview' && <SiteOverviewContent siteId={siteId} />}

      {tab === 'gantt' && site && (
        <>
          <GanttView
            key={phasesRefreshKey}
            sites={[site]}
            navigateTo={navigateTo}
            onManagePhases={() => setShowManageModal(true)}
            selectedSiteId={site.id}
            onSelectSite={() => {}}
            canEdit={canEdit}
          />
          <div style={{ marginTop: 16 }}>
            <SCurveChart key={phasesRefreshKey} site={site} />
          </div>
        </>
      )}

      {showManageModal && site && (
        <PhaseManageModal
          site={site}
          phases={(allPhases || []).filter((p) => p.site_id === site.id)}
          onClose={() => setShowManageModal(false)}
          onSaved={() => { refetchPhases(); setPhasesRefreshKey((k) => k + 1) }}
        />
      )}
    </div>
  )
}
```

`canEditPage(role, pageKey)` (verified in `src/lib/permissions.js:170`) and the `isAtLeast('ADMIN') && canEditPage(role, 'sites')` combination above are copied exactly from `Sites.jsx:432-433`'s own `canEdit` computation — no need to re-derive this, just match it verbatim as shown.

- [ ] **Step 2: Verify build**

Run: `npm run build` → Expected: built, no errors (this will fail until Task 3 wires the route, if `SiteDetail.jsx` has any import path typos — the build only fails on things actually reachable from an entry point, so a plain build might succeed even with an unwired, unreferenced file; don't rely on this alone — Task 3's wiring is where real verification happens).

- [ ] **Step 3: Commit**

```bash
git add src/pages/SiteDetail.jsx
git commit -m "Add SiteDetail page (ภาพรวม + Gantt tabs for one site)"
```

---

### Task 3: Wire `site_detail` into `App.jsx`'s routing

**Files:**
- Modify: `src/App.jsx`

**Interfaces:**
- Consumes: `SiteDetail` (Task 2).

- [ ] **Step 1: Add the lazy import**

Near the other `lazy(() => import('./pages/...'))` lines (search for `const Sites` to find the right spot), add:
```js
const SiteDetail          = lazy(() => import('./pages/SiteDetail.jsx'))
```

- [ ] **Step 2: Add a hidden gate entry — do NOT add this to the visible `TABS` array**

Find `const ALL_TAB_ENTRIES = TABS.flatMap(t => t.children ?? [t])` (search for it). This is the ONLY place page-level permission gates come from (per the comment directly above `renderPage`'s gate lookup) — `visibleTabs` (the actual rendered nav bar) is computed separately, directly from `TABS`, so anything added only to `ALL_TAB_ENTRIES` and not to `TABS` gets a real gate without ever appearing in the nav. Change it to:

```js
// Hidden routes: reachable only via navigateTo(), never shown in the nav
// bar (not in TABS), but still need a real gate here or renderPage's
// ALL_TAB_ENTRIES.find(...) ?? ALL_TAB_ENTRIES[0] fallback would silently
// grant them Dashboard's (WORKER-level) gate instead of their own.
const HIDDEN_TAB_ENTRIES = [
  { id: 'site_detail', minRole: 'ADMIN', module: null },
]
const ALL_TAB_ENTRIES = TABS.flatMap(t => t.children ?? [t]).concat(HIDDEN_TAB_ENTRIES)
```

- [ ] **Step 3: Add the switch case**

In `renderPage`'s `switch (activeTab)` block (search for `case 'sites':`), add right after it:
```jsx
        case 'site_detail': return <SiteDetail {...props} />
```

- [ ] **Step 4: Verify build**

Run: `npm run build` → Expected: built, no errors.

- [ ] **Step 5: Verify via build + code read-through**

There is no real UI trigger into `site_detail` yet — Task 4 adds the site-name click that actually reaches it, and Task 4's Step 5 does the full live browser walkthrough of this route (page renders, tabs work, gating). For this task, verification is: `npm run build` succeeded (Step 4), plus re-read your own diff for Steps 1-3 against the actual current file content one more time — confirm `HIDDEN_TAB_ENTRIES` is concatenated into `ALL_TAB_ENTRIES` (not `TABS`), confirm the `site_detail` case was added inside the existing `switch (activeTab)` block and not accidentally outside it, and confirm the lazy import path matches the real file location (`./pages/SiteDetail.jsx`, matching Task 2's file exactly).

- [ ] **Step 6: Commit**

```bash
git add src/App.jsx
git commit -m "Add hidden site_detail route with its own ADMIN gate"
```

---

### Task 4: Update `Sites.jsx` — name-click target and simplified portfolio Gantt view

**Files:**
- Modify: `src/pages/Sites.jsx`

**Interfaces:**
- Consumes: nothing new (uses `navigateTo`, already a prop).

- [ ] **Step 1: Change the site-name click handler**

Find the site-name cell in the table (search for `onClick={() => openSiteOverview(s.id)}`). Change it to:
```jsx
onClick={() => navigateTo('site_detail', { siteId: s.id, siteName: s.name })}
```
Leave everything else about that cell (the `LinkIcon`, styling) unchanged.

- [ ] **Step 2: Simplify the "📊 Gantt" toggle view to drop per-site management**

Find the `{viewMode === 'gantt' && (...)}` block (search for `viewMode === 'gantt'`). It currently renders `<GanttView>` with `onManagePhases={(site) => setManagePhasesSite(site)}` and, below it, a conditional `<SCurveChart>` for whatever site is selected. Per this task's goal, the portfolio Gantt view becomes read-only overview only — remove the management/drill-down affordances:

Change:
```jsx
      {viewMode === 'gantt' && (
        <>
          <GanttView
            key={phasesRefreshKey}
            sites={filtered}
            navigateTo={navigateTo}
            onManagePhases={(site) => setManagePhasesSite(site)}
            selectedSiteId={selectedSiteId}
            onSelectSite={setSelectedSiteId}
            canEdit={canEdit}
          />
          {(() => {
            const selectedSite = filtered.find((s) => s.id === selectedSiteId)
            return selectedSite && (
              <div style={{ marginTop: 16 }}>
                <SCurveChart key={phasesRefreshKey} site={selectedSite} />
              </div>
            )
          })()}
        </>
      )}

      {managePhasesSite && (
        <PhaseManageModal
          site={managePhasesSite}
          phases={(allPhases || []).filter((p) => p.site_id === managePhasesSite.id)}
          onClose={() => setManagePhasesSite(null)}
          onSaved={() => { refetchPhases(); setPhasesRefreshKey((k) => k + 1) }}
        />
      )}
```
to:
```jsx
      {viewMode === 'gantt' && (
        <GanttView
          sites={filtered}
          navigateTo={navigateTo}
          onManagePhases={(site) => navigateTo('site_detail', { siteId: site.id, siteName: site.name })}
          selectedSiteId={null}
          onSelectSite={() => {}}
          canEdit={false}
        />
      )}
```
Rationale for each change: `onManagePhases` now navigates to the site's detail page (where phase management actually lives) instead of opening a modal inline — this doubles as the "portfolio view's own way to jump into one site," so the affordance isn't lost, just relocated to be consistent with the rest of this plan. `selectedSiteId`/`onSelectSite` are neutered (`null`/no-op) since row-click-to-select no longer does anything in this simplified view (no S-curve panel to reveal here anymore) — `GanttView` still accepts these props without them being wired to real state, it just never highlights a row. `canEdit={false}` is passed explicitly (rather than omitted) so `GanttView`'s "📋 จัดการขั้นตอน" button never renders here at all — since it's being replaced by the "go to site detail" behavior, keep it hidden in the portfolio view rather than misleadingly implying you can manage phases inline anymore. **Do not delete the `onManagePhases` line entirely** — `GanttView`'s existing code calls `onManagePhases(site)` from its own button, and while that button is now hidden via `canEdit={false}`, the prop is still required by `GanttView`'s signature (avoid a missing-prop runtime error if `canEdit` were ever toggled some other way later); keep it as a real, working handler even though it's currently unreachable through this view's UI.

- [ ] **Step 3: Remove now-unused state**

`managePhasesSite`, `setManagePhasesSite`, `selectedSiteId`, `setSelectedSiteId`, `phasesRefreshKey`, `setPhasesRefreshKey`, and the `<PhaseManageModal>` import may now be entirely unused in `Sites.jsx` — check with a careful read (search each identifier) and remove any that have zero remaining references, to avoid dead code / unused-variable lint noise. Do NOT remove `allPhases`/`refetchPhases`/`useSitePhases` import if `GanttView` (or anything else still in this file) still needs `allPhases` for something — re-check before deleting; if `GanttView` alone needs `useSitePhases()` internally (it does, from the prior plan — it calls the hook itself), then `Sites.jsx`'s own top-level `useSitePhases()` call may ALSO become fully unused and removable. Trace every reference carefully rather than assuming.

- [ ] **Step 4: Verify build**

Run: `npm run build` → Expected: built, no errors, and no new "unused variable" warnings introduced by leftover dead state from Step 3.
Run: `npm test` → Expected: 163 passed.

- [ ] **Step 5: Full live browser walkthrough**

Start `npm run dev`, load browser tools. Walk through:
1. On the Sites page (table view), click a site's name — confirm it navigates to the new `SiteDetail` page, showing the site's name/number header, "ภาพรวม"/"📅 Gantt" tab buttons, and the ภาพรวม tab's content matches what the old popup used to show (compare against Task 1's verification, same site if convenient).
2. Click "📅 Gantt" tab — confirm the Gantt bar (or empty-timeline message if this site has no dated phases) and S-curve render for just this one site.
3. If `canEdit` is true for your test role, click "📋 จัดการขั้นตอน" — confirm the phase modal opens, scoped to this one site, and saving updates the Gantt/S-curve on this page without needing a reload (same `phasesRefreshKey` remount pattern as the prior plan).
4. Click "← ไซท์งานทั้งหมด" — confirm it returns to the Sites list.
5. Back on the Sites list, click "📊 Gantt" toggle — confirm it still shows all sites' rows, but there is no longer a way to open a phase-management modal or an inline S-curve directly from this view (no "จัดการขั้นตอน" button visible, clicking a row does nothing visible).
6. Click "📋 ตาราง" — confirm the table itself, plus site-name-click (now going to SiteDetail), search, sort, and all pre-existing row actions still work.
7. Check browser console for errors after each step.

- [ ] **Step 6: Commit**

```bash
git add src/pages/Sites.jsx
git commit -m "Route site name clicks to SiteDetail page; simplify portfolio Gantt to read-only"
```
