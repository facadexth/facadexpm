# Inventory Categories, Opening-Balance Adjustment & Invoice-Ratio COGS Deduction — Design

## Purpose

Three related gaps in the just-shipped inventory module (Phase 1 + the glass/aluminum dual-unit conversion extension), all raised in the same conversation with the business owner:

1. **No way to enter an opening/starting stock balance.** Quantity and cost are derived exclusively from `stock_movements`, which today only get written by PO receipt and site-completion leftover transfer. There's no way to set an initial balance when first adopting the system, or to correct the system's numbers to match a physical count later (e.g. before a new tax year).
2. **No item categorization.** Materials aren't grouped by type (aluminum, glass, equipment, rubber/silicone), which blocks both a filterable price list and — the actual business need behind it — a way to allocate invoiced revenue's material cost across categories.
3. **No connection between billing and stock at all.** The business's real operational reality: there is no staff available to log individual material withdrawals at the point of production use ("เบิกไปผลิต"). Job costing already works correctly today (material is 100% expensed to the job at PO receipt — this does not change). But the *stock ledger* has no mechanism to reflect that materials get consumed as jobs get invoiced, so `quantity_on_hand` drifts further from physical reality over time with no way to correct it in bulk, in proportion to actual sales.

## Current system facts this design depends on

- **The stock ledger is a single RPC**: `record_stock_movement(p_inventory_item_id, p_site_id, p_movement_type, p_quantity, p_unit_cost, p_reference_type, p_reference_id, p_notes)`, SECURITY DEFINER, the only writer of `stock_movements`/`inventory_stock_balances`. Today it accepts exactly `'purchase_in'`, `'transfer_in'`, `'transfer_out'` and rejects everything else. The `stock_movements.movement_type` CHECK constraint already includes `'sale_out'`, `'sale_reversal'`, and `'adjustment'` in its allowed values — reserved by the original Phase 1 spec for exactly this kind of future work, never implemented.
- **Job costing is already correct and does not change.** A Purchase Order's full cost is expensed to its site the moment it's received (an `expenses` row, created directly by `PurchaseOrders.jsx`'s `handleReceive`). This design adds a *second*, independent concern — keeping the *stock quantity* ledger honest — without touching that expense-recognition logic at all.
- **`sites` already has a category-shaped cost breakdown**: `cost_aluminum`, `cost_glass`, `cost_equipment`, `cost_rubber`, `cost_labor`, `cost_other` (all `NUMERIC DEFAULT 0`), labeled in `Sites.jsx` as "อลูมิเนียม/เหล็ก", "กระจก", "อุปกรณ์", "ซิลิโคน/ยาง". These are pre-existing, manually-entered budget fields — this design's new inventory category taxonomy deliberately mirrors their exact naming, so a future reconciliation between "material actually deducted by category" and "budgeted cost by category" is a straightforward comparison, not a re-mapping exercise. That reconciliation is not built now.
- **The Inventory page currently has 4 tabs**: "รายการสินค้าคงคลัง" (item CRUD), "มูลค่าสต็อก" (valuation/balances), "ประวัติการเคลื่อนไหว" (movement ledger), "หน้าตัดอลูมิเนียม" (aluminum profile master, added by the dual-unit-conversion work). This design restructures these into a different set (see UI section).
- **Decision from this same conversation, already settled**: material-requisition-at-point-of-use ("เบิกไปผลิต") is explicitly rejected as a mechanism, because there is no staff to perform it — building that feature would produce numbers that look precise but are actually unmaintained. The chosen alternative is what this spec builds: (a) periodic physical-count correction, and (b) an approximate, ratio-based deduction tied to invoicing, which requires zero extra data entry per job.
- **`Invoices.jsx` is explicitly out of scope for this design.** Per the business owner's own framing: "ใบแจ้งหนี้มีหน้าที่ส่งยอดมาที่การตัดสต็อกใน tab สินค้าคงคลังเท่านั้น" — an invoice's role is only to be a *source of value* the inventory side reads; the inventory side does the actual deduction work as its own reviewable action, not something that fires invisibly the moment an invoice is created. This means `Invoices.jsx` needs **zero code changes** — the new inventory-side screen queries the existing `invoices` table directly (it already has `site_id` and an invoiced amount) to find invoices that haven't had their stock impact processed yet.

## Decisions (made in direct conversation with the business owner, this session)

1. **Job costing (expense recognition) does not change.** 100%-expensed-at-PO-receipt stays exactly as it is. This design only affects the *stock quantity* ledger.
2. **Opening-balance / periodic adjustment is a standing, repeatable feature** — usable once at first system adoption, and again every time a physical count is taken (e.g. before a new tax year), not a one-off migration tool.
3. **An adjustment always targets ส่วนกลาง (the central site)**, never a job site directly — matching how the whole stock model already treats ส่วนกลาง as the general pool.
4. **Adjustment semantics: the admin enters the *actual counted* quantity and cost/unit; the system computes and records the difference.** This is a "correct to match reality" action, not an additive purchase — confirmed directly ("ปรับยอดในระบบให้ตรง...ส่วนต่างที่หายไปถือเป็นของที่ใช้ไปแล้ว").
5. **New inventory-category taxonomy**, mirroring `sites`' existing cost-breakdown labels exactly (อลูมิเนียม/เหล็ก, กระจก, อุปกรณ์, ซิลิโคน/ยาง, plus a general "อื่นๆ"), attached to every `inventory_items` row. Used now only for filtering; **not** wired to any automatic per-category cost posting on `sites` in this design (explicitly deferred).
6. **Invoice-to-stock is a ratio, not a line-item match.** When an invoice is processed, deduct stock value equal to a **material-cost percentage of the invoice's pre-VAT amount** (tenant-configurable, default **70%**), then split that material value across categories by **tenant-configurable percentages that must sum to 100%** (defaults: aluminum 35%, glass 35%, equipment 15%, rubber/silicone 15%). Both the overall material % and the per-category split are editable per-invoice at processing time, not just as global defaults.
7. **Sourcing order per category: site stock first, ส่วนกลาง second.** If a category's target value exceeds what's physically at the invoice's site, take everything available there, auto-transfer the shortfall in from ส่วนกลาง to cover as much as possible, and if even that's insufficient, deduct whatever total is available and surface the unmet amount as a clear warning — never block, never fabricate a negative balance (consistent with this system's existing non-blocking posture — see Ruling E from the original Phase 1 plan).
8. **This entire mechanism lives inside the Inventory page as a reviewable queue, not an automatic side effect of creating an invoice.** `Invoices.jsx` is untouched. A new tab lists invoices whose stock impact hasn't been processed yet, shows the computed breakdown for review/edit, and only posts movements when the admin explicitly confirms — mirroring the same "preview before posting" discipline already used for PO receipts.
9. **The Inventory page's tabs are restructured**, per the business owner's explicit request: the old "รายการสินค้าคงคลัง" (item CRUD) and "มูลค่าสต็อก" (valuation) tabs merge into one — a single table showing every item's current balance, category, unit cost, total value, per site, plus a "แหล่งที่มาล่าสุด" (most recent source) indicator, with inline editing of quantity/cost for ส่วนกลาง rows serving as the adjustment mechanism from decision 4. New final tab order: **(1) รายการสินค้าคงคลัง** (merged item+balance view, includes adjustment), **(2) ตัดสต็อกจากใบแจ้งหนี้** (new — the invoice-deduction queue from decisions 6-8), **(3) หน้าตัดอลูมิเนียม** (unchanged, aluminum profile master), **(4) ประวัติการเคลื่อนไหว** (unchanged, the append-only ledger — this stays completely separate from the merged view in decision 9, since it's a passive audit trail, not an editable working view).

## Data model

### `inventory_categories` — the category lookup

```sql
CREATE TABLE inventory_categories (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id   UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  name        TEXT NOT NULL,
  sort_order  INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Same RLS shape as every other inventory table (`is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders')`). New tenants get 4 rows seeded automatically at signup (extending `handle_new_user()`'s existing per-tenant seed step, the same mechanism that already seeds `expense_categories`/`site_phases`): "อลูมิเนียม/เหล็ก", "กระจก", "อุปกรณ์", "ซิลิโคน/ยาง" — matching `sites`' cost-breakdown labels exactly. Tenants can add more (e.g. "อื่นๆ") the same way they add expense categories today.

