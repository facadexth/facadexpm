# Aluminium window/door QA rulebook

For a QA agent that judges whether CHANG's aluminium drawings (`partSvgString`, saved previews, attachment pages) and cost breakdowns (`expandParts` -> `computeBomForOpening` -> `costOpening`) are right. Written 2026-10-16 from: `docs/handover-aluminium-cost-catalog.md`, `src/lib/layouts/*.js`, `src/lib/layoutRegistry.js`, `src/lib/partModel.js`, `src/lib/partExpand.js`, `src/lib/bomEngine.js`, `src/lib/addonModel.js`, `src/lib/addonExpand.js`, `src/lib/openingCost.js`, `src/lib/aluPrice.js`, `src/lib/aluCatalogPricing.js`, `src/lib/openingExtras.js`, `src/lib/hardwareDefaults.js`, `scripts/gen-templates-all-types.mjs`, the specs `2026-10-10-bom-template-part-editor-design.md`, `2026-10-12-bom-template-by-type-and-addons-design.md`, `2026-10-13-part-editor-layouts-all-types-design.md`, the plan `2026-10-15-sliding2-addons.md`, and the owner memory note `project_aluminium_cost_catalog_brainstorm.md`. Every worked number in section 3 was produced by running the real code (`expandParts`, `computeComponentLength`, `expandAddons`, `hardwareDefaults`) at HEAD `9ebb1a8b`, not by hand.

**Tags.** Each rule carries exactly one tag:
- **CONFIRMED** = traceable to an owner statement (date and source given).
- **INFERRED** = an agent's or spec-writer's guess (source given) with the cost if it is wrong.

**Owner answers 2026-10-16.** The owner answered all 12 questions of section 5 on 2026-10-16. Every rule they settle is now tagged "CONFIRMED (owner 2026-10-16)". Answer 3 points to the Nakhon Nayok shop drawings for serie general (ทั่วไป). What those drawings show (profiles, joins of stacked units, how the live preview must draw them) is in **`docs/aluminium-series-general.md`**. Read it before judging any ทั่วไป drawing or add-on. Where the code disagrees with an answer or with the drawings, see section 7 ("Code vs owner answers — defects to fix").

Agent rulings in the handover (R-*, PE-*, AO-* without "(owner)", P3-*, numbered rulings without "(owner)") are INFERRED even when they look obvious. "Owner accepted mockup v5" (2026-10-13) confirms the *drawing* conventions it shows, not the lengths.

**Do not flag** (known conventions, explained in section 2): meeting stiles of sliding sashes drawn overlapping / coincident (U8); covers, beads, plates and overlay frames drawn on top of another member (U9); a `sliding_2` drawing with no glass tint or slide arrows (R-8a: frozen legacy drawing); hardware lines with unit price 0 and no part (owner said 2026-10-15 linking is not needed yet); every butt deduction showing 0 with `no_butt_distance` on CHANG (imported profiles have no `width_mm` / `butt_distance_mm` yet; data, not a bug).

Notation used below: `W`, `H` = item width / height (mm). `b(X)` = butt distance after notch of the profile on position X (`alu_profiles.butt_distance_mm`, else the perpendicular dimension via the primary contact surface). `w(X)` = profile full width (`width_mm`). `o` = one sash overlap. "through" = วิ่งสุด (full length, no end deduction). "butt" = วิ่งชน (length minus `b` of the member it butts, per end).

---

## 1. Glossary

| Thai term | Meaning | In the app |
|---|---|---|
| วงกบ | The outer frame of a window/door unit (4 members, or 3 for a door without sill). | Part `frame` in most layouts; positions `frame_top`, `frame_bottom`, `frame_side`. |
| เฟรมบน / เฟรมล่าง / เฟรมข้าง | Head / sill (bottom frame) / jamb (side frame) members of the วงกบ. | `frame_top` / `frame_bottom` / `frame_side` (×2, labels ซ้าย / ขวา). |
| เฟรมข้างติดกล่อง / เฟรมข้างไม่ติดกล่อง | Sliding-system side frame profile with / without the integral track box. | Families in the sliding series; ไม่ติดกล่อง is the add-on overlay side (`ao_frame_side`). |
| กล่องเรียบ / กล่องร่อง | Plain rectangular box tube / box tube with a glazing groove; base profiles every extruder has. | Default families for fixed frames, mullions (`กล่องร่อง` for ทั่วไป templates). |
| กล่องร่องวิ่งยาว | The long-running grooved box that replaces the sliding side frame when a top/bottom ร่วมวงกบ add-on is present. | Family on the merge piece `ext` (AO-9). |
| บาน | A sash (window) or leaf (door): the movable or glazed panel inside the frame. | Parts `sash`, `sash_left/mid/right`, `sash_fixed/middle/front`, `leaf`, `awning`. |
| บานเลื่อน | Sliding sash. | `sliding_2`, `sliding_n`, `sliding_3track`, `sliding_2_fixed_2`. |
| บานเลื่อนบน / บานเลื่อนล่าง | Top / bottom rail of a sliding sash. | Positions `sash_top`/`sash_bottom` (sliding_2), `*_top`/`*_bottom`. |
| เสากุญแจ | Lock stile: the sash stile that closes against the frame and carries the lock/handle. | `key_stile`, `*_key_stile`; in `sliding_2_fixed_2` piece names of `stile_a`/`stile_b`. |
| เสากุญแจตัวผู้ / ตัวเมีย | Male / female lock stiles that meet at the centre of a 2+2 sliding unit. | `sliding_2_fixed_2` `pieceNames`. |
| เสาเกี่ยว | Hook (interlock) stile: the stile where two sliding sashes on different tracks hook and overlap. | `hook_stile`, `*_hook_stile`, `mid_hook_a/b`. |
| ระยะซ้อนบาน (overlap) | How much two neighbouring sliding sashes overlap at the hook stiles. | `parts[].overlap_mode` `auto_hook` (= `b(hook)` else `w(hook)`) or `manual` `overlap_mm`; added back in rail length × `overlapCount`. |
| บานฟิก / บานติดตาย / ติดตาย | Fixed (non-opening) sash or fixed light. | `fixed: true` parts; layout `fixed_grid`; add-on kind `fixed`. |
| F | Mark for a fixed pane in the drawing. | Drawn in the glass corner (owner 2026-10-15, commit 96b8520d). |
| ซอยกลาง (ตั้ง / นอน) | Intermediate mullion (vertical) / transom (horizontal) dividing glass. | `mullion` / `transom` positions (grid layouts); add-on pieces `mullion` / `rail`. |
| ซอยหลอก | Fake divider: a decorative bar on the glass, not structural. | Add-on `fake_rows` / `fake_cols` (1 = none); drawn at half frame width; no BOM line, no price. |
| คานกั้น | Divider member between the main unit and a ร่วมวงกบ add-on. | Merge piece `divider`; qty 0 by default on sliding top/bottom (AO-9), 1 on left/right. |
| ช่องแสง | An extra light (transom light / side light) added to the main unit. | Inline add-ons `estimation_item_addons` (mode / kind / position / len / thick / rows / cols / align). |
| ร่วมวงกบ (merge) | The add-on shares the main frame: main members stretch through it. | `mode: 'merge'`; pieces `ext`, `divider`, `main_facing`, `ao_frame_side`, `ao_bead`, `ao_frame_far`, `mullion`, `rail`. |
| แยกวงกบ (attach) | The add-on has its own complete frame set beside the main unit. | `mode: 'attach'`; pieces `frame_top`, `frame_bottom`, `frame_side`, `mullion`, `rail`; its own synthetic opening. |
| เสมอบน / เสมอล่าง / เสมอซ้าย / เสมอขวา | An add-on aligned flush with one end of the whole stack. | `align: 'start' / 'end'` (AO-13). |
| ระยะชน (หลัง notch) | Butt distance after notch: how much a butting bar is shortened per end when it butts this profile. Example: side frame full width 51.3, butt distance 38.1. | `alu_profiles.butt_distance_mm`; `buttOfFor` in `openingCost.js`. |
| notch | Machining of a bar end so it sits into the profile it butts; it is why butt distance < full width. | Implicit in `butt_distance_mm`. |
| ผิวสัมผัสหลัก (primary contact surface) | The face of a profile that a butting bar rests on; decides the fallback deduction. | `primary_contact` `width` (default; deduct `depth_mm`) / `depth` (deduct `width_mm`). |
| วิ่งสุด / วิ่งชน | Run through (full length) / butt (shortened by the butted member). | End modes `through` / `butt` in `ends`; editor markers "สุด" (green) / "ชน" (orange). |
| เข้ามุม 45° | Mitred corner: both bars cut at 45°, no butt deduction, length = outer (long-point) length. | `corner: 'mitre'` -> `cut_style: 'miter45'`, `end_deduction_mm` 0. |
| ตบธรณี | Sill cover strip clipped on the sill. | `sliding_2_fixed_2` free position `sill_cover`, `W × 0.5`. |
| ตบเรียบ / ตบร่อง | Machining notes: face milled flat / grooved. | Merge `main_facing` note: top add-on `ตบเรียบ (รองคิ้วเท)`, bottom add-on `ตบร่อง` (suffix in BOM `role_name`). |
| คิ้ว / คิ้วเท / คิ้วประตู / คิ้วบาน | Bead / glazing bead: clip-on strip holding glass or covering a joint. คิ้วเท = bead laid on the main head under a top add-on. | `ao_bead`; swing door `leaf_bead_v/h`; folding `leaf_cover_h`. |
| ฝาครอบ / ฝาปิด | Snap-on cover cap. | Curtain wall `cover_w` / `cover_h` (NO.3112). |
| แผ่นกด | Pressure plate (curtain wall). | `plate_w` / `plate_h` (NO.9019). |
| บังใบ | Leaf rebate cover / astragal strip on a folding leaf edge. | `folding_door` free `leaf_cover_v`. |
| ราง / รางบน / รางล่าง | Track; head track / bottom track. | Sliding frame members (renamed รางบน / รางล่าง (ธรณี) when `door`), folding `track_*`, hanging `track_rail`. |
| รางแขวน | Top-hung sliding door track. | `hanging_door` `track_rail` (+ cover `track_cover`), factor 2. |
| ธรณี | Threshold / door sill. | `swing_door` `sill` (input `sill` yes/no). |
| ธรณีกันบานเลื่อน | Sill guard under the fixed sash of เลื่อน 1 ฟิก 1. | `sliding_2` free position `sill_guard` (`one_fixed` = 1). |
| ลูกล้อ | Roller (sliding sash wheel). | Hardware lines `ลูกล้อ`, `ลูกล้อรางแขวน`, `ล้อบน/ล่างบานเฟี้ยม`. |
| บานพับ / บานพับวงกบ | Hinge / hinge on the frame (folding door jamb). | Hardware lines. |
| แขนค้ำกระทุ้ง | Awning stay. | Hardware, 2 per awning sash. |
| โช้ค / door closer ฝังวงกบบน / เดือยบน/ล่าง | Concealed head closer / top-bottom pivots of a framed swing door. | `swing_door` with `pivot`. |
| patch fitting / floor spring / กุญแจล็อคพื้น | Frameless glass door fittings. | `frameless_door` hardware. |
| ไกด์พื้น | Floor guide of a hanging door. | `hanging_door` hardware. |
| บานกระทุ้ง | Awning (top-hung, pushed out). | `awning_grid`; curtain-wall `awning` cells; add-on kind `awning` (costed as fixed for now). |
| บานเปิดข้าง | Side-hung casement window. | `casement_n`. |
| บานเปิด / บานสวิง | Hinged door / pivot swing door (framed). | `swing_door` (`pivot` false / true). |
| บานสวิงเปลือย | Frameless glass swing door. | `frameless_door`. |
| บานเฟี้ยม | Folding (bi-fold) door. | `folding_door` (`nL`, `nR`). |
| mullion / transom / spandrel | Curtain wall vertical / horizontal member / opaque panel cell. | `curtain_wall` positions, `cells` kinds glass / awning / spandrel. |
| ส่วนประกอบ / ทั้งชุด / เสร็จแล้ว | Template part-editor tab / whole-unit tab / per-part "done" tick. | UI only; `_done` is not an input. |
| ภาพเก่า | Saved drawing older than the data (signature mismatch). | `itemPreviewSignature`. |

