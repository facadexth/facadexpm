# Mobile view — round 2 (every remaining page) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every remaining page of changpm.app is usable on a phone (≤ 900 px), the site-detail page stops being one very long scroll, and Gantt / S-curve / the assign week grid can be viewed landscape, while laptop and landscape-tablet rendering stays identical.

**Architecture:** Reuse the round-1 primitives (`useIsPhone`, `src/mobile.css`, `CardTable`, `PhoneFilters`, `MoreActions`, `.phone-chips-row`). Add three small pieces: `siteShortName()` + an optional `sites.short_name` column, `<LandscapeView>` (phone-only "⤢ ดูแนวนอน" full-screen viewer that rotates 90° on a portrait phone and opens by itself when the phone is turned), and `<PhoneSection>` (phone-only collapsible block). Pages then get wrapper swaps.

**Tech Stack:** React 18, plain CSS, vitest + jsdom (+ @testing-library/react), Supabase Postgres.

**Spec:** `docs/superpowers/specs/2026-10-15-mobile-view-design.md` (§4–§8 round 2) plus the owner's decisions on the round-2 mockup https://claude.ai/artifact/4gC6gw6NpLkkoEiheJevws (2026-10-17):
- Site detail overview: key numbers in a 2-column grid; quotation billing, deposit, retention and the category chart collapse into sections with a summary in the heading (quotation section open by default).
- Gantt, S-curve and the assign week grid: a "⤢ ดูแนวนอน" button, and turning the phone opens the same landscape view automatically. iPhone cannot be forced to rotate, so the content is rotated 90° in a full-screen overlay when the phone is portrait.
- Assign week grid on phone: day cells show the site's short name, not the site code.
- Site short name: automatic from the full name now, plus an optional field to set it by hand.

## Global Constraints

