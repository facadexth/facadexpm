# Inventory Module — Design

## Purpose

FacadeXPM currently has no concept of physical stock. Material purchased for a job goes straight from a Purchase Order to an expense against that site (`purchase_orders` → `expense_id`, `site_id NOT NULL`) — pure job costing, no warehouse, no quantity tracking, no reuse across jobs. `catalog_items` (the sell-side price list used on quotations/invoices) is deliberately cost-blind and stock-blind by an earlier explicit design decision.

This is the next major step after the current PEAK-replacement work (quotations/invoices, already built, some polish remaining) — **not required for the Oct-8 2026 PEAK-replacement deadline**, and explicitly scoped as a parallel, next-phase build to bring FacadeXPM to genuine feature parity with PEAK/Express's inventory module: real stock-on-hand tracking plus weighted-average cost valuation feeding actual COGS, for both materials consumed on jobs and goods resold directly to clients.

## Current system facts this design depends on

- **No stock/warehouse concept exists anywhere.** `purchase_orders`/`purchase_order_items` tie every purchase to a `site_id` (`NOT NULL`) and become an `expense_id` on receipt. Material is 100% expensed to that site immediately — there is no "received into stock, later consumed" step today.
- **`catalog_items` is deliberately cost/stock-blind today**, by explicit prior design decision (see `schema.sql`'s comment above the table): *"Sell-side price list only — no cost price, no per-item VAT, no stock quantity... buy-side materials and sell-side deliverables are different kinds of things with no 1:1 mapping."* This design reverses that decision for the subset of catalog items that are also physical, inventory-tracked goods — service/deliverable catalog items are unaffected.
- **No general ledger / chart-of-accounts / double-entry bookkeeping exists anywhere in the system.** Reporting today is document-rollup based (`SalesReport.jsx`, `Income.jsx`, `Payroll.jsx`, `labor_cost_by_site`), not GL-based. This design does not introduce one — COGS is a computed reporting figure, not a journal-entry system.
- **The Quotation → Invoice → Receipt document lifecycle already exists and is live.** A quotation is a proposal (freely editable, can be rejected) with no stock impact. An invoice is the committed, billed sale — this is the natural point for a real sale event to fire.
- **PEAK replacement deadline** (2026-08-24 + 45 days ≈ 2026-10-08) covers quotations/invoices only — inventory is explicitly out of scope for that deadline and is being scoped now to build in parallel as bandwidth allows.

## Decisions already made (via brainstorming)

1. **Scope: both job-costing and trading, on one stock ledger.** Materials consumed on a job keep today's behavior exactly (100% expensed to the site via the existing PO flow) — this design does not change job costing. Separately, some inventory items can also be sold directly to clients on quotations/invoices, with real weighted-average-cost COGS. Both draw from and write to the same underlying stock ledger.
2. **Valuation: weighted-average (moving average) cost**, recalculated per receipt, not FIFO and not a per-item choice. Matches PEAK/Express's default for Thai SMEs, is simpler to build and audit than lot-based FIFO, and is TFRS-for-SMEs compliant.
3. **Units of measure: one base stocking unit per item**, chosen as whatever actually drives that item's cost (e.g. **kg** for aluminium, **ตร.ม./sqm** for glass) — not necessarily the unit it's purchased or sold in. Two conversion styles, both needed:
   - **Fixed factor** (aluminium-style): a conversion ratio set once per item/profile (e.g. "1 piece of profile X = 2.3 kg"), reused on every transaction in that alternate unit.
   - **Per-transaction dimension entry** (glass-style): a piece doesn't have one fixed size, so width × height is captured at the time of that specific transaction and converted to sqm on the spot.
4. **No lot/batch tracking — pooled stock.** An item's stock is one running quantity + one running weighted-average cost per location, not tracked back to which specific delivery a unit came from. Consistent with weighted-average costing; avoids building lot-tracking machinery that isn't needed for costing purposes.
5. **Reconciliation is triggered by site completion, not a calendar.** There is no periodic stock-take. At job close-out, whatever material is physically left over gets a transfer movement out of "this job" and into general stock.
6. **Leftover valuation: the job keeps 100% of its original cost; leftover enters general stock at zero cost.** Matches existing project-management practice (100% of purchased material is always charged to the job, plus the separate 5% contingency practiced on quoted prices — unrelated to this system). The completed job's cost is exactly what was purchased for it, no partial credit-back. Leftover material re-entering the stock pool at zero cost is intentional — its cost was already fully recognized by the original job — and will correctly blend into (slightly lower) that item's weighted-average cost for future jobs drawing from the same pool.
7. **Stock has two entry points.** A Purchase Order can target a specific site (material belongs to that job, 100% expensed as today, until site completion transfers any leftover out), **or** target general stock directly (buying material ahead of a job that hasn't started yet).
8. **General stock is not a special entity — it's an ordinary site.** Modeled as a real row in the existing `sites` table, named "ส่วนกลาง" (Central), which the business **also already uses as a catch-all site for miscellaneous/unidentified jobs** — so it gets no special flag or exclusion anywhere (worker check-in, site reports, etc. all treat it like any other site). This means the entire stock ledger is naturally site-scoped: stock "lives at" a site_id (including ส่วนกลาง), and moving it between locations is just another movement type.
9. **`catalog_items` gains an optional link to a new `inventory_items` table**, not stock/cost fields directly. A catalog item without the link behaves exactly as today (a service/deliverable, no stock, no cost). A catalog item *with* the link is a physical good — its cost and stock-availability come live from the linked `inventory_items` row. "Cost" always means that item's *current* weighted-average cost at the moment it's used, never a static number stored on the catalog item.
10. **COGS posts at invoice creation**, not quotation acceptance and not payment. A quotation is just a proposal with no stock impact; the invoice is the real committed sale, matching how these two documents already relate to each other in the existing system.
11. **Cancelling an invoice reverses the stock/COGS effect** via a compensating movement (not a delete) — preserves the audit trail of what actually happened, consistent with how the rest of this system favors auditable history over silent correction.
12. **Insufficient stock is a soft warning, not a hard block.** An invoice can still be saved even if a line would take an item's stock negative — matches this system's general pragmatic, non-blocking posture elsewhere (job costing has no gates either). The warning exists so staff notice, but billing a real sale is never blocked by an inventory-count timing issue.

## Data model

### `inventory_items` — the stockable item definition

```sql
CREATE TABLE inventory_items (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id   UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  name        TEXT NOT NULL,
  base_unit   TEXT NOT NULL,          -- e.g. 'kg', 'sqm', 'piece' — whatever drives this item's real cost
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

No cost or quantity lives here — those are per-location (see `inventory_stock_balances` below), since the same item can have a different weighted-average cost sitting at different sites.

### `inventory_item_unit_factors` — fixed-conversion alternate units (aluminium-style)

```sql
CREATE TABLE inventory_item_unit_factors (
  id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id           UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  inventory_item_id   UUID NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  unit_name           TEXT NOT NULL,     -- e.g. 'piece'
  factor_to_base      NUMERIC NOT NULL,  -- e.g. 2.3 (kg per piece)
  UNIQUE (inventory_item_id, unit_name)
);
```

Glass-style per-transaction dimension entry needs no stored row here — width × height is captured directly on the movement itself (see below).

### `inventory_stock_balances` — running quantity + cost, per item per site

```sql
CREATE TABLE inventory_stock_balances (
  id                     UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id              UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  inventory_item_id      UUID NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  site_id                UUID NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
  quantity_on_hand       NUMERIC NOT NULL DEFAULT 0,   -- in the item's base_unit
  weighted_average_cost  NUMERIC NOT NULL DEFAULT 0,   -- currency per base_unit
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (inventory_item_id, site_id)
);
```

Maintained transactionally alongside every `stock_movements` insert (not recomputed from the full ledger on every read) — same "maintained running total" pattern the rest of this app already favors over pure event-sourcing.

### `stock_movements` — the append-only ledger

```sql
CREATE TABLE stock_movements (
  id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id           UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  inventory_item_id   UUID NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
  site_id             UUID NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,   -- where this movement affects balance
  movement_type       TEXT NOT NULL CHECK (movement_type IN
                        ('purchase_in', 'transfer_in', 'transfer_out', 'sale_out', 'sale_reversal', 'adjustment')),
  quantity            NUMERIC NOT NULL,   -- always positive; direction implied by movement_type
  unit_cost           NUMERIC,            -- populated on every movement type except adjustment-down; only purchase_in/transfer_in feed the weighted-average recalculation (sale_out/sale_reversal carry the cost for COGS reporting but don't change the remaining balance's cost basis)
  reference_type      TEXT,               -- 'purchase_order' | 'site_completion' | 'invoice' | 'manual'
  reference_id        UUID,               -- the PO / invoice / completion event this movement came from
  notes               TEXT,
  created_by          TEXT,               -- admin email, for adjustment/manual entries
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

A transfer (e.g. leftover from Site A → ส่วนกลาง at completion) is two rows sharing a `reference_id`: a `transfer_out` at Site A (reducing its balance) and a `transfer_in` at ส่วนกลาง (increasing its balance) — kept as two rows rather than one row with a from/to pair so each row cleanly affects exactly one `(inventory_item_id, site_id)` balance, matching the rest of the ledger's shape.

### `purchase_order_items` — optional inventory link

```sql
ALTER TABLE purchase_order_items ADD COLUMN inventory_item_id UUID REFERENCES inventory_items(id) ON DELETE SET NULL;
```

Nullable. A PO line without this link behaves exactly as today (pure expense, no stock effect) — e.g. a misc. purchase that was never meant to be tracked as inventory. A PO line *with* the link, once the PO is marked `received`, creates a `purchase_in` `stock_movements` row at that PO's `site_id` **in addition to** the existing expense creation — the cost/expense side is unchanged (still 100% charged immediately per decision #6), the stock side is new and purely tracks quantity + recalculates that `(item, site)` balance's weighted-average cost.

### `catalog_items` — optional inventory link

```sql
ALTER TABLE catalog_items ADD COLUMN inventory_item_id UUID REFERENCES inventory_items(id) ON DELETE SET NULL;
```

Nullable, per decision #9 above.

## Business logic

### Purchasing (job-site PO)

Unchanged expense behavior. If the PO line is linked to an `inventory_item`, receiving it additionally posts a `purchase_in` movement at that site, recalculating `inventory_stock_balances.weighted_average_cost` as:
`new_wac = (old_qty * old_wac + received_qty * received_unit_cost) / (old_qty + received_qty)`.

### Purchasing (into ส่วนกลาง directly)

Same mechanism — a PO with `site_id = ส่วนกลาง's id`. No job to expense against in the usual sense (see Open Question below on how this PO's cost gets recorded if not tied to a job).

### Site completion → leftover transfer

At job close-out, admin records the physical quantity left over per item (a simple count entry, not a full "stock take" workflow — reconciliation is site-triggered, not periodic, per decision #5). This posts a `transfer_out` at the completed site (bringing its balance for that item toward zero) and a `transfer_in` at ส่วนกลาง, **both at `unit_cost = 0`** (decision #6 — the job already ate the full cost, so what re-enters stock is valued at zero and will pull that item's ส่วนกลาง weighted-average cost down accordingly).

### Selling (invoice creation)

For each invoice line linked to an `inventory_item`: post a `sale_out` movement (quantity = line quantity converted to base unit, `unit_cost` = that item's *current* weighted-average cost at whichever site the sale draws from — ส่วนกลาง by default, or the specific site if the item was bought straight there and never transferred out). This is the COGS figure for that line. If the resulting balance would go negative, save anyway and surface a warning (decision #12) — never block.

### Cancelling an invoice

Post a `sale_reversal` movement (same quantity/site/item, opposite direction, same `unit_cost` as the original sale) referencing the same invoice — restores the balance and reverses the COGS, without deleting the original `sale_out` row.

### Reporting

1. **Stock card** — per `(inventory_item, site)`, the full `stock_movements` history in order, with a running quantity and running weighted-average cost column (recomputable directly from the ledger — this is the audit trail).
2. **Stock valuation report** — one row per `inventory_stock_balances` entry: `quantity_on_hand * weighted_average_cost`, summed for a total inventory asset value snapshot.
3. **COGS report** — `stock_movements` where `movement_type IN ('sale_out','sale_reversal')`, grouped by period, summing `quantity * unit_cost` (reversals net out) — the tax-filing figure.
4. **Site material cost** — extends existing job-cost tracking (currently just the `expenses` rollup per site) to also show, per site, how much was issued via `purchase_in` at that site directly vs. transferred in from elsewhere, and what left as `transfer_out` at completion.

Low-stock/reorder alerts are a plausible future addition but out of scope here — nothing above depends on them.

## Edge cases

- **A PO line's `inventory_item_id` is set after the PO is already received.** Out of scope for v1 — linking happens at PO-item creation time; retroactively linking an already-received line and back-filling a stock movement is not supported (would need to reconstruct what the cost/quantity should have been after the fact).
- **An item is sold from a site's balance that itself has a zero or negative weighted-average cost** (e.g. immediately after a zero-cost leftover transfer). This is expected and correct, not an error — that COGS line will legitimately be zero or low until fresh, paid stock blends back in.
- **A catalog item's linked `inventory_item` is deactivated or deleted while still referenced by open quotations.** `ON DELETE SET NULL` means the catalog item silently reverts to service-only behavior (no cost/stock) rather than erroring — acceptable since a quotation is just a proposal; if this matters for an already-invoiced line, the historical `stock_movements` row is unaffected (it doesn't FK through `catalog_items`).
- **Same-day multiple transfers or sales against the same balance.** No locking concern beyond normal transactional row updates — `inventory_stock_balances` is a single row per `(item, site)` updated per movement, same pattern as any other running-total column in this app.

## Open questions for the implementation plan

- **How does a PO purchased directly into ส่วนกลาง (not tied to any job) get its cost recorded?** Job-site POs expense against that site as today; a ส่วนกลาง PO has no job to charge. Likely needs its own expense category (e.g. "material — inventory stock"), to be confirmed when planning.
- **Exact UI surface for site completion's leftover count entry** and for a manual `adjustment` movement (e.g. a straightforward correction after a discovered counting error) — this spec defines the data model and movement semantics; the UI shape (a new Inventory page, a step added to whatever "close out a site" flow exists today) is a planning-time decision, not fixed here.
- **RLS**: proposed as admin/owner-only writes on all new tables (`is_admin_or_owner()`, matching `purchase_orders`/`expenses` today) — no worker-facing write path is implied anywhere in this design, unlike the check-in feature.

## Phasing (proposed, for the implementation plan to structure around)

This is a large enough build to phase rather than ship in one pass:

- **Phase 1 — stock ledger + job-costing integration.** `inventory_items`, unit factors, `inventory_stock_balances`, `stock_movements`, PO-linking, site-completion leftover transfer, the stock card + valuation reports. Delivers real, accurate physical stock tracking on its own, with no change to the sell side — usable and valuable even before Phase 2 exists.
- **Phase 2 — sell-side integration + COGS.** `catalog_items` linking, invoice-triggered `sale_out`/`sale_reversal`, the COGS report, the site-material-cost report enrichment.

## Out of scope for this spec

- A general ledger / chart-of-accounts / double-entry posting system — COGS here is a computed report, not a journal entry.
- Lot/batch traceability (which specific delivery a unit came from) — pooled stock only, per decision #4.
- Low-stock/reorder point alerts.
- A map/visual warehouse-location picker, or any sub-location tracking within a site (e.g. shelf/bin) — stock is tracked per site only.
- Retroactively linking already-received PO lines to inventory items.
