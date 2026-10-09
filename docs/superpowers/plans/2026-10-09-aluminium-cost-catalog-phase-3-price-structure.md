# Aluminium Cost Catalog — Phase 3 (price structure, quotation export, attachments, compare) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From an estimation project's costed items, produce the price structure (cost → waste → profit → transport → PM → rounded price), export it to a normal draft quotation with A4 attachment pages, number each export (R2-1, R2-2 …), and after signing pull the agreed prices back to compare real profit against the set profit.

**Architecture:** Pure libraries (`priceStructure`, `priceStructureView`, `quotationExport`, `attachmentPages`, `priceCompare`) hold all the maths and planning and are unit-tested; thin React components and one API module (`estimationQuotationApi`) do the I/O. All new tables are estimation-side and module-gated; no column is added to `quotations` / `quotation_items`; `Quotations.jsx` gains one optional `extraPages` prop that is a no-op without it.

**Tech Stack:** React (Vite), Supabase/Postgres RLS, vitest, plain SVG for pies and drawings.

**Spec:** `docs/superpowers/specs/2026-10-09-aluminium-price-structure-and-quotation-export-design.md` (commit 75a7cfca). Mockup (layout/wording source of truth): https://claude.ai/artifact/PJqo9xMxMGyxvAw8LbYMvh (v14). Workbook of the formulas: `price_structure.xlsx`, sheet `ELSY` (main folder).

## Global Constraints

- Worktree `/Users/plfx/code/FacadeXPM/facadex-app/.claude/worktrees/alu-cost-catalog`, branch `feat/alu-cost-catalog`. Do not push. Do not merge. Main folder code untouched.
- Agents never run SQL against Supabase/production. Migrations and SQL tests are written as files; the owner runs them (`!` commands, one per message, prepared as scripts in `.superpowers/sdd/<plan>/`).
- Every new table: `tenant_id UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id)`, tenant index, RLS `is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation')` (copy the loop in `supabase/migrations/2026-10-12-03-estimation-hardware-packages.sql`). Every new column on an existing table is nullable or has a default (additive).
- No `upsert` (house rule): look up, then insert or update.
- Money: full precision in calculations; the only roundings are PM `ceil` to whole baht and the selling price `ceil` to the project's step (default 100).
- UI text Thai; code/comments English. Match the surrounding style (comment density, naming).
- Isolation: a tenant without `estimation` must see no change anywhere. Quotations.jsx may only gain optional additive props/queries that do nothing without an estimation link and the module; a test proves it.
- UI work follows "mockup first": the item/project/price-structure/send/compare/attachment screens are already in mockup v14. The **catalogue picture-upload fields** (Task 9) have no mockup yet — controller publishes one and waits for owner comments before Task 9 is dispatched.
- Thai wording and layout: follow mockup v14 exactly; where this plan and the mockup disagree, the mockup wins for layout and the spec wins for behaviour.
- Final message of the whole arc lists every `Ruling:` line from the Phase 2b and Phase 3 ledgers.

## Rulings made while writing this plan (record in the ledger as `Ruling:`)

- Ruling P3-1: **Reuse the existing `profit_pct`** (on `estimation_projects` and `estimation_openings`, resolved item-over-project by `resolveItemInputs`) as the price structure's profit %. No new `markup_pct` column. Cost if wrong: one rename migration. (Spec §5 named a new column; the code already has the exact semantics.)
- Ruling P3-2: The engine's own template waste (`bom.wasteCost`) is **excluded** from `V`; the price structure applies the **project's** `waste_pct` to the aluminium cost. Template `waste_pct` keeps affecting the old per-item total only.
- Ruling P3-3: `alu_profiles` already has `image_url`; for one mechanism across catalogues a new `image_path` (storage path) is added to `alu_profiles`, `infill_types`, `alu_parts`; `image_url` is left untouched and ignored by Phase 3. Silicone/sealant/felt/screws are `alu_parts` rows (`kind='accessory'`), so they are covered. Colours (`alu_finishes`) get `color_hex` (swatch) plus `image_path`.
- Ruling P3-4: Sub-number `sub_no` is stored on `estimation_price_snapshots` and counts pushes per (quotation, revision-after-push); label `R{rev}-{sub_no}`. Before the first send the revision is 1.
- Ruling P3-5: Money columns written to quotation lines are the selling price per set rounded to the step (whole baht); in split mode material = `round(price × pct / 100)`, labour = `price − material`.

## Review Focus

- A project where **every** item is unresolved or has size 0 (division by zero in Z share, per-sqm, profit %). Expect "ยังคิดไม่ได้" rows, totals that skip them, no `NaN`/`Infinity` anywhere.
- Re-send after the user **deleted or reordered** generated lines in the Quotation page. Expect: missing generated rows are re-created, user-added rows untouched, sort order stays consistent.
- Re-send when a generated line is **referenced by an invoice** and its item was removed from the project. Expect the pair is kept and flagged, never deleted.
- Customer **discount by percent and by amount**, VAT-inclusive prices, and zero-line quotations in the compare screen. Expect profit % computed on net-of-VAT, net-of-discount unit price.
- Tenant **without** `estimation` (or without `quotations`) opening Quotations: no extra queries, identical output; a user with only one of the two modules never sees the send button.

---

## File structure

Create:
- `supabase/migrations/2026-10-14-01-price-structure.sql` — schema (Task 1)
- `supabase/migrations/2026-10-14-02-estimation-images.sql` — bucket + image columns (Task 1)
- `supabase/tests/price_structure_test.sql`, `supabase/tests/estimation_images_test.sql`
- `src/lib/priceStructure.js` (+ `.test.js`) — maths (Task 2)
- `src/lib/priceStructureView.js` (+ test) — columns/footers/pies/weights (Task 5)
- `src/lib/quotationExport.js` (+ test) — row building, split, state table, labels (Task 7)
- `src/lib/estimationQuotationApi.js` (+ test with fake client) — writes (Task 8)
- `src/lib/estimationImages.js` (+ test) — upload path/validation/signed URL (Task 9)
- `src/lib/attachmentPages.js` (+ test) — page plan (Task 10)
- `src/lib/priceCompare.js` (+ test) — agreed vs offered (Task 12)
- `src/pages/estimation/PriceStructureTab.jsx`, `PriceStructureTable.jsx`, `PieChart.jsx`, `SendToQuotationDialog.jsx`, `CompareTab.jsx`, `AttachmentPages.jsx`, `ProjectFactorsPanel.jsx`
- `src/hooks/usePriceStructure.js` — loads links/lines/snapshots