### `inventory_items` gains a category link

```sql
ALTER TABLE inventory_items ADD COLUMN category_id UUID REFERENCES inventory_categories(id) ON DELETE SET NULL;
```

Nullable — an uncategorized item still works everywhere exactly as today, just doesn't appear when the price list is filtered to a specific category.

### `record_stock_movement()` gains `'adjustment'` support

The function's signature does not change. What changes is what `p_quantity`/`p_unit_cost` *mean* when `p_movement_type = 'adjustment'`:

- For `'purchase_in'`/`'transfer_in'`/`'transfer_out'` (unchanged): `p_quantity` is the amount moving, always positive.
- For **`'adjustment'`** (new): `p_quantity` is the **new absolute `quantity_on_hand`** the admin has counted, and `p_unit_cost` is the **new absolute `weighted_average_cost`** — not a delta, not a blend. The function computes `delta = p_quantity - old_qty`, writes `stock_movements.quantity = delta` (which **may be negative** — the only movement type permitted to store a negative quantity; every other type keeps requiring `p_quantity > 0`), and sets `inventory_stock_balances` to exactly `(p_quantity, p_unit_cost)`, not a blended figure. `stock_movements.unit_cost` for an adjustment row stores the new absolute cost/unit (the counted value), not "the cost of the delta" — there is no meaningful per-unit cost for a shrinkage write-off, and this keeps the row's meaning legible on the movement-history screen ("ปรับยอดเป็น 45.5 ตรม. @ 120/ตรม.").
- Validation for `'adjustment'` differs from the other types: `p_quantity` (the new absolute count) must still be `>= 0` (physical stock can't be negative), but unlike every other movement type it may legitimately be `0` (fully depleted) — the resulting *delta* stored in `stock_movements.quantity` can be positive, negative, or exactly zero (re-confirming an unchanged count is a valid, auditable no-op action, not an error).
- Tenant-ownership and privilege checks (Ruling D from Phase 1) apply identically to this new branch — no exception.
- `'sale_out'`/`'sale_reversal'` (already reserved in the CHECK constraint, never implemented) are implemented by this design too — see Business Logic below. Their `p_quantity` semantics match the original `purchase_in` convention: always positive, direction implied by type.

## Business logic

### Opening balance / periodic adjustment (decisions 2-4)

On the merged "รายการสินค้าคงคลัง" tab, each row showing a ส่วนกลาง balance has its quantity and cost/unit editable inline. Saving a changed value calls `record_stock_movement(item_id, ส่วนกลาง's site_id, 'adjustment', <entered quantity>, <entered cost>, 'manual_adjustment', null, null)`. Rows for any other site are **not** editable here (decision 3) — their quantities only ever change via PO receipt, site-completion transfer, or (new) invoice-ratio deduction.

### Invoice-ratio COGS deduction (decisions 6-8)

**Settings** (tenant-level defaults, stored as one JSON row in the existing `app_settings` key-value table under key `'inventory_cogs_ratio'`): `{ "material_pct": 70, "category_splits": { "<aluminum category id>": 35, "<glass category id>": 35, "<equipment category id>": 15, "<rubber category id>": 15 } }`. Editable from the same new tab (a small settings panel above the queue), and overridable per-invoice at processing time without changing the saved defaults.

**The queue.** The new "ตัดสต็อกจากใบแจ้งหนี้" tab lists every `invoices` row for which no `stock_movements` row exists with `reference_type = 'invoice' AND reference_id = <that invoice's id>` yet. For each: read the invoice's own `site_id` and pre-VAT amount (already on the `invoices` table — no `Invoices.jsx` change needed to produce this data), compute `material_value = amount_no_vat * material_pct / 100`, then `category_value[c] = material_value * category_splits[c] / 100` for each category. Show this breakdown editable (the admin can override either the overall material % or any category's split for this one invoice before confirming) with a live preview of what will be deducted from where, mirroring the PO-receive confirm dialog's existing preview pattern.

