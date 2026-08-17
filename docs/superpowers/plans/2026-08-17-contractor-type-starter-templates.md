# Contractor-Type Starter Templates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** New companies signing up pick a contractor type; the signup trigger seeds their expense categories and one default material supplier per category (never on labor categories) instead of leaving them with a blank workspace.

**Architecture:** Three new reference tables (`contractor_types`, `contractor_type_categories`, `contractor_type_category_suppliers`) hold shared, non-tenant-scoped template content. `handle_new_user()`'s new-tenant branch reads the selected type's rows and copies them into the new tenant's own `expense_categories`/`suppliers` — a one-time seed, not an ongoing link.

**Tech Stack:** Supabase (Postgres + PostgREST), React 18, Vite. No automated JS test framework in this repo — SQL correctness is verified with disposable-fixture `DO $$` blocks (see `supabase/tests/tenant_scoping_test.sql` for the established pattern); frontend correctness is verified manually against the running dev server, consistent with every other plan in this repo.

## Global Constraints

- Design source of truth: `docs/superpowers/specs/2026-08-17-contractor-type-starter-templates-design.md`.
- Type selection: one required dropdown at signup, not multi-select, not skippable.
- Changing type later (Settings): updates the label only, never re-seeds categories or suppliers.
- A default supplier attaches to an individual category, never to the type as a whole.
- Labor categories (e.g. ค่าแรงช่างทาสี) get no default supplier — `suppliers` is for material vendors only.
- `contractor_types`/`contractor_type_categories`/`contractor_type_category_suppliers` are shared reference data: readable by any `authenticated` user, no tenant scoping, no write policy for `authenticated` (content is maintained directly via SQL, matching how `app_settings`' global defaults are maintained today).
- This project applies migrations directly to the live Supabase project (`yyzbgdmgyvvypfcjuhtr`) via `mcp__plugin_supabase_supabase__apply_migration` — there is no local Supabase stack. Migrations touch production tables with real tenant data.
- Out of scope (do not build): supplier "partner" placement/commercial relationships, real-time or location-based supplier search, an admin UI for managing template content, multiple suppliers per category (the schema supports it; nothing else does yet).

---

## File Structure

**New SQL migrations** (`supabase/migrations/`):
- `2026-08-17-01-contractor-type-templates.sql` — the 3 new tables + `tenants.contractor_type_id` + RLS (Task 1)
- `2026-08-17-02-seed-contractor-type-content.sql` — the 10 types' content (Task 2)
- `2026-08-17-03-signup-trigger-contractor-seed.sql` — extends `handle_new_user()` (Task 3)

**New test file:**
- `supabase/tests/contractor_type_templates_test.sql` — disposable-fixture regression tests, appended to across Tasks 1–3, matching `supabase/tests/tenant_scoping_test.sql`'s style.

**Modified frontend files:**
- `src/hooks/useSupabase.js` — add `useContractorTypes()` (Task 4)
- `src/pages/Login.jsx` — add the contractor-type dropdown to the signup form (Task 4)
- `src/hooks/useTenant.js` — add a `refetch` export (Task 5)
- `src/pages/Settings.jsx` — add the "change contractor type" card (Task 5)

**Schema doc:**
- `supabase/schema.sql` — kept in sync after each SQL task, matching every prior migration in this repo.

---

### Task 1: `contractor_types` + `contractor_type_categories` + `contractor_type_category_suppliers` tables + `tenants.contractor_type_id`

**Files:**
- Create: `supabase/migrations/2026-08-17-01-contractor-type-templates.sql`
- Create: `supabase/tests/contractor_type_templates_test.sql`
- Modify: `supabase/schema.sql`

**Interfaces:**
- Produces: `contractor_types(id, key, label_th, sort_order)`, `contractor_type_categories(id, contractor_type_id, name, color, sort_order)`, `contractor_type_category_suppliers(id, category_template_id, supplier_name, sort_order)`, `tenants.contractor_type_id UUID REFERENCES contractor_types(id)` — consumed by Tasks 2, 3, 4, 5.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/2026-08-17-01-contractor-type-templates.sql
--
-- Shared reference data for contractor-type starter templates (see
-- docs/superpowers/specs/2026-08-17-contractor-type-starter-templates-design.md).
-- Not tenant-scoped — every tenant reads the same rows once, at signup.

CREATE TABLE contractor_types (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key         TEXT NOT NULL UNIQUE,
  label_th    TEXT NOT NULL,
  sort_order  INT NOT NULL DEFAULT 0
);

CREATE TABLE contractor_type_categories (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_type_id  UUID NOT NULL REFERENCES contractor_types(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  color               TEXT NOT NULL DEFAULT '#6c63ff',
  sort_order          INT NOT NULL DEFAULT 0
);

-- Kept as its own table (rather than a supplier_name column on
-- contractor_type_categories) so a category can carry more than one
-- candidate supplier later without a schema change — v1 only ever
-- inserts one row per material category, and zero rows for a labor
-- category (that absence is what marks it as labor — no separate flag).
CREATE TABLE contractor_type_category_suppliers (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category_template_id  UUID NOT NULL REFERENCES contractor_type_categories(id) ON DELETE CASCADE,
  supplier_name          TEXT NOT NULL,
  sort_order             INT NOT NULL DEFAULT 0
);

ALTER TABLE tenants ADD COLUMN contractor_type_id UUID REFERENCES contractor_types(id);

-- Shared reference data: any authenticated user can read it (needed by
-- the signup form's dropdown, before the caller even has a tenant_id
-- yet — so this must NOT be tenant_can_write()/current_tenant_id()
-- gated). No write policy for authenticated — content is maintained
-- directly via SQL.
ALTER TABLE contractor_types ENABLE ROW LEVEL SECURITY;
CREATE POLICY anyone_reads_contractor_types ON contractor_types FOR SELECT TO authenticated USING (true);

ALTER TABLE contractor_type_categories ENABLE ROW LEVEL SECURITY;
CREATE POLICY anyone_reads_contractor_type_categories ON contractor_type_categories FOR SELECT TO authenticated USING (true);

ALTER TABLE contractor_type_category_suppliers ENABLE ROW LEVEL SECURITY;
CREATE POLICY anyone_reads_contractor_type_category_suppliers ON contractor_type_category_suppliers FOR SELECT TO authenticated USING (true);
```

- [ ] **Step 2: Apply the migration**

Use `mcp__plugin_supabase_supabase__apply_migration` with `project_id: yyzbgdmgyvvypfcjuhtr`, `name: contractor_type_templates`, and the SQL from Step 1 as `query`.

- [ ] **Step 3: Verify the tables and column exist**

Run via `mcp__plugin_supabase_supabase__execute_sql`:

```sql
SELECT count(*) FROM contractor_types;
SELECT count(*) FROM contractor_type_categories;
SELECT count(*) FROM contractor_type_category_suppliers;
SELECT contractor_type_id FROM tenants LIMIT 1;
```

Expected: first three return `0`, the fourth returns one row with `contractor_type_id = NULL` (existing tenants, including FacadeX's own, have no type set yet — that's correct, nothing back-assigns one).

- [ ] **Step 4: Write and run the fixture test**

Create `supabase/tests/contractor_type_templates_test.sql`:

```sql
-- ================================================================
-- Regression tests for contractor-type starter templates.
-- Disposable-fixture style, matching supabase/tests/tenant_scoping_test.sql
-- — safe to run against production, self-cleans on every path.
-- ================================================================

-- ── Test 1: an authenticated user with no tenant yet (mid-signup) can
-- still read contractor_types — the RLS policy must not require
-- current_tenant_id() to resolve. ──
DO $$
DECLARE
  visible_count INT;
  test_type_id UUID;
BEGIN
  INSERT INTO contractor_types (key, label_th, sort_order)
  VALUES ('__test_type__', '__TEST TYPE__', 999)
  RETURNING id INTO test_type_id;

  SET LOCAL role = 'authenticated';
  SET LOCAL request.jwt.claims = '{"email":"__no_tenant_yet__@example.com"}';

  SELECT count(*) INTO visible_count FROM contractor_types WHERE id = test_type_id;
  IF visible_count != 1 THEN
    RAISE EXCEPTION 'contractor_types RLS REGRESSION: expected 1 visible row for a user with no tenant, got %', visible_count;
  END IF;

  RESET role;
  DELETE FROM contractor_types WHERE id = test_type_id;

  RAISE NOTICE 'Test 1 (contractor_types readable pre-tenant): TEST PASSED';
END $$;

-- ── Test 2: a category with zero contractor_type_category_suppliers
-- rows (a labor category) is distinguishable from one with a row
-- (a material category) purely by the join — no flag needed. ──
DO $$
DECLARE
  test_type_id UUID;
  material_cat_id UUID;
  labor_cat_id UUID;
  supplier_count_material INT;
  supplier_count_labor INT;
BEGIN
  INSERT INTO contractor_types (key, label_th, sort_order)
  VALUES ('__test_type_2__', '__TEST TYPE 2__', 999)
  RETURNING id INTO test_type_id;

  INSERT INTO contractor_type_categories (contractor_type_id, name, color, sort_order)
  VALUES (test_type_id, '__TEST material cat__', '#FFFFFF', 1)
  RETURNING id INTO material_cat_id;

  INSERT INTO contractor_type_categories (contractor_type_id, name, color, sort_order)
  VALUES (test_type_id, '__TEST labor cat__', '#FFFFFF', 2)
  RETURNING id INTO labor_cat_id;

  INSERT INTO contractor_type_category_suppliers (category_template_id, supplier_name, sort_order)
  VALUES (material_cat_id, '__TEST SUPPLIER__', 1);
  -- deliberately no supplier row for labor_cat_id

  SELECT count(*) INTO supplier_count_material FROM contractor_type_category_suppliers WHERE category_template_id = material_cat_id;
  SELECT count(*) INTO supplier_count_labor FROM contractor_type_category_suppliers WHERE category_template_id = labor_cat_id;

  IF supplier_count_material != 1 THEN
    RAISE EXCEPTION 'REGRESSION: material category should have 1 supplier, got %', supplier_count_material;
  END IF;
  IF supplier_count_labor != 0 THEN
    RAISE EXCEPTION 'REGRESSION: labor category should have 0 suppliers, got %', supplier_count_labor;
  END IF;

  DELETE FROM contractor_type_category_suppliers WHERE category_template_id = material_cat_id;
  DELETE FROM contractor_type_categories WHERE id IN (material_cat_id, labor_cat_id);
  DELETE FROM contractor_types WHERE id = test_type_id;

  RAISE NOTICE 'Test 2 (labor category has no supplier row): TEST PASSED';
END $$;
```

Run the whole file via `execute_sql`. Expected: two `TEST PASSED` notices, no `ERROR`.

- [ ] **Step 5: Update schema.sql**

Add the three `CREATE TABLE` statements, the `tenants.contractor_type_id` column (in the existing `tenants` table definition), and the three RLS policy blocks to `supabase/schema.sql`, placed near the existing `expense_categories`/`suppliers` table definitions (they're the tables this feature seeds into).

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/2026-08-17-01-contractor-type-templates.sql supabase/tests/contractor_type_templates_test.sql supabase/schema.sql
git commit -m "feat: add contractor-type starter template tables"
```

---

### Task 2: Seed the 10 contractor types' content

**Files:**
- Create: `supabase/migrations/2026-08-17-02-seed-contractor-type-content.sql`
- Modify: `supabase/tests/contractor_type_templates_test.sql` (append Test 3)
- Modify: `supabase/schema.sql`

**Interfaces:**
- Consumes: `contractor_types`, `contractor_type_categories`, `contractor_type_category_suppliers` (Task 1).
- Produces: 10 rows in `contractor_types`, 30 rows in `contractor_type_categories`, 21 rows in `contractor_type_category_suppliers` — consumed by Task 3 (the signup trigger reads these).

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/2026-08-17-02-seed-contractor-type-content.sql
--
-- Content drafted from general knowledge of well-known Thai
-- construction-material brands (not verified business relationships),
-- confirmed with the user as a v1 starting point — editable any time by
-- updating these tables directly, no code change or redeploy needed.
-- See docs/superpowers/specs/2026-08-17-contractor-type-starter-templates-design.md
-- for the full type→category→supplier table this transcribes.

INSERT INTO contractor_types (key, label_th, sort_order) VALUES
  ('painting',           'ทาสี',                    1),
  ('glass_aluminum',     'กระจก/อลูมิเนียม',        2),
  ('electrical',         'ไฟฟ้า',                   3),
  ('plumbing',           'ประปา/สุขาภิบาล',         4),
  ('structural_concrete','โครงสร้าง/คอนกรีต',       5),
  ('roofing',            'หลังคา',                  6),
  ('tiling_flooring',    'กระเบื้อง/พื้นผิว',       7),
  ('drywall_ceiling',    'ผนังเบา/ฝ้าเพดาน',        8),
  ('hvac',               'ปรับอากาศ',               9),
  ('steelwork',          'งานเหล็ก/โครงเหล็ก',      10);

INSERT INTO contractor_type_categories (contractor_type_id, name, color, sort_order)
SELECT ct.id, v.name, v.color, v.sort_order
FROM (VALUES
  ('painting',            'ค่าสี',                     '#FF6B6B', 1),
  ('painting',            'ค่าอุปกรณ์ทาสี',            '#FFD166', 2),
  ('painting',            'ค่าแรงช่างทาสี',            '#9E9EC8', 3),

  ('glass_aluminum',      'ค่ากระจก',                  '#4ECDC4', 1),
  ('glass_aluminum',      'ค่าอลูมิเนียม/เหล็ก',        '#6C63FF', 2),
  ('glass_aluminum',      'ค่าซิลิโคน/ยาง',            '#A29BFE', 3),

  ('electrical',          'ค่าสายไฟ/อุปกรณ์ไฟฟ้า',     '#FFD166', 1),
  ('electrical',          'ค่าเบรกเกอร์/ตู้ไฟ',        '#74B9FF', 2),
  ('electrical',          'ค่าแรงช่างไฟฟ้า',           '#9E9EC8', 3),

  ('plumbing',            'ค่าท่อ/ข้อต่อ',             '#4ECDC4', 1),
  ('plumbing',            'ค่าสุขภัณฑ์',                '#74B9FF', 2),
  ('plumbing',            'ค่าแรงช่างประปา',           '#9E9EC8', 3),

  ('structural_concrete', 'ค่าปูน/คอนกรีตผสมเสร็จ',    '#6C63FF', 1),
  ('structural_concrete', 'ค่าเหล็กเส้น',              '#FD79A8', 2),
  ('structural_concrete', 'ค่าแรงช่างโครงสร้าง',       '#9E9EC8', 3),

  ('roofing',             'ค่ากระเบื้อง/แผ่นหลังคา',   '#FF6B6B', 1),
  ('roofing',             'ค่าโครงหลังคา',             '#FD79A8', 2),
  ('roofing',             'ค่าแรงช่างหลังคา',          '#9E9EC8', 3),

  ('tiling_flooring',     'ค่ากระเบื้อง',              '#4ECDC4', 1),
  ('tiling_flooring',     'ค่าปูนกาว/ยาแนว',           '#FFD166', 2),
  ('tiling_flooring',     'ค่าแรงช่างปู',              '#9E9EC8', 3),

  ('drywall_ceiling',     'ค่าแผ่นยิปซั่ม/สมาร์ทบอร์ด', '#74B9FF', 1),
  ('drywall_ceiling',     'ค่าโครงคร่าว',              '#A29BFE', 2),
  ('drywall_ceiling',     'ค่าแรงช่างฝ้า/ผนัง',        '#9E9EC8', 3),

  ('hvac',                'ค่าเครื่องปรับอากาศ',       '#4ECDC4', 1),
  ('hvac',                'ค่าท่อ/ฉนวนแอร์',           '#74B9FF', 2),
  ('hvac',                'ค่าแรงช่างแอร์',            '#9E9EC8', 3),

  ('steelwork',           'ค่าเหล็กรูปพรรณ',           '#FD79A8', 1),
  ('steelwork',           'ค่าสี/สารกันสนิม',          '#FF6B6B', 2),
  ('steelwork',           'ค่าแรงช่างเหล็ก/เชื่อม',     '#9E9EC8', 3)
) AS v(type_key, name, color, sort_order)
JOIN contractor_types ct ON ct.key = v.type_key;

INSERT INTO contractor_type_category_suppliers (category_template_id, supplier_name, sort_order)
SELECT c.id, v.supplier_name, 1
FROM (VALUES
  ('painting',            'ค่าสี',                     'TOA'),
  ('painting',            'ค่าอุปกรณ์ทาสี',            'ไทวัสดุ'),

  ('glass_aluminum',      'ค่ากระจก',                  'กระจกไทยอาซาฮี'),
  ('glass_aluminum',      'ค่าอลูมิเนียม/เหล็ก',        'TOSTEM'),
  ('glass_aluminum',      'ค่าซิลิโคน/ยาง',            'Dow Corning'),

  ('electrical',          'ค่าสายไฟ/อุปกรณ์ไฟฟ้า',     'บางกอกเคเบิ้ล'),
  ('electrical',          'ค่าเบรกเกอร์/ตู้ไฟ',        'Schneider Electric'),

  ('plumbing',            'ค่าท่อ/ข้อต่อ',             'SCG'),
  ('plumbing',            'ค่าสุขภัณฑ์',                'American Standard'),

  ('structural_concrete', 'ค่าปูน/คอนกรีตผสมเสร็จ',    'ปูนอินทรี (INSEE)'),
  ('structural_concrete', 'ค่าเหล็กเส้น',              'TATA Steel'),

  ('roofing',             'ค่ากระเบื้อง/แผ่นหลังคา',   'ตราเพชร'),
  ('roofing',             'ค่าโครงหลังคา',             'เหล็กสยามยามาโตะ'),

  ('tiling_flooring',     'ค่ากระเบื้อง',              'คอตโต้ (COTTO)'),
  ('tiling_flooring',     'ค่าปูนกาว/ยาแนว',           'ตราจระเข้'),

  ('drywall_ceiling',     'ค่าแผ่นยิปซั่ม/สมาร์ทบอร์ด', 'ยิปซัม (Gyproc)'),
  ('drywall_ceiling',     'ค่าโครงคร่าว',              'ไทวัสดุ'),

  ('hvac',                'ค่าเครื่องปรับอากาศ',       'ไดกิ้น (Daikin)'),
  ('hvac',                'ค่าท่อ/ฉนวนแอร์',           'Aeroflex'),

  ('steelwork',           'ค่าเหล็กรูปพรรณ',           'เหล็กสยามยามาโตะ'),
  ('steelwork',           'ค่าสี/สารกันสนิม',          'TOA')
) AS v(type_key, category_name, supplier_name)
JOIN contractor_types ct ON ct.key = v.type_key
JOIN contractor_type_categories c ON c.contractor_type_id = ct.id AND c.name = v.category_name;
```

- [ ] **Step 2: Apply the migration**

Use `mcp__plugin_supabase_supabase__apply_migration` with `name: seed_contractor_type_content` and the SQL from Step 1.

- [ ] **Step 3: Verify row counts and a spot-check**

Run via `execute_sql`:

```sql
SELECT
  (SELECT count(*) FROM contractor_types) AS types,
  (SELECT count(*) FROM contractor_type_categories) AS categories,
  (SELECT count(*) FROM contractor_type_category_suppliers) AS suppliers;
```

Expected: `types=10`, `categories=30`, `suppliers=21`.

```sql
SELECT ct.label_th, cc.name, ccs.supplier_name
FROM contractor_types ct
JOIN contractor_type_categories cc ON cc.contractor_type_id = ct.id
LEFT JOIN contractor_type_category_suppliers ccs ON ccs.category_template_id = cc.id
WHERE ct.key = 'painting'
ORDER BY cc.sort_order;
```

Expected: 3 rows — `ทาสี | ค่าสี | TOA`, `ทาสี | ค่าอุปกรณ์ทาสี | ไทวัสดุ`, `ทาสี | ค่าแรงช่างทาสี | NULL` (the labor category has no supplier).

- [ ] **Step 4: Append and run the fixture test — content integrity**

Append to `supabase/tests/contractor_type_templates_test.sql`:

```sql
-- ── Test 3: every seeded contractor type has at least one category,
-- and every category with a name NOT containing 'แรง' (the labor-cost
-- naming convention used throughout this seed and the rest of the app)
-- has exactly one supplier — catches a mistyped type_key or
-- category_name in the VALUES lists silently producing an orphaned
-- row that the JOIN in Task 2's migration would have dropped. ──
DO $$
DECLARE
  types_without_categories INT;
  material_categories_without_supplier INT;
BEGIN
  SELECT count(*) INTO types_without_categories
  FROM contractor_types ct
  WHERE NOT EXISTS (SELECT 1 FROM contractor_type_categories cc WHERE cc.contractor_type_id = ct.id)
    AND ct.key NOT LIKE '\_\_test%';

  IF types_without_categories != 0 THEN
    RAISE EXCEPTION 'CONTENT REGRESSION: % contractor type(s) have zero categories (a type_key typo in the seed VALUES list silently drops the JOIN)', types_without_categories;
  END IF;

  SELECT count(*) INTO material_categories_without_supplier
  FROM contractor_type_categories cc
  WHERE cc.name NOT LIKE '%แรง%'
    AND NOT EXISTS (SELECT 1 FROM contractor_type_category_suppliers s WHERE s.category_template_id = cc.id)
    AND cc.name NOT LIKE '\_\_TEST%';

  IF material_categories_without_supplier != 0 THEN
    RAISE EXCEPTION 'CONTENT REGRESSION: % non-labor categor(y/ies) have zero suppliers (a category_name typo in the seed VALUES list silently drops the JOIN)', material_categories_without_supplier;
  END IF;

  RAISE NOTICE 'Test 3 (seed content integrity): TEST PASSED';
END $$;
```

Run the whole file via `execute_sql`. Expected: three `TEST PASSED` notices, no `ERROR`.

- [ ] **Step 5: Update schema.sql**

Add a comment near the `contractor_types` table definition in `supabase/schema.sql` noting the seed data lives in this migration (schema.sql documents structure, not bulk seed data — matching how the `expense_categories` starter-category `INSERT` is handled there today: the structure is documented inline, this seed's row-level content is referenced by migration filename, not fully duplicated).

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/2026-08-17-02-seed-contractor-type-content.sql supabase/tests/contractor_type_templates_test.sql supabase/schema.sql
git commit -m "feat: seed content for the 10 contractor-type starter templates"
```

---

### Task 3: Signup trigger seeds categories + suppliers for new tenants

**Files:**
- Create: `supabase/migrations/2026-08-17-03-signup-trigger-contractor-seed.sql`
- Modify: `supabase/tests/contractor_type_templates_test.sql` (append Test 4)
- Modify: `supabase/schema.sql`

**Interfaces:**
- Consumes: `contractor_type_categories`, `contractor_type_category_suppliers` (Tasks 1–2), the existing `handle_new_user()` trigger body (reproduced below from `2026-08-16-15-signup-seeds-app-settings.sql`, the currently-live version).
- Produces: no new interface — extends `handle_new_user()` in place. `auth.signUp()`'s `options.data` gains an expected `contractor_type_id` field, consumed here and by Task 4's frontend change.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/2026-08-17-03-signup-trigger-contractor-seed.sql
--
-- Extends handle_new_user()'s new-tenant branch: sets the tenant's
-- contractor_type_id from signup metadata, then seeds expense_categories
-- and suppliers from that type's template rows. Only the NEWLY CREATED
-- tenant branch seeds anything here — an invited teammate joins an
-- existing tenant that should already have its own categories/suppliers,
-- so seeding there would be wrong, same reasoning as the app_settings
-- seed this migration sits alongside.
--
-- If contractor_type_id is absent or NULL in the metadata (shouldn't
-- happen once Task 4 makes the signup dropdown required, but the
-- trigger must not error on it), seeding is skipped entirely and the
-- tenant starts blank, exactly as it does today — a safety fallback,
-- not a supported path.
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_tenant_id UUID;
  v_invited_tenant_id UUID;
  v_contractor_type_id UUID;
BEGIN
  v_invited_tenant_id := (new.raw_user_meta_data->>'invited_tenant_id')::UUID;

  IF v_invited_tenant_id IS NOT NULL THEN
    v_tenant_id := v_invited_tenant_id;
  ELSE
    v_contractor_type_id := (new.raw_user_meta_data->>'contractor_type_id')::UUID;

    INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at, contractor_type_id)
    VALUES (
      COALESCE(new.raw_user_meta_data->>'company_name', new.email),
      new.id, 'trial', now() + interval '14 days', v_contractor_type_id
    )
    RETURNING id INTO v_tenant_id;

    -- Default settings for the new tenant, matching schema.sql's global
    -- app_settings seed values exactly.
    INSERT INTO app_settings (tenant_id, key, value) VALUES
      (v_tenant_id, 'travel_rate_per_km', '20'),
      (v_tenant_id, 'holiday_pay_multiplier', '1.5')
    ON CONFLICT (tenant_id, key) DO NOTHING;

    IF v_contractor_type_id IS NOT NULL THEN
      INSERT INTO expense_categories (name, color, sort_order, tenant_id)
      SELECT name, color, sort_order, v_tenant_id
      FROM contractor_type_categories
      WHERE contractor_type_id = v_contractor_type_id;

      INSERT INTO suppliers (name, tenant_id)
      SELECT s.supplier_name, v_tenant_id
      FROM contractor_type_category_suppliers s
      JOIN contractor_type_categories c ON c.id = s.category_template_id
      WHERE c.contractor_type_id = v_contractor_type_id;
    END IF;
  END IF;

  INSERT INTO public.user_roles (user_email, role, status, tenant_id)
  VALUES (
    new.email,
    CASE WHEN v_invited_tenant_id IS NULL THEN 'OWNER' ELSE 'WORKER' END,
    'approved',
    v_tenant_id
  )
  ON CONFLICT (user_email) DO NOTHING;

  RETURN new;
END;
$$;
```

- [ ] **Step 2: Apply the migration**

Use `mcp__plugin_supabase_supabase__apply_migration` with `name: signup_trigger_contractor_seed` and the SQL from Step 1.

- [ ] **Step 3: Live-verify via an uncommitted transaction**

This project's established pattern for testing `auth.users` triggers without leaving artifacts: run the insert and assertions inside a transaction that's never committed, relying on connection close to discard it (used successfully for `handle_new_user()`'s own prior verification). Run via `execute_sql`:

```sql
BEGIN;

DO $$
DECLARE
  v_painting_type_id UUID;
  v_new_user_id UUID := gen_random_uuid();
  v_tenant_id UUID;
  v_category_count INT;
  v_supplier_count INT;
  v_labor_category_supplier_count INT;
BEGIN
  SELECT id INTO v_painting_type_id FROM contractor_types WHERE key = 'painting';

  INSERT INTO auth.users (id, email, raw_user_meta_data)
  VALUES (
    v_new_user_id, '__test_contractor_seed__@example.com',
    jsonb_build_object('company_name', 'Test Painting Co', 'contractor_type_id', v_painting_type_id::text)
  );

  SELECT tenant_id INTO v_tenant_id FROM user_roles WHERE user_email = '__test_contractor_seed__@example.com';

  SELECT count(*) INTO v_category_count FROM expense_categories WHERE tenant_id = v_tenant_id;
  IF v_category_count != 3 THEN
    RAISE EXCEPTION 'REGRESSION: expected 3 seeded categories for painting, got %', v_category_count;
  END IF;

  SELECT count(*) INTO v_supplier_count FROM suppliers WHERE tenant_id = v_tenant_id;
  IF v_supplier_count != 2 THEN
    RAISE EXCEPTION 'REGRESSION: expected 2 seeded suppliers for painting (labor category gets none), got %', v_supplier_count;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM suppliers WHERE tenant_id = v_tenant_id AND name = 'TOA') THEN
    RAISE EXCEPTION 'REGRESSION: expected TOA among the seeded suppliers, not found';
  END IF;

  RAISE NOTICE 'Live trigger verification: TEST PASSED (% categories, % suppliers)', v_category_count, v_supplier_count;