Modify:
- `src/lib/estimationSettings.js` (+ test): default factors
- `src/pages/estimation/itemForm.js`, `ItemFields.jsx`, `src/lib/openingPayload.js` (+ tests): four costs
- `src/pages/estimation/projectDefaults.js` (`newProjectRow`), `ProjectDefaultsPanel.jsx`: factors
- `src/pages/Estimation.jsx`: new tab
- `src/pages/Quotations.jsx`: optional `extraPages` (Task 11)
- catalogue screens in `src/pages/aluCatalog/*.jsx`: picture field (Task 9)
- `docs/handover-aluminium-cost-catalog.md`: Phase 3 section (Task 13)

---

### Task 1: Migrations and SQL tests (owner applies)

**Files:**
- Create: `supabase/migrations/2026-10-14-01-price-structure.sql`, `supabase/migrations/2026-10-14-02-estimation-images.sql`
- Test: `supabase/tests/price_structure_test.sql`, `supabase/tests/estimation_images_test.sql`
- Create (ledger dir, git-ignored): `run-price-structure-tests.sh`, `run-estimation-images-tests.sh` modelled on `run-hardware-packages-tests.sh` there.

**Interfaces:**
- Produces: tables `estimation_quotation_links`, `estimation_quotation_lines`, `estimation_price_snapshots`; columns named below (exact names used by all later tasks).

- [ ] **Step 1: Write `2026-10-14-01-price-structure.sql`**

```sql
-- Phase 3: price structure + quotation export. Additive; estimation-only. The only references to standard tables are
-- foreign keys FROM estimation tables TO quotations / quotation_items (nothing is added to those tables).
ALTER TABLE estimation_projects
  ADD COLUMN waste_pct       NUMERIC CHECK (waste_pct IS NULL OR (waste_pct >= 0 AND waste_pct <= 1000)),
  ADD COLUMN pm_pct          NUMERIC CHECK (pm_pct IS NULL OR (pm_pct >= 0 AND pm_pct <= 1000)),
  ADD COLUMN transport_total NUMERIC CHECK (transport_total IS NULL OR transport_total >= 0),
  ADD COLUMN round_step      NUMERIC NOT NULL DEFAULT 100 CHECK (round_step > 0);

ALTER TABLE estimation_settings
  ADD COLUMN default_waste_pct  NUMERIC CHECK (default_waste_pct IS NULL OR default_waste_pct >= 0),
  ADD COLUMN default_profit_pct NUMERIC CHECK (default_profit_pct IS NULL OR default_profit_pct >= 0),
  ADD COLUMN default_pm_pct     NUMERIC CHECK (default_pm_pct IS NULL OR default_pm_pct >= 0),
  ADD COLUMN default_round_step NUMERIC CHECK (default_round_step IS NULL OR default_round_step > 0);

ALTER TABLE estimation_openings
  ADD COLUMN fire_barrier_cost NUMERIC CHECK (fire_barrier_cost IS NULL OR fire_barrier_cost >= 0),
  ADD COLUMN bracket_cost      NUMERIC CHECK (bracket_cost IS NULL OR bracket_cost >= 0),
  ADD COLUMN bend_alu_cost     NUMERIC CHECK (bend_alu_cost IS NULL OR bend_alu_cost >= 0),
  ADD COLUMN bend_glass_cost   NUMERIC CHECK (bend_glass_cost IS NULL OR bend_glass_cost >= 0);

ALTER TABLE infill_types ADD COLUMN code TEXT;          -- glass code, e.g. TP6
ALTER TABLE alu_finishes ADD COLUMN color_hex TEXT CHECK (color_hex IS NULL OR color_hex ~ '^#[0-9A-Fa-f]{6}$');

CREATE TABLE estimation_quotation_links (
  id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id           UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  project_id          UUID NOT NULL UNIQUE REFERENCES estimation_projects(id) ON DELETE CASCADE,
  quotation_id        UUID REFERENCES quotations(id) ON DELETE SET NULL,
  attach_enabled      BOOLEAN NOT NULL DEFAULT true,
  attach_mode         TEXT NOT NULL DEFAULT 'pages' CHECK (attach_mode IN ('pages','thumb','both')),
  attach_view         TEXT NOT NULL DEFAULT 'both'  CHECK (attach_view IN ('both','out','in')),
  split_enabled       BOOLEAN NOT NULL DEFAULT false,
  split_material_pct  NUMERIC NOT NULL DEFAULT 80 CHECK (split_material_pct >= 0 AND split_material_pct <= 100),
  last_pushed_at      TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE estimation_quotation_lines (
  id                 UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id          UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  project_id         UUID NOT NULL REFERENCES estimation_projects(id) ON DELETE CASCADE,
  opening_id         UUID NOT NULL REFERENCES estimation_openings(id) ON DELETE CASCADE,
  item_row_id        UUID REFERENCES quotation_items(id) ON DELETE SET NULL,
  description_row_id UUID REFERENCES quotation_items(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, opening_id)
);
CREATE TABLE estimation_price_snapshots (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id     UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  project_id    UUID NOT NULL REFERENCES estimation_projects(id) ON DELETE CASCADE,
  quotation_id  UUID REFERENCES quotations(id) ON DELETE SET NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('sent','agreed')),
  revision      INT  NOT NULL DEFAULT 1 CHECK (revision >= 1),
  sub_no        INT  NOT NULL DEFAULT 1 CHECK (sub_no >= 1),
  price_as_of   DATE,
  factors       JSONB NOT NULL DEFAULT '{}'::jsonb,
  items         JSONB NOT NULL DEFAULT '[]'::jsonb,
  totals        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_eql_quotation_id   ON estimation_quotation_links(quotation_id);
CREATE INDEX idx_eqlines_project    ON estimation_quotation_lines(project_id);
CREATE INDEX idx_eqlines_item_row   ON estimation_quotation_lines(item_row_id);
CREATE INDEX idx_eqlines_desc_row   ON estimation_quotation_lines(description_row_id);
CREATE INDEX idx_eps_project        ON estimation_price_snapshots(project_id, created_at);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['estimation_quotation_links','estimation_quotation_lines','estimation_price_snapshots'] LOOP
    EXECUTE format('CREATE INDEX idx_%s_tenant_id ON %I(tenant_id)', t, t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY admin_full_access ON %I FOR ALL TO authenticated
      USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation'))
      WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation'))$p$, t);
  END LOOP;
END $$;
```

Before finishing, grep the repo for any **view** selecting `estimation_projects.*`, `estimation_openings.*` or `infill_types.*` (house rule "view e.* column freeze"); if one exists, the migration must recreate it. State the result in the report.

- [ ] **Step 2: Write `2026-10-14-02-estimation-images.sql`**