**Sourcing, per category, on confirm (decision 7):**
1. Find every `inventory_items` row in that category with a nonzero `inventory_stock_balances` row at the invoice's site.
2. Sum their value (`quantity_on_hand * weighted_average_cost`) at that site. If it covers `category_value[c]`, deduct proportionally: each item's `sale_out` quantity = `category_value[c] * (that item's site value / total site value in category) / that item's weighted_average_cost`.
3. If the site's total is less than `category_value[c]`: post `sale_out` for the site's *entire* available balance in that category (draining it to zero for those items), then attempt to cover the shortfall (`category_value[c] - site total`) from ส่วนกลาง the same way — proportionally across ส่วนกลาง's balances in that category, via a `transfer_out` at ส่วนกลาง + `transfer_in` at the site (same paired-movement pattern as Phase 1's site-completion transfer) for the quantity needed, followed by `sale_out` at the site for that newly-arrived amount.
4. If ส่วนกลาง *also* doesn't have enough: deduct everything available (site + ส่วนกลาง combined) and record the shortfall — the confirm screen shows this as a clear warning before the admin confirms (matching the `unconverted` warning pattern already shipped tonight for the dual-unit-conversion receive flow), never blocking the action.
5. Every `sale_out` movement (and any `transfer_out`/`transfer_in` used to backfill) carries `reference_type = 'invoice'`, `reference_id = <the invoice's id>` — this is what makes an invoice "processed" and removes it from the queue.

