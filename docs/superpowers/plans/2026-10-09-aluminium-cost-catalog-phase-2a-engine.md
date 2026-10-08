# Aluminium Cost Catalog — Phase 2a: Engine Rewire (no new screens) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the estimation engine able to price an opening from the new aluminium catalog (series → profile by family/thickness → extruder price basis → price history as of a date), with project defaults, per-item inheritance, hardware sets, availability checks, a drawing preview geometry and stale-price detection — all as pure, tested code plus one additive migration. No screen is built or rewired here.

**Architecture:** One additive ("expand") migration adds the new columns next to the old ones, so the currently deployed estimation module keeps working whether or not the migration is applied. New pure modules (`aluCatalogPricing`, `estimationInherit`, `framePreview`, `staleProjectPrices`) hold the logic. `bomEngine.computeBomForOpening` takes a `pricing` object instead of `(profiles, finish)`; a `legacyPricing` adapter reproduces today's behaviour exactly so `Estimation.jsx` keeps working until Phase 2b replaces it.

**Tech Stack:** Postgres/Supabase (RLS), React 18 + Vite, vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-08-aluminium-cost-catalog-design.md` (Estimation changes, Decisions 1–7). Phase 1 plan: `docs/superpowers/plans/2026-10-08-aluminium-cost-catalog-phase-1.md` (built, review-clean; its migrations 01–03 may or may not be applied yet — this plan works either way).

**Phase split (owner rule: mockup before any UI).** This plan (2a) is everything except screens. Phase 2b (project defaults panel, item modal with the six fields and the preview, availability warning UI, stale-price banner, BomTemplates type/part selects, retirement of the legacy tables) is planned AFTER the owner has commented on a mockup of those screens. See "Phase 2b outline" at the end.

## Global Constraints

- FacadeX only: tables keep the existing RLS policy `admin_full_access` (`is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation')`); this plan adds columns only, no new table, no policy change.
- **Expand only.** The migration in this plan is additive: new nullable columns / defaulted columns, and three NOT NULL drops. It must not drop, rename or retype anything and must leave the old code path working. Contract (dropping `series`, `finish_id`, `aluminum_finishes`) is Phase 2b and is applied at deploy time, never earlier. Migrations go live the instant they are applied; an unpushed branch is not safe.
- Agents never touch any database. Verification of SQL is done by the owner running the prepared script (rolled-back transaction). Agents verify SQL by careful reading only.
- Do NOT modify `src/pages/AluminumProfiles.jsx` or `src/pages/PurchaseOrders.jsx` (legacy aluminium profiles stay PO-side). `src/pages/Estimation.jsx` may change only the two `computeBomForOpening` call sites and one import (Task 3). `src/pages/BomTemplates.jsx` is not touched in this plan.
- Pure functions only in `src/lib`: no I/O, no `Date.now()`; dates are `'YYYY-MM-DD'` strings compared as strings.
- A price that cannot be found is `unresolved` with a reason; it never silently becomes 0 without being listed in `unresolvedComponents` / `unresolvedDetails`.
- No upserts and no PostgREST embeds in new code; load tables separately (`fetchCatalogRows`) and join client-side.
- Thai UI copy where any user-visible string exists (this plan has almost none).
- Commit messages end with the line `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Run unit tests with `npx vitest run <file>`; whole suite `npm test`; build `npm run build`.

## Rulings (decided while planning; owner can overturn at the 2b mockup gate)

- Ruling: Expand/contract migrations. The new openings column for the colour is named `alu_finish_id` (not `finish_id` as the spec says) and stays that name; the legacy `finish_id`/`series` columns are dropped in 2b. — Renaming would need the same column to point at two tables during the transition. — If wrong: a rename migration later, no data at risk.
- Ruling: An item's infill and hardware set inherit the project default when NULL, so "explicitly none" needs its own flag: `no_infill` / `no_hardware_set` booleans (default false). — NULL cannot mean both "inherit" and "none". — If wrong: replace flags with a sentinel in 2b.
- Ruling: Thickness is not one of the owner's six item fields but profile lookup needs it. Project gets `default_thickness_mm`; the item's `thickness_mm` becomes nullable = inherit. — Without it every item would need a thickness field. — Owner to confirm at the mockup gate (an item-level override stays available).
- Ruling: A hardware set is priced once per opening unit: Σ(set item quantity × net part price). It does not scale per cell. Template hardware lines keep their own per-cell/perimeter rules. — Spec says "hardware set cost"; no scaling rule was given. — If wrong: add a `quantity_basis` to the set link later.
- Ruling: Template hardware with a `part_id` is priced from the part price history; with no price row, or no `part_id`, it falls back to `reference_unit_price` and the line says `price_source: 'reference'`. — Spec: "reference_unit_price remains the fallback". — If wrong: change the fallback to unresolved.
- Ruling: Labour per m² resolves item → project → type default (`door_window_types.default_labour_per_sqm` when > 0) → the template's own `labor_price_per_sqm`. — Spec Decision 1 plus keeping old behaviour as the last resort.
- Ruling: Waste %, sealant rate, PM %, rounding and VAT overrides are Phase 3 (cost settings). Phase 2 keeps the template's `waste_pct`, `silicone_price_per_m`, `felt_price_per_m`. `profit_pct` is stored on project/item now (inheritance is built) but nothing computes with it until Phase 3.
- Ruling: A colour belongs to one extruder. If the item's colour belongs to a different extruder than the profile resolved from the series, the line is `unresolved` with reason `finish_other_provider`.
- Ruling: Two profiles matching one (series, family, thickness) are not blocked by the DB; the lowest `id` is used and the line carries `ambiguous: true` so a screen can warn. — `alu_series_profiles` has no unique index over that tuple (final review note 9).

## Review Focus

Inputs and conditions the spec implies that a person will hit, most likely first. Each has a pinning test in the task named.

1. The item inherits the project's default colour, but the (new) series belongs to another extruder → must be `unresolved: finish_other_provider`, never priced with the wrong extruder's prices — Task 2.
2. The project default series changes to one that does not offer some items' door/window type → those items (only the ones that inherit the series) are listed — Task 4.
3. A price row dated after the project's locked `price_as_of` must not change the BOM; the same BOM computed "as of today" must show exactly which lines changed — Tasks 2 and 6.
4. An item that explicitly says "no infill" / "no hardware set" must not pick up the project default — Task 4.
5. A hardware set containing a part with no price must not make the set silently cheaper: the line is listed as unresolved — Tasks 2 and 3.
6. Two profiles matching one (series, family, thickness) → deterministic pick plus `ambiguous` — Task 2.
7. A project-default labour rate of 0 is a real value (free labour), not "unset" — Task 4.

---

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/2026-10-11-01-estimation-catalog-expand.sql` | Additive columns on `bom_templates`, `bom_template_hardware`, `estimation_projects`, `estimation_openings` |
| `supabase/tests/estimation_expand_test.sql` | Rolled-back SQL checks for the migration |
| `.superpowers/sdd/…/run-estimation-expand-tests.sh` | Owner-run script (created by Task 1) |
| `src/lib/aluPrice.js` (modify) | `resolveAluPrice` also returns `row_id` of the price row it used |
| `src/lib/aluCatalogPricing.js` (new) | `buildCatalogIndex`, `resolveCatalogProfile`, `makeCatalogPricing` |
| `src/lib/bomEngine.js` (modify) | `computeBomForOpening(opening, template, components, hardware, pricing, infillType)`, `legacyPricing`, exported `resolveGrid`, set lines, labour override |
| `src/lib/estimationInherit.js` (new) | Inheritance by NULL, availability, add-on filter, affected-items list |
| `src/lib/framePreview.js` (new) | Geometry for the double-line drawing with dimensions |
| `src/lib/staleProjectPrices.js` (new) | Which price rows differ between the locked date and today |
| `src/hooks/useAluCatalog.js` (modify) | `useEstimationCatalog()` loads every catalog table once and builds the index |
| `src/pages/Estimation.jsx` (modify, 3 lines) | Call `legacyPricing(...)` so the old screen keeps working |

---

### Task 1: Expand migration, SQL test and owner script

**Files:**
- Create: `supabase/migrations/2026-10-11-01-estimation-catalog-expand.sql`
- Create: `supabase/tests/estimation_expand_test.sql`
- Create: `.superpowers/sdd/2026-10-08-aluminium-cost-catalog-phase-1/run-estimation-expand-tests.sh` (git-ignored scratch folder; the owner runs it)

**Interfaces:**
- Consumes: Phase 1 tables `alu_series`, `alu_finishes`, `alu_parts`, `door_window_types` (migrations 2026-10-10-01..03; the test script can include them), existing `estimation_projects`, `estimation_openings`, `bom_templates`, `bom_template_hardware`, `infill_types`.
- Produces columns (exact names, used by later tasks and Phase 2b):
  - `bom_templates.type_id UUID → door_window_types ON DELETE SET NULL`
  - `bom_template_hardware.part_id UUID → alu_parts ON DELETE SET NULL`
  - `estimation_projects`: `default_series_id → alu_series`, `default_finish_id → alu_finishes`, `default_infill_id → infill_types`, `default_hardware_set_id → alu_parts` (all `ON DELETE SET NULL`), `default_thickness_mm NUMERIC > 0`, `labour_per_sqm NUMERIC >= 0`, `profit_pct NUMERIC 0..1000`, `price_as_of DATE NOT NULL DEFAULT current_date`
  - `estimation_openings`: `series`, `finish_id`, `thickness_mm` lose NOT NULL; new `series_id → alu_series`, `alu_finish_id → alu_finishes`, `hardware_set_id → alu_parts` (all `ON DELETE RESTRICT`), `no_infill BOOLEAN NOT NULL DEFAULT false`, `no_hardware_set BOOLEAN NOT NULL DEFAULT false`, `profit_pct`, `labour_per_sqm`, `item_name TEXT`, `item_description TEXT`; CHECKs: `NOT (no_infill AND infill_type_id IS NOT NULL)`, `NOT (no_hardware_set AND hardware_set_id IS NOT NULL)`.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/2026-10-11-01-estimation-catalog-expand.sql
-- Aluminium cost catalog, Phase 2a "expand" step. ADDITIVE ONLY: nothing is dropped, renamed or
-- retyped, and the three NOT NULL drops only loosen rules, so the currently deployed estimation
-- screens (which still write series / finish_id / thickness_mm) keep working before and after this
-- migration. The matching "contract" step (drop series, finish_id, aluminum_finishes) is Phase 2b
-- and is applied only at deploy time. Spec: 2026-10-08-aluminium-cost-catalog-design.md, Estimation changes.
-- Needs migrations 2026-10-10-01..03 (the catalog tables) to be applied first.

-- A template is "the BOM for type X"; a hardware line can point at a catalog part for its price.
ALTER TABLE bom_templates
  ADD COLUMN type_id UUID REFERENCES door_window_types(id) ON DELETE SET NULL;
ALTER TABLE bom_template_hardware
  ADD COLUMN part_id UUID REFERENCES alu_parts(id) ON DELETE SET NULL;

-- Project defaults (an item that leaves a field NULL inherits it) and the price lock date.
-- price_as_of is set when the project is created and never moves by itself.
ALTER TABLE estimation_projects
  ADD COLUMN default_series_id       UUID REFERENCES alu_series(id)    ON DELETE SET NULL,
  ADD COLUMN default_finish_id       UUID REFERENCES alu_finishes(id)  ON DELETE SET NULL,
  ADD COLUMN default_infill_id       UUID REFERENCES infill_types(id)  ON DELETE SET NULL,
  ADD COLUMN default_hardware_set_id UUID REFERENCES alu_parts(id)     ON DELETE SET NULL,
  ADD COLUMN default_thickness_mm    NUMERIC CHECK (default_thickness_mm IS NULL OR default_thickness_mm > 0),
  ADD COLUMN labour_per_sqm          NUMERIC CHECK (labour_per_sqm IS NULL OR labour_per_sqm >= 0),
  ADD COLUMN profit_pct              NUMERIC CHECK (profit_pct IS NULL OR (profit_pct >= 0 AND profit_pct <= 1000)),
  ADD COLUMN price_as_of             DATE NOT NULL DEFAULT current_date;

