# Excel Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a shared "export to Excel" utility and wire an export button into Income.jsx and Expenses.jsx, so each downloads exactly the rows currently on screen (respecting whatever filters are active) with real numeric/date cells, not formatted display strings.

**Architecture:** One pure, testable row-mapping function (`buildExportRows`) plus a thin browser-only wrapper (`exportToExcel`) in a new `src/lib/exportExcel.js`, using the `xlsx` (SheetJS) library already a dependency of this project (currently only used for import in `src/components/ExcelUpload.jsx`). Both pages call the same `exportToExcel(rows, columns, filenameBase)` signature with their own column list.

**Tech Stack:** `xlsx` (SheetJS, already a dependency, `^0.18.5`), Vitest.

## Global Constraints

- Export only the rows currently rendered under the page's active filters — never a separate "export everything" mode. Income/Expenses already fetch server-side filtered data (`useIncomes(filters)`/`useExpenses(filters)`), so "the rows currently in state" already is "what's on screen."
- Numeric cells must be real numbers (no thousands separators, no currency symbol) — pass raw stored numbers straight through, not the `fmt()`-formatted display strings.
- Date cells must be real Excel dates, not Thai-formatted display strings — achieved via SheetJS's `cellDates: true` option plus converting stored ISO date strings to JS `Date` objects before handing rows to SheetJS.
- Column set and order must match each page's current on-screen `<th>` order exactly, excluding the trailing empty actions column.
- No import-to-overwrite feature — out of scope entirely for this plan.

---

### Task 1: `exportToExcel` utility + unit tests

**Files:**
- Create: `src/lib/exportExcel.js`
- Create: `src/lib/exportExcel.test.js`

**Interfaces:**
- Produces (used by Tasks 2 and 3):
  - `export function buildExportRows(rows, columns)` in `src/lib/exportExcel.js` — `(rows: object[], columns: {header: string, accessor: (row) => any}[]) => object[]`. Pure function: maps each row through the column accessors, returning plain objects keyed by each column's `header` string, in column-definition order. This is the piece that's actually worth unit testing (row shaping/date conversion logic) — `XLSX.writeFile` itself is a real-download side effect, not unit-testable, and isn't worth mocking.
  - `export function exportToExcel(rows, columns, filenameBase)` in `src/lib/exportExcel.js` — `(rows: object[], columns: {header: string, accessor: (row) => any}[], filenameBase: string) => void`. Calls `buildExportRows`, builds a workbook via `XLSX.utils.json_to_sheet(..., { cellDates: true })` + `XLSX.utils.book_new()` + `XLSX.utils.book_append_sheet()`, then `XLSX.writeFile(workbook, filename)` where `filename` is `` `${filenameBase}_${timestamp}.xlsx` `` (timestamp format below).

- [ ] **Step 1: Write the failing tests for `buildExportRows`**

Create `src/lib/exportExcel.test.js`:
```js
import { describe, it, expect } from 'vitest'
import { buildExportRows } from './exportExcel.js'

describe('buildExportRows', () => {
  it('maps rows through column accessors, keyed by header', () => {
    const rows = [
      { id: 1, amount_no_vat: 1000, description: 'ค่าแรง' },
      { id: 2, amount_no_vat: 2000, description: 'ค่าวัสดุ' },
    ]
    const columns = [
      { header: 'รายละเอียด', accessor: r => r.description },
      { header: 'ก่อน VAT', accessor: r => r.amount_no_vat },
    ]
    expect(buildExportRows(rows, columns)).toEqual([
      { 'รายละเอียด': 'ค่าแรง', 'ก่อน VAT': 1000 },
      { 'รายละเอียด': 'ค่าวัสดุ', 'ก่อน VAT': 2000 },
    ])
  })

  it('preserves column order regardless of row object key order', () => {
    const rows = [{ b: 2, a: 1 }]
    const columns = [
      { header: 'A', accessor: r => r.a },
      { header: 'B', accessor: r => r.b },
    ]
    const result = buildExportRows(rows, columns)
    expect(Object.keys(result[0])).toEqual(['A', 'B'])
  })

  it('passes numbers through as real numbers, not formatted strings', () => {
    const rows = [{ amount: 1234567.89 }]
    const columns = [{ header: 'ยอด', accessor: r => r.amount }]
    const result = buildExportRows(rows, columns)
    expect(result[0]['ยอด']).toBe(1234567.89)
    expect(typeof result[0]['ยอด']).toBe('number')
  })

  it('converts an accessor-returned Date to a real Date instance (passthrough)', () => {
    const rows = [{ date: '2026-01-15' }]
    const columns = [{ header: 'วันที่', accessor: r => new Date(r.date) }]
    const result = buildExportRows(rows, columns)
    expect(result[0]['วันที่']).toBeInstanceOf(Date)
  })

  it('returns an empty array for an empty rows array', () => {
    const columns = [{ header: 'A', accessor: r => r.a }]
    expect(buildExportRows([], columns)).toEqual([])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- exportExcel`
