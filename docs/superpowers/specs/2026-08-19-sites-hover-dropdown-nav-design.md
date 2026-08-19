# "ไซท์งาน" Hover Dropdown Navigation — Design Spec

## Overview

FacadeXPM's top nav bar (`App.jsx`) currently lists 13 flat tabs, including three that all relate to the same underlying concept — a site's financial state: `sites` (🏗️ ไซท์งาน, the site list/overview), `retention` (🔒 Retention), and `deposits` (💰 มัดจำ). This groups those three under a single "ไซท์งาน" nav entry that reveals a dropdown on hover, so related pages sit together instead of competing for space in the flat tab bar.

## Goals

- "ไซท์งาน" becomes a hover-triggered dropdown containing three items: **Overview** (today's Sites page), **มัดจำ**, **Retention**.
- Clicking the "ไซท์งาน" label itself does nothing — it is a pure menu trigger, not a navigable page. Only picking an item from the dropdown navigates.
- The "ไซท์งาน" trigger shows as visually active (matches today's active-tab underline/color) whenever the current page is any of its three children — so a user looking at Retention can still see they're "inside" the ไซท์งาน section.
- All existing gating is preserved exactly, just relocated: มัดจำ only appears in the dropdown when `hasModuleAccess('client_deposits')`; all three still require `minRole: 'ADMIN'`; per-role view/edit overrides (`canViewPage`) still apply per child, independently.
- No other tab in the nav bar changes. This is not a general mega-menu redesign — the other 10 flat tabs stay exactly as they are today.

## Non-Goals

- No change to any of the three underlying pages (`Sites.jsx`, `Retention.jsx`, `Deposits.jsx`) themselves — this is nav wiring only.
- No reusable "N-level nav" framework. The data shape added to `TABS` is generic enough that a future tab could reuse it, but this plan only implements rendering for the one group.
- No mobile/touch hover fallback. The user explicitly confirmed clicking the "ไซท์งาน" label does nothing — only the hover dropdown navigates. This means on a touch device (no hover), the three grouped pages become unreachable through this trigger. The existing nav bar has no distinct mobile layout today (it's a horizontally scrollable flat row at narrow widths per `src/index.css`'s existing breakpoints) and this app is used on desktop per this session's established usage pattern, so the tradeoff is accepted as specified rather than silently "fixed" with click-to-toggle behavior the user didn't ask for. If touch support turns out to matter later, that's a follow-up question for the user, not a default to bake in now.

## Design

**Data shape.** `TABS` in `App.jsx` currently is a flat array of `{ id, label, minRole, module }`. This adds one new shape alongside it: a group entry has no `id`/`module` of its own and instead carries `children: [{ id, label, minRole, module }, ...]`:

```js
{
  label: '🏗️ ไซท์งาน',
  children: [
    { id: 'sites',     label: 'Overview',  minRole: 'ADMIN', module: null },
    { id: 'deposits',  label: '💰 มัดจำ',   minRole: 'ADMIN', module: 'client_deposits' },
    { id: 'retention', label: '🔒 Retention', minRole: 'ADMIN', module: null },
  ],
}
```

The three standalone `sites`/`retention`/`deposits` entries are removed from the flat `TABS` list (this group replaces them, in the same position `sites` occupies today — first, right after `assign`/`hr`).

**Rendering.** The nav bar's `visibleTabs` computation (today: filter flat `TABS` by role/module/permission) extends to: for each `TABS` entry, if it has `children`, filter *those* by the same three rules and keep the group only if at least one child survives; if it has no `children`, filter it exactly as today. The rendered nav bar maps over this filtered list — a plain entry renders the existing button; a group entry renders a small wrapper `<div>` containing the same-styled (non-interactive, `onClick` omitted) label plus a dropdown `<div>` shown via pure CSS `:hover` on the wrapper (`.nav-group:hover .nav-dropdown { display: block }`) — no JS open/close state needed, since the label itself never toggles anything and hover is the only trigger.

**Active state.** The group trigger is visually active (same underline treatment the flat tabs use) when `activeTab` matches any of its children's `id`s — computed the same way `visibleTabs.map` already checks `activeTab === tab.id` for flat tabs, just widened to `tab.children?.some(c => c.id === activeTab)` for a group.

**Navigation.** Clicking a dropdown item calls the exact same handler flat tabs use today (`sessionStorage.removeItem('chunk-reload-attempted'); setNavState({}); setActiveTab(child.id)`), then closes the dropdown. No new navigation path — `renderPage()`'s switch statement is untouched, since `sites`/`retention`/`deposits` still resolve to the same `activeTab` values as before.

## Testing

- No new pure-logic function is introduced (this is presentational/nav wiring), so no new unit test file. Verification is `npm test`/`npm run build` (regression check — the existing 36 tests must still pass since `renderPage()` and each page component are unchanged) plus a manual/documented check that the dropdown opens, an item navigates correctly, and a non-subscribed tenant's dropdown omits มัดจำ. Manual browser click-through has been a standing, disclosed limitation all session (no test login credentials available to implementer/reviewer subagents) — the same limitation applies here and will be called out, not silently skipped.
