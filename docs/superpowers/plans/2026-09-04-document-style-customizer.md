# Document Style Customizer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a tenant's OWNER visually tune the Quotation/Invoice/Receipt document header (logo size, fonts, spacing, colors, column split) from Settings, with a live preview, persisted per-tenant — and ship a better logo-height default along the way, fixing a real shipped bug (today's logo has no height cap).

**Architecture:** One nullable `tenants.document_style` JSONB column; a new `src/lib/documentStyle.js` module owning `DEFAULT_DOCUMENT_STYLE` and a `resolveDocumentStyle()` merge helper; the shared `usePaginatedDocument` hook gains optional geometry-override parameters (default = today's exact constants, so every existing call site is unaffected); `QuotationHeader`/`QuotationPaper` and `DocumentHeader`/`DocumentPaper` are mechanically rewired to read resolved style values instead of hardcoded numbers; a new OWNER-only Settings card renders a slider panel next to a live `QuotationPaper` preview fed a synthetic tenant object (real company data + the in-progress, unsaved style state) so changes are visible before Save.

**Tech Stack:** React (function components, hooks, controlled inputs), Supabase (Postgres + RLS), no test runner — verification is live (Playwright against a throwaway Supabase tenant), matching this project's established norm.

**Spec:** `docs/superpowers/specs/2026-09-04-document-style-customizer-design.md`

## Global Constraints

- New column: `tenants.document_style JSONB`, nullable. `NULL` means "use `DEFAULT_DOCUMENT_STYLE`."
- `resolveDocumentStyle(overrides)` is a flat shallow merge: `{ ...DEFAULT_DOCUMENT_STYLE, ...(overrides || {}) }` — every value in the style object is a primitive (number/string/boolean), so shallow merge is correct and sufficient.
- **`usePaginatedDocument`'s pagination algorithm itself (the bucketing/footer-split logic) must not change at all.** It was independently fuzz-tested 300,000 cases and hand-traced correct in the prior plan's final review. This plan only adds optional parameters with defaults exactly equal to today's exported constants (`PAGE_WIDTH_PX`, `PAGE_PADDING_CSS`, `PAGE_HEIGHT_PX`, `TABLE_MARGIN_TOP_PX`), so every existing call site that doesn't pass them is provably unaffected — same output, same behavior, byte-for-byte.
- **Page width and the total page-div height stay fixed, non-tunable.** Only `pagePaddingV`/`pagePaddingH` (and `tableMarginTop`) become tunable. To keep the physical page-div height pinned to the value already calibrated against html2pdf.js's real ~1046px A4 budget (safety margin proven live, see `usePaginatedDocument.jsx`'s own `PAGE_HEIGHT_PX` comment) regardless of what padding an OWNER picks, the *content budget* passed to the hook is derived as `PAGE_DIV_HEIGHT_PX - pagePaddingV*2` — i.e. tuning padding trades space between margin and content, it never changes the total physical page height. This is a deliberate elaboration on the spec (which left exact field-splitting to the plan) specifically to prevent an OWNER's slider choice from ever reintroducing the blank-page PDF bug two earlier rounds fixed.
- **The single-source invariant, preserved through customization**: the hidden measurement pass and the real page-div render must derive every shared geometry value from the literal same values, now via one `resolveDocumentStyle(...)` call per component instead of module constants. No value may be written in two places.
- Default style values (verbatim, `src/lib/documentStyle.js`):
  ```js
  export const DEFAULT_DOCUMENT_STYLE = {
    accent: '#6c63ff',
    pagePaddingV: 40, pagePaddingH: 44,
    logoWidth: 110, logoMaxHeight: 64, logoGap: 20,
    nameSize: 18, addressSize: 12, contactSize: 12, titleSize: 28,
    headerRowGap: 25, contactLineGap: 6,
    clientInfoOffset: 17, docInfoBoxOffset: 17,
    splitRatioClient: 66,
    infoSize: 12,
    tableMarginTop: 18,
    tableHeaderBg: '#f4f4f6', tableHeaderColor: '#4a4d63', tableHeaderSize: 12,
    tableHeaderPadding: 11, tableHeaderBorder: 2, tableHeaderBold: true,
    showContactIcons: true, showRevisionSuffix: true,
  }
  ```
  Every value above equals what's currently hardcoded in `QuotationHeader`/`DocumentHeader`/`QuotationPaper`/`DocumentPaper`, **except `logoMaxHeight` (64), which is new** — today's shipped code has no cap at all, which is the root cause of the "terrible" oversized-logo bug this plan also fixes.
- This project has no unit test runner (no test script in `package.json`) — every task verifies live: `npx vite build`, a throwaway Supabase test tenant via the exact `auth.users`/`auth.identities` INSERT pattern used throughout this session (empty-string `confirmation_token`/`recovery_token`/`email_change_token_new`/`email_change`, `COALESCE(..., '')` on other gotrue varchar columns, `tenants`/`user_roles` auto-created by `handle_new_user()` — never insert those two directly), Playwright against `http://localhost:5199`, full cleanup afterward in FK-dependency order verified with a final 0-row count query, then commit + push directly to `main` (`git fetch origin main`, confirm `git log HEAD..origin/main --oneline` is empty, then `git push origin worktree-quotation-module:main` — no PR workflow).
- Playwright: log in via the real login FORM (fill `input[type=email]`/`input[type=password]`, click submit) — API signup + localStorage token injection does not work in this app. No client-side router — navigate via `await page.evaluate(() => sessionStorage.setItem('pendingTab', '<tab-id>'))` then `await page.reload()`. The Settings tab's id is `'settings'` and is already `minRole:'OWNER'`-gated at the routing layer (real enforcement, not just nav-hiding — confirmed via a comment in `src/App.jsx` about a previously-fixed gap), so the new Settings card needs no additional role check of its own.
- Sandbox note: multi-line heredoc `git commit -m "$(cat <<'EOF' ...)"` compound commands are rejected as "too complex" in this worktree's sandbox. Write the commit message to a temp file first, then `git commit -F <file>`.
- Migration numbering: the last migration is `supabase/migrations/2026-09-04-01-tenant-contact-fields.sql`. This plan's migration is `2026-09-04-02-tenant-document-style.sql`.

---

### Task 1: Add `document_style` column to `tenants`

**Files:**
- Create: `supabase/migrations/2026-09-04-02-tenant-document-style.sql`
- Modify: `supabase/schema.sql`

**Interfaces:**
- Produces: `tenants.document_style JSONB` (nullable) — consumed by Task 2's `resolveDocumentStyle` (reads it) and Task 6's Settings UI (writes it).

- [ ] **Step 1: Dry-run the migration**

Via the `execute_sql` MCP tool (project_id `yyzbgdmgyvvypfcjuhtr`):

```sql
BEGIN;
ALTER TABLE tenants
  ADD COLUMN document_style JSONB;
ROLLBACK;
```

Expected: no errors.

- [ ] **Step 2: Apply live**

Run the same `ALTER TABLE` (no `BEGIN;`/`ROLLBACK;`) via `apply_migration`. Takes effect on the live database immediately.

- [ ] **Step 3: Write the migration file**

```sql
-- 2026-09-04-02-tenant-document-style.sql
-- Per-tenant document header style overrides (spec:
-- docs/superpowers/specs/2026-09-04-document-style-customizer-design.md).
-- NULL means "use DEFAULT_DOCUMENT_STYLE" (src/lib/documentStyle.js) --
-- no backfill needed, every existing tenant is unaffected until an OWNER
-- opens the new Settings customizer and saves.
ALTER TABLE tenants
  ADD COLUMN document_style JSONB;
```

