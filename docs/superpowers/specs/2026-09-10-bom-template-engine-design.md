# BOM Template Engine — Design

## Problem

FacadeX quotes and orders aluminum doors/windows using two hand-maintained Excel files (`Aluminium calculation_270116-1.xlsx`, `price_structure.xlsx`). Reading those files (with the business owner, this session) surfaced the real bottleneck: it isn't the dimension data — it's that **every aluminum series/type (ทั่วไป, ยูโร, วิสดอม, Curtainwall, Unitized...) and every door/window product type (swing door, awning, folding door, louvre...) has its own bill-of-materials logic**, hardcoded as one-off spreadsheet formulas across ~170 rows that only the business owner can read or safely extend.

Reading a supplier/client document with AI is already a solved, shipped pattern (`extract-po-document`, v1.15.x). Computing an accurate BOM and cost for an arbitrary door/window type, from structured inputs a non-expert can supply, is not — nothing in the platform today turns "opening dimensions + type + series + thickness" into a materials list or a price.

## Goal

Let a domain expert (the business owner, or another admin) define a door/window **type once** — as a `bom_template`: its components, how each component's length derives from the opening's width/height/panel count, which aluminum profile family it draws from, its hardware, its glass-area rule, and its size limits — using guided pickers, never a formula language. Once a template exists, **anyone** can get an accurate computed BOM and unit cost for an opening by picking a template, series, thickness, and typing width/height/quantity. No spreadsheet, no formula knowledge, at quote time.

## Non-goals (explicitly deferred to later specs)

- **AI drawing extraction** (reading W/H/qty/opening-ID off a PDF). Phase 1 ships with manual entry only; extraction is a follow-on spec that populates the same `estimation_openings` table this spec creates, through a second entry path.
- **Writing into `quotations` or `purchase_orders`.** This spec computes a BOM and a unit cost and stops there. Turning a project's openings into quotation line items, and summing them into PO line items, are each their own future spec — both read this spec's output, neither is built here.
- **Labour, and the materials-only vs. materials+installation toggle.** Confirmed (2026-09-10) as one toggle driving both the quoted price (labour included or not) and the eventual shipping plan (deliver-only vs. deliver-and-install) — but it's purely additive on top of this spec's per-unit materials cost, which is identical either way. It belongs entirely to the future Quotation-output spec (Phase 3a), not here; flagged so that spec doesn't have to rediscover it.
- **A general formula language.** Length rules are a fixed, small preset enum (see Data model). Anything that doesn't fit a preset uses the manual adjustment-line escape hatch (below), not a new formula feature.
- **Multi-admin template review/approval workflow.** Phase 1 uses the same admin/owner-only RLS shape every other module already uses; no separate review step.
- **A freeform skeleton/canvas editor.** Internal structure is a parametric grid (rows × columns, Decision 10), not a drag-and-drop drawing tool — deliberately, to stay inside "guided form" territory.
- **Mixed fill type per grid cell** (e.g. a glazed transom row over a solid bottom panel). Phase 1's grid assumes every cell is glazed identically; a per-cell fill-type override is a natural extension, not built now (see Open questions).

## Current system facts this design depends on

- **`aluminum_profiles`** (id, tenant_id, name, `linear_weight_kg_per_m`, `default_length_m`, active) already exists, shipped by the dual-unit-conversion spec. Today it's a flat catalog — `name` is a free-text label that happens to encode shape+series+thickness together (e.g. "หน้าตัด กล่องร่อง 1.2mm") — used only on the *procurement* side: `purchase_order_items.aluminum_profile_id` + `rod_length_m` convert "N rods" to kg via `computeAluminumWeightKg()` (`src/lib/inventoryCost.js`) for stock-ledger costing. It has no separate `series`/`thickness` fields, and nothing today computes a *sell-side* price from it.
- **`quotations` / `quotation_items`** already exist (status `draft→sent→accepted→rejected→expired`, `catalog_item_id` optional back-reference to a static `catalog_items` price list). This is the eventual home for BOM output — not touched by this spec.
- **`purchase_orders` / `purchase_order_items`** already exist, with the same "linked inventory item, review before saving" shape used throughout the app. Also the eventual home for BOM output — not touched by this spec.
- **`inventory_items`** (hardware/materials catalog, `unit_conversion_mode` flag) is priced via a *weighted-average cost* that only exists once stock has actually been received — there is no static "quoting reference price" on it, unlike `catalog_items.default_unit_price`. A brand-new hardware item can have a null/zero WAC. This spec does not read WAC for BOM costing (see Decision 6).
- **`tenant_modules`** gates every module behind a `CHECK (module_key IN (...))` allow-list (`payroll`, `labor_subcontractors`, `purchase_orders`, `client_deposits`, `quotations`, `invoices`, `cheque_tracking`) plus a mirrored `package_modules` table. Every RLS policy in the app follows the same shape: `is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('<key>')`.
- **`inventoryCost.js`** establishes the house style for this kind of math: small, pure, unit-tested JS functions mirroring what a DB-side function does, recomputed on demand rather than cached — this spec's BOM computation follows the same pattern.

