# Document Style Customizer — Design

**Status:** Approved by user (chat design, 2026-09-04). Ready for implementation planning.

## Goal

Give a tenant's OWNER a live, visual way to tune the Quotation/Invoice/Receipt
document header's appearance (logo size, fonts, spacing, colors, column
split) from Settings, persisted per-tenant — replacing the fixed values
`QuotationHeader`/`DocumentHeader` currently hardcode. This also fixes a real
shipped bug: today's logo sizing has no height cap (stretches to match
whatever height the adjacent text block happens to be), which looks
disproportionate for a portrait-oriented logo file next to a full 4-line
text block — the new default value set includes a sane cap, so tenants who
never open the customizer still see a better result than today's.

## Background

This is a follow-on to `docs/superpowers/specs/2026-09-04-document-header-pagination-design.md`
(shipped: new header layout + real multi-page pagination for
`QuotationPaper`/`DocumentPaper`), which explicitly listed "a live
style-customizer UI in Settings" as a Non-Goal to revisit later. That spec
also established the two components' current header code
(`QuotationHeader` in `src/pages/Quotations.jsx`, `DocumentHeader` in
`src/pages/Invoices.jsx`) and the shared pagination hook
(`src/hooks/usePaginatedDocument.jsx`, exporting `PAGE_WIDTH_PX`,
`PAGE_PADDING_V_PX`/`PAGE_PADDING_H_PX`/`PAGE_PADDING_CSS`,
`TABLE_MARGIN_TOP_PX`, `PAGE_HEIGHT_PX` — geometry constants that MUST drive
both the hook's hidden measurement pass and each consumer's real render
identically, a hard-won invariant from that spec's own implementation
(two real bugs shipped and fixed when this drifted).

## Non-Goals

- **Per-document-type independent styling.** One shared style config applies
  to both Quotation and Invoice/Receipt. (User confirmed.)
- **Paper size selection.** A4 stays fixed and non-configurable — it already
  is, structurally: `downloadPDF` (`src/lib/pdf.js`) hardcodes
  `jsPDF: { format: 'a4' }`, and the pixel-based page width has always been
  an on-screen/measurement proxy for that, not an independent paper-size
  setting.
- **ADMIN access.** OWNER role only, matching this app's existing
  OWNER-only precedent for company-identity settings (e.g. user
  management).
- **Reusing the dev-time visual-companion browser tool in production.** That
  tool is session-only, writes nothing to disk, and runs its own Node
  server outside the Vite app — it was the design *prototype*, not
  something the shipped feature depends on. The shipped customizer
  re-implements the same slider pattern as real React state + controlled
  inputs inside the Settings page.

## Data Model

One nullable JSONB column:

```sql
ALTER TABLE tenants
  ADD COLUMN document_style JSONB;
```

`NULL` means "use defaults" — a tenant who never opens the customizer is
unaffected structurally (no row-shape migration needed for existing
tenants) and gets the new, better-capped default values.

## Shared Style Module

New file: `src/lib/documentStyle.js`. Two exports:

**`DEFAULT_DOCUMENT_STYLE`** — every currently-hardcoded value, as one flat
object, PLUS the new `logoMaxHeight` cap (today's shipped code has no
equivalent — this is the fix):

```js
export const DEFAULT_DOCUMENT_STYLE = {
  accent: '#6c63ff',
  pagePaddingV: 40, pagePaddingH: 44,
  logoWidth: 110, logoMaxHeight: 64, logoGap: 20,
  nameSize: 18, addressSize: 12, contactSize: 12, titleSize: 28,
  headerRowGap: 25, contactLineGap: 6,
  clientInfoOffset: 17, docInfoBoxOffset: 17,
  splitRatioClient: 66, // doc-info box gets 100-this, both in fr units
  infoSize: 12,
  tableHeaderBg: '#f4f4f6', tableHeaderColor: '#4a4d63', tableHeaderSize: 12,
  tableHeaderPadding: 11, tableHeaderBorder: 2, tableHeaderBold: true,
  showContactIcons: true, showRevisionSuffix: true,
}
```

(Field names/values above are the concrete starting point; the
implementation plan may adjust exact key names to match the current code's
own variable names one-for-one, but the VALUES must equal what's currently
hardcoded, except `logoMaxHeight` which is new.)

**`resolveDocumentStyle(overrides)`** — `{ ...DEFAULT_DOCUMENT_STYLE, ...(overrides || {}) }`,
a flat shallow merge (sparse per-field override, not deep/nested — every
value above is a primitive, so shallow merge is sufficient and keeps the
customizer's "one slider = one changed key" mental model simple). Called
once per render in each consuming component and in the customizer itself.

## Consuming Components

`QuotationHeader`, `DocumentHeader`, `QuotationPaper`, `DocumentPaper` each
call `resolveDocumentStyle(tenant?.document_style)` once and use the
resolved object's values instead of today's hardcoded numbers/strings —
mechanical substitution, no structural change to these components' JSX
shape.

**Logo cap, specifically** (the bug fix): the existing decoupled
absolute-position stretch technique (`position:relative` wrapper +
`position:absolute; inset:0; height:100%` image, established to dodge a
flexbox circular-sizing bug) gains `maxHeight: style.logoMaxHeight` on the
wrapper. `objectFit:contain` already preserves aspect ratio within
whatever box it's given — a height cap means a short text block still lets
the logo grow to fill available height (today's "stretch to match" intent,
preserved), but a tall block can no longer inflate the logo past a sane
size.

**Pagination hook integration**: `usePaginatedDocument` currently reads its
geometry from module-level exported constants. It gains equivalent
optional parameters (e.g. `pageWidth`, `pagePaddingCss`, `pagePaddingV`,
`tableMarginTop`, `pageHeight` — falling back to the existing exported
constants when a consumer doesn't pass them, so the hook's own default
behavior is unchanged for any caller that doesn't opt in). `QuotationPaper`/
`DocumentPaper` pass their `resolveDocumentStyle(...)` result's relevant
fields through to the hook call, so the SAME per-tenant resolved values
drive both the hidden measurement pass and the real page-div render — the
spec this design is a follow-on to established why this single-source
requirement is non-negotiable (a past drift here shipped two real bugs).

## Settings UI

New card in `src/pages/Settings.jsx`. No new role check needed inside the
component: the "ทั่วไป" tab that routes to this whole page is already
`minRole: 'OWNER'` in `src/App.jsx`'s `TABS` array, and tab access is
enforced at the routing layer (not just nav-link hiding — confirmed via
`App.jsx`'s `isAtLeast(tab.minRole)` gate, which a comment there notes was
previously a real gap and has since been fixed to actually block the page
render, not just the nav entry). ADMIN/WORKER cannot reach this page at
all, so the new card is automatically OWNER-only by being on this page.

**Layout**: a control panel (the proven slider set — page padding, logo
width/gap/max-height, every font size, every spacing value, the
client/doc-info column split ratio, table-header background/text-color/
font-size/padding/border-width, a bold toggle, an accent color picker, a
contact-icons visibility toggle, a revision-suffix visibility toggle) next
to a **live preview pane**: a real `QuotationPaper` instance, rendered with
fixed placeholder sample data (a representative fake company/client/items —
not live tenant data, so the preview is stable and doesn't depend on the
tenant having any real quotations), re-rendering as sliders change via
local component state (not persisted until Save).

**Controls**:
- Each slider/color-picker/toggle updates local state immediately (instant
  preview feedback, matching the proven prototype's UX).
- **"💾 บันทึก"** — persists the current local state as `tenants.document_style`
  via `supabase.from('tenants').update({ document_style: {...} })`.
- **"↺ คืนค่าเริ่มต้น"** — resets local state to `DEFAULT_DOCUMENT_STYLE` AND
  persists `document_style: null` (not an object equal to the defaults —
  `NULL` is the actual "use defaults" state, so a future change to
  `DEFAULT_DOCUMENT_STYLE` itself continues to apply to tenants who reset,
  rather than freezing them on today's default values forever).
- On mount, local state initializes from `resolveDocumentStyle(tenant?.document_style)`
  (today's saved customization, or defaults if none).

## Testing / Verification Plan

Same live-verification norm as the rest of this session:
1. Migration: dry-run, apply live, write migration file, update
   `supabase/schema.sql`.
2. Build, throwaway test tenant, verify: (a) a fresh tenant with no
   `document_style` renders documents using `DEFAULT_DOCUMENT_STYLE` —
   specifically confirm the logo no longer exceeds `logoMaxHeight` even
   with a tall multi-line address block (the original bug); (b) OWNER role
   sees the new Settings card, ADMIN/WORKER do not; (c) moving sliders
   updates the live preview without saving; (d) Save persists to the DB
   and a subsequent real Quotation/Invoice document render reflects the
   saved values; (e) Reset clears `document_style` to `NULL` and the
   document render reverts to defaults; (f) multi-page pagination still
   works correctly with a customized (non-default) padding/font-size
   combination — construct a long item list under a customized style and
   confirm page count/footer placement is still correct, since this is
   the exact class of bug the geometry-constants invariant exists to
   prevent.
3. Full cleanup of the test tenant afterward, commit + push directly to
   `main` (this session's established workflow, no PR).
