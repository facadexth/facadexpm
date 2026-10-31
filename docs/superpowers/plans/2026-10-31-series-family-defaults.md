# Series Family Defaults + Hardware Set Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The project default picks a series family (ซีรีส์หลัก, e.g. ICONIQ EURO) instead of one series, every item gets the family's series that makes its door/window type (still changeable per item), the saved defaults card collapses to a one-line summary, and the hardware set page is rebuilt (no unit, hardware + consumables picked from stock at the latest purchase price, series links on the same page).

**Architecture:** Two additive migrations (families + `alu_series.series_family_id` + `estimation_projects.default_series_family_id` with the owner-approved seed; `alu_parts.inventory_item_id` + three SECURITY INVOKER functions). All selection logic is pure and tested: `src/lib/seriesFamily.js` (family keys, choices, "the family's series for this type", `withFamilyResolver`) and `src/lib/latestPurchasePrice.js` (tax invoice → PO → catalogue price). `resolveItemInputs` stays the single place every screen gets an item's series; callers receive a project wrapped once by `withFamilyResolver`, so no caller signature changes. UI tasks read only those helpers.

**Tech Stack:** React 18 + Vite, Supabase (PostgREST + plpgsql), vitest (SSR `react-dom/server` smoke tests; jsdom + `@testing-library/react` where a click is needed).

