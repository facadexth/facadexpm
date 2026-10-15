# Mobile view (จอมือถือ) — design spec

Date: 2026-10-15. Owner decisions taken from the mockup
(https://claude.ai/artifact/KU6WQ4ACGXaKncJKN7hXih): drawer menu (A),
card-per-row tables (A), round order as proposed, portrait tablets are
NOT protected (they get the phone layout too).

## 1. Goal

Every role can use every page of changpm.app on a phone as fully as on a
desktop: navigate, read lists, filter, open details, fill forms, approve.
Worker-facing LINE flows and the field form are already mobile and are
out of scope. Printing/PDF is unchanged.

## 2. Constraint 1 (binding): laptop and landscape tablet never change

"ห้ามทำให้หน้า laptop / tablet เสีย". Enforced three ways, all required:

1. **One breakpoint, one file.** All phone CSS lives in `src/mobile.css`
   and the whole file is wrapped in a single
   `@media (max-width: 900px) { … }` block. A vitest test
   (`src/mobile.css.test.js`) parses the file and fails if any rule sits
   outside that block or if any other media query appears in it.
   `src/index.css` is not edited by this work except to `@import` nothing
   (mobile.css is imported from `main.jsx` after index.css).
2. **One hook, original JSX on desktop.** `useIsPhone()`
   (`src/hooks/useIsPhone.js`) returns
   `matchMedia('(max-width: 900px)').matches` and updates on change. Every
   JSX change in this work is `isPhone ? <PhoneThing/> : <original JSX/>`
   or a wrapper component whose desktop branch returns `children`
   unchanged (a Fragment, no extra element, no extra class). Desktop DOM
   therefore stays identical. Attributes that do not affect layout
   (`inputMode`, `aria-*`, `data-*`) are the only additions allowed on
   shared elements.
3. **Layout fingerprint before/after.** `scripts/layout-fingerprint.browser.js`
   is a browser snippet run through the Chrome tool in the owner's
   logged-in profile (demo tenant preferred), in a separate tab that
   embeds the live/preview app in iframes of width 1440 and 1024. For
   each page it records, for every element inside `header`, `nav` and
   `main` (first 3 `tbody` rows only, to ignore data drift): tag, class
   list, bounding rect rounded to 1 px, and these computed styles:
   display, position, width, height, padding, margin, font-size,
   flex-direction, grid-template-columns, overflow-x, white-space,
   visibility. The baseline is captured from main before round 1 and
   stored outside git (session scratchpad, copied to
   `docs/mobile-view/baseline/` only if the owner wants it in the repo).
   After each round the same script runs on the preview build and
   `scripts/layout-fingerprint-diff.mjs` prints every page/element that
   differs. A round cannot be deployed with a non-empty diff unless every
   difference is explained by data drift and the owner accepts it.

Widths: ≤ 900 px = phone layout (phones, portrait tablets 744–834 px).
> 900 px = untouched. Existing rules at 1024/900/600/420 px in
`index.css` keep applying exactly as today.

## 3. Shell (App.jsx)

Phone only (`isPhone`):

- **Header**: ☰ button, tenant logo or company name (ellipsis), bell.
  Email, date, 📖, theme and logout move into the drawer footer.
  Height 52 px, sticky (already inside `StickyChrome`).
- **Nav strip hidden**; replaced by a one-line breadcrumb under the
  header: `<group label> › <active tab label>` (group tabs) or just the
  tab label. Built from `visibleTabs` and `activeTab`.
- **Drawer** (`src/components/PhoneDrawer.jsx`): left panel 82 % width,
  overlay. Content, top to bottom: user email + role + company name;
  every entry of `visibleTabs` (same gates as desktop); a group row is an
  accordion header showing its badge (`badgeForTab`), expanded by tap,
  the active group starts expanded; sub-tabs show `pendingByTab` badges;
  then 📖 คู่มือ (opens the manual), theme toggle, ออกจากระบบ.
  Tap on a tab = same handler as the desktop nav
  (`sessionStorage.removeItem('chunk-reload-attempted'); setNavState({});
  setActiveTab(id)`) then the drawer closes. Overlay tap, ✕, Escape and
  the phone back button close it. Back-button behaviour reuses the
  history mechanism of `Modal.jsx`, extracted unchanged into
  `useBackToClose(onClose)` (`src/hooks/useBackToClose.js`); `Modal`
  keeps calling it so desktop behaviour is identical.
- Pending-focus from the bell/push keeps working: `navigateTo` is
  unchanged; `PendingFocusChip` is already responsive.
- `main` padding on phone: 12 px (already at ≤ 1024). No change.

## 4. Lists: table → cards (`src/components/CardTable.jsx`)

Pages keep their `<table>`; only the wrapper changes:
`<div className="table-wrap">` becomes `<CardTable map={…}>` which on
desktop renders exactly `<div className="table-wrap">{children}</div>`
(same element, same class, extra props none) and on phone renders the
same div with class `table-wrap card-table` plus a `useLayoutEffect` +
`MutationObserver` that, after every render, walks `thead th` and
`tbody tr > td` and sets on each cell `data-label` (header text with a
trailing sort glyph `↕ ↑ ↓ ⇅` removed) and one class from the map:

```js
map = {
  title:   'เลขที่',          // header text (exact) or column index; required
  amount:  'ยอด',             // right of title, bold, tabular-nums
  status:  'สถานะ',           // pill in the footer row
  sub:     ['ลูกค้า', 'ไซท์งาน'], // lines under the title, muted
  actions: 'last',            // 'last' = last column, or header text
  hide:    ['#'],             // not shown on the card
}
```

Cells not in the map render as `label: value` rows (two columns, label
muted). Card layout in `mobile.css`:

- `tr` = card (bg2, border, radius 12, padding 10/12, margin 8 0);
  `td` blocks; `.mc-title` and `.mc-amount` on the first line
  (grid 1fr auto); `.mc-sub` lines below in text2 12 px; generic rows as
  `display:grid; grid-template-columns: 38% 1fr`; footer line =
  `.mc-status` left, `.mc-actions` right (the existing RowActionsMenu /
  buttons unchanged).
- `thead` stays in the DOM and becomes a horizontal chip strip
  (`display:flex; overflow-x:auto`) so sortable headers keep working;
  non-sortable headers are hidden in the strip (`th` without a click
  handler gets `data-sortable="false"` from the hook; CSS hides it).
- Row `onClick` handlers keep working because cards are the same `tr`.
- Empty-state rows (one `td` with `colSpan`) render as a plain centred
  line (hook marks `data-empty`).
- `max-height: 560px` of `.table-wrap` is removed on phone (page
  scrolls instead).

Every table in the app gets a map in its round (section 8). A table with
no map yet still renders as the old scrolling table on phone (hook does
nothing without a map), so rounds can ship independently.

## 5. Toolbars and filters

- **`<PhoneFilters count summary onClear>`** (`src/components/PhoneFilters.jsx`):
  desktop returns `children` as-is. Phone renders a button
  `ตัวกรอง` with a badge `count` (number of active non-default filters,
  supplied by the page) that opens a bottom sheet containing `children`
  (the page's existing filter controls, unchanged), with ปิด /
  ล้างทั้งหมด buttons. `summary` is a list of `{label, onRemove}` chips
  shown under the toolbar for active filters. Pages wrap only the filter
  block; the search input and the primary button stay outside.
  Used on pages with more than 3 filter controls: Expenses,
  PurchaseOrders, Invoices, Quotations, Income, Cheques, Inventory
  (stock), HR tabs, SupplierTaxInvoices, SalesReport.
- **`<MoreActions>`** (`src/components/MoreActions.jsx`): desktop
  returns `children` as-is. Phone renders a `⋯` button that opens a
  small menu listing the children (Import Excel, Template, Export Excel,
  ส่งออก PEAK, …). The page's primary button stays outside and becomes
  full width (`.btn-primary` inside `.toolbar` → `flex:1` on phone).
- Date ranges: two inputs on one row (`grid 1fr auto 1fr` with the dash),
  never wrapping.
- Dashboard period buttons and page sub-tab strips (Inventory, HR,
  Settings already has a select) become a horizontal chip strip
  (`overflow-x:auto; white-space:nowrap`), no wrapping.

## 6. Forms and modals

- `Modal` on phone (CSS only): full screen (`width:100vw; height:100dvh;
  max-width:none; border-radius:0`), header sticky top, `.modal-footer`
  sticky bottom with the existing buttons stretched (`flex:1`).
  `ConfirmDialog` stays a centred small dialog (class `modal-confirm`
  added by `ConfirmDialog` only; desktop CSS has no rule for it).
- Full-page forms (QuotationForm, Invoice form, PO form, Expense form,
  Payroll): `form-grid-2/3/4` collapse to one column at ≤ 900 (the
  600-px rule already exists; `mobile.css` repeats it for 601–900).
  Line-item rows: the item row container gets class `line-items` (no
  desktop style) and on phone each row becomes a stacked card: name
  full width, then `qty × unit`, `price`, `total` on one 3-column grid,
  delete button top-right. Totals block full width under the items.
  Primary save/cancel row sticky at the bottom.
- Inputs: `font-size:16px` on phone (prevents iOS zoom), min height
  44 px for `.btn`, inputs and `tr` footer actions; number inputs get
  `inputMode="decimal"`; date inputs unchanged (native picker).
- `SearchableSelect` / `QuickAddSelect` dropdowns open as a bottom sheet
  with a search box on phone (component branch; desktop unchanged).

## 7. Page-specific rules (round 3)

- Site detail: Gantt = horizontal scroll with the task-name column
  sticky; S-curve full width; Kanban = columns at 85 % width with
  `scroll-snap-type: x mandatory`; phase/task tables → cards.
- Assign (week view): horizontal scroll with the worker column sticky,
  day cells unchanged; day view unchanged (already fits).
- HR: sub-tab strip; each table → cards; check-in map unchanged.
- Inventory: 11 tables → cards; stock-card charts full width.
- Communication Center: cards already; tables of commands → cards.

## 8. Rounds (each deploys on its own, each ends with fingerprint diff = empty, changelog + version bump)

| Round | Pages | Deliverables |
|---|---|---|
| 1 โครง | App shell, Dashboard, Sites (table), Quotations | `useIsPhone`, `mobile.css` + static test, `PhoneDrawer`, breadcrumb, `useBackToClose`, `CardTable`, `PhoneFilters`, `MoreActions`, Modal CSS, fingerprint scripts + baseline, maps for Sites and Quotations, QuotationForm line items |
| 2 เงิน | Invoices, Deposits, Retention, Income, SalesReport, Expenses, PurchaseOrders, Cheques, SupplierTaxInvoices, SupplierCreditNotes | maps + PhoneFilters on each, Invoice/PO/Expense forms |
| 3 งานหน้างาน | SiteDetail (Gantt, Kanban, S-curve, tables), Assign, HR (all tabs, Payroll), LaborContractors, Inventory, AluminumProfiles | section 7 |
| 4 ตั้งค่า/แอดมิน | Settings tabs, Categories, Clients, Suppliers, CatalogItems, UserManagement, CommunicationCenter, DocumentTemplatesAdmin, Estimation, BomTemplates, TenantManagement, LineAdminChat, StartingGuide | maps, sheets, chip strips |

Estimate: 2–3 days per round including review and live checks. The
primitives are built once in round 1; later rounds are mostly one map
per table plus one `PhoneFilters` per page.

## 9. Testing

- vitest: `useIsPhone` (matchMedia mock), `CardTable` (jsdom: desktop
  renders the bare div; phone sets `data-label`/classes; empty row;
  sort-glyph stripping; map by index and by header text; MutationObserver
  re-applies after rows change), `PhoneFilters`/`MoreActions` desktop =
  children only, `mobile.css` static test, `useBackToClose` behaviour
  identical to the current Modal tests (if none exist, write them first
  against the current Modal, then extract).
- Visual: phone frames at 390 px through the Chrome tool (iframe
  harness) for every page in the round, screenshots saved to the
  scratchpad and summarised to the owner; fingerprint diff at 1440 and
  1024 must be empty.
- Live: after each deploy the owner checks on a real phone: drawer,
  one list, one filter sheet, one form save (demo tenant).

## 10. Out of scope

Separate mobile app or subdomain; bottom tab bar; offline; worker LINE
flows; print/PDF layouts; redesign of desktop pages; touch gestures
beyond scroll/snap.
