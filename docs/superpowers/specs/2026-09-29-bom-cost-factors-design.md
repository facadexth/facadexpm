# BOM Template Engine — Cost Factors Extension

> Extends `docs/superpowers/specs/2026-09-10-bom-template-engine-design.md` (Phase 1, shipped). Read that spec first — this one assumes its data model, `bomEngine.js`, and decisions as given, and only documents what changes or adds to them.

## Problem

Phase 1's `computeBomForOpening` produces an accurate materials **cost** — aluminum (weighted by profile + finish), hardware, glass, waste — but three real cost factors the business actually prices are completely absent: **labor**, **silicone**, and **felt/weatherstrip**. Infill is glass-only, though the business regularly prices mesh, solid panel, and aluminum composite panel (ACP) infill too. And there's no way to represent a genuine **add-on unit** — e.g. a fixed transom light above a door — distinct from splitting the same window into more grid panels of the same kind; confirmed directly against the business owner's own `Aluminium calculation_270116-1.xlsx`, whose sliding-door BOM calculators already split every product into a main leaf (`ขนาดบานเลื่อน`) and an independently-sized add-on light (`ขนาดช่องแสง`), each contributing its own aluminum/glass totals.

## Goal

Extend the BOM engine so a computed opening cost accounts for every material/labor factor the business prices — labor, silicone, felt, mesh/solid-panel/ACP infill, and an add-on unit — while keeping Phase 1's "no formula language, guided pickers only" spirit intact. Turning this cost into a sellable **price** (margin, transportation, PM, VAT) is explicitly not this spec's job — see Non-goals.

## Non-goals (explicitly deferred)

- **Margin %, transportation, PM cost, VAT.** The next spec entirely — this one stops at cost, exactly like Phase 1 did. See "Verified markup facts" below for numbers already confirmed against the real spreadsheet, recorded now so that spec doesn't have to rediscover them.
- **Quotation / Purchase Order / Material Order output.** Still Phase 3a/3b from the original spec, untouched here.
- **AI drawing extraction.** Still deferred (confirmed again this round — "too soon").
- **Fire Barrier / Bracket / curved-bending (ALU/GL) as structured rate fields.** The real spreadsheet has dedicated baseline rates for these, but the business owner confirmed they're rare enough to keep in Phase 1's existing free-text `extra_lines` escape hatch rather than promote to first-class fields ("it's additional cost we can define later").
- **A generic "location" field for add-on units.** Considered and ruled out — nothing in the real spreadsheet has one. An add-on's position is implicit in which template is picked (a "door with transom" template differs from a "door, no transom" template), not a location a user selects.
- **Live visual preview / SVG diagram of the opening.** Inspired by a reference demo seen this round, genuinely useful, not blocking this spec.
- **Formula-string length rules.** A reference demo uses arbitrary expressions (`width`, `height`, `rows`, `columns`...); Phase 1's fixed 5-preset enum already covers every case in the real drawing sample reviewed this round, so it stays as-is.
- **Per-opening override of labor/silicone/felt rates.** Phase 1 established `waste_pct` as a per-template default with no per-opening override; this spec keeps that precedent for the three new rate fields, for consistency and because nothing yet demands per-opening overrides (YAGNI).
- **Formalizing `series` into its own catalog table.** A real reference demo has one; worth doing eventually to remove typo risk, but not load-bearing for this spec's cost-factor work — a natural follow-up spec.
- **Multiple add-on units per opening.** Every real example reviewed has at most one. If a real template later needs two (e.g. a transom above *and* a sidelite beside), that's a follow-up.
- **The wider marketplace platform** (comparison UI, fabricator matching, purchase/checkout, material fulfillment, production supervision). Recorded separately in memory (`estimation-platform-ultimate-vision`) — this spec is piece 1 of that, and only piece 1.

## Current system facts this design depends on

