# Aluminium Cost Catalog + Price Structure

> Builds on `2026-09-10-bom-template-engine-design.md` and `2026-09-29-bom-cost-factors-design.md` (both shipped). Read them first: this spec only documents what changes or is added. FacadeX-only: every table is gated by `has_module_access('estimation')` (`estimation` is in `EXPLICIT_ONLY_MODULES`, so no other tenant sees any of it).

## Problem

The estimation module prices an opening from `aluminum_profiles` matched by free-text `series`, with one `price_per_kg` per finish. Real quoting needs (1) a proper cost catalog — extruder → series → door/window type → components — where price basis differs per extruder (per kg, per piece, or both) and prices change over time, and (2) a project-level price build-up (profit, transport, protection, cleaning, PM, rounding, VAT) shaped like the owner's `price_structure.xlsx` (tab ELSY), ending in an export to Quotation.

All catalog tables are empty in the live CHANG DB (checked 2026-10-08); 2 estimation projects, 0 openings. No data migration is needed. The catalog is built as **new tables, separate from the legacy `aluminum_profiles` (read by PO receiving, gated by the `purchase_orders` module) and `aluminum_finishes` (carries `price_per_kg`)**, so the catalog depends only on the `estimation` module and prices exist in one place. Linking the catalog to the PO side is deferred until the owner is satisfied with it; Phase 2 repoints the engine to the new tables and retires `aluminum_finishes`.

## Goals

1. Cost database: **extruder (โรงรีด) → series → type → components**, with reuse of components across series/types.
2. Per-extruder price basis, per-extruder colour list, price history with effective dates, optional per-profile/per-series price override.
3. Project defaults (series, colour, infill, hardware set, labour ฿/m², profit %) overridable per item.
4. Price-structure table per project (ELSY layout), with adjustable profit/transport/protection/cleaning/waste/PM/rounding/VAT.
5. Export to Quotation, and re-export as a revision.

## Non-goals

- Automatic supplier price updates (manual entry now; see Decision 9).
- AI reading of drawings (the six item fields below are deliberately the schema AI will fill later).
- Changing how Quotation works for any tenant that lacks the estimation module.

## Data model

All tables: `tenant_id UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id)`, RLS `admin_full_access` = `is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation')`, index on `tenant_id`.

### Hierarchy
- `alu_providers(name, short_name, price_basis CHECK in ('per_kg','per_piece','both'), active)` — `short_name` is for the abbreviated series label (Decision 6).
- `alu_series(provider_id, name, is_base, active)` — `is_base` marks the base series every extruder has (กล่องร่อง, กล่องเรียบ).
- `door_window_types(name, category 'door'|'window', default_labour_per_sqm, active)` — global names (บานเลื่อน, บานเปิด, บานพับ, ประตูพับ…). `default_labour_per_sqm` is the DB-sheet "ค่าแรงต่อชุด" per type, expressed in ฿/m² (Decision 4).
- `alu_series_types(series_id, type_id)` — which types a series offers. No row = not offered.

### Components
- `alu_profiles` (new): `provider_id`, `name`, `drawing_no`, `family`, `thickness_mm`, `linear_weight_kg_per_m`, `default_length_m`, `image_url`, `active`. Legacy `aluminum_profiles` is left alone. **No separate shapes table**: a profile row is already "cross-section + thickness" (one row of the DB sheet), and cross-extruder grouping is `family`.
- `alu_series_profiles(series_id, profile_id, family)` — many-to-many reuse. `family` lives on the link because the same profile can play a different role in another series.
- `alu_finishes` (new): `provider_id`, `name`, `code`, `active`. Colours are per extruder and carry **no price**; prices exist only in `alu_kg_prices`. Legacy `aluminum_finishes` keeps serving the current engine until Phase 2.
- `alu_profile_variants(profile_id, finish_id, length_m)` — colour × stock length; carries piece prices.
- `alu_parts(provider_id nullable, name, kind 'hardware'|'hardware_set'|'accessory', unit)`; `alu_part_set_items(set_id, part_id, quantity)`; `alu_series_parts(series_id, type_id nullable, part_id)`. A hardware set is linked to the type(s) it is used with (DB sheet column "ใช้กับชุด").

### Prices (all append-only; lookup = latest row with `effective_from <= asOf`)
Every price table has `effective_from DATE NOT NULL`, `source TEXT NOT NULL DEFAULT 'manual'`, `created_at`.
- `alu_kg_prices(provider_id, finish_id, series_id NULL, profile_id NULL, price_per_kg)` — precedence: profile > series > provider×finish.
- `alu_piece_prices(variant_id, price_per_piece)`.
- `alu_part_prices(part_id, list_price, discount_pct DEFAULT 0)` — effective price = `list_price × (1 − discount_pct/100)` (the equipment sheet carries "ลด 22%" style discounts).

Uniqueness: `(scope columns…, effective_from)` per price table, so `onConflict` names the real unique index (known trap).

