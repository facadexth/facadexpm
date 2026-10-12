# BOM template by type, start-from-saved, inline add-ons — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** create BOM templates from the owner's type catalogue (scratch or clone of a saved template), and let items carry several inline add-ons that either merge into the main unit or attach as separate units, each editable piece by piece, costed and drawn.

**Architecture:** one additive migration; pure libs (`layoutRegistry`, `addonModel`, `addonExpand`, `addonSave`, `typeReferences`) first, then costing integration, then UI that reuses the shipped part editor. Merge add-ons compile into the main BOM through an `envelope` argument of `expandParts`; attach add-ons are separate synthetic openings combined with `combineOpeningBoms` like today's add-on unit. Legacy add-on columns and templates without add-ons keep their exact current code paths.

**Tech Stack:** React 18, Vite, Supabase (Postgres RLS), vitest + `renderToString` smoke tests, existing libs `partModel.js`, `partExpand.js`, `partSave.js`, `partGeometry.js`, `partPreviewSvg.js`, `openingCost.js`, `bomEngine.js`.

**Spec:** `docs/superpowers/specs/2026-10-12-bom-template-by-type-and-addons-design.md` (read it first; the plan argues from it). Mockup the owner commented on: https://claude.ai/artifact/BHyUNkbGFkXd39DFTB4AMU (v12). Part-editor mockup (embedded unchanged in step 3): https://claude.ai/artifact/W5ancigcsmQU5MWN2eXG6W.

## Global Constraints

- FacadeX-only: every new table has RLS `is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation')` (copy the DO-block from `supabase/migrations/2026-10-15-01-bom-part-editor.sql`); UI is reachable only through the estimation module; tests assert that tenants/templates/items without the new data see no change.
- Additive and nullable: no existing column, table, view or code path is changed in behaviour. Legacy `estimation_openings.addon_*` columns are never written by new code.
- Agents never run SQL against Supabase/production; migrations are files; the owner runs them (one command per message). Deploy order: migration before code.
- No `alert`-only error paths for saves: errors are shown, never swallowed (lesson from earlier reviews); never price a missing value as 0; every numeric input becomes `Number`/`null` before entering a model.
- Match the surrounding code style (comment density, naming); files stay focused (no file over ~500 lines; `BomTemplates.jsx` is already 660: new UI goes in new files).
- UI tasks (8–12) start **only after the owner has accepted the mockup** named in the task (standing rule: mockup first). Tasks 1–7 contain no UI and may run now.
- Always set `model` explicitly when dispatching subagents; ledger at `.superpowers/sdd/2026-10-12-bom-template-by-type-and-addons/progress.md`; final message lists every `Ruling:` line.

## Rulings (plan time; the owner can overturn; most are data defaults)

- **AO-1** merge add-on: the main frame's far member (top for a top add-on) stays the outer frame and keeps its length; the stretched members are the two sides (for top/bottom add-ons) or top and bottom (left/right), cut once at the new length via an `envelope` override.
- **AO-2** with a merge add-on on side S the sash deduction on side S uses the **divider profile's butt distance** instead of the main frame member's.
- **AO-3** an attach add-on is priced inside the same item and drawn in the same attachment image; no separate quotation line.
- **AO-4** cloning a saved template always creates a new template; nothing is overwritten.
- **AO-5** limits: ≤ 6 add-ons per item, rows ≤ 6, cols ≤ 12, `len_m`/`thick_m` in (0, 20].
- **AO-6** `layout_kind` lives on `door_window_types`, set by the owner in the catalogue type form; no type-name matching.
- **AO-7** an item with a legacy single add-on cannot also have new add-ons (form shows a convert button).
- **AO-8** add-on kinds now: `fixed`, `awning`. Reference inputs: `w,h,len,mw,mh,tw,th` (attach: only `w,h`).

## Review Focus

1. Add-on larger than, or offset beyond, the main edge; zero/negative/NaN sizes; rows/cols at the limits: warnings, no negative or NaN lines, never a throw.
2. An item that has both the legacy `addon_template_id` and new add-on rows (only reachable by hand-edited data): costing must pick one deterministically (legacy wins) and flag it.
3. Template created before the migration, or a tenant whose new tables fail to load: Estimation still renders and costs legacy/part-editor templates; add-ons show as "not loaded", not as 0.
4. A `merge` add-on on every side at once, several on one side stacking, and removing one of them: expansion, drawing and persistence stay consistent (no orphan overrides).
5. Hostile upload: name with path separators/HTML, 0-byte file, wrong content type, 25 MB file, `.dwg`: refused or sanitised with Thai messages; stored path never user-controlled beyond a uuid prefix.
6. Clone of a template that has part-editor rows, flat components, joints, hardware and add-on pieces; clone of a template with missing children; name collision.