-- Items: the old text series / legacy colour / thickness become optional, the catalog columns are added.
-- The colour column is alu_finish_id (not finish_id) because finish_id still points at the legacy
-- aluminum_finishes table until the contract step.
ALTER TABLE estimation_openings
  ALTER COLUMN series       DROP NOT NULL,
  ALTER COLUMN finish_id    DROP NOT NULL,
  ALTER COLUMN thickness_mm DROP NOT NULL,
  ADD COLUMN series_id        UUID REFERENCES alu_series(id)   ON DELETE RESTRICT,
  ADD COLUMN alu_finish_id    UUID REFERENCES alu_finishes(id) ON DELETE RESTRICT,
  ADD COLUMN hardware_set_id  UUID REFERENCES alu_parts(id)    ON DELETE RESTRICT,
  ADD COLUMN no_infill        BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN no_hardware_set  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN profit_pct       NUMERIC CHECK (profit_pct IS NULL OR (profit_pct >= 0 AND profit_pct <= 1000)),
  ADD COLUMN labour_per_sqm   NUMERIC CHECK (labour_per_sqm IS NULL OR labour_per_sqm >= 0),
  ADD COLUMN item_name        TEXT,
  ADD COLUMN item_description TEXT,
  ADD CONSTRAINT estimation_openings_infill_flag_ck CHECK (NOT (no_infill AND infill_type_id IS NOT NULL)),
  ADD CONSTRAINT estimation_openings_hwset_flag_ck  CHECK (NOT (no_hardware_set AND hardware_set_id IS NOT NULL));

-- Foreign-key indexes (deleting a series / colour / part scans these).
CREATE INDEX idx_bom_templates_type_id               ON bom_templates(type_id);
CREATE INDEX idx_bom_template_hardware_part_id       ON bom_template_hardware(part_id);
CREATE INDEX idx_estimation_projects_default_series  ON estimation_projects(default_series_id);
CREATE INDEX idx_estimation_projects_default_finish  ON estimation_projects(default_finish_id);
CREATE INDEX idx_estimation_projects_default_infill  ON estimation_projects(default_infill_id);
CREATE INDEX idx_estimation_projects_default_hwset   ON estimation_projects(default_hardware_set_id);
CREATE INDEX idx_estimation_openings_series_id       ON estimation_openings(series_id);
CREATE INDEX idx_estimation_openings_alu_finish_id   ON estimation_openings(alu_finish_id);
CREATE INDEX idx_estimation_openings_hardware_set_id ON estimation_openings(hardware_set_id);
```

- [ ] **Step 2: Write the SQL test** (standalone, own fixtures, same conventions as `supabase/tests/alu_catalog_test.sql`: read its first 35 lines and the Test 3 tail first and copy the style — one DO block per test, `SET LOCAL role = 'authenticated'`, claims via `SET LOCAL request.jwt.claims`, `RESET role` at the end, no `WHEN OTHERS`)

```sql
-- supabase/tests/estimation_expand_test.sql
-- RUN ONLY INSIDE ONE TRANSACTION THAT ENDS IN ROLLBACK (fixtures are real rows).
--   BEGIN; <alu catalog migrations 01..03 if not applied>; <2026-10-11-01 expand migration>; <this file>; ROLLBACK;
-- Tenants: A and B hold only 'estimation'; C holds nothing.

CREATE TEMP TABLE _est_fx (a_tenant UUID, b_tenant UUID, c_tenant UUID);
DO $$
DECLARE owner_id UUID; ta UUID; tb UUID; tc UUID;
BEGIN
  SELECT id INTO owner_id FROM auth.users ORDER BY created_at ASC LIMIT 1;
  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at)
    VALUES ('__EST TEST A__', owner_id, 'expired', now() - interval '1 day') RETURNING id INTO ta;
  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at)
    VALUES ('__EST TEST B__', owner_id, 'expired', now() - interval '1 day') RETURNING id INTO tb;
  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at)
    VALUES ('__EST TEST C__', owner_id, 'expired', now() - interval '1 day') RETURNING id INTO tc;
  INSERT INTO tenant_modules (tenant_id, module_key) VALUES (ta, 'estimation'), (tb, 'estimation');
  INSERT INTO user_roles (user_email, role, status, tenant_id) VALUES
    ('__est_a__@example.com', 'OWNER', 'approved', ta),
    ('__est_b__@example.com', 'OWNER', 'approved', tb),
    ('__est_c__@example.com', 'OWNER', 'approved', tc);
  INSERT INTO _est_fx VALUES (ta, tb, tc);
END $$;

-- ── Test 1: the new columns work, defaults and inheritance-by-NULL are accepted ──
DO $$
DECLARE
  ta UUID; tb UUID; tc UUID;
  prov UUID; ser UUID; fin UUID; setp UUID; typ UUID; tpl UUID; inf UUID; proj UUID; op UUID; n INT; pasof DATE; raised BOOLEAN;
BEGIN
  SELECT a_tenant, b_tenant, c_tenant INTO ta, tb, tc FROM _est_fx;
  SET LOCAL role = 'authenticated';
  SET LOCAL request.jwt.claims = '{"email":"__est_a__@example.com"}';

  INSERT INTO alu_providers (name, short_name, price_basis) VALUES ('EST P', 'EP', 'per_kg') RETURNING id INTO prov;
  INSERT INTO alu_series (provider_id, name) VALUES (prov, 'EST S') RETURNING id INTO ser;
  INSERT INTO alu_finishes (provider_id, name) VALUES (prov, 'EST F') RETURNING id INTO fin;
  INSERT INTO alu_parts (name, kind) VALUES ('EST SET', 'hardware_set') RETURNING id INTO setp;
  INSERT INTO door_window_types (name, category) VALUES ('EST TYPE', 'window') RETURNING id INTO typ;
  INSERT INTO infill_types (name, price_per_sqm) VALUES ('EST INFILL', 100) RETURNING id INTO inf;
  INSERT INTO bom_templates (name, category, type_id) VALUES ('EST TPL', 'window', typ) RETURNING id INTO tpl;
  INSERT INTO bom_template_hardware (template_id, name, reference_unit_price, quantity_basis, part_id)
    VALUES (tpl, 'EST HW', 10, 'fixed', setp);

  -- a project with no defaults at all still inserts, and price_as_of defaults to today
  INSERT INTO estimation_projects (name) VALUES ('EST PROJ') RETURNING id, price_as_of INTO proj, pasof;
  IF pasof IS NULL THEN RAISE EXCEPTION 'price_as_of was not defaulted'; END IF;
  UPDATE estimation_projects SET default_series_id = ser, default_finish_id = fin, default_infill_id = inf,
    default_hardware_set_id = setp, default_thickness_mm = 1.2, labour_per_sqm = 0, profit_pct = 15 WHERE id = proj;
  SELECT count(*) INTO n FROM estimation_projects WHERE id = proj AND labour_per_sqm = 0 AND default_thickness_mm = 1.2;
  IF n <> 1 THEN RAISE EXCEPTION 'project defaults did not round-trip (labour 0 must be stored as 0)'; END IF;

  -- an item that inherits everything: series/colour/thickness/infill/set all NULL
  INSERT INTO estimation_openings (project_id, opening_no, template_id, width_m, height_m)
    VALUES (proj, 'D1', tpl, 2, 2) RETURNING id INTO op;
  -- and one that overrides with catalog ids and an item name
  INSERT INTO estimation_openings (project_id, opening_no, template_id, width_m, height_m, series_id, alu_finish_id,
      hardware_set_id, thickness_mm, item_name, item_description, labour_per_sqm, profit_pct)
    VALUES (proj, 'D2', tpl, 2, 2, ser, fin, setp, 1.5, 'ประตู', 'รายละเอียด', 0, 20);

  -- explicit "none" flags are accepted, and cannot be combined with an explicit value
  UPDATE estimation_openings SET no_infill = true, no_hardware_set = true WHERE id = op;
  raised := false;
  BEGIN
    UPDATE estimation_openings SET infill_type_id = inf WHERE id = op;  -- no_infill is still true
  EXCEPTION WHEN check_violation THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'no_infill together with infill_type_id was allowed'; END IF;
  raised := false;
  BEGIN
    UPDATE estimation_openings SET hardware_set_id = setp WHERE id = op;  -- no_hardware_set is still true
  EXCEPTION WHEN check_violation THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'no_hardware_set together with hardware_set_id was allowed'; END IF;

  -- CHECK constraints
  raised := false;
  BEGIN UPDATE estimation_projects SET labour_per_sqm = -1 WHERE id = proj;
  EXCEPTION WHEN check_violation THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'negative project labour was allowed'; END IF;
  raised := false;
  BEGIN UPDATE estimation_projects SET profit_pct = 1001 WHERE id = proj;
  EXCEPTION WHEN check_violation THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'profit_pct over 1000 was allowed'; END IF;
  raised := false;
  BEGIN UPDATE estimation_projects SET default_thickness_mm = 0 WHERE id = proj;
  EXCEPTION WHEN check_violation THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'default_thickness_mm = 0 was allowed'; END IF;
  raised := false;
  BEGIN UPDATE estimation_openings SET labour_per_sqm = -5 WHERE id = op;
  EXCEPTION WHEN check_violation THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'negative item labour was allowed'; END IF;

  RESET role;
  RAISE NOTICE 'Test 1 (columns, defaults, checks): TEST PASSED';
END $$;

-- ── Test 2: delete behaviour (defaults are SET NULL, items RESTRICT) ──
DO $$
DECLARE
  ta UUID; tb UUID; tc UUID;
  prov UUID; ser UUID; ser2 UUID; fin UUID; setp UUID; typ UUID; tpl UUID; proj UUID; hw UUID; n INT; raised BOOLEAN;
