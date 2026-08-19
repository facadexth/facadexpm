# "ไซท์งาน" Hover Dropdown Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Group the `sites`, `deposits`, and `retention` top-nav tabs under one "ไซท์งาน" entry that reveals its three children as a dropdown on hover, replacing their current position as three separate flat tabs.

**Architecture:** `App.jsx`'s flat `TABS` array gains one "group" shape (a label + `children` array, no `id`/`module` of its own) in place of the three standalone entries it replaces. The existing role/module/permission filtering logic is refactored into a shared `passesGates()` check reused for both plain tabs and group children, so gating behavior is byte-identical to today, just applied one level deeper for these three. Rendering adds one new branch (group vs. plain tab) to the existing `visibleTabs.map()`; the dropdown itself is pure CSS `:hover` (two new classes in `index.css`), no JS open/close state.

**Tech Stack:** React 18 + Vite, plain CSS (no new dependencies).

## Global Constraints

- Clicking the "ไซท์งาน" label itself must do nothing — no `onClick`, no `cursor: pointer`. Only clicking a dropdown child navigates. This was an explicit, deliberate user decision (confirmed twice) — do not "improve" it with click-to-toggle behavior.
- The dropdown is hover-only (pure CSS `:hover`), not JS-driven — this app has no distinct mobile/touch nav layout today, and the design spec explicitly accepts hover-only as the scope, not a gap to silently patch.
- Gating for the three grouped tabs (`sites`/`deposits`/`retention`) must stay byte-identical to today: `isAtLeast(minRole)`, `hasModuleAccess(module)`, `canViewPage(role, id)`, in that order. Do not add or remove a gate when moving these into the group's `children`.
- No other tab in `TABS` changes — only `sites`, `deposits`, `retention` move into the new group; the other 10 stay exactly where they are.
- `renderPage()`'s switch statement is untouched — `sites`/`retention`/`deposits` still resolve to the same `activeTab` string values as before, so no case needs to change.

---

### Task 1: Group the three tabs under one hover-dropdown entry

**Files:**
- Modify: `src/App.jsx`
- Modify: `src/index.css`

**Interfaces:**
- Produces: no new exported functions/hooks — this is a self-contained rendering change local to `App.jsx`. Nothing else in the codebase imports `TABS` (confirmed: `grep -rn "\bTABS\b" src/` outside `App.jsx` returns nothing).

- [ ] **Step 1: Restructure the `TABS` array**

In `src/App.jsx`, the `TABS` array currently reads (lines 32-48):
```js
const TABS = [
  { id: 'dashboard',         label: '📊 ภาพรวม',              minRole: 'WORKER', module: null },
  { id: 'assign',            label: '📋 Assign ช่าง',          minRole: 'WORKER', module: 'payroll' },
  { id: 'hr',                label: '👷 HR',                   minRole: 'WORKER', module: 'payroll' },
  { id: 'sites',             label: '🏗️ ไซท์งาน',            minRole: 'ADMIN',  module: null },
  { id: 'expenses',          label: '💸 รายจ่าย',              minRole: 'ADMIN',  module: null },
  { id: 'purchase_orders',   label: '🧾 ใบสั่งซื้อ',           minRole: 'ADMIN',  module: 'purchase_orders' },
  { id: 'income',            label: '💰 รายรับ',               minRole: 'ADMIN',  module: null },
  { id: 'retention',         label: '🔒 Retention',            minRole: 'ADMIN',  module: null },
  { id: 'deposits',          label: '💰 มัดจำ',                minRole: 'ADMIN',  module: 'client_deposits' },
  { id: 'categories',        label: '🏷️ หมวดหมู่',            minRole: 'ADMIN',  module: null },
  { id: 'clients',           label: '🏢 ลูกค้า',              minRole: 'ADMIN',  module: null },
  { id: 'suppliers',         label: '🏭 Supplier',             minRole: 'ADMIN',  module: null },
  { id: 'labor_contractors', label: '🔧 ผู้รับเหมาค่าแรง',    minRole: 'ADMIN',  module: 'labor_subcontractors' },
  { id: 'user_management',   label: '👤 ผู้ใช้งาน',           minRole: 'OWNER',  module: null },
  { id: 'settings',          label: '⚙️ ตั้งค่า',             minRole: 'OWNER',  module: null },
]
```