---

## 2. Universal rules

### U1. No in-line continuation (CONFIRMED, owner 2026-10-16)
"A frame member that is cut can never simply continue into another member in line with it with nothing between them. Wherever a profile ends, it must end against a member that crosses it (a transom/divider/side). Example found: in W-01 (sliding 2 + top merged add-on) the add-on's side frame stood directly on the main side frame at 1.20 m — wrong; the side must run through and the divider butts between."
Source: owner statement 2026-10-16, commit `9ebb1a8b` message and test `partPreviewSvg.test.js` "merge add-ons: a flush side runs through the main frame; a non-flush one stops against the main frame member".
Consequences the QA agent must check:
- U1a. A ร่วมวงกบ top/bottom add-on flush with the main side: the main side frame is ONE bar from the add-on's outer edge to the main sill (drawing) and ONE BOM piece at `th` (costing: `ext` override `lengthMm = th`). Left/right add-on: the main head and sill are one bar each at `tw`.
- U1b. A ร่วมวงกบ add-on NOT flush with a main side (shorter `len` or offset): its own side bars stop on the main frame member that crosses them (the main head for a top add-on). The main side keeps `H`.
- U1c. Any drawing in which two collinear bars of the same orientation meet end to end with no crossing member between them is a defect, except: free trims (U9) and frame-to-frame contact between two separate frames (see U1d).
- U1d. CONFIRMED (owner 2026-10-16, Q3): "Depends on the series. For serie general an add-on can NOT stand on the old frame; it must become a shared frame (วงกบร่วมกัน) + adapter." Serie general (ทั่วไป): a แยกวงกบ add-on whose side bars stand on the main frame, and the double bar (main frame member + add-on frame member back to back) at the joint, are **defects**. The drawings show one shared box member at every joint: a top light over a unit uses กล่องเปิด + ฝาปิด; glass under a unit uses กล่องเรียบ + ฝาตบร่อง; side by side uses one กล่องร่อง mullion + ฝาตบร่อง. The outer jambs run the whole stack (series file §3.11 J1-J6, p15 A43 sections 28/30/22/23). Other series: still open, do not flag.

### U2. Every corner has exactly one through member (CONFIRMED, owner 2026-10-10, part-editor spec §2 decision 4)
"At a corner exactly one of the two pieces runs through; changing one flips the other automatically." Not applied to mitred parts (U5) or tee joints (U4). `validateCorners(model)` reports `corner_violation`, `both_through`, `both_butt`.

### U3. Which member runs through at a frame corner
- U3a. Sliding frames: the two side frames run through, head and sill butt between them (waterproofing). CONFIRMED (owner, handover Ruling 5 and part-editor spec decision 6, 2026-10-10).
- U3b. Sliding sashes: stiles (เสากุญแจ, เสาเกี่ยว) run through, rails butt into the stiles. CONFIRMED (owner, part-editor spec decision 6, 2026-10-10).
- U3c. Door leaves (บานเปิด, บานสวิง, รางแขวน, บานเลื่อนรางล่าง, บานเฟี้ยม): "ต่อตรง", stiles run through, rails butt. CONFIRMED (owner D15, 2026-10-13).
- U3d. Frames of non-sliding kinds (fixed_grid, awning_grid, casement_n, frameless_wall, swing_door, frameless_door): sides through, head/sill butt, the same as sliding. CONFIRMED (owner 2026-10-16, Q2 "yes"). The code agrees (layout joints `through: 'v'`).
- U3e. Folding door (บานเฟี้ยม) track frame: **top/bottom tracks run through, side tracks butt** between them. CONFIRMED (owner 2026-10-16, Q1 answer (ก); same as spec 5.10). The code is wrong: the joint says `through: 'v'`, so top/bottom butt into the sides, AND the side rule is `height_minus` `track_top_bottom`. Both members are shortened at each corner (at b = 40: top/bottom 80 mm too short each). QA: flag it (defect D1).

### U4. Grids: verticals run through, horizontals butt (CONFIRMED, owner D7, 2026-10-13)
"Vertical mullions run full height; horizontal transoms butt into them. The same rule applies to every grid (curtain wall, awning grids)." Code: tee joints, mullion `height_minus` `frame_top_bottom`; transom `width_minus` with `grid_*` auto (frame sides + (cols−1)·w(mullion)) / cols, ends `through` because the pre-deduction already removed the mullion widths (R-3a, INFERRED: uses mullion WIDTH, not its butt distance; cost if wrong: transom long by (w − b) per end for profiles whose butt < width). Add-on grids: mullions through, rails between, drawn as wide as the frame (CONFIRMED owner 2026-10-15, commit 96b8520d).

### U5. Mitre (CONFIRMED)
- U5a. Awning and casement window sashes are mitred 45° at all four corners; only those (D11 and D15, owner 2026-10-13). Code: `awning_grid`, `casement_n`, curtain-wall `awning` parts `corner: 'mitre'` -> `cut_style: 'miter45'`, `end_deduction_mm` 0.
- U5b. A 45° piece's length is always its OUTER (long-point) length; mixing in the inner length causes big errors (owner, Ruling 6, 2026-10-09). The cut list, labels and BOM must say outer length.
- U5c. Saw kerf 3 mm (90°) and 10 mm (45°) are placeholders; 10 mm is the owner's estimate, real values to be measured (owner, Ruling 6). Whole-project cut optimizer only (owner). Do not judge kerf numbers as wrong.