## Decisions made (rulings from this session's design conversation, recorded so the plan doesn't re-litigate them)

1. **New module key: `estimation`.** Distinct capability from both `quotations` and `purchase_orders` — a tenant might want BOM/quoting without full PO workflow, or vice versa. Matches the existing one-module-per-capability pattern. Requires widening the `tenant_modules`/`package_modules` CHECK constraints.
2. **`aluminum_profiles` gains three nullable columns** — `family TEXT`, `series TEXT`, `thickness_mm NUMERIC` — instead of a new parallel table. Existing rows (and the procurement-side PO flow that reads them) keep working unchanged with these left null; new rows imported for BOM use populate all three so a `(family, series, thickness_mm)` triple resolves to exactly one profile at BOM-compute time.
3. **Finish pricing is decoupled from profile weight**, matching the source workbook: a new `aluminum_finishes` table (name, `price_per_kg`) is selected per opening (not baked into the profile), and BOM cost = Σ(component weight) × finish price/kg.
4. **Glass is a picked catalog, not a template rule.** A new `bom_glass_types` table (name, `price_per_sqm`) is selected per opening, same UX as series/thickness/finish. The *template* only defines the area formula (width/height deduction in mm) — which glass fills that area is the estimator's choice, same reasoning as series/thickness (confirmed earlier this session: the estimator picks it, the drawing doesn't specify it).
5. **Hardware gets its own reference price, not a live WAC lookup.** `bom_template_hardware.reference_unit_price` is a static, editable number (same spirit as `catalog_items.default_unit_price`) — reading `inventory_items`' weighted-average cost would make BOM totals fluctuate with unrelated stock activity and break for hardware with no stock yet. An optional `inventory_item_id` FK is kept for traceability/reporting only, never for pricing.
6. **Constraints are warning-only in Phase 1.** A violated limit (e.g. max span) shows a banner; it never blocks saving an opening. Hard-blocking is a plausible Phase 1.1 toggle, deliberately not built now — reversible either way, and shipping the warning first is lower-risk.
7. **Escape hatch: a manual adjustment line, not a new preset.** One-off costs that don't fit any component/hardware rule (curved bending, Fire Barrier, a bracket) are added as a free-text `{ description, amount }` line directly on an opening (`estimation_openings.extra_lines`, a JSONB array), editable per opening. This keeps the template preset vocabulary small instead of growing it to cover every rare case.
8. **Template authorship: admin/owner only, no approval workflow** — same RLS shape as every other module (`is_admin_or_owner()`). If misuse becomes a real problem later, that's a new, separate spec.
9. **Phase 1 persists openings, grouped by project** (`estimation_projects` → `estimation_openings`), even though AI drawing extraction (which would auto-populate these rows) is out of scope here. Building the table now, with only a manual-entry form on top, means the drawing-extraction spec adds a second way to create the same rows rather than a new table — the two specs share one data model instead of needing a later migration to unify them.
10. **Internal structure (mullions/rails) is a parametric grid, not a freeform skeleton canvas.** Raised mid-session: a door/window's repeating internal members (transom rails, mullions between panels) should scale dynamically with the opening's actual size rather than being individually hand-specified per template. A full drag-and-drop skeleton editor was considered and rejected as overkill — it's real UI engineering, not a form, and fights the "non-expert, no canvas, no formulas" goal as hard as a formula language would. A **grid** gets the same dynamic-sizing win parametrically: a template declares `grid_row_weights` (template-fixed — e.g. a transom split) and the opening supplies its own column count (`panel_count`, equal-width columns) at quote time, since leaf/panel count is something that varies order-to-order on the same template while a transom split is a property of the type itself. See Data model and Business logic below.

