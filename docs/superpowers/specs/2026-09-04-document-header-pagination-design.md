# Document Header Redesign + Real Pagination — Design

**Status:** Approved by user (interactive brainstorming session, 2026-09-04). Ready for implementation planning.

## Goal

Redesign the header of `QuotationPaper` (Quotations.jsx) and `DocumentPaper`
(Invoices.jsx, shared by Invoice + Receipt) to match a reference document the
user provided, and add real multi-page pagination so long item lists split
correctly across pages — with the full header repeated on every page — for
on-screen preview, `window.print()`, and PDF export. JPG export stays
single-page-only (see Non-Goals).

## Background

Both components currently render as a single continuous flowing `<div>` with
no page-break logic:
- On-screen preview: rendered directly inside a modal.
- Print: `window.print()` + a global `@media print` CSS block that isolates
  `.printable-document`.
- PDF: `downloadPDF()` (`src/lib/pdf.js`) via `html2pdf.js`, which
  auto-paginates a tall div but has no page-number awareness.
- JPG: `downloadJPG()` via `html2canvas`, captures ONE canvas scaled into a
  single A4-proportioned image — structurally cannot represent multiple pages.

`WorkPhotosDocumentModal` (also in Invoices.jsx) is the one existing
multi-page precedent: it pre-chunks photos into fixed-size arrays, renders one
fixed-height page div per chunk with explicit `pageBreakAfter`/`breakAfter`
CSS, and only renders its signature block on the last page (`isLast` flag +
`flex:1` spacer). Its page height is deliberately 270mm, not the true 277mm
printable area, to dodge an empirically-found `html2pdf.js` page-break-modulo
bug that inserted blank pages when a page div's height exactly matched the
physical page height.

Both `QuotationPaper` and `DocumentPaper` were edited in this same session
(commits `dbfec30`, `901293a`) to add a `minHeight`/flex-column/`flex:1`-spacer
pattern that pushes the signature to the bottom of one simulated A4 page, and
a decoupled absolute-positioned logo (`position:relative` wrapper +
`position:absolute; inset:0` image) that stretches to match the header text
block's height without triggering a flexbox circular-sizing bug (the image's
own natural pixel dimensions otherwise leak into the layout's hypothetical
sizing pass). That logo-sizing mechanism is unchanged by this design — only
the surrounding layout (gaps, contact block, column split) changes.

## Non-Goals

- **JPG multi-page support.** Confirmed with the user: when a document spans
  more than one page, `downloadJPG()` stays disabled (with a tooltip pointing
  at PDF) rather than exporting multiple files. Single-page documents keep
  today's JPG behavior unchanged.
- **A live style-customizer UI in Settings.** The user liked the interactive
  slider-based tuning tool used during this design session and asked about
  making it a real product feature. That's a separate, out-of-scope idea —
  tracked as a memory note (`project_document_style_customizer_idea`), to be
  brainstormed as its own project later.
- **PurchaseOrders' document view.** Not part of this design; PO documents
  keep their existing header/layout untouched.

## Data Model Changes

Add two nullable columns to `tenants`, following the exact pattern of the
existing `address`/`tax_id`/`phone` columns added by
`2026-08-22-01-tenant-company-profile.sql`:

```sql
ALTER TABLE tenants
  ADD COLUMN email   TEXT,
  ADD COLUMN website TEXT;
```

`Settings.jsx`'s existing "🏢 ข้อมูลบริษัท" card gets two more inputs for
these, same state/onChange/save pattern as the fields already there.

No other schema change is needed:
- "โครงการ" (project) sources from `quotations.sites(name)` / `invoices.sites
  (name)`, both already joined by `useQuotations`/`useInvoices`. It reads `—`
  until a quotation is accepted and linked to a site (existing behavior,
  matches the list-view column).
- Revision number is folded into the document-number display as a suffix
  (`QT-2026-047-R3`), computed client-side from the existing `revision`
  column — no new column.

## Header Layout

Applies identically to `QuotationPaper` and `DocumentPaper`. All measurements
below are the values locked in during interactive tuning; treat them as the
starting values for the CSS, not user-adjustable at runtime (no in-app style
customizer — see Non-Goals).

**Page padding:** 40px vertical, 44px horizontal (unchanged from current).

**Header row** (flex, `align-items: stretch`, `gap: 25px`):
- **Left column** (flex, `gap: 20px` between logo and text):
  - Logo: existing decoupled-stretch mechanism, wrapper width 110px, height
    stretches to match the text column via the `position:absolute` technique
    already shipped. No-logo placeholder: 40×40 solid box, unchanged.
  - Text column: company name (18px, weight 800) → address (12px, `#6a6f85`,
    line-height 1.6, wraps naturally, typically 2 lines) → tax ID line (12px,
    `#6a6f85`) → **contact line** (12px, `#4a4d63`, margin-top 6px from the
    tax ID line — directly under the address block, not a separate column):
    single line `📞 {phone}   ✉️ {email}   🌐 {website}`, each segment
    conditionally rendered only when that tenant field is set (same
    "only show what's filled in" pattern as the existing address/tax-id/phone
    concatenation).
- **Right column** (`text-align: right`): page-number line (`หน้า {n}/{total}`,
  12px, `#6a6f85`) → ต้นฉบับ/สำเนา tag (unchanged styling) → document title
  (28px, weight 800).

