# BOM template part editor (click-to-define pieces) — design

Date: 2026-10-10 · Branch: `feat/alu-cost-catalog` · Status: **draft for the owner's review** (no plan, no code)

Mockup (owner-approved for "sliding window, 2 sashes, no transom", v24): https://claude.ai/artifact/W5ancigcsmQU5MWN2eXG6W — source of truth for layout, labels and the worked example. Formula evidence: `aluiminium calculation.xlsx` (type 1, no-transom case) and the owner's comments on the mockup.

## 1. Goal

Let the owner define a window/door template by **clicking the drawn pieces** instead of filling a flat list: pieces are grouped into **parts** (sub-assemblies), a position can hold **several profiles** (box + cover/trim), every **end of every piece** is set to *run through* or *butt* (with the butt deduction defaulting from the butted profile), and the real **cut length** is computed from the opening minus the frame. The first supported layout is the sliding window with 2 equal sashes and no transom.

Success = for the example in the mockup the editor and the cost engine give the same numbers (frame 1,723.8 / 1,200; sash rails 824.4; sash stiles 1,126.1 mm at 1,800 × 1,200 with sample widths), existing templates keep costing exactly as before, and the owner can build the same template without leaving the BOM Template page.

## 2. Owner decisions (2026-10-10)

1. Scope of the UI: **BOM Template page only** (tab "ส่วนประกอบและอุปกรณ์"); the item form is unchanged.
2. A template is made of **parts**: วงกบ × 1 and บานเลื่อน × 2 (the 2 sashes are equal: one part with count 2). Part name and count are editable.
3. One **position** (a clickable piece in the drawing) may hold **several profiles** (e.g. box + cover, box + trim). Each profile has its own length rule, deduction, factor, quantity and end settings; a new profile starts as a copy of the first.
4. **Every end of every piece is set separately** (frame sides left/right × top/bottom, sash left/right) to *run through* ("วิ่งสุด" = full length) or *butt* ("วิ่งชน" = full length minus the butted profile's butt distance). At a corner exactly one of the two pieces runs through; changing one flips the other automatically.
5. A profile stores two numbers: its **full width** (reference) and its **butt distance after notch** (e.g. side frame 51.3 / 38.1). The butt distance is the default deduction for every end that butts it; the user can overwrite the deduction per end. Snapping a cover into a groove does not change the butt distance.
6. Defaults for the sliding window: frame top/bottom butt the side frames, side frames run through; sash stiles (key stile, hook stile) run through, sash rails butt the stiles.
7. Real cut lengths: the sash sits inside the frame opening, so sash lengths deduct the frame: stile = H − (top frame + bottom frame butt distances); rail per sash = [W − left frame − right frame − key stile × 2 − hook stile × 2 + hook stile × 1] ÷ 2 (the two hook stiles overlap by one hook width). Frame deduction uses the side frame's butt distance (38.1 in the example). The deduction values default **automatically from the frame profiles** and can be overwritten per series ("แก้เอง", with a reset).
8. Ends/lengths are shown as **length per piece × quantity**; pieces with different lengths (e.g. left/right side frame with different ends) appear as extra lines.
9. Preview in the editor: top **overview** (click to select), below a **zoom of the selected part** where the end markers (green "สุด", orange "ชน") are clicked to toggle; the overview and zoom draw every joint flush; overlapping sashes are drawn with the visible sash on top (outside view: left sash outside; inside view swaps).

Still open with the owner (defaults used): which sash is outside (default left); meaning of the comment "ภาพขยายวงกบชนแทน" (frame zoom joints drawn flush); real butt distances, hook overlap and clearance values (the mockup uses sample numbers 38.1 / 35.8 / 25).

## 3. Scope

In scope: new template layout kind `sliding_2` (sliding window, 2 sashes, no transom); parts / positions / profile lines / per-piece per-end data; butt distance on profiles; engine support for a length factor and end deductions; an expander that compiles the new model into the engine's flat component list; the click editor with overview + zoom; "start from the sliding-window layout" action; migrations, tests.

Out of scope (later): other layouts (swing door, fixed light, transom/light-grid, curtain wall, folding door, louver) and their Excel formulas; showing these templates in the item form's preview and in the quotation attachment drawings (they keep the old preview); glass, labour and hardware in the new model (hardware stays in the existing tabs); importing the Excel formulas; clearance and sash-overlap defaults beyond the editable fields; per-part colours.

## 4. Data model (new migration `2026-10-15-01-bom-part-editor.sql`, additive; the owner applies it)

All new tables: `tenant_id UUID NOT NULL DEFAULT current_tenant_id()`, tenant index, RLS `is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation')` (same loop as the Phase 2b/3 tables).

- `bom_templates`: `layout_kind TEXT NULL CHECK (layout_kind IN ('sliding_2'))` — NULL = legacy template, nothing changes.
- `bom_template_parts` (`template_id`, `part_key` ('frame'|'sash'), `name`, `count INT ≥ 1`, `overlap_mode` ('auto_hook'|'manual', default 'auto_hook'), `overlap_mm NUMERIC ≥ 0 NULL`, `sort_order`).
- `bom_template_positions` (`part_id`, `position_key` — one of `frame_top, frame_bottom, frame_side, sash_top, sash_bottom, key_stile, hook_stile`, `name`, `sort_order`; unique `(part_id, position_key)`). The drawing geometry comes from `layout_kind` + `position_key` in code, not from data.
- `bom_template_position_profiles` (`position_id`, `profile_family TEXT NOT NULL`, `length_rule_type` (same CHECK as components), `length_deduction_mm NUMERIC ≥ 0 DEFAULT 0`, `deduction_auto BOOLEAN DEFAULT true`, `length_factor NUMERIC > 0 DEFAULT 1`, `quantity_value NUMERIC ≥ 0 DEFAULT 1`, `thickness_role` (NULL | 'sash'), `sort_order`).
- `bom_template_piece_ends` (`position_profile_id`, `piece_index INT ≥ 0`, `end_index SMALLINT IN (0,1)`, `mode` ('through'|'butt'), `butt_to_profile_id UUID REFERENCES bom_template_position_profiles ON DELETE SET NULL`, `deduction_mm NUMERIC ≥ 0 NULL` — NULL = default from the butted profile; unique `(position_profile_id, piece_index, end_index)`).
- `alu_profiles`: `butt_distance_mm NUMERIC NULL CHECK (butt_distance_mm IS NULL OR butt_distance_mm >= 0)`. When NULL the existing automatic rule in `assembly.jointDeductionMm` (width/depth + primary contact) applies, so nothing changes until the owner fills it. The full width is the existing `width_mm`.
- `bom_template_components` (engine input, existing table): `length_factor NUMERIC NOT NULL DEFAULT 1 CHECK (length_factor > 0)`, `end_deduction_mm NUMERIC NOT NULL DEFAULT 0 CHECK (end_deduction_mm >= 0)`.

No column is added to or removed from quotations, invoices or any standard module. Migration order: after Phase 3's `2026-10-14-01/02`.

## 5. Engine and expansion (pure libraries)

- **Engine change (minimal, defaults keep old results):** `computeComponentLength` becomes `rule(...) × length_factor − end_deduction_mm/1000` (factor 1 and end deduction 0 for every existing row). Everything else in `bomEngine` is untouched.
- **`expandParts({ template, parts, positions, lines, ends, profilesByFamily, index, seriesId, thicknessMm })`** (new `src/lib/partExpand.js`) returns the flat component list the engine already understands. For every profile line it computes the pre-factor deduction (manual value, or the automatic frame/overlap deduction) and, for each piece, the end deductions (butt = override or the butted profile's butt distance, through = 0); pieces with the same deduction pair collapse into one component with `quantity = pieces × part count × quantity_value`, pieces with different ones become separate components (`role_name` carries "ซ้าย/ขวา"). Automatic deductions: `sash_top/sash_bottom` = frame_side ×2 (pre-factor) and overlap = hook-stile width (auto) or the manual value; `key_stile/hook_stile` = frame_top + frame_bottom. The corner rule (one through, one butt) is enforced when saving and re-checked on load; a violation is reported as an issue, never silently fixed.
- **Integration point:** `openingCost.prepareComponents` — if `template.layout_kind` is set, components come from `expandParts(...)` using the item's resolved series/thickness; otherwise the existing path runs unchanged. The cut optimizer, BOM views and stale-price check already consume the flat components, so they need no change.
- **Butt distance lookup:** by profile family at the item's series/thickness through the existing `resolveCatalogProfile` (same as joints); a missing distance → `butt_distance_mm`, else the legacy automatic rule, else an unresolved reason shown in the editor and in the cost summary (never 0).

## 6. UI (BOM Template page, tab "ส่วนประกอบและอุปกรณ์", for templates with `layout_kind`)

Per the approved mockup: width/height test inputs and outside/inside toggle; overview SVG (click a piece to select); zoom SVG of the selected part with clickable end markers; side panel: part name and count (+ sash overlap, auto/manual), position name, one fieldset per profile (profile family, profile info — full width and butt distance —, length rule, deduction (auto/manual badge, ↺ reset), length factor, quantity, thickness role, per-end controls with target and deduction, step-by-step "ที่มา" line, result), button "+ เพิ่มโปรไฟล์ในตำแหน่งนี้"; components table grouped by part with "length × quantity" lines and part totals. Legacy templates keep the current tab untouched. A button "สร้างจากแบบบานเลื่อน 2 บาน (ไม่มีช่องแสง)" creates the parts/positions/lines with the defaults of decision 6; profile families are chosen by the owner. Saving writes the new tables and then regenerates nothing else (expansion happens at costing time).

Editing the butt distance / full width of a profile happens in the editor's profile-info boxes and writes `alu_profiles` (same table as the catalogue; the catalogue's profile screen also gains the butt-distance field).

## 7. Compatibility and isolation

- Templates without `layout_kind` and every existing component row produce identical costs, BOMs and previews (tests below).
- Estimation is FacadeX-only: all new tables are gated by the `estimation` module in RLS; no standard module is touched.
- Deploy order: apply the migration, then deploy the code (the code reads the new columns).

## 8. Tests

- `expandParts` unit tests including the owner's example (1,800 × 1,200; side frame butt distance 38.1, top 38.1, bottom 35.8, stiles 25, hook overlap 25): top/bottom frame 1,723.8, side frames 1,200 (and 1,164.2 when an end is switched), rails 824.4, stiles 1,126.1; grouping of equal/different lengths; part count multiplication; multiple profiles in one position with independent ends; corner rule (flip on toggle, violation reported); manual overrides and ↺ reset; missing butt distance → unresolved.
- Engine tests: `length_factor`/`end_deduction_mm` defaults reproduce every existing `bomEngine` test unchanged; new cases for factor and end deduction.
- Equivalence/regression: a legacy template costs the same before and after (existing suite), and a new-style template with all-through ends, factor 1 and no deduction equals the equivalent flat template.
- SQL test script (owner-run): constraints, unique keys, RLS isolation, `ON DELETE SET NULL` on `butt_to_profile_id`.
- Editor tests: pure state logic (toggle coupling, grouping, auto-deduction, save payload) unit-tested; component smoke tests; no `NaN`/`undefined` in the rendered editor.

## 9. Risks and open items

- The engine's length formula gains two inputs; mitigated by defaults and the unchanged old tests.
- Per-end data multiplies rows (pieces × ends × profiles); acceptable at template size.
- The item-form preview and the quotation attachment drawings still use the legacy preview for these templates until a follow-up; their dimensions come from the same opening, so only the end-flush detail differs.
- Sample numbers in the mockup are not real: the owner must enter butt distances and widths per profile, the hook overlap and any clearance per series.
- Pending owner answers: outer sash side (default left); the "ภาพขยายวงกบชนแทน" comment.