- **`bomEngine.js`** (`computeBomForOpening(opening, template, components, hardware, profiles, finish, glassType)`) currently returns `{ profileLines, gridLines, hardwareLines, glassArea_sqm, glassCost, wasteCost, extraLinesCost, totalCost, unresolvedComponents }`. `totalCost = aluminumSubtotal + wasteCost + Σhardware + glassCost + extraLinesCost`, per-unit (caller multiplies by `opening.quantity`). Full current implementation read directly this session — no drift from the Phase 1 spec's description.
- **`bom_glass_types`** (id, tenant_id, name, `price_per_sqm`, active) is the only infill concept today — glass or nothing.
- **`bom_templates`** already has `waste_pct NUMERIC NOT NULL DEFAULT 10` as the precedent this spec's three new rate fields follow.
- **Verified markup facts** (read live from the real `price_structure.xlsx`'s cell formulas, not the PDF export — for the *next* spec, recorded here so it doesn't have to re-derive them): waste = 10% of aluminum cost only (already matches this engine exactly); profit = 45% of total cost; PM = 2% of selling price (cost + profit), not of the grand total; transport is allocated to each line item proportional to that item's share of total selling-price value across the project, not by area or count. That same historical sheet also computes its "วัสดุเสริม ซิลิโคน สักหลาด" as one combined line priced per sqm — the business owner reviewed this and explicitly chose to diverge from it for the new design (Decision 3 below: two separate lines, priced per perimeter meter).
- **`Aluminium calculation_270116-1.xlsx`**'s sliding-door calculators (rows ~267–317, password `261`) are the ground truth for Decision 5 (add-on units) — read directly this session via `msoffcrypto-tool` + `openpyxl`, both formulas and values.

## Decisions made

1. **Infill is generalized from glass-only to four material kinds.** `bom_glass_types` is renamed to `infill_types` and gains `material_kind TEXT NOT NULL DEFAULT 'glass' CHECK (material_kind IN ('glass','mesh','solid_panel','acp'))`. One area × price formula serves all four — validated against a reference demo's own "Material Type" list (glass / aluminium composite / corrugated aluminum / solid panel); `mesh` is added because the business owner named it explicitly and the demo didn't have it.
2. **Rename cascade following from Decision 1**, confirmed against every file that references the old names (`grep`, full blast radius): `estimation_openings.glass_type_id` → `infill_type_id`; `bom_templates.glass_width_deduction_mm` / `glass_height_deduction_mm` → `infill_width_deduction_mm` / `infill_height_deduction_mm`; `bomEngine.js`'s `glassType` param → `infillType`, `glassArea_sqm`/`glassCost` → `infillArea_sqm`/`infillCost`; UI labels "ชนิดกระจก" → "วัสดุอุดช่อง". Touches `useSupabase.js` (its `useBomGlassTypes` hook is renamed to `useInfillTypes`, table name inside it updated to match), `bomEngine.js`, `bomEngine.test.js`, `BomTemplates.jsx`, `Estimation.jsx`. A rename, not a new parallel concept — existing data keeps working (`material_kind` defaults to `'glass'`).
3. **Labor, silicone, and felt are three new per-template rate fields**, following the exact precedent `waste_pct` already set (a template default, editable per template, no per-opening override — Non-goals). Confirmed bases: **labor** = opening area (`width_m × height_m`) × `labor_price_per_sqm`; **silicone** and **felt** are each their own line, = perimeter (`2 × (width_m + height_m)`) × their own rate (`silicone_price_per_m`, `felt_price_per_m`) — a deliberate, explicit divergence from the historical spreadsheet's one-combined-per-sqm-line approach (business owner's call after reviewing the real formula: "doesn't matter [that they're combined there]. let's use perimeter").
4. **Fire Barrier / Bracket / curved-bending stay in the existing free-text `extra_lines`.** Not promoted to structured fields this round.
5. **An opening can reference one add-on unit**: its own template, width, height, and panel count — distinct from the main unit's grid (which only splits the main unit into more panels of the *same* kind). Confirmed directly against `Aluminium calculation_270116-1.xlsx`'s real sliding-door calculators, which already separate `ขนาดบานเลื่อน` (main leaf) from `ขนาดช่องแสง` (add-on light), each with independent size inputs and BOM totals. The add-on **shares** the main unit's `series`, `thickness_mm`, `finish_id`, and `infill_type_id` — the real spreadsheet implies the add-on is made from the same series/finish/glass as the main unit (it shows a glass *discount/override*, not an independent glass picker) — it does **not** get its own series/thickness/finish/infill selectors. It **does** get its own template (different BOM shape) and its own labor/silicone/felt cost, computed from *its own* template's rates against *its own* dimensions, summed into the opening's total alongside the main unit's.
6. **No location field for the add-on** (see Non-goals) — position is implicit in which `bom_templates` row is picked as the add-on template.
7. **Length-rule enum unchanged** (still the 5 Phase 1 presets) — considered a formula-string approach, rejected; the enum already covers everything in the real drawing sample reviewed this round.