### Cancelling a processed invoice

Not automated in this design — `Invoices.jsx` is untouched, so there is no signal when an invoice is cancelled or edited after its stock impact was posted. If a correction is needed, the admin uses the same ส่วนกลาง-only adjustment mechanism from decision 4 as a manual fix-it path. Flagged explicitly as an Open Question below for whether this needs a real solution later.

## UI: the restructured Inventory page

1. **รายการสินค้าคงคลัง** (merged item + balance view) — one table, one row per `(item, site)` balance that exists, plus a way to create a brand-new item (which starts with zero balances everywhere until a PO or an adjustment gives it one). Columns: ชื่อสินค้า, หมวดหมู่ (filterable dropdown, from decision 5/9), ไซท์งาน, ปริมาณ (editable only on ส่วนกลาง rows), ราคา/หน่วย (editable only on ส่วนกลาง rows), มูลค่ารวม, แหล่งที่มาล่าสุด (the most recent `stock_movements` row's `reference_type`/`reference_id` resolved to a human string: the PO number, "ปรับยอด", or "โอนจาก <site name>"), and the existing item-management actions (edit definition, unit-conversion mode/reference-area, delete).
2. **ตัดสต็อกจากใบแจ้งหนี้** (new) — the settings panel + queue from the Business Logic section above.
3. **หน้าตัดอลูมิเนียม** — unchanged from tonight's dual-unit-conversion work.
4. **ประวัติการเคลื่อนไหว** — unchanged; still the passive, complete audit trail. Every new movement type this design introduces (`adjustment`, `sale_out`, its backfill `transfer_out`/`transfer_in`) already renders correctly here since `MOVEMENT_TYPE_LABELS` already has entries for all of them from Phase 1.

## Edge cases

- **An item has no category set.** It simply never appears when the price-list filter is set to a specific category, and is skipped entirely by the invoice-ratio deduction logic (it can't be assigned a % of anything) — the admin must categorize an item before it participates in ratio deduction. Not an error, just inert.
- **An invoice's site has been deleted or the invoice has no `site_id`.** Such an invoice can't be processed through the queue (there's nothing to deduct against) — it's excluded from the queue entirely rather than shown with an unusable "confirm" action.
- **Two admins try to process the same invoice at once.** The `reference_type='invoice' AND reference_id=X` existence check happens at confirm time inside the same transaction pattern `record_stock_movement()` already uses (row-level lock via `FOR UPDATE` on the balance being touched) — a second concurrent confirm for the same invoice would still post a duplicate movement today, since there's no unique constraint prevents it. Flagged as an Open Question below.
- **A category's split percentages don't sum to 100%, or the material % is left blank.** The confirm screen validates and blocks confirmation (not a silent auto-normalize) until the numbers make sense — this is exactly the kind of judgment call that should never happen silently, unlike the system's usual non-blocking posture toward *physical stock* shortfalls.
- **An adjustment is entered for an item that has never had any stock_movements at all (a brand-new item).** `old_qty`/`old_wac` are both 0 (no existing balance row), so the "delta" is simply the entered quantity itself and the new WAC is exactly the entered cost — behaves correctly as a pure opening-balance entry, no special-casing needed.

## Open questions for the implementation plan

- **Duplicate-confirm race on the invoice queue** (edge case above) — whether to add a unique constraint or advisory lock keyed on `(reference_type, reference_id)` to make a double-confirm impossible rather than just unlikely. A planning-time decision, not fixed here.
- **Reversing a processed-then-cancelled invoice's deduction** — left as a manual adjustment for now (see Business Logic); whether this needs a dedicated "un-process this invoice" action later is a decision for a future iteration, not this one.
- **Exact proportional-distribution rounding** (splitting a category's target value across multiple items, and the resulting quantities against each item's own decimal precision) — a planning-time implementation detail, not a design-level ambiguity.

## Out of scope for this spec

- Any change to `Invoices.jsx` or the invoice creation/editing flow itself (explicit business-owner instruction).
- "เบิกไปผลิต" (material requisition at point of production use) in any form — explicitly rejected earlier in this conversation due to lack of staffing to operate it.
- Automatic reconciliation between actual category-deduction totals and `sites.cost_aluminum`/`cost_glass`/etc.'s existing manually-entered budget figures — the category taxonomy is designed to make this easy later, but no code connects them yet.
- Lot/batch tracking, scrap/remnant management — unchanged from Phase 1's original out-of-scope list; nothing here reopens them.