**Spec:** `docs/superpowers/specs/2026-10-31-series-family-defaults-design.md` (owner-approved 2026-10-31, binding). Mockups: collapsed card `/private/tmp/claude-501/-Users-plfx-code-FacadeXPM-facadex-app/b2f8c48c-54bd-40ef-b3cd-c4b9b6b00bea/scratchpad/defaults/project-defaults.html`, hardware set page `/private/tmp/claude-501/-Users-plfx-code-FacadeXPM-facadex-app/b2f8c48c-54bd-40ef-b3cd-c4b9b6b00bea/scratchpad/hwset/hwset.html`, family table v4 `/private/tmp/claude-501/-Users-plfx-code-FacadeXPM-facadex-app/b2f8c48c-54bd-40ef-b3cd-c4b9b6b00bea/scratchpad/families/series-families.html`. Where a mockup and the spec differ, the spec wins (e.g. the collapsed card's label is "ซีรีส์หลัก", the stock picker shows "ซื้อล่าสุด", not "ต้นทุนเฉลี่ย").

## Global Constraints

- Worktree `/Users/plfx/code/FacadeXPM/facadex-app/.claude/worktrees/series-family`, branch `feat/series-family`. Use absolute paths. Never bare `git stash`. Do not push, merge or deploy.
- `node_modules`: run `ls /Users/plfx/code/FacadeXPM/facadex-app/.claude/worktrees/series-family/node_modules >/dev/null 2>&1 || ln -s /Users/plfx/code/FacadeXPM/facadex-app/node_modules /Users/plfx/code/FacadeXPM/facadex-app/.claude/worktrees/series-family/node_modules`. `.gitignore` has `node_modules/`, which does NOT match a symlink, so once: `grep -qx node_modules "$(git -C /Users/plfx/code/FacadeXPM/facadex-app/.claude/worktrees/series-family rev-parse --git-common-dir)/info/exclude" || echo node_modules >> "$(git -C /Users/plfx/code/FacadeXPM/facadex-app/.claude/worktrees/series-family rev-parse --git-common-dir)/info/exclude"`. Always `git add` the exact paths a task lists; never `git add -A` or `git add .`.
- `.env`: four suites (`Dashboard.test.jsx`, `Inventory.moReport.test.jsx`, `pmPages.test.jsx`, `SiteOverviewContent.phone.test.jsx`) need `VITE_SUPABASE_URL` to import. If the worktree has no `.env`: `ln -s /Users/plfx/code/FacadeXPM/facadex-app/.env /Users/plfx/code/FacadeXPM/facadex-app/.claude/worktrees/series-family/.env` (`.env` is gitignored; never commit it).
- Tests: `npx vitest run` from the worktree (whole suite before every commit; it must stay green — a dry assembly of this whole plan on 2026-10-31 gave 331 files / 4,257 tests passing and a clean `vite build`). TDD: write the failing test first and see it fail.
- Existing tests stay byte-identical unless the task names the edit and says why. `src/lib/itemPreviewSignature.golden.json` and every other snapshot must not change (projects without a family behave exactly as before).
- UI copy in Thai, verbatim from the spec where it gives text. Inline styles + CSS vars (`var(--border)`, `var(--text2)`, `var(--text3)`, `var(--accent)`, `var(--bg3)`, `var(--red)`, `var(--green)`), classes `card`, `btn btn-sm btn-ghost|btn-primary`, `input`, `label`, `badge`, `table-wrap`, `font-mono`.
- No `alert(` / `confirm(` / `prompt(` in any file this plan creates, and none left in `ProjectDefaultsPanel.jsx` / `ProviderCompare.jsx` after their tasks: errors go in `InlineError` (`src/pages/estimation/InlineError.jsx`, props `{ title, children, onClose }`). `src/pages/estimation/noBrowserDialogs.test.js` gains those files. The existing `alert()` calls inside `CatalogCrud.jsx` / `HierarchyTab.jsx` stay (not this plan's code).
- Supabase project CHANG `kntspldhvcjeaubtqtkn` only. Implementers NEVER run SQL or any database/MCP tool. Each migration `supabase/migrations/2026-10-31-0N-*.sql` has a `*.dryrun.sql` = `BEGIN;` + the migration text verbatim + checks + a final `RAISE EXCEPTION 'RESULTS: …'` + `ROLLBACK;`. The controller runs dry runs; the owner applies real migrations (a migration is live the instant it is applied).
- The SQL runner refuses any text containing the words DELETE, DROP or TRUNCATE (also inside `ON DELETE …` and comments). Migration, dry-run and report files in this plan never contain them: foreign keys keep the default action (NO ACTION). `src/lib/migrationFiles20261031.test.js` pins this.
- RLS on a new table: the sibling `alu_*` policy `admin_full_access … TO authenticated`, written in the wrapped form `((SELECT is_admin_or_owner()) AND (tenant_id = (SELECT current_tenant_id())) AND (SELECT has_module_access('estimation'::text)))` for USING and WITH CHECK. New functions: `REVOKE ALL … FROM PUBLIC, anon; GRANT EXECUTE … TO authenticated`.
- View column freeze: no view in `supabase/migrations` reads `alu_series`, `alu_parts` or `estimation_projects` (checked 2026-10-31); each dry run also lists live dependants (expected none).
- Never name a column `family` (`alu_profiles.family` = profile shape group). The new column is `series_family_id`.
- `default_series_id` is read only by `src/lib/estimationInherit.js`, `src/lib/seriesFamily.js` and `src/pages/estimation/projectDefaults.js` (guard test from Task 4).
- No client `upsert`. No new npm dependency.
- Commit with a heredoc (zsh mangles backticks in `-m`). The message ends with exactly these two lines:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01SKarDAHEncS9RZ6zCSPXc1
  ```
- Release (Task 12 only): version `1.36.0` in `package.json` and both places in `package-lock.json`, a Thai entry at the top of `src/changelog.json`, the estimation section of `public/manual/index.html`. No deploy.

## Review Focus

1. A series linked to a parent type (e.g. "บานเลื่อน") while the item's template has a child type ("บานเลื่อน 2 บาน") → the family still picks that series, because the resolver reads the EXPANDED series-type links (Task 2 test "a link on a parent type covers its child type").
2. The owner picks a family of Alumet, then switches "โรงรีดหลัก" to SMS → the family is cleared from the draft (never saved against the wrong extruder); a saved family always resolves inside its own extruder even if `primary_provider_id` points elsewhere (Task 2 test "uses the family's own extruder", Task 5 test "switching the main extruder clears a family of another extruder").
3. A template with no type under a project family → the family's first series by name (still priced, like the old single default), never "ยังไม่เลือกซีรีส์" (Task 2 test "no type: the first series by name").
4. A stock-linked part whose newest tax invoice is dated after the project's price date → the project is priced with the purchase price on or before its price date (or the catalogue price), never a future one; the hardware set page shows today's latest (Task 10 test "never a price dated after asOf").
5. The same stock item added twice to one set, or to two sets → one `alu_parts` row is reused and the second add to the same set changes nothing ("มีในชุดแล้ว") (Task 9 dry-run PASS 6, Task 11 test `addResultText`).

## Rulings on spec gaps (made while planning; listed in the hand-back)

- Four MN series are not in table v4's lists: `AWNING 3"`, `BOX-FRAME SLIDING 4" กล่อง 4" มีรางในตัว`, `T-SLOT SOLID BARS`, `ชุด ULTRA SLIM MN-7112`. They stay without a family (each its own). This keeps misc. at the 13 the table names. (v4 also prints "9" for ช่องแสง-บานสวิง but lists 8; the 8 listed are mapped.)
- XLS ("ไฟล์ Aluminium calculation") and SMS-KC get no family rows (spec: "ชุดอื่นอยู่เดี่ยว", KC = no family). Seed = 27 families, 98 series.
- Foreign keys use NO ACTION (not SET NULL): a family still used by a series or a project cannot be removed; the screen says "ปิดใช้งาน" instead. This also keeps the forbidden word out of the SQL.
- A family whose row is switched off is hidden from the pickers (its series show one by one), but a project already saved on it keeps resolving it.
- The stock-linked part price also prices hardware sets in estimation (same helper as the page), as of the project's price date. Only posted tax invoices count; PO lines count when not cancelled and in the item's base unit.
- "Saved defaults" for the collapsed card = any of provider / family / series / colour / thickness / sash / infill / package / labour set. `profit_pct` and `price_as_of` alone do not count (every new project gets them at creation).

---

## File map

| File | Responsibility | Tasks |
|---|---|---|
| `supabase/migrations/2026-10-31-01-alu-series-family.sql` + `.dryrun.sql` (new) | families table, two FK columns, seed 27/98, project move | 1 |
| `supabase/datafix/2026-10-31-series-family-price-report.sql` (new) | read-only before/after report (spec §10) | 1 |
| `src/lib/migrationFiles20261031.test.js` (new) | guard: no refused words; dry run replays the migration | 1, 9 |
| `src/lib/seriesFamily.js` (new) | pure family logic + `withFamilyResolver` + thickness text helpers | 2 |
| `src/lib/estimationCatalogTables.js`, `src/lib/aluCatalogPricing.js` | index gains `seriesFamilies` (2) and `purchasePrices` (10) | 2, 10 |
| `src/lib/estimationInherit.js` | `inheritedSeries`, `resolveSeriesId`, new series order, `itemsAffectedByDefaultFamily` | 3 |
| `src/pages/Estimation.jsx`, `src/pages/estimation/useQuotationAttachments.js` | wrap the project once | 3 |
| `src/pages/estimation/itemForm.js`, `useItemModel.js`, `ItemFields.jsx`, `ItemsTable.jsx`, `AvailabilityBanner.jsx`, `projectDefaults.js` (banners), `src/lib/estimationCatalogViews.js` | every direct reader goes through the resolver; item form hints; hardware set order | 4 |
| `src/lib/defaultSeriesReaders.test.js` (new) | guard: nobody else reads `default_series_id` | 4, 5, 7 |
| `src/pages/estimation/projectDefaults.js`, `ProjectDefaultsPanel.jsx`, `src/lib/projectHardware.js` | "ซีรีส์หลัก" field, draft/patch, collapsed card | 5, 6 |
| `src/lib/providerCompare.js`, `src/pages/estimation/ProviderCompare.jsx`, `projectBomHelpers.js` | compare by family | 7 |
| `src/pages/aluCatalog/HierarchyTab.jsx` | manage families; series → family select | 8 |
| `supabase/migrations/2026-10-31-02-alu-parts-stock-link.sql` + `.dryrun.sql`, `supabase/datafix/2026-10-31-hardware-stock-match-report.sql` (new) | stock link, price/insert functions, 24-part report | 9 |
| `src/lib/latestPurchasePrice.js` (new), `src/hooks/useAluCatalog.js`, `projectDefaults.js` (`priceRowLabel`) | latest purchase price in engine and labels | 10 |
| `src/lib/hardwareSetView.js` (new), `src/pages/aluCatalog/HardwareSetsPanel.jsx`, `StockItemPicker.jsx`, `SeriesLinkPicker.jsx` (new), `PartsTab.jsx` | hardware set page | 11 |
| `package.json`, `package-lock.json`, `src/changelog.json`, `public/manual/index.html` | release 1.36.0 | 12 |

---
### Task 1: Migration 01 — series families, seed, project move, price report

**Files:**
- Create: `supabase/migrations/2026-10-31-01-alu-series-family.sql`
- Create: `supabase/migrations/2026-10-31-01-alu-series-family.dryrun.sql`
- Create: `supabase/datafix/2026-10-31-series-family-price-report.sql`
- Test: `src/lib/migrationFiles20261031.test.js` (new)

**Interfaces:**
- Consumes: nothing.
- Produces (DB, after the owner applies it): table `alu_series_families (id uuid, tenant_id uuid, provider_id uuid, name text, thickness_options numeric[] | null, sort_order int, active boolean, created_at)`, unique `(tenant_id, provider_id, name)` and `(id, provider_id)`; column `alu_series.series_family_id uuid | null` (composite FK `(series_family_id, provider_id)` → the family, so a series can only join its own extruder's family); column `estimation_projects.default_series_family_id uuid | null`. Seed on tenant `1b9affc4-2136-4ed1-b168-a36e6624e743`: 27 families, 98 series placed. Later tasks read these as plain rows (`index.seriesFamilies[id]`, `series.series_family_id`, `project.default_series_family_id`).

- [ ] **Step 1: Write the failing guard test**

Create `src/lib/migrationFiles20261031.test.js`:

```js
// src/lib/migrationFiles20261031.test.js
// Guard for the 2026-10-31 migrations: the SQL runner refuses any text containing DELETE / DROP / TRUNCATE, and each
// dry run must replay its migration verbatim between BEGIN and ROLLBACK (so the dry run tests the real text).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const MIGRATIONS = ['2026-10-31-01-alu-series-family']
const REPORTS = ['2026-10-31-series-family-price-report']
const mig = name => readFileSync(`supabase/migrations/${name}.sql`, 'utf8')
const dry = name => readFileSync(`supabase/migrations/${name}.dryrun.sql`, 'utf8')
const REFUSED = /\b(DELETE|DROP|TRUNCATE)\b/i

describe('2026-10-31 migration files', () => {
  for (const name of MIGRATIONS) {
    it(`${name}: no refused word in the migration or its dry run`, () => {
      expect(mig(name)).not.toMatch(REFUSED)
      expect(dry(name)).not.toMatch(REFUSED)
    })
    it(`${name}: the dry run is BEGIN + the migration verbatim + checks + ROLLBACK`, () => {
      const d = dry(name)
      expect(d.split('\n').find(l => l.trim() && !l.startsWith('--'))).toBe('BEGIN;')
      expect(d).toContain(mig(name).trim())
      expect(d).toContain("RAISE EXCEPTION 'RESULTS: %'")
      expect(d.trimEnd().endsWith('ROLLBACK;')).toBe(true)
    })
    it(`${name}: never adds a column named family`, () => {
      expect(mig(name)).not.toMatch(/ADD COLUMN\s+family\b/i)
    })
  }
  for (const name of REPORTS) {
    it(`report ${name} is read only`, () => {
      const s = readFileSync(`supabase/datafix/${name}.sql`, 'utf8')
      expect(s).not.toMatch(REFUSED)
      expect(s).not.toMatch(/\b(INSERT|UPDATE|ALTER|CREATE)\b/i)
    })
  }
})

describe('2026-10-31-01 seed', () => {
  const s = mig('2026-10-31-01-alu-series-family')
  it('lists 27 families and 98 series, and its guard expects exactly those', () => {
    expect((s.match(/^\s*\('(ALM|SP|SMS|MN)', '[^']+', (ARRAY|NULL)/gm) || []).length).toBe(27)
    expect((s.match(/^\s*\('(ALM|SP|SMS|MN)', '[^']+', '[^']+'\)/gm) || []).length).toBe(98)
    expect(s).toContain('(expect 27)')
    expect(s).toContain('(expect 98)')
  })
  it('no series is listed twice', () => {
    const rows = [...s.matchAll(/^\s*\('(ALM|SP|SMS|MN)', '[^']+', '([^']+)'\)/gm)].map(m => `${m[1]}|${m[2]}`)
    expect(new Set(rows).size).toBe(rows.length)
  })
  it('STANDARD carries 1.0/1.2/1.5/1.8/2.0 for ALM, SMS and MN', () => {
    expect((s.match(/'STANDARD', ARRAY\[1\.0,1\.2,1\.5,1\.8,2\.0\]::numeric\[\]/g) || []).length).toBe(3)
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run src/lib/migrationFiles20261031.test.js`
Expected: FAIL with `ENOENT: no such file or directory … 2026-10-31-01-alu-series-family.sql`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/2026-10-31-01-alu-series-family.sql` with exactly this content. The series names were copied by script from the tenant's catalogue export (`…/scratchpad/alucompare/data/alu_series.json`), so they match the stored names byte for byte; do not retype them.

```sql
-- supabase/migrations/2026-10-31-01-alu-series-family.sql
-- Series family (ซีรีส์หลัก): the project default names a family (e.g. ICONIQ EURO) and every item gets the family's
-- series for its door/window type. Spec: docs/superpowers/specs/2026-10-31-series-family-defaults-design.md (section 4).
-- Additive. Every foreign key keeps the default action (NO ACTION): a family that a series or a project still uses
-- cannot be removed; the catalogue screen says to switch it off instead. No view reads alu_series or
-- estimation_projects (checked 2026-10-31; the dry run lists live dependants too).
-- Seed: only tenant 1b9affc4-2136-4ed1-b168-a36e6624e743 has these series; every other tenant gets the schema only.
-- The words the SQL runner refuses never appear in this file (vitest guard: src/lib/migrationFiles20261031.test.js).

CREATE TABLE alu_series_families (
  id                UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id         UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  provider_id       UUID NOT NULL REFERENCES alu_providers(id),
  name              TEXT NOT NULL CHECK (btrim(name) <> ''),
  -- NULL = every thickness of the family's series; STANDARD = {1.0,1.2,1.5,1.8,2.0}
  thickness_options NUMERIC[] CHECK (thickness_options IS NULL OR (cardinality(thickness_options) > 0 AND 0 < ALL (thickness_options))),
  sort_order        INT NOT NULL DEFAULT 0,
  active            BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider_id, name),
  UNIQUE (id, provider_id)   -- target of alu_series' (family, provider) key: a series joins only its own extruder's family
);
CREATE INDEX idx_alu_series_families_tenant_id   ON alu_series_families(tenant_id);
CREATE INDEX idx_alu_series_families_provider_id ON alu_series_families(provider_id);
ALTER TABLE alu_series_families ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_full_access ON alu_series_families FOR ALL TO authenticated
  USING (((SELECT is_admin_or_owner()) AND (tenant_id = (SELECT current_tenant_id())) AND (SELECT has_module_access('estimation'::text))))
  WITH CHECK (((SELECT is_admin_or_owner()) AND (tenant_id = (SELECT current_tenant_id())) AND (SELECT has_module_access('estimation'::text))));

-- NULL = the series is a family of its own. Never named "family": alu_profiles.family is the profile's shape group.
ALTER TABLE alu_series ADD COLUMN series_family_id UUID;
ALTER TABLE alu_series ADD CONSTRAINT alu_series_series_family_fk
  FOREIGN KEY (series_family_id, provider_id) REFERENCES alu_series_families (id, provider_id);
CREATE INDEX idx_alu_series_series_family_id ON alu_series(series_family_id);

-- The project's default family. default_series_id stays (old projects, a series with no family).
ALTER TABLE estimation_projects ADD COLUMN default_series_family_id UUID REFERENCES alu_series_families(id);
CREATE INDEX idx_estimation_projects_default_family ON estimation_projects(default_series_family_id);

-- Seed the families (owner-approved table v4, 2026-10-31). Keys: ALM = Alumet, SP = SMART PLUS, SMS, MN.
WITH pv(k, id) AS (VALUES ('ALM', 'f634b34f-27de-4d8d-8766-4339bd0bced1'::uuid), ('SP', '0d407c5e-c318-4ab5-bdf5-03af2266e381'::uuid),
                   ('SMS', '33e74b71-b2aa-40d5-b6e2-45a8ad5f79f5'::uuid), ('MN', 'eabb17a4-a111-41e5-a59e-6b6226c7880a'::uuid)),
fam(k, name, thickness_options, sort_order) AS (VALUES
  ('ALM', 'STANDARD', ARRAY[1.0,1.2,1.5,1.8,2.0]::numeric[], 0),
  ('ALM', 'ICONIQ EURO', NULL::numeric[], 1),
  ('ALM', 'PRO SMART', NULL::numeric[], 2),
  ('ALM', 'PRO SMART X', NULL::numeric[], 3),
  ('ALM', 'MINI', NULL::numeric[], 4),
  ('SP', 'EURO 1.5', NULL::numeric[], 0),
  ('SP', 'SEMI EURO 1.2', NULL::numeric[], 1),
  ('SMS', 'STANDARD', ARRAY[1.0,1.2,1.5,1.8,2.0]::numeric[], 0),
  ('SMS', 'HOMELIFE', NULL::numeric[], 1),
  ('SMS', 'PROLINE', NULL::numeric[], 2),
  ('MN', 'STANDARD', ARRAY[1.0,1.2,1.5,1.8,2.0]::numeric[], 0),
  ('MN', 'ยูโร 2021', NULL::numeric[], 1),
  ('MN', 'ยูโร 4"', NULL::numeric[], 2),
  ('MN', 'ยูโรไทย', NULL::numeric[], 3),
  ('MN', 'บานเลื่อนใหญ่ 4" / 130 / 6"', NULL::numeric[], 4),
  ('MN', 'บานเลื่อนพิเศษ 4"', NULL::numeric[], 5),
  ('MN', 'บานเลื่อน ราง 110', NULL::numeric[], 6),
  ('MN', 'บานเลื่อนทั่วไป', NULL::numeric[], 7),
  ('MN', 'รางแขวน', NULL::numeric[], 8),
  ('MN', 'บานกระทุ้ง 2" / ยูเนี่ยน', NULL::numeric[], 9),
  ('MN', 'บานกระทุ้งเปิดข้าง', NULL::numeric[], 10),
  ('MN', 'ประตูบานเปิด 4"x1"', NULL::numeric[], 11),
  ('MN', 'ช่องแสง-บานสวิง', NULL::numeric[], 12),
  ('MN', 'บานเฟี้ยม', NULL::numeric[], 13),
  ('MN', 'ผนังกระจก', NULL::numeric[], 14),
  ('MN', 'ราวกันตก', NULL::numeric[], 15),
  ('MN', 'miscellaneous (misc.)', NULL::numeric[], 16)
)
INSERT INTO alu_series_families (tenant_id, provider_id, name, thickness_options, sort_order)
SELECT p.tenant_id, p.id, fam.name, fam.thickness_options, fam.sort_order
  FROM fam
  JOIN pv ON pv.k = fam.k
  JOIN alu_providers p ON p.id = pv.id AND p.tenant_id = '1b9affc4-2136-4ed1-b168-a36e6624e743'::uuid;

-- Put each series in its family: (extruder, family, series name exactly as stored).
WITH pv(k, id) AS (VALUES ('ALM', 'f634b34f-27de-4d8d-8766-4339bd0bced1'::uuid), ('SP', '0d407c5e-c318-4ab5-bdf5-03af2266e381'::uuid),
                   ('SMS', '33e74b71-b2aa-40d5-b6e2-45a8ad5f79f5'::uuid), ('MN', 'eabb17a4-a111-41e5-a59e-6b6226c7880a'::uuid)),
m(k, family_name, series_name) AS (VALUES
  ('ALM', 'STANDARD', 'MINI MC ท่อกลม / กล่องสี่เหลี่ยม'),
  ('ALM', 'ICONIQ EURO', 'ICONIQ EURO บานติดตาย'),
  ('ALM', 'ICONIQ EURO', 'ICONIQ EURO บานเปิด / บานกระทุ้ง'),
  ('ALM', 'ICONIQ EURO', 'ICONIQ EURO บานเลื่อน'),
  ('ALM', 'PRO SMART', 'PRO SMART บานติดตาย'),
  ('ALM', 'PRO SMART', 'PRO SMART บานเฟี้ยม'),
  ('ALM', 'PRO SMART', 'PRO SMART บานเลื่อน'),
  ('ALM', 'PRO SMART', 'PRO SMART หน้าต่างบานเปิด / บานกระทุ้ง'),
  ('ALM', 'PRO SMART X', 'PRO SMART X บานเปิด / บานกระทุ้ง'),
  ('ALM', 'PRO SMART X', 'PRO SMART X บานเลื่อน'),
  ('ALM', 'MINI', 'MINI CAS บานกระทุ้ง'),
  ('ALM', 'MINI', 'MINI CUR ผนังกระจก'),
  ('ALM', 'MINI', 'MINI OP บานเปิด'),
  ('ALM', 'MINI', 'MINI SH ช่องแสง / บานสวิง'),
  ('ALM', 'MINI', 'MINI SL บานเลื่อนมาตรฐาน'),
  ('SP', 'EURO 1.5', 'EURO 1.5 ชุดบานเปิด / บานกระทุ้ง / บานติดตาย'),
  ('SP', 'EURO 1.5', 'EURO 1.5 ชุดบานเลื่อน 2 ราง / 3 ราง'),
  ('SP', 'EURO 1.5', 'EURO 1.5 ชุดประตูบานเฟี้ยม'),
  ('SP', 'SEMI EURO 1.2', 'SEMI EURO 1.2 ชุดบานเปิด / บานกระทุ้ง / บานติดตาย'),
  ('SP', 'SEMI EURO 1.2', 'SEMI EURO 1.2 ชุดบานเลื่อน 2 ราง / 3 ราง'),
  ('SMS', 'STANDARD', 'SMS001 บานกระทุ้ง'),
  ('SMS', 'STANDARD', 'SMS001 บานสวิง / ช่องแสง'),
  ('SMS', 'STANDARD', 'SMS001 บานเลื่อน'),
  ('SMS', 'STANDARD', 'SMS001 ผนังกระจก'),
  ('SMS', 'STANDARD', 'SMS001 ระแนง / บังแดด'),
  ('SMS', 'STANDARD', 'SMS001 หน้าตัดมาตรฐาน (ท่อ / ฉาก / แบน / ราง)'),
  ('SMS', 'HOMELIFE', 'HOMELIFE 2000 (200) บานเลื่อน'),
  ('SMS', 'HOMELIFE', 'HOMELIFE 268 หน้าต่างบานเลื่อน 68.36'),
  ('SMS', 'HOMELIFE', 'HOMELIFE 3000 (220) บานเลื่อนเฟรม 45'),
  ('SMS', 'HOMELIFE', 'HOMELIFE 4000 (240) บานเฟี้ยม'),
  ('SMS', 'HOMELIFE', 'HOMELIFE 5000 (250) ประตูบานเปิดคู่'),
  ('SMS', 'HOMELIFE', 'HOMELIFE 6000 / 7000 (260) บานกระทุ้ง / บานเปิด'),
  ('SMS', 'PROLINE', 'PROLINE 1000 (100) ช่องแสง'),
  ('SMS', 'PROLINE', 'PROLINE 1000 (110) ช่องแสงร่องใหญ่'),
  ('SMS', 'PROLINE', 'PROLINE 130 / 131 ประตูบานสวิง'),
  ('MN', 'STANDARD', 'GROUP 01 ท่อ/ฉาก/ตัว U/เส้นแบน มาตรฐาน'),
  ('MN', 'ยูโร 2021', 'EURO SERIES SLIDING DOOR ประตูบานเลื่อนยูโร'),
  ('MN', 'ยูโร 2021', 'ชุดบานเลื่อน MN-U7125 EURO2021 (2 ราง)'),
  ('MN', 'ยูโร 2021', 'ชุดบานเลื่อน MN-U7126 EURO2021 (3 ราง)'),
  ('MN', 'ยูโร 4"', 'ชุดบานเลื่อน MN-7463 EURO 4" (3 ราง)'),
  ('MN', 'ยูโรไทย', 'ชุดบานเลื่อน EURO THAI'),
  ('MN', 'บานเลื่อนใหญ่ 4" / 130 / 6"', 'ชุดบานเลื่อนชุดใหญ่ MN-40303 / MN-42943'),
  ('MN', 'บานเลื่อนใหญ่ 4" / 130 / 6"', 'ชุดบานเลื่อนชุดใหญ่ MN-41479 (3 ราง)'),
  ('MN', 'บานเลื่อนใหญ่ 4" / 130 / 6"', 'ชุดบานเลื่อนชุดใหญ่ MN-42500 (130)'),
  ('MN', 'บานเลื่อนใหญ่ 4" / 130 / 6"', 'SLIDING FRAMES 101.6 / 130 / 151.9'),
  ('MN', 'บานเลื่อนใหญ่ 4" / 130 / 6"', 'SLIDING DOOR SASH หนา 38 มม. ร่อง 12'),
  ('MN', 'บานเลื่อนพิเศษ 4"', 'ชุดบานเลื่อน MN-4173B'),
  ('MN', 'บานเลื่อนพิเศษ 4"', 'SLIDING DOOR 101.6-103 มม.'),
  ('MN', 'บานเลื่อนพิเศษ 4"', 'ชุดบานเลื่อน MINI EURO'),
  ('MN', 'บานเลื่อน ราง 110', 'ชุดบานเลื่อน MN-4075 (3 ราง)'),
  ('MN', 'บานเลื่อน ราง 110', 'SLIDING 3 ราง 109.8'),
  ('MN', 'บานเลื่อนทั่วไป', 'SLIDING 95 มม. ชุดบานเลื่อนมาตรฐาน'),
  ('MN', 'บานเลื่อนทั่วไป', 'BOX-FRAME SLIDING 4"x1.75" (ร่องบาน 29.5)'),
  ('MN', 'บานเลื่อนทั่วไป', 'SLIDING WINDOW 2 ราง 71.5 + 1 ราง 36.35'),
  ('MN', 'บานเลื่อนทั่วไป', 'SLIDING 105.5 มม.'),
  ('MN', 'บานเลื่อนทั่วไป', 'FLY SCREEN (SLIDING) มุ้งบานเลื่อน'),
  ('MN', 'รางแขวน', 'ชุดประตูรางแขวน MN-U6359'),
  ('MN', 'รางแขวน', 'HANGING SLIDING RAIL บานเลื่อนรางแขวน'),
  ('MN', 'บานกระทุ้ง 2" / ยูเนี่ยน', 'ชุดบานกระทุ้ง 2" MN-50662 / MN-50690'),
  ('MN', 'บานกระทุ้ง 2" / ยูเนี่ยน', 'AWNING 36.5 / 48.5'),
  ('MN', 'บานกระทุ้ง 2" / ยูเนี่ยน', 'ชุดบานกระทุ้ง UNION (UN)'),
  ('MN', 'บานกระทุ้ง 2" / ยูเนี่ยน', 'AWNING 56.3'),
  ('MN', 'บานกระทุ้ง 2" / ยูเนี่ยน', 'AWNING-CASEMENT 36.63'),
  ('MN', 'บานกระทุ้งเปิดข้าง', 'AWNING กรอบนอก 4" ในตัว'),
  ('MN', 'บานกระทุ้งเปิดข้าง', 'CASEMENT 45/52'),
  ('MN', 'บานกระทุ้งเปิดข้าง', 'ชุดหน้าต่างบานเปิดยูโร MN-50624'),
  ('MN', 'ประตูบานเปิด 4"x1"', 'SHOPFRONT 4"x1" 101.6x25.4'),
  ('MN', 'ประตูบานเปิด 4"x1"', 'ชุดประตูบานเปิด MN-3513 / MN-30083 (วงกบบาง)'),
  ('MN', 'ประตูบานเปิด 4"x1"', 'ชุดประตูบานเปิด + ช่องแสงสลิม MN-30457'),
  ('MN', 'ประตูบานเปิด 4"x1"', 'ชุดคานผลักประตูหนีไฟ MN-30457 / MN-30458'),
  ('MN', 'ประตูบานเปิด 4"x1"', 'SHOPFRONT 101.6x20'),
  ('MN', 'ช่องแสง-บานสวิง', 'SWING DOOR ประตูบานสวิง'),
  ('MN', 'ช่องแสง-บานสวิง', 'SHOPFRONT 4"x2" กล่อง 101.6x50.8'),
  ('MN', 'ช่องแสง-บานสวิง', 'SHOPFRONT 3" 76.2x38.1'),
  ('MN', 'ช่องแสง-บานสวิง', 'SHOPFRONT 4" กล่อง 101.6x44.45'),
  ('MN', 'ช่องแสง-บานสวิง', 'SHOPFRONT 5" / 6"'),
  ('MN', 'ช่องแสง-บานสวิง', 'ชุดประตูบานเปิดเดี่ยว + ช่องแสง MN-50166'),
  ('MN', 'ช่องแสง-บานสวิง', 'ชุดประตูบานเปิดวงกบไม้ MN-1778'),
  ('MN', 'ช่องแสง-บานสวิง', 'ชุดประตูบานเลื่อน AUTOMATIC MN-U3393'),
  ('MN', 'บานเฟี้ยม', 'FOLDING DOOR ประตูบานเฟี้ยม'),
  ('MN', 'บานเฟี้ยม', 'ชุดบานเฟี้ยม (101.6)'),
  ('MN', 'ผนังกระจก', 'CURTAIN WALL ผนังกระจก (stick)'),
  ('MN', 'ผนังกระจก', 'CURTAIN WALL (CASEMENT) บานเปิดในผนังกระจก'),
  ('MN', 'ราวกันตก', 'ราวกันตก กระจก MN-BH034'),
  ('MN', 'ราวกันตก', 'ราวกันตก ลูกกรง MN-BH035'),
  ('MN', 'miscellaneous (misc.)', 'PIVOT WINDOW หน้าต่างบานหมุน'),
  ('MN', 'miscellaneous (misc.)', 'LIFTING WINDOW หน้าต่างบานยก'),
  ('MN', 'miscellaneous (misc.)', 'FRAMELESS DOOR ประตูบานเปลือย'),
  ('MN', 'miscellaneous (misc.)', 'AUTOMATIC SLIDING DOOR ฝาครอบประตูอัตโนมัติ'),
  ('MN', 'miscellaneous (misc.)', 'GLAZING BEAD คิ้วใส่กระจก'),
  ('MN', 'miscellaneous (misc.)', 'SPANDREL ลูกฟูก'),
  ('MN', 'miscellaneous (misc.)', 'LOUVER - SUNSHADE เกล็ดระบายอากาศ-แผงบังแดด'),
  ('MN', 'miscellaneous (misc.)', 'CLADDING / ROOFING / T-CEILING / BALUSTRADE / MISC (GROUP 07)'),
  ('MN', 'miscellaneous (misc.)', 'CASEMENT 4" (วงกบ 101.6x44.45)'),
  ('MN', 'miscellaneous (misc.)', 'FLY SCREEN (CASEMENT) มุ้งบานเปิด'),
  ('MN', 'miscellaneous (misc.)', 'ชุดประตูบานเปิด HEAVY DUTY MN-7855'),
  ('MN', 'miscellaneous (misc.)', 'SF20 SHOPFRONT'),
  ('MN', 'miscellaneous (misc.)', 'SW20 SWING DOOR')
)
UPDATE alu_series s
   SET series_family_id = f.id
  FROM m
  JOIN pv ON pv.k = m.k
  JOIN alu_series_families f ON f.provider_id = pv.id AND f.name = m.family_name
 WHERE s.provider_id = pv.id AND s.name = m.series_name;

-- Guard: on the database that has these extruders, every family and every listed series must have landed.
DO $$
DECLARE f INT; n INT;
BEGIN
  IF EXISTS (SELECT 1 FROM alu_providers WHERE id = 'eabb17a4-a111-41e5-a59e-6b6226c7880a'::uuid AND tenant_id = '1b9affc4-2136-4ed1-b168-a36e6624e743'::uuid) THEN
    SELECT count(*) INTO f FROM alu_series_families WHERE tenant_id = '1b9affc4-2136-4ed1-b168-a36e6624e743'::uuid;
    SELECT count(*) INTO n FROM alu_series WHERE tenant_id = '1b9affc4-2136-4ed1-b168-a36e6624e743'::uuid AND series_family_id IS NOT NULL;
    IF f <> 27 OR n <> 98 THEN
      RAISE EXCEPTION 'series family seed: % families (expect 27), % series (expect 98); was a series renamed after 2026-10-31?', f, n;
    END IF;
  END IF;
END $$;

-- Move projects whose default series now belongs to a family (spec section 4.4). A series with no family stays as it is.
UPDATE estimation_projects p
   SET default_series_family_id = s.series_family_id,
       primary_provider_id      = COALESCE(p.primary_provider_id, s.provider_id),
       default_series_id        = NULL
  FROM alu_series s
 WHERE s.id = p.default_series_id AND s.series_family_id IS NOT NULL;
```

- [ ] **Step 4: Write the dry run (generated from the migration, never hand-copied)**

```bash
W=/Users/plfx/code/FacadeXPM/facadex-app/.claude/worktrees/series-family/supabase/migrations
{
  echo '-- Dry run for 2026-10-31-01 (controller only). Replays the migration verbatim, checks it, and always rolls'
  echo '-- back via the final RAISE. Tenant 1b9affc4: current_tenant_id() reads auth.email(), so check 9 sets'
  echo '-- request.jwt.claims to the tenant OWNER and runs as role authenticated.'
  echo 'BEGIN;'
  echo
  cat "$W/2026-10-31-01-alu-series-family.sql"
  cat <<'SQL'

-- ===================== checks (dry run only) =====================
CREATE TEMP TABLE _res (n SERIAL, line TEXT);

DO $t$
DECLARE
  v_t    UUID := '1b9affc4-2136-4ed1-b168-a36e6624e743'::uuid;
  v_mail TEXT;
  n      INT;
  txt    TEXT;
  r      RECORD;
BEGIN
  SELECT count(*) INTO n FROM alu_series_families WHERE tenant_id = v_t;
  INSERT INTO _res(line) VALUES (CASE WHEN n = 27 THEN 'PASS 1 families = 27' ELSE 'FAIL 1 families = ' || n END);

  -- expected: ALM 15/15, MN 63/67, SMS 15/17, SMS-KC 0/2, SP 5/5, XLS 0/9
  FOR r IN SELECT pr.short_name, count(*) FILTER (WHERE s.series_family_id IS NOT NULL) AS fam, count(*) AS total
             FROM alu_series s JOIN alu_providers pr ON pr.id = s.provider_id
            WHERE s.tenant_id = v_t GROUP BY pr.short_name ORDER BY pr.short_name LOOP
    INSERT INTO _res(line) VALUES (format('info 2 %s: %s of %s series in a family', r.short_name, r.fam, r.total));
  END LOOP;

  SELECT count(*) INTO n FROM alu_series_families
   WHERE tenant_id = v_t AND name = 'STANDARD' AND thickness_options = ARRAY[1.0,1.2,1.5,1.8,2.0]::numeric[];
  INSERT INTO _res(line) VALUES (CASE WHEN n = 3 THEN 'PASS 3 STANDARD x3 with 1.0/1.2/1.5/1.8/2.0' ELSE 'FAIL 3 STANDARD rows = ' || n END);

  -- expected: HOSPITAL family = ICONIQ EURO, default_series_id = -, provider = ALM
  FOR r IN SELECT p.name, p.default_series_id, f.name AS fam, pr.short_name
             FROM estimation_projects p
             LEFT JOIN alu_series_families f ON f.id = p.default_series_family_id
             LEFT JOIN alu_providers pr ON pr.id = p.primary_provider_id
            ORDER BY p.name LOOP
    INSERT INTO _res(line) VALUES (format('info 4 project %s: family=%s default_series_id=%s provider=%s',
      r.name, COALESCE(r.fam, '-'), COALESCE(r.default_series_id::text, '-'), COALESCE(r.short_name, '-')));
  END LOOP;
  SELECT count(*) INTO n FROM estimation_projects WHERE default_series_family_id IS NOT NULL AND default_series_id IS NOT NULL;
  INSERT INTO _res(line) VALUES (CASE WHEN n = 0 THEN 'PASS 4b no project has both a family and a single series' ELSE 'FAIL 4b both set = ' || n END);

  -- an item whose series comes from the project could change price; expected none (HOSPITAL's item has its own)
  SELECT count(*) INTO n FROM estimation_openings o JOIN estimation_projects p ON p.id = o.project_id
   WHERE o.series_id IS NULL AND (p.default_series_family_id IS NOT NULL OR p.default_series_id IS NOT NULL);
  INSERT INTO _res(line) VALUES (CASE WHEN n = 0 THEN 'PASS 5 no item inherits a project series (prices unchanged)' ELSE 'FAIL 5 items inheriting a project series = ' || n || ' (compare them on the dev server)' END);

  SELECT count(*) INTO n FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'alu_series_families'
     AND qual ILIKE '%SELECT is_admin_or_owner()%' AND qual ILIKE '%SELECT current_tenant_id()%' AND with_check ILIKE '%SELECT has_module_access(%';
  INSERT INTO _res(line) VALUES (CASE WHEN n = 1 AND (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.alu_series_families'::regclass)
    THEN 'PASS 6 RLS on, wrapped policy' ELSE 'FAIL 6 policies = ' || n END);

  SELECT string_agg(DISTINCT v.relname, ', ') INTO txt
    FROM pg_depend d JOIN pg_rewrite rw ON rw.oid = d.objid JOIN pg_class v ON v.oid = rw.ev_class
    JOIN pg_class t ON t.oid = d.refobjid
   WHERE t.relnamespace = 'public'::regnamespace AND t.relname IN ('alu_series', 'estimation_projects') AND v.oid <> t.oid;
  INSERT INTO _res(line) VALUES (CASE WHEN txt IS NULL THEN 'PASS 7 no view depends on alu_series / estimation_projects' ELSE 'FAIL 7 views: ' || txt END);

  BEGIN
    UPDATE alu_series SET series_family_id = (SELECT id FROM alu_series_families WHERE provider_id = 'eabb17a4-a111-41e5-a59e-6b6226c7880a'::uuid LIMIT 1)
     WHERE id = (SELECT id FROM alu_series WHERE provider_id = 'f634b34f-27de-4d8d-8766-4339bd0bced1'::uuid LIMIT 1);
    INSERT INTO _res(line) VALUES ('FAIL 8 an Alumet series took an MN family');
  EXCEPTION WHEN foreign_key_violation THEN
    INSERT INTO _res(line) VALUES ('PASS 8 a family of another extruder is refused');
  END;

  SELECT user_email INTO v_mail FROM user_roles WHERE tenant_id = v_t AND role = 'OWNER' ORDER BY user_email LIMIT 1;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated', 'email', v_mail)::text, true);
  EXECUTE 'SET LOCAL role authenticated';
  SELECT count(*) INTO n FROM alu_series_families;
  EXECUTE 'RESET ROLE';
  INSERT INTO _res(line) VALUES (CASE WHEN n = 27 THEN 'PASS 9 the owner reads 27 families through RLS' ELSE 'FAIL 9 owner sees ' || n END);
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _res(line) VALUES ('FAIL exception: ' || SQLERRM);
END $t$;

DO $z$ BEGIN RAISE EXCEPTION 'RESULTS: %', (SELECT string_agg(line, E'\n' ORDER BY n) FROM _res); END $z$;
ROLLBACK;
SQL
} > "$W/2026-10-31-01-alu-series-family.dryrun.sql"
```

If the migration is edited later, regenerate the dry run with the same command (the guard test fails otherwise).

- [ ] **Step 5: Write the read-only price report**

Create `supabase/datafix/2026-10-31-series-family-price-report.sql`:

```sql
-- supabase/datafix/2026-10-31-series-family-price-report.sql
-- READ ONLY. Before/after check for 2026-10-31-01 (spec section 10). The price of an item can change only if the
-- item takes its series from the project; every other input (size, template, colour, thickness ...) is untouched.
-- Query A: run BEFORE applying the migration. Query B: run AFTER. Save both outputs in the session notes.
-- Expected on CHANG (2026-10-31): HOSPITAL's one item shows series_from = 'own' in both, and no row anywhere shows
-- 'inherits' -> no price changes. Any 'inherits' row: open that item on the dev server before and after and compare.

-- A (before)
SELECT p.name AS project, o.opening_no, own.name AS own_series, def.name AS project_default_series,
       CASE WHEN o.series_id IS NOT NULL THEN 'own'
            WHEN p.default_series_id IS NOT NULL THEN 'inherits'
            ELSE 'none' END AS series_from
  FROM estimation_openings o
  JOIN estimation_projects p ON p.id = o.project_id
  LEFT JOIN alu_series own ON own.id = o.series_id
  LEFT JOIN alu_series def ON def.id = p.default_series_id
 ORDER BY p.name, o.opening_no;

-- B (after)
SELECT p.name AS project, o.opening_no, own.name AS own_series, def.name AS project_default_series, f.name AS project_family,
       CASE WHEN o.series_id IS NOT NULL THEN 'own'
            WHEN p.default_series_family_id IS NOT NULL OR p.default_series_id IS NOT NULL THEN 'inherits'
            ELSE 'none' END AS series_from
  FROM estimation_openings o
  JOIN estimation_projects p ON p.id = o.project_id
  LEFT JOIN alu_series own ON own.id = o.series_id
  LEFT JOIN alu_series def ON def.id = p.default_series_id
  LEFT JOIN alu_series_families f ON f.id = p.default_series_family_id
 ORDER BY p.name, o.opening_no;
```

- [ ] **Step 6: Run the guard test and the whole suite**

Run: `npx vitest run src/lib/migrationFiles20261031.test.js` → Expected: PASS (8 tests).
Run: `npx vitest run` → Expected: all green (`estimationCatalogTables.test.js` still scans only the 2026-10-10 files, so it is unaffected until Task 2).

- [ ] **Step 7: Commit**

```bash
cd /Users/plfx/code/FacadeXPM/facadex-app/.claude/worktrees/series-family
git add supabase/migrations/2026-10-31-01-alu-series-family.sql supabase/migrations/2026-10-31-01-alu-series-family.dryrun.sql supabase/datafix/2026-10-31-series-family-price-report.sql src/lib/migrationFiles20261031.test.js
git commit -F - <<'MSG'
feat(db): series families (ซีรีส์หลัก) table, seed 27/98, project move + dry run

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SKarDAHEncS9RZ6zCSPXc1
MSG
```

Controller (not the implementer): run `supabase/datafix/2026-10-31-series-family-price-report.sql` query A, then the dry run; expected RESULTS: PASS 1, 3, 4b, 5, 6, 7, 8, 9 and info 2 = `ALM 15 of 15, MN 63 of 67, SMS 15 of 17, SMS-KC 0 of 2, SP 5 of 5, XLS 0 of 9`, info 4 HOSPITAL `family=ICONIQ EURO default_series_id=- provider=ALM`. Only then ask the owner to apply the migration, and run query B after.

---
### Task 2: `seriesFamily.js` — pure family logic; the catalogue index loads families

**Files:**
- Create: `src/lib/seriesFamily.js`
- Test: `src/lib/seriesFamily.test.js` (new)
- Modify: `src/lib/estimationCatalogTables.js` (add `seriesFamilies`)
- Modify: `src/lib/aluCatalogPricing.js:21-38` (`buildCatalogIndex` gains `seriesFamilies`)
- Modify: `src/lib/estimationCatalogTables.test.js` (scan the new migration too; 14 → 15 tables — the test pins "every catalog table the screens load", and this plan adds one)

**Interfaces:**
- Consumes: Task 1 columns (as plain row fields); `thicknessesForSeries(index, seriesId) -> number[]` from `src/lib/estimationCatalogViews.js`.
- Produces (all exported from `src/lib/seriesFamily.js`; a "key" is `''` | a family id | `'series:<seriesId>'`):
  - `isSoloKey(key) -> boolean`, `soloKey(seriesId) -> string`, `soloSeriesId(key) -> string | null`
  - `familyKey(series, familiesById?) -> string` (the family id while that family row exists and is active, else `'series:<id>'`)
  - `projectFamilyKey(project) -> string` (`default_series_family_id`, else `'series:' + default_series_id`, else `''`)
  - `keyProviderId(index, key) -> string | null`, `familyLabel(index, key) -> string`
  - `familySeries(index, providerId | null, key) -> series[]` (active, by name; a solo key returns its series even if inactive)
  - `familySeriesForType(index, seriesTypes, providerId | null, key, typeId | null) -> seriesId | null`
  - `familyChoices(index, providerId | null) -> { value: key, label, count }[]`
  - `familyThicknesses(index, key) -> number[]`, `familyAllowsMixed(index, seriesTypes, key) -> boolean`
  - `projectSeriesIds(project) -> string[]`
  - `withFamilyResolver(project, index, seriesTypes) -> project` (same object when the project has no family; otherwise a copy with `familyName: string`, `familySeriesIds: string[]`, `seriesForType(typeId) -> seriesId | null`)
  - `parseThicknessOptions(value) -> { value: number[] | null, error: string | null }`, `formatThicknessOptions(arr) -> string`
  - `buildCatalogIndex(rows).seriesFamilies` = `{ [id]: familyRow }` (`{}` when not loaded); `ESTIMATION_CATALOG_TABLES.seriesFamilies = 'alu_series_families'`.
  - `seriesTypes` everywhere in this plan means the EXPANDED links (`useEstimationCatalog().seriesTypes` = `Object.values(index.seriesTypesBySeries).flat()`), never raw `alu_series_types` rows.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/seriesFamily.test.js`:

```js
// src/lib/seriesFamily.test.js
import { describe, it, expect } from 'vitest'
import { buildCatalogIndex } from './aluCatalogPricing.js'
import {
  isSoloKey, soloKey, soloSeriesId, familyKey, projectFamilyKey, keyProviderId, familyLabel, familySeries,
  familySeriesForType, familyChoices, familyThicknesses, familyAllowsMixed, projectSeriesIds, withFamilyResolver,
  parseThicknessOptions, formatThicknessOptions,
} from './seriesFamily.js'

// ASCII names so "first by name" is unambiguous. Types: win > slide > slide2 (child), casement, fixed, awning.
const rows = {
  providers: [{ id: 'A', name: 'Alumet' }, { id: 'B', name: 'SMS' }],
  seriesFamilies: [
    { id: 'fA', provider_id: 'A', name: 'EURO', thickness_options: null, active: true },
    { id: 'fStd', provider_id: 'A', name: 'STANDARD', thickness_options: [2, 1, 1.5, 1.5], active: true },
    { id: 'fOff', provider_id: 'A', name: 'OLD', thickness_options: null, active: false },
  ],
  series: [
    { id: 's1', provider_id: 'A', name: 'EURO Slide', series_family_id: 'fA' },
    { id: 's10', provider_id: 'A', name: 'EURO Slide 3T', series_family_id: 'fA' },
    { id: 's2', provider_id: 'A', name: 'EURO Open', series_family_id: 'fA' },
    { id: 's3', provider_id: 'A', name: 'EURO Fixed', series_family_id: 'fA' },
    { id: 's4', provider_id: 'A', name: 'EURO Aaa', series_family_id: 'fA', active: false },
    { id: 's5', provider_id: 'A', name: 'MINI MC', series_family_id: 'fStd' },
    { id: 's6', provider_id: 'A', name: 'SOLO', series_family_id: null },
    { id: 's7', provider_id: 'A', name: 'OLD 1', series_family_id: 'fOff' },
    { id: 's8', provider_id: 'B', name: 'B one', series_family_id: null },
  ],
  types: [
    { id: 'win', name: 'หน้าต่าง', parent_id: null }, { id: 'slide', name: 'บานเลื่อน', parent_id: 'win' },
    { id: 'slide2', name: 'บานเลื่อน 2 บาน', parent_id: 'slide' }, { id: 'casement', name: 'บานเปิด', parent_id: 'win' },
    { id: 'fixed', name: 'บานติดตาย', parent_id: 'win' }, { id: 'awning', name: 'บานกระทุ้ง', parent_id: 'win' },
  ],
  seriesTypes: [
    { id: 'l1', series_id: 's1', type_id: 'slide', allow_mixed_thickness: false },
    { id: 'l10', series_id: 's10', type_id: 'slide', allow_mixed_thickness: false },
    { id: 'l2', series_id: 's2', type_id: 'casement', allow_mixed_thickness: true },
    { id: 'l3', series_id: 's3', type_id: 'fixed', allow_mixed_thickness: false },
    { id: 'l4', series_id: 's4', type_id: 'slide', allow_mixed_thickness: false },
    { id: 'l6', series_id: 's6', type_id: 'slide', allow_mixed_thickness: false },
  ],
  profiles: [
    { id: 'p12', provider_id: 'A', thickness_mm: 1.2 }, { id: 'p15', provider_id: 'A', thickness_mm: 1.5 }, { id: 'p20', provider_id: 'A', thickness_mm: 2 },
  ],
  seriesProfiles: [
    { series_id: 's1', profile_id: 'p12' }, { series_id: 's2', profile_id: 'p15' }, { series_id: 's3', profile_id: 'p12' }, { series_id: 's6', profile_id: 'p20' },
  ],
}
const index = buildCatalogIndex(rows)
const seriesTypes = Object.values(index.seriesTypesBySeries).flat()   // expanded, as useEstimationCatalog gives it

describe('keys', () => {
  it('solo keys round-trip', () => {
    expect(soloKey('s6')).toBe('series:s6')
    expect(isSoloKey('series:s6')).toBe(true)
    expect(isSoloKey('fA')).toBe(false)
    expect(isSoloKey('')).toBe(false)
    expect(soloSeriesId('series:s6')).toBe('s6')
    expect(soloSeriesId('fA')).toBeNull()
  })
  it('familyKey: the family while it is active, else the series itself', () => {
    expect(familyKey(index.series.s1, index.seriesFamilies)).toBe('fA')
    expect(familyKey(index.series.s6, index.seriesFamilies)).toBe('series:s6')
    expect(familyKey(index.series.s7, index.seriesFamilies)).toBe('series:s7')   // family switched off
    expect(familyKey(index.series.s7)).toBe('fOff')                               // no map given: trust the column
  })
  it('projectFamilyKey prefers the family, then the single series', () => {
    expect(projectFamilyKey({ default_series_family_id: 'fA', default_series_id: 's6' })).toBe('fA')
    expect(projectFamilyKey({ default_series_id: 's6' })).toBe('series:s6')
    expect(projectFamilyKey({})).toBe('')
    expect(projectFamilyKey(null)).toBe('')
  })
  it('keyProviderId and familyLabel', () => {
    expect(keyProviderId(index, 'fA')).toBe('A')
    expect(keyProviderId(index, 'series:s8')).toBe('B')
    expect(keyProviderId(index, '')).toBeNull()
    expect(keyProviderId(index, 'gone')).toBeNull()
    expect(familyLabel(index, 'fA')).toBe('EURO')
    expect(familyLabel(index, 'series:s6')).toBe('SOLO')
    expect(familyLabel(index, '')).toBe('')
  })
})

describe('familySeries / familySeriesForType', () => {
  it('active series of the family, by name', () => {
    expect(familySeries(index, 'A', 'fA').map(s => s.id)).toEqual(['s3', 's2', 's1', 's10'])
    expect(familySeries(index, 'B', 'fA')).toEqual([])
    expect(familySeries(index, null, 'series:s6').map(s => s.id)).toEqual(['s6'])
  })
  it('picks the first series by name that makes the type; inactive series never', () => {
    expect(familySeriesForType(index, seriesTypes, 'A', 'fA', 'slide')).toBe('s1')
    expect(familySeriesForType(index, seriesTypes, 'A', 'fA', 'casement')).toBe('s2')
    expect(familySeriesForType(index, seriesTypes, 'A', 'fA', 'fixed')).toBe('s3')
  })
  it('a link on a parent type covers its child type (Review Focus 1)', () => {
    expect(familySeriesForType(index, seriesTypes, 'A', 'fA', 'slide2')).toBe('s1')
  })
  it('null when no series of the family makes the type', () => {
    expect(familySeriesForType(index, seriesTypes, 'A', 'fA', 'awning')).toBeNull()
    expect(familySeriesForType(index, seriesTypes, 'A', '', 'slide')).toBeNull()
  })
  it('no type: the first series by name (Review Focus 3)', () => {
    expect(familySeriesForType(index, seriesTypes, 'A', 'fA', null)).toBe('s3')
  })
  it('a solo key returns its series whatever the type (the old single default)', () => {
    expect(familySeriesForType(index, seriesTypes, null, 'series:s6', 'casement')).toBe('s6')
  })
})

describe('familyChoices', () => {
  it('one extruder: families with their count, lone series by name, switched-off family shown series by series', () => {
    expect(familyChoices(index, 'A')).toEqual([
      { value: 'fA', label: 'EURO · 4 ชุด', count: 4 },
      { value: 'series:s7', label: 'OLD 1', count: 1 },
      { value: 'series:s6', label: 'SOLO', count: 1 },
      { value: 'fStd', label: 'STANDARD · 1 ชุด', count: 1 },
    ])
  })
  it('no extruder chosen: every extruder, labelled with its name', () => {
    const all = familyChoices(index, '')
    expect(all.find(o => o.value === 'series:s8').label).toBe('B one · SMS')
    expect(all.find(o => o.value === 'fA').label).toBe('EURO · 4 ชุด · Alumet')
  })
})

describe('thicknesses and mixed thickness', () => {
  it("the family's own list when set (sorted, distinct), else the union of its series", () => {
    expect(familyThicknesses(index, 'fStd')).toEqual([1, 1.5, 2])
    expect(familyThicknesses(index, 'fA')).toEqual([1.2, 1.5])
    expect(familyThicknesses(index, 'series:s6')).toEqual([2])
    expect(familyThicknesses(index, '')).toEqual([])
  })
  it('mixed thickness when any series of the family allows it', () => {
    expect(familyAllowsMixed(index, seriesTypes, 'fA')).toBe(true)
    expect(familyAllowsMixed(index, seriesTypes, 'series:s6')).toBe(false)
    expect(familyAllowsMixed(index, seriesTypes, '')).toBe(false)
  })
})

describe('withFamilyResolver', () => {
  it('a project without a family comes back as the same object', () => {
    const pj = { id: 'p', default_series_id: 's6' }
    expect(withFamilyResolver(pj, index, seriesTypes)).toBe(pj)
    expect(withFamilyResolver(null, index, seriesTypes)).toBeNull()
  })
  it('adds seriesForType, familyName and familySeriesIds', () => {
    const pj = withFamilyResolver({ id: 'p', default_series_family_id: 'fA' }, index, seriesTypes)
    expect(pj.seriesForType('slide')).toBe('s1')
    expect(pj.seriesForType('awning')).toBeNull()
    expect(pj.seriesForType(null)).toBe('s3')
    expect(pj.familyName).toBe('EURO')
    expect(pj.familySeriesIds).toEqual(['s3', 's2', 's1', 's10'])
  })
  it("uses the family's own extruder even when the project's main extruder is another (Review Focus 2)", () => {
    const pj = withFamilyResolver({ id: 'p', default_series_family_id: 'fA', primary_provider_id: 'B' }, index, seriesTypes)
    expect(pj.seriesForType('casement')).toBe('s2')
  })
  it('projectSeriesIds: the family series, or the single series, or none', () => {
    expect(projectSeriesIds(withFamilyResolver({ default_series_family_id: 'fA' }, index, seriesTypes))).toEqual(['s3', 's2', 's1', 's10'])
    expect(projectSeriesIds({ default_series_id: 's6' })).toEqual(['s6'])
    expect(projectSeriesIds({})).toEqual([])
  })
})

describe('thickness text on the family form', () => {
  it('parses commas or spaces, sorts, drops duplicates; blank = every thickness', () => {
    expect(parseThicknessOptions('1.0, 1.2 1.5,1.2')).toEqual({ value: [1, 1.2, 1.5], error: null })
    expect(parseThicknessOptions('  ')).toEqual({ value: null, error: null })
    expect(parseThicknessOptions(null)).toEqual({ value: null, error: null })
    expect(parseThicknessOptions([2, 1])).toEqual({ value: [1, 2], error: null })
    expect(parseThicknessOptions('1.2, abc').error).toBe('ความหนาต้องเป็นตัวเลขมากกว่า 0 คั่นด้วยจุลภาค เช่น 1.0, 1.2, 1.5')
    expect(parseThicknessOptions('0').error).not.toBeNull()
  })
  it('formats with one decimal at least', () => {
    expect(formatThicknessOptions([1, 1.2, 2])).toBe('1.0, 1.2, 2.0')
    expect(formatThicknessOptions(null)).toBe('')
  })
})

describe('buildCatalogIndex', () => {
  it('indexes families by id, {} when not loaded', () => {
    expect(index.seriesFamilies.fA.name).toBe('EURO')
    expect(buildCatalogIndex({}).seriesFamilies).toEqual({})
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run src/lib/seriesFamily.test.js`
Expected: FAIL with `Failed to resolve import "./seriesFamily.js"`.

- [ ] **Step 3: Implement**

Create `src/lib/seriesFamily.js`:

```js
// src/lib/seriesFamily.js
// Series family (ซีรีส์หลัก, spec 2026-10-31 section 5): a group of one extruder's series (ICONIQ EURO = its fixed,
// casement and sliding series). The project default names a family; each item gets the family's series that makes its
// door/window type. A series with no family is a family of its own, keyed 'series:<id>'. Pure; reads the
// buildCatalogIndex index (index.series, index.seriesFamilies, index.providers) and the EXPANDED series-type links.
import { thicknessesForSeries } from './estimationCatalogViews.js'

const SOLO = 'series:'
const byName = (a, b) => String(a.name ?? '').localeCompare(String(b.name ?? ''), 'th')
const familiesOf = index => (index && index.seriesFamilies) || {}

export const isSoloKey = key => typeof key === 'string' && key.startsWith(SOLO)
export const soloKey = seriesId => SOLO + seriesId
export const soloSeriesId = key => (isSoloKey(key) ? key.slice(SOLO.length) : null)

// The pickers' key of a series: its family while that family row exists and is active, else the series itself.
// Without familiesById the column is trusted as it is.
export function familyKey(series, familiesById) {
  const f = series && series.series_family_id
  if (f && (!familiesById || (familiesById[f] && familiesById[f].active !== false))) return f
  return soloKey(series.id)
}

// '' | family id | 'series:<id>': what the project defaults point at.
export function projectFamilyKey(project) {
  const pj = project || {}
  if (pj.default_series_family_id) return pj.default_series_family_id
  if (pj.default_series_id) return soloKey(pj.default_series_id)
  return ''
}

export function keyProviderId(index, key) {
  if (!key) return null
  if (isSoloKey(key)) {
    const s = index.series[soloSeriesId(key)]
    return s ? s.provider_id : null
  }
  const f = familiesOf(index)[key]
  return f ? f.provider_id : null
}

export function familyLabel(index, key) {
  if (!key) return ''
  if (isSoloKey(key)) {
    const s = index.series[soloSeriesId(key)]
    return s ? s.name : ''
  }
  const f = familiesOf(index)[key]
  return f ? f.name : ''
}

// Active series of a family, by name (providerId optional). A solo key gives its own series even when inactive, so an
// old project keeps pricing exactly as before.
export function familySeries(index, providerId, key) {
  if (!key) return []
  if (isSoloKey(key)) {
    const s = index.series[soloSeriesId(key)]
    return s ? [s] : []
  }
  return Object.values(index.series)
    .filter(s => s.series_family_id === key && s.active !== false && (!providerId || s.provider_id === providerId))
    .sort(byName)
}

// The family's series for one door/window type: the first by name with a link on typeId (seriesTypes = the expanded
// links, so a link on a parent type covers its children), null when none has one. A solo key returns its series for
// any type (the old single-series default); no typeId (a template without a type) = the first series by name.
export function familySeriesForType(index, seriesTypes, providerId, key, typeId) {
  const list = familySeries(index, providerId, key)
  if (!list.length) return null
  if (isSoloKey(key) || !typeId) return list[0].id
  const hit = list.find(s => (seriesTypes || []).some(st => st.series_id === s.id && st.type_id === typeId))
  return hit ? hit.id : null
}

// Options of one extruder, or of every extruder (then labelled with it) when providerId is empty:
// [{ value: key, label, count }]: a family "ICONIQ EURO · 3 ชุด", a series without an (active) family by its name.
export function familyChoices(index, providerId) {
  const fams = familiesOf(index)
  const groups = new Map()
  for (const s of Object.values(index.series)) {
    if (s.active === false || (providerId && s.provider_id !== providerId)) continue
    const key = familyKey(s, fams)
    if (!groups.has(key)) groups.set(key, { key, providerId: s.provider_id, count: 0 })
    groups.get(key).count += 1
  }
  return [...groups.values()].map(g => {
    const base = isSoloKey(g.key) ? familyLabel(index, g.key) : `${fams[g.key].name} · ${g.count} ชุด`
    const prov = index.providers && index.providers[g.providerId]
    return { value: g.key, label: !providerId && prov ? `${base} · ${prov.name}` : base, count: g.count }
  }).sort((a, b) => String(a.label).localeCompare(String(b.label), 'th'))
}

// Frame thicknesses the project default offers: the family's own list when set (STANDARD = 1.0–2.0), else every
// thickness of its series. Ascending, distinct.
export function familyThicknesses(index, key) {
  if (!key) return []
  if (isSoloKey(key)) return thicknessesForSeries(index, soloSeriesId(key))
  const f = familiesOf(index)[key]
  if (f && Array.isArray(f.thickness_options) && f.thickness_options.length) {
    return [...new Set(f.thickness_options.map(Number))].filter(n => Number.isFinite(n) && n > 0).sort((a, b) => a - b)
  }
  const seen = new Set()
  for (const s of familySeries(index, null, key)) for (const t of thicknessesForSeries(index, s.id)) seen.add(t)
  return [...seen].sort((a, b) => a - b)
}

// True when any series of the family has a type that allows frame and sash to differ.
export function familyAllowsMixed(index, seriesTypes, key) {
  const ids = familySeries(index, null, key).map(s => s.id)
  return (seriesTypes || []).some(l => ids.includes(l.series_id) && l.allow_mixed_thickness === true)
}

// The series the project defaults cover (package and banner checks): the family's series, or the single series.
export function projectSeriesIds(project) {
  const pj = project || {}
  if (Array.isArray(pj.familySeriesIds)) return pj.familySeriesIds
  return pj.default_series_id ? [pj.default_series_id] : []
}

// The project as every screen uses it. With a family: a copy with seriesForType(typeId) -> series id | null
// (memoised per type), familyName and familySeriesIds. Without one: the SAME object, so memo deps and snapshots stay.
// The family's own extruder is used, whatever primary_provider_id says.
export function withFamilyResolver(project, index, seriesTypes) {
  if (!project || !project.default_series_family_id || !index) return project
  const key = project.default_series_family_id
  const fam = familiesOf(index)[key] || null
  const providerId = fam ? fam.provider_id : null
  const memo = new Map()
  return {
    ...project,
    familyName: fam ? fam.name : '',
    familySeriesIds: familySeries(index, providerId, key).map(s => s.id),
    seriesForType(typeId) {
      const k = typeId || ''
      if (!memo.has(k)) memo.set(k, familySeriesForType(index, seriesTypes, providerId, key, typeId || null))
      return memo.get(k)
    },
  }
}

const THICKNESS_ERROR = 'ความหนาต้องเป็นตัวเลขมากกว่า 0 คั่นด้วยจุลภาค เช่น 1.0, 1.2, 1.5'

// The family form's thickness text ("1.0, 1.2 1.5") or a stored array -> sorted distinct numbers; blank -> null.
export function parseThicknessOptions(v) {
  const parts = Array.isArray(v) ? v.map(String) : String(v ?? '').split(/[\s,]+/).filter(Boolean)
  if (!parts.length) return { value: null, error: null }
  const nums = parts.map(Number)
  if (nums.some(n => !Number.isFinite(n) || n <= 0)) return { value: null, error: THICKNESS_ERROR }
  return { value: [...new Set(nums)].sort((a, b) => a - b), error: null }
}

export function formatThicknessOptions(arr) {
  if (!Array.isArray(arr) || !arr.length) return ''
  return arr.map(Number).map(n => (Number.isInteger(n) ? n.toFixed(1) : String(n))).join(', ')
}
```

In `src/lib/estimationCatalogTables.js` add one line after `series: 'alu_series',`:

```js
  seriesFamilies: 'alu_series_families',
```

In `src/lib/aluCatalogPricing.js`, `buildCatalogIndex`, add after `series: byId(rows.series),`:

```js
    seriesFamilies: byId(rows.seriesFamilies),
```

In `src/lib/estimationCatalogTables.test.js`, change the file filter and the count (the only two edits):

```js
const migrations = readdirSync('supabase/migrations')
  .filter(f => /^2026-10-10-0[123]-alu-catalog-/.test(f) || f === '2026-10-31-01-alu-series-family.sql')
```

and rename `it('covers all 14 catalog tables exactly once', …)` to `it('covers all 15 catalog tables exactly once', …)` (body unchanged).

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/lib/seriesFamily.test.js src/lib/estimationCatalogTables.test.js src/lib/aluCatalogIndex2b.test.js src/lib/aluCatalogPricing.test.js`
Expected: PASS. If the `familySeries` order test fails only on order, check the names are the ASCII ones above (Thai collation is not under test here).
Run: `npx vitest run` → Expected: all green.

- [ ] **Step 5: Commit**

```bash
cd /Users/plfx/code/FacadeXPM/facadex-app/.claude/worktrees/series-family
git add src/lib/seriesFamily.js src/lib/seriesFamily.test.js src/lib/estimationCatalogTables.js src/lib/estimationCatalogTables.test.js src/lib/aluCatalogPricing.js
git commit -F - <<'MSG'
feat(estimation): seriesFamily helpers (family keys, choices, series for a type, resolver)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SKarDAHEncS9RZ6zCSPXc1
MSG
```

---
### Task 3: The resolver — series order 1–4 in `resolveItemInputs`; the project is wrapped once

**Files:**
- Modify: `src/lib/estimationInherit.js` (new `inheritedSeries`, `resolveSeriesId`, `itemsAffectedByDefaultFamily`; `resolveItemInputs` line 22)
- Test: `src/lib/estimationInheritFamily.test.js` (new; the existing `estimationInherit.test.js` is not edited)
- Modify: `src/pages/Estimation.jsx:89` (wrap the selected project)
- Modify: `src/pages/estimation/useQuotationAttachments.js` (wrap the loaded project)
- Test: `src/pages/Quotations.isolation.test.jsx` (one new `it`, appended; nothing existing edited)

**Interfaces:**
- Consumes (Task 2): `familySeriesForType`, `isSoloKey`, `soloSeriesId`, `withFamilyResolver(project, index, seriesTypes)`; `buildCatalogIndex` (`src/lib/aluCatalogPricing.js`).
- Produces (`src/lib/estimationInherit.js`):
  - `inheritedSeries(item, project, template) -> { series_id: string | null, source: 'item' | 'family' | 'project' | null, familyMissing: boolean }`. Order: 1 `item.series_id`; 2 `project.seriesForType(template.type_id)` when the project carries a resolver (its answer is final, even null, which sets `familyMissing: true`); 3 `project.default_series_id`; 4 null.
  - `resolveSeriesId(item, project, template) -> string | null` (= `inheritedSeries(...).series_id`)
  - `resolveItemInputs(...)` unchanged signature and keys; `series_id` now comes from `inheritedSeries`.
  - `itemsAffectedByDefaultFamily(items, templatesById, index, seriesTypes, key) -> item[]`: items with no own series whose main template's type the family has no series for, or whose add-on the resolved series does not make; a solo key behaves exactly like `itemsAffectedByDefaultSeries`.
  - Every screen that receives `project` from `Estimation.jsx` (ProjectDefaultsPanel, ItemsTable, ItemModal, ProjectBomView → ProviderCompare, PriceStructureTab → SendToQuotationButton, banners, `costItems`) now gets the wrapped project. The quotation attachment loader wraps its own.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/estimationInheritFamily.test.js`:

```js
// src/lib/estimationInheritFamily.test.js -- spec 2026-10-31 section 5: the series order and the family resolver.
import { describe, it, expect } from 'vitest'
import { buildCatalogIndex } from './aluCatalogPricing.js'
import { withFamilyResolver } from './seriesFamily.js'
import { inheritedSeries, resolveSeriesId, resolveItemInputs, itemsAffectedByDefaultFamily, itemsAffectedByDefaultSeries } from './estimationInherit.js'

const index = buildCatalogIndex({
  providers: [{ id: 'A', name: 'Alumet' }],
  seriesFamilies: [{ id: 'fA', provider_id: 'A', name: 'EURO' }],
  series: [
    { id: 'sSlide', provider_id: 'A', name: 'EURO Slide', series_family_id: 'fA' },
    { id: 'sOpen', provider_id: 'A', name: 'EURO Open', series_family_id: 'fA' },
    { id: 'sOther', provider_id: 'A', name: 'Other' },
  ],
  types: [{ id: 'slide', name: 'บานเลื่อน' }, { id: 'casement', name: 'บานเปิด' }, { id: 'awning', name: 'บานกระทุ้ง' }],
  seriesTypes: [{ id: 'l1', series_id: 'sSlide', type_id: 'slide' }, { id: 'l2', series_id: 'sOpen', type_id: 'casement' }],
})
const seriesTypes = Object.values(index.seriesTypesBySeries).flat()
const tSlide = { id: 'tS', type_id: 'slide' }
const tOpen = { id: 'tO', type_id: 'casement' }
const tAwn = { id: 'tA', type_id: 'awning' }
const fam = withFamilyResolver({ id: 'p', default_series_family_id: 'fA', default_finish_id: 'f1' }, index, seriesTypes)

describe('inheritedSeries: the order 1-4 (spec section 5)', () => {
  it("1 the item's own series always wins", () => {
    expect(inheritedSeries({ series_id: 'sOther' }, fam, tSlide)).toEqual({ series_id: 'sOther', source: 'item', familyMissing: false })
  })
  it("2 the project's family gives the series of the template's type", () => {
    expect(inheritedSeries({}, fam, tSlide)).toEqual({ series_id: 'sSlide', source: 'family', familyMissing: false })
    expect(inheritedSeries({}, fam, tOpen).series_id).toBe('sOpen')
  })
  it('2 a family without a series for the type gives null + familyMissing, never the old default', () => {
    const both = { ...fam, default_series_id: 'sOther' }
    expect(inheritedSeries({}, both, tAwn)).toEqual({ series_id: null, source: null, familyMissing: true })
  })
  it('3 an old project (no family) uses default_series_id; 4 nothing set gives null', () => {
    expect(inheritedSeries({}, { default_series_id: 'sOther' }, tAwn)).toEqual({ series_id: 'sOther', source: 'project', familyMissing: false })
    expect(inheritedSeries(null, null, null)).toEqual({ series_id: null, source: null, familyMissing: false })
  })
  it('resolveSeriesId is the series id alone', () => {
    expect(resolveSeriesId({}, fam, tOpen)).toBe('sOpen')
    expect(resolveSeriesId({ series_id: '' }, { default_series_id: 's9' }, null)).toBe('s9')
  })
})

describe('resolveItemInputs with a family', () => {
  it('series by type, every other input as before, same keys as ever', () => {
    const r = resolveItemInputs({}, fam, tSlide, index.types)
    expect(r.series_id).toBe('sSlide')
    expect(r.finish_id).toBe('f1')
    expect(Object.keys(r)).toEqual(['series_id', 'finish_id', 'infill_type_id', 'hardware_set_id', 'thickness_mm', 'sash_thickness_mm', 'labour_per_sqm', 'profit_pct'])
  })
})

describe('itemsAffectedByDefaultFamily', () => {
  const templatesById = { tS: tSlide, tO: tOpen, tA: tAwn, tAddon: { id: 'tAddon', type_id: 'casement' } }
  const items = [
    { id: 'a', template_id: 'tS' },
    { id: 'b', template_id: 'tA' },                              // no awning series in the family
    { id: 'c', template_id: 'tA', series_id: 'sOther' },          // own series: never affected
    { id: 'd', template_id: 'tS', addon_template_id: 'tAddon' },  // slide series does not make the casement add-on
  ]
  it('lists inheriting items the family cannot build', () => {
    expect(itemsAffectedByDefaultFamily(items, templatesById, index, seriesTypes, 'fA').map(i => i.id)).toEqual(['b', 'd'])
  })
  it('no key: nothing; a solo key: exactly the old single-series check', () => {
    expect(itemsAffectedByDefaultFamily(items, templatesById, index, seriesTypes, '')).toEqual([])
    expect(itemsAffectedByDefaultFamily(items, templatesById, index, seriesTypes, 'series:sSlide'))
      .toEqual(itemsAffectedByDefaultSeries(items, templatesById, 'sSlide', seriesTypes))
  })
})
```

Append this `it` at the end of `src/pages/Quotations.isolation.test.jsx` inside a new `describe` (the file's recording fake supports `eq` / `in`):

```jsx
describe('series family: attachment items take the family series of their type', () => {
  it('the loader wraps the project with the family resolver', async () => {
    tenantModules = ['estimation']
    fakeData = {
      ...estimation,
      estimation_projects: [{ ...estimation.estimation_projects[0], default_series_id: null, default_series_family_id: 'FAM' }],
      alu_series_families: [{ id: 'FAM', provider_id: 'PR', name: 'EURO' }],
      alu_series: [
        { id: 'SS', provider_id: 'PR', name: 'EURO Slide', series_family_id: 'FAM' },
        { id: 'SF', provider_id: 'PR', name: 'EURO Fixed', series_family_id: 'FAM' },
      ],
      alu_series_types: [{ id: 'x1', series_id: 'SS', type_id: 'slide' }, { id: 'x2', series_id: 'SF', type_id: 'fixed' }],
    }
    const { hasModuleAccess } = useTenant()
    const r = await loadQuotationAttachments({ quotation, hasModuleAccess })
    const byNo = Object.fromEntries(r.items.map(i => [i.opening_no, i.series_id]))
    expect(byNo['W-01']).toBe('SS')   // slide template
    expect(byNo['F-01']).toBe('SF')   // fixed template
    expect(byNo['D-01']).toBeNull()   // the family has no door series
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/lib/estimationInheritFamily.test.js src/pages/Quotations.isolation.test.jsx`
Expected: FAIL (`inheritedSeries is not a function`; the attachment test gets `null` series).

- [ ] **Step 3: Implement the resolver**

In `src/lib/estimationInherit.js` add the import under the existing ones:

```js
import { familySeriesForType, isSoloKey, soloSeriesId } from './seriesFamily.js'
```

Add after the `firstNum` helper:

```js
// The series an item uses and where it comes from (spec 2026-10-31 section 5): 1 its own; 2 the project's series family
// for the template's type (project wrapped by seriesFamily.withFamilyResolver; its answer is final, null included);
// 3 the project's single default series (projects from before families); 4 none.
export function inheritedSeries(item, project, template) {
  const it = item || {}
  const pj = project || {}
  if (isSet(it.series_id)) return { series_id: it.series_id, source: 'item', familyMissing: false }
  if (typeof pj.seriesForType === 'function') {
    const id = pj.seriesForType(template && template.type_id ? template.type_id : null)
    return id ? { series_id: id, source: 'family', familyMissing: false } : { series_id: null, source: null, familyMissing: true }
  }
  if (isSet(pj.default_series_id)) return { series_id: pj.default_series_id, source: 'project', familyMissing: false }
  return { series_id: null, source: null, familyMissing: false }
}

export const resolveSeriesId = (item, project, template) => inheritedSeries(item, project, template).series_id
```

In `resolveItemInputs` replace the line `series_id: first(it.series_id, pj.default_series_id),` with:

```js
    series_id: inheritedSeries(it, pj, template).series_id,
```

Append at the end of the file:

```js
// Items that will inherit the family `key` (their own series_id is null) but that it cannot build: the family has no
// series for the main template's type, or the series it gives does not make the add-on. A solo key ('series:<id>')
// is the old single-series check. index = buildCatalogIndex(...), seriesTypes = the expanded links.
export function itemsAffectedByDefaultFamily(items, templatesById, index, seriesTypes, key) {
  if (!key) return []
  if (isSoloKey(key)) return itemsAffectedByDefaultSeries(items, templatesById, soloSeriesId(key), seriesTypes)
  const fam = ((index && index.seriesFamilies) || {})[key]
  const providerId = fam ? fam.provider_id : null
  return (items || []).filter(item => {
    if (item.series_id) return false
    const main = (templatesById || {})[item.template_id]
    if (!main) return false
    const seriesId = familySeriesForType(index, seriesTypes, providerId, key, main.type_id || null)
    if (!seriesId) return true
    const addon = item.addon_template_id ? typeAvailability((templatesById || {})[item.addon_template_id], seriesId, seriesTypes) : 'unknown'
    return addon === 'not_offered'
  })
}
```

(`first` stays: it is still used by finish / infill / hardware.)

- [ ] **Step 4: Wrap the project on the estimation page**

In `src/pages/Estimation.jsx` add to the imports:

```js
import { withFamilyResolver } from '../lib/seriesFamily.js'
```

Replace line 89 `const project = (projects || []).find(p => p.id === selectedProjectId) || null` with:

```js
  const rawProject = (projects || []).find(p => p.id === selectedProjectId) || null
  // Every screen below reads the item's series through resolveItemInputs; with a series family the project carries
  // seriesForType(typeId). A project without a family stays the same object.
  const project = useMemo(() => withFamilyResolver(rawProject, catalog.index, catalog.seriesTypes), [rawProject, catalog.index, catalog.seriesTypes])
```

(`index` is declared a few lines lower as `catalog.index`; use `catalog.index` here so the order of declarations does not matter. The hook stays above every early return.)

- [ ] **Step 5: Wrap the project in the quotation attachment loader**

In `src/pages/estimation/useQuotationAttachments.js` add imports:

```js
import { withFamilyResolver } from '../../lib/seriesFamily.js'
import { buildCatalogIndex } from '../../lib/aluCatalogPricing.js'
```

In `loadQuotationAttachmentsOrThrow`, right after the `const [templates, types, pkgItems] = await Promise.all([...])` block and before `const items = buildAttachmentItems({`, add:

```js
  // A project on a series family: load that family's series and their type links, so items that inherit pick the
  // same series as on the estimation page. No extra query for a project without a family.
  let resolverProject = project
  if (project.default_series_family_id) {
    const famId = project.default_series_family_id
    const [famRows, famSeries] = await Promise.all([
      sb.from('alu_series_families').select('*').eq('id', famId).then(must),
      sb.from('alu_series').select('*').eq('series_family_id', famId).then(must),
    ])
    const ids = (famSeries || []).map(s => s.id)
    const famLinks = ids.length ? (must(await sb.from('alu_series_types').select('*').in('series_id', ids)) || []) : []
    const mini = buildCatalogIndex({ seriesFamilies: famRows, series: famSeries, seriesTypes: famLinks, types })
    resolverProject = withFamilyResolver(project, mini, Object.values(mini.seriesTypesBySeries).flat())
  }
```

and pass `project: resolverProject` (instead of `project`) to `buildAttachmentItems({ … })`. Nothing else in the loader changes.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run src/lib/estimationInheritFamily.test.js src/pages/Quotations.isolation.test.jsx src/lib/estimationInherit.test.js src/lib/openingCost.test.js src/lib/itemPreviewSignature.test.js`
Expected: PASS (the existing files unchanged and green: a project without a family resolves exactly as before).
Run: `npx vitest run` → Expected: all green.

- [ ] **Step 7: Commit**

```bash
cd /Users/plfx/code/FacadeXPM/facadex-app/.claude/worktrees/series-family
git add src/lib/estimationInherit.js src/lib/estimationInheritFamily.test.js src/pages/Estimation.jsx src/pages/estimation/useQuotationAttachments.js src/pages/Quotations.isolation.test.jsx
git commit -F - <<'MSG'
feat(estimation): item series order item > family by type > old default; project wrapped once

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SKarDAHEncS9RZ6zCSPXc1
MSG
```

---
### Task 4: Every direct reader goes through the resolver; item form hints; hardware set order in the item form

**Files:**
- Modify: `src/pages/estimation/itemForm.js` (`reconcileItemForm` line 179; new `itemSeriesOptions`, `itemSeriesHint`)
- Modify: `src/pages/estimation/ItemsTable.jsx:47`
- Modify: `src/pages/estimation/projectDefaults.js` (`hardwareBanners` line 151, `availabilityIssues` lines 156-169)
- Modify: `src/pages/estimation/AvailabilityBanner.jsx` (family-missing line)
- Modify: `src/lib/estimationCatalogViews.js` (new `hardwareSetChoices`)
- Modify: `src/pages/estimation/useItemModel.js` (lines 36-100: inherited label, series options/hint, hardware sets)
- Modify: `src/pages/estimation/ItemFields.jsx:66-71` (series field)
- Test: `src/pages/estimation/itemFormFamily.test.js` (new), `src/pages/estimation/projectDefaultsFamily.test.js` (new), `src/lib/hardwareSetChoices.test.js` (new), `src/lib/defaultSeriesReaders.test.js` (new guard)

**Interfaces:**
- Consumes: `inheritedSeries`, `resolveSeriesId` (Task 3); `projectSeriesIds` (Task 2); `seriesChoices(index, providerId)` (`projectDefaults.js`); `hardwareSetsForSeries` (`estimationCatalogViews.js`).
- Produces:
  - `itemSeriesOptions({ index, project, typeId, seriesTypes }) -> { value, label }[]` (the family's series that make `typeId` first, then every other series of the main extruder) — `itemForm.js`
  - `itemSeriesHint({ index, project, template, seriesTypes, ownSeriesId }) -> { warn } | { hint } | null` — `itemForm.js`. Texts: `ซีรีส์หลัก <ชื่อ> ไม่มีชุดสำหรับประเภทนี้ — เลือกชุดในรายการ`, `ซีรีส์หลักนี้มี <n> ชุด<ชื่อประเภท> — เลือกได้ที่นี่`.
  - `hardwareSetChoices(index, seriesId, typeId) -> part[]` — `estimationCatalogViews.js` (sets linked to the series/type first, then sets linked to no series at all)
  - `availabilityIssues` entries may now be `{ item, which: 'main', template, familyMissing: true, familyName, offeredBy: [] }`.
  - `useItemModel(...)` result gains `seriesHint` (above) and its `inherit.series` is the label of the series the resolver picks for the template.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/defaultSeriesReaders.test.js`:

```js
// src/lib/defaultSeriesReaders.test.js
// Guard (spec 2026-10-31 section 5): the project's series is read only through the resolver (estimationInherit
// inheritedSeries / resolveSeriesId, seriesFamily). Any other source file that names default_series_id would bypass
// the project's series family.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ALLOWED = new Set([
  'src/lib/estimationInherit.js',
  'src/lib/seriesFamily.js',
  'src/pages/estimation/projectDefaults.js',
  'src/pages/estimation/ProjectDefaultsPanel.jsx',   // leaves this list in Task 5
  'src/pages/estimation/ProviderCompare.jsx',        // leaves this list in Task 7
])
function walk(dir, out = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(js|jsx)$/.test(f) && !/\.test\.(js|jsx)$/.test(f)) out.push(p)
  }
  return out
}

describe('default_series_id is read only by the resolver', () => {
  it('no other source file names it', () => {
    const offenders = walk('src').filter(p => !ALLOWED.has(p) && readFileSync(p, 'utf8').includes('default_series_id'))
    expect(offenders).toEqual([])
  })
})
```

Create `src/lib/hardwareSetChoices.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { buildCatalogIndex } from './aluCatalogPricing.js'
import { hardwareSetChoices } from './estimationCatalogViews.js'

const index = buildCatalogIndex({
  types: [{ id: 'slide' }, { id: 'casement' }],
  parts: [
    { id: 'hLinked', kind: 'hardware_set', name: 'B linked' }, { id: 'hType', kind: 'hardware_set', name: 'A slide only' },
    { id: 'hOther', kind: 'hardware_set', name: 'C other series' }, { id: 'hFree', kind: 'hardware_set', name: 'D free' },
    { id: 'hOff', kind: 'hardware_set', name: 'E free off', active: false }, { id: 'p', kind: 'hardware', name: 'a part' },
  ],
  seriesParts: [
    { series_id: 's1', part_id: 'hLinked', type_id: null }, { series_id: 's1', part_id: 'hType', type_id: 'slide' },
    { series_id: 's2', part_id: 'hOther', type_id: null },
  ],
})

describe('hardwareSetChoices', () => {
  it("the series' sets for the type first, then sets linked to no series at all", () => {
    expect(hardwareSetChoices(index, 's1', 'slide').map(p => p.id)).toEqual(['hType', 'hLinked', 'hFree'])
    expect(hardwareSetChoices(index, 's1', 'casement').map(p => p.id)).toEqual(['hLinked', 'hFree'])
  })
  it('no series yet: only the sets usable with any series', () => {
    expect(hardwareSetChoices(index, null, 'slide').map(p => p.id)).toEqual(['hFree'])
  })
})
```

Create `src/pages/estimation/itemFormFamily.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { buildCatalogIndex } from '../../lib/aluCatalogPricing.js'
import { withFamilyResolver } from '../../lib/seriesFamily.js'
import { reconcileItemForm, itemSeriesOptions, itemSeriesHint } from './itemForm.js'

const index = buildCatalogIndex({
  providers: [{ id: 'A', name: 'Alumet' }],
  seriesFamilies: [{ id: 'fH', provider_id: 'A', name: 'HOMELIFE' }],
  series: [
    { id: 'h1', provider_id: 'A', name: 'HL 2000 Slide', series_family_id: 'fH' },
    { id: 'h2', provider_id: 'A', name: 'HL 268 Slide', series_family_id: 'fH' },
    { id: 'h3', provider_id: 'A', name: 'HL 5000 Door', series_family_id: 'fH' },
    { id: 'x', provider_id: 'A', name: 'AAA other' },
  ],
  types: [{ id: 'slide', name: 'บานเลื่อน' }, { id: 'door', name: 'ประตูบานเปิด' }, { id: 'awning', name: 'บานกระทุ้ง' }],
  seriesTypes: [{ series_id: 'h1', type_id: 'slide' }, { series_id: 'h2', type_id: 'slide' }, { series_id: 'h3', type_id: 'door' }],
  profiles: [{ id: 'p', provider_id: 'A', thickness_mm: 1.2 }],
  seriesProfiles: [{ series_id: 'h3', profile_id: 'p' }],
})
const seriesTypes = Object.values(index.seriesTypesBySeries).flat()
const project = withFamilyResolver({ id: 'pj', default_series_family_id: 'fH', primary_provider_id: 'A' }, index, seriesTypes)

describe('item form with a project series family', () => {
  it('options: the family series of this type first, then the rest of the extruder', () => {
    expect(itemSeriesOptions({ index, project, typeId: 'slide', seriesTypes }).map(o => o.value)).toEqual(['h1', 'h2', 'x', 'h3'])
  })
  it('several family series for one type: a small hint', () => {
    expect(itemSeriesHint({ index, project, template: { type_id: 'slide' }, seriesTypes, ownSeriesId: '' }))
      .toEqual({ hint: 'ซีรีส์หลักนี้มี 2 ชุดบานเลื่อน — เลือกได้ที่นี่' })
  })
  it('no family series for the type: a warning, unless the item picked its own series', () => {
    expect(itemSeriesHint({ index, project, template: { type_id: 'awning' }, seriesTypes, ownSeriesId: '' }))
      .toEqual({ warn: 'ซีรีส์หลัก HOMELIFE ไม่มีชุดสำหรับประเภทนี้ — เลือกชุดในรายการ' })
    expect(itemSeriesHint({ index, project, template: { type_id: 'awning' }, seriesTypes, ownSeriesId: 'x' })).toBeNull()
  })
  it('one family series, or a project without a family: no hint', () => {
    expect(itemSeriesHint({ index, project, template: { type_id: 'door' }, seriesTypes, ownSeriesId: '' })).toBeNull()
    expect(itemSeriesHint({ index, project: { default_series_id: 'x' }, template: { type_id: 'slide' }, seriesTypes, ownSeriesId: '' })).toBeNull()
  })
  it('reconcileItemForm reads the thickness of the series the family gives this template', () => {
    const f = reconcileItemForm({ series_id: '', thickness_mm: '', sash_thickness_mm: '' }, { series_id: '', thickness_mm: '', sash_thickness_mm: '' },
      { index, project, template: { type_id: 'door' }, isNew: true })
    expect(f.thickness_mm).toBe('1.2')
  })
})
```

Create `src/pages/estimation/projectDefaultsFamily.test.js` (Tasks 5 and 6 append to it):

```js
import { describe, it, expect } from 'vitest'
import { buildCatalogIndex } from '../../lib/aluCatalogPricing.js'
import { withFamilyResolver } from '../../lib/seriesFamily.js'
import { hardwareBanners, availabilityIssues } from './projectDefaults.js'

export const famIndex = buildCatalogIndex({
  providers: [{ id: 'A', name: 'บจก. อลูเม็ท (Alumet)' }, { id: 'B', name: 'SMS' }],
  seriesFamilies: [
    { id: 'fI', provider_id: 'A', name: 'ICONIQ EURO', thickness_options: null },
    { id: 'fS', provider_id: 'A', name: 'STANDARD', thickness_options: [1.0, 1.2, 1.5, 1.8, 2.0] },
  ],
  series: [
    { id: 'iSlide', provider_id: 'A', name: 'ICONIQ EURO บานเลื่อน', series_family_id: 'fI' },
    { id: 'iOpen', provider_id: 'A', name: 'ICONIQ EURO บานเปิด / บานกระทุ้ง', series_family_id: 'fI' },
    { id: 'iFix', provider_id: 'A', name: 'ICONIQ EURO บานติดตาย', series_family_id: 'fI' },
    { id: 'mc', provider_id: 'A', name: 'MINI MC ท่อกลม / กล่องสี่เหลี่ยม', series_family_id: 'fS' },
    { id: 'b1', provider_id: 'B', name: 'SMS 230' },
  ],
  types: [{ id: 'tSlide', name: 'บานเลื่อน' }, { id: 'tOpen', name: 'บานเปิด' }, { id: 'tFix', name: 'บานติดตาย' }, { id: 'tFold', name: 'บานเฟี้ยม' }],
  seriesTypes: [
    { series_id: 'iSlide', type_id: 'tSlide', allow_mixed_thickness: false },
    { series_id: 'iOpen', type_id: 'tOpen', allow_mixed_thickness: true },
    { series_id: 'iFix', type_id: 'tFix', allow_mixed_thickness: false },
  ],
  finishes: [{ id: 'fin', provider_id: 'A', name: '15664 Heritage Oak' }],
  profiles: [{ id: 'p12', provider_id: 'A', thickness_mm: 1.2 }, { id: 'p20', provider_id: 'A', thickness_mm: 2 }],
  seriesProfiles: [{ series_id: 'iSlide', profile_id: 'p12' }, { series_id: 'iOpen', profile_id: 'p20' }],
})
export const famSeriesTypes = Object.values(famIndex.seriesTypesBySeries).flat()
const templatesById = { tS: { id: 'tS', name: 'บานเลื่อน 2 บาน', type_id: 'tSlide' }, tF: { id: 'tF', name: 'บานเฟี้ยม 4 บาน', type_id: 'tFold' } }

describe('banners with a project family', () => {
  const project = withFamilyResolver({ id: 'p', default_series_family_id: 'fI' }, famIndex, famSeriesTypes)
  it('a type the family has no series for is listed with the family name', () => {
    const issues = availabilityIssues({ items: [{ id: 'a', template_id: 'tS' }, { id: 'b', template_id: 'tF' }], project, templatesById, index: famIndex, seriesTypes: famSeriesTypes })
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ which: 'main', familyMissing: true, familyName: 'ICONIQ EURO', offeredBy: [] })
    expect(issues[0].item.id).toBe('b')
  })
  it('a package of a series inside the family is not "another series"', () => {
    const base = { packageItems: null, items: [], templatesById, typesById: famIndex.types }
    expect(hardwareBanners({ ...base, project, pkg: { series_id: 'iOpen' } }).wrongSeries).toBe(false)
    expect(hardwareBanners({ ...base, project, pkg: { series_id: 'b1' } }).wrongSeries).toBe(true)
    expect(hardwareBanners({ ...base, project, pkg: { series_id: null } }).wrongSeries).toBe(false)
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/lib/defaultSeriesReaders.test.js src/lib/hardwareSetChoices.test.js src/pages/estimation/itemFormFamily.test.js src/pages/estimation/projectDefaultsFamily.test.js`
Expected: FAIL — the guard lists `src/pages/estimation/itemForm.js`, `src/pages/estimation/ItemsTable.jsx`, `src/pages/estimation/useItemModel.js`; the others fail on missing exports / null family results.

- [ ] **Step 3: `itemForm.js`**

Add imports at the top:

```js
import { resolveSeriesId } from '../../lib/estimationInherit.js'
import { seriesChoices } from './projectDefaults.js'
```

In `reconcileItemForm` replace `const seriesId = f.series_id || pj.default_series_id || null` with:

```js
  const seriesId = f.series_id || resolveSeriesId(null, pj, template) || null
```

Add after `withCurrent`:

```js
// The item's series options: with a project family, the family's series that make this type come first, then every
// other series of the main extruder (same labels as seriesChoices).
export function itemSeriesOptions({ index, project, typeId, seriesTypes }) {
  const pj = project || {}
  const all = seriesChoices(index, pj.primary_provider_id)
  const fam = Array.isArray(pj.familySeriesIds) ? pj.familySeriesIds : []
  const fits = id => !typeId || (seriesTypes || []).some(st => st.series_id === id && st.type_id === typeId)
  const first = fam.filter(id => fits(id)).map(id => all.find(o => o.value === id)).filter(Boolean)
  return [...first, ...all.filter(o => !first.includes(o))]
}

// The note under the item's series field (spec section 7): a warning when the project family has no series for this
// type (and the item has none of its own), a hint when the family has several for it. null otherwise.
export function itemSeriesHint({ index, project, template, seriesTypes, ownSeriesId }) {
  const pj = project || {}
  if (typeof pj.seriesForType !== 'function') return null
  const typeId = template && template.type_id
  if (!typeId) return null
  if (!ownSeriesId && !pj.seriesForType(typeId)) {
    const fam = pj.familyName ? `ซีรีส์หลัก ${pj.familyName}` : 'ซีรีส์หลักของโปรเจกต์'
    return { warn: `${fam} ไม่มีชุดสำหรับประเภทนี้ — เลือกชุดในรายการ` }
  }
  const n = (pj.familySeriesIds || []).filter(id => (seriesTypes || []).some(st => st.series_id === id && st.type_id === typeId)).length
  const typeName = index.types[typeId] ? index.types[typeId].name : 'ประเภทนี้'
  return n > 1 ? { hint: `ซีรีส์หลักนี้มี ${n} ชุด${typeName} — เลือกได้ที่นี่` } : null
}
```

(`projectDefaults.js` does not import `itemForm.js`, so there is no import cycle; check with `grep -n "itemForm" src/pages/estimation/projectDefaults.js` → no output.)

- [ ] **Step 4: `ItemsTable.jsx`**

Add `import { resolveSeriesId } from '../../lib/estimationInherit.js'` and replace line 47 with:

```jsx
              const seriesId = resolveSeriesId(o, project, tpl)
```

- [ ] **Step 5: `projectDefaults.js` banners and `AvailabilityBanner.jsx`**

Imports: change `import { typeAvailability } from '../../lib/estimationInherit.js'` to `import { typeAvailability, inheritedSeries } from '../../lib/estimationInherit.js'` and add `import { projectSeriesIds } from '../../lib/seriesFamily.js'`.

In `hardwareBanners` replace the `wrongSeries` line with:

```js
  // a package tied to a series outside the project's family / single series (a package with no series fits any)
  const ids = projectSeriesIds(project)
  const wrongSeries = !!(pkg && pkg.series_id && ids.length && !ids.includes(pkg.series_id))
```

Replace the body of `availabilityIssues` with:

```js
export function availabilityIssues({ items, project, templatesById, index, seriesTypes }) {
  const out = []
  for (const item of items || []) {
    const main = item.template_id ? (templatesById || {})[item.template_id] : null
    const inh = inheritedSeries(item, project, main)
    if (inh.familyMissing) {
      if (main) out.push({ item, which: 'main', template: main, familyMissing: true, familyName: (project && project.familyName) || '', offeredBy: [] })
      continue
    }
    const seriesId = inh.series_id
    if (!seriesId) continue
    for (const [which, tid] of [['main', item.template_id], ['addon', item.addon_template_id]]) {
      const t = tid ? (templatesById || {})[tid] : null
      if (!t || typeAvailability(t, seriesId, seriesTypes) !== 'not_offered') continue
      out.push({ item, which, template: t, offeredBy: seriesForType(index, t.type_id).map(s => seriesLabelFull(s, index.providers[s.provider_id])) })
    }
  }
  return out
}
```

In `AvailabilityBanner.jsx` replace the `{' — '}{x.offeredBy.length ? …}` part of the `<li>` with:

```jsx
                {' — '}{x.familyMissing
                  ? `ซีรีส์หลัก ${x.familyName} ไม่มีชุดสำหรับประเภทนี้ — เลือกชุดในรายการ`
                  : (x.offeredBy.length ? `มีในซีรีส์ ${x.offeredBy.join(', ')}` : 'ยังไม่มีซีรีส์ไหนทำแบบนี้')}
```

- [ ] **Step 6: `hardwareSetChoices` in `src/lib/estimationCatalogViews.js`**

Add after `accessoriesForSeries`:

```js
// The item form's hardware sets (spec section 12): the sets linked to the item's series (and type) first, then the
// sets linked to no series at all (usable with any series). Each group by name; inactive sets are left out.
export function hardwareSetChoices(index, seriesId, typeId) {
  const linked = seriesId ? hardwareSetsForSeries(index, seriesId, typeId) : []
  const anyLink = new Set(Object.values(index.seriesPartsBySeries || {}).flat().map(l => l.part_id))
  const free = Object.values(index.parts || {})
    .filter(p => p.kind === 'hardware_set' && p.active !== false && !anyLink.has(p.id))
    .sort(byName)
  return [...linked, ...free.filter(p => !linked.some(x => x.id === p.id))]
}
```

- [ ] **Step 7: `useItemModel.js` and `ItemFields.jsx`**

In `useItemModel.js`:
- imports: `resolveItemInputs, addonTemplatesForSeries, typeAvailability, inheritedSeries` from `estimationInherit.js`; replace `hardwareSetsForSeries` with `hardwareSetChoices` in the `estimationCatalogViews.js` import; add `itemSeriesOptions, itemSeriesHint` to the `./itemForm.js` import; remove `seriesChoices` from the `./projectDefaults.js` import (keep `finishChoices`).
- replace `const pjSeries = pj.default_series_id ? index.series[pj.default_series_id] : null` with:

```js
    // what the project gives THIS template: its family's series for the type, or the old single default
    const fromProject = inheritedSeries(null, pj, template)
    const pjSeries = fromProject.series_id ? index.series[fromProject.series_id] : null
```

- replace the `hwOpts` line with:

```js
    const hwOpts = withCurrent(optionsOf(hardwareSetChoices(index, seriesId, template && template.type_id)), form.hardware_set_id, nameOf(index.parts, form.hardware_set_id))
```

- replace the `seriesOpts:` entry with these two entries:

```js
      seriesOpts: withCurrent(itemSeriesOptions({ index, project: pj, typeId: template && template.type_id, seriesTypes }), form.series_id, nameOf(index.series, form.series_id), '(ไม่อยู่ในรายการ)'),
      seriesHint: itemSeriesHint({ index, project: pj, template, seriesTypes, ownSeriesId: form.series_id }),
```

- replace the `hwOwnHint:` value with:

```js
      inherit, hwOpts, hwOwnHint: series ? `ชุดที่ใช้กับ ${series.name} ขึ้นก่อน · ชุดที่ไม่ผูกซีรีส์ใช้ได้ทุกซีรีส์` : 'เลือกซีรีส์ก่อน',
```

In `ItemFields.jsx` replace the series `<Field label="ซีรีส์">…</Field>` block with:

```jsx
        <Field label="ซีรีส์" hint={m.seriesHint && m.seriesHint.hint} warn={m.seriesHint && m.seriesHint.warn}>
          <select className="input" disabled={dis} value={form.series_id} onChange={e => update({ series_id: e.target.value })}>
            <option value="">ตามโปรเจกต์ ({m.inherit.series || 'ไม่กำหนด'})</option>
            <Options list={m.seriesOpts} />
          </select>
        </Field>
```

- [ ] **Step 8: Run the tests**

Run: `npx vitest run src/lib/defaultSeriesReaders.test.js src/lib/hardwareSetChoices.test.js src/pages/estimation/itemFormFamily.test.js src/pages/estimation/projectDefaultsFamily.test.js src/pages/estimation/projectDefaults.test.js src/pages/estimation/itemForm.test.js src/pages/estimation/ItemModal.smoke.test.jsx`
Expected: PASS. If `ItemModal.smoke.test.jsx` (or another existing test) pins the old option text "ใช้ค่าโปรเจกต์ · …" of the series select or a hardware-set option list that now also shows unlinked sets, update only that assertion to the new text/list and say so in the commit body (spec section 7 and 12 change exactly these).
Run: `npx vitest run` → Expected: all green.

- [ ] **Step 9: Commit**

```bash
cd /Users/plfx/code/FacadeXPM/facadex-app/.claude/worktrees/series-family
git add src/pages/estimation/itemForm.js src/pages/estimation/ItemsTable.jsx src/pages/estimation/projectDefaults.js src/pages/estimation/AvailabilityBanner.jsx src/lib/estimationCatalogViews.js src/pages/estimation/useItemModel.js src/pages/estimation/ItemFields.jsx src/lib/defaultSeriesReaders.test.js src/lib/hardwareSetChoices.test.js src/pages/estimation/itemFormFamily.test.js src/pages/estimation/projectDefaultsFamily.test.js
git commit -F - <<'MSG'
feat(estimation): item form, table and banners read the series through the family resolver

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SKarDAHEncS9RZ6zCSPXc1
MSG
```

---
### Task 5: Project defaults — the "ซีรีส์หลัก" field (draft, reconcile, patch, thickness, packages, warning)

**Files:**
- Modify: `src/pages/estimation/projectDefaults.js` (`DRAFT_COLUMNS`, `draftFromProject`, `reconcileDraft`; new `draftSeriesKey`, `applySeriesKey`)
- Modify: `src/lib/projectHardware.js` (new `packagesForSeriesIds`)
- Modify: `src/pages/estimation/ProjectDefaultsPanel.jsx` (series field → family field; `alert` → `InlineError`)
- Modify: `src/lib/defaultSeriesReaders.test.js` (remove `ProjectDefaultsPanel.jsx` from `ALLOWED` — the panel no longer names the column)
- Modify: `src/pages/estimation/noBrowserDialogs.test.js` (add `'ProjectDefaultsPanel.jsx'` to `FILES`)
- Test: `src/pages/estimation/projectDefaultsFamily.test.js` (append), `src/pages/estimation/ProjectDefaultsPanel.smoke.test.jsx` (new)

**Interfaces:**
- Consumes (Task 2): `familyChoices`, `familyLabel`, `familySeries`, `familyThicknesses`, `familyAllowsMixed`, `keyProviderId`, `isSoloKey`, `soloSeriesId`, `soloKey`; (Task 3) `itemsAffectedByDefaultFamily`.
- Produces:
  - draft gains `default_series_family_id: string` ('' = none); `DRAFT_COLUMNS` includes `'default_series_family_id'`.
  - `draftSeriesKey(draft) -> key` and `applySeriesKey(draft, key, index) -> draft` (a family sets `default_series_family_id` and blanks `default_series_id`; a solo key the reverse; a blank main extruder is filled with the key's extruder). Saving a family therefore writes `default_series_id: null` (spec section 4.3).
  - `reconcileDraft(draft, index, seriesTypes)` same signature; works on the key.
  - `packagesForSeriesIds(packages, seriesIds) -> package[]` (active, `series_id` NULL or in the list, by name) — `projectHardware.js`.

- [ ] **Step 1: Write the failing tests**

Append to `src/pages/estimation/projectDefaultsFamily.test.js` (add `draftFromProject, reconcileDraft, buildPatch, draftSeriesKey, applySeriesKey, patchChangesSeries` to its `./projectDefaults.js` import and `import { packagesForSeriesIds } from '../../lib/projectHardware.js'`):

```js
describe('the ซีรีส์หลัก draft', () => {
  const legacy = { id: 'p', primary_provider_id: 'A', default_series_id: 'iSlide', default_finish_id: 'fin', profit_pct: 50 }
  it('a legacy project reads as a solo key; picking a family swaps the columns', () => {
    const d = draftFromProject(legacy)
    expect(d.default_series_family_id).toBe('')
    expect(draftSeriesKey(d)).toBe('series:iSlide')
    const f = applySeriesKey(d, 'fI', famIndex)
    expect([f.default_series_family_id, f.default_series_id]).toEqual(['fI', ''])
    expect(draftSeriesKey(applySeriesKey(f, 'series:mc', famIndex))).toBe('series:mc')
  })
  it('saving a family writes the family and clears the single series', () => {
    const d = reconcileDraft(applySeriesKey(draftFromProject(legacy), 'fI', famIndex), famIndex, famSeriesTypes)
    expect(buildPatch(legacy, d)).toEqual({ default_series_family_id: 'fI', default_series_id: null })
    expect(patchChangesSeries(buildPatch(legacy, d))).toBe(true)
    expect(patchChangesSeries({ profit_pct: 5 })).toBe(false)
  })
  it('a family fills a blank main extruder', () => {
    expect(applySeriesKey(draftFromProject({}), 'fI', famIndex).primary_provider_id).toBe('A')
  })
  it('switching the main extruder clears a family of another extruder (Review Focus 2)', () => {
    const d = reconcileDraft({ ...draftFromProject({ primary_provider_id: 'A', default_series_family_id: 'fI', default_finish_id: 'fin' }), primary_provider_id: 'B' }, famIndex, famSeriesTypes)
    expect([d.default_series_family_id, d.default_series_id, d.default_finish_id]).toEqual(['', '', ''])
  })
  it("frame thickness: the family's list (STANDARD 5 values) or the union of its series; colour of its extruder kept", () => {
    const std = reconcileDraft({ ...draftFromProject({ primary_provider_id: 'A', default_finish_id: 'fin' }), default_series_family_id: 'fS', default_thickness_mm: '1.8' }, famIndex, famSeriesTypes)
    expect(std.default_thickness_mm).toBe('1.8')
    expect(std.default_finish_id).toBe('fin')
    const bad = reconcileDraft({ ...draftFromProject({ primary_provider_id: 'A' }), default_series_family_id: 'fI', default_thickness_mm: '1.8' }, famIndex, famSeriesTypes)
    expect(bad.default_thickness_mm).toBe('')    // ICONIQ EURO offers 1.2 and 2.0 only
  })
  it('the sash thickness exists when one series of the family allows mixed thickness', () => {
    const d = reconcileDraft({ ...draftFromProject({ primary_provider_id: 'A' }), default_series_family_id: 'fI', default_thickness_mm: '2' }, famIndex, famSeriesTypes)
    expect(d.default_sash_thickness_mm).toBe('2')
  })
  it('packages: no series or a series of the family', () => {
    const pk = [{ id: 'a', name: 'B', series_id: null }, { id: 'b', name: 'A', series_id: 'iOpen' }, { id: 'c', name: 'C', series_id: 'b1' }, { id: 'd', name: 'D', series_id: null, active: false }]
    expect(packagesForSeriesIds(pk, ['iOpen', 'iSlide']).map(p => p.id)).toEqual(['b', 'a'])
    expect(packagesForSeriesIds(pk, []).map(p => p.id)).toEqual(['a'])
  })
})
```

Create `src/pages/estimation/ProjectDefaultsPanel.smoke.test.jsx`:

```jsx
// SSR smoke: the defaults form offers ซีรีส์หลัก (families of the main extruder) and shows the saved one.
import { describe, it, expect, vi } from 'vitest'
import { renderToString } from 'react-dom/server'
import { buildCatalogIndex } from '../../lib/aluCatalogPricing.js'

vi.mock('../../lib/supabase.js', () => ({ supabase: {} }))
const { default: ProjectDefaultsPanel } = await import('./ProjectDefaultsPanel.jsx')

const index = buildCatalogIndex({
  providers: [{ id: 'A', name: 'บจก. อลูเม็ท (Alumet)' }],
  seriesFamilies: [{ id: 'fI', provider_id: 'A', name: 'ICONIQ EURO' }],
  series: [
    { id: 's1', provider_id: 'A', name: 'ICONIQ EURO บานเลื่อน', series_family_id: 'fI' },
    { id: 's2', provider_id: 'A', name: 'ICONIQ EURO บานเปิด / บานกระทุ้ง', series_family_id: 'fI' },
    { id: 's3', provider_id: 'A', name: 'ICONIQ EURO บานติดตาย', series_family_id: 'fI' },
  ],
})
const clean = h => h.replace(/<!-- -->/g, '')
const render = project => clean(renderToString(
  <ProjectDefaultsPanel project={project} index={index} seriesTypes={[]} infillTypes={[]} packages={[]} items={[]} templatesById={{}} canEdit onSaved={async () => {}} />,
))

describe('ProjectDefaultsPanel: ซีรีส์หลัก', () => {
  it('a new project: expanded form with the family choices of the main extruder', () => {
    const h = render({ id: 'p1', primary_provider_id: null, profit_pct: 30, price_as_of: '2026-10-31' })
    expect(h).toContain('ซีรีส์หลัก')
    expect(h).toContain('ICONIQ EURO · 3 ชุด')
    expect(h).not.toMatch(/NaN|undefined/)
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/pages/estimation/projectDefaultsFamily.test.js src/pages/estimation/ProjectDefaultsPanel.smoke.test.jsx`
Expected: FAIL (`draftSeriesKey is not a function`; the panel still says "ซีรีส์").

- [ ] **Step 3: `projectDefaults.js`**

Add the import:

```js
import { familyThicknesses, familyAllowsMixed, keyProviderId, isSoloKey, soloSeriesId, soloKey } from '../../lib/seriesFamily.js'
```

(merge with the `projectSeriesIds` import from Task 4.) Then:

```js
export const DRAFT_COLUMNS = [
  'primary_provider_id', 'default_series_family_id', 'default_series_id', 'default_finish_id', 'default_thickness_mm', 'default_sash_thickness_mm',
  'default_infill_id', 'hardware_package_id', 'labour_per_sqm', 'profit_pct', 'description_format',
]
```

In `draftFromProject` add `default_series_family_id: str(pj.default_series_family_id),` after `primary_provider_id`.

Add after `draftFromProject`:

```js
// The draft's ซีรีส์หลัก as one picker value: '' | family id | 'series:<id>' (a series with no family).
export const draftSeriesKey = d => (d && d.default_series_family_id) || (d && d.default_series_id ? soloKey(d.default_series_id) : '')

// Picking a ซีรีส์หลัก: a family blanks the single series and the reverse (the new screen never writes both); a blank
// main extruder takes the key's extruder.
export function applySeriesKey(draft, key, index) {
  const d = { ...draft }
  if (!key) { d.default_series_family_id = ''; d.default_series_id = '' }
  else if (isSoloKey(key)) { d.default_series_family_id = ''; d.default_series_id = soloSeriesId(key) }
  else { d.default_series_family_id = key; d.default_series_id = '' }
  const pid = keyProviderId(index, key)
  if (pid && !d.primary_provider_id) d.primary_provider_id = pid
  return d
}

// True when a buildPatch result changes the ซีรีส์หลัก (family or single series): the panel then lists affected items.
export const patchChangesSeries = patch => 'default_series_family_id' in (patch || {}) || 'default_series_id' in (patch || {})
```

Replace `reconcileDraft` with:

```js
// Brings dependent fields back in line after any change: the ซีรีส์หลัก (family or single series) must belong to the
// main extruder, the colour to its extruder, thicknesses must be ones it offers (a single one is selected for the
// owner), and the sash thickness exists only where a type of its series allows mixed thickness. Returns a new draft.
export function reconcileDraft(draft, index, seriesTypes) {
  const d = { ...draft }
  const key0 = draftSeriesKey(d)
  const pid0 = keyProviderId(index, key0)
  if (key0 && (!pid0 || (d.primary_provider_id && pid0 !== d.primary_provider_id))) { d.default_series_family_id = ''; d.default_series_id = '' }
  const key = draftSeriesKey(d)
  const finishes = finishChoices(index, d.default_series_id || null, keyProviderId(index, key) || d.primary_provider_id)
  if (d.default_finish_id && !finishes.some(f => f.value === d.default_finish_id)) d.default_finish_id = ''
  const opts = familyThicknesses(index, key)
  if (opts.length === 1) d.default_thickness_mm = String(opts[0])
  else if (!opts.includes(Number(d.default_thickness_mm))) d.default_thickness_mm = ''
  const mixed = familyAllowsMixed(index, seriesTypes, key)
  if (!mixed || !opts.includes(Number(d.default_sash_thickness_mm))) d.default_sash_thickness_mm = ''
  // Ruling 21: where the sash select is shown the saved value is a real number. Only a blank is filled (from the frame);
  // an existing sash never follows later frame changes. No frame yet = stays blank (saved as NULL).
  if (mixed && d.default_sash_thickness_mm === '' && d.default_thickness_mm !== '') d.default_sash_thickness_mm = d.default_thickness_mm
  return d
}
```

(For a single series this is exactly the old behaviour: `familyThicknesses` / `familyAllowsMixed` of a solo key are `thicknessesForSeries` / `mixedThicknessAllowed`, and `finishChoices` gets the series' own extruder. The existing `projectDefaults.test.js` stays green unchanged.) The `thicknessesForSeries` import in this file stays only if something else still uses it; otherwise remove it.

In `src/lib/projectHardware.js` append:

```js
// Active packages the project's ซีรีส์หลัก may use: no series, or one of seriesIds. By name.
export function packagesForSeriesIds(packages, seriesIds) {
  const ids = seriesIds || []
  return (packages || [])
    .filter(p => p.active !== false && (!p.series_id || ids.includes(p.series_id)))
    .sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? ''), 'th'))
}
```

- [ ] **Step 4: `ProjectDefaultsPanel.jsx`**

Imports: drop `thicknessesForSeries`, `itemsAffectedByDefaultSeries`, `packagesForSeries`, `seriesLabelFull`, and `seriesChoices` / `mixedThicknessAllowed`; add:

```js
import InlineError from './InlineError.jsx'
import { itemsAffectedByDefaultFamily } from '../../lib/estimationInherit.js'
import { packagesForSeriesIds } from '../../lib/projectHardware.js'
import { familyChoices, familyLabel, familySeries, familyThicknesses, familyAllowsMixed, keyProviderId } from '../../lib/seriesFamily.js'
import {
  draftFromProject, reconcileDraft, finishChoices, sashDisplayValue, validateDraft, buildPatch, draftSeriesKey, applySeriesKey,
  patchChangesSeries,
} from './projectDefaults.js'
```

(The panel must not name `default_series_id` itself: the guard test of Task 4 fails once the panel leaves its allow-list. `patchChangesSeries` lives in `projectDefaults.js`, which is allowed.)

Replace the block from `const seriesOpts = …` down to `if (chosenPkg && …) pkgOpts.push(chosenPkg)` with:

```js
  const seriesKey = draftSeriesKey(draft)
  const familyOpts = familyChoices(index, draft.primary_provider_id)
  // the saved ซีรีส์หลัก stays visible even when it is no longer offered (switched off / series inactive)
  const keyOpts = seriesKey && !familyOpts.some(o => o.value === seriesKey)
    ? [...familyOpts, { value: seriesKey, label: `${familyLabel(index, seriesKey) || 'ที่ถูกลบแล้ว'} (ปิดใช้งาน)` }]
    : familyOpts
  const keyProvider = keyProviderId(index, seriesKey)
  const finishOpts = finishChoices(index, null, keyProvider || draft.primary_provider_id)   // a key's extruder = its series' extruder
  const thicknesses = familyThicknesses(index, seriesKey)
  const singleThickness = thicknesses.length === 1
  const showSash = familyAllowsMixed(index, seriesTypes, seriesKey)
  const pkgOpts = [...packagesForSeriesIds(packages, familySeries(index, null, seriesKey).map(s => s.id))]
  const chosenPkg = draft.hardware_package_id ? (packages || []).find(p => p.id === draft.hardware_package_id) : null
  if (chosenPkg && !pkgOpts.some(p => p.id === chosenPkg.id)) pkgOpts.push(chosenPkg)
  const changeSeries = key => setDraft(d => reconcileDraft(applySeriesKey(d, key, index), index, seriesTypes))
```

In `sampleDesc` use `series_label: familyLabel(index, seriesKey),`.

Add `const [saveError, setSaveError] = useState(null)` next to the other state; in `write` replace `catch (e) { alert('บันทึกไม่สำเร็จ: ' + e.message) }` with `catch (e) { setSaveError('บันทึกไม่สำเร็จ: ' + e.message) }` and call `setSaveError(null)` at the start of `write`.

`handleSave`:

```js
  const handleSave = () => {
    if (error || !dirty) return
    if (patchChangesSeries(patch)) {
      const affected = itemsAffectedByDefaultFamily(items, templatesById, index, seriesTypes, seriesKey)
      if (affected.length) { setConfirm({ patch, affected }); return }
    }
    write(patch)
  }
```

Replace the `<Field label="ซีรีส์">…</Field>` with:

```jsx
        <Field label="ซีรีส์หลัก" hint="แต่ละรายการได้ชุดที่ตรงประเภทบานเอง เปลี่ยนในรายการได้">
          <select className="input" disabled={dis} value={seriesKey} onChange={e => changeSeries(e.target.value)}>
            <option value="">ไม่กำหนด (เลือกต่อรายการ)</option>
            {keyOpts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </Field>
```

Colour hint: `hint={!seriesKey && !draft.primary_provider_id ? 'เลือกซีรีส์หลักหรือโรงรีดก่อน' : null}`. Frame thickness hint: `hint={singleThickness ? 'ซีรีส์หลักนี้มีความหนาเดียว เลือกให้อัตโนมัติ' : (!seriesKey ? 'เลือกซีรีส์หลักก่อน' : 'ในรายการยังเลือกความหนาอื่นของชุดได้')}`. Sash hint: `"ซีรีส์หลักนี้มีประเภทที่ใช้ความหนาวงกบกับกรอบบานไม่เท่ากันได้"`.

Above the error alert add `{saveError && <InlineError onClose={() => setSaveError(null)}>{saveError}</InlineError>}`.

ConfirmDialog: `title="เปลี่ยนซีรีส์หลัก"`, first message line `ซีรีส์หลักใหม่ไม่มีชุดสำหรับแบบต่อไปนี้ ({confirm.affected.length} รายการ) ยังบันทึกได้ แต่รายการเหล่านี้จะคิดราคาไม่ได้จนกว่าจะเลือกชุดในรายการ:`.

Edit the guard lists: remove the `'src/pages/estimation/ProjectDefaultsPanel.jsx',` line from `ALLOWED` in `src/lib/defaultSeriesReaders.test.js`; add `'ProjectDefaultsPanel.jsx'` to `FILES` in `src/pages/estimation/noBrowserDialogs.test.js`.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/pages/estimation/projectDefaultsFamily.test.js src/pages/estimation/ProjectDefaultsPanel.smoke.test.jsx src/pages/estimation/projectDefaults.test.js src/lib/projectHardware.test.js src/lib/defaultSeriesReaders.test.js src/pages/estimation/noBrowserDialogs.test.js`
Expected: PASS. Then `grep -n "default_series_id\|alert(" src/pages/estimation/ProjectDefaultsPanel.jsx` → no output.
Run: `npx vitest run` → Expected: all green.

- [ ] **Step 6: Commit**

```bash
cd /Users/plfx/code/FacadeXPM/facadex-app/.claude/worktrees/series-family
git add src/pages/estimation/projectDefaults.js src/lib/projectHardware.js src/pages/estimation/ProjectDefaultsPanel.jsx src/lib/defaultSeriesReaders.test.js src/pages/estimation/noBrowserDialogs.test.js src/pages/estimation/projectDefaultsFamily.test.js src/pages/estimation/ProjectDefaultsPanel.smoke.test.jsx
git commit -F - <<'MSG'
feat(estimation): project defaults pick a ซีรีส์หลัก (family), thickness/sash/packages follow it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SKarDAHEncS9RZ6zCSPXc1
MSG
```

---
### Task 6: Collapsed defaults card (mockup "ค่าเริ่มต้นโปรเจกต์ แบบย่อ")

**Files:**
- Modify: `src/pages/estimation/projectDefaults.js` (new `hasSavedDefaults`, `defaultsSummary`, `thaiDate`)
- Modify: `src/pages/estimation/ProjectDefaultsPanel.jsx` (open/closed state, collapsed header + chips, "ย่อ ▴")
- Test: `src/pages/estimation/projectDefaultsFamily.test.js` (append), `src/pages/estimation/ProjectDefaultsPanel.collapse.test.jsx` (new, jsdom)

**Interfaces:**
- Consumes: Task 5 panel; `familyLabel`, `projectFamilyKey` (Task 2).
- Produces:
  - `hasSavedDefaults(project) -> boolean` (true when any of `primary_provider_id, default_series_family_id, default_series_id, default_finish_id, default_thickness_mm, default_sash_thickness_mm, default_infill_id, hardware_package_id, labour_per_sqm` is set; `profit_pct` / `price_as_of` alone do not count — every new project gets them)
  - `defaultsSummary({ project, index, infillTypes }) -> { label, value }[]` in the order โรงรีด, ซีรีส์หลัก, สี, อุดช่อง, กำไร, วันที่ราคา; blanks left out
  - `thaiDate('2026-10-09') -> '9 ต.ค. 2569'` ('' for anything else)
  - Panel behaviour: opens collapsed when `hasSavedDefaults(project)`, expanded otherwise; resets that choice on another project; collapses after a successful save; collapsing keeps unsaved edits (the draft lives in the panel). Not stored in the DB.

- [ ] **Step 1: Write the failing tests**

Append to `src/pages/estimation/projectDefaultsFamily.test.js` (add `hasSavedDefaults, defaultsSummary, thaiDate` to the `./projectDefaults.js` import):

```js
describe('collapsed card helpers', () => {
  it('a new project (only profit and price date) is not "set"; any default is', () => {
    expect(hasSavedDefaults({ profit_pct: 30, price_as_of: '2026-10-31' })).toBe(false)
    expect(hasSavedDefaults({ default_series_family_id: 'fI' })).toBe(true)
    expect(hasSavedDefaults({ labour_per_sqm: 0 })).toBe(true)
    expect(hasSavedDefaults(null)).toBe(false)
  })
  it('summary chips in the mockup order, blanks left out', () => {
    const project = { primary_provider_id: 'A', default_series_family_id: 'fI', default_finish_id: 'fin', default_infill_id: 'g', profit_pct: 50, price_as_of: '2026-10-09' }
    expect(defaultsSummary({ project, index: famIndex, infillTypes: [{ id: 'g', name: 'กระจกใส 6มม.' }] })).toEqual([
      { label: 'โรงรีด', value: 'บจก. อลูเม็ท (Alumet)' },
      { label: 'ซีรีส์หลัก', value: 'ICONIQ EURO' },
      { label: 'สี', value: '15664 Heritage Oak' },
      { label: 'อุดช่อง', value: 'กระจกใส 6มม.' },
      { label: 'กำไร', value: '50%' },
      { label: 'วันที่ราคา', value: '9 ต.ค. 2569' },
    ])
    expect(defaultsSummary({ project: { profit_pct: null, price_as_of: null }, index: famIndex, infillTypes: [] })).toEqual([])
  })
  it('thaiDate', () => {
    expect(thaiDate('2026-01-31')).toBe('31 ม.ค. 2569')
    expect(thaiDate('')).toBe('')
    expect(thaiDate(null)).toBe('')
  })
})
```

Create `src/pages/estimation/ProjectDefaultsPanel.collapse.test.jsx`:

```jsx
// @vitest-environment jsdom
// The defaults card collapses after save, opens collapsed when set, expanded when new, and never loses unsaved edits.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { buildCatalogIndex } from '../../lib/aluCatalogPricing.js'

const update = vi.fn(() => ({ eq: () => Promise.resolve({ error: null }) }))
vi.mock('../../lib/supabase.js', () => ({ supabase: { from: () => ({ update }) } }))
const { default: ProjectDefaultsPanel } = await import('./ProjectDefaultsPanel.jsx')

const index = buildCatalogIndex({
  providers: [{ id: 'A', name: 'บจก. อลูเม็ท (Alumet)' }],
  seriesFamilies: [{ id: 'fI', provider_id: 'A', name: 'ICONIQ EURO' }],
  series: [{ id: 's1', provider_id: 'A', name: 'ICONIQ EURO บานเลื่อน', series_family_id: 'fI' }],
})
const saved = { id: 'p1', primary_provider_id: 'A', default_series_family_id: 'fI', profit_pct: 50, price_as_of: '2026-10-09' }
const mount = (project, onSaved = vi.fn(async () => {})) => render(
  <ProjectDefaultsPanel project={project} index={index} seriesTypes={[]} infillTypes={[]} packages={[]} items={[]} templatesById={{}} canEdit onSaved={onSaved} />,
)
afterEach(cleanup)

describe('ProjectDefaultsPanel collapse', () => {
  it('a project with saved defaults opens collapsed with its chips', () => {
    mount(saved)
    expect(screen.getByText('✓ บันทึกแล้ว')).toBeTruthy()
    expect(screen.getByText('แก้ไข ▾')).toBeTruthy()
    expect(screen.getByText('ICONIQ EURO')).toBeTruthy()
    expect(screen.getByText('9 ต.ค. 2569')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /บันทึกค่าเริ่มต้น/ })).toBeNull()
  })
  it('a new project opens expanded', () => {
    mount({ id: 'p2', profit_pct: 30, price_as_of: '2026-10-31' })
    expect(screen.getByText('ย่อ ▴')).toBeTruthy()
    expect(screen.getByRole('button', { name: /บันทึกค่าเริ่มต้น/ })).toBeTruthy()
  })
  it('collapsing keeps an unsaved edit, and says it is not saved', () => {
    const { container } = mount(saved)
    fireEvent.click(screen.getByText('แก้ไข ▾'))
    fireEvent.change(container.querySelector('input[max="1000"]'), { target: { value: '60' } })
    fireEvent.click(screen.getByText('ย่อ ▴'))
    expect(screen.getByText('มีค่าที่ยังไม่บันทึก')).toBeTruthy()
    fireEvent.click(screen.getByText('แก้ไข ▾'))
    expect(container.querySelector('input[max="1000"]').value).toBe('60')
  })
  it('saving collapses the card', async () => {
    const onSaved = vi.fn(async () => {})
    const { container } = mount(saved, onSaved)
    fireEvent.click(screen.getByText('แก้ไข ▾'))
    fireEvent.change(container.querySelector('input[max="1000"]'), { target: { value: '60' } })
    fireEvent.click(screen.getByRole('button', { name: /บันทึกค่าเริ่มต้น/ }))
    await waitFor(() => expect(screen.getByText('แก้ไข ▾')).toBeTruthy())
    expect(update).toHaveBeenCalledWith({ profit_pct: 60 })
    expect(onSaved).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/pages/estimation/projectDefaultsFamily.test.js src/pages/estimation/ProjectDefaultsPanel.collapse.test.jsx`
Expected: FAIL (`hasSavedDefaults is not a function`; no "แก้ไข ▾").

- [ ] **Step 3: Helpers in `projectDefaults.js`**

Add `familyLabel, projectFamilyKey` to the `seriesFamily.js` import, then:

```js
// Columns whose value means the owner has set the defaults. profit_pct and price_as_of are filled when a project is
// created (newProjectRow), so they alone do not count.
const SET_COLUMNS = ['primary_provider_id', 'default_series_family_id', 'default_series_id', 'default_finish_id', 'default_thickness_mm',
  'default_sash_thickness_mm', 'default_infill_id', 'hardware_package_id', 'labour_per_sqm']
export const hasSavedDefaults = project => !!project && SET_COLUMNS.some(c => project[c] !== null && project[c] !== undefined && project[c] !== '')

const TH_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.']
// '2026-10-09' -> '9 ต.ค. 2569' (Buddhist year); '' for anything that is not a YYYY-MM-DD date.
export function thaiDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''))
  return m ? `${Number(m[3])} ${TH_MONTHS[Number(m[2]) - 1]} ${Number(m[1]) + 543}` : ''
}

// The collapsed card's chips (mockup order); a blank default is left out (= chosen per item).
export function defaultsSummary({ project, index, infillTypes }) {
  const pj = project || {}
  const prov = pj.primary_provider_id ? index.providers[pj.primary_provider_id] : null
  const finish = pj.default_finish_id ? index.finishes[pj.default_finish_id] : null
  const infill = pj.default_infill_id ? (infillTypes || []).find(g => g.id === pj.default_infill_id) : null
  const profit = pj.profit_pct === null || pj.profit_pct === undefined || pj.profit_pct === '' ? NaN : Number(pj.profit_pct)
  return [
    ['โรงรีด', prov ? prov.name : ''],
    ['ซีรีส์หลัก', familyLabel(index, projectFamilyKey(pj))],
    ['สี', finish ? finish.name : ''],
    ['อุดช่อง', infill ? infill.name : ''],
    ['กำไร', Number.isFinite(profit) ? `${profit}%` : ''],
    ['วันที่ราคา', thaiDate(pj.price_as_of)],
  ].filter(([, v]) => v).map(([label, value]) => ({ label, value }))
}
```

- [ ] **Step 4: The panel**

In `ProjectDefaultsPanel.jsx` add `hasSavedDefaults, defaultsSummary` to the `./projectDefaults.js` import. After the draft state add:

```js
  // Collapsed after a save, or when an already-set project opens; a new project opens expanded (spec section 6).
  const [open, setOpen] = useState(() => !hasSavedDefaults(project))
  useEffect(() => { setOpen(!hasSavedDefaults(project)) }, [project.id]) // eslint-disable-line react-hooks/exhaustive-deps
```

In `write`, after `setSaveTick(t => t + 1)` add `setOpen(false)`.

Right before the final `return (`, add the collapsed view (all hooks are above it):

```jsx
  if (!open) {
    const chips = defaultsSummary({ project, index, infillTypes })
    return (
      <div className="card" style={{ padding: '12px 16px', display: 'grid', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <div style={{ fontWeight: 700 }}>ค่าเริ่มต้นของโปรเจกต์</div>
          {dirty
            ? <span className="badge" style={{ color: 'var(--red)' }}>มีค่าที่ยังไม่บันทึก</span>
            : <span className="badge badge-paid">✓ บันทึกแล้ว</span>}
          <button type="button" className="btn btn-sm btn-ghost" style={{ marginLeft: 'auto' }} onClick={() => setOpen(true)}>{canEdit ? 'แก้ไข ▾' : 'ดู ▾'}</button>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {chips.map(c => (
            <span key={c.label} className="badge" style={{ padding: '3px 8px', display: 'inline-flex', gap: 4 }}>
              <span style={{ color: 'var(--text3)' }}>{c.label}</span><span>{c.value}</span>
            </span>
          ))}
          {!chips.length && <span style={{ fontSize: 12, color: 'var(--text3)' }}>ยังไม่ได้ตั้งค่า — เลือกต่อรายการ</span>}
        </div>
      </div>
    )
  }
```

In the expanded view, replace the title `<div style={{ fontWeight: 700 }}>ค่าเริ่มต้นของโปรเจกต์ …</div>` with:

```jsx
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ fontWeight: 700 }}>ค่าเริ่มต้นของโปรเจกต์ <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--text3)' }}>(ว่าง = เลือกต่อรายการ)</span></div>
        <button type="button" className="btn btn-sm btn-ghost" style={{ marginLeft: 'auto' }} onClick={() => setOpen(false)}>ย่อ ▴</button>
      </div>
```

(If the confirm dialog is open the card is expanded, so the dialog is still rendered by the expanded view.)

After Tasks 5 and 6 the whole file reads as follows (use it to check your edits; it was assembled from exactly the steps above and passes every test in this plan):

```jsx
// src/pages/estimation/ProjectDefaultsPanel.jsx
// Project defaults (mockup screen 1): main extruder, series, colour, thicknesses, infill, hardware package,
// labour, profit, price date and the quotation description format. Blank = NULL = "choose per item".
import { useState, useEffect, useMemo } from 'react'
import { supabase } from '../../lib/supabase.js'
import { ConfirmDialog } from '../../components/Modal.jsx'
import InlineError from './InlineError.jsx'
import { itemsAffectedByDefaultFamily } from '../../lib/estimationInherit.js'
import { packagesForSeriesIds } from '../../lib/projectHardware.js'
import { familyChoices, familyLabel, familySeries, familyThicknesses, familyAllowsMixed, keyProviderId } from '../../lib/seriesFamily.js'
import { DESCRIPTION_TOKENS, buildItemDescription } from '../../lib/descriptionFormat.js'
import {
  draftFromProject, reconcileDraft, finishChoices, sashDisplayValue, validateDraft, buildPatch, draftSeriesKey, applySeriesKey,
  hasSavedDefaults, defaultsSummary, patchChangesSeries,
} from './projectDefaults.js'

const Field = ({ label, hint, children }) => (
  <div>
    <label className="label">{label}</label>
    {children}
    {hint && <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 3 }}>{hint}</div>}
  </div>
)

export default function ProjectDefaultsPanel({ project, index, seriesTypes, infillTypes, packages, items, templatesById, canEdit, onSaved }) {
  const [draft, setDraft] = useState(() => reconcileDraft(draftFromProject(project), index, seriesTypes))
  const [saving, setSaving] = useState(false)
  const [confirm, setConfirm] = useState(null)   // { patch, affected }
  const [saveError, setSaveError] = useState(null)
  // Collapsed after a save, or when an already-set project opens; a new project opens expanded (spec section 6).
  const [open, setOpen] = useState(() => !hasSavedDefaults(project))
  useEffect(() => { setOpen(!hasSavedDefaults(project)) }, [project.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Reset only for another project or after our own successful save, never on a plain refetch (unsaved edits stay).
  const [saveTick, setSaveTick] = useState(0)
  useEffect(() => { setDraft(reconcileDraft(draftFromProject(project), index, seriesTypes)) }, [project.id, saveTick]) // eslint-disable-line react-hooks/exhaustive-deps

  const change = (k, v) => setDraft(d => reconcileDraft({ ...d, [k]: v }, index, seriesTypes))
  const patch = useMemo(() => buildPatch(project, draft), [project, draft])
  const dirty = Object.keys(patch).length > 0
  const error = validateDraft(draft)

  const seriesKey = draftSeriesKey(draft)
  const familyOpts = familyChoices(index, draft.primary_provider_id)
  // the saved ซีรีส์หลัก stays visible even when it is no longer offered (switched off / series inactive)
  const keyOpts = seriesKey && !familyOpts.some(o => o.value === seriesKey)
    ? [...familyOpts, { value: seriesKey, label: `${familyLabel(index, seriesKey) || 'ที่ถูกลบแล้ว'} (ปิดใช้งาน)` }]
    : familyOpts
  const keyProvider = keyProviderId(index, seriesKey)
  const finishOpts = finishChoices(index, null, keyProvider || draft.primary_provider_id)
  const thicknesses = familyThicknesses(index, seriesKey)
  const singleThickness = thicknesses.length === 1
  const showSash = familyAllowsMixed(index, seriesTypes, seriesKey)
  const pkgOpts = [...packagesForSeriesIds(packages, familySeries(index, null, seriesKey).map(s => s.id))]
  const chosenPkg = draft.hardware_package_id ? (packages || []).find(p => p.id === draft.hardware_package_id) : null
  if (chosenPkg && !pkgOpts.some(p => p.id === chosenPkg.id)) pkgOpts.push(chosenPkg)
  const changeSeries = key => setDraft(d => reconcileDraft(applySeriesKey(d, key, index), index, seriesTypes))

  const sampleDesc = buildItemDescription({
    item_name: 'ประตูบานเลื่อน', type_name: 'บานเลื่อน', width_m: 1.8, height_m: 2.1,
    series_label: familyLabel(index, seriesKey),
    finish_name: draft.default_finish_id && index.finishes[draft.default_finish_id] ? index.finishes[draft.default_finish_id].name : 'ขาว',
    thickness_mm: draft.default_thickness_mm, infill_name: 'กระจกเขียว 6 มม.', hardware_set_name: 'ชุดมาตรฐาน',
  }, draft.description_format)

  const write = async (p) => {
    setSaving(true)
    setSaveError(null)
    try {
      const { error: e } = await supabase.from('estimation_projects').update(p).eq('id', project.id)
      if (e) throw e
      await onSaved()
      setSaveTick(t => t + 1)
      setOpen(false)
    } catch (e) { setSaveError('บันทึกไม่สำเร็จ: ' + e.message) }
    finally { setSaving(false); setConfirm(null) }
  }

  const handleSave = () => {
    if (error || !dirty) return
    if (patchChangesSeries(patch)) {
      const affected = itemsAffectedByDefaultFamily(items, templatesById, index, seriesTypes, seriesKey)
      if (affected.length) { setConfirm({ patch, affected }); return }
    }
    write(patch)
  }

  const tokenLabel = k => (DESCRIPTION_TOKENS.find(t => t.key === k) || {}).label || k
  const fmtList = draft.description_format
  const move = (i, d) => { const a = [...fmtList]; const j = i + d; if (j < 0 || j >= a.length) return; [a[i], a[j]] = [a[j], a[i]]; setDraft(x => ({ ...x, description_format: a })) }
  const dis = !canEdit

  if (!open) {
    const chips = defaultsSummary({ project, index, infillTypes })
    return (
      <div className="card" style={{ padding: '12px 16px', display: 'grid', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <div style={{ fontWeight: 700 }}>ค่าเริ่มต้นของโปรเจกต์</div>
          {dirty
            ? <span className="badge" style={{ color: 'var(--red)' }}>มีค่าที่ยังไม่บันทึก</span>
            : <span className="badge badge-paid">✓ บันทึกแล้ว</span>}
          <button type="button" className="btn btn-sm btn-ghost" style={{ marginLeft: 'auto' }} onClick={() => setOpen(true)}>{canEdit ? 'แก้ไข ▾' : 'ดู ▾'}</button>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {chips.map(c => (
            <span key={c.label} className="badge" style={{ padding: '3px 8px', display: 'inline-flex', gap: 4 }}>
              <span style={{ color: 'var(--text3)' }}>{c.label}</span><span>{c.value}</span>
            </span>
          ))}
          {!chips.length && <span style={{ fontSize: 12, color: 'var(--text3)' }}>ยังไม่ได้ตั้งค่า — เลือกต่อรายการ</span>}
        </div>
      </div>
    )
  }

  return (
    <div className="card" style={{ padding: 16, display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ fontWeight: 700 }}>ค่าเริ่มต้นของโปรเจกต์ <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--text3)' }}>(ว่าง = เลือกต่อรายการ)</span></div>
        <button type="button" className="btn btn-sm btn-ghost" style={{ marginLeft: 'auto' }} onClick={() => setOpen(false)}>ย่อ ▴</button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
        <Field label="โรงรีดหลัก">
          <select className="input" disabled={dis} value={draft.primary_provider_id} onChange={e => change('primary_provider_id', e.target.value)}>
            <option value="">ไม่กำหนด (เลือกต่อรายการ)</option>
            {Object.values(index.providers).filter(p => p.active !== false).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        <Field label="ซีรีส์หลัก" hint="แต่ละรายการได้ชุดที่ตรงประเภทบานเอง เปลี่ยนในรายการได้">
          <select className="input" disabled={dis} value={seriesKey} onChange={e => changeSeries(e.target.value)}>
            <option value="">ไม่กำหนด (เลือกต่อรายการ)</option>
            {keyOpts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </Field>
        <Field label="สี" hint={!seriesKey && !draft.primary_provider_id ? 'เลือกซีรีส์หลักหรือโรงรีดก่อน' : null}>
          <select className="input" disabled={dis || !finishOpts.length} value={draft.default_finish_id} onChange={e => change('default_finish_id', e.target.value)}>
            <option value="">ไม่กำหนด (เลือกต่อรายการ)</option>
            {finishOpts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </Field>
        <Field label="ความหนาวงกบ (มม.)" hint={singleThickness ? 'ซีรีส์หลักนี้มีความหนาเดียว เลือกให้อัตโนมัติ' : (!seriesKey ? 'เลือกซีรีส์หลักก่อน' : 'ในรายการยังเลือกความหนาอื่นของชุดได้')}>
          <select className="input" disabled={dis || singleThickness || !thicknesses.length} value={draft.default_thickness_mm} onChange={e => change('default_thickness_mm', e.target.value)}>
            <option value="">ไม่กำหนด (เลือกต่อรายการ)</option>
            {thicknesses.map(t => <option key={t} value={String(t)}>{t}</option>)}
          </select>
        </Field>
        {showSash && (
          <Field label="ความหนากรอบบาน (มม.)" hint="ซีรีส์หลักนี้มีประเภทที่ใช้ความหนาวงกบกับกรอบบานไม่เท่ากันได้">
            <select className="input" disabled={dis} value={sashDisplayValue(draft)} onChange={e => change('default_sash_thickness_mm', e.target.value)}>
              {!sashDisplayValue(draft) && <option value="">— เลือก —</option>}
              {thicknesses.map(t => <option key={t} value={String(t)}>{t}</option>)}
            </select>
          </Field>
        )}
        <Field label="วัสดุอุดช่อง">
          <select className="input" disabled={dis} value={draft.default_infill_id} onChange={e => change('default_infill_id', e.target.value)}>
            <option value="">ไม่กำหนด (เลือกต่อรายการ)</option>
            {(infillTypes || []).filter(g => g.active !== false).map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </Field>
        <Field label="ชุดอุปกรณ์ของโปรเจกต์">
          <select className="input" disabled={dis} value={draft.hardware_package_id} onChange={e => change('hardware_package_id', e.target.value)}>
            <option value="">— ไม่ใช้ —</option>
            {pkgOpts.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        <Field label="ค่าแรง (฿/ตร.ม.)" hint="ว่าง = ใช้ค่าของประเภท; 0 = ไม่คิดค่าแรง">
          <input className="input" disabled={dis} type="number" min="0" step="any" value={draft.labour_per_sqm} onChange={e => change('labour_per_sqm', e.target.value)} />
        </Field>
        <Field label="กำไร (%)">
          <input className="input" disabled={dis} type="number" min="0" max="1000" step="any" value={draft.profit_pct} onChange={e => change('profit_pct', e.target.value)} />
        </Field>
        <Field label="วันที่ราคา" hint="ล็อกตั้งแต่สร้างโปรเจกต์ ใช้คิดราคาทุกรายการ">
          <div className="input" style={{ background: 'var(--bg2, #f7f7f7)' }}>{project.price_as_of || '—'}</div>
        </Field>
      </div>

      <div>
        <label className="label">รูปแบบคำอธิบายรายการ (ลำดับตามที่เลือก)</label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          {fmtList.map((k, i) => (
            <span key={k} className="badge" style={{ display: 'inline-flex', gap: 4, alignItems: 'center', padding: '3px 8px' }}>
              {tokenLabel(k)}
              {canEdit && <>
                <button type="button" className="btn btn-sm btn-ghost" style={{ padding: '0 4px' }} disabled={i === 0} onClick={() => move(i, -1)}>◀</button>
                <button type="button" className="btn btn-sm btn-ghost" style={{ padding: '0 4px' }} disabled={i === fmtList.length - 1} onClick={() => move(i, 1)}>▶</button>
                <button type="button" className="btn btn-sm btn-ghost" style={{ padding: '0 4px', color: 'var(--red)' }} onClick={() => setDraft(x => ({ ...x, description_format: x.description_format.filter(t => t !== k) }))}>✕</button>
              </>}
            </span>
          ))}
          {canEdit && DESCRIPTION_TOKENS.filter(t => !fmtList.includes(t.key)).map(t => (
            <button key={t.key} type="button" className="btn btn-sm btn-ghost" onClick={() => setDraft(x => ({ ...x, description_format: [...x.description_format, t.key] }))}>+ {t.label}</button>
          ))}
        </div>
        <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 6 }}>ตัวอย่าง: {sampleDesc || '—'}</div>
      </div>

      {saveError && <InlineError onClose={() => setSaveError(null)}>{saveError}</InlineError>}
      {error && <div className="alert alert-error" style={{ fontSize: 13 }}>{error}</div>}
      {canEdit && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="btn btn-ghost" disabled={!dirty || saving} onClick={() => setDraft(reconcileDraft(draftFromProject(project), index, seriesTypes))}>คืนค่า</button>
          <button type="button" className="btn btn-primary" disabled={!dirty || !!error || saving} onClick={handleSave}>{saving ? '⏳ กำลังบันทึก...' : '💾 บันทึกค่าเริ่มต้น'}</button>
        </div>
      )}

      {confirm && (
        <ConfirmDialog
          title="เปลี่ยนซีรีส์หลัก"
          message={<div>
            ซีรีส์หลักใหม่ไม่มีชุดสำหรับแบบต่อไปนี้ ({confirm.affected.length} รายการ) ยังบันทึกได้ แต่รายการเหล่านี้จะคิดราคาไม่ได้จนกว่าจะเลือกชุดในรายการ:
            <ul style={{ margin: '6px 0 0 18px' }}>{confirm.affected.map(i => <li key={i.id}>{i.opening_no}{i.item_name ? ` · ${i.item_name}` : ''}</li>)}</ul>
          </div>}
          onConfirm={() => write(confirm.patch)} onCancel={() => setConfirm(null)} />
      )}
    </div>
  )
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/pages/estimation/projectDefaultsFamily.test.js src/pages/estimation/ProjectDefaultsPanel.collapse.test.jsx src/pages/estimation/ProjectDefaultsPanel.smoke.test.jsx`
Expected: PASS.
Run: `npx vitest run` → Expected: all green.

- [ ] **Step 6: Commit**

```bash
cd /Users/plfx/code/FacadeXPM/facadex-app/.claude/worktrees/series-family
git add src/pages/estimation/projectDefaults.js src/pages/estimation/ProjectDefaultsPanel.jsx src/pages/estimation/projectDefaultsFamily.test.js src/pages/estimation/ProjectDefaultsPanel.collapse.test.jsx
git commit -F - <<'MSG'
feat(estimation): project defaults card collapses to summary chips after save

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SKarDAHEncS9RZ6zCSPXc1
MSG
```

---
### Task 7: Compare extruders by ซีรีส์หลัก

**Files:**
- Modify: `src/lib/providerCompare.js` (a candidate may carry `seriesKey`; per-item series by type)
- Modify: `src/pages/estimation/projectBomHelpers.js` (`comparisonRows` reads `seriesKey || seriesId`)
- Modify: `src/pages/estimation/ProviderCompare.jsx` (family pickers, apply via `applySeriesKey`, `InlineError`)
- Modify: `src/lib/defaultSeriesReaders.test.js` (remove `ProviderCompare.jsx` from `ALLOWED`)
- Modify: `src/pages/estimation/noBrowserDialogs.test.js` (add `'ProviderCompare.jsx'` to `FILES`)
- Test: `src/lib/providerCompareFamily.test.js` (new), `src/pages/estimation/comparisonRowsFamily.test.js` (new)

**Interfaces:**
- Consumes: `familySeriesForType`, `familyChoices`, `familyLabel`, `projectFamilyKey` (Task 2); `itemsAffectedByDefaultFamily` (Task 3); `applySeriesKey`, `draftFromProject`, `reconcileDraft`, `buildPatch`, `finishChoices` (Task 5).
- Produces: `compareProviders(ctx)` — `ctx.seriesTypes` (expanded links) is read when a candidate is `{ providerId, seriesKey, finishId }`; the old `{ providerId, seriesId, finishId }` works as before. An item whose type the candidate family has no series for adds its quantity to `unresolvedLines` and goes to `failedItems` with `text: 'ซีรีส์หลักนี้ไม่มีชุดสำหรับประเภทนี้'`. `comparisonRows` rows gain `seriesKey` only when the result has one.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/providerCompareFamily.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { buildCatalogIndex } from './aluCatalogPricing.js'
import { mergeSettings } from './estimationSettings.js'
import { compareProviders } from './providerCompare.js'

const index = buildCatalogIndex({
  providers: [{ id: 'A', price_basis: 'per_kg' }],
  seriesFamilies: [{ id: 'famA', provider_id: 'A', name: 'EURO' }],
  series: [{ id: 'sFix', provider_id: 'A', name: 'EURO Fixed', series_family_id: 'famA' }, { id: 'sSl', provider_id: 'A', name: 'EURO Slide', series_family_id: 'famA' }],
  types: [{ id: 'fixed' }, { id: 'slide' }, { id: 'casement' }],
  seriesTypes: [{ id: 'l1', series_id: 'sFix', type_id: 'fixed' }, { id: 'l2', series_id: 'sSl', type_id: 'slide' }],
  finishes: [{ id: 'fA', provider_id: 'A' }],
  profiles: [{ id: 'pA', provider_id: 'A', family: 'box', thickness_mm: 1.5, linear_weight_kg_per_m: 1 }],
  seriesProfiles: [{ series_id: 'sFix', profile_id: 'pA' }, { series_id: 'sSl', profile_id: 'pA' }],
  kgPrices: [{ id: 'k1', provider_id: 'A', finish_id: 'fA', price_per_kg: 100, effective_from: '2026-01-01' }],
})
const seriesTypes = Object.values(index.seriesTypesBySeries).flat()
const tpl = (id, type_id) => ({ id, type_id, waste_pct: 0, grid_row_weights: [1], labor_price_per_sqm: 0, silicone_price_per_m: 0, felt_price_per_m: 0, infill_width_deduction_mm: 0, infill_height_deduction_mm: 0 })
const templatesById = { tF: tpl('tF', 'fixed'), tS: tpl('tS', 'slide'), tC: tpl('tC', 'casement') }
const comp = [{ role_name: 'top', profile_family: 'box', length_rule_type: 'width', length_deduction_mm: 0, quantity_basis: 'fixed', quantity_value: 2 }]
const componentsByTemplate = { tF: comp, tS: comp, tC: comp }
const item = (id, template_id) => ({ id, opening_no: id, template_id, width_m: 2, height_m: 1, panel_count: 1, quantity: 1, thickness_mm: 1.5 })
const base = { project: { price_as_of: '2026-06-01' }, templatesById, componentsByTemplate, jointsByTemplate: {}, typesById: index.types, infillTypesById: {}, index, settings: mergeSettings(null), asOf: '2026-06-01', seriesTypes }

describe('compareProviders with a family candidate', () => {
  it("each item is priced in the family's series for its type", () => {
    const [r] = compareProviders({ ...base, items: [item('F1', 'tF'), item('S1', 'tS')], candidates: [{ providerId: 'A', seriesKey: 'famA', finishId: 'fA' }] })
    expect(r).toMatchObject({ aluminium: 2 * 2 * 100 * 2, complete: true, itemsPriced: 2 })
  })
  it('a type the family has no series for is unresolved and named, never priced in another series', () => {
    const [r] = compareProviders({ ...base, items: [item('F1', 'tF'), item('C1', 'tC')], candidates: [{ providerId: 'A', seriesKey: 'famA', finishId: 'fA' }] })
    expect(r.complete).toBe(false)
    expect(r.unresolvedLines).toBe(1)
    expect(r.failedItems).toEqual([{ id: 'C1', opening_no: 'C1', text: 'ซีรีส์หลักนี้ไม่มีชุดสำหรับประเภทนี้' }])
  })
  it('a candidate with neither seriesKey nor seriesId is pending', () => {
    const [r] = compareProviders({ ...base, items: [item('F1', 'tF')], candidates: [{ providerId: 'A', seriesKey: '', finishId: 'fA' }] })
    expect(r).toMatchObject({ aluminium: 0, complete: false })
  })
})
```

Create `src/pages/estimation/comparisonRowsFamily.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { comparisonRows } from './projectBomHelpers.js'

describe('comparisonRows with family candidates', () => {
  it('a family key counts as a chosen series; the key is passed through', () => {
    const rows = comparisonRows([
      { providerId: 'A', seriesKey: 'famA', finishId: 'f', aluminium: 1000, complete: true, unresolvedLines: 0 },
      { providerId: 'B', seriesKey: 'famB', finishId: 'f', aluminium: 900, complete: true, unresolvedLines: 0 },
      { providerId: 'C', seriesKey: '', finishId: 'f', aluminium: 0, complete: false, unresolvedLines: 1 },
    ], 'A')
    expect(rows[1]).toMatchObject({ seriesKey: 'famB', canApply: true, pending: false })
    expect(rows[2].pending).toBe(true)
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/lib/providerCompareFamily.test.js src/pages/estimation/comparisonRowsFamily.test.js`
Expected: FAIL (a family candidate is treated as pending: `aluminium: 0`).

- [ ] **Step 3: `providerCompare.js`**

Add `import { familySeriesForType } from './seriesFamily.js'`. Update the header comment's candidate line to: `// Candidate = { providerId, seriesId | seriesKey, finishId }: seriesKey (a ซีรีส์หลัก key) gives each item its family's series for its type.` Replace the early-return condition with:

```js
    if (!(cand.seriesKey || cand.seriesId) || !cand.finishId) {
```

Inside the item loop, after the `if (!template) { … continue }` line and before `const forced = …`, add:

```js
      const qty = Number(item.quantity) > 0 ? Number(item.quantity) : 1
      const seriesId = cand.seriesKey
        ? familySeriesForType(index, ctx.seriesTypes, cand.providerId, cand.seriesKey, template.type_id || null)
        : cand.seriesId
      if (!seriesId) {
        unresolvedLines += qty
        failedItems.push({ id: item.id, opening_no: item.opening_no, text: 'ซีรีส์หลักนี้ไม่มีชุดสำหรับประเภทนี้' })
        continue
      }
```

and change `series_id: cand.seriesId` in `forced` to `series_id: seriesId`. Inside the `try`, the existing `const qty = …` line now duplicates the outer one: delete that inner line (use the outer `qty`). Update the ctx comment to mention `seriesTypes?`.

- [ ] **Step 4: `comparisonRows`**

In `src/pages/estimation/projectBomHelpers.js` `comparisonRows`, inside the `map`, add `const chosen = r.seriesKey || r.seriesId` and return:

```js
    return {
      providerId: r.providerId, seriesId: r.seriesId, finishId: r.finishId, isBase,
      ...(r.seriesKey !== undefined ? { seriesKey: r.seriesKey } : {}),
      complete: !!r.complete, aluminium: r.complete ? r.aluminium : null,
      diff: d, unresolvedLines: r.complete ? 0 : r.unresolvedLines,
      pending: !chosen || !r.finishId,
      canApply: !isBase && !!r.complete && !!chosen && !!r.finishId,
    }
```

(The existing `comparisonRows` test has no `seriesKey`, so its rows are unchanged.)

- [ ] **Step 5: `ProviderCompare.jsx`**

Imports: replace `itemsAffectedByDefaultSeries` with `itemsAffectedByDefaultFamily`; replace `seriesChoices, finishChoices, draftFromProject, reconcileDraft, buildPatch` with `finishChoices, draftFromProject, reconcileDraft, buildPatch, applySeriesKey`; add `import { familyChoices, familyLabel, projectFamilyKey } from '../../lib/seriesFamily.js'` and `import InlineError from './InlineError.jsx'`.

Changes:

```js
  const [saveError, setSaveError] = useState(null)
  const baseKey = projectFamilyKey(project)
  const pickOf = p => (p.id === primaryId ? { seriesKey: baseKey, finishId: project.default_finish_id || '' } : (picks[p.id] || { seriesKey: '', finishId: '' }))
```

In `rows`' `compareProviders({ … })` add `seriesTypes,` to the ctx. `setPick` default object becomes `{ seriesKey: '', finishId: '' }`.

```js
  const startApply = row => {
    const draft = reconcileDraft(applySeriesKey({ ...draftFromProject(project), primary_provider_id: row.providerId, default_finish_id: row.finishId }, row.seriesKey, index), index, seriesTypes)
    const patch = buildPatch(project, draft)
    const seen = new Set()
    const affected = [...itemsAffectedByDefaultFamily(items, base.templatesById, index, seriesTypes, row.seriesKey), ...itemsWithForeignColour(items, index, row.providerId)]
      .filter(i => !seen.has(i.id) && seen.add(i.id))
    setConfirm({ row, patch, affected, name: index.providers[row.providerId].name, clearsThickness: 'default_thickness_mm' in patch })
  }
```

In `apply` replace `alert('บันทึกไม่สำเร็จ: ' + e.message)` with `setSaveError('บันทึกไม่สำเร็จ: ' + e.message)` (and `setSaveError(null)` at its start); render `{saveError && <InlineError onClose={() => setSaveError(null)}>{saveError}</InlineError>}` above the table.

Texts: the hint `{!baseKey || !project.default_finish_id ? ' · ตั้งซีรีส์หลักและสีเริ่มต้นของโปรเจกต์ก่อน จึงจะเทียบกับโรงรีดหลักได้' : ''}`; the intro sentence `…โดยบังคับทุกรายการเป็นซีรีส์หลักและสีที่เลือก (แต่ละรายการได้ชุดที่ตรงประเภทของมัน ขนาด เทมเพลต ความหนาตามเดิม)…`; table header `<th>ซีรีส์หลัก</th>`; pending text `'ยังไม่ได้ตั้งซีรีส์หลัก/สีของโปรเจกต์'` / `'เลือกซีรีส์หลักและสี'`; confirm `จะตั้งโรงรีดหลัก ซีรีส์หลัก และสีเริ่มต้นของโปรเจกต์ตามแถวนี้`, and `ไม่มีชุดสำหรับแบบในซีรีส์หลักใหม่` in place of `ไม่มีแบบในซีรีส์ใหม่`.

The series cell:

```jsx
                  <td>{fixed ? (familyLabel(index, pick.seriesKey) || '—') : (
                    <select className="input input-sm" value={pick.seriesKey} onChange={e => setPick(p.id, { seriesKey: e.target.value, finishId: '' })}>
                      <option value="">— เลือก —</option>
                      {familyChoices(index, p.id).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>)}</td>
```

and in the colour cell use `disabled={!pick.seriesKey}` and `finishChoices(index, null, p.id)`.

After this step the whole file reads as follows (assembled from exactly the edits above; passes every test in this plan):

```jsx
// src/pages/estimation/ProviderCompare.jsx
// Extruder comparison (mockup screen 6, lower panel). Aluminium cost only, read-only: for each extruder the owner
// picks a series and colour and the whole project is recomputed with them. Nothing changes until "ใช้โรงรีดนี้".
import { useState, useMemo } from 'react'
import { supabase, fmt } from '../../lib/supabase.js'
import { ConfirmDialog } from '../../components/Modal.jsx'
import { compareProviders } from '../../lib/providerCompare.js'
import { itemsAffectedByDefaultFamily } from '../../lib/estimationInherit.js'
import { finishChoices, draftFromProject, reconcileDraft, buildPatch, applySeriesKey } from './projectDefaults.js'
import { familyChoices, familyLabel, projectFamilyKey } from '../../lib/seriesFamily.js'
import InlineError from './InlineError.jsx'
import { comparisonRows, itemsWithForeignColour } from './projectBomHelpers.js'

export default function ProviderCompare({ project, items, base, index, seriesTypes, canEdit, onApplied }) {
  const providers = useMemo(() => Object.values(index.providers).filter(p => p.active !== false).sort((a, b) => String(a.name).localeCompare(String(b.name), 'th')), [index])
  const primaryId = project.primary_provider_id || null
  // picks[providerId] = { seriesId, finishId }; the main extruder row always uses the project's own defaults
  const baseMissing = !primaryId || !providers.some(p => p.id === primaryId)
  const [picks, setPicks] = useState({})
  const [confirm, setConfirm] = useState(null)
  const [busy, setBusy] = useState(false)
  const [saveError, setSaveError] = useState(null)
  const baseKey = projectFamilyKey(project)
  const pickOf = p => (p.id === primaryId ? { seriesKey: baseKey, finishId: project.default_finish_id || '' } : (picks[p.id] || { seriesKey: '', finishId: '' }))

  const rows = useMemo(() => {
    const candidates = providers.map(p => ({ providerId: p.id, ...pickOf(p) }))
    const results = compareProviders({
      project, items, templatesById: base.templatesById, componentsByTemplate: base.componentsByTemplate, jointsByTemplate: base.jointsByTemplate, partModelByTemplate: base.partModelByTemplate,
      addonPiecesByTemplate: base.addonPiecesByTemplate, itemAddonsByOpening: base.itemAddonsByOpening, addonPiecesError: base.addonPiecesError, itemAddonsError: base.itemAddonsError,
      typesById: base.typesById, infillTypesById: base.infillTypesById, index, settings: base.settings, candidates, asOf: project.price_as_of, seriesTypes,
    })
    return comparisonRows(results, primaryId)
  }, [providers, picks, project, items, base, index, primaryId]) // eslint-disable-line react-hooks/exhaustive-deps

  const setPick = (pid, patch) => setPicks(s => ({ ...s, [pid]: { ...(s[pid] || { seriesKey: '', finishId: '' }), ...patch } }))

  const startApply = row => {
    const draft = reconcileDraft(applySeriesKey({ ...draftFromProject(project), primary_provider_id: row.providerId, default_finish_id: row.finishId }, row.seriesKey, index), index, seriesTypes)
    const patch = buildPatch(project, draft)
    const seen = new Set()
    const affected = [...itemsAffectedByDefaultFamily(items, base.templatesById, index, seriesTypes, row.seriesKey), ...itemsWithForeignColour(items, index, row.providerId)]
      .filter(i => !seen.has(i.id) && seen.add(i.id))
    setConfirm({ row, patch, affected, name: index.providers[row.providerId].name, clearsThickness: 'default_thickness_mm' in patch })
  }
  const apply = async () => {
    setBusy(true)
    setSaveError(null)
    try {
      const { error } = await supabase.from('estimation_projects').update(confirm.patch).eq('id', project.id)
      if (error) throw error
      await onApplied()
      setConfirm(null)
    } catch (e) { setSaveError('บันทึกไม่สำเร็จ: ' + e.message) } finally { setBusy(false) }
  }

  return (
    <div className="card" style={{ padding: 16, display: 'grid', gap: 10 }}>
      <div style={{ fontWeight: 700 }}>เทียบราคาโรงรีด <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--text3)' }}>(เฉพาะอลูมิเนียม · ไม่เปลี่ยนค่าในโครงการ)</span></div>
      <div style={{ fontSize: 12, color: 'var(--text2)' }}>
        คิดต้นทุนอลูมิเนียมทั้งโครงการซ้ำ โดยบังคับทุกรายการเป็นซีรีส์และสีที่เลือก (ขนาด เทมเพลต ความหนาตามเดิม) ไม่รวมอุปกรณ์ วัสดุอุดช่อง และค่าแรง
        {!baseKey || !project.default_finish_id ? ' · ตั้งซีรีส์หลักและสีเริ่มต้นของโปรเจกต์ก่อน จึงจะเทียบกับโรงรีดหลักได้' : ''}
      </div>
      {baseMissing && <div className="alert alert-warning" style={{ fontSize: 13 }}>ไม่มีโรงรีดหลักเป็นฐานเทียบ (ยังไม่ได้เลือก หรือโรงรีดหลักถูกปิดใช้งาน) จึงไม่แสดงส่วนต่าง</div>}
      {saveError && <InlineError onClose={() => setSaveError(null)}>{saveError}</InlineError>}
      <div className="table-wrap">
        <table>
          <thead><tr><th>โรงรีด</th><th>ซีรีส์หลัก</th><th>สี</th><th>ต้นทุนอลูมิเนียม (฿)</th><th>เทียบโรงรีดหลัก<div style={{ fontWeight: 400, fontSize: 11, color: 'var(--text3)' }}>ฐานเทียบ (บังคับซีรีส์/สีตั้งต้นของโปรเจกต์ ไม่ใช่ยอดจริงในรายการ)</div></th><th>สถานะ</th><th /></tr></thead>
          <tbody>
            {providers.map((p, i) => {
              const row = rows[i]
              const pick = pickOf(p)
              const fixed = p.id === primaryId
              return (
                <tr key={p.id}>
                  <td>{p.name}{fixed ? ' (หลัก)' : ''}</td>
                  <td>{fixed ? (familyLabel(index, pick.seriesKey) || '—') : (
                    <select className="input input-sm" value={pick.seriesKey} onChange={e => setPick(p.id, { seriesKey: e.target.value, finishId: '' })}>
                      <option value="">— เลือก —</option>
                      {familyChoices(index, p.id).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>)}</td>
                  <td>{fixed ? (index.finishes[pick.finishId] ? index.finishes[pick.finishId].name : '—') : (
                    <select className="input input-sm" value={pick.finishId} disabled={!pick.seriesKey} onChange={e => setPick(p.id, { finishId: e.target.value })}>
                      <option value="">— เลือก —</option>
                      {finishChoices(index, null, p.id).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>)}</td>
                  <td className="font-mono">{row.complete ? fmt(row.aluminium) : '—'}</td>
                  <td className="font-mono">{row.diff ? `${row.diff.amount > 0 ? '+' : ''}${fmt(row.diff.amount)} (${row.diff.pct > 0 ? '+' : ''}${row.diff.pct.toFixed(1)}%)` : '—'}</td>
                  <td>{row.pending ? <span style={{ color: 'var(--text3)' }}>{fixed ? 'ยังไม่ได้ตั้งซีรีส์/สีของโปรเจกต์' : 'เลือกซีรีส์และสี'}</span>
                    : row.complete ? <span style={{ color: 'var(--green)' }}>คิดครบ</span>
                      : <span style={{ color: 'var(--red)' }}>คิดไม่ได้ {row.unresolvedLines} รายการ (ไม่มีหน้าตัด/ราคา){(row.failedItems || []).length > 0 && ` · คิดราคาไม่ได้: ${row.failedItems.map(f => f.opening_no || f.id).join(', ')}`}</span>}</td>
                  <td>{canEdit && row.canApply && <button type="button" className="btn btn-sm btn-ghost" onClick={() => startApply(row)}>ใช้โรงรีดนี้</button>}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {confirm && (
        <ConfirmDialog title={`ใช้โรงรีด ${confirm.name}`} confirmDisabled={busy} onCancel={() => setConfirm(null)} onConfirm={apply}
          message={<div>
            จะตั้งโรงรีดหลัก ซีรีส์ และสีเริ่มต้นของโปรเจกต์ตามแถวนี้{confirm.clearsThickness ? ' (ความหนาเริ่มต้นที่ซีรีส์ใหม่ไม่มีจะถูกล้าง ต้องเลือกใหม่)' : ''}
            <div>ความหนาวงกบ/ความหนากรอบบานที่บันทึกไว้เป็นค่าเริ่มต้น อาจถูกล้างถ้าไม่มีในซีรีส์ใหม่</div>
            {confirm.affected.length > 0 ? <> รายการเหล่านี้ที่ใช้ค่าเริ่มต้นของโปรเจกต์ ({confirm.affected.length}) ไม่มีแบบในซีรีส์ใหม่ หรือตั้งสีเองเป็นสีของโรงรีดอื่น จะคิดราคาไม่ได้จนกว่าจะแก้:
              <ul style={{ margin: '6px 0 0 18px' }}>{confirm.affected.map(i => <li key={i.id}>{i.opening_no}{i.item_name ? ` · ${i.item_name}` : ''}</li>)}</ul></> : ' ไม่มีรายการที่ได้รับผลกระทบด้านแบบ'}
            <div style={{ marginTop: 6 }}>รายการที่ตั้งซีรีส์หรือสีเองยังคงเดิม</div>
          </div>} />
      )}
    </div>
  )
}
```

Edit the guard lists: remove `'src/pages/estimation/ProviderCompare.jsx',` from `ALLOWED`; add `'ProviderCompare.jsx'` to `FILES`.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run src/lib/providerCompareFamily.test.js src/pages/estimation/comparisonRowsFamily.test.js src/lib/providerCompare.test.js src/pages/estimation/projectBomHelpers.test.js src/lib/defaultSeriesReaders.test.js src/pages/estimation/noBrowserDialogs.test.js src/pages/estimation/ProjectBomView.wiring.smoke.test.jsx`
Expected: PASS. `grep -n "default_series_id\|alert(" src/pages/estimation/ProviderCompare.jsx` → no output.
Run: `npx vitest run` → Expected: all green.

- [ ] **Step 7: Commit**

```bash
cd /Users/plfx/code/FacadeXPM/facadex-app/.claude/worktrees/series-family
git add src/lib/providerCompare.js src/pages/estimation/projectBomHelpers.js src/pages/estimation/ProviderCompare.jsx src/lib/defaultSeriesReaders.test.js src/pages/estimation/noBrowserDialogs.test.js src/lib/providerCompareFamily.test.js src/pages/estimation/comparisonRowsFamily.test.js
git commit -F - <<'MSG'
feat(estimation): extruder comparison picks a ซีรีส์หลัก per extruder

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SKarDAHEncS9RZ6zCSPXc1
MSG
```

---
### Task 8: Catalogue — manage ซีรีส์หลัก and put each series in one (HierarchyTab)

**Files:**
- Modify: `src/pages/aluCatalog/HierarchyTab.jsx`
- Test: `src/pages/aluCatalog/HierarchyTab.smoke.test.jsx` (new)

**Interfaces:**
- Consumes: `parseThicknessOptions`, `formatThicknessOptions` (Task 2); `optionList`, `buildPayload`, `formFromRow`, `emptyForm` (`src/lib/catalogForm.js`); `CrudForm`, `CatalogCrud` (`src/components/CatalogCrud.jsx`; a field may have `render({ value, set, form })`, `serialize(value, form)`, `options(form, row)`, `emptyLabel`, `hint`).
- Produces (exported from `HierarchyTab.jsx` for the test): `seriesFields(familiesOfProvider) -> field[]` (adds `series_family_id` select, label "ซีรีส์หลัก", empty = "ไม่มี (เป็นซีรีส์หลักของตัวเอง)"), `FAMILY_FIELDS` (name, thickness_options text ↔ `numeric[]`, active), `familyThicknessError(form) -> string | null`.

- [ ] **Step 1: Write the failing test**

Create `src/pages/aluCatalog/HierarchyTab.smoke.test.jsx`:

```jsx
// SSR smoke: the series form offers the extruder's ซีรีส์หลัก; the family form edits the thickness list as text.
import { describe, it, expect, vi } from 'vitest'
import { renderToString } from 'react-dom/server'
import { CrudForm } from '../../components/CatalogCrud.jsx'
import { emptyForm, formFromRow, buildPayload } from '../../lib/catalogForm.js'

vi.mock('../../lib/supabase.js', () => ({ supabase: {} }))
const { seriesFields, FAMILY_FIELDS, familyThicknessError } = await import('./HierarchyTab.jsx')
const clean = h => h.replace(/<!-- -->/g, '')
const form = (fields, initial, row = null) => clean(renderToString(<CrudForm fields={fields} initial={initial} row={row} onSave={() => {}} onCancel={() => {}} />))

describe('HierarchyTab forms', () => {
  const fams = [{ id: 'f1', name: 'ICONIQ EURO', active: true }, { id: 'f2', name: 'OLD', active: false }]
  it('the series form has a ซีรีส์หลัก select of active families (the current one kept)', () => {
    const fields = seriesFields(fams)
    const h = form(fields, emptyForm(fields))
    expect(h).toContain('ซีรีส์หลัก')
    expect(h).toContain('ไม่มี (เป็นซีรีส์หลักของตัวเอง)')
    expect(h).toContain('ICONIQ EURO')
    expect(h).not.toContain('>OLD<')
    const row = { id: 's', name: 'X', series_family_id: 'f2', is_base: false, active: true }
    expect(form(fields, formFromRow(fields, row), row)).toContain('OLD')
    expect(buildPayload(fields, { ...emptyForm(fields), name: 'X', series_family_id: '' })).toMatchObject({ series_family_id: null })
  })
  it('the family form shows a stored thickness list as text and saves numbers', () => {
    const row = { id: 'f', name: 'STANDARD', thickness_options: [1, 1.2, 1.5, 1.8, 2], active: true }
    expect(form(FAMILY_FIELDS, formFromRow(FAMILY_FIELDS, row), row)).toContain('value="1.0, 1.2, 1.5, 1.8, 2.0"')
    expect(buildPayload(FAMILY_FIELDS, { name: ' STANDARD ', thickness_options: '2, 1.0', active: true })).toEqual({ name: 'STANDARD', thickness_options: [1, 2], active: true })
    expect(buildPayload(FAMILY_FIELDS, { name: 'EURO', thickness_options: '', active: true }).thickness_options).toBeNull()
    expect(familyThicknessError({ thickness_options: '1.2, x' })).toBeTruthy()
    expect(familyThicknessError({ thickness_options: '' })).toBeNull()
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run src/pages/aluCatalog/HierarchyTab.smoke.test.jsx`
Expected: FAIL (`seriesFields is not a function`).

- [ ] **Step 3: Implement**

In `HierarchyTab.jsx` add imports `optionList` (from `../../lib/catalogForm.js`, next to the existing ones) and `import { parseThicknessOptions, formatThicknessOptions } from '../../lib/seriesFamily.js'`.

Replace `const SERIES_FIELDS = [ … ]` with:

```jsx
// families = the selected extruder's ซีรีส์หลัก rows. A series joins at most one family of its own extruder.
export const seriesFields = families => [
  { key: 'name', label: 'ชื่อซีรีส์', type: 'text', required: true, placeholder: 'เช่น ซีรีส์ 40' },
  { key: 'series_family_id', label: 'ซีรีส์หลัก', type: 'select', emptyLabel: 'ไม่มี (เป็นซีรีส์หลักของตัวเอง)',
    options: (form, row) => optionList(families, f => f.name, row ? row.series_family_id : null),
    hint: 'โปรเจกต์ที่เลือกซีรีส์หลักนี้ จะได้ชุดนี้กับรายการที่เป็นประเภทที่ชุดนี้ทำ' },
  { key: 'is_base', label: 'ซีรีส์พื้นฐานของโรงรีด (ใช้แสดงเท่านั้น)', type: 'checkbox', default: false },
  { key: 'active', label: 'ใช้งานอยู่', type: 'checkbox', default: true },
]

export const FAMILY_FIELDS = [
  { key: 'name', label: 'ชื่อซีรีส์หลัก', type: 'text', required: true, placeholder: 'เช่น ICONIQ EURO' },
  { key: 'thickness_options', label: 'ความหนาที่ให้เลือกในค่าเริ่มต้นโปรเจกต์ (มม.)', type: 'text',
    render: ({ value, set }) => (
      <input className="input" value={Array.isArray(value) ? formatThicknessOptions(value) : (value ?? '')}
        onChange={e => set(e.target.value)} placeholder="เช่น 1.0, 1.2, 1.5, 1.8, 2.0" />
    ),
    serialize: v => parseThicknessOptions(v).value,
    hint: 'เว้นว่าง = ใช้ทุกความหนาของชุดในกลุ่ม · ในรายการยังเลือกความหนาอื่นของชุดได้' },
  { key: 'active', label: 'ใช้งานอยู่', type: 'checkbox', default: true },
]
export const familyThicknessError = form => parseThicknessOptions(form.thickness_options).error
```

In the component: add `const families = useCatalogTable('alu_series_families')`; include `families.error` in the `error` expression; then:

```jsx
  const familiesOfProvider = (families.data || []).filter(f => f.provider_id === providerId)
  const familyById = Object.fromEntries((families.data || []).map(f => [f.id, f]))
```

In the series `CatalogCrud`: `fields={seriesFields(familiesOfProvider)}` and add the column `{ key: 'series_family_id', label: 'ซีรีส์หลัก', render: r => familyById[r.series_family_id]?.name || '—' },` after the name column.

Directly under the series card's explanatory `<div …>` (still inside the `providerId && providerById[providerId]` branch) add:

```jsx
            <CatalogCrud
              title={`🧩 ซีรีส์หลักของ ${providerById[providerId].name}`} table="alu_series_families" fields={FAMILY_FIELDS}
              rows={familiesOfProvider} scope={{ provider_id: providerId }} onChanged={families.refetch} canEdit={canEdit}
              validate={familyThicknessError}
              deleteWarning="ลบไม่ได้ถ้ายังมีซีรีส์อยู่ในกลุ่ม หรือมีโปรเจกต์ใช้เป็นค่าเริ่มต้น ให้ปิด “ใช้งานอยู่” แทน"
              duplicateMessage="โรงรีดนี้มีซีรีส์หลักชื่อนี้อยู่แล้ว"
              addLabel="+ เพิ่มซีรีส์หลัก" emptyText="ยังไม่มีซีรีส์หลัก (แต่ละซีรีส์เป็นซีรีส์หลักของตัวเอง)"
              columns={[
                { key: 'name', label: 'ซีรีส์หลัก', render: r => <strong>{r.name}</strong> },
                { key: 'thickness_options', label: 'ความหนาที่ให้เลือก', render: r => formatThicknessOptions(r.thickness_options) || 'ทุกความหนาของชุด' },
                { key: 'count', label: 'จำนวนชุด', render: r => seriesOfProvider.filter(s => s.series_family_id === r.id).length },
                { key: 'active', label: 'สถานะ', render: r => <ActiveBadge active={r.active} /> },
              ]}
            />
            <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: -12 }}>
              ซีรีส์หลักคือกลุ่มของชุดที่ขายด้วยกัน (เช่น ICONIQ EURO = บานติดตาย บานเปิด บานเลื่อน) · ค่าเริ่มต้นโปรเจกต์เลือกแค่ซีรีส์หลัก แต่ละรายการได้ชุดที่ตรงประเภทเอง · ใส่ซีรีส์เข้ากลุ่มที่ปุ่ม "แก้ไข" ของซีรีส์
            </div>
```

(`CatalogCrud` already shows its own messages; this task adds no `alert`.)

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/pages/aluCatalog/HierarchyTab.smoke.test.jsx src/pages/aluCatalog/TypesTab.smoke.test.jsx`
Expected: PASS.
Run: `npx vitest run` → Expected: all green.

- [ ] **Step 5: Commit**

```bash
cd /Users/plfx/code/FacadeXPM/facadex-app/.claude/worktrees/series-family
git add src/pages/aluCatalog/HierarchyTab.jsx src/pages/aluCatalog/HierarchyTab.smoke.test.jsx
git commit -F - <<'MSG'
feat(catalog): manage ซีรีส์หลัก per extruder and assign each series to one

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SKarDAHEncS9RZ6zCSPXc1
MSG
```

---
### Task 9: Migration 02 — parts linked to stock, purchase price + add-to-set functions, 24-part match report

**Files:**
- Create: `supabase/migrations/2026-10-31-02-alu-parts-stock-link.sql`
- Create: `supabase/migrations/2026-10-31-02-alu-parts-stock-link.dryrun.sql`
- Create: `supabase/datafix/2026-10-31-hardware-stock-match-report.sql`
- Modify: `src/lib/migrationFiles20261031.test.js` (add the new migration and report to its lists, plus one test)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces (DB): `alu_parts.inventory_item_id uuid | null` (unique where not null); RPCs (PostgREST names, called with `supabase.rpc(name, args)`):
  - `stock_item_purchase_prices({ p_item_ids: uuid[] | null }) -> { id: 'sti:<line>' | 'poi:<line>', inventory_item_id, unit_cost: number (ex-VAT, per base unit), effective_from: 'YYYY-MM-DD', source: 'tax_invoice' | 'po', doc_no }[]` (one row per item, date and source; `null` = every item a part points at)
  - `alu_add_stock_item_to_set({ p_set_id, p_inventory_item_id, p_kind: 'hardware' | 'accessory', p_quantity }) -> { part_id, added: boolean }`
  - `alu_add_new_part_to_set({ p_set_id, p_name, p_unit, p_kind, p_quantity, p_price: number | null, p_price_date: 'YYYY-MM-DD' | null }) -> { part_id }`
  - Error messages (raised as the exception text): `bad_kind`, `bad_quantity`, `bad_name`, `bad_price`, `not_a_set`, `item_not_found`.

- [ ] **Step 1: Extend the guard test (fails first)**

In `src/lib/migrationFiles20261031.test.js` change the lists to:

```js
const MIGRATIONS = ['2026-10-31-01-alu-series-family', '2026-10-31-02-alu-parts-stock-link']
const REPORTS = ['2026-10-31-series-family-price-report', '2026-10-31-hardware-stock-match-report']
```

and append:

```js
describe('2026-10-31-02 functions', () => {
  const s = mig('2026-10-31-02-alu-parts-stock-link')
  it('every function runs as the caller (RLS applies) and only authenticated may call it', () => {
    for (const fn of ['stock_item_purchase_prices', 'alu_add_stock_item_to_set', 'alu_add_new_part_to_set']) {
      expect(s).toMatch(new RegExp(`FUNCTION ${fn}\\([^)]*\\)\\s*RETURNS[\\s\\S]*?SECURITY INVOKER`))
      expect(s).toMatch(new RegExp(`REVOKE ALL ON FUNCTION ${fn}\\(`))
      expect(s).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${fn}\\([^)]*\\) TO authenticated`))
    }
    expect(s).not.toMatch(/SECURITY DEFINER/)
  })
})
```

Run: `npx vitest run src/lib/migrationFiles20261031.test.js` → Expected: FAIL (`ENOENT … 2026-10-31-02-alu-parts-stock-link.sql`).

- [ ] **Step 2: Write the migration**

Create `supabase/migrations/2026-10-31-02-alu-parts-stock-link.sql`:

```sql
-- supabase/migrations/2026-10-31-02-alu-parts-stock-link.sql
-- Hardware sets from stock (spec section 12). A catalogue part (alu_parts) may point at one stock item
-- (inventory_items); at most one part per stock item. Three functions, all SECURITY INVOKER (the caller's RLS applies):
--   stock_item_purchase_prices(p_item_ids)  read only: the latest purchase price of each stock item per date, ex-VAT,
--                                            per the item's base unit (posted supplier tax invoices, then purchase orders)
--   alu_add_stock_item_to_set(...)          find-or-create the part of a stock item, then put it in a hardware set
--   alu_add_new_part_to_set(...)            a new part that is not in stock (name, unit, optional price) into a set
-- Additive. The foreign key keeps the default action (NO ACTION). No view reads alu_parts (checked 2026-10-31).
-- The words the SQL runner refuses never appear in this file (vitest guard: src/lib/migrationFiles20261031.test.js).

ALTER TABLE alu_parts ADD COLUMN inventory_item_id UUID REFERENCES inventory_items(id);
-- an inventory item belongs to one tenant, so "one part per item" is also "one per item per tenant"
CREATE UNIQUE INDEX uq_alu_parts_inventory_item ON alu_parts (inventory_item_id) WHERE inventory_item_id IS NOT NULL;

-- p_item_ids NULL = every stock item that a catalogue part points at (what the estimation engine loads).
-- One row per (item, date, source): the last line of that day. Tax invoice lines: base_unit_cost (= line amount / base
-- quantity; the line amounts add up to net_before_vat, so it is ex-VAT). PO lines: unit price after the line discount,
-- divided by 1.07 when the PO price includes VAT; only lines in the item's base unit (no unit conversion here).
CREATE OR REPLACE FUNCTION stock_item_purchase_prices(p_item_ids UUID[] DEFAULT NULL)
RETURNS TABLE (id TEXT, inventory_item_id UUID, unit_cost NUMERIC, effective_from DATE, source TEXT, doc_no TEXT)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  WITH wanted AS (
    SELECT i.id, i.base_unit FROM inventory_items i
     WHERE (p_item_ids IS NULL AND EXISTS (SELECT 1 FROM alu_parts p WHERE p.inventory_item_id = i.id))
        OR i.id = ANY (COALESCE(p_item_ids, '{}'::uuid[]))
  ),
  sti AS (
    SELECT DISTINCT ON (li.inventory_item_id, inv.invoice_date)
           'sti:' || li.id::text AS id, li.inventory_item_id, li.base_unit_cost AS unit_cost,
           inv.invoice_date AS effective_from, 'tax_invoice'::text AS source, inv.invoice_no AS doc_no
      FROM supplier_tax_invoice_items li
      JOIN wanted w ON w.id = li.inventory_item_id
      JOIN supplier_tax_invoices inv ON inv.id = li.invoice_id AND inv.status = 'posted'
     WHERE li.base_unit_cost IS NOT NULL
     ORDER BY li.inventory_item_id, inv.invoice_date, inv.posted_at DESC NULLS LAST, li.sort_order DESC
  ),
  po AS (
    SELECT DISTINCT ON (li.inventory_item_id, o.date)
           'poi:' || li.id::text AS id, li.inventory_item_id,
           round(li.unit_price * (1 - COALESCE(li.discount_pct, 0) / 100)
                 / CASE WHEN o.has_vat AND o.price_includes_vat THEN 1.07 ELSE 1 END, 4) AS unit_cost,
           o.date AS effective_from, 'po'::text AS source, o.po_number AS doc_no
      FROM purchase_order_items li
      JOIN wanted w ON w.id = li.inventory_item_id
      JOIN purchase_orders o ON o.id = li.po_id AND o.status <> 'cancelled'
     WHERE li.unit_price > 0 AND (NULLIF(btrim(li.unit), '') IS NULL OR btrim(li.unit) = btrim(w.base_unit))
     ORDER BY li.inventory_item_id, o.date, o.created_at DESC NULLS LAST, li.sort_order DESC
  )
  SELECT * FROM sti
  UNION ALL
  SELECT * FROM po
$$;

-- Returns { part_id, added }: added = false when the set already held that part (nothing changes then).
CREATE OR REPLACE FUNCTION alu_add_stock_item_to_set(p_set_id UUID, p_inventory_item_id UUID, p_kind TEXT, p_quantity NUMERIC DEFAULT 1)
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE
  v_tenant UUID := current_tenant_id();
  v_kind   TEXT;
  v_name   TEXT;
  v_unit   TEXT;
  v_part   UUID;
  v_added  BOOLEAN := false;
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('hardware', 'accessory') THEN RAISE EXCEPTION 'bad_kind'; END IF;
  IF p_quantity IS NULL OR NOT (p_quantity > 0 AND p_quantity < 'Infinity'::numeric) THEN RAISE EXCEPTION 'bad_quantity'; END IF;
  SELECT kind INTO v_kind FROM alu_parts WHERE id = p_set_id AND tenant_id = v_tenant;
  IF v_kind IS DISTINCT FROM 'hardware_set' THEN RAISE EXCEPTION 'not_a_set'; END IF;
  SELECT name, base_unit INTO v_name, v_unit FROM inventory_items WHERE id = p_inventory_item_id AND tenant_id = v_tenant;
  IF NOT FOUND THEN RAISE EXCEPTION 'item_not_found'; END IF;
  SELECT id INTO v_part FROM alu_parts WHERE inventory_item_id = p_inventory_item_id AND tenant_id = v_tenant;
  IF v_part IS NULL THEN
    INSERT INTO alu_parts (tenant_id, name, kind, unit, inventory_item_id)
    VALUES (v_tenant, v_name, p_kind, v_unit, p_inventory_item_id)
    RETURNING id INTO v_part;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM alu_part_set_items WHERE set_id = p_set_id AND part_id = v_part) THEN
    INSERT INTO alu_part_set_items (tenant_id, set_id, part_id, quantity) VALUES (v_tenant, p_set_id, v_part, p_quantity);
    v_added := true;
  END IF;
  RETURN jsonb_build_object('part_id', v_part, 'added', v_added);
END $$;

-- A part that is not in stock: created here (code P-nnnn by the existing trigger), priced from p_price_date when a
-- price is given, and put in the set. Returns { part_id }.
CREATE OR REPLACE FUNCTION alu_add_new_part_to_set(p_set_id UUID, p_name TEXT, p_unit TEXT, p_kind TEXT,
                                                   p_quantity NUMERIC DEFAULT 1, p_price NUMERIC DEFAULT NULL, p_price_date DATE DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE
  v_tenant UUID := current_tenant_id();
  v_kind   TEXT;
  v_part   UUID;
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('hardware', 'accessory') THEN RAISE EXCEPTION 'bad_kind'; END IF;
  IF COALESCE(btrim(p_name), '') = '' OR COALESCE(btrim(p_unit), '') = '' THEN RAISE EXCEPTION 'bad_name'; END IF;
  IF p_quantity IS NULL OR NOT (p_quantity > 0 AND p_quantity < 'Infinity'::numeric) THEN RAISE EXCEPTION 'bad_quantity'; END IF;
  IF p_price IS NOT NULL AND (NOT (p_price >= 0 AND p_price < 'Infinity'::numeric) OR p_price_date IS NULL) THEN RAISE EXCEPTION 'bad_price'; END IF;
  SELECT kind INTO v_kind FROM alu_parts WHERE id = p_set_id AND tenant_id = v_tenant;
  IF v_kind IS DISTINCT FROM 'hardware_set' THEN RAISE EXCEPTION 'not_a_set'; END IF;
  INSERT INTO alu_parts (tenant_id, name, kind, unit) VALUES (v_tenant, btrim(p_name), p_kind, btrim(p_unit)) RETURNING id INTO v_part;
  IF p_price IS NOT NULL THEN
    INSERT INTO alu_part_prices (tenant_id, part_id, list_price, discount_pct, effective_from, source)
    VALUES (v_tenant, v_part, p_price, 0, p_price_date, 'manual');
  END IF;
  INSERT INTO alu_part_set_items (tenant_id, set_id, part_id, quantity) VALUES (v_tenant, p_set_id, v_part, p_quantity);
  RETURN jsonb_build_object('part_id', v_part);
END $$;

REVOKE ALL ON FUNCTION stock_item_purchase_prices(UUID[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION alu_add_stock_item_to_set(UUID, UUID, TEXT, NUMERIC) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION alu_add_new_part_to_set(UUID, TEXT, TEXT, TEXT, NUMERIC, NUMERIC, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION stock_item_purchase_prices(UUID[]) TO authenticated;
GRANT EXECUTE ON FUNCTION alu_add_stock_item_to_set(UUID, UUID, TEXT, NUMERIC) TO authenticated;
GRANT EXECUTE ON FUNCTION alu_add_new_part_to_set(UUID, TEXT, TEXT, TEXT, NUMERIC, NUMERIC, DATE) TO authenticated;
```

- [ ] **Step 3: Generate the dry run**

```bash
W=/Users/plfx/code/FacadeXPM/facadex-app/.claude/worktrees/series-family/supabase/migrations
{
  echo '-- Dry run for 2026-10-31-02 (controller only). Replays the migration verbatim, exercises the functions as the'
  echo '-- OWNER of tenant 1b9affc4 (role authenticated, request.jwt.claims email), and always rolls back via the final RAISE.'
  echo 'BEGIN;'
  echo
  cat "$W/2026-10-31-02-alu-parts-stock-link.sql"
  cat <<'SQL'

-- ===================== checks (dry run only) =====================
CREATE TEMP TABLE _res (n SERIAL, line TEXT);

DO $t$
DECLARE
  v_t     UUID := '1b9affc4-2136-4ed1-b168-a36e6624e743'::uuid;
  v_mail  TEXT;
  v_item  UUID;
  v_set1  UUID;
  v_set2  UUID;
  res1    JSONB;
  res2    JSONB;
  res3    JSONB;
  res4    JSONB;
  n       INT;
  txt     TEXT;
  r       RECORD;
BEGIN
  INSERT INTO _res(line) VALUES (CASE WHEN EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'uq_alu_parts_inventory_item')
    THEN 'PASS 1 unique index on alu_parts.inventory_item_id' ELSE 'FAIL 1 index missing' END);

  INSERT INTO _res(line) VALUES (CASE WHEN
        NOT has_function_privilege('anon', 'public.stock_item_purchase_prices(uuid[])', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.alu_add_stock_item_to_set(uuid,uuid,text,numeric)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.alu_add_new_part_to_set(uuid,text,text,text,numeric,numeric,date)', 'EXECUTE')
    AND has_function_privilege('authenticated', 'public.stock_item_purchase_prices(uuid[])', 'EXECUTE')
    AND has_function_privilege('authenticated', 'public.alu_add_stock_item_to_set(uuid,uuid,text,numeric)', 'EXECUTE')
    AND has_function_privilege('authenticated', 'public.alu_add_new_part_to_set(uuid,text,text,text,numeric,numeric,date)', 'EXECUTE')
    THEN 'PASS 2 grants: authenticated only' ELSE 'FAIL 2 grants' END);

  SELECT string_agg(DISTINCT v.relname, ', ') INTO txt
    FROM pg_depend d JOIN pg_rewrite rw ON rw.oid = d.objid JOIN pg_class v ON v.oid = rw.ev_class
    JOIN pg_class t ON t.oid = d.refobjid
   WHERE t.relnamespace = 'public'::regnamespace AND t.relname = 'alu_parts' AND v.oid <> t.oid;
  INSERT INTO _res(line) VALUES (CASE WHEN txt IS NULL THEN 'PASS 3 no view depends on alu_parts' ELSE 'FAIL 3 views: ' || txt END);

  -- posted tax invoices whose lines do not add up to net_before_vat (then base_unit_cost might not be ex-VAT)
  SELECT count(*) INTO n FROM supplier_tax_invoices inv
   WHERE inv.status = 'posted'
     AND abs(COALESCE((SELECT sum(amount) FROM supplier_tax_invoice_items li WHERE li.invoice_id = inv.id), 0) - inv.net_before_vat) > 1;
  INSERT INTO _res(line) VALUES (CASE WHEN n = 0 THEN 'PASS 4 every posted tax invoice: lines add up to net_before_vat (ex-VAT)'
    ELSE 'info 4 posted invoices whose lines differ from net_before_vat by > 1 baht: ' || n || ' (look before trusting base_unit_cost)' END);

  -- the stock item with the most recent posted tax invoice line in category อุปกรณ์ (falls back to any active item)
  SELECT li.inventory_item_id INTO v_item
    FROM supplier_tax_invoice_items li JOIN supplier_tax_invoices inv ON inv.id = li.invoice_id AND inv.status = 'posted'
    JOIN inventory_items i ON i.id = li.inventory_item_id JOIN expense_categories c ON c.id = i.category_id AND c.name = 'อุปกรณ์'
   WHERE inv.tenant_id = v_t ORDER BY inv.invoice_date DESC LIMIT 1;
  IF v_item IS NULL THEN SELECT id INTO v_item FROM inventory_items WHERE tenant_id = v_t AND active ORDER BY name LIMIT 1; END IF;

  SELECT user_email INTO v_mail FROM user_roles WHERE tenant_id = v_t AND role = 'OWNER' ORDER BY user_email LIMIT 1;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated', 'email', v_mail)::text, true);
  EXECUTE 'SET LOCAL role authenticated';

  FOR r IN SELECT * FROM stock_item_purchase_prices(ARRAY[v_item]) ORDER BY effective_from DESC LIMIT 3 LOOP
    INSERT INTO _res(line) VALUES (format('info 5 price row %s %s %s %s (%s)', r.source, r.effective_from, r.unit_cost, r.doc_no, r.id));
  END LOOP;

  INSERT INTO alu_parts (name, kind, unit) VALUES ('dry-run set 1', 'hardware_set', 'ชุด') RETURNING id INTO v_set1;
  INSERT INTO alu_parts (name, kind, unit) VALUES ('dry-run set 2', 'hardware_set', 'ชุด') RETURNING id INTO v_set2;
  res1 := alu_add_stock_item_to_set(v_set1, v_item, 'hardware', 2);
  res2 := alu_add_stock_item_to_set(v_set1, v_item, 'hardware', 5);
  res3 := alu_add_stock_item_to_set(v_set2, v_item, 'accessory', 1);
  SELECT count(*) INTO n FROM alu_parts WHERE inventory_item_id = v_item;
  INSERT INTO _res(line) VALUES (CASE WHEN (res1->>'added')::boolean AND NOT (res2->>'added')::boolean AND (res3->>'added')::boolean
      AND res1->>'part_id' = res2->>'part_id' AND res1->>'part_id' = res3->>'part_id' AND n = 1
      AND (SELECT quantity FROM alu_part_set_items WHERE set_id = v_set1 AND part_id = (res1->>'part_id')::uuid) = 2
    THEN 'PASS 6 one part per stock item, reused across sets, a second add changes nothing'
    ELSE format('FAIL 6 %s %s %s parts=%s', res1, res2, res3, n) END);

  SELECT count(*) INTO n FROM stock_item_purchase_prices(NULL) WHERE inventory_item_id = v_item;
  INSERT INTO _res(line) VALUES ('info 7 engine rows for the linked item: ' || n);

  res4 := alu_add_new_part_to_set(v_set1, 'dry-run new part', 'ชิ้น', 'accessory', 3, 12.5, DATE '2026-10-31');
  INSERT INTO _res(line) VALUES (CASE WHEN EXISTS (SELECT 1 FROM alu_part_prices WHERE part_id = (res4->>'part_id')::uuid AND list_price = 12.5 AND effective_from = DATE '2026-10-31')
      AND EXISTS (SELECT 1 FROM alu_part_set_items WHERE set_id = v_set1 AND part_id = (res4->>'part_id')::uuid AND quantity = 3)
      AND (SELECT kind FROM alu_parts WHERE id = (res4->>'part_id')::uuid) = 'accessory'
    THEN 'PASS 8 new part with a price lands in the set' ELSE 'FAIL 8 ' || res4 END);

  BEGIN
    PERFORM alu_add_stock_item_to_set(v_set1, v_item, 'hardware_set', 1);
    INSERT INTO _res(line) VALUES ('FAIL 9 bad kind accepted');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _res(line) VALUES (CASE WHEN SQLERRM = 'bad_kind' THEN 'PASS 9 bad_kind refused' ELSE 'FAIL 9 ' || SQLERRM END);
  END;
  BEGIN
    PERFORM alu_add_stock_item_to_set(v_item, v_item, 'hardware', 1);
    INSERT INTO _res(line) VALUES ('FAIL 10 a non-set accepted');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _res(line) VALUES (CASE WHEN SQLERRM = 'not_a_set' THEN 'PASS 10 not_a_set refused' ELSE 'FAIL 10 ' || SQLERRM END);
  END;
  EXECUTE 'RESET ROLE';
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _res(line) VALUES ('FAIL exception: ' || SQLERRM);
END $t$;

DO $z$ BEGIN RAISE EXCEPTION 'RESULTS: %', (SELECT string_agg(line, E'\n' ORDER BY n) FROM _res); END $z$;
ROLLBACK;
SQL
} > "$W/2026-10-31-02-alu-parts-stock-link.dryrun.sql"
```

- [ ] **Step 4: Write the read-only match report**

Create `supabase/datafix/2026-10-31-hardware-stock-match-report.sql`:

```sql
-- supabase/datafix/2026-10-31-hardware-stock-match-report.sql
-- READ ONLY (spec section 12). The catalogue's existing parts (no stock link yet) next to stock items with a similar
-- name, for the owner to confirm before any link is made. Nothing is linked automatically.
-- match = 'same name' (case and outer spaces ignored) or 'contains' (one name inside the other). Up to 3 per part.
SELECT p.code, p.name AS part, p.kind, p.unit,
       m.code AS stock_code, m.name AS stock_name, m.base_unit AS stock_unit, c.name AS stock_category,
       CASE WHEN m.id IS NULL THEN 'no match'
            WHEN lower(btrim(m.name)) = lower(btrim(p.name)) THEN 'same name'
            ELSE 'contains' END AS match
  FROM alu_parts p
  LEFT JOIN LATERAL (
    SELECT i.id, i.code, i.name, i.base_unit, i.category_id
      FROM inventory_items i
     WHERE i.tenant_id = p.tenant_id AND i.active
       AND (lower(btrim(i.name)) = lower(btrim(p.name))
            OR position(lower(btrim(p.name)) IN lower(i.name)) > 0
            OR position(lower(btrim(i.name)) IN lower(p.name)) > 0)
     ORDER BY (lower(btrim(i.name)) = lower(btrim(p.name))) DESC, length(i.name), i.name
     LIMIT 3
  ) m ON true
  LEFT JOIN expense_categories c ON c.id = m.category_id
 WHERE p.kind <> 'hardware_set' AND p.inventory_item_id IS NULL
 ORDER BY p.code, match DESC, m.name;
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/lib/migrationFiles20261031.test.js` → Expected: PASS.
Run: `npx vitest run` → Expected: all green.

- [ ] **Step 6: Commit**

```bash
cd /Users/plfx/code/FacadeXPM/facadex-app/.claude/worktrees/series-family
git add supabase/migrations/2026-10-31-02-alu-parts-stock-link.sql supabase/migrations/2026-10-31-02-alu-parts-stock-link.dryrun.sql supabase/datafix/2026-10-31-hardware-stock-match-report.sql src/lib/migrationFiles20261031.test.js
git commit -F - <<'MSG'
feat(db): catalogue parts linked to stock, latest purchase price + add-to-set functions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SKarDAHEncS9RZ6zCSPXc1
MSG
```

Controller (not the implementer): run the dry run; expected RESULTS: PASS 1, 2, 3, 6, 8, 9, 10; PASS 4 or an `info 4` count to look at before trusting `base_unit_cost` as ex-VAT; `info 5` up to 3 price rows of the sample item; `info 7` ≥ 1. Then the owner applies it, and the controller runs the match report and shows it to the owner (nothing is linked automatically).

---
### Task 10: Latest purchase price — pure helper, used by the estimation engine and price labels

**Files:**
- Create: `src/lib/latestPurchasePrice.js`
- Test: `src/lib/latestPurchasePrice.test.js` (new)
- Modify: `src/lib/aluCatalogPricing.js` (`buildCatalogIndex` gains `purchasePrices`; `hardwarePrice` and `setLines` price parts through `resolveStockPartPrice`)
- Modify: `src/hooks/useAluCatalog.js` (`useEstimationCatalog` also loads `stock_item_purchase_prices`)
- Modify: `src/pages/estimation/projectDefaults.js` (`priceRowLabel` knows purchase-price ids)
- Test: `src/lib/aluCatalogPricingStock.test.js` (new)

**Interfaces:**
- Consumes (Task 9): RPC `stock_item_purchase_prices` rows; `alu_parts.inventory_item_id`; `resolvePartPrice({ partId, asOf, partPrices })` (`src/lib/aluPrice.js`, returns `{ list_price, discount_pct, net_price, row } | null`).
- Produces (`src/lib/latestPurchasePrice.js`):
  - `latestPurchasePrice(rows, inventoryItemId, asOf?) -> { unit_cost, effective_from, source, doc_no, id } | null` (latest posted tax invoice on/before asOf, else latest PO on/before asOf; no asOf = latest of all)
  - `resolveStockPartPrice({ partId, part, asOf, purchasePrices, partPrices }) -> { list_price, discount_pct, net_price, row: { id, effective_from }, source: 'tax_invoice' | 'po' | 'catalog', date, doc_no } | null`
  - `priceSourceText(price) -> string` (`ใบกำกับภาษีซื้อ IV-1 · 2026-10-01` / `ใบสั่งซื้อ PO-… · …` / `แคตตาล็อก · ตั้งแต่ …` / `ยังไม่มีราคา`)
  - `buildCatalogIndex(rows).purchasePrices` = `rows.purchasePrices || []`; a hardware-set line of a stock-linked part gets `price_row_id = 'sti:…' | 'poi:…'`.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/latestPurchasePrice.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { latestPurchasePrice, resolveStockPartPrice, priceSourceText } from './latestPurchasePrice.js'

const rows = [
  { id: 'sti:1', inventory_item_id: 'i1', unit_cost: '98', effective_from: '2026-09-01', source: 'tax_invoice', doc_no: 'IV-1' },
  { id: 'sti:2', inventory_item_id: 'i1', unit_cost: 105, effective_from: '2026-10-20', source: 'tax_invoice', doc_no: 'IV-2' },
  { id: 'poi:1', inventory_item_id: 'i1', unit_cost: 90, effective_from: '2026-10-25', source: 'po', doc_no: 'PO-2026-010' },
  { id: 'poi:2', inventory_item_id: 'i2', unit_cost: 40, effective_from: '2026-08-01', source: 'po', doc_no: 'PO-2026-002' },
]
const partPrices = [{ id: 'pp1', part_id: 'P3', list_price: 100, discount_pct: 10, effective_from: '2026-01-01' }]

describe('latestPurchasePrice', () => {
  it('a tax invoice beats a newer PO; numbers come out as numbers', () => {
    expect(latestPurchasePrice(rows, 'i1')).toEqual({ unit_cost: 105, effective_from: '2026-10-20', source: 'tax_invoice', doc_no: 'IV-2', id: 'sti:2' })
  })
  it('never a price dated after asOf (Review Focus 4)', () => {
    expect(latestPurchasePrice(rows, 'i1', '2026-10-01').id).toBe('sti:1')
    expect(latestPurchasePrice(rows, 'i1', '2026-08-31')).toBeNull()
  })
  it('a PO when the item has no tax invoice; null for no rows or no item', () => {
    expect(latestPurchasePrice(rows, 'i2').source).toBe('po')
    expect(latestPurchasePrice(rows, 'i9')).toBeNull()
    expect(latestPurchasePrice(rows, null)).toBeNull()
  })
})

describe('resolveStockPartPrice', () => {
  it('a stock-linked part: the purchase price, in resolvePartPrice shape', () => {
    const p = resolveStockPartPrice({ partId: 'P1', part: { id: 'P1', inventory_item_id: 'i1' }, asOf: '2026-10-31', purchasePrices: rows, partPrices })
    expect(p).toEqual({ list_price: 105, discount_pct: 0, net_price: 105, row: { id: 'sti:2', effective_from: '2026-10-20' }, source: 'tax_invoice', date: '2026-10-20', doc_no: 'IV-2' })
  })
  it('falls back to the catalogue price, and an unlinked part always uses it', () => {
    expect(resolveStockPartPrice({ partId: 'P3', part: { id: 'P3', inventory_item_id: 'i9' }, asOf: '2026-10-31', purchasePrices: rows, partPrices }))
      .toMatchObject({ net_price: 90, source: 'catalog', date: '2026-01-01', doc_no: null })
    expect(resolveStockPartPrice({ partId: 'P3', part: { id: 'P3' }, asOf: '2026-10-31', purchasePrices: rows, partPrices }).source).toBe('catalog')
    expect(resolveStockPartPrice({ partId: 'P4', part: { id: 'P4' }, asOf: '2026-10-31', purchasePrices: rows, partPrices })).toBeNull()
  })
  it('priceSourceText', () => {
    expect(priceSourceText({ source: 'tax_invoice', doc_no: 'IV-2', date: '2026-10-20' })).toBe('ใบกำกับภาษีซื้อ IV-2 · 2026-10-20')
    expect(priceSourceText({ source: 'po', doc_no: 'PO-1', date: '2026-08-01' })).toBe('ใบสั่งซื้อ PO-1 · 2026-08-01')
    expect(priceSourceText({ source: 'catalog', date: '2026-01-01' })).toBe('แคตตาล็อก · ตั้งแต่ 2026-01-01')
    expect(priceSourceText(null)).toBe('ยังไม่มีราคา')
  })
})
```

Create `src/lib/aluCatalogPricingStock.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { buildCatalogIndex, makeCatalogPricing } from './aluCatalogPricing.js'
import { priceRowLabel } from '../pages/estimation/projectDefaults.js'

const index = buildCatalogIndex({
  parts: [
    { id: 'SET', kind: 'hardware_set', name: 'ชุดบานเลื่อน' },
    { id: 'P1', kind: 'hardware', name: 'ล้อ', inventory_item_id: 'i1' },
    { id: 'P2', kind: 'accessory', name: 'ซิลิโคน' },
  ],
  setItems: [{ id: 'x1', set_id: 'SET', part_id: 'P1', quantity: 4 }, { id: 'x2', set_id: 'SET', part_id: 'P2', quantity: 1 }],
  partPrices: [{ id: 'pp2', part_id: 'P2', list_price: 95, discount_pct: 0, effective_from: '2026-01-01' }, { id: 'pp1', part_id: 'P1', list_price: 70, discount_pct: 0, effective_from: '2026-01-01' }],
  purchasePrices: [{ id: 'sti:9', inventory_item_id: 'i1', unit_cost: 85, effective_from: '2026-10-01', source: 'tax_invoice', doc_no: 'IV-9' }],
})
const lines = asOf => makeCatalogPricing({ index, seriesId: null, finishId: null, asOf }).setLines('SET')

describe('hardware set lines with a stock-linked part', () => {
  it('the linked part is priced at its latest purchase price on/before the project date', () => {
    const l = lines('2026-10-31')
    expect(l.find(x => x.name === 'ล้อ')).toMatchObject({ unit_price: 85, cost: 340, resolved: true, price_row_id: 'sti:9' })
    expect(l.find(x => x.name === 'ซิลิโคน')).toMatchObject({ unit_price: 95, price_row_id: 'pp2' })
  })
  it('a project dated before the invoice keeps the catalogue price', () => {
    expect(lines('2026-09-01').find(x => x.name === 'ล้อ')).toMatchObject({ unit_price: 70, price_row_id: 'pp1' })
  })
  it('priceRowLabel names a purchase-price row', () => {
    expect(priceRowLabel(index, 'sti:9')).toBe('85.00 บาท (ใบกำกับภาษีซื้อ IV-9 · 2026-10-01)')
  })
  it('buildCatalogIndex: purchasePrices defaults to []', () => {
    expect(buildCatalogIndex({}).purchasePrices).toEqual([])
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/lib/latestPurchasePrice.test.js src/lib/aluCatalogPricingStock.test.js`
Expected: FAIL (`Failed to resolve import "./latestPurchasePrice.js"`).

- [ ] **Step 3: Implement `src/lib/latestPurchasePrice.js`**

```js
// src/lib/latestPurchasePrice.js
// Price of a catalogue part that points at a stock item (alu_parts.inventory_item_id), spec 2026-10-31 section 12:
// the latest posted supplier tax invoice price, else the latest purchase-order price, else the part's own catalogue
// price (alu_part_prices). Ex-VAT, per the stock item's base unit. rows = stock_item_purchase_prices() rows
// { id, inventory_item_id, unit_cost, effective_from, source: 'tax_invoice' | 'po', doc_no }. asOf = 'YYYY-MM-DD'.
// Pure; the estimation engine (aluCatalogPricing) and the hardware set page price a part through the same function.
import { resolvePartPrice } from './aluPrice.js'

function latestOf(rows, itemId, source, asOf) {
  let best = null
  for (const r of rows || []) {
    if (r.inventory_item_id !== itemId || r.source !== source) continue
    if (asOf && r.effective_from > asOf) continue
    if (!best || r.effective_from > best.effective_from) best = r
  }
  return best
}

export function latestPurchasePrice(rows, inventoryItemId, asOf) {
  if (!inventoryItemId) return null
  const r = latestOf(rows, inventoryItemId, 'tax_invoice', asOf) || latestOf(rows, inventoryItemId, 'po', asOf)
  if (!r) return null
  const n = Number(r.unit_cost)
  return Number.isFinite(n) ? { unit_cost: n, effective_from: r.effective_from, source: r.source, doc_no: r.doc_no || null, id: r.id } : null
}

// resolvePartPrice's shape ({ list_price, discount_pct, net_price, row }) plus source and date.
export function resolveStockPartPrice({ partId, part, asOf, purchasePrices, partPrices }) {
  const p = part || null
  const bought = p && p.inventory_item_id ? latestPurchasePrice(purchasePrices, p.inventory_item_id, asOf) : null
  if (bought) {
    return {
      list_price: bought.unit_cost, discount_pct: 0, net_price: bought.unit_cost,
      row: { id: bought.id, effective_from: bought.effective_from }, source: bought.source, date: bought.effective_from, doc_no: bought.doc_no,
    }
  }
  const c = resolvePartPrice({ partId: partId || (p && p.id), asOf, partPrices })
  return c ? { ...c, source: 'catalog', date: c.row.effective_from, doc_no: null } : null
}

const SOURCE_TEXT = { tax_invoice: 'ใบกำกับภาษีซื้อ', po: 'ใบสั่งซื้อ' }
export function priceSourceText(price) {
  if (!price) return 'ยังไม่มีราคา'
  if (price.source === 'catalog') return `แคตตาล็อก · ตั้งแต่ ${price.date}`
  return [[SOURCE_TEXT[price.source] || price.source, price.doc_no].filter(Boolean).join(' '), price.date].filter(Boolean).join(' · ')
}
```

- [ ] **Step 4: Engine, loader and label**

`src/lib/aluCatalogPricing.js`: add `import { resolveStockPartPrice } from './latestPurchasePrice.js'`; in `buildCatalogIndex` add `purchasePrices: rows.purchasePrices || [],` after `partPrices`. Add one helper inside `makeCatalogPricing` (after `asOfOk`):

```js
  // a part linked to stock is priced at its latest purchase on/before asOf, else its catalogue price
  const partPrice = partId => resolveStockPartPrice({ partId, part: index.parts[partId], asOf, purchasePrices: index.purchasePrices, partPrices: index.partPrices })
```

and replace both `resolvePartPrice({ partId: h.part_id, asOf, partPrices: index.partPrices })` (in `hardwarePrice`) with `partPrice(h.part_id)` and `resolvePartPrice({ partId: item.part_id, asOf, partPrices: index.partPrices })` (in `setLines`) with `partPrice(item.part_id)`. Keep `resolvePartPrice` in the import only if still used in the file.

`src/hooks/useAluCatalog.js`, in `useEstimationCatalog`'s query function, after the `entries` `Promise.all`:

```js
    // latest purchase prices of stock-linked parts (read-only RPC); a failure leaves those parts on catalogue prices
    let purchasePrices = []
    try {
      purchasePrices = await fetchAllRows(() => supabase.rpc('stock_item_purchase_prices', { p_item_ids: null }).order('id'))
    } catch (e) {
      console.warn('stock purchase prices not loaded', e)
    }
    return { ...Object.fromEntries(entries), purchasePrices }
```

with `import { fetchAllRows } from '../lib/fetchAllRows.js'`.

`src/pages/estimation/projectDefaults.js`, in `priceRowLabel`, before `return 'ราคาที่ถูกลบแล้ว'` add (and `import { priceSourceText } from '../../lib/latestPurchasePrice.js'`):

```js
  const bought = (index.purchasePrices || []).find(r => r.id === id)
  if (bought) return `${Number(bought.unit_cost).toLocaleString('en-US', { minimumFractionDigits: 2 })} บาท (${priceSourceText({ source: bought.source, doc_no: bought.doc_no, date: bought.effective_from })})`
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/lib/latestPurchasePrice.test.js src/lib/aluCatalogPricingStock.test.js src/lib/aluCatalogPricing.test.js src/lib/openingCost.test.js src/pages/estimation/projectDefaults.test.js`
Expected: PASS (existing pricing tests unchanged: their parts have no `inventory_item_id`).
Run: `npx vitest run` → Expected: all green.

- [ ] **Step 6: Commit**

```bash
cd /Users/plfx/code/FacadeXPM/facadex-app/.claude/worktrees/series-family
git add src/lib/latestPurchasePrice.js src/lib/latestPurchasePrice.test.js src/lib/aluCatalogPricing.js src/lib/aluCatalogPricingStock.test.js src/hooks/useAluCatalog.js src/pages/estimation/projectDefaults.js
git commit -F - <<'MSG'
feat(estimation): stock-linked parts priced at the latest purchase price (tax invoice > PO > catalogue)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SKarDAHEncS9RZ6zCSPXc1
MSG
```

---
### Task 11: The hardware set page (ชุดอุปกรณ์): no unit, hardware + consumables from stock, series links

**Files:**
- Create: `src/lib/hardwareSetView.js`
- Test: `src/lib/hardwareSetView.test.js` (new)
- Create: `src/pages/aluCatalog/HardwareSetsPanel.jsx`, `src/pages/aluCatalog/StockItemPicker.jsx`, `src/pages/aluCatalog/SeriesLinkPicker.jsx`
- Test: `src/pages/aluCatalog/HardwareSetsPanel.smoke.test.jsx` (new)
- Modify: `src/pages/aluCatalog/PartsTab.jsx` (view switch; `accessory` label "วัสดุสิ้นเปลือง"; sets leave the general list; the old "สิ่งที่อยู่ในชุดนี้" LinkEditor is removed — the new page replaces it)
- Modify: `src/pages/estimation/noBrowserDialogs.test.js` (add the three new files to `FILES` as `'../aluCatalog/HardwareSetsPanel.jsx'`, `'../aluCatalog/StockItemPicker.jsx'`, `'../aluCatalog/SeriesLinkPicker.jsx'`; `source()` resolves them relative to the test)

**Interfaces:**
- Consumes: RPCs `stock_item_purchase_prices`, `alu_add_stock_item_to_set`, `alu_add_new_part_to_set` (Task 9); `resolveStockPartPrice`, `latestPurchasePrice`, `priceSourceText` (Task 10); `familyChoices`, `familySeries` (Task 2); `buildCatalogIndex`; `useCatalogTable(table, orderBy)`; `useQuery(fn, deps)` (`src/hooks/useSupabase.js`); `fetchAllRows`; `CrudForm`, `Modal`, `InlineError`; `typePickerOptions(types, keepIds)` (`src/lib/catalogTypeForm.js`); `localDateString(date)` (`src/lib/localDate.js`).
- Produces (`src/lib/hardwareSetView.js`):
  - `SECTIONS = [{ key: 'hardware', title: 'อุปกรณ์', kind: 'hardware', addLabel: '+ เพิ่มอุปกรณ์', categories: ['อุปกรณ์'] }, { key: 'consumable', title: 'วัสดุสิ้นเปลือง', kind: 'accessory', addLabel: '+ เพิ่มวัสดุสิ้นเปลือง', categories: ['วัสดุสิ้นเปลือง', 'ซิลิโคน/ยาง'] }]`
  - `setLines({ setId, setItems, partsById }) -> { hardware: Line[], consumable: Line[] }`, `Line = { id, part, quantity }`
  - `setSummaryText(lines) -> string`, `priceLines(lines, { asOf, purchasePrices, partPrices }) -> (Line & { price })[]`, `setTotal(priced) -> { total, missing }`
  - `onHandByItem(balances) -> { [itemId]: number }`, `stockMatches({ items, categoryNames, query, limit? }) -> item[]`, `stockLineText({ onHand, unit, price }) -> string`
  - `seriesChips({ setId, seriesParts, seriesById, providersById, typesById }) -> { id, provider, label, type }[]`, `newSeriesLinks({ setId, seriesIds, typeId, seriesParts }) -> { series_id, part_id, type_id }[]`
  - `rpcErrorText(error) -> string`, `addResultText(data, name) -> string`
  - `HardwareSetsPanel` default export `({ canEdit })`; named exports `setFields(providers)`, `SetDetail(props)`; `StockItemPicker` default export, named `StockResults(props)`.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/hardwareSetView.test.js`:

```js
import { describe, it, expect } from 'vitest'
import {
  SECTIONS, setLines, setSummaryText, priceLines, setTotal, onHandByItem, stockMatches, stockLineText, seriesChips, newSeriesLinks,
  rpcErrorText, addResultText,
} from './hardwareSetView.js'

const partsById = {
  P9: { id: 'P9', code: 'P-0009', name: 'ลูกล้อบานเลื่อน', kind: 'hardware', unit: 'ชิ้น', inventory_item_id: 'i1' },
  P7: { id: 'P7', code: 'P-0007', name: 'มือจับฝัง(ล็อค)', kind: 'hardware', unit: 'ชิ้น' },
  S1: { id: 'S1', code: 'P-0030', name: 'ซิลิโคน 300 มล.', kind: 'accessory', unit: 'หลอด' },
}
const setItems = [
  { id: 'a', set_id: 'SET', part_id: 'P9', quantity: '4' }, { id: 'b', set_id: 'SET', part_id: 'P7', quantity: 1 },
  { id: 'c', set_id: 'SET', part_id: 'S1', quantity: 2 }, { id: 'd', set_id: 'OTHER', part_id: 'P7', quantity: 1 },
]

describe('set contents', () => {
  it('splits into hardware and consumables, by name, quantities as numbers', () => {
    const l = setLines({ setId: 'SET', setItems, partsById })
    expect(l.hardware.map(x => [x.part.id, x.quantity])).toEqual([['P7', 1], ['P9', 4]])
    expect(l.consumable.map(x => x.part.id)).toEqual(['S1'])
    expect(setSummaryText(l)).toBe('2 อุปกรณ์ · 1 สิ้นเปลือง')
    expect(setSummaryText(setLines({ setId: 'EMPTY', setItems, partsById }))).toBe('ยังไม่ได้ใส่ของ')
  })
  it('prices each line (purchase price for stock-linked parts) and totals the set', () => {
    const ctx = {
      asOf: '2026-10-31',
      purchasePrices: [{ id: 'sti:1', inventory_item_id: 'i1', unit_cost: 85, effective_from: '2026-10-01', source: 'tax_invoice', doc_no: 'IV-1' }],
      partPrices: [{ id: 'pp', part_id: 'S1', list_price: 95, discount_pct: 0, effective_from: '2026-01-01' }],
    }
    const l = setLines({ setId: 'SET', setItems, partsById })
    const priced = priceLines([...l.hardware, ...l.consumable], ctx)
    expect(priced.map(x => x.price && x.price.net_price)).toEqual([null, 85, 95])
    expect(setTotal(priced)).toEqual({ total: 4 * 85 + 2 * 95, missing: 1 })
  })
})

describe('stock search', () => {
  const items = [
    { id: 'i1', code: 'HW0001', name: 'มือจับกระทุ้ง 019 สีดำ ขวา', base_unit: 'ชิ้น', expense_categories: { name: 'อุปกรณ์' } },
    { id: 'i2', code: 'SC0001', name: 'ซิลิโคน 300 มล.', base_unit: 'หลอด', expense_categories: { name: 'ซิลิโคน/ยาง' } },
    { id: 'i3', code: 'AL0001', name: 'มือจับ อลูมิเนียม', base_unit: 'เส้น', expense_categories: { name: 'อลูมิเนียม/เหล็ก' } },
    { id: 'i4', code: 'HW0002', name: 'มือจับปิดแล้ว', base_unit: 'ชิ้น', active: false, expense_categories: { name: 'อุปกรณ์' } },
  ]
  it("only the section's categories, active, by name or code", () => {
    expect(stockMatches({ items, categoryNames: SECTIONS[0].categories, query: 'มือจับ' }).map(i => i.id)).toEqual(['i1'])
    expect(stockMatches({ items, categoryNames: SECTIONS[1].categories, query: 'sc00' }).map(i => i.id)).toEqual(['i2'])
    expect(stockMatches({ items, categoryNames: SECTIONS[0].categories, query: '' }).map(i => i.id)).toEqual(['i1'])
    expect(stockMatches({ items: null, categoryNames: ['อุปกรณ์'], query: 'x' })).toEqual([])
  })
  it('on hand summed over sites; the line text of the mockup', () => {
    expect(onHandByItem([{ inventory_item_id: 'i1', quantity_on_hand: '10' }, { inventory_item_id: 'i1', quantity_on_hand: 14 }])).toEqual({ i1: 24 })
    expect(stockLineText({ onHand: 24, unit: 'ชิ้น', price: { unit_cost: 145 } })).toBe('คงเหลือ 24 ชิ้น · ซื้อล่าสุด 145')
    expect(stockLineText({ onHand: 0, unit: 'ชิ้น', price: { unit_cost: 98 } })).toBe('หมดสต๊อก · ซื้อล่าสุด 98')
    expect(stockLineText({ onHand: undefined, unit: 'ชิ้น', price: null })).toBe('หมดสต๊อก · ยังไม่มีราคาซื้อ')
  })
})

describe('series links', () => {
  const seriesParts = [
    { id: 'L1', series_id: 's2', part_id: 'SET', type_id: null }, { id: 'L2', series_id: 's1', part_id: 'SET', type_id: 'slide' },
    { id: 'L3', series_id: 's1', part_id: 'OTHER', type_id: null },
  ]
  const seriesById = { s1: { id: 's1', name: 'ICONIQ EURO บานเลื่อน', provider_id: 'A' }, s2: { id: 's2', name: 'ทั่วไป', provider_id: 'X' } }
  const providersById = { A: { id: 'A', name: 'บจก. อลูเม็ท (Alumet)', short_name: 'Alumet' }, X: { id: 'X', name: 'ไฟล์ Aluminium calculation', short_name: 'XLS' } }
  it('chips of this set, with extruder and type', () => {
    expect(seriesChips({ setId: 'SET', seriesParts, seriesById, providersById, typesById: { slide: { name: 'บานเลื่อน' } } })).toEqual([
      { id: 'L2', provider: 'Alumet', label: 'ICONIQ EURO บานเลื่อน', type: 'บานเลื่อน' },
      { id: 'L1', provider: 'XLS', label: 'ทั่วไป', type: '' },
    ])
  })
  it('new links skip the ones the set already has (same series and type)', () => {
    expect(newSeriesLinks({ setId: 'SET', seriesIds: ['s1', 's3', 's3'], typeId: 'slide', seriesParts })).toEqual([{ series_id: 's3', part_id: 'SET', type_id: 'slide' }])
    expect(newSeriesLinks({ setId: 'SET', seriesIds: ['s1'], typeId: '', seriesParts })).toEqual([{ series_id: 's1', part_id: 'SET', type_id: null }])
  })
})

describe('messages', () => {
  it('RPC errors in Thai; database errors via friendlyDbError', () => {
    expect(rpcErrorText({ message: 'not_a_set' })).toBe('ไม่พบชุดอุปกรณ์นี้ (อาจถูกลบไปแล้ว)')
    expect(rpcErrorText({ message: 'item_not_found' })).toBe('ไม่พบรายการนี้ในสต๊อก หรือไม่มีสิทธิ์ดูสต๊อก')
    expect(rpcErrorText({ code: '23505', message: 'dup' })).toBe('มีข้อมูลนี้อยู่แล้ว (ซ้ำ) กรุณาตรวจสอบรายการเดิม')
  })
  it('a second add of the same stock item says it is already there (Review Focus 5)', () => {
    expect(addResultText({ part_id: 'p', added: false }, 'ลูกล้อ')).toBe('ลูกล้อ มีในชุดแล้ว')
    expect(addResultText({ part_id: 'p', added: true }, 'ลูกล้อ')).toBe('เพิ่ม ลูกล้อ แล้ว')
  })
})
```

Create `src/pages/aluCatalog/HardwareSetsPanel.smoke.test.jsx`:

```jsx
// SSR smoke of the hardware set page parts (mockup hwset.html): the set form has no unit, the detail shows the two
// sections, prices with their source, the set total and the series chips; the stock list shows on hand + last price.
import { describe, it, expect, vi } from 'vitest'
import { renderToString } from 'react-dom/server'
import { CrudForm } from '../../components/CatalogCrud.jsx'
import { emptyForm } from '../../lib/catalogForm.js'

vi.mock('../../lib/supabase.js', () => ({ supabase: {} }))
const { setFields, SetDetail } = await import('./HardwareSetsPanel.jsx')
const { StockResults } = await import('./StockItemPicker.jsx')
const clean = h => h.replace(/<!-- -->/g, '')
const noop = () => {}

describe('hardware set page', () => {
  it('the set form: name, maker (optional), active; no unit', () => {
    const f = setFields([{ id: 'A', name: 'Alumet', active: true }])
    const h = clean(renderToString(<CrudForm fields={f} initial={emptyForm(f)} onSave={noop} onCancel={noop} />))
    expect(h).toContain('ชื่อชุด')
    expect(h).toContain('ผู้ผลิต (ไม่บังคับ)')
    expect(h).not.toContain('หน่วย')
  })
  it('the detail: two sections, prices with source, total, chips', () => {
    const part = (id, name, unit) => ({ id, code: 'P-' + id, name, unit })
    const lines = {
      hardware: [{ id: 'a', quantity: 4, part: part('9', 'ลูกล้อบานเลื่อน', 'ชิ้น'), price: { net_price: 85, source: 'tax_invoice', doc_no: 'IV-1', date: '2026-10-01' } }],
      consumable: [{ id: 'c', quantity: 2, part: part('30', 'ซิลิโคน 300 มล.', 'หลอด'), price: null }],
    }
    const h = clean(renderToString(
      <SetDetail set={{ id: 'S', code: 'P-0025', name: 'อุปกรณ์หน้าต่างบานเลื่อนสวน', active: true }} lines={lines} total={{ total: 340, missing: 1 }}
        chips={[{ id: 'L', provider: 'Alumet', label: 'ICONIQ EURO บานเลื่อน', type: '' }]} canEdit
        pickerFor={() => null} seriesPicker={null}
        on={{ edit: noop, toggleActive: noop, add: noop, quantity: noop, removeLine: noop, addSeries: noop, removeChip: noop }} />,
    ))
    for (const t of ['1. อุปกรณ์', '2. วัสดุสิ้นเปลือง', '3. ใช้กับซีรีส์', '+ เพิ่มอุปกรณ์', '+ เพิ่มวัสดุสิ้นเปลือง', '+ เพิ่มซีรีส์']) expect(h).toContain(t)
    expect(h).toContain('ราคาชุด = รวมราคาของในชุด 340.00 บาท (ยังไม่มีราคา 1 รายการ)')
    expect(h).toContain('ใบกำกับภาษีซื้อ IV-1 · 2026-10-01')
    expect(h).toContain('ยังไม่มีราคา')
    expect(h).toContain('ICONIQ EURO บานเลื่อน')
    expect(h).not.toMatch(/NaN|undefined/)
  })
  it('stock results: on hand and last purchase price, a pick button', () => {
    const h = clean(renderToString(
      <StockResults matches={[{ id: 'i1', code: 'HW0001', name: 'มือจับกระทุ้ง 019 สีดำ ขวา', base_unit: 'ชิ้น' }]} onHand={{ i1: 10 }}
        prices={[{ id: 'sti:1', inventory_item_id: 'i1', unit_cost: 98, effective_from: '2026-10-01', source: 'tax_invoice', doc_no: 'IV-1' }]} busy={false} onPick={noop} />,
    ))
    expect(h).toContain('มือจับกระทุ้ง 019 สีดำ ขวา')
    expect(h).toContain('คงเหลือ 10 ชิ้น · ซื้อล่าสุด 98')
    expect(h).toContain('เลือก')
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/lib/hardwareSetView.test.js src/pages/aluCatalog/HardwareSetsPanel.smoke.test.jsx`
Expected: FAIL (`Failed to resolve import "./hardwareSetView.js"`).

- [ ] **Step 3: `src/lib/hardwareSetView.js`**

```js
// src/lib/hardwareSetView.js
// The hardware set page (spec 2026-10-31 section 12): what a set holds, split into hardware (อุปกรณ์) and consumables
// (วัสดุสิ้นเปลือง); each line's price (resolveStockPartPrice: latest purchase for stock-linked parts, else catalogue);
// the set total; the stock search of a section; the series chips and the new links to insert. Pure.
import { resolveStockPartPrice } from './latestPurchasePrice.js'
import { friendlyDbError } from './catalogForm.js'

export const SECTIONS = [
  { key: 'hardware', title: 'อุปกรณ์', kind: 'hardware', addLabel: '+ เพิ่มอุปกรณ์', categories: ['อุปกรณ์'] },
  { key: 'consumable', title: 'วัสดุสิ้นเปลือง', kind: 'accessory', addLabel: '+ เพิ่มวัสดุสิ้นเปลือง', categories: ['วัสดุสิ้นเปลือง', 'ซิลิโคน/ยาง'] },
]

const byName = (a, b) => String(a.name ?? '').localeCompare(String(b.name ?? ''), 'th')
const qtyText = n => Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })

// alu_part_set_items of one set -> its lines; kind 'accessory' = consumable, anything else = hardware.
export function setLines({ setId, setItems, partsById }) {
  const out = { hardware: [], consumable: [] }
  for (const r of setItems || []) {
    if (r.set_id !== setId) continue
    const part = (partsById || {})[r.part_id]
    if (!part) continue
    out[part.kind === 'accessory' ? 'consumable' : 'hardware'].push({ id: r.id, part, quantity: Number(r.quantity) })
  }
  out.hardware.sort((a, b) => byName(a.part, b.part))
  out.consumable.sort((a, b) => byName(a.part, b.part))
  return out
}

export function setSummaryText(lines) {
  const h = lines.hardware.length
  const c = lines.consumable.length
  if (!h && !c) return 'ยังไม่ได้ใส่ของ'
  return [h ? `${h} อุปกรณ์` : null, c ? `${c} สิ้นเปลือง` : null].filter(Boolean).join(' · ')
}

export const priceLines = (lines, { asOf, purchasePrices, partPrices }) =>
  (lines || []).map(l => ({ ...l, price: resolveStockPartPrice({ partId: l.part.id, part: l.part, asOf, purchasePrices, partPrices }) }))

// Σ quantity × price; lines without a price are counted in missing (the total is then a lower bound).
export function setTotal(priced) {
  let total = 0
  let missing = 0
  for (const l of priced || []) {
    if (l.price) total += l.quantity * l.price.net_price
    else missing += 1
  }
  return { total, missing }
}

export function onHandByItem(balances) {
  const m = {}
  for (const b of balances || []) m[b.inventory_item_id] = (m[b.inventory_item_id] || 0) + (Number(b.quantity_on_hand) || 0)
  return m
}

// Active stock items of the section's categories whose name or code contains the query; by name, at most `limit`.
export function stockMatches({ items, categoryNames, query, limit = 20 }) {
  const q = String(query || '').trim().toLowerCase()
  return (items || [])
    .filter(i => i.active !== false && (categoryNames || []).includes(i.expense_categories && i.expense_categories.name))
    .filter(i => !q || String(i.name || '').toLowerCase().includes(q) || String(i.code || '').toLowerCase().includes(q))
    .sort(byName)
    .slice(0, limit)
}

// "คงเหลือ 24 ชิ้น · ซื้อล่าสุด 145" / "หมดสต๊อก · ซื้อล่าสุด 98" / "… · ยังไม่มีราคาซื้อ"
export function stockLineText({ onHand, unit, price }) {
  const n = Number(onHand) || 0
  return [n > 0 ? `คงเหลือ ${qtyText(n)} ${unit || ''}`.trim() : 'หมดสต๊อก', price ? `ซื้อล่าสุด ${qtyText(price.unit_cost)}` : 'ยังไม่มีราคาซื้อ'].join(' · ')
}

export function seriesChips({ setId, seriesParts, seriesById, providersById, typesById }) {
  return (seriesParts || []).filter(l => l.part_id === setId).map(l => {
    const s = (seriesById || {})[l.series_id]
    const p = s ? (providersById || {})[s.provider_id] : null
    const t = l.type_id ? (typesById || {})[l.type_id] : null
    return { id: l.id, provider: p ? (p.short_name || p.name) : '', label: s ? s.name : 'ซีรีส์ที่ถูกลบแล้ว', type: t ? t.name : '' }
  }).sort((a, b) => `${a.provider} ${a.label}`.localeCompare(`${b.provider} ${b.label}`, 'th'))
}

// Rows for alu_series_parts that the set does not have yet (same series and same type, NULL = every type).
export function newSeriesLinks({ setId, seriesIds, typeId, seriesParts }) {
  const t = typeId || null
  const have = new Set((seriesParts || []).filter(l => l.part_id === setId).map(l => `${l.series_id}|${l.type_id || ''}`))
  return [...new Set(seriesIds || [])].filter(id => !have.has(`${id}|${t || ''}`)).map(id => ({ series_id: id, part_id: setId, type_id: t }))
}

const RPC_TEXT = {
  bad_kind: 'ชนิดของรายการไม่ถูกต้อง', bad_quantity: 'จำนวนต้องมากกว่า 0', bad_name: 'กรอกชื่อและหน่วยของรายการใหม่',
  bad_price: 'ราคาต้องเป็นตัวเลขตั้งแต่ 0 ขึ้นไป', not_a_set: 'ไม่พบชุดอุปกรณ์นี้ (อาจถูกลบไปแล้ว)',
  item_not_found: 'ไม่พบรายการนี้ในสต๊อก หรือไม่มีสิทธิ์ดูสต๊อก',
}
export const rpcErrorText = e => (e && RPC_TEXT[e.message]) || friendlyDbError(e)

export const addResultText = (data, name) => (data && data.added === false ? `${name} มีในชุดแล้ว` : `เพิ่ม ${name} แล้ว`)
```

- [ ] **Step 4: `src/pages/aluCatalog/StockItemPicker.jsx`**

```jsx
// src/pages/aluCatalog/StockItemPicker.jsx
// "+ เพิ่ม" of a hardware-set section: search the stock items of the section's categories (on hand + latest purchase
// price), pick one, or create a part that is not in stock (name, unit, optional price). Never writes by itself:
// onPick(item) / onCreate({ name, unit, price }) belong to the page.
import { useState, useMemo } from 'react'
import { supabase } from '../../lib/supabase.js'
import { useQuery } from '../../hooks/useSupabase.js'
import { fetchAllRows } from '../../lib/fetchAllRows.js'
import { stockMatches, onHandByItem, stockLineText } from '../../lib/hardwareSetView.js'
import { latestPurchasePrice } from '../../lib/latestPurchasePrice.js'

export function StockResults({ matches, onHand, prices, busy, onPick }) {
  return (
    <div style={{ display: 'grid', gap: 4 }}>
      {matches.map(i => (
        <div key={i.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 6 }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div><span className="font-mono" style={{ color: 'var(--text3)' }}>{i.code}</span> {i.name}</div>
            <div style={{ fontSize: 12, color: 'var(--text3)' }}>{stockLineText({ onHand: (onHand || {})[i.id], unit: i.base_unit, price: latestPurchasePrice(prices, i.id) })}</div>
          </div>
          <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => onPick(i)}>เลือก</button>
        </div>
      ))}
    </div>
  )
}

export default function StockItemPicker({ section, busy, onPick, onCreate, onClose }) {
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState({ name: '', unit: '', price: '' })
  const [formError, setFormError] = useState(null)
  const stock = useQuery(async () => {
    const [items, balances] = await Promise.all([
      fetchAllRows(() => supabase.from('inventory_items').select('id, code, name, base_unit, active, category_id, expense_categories(name)').eq('active', true).order('name').order('id')),
      fetchAllRows(() => supabase.from('inventory_stock_balances').select('id, inventory_item_id, quantity_on_hand').order('id')),
    ])
    return { items, onHand: onHandByItem(balances) }
  }, [])
  const matches = useMemo(() => stockMatches({ items: stock.data && stock.data.items, categoryNames: section.categories, query }), [stock.data, section, query])
  const ids = matches.map(m => m.id)
  const prices = useQuery(async () => {
    if (!ids.length) return []
    const { data, error } = await supabase.rpc('stock_item_purchase_prices', { p_item_ids: ids })
    if (error) throw error
    return data || []
  }, [ids.join(',')])

  const create = () => {
    const price = String(draft.price).trim()
    if (!draft.name.trim() || !draft.unit.trim()) { setFormError('กรอกชื่อและหน่วย'); return }
    if (price !== '' && !(Number(price) >= 0)) { setFormError('ราคาต้องเป็นตัวเลขตั้งแต่ 0 ขึ้นไป'); return }
    setFormError(null)
    onCreate({ name: draft.name.trim(), unit: draft.unit.trim(), price: price === '' ? null : Number(price) })
  }

  return (
    <div className="card" style={{ padding: 12, display: 'grid', gap: 8, background: 'var(--bg3)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ fontWeight: 600, fontSize: 13 }}>จากสต๊อก (คลังสินค้า หมวด{section.categories.join(' / ')})</div>
        <button type="button" className="btn btn-sm btn-ghost" style={{ marginLeft: 'auto' }} onClick={onClose}>ปิด</button>
      </div>
      <input className="input" autoFocus placeholder="พิมพ์ชื่อหรือรหัสสินค้า" value={query} onChange={e => setQuery(e.target.value)} />
      {stock.error && <div style={{ color: 'var(--red)', fontSize: 13 }}>โหลดสต๊อกไม่สำเร็จ: {stock.error}</div>}
      {!stock.data && !stock.error && <div style={{ fontSize: 13, color: 'var(--text3)' }}>กำลังโหลดสต๊อก...</div>}
      {stock.data && <StockResults matches={matches} onHand={stock.data.onHand} prices={prices.data || []} busy={busy} onPick={onPick} />}
      {stock.data && !matches.length && <div style={{ fontSize: 13, color: 'var(--text3)' }}>ไม่พบในสต๊อก</div>}
      {!creating
        ? <button type="button" className="btn btn-sm btn-ghost" style={{ justifySelf: 'start' }} onClick={() => { setCreating(true); setDraft(d => ({ ...d, name: d.name || query.trim() })) }}>+ สร้างรายการใหม่ (ยังไม่มีในสต๊อก)</button>
        : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8, alignItems: 'end' }}>
            <div><label className="label">ชื่อ</label><input className="input" value={draft.name} onChange={e => setDraft(d => ({ ...d, name: e.target.value }))} /></div>
            <div><label className="label">หน่วย</label><input className="input" value={draft.unit} placeholder="เช่น ชิ้น" onChange={e => setDraft(d => ({ ...d, unit: e.target.value }))} /></div>
            <div><label className="label">ราคา/หน่วย (ไม่บังคับ)</label><input className="input" type="number" min="0" step="any" value={draft.price} onChange={e => setDraft(d => ({ ...d, price: e.target.value }))} /></div>
            <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={create}>สร้างและเพิ่มเข้าชุด</button>
            {formError && <div style={{ gridColumn: '1 / -1', color: 'var(--red)', fontSize: 13 }}>{formError}</div>}
          </div>
        )}
    </div>
  )
}
```

- [ ] **Step 5: `src/pages/aluCatalog/SeriesLinkPicker.jsx`**

```jsx
// src/pages/aluCatalog/SeriesLinkPicker.jsx
// "+ เพิ่มซีรีส์" of a hardware set: extruder → ซีรีส์หลัก → tick its series, optional type → onAdd(seriesIds, typeId).
// Same alu_series_parts rows as the series side ("ชุดอุปกรณ์ที่ซีรีส์นี้ใช้"); the page does the insert.
import { useState } from 'react'
import { familyChoices, familySeries } from '../../lib/seriesFamily.js'

const byName = (a, b) => String(a.name ?? '').localeCompare(String(b.name ?? ''), 'th')

export default function SeriesLinkPicker({ index, typeOptions, busy, onAdd, onClose }) {
  const [providerId, setProviderId] = useState('')
  const [key, setKey] = useState('')
  const [picked, setPicked] = useState([])
  const [typeId, setTypeId] = useState('')
  const providers = Object.values(index.providers).filter(p => p.active !== false).sort(byName)
  const list = key ? familySeries(index, providerId, key) : []
  const toggle = id => setPicked(p => (p.includes(id) ? p.filter(x => x !== id) : [...p, id]))
  return (
    <div className="card" style={{ padding: 12, display: 'grid', gap: 8, background: 'var(--bg3)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 8 }}>
        <select className="input" value={providerId} onChange={e => { setProviderId(e.target.value); setKey(''); setPicked([]) }}>
          <option value="">— โรงรีด —</option>
          {providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select className="input" disabled={!providerId} value={key} onChange={e => { setKey(e.target.value); setPicked([]) }}>
          <option value="">— ซีรีส์หลัก —</option>
          {(providerId ? familyChoices(index, providerId) : []).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select className="input" value={typeId} onChange={e => setTypeId(e.target.value)}>
          <option value="">ประเภท: ทุกประเภท (ไม่บังคับ)</option>
          {(typeOptions || []).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>
      {list.map(s => (
        <label key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
          <input type="checkbox" checked={picked.includes(s.id)} onChange={() => toggle(s.id)} /> {s.name}
        </label>
      ))}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button type="button" className="btn btn-sm btn-ghost" onClick={onClose}>ยกเลิก</button>
        <button type="button" className="btn btn-sm btn-primary" disabled={busy || !picked.length} onClick={() => onAdd(picked, typeId || null)}>เพิ่ม {picked.length} ชุด</button>
      </div>
    </div>
  )
}
```

- [ ] **Step 6: `src/pages/aluCatalog/HardwareSetsPanel.jsx`**

```jsx
// src/pages/aluCatalog/HardwareSetsPanel.jsx
// ชุดอุปกรณ์ (spec 2026-10-31 section 12, mockup hwset.html v2). Left: the sets (search, "+ ชุดใหม่"). Right: the chosen
// set: 1 อุปกรณ์, 2 วัสดุสิ้นเปลือง (each from stock or created new), 3 ใช้กับซีรีส์. A set has no unit (saved as 'ชุด').
// Prices: latest purchase price for stock-linked parts, else the catalogue price; the set total = Σ quantity × price.
// Errors show inline (InlineError), never in a browser dialog.
import { useState, useMemo } from 'react'
import { supabase } from '../../lib/supabase.js'
import { useQuery } from '../../hooks/useSupabase.js'
import { useCatalogTable } from '../../hooks/useAluCatalog.js'
import { Modal } from '../../components/Modal.jsx'
import { CrudForm } from '../../components/CatalogCrud.jsx'
import InlineError from '../estimation/InlineError.jsx'
import { emptyForm, formFromRow, buildPayload, missingRequired, optionList } from '../../lib/catalogForm.js'
import { buildCatalogIndex } from '../../lib/aluCatalogPricing.js'
import { typePickerOptions } from '../../lib/catalogTypeForm.js'
import { localDateString } from '../../lib/localDate.js'
import { priceSourceText } from '../../lib/latestPurchasePrice.js'
import { SECTIONS, setLines, setSummaryText, priceLines, setTotal, seriesChips, newSeriesLinks, rpcErrorText, addResultText } from '../../lib/hardwareSetView.js'
import StockItemPicker from './StockItemPicker.jsx'
import SeriesLinkPicker from './SeriesLinkPicker.jsx'

const money = n => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const byName = (a, b) => String(a.name ?? '').localeCompare(String(b.name ?? ''), 'th')

export const setFields = providers => [
  { key: 'name', label: 'ชื่อชุด', type: 'text', required: true, placeholder: 'เช่น อุปกรณ์หน้าต่างบานเลื่อนสวน' },
  { key: 'provider_id', label: 'ผู้ผลิต (ไม่บังคับ)', type: 'select', options: form => optionList(providers, p => p.name, form.provider_id) },
  { key: 'active', label: 'ใช้งานอยู่', type: 'checkbox', default: true },
]

// The chosen set (pure view). lines = { hardware, consumable } priced lines; pickerFor(sectionKey) -> node | null.
export function SetDetail({ set, lines, total, chips, canEdit, pickerFor, seriesPicker, on }) {
  return (
    <div className="card" style={{ padding: 16, display: 'grid', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 16 }}>{set.name}</div>
          <div style={{ fontSize: 12, color: 'var(--text3)' }}>
            {set.code} · {set.active === false ? 'ปิดใช้งาน' : 'ใช้งานอยู่'} · ราคาชุด = รวมราคาของในชุด {money(total.total)} บาท{total.missing ? ` (ยังไม่มีราคา ${total.missing} รายการ)` : ''}
          </div>
        </div>
        {canEdit && (
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <button type="button" className="btn btn-sm btn-ghost" onClick={on.edit}>แก้ชื่อ</button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={on.toggleActive}>{set.active === false ? 'เปิดใช้งาน' : 'ปิดใช้งาน'}</button>
          </div>
        )}
      </div>

      {SECTIONS.map((s, i) => (
        <section key={s.key} style={{ display: 'grid', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ fontWeight: 600 }}>{i + 1}. {s.title}</div>
            {canEdit && <button type="button" className="btn btn-sm btn-ghost" style={{ marginLeft: 'auto' }} onClick={() => on.add(s.key)}>{s.addLabel}</button>}
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>รายการ</th><th>จำนวน</th><th>ราคา/หน่วย</th><th>ที่มาของราคา</th><th /></tr></thead>
              <tbody>
                {lines[s.key].map(l => (
                  <tr key={l.id}>
                    <td><span className="font-mono" style={{ color: 'var(--text3)' }}>{l.part.code}</span> {l.part.name} <span style={{ color: 'var(--text3)' }}>({l.part.unit})</span></td>
                    <td style={{ width: 96 }}>{canEdit
                      ? <input key={`${l.id}-${l.quantity}`} className="input" type="number" min="0" step="any" defaultValue={l.quantity} onBlur={e => on.quantity(l, e.target.value)} aria-label={`จำนวน ${l.part.name}`} />
                      : l.quantity}</td>
                    <td className="font-mono">{l.price ? money(l.price.net_price) : '—'}</td>
                    <td style={{ fontSize: 12, color: 'var(--text3)' }}>{priceSourceText(l.price)}</td>
                    <td>{canEdit && <button type="button" className="btn btn-sm btn-ghost" style={{ color: 'var(--red)' }} aria-label={`เอา ${l.part.name} ออก`} onClick={() => on.removeLine(l)}>✕</button>}</td>
                  </tr>
                ))}
                {!lines[s.key].length && <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--text3)', padding: 12 }}>ยังไม่มี{s.title}ในชุดนี้</td></tr>}
              </tbody>
            </table>
          </div>
          {pickerFor(s.key)}
        </section>
      ))}

      <section style={{ display: 'grid', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ fontWeight: 600 }}>3. ใช้กับซีรีส์</div>
          {canEdit && <button type="button" className="btn btn-sm btn-ghost" style={{ marginLeft: 'auto' }} onClick={on.addSeries}>+ เพิ่มซีรีส์</button>}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {chips.map(c => (
            <span key={c.id} className="badge" style={{ padding: '3px 8px', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <span style={{ color: 'var(--text3)' }}>{c.provider}</span><span>{c.label}{c.type ? ` · ${c.type}` : ''}</span>
              {canEdit && <button type="button" className="btn btn-sm btn-ghost" style={{ padding: '0 4px' }} aria-label={`เลิกผูก ${c.label}`} onClick={() => on.removeChip(c)}>✕</button>}
            </span>
          ))}
          {!chips.length && <span style={{ fontSize: 12, color: 'var(--text3)' }}>ยังไม่ผูกซีรีส์ = ใช้ได้ทุกซีรีส์</span>}
        </div>
        {seriesPicker}
        <div style={{ fontSize: 12, color: 'var(--text3)' }}>ตอนเลือกชุดอุปกรณ์ในรายการ จะเห็นชุดที่ผูกกับซีรีส์ของรายการนั้นก่อน (ไม่ผูกเลย = ใช้ได้ทุกซีรีส์)</div>
      </section>
    </div>
  )
}

export default function HardwareSetsPanel({ canEdit }) {
  const parts = useCatalogTable('alu_parts')
  const setItems = useCatalogTable('alu_part_set_items', 'id')
  const partPrices = useCatalogTable('alu_part_prices', 'id')
  const providers = useCatalogTable('alu_providers')
  const series = useCatalogTable('alu_series')
  const families = useCatalogTable('alu_series_families')
  const types = useCatalogTable('door_window_types')
  const seriesTypes = useCatalogTable('alu_series_types', 'id')
  const seriesParts = useCatalogTable('alu_series_parts', 'id')
  const [setId, setSetId] = useState('')
  const [search, setSearch] = useState('')
  const [picking, setPicking] = useState(null)      // section key | null
  const [seriesOpen, setSeriesOpen] = useState(false)
  const [editing, setEditing] = useState(null)      // null | 'new' | set row
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [note, setNote] = useState(null)

  const linkedIds = useMemo(() => [...new Set((parts.data || []).map(p => p.inventory_item_id).filter(Boolean))].sort(), [parts.data])
  const purchase = useQuery(async () => {
    if (!linkedIds.length) return []
    const { data, error } = await supabase.rpc('stock_item_purchase_prices', { p_item_ids: linkedIds })
    if (error) throw error
    return data || []
  }, [linkedIds.join(',')])
  const index = useMemo(() => buildCatalogIndex({
    providers: providers.data, series: series.data, seriesFamilies: families.data, types: types.data, seriesTypes: seriesTypes.data,
  }), [providers.data, series.data, families.data, types.data, seriesTypes.data])

  const loadError = [parts, setItems, partPrices, providers, series, families, types, seriesTypes, seriesParts].map(q => q.error).find(Boolean)
  if (loadError) return <InlineError title="โหลดข้อมูลไม่สำเร็จ">{loadError}</InlineError>

  const today = localDateString(new Date())
  const partsById = Object.fromEntries((parts.data || []).map(p => [p.id, p]))
  const sets = (parts.data || []).filter(p => p.kind === 'hardware_set').sort(byName)
  const q = search.trim().toLowerCase()
  const shownSets = sets.filter(s => !q || String(s.name).toLowerCase().includes(q) || String(s.code || '').toLowerCase().includes(q))
  const set = sets.find(s => s.id === setId) || null
  const priceCtx = { asOf: today, purchasePrices: purchase.data || [], partPrices: partPrices.data || [] }
  const raw = set ? setLines({ setId: set.id, setItems: setItems.data, partsById }) : null
  const lines = raw ? { hardware: priceLines(raw.hardware, priceCtx), consumable: priceLines(raw.consumable, priceCtx) } : null
  const total = lines ? setTotal([...lines.hardware, ...lines.consumable]) : null
  const chips = set ? seriesChips({ setId: set.id, seriesParts: seriesParts.data, seriesById: index.series, providersById: index.providers, typesById: index.types }) : []
  const typeOptions = typePickerOptions(types.data || [], new Set((types.data || []).map(t => t.id))).map(o => ({ value: o.id, label: o.label }))
  const fields = setFields(providers.data)

  const run = async (work, after) => {
    setBusy(true); setErr(null); setNote(null)
    try {
      const r = await work()
      if (after) await after(r)
    } catch (e) { setErr(rpcErrorText(e)) }
    finally { setBusy(false) }
  }
  const saveSet = form => {
    const missing = missingRequired(fields, form)
    if (missing.length) { setErr('กรุณากรอก: ' + missing.join(', ')); return }
    const payload = buildPayload(fields, form, editing === 'new' ? null : editing)
    run(async () => {
      if (editing === 'new') {
        const { data, error } = await supabase.from('alu_parts').insert({ ...payload, kind: 'hardware_set', unit: 'ชุด' }).select('id').single()
        if (error) throw error
        return data.id
      }
      const { error } = await supabase.from('alu_parts').update(payload).eq('id', editing.id)
      if (error) throw error
      return editing.id
    }, async id => { setEditing(null); await parts.refetch(); setSetId(id) })
  }
  const kindOf = key => SECTIONS.find(s => s.key === key).kind
  const on = {
    edit: () => setEditing(set),
    toggleActive: () => run(async () => {
      const { error } = await supabase.from('alu_parts').update({ active: set.active === false }).eq('id', set.id)
      if (error) throw error
    }, () => parts.refetch()),
    add: key => { setSeriesOpen(false); setPicking(p => (p === key ? null : key)) },
    quantity: (line, value) => {
      const n = Number(value)
      if (String(value).trim() === '' || !(n > 0)) { setErr('จำนวนต้องมากกว่า 0'); setItems.refetch(); return }
      if (n === line.quantity) return
      run(async () => {
        const { error } = await supabase.from('alu_part_set_items').update({ quantity: n }).eq('id', line.id)
        if (error) throw error
      }, () => setItems.refetch())
    },
    removeLine: line => run(async () => {
      const { error } = await supabase.from('alu_part_set_items').delete().eq('id', line.id)
      if (error) throw error
    }, () => setItems.refetch()),
    addSeries: () => { setPicking(null); setSeriesOpen(o => !o) },
    removeChip: chip => run(async () => {
      const { error } = await supabase.from('alu_series_parts').delete().eq('id', chip.id)
      if (error) throw error
    }, () => seriesParts.refetch()),
  }
  const addFromStock = (key, item) => run(async () => {
    const { data, error } = await supabase.rpc('alu_add_stock_item_to_set', { p_set_id: set.id, p_inventory_item_id: item.id, p_kind: kindOf(key), p_quantity: 1 })
    if (error) throw error
    return data
  }, async data => { await Promise.all([parts.refetch(), setItems.refetch()]); setNote(addResultText(data, item.name)) })
  const addNew = (key, f) => run(async () => {
    const { error } = await supabase.rpc('alu_add_new_part_to_set', {
      p_set_id: set.id, p_name: f.name, p_unit: f.unit, p_kind: kindOf(key), p_quantity: 1, p_price: f.price, p_price_date: f.price === null ? null : today,
    })
    if (error) throw error
  }, async () => { setPicking(null); await Promise.all([parts.refetch(), setItems.refetch(), partPrices.refetch()]); setNote(`เพิ่ม ${f.name} แล้ว`) })
  const addSeriesLinks = (seriesIds, typeId) => {
    const rows = newSeriesLinks({ setId: set.id, seriesIds, typeId, seriesParts: seriesParts.data })
    if (!rows.length) { setNote('ซีรีส์ที่เลือกผูกกับชุดนี้อยู่แล้ว'); return }
    run(async () => {
      const { error } = await supabase.from('alu_series_parts').insert(rows)
      if (error) throw error
    }, async () => { setSeriesOpen(false); await seriesParts.refetch(); setNote(`เพิ่ม ${rows.length} ชุดแล้ว`) })
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16, alignItems: 'start' }}>
      <div className="card" style={{ padding: 12, display: 'grid', gap: 8, alignContent: 'start' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ fontWeight: 700 }}>ชุดอุปกรณ์</div>
          {canEdit && <button type="button" className="btn btn-sm btn-primary" style={{ marginLeft: 'auto' }} onClick={() => setEditing('new')}>+ ชุดใหม่</button>}
        </div>
        <input className="input" placeholder="ค้นหาชุด" value={search} onChange={e => setSearch(e.target.value)} />
        {shownSets.map(s => (
          <button key={s.id} type="button" className={`btn btn-sm ${s.id === setId ? 'btn-primary' : 'btn-ghost'}`}
            style={{ display: 'grid', justifyItems: 'start', textAlign: 'left' }}
            onClick={() => { setSetId(s.id); setPicking(null); setSeriesOpen(false); setErr(null); setNote(null) }}>
            <span>{s.name}{s.active === false ? ' (ปิดใช้งาน)' : ''}</span>
            <span style={{ fontSize: 11, opacity: 0.75 }}>{s.code} · {setSummaryText(setLines({ setId: s.id, setItems: setItems.data, partsById }))}</span>
          </button>
        ))}
        {!shownSets.length && <div style={{ fontSize: 13, color: 'var(--text3)', padding: 8 }}>{parts.data == null ? 'กำลังโหลด...' : 'ยังไม่มีชุดอุปกรณ์'}</div>}
      </div>

      <div style={{ display: 'grid', gap: 8, minWidth: 0 }}>
        {err && <InlineError onClose={() => setErr(null)}>{err}</InlineError>}
        {note && <div style={{ fontSize: 13, color: 'var(--green)' }}>{note}</div>}
        {set ? (
          <SetDetail set={set} lines={lines} total={total} chips={chips} canEdit={canEdit} on={on}
            pickerFor={key => (picking === key ? (
              <StockItemPicker section={SECTIONS.find(s => s.key === key)} busy={busy}
                onPick={item => addFromStock(key, item)} onCreate={f => addNew(key, f)} onClose={() => setPicking(null)} />
            ) : null)}
            seriesPicker={seriesOpen ? <SeriesLinkPicker index={index} typeOptions={typeOptions} busy={busy} onAdd={addSeriesLinks} onClose={() => setSeriesOpen(false)} /> : null} />
        ) : (
          <div className="card" style={{ padding: 24, textAlign: 'center', color: 'var(--text3)' }}>เลือกชุดทางซ้าย หรือกด "+ ชุดใหม่"</div>
        )}
      </div>

      {editing && (
        <Modal title={editing === 'new' ? 'ชุดอุปกรณ์ใหม่' : 'แก้ชุดอุปกรณ์'} onClose={() => setEditing(null)} maxWidth={440}>
          <CrudForm fields={fields} row={editing === 'new' ? null : editing} loading={busy} onSave={saveSet} onCancel={() => setEditing(null)}
            initial={editing === 'new' ? emptyForm(fields) : formFromRow(fields, editing)} />
        </Modal>
      )}
    </div>
  )
}
```

- [ ] **Step 7: `PartsTab.jsx`**

Replace the whole file with the version below. Changes against the current file: `accessory` is labelled "วัสดุสิ้นเปลือง" (owner: "อะไหล่/อุปกรณ์เสริม" → "วัสดุสิ้นเปลือง"); a two-button switch opens the new set page; hardware sets leave the general list and its kind options; the old "เลือกชุดอุปกรณ์เพื่อกำหนดสิ่งที่อยู่ในชุด" select + LinkEditor and the now-unused `alu_part_set_items` load are gone (the new page replaces them). The series LinkEditor ("อุปกรณ์/ชุดอุปกรณ์ที่ซีรีส์นี้ใช้") stays: it edits the same `alu_series_parts` rows as section 3.

```jsx
// src/pages/aluCatalog/PartsTab.jsx
// Hardware and consumables (rubber, silicone, screws ...), which series (optionally which type) uses which part, and
// the hardware set page (HardwareSetsPanel: what each set holds, from stock, and its series).
import { useState } from 'react'
import { useCatalogTable } from '../../hooks/useAluCatalog.js'
import CatalogCrud, { ActiveBadge } from '../../components/CatalogCrud.jsx'
import LinkEditor from '../../components/LinkEditor.jsx'
import { optionList } from '../../lib/catalogForm.js'
import { typePickerOptions } from '../../lib/catalogTypeForm.js'
import { seriesLabelFull } from '../../lib/aluCatalog.js'
import HardwareSetsPanel from './HardwareSetsPanel.jsx'

const KIND_LABEL = { hardware: 'อุปกรณ์', hardware_set: 'ชุดอุปกรณ์', accessory: 'วัสดุสิ้นเปลือง' }
// sets are managed on their own page (no unit, contents from stock), so the general list offers the other two kinds
const SINGLE_KINDS = Object.entries(KIND_LABEL).filter(([v]) => v !== 'hardware_set')

// management selectors list every row, inactive ones tagged, so nothing becomes unreachable
const withInactiveTag = (rows, labelFn) => (rows || []).map(r => ({ value: r.id, label: labelFn(r) + (r.active === false ? ' (ปิดใช้งาน)' : '') }))

export default function PartsTab({ canEdit }) {
  const [view, setView] = useState('parts')   // 'parts' | 'sets'
  const providers = useCatalogTable('alu_providers')
  const parts = useCatalogTable('alu_parts')
  const series = useCatalogTable('alu_series')
  const types = useCatalogTable('door_window_types')
  const seriesParts = useCatalogTable('alu_series_parts', 'id')
  const [seriesId, setSeriesId] = useState('')
  const [kindFilter, setKindFilter] = useState('')

  const switcher = (
    <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
      <button type="button" className={`btn btn-sm ${view === 'parts' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setView('parts')}>อุปกรณ์ · วัสดุสิ้นเปลือง</button>
      <button type="button" className={`btn btn-sm ${view === 'sets' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setView('sets')}>ชุดอุปกรณ์</button>
    </div>
  )
  if (view === 'sets') return <div>{switcher}<HardwareSetsPanel canEdit={canEdit} /></div>

  const error = providers.error || parts.error || series.error || types.error || seriesParts.error
  if (error) return <div>{switcher}<div style={{ color: 'var(--red)' }}>โหลดข้อมูลไม่สำเร็จ: {error}</div></div>

  const providerById = Object.fromEntries((providers.data || []).map(p => [p.id, p]))
  // a selection whose row vanished must not linger
  if (seriesId && series.data && !series.data.some(s => s.id === seriesId)) setSeriesId('')
  const linkedToSeries = new Set((seriesParts.data || []).filter(l => l.series_id === seriesId).map(l => l.part_id))
  const seriesPartChoices = (parts.data || []).filter(p => p.active !== false || linkedToSeries.has(p.id))
  const shownParts = (parts.data || []).filter(p => p.kind !== 'hardware_set' && (!kindFilter || p.kind === kindFilter))
  // tree order, full path labels; inactive types stay listed so existing links remain editable
  const typeOptions = typePickerOptions(types.data || [], new Set((types.data || []).map(t => t.id))).map(o => ({ value: o.id, label: o.label }))
  const partLabel = p => (p.code ? `${p.code} · ${p.name}` : p.name)
  const inactiveTag = p => (p.active === false ? ' (ปิดใช้งาน)' : '')

  const PART_FIELDS = [
    { key: 'name', label: 'ชื่อ', type: 'text', required: true },
    { key: 'kind', label: 'ชนิด', type: 'select', required: true, default: 'hardware',
      options: SINGLE_KINDS.map(([value, label]) => ({ value, label })) },
    { key: 'unit', label: 'หน่วย', type: 'text', required: true, default: 'ชิ้น' },
    { key: 'provider_id', label: 'โรงรีด/ผู้ผลิต (ไม่บังคับ)', type: 'select', options: form => optionList(providers.data, p => p.name, form.provider_id) },
    { key: 'active', label: 'ใช้งานอยู่', type: 'checkbox', default: true },
  ]

  return (
    <div>
      {switcher}
      <div style={{ marginBottom: 12 }}>
        <label className="label">แสดงเฉพาะชนิด</label>
        <select className="input" style={{ maxWidth: 240 }} value={kindFilter} onChange={e => setKindFilter(e.target.value)}>
          <option value="">ทั้งหมด</option>
          {SINGLE_KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </div>
      <CatalogCrud
        title="🔩 ชิ้นส่วนอื่น · อุปกรณ์ / วัสดุสิ้นเปลือง" table="alu_parts" fields={PART_FIELDS} rows={shownParts}
        onChanged={parts.refetch} canEdit={canEdit} addLabel="+ เพิ่มรายการ" emptyText={(parts.data || []).length && kindFilter ? 'ไม่มีรายการในชนิดนี้' : 'ยังไม่มีอุปกรณ์'}
        deleteWarning='ลบไม่ได้ถ้ารายการนี้อยู่ในชุดอุปกรณ์ใด ต้องเอาออกจากชุดก่อน (ลบได้แล้วจะลบการผูกกับซีรีส์และราคาทั้งหมดของรายการนี้ด้วย) ถ้าแค่เลิกใช้ ให้ปิด "ใช้งานอยู่" แทน'
        columns={[
          { key: 'code', label: 'รหัส', render: r => <span style={{ fontFamily: 'monospace' }}>{r.code}</span> },
          { key: 'name', label: 'ชื่อ', render: r => <strong>{r.name}</strong> },
          { key: 'kind', label: 'ชนิด', render: r => KIND_LABEL[r.kind] },
          { key: 'unit', label: 'หน่วย' },
          { key: 'provider_id', label: 'ผู้ผลิต', render: r => providerById[r.provider_id]?.name || '—' },
          { key: 'active', label: 'สถานะ', render: r => <ActiveBadge active={r.active} /> },
        ]}
      />

      <div style={{ margin: '16px 0 12px' }}>
        <label className="label">เลือกซีรีส์เพื่อกำหนดอุปกรณ์ที่ใช้</label>
        <select className="input" style={{ maxWidth: 380 }} value={seriesId} onChange={e => setSeriesId(e.target.value)}>
          <option value="">— เลือกซีรีส์ —</option>
          {withInactiveTag(series.data, s => seriesLabelFull(s, providerById[s.provider_id])).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>
      {seriesId && (
        <LinkEditor
          title="อุปกรณ์/ชุดอุปกรณ์ที่ซีรีส์นี้ใช้" hint="เลือกประเภทบานเพื่อจำกัดให้ใช้กับประเภทนั้นเท่านั้น เว้นว่างคือใช้กับทุกประเภท (ชุดอุปกรณ์ 'ใช้กับชุด') · ถ้าเลือกประเภทที่มีประเภทย่อย จะใช้กับประเภทย่อยทั้งหมดของประเภทนี้ · ผูกจากหน้าชุดอุปกรณ์ได้ด้วย (ข้อมูลเดียวกัน)"
          linkTable="alu_series_parts" parentKey="series_id" parentId={seriesId} childKey="part_id"
          childOptions={seriesPartChoices.map(p => ({ id: p.id, label: `${partLabel(p)} · ${KIND_LABEL[p.kind]}${inactiveTag(p)}` }))}
          links={seriesParts.data} onChanged={seriesParts.refetch} canEdit={canEdit}
          extra={{ key: 'type_id', label: 'ประเภท', type: 'select', emptyLabel: 'ทุกประเภท', options: typeOptions }}
        />
      )}
    </div>
  )
}
```

Afterwards `grep -rn "อะไหล่/อุปกรณ์เสริม" /Users/plfx/code/FacadeXPM/facadex-app/.claude/worktrees/series-family/src` must print nothing.

Add the three new files to `FILES` in `src/pages/estimation/noBrowserDialogs.test.js`:

```js
const FILES = ['CutModeField.jsx', 'CustomLengthSummary.jsx', 'BomProfilesTable.jsx', 'CutOptimizerPanel.jsx', 'StickerSheet.jsx', 'OffcutStockPanel.jsx', 'ProjectBomView.jsx', 'CutSheetView.jsx', 'TemplateCardGrid.jsx', 'templateCards.js',
  'ProjectDefaultsPanel.jsx', 'ProviderCompare.jsx', '../aluCatalog/HardwareSetsPanel.jsx', '../aluCatalog/StockItemPicker.jsx', '../aluCatalog/SeriesLinkPicker.jsx']
```

(`ProjectDefaultsPanel.jsx` and `ProviderCompare.jsx` were added in Tasks 5 and 7; keep them.)

- [ ] **Step 8: Run the tests**

Run: `npx vitest run src/lib/hardwareSetView.test.js src/pages/aluCatalog/HardwareSetsPanel.smoke.test.jsx src/pages/estimation/noBrowserDialogs.test.js`
Expected: PASS.
Run: `npx vitest run` → Expected: all green.
Run: `npm run build` from the worktree → Expected: builds without errors (catches a wrong import in the panel files, which only the smoke test partly covers).

- [ ] **Step 9: Commit**

```bash
cd /Users/plfx/code/FacadeXPM/facadex-app/.claude/worktrees/series-family
git add src/lib/hardwareSetView.js src/lib/hardwareSetView.test.js src/pages/aluCatalog/HardwareSetsPanel.jsx src/pages/aluCatalog/StockItemPicker.jsx src/pages/aluCatalog/SeriesLinkPicker.jsx src/pages/aluCatalog/HardwareSetsPanel.smoke.test.jsx src/pages/aluCatalog/PartsTab.jsx src/pages/estimation/noBrowserDialogs.test.js
git commit -F - <<'MSG'
feat(catalog): hardware set page — no unit, hardware + consumables from stock, series links

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SKarDAHEncS9RZ6zCSPXc1
MSG
```

---
### Task 12: Release 1.36.0 — version, changelog, manual; final checks

**Files:**
- Modify: `package.json` (`"version": "1.36.0"`), `package-lock.json` (lines 3 and 9: `"version": "1.36.0"`)
- Modify: `src/changelog.json` (new first entry)
- Modify: `public/manual/index.html` (estimation section, around line 954)

**Interfaces:**
- Consumes: everything above (no code change in this task).
- Produces: release metadata only. No deploy (the controller deploys after the migrations are applied — the app reads `alu_series_families` on load, so migration 01 must be live before this build goes out).

- [ ] **Step 1: Version**

```bash
cd /Users/plfx/code/FacadeXPM/facadex-app/.claude/worktrees/series-family
sed -i '' 's/"version": "1.35.2"/"version": "1.36.0"/' package.json
sed -i '' '3s/"version": "1.35.2"/"version": "1.36.0"/; 9s/"version": "1.35.2"/"version": "1.36.0"/' package-lock.json
grep -n '"version"' package.json package-lock.json | head -3
```

Expected: three lines, all `1.36.0`. (If `main` moved past 1.35.2 meanwhile, the controller re-bumps above the live version before deploying.)

- [ ] **Step 2: Changelog**

Insert as the first element of the array in `src/changelog.json`:

```json
  {
    "version": "1.36.0",
    "date": "2026-10-31",
    "notes": [
      "ค่าเริ่มต้นโปรเจกต์เลือกแค่ ซีรีส์หลัก (เช่น ICONIQ EURO) แต่ละรายการได้ชุดที่ตรงประเภทบานเอง (บานเลื่อน บานเปิด บานติดตาย) และยังเปลี่ยนชุดในรายการได้",
      "การ์ดค่าเริ่มต้นของโปรเจกต์ บันทึกแล้วย่อเหลือป้ายสรุป (โรงรีด ซีรีส์หลัก สี อุดช่อง กำไร วันที่ราคา) กด แก้ไข เพื่อกาง",
      "แคตตาล็อก แท็บโรงรีด · ซีรีส์: จัดซีรีส์เข้าซีรีส์หลัก และตั้งความหนาที่ให้เลือกได้ (STANDARD 1.0 / 1.2 / 1.5 / 1.8 / 2.0 มม.)",
      "ชุดอุปกรณ์หน้าใหม่: ไม่มีหน่วย แยกอุปกรณ์กับวัสดุสิ้นเปลือง เลือกของจากสต๊อก ราคาตามราคาซื้อล่าสุด (ใบกำกับภาษีซื้อ แล้วใบสั่งซื้อ) และผูกซีรีส์ได้ในหน้าเดียว",
      "เทียบราคาโรงรีด: เลือกเป็นซีรีส์หลักของแต่ละโรงรีด"
    ]
  },
```

Run: `node -e "JSON.parse(require('fs').readFileSync('src/changelog.json','utf8'))" && echo ok` → Expected: `ok`.

- [ ] **Step 3: Manual**

In `public/manual/index.html`, in the `<li><b>แคตตาล็อกโรงรีด</b> …` line (estimation section, ~line 954) replace `เลือกโรงรีด/ซีรีส์/ความหนา/สีเป็นค่าเริ่มต้นของโปรเจกต์ได้` with `เลือกโรงรีด/ซีรีส์หลัก/ความหนา/สีเป็นค่าเริ่มต้นของโปรเจกต์ได้`. Then, directly after the `</ul>` that closes the "ใบตัดอลูมิเนียม สติกเกอร์ และสต็อกเศษ (1.35.0)" list and before the amber `🚧` callout, insert:

```html
        <h4 style="margin-top:18px;">ซีรีส์หลักและชุดอุปกรณ์ (1.36.0)</h4>
        <ul class="features">
          <li><b>ซีรีส์หลัก</b> — ค่าเริ่มต้นของโปรเจกต์เลือกแค่ซีรีส์หลัก เช่น ICONIQ EURO ไม่ต้องเลือกถึงประเภทช่องเปิด · แต่ละรายการได้ชุดที่ทำประเภทนั้นเอง (บานเลื่อนได้ "ICONIQ EURO บานเลื่อน" บานเปิดได้ "ICONIQ EURO บานเปิด / บานกระทุ้ง") · ช่องซีรีส์ในรายการว่าง = "ตามโปรเจกต์ (ชื่อชุดที่ได้)" เลือกชุดอื่นเองได้</li>
          <li>ซีรีส์หลักมีหลายชุดสำหรับประเภทเดียว (เช่น HOMELIFE บานเลื่อน) ระบบใช้ชุดแรกตามชื่อ และบอกในรายการว่ามีให้เลือกกี่ชุด · ซีรีส์หลักไม่มีชุดสำหรับประเภทนั้น ระบบเตือน "เลือกชุดในรายการ" และรายการนั้นยังคิดราคาไม่ได้จนกว่าจะเลือก</li>
          <li><b>การ์ดค่าเริ่มต้น</b> — บันทึกแล้วย่อเหลือป้ายสรุป กด "แก้ไข ▾" เพื่อกาง · ย่อระหว่างแก้ ค่าที่ยังไม่บันทึกไม่หาย (ป้าย "มีค่าที่ยังไม่บันทึก")</li>
          <li><b>แคตตาล็อก → โรงรีด · ซีรีส์</b> — เพิ่ม/แก้ซีรีส์หลักของแต่ละโรงรีด ตั้ง "ความหนาที่ให้เลือก" ได้ (STANDARD = 1.0, 1.2, 1.5, 1.8, 2.0 มม.) · ใส่ซีรีส์เข้ากลุ่มที่ปุ่ม "แก้ไข" ของซีรีส์ · ลบซีรีส์หลักที่ยังมีซีรีส์หรือโปรเจกต์ใช้อยู่ไม่ได้ ให้ปิดใช้งานแทน</li>
          <li><b>แคตตาล็อก → ชิ้นส่วนอื่น → ชุดอุปกรณ์</b> — ชุดไม่มีหน่วย (นับเป็นชุด) · ส่วนที่ 1 อุปกรณ์ ส่วนที่ 2 วัสดุสิ้นเปลือง กด "+ เพิ่ม" แล้วค้นหาจากสต๊อก (เห็นคงเหลือและราคาซื้อล่าสุด) ไม่เจอ กด "สร้างรายการใหม่" · ส่วนที่ 3 ผูกกับซีรีส์: โรงรีด → ซีรีส์หลัก → ติ๊กชุด (+ ประเภทถ้าต้องการ) · ไม่ผูกซีรีส์เลย = ใช้ได้ทุกซีรีส์</li>
          <li>ราคาของในชุดที่มาจากสต๊อก = ราคาซื้อล่าสุด ไม่รวม VAT จากใบกำกับภาษีซื้อ ถ้าไม่มีใช้ใบสั่งซื้อ ถ้าไม่มีอีกใช้ราคาในแคตตาล็อก · โปรเจกต์คิดราคาตามวันที่ราคาของโปรเจกต์ (ไม่ใช้ราคาที่ซื้อหลังวันนั้น)</li>
        </ul>
```

Run: `grep -c "ซีรีส์หลักและชุดอุปกรณ์ (1.36.0)" public/manual/index.html` → Expected: `1`.

- [ ] **Step 4: Final checks**

Run: `npx vitest run` → Expected: all green.
Run: `npm run build` → Expected: success.
Run: `git -C /Users/plfx/code/FacadeXPM/facadex-app/.claude/worktrees/series-family diff --stat main -- src/lib/itemPreviewSignature.golden.json` → Expected: no output (snapshot untouched).
Run: `grep -rn "default_series_id" /Users/plfx/code/FacadeXPM/facadex-app/.claude/worktrees/series-family/src --include="*.js" --include="*.jsx" -l | grep -v "\.test\." ` → Expected: only `src/lib/estimationInherit.js`, `src/lib/seriesFamily.js`, `src/pages/estimation/projectDefaults.js`.

- [ ] **Step 5: Commit**

```bash
cd /Users/plfx/code/FacadeXPM/facadex-app/.claude/worktrees/series-family
git add package.json package-lock.json src/changelog.json public/manual/index.html
git commit -F - <<'MSG'
chore(release): 1.36.0 — series family defaults, collapsed defaults card, hardware set page

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SKarDAHEncS9RZ6zCSPXc1
MSG
```

---

## Controller checklist (not for implementers)

Order matters: the app loads `alu_series_families` on the estimation page, so migration 01 must be live before the 1.36.0 build is deployed.

1. Run `supabase/datafix/2026-10-31-series-family-price-report.sql` query A on CHANG; save the output.
2. Run `2026-10-31-01-alu-series-family.dryrun.sql`; compare with the expected RESULTS under Task 1. Any FAIL → stop.
3. Owner applies migration 01 (`!`). Run report query B; expected: same rows as A, every `series_from` = `own` or `none` (no price can change).
4. Run `2026-10-31-02-alu-parts-stock-link.dryrun.sql` (expected RESULTS under Task 9); owner applies migration 02; run `2026-10-31-hardware-stock-match-report.sql` and give the list to the owner (nothing links automatically).
5. Dev server (`npm run dev` in the worktree), logged in as the FacadeX owner:
   - Estimation → a test project → ค่าเริ่มต้น: โรงรีดหลัก = Alumet, ซีรีส์หลัก = "ICONIQ EURO · 3 ชุด" → save → the card collapses with chips; reload → still collapsed.
   - Add an item with a casement (บานเปิด) template and one with a sliding (บานเลื่อน) template, series left on "ตามโปรเจกต์": the first shows "ตามโปรเจกต์ (ICONIQ EURO บานเปิด / บานกระทุ้ง · …)", the second "ตามโปรเจกต์ (ICONIQ EURO บานเลื่อน · …)"; both priced (no "ยังไม่เลือกซีรีส์").
   - A บานเฟี้ยม template on that project: the warning "ซีรีส์หลัก ICONIQ EURO ไม่มีชุดสำหรับประเภทนี้ — เลือกชุดในรายการ" and the amber banner.
   - SMS → HOMELIFE on another test project, a sliding item: hint "ซีรีส์หลักนี้มี 3 ชุดบานเลื่อน — เลือกได้ที่นี่" (count = the sliding series HOMELIFE really links).
   - HOSPITAL: its item's price is the same as before the migration.
   - Catalogue → ชิ้นส่วนอื่น → ชุดอุปกรณ์: "+ ชุดใหม่" (no unit field), add one stock item twice ("… มีในชุดแล้ว" the second time), the price shows "ใบกำกับภาษีซื้อ …" or "ใบสั่งซื้อ …", add a series via โรงรีด → ซีรีส์หลัก → ติ๊ก.
6. Bump above the live version if `main` moved, merge, deploy (chang-ship skill), check `build-info.json`, then the lessons note and the manual redeploy (house rule).