- Every new CSS rule lives in `src/mobile.css` inside its single `@media (max-width: 900px) { … }` block; `src/mobile.css.test.js` must stay green. `src/index.css` is not edited.
- Every JSX change is gated: `isPhone ? <phone/> : <original/>`, or a wrapper whose desktop branch returns `children` unchanged. Desktop DOM stays identical: no new elements, classes or inline styles on desktop. Allowed on shared elements: `inputMode`, `aria-*`, `data-*` attributes only.
- Exception (owner-requested feature, visible on desktop too): the "ชื่อย่อ" input in the site add/edit form (Task 1).
- `CardTable` replaces `<div className="table-wrap">` 1:1; give a `map` only where inference picks the wrong title/amount (see `src/lib/cardTable.js`).
- Thai UI text. Commits via `git commit -F <file>`; every commit message ends with:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_0139hUNtVFb4DkimmJ3YCSGW`.
- `npx vitest run` green and `npm run build` passing before every commit. Never deploy, never apply migrations, never push (the controller does those).
- Live DB is CHANG `kntspldhvcjeaubtqtkn`; Tokyo `yyzbgdmgyvvypfcjuhtr` is never touched.

## Review Focus

1. Desktop unchanged: any page touched must render the same DOM at > 900 px (wrappers return children; no stray class/style). Tests for new primitives assert the desktop branch returns the child itself.
2. `siteShortName` with Thai combining marks: truncation must not split a grapheme (e.g. cut between "ศ" and "ู"). Test with `Intl.Segmenter`-based slicing.
3. `LandscapeView` open + phone back button closes the overlay, does not leave the page; rotating the phone back to portrait while open keeps it open (only ✕/back closes).
4. CardTable on tables with expandable sub-rows or `colSpan` group rows: those rows must render as plain rows, not broken cards (existing `data-empty` handling) — check Inventory and Payroll specifically.
5. Assign grid short names: a site with `short_name` set shows it; `ส่วนกลาง` (is_default) shows its own name; desktop still shows the old label.

---

### Task 1: Site short name (column, helper, form field)

**Files:**
- Create: `supabase/migrations/2026-10-17-03-site-short-name.sql`
- Create: `src/lib/siteShortName.js`, `src/lib/siteShortName.test.js`
- Modify: the site add/edit form in `src/pages/Sites.jsx` (find the form that edits `name`, `site_number`)

**Interfaces:**
- Produces: `siteShortName(site: {name?: string, short_name?: string|null}, max = 14): string`, `autoShortName(name: string, max = 14): string`.

- [ ] **Step 1: Migration (do NOT apply)**

```sql
-- 2026-10-17-03: optional hand-set short name for a site (phone assign grid etc.).
-- NULL = use the automatic short name (src/lib/siteShortName.js).
ALTER TABLE public.sites ADD COLUMN IF NOT EXISTS short_name text;
ALTER TABLE public.sites DROP CONSTRAINT IF EXISTS sites_short_name_len;
ALTER TABLE public.sites ADD CONSTRAINT sites_short_name_len CHECK (short_name IS NULL OR char_length(short_name) <= 30);
```
Also grep `supabase/migrations` for views built with `s.*` / `sites.*` over `sites` (memory: view column lists freeze). If the app reads `short_name` through such a view, re-create that view in this migration with the same definition; otherwise read it from `sites` directly. Write down in the commit message which path you took.

- [ ] **Step 2: Failing tests** in `src/lib/siteShortName.test.js`:
  - `siteShortName({ name: 'x', short_name: '  ศูนย์ฯ ' })` → `'ศูนย์ฯ'`
  - empty/whitespace `short_name` falls back to auto.
  - `autoShortName('โครงการศูนย์เวชศาสตร์นิวเคลียร์และศูนย์รังษีรักษา')` → starts with `'ศูนย์เวชศาสตร'`, ends with `'…'`, at most 14 graphemes before `'…'`, and never ends on a dangling combining mark (assert the last grapheme before `…` equals itself segmented).
  - leading `โครงการ`, `งาน`, `บริษัท` removed; trailing `(…)` removed; `จำกัด`/`(มหาชน)` removed.
  - first whitespace-separated word kept when ≤ max (`'คอนโด สุขุมวิท 77'` → `'คอนโด'`)… unless that word is shorter than 4 graphemes, then keep words while total ≤ max (`'บ้าน คุณสมชาย'` → `'บ้าน คุณสมชาย'` if ≤ 14).
  - `ส่วนกลาง` → `ส่วนกลาง`; `''`/null → `''`.
- [ ] **Step 3: Implement** with `Intl.Segmenter('th', { granularity: 'grapheme' })` for counting/slicing (fallback `Array.from` when Segmenter is missing).
- [ ] **Step 4: Form field** — in the site form add an optional input "ชื่อย่อ (ไม่บังคับ)" bound to `short_name`, `maxLength={30}`, placeholder = `autoShortName(current name)` so the user sees what the automatic name would be. Save `''` as `null`. Make sure the save path (insert/update in `useSupabase.js` or the page) passes `short_name` through.
- [ ] **Step 5:** `npx vitest run`, `npm run build`, commit `feat(sites): optional short name + automatic short name helper`.

---

### Task 2: `LandscapeView` and `PhoneSection` primitives

**Files:**
- Create: `src/components/LandscapeView.jsx`, `src/components/LandscapeView.test.jsx`
- Create: `src/components/PhoneSection.jsx`, `src/components/PhoneSection.test.jsx`
- Modify: `src/mobile.css`

**Interfaces:**
- Produces: `<LandscapeView title: string, children>`; `<PhoneSection title: ReactNode, summary?: ReactNode, defaultOpen?: boolean, children>`.

`LandscapeView`:
- Desktop: `return children` (no wrapper; test asserts `container.firstChild` is the child).
- Phone: renders a right-aligned button `⤢ ดูแนวนอน` (class `btn btn-ghost btn-sm phone-landscape-btn`) above `children`. When open, a portal to `document.body`: `.phone-landscape-overlay` (fixed, inset 0, z-index 400, bg var(--bg)) containing `.phone-landscape-stage`. Header bar inside the stage: title + ✕ button (aria-label "ปิดมุมมองแนวนอน"). The same `children` render inside the stage (they are rendered once: while open, the inline copy shows a small placeholder "กำลังดูแนวนอน" instead of the children so charts with ids don't duplicate).
- Rotation: if `matchMedia('(orientation: portrait)').matches`, the stage gets class `is-rotated`: `width:100vh; height:100vw; transform: rotate(90deg) translateY(-100%); transform-origin: top left; position:absolute; top:0; left:0` (use `100dvh`/`100dvw` where supported). In landscape no rotation (stage = 100% × 100%). Listen to the orientation media query and re-evaluate.
- Auto-open: while mounted on phone, when orientation changes to landscape AND the new viewport height is < 500 px (a phone turned sideways) → open. Do NOT auto-open when the landscape viewport is 500 px or taller: an unfolded foldable (e.g. Pixel Fold inner screen) is landscape and roomy, and unfolding must not pop the overlay (owner question 2026-10-17). The button still opens it. Turning back to portrait while open keeps it open (now rotated). Test both: height 390 → opens; height 700 → stays closed.
- Best effort on open: `document.documentElement.requestFullscreen?.()` then `screen.orientation?.lock?.('landscape')`, both wrapped in try/catch and `.catch(() => {})`; on close `screen.orientation?.unlock?.()` and `document.exitFullscreen?.()` only if `document.fullscreenElement`.
- `useBackToClose(close)` while open; Escape closes.
- Tests (jsdom, mock matchMedia like `src/hooks/useIsPhone.test.js`): desktop returns child; phone shows button; click opens overlay with title and ✕; ✕ closes; portrait → stage has `is-rotated`; firing orientation landscape opens it.

`PhoneSection`:
- Desktop: `return children`.
- Phone: `<details className="phone-section" open={defaultOpen}><summary><span className="ps-title">{title}</span>{summary && <span className="ps-sum">{summary}</span>}</summary><div className="ps-body">{children}</div></details>`.
- Tests: desktop returns child; phone renders summary text and starts closed unless `defaultOpen`.

CSS (inside the media block): styles for `.phone-landscape-btn`, overlay, stage, header, `.phone-section` (bg2, border, radius 12, summary grid `1fr auto 14px` with ▸/▾ marker, body padding), matching the mockup.

- [ ] Steps: failing tests → implement → CSS → `npx vitest run` + build → commit `feat(mobile): LandscapeView and PhoneSection primitives`.

---

### Task 3: Site detail page on phone

**Files:**
- Modify: `src/pages/SiteDetail.jsx` (tab buttons row → `className="phone-chips-row"` only on phone, or add `data-phone="tabs"` and style it), `src/components/SiteOverviewContent.jsx`, `src/pages/sites/GanttView.jsx`, `src/pages/sites/SCurveChart.jsx` usage, `src/pages/sites/PhaseKanbanBoard.jsx`, `src/pages/sites/DailyReport.jsx` (check only), `src/mobile.css`.

- Overview (`SiteOverviewContent`, also used by `SiteOverviewModal`): on phone the first key-number grid (`form-grid-3`, 7 items) shows as 2 columns: add `data-phone="kpis"` and CSS `[data-phone="kpis"] { grid-template-columns: 1fr 1fr !important; gap: 6px }` with each item a small tile (bg2, border, radius 10, padding 6/9). Order on phone: มูลค่าสัญญา, % เบิก, รายรับ, รายจ่าย, กำไร, ค่าแรงพนักงาน, วันจบงาน (CSS `order` via `data-phone-order` attributes is fine).
- Each later block (quotation billing table, มัดจำ, Retention, category pie, and any other titled block in the file) on phone: `isPhone ? <PhoneSection title=… summary=… defaultOpen={quotation block}>{block without its own title div}</PhoneSection> : original`. Summaries: quotations = `เหลือเบิก <fmt(sum.remainingTotal)>`; deposit = `คงเหลือ <fmt(remaining_balance)>`; retention = status label; chart = `กราฟ`.
- Quotation billing table on phone: wrap in `CardTable` (title = เลขที่ใบเสนอราคา, amount = ยอดรวม) or render a phone card list — choose whichever keeps the totals row readable; the totals row must stay visible.
- Gantt: wrap the Gantt chart in `<LandscapeView title="Gantt · {site_number}">`. Inline on phone: horizontal scroll with the task-name column `position: sticky; left: 0` (find the name column element and add `data-phone="gantt-name"`), header row sticky top if it is not already.
- S-curve on the Gantt tab: phone → `<PhoneSection title="S-curve" summary={plan vs actual % if cheaply available, else 'กราฟ'}><LandscapeView title="S-curve">…</LandscapeView></PhoneSection>`.
- Kanban: columns in a horizontal row with `scroll-snap-type: x mandatory`, each column `flex: 0 0 85%` and `scroll-snap-align: start` (add `data-phone="kanban"` on the columns container). The unassigned-photos card above stays as is but its buttons wrap.
- Daily report: check at 390 px; fix only overflow (form-grid collapse is already global).
- [ ] Steps: implement → vitest + build → commit `feat(mobile): site detail overview sections, landscape Gantt/S-curve, kanban snap`.

---

### Task 4: Assign week grid on phone

**Files:** `src/pages/Assign.jsx`, `src/pages/assign/GridView.jsx`, `src/mobile.css`.

- Week view: wrap the grid in `<LandscapeView title="จัดคนงาน · สัปดาห์">`; inline phone view scrolls horizontally with the worker column sticky (`data-phone="assign-worker"`), day cells unchanged in size.
- Day cells on phone show `siteShortName(site)` instead of the site code/label (desktop keeps the current label). The sites data must include `name`, `short_name`, `is_default`; for `is_default` sites show `site.name`. Add `short_name` to the select the page uses (if it reads through a view, see Task 1 Step 1 notes).
- Day view: unchanged.
- [ ] Steps: implement → vitest (add a small test if the label choice is a pure function) + build → commit `feat(mobile): assign week grid sticky + landscape + short site names`.

---

### Task 5: Money pages

**Files:** `src/pages/Expenses.jsx`, `Income.jsx`, `Cheques.jsx`, `Deposits.jsx`, `Retention.jsx`, `SupplierTaxInvoices.jsx`, `SupplierCreditNotes.jsx`, `Invoices.jsx` (list), `PurchaseOrders.jsx` (list), `LaborContractors.jsx`, `Payroll.jsx`, `src/mobile.css` if needed.

For each page: every `<div className="table-wrap">` → `<CardTable map={…only if needed}>` (import from `../components/CardTable.jsx`); filter blocks with more than 3 controls → `<PhoneFilters count summary onClear>` around the filter controls only (search box and primary button stay outside; `count` = number of non-default filters, `summary` = chips with `onRemove` resetting that filter); secondary toolbar buttons (Import, Template, Export, PEAK, …) → `<MoreActions>`. Follow how `src/pages/Quotations.jsx` and `src/pages/Sites.jsx` did it in round 1. Expense/income amounts keep their colour classes.
- [ ] Steps: one page at a time; after all, vitest + build → commit `feat(mobile): money pages as cards with filter sheet`.

---

### Task 6: Inventory, catalogue and estimation pages

**Files:** `src/pages/Inventory.jsx` (10 tables + sub-tab strip → chips), `BomTemplates.jsx`, `CatalogItems.jsx`, `AluminumProfiles.jsx`, `Estimation.jsx`, `Categories.jsx`.

- Inventory sub-tab buttons → horizontal chip strip on phone (`data-phone="tabs"` + CSS, or `.phone-chips-row` on phone only). Stock-card charts full width. All tables → `CardTable` (stock balance: title = item, amount = มูลค่า; movements: title = date/doc, amount = qty or value — pick by headers). Filters → `PhoneFilters` where > 3 controls.
- [ ] Steps: implement → vitest + build → commit `feat(mobile): inventory, catalogue, estimation pages`.

---

### Task 7: HR, people, settings and admin pages + shared components

**Files:** `src/pages/HR.jsx` (7 tables, sub-tabs → chips, check-in map unchanged), `UserManagement.jsx`, `Suppliers.jsx`, `Clients.jsx`, `Settings.jsx`, `CommunicationCenter.jsx`, `TenantManagement.jsx`, and components `TaxInvoicePreview.jsx`, `SupplierTaxInvoiceForm.jsx` (line items like the round-1 quotation form: `line-items`/`line-item` classes), `PackageComparison.jsx`, `ExcelUpload.jsx`.

- Same rules as Task 5. Approve/delete buttons stay in the card footer (`actions` role).
- [ ] Steps: implement → vitest + build → commit `feat(mobile): HR, people, settings, admin pages`.

---

### Task 8 (controller): verification, version, deploy prep

- Whole-branch review (most capable model) against this plan + spec.
- Phone screenshots at 390 px of every page group, and the layout fingerprint at 1440 / 1024 (`scripts/layout-fingerprint.browser.js` + `scripts/layout-fingerprint-diff.mjs`) — diff must be empty.
- Dry-run migration 2026-10-17-03 in a rolled-back transaction; apply only after the owner says so; it must be applied BEFORE the web deploy (the form saves `short_name`).
- Version 1.20.51 + Thai changelog entry; deploy only after the owner says so.
