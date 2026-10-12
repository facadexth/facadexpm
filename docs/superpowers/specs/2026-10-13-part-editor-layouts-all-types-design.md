# Part-editor layouts for every catalogue type — sub-spec

Parent: `2026-10-12-bom-template-by-type-and-addons-design.md` (§4.1 layout kinds, §5.1 registry, §9 per-type rollout). This sub-spec defines the layout of every leaf type in the owner's catalogue so the part editor (`partModel` / `partExpand` / `partGeometry` / `partPreviewSvg`) can build a template for any type, not only `sliding_2`. Add-ons stay in the parent spec; this document covers main units only.

Mockup accepted as the drawing reference: https://claude.ai/artifact/KiGoMF2S7Uk3pkMpTEWhq8 (v5, 2026-10-13). Owner comments v2→v5 are decisions D1–D14 below. Formula reference: https://claude.ai/artifact/2pBkh143n5k3HP6NhL3TwE (v6, every Excel part per type).

## 1. Goal

One `layout_kind` per catalogue type, each with a declarative layout (parts, positions, length rules, corner rules, drawing) so that:
- the template editor shows the type's drawing, lets the owner zoom a part (วงกบ / บาน 1 / บาน 2 …), click a bar and assign profile family, thickness, length reference, factor, end deduction and piece count (same interaction as today's sliding editor);
- the item preview, quotation attachment and costing use the same geometry;
- adding a future type is one registry entry + one layout definition + tests, never a change to the editor UI.

Out of scope: add-ons (parent spec), hardware pricing rules beyond default counts (§7), shop drawings.

## 2. Owner decisions (mockup comments 2026-10-13)

| # | Decision |
|---|---|
| D1 | Folding door: the estimator enters **left count and right count** separately (`nL`, `nR`); an odd count on a side leaves one swing leaf; a centre split line is drawn when both sides > 0. |
| D2 | Stick wall and unitized curtain wall: each cell **cycles กระจก → บานกระทุ้ง → spandrel → กระจก** by clicking it; the row-level spandrel setting is only the default. |
| D3 | Frameless glass wall (ผนังกระจกบานเปลือย): **perimeter frame on all four sides**, full-height glass panes, vertical silicone joints only, no horizontal division, no grey fittings. |
| D4 | Hinged door (บานเปิด): top and bottom rails the **same size** (no kick rail); **threshold (ธรณี / วงกบล่าง) is a yes/no choice**. |
| D5 | Swing door (บานสวิง, framed): **no hinges**; a **door closer concealed in the head frame** plus top/bottom pivots. Threshold yes/no as D4. |
| D6 | Frameless swing door (บานสวิงเปลือย): patch fittings **flush with the top and bottom edges**, a stainless pull handle and a **floor lock**. |
| D7 | Fixed light (บานติดตาย): **vertical mullions run full height; horizontal transoms butt into them.** The same rule applies to every grid (curtain wall, awning grids). |
| D8 | New type **บานเปิดข้างเดี่ยว** (single casement, hinge side chosen). |
| D9 | Sliding 3 sashes: **three tracks** — บานฟิก (back track, fixed) / บานกลาง / บานหน้า; sliding sashes stack toward the fixed one. |
| D10 | Sliding 2 + fixed 2: **four sashes on two tracks**, left→right: วงกบ · เสากุญแจ · เสาเกี่ยว ‖ เสาเกี่ยว · เสากุญแจตัวผู้ · เสากุญแจตัวเมีย · เสาเกี่ยว ‖ เสาเกี่ยว · เสากุญแจ · วงกบ; the hook stiles of neighbouring sashes overlap; fixed sashes sit on the back track. No เสาตาย. |
| D11 | Awning and casement sashes are **mitred at 45°** at all four corners. |
| D12 | Frameless glass wall keeps vertical joints only (D3); unitized walls draw unit joints additionally. |
| D13 | Every type gets the **zoom + click-to-assign** interaction: part tabs (ทั้งชุด / วงกบ / บาน n…), unselected parts faded, members of the same name inside one part are assigned once, "เสร็จแล้ว" per part collapses it. |
| D14 | Preview line styles stay the four existing ones: double line (default, used on quotations), double line + piece lengths, solid by colour, CAD (lines only). |