## Data model

```sql
-- Extends the existing procurement-side catalog with the axes BOM
-- components need to resolve an exact profile. All three nullable: existing
-- rows, and the PO flow that already reads this table, are unaffected.
ALTER TABLE aluminum_profiles ADD COLUMN family TEXT;
ALTER TABLE aluminum_profiles ADD COLUMN series TEXT;
ALTER TABLE aluminum_profiles ADD COLUMN thickness_mm NUMERIC;

-- Finish price/kg, decoupled from profile weight (Decision 3).
CREATE TABLE aluminum_finishes (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id   UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  name        TEXT NOT NULL,          -- e.g. "POWDER COATING SAHARA"
  price_per_kg NUMERIC NOT NULL,
  active      BOOLEAN NOT NULL DEFAULT true
);

-- Glass price/sqm catalog, picked per opening (Decision 4).
CREATE TABLE bom_glass_types (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id     UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  name          TEXT NOT NULL,        -- e.g. "กระจกใส 10มม."
  price_per_sqm NUMERIC NOT NULL,
  active        BOOLEAN NOT NULL DEFAULT true
);

-- One row per door/window type. glass_*_deduction_mm is applied PER GRID
-- CELL now, not once for the whole opening (Decision 10). waste_pct
-- applies to the aluminum subtotal only, mirroring where the source
-- workbook applies its ~10% allowance.
--
-- grid_row_weights: template-fixed row split, e.g. '[1]' (no internal
-- horizontal rail) or '[0.25, 0.75]' (a short transom row + a tall main
-- row). Column count is NOT stored here -- it's supplied per opening via
-- estimation_openings.panel_count (Decision 10: leaf/panel count varies
-- order to order on the same template; a transom split doesn't).
-- grid_*_family are the profile family for grid-DERIVED internal members
-- only (perimeter rails/stiles/lock-rail stay explicit bom_template_components
-- rows, unchanged). Null means "this template has no internal member of
-- that orientation" -- e.g. grid_vertical_mullion_family is null for a
-- template that's never quoted with panel_count > 1.
CREATE TABLE bom_templates (
  id                          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id                   UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  name                        TEXT NOT NULL,       -- e.g. "Swing Door · 2 Leaf · General"
  category                    TEXT NOT NULL CHECK (category IN ('door','window')),
  waste_pct                   NUMERIC NOT NULL DEFAULT 10,
  glass_width_deduction_mm    NUMERIC NOT NULL DEFAULT 0,
  glass_height_deduction_mm   NUMERIC NOT NULL DEFAULT 0,
  grid_row_weights            JSONB NOT NULL DEFAULT '[1]',   -- e.g. [0.25, 0.75]
  grid_horizontal_rail_family TEXT,                            -- profile family, or null
  grid_vertical_mullion_family TEXT,                           -- profile family, or null
  active                      BOOLEAN NOT NULL DEFAULT true,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per explicit, non-repeating component (top rail, bottom rail,
-- side jamb, stile, lock rail...). Repeating internal members (transom
-- rails, panel mullions) are NOT rows here any more -- the grid on
-- bom_templates derives their count/length automatically (Decision 10).
-- length_rule_type is a small preset enum, not a formula language.
CREATE TABLE bom_template_components (
  id                    UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id             UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  template_id           UUID NOT NULL REFERENCES bom_templates(id) ON DELETE CASCADE,
  role_name             TEXT NOT NULL,           -- e.g. "Top rail" -- label only
  profile_family        TEXT NOT NULL,           -- matches aluminum_profiles.family
  length_rule_type       TEXT NOT NULL CHECK (length_rule_type IN
                          ('width','height','width_minus','height_minus','perimeter')),
  length_deduction_mm    NUMERIC NOT NULL DEFAULT 0,   -- used by the '_minus' variants
  quantity_basis         TEXT NOT NULL CHECK (quantity_basis IN ('fixed','per_cell')),
  quantity_value         NUMERIC NOT NULL DEFAULT 1,   -- e.g. 2 (stiles), or the base count for 'fixed'
  sort_order              INT NOT NULL DEFAULT 0
);

CREATE TABLE bom_template_hardware (
  id                    UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id             UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  template_id           UUID NOT NULL REFERENCES bom_templates(id) ON DELETE CASCADE,
  name                  TEXT NOT NULL,             -- e.g. "Hinge"
  reference_unit_price  NUMERIC NOT NULL,          -- Decision 5: static, not WAC
  inventory_item_id     UUID REFERENCES inventory_items(id) ON DELETE SET NULL,  -- traceability only
  quantity_basis        TEXT NOT NULL CHECK (quantity_basis IN
                         ('fixed','per_cell','per_perimeter_m')),
  quantity_value        NUMERIC NOT NULL DEFAULT 1,
  sort_order             INT NOT NULL DEFAULT 0
);

-- Warning-only limits (Decision 6).
CREATE TABLE bom_template_constraints (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id    UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  template_id  UUID NOT NULL REFERENCES bom_templates(id) ON DELETE CASCADE,
  rule_type    TEXT NOT NULL CHECK (rule_type IN
               ('max_width_mm','max_height_mm','max_span_mm','max_panel_count')),
  value        NUMERIC NOT NULL,
  message      TEXT NOT NULL          -- shown verbatim in the warning banner
);

-- A quotation-in-progress's openings, grouped by project (Decision 9).
-- No AI extraction path yet -- rows are created by the manual entry form
-- this spec builds. site_id/client_id nullable: an estimate may predate
-- either being decided.
CREATE TABLE estimation_projects (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id   UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  name        TEXT NOT NULL,
  client_id   UUID REFERENCES clients(id) ON DELETE SET NULL,
  status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','reviewed')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE estimation_openings (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id     UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  project_id    UUID NOT NULL REFERENCES estimation_projects(id) ON DELETE CASCADE,
  opening_no    TEXT NOT NULL,          -- "D1", "W5" -- free text, user-assigned in Phase 1
  template_id   UUID NOT NULL REFERENCES bom_templates(id) ON DELETE RESTRICT,
  series        TEXT NOT NULL,          -- matches aluminum_profiles.series (Decision: estimator picks, confirmed this session)
  thickness_mm  NUMERIC NOT NULL,       -- matches aluminum_profiles.thickness_mm
  finish_id     UUID NOT NULL REFERENCES aluminum_finishes(id) ON DELETE RESTRICT,
  glass_type_id UUID REFERENCES bom_glass_types(id) ON DELETE RESTRICT,  -- null for a type with no glass
  width_m       NUMERIC NOT NULL,
  height_m      NUMERIC NOT NULL,
  panel_count   INT NOT NULL DEFAULT 1,   -- grid COLUMN count for this opening (Decision 10) -- equal-width columns, not stored on the template
  quantity      INT NOT NULL DEFAULT 1,
  extra_lines   JSONB NOT NULL DEFAULT '[]',   -- Decision 7: [{ description, amount }]
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

All nine new/altered tables get the standard RLS shape used everywhere else in the app:

```sql
CREATE POLICY admin_full_access ON <table> FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation'));
```

`tenant_modules`/`package_modules` CHECK constraints widen to include `'estimation'` in their allow-lists (mechanical migration, same shape as every prior module addition).

## Business logic — the BOM computation

Pure, client-side, no I/O once its inputs are loaded — same style as `inventoryCost.js`. New file: `src/lib/bomEngine.js`.

```
computeBomForOpening(opening, template, components, hardware, profiles, finish, glassType)
  → {
      profileLines: [{ role_name, family, series, thickness_mm, length_m, quantity, weight_kg, cost, resolved: bool }],
      gridLines: [{ orientation: 'horizontal'|'vertical', family, length_m, quantity, weight_kg, cost, resolved: bool }],
      hardwareLines: [{ name, quantity, cost }],
      glassArea_sqm, glassCost,
      wasteCost,
      extraLinesCost,
      totalCost,
      unresolvedComponents: [role_name, ...],  -- see Error handling
    }