END $$;

ROLLBACK;
```

Expected: `NOTICE: Live trigger verification: TEST PASSED (3 categories, 2 suppliers)`, no `ERROR`. The `ROLLBACK` at the end discards everything — confirm with a follow-up `SELECT count(*) FROM auth.users WHERE email = '__test_contractor_seed__@example.com';` outside the transaction, expect `0`.

- [ ] **Step 4: Verify the NULL-metadata safety fallback**

Run via `execute_sql`:

```sql
BEGIN;

DO $$
DECLARE
  v_tenant_id UUID;
  v_category_count INT;
BEGIN
  INSERT INTO auth.users (id, email, raw_user_meta_data)
  VALUES (gen_random_uuid(), '__test_no_type__@example.com', jsonb_build_object('company_name', 'Test No Type Co'));

  SELECT tenant_id INTO v_tenant_id FROM user_roles WHERE user_email = '__test_no_type__@example.com';
  SELECT count(*) INTO v_category_count FROM expense_categories WHERE tenant_id = v_tenant_id;

  IF v_category_count != 0 THEN
    RAISE EXCEPTION 'REGRESSION: signup with no contractor_type_id should seed 0 categories, got %', v_category_count;
  END IF;

  RAISE NOTICE 'NULL-metadata fallback: TEST PASSED';
