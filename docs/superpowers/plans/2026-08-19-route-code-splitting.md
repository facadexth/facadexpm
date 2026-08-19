# Route-Based Code-Splitting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lazy-load the 12 non-Dashboard pages in `src/App.jsx` so the app's initial JS payload shrinks from ~1.3MB to roughly "Dashboard + shared code," reducing how often the browser discards this tab under memory pressure.

**Architecture:** Convert 12 of `App.jsx`'s 14 static page imports to `React.lazy()`, wrap the existing `renderPage()` switch in a `Suspense` boundary with a reused loading-text fallback, then add a dedicated error boundary that catches failed chunk loads (stale-deployment 404s) and recovers with a single automatic reload that lands the user back on the tab they wanted instead of bouncing to Dashboard.

**Tech Stack:** React 18 (`lazy`, `Suspense`, class-component error boundary — no new dependencies), Vite 5.4 (already emits per-dynamic-import chunks with no config changes needed).

## Global Constraints

- Dashboard and Login stay as regular static imports — do not lazy-load either (per spec, avoids first-login flicker for Dashboard; Login is needed before any lazy-loading infra helps).
- Page-level splitting only. Do not split below the page level (no per-modal, per-sub-tab, or per-component lazy-loading within a single page).
- No change to routing mechanism — this app has no URL router; `activeTab` stays plain React state.
- No change to `html2pdf.js` / `html2canvas` lazy-loading in `src/lib/pdf.js` — already dynamic-imported, out of scope.
- `npm test` (25 existing Vitest tests, none touching `App.jsx`) must continue passing unmodified throughout.
- No backend/schema/data changes — pure frontend build-output change.

---

### Task 1: Lazy-load pages behind a Suspense boundary

**Files:**
- Modify: `src/App.jsx` (full file currently 191 lines — see below for exact before/after)

**Interfaces:**
- Consumes: nothing from other tasks (this is the first task).
- Produces: a `PageLoadingFallback` component (defined inline in `App.jsx`, not exported — Task 2 does not need to import it, only needs to know it exists as the `Suspense` fallback already in place) and the lazy-wrapped page components (`Sites`, `Assign`, `Expenses`, `PurchaseOrders`, `Income`, `HR`, `LaborContractors`, `Categories`, `Clients`, `Suppliers`, `UserManagement`, `Settings` — all still referenced by these exact names in `renderPage()`, unchanged from before this task). Task 2 wraps the `Suspense` block this task creates with an error boundary — it needs to know the `Suspense` JSX is the direct child of the render tree at the old `{renderPage()}` call site (main content area, inside `<main>`).

- [ ] **Step 1: Replace the import block**

In `src/App.jsx`, replace lines 5–26 (the entire top import block, from `import { useState, useEffect } from 'react'` through `import Settings from './pages/Settings.jsx'`) with:

```jsx
import { useState, useEffect, lazy, Suspense } from 'react'
import { supabase } from './lib/supabase.js'
import { useUserRole } from './hooks/useUserRole.js'
import { useTenant } from './hooks/useTenant.js'
import { ProtectedPage } from './components/ProtectedPage.jsx'
import { canViewPage } from './lib/permissions.js'
import ChangePassword from './components/ChangePassword.jsx'
import TrialBanner from './components/TrialBanner.jsx'
import Login      from './pages/Login.jsx'
import Dashboard   from './pages/Dashboard.jsx'

const Sites             = lazy(() => import('./pages/Sites.jsx'))
const Assign             = lazy(() => import('./pages/Assign.jsx'))
const Expenses           = lazy(() => import('./pages/Expenses.jsx'))
const PurchaseOrders     = lazy(() => import('./pages/PurchaseOrders.jsx'))
const Income             = lazy(() => import('./pages/Income.jsx'))
const HR                 = lazy(() => import('./pages/HR.jsx'))
const LaborContractors   = lazy(() => import('./pages/LaborContractors.jsx'))
const Categories         = lazy(() => import('./pages/Categories.jsx'))
const Clients            = lazy(() => import('./pages/Clients.jsx'))
const Suppliers          = lazy(() => import('./pages/Suppliers.jsx'))
const UserManagement     = lazy(() => import('./pages/UserManagement.jsx'))
const Settings           = lazy(() => import('./pages/Settings.jsx'))
```