---

### Task 1: Migration and SQL test

**Files:** Create `supabase/migrations/2026-10-16-01-template-by-type-addons.sql`, `supabase/tests/template_by_type_addons_test.sql`, `.superpowers/sdd/2026-10-12-bom-template-by-type-and-addons/run-addons-tests.sh` (git-ignored; copy `run-part-editor-tests.sh` and change the file names and the `PASSED` text).

**Interfaces:** Produces the tables/columns of spec §4. Consumes `door_window_types`, `bom_templates`, `estimation_openings`, `tenants`, `current_tenant_id()`, `is_admin_or_owner()`, `has_module_access()`.

- [ ] **Step 1: Write the migration** (exact DDL):

```sql
-- Needs 2026-10-09..15 migrations applied. Additive only. Spec 2026-10-12-bom-template-by-type-and-addons-design.md §4.
ALTER TABLE door_window_types
  ADD COLUMN layout_kind TEXT CHECK (layout_kind IS NULL OR layout_kind IN ('sliding_2'));

CREATE TABLE bom_template_addon_pieces (
  id             UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id      UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  template_id    UUID NOT NULL REFERENCES bom_templates(id) ON DELETE CASCADE,
  mode           TEXT NOT NULL CHECK (mode IN ('merge','attach')),
  kind           TEXT NOT NULL CHECK (kind IN ('fixed','awning')),
  piece_key      TEXT NOT NULL CHECK (piece_key IN ('ext','divider','frame_top','frame_bottom','frame_side','mullion','rail')),
  profile_family TEXT,
  ref_input      TEXT NOT NULL CHECK (ref_input IN ('w','h','len','mw','mh','tw','th')),
  length_factor  NUMERIC NOT NULL DEFAULT 1 CHECK (length_factor > 0),
  deduction_mm   NUMERIC NOT NULL DEFAULT 0 CHECK (deduction_mm >= 0),
  qty_rule       TEXT NOT NULL DEFAULT 'fixed' CHECK (qty_rule IN ('fixed','cols-1','rows-1','cols','rows','rows*cols')),
  qty_fixed      INT NOT NULL DEFAULT 1 CHECK (qty_fixed >= 0 AND qty_fixed <= 1000),
  thickness_role TEXT CHECK (thickness_role IS NULL OR thickness_role IN ('sash')),
  sort_order     INT NOT NULL DEFAULT 0,
  UNIQUE (template_id, mode, kind, piece_key),
  CHECK ((mode = 'merge' AND piece_key NOT IN ('frame_top','frame_bottom','frame_side'))
      OR (mode = 'attach' AND piece_key NOT IN ('ext','divider'))),
  CHECK (mode = 'merge' OR ref_input IN ('w','h'))
);

CREATE TABLE estimation_item_addons (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id  UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  opening_id UUID NOT NULL REFERENCES estimation_openings(id) ON DELETE CASCADE,
  mode       TEXT NOT NULL CHECK (mode IN ('merge','attach')),
  kind       TEXT NOT NULL CHECK (kind IN ('fixed','awning')),
  position   TEXT NOT NULL CHECK (position IN ('top','bottom','left','right')),
  len_m      NUMERIC NOT NULL CHECK (len_m > 0 AND len_m <= 20),
  thick_m    NUMERIC NOT NULL CHECK (thick_m > 0 AND thick_m <= 20),
  offset_m   NUMERIC NOT NULL DEFAULT 0 CHECK (offset_m >= 0),
  rows       INT NOT NULL DEFAULT 1 CHECK (rows BETWEEN 1 AND 6),
  cols       INT NOT NULL DEFAULT 1 CHECK (cols BETWEEN 1 AND 12),
  sort_order INT NOT NULL DEFAULT 0
);

CREATE TABLE estimation_type_references (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id    UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  type_id      UUID NOT NULL REFERENCES door_window_types(id) ON DELETE CASCADE,
  storage_path TEXT NOT NULL,
  file_name    TEXT NOT NULL,
  content_type TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_bom_template_addon_pieces_template_id ON bom_template_addon_pieces(template_id);
CREATE INDEX idx_estimation_item_addons_opening_id    ON estimation_item_addons(opening_id);
CREATE INDEX idx_estimation_type_references_type_id   ON estimation_type_references(type_id);
-- then the same DO $$ block as 2026-10-15-01 for the three new tables (tenant_id index, RLS, admin_full_access policy).
```
Check first (grep) that no view selects `door_window_types.*` (memory: view `x.*` freezes) and say so in a comment.

