# Site Overview Modal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clicking a site's name anywhere it appears (9 pages) opens a read-only popup showing that site's financial summary plus its มัดจำ (deposit) and retention status together.

**Architecture:** One new hook (`useSiteOverview`) merges three existing views (`site_financial_summary`, `site_deposit_summary`, `site_retention_summary`) for a single site. One new component (`SiteOverviewModal.jsx`) renders it inside the existing `Modal` wrapper. The modal's open/close state lives in `App.jsx` (mirroring the existing `ChangePassword` modal) and an `openSiteOverview` function is added to the `props` object every page already receives, so each page only needs to call the prop — no per-page modal state. Wiring the actual click handler into each of the 9 site-name locations is split into 4 tasks by natural grouping, after the shared foundation (hook + modal + App.jsx + first page) lands in Task 1.

**Tech Stack:** React 18 + Vite, Supabase (existing views only — no schema change).

## Global Constraints

- **WORKER role must never see this modal.** `site_financial_summary`/`site_deposit_summary`/`site_retention_summary` all carry money figures (contract value, income, expense, profit, deposit, retention) that WORKER role has never been shown anywhere else in this app (`sites_progress`, the one WORKER-facing site view, deliberately excludes all money columns — see its comment in `supabase/schema.sql`). Per explicit user decision, only wire the click handler into site-name displays that are already gated to ADMIN+ (directly, or inside an existing `canEdit`/`isAtLeast('ADMIN')` conditional). **`Dashboard.jsx`'s `WorkerSiteProgress` component (the card grid shown to WORKER role) must NOT get this wiring** — its site names stay non-clickable, exactly as today. Only `Dashboard.jsx`'s ADMIN-only `ongoingSites` table (rendered in the main `Dashboard` component body, not `WorkerSiteProgress`) gets wired.
- The modal is read-only — no edit actions, no cost breakdown, no attachments. If a task's page has a `canEdit`-style variable already computed, that's irrelevant to this modal (it never edits); it only matters for confirming a given site-name location is ADMIN-only-visible per the constraint above.
- Reuse existing status logic, don't duplicate it: Task 1 extracts `Retention.jsx`'s inline `statusFor` into a shared `src/lib/retentionStatus.js` (`retentionStatusFor`), and `Deposits.jsx`'s inline `statusFor` into `src/lib/depositCalc.js` (`depositStatusFor`), so both the existing pages and the new modal call the same function instead of two copies of the same label/class logic.
- No new database views or columns.

---

### Task 1: `useSiteOverview` hook, `SiteOverviewModal`, App.jsx wiring, and Sites.jsx

**Files:**
- Modify: `src/hooks/useSupabase.js`
- Create: `src/lib/retentionStatus.js`
- Modify: `src/pages/Retention.jsx`
- Modify: `src/lib/depositCalc.js`
- Modify: `src/pages/Deposits.jsx`
- Create: `src/components/SiteOverviewModal.jsx`
- Modify: `src/App.jsx`
- Modify: `src/pages/Sites.jsx`

**Interfaces:**
- Produces (used by Tasks 2-4):
  - `openSiteOverview(id)` — added to the `props` object every page receives in `App.jsx`'s `renderPage()`. Calling it with a site's `id` opens the modal for that site.
  - `export function useSiteOverview(siteId)` in `src/hooks/useSupabase.js` — returns `{ data, loading, error, refetch }` where `data` is `null` (no `siteId`) or `{ ...site_financial_summary row, deposit: site_deposit_summary row, retention: site_retention_summary row }`.
  - `export function retentionStatusFor(row)` in `src/lib/retentionStatus.js` — `(row: {retention_released, end_date, due_date}) => {label, cls}`.
  - `export function depositStatusFor(row)` in `src/lib/depositCalc.js` — `(row: {remaining_balance}) => {label, cls}`.

- [ ] **Step 1: Add the `useSiteOverview` hook**

