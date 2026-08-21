# Quotation Module — Design Spec

## Overview

FacadeXPM has no concept of a pre-sales document today. Every project starts
life as a `sites` row already in progress — there's no way to quote a
prospective client, track whether they accepted, and only then create the
site. This spec adds a **Quotation** module (ใบเสนอราคา): a client-facing,
itemized document that exists independently of `sites`, gated as a paid
module the same way `purchase_orders`/`labor_subcontractors`/
`client_deposits` are gated today.

This is **Sub-project A** of a two-part effort scoped during brainstorming:

1. **Quotation** (this spec) — create, send, and track quotations; on
   acceptance, hand off into a new (or existing) Site.
2. **Invoice / progress billing** — future spec, not covered here. Bills
   drawn against a quotation's line items (a single item can be billed
   100% at once, or split across multiple draws, e.g. 30%/30%/40%, tracked
   independently per line), deducting from any client deposit already on
   file, and reconciling into an `incomes` row once paid — the same
   ordered→received / expense-reconciliation shape `purchase_orders`
   already uses, mirrored onto the revenue side. Depends on this spec's
   `quotation_items` shape and is intentionally deferred until this ships.

## Goals

- Let a tenant create, edit, and send a quotation to a prospective client
  **before any `sites` row exists** — a quotation only requires a client.
- Itemized line items, optionally drawn from a new reusable **item
  catalog** (sell-side price list) to speed up entry, or typed free-text
  for one-offs — same "pick from catalog or type your own" shape
  `SearchableSelect` already provides for suppliers/categories.
- A simple status lifecycle (draft → sent → accepted/rejected/expired)
  with the document locked once it leaves draft/sent.
- Marking a quotation **accepted** prompts the user to create (or link) a
  `sites` row, pre-filled from the quotation, closing the loop into the
  existing Sites/Income/Retention/Deposits modules.
- A branded PDF export, matching the existing Purchase Order PDF/JPG
  export pattern (`html2pdf.js`/`html2canvas`), which requires adding a
  company profile (address, tax ID, logo, bank details) that doesn't
  exist anywhere in the schema today.
- Gate the whole feature behind a new `quotations` module.

## Non-Goals

- **No "Estimation" module.** The user's real pricing process is a
  bottom-up cost buildup per item (aluminum weight × rate, glass, labor,
  subframe, waste %, margin %, PM fee %, plus project-level transport/
  protection/cleaning) done today in Excel, with a *second*, more complex
  file just for aluminum costing. Quotation does not model or calculate
  any of this — it only stores the **final** numbers (description, unit,
  qty, unit price, line total) that estimation already produced. A future
  Estimation module could hand its output to Quotation, but that's out of
  scope here and doesn't constrain this spec's data model.
- **No Invoice / progress billing / reconciliation into Income.**
  Sub-project B, described above, not built here.
- **No public, client-facing acceptance portal.** "Accepted" is recorded
  by internal staff clicking a button after receiving the signed
  quotation back via email/LINE/in person — there is no public
  unauthenticated link for a client to click-to-accept. The user
  explicitly wants this eventually ("I would love to have it") but scoped
  it to a later phase depending on available resourcing. Nothing in this
  design blocks adding it later (status stays a plain enum; a future spec
  can add a token-based public route without touching this shape), but no
  token/slug column is added now — that would be speculative for a
  feature not yet committed to.
- **No per-line-item VAT.** VAT stays a single header-level toggle
  (`has_vat` / `price_includes_vat`), identical to `purchase_orders`
  today. Mixed VAT-applicability within one document isn't something PO
  supports either, and nothing in this conversation asked for it.
- **No cost price on catalog items, no margin calculation, no inventory
  quantity tracking.** The user's business doesn't resell what it buys —
  raw materials purchased (aluminum, glass) become an input cost that,
  combined with labor and admin, produces a *different* finished
  deliverable (e.g. a "door and window set" priced per set, a glass wall
  priced per sq.m.). There's no 1:1 item match between a PO line and a
  Quotation line, so a "cost price" field on the catalog would be
  meaningless. Profit/COGS reporting is a site-level aggregate (Income
  vs. categorized Expenses vs. Payroll/overhead) that already exists
  independently of this module and isn't extended here. The catalog is a
  **sell-side price list only** — it doesn't track how many units exist,
  only what an item is called, its unit, and its default price.
