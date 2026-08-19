# Site Overview Modal — Design Spec

## Overview

FacadeXPM shows a site's name as plain text in nine different pages (Sites, Income, Expenses, PurchaseOrders, Assign, LaborContractors, Retention, Deposits, Dashboard), but there's no quick way to see that one site's full financial picture without navigating to the dedicated Sites list and scanning for it. This adds a click-to-open overview modal, reachable from every one of those site-name mentions, showing a single site's contract/financial summary plus its deposit (มัดจำ) and retention status together in one place.

This was originally scoped during the client-deposit-tracking brainstorm as "Sub-project B," deferred until deposit tracking (now shipped) existed to summarize. It is independent of, and unrelated in implementation to, the separately-specced hover-dropdown nav (`2026-08-19-sites-hover-dropdown-nav-design.md`) — that spec's "Overview" dropdown item still points at the existing all-sites list page, unchanged; this modal is an additive per-site drill-down reachable from anywhere, not a replacement for any existing page.

## Goals

- Clicking a site's name in any of the 9 pages that currently render one opens a modal showing that one site's overview — no page navigation, no loss of the page/filter state the user was already on.
- Content: contract value, total income/expense, gross profit, billing %, status, start/end date (from `site_financial_summary`); deposit collected/deducted/remaining + status (from `site_deposit_summary`); retention amount, due date, released status (from `site_retention_summary`) — a "summary + มัดจำ/retention" scope, explicitly not a full read-only clone of the Sites edit form (no cost breakdown, no attachments).
- Modal-based (floats over the current page), not a page navigation — matches the user's explicit choice for "quick look without losing context."

## Non-Goals

- No changes to the existing Sites list page's content or the hover-dropdown nav spec — both are separate, already-decided pieces this doesn't touch.
- No cost breakdown (`cost_aluminum`/`cost_glass`/etc.), no attachments, no edit capability inside the modal — it is read-only summary, matching the user's explicit "สรุปเต็มที่ + มัดจำ/retention" choice over the alternative "everything the Sites edit form has."
- No new database views or columns — this reads three existing views (`site_financial_summary`, `site_deposit_summary`, `site_retention_summary`) that already carry everything the modal needs; nothing here required a schema change.

## Design

**1. Data layer.** A new hook, `useSiteOverview(siteId)`, added to `src/hooks/useSupabase.js`. It fetches one row from each of the three existing views in parallel (`Promise.all`, each filtered `.eq('id'|'site_id', siteId).single()`) and merges them into one object: the flat `site_financial_summary` columns, plus a nested `.deposit` (the `site_deposit_summary` row) and `.retention` (the `site_retention_summary` row). Returns `null` when `siteId` is falsy, matching the existing `useSite(id)`/`useSiteDepositBalance(siteId)` convention in the same file.

**2. `SiteOverviewModal.jsx`** (new file, `src/components/`). Props: `siteId`, `onClose`. Internally calls `useSiteOverview(siteId)` and renders, inside the existing `Modal` component (`src/components/Modal.jsx`, the same wrapper every other modal in the app already uses):
- Header: site name, site number, status badge (reusing the existing `badge-status-*` classes from `Sites.jsx`'s table).
- Financial section: contract value, total income, total expense, gross profit, billing % — same fields/formatting `Sites.jsx`'s table already displays for these columns.
- Deposit section: only rendered when `deposit.total_deposit > 0` (mirrors `Deposits.jsx`'s own visibility rule) — collected/deducted/remaining amounts, and the same "คงเหลือ"/"หักครบแล้ว" status labels `Deposits.jsx` uses.
- Retention section: only rendered when `retention.total_retention > 0` (mirrors `Retention.jsx`'s own visibility rule) — amount, due date, and the same status labels `Retention.jsx` uses (including the "รอจบงาน" case for sites still in progress).
- No footer actions beyond a close button — no "quick links to Income/Expenses" navigation buttons in this first version (out of scope unless requested later; the existing pages already have their own site-filtered navigation entry points).

**3. Global wiring.** The modal's open/close state (`openSiteId`, `setOpenSiteId`) lives in `App.jsx`, following the exact pattern the existing `ChangePassword` modal already uses (`showChangePassword` state + conditional render at the bottom of `App.jsx`'s JSX). A new `openSiteOverview(id)` function (`id => setOpenSiteId(id)`) is added to the `props` object every page component already receives (`const props = { navigateTo, navState }` becomes `{ navigateTo, navState, openSiteOverview }`), so no page needs its own local modal state — they only need to call the prop.

**4. Site-name wiring, one page at a time.** In each of the 9 pages, the cell/element that currently renders a bare site name gets wrapped so clicking it calls `openSiteOverview(site.id)` (using whatever the row's site-id field is called in that page's existing data — e.g. `i.site_id` in Income.jsx, `s.id` in Sites.jsx, `row.site_id` in Retention.jsx/Deposits.jsx) instead of doing nothing. Existing click handlers on *other* cells in the same row (e.g. Sites.jsx's "รายรับ"/"รายจ่าย" cells that already `navigateTo`) are untouched — this only adds a handler to the name cell itself, which today has none.

## Testing

- No new pure-logic function beyond the hook's data-merging, which has no branching worth unit-testing in isolation (it's three parallel fetches plus an object spread) — verification is `npm test`/`npm run build` regression (all 9 touched pages' existing tests, if any, plus the app-wide 36) and a manual/documented check that clicking a name in each of the 9 locations opens the modal with the right site's data. Manual browser click-through remains a standing, disclosed limitation this session (no test login credentials available to implementer/reviewer subagents) — flagged explicitly, not silently skipped, same as every other UI feature built this session.