END $$;

ROLLBACK;
```

Expected: `NOTICE: NULL-metadata fallback: TEST PASSED`, no `ERROR`.

- [ ] **Step 5: Append the fixture test to the repo's test file**

Add Test 4 to `supabase/tests/contractor_type_templates_test.sql` — the same `BEGIN ... DO $$ ... ROLLBACK;` block from Step 3 (the painting-signup case), so this scenario has permanent regression coverage rather than only being checked once during implementation:

```sql
-- ── Test 4: a new signup with contractor_type_id='painting' gets
-- exactly 3 seeded categories and 2 seeded suppliers (the labor
-- category gets none). Run inside an explicit transaction that's
-- rolled back, not committed — the established pattern for testing
-- auth.users triggers without leaving artifacts. ──
BEGIN;
DO $$
DECLARE
  v_painting_type_id UUID;
  v_tenant_id UUID;
  v_category_count INT;
  v_supplier_count INT;
BEGIN
  SELECT id INTO v_painting_type_id FROM contractor_types WHERE key = 'painting';

  INSERT INTO auth.users (id, email, raw_user_meta_data)
  VALUES (
    gen_random_uuid(), '__test_contractor_seed__@example.com',
    jsonb_build_object('company_name', 'Test Painting Co', 'contractor_type_id', v_painting_type_id::text)
  );

  SELECT tenant_id INTO v_tenant_id FROM user_roles WHERE user_email = '__test_contractor_seed__@example.com';
  SELECT count(*) INTO v_category_count FROM expense_categories WHERE tenant_id = v_tenant_id;
  SELECT count(*) INTO v_supplier_count FROM suppliers WHERE tenant_id = v_tenant_id;

  IF v_category_count != 3 THEN
    RAISE EXCEPTION 'Test 4 REGRESSION: expected 3 seeded categories for painting, got %', v_category_count;
  END IF;
  IF v_supplier_count != 2 THEN
    RAISE EXCEPTION 'Test 4 REGRESSION: expected 2 seeded suppliers for painting, got %', v_supplier_count;
  END IF;

  RAISE NOTICE 'Test 4 (signup trigger seeds categories + suppliers): TEST PASSED';
