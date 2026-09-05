# Inventory Module — Dual-Unit Conversion for Glass & Aluminum — Design

## Purpose

Phase 1 of the inventory module (shipped 2026-09-05, live on `main`) built a real stock ledger with weighted-average costing for materials bought via Purchase Orders. Its unit-conversion model covered exactly two cases: no conversion (purchase unit = stock unit), and a fixed factor stored once per item (e.g. "1 piece = 2.3 kg"). Ruling F in that plan explicitly deferred a harder case — "glass-style per-transaction dimension entry" — as future work.

This spec is that future work, refined through direct conversation with the business owner. It covers two materials whose purchase unit and stock unit differ in ways a fixed factor can't express:

- **Glass**: bought by the sheet, stocked/costed by area (ตร.ม.) — and sheets of the same spec vary in size from purchase to purchase, so there is no single fixed factor per item.
- **Aluminum profiles**: bought by the rod, stocked/costed by weight (กก.) — where the conversion factor (kg per meter) depends on which cross-section profile was ordered, but the resulting stock pools by *color*, not by profile.

Also in scope: a report that approximates "how many physical sheets does this area balance represent," requested for Revenue Department (สรรพากร) physical stock-count purposes.

Out of scope (explicitly deferred by the business owner, not part of this spec): lot/serial tracking of individual physical sheets or rods, and scrap/remnant (off-cut) management — both noted as "reserve for later" with no defined requirements yet.

## Current system facts this design depends on