BEGIN
  SELECT a_tenant, b_tenant, c_tenant INTO ta, tb, tc FROM _est_fx;
  SET LOCAL role = 'authenticated';
  SET LOCAL request.jwt.claims = '{"email":"__est_a__@example.com"}';

  SELECT id INTO prov FROM alu_providers WHERE name = 'EST P';
  SELECT id INTO ser FROM alu_series WHERE name = 'EST S';
  SELECT id INTO fin FROM alu_finishes WHERE name = 'EST F';
  SELECT id INTO setp FROM alu_parts WHERE name = 'EST SET';
  SELECT id INTO tpl FROM bom_templates WHERE name = 'EST TPL';
  SELECT id INTO proj FROM estimation_projects WHERE name = 'EST PROJ';

  -- a series used by an item cannot be deleted
  raised := false;
  BEGIN DELETE FROM alu_series WHERE id = ser;
  EXCEPTION WHEN foreign_key_violation THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'deleting a series used by an item was allowed'; END IF;

  -- a series used only as a project default can be deleted; the default becomes NULL
  INSERT INTO alu_series (provider_id, name) VALUES (prov, 'EST S2') RETURNING id INTO ser2;
  UPDATE estimation_projects SET default_series_id = ser2 WHERE id = proj;
  DELETE FROM alu_series WHERE id = ser2;
  SELECT count(*) INTO n FROM estimation_projects WHERE id = proj AND default_series_id IS NULL;
  IF n <> 1 THEN RAISE EXCEPTION 'project default series was not cleared on delete'; END IF;

  -- a colour used by an item cannot be deleted
  raised := false;
  BEGIN DELETE FROM alu_finishes WHERE id = fin;
  EXCEPTION WHEN foreign_key_violation THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'deleting a colour used by an item was allowed'; END IF;

  -- template hardware keeps working when its catalog part disappears (part_id -> NULL)
  -- (the set is still the project default and an item's set, so detach those first)
  UPDATE estimation_openings SET hardware_set_id = NULL WHERE hardware_set_id = setp;
  DELETE FROM alu_parts WHERE id = setp;
  SELECT count(*) INTO n FROM bom_template_hardware WHERE name = 'EST HW' AND part_id IS NULL;
  IF n <> 1 THEN RAISE EXCEPTION 'template hardware part_id was not cleared on part delete'; END IF;
  SELECT count(*) INTO n FROM estimation_projects WHERE id = proj AND default_hardware_set_id IS NULL;
  IF n <> 1 THEN RAISE EXCEPTION 'project default hardware set was not cleared on part delete'; END IF;

  RESET role;
  RAISE NOTICE 'Test 2 (delete behaviour): TEST PASSED';
END $$;

-- ── Test 3: other tenants see none of it ──
DO $$
DECLARE ta UUID; tb UUID; tc UUID; n INT; t TEXT;
BEGIN
  SELECT a_tenant, b_tenant, c_tenant INTO ta, tb, tc FROM _est_fx;
  SET LOCAL role = 'authenticated';
  SET LOCAL request.jwt.claims = '{"email":"__est_a__@example.com"}';
  SELECT count(*) INTO n FROM estimation_projects WHERE name = 'EST PROJ';
  IF n <> 1 THEN RAISE EXCEPTION 'tenant A should see its project, saw %', n; END IF;
  SELECT count(*) INTO n FROM estimation_openings WHERE item_name = 'ประตู';
  IF n <> 1 THEN RAISE EXCEPTION 'tenant A should see its item, saw %', n; END IF;

  FOREACH t IN ARRAY ARRAY['b','c'] LOOP
    PERFORM set_config('request.jwt.claims', format('{"email":"__est_%s__@example.com"}', t), true);
    SELECT count(*) INTO n FROM estimation_projects;
    IF n <> 0 THEN RAISE EXCEPTION 'tenant % sees % projects', t, n; END IF;
    SELECT count(*) INTO n FROM estimation_openings;
    IF n <> 0 THEN RAISE EXCEPTION 'tenant % sees % items', t, n; END IF;
  END LOOP;

  RESET role;
  RAISE NOTICE 'Test 3 (isolation): TEST PASSED';
END $$;
```

Note for the implementer: Test 3 relies on tenants B and C having no estimation rows of their own in this transaction (true: nothing inserts them) — but on the live database tenant rows are real, and the fixture tenants are brand new, so they have none. Keep the assertions as written.

- [ ] **Step 3: Write the owner script** (same shape as `run-alu-sql-tests.sh`, which you should read first). It builds one file `BEGIN; [catalog migrations 01..03 unless PHASE1_APPLIED=1]; expand migration; tests; SELECT 'ESTIMATION EXPAND TESTS PASSED' AS result; ROLLBACK;`, runs it with `npx supabase db query --project-ref kntspldhvcjeaubtqtkn --linked=false -f FILE`, then a persistence check `select (select count(*) from information_schema.columns where table_name='estimation_projects' and column_name='price_as_of') as expand_applied, (select count(*) from tenants where company_name like '__EST TEST%') as leftover` (expected `expand_applied = 0` before the owner applies the migration for real, `leftover = 0`).

```bash
#!/usr/bin/env bash
# Owner-run: ! bash .superpowers/sdd/2026-10-08-aluminium-cost-catalog-phase-1/run-estimation-expand-tests.sh
# Add PHASE1_APPLIED=1 in front once the alu catalog migrations 2026-10-10-01..03 are applied for real.
set -euo pipefail
cd "$(dirname "$0")/../../.."
REF=kntspldhvcjeaubtqtkn
OUT="$(mktemp -d)/est_expand_all.sql"
{
  echo 'BEGIN;'
  if [ "${PHASE1_APPLIED:-0}" != "1" ]; then
    for f in supabase/migrations/2026-10-10-0[123]-*.sql; do cat "$f"; done
  fi
  cat supabase/migrations/2026-10-11-01-estimation-catalog-expand.sql
  cat supabase/tests/estimation_expand_test.sql
  echo "SELECT 'ESTIMATION EXPAND TESTS PASSED' AS result;"
  echo 'ROLLBACK;'
} > "$OUT"
echo "== running in one rolled-back transaction (PHASE1_APPLIED=${PHASE1_APPLIED:-0})"
npx supabase db query --project-ref "$REF" --linked=false -f "$OUT"
echo "== persistence check (expect leftover = 0; expand_applied = 0 until you apply it for real)"
npx supabase db query --project-ref "$REF" --linked=false \
  "select (select count(*) from information_schema.columns where table_name='estimation_projects' and column_name='price_as_of') as expand_applied, (select count(*) from tenants where company_name like '__EST TEST%') as leftover"
```

- [ ] **Step 4: Static self-check (NO database access).** Re-read both SQL files against the Interfaces list: every column named exactly; every `ON DELETE` as listed; the two CHECK constraint names; test inserts supply every NOT NULL column that has no default (`bom_template_hardware.quantity_basis`, `estimation_openings.opening_no/template_id/width_m/height_m`, `infill_types.price_per_sqm`, `alu_parts.name`); no reference to a table or column that does not exist in migrations `2026-09-10-0[678]`, `2026-09-29-02`, `2026-10-10-0[123]`. Do not run anything against any database.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/2026-10-11-01-estimation-catalog-expand.sql supabase/tests/estimation_expand_test.sql
git commit -m "feat(estimation): additive columns for catalog-backed projects and items" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

(The owner script lives in the git-ignored workspace and is not committed.)

---

### Task 2: Catalog pricing module (`aluCatalogPricing.js`)

**Files:**
- Modify: `src/lib/aluPrice.js` (return `row_id`), `src/lib/aluPrice.test.js` (one new test)
- Create: `src/lib/aluCatalogPricing.js`, `src/lib/aluCatalogPricing.test.js`

**Interfaces:**
- Consumes: `resolveAluPrice`, `resolvePartPrice` from `./aluPrice.js`.
- Produces:
  - `resolveAluPrice(...)` results now include `row_id` (id of the price row used) for `per_kg` and `per_piece` outcomes.
  - `buildCatalogIndex(rows)` → `{ providers, series, profiles, finishes, parts (id→row maps), seriesProfilesBySeries, setItemsBySet, variants, kgPrices, piecePrices, partPrices }`. `rows` keys: `providers, series, profiles, seriesProfiles, finishes, variants, parts, setItems, kgPrices, piecePrices, partPrices` (arrays, any may be missing).
  - `resolveCatalogProfile(index, seriesId, family, thicknessMm)` → `{ profile, ambiguous }`.
  - `makeCatalogPricing({ index, seriesId, finishId, asOf })` → pricing object with `kind: 'catalog'`, `profileLine({ role_name, family, length_m, quantity, thickness_mm })`, `hardwarePrice(h)`, `setLines(setId)`. This is the `pricing` object `bomEngine` consumes (Task 3).
  - Profile line shape: `{ role_name, family, series_id, thickness_mm, length_m, quantity, weight_kg, cost, resolved, reason, ambiguous, profile_id?, basis?, price_per_m?, price_row_id }`. `reason` ∈ `no_series | no_finish | no_profile | no_provider | finish_other_provider | no_weight | no_kg_price | no_variant | no_piece_price | no_price | null`.
  - `hardwarePrice(h)` → `{ unit_price, source: 'part' | 'reference', price_row_id }`.
  - `setLines(setId)` → `[{ name, code, quantity, unit_price, cost, resolved, price_row_id }]`.

- [ ] **Step 1: Add `row_id` to `resolveAluPrice` (test first)**

Add to `src/lib/aluPrice.test.js` (inside the existing file; reuse its imports — it already imports `resolveAluPrice`):

```js
describe('resolveAluPrice -- row_id of the price row used', () => {
  const provider = { id: 'p', price_basis: 'both' }
  const profile = { id: 'pr', linear_weight_kg_per_m: 2, default_length_m: 6 }
  const finish = { id: 'f' }
  const variants = [{ id: 'v', profile_id: 'pr', finish_id: 'f', length_m: 6 }]

  it('per_kg result carries the id of the kg price row', () => {
    const kgPrices = [{ id: 'k1', provider_id: 'p', finish_id: 'f', series_id: null, profile_id: null, price_per_kg: 100, effective_from: '2026-01-01' }]
    const r = resolveAluPrice({ provider, series: null, profile, finish, variants, asOf: '2026-06-01', kgPrices, piecePrices: [] })
    expect(r.basis).toBe('per_kg')
    expect(r.row_id).toBe('k1')
  })

  it('per_piece result carries the id of the piece price row', () => {
    const piecePrices = [{ id: 'pc1', variant_id: 'v', price_per_piece: 600, effective_from: '2026-01-01' }]
    const r = resolveAluPrice({ provider, series: null, profile, finish, variants, asOf: '2026-06-01', kgPrices: [], piecePrices })
    expect(r.basis).toBe('per_piece')
    expect(r.row_id).toBe('pc1')
  })
})
```

Run `npx vitest run src/lib/aluPrice.test.js` → the two new tests FAIL (`row_id` undefined). Then in `src/lib/aluPrice.js` change the two success returns:

```js
        return { basis: 'per_kg', price_per_kg: kg.price_per_kg, price_per_m: kg.price_per_kg * weight, source: kg.source, row_id: kg.row.id }
```
```js
    return { basis: 'per_piece', price_per_piece: perPiece, price_per_m: perPiece / Number(variant.length_m), source: 'piece', variant_id: variant.id, row_id: row.id }
```
Run again → PASS, and every earlier test in the file still passes.

- [ ] **Step 2: Write the failing tests for the new module**

```js
// src/lib/aluCatalogPricing.test.js
import { describe, it, expect } from 'vitest'
import { buildCatalogIndex, resolveCatalogProfile, makeCatalogPricing } from './aluCatalogPricing.js'

const rows = () => ({
  providers: [{ id: 'p1', price_basis: 'per_kg' }, { id: 'p2', price_basis: 'per_piece' }],
  series: [{ id: 's1', provider_id: 'p1' }, { id: 's2', provider_id: 'p2' }],
  profiles: [
    { id: 'pr1', provider_id: 'p1', thickness_mm: 1.2, linear_weight_kg_per_m: 1.5, default_length_m: 6.4, active: true },
    { id: 'pr2', provider_id: 'p2', thickness_mm: 1.2, linear_weight_kg_per_m: 0.9, default_length_m: 6, active: true },
  ],
  seriesProfiles: [
    { id: 'l1', series_id: 's1', profile_id: 'pr1', family: 'Frame' },
    { id: 'l2', series_id: 's2', profile_id: 'pr2', family: 'Frame' },
  ],
  finishes: [{ id: 'f1', provider_id: 'p1' }, { id: 'f2', provider_id: 'p2' }],
  variants: [{ id: 'v2', profile_id: 'pr2', finish_id: 'f2', length_m: 6 }],
  parts: [
    { id: 'set1', name: 'Set', code: 'P-0001', kind: 'hardware_set' },
    { id: 'pt1', name: 'Lock', code: 'P-0002', kind: 'hardware' },
    { id: 'pt2', name: 'Hinge', code: 'P-0003', kind: 'hardware' },
  ],
  setItems: [{ id: 'i1', set_id: 'set1', part_id: 'pt1', quantity: 2 }, { id: 'i2', set_id: 'set1', part_id: 'pt2', quantity: 1 }],
  kgPrices: [
    { id: 'k1', provider_id: 'p1', finish_id: 'f1', series_id: null, profile_id: null, price_per_kg: 100, effective_from: '2026-01-01' },
    { id: 'k2', provider_id: 'p1', finish_id: 'f1', series_id: null, profile_id: null, price_per_kg: 120, effective_from: '2026-09-01' },
  ],
  piecePrices: [{ id: 'pc1', variant_id: 'v2', price_per_piece: 600, effective_from: '2026-01-01' }],
  partPrices: [{ id: 'pp1', part_id: 'pt1', list_price: 100, discount_pct: 10, effective_from: '2026-01-01' }],
})

describe('resolveCatalogProfile', () => {
  const index = buildCatalogIndex(rows())
  it('finds the profile linked to the series with that family and thickness', () => {
    expect(resolveCatalogProfile(index, 's1', 'Frame', 1.2).profile.id).toBe('pr1')
  })
  it('returns null for another thickness, family or series', () => {
    expect(resolveCatalogProfile(index, 's1', 'Frame', 1.5).profile).toBeNull()
    expect(resolveCatalogProfile(index, 's1', 'Other', 1.2).profile).toBeNull()
    expect(resolveCatalogProfile(index, 'nope', 'Frame', 1.2).profile).toBeNull()
  })
  it('skips inactive profiles', () => {
    const r = rows(); r.profiles[0].active = false
    expect(resolveCatalogProfile(buildCatalogIndex(r), 's1', 'Frame', 1.2).profile).toBeNull()
  })
  it('picks the lowest id and flags ambiguous when two profiles match', () => {
    const r = rows()
    r.profiles.push({ id: 'pr0', provider_id: 'p1', thickness_mm: 1.2, linear_weight_kg_per_m: 1.4, default_length_m: 6.4, active: true })
    r.seriesProfiles.push({ id: 'l3', series_id: 's1', profile_id: 'pr0', family: 'Frame' })
    const res = resolveCatalogProfile(buildCatalogIndex(r), 's1', 'Frame', 1.2)
    expect(res.profile.id).toBe('pr0')
    expect(res.ambiguous).toBe(true)
  })
})

describe('makeCatalogPricing.profileLine', () => {
  const index = buildCatalogIndex(rows())
  const line = (opts, input = {}) =>
    makeCatalogPricing({ index, seriesId: 's1', finishId: 'f1', asOf: '2026-06-01', ...opts })
      .profileLine({ role_name: 'Top rail', family: 'Frame', length_m: 2, quantity: 2, thickness_mm: 1.2, ...input })

  it('per_kg: weight x price, as of the date, with the price row id', () => {
    const l = line()
    expect(l.resolved).toBe(true)
    expect(l.weight_kg).toBeCloseTo(6)        // 2 m x 2 x 1.5 kg/m
    expect(l.cost).toBeCloseTo(600)           // 6 kg x 100
    expect(l.price_row_id).toBe('k1')
    expect(l.reason).toBeNull()
  })
  it('a price dated after asOf is ignored; a later asOf picks it up', () => {
    expect(line({ asOf: '2026-06-01' }).price_row_id).toBe('k1')
    expect(line({ asOf: '2026-10-01' }).cost).toBeCloseTo(720)
    expect(line({ asOf: '2026-10-01' }).price_row_id).toBe('k2')
  })
  it('per_piece: cost from the piece price spread over the stock length', () => {
    const l = line({ seriesId: 's2', finishId: 'f2' })
    expect(l.resolved).toBe(true)
    expect(l.basis).toBe('per_piece')
    expect(l.cost).toBeCloseTo(2 * 2 * (600 / 6))  // 400
    expect(l.weight_kg).toBeCloseTo(2 * 2 * 0.9)   // informational
    expect(l.price_row_id).toBe('pc1')
  })
  it('unresolved reasons are explicit and cost is 0 (never silent)', () => {
    expect(line({ seriesId: null })).toMatchObject({ resolved: false, reason: 'no_series', cost: 0 })
    expect(line({ finishId: null })).toMatchObject({ resolved: false, reason: 'no_finish', cost: 0 })
    expect(line({}, { family: 'Nope' })).toMatchObject({ resolved: false, reason: 'no_profile' })
    expect(line({}, { thickness_mm: 9 })).toMatchObject({ resolved: false, reason: 'no_profile' })
    expect(line({ asOf: '2025-01-01' })).toMatchObject({ resolved: false, reason: 'no_kg_price', cost: 0 })
  })
  it('a colour of another extruder is never priced (Review Focus 1)', () => {
    expect(line({ finishId: 'f2' })).toMatchObject({ resolved: false, reason: 'finish_other_provider', cost: 0 })
  })
  it('flags an ambiguous profile match on a resolved line (Review Focus 6)', () => {
    const r = rows()
    r.profiles.push({ id: 'pr0', provider_id: 'p1', thickness_mm: 1.2, linear_weight_kg_per_m: 1.4, default_length_m: 6.4, active: true })
    r.seriesProfiles.push({ id: 'l3', series_id: 's1', profile_id: 'pr0', family: 'Frame' })
    const l = makeCatalogPricing({ index: buildCatalogIndex(r), seriesId: 's1', finishId: 'f1', asOf: '2026-06-01' })
      .profileLine({ role_name: 'X', family: 'Frame', length_m: 1, quantity: 1, thickness_mm: 1.2 })
    expect(l.ambiguous).toBe(true)
    expect(l.profile_id).toBe('pr0')
  })
})

describe('makeCatalogPricing.hardwarePrice', () => {
  const pricing = makeCatalogPricing({ index: buildCatalogIndex(rows()), seriesId: 's1', finishId: 'f1', asOf: '2026-06-01' })
  it('uses the net part price when the hardware line points at a priced part', () => {
    expect(pricing.hardwarePrice({ part_id: 'pt1', reference_unit_price: 50 })).toMatchObject({ unit_price: 90, source: 'part', price_row_id: 'pp1' })
  })
  it('falls back to the reference price with no part, or a part with no price', () => {
    expect(pricing.hardwarePrice({ part_id: null, reference_unit_price: 50 })).toMatchObject({ unit_price: 50, source: 'reference', price_row_id: null })
    expect(pricing.hardwarePrice({ part_id: 'pt2', reference_unit_price: 40 })).toMatchObject({ unit_price: 40, source: 'reference' })
  })
})

describe('makeCatalogPricing.setLines', () => {
  const pricing = makeCatalogPricing({ index: buildCatalogIndex(rows()), seriesId: 's1', finishId: 'f1', asOf: '2026-06-01' })
  it('prices each set item; an unpriced part is listed unresolved with cost 0 (Review Focus 5)', () => {
    const lines = pricing.setLines('set1')
    expect(lines).toHaveLength(2)
    const lock = lines.find(l => l.name === 'Lock')
    const hinge = lines.find(l => l.name === 'Hinge')
    expect(lock).toMatchObject({ quantity: 2, unit_price: 90, cost: 180, resolved: true, code: 'P-0002' })
    expect(hinge).toMatchObject({ quantity: 1, cost: 0, resolved: false })
  })
  it('an unknown or empty set gives no lines', () => {
    expect(pricing.setLines('nope')).toEqual([])
    expect(pricing.setLines(null)).toEqual([])
  })
})
```

Run `npx vitest run src/lib/aluCatalogPricing.test.js` → FAIL (module not found).

- [ ] **Step 3: Implement**

```js
// src/lib/aluCatalogPricing.js
// Catalog-backed pricing for bomEngine: picks the profile for (series, family, thickness), prices it
// with the extruder's price basis as of a date, and prices hardware and hardware sets from the part
// price history. Pure: callers load the catalog tables once (useEstimationCatalog) and pass them in.
// Spec: 2026-10-08-aluminium-cost-catalog-design.md, Decision 7.
import { resolveAluPrice, resolvePartPrice } from './aluPrice.js'

function byId(list) {
  const m = {}
  for (const r of list || []) m[r.id] = r
  return m
}

function groupBy(list, key) {
  const m = {}
  for (const r of list || []) (m[r[key]] = m[r[key]] || []).push(r)
  return m
}

export function buildCatalogIndex(rows = {}) {
  return {
    providers: byId(rows.providers),
    series: byId(rows.series),
    profiles: byId(rows.profiles),
    finishes: byId(rows.finishes),
    parts: byId(rows.parts),
    seriesProfilesBySeries: groupBy(rows.seriesProfiles, 'series_id'),
    setItemsBySet: groupBy(rows.setItems, 'set_id'),
    variants: rows.variants || [],
    kgPrices: rows.kgPrices || [],
    piecePrices: rows.piecePrices || [],
    partPrices: rows.partPrices || [],
  }
}

// A series offers a profile in a role (family) through alu_series_profiles; the thickness lives on the
// profile row. The DB does not stop two profiles matching one tuple, so pick the lowest id and say so.
export function resolveCatalogProfile(index, seriesId, family, thicknessMm) {
  const links = (index.seriesProfilesBySeries[seriesId] || []).filter(l => l.family === family)
  const matches = links
    .map(l => index.profiles[l.profile_id])
    .filter(p => p && p.active !== false && Number(p.thickness_mm) === Number(thicknessMm))
    .sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1))
  if (!matches.length) return { profile: null, ambiguous: false }
  return { profile: matches[0], ambiguous: matches.length > 1 }
}

