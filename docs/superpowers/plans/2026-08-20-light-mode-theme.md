# Light Mode Theme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a light color palette alongside the existing dark one, switchable via a header toggle button, defaulting to the device's OS preference on first visit and remembering the user's manual choice per device thereafter.

**Architecture:** `src/index.css`'s existing `:root` block (today's dark values) stays as the default/fallback. A `@media (prefers-color-scheme: light)` block auto-applies light when no explicit choice has been saved; `:root[data-theme="dark"]`/`:root[data-theme="light"]` blocks let an explicit choice override the media query. A tiny inline script in `index.html`'s `<head>` reads `localStorage` before first paint to set the `data-theme` attribute (avoiding a flash of the wrong theme), and a small shared helper module (`src/lib/theme.js`) provides the "what's the current effective theme" and "toggle it" logic used by both the header button and (in Task 2) the Dashboard chart.

**Tech Stack:** Plain CSS custom properties, `window.matchMedia`, `localStorage` — no new dependencies.

## Global Constraints

- No component file other than `App.jsx` (the toggle button) and `Dashboard.jsx` (Task 2, the chart) needs to change — every other component already reads CSS variables and picks up the new palette automatically.
- `--accent`, `--green`, `--red`, `--yellow`, `--blue` stay unchanged across themes — only structural/text variables (`--bg`, `--bg2`, `--bg3`, `--bg4`, `--text`, `--text2`, `--text3`, `--border`) get light equivalents.
- No changes to `src/lib/pdf.js` or any PDF-generation code — it already forces a white background regardless of theme.
- No changes to badge/alert/KPI-accent CSS rules (`.badge-*`, `.alert-*`, `.kpi-card.*::before`) — they use fixed `rgba(hex, opacity)` values already, not the variables, and read acceptably on both themes as-is.
- No cross-device sync (no database column, no user-profile setting) — `localStorage` only.

---

### Task 1: Palette, persistence, and the header toggle button

**Files:**
- Modify: `src/index.css`
- Modify: `index.html`
- Create: `src/lib/theme.js`
- Modify: `src/App.jsx`

**Interfaces:**
- Produces (used by Task 2):
  - `export function getEffectiveTheme()` in `src/lib/theme.js` — `() => 'dark' | 'light'`, returns the currently-applied theme (reads the `data-theme` attribute if explicitly set, otherwise falls back to `window.matchMedia('(prefers-color-scheme: dark)')`).
  - `export function toggleTheme()` in `src/lib/theme.js` — `() => 'dark' | 'light'`, flips the current effective theme, sets `document.documentElement`'s `data-theme` attribute, saves to `localStorage`, and returns the new theme.

- [ ] **Step 1: Add the light palette to `src/index.css`**

