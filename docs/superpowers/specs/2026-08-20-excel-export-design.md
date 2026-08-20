# Excel Export — Design Spec

## Overview

FacadeXPM currently has zero export functionality anywhere (confirmed by codebase search — `xlsx` is a dependency, but only ever used for *import*, in `src/components/ExcelUpload.jsx`). This adds a shared "Export to Excel" mechanism and wires it into the two highest-value pages first: Income and Expenses. Export-only — no import-to-overwrite counterpart is being built (an explicit, deliberate user decision: bulk data edits will continue to be done manually, outside the app, when genuinely needed, rather than building a permanent overwrite pathway into the product).

## Goals

- A reusable export utility that any page's table can call with its own column list and row data.
- Income.jsx and Expenses.jsx each get an "📤 Export Excel" button next to their existing "📥 Import Excel" button.
- The exported file contains exactly what's currently on screen — the same rows the table is rendering after the page's active filters (date range, site, search, status, etc.) — not a full unfiltered dump. If a user wants "everything," they clear their filters first, the same way they already would to *see* everything.
- Numbers export as real numeric cells (no thousands-separator formatting, no currency symbol) so they're immediately usable in Excel SUM/pivot formulas. Dates export as native Excel date cells (via SheetJS's date-cell support), not as Thai-formatted display strings.
- Column set matches what's visible in each page's on-screen table today — not a richer/different set, and not identical between the two pages, since Income and Expenses have different columns.

## Non-Goals

- No import-to-overwrite/replace feature. Explicitly rejected by the user this session — too risky for financial data; any future bulk edit need gets handled manually (SQL/script, human-reviewed), not through a permanent in-app pathway.
- No rollout to the other 11 list-view pages (Sites, PurchaseOrders, LaborContractors, Assign, Retention, Deposits, Clients, Suppliers, Categories, HR, UserManagement) in this spec. The shared utility is designed so adding export to any of those later is "pass a new column list," but that wiring is out of scope here — revisit only if/when requested.
- No server-side export (e.g., a Supabase Edge Function generating the file) — the export utility runs entirely client-side on the rows the page has already fetched and is already rendering, using the browser's existing `xlsx` (SheetJS) dependency, the same library `ExcelUpload.jsx` already uses for parsing.
- No "export everything regardless of filters" toggle — deliberately out of scope per the user's explicit choice; if wanted later, that's a small follow-up to the same utility, not a redesign.

## Design

**1. Shared utility: `src/lib/exportExcel.js`** (new file). One exported function:

```js
export function exportToExcel(rows, columns, filenameBase)
```

- `rows`: the array of row objects a page is already rendering (e.g. `incomes` after `useIncomes(filters)`, already filtered server-side by the page's active date range/site/search — Income and Expenses both already pass their filters into their data-fetching hook, so "what's on screen" and "what the hook returned" are the same set; no separate client-side re-filtering needed in the export utility itself).
- `columns`: an array of `{ header: string, accessor: (row) => value }` — `header` becomes the Excel column title (matching the page's on-screen `<th>` text exactly), `accessor` extracts and shapes the cell value from a row (e.g. converting a stored ISO date string into a real JS `Date` object for SheetJS to write as a native Excel date cell, or leaving a number as a plain number).
- `filenameBase`: a string the caller provides (e.g. `รายรับ_2026-01-01_ถึง_2026-08-20`), which the utility appends a timestamp to and use as the downloaded filename, so repeated exports on the same day/range don't silently overwrite each other in the user's Downloads folder.

Internally: builds a single-sheet workbook with `XLSX.utils.json_to_sheet` (mapping `rows` through `columns` first to produce plain objects keyed by `header`), then `XLSX.writeFile(workbook, filename)` — the same `xlsx` global `ExcelUpload.jsx` already imports, just used in the opposite (write) direction for the first time in this codebase.

**2. Income.jsx wiring.** A new "📤 Export Excel" button next to the existing "📥 Import Excel" button in the toolbar. On click, calls `exportToExcel` with:
- `rows`: the `incomes` array already held in the component's state (from `useIncomes(filters)`, `filters` being the page's own `dateFrom`/`dateTo`/`siteId`/`search` state — already respects whatever the user has filtered to, no extra plumbing needed).
- `columns`: one entry per visible `<th>` in the table today — เลขใบแจ้งหนี้, วันที่, ไซท์งาน, ลูกค้า, รายละเอียด, ก่อน VAT, VAT, Tax หัก, Retention, หักมัดจำ, ยอดรับจริง (11 columns; the current table's last `<th>` is the empty actions column, excluded from export). Numeric accessors (`amount_no_vat`/`vat`/`tax_withheld`/`retention`/`deposit_deduction`/`received_amount`) pass the raw stored number straight through, unformatted. The `วันที่` accessor converts the stored `date` string to a `Date` object.
- `filenameBase`: `` รายรับ_${dateFrom}_ถึง_${dateTo} `` (falls back gracefully if a site filter is active — filename doesn't need to encode every filter, just the date range, since that's the dimension most exports will be sliced by).

**3. Expenses.jsx wiring.** Same pattern, next to Expenses' existing "📥 Import Excel" button. Columns: วันที่, รายละเอียด, ไซท์งาน, หมวด, ผู้จำหน่าย, มูลค่า, วิธีชำระ, วันเช็ค, สถานะ (9 columns, matching the current table's `<th>`s minus the trailing empty actions column). `วิธีชำระ`/`สถานะ` accessors export the same Thai label text already shown on screen (e.g. `"โอน"`/`"เช็ค"`/`"เงินสด"` for payment method, the `STATUS_LABELS[e.status]` lookup already used in the table) rather than the raw internal status code, since that's what a human reading the exported file would expect to see.

## Testing

- `exportToExcel`'s row-mapping logic (rows × columns → plain objects, date conversion) is a pure function worth a real unit test: given a small fixture array of rows and a column list, assert the shape of the object array passed to `XLSX.utils.json_to_sheet` is correct (right keys, right value types — numbers stay numbers, date strings become `Date` instances). The actual `XLSX.writeFile` browser-download call itself is not unit-testable (it triggers a real file save) and isn't worth mocking — that part is covered by manual verification instead.
- Manual verification (documented, standing limitation this session: no test login credentials available to implementer/reviewer subagents) — open the exported file and confirm: column headers match the on-screen table exactly, numeric cells are real numbers (not text, not comma-formatted), date cells are real Excel dates (not strings), and the row count matches what's currently visible on screen under whatever filter was active at export time.