export function makeCatalogPricing({ index, seriesId, finishId, asOf }) {
  const series = index.series[seriesId] || null
  const finish = index.finishes[finishId] || null

  return {
    kind: 'catalog',

    profileLine({ role_name, family, length_m, quantity, thickness_mm }) {
      const base = {
        role_name, family, series_id: seriesId || null, thickness_mm, length_m, quantity,
        weight_kg: 0, cost: 0, resolved: false, reason: null, ambiguous: false, price_row_id: null,
      }
      if (!series) return { ...base, reason: 'no_series' }
      if (!finish) return { ...base, reason: 'no_finish' }
      const { profile, ambiguous } = resolveCatalogProfile(index, seriesId, family, thickness_mm)
      if (!profile) return { ...base, reason: 'no_profile' }
      const provider = index.providers[profile.provider_id]
      if (!provider) return { ...base, profile_id: profile.id, reason: 'no_provider' }
      if (finish.provider_id !== profile.provider_id) return { ...base, profile_id: profile.id, reason: 'finish_other_provider' }
      const price = resolveAluPrice({
        provider, series, profile, finish, variants: index.variants, asOf,
        kgPrices: index.kgPrices, piecePrices: index.piecePrices,
      })
      if (price.unresolved) return { ...base, profile_id: profile.id, reason: price.reason }
      return {
        ...base, profile_id: profile.id, ambiguous, resolved: true, basis: price.basis,
        price_per_m: price.price_per_m,
        weight_kg: length_m * quantity * Number(profile.linear_weight_kg_per_m),
        cost: length_m * quantity * price.price_per_m,
        price_row_id: price.row_id ?? null,
      }
    },

    // h is a bom_template_hardware row. A priced catalog part wins; otherwise the reference price stays.
    hardwarePrice(h) {
      if (h.part_id) {
        const p = resolvePartPrice({ partId: h.part_id, asOf, partPrices: index.partPrices })
        if (p) return { unit_price: p.net_price, source: 'part', price_row_id: p.row.id }
      }
      return { unit_price: Number(h.reference_unit_price) || 0, source: 'reference', price_row_id: null }
    },

    setLines(setId) {
      if (!setId) return []
      return (index.setItemsBySet[setId] || []).map(item => {
        const part = index.parts[item.part_id]
        const p = resolvePartPrice({ partId: item.part_id, asOf, partPrices: index.partPrices })
        const quantity = Number(item.quantity)
        return {
          name: part ? part.name : '?', code: part ? part.code : null, quantity,
          unit_price: p ? p.net_price : 0, cost: p ? quantity * p.net_price : 0,
          resolved: !!p, price_row_id: p ? p.row.id : null,
        }
      })
    },
  }
}
```

- [ ] **Step 4: Run to green**

Run: `npx vitest run src/lib/aluCatalogPricing.test.js src/lib/aluPrice.test.js` → all PASS. Then `npm test` → whole suite PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/aluPrice.js src/lib/aluPrice.test.js src/lib/aluCatalogPricing.js src/lib/aluCatalogPricing.test.js
git commit -m "feat(alu-catalog): catalog pricing for the BOM engine (profiles by series/family/thickness, hardware, sets)" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Rewire `bomEngine` to a pricing object

**Files:**
- Modify: `src/lib/bomEngine.js`, `src/lib/bomEngine.test.js`, `src/pages/Estimation.jsx` (the import line and the two `computeBomForOpening` calls only)

**Interfaces:**
- Consumes: the `pricing` object from Task 2 (`profileLine`, `hardwarePrice`, optional `setLines`).
- Produces:
  - `computeBomForOpening(opening, template, components, hardware, pricing, infillType)` (the old `(profiles, finish)` pair is replaced by `pricing`; `infillType` moves from 7th to 6th argument).
  - `legacyPricing(profiles, finish)` → a pricing object reproducing today's behaviour exactly (match by `family + opening.series + thickness_mm`, cost = kg × `finish.price_per_kg`, hardware at `reference_unit_price`, no sets).
  - `resolveGrid(template, opening)` is now exported (used by Task 5).
  - `opening` may carry `hardware_set_id` (resolved effective id or null) and `labour_per_sqm` (resolved effective rate or null → falls back to `template.labor_price_per_sqm`).
  - Result adds `hardwareSetLines` (each `{ name, code, quantity, unit_price, cost, resolved, price_row_id }`), `unresolvedDetails: [{ name, reason }]`; `hardwareLines[i]` gains `price_source` and `price_row_id`; `profileLines`/`gridLines` entries gain `reason`, `profile_id`, `price_row_id`; `totalCost` includes set lines; `unresolvedComponents` (array of names) also lists set parts that have no price.

- [ ] **Step 1: Update the existing tests mechanically, then add new ones (all must fail to compile first)**

In `src/lib/bomEngine.test.js`: change the import to `import { computeBomForOpening, combineOpeningBoms, legacyPricing } from './bomEngine.js'` and rewrite every call of the old shape

`computeBomForOpening(<opening>, <template>, <components>, <hardware>, [PROFILE], FINISH, <infill>)`

to

`computeBomForOpening(<opening>, <template>, <components>, <hardware>, legacyPricing([PROFILE], FINISH), <infill>)`

(any call that passes a different profiles array or finish keeps those: `legacyPricing(<profiles>, <finish>)`). Do not change any expected value. Then append:

```js
import { buildCatalogIndex, makeCatalogPricing } from './aluCatalogPricing.js'

