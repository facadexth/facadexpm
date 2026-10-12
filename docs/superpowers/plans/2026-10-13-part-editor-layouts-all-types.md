# Part-editor layouts for every catalogue type — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the BOM-template part editor, item preview, quotation drawing and costing work for all 13 layout kinds (23 catalogue leaf types) instead of only `sliding_2`, by turning the hard-coded sliding rules into declarative layout definitions.

**Architecture:** `partModel.js` keeps its model shape (`parts`, `lines`, `names`, per-piece `ends`) and gains `params` (layout inputs). Every rule that is a `switch` on a position key today (default target, partner end, default line, automatic deduction, overlap) becomes data read from the layout definition (`src/lib/layouts/*.js`, collected by `layoutRegistry.js`). Counts (`per`, `count`, factors) are small expressions over `params`. `partExpand` compiles exactly as today (`length = (base − pre + overlap) × factor − ends`); grids and mitres are new pre-deduction / end rules, not a new engine. Geometry and SVG port the accepted mockup's drawing functions. The UI gains dynamic part tabs and an inputs panel; the catalogue type form sets `layout_kind` + fixed params.

**Tech Stack:** React 18 + Vite, vitest (`npm test -- --run`), Supabase/Postgres (migrations are files; the owner applies them), pure JS libs under `src/lib`.

**Spec:** `docs/superpowers/specs/2026-10-13-part-editor-layouts-all-types-design.md` (parent: `docs/superpowers/specs/2026-10-12-bom-template-by-type-and-addons-design.md`). Drawing reference: `docs/reference/type-previews-mockup.html` (copied in Task 8 from the accepted artifact v5).

## Global Constraints

- `sliding_2` behaviour is frozen: every existing test in `partModel.test.js`, `partExpand.test.js`, `partGeometry.test.js`, `partPreviewSvg.test.js`, `partSave.test.js` must pass unchanged (the only allowed edit is an import path). Worked example 1800 × 1200 stays 1,723.8 / 1,200 / 824.4 / 1,126.1.
- Length model unchanged: `length = (base − length_deduction_mm) × length_factor − end_deduction_mm`; bases are `width`, `height`, `width_minus`, `height_minus`, `perimeter` (bomEngine). No new rule type in bomEngine.
- Limits: `MAX_PART_COUNT = 10` sashes/leaves; grids `rows ≤ 8`, `cols ≤ 12`; inputs are whole numbers except W/H (mm, integers in the UI).
- Position keys, part keys and layout kinds are ASCII snake_case; display names are Thai and editable (`model.names`).
- Every new pure lib: no I/O, no React, deterministic output (locale-free formatting via `fmtMm`).
- RLS unchanged (the migration adds columns only). No view uses `x.*` on `door_window_types`, `bom_templates`, `estimation_openings` — verify with `grep -n "\.\*" supabase/migrations/*.sql supabase/schema.sql` before writing the migration; if one does, add a `CREATE OR REPLACE VIEW` to the migration.
- Owner decisions D1–D17 and the open rulings R3/R5 are data defaults in the layout files, never conditions in the engine.
- UI tasks follow the accepted mockup v5; no new screens.

## Review Focus

1. A template saved under `sliding_2` before this change loads with `params = {}` and expands to the same rows (`modelFromRows` must default params from the layout, not fail) — pinned in Task 2.
2. `cols = 1` / `rows = 1` grids: zero mullions/transoms, no `per = 0` crash, transom segments = 0 — pinned in Task 4.
3. `nL = 0, nR = 0` folding door and `leaves = 1` doors: counts never go below the layout minimum; the editor shows a hint instead of an empty model — pinned in Task 6.
4. Unknown or mismatched `layout_kind` (type says `awning_grid`, template rows say `sliding_2`): load refuses with `layout_mismatch`, never silently re-maps — pinned in Task 9.
5. Curtain-wall `cells` with keys outside `rows × cols` after the estimator shrinks the grid: dropped on expand, not crashing — pinned in Task 7.
6. Mitred positions never receive an end deduction even when a stale `ends[].mode = 'butt'` is stored — pinned in Task 3.

---

### Task 1: Migration and SQL test

**Files:**
- Create: `supabase/migrations/2026-10-17-01-layouts-all-types.sql`
- Create: `supabase/tests/layouts_all_types_test.sql`
- Create: `.superpowers/sdd/2026-10-13-part-editor-layouts-all-types/run-layouts-tests.sh` (owner runs it; same shape as `run-part-editor-tests.sh`)

**Interfaces:**
- Produces: `door_window_types.layout_params JSONB NOT NULL DEFAULT '{}'`, `bom_templates.layout_params JSONB NOT NULL DEFAULT '{}'`, `estimation_openings.layout_params JSONB NOT NULL DEFAULT '{}'`, `door_window_types.layout_kind` CHECK list = the 13 kinds.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/2026-10-17-01-layouts-all-types.sql
-- Part-editor layouts for every catalogue type (spec 2026-10-13). Additive; idempotent where Postgres allows.
ALTER TABLE door_window_types ADD COLUMN IF NOT EXISTS layout_kind TEXT;
ALTER TABLE door_window_types DROP CONSTRAINT IF EXISTS door_window_types_layout_kind_check;
ALTER TABLE door_window_types ADD CONSTRAINT door_window_types_layout_kind_check CHECK (layout_kind IS NULL OR layout_kind IN (
  'sliding_2','sliding_n','sliding_3track','sliding_2_fixed_2','fixed_grid','awning_grid','casement_n',
  'swing_door','frameless_door','hanging_door','folding_door','curtain_wall','frameless_wall'));
