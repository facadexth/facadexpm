# BOM Template Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin define a door/window type once as a `bom_template` (components, a parametric row/column grid, hardware, glass rule, warning-only size limits) via guided pickers, and let anyone compute an accurate per-unit BOM and cost for an opening (template + series + thickness + finish + glass type + width/height/panel count/quantity) — no formulas, no spreadsheet.

**Architecture:** Nine new/altered Postgres tables behind a new `estimation` module key; a pure client-side computation library (`src/lib/bomEngine.js`) mirroring the house style already used for `inventoryCost.js`; three UI surfaces — an extension of the existing (currently unreachable) aluminum-profile subtab in `Inventory.jsx`, a new `BomTemplates.jsx` admin page (template editor + two small reference catalogs), and a new `Estimation.jsx` page (projects, openings, live computed BOM).

**Tech Stack:** React + Vite, Supabase (Postgres + RLS), Vitest for `bomEngine.test.js` (matches `inventoryCost.test.js`).

**Spec:** `docs/superpowers/specs/2026-09-10-bom-template-engine-design.md`

## Global Constraints

- Every new/altered table gets the exact RLS shape already used everywhere in this app: `USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation'))`, same for `WITH CHECK`. Single `admin_full_access` policy, `FOR ALL TO authenticated`.
- `computeBomForOpening` is pure — no Supabase calls inside it. Callers load all inputs first (same pattern as `inventoryCost.js`'s functions).
- Length rules and quantity bases are a fixed, small preset enum — no field anywhere in the new UI accepts a formula string.
- Constraints (`bom_template_constraints`) are warning-only: never block saving an opening.
- Hardware pricing (`bom_template_hardware.reference_unit_price`) is a static number, never read from `inventory_items`' weighted-average cost.
- `profile_family` is plain `TEXT`, matched against `aluminum_profiles.family` — no FK, no lookup table (spec's YAGNI ruling).
- New tables use `gen_random_uuid()` PKs, `tenant_id UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id)` — copy this from any existing table in `supabase/schema.sql`, never write it by hand differently.

## Ruling: `estimation` module's default package tier

The spec left this as an open business question. Ruling for this plan (reversible later by editing `package_modules` directly): follow the exact precedent set by `cheque_tracking`'s migration (`supabase/migrations/2026-09-01-02-cheque-tracking.sql`) — grant it to every paid tier (`'Solo','Pro Team','Business','Enterprise'`), not `'Free'`. If the business wants a narrower tier later, that's a one-line data change, not a schema change.

## Ruling: profile import stays manual-only for Phase 1

The spec flagged whether `ExcelUpload.jsx`'s existing `aluminum_profile` sheet type should also import `family`/`series`/`thickness_mm`. Ruling: yes, extend it — Task 7 below adds it, since `parseAluminumProfileSheet` already exists and reading three more optional columns is small. This directly serves the real need (getting the source workbook's 201 profile rows in), so it's in scope, not deferred.

---

### Task 1: `estimation` module key

**Files:**
- Create: `supabase/migrations/2026-09-10-05-estimation-module-key.sql`

**Interfaces:**
- Produces: the string `'estimation'` becomes a valid `tenant_modules.module_key` / `package_modules.module_key` value, usable by every later task's RLS policies.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/2026-09-10-05-estimation-module-key.sql
-- New 'estimation' module: the BOM Template Engine (see
-- docs/superpowers/specs/2026-09-10-bom-template-engine-design.md).
-- Same toggle-per-tenant pattern as every other module. Default tier
-- assignment follows the cheque_tracking precedent -- every paid tier,
-- not Free (business can narrow this later by editing package_modules).
ALTER TABLE tenant_modules DROP CONSTRAINT tenant_modules_module_key_check;
ALTER TABLE tenant_modules ADD CONSTRAINT tenant_modules_module_key_check
  CHECK (module_key IN ('payroll','labor_subcontractors','purchase_orders','client_deposits','quotations','invoices','cheque_tracking','estimation'));

ALTER TABLE package_modules DROP CONSTRAINT package_modules_module_key_check;
ALTER TABLE package_modules ADD CONSTRAINT package_modules_module_key_check
  CHECK (module_key IN ('payroll','labor_subcontractors','purchase_orders','client_deposits','quotations','invoices','cheque_tracking','estimation'));

INSERT INTO package_modules (package_id, module_key)
SELECT id, 'estimation' FROM packages WHERE name IN ('Solo','Pro Team','Business','Enterprise');

INSERT INTO tenant_modules (tenant_id, module_key)
SELECT t.id, 'estimation' FROM tenants t
JOIN package_modules pm ON pm.package_id = t.package_id AND pm.module_key = 'estimation'
ON CONFLICT (tenant_id, module_key) DO NOTHING;
```

- [ ] **Step 2: Apply the migration**

Run via the `mcp__plugin_supabase_supabase__apply_migration` tool (this project has no local `supabase` CLI configured — every other migration this session used that tool) with `name: "estimation_module_key"` and the SQL above.

- [ ] **Step 3: Verify**

Run: query `SELECT module_key FROM tenant_modules WHERE module_key = 'estimation' LIMIT 1;` via `mcp__plugin_supabase_supabase__execute_sql` against a tenant on a paid package.
Expected: at least one row (confirms the backfill ran).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/2026-09-10-05-estimation-module-key.sql
git commit -m "feat: add estimation module key"
```

---

### Task 2: BOM reference tables — profile axes, finishes, glass types

**Files:**
- Create: `supabase/migrations/2026-09-10-06-bom-reference-tables.sql`

**Interfaces:**
- Produces: `aluminum_profiles.family/series/thickness_mm` (nullable TEXT/TEXT/NUMERIC); `aluminum_finishes(id, tenant_id, name, price_per_kg, active)`; `bom_glass_types(id, tenant_id, name, price_per_sqm, active)`.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/2026-09-10-06-bom-reference-tables.sql
-- BOM Template Engine, part 1 of 3: the small reference catalogs. All
-- three ALTER columns are nullable -- existing aluminum_profiles rows and
-- the procurement-side PO flow that already reads this table (PurchaseOrders.jsx,
-- inventoryCost.js) are completely unaffected. See spec Decisions 2-4.
ALTER TABLE aluminum_profiles ADD COLUMN family TEXT;
ALTER TABLE aluminum_profiles ADD COLUMN series TEXT;
ALTER TABLE aluminum_profiles ADD COLUMN thickness_mm NUMERIC;

CREATE TABLE aluminum_finishes (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id    UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  name         TEXT NOT NULL,
  price_per_kg NUMERIC NOT NULL,
  active       BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_aluminum_finishes_tenant_id ON aluminum_finishes(tenant_id);
ALTER TABLE aluminum_finishes ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_full_access ON aluminum_finishes FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation'));

CREATE TABLE bom_glass_types (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id     UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  name          TEXT NOT NULL,
  price_per_sqm NUMERIC NOT NULL,
  active        BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_bom_glass_types_tenant_id ON bom_glass_types(tenant_id);
ALTER TABLE bom_glass_types ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_full_access ON bom_glass_types FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation'));
```

- [ ] **Step 2: Apply via `mcp__plugin_supabase_supabase__apply_migration`**, `name: "bom_reference_tables"`.

- [ ] **Step 3: Verify**

Run: `SELECT column_name FROM information_schema.columns WHERE table_name = 'aluminum_profiles' AND column_name IN ('family','series','thickness_mm');` via `execute_sql`.
Expected: 3 rows.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/2026-09-10-06-bom-reference-tables.sql
git commit -m "feat: add aluminum profile axes and BOM reference catalogs"
```

---

### Task 3: `bom_templates` and its children

**Files:**
- Create: `supabase/migrations/2026-09-10-07-bom-templates.sql`

**Interfaces:**
- Consumes: nothing from Task 2 by FK (`profile_family` is plain TEXT per the spec's ruling).
- Produces: `bom_templates(id, tenant_id, name, category, waste_pct, glass_width_deduction_mm, glass_height_deduction_mm, grid_row_weights, grid_horizontal_rail_family, grid_vertical_mullion_family, active, created_at)`; `bom_template_components(id, tenant_id, template_id, role_name, profile_family, length_rule_type, length_deduction_mm, quantity_basis, quantity_value, sort_order)`; `bom_template_hardware(id, tenant_id, template_id, name, reference_unit_price, inventory_item_id, quantity_basis, quantity_value, sort_order)`; `bom_template_constraints(id, tenant_id, template_id, rule_type, value, message)`.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/2026-09-10-07-bom-templates.sql
-- BOM Template Engine, part 2 of 3: the template itself and its children.
-- See spec's Data model / Decision 10 for the grid rationale.
CREATE TABLE bom_templates (
  id                           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id                    UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  name                         TEXT NOT NULL,
  category                     TEXT NOT NULL CHECK (category IN ('door','window')),
  waste_pct                    NUMERIC NOT NULL DEFAULT 10,
  glass_width_deduction_mm     NUMERIC NOT NULL DEFAULT 0,
  glass_height_deduction_mm    NUMERIC NOT NULL DEFAULT 0,
  grid_row_weights             JSONB NOT NULL DEFAULT '[1]',
  grid_horizontal_rail_family  TEXT,
  grid_vertical_mullion_family TEXT,
  active                       BOOLEAN NOT NULL DEFAULT true,
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_bom_templates_tenant_id ON bom_templates(tenant_id);
ALTER TABLE bom_templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_full_access ON bom_templates FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation'));

CREATE TABLE bom_template_components (
  id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id           UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  template_id         UUID NOT NULL REFERENCES bom_templates(id) ON DELETE CASCADE,
  role_name           TEXT NOT NULL,
  profile_family      TEXT NOT NULL,
  length_rule_type    TEXT NOT NULL CHECK (length_rule_type IN
                       ('width','height','width_minus','height_minus','perimeter')),
  length_deduction_mm NUMERIC NOT NULL DEFAULT 0,
  quantity_basis      TEXT NOT NULL CHECK (quantity_basis IN ('fixed','per_cell')),
  quantity_value      NUMERIC NOT NULL DEFAULT 1,
  sort_order          INT NOT NULL DEFAULT 0
);

CREATE INDEX idx_bom_template_components_template_id ON bom_template_components(template_id);
CREATE INDEX idx_bom_template_components_tenant_id ON bom_template_components(tenant_id);
ALTER TABLE bom_template_components ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_full_access ON bom_template_components FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation'));

CREATE TABLE bom_template_hardware (
  id                   UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id            UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  template_id          UUID NOT NULL REFERENCES bom_templates(id) ON DELETE CASCADE,
  name                 TEXT NOT NULL,
  reference_unit_price NUMERIC NOT NULL,
  inventory_item_id    UUID REFERENCES inventory_items(id) ON DELETE SET NULL,
  quantity_basis       TEXT NOT NULL CHECK (quantity_basis IN ('fixed','per_cell','per_perimeter_m')),
  quantity_value       NUMERIC NOT NULL DEFAULT 1,
  sort_order           INT NOT NULL DEFAULT 0
);

CREATE INDEX idx_bom_template_hardware_template_id ON bom_template_hardware(template_id);
CREATE INDEX idx_bom_template_hardware_tenant_id ON bom_template_hardware(tenant_id);
ALTER TABLE bom_template_hardware ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_full_access ON bom_template_hardware FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation'));

CREATE TABLE bom_template_constraints (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id   UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  template_id UUID NOT NULL REFERENCES bom_templates(id) ON DELETE CASCADE,
  rule_type   TEXT NOT NULL CHECK (rule_type IN
              ('max_width_mm','max_height_mm','max_span_mm','max_panel_count')),
  value       NUMERIC NOT NULL,
  message     TEXT NOT NULL
);

CREATE INDEX idx_bom_template_constraints_template_id ON bom_template_constraints(template_id);
CREATE INDEX idx_bom_template_constraints_tenant_id ON bom_template_constraints(tenant_id);
ALTER TABLE bom_template_constraints ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_full_access ON bom_template_constraints FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation'));
```

- [ ] **Step 2: Apply via `mcp__plugin_supabase_supabase__apply_migration`**, `name: "bom_templates"`.

- [ ] **Step 3: Verify**

Run: `SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'bom_template%';` via `execute_sql`.
Expected: 4 rows (`bom_templates`, `bom_template_components`, `bom_template_hardware`, `bom_template_constraints`).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/2026-09-10-07-bom-templates.sql
git commit -m "feat: add bom_templates and its component/hardware/constraint tables"
```

---

### Task 4: `estimation_projects` and `estimation_openings`

**Files:**
- Create: `supabase/migrations/2026-09-10-08-estimation-openings.sql`

**Interfaces:**
- Consumes: `bom_templates(id)` (Task 3), `aluminum_finishes(id)` / `bom_glass_types(id)` (Task 2), `clients(id)` (already exists).
- Produces: `estimation_projects(id, tenant_id, name, client_id, status, created_at)`; `estimation_openings(id, tenant_id, project_id, opening_no, template_id, series, thickness_mm, finish_id, glass_type_id, width_m, height_m, panel_count, quantity, extra_lines, created_at)`.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/2026-09-10-08-estimation-openings.sql
-- BOM Template Engine, part 3 of 3: projects and their openings. No AI
-- drawing extraction yet (spec Non-goals) -- rows come from the manual
-- entry form Task 10 builds.
CREATE TABLE estimation_projects (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id  UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  name       TEXT NOT NULL,
  client_id  UUID REFERENCES clients(id) ON DELETE SET NULL,
  status     TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','reviewed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_estimation_projects_tenant_id ON estimation_projects(tenant_id);
ALTER TABLE estimation_projects ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_full_access ON estimation_projects FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation'));

CREATE TABLE estimation_openings (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id     UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  project_id    UUID NOT NULL REFERENCES estimation_projects(id) ON DELETE CASCADE,
  opening_no    TEXT NOT NULL,
  template_id   UUID NOT NULL REFERENCES bom_templates(id) ON DELETE RESTRICT,
  series        TEXT NOT NULL,
  thickness_mm  NUMERIC NOT NULL,
  finish_id     UUID NOT NULL REFERENCES aluminum_finishes(id) ON DELETE RESTRICT,
  glass_type_id UUID REFERENCES bom_glass_types(id) ON DELETE RESTRICT,
  width_m       NUMERIC NOT NULL,
  height_m      NUMERIC NOT NULL,
  panel_count   INT NOT NULL DEFAULT 1,
  quantity      INT NOT NULL DEFAULT 1,
  extra_lines   JSONB NOT NULL DEFAULT '[]',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_estimation_openings_project_id ON estimation_openings(project_id);
CREATE INDEX idx_estimation_openings_tenant_id ON estimation_openings(tenant_id);
ALTER TABLE estimation_openings ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_full_access ON estimation_openings FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation'));
```

- [ ] **Step 2: Apply via `mcp__plugin_supabase_supabase__apply_migration`**, `name: "estimation_openings"`.

- [ ] **Step 3: Verify**

Run: `SELECT table_name FROM information_schema.tables WHERE table_name IN ('estimation_projects','estimation_openings');` via `execute_sql`.
Expected: 2 rows.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/2026-09-10-08-estimation-openings.sql
git commit -m "feat: add estimation_projects and estimation_openings"
```

---

### Task 5: `bomEngine.js` — the pure BOM computation

**Files:**
- Create: `src/lib/bomEngine.js`
- Test: `src/lib/bomEngine.test.js`

**Interfaces:**
- Produces: `computeBomForOpening(opening, template, components, hardware, profiles, finish, glassType)` → `{ profileLines, gridLines, hardwareLines, glassArea_sqm, glassCost, wasteCost, extraLinesCost, totalCost, unresolvedComponents }` — the exact shape from the spec's Business logic section. This is what Tasks 9 and 10's UI call directly; no other task changes this file.
- Consumes: nothing (pure function, no imports from other new files).

No Supabase mocking needed — every test below constructs plain JS fixtures.

- [ ] **Step 1: Write the failing tests**

```javascript
// src/lib/bomEngine.test.js
import { describe, it, expect } from 'vitest'
import { computeBomForOpening } from './bomEngine.js'

const PROFILE = { family: 'Frame-General', series: 'General', thickness_mm: 1.2, linear_weight_kg_per_m: 1.5 }
const FINISH = { price_per_kg: 170 }
const GLASS = { price_per_sqm: 500 }

function baseTemplate(overrides = {}) {
  return {
    waste_pct: 10,
    glass_width_deduction_mm: 80,
    glass_height_deduction_mm: 80,
    grid_row_weights: [1],
    grid_horizontal_rail_family: null,
    grid_vertical_mullion_family: null,
    ...overrides,
  }
}

function baseOpening(overrides = {}) {
  return {
    width_m: 2, height_m: 2, panel_count: 1, series: 'General', thickness_mm: 1.2,
    quantity: 1, extra_lines: [],
    ...overrides,
  }
}

describe('computeBomForOpening -- length_rule_type presets', () => {
  it('width: uses opening width directly', () => {
    const components = [{ role_name: 'Top rail', profile_family: 'Frame-General', length_rule_type: 'width', length_deduction_mm: 0, quantity_basis: 'fixed', quantity_value: 1 }]
    const result = computeBomForOpening(baseOpening(), baseTemplate(), components, [], [PROFILE], FINISH, GLASS)
    expect(result.profileLines[0].length_m).toBe(2)
  })

  it('height: uses opening height directly', () => {
    const components = [{ role_name: 'Side jamb', profile_family: 'Frame-General', length_rule_type: 'height', length_deduction_mm: 0, quantity_basis: 'fixed', quantity_value: 1 }]
    const result = computeBomForOpening(baseOpening({ width_m: 2, height_m: 3 }), baseTemplate(), components, [], [PROFILE], FINISH, GLASS)
    expect(result.profileLines[0].length_m).toBe(3)
  })

  it('width_minus: subtracts the deduction in meters', () => {
    const components = [{ role_name: 'Lock rail', profile_family: 'Frame-General', length_rule_type: 'width_minus', length_deduction_mm: 400, quantity_basis: 'fixed', quantity_value: 1 }]
    const result = computeBomForOpening(baseOpening({ width_m: 2 }), baseTemplate(), components, [], [PROFILE], FINISH, GLASS)
    expect(result.profileLines[0].length_m).toBeCloseTo(1.6)
  })

  it('height_minus: subtracts the deduction in meters', () => {
    const components = [{ role_name: 'Stile', profile_family: 'Frame-General', length_rule_type: 'height_minus', length_deduction_mm: 40, quantity_basis: 'fixed', quantity_value: 2 }]
    const result = computeBomForOpening(baseOpening({ height_m: 2 }), baseTemplate(), components, [], [PROFILE], FINISH, GLASS)
    expect(result.profileLines[0].length_m).toBeCloseTo(1.96)
  })

  it('perimeter: 2 x (width + height)', () => {
    const components = [{ role_name: 'Weatherstrip frame', profile_family: 'Frame-General', length_rule_type: 'perimeter', length_deduction_mm: 0, quantity_basis: 'fixed', quantity_value: 1 }]
    const result = computeBomForOpening(baseOpening({ width_m: 2, height_m: 3 }), baseTemplate(), components, [], [PROFILE], FINISH, GLASS)
    expect(result.profileLines[0].length_m).toBe(10)
  })
})

describe('computeBomForOpening -- quantity_basis', () => {
  it('fixed: uses quantity_value as-is', () => {
    const components = [{ role_name: 'Side jamb', profile_family: 'Frame-General', length_rule_type: 'height', length_deduction_mm: 0, quantity_basis: 'fixed', quantity_value: 2 }]
    const result = computeBomForOpening(baseOpening(), baseTemplate(), components, [], [PROFILE], FINISH, GLASS)
    expect(result.profileLines[0].quantity).toBe(2)
  })

  it('per_cell: multiplies by rowCount x columnCount', () => {
    const components = [{ role_name: 'Corner block', profile_family: 'Frame-General', length_rule_type: 'width', length_deduction_mm: 0, quantity_basis: 'per_cell', quantity_value: 1 }]
    const template = baseTemplate({ grid_row_weights: [0.25, 0.75] })
    const result = computeBomForOpening(baseOpening({ panel_count: 2 }), template, components, [], [PROFILE], FINISH, GLASS)
    expect(result.profileLines[0].quantity).toBe(4) // 2 rows x 2 columns
  })
})

describe('computeBomForOpening -- waste_pct', () => {
  it('applies only to the aluminum subtotal (components + grid lines)', () => {
    const components = [{ role_name: 'Top rail', profile_family: 'Frame-General', length_rule_type: 'width', length_deduction_mm: 0, quantity_basis: 'fixed', quantity_value: 1 }]
    const template = baseTemplate({ waste_pct: 20, glass_width_deduction_mm: 0, glass_height_deduction_mm: 0 })
    const result = computeBomForOpening(baseOpening({ width_m: 2, height_m: 2 }), template, components, [], [PROFILE], FINISH, null)
    // length 2m x qty 1 x 1.5 kg/m = 3kg x 170 = 510
    expect(result.profileLines[0].cost).toBeCloseTo(510)
    expect(result.wasteCost).toBeCloseTo(102) // 510 x 20%
  })
})

describe('computeBomForOpening -- grid-derived members', () => {
  it('adds no horizontal rail when grid_row_weights has length 1', () => {
    const template = baseTemplate({ grid_row_weights: [1], grid_horizontal_rail_family: 'Frame-General' })
    const result = computeBomForOpening(baseOpening(), template, [], [], [PROFILE], FINISH, GLASS)
    expect(result.gridLines.filter(l => l.orientation === 'horizontal')).toHaveLength(0)
  })

  it('adds rowCount - 1 horizontal rails, full opening width, when weighted rows are set', () => {
    const template = baseTemplate({ grid_row_weights: [0.25, 0.75], grid_horizontal_rail_family: 'Frame-General' })
    const result = computeBomForOpening(baseOpening({ width_m: 2.5, height_m: 2 }), template, [], [], [PROFILE], FINISH, GLASS)
    const rails = result.gridLines.filter(l => l.orientation === 'horizontal')
    expect(rails).toHaveLength(1)
    expect(rails[0].length_m).toBe(2.5)
  })

  it('adds columnCount - 1 vertical mullions, full opening height, when panel_count > 1', () => {
    const template = baseTemplate({ grid_vertical_mullion_family: 'Frame-General' })
    const result = computeBomForOpening(baseOpening({ width_m: 2, height_m: 2.2, panel_count: 3 }), template, [], [], [PROFILE], FINISH, GLASS)
    const mullions = result.gridLines.filter(l => l.orientation === 'vertical')
    expect(mullions).toHaveLength(2)
    expect(mullions[0].length_m).toBe(2.2)
  })

  it('adds no vertical mullion when panel_count is 1, even if a family is set', () => {
    const template = baseTemplate({ grid_vertical_mullion_family: 'Frame-General' })
    const result = computeBomForOpening(baseOpening({ panel_count: 1 }), template, [], [], [PROFILE], FINISH, GLASS)
    expect(result.gridLines.filter(l => l.orientation === 'vertical')).toHaveLength(0)
  })
})

describe('computeBomForOpening -- glass area, per cell', () => {
  it('single-cell opening: (width - deduction) x (height - deduction)', () => {
    const template = baseTemplate({ glass_width_deduction_mm: 80, glass_height_deduction_mm: 80 })
    const result = computeBomForOpening(baseOpening({ width_m: 1, height_m: 1 }), template, [], [], [PROFILE], FINISH, GLASS)
    expect(result.glassArea_sqm).toBeCloseTo(0.92 * 0.92)
    expect(result.glassCost).toBeCloseTo(0.92 * 0.92 * 500)
  })

  it('sums across every cell of a weighted-row, multi-column grid', () => {
    const template = baseTemplate({ grid_row_weights: [0.25, 0.75], glass_width_deduction_mm: 80, glass_height_deduction_mm: 80 })
    const result = computeBomForOpening(baseOpening({ width_m: 2, height_m: 2, panel_count: 2 }), template, [], [], [PROFILE], FINISH, GLASS)
    // 2 rows x 2 columns = 4 cells. columns: 1m wide each. rows: 0.5m and 1.5m tall.
    const cell1 = (1 - 0.08) * (0.5 - 0.08)
    const cell2 = (1 - 0.08) * (1.5 - 0.08)
    const expectedArea = 2 * cell1 + 2 * cell2
    expect(result.glassArea_sqm).toBeCloseTo(expectedArea)
  })

  it('is zero when no glassType is supplied', () => {
    const result = computeBomForOpening(baseOpening(), baseTemplate(), [], [], [PROFILE], FINISH, null)
    expect(result.glassArea_sqm).toBe(0)
    expect(result.glassCost).toBe(0)
  })
})

describe('computeBomForOpening -- hardware', () => {
  it('fixed basis uses quantity_value as-is', () => {
    const hardware = [{ name: 'Handle', reference_unit_price: 200, quantity_basis: 'fixed', quantity_value: 1 }]
    const result = computeBomForOpening(baseOpening(), baseTemplate(), [], hardware, [PROFILE], FINISH, GLASS)
    expect(result.hardwareLines[0].quantity).toBe(1)
    expect(result.hardwareLines[0].cost).toBe(200)
  })

  it('per_cell multiplies by rowCount x columnCount', () => {
    const hardware = [{ name: 'Hinge', reference_unit_price: 150, quantity_basis: 'per_cell', quantity_value: 3 }]
    const result = computeBomForOpening(baseOpening({ panel_count: 2 }), baseTemplate(), [], hardware, [PROFILE], FINISH, GLASS)
    expect(result.hardwareLines[0].quantity).toBe(6)
    expect(result.hardwareLines[0].cost).toBe(900)
  })

  it('per_perimeter_m multiplies by 2 x (width + height)', () => {
    const hardware = [{ name: 'Weatherstrip', reference_unit_price: 10, quantity_basis: 'per_perimeter_m', quantity_value: 1 }]
    const result = computeBomForOpening(baseOpening({ width_m: 2, height_m: 3 }), baseTemplate(), [], hardware, [PROFILE], FINISH, GLASS)
    expect(result.hardwareLines[0].quantity).toBe(10)
    expect(result.hardwareLines[0].cost).toBe(100)
  })
})

describe('computeBomForOpening -- unresolved components', () => {
  it('flags a component with no matching profile, contributes zero cost, never guesses', () => {
    const components = [{ role_name: 'Top rail', profile_family: 'Nonexistent', length_rule_type: 'width', length_deduction_mm: 0, quantity_basis: 'fixed', quantity_value: 1 }]
    const result = computeBomForOpening(baseOpening(), baseTemplate(), components, [], [PROFILE], FINISH, GLASS)
    expect(result.unresolvedComponents).toContain('Top rail')
    expect(result.profileLines[0].resolved).toBe(false)
    expect(result.profileLines[0].cost).toBe(0)
  })

  it('flags a grid-derived member with no matching profile', () => {
    const template = baseTemplate({ grid_vertical_mullion_family: 'Nonexistent' })
    const result = computeBomForOpening(baseOpening({ panel_count: 2 }), template, [], [], [PROFILE], FINISH, GLASS)
    expect(result.gridLines[0].resolved).toBe(false)
    expect(result.unresolvedComponents.length).toBeGreaterThan(0)
  })
})

describe('computeBomForOpening -- extra_lines and totalCost', () => {
  it('sums extra_lines amounts into extraLinesCost and the total', () => {
    const opening = baseOpening({ extra_lines: [{ description: 'Curved bending', amount: 500 }, { description: 'Bracket', amount: 300 }] })
    const result = computeBomForOpening(opening, baseTemplate(), [], [], [PROFILE], FINISH, null)
    expect(result.extraLinesCost).toBe(800)
    expect(result.totalCost).toBeCloseTo(result.wasteCost + 800) // no components/hardware/glass in this fixture
  })

  it('totalCost is a per-unit figure -- does not multiply by opening.quantity', () => {
    const opening = baseOpening({ quantity: 5, extra_lines: [{ description: 'x', amount: 100 }] })
    const result = computeBomForOpening(opening, baseTemplate(), [], [], [PROFILE], FINISH, null)
    expect(result.totalCost).toBeCloseTo(result.wasteCost + 100)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/bomEngine.test.js`
Expected: FAIL — `bomEngine.js` does not exist / `computeBomForOpening` is not a function.

- [ ] **Step 3: Implement `bomEngine.js`**

```javascript
// src/lib/bomEngine.js
// ============================================================
// Pure computation of a per-unit BOM and cost for one estimation_opening,
// given its bom_template and the reference catalogs it needs. No I/O --
// callers (BomTemplates.jsx's preview, Estimation.jsx) load every input
// once and call this on every keystroke. Mirrors the house style already
// used by inventoryCost.js.
//
// See docs/superpowers/specs/2026-09-10-bom-template-engine-design.md's
// "Business logic" section -- this is a direct implementation of it.
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

export function computeBomForOpening(opening, template, components, hardware, profiles, finish, glassType) {
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

  let glassArea_sqm = 0
  if (glassType) {
    const wDed = template.glass_width_deduction_mm / 1000
    const hDed = template.glass_height_deduction_mm / 1000
    // Each entry in `cells` already represents one column's width (cellWidth_m
    // = width_m / columnCount) for that row -- so one row's total glass area
    // is columnCount identical cells, not a second loop over columns.
    for (const cell of cells) {
      glassArea_sqm += columnCount * Math.max(0, cell.width_m - wDed) * Math.max(0, cell.height_m - hDed)
    }
  }
  const glassCost = glassType ? glassArea_sqm * glassType.price_per_sqm : 0

  const extraLinesCost = (opening.extra_lines || []).reduce((s, l) => s + l.amount, 0)

  const totalCost = aluminumSubtotal + wasteCost + hardwareLines.reduce((s, l) => s + l.cost, 0) + glassCost + extraLinesCost

  return { profileLines, gridLines, hardwareLines, glassArea_sqm, glassCost, wasteCost, extraLinesCost, totalCost, unresolvedComponents }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/bomEngine.test.js`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/bomEngine.js src/lib/bomEngine.test.js
git commit -m "feat: add bomEngine pure BOM computation with tests"
```

---

### Task 6: Data hooks for the new tables

**Files:**
- Modify: `src/hooks/useSupabase.js`

**Interfaces:**
- Consumes: Tasks 1-4's tables.
- Produces: `useBomTemplates()`, `useBomTemplateComponents()`, `useBomTemplateHardware()`, `useBomTemplateConstraints()`, `useAluminumFinishes()`, `useBomGlassTypes()`, `useEstimationProjects()`, `useEstimationOpenings()` — each returns `{ data, loading, error, refetch }` via the existing `useQuery` helper, matching `useAllAluminumProfiles()`'s exact shape. Tasks 8, 9, 10 import these.

- [ ] **Step 1: Add the hooks**

Append to `src/hooks/useSupabase.js` (near `useAllAluminumProfiles`, same file already imported by `Inventory.jsx`):

```javascript
/** Every BOM template regardless of active flag -- the template editor's
 *  own list needs to see and manage inactive ones too. */
export function useBomTemplates() {
  return useQuery(async () => {
    const { data, error } = await supabase.from('bom_templates').select('*').order('name')
    if (error) throw error
    return data
  })
}

export function useBomTemplateComponents() {
  return useQuery(async () => {
    const { data, error } = await supabase.from('bom_template_components').select('*').order('sort_order')
    if (error) throw error
    return data
  })
}

export function useBomTemplateHardware() {
  return useQuery(async () => {
    const { data, error } = await supabase.from('bom_template_hardware').select('*').order('sort_order')
    if (error) throw error
    return data
  })
}

export function useBomTemplateConstraints() {
  return useQuery(async () => {
    const { data, error } = await supabase.from('bom_template_constraints').select('*')
    if (error) throw error
    return data
  })
}

export function useAluminumFinishes() {
  return useQuery(async () => {
    const { data, error } = await supabase.from('aluminum_finishes').select('*').order('name')
    if (error) throw error
    return data
  })
}

export function useBomGlassTypes() {
  return useQuery(async () => {
    const { data, error } = await supabase.from('bom_glass_types').select('*').order('name')
    if (error) throw error
    return data
  })
}

export function useEstimationProjects() {
  return useQuery(async () => {
    const { data, error } = await supabase
      .from('estimation_projects')
      .select('*, clients(name)')
      .order('created_at', { ascending: false })
    if (error) throw error
    return data
  })
}

export function useEstimationOpenings() {
  return useQuery(async () => {
    const { data, error } = await supabase
      .from('estimation_openings')
      .select('*, bom_templates(name, category)')
      .order('opening_no')
    if (error) throw error
    return data
  })
}
```

- [ ] **Step 2: Manually verify**

Run: `npm run dev`, open the browser console on any already-logged-in page, and run `await window.supabase?.from('bom_templates').select('*')` is not applicable (no global) — instead, temporarily add `console.log(useBomTemplates())` is not testable outside a component. Skip runtime verification here; Task 8/9's screens are what actually exercise these hooks, and their own manual QA step covers this.
Expected: no action needed — this step intentionally has no independent check; see Task 8.

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useSupabase.js
git commit -m "feat: add data hooks for BOM template engine tables"
```

---

### Task 7: Restore and extend the aluminum-profile subtab in `Inventory.jsx`

**Files:**
- Modify: `src/pages/Inventory.jsx:150` (`EMPTY_PROFILE_FORM`), `:152-189` (`ProfileForm`), `:669-688` (`handleSaveProfile`), `:699-707` (nav buttons), `:795-841` (profiles table view)
- Modify: `src/components/ExcelUpload.jsx:295-313` (`parseAluminumProfileSheet`)

**Interfaces:**
- Consumes: Task 2's `aluminum_profiles.family/series/thickness_mm` columns.
- Produces: nothing new consumed by later tasks (family/series values become freely-typeable strings that Task 9's template editor autocompletes against, read directly via the existing `useAllAluminumProfiles()`/`useAluminumProfiles()` hooks — no new hook needed).

This subtab's nav button was intentionally pulled from the UI (see the `TODO(aluminum-profiles-subtab)` comment at `Inventory.jsx:702-705`) while its CRUD code was left intact. This task re-adds the button and extends the form/table with the three new fields the BOM engine needs.

- [ ] **Step 1: Restore the nav button**

In `src/pages/Inventory.jsx`, replace:

```javascript
        {/* TODO(aluminum-profiles-subtab): "หน้าตัดอลูมิเนียม" pulled from
            the UI -- not finished yet. The view/CRUD code below is left
            intact; just re-add this button (and the ExcelUpload
            type="aluminum_profile" entry point inside it) once ready. */}
        <button className={`btn btn-sm ${view === 'movements' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setView('movements')}>📜 ประวัติการเคลื่อนไหว</button>
```

with:

```javascript
        <button className={`btn btn-sm ${view === 'profiles' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setView('profiles')}>📐 หน้าตัดอลูมิเนียม</button>
        <button className={`btn btn-sm ${view === 'movements' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setView('movements')}>📜 ประวัติการเคลื่อนไหว</button>
```

- [ ] **Step 2: Extend the profile form's default state and fields**

Replace `EMPTY_PROFILE_FORM`:

```javascript
const EMPTY_PROFILE_FORM = { name: '', family: '', series: '', thickness_mm: '', linear_weight_kg_per_m: '', default_length_m: '6.4' }
```

In `ProfileForm`, insert three fields after the "ชื่อหน้าตัด" field and before "น้ำหนัก (กก./เมตร)":

```javascript
        <div>
          <label className="label">กลุ่มหน้าตัด (family) — สำหรับผูกกับ BOM Template</label>
          <input className="input" value={form.family} onChange={e => set('family', e.target.value)} placeholder="เช่น กล่องร่อง" />
        </div>
        <div>
          <label className="label">รุ่น/ซีรีส์ (series)</label>
          <input className="input" value={form.series} onChange={e => set('series', e.target.value)} placeholder="เช่น ทั่วไป, ยูโร, วิสดอม" />
        </div>
        <div>
          <label className="label">ความหนา (มม.)</label>
          <input className="input" type="number" min="0" step="0.1" value={form.thickness_mm} onChange={e => set('thickness_mm', e.target.value)} placeholder="เช่น 1.2" />
        </div>
```

- [ ] **Step 3: Persist the new fields on save**

In `handleSaveProfile`, replace the `payload` construction:

```javascript
      const payload = {
        name: form.name,
        family: form.family || null,
        series: form.series || null,
        thickness_mm: form.thickness_mm ? parseFloat(form.thickness_mm) : null,
        linear_weight_kg_per_m: parseFloat(form.linear_weight_kg_per_m) || 0,
        default_length_m: form.default_length_m ? parseFloat(form.default_length_m) : 6.4,
        active: form.active !== false,
      }
```

- [ ] **Step 4: Show the new fields in the profiles table**

In the `view === 'profiles'` table, replace the header row:

```javascript
                <thead><tr>
                  <th className="sortable" onClick={() => profileToggleSort('name')}>ชื่อหน้าตัด{profileSi('name')}</th>
                  <th className="sortable" onClick={() => profileToggleSort('family')}>กลุ่ม{profileSi('family')}</th>
                  <th className="sortable" onClick={() => profileToggleSort('series')}>รุ่น{profileSi('series')}</th>
                  <th className="sortable" onClick={() => profileToggleSort('thickness_mm')}>หนา (มม.){profileSi('thickness_mm')}</th>
                  <th className="sortable" onClick={() => profileToggleSort('linear_weight_kg_per_m')}>กก./เมตร{profileSi('linear_weight_kg_per_m')}</th>
                  <th className="sortable" onClick={() => profileToggleSort('default_length_m')}>ความยาวมาตรฐาน{profileSi('default_length_m')}</th>
                  <th className="sortable" onClick={() => profileToggleSort('active')}>สถานะ{profileSi('active')}</th>
                  <th></th>
                </tr></thead>
```

and each row's cells:

```javascript
                    <tr key={p.id}>
                      <td style={{ fontWeight: 600 }}>{p.name}</td>
                      <td>{p.family || '—'}</td>
                      <td>{p.series || '—'}</td>
                      <td className="font-mono">{p.thickness_mm ?? '—'}</td>
                      <td className="font-mono">{fmt(p.linear_weight_kg_per_m)}</td>
                      <td className="font-mono">{fmt(p.default_length_m)} ม.</td>
                      <td>{p.active ? <span className="badge badge-paid">ใช้งานอยู่</span> : <span className="badge badge-finished">ปิดใช้งาน</span>}</td>
```

(leave the actions `<td>` and the `colSpan` on the empty-state row unchanged in structure, just bump `colSpan={5}` to `colSpan={8}` for the new column count.)

- [ ] **Step 5: Extend the Excel importer**

In `src/components/ExcelUpload.jsx`, replace `parseAluminumProfileSheet`:

```javascript
async function parseAluminumProfileSheet(ws) {
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null })
  const headerRowIdx = rows.findIndex(r => r.some(c => typeof c === 'string' && c.includes('ชื่อหน้าตัด')))
  if (headerRowIdx < 0) throw new Error('ไม่พบแถว header (ชื่อหน้าตัด)')
  const dataRows = rows.slice(headerRowIdx + 2)
  const records = []
  for (const row of dataRows) {
    if (!row[0]) continue
    const linearWeight = parseFloat(row[1])
    if (!linearWeight) continue
    const rawLength = row[2] != null ? parseFloat(row[2]) : NaN
    const thickness = row[5] != null ? parseFloat(row[5]) : NaN
    records.push({
      name: String(row[0]),
      linear_weight_kg_per_m: linearWeight,
      default_length_m: Number.isFinite(rawLength) && rawLength > 0 ? rawLength : 6.4,
      family: row[3] != null ? String(row[3]) : null,
      series: row[4] != null ? String(row[4]) : null,
      thickness_mm: Number.isFinite(thickness) ? thickness : null,
    })
  }
  return records
}
```

(Columns 0-2 unchanged from before; columns 3/4/5 are new, optional — `!row[3]` etc. never skips a row, matching this function's existing "only `name` and `linear_weight_kg_per_m` are required" behavior.)

- [ ] **Step 6: Manual verification**

Run: `npm run dev`, log in as an admin/owner on a tenant with the `purchase_orders` module, go to คลังสินค้า (Inventory) → click "📐 หน้าตัดอลูมิเนียม", click "+ เพิ่มหน้าตัด", fill in name/family/series/thickness/weight, save.
Expected: the new row appears in the table with all three new columns populated; editing it round-trips correctly.

- [ ] **Step 7: Commit**

```bash
git add src/pages/Inventory.jsx src/components/ExcelUpload.jsx
git commit -m "feat: restore aluminum profile subtab and add family/series/thickness fields"
```

---

### Task 8: Small reference catalogs — `BomTemplates.jsx` scaffold, finishes and glass types

**Files:**
- Create: `src/pages/BomTemplates.jsx`

**Interfaces:**
- Consumes: `useBomTemplates`, `useAluminumFinishes`, `useBomGlassTypes` (Task 6).
- Produces: the `view` sub-tab scaffold (`'templates' | 'finishes' | 'glass_types'`) that Task 9 adds the `'templates'` view's content into. Exports `default function BomTemplates(props)`.

This mirrors `Inventory.jsx`'s own multi-view-with-buttons pattern exactly, including its `canEdit` gating.

- [ ] **Step 1: Write the file**

```javascript
// src/pages/BomTemplates.jsx
// ============================================================
// BOM Templates -- admin screen for the estimation module's guided
// template editor plus its two small reference catalogs (finishes,
// glass types). Gated on has_module_access('estimation').
// See docs/superpowers/specs/2026-09-10-bom-template-engine-design.md.
// ============================================================
import { useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { useBomTemplates, useAluminumFinishes, useBomGlassTypes } from '../hooks/useSupabase.js'
import { useUserRole } from '../hooks/useUserRole.js'
import { canEditPage } from '../lib/permissions.js'
import { fmt } from '../lib/supabase.js'
import { Modal, ConfirmDialog } from '../components/Modal.jsx'
import { useDraftForm } from '../hooks/useDraftForm.js'

function FinishForm({ initial, onSave, onCancel, loading }) {
  const [form, setForm, clearDraft] = useDraftForm('aluminum-finish-form', { name: '', price_per_kg: '', active: true, ...initial }, !initial?.id)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  return (
    <form onSubmit={e => { e.preventDefault(); clearDraft(); onSave(form) }}>
      <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
        <div>
          <label className="label">ชื่อสีผิว ★</label>
          <input className="input" required value={form.name} onChange={e => set('name', e.target.value)} placeholder="เช่น POWDER COATING SAHARA" />
        </div>
        <div>
          <label className="label">ราคา/กก. ★</label>
          <input className="input" required type="number" min="0" step="0.01" value={form.price_per_kg} onChange={e => set('price_per_kg', e.target.value)} />
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

export default function BomTemplates(props) {
  const { isAtLeast, role } = useUserRole()
  const canEdit = isAtLeast('ADMIN') && canEditPage(role, 'bom_templates')

  const [view, setView] = useState('templates')

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

  const handleSaveFinish = async (form) => {
    setSavingFinish(true)
    try {
      const payload = { name: form.name, price_per_kg: parseFloat(form.price_per_kg) || 0, active: form.active !== false }
      const { error } = editFinish
        ? await supabase.from('aluminum_finishes').update(payload).eq('id', editFinish.id)
        : await supabase.from('aluminum_finishes').insert(payload)
      if (error) throw error
      setShowFinishForm(false); setEditFinish(null); refetchFinishes()
    } catch (e) { alert('บันทึกไม่สำเร็จ: ' + e.message) }
    finally { setSavingFinish(false) }
  }

  const handleDeleteFinish = async () => {
    if (!deleteFinishId) return
    const { error } = await supabase.from('aluminum_finishes').delete().eq('id', deleteFinishId)
    if (!error) { setDeleteFinishId(null); refetchFinishes() }
    else alert('ลบไม่สำเร็จ (อาจมีการใช้งานผูกอยู่): ' + error.message)
  }

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

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button className={`btn btn-sm ${view === 'templates' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setView('templates')}>🧩 BOM Templates</button>
        <button className={`btn btn-sm ${view === 'finishes' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setView('finishes')}>🎨 สีผิวอลูมิเนียม</button>
        <button className={`btn btn-sm ${view === 'glass_types' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setView('glass_types')}>🪟 ชนิดกระจก</button>
      </div>

      {view === 'templates' && (
        <div style={{ color: 'var(--text3)' }}>Task 9 fills this in.</div>
      )}

      {view === 'finishes' && (
        <>
          {canEdit && <button className="btn btn-primary" style={{ marginBottom: 14 }} onClick={() => { setEditFinish(null); setShowFinishForm(true) }}>+ เพิ่มสีผิว</button>}
          <div className="card">
            <div className="table-wrap">
              <table>
                <thead><tr><th>ชื่อสีผิว</th><th>ราคา/กก.</th><th>สถานะ</th><th></th></tr></thead>
                <tbody>
                  {(finishes || []).map(f => (
                    <tr key={f.id}>
                      <td style={{ fontWeight: 600 }}>{f.name}</td>
                      <td className="font-mono">{fmt(f.price_per_kg)}</td>
                      <td>{f.active ? <span className="badge badge-paid">ใช้งานอยู่</span> : <span className="badge badge-finished">ปิดใช้งาน</span>}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {canEdit && (
                          <>
                            <button className="btn btn-sm btn-ghost" onClick={() => { setEditFinish(f); setShowFinishForm(true) }}>แก้ไข</button>
                            <button className="btn btn-sm btn-ghost" style={{ color: 'var(--red)' }} onClick={() => setDeleteFinishId(f.id)}>ลบ</button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                  {!(finishes || []).length && <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--text3)', padding: 24 }}>ยังไม่มีสีผิว</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

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

      {showFinishForm && (
        <Modal title={editFinish ? `แก้ไข ${editFinish.name}` : 'เพิ่มสีผิวใหม่'} onClose={() => { setShowFinishForm(false); setEditFinish(null) }} maxWidth={420}>
          <FinishForm initial={editFinish || {}} onSave={handleSaveFinish} onCancel={() => { setShowFinishForm(false); setEditFinish(null) }} loading={savingFinish} />
        </Modal>
      )}
      {deleteFinishId && <ConfirmDialog title="ลบสีผิว" message="ยืนยันการลบ?" onConfirm={handleDeleteFinish} onCancel={() => setDeleteFinishId(null)} />}

      {showGlassForm && (
        <Modal title={editGlass ? `แก้ไข ${editGlass.name}` : 'เพิ่มชนิดกระจกใหม่'} onClose={() => { setShowGlassForm(false); setEditGlass(null) }} maxWidth={420}>
          <GlassTypeForm initial={editGlass || {}} onSave={handleSaveGlass} onCancel={() => { setShowGlassForm(false); setEditGlass(null) }} loading={savingGlass} />
        </Modal>
      )}
      {deleteGlassId && <ConfirmDialog title="ลบชนิดกระจก" message="ยืนยันการลบ?" onConfirm={handleDeleteGlass} onCancel={() => setDeleteGlassId(null)} />}
    </div>
  )
}
```

- [ ] **Step 2: Manual verification**

This page isn't reachable yet (Task 11 wires the nav). Verify it compiles: run `npm run build` and confirm no errors reference `BomTemplates.jsx`.
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/pages/BomTemplates.jsx
git commit -m "feat: add BomTemplates page scaffold with finishes and glass types catalogs"
```

---

### Task 9: The template editor — grid, components, hardware, constraints

**Files:**
- Modify: `src/pages/BomTemplates.jsx` (the `view === 'templates'` placeholder from Task 8)

**Interfaces:**
- Consumes: `useBomTemplates`, `useBomTemplateComponents`, `useBomTemplateHardware`, `useBomTemplateConstraints` (Task 6); `useAluminumProfiles` (existing, for the `profile_family` autocomplete datalist).
- Produces: nothing new consumed elsewhere — Task 10's Estimation.jsx reads templates/components/hardware/constraints directly via the same Task 6 hooks, not through this component.

This is the piece that has to stay approachable for a non-expert (spec Goal) — every field is a number input, text input, or `<select>` of the five/two preset enums; nothing accepts a formula.

- [ ] **Step 1: Add the editor**

Add these imports to `src/pages/BomTemplates.jsx`:

```javascript
import { useBomTemplateComponents, useBomTemplateHardware, useBomTemplateConstraints, useAluminumProfiles } from '../hooks/useSupabase.js'
```

Add this component above `export default function BomTemplates`:

```javascript
const LENGTH_RULE_LABELS = {
  width: '= กว้าง (width)',
  height: '= สูง (height)',
  width_minus: '= กว้าง − ระยะหัก (mm)',
  height_minus: '= สูง − ระยะหัก (mm)',
  perimeter: '= เส้นรอบรูป',
}
const QUANTITY_BASIS_LABELS = { fixed: 'จำนวนคงที่', per_cell: 'ต่อช่อง (cell)' }
const HARDWARE_BASIS_LABELS = { fixed: 'จำนวนคงที่', per_cell: 'ต่อช่อง (cell)', per_perimeter_m: 'ต่อเมตรเส้นรอบรูป' }
const CONSTRAINT_TYPE_LABELS = { max_width_mm: 'กว้างสูงสุด (mm)', max_height_mm: 'สูงสุงสุด (mm)', max_span_mm: 'ช่วงกว้างสูงสุด (mm)', max_panel_count: 'จำนวนช่องสูงสุด' }

const EMPTY_TEMPLATE_FORM = {
  name: '', category: 'window', waste_pct: '10',
  glass_width_deduction_mm: '0', glass_height_deduction_mm: '0',
  grid_row_weights: [1],
  grid_horizontal_rail_family: '', grid_vertical_mullion_family: '',
  active: true,
}

function TemplateEditor({ template, allProfiles, components, hardware, constraints, onSaved, onDeleted, canEdit }) {
  const isNew = !template?.id
  const [form, setForm] = useState(() => isNew ? EMPTY_TEMPLATE_FORM : {
    name: template.name, category: template.category, waste_pct: String(template.waste_pct),
    glass_width_deduction_mm: String(template.glass_width_deduction_mm), glass_height_deduction_mm: String(template.glass_height_deduction_mm),
    grid_row_weights: template.grid_row_weights, grid_horizontal_rail_family: template.grid_horizontal_rail_family || '',
    grid_vertical_mullion_family: template.grid_vertical_mullion_family || '', active: template.active,
  })
  const [rows, setRows] = useState(() => isNew ? [] : components.filter(c => c.template_id === template.id).sort((a, b) => a.sort_order - b.sort_order))
  const [hwRows, setHwRows] = useState(() => isNew ? [] : hardware.filter(h => h.template_id === template.id).sort((a, b) => a.sort_order - b.sort_order))
  const [constraintRows, setConstraintRows] = useState(() => isNew ? [] : constraints.filter(c => c.template_id === template.id))
  const [saving, setSaving] = useState(false)

  const familyOptions = [...new Set(allProfiles.map(p => p.family).filter(Boolean))]

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  const setRowWeight = (i, v) => setForm(f => ({ ...f, grid_row_weights: f.grid_row_weights.map((w, idx) => idx === i ? parseFloat(v) || 0 : w) }))
  const addRow = () => setForm(f => ({ ...f, grid_row_weights: [...f.grid_row_weights, 1] }))
  const removeRow = (i) => setForm(f => ({ ...f, grid_row_weights: f.grid_row_weights.filter((_, idx) => idx !== i) }))

  const addComponent = () => setRows(r => [...r, { role_name: '', profile_family: '', length_rule_type: 'width', length_deduction_mm: 0, quantity_basis: 'fixed', quantity_value: 1, sort_order: r.length }])
  const setComponent = (i, k, v) => setRows(r => r.map((row, idx) => idx === i ? { ...row, [k]: v } : row))
  const removeComponent = (i) => setRows(r => r.filter((_, idx) => idx !== i))

  const addHardware = () => setHwRows(r => [...r, { name: '', reference_unit_price: 0, quantity_basis: 'fixed', quantity_value: 1, sort_order: r.length }])
  const setHardware = (i, k, v) => setHwRows(r => r.map((row, idx) => idx === i ? { ...row, [k]: v } : row))
  const removeHardware = (i) => setHwRows(r => r.filter((_, idx) => idx !== i))

  const addConstraint = () => setConstraintRows(r => [...r, { rule_type: 'max_width_mm', value: 0, message: '' }])
  const setConstraint = (i, k, v) => setConstraintRows(r => r.map((row, idx) => idx === i ? { ...row, [k]: v } : row))
  const removeConstraint = (i) => setConstraintRows(r => r.filter((_, idx) => idx !== i))

  // One template, its components, its hardware, and its constraints save
  // together as one unit -- simplest correct approach for a form editor:
  // upsert the template row, then delete-and-reinsert every child table's
  // rows for it. Never partially saves (children only touched after the
  // template row itself succeeds).
  const handleSave = async () => {
    setSaving(true)
    try {
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
      let templateId = template?.id
      if (isNew) {
        const { data, error } = await supabase.from('bom_templates').insert(payload).select('id').single()
        if (error) throw error
        templateId = data.id
      } else {
        const { error } = await supabase.from('bom_templates').update(payload).eq('id', templateId)
        if (error) throw error
      }

      await supabase.from('bom_template_components').delete().eq('template_id', templateId)
      if (rows.length) {
        const { error } = await supabase.from('bom_template_components').insert(
          rows.map((r, i) => ({ ...r, template_id: templateId, length_deduction_mm: parseFloat(r.length_deduction_mm) || 0, quantity_value: parseFloat(r.quantity_value) || 0, sort_order: i }))
        )
        if (error) throw error
      }

      await supabase.from('bom_template_hardware').delete().eq('template_id', templateId)
      if (hwRows.length) {
        const { error } = await supabase.from('bom_template_hardware').insert(
          hwRows.map((h, i) => ({ ...h, template_id: templateId, reference_unit_price: parseFloat(h.reference_unit_price) || 0, quantity_value: parseFloat(h.quantity_value) || 0, sort_order: i }))
        )
        if (error) throw error
      }

      await supabase.from('bom_template_constraints').delete().eq('template_id', templateId)
      if (constraintRows.length) {
        const { error } = await supabase.from('bom_template_constraints').insert(
          constraintRows.map(c => ({ ...c, template_id: templateId, value: parseFloat(c.value) || 0 }))
        )
        if (error) throw error
      }

      onSaved()
    } catch (e) { alert('บันทึกไม่สำเร็จ: ' + e.message) }
    finally { setSaving(false) }
  }

  return (
    <div className="card" style={{ padding: 16, display: 'grid', gap: 16 }}>
      <datalist id="profile-family-options">
        {familyOptions.map(f => <option key={f} value={f} />)}
      </datalist>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 160px', gap: 10 }}>
        <div>
          <label className="label">ชื่อ Template ★</label>
          <input className="input" required disabled={!canEdit} value={form.name} onChange={e => set('name', e.target.value)} placeholder="เช่น Swing Door 2 Leaf General" />
        </div>
        <div>
          <label className="label">ประเภท</label>
          <select className="input" disabled={!canEdit} value={form.category} onChange={e => set('category', e.target.value)}>
            <option value="door">ประตู</option>
            <option value="window">หน้าต่าง</option>
          </select>
        </div>
      </div>

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

      <div>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>โครงสร้างภายใน (Grid)</div>
        <div style={{ display: 'grid', gap: 6 }}>
          {form.grid_row_weights.map((w, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ fontSize: 12, color: 'var(--text3)', width: 60 }}>แถว {i + 1}</span>
              <input className="input input-sm" style={{ width: 100 }} disabled={!canEdit} type="number" min="0" step="0.05" value={w} onChange={e => setRowWeight(i, e.target.value)} />
              {canEdit && form.grid_row_weights.length > 1 && <button type="button" className="btn btn-sm btn-ghost" style={{ color: 'var(--red)' }} onClick={() => removeRow(i)}>✕</button>}
            </div>
          ))}
          {canEdit && <button type="button" className="btn btn-sm btn-ghost" style={{ justifySelf: 'start' }} onClick={addRow}>+ เพิ่มแถว</button>}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10 }}>
          <div>
            <label className="label">โปรไฟล์คานแนวนอน (ถ้ามีมากกว่า 1 แถว)</label>
            <input className="input" disabled={!canEdit} list="profile-family-options" value={form.grid_horizontal_rail_family} onChange={e => set('grid_horizontal_rail_family', e.target.value)} placeholder="เช่น กล่องร่อง" />
          </div>
          <div>
            <label className="label">โปรไฟล์เสากลาง (ถ้าจำนวนช่อง &gt; 1)</label>
            <input className="input" disabled={!canEdit} list="profile-family-options" value={form.grid_vertical_mullion_family} onChange={e => set('grid_vertical_mullion_family', e.target.value)} placeholder="เช่น กล่องร่อง" />
          </div>
        </div>
      </div>

      <div>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>ชิ้นส่วนอลูมิเนียม (Components)</div>
        <div style={{ display: 'grid', gap: 6 }}>
          {rows.map((r, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 80px 1fr 80px 32px', gap: 6, alignItems: 'center' }}>
              <input className="input input-sm" disabled={!canEdit} placeholder="ชื่อชิ้นส่วน" value={r.role_name} onChange={e => setComponent(i, 'role_name', e.target.value)} />
              <input className="input input-sm" disabled={!canEdit} list="profile-family-options" placeholder="กลุ่มหน้าตัด" value={r.profile_family} onChange={e => setComponent(i, 'profile_family', e.target.value)} />
              <select className="input input-sm" disabled={!canEdit} value={r.length_rule_type} onChange={e => setComponent(i, 'length_rule_type', e.target.value)}>
                {Object.entries(LENGTH_RULE_LABELS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
              </select>
              <input className="input input-sm" disabled={!canEdit} type="number" min="0" placeholder="ระยะหัก mm" value={r.length_deduction_mm} onChange={e => setComponent(i, 'length_deduction_mm', e.target.value)} />
              <select className="input input-sm" disabled={!canEdit} value={r.quantity_basis} onChange={e => setComponent(i, 'quantity_basis', e.target.value)}>
                {Object.entries(QUANTITY_BASIS_LABELS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
              </select>
              <input className="input input-sm" disabled={!canEdit} type="number" min="0" placeholder="จำนวน" value={r.quantity_value} onChange={e => setComponent(i, 'quantity_value', e.target.value)} />
              {canEdit && <button type="button" className="btn btn-sm btn-ghost" style={{ color: 'var(--red)' }} onClick={() => removeComponent(i)}>✕</button>}
            </div>
          ))}
          {canEdit && <button type="button" className="btn btn-sm btn-ghost" style={{ justifySelf: 'start' }} onClick={addComponent}>+ เพิ่มชิ้นส่วน</button>}
        </div>
      </div>

      <div>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>อุปกรณ์ (Hardware)</div>
        <div style={{ display: 'grid', gap: 6 }}>
          {hwRows.map((h, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 120px 1fr 80px 32px', gap: 6, alignItems: 'center' }}>
              <input className="input input-sm" disabled={!canEdit} placeholder="ชื่ออุปกรณ์" value={h.name} onChange={e => setHardware(i, 'name', e.target.value)} />
              <input className="input input-sm" disabled={!canEdit} type="number" min="0" placeholder="ราคา/ชิ้น" value={h.reference_unit_price} onChange={e => setHardware(i, 'reference_unit_price', e.target.value)} />
              <select className="input input-sm" disabled={!canEdit} value={h.quantity_basis} onChange={e => setHardware(i, 'quantity_basis', e.target.value)}>
                {Object.entries(HARDWARE_BASIS_LABELS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
              </select>
              <input className="input input-sm" disabled={!canEdit} type="number" min="0" placeholder="จำนวน" value={h.quantity_value} onChange={e => setHardware(i, 'quantity_value', e.target.value)} />
              {canEdit && <button type="button" className="btn btn-sm btn-ghost" style={{ color: 'var(--red)' }} onClick={() => removeHardware(i)}>✕</button>}
            </div>
          ))}
          {canEdit && <button type="button" className="btn btn-sm btn-ghost" style={{ justifySelf: 'start' }} onClick={addHardware}>+ เพิ่มอุปกรณ์</button>}
        </div>
      </div>

      <div>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>ข้อจำกัด (แจ้งเตือนเท่านั้น ไม่บล็อกการบันทึก)</div>
        <div style={{ display: 'grid', gap: 6 }}>
          {constraintRows.map((c, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 120px 2fr 32px', gap: 6, alignItems: 'center' }}>
              <select className="input input-sm" disabled={!canEdit} value={c.rule_type} onChange={e => setConstraint(i, 'rule_type', e.target.value)}>
                {Object.entries(CONSTRAINT_TYPE_LABELS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
              </select>
              <input className="input input-sm" disabled={!canEdit} type="number" min="0" placeholder="ค่า" value={c.value} onChange={e => setConstraint(i, 'value', e.target.value)} />
              <input className="input input-sm" disabled={!canEdit} placeholder="ข้อความแจ้งเตือน" value={c.message} onChange={e => setConstraint(i, 'message', e.target.value)} />
              {canEdit && <button type="button" className="btn btn-sm btn-ghost" style={{ color: 'var(--red)' }} onClick={() => removeConstraint(i)}>✕</button>}
            </div>
          ))}
          {canEdit && <button type="button" className="btn btn-sm btn-ghost" style={{ justifySelf: 'start' }} onClick={addConstraint}>+ เพิ่มข้อจำกัด</button>}
        </div>
      </div>

      {canEdit && (
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          {!isNew && <button type="button" className="btn btn-ghost" style={{ color: 'var(--red)' }} onClick={() => onDeleted(template.id)}>🗑️ ลบ Template</button>}
          <button type="button" className="btn btn-primary" disabled={saving || !form.name} onClick={handleSave}>{saving ? '⏳ กำลังบันทึก...' : '💾 บันทึก'}</button>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Wire it into the `'templates'` view**

Replace the Task 8 placeholder:

```javascript
      {view === 'templates' && (
        <div style={{ color: 'var(--text3)' }}>Task 9 fills this in.</div>
      )}
```

with:

```javascript
      {view === 'templates' && (
        <TemplatesView canEdit={canEdit} />
      )}
```

and add this component above `export default function BomTemplates` (it owns the templates list + delete confirm, delegating the form to `TemplateEditor`):

```javascript
function TemplatesView({ canEdit }) {
  const { data: templates, refetch: refetchTemplates } = useBomTemplates()
  const { data: components } = useBomTemplateComponents()
  const { data: hardware } = useBomTemplateHardware()
  const { data: constraints } = useBomTemplateConstraints()
  const { data: allProfiles } = useAluminumProfiles()
  const [selectedId, setSelectedId] = useState(null)
  const [creating, setCreating] = useState(false)
  const [deleteId, setDeleteId] = useState(null)

  const selected = (templates || []).find(t => t.id === selectedId)

  const handleDelete = async () => {
    if (!deleteId) return
    const { error } = await supabase.from('bom_templates').delete().eq('id', deleteId)
    if (!error) { setDeleteId(null); setSelectedId(null); refetchTemplates() }
    else alert('ลบไม่สำเร็จ (อาจมี opening ที่ใช้ template นี้อยู่): ' + error.message)
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: 16 }}>
      <div className="card" style={{ padding: 12 }}>
        {canEdit && <button className="btn btn-primary btn-sm" style={{ marginBottom: 10, width: '100%' }} onClick={() => { setCreating(true); setSelectedId(null) }}>+ Template ใหม่</button>}
        <div style={{ display: 'grid', gap: 4 }}>
          {(templates || []).map(t => (
            <button key={t.id} className={`btn btn-sm ${selectedId === t.id ? 'btn-primary' : 'btn-ghost'}`} style={{ justifyContent: 'flex-start' }}
              onClick={() => { setSelectedId(t.id); setCreating(false) }}>
              {t.active ? '' : '🚫 '}{t.name}
            </button>
          ))}
          {!(templates || []).length && <div style={{ fontSize: 12, color: 'var(--text3)', padding: 8 }}>ยังไม่มี Template</div>}
        </div>
      </div>
      <div>
        {creating && (
          <TemplateEditor template={null} allProfiles={allProfiles || []} components={[]} hardware={[]} constraints={[]} canEdit={canEdit}
            onSaved={() => { setCreating(false); refetchTemplates() }} onDeleted={() => {}} />
        )}
        {selected && !creating && (
          <TemplateEditor template={selected} allProfiles={allProfiles || []} components={components || []} hardware={hardware || []} constraints={constraints || []} canEdit={canEdit}
            onSaved={refetchTemplates} onDeleted={(id) => setDeleteId(id)} />
        )}
        {!creating && !selected && <div style={{ color: 'var(--text3)', padding: 20 }}>เลือก Template ทางซ้าย หรือสร้างใหม่</div>}
      </div>
      {deleteId && <ConfirmDialog title="ลบ Template" message="ยืนยันการลบ? (ถ้ามี opening ผูกอยู่ การลบจะไม่สำเร็จ)" onConfirm={handleDelete} onCancel={() => setDeleteId(null)} />}
    </div>
  )
}
```

- [ ] **Step 3: Manual verification**

Same as Task 8 step 2: run `npm run build`, confirm no compile errors.
Expected: build succeeds. Full functional QA happens after Task 11 wires the nav (see Task 11's verification step, which exercises this end-to-end).

- [ ] **Step 4: Commit**

```bash
git add src/pages/BomTemplates.jsx
git commit -m "feat: add BOM template guided editor (grid, components, hardware, constraints)"
```

---

### Task 10: `Estimation.jsx` — projects, openings, live BOM

**Files:**
- Create: `src/pages/Estimation.jsx`

**Interfaces:**
- Consumes: `computeBomForOpening` (Task 5); `useBomTemplates`, `useBomTemplateComponents`, `useBomTemplateHardware`, `useBomTemplateConstraints`, `useAluminumFinishes`, `useBomGlassTypes`, `useEstimationProjects`, `useEstimationOpenings` (Task 6); `useAluminumProfiles` (existing).
- Produces: `default function Estimation(props)`.

- [ ] **Step 1: Write the file**

```javascript
// src/pages/Estimation.jsx
// ============================================================
// Estimation -- projects and their openings, with a live-computed BOM
// and unit cost per opening (via bomEngine.js). No AI drawing extraction
// yet (manual entry only, spec Non-goals); doesn't write into quotations
// or purchase_orders (spec Non-goals) -- this is where those future
// features will read from.
// ============================================================
import { useState, useMemo } from 'react'
import { supabase } from '../lib/supabase.js'
import {
  useEstimationProjects, useEstimationOpenings, useBomTemplates, useBomTemplateComponents,
  useBomTemplateHardware, useBomTemplateConstraints, useAluminumFinishes, useBomGlassTypes, useAluminumProfiles,
} from '../hooks/useSupabase.js'
import { useUserRole } from '../hooks/useUserRole.js'
import { canEditPage } from '../lib/permissions.js'
import { fmt } from '../lib/supabase.js'
import { computeBomForOpening } from '../lib/bomEngine.js'
import { Modal, ConfirmDialog } from '../components/Modal.jsx'
import SearchableSelect from '../components/SearchableSelect.jsx'

function evaluateConstraints(opening, constraints) {
  const violations = []
  for (const c of constraints) {
    if (c.rule_type === 'max_width_mm' && opening.width_m * 1000 > c.value) violations.push(c.message)
    if (c.rule_type === 'max_height_mm' && opening.height_m * 1000 > c.value) violations.push(c.message)
    if (c.rule_type === 'max_span_mm' && opening.width_m * 1000 > c.value) violations.push(c.message)
    if (c.rule_type === 'max_panel_count' && opening.panel_count > c.value) violations.push(c.message)
  }
  return violations
}

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
  const [saving, setSaving] = useState(false)

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  const addExtraLine = () => setForm(f => ({ ...f, extra_lines: [...f.extra_lines, { description: '', amount: 0 }] }))
  const setExtraLine = (i, k, v) => setForm(f => ({ ...f, extra_lines: f.extra_lines.map((l, idx) => idx === i ? { ...l, [k]: v } : l) }))
  const removeExtraLine = (i) => setForm(f => ({ ...f, extra_lines: f.extra_lines.filter((_, idx) => idx !== i) }))

  const template = (templates || []).find(t => t.id === form.template_id)
  const templateComponents = (components || []).filter(c => c.template_id === form.template_id)
  const templateHardware = (hardware || []).filter(h => h.template_id === form.template_id)
  const templateConstraints = (constraints || []).filter(c => c.template_id === form.template_id)
  const finish = (finishes || []).find(f => f.id === form.finish_id)
  const glassType = (glassTypes || []).find(g => g.id === form.glass_type_id)

  const numericOpening = useMemo(() => ({
    width_m: parseFloat(form.width_m) || 0,
    height_m: parseFloat(form.height_m) || 0,
    panel_count: parseInt(form.panel_count, 10) || 1,
    series: form.series,
    thickness_mm: parseFloat(form.thickness_mm) || 0,
    quantity: parseInt(form.quantity, 10) || 1,
    extra_lines: form.extra_lines.map(l => ({ description: l.description, amount: parseFloat(l.amount) || 0 })),
  }), [form])

  const bom = useMemo(() => {
    if (!template || !finish || !numericOpening.width_m || !numericOpening.height_m || !numericOpening.series || !numericOpening.thickness_mm) return null
    return computeBomForOpening(numericOpening, template, templateComponents, templateHardware, profiles || [], finish, glassType || null)
  }, [template, finish, glassType, numericOpening, templateComponents, templateHardware, profiles])

  const violations = template ? evaluateConstraints(numericOpening, templateConstraints) : []

  const handleSave = async () => {
    setSaving(true)
    try {
      const payload = {
        project_id: projectId, opening_no: form.opening_no, template_id: form.template_id,
        series: form.series, thickness_mm: parseFloat(form.thickness_mm) || 0,
        finish_id: form.finish_id, glass_type_id: form.glass_type_id || null,
        width_m: parseFloat(form.width_m) || 0, height_m: parseFloat(form.height_m) || 0,
        panel_count: parseInt(form.panel_count, 10) || 1, quantity: parseInt(form.quantity, 10) || 1,
        extra_lines: numericOpening.extra_lines,
      }
      const { error } = isNew
        ? await supabase.from('estimation_openings').insert(payload)
        : await supabase.from('estimation_openings').update(payload).eq('id', opening.id)
      if (error) throw error
      onSaved()
    } catch (e) { alert('บันทึกไม่สำเร็จ: ' + e.message) }
    finally { setSaving(false) }
  }

  return (
    <div className="card" style={{ padding: 16, display: 'grid', gap: 12 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '100px 1fr', gap: 10 }}>
        <div>
          <label className="label">เลขช่อง ★</label>
          <input className="input" required disabled={!canEdit} value={form.opening_no} onChange={e => set('opening_no', e.target.value)} placeholder="เช่น D1" />
        </div>
        <div>
          <label className="label">Template ★</label>
          <SearchableSelect required value={form.template_id} onChange={v => set('template_id', v)}
            options={(templates || []).filter(t => t.active).map(t => ({ value: t.id, label: t.name, keywords: t.name }))} />
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
        <div>
          <label className="label">รุ่น/ซีรีส์ ★</label>
          <input className="input" required disabled={!canEdit} value={form.series} onChange={e => set('series', e.target.value)} placeholder="เช่น ทั่วไป" />
        </div>
        <div>
          <label className="label">ความหนา (mm) ★</label>
          <input className="input" required disabled={!canEdit} type="number" min="0" step="0.1" value={form.thickness_mm} onChange={e => set('thickness_mm', e.target.value)} />
        </div>
        <div>
          <label className="label">สีผิว ★</label>
          <SearchableSelect required value={form.finish_id} onChange={v => set('finish_id', v)}
            options={(finishes || []).filter(f => f.active).map(f => ({ value: f.id, label: f.name, keywords: f.name }))} />
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr 1fr', gap: 10 }}>
        <div>
          <label className="label">กว้าง (m) ★</label>
          <input className="input" required disabled={!canEdit} type="number" min="0" step="0.01" value={form.width_m} onChange={e => set('width_m', e.target.value)} />
        </div>
        <div>
          <label className="label">สูง (m) ★</label>
          <input className="input" required disabled={!canEdit} type="number" min="0" step="0.01" value={form.height_m} onChange={e => set('height_m', e.target.value)} />
        </div>
        <div>
          <label className="label">จำนวนช่อง (panel)</label>
          <input className="input" disabled={!canEdit} type="number" min="1" value={form.panel_count} onChange={e => set('panel_count', e.target.value)} />
        </div>
        <div>
          <label className="label">จำนวน (set)</label>
          <input className="input" disabled={!canEdit} type="number" min="1" value={form.quantity} onChange={e => set('quantity', e.target.value)} />
        </div>
        <div>
          <label className="label">ชนิดกระจก</label>
          <SearchableSelect value={form.glass_type_id} onChange={v => set('glass_type_id', v)}
            options={(glassTypes || []).filter(g => g.active).map(g => ({ value: g.id, label: g.name, keywords: g.name }))} placeholder="ไม่มีกระจก" />
        </div>
      </div>

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
        <div key={i} className="alert alert-error" style={{ fontSize: 13 }}>⚠️ {msg}</div>
      ))}

      {bom && (
        <div className="card" style={{ padding: 12, background: 'var(--bg2, #f7f7f7)' }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>สรุป BOM (ต่อ 1 ชุด)</div>
          {[...bom.profileLines, ...bom.gridLines].map((l, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: l.resolved ? 'inherit' : 'var(--red)' }}>
              <span>{l.role_name} {!l.resolved && '(ไม่พบหน้าตัดที่ตรงกัน)'}</span>
              <span className="font-mono">{fmt(l.cost)}</span>
            </div>
          ))}
          {bom.hardwareLines.map((l, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
              <span>{l.name} x{l.quantity}</span>
              <span className="font-mono">{fmt(l.cost)}</span>
            </div>
          ))}
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
            <span>เผื่อเสียเศษ</span><span className="font-mono">{fmt(bom.wasteCost)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
            <span>กระจก ({bom.glassArea_sqm.toFixed(2)} ตร.ม.)</span><span className="font-mono">{fmt(bom.glassCost)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
            <span>รายการเพิ่มเติม</span><span className="font-mono">{fmt(bom.extraLinesCost)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, borderTop: '1px solid var(--border, #ddd)', marginTop: 6, paddingTop: 6 }}>
            <span>รวมต่อชุด</span><span className="font-mono">{fmt(bom.totalCost)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700 }}>
            <span>รวม x{numericOpening.quantity} ชุด</span><span className="font-mono">{fmt(bom.totalCost * numericOpening.quantity)}</span>
          </div>
        </div>
      )}

      {canEdit && (
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-primary" disabled={saving || !form.opening_no || !form.template_id} onClick={handleSave}>
            {saving ? '⏳ กำลังบันทึก...' : '💾 บันทึกช่องเปิด'}
          </button>
        </div>
      )}
    </div>
  )
}

export default function Estimation(props) {
  const { isAtLeast, role } = useUserRole()
  const canEdit = isAtLeast('ADMIN') && canEditPage(role, 'estimation')

  const { data: projects, refetch: refetchProjects } = useEstimationProjects()
  const { data: openings, refetch: refetchOpenings } = useEstimationOpenings()
  const { data: templates } = useBomTemplates()
  const { data: components } = useBomTemplateComponents()
  const { data: hardware } = useBomTemplateHardware()
  const { data: constraints } = useBomTemplateConstraints()
  const { data: finishes } = useAluminumFinishes()
  const { data: glassTypes } = useBomGlassTypes()
  const { data: profiles } = useAluminumProfiles()

  const [selectedProjectId, setSelectedProjectId] = useState(null)
  const [showProjectForm, setShowProjectForm] = useState(false)
  const [newProjectName, setNewProjectName] = useState('')
  const [creatingOpening, setCreatingOpening] = useState(false)
  const [editingOpeningId, setEditingOpeningId] = useState(null)

  const projectOpenings = (openings || []).filter(o => o.project_id === selectedProjectId)

  const handleCreateProject = async () => {
    if (!newProjectName) return
    const { error } = await supabase.from('estimation_projects').insert({ name: newProjectName })
    if (error) { alert('สร้างไม่สำเร็จ: ' + error.message); return }
    setNewProjectName(''); setShowProjectForm(false); refetchProjects()
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: 16 }}>
      <div className="card" style={{ padding: 12 }}>
        {canEdit && <button className="btn btn-primary btn-sm" style={{ marginBottom: 10, width: '100%' }} onClick={() => setShowProjectForm(true)}>+ โปรเจกต์ใหม่</button>}
        <div style={{ display: 'grid', gap: 4 }}>
          {(projects || []).map(p => (
            <button key={p.id} className={`btn btn-sm ${selectedProjectId === p.id ? 'btn-primary' : 'btn-ghost'}`} style={{ justifyContent: 'flex-start' }}
              onClick={() => { setSelectedProjectId(p.id); setCreatingOpening(false); setEditingOpeningId(null) }}>
              {p.name}
            </button>
          ))}
          {!(projects || []).length && <div style={{ fontSize: 12, color: 'var(--text3)', padding: 8 }}>ยังไม่มีโปรเจกต์</div>}
        </div>
      </div>

      <div>
        {!selectedProjectId && <div style={{ color: 'var(--text3)', padding: 20 }}>เลือกโปรเจกต์ทางซ้าย หรือสร้างใหม่</div>}
        {selectedProjectId && (
          <div style={{ display: 'grid', gap: 12 }}>
            <div style={{ display: 'flex', gap: 8 }}>
              {canEdit && <button className="btn btn-primary btn-sm" onClick={() => { setCreatingOpening(true); setEditingOpeningId(null) }}>+ เพิ่มช่องเปิด</button>}
            </div>
            <div className="card">
              <div className="table-wrap">
                <table>
                  <thead><tr><th>เลขช่อง</th><th>Template</th><th>ขนาด</th><th>จำนวน</th><th></th></tr></thead>
                  <tbody>
                    {projectOpenings.map(o => (
                      <tr key={o.id} style={{ cursor: 'pointer' }} onClick={() => { setEditingOpeningId(o.id); setCreatingOpening(false) }}>
                        <td style={{ fontWeight: 600 }}>{o.opening_no}</td>
                        <td>{o.bom_templates?.name}</td>
                        <td className="font-mono">{o.width_m} x {o.height_m} m</td>
                        <td className="font-mono">{o.quantity}</td>
                        <td><button className="btn btn-sm btn-ghost">แก้ไข</button></td>
                      </tr>
                    ))}
                    {!projectOpenings.length && <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--text3)', padding: 24 }}>ยังไม่มีช่องเปิด</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>

            {creatingOpening && (
              <OpeningEditor opening={null} projectId={selectedProjectId} templates={templates} components={components} hardware={hardware}
                constraints={constraints} profiles={profiles} finishes={finishes} glassTypes={glassTypes} canEdit={canEdit}
                onSaved={() => { setCreatingOpening(false); refetchOpenings() }} />
            )}
            {editingOpeningId && (
              <OpeningEditor opening={projectOpenings.find(o => o.id === editingOpeningId)} projectId={selectedProjectId} templates={templates} components={components}
                hardware={hardware} constraints={constraints} profiles={profiles} finishes={finishes} glassTypes={glassTypes} canEdit={canEdit}
                onSaved={() => { setEditingOpeningId(null); refetchOpenings() }} />
            )}
          </div>
        )}
      </div>

      {showProjectForm && (
        <Modal title="โปรเจกต์ใหม่" onClose={() => setShowProjectForm(false)} maxWidth={420}>
          <div className="modal-body">
            <label className="label">ชื่อโปรเจกต์ ★</label>
            <input className="input" value={newProjectName} onChange={e => setNewProjectName(e.target.value)} placeholder="เช่น บ้านพี่วัฒน์" />
          </div>
          <div className="modal-footer">
            <button className="btn btn-ghost" onClick={() => setShowProjectForm(false)}>ยกเลิก</button>
            <button className="btn btn-primary" disabled={!newProjectName} onClick={handleCreateProject}>✅ สร้าง</button>
          </div>
        </Modal>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Manual verification**

Run: `npm run build`, confirm no compile errors referencing `Estimation.jsx`.
Expected: build succeeds. Full functional QA happens in Task 11's verification step.

- [ ] **Step 3: Commit**

```bash
git add src/pages/Estimation.jsx
git commit -m "feat: add Estimation page with live BOM computation per opening"
```

---

### Task 11: Nav wiring

**Files:**
- Modify: `src/App.jsx`

**Interfaces:**
- Consumes: `BomTemplates.jsx` (Task 9), `Estimation.jsx` (Task 10).

- [ ] **Step 1: Add lazy imports**

Near the other `lazy(() => import(...))` lines in `src/App.jsx` (after `const Cheques = ...`):

```javascript
const BomTemplates = lazy(() => import('./pages/BomTemplates.jsx'))
const Estimation   = lazy(() => import('./pages/Estimation.jsx'))
```

- [ ] **Step 2: Add tabs**

Add a new top-level group to the `TABS` array, after the `'💰 รายรับ'` group and before `labor_contractors`:

```javascript
  { label: '🧮 ประเมินราคา', children: [
    { id: 'estimation',    label: '📐 ประเมินราคา (BOM)', minRole: 'ADMIN', module: 'estimation' },
    { id: 'bom_templates', label: '🧩 BOM Templates',     minRole: 'ADMIN', module: 'estimation' },
  ] },
```

- [ ] **Step 3: Add switch cases**

In the `switch (activeTab)` block, add before `default:`:

```javascript
        case 'estimation':    return <Estimation    {...props} />
        case 'bom_templates': return <BomTemplates   {...props} />
```

- [ ] **Step 4: Manual end-to-end verification**

Run: `npm run dev`, log in as owner/admin on a tenant with the `estimation` module (Task 1's backfill grants it to every paid-tier tenant).
1. Go to 🧮 ประเมินราคา → 🧩 BOM Templates. Reconstruct the spec's illustrative "Swing Door · 2 Leaf" example: create a template with 2 components (Top rail `= width`, Side jamb `= height` x2), one hardware row (Hinge, per_cell, x3), grid_vertical_mullion_family set, one row weight.
2. Go to คลังสินค้า → 📐 หน้าตัดอลูมิเนียม, create one profile with matching `family`/`series`/`thickness_mm` and a `linear_weight_kg_per_m`.
3. Go to 🧩 BOM Templates → 🎨 สีผิวอลูมิเนียม, create one finish. Go to 🪟 ชนิดกระจก, create one glass type.
4. Go to 📐 ประเมินราคา (BOM), create a project, add an opening using the template/series/thickness/finish/glass from steps 1-3, width 2, height 2, panel count 2, quantity 1.

Expected: the live BOM breakdown appears with resolved profile lines (no red "ไม่พบหน้าตัดที่ตรงกัน" text), a non-zero total cost, and saving the opening succeeds and shows up in the openings table.

- [ ] **Step 5: Commit**

```bash
git add src/App.jsx
git commit -m "feat: wire Estimation and BOM Templates into nav"
```

---

## Self-Review Notes

**Spec coverage:** every Data model table (Task 1-4), the full Business logic algorithm (Task 5), all three UI surfaces from the spec's UI changes section (Tasks 7, 8, 9, 10), and nav wiring (Task 11, implied by the spec's "gated the same way every other module's nav entry is gated") are covered. Error handling's three cases (unresolved component/grid line, `ON DELETE RESTRICT` on `template_id`, series/thickness mismatch) are exercised by Task 5's tests and Task 10's UI (the red "ไม่พบหน้าตัดที่ตรงกัน" line, the delete-blocked-by-FK behavior which needs no extra code — Postgres enforces it).

**Placeholder scan:** no TBD/TODO markers introduced; the one intentional interim state (Task 8's `<div>Task 9 fills this in.</div>`) is explicitly replaced by Task 9 Step 2, not left in the final tree.

**Type consistency:** `computeBomForOpening`'s signature and return shape (Task 5) match exactly what Task 9's preview-free editor and Task 10's `OpeningEditor` consume — `resolved`, `role_name`, `cost`, `unresolvedComponents` are used identically in both the tests and the UI. Hook names from Task 6 (`useBomTemplates`, `useBomTemplateComponents`, etc.) are the exact names imported in Tasks 8-10.
