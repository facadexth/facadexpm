# Invoice Module — Design Spec

## Overview

This is **Sub-project B** of the document-lifecycle effort scoped in
`2026-08-22-quotation-module-design.md` ("Quotation" was Sub-project A,
already shipped). It adds progress billing: **Invoice** draws against a
signed quotation's line items (item-by-item, or fully at once), **Receipt
+ ใบกำกับภาษี** are issued together the moment an invoice is paid, and that
payment reconciles into the existing `incomes` table — the same
ordered→received / expense-reconciliation shape `purchase_orders` already
uses (`ordered` → app-level insert into `expenses`, link back
`purchase_orders.expense_id`), mirrored onto the revenue side.

Everything in this spec was worked out through interactive prototyping
this session (a live HTML mockup, iterated against real numeric examples)
before being written up here — the behavior described in **Item-Selection
UI** below is validated, not speculative.

## Goals

- Bill against a quotation's items with **work-completion %, tracked per
  physical unit** — not a single blended percentage per line, and not
  raw quantity as the primary input. A window line with 5 sets can have
  set #1 at 40% complete while the other 4 haven't started; the next
  invoice needs to represent that honestly.
- A **simple default UI** (โหมดง่าย: tick a box for 100% of what's left,
  or type a quantity — identical shape to how Quotation/PO item entry
  already works) that only escalates to per-unit control (โหมดละเอียด)
  when a line actually needs it.
- One persistent **per-unit progress ledger** as the single source of
  truth, so easy mode and advanced mode are two views over the same data
  — switching between them, without editing anything, never changes the
  billed total.
- Marking an invoice **paid** issues a combined **ใบเสร็จรับเงิน/ใบกำกับภาษี**
  and reconciles into `incomes`, automatically feeding the Deposits,
  Retention, and Sales Report views that already read from that table.
