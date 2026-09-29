# BOM Cost Factors Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the FacadeX Estimation module's BOM engine so a computed opening cost includes labor, silicone, felt, a 4-kind infill catalog (glass/mesh/solid panel/ACP), and an optional add-on unit (e.g. a fixed transom above a door) — matching every cost factor the business actually prices, per `docs/superpowers/specs/2026-09-29-bom-cost-factors-design.md`.

**Architecture:** A database migration renames the glass-only catalog to a generic infill catalog and adds three new per-template rate columns plus four add-on-unit columns on `estimation_openings`. `src/lib/bomEngine.js` (a pure function, no I/O) gets the rename applied to its parameters/return shape and three new cost-line calculations. Two UI pages (`BomTemplates.jsx`, `Estimation.jsx`) and one hook (`useSupabase.js`) are updated to match. The add-on unit is computed by calling the same pure `computeBomForOpening` function a second time from the UI layer and summing the two results — the function itself never grows a second code path.

**Tech Stack:** React 18, Vite, Supabase (Postgres + JS client), Vitest.

**Spec:** `docs/superpowers/specs/2026-09-29-bom-cost-factors-design.md` — read it alongside this plan; the plan argues from it and doesn't repeat its reasoning.

## Global Constraints

- All new `bom_templates` rate columns (`labor_price_per_sqm`, `silicone_price_per_m`, `felt_price_per_m`) are `NUMERIC NOT NULL DEFAULT 0` — existing templates must keep computing the exact same `totalCost` until an admin fills these in.
- The rename (`bom_glass_types`→`infill_types`, `glass_type_id`→`infill_type_id`, `glass_width_deduction_mm`/`glass_height_deduction_mm`→`infill_width_deduction_mm`/`infill_height_deduction_mm`) must be a `RENAME`, never a drop-and-recreate — existing data must survive untouched.
- `computeBomForOpening`'s contract stays "one opening in, one BOM out" — add-on aggregation happens in the calling UI code, never inside the function itself.
- The add-on unit shares the main opening's `series`, `thickness_mm`, `finish_id`, and `infill_type_id` — it never gets its own selectors for these (spec Decision 5).
- No per-opening override for labor/silicone/felt rates — template default only (spec Non-goals).
- No location field for the add-on unit — position is implicit in which template is picked as the add-on (spec Decision 6).

---

## Task 1: Database migration — infill generalization + new rate/add-on columns

**Files:**
- Create: `supabase/migrations/2026-09-29-02-bom-cost-factors.sql`

**Interfaces:**
- Produces: table `infill_types` (renamed from `bom_glass_types`) with new column `material_kind`; `estimation_openings.infill_type_id` (renamed from `glass_type_id`); `bom_templates.infill_width_deduction_mm`/`infill_height_deduction_mm` (renamed from `glass_width_deduction_mm`/`glass_height_deduction_mm`); `bom_templates.labor_price_per_sqm`/`silicone_price_per_m`/`felt_price_per_m` (new); `estimation_openings.addon_template_id`/`addon_width_m`/`addon_height_m`/`addon_panel_count` (new). All later tasks consume these exact names.

- [ ] **Step 1: Write the migration file**

```sql
-- supabase/migrations/2026-09-29-02-bom-cost-factors.sql
-- Extends the BOM Template Engine (Phase 1) per
-- docs/superpowers/specs/2026-09-29-bom-cost-factors-design.md.
--
-- Decisions 1-2: generalize glass -> infill. A rename, not a new table --
-- existing rows keep working (material_kind defaults to 'glass'). RLS
-- policies survive a table/column rename automatically; no policy
-- changes needed.
ALTER TABLE bom_glass_types RENAME TO infill_types;
ALTER TABLE infill_types ADD COLUMN material_kind TEXT NOT NULL DEFAULT 'glass'
  CHECK (material_kind IN ('glass','mesh','solid_panel','acp'));

ALTER TABLE estimation_openings RENAME COLUMN glass_type_id TO infill_type_id;
ALTER TABLE bom_templates RENAME COLUMN glass_width_deduction_mm TO infill_width_deduction_mm;
ALTER TABLE bom_templates RENAME COLUMN glass_height_deduction_mm TO infill_height_deduction_mm;

-- Decision 3: labor/silicone/felt per-template rate fields, same
-- precedent as waste_pct (template default, DEFAULT 0 so existing
-- templates keep computing the same total_cost until filled in).
ALTER TABLE bom_templates ADD COLUMN labor_price_per_sqm  NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE bom_templates ADD COLUMN silicone_price_per_m NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE bom_templates ADD COLUMN felt_price_per_m     NUMERIC NOT NULL DEFAULT 0;

-- Decision 5: one optional add-on unit per opening. All four nullable --
-- an opening with no add-on leaves them null and the add-on computation
-- is skipped entirely. addon_panel_count defaults to 1 like the main
-- unit's panel_count does. ON DELETE RESTRICT matches template_id's
-- existing behavior (a template with any opening referencing it can't
-- be hard-deleted).
ALTER TABLE estimation_openings ADD COLUMN addon_template_id UUID REFERENCES bom_templates(id) ON DELETE RESTRICT;
ALTER TABLE estimation_openings ADD COLUMN addon_width_m     NUMERIC;
ALTER TABLE estimation_openings ADD COLUMN addon_height_m    NUMERIC;
ALTER TABLE estimation_openings ADD COLUMN addon_panel_count INT NOT NULL DEFAULT 1;
```

- [ ] **Step 2: Apply the migration**

Use the `apply_migration` MCP tool (project_id `yyzbgdmgyvvypfcjuhtr`, name `bom_cost_factors`, query = the exact SQL above). Do not hand-run this via `execute_sql` — DDL goes through `apply_migration` per this project's tooling convention.

- [ ] **Step 3: Verify the rename preserved existing data and the new columns exist**

Run via `execute_sql`:
```sql
select table_name, column_name, data_type, column_default, is_nullable
from information_schema.columns
where table_name in ('infill_types','bom_templates','estimation_openings')
  and column_name in (
    'material_kind','infill_type_id','infill_width_deduction_mm','infill_height_deduction_mm',
    'labor_price_per_sqm','silicone_price_per_m','felt_price_per_m',
    'addon_template_id','addon_width_m','addon_height_m','addon_panel_count'
  )
order by table_name, column_name;
```
Expected: all 11 rows present, `material_kind` default `'glass'::text`, the three new `bom_templates` rate columns default `0`, `addon_panel_count` default `1`, the other three `addon_*` columns nullable with no default. Also run `select count(*) from infill_types;` and confirm it matches whatever `bom_glass_types` held before (the rename preserves row count/content exactly — this is a sanity check, not a real risk with `RENAME`).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/2026-09-29-02-bom-cost-factors.sql
git commit -m "feat: add BOM cost-factors migration (infill rename, labor/silicone/felt, add-on unit)"
```

---

## Task 2: `bomEngine.js` — rename glass→infill, add labor/silicone/felt cost lines

**Files:**
- Modify: `src/lib/bomEngine.js`
- Test: `src/lib/bomEngine.test.js`

**Interfaces:**
- Consumes: Task 1's column names (`bom_templates.infill_width_deduction_mm`/`infill_height_deduction_mm`/`labor_price_per_sqm`/`silicone_price_per_m`/`felt_price_per_m`).
- Produces: `computeBomForOpening(opening, template, components, hardware, profiles, finish, infillType)` — note the last parameter is renamed from `glassType` to `infillType`. Returns `{ profileLines, gridLines, hardwareLines, infillArea_sqm, infillCost, wasteCost, laborCost, siliconeCost, feltCost, extraLinesCost, totalCost, unresolvedComponents }` (renamed `glassArea_sqm`/`glassCost` → `infillArea_sqm`/`infillCost`; new `laborCost`/`siliconeCost`/`feltCost`). Task 5 and Task 6 (Estimation.jsx) and Task 4 (BomTemplates.jsx) consume these exact names.

- [ ] **Step 1: Update the existing tests to use the renamed field names (still red until Step 3)**

In `src/lib/bomEngine.test.js`, apply these exact replacements:

Replace the `baseTemplate` helper:
```javascript
function baseTemplate(overrides = {}) {
  return {
    waste_pct: 10,
    infill_width_deduction_mm: 80,
    infill_height_deduction_mm: 80,
    labor_price_per_sqm: 0,
    silicone_price_per_m: 0,
    felt_price_per_m: 0,
    grid_row_weights: [1],
    grid_horizontal_rail_family: null,
    grid_vertical_mullion_family: null,
    ...overrides,
  }
}
```

Then rename every occurrence in the file of `result.glassArea_sqm` to `result.infillArea_sqm` and `result.glassCost` to `result.infillCost`, and every occurrence of `glass_width_deduction_mm`/`glass_height_deduction_mm` in template overrides to `infill_width_deduction_mm`/`infill_height_deduction_mm`. The `describe('computeBomForOpening -- glass area, per cell', ...)` block's title becomes `describe('computeBomForOpening -- infill area, per cell', ...)`. The `GLASS` fixture constant stays named `GLASS` (it's just test data representing one infill catalog row — no rename needed there, only the template/result field names change).

- [ ] **Step 2: Run tests to confirm they fail on the old field names**

Run: `npx vitest run src/lib/bomEngine.test.js`
Expected: FAIL — `expect(result.infillArea_sqm)` etc. are `undefined` because `bomEngine.js` hasn't been updated yet.

- [ ] **Step 3: Update `bomEngine.js`**

Replace the full contents of `src/lib/bomEngine.js` with:

```javascript
// ============================================================
// Pure computation of a per-unit BOM and cost for one estimation_opening,
// given its bom_template and the reference catalogs it needs. No I/O --
// callers (BomTemplates.jsx's preview, Estimation.jsx) load every input
// once and call this on every keystroke. Mirrors the house style already
// used by inventoryCost.js.
//
// See docs/superpowers/specs/2026-09-10-bom-template-engine-design.md's
// "Business logic" section for the original engine, and
// docs/superpowers/specs/2026-09-29-bom-cost-factors-design.md for the
// infill generalization + labor/silicone/felt cost lines added here.
// Add-on unit aggregation happens at the CALLER (Estimation.jsx), not in
// this function -- this stays "one opening in, one BOM out."
// ============================================================