In `src/hooks/useSupabase.js`, immediately after `useSiteDepositBalance` (currently ends right before the `// ── Expenses ─────` comment), add:

```js
/**
 * useSiteOverview: one site's full picture for the Site Overview modal --
 * merges site_financial_summary (contract/income/expense/profit) with
 * nested .deposit (site_deposit_summary row) and .retention
 * (site_retention_summary row) for the same site, fetched in parallel.
 */
export function useSiteOverview(siteId) {
  return useQuery(async () => {
    if (!siteId) return null
    const [siteRes, depositRes, retentionRes] = await Promise.all([
      supabase.from('site_financial_summary').select('*').eq('id', siteId).single(),
      supabase.from('site_deposit_summary').select('*').eq('site_id', siteId).single(),
      supabase.from('site_retention_summary').select('*').eq('site_id', siteId).single(),
    ])
    if (siteRes.error) throw siteRes.error
    if (depositRes.error) throw depositRes.error
    if (retentionRes.error) throw retentionRes.error
    return { ...siteRes.data, deposit: depositRes.data, retention: retentionRes.data }
  }, [siteId])
}
```

- [ ] **Step 2: Extract retention status logic into a shared module**

Create `src/lib/retentionStatus.js`:
```js
// ============================================================
// Retention status label + badge class -- shared between the Retention
// summary tab and the Site Overview modal so both agree on what each
// status means and which badge class it maps to.
// ============================================================
export function retentionStatusFor(row) {
  if (row.retention_released) return { label: 'คืนแล้ว', cls: 'badge-paid' }
  if (!row.end_date) return { label: 'รอจบงาน', cls: 'badge-pending' }
  if (!row.due_date) return { label: 'ยังไม่ได้ตั้งระยะเวลา', cls: 'badge-pending' }
  const today = new Date().toISOString().slice(0, 10)
  if (row.due_date < today) return { label: 'เกินกำหนด', cls: 'badge-status-cancelled' }
  const in30 = new Date()
  in30.setDate(in30.getDate() + 30)
  if (row.due_date <= in30.toISOString().slice(0, 10)) return { label: 'ใกล้ครบกำหนด', cls: 'badge-po-ordered' }
  return { label: 'รอครบกำหนด', cls: 'badge-pending' }
}
```

In `src/pages/Retention.jsx`, remove the local `statusFor` function (currently lines 12-21):
```js
function statusFor(row) {
  if (row.retention_released) return { label: 'คืนแล้ว', cls: 'badge-paid' }
  if (!row.end_date) return { label: 'รอจบงาน', cls: 'badge-pending' }
  if (!row.due_date) return { label: 'ยังไม่ได้ตั้งระยะเวลา', cls: 'badge-pending' }
  const today = new Date().toISOString().slice(0, 10)
  if (row.due_date < today) return { label: 'เกินกำหนด', cls: 'badge-status-cancelled' }
  const in30 = new Date()
  in30.setDate(in30.getDate() + 30)
  if (row.due_date <= in30.toISOString().slice(0, 10)) return { label: 'ใกล้ครบกำหนด', cls: 'badge-po-ordered' }
  return { label: 'รอครบกำหนด', cls: 'badge-pending' }
}
```
and add an import at the top of the file instead:
```js
import { retentionStatusFor } from '../lib/retentionStatus.js'
```
Then change the one call site (`const status = statusFor(row)`) to:
```js
const status = retentionStatusFor(row)
```

- [ ] **Step 3: Extract deposit status logic into `depositCalc.js`**

In `src/lib/depositCalc.js`, add at the end of the file:
```js

export function depositStatusFor(row) {
  if (row.remaining_balance > 0) return { label: 'คงเหลือ', cls: 'badge-paid' }
  return { label: 'หักครบแล้ว', cls: 'badge-finished' }
}
```

