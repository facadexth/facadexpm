# Route-Based Code-Splitting — Design Spec

## Problem

`App.jsx` statically imports all 13 top-level pages (Dashboard, Sites,
Assign, Expenses, PurchaseOrders, Income, HR, LaborContractors,
Categories, Clients, Suppliers, UserManagement, Settings) into a single
JS bundle, currently ~1.3MB, loaded in full on every visit regardless of
which tab the user actually opens.

This matters because Chrome's Memory Saver and Safari's background-tab
suspension both target higher-memory tabs first when reclaiming RAM —
the heavier this bundle, the more often the app's tab gets discarded and
silently reloaded when the user switches away and back (browser tabs or
other applications). A same-session fix (`useDraftForm`, shipped
2026-08-18/19) already makes these reloads harmless — typed form data
survives them. This spec addresses the other half: making the reloads
themselves less frequent, with the biggest benefit landing on the
weakest devices (older phones, slow connections) where the gap is
largest today.

## Goals

- Reduce the JS payload loaded on initial page load / login to roughly
  "Dashboard + shared chunks" instead of "every page in the app."
- Each additional tab's code loads on first visit to that tab within a
  session, then is cached for the rest of the session.
- No user-visible regression: page switching still feels instant after
  the first visit to each tab; a stale-deployment chunk-load failure
  degrades gracefully instead of crashing to a blank screen.

## Non-Goals

- Splitting below the page level (no per-modal, per-sub-tab, or
  per-component splitting within a single page). The page-level split
  captures the large majority of the win; going deeper adds complexity
  for diminishing returns.
- Changing routing mechanism. This app has no URL router (tabs are
  plain `activeTab` state, not `react-router` routes) and that stays
  as-is — "route-based" here means "per-tab," not a URL routing change.
- Any change to `html2pdf.js` / `html2canvas` lazy-loading — both
  already load via dynamic `import()` in `src/lib/pdf.js` and are out
  of scope.

## Design

### 1. Lazy imports in `App.jsx`

Replace the 12 non-Dashboard static imports:

```js
import Sites       from './pages/Sites.jsx'
import Assign      from './pages/Assign.jsx'
// ...etc
```

with `React.lazy()`:

```js
import { lazy } from 'react'

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

`Dashboard` and `Login` stay regular static imports — Dashboard per the
approved decision (default tab, no first-login flicker), Login because
it's needed before any lazy-loading infrastructure would help (nobody
is "switching tabs" pre-authentication).

`renderPage()`'s existing `switch` statement is unchanged — `React.lazy`
components are drop-in compatible with JSX usage (`<Sites {...props} />`
works identically whether `Sites` is a static or lazy component).

### 2. Suspense boundary + loading fallback

Wrap the `renderPage()` call site (`{renderPage()}` in the main render,
`App.jsx` line 182) in `<Suspense>`:

```jsx
<Suspense fallback={<PageLoadingFallback />}>
  {renderPage()}