function resolveGrid(template, opening) {
  const rowWeights = template.grid_row_weights.length ? template.grid_row_weights : [1]
  const rowCount = rowWeights.length
  const columnCount = Math.max(1, opening.panel_count || 1)
  const rowWeightSum = rowWeights.reduce((s, w) => s + w, 0)
  const rowFractions = rowWeights.map(w => w / rowWeightSum)
  const cellWidth_m = opening.width_m / columnCount
  const cells = rowFractions.map(frac => ({ width_m: cellWidth_m, height_m: opening.height_m * frac }))
  return { rowCount, columnCount, cells }
}

function resolveProfile(profiles, family, series, thicknessMm) {
  return profiles.find(p => p.family === family && p.series === series && p.thickness_mm === thicknessMm) || null
}

function computeComponentLength(rule, deductionMm, widthM, heightM) {
  const deductionM = deductionMm / 1000
  if (rule === 'width') return widthM
  if (rule === 'height') return heightM
  if (rule === 'width_minus') return widthM - deductionM
  if (rule === 'height_minus') return heightM - deductionM
  if (rule === 'perimeter') return 2 * (widthM + heightM)
  throw new Error(`Unknown length_rule_type: ${rule}`)
}

function priceProfileLine({ role_name, family, length_m, quantity, profiles, opening, finish }) {
  const profile = resolveProfile(profiles, family, opening.series, opening.thickness_mm)
  const resolved = !!profile
  const weight_kg = resolved ? length_m * quantity * profile.linear_weight_kg_per_m : 0
  const cost = resolved ? weight_kg * finish.price_per_kg : 0
  return { role_name, family, series: opening.series, thickness_mm: opening.thickness_mm, length_m, quantity, weight_kg, cost, resolved }
}

export function computeBomForOpening(opening, template, components, hardware, profiles, finish, infillType) {
  const { rowCount, columnCount, cells } = resolveGrid(template, opening)

  // Grid-derived internal members (Business logic Step 2).
  const gridLines = []
  if (rowCount > 1 && template.grid_horizontal_rail_family) {
    for (let i = 0; i < rowCount - 1; i++) {
      gridLines.push({
        orientation: 'horizontal',
        ...priceProfileLine({
          role_name: 'Horizontal rail', family: template.grid_horizontal_rail_family,
          length_m: opening.width_m, quantity: 1, profiles, opening, finish,
        }),
      })
    }
  }
  if (columnCount > 1 && template.grid_vertical_mullion_family) {
    for (let i = 0; i < columnCount - 1; i++) {
      gridLines.push({
        orientation: 'vertical',
        ...priceProfileLine({
          role_name: 'Vertical mullion', family: template.grid_vertical_mullion_family,
          length_m: opening.height_m, quantity: 1, profiles, opening, finish,
        }),
      })
    }
  }

  // Explicit components (Business logic Step 3).
  const profileLines = (components || []).map(c => {
    const length_m = computeComponentLength(c.length_rule_type, c.length_deduction_mm, opening.width_m, opening.height_m)
    const quantity = c.quantity_basis === 'per_cell' ? c.quantity_value * rowCount * columnCount : c.quantity_value
    return priceProfileLine({ role_name: c.role_name, family: c.profile_family, length_m, quantity, profiles, opening, finish })
  })

  const unresolvedComponents = [...profileLines, ...gridLines].filter(l => !l.resolved).map(l => l.role_name)

  const aluminumSubtotal = [...profileLines, ...gridLines].reduce((s, l) => s + l.cost, 0)
  const wasteCost = aluminumSubtotal * (template.waste_pct / 100)

  const perimeter_m = 2 * (opening.width_m + opening.height_m)
  const hardwareLines = (hardware || []).map(h => {
    const quantity =
      h.quantity_basis === 'per_cell' ? h.quantity_value * rowCount * columnCount :
      h.quantity_basis === 'per_perimeter_m' ? h.quantity_value * perimeter_m :
      h.quantity_value
    return { name: h.name, quantity, cost: quantity * h.reference_unit_price }
  })

  let infillArea_sqm = 0
  if (infillType) {
    const wDed = template.infill_width_deduction_mm / 1000
    const hDed = template.infill_height_deduction_mm / 1000
    // Each entry in `cells` already represents one column's width (cellWidth_m
    // = width_m / columnCount) for that row -- so one row's total infill area
    // is columnCount identical cells, not a second loop over columns.
    for (const cell of cells) {
      infillArea_sqm += columnCount * Math.max(0, cell.width_m - wDed) * Math.max(0, cell.height_m - hDed)
    }
  }
  const infillCost = infillType ? infillArea_sqm * infillType.price_per_sqm : 0

  // New cost factors (2026-09-29 spec, Decision 3). Zero when the
  // template's rate is the default 0, so an unfilled-in template keeps
  // computing exactly the same totalCost as before this spec.
  const laborCost = opening.width_m * opening.height_m * template.labor_price_per_sqm
  const siliconeCost = perimeter_m * template.silicone_price_per_m
  const feltCost = perimeter_m * template.felt_price_per_m

  const extraLinesCost = (opening.extra_lines || []).reduce((s, l) => s + l.amount, 0)

  const totalCost = aluminumSubtotal + wasteCost + hardwareLines.reduce((s, l) => s + l.cost, 0) + infillCost
    + laborCost + siliconeCost + feltCost + extraLinesCost

  return {
    profileLines, gridLines, hardwareLines, infillArea_sqm, infillCost, wasteCost,
    laborCost, siliconeCost, feltCost, extraLinesCost, totalCost, unresolvedComponents,
  }
}
```

- [ ] **Step 4: Run tests to confirm the renamed fields pass**

Run: `npx vitest run src/lib/bomEngine.test.js`
Expected: PASS (all existing cases, now using the renamed field names).

- [ ] **Step 5: Add new test cases for labor/silicone/felt and infill material kinds**

Append to `src/lib/bomEngine.test.js`:

```javascript
describe('computeBomForOpening -- labor/silicone/felt cost lines', () => {
  it('labor = width x height x labor_price_per_sqm', () => {
    const template = baseTemplate({ labor_price_per_sqm: 500 })
    const result = computeBomForOpening(baseOpening({ width_m: 2, height_m: 3 }), template, [], [], [PROFILE], FINISH, null)
    expect(result.laborCost).toBeCloseTo(2 * 3 * 500)
  })

  it('silicone = perimeter x silicone_price_per_m', () => {
    const template = baseTemplate({ silicone_price_per_m: 40 })
    const result = computeBomForOpening(baseOpening({ width_m: 2, height_m: 3 }), template, [], [], [PROFILE], FINISH, null)
    expect(result.siliconeCost).toBeCloseTo(2 * (2 + 3) * 40)
  })

  it('felt = perimeter x felt_price_per_m', () => {
    const template = baseTemplate({ felt_price_per_m: 15 })
    const result = computeBomForOpening(baseOpening({ width_m: 2, height_m: 3 }), template, [], [], [PROFILE], FINISH, null)
    expect(result.feltCost).toBeCloseTo(2 * (2 + 3) * 15)
  })

  it('all three are zero at the default rate, and totalCost is unchanged from before this spec', () => {
    const result = computeBomForOpening(baseOpening(), baseTemplate(), [], [], [PROFILE], FINISH, null)
    expect(result.laborCost).toBe(0)
    expect(result.siliconeCost).toBe(0)
    expect(result.feltCost).toBe(0)
    expect(result.totalCost).toBeCloseTo(result.wasteCost) // no components/hardware/infill/extra_lines in this fixture
  })

  it('all three sum into totalCost alongside the existing factors', () => {
    const template = baseTemplate({ labor_price_per_sqm: 500, silicone_price_per_m: 40, felt_price_per_m: 15 })
    const result = computeBomForOpening(baseOpening({ width_m: 2, height_m: 3 }), template, [], [], [PROFILE], FINISH, null)
    expect(result.totalCost).toBeCloseTo(result.wasteCost + result.laborCost + result.siliconeCost + result.feltCost)
  })
})