Expected: FAIL — `Failed to resolve import "./exportExcel.js"` (the module doesn't exist yet).

- [ ] **Step 3: Implement `src/lib/exportExcel.js`**

```js
// ============================================================
// Excel export -- shared by any page that wants a "export to Excel"
// button. Exports exactly the rows the caller passes in (already
// filtered by that page's own active filters -- this module does no
// filtering of its own), with real numeric/date cells rather than the
// formatted display strings shown on screen.
// ============================================================
import * as XLSX from 'xlsx'

/**
 * Pure row-shaping step: maps `rows` through `columns`' accessors into
 * plain objects keyed by each column's header, in column-definition
 * order. Exported separately from exportToExcel so this logic --  the
 * only part worth automated testing -- can be tested without triggering
 * a real file download.
 */
export function buildExportRows(rows, columns) {
  return rows.map(row => {
    const out = {}
    for (const col of columns) {
      out[col.header] = col.accessor(row)
    }
    return out
  })
}

function timestamp() {
  const d = new Date()
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
}

/**
 * Builds a single-sheet workbook from `rows`/`columns` (see
 * buildExportRows) and triggers a browser download named
 * `${filenameBase}_${timestamp}.xlsx`. cellDates:true makes any
 * accessor that returns a JS Date write as a real Excel date cell
 * instead of a bare serial number or string.
 */
export function exportToExcel(rows, columns, filenameBase) {
  const data = buildExportRows(rows, columns)
  const worksheet = XLSX.utils.json_to_sheet(data, { cellDates: true })
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Sheet1')
  XLSX.writeFile(workbook, `${filenameBase}_${timestamp()}.xlsx`)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- exportExcel`
Expected: PASS, 5 tests passing.

- [ ] **Step 5: Run the full suite and build**

Run: `npm test`
Expected: all tests pass (41 total: 36 existing + 5 new).

Run: `npm run build`
Expected: succeeds with no new errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/exportExcel.js src/lib/exportExcel.test.js
git commit -m "feat: add exportToExcel utility for browser-side Excel export"
```

---

### Task 2: Wire export into Income.jsx

**Files:**
- Modify: `src/pages/Income.jsx`

**Interfaces:**
- Consumes: `exportToExcel(rows, columns, filenameBase)` from `src/lib/exportExcel.js` (Task 1).

- [ ] **Step 1: Import the utility**

In `src/pages/Income.jsx`, add this import alongside the existing ones (after `import ExcelUpload from '../components/ExcelUpload.jsx'`):
```js
import { exportToExcel } from '../lib/exportExcel.js'
```

- [ ] **Step 2: Add the column list and click handler**

Inside the `Income` component (after the existing `showToast` helper, before the `handleSave` function), add:
```js
  const handleExport = () => {
    const columns = [
      { header: 'เลขใบแจ้งหนี้', accessor: i => i.invoice_no || '' },
      { header: 'วันที่', accessor: i => new Date(i.date) },
      { header: 'ไซท์งาน', accessor: i => i.site_name || '' },
      { header: 'ลูกค้า', accessor: i => i.client_name || '' },
      { header: 'รายละเอียด', accessor: i => i.description || '' },
      { header: 'ก่อน VAT', accessor: i => i.amount_no_vat || 0 },
      { header: 'VAT', accessor: i => i.vat || 0 },
      { header: 'Tax หัก', accessor: i => i.tax_withheld || 0 },
      { header: 'Retention', accessor: i => i.retention || 0 },
      { header: 'หักมัดจำ', accessor: i => i.deposit_deduction || 0 },
      { header: 'ยอดรับจริง', accessor: i => i.received_amount || 0 },
    ]
    exportToExcel(incomes || [], columns, `รายรับ_${dateFrom}_ถึง_${dateTo}`)
  }
```
(This matches the 11 on-screen `<th>` columns in the same order, excluding the trailing empty actions column. `date` is converted to a real `Date` object here, matching the plan's Global Constraint on date cells.)

- [ ] **Step 3: Add the export button**

The toolbar currently reads (around the "Import Excel"/"Template" buttons):
```jsx
        {canEdit && <button className="btn btn-success" onClick={() => { setEditRow(null); setShowAdd(true) }}>+ เพิ่มรายรับ</button>}
        {canEdit && <button className="btn btn-ghost" onClick={() => setShowImport(v => !v)}>📥 Import Excel</button>}
        <a className="btn btn-ghost" href="/templates/TEMPLATE_รายรับ.xlsx" download>📄 Template</a>
```
Add the export button immediately after the Template link:
```jsx
        {canEdit && <button className="btn btn-success" onClick={() => { setEditRow(null); setShowAdd(true) }}>+ เพิ่มรายรับ</button>}
        {canEdit && <button className="btn btn-ghost" onClick={() => setShowImport(v => !v)}>📥 Import Excel</button>}
        <a className="btn btn-ghost" href="/templates/TEMPLATE_รายรับ.xlsx" download>📄 Template</a>
        <button className="btn btn-ghost" onClick={handleExport}>📤 Export Excel</button>
```
(Not gated behind `canEdit` — exporting is a read action, available to anyone who can already view this page, unlike importing which writes data.)

- [ ] **Step 4: Verify**

Run: `npm test`
Expected: all 41 tests pass (no new test file needed here — this task is UI wiring around an already-tested pure function; the button's correctness is that it calls `exportToExcel` with the right arguments, which is straightforward enough to verify by reading the diff plus a manual check).

Run: `npm run build`
Expected: succeeds with no new errors.

Manually confirm in the dev server (documented, standing limitation this session: no test login credentials available — call this out in your report rather than skipping silently): clicking "📤 Export Excel" downloads a file; opening it shows 11 columns matching the on-screen table headers, in the same order; numeric columns are real numbers (Excel right-aligns them and lets you SUM); the "วันที่" column shows as a real date (Excel lets you apply date formatting / do date math on it, and it's not left-aligned like a text string would be); the row count matches what the on-screen table currently shows under whatever date range/site/search filter is active; changing the date filter and re-exporting produces a different row count matching the new filter.

- [ ] **Step 5: Commit**

```bash
git add src/pages/Income.jsx
git commit -m "feat: add Excel export button to Income"
```

---

### Task 3: Wire export into Expenses.jsx

**Files:**
- Modify: `src/pages/Expenses.jsx`

**Interfaces:**
- Consumes: `exportToExcel(rows, columns, filenameBase)` from `src/lib/exportExcel.js` (Task 1).

- [ ] **Step 1: Import the utility**

In `src/pages/Expenses.jsx`, add this import alongside the existing imports (near wherever `ExcelUpload`/`fmt`/`fmtDate` are imported from):
```js
import { exportToExcel } from '../lib/exportExcel.js'
```

- [ ] **Step 2: Add the column list and click handler**

Inside the `Expenses` component, add a handler analogous to Income's:
```js
  const handleExport = () => {
    const PAYMENT_METHOD_LABEL = { transfer: 'โอน', check: 'เช็ค', cash: 'เงินสด' }
    const columns = [
      { header: 'วันที่', accessor: e => new Date(e.date) },
      { header: 'รายละเอียด', accessor: e => e.description || '' },
      { header: 'ไซท์งาน', accessor: e => e.site_name || '' },
      { header: 'หมวด', accessor: e => e.category_name || '' },
      { header: 'ผู้จำหน่าย', accessor: e => e.supplier || '' },
      { header: 'มูลค่า', accessor: e => e.amount || 0 },
      { header: 'วิธีชำระ', accessor: e => PAYMENT_METHOD_LABEL[e.payment_method] || e.payment_method || '' },
      { header: 'วันเช็ค', accessor: e => e.check_date ? new Date(e.check_date) : '' },
      { header: 'สถานะ', accessor: e => STATUS_LABELS[e.status] || e.status || '' },
    ]
    exportToExcel(expenses || [], columns, `รายจ่าย_${dateFrom}_ถึง_${dateTo}`)
  }
```
(`STATUS_LABELS` is already defined/imported at module scope in this file, the same lookup the table's status badge already uses — reuse it, don't redefine it. `PAYMENT_METHOD_LABEL` is defined locally here since the table currently inlines this exact 3-way ternary rather than using a shared constant — matching the existing table's on-screen text exactly, per the plan's Global Constraint on column values matching what's currently shown.)

- [ ] **Step 3: Add the export button**

Find this file's equivalent toolbar (the "📥 Import Excel"/"📄 Template" buttons) and add the export button immediately after the Template link, following the exact same placement pattern used in Task 2 for Income.jsx:
```jsx
        <button className="btn btn-ghost" onClick={handleExport}>📤 Export Excel</button>
```
(Not gated behind `canEdit`, same reasoning as Income.)

- [ ] **Step 4: Verify**

Run: `npm test`
Expected: all 41 tests pass.

Run: `npm run build`
Expected: succeeds with no new errors.

Manually confirm (documented limitation, same as Task 2): clicking export downloads a file with 9 columns matching the on-screen table headers in order; `มูลค่า` is a real number; `วันที่`/`วันเช็ค` are real dates (with `วันเช็ค` correctly blank, not `"Invalid Date"`, for rows with no check date); `วิธีชำระ`/`สถานะ` show the same Thai label text the table already displays, not raw internal codes; row count matches the currently-filtered on-screen table.

- [ ] **Step 5: Commit**

```bash
git add src/pages/Expenses.jsx
git commit -m "feat: add Excel export button to Expenses"
```