- A new, purely **derived "% invoiced"** figure on the site (parallel to
  the existing derived `billing_pct`, which is now unambiguously "%
  collected") — mirrors how `sites.contract_value`/`billing_pct` already
  work: nothing is stored, it's computed live from the ledger.

## Non-Goals

- **No partial invoice payments.** An invoice flips `unpaid → paid` in
  one shot, exactly mirroring PO's `ordered → received`. If a client
  genuinely pays in installments, staff create separate smaller invoices
  — that's what progress billing is *for*. Confirmed with the user
  during brainstorming.
- **No multi-quotation invoices.** One invoice always bills against
  exactly one quotation. A site with two signed quotations (e.g. a
  change order) gets two independent invoice threads. Confirmed with the
  user during brainstorming.
- **No separate Receipt vs. Tax Invoice documents.** Combined into one
  document generated together on payment — standard Thai SME practice.
  Confirmed with the user during brainstorming.
- **No draft/sent state for invoices.** Unlike Quotation
  (draft→sent→accepted), an invoice is created final — mirrors PO, which
  also has no draft concept before `ordered`. If a mistake is made before
  payment, **void** it (see Status Lifecycle) rather than editing it in
  place.
- **No editing an invoice after creation.** Creating an invoice mutates
  the shared per-unit ledger (`quotation_item_units`); in-place editing
  would require diffing and re-applying ledger deltas, which is exactly
  what void + recreate already accomplishes more simply.
- **No public client-facing payment portal.** "Paid" is recorded by
  internal staff after receiving payment via bank transfer/cheque/etc,
  same non-goal Quotation's acceptance already has.
- **No automatic/recurring invoice generation.** Every invoice is
  created manually against a specific billing round.

## Data Model

### `quotation_item_units` — NEW, the per-unit progress ledger

The single source of truth for how much of each quotation line has been
billed. **Seeded lazily**, the first time the item-selection screen opens
for a given quotation (idempotent: skip any `quotation_item` that already
has rows) — deliberately *not* at quotation-acceptance time, because
acceptance is a `quotations`-gated action that must keep working for
tenants who don't have the `invoices` module at all, while this table's
RLS gates on `has_module_access('invoices')` (see Module Gating). Seeding
only happens from inside a flow that already requires that module. One
row per physical unit for small, discrete-quantity lines; one row for the
whole quantity otherwise:

```sql
CREATE TABLE quotation_item_units (
  id                UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  quotation_item_id UUID NOT NULL REFERENCES quotation_items(id) ON DELETE CASCADE,
  unit_index        INT NOT NULL,                  -- 0-based, physical fill order
  unit_qty          NUMERIC NOT NULL,               -- 1 per row when fragmented; full qty when not
  cumulative_pct    NUMERIC NOT NULL DEFAULT 0
                    CHECK (cumulative_pct BETWEEN 0 AND 100),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  tenant_id         UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  UNIQUE (quotation_item_id, unit_index)
);

CREATE INDEX idx_quotation_item_units_quotation_item_id ON quotation_item_units(quotation_item_id);
CREATE INDEX idx_quotation_item_units_tenant_id ON quotation_item_units(tenant_id);
```

Seeding rule, run once per `quotation_item` the first time it's touched
by the item-selection screen:

- If `quantity` is a whole number `<= 20`: insert `quantity` rows,
  `unit_qty = 1` each. This is what lets a "5 ชุด" window line fragment
  into individually-trackable sets in โหมดละเอียด.
- Otherwise (large or fractional quantity — e.g. `45 ตร.ม.` of curtain
  wall): insert **one** row, `unit_qty = quantity`. Area-type lines never
  fragment; billing them is always a single cumulative % against the
  whole quantity.

This is a display/UI heuristic, not a hard business rule — nothing about
the table shape depends on it. Both cases use the identical row
structure; a "piece" line is just a line with more than one row.

### `invoices` — header

```sql
CREATE TABLE invoices (
  id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  invoice_number      TEXT NOT NULL UNIQUE DEFAULT '',    -- AUTO: INV-2026-001
  quotation_id        UUID NOT NULL REFERENCES quotations(id) ON DELETE RESTRICT,
  site_id             UUID NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
  date                DATE NOT NULL,
  status              TEXT NOT NULL DEFAULT 'unpaid'
                      CHECK (status IN ('unpaid','paid','void')),
  has_vat             BOOLEAN NOT NULL,   -- snapshot from quotation at creation time
  price_includes_vat  BOOLEAN NOT NULL,   -- snapshot
  subtotal            NUMERIC NOT NULL DEFAULT 0,
  vat                 NUMERIC NOT NULL DEFAULT 0,
  total               NUMERIC NOT NULL DEFAULT 0,
  notes               TEXT,
  paid_date           DATE,
  income_id           UUID REFERENCES incomes(id) ON DELETE SET NULL,  -- set once paid
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  tenant_id           UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id)
);

CREATE INDEX idx_invoices_quotation_id ON invoices(quotation_id);
CREATE INDEX idx_invoices_site_id ON invoices(site_id);
CREATE INDEX idx_invoices_status ON invoices(status);
CREATE INDEX idx_invoices_tenant_id ON invoices(tenant_id);
```

`has_vat`/`price_includes_vat` are snapshotted (not read live from
`quotations`) for the same reason `quotation_revisions` snapshots —
an invoice's printed numbers must never silently shift if the source
quotation is ever revisited.

### `invoice_items` — one row per quotation line drawn on, this invoice

```sql
CREATE TABLE invoice_items (
  id                 UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  invoice_id         UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  quotation_item_id  UUID NOT NULL REFERENCES quotation_items(id) ON DELETE RESTRICT,
  description        TEXT NOT NULL,     -- snapshot
  unit               TEXT,
  unit_price         NUMERIC NOT NULL,  -- snapshot
  draw_qty           NUMERIC NOT NULL,  -- total unit-equivalents billed by this invoice
  line_total         NUMERIC NOT NULL,
  sort_order         INT NOT NULL DEFAULT 0,
  tenant_id          UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id)
);

CREATE INDEX idx_invoice_items_invoice_id ON invoice_items(invoice_id);
CREATE INDEX idx_invoice_items_tenant_id ON invoice_items(tenant_id);
```

### `invoice_item_draws` — NEW, per-unit audit trail

Records exactly which `quotation_item_units` row moved from what % to
what %, and for how much money, on this invoice. This is what powers the
"ประวัติการเรียกเก็บ" history shown per unit in โหมดละเอียด, and is how a
later invoice can display "ชุดที่ 1 → 40% (INV-2026-001)" against a
specific past invoice rather than a vague aggregate.

```sql
CREATE TABLE invoice_item_draws (
  id                      UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  invoice_item_id         UUID NOT NULL REFERENCES invoice_items(id) ON DELETE CASCADE,
  quotation_item_unit_id  UUID NOT NULL REFERENCES quotation_item_units(id) ON DELETE RESTRICT,
  prior_pct               NUMERIC NOT NULL,
  target_pct              NUMERIC NOT NULL,
  amount                  NUMERIC NOT NULL,
  tenant_id               UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id)
);

CREATE INDEX idx_invoice_item_draws_invoice_item_id ON invoice_item_draws(invoice_item_id);
CREATE INDEX idx_invoice_item_draws_unit_id ON invoice_item_draws(quotation_item_unit_id);
CREATE INDEX idx_invoice_item_draws_tenant_id ON invoice_item_draws(tenant_id);
```

### `receipts` — combined ใบเสร็จรับเงิน/ใบกำกับภาษี

```sql
CREATE TABLE receipts (
  id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  receipt_number      TEXT NOT NULL UNIQUE DEFAULT '',   -- AUTO: RCP-2026-001
  tax_invoice_number  TEXT NOT NULL UNIQUE DEFAULT '',   -- AUTO: TIN-2026-001
  invoice_id          UUID NOT NULL UNIQUE REFERENCES invoices(id) ON DELETE RESTRICT,
  date                DATE NOT NULL,
  amount              NUMERIC NOT NULL,
  tenant_id           UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id)
);

CREATE INDEX idx_receipts_invoice_id ON receipts(invoice_id);
CREATE INDEX idx_receipts_tenant_id ON receipts(tenant_id);
```

One physical document, printed with **two independently-sequential
numbers** — `receipt_number` for the payment record, `tax_invoice_number`
for VAT filing. Thai tax practice generally expects the tax invoice
series to be its own unbroken sequence even when it's printed on the
same page as the receipt, so both get their own auto-numbering trigger
rather than sharing one.

`invoice_id` is `UNIQUE` because payment is single-shot (Non-Goals) — at
most one receipt can ever exist per invoice.

## Calculation Logic

`src/lib/invoiceCalc.js` (new, unit-tested, following the
`quotationCalc.js` precedent):

```js
export const VAT_RATE = 0.07

// Fills unit-equivalents across a quotation_item's units in array order,
// completing each unit's remaining capacity before moving to the next.
// The single function both modes share: โหมดง่าย calls it with a scalar
// qty; โหมดละเอียด edits `target` on individual units directly and this
// function is what re-derives โหมดง่าย's own display from that result.
export function waterfall(units, qty) {
  let budget = qty
  return units.map(u => {
    if (u.cumulative_pct >= 100) return { ...u, target: u.cumulative_pct }
    const capacity = (100 - u.cumulative_pct) / 100
    if (budget <= 1e-9) return { ...u, target: u.cumulative_pct }
    if (budget >= capacity - 1e-9) { budget -= capacity; return { ...u, target: 100 } }
    const target = u.cumulative_pct + budget * 100
    budget = 0
    return { ...u, target }
  })
}

export function openQty(units) {
  return units.reduce((s, u) => s + (100 - u.cumulative_pct) / 100, 0)
}

export function drawAmount(units, unitValue) {
  return units.reduce((s, u) => s + (u.target - u.cumulative_pct) / 100 * unitValue, 0)
}

export function calcInvoiceTotals(invoiceItems, { hasVat, priceIncludesVat }) {
  const subtotal = sum(invoiceItems.map(i => i.line_total))
  // identical has_vat / price_includes_vat branching to calcQuotationTotals,
  // minus discount (invoices don't carry their own discount — the
  // quotation's discount is already baked into each line's unit_price
  // at quotation-creation time)
}
```

## Item-Selection UI (creating an invoice)

New modal/page, opened from a site or from the quotation itself, against
one `accepted` quotation with a `site_id` set. On open, lazily seeds any
missing `quotation_item_units` rows for that quotation's items (see Data
Model) before rendering.