- **No revision/version history.** A quotation is editable while
  `draft`/`sent` and locked once `accepted`/`rejected`/`expired`. If the
  client wants changes after that, staff create a new quotation. Full
  version history can be a future addition if this turns out to be
  painful in practice.

## Data Model

### `tenants` — company profile, for the PDF letterhead

Nothing beyond `company_name` exists today. Adding the fields any
client-facing document (this, and later Invoice) needs:

```sql
ALTER TABLE tenants
  ADD COLUMN address            TEXT,
  ADD COLUMN tax_id             TEXT,
  ADD COLUMN phone              TEXT,
  ADD COLUMN logo_url           TEXT,
  ADD COLUMN bank_name          TEXT,
  ADD COLUMN bank_account_name  TEXT,
  ADD COLUMN bank_account_no    TEXT;
```

All nullable — existing tenants (including FacadeX's own bootstrap
tenant) simply have an incomplete letterhead until an OWNER fills these
in via a new section on the Settings page. Editable the same way
`contractor_type_id` was just added: OWNER-only, via `owner_updates_own_tenant`.

Logo storage: a new **public-read** Storage bucket `tenant-logos`,
tenant-prefixed path (`{tenant_id}/logo.<ext>`), mirroring the
`site-attachments` bucket's path convention but public rather than
private — a company logo isn't sensitive (it's *meant* to be shown to
clients on the PDF), and `html2canvas` needs to load it directly in the
browser without a signed-URL round trip. Write access still restricted
to the tenant's own OWNER via bucket RLS, same shape as the existing
attachment buckets' tenant-scoped policies.

### `catalog_items` — NEW, sell-side price list

```sql
CREATE TABLE catalog_items (
  id                 UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name               TEXT NOT NULL,
  unit               TEXT,                        -- ชุด, ตร.ม., เมตร, ชิ้น, ...
  default_unit_price NUMERIC NOT NULL DEFAULT 0,   -- a suggestion, not enforced
  active             BOOLEAN NOT NULL DEFAULT true,-- retire without deleting (referenced by past quotations)
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  tenant_id          UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id)
);

CREATE INDEX idx_catalog_items_tenant_id ON catalog_items(tenant_id);
```

Picked via `SearchableSelect` when adding a quotation line (autofills
`description`/`unit`/`unit_price`, all three still freely editable after
picking — same "assist, don't constrain" shape suppliers/categories
already have on the PO item editor). A line can also skip the catalog
entirely and be typed from scratch, which is how estimation-sheet output
or a genuine one-off gets in.

### `quotations` — header

```sql
CREATE TABLE quotations (
  id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  quotation_number    TEXT NOT NULL UNIQUE DEFAULT '',  -- AUTO: QT-2026-001
  client_id           UUID NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  site_id             UUID REFERENCES sites(id) ON DELETE SET NULL,  -- NULL until accepted
  date                DATE NOT NULL,
  valid_until         DATE,                              -- ราคานี้มีผลถึงวันที่...
  status              TEXT NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft','sent','accepted','rejected','expired')),
  has_vat             BOOLEAN NOT NULL DEFAULT true,
  price_includes_vat  BOOLEAN NOT NULL DEFAULT false,
  discount_amount     NUMERIC,                           -- mutually exclusive with discount_pct;
  discount_pct        NUMERIC,                            -- UI enforces only one is set
  payment_terms       TEXT,                               -- free text, printed on the PDF
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  tenant_id           UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id)
);

CREATE INDEX idx_quotations_client_id ON quotations(client_id);
CREATE INDEX idx_quotations_site_id ON quotations(site_id);
CREATE INDEX idx_quotations_status ON quotations(status);
CREATE INDEX idx_quotations_tenant_id ON quotations(tenant_id);
```