Note `Dashboard` and `Login` are unchanged, regular static imports — only the other 12 become `lazy()`.

- [ ] **Step 2: Add the loading fallback component**

Immediately after the `TABS` array (after the closing `]` that was at old line 42, before `export default function App() {`), add:

```jsx
function PageLoadingFallback() {
  return (
    <div style={{ minHeight: '60vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ color: 'var(--text3)', fontSize: 14 }}>กำลังโหลด...</div>
    </div>
  )
}
```

- [ ] **Step 3: Wrap the page-content render in Suspense**

Find this line (old line 182, inside the `<main className="app-main" ...>` block):

```jsx
        {renderPage()}
```

Replace it with:

```jsx
        <Suspense fallback={<PageLoadingFallback />}>
          {renderPage()}
        </Suspense>
```

Do not change `renderPage()` itself — its `switch` statement and every `<ProtectedPage>`/page JSX inside it stays exactly as-is. `React.lazy()` components work as drop-in replacements for regular components in JSX.

- [ ] **Step 4: Build and verify chunk splitting**

Run:
```bash
npm run build
```

Expected: build succeeds with no errors. In the output listing, confirm you now see separate chunk files for pages beyond the single large `index-*.js` — e.g. entries like `dist/assets/Sites-*.js`, `dist/assets/Expenses-*.js`, `dist/assets/PurchaseOrders-*.js`, etc. (Vite names lazy chunks after the source file by default). Confirm the main `index-*.js` chunk's reported size has dropped from the pre-change baseline (check `git stash`, `npm run build`, note old `index-*.js` size, `git stash pop`, `npm run build`, compare — or just compare against the ~1.3MB figure already documented in this session's prior build outputs).

- [ ] **Step 5: Run the existing test suite**

Run:
```bash
npm test
```

Expected: `Test Files 2 passed (2)`, `Tests 25 passed (25)` — identical to before this change, since none of these tests touch `App.jsx`.

- [ ] **Step 6: Manual smoke test in the browser**

Run:
```bash
npm run preview -- --port 4174
```

Open `http://localhost:4174` in a browser, log in, and click through **every one of the 13 tabs** (ภาพรวม, Assign ช่าง, HR, ไซท์งาน, รายจ่าย, ใบสั่งซื้อ, รายรับ, หมวดหมู่, ลูกค้า, Supplier, ผู้รับเหมาค่าแรง, ผู้ใช้งาน, ตั้งค่า — role permitting; log in as an OWNER-role account to see all of them). For each: confirm the page renders correctly, confirm no errors appear in the browser console (open DevTools before starting). Click each tab a second time and confirm it renders instantly the second time (already-loaded chunks aren't refetched — check the Network tab: the second visit shows no new request for that page's chunk file).

- [ ] **Step 7: Commit**

```bash
git add src/App.jsx
git commit -m "$(cat <<'EOF'
perf: lazy-load non-Dashboard pages to shrink initial bundle

App.jsx statically imported all 13 pages into one ~1.3MB chunk loaded
on every visit regardless of active tab. Converted the 12 non-Dashboard
pages to React.lazy() behind a Suspense boundary (Dashboard stays
eager -- it's the default tab, no first-login flicker; Login stays
eager -- needed before any lazy infra helps).

Smaller resident memory footprint means the browser's tab-discarding
under memory pressure (Chrome Memory Saver, Safari background-tab
suspension) should trigger less often on this tab, especially on
weaker devices/mobile where the gap is worst today. Complements
useDraftForm (shipped 2026-08-18/19), which makes an unavoidable
reload harmless but doesn't reduce how often one happens.

See docs/superpowers/specs/2026-08-19-route-code-splitting-design.md.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Recover gracefully from stale-deployment chunk-load failures

**Files:**
- Create: `src/components/ChunkErrorBoundary.jsx`
- Modify: `src/App.jsx`

**Interfaces:**
- Consumes: the `Suspense` block Task 1 created around `{renderPage()}` (this task wraps it with the new error boundary, one level up in the tree) and the `activeTab` state variable already defined in `App.jsx` (unchanged name/type — a string tab id).
- Produces: `ChunkErrorBoundary` — a default-exported React class component accepting props `{ pendingTab: string, children: ReactNode }`. Not consumed by any other task in this plan; it's the last task.

- [ ] **Step 1: Create the error boundary component**

Create `src/components/ChunkErrorBoundary.jsx`:

```jsx
// ============================================================
// ChunkErrorBoundary — recovers from a failed lazy-page chunk load
// (stale deployment: browser has an old index.html referencing JS
// filenames that no longer exist on the server after a new build).
// Catches the failure, remembers which tab the user was trying to
// reach, and does exactly one automatic reload to fetch the current
// build. A guard flag in sessionStorage prevents a reload loop if the
// reload doesn't actually fix it (e.g. a real network outage).
// ============================================================
import { Component } from 'react'