Save to `supabase/migrations/2026-09-04-02-tenant-document-style.sql`.

- [ ] **Step 4: Update `supabase/schema.sql`**

Find the `ALTER TABLE tenants ADD COLUMN email TEXT, ADD COLUMN website TEXT;` block (from `2026-09-04-01-tenant-contact-fields.sql`) and add a second `ALTER TABLE` statement immediately after it for `document_style`, with a short comment matching that block's style.

- [ ] **Step 5: Verify live**

```sql
SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = 'tenants' AND column_name = 'document_style';
```

Expected: one row, `data_type = 'jsonb'`.

- [ ] **Step 6: Commit and push**

```
feat: add tenants.document_style for the per-tenant style customizer

Nullable JSONB, NULL means use DEFAULT_DOCUMENT_STYLE. Feeds the new
Settings customizer (spec:
docs/superpowers/specs/2026-09-04-document-style-customizer-design.md).
```

```bash
git add supabase/migrations/2026-09-04-02-tenant-document-style.sql supabase/schema.sql
git commit -F <temp-file-path>
git fetch origin main && git log HEAD..origin/main --oneline
git push origin worktree-quotation-module:main
```

---

### Task 2: Build the shared style module

**Files:**
- Create: `src/lib/documentStyle.js`

**Interfaces:**
- Produces: `DEFAULT_DOCUMENT_STYLE` (object, exact shape in Global Constraints), `resolveDocumentStyle(overrides)` → complete style object. Consumed by Task 4 (`QuotationHeader`/`QuotationPaper`), Task 5 (`DocumentHeader`/`DocumentPaper`), and Task 6 (Settings UI).

- [ ] **Step 1: Write the module**

```js
// Per-tenant document header style. NULL/missing fields on a tenant's
// document_style fall back to these defaults -- a tenant who never opens
// the Settings customizer is unaffected by this file ever changing its
// defaults (their documents track DEFAULT_DOCUMENT_STYLE going forward,
// not a frozen copy), while a tenant who saved a customization keeps
// exactly the fields they touched and nothing else.
//
// logoMaxHeight is new -- the previously-shipped header had no cap on the
// logo's stretch-to-match-text-height sizing, which looks disproportionate
// for a portrait-oriented logo file next to a short text block. Every
// other value here equals what QuotationHeader/DocumentHeader/
// QuotationPaper/DocumentPaper hardcoded before this file existed.
export const DEFAULT_DOCUMENT_STYLE = {
  accent: '#6c63ff',
  pagePaddingV: 40, pagePaddingH: 44,
  logoWidth: 110, logoMaxHeight: 64, logoGap: 20,
  nameSize: 18, addressSize: 12, contactSize: 12, titleSize: 28,
  headerRowGap: 25, contactLineGap: 6,
  clientInfoOffset: 17, docInfoBoxOffset: 17,
  splitRatioClient: 66,
  infoSize: 12,
  tableMarginTop: 18,
  tableHeaderBg: '#f4f4f6', tableHeaderColor: '#4a4d63', tableHeaderSize: 12,
  tableHeaderPadding: 11, tableHeaderBorder: 2, tableHeaderBold: true,
  showContactIcons: true, showRevisionSuffix: true,
}

// Flat shallow merge -- every DEFAULT_DOCUMENT_STYLE value is a primitive
// (number/string/boolean), so a sparse per-field override object (as
// stored in tenants.document_style, or as built up by the Settings
// customizer's slider state) is always sufficient; no nested/deep merge
// needed.
export function resolveDocumentStyle(overrides) {
  return { ...DEFAULT_DOCUMENT_STYLE, ...(overrides || {}) }
}
```

- [ ] **Step 2: Build**

```bash
npx vite build
```

Expected: no errors. (No consumers yet — this only checks syntax.)

- [ ] **Step 3: Commit**

No independent live-verification surface yet (pure data module, no UI). Verified end-to-end in Task 4.

```
feat: add DEFAULT_DOCUMENT_STYLE + resolveDocumentStyle

Shared style-resolution module for the new per-tenant document style
customizer (spec:
docs/superpowers/specs/2026-09-04-document-style-customizer-design.md).
No consumers yet -- wired into QuotationHeader/QuotationPaper next.
```

```bash
git add src/lib/documentStyle.js
git commit -F <temp-file-path>
git fetch origin main && git log HEAD..origin/main --oneline
git push origin worktree-quotation-module:main
```

---

### Task 3: `usePaginatedDocument` gains optional geometry overrides

**Files:**
- Modify: `src/hooks/usePaginatedDocument.jsx` (full file read as part of writing this plan — 237 lines, current shape assumed accurate)

**Interfaces:**
- Consumes: nothing new.
- Produces: `usePaginatedDocument({ ..., pageWidth, pagePaddingCss, pageHeight, tableMarginTop })` — four new optional parameters, each defaulting to the hook's own existing exported constant when omitted. `PAGE_WIDTH_PX`/`PAGE_PADDING_V_PX`/`PAGE_PADDING_H_PX`/`PAGE_PADDING_CSS`/`TABLE_MARGIN_TOP_PX`/`PAGE_HEIGHT_PX` stay exported, unchanged in value, for any caller (including Task 4/5's own `PAGE_DIV_HEIGHT_PX` computation) that still wants the raw defaults. Consumed by Task 4 (`QuotationPaper`) and Task 5 (`DocumentPaper`).

- [ ] **Step 1: Change the hook's parameter destructuring**

Find (line 83):

```js
export function usePaginatedDocument({ items, renderHeader, renderTableHeader, renderRow, renderFooter, remeasureKey }) {
```

Replace with:

```js
export function usePaginatedDocument({
  items, renderHeader, renderTableHeader, renderRow, renderFooter, remeasureKey,
  pageWidth = PAGE_WIDTH_PX,
  pagePaddingCss = PAGE_PADDING_CSS,
  pageHeight = PAGE_HEIGHT_PX,
  tableMarginTop = TABLE_MARGIN_TOP_PX,
}) {
```

Every caller that doesn't pass these four new keys gets exactly `PAGE_WIDTH_PX`/`PAGE_PADDING_CSS`/`PAGE_HEIGHT_PX`/`TABLE_MARGIN_TOP_PX` — identical to today's behavior, since those are literally what the destructured defaults equal.

- [ ] **Step 2: Replace the 4 internal usages of the module constants with the new local parameter names**

In the hidden measurement pass (around line 135, the `measurementNode` div and its children):

```jsx
<div style={{ position: 'absolute', visibility: 'hidden', pointerEvents: 'none', top: 0, left: -99999, width: pageWidth, padding: pagePaddingCss, boxSizing: 'border-box', zIndex: -1 }}>
  <div ref={headerRef}>{renderHeader()}</div>
  <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: tableMarginTop }}>
```

(replacing `PAGE_WIDTH_PX` → `pageWidth`, `PAGE_PADDING_CSS` → `pagePaddingCss`, `TABLE_MARGIN_TOP_PX` → `tableMarginTop` — only in these two spots, leave everything else in that JSX block unchanged).

In the budget calculation (around line 160):

```js
const availableRegular = pageHeight - heights.headerHeight - heights.tableHeaderHeight - tableMarginTop
```

(replacing `PAGE_HEIGHT_PX` → `pageHeight`, `TABLE_MARGIN_TOP_PX` → `tableMarginTop`).