- **`inventory_items`** (id, tenant_id, name, base_unit, active) — one row per stockable thing, one running weighted-average cost per `(item, site)` in `inventory_stock_balances`. No material-type flag exists yet — every item today conceptually behaves the same way until this spec adds a way to distinguish them (see Data Model below).
- **`inventory_item_unit_factors`** (inventory_item_id, unit_name, factor_to_base) — a *fixed* ratio stored once per item, e.g. "1 piece = 2.3 kg." Cannot express glass (ratio varies per purchase) or aluminum (ratio depends on which profile, not which item/color).
- **`purchase_order_items`** already has a nullable `inventory_item_id` (added in Phase 1) linking a PO line to a stockable item. `PurchaseOrders.jsx`'s `receiveStockPlan(po)` function computes, for each linked PO line, a `baseQty` (quantity converted to the item's base unit) and `unitCostPerBase` (that line's total cost divided by `baseQty`) — this is the single function that both the pre-confirm preview and the actual `record_stock_movement()` RPC call read from. Today it has exactly two branches: use a matching unit-factor row if one exists, else assume the PO line's unit already *is* the base unit (1:1).
- **`record_stock_movement()`** (the RPC that posts a `stock_movements` row and recalculates the `(item, site)` balance's weighted-average cost) takes an already-computed `p_quantity`/`p_unit_cost` in base units — it has no notion of profiles, dimensions, or purchase units at all, and this spec does not change it. Everything new here happens *before* that RPC is ever called, inside the client-side conversion step.
- **Design decision #4** from the original Phase 1 spec: pooled stock, no lot/batch tracking — an item's stock is one running quantity + one running weighted-average cost per location, not traceable back to which specific delivery a unit came from. This spec's approach to the physical-count report (below) is deliberately chosen to preserve this decision rather than reverse it.

## Decisions made (via direct conversation with the business owner)

1. **Glass sheet sizes genuinely vary per purchase** — confirmed directly. There is no standard size per spec that would let glass reuse the existing fixed-factor mechanism. Every PO line for glass must capture its own width × height.
2. **The physical-sheet-count report is an approximation, not an exact reconciliation.** The business owner explicitly chose this over reversing decision #4 to add lot-tracking: stock stays pooled by area; the report divides the pooled area by a reference/nominal sheet size set once per glass spec, giving a "roughly N sheets" figure for สรรพากร, not a guarantee that N *specific* physical sheets exist.
3. **Aluminum stock pools by color, not by profile.** Receiving "หน้าตัด X สี Y จำนวน Z เส้น" adds weight to a single stock pool for "อลูมิเนียม สี Y" (one `inventory_item` per color, exactly like today). The profile only determines *how many kg* those Z rods weigh — it has no separate stock pool of its own. This means aluminum needs a small standalone lookup table (profile → kg/m), not a restructuring of `inventory_items`.
4. **Every aluminum profile has a linear weight (kg/m) and a default rod length.** The business owner confirmed rods are cut to a standard length (6.4 m) that occasionally gets customized per order, but not often. The default pre-fills the receive form; the actual value used is always stored on the PO line for audit, since it directly affects the weight calculation.
5. **Scrap/remnant management stays fully out of scope for this spec** — no schema placeholder is added for it. When it's actually needed, it gets its own brainstorm (adding speculative structure now for undefined requirements would violate this project's YAGNI discipline, and — per decision #2 above — would need to reckon with the same pooled-vs-lot-tracking tension this spec deliberately avoided).

## Data model

### `inventory_items` gains a conversion-mode flag

The system needs to know, at PO-receive time, *which* new input fields to show for a given linked item — there's no way to infer "this is glass" vs "this is aluminum" vs "plain" from the existing columns.

```sql
ALTER TABLE inventory_items ADD COLUMN unit_conversion_mode TEXT NOT NULL DEFAULT 'plain'
  CHECK (unit_conversion_mode IN ('plain', 'aluminum_profile', 'glass_dimension'));
```

- `'plain'` (default): today's behavior, unchanged — fixed-factor lookup if one exists, else 1:1. Every item created before this spec keeps working exactly as it does today.
- `'aluminum_profile'`: the PO-line receive form shows a profile picker + rod length instead of relying on a stored unit factor.
- `'glass_dimension'`: the PO-line receive form shows width/height inputs.

### `aluminum_profiles` — the profile lookup, independent of color

```sql
CREATE TABLE aluminum_profiles (
  id                     UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id              UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  name                   TEXT NOT NULL,               -- e.g. "หน้าตัด X"
  linear_weight_kg_per_m NUMERIC NOT NULL,             -- กก./เมตร
  default_length_m       NUMERIC NOT NULL DEFAULT 6.4,
  active                 BOOLEAN NOT NULL DEFAULT true,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Not an `inventory_item` — it has no stock, no cost of its own, and is never referenced by `stock_movements`. It exists purely to answer "how many kg is this rod" at the moment a PO line is being converted to base units. The *same* profile can feed into many different color pools across different POs.

### `inventory_items` gains a reference area, for the sheet-count report

```sql
ALTER TABLE inventory_items ADD COLUMN reference_area_sqm NUMERIC;
```

Nullable; only meaningful for a `'glass_dimension'`-mode item. Set once per glass spec (e.g. "กระจก 6มม.ใส" → `2.88` for a nominal 1.2×2.4m sheet). Used only by the report in the Reporting section below — never by the stock ledger itself.

### `purchase_order_items` gains the raw inputs needed for conversion + audit trail

```sql
ALTER TABLE purchase_order_items ADD COLUMN aluminum_profile_id UUID REFERENCES aluminum_profiles(id) ON DELETE SET NULL;
ALTER TABLE purchase_order_items ADD COLUMN rod_length_m NUMERIC;
ALTER TABLE purchase_order_items ADD COLUMN glass_width_m NUMERIC;
ALTER TABLE purchase_order_items ADD COLUMN glass_height_m NUMERIC;
```

All nullable — only populated when the line is linked to an item in the matching conversion mode. Storing the raw inputs (which profile, what length; what width/height) rather than only the computed kg/sqm keeps the PO document itself meaningful ("20 เส้น หน้าตัด X ยาว 6.4ม." prints correctly) and gives a complete audit trail for how a stock quantity was derived, matching the spirit of `stock_movements` already being an append-only, explainable ledger.

## Business logic

### Receive-time conversion (extends `receiveStockPlan()` in `PurchaseOrders.jsx`)

For each PO line linked to an `inventory_item`, in order:

1. If the item's `unit_conversion_mode = 'aluminum_profile'` and the line has an `aluminum_profile_id` set: `baseQty (kg) = quantity (rods) × rod_length_m × profile.linear_weight_kg_per_m`. `unitCostPerBase = (quantity × unit_price) / baseQty` — the same "total line cost ÷ converted base quantity" pattern Phase 1 already uses for its VAT adjustment, applied here too if the PO is VAT-inclusive.
2. Else if the item's `unit_conversion_mode = 'glass_dimension'` and the line has `glass_width_m`/`glass_height_m` set: `baseQty (sqm) = quantity (sheets) × glass_width_m × glass_height_m`. `unitCostPerBase` computed the same way.
3. Else, fall through to Phase 1's existing logic unchanged: a matching `inventory_item_unit_factors` row if one exists, else 1:1.

This is a strict extension of the existing function — cases 1 and 2 are new branches checked first; every item that doesn't use the new modes (everything received before this spec, and every future plain/fixed-factor item) falls through to exactly the code that already shipped and was reviewed.

A PO line whose sheets/rods aren't all the same size/length still fits the existing multi-line PO editor: each distinct size or length is simply its own line, exactly like any other PO today.

### Receive-time UI

- Linking a PO line to an `'aluminum_profile'`-mode item shows: a profile picker (from `aluminum_profiles`, active items only) and a "ความยาว (ม.)" field pre-filled from the chosen profile's `default_length_m`, editable.
- Linking a PO line to a `'glass_dimension'`-mode item shows: "กว้าง (ม.)" and "ยาว (ม.)" fields, both required before the line can be saved.
- The existing per-item stock preview (shown in the receive confirm dialog before posting) uses the same conversion logic, so what's previewed always matches what's posted — continuing this project's established single-source-of-truth discipline for this exact class of calculation.

### Setting up a new aluminum color or glass spec

- Creating an `inventory_item` gains a `unit_conversion_mode` selector (default `'plain'`) on the Inventory page's item form. Choosing `'glass_dimension'` also reveals the `reference_area_sqm` field. Choosing `'aluminum_profile'` needs no extra field on the item itself — profiles are managed separately.
- `aluminum_profiles` get their own small CRUD section on the Inventory page (name, kg/m, default length), parallel to how unit-conversion factors are already managed there for other items.

## Reporting

**Approximate physical sheet count**, added to the existing valuation report (`Inventory.jsx`'s "มูลค่าสต็อก" view): for any balance whose item has `unit_conversion_mode = 'glass_dimension'` and a non-null `reference_area_sqm`, show an additional column — `quantity_on_hand / reference_area_sqm`, rounded and labeled clearly as an estimate (e.g. "≈ 15.8 แผ่น (อ้างอิงขนาด 1.2×2.4ม.)"). Items without a `reference_area_sqm` set simply show no estimate, rather than a misleading number.

The existing "ประวัติการเคลื่อนไหว" (movement ledger) view already satisfies the Stock Card requirement as shipped in Phase 1 — it shows every movement in the item's base unit with a running effect on the balance. No changes needed there.

## Edge cases

- **A plain item (e.g. a door handle) is unaffected end-to-end.** `unit_conversion_mode` defaults to `'plain'`; no new fields appear anywhere for it.
- **A glass-mode item's PO line is saved without width/height.** Client-side validation blocks this before save, the same way `quantity`/`description` are already required today — a glass-type line with no dimensions has no way to compute a stock effect at all.
- **An aluminum profile is deactivated while still referenced by old PO lines.** `ON DELETE SET NULL` (matches Phase 1's existing `inventory_item_id` pattern) — the historical PO line keeps its stored `rod_length_m` and computed effect; only future new lines lose the option to pick that profile.
- **Someone changes an item's `unit_conversion_mode` after it already has stock/history.** Not blocked (matches this project's generally non-blocking posture elsewhere), but only affects *future* PO lines — already-posted `stock_movements` rows and their stored raw inputs are historical fact and never recomputed.
- **`reference_area_sqm` is left unset for a glass item.** The valuation report simply omits the estimate column's value for that row (see Reporting above) — never divides by null or shows a wrong number.

## Open questions for the implementation plan

- **Exact UI placement** for the profile picker/rod-length fields and the width/height fields within the existing PO `ItemsEditor` component (which already has a similar collapsible "📦 ผูกกับสต็อก" sub-row from Phase 1) — a planning-time layout decision, not fixed here.
- **`aluminum_profiles` RLS** — proposed as the same shape as every other Phase 1 table: `admin_full_access`, tenant-scoped, gated on `has_module_access('purchase_orders')` (consistent with Ruling A from the Phase 1 plan — this is still buying-side functionality, not a new paid module).

## Out of scope for this spec

- Lot/serial tracking of individual physical sheets or rods (decision #2 deliberately avoids this).
- Scrap/remnant (off-cut) management in any form (decision #5).
- Any change to `record_stock_movement()`, `inventory_stock_balances`, or `stock_movements` — this spec is entirely about computing the right numbers *before* that existing, already-shipped machinery is called.
- Sell-side integration (still the original spec's Phase 2 — catalog linking, invoice-triggered COGS — untouched and unrelated to this work).