describe('computeBomForOpening -- catalog pricing', () => {
  const rows = {
    providers: [{ id: 'p1', price_basis: 'per_kg' }],
    series: [{ id: 's1', provider_id: 'p1' }],
    profiles: [{ id: 'pr1', provider_id: 'p1', thickness_mm: 1.2, linear_weight_kg_per_m: 1.5, default_length_m: 6.4, active: true }],
    seriesProfiles: [{ id: 'l1', series_id: 's1', profile_id: 'pr1', family: 'Frame' }],
    finishes: [{ id: 'f1', provider_id: 'p1' }],
    parts: [
      { id: 'set1', name: 'Set', code: 'P-0001', kind: 'hardware_set' },
      { id: 'pt1', name: 'Lock', code: 'P-0002', kind: 'hardware' },
      { id: 'pt2', name: 'Hinge', code: 'P-0003', kind: 'hardware' },
    ],
    setItems: [{ id: 'i1', set_id: 'set1', part_id: 'pt1', quantity: 2 }, { id: 'i2', set_id: 'set1', part_id: 'pt2', quantity: 1 }],
    kgPrices: [{ id: 'k1', provider_id: 'p1', finish_id: 'f1', series_id: null, profile_id: null, price_per_kg: 100, effective_from: '2026-01-01' }],
    partPrices: [{ id: 'pp1', part_id: 'pt1', list_price: 100, discount_pct: 10, effective_from: '2026-01-01' }],
  }
  const pricing = (asOf = '2026-06-01') => makeCatalogPricing({ index: buildCatalogIndex(rows), seriesId: 's1', finishId: 'f1', asOf })
  const rail = { role_name: 'Top rail', profile_family: 'Frame', length_rule_type: 'width', length_deduction_mm: 0, quantity_basis: 'fixed', quantity_value: 1 }
  const opening = (o = {}) => baseOpening({ thickness_mm: 1.2, ...o })

  it('prices aluminium from the catalog and adds waste', () => {
    const r = computeBomForOpening(opening(), baseTemplate(), [rail], [], pricing(), null)
    expect(r.profileLines[0].cost).toBeCloseTo(300)   // 2 m x 1.5 kg/m x 100
    expect(r.wasteCost).toBeCloseTo(30)
    expect(r.totalCost).toBeCloseTo(330)
    expect(r.unresolvedComponents).toEqual([])
  })

  it('an unresolved profile is listed with its reason and costs 0', () => {
    const r = computeBomForOpening(opening(), baseTemplate(), [{ ...rail, profile_family: 'Nope' }], [], pricing(), null)
    expect(r.unresolvedComponents).toEqual(['Top rail'])
    expect(r.unresolvedDetails).toEqual([{ name: 'Top rail', reason: 'no_profile' }])
    expect(r.totalCost).toBe(0)
  })

  it('labour: the opening rate (even 0) beats the template rate; null falls back to the template', () => {
    const tpl = baseTemplate({ labor_price_per_sqm: 100 })
    expect(computeBomForOpening(opening({ labour_per_sqm: 500 }), tpl, [], [], pricing(), null).laborCost).toBeCloseTo(2000)
    expect(computeBomForOpening(opening({ labour_per_sqm: 0 }), tpl, [], [], pricing(), null).laborCost).toBe(0)
    expect(computeBomForOpening(opening({ labour_per_sqm: null }), tpl, [], [], pricing(), null).laborCost).toBeCloseTo(400)
    expect(computeBomForOpening(opening(), tpl, [], [], pricing(), null).laborCost).toBeCloseTo(400)
  })

  it('template hardware linked to a priced part uses the part price, else the reference price', () => {
    const hw = [
      { name: 'Lock', part_id: 'pt1', reference_unit_price: 50, quantity_basis: 'fixed', quantity_value: 2 },
      { name: 'Hinge', part_id: null, reference_unit_price: 30, quantity_basis: 'fixed', quantity_value: 1 },
    ]
    const r = computeBomForOpening(opening(), baseTemplate(), [], hw, pricing(), null)
    expect(r.hardwareLines[0]).toMatchObject({ cost: 180, price_source: 'part', price_row_id: 'pp1' })
    expect(r.hardwareLines[1]).toMatchObject({ cost: 30, price_source: 'reference' })
  })

  it('a hardware set adds its priced parts; an unpriced part is listed unresolved, not silently free (Review Focus 5)', () => {
    const r = computeBomForOpening(opening({ hardware_set_id: 'set1' }), baseTemplate(), [], [], pricing(), null)
    expect(r.hardwareSetLines).toHaveLength(2)
    expect(r.hardwareSetLines.find(l => l.name === 'Lock').cost).toBe(180)
    expect(r.unresolvedComponents).toEqual(['Hinge'])
    expect(r.unresolvedDetails).toEqual([{ name: 'Hinge', reason: 'no_part_price' }])
    expect(r.totalCost).toBeCloseTo(180)
  })

  it('no hardware_set_id means no set lines (legacy pricing never has sets)', () => {
    const r = computeBomForOpening(opening(), baseTemplate(), [], [], pricing(), null)
    expect(r.hardwareSetLines).toEqual([])
    const legacy = computeBomForOpening(baseOpening({ hardware_set_id: 'set1' }), baseTemplate(), [], [], legacyPricing([PROFILE], FINISH), null)
    expect(legacy.hardwareSetLines).toEqual([])
  })

  it('price rows used are reported so a later "as of today" run can be compared', () => {
    const r = computeBomForOpening(opening({ hardware_set_id: 'set1' }), baseTemplate(), [rail], [], pricing(), null)
    expect(r.profileLines[0].price_row_id).toBe('k1')
    expect(r.hardwareSetLines.find(l => l.name === 'Lock').price_row_id).toBe('pp1')
  })
})
```

Run `npx vitest run src/lib/bomEngine.test.js` → FAIL (`legacyPricing` is not exported, signature differs).

- [ ] **Step 2: Implement the engine changes**

Replace `resolveProfile`, `priceProfileLine` and the head of `computeBomForOpening`; keep `computeComponentLength`, `combineOpeningBoms` and the infill block as they are. Export `resolveGrid`. Full replacement of the changed parts:

```js
// resolveGrid: keep the existing function body exactly as it is and only add `export` in front of it.
// resolveProfile is deleted (legacyPricing below replaces it).

// Today's behaviour as a pricing object: the profile is matched by (family, series text, thickness)
// and costed as kg x the colour's price_per_kg. Kept until Phase 2b retires the legacy tables.
export function legacyPricing(profiles, finish) {
  return {
    kind: 'legacy',
    profileLine({ role_name, family, length_m, quantity, thickness_mm, opening }) {
      const profile = (profiles || []).find(p => p.family === family && p.series === opening.series && p.thickness_mm === thickness_mm) || null
      const resolved = !!profile
      const weight_kg = resolved ? length_m * quantity * profile.linear_weight_kg_per_m : 0
      const cost = resolved ? weight_kg * finish.price_per_kg : 0
      return {
        role_name, family, series: opening.series, thickness_mm, length_m, quantity, weight_kg, cost, resolved,
        reason: resolved ? null : 'no_profile', price_row_id: null,
      }
    },
    hardwarePrice(h) {
      return { unit_price: h.reference_unit_price, source: 'reference', price_row_id: null }
    },
    setLines() { return [] },
  }
}

function priceProfileLine({ role_name, family, length_m, quantity, pricing, opening }) {
  return pricing.profileLine({ role_name, family, length_m, quantity, thickness_mm: opening.thickness_mm, opening })
}

export function computeBomForOpening(opening, template, components, hardware, pricing, infillType) {
  const { rowCount, columnCount, cells } = resolveGrid(template, opening)

  // Grid-derived internal members (Business logic Step 2).
  const gridLines = []
  if (rowCount > 1 && template.grid_horizontal_rail_family) {
    for (let i = 0; i < rowCount - 1; i++) {
      gridLines.push({
        orientation: 'horizontal',
        ...priceProfileLine({ role_name: 'Horizontal rail', family: template.grid_horizontal_rail_family, length_m: opening.width_m, quantity: 1, pricing, opening }),
      })
    }
  }
  if (columnCount > 1 && template.grid_vertical_mullion_family) {
    for (let i = 0; i < columnCount - 1; i++) {
      gridLines.push({
        orientation: 'vertical',
        ...priceProfileLine({ role_name: 'Vertical mullion', family: template.grid_vertical_mullion_family, length_m: opening.height_m, quantity: 1, pricing, opening }),
      })
    }
  }

  // Explicit components (Business logic Step 3).
  const profileLines = (components || []).map(c => {
    const length_m = computeComponentLength(c.length_rule_type, c.length_deduction_mm, opening.width_m, opening.height_m)
    const quantity = c.quantity_basis === 'per_cell' ? c.quantity_value * rowCount * columnCount : c.quantity_value
    return priceProfileLine({ role_name: c.role_name, family: c.profile_family, length_m, quantity, pricing, opening })
  })

  const unresolvedProfileLines = [...profileLines, ...gridLines].filter(l => !l.resolved)
  const aluminumSubtotal = [...profileLines, ...gridLines].reduce((s, l) => s + l.cost, 0)
  const wasteCost = aluminumSubtotal * (template.waste_pct / 100)

  const perimeter_m = 2 * (opening.width_m + opening.height_m)
  const hardwareLines = (hardware || []).map(h => {
    const quantity =
      h.quantity_basis === 'per_cell' ? h.quantity_value * rowCount * columnCount :
      h.quantity_basis === 'per_perimeter_m' ? h.quantity_value * perimeter_m :
      h.quantity_value
    const hp = pricing.hardwarePrice(h)
    return { name: h.name, quantity, cost: quantity * hp.unit_price, price_source: hp.source, price_row_id: hp.price_row_id }
  })

  // One hardware set per opening unit (Ruling: not scaled per cell). An unpriced part is listed, never hidden.
  const hardwareSetLines = opening.hardware_set_id && pricing.setLines ? pricing.setLines(opening.hardware_set_id) : []
  const unresolvedSetLines = hardwareSetLines.filter(l => !l.resolved)

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

  // Labour: the opening's effective rate (resolved by the caller: item -> project -> type default; 0 is a
  // real value) wins; null/undefined falls back to the template's own rate.
  const labourRate = Number.isFinite(opening.labour_per_sqm) ? opening.labour_per_sqm : template.labor_price_per_sqm
  const laborCost = opening.width_m * opening.height_m * labourRate
  const siliconeCost = perimeter_m * template.silicone_price_per_m
  const feltCost = perimeter_m * template.felt_price_per_m

  const extraLinesCost = (opening.extra_lines || []).reduce((s, l) => s + l.amount, 0)

  const totalCost = aluminumSubtotal + wasteCost + hardwareLines.reduce((s, l) => s + l.cost, 0)
    + hardwareSetLines.reduce((s, l) => s + l.cost, 0) + infillCost
    + laborCost + siliconeCost + feltCost + extraLinesCost

  return {
    profileLines, gridLines, hardwareLines, hardwareSetLines, infillArea_sqm, infillCost, wasteCost,
    laborCost, siliconeCost, feltCost, extraLinesCost, totalCost,
    unresolvedComponents: [...unresolvedProfileLines.map(l => l.role_name), ...unresolvedSetLines.map(l => l.name)],
    unresolvedDetails: [
      ...unresolvedProfileLines.map(l => ({ name: l.role_name, reason: l.reason })),
      ...unresolvedSetLines.map(l => ({ name: l.name, reason: 'no_part_price' })),
    ],
  }
}
```

(`combineOpeningBoms` stays exactly as is.)

In `src/pages/Estimation.jsx` make only these edits: import `legacyPricing` next to `computeBomForOpening, combineOpeningBoms`; change the two calls to

```js
return computeBomForOpening(numericOpening, template, templateComponents, templateHardware, legacyPricing(profiles || [], finish), infillType || null)
```
```js
return computeBomForOpening(numericAddon, addonTemplate, addonComponents, addonHardware, legacyPricing(profiles || [], finish), infillType || null)
```

- [ ] **Step 3: Run to green**

Run `npx vitest run src/lib/bomEngine.test.js` → every old test (unchanged expectations) and the new ones PASS. Then `npm test` and `npm run build` → PASS (the build proves `Estimation.jsx` still compiles and imports resolve).

- [ ] **Step 4: Commit**

```bash
git add src/lib/bomEngine.js src/lib/bomEngine.test.js src/pages/Estimation.jsx
git commit -m "feat(estimation): bomEngine prices through a pricing object (catalog or legacy), hardware sets, labour override" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Inheritance, availability and add-on filtering (`estimationInherit.js`)