In the footer-fit branch (around line 182, `if (heights.footerHeight <= availableRegular)`) — no change needed, it already only references `availableRegular`/`heights.footerHeight`, both already using the new locals transitively.

**Do not touch anything else in this file** — the bucketing loop (lines 164-176), the footer maximal-suffix-split logic (lines 184-207), the extreme-footer branch (lines 208-219), and the zero-items guard (lines 231-233) are all untouched, since none of them reference the geometry constants directly (they only use `availableRegular`/`availableLast`, which are already correctly derived above).

- [ ] **Step 3: Build**

```bash
npx vite build
```

Expected: no errors.

- [ ] **Step 4: Live verification — prove existing callers are unaffected**

1. Create a throwaway test tenant, a client, and a quotation with 25-28 items (enough to force 2+ pages under today's defaults — matches the prior plan's own multi-page verification approach).
2. Playwright: log in, open the quotation's document modal, screenshot. Confirm the page count, header content, and footer placement are IDENTICAL to what the prior plan's Task 5 verification already established (2 pages for a similarly-sized test case, full header repeated, totals/signature only on the last page) — since neither `QuotationPaper` nor `DocumentPaper` pass any of the 4 new parameters yet (that's Task 4/5), this step is purely a regression check that Task 3's refactor changed nothing observable.
3. Clean up the test tenant fully, verify 0 rows left.

- [ ] **Step 5: Commit and push**

```
feat: usePaginatedDocument accepts optional geometry overrides

pageWidth/pagePaddingCss/pageHeight/tableMarginTop, each defaulting to
the hook's own existing exported constant -- every current call site
(neither QuotationPaper nor DocumentPaper pass these yet) is
unaffected, proven via a live multi-page regression check. Lets the
upcoming per-tenant style customizer (spec:
docs/superpowers/specs/2026-09-04-document-style-customizer-design.md)
drive the hidden measurement pass and the real page-div render from
the exact same resolved-style values, preserving the single-source
invariant the prior plan established.
```

```bash
git add src/hooks/usePaginatedDocument.jsx
git commit -F <temp-file-path>
git fetch origin main && git log HEAD..origin/main --oneline
git push origin worktree-quotation-module:main
```

---

### Task 4: Wire `QuotationHeader`/`QuotationPaper` to `resolveDocumentStyle`

**Files:**
- Modify: `src/pages/Quotations.jsx` (`QuotationHeader` ~line 329-378, `QuotationPaper` ~line 386-561 — exact current content read in full as part of writing this plan)

**Interfaces:**
- Consumes: `resolveDocumentStyle` from Task 2, the hook's new optional parameters from Task 3.
- Produces: no new external props — `QuotationHeader`/`QuotationPaper` still take exactly the same props as before; they now internally read `tenant?.document_style` via `resolveDocumentStyle`. This is what Task 6's live preview relies on (feeding a synthetic `tenant` object with an unsaved `document_style` reproduces the exact same resolution path a real save would).

This task is a mechanical substitution: every hardcoded number/string that appears in `DEFAULT_DOCUMENT_STYLE` gets replaced with the resolved style's corresponding field. Read the current `QuotationHeader`/`QuotationPaper` in full before starting (already re-read as part of writing this plan; the code below assumes that exact starting point — do not guess at line numbers, re-grep for the current content since Tasks 1-3 don't touch this file).

- [ ] **Step 1: Import and remove the now-redundant module-level `ACCENT` constant**

Add to `Quotations.jsx`'s imports: `import { resolveDocumentStyle } from '../lib/documentStyle.js'`. Also add `PAGE_DIV_HEIGHT_PX`-relevant imports if not already present — check the existing `import { usePaginatedDocument, PAGE_HEIGHT_PX, PAGE_WIDTH_PX, PAGE_PADDING_CSS, PAGE_PADDING_V_PX, TABLE_MARGIN_TOP_PX } from '../hooks/usePaginatedDocument.jsx'` line and keep it as-is (these stay the FIXED-value fallbacks/defaults for width and the total page-div height, per Global Constraints — only padding and table-margin become tunable, and even those flow through `resolveDocumentStyle`, not directly from these imports, inside `QuotationHeader`/`QuotationPaper` themselves).

Remove the module-level `const ACCENT = '#6c63ff'` (line 316) — it becomes `style.accent` inside each component instead, since it's now a per-tenant-tunable value, not a fixed constant.

- [ ] **Step 2: Rewrite `QuotationHeader`**

