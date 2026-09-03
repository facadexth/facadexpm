# Document Header Redesign + Real Pagination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the QuotationPaper/DocumentPaper document header to match the approved reference design, and add real multi-page pagination (full header repeated per page) so long item lists split correctly across on-screen preview, print, and PDF export.

**Architecture:** A small shared pagination hook (`usePaginatedDocument`) measures real rendered header/row heights in a hidden pass, then buckets items into fixed-height pages using the exact fixed-page-div + `pageBreakAfter`/`breakAfter` pattern already proven in `WorkPhotosDocumentModal`. `QuotationPaper` and `DocumentPaper` each get their header JSX rewritten to the new layout and are wired to loop over the hook's `pages` output instead of rendering one flat list. JPG export (single-canvas, can't represent multiple pages) gets disabled via a new `disabled` flag on `RowActionsMenu` items whenever a document computes to more than one page.

**Tech Stack:** React (function components, hooks), Supabase (Postgres + RLS), html2pdf.js / html2canvas (unchanged), no test runner in this project — verification is live (Playwright against a throwaway Supabase tenant), matching this project's established norm.

**Spec:** `docs/superpowers/specs/2026-09-04-document-header-pagination-design.md`

## Global Constraints

- Page padding: 40px vertical, 44px horizontal.
- Header row: flex, `align-items: stretch`, `gap: 25px`. Left column inner gap (logo↔text): 20px.
- Logo wrapper width: 110px (existing decoupled absolute-position stretch mechanism — do not change how it scales, only its wrapper width).
- Type scale: company name 18px/800, address/tax-id/contact line 12px/`#6a6f85` (contact line text color `#4a4d63`), doc title 28px/800, page-number line 12px/`#6a6f85`, table/info-box text 12px.
- Contact line: single line `📞 {phone}   ✉️ {email}   🌐 {website}`, `margin-top: 6px` from the tax-ID line, each segment conditionally rendered only when that tenant field is set.
- Client-info / doc-info row: `display:grid; grid-template-columns: 66fr 34fr; gap: 20px` — **`fr` units, not `%`** (guarantees the box's right edge lands on the page's right margin). Client-info column and doc-info box each get their **own independent** `margin-top: 17px` (two separate style declarations, not one shared parent margin — moving one later must never move the other).
- Client info format: inline `label : value`, line-height 2 — `ลูกค้า : {name}` (bold name) / `ที่อยู่ : {address}` / `เลขที่ภาษี : {tax_id}` (only when set).
- Doc-info box: bordered `#e4e6ef`, radius 8px, padding `14px 16px`, 2×2 grid, 12px text.
- Item table header: 12px text, weight 700, background `#f4f4f6`, text color `#4a4d63`, vertical padding 11px, `border-bottom: 2px solid {ACCENT}`.
- Accent color constant: `#6c63ff` (single source of truth per file — define once, reference everywhere it's currently hardcoded: tag border/text, table header border, totals row border/text). Revision suffix and logo are explicitly **not** accent-colored.
- Pagination page height: **960px** (960 = shipped single-page `minHeight` of 1000px minus a ~4% safety margin, mirroring `WorkPhotosDocumentModal`'s 270mm-vs-277mm workaround for an `html2pdf.js` page-break modulo bug).
- No new test runner — this project has none (`package.json` has no test script). Every task verifies live: `npx vite build`, a throwaway Supabase test tenant via the exact `auth.users`/`auth.identities` INSERT pattern used throughout this session (empty-string `confirmation_token`/`recovery_token`/`email_change_token_new`/`email_change`; never insert `tenants`/`user_roles` directly — the `handle_new_user()` trigger creates them), Playwright screenshots against `http://localhost:5199`, full cleanup afterward in FK-dependency order (`quotation_items`/`invoice_items` → `quotations`/`invoices` → `bank_accounts` → `clients` → `sites` → `audit_logs` → `app_settings` → `document_prints` → `user_roles` → `tenants` → `auth.identities` → `auth.users`, verified with a final 0-row count query), then commit + push directly to `main` (`git fetch origin main`, confirm `git log HEAD..origin/main --oneline` is empty, then `git push origin worktree-quotation-module:main` — no PR workflow).
- Sandbox note: multi-line heredoc `git commit -m "$(cat <<'EOF' ...)"` gets rejected as "too complex" in this worktree's sandbox. Write the commit message to a temp file first, then `git commit -F <file>`.
- Migration numbering: the last migration in `supabase/migrations/` is `2026-09-03-13-units.sql`. This plan's migration is dated `2026-09-04-01-tenant-contact-fields.sql`.

---

### Task 1: Add `email`/`website` columns to `tenants`

**Files:**
- Create: `supabase/migrations/2026-09-04-01-tenant-contact-fields.sql`
- Modify: `supabase/schema.sql` (find the existing `ALTER TABLE tenants ADD COLUMN address ... bank_account_no TEXT;` block from `2026-08-22-01-tenant-company-profile.sql` and add the two new columns to the live table definition, following that same pattern)

**Interfaces:**
- Produces: `tenants.email TEXT` (nullable), `tenants.website TEXT` (nullable) — consumed by Task 2 (Settings form) and Tasks 5/6 (document header contact line).

- [ ] **Step 1: Dry-run the migration**

Run via the `execute_sql` MCP tool (project_id `yyzbgdmgyvvypfcjuhtr`):

```sql
BEGIN;
ALTER TABLE tenants
  ADD COLUMN email   TEXT,
  ADD COLUMN website TEXT;
ROLLBACK;
```

Expected: no errors.

- [ ] **Step 2: Apply live**

Run the same `ALTER TABLE` (without the `BEGIN;`/`ROLLBACK;` wrapper) via the `apply_migration` MCP tool. This takes effect on the live production database immediately.

- [ ] **Step 3: Write the migration file**

```sql
-- 2026-09-04-01-tenant-contact-fields.sql
-- Company email/website for the new document-header contact line (spec:
-- docs/superpowers/specs/2026-09-04-document-header-pagination-design.md).
-- Same nullable-column pattern as address/tax_id/phone from
-- 2026-08-22-01-tenant-company-profile.sql.
ALTER TABLE tenants
  ADD COLUMN email   TEXT,
  ADD COLUMN website TEXT;
```

Save to `supabase/migrations/2026-09-04-01-tenant-contact-fields.sql`.

- [ ] **Step 4: Update `supabase/schema.sql`**

Find the `ALTER TABLE tenants ADD COLUMN address ...` block (search for `bank_account_no`). Add `email` and `website` to that same statement's column list (or append a second `ALTER TABLE` right after it, matching whichever style the surrounding file already uses for incremental additions) so `schema.sql` reflects the live table shape.

- [ ] **Step 5: Verify live**

Via `execute_sql`:

```sql
SELECT column_name FROM information_schema.columns
WHERE table_name = 'tenants' AND column_name IN ('email', 'website');
```

Expected: both rows returned.

- [ ] **Step 6: Commit**

Write a commit message to a temp file, e.g.:

```
feat: add tenants.email/website for the document-header contact line

Nullable, same pattern as address/tax_id/phone. Feeds the new
contact-icons line in QuotationPaper/DocumentPaper's header (spec:
docs/superpowers/specs/2026-09-04-document-header-pagination-design.md).
```

```bash
git add supabase/migrations/2026-09-04-01-tenant-contact-fields.sql supabase/schema.sql
git commit -F <temp-file-path>
git fetch origin main
git log HEAD..origin/main --oneline   # must be empty
git push origin worktree-quotation-module:main
```

---

### Task 2: Add email/website fields to Settings' company card

**Files:**
- Modify: `src/pages/Settings.jsx` (profile state around line 210-224, JSX card around line 454-498)

**Interfaces:**
- Consumes: `tenants.email`/`tenants.website` from Task 1.
- Produces: nothing new consumed by later tasks — this is a self-contained data-entry surface. (Tasks 5/6 read `tenant.email`/`tenant.website` directly from the `tenant` object already passed into `QuotationPaper`/`DocumentPaper`, independent of this task's UI.)

- [ ] **Step 1: Add the fields to `profile` state**

In the `useState` initializer (currently `{ company_name: '', address: '', tax_id: '', phone: '', default_payment_terms: '', default_notes: '' }`), add `email: '', website: ''`:

```jsx
const [profile, setProfile] = useState({
  company_name: '', address: '', tax_id: '', phone: '', email: '', website: '',
  default_payment_terms: '', default_notes: '',
})
```

- [ ] **Step 2: Populate them from `tenant` in the load effect**

In the `useEffect` that calls `setProfile({...})` on `tenant` change, add:

```jsx
email: tenant.email || '', website: tenant.website || '',
```

alongside the existing `phone: tenant.phone || '',` line.

- [ ] **Step 3: Add the input fields to the card JSX**

Right after the existing `เบอร์โทร` field block (the one wrapping `profile.phone`), add a new `form-grid-2` row:

```jsx
<div className="form-grid-2">
  <div>
    <label className="label">อีเมล</label>
    <input className="input" type="email" value={profile.email} onChange={e => setProfileField('email', e.target.value)} />
  </div>
  <div>
    <label className="label">เว็บไซต์</label>
    <input className="input" value={profile.website} onChange={e => setProfileField('website', e.target.value)} placeholder="www.example.com" />
  </div>
</div>
```

No changes needed to `handleSaveProfile` — it already does `supabase.from('tenants').update(profile)` with the whole state object, so `email`/`website` save automatically once they're in `profile`.

- [ ] **Step 4: Build**

```bash
npx vite build
```

Expected: no errors.

- [ ] **Step 5: Live verification**

1. Create a throwaway test tenant (standard `auth.users`/`auth.identities` INSERT pattern).
2. Playwright: log in, navigate to Settings, fill in "อีเมล" and "เว็บไซต์" fields, click "✅ บันทึกข้อมูลบริษัท", reload the page, confirm both fields still show the saved values (proves the round-trip through Supabase, not just local state).
3. Query `SELECT email, website FROM tenants WHERE id = '<test-tenant-id>'` directly to confirm persistence.
4. Clean up the test tenant fully (FK-dependency order, verify 0 rows left).

- [ ] **Step 6: Commit and push**

```
feat: add email/website fields to Settings' company profile card

Feeds the new contact-icons line in the redesigned document header
(spec: docs/superpowers/specs/2026-09-04-document-header-pagination-design.md).
Same state/onChange/save pattern as the existing address/tax_id/phone
fields on this card -- no new save-path code needed, handleSaveProfile
already persists the whole profile object.
```

---

### Task 3: Add `disabled` support to `RowActionsMenu`

**Files:**
- Modify: `src/components/RowActionsMenu.jsx` (item rendering around line 92-104)

**Interfaces:**
- Produces: `items` array entries may now include `disabled: boolean` and `disabledTitle: string`. Consumed by Task 5 (`QuotationDocumentModal`'s JPG button) and Task 6 (`InvoiceDocumentModal`/`ReceiptDocumentModal`'s JPG buttons).

- [ ] **Step 1: Read the current item-rendering block**

Confirm the exact current JSX at `src/components/RowActionsMenu.jsx:92-104` (shown below) before editing — it currently has no disabled state:

```jsx
{items.map((it, i) => (
  <div
    key={i}
    onClick={() => { setOpen(false); it.onClick() }}
    style={{
      padding: '9px 14px', cursor: 'pointer', fontSize: 13, whiteSpace: 'nowrap',
      color: it.danger ? 'var(--red)' : 'var(--text)',
      borderBottom: i < items.length - 1 ? '1px solid var(--border, #333)' : 'none',
    }}
  >
    {it.label}
  </div>
))}
```

- [ ] **Step 2: Add disabled handling**

Replace it with:

```jsx
{items.map((it, i) => (
  <div
    key={i}
    title={it.disabled ? it.disabledTitle : undefined}
    onClick={() => { if (it.disabled) return; setOpen(false); it.onClick() }}
    style={{
      padding: '9px 14px', cursor: it.disabled ? 'not-allowed' : 'pointer', fontSize: 13, whiteSpace: 'nowrap',
      color: it.disabled ? 'var(--text3, #888)' : (it.danger ? 'var(--red)' : 'var(--text)'),
      opacity: it.disabled ? 0.55 : 1,
      borderBottom: i < items.length - 1 ? '1px solid var(--border, #333)' : 'none',
    }}
  >
    {it.label}
  </div>
))}
```

Existing callers that never set `disabled` are unaffected (`it.disabled` is `undefined`, falsy throughout).

- [ ] **Step 3: Build**

```bash
npx vite build
```

Expected: no errors.

- [ ] **Step 4: Live verification**

Playwright: open any existing `RowActionsMenu` in the app (e.g. a Quotation row's "⋮" menu or the document-save dropdown) exactly as it exists today, confirm it still opens and every item is still clickable and functions normally (regression check — this task adds a new optional field, it must not change existing behavior since no existing caller sets `disabled`).

- [ ] **Step 5: Commit and push**

```
feat: support a disabled state on RowActionsMenu items

Needed for the document-export dropdown's JPG option, which must
disable itself for multi-page documents (JPG export can only capture
a single canvas -- see docs/superpowers/specs/2026-09-04-document-header-pagination-design.md).
Backward compatible: items without `disabled` set render exactly as
before.
```

---

### Task 4: Build the shared pagination hook

**Files:**
- Create: `src/hooks/usePaginatedDocument.js`

**Interfaces:**
- Produces: `usePaginatedDocument({ items, renderHeader, renderTableHeader, renderRow })` → `{ pages, pageCount, measurementNode }`. Consumed by Task 5 (`QuotationPaper`) and Task 6 (`DocumentPaper`).
  - `items`: array of row data.
  - `renderHeader(): JSX.Element` — called with no args; must return a representative header (used only for height measurement — always measured as if it were page 1 of 1, since page-number digit count doesn't affect height).
  - `renderTableHeader(): JSX.Element` — must return a `<tr>...</tr>` (gets wrapped in a measurement `<thead>`).
  - `renderRow(item, index): JSX.Element` — must return a `<tr key=...>...</tr>` for that row (the same element is reused, ref-cloned, for measurement).
  - Returns `pages: item[][]` (never empty — at least one, possibly-empty page), `pageCount: number`, `measurementNode: JSX.Element | null` (render this once as a hidden sibling inside the caller's element; it becomes `null` once heights are known).

- [ ] **Step 1: Write the hook**

```jsx
import { useState, useLayoutEffect, useRef, cloneElement } from 'react'

// Deliberately shorter than the shipped single-page minHeight (1000px, from
// commits dbfec30/901293a) -- mirrors WorkPhotosDocumentModal's own
// 270mm-vs-277mm safety margin against an html2pdf.js page-break modulo bug
// (a page div whose height exactly matches the physical page height can
// trigger a spurious blank page).
export const PAGE_HEIGHT_PX = 960

// Two-pass pagination: mount renderHeader/renderTableHeader/renderRow once
// in a hidden measurement pass, read their real rendered heights (this is
// what makes Thai text wrapping -- which a static estimate can't predict --
// measure correctly), then bucket `items` into pages that fit
// PAGE_HEIGHT_PX minus the (measured) header and table-header heights,
// which repeat identically on every page.
export function usePaginatedDocument({ items, renderHeader, renderTableHeader, renderRow }) {
  const [heights, setHeights] = useState(null)
  const headerRef = useRef(null)
  const tableHeaderRef = useRef(null)
  const rowRefs = useRef([])
  rowRefs.current = []

  useLayoutEffect(() => {
    if (!headerRef.current || !tableHeaderRef.current) return
    const headerHeight = headerRef.current.getBoundingClientRect().height
    const tableHeaderHeight = tableHeaderRef.current.getBoundingClientRect().height
    const rowHeights = rowRefs.current.map(el => (el ? el.getBoundingClientRect().height : 0))
    setHeights({ headerHeight, tableHeaderHeight, rowHeights })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items])

  const measured = heights && heights.rowHeights.length === items.length

  if (!measured) {
    // Not measured yet -- render everything on one page as a safe fallback
    // (never drops content) while the hidden pass mounts and measures.
    return {
      pages: [items],
      pageCount: 1,
      measurementNode: (
        <div style={{ position: 'absolute', visibility: 'hidden', pointerEvents: 'none', top: 0, left: -99999, width: 700, zIndex: -1 }}>
          <div ref={headerRef}>{renderHeader()}</div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead ref={tableHeaderRef}>{renderTableHeader()}</thead>
            <tbody>
              {items.map((it, i) => cloneElement(renderRow(it, i), { ref: el => { rowRefs.current[i] = el } }))}
            </tbody>
          </table>
        </div>
      ),
    }
  }

  const available = PAGE_HEIGHT_PX - heights.headerHeight - heights.tableHeaderHeight
  const pages = []
  let current = []
  let currentHeight = 0
  items.forEach((it, i) => {
    const h = heights.rowHeights[i]
    if (current.length && currentHeight + h > available) {
      pages.push(current)
      current = []
      currentHeight = 0
    }
    current.push(it)
    currentHeight += h
  })
  pages.push(current)

  return { pages, pageCount: pages.length, measurementNode: null }
}
```

- [ ] **Step 2: Build**

```bash
npx vite build
```

Expected: no errors. (This file has no consumers yet, so this only checks syntax.)

- [ ] **Step 3: Commit**

This task has no independent live-verification surface (it's a hook with no UI yet) — its behavior is verified end-to-end in Task 5. Commit as a checkpoint:

```
feat: add usePaginatedDocument hook for multi-page document rendering

Two-pass height-measurement pagination (hidden pass measures real
rendered header/row heights, then buckets items into pages), same
shape as WorkPhotosDocumentModal's existing fixed-page-div +
pageBreakAfter pattern but height-driven instead of fixed-count-driven
since item/note/item_description rows vary widely in height. No
consumers yet -- wired into QuotationPaper next.
```

```bash
git add src/hooks/usePaginatedDocument.js
git commit -F <temp-file-path>
git fetch origin main && git log HEAD..origin/main --oneline
git push origin worktree-quotation-module:main
```

---

### Task 5: Redesign `QuotationPaper` (header + pagination) and update its callers

**Files:**
- Modify: `src/pages/Quotations.jsx` — `QuotationPaper` (line 321-451), `QuotationDocumentModal` (line 454-508, specifically the `<QuotationPaper .../>` call at 480-488 and the JPG `RowActionsMenu` item at 502), `QuotationHistoryModal` (line 513-570, the `<QuotationPaper .../>` call at 544-552 and its JPG item at 564)

**Interfaces:**
- Consumes: `usePaginatedDocument` from Task 4.
- Produces: `QuotationPaper` gains two new props: `siteName` (string or `null` — the "โครงการ" value) and continues to accept `revision` (now used for a `-R{n}` suffix instead of its own info-box cell). `QuotationDocumentModal`/`QuotationHistoryModal`'s JPG `RowActionsMenu` items gain `disabled`/`disabledTitle`.

This is the riskiest task — read the full current `QuotationPaper` function (`src/pages/Quotations.jsx:321-451`) before starting; the code below assumes that exact starting point (already re-read as part of writing this plan).

- [ ] **Step 1: Rewrite `QuotationPaper`'s signature and header block**

Replace the function signature to add `siteName`:

```jsx
function QuotationPaper({ elementId, tenant, quotationNumber, tag, date, validUntil, revision, siteName, clientName, clientAddress, clientTaxId, items, hasVat, priceIncludesVat, discountAmount, discountPct, paymentTerms, notes, bankAccount, clientSignature }) {
```

Add the accent constant and the pagination hook call right after the existing `totals`/`mySignature` lines:

```jsx
  const totals = calcQuotationTotals(items, { hasVat, priceIncludesVat, discountAmount, discountPct })
  const mySignature = useMySignatureUrl()
  const ACCENT = '#6c63ff'

  const revisionSuffix = revision > 1 ? `-R${revision}` : ''

  // Both the top row (logo/contact/title) and the client-info/doc-info row
  // below it repeat identically on every page (per the spec's explicit
  // "repeat the whole header" requirement) -- kept as one Header component
  // so the pagination hook's renderHeader has a single, simple call.
  const Header = ({ pageNumber, totalPages }) => (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'stretch', gap: 25 }}>
        <div style={{ display: 'flex', gap: 20 }}>
          {tenant?.logo_url
            ? (
              <div style={{ position: 'relative', width: 110, flexShrink: 0 }}>
                <img src={tenant.logo_url} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', objectPosition: 'left center' }} crossOrigin="anonymous" />
              </div>
            )
            : <div style={{ width: 40, height: 40, borderRadius: 8, background: ACCENT, flexShrink: 0 }} />}
          <div>
            <div style={{ fontSize: 18, fontWeight: 800 }}>{tenant?.company_name}</div>
            {tenant?.address && <div style={{ fontSize: 12, color: '#6a6f85', lineHeight: 1.6, marginTop: 2 }}>{tenant.address}</div>}
            {tenant?.tax_id && <div style={{ fontSize: 12, color: '#6a6f85' }}>เลขผู้เสียภาษี {tenant.tax_id}</div>}
            {(tenant?.phone || tenant?.email || tenant?.website) && (
              <div style={{ fontSize: 12, color: '#4a4d63', marginTop: 6 }}>
                {tenant?.phone && <>📞&nbsp;{tenant.phone}</>}
                {tenant?.phone && (tenant?.email || tenant?.website) && '   '}
                {tenant?.email && <>✉️&nbsp;{tenant.email}</>}
                {tenant?.email && tenant?.website && '   '}
                {tenant?.website && <>🌐&nbsp;{tenant.website}</>}
              </div>
            )}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 12, color: '#6a6f85', marginBottom: 4 }}>หน้า {pageNumber}/{totalPages}</div>
          <div style={{ fontSize: 12, fontWeight: 700, color: ACCENT, border: `1px solid ${ACCENT}`, borderRadius: 4, padding: '2px 8px', display: 'inline-block', marginBottom: 6 }}>{tag || 'ต้นฉบับ'}</div>
          <div style={{ fontSize: 28, fontWeight: 800 }}>ใบเสนอราคา</div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '66fr 34fr', gap: 20 }}>
        <div style={{ marginTop: 17, fontSize: 12.5, lineHeight: 2 }}>
          <div><span style={{ color: '#6a6f85' }}>ลูกค้า&nbsp;:</span> <strong>{clientName || '—'}</strong></div>
          <div><span style={{ color: '#6a6f85' }}>ที่อยู่&nbsp;:</span> {clientAddress || '—'}</div>
          {clientTaxId && <div><span style={{ color: '#6a6f85' }}>เลขที่ภาษี&nbsp;:</span> {clientTaxId}</div>}
        </div>
        <div style={{ marginTop: 17, border: '1px solid #e4e6ef', borderRadius: 8, padding: '14px 16px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 24px', fontSize: 12 }}>
          <div><span style={{ color: '#6a6f85' }}>เลขที่เอกสาร</span><br /><strong>{quotationNumber}{revisionSuffix}</strong></div>
          <div><span style={{ color: '#6a6f85' }}>วันที่ออก</span><br />{date ? new Date(date).toLocaleDateString('th-TH') : '—'}</div>
          <div><span style={{ color: '#6a6f85' }}>ใช้ได้ถึง</span><br />{validUntil ? new Date(validUntil).toLocaleDateString('th-TH') : '—'}</div>
          <div><span style={{ color: '#6a6f85' }}>โครงการ</span><br />{siteName || '—'}</div>
        </div>
      </div>
    </>
  )
```

- [ ] **Step 2: Write the row-rendering function and wire the pagination hook**

Replace the old inline `items.map(...)` table body with a named `renderRow` function, then call the hook:

```jsx
  const renderRow = (it, i) => (
    it.item_type === 'note' || it.item_type === 'item_description' ? (
      <tr key={it.id || i}>
        <td colSpan={4} style={{ padding: `6px 8px 6px ${it.item_type === 'item_description' ? 20 : 8}px`, borderBottom: '1px solid #eee', fontStyle: 'italic', color: '#666', whiteSpace: 'pre-line' }}>{it.description}</td>
      </tr>
    ) : (
      <tr key={it.id || i}>
        <td style={{ padding: '9px 8px', borderBottom: '1px solid #eee' }}>{it.description}</td>
        <td style={{ textAlign: 'right', padding: '9px 8px', borderBottom: '1px solid #eee' }}>{it.quantity} {it.unit || ''}</td>
        <td style={{ textAlign: 'right', padding: '9px 8px', borderBottom: '1px solid #eee' }}>{fmt(it.unit_price)}</td>
        <td style={{ textAlign: 'right', padding: '9px 8px', borderBottom: '1px solid #eee' }}>{fmt(it.line_total)}</td>
      </tr>
    )
  )

  const renderTableHeader = () => (
    <tr>
      <th style={{ textAlign: 'left', padding: '11px 8px', fontSize: 12, fontWeight: 700, color: '#4a4d63', background: '#f4f4f6', borderBottom: `2px solid ${ACCENT}` }}>รายการ</th>
      <th style={{ textAlign: 'right', padding: '11px 8px', fontSize: 12, fontWeight: 700, color: '#4a4d63', background: '#f4f4f6', borderBottom: `2px solid ${ACCENT}` }}>จำนวน</th>
      <th style={{ textAlign: 'right', padding: '11px 8px', fontSize: 12, fontWeight: 700, color: '#4a4d63', background: '#f4f4f6', borderBottom: `2px solid ${ACCENT}` }}>ราคา/หน่วย</th>
      <th style={{ textAlign: 'right', padding: '11px 8px', fontSize: 12, fontWeight: 700, color: '#4a4d63', background: '#f4f4f6', borderBottom: `2px solid ${ACCENT}` }}>รวม</th>
    </tr>
  )

  const { pages, pageCount, measurementNode } = usePaginatedDocument({
    items,
    renderHeader: () => <Header pageNumber={1} totalPages={1} />,
    renderTableHeader,
    renderRow,
  })
```

Add the import: `import { usePaginatedDocument } from '../hooks/usePaginatedDocument.js'` at the top of `Quotations.jsx`.

- [ ] **Step 3: Replace the return statement's body with the paginated render**

Replace everything from the outer `<div id={elementId} ...>` through its closing `</div>` (the whole current return block) with:

```jsx
  return (
    <div id={elementId} className="printable-document" style={{ fontFamily: 'Sarabun,sans-serif' }}>
      {pages.map((pageItems, pageIndex) => {
        const isLast = pageIndex === pages.length - 1
        return (
          <div
            key={pageIndex}
            style={{
              padding: '40px 44px', background: '#fff', color: '#17181f', boxSizing: 'border-box',
              minHeight: PAGE_HEIGHT_PX, display: 'flex', flexDirection: 'column',
              pageBreakAfter: isLast ? 'auto' : 'always', breakAfter: isLast ? 'auto' : 'page',
              marginBottom: isLast ? 0 : 16,
              boxShadow: pages.length > 1 ? '0 1px 4px rgba(0,0,0,.08)' : 'none',
            }}
          >
            <Header pageNumber={pageIndex + 1} totalPages={pages.length} />

            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginTop: 18 }}>
              <thead>{renderTableHeader()}</thead>
              <tbody>{pageItems.map(renderRow)}</tbody>
            </table>

            {isLast && (
              <>
                <div style={{ marginTop: 14, display: 'flex', justifyContent: 'flex-end' }}>
                  <table style={{ width: 260, fontSize: 12.5 }}>
                    <tbody>
                      {totals.discount > 0 && (
                        <tr><td style={{ padding: '5px 4px', color: '#6a6f85' }}>ส่วนลด</td><td style={{ textAlign: 'right', padding: '5px 4px' }}>-{fmt(totals.discount)}</td></tr>
                      )}
                      <tr><td style={{ padding: '5px 4px', color: '#6a6f85' }}>รวมก่อน VAT</td><td style={{ textAlign: 'right', padding: '5px 4px' }}>{fmt(totals.subtotal)}</td></tr>
                      {hasVat && (
                        <tr><td style={{ padding: '5px 4px', color: '#6a6f85' }}>VAT (7%)</td><td style={{ textAlign: 'right', padding: '5px 4px' }}>{fmt(totals.vat)}</td></tr>
                      )}
                      <tr>
                        <td style={{ padding: '10px 4px 4px', fontWeight: 800, fontSize: 15, color: ACCENT, borderTop: `2px solid ${ACCENT}` }}>รวมทั้งสิ้น</td>
                        <td style={{ textAlign: 'right', padding: '10px 4px 4px', fontWeight: 800, fontSize: 15, color: ACCENT, borderTop: `2px solid ${ACCENT}` }}>{fmt(totals.total)} บาท</td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                {(paymentTerms || notes || bankAccount) && (
                  <div style={{ marginTop: 20, fontSize: 11.5, background: '#f9f9fc', borderRadius: 8, padding: '12px 16px', lineHeight: 1.8 }}>
                    {(paymentTerms || notes) && (
                      <>
                        <strong style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>หมายเหตุ</strong>
                        <div style={{ marginBottom: bankAccount ? 10 : 0, whiteSpace: 'pre-line' }}>
                          {[paymentTerms, notes].filter(Boolean).join('\n\n')}
                        </div>
                      </>
                    )}
                    {bankAccount && (
                      <div style={{ marginTop: 10 }}>
                        <strong>ชำระเงินไปที่:</strong> {bankAccount.bank_name} ชื่อบัญชี {bankAccount.account_name} เลขที่ {bankAccount.account_no}
                      </div>
                    )}
                  </div>
                )}

                <div style={{ flex: 1 }} />

                <div style={{ marginTop: 44, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, textAlign: 'center', fontSize: 11.5 }}>
                  <div>
                    <div style={{ height: 40, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
                      {mySignature && <img src={mySignature.url} alt="" crossOrigin="anonymous" style={{ height: 36, display: 'block' }} />}
                    </div>
                    <div style={{ borderTop: '1px solid #999', paddingTop: 8 }}>ผู้เสนอราคา</div>
                  </div>
                  <div>
                    <div style={{ height: 40, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
                      {clientSignature && <img src={clientSignature.url} alt="" crossOrigin="anonymous" style={{ height: 36, display: 'block' }} />}
                    </div>
                    <div style={{ borderTop: '1px solid #999', paddingTop: 8 }}>ผู้ยอมรับ (ลูกค้า)</div>
                    {clientSignature && (
                      <div style={{ marginTop: 2, color: '#6a6f85', fontSize: 10 }}>
                        {clientSignature.signerName} · เซ็นเมื่อ {new Date(clientSignature.signedAt).toLocaleDateString('th-TH')}
                      </div>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        )
      })}
      {measurementNode}
    </div>
  )
}
```

Add the import `import { usePaginatedDocument, PAGE_HEIGHT_PX } from '../hooks/usePaginatedDocument.js'` (combine with Step 2's import into one line).

- [ ] **Step 4: Update `QuotationDocumentModal`'s call site**

At line 480-488, add `siteName={qt.sites?.name}`:

```jsx
<QuotationPaper
  elementId={elementId} tenant={tenant} quotationNumber={qt.quotation_number} tag={printTag}
  date={qt.date} validUntil={qt.valid_until} revision={qt.revision || 1} siteName={qt.sites?.name}
  clientName={qt.clients?.name} clientAddress={qt.clients?.address} clientTaxId={qt.clients?.tax_id} items={qt.quotation_items || []}
  hasVat={qt.has_vat} priceIncludesVat={qt.price_includes_vat}
  discountAmount={qt.discount_amount} discountPct={qt.discount_pct}
  paymentTerms={qt.payment_terms} notes={qt.notes} bankAccount={qt.bank_accounts}
  clientSignature={receipt && signatureUrl ? { url: signatureUrl, signerName: receipt.signer_name, signedAt: receipt.signed_at } : null}
/>
```

`useQuotations`' select string already joins `sites(name, site_number)` (confirmed in `src/hooks/useSupabase.js:227`), so `qt.sites?.name` needs no query change.

The modal also needs the page count for the JPG guard, but pagination is computed inside `QuotationPaper`, not in the modal. Expose it via a callback prop — add `onPageCountChange` to `QuotationPaper`'s signature:

```jsx
function QuotationPaper({ elementId, tenant, quotationNumber, tag, date, validUntil, revision, siteName, clientName, clientAddress, clientTaxId, items, hasVat, priceIncludesVat, discountAmount, discountPct, paymentTerms, notes, bankAccount, clientSignature, onPageCountChange }) {
```

and after the `usePaginatedDocument` call, add:

```jsx
  useEffect(() => { onPageCountChange?.(pageCount) }, [pageCount, onPageCountChange])
```

(add `useEffect` to the existing `react` import at the top of the file if not already imported — it already is, used elsewhere in this file).

In `QuotationDocumentModal`, add state and pass the callback:

```jsx
const [pageCount, setPageCount] = useState(1)
```

```jsx
<QuotationPaper
  ...
  onPageCountChange={setPageCount}
/>
```

Then update the JPG item in the `RowActionsMenu` (line ~502):

```jsx
<RowActionsMenu
  trigger="💾 บันทึกเอกสาร ▾" triggerClassName="btn btn-primary"
  items={[
    { label: '🖨️ พิมพ์', onClick: () => window.print() },
    { label: '📄 บันทึกเป็น PDF', onClick: () => handleDownload('pdf', downloadPDF) },
    { label: '🖼️ บันทึกเป็น JPG', onClick: () => handleDownload('jpg', downloadJPG), disabled: pageCount > 1, disabledTitle: 'เอกสารหลายหน้า บันทึกเป็น PDF แทน' },
  ]}
/>
```

- [ ] **Step 5: Update `QuotationHistoryModal`'s call site**

At line 544-552, add `siteName={null}` (historical revision snapshots don't capture site — this preserves the existing, already-accepted gap where `clientAddress`/`clientTaxId` are also missing from snapshots) and the same `onPageCountChange`/`disabled` wiring as Step 4, scoped to this modal's own `pageCount` state and its JPG item at line ~564:

```jsx
<QuotationPaper
  elementId={elementId} tenant={tenant} quotationNumber={quotation.quotation_number}
  tag={`ฉบับแก้ไขครั้งที่ ${selected.revision} (ประวัติ)`}
  date={s.date} validUntil={s.valid_until} revision={selected.revision} siteName={null}
  clientName={s.client_name} items={s.items || []}
  hasVat={s.has_vat} priceIncludesVat={s.price_includes_vat}
  discountAmount={s.discount_amount} discountPct={s.discount_pct}
  paymentTerms={s.payment_terms} notes={s.notes} bankAccount={s.bank_account}
  onPageCountChange={setHistoryPageCount}
/>
```

with `const [historyPageCount, setHistoryPageCount] = useState(1)` declared near the top of `QuotationHistoryModal`, and its JPG item:

```jsx
{ label: '🖼️ บันทึกเป็น JPG', onClick: () => downloadJPG(elementId, `${quotation.quotation_number}-rev${selected.revision}.jpg`), disabled: historyPageCount > 1, disabledTitle: 'เอกสารหลายหน้า บันทึกเป็น PDF แทน' },
```

- [ ] **Step 6: Build**

```bash
npx vite build
```

Expected: no errors. Fix any prop-name typos or missing-import issues now.

- [ ] **Step 7: Live verification — single-page case**

1. Create a throwaway test tenant with `email`/`website`/`phone`/`address`/`tax_id`/`logo_url` all set, plus a client and a bank account.
2. Create a quotation with 2-3 items (short — stays on one page), no site linked.
3. Playwright: open the quotation's document modal (📄 button), screenshot it. Confirm: logo scales to the header text block, contact line shows all three segments with icons, doc-info box shows 4 cells with โครงการ reading "—", client info reads "ลูกค้า : ...", revision shows no suffix (this is a fresh draft, `revision` is 1), signature sits at the bottom of the page, JPG option in the save dropdown is enabled (not grayed out).
4. Click "🖼️ บันทึกเป็น JPG", confirm the download succeeds and the exported image matches the preview.

- [ ] **Step 8: Live verification — multi-page case**

1. Using the same test tenant, insert enough `quotation_items` rows (via SQL — 25-30 plain `item`-type rows is a safe margin to force 2+ pages at ~40-50px per row against the ~800px available budget after the header) on a second quotation.
2. Link this quotation to a `site_id` (create a test site first) so โครงการ has a real value to check.
3. Playwright: open its document modal, screenshot the full modal (scrolled). Confirm: 2+ visually distinct pages render (boxShadow/gap visible between them), each page's header shows the correct `หน้า N/M`, the full header (logo, contact line, doc-info box, client info) repeats identically on every page except the page-number text, totals/notes/signature appear only on the last page, JPG option is now disabled (grayed out, click does nothing).
4. Click "📄 บันทึกเป็น PDF", confirm the download succeeds. (Confirming the actual PDF's page count precisely may require opening the downloaded file — at minimum confirm the download completes without error and the file size is plausible for a multi-page document, larger than the single-page case's PDF.)
5. Emulate print media (`page.emulateMedia({ media: 'print' })`) and screenshot — confirm the page break lands between the two page-divs, not mid-content.

- [ ] **Step 9: Live verification — revision suffix**

1. On the short (single-page) quotation from Step 7, mark it as sent (`ส่ง` button / set `ever_sent`), then edit it (change any field) and save — this should bump `revision` to 2 per existing revision-tracking behavior.
2. Reopen its document modal, screenshot, confirm the document number now reads `{number}-R2` in plain bold black text (not accent-colored).
3. Open its "🕓 ประวัติการแก้ไข" history modal, confirm the revision-1 snapshot also renders correctly (through the same `QuotationPaper`, `siteName` correctly shows "—" since snapshots don't capture site).

- [ ] **Step 10: Clean up**

Delete the test tenant fully (`quotation_items` → `quotations` → `bank_accounts` → `clients` → `sites` → `audit_logs` → `app_settings` → `document_prints` → `user_roles` → `tenants` → `auth.identities` → `auth.users`), verify 0 rows left with a final count query.

- [ ] **Step 11: Commit and push**

```
feat: redesign QuotationPaper header and add real multi-page pagination

New header layout (contact-icons line, inline client-info, 2x2
doc-info box with a "โครงการ" field and revision folded into the
document number as a -RN suffix, 66/34 fr-based column split so the
box's right edge stays pinned to the page margin) plus real pagination
via the new usePaginatedDocument hook -- long item lists now split
across correctly-height-measured pages, full header repeated on every
page, totals/notes/signature only on the last page. JPG export
disables itself (via RowActionsMenu's new disabled support) once a
document computes to more than one page, since html2canvas can only
capture a single-page image; PDF/print/preview all handle multi-page
natively through the same explicit pageBreakAfter divs
WorkPhotosDocumentModal already established.

Spec: docs/superpowers/specs/2026-09-04-document-header-pagination-design.md

Verified live: single-page and forced-multi-page (25+ items) test
quotations, screenshotted preview/print-emulation/PDF/JPG-disabled
state, confirmed the revision suffix appears correctly after a real
send-then-edit revision bump and reads correctly through the history
modal too. Test tenant cleaned up fully afterward.
```

```bash
git add src/pages/Quotations.jsx src/hooks/usePaginatedDocument.js
git commit -F <temp-file-path>
git fetch origin main && git log HEAD..origin/main --oneline
git push origin worktree-quotation-module:main
```

---

### Task 6: Redesign `DocumentPaper` (header + pagination) and update Invoice/Receipt callers

**Files:**
- Modify: `src/pages/Invoices.jsx` — `DocumentPaper` (line 492-611ish), `InvoiceDocumentModal` (line 642-738), `ReceiptDocumentModal` (line 748-800ish)

**Interfaces:**
- Consumes: `usePaginatedDocument` from Task 4 (same hook, reused as-is — no changes to the hook itself).
- Produces: `DocumentPaper` loses its `siteName` prop (site now folds into the caller-supplied `infoFields` array as one more `{label, value}` entry instead of its own dedicated client-info line — `infoFields` was already fully caller-driven, this keeps that architecture intact). `DocumentPaper` gains `onPageCountChange`. Both `InvoiceDocumentModal` and `ReceiptDocumentModal` get the same JPG-disable wiring as Task 5.

This task is the same shape as Task 5, applied to `DocumentPaper`. Read the full current `DocumentPaper` function and its two call sites (`src/pages/Invoices.jsx:492-611`, `642-738`, `748-800`ish) before starting — already re-read as part of writing this plan; the code below assumes that exact starting point.

- [ ] **Step 1: Rewrite `DocumentPaper`'s header, matching Task 5's `Header` shape**

Same structural change as Task 5 Step 1, adapted to this component's prop names (`title` instead of a hardcoded Thai string, `infoFields` instead of hardcoded doc-info cells, no `revision`/`quotationNumber` — this component has neither, invoices have no revision column):

```jsx
function DocumentPaper({ elementId, tenant, tag, title, infoFields, clientName, clientAddress, clientTaxId, items, totalsLabel, totalsAmount, subtotal, vat, hasVat, withholdingTaxPct, withholdingTaxAmount, isWithholdingEstimate, notesBlock, signatures, recipientSignature, onPageCountChange }) {
  const mySignature = useMySignatureUrl()
  const ACCENT = '#6c63ff'

  const Header = ({ pageNumber, totalPages }) => (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'stretch', gap: 25 }}>
        <div style={{ display: 'flex', gap: 20 }}>
          {tenant?.logo_url
            ? (
              <div style={{ position: 'relative', width: 110, flexShrink: 0 }}>
                <img src={tenant.logo_url} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', objectPosition: 'left center' }} crossOrigin="anonymous" />
              </div>
            )
            : <div style={{ width: 40, height: 40, borderRadius: 8, background: ACCENT, flexShrink: 0 }} />}
          <div>
            <div style={{ fontSize: 18, fontWeight: 800 }}>{tenant?.company_name}</div>
            {tenant?.address && <div style={{ fontSize: 12, color: '#6a6f85', lineHeight: 1.6, marginTop: 2 }}>{tenant.address}</div>}
            {tenant?.tax_id && <div style={{ fontSize: 12, color: '#6a6f85' }}>เลขผู้เสียภาษี {tenant.tax_id}</div>}
            {(tenant?.phone || tenant?.email || tenant?.website) && (
              <div style={{ fontSize: 12, color: '#4a4d63', marginTop: 6 }}>
                {tenant?.phone && <>📞&nbsp;{tenant.phone}</>}
                {tenant?.phone && (tenant?.email || tenant?.website) && '   '}
                {tenant?.email && <>✉️&nbsp;{tenant.email}</>}
                {tenant?.email && tenant?.website && '   '}
                {tenant?.website && <>🌐&nbsp;{tenant.website}</>}
              </div>
            )}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 12, color: '#6a6f85', marginBottom: 4 }}>หน้า {pageNumber}/{totalPages}</div>
          <div style={{ fontSize: 12, fontWeight: 700, color: ACCENT, border: `1px solid ${ACCENT}`, borderRadius: 4, padding: '2px 8px', display: 'inline-block', marginBottom: 6 }}>{tag || 'ต้นฉบับ'}</div>
          <div style={{ fontSize: 28, fontWeight: 800 }}>{title}</div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '66fr 34fr', gap: 20 }}>
        <div style={{ marginTop: 17, fontSize: 12.5, lineHeight: 2 }}>
          <div><span style={{ color: '#6a6f85' }}>ลูกค้า&nbsp;:</span> <strong>{clientName || '—'}</strong></div>
          <div><span style={{ color: '#6a6f85' }}>ที่อยู่&nbsp;:</span> {clientAddress || '—'}</div>
          {clientTaxId && <div><span style={{ color: '#6a6f85' }}>เลขที่ภาษี&nbsp;:</span> {clientTaxId}</div>}
        </div>
        <div style={{ marginTop: 17, border: '1px solid #e4e6ef', borderRadius: 8, padding: '14px 16px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 24px', fontSize: 12 }}>
          {infoFields.map(f => (
            <div key={f.label}><span style={{ color: '#6a6f85' }}>{f.label}</span><br />{f.value}</div>
          ))}
        </div>
      </div>
    </>
  )
```

Note this drops the old separate "ไซท์งาน" client-info line entirely — โครงการ now arrives as one more entry in the caller's `infoFields` array (Step 4/5 below).

- [ ] **Step 2: Write `renderRow`/`renderTableHeader` and wire the pagination hook**

```jsx
  const renderRow = (it, i) => (
    <tr key={it.id || i}>
      <td style={{ padding: '9px 8px', borderBottom: '1px solid #eee' }}>{it.description}</td>
      <td style={{ textAlign: 'right', padding: '9px 8px', borderBottom: '1px solid #eee' }}>{fmt(it.draw_qty).replace(/\.00$/, '')} {it.unit || ''}</td>
      <td style={{ textAlign: 'right', padding: '9px 8px', borderBottom: '1px solid #eee' }}>{fmt(it.unit_price)}</td>
      <td style={{ textAlign: 'right', padding: '9px 8px', borderBottom: '1px solid #eee' }}>{fmt(it.line_total)}</td>
    </tr>
  )

  const renderTableHeader = () => (
    <tr>
      <th style={{ textAlign: 'left', padding: '11px 8px', fontSize: 12, fontWeight: 700, color: '#4a4d63', background: '#f4f4f6', borderBottom: `2px solid ${ACCENT}` }}>รายการ</th>
      <th style={{ textAlign: 'right', padding: '11px 8px', fontSize: 12, fontWeight: 700, color: '#4a4d63', background: '#f4f4f6', borderBottom: `2px solid ${ACCENT}` }}>จำนวน</th>
      <th style={{ textAlign: 'right', padding: '11px 8px', fontSize: 12, fontWeight: 700, color: '#4a4d63', background: '#f4f4f6', borderBottom: `2px solid ${ACCENT}` }}>ราคา/หน่วย</th>
      <th style={{ textAlign: 'right', padding: '11px 8px', fontSize: 12, fontWeight: 700, color: '#4a4d63', background: '#f4f4f6', borderBottom: `2px solid ${ACCENT}` }}>รวม</th>
    </tr>
  )

  const { pages, pageCount, measurementNode } = usePaginatedDocument({
    items,
    renderHeader: () => <Header pageNumber={1} totalPages={1} />,
    renderTableHeader,
    renderRow,
  })

  useEffect(() => { onPageCountChange?.(pageCount) }, [pageCount, onPageCountChange])
```

Add `import { usePaginatedDocument, PAGE_HEIGHT_PX } from '../hooks/usePaginatedDocument.js'` to `Invoices.jsx`'s imports (`useEffect` is already imported in this file, used elsewhere).

- [ ] **Step 3: Replace the return statement**

Same page-looping shape as Task 5 Step 3, adapted for this component's totals/withholding-tax block and `notesBlock`/`signatures`/`recipientSignature` props:

```jsx
  return (
    <div id={elementId} className="printable-document" style={{ fontFamily: 'Sarabun,sans-serif' }}>
      {pages.map((pageItems, pageIndex) => {
        const isLast = pageIndex === pages.length - 1
        return (
          <div
            key={pageIndex}
            style={{
              padding: '40px 44px', background: '#fff', color: '#17181f', boxSizing: 'border-box',
              minHeight: PAGE_HEIGHT_PX, display: 'flex', flexDirection: 'column',
              pageBreakAfter: isLast ? 'auto' : 'always', breakAfter: isLast ? 'auto' : 'page',
              marginBottom: isLast ? 0 : 16,
              boxShadow: pages.length > 1 ? '0 1px 4px rgba(0,0,0,.08)' : 'none',
            }}
          >
            <Header pageNumber={pageIndex + 1} totalPages={pages.length} />

            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginTop: 18 }}>
              <thead>{renderTableHeader()}</thead>
              <tbody>{pageItems.map(renderRow)}</tbody>
            </table>

            {isLast && (
              <>
                <div style={{ marginTop: 14, display: 'flex', justifyContent: 'flex-end' }}>
                  <table style={{ width: 260, fontSize: 12.5 }}>
                    <tbody>
                      {subtotal != null && (
                        <tr><td style={{ padding: '5px 4px', color: '#6a6f85' }}>รวมก่อน VAT</td><td style={{ textAlign: 'right', padding: '5px 4px' }}>{fmt(subtotal)}</td></tr>
                      )}
                      {hasVat && vat != null && (
                        <tr><td style={{ padding: '5px 4px', color: '#6a6f85' }}>VAT (7%)</td><td style={{ textAlign: 'right', padding: '5px 4px' }}>{fmt(vat)}</td></tr>
                      )}
                      <tr>
                        <td style={{ padding: '10px 4px 4px', fontWeight: 800, fontSize: 15, color: ACCENT, borderTop: `2px solid ${ACCENT}` }}>{totalsLabel}</td>
                        <td style={{ textAlign: 'right', padding: '10px 4px 4px', fontWeight: 800, fontSize: 15, color: ACCENT, borderTop: `2px solid ${ACCENT}` }}>{fmt(totalsAmount)} บาท</td>
                      </tr>
                      {withholdingTaxAmount > 0 && (
                        <>
                          <tr>
                            <td style={{ padding: '5px 4px', color: '#c0392b' }}>
                              หัก ณ ที่จ่าย ({withholdingTaxPct}%){isWithholdingEstimate ? ' (ประมาณการ)' : ''}
                            </td>
                            <td style={{ textAlign: 'right', padding: '5px 4px', color: '#c0392b' }}>({fmt(withholdingTaxAmount)})</td>
                          </tr>
                          <tr>
                            <td style={{ padding: '8px 4px 4px', fontWeight: 700, fontSize: 13, borderTop: '1px solid #e4e6ef' }}>ยอดรับสุทธิ</td>
                            <td style={{ textAlign: 'right', padding: '8px 4px 4px', fontWeight: 700, fontSize: 13, borderTop: '1px solid #e4e6ef' }}>{fmt(totalsAmount - withholdingTaxAmount)} บาท</td>
                          </tr>
                        </>
                      )}
                    </tbody>
                  </table>
                </div>

                {notesBlock}

                <div style={{ flex: 1 }} />

                <div style={{ marginTop: 44, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, textAlign: 'center', fontSize: 11.5 }}>
                  <div>
                    <div style={{ height: 40, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
                      {mySignature && <img src={mySignature.url} alt="" crossOrigin="anonymous" style={{ height: 36, display: 'block' }} />}
                    </div>
                    <div style={{ borderTop: '1px solid #999', paddingTop: 8 }}>{signatures[0]}</div>
                  </div>
                  <div>
                    <div style={{ height: 40, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
                      {recipientSignature && <img src={recipientSignature.url} alt="" crossOrigin="anonymous" style={{ height: 36, display: 'block' }} />}
                    </div>
                    <div style={{ borderTop: '1px solid #999', paddingTop: 8 }}>{signatures[1]}</div>
                    {recipientSignature && (
                      <div style={{ marginTop: 2, color: '#6a6f85', fontSize: 10 }}>
                        {recipientSignature.signerName} · เซ็นเมื่อ {new Date(recipientSignature.signedAt).toLocaleDateString('th-TH')}
                      </div>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        )
      })}
      {measurementNode}
    </div>
  )
}
```

- [ ] **Step 4: Update `InvoiceDocumentModal`'s call site**

Remove `siteName={invoice.sites?.name}`, add `{ label: 'โครงการ', value: invoice.sites?.name || '—' }` as a 4th entry to `infoFields`, and add the `onPageCountChange`/`disabled` wiring (same pattern as Task 5 Step 4):

```jsx
const [pageCount, setPageCount] = useState(1)
```

```jsx
<DocumentPaper
  elementId={elementId} tenant={tenant} title={docTitle} tag={printTag}
  infoFields={[
    { label: 'เลขที่เอกสาร', value: invoice.invoice_number },
    { label: 'วันที่ออก', value: new Date(invoice.date).toLocaleDateString('th-TH') },
    { label: 'อ้างอิงใบเสนอราคา', value: invoice.quotations?.quotation_number },
    { label: 'โครงการ', value: invoice.sites?.name || '—' },
  ]}
  clientName={client?.name} clientAddress={client?.address} clientTaxId={client?.tax_id}
  items={items} totalsLabel="รวมทั้งสิ้น" totalsAmount={invoice.total}
  subtotal={invoice.subtotal} vat={invoice.vat} hasVat={invoice.has_vat}
  withholdingTaxPct={wht.pct} withholdingTaxAmount={wht.amount} isWithholdingEstimate={wht.isEstimate}
  notesBlock={bankAccount && (
    <div style={{ marginTop: 20, fontSize: 11.5, background: '#f9f9fc', borderRadius: 8, padding: '12px 16px', lineHeight: 1.8 }}>
      <strong>ชำระเงินไปที่:</strong> {bankAccount.bank_name} ชื่อบัญชี {bankAccount.account_name} เลขที่ {bankAccount.account_no}
    </div>
  )}
  signatures={['ผู้ออกใบแจ้งหนี้', 'ผู้รับเอกสาร']}
  recipientSignature={receipt && signatureUrl ? { url: signatureUrl, signerName: receipt.signer_name, signedAt: receipt.signed_at } : null}
  onPageCountChange={setPageCount}
/>
```

And its JPG item:

```jsx
{ label: '🖼️ บันทึกเป็น JPG', onClick: () => handleDownload('jpg', downloadJPG), disabled: pageCount > 1, disabledTitle: 'เอกสารหลายหน้า บันทึกเป็น PDF แทน' },
```

- [ ] **Step 5: Update `ReceiptDocumentModal`'s call site**

Same treatment:

```jsx
const [pageCount, setPageCount] = useState(1)
```

```jsx
<DocumentPaper
  elementId={elementId} tenant={tenant} title={variant.title} tag={printTag}
  infoFields={[
    { label: variant.numberLabel, value: receipt[variant.numberField] },
    { label: 'วันที่', value: new Date(receipt.date).toLocaleDateString('th-TH') },
    { label: 'อ้างอิงใบแจ้งหนี้', value: invoice.invoice_number },
    { label: 'โครงการ', value: invoice.sites?.name || '—' },
  ]}
  clientName={client?.name} clientAddress={client?.address} clientTaxId={client?.tax_id}
  items={items} totalsLabel="รวมรับชำระ" totalsAmount={receipt.amount}
  subtotal={invoice.subtotal} vat={invoice.vat} hasVat={invoice.has_vat}
  withholdingTaxPct={wht.pct} withholdingTaxAmount={wht.amount} isWithholdingEstimate={wht.isEstimate}
  notesBlock={null}
  signatures={['ผู้รับเงิน', 'ผู้จ่ายเงิน']}
  onPageCountChange={setPageCount}
/>
```

```jsx
{ label: '🖼️ บันทึกเป็น JPG', onClick: () => handleDownload('jpg', downloadJPG), disabled: pageCount > 1, disabledTitle: 'เอกสารหลายหน้า บันทึกเป็น PDF แทน' },
```

- [ ] **Step 6: Build**

```bash
npx vite build
```

Expected: no errors.

- [ ] **Step 7: Live verification — single-page + multi-page, both Invoice and Receipt**

Reuse the same throwaway-tenant setup pattern as Task 5 Steps 7-8, adapted:
1. Create a test tenant (with `email`/`website`/etc.), client, site, bank account.
2. Create a quotation → accept it → create an invoice from it with 2-3 items (short) and a site linked.
3. Playwright: open the invoice document modal, screenshot. Confirm the same header elements as Task 5 Step 7 (logo scaling, contact line, 4-cell doc-info box now showing โครงการ with the real site name, client info inline format), JPG enabled.
4. Mark the invoice paid to generate a receipt; open the receipt document modal, screenshot, confirm the same header correctness (including โครงการ) and JPG enabled.
5. Create a second invoice (via direct `invoice_items` SQL insert, 25-30 rows) to force 2+ pages; screenshot: confirm full header repeats per page, totals/notes/signature only on the last page, JPG disabled, PDF download succeeds, print-media emulation breaks between pages correctly.
6. Clean up the test tenant fully, verify 0 rows left.

- [ ] **Step 8: Commit and push**

```
feat: redesign DocumentPaper header and add real multi-page pagination

Same treatment as QuotationPaper (previous commit): contact-icons
line, inline client info, 66/34 fr-based split, real pagination via
the shared usePaginatedDocument hook, JPG disables itself for
multi-page documents. DocumentPaper's siteName prop is retired --
"โครงการ" now arrives as one more entry in the caller-supplied
infoFields array (Invoice/Receipt), keeping the doc-info box's
rendering fully generic as it already was, and dropping the old
separate "ไซท์งาน" line from client-info. No revision suffix here --
invoices/receipts have no revision column, unlike quotations.

Spec: docs/superpowers/specs/2026-09-04-document-header-pagination-design.md

Verified live: single-page and forced-multi-page test invoice AND
receipt, screenshotted preview/print-emulation/PDF/JPG-disabled state
for both document types, confirmed โครงการ shows the real linked site
name. Test tenant cleaned up fully afterward.
```

```bash
git add src/pages/Invoices.jsx
git commit -F <temp-file-path>
git fetch origin main && git log HEAD..origin/main --oneline
git push origin worktree-quotation-module:main
```

---

## Post-Plan Note

This plan does not touch `PurchaseOrders.jsx`'s document view or `WorkPhotosDocumentModal` — both are explicitly out of scope per the spec's Non-Goals. `WorkPhotosDocumentModal`'s own mm-based fixed-page pattern is left as-is; it was the reference this plan's px-based pagination was modeled on, not something this plan modifies.