### `quotation_items` — flat line list

Same shape as `purchase_order_items`, plus an optional catalog reference:

```sql
CREATE TABLE quotation_items (
  id               UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  quotation_id     UUID NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  catalog_item_id  UUID REFERENCES catalog_items(id) ON DELETE SET NULL,  -- nullable: free-text lines have none
  description      TEXT NOT NULL,
  unit             TEXT,
  quantity         NUMERIC NOT NULL DEFAULT 1,
  unit_price       NUMERIC NOT NULL DEFAULT 0,
  line_total       NUMERIC NOT NULL DEFAULT 0,
  sort_order       INT NOT NULL DEFAULT 0,
  tenant_id        UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id)
);

CREATE INDEX idx_quotation_items_quotation_id ON quotation_items(quotation_id);
CREATE INDEX idx_quotation_items_tenant_id ON quotation_items(tenant_id);
```

`catalog_item_id` is kept purely as provenance (which catalog entry this
line came from, if any) — it does not constrain `description`/`unit`/
`unit_price`, which are copied at add-time and can drift from the catalog
afterward without anything re-syncing. This matches the earlier
clarification that pricing varies by site/deal, not a single fixed
catalog price.

## Calculation Logic

`src/lib/quotationCalc.js` (new, unit-tested — following the
`depositCalc.js`/`expenseChart.js` precedent of extracting pure calc
logic into a tested lib module, rather than `PurchaseOrders.jsx`'s
`calcPoTotals`, which is inline and untested):

```js
export function calcQuotationTotals(items, { hasVat, priceIncludesVat, discountAmount, discountPct }) {
  const rawTotal = sum(items.map(lineTotal))
  const discounted = discountPct
    ? rawTotal * (1 - discountPct / 100)
    : rawTotal - (discountAmount || 0)
  // then identical has_vat / price_includes_vat branching to calcPoTotals,
  // applied to `discounted` instead of `rawTotal`
}
```

Discount is applied once, to the line-item sum, before the existing
VAT-inclusive/exclusive branching — so it uniformly reduces whichever
figure is meaningful (VAT-inclusive total or pre-VAT subtotal) before VAT
math runs, rather than needing separate discount logic per VAT mode.

## Status Lifecycle & the Accept → Site Setup Handoff

`draft` and `sent` are editable. `accepted`/`rejected`/`expired` lock the
document (matches the existing precedent of Purchase Orders' three-state
`ordered`/`received`/`cancelled`, just with a rejection/expiry branch
added since quotations, unlike POs, can be declined or time out).

Marking a quotation **accepted** (an internal click — see Non-Goals) opens
a Site-setup popup if `site_id` is still null:

- Pre-fills `sites.name` (from client name / quotation notes — exact
  default TBD at implementation time, not load-bearing for this spec),
  `sites.contract_value` = the quotation's calculated total.
- On save, creates the `sites` row and sets `quotations.site_id` to it.
- If a site already exists for this client (rare, but the popup should
  allow searching/picking an existing site instead of always creating a
  new one — same `SearchableSelect` used everywhere else), sets
  `quotations.site_id` directly without creating anything.

This mirrors the existing "PO Reconciliation Dialog" interaction shape in
`Expenses.jsx` (a status change prompting a required follow-up action via
a popup) rather than inventing a new pattern.

## UI

New page `src/pages/Quotations.jsx` (ใบเสนอราคา):

- List + filters (client, status, date range) — same toolbar/filter-panel
  shape as `Expenses.jsx`/`PurchaseOrders.jsx`.