```

**Step 1 — resolve the grid.** `rowWeights = template.grid_row_weights` (length = `rowCount`); `columnCount = opening.panel_count`, with implicit equal `columnWeights` (each `1 / columnCount`). Normalize `rowFractions[i] = rowWeights[i] / Σ rowWeights`. Each cell `(r, c)`'s size: `cellWidth_m = opening.width_m / columnCount`, `cellHeight_m = opening.height_m × rowFractions[r]`.

**Step 2 — grid-derived members** (only when the relevant family is set on the template):
- If `rowCount > 1` and `grid_horizontal_rail_family` is set: `rowCount − 1` horizontal rails, each `length_m = opening.width_m`, positioned at each internal row boundary.
- If `columnCount > 1` and `grid_vertical_mullion_family` is set: `columnCount − 1` vertical mullions, each `length_m = opening.height_m`.
- Each resolves against `aluminum_profiles` exactly like a component (Step 3 below) and lands in `gridLines`, not `profileLines`.

**Step 3 — explicit components.** For each `bom_template_components` row:
1. Resolve the exact profile: find the `aluminum_profiles` row where `family = component.profile_family AND series = opening.series AND thickness_mm = opening.thickness_mm AND tenant_id = <tenant>`. If none matches, the component (or grid line) is `unresolved` (see Error handling) and contributes zero cost — it never falls back to a guess.
2. Compute `length_m` from `length_rule_type` against `opening.width_m` / `opening.height_m` (components no longer reference `panel_count` directly — that's the grid's job now):
   - `width` → `width_m`; `height` → `height_m`
   - `width_minus` → `width_m − length_deduction_mm/1000`; `height_minus` similarly
   - `perimeter` → `2 × (width_m + height_m)`
3. Compute the row's `quantity`: `quantity_basis = 'fixed'` → `quantity_value`; `'per_cell'` → `quantity_value × rowCount × columnCount`.
4. `weight_kg = length_m × quantity × profile.linear_weight_kg_per_m`. `cost = weight_kg × finish.price_per_kg`.

Aluminum subtotal = Σ (`profileLines` cost + `gridLines` cost). `wasteCost = aluminum subtotal × template.waste_pct / 100`.

Hardware: for each `bom_template_hardware` row, resolve `quantity` the same way (`fixed` / `per_cell` → `quantity_value × rowCount × columnCount` / `per_perimeter_m` → `quantity_value × 2×(width_m+height_m)`), `cost = quantity × reference_unit_price`.

Glass: computed **per cell** and summed — `glassArea_sqm = Σ over all rowCount×columnCount cells of (cellWidth_m − glass_width_deduction_mm/1000) × (cellHeight_m − glass_height_deduction_mm/1000)`, `glassCost = glassArea_sqm × glassType.price_per_sqm` (zero if the template/opening has no glass). Phase 1 assumes every cell is glazed the same way — see Non-goals for the mixed-fill-type case this doesn't yet cover.

`extraLinesCost = Σ opening.extra_lines[].amount`.

`totalCost = aluminum subtotal + wasteCost + Σ hardwareLines + glassCost + extraLinesCost` is the cost for **one unit** of the opening (one door/window). `computeBomForOpening` returns this per-unit figure and does not multiply by `opening.quantity` itself — the UI multiplies `totalCost × opening.quantity` when it needs a line subtotal (e.g. "3 × W12 = ..."), keeping the function's contract to "one opening, one unit" regardless of how many identical copies are ordered. **Labour and project-level markup (profit/transport/PM/VAT) are explicitly not part of this total** — those are Phase 3a's job (Quotation output), operating on top of this per-unit cost, not inside it.

## UI changes

- **New admin screen, "BOM Templates"** (`src/pages/BomTemplates.jsx`): list of templates; a template editor that is a guided form, not a code/formula editor. A small **grid section** at the top: "+ Add row" appends a weight number to `grid_row_weights` (default 1, so a fresh template starts as a single unweighted row = no internal rail), plus two optional family pickers for the internal horizontal rail / vertical mullion — still just number inputs and dropdowns, no canvas. Below that, the explicit component list: add a component by picking role name (free text), profile family (free text, autocompleted from existing `aluminum_profiles.family` values), a length-rule dropdown (five presets, down from seven now that the grid owns the repeating cases), and a quantity-basis dropdown. Same shape for hardware rows and constraint rows. This is the piece that has to stay approachable for a non-expert per the original ask — no field on this screen accepts a formula string.
- **New screen, "Estimation"** (`src/pages/Estimation.jsx`): create a project, add openings (template, series, thickness, finish, glass type, width, height, panel count, quantity — all pickers/number inputs), see the computed BOM breakdown and unit cost live as those inputs change (calls `computeBomForOpening` client-side, no network round-trip needed once templates/catalogs are loaded once). A warning banner renders per violated constraint (Decision 6). An "Add adjustment line" control implements the escape hatch (Decision 7).
- **Admin screens for the small catalogs** (`aluminum_finishes`, `bom_glass_types`) — simple CRUD tables, same pattern as any other settings list already in the app (e.g. `inventory_categories`).
- Nav: a new "Estimation" section, gated on `has_module_access('estimation')` the same way every other module's nav entry is gated.

## Error handling

- **Unresolved component or grid line** (no `aluminum_profiles` row matches `family`+`series`+`thickness_mm`): never silently priced at zero-and-hidden. The opening's BOM breakdown lists it under `unresolvedComponents` with a visible red line ("Top rail: no profile configured for General / 1.2mm", or "Vertical mullion: no profile configured for...") and the opening's total cost is flagged as incomplete (shown, not blocked — consistent with Decision 6's warning-not-block stance) so the estimator can still see partial numbers while fixing the catalog.
- **Template deleted or deactivated while openings reference it**: `template_id` is `ON DELETE RESTRICT` — a template with any opening referencing it cannot be hard-deleted; `active = false` is the intended way to retire a template, and existing openings keep computing against it as long as it exists.
- **Series/thickness typed on an opening that doesn't exist in `aluminum_profiles` for *any* component's family**: same as unresolved component above — every component under that opening reports unresolved, not a crash.

## Testing

- Unit tests for `bomEngine.js` (`src/lib/bomEngine.test.js`, matching `inventoryCost.test.js`'s style): one test per `length_rule_type` preset, one per `quantity_basis` value, waste_pct application, per-cell glass area formula (including a weighted-row grid, e.g. `[0.25, 0.75]`, and `panel_count > 1`), grid-derived rail/mullion count and length at various row/column counts, unresolved-component/grid-line behavior, extra_lines summation. Pure functions, no Supabase mocking needed.
- No new edge function in this spec (no AI call) — manual QA of the two new screens against a hand-built template (e.g. reconstruct the illustrative "Swing Door · 2 Leaf" example from the design artifact) is the acceptance check before shipping.

## Open questions for the implementation plan

- **Profile import**: the source workbook's 201 profile rows need `family`/`series`/`thickness_mm` populated to be usable — is that a one-time manual data-entry pass, or does it warrant an Excel-import path (the existing `ExcelUpload.jsx` already handles an `aluminum_profile` sheet type; extending its parser to also read family/series/thickness columns is plausibly small, but sizing that is the plan's job, not this spec's).
- **`profile_family` as free text vs. a real lookup table**: this spec keeps it as a plain TEXT match against `aluminum_profiles.family` for simplicity. If typos in either place become a real problem in practice, promoting it to a proper `aluminum_profile_families` table with FKs both directions is a natural follow-up, deliberately not built now (YAGNI).
- **Constraint hard-block toggle**: flagged in Decision 6 as a plausible Phase 1.1, not decided now.
- **`estimation` module's package assignment**: which pricing tier(s) get it by default is a business decision, not a technical one — needs an answer before the `package_modules` seed data can be written.
- **Per-cell fill type** (Non-goals): if a real template needs a mixed grid — e.g. a glazed transom over a solid bottom panel — Phase 1's "every cell is glazed the same way" assumption breaks. Worth revisiting once real templates are being built and it's clear whether this is a common case or a rare one.
- **Per-opening column weights**: Phase 1 only lets the *template* weight rows unequally; opening-supplied columns (`panel_count`) are always equal-width. If an asymmetric-panel case shows up in practice (e.g. one wide fixed panel + one narrow operable panel), this would need extending — deliberately not built now since no real template surfaced this requirement yet.