- [ ] **Step 2: SQL test** `supabase/tests/template_by_type_addons_test.sql`, modelled on `bom_part_editor_test.sql` (BEGIN…ROLLBACK, two test tenants named `__AO TEST A/B`, estimation module on for A only): constraint cases (each CHECK rejects a bad row: key/mode mismatch, `attach` with `ref_input='tw'`, `rows=7`, `len_m=0`, `len_m=21`), UNIQUE `(template_id,mode,kind,piece_key)`, cascade (delete template → pieces gone; delete opening → add-ons gone; delete type → references gone), RLS (tenant B sees none of A's rows; a non-admin sees none; a tenant without the module sees none), `layout_kind='bad'` rejected.
- [ ] **Step 3: Static self-review only** (no SQL is executed by agents). Commit `feat: migration for type layout kind, add-on piece sets, item add-ons, type references`.

### Task 2: Layout registry and catalogue field

**Files:** Create `src/lib/layoutRegistry.js`, `src/lib/layoutRegistry.test.js`; Modify `src/pages/aluCatalog/TypesTab.jsx` (one field), `src/lib/catalogTypeForm.test.js` or the existing types test.

**Interfaces:** Produces `LAYOUT_REGISTRY` (`{ sliding_2: { label, inputs: ['width','height'], addonKinds: ['fixed','awning'], hasPartEditor: true } }`), `layoutForType(type) → { kind, label, inputs, addonKinds, hasPartEditor } | null`, `LAYOUT_OPTIONS` (`[{value,label}]`), `ADDON_KIND_LABEL = { fixed: 'ช่องแสงติดตาย (กริด)', awning: 'ช่องแสงบานกระทุ้ง (กริด)' }`. Consumes `LAYOUTS` keys from `partModel.js`.

- [ ] **Step 1: Failing tests:** `layoutForType({layout_kind:'sliding_2'})` returns the entry; `layoutForType({layout_kind:null})`, `layoutForType(null)`, `layoutForType({layout_kind:'unknown'})` return `null`; every registry key exists in `LAYOUTS` (guards drift); `LAYOUT_OPTIONS` lists the Thai labels; the types form field `layout_kind` is `omitWhenAbsent: true` (so saving a type before the migration still works) and blank maps to `null`.
- [ ] **Step 2–4:** implement; add to `typeFields` a select `{ key: 'layout_kind', label: 'แบบชิ้นส่วน (layout)', type: 'select', emptyLabel: '— ไม่มี (ใช้ตารางชิ้นส่วนแบบเดิม) —', options: LAYOUT_OPTIONS, omitWhenAbsent: true, hint: 'ประเภทที่เลือกแบบชิ้นส่วนไว้ จะสร้าง template ด้วยหน้าคลิกชิ้นส่วน (part editor) ประเภทที่เว้นว่างใช้ตารางชิ้นส่วนแบบเดิม' }` using the existing field flags; run focused tests, full suite, build. Commit `feat: layout registry and type layout field`.

### Task 3: Add-on model (pure)

**Files:** Create `src/lib/addonModel.js`, `src/lib/addonModel.test.js`.

**Interfaces:** Produces
`ADDON_MODES = ['merge','attach']`, `ADDON_KINDS = ['fixed','awning']`, `ADDON_POSITIONS = ['top','bottom','left','right']`, `MAX_ADDONS = 6`, limits per AO-5;
`newAddon({ mode='merge', kind='fixed', position='top', mainWidthMm, mainHeightMm }) → { mode, kind, position, len_mm, thick_mm, offset_mm, rows, cols }` (len = main edge on that side, thick 400, offset 0, rows 1, cols 3);
`addonDims(a) → { w, h }` (top/bottom: w = len, h = thick; left/right: w = thick, h = len);
`layoutAddons({ widthMm, heightMm, addons }) → { rects: [{ main?: true, i?, x, y, w, h }], envelope: { x0, y0, w, h } }` (port of the mockup `layout()` stacking: top/left add-ons grow in negative coordinates, cumulative per side in list order);
`refValue(a, ref, main) → mm` (`w,h` from `addonDims`; `len` = `len_mm`; `mw,mh` = main opening; `tw,th` = main + this add-on only);
`defaultAddonPieces(mode, kind, { buttMm = 0 }) → rows` (spec §5.3 defaults with `profile_family: null`, `deduction_mm = 2*buttMm` where the spec says 2 × butt, `qty_rule`/`qty_fixed` as in §5.3, merge: `ext` (ref `th` for top/bottom, `tw` for left/right is resolved at expansion by position, so the row stores `ref_input:'th'` and the expander swaps), `divider` ref `len`; attach: frame_top/bottom ref `w`, frame_side ref `h`, mullion ref `h`, rail ref `w`);
`validateAddons(addons, main) → string | null` (first Thai problem: count > 6, rows/cols out of range or non-integer, `len_mm`/`thick_mm` ≤ 0 or non-finite, `offset_mm` < 0, unknown mode/kind/position; never mutates).

- [ ] **Step 1: Failing tests** (numbers from the mockup, main 1800 × 1200): top add-on len 1800 thick 400 → `envelope` 1800 × 1600, rect y = −400; second top add-on thick 300 stacks to y = −700, envelope h = 1900; bottom add-on rect y = 1200; left add-on thick 400 → x = −400, envelope w = 2200; `addonDims` swaps for left/right; `refValue` for the top add-on: `w` 1800, `h` 400, `len` 1800, `mw` 1800, `mh` 1200, `tw` 1800, `th` 1600; for a right add-on `tw` 2200, `th` 1200; `defaultAddonPieces('attach','fixed',{buttMm:38.1})` has frame_top ded 76.2 qty 1, frame_side ded 0 qty 2, mullion qty rule `cols-1`, rail `rows-1`, and no `ext`/`divider`; merge has `ext` (qty 2, ded 0) and `divider` (ded 76.2, qty 1) and no frame_*; `validateAddons` rejects 7 add-ons, rows 0, cols 13, rows 1.5, len 0, NaN, offset −1, unknown position (one test each, Thai message non-empty) and accepts the defaults; inputs are not mutated (deep-freeze them).
- [ ] **Step 2–4:** implement, full suite. Commit `feat: add-on model (layout, dims, defaults, validation)`.

### Task 4: Add-on expansion (pure)

**Files:** Create `src/lib/addonExpand.js`, `src/lib/addonExpand.test.js`; Modify `src/lib/partExpand.js` (additive optional `envelope` argument), `src/lib/partExpand.test.js` (extend).

**Interfaces:**
`expandAddons({ addons, pieceSets, main: { widthMm, heightMm }, buttOf, dividerButtOf }) → { attach: [{ addonIndex, opening: { width_m, height_m, panel_count }, components }], merge: { envelope, extraComponents }, glass: [{ addonIndex, count, widthMm, heightMm }], issues }` where `pieceSets` is the array of `bom_template_addon_pieces` rows and `buttOf(family)` is the existing lookup;
`expandParts({ model, buttOf, widthOf, envelope })` (new optional `envelope = { frameSideHeightMm?, frameTopWidthMm?, frameBottomWidthMm?, sashTopDividerButtMm?, sashBottomDividerButtMm?, sashLeft…/Right… }`). Absent or `{}` ⇒ **byte-identical output** to today. With `frameSideHeightMm` the `frame_side` lines compute from that height instead of the opening height; with a divider butt for a side the sash deduction on that side uses it (AO-2).

- [ ] **Step 1: Failing tests** (main 1800 × 1200, butt of every profile 38.1 unless stated, profile families filled in the piece sets):
  - attach, top add-on 1800 × 400, 1 × 3: components `frame_top` length 1,723.8 qty 1, `frame_bottom` 1,723.8 qty 1, `frame_side` 400 qty 2, `mullion` 323.8 qty 2, `rail` qty 0 (row dropped, no component), glass 3 × (523.8 × 323.8); opening `width_m 1.8, height_m 0.4, panel_count 3`.
  - attach 2 rows × 2 cols on a right add-on thick 500 len 1200: dims w 500, h 1200; mullion length `h` − 76.2 = 1,123.8 qty 1; rail length `w` − 76.2 = 423.8 qty 1; glass 4 × (173.8 × 523.8).
  - merge top add-on 1800 × 400, 1 × 3: `envelope.frameSideHeightMm = 1600`; `divider` 1,723.8 qty 1; `mullion` 323.8 qty 2; glass 3 × (523.8 × 323.8); main `expandParts` with that envelope: `frame_side` component length 1.6 m qty 2 (was 1.2), frame top/bottom and sash lengths unchanged when the divider butt equals the main frame butt (AO-1).
  - AO-2: divider profile butt 25, frame_top butt 38.1, frame_bottom butt 35.8, merge top add-on ⇒ stile length = 1200 − (25 + 35.8) = 1,139.2 mm (without add-on 1,126.1); with a **bottom** merge add-on the bottom term uses the divider butt, top term unchanged.
  - merge add-ons on top and left together ⇒ both envelope entries set; two top add-ons ⇒ `frameSideHeightMm` = 1200 + 400 + 300, two dividers.
  - issues: empty `profile_family` ⇒ `no_profile_family` and no component; `buttOf` returns null ⇒ `no_butt_distance`, deduction counted 0 and flagged; missing piece set for the add-on's (mode, kind) ⇒ `addon_piece_missing`; add-on `off + len` > main edge ⇒ `addon_out_of_range` (still expanded, flagged); a piece length that would be ≤ 0 (add-on thick 50 with ded 76.2) ⇒ clamped to 0, component dropped, `addon_piece_too_small` issue; never negative or NaN.
  - quantity rules: `fixed` uses `qty_fixed`, `cols-1` with cols 1 ⇒ 0, `rows*cols`.
  - `expandParts` with no/empty `envelope` equals the existing outputs (reuse three existing test models; assert deep equality with the call without the argument).
  - inputs frozen: no mutation.
- [ ] **Step 2–4:** implement; keep each function < 60 lines; clamp, never throw on bad input (`expandAddons(null)` ⇒ empty result); run full suite. Commit `feat: add-on expansion (attach units, merge envelope, divider butt)`.

### Task 5: Persistence and cloning

**Files:** Create `src/lib/addonSave.js`, `src/lib/addonSave.test.js`, `src/lib/templateClone.js`, `src/lib/templateClone.test.js`.

**Interfaces:**
`pieceRowsFromSets(rows) → piece sets`/`pieceSetsToRows(sets, templateId) → rows` (whitelisted columns only, no ids from the client except via `newId`);
`saveAddonPieces({ supabase, templateId, rows })` (validate → delete the template's rows → insert; throw on first error, document the non-atomic window like `saveModel`; validation before any delete);
`loadAddonPieces({ supabase, templateId })`; `loadItemAddons({ supabase, openingIds })`; `saveItemAddons({ supabase, openingId, addons })` (m → metres, `validateAddons` first, delete → insert, `sort_order` = list order);
`cloneTemplate({ supabase, sourceId, name, newId })` → `{ id }` copying in order: `bom_templates` (new name, same `type_id`, `layout_kind`), `bom_template_components`, `bom_template_joints` (remapping `joint_id` on components), `bom_template_hardware`, part-editor rows via `loadModel` + `saveModel` (existing, so ids are regenerated), `bom_template_addon_pieces`; stops at the first error and reports which table failed; on failure after the template row exists, deletes the new template row (cascade) so no half clone remains and returns the error.

- [ ] **Step 1: Failing tests** (fake supabase client recording calls): round trip pieces ↔ rows equals; unknown columns never written; `saveAddonPieces` order is delete → insert and a validation error performs **zero** calls; first injected error stops later inserts; `saveItemAddons` converts mm↔m exactly (400 mm ⇄ 0.4), rejects 7 add-ons with zero calls; clone: every child table copied once, joint ids remapped (component with `joint_id` points to the new joint), name collision error (`23505`) returns a Thai message and leaves nothing behind; clone of a template with no children succeeds; part-editor template clones its model (rows count equal); the new template never shares an id with the source.
- [ ] **Step 2–4:** implement, full suite. Commit `feat: add-on persistence and template cloning`.

### Task 6: Costing integration

**Files:** Modify `src/lib/openingCost.js`, `src/lib/projectBom.js` (only if it enumerates add-on BOMs), `src/lib/reasonText.js`, `src/pages/Estimation.jsx` (loaders), `src/pages/estimation/ProviderCompare.jsx`; Create `src/hooks/useTemplateAddonPieces.js`, `src/hooks/useItemAddons.js`; tests `openingCost.test.js` (extend), `reasonText` test, hook smoke.

**Interfaces:** `costOpening` ctx gains optional `addonPiecesByTemplate` (`{ [templateId]: rows[] }`) and `itemAddonsByOpening` (`{ [openingId]: addon[] }`), `itemAddonsError` / `addonPiecesError` (strings or null); result gains `addonBoms` (array) and issues with `source: 'addon'`; hooks `useTemplateAddonPieces(templates) → { addonPiecesByTemplate, loading, error }` (module-gated like `useBomPartModel`; fetch only for templates with `layout_kind`), `useItemAddons(openingIds) → { itemAddonsByOpening, loading, error }`. New reason codes `addon_piece_missing`, `addon_out_of_range`, `addon_piece_too_small`, `addon_not_loaded` with Thai text.

- [ ] **Step 1: Failing tests:** (a) **parity**: item without add-ons, and the legacy `addon_template_id` item, produce exactly the existing numbers (reuse an existing case with the absolute total, not only a with/without comparison); (b) item with one attach add-on: total = main + add-on unit cost, `addonBoms.length === 1`, the combined BOM lists the add-on bars (via `combineOpeningBoms`); (c) one merge add-on: the main BOM's frame side line is 1.6 m × 2, divider and mullion rows present, infill area includes the add-on panes; (d) legacy `addon_template_id` **and** new add-ons present: legacy wins, issue `addon_conflict`; (e) the add-on tables failed to load (`ctx.itemAddonsError` or `ctx.addonPiecesError` set): every item whose template has a `layout_kind` gets issue `addon_not_loaded` (shown once per item, no silent zero) and costs exactly as before otherwise; (f) missing piece set ⇒ `unresolved` with `addon_piece_missing`; (g) reasonText returns Thai for all four new codes; (h) ProviderCompare passes both ctx maps (grep every `costOpening(` / `costItems(` caller receives them; assert in a test that `Estimation`'s `base` ctx has the keys).
- [ ] **Step 2–4:** implement: in `costOpening`, when `itemAddons` non-empty and the item has no legacy add-on: run `expandAddons`, pass `envelope` into `prepareComponents`→`expandParts`, append merge components, cost each attach unit with `computeBomForOpening` (synthetic opening; infill type and pricing as `buildEngineAddonOpening` does — read it and reuse its infill logic), combine, add issues. No change when the list is empty. Hooks must not make Estimation wait forever or blank costs on error (lesson from Task 5 of the part editor: errors set `loading=false`; a refetch must not null `base`). Full suite, build. Commit `feat: cost inline add-ons (attach units and merge into main unit)`.

### Task 7: Type reference upload library

**Files:** Create `src/lib/typeReferences.js`, `src/lib/typeReferences.test.js`, `src/hooks/useTypeReferences.js`.

**Interfaces:** `validateReferenceFile({ name, size, type }) → string | null` (Thai: `.dwg`/`.dxf` ⇒ hint to export as pdf or image; allowed `image/png|jpeg|webp|gif`, `application/pdf`; size ≤ 20 MB and > 0), `safeFileName(name) → string` (strip path separators, control chars, collapse to `[A-Za-z0-9._-ก-๙ ]`, ≤ 80 chars, never empty), `referencePath({ tenantId, typeId, name, uuid }) → string` (`<tenant>/type-references/<type>/<uuid>-<safe name>`), `uploadReference({ supabase, tenantId, typeId, file, uuid })` (upload to bucket `estimation-images`, then insert the row; if the insert fails, remove the uploaded object and surface the error), `deleteReference({ supabase, row })` (remove object, then row; row first would orphan a file, so object first and a tolerated "not found"), `useTypeReferences(typeId) → { rows, loading, error, refetch }`, `referenceUrl(supabase, row)` (signed URL, 1 h).

- [ ] **Step 1: Failing tests:** each validator branch (dwg, 0 bytes, 25 MB, svg refused because it could carry script, exe); `safeFileName('../../x<script>.png')` has no `/`, `<`, `..`; Thai file names kept; path starts with the tenant id; upload failure ⇒ no row insert; insert failure ⇒ object removed (fake client records `remove`); delete tolerates a missing object; the hook is module-gated (no fetch without a `typeId`).
- [ ] **Step 2–4:** implement, full suite. Commit `feat: type reference upload library`.

> **Gate before Task 8:** publish nothing new; confirm with the owner (one line in the chat) that mockup v12 (https://claude.ai/artifact/BHyUNkbGFkXd39DFTB4AMU) is accepted and which open question rulings (spec §10) stand. If the owner changes a ruling, change the data defaults in Task 3 only (`defaultAddonPieces`) and the AO-2 flag in Task 4.

### Task 8: Create flow — type picker and start from scratch / saved

**Files:** Create `src/pages/bomTemplates/NewTemplateWizard.jsx`, `TypePicker.jsx`, `StartFrom.jsx`, `NewTemplateWizard.smoke.test.jsx`; Modify `src/pages/BomTemplates.jsx` (the "สร้างใหม่" entry opens the wizard; editing an existing template is unchanged).

**Behaviour: follow mockup v12 steps 1–2 exactly (read it first).** Props `{ types, templates, onCancel, onStart }`; `onStart({ type_id, layout_kind, cloneFrom?: templateId })`. `TypePicker`: tree from `typeTreeOf(types)` (existing helper in `itemForm.js`), parents with children not selectable, shows "มี editor" when `layoutForType(type)` is non-null else "รอสูตร"; `StartFrom`: segmented "เริ่มจากศูนย์" / "เริ่มจากไฟล์ที่บันทึกไว้", saved list filtered by `type_id` with a tick to show all, selecting + "โหลดมาแก้" ⇒ clone (Task 5) then open the editor on the clone with a name field "ชื่อ template ใหม่" prefilled `<name> (สำเนา)`; scratch with a layout-kind type ⇒ `startModel(kind)` and default add-on pieces; scratch with a type without layout kind ⇒ today's flat editor (unchanged).

- [ ] **Step 1: Smoke tests** (`renderToString`, `vi.mock` supabase as in `ItemModal.smoke.test.jsx`): the wizard renders the type tree with Thai labels and no `NaN`/`undefined`; a type with `layout_kind` shows the "มี editor" chip; the saved list is filtered to the picked type and shows all types after the tick state is set; the "โหลดมาแก้" button is disabled until a template is picked; legacy: the existing editor renders for a template with no `layout_kind` exactly as before (reuse an existing `BomTemplates` smoke case).
- [ ] **Step 2: Pure helpers** (in `src/pages/bomTemplates/helpers.js`, tests in `helpers.test.js`): `savedTemplatesFor(templates, typeId, all)`, `defaultCloneName(name, existingNames)` (adds " (สำเนา)", then " (สำเนา 2)" … on collision).
- [ ] **Step 3–4:** implement; controller compares each screen with the mockup (screenshots into the scratchpad). Commit `feat: create BOM template from type, scratch or saved template`.

### Task 9: Add-on box, add-on zoom editor, collapse

**Files:** Create `src/pages/bomTemplates/addon/AddonBox.jsx`, `AddonZoom.jsx`, `AddonPieceTable.jsx`, `AddonEffects.jsx`, `addonView.js`, `AddonBox.smoke.test.jsx`, `addonView.test.js`; Modify `src/pages/bomTemplates/PartEditor.jsx` (mount the box under the width/height bar; add the "เสร็จแล้ว ▲ / แก้" collapse to profile lines in `PartLine.jsx` via `line.done` kept in UI state only), `PartPreview.jsx` (overlay add-ons around the unchanged overview markup; click selects an add-on and fades the main unit).

**Behaviour: mockup v12 (add-on box in the main card, zoom card, effects table, collapse).** The add-on zoom geometry (attach: own frame; merge: shared frame, extended sides, divider, faded main stub; any of four positions) is a pure `addonView.js` (`zoomPieces({ addon, mode, scale }) → [{ key, x, y, w, h, role }]`) so it is testable without a DOM; the side panel edits `bom_template_addon_pieces` rows in the template model (profile from `catalogFamilies(index)`, ref input from the allowed list, factor, deduction, qty rule, fixed qty); numbers shown come from `addonExpand`/`pieceLength` (no formulas in the UI); all numeric inputs are `Number`/`null`.

- [ ] **Step 1: Pure tests** (`addonView.test.js`): for each of the four positions and both modes the pieces tile the add-on rectangle with no overlap and no gap (sum of areas = rectangle area; sweep rows 1–3 × cols 1–4); merge shows the stub and the extended sides; selection keys exist in the piece set.
- [ ] **Step 2: Smoke tests:** box renders defaults without `NaN`; collapse hides fields and shows the one-line summary; expanding restores; zoom renders pieces and the table header "ความยาว × ท่อน (มม.)"; with no profile the table says the unresolved Thai text instead of numbers; legacy part-editor snapshot (no add-ons) unchanged (render string equal to the pre-change render of the same model — capture the golden before editing, as in Task 10 of the part-editor plan).
- [ ] **Step 3–4:** implement, full suite, build, controller screenshot check against the mockup. Commit `feat: add-on box, zoom editor and collapse`.

### Task 10: Reference upload UI

**Files:** Create `src/pages/bomTemplates/TypeReferences.jsx`, `TypeReferences.smoke.test.jsx`; mount in `NewTemplateWizard.jsx` and in the editor header.

**Behaviour: mockup v12 "รูปแบบอ้างอิง" box.** Thumbnails (images via signed URL `<img>`; pdf as a labelled tile), delete button, drop zone/`<input type=file multiple accept>`, per-file error line, "dwg ใช้ตรง ๆ ไม่ได้ ให้ export เป็น pdf หรือรูป" note; hidden when the module gate fails.

- [ ] **Step 1: Smoke tests:** empty state text, a row list with an image and a pdf, error text for a refused file (call `validateReferenceFile`), no `dangerouslySetInnerHTML` (grep assertion in the test file reading the component source).
- [ ] **Step 2–4:** implement, full suite, build. Commit `feat: reference uploads per type`.

> **Gate before Task 11:** publish a mockup artifact of the **item form** with the multi-add-on list (mode, kind, position, size, offset, rows, cols, legacy convert button, overall size, live drawing) built from mockup v12's add-on box and the Mockup 2b item screen; wait for the owner's comments (standing rule).

### Task 11: Item form — several add-ons

**Files:** Create `src/pages/estimation/ItemAddons.jsx`, `ItemAddons.smoke.test.jsx`; Modify `src/pages/estimation/ItemModal.jsx`, `itemForm.js`, `useItemModel.js`, `ItemCostSummary.jsx` (list add-on lines), `openingPayload.js` (do **not** write legacy add-on columns for new add-ons), `itemRoundTrip.test.js`.

**Interfaces:** form field `addons: Addon[]` (mm); `formFromOpening(item, addons)`, `buildOpeningPayload(form)` unchanged for legacy columns; new `saveItemAddons` call after the opening row is saved (never before: opening id needed), failure shown with the existing save-error path; `convertLegacyAddon(form) → form` implementing AO-7.

- [ ] **Step 1: Failing tests:** round trip form → payload → form for an item with two add-ons (mm values exact); legacy-only item round-trips byte-identically; new + legacy together is rejected by `validateItemForm` with a Thai message; convert button turns the legacy add-on into one `attach` add-on with the same size/position and clears the legacy fields; the cost summary shows one line per add-on; saving fails visibly if `saveItemAddons` throws and the item row is not left half-saved (opening row kept, error shown, add-ons retried on next save).
- [ ] **Step 2–4:** implement, full suite, build, controller check vs the accepted item mockup. Commit `feat: several inline add-ons on items`.

### Task 12: Drawings, signature, attachments

**Files:** Modify `src/lib/partPreviewSvg.js`, `src/lib/itemPreviewSignature.js`, `src/pages/estimation/PreviewPanel.jsx`, `useItemModel.js`, `projectDefaults.js` (`currentPreviewSigs`); tests alongside, plus `src/lib/attachmentPages.test.js` (one new case).

**Interfaces:** `partSvgString({ model, widthMm, heightMm, view, buttOf, widthOf, style, addons })` (new optional `addons`; absent ⇒ identical output): main drawing unchanged, merge add-ons inside one outer frame with a divider bar, attach add-ons with their own frame, overall dimension lines, total size in the same text format; allowed elements only (`svg`, `rect`, `line`, `text`, `polyline`), passes `safeSvgDataUri`. Signature appends a fingerprint of the add-on list (sorted keys) when present; unchanged strings otherwise.

- [ ] **Step 1: Failing tests:** golden equality for items without add-ons (the existing golden fixture still passes untouched); add-on drawing passes `safeSvgDataUri` for outside and inside views; envelope text equals `Math.round` of the overall mm; merge vs attach differ; signature changes when an add-on field changes and not when only an unused catalogue value changes; attachment plan test: an item whose `preview_svg_out/in` contain add-ons yields both views (not `noPreview`) without changes to `attachmentPages.js`.
- [ ] **Step 2–4:** implement, full suite, build. Commit `feat: drawings and quotation attachments with add-ons`.

### Task 13: Handover, ledger, whole-branch review

**Files:** Modify `docs/handover-aluminium-cost-catalog.md` (new section "Create by type, add-ons"), memory file `project_aluminium_cost_catalog_brainstorm.md` and `MEMORY.md` line.

- [ ] **Step 1:** write the section: what was built, SQL order (migration `2026-10-16-01` after `2026-10-15-01`, test script first, one command per message), owner click-through list in Thai (set `layout_kind` on the sliding type; create from scratch; clone; add one merge and one attach add-on and click each piece; upload a reference; open an old item and a legacy add-on item; check a quotation attachment), data the owner must enter (profiles for divider/mullion/rail/frame per template; butt distances), deferred items (other types, vent/side-hung kinds, auto-hide of finished lines, migrating `estimation_layout_templates`).
- [ ] **Step 2:** `npx vitest run`, `npm run build`, report counts.
- [ ] **Step 3: Whole-branch review** (most capable model) over this plan's commits: engine/expansion parity, expansion numbers against spec §8 by hand, migration vs code column names (grep every column name in the code against the SQL), RLS and module gate, nothing outside estimation touched, the Review Focus list; ONE fix dispatch, one scoped re-review.
- [ ] **Step 4:** final message: all `Ruling:` lines (this plan, part editor, Phase 3, Phase 2b), the owner's SQL commands (one per message), reminder that nothing is merged or pushed and the branch must be rebased on `origin/main` before the final merge.
