# Sliding 2-sash: inline add-ons (ช่องแสง) and type options — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** items on a `sliding_2` template can carry several inline add-ons (ช่องแสง: merge into the main frame or attach as a separate unit), each with an owner-editable piece set per (mode, kind, position), costed, drawn and persisted; and `sliding_2` gains the owner's options (ประตู/หน้าต่าง, เลื่อนสวน / เลื่อน 1 ฟิก 1).

**Architecture:** one additive migration (two tables); pure libs first (`addonModel`, `addonExpand`, `addonSave`), an additive `overrides` argument on `expandParts` and an additive `fixed_length_mm` on engine components; costing integration in `openingCost`; UI that reuses the shipped part editor (add-on box + zoom card per mockup v12) and the item modal. Everything is opt-in per template/item: templates without piece sets and items without add-ons take the byte-identical existing path.

**Tech Stack:** React 18, Vite, Supabase (Postgres RLS), vitest + `renderToString` smoke tests; existing libs `partModel.js`, `partExpand.js`, `partSave.js`, `partPreviewSvg.js`, `openingCost.js`, `bomEngine.js`, `layoutRegistry.js`, `layouts/sliding_2.js`.

**Spec:** `docs/superpowers/specs/2026-10-12-bom-template-by-type-and-addons-design.md` §3–§5, §7, §8 (read first), **amended by the owner's rulings of 2026-10-14/15 recorded in this plan's Rulings** (formula sheet https://claude.ai/artifact/2EPvVZiaFh6DdHqDt9aZaT sections `#addons`, `#addon-sliding-tb`, and the sliding_2 "ขอเพิ่ม" table). Mockup v12 (add-on box, zoom card, effects table): https://claude.ai/artifact/BHyUNkbGFkXd39DFTB4AMU. Superseded plan (kept for history, do not execute): `2026-10-12-bom-template-by-type-and-addons.md` — its Tasks 2 (registry: already shipped by the 13-layouts work), 5-clone, 7, 8, 10 (type picker wizard, reference uploads, cloning) are **deferred**, not part of this plan.

## Global Constraints

- FacadeX-only: new tables get the exact RLS block of `supabase/migrations/2026-10-15-01-bom-part-editor.sql` lines 71–82 (`admin_full_access`: `is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation')`); UI reachable only inside the estimation module.
- Additive and nullable: no existing column/table/view changes behaviour; legacy `estimation_openings.addon_*` columns are never written by new code. No view selects `estimation_openings.*` / `bom_templates.*` (checked in 2026-10-17-01's header; re-grep anyway).
- Agents never run SQL on Supabase; migrations are files, the owner runs them (`!` command, dry-run script first). Deploy order: `2026-10-17-01` then `2026-10-18-01` before code.
- `sliding_2` behaviour is FROZEN by tests (`partModel.test.js`, sha256 drawing pin in `partPreviewSvg` tests): every change to `layouts/sliding_2.js` must keep a model built with default params byte-identical (new inputs default to the old behaviour, new positions use `enabled` expressions that are 0 by default).
- No `alert`-only save errors; never price a missing value as 0 (issue instead); every numeric input becomes `Number`/`null` before entering a model.
- Match the surrounding style; no file over ~500 lines (`BomTemplates.jsx` is 660 → new UI goes in `src/pages/bomTemplates/addon/`).
- Worktree `/Users/plfx/code/FacadeXPM/facadex-app/.claude/worktrees/alu-cost-catalog`, branch `feat/alu-cost-catalog`; never bare `git stash`. Baseline before Task 1: 2218 tests passing (`npx vitest run`), `npm run build` OK.
- Subagents: set `model` explicitly (Sonnet 5.5 default; Opus 5.5 for Tasks 3 and 5; never Haiku). Commit trailer on every commit: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Ledger `.superpowers/sdd/2026-10-15-sliding2-addons/progress.md`.

## Rulings (plan time; the owner overturns by data where possible)

- **AO-1** (spec) merge add-on: the main frame's far member keeps its length; the two members running beside the add-on (`frame_side` for top/bottom add-ons, `frame_top`+`frame_bottom` for left/right) are cut **once** at the overall length (`th` / `tw`) via an override of the main position — no extra bar.
- **AO-2** (spec, narrowed) with a merge add-on on side S **and a `divider` row with qty > 0**, the sash deduction on side S uses the divider's butt distance. With divider qty 0 (the sliding top/bottom ruling) the sash deduction is unchanged.
- **AO-3** attach add-ons are priced inside the same item and drawn in the same attachment; the synthetic add-on opening uses the **main template's** rates (waste, labour, silicone, felt) and the item's infill type; no hardware rows.
- **AO-5** limits: ≤ 6 add-ons per item, rows ≤ 6, cols ≤ 12, `len_m`/`thick_m` in (0, 20].
- **AO-7** an item with a legacy single add-on (`addon_template_id`) cannot also have new add-ons; legacy wins in costing with issue `addon_conflict`; the form offers "แปลงเป็นช่องแสงแบบใหม่".
- **AO-9 (owner 2026-10-15, sliding top/bottom merge):** the main frame side profile is **substituted** (เฟรมข้างติดกล่อง → กล่องร่องวิ่งยาว) and cut at `th`; the add-on gets 2 overlay side pieces (เฟรมข้างไม่ติดกล่อง, free ends); **no divider**: the main's facing member (เฟรมบน for a top add-on, เฟรมล่าง for a bottom one) stays, with a machining note (ตบเรียบ / ตบร่อง); a top add-on adds a bead (คิ้วเท) on that member. Encoded as data: piece sets are keyed by **(mode, kind, position)** for merge, so the four sides can differ; defaults for `sliding_2` top/bottom follow this ruling, left/right follow the spec (ext lengthening, divider qty 1).
- **AO-10** a merge `ext` row with a `profile_family` set means **profile substitution** of the main position's line 0 (every piece of that position); the substituted family's butt distance is what other pieces' automatic deductions read (the sash now sits against the track box). `profile_family` null = keep the main's family (spec behaviour).
- **AO-11** per-piece machining notes (`note` column, ≤ 120 chars) are shown in the effects table and in the BOM line `role_name` as a suffix in brackets; they never change a price.
- **AO-12** open owner questions become editable defaults, never blockers: overlay side length `h` (deduction 0), bead length `len − 2·b[overlay side]`, bottom add-on bead qty 0, add-on far frame = `len − 2·b[overlay side]` with family null (owner assigns), awning add-ons = fixed add-on pieces (no sash pieces yet; issue-free, just fewer bars).
- **S-1 (sliding_2 options, owner 2026-10-14/15):** inputs `door` (ประตู/หน้าต่าง, boolean, default false, `fixed_by_type`), `one_fixed` (รูปแบบบาน: 0 = เลื่อนสวน, 1 = เลื่อน 1 ฟิก 1, default 0, `fixed_by_type`), `fixed_side` (ซ้าย/ขวา, only when `one_fixed = 1`, estimator). Hardware defaults for new templates: ลูกล้อ `4 − 2·one_fixed` per unit, มือจับล็อค (ด้านใน) `2 − one_fixed` per unit, กุญแจ/มือจับเรียบ (ด้านนอก) `door·(2 − one_fixed)` per unit. New position ธรณีกันบานเลื่อน (`enabled: 'one_fixed'`): `(W − 2·b[เฟรมข้าง] + o) × 0.5 − b[เสาเกี่ยว] − b[เสากุญแจ] + w[เสากุญแจ]`, free piece. The `sliding_1_fixed_1` draft type is folded into this option (no new layout kind, no CHECK widening).

## Review Focus

1. Add-on wider than, or offset beyond, the main edge; thick ≤ deduction; rows/cols at the limits; NaN/strings from the DB: Thai warnings, lengths clamped to 0 and flagged, never negative, never a throw (Task 3 tests `addon_out_of_range`, `addon_piece_too_small`, `expandAddons(null)`).
2. Item with legacy `addon_template_id` **and** new rows (hand-edited data): legacy costs, issue `addon_conflict`, new rows ignored deterministically (Task 5 test d).
3. Tables missing or failed to load (deployed code before migration, RLS denies): Estimation still renders and costs as before; add-on items get `addon_not_loaded`, never a silent 0 (Task 4 hook tests, Task 5 test e).
4. Merge add-ons on every side at once, two on one side, then remove one: overrides and piece sets stay consistent, no orphan override, `th` stacks (Task 3 stacking tests; Task 6 smoke).
5. `sliding_2` frozen behaviour after the option work: default-param model, drawing sha256 and expand numbers unchanged (Task 9 parity tests run the existing frozen suites untouched).

---

### Task 1: Migration, SQL test, dry-run script

**Files:**
- Create: `supabase/migrations/2026-10-18-01-item-addons.sql`, `supabase/tests/item_addons_test.sql`, `.superpowers/sdd/2026-10-15-sliding2-addons/run-addons-tests.sh`
- Reference: `supabase/migrations/2026-10-15-01-bom-part-editor.sql` (RLS block), `supabase/tests/bom_part_editor_test.sql` (test shape), `.superpowers/sdd/2026-10-13-part-editor-layouts-all-types/run-layouts-tests.sh` (script shape)

**Interfaces:**
- Produces tables `bom_template_addon_pieces`, `estimation_item_addons` (columns below; Tasks 4–7 use these exact names).
- Consumes `bom_templates`, `estimation_openings`, `tenants`, `current_tenant_id()`, `is_admin_or_owner()`, `has_module_access()`.

- [ ] **Step 1: Write the migration** (exact DDL; header comment states: additive, re-runnable, needs 2026-10-15-01; `2026-10-17-01` is independent; no view selects the parent tables' `*` — re-grep `supabase/migrations` and `supabase/schema.sql` for `openings.*`/`templates.*` and say so):

```sql
-- Inline add-ons (ช่องแสง) on items, piece sets per template. Additive; re-runnable. Needs 2026-10-15-01.
-- Spec 2026-10-12 §4.2/§4.3 as amended by plan 2026-10-15-sliding2-addons.md (AO-9: sets keyed by position; note column).
CREATE TABLE IF NOT EXISTS bom_template_addon_pieces (
  id             UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id      UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  template_id    UUID NOT NULL REFERENCES bom_templates(id) ON DELETE CASCADE,
  mode           TEXT NOT NULL CHECK (mode IN ('merge','attach')),
  kind           TEXT NOT NULL CHECK (kind IN ('fixed','awning')),
  position       TEXT CHECK (position IS NULL OR position IN ('top','bottom','left','right')),
  piece_key      TEXT NOT NULL CHECK (piece_key IN ('ext','divider','main_facing','ao_frame_side','ao_bead','ao_frame_far','frame_top','frame_bottom','frame_side','mullion','rail')),
  profile_family TEXT,
  ref_input      TEXT NOT NULL CHECK (ref_input IN ('w','h','len','mw','mh','tw','th')),
  length_factor  NUMERIC NOT NULL DEFAULT 1 CHECK (length_factor > 0),
  deduction_mm   NUMERIC NOT NULL DEFAULT 0 CHECK (deduction_mm >= 0),
  qty_rule       TEXT NOT NULL DEFAULT 'fixed' CHECK (qty_rule IN ('fixed','cols-1','rows-1','cols','rows','rows*cols')),
  qty_fixed      INT NOT NULL DEFAULT 1 CHECK (qty_fixed >= 0 AND qty_fixed <= 1000),
  thickness_role TEXT CHECK (thickness_role IS NULL OR thickness_role IN ('sash')),
  note           TEXT CHECK (note IS NULL OR char_length(note) <= 120),
  sort_order     INT NOT NULL DEFAULT 0,
  -- merge sets are per position; attach sets are position-free
  CHECK ((mode = 'merge' AND position IS NOT NULL) OR (mode = 'attach' AND position IS NULL)),
  CHECK ((mode = 'merge' AND piece_key NOT IN ('frame_top','frame_bottom','frame_side'))
      OR (mode = 'attach' AND piece_key IN ('frame_top','frame_bottom','frame_side','mullion','rail'))),
  CHECK (mode = 'merge' OR ref_input IN ('w','h'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_bom_template_addon_pieces_set
  ON bom_template_addon_pieces (template_id, mode, kind, COALESCE(position, ''), piece_key);

CREATE TABLE IF NOT EXISTS estimation_item_addons (
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
CREATE INDEX IF NOT EXISTS idx_bom_template_addon_pieces_template_id ON bom_template_addon_pieces(template_id);
CREATE INDEX IF NOT EXISTS idx_estimation_item_addons_opening_id    ON estimation_item_addons(opening_id);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['bom_template_addon_pieces','estimation_item_addons'] LOOP
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%s_tenant_id ON %I(tenant_id)', t, t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = t AND policyname = 'admin_full_access') THEN
      EXECUTE format($p$CREATE POLICY admin_full_access ON %I FOR ALL TO authenticated
        USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation'))
        WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation'))$p$, t);
    END IF;
  END LOOP;
END $$;
```

- [ ] **Step 2: SQL test** `supabase/tests/item_addons_test.sql` modelled on `bom_part_editor_test.sql` (BEGIN … ROLLBACK; two tenants `__AO TEST A` / `__AO TEST B`, estimation module on for A only; use the same helper pattern that file uses to switch `current_tenant_id()`; every assertion `RAISE EXCEPTION` on failure). Cases, each as its own block:
  1. good merge row (`position 'top'`, `piece_key 'ext'`, `ref_input 'th'`) inserts; good attach row (`position NULL`, `frame_top`, `w`) inserts.
  2. rejects: merge with `position NULL`; attach with `position 'top'`; attach `piece_key 'ext'`; merge `piece_key 'frame_side'`; attach `ref_input 'tw'`; `qty_fixed -1`; `length_factor 0`; `note` of 121 chars; duplicate (template, mode, kind, position, piece_key); duplicate attach (position NULL twice, same key) — the COALESCE index must catch it.
  3. item add-on rejects: `rows 7`, `cols 13`, `len_m 0`, `len_m 21`, `offset_m -1`, `position 'middle'`.
  4. cascade: delete template → pieces gone; delete opening → add-ons gone.
  5. RLS: as tenant B, A's rows invisible and insert into A refused; a tenant without the module sees none; re-running the migration file's DO block twice does not fail (policy guard).
- [ ] **Step 3: Dry-run script** `.superpowers/sdd/2026-10-15-sliding2-addons/run-addons-tests.sh` = copy of `run-layouts-tests.sh` with: migration file `2026-10-18-01-item-addons.sql`, test file `item_addons_test.sql`, PASSED text `ADDONS TESTS PASSED`, tenant prefix `__AO TEST%`, persistence check `select (select count(*) from information_schema.tables where table_name='estimation_item_addons') as applied, …`. `chmod +x`. Static self-review only (no SQL executed by agents).
- [ ] **Step 4: Commit** `feat(sql): item add-ons and template add-on piece sets`

### Task 2: Add-on model (pure)

**Files:**
- Create: `src/lib/addonModel.js`, `src/lib/addonModel.test.js`

**Interfaces (produces; Tasks 3–8 import these names exactly):**
```js
export const ADDON_MODES = ['merge', 'attach']
export const ADDON_KINDS = ['fixed', 'awning']
export const ADDON_POSITIONS = ['top', 'bottom', 'left', 'right']
export const ADDON_MODE_LABEL = { merge: 'ร่วมวงกบ', attach: 'แยกวงกบ' }
export const ADDON_KIND_LABEL = { fixed: 'ติดตาย', awning: 'กระทุ้ง' }
export const ADDON_POSITION_LABEL = { top: 'บน', bottom: 'ล่าง', left: 'ซ้าย', right: 'ขวา' }
export const MAX_ADDONS = 6, MAX_ROWS = 6, MAX_COLS = 12, MAX_LEN_MM = 20000
export const PIECE_KEYS = { merge: ['ext','divider','main_facing','ao_frame_side','ao_bead','ao_frame_far','mullion','rail'], attach: ['frame_top','frame_bottom','frame_side','mullion','rail'] }
export const PIECE_LABEL = { ext: 'เฟรมบานหลักข้างช่องแสง (ยาวขึ้น/เปลี่ยน profile)', divider: 'คานกั้น', main_facing: 'เฟรมบานหลักด้านที่ติดช่องแสง (หมายเหตุ/เปลี่ยน profile)', ao_frame_side: 'เฟรมข้างช่องแสง (แปะทับ)', ao_bead: 'คิ้วเท', ao_frame_far: 'เฟรมด้านไกลของช่องแสง', frame_top: 'เฟรมบน', frame_bottom: 'เฟรมล่าง', frame_side: 'เฟรมข้าง', mullion: 'ซอยกลางตั้ง', rail: 'ซอยกลางนอน' }
export const REF_INPUTS = { merge: ['w','h','len','mw','mh','tw','th'], attach: ['w','h'] }
export const QTY_RULES = ['fixed','cols-1','rows-1','cols','rows','rows*cols']
export function newAddon({ mode = 'merge', kind = 'fixed', position = 'top', mainWidthMm, mainHeightMm }) // → { mode, kind, position, len_mm, thick_mm: 400, offset_mm: 0, rows: 1, cols: 3 }; len_mm = main edge length on that side
export function addonDims(a) // → { w, h }: top/bottom w = len_mm, h = thick_mm; left/right w = thick_mm, h = len_mm
export function layoutAddons({ widthMm, heightMm, addons }) // → { rects: [{ main: true, x: 0, y: 0, w, h }, { i, x, y, w, h }...], envelope: { x0, y0, w, h } } stacking outward per side in list order (top/left negative)
export function refValue(a, ref, main) // mm: w/h from addonDims; len = len_mm; mw/mh = main.widthMm/heightMm; tw/th = main + this add-on only (tw = mw + thick for left/right, th = mh + thick for top/bottom)
export function extRef(position) // 'th' for top/bottom, 'tw' for left/right
export function setKey(mode, kind, position) // `${mode}|${kind}|${mode === 'merge' ? position : ''}`
export function defaultAddonPieces({ mode, kind, position, layoutKind = 'sliding_2', buttMm = 0 }) // → rows (below)
export function pieceQty(row, a) // number from qty_rule/qty_fixed and a.rows/a.cols (cols-1 at cols 1 → 0)
export function validateAddons(addons, main) // → first Thai problem string | null; never mutates
export function validatePieceRows(rows) // → first Thai problem | null (unknown key for mode, ref not allowed for mode, factor ≤ 0, deduction < 0, qty_fixed < 0 or > 1000, note > 120)
```
`defaultAddonPieces` rows have the migration's column names (`piece_key, profile_family: null, ref_input, length_factor: 1, deduction_mm, qty_rule, qty_fixed, thickness_role: null, note: null, sort_order`) plus `mode, kind, position` (`position` null for attach):
- attach (any kind, any `layoutKind`): `frame_top` ref w ded 2·butt qty 1 · `frame_bottom` ref w ded 2·butt qty 1 · `frame_side` ref h ded 0 qty 2 · `mullion` ref h ded 2·butt qty `cols-1` · `rail` ref w ded 2·butt qty `rows-1`.
- merge, `layoutKind === 'sliding_2'`, position top: `ext` ref th ded 0 qty 2 (family null; the owner sets กล่องร่องวิ่งยาว) · `divider` ref len ded 2·butt qty **0** · `main_facing` ref len qty 0 note `'ตบเรียบ (รองคิ้วเท)'` · `ao_frame_side` ref h ded 0 qty 2 · `ao_bead` ref len ded 2·butt qty 1 · `ao_frame_far` ref len ded 2·butt qty 1 · `mullion` ref h ded 2·butt qty `cols-1` · `rail` ref len ded 2·butt qty `rows-1`.
- merge sliding_2 bottom: same as top but `main_facing` note `'ตบร่อง'` and `ao_bead` qty 0.
- merge left/right (sliding_2) and merge for any other `layoutKind` (all positions): `ext` ref `extRef(position)` ded 0 qty 2 · `divider` ref len ded 2·butt qty 1 · `main_facing` qty 0 note null · `ao_frame_side` qty 0 · `ao_bead` qty 0 · `ao_frame_far` qty 0 · `mullion` ref h ded 2·butt qty `cols-1` · `rail` ref w ded 2·butt qty `rows-1` (mullions are always vertical and read `h`, rails always horizontal and read `w`, in every mode and position; `w`/`h` are the add-on's own dims from `addonDims`).
`sort_order` = index in the lists above.

- [ ] **Step 1: Failing tests** (main 1800 × 1200 unless stated). `newAddon` top → len 1800, thick 400, rows 1, cols 3; left → len 1200. `addonDims` swaps for left/right. `layoutAddons`: top 400 → rect y −400, envelope 1800 × 1600; second top 300 → y −700, envelope h 1900; bottom → y 1200; left 400 → x −400, envelope w 2200; empty list → envelope = main. `refValue` top add-on: w 1800, h 400, len 1800, mw 1800, mh 1200, tw 1800, th 1600; right add-on thick 500: tw 2300, th 1200. `extRef`. `setKey('attach','fixed','top') === 'attach|fixed|'`. `defaultAddonPieces` attach with butt 38.1: frame_top ded 76.2, frame_side ded 0 qty 2, mullion `cols-1`, rail `rows-1`, no ext/divider, every `position` null; merge sliding_2 top: ext ref th, divider qty 0, main_facing note 'ตบเรียบ (รองคิ้วเท)', ao_bead qty 1, ao_frame_side qty 2 ref h; bottom: ao_bead qty 0, note 'ตบร่อง'; left: ext ref tw, divider qty 1, ao_* qty 0; `layoutKind 'fixed_grid'` top: spec defaults (divider 1, ao_* 0). `pieceQty`: fixed → qty_fixed; cols-1 at cols 1 → 0; rows*cols 2×3 → 6. `validateAddons`: 7 add-ons, rows 0, cols 13, rows 1.5, len 0, len NaN, len '400' (string → rejected: callers coerce first), offset −1, unknown position/mode/kind → non-empty Thai; defaults accepted; `Object.freeze` inputs not mutated. `validatePieceRows`: attach row with ref 'tw' rejected; merge row key 'frame_top' rejected; note 121 chars rejected; good defaults accepted.
- [ ] **Step 2: Run tests, see them fail** (`npx vitest run src/lib/addonModel.test.js`).
- [ ] **Step 3: Implement** (pure, no imports except nothing; each function < 40 lines).
- [ ] **Step 4: Tests pass; full suite** (`npx vitest run`). Commit `feat: add-on model (layout, dims, piece-set defaults, validation)`.

### Task 3: Engine — fixed lengths, position overrides, add-on expansion (Opus 5.5)

**Files:**
- Modify: `src/lib/bomEngine.js` (`computeBomForOpening` component loop, ~line 72), `src/lib/bomEngine.test.js` (extend)
- Modify: `src/lib/partExpand.js` (`expandParts` + `makeCtx`), `src/lib/partExpand.test.js` (extend)
- Create: `src/lib/addonExpand.js`, `src/lib/addonExpand.test.js`

**Interfaces:**
- `bomEngine`: a component may carry `fixed_length_mm` (finite number ≥ 0). Then `length_m = (fixed_length_mm / 1000) * factorOf(c.length_factor) - endOf(c.end_deduction_mm) / 1000` instead of `computeComponentLength`. Absent → unchanged.
- `expandParts({ model, buttOf, widthOf, overrides })`, `overrides = { [positionKey]: { lengthMm?: number, family?: string } }` (optional). `family` replaces `lineFamily(model, key, 0)` for that position **everywhere** in the expansion (the line's own components and every `b(role)`/`famOf` lookup that reads that position's line 0, AO-10); `lengthMm` sets `fixed_length_mm` on every component produced from that position's line 0 (lines ≥ 1 unchanged). Absent/`{}` ⇒ byte-identical output (deep-equal test on three existing models). Also a `sideButt = { top?, bottom?, left?, right? }` override: when present, the AUTO `b('frame_top')` / `b('frame_bottom')` / `b('frame_side')` lookup returns that mm instead of the frame member's butt (AO-2; left/right both map to `frame_side` — use the given value for both sides of the `frame_sides` sum only when both are set, else `b(frame_side) + sideButt.left ?? b(frame_side)` … keep it simple: `frame_sides = (sideButt.left ?? b) + (sideButt.right ?? b)`, `frame_top_bottom = (sideButt.top ?? bTop) + (sideButt.bottom ?? bBottom)`).
- `expandAddons({ addons, pieceRows, main: { widthMm, heightMm }, buttOf, layoutKind }) → { attach: [{ addonIndex, opening: { width_m, height_m, panel_count }, components }], merge: { overrides, sideButt, components, notes: [{ addonIndex, position, text }] }, glass: [{ addonIndex, count, widthMm, heightMm }], issues: [{ role_name, reason, addonIndex }] }`. `pieceRows` = all rows of the template (any mode/kind/position); the set for an add-on is `rows.filter(setKey match)`, and when **no row** exists for that set the defaults from `defaultAddonPieces` are used (so a template saved without touching add-ons still expands; profiles null ⇒ `no_profile_family` issues per piece with qty > 0). Reason codes: `no_profile_family`, `no_butt_distance`, `addon_out_of_range` (offset + len > main edge, or thick ≤ 0), `addon_piece_too_small` (length ≤ 0 after deductions → component dropped). `expandAddons(null)` / empty addons ⇒ `{ attach: [], merge: { overrides: {}, sideButt: {}, components: [], notes: [] }, glass: [], issues: [] }`.
- Component shape produced (both modes): `{ role_name, profile_family, length_rule_type: 'width', length_deduction_mm: 0, length_factor, end_deduction_mm: 0, fixed_length_mm, quantity_basis: 'fixed', quantity_value, thickness_role, sort_order, cut_style: 'square', addon_index }` where `fixed_length_mm = max(0, refValue × 1 − deduction_mm)` (factor applied by the engine). `role_name` = `${PIECE_LABEL[key]} (ช่องแสง ${addonIndex + 1})` + (note ? ` [${note}]` : ''). Attach components use `fixed_length_mm` too (uniform; the synthetic opening still carries w/h for labour/perimeter).
- Merge semantics per piece: `ext` → `overrides[extPosition] = { lengthMm: refValue(th|tw) × factor − deduction, family: profile_family || undefined }` where `extPosition` = the layout's `roles.frame_side` for top/bottom, `roles.frame_top` **and** `roles.frame_bottom` for left/right (two overrides); two add-ons on the same axis stack: `lengthMm` = main + sum of thick of all add-ons on both ends of that axis (compute from `layoutAddons(...).envelope`). `main_facing` → no component; `family` override of the facing position (`roles.frame_top` for top …; left/right → `roles.frame_side` is shared by both sides: apply the family override only if both left and right add-ons agree or only one exists; else issue `addon_conflict`), `notes.push({ addonIndex, position, text: note })` when note set. `divider` with qty > 0 → component (ref len) and `sideButt[position] = buttOf(divider family)` (AO-2). `ao_frame_side`, `ao_bead`, `ao_frame_far`, `mullion`, `rail` → components when qty > 0.
- Glass: per add-on `count = rows × cols`, `widthMm = (w − 2·b)/cols`, `heightMm = (h − 2·b)/rows` with b = butt of the add-on's own frame (attach `frame_side`; merge `ao_frame_side` if qty > 0 else `ext` family's butt else 0), clamped ≥ 0.

- [ ] **Step 1: Failing tests, bomEngine:** component `{ fixed_length_mm: 1723.8, length_factor: 1, end_deduction_mm: 0, quantity_value: 1, length_rule_type: 'width' }` on a 1.8 × 1.2 opening prices length 1.7238 m; `fixed_length_mm` with factor 0.5 and end ded 10 → 0.8519; absent field → existing path (reuse one existing expectation).
- [ ] **Step 2: Failing tests, partExpand overrides:** for a sliding_2 model with families set and butt 38.1 everywhere: `overrides: { frame_side: { lengthMm: 1600 } }` ⇒ the frame_side component has `fixed_length_mm 1600`, other components identical; `overrides: { frame_side: { family: 'กล่องร่องวิ่งยาว' } }` with `buttOf('กล่องร่องวิ่งยาว') = 50` ⇒ frame_side family replaced **and** sash width deduction = 2 × 50; `sideButt: { top: 25 }` with frame_top butt 38.1, bottom 35.8 ⇒ stile deduction 25 + 35.8 = 60.8; no overrides ⇒ deep-equal to the call without the argument (three models: sliding_2, sliding_n n=3, swing_door leaves 2).
- [ ] **Step 3: Failing tests, addonExpand** (main 1800 × 1200, butt 38.1 for every family unless stated; rows from `defaultAddonPieces` with families filled in):
  - attach top 1800 × 400, 1 × 3: frame_top/bottom `fixed_length_mm` 1723.8 qty 1 each, frame_side 400 qty 2, mullion 323.8 qty 2, no rail component; opening `{ width_m: 1.8, height_m: 0.4, panel_count: 3 }`; glass 3 × (574.6 × 323.8) → compute: (1800 − 76.2)/3 = 574.6, (400 − 76.2)/1 = 323.8.
  - attach right thick 500 len 1200, 2 × 2: mullion 1123.8 qty 1, rail 423.8 qty 1, glass 4 × (211.9 × 561.9).
  - merge sliding_2 top 1800 × 400, 1 × 3, ext family 'กล่องร่องวิ่งยาว' (butt 50): `overrides.frame_side = { lengthMm: 1600, family: 'กล่องร่องวิ่งยาว' }`; no divider component; `overrides.frame_top = { family: undefined }` not present (main_facing family null) but `notes[0].text === 'ตบเรียบ (รองคิ้วเท)'`; ao_frame_side 400 qty 2; ao_bead 1723.8 qty 1; ao_frame_far 1723.8 qty 1; mullion 323.8 qty 2; `sideButt` empty.
  - merge sliding_2 bottom: no bead component, note 'ตบร่อง'.
  - merge left (spec path) thick 400 len 1200 divider butt 25: `overrides.frame_top = overrides.frame_bottom = { lengthMm: 2200 }`, divider component 1123.8 qty 1, `sideButt.left === 25`.
  - two top add-ons 400 + 300 ⇒ `overrides.frame_side.lengthMm === 1900`; top + bottom ⇒ 1200 + 400 + 400 = 2000; top + left ⇒ both frame_side and frame_top/bottom overrides.
  - issues: family null on a qty > 0 piece ⇒ `no_profile_family` with `addonIndex`, no component; `buttOf` null ⇒ `no_butt_distance`, deduction counted 0; offset 1500 + len 1800 ⇒ `addon_out_of_range` (still expanded); thick 50 with ded 76.2 on a vertical piece ⇒ `addon_piece_too_small`, component dropped; `expandAddons(null)` ⇒ empty shape; frozen inputs not mutated.
  - no rows for the set ⇒ defaults used (families null ⇒ issues, counts equal the default set).
- [ ] **Step 4: Implement** (functions < 60 lines; `addonExpand.js` imports only `addonModel.js` and `layoutRegistry.js` `rolesOf`/`LAYOUTS`). Run the three test files, then the full suite.
- [ ] **Step 5: Commit** `feat: add-on expansion, part overrides and fixed-length components`

### Task 4: Persistence and hooks

**Files:**
- Create: `src/lib/addonSave.js`, `src/lib/addonSave.test.js`, `src/hooks/useTemplateAddonPieces.js`, `src/hooks/useItemAddons.js`
- Reference: `src/lib/partSave.js` (`saveModel` delete-then-insert pattern and error handling), `src/hooks/useBomPartModel.js` (module gate, `loading=false` on error)

**Interfaces:**
```js
export const PIECE_COLUMNS = ['mode','kind','position','piece_key','profile_family','ref_input','length_factor','deduction_mm','qty_rule','qty_fixed','thickness_role','note','sort_order']
export function pieceRowsToSets(rows)         // → { [setKey]: rows sorted by sort_order } (strips id/tenant/template)
export function pieceSetsToRows(sets, templateId) // → rows with template_id, whitelisted columns, numbers coerced, attach position forced null
export async function saveAddonPieces({ supabase, templateId, rows }) // validatePieceRows first (throw Error(thai) with zero calls) → delete where template_id → insert (chunks of 200); throws on first error
export async function loadAddonPieces({ supabase, templateIds }) // → { [templateId]: rows[] } ; [] for ids without rows
export function itemAddonsFromRows(rows)      // → addons in mm, sorted by sort_order: { id, mode, kind, position, len_mm, thick_mm, offset_mm, rows, cols }
export function itemAddonsToRows(addons, openingId) // mm → m (÷1000, 6 dp), sort_order = index, whitelisted columns
export async function saveItemAddons({ supabase, openingId, addons, main }) // validateAddons(addons, main) first (zero calls on error) → delete → insert
export async function loadItemAddons({ supabase, openingIds }) // → { [openingId]: addons[] }
// hooks
useTemplateAddonPieces(templates) → { addonPiecesByTemplate, loading, error }   // fetch only templates with layout_kind; module-gated like useBomPartModel; {} when none
useItemAddons(openingIds) → { itemAddonsByOpening, loading, error, refetch }
```
- [ ] **Step 1: Failing tests** (fake supabase recording `from().delete().eq()` / `insert()` calls, as in `partSave.test.js`): round trip sets ↔ rows equal and unknown columns dropped; attach rows get `position: null` even if given; `saveAddonPieces` order delete → insert; validation error ⇒ zero calls; injected insert error ⇒ thrown, no further calls; `itemAddonsToRows` 400 mm → 0.4, 1723.8 mm → 1.7238; `itemAddonsFromRows` strings '0.4' → 400; `saveItemAddons` with 7 add-ons ⇒ zero calls and Thai message; `loadItemAddons` groups by opening and returns `[]` for ids with no rows; hook: no fetch without templates with `layout_kind`; a failing fetch sets `error` and `loading=false` (renderHook or a small harness as `useBomPartModel` tests do).
- [ ] **Step 2–3:** implement; full suite. Commit `feat: add-on persistence and hooks`.

### Task 5: Costing integration (Opus 5.5)

**Files:**
- Modify: `src/lib/openingCost.js` (`costOpening`, `prepareComponents`, `partPreviewCtx`), `src/lib/openingCost.test.js`, `src/lib/reasonText.js` (+ its test), `src/pages/Estimation.jsx` (ctx wiring), `src/pages/estimation/ProviderCompare.jsx` (pass both maps), `src/lib/projectBom.js` only if it enumerates `addonBom`
- Reference: `buildEngineAddonOpening` in `openingCost.js` (infill logic to reuse), `combineOpeningBoms`

**Interfaces:**
- `costOpening(ctx)` gains optional `ctx.addonPiecesByTemplate` (`{ [templateId]: rows[] }`), `ctx.itemAddonsByOpening` (`{ [openingId]: addons[] }`), `ctx.addonPiecesError`, `ctx.itemAddonsError` (string|null). Result gains `addonBoms: [{ addonIndex, bom }]` (attach units), `addonMerge: { components, notes, glass: { area_sqm, cost, panes } }`, and `totalCost` of `combined` includes attach units and merge glass; issues from add-ons carry `source: 'addon'`.
- Behaviour: `addons = ctx.itemAddonsByOpening?.[item.id] || []`. If `item.addon_template_id` is set and `addons.length > 0` ⇒ legacy path only + issue `addon_conflict`. If `addons.length > 0` and `template.layout_kind`: `expandAddons({ addons, pieceRows: ctx.addonPiecesByTemplate?.[template.id] || [], main: { widthMm: item.width_m*1000, heightMm: item.height_m*1000 }, buttOf, layoutKind: template.layout_kind })`; pass `overrides`/`sideButt` into `prepareComponents` → `preparePartComponents` → `expandParts`; append `merge.components` (through `applyRoleThickness`) to the main components before `computeBomForOpening`; merge glass: `area = Σ count × w × h / 1e6`, `cost = area × infillType.price_per_sqm` (0 and an issue `no_infill` … no: when the item has no infill type, area is listed with cost 0 and no new issue — same as the main unit); each attach unit: `computeBomForOpening({ ...main.opening, width_m, height_m, panel_count, hardware_set_id: null, extra_lines: [] }, template, attachComponents, [], pricing, main.infillType)`. `combined.totalCost = bom.totalCost + Σ attach + mergeGlass.cost` (legacy `addonBom` term unchanged). If `ctx.addonPiecesError || ctx.itemAddonsError` and `template.layout_kind` ⇒ issue `addon_not_loaded` once per item and no add-on costing. Template without `layout_kind` but with add-ons ⇒ issue `addon_needs_layout`, no add-on costing.
- `partPreviewCtx(ctx, template, resolved, item)` returns also `addons` and the `overrides` so the item preview draws the same thing (Task 8 uses it).
- `reasonText` new codes with Thai: `addon_conflict` 'มีชุดต่อเติมแบบเดิมอยู่แล้ว ลบหรือแปลงก่อนจึงใช้ช่องแสงแบบใหม่', `addon_not_loaded` 'โหลดข้อมูลช่องแสงไม่สำเร็จ ยังไม่ได้คิดราคาช่องแสง', `addon_needs_layout` 'template นี้ไม่ได้ใช้ part editor จึงใส่ช่องแสงไม่ได้', `addon_out_of_range` 'ช่องแสงยาวหรือเยื้องเกินขอบบานหลัก', `addon_piece_too_small` 'ชิ้นส่วนช่องแสงสั้นกว่าระยะหัก'.

- [ ] **Step 1: Failing tests:** (a) parity: an existing `costOpening` case with its absolute total still passes with `ctx` lacking the new keys, and with `itemAddonsByOpening: {}`; the legacy add-on case unchanged; (b) attach add-on on a sliding_2 part-editor item: `addonBoms.length === 1`, its `profileLines` have 4 lines (frame top/bottom/side ×2 grouped as the expander emits, mullion), `combined.totalCost` = main + unit; (c) merge sliding_2 top add-on with ext family: the main `profileLines` entry for เฟรมข้าง has `length_m` 1.6 and family 'กล่องร่องวิ่งยาว', notes contain 'ตบเรียบ', `addonMerge.glass.panes === 3`; (d) legacy + new ⇒ legacy total, issue `addon_conflict`; (e) `itemAddonsError: 'x'` ⇒ `addon_not_loaded`, total = plain; (f) template without `layout_kind` + add-ons ⇒ `addon_needs_layout`; (g) `reasonText` returns Thai for the five codes; (h) grep test: every `costOpening(`/`costItems(` caller in `src/pages` passes a ctx built from the same `base` object that has `addonPiecesByTemplate` (assert by reading `Estimation.jsx` source for both keys, as earlier tests did for `partModelByTemplate`).
- [ ] **Step 2–3:** implement; `Estimation.jsx`: call `useTemplateAddonPieces(templates)` and `useItemAddons(openingIds)` next to `useBomPartModel`, put the four keys into `base`; never block render on their loading (errors set state, costs still show). Full suite + `npm run build`. Commit `feat: cost inline add-ons (attach units, merge pieces, frame overrides)`.

### Task 6: Template UI — add-on box, zoom editor, piece table (mockup v12)

**Files:**
- Create: `src/pages/bomTemplates/addon/AddonBox.jsx`, `AddonZoom.jsx`, `AddonPieceTable.jsx`, `AddonEffects.jsx`, `addonView.js`, `addonView.test.js`, `AddonBox.smoke.test.jsx`
- Modify: `src/pages/bomTemplates/PartEditor.jsx` (mount `AddonBox` under the width/height bar; new props `addonSets`, `onAddonSetsChange`, `previewAddons`, `onPreviewAddonsChange`), `src/pages/bomTemplates/PartPreview.jsx` (draw `previewAddons` rects around the unchanged overview markup; click selects an add-on), `src/pages/BomTemplates.jsx` (load piece rows with the model via `loadAddonPieces`, save with `saveAddonPieces` after `saveModel`, keep file < 700 lines: move the load/save glue into `src/pages/bomTemplates/addon/addonTemplateGlue.js`)
- Reference: mockup v12 (read it with the Artifact tool before coding), `PartSidePanel.jsx` (field style), `partEditorView.js`

**Behaviour:** the editor keeps **preview add-ons** (UI state only, not saved: list of `newAddon`s the owner adds to see the effect) and **piece sets** (saved per template: `{ [setKey]: rows }`). The add-on box lists preview add-ons (mode / kind / position / len / thick / offset / rows / cols; "เสร็จแล้ว ▲" collapse to a one-line summary; delete). Clicking an add-on in the overview opens the zoom card: `addonView.zoomPieces({ addon, rows, scale })` → rectangles per piece key present with qty > 0 (attach: own frame + grid; merge: ext stubs, facing member, overlay sides, bead, far frame, divider if qty > 0, grid); clicking a piece selects its row in the side panel: profile family (`catalogFamilies(index)` as `PartSidePanel` does), ref input (allowed list per mode), factor, deduction, qty rule + fixed qty, note (text, 120 max), thickness role; the table below lists every row of the set with `fixed_length_mm` × qty from `expandAddons` (numbers only from the lib) and the unresolved Thai text when the family is missing; `AddonEffects` lists `merge.overrides` (position name → new length / family) and `notes`. A set that has no saved rows shows the defaults (`defaultAddonPieces`) and is written on save only if the owner edited it ("แก้แล้ว" flag per set) — unsaved sets keep using defaults at cost time (Task 3).

- [ ] **Step 1: Pure tests** `addonView.test.js`: for each position × mode with rows 1–3 × cols 1–4, the piece rectangles lie inside the add-on rect, no two overlap (pairwise), every key with qty > 0 appears once; merge with ext qty 2 shows two stubs along the main; attach has four frame pieces.
- [ ] **Step 2: Smoke tests** (`renderToString`, mock supabase as `PartEditor.smoke.test.jsx` does): box renders empty state 'ยังไม่มีช่องแสง'; with one add-on shows the summary line and Thai labels, no `NaN`/`undefined`; collapsed state hides inputs; zoom renders the table header 'ความยาว × ท่อน (มม.)' and the unresolved text when families are null; **golden**: the part editor's render string for a sliding_2 model with no preview add-ons and no sets is identical to the pre-change render (capture the golden string in the test from the current commit before editing: write the test first, commit the fixture, then edit).
- [ ] **Step 3: Implement**; `npm run build`; controller takes screenshots on the dev server (owner's login may be missing: then say so, do not block). Full suite. Commit `feat: add-on box, zoom editor and piece sets in the part editor`.

### Task 7: Item form — several add-ons (gate: item-form mockup)

> **Gate:** before coding, publish a mockup artifact of the item form add-on list (fields mode/kind/position/len/thick/offset/rows/cols, legacy convert button, overall size line, live drawing) derived from mockup v12's box and the current `ItemModal`; the owner comments asynchronously. Implement to the mockup; if comments arrive later, apply them as a follow-up task.

**Files:**
- Create: `src/pages/estimation/ItemAddons.jsx`, `ItemAddons.smoke.test.jsx`
- Modify: `src/pages/estimation/ItemModal.jsx` (mount under the size fields, only when the template has `layout_kind`), `src/pages/estimation/itemForm.js` + `itemForm.test.js` (`addons` field, `validateItemForm` AO-7 rule), `src/pages/estimation/useItemModel.js` (load via `loadItemAddons` for the edited item, save via `saveItemAddons` **after** the opening row is saved, error shown through the existing save-error path), `src/lib/openingPayload.js` + `src/pages/estimation/itemRoundTrip.test.js` (never writes legacy columns for new add-ons), `src/pages/estimation/ItemCostSummary.jsx` (one line per add-on from `addonBoms`/`addonMerge`)

**Interfaces:** form field `addons: Addon[]` (mm, from `addonModel`); `convertLegacyAddon(form) → form` (AO-7: one `attach` add-on, kind fixed, position = `addon_position`, len = `addon_width_m`→mm for top/bottom (height for left/right), thick = the other, offset = `addon_offset_m`, rows 1, cols = `addon_panel_count`; clears `has_addon`, `addon_template_id` and the legacy sizes); `validateItemForm` returns 'มีชุดต่อเติมแบบเดิมอยู่ ให้แปลงหรือลบก่อน' when both exist.

- [ ] **Step 1: Failing tests:** round trip form → payload → form for two add-ons (mm exact); legacy-only item round-trips byte-identically; legacy + new rejected with the Thai message; `convertLegacyAddon` mapping for top and for left; summary shows one line per add-on; save order: opening row saved first, add-ons second, a thrown `saveItemAddons` surfaces the error and leaves the opening row (fake client).
- [ ] **Step 2–3:** implement; full suite; build; screenshots if the dev login works. Commit `feat: inline add-ons on items`.

### Task 8: Drawings, signature, attachments

**Files:**
- Modify: `src/lib/partPreviewSvg.js` (`partSvgString` new optional `addons` + `overrides`), `src/lib/partPreviewSvg.test.js`, `src/lib/itemPreviewSignature.js` (+ test), `src/pages/estimation/PreviewPanel.jsx`, `src/pages/estimation/useItemModel.js` (pass add-ons to the preview), `src/pages/estimation/projectDefaults.js` (`currentPreviewSigs`), `src/lib/attachmentPages.test.js` (one case)

**Interfaces:** `partSvgString({ …, addons = null, overrides = null })`: absent ⇒ identical string (sha256 pin stays); with add-ons: main drawing unchanged in place, merge add-ons inside one outer outline with the facing member drawn, attach add-ons with their own frame, grid lines per rows/cols, overall dimension text `Math.round(envelope.w) × Math.round(envelope.h)`; elements only `svg|rect|line|text|polyline|g`; passes `safeSvgDataUri`. Signature: appends `|ao:` + JSON of the add-on list (sorted keys, numbers) when non-empty; unchanged otherwise.

- [ ] **Step 1: Failing tests:** golden sha256 unchanged without add-ons; with a top merge and a right attach add-on the string passes `safeSvgDataUri` for both views and contains the envelope text '1800 × 1600' / '2300 × 1200' respectively; signature changes with any add-on field and not with an unrelated catalogue value; attachment plan test: an item whose stored `preview_svg_out/in` came from the add-on drawing yields both views.
- [ ] **Step 2–3:** implement; full suite; build. Commit `feat: drawings and attachments with add-ons`.

### Task 9: sliding_2 options — ประตู/หน้าต่าง, เลื่อน 1 ฟิก 1, ธรณีกันบานเลื่อน

**Files:**
- Modify: `src/lib/layouts/sliding_2.js`, `src/lib/partExpand.js` (rule `plus` term), `src/lib/partExpand.test.js`, `src/lib/partModel.test.js` (new cases only; frozen cases untouched), `src/lib/hardwareDefaults.test.js`, `src/lib/layoutRegistry.js` only if `validateLayout` must learn the `plus` field
- Reference: `layouts/swing_door.js` (`enabled` position + boolean input pattern), `layouts/sliding_2_fixed_2.js` (fixed pieces, `isFixedPiece`), formula sheet section `#sliding_1_fixed_1`

**Changes (S-1):**
```js
inputs: [
  { key: 'door', label: 'ประตู / หน้าต่าง', type: 'boolean', default: false, fixed_by_type: true },
  { key: 'one_fixed', label: 'รูปแบบบาน', type: 'select', options: [{ value: 0, label: 'เลื่อนสวน (2 บานเลื่อน)' }, { value: 1, label: 'เลื่อน 1 ฟิก 1' }], default: 0, fixed_by_type: true, estimator: true },
  { key: 'fixed_side', label: 'บานฟิกอยู่', type: 'select', options: [{ value: 'left', label: 'ซ้าย' }, { value: 'right', label: 'ขวา' }], default: 'left', only_when: { one_fixed: 1 }, estimator: true },
],
positions: { …existing unchanged…,
  sill_guard: { part: 'sash', orient: 'h', per: 1, name: 'ธรณีกันบานเลื่อน', enabled: 'one_fixed', corner: 'free',
    rule: { type: 'width_minus', auto: 'frame_sides', factor: 0.5, overlap: 'hook', role: 'sash', family: 'ธรณีกันบานเลื่อน',
            minus: ['hook_stile', 'key_stile'], plusWidth: ['key_stile'] } },
},
order: [...existing, 'sill_guard'],
hardware: [
  { name: 'ลูกล้อ', per: 'unit', qty: '4-2*one_fixed' },
  { name: 'มือจับล็อค (ด้านใน)', per: 'unit', qty: '2-one_fixed' },
  { name: 'กุญแจ/มือจับเรียบ (ด้านนอก)', per: 'unit', qty: 'door*(2-one_fixed)' },
],
```
`rule.minus` = position keys whose line-0 butt distance is subtracted after the factor (free piece: no end records); `rule.plusWidth` = position keys whose line-0 profile **width** is added after the factor. Implement both in `expandParts` as part of `end_deduction_mm` (minus) and a negative `end_deduction_mm` is not allowed by the engine (`endOf` clamps > 0) ⇒ instead fold them into `length_deduction_mm` **after** dividing by the factor: `length_deduction_mm = pre − overlap + (Σ b(minus) − Σ w(plusWidth)) / factor` (with the 0.5 factor: `(b_hook + b_key − w_key) / 0.5`). Missing width ⇒ issue `no_profile_width`. `enabled: 'one_fixed'` with select values 0/1 — confirm `evalExpr` sees numbers (`exprParams` maps select values; if it only maps booleans/numbers, store `one_fixed` as a number select — the options above already use numeric values). Fixed sash: if `partModel.isFixedPiece` can read an expression from the part (`fixed: 'one_fixed'` on the sash part with `fixedSide: 'fixed_side'`), use it so the drawing drops the slide arrow of that sash; otherwise leave the drawing unchanged and write 'drawing shows both arrows for เลื่อน 1 ฟิก 1' in the handover.
- [ ] **Step 1: Failing tests:** default params ⇒ `startModel('sliding_2')` deep-equals the frozen model minus/plus nothing (the frozen suite must stay untouched and green; `sill_guard` absent); `one_fixed: 1` ⇒ `sill_guard` present with one piece; expand with W 1800, b(frame_side) 38.1, o 40 (hook butt), b(hook) 40, b(key) 38.1, w(key) 50: sill length = (1800 − 76.2 + 40) × 0.5 − 40 − 38.1 + 50 = 853.8 → assert the component's effective length via `computeComponentLength` = 0.8538; missing key width ⇒ `no_profile_width`; hardware defaults: default params ⇒ [ลูกล้อ 4, มือจับล็อค 2, กุญแจ 0 → row dropped if the existing helper drops qty 0, else qty 0], `{ door: true, one_fixed: 1 }` ⇒ [2, 1, 1]; the item form shows `fixed_side` only when `one_fixed = 1` (existing `only_when` test pattern in `ItemLayoutInputs.test.jsx`).
- [ ] **Step 2–3:** implement; run the frozen suites (`partModel.test.js`, `partPreviewSvg` sha256, `PartEditor.layouts.test.jsx`) and the full suite. Commit `feat(sliding_2): door/window and one-fixed options with sill guard`.

### Task 10: Handover, formula sheet note, ledger, whole-branch review

**Files:**
- Modify: `docs/handover-aluminium-cost-catalog.md` (new section "Inline add-ons + sliding_2 options (2026-10-15)"), memory `project_aluminium_cost_catalog_brainstorm.md` (+ Obsidian mirror), `MEMORY.md` line

- [ ] **Step 1:** handover section: what was built; SQL order (`run-layouts-tests.sh` → apply 2026-10-17-01 → `run-addons-tests.sh` → apply 2026-10-18-01; one command per message); owner click-through in Thai (open a sliding_2 template, add a top merge add-on in the box, assign กล่องร่องวิ่งยาว to `ext`, see เฟรมข้าง 1600 in the table and the note ตบเรียบ; add an attach add-on; save; open an item, add the same add-ons, check cost lines and the drawing; open a legacy add-on item and press แปลง; set ประตู + เลื่อน 1 ฟิก 1 on the type and see the hardware/sill rows); rulings AO-9…AO-12, S-1; deferred (type picker wizard, reference uploads, clone, awning sash pieces, left/right profile rulings, bead on bottom add-ons).
- [ ] **Step 2:** `npx vitest run`, `npm run build`; record counts in the ledger.
- [ ] **Step 3: Whole-branch review** (Opus 5.5 or the session model) over this plan's commits: parity paths (no add-ons, legacy add-on, sliding_2 defaults), expansion numbers against this plan by hand, migration column names vs code (`grep` every `PIECE_COLUMNS` name in the SQL), RLS/module gate, Review Focus 1–5; ONE fix dispatch, one scoped re-review.
- [ ] **Step 4:** final message to the owner (Thai): what to run (SQL, one per message), what to click, open questions still parked as defaults, reminder nothing is merged/pushed.