describe('computeBomForOpening -- infill material kinds', () => {
  it('uses the same area x price formula regardless of material_kind', () => {
    const meshInfill = { price_per_sqm: 300, material_kind: 'mesh' }
    const template = baseTemplate({ infill_width_deduction_mm: 80, infill_height_deduction_mm: 80 })
    const result = computeBomForOpening(baseOpening({ width_m: 1, height_m: 1 }), template, [], [], [PROFILE], FINISH, meshInfill)
    expect(result.infillArea_sqm).toBeCloseTo(0.92 * 0.92)
    expect(result.infillCost).toBeCloseTo(0.92 * 0.92 * 300)
  })

  it('acp and solid_panel infill kinds compute identically to glass at the same price', () => {
    const template = baseTemplate({ infill_width_deduction_mm: 0, infill_height_deduction_mm: 0 })
    const acpResult = computeBomForOpening(baseOpening({ width_m: 1, height_m: 1 }), template, [], [], [PROFILE], FINISH, { price_per_sqm: 500, material_kind: 'acp' })
    const glassResult = computeBomForOpening(baseOpening({ width_m: 1, height_m: 1 }), template, [], [], [PROFILE], FINISH, { price_per_sqm: 500, material_kind: 'glass' })
    expect(acpResult.infillCost).toBeCloseTo(glassResult.infillCost)
  })
})
```

- [ ] **Step 6: Run the full test file to confirm everything passes**

Run: `npx vitest run src/lib/bomEngine.test.js`
Expected: PASS, all cases (existing + new).

- [ ] **Step 7: Commit**

```bash
git add src/lib/bomEngine.js src/lib/bomEngine.test.js
git commit -m "feat: rename glass to infill and add labor/silicone/felt cost lines in bomEngine"
```

---

## Task 3: `useSupabase.js` — rename `useBomGlassTypes` to `useInfillTypes`

**Files:**
- Modify: `src/hooks/useSupabase.js`

**Interfaces:**
- Consumes: Task 1's `infill_types` table name.
- Produces: `useInfillTypes()` hook (same shape as the old `useBomGlassTypes()`: `{ data, refetch }`, data is an array of `{ id, tenant_id, name, price_per_sqm, material_kind, active, created_at }` rows ordered by `name`). Task 4 and Task 5 import and call this.

- [ ] **Step 1: Find and replace the hook**

In `src/hooks/useSupabase.js`, find:
```javascript
export function useBomGlassTypes() {
  return useQuery(async () => {
    const { data, error } = await supabase.from('bom_glass_types').select('*').order('name')
    if (error) throw error
    return data
  })
}
```

Replace with:
```javascript
export function useInfillTypes() {
  return useQuery(async () => {
    const { data, error } = await supabase.from('infill_types').select('*').order('name')
    if (error) throw error
    return data
  })
}
```

- [ ] **Step 2: Confirm no other file still imports the old name**

Run: `grep -rn "useBomGlassTypes\|bom_glass_types" src/`
Expected: no matches (Task 4 and Task 5 will update the two remaining call sites in the same overall change — if this grep still shows hits after Tasks 4-5 are also done, something was missed).

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useSupabase.js
git commit -m "feat: rename useBomGlassTypes hook to useInfillTypes"
```

---

## Task 4: `BomTemplates.jsx` — infill material-kind UI + labor/silicone/felt rate inputs

**Files:**
- Modify: `src/pages/BomTemplates.jsx`

**Interfaces:**
- Consumes: Task 1's `infill_types`/`bom_templates` columns, Task 3's `useInfillTypes()` hook, Task 2's `bomEngine.js` (not directly called here, but this page manages the data `Estimation.jsx` feeds into it).
- Produces: no new exports — this is a leaf page component.

- [ ] **Step 1: Rename the import and the glass-types view**

Find:
```javascript
import { useBomTemplates, useAluminumFinishes, useBomGlassTypes } from '../hooks/useSupabase.js'
```
Replace with:
```javascript
import { useBomTemplates, useAluminumFinishes, useInfillTypes } from '../hooks/useSupabase.js'
```

- [ ] **Step 2: Rename `GlassTypeForm` to `InfillTypeForm` and add the material-kind selector**

Find the entire `GlassTypeForm` function:
```javascript
function GlassTypeForm({ initial, onSave, onCancel, loading }) {
  const [form, setForm, clearDraft] = useDraftForm('bom-glass-type-form', { name: '', price_per_sqm: '', active: true, ...initial }, !initial?.id)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  return (
    <form onSubmit={e => { e.preventDefault(); clearDraft(); onSave(form) }}>
      <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
        <div>
          <label className="label">ชื่อกระจก ★</label>
          <input className="input" required value={form.name} onChange={e => set('name', e.target.value)} placeholder="เช่น กระจกใส 10มม." />
        </div>
        <div>
          <label className="label">ราคา/ตร.ม. ★</label>
          <input className="input" required type="number" min="0" step="0.01" value={form.price_per_sqm} onChange={e => set('price_per_sqm', e.target.value)} />
        </div>
        {initial?.id && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
            <input type="checkbox" checked={form.active} onChange={e => set('active', e.target.checked)} />
            ใช้งานอยู่
          </label>
        )}
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-ghost" onClick={() => { clearDraft(); onCancel() }}>ยกเลิก</button>
        <button type="submit" className="btn btn-primary" disabled={loading}>{loading ? '⏳ กำลังบันทึก...' : '✅ บันทึก'}</button>
      </div>
    </form>
  )
}
```

Replace with:
```javascript
const MATERIAL_KIND_LABELS = { glass: 'กระจก', mesh: 'ตาข่าย', solid_panel: 'แผ่นทึบ', acp: 'อลูมิเนียมคอมโพสิต (ACP)' }

function InfillTypeForm({ initial, onSave, onCancel, loading }) {
  const [form, setForm, clearDraft] = useDraftForm('infill-type-form', { name: '', price_per_sqm: '', material_kind: 'glass', active: true, ...initial }, !initial?.id)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  return (
    <form onSubmit={e => { e.preventDefault(); clearDraft(); onSave(form) }}>
      <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
        <div>
          <label className="label">ชื่อวัสดุอุดช่อง ★</label>
          <input className="input" required value={form.name} onChange={e => set('name', e.target.value)} placeholder="เช่น กระจกใส 10มม." />
        </div>
        <div>
          <label className="label">ประเภทวัสดุ ★</label>
          <select className="input" required value={form.material_kind} onChange={e => set('material_kind', e.target.value)}>
            {Object.entries(MATERIAL_KIND_LABELS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select>
        </div>
        <div>
          <label className="label">ราคา/ตร.ม. ★</label>
          <input className="input" required type="number" min="0" step="0.01" value={form.price_per_sqm} onChange={e => set('price_per_sqm', e.target.value)} />
        </div>
        {initial?.id && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
            <input type="checkbox" checked={form.active} onChange={e => set('active', e.target.checked)} />
            ใช้งานอยู่
          </label>
        )}
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-ghost" onClick={() => { clearDraft(); onCancel() }}>ยกเลิก</button>
        <button type="submit" className="btn btn-primary" disabled={loading}>{loading ? '⏳ กำลังบันทึก...' : '✅ บันทึก'}</button>
      </div>
    </form>
  )
}
```

- [ ] **Step 3: Rename the template editor's glass-deduction fields to infill-deduction, and add the 3 new rate inputs**

Find, in `EMPTY_TEMPLATE_FORM`:
```javascript
const EMPTY_TEMPLATE_FORM = {
  name: '', category: 'window', waste_pct: '10',
  glass_width_deduction_mm: '0', glass_height_deduction_mm: '0',
  grid_row_weights: [1],
  grid_horizontal_rail_family: '', grid_vertical_mullion_family: '',
  active: true,
}
```
Replace with:
```javascript
const EMPTY_TEMPLATE_FORM = {
  name: '', category: 'window', waste_pct: '10',
  infill_width_deduction_mm: '0', infill_height_deduction_mm: '0',
  labor_price_per_sqm: '0', silicone_price_per_m: '0', felt_price_per_m: '0',
  grid_row_weights: [1],
  grid_horizontal_rail_family: '', grid_vertical_mullion_family: '',
  active: true,
}
```