**Files:**
- Create: `src/lib/estimationInherit.js`, `src/lib/estimationInherit.test.js`

**Interfaces:**
- Consumes: plain rows (`estimation_projects`, `estimation_openings`, `bom_templates`, `door_window_types`, `alu_series_types`).
- Produces:
  - `resolveItemInputs(item, project, template, typesById)` → `{ series_id, finish_id, infill_type_id, hardware_set_id, thickness_mm, labour_per_sqm, profit_pct }` (each `null` when nothing resolves). `finish_id` here is the catalog colour (`item.alu_finish_id ?? project.default_finish_id`).
  - `typeAvailability(template, seriesId, seriesTypes)` → `'ok' | 'not_offered' | 'unknown'`.
  - `addonTemplatesForSeries(templates, seriesId, seriesTypes)` → active templates whose availability is not `'not_offered'`.
  - `itemsAffectedByDefaultSeries(items, templatesById, newSeriesId, seriesTypes)` → items that inherit the series (`series_id == null`) and whose main or add-on template is `'not_offered'` in the new series.

- [ ] **Step 1: Write the failing tests**

```js
// src/lib/estimationInherit.test.js
import { describe, it, expect } from 'vitest'
import { resolveItemInputs, typeAvailability, addonTemplatesForSeries, itemsAffectedByDefaultSeries } from './estimationInherit.js'

const project = { default_series_id: 's1', default_finish_id: 'f1', default_infill_id: 'i1', default_hardware_set_id: 'h1', default_thickness_mm: 1.2, labour_per_sqm: 250, profit_pct: 15 }
const types = { t1: { id: 't1', default_labour_per_sqm: 300 }, t0: { id: 't0', default_labour_per_sqm: 0 } }
const tpl = { id: 'tp1', type_id: 't1' }

describe('resolveItemInputs', () => {
  it('an empty item inherits everything from the project', () => {
    expect(resolveItemInputs({}, project, tpl, types)).toEqual({
      series_id: 's1', finish_id: 'f1', infill_type_id: 'i1', hardware_set_id: 'h1', thickness_mm: 1.2, labour_per_sqm: 250, profit_pct: 15,
    })
  })
  it('explicit item values win', () => {
    const item = { series_id: 's2', alu_finish_id: 'f2', infill_type_id: 'i2', hardware_set_id: 'h2', thickness_mm: 1.5, labour_per_sqm: 100, profit_pct: 20 }
    expect(resolveItemInputs(item, project, tpl, types)).toEqual({
      series_id: 's2', finish_id: 'f2', infill_type_id: 'i2', hardware_set_id: 'h2', thickness_mm: 1.5, labour_per_sqm: 100, profit_pct: 20,
    })
  })
  it('"no infill" / "no hardware set" flags beat the project default (Review Focus 4)', () => {
    const r = resolveItemInputs({ no_infill: true, no_hardware_set: true }, project, tpl, types)
    expect(r.infill_type_id).toBeNull()
    expect(r.hardware_set_id).toBeNull()
  })
  it('a labour rate of 0 is a real value at item and project level (Review Focus 7)', () => {
    expect(resolveItemInputs({ labour_per_sqm: 0 }, project, tpl, types).labour_per_sqm).toBe(0)
    expect(resolveItemInputs({}, { ...project, labour_per_sqm: 0 }, tpl, types).labour_per_sqm).toBe(0)
  })
  it('labour falls back item -> project -> type default (> 0) -> null', () => {
    const noLabour = { ...project, labour_per_sqm: null }
    expect(resolveItemInputs({}, noLabour, tpl, types).labour_per_sqm).toBe(300)
    expect(resolveItemInputs({}, noLabour, { id: 'x', type_id: 't0' }, types).labour_per_sqm).toBeNull()
    expect(resolveItemInputs({}, noLabour, { id: 'x', type_id: null }, types).labour_per_sqm).toBeNull()
    expect(resolveItemInputs({}, noLabour, null, types).labour_per_sqm).toBeNull()
  })
  it('missing everywhere gives nulls, never undefined', () => {
    expect(resolveItemInputs({}, {}, null, {})).toEqual({
      series_id: null, finish_id: null, infill_type_id: null, hardware_set_id: null, thickness_mm: null, labour_per_sqm: null, profit_pct: null,
    })
  })
})

describe('typeAvailability', () => {
  const seriesTypes = [{ series_id: 's1', type_id: 't1' }]
  it('ok when the series offers the template type', () => {
    expect(typeAvailability({ type_id: 't1' }, 's1', seriesTypes)).toBe('ok')
  })
  it('not_offered when the series lacks it', () => {
    expect(typeAvailability({ type_id: 't1' }, 's2', seriesTypes)).toBe('not_offered')
  })
  it('unknown when the template has no type, there is no template, or no series', () => {
    expect(typeAvailability({ type_id: null }, 's1', seriesTypes)).toBe('unknown')
    expect(typeAvailability(null, 's1', seriesTypes)).toBe('unknown')
    expect(typeAvailability({ type_id: 't1' }, null, seriesTypes)).toBe('unknown')
  })
})

describe('addonTemplatesForSeries', () => {
  const seriesTypes = [{ series_id: 's1', type_id: 't1' }]
  const templates = [
    { id: 'a', type_id: 't1', active: true },
    { id: 'b', type_id: 't2', active: true },
    { id: 'c', type_id: null, active: true },
    { id: 'd', type_id: 't1', active: false },
  ]
  it('lists active templates the series offers, plus untyped ones; hides the not-offered and inactive', () => {
    expect(addonTemplatesForSeries(templates, 's1', seriesTypes).map(t => t.id)).toEqual(['a', 'c'])
  })
  it('with no series nothing can be judged, so all active templates are listed', () => {
    expect(addonTemplatesForSeries(templates, null, seriesTypes).map(t => t.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('itemsAffectedByDefaultSeries', () => {
  const seriesTypes = [{ series_id: 'new', type_id: 't1' }]
  const templatesById = { tp1: { id: 'tp1', type_id: 't1' }, tp2: { id: 'tp2', type_id: 't2' }, tpU: { id: 'tpU', type_id: null } }
  const items = [
    { id: 'i1', series_id: null, template_id: 'tp1' },                       // offered -> fine
    { id: 'i2', series_id: null, template_id: 'tp2' },                       // not offered -> affected
    { id: 'i3', series_id: 'own', template_id: 'tp2' },                      // overrides the series -> not affected
    { id: 'i4', series_id: null, template_id: 'tp1', addon_template_id: 'tp2' }, // add-on not offered -> affected
    { id: 'i5', series_id: null, template_id: 'tpU' },                       // untyped -> cannot judge
  ]
  it('lists only items that inherit the series and whose template or add-on is not offered (Review Focus 2)', () => {
    expect(itemsAffectedByDefaultSeries(items, templatesById, 'new', seriesTypes).map(i => i.id)).toEqual(['i2', 'i4'])
  })
  it('with no new series nothing is affected', () => {
    expect(itemsAffectedByDefaultSeries(items, templatesById, null, seriesTypes)).toEqual([])
  })
})
```

Run `npx vitest run src/lib/estimationInherit.test.js` → FAIL (module not found).

- [ ] **Step 2: Implement**

```js
// src/lib/estimationInherit.js
// Inheritance by NULL (spec Decision 1) and the availability checks (Decisions 2 and 5). Pure.
// A project default is used when the item leaves the field NULL. Infill and hardware set also have an
// explicit "none" flag on the item, because NULL already means "inherit".

const isSet = v => v !== null && v !== undefined && v !== ''
const first = (...vals) => { for (const v of vals) if (isSet(v)) return v; return null }

export function resolveItemInputs(item, project, template, typesById) {
  const it = item || {}
  const pj = project || {}
  const type = template && template.type_id ? (typesById || {})[template.type_id] : null
  const typeLabour = type && Number(type.default_labour_per_sqm) > 0 ? Number(type.default_labour_per_sqm) : null
  return {
    series_id: first(it.series_id, pj.default_series_id),
    finish_id: first(it.alu_finish_id, pj.default_finish_id),
    infill_type_id: it.no_infill ? null : first(it.infill_type_id, pj.default_infill_id),
    hardware_set_id: it.no_hardware_set ? null : first(it.hardware_set_id, pj.default_hardware_set_id),
    thickness_mm: first(it.thickness_mm, pj.default_thickness_mm),
    labour_per_sqm: first(it.labour_per_sqm, pj.labour_per_sqm, typeLabour),
    profit_pct: first(it.profit_pct, pj.profit_pct),
  }
}

// 'unknown' = cannot judge (no type on the template, no template, or no series yet); never a hard block.
export function typeAvailability(template, seriesId, seriesTypes) {
  if (!template || !template.type_id || !seriesId) return 'unknown'
  const offered = (seriesTypes || []).some(st => st.series_id === seriesId && st.type_id === template.type_id)
  return offered ? 'ok' : 'not_offered'
}

export function addonTemplatesForSeries(templates, seriesId, seriesTypes) {
  return (templates || []).filter(t => t.active !== false && typeAvailability(t, seriesId, seriesTypes) !== 'not_offered')
}

// Items that will inherit newSeriesId (their own series_id is null) but whose template or add-on
// that series does not offer. Used to list what a default-series change affects.
export function itemsAffectedByDefaultSeries(items, templatesById, newSeriesId, seriesTypes) {
  if (!newSeriesId) return []
  return (items || []).filter(item => {
    if (item.series_id) return false
    const main = typeAvailability((templatesById || {})[item.template_id], newSeriesId, seriesTypes)
    const addon = item.addon_template_id ? typeAvailability((templatesById || {})[item.addon_template_id], newSeriesId, seriesTypes) : 'unknown'
    return main === 'not_offered' || addon === 'not_offered'
  })
}
```

- [ ] **Step 3: Run to green**

Run `npx vitest run src/lib/estimationInherit.test.js` → PASS; then `npm test` → PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/estimationInherit.js src/lib/estimationInherit.test.js
git commit -m "feat(estimation): project-default inheritance, type availability and add-on filtering" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Drawing preview geometry (`framePreview.js`)

**Files:**
- Create: `src/lib/framePreview.js`, `src/lib/framePreview.test.js`

**Interfaces:**
- Consumes: `resolveGrid` from `./bomEngine.js` (exported in Task 3).
- Produces: `buildFramePreview({ template, width_m, height_m, panel_count, addon })` → `null` when the main width or height is not a positive number, else `{ viewBox: { width, height }, units: [{ kind: 'main' | 'addon', outer: {x,y,w,h}, inner: {x,y,w,h}, lines: [{x1,y1,x2,y2}] }], dims: [{ kind: 'width' | 'height', x1,y1,x2,y2, text, unit: 'main' | 'addon' }], scale }`. `addon` is `{ template, width_m, height_m, panel_count }` or omitted; the add-on is drawn stacked ABOVE the main unit (a fanlight over a door), centred on the wider of the two. Units: pixels at `scale` px per metre; margin 40 px on each side for the dimension labels; the longest side is fitted into a 280 × 220 px drawing area. Frame thickness drawn as the gap between `outer` and `inner`: `clamp(0.045 × min(outer.w, outer.h), 4, 10)` px, capped at a third of the short side. Interior grid lines are drawn as double lines 4 px apart (each member = two parallel lines).

- [ ] **Step 1: Write the failing tests**