```sql
ALTER TABLE alu_profiles  ADD COLUMN image_path TEXT;
ALTER TABLE infill_types  ADD COLUMN image_path TEXT;
ALTER TABLE alu_parts     ADD COLUMN image_path TEXT;
ALTER TABLE alu_finishes  ADD COLUMN image_path TEXT;

INSERT INTO storage.buckets (id, name, public) VALUES ('estimation-images', 'estimation-images', false)
ON CONFLICT (id) DO NOTHING;
CREATE POLICY estimation_images_tenant_access ON storage.objects FOR ALL TO authenticated
  USING (bucket_id = 'estimation-images' AND is_admin_or_owner() AND has_module_access('estimation')
         AND (storage.foldername(name))[1] = current_tenant_id()::text)
  WITH CHECK (bucket_id = 'estimation-images' AND is_admin_or_owner() AND has_module_access('estimation')
         AND (storage.foldername(name))[1] = current_tenant_id()::text);
```

- [ ] **Step 3: SQL tests** — follow `supabase/tests/estimation_hardware_packages_test.sql` exactly (3 fixture tenants A/B hold `estimation`, C holds nothing; one transaction ending in ROLLBACK). `price_structure_test.sql` must assert, as tenant A: insert a project, an opening with `fire_barrier_cost=100`, a link, a line, two snapshots; CHECK failures (`round_step = 0`, `split_material_pct = 120`, `attach_mode = 'x'`, `sub_no = 0`, negative `bracket_cost`) each raise `check_violation` (23514); duplicate link per project and duplicate `(project_id, opening_id)` raise 23505; deleting the quotation sets `quotation_id`/`item_row_id` NULL (create a quotation + two quotation_items first using the minimal columns from `supabase/tests/quotation_module_test.sql`); as tenant B: sees 0 rows of tenant A in all three tables; as tenant C: 0 rows and an insert is rejected (RLS `42501`). `estimation_images_test.sql` asserts the four columns exist and that tenant C cannot insert into `storage.objects` for bucket `estimation-images`.
- [ ] **Step 4: Owner scripts** — write the two `run-*.sh` files (BEGIN; migrations in order; test file; ROLLBACK, via the same `psql` mechanism as the existing scripts) and **do not run them**.
- [ ] **Step 5: Commit** `git add supabase/migrations/2026-10-14-0*.sql supabase/tests/price_structure_test.sql supabase/tests/estimation_images_test.sql && git commit -m "feat: phase 3 migrations and SQL tests (not applied)"`.

---

### Task 2: `priceStructure` pure library

**Files:**
- Create: `src/lib/priceStructure.js`
- Test: `src/lib/priceStructure.test.js`

**Interfaces:**
- Consumes: the object returned by `costOpening` (`src/lib/openingCost.js`): `{ resolved, bom, addonBom, extras, total, unresolved }` where `bom` / `addonBom` have `profileLines`, `gridLines`, `hardwareLines`, `hardwareSetLines`, `infillCost`, `laborCost`, `siliconeCost`, `feltCost`, `extraLinesCost`, `wasteCost`; each profile line has `cost` and `weight_kg`; `extras.cost`.
- Produces:
  - `costBreakdown(cost) → { alu, hardware, glass, labour, other, aluWeightKg }` (`other` = silicone+felt+extra lines+extras; engine waste excluded — Ruling P3-2)
  - `priceItem({ breakdown, fireBarrier, bracket, bendAlu, bendGlass, profitPct, wastePct }) → { v, w, x, y }`
  - `priceProject({ items, factors }) → { rows, totals }` where `items[i] = { id, quantity, width_m, height_m, breakdown, fireBarrier, bracket, bendAlu, bendGlass, profitPct (null = use factors.profitPct), unresolved (bool) }`, `factors = { wastePct, profitPct, pmPct, transportTotal, roundStep }`. Each row: `{ id, quantity, resolved, v, w, x, y, z, pm, perSet, price, perSqm, lineTotal, profitPct, breakdown, extraCosts, aluWeightKg }`.
  - `totals = { lineTotal, sumV, sumW, sumX, sumZ, sumPm, aluWeightNet, aluWeightWithWaste }`.
  - `realProfitPct({ v, w, z, pm, agreedNet }) → number|null`.

- [ ] **Step 1: Write the failing tests** (`src/lib/priceStructure.test.js`):