### U6. Butt deduction (CONFIRMED, owner Ruling 5 and part-editor decision 5)
- U6a. A butting end is shortened by the butt distance after notch of the profile it butts (e.g. side frame 51.3 wide, butt distance 38.1). Overridable per end (manual mm). Snapping a cover into a groove does not change it.
- U6b. If `butt_distance_mm` is empty, the fallback is the dimension perpendicular to the profile's primary contact surface: กล่องเรียบ 101.6 × 44.45 with contact on the 101.6 face deducts 44.45 (default); contact on the narrow face deducts 101.6 (owner example).
- U6c. A missing butt distance is never silently 0: the cost summary shows `no_butt_distance` ("โปรไฟล์ที่ชนไม่มีระยะชน"); add-on 2·butt pieces still at 0 raise `addon_deduction_zero`. CONFIRMED in spirit (owner rule "never priced as 0" is the spec's; the reason codes are agent design) — treat the absence of a warning as a defect.
- U6d. A butting end points at the piece it actually butts (a sash rail butts a stile, not the side frame) (part-editor spec §9, from the owner's mockup iterations). INFERRED wording, CONFIRMED by owner-approved mockup v24 numbers; QA treats it as CONFIRMED-by-mockup only for sliding_2.

### U7. Sash sits inside the frame opening (CONFIRMED for sliding, owner 2026-10-10 decision 7)
Stile = `H − b(frame_top) − b(frame_bottom)`. Rail per sash (2 sashes) = `[W − b(left) − b(right) − 2·b(key) − 2·b(hook) + o] ÷ 2`, written in code as `(W − 2·b(frame_side) + o) × 0.5 − b(hook) − b(key)`. Owner sample: 1800 × 1200, b(side) 38.1, b(top) 38.1, b(bottom) 35.8, stiles 25, hook 25 -> frame 1723.8 / 1200, rails 824.4, stiles 1126.1.
- U7a. `o` = `b(hook)` else `w(hook)` (PE-5, INFERRED; the owner's formula says "+ hook stile × 1" without saying width or butt). Cost if wrong: each rail off by (w − b)/2.
- U7b. Other kinds use the same "inside the frame opening, zero clearance" approach (sash outer size = frame inner opening or grid cell). Owner 2026-10-16 (Q8): "depends on the series; read it from the drawings". For serie general the drawings show **sub-frames inside the grid cell**, not sashes cut to the cell:
  - **Awning:** inner frame กรอบใน + sash. The sight line from the box face to the glass is 66 per side.
  - **Sliding:** a 2-track sub-frame whose side shows 19 beyond the 44.5 box. Hook stile 34.4.
  - **Door leaf:** stile 54, top rail 52, bottom rail 80.

  No gap is dimensioned (series file §5). So zero clearance stays INFERRED. The general-series awning also misses the กรอบใน member entirely (defect D9). Exact gaps: questions G3, G4.

### U8. Sliding sash overlap in the drawing (CONFIRMED, owner 2026-10-10 decisions 9-10)
Neighbouring sashes on different tracks physically overlap at the hook stiles. The drawing shows them overlapping by one stile width, visible sash drawn last (on top); outside view: the LEFT sash is the outside one; inside view swaps it. Coincident / overlapping meeting stiles are the convention: do NOT flag. Which stiles meet in the middle: **เสาเกี่ยว hooks onto เสาเกี่ยว, lock stiles at the jambs**. CONFIRMED (owner 2026-10-16, Q7; SEEN on the Nakhon Nayok drawings p15/p3 section 26). `sliding_n` / `sliding_3track` already do this. `sliding_2` puts the hook stile on the left of every sash, so the left sash has its hook at the frame and the middle is key + hook. That is a drawing defect (D7). Costing is the same (2 key + 2 hook at n = 2).

### U9. Clip-on members drawn on top (CONFIRMED where owner-ruled, else INFERRED)
Positions with `corner: 'free'` and add-on overlay pieces sit ON another member; overlap in the drawing is intentional, they have no corner partner and no end deduction: ธรณีกันบานเลื่อน, ตบธรณี, คิ้วเท and เฟรมข้างไม่ติดกล่อง (overlay, "แปะทับ") on a sliding top/bottom merge (CONFIRMED, owner AO-9 2026-10-15), คิ้วประตู, บังใบ, คิ้วบาน, แผ่นกด, ฝาปิด, รางแขวน + กล่อง 1-3/4 (INFERRED, from layouts / spec). Do not count them in U1 / U2 checks.

### U10. Drawing views (CONFIRMED)
- U10a. Two views, outside (`out`) and inside (`in`); inside is the mirror image; opening symbols dashed / solid swap with the view (spec §6 + owner-accepted mockup v5, 2026-10-13).
- U10b. Saved preview and quotation attachment = double-line style, no part-length labels, both views (owner, Ruling 11 is agent-made but "keep all four styles" is owner, 2026-10-09). Live preview keeps double, double + lengths, solid, CAD (D14 owner).
- U10c. Opening symbols (owner-accepted mockup v5): swing/casement V with apex at the hinge side; awning V apex at the top; sliding arrows (sliding_n halves: left half →, right half ←; 3-track / 2+2 toward the fixed sash); folding alternating V + split line when both sides > 0; fixed panes marked F in the glass corner (owner 2026-10-15). `sliding_2` (legacy) draws no arrows; under เลื่อน 1 ฟิก 1 it marks the fixed sash with F in the glass corner (owner 2026-10-15) but `fixed_side` does not move anything else in the picture (known deferred).

### U11. Dimensions (CONFIRMED, owner 2026-10-15, commit 63f4088e)
Drawings with add-ons carry three levels: main unit, each add-on, whole unit. Along each axis a chain on the first line (main + every add-on on that axis, each with its own size) and the overall size on a second line when the chain has more than one segment; text "รวม W × H มม.". Axis without add-ons: one line. Not dimensioned: a top/bottom add-on shorter than the main width (known gap). Item form sizes in mm (owner, Ruling 23).

### U12. Add-on placement (CONFIRMED, owner AO-13 2026-10-15)
No free offset in the UI: an add-on is flush with one end of the whole stack (main + perpendicular add-ons): top/bottom choose เสมอซ้าย / เสมอขวา, left/right choose เสมอบน / เสมอล่าง. Same-side add-ons stack outward in list order (`layoutAddons`).

### U13. Costing chain (mixed tags)
1. Piece length (m) per component: `computeComponentLength` = `(base − pre/1000) × factor − end/1000`, or `fixed_length_mm/1000 × factor − end/1000` for add-on pieces / overrides.
2. Aluminium line: `cost = length_m × qty × price_per_m`; per-kg providers: `price_per_m = price_per_kg(finish, provider, effective_from ≤ price_as_of) × linear_weight_kg_per_m`; per-piece: `price_per_piece / variant length`. Weight = `length × qty × kg/m`. Price per kg is by finish, provider-wide: owner table 2026-10-15 (ANODIZED NA 170, 512 190, 517 210, POWDER COATING WHITE 170, BLACK 170, SAHARA 250, WOOD GRAIN 350 บาท/กก.) CONFIRMED. Price lock by `effective_from` / `price_as_of` CONFIRMED (owner Ruling 1).
3. Thickness: frame and sash thickness separate (government case frame 2.0 / sash 1.5) where the series×type allows it; members tagged `thickness_role 'sash'` use the sash thickness. CONFIRMED (owner Rulings 3, 21). Door leaves use role `sash` (R-9a) INFERRED.
4. Waste: engine adds `aluminium × template.waste_pct`; the price-structure tab replaces it with the project's waste % (P3-2) INFERRED.
5. Hardware: `qty × part net price` (list × (1 − discount %)), else reference price; a 0 price is flagged `no_hardware_price`. Hardware set from the project's package by type (owner Ruling 20). Layout default counts: section 3, INFERRED except sliding_2 (CONFIRMED).
6. Per item, the layout hardware follows the item's options by delta (`itemHardwareRows`): owner 2026-10-15 "door is chosen per item" CONFIRMED.
7. Infill: `Σ cells (cellW − infill_width_deduction) × (cellH − infill_height_deduction) × price/m²`, cells from the template grid / `panel_count`, NOT from the layout model (frameless leaves, curtain-wall spandrels, layout glass parts are not priced yet: known gap). INFERRED.
8. Labour `W × H × rate` (item -> project -> type -> template). Silicone and felt `2(W + H) × rate`. Computed on the main opening only. INFERRED.
9. Extras: one shim + screw + plug per fixing point, every 0.6 m, at least 2 per side, per frame (owner); off until the parts are linked in settings (Ruling 8, INFERRED). Sealant length = perimeter of every frame unit; 300 ml tube = 10 m (owner). A merge add-on grows the main frame to the envelope; each attach unit is its own frame.
10. Offcuts never reduce cost (Ruling 7, INFERRED). Stock length: per-profile override > project > 6.4 m (Ruling 15, INFERRED).
11. Add-ons: attach units are priced inside the same item as their own openings (main template's waste, labour, silicone, felt rates; item's infill; no hardware) (AO-3, INFERRED). Merge pieces are lines of the main BOM; merge glass priced as `count × paneW × paneH × infill price` (INFERRED).

---

## 3. Per kind

Unless stated, numbers use the uniform test values `b = 40` for every profile, `w = 60` for every profile (so `o = 40` for auto_hook), at the default params. sliding_2 uses the owner's sample values. Formula first, then the value the real code produced. "×n" = pieces per unit.

### 3.1 `sliding_2` — บานเลื่อนสวน 2 บาน (type บานเลื่อนสวน 2 บาน)
Inputs: `door` (ประตู / หน้าต่าง, per item, CONFIRMED owner 2026-10-15), `one_fixed` 0 = เลื่อนสวน / 1 = เลื่อน 1 ฟิก 1, `fixed_side` (CONFIRMED owner S-1, 2026-10-14/15). Parts: วงกบ ×1, บานเลื่อน ×2 (one part, count 2, tracks alternate).
1800 × 1200, b(FS) 38.1, b(FT) 38.1, b(FB) 35.8, b(KS) = b(HS) = 25, o = 25, w(KS) 50:

| Member | Ends | Formula | ×n | Length |
|---|---|---|---|---|
| เฟรมบน / เฟรมล่าง | butt both into เฟรมข้าง | `W − 2·b(FS)` | 1 + 1 | 1723.8 |
| เฟรมข้าง | through | `H` | 2 | 1200 |
| บานเลื่อนบน / ล่าง | butt into hook + key stile | `(W − 2·b(FS) + o) × 0.5 − b(HS) − b(KS)` | 2 + 2 | 824.4 |
| เสากุญแจ / เสาเกี่ยว | through | `H − b(FT) − b(FB)` | 2 + 2 | 1126.1 |
| ธรณีกันบานเลื่อน (only `one_fixed` 1) | free | `(W − 2·b(FS) + o) × 0.5 − b(HS) − b(KS) + w(KS)` | 1 | 874.4 (w(KS) 50) |

Tags: frame/sash lengths CONFIRMED (owner 2026-10-10, worked example). Sill guard formula CONFIRMED (owner sheet thread, memory note line 74: "w = profile width, confirmed"). Sill guard thickness: owner said **frame thickness**, code gives `thickness_role 'sash'` (rule `role: 'sash'` in `sliding_2.js`): a mismatch; QA: flag it (cost: priced at sash thickness, e.g. 1.5 instead of 2.0).
Hardware (CONFIRMED owner sheet thread + S-1): ลูกล้อ `4 − 2·one_fixed` (2 per sliding sash), มือจับล็อค (ด้านใน) `2 − one_fixed`, กุญแจ/มือจับเรียบ (ด้านนอก) `door × (2 − one_fixed)`. Defaults: 4 / 2 / 0; door + 1 ฟิก 1: 2 / 1 / 1.
Drawing must show: 4 frame bars (sides full height), 2 sashes each `inW/2 + hook/2` wide overlapping in the middle (U8), no glass tint / arrows (legacy), F in the glass corner of the fixed sash when `one_fixed` = 1, the sill guard strip under the fixed sash.

### 3.2 `sliding_n` — บานเลื่อน n บาน (type บานเลื่อนรางล่าง, `door: true` pinned)
Inputs: `n` 2-6 (item), `door` (type). Parts บานซ้าย (key at frame + hook), บานกลาง ×(n−2) (hook + hook), บานขวา (hook + key at frame) -> 2 key + 2(n−1) hook stiles (R-F1 INFERRED / spec 5.4). Tracks alternate 1,2,1,2.
Rail = `(W − 2·b(FS) + (n−1)·o) / n − b(left stile) − b(right stile)`; stile = `H − b(FT) − b(FB)`; frame as sliding_2. With `door`: bottom frame named รางล่าง (ธรณี), top รางบน.
1800 × 1200, n 2, b 40, o 40: เฟรมบน/ล่าง 1720 ×1+1; เฟรมข้าง 1200 ×2; rails `(1800 − 80 + 40)/2 − 80` = 800 ×4; stiles 1120 ×4 (2 key, 2 hook). n = 2 reproduces sliding_2's per-family totals (test). Code test n 3 at 2700: rail before end deductions `(2700 − 90 + 80)/3` = 896.67.
Hardware (CONFIRMED owner 2026-10-16, Q12 "yes"): ลูกล้อ 2 per sash, กุญแจ/มือจับ 1 per unit -> n 2: 4 / 1.
Drawing: n sashes, glass, slide arrows left half → right half ←, hook-hook overlaps between sashes.
Families: sliding families of series ทั่วไป (gen script `sliding` map) INFERRED; owner question #6 (which series for the bottom-rail door) still open.

### 3.3 `sliding_3track` — บานเลื่อน 3 บาน (3 tracks)
Three tracks, บานฟิก on the back track (fixed), บานกลาง middle, บานหน้า front (CONFIRMED owner D9 2026-10-13). Fixed side default left, mirror per item (R3 INFERRED, open owner question 1). Stiles: fixed = key at frame + hook; middle = hook + hook; front = hook + key at frame (spec 5.5, INFERRED).
Rail = `(W − 2·b(FS) + 2·o)/3 − 2·b(stile)`; stile `H − b(FT) − b(FB)`.
1800 × 1200, b 40, o 40: frame 1720 / 1200; rails `(1800 − 80 + 80)/3 − 80` = 520 ×6 (2 per sash); stiles 1120 ×6 (2 key, 4 hook).
Frame families default รางบนบิ๊กเฟรม / รางล่างบิ๊กเฟรม 2 ราง (a "2 ราง" sill on a 3-track unit; from the Excel, INFERRED; QA may note it, the owner set Big Frame series in the generator).
Hardware (INFERRED): ลูกล้อ 4 (2 on each sliding sash), ราง 3 (informational).
Drawing: 3 sashes, F on the fixed pane, arrows on the sliding two pointing toward the fixed sash.

### 3.4 `sliding_2_fixed_2` — บานเลื่อน 2 ตาย 2
Four sashes on two tracks, outer two fixed on the back track, left→right stiles: วงกบ · เสากุญแจ · เสาเกี่ยว ‖ เสาเกี่ยว · เสากุญแจตัวผู้ · เสากุญแจตัวเมีย · เสาเกี่ยว ‖ เสาเกี่ยว · เสากุญแจ · วงกบ; no เสาตาย (CONFIRMED owner D10). Equal glass on all four sashes (CONFIRMED owner D17).
Rail = `(W − 2·b(FS) + 2·o) / 4 − b(stile_a) − b(stile_b)`; stiles `H − b(FT) − b(FB)`; ตบธรณี free `W × 0.5`.
1800 × 1200, b 40, o 40: frame 1720 / 1200; rails `(1800 − 80 + 80)/4 − 80` = 370 ×8; stiles 1120 ×8; ตบธรณี 900 ×1.
INFERRED: `roles.hook = 'stile_b'` one family for all hook overlaps (R-5a; off by (b(stile_b) − b(stile_a)) × 2/4 per rail when mixed); generator sets both stile families to เสาเกี่ยว (handover "guesses to review") so the เสากุญแจ pieces are priced as เสาเกี่ยว until the owner edits; ตบธรณี `W/2` from the Excel.
Hardware (INFERRED): ลูกล้อ 4, กุญแจ 1.
Drawing: 4 equal sashes, F on the two outer, arrows on the inner two toward their fixed neighbour.

### 3.5 `fixed_grid` — บานติดตาย (rows × cols)
Defaults rows 2, cols 3 (item). Frame: sides through, head/sill butt (U3d INFERRED). Mullions ×(cols−1) through between head and sill (CONFIRMED D7). Transoms ×(rows−1)·cols, one per column segment (R-3b arithmetic).
Mullion = `H − b(FT) − b(FB)`; transom = `(W − 2·b(FS) − (cols−1)·w(mullion)) / cols` (ends through, R-3a).
1800 × 1200, b 40, w 60: frame 1720 ×2 / 1200 ×2; mullion 1120 ×2; transom `(1800 − 80 − 120)/3` = 533.3 ×3.
Hardware: none. Drawing: frame, 2 full-height mullions, 3 transom segments between them, each pane marked F.
Families: กล่องเรียบ frame, ซอยกลาง 4"/2" ยูโร (layout) or กล่องร่อง (ทั่วไป templates, generator) INFERRED.

### 3.6 `awning_grid` — บานกระทุ้ง r ชั้น × c ช่อง (6 types; rows / cols pinned by the type name)
fixed_grid + one awning sash per cell, mitred (CONFIRMED D11), top-hinged, opens out by default (`open` item).
Sash rail = `(W − 2·b(FS) − (cols−1)·w(mullion)) / cols`; sash side = `(H − b(FT) − b(FB) − (rows−1)·w(transom)) / rows`; all outer lengths, no end deduction.
1800 × 1200, 2 × 2, b 40, w 60: frame 1720 / 1200; mullion 1120 ×1; transom `(1800 − 80 − 60)/2` = 830 ×2; sash rails 830 ×4 + 830 ×4 (miter45); sash sides `(1200 − 80 − 60)/2` = 530 ×8 (miter45).
INFERRED: sash = cell size with zero clearance (U7b); sashes clamp to 10 (MAX_PART_COUNT) for 3×4 etc. while hardware uses the full count.
Hardware (INFERRED): แขนค้ำกระทุ้ง 2 per sash, มือจับ 1 per sash -> 8 / 4 at 2 × 2.
Drawing: grid + V with apex at the top in each cell; dashed/solid by `open` and view.

### 3.7 `casement_n` — บานเปิดข้าง (n per item) / บานเปิดข้างเดี่ยว (n = 1 pinned, CONFIRMED D8)
Frame + (n−1) mullions + n mitred sashes (CONFIRMED D11). Hinge: n = 1 by input `hinge`; n ≥ 2 alternate (n 2: left, right; n 3: left, left, right) (spec 5.3, INFERRED).
Sash rail = `(W − 2·b(FS) − (n−1)·w(mullion)) / n`; sash side = `H − b(FT) − b(FB)`; mitred.
1800 × 1200, n 2: frame 1720 / 1200; mullion 1120 ×1; sash rails `(1800 − 80 − 60)/2` = 830 ×2 + ×2; sash sides 1120 ×4.
Hardware (INFERRED): บานพับ 2 per sash, มือจับ 1 per sash -> 4 / 2.
Drawing: V apex at the hinge stile of each sash.

### 3.8 `swing_door` — บานเปิด (hinged) / บานสวิงเดี่ยว / บานสวิงคู่ (pivot)
Inputs: `leaves` 1-2 (type pins for สวิง), `hinge` (1 leaf), `open`, `sill` yes/no (CONFIRMED D4/D5), `pivot` (type). Rails top/bottom same size, no kick rail (CONFIRMED D4). Leaves butt-jointed (CONFIRMED D15). Pivot door: no hinges, concealed head closer + top/bottom pivots (CONFIRMED D5).
Head / sill = `W − 2·b(FS)` (butt); sides `H` (through); leaf stiles = `H − b(FT) − b(sill)` (sill absent -> head only, R-P3 INFERRED); leaf rails = `(W − 2·b(FS)) / leaves − b(hinge stile) − b(handle stile)`; beads คิ้วประตู ตั้ง ×2 per leaf = stile length, นอน ×2 per leaf = `(W − 2·b(FS)) / leaves` (I5 INFERRED).
900 × 2100, 1 leaf, sill yes, b 40: head 820, sill 820, sides 2100 ×2, stiles 2020 ×2, rails `820 − 80` = 740 ×2, beads 2020 ×2 and 820 ×2.
Bead lengths stay as set: vertical = stile length, horizontal = leaf width. CONFIRMED (owner 2026-10-16, Q9 answer (ก)). Do not flag the 820 bead against the 740 rail. The Nakhon Nayok drawings show คิ้วประตูสวิง on all four sides inside the leaf (p33 sections 61-65), so the physical bead is shorter. The owner chose the current (longer) cut on purpose. Note only, no defect.
Serie general, SEEN on p33: the doors in the reference set are floor-pivot doors with no sill, a กล่องแจ็คสัน head with a concealed closer, top rail 52 and bottom rail 80. The unequal rails conflict with D4's "rails same size" for this series (question G5).
Hardware (INFERRED counts, D5 items CONFIRMED): hinged: บานพับ 3 + มือจับ 1 per leaf; pivot: door closer 1 + เดือยบน/ล่าง 2 + มือจับ 1 per leaf (closer per leaf INFERRED).
Drawing: frame (dashed floor line when no sill), V apex at hinge stile; 2 leaves hinged on the outer stiles.

### 3.9 `frameless_door` — บานสวิงเปลือยเดี่ยว / คู่
Frame on top and both sides, no threshold; the leaf is frameless glass with patch fittings (CONFIRMED D16, D6). Head butts the sides (INFERRED U3d).
900 × 2100, b 40: head `W − 2·b` = 820 ×1, sides 2100 ×2. No leaf aluminium.
Hardware: patch fitting 2, floor spring 1, มือจับสแตนเลส 1, กุญแจล็อคพื้น 1 per leaf. Items D6 CONFIRMED (patch fittings flush top/bottom, pull handle, floor lock); counts and the floor spring INFERRED (handover #8: "guesses").
Drawing: 3 frame bars, glass leaf, patch fittings at the top and bottom of the hinge side, dashed floor.
Known gap: glass leaf not priced (U13.7).

### 3.10 `hanging_door` — บานเลื่อนรางแขวน
Track (รางแขวนใหญ่ + กล่อง 1-3/4 cover) free, `W × 2`; frame sides `H − b(track)` hung under the track; leaf stiles `H − b(track)` (through, `auto: 'track'` INFERRED, handover #7); leaf rails `(W − 2·b(FS)) / leaves − 2·b(stile)` (butt, D15 CONFIRMED).
900 × 2100, 1 leaf, b 40: track 1800 ×1, cover 1800 ×1, sides 2060 ×2, stiles 2060 ×2, rails 740 ×2.
Track 2·W for 1 and 2 leaves, leaf width = inner opening: CONFIRMED (owner 2026-10-16, Q10 "yes"). This is consistent with the Nakhon Nayok drawing p29 IA3: track cover 2800 ≈ 2 × 1400, leaf 1350, leaf 2400 under a 150 track. Leaf as tall as the frame sides (no floor gap) stays INFERRED. The 2-leaf drawing still shows 1.5·W of track against 2·W in costing: report that as a drawing mismatch only.
Hardware (INFERRED): ลูกล้อรางแขวน 2 per leaf, ไกด์พื้น 1.
Drawing: slide arrow toward the open side (1 leaf), outward from the middle (2 leaves).

### 3.11 `folding_door` — บานเฟี้ยม
Inputs `nL`, `nR` 0-5 each, not both 0 (CONFIRMED D1; cap 5 is R-6b INFERRED). Leaves butt-jointed (D15).
Track top / bottom = `W` with ends butting the sides (`W − 2·b(side)`); track sides = `H − b(top) − b(bottom)` (see U3e: both shortened); leaf rails = `(W − 2·b(track side)) / (nL + nR) − 2·b(leaf stile)`; leaf stiles `H − b(top) − b(bottom)`; บังใบ ×2 per leaf = stile length; คิ้วบาน ×2 per leaf = `(W − 2·b) / (nL + nR)`.
2400 × 2100, 2 + 2, b 40: track top/bottom 2320 ×1 each; track sides 2020 ×2; leaf rails `(2400 − 80)/4 − 80` = 500 ×4 + ×4; leaf stiles 2020 ×8; บังใบ 2020 ×8; คิ้วบาน 580 ×8.
INFERRED: free-line families (บังใบ, คิ้วบาน) and their lengths (handover #8); leaf height with no clearance to the tracks.
Hardware (INFERRED): rollers `2·(ceil(nL/2) + ceil(nR/2))` = 4; บานพับ 3 per fold between leaves = 6; บานพับวงกบ 3 per side with leaves = 6; มือจับ 1 per side = 2 (3 + 2: 6 / 9 / 6 / 2).
Drawing: alternating V per leaf, first leaf of each side hinged at the jamb, arrows to each stack side, dashed split line when both sides > 0 (D1).

### 3.12 `curtain_wall` — STICK WALL (`unitized` false) / UNITIZED CURTAIN WALL (true)
Inputs rows 3, cols 4, `spandrel`, `cells` (each cell cycles กระจก → บานกระทุ้ง → spandrel, CONFIRMED D2), `k` 0.5 / 1 / 0. Mullions ×(cols+1) full height, transoms ×(rows+1)·cols butting into mullions (CONFIRMED D7). No perimeter frame: the outer mullions/transoms are the edge.
Mullion = `H`; transom = `(W − (cols+1)·w(mullion)) / cols`; pressure plate / cover lines (Excel `(W(R+1) + H(C+1))(1−k)`): `W × (rows+1)(1−k)` and `H × (cols+1)(1−k)` each, absent when k = 1; awning cell sash `(W − (cols+1)·w)/cols` × `(H − (rows+1)·w(transom))/rows`, mitred.
4000 × 3600, 3 × 4, k 0.5, w 60: mullions 3600 ×5; transoms `(4000 − 300)/4` = 925 ×16 (R-7a); แผ่นกด นอน 8000 + ตั้ง 9000; ฝาปิด นอน 8000 + ตั้ง 9000.
INFERRED: meaning of `k` (Excel constant, the parent-spec question stays open); item may override the template's cell picture (R5, open owner question 2); sash families บานหน้าต่างยูโร / คิ้วยูโร placeholders; STICK WALL awning sash uses EURO profiles; UNITIZED family mapping (handover "guesses"). Spandrel panels not priced (known gap).
Hardware (INFERRED): แขนค้ำ 2 + มือจับ 1 per awning cell (template's cells only, R-F4).
Drawing: grid of cells, awning V in awning cells, spandrel cells opaque; unitized draws unit joints (D12).

### 3.13 `frameless_wall` — ผนังกระจกบานเปลือย
Perimeter frame on all four sides, full-height panes, vertical silicone joints only, no transoms, no fittings (CONFIRMED D3, D12).
1800 × 1200, cols 3, b 40: head/sill 1720 ×2, sides 1200 ×2. Silicone joints = cols − 1 = 2 (computed, not priced). Panes not priced (gap).
Hardware: none.

### 3.14 Inline add-ons (ช่องแสง) — UI gated to `sliding_2` only
Shared: kind `fixed` / `awning` (awning costed as fixed for now, INFERRED AO-12), position top/bottom/left/right, `len` along the main edge, `thick` outward, rows ≤ 6, cols ≤ 12, ≤ 6 add-ons (AO-5 INFERRED), `align` (U12 CONFIRMED), fake dividers drawing-only (CONFIRMED owner 2026-10-15). Piece length = `max(0, ref − deduction) × factor`; ext = `envelope span × factor − deduction`. Default "2·butt" deductions are filled from the set's side family (`fillDefaultDeductions`; side family = attach `frame_side`, merge `ao_frame_side` else `ext`).

Worked example (W-01 shape): main 1800 × 1200 sliding_2 with the owner sample butts, add-on 1800 × 400, rows 1, cols 3, all families set, add-on side butt 30 (so 2·butt = 60), ext butt 38.1.

**Merge, top (sliding_2), CONFIRMED structure (owner AO-9, 2026-10-15) + U1:**

| Piece | Rule | ×n | Length | Tag |
|---|---|---|---|---|
| ext -> main เฟรมข้าง substituted to กล่องร่องวิ่งยาว | `th` = H + thick | 2 | 1600 (replaces 1200) | CONFIRMED (AO-9, U1) |
| divider (คานกั้น) | `len − 2·b` | 0 | — (no divider on sliding top/bottom) | CONFIRMED (AO-9) |
| main_facing = main เฟรมบน kept, note ตบเรียบ (รองคิ้วเท) | stays `W − 2·b(FS)` | (1) | 1723.8 | CONFIRMED (AO-9) |
| ao_frame_side เฟรมข้างไม่ติดกล่อง (แปะทับ, overlay) | code: `h` (400). **Required: the sash (main unit) height, not the add-on height** | 2 | code 400 | structure CONFIRMED; length CONFIRMED (owner 2026-10-16, Q5) — code defect D4 |
| ao_bead คิ้วเท | code: `len − 2·b(overlay side)`. **Required: `len − 2·b(ext)` (the long box)** | 1 | code 1740; required 1723.8 at b(ext) 38.1 | CONFIRMED (owner 2026-10-16, Q4 (ก)) — code defect D3 |
| ao_frame_far (the add-on's outer head) | code: `len − 2·b(overlay side)`. **Required: `len − 2·b(ext)`** | 1 | code 1740; required 1723.8 | deduction CONFIRMED (owner 2026-10-16, Q4); family still null — code defect D3 |
| mullion ซอยกลางตั้ง | `h − 2·b` | cols − 1 = 2 | 340 | INFERRED |
| rail ซอยกลางนอน | `len − 2·b` | rows − 1 = 0 | — | INFERRED |
| glass | code: `((w − 2·b)/cols) × ((h − 2·b)/rows)`. **Required: `(w − 2·b − (cols−1)·w(mullion))/cols + bite` × the same for rows, bite ≈ 6 mm** | 3 | code 580 × 340 | CONFIRMED (owner 2026-10-16, Q6) — code defect D5; bite per edge vs per pane: question G6 |

Main sash rails / stiles unchanged (824.4 / 1126.1): no divider -> AO-2 does not apply (CONFIRMED by AO-9 "sash deduction unchanged").
**Merge, bottom (sliding_2):** same but note ตบร่อง on the main เฟรมล่าง, คิ้วเท qty 0 (AO-12 INFERRED); ext 1600, overlay 400 ×2, far 1740, mullions 340 ×2.
**Merge, left/right (spec defaults, INFERRED; owner left/right rulings pending):** ext -> main head and sill at `tw` = 2200 (both butting the sides -> 2123.8 each); divider ×1 `len − 2·b` = 1140; overlay side / bead / far frame qty 0; mullions `h − 2·b` = 1140 ×2 (h = 1200 for a left add-on); main sash deduction on that side uses the divider's butt (AO-2): rails 828.45 instead of 824.4; the substituted family's butt also drives the stile deduction (AO-10: stiles 1123.8). Glass 3 × 107.9 × 1123.8 (cols 3 across a 400 mm add-on: three very narrow panes; QA: plausible only if the user really asked for cols 3).
**Attach (แยกวงกบ), any side:** own opening `w × h` = 1.8 × 0.4; frame_top / frame_bottom `w − 2·b` = 1740 ×1 each; frame_side `h` = 400 ×2 (through); mullion `h − 2·b` = 340 ×(cols − 1); rail `w − 2·b` ×(rows − 1); glass 3 × 580 × 340; no hardware; main unit untouched (CONFIRMED structure, owner spec D2 2026-10-12; costing rules AO-3 INFERRED).
Gaps the QA agent should check and report:
- A1. (INFERRED) Non-flush merge add-on: costing still sets `ext` = `th` (main sides 1600). The drawing (commit 9ebb1a8b) keeps the main side at H and stops the add-on's sides on the main head. Costing and drawing disagree. By U1b the drawing is right: the BOM should keep the main side at H and give the add-on its own structural sides.
- A2. CONFIRMED (owner 2026-10-16, Q6): add-on glass deducts the mullion widths and adds glass bite of about 6 mm. The code does neither (D5).
- A3. CONFIRMED (owner 2026-10-16, Q4 (ก)): far frame and คิ้วเท deduct the butt of the extended กล่องร่อง (ext), not the overlay. The code uses the overlay (D3).
- A4. CONFIRMED (owner 2026-10-16, Q11): the merge add-on area gets labour per m² and silicone (and felt) too. The engine uses only the main W × H (D6).
- A5. CONFIRMED (owner 2026-10-16, Q3) + SEEN (series file §3.11): in serie general a top/bottom add-on is separated from the main unit by **one shared box transom** with an adapter cap:
  - Top add-on over a sliding unit: กล่องเปิด + ฝาปิด, with the sliding head track screwed under it.
  - Bottom add-on: กล่องเรียบ + ฝาตบร่อง, with the sliding sill on top.

  The code's sliding_2 top/bottom set has `divider` qty 0 and no adapter piece. AO-9 may hold for another series. For ทั่วไป it misses a box bar and a cap per add-on (D2). Ask G2 before changing W-01.

---

## 4. Rule register (one tag each)

| ID | Rule | Tag | Source / cost if wrong |
|---|---|---|---|
| U1 | No in-line continuation; a profile ends against a crossing member | CONFIRMED | owner 2026-10-16, commit 9ebb1a8b |
| U1a | Flush merge add-on: main member runs through, one piece at `th`/`tw` | CONFIRMED | owner 2026-10-16 + AO-9 |
| U1b | Non-flush merge add-on: its sides stop on the main frame member | CONFIRMED | owner 2026-10-16 (commit message) |
| U1d | Serie general: no add-on stands on an old frame; one shared box + adapter at every joint (other series open) | CONFIRMED | owner 2026-10-16 Q3 + Nakhon Nayok drawings |
| U2 | Exactly one through member per butt corner | CONFIRMED | owner 2026-10-10 decision 4 |
| U3a | Sliding frame: sides through, head/sill butt | CONFIRMED | owner Ruling 5 / decision 6 |
| U3b | Sliding sash: stiles through, rails butt | CONFIRMED | owner decision 6 |
| U3c | Door leaves butt-jointed, stiles through | CONFIRMED | owner D15 2026-10-13 |
| U3d | Non-sliding frames: sides through, head/sill butt | CONFIRMED | owner 2026-10-16 Q2 |
| U3e | Folding: top/bottom tracks through, sides butt (code shortens both: D1) | CONFIRMED | owner 2026-10-16 Q1 (ก) |
| U4 | Grid verticals through, horizontals butt | CONFIRMED | owner D7 |
| U4a | Transom pre-deduction uses mullion width, ends through | INFERRED | R-3a; (w − b) per end |
| U5a | Awning/casement sashes mitred, nothing else | CONFIRMED | owner D11, D15 |
| U5b | Mitred piece length = outer length | CONFIRMED | owner Ruling 6 |
| U5c | Kerf 3 / 10 mm are placeholders | CONFIRMED | owner Ruling 6 |
| U6a | Butt end deducts butt distance after notch of the butted profile | CONFIRMED | owner Ruling 5, decision 5 |
| U6b | Fallback = dimension perpendicular to primary contact face | CONFIRMED | owner Ruling 5 example |
| U6c | Missing butt distance is flagged, never silent 0 | INFERRED | spec/agent design; hidden under-costing |
| U6d | Butt end points at the member it really butts | INFERRED | part-editor spec §9 (mockup lessons); wrong deductions |
| U7 | Sliding stile / rail formulas (owner sample 1723.8 / 1200 / 824.4 / 1126.1) | CONFIRMED | owner 2026-10-10 decision 7 |
| U7a | Overlap unit = b(hook) else w(hook) | INFERRED | PE-5; (w − b)/2 per rail |
| U7b | Zero clearance between sash/leaf and opening/cell (series-dependent; general = sub-frames, gaps not dimensioned) | INFERRED | owner 2026-10-16 Q8 "read the drawings"; members too long |
| U8 | Sash overlap drawn on top, left sash outside, inside view swaps | CONFIRMED | owner 2026-10-10 decisions 9-10 |
| U8a | Meeting stiles hook-on-hook, keys at the jambs (sliding_2 drawing wrong: D7) | CONFIRMED | owner 2026-10-16 Q7 + drawings p15 (26) |
| U9 | Clip-on pieces (sill guard, ตบธรณี, คิ้วเท, overlay side) drawn on top | CONFIRMED | owner AO-9 / S-1 / D10 |
| U9a | Other free lines (คิ้วประตู, บังใบ, คิ้วบาน, plates, covers, track) are clip-on | INFERRED | layouts / spec |
| U10a | Outside/inside views mirror; symbols swap dashed/solid | CONFIRMED | owner-accepted mockup v5 |
| U10b | Four live styles; saved = double line | CONFIRMED | owner 2026-10-09 + D14 |
| U10c | Opening symbols as in mockup v5, F in glass corner | CONFIRMED | mockup v5 + owner 2026-10-15 |
| U11 | Three dimension levels with add-ons | CONFIRMED | owner 2026-10-15 |
| U12 | Add-on flush via align, stacks outward | CONFIRMED | owner AO-13 |
| C1 | Price per m = kg price (finish, provider) × kg/m, by effective_from | CONFIRMED | owner Ruling 1 + finish table 2026-10-15 |
| C2 | Frame vs sash thickness separate; sash members at sash thickness | CONFIRMED | owner Rulings 3, 21 |
| C3 | Door leaves at sash thickness | INFERRED | R-9a; leaf priced at wrong thickness |
| C4 | Project waste % replaces template waste on the price tab | INFERRED | P3-2 |
| C5 | Hardware set from the project's package by type | CONFIRMED | owner Ruling 20 |
| C6 | Layout hardware follows item options by delta | CONFIRMED | owner 2026-10-15 |
| C7 | Infill from template grid, layout glass/spandrel unpriced | INFERRED | known gap; glass cost |
| C8 | Labour = area × rate, silicone/felt = perimeter × rate, **including merge add-on area** (code: main only, D6) | CONFIRMED | owner 2026-10-16 Q11 |
| C9 | Fixing points every 0.6 m, min 2 per side; 1 tube = 10 m | CONFIRMED | owner (Ruling 8/9 inputs) |
| C10 | Shim/screw/plug off until linked; offcuts never reduce cost; stock 6.4 m | INFERRED | Rulings 7, 8, 15 |
| C11 | Attach units priced in the same item at main rates, no hardware | INFERRED | AO-3 |
| K1 | sliding_2 lengths | CONFIRMED | owner 2026-10-10 |
| K1a | Sill guard formula | CONFIRMED | owner sheet thread |
| K1b | Sill guard at frame thickness (code: sash) | CONFIRMED | owner sheet thread; code mismatch |
| K1c | sliding_2 hardware 2 rollers/sash, inner handle 1/sash, outer key 1/sash only when door | CONFIRMED | owner sheet thread + S-1 |
| K2 | sliding_n stiles 2 key + 2(n−1) hook, alternating tracks | INFERRED | spec 5.4 / R-F1 |
| K3 | 3-track: fixed on back track, sliding stack toward it | CONFIRMED | owner D9 |
| K3a | 3-track fixed side left by default, mirrorable | INFERRED | R3 |
| K4 | 2+2: four sashes two tracks, D10 stile order, no เสาตาย | CONFIRMED | owner D10 |
| K4a | 2+2: equal glass on all four | CONFIRMED | owner D17 |
| K4b | 2+2: one hook family; ตบธรณี W/2; both stiles เสาเกี่ยว in the generated template | INFERRED | R-5a, generator |
| K5 | fixed_grid transom count (rows−1)·cols, panes F | INFERRED | R-3b arithmetic |
| K6 | awning rows/cols from the type name; top hinge, opens out default | INFERRED | spec 5.2 (names CONFIRMED by catalogue) |
| K7 | casement single type n = 1 | CONFIRMED | owner D8 |
| K7a | casement hinge alternation for n ≥ 2 | INFERRED | spec 5.3 |
| K8 | swing: rails same size, sill yes/no, pivot = closer + pivots no hinges | CONFIRMED | owner D4, D5 |
| K8a | swing bead lengths (stile height / leaf width) as set | CONFIRMED | owner 2026-10-16 Q9 (ก) |
| K8b | stile without sill deducts head only | INFERRED | R-P3 |
| K9 | frameless door: frame top + sides, no sill, patch fittings, pull handle, floor lock | CONFIRMED | owner D6, D16 |
| K9a | frameless door floor spring + counts | INFERRED | handover #8 |
| K10 | hanging door: track 2·W (1 and 2 leaves), leaf = inner width | CONFIRMED | owner 2026-10-16 Q10 + drawing p29 IA3 |
| K11 | folding: nL / nR separate, split line, odd count leaves a swing leaf | CONFIRMED | owner D1 |
| K11a | folding free lines and their families | INFERRED | handover #8 |
| K12 | curtain wall cell cycle glass → awning → spandrel | CONFIRMED | owner D2 |
| K12a | curtain wall k semantics, item overrides cells, unitized families | INFERRED | R5, handover #9 |
| K13 | frameless wall: 4-side frame, vertical silicone joints only | CONFIRMED | owner D3, D12 |
| H1 | Hardware default counts for all kinds | CONFIRMED | owner 2026-10-16 Q12 |
| H2 | Hardware lines are fixed totals at template creation (pre-delta) | INFERRED | R-F4 (handover #4) |
| A0 | Merge sliding top/bottom: substitute side to กล่องร่องวิ่งยาว cut at th, 2 overlay sides, no divider, ตบเรียบ/ตบร่อง, top bead | CONFIRMED | owner AO-9 2026-10-15 |
| A0a | Overlay side = sash (main) height; bead/far `len − 2·b(ext)` (code: `h` and b(overlay): D3, D4); bottom bead 0 and far family null stay INFERRED | CONFIRMED | owner 2026-10-16 Q4, Q5 |
| A0b | Merge left/right defaults (divider ×1, AO-2 sash deduction) | INFERRED | spec 5.3, AO-2; owner rulings pending |
| A0c | Attach = own frame, main untouched | CONFIRMED | owner spec D2 2026-10-12 |
| A0d | Add-on dividers drawn frame-width; fake dividers half width, no price | CONFIRMED | owner 2026-10-15 |
| A1 | Non-flush merge: BOM must not extend the main side | INFERRED | derived from U1b; main sides over-priced by thick × 2 |
| A2 | Add-on glass deducts mullion widths, adds glass bite ≈ 6 mm (code: neither, D5) | CONFIRMED | owner 2026-10-16 Q6 |
| A3 | Far frame / bead deduct b of the extended side, not the overlay (code: overlay, D3) | CONFIRMED | owner 2026-10-16 Q4 (ก) |
| A4 | Merge add-on area gets labour/silicone (code: no, D6) | CONFIRMED | owner 2026-10-16 Q11 |

| A5 | Serie general top/bottom add-on: one shared box transom + adapter cap (กล่องเปิด + ฝาปิด on top, กล่องเรียบ + ฝาตบร่อง below) | CONFIRMED | owner 2026-10-16 Q3 + drawings p15 (28) (30) |

Count: 55 CONFIRMED, 24 INFERRED (79 rules). On 2026-10-16, 12 rules moved to CONFIRMED by the owner's answers and A5 was added. U7b stays INFERRED: the owner said "read the drawings" and the drawings give no gap.

---

## 5. Questions for the owner (all answered 2026-10-16)

Answers (CONFIRMED, owner 2026-10-16):
1. (ก) top/bottom tracks run through, side tracks butt. U3e, defect D1.
2. Yes. U3d.
3. "Depends on the series. For serie general an add-on can NOT stand on the old frame; it must become a shared frame (วงกบร่วมกัน) + adapter. See the rules and how to draw the live preview in the Nakhon Nayok shop drawing." U1d, A5, `docs/aluminium-series-general.md`, defects D2, D8.
4. (ก) far frame and คิ้วเท deduct the butt of the extended กล่องร่อง. A3, defect D3.
5. The overlay side frame is only as long as the sash height, not the full add-on height. Drawings p15 A43: the 2-track side lies on the long jamb only over the sliding cell. A0a, defect D4.
6. Yes, subtract the mullion widths, but add glass bite of about 6 mm. A2, defect D5.
7. Hook-on-hook in the middle. U8a, defect D7.
8. Depends on the series; read it from the drawings for serie general. U7b, series file §5.
9. (ก) beads as currently set. K8a.
10. Yes. K10.
11. Yes. C8/A4, defect D6.
12. Yes. H1.

Original questions, kept for reference:

1. บานเฟี้ยม: ที่มุมวงกบ ให้ รางบน/รางล่าง วิ่งสุด แล้ว รางข้าง ชน ใช่ไหม? (ตอนนี้โปรแกรมหักทั้งสองตัว ทำให้มุมขาด) — ตอบ: (ก) รางบน/ล่าง วิ่งสุด รางข้างชน (ข) รางข้างวิ่งสุด รางบน/ล่างชน
2. วงกบของบานติดตาย บานกระทุ้ง บานเปิดข้าง ประตูบานเปิด/สวิง และผนังกระจกเปลือย ใช้กติกาเดียวกับบานเลื่อน คือ เฟรมข้างวิ่งสุด เฟรมบน/ล่างชน ใช่ไหม? (ใช่ / ไม่ใช่)
3. ช่องแสงแบบแยกวงกบ เฟรมข้างของช่องแสงวางต่อบนหัวเฟรมข้างของบานหลักได้ไหม เพราะเป็นคนละวงกบ? (ได้ / ไม่ได้)
4. ช่องแสงร่วมวงกบด้านบน (บานเลื่อน): เฟรมด้านไกลและคิ้วเท ให้หักระยะชนของตัวไหน? (ก) กล่องร่องวิ่งยาว ที่วิ่งยาวขึ้นไป (ข) เฟรมข้างไม่ติดกล่อง ที่แปะทับ
5. เฟรมข้างไม่ติดกล่องที่แปะทับบนช่องแสง ยาวเท่าความสูงช่องแสงเต็ม (เช่น 400) ใช่ไหม? (ใช่ / ไม่ใช่ ต้องหักออก)
6. ขนาดกระจกช่องแสง ต้องหักความกว้างซอยกลางออกด้วยใช่ไหม? (ใช่ / ไม่ใช่)
7. บานเลื่อน 2 บาน ตรงกลางที่บานซ้อนกัน เป็น เสาเกี่ยว ชน เสาเกี่ยว ใช่ไหม? (ใช่ / ไม่ใช่ เป็นเสากุญแจกับเสาเกี่ยว)
8. บานกระทุ้ง บานเปิดข้าง และใบประตู ขนาดใบเท่าช่องเปิดพอดี ไม่ต้องเผื่อระยะห่างรอบบาน ใช่ไหม? (ใช่ / ไม่ใช่ ต้องเผื่อ … มม.)
9. คิ้วประตู (บานเปิด/สวิง) ยาวเท่าไหน? (ก) เท่าเสาบานและกว้างเท่าบาน ตามที่ตั้งไว้ตอนนี้ (ข) เท่าช่องกระจก คือหักราวและเสาออก
10. ประตูรางแขวน ใบบานกว้างเท่าช่องเปิดภายในวงกบ และรางยาว 2 เท่าความกว้าง ทั้งแบบ 1 บานและ 2 บาน ใช่ไหม? (ใช่ / ไม่ใช่)
11. ช่องแสงร่วมวงกบ ต้องคิดค่าแรงต่อ ตร.ม. และค่าซิลิโคนรวมพื้นที่ช่องแสงด้วยใช่ไหม? (ใช่ / ไม่ใช่)
12. จำนวนอุปกรณ์ตั้งต้น (บานพับ 3 ต่อใบประตู, แขนค้ำ 2 ต่อบานกระทุ้ง, บานพับ 2 ต่อบานเปิดข้าง, ลูกล้อ 2 ต่อบานเลื่อน, โช้ค 1 ต่อใบประตูสวิง) ถูกต้องใช่ไหม? (ใช่ / ไม่ใช่ จะแก้รายการไหน)

### 5b. New questions (2026-10-16): things the Nakhon Nayok drawings could not settle

G1. (ทุกแบบ, p15 / p42) รูปด้านเขียนแถบวงกบ 50 มม. แต่รูปตัดกล่องหน้า 44.5 มม. ในโปรแกรมให้วาดและคิดความกว้างวงกบเท่าไหร่? (50 / 44.5)
G2. (บานเลื่อน + ช่องแสงบน, p15 รูปตัด 28) ซีรีส์ทั่วไป ระหว่างช่องแสงกับบานเลื่อน ต้องมี กล่องเปิด + ฝาปิด 1 เส้น (คานกั้น) แล้วรางบนบานเลื่อนยึดใต้ แทนวิธี "ตบเรียบ + คิ้วเท" ที่ตั้งไว้ให้ W-01 ใช่ไหม? (ใช่ / ไม่ใช่)
G3. (บานกระทุ้ง, p16 รูปตัด 14) ระยะ 66 มม. แบ่งเป็น กรอบใน กี่ มม. และ กรอบนอก กี่ มม. และเว้นช่องรอบบานกี่ มม.?
G4. (ประตูสวิง, p33 รูปตัด 61-65) ใบประตูเว้นห่างจากวงกบ/ใบข้างกี่ มม. ต่อด้าน?
G5. (ประตูสวิง, p33 รูปตัด 62/63) ขวางบน 52 ขวางล่าง 80 ไม่เท่ากัน ใช้กับซีรีส์ทั่วไปทุกงานไหม? (ใช่ / เฉพาะงานนี้)
G6. (ช่องแสง) ระยะอมกระจก 6 มม. คือ บวกต่อขอบ (บานละ +12) หรือบวกรวมทั้งบาน (+6)?
G7. (ทุกแบบ, p15 A43) ตัวเลขขนาดช่องแสงที่ลูกค้าให้ (เช่น 1050) นับรวมแถบคานกั้นที่ใช้ร่วมด้วยใช่ไหม? (ใช่ เหมือนในแบบ / ไม่ใช่ นับเฉพาะช่อง)
G8. (บานเลื่อน, p15 รูปตัด 22) เฟรมข้าง 2 ราง ที่แปะทับ ยาวเท่าความสูงช่องบานเลื่อนเต็ม (เช่น 1400) หรือหักอะไรออก?
G9. (ประตูอัตโนมัติ / บานเลื่อนเปลือย / บานเกล็ด, p34, p40, p18) ต้องเพิ่มแบบเหล่านี้ในโปรแกรมไหม? (ใช่ / ยังไม่ต้อง)
G10. (A42 p14, IA21 p37) ตารางเขียน "บานกระทุ้ง" / "สวิงคู่" แต่รูปเป็นบานเลื่อน / สวิงเดี่ยว ยึดอย่างไหน? (รูป / ตาราง)

---

## 6. How the QA agent checks

Run code without writing files: `node --input-type=module -e "import { … } from '<abs path>/src/lib/….js' …"` from the worktree (ignore the MODULE_TYPELESS warning), or add a vitest case under `src/lib/` (`npx vitest run <file>`; the suite exists, see package.json). Never run SQL. Standard set-up: `m = startModel(kind, defaultParams(kind, typeParams))`, fill blank families (`m.lines[k][0].profile_family`), constant `buttOf = () => 40`, `widthOf = () => 60`, or a per-family map. Item params: `setParams(m, patch)` or `modelForItem(m, { layout_params })`.

| Rule | Mechanical check | Visual check |
|---|---|---|
| U1, U1a | `expandAddons({ addons:[topMerge], pieceRows, main:{widthMm:1800,heightMm:1200}, buttOf, layoutKind:'sliding_2' }).merge.overrides.frame_side.lengthMm === 1600`; `expandParts({ model, buttOf, widthOf, overrides, sideButt })` has `เฟรมข้าง` qty 2 at 1600 and no other structural vertical at 1200 or 400 (the 400 ones must be `เฟรมข้างช่องแสง (แปะทับ)`). Drawing: `rects(partSvgString({ model, widthMm:1800, heightMm:1200, view, addons:[topMerge] }))` (regex helper in `partPreviewSvg.test.js:18`) contains a narrow bar from above `overviewSpecs(...).box.frameY` down to `frameY + frameH` at each side, in both views. | Each side frame is one continuous bar through the add-on; the add-on has no separate side bar standing on the main side's top end. |
| U1b, A1 | Same with `ao({ len_mm:1200, offset_mm:300 })`: no rect crosses `frameY` (test in `partPreviewSvg.test.js`). Then compare with `expandAddons(...).merge.overrides.frame_side` — if `lengthMm` is still `th` while the drawing stops, report A1. | Short add-on: its sides stand on the main head. |
| U1c | For every pair of same-orientation rects in `partSvgString` output: report when they share x-range (vertical) and one's bottom equals the other's top within 0.05, unless one is a free line (`overviewSpecs` piece `role: 'extra'` / free position) or they belong to an attach unit vs the main frame (U1d). | Look at every T and L joint: a bar end must touch the side of a crossing bar. |
| U2, U3a-d | `validateCorners(model)` returns `[]` at defaults and after `setEndMode` flips; read `model.lines[k][0].ends` (`through` / `butt`, `to.key`). Expect for butt corners: `frame_top/bottom` ends `butt` -> `frame_side`, sides `through`; sliding rails `butt` -> stiles. | Corners: the through member's end is flush with the outer edge; the butting member stops at its side. |
| U3e | `folding_door`: `track_top` ends are `butt` AND `track_side` `deduction_auto` with `auto: 'track_top_bottom'` gives `length_deduction_mm` 80 at b 40 -> both shortened: report. | Corner gap / both bars short in the "ความยาวชิ้น" style labels. |
| U4, U4a | `fixed_grid` 1800 × 1200, b 45 w 60: mullion `length_deduction_mm` 90, length 1110 ×2; transom deduction 210, length 530 ×3 (`layouts.test.js`). Tee: transom ends `through`. | Mullions full height between head and sill; transoms between mullions. |
| U5a, U5b | Components of mitred parts have `cut_style: 'miter45'` and `end_deduction_mm: 0`; no other part has `miter45`. Cut-list / editor labels for these say outer length. | 45° lines at the four corners of awning/casement sashes only. |
| U6a, U6b | `endDeduction({ model, buttOf, widthOf, end })` = `buttOf(family of end.to)`; `buttOfFor(opts)` returns `butt_distance_mm`, else `jointDeductionMm` (depth for `primary_contact 'width'`). | "ที่มา" line (`explainPiece`) shows "− ปลายซ้าย ชน <member> <mm>". |
| U6c | `expandParts` with `buttOf: () => null` -> issues contain `no_butt_distance` for every butted position; `costOpening(...).unresolved` lists them (source `joint`); add-on rows at 0 with side butt > 0 -> `addon_deduction_zero`. | Cost summary shows the Thai warning; price status "ราคายังไม่ครบ". |
| U7, K1 | sliding_2 with the owner map `{FT 38.1, FB 35.8, FS 38.1, KS 25, HS 25}`: lengths 1723.8 / 1200 / 824.4 / 1126.1 via `computeComponentLength(c.length_rule_type, c.length_deduction_mm, 1.8, 1.2, c.length_factor, c.end_deduction_mm)`. `sashOverlap({ model, buttOf, widthOf })` = 25. | Editor table rows and "ที่มา" text `(กว้าง 1,800 − หักวงกบ 76.2 + ระยะซ้อน 25) × 0.5 − ปลายซ้าย 25 − ปลายขวา 25 = 824.4`. |
| U7b | Compare sash outer length with the frame inner opening (`zoomSpecs(...).opening`); equal = zero clearance (as built). | — |
| U8, U8a | `overviewSpecs({ model, widthMm, heightMm, view })`: sash pieces overlap by the hook width; for `view:'in'` x is mirrored and the other sash is drawn last. Read stile order from joints (`sash_top.v = ['hook_stile','key_stile']`, `sliding_n` left `['left_key_stile','left_hook_stile']`). | Do not flag overlap. Note which stiles meet in the middle; report only a mismatch with the owner's answer to Q7. |
| U9, U9a | Free positions: layout `corner: 'free'` or part `corner: 'free'`; their components have `end_deduction_mm` 0; ignore them in U1c / U2. | Strips drawn over other bars are expected. |
| U10a-c | `partSvgString({ view:'out' })` vs `'in'`: mirrored x, symbol dashed/solid swap; `symbolFor(model, partKey, i)` returns `v_hinge` + hinge side, `slide`, `fold`; `isFixedPiece` true pieces have the F mark. Saved preview = style `double`. | V apex at hinge, awning apex top, arrows toward fixed, F in glass corner. |
| U11 | `partSvgString({ addons })` text contains each add-on size, the main size and `รวม 1800 × 1600` for the top example; `partViewBox` grows by the add-on extents. Without add-ons the SVG is byte-identical (sha256 pin test). | Two dimension lines on the add-on axis, one on the other. |
| U12 | `layoutAddons({ widthMm, heightMm, addons }).rects` x/y: `align:'start'` flush with the stack start, `'end'` flush with the end; same-side add-ons stacked in list order. | Add-on edges flush with the chosen side. |
| C1 | `makeCatalogPricing(...).profileLine(...)`: `price_per_m = price_per_kg × linear_weight_kg_per_m`, `cost = length × qty × price_per_m`; check `price_as_of` picks the latest `effective_from` ≤ it. W-01 SAHARA: เฟรมบน 1.8 ม. = 366.75 (handover). | Cost lines per profile. |
| C2, C3 | Components carry `thickness_role`; `applyRoleThickness` sets `thickness_mm` to the sash thickness only when `allowsMixedThickness`. Check sill guard: `startModel('sliding_2',{one_fixed:1}).lines.sill_guard[0].thickness_role` — `'sash'` contradicts the owner (K1b): report. | — |
| C5, C6, H1, H2, K1c | `hardwareDefaults(kind, params)` gives the section 3 counts; `itemHardwareRows(rows, baseModel, itemModel)` adds only the delta (sliding_2 window template, item `door:true, one_fixed:1` -> ลูกล้อ 2, มือจับล็อค 1, กุญแจ 1). | Hardware lines in the item cost summary. |
| C7, C8, A4 | `computeBomForOpening` result: `infillArea_sqm` from template grid; `laborCost = W·H·rate` of the main item only; for an item with a merge add-on compare `bom.laborCost` with `rate × envelope area`. | — |
| C9, C10 | `openingExtras({ units, settings, ... })`: points per side `max(2, ceil(L/0.6)+1)`, sealant = Σ perimeters; units = merge envelope + each attach unit. `sealantTubes(m, 10)`. | — |
| C11 | `costOpening(ctx).addonBoms[i].bom`: own opening `w × h`, no hardware lines, `grid_*` null. `costBoms(r)` includes every attach BOM; `r.total` = main + attach + merge glass + extras. | One cost line per add-on, total = sum of lines. |
| K2-K13 | For each kind: section 3 set-up and numbers; piece counts with `pieceCount(model, key)`; tracks `trackOf`, order `sequenceOf`, fixed `isFixedPiece`; curtain-wall cells `cycleCellKind` / `countKinds`; frameless joints `jointCount`. Golden numbers in `src/lib/layouts/layouts.test.js` (b 45, w 60). | Compare with the mockup v5 drawing reference (docs/reference/type-previews-mockup.html). |
| K8a | swing_door 900 × 2100: `คิ้วประตู (นอน)` 820 > `ราวบนบาน` 740 -> report as Q9 pending. | Beads extend past the glass opening. |
| A0, A0a-d | `defaultAddonPieces({ mode, kind, position, layoutKind:'sliding_2', buttMm })` rows (ref, deduction, qty rule, note) match section 3.14; `expandAddons` gives `merge.notes` ตบเรียบ (รองคิ้วเท) / ตบร่อง, components with `fixed_length_mm`; `explainAddonPiece({ row, addon, main })` text; divider qty 0 on sliding top/bottom; `sideButt` set only when a divider qty > 0. Fake dividers: no component, only rects at half width. | Overlay sides drawn on the long side bar; bead on the main head; ซอยหลอก thin bars. |
| A2 | `expandAddons(...).glass[i].widthMm === (w − 2·b)/cols` (no mullion width): report. | Panes drawn narrower than priced. |
| A3 | Far frame / bead `deduction_mm` = 2·b(overlay family) after `fillDefaultDeductions`; compare with 2·b(ext family). | — |

---

## 7. Code vs owner answers — defects to fix (2026-10-16)

Severity: **High** = wrong money or wrong cut list on every affected item; **Medium** = wrong on some items or drawing-only but customer-visible; **Low** = cosmetic or edge case. Line numbers at HEAD `292a5a59`. Fixed 2026-10-16 on `feat/alu-cost-catalog` (code only, test-first, one commit each): D1, D3, D4, D6, D7, D12, marked **FIXED <sha>** below. D2, D5, D8, D9, D10, D11 wait for owner answers. No database row was changed: templates and add-on piece sets already saved on CHANG keep their stored ends / ref_input / deductions / thickness_role (the live บานเฟี้ยม template, W-01's merge piece set) until they are re-saved or regenerated.

| ID | Where (file:line) | Current behaviour | Required behaviour | Owner answer / source | Severity |
|---|---|---|---|---|---|
| D1 **FIXED 750953dc** | `src/lib/layouts/folding_door.js:31-32` (joints `through: 'v'`) with `:23` (side `height_minus` `track_top_bottom`) | Top/bottom tracks butt into the sides (`W − 2·b`) AND the sides are `H − b(top) − b(bottom)`: both members short at all 4 corners | Top/bottom tracks run through (`W`, ends `through`); sides butt (`H − b(top) − b(bottom)`). Joints `through: 'h'` | Q1 (ก) | High. Fix: folding_door joints `through: 'h'`, side track rule plain `height` (butt ends deduct b(top) + b(bottom) once). Drawing follows the same end modes. |
| D2 | `src/lib/addonModel.js:123-130` (sliding_2 top/bottom set) | `divider` qty 0; no adapter piece in `PIECE_KEYS` (`:28-31`); no series in `setKey` (`:104`) or `defaultAddonPieces` (`:113`) | Serie general: divider qty 1 (top: กล่องเปิด, bottom: กล่องเรียบ, `len − 2·b(ext)`) + an adapter piece (top ฝาปิด, bottom ฝาตบร่อง, same length). Defaults must depend on the template's series | Q3 + drawings p15 (28) (30) | High (ask G2 first) |
| D3 **FIXED 96e0ed47** | `src/lib/addonModel.js:147` (`SIDE_KEYS.merge = ['ao_frame_side','ext']`) used by `fillDefaultDeductions` `:163-167`; `src/lib/addonExpand.js:146-149` (glass butt) | `ao_bead`, `ao_frame_far` (and divider, glass) deduct 2·b of the overlay side | Deduct 2·b of the extended กล่องร่อง (`ext`) first; overlay only as a fallback | Q4 (ก) | Medium. Fix: `BUTT_SOURCE_KEYS` / `buttFamilyOf` / `fillDeductionsBy`: ao_frame_far and ao_bead default to 2·b(ext), overlay only as fallback; a fallback value moves to 2·b(ext) when ext gets a family. Ruling: divider, mullion, rail and the add-on glass keep the side family (divider = D2, glass = D5). |
| D4 **FIXED 5e6296ed** | `src/lib/addonModel.js:128` (`['ao_frame_side','h',0,'fixed',2]`) | Overlay side = add-on height `h` (400) | Overlay side = main unit (sash) height (`mh`), placed over the main unit, not the add-on (series file J4) | Q5 + p15 A43 | High. Fix: default `ao_frame_side` ref `mh` (main unit height) in the sliding_2 top/bottom merge set. Ruling: "sash height" read as the sliding cell = main unit height (series file J4); deduction from mh still open (G8). The add-on zoom still draws the overlay strip inside the add-on rectangle. |
| D5 | `src/lib/addonExpand.js:82-90` (`pushGlass`) | Pane = `(w − 2·b)/cols × (h − 2·b)/rows`; no mullion/rail width, no bite | Pane = `(w − 2·b − (cols−1)·w(mullion))/cols + bite` × `(h − 2·b − (rows−1)·w(rail))/rows + bite`, bite ≈ 6 mm (per edge or per pane: G6) | Q6 | Medium |
| D6 **FIXED eeeed54c** | `src/lib/bomEngine.js:120-123` fed by `src/lib/openingCost.js:238` (`main.opening`) | Labour `W × H × rate`, silicone/felt `2(W + H) × rate` on the main unit only; merge add-ons add nothing | Merge items: labour on the envelope area (main + merge add-ons), silicone/felt on the envelope perimeter | Q11 | Medium. Fix: costOpening passes `labour_area_sqm` (main + each merge add-on area) and `seal_perimeter_m` (merge envelope perimeter) to the engine. Ruling: felt follows silicone (same 2(W + H) rule); area is the sum of rectangles, perimeter the envelope (same unit openingExtras seals). |
| D7 **FIXED 3e1c101e** | `src/lib/partGeometry.js:88-96` (`geomSash`: hook left, key right for every sash); `src/lib/layouts/sliding_2.js:34-35` (joints `['hook_stile','key_stile']` for both pieces) | Left sash has its hook at the left jamb; middle = key + hook | Lock stiles at both jambs, hook-on-hook in the middle (sash 0: key left, hook right; sash 1: hook left, key right) | Q7 + p15 (26) | Medium (drawing only; costing equal). Fix: geomSash mirrors the left sash of a 2-sash drawing (key left, hook right, rails flipped); hooks still overlap. Pins re-taken: 4 sliding_2 sha256 pins in `partPreviewSvg.test.js`, golden `partEditor-sliding2.html` and `partEditor-sliding2-owner.html`. |
| D8 | `src/lib/partPreviewSvg.js:288` (`has = s => r.a.mode === 'attach' \|\| s !== facing`); `src/lib/addonModel.js:118-121` (attach pieces) | An แยกวงกบ add-on gets 4 bars, so the joint shows the main bar and the add-on bar back to back, and costs its own head/sill there | Serie general: no attach mode (UI should offer only ร่วมวงกบ, or convert attach to a shared box + adapter). Other series: unchanged until the owner rules | Q3 + drawings E2/J3 | Medium |
| D9 | `src/lib/layouts/awning_grid.js` (no inner-frame position) and `scripts/gen-templates-all-types.mjs:41` | General-series awning = grid + mitred sash only | Serie general adds a กรอบในบานกระทุ้ง (4 pieces per awning cell) + คิ้วบานกระทุ้ง, screwed into the grid box | drawings p16 (3) (4) (14) (15) | Medium |
| D10 | `scripts/gen-templates-all-types.mjs:27` and `:41` (`transom: 'กล่องร่อง'`) | General-series transom family is กล่องร่อง, with no cap or cover lines | Transom = กล่องเปิด + ฝาปิด + ฝาตบร่อง (p42 (9)); sill = กล่องเปิด + ฝาปิด (p42 (11)); mullion = กล่องร่อง + ฝาตบร่อง (p42 (17)); awning-row bottom/mullion = กล่องเรียบ + ฝาตบร่อง / ฝาตบเรียบ (p16 (15) (16)) | drawings | Medium (template data) |
| D11 | `src/lib/partPreviewSvg.js:229-231` (`addonGeometry` axes) / `:241` (`addonDims`) | The chain splits at the main frame's outer edge, so the shared bar is counted in the main unit | Serie general: the shared bar is counted in the top/left unit's segment (p15 A43: 1050 / 1450 / 600) | drawings E4/J6; G7 | Low-Medium (labels; matters if users type drawing sizes) |
| D12 **FIXED 588a6ff8** | `src/lib/layouts/sliding_2.js:28-29` (`sill_guard` rule `role: 'sash'`) | Sill guard priced at sash thickness | Frame thickness (already K1b) | owner sheet thread | Medium (pre-existing). Fix: sill_guard rule has no role, so `thickness_role` null = frame thickness. |

Agreeing with the answers, no defect: Q2 (`fixed_grid.js:21-22` and reuses, sides through), Q9 (`swing_door.js:29-30` beads), Q10 (`hanging_door` track 2·W), Q12 (`hardwareDefaults`).