```js
// src/lib/framePreview.test.js
import { describe, it, expect } from 'vitest'
import { buildFramePreview } from './framePreview.js'

const tpl = (o = {}) => ({ grid_row_weights: [1], ...o })

describe('buildFramePreview', () => {
  it('returns null when the size is missing or not positive', () => {
    expect(buildFramePreview({ template: tpl(), width_m: 0, height_m: 2, panel_count: 1 })).toBeNull()
    expect(buildFramePreview({ template: tpl(), width_m: 2, height_m: NaN, panel_count: 1 })).toBeNull()
    expect(buildFramePreview({ template: null, width_m: 2, height_m: 2, panel_count: 1 })).toBeNull()
  })

  it('fits a 2 x 1.5 m opening into the drawing area with a double-line frame', () => {
    const p = buildFramePreview({ template: tpl(), width_m: 2, height_m: 1.5, panel_count: 1 })
    expect(p.scale).toBeCloseTo(140)                       // min(280/2, 220/1.5)
    expect(p.units).toHaveLength(1)
    const u = p.units[0]
    expect(u.outer).toEqual({ x: 40, y: 40, w: 280, h: 210 })
    expect(u.inner.x).toBeCloseTo(40 + 9.45)               // 0.045 x min(280, 210) = 9.45
    expect(u.inner.w).toBeCloseTo(280 - 2 * 9.45)
    expect(u.lines).toEqual([])                            // one panel, one row: no interior members
    expect(p.viewBox).toEqual({ width: 360, height: 290 })
  })

  it('the frame thickness is clamped to 4..10 px', () => {
    const thin = buildFramePreview({ template: tpl(), width_m: 5, height_m: 0.5, panel_count: 1 }).units[0]   // 280 x 28 px
    expect(thin.inner.x - thin.outer.x).toBeCloseTo(4)
    const big = buildFramePreview({ template: tpl(), width_m: 1, height_m: 1, panel_count: 1 }).units[0]
    expect(big.inner.x - big.outer.x).toBeLessThanOrEqual(10)
  })

  it('a very thin opening still has a positive inner box', () => {
    const u = buildFramePreview({ template: tpl(), width_m: 5, height_m: 0.1, panel_count: 1 }).units[0]       // 280 x 5.6 px
    expect(u.inner.w).toBeGreaterThan(0)
    expect(u.inner.h).toBeGreaterThan(0)
  })

  it('3 panels draw 2 vertical members, each a double line (4 lines)', () => {
    const u = buildFramePreview({ template: tpl(), width_m: 3, height_m: 2, panel_count: 3 }).units[0]
    const vertical = u.lines.filter(l => l.x1 === l.x2)
    expect(vertical).toHaveLength(4)
    expect(u.lines).toHaveLength(4)
    // the two members sit at 1/3 and 2/3 of the inner width
    const xs = [...new Set(vertical.map(l => Math.round(l.x1)))]
    expect(xs.length).toBe(4)
  })

  it('row weights [1,2] draw one horizontal member at 1/3 of the inner height', () => {
    const u = buildFramePreview({ template: tpl({ grid_row_weights: [1, 2] }), width_m: 2, height_m: 3, panel_count: 1 }).units[0]
    const horizontal = u.lines.filter(l => l.y1 === l.y2)
    expect(horizontal).toHaveLength(2)                     // one member = two lines
    const mid = u.inner.y + u.inner.h / 3
    const ys = horizontal.map(l => l.y1)
    expect(Math.min(...ys)).toBeLessThan(mid)
    expect(Math.max(...ys)).toBeGreaterThan(mid)
  })

  it('stacks an add-on above the main unit and fits both', () => {
    const p = buildFramePreview({
      template: tpl(), width_m: 2, height_m: 2, panel_count: 1,
      addon: { template: tpl(), width_m: 2, height_m: 0.5, panel_count: 2 },
    })
    expect(p.units.map(u => u.kind)).toEqual(['addon', 'main'])
    const [addon, main] = p.units
    expect(addon.outer.y).toBeLessThan(main.outer.y)
    expect(addon.outer.y + addon.outer.h).toBeCloseTo(main.outer.y)   // touching
    expect(p.scale).toBeCloseTo(Math.min(280 / 2, 220 / 2.5))
    expect(main.outer.y + main.outer.h + 40).toBeLessThanOrEqual(p.viewBox.height + 1e-6)
  })

  it('reports dimensions as text in metres', () => {
    const p = buildFramePreview({ template: tpl(), width_m: 5.45, height_m: 2.7, panel_count: 1 })
    expect(p.dims.find(d => d.kind === 'width').text).toBe('5.45 ม.')
    expect(p.dims.find(d => d.kind === 'height').text).toBe('2.70 ม.')
  })

  it('an add-on with no usable size is ignored', () => {
    const p = buildFramePreview({ template: tpl(), width_m: 2, height_m: 2, panel_count: 1, addon: { template: tpl(), width_m: 0, height_m: 0.5, panel_count: 1 } })
    expect(p.units).toHaveLength(1)
  })
})
```

Run `npx vitest run src/lib/framePreview.test.js` → FAIL (module not found).

- [ ] **Step 2: Implement**

```js
// src/lib/framePreview.js
// Geometry for the type/add-on preview: a double-line frame (outer + inner rectangle), double-line
// interior members taken from the template grid, and dimension labels. Pure -- a screen draws the SVG.
import { resolveGrid } from './bomEngine.js'

const BOX_W = 280
const BOX_H = 220
const MARGIN = 40
const MEMBER_GAP = 4

const positive = n => Number.isFinite(n) && n > 0
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const metres = n => `${n.toFixed(2)} ม.`

function drawUnit(kind, template, w_m, h_m, panel_count, scale, x, y) {
  const outer = { x, y, w: w_m * scale, h: h_m * scale }
  // frame thickness 4..10 px, but never more than a third of the short side so a very thin opening keeps a positive inner box
  const t = Math.min(clamp(0.045 * Math.min(outer.w, outer.h), 4, 10), Math.min(outer.w, outer.h) / 3)
  const inner = { x: outer.x + t, y: outer.y + t, w: outer.w - 2 * t, h: outer.h - 2 * t }

  const { cells, columnCount } = resolveGrid(template, { width_m: w_m, height_m: h_m, panel_count })
  const totalH = cells.reduce((s, c) => s + c.height_m, 0)
  const lines = []
  let acc = 0
  for (let i = 0; i < cells.length - 1; i++) {                 // horizontal members between rows
    acc += cells[i].height_m
    const yy = inner.y + inner.h * (acc / totalH)
    lines.push({ x1: inner.x, y1: yy - MEMBER_GAP / 2, x2: inner.x + inner.w, y2: yy - MEMBER_GAP / 2 })
    lines.push({ x1: inner.x, y1: yy + MEMBER_GAP / 2, x2: inner.x + inner.w, y2: yy + MEMBER_GAP / 2 })
  }
  for (let c = 1; c < columnCount; c++) {                      // vertical members between columns
    const xx = inner.x + inner.w * (c / columnCount)
    lines.push({ x1: xx - MEMBER_GAP / 2, y1: inner.y, x2: xx - MEMBER_GAP / 2, y2: inner.y + inner.h })
    lines.push({ x1: xx + MEMBER_GAP / 2, y1: inner.y, x2: xx + MEMBER_GAP / 2, y2: inner.y + inner.h })
  }
  return { kind, outer, inner, lines }
}

export function buildFramePreview({ template, width_m, height_m, panel_count, addon }) {
  if (!template || !positive(width_m) || !positive(height_m)) return null
  const addonOk = addon && addon.template && positive(addon.width_m) && positive(addon.height_m)

  const totalW = addonOk ? Math.max(width_m, addon.width_m) : width_m
  const totalH = addonOk ? height_m + addon.height_m : height_m
  const scale = Math.min(BOX_W / totalW, BOX_H / totalH)

  const units = []
  let y = MARGIN
  if (addonOk) {
    const ax = MARGIN + ((totalW - addon.width_m) / 2) * scale
    units.push(drawUnit('addon', addon.template, addon.width_m, addon.height_m, addon.panel_count || 1, scale, ax, y))
    y += addon.height_m * scale
  }
  const mx = MARGIN + ((totalW - width_m) / 2) * scale
  units.push(drawUnit('main', template, width_m, height_m, panel_count || 1, scale, mx, y))

  const main = units[units.length - 1]
  const dims = [
    { kind: 'width', unit: 'main', x1: main.outer.x, y1: main.outer.y + main.outer.h + 20, x2: main.outer.x + main.outer.w, y2: main.outer.y + main.outer.h + 20, text: metres(width_m) },
    { kind: 'height', unit: 'main', x1: main.outer.x + main.outer.w + 20, y1: main.outer.y, x2: main.outer.x + main.outer.w + 20, y2: main.outer.y + main.outer.h, text: metres(height_m) },
  ]
  if (addonOk) {
    const a = units[0]
    dims.push({ kind: 'height', unit: 'addon', x1: a.outer.x + a.outer.w + 20, y1: a.outer.y, x2: a.outer.x + a.outer.w + 20, y2: a.outer.y + a.outer.h, text: metres(addon.height_m) })
  }

  return { viewBox: { width: totalW * scale + 2 * MARGIN, height: totalH * scale + 2 * MARGIN }, units, dims, scale }
}
```

- [ ] **Step 3: Run to green**

Run `npx vitest run src/lib/framePreview.test.js` → PASS; `npm test` → PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/framePreview.js src/lib/framePreview.test.js
git commit -m "feat(estimation): geometry for the double-line type preview with dimensions" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Stale-price detection (`staleProjectPrices.js`)

**Files:**
- Create: `src/lib/staleProjectPrices.js`, `src/lib/staleProjectPrices.test.js`