## Data model

```sql
-- Decisions 1-2: generalize glass -> infill. A rename, not a new table --
-- existing rows keep working (material_kind defaults to 'glass'). RLS
-- policies survive a table rename automatically; no policy changes needed.
ALTER TABLE bom_glass_types RENAME TO infill_types;
ALTER TABLE infill_types ADD COLUMN material_kind TEXT NOT NULL DEFAULT 'glass'
  CHECK (material_kind IN ('glass','mesh','solid_panel','acp'));

ALTER TABLE estimation_openings RENAME COLUMN glass_type_id TO infill_type_id;
ALTER TABLE bom_templates RENAME COLUMN glass_width_deduction_mm TO infill_width_deduction_mm;
ALTER TABLE bom_templates RENAME COLUMN glass_height_deduction_mm TO infill_height_deduction_mm;

-- Decision 3: labor/silicone/felt per-template rate fields, same precedent
-- as waste_pct (template default, DEFAULT 0 so existing templates keep
-- computing the same total_cost until an admin fills these in).
ALTER TABLE bom_templates ADD COLUMN labor_price_per_sqm  NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE bom_templates ADD COLUMN silicone_price_per_m NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE bom_templates ADD COLUMN felt_price_per_m     NUMERIC NOT NULL DEFAULT 0;

-- Decision 5: one optional add-on unit per opening. All four nullable --
-- an opening with no add-on leaves them null and the add-on computation
-- is skipped entirely. addon_panel_count defaults to 1 like the main
-- unit's panel_count does. ON DELETE RESTRICT matches template_id's
-- existing behavior (Phase 1: a template with any opening referencing it
-- can't be hard-deleted).
ALTER TABLE estimation_openings ADD COLUMN addon_template_id UUID REFERENCES bom_templates(id) ON DELETE RESTRICT;
ALTER TABLE estimation_openings ADD COLUMN addon_width_m     NUMERIC;
ALTER TABLE estimation_openings ADD COLUMN addon_height_m    NUMERIC;
ALTER TABLE estimation_openings ADD COLUMN addon_panel_count INT NOT NULL DEFAULT 1;
```

## Business logic — changes to `bomEngine.js`

`computeBomForOpening`'s signature changes only in the rename (`glassType` → `infillType`; its internal glass-only variable names become infill-generic). Three new cost lines are added, each zero when the template's rate is the default 0:

```
laborCost    = opening.width_m * opening.height_m * template.labor_price_per_sqm
siliconeCost = perimeter_m * template.silicone_price_per_m   -- perimeter_m already computed for per_perimeter_m hardware
feltCost     = perimeter_m * template.felt_price_per_m

totalCost = aluminumSubtotal + wasteCost + Σ hardwareLines + infillCost
          + laborCost + siliconeCost + feltCost + extraLinesCost
```

Returned shape gains `laborCost`, `siliconeCost`, `feltCost` alongside the renamed `infillArea_sqm`/`infillCost`. No other function's contract changes — `computeBomForOpening` still computes exactly one unit's BOM, same as Phase 1.