const RELOAD_GUARD_KEY = 'chunk-reload-attempted'
const PENDING_TAB_KEY = 'pendingTab'

// This message text is thrown by the browser's own JS engine for a
// failed dynamic import() -- NOT something Vite generates -- and its
// exact wording differs per browser. Covers Chrome/Edge ("Failed to
// fetch dynamically imported module"), Firefox ("error loading
// dynamically imported module"), and Safari/WebKit ("Importing a
// module script failed"). If a browser this app needs to support
// throws different wording, add it here.
const CHUNK_ERROR_PATTERN = /failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed/i

export default class ChunkErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, isChunkLoadError: false, error: null }
  }

  static getDerivedStateFromError(error) {
    const isChunkLoadError = CHUNK_ERROR_PATTERN.test(error?.message || '')
    return { hasError: true, isChunkLoadError, error }
  }

  componentDidCatch(error) {
    if (!this.state.isChunkLoadError) return // not a chunk-load failure -- let it surface as a real bug, don't reload-loop on unrelated errors

    const alreadyTried = sessionStorage.getItem(RELOAD_GUARD_KEY)
    if (alreadyTried) return // reload already happened once and didn't fix it -- stop here rather than loop forever

    sessionStorage.setItem(RELOAD_GUARD_KEY, '1')
    if (this.props.pendingTab) {
      sessionStorage.setItem(PENDING_TAB_KEY, this.props.pendingTab)
    }
    window.location.reload()
  }

  render() {
    if (this.state.hasError && !this.state.isChunkLoadError) {
      throw this.state.error // re-throw non-chunk errors -- don't swallow real bugs
    }
    return this.props.children
  }
}
```

- [ ] **Step 2: Wire the boundary and pendingTab restoration into App.jsx**

In `src/App.jsx`, add the import alongside the other component imports (near the top, with `ChangePassword`/`TrialBanner`):

```jsx
import ChunkErrorBoundary from './components/ChunkErrorBoundary.jsx'
```

In the component body, add a new `useEffect` that restores a pending tab on boot. Place it directly after the existing auth-session `useEffect` (the one calling `supabase.auth.getSession()`):

```jsx
  useEffect(() => {
    const pending = sessionStorage.getItem('pendingTab')
    if (pending) {
      sessionStorage.removeItem('pendingTab')
      sessionStorage.removeItem('chunk-reload-attempted')
      setActiveTab(pending)
    }
  }, [])
```

Then wrap the `Suspense` block from Task 1 with the new boundary:

```jsx
        <ChunkErrorBoundary pendingTab={activeTab}>
          <Suspense fallback={<PageLoadingFallback />}>
            {renderPage()}
          </Suspense>
        </ChunkErrorBoundary>