END $$;
ROLLBACK;
```

Note: this test's own `BEGIN`/`ROLLBACK` means it must be run as its own statement batch, not concatenated with Tests 1–3 into a single `execute_sql` call the way `tenant_scoping_test.sql`'s tests are — a `ROLLBACK` here would also discard Tests 1–3's own inserts/deletes if they ran earlier in the same implicit transaction. Run Test 4 as a separate `execute_sql` call from Tests 1–3.

- [ ] **Step 6: Update schema.sql**

Replace the `handle_new_user()` definition in `supabase/schema.sql` with the new version from Step 1.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/2026-08-17-03-signup-trigger-contractor-seed.sql supabase/tests/contractor_type_templates_test.sql supabase/schema.sql
git commit -m "feat: seed categories and suppliers from contractor type on signup"
```

---

### Task 4: Contractor-type dropdown on the signup form

**Files:**
- Modify: `src/hooks/useSupabase.js` (add `useContractorTypes()`)
- Modify: `src/pages/Login.jsx`

**Interfaces:**
- Consumes: `contractor_types` table (Task 1), `auth.signUp()`'s `contractor_type_id` metadata field (Task 3).
- Produces: `useContractorTypes()` returning `{ data, loading, error }` (the standard `useQuery` shape already used by every other hook in `useSupabase.js`) — consumed by Task 5 (Settings.jsx needs the same list).