In `src/pages/Deposits.jsx`, remove the local `statusFor` function:
```js
function statusFor(row) {
  if (row.remaining_balance > 0) return { label: 'คงเหลือ', cls: 'badge-paid' }
  return { label: 'หักครบแล้ว', cls: 'badge-finished' }
}
```
and add an import instead:
```js
import { depositStatusFor } from '../lib/depositCalc.js'
```
Then change the one call site (`const status = statusFor(row)`) to:
```js
const status = depositStatusFor(row)
```

- [ ] **Step 4: Create the modal component**

Create `src/components/SiteOverviewModal.jsx`:
```jsx
// ============================================================
// SiteOverviewModal -- popup summary for one site: contract/financials +
// มัดจำ (deposit) + retention, opened by clicking a site name anywhere in
// the app. Read-only; no edit actions. ADMIN+ only -- see App.jsx, this
// is never wired into WORKER-visible site-name displays.
// ============================================================
import { useSiteOverview } from '../hooks/useSupabase.js'
import { fmt, fmtDate } from '../lib/supabase.js'
import { depositStatusFor } from '../lib/depositCalc.js'
import { retentionStatusFor } from '../lib/retentionStatus.js'
import { Modal } from './Modal.jsx'

export default function SiteOverviewModal({ siteId, onClose }) {
  const { data: site } = useSiteOverview(siteId)

  return (
    <Modal title={site ? `${site.site_number} · ${site.name}` : 'ไซท์งาน'} onClose={onClose} maxWidth={560}>
      <div className="modal-body" style={{ display: 'grid', gap: 16 }}>
        {!site ? (
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
          </>
        )}
      </div>
      <div className="modal-footer">
        <button className="btn btn-ghost" onClick={onClose}>ปิด</button>
      </div>
    </Modal>
  )
}
```

- [ ] **Step 5: Wire the modal into `App.jsx`**

Add the import. In `src/App.jsx`, immediately after `import ChangePassword from './components/ChangePassword.jsx'`:
```js
import SiteOverviewModal from './components/SiteOverviewModal.jsx'
```

Add state. Immediately after `const [showChangePassword, setShowChangePassword] = useState(false)`:
```js
  const [overviewSiteId, setOverviewSiteId] = useState(null)
```

Add `openSiteOverview` to the shared `props` object inside `renderPage()`. Change:
```js
  const renderPage = () => {
    const props = { navigateTo, navState }
```
to:
```js
  const renderPage = () => {
    const props = { navigateTo, navState, openSiteOverview: setOverviewSiteId }
```

Render the modal. Immediately after the existing `{showChangePassword && (...)}` block near the end of `App.jsx`'s JSX:
```jsx
      {showChangePassword && (
        <ChangePassword onClose={() => setShowChangePassword(false)} />
      )}

      {overviewSiteId && (
        <SiteOverviewModal siteId={overviewSiteId} onClose={() => setOverviewSiteId(null)} />
      )}
```

- [ ] **Step 6: Wire Sites.jsx (first consumer)**

Change the function signature (currently `export default function Sites({ navigateTo }) {`) to:
```js
export default function Sites({ navigateTo, openSiteOverview }) {
```

The site-name cell currently reads:
```jsx
                      <div style={{ fontWeight: 600, fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
                        {s.name}
                        {s.map_url && (
                          <a href={s.map_url} target="_blank" rel="noreferrer" title="เปิดแผนที่ Google Maps"
                            style={{ textDecoration: 'none', fontSize: 13 }} onClick={e => e.stopPropagation()}>📍</a>
                        )}
                      </div>
```
Change it to (adding the click handler and `cursor: pointer`; the map-pin link already calls `e.stopPropagation()` on its own click, so it keeps opening the map instead of also opening the overview):
```jsx
                      <div
                        style={{ fontWeight: 600, fontSize: 13, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}
                        onClick={() => openSiteOverview(s.id)}
                      >
                        {s.name}
                        {s.map_url && (
                          <a href={s.map_url} target="_blank" rel="noreferrer" title="เปิดแผนที่ Google Maps"
                            style={{ textDecoration: 'none', fontSize: 13 }} onClick={e => e.stopPropagation()}>📍</a>
                        )}
                      </div>
```