Add a `style` prop (the caller passes `resolveDocumentStyle(tenant?.document_style)`'s result once, not recomputed per sub-component):

```jsx
function QuotationHeader({ tenant, tag, revisionSuffix, quotationNumber, date, validUntil, siteName, clientName, clientAddress, clientTaxId, pageNumber, totalPages, style }) {
  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'stretch', gap: style.headerRowGap }}>
        <div style={{ display: 'flex', gap: style.logoGap }}>
          {tenant?.logo_url
            ? (
              <div style={{ position: 'relative', width: style.logoWidth, maxHeight: style.logoMaxHeight, flexShrink: 0 }}>
                <img src={tenant.logo_url} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', objectPosition: 'left center' }} crossOrigin="anonymous" />
              </div>
            )
            : <div style={{ width: 40, height: 40, borderRadius: 8, background: style.accent, flexShrink: 0 }} />}
          <div>
            <div style={{ fontSize: style.nameSize, fontWeight: 800 }}>{tenant?.company_name}</div>
            {tenant?.address && <div style={{ fontSize: style.addressSize, color: '#6a6f85', lineHeight: 1.6, marginTop: 2 }}>{tenant.address}</div>}
            {tenant?.tax_id && <div style={{ fontSize: style.addressSize, color: '#6a6f85' }}>เลขผู้เสียภาษี {tenant.tax_id}</div>}
            {style.showContactIcons && (tenant?.phone || tenant?.email || tenant?.website) && (
              <div style={{ fontSize: style.contactSize, color: '#4a4d63', marginTop: style.contactLineGap }}>
                {tenant?.phone && <>📞&nbsp;{tenant.phone}</>}
                {tenant?.phone && (tenant?.email || tenant?.website) && <>&nbsp;&nbsp;&nbsp;</>}
                {tenant?.email && <>✉️&nbsp;{tenant.email}</>}
                {tenant?.email && tenant?.website && <>&nbsp;&nbsp;&nbsp;</>}
                {tenant?.website && <>🌐&nbsp;{tenant.website}</>}
              </div>
            )}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: style.addressSize, color: '#6a6f85', marginBottom: 4 }}>หน้า {pageNumber}/{totalPages}</div>
          <div style={{ fontSize: style.addressSize, fontWeight: 700, color: style.accent, border: `1px solid ${style.accent}`, borderRadius: 4, padding: '2px 8px', display: 'inline-block', marginBottom: 6 }}>{tag || 'ต้นฉบับ'}</div>
          <div style={{ fontSize: style.titleSize, fontWeight: 800 }}>ใบเสนอราคา</div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: `${style.splitRatioClient}fr ${100 - style.splitRatioClient}fr`, gap: 20 }}>
        <div style={{ marginTop: style.clientInfoOffset, fontSize: 12.5, lineHeight: 2 }}>
          <div><span style={{ color: '#6a6f85' }}>ลูกค้า&nbsp;:</span> <strong>{clientName || '—'}</strong></div>
          <div><span style={{ color: '#6a6f85' }}>ที่อยู่&nbsp;:</span> {clientAddress || '—'}</div>
          {clientTaxId && <div><span style={{ color: '#6a6f85' }}>เลขที่ภาษี&nbsp;:</span> {clientTaxId}</div>}
        </div>
        <div style={{ marginTop: style.docInfoBoxOffset, border: '1px solid #e4e6ef', borderRadius: 8, padding: '14px 16px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 24px', fontSize: style.infoSize }}>
          <div><span style={{ color: '#6a6f85' }}>เลขที่เอกสาร</span><br /><strong>{quotationNumber}{style.showRevisionSuffix ? revisionSuffix : ''}</strong></div>
          <div><span style={{ color: '#6a6f85' }}>วันที่ออก</span><br />{date ? new Date(date).toLocaleDateString('th-TH') : '—'}</div>
          <div><span style={{ color: '#6a6f85' }}>ใช้ได้ถึง</span><br />{validUntil ? new Date(validUntil).toLocaleDateString('th-TH') : '—'}</div>
          <div><span style={{ color: '#6a6f85' }}>โครงการ</span><br />{siteName || '—'}</div>
        </div>
      </div>
    </>
  )
}
```

- [ ] **Step 3: Wire `QuotationPaper` to resolve style once and pass it through**

Inside `QuotationPaper`, right after `const mySignature = useMySignatureUrl()`, add:

```js
const style = resolveDocumentStyle(tenant?.document_style)
```

Update `headerProps` to include it:

```js
const headerProps = { tenant, tag, revisionSuffix, quotationNumber, date, validUntil, siteName, clientName, clientAddress, clientTaxId, style }
```

Update `renderTableHeader` to use resolved values (replacing every `'#f4f4f6'` → `style.tableHeaderBg`, `'#4a4d63'` → `style.tableHeaderColor`, `12` → `style.tableHeaderSize`, `'11px 8px'` → `` `${style.tableHeaderPadding}px 8px` ``, the `2px solid ${ACCENT}` border → `` `${style.tableHeaderBorder}px solid ${style.accent}` ``, and adding `fontWeight: style.tableHeaderBold ? 700 : 400` in place of the hardcoded `fontWeight: 700`):

```js
const renderTableHeader = () => (
  <tr>
    <th style={{ textAlign: 'left', padding: `${style.tableHeaderPadding}px 8px`, fontSize: style.tableHeaderSize, fontWeight: style.tableHeaderBold ? 700 : 400, color: style.tableHeaderColor, background: style.tableHeaderBg, borderBottom: `${style.tableHeaderBorder}px solid ${style.accent}` }}>รายการ</th>
    <th style={{ textAlign: 'right', padding: `${style.tableHeaderPadding}px 8px`, fontSize: style.tableHeaderSize, fontWeight: style.tableHeaderBold ? 700 : 400, color: style.tableHeaderColor, background: style.tableHeaderBg, borderBottom: `${style.tableHeaderBorder}px solid ${style.accent}` }}>จำนวน</th>
    <th style={{ textAlign: 'right', padding: `${style.tableHeaderPadding}px 8px`, fontSize: style.tableHeaderSize, fontWeight: style.tableHeaderBold ? 700 : 400, color: style.tableHeaderColor, background: style.tableHeaderBg, borderBottom: `${style.tableHeaderBorder}px solid ${style.accent}` }}>ราคา/หน่วย</th>
    <th style={{ textAlign: 'right', padding: `${style.tableHeaderPadding}px 8px`, fontSize: style.tableHeaderSize, fontWeight: style.tableHeaderBold ? 700 : 400, color: style.tableHeaderColor, background: style.tableHeaderBg, borderBottom: `${style.tableHeaderBorder}px solid ${style.accent}` }}>รวม</th>
  </tr>
)
```

In `renderFooter`, replace the two `color: ACCENT`/`borderTop: `2px solid ${ACCENT}`` usages on the "รวมทั้งสิ้น" row with `style.accent` — leave everything else in `renderFooter` unchanged (its layout/spacing isn't part of the tunable set per the spec's slider list).

Update the `usePaginatedDocument` call to pass the derived, padding-safe content-height budget and the resolved padding/table-margin:

```js
const { pages, pageCount, measurementNode } = usePaginatedDocument({
  items,
  renderHeader: () => <QuotationHeader {...headerProps} pageNumber={1} totalPages={1} />,
  renderTableHeader,
  renderRow,
  renderFooter,
  remeasureKey: `${mySignature?.url || ''}|${clientSignature?.url || ''}|${extraRemeasureKey || ''}`,
  pagePaddingCss: `${style.pagePaddingV}px ${style.pagePaddingH}px`,
  pageHeight: (PAGE_HEIGHT_PX + PAGE_PADDING_V_PX * 2) - style.pagePaddingV * 2,
  tableMarginTop: style.tableMarginTop,
})
```

(`pageWidth` is deliberately NOT passed — page width stays fixed at `PAGE_WIDTH_PX`, per Global Constraints. The `pageHeight` expression is exactly the Global Constraints' "derive the content budget from the fixed total minus tunable padding" rule: `PAGE_HEIGHT_PX + PAGE_PADDING_V_PX * 2` is today's fixed total page-div height — 980px — and subtracting `style.pagePaddingV * 2` (which may differ from the default 40) yields the correct content budget for whatever padding was chosen, while the TOTAL page-div height computed in Step 4 below stays pinned to that same fixed 980px value always.)

- [ ] **Step 4: Update the page-div's own render to use `style`**

Replace:

```js
const PAGE_DIV_HEIGHT_PX = PAGE_HEIGHT_PX + PAGE_PADDING_V_PX * 2
```

with a comment clarifying it's now the fixed total (unaffected by tunable padding — see Step 3's budget derivation):

```js
// Fixed total page-div height regardless of the tenant's chosen padding --
// see the usePaginatedDocument call above, which derives its content
// budget as (this fixed total) minus the tenant's tunable padding, so the
// physical page-div height driving the PDF/print budget never moves.
const PAGE_DIV_HEIGHT_PX = PAGE_HEIGHT_PX + PAGE_PADDING_V_PX * 2
```

(no code change here, just the clarifying comment — `PAGE_DIV_HEIGHT_PX` itself stays computed from the fixed imported constants, deliberately NOT from `style`).

Then update the page-div's own inline style: replace `padding: PAGE_PADDING_CSS` with `padding: \`${style.pagePaddingV}px ${style.pagePaddingH}px\`` in the page-div's style object, and the item table's `marginTop: TABLE_MARGIN_TOP_PX` with `marginTop: style.tableMarginTop`. Also pass `style` to both `<QuotationHeader {...headerProps} .../>` render calls — already covered since `headerProps` now includes `style` (Step 3).

- [ ] **Step 5: Build**

```bash
npx vite build
```

Expected: no errors. Fix any missed `ACCENT`/hardcoded-value references now (search the file for `ACCENT` to confirm none remain in `QuotationHeader`/`QuotationPaper`).

- [ ] **Step 6: Live verification**