```js
import { describe, it, expect } from 'vitest'
import { costBreakdown, priceItem, priceProject, realProfitPct } from './priceStructure.js'

const bd = (alu, hardware = 0, glass = 0, labour = 0, other = 0, aluWeightKg = 0) => ({ alu, hardware, glass, labour, other, aluWeightKg })
const F = { wastePct: 10, profitPct: 45, pmPct: 2, transportTotal: 5000, roundStep: 100 }
const base = { quantity: 1, width_m: 1, height_m: 2, fireBarrier: 0, bracket: 0, bendAlu: 0, bendGlass: 0, profitPct: null, unresolved: false }

describe('costBreakdown', () => {
  it('splits an engine result and leaves the engine waste out', () => {
    const cost = {
      bom: { profileLines: [{ cost: 1000, weight_kg: 2 }], gridLines: [{ cost: 500, weight_kg: 1 }], hardwareLines: [{ cost: 300 }], hardwareSetLines: [{ cost: 200 }],
             infillCost: 700, laborCost: 400, siliconeCost: 20, feltCost: 10, extraLinesCost: 30, wasteCost: 150 },
      addonBom: { profileLines: [{ cost: 100, weight_kg: 0.5 }], gridLines: [], hardwareLines: [], hardwareSetLines: [], infillCost: 50, laborCost: 0, siliconeCost: 0, feltCost: 0, extraLinesCost: 0, wasteCost: 10 },
      extras: { cost: 40 },
    }
    expect(costBreakdown(cost)).toEqual({ alu: 1600, hardware: 500, glass: 750, labour: 400, other: 100, aluWeightKg: 3.5 })
  })
})

describe('priceItem', () => {
  it('V = all categories, W = alu x waste, X = V x profit, Y = V+W+X', () => {
    const r = priceItem({ breakdown: bd(3000, 1000, 1000, 500, 500), fireBarrier: 0, bracket: 0, bendAlu: 0, bendGlass: 0, profitPct: 45, wastePct: 10 })
    expect(r).toEqual({ v: 6000, w: 300, x: 2700, y: 9000 })
  })
  it('adds the four extra costs into V', () => {
    const r = priceItem({ breakdown: bd(1000), fireBarrier: 100, bracket: 200, bendAlu: 300, bendGlass: 400, profitPct: 0, wastePct: 0 })
    expect(r.v).toBe(2000)
  })
})

describe('priceProject', () => {
  it('single item: transport all on it, PM ceil, round up to step, per sqm', () => {
    const { rows, totals } = priceProject({ items: [{ ...base, id: 'a', breakdown: bd(3000, 1000, 1000, 500, 500, 10) }], factors: F })
    const r = rows[0]
    expect([r.v, r.w, r.x, r.y, r.z, r.pm]).toEqual([6000, 300, 2700, 9000, 5000, 180])
    expect(r.perSet).toBe(14180)
    expect(r.price).toBe(14200)
    expect(r.perSqm).toBe(14180 / 2)
    expect(r.lineTotal).toBe(14200)
    expect(totals.lineTotal).toBe(14200)
    expect(totals.aluWeightNet).toBe(10)
    expect(totals.aluWeightWithWaste).toBeCloseTo(11)
  })
  it('allocates transport by share of Y x quantity and divides by quantity', () => {
    const items = [
      { ...base, id: 'a', breakdown: bd(3000, 1000, 1000, 500, 500) },                 // Y 9000, qty 1
      { ...base, id: 'b', quantity: 2, breakdown: bd(1500, 500, 500, 250, 250) },     // Y 4500, qty 2
    ]
    const { rows } = priceProject({ items, factors: F })
    expect(rows[0].z).toBe(2500)
    expect(rows[1].z).toBe(1250)
    expect(rows[0].z * 1 + rows[1].z * 2).toBe(5000)
  })
  it('a per-item profit overrides the project (null = follow)', () => {
    const items = [{ ...base, id: 'a', profitPct: 20, breakdown: bd(3000, 1000, 1000, 500, 500) }]
    expect(priceProject({ items, factors: F }).rows[0].x).toBe(1200)
  })
  it('an unresolved item is flagged, priced as nothing, and excluded from the transport share and totals', () => {
    const items = [{ ...base, id: 'a', breakdown: bd(3000, 1000, 1000, 500, 500) }, { ...base, id: 'u', unresolved: true, breakdown: bd(0) }]
    const { rows, totals } = priceProject({ items, factors: F })
    expect(rows[1].resolved).toBe(false)
    expect(rows[1].price).toBe(null)
    expect(rows[0].z).toBe(5000)
    expect(totals.lineTotal).toBe(14200)
  })
  it('never yields NaN or Infinity with no items, zero size or zero V', () => {
    expect(priceProject({ items: [], factors: F }).totals.lineTotal).toBe(0)
    const r = priceProject({ items: [{ ...base, id: 'z', width_m: 0, height_m: 0, breakdown: bd(0) }], factors: F }).rows[0]
    for (const k of ['v', 'w', 'x', 'y', 'z', 'pm', 'perSet']) expect(Number.isFinite(r[k])).toBe(true)
    expect(r.perSqm).toBe(null)
  })
  it('treats a missing factor as 0 and a missing/invalid step as 100', () => {
    const { rows } = priceProject({ items: [{ ...base, id: 'a', breakdown: bd(1000) }], factors: { roundStep: 0 } })
    expect(rows[0].price).toBe(1000)
  })
})

describe('realProfitPct', () => {
  it('(agreed net - (V+W+Z+PM)) / V', () => {
    expect(realProfitPct({ v: 6000, w: 300, z: 5000, pm: 180, agreedNet: 14200 })).toBeCloseTo(45.333, 2)
    expect(realProfitPct({ v: 6000, w: 300, z: 5000, pm: 180, agreedNet: 13000 })).toBeCloseTo(25.333, 2)
  })
  it('is null when V is 0', () => {
    expect(realProfitPct({ v: 0, w: 0, z: 0, pm: 0, agreedNet: 100 })).toBe(null)
  })
})
```

- [ ] **Step 2: Run** `npx vitest run src/lib/priceStructure.test.js` — expect FAIL (module missing).
- [ ] **Step 3: Implement** `src/lib/priceStructure.js`:

```js
// src/lib/priceStructure.js
// Price structure of an estimation project (owner's ELSY sheet). Pure: no I/O, no React.
//   V = all cost categories   W = aluminium x waste%   X = V x profit%   Y = V + W + X
//   Z = project transport allocated by share of Y x quantity   PM = ceil(Y x pm%)
//   per set = Y + Z + PM   price = per set rounded UP to the step   per sqm = per set / (w x h)
const n = v => { const x = Number(v); return Number.isFinite(x) ? x : 0 }
const sum = (rows, k) => (rows || []).reduce((s, r) => s + n(r[k]), 0)

// The engine's own template waste is deliberately left out (Ruling P3-2): the project's waste % applies instead.
export function costBreakdown(cost) {
  const boms = [cost && cost.bom, cost && cost.addonBom].filter(Boolean)
  const profile = b => [...(b.profileLines || []), ...(b.gridLines || [])]
  return {
    alu: boms.reduce((s, b) => s + sum(profile(b), 'cost'), 0),
    hardware: boms.reduce((s, b) => s + sum(b.hardwareLines, 'cost') + sum(b.hardwareSetLines, 'cost'), 0),
    glass: boms.reduce((s, b) => s + n(b.infillCost), 0),
    labour: boms.reduce((s, b) => s + n(b.laborCost), 0),
    other: boms.reduce((s, b) => s + n(b.siliconeCost) + n(b.feltCost) + n(b.extraLinesCost), 0) + n(cost && cost.extras && cost.extras.cost),
    aluWeightKg: boms.reduce((s, b) => s + sum(profile(b), 'weight_kg'), 0),
  }
}

export function priceItem({ breakdown, fireBarrier, bracket, bendAlu, bendGlass, profitPct, wastePct }) {
  const b = breakdown || {}
  const v = n(b.alu) + n(b.hardware) + n(b.glass) + n(b.labour) + n(b.other) + n(fireBarrier) + n(bracket) + n(bendAlu) + n(bendGlass)
  const w = n(b.alu) * n(wastePct) / 100
  const x = v * n(profitPct) / 100
  return { v, w, x, y: v + w + x }
}

export function priceProject({ items, factors }) {
  const f = factors || {}
  const step = n(f.roundStep) > 0 ? n(f.roundStep) : 100
  const base = (items || []).map(it => {
    const resolved = !it.unresolved
    const profitPct = it.profitPct === null || it.profitPct === undefined || it.profitPct === '' ? n(f.profitPct) : n(it.profitPct)
    const p = resolved ? priceItem({ breakdown: it.breakdown, fireBarrier: it.fireBarrier, bracket: it.bracket, bendAlu: it.bendAlu, bendGlass: it.bendGlass, profitPct, wastePct: f.wastePct }) : { v: 0, w: 0, x: 0, y: 0 }
    return { it, resolved, profitPct, ...p, qty: Math.max(0, n(it.quantity)) }
  })
  const basis = base.reduce((s, r) => s + (r.resolved ? r.y * r.qty : 0), 0)
  const rows = base.map(r => {
    const { it } = r
    const extraCosts = { fireBarrier: n(it.fireBarrier), bracket: n(it.bracket), bendAlu: n(it.bendAlu), bendGlass: n(it.bendGlass) }
    const aluWeightKg = n(it.breakdown && it.breakdown.aluWeightKg)
    if (!r.resolved) return { id: it.id, quantity: r.qty, resolved: false, v: 0, w: 0, x: 0, y: 0, z: 0, pm: 0, perSet: 0, price: null, perSqm: null, lineTotal: 0, profitPct: r.profitPct, breakdown: it.breakdown, extraCosts, aluWeightKg }
    const z = basis > 0 && r.qty > 0 ? n(f.transportTotal) * (r.y * r.qty / basis) / r.qty : 0
    const pm = Math.ceil(r.y * n(f.pmPct) / 100 - 1e-9)
    const perSet = r.y + z + pm
    const price = Math.ceil(perSet / step - 1e-9) * step
    const area = n(it.width_m) * n(it.height_m)
    return { id: it.id, quantity: r.qty, resolved: true, v: r.v, w: r.w, x: r.x, y: r.y, z, pm, perSet, price, perSqm: area > 0 ? perSet / area : null, lineTotal: price * r.qty, profitPct: r.profitPct, breakdown: it.breakdown, extraCosts, aluWeightKg }
  })
  const ok = rows.filter(r => r.resolved)
  const net = ok.reduce((s, r) => s + r.aluWeightKg * r.quantity, 0)
  return {
    rows,
    totals: {
      lineTotal: ok.reduce((s, r) => s + r.lineTotal, 0),
      sumV: ok.reduce((s, r) => s + r.v * r.quantity, 0), sumW: ok.reduce((s, r) => s + r.w * r.quantity, 0),
      sumX: ok.reduce((s, r) => s + r.x * r.quantity, 0), sumZ: ok.reduce((s, r) => s + r.z * r.quantity, 0),
      sumPm: ok.reduce((s, r) => s + r.pm * r.quantity, 0),
      aluWeightNet: net, aluWeightWithWaste: net * (1 + n(f.wastePct) / 100),
    },
  }
}

// Real profit on the same base the set profit uses: (net price - (V+W+Z+PM)) / V, in percent.
export function realProfitPct({ v, w, z, pm, agreedNet }) {
  if (!(n(v) > 0)) return null
  return (n(agreedNet) - (n(v) + n(w) + n(z) + n(pm))) / n(v) * 100
}
```

