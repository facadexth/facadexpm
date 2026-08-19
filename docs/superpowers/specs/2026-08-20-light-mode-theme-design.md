# Light Mode Theme — Design Spec

## Overview

FacadeXPM is currently dark-mode-only, styled entirely through CSS custom properties defined once in `src/index.css`'s `:root` block (`--bg`, `--bg2`, `--text`, `--accent`, etc.). This adds a light palette and a way to switch between them, so users can pick whichever is easier on their eyes.

## Goals

- A light color palette exists alongside the current dark one, switchable at runtime.
- On first visit (no saved preference yet), the theme follows the device/OS's `prefers-color-scheme` setting.
- Once a user manually toggles, that choice is remembered for that device/browser (not synced across devices — explicitly not needed per user decision) and overrides the OS preference from then on.
- A toggle button in the header lets the user switch themes at any time.
- Everything that currently reads a CSS variable (badges, buttons, cards, tables, modals, forms) picks up the new palette automatically, with no per-component changes needed — because the mechanism is variable-value swapping, not new classes.
- The Dashboard's income/expense bar chart (recharts) — the one part of the UI that uses hardcoded hex colors instead of CSS variables (grid lines, axis labels, tooltip background) — gets theme-aware colors too, since a dark tooltip floating over a light page would look broken.

## Non-Goals

- No per-tenant/brand accent color customization — that's the separate, not-yet-scoped white-labeling roadmap item (see `saas-roadmap-decisions` — tenant logo, not tenant color). This spec is strictly light/dark, not a color picker.
- No changes to PDF generation (`src/lib/pdf.js`, purchase-order/labor-payment PDF exports) — it already forces a white background (`backgroundColor: '#ffffff'` passed to `html2canvas`) regardless of the app's theme, so printed/exported documents are already theme-independent. Confirmed by reading the current code before writing this spec.
- No re-tuning of the badge/alert/KPI-accent background colors (`.badge-paid`, `.alert-success`, `.kpi-card.green::before`, etc.). These are already low-opacity tinted colors (e.g. `rgba(0,212,170,0.15)`) layered over the surrounding surface color, not full-strength fills — this pattern reads acceptably on both a dark and a light background without per-theme adjustment, so they're left as-is. Confirmed by reading `src/index.css`'s badge/alert rules before writing this spec — they use fixed `rgba(hex, opacity)` values, not the `--green`/`--red`/etc. variables directly, so they don't inherit theme changes automatically anyway, and don't need to.
- No cross-device sync of the theme preference (a database column, a user-profile setting) — explicitly decided against; `localStorage` per device is sufficient.

## Design

**1. Palette mechanism.** `src/index.css`'s existing `:root { ... }` block (today's dark values) becomes the default/fallback. Three new blocks are added:
- `@media (prefers-color-scheme: light) { :root { ...light values... } }` — auto-applies light if the OS prefers light AND the user hasn't manually chosen yet.
- `:root[data-theme="dark"] { ...dark values (same as the base :root today)... }` — explicit override once the user manually picks dark, winning over the media query in both directions.
- `:root[data-theme="light"] { ...light values... }` — explicit override once the user manually picks light.

This is the standard token-level theming pattern: every component already reads `var(--bg)`/`var(--text)`/etc., so redefining those four variable sets is the entire mechanism — no component file needs to change for the palette itself (only the Dashboard chart, per Goals, since recharts needs literal color values, not CSS variables, passed as props).

**2. Light palette values.** Structural/text variables get real light equivalents; semantic accent colors (`--green`, `--red`, `--yellow`, `--blue`, `--accent`) stay close to their current hex values (already reasonably saturated, mid-brightness colors that read fine on either a dark or a light background) with minor adjustments only if needed for WCAG contrast against a white background:
```css
--bg: #f5f6fa;
--bg2: #ffffff;
--bg3: #eef0f7;
--bg4: #e4e7f2;
--text: #1a1d2e;
--text2: #565a7a;
--text3: #9296b8;
--border: rgba(108, 99, 255, 0.15);
```
(`--accent`, `--green`, `--red`, `--yellow`, `--blue` unchanged from today's values — they're already vivid enough to read on white.)

**3. Persistence and detection.** A small script (inline in `index.html` or a tiny module imported first in `main.jsx`, before React renders, to avoid a flash of the wrong theme) runs once on load:
- Read `localStorage.getItem('theme')`. If it's `'light'` or `'dark'`, set `document.documentElement.dataset.theme` to that value immediately.
- If nothing is saved, don't set `data-theme` at all — the `@media (prefers-color-scheme)` block handles it automatically, and no explicit choice has been made yet.

**4. Toggle button.** Added to `App.jsx`'s header, next to the existing "เปลี่ยนรหัสผ่าน"/"ออกจากระบบ" buttons — a small ☀️/🌙 icon button. Clicking it:
- Determines the *current effective* theme (read `document.documentElement.dataset.theme`, falling back to checking `window.matchMedia('(prefers-color-scheme: dark)').matches` if unset).
- Sets `document.documentElement.dataset.theme` to the opposite value and saves it to `localStorage.setItem('theme', ...)`.
- No page reload needed — CSS variables update instantly since they're just an attribute change.

**5. Dashboard chart.** The `BarChart`'s hardcoded colors (`CartesianGrid stroke`, `XAxis`/`YAxis` tick `fill`, `Tooltip` `contentStyle`, `Legend` `wrapperStyle` color) get computed from the current theme instead of fixed hex strings — read the same way the toggle button determines "current effective theme," and pick one of two small literal-color objects (dark-chart-colors vs light-chart-colors) accordingly. The `Bar` fill colors (`#00d4aa`/`#ff6b6b`, matching `--green`/`--red`) stay as-is — same reasoning as the Non-Goals badge/alert point, they already read fine on both backgrounds.

## Testing

- No new pure-logic function beyond a small "get current effective theme" helper and the toggle handler — both trivial enough that manual/build verification is the bar, consistent with how this session's other presentational features were verified (`npm test`/`npm run build` regression, plus a documented, disclosed manual-browser-check limitation since no test login credentials are available to implementer/reviewer subagents this session).
- Verify specifically: first load with no saved preference follows OS preference; toggling persists across a page reload; every existing page (spot-check a few: Sites table, Income form modal, a badge-heavy page like PurchaseOrders) looks legible in both themes; the Dashboard chart's tooltip/grid/axis text is readable in both themes.