ALTER TABLE door_window_types   ADD COLUMN IF NOT EXISTS layout_params JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE bom_templates       ADD COLUMN IF NOT EXISTS layout_params JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE estimation_openings ADD COLUMN IF NOT EXISTS layout_params JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE door_window_types   ADD CONSTRAINT door_window_types_layout_params_obj   CHECK (jsonb_typeof(layout_params) = 'object');
ALTER TABLE bom_templates       ADD CONSTRAINT bom_templates_layout_params_obj       CHECK (jsonb_typeof(layout_params) = 'object');
ALTER TABLE estimation_openings ADD CONSTRAINT estimation_openings_layout_params_obj CHECK (jsonb_typeof(layout_params) = 'object');
```

If the parent plan's migration `2026-10-16-01` (which first adds `layout_kind` with a one-kind CHECK) has already been applied, the `DROP CONSTRAINT IF EXISTS` line replaces its CHECK; if not, this file creates the column. Either order works — state this in the file header.

- [ ] **Step 2: Write the SQL test** (rolled back; same harness as `supabase/tests/bom_part_editor_test.sql`): insert a type with `layout_kind = 'awning_grid'`, `layout_params = '{"rows":2,"cols":2}'`; assert a `layout_kind = 'bogus'` insert raises `check_violation`; assert `layout_params = '[]'` raises; assert the three columns exist via `information_schema.columns`; `RAISE NOTICE 'PASSED'`; end with `ROLLBACK`.

- [ ] **Step 3: Write the runner script** (copies the part-editor runner: `npx supabase db query -f` the test, greps PASSED, exit 1 otherwise; prints the apply command for the owner).

- [ ] **Step 4: Run the grep for `x.*` views** named in Global Constraints; record the result in the ledger.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/2026-10-17-01-layouts-all-types.sql supabase/tests/layouts_all_types_test.sql .superpowers/sdd/2026-10-13-part-editor-layouts-all-types/run-layouts-tests.sh
git commit -m "feat(estimation): migration for part-editor layouts of every type (layout_kind kinds, layout_params)"
```

---

### Task 2: Declarative layout schema in `partModel` (sliding_2 frozen)

**Files:**
- Create: `src/lib/layoutExpr.js`, `src/lib/layoutExpr.test.js`
- Create: `src/lib/layouts/sliding_2.js`
- Create: `src/lib/layoutRegistry.js`, `src/lib/layoutRegistry.test.js`
- Modify: `src/lib/partModel.js` (replace the hard-coded `LAYOUTS`, `defaultTarget`, `defaultPair`, `defaultLine`, `partnerEnd` with data-driven versions)
- Modify: `src/lib/partModel.test.js` (add tests; existing tests unchanged)

**Interfaces:**
- Consumes: today's `partModel` API.
- Produces:
  - `evalExpr(expr, params) -> number` (`layoutExpr.js`): `expr` is a number or a string over identifiers in `params`, integers, `+ - * / ( )`; throws `layout_expr` on anything else; integer results for counts (`Math.round`).
  - Layout definition shape (every file under `src/lib/layouts/`):
    ```js
    export default {
      kind: 'sliding_2',
      inputs: [ // ordered; `estimator` = shown on the item form; `fixed_by_type` = value comes from door_window_types.layout_params
        // W/H are implicit (width_m/height_m); only extra inputs are listed
      ],
      parts: [
        { key: 'frame', name: 'วงกบ', count: 1, overlap_mode: 'manual', overlap_mm: 0, corner: 'butt', track: null, fixed: false, glass: false },
        { key: 'sash',  name: 'บานเลื่อน', count: 2, overlap_mode: 'auto_hook', overlap_mm: 0, corner: 'butt', track: 'alternate' },
      ],
      positions: {
        frame_top:    { part: 'frame', orient: 'h', per: 1, name: 'เฟรมบน',   rule: { type: 'width' } },
        frame_bottom: { part: 'frame', orient: 'h', per: 1, name: 'เฟรมล่าง', rule: { type: 'width' } },
        frame_side:   { part: 'frame', orient: 'v', per: 2, name: 'เฟรมข้าง', labels: ['ซ้าย','ขวา'], rule: { type: 'height' } },
        sash_top:     { part: 'sash', orient: 'h', per: 1, name: 'บานเลื่อนบน',  rule: { type: 'width_minus', auto: 'frame_sides', factor: 0.5, overlap: 'hook', role: 'sash' } },
        sash_bottom:  { part: 'sash', orient: 'h', per: 1, name: 'บานเลื่อนล่าง', rule: { type: 'width_minus', auto: 'frame_sides', factor: 0.5, overlap: 'hook', role: 'sash' } },
        key_stile:    { part: 'sash', orient: 'v', per: 1, name: 'เสากุญแจ', rule: { type: 'height_minus', auto: 'frame_top_bottom', role: 'sash' } },
        hook_stile:   { part: 'sash', orient: 'v', per: 1, name: 'เสาเกี่ยว', rule: { type: 'height_minus', auto: 'frame_top_bottom', role: 'sash' } },
      },
      // corners: one entry per horizontal position; v[e] = the vertical position at end e (0 = left, 1 = right);
      // vPiece 'byEnd' = frame-style (piece 0 left / piece 1 right), 'same' = sash-style (same piece index);
      // vEnd = which end of the vertical meets this horizontal (0 top, 1 bottom); through = 'v' | 'h'; mode = 'butt' | 'mitre' | 'tee'
      joints: [
        { h: 'frame_top',    v: ['frame_side','frame_side'], vPiece: 'byEnd', vEnd: 0, through: 'v', mode: 'butt' },
        { h: 'frame_bottom', v: ['frame_side','frame_side'], vPiece: 'byEnd', vEnd: 1, through: 'v', mode: 'butt' },
        { h: 'sash_top',     v: ['hook_stile','key_stile'],  vPiece: 'same',  vEnd: 0, through: 'v', mode: 'butt' },
        { h: 'sash_bottom',  v: ['hook_stile','key_stile'],  vPiece: 'same',  vEnd: 1, through: 'v', mode: 'butt' },
      ],
      order: ['frame_top','frame_bottom','frame_side','sash_top','sash_bottom','key_stile','hook_stile'],
      hardware: [ { name: 'ลูกล้อ', per: 'sash', qty: 2 }, { name: 'กุญแจ/มือจับ', per: 'unit', qty: 1 } ],
      symbol: { sash: 'slide' },
    }
    ```
    `per`, `count`, `factor`, `overlapCount` may be expressions (strings) over `params` (Task 3 uses `overlapCount`).
  - `layoutRegistry.js`: `LAYOUTS` (kind → definition, this task registers only `sliding_2`; later tasks add files and one import line each), `layoutOf(kind)` (throws `unknown_layout`), `inputsOf(kind)`, `defaultParams(kind, typeParams)` (layout defaults overridden by `fixed_by_type` values), `kinds()`.
  - `partModel.js`: `startModel(kind, params = {})` stores `model.params`; `pieceCount(model, key)` = `evalExpr(per) × evalExpr(part.count)`; `partnerEnd(model, key, piece, end)` (NOTE: now takes `model` first — update the three callers in `partModel.js`; `partExpand.validateCorners` already receives the model); `defaultTarget(model, key, end)`; `defaultLine(model, key)` from `rule`; `setParams(model, patch)` re-runs `ensureEnds`.