**Client info / doc-info row** (`margin-top: 17px` from the header row;
`display: grid; grid-template-columns: 66fr 34fr; gap: 20px`, **`fr` units,
not percentages** — `fr` tracks are spec-guaranteed to divide available width
after subtracting the gap, so the right column's edge always lands exactly on
the page's right margin; percentage tracks have edge-case drift risk):
- **Left (client info), independent vertical position** — inline
  `label : value` format, line-height 2: `ลูกค้า : {name}` (name bold) /
  `ที่อยู่ : {address}` / `เลขที่ภาษี : {tax_id}`.
- **Right (doc-info box), independent vertical position** (own
  `margin-top`, separate from the client-info column's offset — moving one
  must never move the other): bordered box (`#e4e6ef`, radius 8px, padding
  14px/16px), 2×2 grid, 12px text: **เลขที่เอกสาร** (document number, with
  `-R{revision}` suffix appended in the *same* plain bold black text — not
  accent-colored — only when `revision > 1`) / **วันที่ออก** / **ใช้ได้ถึง** /
  **โครงการ** (site name or `—`).

**Item table:** `margin-top: 18px` from the row above. Header cells: 12px
text, weight 700 (bold — up from the current unstyled/normal weight),
background `#f4f4f6`, text color `#4a4d63`, vertical padding 11px (up from
9px), `border-bottom: 2px solid {accent}`.

**Accent color:** a single source of truth (`#6c63ff`, matching the existing
brand purple already used elsewhere in the app — no new configurability)
applied consistently to: the ต้นฉบับ/สำเนา tag border+text, the item-table
header's bottom border, and the totals row's border+text. Explicitly **not**
applied to the revision suffix (plain black, see above) and not applicable to
the logo itself (real logos are tenant images; the accent only colors the
no-logo placeholder box, as today).

## Pagination Mechanics

Two-pass render, same spirit as `WorkPhotosDocumentModal`'s existing
precedent but height-driven instead of count-driven, since item rows
(item / note / item_description) vary significantly in rendered height:

1. Item rows mount once in a hidden (`visibility:hidden; position:absolute`)
   measurement pass with refs on each row.
2. `useLayoutEffect` reads each row's real rendered height via
   `getBoundingClientRect()` — this is what makes Thai text wrapping (which a
   static estimate can't predict) measure correctly.
3. Greedily bucket rows into pages against a fixed available content height:
   **960px** total page height — a deliberate ~4% shorter than the
   already-shipped 1000px single-page `minHeight` from commits `dbfec30`/
   `901293a`, mirroring `WorkPhotosDocumentModal`'s own 270mm-vs-277mm safety
   margin against the same `html2pdf.js` page-break modulo bug (a page div
   whose height exactly matches the physical page height can trigger a
   spurious blank page) — minus the full header block's height (measured
   once, since
   **the complete header repeats on every page** — confirmed explicitly by
   the user, overriding an earlier draft that proposed a slimmer continuation
   header) minus the item-table's own header-row height (also repeats on
   every page).
4. Final render is N page `<div>`s, each with the complete header (logo,
   contact block, doc-info/client-info boxes — page number in the corner
   updates per page: `หน้า 1/2`, `หน้า 2/2`, ...) followed by that page's
   item-row slice, with explicit `pageBreakAfter`/`breakAfter` CSS between
   pages (same as `WorkPhotosDocumentModal`). Only the **last** page renders
   totals, notes, bank-account block, and the signature row (same `isLast`
   pattern, reusing the already-shipped `flex:1`-spacer-to-bottom mechanism
   from this session's earlier commits).
5. On-screen preview: pages render stacked with a visible gap/shadow between
   them so multi-page is legible inside the modal.
6. `window.print()`: same DOM, same explicit breaks — the browser paginates
   identically to preview since nothing changes between the two.
7. PDF (`downloadPDF()`): unchanged call site: `html2pdf.js` now correctly
   produces one physical page per page-div because the explicit breaks drive
   it, the same mechanism already proven for `WorkPhotosDocumentModal`.
8. JPG (`downloadJPG()`): gains a page-count guard. When the computed
   `pages.length > 1`, the JPG option in the ต้นฉบับ/สำเนา + save dropdown is
   disabled with a tooltip directing the user to PDF. Single-page documents
   (the common case) are unaffected.

## Testing / Verification Plan

Same live-verification norm as the rest of this session:
1. Build (`npx vite build`).
2. Throwaway test tenant (exact `auth.users`/`auth.identities` insert
   pattern used throughout this session), with `email`/`website` set so the
   contact line's full 3-segment case is exercised.
3. Two quotations: one short (fits one page, confirms JPG stays enabled and
   the single-page layout matches the tuned design) and one long (enough
   `item`/`item_description`/`note` rows to force 2+ pages, confirms: header
   repeats in full on every page with the correct `หน้า N/M`, totals/
   signature only appear on the last page, JPG option disables, PDF produces
   the correct page count).
4. Playwright screenshots of: the on-screen modal preview (both documents),
   print-media emulation, and the downloaded PDF's page count. Also verify
   the revision suffix appears correctly (`-R3`) on an edited-after-sent
   quotation, and reads plain (no suffix) on a still-draft one.
5. Repeat the multi-page case for at least one Invoice (via `DocumentPaper`)
   to confirm the shared component behaves identically for that document
   type, per the "roll out to all three now" scope decision.
6. Full cleanup of the test tenant afterward (tenants/user_roles/
   app_settings/audit_logs/document_prints, in FK-dependency order, verified
   with a final 0-row count query).
7. Commit + push directly to `main` per this session's established workflow
   (no PR).