Find, in `TemplateEditor`'s initial state (inside `useState(() => isNew ? EMPTY_TEMPLATE_FORM : { ... })`):
```javascript
  const [form, setForm] = useState(() => isNew ? EMPTY_TEMPLATE_FORM : {
    name: template.name, category: template.category, waste_pct: String(template.waste_pct),
    glass_width_deduction_mm: String(template.glass_width_deduction_mm), glass_height_deduction_mm: String(template.glass_height_deduction_mm),
    grid_row_weights: template.grid_row_weights, grid_horizontal_rail_family: template.grid_horizontal_rail_family || '',
    grid_vertical_mullion_family: template.grid_vertical_mullion_family || '', active: template.active,
  })
```
Replace with:
```javascript
  const [form, setForm] = useState(() => isNew ? EMPTY_TEMPLATE_FORM : {
    name: template.name, category: template.category, waste_pct: String(template.waste_pct),
    infill_width_deduction_mm: String(template.infill_width_deduction_mm), infill_height_deduction_mm: String(template.infill_height_deduction_mm),
    labor_price_per_sqm: String(template.labor_price_per_sqm), silicone_price_per_m: String(template.silicone_price_per_m), felt_price_per_m: String(template.felt_price_per_m),
    grid_row_weights: template.grid_row_weights, grid_horizontal_rail_family: template.grid_horizontal_rail_family || '',
    grid_vertical_mullion_family: template.grid_vertical_mullion_family || '', active: template.active,
  })
```

Find, in `handleSave`'s `payload`:
```javascript
      const payload = {
        name: form.name, category: form.category,
        waste_pct: parseFloat(form.waste_pct) || 0,
        glass_width_deduction_mm: parseFloat(form.glass_width_deduction_mm) || 0,
        glass_height_deduction_mm: parseFloat(form.glass_height_deduction_mm) || 0,
        grid_row_weights: form.grid_row_weights,
        grid_horizontal_rail_family: form.grid_horizontal_rail_family || null,
        grid_vertical_mullion_family: form.grid_vertical_mullion_family || null,
        active: form.active !== false,
      }
```
Replace with:
```javascript
      const payload = {
        name: form.name, category: form.category,
        waste_pct: parseFloat(form.waste_pct) || 0,
        infill_width_deduction_mm: parseFloat(form.infill_width_deduction_mm) || 0,
        infill_height_deduction_mm: parseFloat(form.infill_height_deduction_mm) || 0,
        labor_price_per_sqm: parseFloat(form.labor_price_per_sqm) || 0,
        silicone_price_per_m: parseFloat(form.silicone_price_per_m) || 0,
        felt_price_per_m: parseFloat(form.felt_price_per_m) || 0,
        grid_row_weights: form.grid_row_weights,
        grid_horizontal_rail_family: form.grid_horizontal_rail_family || null,
        grid_vertical_mullion_family: form.grid_vertical_mullion_family || null,
        active: form.active !== false,
      }
```

Find the waste/deduction input row in the JSX:
```javascript
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
        <div>
          <label className="label">เผื่อเสียเศษ (%)</label>
          <input className="input" disabled={!canEdit} type="number" min="0" step="0.1" value={form.waste_pct} onChange={e => set('waste_pct', e.target.value)} />
        </div>
        <div>
          <label className="label">หักระยะกระจก กว้าง (mm)</label>
          <input className="input" disabled={!canEdit} type="number" min="0" value={form.glass_width_deduction_mm} onChange={e => set('glass_width_deduction_mm', e.target.value)} />
        </div>
        <div>
          <label className="label">หักระยะกระจก สูง (mm)</label>
          <input className="input" disabled={!canEdit} type="number" min="0" value={form.glass_height_deduction_mm} onChange={e => set('glass_height_deduction_mm', e.target.value)} />
        </div>
      </div>
```
Replace with:
```javascript
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
        <div>
          <label className="label">เผื่อเสียเศษ (%)</label>
          <input className="input" disabled={!canEdit} type="number" min="0" step="0.1" value={form.waste_pct} onChange={e => set('waste_pct', e.target.value)} />
        </div>
        <div>
          <label className="label">หักระยะวัสดุอุดช่อง กว้าง (mm)</label>
          <input className="input" disabled={!canEdit} type="number" min="0" value={form.infill_width_deduction_mm} onChange={e => set('infill_width_deduction_mm', e.target.value)} />
        </div>
        <div>
          <label className="label">หักระยะวัสดุอุดช่อง สูง (mm)</label>
          <input className="input" disabled={!canEdit} type="number" min="0" value={form.infill_height_deduction_mm} onChange={e => set('infill_height_deduction_mm', e.target.value)} />
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
        <div>
          <label className="label">ค่าแรง (฿/ตร.ม.)</label>
          <input className="input" disabled={!canEdit} type="number" min="0" step="0.01" value={form.labor_price_per_sqm} onChange={e => set('labor_price_per_sqm', e.target.value)} />
        </div>
        <div>
          <label className="label">ซิลิโคน (฿/ม.)</label>
          <input className="input" disabled={!canEdit} type="number" min="0" step="0.01" value={form.silicone_price_per_m} onChange={e => set('silicone_price_per_m', e.target.value)} />
        </div>
        <div>
          <label className="label">สักหลาด (฿/ม.)</label>
          <input className="input" disabled={!canEdit} type="number" min="0" step="0.01" value={form.felt_price_per_m} onChange={e => set('felt_price_per_m', e.target.value)} />
        </div>
      </div>
```

- [ ] **Step 4: Rename the glass-types state, handlers, and table view in the default export**

Find:
```javascript
  const { data: templates, refetch: refetchTemplates } = useBomTemplates()
  const { data: finishes, refetch: refetchFinishes } = useAluminumFinishes()
  const { data: glassTypes, refetch: refetchGlassTypes } = useBomGlassTypes()

  const [showFinishForm, setShowFinishForm] = useState(false)
  const [editFinish, setEditFinish] = useState(null)
  const [savingFinish, setSavingFinish] = useState(false)
  const [deleteFinishId, setDeleteFinishId] = useState(null)

  const [showGlassForm, setShowGlassForm] = useState(false)
  const [editGlass, setEditGlass] = useState(null)
  const [savingGlass, setSavingGlass] = useState(false)
  const [deleteGlassId, setDeleteGlassId] = useState(null)
```
Replace with:
```javascript
  const { data: templates, refetch: refetchTemplates } = useBomTemplates()
  const { data: finishes, refetch: refetchFinishes } = useAluminumFinishes()
  const { data: infillTypes, refetch: refetchInfillTypes } = useInfillTypes()

  const [showFinishForm, setShowFinishForm] = useState(false)
  const [editFinish, setEditFinish] = useState(null)
  const [savingFinish, setSavingFinish] = useState(false)
  const [deleteFinishId, setDeleteFinishId] = useState(null)

  const [showInfillForm, setShowInfillForm] = useState(false)
  const [editInfill, setEditInfill] = useState(null)
  const [savingInfill, setSavingInfill] = useState(false)
  const [deleteInfillId, setDeleteInfillId] = useState(null)
```

Find:
```javascript
  const handleSaveGlass = async (form) => {
    setSavingGlass(true)
    try {
      const payload = { name: form.name, price_per_sqm: parseFloat(form.price_per_sqm) || 0, active: form.active !== false }
      const { error } = editGlass
        ? await supabase.from('bom_glass_types').update(payload).eq('id', editGlass.id)
        : await supabase.from('bom_glass_types').insert(payload)
      if (error) throw error
      setShowGlassForm(false); setEditGlass(null); refetchGlassTypes()
    } catch (e) { alert('บันทึกไม่สำเร็จ: ' + e.message) }
    finally { setSavingGlass(false) }
  }

  const handleDeleteGlass = async () => {
    if (!deleteGlassId) return
    const { error } = await supabase.from('bom_glass_types').delete().eq('id', deleteGlassId)
    if (!error) { setDeleteGlassId(null); refetchGlassTypes() }
    else alert('ลบไม่สำเร็จ (อาจมีการใช้งานผูกอยู่): ' + error.message)
  }
```
Replace with:
```javascript
  const handleSaveInfill = async (form) => {
    setSavingInfill(true)
    try {
      const payload = { name: form.name, price_per_sqm: parseFloat(form.price_per_sqm) || 0, material_kind: form.material_kind, active: form.active !== false }
      const { error } = editInfill
        ? await supabase.from('infill_types').update(payload).eq('id', editInfill.id)
        : await supabase.from('infill_types').insert(payload)
      if (error) throw error
      setShowInfillForm(false); setEditInfill(null); refetchInfillTypes()
    } catch (e) { alert('บันทึกไม่สำเร็จ: ' + e.message) }
    finally { setSavingInfill(false) }
  }

  const handleDeleteInfill = async () => {
    if (!deleteInfillId) return
    const { error } = await supabase.from('infill_types').delete().eq('id', deleteInfillId)
    if (!error) { setDeleteInfillId(null); refetchInfillTypes() }
    else alert('ลบไม่สำเร็จ (อาจมีการใช้งานผูกอยู่): ' + error.message)
  }
```

