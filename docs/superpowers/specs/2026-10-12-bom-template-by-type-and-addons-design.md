# BOM template creation by type, start-from-saved, and inline add-ons — design

Date: 2026-10-12. Status: written for owner review (nothing built). Builds on `2026-10-10-bom-template-part-editor-design.md` (part editor, shipped on branch `feat/alu-cost-catalog`) and `2026-10-08-aluminium-cost-catalog-design.md` (catalogue, types, add-on today). FacadeX-only: everything is gated by the `estimation` module (tables, RLS, UI), additive and nullable, so tenants without `estimation` and every existing template/item behave exactly as before.

Reference mockup (owner commented on it for a day; this spec encodes its final state): https://claude.ai/artifact/BHyUNkbGFkXd39DFTB4AMU (v12). Part-editor mockup (approved earlier, embedded unchanged in step 3): https://claude.ai/artifact/W5ancigcsmQU5MWN2eXG6W. Formulas per type (7 types from `aluiminium calculation.xlsx`, aluminium only): https://claude.ai/artifact/2pBkh143n5k3HP6NhL3TwE.

## 1. Goal

1. Creating a BOM template starts from the **type** (the owner's 3-level `door_window_types` catalogue, 24 entries on CHANG on 2026-10-12), not from a free-form skeleton button. The type decides which editor, which inputs the estimator will type, and which add-on kinds make sense.
2. Step 2 offers **start from scratch** or **start from a saved template** (clone, edit, save as a new template; the original is never overwritten).
3. **Add-ons stop being separate types.** An add-on (transom light, side light, vent …) is a unit defined inline on the item: kind (fixed / awning), position (top/bottom/left/right), size, offset, rows × columns. It has two modes: **merge** (affects the main unit: same frame, shared divider, main frame members stretch) and **attach** (a separate unit with its own frame; the main unit is untouched). Several add-ons per item, at several positions.
4. The owner can click each piece of an add-on unit and assign its profile, which input its length refers to, and how many bars, exactly like the part editor.
5. The owner can upload reference drawings/photos per type (images, pdf) in the page; they are references for building each type's editor, never parsed into formulas.

## 2. Owner decisions (from the mockup comments, 2026-10-12)

| # | Decision | Where |
|---|---|---|
| D1 | Types come from the existing catalogue (no hard-coded type list). Steps 2 and 3 of the create page reuse the approved part-editor page. | §5, §6 |
| D2 | Add-on is not a separate type any more; add-on with effect on the main unit **and** add-on without effect (just attached) both exist. | §4, §5 |
| D3 | Add-ons are available for every main type, in several positions, several per item (modelled on the item-form "ของเพิ่มเติม" screen in Mockup 2b). | §4 |
| D4 | Add-on inputs sit in the same section as the main unit's width/height, not in a separate card. | §6 |
| D5 | Components/profile lines/add-ons that are finished can be collapsed to a one-line summary and reopened. Manual "เสร็จแล้ว" button (owner did not ask for auto-hide). | §6 |
| D6 | The add-on preview is the existing part-editor overview drawing with the add-on drawn around it; nothing is redrawn for the main unit. | §6, §7 |
| D7 | For an attached add-on: click it, the main unit fades, a zoomed view of the add-on only; click a piece to set profile, reference input, multiplier, deduction, bar count. Merge add-ons get the same editor for the pieces they stretch or add. | §6 |
| D8 | Step 2 = start from scratch / start from saved template (pick from saved list). | §6 |
| D9 | Reference uploads per type, readable by Claude, never turned into formulas. | §4, §6 |
| D10 | Formulas for every type come from `aluiminium calculation.xlsx`; the 12 open questions on the formula page must be answered before each type's editor is built. | §9 |

## 3. Scope and phasing

This spec covers the **shared machinery** and the **sliding window (`sliding_2`)**, the only layout with a part editor today. Each further type is a later, separate piece of work that plugs into the same registry (§5.1): layout kind + default piece set + geometry + tests, started only after the owner answers that type's formula questions and approves its mockup (spec of 2026-10-10 §10 table).

In scope: type registry and create page; clone from saved; reference uploads; inline add-on model, piece sets, expander, persistence, costing, item form, preview/attachment drawing.
Out of scope: editors for other types; changing how quotations/prices are computed; per-category discounts; transport calculator; picture upload in the catalogue screens (Phase 3 Task 9, still waiting for its own mockup).

## 4. Data model (all additive, one migration `2026-10-16-01`, applied by the owner)

### 4.1 Types ↔ layout kinds

`door_window_types.layout_kind TEXT NULL CHECK (layout_kind IS NULL OR layout_kind IN ('sliding_2'))` (the CHECK list grows with each shipped layout). The owner sets it in the catalogue type form ("แบบชิ้นส่วน"). No type-name matching in code. A type with NULL layout kind keeps today's flat-component template flow.

### 4.2 Add-on piece sets (template level: "what are the bars of an add-on of kind K in mode M")

```
bom_template_addon_pieces
  id, tenant_id (default current_tenant_id()), template_id → bom_templates ON DELETE CASCADE
  mode          TEXT CHECK IN ('merge','attach')
  kind          TEXT CHECK IN ('fixed','awning')
  piece_key     TEXT CHECK IN ('ext','divider','frame_top','frame_bottom','frame_side','mullion','rail')
  profile_family TEXT NULL            -- family name, like bom_template_components.profile_family
  ref_input     TEXT CHECK IN ('w','h','len','mw','mh','tw','th')
  length_factor NUMERIC NOT NULL DEFAULT 1 CHECK (> 0)
  deduction_mm  NUMERIC NOT NULL DEFAULT 0 CHECK (>= 0)
  qty_rule      TEXT CHECK IN ('fixed','cols-1','rows-1','cols','rows','rows*cols')
  qty_fixed     INT  NOT NULL DEFAULT 1 CHECK (>= 0)
  thickness_role TEXT NULL CHECK IN ('sash')   -- same semantics as components
  sort_order    INT NOT NULL DEFAULT 0
  UNIQUE (template_id, mode, kind, piece_key)
```
Glass is not a piece row: the add-on's infill follows the item's infill type, count = rows × cols, size from the geometry. RLS: the same `admin_full_access` policy as the part-editor tables (`is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation')`).

Inputs available to `ref_input` (all in mm at costing time):
`w`,`h` = add-on width/height as drawn; `len` = length along the main unit's edge; `mw`,`mh` = main opening width/height; `tw`,`th` = overall width/height of main + this add-on. `merge` sets may use all seven, `attach` sets only `w`,`h`.

### 4.3 Add-ons on an item

```
estimation_item_addons
  id, tenant_id, opening_id → estimation_openings ON DELETE CASCADE
  mode ('merge'|'attach'), kind ('fixed'|'awning'),
  position ('top'|'bottom'|'left'|'right'),
  len_m NUMERIC > 0, thick_m NUMERIC > 0, offset_m NUMERIC >= 0,
  rows INT >= 1, cols INT >= 1, sort_order INT
```
Several rows per item; same-side add-ons stack outward in `sort_order`. The existing single add-on columns on `estimation_openings` (`addon_template_id`, `addon_width_m`, `addon_height_m`, `addon_panel_count`, `addon_position`, `addon_offset_m`) are **not touched**: an item with `addon_template_id` keeps costing as today (§8).

### 4.4 Type reference files

```
estimation_type_references
  id, tenant_id, type_id → door_window_types ON DELETE CASCADE,
  storage_path TEXT NOT NULL, file_name TEXT NOT NULL, content_type TEXT, created_at
```
Files go to the existing private bucket `estimation-images` (policy already tenant-scoped) under `<tenant_id>/type-references/<type_id>/<uuid>-<name>`. Accepted: `image/*`, `application/pdf`, max 20 MB. dwg is refused with a Thai hint to export to pdf/image.

### 4.5 Cloning

Clone = new rows only; no schema. `cloneTemplate` copies `bom_templates` (new name), `bom_template_components`, joints, hardware, part-editor rows, add-on pieces, with new ids; `type_id` stays unless the owner changes it. A cloned template records nothing about its source.

## 5. Behaviour

### 5.1 Layout registry (code)

`src/lib/layoutRegistry.js` exports for each layout kind: `inputs` (what the estimator types: for `sliding_2` width, height), `defaultAddonPieces(mode, kind)` (the piece set defaults of §5.3 with empty profiles), `addonKinds`, and the existing `LAYOUTS[...]` model from `partModel.js`. Adding a type later = one registry entry + its part model + tests.

### 5.2 Create page flow

Step 1 pick a type (tree from `door_window_types`: category → parent → child; parents that have children are not selectable). Step 2: start from scratch, or start from saved template (list filtered to the picked type, tick to show all types; loading switches the type to the template's type). Step 3: for a type with `layout_kind`, the part editor with the add-on box inside the same card; for a type without, the existing flat-component editor (unchanged). Save creates a new `bom_templates` row (never overwrites), then the part rows (existing `saveModel`), then the add-on piece rows.

### 5.3 Piece sets and geometry (defaults; every value editable by the owner)

Attach, kind fixed/awning (add-on unit has width W, height H, own frame):
frame top / bottom: ref `w`, deduction 2 × butt of the side profile, qty 1 each · frame sides: ref `h`, deduction 0, qty 2 · mullion (vertical): ref `h`, deduction 2 × butt, qty cols − 1 · rail (horizontal): ref `w`, deduction 2 × butt, qty rows − 1 · infill: rows × cols panes, each ≈ cell size − 2 × butt.

Merge (add-on shares the frame of the main unit): `ext` (the main frame members that run beside the add-on get longer: sides for top/bottom add-ons, top and bottom for left/right ones): ref `th` / `tw`, deduction 0, qty 2 — implemented as a **length override of the main frame position**, not as an extra bar, so bar cutting still sees one piece · `divider` (new member between main and add-on): ref `len`, deduction 2 × butt, qty 1 · mullion, rail, infill as above.

Rulings that the owner can overturn (open questions, §10): **AO-1** the main frame's far member (top for a top add-on) stays the unit's outer frame and its length does not change; **AO-2** with a merge add-on on a side, the main sashes' deduction on that side uses the **divider profile's butt distance** instead of the main frame member's (the divider is now the member the sash sits against).

### 5.4 Expansion and costing

`expandAddons({ addons, pieceSets, main: { widthMm, heightMm }, buttOf, widthOf }) → { merge: { frameOverrides }, components, issues, glass }`.
- Attach: each add-on becomes its own synthetic opening (width = `w`, height = `h`, panel count rows × cols) with components compiled from its piece set (`length_rule` `width`/`height` + factor/end deduction, quantity computed numerically) and costed through the existing `computeBomForOpening`; results are combined into the item with `combineOpeningBoms` exactly like the current add-on unit.
- Merge: `frameOverrides` feeds `expandParts` (new optional `envelope` argument: the heights/widths a frame position uses) so the stretched members are cut once at their new length; extra pieces (divider, mullion, rail) compile to components of the main BOM; AO-2 changes the `buttOf` lookup for the sash deductions only when a divider exists on that side.
- Issues (`no_profile_family`, `no_butt_distance`, `addon_piece_missing`, `addon_out_of_range`) go to `unresolved` like part-editor issues and show Thai text via `reasonText`. A missing profile is never priced as 0.
- Items without item-add-ons and templates without piece sets take the exact existing code path (parity tests).

### 5.5 Item form

New items list add-ons with the same fields as the mockup (mode, kind, position, length, thickness, offset, rows, cols). An item that has a legacy single add-on keeps showing the existing fields and cannot mix both on the same item (the form shows a note and a "convert to new add-on" button that creates one attach add-on with the same size/position and clears the legacy columns after the owner confirms).

### 5.6 Drawings

`partPreviewSvg` draws main + add-ons: main = the existing overview markup; merge add-ons inside one outer frame with a divider bar; attach add-ons with their own frame; total dimension lines. Same builder for the item preview and the quotation attachment (stored `preview_svg_*`, rejected-input validator unchanged). The stale-drawing signature includes the add-on list and piece-set widths.

## 6. UI (references: mockup v12; build UI only after the mockup is accepted by the owner — it is the standing rule)

- Page `BomTemplates` → "สร้างใหม่": step cards 1–3 as in the mockup; step 3 for `sliding_2` embeds the shipped `PartEditor`; the add-on box (list, mode/kind/position/size/offset/rows/cols, "เสร็จแล้ว ▲" collapse, "ดูภาพขยาย / กำหนดชิ้นส่วน") sits under the width/height bar in the same card.
- Overview card: the editor's overview markup with add-ons around it; clicking an add-on selects it, fades the main unit, opens the add-on zoom card (pieces clickable, side panel with profile / reference input / multiplier / deduction / quantity rule, table with "length × bars" and totals); the effects table lists main-unit changes (stretched members, divider, extra bars).
- Upload box per type under step 3 (image/pdf, thumbnails, delete). Create button label becomes "บันทึกเป็น template ใหม่" when started from a saved template.
- All numeric inputs are converted to numbers/null before entering the model (lesson from the part editor).

## 7. Compatibility

- Legacy templates (flat components, with or without `addon_template_id` on items) and part-editor templates without add-ons: byte-identical costs and drawings (golden/parity tests).
- `estimation_layout_templates` (type + one add-on type + ratios) stays as the item-form shortcut for legacy add-ons; it is not migrated in this work.
- Deploy order: migration `2026-10-16-01` before code. Code that reads the new tables degrades to "no add-ons" when the tables are missing (the Estimation page must still render, as for the part-editor tables).

## 8. Tests (summary; each task adds its own)

Pure units: add-on layout/envelope (ported from the mockup `layout()`), piece-set defaults, expander numbers from the mockup (top add-on 1800 × 400, 1 × 3: sides 1,200 → 1,600; divider 1,723.8; mullions 2 × 323.8; panes 3 × 524 × 324; attach frame top/bottom 1,723.8, sides 400), AO-1/AO-2 behaviour, missing-profile issues, quantity rules. Parity: costOpening for an item with no add-ons and for the legacy add-on item is unchanged. Persistence: round-trip of piece sets and item add-ons, delete-then-insert ordering, stop-on-first-error, validation before any delete. UI: renderToString smoke for the create page (scratch / saved / reference box), collapse/expand, add-on zoom. SQL: constraints, RLS, cascade, tenant isolation, module gate.

## 9. Per-type rollout (unchanged from the part-editor spec §10)

Sheet types in `aluiminium calculation.xlsx`: sliding 2 sashes (built), sliding 2 + 2 fixed, fixed light, curtain wall, casement, swing door, hanging-rail door; folding door and louver are not extracted yet. The 24 catalogue types map onto these by the owner's `layout_kind` assignment; types that do not map (sliding 3 sashes, bottom-rail door, the six awning types, frameless variants) need the owner's formula first. The six awning types encode rows × columns in their names, so the editor reads them from the type instead of asking the estimator.

## 10. Open questions (provisional rulings in brackets; the plan builds to the rulings and keeps them as data defaults so a different answer is a data change)

1. Merge add-on, one divider or two members (main frame top plus the add-on's own bottom)? [one divider, §5.3 AO-1/AO-2]
2. Attach add-on: priced as part of the same item and drawn in the same attachment image, or its own quotation line? [same item, same image]
3. Profiles of divider / mullion / rail / attached frame: chosen from the catalogue per template, ends set like the part editor? [yes]
4. Add-on kinds beyond fixed/awning (vent, side-hung)? [only fixed/awning now]
5. Reference input list sufficient? Quantity rules sufficient? [as in §4.2]
6. Saved-template list filtered to the picked type by default, clone never overwrites. [yes]
7. "บานสวิงเปลือย" (frameless swing door): what replaces the frame? [not built; asked per type]
8. Sash positions in the part editor (hook stile left of both sashes in the mockup): confirm against the real window. [as approved mockup]

## 11. Risks

- Merge mode touches the main expansion (envelope, AO-2); mitigated by making it opt-in per item add-on and keeping the old path byte-identical.
- Two add-on representations coexist (legacy columns, new rows); mitigated by the one-or-the-other rule and the explicit convert button.
- Per-end/piece data volume grows (add-ons × pieces); acceptable at template size, capped by input limits (§plan Task 6: ≤ 6 add-ons per item, rows ≤ 6, cols ≤ 12).
- Uploaded files are untrusted: content type and size checked client-side and by the bucket policy; shown through `<img>` and links only, never inlined as markup.
- Estimators typing real sizes: lengths ≤ 0 or add-ons wider than the main edge produce Thai warnings, never negative lines (the engine does not clamp; the expander clamps and flags).