- [ ] **Step 1: Add `useContractorTypes()` to useSupabase.js**

Add this function to `src/hooks/useSupabase.js`, placed near `useCompanyHolidays()` (same simple read-only list shape):

```javascript
// ── Contractor Types ────────────────────────────────────────────

/** รายการประเภทผู้รับเหมาทั้งหมด — ใช้ในฟอร์ม signup และหน้า Settings */
export function useContractorTypes() {
  return useQuery(async () => {
    const { data, error } = await supabase
      .from('contractor_types')
      .select('id, key, label_th')
      .order('sort_order')
    if (error) throw error
    return data
  })
}
```

- [ ] **Step 2: Add the dropdown and wire it into signUp() in Login.jsx**

Modify `src/pages/Login.jsx`. First, add the import and state:

```javascript
import { useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { useContractorTypes } from '../hooks/useSupabase.js'

export default function Login() {
  const [mode,     setMode]     = useState('login') // 'login' | 'signup'
  const [companyName, setCompanyName] = useState('')
  const [contractorTypeId, setContractorTypeId] = useState('')
  const [email,    setEmail]    = useState('')
  const [password, setPassword] = useState('')
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState(null)
  const [signupDone, setSignupDone] = useState(false)
  const { data: contractorTypes } = useContractorTypes()
```