Find the tab button:
```javascript
        <button className={`btn btn-sm ${view === 'glass_types' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setView('glass_types')}>🪟 ชนิดกระจก</button>
```
Replace with:
```javascript
        <button className={`btn btn-sm ${view === 'infill_types' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setView('infill_types')}>🪟 วัสดุอุดช่อง</button>
```

Find the entire `glass_types` view block:
```javascript
      {view === 'glass_types' && (
        <>
          {canEdit && <button className="btn btn-primary" style={{ marginBottom: 14 }} onClick={() => { setEditGlass(null); setShowGlassForm(true) }}>+ เพิ่มชนิดกระจก</button>}
          <div className="card">
            <div className="table-wrap">
              <table>
                <thead><tr><th>ชื่อกระจก</th><th>ราคา/ตร.ม.</th><th>สถานะ</th><th></th></tr></thead>
                <tbody>
                  {(glassTypes || []).map(g => (
                    <tr key={g.id}>
                      <td style={{ fontWeight: 600 }}>{g.name}</td>
                      <td className="font-mono">{fmt(g.price_per_sqm)}</td>
                      <td>{g.active ? <span className="badge badge-paid">ใช้งานอยู่</span> : <span className="badge badge-finished">ปิดใช้งาน</span>}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {canEdit && (
                          <>
                            <button className="btn btn-sm btn-ghost" onClick={() => { setEditGlass(g); setShowGlassForm(true) }}>แก้ไข</button>
                            <button className="btn btn-sm btn-ghost" style={{ color: 'var(--red)' }} onClick={() => setDeleteGlassId(g.id)}>ลบ</button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                  {!(glassTypes || []).length && <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--text3)', padding: 24 }}>ยังไม่มีชนิดกระจก</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
```
Replace with:
```javascript
      {view === 'infill_types' && (
        <>
          {canEdit && <button className="btn btn-primary" style={{ marginBottom: 14 }} onClick={() => { setEditInfill(null); setShowInfillForm(true) }}>+ เพิ่มวัสดุอุดช่อง</button>}
          <div className="card">
            <div className="table-wrap">
              <table>
                <thead><tr><th>ชื่อวัสดุ</th><th>ประเภท</th><th>ราคา/ตร.ม.</th><th>สถานะ</th><th></th></tr></thead>
                <tbody>
                  {(infillTypes || []).map(g => (
                    <tr key={g.id}>
                      <td style={{ fontWeight: 600 }}>{g.name}</td>
                      <td>{MATERIAL_KIND_LABELS[g.material_kind] || g.material_kind}</td>
                      <td className="font-mono">{fmt(g.price_per_sqm)}</td>
                      <td>{g.active ? <span className="badge badge-paid">ใช้งานอยู่</span> : <span className="badge badge-finished">ปิดใช้งาน</span>}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {canEdit && (
                          <>
                            <button className="btn btn-sm btn-ghost" onClick={() => { setEditInfill(g); setShowInfillForm(true) }}>แก้ไข</button>
                            <button className="btn btn-sm btn-ghost" style={{ color: 'var(--red)' }} onClick={() => setDeleteInfillId(g.id)}>ลบ</button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                  {!(infillTypes || []).length && <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--text3)', padding: 24 }}>ยังไม่มีวัสดุอุดช่อง</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
```

Find the modal + confirm-delete block at the bottom:
```javascript
      {showGlassForm && (
        <Modal title={editGlass ? `แก้ไข ${editGlass.name}` : 'เพิ่มชนิดกระจกใหม่'} onClose={() => { setShowGlassForm(false); setEditGlass(null) }} maxWidth={420}>
          <GlassTypeForm initial={editGlass || {}} onSave={handleSaveGlass} onCancel={() => { setShowGlassForm(false); setEditGlass(null) }} loading={savingGlass} />
        </Modal>
      )}
      {deleteGlassId && <ConfirmDialog title="ลบชนิดกระจก" message="ยืนยันการลบ?" onConfirm={handleDeleteGlass} onCancel={() => setDeleteGlassId(null)} />}
```
Replace with:
```javascript
      {showInfillForm && (
        <Modal title={editInfill ? `แก้ไข ${editInfill.name}` : 'เพิ่มวัสดุอุดช่องใหม่'} onClose={() => { setShowInfillForm(false); setEditInfill(null) }} maxWidth={420}>
          <InfillTypeForm initial={editInfill || {}} onSave={handleSaveInfill} onCancel={() => { setShowInfillForm(false); setEditInfill(null) }} loading={savingInfill} />
        </Modal>
      )}
      {deleteInfillId && <ConfirmDialog title="ลบวัสดุอุดช่อง" message="ยืนยันการลบ?" onConfirm={handleDeleteInfill} onCancel={() => setDeleteInfillId(null)} />}
```

- [ ] **Step 5: Confirm no stray references remain**

Run: `grep -n "glass\|Glass" src/pages/BomTemplates.jsx`
Expected: no matches (every "glass" reference in this file has been renamed to "infill" by this point). If any remain, they were missed in Steps 1-4 — fix before proceeding.

- [ ] **Step 6: Manual smoke test**

Run `npm run dev`, log in as an OWNER/ADMIN test account, open BOM Templates → วัสดุอุดช่อง tab, add a new infill type with `material_kind: 'mesh'`, confirm it saves and lists with the Thai label "ตาข่าย". Open a template, confirm the 3 new rate inputs (ค่าแรง/ซิลิโคน/สักหลาด) render and save correctly (reload the page, reopen the template, confirm the values persisted).

- [ ] **Step 7: Commit**

```bash
git add src/pages/BomTemplates.jsx
git commit -m "feat: rename glass UI to infill (material_kind selector) and add labor/silicone/felt rate inputs"
```

---

## Task 5: `Estimation.jsx` — infill rename + labor/silicone/felt in the BOM summary

**Files:**
- Modify: `src/pages/Estimation.jsx`

**Interfaces:**
- Consumes: Task 1's `estimation_openings.infill_type_id` column, Task 2's `computeBomForOpening`'s renamed/extended return shape (`infillArea_sqm`, `infillCost`, `laborCost`, `siliconeCost`, `feltCost`), Task 3's `useInfillTypes()` hook.
- Produces: no new exports. Task 6 (add-on unit) builds directly on top of the `OpeningEditor` component this task updates — do this task first.

- [ ] **Step 1: Rename the import**

Find:
```javascript
import {
  useEstimationProjects, useEstimationOpenings, useBomTemplates, useBomTemplateComponents,
  useBomTemplateHardware, useBomTemplateConstraints, useAluminumFinishes, useBomGlassTypes, useAluminumProfiles,
} from '../hooks/useSupabase.js'
```
Replace with:
```javascript
import {
  useEstimationProjects, useEstimationOpenings, useBomTemplates, useBomTemplateComponents,
  useBomTemplateHardware, useBomTemplateConstraints, useAluminumFinishes, useInfillTypes, useAluminumProfiles,
} from '../hooks/useSupabase.js'
```

- [ ] **Step 2: Rename `glassTypes`/`glass_type_id` throughout `OpeningEditor`**

Find the `OpeningEditor` function signature and its initial form state:
```javascript
function OpeningEditor({ opening, projectId, templates, components, hardware, constraints, profiles, finishes, glassTypes, onSaved, canEdit }) {
  const isNew = !opening?.id
  const [form, setForm] = useState(() => isNew ? {
    opening_no: '', template_id: '', series: '', thickness_mm: '', finish_id: '', glass_type_id: '',
    width_m: '', height_m: '', panel_count: '1', quantity: '1', extra_lines: [],
  } : {
    opening_no: opening.opening_no, template_id: opening.template_id, series: opening.series, thickness_mm: String(opening.thickness_mm),
    finish_id: opening.finish_id, glass_type_id: opening.glass_type_id || '',
    width_m: String(opening.width_m), height_m: String(opening.height_m),
    panel_count: String(opening.panel_count), quantity: String(opening.quantity), extra_lines: opening.extra_lines || [],
  })
```
Replace with:
```javascript
function OpeningEditor({ opening, projectId, templates, components, hardware, constraints, profiles, finishes, infillTypes, onSaved, canEdit }) {
  const isNew = !opening?.id
  const [form, setForm] = useState(() => isNew ? {
    opening_no: '', template_id: '', series: '', thickness_mm: '', finish_id: '', infill_type_id: '',
    width_m: '', height_m: '', panel_count: '1', quantity: '1', extra_lines: [],
  } : {
    opening_no: opening.opening_no, template_id: opening.template_id, series: opening.series, thickness_mm: String(opening.thickness_mm),
    finish_id: opening.finish_id, infill_type_id: opening.infill_type_id || '',
    width_m: String(opening.width_m), height_m: String(opening.height_m),
    panel_count: String(opening.panel_count), quantity: String(opening.quantity), extra_lines: opening.extra_lines || [],
  })
```

Find:
```javascript
  const finish = (finishes || []).find(f => f.id === form.finish_id)
  const glassType = (glassTypes || []).find(g => g.id === form.glass_type_id)
```
Replace with:
```javascript
  const finish = (finishes || []).find(f => f.id === form.finish_id)
  const infillType = (infillTypes || []).find(g => g.id === form.infill_type_id)
```

Find, inside the `bom` `useMemo`:
```javascript
  const bom = useMemo(() => {
    if (!template || !finish || !numericOpening.width_m || !numericOpening.height_m || !numericOpening.series || !numericOpening.thickness_mm) return null
    return computeBomForOpening(numericOpening, template, templateComponents, templateHardware, profiles || [], finish, glassType || null)
  }, [template, finish, glassType, numericOpening, templateComponents, templateHardware, profiles])
```
Replace with:
```javascript
  const bom = useMemo(() => {
    if (!template || !finish || !numericOpening.width_m || !numericOpening.height_m || !numericOpening.series || !numericOpening.thickness_mm) return null
    return computeBomForOpening(numericOpening, template, templateComponents, templateHardware, profiles || [], finish, infillType || null)
  }, [template, finish, infillType, numericOpening, templateComponents, templateHardware, profiles])
```

Find, in `handleSave`'s `payload`:
```javascript
      const payload = {
        project_id: projectId, opening_no: form.opening_no, template_id: form.template_id,
        series: form.series, thickness_mm: parseFloat(form.thickness_mm) || 0,
        finish_id: form.finish_id, glass_type_id: form.glass_type_id || null,
        width_m: parseFloat(form.width_m) || 0, height_m: parseFloat(form.height_m) || 0,
        panel_count: parseInt(form.panel_count, 10) || 1, quantity: parseInt(form.quantity, 10) || 1,
        extra_lines: numericOpening.extra_lines,
      }
```
Replace with:
```javascript
      const payload = {
        project_id: projectId, opening_no: form.opening_no, template_id: form.template_id,
        series: form.series, thickness_mm: parseFloat(form.thickness_mm) || 0,
        finish_id: form.finish_id, infill_type_id: form.infill_type_id || null,
        width_m: parseFloat(form.width_m) || 0, height_m: parseFloat(form.height_m) || 0,
        panel_count: parseInt(form.panel_count, 10) || 1, quantity: parseInt(form.quantity, 10) || 1,
        extra_lines: numericOpening.extra_lines,
      }
```

Find the glass picker in the JSX:
```javascript
        <div>
          <label className="label">ชนิดกระจก</label>
          <SearchableSelect disabled={!canEdit} value={form.glass_type_id} onChange={v => set('glass_type_id', v)}
            options={(glassTypes || []).filter(g => g.active).map(g => ({ value: g.id, label: g.name, keywords: g.name }))} placeholder="ไม่มีกระจก" />
        </div>
```
Replace with:
```javascript
        <div>
          <label className="label">วัสดุอุดช่อง</label>
          <SearchableSelect disabled={!canEdit} value={form.infill_type_id} onChange={v => set('infill_type_id', v)}
            options={(infillTypes || []).filter(g => g.active).map(g => ({ value: g.id, label: g.name, keywords: g.name }))} placeholder="ไม่มีวัสดุอุดช่อง" />
        </div>
```

- [ ] **Step 3: Rename the BOM summary's glass row and add labor/silicone/felt rows**

Find:
```javascript
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
            <span>เผื่อเสียเศษ</span><span className="font-mono">{fmt(bom.wasteCost)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
            <span>กระจก ({bom.glassArea_sqm.toFixed(2)} ตร.ม.)</span><span className="font-mono">{fmt(bom.glassCost)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
            <span>รายการเพิ่มเติม</span><span className="font-mono">{fmt(bom.extraLinesCost)}</span>
          </div>
```
Replace with:
```javascript
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
            <span>เผื่อเสียเศษ</span><span className="font-mono">{fmt(bom.wasteCost)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
            <span>วัสดุอุดช่อง ({bom.infillArea_sqm.toFixed(2)} ตร.ม.)</span><span className="font-mono">{fmt(bom.infillCost)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
            <span>ค่าแรง</span><span className="font-mono">{fmt(bom.laborCost)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
            <span>ซิลิโคน</span><span className="font-mono">{fmt(bom.siliconeCost)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
            <span>สักหลาด</span><span className="font-mono">{fmt(bom.feltCost)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
            <span>รายการเพิ่มเติม</span><span className="font-mono">{fmt(bom.extraLinesCost)}</span>
          </div>
```

- [ ] **Step 4: Rename the hook call in the default export**

Find:
```javascript
  const { data: glassTypes } = useBomGlassTypes()
```
Replace with:
```javascript
  const { data: infillTypes } = useInfillTypes()
```

Find both `OpeningEditor` usages (creating and editing) and rename the `glassTypes` prop to `infillTypes`:
```javascript
            {creatingOpening && (
              <OpeningEditor key="new" opening={null} projectId={selectedProjectId} templates={templates} components={components} hardware={hardware}
                constraints={constraints} profiles={profiles} finishes={finishes} glassTypes={glassTypes} canEdit={canEdit}
                onSaved={() => { setCreatingOpening(false); refetchOpenings() }} />
            )}
            {editingOpeningId && (
              <OpeningEditor key={editingOpeningId} opening={projectOpenings.find(o => o.id === editingOpeningId)} projectId={selectedProjectId} templates={templates} components={components}
                hardware={hardware} constraints={constraints} profiles={profiles} finishes={finishes} glassTypes={glassTypes} canEdit={canEdit}
                onSaved={() => { setEditingOpeningId(null); refetchOpenings() }} />
            )}
```
Replace with:
```javascript
            {creatingOpening && (
              <OpeningEditor key="new" opening={null} projectId={selectedProjectId} templates={templates} components={components} hardware={hardware}
                constraints={constraints} profiles={profiles} finishes={finishes} infillTypes={infillTypes} canEdit={canEdit}
                onSaved={() => { setCreatingOpening(false); refetchOpenings() }} />
            )}
            {editingOpeningId && (
              <OpeningEditor key={editingOpeningId} opening={projectOpenings.find(o => o.id === editingOpeningId)} projectId={selectedProjectId} templates={templates} components={components}
                hardware={hardware} constraints={constraints} profiles={profiles} finishes={finishes} infillTypes={infillTypes} canEdit={canEdit}
                onSaved={() => { setEditingOpeningId(null); refetchOpenings() }} />
            )}
```

- [ ] **Step 5: Confirm no stray references remain**

Run: `grep -n "glass\|Glass" src/pages/Estimation.jsx`
Expected: no matches at this point in the file *outside* the parts Task 6 will still add (Task 6 doesn't reintroduce "glass" anywhere — if this grep is clean now, it stays clean after Task 6 too).

- [ ] **Step 6: Manual smoke test**

Run `npm run dev`, open Estimation, open an existing opening (or create one against a template that has non-zero waste/labor/silicone/felt rates from Task 4's smoke test), confirm the BOM summary shows the renamed "วัสดุอุดช่อง" row and the three new "ค่าแรง"/"ซิลิโคน"/"สักหลาด" rows with correct non-zero values, and that `totalCost` visibly includes them.

- [ ] **Step 7: Commit**

```bash
git add src/pages/Estimation.jsx
git commit -m "feat: rename glass to infill and show labor/silicone/felt in the Estimation BOM summary"
```

---

## Task 6: `Estimation.jsx` — add-on unit (toggle, fields, second BOM computation, combined total)

**Files:**
- Modify: `src/pages/Estimation.jsx`

**Interfaces:**
- Consumes: Task 1's `estimation_openings.addon_template_id`/`addon_width_m`/`addon_height_m`/`addon_panel_count` columns, Task 2's `computeBomForOpening` (called a second time here, unmodified contract).
- Produces: no new exports.

- [ ] **Step 1: Add add-on fields to the form state**

Find the `OpeningEditor` initial form state (as updated by Task 5):
```javascript
  const [form, setForm] = useState(() => isNew ? {
    opening_no: '', template_id: '', series: '', thickness_mm: '', finish_id: '', infill_type_id: '',
    width_m: '', height_m: '', panel_count: '1', quantity: '1', extra_lines: [],
  } : {
    opening_no: opening.opening_no, template_id: opening.template_id, series: opening.series, thickness_mm: String(opening.thickness_mm),
    finish_id: opening.finish_id, infill_type_id: opening.infill_type_id || '',
    width_m: String(opening.width_m), height_m: String(opening.height_m),
    panel_count: String(opening.panel_count), quantity: String(opening.quantity), extra_lines: opening.extra_lines || [],
  })
```
Replace with:
```javascript
  const [form, setForm] = useState(() => isNew ? {
    opening_no: '', template_id: '', series: '', thickness_mm: '', finish_id: '', infill_type_id: '',
    width_m: '', height_m: '', panel_count: '1', quantity: '1', extra_lines: [],
    has_addon: false, addon_template_id: '', addon_width_m: '', addon_height_m: '', addon_panel_count: '1',
  } : {
    opening_no: opening.opening_no, template_id: opening.template_id, series: opening.series, thickness_mm: String(opening.thickness_mm),
    finish_id: opening.finish_id, infill_type_id: opening.infill_type_id || '',
    width_m: String(opening.width_m), height_m: String(opening.height_m),
    panel_count: String(opening.panel_count), quantity: String(opening.quantity), extra_lines: opening.extra_lines || [],
    has_addon: !!opening.addon_template_id,
    addon_template_id: opening.addon_template_id || '', addon_width_m: opening.addon_width_m != null ? String(opening.addon_width_m) : '',
    addon_height_m: opening.addon_height_m != null ? String(opening.addon_height_m) : '', addon_panel_count: String(opening.addon_panel_count || 1),
  })
```

- [ ] **Step 2: Resolve the add-on template and compute its own BOM**

Find:
```javascript
  const template = (templates || []).find(t => t.id === form.template_id)
  const templateComponents = (components || []).filter(c => c.template_id === form.template_id)
  const templateHardware = (hardware || []).filter(h => h.template_id === form.template_id)
  const templateConstraints = (constraints || []).filter(c => c.template_id === form.template_id)
  const finish = (finishes || []).find(f => f.id === form.finish_id)
  const infillType = (infillTypes || []).find(g => g.id === form.infill_type_id)
```
Replace with:
```javascript
  const template = (templates || []).find(t => t.id === form.template_id)
  const templateComponents = (components || []).filter(c => c.template_id === form.template_id)
  const templateHardware = (hardware || []).filter(h => h.template_id === form.template_id)
  const templateConstraints = (constraints || []).filter(c => c.template_id === form.template_id)
  const finish = (finishes || []).find(f => f.id === form.finish_id)
  const infillType = (infillTypes || []).find(g => g.id === form.infill_type_id)

  const addonTemplate = form.has_addon ? (templates || []).find(t => t.id === form.addon_template_id) : null
  const addonComponents = (components || []).filter(c => c.template_id === form.addon_template_id)
  const addonHardware = (hardware || []).filter(h => h.template_id === form.addon_template_id)
```

Find the `numericOpening` memo:
```javascript
  const numericOpening = useMemo(() => ({
    width_m: parseFloat(form.width_m) || 0,
    height_m: parseFloat(form.height_m) || 0,
    panel_count: parseInt(form.panel_count, 10) || 1,
    series: form.series,
    thickness_mm: parseFloat(form.thickness_mm) || 0,
    quantity: parseInt(form.quantity, 10) || 1,
    extra_lines: form.extra_lines.map(l => ({ description: l.description, amount: parseFloat(l.amount) || 0 })),
  }), [form])
```
Replace with:
```javascript
  const numericOpening = useMemo(() => ({
    width_m: parseFloat(form.width_m) || 0,
    height_m: parseFloat(form.height_m) || 0,
    panel_count: parseInt(form.panel_count, 10) || 1,
    series: form.series,
    thickness_mm: parseFloat(form.thickness_mm) || 0,
    quantity: parseInt(form.quantity, 10) || 1,
    extra_lines: form.extra_lines.map(l => ({ description: l.description, amount: parseFloat(l.amount) || 0 })),
  }), [form])

  // Add-on unit shares the main opening's series/thickness_mm (spec
  // Decision 5) -- it has no selectors of its own for these, and no
  // extra_lines of its own (one adjustment-line list per opening).
  const numericAddon = useMemo(() => ({
    width_m: parseFloat(form.addon_width_m) || 0,
    height_m: parseFloat(form.addon_height_m) || 0,
    panel_count: parseInt(form.addon_panel_count, 10) || 1,
    series: form.series,
    thickness_mm: parseFloat(form.thickness_mm) || 0,
    quantity: 1,
    extra_lines: [],
  }), [form])
```

Find the `bom` memo:
```javascript
  const bom = useMemo(() => {
    if (!template || !finish || !numericOpening.width_m || !numericOpening.height_m || !numericOpening.series || !numericOpening.thickness_mm) return null
    return computeBomForOpening(numericOpening, template, templateComponents, templateHardware, profiles || [], finish, infillType || null)
  }, [template, finish, infillType, numericOpening, templateComponents, templateHardware, profiles])
```
Replace with:
```javascript
  const bom = useMemo(() => {
    if (!template || !finish || !numericOpening.width_m || !numericOpening.height_m || !numericOpening.series || !numericOpening.thickness_mm) return null
    return computeBomForOpening(numericOpening, template, templateComponents, templateHardware, profiles || [], finish, infillType || null)
  }, [template, finish, infillType, numericOpening, templateComponents, templateHardware, profiles])

  // Add-on aggregation happens HERE, at the call site -- computeBomForOpening
  // itself stays "one opening in, one BOM out" (spec Business logic).
  // Requires all three of template/width/height before attempting a
  // computation (spec Error handling: partially-filled add-on = "no
  // add-on yet", not an error).
  const addonBom = useMemo(() => {
    if (!form.has_addon || !addonTemplate || !finish || !numericAddon.width_m || !numericAddon.height_m) return null
    return computeBomForOpening(numericAddon, addonTemplate, addonComponents, addonHardware, profiles || [], finish, infillType || null)
  }, [form.has_addon, addonTemplate, finish, infillType, numericAddon, addonComponents, addonHardware, profiles])

  const combinedTotalCost = bom ? bom.totalCost + (addonBom ? addonBom.totalCost : 0) : null
```

- [ ] **Step 3: Include add-on fields in the save payload**

Find, in `handleSave`'s `payload` (as updated by Task 5):
```javascript
      const payload = {
        project_id: projectId, opening_no: form.opening_no, template_id: form.template_id,
        series: form.series, thickness_mm: parseFloat(form.thickness_mm) || 0,
        finish_id: form.finish_id, infill_type_id: form.infill_type_id || null,
        width_m: parseFloat(form.width_m) || 0, height_m: parseFloat(form.height_m) || 0,
        panel_count: parseInt(form.panel_count, 10) || 1, quantity: parseInt(form.quantity, 10) || 1,
        extra_lines: numericOpening.extra_lines,
      }
```
Replace with:
```javascript
      const payload = {
        project_id: projectId, opening_no: form.opening_no, template_id: form.template_id,
        series: form.series, thickness_mm: parseFloat(form.thickness_mm) || 0,
        finish_id: form.finish_id, infill_type_id: form.infill_type_id || null,
        width_m: parseFloat(form.width_m) || 0, height_m: parseFloat(form.height_m) || 0,
        panel_count: parseInt(form.panel_count, 10) || 1, quantity: parseInt(form.quantity, 10) || 1,
        extra_lines: numericOpening.extra_lines,
        addon_template_id: form.has_addon ? (form.addon_template_id || null) : null,
        addon_width_m: form.has_addon ? (parseFloat(form.addon_width_m) || null) : null,
        addon_height_m: form.has_addon ? (parseFloat(form.addon_height_m) || null) : null,
        addon_panel_count: form.has_addon ? (parseInt(form.addon_panel_count, 10) || 1) : 1,
      }
```

- [ ] **Step 4: Add the add-on toggle + fields to the JSX, after the extra-lines block**

Find:
```javascript
      <div>
        <div style={{ fontWeight: 700, marginBottom: 6, fontSize: 13 }}>รายการเพิ่มเติม (Fire Barrier, ดัดโค้ง, ฯลฯ)</div>
        <div style={{ display: 'grid', gap: 6 }}>
          {form.extra_lines.map((l, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 140px 32px', gap: 6 }}>
              <input className="input input-sm" disabled={!canEdit} placeholder="รายละเอียด" value={l.description} onChange={e => setExtraLine(i, 'description', e.target.value)} />
              <input className="input input-sm" disabled={!canEdit} type="number" placeholder="จำนวนเงิน" value={l.amount} onChange={e => setExtraLine(i, 'amount', e.target.value)} />
              {canEdit && <button type="button" className="btn btn-sm btn-ghost" style={{ color: 'var(--red)' }} onClick={() => removeExtraLine(i)}>✕</button>}
            </div>
          ))}
          {canEdit && <button type="button" className="btn btn-sm btn-ghost" style={{ justifySelf: 'start' }} onClick={addExtraLine}>+ เพิ่มรายการ</button>}
        </div>
      </div>

      {violations.map((msg, i) => (
```
Replace with:
```javascript
      <div>
        <div style={{ fontWeight: 700, marginBottom: 6, fontSize: 13 }}>รายการเพิ่มเติม (Fire Barrier, ดัดโค้ง, ฯลฯ)</div>
        <div style={{ display: 'grid', gap: 6 }}>
          {form.extra_lines.map((l, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 140px 32px', gap: 6 }}>
              <input className="input input-sm" disabled={!canEdit} placeholder="รายละเอียด" value={l.description} onChange={e => setExtraLine(i, 'description', e.target.value)} />
              <input className="input input-sm" disabled={!canEdit} type="number" placeholder="จำนวนเงิน" value={l.amount} onChange={e => setExtraLine(i, 'amount', e.target.value)} />
              {canEdit && <button type="button" className="btn btn-sm btn-ghost" style={{ color: 'var(--red)' }} onClick={() => removeExtraLine(i)}>✕</button>}
            </div>
          ))}
          {canEdit && <button type="button" className="btn btn-sm btn-ghost" style={{ justifySelf: 'start' }} onClick={addExtraLine}>+ เพิ่มรายการ</button>}
        </div>
      </div>

      <div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13, fontWeight: 700, marginBottom: form.has_addon ? 8 : 0 }}>
          <input type="checkbox" disabled={!canEdit} checked={form.has_addon} onChange={e => set('has_addon', e.target.checked)} />
          มีชุดต่อเติม (Add-on unit — เช่น ช่องแสงเหนือประตู)
        </label>
        {form.has_addon && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 10 }}>
            <div style={{ gridColumn: 'span 2' }}>
              <label className="label">Template ชุดต่อเติม ★</label>
              <SearchableSelect required disabled={!canEdit} value={form.addon_template_id} onChange={v => set('addon_template_id', v)}
                options={(templates || []).filter(t => t.active).map(t => ({ value: t.id, label: t.name, keywords: t.name }))} />
            </div>
            <div>
              <label className="label">กว้าง (m) ★</label>
              <input className="input" required disabled={!canEdit} type="number" min="0" step="0.01" value={form.addon_width_m} onChange={e => set('addon_width_m', e.target.value)} />
            </div>
            <div>
              <label className="label">สูง (m) ★</label>
              <input className="input" required disabled={!canEdit} type="number" min="0" step="0.01" value={form.addon_height_m} onChange={e => set('addon_height_m', e.target.value)} />
            </div>
            <div>
              <label className="label">จำนวนช่อง (panel)</label>
              <input className="input" disabled={!canEdit} type="number" min="1" value={form.addon_panel_count} onChange={e => set('addon_panel_count', e.target.value)} />
            </div>
          </div>
        )}
      </div>

      {violations.map((msg, i) => (
```

- [ ] **Step 5: Show the add-on's own BOM sub-block and the combined total**

Find the end of the main BOM summary card:
```javascript
          <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, borderTop: '1px solid var(--border, #ddd)', marginTop: 6, paddingTop: 6 }}>
            <span>รวมต่อชุด</span><span className="font-mono">{fmt(bom.totalCost)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700 }}>
            <span>รวม x{numericOpening.quantity} ชุด</span><span className="font-mono">{fmt(bom.totalCost * numericOpening.quantity)}</span>
          </div>
        </div>
      )}
```
Replace with:
```javascript
          <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, borderTop: '1px solid var(--border, #ddd)', marginTop: 6, paddingTop: 6 }}>
            <span>รวมต่อชุด (ชุดหลัก)</span><span className="font-mono">{fmt(bom.totalCost)}</span>
          </div>
        </div>
      )}

      {addonBom && (
        <div className="card" style={{ padding: 12, background: 'var(--bg2, #f7f7f7)', border: '1px dashed var(--border, #ccc)' }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>ชุดต่อเติม: {addonTemplate?.name}</div>
          {[...addonBom.profileLines, ...addonBom.gridLines].map((l, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: l.resolved ? 'inherit' : 'var(--red)' }}>
              <span>{l.role_name} {!l.resolved && '(ไม่พบหน้าตัดที่ตรงกัน)'}</span>
              <span className="font-mono">{fmt(l.cost)}</span>
            </div>
          ))}
          {addonBom.hardwareLines.map((l, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
              <span>{l.name} x{l.quantity}</span>
              <span className="font-mono">{fmt(l.cost)}</span>
            </div>
          ))}
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
            <span>เผื่อเสียเศษ</span><span className="font-mono">{fmt(addonBom.wasteCost)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
            <span>วัสดุอุดช่อง ({addonBom.infillArea_sqm.toFixed(2)} ตร.ม.)</span><span className="font-mono">{fmt(addonBom.infillCost)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
            <span>ค่าแรง</span><span className="font-mono">{fmt(addonBom.laborCost)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
            <span>ซิลิโคน</span><span className="font-mono">{fmt(addonBom.siliconeCost)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
            <span>สักหลาด</span><span className="font-mono">{fmt(addonBom.feltCost)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, borderTop: '1px solid var(--border, #ddd)', marginTop: 6, paddingTop: 6 }}>
            <span>รวมต่อชุด (ชุดต่อเติม)</span><span className="font-mono">{fmt(addonBom.totalCost)}</span>
          </div>
        </div>
      )}

      {combinedTotalCost != null && (
        <div className="card" style={{ padding: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700 }}>
            <span>รวมทั้งช่องเปิด (ชุดหลัก{addonBom ? ' + ชุดต่อเติม' : ''})</span><span className="font-mono">{fmt(combinedTotalCost)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700 }}>
            <span>รวม x{numericOpening.quantity} ชุด</span><span className="font-mono">{fmt(combinedTotalCost * numericOpening.quantity)}</span>
          </div>
        </div>
      )}
```

- [ ] **Step 6: Run the full test suite to confirm nothing else broke**

Run: `npx vitest run`
Expected: PASS, all files (this task doesn't touch `bomEngine.js`/`bomEngine.test.js` again, but this confirms the app still builds cleanly with these JSX changes — Vite/Vitest will catch a syntax error immediately).

- [ ] **Step 7: Manual smoke test — reconstruct a real add-on example**

Per the spec's Testing section: using `Aluminium calculation_270116-1.xlsx`'s sliding-door + transom-light example (password `261`, rows ~267-317) as a rough reference, in the running app (`npm run dev`):
1. In BOM Templates, create two simple templates (e.g. "Sliding Door — Main" and "Transom Light — Add-on") each with at least one component so they resolve to a non-zero cost.
2. In Estimation, create a new project and one opening using the main template, then tick "มีชุดต่อเติม", pick the add-on template, and enter its own width/height.
3. Confirm: the add-on's own BOM sub-block renders with a distinct total, the combined total equals main + add-on, and saving + reopening the opening restores the add-on toggle checked with the same values.
4. Untick the add-on toggle on an opening that had one, save, reopen — confirm the add-on fields cleared (`addon_template_id` etc. saved as `null`) and only the main unit's total shows.

- [ ] **Step 8: Commit**

```bash
git add src/pages/Estimation.jsx
git commit -m "feat: add optional add-on unit to Estimation openings (toggle, fields, combined BOM total)"
```

---

## Task 7: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npx vitest run`
Expected: PASS, every test file (this project's full suite, not just the ones touched by this plan).

- [ ] **Step 2: Run a production build**

Run: `npm run build`
Expected: builds cleanly with no errors (this catches any remaining reference to a renamed identifier that unit tests wouldn't exercise, e.g. an unused-but-broken import).

- [ ] **Step 3: Confirm the full blast radius grep is clean**

Run: `grep -rln "bom_glass_types\|glass_type_id\|glassArea_sqm\|glassCost\|useBomGlassTypes\|GlassTypeForm" src/ supabase/functions/ 2>/dev/null`
Expected: no output. (The Phase 1 spec file and this plan/spec itself will still mention "glass" historically in prose — that's expected and fine; this grep is scoped to `src/` and `supabase/functions/`, i.e. actual code, not docs.)

- [ ] **Step 4: Update `package.json` version and `src/changelog.json`, per this project's standing shipping practice**

Bump the patch version in `package.json` and add a new top entry to `src/changelog.json` describing the shipped change in Thai, matching the style of every prior entry in that file (see the existing entries for the exact tone/format). This is a real user-facing change (new fields on the Estimation/BOM Templates pages), so it needs an entry.

- [ ] **Step 5: Update both manual copies**

Find the existing "ประเมินราคา (BOM)" appendix section in `public/manual/index.html` (search for `page-estimation`) and add a short callout describing: (a) วัสดุอุดช่อง now supports 4 material kinds, not just glass, (b) the 3 new rate fields (labor/silicone/felt) on each template, (c) the add-on-unit toggle in the opening editor. Then read the Claude Artifact manual copy at `https://claude.ai/artifact/XTuSvCZRTdN8kDztUKed7G` (the Artifact tool's `action: "read"`), apply the same addition to its saved-to-disk HTML via the established `python str.replace` diff-verify pattern (see this session's prior rounds for the exact technique — save the edited content to a scratch file, confirm the target string's `count() == 1` before replacing), and republish it with `action: "publish"` passing `url` to update in place rather than create a new artifact.

- [ ] **Step 6: Commit**

```bash
git add package.json src/changelog.json public/manual/index.html
git commit -m "docs: bump version, changelog, and manual for BOM cost-factors extension"
```
