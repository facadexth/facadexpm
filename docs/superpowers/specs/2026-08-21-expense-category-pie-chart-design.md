# Expense-by-Category Pie Chart — Design Spec

## Overview

Two pie charts showing expense distribution by หมวดหมู่ (category), for FacadeXPM's Expenses page and the per-site overview popup. Both use `recharts` (already a dependency, already used on `Dashboard.jsx` for its bar chart — no new library).

## Part A: Expenses Page (`src/pages/Expenses.jsx`)

### Goals

- A pie-chart card above the expenses table, grouped by `category_name`, summing `amount`.
- Reflects whatever filters are currently applied on the page (site, date range, category, supplier, status, search) — reads from the same `expenses` array the table already renders, so no new query.
- Tooltip shows category name, formatted amount (บาท), and percentage of the filtered total.
- If the filtered set is empty, show a message ("ไม่มีข้อมูล") instead of an empty chart.

### Non-Goals

- No new Supabase query — pure client-side `useMemo` aggregation of the already-fetched `expenses` array.
- No drill-down/click-to-filter interaction on chart slices — display only.

## Part B: Site Overview Popup (`src/components/SiteOverviewModal.jsx`)

### Goals

- A new "📊 ค่าใช้จ่ายตามหมวด" section (same visual style as the existing มัดจำ/Retention sections — a labeled block, conditionally rendered), showing that one site's all-time expense breakdown by category.
- New hook `useSiteExpensesByCategory(siteId)` in `src/hooks/useSupabase.js`: queries `expenses_view` filtered by `site_id` only (no date range — all-time for the site), returns raw rows; the component aggregates client-side by `category_name`, mirroring Part A's approach exactly.
- Section only renders if the site has at least one expense (matching the existing `site.deposit?.total_deposit > 0` / `site.retention?.total_retention > 0` conditional pattern already used for the other sections in this modal).

### Non-Goals

- No date-range scoping for the modal's chart — it's always the site's full history, consistent with the modal's other figures (`total_expense`, `total_income` etc. are also all-time, not date-scoped).

## Shared Design

- **Category grouping**: group by `category_name`; a null/missing category groups under "ไม่ระบุหมวด" (matching the existing `e.category_name || ''` empty-string-fallback convention elsewhere in `Expenses.jsx`, made a real fallback label here since a pie slice needs a name).
- **Colors**: a fixed palette array of ~8 colors (reusing hues from the app's existing `SITE_PALETTE_DARK`/`SITE_PALETTE_LIGHT` in `src/pages/assign/constants.js` is out of scope — that module is Assign-specific; instead use a small local palette constant), cycled by category index via recharts' `<Cell fill={...}>` — categories are a small, low-cardinality set (typically under 10), so no hashing scheme is needed.
- **Chart component**: `recharts`'s `PieChart`/`Pie`/`Cell`/`Tooltip`/`Legend`, `ResponsiveContainer` for sizing (matching `Dashboard.jsx`'s existing chart-sizing pattern).
- **Theme awareness**: chart card wrapped in the app's existing `.card` class (already theme-aware via CSS variables) — no custom dark/light handling needed beyond what the existing card/legend text colors already provide.

## Testing

- No new pure-logic function beyond a straightforward `reduce`-based grouping (same shape as `Expenses.jsx`'s existing `totalAmount`/`totalPaid` `useMemo`s) — verification is `npm test`/`npm run build` regression plus a documented, disclosed manual-browser-check limitation (no test login credentials available this session, consistent with every other UI feature built this session).
- Manual verification checklist: on the Expenses page, changing any filter updates the pie chart to match the filtered rows; an empty filter result shows the empty-state message instead of a blank chart. In the Site Overview popup, opening a site with expenses shows its category breakdown; opening a site with zero expenses shows no chart section at all (not an empty chart).