Update `handleSignup` to pass `contractor_type_id`:

```javascript
  const handleSignup = async (e) => {
    e.preventDefault()
    setLoading(true)
    setError(null)
    const { error } = await supabase.auth.signUp({
      email, password,
      options: { data: { company_name: companyName, contractor_type_id: contractorTypeId } }
    })
    if (error) {
      setError(error.message)
      setLoading(false)
      return
    }
    setSignupDone(true)
    setLoading(false)
  }
```

Add the dropdown to the signup-mode form block, right after the company-name field:

```javascript
            {mode === 'signup' && (
              <div>
                <label className="label">ชื่อบริษัท</label>
                <input
                  type="text" className="input" required autoFocus
                  value={companyName} onChange={e => setCompanyName(e.target.value)}
                  placeholder="บริษัท ตัวอย่าง จำกัด"
                />
              </div>
            )}
            {mode === 'signup' && (
              <div>
                <label className="label">ประเภทผู้รับเหมา</label>
                <select
                  className="input" required
                  value={contractorTypeId} onChange={e => setContractorTypeId(e.target.value)}
                >
                  <option value="" disabled>เลือกประเภทผู้รับเหมา</option>
                  {(contractorTypes || []).map(t => (
                    <option key={t.id} value={t.id}>{t.label_th}</option>
                  ))}
                </select>
              </div>
            )}
```