**Add-on aggregation happens at the call site, not inside `computeBomForOpening`.** When `opening.addon_template_id` is set, the caller (`Estimation.jsx`) calls `computeBomForOpening` a second time — with the add-on's own template/components/hardware and `{ width_m: addon_width_m, height_m: addon_height_m, panel_count: addon_panel_count, series: opening.series, thickness_mm: opening.thickness_mm, extra_lines: [] }` (the add-on's own `series`/`thickness_mm` are the main opening's, per Decision 5; it gets no `extra_lines` of its own — one adjustment-line list per opening is enough) — passing the same `finish`/`infillType` resolved for the main unit. The opening's total cost for one unit is `mainBom.totalCost + (addonBom?.totalCost ?? 0)`; the UI multiplies by `opening.quantity` exactly as Phase 1 already does for the main unit alone. This keeps `computeBomForOpening` a small pure "one opening in, one BOM out" function — Phase 1's own house style — rather than growing a second code path inside it for a two-unit case.

## UI changes

- **`BomTemplates.jsx`**: three new numeric rate inputs (labor ฿/m², silicone ฿/m, felt ฿/m) in the template editor, placed next to the existing waste % input. The infill picker/list becomes "วัสดุอุดช่อง" and adding a new infill type includes a material-kind selector (glass/mesh/solid panel/ACP).
- **`Estimation.jsx`**: the opening editor gains an "Add-on unit" toggle. When on, it shows a template picker (filtered to `active` templates, same as the main template picker) plus width/height/panel-count inputs — same shape as the main unit's own fields, just for the add-on. The BOM summary card gains rows for labor, silicone, and felt (shown even when 0, consistent with how waste/glass/extra-lines rows already always show), and — when an add-on is set — a second, visually distinct "Add-on: <template name>" sub-block with its own line items, followed by a combined opening total. The "ชนิดกระจก" picker label becomes "วัสดุอุดช่อง"; its options optionally group by material kind if the list grows long enough to need it (not required for the current single seeded row, but worth doing given four kinds now exist).

## Error handling

- Unchanged from Phase 1 for the main unit (unresolved components/grid lines shown, not blocked).
- **Add-on unit unresolved components**: identical treatment, reported separately under the add-on's own sub-block so it's clear which unit (main or add-on) has the gap.
- **Add-on template deleted/deactivated while referenced**: same `ON DELETE RESTRICT` + `active=false`-to-retire pattern as the main `template_id` already uses.
- **Add-on fields partially filled** (e.g. `addon_template_id` set but `addon_width_m` null): treated as "no valid add-on yet" — the add-on computation is skipped (not attempted with a missing dimension) until all three of template/width/height are present, mirroring how the main unit's own BOM already only computes once its own required fields are filled.

## Testing

- `bomEngine.test.js`: new cases for `laborCost`/`siliconeCost`/`feltCost` (each formula, and each at rate 0 confirming no regression to Phase 1's existing total for templates that don't set them), infill cost across all four `material_kind` values (same formula, different catalog row), and add-on aggregation (main-only total unchanged when no add-on; main+add-on summed correctly when one is present; add-on's own unresolved-component reporting kept separate from the main unit's).
- Manual QA: reconstruct one real add-on example from `Aluminium calculation_270116-1.xlsx` (a sliding door + transom light) as two templates and one opening referencing both, and confirm the computed total is in the right ballpark against that sheet's own numbers for the equivalent product — not an exact match (different waste/rate assumptions), but a sanity check that nothing is off by an order of magnitude.

## Open questions for the implementation plan

- **`aluminum_finishes`/`infill_types` seed data for the four material kinds**: only one glass row exists today (`กระจกใส 6 มม.`, seeded during earlier exploration this session in a throwaway reference demo — not in FacadeX itself). Populating real mesh/solid-panel/ACP rows with real prices is a data-entry task, not a schema question — sizing it is the plan's job.
- **Series catalog formalization** (Non-goals) — worth a follow-up spec if typos become a real problem in practice; not built now.
- **Multiple add-ons per opening** (Non-goals) — revisit if a real template surfaces the need; no evidence for it yet.
- **Per-opening rate overrides for labor/silicone/felt** (Non-goals) — revisit if the business ever wants to negotiate these per job rather than trusting the template default; no evidence for it yet, and Phase 1 already set the "template default, no override" precedent for `waste_pct`.