(The `- 1e-9` guards float noise so an exact multiple of the step is not pushed up one step. The "missing step → 100" test passes because `roundStep: 0` falls back to 100 and 1000 is already a multiple.)

- [ ] **Step 4: Run** `npx vitest run src/lib/priceStructure.test.js` — expect PASS. Then `npx vitest run` — expect the full suite green.
- [ ] **Step 5: Check against the workbook** — open `price_structure.xlsx` (sheet ELSY) with the same Python approach used earlier in the session (`python3 -I` + openpyxl, read-only), take the first three data rows' inputs and outputs, and add one test `matches ELSY row N` per row with the sheet's numbers copied in as literals. If a sheet number disagrees with this implementation, STOP and report it (the sheet is the owner's authority); do not adjust the test to the code.
- [ ] **Step 6: Commit** `feat: priceStructure maths (ELSY formulas)`.

---

### Task 3: Four item costs in the item form and payload; project factors

**Files:**
- Modify: `src/pages/estimation/itemForm.js`, `src/pages/estimation/ItemFields.jsx`, `src/lib/openingPayload.js`
- Modify: `src/lib/estimationSettings.js`, `src/pages/estimation/projectDefaults.js` (`newProjectRow`, `DRAFT_COLUMNS`, `draftFromProject`), `src/pages/estimation/ProjectDefaultsPanel.jsx`
- Create: `src/pages/estimation/ProjectFactorsPanel.jsx` (waste %, profit % [existing], PM %, transport total, round step; shown inside the price-structure tab, Task 6; saving reuses the panel's save pattern)
- Test: extend `itemForm.test.js`, `itemRoundTrip.test.js`, `estimationSettings.test.js`, `projectDefaults.test.js`

**Interfaces:**
- Consumes: Task 1 column names.
- Produces: form fields `fire_barrier_cost`, `bracket_cost`, `bend_alu_cost`, `bend_glass_cost` (strings in the form, numbers/NULL in the payload; blank → NULL, negative or NaN → validation error with the same message style as `labour_per_sqm`); `mergeSettings` returns `default_waste_pct` (default 10), `default_profit_pct` (45), `default_pm_pct` (2), `default_round_step` (100); `newProjectRow(name, settings)` seeds `waste_pct`, `profit_pct`, `pm_pct`, `round_step` from those; `transport_total` stays NULL.

- [ ] **Step 1: Failing tests** — (a) `formFromOpening` / `buildOpeningPayload` round trip keeps the four values, blank → `null`, `'-5'` rejected, `'abc'` rejected; (b) `mergeSettings({})` gives 10/45/2/100 and `mergeSettings({default_round_step: 0})` falls back to 100; (c) `newProjectRow('x', settings)` contains the seeded factors and still has every key it had before (existing tests stay green).
- [ ] **Step 2: Run** the four files — FAIL.
- [ ] **Step 3: Implement.** Item form: add the four inputs to `ItemFields.jsx` in the "รายการเพิ่มเติม" block as "Fire Barrier (บาท/ชุด)", "Bracket (บาท/ชุด)", "ดัดอลูมิเนียม (บาท/ชุด)", "ดัดกระจก (บาท/ชุด)", wired like `labour_per_sqm`. `ItemFields` is shared with the quick calculator — the quick calculator must ignore them (they are not part of its draft).
- [ ] **Step 4: Run** the four files, then the full suite — PASS.
- [ ] **Step 5: Commit** `feat: four per-set item costs and project factor defaults`.

---

### Task 4: `usePriceStructure` hook and project/priceStructure assembly

**Files:**
- Create: `src/hooks/usePriceStructure.js`, `src/lib/priceStructureInputs.js` (+ `.test.js`)

**Interfaces:**
- Consumes: Task 2 (`costBreakdown`, `priceProject`), `costs` map from `Estimation.jsx` (`costItems` result: `{ [openingId]: costOpening result }`), `projectOpenings`, `project`.
- Produces: `buildPriceInputs({ items, costs, project }) → items[]` in the `priceProject` input shape (`profitPct` = item `profit_pct` if not null else `null`; `unresolved = cost.unresolved.length > 0 || !cost`; four extra costs from the item; `quantity`, `width_m`, `height_m` as numbers); `projectFactors(project) → { wastePct, profitPct, pmPct, transportTotal, roundStep }` (null → 0, step null → 100); hook `usePriceStructure(projectId) → { link, lines, snapshots, loading, error, refetch }` loading the three tables for that project (use `useCatalogTable`-style `fetchCatalogRows` + client-side filter, matching the other hooks).

- [ ] **Step 1: Failing tests** for `buildPriceInputs` (unresolved when `cost.unresolved` non-empty; item profit `''`/null → null; string numerics coerced) and `projectFactors` (nulls → 0, `round_step` null → 100).
- [ ] **Step 2–4:** run → implement → run (PASS). Hook has no test (thin loader), but must not call Supabase when the tenant lacks the module: `Estimation.jsx` is only reachable with the module, so no extra guard is needed here.
- [ ] **Step 5: Commit** `feat: price structure inputs and loader hook`.

---

### Task 5: `priceStructureView` — columns, footers, pies, hover

**Files:**
- Create: `src/lib/priceStructureView.js`, `src/lib/priceStructureView.test.js`

**Interfaces:**
- Consumes: `priceProject` result + items (for names, glass).
- Produces:
  - `visibleColumns(rows) → string[]` — keys from `['alu','hardware','glass','labour','fireBarrier','bracket','bendAlu','bendGlass','other']` that are non-zero in at least one resolved row (hide-if-empty applies to all nine; V and the later columns always show).
  - `sumproductRow(rows, keys) → { [key]: Σ value×quantity, v, w, x, y, z, pm, lineTotal }`.
  - `costPieData(rows) → [{ key, label, value }]` (Σ×quantity per category, zero slices dropped, Thai labels from the mockup) and `pricePieData(totals) → [{ key:'v'|'w'|'x'|'z'|'pm', label, value }]` over `totals`.
  - `glassHover(infillType) → { code, name, perSqm, perSqft } | null` (`perSqft = perSqm × 0.09290304`, 2 dp).
  - `weightSummary(totals) → { net, withWaste }` formatted numbers (kg, 2 dp).

- [ ] **Step 1: Failing tests:** a column that is zero everywhere is hidden; one row with `fireBarrier=100` shows it; sumproduct multiplies by quantity (qty 2 doubles); pie data drops zero slices and slice values sum to the sumproduct total; `glassHover({code:'TP6',name:'กระจกเทมเปอร์ 6',price_per_sqm:1000})` → perSqft 92.9; unresolved rows are excluded from sums.
- [ ] **Step 2–4:** run → implement → run (PASS).
- [ ] **Step 5: Commit** `feat: price structure view model`.

---

### Task 6: Price-structure tab UI

**Files:**
- Create: `src/pages/estimation/PriceStructureTab.jsx`, `PriceStructureTable.jsx`, `PieChart.jsx`, `ProjectFactorsPanel.jsx`
- Modify: `src/pages/Estimation.jsx` (third tab "โครงสร้างราคา")
- Test: `src/pages/estimation/PriceStructureTab.smoke.test.jsx` (pattern of `ItemModal.smoke.test.jsx`)

**Interfaces:**
- Consumes: Tasks 2, 4, 5. Props `{ project, items, costs, index, infillTypes, canEdit, onProjectSaved }`.
- Produces: tab content per mockup v14 tab 1: factors panel (waste, profit, PM, transport, step; save writes the project row), table (columns from `visibleColumns`, names exactly as in the mockup, per-row profit cell with a tick "ตามโปรเจกต์" whose **text is clickable** to toggle; unticking reveals a number input that writes the item's `profit_pct`), SUMPRODUCT footer, two SVG pies (`PieChart` takes `[{label,value}]`, theme-token colours, labels inside viewBox), weight summary, glass code cell with `title` hover from `glassHover`, project total. Button "ส่งไปใบเสนอราคา" is rendered by Task 8's dialog trigger; here leave a `children`/`actions` slot.

- [ ] **Step 1: Smoke test:** renders with two resolved items and one unresolved; asserts the unresolved row shows the unresolved text and no `NaN` appears in the document text; a column with zero everywhere is absent; clicking the "ตามโปรเจกต์" text toggles the checkbox.
- [ ] **Step 2–4:** run → implement → run (PASS); `npm run build` succeeds.
- [ ] **Step 5: Controller click-through** — controller opens the tab against a local build with test data and compares with mockup v14; screenshots into the scratchpad; discrepancies become fix rounds. (No Supabase writes by agents: the controller uses the running app only if the owner has applied migrations; otherwise the smoke test + mockup comparison is the check and the report says so.)
- [ ] **Step 6: Commit** `feat: price structure tab`.

---

### Task 7: `quotationExport` — rows, split, state table, labels

**Files:**
- Create: `src/lib/quotationExport.js`, `src/lib/quotationExport.test.js`

**Interfaces:**
- Consumes: Task 2 rows; `buildItemDescription` from `src/lib/descriptionFormat.js`.
- Produces:
  - `buildLines({ rows, items, descriptionCtxById, descriptionFormat, split: { enabled, materialPct } }) → [{ openingId, item: {description, unit:'ชุด', quantity, unit_price, unit_price_material, unit_price_labor, line_total, item_type:'item'}, desc: {description, unit:null, quantity:0, unit_price:0, unit_price_material, unit_price_labor, line_total:0, item_type:'item_description'} }]` — only resolved rows; `description` of the item row = `"{item_no} {item_name}"` (fallback "รายการ n"); material = `Math.round(price*pct/100)`, labour = `price - material`; when split is off both are `null`.
  - `planPush({ quotation, link, existingLines, newLines, invoiceRefs }) → { action: 'create'|'overwrite'|'pullback_overwrite', bumpRevision: boolean, newRevision, setStatus: 'draft'|null, needsAcceptedConfirm, updates: [...], inserts: [...], deletes: [...], keeps: [...], subNo }` implementing the spec §7.2 table: no quotation → create (revision 1, sub 1); `status==='draft'` → overwrite (no bump); `status in ('sent','accepted')` → pullback (bump, status draft, `needsAcceptedConfirm = status==='accepted'`). `existingLines` carries `{openingId,itemRowId,descRowId}` and which of those row ids still exist in the quotation; a missing row → re-insert; an opening no longer in `newLines` → delete unless in `invoiceRefs` (then keep, flagged).
  - `revisionLabel(revision, subNo) → 'R2-1'`; `nextSubNo(snapshots, quotationId, revision)` → max existing `sub_no` for that revision + 1 (1 if none).
  - `snapshotFor(quotation, items)` → the exact `quotation_revisions.snapshot` JSON shape (copy the object literal in `Quotations.jsx` handleSave: client_id, client_name, date, valid_until, has_vat, price_includes_vat, discount_amount, discount_pct, pricing_mode, payment_terms, notes, bank_account, items[{description,unit,quantity,unit_price,unit_price_material,unit_price_labor,line_total}]).

- [ ] **Step 1: Failing tests** (write all): split 80/20 of 14,200 → 11,360 / 2,840 and sum equals price; split 100 → labour 0; non-integer rounding goes to labour (e.g. 14,201 at 80% → material 11,361, labour 2,840); `planPush` for each status row of the §7.2 table; accepted sets `needsAcceptedConfirm`; user-deleted generated item row is re-inserted and a user-added row id is never in updates/deletes; removed opening with invoice reference → in `keeps`; `nextSubNo` restarts at 1 for a new revision and increments within one; `revisionLabel(1,1)==='R1-1'`; `snapshotFor` has exactly the keys listed above.
- [ ] **Step 2–4:** run → implement → run (PASS).
- [ ] **Step 5: Commit** `feat: quotation export planning`.

---

### Task 8: Send/update executor and dialog

**Files:**
- Create: `src/lib/estimationQuotationApi.js`, `src/lib/estimationQuotationApi.test.js`, `src/pages/estimation/SendToQuotationDialog.jsx`
- Modify: `src/pages/estimation/PriceStructureTab.jsx` (button + dialog; hidden unless the tenant has **both** `estimation` and `quotations`: `useTenant().hasModuleAccess('quotations')`)

**Interfaces:**
- Consumes: Task 7 plan. `pushToQuotation({ supabase, project, link, quotation, plan, header, lines, snapshotPayload })`.
- Produces: the write sequence, in this order, each step awaited and any error thrown before the next: (1) if `plan.action==='create'`: insert `quotations` (columns exactly as `qtPayload` in `Quotations.jsx`: `client_id, site_name, date, valid_until, has_vat:true, price_includes_vat:false, discount_*: null, pricing_mode, payment_terms: tenant.default_payment_terms, notes: null, bank_account_id: default account of the tenant's category as the Quotation form picks it`); the **header defaults come from the same sources as `Quotations.jsx` lines 58-61 and 1562-1563 and the bank default effect at ~430** — read those and reuse the same helper if one is exported, else copy the logic into a small shared helper and make `Quotations.jsx` untouched; (2) if `plan.bumpRevision`: insert `quotation_revisions {quotation_id, revision: old, snapshot: snapshotFor(...)}` then update `quotations {status:'draft', revision:new}`; (3) delete/update/insert `quotation_items` per plan (update by id; inserts in the pair order with `sort_order`); (4) upsert-free write of `estimation_quotation_lines` (lookup then insert/update); (5) insert `estimation_price_snapshots {kind:'sent', revision, sub_no, ...}`; (6) update the link (`last_pushed_at`, attach options, split options) — insert it first time. Return `{ quotationId, label }`. Never wrap in a swallow-and-continue.
- Dialog: customer select (required, from `clients`), site name text, date (today), validity days (default as the Quotation form's `valid_days` default), attach options (pages/thumb/both, ext/int/both), split tick box with adjustable % next to it (default 80, clickable text toggles), list of lines to create/update, warning for items without a saved preview, blocked while any item is unresolved unless the "ข้ามรายการที่คิดไม่ได้" box is ticked; confirm step for `accepted` (inline, no `confirm()`), result toast with the label (e.g. "ส่งเป็น R2-1").

- [ ] **Step 1: Failing tests with a hand-written fake Supabase client** (an in-memory object exposing `from(table)` with `insert/update/delete/select/eq/in` chainables for `quotations`, `quotation_items`, `quotation_revisions`, `estimation_quotation_lines`, `estimation_price_snapshots`, `estimation_quotation_links`): first send creates 1 quotation + 2×N items + lines + snapshot (`R1-1`) + link; second push while draft overwrites by id, ids unchanged, label `R1-2`; push on `sent` writes one `quotation_revisions` row whose snapshot equals the pre-push content, sets status `draft`, revision 2, label `R2-1`; a following push stays revision 2, label `R2-2`; user-added row survives; an error in step 3 stops before steps 4–6 (assert no snapshot written).
- [ ] **Step 2–4:** run → implement → run (PASS); smoke render of the dialog (button disabled until a customer is chosen; unresolved block works).
- [ ] **Step 5: Commit** `feat: export price structure to quotation (create / update / revision)`.

---

### Task 9: Catalogue pictures — **gated on owner-approved mockup**

Controller, before dispatching: publish a mockup artifact of the picture field in each catalogue screen (profile, glass/infill, part/hardware/set/accessory, colour with swatch hex) and wait for the owner's comments (standing rule).

**Files:**
- Create: `src/lib/estimationImages.js`, `src/lib/estimationImages.test.js`
- Modify: `src/pages/aluCatalog/ProfilesTab.jsx`, `PartsTab.jsx`, `TypesTab.jsx`/the glass (infill) screen and the colours screen (find them with grep; infill types live in `BomTemplates`/reference tabs — the implementer lists exactly where each of the four tables is edited and reports it), `src/pages/aluCatalog/SettingsTab.jsx` untouched.

**Interfaces:**
- Produces: `imagePath(tenantId, table, rowId, fileName) → '<tenantId>/<table>/<rowId>/<timestamp>-<safeName>'` (safe name: ASCII letters, digits, `.`, `-`, `_`; Thai names replaced by `img`); `validateImage(file) → null | message` (types png/jpeg/webp, ≤ 2 MB); `uploadImage({ supabase, tenantId, table, rowId, file }) → path` (upload to bucket `estimation-images`, then update the row's `image_path`; on update failure remove the uploaded object); `signedUrls(supabase, paths) → { [path]: url }` (one batched `createSignedUrls`, 1 h); component `ImageField` (thumbnail, choose/replace/remove). Colours also get a `color_hex` input with swatch.
- Existing rows and screens without an image keep working; the field is optional everywhere.

- [ ] **Step 1: Failing tests:** `imagePath` yields tenant-prefixed ASCII-safe paths; `validateImage` rejects gif, 3 MB, accepts 1 MB webp; `uploadImage` with a fake client removes the object when the row update fails.
- [ ] **Step 2–4:** run → implement → run; build passes.
- [ ] **Step 5: Commit** `feat: pictures on catalogue rows`.

---

### Task 10: Attachment pages

**Files:**
- Create: `src/lib/attachmentPages.js`, `src/lib/attachmentPages.test.js`, `src/pages/estimation/AttachmentPages.jsx`

**Interfaces:**
- Consumes: items with `preview_svg_out`, `preview_svg_in`, size, series, colour (`alu_finishes.name`, `color_hex`), glass (`code`, name, thickness), hardware set (`alu_parts` name, brand=provider name) and its `alu_part_set_items` parts with pictures; Task 9 signed URLs.
- Produces:
  - `planAttachmentPages({ items, options: { view }, firstPageNo, totalQuotationPages }) → { pages: [{ kind:'items'|'hardware'|'colours', pageNo, items?: [4 max, 2×2 order], hardwareSets?, colours? }], totalPages }` — 4 items per page in input order; hardware-set schedule starts a new page; colour legend follows it (same page if it fits: schedule rows ≤ 10 → legend shares, else own page); page numbers continue from `totalQuotationPages` and `totalPages` includes them.
  - `hardwareSchedule(items, setsById, partsBySet, providersById) → [{ setId, name, brand, parts:[{name, quantity, imagePath}], itemNos }]` — only sets actually used, ordered by first use; flags `needsApprovalNote` for the standard note "ยี่ห้ออื่นที่เทียบเท่าต้องได้รับการอนุมัติ".
  - `colourLegend(items) → [{ finishId, name, hex, itemNos }]`.
  - `AttachmentPages` renders each page as an A4 block (same CSS constants as `QuotationPaper` via `PAGE_WIDTH_PX`/`PAGE_HEIGHT_PX`/`PAGE_PADDING_CSS` from `usePaginatedDocument.jsx`), with the **quotation header component reused** (title "ใบเสนอราคา", subtitle "แบบแนบ", document number, revision label `R2-1`), each item frame showing outside and inside SVGs side by side with dimension lines already in the saved SVG, then rows aluminium (series, thickness, colour swatch+name), glass (code, name), hardware set (name), and the footer "หน้า n/total". Pictures missing → drawn placeholder icon.

- [ ] **Step 1: Failing tests (pure):** 10 items → pages 3 items-pages (4,4,2); hardware/colour page counting; `pageNo` continues (quotation 2 pages, first attachment page = 3, `totalPages` = 2 + attachment pages); only used sets in the schedule; colour legend merges items with the same finish; `view:'out'` plans one SVG per frame; an item without saved preview yields a frame flagged `noPreview`.
- [ ] **Step 2–4:** run → implement → run; component smoke test renders 5 items into 2 item pages + schedule + legend.
- [ ] **Step 5: Controller PDF check:** produce a print copy through the same headless-Chrome route used for the earlier sample PDF and compare to mockup v14; fixes via fix rounds.
- [ ] **Step 6: Commit** `feat: attachment pages for estimation quotations`.

---

### Task 11: Optional `extraPages` in the Quotation print (isolation task)

**Files:**
- Modify: `src/pages/Quotations.jsx` (QuotationPaper and the place that renders the document modal)
- Create: `src/pages/estimation/useQuotationAttachments.js` (loads link + project data **only if** `hasModuleAccess('estimation')`; returns `null` otherwise without any query)
- Test: `src/pages/Quotations.isolation.test.jsx` (or the closest existing test file pattern)

**Interfaces:**
- Consumes: Task 10.
- Produces: `QuotationPaper` accepts optional `extraPages` (array of `{ key, node }`) and `extraPageCount`; when absent/empty the rendered output and numbering are identical to today. When present: appended after the last quotation page, header subtitle "แบบแนบ", numbering `n / (quotationPages + extraPageCount)`. The Quotations page calls `useQuotationAttachments(quotation)` only when the tenant has `estimation`; the hook returns `null` for no link.

- [ ] **Step 1: Failing tests:** (a) render `QuotationPaper` for a fixture without `extraPages` → snapshot equals the output captured **before this task** (capture it first, commit as a fixture); (b) with a mocked `useTenant` lacking `estimation`, the attachments hook performs **zero** `supabase.from` calls; (c) with `extraPages` of 2 nodes the page labels run `1/N … N/N` where N = quotation pages + 2 (take the quotation page count from the paginator in the test, do not hard-code it); (d) pulling the existing quotation tests: full suite unchanged.
- [ ] **Step 2–4:** run → implement (additive props only; **no other behaviour change** in the file; the diff must touch Quotations.jsx in additive hunks only — reviewer checks `git diff --stat` for deletions) → run (PASS).
- [ ] **Step 5: Commit** `feat: optional attachment pages in quotation print (no-op without estimation)`.

---

### Task 12: Compare after signing

**Files:**
- Create: `src/lib/priceCompare.js`, `src/lib/priceCompare.test.js`, `src/pages/estimation/CompareTab.jsx`
- Modify: `src/pages/Estimation.jsx` (fourth tab "เทียบราคาจริง", shown when a link exists)

**Interfaces:**
- Consumes: last `sent` snapshot (`items[]` with `{openingId, v, w, z, pm, price, quantity, profitPct}`), the quotation (`has_vat`, `price_includes_vat`, `discount_amount`, `discount_pct`) and its current item rows through `estimation_quotation_lines`.
- Produces: `buildComparison({ snapshot, quotation, lines, quotationItems }) → { rows: [{ openingId, offeredPrice, agreedUnit, discountShare, agreedNet, diff, diffPct, setProfitPct, realProfitPct, profitDiffPts, quantity }], extras: { removed: [...], added: [...] }, summary: { offeredTotal, agreedTotal, reductionPct, setProfitPct (weighted by V×qty), realProfitPct } }`. Bill discount: `discount_amount` or `discount_pct × subtotal`, allocated pro rata to line totals; if `price_includes_vat` divide each by 1.07 first; cost base from the **snapshot** (not live costs). `realProfitPct` from Task 2.
- UI: button "ดึงราคาที่ตกลงกลับมาเทียบ" (enabled when quotation status is `accepted`; owner can force for `sent` with an inline confirm), shows the table per mockup tab 5, appends an `agreed` snapshot (revision, next `sub_no`) on press. Read-only: no write to estimation items or to the quotation.

- [ ] **Step 1: Failing tests:** no discount, agreed = offered → real = set profit; amount discount 1,000 on 2 lines of 10,000 and 30,000 → shares 250/750; 5% discount; VAT-inclusive agreed 15,190 → net 14,196.26...; line removed in quotation → listed in `extras.removed`, excluded from summary; user-added row → `extras.added`; V = 0 row → `realProfitPct` null, no NaN in summary.
- [ ] **Step 2–4:** run → implement → run; component smoke test.
- [ ] **Step 5: Commit** `feat: compare agreed prices with the offer`.

---

### Task 13: Handover, ledger rulings, deploy notes

**Files:**
- Modify: `docs/handover-aluminium-cost-catalog.md` (Phase 3 section: SQL order `2026-10-14-01`, `-02` after the Phase 2b ones, test scripts, files touched outside the estimation area = `Quotations.jsx` additive hunks + `estimation_*` hook, owner click-through list, deferred minors), memory file `project_aluminium_cost_catalog_brainstorm.md` and its MEMORY.md line (Phase 3 built, HEAD hash, migrations not applied).

- [ ] **Step 1:** write the section; list owner click-through steps in Thai (create project → set factors → add items with the four costs → price structure tab numbers equal the ELSY workbook → send → check the draft quotation → print with attachments → update price → R2-1 → mark accepted → compare).
- [ ] **Step 2:** `npx vitest run` and `npm run build` — report counts.
- [ ] **Step 3: Whole-branch review** (most capable model) over `git diff origin/main...HEAD` limited to Phase 3 commits plus the isolation check; ONE fix dispatch; adjudicate residuals.
- [ ] **Step 4: Commit** `docs: phase 3 handover`. Then final message: list all `Ruling:` lines (Phase 2b + Phase 3), the owner's SQL commands one per message, and remind that rebase on `origin/main` happens before the final merge, and **nothing is merged or pushed without the owner**.