Owner answers 2026-10-13 (second round):
- D15 Door sashes (บานเปิด, บานสวิง, รางแขวน, บานเลื่อนรางล่าง, บานเฟี้ยม) are **butt-jointed** ("ต่อตรง": stiles run through, rails butt). Only awning and casement window sashes are mitred (D11).
- D16 Frameless swing door: **perimeter frame (วงกบ) on top and both sides, no threshold**; the leaf itself is frameless glass with patch fittings.
- D17 Sliding 2 + fixed 2: **equal glass width on all four sashes** — no `Wf` input; the layout computes one sash width so every pane is the same.

Provisional rulings still open (the owner can overturn; each is a data default, not code):
- R3 In the 3-track sliding layout the fixed sash is the leftmost (viewed from outside); the estimator can mirror it (`fixed_side` input).
- R5 Curtain-wall cell kinds are saved on the template (`layout_params.cells`) as the type's default picture; an item may override them (the same JSON on the item) because every project façade differs.

## 3. Generalisations of the part model

Today `LAYOUTS.sliding_2` has fixed parts, fixed `per` counts and three corner rules. Every layout below needs these extensions (all backwards compatible: `sliding_2` keeps its exact current behaviour and tests):

- **G1 Layout inputs.** A layout declares `inputs` (the parent spec §5.1 already names this): each input has key, label, unit, min/max/step or a select list, and `fixed_by_type` when the catalogue type name fixes it (awning rows × cols, swing door leaves). Values live in `bom_templates.layout_params` (template defaults; the owner edits them in the editor) and in `estimation_openings.layout_params` (item values; only inputs marked `estimator: true` are shown on the item form; the rest are copied from the template). `width_m` / `height_m` stay the item's W/H as today.
- **G2 Dynamic part counts.** `parts[].count` may be a function of inputs (`count: 'n'`, `'leaves'`, `'nL+nR'`, `'rows*cols'`, `'cells.awning'`). `MAX_PART_COUNT` (10) caps sashes; grids cap at rows ≤ 8, cols ≤ 12 (same limits as the parent spec's add-on grids).
- **G3 Dynamic piece counts per position.** `positions[].per` may be an expression (`'cols-1'` mullions, `'(rows-1)*cols'` transom segments, `'2'`). Each piece keeps its own end pair as today (`ensureEnds` already grows ends with the count).
- **G4 Corner modes.** `corner: 'butt'` (today's rule: exactly one piece runs through), `'mitre'` (both pieces keep their full outer length, no deduction, 45° cut flagged for the optimizer's kerf), `'free'` (no partner: trims, covers). Mitre applies per part (D11), not per piece.
- **G5 Grid rule (D7).** A `grid` position pair declares `through: 'v'`: vertical pieces run the full inner height and butt into the frame; horizontal pieces are one piece per column segment, butting into the verticals (deduction = the vertical profile's butt distance each end). This replaces the sliding corner rule inside grids.
- **G6 Tracks and overlap.** A sash part declares `track` (1 = front … 3 = back) and `overlap_mode: 'auto_hook' | 'manual' | 'none'`. `sashOverlap` generalises from 2 sashes to n: each neighbouring pair on different tracks overlaps by the hook-stile overlap; sashes on the same track do not overlap. Fixed sashes (`fixed: true`) draw a tinted pane with "F" and have no slide arrow.
- **G7 Parts without bars.** A part may have `positions: []` and `glass: true` (frameless leaf / pane): it draws glass and fittings, contributes no aluminium, and contributes hardware counts (§7).
- **G8 Cell kinds.** A grid layout may declare `cells: { kinds: ['glass','awning','spandrel'] }`; the template/item stores `cells: {"r,c": kind}`. An `awning` cell instantiates the awning sash sub-layout inside that cell (same part model, mitred); a `spandrel` cell replaces glass by a panel line item (infill kind `solid_panel`).
- **G9 Opening symbol and hardware metadata** per part (`symbol: 'v_hinge' | 'slide' | 'fold' | 'none'`, `hinge: 'left'|'right'|'top'`, `opens: 'in'|'out'`) drive `partPreviewSvg` only; costing ignores them.

Length rules stay the existing four (`width`, `height`, `width_minus`, `height_minus`) plus two new references for sash members: `sash_width` and `sash_height` (the sash's own outer size as computed by the layout — e.g. W ÷ n + overlap — so the owner no longer has to encode ÷2 as a factor; `sliding_2` keeps `width_minus × 0.5` for compatibility and the editor offers both).

## 4. Type → layout map

| Catalogue type (leaf) | layout_kind | fixed by type (`fixed_by_type`) | estimator inputs |
|---|---|---|---|
| STICK WALL | `curtain_wall` | `unitized: false` | W, H, rows, cols, cells |
| UNITIZED CURTAIN WALL | `curtain_wall` | `unitized: true` | W, H, rows, cols, cells |
| ผนังกระจกบานเปลือย | `frameless_wall` | — | W, H, cols |
| บานเปิด | `swing_door` | `pivot: false` (hinged) | W, H, leaves, hinge, open, sill |
| บานสวิงเดี่ยว / บานสวิงคู่ | `swing_door` | `pivot: true`, leaves 1 / 2 | W, H, hinge (single only), open, sill |
| บานสวิงเปลือยเดี่ยว / คู่ | `frameless_door` | leaves 1 / 2 | W, H, hinge (single only), open |
| บานเฟี้ยม | `folding_door` | — | W, H, nL, nR |
| บานเลื่อนรางแขวน | `hanging_door` | — | W, H, leaves |
| บานเลื่อนรางล่าง | `sliding_n` | `door: true` (threshold rail, no bottom frame) | W, H, n |
| บานติดตาย | `fixed_grid` | — | W, H, rows, cols |
| บานเปิดข้างเดี่ยว (new, D8) | `casement_n` | n = 1 | W, H, hinge, open |
| บานเปิดข้าง | `casement_n` | — | W, H, n, open |
| บานเลื่อนสวน 2 บาน | `sliding_2` (shipped) | — | W, H |
| บานเลื่อน 3 บาน | `sliding_3track` | — | W, H, fixed_side |
| บานเลื่อน 2 ตาย 2 | `sliding_2_fixed_2` | — | W, H |
| บานกระทุ้ง r ชั้น x c ช่อง (6 types) | `awning_grid` | rows = r, cols = c | W, H, open |

`door_window_types.layout_kind` CHECK list grows to these 13 kinds; `door_window_types.layout_params JSONB` holds the `fixed_by_type` values (set in the catalogue type form next to "แบบชิ้นส่วน").

## 5. Layout definitions

Notation: `W`, `H` = opening size (mm); `f` = frame profile width, `m` = mullion/divider width, `s` = sash profile width (all read from the assigned profile's `width_mm`, falling back to the editor constants 45 / 60 / 50 only for drawing); `b(x)` = butt distance of profile x; `ov` = hook overlap (from the hook-stile profile, PE-5). "through" = full length; "butts into X" = length minus `b(X)` per end. Default profile families are the Excel names (so the import of `2026-10-13-import-aluminium-calculation-xlsx.sql` resolves them); the owner may change any of them.

### 5.1 `fixed_grid` — บานติดตาย

Parts: `frame` (1). Positions: `frame_side` ×2 through (H), `frame_top` / `frame_bottom` butt into sides (W − 2·b(side)); `mullion` × (cols−1) through the inner height (H − 2·f) butting into top/bottom (G5); `transom` × (rows−1)·cols, one per column segment, butting into mullions/sides. Glass per cell. Defaults: frame = กล่องเรียบ (or กล่องร่อง for the light-grid series), mullion = ซอยกลาง 4" / กล่องร่อง, transom = ซอยกลาง 2" / ตบร่อง per the Excel grid (กล่องร่อง `Wl + Hl·(C+1)`, ตบร่อง `Wl·(R−1) + Hl·(C−1)` — the system's per-segment lengths sum to the same totals). Symbol: none; each pane labelled F.

Worked example (drawing constants f = 45, m = 60; 1800 × 1200, 2 × 3): sides 2 × 1200; top/bottom 2 × (1800 − 2·b); mullions 2 × 1110; transoms 6 × 530 (cell width (1800 − 90 − 120)/3). The test asserts these with b = 45 (constant) and again with b from a profile.

### 5.2 `awning_grid` — บานกระทุ้ง r × c (six types)

`fixed_grid` plus one `sash` part per cell (`count: 'rows*cols'`), each sash: `sash_top` (hinge rail), `sash_bottom` (handle rail), `sash_side` ×2, **mitred** (G4): every member = the cell's inner size (cell width / cell height), no deductions, thickness role `sash`. Symbol: V with apex at the top, opens out by default (`open`). Defaults: sash = กรอบในกระทุ้ง+คิ้ว / กรอบนอกกระทุ้ง (Excel: `(บานกว้าง × จำนวน + บานสูง × จำนวน) × 2`); frame/grid as 5.1. Hardware default per sash: 2 stays, 1 handle.

### 5.3 `casement_n` — บานเปิดข้าง / บานเปิดข้างเดี่ยว

`fixed_grid` with rows = 1, cols = n, plus one mitred sash per cell (as 5.2) with `symbol: 'v_hinge'`, hinge side: single sash = input; n ≥ 2 = left half hinged left, right half hinged right (pairs meet in the middle). Opens out by default. Hardware per sash: 2 friction stays / hinges, 1 handle.

### 5.4 `sliding_n` — บานเลื่อนสวน 2 บาน (shipped as `sliding_2`), บานเลื่อนรางล่าง (door)

`sliding_2` stays as built. `sliding_n` generalises it with `n` sashes alternating front/back track (G6): sash i on track `i % 2 + 1`; sash width = (inner W + (n−1)·ov) / n (`sash_width` reference); stiles: the two outer stiles are เสากุญแจ, every inner stile is เสาเกี่ยว; arrows: left half slide right, right half slide left. `door: true` variant: bottom frame = threshold rail `รางล่าง (ธรณี)` (thin), top = `รางบน`; the owner's door-rail families from the Excel sheet 7 are not used here (that sheet is the hanging door). Hardware: 2 rollers per sash, 1 lock set per unit.

### 5.5 `sliding_3track` — บานเลื่อน 3 บาน (D9, R3)

Three sashes on three tracks: sash 1 = บานฟิก (`fixed: true`, back track, pane marked F), sash 2 = บานกลาง (middle track), sash 3 = บานหน้า (front track); sash width = (inner W + 2·ov) / 3; neighbouring sashes overlap by `ov`; sliding sashes' arrows point toward the fixed sash; `fixed_side` mirrors the whole layout. Frame: `เฟรมบน (3 ราง)` / `เฟรมล่าง (3 ราง)` families default to the 3-track profiles (Excel: รางบนบิ๊กเฟรม 1.5·W, รางล่างบิ๊กเฟรม 2 ราง, ธรณี 3 ราง). Hardware: 2 rollers on each sliding sash, 1 lock.

### 5.6 `sliding_2_fixed_2` — บานเลื่อน 2 ตาย 2 (D10, D17)

Frame as sliding (2-track head/sill). Four sashes of **equal outer width** `w = (inner W + 2·ov) / 4` (two hook overlaps: fixed-left ‖ slide-left and slide-right ‖ fixed-right; the two key stiles meet at the centre without overlap), so every pane has the same glass width (D17). Sashes left→right: `fixed_left` (back track, `fixed: true`, stiles: เสากุญแจ at the frame, เสาเกี่ยว inside), `slide_left` (front track, เสาเกี่ยว overlapping the fixed sash's hook, เสากุญแจตัวผู้ at the centre), `slide_right` (front, เสากุญแจตัวเมีย at the centre, เสาเกี่ยว), `fixed_right` (back, mirror of fixed_left). Rails: บานเลื่อนบน / บานเลื่อนล่าง on every sash (`width_minus`, pre-deduction 2·b(frame_side) − 2·ov, factor ¼); a `ตบธรณี` cover on the sill (Excel W ÷ 2) as a free position. Symbols: arrows on the two sliding sashes pointing toward the fixed sashes (each opens by sliding over its fixed neighbour); fixed panes marked F. The Excel type 2 totals (เสาเกี่ยว 4H, เสากุญแจ 2H + ประกบกลาง H) are reproduced when the centre stiles are assigned เสากุญแจ ×2 (ตัวผู้/ตัวเมีย) and ประกบกลาง is added as a free line on the centre stile — the test checks the 3.3 × 1.0 example of the Excel against the expanded rows.

### 5.7 `swing_door` — บานเปิด (hinged), บานสวิงเดี่ยว/คู่ (pivot)

Frame: `frame_side` ×2 through, `frame_top` butts; `sill` (ธรณี) present only when `sill = yes` (D4/D5) — when absent the sides run to the floor and the drawing shows a dashed floor line. Leaves (`count: 'leaves'`): stiles through (`เสาบานพับ`, `เสามือจับ`), rails butt (`ราวบนบาน`, `ราวล่างบาน` — same size, D4), butt-jointed (R1). Leaf width = inner W / leaves. Symbol: V, apex at the hinge stile; single leaf hinge = input, double = hinged on both outer stiles; `open` in/out. Hardware: hinged (`pivot: false`) = 3 hinges + 1 handle per leaf; pivot (`pivot: true`) = 1 concealed closer in the head + 2 pivots + 1 handle per leaf (D5). Excel sheet 6 families as defaults: กล่องแจ็คสัน/ฝาแจ็คสัน (head), เสาประตูสวิง (stiles), เสาบนสวิง/เสาล่างสวิง (rails), ธรณีสวิง (sill), คิ้วประตู (beads, free position ×4 per leaf).

### 5.8 `frameless_door` — บานสวิงเปลือยเดี่ยว/คู่ (D6, D16)

Frame: `frame_side` ×2 through, `frame_top` butts into the sides, **no threshold** (dashed floor line in the drawing). Leaves: `leaf` × leaves with `glass: true` (no bars), leaf width = inner W / leaves. Hardware per leaf: 2 patch fittings (flush with the top and bottom edges, hinge side), 1 floor spring, 1 stainless pull handle, 1 floor lock; double door adds nothing on the meeting edge. Symbol: V from the patch side. Aluminium = the three frame members (plus any owner-added free lines).

### 5.9 `hanging_door` — บานเลื่อนรางแขวน

Parts: `track` (รางแขวนใหญ่ + กล่อง 1-3/4 cover; the track runs past the opening by the slide distance: default length rule `width` with factor 2, i.e. 2·W for one leaf and for two leaves opening to both sides — open question 5), `frame_side` ×2 (hang from under the track, through), `leaf` × leaves: stiles through (เสาประตูสวิง), rails butt (เสาบนสวิง / เสาล่างสวิง), a floor guide as hardware. Symbol: arrows (single: toward the open side; double: outward). Excel sheet 7 is the default family set; the owner's answer on the "2 and 4 constants" (parent spec open question) changes only the defaults.

### 5.10 `folding_door` — บานเฟี้ยม (D1)

Frame: `track_top` (รางบน, through), `track_bottom` (รางล่าง / ยูฝังพื้น, through), `track_side` ×2 (รางข้าง) butting into the tracks. Leaves: `count: 'nL+nR'`, each leaf 4 members (กรอบบาน 4" top/bottom/sides, butt-jointed, R1) plus บังใบ/คิ้วบาน as free lines; leaf width = inner W / (nL+nR). Symbols: V alternating per pair (first leaf of each side hinged at the jamb), hinge marks on the shared edges, arrows toward each stack side, a dashed split line when both sides > 0. Hardware: 3 hinges per leaf junction, 1 top + 1 bottom roller per pair, 1 handle per side. Excel sheet 8 (`รางบน + รางล่าง + 2·กรอบบาน + 2·คิ้ว` on W; `2·รางข้าง + (nL+nR)·2·(กรอบ+คิ้ว)` on H) is reproduced by the defaults.

### 5.11 `curtain_wall` — STICK WALL, UNITIZED (D2, D7, R5)

Positions: `mullion` × (cols+1) through the full H (NO.9010 `H·(C+1)`), `transom` × (rows+1)·cols per column segment butting into mullions (NO.9023 `W·(R+1)` in total), pressure plate / cover lines (NO.9019, NO.3112 — free lines with factor `(1−k)`, the parent spec's open question on `k` stays). Cells: `kinds: ['glass','awning','spandrel']` (G8); an awning cell instantiates the 5.2 sash inside the cell with Unitized/EURO families (บานหน้าต่างยูโร + คิ้วยูโร, or casement 13-0599a / casem-base for unitized); spandrel = solid panel infill. `unitized: true` draws the unit joints (one per column and per row) and switches the default families to the Unitized set (Gutter, Sill, Fe-/Ma-Mullion, Int-Tran). Cell state saved on the template, overridable on the item (R5).

### 5.12 `frameless_wall` — ผนังกระจกบานเปลือย (D3)

Frame: 4 sides as 5.1 (families: กล่องเรียบ default). Inside: `pane` × cols with `glass: true`, vertical silicone joints (joint count = cols − 1 as a sealant quantity, not aluminium), no transoms, no fittings. Symbol: none.

### 5.13 `sliding_2` — unchanged (reference implementation).

## 6. Editor behaviour common to all layouts (D13)

- Overview drawing of the whole unit; part tabs from the layout (`ทั้งชุด`, then one per part instance: `วงกบ`, `บาน 1`…, `ซอยกลาง`, `ราง`). Choosing a part fades the rest to 25 % opacity.
- Clicking a bar selects **that position's line 0** for the part; all pieces of the same position inside the part are highlighted and assigned together (วงกบข้าง ×2). Extra lines (covers, beads) are added from the side panel as today.
- Side panel fields: profile family (filtered to the item's series when known), thickness role, length reference (`width`/`height`/`sash_width`/`sash_height`/`width_minus`/`height_minus`), factor, end deduction (auto from the partner's butt distance unless overridden), piece count (read-only when fixed by the layout; editable for free lines). The computed length and its explanation (`explainPiece`) are shown live.
- "เสร็จแล้ว" per part collapses its tab and shows ✓; the overview badge counts assigned / total positions.
- Inputs panel: the layout's `inputs` with their `fixed_by_type` values shown read-only.
- Line styles D14; view in/out flips dashed/solid opening symbols and mirrors hinge sides.

## 7. Hardware default counts

Each layout lists default hardware per part instance (hinges, stays, rollers, closers, pivots, patch fittings, floor springs, locks, handles). They are **suggestions written into the template's hardware list** when the template is created from the layout (`bom_template_hardware` rows with `quantity_rule: per_sash | per_unit`), editable like any hardware line; nothing is hard-coded in costing. The family of each hardware item is left empty (the owner picks the part from `alu_parts`).

## 8. Data changes (one additive migration, `2026-10-17-01-layouts-all-types.sql`, owner-applied)

- `door_window_types.layout_kind` CHECK list → the 13 kinds of §4; `door_window_types.layout_params JSONB NOT NULL DEFAULT '{}'`.
- `bom_templates.layout_params JSONB NOT NULL DEFAULT '{}'` (template input defaults, `cells`).
- `estimation_openings.layout_params JSONB NOT NULL DEFAULT '{}'` (item inputs incl. `cells` override). No view uses `x.*` on these tables (re-check at migration time, standing rule).
- `bom_template_position_profiles` unchanged: position keys are strings, so new keys (`mullion`, `transom`, `sash_side`, `fixed_left_key_stile` …) need no schema change; piece ends keep their JSON shape.

## 9. Tests

Per layout: (a) `startModel(kind, params)` snapshot; (b) `expandParts` worked example with constant butt distances and with a profile index (the §5 numbers; sliding 2 + fixed 2 and folding door also against the Excel examples); (c) geometry: every bar inside the opening, no overlaps except declared hook overlaps, mitred corners for awning/casement; (d) preview SVG string: symbol kind and hinge side per view, cell kinds for curtain walls; (e) registry: every catalogue layout kind resolves, unknown kind throws; (f) `sliding_2` tests unchanged and green.

## 10. Rollout order (proposed; the owner may reorder)

1. `fixed_grid` + `awning_grid` (G3, G4 mitre, G5 grid rule) — smallest step from today, covers 7 types.
2. `casement_n`, `sliding_n` (door variant), `sliding_3track`, `sliding_2_fixed_2` (G6 tracks).
3. `swing_door`, `hanging_door`, `folding_door` (G1 inputs with selects, G2 counts).
4. `curtain_wall`, `frameless_wall`, `frameless_door` (G7, G8).
Each step = one plan task group with its own review; the editor UI changes land with step 1 and are reused by the rest.

## 11. Open questions for the owner

Answered 2026-10-13: doors butt-jointed (D15); frameless swing door = frame around, no threshold (D16); sliding 2 + fixed 2 = equal glass on every sash (D17).

Still open (the plan builds to the rulings; each is a data default):
1. R3: 3-track fixed sash side default (left, mirrorable).
2. R5: may an item override the template's curtain-wall cell picture, or is the picture fixed per template (one template per façade pattern)?
3. Hanging door track length rule: 2·W for one leaf, and for two leaves opening to both sides?
4. The hardware defaults in §7: confirm counts (3 hinges per leaf, 2 stays per awning sash, 2 rollers per sliding sash, 1 roller pair per folding pair).
5. Which series each layout's defaults should name when the type is not in the Excel (frameless types, bottom-rail door).