```

(replacing the plain `<Suspense>...</Suspense>` block Task 1 added at the same location).

- [ ] **Step 3: Build and run the existing test suite**

```bash
npm run build
npm test
```

Expected: build succeeds, `Tests 25 passed (25)` — unchanged.

- [ ] **Step 4: Simulate a stale-deployment chunk failure and verify recovery**

Temporarily break one lazy import to force a real failed dynamic import. In `src/App.jsx`, change:

```jsx
const Sites             = lazy(() => import('./pages/Sites.jsx'))
```

to a nonexistent path:

```jsx
const Sites             = lazy(() => import('./pages/SitesXXX.jsx'))
```

Build and preview:
```bash
npm run build
npm run preview -- --port 4174
```

Open `http://localhost:4174` in **Chrome**, open DevTools console, log in, click the "ไซท์งาน" (Sites) tab. Expected: the page briefly shows the loading fallback, then the whole app reloads once automatically, and after reloading it lands directly on the Sites tab (not bounced back to Dashboard) — even though Sites is still broken at this point, so you should see the loading fallback stuck there afterward (expected, since the import genuinely can't succeed while the path is wrong). Open DevTools → Application → Session Storage and confirm `chunk-reload-attempted` is set to `1` and the app did **not** reload a second time when you click Sites again.

Repeat the same steps in **Safari** (Web Inspector → Storage for the sessionStorage check). Confirm the same one-reload-then-land-on-Sites behavior. If Safari's actual thrown error message doesn't match `CHUNK_ERROR_PATTERN` (the reload never fires, or the error surfaces as an unhandled crash instead), capture the real message text from Safari's console and add it to the regex in `src/components/ChunkErrorBoundary.jsx`, then re-test.

Once confirmed in both browsers, revert the temporary breakage:

```jsx
const Sites             = lazy(() => import('./pages/Sites.jsx'))
```

Run `npm run build` again and confirm Sites loads normally, then run `npm test` once more to confirm nothing else broke.

- [ ] **Step 5: Commit**

```bash
git add src/components/ChunkErrorBoundary.jsx src/App.jsx
git commit -m "$(cat <<'EOF'
fix: recover from stale-deployment chunk-load failures instead of crashing

Frequent deploys mean a user with the app open across a deploy who
then clicks a not-yet-loaded tab will have React.lazy's dynamic
import() reject (browser fetches an old, now-404 hashed filename) --
uncaught, this crashes the whole render tree to a blank screen.

ChunkErrorBoundary catches specifically chunk-load failures (detected
by browser error message text, verified against Chrome and Safari's
actual wording -- see the regex comment), remembers which tab the user
wanted via sessionStorage, and does exactly one automatic reload. On
boot, App.jsx checks for that pending tab and activates it instead of
defaulting to Dashboard, so the flow reads as "click tab -> brief
reload -> land on that tab" rather than "crash" or "bounce to
Dashboard." A guard flag stops a second automatic reload if the first
one didn't fix it (e.g. real network outage), to avoid a reload loop.

Non-chunk errors are re-thrown unchanged -- this boundary only
intercepts the specific stale-deploy failure mode, not general bugs.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review Notes

(Completed during plan authoring, not part of the executable plan — retained here for the record.)

1. **Spec coverage:** Lazy imports (Task 1, Step 1) ✓. Suspense + reused loading text (Task 1, Steps 2–3) ✓. Dashboard/Login stay eager (Task 1, Step 1 note + Global Constraints) ✓. ChunkErrorBoundary + message-pattern caveat (Task 2, Step 1) ✓. pendingTab restore-on-boot (Task 2, Step 2) ✓. Reload guard against infinite loop (Task 2, Step 1, `RELOAD_GUARD_KEY` check) ✓. Testing: bundle size (Task 1 Step 4), manual click-through + chunk-caching check (Task 1 Step 6), stale-deploy simulation in both Chrome and Safari (Task 2 Step 4), existing test suite stays green (both tasks) ✓. Page-level-only scope — no task touches anything below `App.jsx`'s page components ✓.
2. **Placeholder scan:** none found — every step has literal code/commands, no "add error handling" or "TBD" phrasing.
3. **Type/name consistency:** `ChunkErrorBoundary` is the exact name used in both its own file's export and `App.jsx`'s import in Task 2. `PageLoadingFallback` defined in Task 1 is referenced by the same name in Task 2's Step 2 replacement block. `pendingTab` prop name matches between the component definition (Step 1) and its usage (Step 2). `sessionStorage` key strings (`'pendingTab'`, `'chunk-reload-attempted'`) are hardcoded identically in both the boundary component and `App.jsx`'s restore effect — no drift between the two files.