1. Create a throwaway test tenant with `logo_url` set to a real, tall/portrait-oriented image (reuse the same public test logo URL used in the prior plan's verification: `https://yyzbgdmgyvvypfcjuhtr.supabase.co/storage/v1/object/public/tenant-logos/1b9affc4-2136-4ed1-b168-a36e6624e743/logo.jpg`), `document_style` left `NULL`.
2. Playwright: open a quotation's document modal, screenshot. Confirm: **the logo no longer exceeds ~64px in height** even though the text block next to it is 3-4 lines tall (the actual bug being fixed) — measure via `getBoundingClientRect()` on the logo `<img>`, confirm `height <= 64` (allow a couple px of rounding slack).
3. Directly `UPDATE tenants SET document_style = '{"accent":"#e91e63","nameSize":24}'::jsonb WHERE id = '<test-tenant-id>'`, reload the document modal, confirm: the accent color (tag border, table header underline, totals row) is now pink, and the company name renders larger — proving the resolution path works for a real saved override, ahead of Task 6's UI existing yet.
4. Reconfirm the multi-page case (25-28 items) still paginates correctly with `document_style` set to a non-default padding value (e.g. `{"pagePaddingV": 60}`) — confirm page count and footer placement stay correct, and that the exported PDF's page count (byte-inspect `/Count`) matches, proving the fixed-total-height derivation in Step 3 is actually holding.
5. Clean up the test tenant fully, verify 0 rows left.

- [ ] **Step 7: Commit and push**

```
feat: wire QuotationHeader/QuotationPaper to resolveDocumentStyle

Every previously-hardcoded header value (logo size, fonts, spacing,
accent color, table-header styling, contact-icons/revision-suffix
visibility) now comes from resolveDocumentStyle(tenant?.document_style)
instead of fixed constants -- spec:
docs/superpowers/specs/2026-09-04-document-style-customizer-design.md.

Fixes a real shipped bug along the way: the logo previously had no
height cap and could stretch disproportionately tall next to a full
text block. The new DEFAULT_DOCUMENT_STYLE's logoMaxHeight (64px) caps
it even for a tenant who never customizes anything.

Page width and the total page-div height stay fixed regardless of the
tenant's chosen padding -- the pagination hook's content-height budget
is derived as (fixed total) minus (tunable padding), so a large
padding choice trades content-space for margin-space rather than
growing the physical page past the PDF page-break safety margin two
earlier bugs were fixed against.

Verified live: default-style logo now measured <=64px next to a
4-line text block (was unbounded before), a saved document_style
override (custom accent + name size) renders correctly, and a
non-default padding value still produces the correct page count and
PDF byte-level page count for a 25+ item document.
```

```bash
git add src/pages/Quotations.jsx
git commit -F <temp-file-path>
git fetch origin main && git log HEAD..origin/main --oneline
git push origin worktree-quotation-module:main
```

---

### Task 5: Wire `DocumentHeader`/`DocumentPaper` to `resolveDocumentStyle`

**Files:**
- Modify: `src/pages/Invoices.jsx` (`DocumentHeader` ~line 506-554, `DocumentPaper` ~line 575-750 — exact current content read in full as part of writing this plan)

**Interfaces:**
- Consumes: `resolveDocumentStyle` from Task 2, the hook's new optional parameters from Task 3 (already proven correct by Task 4).
- Produces: same as Task 4 — no new external props, `tenant?.document_style` is the only new thing read internally.

Same shape as Task 4, applied to `DocumentHeader`/`DocumentPaper`. Read the current code in full before starting (already re-read as part of writing this plan; assume that exact starting point).

- [ ] **Step 1: Import and remove the redundant `ACCENT` constant**

Add `import { resolveDocumentStyle } from '../lib/documentStyle.js'` to `Invoices.jsx`'s imports (the `usePaginatedDocument`/`PAGE_HEIGHT_PX`/`PAGE_WIDTH_PX`/`PAGE_PADDING_CSS`/`PAGE_PADDING_V_PX`/`TABLE_MARGIN_TOP_PX` import already exists — keep it, same reasoning as Task 4 Step 1). Remove the module-level `const ACCENT = '#6c63ff'` (line 485).

- [ ] **Step 2: Rewrite `DocumentHeader`**

Add a `style` prop, same substitutions as `QuotationHeader` (Task 4 Step 2), but keeping `DocumentHeader`'s own existing differences intact: `title`/`infoFields` stay caller-driven exactly as today (no `revisionSuffix`/`quotationNumber`/`date`/`validUntil`/`siteName` props — this component never had those), and there's no `style.showRevisionSuffix` check since there's no revision suffix here at all:

```jsx
function DocumentHeader({ tenant, tag, title, infoFields, clientName, clientAddress, clientTaxId, pageNumber, totalPages, style }) {
  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'stretch', gap: style.headerRowGap }}>
        <div style={{ display: 'flex', gap: style.logoGap }}>
          {tenant?.logo_url
            ? (
              <div style={{ position: 'relative', width: style.logoWidth, maxHeight: style.logoMaxHeight, flexShrink: 0 }}>
                <img src={tenant.logo_url} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', objectPosition: 'left center' }} crossOrigin="anonymous" />
              </div>
            )
            : <div style={{ width: 40, height: 40, borderRadius: 8, background: style.accent, flexShrink: 0 }} />}
          <div>
            <div style={{ fontSize: style.nameSize, fontWeight: 800 }}>{tenant?.company_name}</div>
            {tenant?.address && <div style={{ fontSize: style.addressSize, color: '#6a6f85', lineHeight: 1.6, marginTop: 2 }}>{tenant.address}</div>}
            {tenant?.tax_id && <div style={{ fontSize: style.addressSize, color: '#6a6f85' }}>เลขผู้เสียภาษี {tenant.tax_id}</div>}
            {style.showContactIcons && (tenant?.phone || tenant?.email || tenant?.website) && (
              <div style={{ fontSize: style.contactSize, color: '#4a4d63', marginTop: style.contactLineGap }}>
                {tenant?.phone && <>📞&nbsp;{tenant.phone}</>}
                {tenant?.phone && (tenant?.email || tenant?.website) && <>&nbsp;&nbsp;&nbsp;</>}
                {tenant?.email && <>✉️&nbsp;{tenant.email}</>}
                {tenant?.email && tenant?.website && <>&nbsp;&nbsp;&nbsp;</>}
                {tenant?.website && <>🌐&nbsp;{tenant.website}</>}
              </div>
            )}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: style.addressSize, color: '#6a6f85', marginBottom: 4 }}>หน้า {pageNumber}/{totalPages}</div>
          <div style={{ fontSize: style.addressSize, fontWeight: 700, color: style.accent, border: `1px solid ${style.accent}`, borderRadius: 4, padding: '2px 8px', display: 'inline-block', marginBottom: 6 }}>{tag || 'ต้นฉบับ'}</div>
          <div style={{ fontSize: style.titleSize, fontWeight: 800 }}>{title}</div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: `${style.splitRatioClient}fr ${100 - style.splitRatioClient}fr`, gap: 20 }}>
        <div style={{ marginTop: style.clientInfoOffset, fontSize: 12.5, lineHeight: 2 }}>
          <div><span style={{ color: '#6a6f85' }}>ลูกค้า&nbsp;:</span> <strong>{clientName || '—'}</strong></div>
          <div><span style={{ color: '#6a6f85' }}>ที่อยู่&nbsp;:</span> {clientAddress || '—'}</div>
          {clientTaxId && <div><span style={{ color: '#6a6f85' }}>เลขที่ภาษี&nbsp;:</span> {clientTaxId}</div>}
        </div>
        <div style={{ marginTop: style.docInfoBoxOffset, border: '1px solid #e4e6ef', borderRadius: 8, padding: '14px 16px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 24px', fontSize: style.infoSize }}>
          {infoFields.map(f => (
            <div key={f.label}><span style={{ color: '#6a6f85' }}>{f.label}</span><br />{f.value}</div>
          ))}
        </div>
      </div>
    </>
  )
}
```

- [ ] **Step 3: Wire `DocumentPaper`**

Same pattern as Task 4 Step 3: add `const style = resolveDocumentStyle(tenant?.document_style)` right after `const mySignature = useMySignatureUrl()`; add `style` to `headerProps`; update `renderTableHeader` identically to Task 4's version (same field substitutions); in `renderFooter`, replace the `color: ACCENT`/`borderTop: `2px solid ${ACCENT}`` on the totals row (`totalsLabel`/`totalsAmount` row) with `style.accent` — leave the withholding-tax sub-block's own `#c0392b` color unchanged (not part of the tunable set); update the `usePaginatedDocument` call:

```js
const { pages, pageCount, measurementNode } = usePaginatedDocument({
  items,
  renderHeader: () => <DocumentHeader {...headerProps} pageNumber={1} totalPages={1} />,
  renderTableHeader,
  renderRow,
  renderFooter,
  remeasureKey: `${mySignature?.url || ''}|${recipientSignature?.url || ''}|${extraRemeasureKey || ''}`,
  pagePaddingCss: `${style.pagePaddingV}px ${style.pagePaddingH}px`,
  pageHeight: (PAGE_HEIGHT_PX + PAGE_PADDING_V_PX * 2) - style.pagePaddingV * 2,
  tableMarginTop: style.tableMarginTop,
})
```

- [ ] **Step 4: Update the page-div's own render**

Same as Task 4 Step 4: `PAGE_DIV_HEIGHT_PX` stays computed from the fixed imported constants (add the same clarifying comment), the page-div's `padding` becomes `` `${style.pagePaddingV}px ${style.pagePaddingH}px` ``, the item table's `marginTop` becomes `style.tableMarginTop`, `<DocumentHeader {...headerProps} .../>` picks up `style` via `headerProps` automatically.

- [ ] **Step 5: Build**

```bash
npx vite build
```

Expected: no errors. Search the file for `ACCENT` to confirm none remain in `DocumentHeader`/`DocumentPaper`.

- [ ] **Step 6: Live verification**

Mirror Task 4 Step 6, but for an Invoice AND a Receipt (both render through `DocumentPaper`):

1. Reuse or create a throwaway test tenant with the same tall test logo, `document_style` left `NULL`. Create a quotation → accept it → create an invoice with 2-3 items; mark it paid to generate a receipt.
2. Playwright: open the invoice document modal, screenshot, confirm logo height `<= 64px`. Open the receipt document modal, same check.
3. `UPDATE tenants SET document_style = '{"accent":"#e91e63","nameSize":24}'::jsonb ...`, reload both, confirm the accent/name-size changes apply identically to both document types (proving the ONE shared style config genuinely covers Quotation AND Invoice/Receipt, per the spec's "one shared config" decision).
4. Create a second invoice with 25-28 items, set a non-default `pagePaddingV` via SQL, confirm multi-page pagination and PDF page count are still correct.
5. Clean up the test tenant fully, verify 0 rows left.

- [ ] **Step 7: Commit and push**

```
feat: wire DocumentHeader/DocumentPaper to resolveDocumentStyle

Same treatment as QuotationHeader/QuotationPaper (previous commit):
every previously-hardcoded header value now comes from
resolveDocumentStyle(tenant?.document_style). Confirms the spec's
"one shared style config" decision -- Invoice and Receipt (both
render through DocumentPaper) pick up the exact same saved
customization Quotation does, verified live against both.

Spec: docs/superpowers/specs/2026-09-04-document-style-customizer-design.md

Verified live: default-style logo capped correctly on an invoice and
a receipt, a saved override applies identically to both, and a
non-default padding value still produces correct multi-page
pagination and PDF page count.
```

```bash
git add src/pages/Invoices.jsx
git commit -F <temp-file-path>
git fetch origin main && git log HEAD..origin/main --oneline
git push origin worktree-quotation-module:main
```

---

### Task 6: Settings UI — style customizer card with live preview

**Files:**
- Modify: `src/pages/Settings.jsx`

**Interfaces:**
- Consumes: `DEFAULT_DOCUMENT_STYLE`/`resolveDocumentStyle` (Task 2), `QuotationPaper` (Task 4, imported from `Quotations.jsx` — check whether it's currently exported; if not, add a named export `export function QuotationPaper(...)` to `Quotations.jsx` as part of this task, since it's needed here for the live preview and wasn't previously imported outside that file).
- Produces: nothing new consumed elsewhere — this is the final task.

- [ ] **Step 1: Export `QuotationPaper`**

`QuotationPaper` is currently declared as a plain, non-exported `function QuotationPaper({ ... }) {` (confirmed at `src/pages/Quotations.jsx:386`). Add `export` to that declaration (`export function QuotationPaper({ ... }) {`) so `Settings.jsx` can import it for the live preview. No other change to that file.

- [ ] **Step 2: Add imports to `Settings.jsx`**

```js
import { DEFAULT_DOCUMENT_STYLE, resolveDocumentStyle } from '../lib/documentStyle.js'
import { QuotationPaper } from './Quotations.jsx'
```

- [ ] **Step 3: Add customizer state**

Inside the `Settings` component, alongside the existing `useTenant()` call (`const { tenant, hasModuleAccess, refetch: refetchTenant } = useTenant()`), add:

```js
const [docStyle, setDocStyle] = useState(() => resolveDocumentStyle(tenant?.document_style))
const [savingDocStyle, setSavingDocStyle] = useState(false)
useEffect(() => {
  setDocStyle(resolveDocumentStyle(tenant?.document_style))
}, [tenant?.document_style])
const setDocStyleField = (k, v) => setDocStyle(s => ({ ...s, [k]: v }))
```

(The `useEffect` re-syncs local state when `tenant` reloads — e.g. after Save calls `refetchTenant()` — so the panel reflects the just-saved values rather than staying on stale pre-save state.)

- [ ] **Step 4: Add save/reset handlers**

```js
const handleSaveDocStyle = async () => {
  setSavingDocStyle(true)
  try {
    const { error } = await supabase.from('tenants').update({ document_style: docStyle }).eq('id', tenant.id)
    if (error) throw error
    refetchTenant()
    alert('✅ บันทึกรูปแบบเอกสารแล้ว')
  } catch (e) {
    alert('Error: ' + e.message)
  } finally {
    setSavingDocStyle(false)
  }
}

const handleResetDocStyle = async () => {
  setSavingDocStyle(true)
  try {
    const { error } = await supabase.from('tenants').update({ document_style: null }).eq('id', tenant.id)
    if (error) throw error
    refetchTenant()
    setDocStyle(DEFAULT_DOCUMENT_STYLE)
    alert('✅ คืนค่าเริ่มต้นแล้ว')
  } catch (e) {
    alert('Error: ' + e.message)
  } finally {
    setSavingDocStyle(false)
  }
}
```

- [ ] **Step 5: Build the preview's sample data**

Add a module-level constant (outside the `Settings` function, near the top of the file after imports) with realistic placeholder document content — NOT real tenant data (the tenant's real `company_name`/`logo_url`/etc. ARE used, via the real `tenant` object below, but client/items/document-number are fake so the preview doesn't depend on the tenant having any real quotations):

```js
const DOC_STYLE_PREVIEW_SAMPLE = {
  quotationNumber: 'QT-2026-000',
  date: new Date().toISOString().slice(0, 10),
  validUntil: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
  revision: 1,
  siteName: 'ตัวอย่างโครงการ',
  clientName: 'บริษัท ตัวอย่าง จำกัด',
  clientAddress: '123 ถนนตัวอย่าง แขวงตัวอย่าง เขตตัวอย่าง กรุงเทพมหานคร 10110',
  clientTaxId: '0000000000000',
  items: [
    { id: 'preview-1', description: 'งานติดตั้งระแนงอลูมิเนียม (ตัวอย่าง)', unit: 'ตร.ม.', quantity: 50, unit_price: 850, line_total: 42500 },
    { id: 'preview-2', description: 'งานสีกันสนิมโครงเหล็ก (ตัวอย่าง)', unit: 'ตร.ม.', quantity: 20, unit_price: 320, line_total: 6400 },
  ],
  hasVat: true,
  priceIncludesVat: false,
  paymentTerms: 'ตัวอย่างเงื่อนไขการชำระเงิน: มัดจำ 50% ก่อนเริ่มงาน ส่วนที่เหลือชำระเมื่องานเสร็จ',
  notes: null,
  bankAccount: null,
  clientSignature: null,
}
```

- [ ] **Step 6: Add the customizer card JSX**

Add a new `<div className="card">` after the existing "🏢 ข้อมูลบริษัท" card, structured as a two-column layout (control panel left, live preview right — matching the proven slider-panel pattern from this feature's design session):

```jsx
<div className="card" style={{ marginBottom: 16 }}>
  <div className="card-header"><div className="card-title">🎨 รูปแบบเอกสาร (ใบเสนอราคา/ใบแจ้งหนี้/ใบเสร็จ)</div></div>
  <div className="card-body" style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: 20, alignItems: 'start' }}>
    <div style={{ display: 'grid', gap: 10 }}>
      <div>
        <label className="label">สีหลัก (Accent)</label>
        <input type="color" value={docStyle.accent} onChange={e => setDocStyleField('accent', e.target.value)} style={{ width: '100%', height: 32 }} />
      </div>

      <div className="label" style={{ marginTop: 8 }}>หน้ากระดาษ</div>
      <div>
        <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5 }}><span>ระยะขอบบน-ล่าง</span><span>{docStyle.pagePaddingV}px</span></label>
        <input type="range" min="16" max="64" value={docStyle.pagePaddingV} onChange={e => setDocStyleField('pagePaddingV', Number(e.target.value))} style={{ width: '100%' }} />
      </div>
      <div>
        <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5 }}><span>ระยะขอบซ้าย-ขวา</span><span>{docStyle.pagePaddingH}px</span></label>
        <input type="range" min="16" max="64" value={docStyle.pagePaddingH} onChange={e => setDocStyleField('pagePaddingH', Number(e.target.value))} style={{ width: '100%' }} />
      </div>

      <div className="label" style={{ marginTop: 8 }}>โลโก้</div>
      <div>
        <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5 }}><span>ความกว้าง</span><span>{docStyle.logoWidth}px</span></label>
        <input type="range" min="40" max="160" value={docStyle.logoWidth} onChange={e => setDocStyleField('logoWidth', Number(e.target.value))} style={{ width: '100%' }} />
      </div>
      <div>
        <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5 }}><span>ความสูงสูงสุด</span><span>{docStyle.logoMaxHeight}px</span></label>
        <input type="range" min="24" max="140" value={docStyle.logoMaxHeight} onChange={e => setDocStyleField('logoMaxHeight', Number(e.target.value))} style={{ width: '100%' }} />
      </div>
      <div>
        <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5 }}><span>ระยะห่างจากข้อความ</span><span>{docStyle.logoGap}px</span></label>
        <input type="range" min="0" max="30" value={docStyle.logoGap} onChange={e => setDocStyleField('logoGap', Number(e.target.value))} style={{ width: '100%' }} />
      </div>

      <div className="label" style={{ marginTop: 8 }}>ขนาดตัวอักษร</div>
      <div>
        <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5 }}><span>ชื่อบริษัท</span><span>{docStyle.nameSize}px</span></label>
        <input type="range" min="12" max="30" value={docStyle.nameSize} onChange={e => setDocStyleField('nameSize', Number(e.target.value))} style={{ width: '100%' }} />
      </div>
      <div>
        <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5 }}><span>ที่อยู่/ติดต่อ</span><span>{docStyle.addressSize}px</span></label>
        <input type="range" min="8" max="16" value={docStyle.addressSize} onChange={e => setDocStyleField('addressSize', Number(e.target.value))} style={{ width: '100%' }} />
      </div>
      <div>
        <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5 }}><span>หัวเอกสาร (เช่น "ใบเสนอราคา")</span><span>{docStyle.titleSize}px</span></label>
        <input type="range" min="14" max="40" value={docStyle.titleSize} onChange={e => setDocStyleField('titleSize', Number(e.target.value))} style={{ width: '100%' }} />
      </div>
      <div>
        <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5 }}><span>ตาราง/กล่องข้อมูล</span><span>{docStyle.infoSize}px</span></label>
        <input type="range" min="9" max="16" value={docStyle.infoSize} onChange={e => setDocStyleField('infoSize', Number(e.target.value))} style={{ width: '100%' }} />
      </div>

      <div className="label" style={{ marginTop: 8 }}>ระยะห่าง</div>
      <div>
        <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5 }}><span>แถวหัวเอกสาร</span><span>{docStyle.headerRowGap}px</span></label>
        <input type="range" min="6" max="48" value={docStyle.headerRowGap} onChange={e => setDocStyleField('headerRowGap', Number(e.target.value))} style={{ width: '100%' }} />
      </div>
      <div>
        <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5 }}><span>ที่อยู่ → ติดต่อ</span><span>{docStyle.contactLineGap}px</span></label>
        <input type="range" min="0" max="24" value={docStyle.contactLineGap} onChange={e => setDocStyleField('contactLineGap', Number(e.target.value))} style={{ width: '100%' }} />
      </div>
      <div>
        <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5 }}><span>กล่องข้อมูลลูกค้า → เอกสาร</span><span>{docStyle.clientInfoOffset}px / {docStyle.docInfoBoxOffset}px</span></label>
        <input type="range" min="0" max="48" value={docStyle.clientInfoOffset} onChange={e => setDocStyleField('clientInfoOffset', Number(e.target.value))} style={{ width: '100%' }} />
        <input type="range" min="0" max="48" value={docStyle.docInfoBoxOffset} onChange={e => setDocStyleField('docInfoBoxOffset', Number(e.target.value))} style={{ width: '100%' }} />
      </div>
      <div>
        <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5 }}><span>หัวเอกสาร → ตารางรายการ</span><span>{docStyle.tableMarginTop}px</span></label>
        <input type="range" min="6" max="48" value={docStyle.tableMarginTop} onChange={e => setDocStyleField('tableMarginTop', Number(e.target.value))} style={{ width: '100%' }} />
      </div>
      <div>
        <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5 }}><span>สัดส่วนคอลัมน์ (ลูกค้า)</span><span>{docStyle.splitRatioClient}%</span></label>
        <input type="range" min="40" max="80" value={docStyle.splitRatioClient} onChange={e => setDocStyleField('splitRatioClient', Number(e.target.value))} style={{ width: '100%' }} />
      </div>

      <div className="label" style={{ marginTop: 8 }}>หัวตารางรายการ</div>
      <div>
        <label className="label">สีพื้นหลัง</label>
        <input type="color" value={docStyle.tableHeaderBg} onChange={e => setDocStyleField('tableHeaderBg', e.target.value)} style={{ width: '100%', height: 28 }} />
      </div>
      <div>
        <label className="label">สีตัวอักษร</label>
        <input type="color" value={docStyle.tableHeaderColor} onChange={e => setDocStyleField('tableHeaderColor', e.target.value)} style={{ width: '100%', height: 28 }} />
      </div>
      <div>
        <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5 }}><span>ขนาดตัวอักษร</span><span>{docStyle.tableHeaderSize}px</span></label>
        <input type="range" min="8" max="16" value={docStyle.tableHeaderSize} onChange={e => setDocStyleField('tableHeaderSize', Number(e.target.value))} style={{ width: '100%' }} />
      </div>
      <div>
        <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5 }}><span>ระยะขอบใน</span><span>{docStyle.tableHeaderPadding}px</span></label>
        <input type="range" min="2" max="20" value={docStyle.tableHeaderPadding} onChange={e => setDocStyleField('tableHeaderPadding', Number(e.target.value))} style={{ width: '100%' }} />
      </div>
      <div>
        <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5 }}><span>เส้นขอบล่าง</span><span>{docStyle.tableHeaderBorder}px</span></label>
        <input type="range" min="0" max="6" value={docStyle.tableHeaderBorder} onChange={e => setDocStyleField('tableHeaderBorder', Number(e.target.value))} style={{ width: '100%' }} />
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <input type="checkbox" checked={docStyle.tableHeaderBold} onChange={e => setDocStyleField('tableHeaderBold', e.target.checked)} />
        ตัวหนา
      </label>

      <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 }}>
        <input type="checkbox" checked={docStyle.showContactIcons} onChange={e => setDocStyleField('showContactIcons', e.target.checked)} />
        แสดงข้อมูลติดต่อ (โทร/อีเมล/เว็บไซต์)
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <input type="checkbox" checked={docStyle.showRevisionSuffix} onChange={e => setDocStyleField('showRevisionSuffix', e.target.checked)} />
        แสดงเลขแก้ไข (-R2) ที่เลขที่เอกสาร
      </label>

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button className="btn btn-primary" onClick={handleSaveDocStyle} disabled={savingDocStyle} style={{ flex: 1 }}>
          {savingDocStyle ? '⏳...' : '💾 บันทึก'}
        </button>
        <button className="btn btn-ghost" onClick={handleResetDocStyle} disabled={savingDocStyle}>
          ↺ คืนค่าเริ่มต้น
        </button>
      </div>
    </div>

    <div style={{ border: '1px solid var(--border)', borderRadius: 10, overflow: 'auto', maxHeight: '80vh' }}>
      <QuotationPaper
        elementId="doc-style-preview"
        tenant={{ ...tenant, document_style: docStyle }}
        quotationNumber={DOC_STYLE_PREVIEW_SAMPLE.quotationNumber}
        tag="ตัวอย่าง"
        date={DOC_STYLE_PREVIEW_SAMPLE.date}
        validUntil={DOC_STYLE_PREVIEW_SAMPLE.validUntil}
        revision={DOC_STYLE_PREVIEW_SAMPLE.revision}
        siteName={DOC_STYLE_PREVIEW_SAMPLE.siteName}
        clientName={DOC_STYLE_PREVIEW_SAMPLE.clientName}
        clientAddress={DOC_STYLE_PREVIEW_SAMPLE.clientAddress}
        clientTaxId={DOC_STYLE_PREVIEW_SAMPLE.clientTaxId}
        items={DOC_STYLE_PREVIEW_SAMPLE.items}
        hasVat={DOC_STYLE_PREVIEW_SAMPLE.hasVat}
        priceIncludesVat={DOC_STYLE_PREVIEW_SAMPLE.priceIncludesVat}
        paymentTerms={DOC_STYLE_PREVIEW_SAMPLE.paymentTerms}
        notes={DOC_STYLE_PREVIEW_SAMPLE.notes}
        bankAccount={DOC_STYLE_PREVIEW_SAMPLE.bankAccount}
        clientSignature={DOC_STYLE_PREVIEW_SAMPLE.clientSignature}
      />
    </div>
  </div>
</div>
```

The preview's `tenant={{ ...tenant, document_style: docStyle }}` is the whole mechanism: `QuotationPaper` internally calls `resolveDocumentStyle(tenant?.document_style)` (Task 4), so feeding it a shallow-cloned tenant object with the in-progress (unsaved) `docStyle` as its `document_style` makes the preview re-render with live slider values on every keystroke/drag, with zero new props or API surface on `QuotationPaper` itself.

- [ ] **Step 7: Build**

```bash
npx vite build
```

Expected: no errors.

- [ ] **Step 8: Live verification**

1. Create a throwaway test tenant (OWNER role — the default for a freshly-signed-up user, per `handle_new_user()`), with `company_name`/`logo_url`/`address`/etc. set on `tenants` so the preview has real-looking company info.
2. Playwright: log in, navigate to the `settings` tab (`sessionStorage.setItem('pendingTab', 'settings')` + reload), confirm the new "🎨 รูปแบบเอกสาร" card renders with the preview showing the sample quotation using the tenant's real logo/name.
3. Drag/change several sliders (e.g. `logoMaxHeight`, `accent` color, `pagePaddingV`) and confirm the preview updates immediately without a page reload or save (read the preview's rendered logo height / accent color via `getBoundingClientRect()`/`getComputedStyle()` before and after each change).
4. Click "💾 บันทึก", confirm the success alert, then query `SELECT document_style FROM tenants WHERE id = '<test-tenant-id>'` directly to confirm the exact slider values persisted.
5. Reload the whole page (not just the tab), navigate back to Settings, confirm the panel's sliders now show the SAVED values (not defaults) — proving the `useEffect` re-sync in Step 3 works.
6. Open a real quotation's document modal (create one first) and confirm it now reflects the saved custom style, closing the loop end-to-end.
7. Click "↺ คืนค่าเริ่มต้น", confirm the success alert, confirm sliders revert to `DEFAULT_DOCUMENT_STYLE` values, and confirm `document_style` is `NULL` in the DB (not an object equal to the defaults — per the spec's explicit reset-behavior requirement).
8. Confirm a WORKER or ADMIN test user (create one via role update, matching this session's established `UPDATE user_roles SET role = ...` pattern) cannot reach the `settings` tab at all (the existing `minRole:'OWNER'` gate — this is a regression check, not new behavior, but worth confirming this plan didn't accidentally weaken it).
9. Clean up the test tenant(s) fully, verify 0 rows left.

- [ ] **Step 9: Commit and push**

```
feat: add OWNER-only document style customizer to Settings

New "🎨 รูปแบบเอกสาร" card: a slider/color-picker panel for every
tunable value in DEFAULT_DOCUMENT_STYLE, next to a live preview (a
real QuotationPaper instance fed the tenant's real company info plus
sample document content) that updates as controls change, before
Save. Save persists to tenants.document_style; Reset clears it back
to NULL (not a copy of today's defaults, so future default changes
keep applying to reset tenants). No new role check needed -- the
Settings page itself is already OWNER-gated at the routing layer.

Spec: docs/superpowers/specs/2026-09-04-document-style-customizer-design.md

Verified live: live preview updates on slider change with no reload,
Save persists exact values and a real document reflects them, Reset
clears to NULL and reverts the panel, and the existing OWNER-only tab
gate still blocks ADMIN/WORKER test users.
```

```bash
git add src/pages/Settings.jsx src/pages/Quotations.jsx
git commit -F <temp-file-path>
git fetch origin main && git log HEAD..origin/main --oneline
git push origin worktree-quotation-module:main
```

---

## Post-Plan Note

This plan does not touch `PurchaseOrders.jsx`'s document view or
`WorkPhotosDocumentModal` — neither uses `QuotationHeader`/`DocumentHeader`
or reads `tenant.document_style`, and extending the customizer to them is
out of scope (not requested).