**โหมดง่าย (default), one global switch at the top of the item list,
applies to every line at once:**

- Tick "เลือกทั้งหมด" → every open line bills 100% of what's left.
- Untick a line → type a quantity (piece lines) or an area quantity
  (area lines — never %, the area's own unit directly). Arrow
  up/down steps by whole units; typing a value over the remaining
  amount snaps the field back to the max, it does not silently clamp
  the underlying number while showing something else.
- A line whose units disagree (some further along than others) still
  gets a normal checkbox + quantity field in easy mode — the quantity is
  a blended remaining figure, tagged "เฉลี่ยจากความคืบหน้าที่ไม่เท่ากันต่อชิ้น"
  so it's visibly an average, not exact.

**โหมดละเอียด, same global switch:**

- Every multi-unit piece line expands into one row per physical unit,
  numbered `{itemNo}.{unitNo}` (e.g. `2.1`, `2.2`, …), each with its own
  `% สะสม` (cumulative target) field — editing it directly writes
  `target` on that unit. A completed unit shows a "ครบแล้ว" tag instead
  of an input.
- The line's own header row shows a **read-only, live-updating quantity**
  in the same column โหมดง่าย would use for that line — always equal to
  `openQty()`'s current draw, so a user can flip back to โหมดง่าย at any
  point and see the identical total, because both modes render from the
  same `quotation_item_units` state. Nothing resets on switch.
- Area lines ignore the switch entirely — they're always one row, always
  billed in their own unit, in every mode, since a single cumulative
  number already has full precision for a continuous measure.

**Row layout** (both modes) follows the same column pattern as
`QuotationItemsEditor`: a fixed-width column per control, `1fr` for the
description block. Simple-mode rows read **checkbox / No / รายการ /
จำนวน / หน่วย / ราคา/หน่วย / รวม** — matching how every other itemized
document in the app already reads.

**Rendering discipline:** number-field `input` handlers must not trigger
a full row-list rebuild on every keystroke (this was caught and fixed
during prototyping — rebuilding `innerHTML` on each keystroke destroys
and recreates the input the user is actively typing into, dropping
cursor focus mid-entry). Only the derived amount/summary text nodes
patch on keystroke; full rebuilds are reserved for structural changes
(checkbox toggle, mode switch, select-all).

On save: for each touched `quotation_item_unit`, insert an
`invoice_item_draws` row (`prior_pct` = its current `cumulative_pct`,
`target_pct` = the value just set) and then update
`quotation_item_units.cumulative_pct = target_pct`. Roll the per-unit
amounts up into one `invoice_items` row per quotation line, then those
into the `invoices` header via `calcInvoiceTotals`.

## Status Lifecycle

`unpaid` (created) → `paid` (reconciled, see below) or → `void`
(mistake correction, only reachable from `unpaid` — mirrors PO's
`ordered → cancelled` branch, which is likewise only reachable before
`received`).

**Voiding** an unpaid invoice reverses its ledger effect: for each of its
`invoice_item_draws`, set the referenced `quotation_item_units.cumulative_pct`
back to that draw's `prior_pct`. This is safe specifically *because*
payment hasn't happened yet — nothing downstream (`incomes`, receipts)
exists to unwind.

**Marking paid** (app-level transaction, direct mirror of
`PurchaseOrders.jsx`'s `handleReceive()`):

1. Insert into `receipts` (`invoice_id`, `date`, `amount = invoices.total`)
   — `receipt_number`/`tax_invoice_number` auto-assigned by trigger.
2. Insert into `incomes`: `invoice_no = invoices.invoice_number`,
   `site_id`, `client_name` (via quotation → client), `description`
   (e.g. "งวดที่ N — {quotation_number}"), `amount_no_vat =
   invoices.subtotal`, `vat = invoices.vat`, `income_type = 'ปกติ'`,
   `deposit_deduction`/`retention` computed the same way manual
   `IncomeForm` entries already compute them today (site defaults),
   `received_amount = invoices.total`.
3. `invoices.update({ status: 'paid', paid_date, income_id })`.

Both writes wrapped try/catch with an audit log after each, same
best-effort-atomicity shape (and same documented manual-reconciliation
fallback) as the PO precedent — no new transactional guarantee is being
invented here.

This single action is what makes Deposits, Retention, Sales Report, and
`site_financial_summary.billing_pct` all "just work" the moment an
invoice is paid — they already read from `incomes`, and nothing about
their queries needs to change.

## Site Progress

New columns on `site_financial_summary` (`schema.sql:1727`), computed
the same "pure derived view" way `billing_pct` already is — nothing
stored on `sites` itself:

```sql
invoiced_amount NUMERIC   -- SUM(quotation_item_units.cumulative_pct / 100
                          --     * unit_qty * quotation_items.unit_price)
                          --   joined quotation_item_units -> quotation_items
                          --   -> quotations -> sites
invoiced_pct    NUMERIC   -- invoiced_amount / contract_value * 100
```

This is deliberately a **second, distinct** figure from the existing
`billing_pct` (`total_income / contract_value`). `invoiced_pct` answers
"how much of the contract has been billed" the instant an invoice is
created; `billing_pct` continues to answer "how much has actually been
collected," unchanged, since it's still driven by `incomes` and
`incomes` still only gets a row at payment time. The gap between the two
is exactly a site's outstanding (billed but unpaid) receivables.

## Auto-numbering

Three new triggers, identical pattern to `generate_quotation_number()`/
`generate_po_number()` (`schema.sql:658`, `761`): `BEFORE INSERT ...
WHEN (NEW.<col> IS NULL OR NEW.<col> = '')`, `MAX(existing suffix
WHERE <col> LIKE '<PREFIX>-'||year||'-%') + 1`, zero-padded to 3 digits.

- `generate_invoice_number()` → `INV-2026-001`
- `generate_receipt_number()` → `RCP-2026-001`
- `generate_tax_invoice_number()` → `TIN-2026-001`

## Module Gating

New module key `invoices`, same shape as `quotations` was added
(`2026-08-22-02-quotations-module-key.sql` is the precedent):

```sql
ALTER TABLE tenant_modules DROP CONSTRAINT tenant_modules_module_key_check;
ALTER TABLE tenant_modules ADD CONSTRAINT tenant_modules_module_key_check
  CHECK (module_key IN ('payroll','labor_subcontractors','purchase_orders',
                         'client_deposits','quotations','invoices'));
```

RLS on `quotation_item_units`, `invoices`, `invoice_items`,
`invoice_item_draws`, `receipts`: single `admin_full_access` policy per
table, identical shape to `quotations`' —

```sql
CREATE POLICY admin_full_access ON invoices FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('invoices'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('invoices'));
```

(same for the other four tables). `quotation_item_units` gates on
`has_module_access('invoices')`, not `'quotations'` — it's purely an
invoicing concern; a tenant without the `invoices` module never needs
these rows to exist or be readable.

New `TABS` entries in `App.jsx`, nested under the existing รายรับ group
alongside `quotations`/`sales_report`:

```js
{ id: 'invoices', label: '🧾 ใบแจ้งหนี้', minRole: 'ADMIN', module: 'invoices' }
```

## UI

New page `src/pages/Invoices.jsx` (ใบแจ้งหนี้):

- List + filters (site, client, status, date range) — same
  toolbar/filter-panel shape as `Quotations.jsx`.
- "สร้างใบแจ้งหนี้" opens the item-selection screen described above,
  scoped to one `accepted` quotation with items still open (any
  `quotation_item_units` row `< 100%`).
- Document view: same "Design A" letterhead pattern as
  `QuotationPaper`/`PODocumentModal`, PDF/JPG export via the existing
  `html2pdf.js` pipeline.
- Status actions: "ทำเครื่องหมายว่าชำระแล้ว" (unpaid → paid, runs the
  reconciliation above), "ยกเลิก" (unpaid → void, only while unpaid).
- Paid invoices show a "ดูใบเสร็จ/ใบกำกับภาษี" link to the generated
  `receipts` document (same letterhead pattern, its own PDF/JPG export).

## Testing

- Unit tests for `invoiceCalc.js`: `waterfall()` (exact-fill, partial-fill,
  already-complete units, budget exhausted before all units filled),
  `openQty()`, `drawAmount()`, and `calcInvoiceTotals()` across both VAT
  modes — same style as `quotationCalc.test.js`.
- A Supabase RLS/policy test file for the five new tables plus the
  `site_financial_summary` column additions, same style as the
  quotation module's RLS tests.
- Migration verification: `information_schema.columns` check for the new
  tables/columns, confirming RLS is enabled and every new table's policy
  gates on `has_module_access('invoices')` as written.
- A dedicated test for the void→revert path: create an invoice that
  partially draws a mixed-progress unit, void it, assert
  `quotation_item_units.cumulative_pct` is back to its pre-invoice value
  exactly (not just "close" — this is money, no floating rounding
  slack tolerated beyond what `NUMERIC` already guarantees).
- Manual click-through is not performed during implementation, same
  documented constraint as the Quotation module.

## Open Questions Resolved During Brainstorming

- **Work-completion % per physical unit**, not quantity and not a single
  blended line-item %, is the actual billing primitive — arrived at only
  after walking through several wrong mental models against concrete
  numeric examples (a 5-set window line where one set is 40% done and
  the other four haven't started).
- **One persistent ledger, two views.** Rejected an earlier design where
  โหมดง่าย and โหมดละเอียด were separate representations that needed
  syncing on mode-switch — that risked losing precision (a hand-tuned
  per-unit split collapsing back to a blended average). Settled on
  `quotation_item_units` as the only state; both UI modes just render
  and mutate it differently.
- **One quotation per invoice, single-shot payment, combined
  receipt/tax-invoice** — all three confirmed directly with the user
  rather than assumed, since each is a real fork with a plausible
  alternative (multi-quotation invoices; partial payments; separate
  documents).
- **"Site progress" is two numbers, not one.** The user's stated flow
  ("invoice created → site progress adjusted" as a step distinct from
  "invoice paid → … → income adjusted") only makes sense if invoiced-%
  and collected-% are different figures — otherwise the first step would
  have nothing to adjust yet, since `incomes` isn't written until
  payment. Resolved by adding `invoiced_pct` as a new derived figure
  alongside the existing `billing_pct`, rather than changing what
  `billing_pct` means.
- **No in-place invoice editing; void + recreate instead.** Once an
  invoice exists it has already mutated shared state (the unit ledger).
  Reversing that cleanly on void is a well-defined, testable operation;
  diffing an edit against arbitrary prior per-unit state is not, for
  comparatively little benefit over "void it and create the correct one."