Replace it with (removing the standalone `sites`/`retention`/`deposits` entries and inserting one group in `sites`'s old position):
```js
const TABS = [
  { id: 'dashboard',         label: '📊 ภาพรวม',              minRole: 'WORKER', module: null },
  { id: 'assign',            label: '📋 Assign ช่าง',          minRole: 'WORKER', module: 'payroll' },
  { id: 'hr',                label: '👷 HR',                   minRole: 'WORKER', module: 'payroll' },
  { label: '🏗️ ไซท์งาน', children: [
    { id: 'sites',     label: 'Overview',  minRole: 'ADMIN', module: null },
    { id: 'deposits',  label: '💰 มัดจำ',   minRole: 'ADMIN', module: 'client_deposits' },
    { id: 'retention', label: '🔒 Retention', minRole: 'ADMIN', module: null },
  ] },
  { id: 'expenses',          label: '💸 รายจ่าย',              minRole: 'ADMIN',  module: null },
  { id: 'purchase_orders',   label: '🧾 ใบสั่งซื้อ',           minRole: 'ADMIN',  module: 'purchase_orders' },
  { id: 'income',            label: '💰 รายรับ',               minRole: 'ADMIN',  module: null },
  { id: 'categories',        label: '🏷️ หมวดหมู่',            minRole: 'ADMIN',  module: null },
  { id: 'clients',           label: '🏢 ลูกค้า',              minRole: 'ADMIN',  module: null },
  { id: 'suppliers',         label: '🏭 Supplier',             minRole: 'ADMIN',  module: null },
  { id: 'labor_contractors', label: '🔧 ผู้รับเหมาค่าแรง',    minRole: 'ADMIN',  module: 'labor_subcontractors' },
  { id: 'user_management',   label: '👤 ผู้ใช้งาน',           minRole: 'OWNER',  module: null },
  { id: 'settings',          label: '⚙️ ตั้งค่า',             minRole: 'OWNER',  module: null },
]
```

- [ ] **Step 2: Add a flattened lookup and fix the role-redirect effect**

The "After role loads, redirect WORKER away from ADMIN-only tabs" effect (lines 91-98) does `TABS.find(t => t.id === activeTab)`. After Step 1, `TABS` contains one entry with no `.id` (the group), so this `find` would never match `activeTab === 'sites'/'deposits'/'retention'` anymore — those three would need to come from the group's `children` instead. Add a flattened constant right after the `TABS` array declaration:

```js
// TABS entries are either a plain tab ({id, label, minRole, module}) or a
// group ({label, children: [...plain tabs]}) for the hover dropdown. This
// flattens both shapes into one list of plain tabs, so lookups by id don't
// need to know which shape produced them.
const ALL_TAB_ENTRIES = TABS.flatMap(t => t.children ?? [t])
```

Then change the effect (lines 91-98) from:
```js
  useEffect(() => {
    if (roleLoading || !session) return
    const current = TABS.find(t => t.id === activeTab)
    if (current && !isAtLeast(current.minRole)) {
      setActiveTab(isAtLeast('ADMIN') ? 'dashboard' : 'assign')
    }
  }, [roleLoading, session, activeTab, isAtLeast])
```
to:
```js
  useEffect(() => {
    if (roleLoading || !session) return
    const current = ALL_TAB_ENTRIES.find(t => t.id === activeTab)
    if (current && !isAtLeast(current.minRole)) {
      setActiveTab(isAtLeast('ADMIN') ? 'dashboard' : 'assign')
    }
  }, [roleLoading, session, activeTab, isAtLeast])
```

- [ ] **Step 3: Extract the shared gating check and update `visibleTabs`**

`visibleTabs` (lines 141-154) currently reads:
```js
  const visibleTabs = TABS.filter(tab => {
    // First check role-based access
    if (!isAtLeast(tab.minRole)) return false

    // Then check module entitlement
    if (!hasModuleAccess(tab.module)) return false

    // Then check saved per-role permission level ('none' hides the tab;
    // 'view'/'edit' both keep it visible — the view/edit distinction is
    // enforced inside each page's own canEdit, not here)
    if (role && !canViewPage(role, tab.id)) return false

    return true
  })
```

Replace it with a shared predicate plus a map-then-filter that handles both shapes — a group survives only if at least one child passes, and keeps only the children that pass:
```js
  // Same three checks every tab (plain or a group's child) has always had:
  // role floor, module entitlement, then per-role view/edit override. Used
  // for both plain tabs and group children so a "ไซท์งาน" child is gated
  // identically to how it was gated as a standalone tab before this change.
  const passesGates = (tab) =>
    isAtLeast(tab.minRole) &&
    hasModuleAccess(tab.module) &&
    (!role || canViewPage(role, tab.id))

  const visibleTabs = TABS
    .map(tab => tab.children ? { ...tab, children: tab.children.filter(passesGates) } : tab)
    .filter(tab => tab.children ? tab.children.length > 0 : passesGates(tab))
```

- [ ] **Step 4: Render the group as a hover dropdown**

The Tab Bar's `<nav>` (lines 197-217) currently reads:
```jsx
      {/* ── Tab Bar ── */}
      <nav style={{
        background: 'var(--bg2)', borderBottom: '1px solid var(--border)',
        padding: '0 20px', display: 'flex', gap: 2, overflowX: 'auto'
      }}>
        {visibleTabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => { sessionStorage.removeItem('chunk-reload-attempted'); setNavState({}); setActiveTab(tab.id) }}
            style={{
              padding: '13px 18px', background: 'none', border: 'none',
              borderBottom: activeTab === tab.id ? '2px solid var(--accent)' : '2px solid transparent',
              color: activeTab === tab.id ? 'var(--accent)' : 'var(--text2)',
              fontWeight: 600, fontSize: 13, cursor: 'pointer',
              whiteSpace: 'nowrap', transition: 'all 0.2s'
            }}
          >
            {tab.label}
          </button>
        ))}
      </nav>
```

Replace the `{visibleTabs.map(...)}` body so a group entry renders a hover-triggered dropdown instead of a plain button, while a plain entry renders exactly the same button as before:
```jsx
      {/* ── Tab Bar ── */}
      <nav style={{
        background: 'var(--bg2)', borderBottom: '1px solid var(--border)',
        padding: '0 20px', display: 'flex', gap: 2, overflowX: 'auto'
      }}>
        {visibleTabs.map(tab => tab.children ? (
          <div key={tab.label} className="nav-group">
            <span
              className="nav-group-trigger"
              style={{
                padding: '13px 18px', display: 'inline-block',
                borderBottom: tab.children.some(c => c.id === activeTab) ? '2px solid var(--accent)' : '2px solid transparent',
                color: tab.children.some(c => c.id === activeTab) ? 'var(--accent)' : 'var(--text2)',
                fontWeight: 600, fontSize: 13, whiteSpace: 'nowrap', transition: 'all 0.2s'
              }}
            >
              {tab.label}
            </span>
            <div className="nav-group-dropdown">
              {tab.children.map(child => (
                <button
                  key={child.id}
                  onClick={() => { sessionStorage.removeItem('chunk-reload-attempted'); setNavState({}); setActiveTab(child.id) }}
                  style={{
                    display: 'block', width: '100%', textAlign: 'left',
                    padding: '10px 16px', background: 'none', border: 'none', cursor: 'pointer',
                    color: activeTab === child.id ? 'var(--accent)' : 'var(--text2)',
                    fontWeight: 600, fontSize: 13, whiteSpace: 'nowrap'
                  }}
                >
                  {child.label}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <button
            key={tab.id}
            onClick={() => { sessionStorage.removeItem('chunk-reload-attempted'); setNavState({}); setActiveTab(tab.id) }}
            style={{
              padding: '13px 18px', background: 'none', border: 'none',
              borderBottom: activeTab === tab.id ? '2px solid var(--accent)' : '2px solid transparent',
              color: activeTab === tab.id ? 'var(--accent)' : 'var(--text2)',
              fontWeight: 600, fontSize: 13, cursor: 'pointer',
              whiteSpace: 'nowrap', transition: 'all 0.2s'
            }}
          >
            {tab.label}
          </button>
        ))}
      </nav>
```

- [ ] **Step 5: Add the dropdown CSS**

`src/index.css` has no `.nav-*` classes yet (the nav bar has always been 100% inline styles) — add these as a new small block. Append to the end of `src/index.css`:
```css

/* ── Hover-dropdown nav group (e.g. "ไซท์งาน" → Overview/มัดจำ/Retention) ── */
.nav-group { position: relative; }
.nav-group-trigger { cursor: default; }
.nav-group-dropdown {
  display: none;
  position: absolute;
  top: 100%;
  left: 0;
  background: var(--bg2);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
  padding: 4px;
  min-width: 160px;
  z-index: 200;
}
.nav-group:hover .nav-group-dropdown { display: block; }
```

- [ ] **Step 6: Verify**

Run: `npm test`
Expected: all 36 existing tests still pass (this task adds no new test file — it's presentational nav wiring with no new pure-logic function, per the design spec).

Run: `npm run build`
Expected: succeeds with no new errors (only the pre-existing chunk-size warnings).

Manually confirm in the running dev server (`npm run dev`, already covered by this session's standing "no test login credentials available" limitation — call this out explicitly in your report rather than skipping it silently):
- Hovering "ไซท์งาน" reveals Overview / มัดจำ / Retention.
- Clicking the "ไซท์งาน" label itself does nothing (no navigation).
- Clicking each dropdown item navigates to the correct page and closes the dropdown (moving the mouse away closes it; no click-driven close state to break).
- "ไซท์งาน" shows the active underline/color when any of its three children is the current page.
- With `client_deposits` NOT granted to a tenant, the dropdown shows only Overview and Retention (มัดจำ omitted) — same gating as before, just inside the dropdown instead of the flat bar.

- [ ] **Step 7: Commit**

```bash
git add src/App.jsx src/index.css
git commit -m "feat: group ไซท์งาน/มัดจำ/Retention into one hover-dropdown nav entry"
```
