# Aluminium Cost Catalog — Phase 1 (Catalog) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the aluminium cost database (extruder → series → type → components, per-extruder colours, price history with effective dates) with a management screen, and a tested pure price-resolution function, without touching the existing BOM engine.

**Architecture:** Three additive SQL migrations creating only new tables (no change to any existing table), all gated by `has_module_access('estimation')` and independent of the purchase-orders module. A pure `resolveAluPrice` library picks prices from rows loaded client-side. A new page `AluCatalog` (five tabs) is built from two generic components (`CatalogCrud`, `LinkEditor`) so each tab is mostly configuration. Phase 2 (engine wiring, project defaults, item flow) and Phase 3 (price structure, export) are separate plans.

**Tech Stack:** Postgres/Supabase (RLS), React + Vite, vitest, supabase-js. Thai UI copy.

**Spec:** `docs/superpowers/specs/2026-10-08-aluminium-cost-catalog-design.md` (read the "Data model", "Prices" and Decision 7 sections first).

## Global Constraints

- FacadeX only: every new table has RLS policy `admin_full_access` = `is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation')` for both `USING` and `WITH CHECK`.
- Every new table: `tenant_id UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id)` and an index on `tenant_id`. Any `UNIQUE` must include `tenant_id` or a tenant-scoped parent id (a globally-unique name once blocked new tenant signups).
- The catalog is separate from the legacy tables: new `alu_profiles` and `alu_finishes` (both gated by `estimation` only). Do NOT alter `aluminum_profiles` (read by PO receiving, gated by `purchase_orders`) or `aluminum_finishes` (has `price_per_kg`, read by the current engine). Linking the catalog to the PO side is deferred until the owner is happy with the catalog.
- Do NOT modify `src/lib/bomEngine.js`, `src/pages/Estimation.jsx`, `src/pages/BomTemplates.jsx`, `src/pages/AluminumProfiles.jsx`. Phase 1 must leave the existing estimation module working.
- Prices live only in the three price tables; the new catalog has no `price_per_kg` column anywhere else. The legacy `aluminum_finishes.price_per_kg` keeps serving the current engine until Phase 2 repoints it to the catalog and retires `aluminum_finishes`.
- Migrations are written but NOT applied by the agent. The owner applies them with `!`. Verify SQL only inside `BEGIN; … ROLLBACK;`.
- Price tables are append-only history: `effective_from DATE NOT NULL`, `source TEXT NOT NULL DEFAULT 'manual'`; lookup = latest row with `effective_from <= asOf`. Dates are `'YYYY-MM-DD'` strings in JS.
- No upserts and no PostgREST embeds in Phase 1: use plain `insert`/`update`/`delete` and load tables separately, joining client-side (avoids the `onConflict` and ambiguous-FK traps).
- Reads of catalog tables go through `fetchCatalogRows` (pages past PostgREST's 1000-row cap).
- Migration file names sort after the newest existing one (`2026-10-09-03-…`): use `2026-10-10-01`, `-02`, `-03`.
- Commit messages end with the line `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Run unit tests with `npx vitest run <file>`; whole suite `npm test`; build `npm run build`.

## Review Focus

Inputs and conditions the spec implies that a person will hit, most likely first. Each has a pinning test in the task named.

1. A price history longer than 1000 rows must not be silently truncated in the UI — Task 6 (`fetchCatalogRows` test with 1005 rows).
2. A second tenant (or FacadeX's own second extruder) creating the same name as an existing row must not collide — Task 1 (SQL: tenant B can create provider `TYK` too; two series of the same name under different providers).
3. Two price rows with the same effective date, deleting a row that other rows depend on, and invalid numbers must give a readable Thai message, not a raw Postgres error — Task 5 (`friendlyDbError`).
4. A per-kg extruder whose profile weight is 0/missing, or that only has piece prices, must come back `unresolved` and never cost 0 silently; a price dated in the future must be ignored — Task 4.
5. A tenant without the estimation module must see and write nothing in any new table, and a tenant with `estimation` but NOT `purchase_orders` must be able to use all of it — Tasks 1–3 (SQL: tenants A and B hold only `estimation`, tenant C holds nothing).
6. An inactive provider/series/profile must disappear from pickers for new rows but still show its name when editing an old row that points at it — Task 5 (`optionList`).

## File Structure

| Path | Responsibility |
|---|---|
| `supabase/migrations/2026-10-10-01-alu-catalog-hierarchy.sql` | providers, types, series, series↔types |
| `supabase/migrations/2026-10-10-02-alu-catalog-components.sql` | new `alu_profiles` and `alu_finishes` (per-extruder, no price), series↔profiles, variants, parts, sets, series↔parts |
| `supabase/migrations/2026-10-10-03-alu-catalog-prices.sql` | kg / piece / part price history |
| `supabase/tests/alu_catalog_test.sql` | RLS, uniqueness and CHECK tests (run inside BEGIN/ROLLBACK) |
| `src/lib/aluPrice.js` (+ `.test.js`) | pure price resolution |
| `src/lib/aluCatalog.js` (+ `.test.js`) | series labels (full / short) |
| `src/lib/catalogForm.js` (+ `.test.js`) | form ↔ payload helpers, option lists, friendly DB errors |
| `src/lib/catalogData.js` (+ `.test.js`) | paged reads of a catalog table |
| `src/hooks/useAluCatalog.js` | `useCatalogTable` hook |
| `src/components/CatalogCrud.jsx` | generic list + add/edit/delete modal |
| `src/components/LinkEditor.jsx` | generic many-to-many checkbox editor with an optional extra column |
| `src/pages/AluCatalog.jsx` | page shell with tabs |
| `src/pages/aluCatalog/HierarchyTab.jsx`, `TypesTab.jsx`, `ProfilesTab.jsx`, `PartsTab.jsx`, `PricesTab.jsx` | one file per tab |
| `src/App.jsx` | nav entry + route |

---

### Task 1: Hierarchy migration and SQL test scaffold

**Files:**
- Create: `supabase/migrations/2026-10-10-01-alu-catalog-hierarchy.sql`
- Create: `supabase/tests/alu_catalog_test.sql`

**Interfaces:**
- Produces: tables `alu_providers(id, tenant_id, name, short_name, price_basis, active, created_at)`, `door_window_types(id, tenant_id, name, category, default_labour_per_sqm, active, created_at)`, `alu_series(id, tenant_id, provider_id, name, is_base, active, created_at)`, `alu_series_types(id, tenant_id, series_id, type_id)`. Later tasks and the UI use these exact names.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/2026-10-10-01-alu-catalog-hierarchy.sql
-- Aluminium cost catalog, part 1 of 3: extruder -> series -> door/window type.
-- FacadeX only: every policy is gated by has_module_access('estimation').
-- Spec: docs/superpowers/specs/2026-10-08-aluminium-cost-catalog-design.md

CREATE TABLE alu_providers (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id   UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  name        TEXT NOT NULL,
  short_name  TEXT NOT NULL,
  price_basis TEXT NOT NULL DEFAULT 'per_kg' CHECK (price_basis IN ('per_kg','per_piece','both')),
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TABLE door_window_types (
  id                     UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id              UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  name                   TEXT NOT NULL,
  category               TEXT NOT NULL CHECK (category IN ('door','window')),
  default_labour_per_sqm NUMERIC CHECK (default_labour_per_sqm IS NULL OR default_labour_per_sqm >= 0),
  active                 BOOLEAN NOT NULL DEFAULT true,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TABLE alu_series (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id   UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  provider_id UUID NOT NULL REFERENCES alu_providers(id) ON DELETE RESTRICT,
  name        TEXT NOT NULL,
  is_base     BOOLEAN NOT NULL DEFAULT false,
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider_id, name)
);

CREATE TABLE alu_series_types (
  id        UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  series_id UUID NOT NULL REFERENCES alu_series(id) ON DELETE CASCADE,
  type_id   UUID NOT NULL REFERENCES door_window_types(id) ON DELETE CASCADE,
  UNIQUE (series_id, type_id)
);

CREATE INDEX idx_alu_series_provider_id   ON alu_series(provider_id);
CREATE INDEX idx_alu_series_types_type_id ON alu_series_types(type_id);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['alu_providers','door_window_types','alu_series','alu_series_types'] LOOP
    EXECUTE format('CREATE INDEX idx_%s_tenant_id ON %I(tenant_id)', t, t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY admin_full_access ON %I FOR ALL TO authenticated
      USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation'))
      WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation'))$p$, t);
  END LOOP;
END $$;
```

- [ ] **Step 2: Write the SQL test file (fixtures + Test 1)**

```sql
-- supabase/tests/alu_catalog_test.sql
-- Aluminium cost catalog: RLS isolation, uniqueness and CHECK constraints.
-- RUN ONLY INSIDE A TRANSACTION THAT ROLLS BACK:
--   BEGIN; <migrations 01..03>; <this file>; ROLLBACK;
-- Tenants: A and B have ONLY the 'estimation' module (the catalog must not need purchase_orders), C has no module (expired trial).

CREATE TEMP TABLE _alu_fx (a_tenant UUID, b_tenant UUID, c_tenant UUID);
DO $$
DECLARE owner_id UUID; ta UUID; tb UUID; tc UUID;
BEGIN
  SELECT id INTO owner_id FROM auth.users ORDER BY created_at ASC LIMIT 1;
  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at)
    VALUES ('__ALU TEST A__', owner_id, 'expired', now() - interval '1 day') RETURNING id INTO ta;
  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at)
    VALUES ('__ALU TEST B__', owner_id, 'expired', now() - interval '1 day') RETURNING id INTO tb;
  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at)
    VALUES ('__ALU TEST C__', owner_id, 'expired', now() - interval '1 day') RETURNING id INTO tc;
  INSERT INTO tenant_modules (tenant_id, module_key) VALUES (ta, 'estimation'), (tb, 'estimation');
  INSERT INTO user_roles (user_email, role, status, tenant_id) VALUES
    ('__alu_a__@example.com', 'OWNER', 'approved', ta),
    ('__alu_b__@example.com', 'OWNER', 'approved', tb),
    ('__alu_c__@example.com', 'OWNER', 'approved', tc);
  INSERT INTO _alu_fx VALUES (ta, tb, tc);
END $$;

-- ── Test 1: hierarchy tables ──
DO $$
DECLARE
  prov UUID; prov2 UUID; ser UUID; typ UUID; n INT;
BEGIN
  SET LOCAL role = 'authenticated';
  SET LOCAL request.jwt.claims = '{"email":"__alu_a__@example.com"}';

  INSERT INTO alu_providers (name, short_name, price_basis) VALUES ('TYK', 'TYK', 'per_kg') RETURNING id INTO prov;
  INSERT INTO alu_providers (name, short_name, price_basis) VALUES ('KC', 'KC', 'both') RETURNING id INTO prov2;
  INSERT INTO alu_series (provider_id, name, is_base) VALUES (prov, 'กล่องร่อง', true) RETURNING id INTO ser;
  -- the same series name under a different provider is allowed
  INSERT INTO alu_series (provider_id, name) VALUES (prov2, 'กล่องร่อง');
  INSERT INTO door_window_types (name, category, default_labour_per_sqm) VALUES ('บานเลื่อน', 'window', 140) RETURNING id INTO typ;
  INSERT INTO alu_series_types (series_id, type_id) VALUES (ser, typ);

  -- invalid price_basis
  BEGIN
    INSERT INTO alu_providers (name, short_name, price_basis) VALUES ('BAD', 'BAD', 'per_sheet');
    RAISE EXCEPTION 'price_basis CHECK did not fire';
  EXCEPTION WHEN check_violation THEN NULL; END;

  -- duplicate provider name inside one tenant
  BEGIN
    INSERT INTO alu_providers (name, short_name) VALUES ('TYK', 'TYK2');
    RAISE EXCEPTION 'provider unique did not fire';
  EXCEPTION WHEN unique_violation THEN NULL; END;

  -- duplicate series<->type link
  BEGIN
    INSERT INTO alu_series_types (series_id, type_id) VALUES (ser, typ);
    RAISE EXCEPTION 'series_types unique did not fire';
  EXCEPTION WHEN unique_violation THEN NULL; END;

  -- tenant B: sees nothing of A, and may reuse the same provider name
  SET LOCAL request.jwt.claims = '{"email":"__alu_b__@example.com"}';
  SELECT count(*) INTO n FROM alu_providers;
  IF n <> 0 THEN RAISE EXCEPTION 'tenant B sees % of tenant A providers', n; END IF;
  INSERT INTO alu_providers (name, short_name) VALUES ('TYK', 'TYK');

  -- tenant C (no estimation module): reads nothing, cannot write
  SET LOCAL request.jwt.claims = '{"email":"__alu_c__@example.com"}';
  SELECT count(*) INTO n FROM alu_providers;
  IF n <> 0 THEN RAISE EXCEPTION 'tenant C sees providers'; END IF;
  BEGIN
    INSERT INTO alu_providers (name, short_name) VALUES ('NOPE', 'NOPE');
    RAISE EXCEPTION 'tenant C insert was allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  RESET role;
  RAISE NOTICE 'Test 1 (hierarchy): TEST PASSED';
END $$;
```

- [ ] **Step 3: Run migration + test inside a rolled-back transaction**

```bash
SCRATCH=/private/tmp/claude-501/-Users-plfx-code-FacadeXPM-facadex-app/c6b37346-e3c3-435c-b5ba-380c8b970a05/scratchpad
{ echo 'BEGIN;'; cat supabase/migrations/2026-10-10-01-alu-catalog-hierarchy.sql supabase/tests/alu_catalog_test.sql; echo 'ROLLBACK;'; } > $SCRATCH/alu_t1.sql
npx supabase db query --linked -f $SCRATCH/alu_t1.sql
```

Expected: no `ERROR`; output includes `Test 1 (hierarchy): TEST PASSED`. (The Supabase MCP `execute_sql` with the same text is an equivalent way to run it.) If `--linked` reports the worktree is not linked, ask the owner for the project ref and pass `--project-ref`. Confirm nothing persisted: `npx supabase db query --linked "select to_regclass('public.alu_providers')"` returns null.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/2026-10-10-01-alu-catalog-hierarchy.sql supabase/tests/alu_catalog_test.sql
git commit -m "feat(alu-catalog): hierarchy tables with RLS and SQL test" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Components migration

**Files:**
- Create: `supabase/migrations/2026-10-10-02-alu-catalog-components.sql`
- Modify: `supabase/tests/alu_catalog_test.sql` (append Test 2)

**Interfaces:**
- Consumes: Task 1 tables.
- Produces: tables `alu_profiles(id, tenant_id, provider_id, name, drawing_no, family, thickness_mm, linear_weight_kg_per_m, default_length_m, image_url, active, created_at)`, `alu_finishes(id, tenant_id, provider_id, name, code, active, created_at)`, `alu_series_profiles(id, tenant_id, series_id, profile_id, family)`, `alu_profile_variants(id, tenant_id, profile_id, finish_id, length_m)`, `alu_parts(id, tenant_id, provider_id, name, kind, unit, active, created_at)`, `alu_part_set_items(id, tenant_id, set_id, part_id, quantity)`, `alu_series_parts(id, tenant_id, series_id, type_id, part_id)`.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/2026-10-10-02-alu-catalog-components.sql
-- Aluminium cost catalog, part 2 of 3: profiles, colours, variants, parts.
-- Deliberately separate from the legacy aluminum_profiles (read by PO
-- receiving, gated by the purchase_orders module) and aluminum_finishes
-- (has price_per_kg, read by the current estimation engine): neither is
-- altered. Phase 2 repoints the engine here; a link to the PO side can be
-- added later. Prices live only in the price tables (migration 03).

CREATE TABLE alu_profiles (
  id                     UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id              UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  provider_id            UUID NOT NULL REFERENCES alu_providers(id) ON DELETE RESTRICT,
  name                   TEXT NOT NULL,
  drawing_no             TEXT,
  family                 TEXT,
  thickness_mm           NUMERIC CHECK (thickness_mm IS NULL OR thickness_mm > 0),
  linear_weight_kg_per_m NUMERIC NOT NULL CHECK (linear_weight_kg_per_m >= 0),
  default_length_m       NUMERIC NOT NULL DEFAULT 6.4 CHECK (default_length_m > 0),
  image_url              TEXT,
  active                 BOOLEAN NOT NULL DEFAULT true,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE alu_finishes (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id   UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  provider_id UUID NOT NULL REFERENCES alu_providers(id) ON DELETE RESTRICT,
  name        TEXT NOT NULL,
  code        TEXT,
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider_id, name)
);
CREATE INDEX idx_alu_profiles_provider_id ON alu_profiles(provider_id);
CREATE INDEX idx_alu_finishes_provider_id ON alu_finishes(provider_id);

CREATE TABLE alu_series_profiles (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id  UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  series_id  UUID NOT NULL REFERENCES alu_series(id) ON DELETE CASCADE,
  profile_id UUID NOT NULL REFERENCES alu_profiles(id) ON DELETE CASCADE,
  family     TEXT,
  UNIQUE (series_id, profile_id)
);

CREATE TABLE alu_profile_variants (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id  UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  profile_id UUID NOT NULL REFERENCES alu_profiles(id) ON DELETE CASCADE,
  finish_id  UUID NOT NULL REFERENCES alu_finishes(id) ON DELETE RESTRICT,
  length_m   NUMERIC NOT NULL CHECK (length_m > 0),
  UNIQUE (profile_id, finish_id, length_m)
);

CREATE TABLE alu_parts (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id   UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  provider_id UUID REFERENCES alu_providers(id) ON DELETE RESTRICT,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'hardware' CHECK (kind IN ('hardware','hardware_set','accessory')),
  unit        TEXT NOT NULL DEFAULT 'ชิ้น',
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE alu_part_set_items (
  id        UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  set_id    UUID NOT NULL REFERENCES alu_parts(id) ON DELETE CASCADE,
  part_id   UUID NOT NULL REFERENCES alu_parts(id) ON DELETE RESTRICT,
  quantity  NUMERIC NOT NULL DEFAULT 1 CHECK (quantity > 0),
  UNIQUE (set_id, part_id),
  CHECK (set_id <> part_id)
);

CREATE TABLE alu_series_parts (
  id        UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  series_id UUID NOT NULL REFERENCES alu_series(id) ON DELETE CASCADE,
  type_id   UUID REFERENCES door_window_types(id) ON DELETE CASCADE,
  part_id   UUID NOT NULL REFERENCES alu_parts(id) ON DELETE CASCADE
);
-- one row per (series, type-or-any, part); type_id NULL means "every type"
CREATE UNIQUE INDEX uq_alu_series_parts
  ON alu_series_parts (series_id, COALESCE(type_id, '00000000-0000-0000-0000-000000000000'::uuid), part_id);

CREATE INDEX idx_alu_series_profiles_profile_id ON alu_series_profiles(profile_id);
CREATE INDEX idx_alu_profile_variants_finish_id ON alu_profile_variants(finish_id);
CREATE INDEX idx_alu_parts_provider_id          ON alu_parts(provider_id);
CREATE INDEX idx_alu_part_set_items_part_id     ON alu_part_set_items(part_id);
CREATE INDEX idx_alu_series_parts_part_id       ON alu_series_parts(part_id);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['alu_profiles','alu_finishes','alu_series_profiles','alu_profile_variants','alu_parts','alu_part_set_items','alu_series_parts'] LOOP
    EXECUTE format('CREATE INDEX idx_%s_tenant_id ON %I(tenant_id)', t, t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY admin_full_access ON %I FOR ALL TO authenticated
      USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation'))
      WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation'))$p$, t);
  END LOOP;
END $$;
```

- [ ] **Step 2: Append Test 2 to `supabase/tests/alu_catalog_test.sql`**

```sql
-- ── Test 2: components ──
DO $$
DECLARE
  prov UUID; ser UUID; typ UUID; prof UUID; fin UUID; setp UUID; partp UUID; n INT;
BEGIN
  SET LOCAL role = 'authenticated';
  SET LOCAL request.jwt.claims = '{"email":"__alu_a__@example.com"}';

  SELECT id INTO prov FROM alu_providers WHERE name = 'TYK';
  SELECT id INTO ser  FROM alu_series WHERE provider_id = prov AND name = 'กล่องร่อง';
  SELECT id INTO typ  FROM door_window_types WHERE name = 'บานเลื่อน';

  INSERT INTO alu_profiles (name, linear_weight_kg_per_m, provider_id, drawing_no, thickness_mm)
    VALUES ('กล่องร่อง 1.2', 0.8, prov, 'FX-001', 1.2) RETURNING id INTO prof;
  INSERT INTO alu_finishes (name, provider_id, code) VALUES ('ขาว', prov, 'W01') RETURNING id INTO fin;
  INSERT INTO alu_series_profiles (series_id, profile_id, family) VALUES (ser, prof, 'กล่องร่อง');
  INSERT INTO alu_profile_variants (profile_id, finish_id, length_m) VALUES (prof, fin, 6.4);

  BEGIN
    INSERT INTO alu_series_profiles (series_id, profile_id) VALUES (ser, prof);
    RAISE EXCEPTION 'series_profiles unique did not fire';
  EXCEPTION WHEN unique_violation THEN NULL; END;

  BEGIN
    INSERT INTO alu_profile_variants (profile_id, finish_id, length_m) VALUES (prof, fin, 0);
    RAISE EXCEPTION 'length CHECK did not fire';
  EXCEPTION WHEN check_violation THEN NULL; END;

  INSERT INTO alu_parts (name, kind) VALUES ('ชุดล็อกบานเลื่อน', 'hardware_set') RETURNING id INTO setp;
  INSERT INTO alu_parts (name, kind, unit) VALUES ('ยางขอบ', 'accessory', 'ม.') RETURNING id INTO partp;
  INSERT INTO alu_part_set_items (set_id, part_id, quantity) VALUES (setp, partp, 2);

  BEGIN
    INSERT INTO alu_part_set_items (set_id, part_id) VALUES (setp, setp);
    RAISE EXCEPTION 'set_id <> part_id CHECK did not fire';
  EXCEPTION WHEN check_violation THEN NULL; END;

  -- NULL type_id means "every type"; two such rows for the same part must collide
  INSERT INTO alu_series_parts (series_id, part_id) VALUES (ser, partp);
  BEGIN
    INSERT INTO alu_series_parts (series_id, part_id) VALUES (ser, partp);
    RAISE EXCEPTION 'series_parts NULL-type unique did not fire';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  INSERT INTO alu_series_parts (series_id, type_id, part_id) VALUES (ser, typ, partp);  -- a typed row is a different row

  -- tenant C: nothing visible, cannot write
  SET LOCAL request.jwt.claims = '{"email":"__alu_c__@example.com"}';
  SELECT count(*) INTO n FROM alu_parts;
  IF n <> 0 THEN RAISE EXCEPTION 'tenant C sees parts'; END IF;
  BEGIN
    INSERT INTO alu_parts (name) VALUES ('NOPE');
    RAISE EXCEPTION 'tenant C insert was allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  RESET role;
  RAISE NOTICE 'Test 2 (components): TEST PASSED';
END $$;
```

- [ ] **Step 3: Run migrations 01+02 and the test file in a rolled-back transaction**

```bash
SCRATCH=/private/tmp/claude-501/-Users-plfx-code-FacadeXPM-facadex-app/c6b37346-e3c3-435c-b5ba-380c8b970a05/scratchpad
{ echo 'BEGIN;'; cat supabase/migrations/2026-10-10-01-alu-catalog-hierarchy.sql supabase/migrations/2026-10-10-02-alu-catalog-components.sql supabase/tests/alu_catalog_test.sql; echo 'ROLLBACK;'; } > $SCRATCH/alu_t2.sql
npx supabase db query --linked -f $SCRATCH/alu_t2.sql
```

Expected: no `ERROR`; both `Test 1` and `Test 2 … TEST PASSED` notices.

Then confirm the catalog never touches the legacy tables: `grep -nE "ALTER TABLE aluminum_|REFERENCES aluminum_" supabase/migrations/2026-10-10-0*.sql` → expected: no output.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/2026-10-10-02-alu-catalog-components.sql supabase/tests/alu_catalog_test.sql
git commit -m "feat(alu-catalog): profiles, colours, variants, parts, sets, series links" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Price history migration

**Files:**
- Create: `supabase/migrations/2026-10-10-03-alu-catalog-prices.sql`
- Modify: `supabase/tests/alu_catalog_test.sql` (append Test 3)

**Interfaces:**
- Produces: `alu_kg_prices(id, tenant_id, provider_id, finish_id, series_id, profile_id, price_per_kg, effective_from, source, created_at)`, `alu_piece_prices(id, tenant_id, variant_id, price_per_piece, effective_from, source, created_at)`, `alu_part_prices(id, tenant_id, part_id, list_price, discount_pct, effective_from, source, created_at)`.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/2026-10-10-03-alu-catalog-prices.sql
-- Aluminium cost catalog, part 3 of 3: price history (append-only by convention;
-- a price is looked up as "latest row with effective_from <= the date asked").

CREATE TABLE alu_kg_prices (
  id             UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id      UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  provider_id    UUID NOT NULL REFERENCES alu_providers(id) ON DELETE RESTRICT,
  finish_id      UUID NOT NULL REFERENCES alu_finishes(id) ON DELETE RESTRICT,
  series_id      UUID REFERENCES alu_series(id) ON DELETE CASCADE,
  profile_id     UUID REFERENCES alu_profiles(id) ON DELETE CASCADE,
  price_per_kg   NUMERIC NOT NULL CHECK (price_per_kg >= 0),
  effective_from DATE NOT NULL,
  source         TEXT NOT NULL DEFAULT 'manual',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (series_id IS NULL OR profile_id IS NULL)
);
CREATE UNIQUE INDEX uq_alu_kg_prices ON alu_kg_prices (
  provider_id, finish_id,
  COALESCE(series_id,  '00000000-0000-0000-0000-000000000000'::uuid),
  COALESCE(profile_id, '00000000-0000-0000-0000-000000000000'::uuid),
  effective_from
);

CREATE TABLE alu_piece_prices (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id       UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  variant_id      UUID NOT NULL REFERENCES alu_profile_variants(id) ON DELETE CASCADE,
  price_per_piece NUMERIC NOT NULL CHECK (price_per_piece >= 0),
  effective_from  DATE NOT NULL,
  source          TEXT NOT NULL DEFAULT 'manual',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (variant_id, effective_from)
);

CREATE TABLE alu_part_prices (
  id             UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id      UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  part_id        UUID NOT NULL REFERENCES alu_parts(id) ON DELETE CASCADE,
  list_price     NUMERIC NOT NULL CHECK (list_price >= 0),
  discount_pct   NUMERIC NOT NULL DEFAULT 0 CHECK (discount_pct >= 0 AND discount_pct <= 100),
  effective_from DATE NOT NULL,
  source         TEXT NOT NULL DEFAULT 'manual',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (part_id, effective_from)
);

CREATE INDEX idx_alu_kg_prices_finish_id ON alu_kg_prices(finish_id);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['alu_kg_prices','alu_piece_prices','alu_part_prices'] LOOP
    EXECUTE format('CREATE INDEX idx_%s_tenant_id ON %I(tenant_id)', t, t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY admin_full_access ON %I FOR ALL TO authenticated
      USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation'))
      WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation'))$p$, t);
  END LOOP;
END $$;
```

- [ ] **Step 2: Append Test 3 to `supabase/tests/alu_catalog_test.sql`**

```sql
-- ── Test 3: price history ──
DO $$
DECLARE
  prov UUID; ser UUID; prof UUID; fin UUID; var UUID; partp UUID; n INT;
BEGIN
  SET LOCAL role = 'authenticated';
  SET LOCAL request.jwt.claims = '{"email":"__alu_a__@example.com"}';

  SELECT id INTO prov FROM alu_providers WHERE name = 'TYK';
  SELECT id INTO ser  FROM alu_series WHERE provider_id = prov;
  SELECT id INTO prof FROM alu_profiles WHERE provider_id = prov;
  SELECT id INTO fin  FROM alu_finishes WHERE provider_id = prov;
  SELECT id INTO var  FROM alu_profile_variants WHERE profile_id = prof;
  SELECT id INTO partp FROM alu_parts WHERE name = 'ยางขอบ';

  INSERT INTO alu_kg_prices (provider_id, finish_id, price_per_kg, effective_from) VALUES (prov, fin, 95, '2026-01-01');
  INSERT INTO alu_kg_prices (provider_id, finish_id, price_per_kg, effective_from) VALUES (prov, fin, 98, '2026-06-01');  -- history: a later date is a new row
  INSERT INTO alu_kg_prices (provider_id, finish_id, series_id, price_per_kg, effective_from) VALUES (prov, fin, ser, 101, '2026-01-01');  -- series override, same date is fine

  BEGIN
    INSERT INTO alu_kg_prices (provider_id, finish_id, price_per_kg, effective_from) VALUES (prov, fin, 99, '2026-01-01');
    RAISE EXCEPTION 'kg price same-date unique did not fire';
  EXCEPTION WHEN unique_violation THEN NULL; END;

  BEGIN
    INSERT INTO alu_kg_prices (provider_id, finish_id, series_id, profile_id, price_per_kg, effective_from)
      VALUES (prov, fin, ser, prof, 90, '2026-02-01');
    RAISE EXCEPTION 'series/profile exclusive CHECK did not fire';
  EXCEPTION WHEN check_violation THEN NULL; END;

  BEGIN
    INSERT INTO alu_kg_prices (provider_id, finish_id, price_per_kg, effective_from) VALUES (prov, fin, -1, '2026-03-01');
    RAISE EXCEPTION 'negative price CHECK did not fire';
  EXCEPTION WHEN check_violation THEN NULL; END;

  INSERT INTO alu_piece_prices (variant_id, price_per_piece, effective_from) VALUES (var, 1200, '2026-01-01');
  INSERT INTO alu_part_prices (part_id, list_price, discount_pct, effective_from) VALUES (partp, 1000, 22, '2026-01-01');

  BEGIN
    INSERT INTO alu_part_prices (part_id, list_price, discount_pct, effective_from) VALUES (partp, 1000, 101, '2026-02-01');
    RAISE EXCEPTION 'discount_pct CHECK did not fire';
  EXCEPTION WHEN check_violation THEN NULL; END;

  BEGIN
    INSERT INTO alu_part_prices (part_id, list_price, effective_from) VALUES (partp, 900, '2026-01-01');
    RAISE EXCEPTION 'part price same-date unique did not fire';
  EXCEPTION WHEN unique_violation THEN NULL; END;

  -- tenant C: nothing visible, cannot write
  SET LOCAL request.jwt.claims = '{"email":"__alu_c__@example.com"}';
  SELECT count(*) INTO n FROM alu_kg_prices;
  IF n <> 0 THEN RAISE EXCEPTION 'tenant C sees kg prices'; END IF;
  BEGIN
    INSERT INTO alu_part_prices (part_id, list_price, effective_from) VALUES (partp, 1, '2026-01-01');
    RAISE EXCEPTION 'tenant C price insert was allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  RESET role;
  RAISE NOTICE 'Test 3 (prices): TEST PASSED';
END $$;
```

- [ ] **Step 3: Run all three migrations + the whole test file in a rolled-back transaction**

```bash
SCRATCH=/private/tmp/claude-501/-Users-plfx-code-FacadeXPM-facadex-app/c6b37346-e3c3-435c-b5ba-380c8b970a05/scratchpad
{ echo 'BEGIN;'; cat supabase/migrations/2026-10-10-01-alu-catalog-hierarchy.sql supabase/migrations/2026-10-10-02-alu-catalog-components.sql supabase/migrations/2026-10-10-03-alu-catalog-prices.sql supabase/tests/alu_catalog_test.sql; echo 'ROLLBACK;'; } > $SCRATCH/alu_t3.sql
npx supabase db query --linked -f $SCRATCH/alu_t3.sql
```

Expected: no `ERROR`; notices for Tests 1, 2, 3 all `TEST PASSED`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/2026-10-10-03-alu-catalog-prices.sql supabase/tests/alu_catalog_test.sql
git commit -m "feat(alu-catalog): kg / piece / part price history tables" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Pure price resolution (`aluPrice.js`)

**Files:**
- Create: `src/lib/aluPrice.js`
- Test: `src/lib/aluPrice.test.js`

**Interfaces:**
- Produces:
  - `pickLatest(rows, asOf, predicate?) → row | null`
  - `resolveKgPrice({ provider, finish, series, profile, asOf, kgPrices }) → { price_per_kg, source: 'profile'|'series'|'provider_finish', row } | null`
  - `findVariant(variants, profileId, finishId, preferLengthM) → variant | null`
  - `resolveAluPrice({ provider, series, profile, finish, variants, asOf, kgPrices, piecePrices }) → { basis:'per_kg', price_per_kg, price_per_m, source } | { basis:'per_piece', price_per_piece, price_per_m, source:'piece', variant_id } | { unresolved:true, reason }` where `reason ∈ 'no_weight'|'no_kg_price'|'no_variant'|'no_piece_price'|'no_price'`
  - `netPrice(listPrice, discountPct) → number`
  - `resolvePartPrice({ partId, asOf, partPrices }) → { list_price, discount_pct, net_price, row } | null`

- [ ] **Step 1: Write the failing tests**

```js
// src/lib/aluPrice.test.js
import { describe, it, expect } from 'vitest'
import { pickLatest, resolveKgPrice, findVariant, resolveAluPrice, netPrice, resolvePartPrice } from './aluPrice.js'

const provider = { id: 'p1', price_basis: 'per_kg' }
const finish = { id: 'f1' }
const series = { id: 's1' }
const profile = { id: 'pr1', linear_weight_kg_per_m: 2.5, default_length_m: 6.4 }
const kg = (over) => ({ provider_id: 'p1', finish_id: 'f1', series_id: null, profile_id: null, price_per_kg: 95, effective_from: '2026-01-01', ...over })

describe('pickLatest', () => {
  const rows = [{ effective_from: '2026-01-01', v: 1 }, { effective_from: '2026-06-01', v: 2 }, { effective_from: '2026-12-01', v: 3 }]
  it('takes the newest row on or before asOf', () => {
    expect(pickLatest(rows, '2026-06-01').v).toBe(2)
    expect(pickLatest(rows, '2026-10-08').v).toBe(2)
  })
  it('ignores rows dated after asOf', () => {
    expect(pickLatest(rows, '2025-12-31')).toBeNull()
  })
  it('applies the predicate and tolerates null rows', () => {
    expect(pickLatest(rows, '2026-12-31', r => r.v < 3).v).toBe(2)
    expect(pickLatest(null, '2026-12-31')).toBeNull()
  })
})

describe('resolveKgPrice', () => {
  it('uses provider x finish when nothing is more specific', () => {
    const r = resolveKgPrice({ provider, finish, series, profile, asOf: '2026-10-08', kgPrices: [kg()] })
    expect(r).toMatchObject({ price_per_kg: 95, source: 'provider_finish' })
  })
  it('prefers a series override, then a profile override', () => {
    const rows = [kg(), kg({ series_id: 's1', price_per_kg: 101 }), kg({ profile_id: 'pr1', price_per_kg: 110 })]
    expect(resolveKgPrice({ provider, finish, series, profile, asOf: '2026-10-08', kgPrices: rows }).source).toBe('profile')
    expect(resolveKgPrice({ provider, finish, series, profile, asOf: '2026-10-08', kgPrices: rows.slice(0, 2) })).toMatchObject({ source: 'series', price_per_kg: 101 })
  })
  it('does not leak another colour, another series or another profile', () => {
    const rows = [kg({ finish_id: 'f2' }), kg({ series_id: 's2', price_per_kg: 1 }), kg({ profile_id: 'other', price_per_kg: 2 })]
    expect(resolveKgPrice({ provider, finish, series, profile, asOf: '2026-10-08', kgPrices: rows })).toBeNull()
  })
  it('follows history by date', () => {
    const rows = [kg(), kg({ price_per_kg: 98, effective_from: '2026-06-01' })]
    expect(resolveKgPrice({ provider, finish, series, profile, asOf: '2026-03-01', kgPrices: rows }).price_per_kg).toBe(95)
    expect(resolveKgPrice({ provider, finish, series, profile, asOf: '2026-07-01', kgPrices: rows }).price_per_kg).toBe(98)
  })
  it('coerces numeric strings', () => {
    expect(resolveKgPrice({ provider, finish, series, profile, asOf: '2026-10-08', kgPrices: [kg({ price_per_kg: '95.5' })] }).price_per_kg).toBe(95.5)
  })
})

describe('findVariant', () => {
  const variants = [
    { id: 'a', profile_id: 'pr1', finish_id: 'f1', length_m: 3 },
    { id: 'b', profile_id: 'pr1', finish_id: 'f1', length_m: 6.4 },
    { id: 'c', profile_id: 'pr1', finish_id: 'f2', length_m: 6.4 },
  ]
  it('prefers the length that matches', () => { expect(findVariant(variants, 'pr1', 'f1', 3).id).toBe('a') })
  it('falls back to the longest', () => { expect(findVariant(variants, 'pr1', 'f1', 5).id).toBe('b') })
  it('returns null when profile and colour never meet', () => { expect(findVariant(variants, 'pr1', 'f9', 6.4)).toBeNull() })
})

describe('resolveAluPrice', () => {
  const piece = (over) => ({ variant_id: 'v1', price_per_piece: 1200, effective_from: '2026-01-01', ...over })
  const variants = [{ id: 'v1', profile_id: 'pr1', finish_id: 'f1', length_m: 6.4 }]

  it('per_kg: price per metre = weight per metre x price per kg', () => {
    const r = resolveAluPrice({ provider, series, profile, finish, variants, asOf: '2026-10-08', kgPrices: [kg()], piecePrices: [] })
    expect(r).toMatchObject({ basis: 'per_kg', price_per_kg: 95, price_per_m: 237.5, source: 'provider_finish' })
  })
  it('per_piece: piece price divided by stock length', () => {
    const r = resolveAluPrice({ provider: { ...provider, price_basis: 'per_piece' }, series, profile, finish, variants, asOf: '2026-10-08', kgPrices: [], piecePrices: [piece()] })
    expect(r).toMatchObject({ basis: 'per_piece', price_per_piece: 1200, price_per_m: 187.5, variant_id: 'v1' })
  })
  it('both: kg wins, piece is the fallback', () => {
    const both = { ...provider, price_basis: 'both' }
    expect(resolveAluPrice({ provider: both, series, profile, finish, variants, asOf: '2026-10-08', kgPrices: [kg()], piecePrices: [piece()] }).basis).toBe('per_kg')
    expect(resolveAluPrice({ provider: both, series, profile, finish, variants, asOf: '2026-10-08', kgPrices: [], piecePrices: [piece()] }).basis).toBe('per_piece')
  })
  it('per_kg provider with only piece prices is unresolved, never silently piece-priced', () => {
    expect(resolveAluPrice({ provider, series, profile, finish, variants, asOf: '2026-10-08', kgPrices: [], piecePrices: [piece()] }))
      .toEqual({ unresolved: true, reason: 'no_kg_price' })
  })
  it('per_kg with a zero or missing weight is unresolved', () => {
    for (const w of [0, null, undefined]) {
      expect(resolveAluPrice({ provider, series, profile: { ...profile, linear_weight_kg_per_m: w }, finish, variants, asOf: '2026-10-08', kgPrices: [kg()], piecePrices: [] }))
        .toEqual({ unresolved: true, reason: 'no_weight' })
    }
  })
  it('per_piece reasons: no variant, then no price', () => {
    const pp = { ...provider, price_basis: 'per_piece' }
    expect(resolveAluPrice({ provider: pp, series, profile, finish, variants: [], asOf: '2026-10-08', kgPrices: [], piecePrices: [] })).toEqual({ unresolved: true, reason: 'no_variant' })
    expect(resolveAluPrice({ provider: pp, series, profile, finish, variants, asOf: '2026-10-08', kgPrices: [], piecePrices: [] })).toEqual({ unresolved: true, reason: 'no_piece_price' })
  })
  it('both with nothing priced is "no_price"', () => {
    expect(resolveAluPrice({ provider: { ...provider, price_basis: 'both' }, series, profile, finish, variants, asOf: '2026-10-08', kgPrices: [], piecePrices: [] }))
      .toEqual({ unresolved: true, reason: 'no_price' })
  })
  it('a price that starts after asOf does not apply', () => {
    expect(resolveAluPrice({ provider, series, profile, finish, variants, asOf: '2025-12-31', kgPrices: [kg()], piecePrices: [] }).unresolved).toBe(true)
  })
})

describe('part prices', () => {
  it('netPrice applies the discount percentage', () => {
    expect(netPrice(1000, 22)).toBeCloseTo(780, 6)
    expect(netPrice(1000)).toBe(1000)
  })
  it('resolvePartPrice returns list, discount and net for the latest row', () => {
    const rows = [
      { part_id: 'x', list_price: 900, discount_pct: 0, effective_from: '2026-01-01' },
      { part_id: 'x', list_price: 1000, discount_pct: 22, effective_from: '2026-06-01' },
      { part_id: 'y', list_price: 5, discount_pct: 0, effective_from: '2026-07-01' },
    ]
    const r = resolvePartPrice({ partId: 'x', asOf: '2026-10-08', partPrices: rows })
    expect(r).toMatchObject({ list_price: 1000, discount_pct: 22 })
    expect(r.net_price).toBeCloseTo(780, 6)
    expect(resolvePartPrice({ partId: 'x', asOf: '2025-01-01', partPrices: rows })).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/aluPrice.test.js`
Expected: FAIL (cannot resolve `./aluPrice.js`).

- [ ] **Step 3: Implement**

```js
// src/lib/aluPrice.js
// ============================================================
// Pure price resolution for the aluminium cost catalog. No I/O: callers load
// the catalog tables once and pass the rows in. asOf and effective_from are
// 'YYYY-MM-DD' strings, which compare correctly as plain strings.
// Spec: docs/superpowers/specs/2026-10-08-aluminium-cost-catalog-design.md
// (Prices; Decision 7).
// ============================================================

export function pickLatest(rows, asOf, predicate = () => true) {
  let best = null
  for (const r of rows || []) {
    if (!predicate(r) || r.effective_from > asOf) continue
    if (!best || r.effective_from > best.effective_from) best = r
  }
  return best
}

// Precedence is by specificity (profile > series > provider x colour);
// inside one level the newest row on or before asOf wins.
export function resolveKgPrice({ provider, finish, series, profile, asOf, kgPrices }) {
  const base = r => r.provider_id === provider.id && r.finish_id === finish.id
  const levels = [
    ['profile', profile && (r => base(r) && r.profile_id === profile.id)],
    ['series', series && (r => base(r) && r.series_id === series.id && !r.profile_id)],
    ['provider_finish', r => base(r) && !r.series_id && !r.profile_id],
  ]
  for (const [source, predicate] of levels) {
    if (!predicate) continue
    const row = pickLatest(kgPrices, asOf, predicate)
    if (row) return { price_per_kg: Number(row.price_per_kg), source, row }
  }
  return null
}

// A profile in a colour can be sold in several stock lengths; take the one
// that matches the profile's standard length, else the longest.
export function findVariant(variants, profileId, finishId, preferLengthM) {
  const candidates = (variants || []).filter(v => v.profile_id === profileId && v.finish_id === finishId)
  if (!candidates.length) return null
  const exact = preferLengthM != null ? candidates.find(v => Number(v.length_m) === Number(preferLengthM)) : null
  return exact || [...candidates].sort((a, b) => Number(b.length_m) - Number(a.length_m))[0]
}

export function resolveAluPrice({ provider, series, profile, finish, variants, asOf, kgPrices, piecePrices }) {
  const basis = provider.price_basis
  const triedKg = basis !== 'per_piece'
  const triedPiece = basis !== 'per_kg'

  if (triedKg) {
    const weight = Number(profile.linear_weight_kg_per_m)
    if (!(weight > 0)) return { unresolved: true, reason: 'no_weight' }
    const kg = resolveKgPrice({ provider, finish, series, profile, asOf, kgPrices })
    if (kg) {
      return { basis: 'per_kg', price_per_kg: kg.price_per_kg, price_per_m: kg.price_per_kg * weight, source: kg.source }
    }
  }

  if (triedPiece) {
    const variant = findVariant(variants, profile.id, finish.id, profile.default_length_m)
    if (!variant) return { unresolved: true, reason: basis === 'both' ? 'no_price' : 'no_variant' }
    const row = pickLatest(piecePrices, asOf, r => r.variant_id === variant.id)
    if (!row) return { unresolved: true, reason: basis === 'both' ? 'no_price' : 'no_piece_price' }
    const perPiece = Number(row.price_per_piece)
    return { basis: 'per_piece', price_per_piece: perPiece, price_per_m: perPiece / Number(variant.length_m), source: 'piece', variant_id: variant.id }
  }

  return { unresolved: true, reason: 'no_kg_price' }
}

export function netPrice(listPrice, discountPct = 0) {
  return Number(listPrice) * (1 - Number(discountPct || 0) / 100)
}

export function resolvePartPrice({ partId, asOf, partPrices }) {
  const row = pickLatest(partPrices, asOf, r => r.part_id === partId)
  if (!row) return null
  return { list_price: Number(row.list_price), discount_pct: Number(row.discount_pct), net_price: netPrice(row.list_price, row.discount_pct), row }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/aluPrice.test.js`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/aluPrice.js src/lib/aluPrice.test.js
git commit -m "feat(alu-catalog): pure price resolution with history and precedence" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Labels and form helpers

**Files:**
- Create: `src/lib/aluCatalog.js`, `src/lib/catalogForm.js`
- Test: `src/lib/aluCatalog.test.js`, `src/lib/catalogForm.test.js`

**Interfaces:**
- Produces (`aluCatalog.js`): `seriesLabelFull(series, provider) → string` ("ชื่อซีรีส์ · ชื่อโรงรีด"), `seriesLabelShort(series, provider) → string` ("ชื่อซีรีส์ (ชื่อย่อ)").
- Produces (`catalogForm.js`): a **field** is `{ key, label, type: 'text'|'number'|'date'|'select'|'checkbox', required?, default?, options?: array | (form)=>array, step?, min?, placeholder?, hint? }`; option = `{ value, label }`.
  - `emptyForm(fields, defaults?) → form`
  - `formFromRow(fields, row) → form`
  - `buildPayload(fields, form) → payload`
  - `missingRequired(fields, form) → string[]` (labels)
  - `resolveOptions(field, form) → option[]`
  - `optionList(rows, labelFn, keepId?) → option[]` (active rows only, plus the row whose id is `keepId`)
  - `friendlyDbError(error) → string`

- [ ] **Step 1: Write the failing tests**

```js
// src/lib/aluCatalog.test.js
import { describe, it, expect } from 'vitest'
import { seriesLabelFull, seriesLabelShort } from './aluCatalog.js'

const provider = { name: 'ไทยยูนิค', short_name: 'TYK' }
describe('series labels', () => {
  it('full label puts the owner after the series name', () => {
    expect(seriesLabelFull({ name: 'กล่องร่อง' }, provider)).toBe('กล่องร่อง · ไทยยูนิค')
  })
  it('short label uses the owner short name', () => {
    expect(seriesLabelShort({ name: 'กล่องร่อง' }, provider)).toBe('กล่องร่อง (TYK)')
  })
  it('falls back to the bare series name when the provider is unknown', () => {
    expect(seriesLabelFull({ name: 'กล่องร่อง' }, undefined)).toBe('กล่องร่อง')
    expect(seriesLabelShort({ name: 'กล่องร่อง' }, { name: 'X', short_name: '' })).toBe('กล่องร่อง')
  })
})
```

```js
// src/lib/catalogForm.test.js
import { describe, it, expect } from 'vitest'
import { emptyForm, formFromRow, buildPayload, missingRequired, resolveOptions, optionList, friendlyDbError } from './catalogForm.js'

const fields = [
  { key: 'name', label: 'ชื่อ', type: 'text', required: true },
  { key: 'weight', label: 'น้ำหนัก', type: 'number' },
  { key: 'kind', label: 'ชนิด', type: 'select', options: [{ value: 'a', label: 'A' }] },
  { key: 'effective_from', label: 'วันที่', type: 'date', required: true },
  { key: 'active', label: 'ใช้งาน', type: 'checkbox', default: true },
]

describe('emptyForm / formFromRow', () => {
  it('starts blank with checkbox defaults', () => {
    expect(emptyForm(fields)).toEqual({ name: '', weight: '', kind: '', effective_from: '', active: true })
  })
  it('lets the caller pre-fill', () => {
    expect(emptyForm(fields, { kind: 'a' }).kind).toBe('a')
  })
  it('turns null columns into empty inputs and keeps 0', () => {
    expect(formFromRow(fields, { name: 'x', weight: 0, kind: null, effective_from: '2026-01-01', active: false }))
      .toEqual({ name: 'x', weight: 0, kind: '', effective_from: '2026-01-01', active: false })
  })
})

describe('buildPayload', () => {
  it('trims text, nulls blanks, parses numbers, keeps booleans', () => {
    expect(buildPayload(fields, { name: '  กล่องร่อง ', weight: '0.85', kind: '', effective_from: '2026-01-01', active: true }))
      .toEqual({ name: 'กล่องร่อง', weight: 0.85, kind: null, effective_from: '2026-01-01', active: true })
  })
  it('an empty number becomes null, a typed 0 stays 0', () => {
    expect(buildPayload(fields, { name: 'x', weight: '', kind: '', effective_from: 'd', active: false }).weight).toBeNull()
    expect(buildPayload(fields, { name: 'x', weight: '0', kind: '', effective_from: 'd', active: false }).weight).toBe(0)
  })
})

describe('missingRequired', () => {
  it('lists labels of blank required fields', () => {
    expect(missingRequired(fields, { name: ' ', weight: '', kind: '', effective_from: '', active: true })).toEqual(['ชื่อ', 'วันที่'])
  })
  it('is empty when everything required is present', () => {
    expect(missingRequired(fields, { name: 'x', effective_from: '2026-01-01' })).toEqual([])
  })
})

describe('resolveOptions', () => {
  it('accepts an array or a function of the form', () => {
    expect(resolveOptions({ options: [{ value: 1, label: 'one' }] }, {})).toEqual([{ value: 1, label: 'one' }])
    expect(resolveOptions({ options: f => [{ value: f.p, label: 'dyn' }] }, { p: 'z' })).toEqual([{ value: 'z', label: 'dyn' }])
    expect(resolveOptions({}, {})).toEqual([])
  })
})

describe('optionList', () => {
  const rows = [{ id: '1', name: 'A', active: true }, { id: '2', name: 'B', active: false }, { id: '3', name: 'C' }]
  it('hides inactive rows from pickers', () => {
    expect(optionList(rows, r => r.name)).toEqual([{ value: '1', label: 'A' }, { value: '3', label: 'C' }])
  })
  it('still shows an inactive row that the edited record points at', () => {
    expect(optionList(rows, r => r.name, '2').map(o => o.value)).toEqual(['1', '2', '3'])
  })
})

describe('friendlyDbError', () => {
  it('explains duplicates, blocked deletes and bad values in Thai', () => {
    expect(friendlyDbError({ code: '23505', message: 'duplicate key' })).toMatch(/ซ้ำ/)
    expect(friendlyDbError({ code: '23503', message: 'fk' })).toMatch(/ผูกอยู่/)
    expect(friendlyDbError({ code: '23514', message: 'check' })).toMatch(/ไม่ถูกต้อง/)
    expect(friendlyDbError({ code: '42501', message: 'rls' })).toMatch(/สิทธิ์/)
  })
  it('falls back to the raw message', () => {
    expect(friendlyDbError({ message: 'boom' })).toBe('boom')
    expect(friendlyDbError(null)).toBe('เกิดข้อผิดพลาด')
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/lib/aluCatalog.test.js src/lib/catalogForm.test.js`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement**

```js
// src/lib/aluCatalog.js
// Labels for a series. The full form is used where a default is picked,
// the short form inside a row where the owner is already clear.
export function seriesLabelFull(series, provider) {
  return provider?.name ? `${series.name} · ${provider.name}` : series.name
}

export function seriesLabelShort(series, provider) {
  return provider?.short_name ? `${series.name} (${provider.short_name})` : series.name
}
```

```js
// src/lib/catalogForm.js
// Pure helpers behind CatalogCrud: form <-> payload conversion, option lists
// and readable database errors.

const isBlank = v => v === '' || v == null || (typeof v === 'string' && v.trim() === '')

export function emptyForm(fields, defaults = {}) {
  const form = {}
  for (const f of fields) {
    if (f.key in defaults) form[f.key] = defaults[f.key]
    else if (f.default !== undefined) form[f.key] = f.default
    else form[f.key] = f.type === 'checkbox' ? false : ''
  }
  return form
}

export function formFromRow(fields, row) {
  const form = {}
  for (const f of fields) {
    const v = row[f.key]
    form[f.key] = f.type === 'checkbox' ? !!v : (v == null ? '' : v)
  }
  return form
}

export function buildPayload(fields, form) {
  const payload = {}
  for (const f of fields) {
    const v = form[f.key]
    if (f.type === 'checkbox') payload[f.key] = !!v
    else if (f.type === 'number') payload[f.key] = isBlank(v) ? null : parseFloat(v)
    else payload[f.key] = isBlank(v) ? null : (typeof v === 'string' ? v.trim() : v)
  }
  return payload
}

export function missingRequired(fields, form) {
  return fields.filter(f => f.required && f.type !== 'checkbox' && isBlank(form[f.key])).map(f => f.label)
}

export function resolveOptions(field, form) {
  const o = field.options
  if (!o) return []
  return typeof o === 'function' ? o(form) : o
}

// Pickers offer active rows only, but editing an old record must still show
// the (now inactive) row it points at.
export function optionList(rows, labelFn, keepId = null) {
  return (rows || [])
    .filter(r => r.active !== false || r.id === keepId)
    .map(r => ({ value: r.id, label: labelFn(r) }))
}

export function friendlyDbError(error) {
  if (!error) return 'เกิดข้อผิดพลาด'
  switch (error.code) {
    case '23505': return 'มีข้อมูลนี้อยู่แล้ว (ซ้ำ) เช่น ชื่อเดียวกัน หรือราคาของวันที่เดียวกัน'
    case '23503': return 'ทำรายการไม่ได้ เพราะมีข้อมูลอื่นผูกอยู่'
    case '23514': return 'ค่าที่กรอกไม่ถูกต้อง (เช่น ติดลบ หรือเกินช่วงที่กำหนด)'
    case '42501': return 'ไม่มีสิทธิ์ทำรายการนี้'
    default: return error.message || 'เกิดข้อผิดพลาด'
  }
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/lib/aluCatalog.test.js src/lib/catalogForm.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/aluCatalog.js src/lib/aluCatalog.test.js src/lib/catalogForm.js src/lib/catalogForm.test.js
git commit -m "feat(alu-catalog): series labels and catalog form helpers" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Data loading, generic CRUD and link components

**Files:**
- Create: `src/lib/catalogData.js`, `src/hooks/useAluCatalog.js`, `src/components/CatalogCrud.jsx`, `src/components/LinkEditor.jsx`
- Test: `src/lib/catalogData.test.js`

**Interfaces:**
- Consumes: `fetchAllRows` (`src/lib/fetchAllRows.js`), `useQuery` (`src/hooks/useSupabase.js`, returns `{ data, loading, error, refetch }`), `Modal`/`ConfirmDialog` (`src/components/Modal.jsx`), helpers from Task 5.
- Produces:
  - `fetchCatalogRows(client, table, orderBy?, ascending?) → Promise<row[]>`
  - `useCatalogTable(table, orderBy?, ascending?) → { data, loading, error, refetch }`
  - `<CatalogCrud title table fields columns rows onChanged canEdit scope? addLabel? emptyText? validate? rowActions? />` where `columns = [{ key, label, render?(row) }]`, `scope` = columns merged into inserts (e.g. `{ provider_id }`), `validate(form) → string|null`, `rowActions(row) → JSX`. Also exports `ActiveBadge`.
  - `<LinkEditor title hint linkTable parentKey parentId childKey childOptions links onChanged canEdit extra? />` where `extra = { key, label, type: 'text'|'number'|'select', options?, defaultFor?(child) }`, `childOptions = [{ id, label }]`, `links` = all rows of the link table.

- [ ] **Step 1: Write the failing test**

```js
// src/lib/catalogData.test.js
import { describe, it, expect } from 'vitest'
import { fetchCatalogRows } from './catalogData.js'

function fakeClient(total) {
  const rows = Array.from({ length: total }, (_, i) => ({ id: String(i) }))
  const orders = []
  return {
    orders,
    from() {
      const q = {
        select() { return q },
        order(col, opts) { orders.push([col, opts]); return q },
        range(a, b) { return Promise.resolve({ data: rows.slice(a, b + 1), error: null }) },
      }
      return q
    },
  }
}

describe('fetchCatalogRows', () => {
  it('returns every row past the 1000-row response cap', async () => {
    const rows = await fetchCatalogRows(fakeClient(1005), 'alu_kg_prices', 'effective_from', false)
    expect(rows).toHaveLength(1005)
  })
  it('orders by the requested column with id as a stable tie-breaker', async () => {
    const client = fakeClient(3)
    await fetchCatalogRows(client, 'alu_series', 'name')
    expect(client.orders).toContainEqual(['name', { ascending: true }])
    expect(client.orders.some(([col]) => col === 'id')).toBe(true)
  })
  it('surfaces a database error', async () => {
    const client = { from: () => ({ select() { return this }, order() { return this }, range: () => Promise.resolve({ data: null, error: new Error('boom') }) }) }
    await expect(fetchCatalogRows(client, 'alu_series')).rejects.toThrow('boom')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/catalogData.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the data layer**

```js
// src/lib/catalogData.js
// Reads every row of a catalog table. PostgREST caps one response at 1000
// rows and price history only grows, so page through with a stable order.
import { fetchAllRows } from './fetchAllRows.js'

export function fetchCatalogRows(client, table, orderBy = 'name', ascending = true) {
  return fetchAllRows(() => client.from(table).select('*').order(orderBy, { ascending }).order('id'))
}
```

```js
// src/hooks/useAluCatalog.js
import { supabase } from '../lib/supabase.js'
import { fetchCatalogRows } from '../lib/catalogData.js'
import { useQuery } from './useSupabase.js'

export function useCatalogTable(table, orderBy = 'name', ascending = true) {
  return useQuery(() => fetchCatalogRows(supabase, table, orderBy, ascending), [table, orderBy, ascending])
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run src/lib/catalogData.test.js`
Expected: PASS.

- [ ] **Step 5: Write `CatalogCrud.jsx`**

```jsx
// src/components/CatalogCrud.jsx
// ============================================================
// Generic list + add/edit/delete modal for one flat catalog table. The
// aluminium catalog tabs are mostly configuration of this component.
// Pure form logic lives in lib/catalogForm.js (tested); this file is the
// view, in the same style as AluminumProfiles.jsx.
// ============================================================
import { useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { Modal, ConfirmDialog } from './Modal.jsx'
import { emptyForm, formFromRow, buildPayload, missingRequired, resolveOptions, friendlyDbError } from '../lib/catalogForm.js'

export function ActiveBadge({ active }) {
  return active
    ? <span className="badge badge-paid">ใช้งานอยู่</span>
    : <span className="badge badge-finished">ปิดใช้งาน</span>
}

function CrudForm({ fields, initial, onSave, onCancel, loading }) {
  const [form, setForm] = useState(initial)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const renderInput = (f) => {
    if (f.type === 'checkbox') {
      return (
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
          <input type="checkbox" checked={!!form[f.key]} onChange={e => set(f.key, e.target.checked)} />
          {f.label}
        </label>
      )
    }
    if (f.type === 'select') {
      return (
        <select className="input" required={f.required} value={form[f.key]} onChange={e => set(f.key, e.target.value)}>
          <option value="">{f.required ? '— เลือก —' : '—'}</option>
          {resolveOptions(f, form).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      )
    }
    return (
      <input
        className="input" required={f.required}
        type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'}
        step={f.type === 'number' ? (f.step || 'any') : undefined} min={f.min}
        placeholder={f.placeholder} value={form[f.key]} onChange={e => set(f.key, e.target.value)}
      />
    )
  }

  return (
    <form onSubmit={e => { e.preventDefault(); onSave(form) }}>
      <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
        {fields.map(f => (
          <div key={f.key}>
            {f.type !== 'checkbox' && <label className="label">{f.label}{f.required ? ' ★' : ''}</label>}
            {renderInput(f)}
            {f.hint && <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 4 }}>{f.hint}</div>}
          </div>
        ))}
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>ยกเลิก</button>
        <button type="submit" className="btn btn-primary" disabled={loading}>{loading ? '⏳ กำลังบันทึก...' : '✅ บันทึก'}</button>
      </div>
    </form>
  )
}

export default function CatalogCrud({
  title, table, fields, columns, rows, onChanged, canEdit,
  scope = {}, addLabel = '+ เพิ่ม', emptyText = 'ยังไม่มีข้อมูล', validate, rowActions,
}) {
  const [editing, setEditing] = useState(null)   // null | 'new' | row
  const [deleteId, setDeleteId] = useState(null)
  const [saving, setSaving] = useState(false)

  const close = () => setEditing(null)

  const handleSave = async (form) => {
    const missing = missingRequired(fields, form)
    if (missing.length) { alert('กรุณากรอก: ' + missing.join(', ')); return }
    const problem = validate ? validate(form) : null
    if (problem) { alert(problem); return }
    setSaving(true)
    try {
      const payload = buildPayload(fields, form)
      if (editing === 'new') {
        const { error } = await supabase.from(table).insert({ ...payload, ...scope })
        if (error) throw error
      } else {
        const { error } = await supabase.from(table).update(payload).eq('id', editing.id)
        if (error) throw error
      }
      close(); onChanged()
    } catch (e) { alert('บันทึกไม่สำเร็จ: ' + friendlyDbError(e)) }
    finally { setSaving(false) }
  }

  const handleDelete = async () => {
    const { error } = await supabase.from(table).delete().eq('id', deleteId)
    if (error) { alert('ลบไม่สำเร็จ: ' + friendlyDbError(error)); return }
    setDeleteId(null); onChanged()
  }

  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
        <h3 style={{ margin: 0, fontSize: 15 }}>{title}</h3>
        {canEdit && <button className="btn btn-sm btn-primary" onClick={() => setEditing('new')}>{addLabel}</button>}
      </div>
      <div className="card">
        <div className="table-wrap">
          <table>
            <thead><tr>{columns.map(c => <th key={c.key}>{c.label}</th>)}<th></th></tr></thead>
            <tbody>
              {(rows || []).map(row => (
                <tr key={row.id}>
                  {columns.map(c => <td key={c.key}>{c.render ? c.render(row) : (row[c.key] ?? '—')}</td>)}
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {rowActions && rowActions(row)}
                    {canEdit && (
                      <>
                        <button className="btn btn-sm btn-ghost" onClick={() => setEditing(row)}>แก้ไข</button>
                        <button className="btn btn-sm btn-ghost" style={{ color: 'var(--red)' }} onClick={() => setDeleteId(row.id)}>ลบ</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
              {!(rows || []).length && <tr><td colSpan={columns.length + 1} style={{ textAlign: 'center', color: 'var(--text3)', padding: 24 }}>{emptyText}</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {editing && (
        <Modal title={editing === 'new' ? `${addLabel.replace('+ ', '')}` : 'แก้ไขข้อมูล'} onClose={close} maxWidth={480}>
          <CrudForm
            fields={fields} loading={saving} onSave={handleSave} onCancel={close}
            initial={editing === 'new' ? emptyForm(fields, scope) : formFromRow(fields, editing)}
          />
        </Modal>
      )}
      {deleteId && (
        <ConfirmDialog title="ลบข้อมูล" message="ยืนยันการลบ? (ถ้ามีข้อมูลอื่นผูกอยู่ การลบจะไม่สำเร็จ)" onConfirm={handleDelete} onCancel={() => setDeleteId(null)} />
      )}
    </div>
  )
}
```

- [ ] **Step 6: Write `LinkEditor.jsx`**

```jsx
// src/components/LinkEditor.jsx
// ============================================================
// Many-to-many editor: one checkbox per candidate child for a chosen
// parent, backed by a link table. An optional "extra" column on the link
// row (a role name, a quantity, a type) is edited inline once linked.
// ============================================================
import { useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { friendlyDbError } from '../lib/catalogForm.js'

function ExtraInput({ extra, link, canEdit, onSaved }) {
  const [value, setValue] = useState(link[extra.key] ?? '')
  const save = async (next) => {
    const parsed = extra.type === 'number'
      ? (next === '' ? null : parseFloat(next))
      : (next === '' ? null : next)
    if (parsed === (link[extra.key] ?? null)) return
    const { error } = await supabase.from(extra.table).update({ [extra.key]: parsed }).eq('id', link.id)
    if (error) { alert('บันทึกไม่สำเร็จ: ' + friendlyDbError(error)); setValue(link[extra.key] ?? ''); return }
    onSaved()
  }
  if (extra.type === 'select') {
    return (
      <select className="input input-sm" style={{ width: 160 }} disabled={!canEdit} value={value}
        onChange={e => { setValue(e.target.value); save(e.target.value) }}>
        <option value="">{extra.emptyLabel || '—'}</option>
        {(extra.options || []).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    )
  }
  return (
    <input className="input input-sm" style={{ width: 140 }} disabled={!canEdit}
      type={extra.type === 'number' ? 'number' : 'text'} step={extra.type === 'number' ? 'any' : undefined}
      placeholder={extra.label} value={value}
      onChange={e => setValue(e.target.value)} onBlur={e => save(e.target.value)} />
  )
}

export default function LinkEditor({ title, hint, linkTable, parentKey, parentId, childKey, childOptions, links, onChanged, canEdit, extra = null }) {
  const mine = (links || []).filter(l => l[parentKey] === parentId)
  const linkFor = (childId) => mine.find(l => l[childKey] === childId)
  const extraWithTable = extra ? { ...extra, table: linkTable } : null

  const toggle = async (child) => {
    const existing = linkFor(child.id)
    if (existing) {
      const { error } = await supabase.from(linkTable).delete().eq('id', existing.id)
      if (error) { alert('ลบไม่สำเร็จ: ' + friendlyDbError(error)); return }
    } else {
      const row = { [parentKey]: parentId, [childKey]: child.id }
      if (extra && extra.defaultFor) row[extra.key] = extra.defaultFor(child)
      const { error } = await supabase.from(linkTable).insert(row)
      if (error) { alert('บันทึกไม่สำเร็จ: ' + friendlyDbError(error)); return }
    }
    onChanged()
  }

  return (
    <div className="card" style={{ padding: 14, marginBottom: 16 }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{title}</div>
      {hint && <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 10 }}>{hint}</div>}
      {!(childOptions || []).length && <div style={{ color: 'var(--text3)' }}>ยังไม่มีรายการให้เลือก</div>}
      <div style={{ display: 'grid', gap: 6 }}>
        {(childOptions || []).map(child => {
          const link = linkFor(child.id)
          return (
            <div key={child.id} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: canEdit ? 'pointer' : 'default', minWidth: 220 }}>
                <input type="checkbox" disabled={!canEdit} checked={!!link} onChange={() => toggle(child)} />
                {child.label}
              </label>
              {link && extraWithTable && <ExtraInput key={link.id + String(link[extra.key])} extra={extraWithTable} link={link} canEdit={canEdit} onSaved={onChanged} />}
            </div>
          )
        })}
      </div>
    </div>
  )
}
```

- [ ] **Step 7: Build to confirm the components compile**

Run: `npm run build`
Expected: build succeeds (the components are not imported yet, so also run `npx vitest run` and expect all tests PASS).

- [ ] **Step 8: Commit**

```bash
git add src/lib/catalogData.js src/lib/catalogData.test.js src/hooks/useAluCatalog.js src/components/CatalogCrud.jsx src/components/LinkEditor.jsx
git commit -m "feat(alu-catalog): paged catalog reads, generic CRUD and link editor" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Page shell, navigation, hierarchy and type tabs

**Files:**
- Create: `src/pages/AluCatalog.jsx`, `src/pages/aluCatalog/HierarchyTab.jsx`, `src/pages/aluCatalog/TypesTab.jsx`
- Modify: `src/App.jsx` (lazy import near line 51; nav entry near line 82; route near line 404)

**Interfaces:**
- Consumes: `useCatalogTable`, `CatalogCrud`/`ActiveBadge`, `LinkEditor`, `optionList`, `seriesLabelFull`, `useUserRole` (`{ isAtLeast, role }`), `canEditPage(role, 'estimation')`.
- Produces: default exports `AluCatalog` (page), `HierarchyTab({ canEdit })`, `TypesTab({ canEdit })`. Tabs added in Tasks 8–10 are imported into `AluCatalog.jsx` by those tasks.

- [ ] **Step 1: Write the hierarchy tab**

```jsx
// src/pages/aluCatalog/HierarchyTab.jsx
// Extruders (โรงรีด), their series (ซีรีส์), and which door/window types each series offers.
import { useState } from 'react'
import { useCatalogTable } from '../../hooks/useAluCatalog.js'
import CatalogCrud, { ActiveBadge } from '../../components/CatalogCrud.jsx'
import LinkEditor from '../../components/LinkEditor.jsx'
import { optionList } from '../../lib/catalogForm.js'
import { seriesLabelFull } from '../../lib/aluCatalog.js'

const BASIS_LABEL = { per_kg: 'ต่อกก.', per_piece: 'ต่อเส้น', both: 'ทั้งสองแบบ' }

const PROVIDER_FIELDS = [
  { key: 'name', label: 'ชื่อโรงรีด', type: 'text', required: true },
  { key: 'short_name', label: 'ชื่อย่อ (ใช้ต่อท้ายชื่อซีรีส์ในรายการ)', type: 'text', required: true },
  { key: 'price_basis', label: 'คิดราคาแบบ', type: 'select', required: true, default: 'per_kg',
    options: [{ value: 'per_kg', label: 'ต่อกก.' }, { value: 'per_piece', label: 'ต่อเส้น' }, { value: 'both', label: 'ทั้งสองแบบ' }] },
  { key: 'active', label: 'ใช้งานอยู่', type: 'checkbox', default: true },
]

const SERIES_FIELDS = [
  { key: 'name', label: 'ชื่อซีรีส์', type: 'text', required: true },
  { key: 'is_base', label: 'ซีรีส์พื้นฐานของโรงรีด (เช่น กล่องร่อง กล่องเรียบ)', type: 'checkbox', default: false },
  { key: 'active', label: 'ใช้งานอยู่', type: 'checkbox', default: true },
]

export default function HierarchyTab({ canEdit }) {
  const providers = useCatalogTable('alu_providers')
  const series = useCatalogTable('alu_series')
  const types = useCatalogTable('door_window_types')
  const seriesTypes = useCatalogTable('alu_series_types', 'id')
  const [providerId, setProviderId] = useState('')
  const [seriesId, setSeriesId] = useState('')

  const providerById = Object.fromEntries((providers.data || []).map(p => [p.id, p]))
  const seriesOfProvider = (series.data || []).filter(s => s.provider_id === providerId)
  const pickedSeries = (series.data || []).find(s => s.id === seriesId)

  const error = providers.error || series.error || types.error || seriesTypes.error
  if (error) return <div style={{ color: 'var(--red)' }}>โหลดข้อมูลไม่สำเร็จ: {error}</div>

  return (
    <div>
      <CatalogCrud
        title="🏭 โรงรีด" table="alu_providers" fields={PROVIDER_FIELDS} rows={providers.data}
        onChanged={providers.refetch} canEdit={canEdit} addLabel="+ เพิ่มโรงรีด" emptyText="ยังไม่มีโรงรีด"
        columns={[
          { key: 'name', label: 'ชื่อ', render: r => <strong>{r.name}</strong> },
          { key: 'short_name', label: 'ชื่อย่อ' },
          { key: 'price_basis', label: 'คิดราคา', render: r => BASIS_LABEL[r.price_basis] },
          { key: 'active', label: 'สถานะ', render: r => <ActiveBadge active={r.active} /> },
        ]}
      />

      <div style={{ marginBottom: 12 }}>
        <label className="label">เลือกโรงรีดเพื่อจัดการซีรีส์</label>
        <select className="input" style={{ maxWidth: 320 }} value={providerId} onChange={e => { setProviderId(e.target.value); setSeriesId('') }}>
          <option value="">— เลือกโรงรีด —</option>
          {optionList(providers.data, p => p.name, providerId).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>

      {providerId && (
        <>
          <CatalogCrud
            title="📚 ซีรีส์" table="alu_series" fields={SERIES_FIELDS} rows={seriesOfProvider}
            scope={{ provider_id: providerId }} onChanged={series.refetch} canEdit={canEdit}
            addLabel="+ เพิ่มซีรีส์" emptyText="โรงรีดนี้ยังไม่มีซีรีส์"
            columns={[
              { key: 'name', label: 'ซีรีส์', render: r => <strong>{seriesLabelFull(r, providerById[r.provider_id])}</strong> },
              { key: 'is_base', label: 'พื้นฐาน', render: r => (r.is_base ? '✓' : '') },
              { key: 'active', label: 'สถานะ', render: r => <ActiveBadge active={r.active} /> },
            ]}
            rowActions={r => <button className="btn btn-sm btn-ghost" onClick={() => setSeriesId(r.id)}>ประเภทบาน</button>}
          />
          {pickedSeries && (
            <LinkEditor
              title={`ประเภทบานที่ซีรีส์ ${seriesLabelFull(pickedSeries, providerById[pickedSeries.provider_id])} มี`}
              hint="ซีรีส์ที่ไม่มีประเภทใด (เช่น ไม่มีประตูพับ) ให้ไม่ติ๊ก ระบบจะเตือนเมื่อเลือกประเภทที่ซีรีส์ไม่มี"
              linkTable="alu_series_types" parentKey="series_id" parentId={pickedSeries.id} childKey="type_id"
              childOptions={optionList(types.data, t => t.name).map(o => ({ id: o.value, label: o.label }))}
              links={seriesTypes.data} onChanged={seriesTypes.refetch} canEdit={canEdit}
            />
          )}
        </>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Write the types tab**

```jsx
// src/pages/aluCatalog/TypesTab.jsx
// Door/window types shared by every extruder (บานเลื่อน บานเปิด …) and their default labour rate.
import { useCatalogTable } from '../../hooks/useAluCatalog.js'
import CatalogCrud, { ActiveBadge } from '../../components/CatalogCrud.jsx'

const FIELDS = [
  { key: 'name', label: 'ชื่อประเภท', type: 'text', required: true, placeholder: 'เช่น บานเลื่อน' },
  { key: 'category', label: 'ประเภทหลัก', type: 'select', required: true, default: 'window',
    options: [{ value: 'door', label: 'ประตู' }, { value: 'window', label: 'หน้าต่าง' }] },
  { key: 'default_labour_per_sqm', label: 'ค่าแรงตั้งต้น (บาท/ตร.ม.)', type: 'number', min: 0,
    hint: 'ใช้เมื่อโปรเจกต์และรายการไม่ได้กำหนดค่าแรงเอง' },
  { key: 'active', label: 'ใช้งานอยู่', type: 'checkbox', default: true },
]

export default function TypesTab({ canEdit }) {
  const types = useCatalogTable('door_window_types')
  if (types.error) return <div style={{ color: 'var(--red)' }}>โหลดข้อมูลไม่สำเร็จ: {types.error}</div>
  return (
    <CatalogCrud
      title="🚪 ประเภทบาน" table="door_window_types" fields={FIELDS} rows={types.data}
      onChanged={types.refetch} canEdit={canEdit} addLabel="+ เพิ่มประเภท" emptyText="ยังไม่มีประเภทบาน"
      columns={[
        { key: 'name', label: 'ชื่อ', render: r => <strong>{r.name}</strong> },
        { key: 'category', label: 'ประเภทหลัก', render: r => (r.category === 'door' ? 'ประตู' : 'หน้าต่าง') },
        { key: 'default_labour_per_sqm', label: 'ค่าแรง/ตร.ม.' },
        { key: 'active', label: 'สถานะ', render: r => <ActiveBadge active={r.active} /> },
      ]}
    />
  )
}
```

- [ ] **Step 3: Write the page shell**

```jsx
// src/pages/AluCatalog.jsx
// ============================================================
// แคตตาล็อกอลูมิเนียม -- the extruder -> series -> type -> component cost
// database behind the estimation module (FacadeX only). Phase 1 of
// docs/superpowers/specs/2026-10-08-aluminium-cost-catalog-design.md.
// ============================================================
import { useState } from 'react'
import { useUserRole } from '../hooks/useUserRole.js'
import { canEditPage } from '../lib/permissions.js'
import HierarchyTab from './aluCatalog/HierarchyTab.jsx'
import TypesTab from './aluCatalog/TypesTab.jsx'

const TABS = [
  { id: 'hierarchy', label: '🏭 โรงรีด · ซีรีส์' },
  { id: 'types',     label: '🚪 ประเภทบาน' },
]

export default function AluCatalog() {
  const { isAtLeast, role } = useUserRole()
  const canEdit = isAtLeast('ADMIN') && canEditPage(role, 'estimation')
  const [tab, setTab] = useState('hierarchy')

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        {TABS.map(t => (
          <button key={t.id} className={`btn btn-sm ${tab === t.id ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>
      {tab === 'hierarchy' && <HierarchyTab canEdit={canEdit} />}
      {tab === 'types' && <TypesTab canEdit={canEdit} />}
    </div>
  )
}
```

- [ ] **Step 4: Wire navigation and route in `src/App.jsx`**

Add next to the other lazy imports (after the `Estimation` line):

```jsx
const AluCatalog    = lazy(() => import('./pages/AluCatalog.jsx'))
```

Add to the `🧮 ประเมินราคา` children array (after the `bom_templates` entry):

```jsx
    { id: 'alu_catalog',   label: '🏭 แคตตาล็อกอลูมิเนียม', minRole: 'ADMIN', module: 'estimation', permKey: 'estimation' },
```

Add to the page switch (after `case 'bom_templates'`):

```jsx
        case 'alu_catalog':   return <AluCatalog    {...props} />
```

- [ ] **Step 5: Build and test**

Run: `npm run build && npx vitest run`
Expected: build succeeds; all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/pages/AluCatalog.jsx src/pages/aluCatalog/HierarchyTab.jsx src/pages/aluCatalog/TypesTab.jsx src/App.jsx
git commit -m "feat(alu-catalog): catalog page with extruder, series and type management" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Profiles, colours and lengths tab

**Files:**
- Create: `src/pages/aluCatalog/ProfilesTab.jsx`
- Modify: `src/pages/AluCatalog.jsx` (add tab)

**Interfaces:**
- Consumes: `useCatalogTable`, `CatalogCrud`, `LinkEditor`, `optionList`, `seriesLabelFull`.
- Produces: default export `ProfilesTab({ canEdit })`.

- [ ] **Step 1: Write the tab**

```jsx
// src/pages/aluCatalog/ProfilesTab.jsx
// Per extruder: profiles (cross-section + thickness), colours, the stock lengths sold
// per profile x colour, and which series use which profile (with its role/family).
import { useState } from 'react'
import { useCatalogTable } from '../../hooks/useAluCatalog.js'
import CatalogCrud, { ActiveBadge } from '../../components/CatalogCrud.jsx'
import LinkEditor from '../../components/LinkEditor.jsx'
import { optionList } from '../../lib/catalogForm.js'

const PROFILE_FIELDS = [
  { key: 'name', label: 'ชื่อหน้าตัด', type: 'text', required: true, placeholder: 'เช่น กล่องร่อง' },
  { key: 'drawing_no', label: 'Drawing No', type: 'text' },
  { key: 'family', label: 'กลุ่ม (family) สำหรับผูก BOM template', type: 'text', placeholder: 'เช่น กล่องร่อง' },
  { key: 'thickness_mm', label: 'ความหนา (มม.)', type: 'number', min: 0 },
  { key: 'linear_weight_kg_per_m', label: 'น้ำหนัก (กก./เมตร)', type: 'number', required: true, min: 0, step: '0.0001' },
  { key: 'default_length_m', label: 'ความยาวมาตรฐาน (เมตร)', type: 'number', default: 6.4, min: 0 },
  { key: 'image_url', label: 'ลิงก์รูปหน้าตัด', type: 'text' },
  { key: 'active', label: 'ใช้งานอยู่', type: 'checkbox', default: true },
]

const FINISH_FIELDS = [
  { key: 'name', label: 'ชื่อสี', type: 'text', required: true, placeholder: 'เช่น ขาว, อโนไดซ์ดำ' },
  { key: 'code', label: 'รหัสสีของโรงรีด', type: 'text' },
  { key: 'active', label: 'ใช้งานอยู่', type: 'checkbox', default: true },
]

export default function ProfilesTab({ canEdit }) {
  const providers = useCatalogTable('alu_providers')
  const profiles = useCatalogTable('alu_profiles')
  const finishes = useCatalogTable('alu_finishes')
  const variants = useCatalogTable('alu_profile_variants', 'id')
  const series = useCatalogTable('alu_series')
  const seriesProfiles = useCatalogTable('alu_series_profiles', 'id')
  const [providerId, setProviderId] = useState('')
  const [seriesId, setSeriesId] = useState('')

  const error = providers.error || profiles.error || finishes.error || variants.error || series.error || seriesProfiles.error
  if (error) return <div style={{ color: 'var(--red)' }}>โหลดข้อมูลไม่สำเร็จ: {error}</div>

  const myProfiles = (profiles.data || []).filter(p => p.provider_id === providerId)
  const myFinishes = (finishes.data || []).filter(f => f.provider_id === providerId)
  const myProfileIds = new Set(myProfiles.map(p => p.id))
  const myVariants = (variants.data || []).filter(v => myProfileIds.has(v.profile_id))
  const mySeries = (series.data || []).filter(s => s.provider_id === providerId)
  const profileName = Object.fromEntries(myProfiles.map(p => [p.id, p.name + (p.thickness_mm ? ` ${p.thickness_mm}` : '')]))
  const finishName = Object.fromEntries(myFinishes.map(f => [f.id, f.name]))

  const VARIANT_FIELDS = [
    { key: 'profile_id', label: 'หน้าตัด', type: 'select', required: true, options: () => optionList(myProfiles, p => profileName[p.id]) },
    { key: 'finish_id', label: 'สี', type: 'select', required: true, options: () => optionList(myFinishes, f => f.name) },
    { key: 'length_m', label: 'ความยาวเส้น (เมตร)', type: 'number', required: true, min: 0 },
  ]

  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 8, maxWidth: 560 }}>
          แท็บนี้เป็นแคตตาล็อกใหม่ แยกจากรายการ "หน้าตัดอลูมิเนียม" และ "สีผิวอลูมิเนียม" เดิมใน BOM Templates ซึ่งยังใช้กับระบบประเมินราคาเดิมจนกว่าจะถึงเฟส 2 ราคาต่อกก. กรอกที่แท็บ "ราคา"
        </div>
        <label className="label">เลือกโรงรีด</label>
        <select className="input" style={{ maxWidth: 320 }} value={providerId} onChange={e => { setProviderId(e.target.value); setSeriesId('') }}>
          <option value="">— เลือกโรงรีด —</option>
          {optionList(providers.data, p => p.name, providerId).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>
      {!providerId && <div style={{ color: 'var(--text3)' }}>เลือกโรงรีดก่อน แล้วจึงเพิ่มหน้าตัด สี และความยาว</div>}

      {providerId && (
        <>
          <CatalogCrud
            title="📏 หน้าตัดอลูมิเนียม" table="alu_profiles" fields={PROFILE_FIELDS} rows={myProfiles}
            scope={{ provider_id: providerId }} onChanged={profiles.refetch} canEdit={canEdit}
            addLabel="+ เพิ่มหน้าตัด" emptyText="โรงรีดนี้ยังไม่มีหน้าตัด"
            columns={[
              { key: 'name', label: 'ชื่อ', render: r => <strong>{r.name}</strong> },
              { key: 'drawing_no', label: 'Drawing No' },
              { key: 'family', label: 'กลุ่ม' },
              { key: 'thickness_mm', label: 'หนา (มม.)' },
              { key: 'linear_weight_kg_per_m', label: 'กก./ม.' },
              { key: 'default_length_m', label: 'ยาวมาตรฐาน (ม.)' },
              { key: 'active', label: 'สถานะ', render: r => <ActiveBadge active={r.active} /> },
            ]}
          />
          <CatalogCrud
            title="🎨 สีของโรงรีด" table="alu_finishes" fields={FINISH_FIELDS} rows={myFinishes}
            scope={{ provider_id: providerId }} onChanged={finishes.refetch} canEdit={canEdit}
            addLabel="+ เพิ่มสี" emptyText="โรงรีดนี้ยังไม่มีสี"
            columns={[
              { key: 'name', label: 'ชื่อสี', render: r => <strong>{r.name}</strong> },
              { key: 'code', label: 'รหัส' },
              { key: 'active', label: 'สถานะ', render: r => <ActiveBadge active={r.active} /> },
            ]}
          />
          <CatalogCrud
            title="📐 ความยาวเส้นที่ขาย (หน้าตัด × สี × ความยาว)" table="alu_profile_variants" fields={VARIANT_FIELDS} rows={myVariants}
            onChanged={variants.refetch} canEdit={canEdit} addLabel="+ เพิ่มความยาว" emptyText="ยังไม่มีความยาวเส้น (จำเป็นเมื่อโรงรีดคิดราคาต่อเส้น)"
            columns={[
              { key: 'profile_id', label: 'หน้าตัด', render: r => profileName[r.profile_id] },
              { key: 'finish_id', label: 'สี', render: r => finishName[r.finish_id] || '—' },
              { key: 'length_m', label: 'ยาว (ม.)' },
            ]}
          />

          <div style={{ margin: '8px 0' }}>
            <label className="label">เลือกซีรีส์เพื่อกำหนดหน้าตัดที่ใช้</label>
            <select className="input" style={{ maxWidth: 320 }} value={seriesId} onChange={e => setSeriesId(e.target.value)}>
              <option value="">— เลือกซีรีส์ —</option>
              {optionList(mySeries, s => s.name, seriesId).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          {seriesId && (
            <LinkEditor
              title="หน้าตัดที่ซีรีส์นี้ใช้" hint="ช่อง 'บทบาท' คือ family ที่ BOM template ใช้ค้นหา (หน้าตัดเดียวกันใช้คนละบทบาทในต่างซีรีส์ได้)"
              linkTable="alu_series_profiles" parentKey="series_id" parentId={seriesId} childKey="profile_id"
              childOptions={myProfiles.filter(p => p.active !== false).map(p => ({ id: p.id, label: profileName[p.id] }))}
              links={seriesProfiles.data} onChanged={seriesProfiles.refetch} canEdit={canEdit}
              extra={{ key: 'family', label: 'บทบาท (family)', type: 'text', defaultFor: child => (myProfiles.find(p => p.id === child.id)?.family || null) }}
            />
          )}
        </>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Add the tab to `AluCatalog.jsx`**

Import: `import ProfilesTab from './aluCatalog/ProfilesTab.jsx'`. Add to `TABS`: `{ id: 'profiles', label: '📏 หน้าตัด · สี · ความยาว' }`. Add below the other conditionals: `{tab === 'profiles' && <ProfilesTab canEdit={canEdit} />}`.

- [ ] **Step 3: Build and test**

Run: `npm run build && npx vitest run`
Expected: build succeeds; all tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src/pages/aluCatalog/ProfilesTab.jsx src/pages/AluCatalog.jsx
git commit -m "feat(alu-catalog): profile, colour, length and series-profile management" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Parts and hardware sets tab

**Files:**
- Create: `src/pages/aluCatalog/PartsTab.jsx`
- Modify: `src/pages/AluCatalog.jsx` (add tab)

**Interfaces:**
- Consumes: `useCatalogTable`, `CatalogCrud`, `LinkEditor`, `optionList`, `seriesLabelFull`.
- Produces: default export `PartsTab({ canEdit })`.

- [ ] **Step 1: Write the tab**

```jsx
// src/pages/aluCatalog/PartsTab.jsx
// Hardware, hardware sets and accessories (rubber, plastic bumpers ...), what each set
// contains, and which series (optionally which type) uses which part.
import { useState } from 'react'
import { useCatalogTable } from '../../hooks/useAluCatalog.js'
import CatalogCrud, { ActiveBadge } from '../../components/CatalogCrud.jsx'
import LinkEditor from '../../components/LinkEditor.jsx'
import { optionList } from '../../lib/catalogForm.js'
import { seriesLabelFull } from '../../lib/aluCatalog.js'

const KIND_LABEL = { hardware: 'อุปกรณ์', hardware_set: 'ชุดอุปกรณ์', accessory: 'อะไหล่/อุปกรณ์เสริม' }

export default function PartsTab({ canEdit }) {
  const providers = useCatalogTable('alu_providers')
  const parts = useCatalogTable('alu_parts')
  const setItems = useCatalogTable('alu_part_set_items', 'id')
  const series = useCatalogTable('alu_series')
  const types = useCatalogTable('door_window_types')
  const seriesParts = useCatalogTable('alu_series_parts', 'id')
  const [setId, setSetId] = useState('')
  const [seriesId, setSeriesId] = useState('')

  const error = providers.error || parts.error || setItems.error || series.error || types.error || seriesParts.error
  if (error) return <div style={{ color: 'var(--red)' }}>โหลดข้อมูลไม่สำเร็จ: {error}</div>

  const providerById = Object.fromEntries((providers.data || []).map(p => [p.id, p]))
  const sets = (parts.data || []).filter(p => p.kind === 'hardware_set')
  const singles = (parts.data || []).filter(p => p.kind !== 'hardware_set' && p.active !== false)

  const PART_FIELDS = [
    { key: 'name', label: 'ชื่อ', type: 'text', required: true },
    { key: 'kind', label: 'ชนิด', type: 'select', required: true, default: 'hardware',
      options: Object.entries(KIND_LABEL).map(([value, label]) => ({ value, label })) },
    { key: 'unit', label: 'หน่วย', type: 'text', required: true, default: 'ชิ้น' },
    { key: 'provider_id', label: 'โรงรีด/ผู้ผลิต (ไม่บังคับ)', type: 'select', options: () => optionList(providers.data, p => p.name) },
    { key: 'active', label: 'ใช้งานอยู่', type: 'checkbox', default: true },
  ]

  return (
    <div>
      <CatalogCrud
        title="🔩 อุปกรณ์ · ชุดอุปกรณ์ · อะไหล่" table="alu_parts" fields={PART_FIELDS} rows={parts.data}
        onChanged={parts.refetch} canEdit={canEdit} addLabel="+ เพิ่มรายการ" emptyText="ยังไม่มีอุปกรณ์"
        columns={[
          { key: 'name', label: 'ชื่อ', render: r => <strong>{r.name}</strong> },
          { key: 'kind', label: 'ชนิด', render: r => KIND_LABEL[r.kind] },
          { key: 'unit', label: 'หน่วย' },
          { key: 'provider_id', label: 'ผู้ผลิต', render: r => providerById[r.provider_id]?.name || '—' },
          { key: 'active', label: 'สถานะ', render: r => <ActiveBadge active={r.active} /> },
        ]}
      />

      <div style={{ marginBottom: 12 }}>
        <label className="label">เลือกชุดอุปกรณ์เพื่อกำหนดสิ่งที่อยู่ในชุด</label>
        <select className="input" style={{ maxWidth: 320 }} value={setId} onChange={e => setSetId(e.target.value)}>
          <option value="">— เลือกชุดอุปกรณ์ —</option>
          {optionList(sets, s => s.name, setId).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>
      {setId && (
        <LinkEditor
          title="สิ่งที่อยู่ในชุดนี้" hint="ติ๊กเพื่อเพิ่มเข้าชุด แล้วใส่จำนวน"
          linkTable="alu_part_set_items" parentKey="set_id" parentId={setId} childKey="part_id"
          childOptions={singles.map(p => ({ id: p.id, label: `${p.name} (${p.unit})` }))}
          links={setItems.data} onChanged={setItems.refetch} canEdit={canEdit}
          extra={{ key: 'quantity', label: 'จำนวน', type: 'number', defaultFor: () => 1 }}
        />
      )}

      <div style={{ margin: '16px 0 12px' }}>
        <label className="label">เลือกซีรีส์เพื่อกำหนดอุปกรณ์ที่ใช้</label>
        <select className="input" style={{ maxWidth: 380 }} value={seriesId} onChange={e => setSeriesId(e.target.value)}>
          <option value="">— เลือกซีรีส์ —</option>
          {optionList(series.data, s => seriesLabelFull(s, providerById[s.provider_id]), seriesId).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>
      {seriesId && (
        <LinkEditor
          title="อุปกรณ์/ชุดอุปกรณ์ที่ซีรีส์นี้ใช้" hint="เลือกประเภทบานเพื่อจำกัดให้ใช้กับประเภทนั้นเท่านั้น เว้นว่างคือใช้กับทุกประเภท (ชุดอุปกรณ์ 'ใช้กับชุด')"
          linkTable="alu_series_parts" parentKey="series_id" parentId={seriesId} childKey="part_id"
          childOptions={(parts.data || []).filter(p => p.active !== false).map(p => ({ id: p.id, label: `${p.name} · ${KIND_LABEL[p.kind]}` }))}
          links={seriesParts.data} onChanged={seriesParts.refetch} canEdit={canEdit}
          extra={{ key: 'type_id', label: 'ประเภท', type: 'select', emptyLabel: 'ทุกประเภท', options: optionList(types.data, t => t.name) }}
        />
      )}
    </div>
  )
}
```

- [ ] **Step 2: Add the tab to `AluCatalog.jsx`**

Import `PartsTab from './aluCatalog/PartsTab.jsx'`; add `{ id: 'parts', label: '🔩 อุปกรณ์' }` to `TABS`; add `{tab === 'parts' && <PartsTab canEdit={canEdit} />}`.

- [ ] **Step 3: Build and test**

Run: `npm run build && npx vitest run`
Expected: build succeeds; all tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src/pages/aluCatalog/PartsTab.jsx src/pages/AluCatalog.jsx
git commit -m "feat(alu-catalog): parts, hardware sets and series-part links" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Prices tab

**Files:**
- Create: `src/pages/aluCatalog/PricesTab.jsx`
- Modify: `src/pages/AluCatalog.jsx` (add tab)

**Interfaces:**
- Consumes: `useCatalogTable` (price tables ordered newest first), `CatalogCrud`, `optionList`, `seriesLabelFull`.
- Produces: default export `PricesTab({ canEdit })`.

- [ ] **Step 1: Write the tab**

```jsx
// src/pages/aluCatalog/PricesTab.jsx
// Price history. Rows are added, never overwritten: a new price is a new row with a later
// effective date, and the newest row on or before a date is the price for that date.
import { useCatalogTable } from '../../hooks/useAluCatalog.js'
import CatalogCrud from '../../components/CatalogCrud.jsx'
import { optionList } from '../../lib/catalogForm.js'
import { seriesLabelFull } from '../../lib/aluCatalog.js'

// local calendar date (en-CA formats as YYYY-MM-DD); toISOString would give yesterday's date before 07:00 in Thailand
const todayStr = () => new Date().toLocaleDateString('en-CA')

export default function PricesTab({ canEdit }) {
  const providers = useCatalogTable('alu_providers')
  const finishes = useCatalogTable('alu_finishes')
  const series = useCatalogTable('alu_series')
  const profiles = useCatalogTable('alu_profiles')
  const variants = useCatalogTable('alu_profile_variants', 'id')
  const parts = useCatalogTable('alu_parts')
  const kgPrices = useCatalogTable('alu_kg_prices', 'effective_from', false)
  const piecePrices = useCatalogTable('alu_piece_prices', 'effective_from', false)
  const partPrices = useCatalogTable('alu_part_prices', 'effective_from', false)

  const all = [providers, finishes, series, profiles, variants, parts, kgPrices, piecePrices, partPrices]
  const error = all.map(q => q.error).find(Boolean)
  if (error) return <div style={{ color: 'var(--red)' }}>โหลดข้อมูลไม่สำเร็จ: {error}</div>

  const providerById = Object.fromEntries((providers.data || []).map(p => [p.id, p]))
  const finishById = Object.fromEntries((finishes.data || []).map(f => [f.id, f]))
  const seriesById = Object.fromEntries((series.data || []).map(s => [s.id, s]))
  const profileById = Object.fromEntries((profiles.data || []).map(p => [p.id, p]))
  const variantById = Object.fromEntries((variants.data || []).map(v => [v.id, v]))
  const partById = Object.fromEntries((parts.data || []).map(p => [p.id, p]))
  const money = n => (n == null ? '—' : Number(n).toLocaleString('th-TH', { maximumFractionDigits: 4 }))
  const profileLabel = p => (p ? `${p.name}${p.thickness_mm ? ' ' + p.thickness_mm : ''}` : '—')

  const KG_FIELDS = [
    { key: 'provider_id', label: 'โรงรีด', type: 'select', required: true, options: () => optionList(providers.data, p => p.name) },
    { key: 'finish_id', label: 'สี', type: 'select', required: true,
      options: form => optionList((finishes.data || []).filter(f => f.provider_id === form.provider_id), f => f.name) },
    { key: 'series_id', label: 'ทับเฉพาะซีรีส์ (ไม่บังคับ)', type: 'select',
      options: form => optionList((series.data || []).filter(s => s.provider_id === form.provider_id), s => s.name) },
    { key: 'profile_id', label: 'ทับเฉพาะหน้าตัด (ไม่บังคับ)', type: 'select',
      options: form => optionList((profiles.data || []).filter(p => p.provider_id === form.provider_id), profileLabel) },
    { key: 'price_per_kg', label: 'ราคา (บาท/กก.)', type: 'number', required: true, min: 0 },
    { key: 'effective_from', label: 'มีผลตั้งแต่วันที่', type: 'date', required: true, default: todayStr() },
  ]
  const PIECE_FIELDS = [
    { key: 'variant_id', label: 'หน้าตัด · สี · ความยาว', type: 'select', required: true,
      options: () => (variants.data || []).map(v => ({ value: v.id, label: `${profileLabel(profileById[v.profile_id])} · ${finishById[v.finish_id]?.name || '—'} · ${v.length_m} ม.` })) },
    { key: 'price_per_piece', label: 'ราคา (บาท/เส้น)', type: 'number', required: true, min: 0 },
    { key: 'effective_from', label: 'มีผลตั้งแต่วันที่', type: 'date', required: true, default: todayStr() },
  ]
  const PART_FIELDS = [
    { key: 'part_id', label: 'อุปกรณ์', type: 'select', required: true, options: () => optionList(parts.data, p => p.name) },
    { key: 'list_price', label: 'ราคาป้าย', type: 'number', required: true, min: 0 },
    { key: 'discount_pct', label: 'ส่วนลด (%)', type: 'number', min: 0, default: 0 },
    { key: 'effective_from', label: 'มีผลตั้งแต่วันที่', type: 'date', required: true, default: todayStr() },
  ]
  const validateKg = form => (form.series_id && form.profile_id ? 'เลือกทับได้อย่างใดอย่างหนึ่ง: ซีรีส์ หรือ หน้าตัด' : null)
  const validateDiscount = form => (Number(form.discount_pct) > 100 ? 'ส่วนลดต้องไม่เกิน 100%' : null)

  return (
    <div>
      <CatalogCrud
        title="⚖️ ราคาต่อกก. (โรงรีด × สี)" table="alu_kg_prices" fields={KG_FIELDS} rows={kgPrices.data}
        onChanged={kgPrices.refetch} canEdit={canEdit} addLabel="+ เพิ่มราคา" validate={validateKg}
        emptyText="ยังไม่มีราคา เพิ่มราคาใหม่โดยใช้วันที่มีผลใหม่ ระบบเก็บประวัติให้"
        columns={[
          { key: 'effective_from', label: 'มีผลตั้งแต่' },
          { key: 'provider_id', label: 'โรงรีด', render: r => providerById[r.provider_id]?.name },
          { key: 'finish_id', label: 'สี', render: r => finishById[r.finish_id]?.name },
          { key: 'scope', label: 'ทับเฉพาะ', render: r => (r.profile_id ? `หน้าตัด ${profileLabel(profileById[r.profile_id])}` : r.series_id ? `ซีรีส์ ${seriesLabelFull(seriesById[r.series_id] || { name: '—' }, providerById[r.provider_id])}` : 'ทั้งโรงรีด') },
          { key: 'price_per_kg', label: 'บาท/กก.', render: r => money(r.price_per_kg) },
        ]}
      />
      <CatalogCrud
        title="📏 ราคาต่อเส้น" table="alu_piece_prices" fields={PIECE_FIELDS} rows={piecePrices.data}
        onChanged={piecePrices.refetch} canEdit={canEdit} addLabel="+ เพิ่มราคา"
        emptyText="ยังไม่มีราคาต่อเส้น (ต้องเพิ่มความยาวเส้นที่แท็บ 'หน้าตัด · สี · ความยาว' ก่อน)"
        columns={[
          { key: 'effective_from', label: 'มีผลตั้งแต่' },
          { key: 'variant_id', label: 'หน้าตัด · สี · ความยาว', render: r => { const v = variantById[r.variant_id]; return v ? `${profileLabel(profileById[v.profile_id])} · ${finishById[v.finish_id]?.name || '—'} · ${v.length_m} ม.` : '—' } },
          { key: 'price_per_piece', label: 'บาท/เส้น', render: r => money(r.price_per_piece) },
        ]}
      />
      <CatalogCrud
        title="🔩 ราคาอุปกรณ์" table="alu_part_prices" fields={PART_FIELDS} rows={partPrices.data}
        onChanged={partPrices.refetch} canEdit={canEdit} addLabel="+ เพิ่มราคา" validate={validateDiscount}
        emptyText="ยังไม่มีราคาอุปกรณ์"
        columns={[
          { key: 'effective_from', label: 'มีผลตั้งแต่' },
          { key: 'part_id', label: 'อุปกรณ์', render: r => partById[r.part_id]?.name },
          { key: 'list_price', label: 'ราคาป้าย', render: r => money(r.list_price) },
          { key: 'discount_pct', label: 'ลด %' },
          { key: 'net', label: 'ราคาสุทธิ', render: r => money(Number(r.list_price) * (1 - Number(r.discount_pct) / 100)) },
        ]}
      />
    </div>
  )
}
```

- [ ] **Step 2: Add the tab to `AluCatalog.jsx`**

Import `PricesTab from './aluCatalog/PricesTab.jsx'`; add `{ id: 'prices', label: '💰 ราคา' }` to `TABS`; add `{tab === 'prices' && <PricesTab canEdit={canEdit} />}`.

- [ ] **Step 3: Build and test**

Run: `npm run build && npx vitest run`
Expected: build succeeds; all tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src/pages/aluCatalog/PricesTab.jsx src/pages/AluCatalog.jsx
git commit -m "feat(alu-catalog): price history tab for kg, piece and part prices" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Phase wrap-up — verify, hand over to the owner, live check

**Files:**
- Modify: none expected (fixes only if a check below fails).

- [ ] **Step 1: Full automated check**

Run: `npm test && npm run build`
Expected: every test PASS; build succeeds.

- [ ] **Step 2: Whole SQL suite once more, rolled back**

```bash
SCRATCH=/private/tmp/claude-501/-Users-plfx-code-FacadeXPM-facadex-app/c6b37346-e3c3-435c-b5ba-380c8b970a05/scratchpad
{ echo 'BEGIN;'; cat supabase/migrations/2026-10-10-0{1,2,3}-*.sql supabase/tests/alu_catalog_test.sql; echo 'ROLLBACK;'; } > $SCRATCH/alu_final.sql
npx supabase db query --linked -f $SCRATCH/alu_final.sql
```

Expected: Tests 1, 2, 3 `TEST PASSED`; no `ERROR`.

- [ ] **Step 3: Check the existing estimation module is untouched**

Run: `git diff --stat origin/main -- src/lib/bomEngine.js src/pages/Estimation.jsx src/pages/BomTemplates.jsx src/pages/AluminumProfiles.jsx`
Expected: no output (none of the four files changed).

- [ ] **Step 4: Hand the migrations to the owner**

Tell the owner to run (the agent cannot apply migrations):

```
! npx supabase db query --linked -f supabase/migrations/2026-10-10-01-alu-catalog-hierarchy.sql
! npx supabase db query --linked -f supabase/migrations/2026-10-10-02-alu-catalog-components.sql
! npx supabase db query --linked -f supabase/migrations/2026-10-10-03-alu-catalog-prices.sql
```

and then confirm the tables exist: `npx supabase db query --linked "select count(*) from information_schema.tables where table_schema='public' and (table_name like 'alu\_%' or table_name = 'door_window_types')"` returns 14 (13 `alu_*` tables plus `door_window_types`).

- [ ] **Step 5: Live check in the browser (after the owner applies the migrations)**

Run the app (`npm run dev`), sign in as the FacadeX owner, open ประเมินราคา → 🏭 แคตตาล็อกอลูมิเนียม, and verify in order:
1. Add extruder "TYK" (short name TYK, ต่อกก.) → appears in the list.
2. Pick it, add series "กล่องร่อง" (พื้นฐาน) → label shows "กล่องร่อง · TYK".
3. ประเภทบาน tab: add "บานเลื่อน" (หน้าต่าง, 140). Back on hierarchy, press ประเภทบาน on the series and tick it.
4. หน้าตัด tab: add a profile (weight 0.85, หนา 1.2), a colour "ขาว", a length 6.4 m; link the profile to the series with role "กล่องร่อง".
5. อุปกรณ์ tab: add a set and a part, put the part in the set with quantity 2.
6. ราคา tab: add a kg price 95 dated today, then 98 dated later; try adding another 95 on the first date → a Thai "ซ้ำ" message, not a Postgres error.
7. Open BOM Templates and Estimation → they still load and behave as before, and the old หน้าตัดอลูมิเนียม / สีผิวอลูมิเนียม lists are unchanged (the new catalog is a separate list until Phase 2).
8. Sign in as a tenant without the estimation module → the nav entry is absent.

Expected: all eight hold. Record any deviation as a bug before merging.

- [ ] **Step 6: Stop before merging**

Do not merge `feat/alu-cost-catalog` into main. Phases 2 and 3 continue on this branch; the owner decides when the whole arc is done.

---

## Self-Review

**Spec coverage (Phase 1 scope = catalog):** hierarchy and series↔types (Task 1); profiles, colours, variants, parts, sets, series↔profiles/parts as new tables (Task 2); kg/piece/part price history with precedence, effective dates and `source` (Task 3, Task 4); `resolveAluPrice`/`resolvePartPrice` with the three bases and `unresolved` (Task 4); series labels full/short with `short_name` (Tasks 1, 5); management UI for every table (Tasks 6–10); FacadeX-only gating (Tasks 1–3, 7). Deferred to later plans by design: `bom_templates.type_id`, estimation project/opening changes, engine rewiring, the stale-price banner, price structure and export (Phases 2–3), and retiring the legacy `aluminum_finishes` (Phase 2). No spec requirement for Phase 1 lacks a task.

**Placeholder scan:** no TBD/TODO/"similar to" steps; every code step carries its code. Checked against the live schema while writing: legacy `aluminum_profiles` is gated by `purchase_orders`, so the catalog uses its own `alu_profiles`/`alu_finishes` and the SQL fixtures give tenants A and B only `estimation`.

**Type consistency:** field/option shapes match across `catalogForm.js`, `CatalogCrud`, and the tabs (`options` array or `(form) => array`, `{ value, label }`); `LinkEditor` `childOptions` use `{ id, label }` in every tab; `extra.table` is injected by `LinkEditor`; `fetchCatalogRows` argument order matches `useCatalogTable`; `resolveAluPrice` reasons match the test expectations; table/column names match the migrations (`alu_series_profiles.family` nullable, `alu_part_set_items.set_id/part_id/quantity`, `alu_series_parts.type_id` nullable).

**Review Focus coverage:** items 1–6 map to Tasks 6, 1, 5, 4, 1–3 and 5 respectively.