- [ ] **Step 7: Verify**

Run: `npm test`
Expected: all 36 existing tests pass (no new test file — `useSiteOverview` is a thin parallel-fetch wrapper with no branching logic worth isolating, matching how `useSiteDepositBalance`/`useSiteRetentionSummary` also have no dedicated tests; `retentionStatusFor`/`depositStatusFor` are moved, not changed, so their behavior is unchanged).

Run: `npm run build`
Expected: succeeds with no new errors.

Manually confirm in the dev server (documented limitation: no test login credentials available, call this out in your report rather than skipping silently): clicking a site name in the Sites list opens the modal with that site's data; clicking the map-pin icon still opens the map and does NOT also open the modal; a site with no deposit/retention shows neither section; closing the modal and reopening a different site's name shows the new site's data (not stale data from the previous one).

- [ ] **Step 8: Commit**

```bash
git add src/hooks/useSupabase.js src/lib/retentionStatus.js src/pages/Retention.jsx src/lib/depositCalc.js src/pages/Deposits.jsx src/components/SiteOverviewModal.jsx src/App.jsx src/pages/Sites.jsx
git commit -m "feat: add site overview modal (hook + component + App.jsx wiring + Sites.jsx)"
```

---

### Task 2: Wire Income.jsx, Expenses.jsx, PurchaseOrders.jsx

**Files:**
- Modify: `src/pages/Income.jsx`
- Modify: `src/pages/Expenses.jsx`
- Modify: `src/pages/PurchaseOrders.jsx`

**Interfaces:**
- Consumes: `openSiteOverview(id)` prop (Task 1) — already flows into every page via `App.jsx`'s shared `props` object; this task only needs to destructure it in each page's function signature and call it.

- [ ] **Step 1: Wire Income.jsx**

Change the function signature (currently `export default function Income({ navigateTo, navState }) {`) to:
```js
export default function Income({ navigateTo, navState, openSiteOverview }) {
```