- [ ] **Step 1: Write `layoutExpr.test.js`**

```js
import { describe, it, expect } from 'vitest'
import { evalExpr } from './layoutExpr.js'
describe('evalExpr', () => {
  it('numbers pass through', () => { expect(evalExpr(2, {})).toBe(2); expect(evalExpr('0.5', {})).toBe(0.5) })
  it('identifiers and arithmetic', () => {
    expect(evalExpr('cols-1', { cols: 4 })).toBe(3)
    expect(evalExpr('(rows-1)*cols', { rows: 3, cols: 4 })).toBe(8)
    expect(evalExpr('nL+nR', { nL: 2, nR: 1 })).toBe(3)
    expect(evalExpr('1/n', { n: 4 })).toBe(0.25)
  })
  it('missing identifier -> 0 for counts, error flagged', () => { expect(() => evalExpr('cols-1', {})).toThrow('layout_expr') })
  it('rejects anything but identifiers, digits and + - * / ( )', () => {
    for (const bad of ['cols--', 'Math.max(1,2)', 'a;b', '1e3x', '__proto__']) expect(() => evalExpr(bad, { cols: 1 })).toThrow('layout_expr')
  })
})
```

- [ ] **Step 2: Run it — FAIL (module missing).**

- [ ] **Step 3: Implement `layoutExpr.js`** — tokenizer (`/^\s*(\d+(?:\.\d+)?|[A-Za-z_][A-Za-z0-9_]*|[-+*/()])/`), recursive-descent parser (expr → term (± term)*, term → factor (×÷ factor)*, factor → number | ident | '(' expr ')'), identifiers looked up in `params` (undefined → throw `new Error('layout_expr: unknown ' + name)`), division by zero → throw. Never `eval`/`Function`.

- [ ] **Step 4: Run — PASS.**

- [ ] **Step 5: Write the frozen-behaviour tests in `partModel.test.js`** (appended): `startModel('sliding_2')` deep-equals the snapshot of today's `startModel('sliding_2')` with `params: {}` added (generate the snapshot BEFORE refactoring and paste it as a literal in the test); `partnerEnd(model,'sash_top',1,0)` → `{ key:'hook_stile', piece:1, end:0 }` and the full involution property for every position/piece/end (`partnerEnd(partnerEnd(x)) === x`); `pieceCount` with `params` absent equals the old numbers.

- [ ] **Step 6: Refactor `partModel.js`** to read the definition: move the `LAYOUTS.sliding_2` object into `src/lib/layouts/sliding_2.js` in the schema above; `LAYOUTS` now comes from `layoutRegistry.js`; implement `partnerEnd(model, key, piece, end)` from `joints` (horizontal end e → `{ key: v[e], piece: vPiece==='byEnd' ? e : piece, end: vEnd }`; vertical end → the inverse search over joints, `mode:'tee'` joints return null for the vertical side); `defaultPair` from `joints` (`through` decides who butts; `mitre` → both ends `{ mode:'mitre', to:null, deduction_mm:null }`); `defaultLine` from `rule` (`length_rule_type = rule.type`, `deduction_auto = !!rule.auto`, `length_factor = evalExpr(rule.factor ?? 1, params)`, `thickness_role = rule.role ?? null`). Keep every exported function name.

- [ ] **Step 7: Run the whole suite — PASS (1847 + new).**

- [ ] **Step 8: Write `layoutRegistry.test.js`** (registry has `sliding_2`; `layoutOf('nope')` throws `unknown_layout`; `defaultParams('sliding_2', {})` → `{}`), run, pass.

- [ ] **Step 9: Commit** `feat(estimation): declarative layout definitions; sliding_2 moved to data with frozen behaviour`.

---

### Task 3: Expansion rules for grids, tracks, mitres and sash references

**Files:**
- Modify: `src/lib/partExpand.js` (`makeCtx.autoDed`, `overlap`, `endDed`, `cut_style`), `src/lib/partExpand.test.js` (append)
- Modify: `src/lib/partModel.js` (`validateCorners` skips `mitre`/`tee`)