</Suspense>
```

`PageLoadingFallback` reuses the existing auth-loading pattern verbatim
(`App.jsx` lines 93-97 today):

```jsx
function PageLoadingFallback() {
  return (
    <div style={{ minHeight: '60vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ color: 'var(--text3)', fontSize: 14 }}>กำลังโหลด...</div>
    </div>
  )
}
```

(`minHeight: 60vh` instead of `100vh` since this one renders inside
`<main>`, below the header/nav, not full-viewport like the auth-loading
screen.)

### 3. Chunk-load-failure handling (stale deploy)

This app deploys frequently; each build's JS filenames are
content-hashed (e.g. `index-BE2i0yBV.js`), and old hashes stop existing
on the server once a new build overwrites `public_html`. A user with the
app open across a deploy who then clicks a tab not yet loaded this
session will have `React.lazy`'s dynamic `import()` reject (browser
fetches a 404). Uncaught, this crashes the whole render tree.

**`ChunkErrorBoundary`** (new component, `src/components/ChunkErrorBoundary.jsx`):
a class component (error boundaries require the class API) wrapping the
`Suspense` block:

```jsx
import { Component } from 'react'

const RELOAD_GUARD_KEY = 'chunk-reload-attempted'

export class ChunkErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(error) {
    // This message text is thrown by the browser's own JS engine for a
    // failed dynamic import() -- NOT something Vite generates -- and its
    // exact wording differs per browser. Covers Chrome/Edge ("Failed to
    // fetch dynamically imported module"), Firefox ("error loading
    // dynamically imported module"), and Safari/WebKit ("Importing a
    // module script failed"). Verify this list against whatever browsers
    // this app actually needs to support before shipping -- do not trust
    // it as exhaustive without checking, since the exact string is
    // engine-version-dependent and not documented as a stable API by any
    // browser vendor.
    const isChunkLoadError =
      /failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed/i.test(error?.message || '')
    return { hasError: true, isChunkLoadError }
  }

  componentDidCatch(error) {
    if (!this.state.isChunkLoadError) return // let non-chunk errors surface normally, don't reload-loop on unrelated bugs

    const alreadyTried = sessionStorage.getItem(RELOAD_GUARD_KEY)
    if (alreadyTried) return // reload didn't fix it (e.g. real network outage) -- stop, don't loop forever

    sessionStorage.setItem(RELOAD_GUARD_KEY, '1')
    if (this.props.pendingTab) {
      sessionStorage.setItem('pendingTab', this.props.pendingTab)
    }
    window.location.reload()
  }

  render() {
    if (this.state.hasError && !this.state.isChunkLoadError) {
      throw this.state.error // re-throw non-chunk errors so they aren't silently swallowed
    }
    return this.props.children
  }
}
```

Usage in `App.jsx`:

```jsx
<ChunkErrorBoundary pendingTab={activeTab}>
  <Suspense fallback={<PageLoadingFallback />}>
    {renderPage()}
  </Suspense>
</ChunkErrorBoundary>
```

On boot (in `App`'s top-level `useEffect`, alongside existing session
setup), check for a pending tab and restore it:

```js
useEffect(() => {
  const pending = sessionStorage.getItem('pendingTab')
  if (pending) {
    sessionStorage.removeItem('pendingTab')
    sessionStorage.removeItem(RELOAD_GUARD_KEY)
    setActiveTab(pending)
  }
}, [])
```

Net effect: click "Expenses" after a stale deploy → chunk 404s → one
automatic reload → app boots fresh with current hashes → lands directly
on Expenses instead of bouncing back to Dashboard. A second consecutive
failure (guard flag already set) does not reload again — it leaves the
Suspense fallback showing rather than reload-looping, which is an
acceptable degraded state for what should be a rare double-failure
(e.g. genuine connectivity loss).

**Open verification item:** the regex above covers the known phrasing
for Chrome/Edge, Firefox, and Safari as of researching this spec, but
since this is unversioned browser-engine behavior (not a Vite API),
the implementer should manually trigger a failed dynamic import in
each browser this app needs to support (at minimum Chrome and Safari,
per this app's actual usage) and confirm the real thrown message
matches one of the three patterns before considering this done — see
Testing step 3.

## Testing

1. **Bundle size**: `npm run build` — confirm `dist/assets/` shows 12
   separate per-page chunks in addition to Dashboard being part of the
   main entry chunk, and that the main entry chunk's size drops
   significantly from today's ~1.3MB (exact target not fixed — any
   meaningful reduction with all pages still reachable counts as
   success; report the before/after numbers).
2. **Manual click-through**: in `npm run preview`, click every one of
   the 13 tabs once, confirm each renders correctly with no console
   errors, and that revisiting an already-loaded tab within the same
   session doesn't refetch its chunk (Network tab shows it served from
   cache / not re-requested).
3. **Stale-deploy simulation**: temporarily rename one page's lazy
   import path to a nonexistent file (e.g. `./pages/Sites.jsx` →
   `./pages/SitesXXX.jsx`) to force a real dynamic-import failure,
   confirm: (a) the app doesn't crash to a blank screen, (b) exactly one
   automatic reload occurs, (c) revert the rename before the reload
   would succeed against the real (renamed-back) file — actually since
   this needs the reload to occur against a build with the typo present
   and then be manually fixed, the practical test is: build with the
   typo, run preview, click the broken tab, confirm one reload + no
   infinite loop (guard flag correctly present in `sessionStorage`
   afterward), then revert the typo and rebuild. Does not require
   deploying to production to verify. Run this in both Chrome and
   Safari (not just one) to confirm the error-message regex actually
   matches the real thrown error text in each — this is the one part
   of the design that can't be verified by reading code alone.
4. Existing test suite (`npm test`, 25 tests) must continue to pass
   unmodified — none of them touch `App.jsx`'s render path.

## Rollout

Single change, no data migration, no backend/schema involvement — pure
frontend build-output change. Ships the same way as every other fix
this session: commit, push to `main`, GitHub Actions builds and updates
the `deploy` branch, deploy to `pm.facadex.co.th` via cPanel (or the
manual zip fallback if cPanel Git is still unreliable at ship time).