The site-name cell currently reads:
```jsx
                  <td style={{ fontSize: 11, color: 'var(--accent)' }} title={i.site_number || undefined}>{i.site_name || '—'}</td>
```
Change it to:
```jsx
                  <td style={{ fontSize: 11, color: 'var(--accent)', cursor: i.site_id ? 'pointer' : 'default' }} title={i.site_number || undefined}
                    onClick={() => i.site_id && openSiteOverview(i.site_id)}>{i.site_name || '—'}</td>
```
(`i.site_id` can be null for an income row with no site assigned -- `site_id UUID REFERENCES sites(id) ON DELETE SET NULL` -- so the click is a no-op and the cursor stays default when there's nothing to open.)

- [ ] **Step 2: Wire Expenses.jsx**

Change the function signature (currently `export default function Expenses({ navigateTo, navState }) {`) to:
```js
export default function Expenses({ navigateTo, navState, openSiteOverview }) {
```

The site-name cell currently reads:
```jsx
                  <td style={{ fontSize: 11, color: 'var(--accent)' }} title={e.site_number || undefined}>{e.site_name || '—'}</td>
```
Change it to:
```jsx
                  <td style={{ fontSize: 11, color: 'var(--accent)', cursor: e.site_id ? 'pointer' : 'default' }} title={e.site_number || undefined}
                    onClick={() => e.site_id && openSiteOverview(e.site_id)}>{e.site_name || '—'}</td>
```

- [ ] **Step 3: Wire PurchaseOrders.jsx**

Change the function signature (currently `export default function PurchaseOrders({ navigateTo, navState }) {`) to:
```js
export default function PurchaseOrders({ navigateTo, navState, openSiteOverview }) {
```

The site-name cell currently reads:
```jsx
                    <td style={{ fontSize: 11, color: 'var(--accent)' }}>{po.sites?.name || '—'}</td>
```
Change it to:
```jsx
                    <td style={{ fontSize: 11, color: 'var(--accent)', cursor: po.site_id ? 'pointer' : 'default' }}
                      onClick={() => po.site_id && openSiteOverview(po.site_id)}>{po.sites?.name || '—'}</td>
```
(`po.site_id` is the foreign key column on the `purchase_orders` row itself, same value the `po.sites?.name` join is keyed on.)

- [ ] **Step 4: Verify**

Run: `npm test`
Expected: all 36 tests pass (no logic changed, just prop wiring).

Run: `npm run build`
Expected: succeeds with no new errors.

Manually confirm (documented limitation, same as Task 1): clicking a site name in each of the three pages' tables opens the modal for the right site; a row with no site assigned (if any exist) doesn't error when clicked.

- [ ] **Step 5: Commit**

```bash
git add src/pages/Income.jsx src/pages/Expenses.jsx src/pages/PurchaseOrders.jsx
git commit -m "feat: wire site overview modal into Income, Expenses, PurchaseOrders"
```

---

### Task 3: Wire Assign.jsx and LaborContractors.jsx

**Files:**
- Modify: `src/pages/Assign.jsx`
- Modify: `src/pages/LaborContractors.jsx`

**Interfaces:**
- Consumes: `openSiteOverview(id)` prop (Task 1), same as Task 2.

- [ ] **Step 1: Wire Assign.jsx**

Change the function signature (currently `export default function Assign({ navState }) {`) to:
```js
export default function Assign({ navState, openSiteOverview }) {
```

This site-name display is inside the `{canEdit && (...)}` block (ADMIN+ only -- `canEdit = isAtLeast('ADMIN') && canEditPage(role, 'assign')`, already confirmed in this file), so it satisfies the Global Constraint's WORKER-visibility rule without any extra gating in this task. It currently reads:
```jsx
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 11, color: 'var(--accent)' }}>{s.site_number}</div>
                <div style={{ fontWeight: 700, fontSize: 14, overflowWrap: 'anywhere' }}>{s.site_name}</div>
              </div>
```
Change it to (the `costBySite` entries carry `site_id`, per this file's own grouping code -- e.g. `m[l.site_id] || (m[l.site_id] = { site_number: l.site_number, site_name: l.site_name, ... })`):
```jsx
              <div style={{ minWidth: 0, cursor: s.site_id ? 'pointer' : 'default' }} onClick={() => s.site_id && openSiteOverview(s.site_id)}>
                <div style={{ fontSize: 11, color: 'var(--accent)' }}>{s.site_number}</div>
                <div style={{ fontWeight: 700, fontSize: 14, overflowWrap: 'anywhere' }}>{s.site_name}</div>
              </div>
```

- [ ] **Step 2: Wire LaborContractors.jsx**

Change the function signature (currently `export default function LaborContractors() {`) to:
```js
export default function LaborContractors({ openSiteOverview }) {
```

The site-name cell currently reads:
```jsx
                  <td style={{ fontSize:11, color:'var(--text3)' }} title={p.labor_contracts?.sites?.site_number || undefined}>{p.labor_contracts?.sites?.name || '—'}</td>
```
Change it to:
```jsx
                  <td style={{ fontSize:11, color:'var(--text3)', cursor: p.labor_contracts?.sites?.id ? 'pointer' : 'default' }}
                    title={p.labor_contracts?.sites?.site_number || undefined}
                    onClick={() => p.labor_contracts?.sites?.id && openSiteOverview(p.labor_contracts.sites.id)}>{p.labor_contracts?.sites?.name || '—'}</td>
```
(the joined `sites` object's own `id` field is what `useSiteOverview`/`openSiteOverview` needs -- not `site_number`, which is a display code, not the UUID primary key.)

- [ ] **Step 3: Verify**

Run: `npm test`
Expected: all 36 tests pass.

Run: `npm run build`
Expected: succeeds with no new errors.

Manually confirm (documented limitation, same as Task 1): as ADMIN+, clicking a site name in Assign's labor-cost cards and in LaborContractors' payment table opens the modal for the right site.

- [ ] **Step 4: Commit**

```bash
git add src/pages/Assign.jsx src/pages/LaborContractors.jsx
git commit -m "feat: wire site overview modal into Assign and LaborContractors"
```

---

### Task 4: Wire Retention.jsx, Deposits.jsx, and Dashboard.jsx's ADMIN site table

**Files:**
- Modify: `src/pages/Retention.jsx`
- Modify: `src/pages/Deposits.jsx`
- Modify: `src/pages/Dashboard.jsx`

**Interfaces:**
- Consumes: `openSiteOverview(id)` prop (Task 1), same as Tasks 2-3.

- [ ] **Step 1: Wire Retention.jsx**

Change the function signature (currently `export default function Retention() {`) to:
```js
export default function Retention({ openSiteOverview }) {
```

The site-name cell currently reads:
```jsx
                    <td style={{ fontWeight: 600, fontSize: 13 }}>{row.name}</td>
```
Change it to:
```jsx
                    <td style={{ fontWeight: 600, fontSize: 13, cursor: 'pointer' }} onClick={() => openSiteOverview(row.site_id)}>{row.name}</td>
```
(every row on this page already has `total_retention > 0`, i.e. it came from a real site with a valid `site_id` -- no null-guard needed here, unlike Task 2's income/expense rows which can have no site at all.)

- [ ] **Step 2: Wire Deposits.jsx**

Change the function signature (currently `export default function Deposits() {`) to:
```js
export default function Deposits({ openSiteOverview }) {
```

The site-name cell currently reads:
```jsx
                    <td style={{ fontWeight: 600, fontSize: 13 }}>{row.name}</td>
```
Change it to:
```jsx
                    <td style={{ fontWeight: 600, fontSize: 13, cursor: 'pointer' }} onClick={() => openSiteOverview(row.site_id)}>{row.name}</td>
```
(same reasoning as Retention.jsx -- every visible row already has `total_deposit > 0`.)

- [ ] **Step 3: Wire Dashboard.jsx's ADMIN-only site table (NOT `WorkerSiteProgress`)**

Change the main `Dashboard` function's signature (currently `export default function Dashboard({ navigateTo }) {`) to:
```js
export default function Dashboard({ navigateTo, openSiteOverview }) {
```
**Do not** change `WorkerSiteProgress`'s signature (it takes no props today and must keep taking none -- see Global Constraints).

The `ongoingSites` table's site-name cell (inside the main `Dashboard` component, not `WorkerSiteProgress`) currently reads:
```jsx
                    <td><strong style={{ fontSize: 12 }}>{s.name}</strong></td>
```
Change it to:
```jsx
                    <td style={{ cursor: 'pointer' }} onClick={() => openSiteOverview(s.id)}><strong style={{ fontSize: 12 }}>{s.name}</strong></td>
```

- [ ] **Step 4: Verify**

Run: `npm test`
Expected: all 36 tests pass.

Run: `npm run build`
Expected: succeeds with no new errors.

Manually confirm (documented limitation, same as Task 1): as ADMIN+, clicking a site name in Retention, Deposits, and the Dashboard's ongoing-sites table opens the modal for the right site. As WORKER, confirm `WorkerSiteProgress`'s site-name cards are unchanged -- still plain text, no click, no cursor change, no access to the modal (WORKER can't reach Retention/Deposits/Sites at all per their `minRole`, and this step confirms Dashboard specifically doesn't leak it through the one page WORKER does see).

- [ ] **Step 5: Commit**

```bash
git add src/pages/Retention.jsx src/pages/Deposits.jsx src/pages/Dashboard.jsx
git commit -m "feat: wire site overview modal into Retention, Deposits, and Dashboard"
```