**Interfaces:**
- Produces: `autoDed` by `rule.auto`:
  - `frame_sides` → `2·b(frame_side)`; `frame_top_bottom` → `b(frame_top) + b(frame_bottom)` (as today);
  - `grid_cols` → `2·b(frame_side) + (cols−1)·w(mullion)` (w = `widthOf(family of mullion line 0)`; missing width → issue `no_profile_width`);
  - `grid_rows` → `b(frame_top) + b(frame_bottom) + (rows−1)·w(transom)`;
  - `sides_only` → `2·b(frame_side)` with no top/bottom (frames without sill: `frame_top` of doors uses `frame_sides`; stiles of a sill-less door use `auto: 'frame_top'` → `b(frame_top)` only).
  - Position names used by `auto` are looked up through `layout.roles` (`{ frame_side: 'frame_side', frame_top: 'frame_top', frame_bottom: 'frame_bottom', mullion: 'mullion', transom: 'transom', hook: 'hook_stile' }`, overridable per layout so e.g. `curtain_wall` maps `frame_side` → `mullion_outer`).
  - `overlap(key, line)`: when `rule.overlap === 'hook'`: `ov × evalExpr(rule.overlapCount ?? 1, params)` where `ov` = hook stile butt distance else width (today's rule); `sliding_2` keeps `overlapCount` 1 (its factor 0.5 already halves `W + ov`).
  - Mitre: a line whose part has `corner: 'mitre'` gets `end_deduction_mm = 0` for every piece regardless of stored `ends`, `cut_style: 'mitre'`; `validateCorners` ignores its joints.
  - `tee` joints: the horizontal piece's ends butt into the vertical's **side** (`endDed` = `b(vertical family)` as for corners); the vertical keeps `through` on both ends; no corner validation.
  - `sash_width` / `sash_height` references in `rule.type` are compiled by `defaultLine` into `width_minus` / `height_minus` with the layout's `auto` + `factor` (they are editor vocabulary only; stored rows keep the four base types).

- [ ] **Step 1: Append tests to `partExpand.test.js`** using a throwaway layout registered only in the test (`registerLayoutForTest(def)` helper exported from `layoutRegistry.js` under `process.env.NODE_ENV === 'test'` guard) with a grid: frame 4 sides, `mullion` (`per: 'cols-1'`, `rule: { type:'height_minus', auto:'frame_top_bottom' }`), `transom` (`per: '(rows-1)*cols'`, `rule: { type:'width_minus', auto:'grid_cols', factor:'1/cols' }`), joints: frame corners butt (v through), `{ h:'transom', v:['mullion','mullion'], mode:'tee', through:'v' }`. With `buttOf = () => 45`, `widthOf = () => 60`, params `{rows:2, cols:3}`, W 1800 H 1200 the expanded rows give: mullion `height_minus` ded 90 factor 1 ends 0 → 1110 × 2 pieces; transom `width_minus` ded `90 + 2·60 = 210` factor `1/3` ends 0 → 530 × 6 pieces. Assert `length_deduction_mm`, `length_factor`, `quantity_value`, and the engine length via `computeComponentLength` (imported from bomEngine) = 1110 / 530.
  Second test: a mitred sash part (4 positions, `corner:'mitre'`) with stale `ends[].mode='butt'` still yields `end_deduction_mm: 0`, `cut_style: 'mitre'`, no `corner_violation`. Third: `overlapCount: 'n-1'` with n = 3 and `ov = 40` adds 80 before the factor `1/3`.

- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** the `autoDed` table, `overlap` multiplier, mitre/tee handling, `roles` lookup. Keep `lineDeductions`, `sashOverlap`, `endDeduction`, `explainPiece` working (explainPiece prints `− ซอยกลาง (cols−1) × กว้าง` for `grid_*`, `(เข้ามุม 45°)` for mitre).
- [ ] **Step 4: Run the full suite — PASS.**
- [ ] **Step 5: Commit** `feat(estimation): grid, tee, mitre and multi-sash overlap rules in the part expander`.

---

### Task 4: Layouts step 1 — `fixed_grid`, `awning_grid`, `casement_n`

**Files:**
- Create: `src/lib/layouts/fixed_grid.js`, `src/lib/layouts/awning_grid.js`, `src/lib/layouts/casement_n.js`, `src/lib/layouts/layouts.test.js` (one shared test file for all layout files; later tasks append)
- Modify: `src/lib/layoutRegistry.js` (import + register)

**Interfaces:** each file exports a definition in the Task 2 schema. Produces these position keys (used by geometry, UI labels and tests):
- `fixed_grid`: parts `frame` (1), `grid` (1); positions `frame_top`, `frame_bottom`, `frame_side` (per 2), `mullion` (part `grid`, v, `per: 'cols-1'`, name `ซอยกลางตั้ง`, rule `height_minus`/`frame_top_bottom`), `transom` (part `grid`, h, `per: '(rows-1)*cols'`, name `ซอยกลางนอน`, rule `width_minus`/`grid_cols`/factor `'1/cols'`); joints: frame corners (v through), transom tee into mullion; inputs `rows` (1–8, default 2, estimator true), `cols` (1–12, default 3, estimator true); hardware none; symbol none. Default families: frame กล่องเรียบ, mullion ซอยกลาง 4" ยูโร, transom ซอยกลาง 2" ยูโร (profile_family strings in `rule.family`; `startModel` copies them into line 0).
- `awning_grid`: `fixed_grid` + part `sash` (`count: 'rows*cols'`, `corner: 'mitre'`, name `บานกระทุ้ง`), positions `sash_top` (h, per 1, name `ราวบนบาน (บานพับ)`, rule `width_minus`/`grid_cols`/factor `'1/cols'`/role sash/family กรอบในกระทุ้ง+คิ้ว), `sash_bottom` (same, name `ราวล่างบาน (มือจับ)`), `sash_side` (v, per 2, labels ซ้าย/ขวา, rule `height_minus`/`grid_rows`/factor `'1/rows'`/role sash/family กรอบนอกกระทุ้ง); joints for the sash: `{ h:'sash_top', v:['sash_side','sash_side'], vPiece:'byEnd', vEnd:0, mode:'mitre' }`, same for `sash_bottom` with `vEnd:1`; inputs `rows`, `cols` with `fixed_by_type: true` (from `door_window_types.layout_params`), `open` (select in/out, default out, estimator true); hardware `แขนค้ำกระทุ้ง` per sash 2, `มือจับ` per sash 1; symbol `{ sash: 'v_hinge', hinge: 'top' }`.
- `casement_n`: `fixed_grid` with `rows` fixed 1 (not an input) and `cols` renamed input `n` (`per: 'n-1'` mullions, `count: 'n'` sashes), sash as awning but names `ราวบนบาน`, `ราวล่างบาน`, `เสาบานพับ`, `เสามือจับ` (`sash_side` per 2 labels `บานพับ`/`มือจับ`), inputs `n` (1–8, default 2, estimator true), `hinge` (select left/right, only when n = 1), `open`; symbol `{ sash:'v_hinge', hinge:'alternate' }`.

- [ ] **Step 1: Write `layouts.test.js`** — for each of the three kinds: (a) `startModel(kind, defaultParams(kind, typeParams))` snapshot of `Object.keys(lines)` and piece counts; (b) `expandParts` worked example with `buttOf = () => 45`, `widthOf = () => 60` at 1800 × 1200:
  - `fixed_grid` 2 × 3: as Task 3 numbers; plus `cols:1, rows:1` → no mullion/transom rows, no issues (Review Focus 2).
  - `awning_grid` rows 2 cols 2 at 1200 × 1200 (`layout_params` of type "บานกระทุ้ง 2 ชั้น x 2 ช่อง"): cell width = (1200 − 90 − 60)/2 = 525, cell height = 525; sash_top rows: ded `90 + 60 = 150`, factor 0.5, ends 0 → 525; `quantity_value` 4 (one per sash piece); sash_side: ded `90 + 60`, factor 0.5, qty 8; `cut_style:'mitre'` on all sash rows; mullion 1 × 1110; transoms 2 × 525.
  - `casement_n` n = 2 at 1500 × 1200: mullion 1 × 1110, sash_top 2 × ((1500 − 90 − 60)/2 = 675), sash_side 4 × 1110; n = 1: no mullion, sash_top 1 × 1410, hinge param honoured in `symbol` resolution (`symbolFor(model, 'sash', piece)` → `{ kind:'v_hinge', hinge:'left' }`).
  (c) `validateCorners` returns `[]` for all three defaults.

- [ ] **Step 2: Run — FAIL.** **Step 3: Write the three layout files + register.** **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** `feat(estimation): layouts fixed_grid, awning_grid, casement_n`.

---

### Task 5: Layouts step 2 — `sliding_n`, `sliding_3track`, `sliding_2_fixed_2`

**Files:** create `src/lib/layouts/sliding_n.js`, `sliding_3track.js`, `sliding_2_fixed_2.js`; register; append `layouts.test.js`.

**Interfaces (produces):**
- `sliding_n`: parts `frame` (1), `sash` (`count:'n'`, `track:'alternate'`, `overlap_mode:'auto_hook'`); positions exactly as `sliding_2` (`key_stile` and `hook_stile` per sash; the drawing mirrors the sashes of the right half so the key stiles sit at the frame and the hook stiles meet inside). Rails: `rule: { type:'width_minus', auto:'frame_sides', factor:'1/n', overlap:'hook', overlapCount:'n-1', role:'sash' }`. Inputs `n` (2–6, default 2, estimator true), `door` (fixed_by_type boolean; when true `frame_bottom` is named `รางล่าง (ธรณี)` and `frame_top` `รางบน`). Hardware: ลูกล้อ per sash 2, กุญแจ/มือจับ per unit 1. Symbol slide (left half →, right half ←).
- `sliding_3track`: sash part `count: 3`, `track: [3,2,1]` (explicit per piece), piece 0 `fixed: true`; rails factor `1/3`, `overlapCount: 2`; frame names `เฟรมบน (3 ราง)` / `เฟรมล่าง (3 ราง)` with families รางบนบิ๊กเฟรม / รางล่างบิ๊กเฟรม 2 ราง (defaults; owner editable); inputs `fixed_side` (select left/right, default left, estimator true); hardware ลูกล้อ per sliding sash 2 (qty expression `2*2`), ราง per unit 3 (informational). Symbol: slide toward the fixed sash; fixed pane F.
- `sliding_2_fixed_2`: sash part `count: 4`, `track: [2,1,1,2]`, `fixed: [true,false,false,true]`; rails `factor: 0.25`, `overlapCount: 2`; stiles are per-sash `stile_a` / `stile_b` (v, per 1 each) with piece-dependent default names from the layout: `pieceNames: { stile_a: ['เสากุญแจ','เสาเกี่ยว','เสากุญแจตัวเมีย','เสาเกี่ยว'], stile_b: ['เสาเกี่ยว','เสากุญแจตัวผู้','เสาเกี่ยว','เสากุญแจ'] }` (D10 order left→right; `pieceLabel` uses them); free position `sill_cover` (h, per 1, `ตบธรณี`, rule `width`, factor 0.5, part `frame`, corner `free`). No inputs beyond W/H (D17). Hardware ลูกล้อ 4, กุญแจ 1.

- [ ] **Step 1: Tests** (append): `sliding_n` n = 2 reproduces `sliding_2`'s 1800 × 1200 worked example exactly (1,723.8 / 1,200 / 824.4 / 1,126.1 with the same `buttOf`/`widthOf` fixtures as `partExpand.test.js`); n = 3 at 2700 × 1200 with `ov = 40`, b = 45: rail = (2700 − 90 + 80)/3 = 896.67 → `r6`; `sliding_3track` same numbers with `track` metadata `[3,2,1]` exposed via `trackOf(model,'sash',piece)`; `sliding_2_fixed_2` at 2400 × 1200: rail = (2400 − 90 + 80)/4 = 597.5; `pieceLabel(model,'stile_b',1)` = `เสากุญแจตัวผู้`; `sill_cover` length 1200 (W × 0.5), `cut_style:'square'`; the Excel type-2 example (W 3300, H 1000, b = 0, ov = 0): sum of all stile lengths = 8 × 1000 = 8000 = Excel's `เสากุญแจ 2H + เสาเกี่ยว 4H + เสาตาย 2H` (same aluminium, different names — note in the test).
- [ ] **Step 2–4: FAIL → implement (incl. `track`, `fixed`, `pieceNames`, `trackOf`, `isFixedPiece` helpers in `partModel.js`) → PASS.**
- [ ] **Step 5: Commit** `feat(estimation): layouts sliding_n, sliding_3track, sliding_2_fixed_2`.

---

### Task 6: Layouts step 3 — `swing_door`, `frameless_door`, `hanging_door`, `folding_door`

**Files:** create the four layout files; register; append `layouts.test.js`.

**Interfaces (produces):**
- `swing_door`: parts `frame` (1), `leaf` (`count:'leaves'`, corner butt, D15). Positions `frame_side` (v, per 2, through, rule height), `frame_top` (h, per 1, rule `width`, ends butt into the sides — the `sliding_2` frame convention), `sill` (h, per 1, name `ธรณี (วงกบล่าง)`, rule `width`, `enabled: 'sill'` — a position whose `enabled` expression (`params.sill === 'yes'` → the registry evaluates `enabled` as an expression over params where selects are mapped to 1/0: `sill`) is 0 is absent from `startModel` and from the drawing); leaf positions `leaf_stile_hinge` (v, per 1, through, rule `height_minus`/`auto: sill ? 'frame_top_bottom' : 'frame_top'` → implement as `auto: 'frame_top_bottom'` with the registry dropping the missing position from the sum when `sill` is absent), `leaf_stile_handle` (v, per 1), `leaf_rail_top` / `leaf_rail_bottom` (h, per 1, rule `width_minus`/`frame_sides`/factor `'1/leaves'`, ends butt into stiles). Inputs: `leaves` (1–2, default 1, `fixed_by_type` for บานสวิงเดี่ยว/คู่, estimator for บานเปิด), `hinge` (left/right, only when leaves = 1), `open` (in/out), `sill` (yes/no), `pivot` (fixed_by_type boolean). Hardware: `pivot` false → บานพับ per leaf 3, มือจับ 1; true → door closer ฝังวงกบบน per leaf 1, เดือยบน/ล่าง 2, มือจับ 1. Symbol v_hinge (single: input; double: outer stiles), `open` → dashed/solid per view. Families: sheet 6 defaults (กล่องแจ็คสัน head, เสาประตูสวิง stiles, เสาบนสวิง/เสาล่างสวิง rails, ธรณีสวิง sill).
- `frameless_door` (D16): parts `frame` (positions `frame_side` ×2, `frame_top`; no sill), `leaf` (`count:'leaves'`, `glass: true`, no positions). Inputs `leaves` (fixed_by_type), `hinge`, `open`. Hardware per leaf: patch fitting 2, floor spring 1, มือจับสแตนเลส 1, กุญแจล็อคพื้น 1.
- `hanging_door`: parts `track` (positions `track_rail` h per 1 `รางแขวนใหญ่` rule `width` factor 2, `track_cover` h per 1 `กล่อง 1-3/4` factor 2, both corner `free`), `frame` (`frame_side` ×2 rule `height_minus` with `auto:'track'` = `b(track_rail)` once), `leaf` (`count:'leaves'`, stiles through `เสาประตูสวิง`, rails butt `เสาบนสวิง`/`เสาล่างสวิง` factor `'1/leaves'`); inputs `leaves` (1–2); hardware ลูกล้อรางแขวน per leaf 2, ไกด์พื้น per unit 1; symbol slide (single toward open side; double outward). Open question 3 of the spec stays a default (factor 2).
- `folding_door` (D1): parts `track` (`track_top` h `รางบน` rule width, `track_bottom` h `รางล่าง (ยูฝังพื้น)` rule width, `track_side` v per 2 `รางข้าง` rule `height_minus`/`auto:'track_top_bottom'`), `leaf` (`count:'nL+nR'`, corner butt; positions `leaf_top`/`leaf_bottom` h rule `width_minus`/`auto:'track_sides'`/factor `'1/(nL+nR)'`, `leaf_side` v per 2 rule `height_minus`/`auto:'track_top_bottom'`), free lines บังใบ/คิ้วบาน per leaf (two `free` positions, v per 2 and h per 2, same rules as the leaf members — the owner may delete them). Inputs `nL` (0–6, default 2), `nR` (0–6, default 2), both estimator true; `startModel` with `nL + nR = 0` throws `layout_params_invalid` (Review Focus 3: the editor catches it and shows "ใส่จำนวนบานซ้าย/ขวา"). Hardware: บานพับต่อบาน `(nL+nR-1-(nL>0&&nR>0?1:0))*3` → express as two hardware rows: per-side pairs: `ล้อบน/ล่างบานเฟี้ยม` qty `ceil(nL/2)+ceil(nR/2)` ×2 — `evalExpr` has no ceil: add `ceil(` `)` and `max(` `)` to `layoutExpr` in this task with tests; symbol fold (alternating V, arrows to each side, split line when both > 0).

- [ ] **Step 1: Tests** (append): `swing_door` leaves 2, sill yes, 1800 × 2100, b = 45: rails `(1800 − 90)/2 = 855` × 2 per rail position (qty 2), stiles `2100 − 90 = 2010`; sill no → stiles `2100 − 45 = 2055`, no `sill` row; `frameless_door`: exactly three aluminium rows (sides ×2, top), `glassParts(model)` returns 2 leaves with widths 855; `hanging_door` leaves 1 W 2400: `track_rail` 4800; `folding_door` nL 2 nR 2 W 3000 H 2400 b 45: leaf width `(3000 − 90)/4 = 727.5`, leaf_side `2400 − 2·b(track)` with `buttOf('รางบน') = 60` → 2280; nL 0 nR 0 → throws `layout_params_invalid`; `evalExpr('ceil(nL/2)+ceil(nR/2)', {nL:3,nR:2})` = 3.
- [ ] **Step 2–4: FAIL → implement (incl. `enabled` positions, `ceil`/`max` in `layoutExpr`, `glassParts(model)` helper) → PASS.**
- [ ] **Step 5: Commit** `feat(estimation): layouts swing_door, frameless_door, hanging_door, folding_door`.

---

### Task 7: Layouts step 4 — `curtain_wall`, `frameless_wall` (cells)

**Files:** create `src/lib/layouts/curtain_wall.js`, `frameless_wall.js`; create `src/lib/layoutCells.js` + test; register; append `layouts.test.js`.

**Interfaces (produces):**
- `layoutCells.js`: `cellKinds(model)` → `{ "r,c": 'glass'|'awning'|'spandrel' }` for every cell in `rows × cols` (template/item `params.cells` entries outside the grid are dropped — Review Focus 5; missing entries default from `params.spandrel` row rule: `top` → row 0, `bottom` → last row, else glass); `cycleCell(model, r, c)` → next kind (glass → awning → spandrel → glass, D2); `countKinds(model)`.
- `curtain_wall`: parts `frame` (positions `mullion` v `per:'cols+1'` through full H, name `เสา mullion`, rule height, family NO.9010; `transom` h `per:'(rows+1)*cols'`, name `ราว transom`, rule `width_minus`/`auto:'cw_cols'` (= `(cols+1)·w(mullion)`)/factor `'1/cols'`, family NO.9023; free lines for the pressure plate and cover (NO.9019, NO.3112): each as two `free` positions, one `width` with factor `'(rows+1)*(1-k)'` and one `height` with factor `'(cols+1)*(1-k)'`, so their sum reproduces the Excel `(W(R+1)+H(C+1))·(1−k)`; input `k` (select 0.5/1/0 → number, default 0.5, estimator true)), `awning` (sash part instantiated per awning cell: `count: 'cells.awning'` — `evalExpr` receives `cells.awning` as a param computed by `cellKinds`; positions as `awning_grid`'s sash with families บานหน้าต่างยูโร / คิ้วยูโร; cell geometry = `(W − (cols+1)·w(mullion))/cols` × `(H − (rows+1)·w(transom))/rows` → rules `width_minus`/`auto:'cw_cols'`/factor `'1/cols'` and `height_minus`/`auto:'cw_rows'`/factor `'1/rows'`, mitre), `spandrel` (part `glass: false`, `panel: true`, count `'cells.spandrel'` — contributes an infill line of kind `solid_panel` per cell, no aluminium). Inputs `rows` (1–8), `cols` (1–12), `spandrel` (none/top/bottom), `cells` (object, estimator true per R5), `k`, `unitized` (fixed_by_type; draws unit joints; families switch to the Unitized set via `familiesWhen: { unitized: {...} }`). Hardware: awning cells → แขนค้ำ 2 + มือจับ 1 per awning cell.
- `frameless_wall` (D3): parts `frame` (4 positions as `fixed_grid`'s frame), `pane` (`glass: true`, `count:'cols'`); inputs `cols` (1–12, default 3, estimator true); sealant joints `cols−1` reported by `jointCount(model)` (used later by the sealant quantity in costing — out of scope here, exported only).

- [ ] **Step 1: Tests**: `layoutCells` (defaults from `spandrel:'top'` with rows 3 cols 4 → 4 spandrel; `cycleCell` sequence; out-of-grid keys dropped after `setParams(model,{cols:2})`); `curtain_wall` 3600 × 3000, rows 3 cols 4, b(mullion) = 0 (mullions run full H), `widthOf` = 65: mullions 5 × 3000; transoms 12 × `(3600 − 5·65)/4 = 818.75`; with one awning cell: 4 sash rows (`quantity_value` 1 each… `sash_side` qty 2) with lengths 818.75 / `(3000 − 4·65)/3 = 913.33`; spandrel count 4 → `panelCells(model).length === 4`; `frameless_wall` cols 3: frame 4 rows, `glassParts` 3 panes of `(3600 − 90)/3 = 1170`, `jointCount` 2.
- [ ] **Step 2–4: FAIL → implement → PASS.**
- [ ] **Step 5: Commit** `feat(estimation): layouts curtain_wall and frameless_wall with cell kinds`.

---

### Task 8: Geometry and preview for every layout

**Files:**
- Create: `docs/reference/type-previews-mockup.html` (copy of the accepted artifact v5 file; the drawing reference), `src/lib/partSymbols.js` + test
- Modify: `src/lib/partGeometry.js` (+ test), `src/lib/partPreviewSvg.js` (+ test), `src/lib/framePreview.js` only if it must dispatch to the part drawing for new kinds (check `itemPreviewSignature.js` callers)

**Interfaces:**
- Consumes: layout definitions, `cellKinds`, `trackOf`, `isFixedPiece`, `glassParts`.
- Produces: `overviewSpecs({ model, widthMm, heightMm, view, widthOf })` returns, for every layout, `{ pieces: [{ key, piece, x, y, w, h, part, partIdx, track, mitre }], glass: [{ x, y, w, h, fixed, kind:'glass'|'spandrel'|'frameless' }], symbols: [{ kind:'v_hinge'|'slide'|'fold'|'none', x, y, w, h, hinge:'left'|'right'|'top', dashed: boolean, dir: -1|1 }], hardwareMarks: [...], dims: [...] }` in mm; `zoomSpecs({ model, partKey, partIdx, selected, ... })` fades other parts (opacity 0.25) exactly as the mockup; `partSvgString` renders the four styles D14 and the symbols (dashed = opens away from the viewer: `dashed = view === 'out' ? open === 'in' : open === 'out'`), unit joints for unitized walls, F labels on fixed panes, floor dashed line for sill-less doors, door-closer box, patch fittings flush (D6), pull handle and floor lock marks.
- Drawing constants when `widthOf` is null: frame 45, mullion/transom 60/65, sash 50, door stile/rail 100, track 60/80 (the mockup's `PW`).

- [ ] **Step 1: Tests**: for each of the 13 kinds at the mockup's default size, `overviewSpecs` returns pieces whose count equals `expandParts` piece count (sum of `quantity_value`), every piece inside `[0,W]×[0,H]` (tracks of `hanging_door` may extend to `[-0.25W, 1.25W]`), no two pieces of the same track overlap except declared hook overlaps (`sliding_*`), mitred pieces carry `mitre: true`; `partSymbols.symbolFor` matrix: casement n=2 → pieces hinge left,right; awning → hinge top; swing_door open in, view out → dashed true; fold nL 2 nR 1 → 3 V entries alternating + 2 arrows + split; `partSvgString` for `curtain_wall` with cells `{ "0,1":'awning', "2,3":'spandrel' }` contains one V polyline and one spandrel rect (assert by counting `<polyline` and `data-kind="spandrel"` attributes); the existing sliding_2 SVG snapshot test is unchanged.
- [ ] **Step 2–4: FAIL → implement by porting the mockup `BODY` functions into `partGeometry` (mm space, same formulas) and the symbol/arrow/dim drawing into `partPreviewSvg` → PASS.** Keep SVG output a string with inline attributes only (no scripts/handlers), as today.
- [ ] **Step 5: Commit** `feat(estimation): geometry and preview SVG for all layout kinds`.

---

### Task 9: Registry wiring — catalogue type form, template persistence, item params, costing

**Files:**
- Modify: `src/lib/partSave.js` (+ test): `modelToRows`/`modelFromRows` carry `layout_params`; `loadModel` validates `template.layout_kind === type.layout_kind` else `{ error: 'layout_mismatch' }` (Review Focus 4); `params` default from `defaultParams(kind, type.layout_params)` when the template row has `{}` (Review Focus 1).
- Modify: `src/hooks/useBomPartModel.js`, `src/lib/openingCost.js` (+ tests): the item's `layout_params` override the template's for `estimator: true` inputs only; `partFamilyOpts` unchanged.
- Modify: `src/lib/catalogTypeForm.js` (+ test) and the TypesTab in the catalogue page: `layout_kind` select lists `kinds()` with Thai labels (`layoutLabels` in the registry), and a `layout_params` fieldset showing the kind's `fixed_by_type` inputs (rows/cols for awning, leaves/pivot for swing, door for bottom-rail sliding, unitized for CW). `omitWhenAbsent` for both.
- Modify: `src/lib/estimationCatalogTables.js` select lists (add `layout_params` to the three tables' selects).

- [ ] **Step 1: Tests**: round-trip `modelToRows → modelFromRows` keeps `params` for `awning_grid` (rows 2 cols 2) and `curtain_wall` (cells); mismatch → `layout_mismatch`; legacy `sliding_2` rows without params → `params: {}` and identical expansion (Review Focus 1); `openingCost` item with `layout_params: { n: 3 }` on a `sliding_n` template prices three sashes (component count check), and an item param for a non-estimator input (`rows` on `awning_grid`) is ignored; `catalogTypeForm` serialises `layout_params` numbers (not strings) and drops unknown keys.
- [ ] **Step 2–4: FAIL → implement → PASS (full suite).**
- [ ] **Step 5: Commit** `feat(estimation): layout kinds and params wired through catalogue, template load/save and costing`.

---

### Task 10: Editor and item form UI (mockup v5)

**Files:**
- Modify: `src/pages/bomTemplates/PartEditor.jsx`, `PartPreview.jsx`, `PartSidePanel.jsx`, `PartTable.jsx`, `PartLine.jsx`; create `src/pages/bomTemplates/PartInputs.jsx`; modify `src/pages/BomTemplates.jsx` (template creation picks the type's layout and `startModel(kind, defaultParams)`); modify the item form (`src/pages/estimation/*` where `width_m`/`height_m` are entered) to add the layout's `estimator` inputs and the curtain-wall cell cycling on the item preview.

**Interfaces:** consumes everything above. Produces: part tabs generated from `model.parts × count` (`ทั้งชุด`, `วงกบ`, `บาน 1`…, `ซอยกลาง`, `ราง`), click on a piece selects `{ key, line: 0 }` and highlights all pieces of that position in the part (D13), `เสร็จแล้ว` per part stored in `model.done` (saved with the model, UI-only meaning), inputs panel with `fixed_by_type` values read-only, D14 style select, view in/out, cell click cycling for CW templates and items (`cycleCell`), hint "ใส่จำนวนบานซ้าย/ขวา" when `startModel` throws `layout_params_invalid`.

- [ ] **Step 1: Component tests** (vitest + @testing-library, as existing PartEditor tests do): awning template shows 1 + 1 + 4 part tabs for 2 × 2; clicking the second tab fades others (`opacity` attribute on other pieces); clicking a sash top piece selects `sash_top` and the side panel shows `เข้ามุม 45°`; casement n = 1 shows the hinge select, n = 2 hides it; folding door with nL 0 nR 0 shows the hint and no SVG; CW template click on a cell cycles its `data-kind`; item form for `sliding_n` shows `n`, for `awning_grid` shows no rows/cols.
- [ ] **Step 2–4: FAIL → implement → PASS; `npm run build` OK.**
- [ ] **Step 5: Live check (implementer, dev server against CHANG with the owner's data):** open a template of each kind group (fixed_grid, awning 2×2, casement 2, sliding 3, swing door 2 leaves, folding 2+2, curtain wall with one awning + one spandrel cell), assign one profile per part, save, reload, confirm the preview and the costing rows; record the screenshots' paths in the report.
- [ ] **Step 6: Commit** `feat(estimation): part editor and item form for every layout kind`.

---

### Task 11: Hardware defaults on template creation

**Files:** modify `src/lib/partSave.js` (`hardwareDefaults(kind, params)` → rows for `bom_template_hardware` with `quantity_rule: 'per_sash' | 'per_unit'` mapped to the existing hardware quantity basis), `src/pages/BomTemplates.jsx` (insert them once on create, editable afterwards), tests.

- [ ] **Step 1: Tests**: `hardwareDefaults('awning_grid', {rows:2, cols:2})` → `[{ name:'แขนค้ำกระทุ้ง', quantity: 8 }, { name:'มือจับ', quantity: 4 }]`; `swing_door` pivot → closer 1, pivots 2, handle 1 per leaf × leaves; `folding_door` nL 3 nR 2 → rollers `(2+1)×2 = 6`; rows carry `part_id: null` (the owner picks the part later) and `source: 'layout_default'`.
- [ ] **Step 2–4: FAIL → implement → PASS.** **Step 5: Commit** `feat(estimation): layout hardware defaults written into new templates`.

---

### Task 12: Handover, ledger, whole-branch review

- [ ] Add "Layouts for every type" to `docs/handover-aluminium-cost-catalog.md`: kinds table, params columns, how to add a layout (file + registry line + tests), deferred items (open rulings R3/R5, hanging track rule, hardware counts, sealant quantity from `jointCount`).
- [ ] Update the parent spec §4.1/§5.1 cross-reference (one line each) to this spec.
- [ ] Final whole-branch review (opus) with the Review Focus list; one fix bundle; re-review.
- [ ] Commit `docs: handover for part-editor layouts of every type`.

## Execution notes

- Order: 1 (independent) → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 12. Tasks 4–7 may run as one implementer each; Task 8 must wait for 7.
- Model choice: Tasks 2, 3, 8 need design judgment (opus); 4–7 are data + tests (sonnet); 10 is UI integration (opus or sonnet with the mockup file in hand).
- The migration is applied by the owner (script in Task 1) before Task 9's live check; nothing in Tasks 2–8 needs the database.
