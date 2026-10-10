# BOM Template Part Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the owner define a sliding-window (2 sashes, no transom) BOM template by clicking drawn pieces: parts, several profiles per position, per-piece per-end through/butt, automatic frame deductions, with an expander that feeds the unchanged cost engine.

**Architecture:** New additive tables hold the part model; a pure `partModel` (editor state + corner rule) and `partExpand` (model → the engine's flat component rows) sit in `src/lib`; `bomEngine` gains two defaulted inputs (length factor, end deduction); `openingCost.prepareComponents` branches on `template.layout_kind`; the editor UI is a new tab body in `BomTemplates.jsx` built from small components and a pure geometry lib. Old templates take the old path untouched.

**Tech Stack:** React (Vite), Supabase/Postgres RLS, vitest, plain SVG.

**Spec:** `docs/superpowers/specs/2026-10-10-bom-template-part-editor-design.md` (fa4417de). **Behaviour reference (approved mockup, v24):** `docs/superpowers/mockups/2026-10-10-bom-part-editor-mockup.html` — its `<script>` is the working logic for corner coupling, geometry (flush joints, occlusion, zoom), grouping and the "ที่มา" line; port it into the pure libs below, do not copy its DOM code.

## Global Constraints

- Worktree `/Users/plfx/code/FacadeXPM/facadex-app/.claude/worktrees/alu-cost-catalog`, branch `feat/alu-cost-catalog`. Do not push. Do not merge. Main folder code untouched.
- Agents never run SQL against Supabase; migrations and SQL tests are files, the owner runs them (`!`), scripts go in `.superpowers/sdd/2026-10-10-bom-template-part-editor/` (git-ignored).
- New tables: `tenant_id UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id)`, tenant index, RLS `is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation')` (copy the loop in `supabase/migrations/2026-10-12-03-estimation-hardware-packages.sql`). New columns on existing tables are nullable or defaulted.
- Templates without `layout_kind` and rows without the new columns must cost **exactly** as before: the whole existing suite stays green untouched (1657 tests at HEAD `91150aa5`).
- No `upsert` (house rule). UI text Thai, code/comments English; match surrounding style.
- UI follows the approved mockup (content, labels, behaviour); styling uses the app's own classes. Where this plan and the mockup disagree, the mockup wins for UI behaviour and the spec for data.
- Final message of the arc lists every `Ruling:` line from this ledger and the Phase 2b/3 ledgers.

## Rulings made while writing this plan (record in the ledger as `Ruling:`)

- Ruling PE-1: the engine adds `length_factor` and `end_deduction_mm` to `bom_template_components`; length = `rule(width|height|…, length_deduction_mm) × length_factor − end_deduction_mm/1000`. Defaults 1 and 0 keep every old result. Cost if wrong: one more migration.
- Ruling PE-2: expansion happens at costing time inside `openingCost.prepareComponents` (it needs the item's series and thickness to look up butt distances); nothing is written to `bom_template_components` for a `layout_kind` template.
- Ruling PE-3: **profile numbers are edited in the catalogue, not in the template editor.** The editor shows (read-only) the full width and butt distance of the profile resolved at a "ซีรีส์/ความหนาที่ใช้ทดสอบ" pair of selects, with a link to the catalogue; the catalogue's profile screen gets the new `butt_distance_mm` field. (Deviates from spec §6's last paragraph to avoid ambiguity when a family has many profiles; cost if wrong: add inline edit later.)
- Ruling PE-4: butt distance lookup order = `alu_profiles.butt_distance_mm` → legacy `assembly.jointDeductionMm` automatic rule (width/depth + primary contact) → issue `no_butt_distance` (shown as unresolved, deduction 0), never a silent 0.
- Ruling PE-5: the hook-stile overlap defaults (`overlap_mode = 'auto_hook'`) to the hook stile profile's butt distance (falls back to `width_mm`).
- Ruling PE-6: for a `layout_kind` template **without an add-on** the item-form live preview and the saved snapshots (so the quotation attachment pages) use the new geometry via a pure SVG-string renderer (owner request 2026-10-10: "live preview … ใช้แนบใบเสนอราคาได้เลย"); items with an add-on, legacy templates and the "parts"/CAD styles keep the legacy renderer; a `layout_kind` template has no flat components, so the legacy `frameFamily` returns null (must not crash).

## Review Focus

- A `layout_kind` template with no parts / no lines / lines without a profile family: expansion returns no components plus an issue, the item shows "ราคาไม่ครบ", nothing throws.
- A corner violation loaded from the database (both pieces through, or both butt): reported as an issue on load, the editor highlights it, saving is blocked until fixed; the expander never silently fixes it.
- A butt end whose target line was deleted (`butt_to_profile_id` NULL): expansion falls back to the end's own deduction if set, otherwise issue `no_butt_target`.
- Changing a part's count (sashes 2 → 3) resizes the per-piece end arrays (new pieces get defaults, existing keep theirs) and the cost multiplies correctly.
- Cost parity: a new-style template that is all "through", factor 1, no deductions equals the equivalent flat template to the cent; every old engine test unchanged.

## File structure

Create:
- `supabase/migrations/2026-10-15-01-bom-part-editor.sql`; `supabase/tests/bom_part_editor_test.sql`
- `src/lib/partModel.js` (+test) — vocabulary, defaults, corner coupling, validation, grouping helpers
- `src/lib/partExpand.js` (+test) — model → engine components
- `src/lib/partSave.js` (+test) — model ↔ database rows
- `src/lib/partGeometry.js` (+test) — overview/zoom geometry (flush joints, occlusion, markers)
- `src/lib/partPreviewSvg.js` (+test) — pure SVG string for the item preview and the saved snapshots
- `src/hooks/useBomPartModel.js`
- `src/pages/bomTemplates/PartEditor.jsx`, `PartPreview.jsx`, `PartSidePanel.jsx`, `PartTable.jsx` (+ `PartEditor.smoke.test.jsx`)

Modify:
- `src/lib/bomEngine.js` (+test) — factor and end deduction
- `src/lib/itemPreviewSignature.js` (+test), `src/pages/estimation/PreviewPanel.jsx`, `useItemModel.js` — new renderer for `layout_kind` templates
- `src/lib/openingCost.js` (+test) — branch to `expandParts`; `src/pages/Estimation.jsx` and `src/pages/estimation/ProviderCompare.jsx` — pass `partModelByTemplate`
- `src/lib/reasonText.js` — new reason texts
- `src/pages/BomTemplates.jsx` — `layout_kind` in form/payload, new tab body, save/load
- `src/pages/aluCatalog/ProfilesTab.jsx`, `src/lib/catalogForm.js` — `butt_distance_mm` field
- `docs/handover-aluminium-cost-catalog.md` — part editor section (incl. that previews/attachments for these templates use the new drawing)

---

### Task 1: Migration and SQL test (owner applies)

**Files:**
- Create: `supabase/migrations/2026-10-15-01-bom-part-editor.sql`, `supabase/tests/bom_part_editor_test.sql`, owner script `.superpowers/sdd/2026-10-10-bom-template-part-editor/run-part-editor-tests.sh` (model on the existing `run-*-tests.sh` in the Phase 3 ledger dir).

- [ ] **Step 1: Write the migration** exactly per spec §4: `bom_templates.layout_kind`; tables `bom_template_parts`, `bom_template_positions`, `bom_template_position_profiles`, `bom_template_piece_ends` (all with `template_id`/FK chain `ON DELETE CASCADE`, `UNIQUE (part_id, position_key)`, `UNIQUE (position_profile_id, piece_index, end_index)`, `butt_to_profile_id ... ON DELETE SET NULL`, the CHECKs listed in the spec); `alu_profiles.butt_distance_mm`; `bom_template_components.length_factor NUMERIC NOT NULL DEFAULT 1 CHECK (length_factor > 0)` and `end_deduction_mm NUMERIC NOT NULL DEFAULT 0 CHECK (end_deduction_mm >= 0)`. RLS loop for the four new tables. Check first (grep `supabase/migrations`) that no VIEW selects `bom_templates.*`, `bom_template_components.*` or `alu_profiles.*` (house rule: a view's `x.*` list freezes); recreate any that does and report the result.
- [ ] **Step 2: SQL test** in the style of `supabase/tests/estimation_hardware_packages_test.sql` (three fixture tenants A/B with `estimation`, C without; one rolled-back transaction): as tenant A insert a template with `layout_kind='sliding_2'`, 2 parts, 7 positions, a profile line with two ends; assert CHECK violations (`count = 0`, `length_factor = 0`, `end_index = 2`, `mode = 'x'`, negative `end_deduction_mm`, `layout_kind = 'x'`) raise 23514, duplicate position key and duplicate end raise 23505, deleting the target profile line sets `butt_to_profile_id` NULL and keeps the end, deleting the template cascades every child; tenant B sees 0 rows of A's data; tenant C cannot read or insert (42501). Existing components rows still default to factor 1 / end deduction 0.
- [ ] **Step 3: Owner script** (written, **not run**).
- [ ] **Step 4: Full suite** `npx vitest run` (no JS changed) then commit `feat: part editor migration and SQL test (not applied)`.

---

### Task 2: Engine — length factor and end deduction

**Files:** Modify `src/lib/bomEngine.js`; Test: `src/lib/bomEngine.test.js` (+ `bomEngineAssembly.test.js` untouched).

**Interfaces:** Produces `computeComponentLength(rule, deductionMm, widthM, heightM, factor = 1, endDeductionMm = 0)`; `computeBomForOpening` reads `c.length_factor` and `c.end_deduction_mm` from each component (missing/null/invalid → 1 and 0).

- [ ] **Step 1: Failing tests** appended to `bomEngine.test.js` (use the file's existing fixtures for `template`, `pricing`; add a tiny component helper): (a) a component with `length_rule_type: 'width_minus', length_deduction_mm: 51.2, length_factor: 0.5, end_deduction_mm: 50` on a 1.8 m opening gives length `(1.8 − 0.0512) × 0.5 − 0.05 = 0.8244` m; (b) a component with neither field gives exactly the old length (run an existing case and compare); (c) `length_factor: '0.5'` and `end_deduction_mm: '25'` (DB numerics arrive as strings) behave as numbers; (d) null / `''` / `NaN` / factor `0` / negative end deduction fall back to 1 / 0.
- [ ] **Step 2: Run** `npx vitest run src/lib/bomEngine.test.js` — FAIL.
- [ ] **Step 3: Implement.** In `computeComponentLength` compute `base` exactly as today, then `return base * factor - endDeductionMm / 1000`; add a helper `const factorOf = v => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 1)` and `const endOf = v => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0)` (guard `''`/null: `Number('') === 0` → factor falls to 1, end to 0). Call sites: line 69 passes `factorOf(c.length_factor), endOf(c.end_deduction_mm)`. Nothing else changes.
- [ ] **Step 4: Run** the engine tests and then the full suite (all 1657 + new) — PASS. Commit `feat: engine length factor and end deduction (defaults keep old results)`.

---

### Task 3: `partModel` — editor state, defaults, corner rule

**Files:** Create `src/lib/partModel.js`; Test `src/lib/partModel.test.js`.

**Interfaces (all pure; port the logic of the mockup's `PARTS/INST/ORIENT/partner/setEnd/defPair/ensure` and the corner defaults):**
- `LAYOUTS.sliding_2 = { parts: [{ key:'frame', name:'วงกบ', count:1, positions:[…] }, { key:'sash', name:'บานเลื่อน', count:2, overlap_mode:'auto_hook', positions:[…] }], positions: { frame_top:{part:'frame',orient:'h',per:1,name:'เฟรมบน'}, frame_bottom:{…'เฟรมล่าง'}, frame_side:{orient:'v',per:2,labels:['ซ้าย','ขวา']}, sash_top:{part:'sash',orient:'h',per:1}, sash_bottom, key_stile:{orient:'v'}, hook_stile:{orient:'v'} } }`
- `startModel('sliding_2') → model` with the defaults of spec decision 6: each position has one empty line `{ profile_family:'', length_rule_type, length_deduction_mm:0, deduction_auto:true|false, length_factor, quantity_value:1, thickness_role, ends:[…] }` — frame_top/bottom `width`, frame_side `height`, sash_top/bottom `width_minus` (factor 0.5, `deduction_auto:true`, thickness_role 'sash'), key/hook stile `height_minus` (`deduction_auto:true`, thickness_role 'sash'); ends: frame_top/bottom butt→frame_side, frame_side through, sash rails butt (end 0 → hook_stile, end 1 → key_stile), stiles through.
- `pieceCount(model, key)` = `per × part.count`; `ensureEnds(model)` resizes every line's `ends` to `[ [end0,end1] × pieceCount ]` (new piece copies line 0's pair for lines > 0 else the default pair; existing kept).
- `partnerEnd(key, piece, end) → { key, piece, end } | null` (frame_top end e ↔ frame_side piece e end 0; frame_bottom end e ↔ frame_side piece e end 1; frame_side piece k end e ↔ (e===0 ? frame_top : frame_bottom) end k; sash_top/bottom end 0 ↔ hook_stile / end 1 ↔ key_stile (same piece) end 0 / end 1 respectively; stiles reverse).
- `setEndMode(model, key, lineIdx, piece, end, mode) → model` (immutable): sets the end; at the partner, sets the opposite mode, and when the partner becomes `butt` sets its `to` to `{ key, line: min(lineIdx, lines−1) }` of the piece that now runs through and its `deduction_mm` to `null`. Partner lines clamp to existing lines.
- `validateCorners(model) → issues[]` (`{ key, piece, end, reason:'both_through'|'both_butt' }`), `defaultTarget(key,end)`.
- `groupsOf(lengthsMm, perPiece) → [{ len, n }]` (round to 0.1 mm, sorted descending) used by table and tests.

- [ ] **Step 1: Failing tests** (`partModel.test.js`): `startModel('sliding_2')` has 7 positions, 4 frame pieces (1+1+2), sash positions with 2 pieces each, and `validateCorners` of the defaults is empty; toggling frame_bottom piece 0 end 0 to `through` makes frame_side piece 0 end 1 `butt` with `to = { key:'frame_bottom', line:0 }` and `deduction_mm: null`, and the corner stays valid; toggling a sash stile end to `butt` flips the matching rail end to `through`; `ensureEnds` after `count 2 → 3` on the sash part adds a third pair per sash line without touching pieces 0–1; a hand-made model with both ends through at a corner yields `both_through`; `groupsOf([1200,1200,1161.9],1)` → `[{len:1200,n:2},{len:1161.9,n:1}]`.
- [ ] **Step 2–4:** run (FAIL) → implement (port from the mockup) → run (PASS) → full suite. Commit `feat: partModel (defaults, corner coupling, validation)`.

---

### Task 4: `partExpand` — model → engine components

**Files:** Create `src/lib/partExpand.js`; Test `src/lib/partExpand.test.js`.

**Interfaces:**
- Consumes: `model` (Task 3 shape, `layout_kind`, `parts`, `lines`), `buttOf(family) → number | null` (mm; Task 5 supplies it), `widthOf(family) → number | null`.
- Produces: `expandParts({ model, buttOf, widthOf }) → { components, issues }`. Each component: `{ role_name, profile_family, length_rule_type, length_deduction_mm, length_factor, end_deduction_mm, quantity_basis:'fixed', quantity_value, thickness_role, sort_order, cut_style:'square' }` (no ids). `issues[]`: `{ role_name, reason }` with reasons `no_profile_family`, `no_butt_distance`, `no_butt_target`, `corner_violation`, `no_model`.

Rules (port the mockup's `baseOf/dedNow/autoDed/ovl/pieceLens/groupsOf/explain`): automatic pre-factor deduction `autoDed`: `sash_top`/`sash_bottom` = `2 × buttOf(frame_side line 0)`, `key_stile`/`hook_stile` = `buttOf(frame_top line 0) + buttOf(frame_bottom line 0)`; overlap for sash rails (rule `width_minus`) = `part.overlap_mode === 'auto_hook' ? buttOf(hook_stile line 0) ?? widthOf(...) : part.overlap_mm`; effective pre-factor deduction = (`deduction_auto` ? autoDed : `length_deduction_mm`) − overlap (only rails). End deduction of an end: `through` → 0; `butt` → `deduction_mm` if not null else `buttOf(family of the target line)`; an unresolved lookup adds an issue and counts 0. Per line: pieces are grouped by (end0 + end1) deduction sum; every group becomes one component with `quantity_value = line.quantity_value × pieces in group`, `end_deduction_mm` = the group's sum, role name = position name (+ " ซ้าย/ขวา" or " บานที่ n" when the line has more than one group). A model with no lines or an empty `profile_family` yields no component for that line plus `no_profile_family`.

- [ ] **Step 1: Failing tests (owner's worked example, 1,800 × 1,200 mm)** with `buttOf` returning `{ side:38.1, top:38.1, bottom:35.8, key:25, hook:25 }` by family name: frame top → one component `width`, `end_deduction_mm: 76.2`, quantity 1 (length 1.7238 m through the engine); frame bottom likewise 76.2 (its own end ends butt the side frame); frame side → `height`, end deduction 0, quantity 2; sash rails → `width_minus`, `length_deduction_mm = 76.2 − 25 = 51.2`, `length_factor 0.5`, `end_deduction_mm 50`, quantity 2 (= 1 × part count 2); key and hook stiles → `height_minus`, `length_deduction_mm 73.9`, end deduction 0, quantity 2 each. Feed each component to `computeComponentLength` (from `bomEngine.js`) and assert 1.7238 / 1.2 / 0.8244 / 1.1261 m. Plus: toggling one frame_side end to `butt` splits that line into two groups (quantities 1 + 1, lengths 1.2 and 1.1619); a second profile (cover) with its own `deduction_mm: 20` at one end gets its own end deduction; manual `deduction_auto:false, length_deduction_mm: 80` overrides the automatic value; `overlap_mode:'manual', overlap_mm: 10`; sash count 3 triples quantities; missing butt distance → `no_butt_distance` and deduction 0; deleted target (`to: null`) with no override → `no_butt_target`; corner violation reported; empty model → `no_model`; all-through, factor 1, no deductions model equals plain `width`/`height` components.
- [ ] **Step 2–4:** run (FAIL) → implement → run (PASS) → full suite. Commit `feat: partExpand (model to engine components)`.

---

### Task 5: Costing integration and data loading

**Files:** Modify `src/lib/openingCost.js`, `src/pages/Estimation.jsx`, `src/pages/estimation/ProviderCompare.jsx`, `src/lib/reasonText.js`; Create `src/hooks/useBomPartModel.js`, `src/lib/partSave.js` (load half: `modelFromRows`); Tests: `src/lib/openingCost.test.js` (extend), `src/lib/partSave.test.js`.

**Interfaces:** `modelFromRows({ template, parts, positions, lines, ends }) → model | null`; hook `useBomPartModel() → { partModelByTemplate, loading, error }` (loads the four tables with `useCatalogTable` as the sibling hooks do, groups by template); `costOpening` ctx gains optional `partModelByTemplate`; `buttOfFor({ index, seriesId, thicknessMmByFamily })` helper inside `partExpand.js` or `openingCost.js` implementing Ruling PE-4 using `resolveCatalogProfile` + `profile.butt_distance_mm` → `assembly.jointDeductionMm`'s width/depth rule.

- [ ] **Step 1: Failing tests:** (a) `costOpening` for a template whose `layout_kind` is `'sliding_2'` and a model like Task 4's builds components via `expandParts` and prices them (use the catalogue fixtures of `openingCost.test.js`; assert the BOM lines carry the lengths above and `unresolved` lists `no_butt_distance` when a profile has no distance); (b) the **parity** test: a template without `layout_kind` costs exactly as in the existing tests (reuse one existing case); (c) a `layout_kind` template with no model in ctx → no throw, `unresolved` has `no_model`; (d) `modelFromRows` round-trips the Task 3 default model (rows built by hand) and returns `null` for a template without `layout_kind`; (e) `reasonText('no_butt_distance')`, `'no_butt_target'`, `'no_profile_family'`, `'corner_violation'`, `'no_model'` give Thai text (add to `REASON_TEXT`).
- [ ] **Step 2–4:** run (FAIL) → implement: in `openingCost.prepareComponents`, `if (template.layout_kind && partModelByTemplate)`: components = `expandParts(...).components` run through the existing `applyRoleThickness` (thickness roles) and **skip** `applyJoints` (expanded rows carry no `joint_id`); issues from the expander are appended to `issues` like joint issues; otherwise the old line runs unchanged. In `Estimation.jsx` build `partModelByTemplate` with the hook and add it to `base`/`costCtx`; in `ProviderCompare.jsx` pass it in the explicit ctx object. Verify with grep that every `costOpening(`/`costItems(` caller receives it (`QuickQuote`, `ItemModal` use `ctx` from Estimation). The legacy preview helpers (`frameFamily`, `partLabels`) receive empty component lists for these templates and must not throw (add a test in `itemPreviewSignature.test.js`: `frameFamily([], [])` is null already; assert `itemPreviewInputs` for a `layout_kind` template with no components still returns inputs). → run → full suite. Commit `feat: cost integration for part-model templates`.

---

### Task 6: Profile butt distance in the catalogue

**Files:** Modify `src/pages/aluCatalog/ProfilesTab.jsx`, `src/lib/catalogForm.js` (+ tests `catalogForm.test.js`); the hook that loads profiles already selects `*` (verify and say so).

- [ ] **Step 1: Failing tests:** the profile form model carries `butt_distance_mm` (string in the form, blank → NULL in the payload, negative or non-numeric → validation error with the same Thai style as `width_mm`); loading an old profile row without the key reads as blank.
- [ ] **Step 2–4:** implement: one number input "ระยะชน เมื่อถูกชน หลัง notch (มม.)" next to width/depth with help text "ความกว้างที่เหลือหลังตัด notch ใช้เป็นค่าหักเริ่มต้นของชิ้นที่วิ่งมาชนเส้นนี้" ; run tests, full suite, build. Commit `feat: butt distance field on profiles`.

---

### Task 7: Persistence — save and load the part model

**Files:** Extend `src/lib/partSave.js` (+ `partSave.test.js`); Modify `src/pages/BomTemplates.jsx` (save/load only; no new UI yet).

**Interfaces:** `modelToRows(model, templateId, newId = crypto.randomUUID) → { parts, positions, lines, ends }` (client-generated UUIDs so one insert per table wires the FKs; `butt_to_profile_id` resolved from `{key,line}` refs; whitelisted columns only); `validateModel(model) → string | null` (first Thai problem: missing profile family, corner violation, factor ≤ 0, negative numbers); `saveModel({ supabase, templateId, model })`: delete the template's parts (cascade removes the rest), then insert parts → positions → lines → ends, throwing on the first error (document the non-atomic window as the existing template save does).

- [ ] **Step 1: Failing tests:** round trip `modelFromRows(modelToRows(model))` equals the model for the default and for a model with a second profile, a manual override and a flipped corner; a `butt` end whose target line was removed is written with `butt_to_profile_id: null`; the row objects contain no unknown keys; `validateModel` rejects both-through corners and an empty family; `saveModel` with a fake client records the order delete → parts → positions → lines → ends and stops at the first injected error (no later insert).
- [ ] **Step 2–4:** run (FAIL) → implement → run. In `BomTemplates.jsx`: add `layout_kind` to `EMPTY_TEMPLATE_FORM`/load/payload, load `partModelByTemplate` for the opened template into state `model`, and in `handleSave` call `validateModel` then `saveModel` after the template row is written when `form.layout_kind` is set (and write no flat components for that template). Commit `feat: save and load the part model`.

---

### Task 8: Geometry library (overview, zoom, markers)

**Files:** Create `src/lib/partGeometry.js` (+ `partGeometry.test.js`).

**Interfaces:** `overviewSpecs({ model, widthMm, heightMm, view, buttOf }) → { box, pieces:[{ key, piece, orient, x, y, w, h, role:'main'|'extra', line }], dims }` and `zoomSpecs({ model, partKey, selected, view, widthMm, heightMm, buttOf }) → { box, pieces, markers:[{ key, piece, end, x, y, mode }], title, opening }`; pure numbers, no markup. Port the mockup's `geomFrame/geomSash/renderPieces/drawOverview/drawZoom` logic: a butt end is shortened by the drawn thickness of the piece it butts so joints touch exactly (overview and zoom); the sash drawn last is the visible one (outside view: left sash on top; inside view mirrors x and puts the right sash on top); sashes overlap by exactly one stile width; extra profiles are thin bars with their own run; zoom of the frame part draws the frame only, zoom of the sash part draws the two sashes side by side with the opening text `ช่องเปิดวงกบ {W−2×side} × {H−top−bottom} มม.`.

- [ ] **Step 1: Failing tests:** default model, 1,800 × 1,200, outside view: the frame_top rect starts exactly at the right edge of the left frame_side rect and ends at the left edge of the right one; a sash rail starts at the right edge of the hook stile; the two sashes' meeting stiles have the same x; inside view mirrors x; toggling a frame_bottom end to `through` makes that rect span the corner and the side rect stop at its top edge (no overlap at the corner); zoom of `frame` has 2 markers on the selected top frame and 4 on the selected side frame; zoom of `sash` has 4 markers for a stile (2 sashes × 2 ends); drawing order puts the visible sash last in both views.
- [ ] **Step 2–4:** run (FAIL) → implement → run → full suite. Commit `feat: part editor geometry (flush joints, occlusion, markers)`.

---

### Task 9: Editor UI

**Files:** Create `src/pages/bomTemplates/PartEditor.jsx`, `PartPreview.jsx`, `PartSidePanel.jsx`, `PartTable.jsx`, `PartEditor.smoke.test.jsx`; Modify `src/pages/BomTemplates.jsx` (tab 0 body + "create from layout" button).

**Behaviour: follow the approved mockup exactly (read it before building).** Props `{ model, onChange, index, canEdit, testSeriesId, testThicknessMm, onTestChange }`. Components: test inputs (กว้าง/สูง มม., outside/inside toggle, test series + thickness selects per Ruling PE-3), overview SVG (click selects a position), zoom SVG with clickable markers (`setEndMode`), side panel (part name/count, sash overlap auto/manual with ↺, position name, one fieldset per profile: family select from `catalogFamilies(index)`, read-only profile info (full width, butt distance) with a "แก้ที่แคตตาล็อก" note, length rule, deduction with auto/manual badge + ↺, length factor "สัดส่วนของความยาวที่ใช้", pieces "จำนวนท่อนต่อ 1 ชิ้นในภาพ", thickness role, per-piece per-end controls with target select and deduction input defaulting from the butted profile, the step-by-step "ที่มา" line, result `length × quantity`), "+ เพิ่มโปรไฟล์ในตำแหน่งนี้" (copies line 0), components table grouped by part with part totals and "↳ ความยาวไม่เท่ากัน" lines, corner-violation banner. All numbers come from `expandParts` + the engine (`computeComponentLength`), not re-implemented in the UI. In `BomTemplates.jsx`: when `form.layout_kind` is set tab 0 shows `PartEditor` instead of the flat component table (hardware, constraints, joints tabs unchanged); a button "สร้างจากแบบบานเลื่อน 2 บาน (ไม่มีช่องแสง)" on a new/legacy-empty template sets `layout_kind='sliding_2'` and `startModel`. Legacy templates (no `layout_kind`) are unchanged.

- [ ] **Step 1: Smoke tests** (`renderToString`, `vi.mock('../../lib/supabase.js', …)` like `ItemModal.smoke.test.jsx`): the editor renders the default model with a fake catalogue without `NaN`/`undefined`; the table header is "ความยาวต่อชิ้น × ปริมาณ (มม.)"; part rows "Part: วงกบ × 1" and "Part: บานเลื่อน × 2"; the "ที่มา" text for the rail example reads `(กว้าง 1,800.0 − หักวงกบ/ระยะหัก 76.2 + ระยะซ้อนบาน 25.0) × 0.5 − ปลายซ้าย ชน เสาเกี่ยว 25.0 − ปลายขวา ชน เสากุญแจ 25.0 = 824.4 มม.` with catalogue fixtures giving those widths; a corner violation shows the banner; a legacy template (no `layout_kind`) still renders the old table; a template with no profile families shows the unresolved text instead of numbers.
- [ ] **Step 2: Pure state tests** for any reducer/helper the components use (selection, add/remove profile, part count change calling `ensureEnds`) — put them in `partModel.test.js`.
- [ ] **Step 3–4:** implement, run focused tests, full suite, `npm run build`.
- [ ] **Step 5: Controller check:** compare each screen with the mockup (screenshots into the scratchpad); discrepancies become fix rounds.
- [ ] **Step 6: Commit** `feat: BOM template part editor UI`.

---

### Task 10: Item preview and quotation attachment drawings

**Files:** Create `src/lib/partPreviewSvg.js`, `src/lib/partPreviewSvg.test.js`; Modify `src/lib/itemPreviewSignature.js` (+ `itemPreviewSignature.test.js`), `src/pages/estimation/PreviewPanel.jsx`, `src/pages/estimation/useItemModel.js`, `src/pages/estimation/itemForm.js` (only where it builds the snapshot), `src/pages/estimation/projectDefaults.js` (`currentPreviewSigs`).

**Interfaces:** `partSvgString({ model, widthMm, heightMm, view, buttOf, style = 'double' }) → string | null` built from `overviewSpecs` (Task 8) plus dimension lines (width below, height right, in mm as the legacy drawing shows metres — match the legacy dimension text format used by `previewSvgString`); only `svg`, `rect`, `line`, `text`, `polyline`; root `<svg xmlns="http://www.w3.org/2000/svg" width=".." height=".." viewBox="..">`; no markers, no scripts, no `on*` attributes, no `style` elements (inline `fill`/`stroke` attributes). `snapshotPreviews(item, template, addonTemplate, resolved, views, partCtx)` gains an optional `partCtx = { model, buttOf }`; for `template.layout_kind` without add-on and with a model it returns the new strings and `sig`, otherwise the legacy path runs exactly as today. `itemPreviewSignature` appends a fingerprint of `layout_kind`, the model JSON and the expanded end deductions when a model is passed (legacy signature string unchanged when not).

- [ ] **Step 1: Failing tests:** (a) `partSvgString` output passes `safeSvgDataUri` from `src/lib/attachmentPages.js` (non-null) for both views and contains `<rect` for every piece and the dimension texts; (b) outside vs inside differ (mirrored, visible sash swaps); (c) a butt end shortens the drawn piece (compare two models); (d) legacy `snapshotPreviews` result for a legacy template is byte-identical to before (reuse an existing test case); (e) a `layout_kind` template without add-on returns the new strings; with an add-on returns the legacy strings; (f) the signature changes when an end mode, a deduction or the butt distance changes and is unchanged for legacy inputs; (g) `PreviewPanel` renders the new drawing for a `layout_kind` template (`renderToString`, no `NaN`/`undefined`) and offers only the double-line and solid styles; legacy templates still offer the four styles.
- [ ] **Step 2–4:** run (FAIL) → implement → run → full suite → `npm run build`. Wire `partCtx` from `useItemModel`/`snapshotFor` (the model and `buttOf` are already in the costing ctx from Task 5) and make the "ภาพเก่า" check (`currentPreviewSigs`) pass the same context so stored snapshots compare correctly.
- [ ] **Step 5: Attachment check:** a test builds the attachment plan (`planAttachmentPages`, `itemViews`) for an item whose `preview_svg_out/in` come from `partSvgString` and asserts both views are present (not `noPreview`) — proving the quotation attachment shows the new drawing without any change to `attachmentPages.js`.
- [ ] **Step 6: Commit** `feat: item preview and quotation attachment use the part-editor drawing`.

---

### Task 11: Handover, ledger, whole-branch review

**Files:** Modify `docs/handover-aluminium-cost-catalog.md` (new section "Part editor": what was built, SQL order — `2026-10-15-01` after the Phase 3 migrations, test script first —, owner click-through list in Thai, data the owner must enter [butt distances, full widths, hook overlap, clearance per profile/series], deferred items [add-on combinations and the parts/CAD preview styles still legacy; other types per spec §10]), memory file and `MEMORY.md` line.

- [ ] **Step 1:** write the section; **deploy order: apply the migration before deploying the code** (the engine and loaders read the new columns).
- [ ] **Step 2:** `npx vitest run` and `npm run build`; report counts.
- [ ] **Step 3: Whole-branch review** (most capable model) over the commits of this plan with focus on: engine parity, expansion correctness against the spec's worked example, RLS/migration vs code column names, nothing outside estimation touched, the Review Focus list above; ONE fix dispatch, one scoped re-review.
- [ ] **Step 4:** final message: all `Ruling:` lines (this plan, Phase 3, Phase 2b), the owner's SQL commands (one per message), reminder that nothing is merged or pushed and that the branch must be rebased on `origin/main` before the final merge.