**Interfaces:**
- Consumes: BOM results from `computeBomForOpening` (Task 3) computed twice with the same inputs but different `asOf` (the project's `price_as_of` = "locked", and today = "current"), keyed by opening id (use `<id>:addon` as the key for an add-on BOM).
- Produces: `listPriceChanges(lockedByOpening, currentByOpening)` → `[{ opening_id, name, before, after }]`, one entry per priced line whose price row differs (`before`/`after` are price-row ids or `null`). A line that was unresolved and is resolved now (or the reverse) also counts. Lines are compared by position (the same inputs produce the same line order).

- [ ] **Step 1: Write the failing tests**

```js
// src/lib/staleProjectPrices.test.js
import { describe, it, expect } from 'vitest'
import { listPriceChanges } from './staleProjectPrices.js'

const bom = (o = {}) => ({
  profileLines: [{ role_name: 'Top rail', price_row_id: 'k1' }],
  gridLines: [],
  hardwareLines: [{ name: 'Lock', price_row_id: null }],
  hardwareSetLines: [{ name: 'Hinge', price_row_id: 'pp1' }],
  ...o,
})

describe('listPriceChanges', () => {
  it('reports nothing when the locked and current runs used the same price rows', () => {
    expect(listPriceChanges({ a: bom() }, { a: bom() })).toEqual([])
  })

  it('reports a line whose price row changed (a newer price took effect) (Review Focus 3)', () => {
    const current = bom({ profileLines: [{ role_name: 'Top rail', price_row_id: 'k2' }] })
    expect(listPriceChanges({ a: bom() }, { a: current })).toEqual([{ opening_id: 'a', name: 'Top rail', before: 'k1', after: 'k2' }])
  })

  it('covers grid, hardware and hardware-set lines too', () => {
    const locked = bom({ gridLines: [{ role_name: 'Mullion', price_row_id: 'g1' }] })
    const current = bom({
      gridLines: [{ role_name: 'Mullion', price_row_id: 'g2' }],
      hardwareLines: [{ name: 'Lock', price_row_id: 'pp9' }],
      hardwareSetLines: [{ name: 'Hinge', price_row_id: 'pp2' }],
    })
    const names = listPriceChanges({ a: locked }, { a: current }).map(c => c.name).sort()
    expect(names).toEqual(['Hinge', 'Lock', 'Mullion'])
  })

  it('a line that was unresolved and now has a price counts as a change (and the reverse)', () => {
    const locked = bom({ profileLines: [{ role_name: 'Top rail', price_row_id: null }] })
    expect(listPriceChanges({ a: locked }, { a: bom() })).toEqual([{ opening_id: 'a', name: 'Top rail', before: null, after: 'k1' }])
    expect(listPriceChanges({ a: bom() }, { a: locked })).toEqual([{ opening_id: 'a', name: 'Top rail', before: 'k1', after: null }])
  })

  it('keeps the openings apart and ignores ones missing from the current run', () => {
    const changed = bom({ profileLines: [{ role_name: 'Top rail', price_row_id: 'k2' }] })
    const out = listPriceChanges({ a: bom(), b: bom(), gone: bom() }, { a: changed, b: bom() })
    expect(out).toEqual([{ opening_id: 'a', name: 'Top rail', before: 'k1', after: 'k2' }])
  })

  it('tolerates missing arrays and legacy lines without price_row_id', () => {
    expect(listPriceChanges({ a: { profileLines: [{ role_name: 'X' }] } }, { a: { profileLines: [{ role_name: 'X' }] } })).toEqual([])
  })
})
```

Run → FAIL (module not found).

- [ ] **Step 2: Implement**

```js
// src/lib/staleProjectPrices.js
// Which priced lines would come out differently if the project's locked price date were today?
// Callers compute each opening's BOM twice (asOf = project.price_as_of, asOf = today) and pass both
// maps here. A line is "changed" when it used a different price row, or gained / lost a price.
// Spec Decision 3 ("มีราคาใหม่ N รายการ").

function priceLines(bom) {
  return [
    ...((bom && bom.profileLines) || []),
    ...((bom && bom.gridLines) || []),
    ...((bom && bom.hardwareLines) || []),
    ...((bom && bom.hardwareSetLines) || []),
  ]
}

export function listPriceChanges(lockedByOpening, currentByOpening) {
  const changes = []
  for (const [openingId, locked] of Object.entries(lockedByOpening || {})) {
    const current = (currentByOpening || {})[openingId]
    if (!current) continue
    const before = priceLines(locked)
    const after = priceLines(current)
    before.forEach((line, i) => {
      const next = after[i]
      if (!next) return
      const a = line.price_row_id ?? null
      const b = next.price_row_id ?? null
      if (a !== b) changes.push({ opening_id: openingId, name: line.role_name || line.name, before: a, after: b })
    })
  }
  return changes
}
```

- [ ] **Step 3: Run to green**

Run `npx vitest run src/lib/staleProjectPrices.test.js` → PASS; `npm test` → PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/staleProjectPrices.js src/lib/staleProjectPrices.test.js
git commit -m "feat(estimation): detect which priced lines changed since the project's locked price date" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: One hook to load the whole catalog, with a table-name check

**Files:**
- Modify: `src/hooks/useAluCatalog.js`
- Create: `src/lib/estimationCatalogTables.js`, `src/lib/estimationCatalogTables.test.js`

**Interfaces:**
- Consumes: `fetchCatalogRows` (`src/lib/catalogData.js`), `useQuery` (`src/hooks/useSupabase.js`), `buildCatalogIndex` (Task 2).
- Produces:
  - `ESTIMATION_CATALOG_TABLES` (constant): `{ providers: 'alu_providers', series: 'alu_series', seriesTypes: 'alu_series_types', types: 'door_window_types', profiles: 'alu_profiles', seriesProfiles: 'alu_series_profiles', finishes: 'alu_finishes', variants: 'alu_profile_variants', parts: 'alu_parts', setItems: 'alu_part_set_items', seriesParts: 'alu_series_parts', kgPrices: 'alu_kg_prices', piecePrices: 'alu_piece_prices', partPrices: 'alu_part_prices' }`.
  - `useEstimationCatalog()` → `{ data, loading, error, refetch, index }` where `data` is `{ providers: [...], series: [...], ... }` (same keys) and `index = buildCatalogIndex(data)` (null until loaded).

- [ ] **Step 1: Write the failing test** (it also guards against a typo'd table name, which would only show at runtime)

```js
// src/lib/estimationCatalogTables.test.js
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { ESTIMATION_CATALOG_TABLES } from './estimationCatalogTables.js'

const migrations = readdirSync('supabase/migrations')
  .filter(f => /^2026-10-10-0[123]-/.test(f))
  .map(f => readFileSync(`supabase/migrations/${f}`, 'utf8'))
  .join('\n')

describe('ESTIMATION_CATALOG_TABLES', () => {
  it('names only tables that the catalog migrations create', () => {
    for (const table of Object.values(ESTIMATION_CATALOG_TABLES)) {
      expect(migrations).toMatch(new RegExp(`CREATE TABLE ${table}\\b`))
    }
  })
  it('covers all 14 catalog tables exactly once', () => {
    const created = [...migrations.matchAll(/CREATE TABLE (\w+)/g)].map(m => m[1]).sort()
    expect(Object.values(ESTIMATION_CATALOG_TABLES).sort()).toEqual(created)
  })
  it('the keys are the ones buildCatalogIndex reads', () => {
    expect(Object.keys(ESTIMATION_CATALOG_TABLES)).toEqual(expect.arrayContaining([
      'providers', 'series', 'profiles', 'seriesProfiles', 'finishes', 'variants', 'parts', 'setItems', 'kgPrices', 'piecePrices', 'partPrices',
    ]))
  })
})
```

Run `npx vitest run src/lib/estimationCatalogTables.test.js` → FAIL (module not found).

- [ ] **Step 2: Implement**

```js
// src/lib/estimationCatalogTables.js
// Every catalog table the estimation screens read, keyed by the name buildCatalogIndex expects.
export const ESTIMATION_CATALOG_TABLES = {
  providers: 'alu_providers',
  series: 'alu_series',
  seriesTypes: 'alu_series_types',
  types: 'door_window_types',
  profiles: 'alu_profiles',
  seriesProfiles: 'alu_series_profiles',
  finishes: 'alu_finishes',
  variants: 'alu_profile_variants',
  parts: 'alu_parts',
  setItems: 'alu_part_set_items',
  seriesParts: 'alu_series_parts',
  kgPrices: 'alu_kg_prices',
  piecePrices: 'alu_piece_prices',
  partPrices: 'alu_part_prices',
}
```

Append to `src/hooks/useAluCatalog.js` (keep `useCatalogTable` as is; add `useMemo` to a new `react` import and the two lib imports):

```js
import { useMemo } from 'react'
import { ESTIMATION_CATALOG_TABLES } from '../lib/estimationCatalogTables.js'
import { buildCatalogIndex } from '../lib/aluCatalogPricing.js'

// Loads every catalog table once (paged past the 1000-row cap) so the estimation screens can price
// openings on every keystroke without further queries. `index` is null until the data has arrived.
export function useEstimationCatalog() {
  const query = useQuery(async () => {
    const entries = await Promise.all(
      Object.entries(ESTIMATION_CATALOG_TABLES).map(async ([key, table]) => [key, await fetchCatalogRows(supabase, table, 'id')]),
    )
    return Object.fromEntries(entries)
  }, [])
  const index = useMemo(() => (query.data ? buildCatalogIndex(query.data) : null), [query.data])
  return { ...query, index }
}
```

- [ ] **Step 3: Run to green**

Run `npx vitest run src/lib/estimationCatalogTables.test.js` → PASS; `npm test` and `npm run build` → PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/estimationCatalogTables.js src/lib/estimationCatalogTables.test.js src/hooks/useAluCatalog.js
git commit -m "feat(estimation): useEstimationCatalog loads the whole catalog once and builds the pricing index" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Phase 2a wrap-up — verify, hand to the owner, stop at the mockup gate

**Files:** none expected (fixes only if a check fails).

- [ ] **Step 1: Full automated check**

Run `npm test && npm run build`. Expected: all PASS, build succeeds.

- [ ] **Step 2: Legacy path unchanged**

Run `git diff --stat origin/main -- src/pages/AluminumProfiles.jsx src/pages/PurchaseOrders.jsx src/pages/BomTemplates.jsx` and compare to Phase 1: `AluminumProfiles.jsx` and `PurchaseOrders.jsx` empty; `BomTemplates.jsx` only the Phase 1 toolbar lines. `git diff origin/main -- src/pages/Estimation.jsx` shows only the import and the two `computeBomForOpening` calls from Task 3.

- [ ] **Step 3: Owner runs the SQL check (agent cannot).** Tell the owner to run, in this order (one line each, with `!`):

```
! bash .superpowers/sdd/2026-10-08-aluminium-cost-catalog-phase-1/run-estimation-expand-tests.sh
```
(add `PHASE1_APPLIED=1` in front once the Phase 1 migrations are applied for real). Expected: a row `ESTIMATION EXPAND TESTS PASSED`; persistence check `leftover = 0`.

Only after that, and only when the owner chooses, apply the migration for real. It is additive and safe to apply before or after the code deploys, but Phase 1's migrations 2026-10-10-01..03 must be applied first:

```
! npx supabase db query --project-ref kntspldhvcjeaubtqtkn --linked=false -f supabase/migrations/2026-10-11-01-estimation-catalog-expand.sql
```

- [ ] **Step 4: STOP at the gate.** Do not start Phase 2b. Publish a clickable mockup artifact of the Phase 2b screens (see outline) for the owner to comment on; write the Phase 2b plan only after reading those comments.

---

## Phase 2b outline (NOT planned in detail yet; written after the mockup gate)

Screens and changes, all FacadeX-only, all of which need the owner's comments on a mockup first:

1. **Project page:** default panel (series · colour · infill · hardware set · thickness · labour ฿/m² · profit %) using `resolveItemInputs`; series pickers labelled `ชื่อซีรีส์ · ชื่อโรงรีด`; changing the default series lists `itemsAffectedByDefaultSeries`; `price_as_of` set from the local date (`toLocaleDateString('en-CA')`) at project creation.
2. **Item add/edit modal** (pre-filled with the old data) with the six fields, "ใช้ค่าโปรเจกต์" checkboxes for colour / infill / hardware set (plus the explicit "none" flags), the double-line **preview** from `buildFramePreview`, add-on picker from `addonTemplatesForSeries`, availability warning from `typeAvailability`, per-item labour/profit override, unresolved-line messages in Thai from `reason` codes.
3. **Stale-price banner** ("มีราคาใหม่ N รายการ") from `listPriceChanges`; the "refresh to latest prices" button only if the owner asks for it in the mockup comments (the spec defers it).
4. **BomTemplates editor:** template `type_id` select; hardware line `part_id` select; the profile-family datalist reads the catalog's families instead of legacy `aluminum_profiles`.
5. **Contract migration (applied at deploy time only):** after the new code is live and `estimation_openings` has no rows relying on the legacy columns — guard with a `DO` block that aborts if any opening has `series_id IS NULL AND series IS NOT NULL` — drop `estimation_openings.series` and `finish_id`, drop `aluminum_finishes` and its hook/UI, delete `legacyPricing`, remove the legacy views left in `BomTemplates.jsx`.
6. Open owner questions for the gate: thickness inheritance (Ruling above); whether an item may override the series; whether a hardware set should scale per cell; whether the refresh button is wanted now; the "ลองคิดราคา" calculator (deferred from Phase 1).

## Self-Review

**Spec coverage (Phase 2 scope):** reshape projects/openings and repoint to the catalog (Task 1, expand step; contract in 2b); rewire `bomEngine` through `resolveAluPrice` / profile lookup via `alu_series_profiles` by `(series, family, thickness)` (Tasks 2–3); project defaults and inheritance by NULL (Tasks 1, 4); availability warning logic (Task 4); add-on filtered by the main item's series (Task 4); preview geometry (Task 5); stale-price banner logic (Task 6); series label helpers already exist from Phase 1. UI for all of these is Phase 2b by the owner's mockup-first rule. Phase 3 items (cost settings, price structure, export) are not touched except `profit_pct` storage.

**Placeholder scan:** every code step carries its code; the only deferred item is Phase 2b, which is explicitly outside this plan and gated on the owner.

**Type consistency:** `makeCatalogPricing(...)` (Task 2) returns `profileLine/hardwarePrice/setLines`, exactly what `computeBomForOpening` (Task 3) calls; line fields `price_row_id`, `reason`, `resolved` are produced in Task 2/`legacyPricing` and read in Task 3/6; `resolveGrid` exported in Task 3 is imported by Task 5; `buildCatalogIndex` keys in Task 2 match `ESTIMATION_CATALOG_TABLES` in Task 7; `resolveItemInputs` outputs (`series_id`, `finish_id`, `infill_type_id`, `hardware_set_id`, `thickness_mm`, `labour_per_sqm`, `profit_pct`) map onto the opening fields the engine reads (`thickness_mm`, `hardware_set_id`, `labour_per_sqm`) and the pricing factory args (`seriesId`, `finishId`).

**Review Focus coverage:** 1 → Task 2; 2 → Task 4; 3 → Tasks 2 and 6; 4 → Task 4; 5 → Tasks 2 and 3; 6 → Task 2; 7 → Task 4.