The file currently starts:
```css
:root {
  --bg: #0f1117;
  --bg2: #1a1d2e;
  --bg3: #252840;
  --bg4: #2e3250;
  --accent: #6c63ff;
  --green: #00d4aa;
  --red: #ff6b6b;
  --yellow: #ffd166;
  --blue: #4ecdc4;
  --text: #e8eaf6;
  --text2: #9e9ec8;
  --text3: #5c5f80;
  --border: rgba(108, 99, 255, 0.2);
  --radius: 10px;
  --shadow: 0 4px 24px rgba(0,0,0,0.3);
}
```
Leave this block exactly as-is (it's the dark/default palette) and add three new blocks immediately after it:
```css

/* Light palette: applied automatically if the OS prefers light and the
   user hasn't explicitly chosen a theme yet on this device. */
@media (prefers-color-scheme: light) {
  :root {
    --bg: #f5f6fa;
    --bg2: #ffffff;
    --bg3: #eef0f7;
    --bg4: #e4e7f2;
    --text: #1a1d2e;
    --text2: #565a7a;
    --text3: #9296b8;
    --border: rgba(108, 99, 255, 0.15);
  }
}

/* Explicit theme choice (data-theme set by src/lib/theme.js) always wins
   over the media query above, in both directions. */
:root[data-theme="dark"] {
  --bg: #0f1117;
  --bg2: #1a1d2e;
  --bg3: #252840;
  --bg4: #2e3250;
  --text: #e8eaf6;
  --text2: #9e9ec8;
  --text3: #5c5f80;
  --border: rgba(108, 99, 255, 0.2);
}

:root[data-theme="light"] {
  --bg: #f5f6fa;
  --bg2: #ffffff;
  --bg3: #eef0f7;
  --bg4: #e4e7f2;
  --text: #1a1d2e;
  --text2: #565a7a;
  --text3: #9296b8;
  --border: rgba(108, 99, 255, 0.15);
}
```

- [ ] **Step 2: Add the pre-paint theme script to `index.html`**

The file currently reads:
```html
<!DOCTYPE html>
<html lang="th">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>FACADE X — Dashboard</title>
    <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🏗️</text></svg>" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
```
Add an inline script as the very first thing inside `<head>`, before the other tags, so it runs before Vite's injected stylesheet link causes any paint:
```html
<!DOCTYPE html>
<html lang="th">
  <head>
    <script>
      // ตั้ง data-theme ก่อน paint ครั้งแรก กัน flash ของธีมผิด --
      // ถ้ายังไม่เคยเลือกเอง ปล่อยให้ @media (prefers-color-scheme) ใน
      // index.css จัดการแทน (ไม่ตั้ง attribute อะไรเลย)
      (function () {
        var saved = localStorage.getItem('theme')
        if (saved === 'light' || saved === 'dark') {
          document.documentElement.setAttribute('data-theme', saved)
        }
      })()
    </script>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>FACADE X — Dashboard</title>
    <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🏗️</text></svg>" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
```

- [ ] **Step 3: Create the shared theme helper**

Create `src/lib/theme.js`:
```js
// ============================================================
// Theme helpers -- shared between the header toggle button and any
// component (e.g. the Dashboard chart) that needs to know the current
// effective theme to pick literal colors recharts can't read from CSS.
// ============================================================

export function getEffectiveTheme() {
  const explicit = document.documentElement.getAttribute('data-theme')
  if (explicit === 'light' || explicit === 'dark') return explicit
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function toggleTheme() {
  const next = getEffectiveTheme() === 'dark' ? 'light' : 'dark'
  document.documentElement.setAttribute('data-theme', next)
  localStorage.setItem('theme', next)
  return next
}
```

- [ ] **Step 4: Add the toggle button to `App.jsx`'s header**

Add the import. Immediately after `import { canViewPage } from './lib/permissions.js'`:
```js
import { getEffectiveTheme, toggleTheme } from './lib/theme.js'
```

Add state. Immediately after `const [overviewSiteId, setOverviewSiteId] = useState(null)`:
```js
  const [theme, setTheme] = useState(getEffectiveTheme)
```
(passing `getEffectiveTheme` itself, not `getEffectiveTheme()`, as the `useState` initializer -- this is React's lazy-initial-state form, so the DOM/`matchMedia` read only happens once on mount, not on every render.)

Add the button. The header's button group currently reads:
```jsx
          <button
            className="btn btn-ghost btn-sm"
            style={{ fontSize: 12 }}
            onClick={() => setShowChangePassword(true)}
          >
            🔑 เปลี่ยนรหัสผ่าน
          </button>
          <button
            className="btn btn-ghost btn-sm"
            style={{ fontSize: 12 }}
            onClick={() => supabase.auth.signOut()}
          >
            ออกจากระบบ
          </button>
```
Add a new button immediately before the "เปลี่ยนรหัสผ่าน" button:
```jsx
          <button
            className="btn btn-ghost btn-sm"
            style={{ fontSize: 12 }}
            onClick={() => setTheme(toggleTheme())}
            title="สลับธีมสว่าง/มืด"
          >
            {theme === 'dark' ? '☀️' : '🌙'}
          </button>
          <button
            className="btn btn-ghost btn-sm"
            style={{ fontSize: 12 }}
            onClick={() => setShowChangePassword(true)}
          >
            🔑 เปลี่ยนรหัสผ่าน
          </button>
          <button
            className="btn btn-ghost btn-sm"
            style={{ fontSize: 12 }}
            onClick={() => supabase.auth.signOut()}
          >
            ออกจากระบบ
          </button>
```

- [ ] **Step 5: Verify**

Run: `npm test`
Expected: all 36 existing tests pass (no new test file — `getEffectiveTheme`/`toggleTheme` both read/write the live `document`/`window`/`localStorage`, which isn't meaningfully unit-testable without a DOM test environment this project doesn't have set up; verification is build + manual browser check, matching how other presentational features were verified this session).

Run: `npm run build`
Expected: succeeds with no new errors.

Manually confirm in the dev server (documented limitation: no test login credentials available, call this out in your report rather than skipping silently):
- With no saved preference, the app's theme matches the OS/browser's light-vs-dark setting.
- Clicking the toggle button switches the whole app's colors instantly (no page reload) and updates the button's own icon.
- Reloading the page after toggling keeps the manually-chosen theme (check `localStorage.getItem('theme')` in devtools if you can't change OS preference easily).
- Spot-check a few pages in light mode for legibility: Sites table, an Income form modal, PurchaseOrders (badge-heavy).

- [ ] **Step 6: Commit**

```bash
git add src/index.css index.html src/lib/theme.js src/App.jsx
git commit -m "feat: add light mode theme toggle"
```

---

### Task 2: Dashboard chart theme-awareness

**Files:**
- Modify: `src/pages/Dashboard.jsx`

**Interfaces:**
- Consumes: `getEffectiveTheme()` from `src/lib/theme.js` (Task 1).

- [ ] **Step 1: Add theme-aware chart colors**

The chart currently reads (inside the main `Dashboard` component's JSX):
```jsx
            <BarChart data={monthlyData} margin={{ top: 0, right: 10, bottom: 0, left: 10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
              <XAxis dataKey="label" tick={{ fill: '#9e9ec8', fontSize: 11 }} />
              <YAxis tickFormatter={fmtShort} tick={{ fill: '#9e9ec8', fontSize: 10 }} />
              <Tooltip formatter={(v) => `${fmt(v)} บาท`} contentStyle={{ background: '#252840', border: '1px solid rgba(108,99,255,0.3)', borderRadius: 8 }} />
              <Legend wrapperStyle={{ fontSize: 12, color: '#9e9ec8' }} />
              <Bar dataKey="income"  name="รายรับ"  fill="#00d4aa" radius={[3,3,0,0]} />
              <Bar dataKey="expense" name="รายจ่าย" fill="#ff6b6b" radius={[3,3,0,0]} />
            </BarChart>
```
The `Bar` `fill` colors (`#00d4aa`/`#ff6b6b`, matching `--green`/`--red`) stay exactly as they are -- per the plan's Global Constraints, semantic accent colors don't change between themes. Only the grid stroke, tick text, and tooltip background (all currently hardcoded to dark-mode-specific values) need to vary by theme.

Add the import. In `src/pages/Dashboard.jsx`, immediately after `import { th } from 'date-fns/locale'`:
```js
import { getEffectiveTheme } from '../lib/theme.js'
```

Inside the main `Dashboard` component (not `WorkerSiteProgress` -- this chart only renders in the ADMIN-visible part of the dashboard), add a small color lookup near the top of the component body, alongside its other `const`/`useState`/`useMemo` declarations:
```js
  const isDarkChart = getEffectiveTheme() === 'dark'
  const chartColors = {
    grid: isDarkChart ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.06)',
    tick: isDarkChart ? '#9e9ec8' : '#565a7a',
    tooltipBg: isDarkChart ? '#252840' : '#ffffff',
    tooltipBorder: isDarkChart ? '1px solid rgba(108,99,255,0.3)' : '1px solid rgba(108,99,255,0.25)',
  }
```
Then update the chart JSX to use these instead of the hardcoded literals:
```jsx
            <BarChart data={monthlyData} margin={{ top: 0, right: 10, bottom: 0, left: 10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} />
              <XAxis dataKey="label" tick={{ fill: chartColors.tick, fontSize: 11 }} />
              <YAxis tickFormatter={fmtShort} tick={{ fill: chartColors.tick, fontSize: 10 }} />
              <Tooltip formatter={(v) => `${fmt(v)} บาท`} contentStyle={{ background: chartColors.tooltipBg, border: chartColors.tooltipBorder, borderRadius: 8 }} />
              <Legend wrapperStyle={{ fontSize: 12, color: chartColors.tick }} />
              <Bar dataKey="income"  name="รายรับ"  fill="#00d4aa" radius={[3,3,0,0]} />
              <Bar dataKey="expense" name="รายจ่าย" fill="#ff6b6b" radius={[3,3,0,0]} />
            </BarChart>
```

- [ ] **Step 2: Verify**

Run: `npm test`
Expected: all 36 tests pass.

Run: `npm run build`
Expected: succeeds with no new errors.

Manually confirm (documented limitation, same as Task 1): in light mode, the chart's grid lines are a subtle dark tint (not the near-invisible white-on-white it would be without this fix), axis/legend text is dark and readable against the light card background, and the tooltip has a white background instead of a dark one floating oddly on the light page.

- [ ] **Step 3: Commit**

```bash
git add src/pages/Dashboard.jsx
git commit -m "feat: make Dashboard chart colors theme-aware"
```