- [ ] **Step 3: Verify the build**

Run: `npx vite build`
Expected: build succeeds with no new errors (pre-existing chunk-size warning is unrelated and expected).

- [ ] **Step 4: Manual verification**

No browser access is available in this environment (documented limitation from the prior signup-flow work). Verify the request shape via `curl` against the live GoTrue endpoint, matching exactly what the updated `handleSignup` now sends — get the real `contractor_types` UUID for `painting` first via `execute_sql` (`SELECT id FROM contractor_types WHERE key='painting';`), then:

```bash
set -a; source .env; set +a
curl -s -X POST "${VITE_SUPABASE_URL}/auth/v1/signup" \
  -H "apikey: ${VITE_SUPABASE_ANON_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"email":"__test_task4_e2e__@example.com","password":"testpass123","data":{"company_name":"__TEST TASK4 CO__","contractor_type_id":"<painting-type-uuid-from-above>"}}'
```

Verify via `execute_sql` that the resulting tenant has `contractor_type_id` set and 3 seeded categories / 2 seeded suppliers (same shape as Task 3's Test 4). Clean up: delete the `user_roles`, `tenants`, `expense_categories`, `suppliers` rows for this test tenant, then `DELETE FROM auth.users WHERE email = '__test_task4_e2e__@example.com';` (safe to delete `auth.users` directly here — confirmed in the prior signup work that all child auth tables cascade).

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useSupabase.js src/pages/Login.jsx
git commit -m "feat: add contractor-type dropdown to the signup form"
```

---

### Task 5: Change contractor type later, from Settings

**Files:**
- Modify: `src/hooks/useTenant.js` (add `refetch`)
- Modify: `src/pages/Settings.jsx`

**Interfaces:**
- Consumes: `useTenant()` (adds `refetch`), `useContractorTypes()` (Task 4).
- Produces: no new interface.

- [ ] **Step 1: Add `refetch` to useTenant.js**

Modify `src/hooks/useTenant.js` — the `fetchTenant` function is already extracted as a `useCallback`, so exposing it just means adding it to the returned object:

```javascript
  return { tenant, enabledModules, loading, isTrialActive, trialDaysRemaining, hasModuleAccess, refetch: fetchTenant }
```

- [ ] **Step 2: Add the "change contractor type" card to Settings.jsx**

Modify `src/pages/Settings.jsx`. Add the import and state, alongside the existing travel-rate state:

```javascript
import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase.js'
import { useAppSetting, saveAppSetting, useContractorTypes } from '../hooks/useSupabase.js'
import { useTenant } from '../hooks/useTenant.js'

export default function Settings() {
  const [permissions, setPermissions] = useState(DEFAULT_PERMISSIONS)
  const [saving, setSaving] = useState(false)

  // Contractor type — stored on tenants.contractor_type_id
  const { tenant, refetch: refetchTenant } = useTenant()
  const { data: contractorTypes } = useContractorTypes()
  const [contractorTypeId, setContractorTypeId] = useState('')
  const [savingType, setSavingType] = useState(false)
  useEffect(() => { if (tenant) setContractorTypeId(tenant.contractor_type_id || '') }, [tenant])

  const handleSaveContractorType = async () => {
    setSavingType(true)
    try {
      const { error } = await supabase
        .from('tenants')
        .update({ contractor_type_id: contractorTypeId || null })
        .eq('id', tenant.id)
      if (error) throw error
      refetchTenant()
      alert('✅ บันทึกประเภทผู้รับเหมาแล้ว')
    } catch (e) {
      alert('Error: ' + e.message)
    } finally {
      setSavingType(false)
    }
  }
```

Add the card to the JSX, right after the travel-rate card (before the "ตั้งค่าสิทธิ์เข้าใช้งาน" section):

```javascript
      {/* ── ประเภทผู้รับเหมา ── */}
      <div className="card" style={{ marginBottom: 24, padding: '16px 20px' }}>
        <h2 style={{ marginBottom: 4, fontSize: 16, fontWeight: 700 }}>🏗️ ประเภทผู้รับเหมา</h2>
        <p style={{ fontSize: 13, color: 'var(--text3)', marginBottom: 12 }}>
          เปลี่ยนได้ตลอด — ไม่กระทบหมวดค่าใช้จ่ายหรือ supplier ที่มีอยู่แล้ว
        </p>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div>
            <label className="label">ประเภทผู้รับเหมา</label>
            <select
              className="input" style={{ width: 240 }}
              value={contractorTypeId} onChange={e => setContractorTypeId(e.target.value)}
            >
              <option value="">— ไม่ระบุ —</option>
              {(contractorTypes || []).map(t => (
                <option key={t.id} value={t.id}>{t.label_th}</option>
              ))}
            </select>
          </div>
          <button className="btn btn-primary" onClick={handleSaveContractorType} disabled={savingType || !tenant}>
            {savingType ? '⏳ กำลังบันทึก...' : '✅ บันทึก'}
          </button>
        </div>
      </div>
```

- [ ] **Step 3: Verify the RLS write path**

`tenants` UPDATE is gated by `owner_updates_own_tenant` (`is_owner() AND id = current_tenant_id()`) per the existing multi-tenancy RLS — confirm this is still correct for this new write path by checking via `execute_sql`:

```sql
SELECT qual, with_check FROM pg_policies
WHERE schemaname='public' AND tablename='tenants' AND cmd='UPDATE';
```

Expected: the existing `owner_updates_own_tenant` policy, unchanged by this task (no new migration needed — an OWNER updating their own tenant's `contractor_type_id` is exactly the write path this policy already allows).

- [ ] **Step 4: Verify the build**

Run: `npx vite build`
Expected: build succeeds with no new errors.

- [ ] **Step 5: Manual verification**

No browser access available. Verify via `execute_sql`, simulating the exact update Settings.jsx now performs, against the real FacadeX tenant (revert immediately after):

```sql
-- Capture current state
SELECT contractor_type_id FROM tenants WHERE company_name = 'Facade X';
-- => expect NULL (never set)

-- Simulate the Settings.jsx save, as the real OWNER
BEGIN;
SET LOCAL role = 'authenticated';
SET LOCAL request.jwt.claims = '{"email":"contact@facadex.co.th"}';
UPDATE tenants SET contractor_type_id = (SELECT id FROM contractor_types WHERE key = 'glass_aluminum')
WHERE id = (SELECT tenant_id FROM user_roles WHERE user_email = 'contact@facadex.co.th');
SELECT contractor_type_id FROM tenants WHERE company_name = 'Facade X';
-- => expect the glass_aluminum type's UUID
ROLLBACK;

-- Confirm the rollback left FacadeX untouched
SELECT contractor_type_id FROM tenants WHERE company_name = 'Facade X';
-- => expect NULL again
```

- [ ] **Step 6: Commit**

```bash
git add src/hooks/useTenant.js src/pages/Settings.jsx
git commit -m "feat: add contractor-type setting, changeable any time"
```

---

### Task 6: End-to-end manual verification checklist

**Files:** none (verification only)

- [ ] Run the full `supabase/tests/contractor_type_templates_test.sql` file (Tests 1–3 together, then Test 4 separately per its own `BEGIN`/`ROLLBACK` note) via `execute_sql` — all 4 tests print `TEST PASSED`, no errors.
- [ ] Fresh signup with a contractor type selected (via the curl method from Task 4, Step 4, or the deployed signup page if browser access becomes available) produces a tenant with exactly that type's categories and material-only suppliers seeded, verified against Task 2's content table.
- [ ] Fresh signup with the dropdown left at its placeholder value is rejected client-side by the `required` attribute (cannot submit) — confirmed by reading `Login.jsx`'s JSX, since this is a native HTML constraint, not app logic that could regress independently.
- [ ] Settings.jsx's contractor-type save updates `tenants.contractor_type_id` without touching any existing `expense_categories`/`suppliers` row (verified via the Task 5, Step 5 SQL simulation).
- [ ] The real FacadeX tenant's `contractor_type_id` is confirmed `NULL` after all verification steps (nothing in this plan should have permanently changed it — FacadeX predates this feature and its own categories/suppliers were set up manually, independent of any template).
- [ ] `mcp__plugin_supabase_supabase__get_advisors` (security type) — confirm no new findings introduced by this plan's migrations (the three new tables' `authenticated`-only, read-only RLS shape matches the already-accepted `tenant_modules` pattern from the multi-tenancy plan, so none are expected).

---

### Task 7: Final whole-branch review + finishing-a-development-branch

- [ ] Dispatch a final code-reviewer over the full branch diff (3 migrations + 1 test file + 4 frontend files).
- [ ] Use the `superpowers:finishing-a-development-branch` skill to verify build status and present merge/PR/keep/discard options.