### Estimation changes
- `bom_templates`: add `type_id` (→ `door_window_types`). A template is "the BOM for type X". Existing `family` text on components stays.
- `bom_template_hardware`: add `part_id` nullable; `reference_unit_price` remains the fallback.
- `estimation_projects`: add
  - defaults: `default_series_id`, `default_finish_id`, `default_infill_id`, `default_hardware_set_id`
  - rates (nullable; NULL = fall back to template/type): `labour_per_sqm`, `profit_pct`, `waste_pct`, `sealant_per_m`, `pm_pct`, `round_step` (default 10), `vat_pct` (default 7)
  - transport: `transport_trips`, `transport_km`, `transport_rate_per_km`, `transport_volume_m3_per_trip` (informational)
  - `protection_per_sqm`, `cleaning_per_sqm`
  - `price_as_of DATE NOT NULL DEFAULT current_date` — set once at creation, never moves on its own (Decision 3).
- `estimation_openings`: replace `series TEXT` with `series_id`, make `series_id`, `finish_id`, `glass_type_id`, `hardware_set_id` **nullable = inherit project default**; add `profit_pct`, `labour_per_sqm` (nullable overrides), `item_name`, `item_description`. `quantity` already exists. Add-on stays `addon_template_id` + its size.
- Export link (Decision 8): `estimation_exports(project_id, quotation_id)` and `estimation_export_items(opening_id, quotation_item_id, exported_unit_price, exported_quantity)`.

## Decisions

1. **Inheritance by NULL.** A NULL series/colour/infill/hardware/profit/labour on an item means "use project default"; the UI checkbox "ใช้ค่าโปรเจกต์" toggles NULL vs an explicit value. Resolution order for labour: item → project → `door_window_types.default_labour_per_sqm`.
2. **Availability warning.** Selecting a type not in `alu_series_types` for the resolved series shows a warning; changing the project default series lists the items affected. Not a hard block (the owner may be quoting something unlisted).
3. **Price lock + staleness.** Costs are computed with `asOf = estimation_projects.price_as_of`. The price-structure page shows a banner when any resolved component has a price row with `effective_from > price_as_of` ("มีราคาใหม่ N รายการ"). A later "refresh to latest prices" button just moves `price_as_of`; not in this spec.
4. **Labour.** Stored per type as a per-set concept but calculated as ฿/m² × item area, so it scales with size. Project default and item override as in Decision 1.
5. **Add-on.** The add-on picker lists templates whose `type_id` is offered by the *main item's* series (`alu_series_types`). Everything else about add-ons is unchanged.
6. **Series label.** Project-default pickers show `ชื่อซีรีส์ · ชื่อโรงรีด`. Per-item shows the short form `ชื่อซีรีส์ (short_name)`.
7. **Price computation.** New pure `resolveAluPrice({profile, finish, provider, series, asOf, prices})` returns `{basis, price_per_kg | price_per_m, source}`; per_kg = weight × price; per_piece = piece price ÷ stock length × cut length; `both` prefers per_kg then falls back to per_piece. No price found → the line is `unresolved` (never silently 0). `priceProfileLine` calls it instead of reading `finish.price_per_kg`; `resolveProfile` looks up through `alu_series_profiles` by `(series_id, family, thickness_mm)`. `computeBomForOpening` stays pure, one opening in, one BOM out.
8. **Quotation export** (below).
9. **Supplier price updates.** Manual entry first. Price rows are source-agnostic (`source` column), so a later importer (supplier price list → staging → owner approves → price rows, in the style of the existing PO document extraction) needs no schema change. Not built here.

## Price structure (per project)

Per item, quantities `W, H` (m), `qty`, `A = W×H`, `P = 2(W+H)`. Mirrors tab ELSY:

| Step | Rule |
|---|---|
| Aluminium | engine `aluminumSubtotal` |
| Waste (เผื่อเศษ) | `waste_pct` × aluminium (item→project→template). For per-kg extruders this equals a % of aluminium weight |
| Hardware | hardware set cost, `list × (1 − discount%)` |
| Glass/infill | existing infill cost (stored ฿/m²; the sheet's ฿/ft² list price is converted at data entry) |
| Labour | `A × labour_per_sqm` |
| Sealant | `P × sealant_per_m` (felt as already implemented) |
| Extra lines | existing `extra_lines` (fire barrier, bracket, bending…) |
| **Cost (รวมต้นทุน)** | sum of the above except waste |
| Profit | `cost × profit_pct` (item→project) |
| **Sale (ราคาขาย)** | cost + waste + profit |
| Additional cost pool | one lump per project: transport `trips × km × rate_per_km` + protection `rate × 2 × ΣA×qty` (both faces) + cleaning `rate × 2 × ΣA×qty`. Spread over items by cost (below) |
| Additional cost per set | `pool ÷ Σ(cost × qty) × cost` |
| PM | `ROUNDUP(pm_pct × cost)` — base is the item's cost (รวมต้นทุน) |
| **Price per set** | sale + additional cost per set + PM, then `ROUNDUP` to `round_step` (default 10 ฿) → "ราคาขายจริง" |
| Line total | price per set × `qty` |

Project footer: Σ line totals, VAT (`vat_pct`), Total. Also shown for sanity: price per set per m² (ELSY col AE).

**Spreading rule (owner decision 2026-10-08, differs from ELSY).** Transport, protection and cleaning are summed into one pool and spread in proportion to cost: `additional per set = pool ÷ Σ(cost × qty) × item cost`, then multiplied by `qty` in the line total. "Cost" is the item's รวมต้นทุน (excludes waste and profit). Protection and cleaning are therefore no longer weighted by area; area only sets the size of the pool.

## Item flow (UI)

Project page: default panel (series · colour · infill · hardware set · labour ฿/m² · profit %) and a cost-settings panel; item table below.

Item = six fields, shared with the future AI reader: **1** name, **2** size, **3** type ± add-on, **4** colour, **5** infill/spec, **6** hardware set. 4–6 inherit the project default with an untick-to-override checkbox. Add/edit opens a **modal pre-filled with the existing values**. The type/add-on picker shows a **double-line SVG preview** of the frame with dimensions, drawn from the template grid (`resolveGrid`) and add-on size. Quantity is typed by the user.

## Quotation export

- Each item becomes two `quotation_items` rows using the existing mechanism: an `item_type='item'` row (description = `item_name`, unit "ชุด", quantity = `qty`, unit_price = price per set after rounding) followed by an `item_type='item_description'` row (the auto-generated spec text, editable, e.g. "ประตูบานเปิดคู่ ขนาด 5.45 × 2.7 ม. อลูมิเนียมอบสีดำ … กระจกใส 10มม. …"). No new columns on `quotations`/`quotation_items`.
- `estimation_export_items` remembers which quotation row belongs to which opening and the exported price/quantity.
- **Update after the price structure changes:** "update quotation" is allowed **only while the linked quotation is a draft**. If it has been sent (status is not `draft`), the button is disabled with the message "ดึงใบเสนอราคากลับเป็นฉบับร่างก่อนจึงจะอัปเดตได้"; the user pulls it back using Quotation's existing pull-back action, then updates. Updating rewrites the linked rows in place (so invoiced rows are never deleted) and adds rows for new items. Revisions follow Quotation's existing rule unchanged: a snapshot + counter bump happen when `ever_sent` is true (i.e. a pulled-back quotation becomes the next revision); a draft that was never sent is simply overwritten. No change to Quotation's revision rules, so no effect on other tenants.
- **Editing the quotation directly never flows back** into the price structure. When such an edited quotation is next saved as a revision, or re-synced, and its items differ from `estimation_export_items`, the revision snapshot JSON gets an `estimation_note` ("ใบเสนอราคาไม่สอดคล้องกับ price structure"). It is shown only in the internal revision history, never on the printed quotation.
- **Safety for other tenants:** the note lives inside the existing `quotation_revisions.snapshot` JSONB, so no shared table gets a new column and tenants without estimation are unaffected. The hook in `Quotations.jsx` is guarded by `companyHasModule('estimation')` and a link lookup that returns nothing for unlinked quotations; the revision history view renders the note only when the key exists.

## Phasing

1. **Catalog**: migrations for the hierarchy/components/prices, `resolveAluPrice` + vitest, catalog management screens (extruder → series/types → profiles/colours/lengths → parts → prices).
2. **Engine + item flow**: reshape `estimation_openings`/`estimation_projects` (repoint `finish_id` to `alu_finishes`, profiles to `alu_profiles`, retire legacy `aluminum_finishes`), rewire `bomEngine.js`, project defaults, modal, preview, availability warnings, stale-price banner.
3. **Price structure + export**: cost-settings, price-structure table, rounding/VAT, Quotation export and update-as-revision.

Each phase merges and deploys on its own. Migrations are applied by the owner (`!`), not by the agent.

## Testing

- Rolled-back SQL: RLS across tenants, price lookup by date and by precedence, uniqueness, CHECK constraints.
- vitest: `resolveAluPrice` (all three bases, missing price, override precedence, `asOf`), `computeBomForOpening` (existing cases still pass with new inputs), price-structure math checked against ELSY rows (e.g. D1: size 5.45 × 2.7, qty 2 → known columns V, X, Y, AB, AD).
- Known traps to check per migration: views using `x.*` freeze their column list; `onConflict` must match the real unique index; PostgREST embeds with FKs in both directions need the exact constraint name.

## Owner decisions on the ELSY open items (2026-10-08)

- PM base is the item's cost (รวมต้นทุน), not the sale price.
- Transport + protection + cleaning form one pool, spread by cost value.
- Rounding is up to the nearest 10 ฿ on the final price per set only (the sheet also rounded glass up by 10 per item; that is dropped).

"ปัดหลัก 10 บาท" means round **up** to a multiple of 10, like ELSY's `ROUNDUP` (confirmed by the owner).