- Create/edit modal: client picker (`SearchableSelect`, required), date,
  valid-until, VAT radio group (identical UI to PO's), discount
  amount-or-percent, payment terms textarea, item-line editor (catalog
  picker + free-text override per line, add/remove rows — same
  `ItemsEditor` shape `PurchaseOrders.jsx` already has).
- PDF export button: `html2pdf.js`/`html2canvas`, same pipeline as PO's
  existing PDF/JPG export, rendering the company profile as a letterhead
  (name, address, tax ID, logo, bank details for payment) plus the
  itemized table, discount, VAT breakdown, and payment terms.
- Status actions: Send (draft→sent), Accept (→ triggers the site-setup
  popup described above), Reject, mark Expired.

New section on `src/pages/Settings.jsx`: company profile fields
(address, tax ID, phone, logo upload, bank details) — OWNER-only, same
role floor as the existing settings sections on that page.

## Auto-numbering

`generate_quotation_number()`, identical pattern to `generate_po_number()`
(`supabase/schema.sql:658`): `QT-` + current year + zero-padded sequence,
scoped by `MAX(existing suffix)+1` within the year, trigger fires
`BEFORE INSERT ... WHEN (NEW.quotation_number IS NULL OR NEW.quotation_number = '')`.

## Module Gating

New module key `quotations`, added the same way `client_deposits` was
(`supabase/migrations/2026-08-19-03-client-deposit-tracking.sql` is the
precedent):

```sql
ALTER TABLE tenant_modules DROP CONSTRAINT tenant_modules_module_key_check;
ALTER TABLE tenant_modules ADD CONSTRAINT tenant_modules_module_key_check
  CHECK (module_key IN ('payroll','labor_subcontractors','purchase_orders','client_deposits','quotations'));
```

RLS on `quotations`, `quotation_items`, and `catalog_items`: single
`admin_full_access` policy per table, same shape as `purchase_orders`
(`supabase/schema.sql:687`) —

```sql
CREATE POLICY admin_full_access ON quotations FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('quotations'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('quotations'));
```

(same for `quotation_items` and `catalog_items`).

New `TABS` entry in `App.jsx`: `{ id: 'quotations', label: '📋 ใบเสนอราคา',
minRole: 'ADMIN', module: 'quotations' }`, placed near `expenses`/
`purchase_orders` in the nav.

## Testing

- Unit tests for `quotationCalc.js` (line totals, both discount modes,
  both VAT modes, and the combination of discount + VAT-inclusive
  pricing) — same style as `expenseChart.test.js`/`depositCalc.test.js`.
- A Supabase RLS/policy test file for the three new tables plus the
  `tenants` column additions, same style as
  `supabase/tests/contractor_type_templates_test.sql` from the
  just-merged contractor-type-templates feature.
- Migration verification: `information_schema.columns` check for the new
  `tenants` columns and the new tables, confirming RLS is enabled and the
  `quotations`/`quotation_items`/`catalog_items` policies gate on
  `has_module_access('quotations')` as written.
- Manual click-through is not performed during implementation (no login
  credentials available to implementer/reviewer agents) — build +
  `npm test` is the verification bar, consistent with how Retention and
  Client Deposits were verified.

## Open Questions Resolved During Brainstorming

- Quotation requires only a `client_id`; `site_id` is nullable and set on
  acceptance, not at creation — quoting happens pre-sales, before a site
  exists.
- Accepting a quotation pops up a site-setup step (create-or-link),
  pre-filling `contract_value` from the quotation total, rather than
  silently creating a site or requiring a separate manual step.
- Acceptance is recorded by internal staff only, not a public
  client-facing acceptance link — that's a wanted future phase, not part
  of this spec, and this design doesn't block adding it later.
- The item catalog is sell-side only (no cost price, no per-item VAT, no
  inventory/stock quantity) — the user's buy-side materials and sell-side
  deliverables are different kinds of things with no 1:1 mapping, so a
  unified buy/sell catalog with margin tracking would be modeling a
  business shape that doesn't match how this company actually works. A
  separate buy-side catalog for Purchase Orders was mentioned as a
  "eventually" want but is out of scope here.
- The user's real pricing process (bottom-up cost buildup: aluminum
  weight × rate, glass, labor, subframe, waste %, margin %, PM fee,
  transport/protection/cleaning) is explicitly a different, future
  "Estimation module" — Quotation only stores the final numbers that
  process produces, and doesn't attempt to replicate any of that
  calculation.
- VAT stays header-level only (matches Purchase Orders), not per line
  item.
