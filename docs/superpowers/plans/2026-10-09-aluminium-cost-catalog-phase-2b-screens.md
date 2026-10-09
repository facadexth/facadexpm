# Aluminium Cost Catalog — Phase 2b (Screens, Assembly Logic, Whole-Project BOM) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the Phase 1 catalog and Phase 2a engine in front of the user: project defaults, the item form with a live preview, template joint logic, a whole-project BOM with a cut optimizer and extruder comparison, and retire the legacy tables.

**Architecture:** Everything with logic is a pure, unit-tested module in `src/lib` (this plan contains their complete code and tests; every one was run green against the 2a branch before being written here: the suite stood at 1216 tests, plus 18 more for the last three libs). Screens are thin: they load tables with the existing hooks, call `costOpening` / `buildProjectBom` / `buildFramePreview`, and write rows. One additive migration (#2) adds the columns/tables; a separate contract migration is applied only at deploy time.

**Tech Stack:** React 18 + Vite, vitest, Supabase (RLS, tenant_id on every table), plain JS libs. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-08-aluminium-cost-catalog-design.md` (the spec's later decisions are in the Rulings below, which came from the owner's mockup comments). Visual spec for every screen: the published mockup https://claude.ai/artifact/BA92PnZB9eSNX1TzyynbbD (v21, 9 screens). Predecessors: `2026-10-08-aluminium-cost-catalog-phase-1.md`, `2026-10-09-aluminium-cost-catalog-phase-2a-engine.md`.

## Global Constraints

- **FacadeX only; other tenants must see no change.** Every new table has the `admin_full_access` policy gated by `has_module_access('estimation')`; every new screen/menu entry is gated by the `estimation` module (an `EXPLICIT_ONLY_MODULES` entry, never opened by a free trial). Nothing in this plan edits a standard module (Quotations, Invoices, PO). Any later link to a standard module must be additive, nullable and module-gated.
- **Expand / contract.** Migration `2026-10-12-01-estimation-2b-expand.sql` is additive only. The contract migration (Task 18) is applied at deploy time, after the new code is live, and guards on legacy data. Migrations go live the instant they are applied; an unpushed branch is not safe.
- **Agents never touch any database.** SQL is verified by careful reading; the owner runs the prepared scripts (`!`). Do not run `supabase`, `psql`, or any MCP SQL tool.
- **Pure functions only in `src/lib`:** no I/O, no `Date.now()` / `new Date()` inside them (callers pass dates in); dates are `'YYYY-MM-DD'` strings.
- **Unresolved, never silent 0.** A price or dimension that cannot be found is listed with a reason code; no total may hide it.
- **No upserts, no PostgREST embeds** in new code: load tables separately (`fetchCatalogRows` / `useCatalogTable`) and join client-side; settings use insert-or-update by looking up the row first.
- **Do NOT modify** `src/pages/AluminumProfiles.jsx` or `src/pages/PurchaseOrders.jsx` (legacy aluminium profiles stay PO-side). The only edit allowed to the shared `src/components/AttachmentsSection.jsx` is an optional `accept` prop whose default is today's value.
- **Mockup-first rule already satisfied** for the screens in Tasks 12–17; build them to match mockup v21. Anything the mockup does not show: stop and ask, do not invent UI.
- **Out of scope (owner, 2026-10-09):** shop drawings / DXF / DWG export (a later extension; do not mould `framePreview` for it), the quotation export and the quotation attachment (Phase 3), data import, the PO linkage. This plan only STORES the preview snapshots and the description format that Phase 3 will use.
- Thai UI copy for every user-visible string. Commit messages end with the line `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Run unit tests with `npx vitest run <file>`; whole suite `npm test`; build `npm run build`.

## Rulings (owner may overturn at the review gate)

Owner-given answers are marked **(owner)**; the rest are mine, each with what it costs if wrong.

1. **(owner) Price lock stays by `effective_from`** (`price_as_of`). Quotations hold 30–60 days; emergencies are handled by the refresh-price button (Task 17). No `price_locked_at`.
2. **(owner) Hardware vs accessory** are the existing `alu_parts.kind` values (`hardware`/`hardware_set` vs `accessory`); series↔part links are the existing `alu_series_parts` (`type_id` NULL = every type). No schema change. A part may link to several types of one series (the unique index already allows it).
3. **(owner) Frame and sash thickness are separate** (government specs, e.g. frame 2.0 mm / sash 1.5 mm, are the common traditional case on every extruder's standard series). The item has `thickness_mm` (frame / main) and `sash_thickness_mm` (NULL = same as the frame); the project has `default_thickness_mm` and `default_sash_thickness_mm`; both inherit by NULL. A template component is tagged `thickness_role = 'sash'` (NULL = frame/main). Sash thickness applies only where the series+type link allows it (`alu_series_types.allow_mixed_thickness`); otherwise every component uses the single thickness (`applyRoleThickness`). A joint's main bar is looked up at the thickness its own components use (the sash thickness when the main bar's components are sash-role, otherwise the frame thickness) — changed after the interim review, because the government case (frame 2.0 / sash 1.5) could never resolve a sash joint otherwise.
4. **(owner) One die = one item.** `alu_profiles.drawing_no` is the extruder's DIE NO. (relabelled in the UI); equal shape with different thickness is a different profile row. `shape_group` only groups profiles and shares the drawing/dimensions; it carries no price. The same die no. from two extruders is two rows. *Wrong if:* shape groups must also hold shared prices — then they need their own table.
5. **(owner) Joint logic is per template.** Main bar = full length. Each profile records its **primary contact surface** = the face a butting bar rests against; the secondary bar is shortened, per end, by the dimension **perpendicular** to that face. Example from the owner: กล่องเรียบ 101.6 × 44.45 — contact on the 101.6 face (the normal case, `primary_contact = 'width'`, the default) shortens the secondary bar by 44.45 (`depth_mm`); contact on the narrow face (`'depth'`) shortens it by 101.6 (`width_mm`). Overridable per joint (manual mm). Which bar is main is set in the template (`bom_template_joints.main_family`; `bom_templates.main_axis` drives the preview). Sliding frame: the two vertical bars are main (waterproofing).
6. **(owner) Cut optimizer is whole-project only**; saw kerf differs for 90° (`kerf_square_mm`, default 3 mm, placeholder) and 45° (`kerf_miter_mm`, default 10 mm = the owner's estimate; he says the real distance must be checked); all constants are tenant-wide in `estimation_settings`. **A 45° piece's length is always its OUTER (long-point) length**; mixing in the shorter inner length causes large errors (owner warning), so the joint UI, the parts-style preview and the cut list must all label mitred pieces as outer length.
7. **Offcuts never reduce cost.** Reusable offcuts (≥ `min_keep_offcut_m`) are only reported. *Wrong if:* the owner stocks and reuses offcuts — then cost needs a credit rule.
8. **Accessories (shim, screw, plug) are off until linked** in the settings tab (`*_part_id` NULL = no line), so a template that already lists them is not double-counted. One of each per fixing point (every 0.6 m, at least 2 per side; owner). The add-on is its own frame for fixing points and sealant length.
9. **Sealant** is shown as quantity (tubes, one total length rounded up once; 300 ml tube = 10 m, owner). Its cost stays the engine's existing silicone line (`silicone_price_per_m`); the settings `sealant_part_id` exists only so a later phase can price tubes. *Wrong if:* the owner wants tube pricing now — then silicone cost must be zeroed per template to avoid double counting.
10. **Extruder comparison** is aluminium-only and read-only: the owner picks a series + colour per candidate extruder; items keep their size, template and thickness (a candidate lacking that thickness/profile is listed as unresolved lines, never priced as 0). Per-item series overrides are ignored in the comparison. The project's `primary_provider_id` is a default for pickers, not a hard filter.
11. **Saved preview** is always the double-line style with no part-length labels, in both views (out/in), stored as SVG text with a signature of the inputs; a stale signature shows a "ภาพเก่ากว่าข้อมูล" hint and a re-save button. The live preview keeps all four styles (double, solid, CAD, parts) as the owner asked to keep them for now.
12. **Layout templates store types, position and proportions only** (ratios against the main size), never series, colour, price or profile. Which BOM template builds a type is looked up at use time (`bomTemplatesForType`).
13. **Profile drawing files (owner):** the owner has supplier catalogue PDFs and the company's own DWG approval drawings; each file is attached to ONE profile (he splits multi-profile files himself). Migration #2 adds the table `alu_profile_files` and the private bucket `alu-profile-files` (the owner applies it with the migration); the screen reuses `AttachmentsSection` with a new optional `accept` prop (default unchanged). DWG/PDF are stored and downloaded only; nothing parses them and DWG has no preview.
14. **Preview decoration** (handle, travel arrow, swing arc) comes from `bom_templates.preview_kind` (`fixed`/`slide`/`swing`), set in the template editor.
15. **Stock length order:** per-profile project override > project `stock_length_m` > tenant default (6.4 m).
16. **Quantity (sets) is not in the item form** (owner); it is edited in the items table of the project page.
17. **`price_as_of`** is set from the user's LOCAL date at project creation (`localDateString(new Date())`); the DB default (`current_date`, UTC) is only a fallback.
18. **(owner, 2026-10-09) Three-level types.** `door_window_types.parent_id`, up to three levels: กลุ่มหลัก (ประตู / หน้าต่าง / ผนังกระจก; category gains `curtain_wall`) → แบบ (บานเลื่อน) → แบบย่อย (รางล่าง / รางบน). Only a type with no active children can be chosen on templates, layout templates and items (`selectableTypes`). A series link or part link on a type applies to all its descendants; a link on a deeper type applies to it alone; the nearest linked ancestor's mixed-thickness flag wins. *Wrong if:* the owner wants a child to remove a parent's parts (no "exclude" rule yet) or wants to quote a non-leaf directly.
19. **Types tab shows a tree** (indented, up to three levels); labels everywhere read "ประตู › บานเลื่อน › รางล่าง" (`typeLabel`). A child takes its category from its parent. A legacy template pointing at a type that now has children keeps pricing but shows a warning in the template editor. Labour rate falls back to the nearest ancestor's.
20. **(owner, 2026-10-09) Project hardware = a package.** A named package (`alu_hardware_packages` + `alu_hardware_package_items`) bundles one hardware set per type (nearest type in the chain wins). It is created in a subtab of the BOM template screen ("ชุดอุปกรณ์โครงการ"); the project page has one select-only field (`estimation_projects.hardware_package_id`); items take their set from the package by type. A type the package does not cover still prices without a set and is warned about (owner can ask for "cannot price" instead). The old `default_hardware_set_id` applies only to projects without a package, so existing projects price unchanged. *Wrong if:* the owner wants an unmapped type to block pricing, or wants per-project overrides of single types (not built).
21. **(owner, 2026-10-09) No "same as frame" choice for the sash thickness.** The sash select (project page and item form) lists real thicknesses only (the series' offered thicknesses), preselected to the frame thickness's value when nothing else is set, and the chosen number is saved explicitly. It is shown only where the type allows mixed thickness. `sash_thickness_mm` NULL stays valid in the DB and engine for old rows and non-mixed types (it means the frame thickness); the UI just never offers it. The frame field is labelled "ความหนา วงกบ (มม.)" in the item form.
22. **Type pick in the item form is cascading dropdowns** (กลุ่มหลัก → แบบ → แบบย่อย), the next dropdown appearing only when the chosen type has children; the saved value is the leaf. Item-form columns are balanced (left: fields, add-on, description; right: preview, layout templates).

## Review Focus

1. A tenant without the `estimation` module (possibly not an aluminium business) must see and change nothing: DB policies on all five new tables and every UI entry. Test: Task 1 SQL test 3 and Task 12–17 gating checklist.
2. An item with missing inputs (no series, a thickness the series lacks, an unlinked joint, an unpriced accessory) shows reason codes and an unresolved list; the total never silently treats it as 0 (Task 7 tests).
3. A saved preview snapshot must not silently outlive an edit: the signature changes with every input that changes the drawing (Task 10 tests) and the form shows the stale hint.
4. Cut optimizer edge inputs: a cut longer than the bar, zero/negative/fractional quantities, 45° vs 90° kerf, a candidate bar shorter than the longest cut, and nothing to cut (Task 5 tests). A mitred piece must always be listed with its outer length (Ruling 6); the joint tab and the parts preview must say so.
5. The contract migration must refuse to run while any item still relies on the legacy columns, and must not run before the new code is deployed (Task 18 guard + deploy checklist).

## File Structure

New pure libs (`src/lib/`, each with a `.test.js` beside it): `estimationCatalogViews`, `localDate`, `assembly`, `estimationSettings`, `openingExtras`, `cutOptimizer`, `projectBom`, `openingCost`, `providerCompare`, `layoutTemplates`, `descriptionFormat`, `openingPayload`, `templateSave`, `profileSketch`, `typeTree`. Changed libs: `aluCatalogPricing` (3 index keys), `bomEngine` (role thickness + cut style), `estimationInherit` (+ its test: sash thickness inherits), `framePreview` (rewritten, backward compatible).
New hook file: `src/hooks/useEstimation2b.js`. New/changed screens: `src/pages/aluCatalog/{ProfilesTab,HierarchyTab,SettingsTab}.jsx`, `src/pages/BomTemplates.jsx` (+ `src/pages/bomTemplates/JointsTab.jsx`), `src/pages/Estimation.jsx` (split into `src/pages/estimation/*`). SQL: `supabase/migrations/2026-10-12-01-estimation-2b-expand.sql`, `supabase/migrations/2026-10-12-02-estimation-type-parent.sql` (Task 11A), `supabase/migrations/2026-10-12-03-estimation-hardware-packages.sql` (Task 11B), `supabase/tests/estimation_2b_expand_test.sql`, and (Task 18) `supabase/migrations/2026-10-13-01-estimation-contract.sql`.

## Follow-up A (already on the branch)

After Tasks 1–11 an interim whole-range review (opus) found one Critical and six Important cross-task problems; they were fixed in commits `3983a9ed` and `e31b1ccb` and the Task code blocks below show the FINAL code. What changed relative to a naive reading of the tasks: `componentRowsForInsert` writes only whitelisted real columns (`thickness_role`, not `thickness_mm`); `projectBom` also lists `costOpening`'s own unresolved entries (joint issues, `no_dimension`, `unknown_infill`, `unknown_addon_template`) and merges hardware by `part_id`; `applyJoints` looks a joint's main bar up at its own components' thickness and marks main bars of a mitre joint 45° (only bars without their own joint); `previewSignature` is normalised and covers the template inputs; `costOpening` reports an add-on it could not cost; `compareProviders` never marks a row complete when a template, size, joint, add-on or infill is missing; `bomEngine` hardware lines carry `part_id`; `stockForProject` and a single `ADDON_POSITIONS` source exist; `validateForm` checks thickness > 0 and a non-negative offset.

## Task order and gates

Tasks 1–10 are SQL + pure code (no UI) and can be reviewed without a browser. Task 11 is data hooks. Tasks 11A (parent/child types) and 11B (project hardware), both added by owner request, are SQL + pure code and must be done before Tasks 12–15. Tasks 12–17 are screens (verified by `npm run build` plus the owner's click-through list at the end; agents cannot load data, so they must not claim a screen "works" beyond building). Task 18 is the deploy-time contract migration (written, not applied). Task 19 is the final verification and handover. Do not skip the task review for the pure-code tasks: transcription errors are the risk.

---



### Task 1: Migration #2 (expand) and its SQL test

**Files:**
- Create: `supabase/migrations/2026-10-12-01-estimation-2b-expand.sql`
- Create: `supabase/tests/estimation_2b_expand_test.sql`
- Controller creates (NOT committed, git-ignored): `.superpowers/sdd/2026-10-09-aluminium-cost-catalog-phase-2b-screens/run-estimation-2b-tests.sh`

**Interfaces:**
- Consumes: the Phase 1 tables (`alu_profiles`, `alu_series_types`, `alu_parts`, `alu_providers`, `door_window_types`), the 2a columns, and the original `bom_templates`, `bom_template_components`, `estimation_projects`, `estimation_openings`.
- Produces (exact names, used by every later task): `alu_profiles.{shape_group,width_mm,depth_mm,primary_contact}` (`primary_contact` = the face a butting bar rests against, default `width`); table `alu_profile_files` + private bucket `alu-profile-files`; `alu_series_types.allow_mixed_thickness`; `bom_templates.{main_axis,preview_kind}`; table `bom_template_joints`; `bom_template_components.{joint_id,joint_ends,thickness_role}`; table `estimation_settings`; `estimation_projects.{primary_provider_id,default_sash_thickness_mm,stock_length_m,description_format}`; table `estimation_project_stock`; `estimation_openings.{sash_thickness_mm,addon_position,addon_offset_m,preview_svg_out,preview_svg_in,preview_sig,preview_saved_at}`; table `estimation_layout_templates`.

Agents do NOT run any of this against a database. Verify by reading: every new table has `tenant_id UUID NOT NULL DEFAULT current_tenant_id()`, RLS enabled and the `admin_full_access` policy with `has_module_access('estimation')`, every UNIQUE includes what it must, every new FK has an index, and the storage policy for `alu-profile-files` is tenant-prefixed and module-gated.

- [ ] **Step 1: Create the migration** with exactly:

```sql
-- supabase/migrations/2026-10-12-01-estimation-2b-expand.sql
-- Aluminium cost catalog, Phase 2b "expand" step #2. ADDITIVE ONLY (new columns with defaults / nullable, new tables):
-- nothing is dropped, renamed or retyped, so the deployed code keeps working before and after this migration.
-- FacadeX only: every new table is gated by has_module_access('estimation'), like the rest of the catalog.
-- Needs migrations 2026-10-10-01..03 and 2026-10-11-01. The matching contract step is a separate file applied at deploy time.

-- 1. Profile dimensions and files. drawing_no (already there) is the extruder's DIE NO.; one die = one profile row.
--    primary_contact = the face a butting bar rests against; the bar is shortened by the dimension perpendicular to it:
--      'width' (default) = the wide face (e.g. 101.6) -> shortened by depth_mm (44.45); 'depth' = the narrow face -> by width_mm.
ALTER TABLE alu_profiles
  ADD COLUMN shape_group     TEXT,
  ADD COLUMN width_mm        NUMERIC CHECK (width_mm IS NULL OR width_mm > 0),
  ADD COLUMN depth_mm        NUMERIC CHECK (depth_mm IS NULL OR depth_mm > 0),
  ADD COLUMN primary_contact TEXT NOT NULL DEFAULT 'width' CHECK (primary_contact IN ('width','depth'));

-- Drawing files per profile (supplier catalogue PDFs, the company's own DWG for approval drawings, DXF/SVG/images).
-- Columns match what src/components/AttachmentsSection.jsx reads and writes. One file = one profile (the owner splits
-- multi-profile PDFs / DWGs himself before uploading). Private bucket, tenant-prefixed path, one FOR ALL policy on both
-- the table and the bucket (see 2026-09-02-04-invoice-photos.sql for why not split per command).
CREATE TABLE alu_profile_files (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id   UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  profile_id  UUID NOT NULL REFERENCES alu_profiles(id) ON DELETE CASCADE,
  file_path   TEXT NOT NULL,
  file_name   TEXT NOT NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_alu_profile_files_profile_id ON alu_profile_files(profile_id);

INSERT INTO storage.buckets (id, name, public) VALUES ('alu-profile-files', 'alu-profile-files', false)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY alu_profile_files_tenant_access ON storage.objects FOR ALL TO authenticated
  USING (
    bucket_id = 'alu-profile-files'
    AND is_admin_or_owner() AND has_module_access('estimation')
    AND (storage.foldername(name))[1] = current_tenant_id()::text
  )
  WITH CHECK (
    bucket_id = 'alu-profile-files'
    AND is_admin_or_owner() AND has_module_access('estimation')
    AND (storage.foldername(name))[1] = current_tenant_id()::text
  );

-- 2. Frame and sash may use different thicknesses (government specs: frame 2.0 mm, sash 1.5 mm) only where the
--    series + type allows it. A component is tagged thickness_role 'sash' (NULL = frame/main) in step 4.
ALTER TABLE alu_series_types
  ADD COLUMN allow_mixed_thickness BOOLEAN NOT NULL DEFAULT false;

-- 3. Template: which bars run full length (drives the preview) and how the preview decorates the type.
ALTER TABLE bom_templates
  ADD COLUMN main_axis    TEXT NOT NULL DEFAULT 'vertical' CHECK (main_axis IN ('vertical','horizontal')),
  ADD COLUMN preview_kind TEXT NOT NULL DEFAULT 'fixed'    CHECK (preview_kind IN ('fixed','slide','swing'));

-- 4. Joints of a template: main bar family, secondary bar family, deduction, cut style.
CREATE TABLE bom_template_joints (
  id               UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id        UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  template_id      UUID NOT NULL REFERENCES bom_templates(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  main_family      TEXT NOT NULL,
  secondary_family TEXT NOT NULL,
  deduction_mode   TEXT NOT NULL DEFAULT 'auto' CHECK (deduction_mode IN ('auto','manual')),
  deduction_mm     NUMERIC CHECK (deduction_mm IS NULL OR deduction_mm >= 0),
  cut_style        TEXT NOT NULL DEFAULT 'square' CHECK (cut_style IN ('square','notch','miter45')),
  notch_width_mm   NUMERIC CHECK (notch_width_mm IS NULL OR notch_width_mm > 0),
  notch_depth_mm   NUMERIC CHECK (notch_depth_mm IS NULL OR notch_depth_mm > 0),
  sort_order       INT NOT NULL DEFAULT 0,
  CHECK (deduction_mode <> 'manual' OR deduction_mm IS NOT NULL)
);

ALTER TABLE bom_template_components
  ADD COLUMN joint_id       UUID REFERENCES bom_template_joints(id) ON DELETE SET NULL,
  ADD COLUMN joint_ends     SMALLINT NOT NULL DEFAULT 2 CHECK (joint_ends IN (1,2)),
  ADD COLUMN thickness_role TEXT CHECK (thickness_role IS NULL OR thickness_role = 'sash');

-- 5. Tenant-wide constants (one row per tenant; every value is universal across projects).
CREATE TABLE estimation_settings (
  id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id           UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  stock_length_m      NUMERIC NOT NULL DEFAULT 6.4 CHECK (stock_length_m > 0),
  kerf_square_mm      NUMERIC NOT NULL DEFAULT 3   CHECK (kerf_square_mm >= 0),
  kerf_miter_mm       NUMERIC NOT NULL DEFAULT 10  CHECK (kerf_miter_mm >= 0),
  min_keep_offcut_m   NUMERIC NOT NULL DEFAULT 0.5 CHECK (min_keep_offcut_m >= 0),
  sealant_m_per_tube  NUMERIC NOT NULL DEFAULT 10  CHECK (sealant_m_per_tube > 0),
  fixing_pitch_m      NUMERIC NOT NULL DEFAULT 0.6 CHECK (fixing_pitch_m > 0),
  fixing_min_per_side INT     NOT NULL DEFAULT 2   CHECK (fixing_min_per_side >= 1),
  sealant_part_id     UUID REFERENCES alu_parts(id) ON DELETE SET NULL,
  shim_part_id        UUID REFERENCES alu_parts(id) ON DELETE SET NULL,
  screw_part_id       UUID REFERENCES alu_parts(id) ON DELETE SET NULL,
  plug_part_id        UUID REFERENCES alu_parts(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id)
);

-- 6. Project: main extruder, description format, stock length, and per-profile stock length overrides.
ALTER TABLE estimation_projects
  ADD COLUMN primary_provider_id    UUID REFERENCES alu_providers(id) ON DELETE SET NULL,
  ADD COLUMN default_sash_thickness_mm NUMERIC CHECK (default_sash_thickness_mm IS NULL OR default_sash_thickness_mm > 0),
  ADD COLUMN stock_length_m      NUMERIC CHECK (stock_length_m IS NULL OR stock_length_m > 0),
  ADD COLUMN description_format  JSONB NOT NULL DEFAULT '["item_name","type","size","alu_color"]'::jsonb;

CREATE TABLE estimation_project_stock (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id  UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  project_id UUID NOT NULL REFERENCES estimation_projects(id) ON DELETE CASCADE,
  profile_id UUID NOT NULL REFERENCES alu_profiles(id) ON DELETE CASCADE,
  length_m   NUMERIC NOT NULL CHECK (length_m > 0),
  UNIQUE (project_id, profile_id)
);

-- 7. Items: add-on position/offset and the saved preview snapshots (always the double-line drawing).
ALTER TABLE estimation_openings
  ADD COLUMN sash_thickness_mm NUMERIC CHECK (sash_thickness_mm IS NULL OR sash_thickness_mm > 0),
  ADD COLUMN addon_position  TEXT CHECK (addon_position IS NULL OR addon_position IN ('top','bottom','left','right')),
  ADD COLUMN addon_offset_m  NUMERIC CHECK (addon_offset_m IS NULL OR addon_offset_m >= 0),
  ADD COLUMN preview_svg_out TEXT,
  ADD COLUMN preview_svg_in  TEXT,
  ADD COLUMN preview_sig     TEXT,
  ADD COLUMN preview_saved_at TIMESTAMPTZ;

-- 8. Layout templates: main type + optional add-on type, position and proportions. No series / colour / price.
CREATE TABLE estimation_layout_templates (
  id                 UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id          UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  name               TEXT NOT NULL,
  main_type_id       UUID NOT NULL REFERENCES door_window_types(id) ON DELETE CASCADE,
  addon_type_id      UUID REFERENCES door_window_types(id) ON DELETE CASCADE,
  addon_position     TEXT CHECK (addon_position IS NULL OR addon_position IN ('top','bottom','left','right')),
  addon_offset_ratio NUMERIC NOT NULL DEFAULT 0    CHECK (addon_offset_ratio >= 0 AND addon_offset_ratio <= 1),
  addon_width_ratio  NUMERIC NOT NULL DEFAULT 1    CHECK (addon_width_ratio > 0),
  addon_height_ratio NUMERIC NOT NULL DEFAULT 0.33 CHECK (addon_height_ratio > 0),
  main_panel_count   INT NOT NULL DEFAULT 1 CHECK (main_panel_count >= 1),
  addon_panel_count  INT NOT NULL DEFAULT 1 CHECK (addon_panel_count >= 1),
  active             BOOLEAN NOT NULL DEFAULT true,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name),
  CHECK ((addon_type_id IS NULL) = (addon_position IS NULL))
);

-- Foreign-key indexes.
CREATE INDEX idx_bom_template_joints_template_id      ON bom_template_joints(template_id);
CREATE INDEX idx_bom_template_components_joint_id     ON bom_template_components(joint_id);
CREATE INDEX idx_estimation_projects_primary_provider ON estimation_projects(primary_provider_id);
CREATE INDEX idx_estimation_project_stock_project_id  ON estimation_project_stock(project_id);
CREATE INDEX idx_estimation_project_stock_profile_id  ON estimation_project_stock(profile_id);
CREATE INDEX idx_estimation_layout_main_type          ON estimation_layout_templates(main_type_id);
CREATE INDEX idx_estimation_layout_addon_type         ON estimation_layout_templates(addon_type_id);
CREATE INDEX idx_estimation_settings_sealant_part     ON estimation_settings(sealant_part_id);
CREATE INDEX idx_estimation_settings_shim_part        ON estimation_settings(shim_part_id);
CREATE INDEX idx_estimation_settings_screw_part       ON estimation_settings(screw_part_id);
CREATE INDEX idx_estimation_settings_plug_part        ON estimation_settings(plug_part_id);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['bom_template_joints','estimation_settings','estimation_project_stock','estimation_layout_templates','alu_profile_files'] LOOP
    EXECUTE format('CREATE INDEX idx_%s_tenant_id ON %I(tenant_id)', t, t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY admin_full_access ON %I FOR ALL TO authenticated
      USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation'))
      WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation'))$p$, t);
  END LOOP;
END $$;
```

- [ ] **Step 2: Create the SQL test** with exactly:

```sql
-- supabase/tests/estimation_2b_expand_test.sql
-- RUN ONLY INSIDE ONE TRANSACTION THAT ENDS IN ROLLBACK (fixtures are real rows).
--   BEGIN; <catalog migrations 2026-10-10-01..03 if not applied>; <2026-10-11-01 if not applied>; <2026-10-12-01>; <this file>; ROLLBACK;
-- Tenants: A and B hold only 'estimation'; C holds nothing.

CREATE TEMP TABLE _est2_fx (a_tenant UUID, b_tenant UUID, c_tenant UUID);
DO $$
DECLARE owner_id UUID; ta UUID; tb UUID; tc UUID;
BEGIN
  SELECT id INTO owner_id FROM auth.users ORDER BY created_at ASC LIMIT 1;
  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at)
    VALUES ('__EST2 TEST A__', owner_id, 'expired', now() - interval '1 day') RETURNING id INTO ta;
  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at)
    VALUES ('__EST2 TEST B__', owner_id, 'expired', now() - interval '1 day') RETURNING id INTO tb;
  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at)
    VALUES ('__EST2 TEST C__', owner_id, 'expired', now() - interval '1 day') RETURNING id INTO tc;
  INSERT INTO tenant_modules (tenant_id, module_key) VALUES (ta, 'estimation'), (tb, 'estimation');
  INSERT INTO user_roles (user_email, role, status, tenant_id) VALUES
    ('__est2_a__@example.com', 'OWNER', 'approved', ta),
    ('__est2_b__@example.com', 'OWNER', 'approved', tb),
    ('__est2_c__@example.com', 'OWNER', 'approved', tc);
  INSERT INTO _est2_fx VALUES (ta, tb, tc);
END $$;

-- ── Test 1: new columns, defaults and CHECK constraints ──
DO $$
DECLARE
  prov UUID; prof UUID; ser UUID; typ UUID; typ2 UUID; tpl UUID; joint UUID; comp UUID; proj UUID; op UUID; part UUID;
  n INT; raised BOOLEAN; pc TEXT; ma TEXT; pk TEXT; mixed BOOLEAN; ds NUMERIC;
BEGIN
  SET LOCAL role = 'authenticated';
  SET LOCAL request.jwt.claims = '{"email":"__est2_a__@example.com"}';

  INSERT INTO alu_providers (name, short_name, price_basis) VALUES ('EST2 P', 'E2', 'per_kg') RETURNING id INTO prov;
  INSERT INTO alu_series (provider_id, name) VALUES (prov, 'EST2 S') RETURNING id INTO ser;
  INSERT INTO door_window_types (name, category) VALUES ('EST2 T', 'window') RETURNING id INTO typ;
  INSERT INTO door_window_types (name, category) VALUES ('EST2 T2', 'window') RETURNING id INTO typ2;
  INSERT INTO alu_parts (name, kind) VALUES ('EST2 SHIM', 'accessory') RETURNING id INTO part;

  -- profile dimensions
  INSERT INTO alu_profiles (provider_id, name, drawing_no, thickness_mm, linear_weight_kg_per_m, width_mm, depth_mm, shape_group)
    VALUES (prov, 'กล่องเรียบ', 'U1613', 1.5, 0.871, 101.6, 44.45, 'กล่องเรียบ') RETURNING id, primary_contact INTO prof, pc;
  IF pc <> 'width' THEN RAISE EXCEPTION 'primary_contact should default to width, got %', pc; END IF;
  UPDATE alu_profiles SET primary_contact = 'depth' WHERE id = prof;
  raised := false; BEGIN UPDATE alu_profiles SET primary_contact = 'diagonal' WHERE id = prof; EXCEPTION WHEN check_violation THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'bad primary_contact was allowed'; END IF;
  raised := false; BEGIN UPDATE alu_profiles SET width_mm = 0 WHERE id = prof; EXCEPTION WHEN check_violation THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'width_mm = 0 was allowed'; END IF;

  -- mixed thickness defaults to off per series + type
  INSERT INTO alu_series_types (series_id, type_id) VALUES (ser, typ) RETURNING allow_mixed_thickness INTO mixed;
  IF mixed THEN RAISE EXCEPTION 'allow_mixed_thickness should default to false'; END IF;
  UPDATE alu_series_types SET allow_mixed_thickness = true WHERE series_id = ser AND type_id = typ;

  -- template defaults + joint + component link
  INSERT INTO bom_templates (name, category, type_id) VALUES ('EST2 TPL', 'window', typ) RETURNING id, main_axis, preview_kind INTO tpl, ma, pk;
  IF ma <> 'vertical' OR pk <> 'fixed' THEN RAISE EXCEPTION 'template defaults wrong: %, %', ma, pk; END IF;
  raised := false; BEGIN UPDATE bom_templates SET main_axis = 'diagonal' WHERE id = tpl; EXCEPTION WHEN check_violation THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'bad main_axis was allowed'; END IF;
  raised := false; BEGIN UPDATE bom_templates SET preview_kind = 'sliding' WHERE id = tpl; EXCEPTION WHEN check_violation THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'bad preview_kind was allowed'; END IF;

  INSERT INTO bom_template_joints (template_id, name, main_family, secondary_family) VALUES (tpl, 'corner', 'กล่องเรียบ', 'ตัวนอน') RETURNING id INTO joint;
  raised := false; BEGIN INSERT INTO bom_template_joints (template_id, name, main_family, secondary_family, deduction_mode) VALUES (tpl, 'x', 'a', 'b', 'manual'); EXCEPTION WHEN check_violation THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'manual joint without deduction_mm was allowed'; END IF;
  INSERT INTO bom_template_joints (template_id, name, main_family, secondary_family, deduction_mode, deduction_mm, cut_style, notch_width_mm, notch_depth_mm)
    VALUES (tpl, 'm', 'a', 'b', 'manual', 0, 'notch', 40, 20);
  raised := false; BEGIN UPDATE bom_template_joints SET cut_style = 'bevel' WHERE id = joint; EXCEPTION WHEN check_violation THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'bad cut_style was allowed'; END IF;

  INSERT INTO bom_template_components (template_id, role_name, profile_family, length_rule_type, quantity_basis, joint_id, thickness_role)
    VALUES (tpl, 'ตัวนอน', 'ตัวนอน', 'width', 'fixed', joint, 'sash') RETURNING id INTO comp;
  raised := false; BEGIN UPDATE bom_template_components SET thickness_role = 'frame' WHERE id = comp; EXCEPTION WHEN check_violation THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'thickness_role other than sash was allowed'; END IF;
  raised := false; BEGIN UPDATE bom_template_components SET joint_ends = 3 WHERE id = comp; EXCEPTION WHEN check_violation THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'joint_ends = 3 was allowed'; END IF;

  -- profile files: one row per uploaded file, removed with the profile (the storage object is removed by the app)
  INSERT INTO alu_profile_files (profile_id, file_path, file_name) VALUES (prof, 'x/y/1-a.pdf', 'a.pdf');

  -- settings: defaults, one row per tenant
  INSERT INTO estimation_settings DEFAULT VALUES RETURNING stock_length_m INTO ds;
  IF ds <> 6.4 THEN RAISE EXCEPTION 'stock_length_m default should be 6.4, got %', ds; END IF;
  raised := false; BEGIN INSERT INTO estimation_settings DEFAULT VALUES; EXCEPTION WHEN unique_violation THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'a second settings row for one tenant was allowed'; END IF;
  raised := false; BEGIN UPDATE estimation_settings SET sealant_m_per_tube = 0; EXCEPTION WHEN check_violation THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'sealant_m_per_tube = 0 was allowed'; END IF;
  UPDATE estimation_settings SET shim_part_id = part;

  -- project: format default, stock overrides (one per profile)
  INSERT INTO estimation_projects (name) VALUES ('EST2 PROJ') RETURNING id INTO proj;
  SELECT count(*) INTO n FROM estimation_projects WHERE id = proj AND description_format = '["item_name","type","size","alu_color"]'::jsonb AND stock_length_m IS NULL;
  IF n <> 1 THEN RAISE EXCEPTION 'project description_format default wrong'; END IF;
  UPDATE estimation_projects SET primary_provider_id = prov, stock_length_m = 6, default_sash_thickness_mm = 1.5 WHERE id = proj;
  raised := false; BEGIN UPDATE estimation_projects SET default_sash_thickness_mm = 0 WHERE id = proj; EXCEPTION WHEN check_violation THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'default_sash_thickness_mm = 0 was allowed'; END IF;
  raised := false; BEGIN UPDATE estimation_projects SET stock_length_m = 0 WHERE id = proj; EXCEPTION WHEN check_violation THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'project stock_length_m = 0 was allowed'; END IF;
  INSERT INTO estimation_project_stock (project_id, profile_id, length_m) VALUES (proj, prof, 6.0);
  raised := false; BEGIN INSERT INTO estimation_project_stock (project_id, profile_id, length_m) VALUES (proj, prof, 5.8); EXCEPTION WHEN unique_violation THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'two stock lengths for one profile in one project were allowed'; END IF;

  -- item: add-on position, offset, saved previews
  INSERT INTO estimation_openings (project_id, opening_no, template_id, width_m, height_m, thickness_mm, sash_thickness_mm, addon_position, addon_offset_m, preview_svg_out, preview_sig)
    VALUES (proj, 'D1', tpl, 2, 2, 2, 1.5, 'bottom', 0.5, '<svg/>', 'sig') RETURNING id INTO op;
  raised := false; BEGIN UPDATE estimation_openings SET sash_thickness_mm = 0 WHERE id = op; EXCEPTION WHEN check_violation THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'sash_thickness_mm = 0 was allowed'; END IF;
  raised := false; BEGIN UPDATE estimation_openings SET addon_position = 'diagonal' WHERE id = op; EXCEPTION WHEN check_violation THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'bad addon_position was allowed'; END IF;
  raised := false; BEGIN UPDATE estimation_openings SET addon_offset_m = -1 WHERE id = op; EXCEPTION WHEN check_violation THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'negative addon_offset_m was allowed'; END IF;

  -- layout templates: add-on type and position come together
  INSERT INTO estimation_layout_templates (name, main_type_id) VALUES ('no addon', typ);
  INSERT INTO estimation_layout_templates (name, main_type_id, addon_type_id, addon_position, addon_offset_ratio) VALUES ('with addon', typ, typ2, 'top', 0.25);
  raised := false; BEGIN INSERT INTO estimation_layout_templates (name, main_type_id, addon_type_id) VALUES ('bad1', typ, typ2); EXCEPTION WHEN check_violation THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'add-on type without a position was allowed'; END IF;
  raised := false; BEGIN INSERT INTO estimation_layout_templates (name, main_type_id, addon_position) VALUES ('bad2', typ, 'top'); EXCEPTION WHEN check_violation THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'a position without an add-on type was allowed'; END IF;
  raised := false; BEGIN INSERT INTO estimation_layout_templates (name, main_type_id, addon_type_id, addon_position, addon_offset_ratio) VALUES ('bad3', typ, typ2, 'top', 1.5); EXCEPTION WHEN check_violation THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'addon_offset_ratio over 1 was allowed'; END IF;
  raised := false; BEGIN INSERT INTO estimation_layout_templates (name, main_type_id) VALUES ('no addon', typ); EXCEPTION WHEN unique_violation THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'duplicate layout template name was allowed'; END IF;

  RESET role;
  RAISE NOTICE 'Test 1 (columns, defaults, checks): TEST PASSED';
END $$;

-- ── Test 2: other tenants and a tenant without the module see and write nothing ──
-- (runs BEFORE the delete test so every table still holds a row for tenant A: an empty table would pass vacuously)
DO $$
DECLARE n INT; t TEXT; raised BOOLEAN; tbl TEXT;
BEGIN
  SET LOCAL role = 'authenticated';
  SET LOCAL request.jwt.claims = '{"email":"__est2_a__@example.com"}';
  SELECT count(*) INTO n FROM estimation_settings;
  IF n <> 1 THEN RAISE EXCEPTION 'tenant A should see its settings row, saw %', n; END IF;
  SELECT count(*) INTO n FROM estimation_layout_templates;
  IF n <> 2 THEN RAISE EXCEPTION 'tenant A should see its 2 layout templates, saw %', n; END IF;
  SELECT count(*) INTO n FROM estimation_project_stock;
  IF n <> 1 THEN RAISE EXCEPTION 'tenant A should see its stock override, saw %', n; END IF;
  SELECT count(*) INTO n FROM alu_profile_files;
  IF n <> 1 THEN RAISE EXCEPTION 'tenant A should see its profile file row, saw %', n; END IF;
  SELECT count(*) INTO n FROM bom_template_joints;
  IF n <> 2 THEN RAISE EXCEPTION 'tenant A should see its 2 joints, saw %', n; END IF;

  FOREACH t IN ARRAY ARRAY['b','c'] LOOP
    PERFORM set_config('request.jwt.claims', format('{"email":"__est2_%s__@example.com"}', t), true);
    FOREACH tbl IN ARRAY ARRAY['estimation_settings','estimation_layout_templates','estimation_project_stock','bom_template_joints','alu_profile_files'] LOOP
      EXECUTE format('SELECT count(*) FROM %I', tbl) INTO n;
      IF n <> 0 THEN RAISE EXCEPTION 'tenant % sees % rows of %', t, n, tbl; END IF;
    END LOOP;
  END LOOP;

  -- tenant C has no estimation module: it cannot create settings either
  PERFORM set_config('request.jwt.claims', '{"email":"__est2_c__@example.com"}', true);
  raised := false;
  BEGIN INSERT INTO estimation_settings DEFAULT VALUES; EXCEPTION WHEN insufficient_privilege THEN raised := true; END;
  IF NOT raised THEN RAISE EXCEPTION 'tenant without the estimation module could insert settings'; END IF;

  RESET role;
  RAISE NOTICE 'Test 2 (isolation and module gate): TEST PASSED';
END $$;

-- ── Test 3: delete behaviour ──
DO $$
DECLARE prof UUID; tpl UUID; joint UUID; proj UUID; part UUID; n INT;
BEGIN
  SET LOCAL role = 'authenticated';
  SET LOCAL request.jwt.claims = '{"email":"__est2_a__@example.com"}';
  SELECT id INTO tpl FROM bom_templates WHERE name = 'EST2 TPL';
  SELECT id INTO joint FROM bom_template_joints WHERE name = 'corner';
  SELECT id INTO prof FROM alu_profiles WHERE drawing_no = 'U1613';
  SELECT id INTO proj FROM estimation_projects WHERE name = 'EST2 PROJ';
  SELECT id INTO part FROM alu_parts WHERE name = 'EST2 SHIM';

  -- deleting a joint keeps the component (joint_id -> NULL)
  DELETE FROM bom_template_joints WHERE id = joint;
  SELECT count(*) INTO n FROM bom_template_components WHERE template_id = tpl AND joint_id IS NULL;
  IF n <> 1 THEN RAISE EXCEPTION 'component should survive its joint being deleted'; END IF;

  -- deleting a profile removes that project's stock length override and its file rows
  DELETE FROM alu_profiles WHERE id = prof;
  SELECT count(*) INTO n FROM estimation_project_stock WHERE project_id = proj;
  IF n <> 0 THEN RAISE EXCEPTION 'stock override should go with its profile'; END IF;
  SELECT count(*) INTO n FROM alu_profile_files WHERE profile_id = prof;
  IF n <> 0 THEN RAISE EXCEPTION 'file rows should go with their profile'; END IF;

  -- deleting a part clears the settings link instead of failing
  DELETE FROM alu_parts WHERE id = part;
  SELECT count(*) INTO n FROM estimation_settings WHERE shim_part_id IS NULL;
  IF n <> 1 THEN RAISE EXCEPTION 'settings shim_part_id should be cleared when the part is deleted'; END IF;

  -- deleting a template removes its remaining joints
  DELETE FROM estimation_openings WHERE template_id = tpl;
  DELETE FROM bom_templates WHERE id = tpl;
  SELECT count(*) INTO n FROM bom_template_joints WHERE template_id = tpl;
  IF n <> 0 THEN RAISE EXCEPTION 'joints should go with their template'; END IF;

  RESET role;
  RAISE NOTICE 'Test 3 (delete behaviour): TEST PASSED';
END $$;
```

- [ ] **Step 3: Controller only — create the owner runner script** (not committed) with exactly:

```bash
#!/usr/bin/env bash
# Owner-run: ! bash .superpowers/sdd/2026-10-09-aluminium-cost-catalog-phase-2b-screens/run-estimation-2b-tests.sh
# Add PHASE1_APPLIED=1 once the catalog migrations 2026-10-10-01..03 are applied for real,
# and PHASE2A_APPLIED=1 once 2026-10-11-01 is applied for real.
set -euo pipefail
cd "$(dirname "$0")/../../.."
REF=kntspldhvcjeaubtqtkn
OUT="$(mktemp -d)/est_2b_all.sql"
{
  echo 'BEGIN;'
  if [ "${PHASE1_APPLIED:-0}" != "1" ]; then
    for f in supabase/migrations/2026-10-10-0[123]-*.sql; do cat "$f"; done
  fi
  if [ "${PHASE2A_APPLIED:-0}" != "1" ]; then
    cat supabase/migrations/2026-10-11-01-estimation-catalog-expand.sql
  fi
  cat supabase/migrations/2026-10-12-01-estimation-2b-expand.sql
  cat supabase/tests/estimation_2b_expand_test.sql
  echo "SELECT 'ESTIMATION 2B TESTS PASSED' AS result;"
  echo 'ROLLBACK;'
} > "$OUT"
echo "== running in one rolled-back transaction (PHASE1_APPLIED=${PHASE1_APPLIED:-0}, PHASE2A_APPLIED=${PHASE2A_APPLIED:-0})"
npx supabase db query --project-ref "$REF" --linked=false -f "$OUT"
echo "== persistence check (expect leftover = 0; applied = 0 until you apply the migration for real)"
npx supabase db query --project-ref "$REF" --linked=false \
  "select (select count(*) from information_schema.columns where table_name='alu_profiles' and column_name='depth_mm') as applied, (select count(*) from tenants where company_name like '__EST2 TEST%') as leftover"

```

- [ ] **Step 4: Re-read both SQL files against the Interfaces list** (column names, CHECK lists, `ON DELETE` actions: joints SET NULL on components, project stock and profile files CASCADE on profile, settings part links SET NULL, layout types CASCADE). Fix any mismatch.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/2026-10-12-01-estimation-2b-expand.sql supabase/tests/estimation_2b_expand_test.sql
git commit -m "feat(estimation): migration #2 expand (profile dims, joints, settings, layout templates, previews)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

**Owner action (later, not an agent step):** `! bash .superpowers/sdd/2026-10-09-aluminium-cost-catalog-phase-2b-screens/run-estimation-2b-tests.sh` — expect `ESTIMATION 2B TESTS PASSED`, `leftover = 0`.


### Task 2: Catalog index keys, series views, sash-thickness inheritance, local date

**Files:**
- Create: `src/lib/estimationCatalogViews.js`
- Create: `src/lib/estimationCatalogViews.test.js`
- Create: `src/lib/aluCatalogIndex2b.test.js`
- Create: `src/lib/estimationInheritSash.test.js`
- Create: `src/lib/localDate.js`
- Create: `src/lib/localDate.test.js`
- Modify: `src/lib/aluCatalogPricing.js (3 lines)`
- Modify: `src/lib/estimationInherit.js (1 line)`
- Modify: `src/lib/estimationInherit.test.js (3 expected objects)`

**Interfaces:**
- Consumes: `buildCatalogIndex(rows)` from Phase 2a; `useEstimationCatalog()` already loads `types`, `seriesTypes`, `seriesParts`.
- Produces: `index.types`, `index.seriesTypesBySeries`, `index.seriesPartsBySeries`; `thicknessesForSeries`, `partsForSeries`, `hardwareSetsForSeries`, `hardwareForSeries`, `accessoriesForSeries`, `typesForSeries`, `seriesForType`, `allowsMixedThickness`; `localDateString(date)`.

What the screens may offer for a series (thicknesses, hardware sets, accessories, types), the sash thickness that inherits like every other default, and the local-date helper for `price_as_of`.

- [ ] **Step 1: Write the failing test** — create `src/lib/estimationCatalogViews.test.js` with exactly:

```js
import { describe, it, expect } from 'vitest'
import { buildCatalogIndex } from './aluCatalogPricing.js'
import {
  thicknessesForSeries, hardwareSetsForSeries, hardwareForSeries, accessoriesForSeries,
  typesForSeries, seriesForType, allowsMixedThickness,
} from './estimationCatalogViews.js'

const rows = {
  providers: [{ id: 'pA', name: 'A' }],
  series: [{ id: 's1', provider_id: 'pA', name: 'S1' }, { id: 's2', provider_id: 'pA', name: 'S2' }],
  types: [{ id: 't1', name: 'บานเลื่อน' }, { id: 't2', name: 'บานเปิด' }, { id: 't3', name: 'ปิดอยู่', active: false }],
  seriesTypes: [
    { series_id: 's1', type_id: 't1', allow_mixed_thickness: true },
    { series_id: 's1', type_id: 't2' },
    { series_id: 's1', type_id: 't3' },
    { series_id: 's2', type_id: 't1' },
  ],
  profiles: [
    { id: 'p1', provider_id: 'pA', thickness_mm: 1.2 }, { id: 'p2', provider_id: 'pA', thickness_mm: 1.5 },
    { id: 'p3', provider_id: 'pA', thickness_mm: 1.5 }, { id: 'p4', provider_id: 'pA', thickness_mm: 2, active: false },
    { id: 'p5', provider_id: 'pA', thickness_mm: null },
  ],
  seriesProfiles: ['p1', 'p2', 'p3', 'p4', 'p5'].map(profile_id => ({ series_id: 's1', profile_id })),
  parts: [
    { id: 'h1', name: 'ชุด B', kind: 'hardware_set' }, { id: 'h2', name: 'ชุด A', kind: 'hardware_set' },
    { id: 'h3', name: 'ล้อ', kind: 'hardware' }, { id: 'a1', name: 'shim', kind: 'accessory' },
    { id: 'h4', name: 'เลิกใช้', kind: 'hardware_set', active: false },
  ],
  seriesParts: [
    { series_id: 's1', type_id: 't1', part_id: 'h1' }, { series_id: 's1', type_id: null, part_id: 'h2' },
    { series_id: 's1', type_id: 't2', part_id: 'h3' }, { series_id: 's1', type_id: null, part_id: 'a1' },
    { series_id: 's1', type_id: 't1', part_id: 'h4' },
  ],
}
const index = buildCatalogIndex(rows)

describe('estimationCatalogViews', () => {
  it('lists distinct active thicknesses, ascending; no thickness / inactive profiles are skipped', () => {
    expect(thicknessesForSeries(index, 's1')).toEqual([1.2, 1.5])
    expect(thicknessesForSeries(index, 'nope')).toEqual([])
  })
  it('hardware sets: the type\'s links plus every-type links, active only, sorted by name', () => {
    expect(hardwareSetsForSeries(index, 's1', 't1').map(p => p.id)).toEqual(['h2', 'h1'])
    expect(hardwareSetsForSeries(index, 's1', 't2').map(p => p.id)).toEqual(['h2'])
  })
  it('with no type given every link of the series counts', () => {
    expect(hardwareSetsForSeries(index, 's1', null).map(p => p.id)).toEqual(['h2', 'h1'])
  })
  it('hardware and accessories are separate kinds', () => {
    expect(hardwareForSeries(index, 's1', 't2').map(p => p.id)).toEqual(['h3'])
    expect(hardwareForSeries(index, 's1', 't1')).toEqual([])
    expect(accessoriesForSeries(index, 's1', 't1').map(p => p.id)).toEqual(['a1'])
  })
  it('types for a series skip inactive types; series for a type lists every offering series', () => {
    expect(typesForSeries(index, 's1').map(t => t.id)).toEqual(['t2', 't1'])
    expect(seriesForType(index, 't1').map(s => s.id)).toEqual(['s1', 's2'])
    expect(seriesForType(index, 't2').map(s => s.id)).toEqual(['s1'])
  })
  it('mixed thickness is allowed only where the series-type link says so', () => {
    expect(allowsMixedThickness(index, 's1', 't1')).toBe(true)
    expect(allowsMixedThickness(index, 's1', 't2')).toBe(false)
    expect(allowsMixedThickness(index, 's2', 't9')).toBe(false)
  })
})
```

- [ ] **Step 2: Write the failing test** — create `src/lib/aluCatalogIndex2b.test.js` with exactly:

```js
// src/lib/aluCatalogIndex2b.test.js -- the index keys Phase 2b adds to buildCatalogIndex.
import { describe, it, expect } from 'vitest'
import { buildCatalogIndex } from './aluCatalogPricing.js'

describe('buildCatalogIndex Phase 2b keys', () => {
  it('indexes types by id and series types / series parts by series', () => {
    const i = buildCatalogIndex({
      types: [{ id: 't1', name: 'a' }],
      seriesTypes: [{ series_id: 's1', type_id: 't1' }, { series_id: 's1', type_id: 't2' }],
      seriesParts: [{ series_id: 's2', type_id: null, part_id: 'p1' }],
    })
    expect(i.types.t1.name).toBe('a')
    expect(i.seriesTypesBySeries.s1).toHaveLength(2)
    expect(i.seriesPartsBySeries.s2[0].part_id).toBe('p1')
  })
  it('missing tables give empty maps, never undefined', () => {
    const i = buildCatalogIndex({})
    expect(i.types).toEqual({})
    expect(i.seriesTypesBySeries).toEqual({})
    expect(i.seriesPartsBySeries).toEqual({})
  })
})
```

- [ ] **Step 3: Write the failing test** — create `src/lib/estimationInheritSash.test.js` with exactly:

```js
// src/lib/estimationInheritSash.test.js -- the sash thickness inherits like every other default (item -> project -> none).
import { describe, it, expect } from 'vitest'
import { resolveItemInputs } from './estimationInherit.js'

describe('resolveItemInputs sash thickness', () => {
  it('item value wins, then the project default, else null (null = same as the frame)', () => {
    expect(resolveItemInputs({ sash_thickness_mm: 1.5 }, { default_sash_thickness_mm: 2 }, null, {}).sash_thickness_mm).toBe(1.5)
    expect(resolveItemInputs({}, { default_sash_thickness_mm: '2' }, null, {}).sash_thickness_mm).toBe(2)
    expect(resolveItemInputs({}, {}, null, {}).sash_thickness_mm).toBeNull()
  })
  it('the frame thickness is unaffected', () => {
    expect(resolveItemInputs({ thickness_mm: 2 }, { default_sash_thickness_mm: 1.5 }, null, {}).thickness_mm).toBe(2)
  })
})
```

- [ ] **Step 4: Write the failing test** — create `src/lib/localDate.test.js` with exactly:

```js
import { describe, it, expect } from 'vitest'
import { localDateString } from './localDate.js'

describe('localDateString', () => {
  it('uses the local calendar day, zero-padded', () => {
    expect(localDateString(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05')
    expect(localDateString(new Date(2026, 9, 9, 0, 1))).toBe('2026-10-09')
  })
  it('a bad value gives null', () => {
    expect(localDateString(new Date('nope'))).toBeNull()
    expect(localDateString('2026-01-01')).toBeNull()
    expect(localDateString(null)).toBeNull()
  })
})
```

- [ ] **Step 5: Run it to confirm it fails**

Run: `npx vitest run src/lib/estimationCatalogViews.test.js src/lib/aluCatalogIndex2b.test.js src/lib/estimationInheritSash.test.js src/lib/localDate.test.js`
Expected: FAIL (module / export not found).

- [ ] **Step 6: Write the implementation** — create `src/lib/estimationCatalogViews.js` with exactly:

```js
// src/lib/estimationCatalogViews.js
// What the screens may offer for a series (and optionally a type). Pure; reads the index built by
// buildCatalogIndex (Task 2 adds types / seriesTypesBySeries / seriesPartsBySeries to it).

const byName = (a, b) => String(a.name ?? '').localeCompare(String(b.name ?? ''), 'th')

// Distinct thicknesses (mm, ascending) of the active profiles a series offers. One value = the screen locks it.
export function thicknessesForSeries(index, seriesId) {
  const seen = new Set()
  for (const l of index.seriesProfilesBySeries[seriesId] || []) {
    const p = index.profiles[l.profile_id]
    const t = p ? Number(p.thickness_mm) : NaN
    if (p && p.active !== false && Number.isFinite(t) && t > 0) seen.add(t)
  }
  return [...seen].sort((a, b) => a - b)
}

// Parts of one kind ('hardware' | 'hardware_set' | 'accessory') linked to the series. A link with
// type_id NULL means "every type"; with a typeId only NULL links and that type's links count; with no
// typeId every link of the series counts.
export function partsForSeries(index, seriesId, typeId, kind) {
  const out = new Map()
  for (const l of index.seriesPartsBySeries[seriesId] || []) {
    if (typeId && l.type_id && l.type_id !== typeId) continue
    const p = index.parts[l.part_id]
    if (p && p.active !== false && p.kind === kind) out.set(p.id, p)
  }
  return [...out.values()].sort(byName)
}
export const hardwareSetsForSeries = (index, seriesId, typeId) => partsForSeries(index, seriesId, typeId, 'hardware_set')
export const hardwareForSeries = (index, seriesId, typeId) => partsForSeries(index, seriesId, typeId, 'hardware')
export const accessoriesForSeries = (index, seriesId, typeId) => partsForSeries(index, seriesId, typeId, 'accessory')

export function typesForSeries(index, seriesId) {
  return (index.seriesTypesBySeries[seriesId] || [])
    .map(st => index.types[st.type_id])
    .filter(t => t && t.active !== false)
    .sort(byName)
}

export function seriesForType(index, typeId) {
  const out = []
  for (const [seriesId, links] of Object.entries(index.seriesTypesBySeries)) {
    const s = index.series[seriesId]
    if (s && s.active !== false && links.some(l => l.type_id === typeId)) out.push(s)
  }
  return out.sort(byName)
}

// Whether frame and sash of this series+type may use different thicknesses (owner: only where the type allows it).
export function allowsMixedThickness(index, seriesId, typeId) {
  const link = (index.seriesTypesBySeries[seriesId] || []).find(l => l.type_id === typeId)
  return !!(link && link.allow_mixed_thickness === true)
}
```

- [ ] **Step 7: Write the implementation** — create `src/lib/localDate.js` with exactly:

```js
// src/lib/localDate.js
// 'YYYY-MM-DD' in the viewer's LOCAL time zone. A Postgres DEFAULT current_date is the UTC date, which is the
// wrong day for a Thai user before 07:00, so price_as_of is always set from here at project creation.
export function localDateString(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
```

- [ ] **Step 8: Add the sash thickness to inheritance** — in `src/lib/estimationInherit.js`, in `resolveItemInputs`, directly after the `thickness_mm: firstNum(it.thickness_mm, pj.default_thickness_mm),` line add:

```js
    sash_thickness_mm: firstNum(it.sash_thickness_mm, pj.default_sash_thickness_mm),
```

The three exact-equality expectations in `src/lib/estimationInherit.test.js` (`an empty item inherits everything...`, `explicit item values win`, `missing everywhere gives nulls...`) now also receive `sash_thickness_mm: null`: add `sash_thickness_mm: null,` right after the `thickness_mm: <value>,` entry in each of those three expected objects (nothing else in that file changes).

- [ ] **Step 9: Add the three index keys** — in `src/lib/aluCatalogPricing.js`, inside `buildCatalogIndex`, directly after the line `parts: byId(rows.parts),` insert:

```js
    types: byId(rows.types),
    seriesTypesBySeries: groupBy(rows.seriesTypes, 'series_id'),
    seriesPartsBySeries: groupBy(rows.seriesParts, 'series_id'),
```

- [ ] **Step 10: Run the tests, then the whole suite and the build**

Run: `npx vitest run src/lib/estimationCatalogViews.test.js src/lib/aluCatalogIndex2b.test.js src/lib/estimationInheritSash.test.js src/lib/localDate.test.js` — Expected: all PASS.
Run: `npm test` and `npm run build` — Expected: all existing tests still pass, build OK.

- [ ] **Step 11: Commit**

```bash
git add src/lib/estimationCatalogViews.js src/lib/estimationCatalogViews.test.js src/lib/aluCatalogIndex2b.test.js src/lib/estimationInheritSash.test.js src/lib/estimationInherit.js src/lib/estimationInherit.test.js src/lib/localDate.js src/lib/localDate.test.js src/lib/aluCatalogPricing.js
git commit -m "feat(estimation): series views (thicknesses, sets, accessories, types) and local date helper

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```


### Task 3: Assembly logic (joints, role thickness) and the engine seams

**Files:**
- Create: `src/lib/assembly.js`
- Create: `src/lib/assembly.test.js`
- Create: `src/lib/bomEngineAssembly.test.js`
- Modify: `src/lib/bomEngine.js`

**Interfaces:**
- Consumes: `resolveCatalogProfile(index, seriesId, family, thicknessMm)` (Phase 2a).
- Produces: `jointDeductionMm(joint, mainProfile)`, `applyJoints({components, joints, index, seriesId, thicknessMm}) -> {components, issues}`, `applyRoleThickness(components, {allowMixed, sashThicknessMm})`; every profile line from `computeBomForOpening` now carries `cut_style` (`square` default).

The owner's joint rule: the main bar runs full length; the secondary bar is shortened, per end, by the dimension perpendicular to the main bar's primary contact surface (auto) or a manual value. Sash-role components take the sash thickness where the series+type allows it. The engine itself stays "one opening in, one BOM out": callers run `applyJoints` first, so it sees ordinary deductions.

- [ ] **Step 1: Write the failing test** — create `src/lib/assembly.test.js` with exactly:

```js
import { describe, it, expect } from 'vitest'
import { buildCatalogIndex } from './aluCatalogPricing.js'
import { jointDeductionMm, applyJoints, applyRoleThickness } from './assembly.js'

const index = buildCatalogIndex({
  series: [{ id: 's1', provider_id: 'pA' }],
  profiles: [
    { id: 'box', provider_id: 'pA', family: 'กล่องเรียบ', thickness_mm: 1.5, depth_mm: 44.45, width_mm: 101.6, primary_contact: 'width' },
    { id: 'boxn', provider_id: 'pA', family: 'กล่องแคบ', thickness_mm: 1.5, depth_mm: 44.45, width_mm: 101.6, primary_contact: 'depth' },
    { id: 'nodim', provider_id: 'pA', family: 'ไม่มีมิติ', thickness_mm: 1.5 },
  ],
  seriesProfiles: ['box', 'boxn', 'nodim'].map(profile_id => ({ series_id: 's1', profile_id })),
})
const joint = (o = {}) => ({ id: 'j1', main_family: 'กล่องเรียบ', secondary_family: 'x', deduction_mode: 'auto', cut_style: 'square', ...o })

describe('jointDeductionMm', () => {
  it('auto: a bar butting the WIDE face (101.6) is shortened by the depth (44.45); butting the narrow face by the width', () => {
    expect(jointDeductionMm(joint(), index.profiles.box)).toEqual({ mm: 44.45, source: 'auto' })
    expect(jointDeductionMm(joint(), index.profiles.boxn)).toEqual({ mm: 101.6, source: 'auto' })
  })
  it('a profile with no primary_contact set behaves as the default (wide face)', () => {
    expect(jointDeductionMm(joint(), { width_mm: 101.6, depth_mm: 44.45 }).mm).toBe(44.45)
  })
  it('manual wins and must be a number >= 0; 0 is allowed', () => {
    expect(jointDeductionMm(joint({ deduction_mode: 'manual', deduction_mm: 3 }), null)).toEqual({ mm: 3, source: 'manual' })
    expect(jointDeductionMm(joint({ deduction_mode: 'manual', deduction_mm: 0 }), null).mm).toBe(0)
    expect(jointDeductionMm(joint({ deduction_mode: 'manual', deduction_mm: '' }), null)).toEqual({ mm: null, reason: 'bad_manual_deduction' })
  })
  it('a 45 degree mitre needs no deduction; missing profile or dimension is a named reason, never 0', () => {
    expect(jointDeductionMm(joint({ cut_style: 'miter45' }), null)).toEqual({ mm: 0, source: 'miter' })
    expect(jointDeductionMm(joint(), null)).toEqual({ mm: null, reason: 'no_main_profile' })
    expect(jointDeductionMm(joint(), index.profiles.nodim)).toEqual({ mm: null, reason: 'no_dimension' })
    expect(jointDeductionMm(undefined, null)).toEqual({ mm: null, reason: 'unknown_joint' })
  })
})

describe('applyJoints', () => {
  const base = { role_name: 'เส้นนอน', profile_family: 'x', length_rule_type: 'width', length_deduction_mm: 0, quantity_basis: 'fixed', quantity_value: 2 }
  const run = (c, j = joint()) => applyJoints({ components: [c], joints: [j], index, seriesId: 's1', thicknessMm: 1.5 })

  it('turns width into width_minus with deduction x 2 ends and carries the cut style', () => {
    const { components, issues } = run({ ...base, joint_id: 'j1' }, joint({ cut_style: 'notch', notch_width_mm: 40, notch_depth_mm: 20 }))
    expect(issues).toEqual([])
    expect(components[0]).toMatchObject({ length_rule_type: 'width_minus', length_deduction_mm: 88.9, cut_style: 'notch', notch_width_mm: 40, notch_depth_mm: 20 })
  })
  it('joint_ends 1 takes the deduction once; an existing width_minus deduction is kept and added to', () => {
    expect(run({ ...base, joint_id: 'j1', joint_ends: 1 }).components[0].length_deduction_mm).toBe(44.45)
    expect(run({ ...base, joint_id: 'j1', length_rule_type: 'height_minus', length_deduction_mm: 10 }).components[0]).toMatchObject({ length_rule_type: 'height_minus', length_deduction_mm: 98.9 })
  })
  it('a component without a joint is unchanged except for a default square cut', () => {
    expect(run(base).components[0]).toEqual({ ...base, cut_style: 'square' })
  })
  it('an unresolvable joint leaves the component as written and reports why', () => {
    const r = run({ ...base, joint_id: 'gone' })
    expect(r.components[0]).toMatchObject({ length_rule_type: 'width', length_deduction_mm: 0, cut_style: 'square' })
    expect(r.issues).toEqual([{ role_name: 'เส้นนอน', reason: 'unknown_joint' }])
    expect(run({ ...base, joint_id: 'j1' }, joint({ main_family: 'ไม่มีมิติ' })).issues[0].reason).toBe('no_dimension')
    expect(run({ ...base, joint_id: 'j1', length_rule_type: 'perimeter' }).issues[0].reason).toBe('rule_not_cuttable')
  })
  it('the main bar is looked up at the frame thickness, whatever thickness the secondary bar has', () => {
    expect(run({ ...base, joint_id: 'j1', thickness_mm: 2 }).issues).toEqual([])
    const other = applyJoints({ components: [{ ...base, joint_id: 'j1' }], joints: [joint()], index, seriesId: 's1', thicknessMm: 2 })
    expect(other.issues[0].reason).toBe('no_main_profile')
  })
})

describe('applyRoleThickness', () => {
  const cs = [{ role_name: 'frame' }, { role_name: 'sash', thickness_role: 'sash' }]
  it('sash-role components get the sash thickness where mixed thickness is allowed; the frame keeps the opening thickness', () => {
    expect(applyRoleThickness(cs, { allowMixed: true, sashThicknessMm: 1.5 }).map(c => c.thickness_mm)).toEqual([null, 1.5])
  })
  it('without permission, or without a sash thickness, every component uses the opening thickness', () => {
    expect(applyRoleThickness(cs, { allowMixed: false, sashThicknessMm: 1.5 }).map(c => c.thickness_mm)).toEqual([null, null])
    expect(applyRoleThickness(cs, { allowMixed: true, sashThicknessMm: null }).map(c => c.thickness_mm)).toEqual([null, null])
    expect(applyRoleThickness(cs).map(c => c.thickness_mm)).toEqual([null, null])
  })
  it('an old thickness_mm on a component never leaks through', () => {
    expect(applyRoleThickness([{ role_name: 'x', thickness_mm: 2 }], { allowMixed: true, sashThicknessMm: 1.5 })[0].thickness_mm).toBeNull()
  })
})

describe('applyJoints: main bar thickness and mitre', () => {
  const comp = (o = {}) => ({ role_name: 'r', profile_family: 'x', length_rule_type: 'width', length_deduction_mm: 0, quantity_basis: 'fixed', quantity_value: 1, ...o })
  const sashIndex = buildCatalogIndex({
    series: [{ id: 's1', provider_id: 'pA' }],
    profiles: [{ id: 'sbox', provider_id: 'pA', family: 'กล่องเฉพาะบาน', thickness_mm: 1.5, depth_mm: 30, width_mm: 80, primary_contact: 'width' }],
    seriesProfiles: [{ series_id: 's1', profile_id: 'sbox' }],
  })
  const j = o => joint({ main_family: 'กล่องเฉพาะบาน', ...o })
  const go = (components, jo, idx = sashIndex) => applyJoints({ components, joints: [jo], index: idx, seriesId: 's1', thicknessMm: 2 })
  it('the main bar is looked up at the thickness of its own components (sash 1.5 while the frame is 2)', () => {
    const r = go([comp({ role_name: 'main', profile_family: 'กล่องเฉพาะบาน', thickness_mm: 1.5 }), comp({ joint_id: 'j1' })], j())
    expect(r.issues).toEqual([])
    expect(r.components[1].length_deduction_mm).toBe(60)
  })
  it('with no component of the main family, the frame thickness is used', () => {
    expect(go([comp({ joint_id: 'j1' })], j()).issues[0].reason).toBe('no_main_profile')
  })
  it('a main-family component without its own thickness uses the frame thickness', () => {
    const r = go([comp({ profile_family: 'กล่องเฉพาะบาน', thickness_mm: null }), comp({ joint_id: 'j1' })], j())
    expect(r.issues[0].reason).toBe('no_main_profile')
  })
  it('a mitre joint marks the main-family bars 45 degrees as well; others stay square', () => {
    const r = go([comp({ role_name: 'main', profile_family: 'กล่องเฉพาะบาน' }), comp({ role_name: 'sec', joint_id: 'j1' }), comp({ role_name: 'other', profile_family: 'zzz' })], j({ cut_style: 'miter45' }))
    expect(r.components.map(c => c.cut_style)).toEqual(['miter45', 'miter45', 'square'])
    expect(r.components[0].length_deduction_mm).toBe(0)
    expect(r.components[1].length_deduction_mm).toBe(0)
  })
  it('a main bar keeps a non-square cut from its own joint', () => {
    const joints = [j({ cut_style: 'miter45' }), j({ id: 'j2', cut_style: 'notch', notch_width_mm: 5, notch_depth_mm: 5, secondary_family: 'q' })]
    const r = applyJoints({ components: [comp({ role_name: 'main', profile_family: 'กล่องเฉพาะบาน', joint_id: 'j2', thickness_mm: 1.5 }), comp({ joint_id: 'j1' })], joints, index: sashIndex, seriesId: 's1', thicknessMm: 2 })
    expect(r.components[0].cut_style).toBe('notch')
  })
})

describe('applyJoints: mitre only flips main bars without their own joint', () => {
  const comp = (o = {}) => ({ role_name: 'r', profile_family: 'x', length_rule_type: 'width', length_deduction_mm: 0, quantity_basis: 'fixed', quantity_value: 1, ...o })
  it('a main-family bar linked to a square joint stays square; one with no joint flips', () => {
    const joints = [joint({ id: 'jm', cut_style: 'miter45' }), joint({ id: 'js', cut_style: 'square' })]
    const r = applyJoints({ components: [comp({ profile_family: 'กล่องเรียบ', joint_id: 'js' }), comp({ profile_family: 'กล่องเรียบ' })], joints, index, seriesId: 's1', thicknessMm: 1.5 })
    expect(r.components.map(c => c.cut_style)).toEqual(['square', 'miter45'])
  })
  it('a component whose own joint cannot be resolved stays square', () => {
    const r = applyJoints({ components: [comp({ profile_family: 'กล่องเรียบ', joint_id: 'gone' })], joints: [joint({ cut_style: 'miter45' })], index, seriesId: 's1', thicknessMm: 1.5 })
    expect(r.components[0].cut_style).toBe('square')
  })
  it('a mitre joint with no main_family flips nothing', () => {
    const r = applyJoints({ components: [comp({ profile_family: undefined }), comp({ profile_family: '' })], joints: [joint({ cut_style: 'miter45', main_family: '' })], index, seriesId: 's1', thicknessMm: 1.5 })
    expect(r.components.map(c => c.cut_style)).toEqual(['square', 'square'])
  })
})
```

- [ ] **Step 2: Write the failing test** — create `src/lib/bomEngineAssembly.test.js` with exactly:

```js
// src/lib/bomEngineAssembly.test.js -- Phase 2b engine seams: per-role thickness and the cut style carried to the cut optimizer.
import { describe, it, expect } from 'vitest'
import { computeBomForOpening, legacyPricing } from './bomEngine.js'

const P12 = { family: 'F', series: 'S', thickness_mm: 1.2, linear_weight_kg_per_m: 1 }
const P20 = { family: 'F', series: 'S', thickness_mm: 2, linear_weight_kg_per_m: 2 }
const FINISH = { price_per_kg: 100 }
const tpl = { waste_pct: 0, infill_width_deduction_mm: 0, infill_height_deduction_mm: 0, labor_price_per_sqm: 0, silicone_price_per_m: 0, felt_price_per_m: 0, grid_row_weights: [1] }
const opening = { width_m: 2, height_m: 1, panel_count: 1, series: 'S', thickness_mm: 1.2, quantity: 1, extra_lines: [] }
const comp = (o = {}) => ({ role_name: 'r', profile_family: 'F', length_rule_type: 'width', length_deduction_mm: 0, quantity_basis: 'fixed', quantity_value: 1, ...o })
const run = components => computeBomForOpening(opening, tpl, components, [], legacyPricing([P12, P20], FINISH), null)

describe('per-role thickness', () => {
  it('a component with its own thickness is priced from that profile; the others use the opening thickness', () => {
    const r = run([comp({ role_name: 'frame' }), comp({ role_name: 'sash', thickness_mm: 2 })])
    expect(r.profileLines[0].thickness_mm).toBe(1.2)
    expect(r.profileLines[0].cost).toBe(2 * 1 * 100)
    expect(r.profileLines[1].thickness_mm).toBe(2)
    expect(r.profileLines[1].cost).toBe(2 * 2 * 100)
  })
  it('a null component thickness means "use the opening thickness"', () => {
    expect(run([comp({ thickness_mm: null })]).profileLines[0].thickness_mm).toBe(1.2)
  })
  it('an override thickness with no matching profile is unresolved, not silently the opening thickness', () => {
    const r = run([comp({ thickness_mm: 3 })])
    expect(r.profileLines[0].resolved).toBe(false)
    expect(r.unresolvedComponents).toEqual(['r'])
  })
})

describe('cut style on profile lines', () => {
  it('defaults to square and carries the component cut_style (grid lines are square)', () => {
    const r = run([comp(), comp({ role_name: 'm', cut_style: 'miter45' })])
    expect(r.profileLines.map(l => l.cut_style)).toEqual(['square', 'miter45'])
  })
  it('grid members are square cuts', () => {
    const t = { ...tpl, grid_row_weights: [1, 1], grid_horizontal_rail_family: 'F' }
    expect(computeBomForOpening(opening, t, [], [], legacyPricing([P12], FINISH), null).gridLines[0].cut_style).toBe('square')
  })
})

describe('hardware lines carry part_id', () => {
  it('part_id is passed through, null when absent', () => {
    const r = computeBomForOpening(opening, tpl, [], [{ name: 'a', part_id: 'p1', quantity_basis: 'fixed', quantity_value: 1 }, { name: 'b', quantity_basis: 'fixed', quantity_value: 1 }], legacyPricing([P12], FINISH), null)
    expect(r.hardwareLines.map(l => l.part_id)).toEqual(['p1', null])
  })
})
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `npx vitest run src/lib/assembly.test.js src/lib/bomEngineAssembly.test.js`
Expected: FAIL (module / export not found).

- [ ] **Step 4: Write the implementation** — create `src/lib/assembly.js` with exactly:

```js
// src/lib/assembly.js
// Joint (butt) logic for a template: which bar is the main bar, how much the secondary bar is shortened,
// how its end is cut. Pure. The engine stays as it is: callers run applyJoints / applyRoleThickness on the
// template's components BEFORE computeBomForOpening, which then sees ordinary length_deduction_mm values.
import { resolveCatalogProfile } from './aluCatalogPricing.js'

const finitePos = n => Number.isFinite(n) && n >= 0

// Deduction (mm) taken off ONE end of the secondary bar. The profile records its PRIMARY CONTACT SURFACE: the face the
// secondary bar butts against. The bar is shortened by the dimension perpendicular to that face:
//   primary_contact 'width' (default) = it butts the wide face  -> shortened by depth_mm   (e.g. 101.6 face -> 44.45)
//   primary_contact 'depth'           = it butts the narrow face -> shortened by width_mm
// A mitre needs no deduction here; manual wins.
export function jointDeductionMm(joint, mainProfile) {
  if (!joint) return { mm: null, reason: 'unknown_joint' }
  if (joint.deduction_mode === 'manual') {
    const raw = joint.deduction_mm
    const n = raw === null || raw === undefined || raw === '' ? NaN : Number(raw)
    return finitePos(n) ? { mm: n, source: 'manual' } : { mm: null, reason: 'bad_manual_deduction' }
  }
  if (joint.cut_style === 'miter45') return { mm: 0, source: 'miter' }
  if (!mainProfile) return { mm: null, reason: 'no_main_profile' }
  const dim = Number(mainProfile.primary_contact === 'depth' ? mainProfile.width_mm : mainProfile.depth_mm)
  return dim > 0 ? { mm: dim, source: 'auto' } : { mm: null, reason: 'no_dimension' }
}

const SHORTEN = { width: 'width_minus', height: 'height_minus', width_minus: 'width_minus', height_minus: 'height_minus' }

// Returns { components, issues }. A component with a joint_id gets its deduction from the joint
// (per end x joint_ends, default 2), and carries the joint's cut style / notch size for the cut optimizer.
// A joint that cannot be resolved leaves the component exactly as the template wrote it and lists an issue.
export function applyJoints({ components, joints, index, seriesId, thicknessMm }) {
  const jointsById = {}
  for (const j of joints || []) jointsById[j.id] = j
  const issues = []
  // the thickness each profile family is built at (a sash-role bar may differ from the frame); first component wins
  const familyThickness = {}
  for (const c of components || []) {
    if (c.profile_family && !(c.profile_family in familyThickness)) familyThickness[c.profile_family] = c.thickness_mm != null ? c.thickness_mm : thicknessMm
  }
  const miterMains = new Set((joints || []).filter(j => j.cut_style === 'miter45' && j.main_family).map(j => j.main_family))
  const out = (components || []).map(c => {
    if (!c.joint_id) return { ...c, cut_style: c.cut_style || 'square' }
    const joint = jointsById[c.joint_id]
    const rule = SHORTEN[c.length_rule_type]
    if (!rule) { issues.push({ role_name: c.role_name, reason: 'rule_not_cuttable' }); return { ...c, cut_style: 'square' } }
    // the main bar is looked up at the thickness of its own components (frame by default, sash where the main bars are
    // sash-role); the secondary bar's own thickness does not move it
    const main = joint ? resolveCatalogProfile(index, seriesId, joint.main_family, familyThickness[joint.main_family] ?? thicknessMm).profile : null
    const ded = jointDeductionMm(joint, main)
    if (ded.mm === null) { issues.push({ role_name: c.role_name, reason: ded.reason }); return { ...c, cut_style: 'square' } }
    const ends = Number(c.joint_ends) === 1 ? 1 : 2
    const base = c.length_rule_type === 'width' || c.length_rule_type === 'height' ? 0 : Number(c.length_deduction_mm) || 0
    return {
      ...c, length_rule_type: rule, length_deduction_mm: base + ded.mm * ends,
      cut_style: joint.cut_style || 'square', notch_width_mm: joint.notch_width_mm ?? null, notch_depth_mm: joint.notch_depth_mm ?? null,
    }
  })
  // a mitre joint cuts the main bars at 45 degrees too (their lengths are unchanged); a bar with its own joint keeps what that joint gave it
  const withMitreMains = out.map(c => (!c.joint_id && miterMains.has(c.profile_family) && (c.cut_style || 'square') === 'square' ? { ...c, cut_style: 'miter45' } : c))
  return { components: withMitreMains, issues }
}

// Government-style specs fix the frame and the sash separately (e.g. frame 2.0 mm, sash 1.5 mm). A template component
// is tagged thickness_role 'sash' (or NULL = frame/main). Where the series+type allows mixed thickness and a sash
// thickness is set, sash-role components are priced at that thickness; every other case uses the opening thickness.
// The engine reads the resulting component.thickness_mm (NULL = the opening thickness).
export function applyRoleThickness(components, { allowMixed, sashThicknessMm } = {}) {
  const sash = Number(sashThicknessMm)
  return (components || []).map(c => ({ ...c, thickness_mm: c.thickness_role === 'sash' && allowMixed && sash > 0 ? sash : null }))
}
```

- [ ] **Step 5: Edit `src/lib/bomEngine.js`** — two edits.

(a) Replace the whole `priceProfileLine` function (it is just above `computeBomForOpening`) with:

```js
// A component may carry its own thickness (frame vs sash, only where the type allows it; see assembly.applyRoleThickness);
// otherwise the opening's single thickness applies.
function priceProfileLine({ role_name, family, length_m, quantity, pricing, opening, thickness_mm, cut_style }) {
  const line = pricing.profileLine({ role_name, family, length_m, quantity, thickness_mm: thickness_mm != null ? thickness_mm : opening.thickness_mm, opening })
  return { ...line, cut_style: cut_style || 'square' }
}
```

(b) In `computeBomForOpening`, in the `profileLines` map, replace the `return priceProfileLine({ role_name: c.role_name, ... })` line with:

```js
    return priceProfileLine({ role_name: c.role_name, family: c.profile_family, length_m, quantity, pricing, opening, thickness_mm: c.thickness_mm, cut_style: c.cut_style })
```

(c) In the `hardwareLines` map, add `part_id: h.part_id || null` to the returned object (Follow-up A).

The grid members (`gridLines`) keep calling `priceProfileLine` without `thickness_mm` / `cut_style`, so they use the opening thickness and are square cuts.

- [ ] **Step 6: Run the tests, then the whole suite and the build**

Run: `npx vitest run src/lib/assembly.test.js src/lib/bomEngineAssembly.test.js` — Expected: all PASS.
Run: `npm test` and `npm run build` — Expected: all existing tests still pass, build OK.

- [ ] **Step 7: Commit**

```bash
git add src/lib/assembly.js src/lib/assembly.test.js src/lib/bomEngineAssembly.test.js src/lib/bomEngine.js
git commit -m "feat(estimation): joint deductions, role thickness and cut style on profile lines

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```


### Task 4: Tenant settings and accessory extras (fixing points, sealant)

**Files:**
- Create: `src/lib/estimationSettings.js`
- Create: `src/lib/estimationSettings.test.js`
- Create: `src/lib/openingExtras.js`
- Create: `src/lib/openingExtras.test.js`

**Interfaces:**
- Consumes: `pricing.hardwarePrice({part_id, reference_unit_price})` from `makeCatalogPricing`.
- Produces: `DEFAULT_SETTINGS`, `mergeSettings(row)`; `fixingPointsForSide`, `frameFixingPoints`, `sealantTubes`, `openingExtras({units, settings, partsById, pricing})`.

Owner rules: shim + screw + plastic plug at every fixing point (every 60 cm, at least 2 per side); sealant length = opening perimeter, converted to 300 ml tubes (10 m each) once per project. Off until the parts are linked (Ruling 8). The 45° kerf default is 10 mm (owner estimate) and mitred pieces are always listed by outer length (Ruling 6).

- [ ] **Step 1: Write the failing test** — create `src/lib/estimationSettings.test.js` with exactly:

```js
import { describe, it, expect } from 'vitest'
import { DEFAULT_SETTINGS, mergeSettings } from './estimationSettings.js'

describe('mergeSettings', () => {
  it('no row gives the defaults', () => {
    expect(mergeSettings(null)).toEqual(DEFAULT_SETTINGS)
    expect(DEFAULT_SETTINGS.stock_length_m).toBe(6.4)
    expect(DEFAULT_SETTINGS.sealant_m_per_tube).toBe(10)
    expect(DEFAULT_SETTINGS.fixing_pitch_m).toBe(0.6)
  })
  it('numeric strings from the DB are coerced; 0 is a real kerf', () => {
    const s = mergeSettings({ stock_length_m: '6', kerf_square_mm: '0', fixing_min_per_side: '3' })
    expect(s.stock_length_m).toBe(6)
    expect(s.kerf_square_mm).toBe(0)
    expect(s.fixing_min_per_side).toBe(3)
  })
  it('invalid values fall back instead of becoming NaN / 0 / negative', () => {
    const s = mergeSettings({ stock_length_m: 0, sealant_m_per_tube: -1, fixing_pitch_m: 'abc', kerf_miter_mm: -2, fixing_min_per_side: 0 })
    expect(s.stock_length_m).toBe(6.4)
    expect(s.sealant_m_per_tube).toBe(10)
    expect(s.fixing_pitch_m).toBe(0.6)
    expect(s.kerf_miter_mm).toBe(10)
    expect(s.fixing_min_per_side).toBe(2)
  })
  it('part links pass through, empty becomes null', () => {
    expect(mergeSettings({ shim_part_id: 'p1', screw_part_id: '' }).shim_part_id).toBe('p1')
    expect(mergeSettings({ screw_part_id: '' }).screw_part_id).toBeNull()
  })
})
```

- [ ] **Step 2: Write the failing test** — create `src/lib/openingExtras.test.js` with exactly:

```js
import { describe, it, expect } from 'vitest'
import { mergeSettings } from './estimationSettings.js'
import { fixingPointsForSide, frameFixingPoints, sealantTubes, openingExtras } from './openingExtras.js'

const S = mergeSettings(null)
const pricing = { hardwarePrice: h => (h.part_id === 'shim' ? { unit_price: 2, source: 'part' } : { unit_price: 0, source: 'reference' }) }

describe('fixing points', () => {
  it('every 60 cm, at least 2 per side (the mockup table: 2.40->5, 2.10->5, 1.20->3, 1.00->3, 0.40->2)', () => {
    const f = l => fixingPointsForSide(l, 0.6, 2)
    expect([f(2.4), f(2.1), f(1.2), f(1.0), f(0.4)]).toEqual([5, 5, 3, 3, 2])
  })
  it('a side of 0 / negative / NaN has no points; a very short side still gets the minimum', () => {
    expect([fixingPointsForSide(0, 0.6, 2), fixingPointsForSide(-1, 0.6, 2), fixingPointsForSide(NaN, 0.6, 2)]).toEqual([0, 0, 0])
    expect(fixingPointsForSide(0.1, 0.6, 2)).toBe(2)
  })
  it('a frame totals 2 x width side + 2 x height side (D-01 2.40 x 2.10 = 20)', () => {
    expect(frameFixingPoints(2.4, 2.1, S)).toBe(20)
    expect(frameFixingPoints(1.2, 1.0, S)).toBe(12)
  })
})

describe('sealantTubes', () => {
  it('rounds the project total up once (14 m at 10 m per tube = 2)', () => {
    expect(sealantTubes(14, 10)).toBe(2)
    expect(sealantTubes(10, 10)).toBe(1)
    expect(sealantTubes(0, 10)).toBe(0)
  })
})

describe('openingExtras', () => {
  const parts = { shim: { name: 'shim', unit: 'ตัว' }, screw: { name: 'สกรู', unit: 'ตัว' } }
  it('does nothing until parts are linked', () => {
    const r = openingExtras({ units: [{ width_m: 2.4, height_m: 2.1 }], settings: S, partsById: parts, pricing })
    expect(r.lines).toEqual([])
    expect(r.points).toBe(20)
    expect(r.sealant_m).toBeCloseTo(9, 9)
    expect(r.cost).toBe(0)
  })
  it('prices a linked part and lists an unpriced one instead of using 0 silently', () => {
    const r = openingExtras({ units: [{ width_m: 2.4, height_m: 2.1 }], settings: { ...S, shim_part_id: 'shim', screw_part_id: 'screw' }, partsById: parts, pricing })
    expect(r.lines.map(l => [l.key, l.quantity, l.cost, l.resolved])).toEqual([['shim', 20, 40, true], ['screw', 20, 0, false]])
    expect(r.cost).toBe(40)
    expect(r.unresolved).toEqual([{ name: 'สกรู', reason: 'no_part_price' }])
  })
  it('the add-on is its own frame: points and sealant add up; an invalid unit is ignored', () => {
    const r = openingExtras({ units: [{ width_m: 1.2, height_m: 1.0 }, { width_m: 1.2, height_m: 0.4 }, { width_m: 0, height_m: 1 }], settings: S, partsById: parts, pricing })
    expect(r.points).toBe(12 + 2 * 3 + 2 * 2)
    expect(r.sealant_m).toBeCloseTo(2 * 2.2 + 2 * 1.6, 9)
  })
})
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `npx vitest run src/lib/estimationSettings.test.js src/lib/openingExtras.test.js`
Expected: FAIL (module / export not found).

- [ ] **Step 4: Write the implementation** — create `src/lib/estimationSettings.js` with exactly:

```js
// src/lib/estimationSettings.js
// Tenant-wide estimation constants (one row in estimation_settings; every value is universal, not per project).
// The kerf numbers are PLACEHOLDERS until the owner measures his saw: a 45 degree cut wastes more (owner estimate ~10 mm).
// A mitred piece's length must always be its OUTER (long-point) length; mixing inner and outer lengths causes large errors.
export const DEFAULT_SETTINGS = {
  stock_length_m: 6.4,
  kerf_square_mm: 3,
  kerf_miter_mm: 10,
  min_keep_offcut_m: 0.5,
  sealant_m_per_tube: 10,
  fixing_pitch_m: 0.6,
  fixing_min_per_side: 2,
  sealant_part_id: null,
  shim_part_id: null,
  screw_part_id: null,
  plug_part_id: null,
}

const num = (v, fallback, ok) => { const n = Number(v); return v !== null && v !== undefined && v !== '' && Number.isFinite(n) && ok(n) ? n : fallback }

// Fills every missing / invalid field from DEFAULT_SETTINGS so callers never see NaN or undefined.
export function mergeSettings(row) {
  const r = row || {}
  const d = DEFAULT_SETTINGS
  return {
    stock_length_m: num(r.stock_length_m, d.stock_length_m, n => n > 0),
    kerf_square_mm: num(r.kerf_square_mm, d.kerf_square_mm, n => n >= 0),
    kerf_miter_mm: num(r.kerf_miter_mm, d.kerf_miter_mm, n => n >= 0),
    min_keep_offcut_m: num(r.min_keep_offcut_m, d.min_keep_offcut_m, n => n >= 0),
    sealant_m_per_tube: num(r.sealant_m_per_tube, d.sealant_m_per_tube, n => n > 0),
    fixing_pitch_m: num(r.fixing_pitch_m, d.fixing_pitch_m, n => n > 0),
    fixing_min_per_side: Math.floor(num(r.fixing_min_per_side, d.fixing_min_per_side, n => n >= 1)),
    sealant_part_id: r.sealant_part_id || null,
    shim_part_id: r.shim_part_id || null,
    screw_part_id: r.screw_part_id || null,
    plug_part_id: r.plug_part_id || null,
  }
}
```

- [ ] **Step 5: Write the implementation** — create `src/lib/openingExtras.js` with exactly:

```js
// src/lib/openingExtras.js
// Accessories the template does not list but the owner's rules imply: plastic shim + screw + plastic
// plug at every fixing point (one of each per point), and the sealant length around the opening.
// Pure. Off until the tenant links the parts in estimation_settings (a null part id = no line).

// Points along one side: one every `pitchM`, at least `minPerSide` (owner: every 60 cm, min 2 per side).
export function fixingPointsForSide(lengthM, pitchM, minPerSide) {
  const len = Number(lengthM)
  if (!(len > 0)) return 0
  return Math.max(minPerSide, Math.ceil(len / pitchM - 1e-9) + 1)
}

// Four sides of a rectangular frame: top/bottom run `width`, left/right run `height`.
export function frameFixingPoints(widthM, heightM, settings) {
  return 2 * fixingPointsForSide(widthM, settings.fixing_pitch_m, settings.fixing_min_per_side)
    + 2 * fixingPointsForSide(heightM, settings.fixing_pitch_m, settings.fixing_min_per_side)
}

export const sealantTubes = (totalLengthM, mPerTube) => (totalLengthM > 0 ? Math.ceil(totalLengthM / mPerTube - 1e-9) : 0)

// units: [{ width_m, height_m }] -- the main opening and, when present, the add-on (its own frame).
// Returns the fixing-point count, the sealant length (opening perimeters) and a priced line per linked part.
export function openingExtras({ units, settings, partsById, pricing }) {
  const valid = (units || []).filter(u => u && u.width_m > 0 && u.height_m > 0)
  const points = valid.reduce((s, u) => s + frameFixingPoints(u.width_m, u.height_m, settings), 0)
  const sealant_m = valid.reduce((s, u) => s + 2 * (u.width_m + u.height_m), 0)
  const spec = [
    ['shim', settings.shim_part_id, points], ['screw', settings.screw_part_id, points], ['plug', settings.plug_part_id, points],
  ]
  const lines = spec.filter(([, partId, qty]) => partId && qty > 0).map(([key, partId, quantity]) => {
    const part = (partsById || {})[partId]
    const hp = pricing.hardwarePrice({ part_id: partId, reference_unit_price: 0 })
    const resolved = hp.source === 'part'
    return {
      key, part_id: partId, name: part ? part.name : '?', unit: part ? part.unit : null, quantity,
      unit_price: resolved ? hp.unit_price : 0, cost: resolved ? quantity * hp.unit_price : 0,
      resolved, reason: resolved ? null : 'no_part_price',
    }
  })
  return { points, sealant_m, lines, cost: lines.reduce((s, l) => s + l.cost, 0), unresolved: lines.filter(l => !l.resolved).map(l => ({ name: l.name, reason: l.reason })) }
}
```

- [ ] **Step 6: Run the tests, then the whole suite and the build**

Run: `npx vitest run src/lib/estimationSettings.test.js src/lib/openingExtras.test.js` — Expected: all PASS.
Run: `npm test` and `npm run build` — Expected: all existing tests still pass, build OK.

- [ ] **Step 7: Commit**

```bash
git add src/lib/estimationSettings.js src/lib/estimationSettings.test.js src/lib/openingExtras.js src/lib/openingExtras.test.js
git commit -m "feat(estimation): tenant settings and accessory extras (fixing points, sealant)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```


### Task 5: Cut optimizer

**Files:**
- Create: `src/lib/cutOptimizer.js`
- Create: `src/lib/cutOptimizer.test.js`

**Interfaces:**
- Consumes: `settings` from `mergeSettings` (kerf values, `min_keep_offcut_m`).
- Produces: `kerfM(style, settings)`, `packBars(cuts, barLengthM, settings) -> {bars, unplaced}`, `summarizePacking(packed, barLengthM, minKeepM)`, `compareLengths({cuts, lengths, settings, barPrice}) -> {rows, best, basis}`.

First-fit-decreasing packing with a per-cut kerf (90° and 45° differ). A piece longer than the bar is reported in `unplaced`, never dropped. `best` is the cheapest when every feasible row has a bar price, otherwise the least scrap (Ruling 7: offcuts never lower the cost).

- [ ] **Step 1: Write the failing test** — create `src/lib/cutOptimizer.test.js` with exactly:

```js
import { describe, it, expect } from 'vitest'
import { mergeSettings } from './estimationSettings.js'
import { kerfM, packBars, summarizePacking, compareLengths } from './cutOptimizer.js'

const S = mergeSettings({ kerf_square_mm: 3, kerf_miter_mm: 5, min_keep_offcut_m: 0.5 })
const cut = (length_m, quantity, style = 'square') => ({ length_m, quantity, style })

describe('packBars', () => {
  it('packs longest first and charges a kerf per cut', () => {
    const { bars } = packBars([cut(3, 2)], 6.4, S)
    expect(bars.length).toBe(1)
    expect(bars[0].pieces).toEqual([3, 3])
    expect(bars[0].left).toBeCloseTo(6.4 - 6 - 0.006, 9)
  })
  it('opens a second bar when the first is full', () => {
    expect(packBars([cut(3.2, 2)], 6.4, S).bars.length).toBe(2)
  })
  it('a piece longer than the bar is reported, never dropped', () => {
    const r = packBars([cut(7, 1), cut(1, 1)], 6.4, S)
    expect(r.unplaced).toEqual([7])
    expect(r.bars.length).toBe(1)
  })
  it('a piece exactly the bar length is placed; bad rows (0 length, 0 / fractional quantity) are ignored', () => {
    expect(packBars([cut(6.4, 1)], 6.4, S).bars[0].left).toBe(0)
    expect(packBars([cut(0, 3), cut(1, 0), cut(NaN, 1)], 6.4, S).bars).toEqual([])
    expect(packBars([cut(1, 2.9)], 6.4, S).bars[0].pieces).toEqual([1, 1])
  })
  it('a 45 degree cut uses the wider kerf', () => {
    expect(kerfM('miter45', S)).toBe(0.005)
    expect(kerfM('square', S)).toBe(0.003)
    expect(kerfM('notch', S)).toBe(0.003)
    expect(packBars([cut(3, 2, 'miter45')], 6.4, S).bars[0].left).toBeCloseTo(6.4 - 6 - 0.01, 9)
  })
})

describe('summarizePacking', () => {
  it('splits offcuts into reusable (>= min keep) and scrap', () => {
    const packed = { bars: [{ pieces: [5.4], left: 1 }, { pieces: [6.1], left: 0.3 }], unplaced: [] }
    const s = summarizePacking(packed, 6.4, 0.5)
    expect(s.count).toBe(2)
    expect(s.reusable_m).toBe(1)
    expect(s.scrap_m).toBeCloseTo(0.3, 9)
    expect(s.stock_m).toBeCloseTo(12.8, 9)
    expect(s.waste_pct).toBeCloseTo((100 * (12.8 - 11.5)) / 12.8, 6)
  })
})

describe('compareLengths', () => {
  const cuts = [cut(1.8, 8), cut(1.2, 8), cut(2.1, 4), cut(0.9, 6)]
  it('returns one row per candidate length and picks the least scrap when no prices are given', () => {
    const r = compareLengths({ cuts, lengths: [5, 5.5, 6, 6.4, 7], settings: S })
    expect(r.rows.map(x => x.length_m)).toEqual([5, 5.5, 6, 6.4, 7])
    expect(r.basis).toBe('scrap')
    const min = Math.min(...r.rows.filter(x => x.feasible).map(x => x.scrap_m))
    expect(r.best.scrap_m).toBe(min)
  })
  it('a length shorter than the longest cut is infeasible and never chosen', () => {
    const r = compareLengths({ cuts: [cut(2.1, 2)], lengths: [2, 6], settings: S })
    expect(r.rows[0].feasible).toBe(false)
    expect(r.rows[0].cost).toBeNull()
    expect(r.best.length_m).toBe(6)
  })
  it('with prices on every row the cheapest total wins, even if it scraps more', () => {
    const price = L => (L === 6 ? 100 : 400)
    const r = compareLengths({ cuts: [cut(2, 2)], lengths: [6, 6.4], settings: S, barPrice: price })
    expect(r.basis).toBe('cost')
    expect(r.best.length_m).toBe(6)
    expect(r.best.cost).toBe(100)
  })
  it('a row without a price makes the choice fall back to least scrap (never compares a number with null)', () => {
    const r = compareLengths({ cuts: [cut(2, 2)], lengths: [6, 6.4], settings: S, barPrice: L => (L === 6 ? 100 : null) })
    expect(r.basis).toBe('scrap')
  })
  it('nothing to cut gives no best length', () => {
    const r = compareLengths({ cuts: [], lengths: [6.4], settings: S })
    expect(r.best).toBeNull()
    expect(r.basis).toBeNull()
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run src/lib/cutOptimizer.test.js`
Expected: FAIL (module / export not found).

- [ ] **Step 3: Write the implementation** — create `src/lib/cutOptimizer.js` with exactly:

```js
// src/lib/cutOptimizer.js
// Whole-project cut planning: pack the cuts of one profile onto stock bars (first-fit decreasing, saw kerf
// charged per cut), and compare candidate bar lengths to find the one wasting least. Pure.
// cuts: [{ length_m, quantity, style }] with style 'square' | 'notch' | 'miter45' (miter45 uses the wider kerf).

const EPS = 1e-9

export const kerfM = (style, settings) => (style === 'miter45' ? settings.kerf_miter_mm : settings.kerf_square_mm) / 1000

// Longest piece first; a piece goes on the first bar with room for it plus its kerf.
// A piece longer than the bar can never be placed: it is returned in `unplaced`, never dropped silently.
export function packBars(cuts, barLengthM, settings) {
  const pieces = []
  for (const c of cuts || []) {
    const len = Number(c.length_m)
    const qty = Math.floor(Number(c.quantity))
    if (!(len > 0) || !(qty > 0)) continue
    for (let i = 0; i < qty; i++) pieces.push({ len, kerf: kerfM(c.style, settings) })
  }
  pieces.sort((a, b) => b.len - a.len)
  const bars = []
  const unplaced = []
  for (const p of pieces) {
    if (p.len > barLengthM + EPS) { unplaced.push(p.len); continue }
    const bar = bars.find(b => b.left + EPS >= p.len + p.kerf)
    if (bar) { bar.left -= p.len + p.kerf; bar.pieces.push(p.len) }
    else bars.push({ left: barLengthM - p.len - p.kerf, pieces: [p.len] })
  }
  // The last cut on a bar needs no trailing kerf, so a bar that came out a hair negative is clamped, not rejected.
  for (const b of bars) b.left = Math.max(0, b.left)
  return { bars, unplaced }
}

// Offcuts at least minKeepM long are reusable stock; shorter ones are scrap.
export function summarizePacking(packed, barLengthM, minKeepM) {
  const count = packed.bars.length
  const cut_m = packed.bars.reduce((s, b) => s + b.pieces.reduce((a, x) => a + x, 0), 0)
  let reusable_m = 0
  let scrap_m = 0
  for (const b of packed.bars) (b.left + EPS >= minKeepM && b.left > 0 ? (reusable_m += b.left) : (scrap_m += b.left))
  const stock_m = count * barLengthM
  return { count, cut_m, stock_m, reusable_m, scrap_m, waste_pct: stock_m > 0 ? (100 * (stock_m - cut_m)) / stock_m : 0, unplaced: packed.unplaced }
}

// Tries every candidate length. barPrice(L) is the price of one whole bar (or null when unknown).
// Best = lowest total cost when every feasible row is priced, otherwise least scrap; ties: fewer bars, then shorter bar.
// Kept offcuts do NOT reduce the cost (conservative ruling); they are only reported.
export function compareLengths({ cuts, lengths, settings, barPrice }) {
  const rows = (lengths || []).map(L => {
    const packed = packBars(cuts, L, settings)
    const s = summarizePacking(packed, L, settings.min_keep_offcut_m)
    const price = barPrice ? barPrice(L) : null
    const feasible = s.unplaced.length === 0 && s.count > 0
    return { length_m: L, ...s, feasible, cost: feasible && price != null ? price * s.count : null }
  })
  const ok = rows.filter(r => r.feasible)
  const priced = ok.length > 0 && ok.every(r => r.cost != null)
  const key = r => (priced ? r.cost : r.scrap_m)
  const best = [...ok].sort((a, b) => key(a) - key(b) || a.count - b.count || a.length_m - b.length_m)[0] || null
  return { rows, best, basis: best ? (priced ? 'cost' : 'scrap') : null }
}
```

- [ ] **Step 4: Run the tests, then the whole suite and the build**

Run: `npx vitest run src/lib/cutOptimizer.test.js` — Expected: all PASS.
Run: `npm test` and `npm run build` — Expected: all existing tests still pass, build OK.

- [ ] **Step 5: Commit**

```bash
git add src/lib/cutOptimizer.js src/lib/cutOptimizer.test.js
git commit -m "feat(estimation): cut optimizer (FFD packing, 90/45 kerf, length comparison)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```


### Task 6: Whole-project BOM roll-up

**Files:**
- Create: `src/lib/projectBom.js`
- Create: `src/lib/projectBom.test.js`

**Interfaces:**
- Consumes: `packBars`, `summarizePacking` (Task 5); `sealantTubes` (Task 4); BOM results from `computeBomForOpening` (profile lines carry `profile_id`, `cut_style`); `extras` from `openingExtras`.
- Produces: `stockLengthFor(profileId, stock, settings)`, `buildProjectBom({entries, settings, stock, profilesById, finishesById}) -> {profiles, parts, sealant, unresolved}`.

Rolls every item (x its quantity) into: aluminium by profile + colour (merged cut list, bars at the stock length, offcuts), hardware/accessories merged by part, and sealant tubes. `entries[i]` = `{opening_no, quantity, finish_id, bom, addonBom, extras}`.

- [ ] **Step 1: Write the failing test** — create `src/lib/projectBom.test.js` with exactly:

```js
import { describe, it, expect } from 'vitest'
import { mergeSettings } from './estimationSettings.js'
import { buildProjectBom, stockLengthFor, stockForProject } from './projectBom.js'

const S = mergeSettings(null)
const pl = (o = {}) => ({ role_name: 'r', profile_id: 'p1', length_m: 2, quantity: 2, resolved: true, cut_style: 'square', ...o })
const bom = (profileLines, extra = {}) => ({ profileLines, gridLines: [], hardwareLines: [], hardwareSetLines: [], unresolvedDetails: [], ...extra })
const profilesById = { p1: { id: 'p1', name: 'กล่องเรียบ', drawing_no: 'U1613' }, p2: { id: 'p2', name: 'ตัวแบ่ง' } }
const finishesById = { f1: { id: 'f1', name: 'อบขาว' } }
const run = (entries, stock) => buildProjectBom({ entries, settings: S, stock, profilesById, finishesById })

describe('stockLengthFor', () => {
  it('per-profile override > project > tenant default', () => {
    expect(stockLengthFor('p1', { byProfile: { p1: 6 }, projectM: 5.8 }, S)).toBe(6)
    expect(stockLengthFor('p2', { byProfile: { p1: 6 }, projectM: 5.8 }, S)).toBe(5.8)
    expect(stockLengthFor('p2', null, S)).toBe(6.4)
    expect(stockLengthFor('p2', { byProfile: { p2: 0 }, projectM: 'x' }, S)).toBe(6.4)
  })
})

describe('buildProjectBom', () => {
  it('multiplies by the item quantity and merges equal cuts of one profile + colour across items', () => {
    const r = run([
      { opening_no: 'D1', quantity: 3, finish_id: 'f1', bom: bom([pl()]) },
      { opening_no: 'D2', quantity: 1, finish_id: 'f1', bom: bom([pl({ quantity: 4 })]) },
    ])
    expect(r.profiles).toHaveLength(1)
    expect(r.profiles[0].cuts).toEqual([{ length_m: 2, style: 'square', quantity: 10 }])
    expect(r.profiles[0]).toMatchObject({ name: 'กล่องเรียบ', die_no: 'U1613', finish_name: 'อบขาว', cut_total_m: 20, stock_length_m: 6.4, count: 4 })
    expect(r.profiles[0].openings.sort()).toEqual(['D1', 'D2'])
  })
  it('the same profile in two colours is two rows; a 45 degree cut is kept apart from a square cut', () => {
    const r = run([
      { opening_no: 'D1', quantity: 1, finish_id: 'f1', bom: bom([pl(), pl({ cut_style: 'miter45' })]) },
      { opening_no: 'D2', quantity: 1, finish_id: 'f2', bom: bom([pl()]) },
    ])
    expect(r.profiles).toHaveLength(2)
    expect(r.profiles.find(p => p.finish_id === 'f1').cuts.map(c => c.style).sort()).toEqual(['miter45', 'square'])
  })
  it('an unresolved line is listed with its opening and reason, never counted as aluminium', () => {
    const r = run([{ opening_no: 'D1', quantity: 1, finish_id: 'f1', bom: bom([pl({ resolved: false, profile_id: undefined, role_name: 'วงกบ', reason: 'no_profile' })]) }])
    expect(r.profiles).toEqual([])
    expect(r.unresolved).toEqual([{ opening_no: 'D1', name: 'วงกบ', reason: 'no_profile' }])
  })
  it('the add-on BOM is rolled up too', () => {
    const r = run([{ opening_no: 'D1', quantity: 2, finish_id: 'f1', bom: bom([pl({ quantity: 1 })]), addonBom: bom([pl({ profile_id: 'p2', quantity: 1, length_m: 1 })]) }])
    expect(r.profiles.map(p => p.name).sort()).toEqual(['กล่องเรียบ', 'ตัวแบ่ง'])
  })
  it('hardware, set lines and accessories merge by part with summed quantity and cost; one unresolved part marks the row', () => {
    const hw = { hardwareLines: [{ name: 'ล้อ', quantity: 2, cost: 20, unresolved: false }], hardwareSetLines: [{ code: 'P-1', name: 'ชุด A', quantity: 1, cost: 100, resolved: true }] }
    const extras = { lines: [{ key: 'shim', part_id: 'ps', name: 'shim', quantity: 20, cost: 40, resolved: true }], sealant_m: 9 }
    const r = run([
      { opening_no: 'D1', quantity: 2, finish_id: 'f1', bom: bom([], hw), extras },
      { opening_no: 'D2', quantity: 1, finish_id: 'f1', bom: bom([], { ...hw, hardwareLines: [{ name: 'ล้อ', quantity: 2, cost: 0, unresolved: true }] }), extras },
    ])
    const wheel = r.parts.find(p => p.name === 'ล้อ')
    expect(wheel).toMatchObject({ quantity: 6, cost: 40, resolved: false, kind: 'hardware' })
    expect(r.parts.find(p => p.code === 'P-1')).toMatchObject({ quantity: 3, cost: 300 })
    expect(r.parts.find(p => p.name === 'shim')).toMatchObject({ quantity: 60, cost: 120, kind: 'accessory' })
  })
  it('sealant is one total length rounded up to tubes (27 m at 10 m per tube = 3)', () => {
    const r = run([{ opening_no: 'D1', quantity: 3, finish_id: 'f1', bom: bom([]), extras: { lines: [], sealant_m: 9 } }])
    expect(r.sealant).toEqual({ length_m: 27, tubes: 3, m_per_tube: 10 })
  })
  it('a missing or zero quantity counts as 1; no entries is an empty BOM', () => {
    const r = run([{ opening_no: 'D1', quantity: 0, finish_id: 'f1', bom: bom([pl({ quantity: 1 })]) }])
    expect(r.profiles[0].cut_total_m).toBe(2)
    expect(run([])).toMatchObject({ profiles: [], parts: [], unresolved: [], sealant: { tubes: 0 } })
  })
})

describe('costOpening problems surface in the project BOM', () => {
  it('joint issues, no_dimension, unknown infill and add-on problems are listed with the opening; profile-line problems are not doubled', () => {
    const unresolved = [
      { name: 'bar', reason: 'no_main_profile', source: 'joint' },
      { name: 'ขนาดช่องเปิด', reason: 'no_dimension', source: 'main' },
      { name: 'วัสดุอุดช่อง', reason: 'unknown_infill', source: 'main' },
      { name: 'ชุดต่อเติม', reason: 'unknown_addon_template', source: 'addon' },
      { name: 'ชุดต่อเติม', reason: 'no_dimension', source: 'addon' },
      { name: 'วงกบ', reason: 'no_profile', source: 'main' },
      { name: 'ล้อ', reason: 'no_hardware_price', source: 'main' },
    ]
    const r = run([{ opening_no: 'D1', quantity: 1, finish_id: 'f1', bom: bom([pl({ resolved: false, profile_id: undefined, role_name: 'วงกบ', reason: 'no_profile' })]), unresolved }])
    expect(r.unresolved).toEqual([
      { opening_no: 'D1', name: 'วงกบ', reason: 'no_profile' },
      { opening_no: 'D1', name: 'bar', reason: 'no_main_profile' },
      { opening_no: 'D1', name: 'ขนาดช่องเปิด', reason: 'no_dimension' },
      { opening_no: 'D1', name: 'วัสดุอุดช่อง', reason: 'unknown_infill' },
      { opening_no: 'D1', name: 'ชุดต่อเติม', reason: 'unknown_addon_template' },
      { opening_no: 'D1', name: 'ชุดต่อเติม', reason: 'no_dimension' },
    ])
  })
})

describe('hardware merged by part_id', () => {
  it('two lines with the same part_id merge even if the names differ; a part marked accessory in partsById is tagged', () => {
    const hw = n => ({ hardwareLines: [{ name: n, part_id: 'ps1', quantity: 1, cost: 10, unresolved: false }, { name: 'ไม่มีรหัส', quantity: 1, cost: 5, unresolved: false }] })
    const r = buildProjectBom({ entries: [{ opening_no: 'D1', quantity: 1, bom: bom([], hw('ล้อ A')) }, { opening_no: 'D2', quantity: 1, bom: bom([], hw('ล้อ B')) }], settings: S, partsById: { ps1: { kind: 'accessory' } } })
    expect(r.parts).toHaveLength(2)
    expect(r.parts.find(p => p.key === 'ps1')).toMatchObject({ quantity: 2, cost: 20, kind: 'accessory' })
    expect(r.parts.find(p => p.name === 'ไม่มีรหัส')).toMatchObject({ quantity: 2, kind: 'hardware' })
  })
})

describe('stockForProject', () => {
  it('keeps only this project\'s per-profile lengths and its own default length', () => {
    const rows = [{ project_id: 'a', profile_id: 'p1', length_m: '5.8' }, { project_id: 'b', profile_id: 'p1', length_m: '9' }, { project_id: 'a', profile_id: 'p2', length_m: 6 }]
    expect(stockForProject(rows, 'a', { stock_length_m: '6.2' })).toEqual({ byProfile: { p1: 5.8, p2: 6 }, projectM: 6.2 })
    expect(stockForProject(null, 'a', null)).toEqual({ byProfile: {}, projectM: null })
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run src/lib/projectBom.test.js`
Expected: FAIL (module / export not found).

- [ ] **Step 3: Write the implementation** — create `src/lib/projectBom.js` with exactly:

```js
// src/lib/projectBom.js
// The whole-project BOM: every item's computed BOM (x its quantity) rolled up into
//   1) aluminium by profile + colour: cut list, bars to buy at the stock length, offcuts
//   2) hardware / accessories: merged by part
//   3) sealant: one total length rounded up to tubes
// Pure. `entries` come from the caller, one per item: { opening_no, quantity, finish_id, bom, addonBom, extras }
// where bom / addonBom are computeBomForOpening results (profile lines carry profile_id and cut_style) and
// extras is openingExtras()'s result.
import { packBars, summarizePacking } from './cutOptimizer.js'
import { sealantTubes } from './openingExtras.js'

const mm = n => Math.round(Number(n) * 1000) / 1000   // cuts are merged at 1 mm

// Stock length: the owner's per-profile override > the project's > the tenant default (6.4 m unless changed).
export function stockLengthFor(profileId, stock, settings) {
  const p = stock && stock.byProfile ? Number(stock.byProfile[profileId]) : NaN
  if (p > 0) return p
  const pr = stock ? Number(stock.projectM) : NaN
  if (pr > 0) return pr
  return settings.stock_length_m
}

const bomsOf = e => [e.bom, e.addonBom].filter(Boolean)

// Stock lengths that apply to ONE project: the per-profile rows of that project and its own default length.
export function stockForProject(rows, projectId, project) {
  const byProfile = {}
  for (const r of rows || []) if (r.project_id === projectId) byProfile[r.profile_id] = Number(r.length_m)
  const pm = Number(project && project.stock_length_m)
  return { byProfile, projectM: pm > 0 ? pm : null }
}

// costOpening().unresolved entries that never show up as an unresolved profile line
const surfaced = u => u.source === 'joint' || u.reason === 'no_dimension' || u.reason === 'unknown_infill' || u.reason === 'unknown_addon_template'

export function buildProjectBom({ entries, settings, stock, profilesById, finishesById, partsById }) {
  const groups = new Map()
  const unresolved = []
  const hardware = new Map()
  let sealant_m = 0

  for (const e of entries || []) {
    const q = Number(e.quantity) > 0 ? Number(e.quantity) : 1
    const costProblems = (e.unresolved || []).filter(surfaced)
    for (const bom of bomsOf(e)) {
      for (const line of [...bom.profileLines, ...bom.gridLines]) {
        if (!line.resolved || !line.profile_id) { unresolved.push({ opening_no: e.opening_no, name: line.role_name, reason: line.reason || 'no_profile' }); continue }
        const key = `${line.profile_id}|${e.finish_id || ''}`
        const g = groups.get(key) || { key, profile_id: line.profile_id, finish_id: e.finish_id || null, cutMap: new Map(), openings: new Set() }
        const style = line.cut_style || 'square'
        const ck = `${mm(line.length_m)}|${style}`
        const prev = g.cutMap.get(ck) || { length_m: mm(line.length_m), style, quantity: 0 }
        prev.quantity += line.quantity * q
        g.cutMap.set(ck, prev)
        g.openings.add(e.opening_no)
        groups.set(key, g)
      }
      for (const l of bom.hardwareLines) {
        const kind = l.part_id && partsById && partsById[l.part_id] && partsById[l.part_id].kind === 'accessory' ? 'accessory' : 'hardware'
        addPart(hardware, l.part_id || l.name, l.name, null, l.quantity * q, l.cost * q, !l.unresolved, kind)
      }
      for (const l of bom.hardwareSetLines || []) addPart(hardware, l.code || l.name, l.name, l.code, l.quantity * q, l.cost * q, l.resolved, 'hardware')
    }
    for (const u of costProblems) unresolved.push({ opening_no: e.opening_no, name: u.name, reason: u.reason })
    if (e.extras) {
      for (const l of e.extras.lines) addPart(hardware, `extra:${l.key}:${l.part_id}`, l.name, null, l.quantity * q, l.cost * q, l.resolved, 'accessory')
      sealant_m += e.extras.sealant_m * q
    }
  }

  const profiles = [...groups.values()].map(g => {
    const cuts = [...g.cutMap.values()].sort((a, b) => b.length_m - a.length_m)
    const profile = (profilesById || {})[g.profile_id]
    const finish = (finishesById || {})[g.finish_id]
    const stock_length_m = stockLengthFor(g.profile_id, stock, settings)
    const packed = packBars(cuts, stock_length_m, settings)
    return {
      key: g.key, profile_id: g.profile_id, finish_id: g.finish_id,
      name: profile ? profile.name : '?', die_no: profile ? profile.drawing_no || null : null, finish_name: finish ? finish.name : null,
      cuts, cut_total_m: cuts.reduce((s, c) => s + c.length_m * c.quantity, 0), openings: [...g.openings],
      stock_length_m, bars: packed.bars, ...summarizePacking(packed, stock_length_m, settings.min_keep_offcut_m),
    }
  }).sort((a, b) => String(a.name).localeCompare(String(b.name), 'th'))

  return {
    profiles,
    parts: [...hardware.values()].sort((a, b) => a.kind.localeCompare(b.kind) || String(a.name).localeCompare(String(b.name), 'th')),
    sealant: { length_m: sealant_m, tubes: sealantTubes(sealant_m, settings.sealant_m_per_tube), m_per_tube: settings.sealant_m_per_tube },
    unresolved,
  }
}

function addPart(map, key, name, code, quantity, cost, resolved, kind) {
  const p = map.get(key) || { key, name, code: code || null, kind, quantity: 0, cost: 0, resolved: true }
  p.quantity += quantity
  p.cost += cost
  p.resolved = p.resolved && resolved
  map.set(key, p)
}
```

- [ ] **Step 4: Run the tests, then the whole suite and the build**

Run: `npx vitest run src/lib/projectBom.test.js` — Expected: all PASS.
Run: `npm test` and `npm run build` — Expected: all existing tests still pass, build OK.

- [ ] **Step 5: Commit**

```bash
git add src/lib/projectBom.js src/lib/projectBom.test.js
git commit -m "feat(estimation): whole-project BOM roll-up (cuts, bars, parts, sealant)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```


### Task 7: costOpening: one item, fully costed

**Files:**
- Create: `src/lib/openingCost.js`
- Create: `src/lib/openingCost.test.js`

**Interfaces:**
- Consumes: `resolveItemInputs`, `buildEngineOpening`, `buildEngineAddonOpening` (2a); `makeCatalogPricing`; `computeBomForOpening`, `combineOpeningBoms`; `applyJoints`, `applyRoleThickness` (Task 3); `allowsMixedThickness` (Task 2); `openingExtras` (Task 4).
- Produces: `costOpening(ctx) -> {resolved, bom, addonBom, extras, issues, total, unresolved}` where `ctx = {item, project, template, addonTemplate, componentsByTemplate, hardwareByTemplate, jointsByTemplate, typesById, infillTypesById, index, settings, asOf}` (the three `...ByTemplate` maps are `{[templateId]: rows[]}`); `resolved` now includes `sash_thickness_mm`.

The single costing entry point. The item form, the project BOM, the stale-price check and the quick calculator all call it so they cannot disagree. `total` = main BOM + add-on BOM + accessory extras; hardware-set cost is inside `bom.totalCost` (priced once per opening, Phase 2a ruling).

- [ ] **Step 1: Write the failing test** — create `src/lib/openingCost.test.js` with exactly:

```js
import { describe, it, expect } from 'vitest'
import { buildCatalogIndex } from './aluCatalogPricing.js'
import { mergeSettings } from './estimationSettings.js'
import { costOpening } from './openingCost.js'

const index = buildCatalogIndex({
  providers: [{ id: 'A', price_basis: 'per_kg' }],
  series: [{ id: 's1', provider_id: 'A' }],
  types: [{ id: 'tSlide' }, { id: 'tFixed' }],
  seriesTypes: [{ series_id: 's1', type_id: 'tSlide', allow_mixed_thickness: true }, { series_id: 's1', type_id: 'tFixed' }],
  finishes: [{ id: 'f1', provider_id: 'A' }],
  profiles: [
    { id: 'box', provider_id: 'A', family: 'box', thickness_mm: 1.5, linear_weight_kg_per_m: 1, depth_mm: 40, primary_contact: 'width' },
    { id: 'bar', provider_id: 'A', family: 'bar', thickness_mm: 1.5, linear_weight_kg_per_m: 1 },
    { id: 'bar2', provider_id: 'A', family: 'bar', thickness_mm: 2, linear_weight_kg_per_m: 2 },
  ],
  seriesProfiles: ['box', 'bar', 'bar2'].map(profile_id => ({ series_id: 's1', profile_id })),
  kgPrices: [{ id: 'k1', provider_id: 'A', finish_id: 'f1', price_per_kg: 100, effective_from: '2026-01-01' }],
  parts: [{ id: 'shim', name: 'shim', kind: 'accessory', unit: 'ตัว' }],
  partPrices: [{ id: 'pp1', part_id: 'shim', list_price: 2, discount_pct: 0, effective_from: '2026-01-01' }],
})
const T = (o = {}) => ({ id: 't1', type_id: 'tSlide', waste_pct: 0, grid_row_weights: [1], labor_price_per_sqm: 0, silicone_price_per_m: 0, felt_price_per_m: 0, infill_width_deduction_mm: 0, infill_height_deduction_mm: 0, ...o })
const comps = [
  { role_name: 'top', profile_family: 'box', length_rule_type: 'width', length_deduction_mm: 0, quantity_basis: 'fixed', quantity_value: 1 },
  { role_name: 'bar', profile_family: 'bar', length_rule_type: 'width', length_deduction_mm: 0, quantity_basis: 'fixed', quantity_value: 2, joint_id: 'j1', joint_ends: 2 },
]
const joints = [{ id: 'j1', main_family: 'box', secondary_family: 'bar', deduction_mode: 'auto', cut_style: 'square' }]
const ctxBase = () => ({
  item: { width_m: 2, height_m: 1, panel_count: 1, quantity: 1, template_id: 't1' },
  project: { default_series_id: 's1', default_finish_id: 'f1', default_thickness_mm: 1.5 },
  template: T(), componentsByTemplate: { t1: comps }, hardwareByTemplate: {}, jointsByTemplate: { t1: joints },
  typesById: index.types, infillTypesById: {}, index, settings: mergeSettings(null), asOf: '2026-06-01',
})

describe('costOpening', () => {
  it('inherits series/colour/thickness from the project, applies the joint deduction, prices through the catalog', () => {
    const r = costOpening(ctxBase())
    // top: 2 m x 1 kg/m x 100 = 200 ; bar: (2 - 2 x 0.040) m x 2 pieces x 1 kg/m x 100 = 384
    expect(r.bom.profileLines[0].cost).toBeCloseTo(200)
    expect(r.bom.profileLines[1].length_m).toBeCloseTo(1.92)
    expect(r.bom.profileLines[1].cost).toBeCloseTo(384)
    expect(r.total).toBeCloseTo(584)
    expect(r.unresolved).toEqual([])
  })
  it('an unresolvable joint is reported and the component keeps the template\'s own length', () => {
    const c = ctxBase()
    c.jointsByTemplate = { t1: [{ ...joints[0], main_family: 'missing' }] }
    const r = costOpening(c)
    expect(r.bom.profileLines[1].length_m).toBe(2)
    expect(r.issues).toEqual([{ role_name: 'bar', reason: 'no_main_profile' }])
    expect(r.unresolved.some(u => u.reason === 'no_main_profile')).toBe(true)
  })
  it('a sash-role component is priced at the sash thickness only where the series+type allows mixed thickness', () => {
    const c = ctxBase()
    c.project = { ...c.project, default_thickness_mm: 1.5, default_sash_thickness_mm: 2 }
    c.componentsByTemplate = { t1: [{ ...comps[0], thickness_role: 'sash', profile_family: 'bar' }, { ...comps[0], role_name: 'frame', profile_family: 'bar' }] }
    const r = costOpening(c)
    expect(r.bom.profileLines.map(l => l.thickness_mm)).toEqual([2, 1.5])
    c.template = T({ type_id: 'tFixed' })
    expect(costOpening(c).bom.profileLines.map(l => l.thickness_mm)).toEqual([1.5, 1.5])
  })
  it('an item\'s own sash thickness wins over the project default', () => {
    const c = ctxBase()
    c.project = { ...c.project, default_sash_thickness_mm: 1.5 }
    c.item = { ...c.item, sash_thickness_mm: 2 }
    c.componentsByTemplate = { t1: [{ ...comps[0], thickness_role: 'sash', profile_family: 'bar' }] }
    expect(costOpening(c).bom.profileLines[0].thickness_mm).toBe(2)
  })
  it('adds the add-on BOM and the accessory extras (shim x fixing points) to the total', () => {
    const c = ctxBase()
    c.settings = mergeSettings({ shim_part_id: 'shim' })
    c.addonTemplate = T({ id: 't2' })
    c.componentsByTemplate = { t1: comps.slice(0, 1), t2: comps.slice(0, 1) }
    c.item = { ...c.item, addon_template_id: 't2', addon_width_m: 2, addon_height_m: 0.5 }
    const r = costOpening(c)
    expect(r.addonBom.totalCost).toBeCloseTo(200)
    // main 2 x 1: 2 x 5 + 2 x 3 = 16 points; add-on 2 x 0.5: 2 x 5 + 2 x 2 = 14 points; 30 shims x 2 baht = 60
    expect(r.extras.points).toBe(30)
    expect(r.extras.cost).toBe(60)
    expect(r.total).toBeCloseTo(200 + 200 + 60)
  })
  it('no series chosen anywhere is unresolved with a reason, never a silent 0 total', () => {
    const c = ctxBase()
    c.project = {}
    const r = costOpening(c)
    expect(r.unresolved.length).toBeGreaterThan(0)
    expect(r.bom.profileLines[0].reason).toBe('no_series')
  })
  it('an add-on without a size is ignored (partially filled = no add-on yet)', () => {
    const c = ctxBase()
    c.addonTemplate = T({ id: 't2' })
    c.item = { ...c.item, addon_template_id: 't2', addon_width_m: 2 }
    expect(costOpening(c).addonBom).toBeNull()
  })
  it('string width/height (DB numerics) cost the same as numbers', () => {
    const c = ctxBase()
    c.item = { ...c.item, width_m: '2', height_m: '1' }
    expect(costOpening(c).total).toBeCloseTo(584)
  })
  it('a missing main height is flagged no_dimension, never a silent 0', () => {
    const c = ctxBase()
    c.item = { ...c.item, height_m: undefined }
    const r = costOpening(c)
    expect(r.unresolved).toContainEqual({ name: 'ขนาดช่องเปิด', reason: 'no_dimension', source: 'main' })
  })
  it('every unresolved entry has exactly name/reason/source, joint failures included', () => {
    const c = ctxBase()
    c.jointsByTemplate = { t1: [{ ...joints[0], main_family: 'missing' }] }
    c.project = { ...c.project, default_series_id: undefined }
    const r = costOpening(c)
    expect(r.unresolved.length).toBeGreaterThan(0)
    r.unresolved.forEach(u => expect(Object.keys(u).sort()).toEqual(['name', 'reason', 'source']))
    const c2 = ctxBase()
    c2.jointsByTemplate = { t1: [{ ...joints[0], main_family: 'missing' }] }
    expect(costOpening(c2).unresolved).toContainEqual({ name: 'bar', reason: 'no_main_profile', source: 'joint' })
  })
  it('an infill id missing from infillTypesById is flagged unknown_infill', () => {
    const c = ctxBase()
    c.item = { ...c.item, infill_type_id: 'ghost' }
    expect(costOpening(c).unresolved).toContainEqual({ name: 'วัสดุอุดช่อง', reason: 'unknown_infill', source: 'main' })
  })
})

describe('costOpening reports an add-on it could not cost', () => {
  it('unknown add-on template, zero add-on size; a normal add-on adds nothing', () => {
    const c = ctxBase()
    c.item = { ...c.item, addon_template_id: 't2', addon_width_m: 2, addon_height_m: 0.5 }
    expect(costOpening(c).unresolved).toContainEqual({ name: 'ชุดต่อเติม', reason: 'unknown_addon_template', source: 'addon' })
    c.addonTemplate = T({ id: 't2' })
    c.componentsByTemplate = { t1: comps.slice(0, 1), t2: comps.slice(0, 1) }
    expect(costOpening(c).unresolved).toEqual([])
    c.item = { ...c.item, addon_height_m: 0 }
    expect(costOpening(c).unresolved).toContainEqual({ name: 'ชุดต่อเติม', reason: 'no_dimension', source: 'addon' })
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run src/lib/openingCost.test.js`
Expected: FAIL (module / export not found).

- [ ] **Step 3: Write the implementation** — create `src/lib/openingCost.js` with exactly:

```js
// src/lib/openingCost.js
// One item, fully costed: resolves inherited inputs, applies the template's joints and role thickness,
// prices main + add-on through the catalog, and adds the accessory extras. The item form, the project BOM,
// the stale-price check and the quick calculator all call this, so they cannot disagree. Pure.
import { computeBomForOpening, combineOpeningBoms } from './bomEngine.js'
import { makeCatalogPricing } from './aluCatalogPricing.js'
import { resolveItemInputs, buildEngineOpening, buildEngineAddonOpening } from './estimationInherit.js'
import { applyJoints, applyRoleThickness } from './assembly.js'
import { allowsMixedThickness } from './estimationCatalogViews.js'
import { openingExtras } from './openingExtras.js'

const positive = n => Number.isFinite(Number(n)) && Number(n) > 0

function prepareComponents({ template, components, joints, index, seriesId, thicknessMm, sashThicknessMm }) {
  const allowMixed = template.type_id ? allowsMixedThickness(index, seriesId, template.type_id) : false
  return applyJoints({ components: applyRoleThickness(components, { allowMixed, sashThicknessMm }), joints, index, seriesId, thicknessMm })
}

// ctx: { item, project, template, addonTemplate, componentsByTemplate, hardwareByTemplate, jointsByTemplate,
//        typesById, infillTypesById, index, settings, asOf }
export function costOpening(ctx) {
  const { item: rawItem, project, template, addonTemplate, index, settings, asOf } = ctx
  // DB numerics can arrive as strings; the engine adds width + height, so coerce once here.
  const item = { ...rawItem, width_m: Number(rawItem.width_m) || 0, height_m: Number(rawItem.height_m) || 0, panel_count: Math.max(1, Math.floor(Number(rawItem.panel_count)) || 1) }
  const byT = (m, id) => (m && m[id]) || []
  const resolved = resolveItemInputs(item, project, template, ctx.typesById)
  const pricing = makeCatalogPricing({ index, seriesId: resolved.series_id, finishId: resolved.finish_id, asOf })
  const issues = []
  const own = []
  if (!(item.width_m > 0 && item.height_m > 0)) own.push({ name: 'ขนาดช่องเปิด', reason: 'no_dimension', source: 'main' })
  if (resolved.infill_type_id && !(ctx.infillTypesById || {})[resolved.infill_type_id]) own.push({ name: 'วัสดุอุดช่อง', reason: 'unknown_infill', source: 'main' })

  const main = buildEngineOpening(item, project, template, ctx.typesById, ctx.infillTypesById)
  const prepared = prepareComponents({ template, components: byT(ctx.componentsByTemplate, template.id), joints: byT(ctx.jointsByTemplate, template.id), index, seriesId: resolved.series_id, thicknessMm: resolved.thickness_mm, sashThicknessMm: resolved.sash_thickness_mm })
  issues.push(...prepared.issues)
  const bom = computeBomForOpening(main.opening, template, prepared.components, byT(ctx.hardwareByTemplate, template.id), pricing, main.infillType)

  let addonBom = null
  const hasAddon = item.addon_template_id && addonTemplate && positive(item.addon_width_m) && positive(item.addon_height_m)
  if (hasAddon) {
    const addon = { width_m: Number(item.addon_width_m), height_m: Number(item.addon_height_m), panel_count: item.addon_panel_count || 1, quantity: 1, extra_lines: [] }
    const ao = buildEngineAddonOpening(item, project, addon, addonTemplate, ctx.typesById, ctx.infillTypesById)
    const aPrepared = prepareComponents({ template: addonTemplate, components: byT(ctx.componentsByTemplate, addonTemplate.id), joints: byT(ctx.jointsByTemplate, addonTemplate.id), index, seriesId: resolved.series_id, thicknessMm: resolved.thickness_mm, sashThicknessMm: resolved.sash_thickness_mm })
    issues.push(...aPrepared.issues)
    addonBom = computeBomForOpening(ao.opening, addonTemplate, aPrepared.components, byT(ctx.hardwareByTemplate, addonTemplate.id), pricing, ao.infillType)
  }

  // an add-on the item asks for but that could not be costed must be said, never silently left out of the total
  if (item.addon_template_id && !hasAddon) own.push({ name: 'ชุดต่อเติม', reason: addonTemplate ? 'no_dimension' : 'unknown_addon_template', source: 'addon' })

  const units = [{ width_m: Number(item.width_m), height_m: Number(item.height_m) }]
  if (hasAddon) units.push({ width_m: Number(item.addon_width_m), height_m: Number(item.addon_height_m) })
  const extras = openingExtras({ units, settings, partsById: index.parts, pricing })
  const combined = combineOpeningBoms(bom, addonBom)
  return {
    resolved, bom, addonBom, extras, issues,
    total: combined.totalCost + extras.cost,
    unresolved: [
      ...own,
      ...bom.unresolvedDetails.map(d => ({ ...d, source: 'main' })),
      ...(addonBom ? addonBom.unresolvedDetails.map(d => ({ ...d, source: 'addon' })) : []),
      ...extras.unresolved.map(d => ({ ...d, source: 'extras' })),
      ...issues.map(i => ({ name: i.role_name, reason: i.reason, source: 'joint' })),
    ],
  }
}
```

- [ ] **Step 4: Run the tests, then the whole suite and the build**

Run: `npx vitest run src/lib/openingCost.test.js` — Expected: all PASS.
Run: `npm test` and `npm run build` — Expected: all existing tests still pass, build OK.

- [ ] **Step 5: Commit**

```bash
git add src/lib/openingCost.js src/lib/openingCost.test.js
git commit -m "feat(estimation): costOpening combines inheritance, joints, pricing, add-on and extras

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```


### Task 8: Extruder comparison

**Files:**
- Create: `src/lib/providerCompare.js`
- Create: `src/lib/providerCompare.test.js`

**Interfaces:**
- Consumes: `computeBomForOpening`, `makeCatalogPricing`, `buildEngineOpening`.
- Produces: `compareProviders({project, items, templatesById, componentsByTemplate, jointsByTemplate, typesById, infillTypesById, index, settings, candidates, asOf}) -> rows` (built on `costOpening`, so joints and sash thickness behave as in the item form), `diffAgainst(baseRow, row) -> {amount, pct} | null`.

Read-only "what if this project were built with extruder B": the same items priced in a candidate series + colour. Aluminium only (Ruling 10). `diffAgainst` returns null unless both rows are complete, so an incomplete extruder never looks cheaper.

- [ ] **Step 1: Write the failing test** — create `src/lib/providerCompare.test.js` with exactly:

```js
import { describe, it, expect } from 'vitest'
import { buildCatalogIndex } from './aluCatalogPricing.js'
import { mergeSettings } from './estimationSettings.js'
import { compareProviders, diffAgainst } from './providerCompare.js'

const index = buildCatalogIndex({
  providers: [{ id: 'A', price_basis: 'per_kg' }, { id: 'B', price_basis: 'per_kg' }],
  series: [{ id: 'sA', provider_id: 'A' }, { id: 'sB', provider_id: 'B' }, { id: 'sB2', provider_id: 'B' }],
  finishes: [{ id: 'fA', provider_id: 'A' }, { id: 'fB', provider_id: 'B' }],
  profiles: [
    { id: 'pA', provider_id: 'A', family: 'box', thickness_mm: 1.5, linear_weight_kg_per_m: 1 },
    { id: 'pB', provider_id: 'B', family: 'box', thickness_mm: 1.5, linear_weight_kg_per_m: 1 },
  ],
  seriesProfiles: [{ series_id: 'sA', profile_id: 'pA' }, { series_id: 'sB', profile_id: 'pB' }],
  kgPrices: [
    { id: 'k1', provider_id: 'A', finish_id: 'fA', price_per_kg: 100, effective_from: '2026-01-01' },
    { id: 'k2', provider_id: 'B', finish_id: 'fB', price_per_kg: 90, effective_from: '2026-01-01' },
  ],
})
const template = { id: 't1', waste_pct: 0, grid_row_weights: [1], labor_price_per_sqm: 0, silicone_price_per_m: 0, felt_price_per_m: 0, infill_width_deduction_mm: 0, infill_height_deduction_mm: 0 }
const components = { t1: [{ role_name: 'top', profile_family: 'box', length_rule_type: 'width', length_deduction_mm: 0, quantity_basis: 'fixed', quantity_value: 2 }] }
const item = { id: 'i1', template_id: 't1', width_m: 2, height_m: 1, panel_count: 1, quantity: 3, thickness_mm: 1.5 }
const base = { project: { price_as_of: '2026-06-01' }, items: [item], templatesById: { t1: template }, componentsByTemplate: components, jointsByTemplate: {}, typesById: {}, infillTypesById: {}, index, settings: mergeSettings(null), asOf: '2026-06-01' }

describe('compareProviders', () => {
  it('prices the same items in each candidate series and colour, x quantity', () => {
    const r = compareProviders({ ...base, candidates: [{ providerId: 'A', seriesId: 'sA', finishId: 'fA' }, { providerId: 'B', seriesId: 'sB', finishId: 'fB' }] })
    expect(r[0].aluminium).toBe(2 * 2 * 100 * 3)
    expect(r[1].aluminium).toBe(2 * 2 * 90 * 3)
    expect(r.every(x => x.complete)).toBe(true)
  })
  it('a candidate series without the profile is incomplete and counts the unpriced lines', () => {
    const r = compareProviders({ ...base, candidates: [{ providerId: 'B', seriesId: 'sB2', finishId: 'fB' }] })
    expect(r[0]).toMatchObject({ aluminium: 0, unresolvedLines: 3, complete: false })
  })
  it('a candidate colour from another extruder is unresolved, not silently priced', () => {
    const r = compareProviders({ ...base, candidates: [{ providerId: 'B', seriesId: 'sB', finishId: 'fA' }] })
    expect(r[0].complete).toBe(false)
  })
  it('an item whose template is gone is skipped; no items is incomplete', () => {
    const r = compareProviders({ ...base, items: [{ ...item, template_id: 'gone' }], candidates: [{ providerId: 'A', seriesId: 'sA', finishId: 'fA' }] })
    expect(r[0]).toMatchObject({ itemsPriced: 0, complete: false })
  })
  it('a candidate without finishId is incomplete, zero aluminium, diffAgainst is null', () => {
    const r = compareProviders({ ...base, candidates: [{ providerId: 'A', seriesId: 'sA' }] })
    expect(r[0]).toMatchObject({ aluminium: 0, complete: false })
    expect(diffAgainst({ complete: true, aluminium: 1000 }, r[0])).toBeNull()
  })
  it('an item with height_m 0 is unresolved', () => {
    const r = compareProviders({ ...base, items: [{ ...item, height_m: 0 }], candidates: [{ providerId: 'A', seriesId: 'sA', finishId: 'fA' }] })
    expect(r[0].complete).toBe(false)
    expect(r[0].unresolvedLines).toBeGreaterThanOrEqual(1)
  })
  it('an item with its own series_id and alu_finish_id is still priced in the candidate series', () => {
    const itemWithOwnSeries = { ...item, series_id: 'sB', alu_finish_id: 'fB' }
    const r = compareProviders({ ...base, items: [itemWithOwnSeries], candidates: [{ providerId: 'A', seriesId: 'sA', finishId: 'fA' }] })
    expect(r[0].aluminium).toBe(2 * 2 * 100 * 3)
  })
  it('an item with addon_template_id includes the addon aluminium cost', () => {
    const t2 = { id: 't2', waste_pct: 0, grid_row_weights: [1], labor_price_per_sqm: 0, silicone_price_per_m: 0, felt_price_per_m: 0, infill_width_deduction_mm: 0, infill_height_deduction_mm: 0 }
    const componentsWithAddon = { ...components, t2: [{ role_name: 'addon', profile_family: 'box', length_rule_type: 'width', length_deduction_mm: 0, quantity_basis: 'fixed', quantity_value: 0.5 }] }
    const itemWithAddon = { ...item, addon_template_id: 't2', addon_width_m: 2, addon_height_m: 1 }
    const r = compareProviders({
      ...base,
      items: [itemWithAddon],
      templatesById: { ...base.templatesById, t2 },
      componentsByTemplate: componentsWithAddon,
      candidates: [{ providerId: 'A', seriesId: 'sA', finishId: 'fA' }]
    })
    expect(r[0].aluminium).toBe(1500)
  })
  it('an item with an unresolvable joint is incomplete', () => {
    const componentWithJoint = [{ role_name: 'top', profile_family: 'box', length_rule_type: 'width', length_deduction_mm: 0, quantity_basis: 'fixed', quantity_value: 2, joint_id: 'j1' }]
    const joints = { j1: { main_family: 'nonexistent' } }
    const r = compareProviders({
      ...base,
      componentsByTemplate: { t1: componentWithJoint },
      jointsByTemplate: joints,
      candidates: [{ providerId: 'A', seriesId: 'sA', finishId: 'fA' }]
    })
    expect(r[0].complete).toBe(false)
  })
})

describe('diffAgainst', () => {
  it('amount and percent against the base row', () => {
    expect(diffAgainst({ complete: true, aluminium: 1000 }, { complete: true, aluminium: 960 })).toEqual({ amount: -40, pct: -4 })
  })
  it('is null when either side is incomplete or the base is 0', () => {
    expect(diffAgainst({ complete: true, aluminium: 1000 }, { complete: false, aluminium: 0 })).toBeNull()
    expect(diffAgainst({ complete: false, aluminium: 0 }, { complete: true, aluminium: 5 })).toBeNull()
    expect(diffAgainst({ complete: true, aluminium: 0 }, { complete: true, aluminium: 5 })).toBeNull()
    expect(diffAgainst(null, null)).toBeNull()
  })
})

describe('Follow-up A: an item whose template is missing', () => {
  it('makes the row incomplete, so a diff against a complete base is null', () => {
    const r = compareProviders({ ...base, items: [item, { ...item, id: 'i2', template_id: 'gone', quantity: 2 }], candidates: [{ providerId: 'A', seriesId: 'sA', finishId: 'fA' }] })
    expect(r[0]).toMatchObject({ itemsPriced: 1, unresolvedLines: 2, complete: false })
    expect(diffAgainst({ complete: true, aluminium: 1000 }, r[0])).toBeNull()
  })
})

describe('fix round 1: left-out add-on or infill makes the row incomplete', () => {
  const cand = [{ providerId: 'A', seriesId: 'sA', finishId: 'fA' }]
  it('an add-on template that is not found', () => {
    const r = compareProviders({ ...base, items: [{ ...item, addon_template_id: 'gone', addon_width_m: 1, addon_height_m: 1 }], candidates: cand })
    expect(r[0].complete).toBe(false)
  })
  it('an infill type that is not found', () => {
    const r = compareProviders({ ...base, items: [{ ...item, infill_type_id: 'nope' }], candidates: cand })
    expect(r[0].complete).toBe(false)
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run src/lib/providerCompare.test.js`
Expected: FAIL (module / export not found).

- [ ] **Step 3: Write the implementation** — create `src/lib/providerCompare.js` with exactly:

```js
// src/lib/providerCompare.js
// "Compare extruders" for a whole project: recompute the ALUMINIUM cost of every item as if it were built in a
// candidate extruder's series and colour. Read-only: nothing in the project changes. Pure.
// Candidate = { providerId, seriesId, finishId } (the screen lets the owner pick the series + colour per candidate).
// Items keep their size, template and thickness (frame and sash); a candidate series that lacks a thickness or
// profile makes those lines unresolved, and the row says how many lines could not be priced.
// Built on costOpening so joints, role thickness and inheritance behave exactly as in the item form.
import { costOpening } from './openingCost.js'

// ctx: { project, items, templatesById, componentsByTemplate, jointsByTemplate, typesById, infillTypesById, index, settings, candidates, asOf }
export function compareProviders(ctx) {
  const { items, templatesById, index } = ctx
  return (ctx.candidates || []).map(cand => {
    // early return if seriesId or finishId is missing
    if (!cand.seriesId || !cand.finishId) {
      return { ...cand, aluminium: 0, unresolvedLines: 1, itemsPriced: 0, complete: false }
    }

    let aluminium = 0
    let unresolvedLines = 0
    let itemsPriced = 0
    for (const item of items || []) {
      const template = (templatesById || {})[item.template_id]
      if (!template) { unresolvedLines += Number(item.quantity) > 0 ? Number(item.quantity) : 1; continue }
      // the same item, forced onto the candidate series + colour; hardware is not part of this comparison
      const forced = { ...item, series_id: cand.seriesId, alu_finish_id: cand.finishId, no_hardware_set: true, hardware_set_id: null }
      const addonTemplate = item.addon_template_id ? (templatesById || {})[item.addon_template_id] : null
      const r = costOpening({
        item: forced, project: ctx.project, template, addonTemplate,
        componentsByTemplate: ctx.componentsByTemplate, hardwareByTemplate: {}, jointsByTemplate: ctx.jointsByTemplate,
        typesById: ctx.typesById, infillTypesById: ctx.infillTypesById, index, settings: ctx.settings, asOf: ctx.asOf,
      })
      const lines = [...r.bom.profileLines, ...r.bom.gridLines, ...(r.addonBom ? [...r.addonBom.profileLines, ...r.addonBom.gridLines] : [])]
      const qty = Number(item.quantity) > 0 ? Number(item.quantity) : 1
      aluminium += lines.reduce((s, l) => s + l.cost, 0) * qty
      unresolvedLines += lines.filter(l => !l.resolved).length * qty
      // also count unresolved dimensions and joints
      unresolvedLines += (r.unresolved || []).filter(u => u.reason === 'no_dimension' || u.reason === 'unknown_addon_template' || u.reason === 'unknown_infill' || u.source === 'joint').length * qty
      itemsPriced += 1
    }
    return { ...cand, aluminium, unresolvedLines, itemsPriced, complete: unresolvedLines === 0 && itemsPriced > 0 }
  })
}

// Difference against the project's own extruder row; null when either side is incomplete (never a fake saving).
export function diffAgainst(base, row) {
  if (!base || !row || !base.complete || !row.complete || !(base.aluminium > 0)) return null
  const amount = row.aluminium - base.aluminium
  return { amount, pct: (100 * amount) / base.aluminium }
}
```

- [ ] **Step 4: Run the tests, then the whole suite and the build**

Run: `npx vitest run src/lib/providerCompare.test.js` — Expected: all PASS.
Run: `npm test` and `npm run build` — Expected: all existing tests still pass, build OK.

- [ ] **Step 5: Commit**

```bash
git add src/lib/providerCompare.js src/lib/providerCompare.test.js
git commit -m "feat(estimation): extruder comparison of aluminium cost

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```


### Task 9: Layout templates and quotation description format

**Files:**
- Create: `src/lib/layoutTemplates.js`
- Create: `src/lib/layoutTemplates.test.js`
- Create: `src/lib/descriptionFormat.js`
- Create: `src/lib/descriptionFormat.test.js`

**Interfaces:**
- Consumes: Rows of `estimation_layout_templates`, `alu_series_types`, `bom_templates`.
- Produces: `ADDON_POSITIONS`, `availableLayoutTemplates`, `applyLayoutTemplate`, `bomTemplatesForType`, `layoutTemplateFromItem`; `DESCRIPTION_TOKENS`, `DEFAULT_DESCRIPTION_FORMAT`, `descriptionParts`, `buildItemDescription`.

Layout templates are picked from the main type and show thumbnails; a series that lacks the main or add-on type greys the card with a reason. The description format is the ordered token list stored on the project (`description_format`) that builds the quotation description.

- [ ] **Step 1: Write the failing test** — create `src/lib/layoutTemplates.test.js` with exactly:

```js
import { describe, it, expect } from 'vitest'
import { availableLayoutTemplates, applyLayoutTemplate, bomTemplatesForType, layoutTemplateFromItem } from './layoutTemplates.js'

const seriesTypes = [{ series_id: 's1', type_id: 'slide' }, { series_id: 's1', type_id: 'fixed' }, { series_id: 's2', type_id: 'slide' }]
const tpls = [
  { id: 'a', name: 'บานเลื่อน + ช่องแสงบน', main_type_id: 'slide', addon_type_id: 'fixed', addon_position: 'top', addon_width_ratio: 1, addon_height_ratio: 0.3, addon_offset_ratio: 0, main_panel_count: 2, addon_panel_count: 1 },
  { id: 'b', name: 'บานเลื่อนเปล่า', main_type_id: 'slide', addon_type_id: null, addon_position: null },
  { id: 'c', name: 'ประตู', main_type_id: 'swing' },
  { id: 'd', name: 'ปิด', main_type_id: 'slide', active: false },
]

describe('availableLayoutTemplates', () => {
  it('shows only the main type\'s templates, usable first, with the reason for a greyed card', () => {
    const r = availableLayoutTemplates(tpls, { mainTypeId: 'slide', seriesId: 's2', seriesTypes })
    expect(r.map(x => [x.template.id, x.usable, x.reason])).toEqual([['b', true, null], ['a', false, 'addon_type_not_offered']])
    expect(availableLayoutTemplates(tpls, { mainTypeId: 'slide', seriesId: 's1', seriesTypes }).every(x => x.usable)).toBe(true)
  })
  it('without a series nothing is judged unusable; without a main type every active template shows', () => {
    expect(availableLayoutTemplates(tpls, { mainTypeId: 'slide', seriesId: null, seriesTypes }).every(x => x.usable)).toBe(true)
    expect(availableLayoutTemplates(tpls, { mainTypeId: null, seriesId: null, seriesTypes }).length).toBe(3)
  })
  it('a series that lacks the main type itself is not usable', () => {
    expect(availableLayoutTemplates(tpls, { mainTypeId: 'swing', seriesId: 's1', seriesTypes })[0].reason).toBe('main_type_not_offered')
  })
  it('without options does not throw', () => {
    expect(availableLayoutTemplates(tpls)).toHaveLength(3)
  })
})

describe('applyLayoutTemplate', () => {
  it('top add-on: width and offset against the main width, height against the main height', () => {
    expect(applyLayoutTemplate({ ...tpls[0], addon_width_ratio: 0.5, addon_offset_ratio: 0.25 }, 2, 1.5)).toEqual({
      main_panel_count: 2, addon_type_id: 'fixed', addon_position: 'top', addon_width_m: 1, addon_height_m: 0.45, addon_offset_m: 0.5, addon_panel_count: 1,
    })
  })
  it('left/right add-on: offset runs along the main height', () => {
    const r = applyLayoutTemplate({ ...tpls[0], addon_position: 'left', addon_width_ratio: 0.2, addon_offset_ratio: 0.5 }, 2, 1.5)
    expect(r.addon_offset_m).toBe(0.75)
    expect(r.addon_width_m).toBe(0.4)
  })
  it('a template without an add-on, or a missing size, is handled', () => {
    expect(applyLayoutTemplate(tpls[1], 2, 1.5).addon_type_id).toBeNull()
    expect(applyLayoutTemplate(tpls[0], 0, 1.5)).toBeNull()
    expect(applyLayoutTemplate(null, 2, 1.5)).toBeNull()
  })
  it('save-then-apply round trip for left and right returns same addon dimensions', () => {
    const t = layoutTemplateFromItem({ name: 'left-test', mainTypeId: 'swing', addonTypeId: 'fixed', position: 'left', widthM: 2, heightM: 1.5, addonWidthM: 0.4, addonHeightM: 0.45, offsetM: 0.75, mainPanels: 1, addonPanels: 1 })
    const result = applyLayoutTemplate(t, 2, 1.5)
    expect(result.addon_width_m).toBe(0.4)
    expect(result.addon_height_m).toBe(0.45)
    expect(result.addon_offset_m).toBe(0.75)
  })
  it('template with null addon_width_ratio and addon_height_ratio applies with finite defaults', () => {
    const result = applyLayoutTemplate({ main_type_id: 'slide', addon_type_id: 'fixed', addon_position: 'top', addon_width_ratio: null, addon_height_ratio: null, addon_offset_ratio: 0 }, 2, 1.5)
    expect(Number.isFinite(result.addon_width_m)).toBe(true)
    expect(Number.isFinite(result.addon_height_m)).toBe(true)
    expect(result.addon_width_m).toBe(2)
    expect(result.addon_height_m).toBe(0.5)
  })
  it('offset ratio of 1.5 is clamped to 1', () => {
    const result = applyLayoutTemplate({ ...tpls[0], addon_offset_ratio: 1.5 }, 2, 1.5)
    expect(result.addon_offset_m).toBe(2)
  })
})

describe('bomTemplatesForType / layoutTemplateFromItem', () => {
  it('finds the active BOM templates of a type', () => {
    expect(bomTemplatesForType([{ id: 1, type_id: 't' }, { id: 2, type_id: 't', active: false }, { id: 3, type_id: 'u' }], 't').map(t => t.id)).toEqual([1])
  })
  it('turns an item into ratios that apply back to the same sizes', () => {
    const t = layoutTemplateFromItem({ name: ' X ', mainTypeId: 'slide', addonTypeId: 'fixed', position: 'top', widthM: 2, heightM: 1.5, addonWidthM: 1, addonHeightM: 0.45, offsetM: 0.5, mainPanels: 2, addonPanels: 1 })
    expect(t).toMatchObject({ name: 'X', addon_width_ratio: 0.5, addon_height_ratio: 0.3, addon_offset_ratio: 0.25 })
    expect(applyLayoutTemplate(t, 2, 1.5)).toMatchObject({ addon_width_m: 1, addon_height_m: 0.45, addon_offset_m: 0.5 })
  })
  it('refuses a nameless template, and an offset beyond the side is clamped to 1', () => {
    expect(layoutTemplateFromItem({ name: ' ', mainTypeId: 'slide', widthM: 2, heightM: 1 })).toBeNull()
    expect(layoutTemplateFromItem({ name: 'x', mainTypeId: 'slide', addonTypeId: 'f', position: 'top', widthM: 2, heightM: 1, addonWidthM: 1, addonHeightM: 0.3, offsetM: 9 }).addon_offset_ratio).toBe(1)
  })
})

describe('ADDON_POSITIONS', () => {
  it('is the same list the preview uses', async () => {
    const fp = await import('./framePreview.js')
    const lt = await import('./layoutTemplates.js')
    expect(lt.ADDON_POSITIONS).toBe(fp.ADDON_POSITIONS)
  })
})
```

- [ ] **Step 2: Write the failing test** — create `src/lib/descriptionFormat.test.js` with exactly:

```js
import { describe, it, expect } from 'vitest'
import { buildItemDescription, descriptionParts, DEFAULT_DESCRIPTION_FORMAT } from './descriptionFormat.js'

const ctx = { item_name: 'D-01', type_name: 'ประตูบานเลื่อน', width_m: 2.4, height_m: 2.1, finish_name: 'อบขาว', series_label: 'Demo 40 · โรงรีด A', thickness_mm: 1.5, infill_name: 'กระจกเทมเปอร์ 6 มม.', hardware_set_name: 'HW-A' }

describe('buildItemDescription', () => {
  it('joins the chosen tokens in the chosen order', () => {
    expect(buildItemDescription(ctx, ['item_name', 'type', 'size', 'alu_color'])).toBe('D-01 ประตูบานเลื่อน 2.40 x 2.10 ม. สีอบขาว')
    expect(buildItemDescription(ctx, ['size', 'item_name'])).toBe('2.40 x 2.10 ม. D-01')
  })
  it('skips empty parts and unknown tokens; a missing list uses the default format', () => {
    expect(buildItemDescription({ item_name: 'D-01', width_m: 0, height_m: 0 }, ['item_name', 'size', 'alu_color', 'nonsense'])).toBe('D-01')
    expect(descriptionParts(ctx, undefined).length).toBe(DEFAULT_DESCRIPTION_FORMAT.length)
    expect(buildItemDescription(null, ['item_name'])).toBe('')
  })
  it('thickness, infill and hardware set render too, and a custom separator is honoured', () => {
    expect(buildItemDescription(ctx, ['thickness', 'infill', 'hardware_set'], ' / ')).toBe('หนา 1.5 มม. / กระจกเทมเปอร์ 6 มม. / HW-A')
  })
})
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `npx vitest run src/lib/layoutTemplates.test.js src/lib/descriptionFormat.test.js`
Expected: FAIL (module / export not found).

- [ ] **Step 4: Write the implementation** — create `src/lib/layoutTemplates.js` with exactly:

```js
// src/lib/layoutTemplates.js
// Layout templates ("แม่แบบรูปแบบ"): a main type + optional add-on type, position and proportions. They store NO series,
// colour, price or profile: those come from whatever series the item uses. Pure.
import { ADDON_POSITIONS } from './framePreview.js'
export { ADDON_POSITIONS }

const offers = (seriesTypes, seriesId, typeId) => (seriesTypes || []).some(st => st.series_id === seriesId && st.type_id === typeId)

const ratio = (v, fallback) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : fallback }

// Layout templates for the chosen main type, usable ones first. `reason` says why a card is greyed out.
export function availableLayoutTemplates(templates, { mainTypeId, seriesId, seriesTypes } = {}) {
  const rows = (templates || [])
    .filter(t => t.active !== false && (!mainTypeId || t.main_type_id === mainTypeId))
    .map(t => {
      let reason = null
      if (seriesId && !offers(seriesTypes, seriesId, t.main_type_id)) reason = 'main_type_not_offered'
      else if (seriesId && t.addon_type_id && !offers(seriesTypes, seriesId, t.addon_type_id)) reason = 'addon_type_not_offered'
      return { template: t, usable: reason === null, reason }
    })
  return [...rows.filter(r => r.usable), ...rows.filter(r => !r.usable)]
}

const r2 = n => Math.round(n * 100) / 100

// Proportions -> metres for a given main size. Add-on WIDTH ratio is always against the main width
// and HEIGHT ratio always against the main height, for all positions. Only the OFFSET ratio runs along
// the shared side: width for top/bottom, height for left/right.
export function applyLayoutTemplate(tpl, mainWidthM, mainHeightM) {
  if (!tpl || !(mainWidthM > 0) || !(mainHeightM > 0)) return null
  const out = { main_panel_count: tpl.main_panel_count || 1, addon_type_id: null, addon_position: null, addon_width_m: null, addon_height_m: null, addon_offset_m: 0, addon_panel_count: 1 }
  if (!tpl.addon_type_id || !ADDON_POSITIONS.includes(tpl.addon_position)) return out
  const horizontal = tpl.addon_position === 'top' || tpl.addon_position === 'bottom'
  const along = horizontal ? mainWidthM : mainHeightM
  const aw = mainWidthM * ratio(tpl.addon_width_ratio, 1)
  const ah = mainHeightM * ratio(tpl.addon_height_ratio, 0.33)
  return {
    ...out, addon_type_id: tpl.addon_type_id, addon_position: tpl.addon_position,
    addon_width_m: r2(aw), addon_height_m: r2(ah), addon_offset_m: r2(along * Math.min(1, Math.max(0, Number(tpl.addon_offset_ratio) || 0))),
    addon_panel_count: tpl.addon_panel_count || 1,
  }
}

// The BOM templates that can build a given type (a layout stores types, the item stores a BOM template).
export const bomTemplatesForType = (bomTemplates, typeId) => (bomTemplates || []).filter(t => t.active !== false && t.type_id === typeId)

// The values to save when the owner ticks "save as layout template" in the item form.
// Ratios are taken against the item's own sizes; the offset ratio is clamped to 0..1 so the template re-applies cleanly.
export function layoutTemplateFromItem({ name, mainTypeId, addonTypeId, position, widthM, heightM, addonWidthM, addonHeightM, offsetM, mainPanels, addonPanels }) {
  const base = { name: String(name || '').trim(), main_type_id: mainTypeId, main_panel_count: mainPanels || 1, active: true }
  if (!base.name || !mainTypeId || !(widthM > 0) || !(heightM > 0)) return null
  if (!addonTypeId || !ADDON_POSITIONS.includes(position) || !(addonWidthM > 0) || !(addonHeightM > 0)) {
    return { ...base, addon_type_id: null, addon_position: null, addon_offset_ratio: 0, addon_width_ratio: 1, addon_height_ratio: 0.33, addon_panel_count: 1 }
  }
  const horizontal = position === 'top' || position === 'bottom'
  const along = horizontal ? widthM : heightM
  return {
    ...base, addon_type_id: addonTypeId, addon_position: position, addon_panel_count: addonPanels || 1,
    addon_width_ratio: Math.round((addonWidthM / widthM) * 1000) / 1000,
    addon_height_ratio: Math.round((addonHeightM / heightM) * 1000) / 1000,
    addon_offset_ratio: Math.min(1, Math.max(0, Math.round(((offsetM || 0) / along) * 1000) / 1000)),
  }
}
```

- [ ] **Step 5: Write the implementation** — create `src/lib/descriptionFormat.js` with exactly:

```js
// src/lib/descriptionFormat.js
// The quotation description of an item is a configurable combination of parts (owner: item name, type, size,
// aluminium, colour ...). The project stores the ordered token list; this builds the text. Pure.
export const DESCRIPTION_TOKENS = [
  { key: 'item_name', label: 'ชื่อรายการ' },
  { key: 'type', label: 'ประเภท' },
  { key: 'size', label: 'ขนาด' },
  { key: 'series', label: 'ซีรีส์' },
  { key: 'alu_color', label: 'สีอลูมิเนียม' },
  { key: 'thickness', label: 'ความหนา' },
  { key: 'infill', label: 'วัสดุอุดช่อง' },
  { key: 'hardware_set', label: 'ชุดอุปกรณ์' },
]
export const DEFAULT_DESCRIPTION_FORMAT = ['item_name', 'type', 'size', 'alu_color']

const m2 = n => Number(n).toFixed(2)

// ctx: { item_name, type_name, width_m, height_m, series_label, finish_name, thickness_mm, infill_name, hardware_set_name }
export function descriptionParts(ctx, tokens) {
  const c = ctx || {}
  const text = {
    item_name: c.item_name,
    type: c.type_name,
    size: c.width_m > 0 && c.height_m > 0 ? `${m2(c.width_m)} x ${m2(c.height_m)} ม.` : '',
    series: c.series_label,
    alu_color: c.finish_name ? `สี${c.finish_name}` : '',
    thickness: c.thickness_mm > 0 ? `หนา ${Number(c.thickness_mm)} มม.` : '',
    infill: c.infill_name,
    hardware_set: c.hardware_set_name,
  }
  const known = new Set(DESCRIPTION_TOKENS.map(t => t.key))
  const list = Array.isArray(tokens) ? tokens : DEFAULT_DESCRIPTION_FORMAT
  return list.filter(k => known.has(k)).map(k => String(text[k] ?? '').trim()).filter(Boolean)
}

export const buildItemDescription = (ctx, tokens, separator = ' ') => descriptionParts(ctx, tokens).join(separator)
```

- [ ] **Step 6: Run the tests, then the whole suite and the build**

Run: `npx vitest run src/lib/layoutTemplates.test.js src/lib/descriptionFormat.test.js` — Expected: all PASS.
Run: `npm test` and `npm run build` — Expected: all existing tests still pass, build OK.

- [ ] **Step 7: Commit**

```bash
git add src/lib/layoutTemplates.js src/lib/layoutTemplates.test.js src/lib/descriptionFormat.js src/lib/descriptionFormat.test.js
git commit -m "feat(estimation): layout templates and quotation description builder

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```


### Task 10: Frame preview v2 (positions, joint seams, inside view, profile width, SVG snapshot)

**Files:**
- Create: `src/lib/framePreview2.test.js`
- Modify (full replace): `src/lib/framePreview.js`

**Interfaces:**
- Consumes: `resolveGrid` from `bomEngine.js`.
- Produces: `buildFramePreview({template, width_m, height_m, panel_count, addon, main_axis, view, frame_mm, part_labels})` (all new options optional; with none given the output equals Phase 2a), `ADDON_POSITIONS`, `previewSvgString(preview, {style, finishColor})`, `previewSignature(fields)`. New output fields: `units[].seams`, `units[].decor`, `labels`, `view`, `main_axis`.

The Phase 2a tests in `src/lib/framePreview.test.js` must pass UNCHANGED (they pin the old numbers); do not edit that file. The preview is for customers and the owner, not for CAD: keep pixel geometry (shop drawings are a later, separate extension).

- [ ] **Step 1: Write the failing test** — create `src/lib/framePreview2.test.js` with exactly:

```js
// src/lib/framePreview2.test.js  (Phase 2b additions; the Phase 2a tests in framePreview.test.js must still pass unchanged)
import { describe, it, expect } from 'vitest'
import { buildFramePreview, previewSvgString, previewSignature } from './framePreview.js'

const tpl = (o = {}) => ({ grid_row_weights: [1], ...o })
const base = { template: tpl(), width_m: 2, height_m: 2, panel_count: 1 }
const withAddon = (o = {}) => ({ ...base, addon: { template: tpl(), width_m: 1, height_m: 0.5, panel_count: 1, ...o } })

describe('add-on position and offset', () => {
  it('top (default) centres the add-on on the main unit; offset_m moves it along the side from the left', () => {
    const c = buildFramePreview(withAddon())
    const [a, m] = c.units
    expect(a.outer.x + a.outer.w / 2).toBeCloseTo(m.outer.x + m.outer.w / 2)
    const o = buildFramePreview(withAddon({ offset_m: 0 }))
    expect(o.units[0].outer.x).toBeCloseTo(o.units[1].outer.x)
    const o2 = buildFramePreview(withAddon({ offset_m: 0.5 }))
    expect(o2.units[0].outer.x - o2.units[1].outer.x).toBeCloseTo(0.5 * o2.scale)
  })
  it('bottom puts the add-on below and touching; left/right put it beside and touching', () => {
    const b = buildFramePreview(withAddon({ position: 'bottom' }))
    expect(b.units[0].outer.y).toBeCloseTo(b.units[1].outer.y + b.units[1].outer.h)
    const l = buildFramePreview(withAddon({ position: 'left', width_m: 0.5, height_m: 1 }))
    expect(l.units[0].outer.x + l.units[0].outer.w).toBeCloseTo(l.units[1].outer.x)
    const r = buildFramePreview(withAddon({ position: 'right', width_m: 0.5, height_m: 1 }))
    expect(r.units[0].outer.x).toBeCloseTo(r.units[1].outer.x + r.units[1].outer.w)
  })
  it('everything stays inside the view box, whatever the position', () => {
    for (const position of ['top', 'bottom', 'left', 'right']) {
      const p = buildFramePreview(withAddon({ position, width_m: 3, height_m: 1.5, offset_m: 0.4 }))
      for (const u of p.units) {
        expect(u.outer.x).toBeGreaterThanOrEqual(-1e-6)
        expect(u.outer.y).toBeGreaterThanOrEqual(-1e-6)
        expect(u.outer.x + u.outer.w).toBeLessThanOrEqual(p.viewBox.width + 1e-6)
        expect(u.outer.y + u.outer.h).toBeLessThanOrEqual(p.viewBox.height + 1e-6)
      }
    }
  })
  it('an unknown position falls back to top; the add-on also reports its own width dimension', () => {
    const d = buildFramePreview(withAddon({ position: 'diagonal' }))
    expect(d.units[0].outer.y).toBeLessThan(d.units[1].outer.y)
    const p = buildFramePreview(withAddon())
    expect(p.dims.filter(d => d.unit === 'addon').map(d => [d.kind, d.text]).sort()).toEqual([['height', '0.50 ม.'], ['width', '1.00 ม.']])
  })
})

describe('joint seams and main axis', () => {
  it('draws four seams per unit; vertical main = vertical seams at the inner edge, horizontal main = horizontal seams', () => {
    const v = buildFramePreview(base).units[0]
    expect(v.seams).toHaveLength(4)
    expect(v.seams.every(s => s.x1 === s.x2 && s.y1 !== s.y2)).toBe(true)
    const h = buildFramePreview({ ...base, main_axis: 'horizontal' }).units[0]
    expect(h.seams.every(s => s.y1 === s.y2 && s.x1 !== s.x2)).toBe(true)
    expect(v.seams[0].x1).toBeCloseTo(v.inner.x)
  })
})

describe('frame width from the profile', () => {
  it('frame_mm sets the drawn frame at scale; without it the Phase 2a 4..10 px rule applies', () => {
    const p = buildFramePreview({ ...base, frame_mm: 44.45 })
    const u = p.units[0]
    expect(u.inner.x - u.outer.x).toBeCloseTo((44.45 / 1000) * p.scale)
    const wide = buildFramePreview({ ...base, frame_mm: 400 }).units[0]
    expect(wide.inner.w).toBeGreaterThan(0)
    const none = buildFramePreview(base).units[0]
    expect(none.inner.x - none.outer.x).toBeLessThanOrEqual(10)
  })
})

describe('inside view', () => {
  it('mirrors left-right: an add-on on the right in the outside view appears on the left inside; dimension text is unchanged', () => {
    const out = buildFramePreview(withAddon({ position: 'right', width_m: 0.5, height_m: 1 }))
    const inn = buildFramePreview({ ...withAddon({ position: 'right', width_m: 0.5, height_m: 1 }), view: 'in' })
    expect(inn.view).toBe('in')
    expect(out.units[0].outer.x).toBeGreaterThan(out.units[1].outer.x)
    expect(inn.units[0].outer.x).toBeLessThan(inn.units[1].outer.x)
    expect(inn.dims.map(d => d.text)).toEqual(out.dims.map(d => d.text))
    expect(inn.viewBox).toEqual(out.viewBox)
  })
  it('a unit keeps its size when mirrored', () => {
    const out = buildFramePreview(base).units[0]
    const inn = buildFramePreview({ ...base, view: 'in' }).units[0]
    expect(inn.outer.w).toBeCloseTo(out.outer.w)
    expect(inn.outer.h).toBeCloseTo(out.outer.h)
  })
})

describe('decoration and part labels', () => {
  it('slide kind with 2+ panels gets a handle and an arrow; swing gets a dashed arc and a knob; fixed gets nothing', () => {
    expect(buildFramePreview({ ...base, template: tpl({ preview_kind: 'slide' }), panel_count: 2 }).units[0].decor.map(d => d.type)).toEqual(['line', 'polyline'])
    expect(buildFramePreview({ ...base, template: tpl({ preview_kind: 'swing' }) }).units[0].decor.map(d => d.type)).toEqual(['polyline', 'circle'])
    expect(buildFramePreview({ ...base, template: tpl({ preview_kind: 'slide' }), panel_count: 1 }).units[0].decor).toEqual([])
    expect(buildFramePreview(base).units[0].decor).toEqual([])
  })
  it('part labels are placed on the four bars and move to the mirrored side inside', () => {
    const labels = { top: 'T', bottom: 'B', left: 'L', right: 'R' }
    const out = buildFramePreview({ ...base, part_labels: labels })
    expect(out.labels.map(l => l.side).sort()).toEqual(['bottom', 'left', 'right', 'top'])
    const inn = buildFramePreview({ ...base, part_labels: labels, view: 'in' })
    const x = (p, side) => p.labels.find(l => l.side === side).x
    expect(x(out, 'left')).toBeLessThan(x(out, 'right'))
    expect(x(inn, 'left')).toBeGreaterThan(x(inn, 'right'))
    expect(buildFramePreview(base).labels).toEqual([])
  })
})

describe('previewSvgString', () => {
  it('returns a self-contained svg with no css variables, the dimension text, and escapes label text', () => {
    const p = buildFramePreview({ ...base, part_labels: { top: 'A<B&C' } })
    const svg = previewSvgString(p, { style: 'double' })
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
    expect(svg).not.toMatch(/var\(--/)
    expect(svg).toContain('2.00 ม.')
    expect(svg).toContain('A&lt;B&amp;C')
  })
  it('cad has no fills, solid uses the finish colour, null preview gives an empty string', () => {
    const p = buildFramePreview(base)
    expect(previewSvgString(p, { style: 'cad' })).toContain('fill="none" stroke="#1f2328" stroke-width="1.2"')
    expect(previewSvgString(p, { style: 'solid', finishColor: '#2b2f33' })).toContain('fill="#2b2f33"')
    expect(previewSvgString(null)).toBe('')
  })
})

describe('previewSignature', () => {
  it('changes with any input that changes the drawing and is stable otherwise', () => {
    const a = { template_id: 't', width_m: 2, height_m: 1.5, panel_count: 2, addon_template_id: 'x', addon_width_m: 1, addon_height_m: 0.5 }
    expect(previewSignature(a)).toBe(previewSignature({ ...a }))
    expect(previewSignature(a)).not.toBe(previewSignature({ ...a, width_m: 2.1 }))
    expect(previewSignature(a)).not.toBe(previewSignature({ ...a, addon_position: 'bottom' }))
    expect(previewSignature(a)).not.toBe(previewSignature({ ...a, main_axis: 'horizontal' }))
  })
})

describe('fix round 1: svg safety, signature completeness, empty offset', () => {
  it('finishColor is validated before it reaches an attribute', () => {
    const p = buildFramePreview(base)
    const bad = previewSvgString(p, { style: 'solid', finishColor: '" onload="x' })
    expect(bad).not.toContain('onload')
    expect(bad).toContain('fill="#f4f4f2"')
    expect(previewSvgString(p, { style: 'solid', finishColor: '#2b2f33' })).toContain('fill="#2b2f33"')
  })
  it('signature tells centred from offset 0 and sees frame widths', () => {
    const a = { template_id: 't', width_m: 2, height_m: 1.5, panel_count: 2, addon_template_id: 'x', addon_width_m: 1, addon_height_m: 0.5 }
    expect(previewSignature({ ...a, addon_offset_m: null })).not.toBe(previewSignature({ ...a, addon_offset_m: 0 }))
    expect(previewSignature({ ...a, addon_offset_m: '' })).toBe(previewSignature({ ...a, addon_offset_m: null }))
    expect(previewSignature({ ...a, frame_mm: 40 })).not.toBe(previewSignature({ ...a, frame_mm: 44.45 }))
    expect(previewSignature({ ...a, addon_frame_mm: 40 })).not.toBe(previewSignature({ ...a, addon_frame_mm: 44.45 }))
    expect(previewSignature({ ...a, frame_mm: 40 })).toBe(previewSignature({ ...a, frame_mm: 40 }))
  })
  it('an empty-string offset centres the add-on like null', () => {
    const e = buildFramePreview(withAddon({ offset_m: '' }))
    const n = buildFramePreview(withAddon({ offset_m: null }))
    expect(e.units[0].outer.x).toBeCloseTo(n.units[0].outer.x)
    expect(e.units[0].outer.x).toBeCloseTo(e.units[1].outer.x + (e.units[1].outer.w - e.units[0].outer.w) / 2)
  })
  it('a mirrored preview serialises without NaN or undefined', () => {
    const svg = previewSvgString(buildFramePreview({ ...withAddon({ position: 'right' }), view: 'in', template: tpl({ preview_kind: 'swing' }), part_labels: { left: 'L' } }))
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg).not.toMatch(/NaN|undefined/)
  })
})

describe('Follow-up A: normalised, complete signature', () => {
  const a = { template_id: 't', width_m: 1.2, height_m: 1.5, panel_count: 2 }
  it('form strings and DB numbers give the same signature; a stale hidden add-on value does not matter', () => {
    expect(previewSignature({ ...a, width_m: '1.20', height_m: '1.50', panel_count: '2' })).toBe(previewSignature(a))
    expect(previewSignature({ ...a, addon_offset_m: '' })).toBe(previewSignature({ ...a, addon_offset_m: null }))
    expect(previewSignature({ ...a, frame_mm: '' })).toBe(previewSignature({ ...a, frame_mm: null }))
    expect(previewSignature({ ...a, addon_position: 'top', addon_width_m: '1', addon_panel_count: 3, addon_offset_m: 0.2, addon_frame_mm: 40, addon_main_axis: 'horizontal' })).toBe(previewSignature(a))
    expect(previewSignature({ ...a, addon_template_id: 'x', addon_width_m: '1.0' })).toBe(previewSignature({ ...a, addon_template_id: 'x', addon_width_m: 1 }))
  })
  it('preview kind, row weights and the add-on axis change it', () => {
    const s = previewSignature(a)
    expect(previewSignature({ ...a, preview_kind: 'slide' })).not.toBe(s)
    expect(previewSignature({ ...a, grid_row_weights: [1, 2] })).not.toBe(s)
    const w = { ...a, addon_template_id: 'x', addon_width_m: 1, addon_height_m: 1 }
    expect(previewSignature({ ...w, addon_main_axis: 'horizontal' })).not.toBe(previewSignature(w))
    expect(previewSignature({ ...w, addon_preview_kind: 'swing' })).not.toBe(previewSignature(w))
    expect(previewSignature({ ...w, addon_grid_row_weights: [1, 1] })).not.toBe(previewSignature(w))
  })
  it('an add-on can have its own main axis for the seams', () => {
    const p = buildFramePreview(withAddon({ main_axis: 'horizontal' }))
    const [ad, mn] = p.units
    expect(ad.seams[0].y1).toBe(ad.seams[0].y2)
    expect(mn.seams[0].x1).toBe(mn.seams[0].x2)
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run src/lib/framePreview2.test.js` — Expected: FAIL (new exports / fields missing).

- [ ] **Step 3: Replace `src/lib/framePreview.js`** with exactly:

```js
// src/lib/framePreview.js
// Geometry for the type/add-on preview: a double-line frame (outer + inner rectangle), double-line
// interior members taken from the template grid, joint seams at the corners (which bars run full length),
// dimension labels, and an inside or outside view. Pure -- a screen draws it, previewSvgString() serialises it.
// Every option added in Phase 2b is optional and defaults to the Phase 2a drawing exactly.
import { resolveGrid } from './bomEngine.js'

const BOX_W = 280
const BOX_H = 220
const MARGIN = 40
const MEMBER_GAP = 4
const MAX_PANELS = 12
export const ADDON_POSITIONS = ['top', 'bottom', 'left', 'right']

// Preview-only guards: a template without usable row weights draws equal rows (or one row), never NaN or a throw.
function safeWeights(template) {
  const w = template && template.grid_row_weights
  if (!Array.isArray(w) || w.length === 0) return [1]
  const ok = w.every(n => Number.isFinite(n) && n >= 0) && w.reduce((a, b) => a + b, 0) > 0
  return ok ? w : w.map(() => 1)
}
const safePanels = n => clamp(Math.floor(Number.isFinite(n) ? n : 1), 1, MAX_PANELS)

const positive = n => Number.isFinite(n) && n > 0
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const metres = n => `${n.toFixed(2)} ม.`

// frame_mm: the visible width of the frame profile in mm (from the catalog). With it the drawn frame is that
// wide at scale (customers see how much of the view the frame takes); without it the Phase 2a 4..10 px rule applies.
function drawUnit(kind, template, w_m, h_m, panel_count, scale, x, y, opts) {
  const outer = { x, y, w: w_m * scale, h: h_m * scale }
  const short = Math.min(outer.w, outer.h)
  const t = opts.frame_mm > 0
    ? Math.min(clamp((opts.frame_mm / 1000) * scale, 2, 60), short / 3)
    : Math.min(clamp(0.045 * short, 4, 10), short / 3)
  const inner = { x: outer.x + t, y: outer.y + t, w: outer.w - 2 * t, h: outer.h - 2 * t }

  const columnsWanted = safePanels(panel_count)
  const { cells, columnCount } = resolveGrid({ ...template, grid_row_weights: safeWeights(template) }, { width_m: w_m, height_m: h_m, panel_count: columnsWanted })
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

  // Seams: where the secondary bars end against the main bars (the main bars run through the corners).
  const seams = opts.main_axis === 'horizontal'
    ? [[outer.x, inner.y, inner.x, inner.y], [inner.x + inner.w, inner.y, outer.x + outer.w, inner.y],
       [outer.x, inner.y + inner.h, inner.x, inner.y + inner.h], [inner.x + inner.w, inner.y + inner.h, outer.x + outer.w, inner.y + inner.h]]
    : [[inner.x, outer.y, inner.x, inner.y], [inner.x + inner.w, outer.y, inner.x + inner.w, inner.y],
       [inner.x, inner.y + inner.h, inner.x, outer.y + outer.h], [inner.x + inner.w, inner.y + inner.h, inner.x + inner.w, outer.y + outer.h]]
  const seamLines = seams.map(([x1, y1, x2, y2]) => ({ x1, y1, x2, y2 }))

  // Decoration by the template's preview_kind: a sliding handle + travel arrow, or a swing arc + knob.
  const decor = []
  const kind2 = template && template.preview_kind
  if (kind2 === 'slide' && columnCount > 1) {
    const hx = inner.x + inner.w / columnCount
    decor.push({ type: 'line', x1: hx, y1: inner.y + inner.h * 0.42, x2: hx, y2: inner.y + inner.h * 0.58, heavy: true })
    decor.push({ type: 'polyline', points: [[inner.x + inner.w * 0.1, inner.y + inner.h * 0.82], [inner.x + inner.w * 0.1 + inner.w / columnCount * 0.6, inner.y + inner.h * 0.82]], arrow: true })
  } else if (kind2 === 'swing') {
    decor.push({ type: 'polyline', points: [[inner.x + inner.w, inner.y], [inner.x, inner.y + inner.h / 2], [inner.x + inner.w, inner.y + inner.h]], dashed: true })
    decor.push({ type: 'circle', cx: inner.x + inner.w - t * 1.4, cy: inner.y + inner.h / 2, r: Math.max(2.2, t * 0.35) })
  }
  return { kind, outer, inner, lines, seams: seamLines, decor }
}

// World rectangle of the add-on in metres, main at (0,0). offset_m runs along the shared side (null = centred).
function addonRect(position, offset, w, h, aw, ah) {
  const along = (len, alen) => (Number.isFinite(offset) && offset !== null ? offset : (len - alen) / 2)
  if (position === 'bottom') return { x: along(w, aw), y: h }
  if (position === 'left') return { x: -aw, y: along(h, ah) }
  if (position === 'right') return { x: w, y: along(h, ah) }
  return { x: along(w, aw), y: -ah }                              // 'top' (default)
}

const mirrorX = (x, W) => W - x
function mirrorPreview(p) {
  const W = p.viewBox.width
  const rect = r => ({ ...r, x: mirrorX(r.x + r.w, W) })
  const seg = l => ({ ...l, x1: mirrorX(l.x1, W), x2: mirrorX(l.x2, W) })
  return {
    ...p, view: 'in',
    units: p.units.map(u => ({
      ...u, outer: rect(u.outer), inner: rect(u.inner), lines: u.lines.map(seg), seams: u.seams.map(seg),
      decor: u.decor.map(d => (d.type === 'circle' ? { ...d, cx: mirrorX(d.cx, W) } : d.type === 'polyline' ? { ...d, points: d.points.map(([x, y]) => [mirrorX(x, W), y]) } : seg(d))),
    })),
    dims: p.dims.map(seg),
    labels: p.labels.map(l => ({ ...l, x: mirrorX(l.x, W) })),
  }
}

// opts (all optional): main_axis 'vertical' | 'horizontal' (default vertical: the left/right bars run full height),
// view 'out' | 'in', frame_mm, part_labels { top, bottom, left, right } (text placed on the main unit's four bars),
// addon { template, width_m, height_m, panel_count, position, offset_m, frame_mm, main_axis (default: the main axis) }.
export function buildFramePreview({ template, width_m, height_m, panel_count, addon, main_axis, view, frame_mm, part_labels }) {
  if (!template || !positive(width_m) || !positive(height_m)) return null
  const addonOk = addon && addon.template && positive(addon.width_m) && positive(addon.height_m)
  const position = addonOk && ADDON_POSITIONS.includes(addon.position) ? addon.position : 'top'
  const axis = main_axis === 'horizontal' ? 'horizontal' : 'vertical'

  const ar = addonOk ? addonRect(position, addon.offset_m === '' || addon.offset_m == null ? null : Number(addon.offset_m), width_m, height_m, addon.width_m, addon.height_m) : null
  const minX = addonOk ? Math.min(0, ar.x) : 0
  const minY = addonOk ? Math.min(0, ar.y) : 0
  const totalW = (addonOk ? Math.max(width_m, ar.x + addon.width_m) : width_m) - minX
  const totalH = (addonOk ? Math.max(height_m, ar.y + addon.height_m) : height_m) - minY
  const scale = Math.min(BOX_W / totalW, BOX_H / totalH)
  const px = v => MARGIN + (v - minX) * scale
  const py = v => MARGIN + (v - minY) * scale

  const units = []
  if (addonOk) units.push(drawUnit('addon', addon.template, addon.width_m, addon.height_m, addon.panel_count, scale, px(ar.x), py(ar.y), { main_axis: addon.main_axis ? (addon.main_axis === 'horizontal' ? 'horizontal' : 'vertical') : axis, frame_mm: addon.frame_mm }))
  units.push(drawUnit('main', template, width_m, height_m, panel_count, scale, px(0), py(0), { main_axis: axis, frame_mm }))

  const main = units[units.length - 1]
  const o = main.outer
  const dims = [
    { kind: 'width', unit: 'main', x1: o.x, y1: position === 'bottom' && addonOk ? o.y - 20 : o.y + o.h + 20, x2: o.x + o.w, y2: position === 'bottom' && addonOk ? o.y - 20 : o.y + o.h + 20, text: metres(width_m) },
    { kind: 'height', unit: 'main', x1: position === 'right' && addonOk ? o.x - 20 : o.x + o.w + 20, y1: o.y, x2: position === 'right' && addonOk ? o.x - 20 : o.x + o.w + 20, y2: o.y + o.h, text: metres(height_m) },
  ]
  if (addonOk) {
    const a = units[0].outer
    const wy = position === 'bottom' ? a.y + a.h + 20 : a.y - 20
    dims.push({ kind: 'width', unit: 'addon', x1: a.x, y1: wy, x2: a.x + a.w, y2: wy, text: metres(addon.width_m) })
    const hx = position === 'left' ? a.x - 20 : a.x + a.w + 20
    dims.push({ kind: 'height', unit: 'addon', x1: hx, y1: a.y, x2: hx, y2: a.y + a.h, text: metres(addon.height_m) })
  }

  const labels = []
  if (part_labels) {
    const t = main.inner.x - o.x
    if (part_labels.top) labels.push({ side: 'top', x: o.x + o.w / 2, y: o.y + t * 0.8, text: part_labels.top, rotate: false })
    if (part_labels.bottom) labels.push({ side: 'bottom', x: o.x + o.w / 2, y: o.y + o.h - t * 0.2, text: part_labels.bottom, rotate: false })
    if (part_labels.left) labels.push({ side: 'left', x: o.x + t * 0.8, y: o.y + o.h / 2, text: part_labels.left, rotate: true })
    if (part_labels.right) labels.push({ side: 'right', x: o.x + o.w - t * 0.2, y: o.y + o.h / 2, text: part_labels.right, rotate: true })
  }

  const out = { viewBox: { width: totalW * scale + 2 * MARGIN, height: totalH * scale + 2 * MARGIN }, units, dims, labels, scale, view: 'out', main_axis: axis }
  return view === 'in' ? mirrorPreview(out) : out
}

// ---- serialising -------------------------------------------------------------------------------------------
// A self-contained SVG string with literal colours (no CSS variables), so it can be stored with the item and
// attached to a quotation. style: 'double' | 'solid' | 'cad'; part labels are drawn whenever the preview has them.
const INK = '#1f2328'
const FRAME = '#d6dbe0'
const GLASS = '#cfe8f5'
const DIM = '#6b7280'
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const n2 = n => Math.round(n * 100) / 100

export function previewSvgString(p, { style = 'double', finishColor = '#f4f4f2' } = {}) {
  if (!p) return ''
  if (!/^#[0-9a-f]{3,8}$/i.test(String(finishColor))) finishColor = '#f4f4f2'
  const frameFill = style === 'cad' ? 'none' : style === 'solid' ? finishColor : FRAME
  const glassFill = style === 'cad' ? 'none' : GLASS
  const parts = []
  for (const u of p.units) {
    parts.push(`<rect x="${n2(u.outer.x)}" y="${n2(u.outer.y)}" width="${n2(u.outer.w)}" height="${n2(u.outer.h)}" fill="${frameFill}" stroke="${INK}" stroke-width="1.2"/>`)
    parts.push(`<rect x="${n2(u.inner.x)}" y="${n2(u.inner.y)}" width="${n2(u.inner.w)}" height="${n2(u.inner.h)}" fill="${glassFill}" stroke="${INK}" stroke-width="1"/>`)
    for (const l of u.lines) parts.push(`<line x1="${n2(l.x1)}" y1="${n2(l.y1)}" x2="${n2(l.x2)}" y2="${n2(l.y2)}" stroke="${INK}" stroke-width="1"/>`)
    for (const l of u.seams) parts.push(`<line x1="${n2(l.x1)}" y1="${n2(l.y1)}" x2="${n2(l.x2)}" y2="${n2(l.y2)}" stroke="${INK}" stroke-width="1.2"/>`)
    for (const d of u.decor) {
      if (d.type === 'circle') parts.push(`<circle cx="${n2(d.cx)}" cy="${n2(d.cy)}" r="${n2(d.r)}" fill="${INK}"/>`)
      else if (d.type === 'polyline') parts.push(`<polyline points="${d.points.map(([x, y]) => `${n2(x)},${n2(y)}`).join(' ')}" fill="none" stroke="${INK}" stroke-width="0.9"${d.dashed ? ' stroke-dasharray="4 3"' : ''}/>`)
      else parts.push(`<line x1="${n2(d.x1)}" y1="${n2(d.y1)}" x2="${n2(d.x2)}" y2="${n2(d.y2)}" stroke="${INK}" stroke-width="${d.heavy ? 3 : 1}" stroke-linecap="round"/>`)
    }
  }
  for (const d of p.dims) {
    const vertical = d.kind === 'height'
    const tick = vertical ? `<line x1="${n2(d.x1 - 6)}" y1="${n2(d.y1)}" x2="${n2(d.x1 + 6)}" y2="${n2(d.y1)}" stroke="${DIM}" stroke-width=".8"/><line x1="${n2(d.x2 - 6)}" y1="${n2(d.y2)}" x2="${n2(d.x2 + 6)}" y2="${n2(d.y2)}" stroke="${DIM}" stroke-width=".8"/>`
      : `<line x1="${n2(d.x1)}" y1="${n2(d.y1 - 6)}" x2="${n2(d.x1)}" y2="${n2(d.y1 + 6)}" stroke="${DIM}" stroke-width=".8"/><line x1="${n2(d.x2)}" y1="${n2(d.y2 - 6)}" x2="${n2(d.x2)}" y2="${n2(d.y2 + 6)}" stroke="${DIM}" stroke-width=".8"/>`
    parts.push(`<line x1="${n2(d.x1)}" y1="${n2(d.y1)}" x2="${n2(d.x2)}" y2="${n2(d.y2)}" stroke="${DIM}" stroke-width=".8"/>${tick}`)
    const cx = (d.x1 + d.x2) / 2
    const cy = (d.y1 + d.y2) / 2
    parts.push(vertical
      ? `<text x="${n2(d.x1 - 5)}" y="${n2(cy)}" font-size="11" fill="${DIM}" text-anchor="middle" transform="rotate(-90 ${n2(d.x1 - 5)} ${n2(cy)})">${esc(d.text)}</text>`
      : `<text x="${n2(cx)}" y="${n2(d.y1 - 4)}" font-size="11" fill="${DIM}" text-anchor="middle">${esc(d.text)}</text>`)
  }
  for (const l of p.labels || []) {
    parts.push(`<text x="${n2(l.x)}" y="${n2(l.y)}" font-size="9" fill="${INK}" text-anchor="middle"${l.rotate ? ` transform="rotate(-90 ${n2(l.x)} ${n2(l.y)})"` : ''}>${esc(l.text)}</text>`)
  }
  const w = n2(p.viewBox.width)
  const h = n2(p.viewBox.height)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${parts.join('')}</svg>`
}

// Cheap signature of every input that changes the saved drawing; the item stores it with the snapshot so a
// later edit can be detected ("the saved preview is older than the item"). Normalised: form strings and DB
// numbers give the same string, and an add-on's fields are ignored while there is no add-on.
export function previewSignature({ template_id, width_m, height_m, panel_count, addon_template_id, addon_width_m, addon_height_m, addon_panel_count, addon_position, addon_offset_m, main_axis, frame_mm, addon_frame_mm, preview_kind, grid_row_weights, addon_preview_kind, addon_grid_row_weights, addon_main_axis }) {
  const num = v => (v === null || v === undefined || String(v).trim() === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null))
  const hasAddon = !(addon_template_id === null || addon_template_id === undefined || String(addon_template_id).trim() === '')
  const a = hasAddon
    ? [addon_template_id, num(addon_width_m), num(addon_height_m), num(addon_panel_count) ?? 1, addon_position ?? null, num(addon_offset_m), num(addon_frame_mm)]
    : [null, null, null, 1, null, null, null]
  return JSON.stringify([
    template_id ?? null, num(width_m), num(height_m), num(panel_count) ?? 1,
    ...a.slice(0, 6),
    main_axis ?? 'vertical', num(frame_mm), a[6],
    preview_kind ?? 'fixed', Array.isArray(grid_row_weights) ? grid_row_weights : null,
    hasAddon ? (addon_preview_kind ?? null) : null, hasAddon && Array.isArray(addon_grid_row_weights) ? addon_grid_row_weights : null, hasAddon ? (addon_main_axis ?? null) : null,
  ])
}
```

- [ ] **Step 4: Run both preview test files, the whole suite, the build**

Run: `npx vitest run src/lib/framePreview.test.js src/lib/framePreview2.test.js` — Expected: PASS (the old file unchanged and green).
Run: `npm test` and `npm run build` — Expected: OK.

- [ ] **Step 5: Commit**

```bash
git add src/lib/framePreview.js src/lib/framePreview2.test.js
git commit -m "feat(estimation): frame preview v2 (add-on positions, joint seams, inside view, profile width, svg snapshot)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```


### Task 11: Item form payload, template save helpers, profile sketch, data hooks

**Files:**
- Create: `src/lib/openingPayload.js`
- Create: `src/lib/openingPayload.test.js`
- Create: `src/lib/templateSave.js`
- Create: `src/lib/templateSave.test.js`
- Create: `src/lib/profileSketch.js`
- Create: `src/lib/profileSketch.test.js`
- Create: `src/hooks/useEstimation2b.js`

**Interfaces:**
- Consumes: `useCatalogTable`, `fetchCatalogRows`, `mergeSettings`.
- Produces: `emptyForm`, `formFromOpening`, `buildOpeningPayload(form, {projectId, previews, savedAt})` (frame `thickness_mm` and `sash_thickness_mm`), `validateForm`; `jointRowsForInsert`, `validateJoints`, `componentRowsForInsert`, `jointIndexForLoad`; `profileSketchSvg`; hooks `useEstimationSettings`, `saveEstimationSettings`, `useLayoutTemplates`, `useTemplateJoints`, `useProjectStock`, `groupByTemplate`.

The item form state <-> row mapping (inherit = NULL, explicit "none" flags, labour 0 is a real value, no quantity), the helpers that keep component->joint links correct when a template is saved by delete + reinsert, the profile cross-section sketch, and the data hooks the screens use. The hooks file has no unit test (it only wires Supabase); the build must pass.

- [ ] **Step 1: Write the failing test** — create `src/lib/openingPayload.test.js` with exactly:

```js
import { describe, it, expect } from 'vitest'
import { emptyForm, formFromOpening, buildOpeningPayload, validateForm } from './openingPayload.js'

const filled = (o = {}) => ({ ...emptyForm(), opening_no: 'D1', template_id: 't1', width_m: '2.4', height_m: '2.1', ...o })

describe('buildOpeningPayload', () => {
  it('blank inherit fields become NULL, never empty strings or 0', () => {
    const p = buildOpeningPayload(filled(), { projectId: 'p1' })
    expect(p).toMatchObject({ project_id: 'p1', series_id: null, alu_finish_id: null, thickness_mm: null, sash_thickness_mm: null, infill_type_id: null, hardware_set_id: null, labour_per_sqm: null, profit_pct: null, item_name: null })
    expect(p.no_infill).toBe(false)
    expect(p).not.toHaveProperty('quantity')
    expect(p).not.toHaveProperty('preview_svg_out')
  })
  it('labour 0 and profit 0 are real values, not "inherit"', () => {
    const p = buildOpeningPayload(filled({ labour_per_sqm: '0', profit_pct: '0' }), { projectId: 'p1' })
    expect(p.labour_per_sqm).toBe(0)
    expect(p.profit_pct).toBe(0)
  })
  it('frame and sash thickness are separate numbers; blank sash = same as frame (NULL)', () => {
    const p = buildOpeningPayload(filled({ thickness_mm: '2', sash_thickness_mm: '1.5' }), { projectId: 'p1' })
    expect(p).toMatchObject({ thickness_mm: 2, sash_thickness_mm: 1.5 })
    expect(buildOpeningPayload(filled({ thickness_mm: '2' }), { projectId: 'p1' }).sash_thickness_mm).toBeNull()
  })
  it('"none" flags win over a leftover selection', () => {
    const p = buildOpeningPayload(filled({ no_infill: true, infill_type_id: 'g1', no_hardware_set: true, hardware_set_id: 'h1' }), { projectId: 'p1' })
    expect(p).toMatchObject({ no_infill: true, infill_type_id: null, no_hardware_set: true, hardware_set_id: null })
  })
  it('add-on fields are cleared when the add-on is switched off, and kept (with position/offset) when on', () => {
    const off = buildOpeningPayload(filled({ has_addon: false, addon_template_id: 't2', addon_width_m: '1', addon_position: 'bottom' }), { projectId: 'p1' })
    expect(off).toMatchObject({ addon_template_id: null, addon_width_m: null, addon_position: null, addon_offset_m: null, addon_panel_count: 1 })
    const on = buildOpeningPayload(filled({ has_addon: true, addon_template_id: 't2', addon_width_m: '1.2', addon_height_m: '0.4', addon_position: 'left', addon_offset_m: '0.3' }), { projectId: 'p1' })
    expect(on).toMatchObject({ addon_template_id: 't2', addon_width_m: 1.2, addon_height_m: 0.4, addon_position: 'left', addon_offset_m: 0.3 })
  })
  it('snapshots are included only when previews are passed', () => {
    const p = buildOpeningPayload(filled(), { projectId: 'p1', previews: { out: '<svg/>', in: null, sig: 's' }, savedAt: '2026-10-09T10:00:00Z' })
    expect(p).toMatchObject({ preview_svg_out: '<svg/>', preview_svg_in: null, preview_sig: 's', preview_saved_at: '2026-10-09T10:00:00Z' })
  })
  it('extra lines are normalised; text numbers become numbers; an invalid panel count falls back to 1', () => {
    const p = buildOpeningPayload(filled({ panel_count: '0', extra_lines: [{ description: 'Fire barrier', amount: '1500' }, { description: null, amount: 'x' }] }), { projectId: 'p1' })
    expect(p.panel_count).toBe(1)
    expect(p.extra_lines).toEqual([{ description: 'Fire barrier', amount: 1500 }, { description: '', amount: 0 }])
  })
})

describe('formFromOpening', () => {
  it('round-trips an item row (NULLs show as empty text)', () => {
    const row = { opening_no: 'D1', template_id: 't1', width_m: 2.4, height_m: 2.1, panel_count: 2, series_id: null, thickness_mm: 1.5, no_infill: true, addon_template_id: 't2', addon_width_m: 1, addon_height_m: 0.4, addon_position: 'bottom', addon_offset_m: 0 }
    const f = formFromOpening(row)
    expect(f).toMatchObject({ series_id: '', thickness_mm: '1.5', no_infill: true, has_addon: true, addon_position: 'bottom', addon_offset_m: '0', panel_count: '2' })
    const p = buildOpeningPayload(f, { projectId: 'p1' })
    expect(p).toMatchObject({ thickness_mm: 1.5, addon_offset_m: 0, addon_template_id: 't2', series_id: null })
  })
})

describe('validateForm', () => {
  it('names the first missing thing in Thai, null when savable', () => {
    expect(validateForm(emptyForm())).toBe('กรอกเลขช่อง')
    expect(validateForm({ ...emptyForm(), opening_no: 'D1' })).toBe('เลือก template')
    expect(validateForm({ ...emptyForm(), opening_no: 'D1', template_id: 't' })).toMatch(/ขนาด/)
    expect(validateForm(filled())).toBeNull()
  })
  it('a partly filled add-on blocks saving; negative labour and out-of-range profit are refused', () => {
    expect(validateForm(filled({ has_addon: true }))).toMatch(/ชุดต่อเติม/)
    expect(validateForm(filled({ has_addon: true, addon_template_id: 't2', addon_width_m: '1' }))).toMatch(/ขนาดชุดต่อเติม/)
    expect(validateForm(filled({ labour_per_sqm: '-1' }))).toMatch(/ค่าแรง/)
    expect(validateForm(filled({ profit_pct: '1001' }))).toMatch(/กำไร/)
    expect(validateForm(filled({ labour_per_sqm: '0', profit_pct: '0' }))).toBeNull()
  })
})

describe('validateForm hardening', () => {
  it('rejects a zero or negative thickness and a negative add-on offset; blank stays allowed', () => {
    expect(validateForm(filled({ thickness_mm: '0' }))).toBe('ความหนาต้องมากกว่า 0')
    expect(validateForm(filled({ sash_thickness_mm: '-1' }))).toBe('ความหนาต้องมากกว่า 0')
    expect(validateForm(filled({ thickness_mm: '1.5', sash_thickness_mm: '' }))).toBeNull()
    const ao = { has_addon: true, addon_template_id: 't2', addon_width_m: '1', addon_height_m: '1' }
    expect(validateForm(filled({ ...ao, addon_offset_m: '-0.1' }))).toBe('ระยะขอบของชุดต่อเติมต้องไม่ติดลบ')
    expect(validateForm(filled({ ...ao, addon_offset_m: '' }))).toBeNull()
    expect(validateForm(filled({ ...ao, addon_offset_m: '0' }))).toBeNull()
    expect(validateForm(filled({ has_addon: false, addon_offset_m: '-5' }))).toBeNull()
  })
})
```

- [ ] **Step 2: Write the failing test** — create `src/lib/templateSave.test.js` with exactly:

```js
import { describe, it, expect } from 'vitest'
import { jointRowsForInsert, validateJoints, componentRowsForInsert, jointIndexForLoad } from './templateSave.js'

describe('jointRowsForInsert', () => {
  it('numbers the order, names a nameless joint, and nulls the fields the mode / style does not use', () => {
    const rows = jointRowsForInsert([
      { name: '', main_family: ' box ', secondary_family: 'bar', deduction_mode: 'auto', deduction_mm: '9', cut_style: 'square', notch_width_mm: '5' },
      { name: 'ตัวแบ่ง', main_family: 'box', secondary_family: 'mid', deduction_mode: 'manual', deduction_mm: '3', cut_style: 'notch', notch_width_mm: '40', notch_depth_mm: '20' },
    ], 't1')
    expect(rows[0]).toMatchObject({ template_id: 't1', name: 'จุดชน 1', main_family: 'box', deduction_mm: null, notch_width_mm: null, sort_order: 0 })
    expect(rows[1]).toMatchObject({ deduction_mode: 'manual', deduction_mm: 3, cut_style: 'notch', notch_width_mm: 40, notch_depth_mm: 20, sort_order: 1 })
  })
  it('manual 0 is kept as 0; an unknown cut style becomes square', () => {
    const r = jointRowsForInsert([{ main_family: 'a', secondary_family: 'b', deduction_mode: 'manual', deduction_mm: '0', cut_style: 'bevel' }], 't')[0]
    expect(r.deduction_mm).toBe(0)
    expect(r.cut_style).toBe('square')
  })
})

describe('validateJoints', () => {
  it('names the first problem; null for none', () => {
    expect(validateJoints([])).toBeNull()
    expect(validateJoints([{ main_family: '', secondary_family: 'b' }])).toMatch(/จุดชนที่ 1/)
    expect(validateJoints([{ main_family: 'a', secondary_family: 'b', deduction_mode: 'manual', deduction_mm: '' }])).toMatch(/ค่าหัก/)
    expect(validateJoints([{ main_family: 'a', secondary_family: 'b', cut_style: 'notch', notch_width_mm: '40' }])).toMatch(/ขนาดบาก/)
    expect(validateJoints([{ main_family: 'a', secondary_family: 'b', deduction_mode: 'manual', deduction_mm: '0', cut_style: 'notch', notch_width_mm: '40', notch_depth_mm: '20' }])).toBeNull()
  })
})

describe('componentRowsForInsert', () => {
  it('maps joint_index to the newly inserted joint id and drops editor-only / old ids', () => {
    const out = componentRowsForInsert([
      { id: 'old', tenant_id: 'x', created_at: 'y', role_name: 'bar', profile_family: 'bar', length_rule_type: 'width', length_deduction_mm: '0', quantity_basis: 'fixed', quantity_value: '2', joint_index: '1', joint_ends: '1', thickness_mm: '' },
      { role_name: 'top', profile_family: 'box', length_rule_type: 'width', length_deduction_mm: 0, quantity_basis: 'fixed', quantity_value: 1, joint_index: '' },
    ], 't1', [{ id: 'jA' }, { id: 'jB' }])
    expect(out[0]).toMatchObject({ template_id: 't1', joint_id: 'jB', joint_ends: 1, thickness_role: null, quantity_value: 2, sort_order: 0 })
    expect(out[0]).not.toHaveProperty('thickness_mm')
    expect(out[0]).not.toHaveProperty('id')
    expect(out[0]).not.toHaveProperty('joint_index')
    expect(out[1]).toMatchObject({ joint_id: null, joint_ends: 2, sort_order: 1 })
  })
  it('a joint index that no longer exists gives no link instead of throwing', () => {
    expect(componentRowsForInsert([{ role_name: 'a', profile_family: 'a', length_rule_type: 'width', quantity_basis: 'fixed', joint_index: '5' }], 't', [{ id: 'j' }])[0].joint_id).toBeNull()
  })
})

describe('jointIndexForLoad', () => {
  it('turns joint_id back into a position in the sort_order sorted joint list', () => {
    const joints = [{ id: 'b', sort_order: 1 }, { id: 'a', sort_order: 0 }]
    const out = jointIndexForLoad([{ joint_id: 'b' }, { joint_id: 'a' }, { joint_id: null }, { joint_id: 'gone' }], joints)
    expect(out.map(c => c.joint_index)).toEqual(['1', '0', '', ''])
  })
})

describe('componentRowsForInsert whitelist', () => {
  it('only the real bom_template_components columns reach the insert, whatever the editor row carries', () => {
    const [row] = componentRowsForInsert([{ foo: 1, bar: 'x', thickness_mm: 2, joint_index: '0', id: 'old', role_name: 'a', profile_family: 'f', length_rule_type: 'width', quantity_basis: 'fixed', thickness_role: 'sash' }], 't', [{ id: 'j' }])
    expect(Object.keys(row).sort()).toEqual(['template_id', 'role_name', 'profile_family', 'length_rule_type', 'length_deduction_mm', 'quantity_basis', 'quantity_value', 'joint_id', 'joint_ends', 'thickness_role', 'sort_order'].sort())
    expect(row).toMatchObject({ thickness_role: 'sash', length_deduction_mm: 0, quantity_value: 0, joint_id: 'j', joint_ends: 2 })
    expect(componentRowsForInsert([{ thickness_role: 'frame' }], 't', [])[0].thickness_role).toBeNull()
  })
})
```

- [ ] **Step 3: Write the failing test** — create `src/lib/profileSketch.test.js` with exactly:

```js
import { describe, it, expect } from 'vitest'
import { profileSketchSvg } from './profileSketch.js'

describe('profileSketchSvg', () => {
  it('draws a closed box (two rects) or an open channel (a polyline + two hooks) with the size as text', () => {
    const box = profileSketchSvg({ width_mm: 101.6, depth_mm: 44.45, wall_mm: 1.5, shape: 'box' })
    expect(box).toContain('101.6 x 44.45 mm')
    expect((box.match(/<rect /g) || []).length).toBe(2)
    const u = profileSketchSvg({ width_mm: 101.6, depth_mm: 44.45, wall_mm: 1.5, shape: 'u' })
    expect(u).toContain('<polyline')
    expect((u.match(/<rect /g) || []).length).toBe(2)
  })
  it('missing or non-positive dimensions give an empty string; a missing wall still draws', () => {
    expect(profileSketchSvg({ width_mm: 0, depth_mm: 10 })).toBe('')
    expect(profileSketchSvg({ width_mm: 10 })).toBe('')
    expect(profileSketchSvg({ width_mm: 40, depth_mm: 40 })).toContain('<svg')
  })
  it('never produces NaN, even with a wall thicker than the section', () => {
    expect(profileSketchSvg({ width_mm: 10, depth_mm: 10, wall_mm: 50, shape: 'box' })).not.toContain('NaN')
  })
})
```

- [ ] **Step 4: Run it to confirm it fails**

Run: `npx vitest run src/lib/openingPayload.test.js src/lib/templateSave.test.js src/lib/profileSketch.test.js`
Expected: FAIL (module / export not found).

- [ ] **Step 5: Write the implementation** — create `src/lib/openingPayload.js` with exactly:

```js
// src/lib/openingPayload.js
// The item form's state <-> the estimation_openings row. Pure. "Inherit" is NULL (spec Decision 1); infill and
// hardware set also carry an explicit "none" flag because NULL already means inherit. Quantity is NOT here:
// it is set on the project page (owner), so an edit never resets it.

const numOrNull = v => {
  if (v === null || v === undefined || String(v).trim() === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const intOr = (v, d) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n >= 1 ? n : d }
const str = v => (v === null || v === undefined ? '' : String(v))

export function emptyForm() {
  return {
    opening_no: '', item_name: '', item_description: '', template_id: '',
    series_id: '', alu_finish_id: '', thickness_mm: '', sash_thickness_mm: '',
    infill_type_id: '', no_infill: false, hardware_set_id: '', no_hardware_set: false,
    width_m: '', height_m: '', panel_count: '1',
    has_addon: false, addon_template_id: '', addon_width_m: '', addon_height_m: '', addon_panel_count: '1', addon_position: 'top', addon_offset_m: '',
    labour_per_sqm: '', profit_pct: '', extra_lines: [],
  }
}

export function formFromOpening(o) {
  return {
    opening_no: str(o.opening_no), item_name: str(o.item_name), item_description: str(o.item_description), template_id: str(o.template_id),
    series_id: str(o.series_id), alu_finish_id: str(o.alu_finish_id), thickness_mm: str(o.thickness_mm), sash_thickness_mm: str(o.sash_thickness_mm),
    infill_type_id: str(o.infill_type_id), no_infill: !!o.no_infill, hardware_set_id: str(o.hardware_set_id), no_hardware_set: !!o.no_hardware_set,
    width_m: str(o.width_m), height_m: str(o.height_m), panel_count: str(o.panel_count || 1),
    has_addon: !!o.addon_template_id, addon_template_id: str(o.addon_template_id), addon_width_m: str(o.addon_width_m), addon_height_m: str(o.addon_height_m),
    addon_panel_count: str(o.addon_panel_count || 1), addon_position: o.addon_position || 'top', addon_offset_m: str(o.addon_offset_m),
    labour_per_sqm: str(o.labour_per_sqm), profit_pct: str(o.profit_pct), extra_lines: Array.isArray(o.extra_lines) ? o.extra_lines : [],
  }
}

// previews: { out, in, sig } | null  (null leaves the saved snapshot columns out of the payload entirely)
export function buildOpeningPayload(form, { projectId, previews = null, savedAt = null } = {}) {
  const addon = form.has_addon && form.addon_template_id
  const payload = {
    project_id: projectId,
    opening_no: String(form.opening_no).trim(),
    item_name: String(form.item_name).trim() || null,
    item_description: String(form.item_description).trim() || null,
    template_id: form.template_id,
    series_id: form.series_id || null,
    alu_finish_id: form.alu_finish_id || null,
    thickness_mm: numOrNull(form.thickness_mm),
    sash_thickness_mm: numOrNull(form.sash_thickness_mm),
    no_infill: !!form.no_infill,
    infill_type_id: form.no_infill ? null : (form.infill_type_id || null),
    no_hardware_set: !!form.no_hardware_set,
    hardware_set_id: form.no_hardware_set ? null : (form.hardware_set_id || null),
    width_m: numOrNull(form.width_m),
    height_m: numOrNull(form.height_m),
    panel_count: intOr(form.panel_count, 1),
    addon_template_id: addon ? form.addon_template_id : null,
    addon_width_m: addon ? numOrNull(form.addon_width_m) : null,
    addon_height_m: addon ? numOrNull(form.addon_height_m) : null,
    addon_panel_count: addon ? intOr(form.addon_panel_count, 1) : 1,
    addon_position: addon ? form.addon_position || 'top' : null,
    addon_offset_m: addon ? numOrNull(form.addon_offset_m) : null,
    labour_per_sqm: numOrNull(form.labour_per_sqm),
    profit_pct: numOrNull(form.profit_pct),
    extra_lines: (form.extra_lines || []).map(l => ({ description: String(l.description || ''), amount: Number(l.amount) || 0 })),
  }
  if (previews) {
    payload.preview_svg_out = previews.out || null
    payload.preview_svg_in = previews.in || null
    payload.preview_sig = previews.sig || null
    payload.preview_saved_at = savedAt
  }
  return payload
}

// Why the form cannot be saved yet (the first problem, as Thai text), or null when it can.
export function validateForm(form) {
  if (!String(form.opening_no).trim()) return 'กรอกเลขช่อง'
  if (!form.template_id) return 'เลือก template'
  if (!(numOrNull(form.width_m) > 0) || !(numOrNull(form.height_m) > 0)) return 'กรอกขนาดกว้างและสูงให้มากกว่า 0'
  for (const k of ['thickness_mm', 'sash_thickness_mm']) {
    const n = numOrNull(form[k])
    if (n !== null && n <= 0) return 'ความหนาต้องมากกว่า 0'
  }
  if (form.has_addon) {
    if (!form.addon_template_id) return 'เลือก template ของชุดต่อเติม'
    if (!(numOrNull(form.addon_width_m) > 0) || !(numOrNull(form.addon_height_m) > 0)) return 'กรอกขนาดชุดต่อเติมให้มากกว่า 0'
    const off = numOrNull(form.addon_offset_m)
    if (off !== null && off < 0) return 'ระยะขอบของชุดต่อเติมต้องไม่ติดลบ'
  }
  const labour = numOrNull(form.labour_per_sqm)
  if (labour !== null && labour < 0) return 'ค่าแรงต้องไม่ติดลบ'
  const profit = numOrNull(form.profit_pct)
  if (profit !== null && (profit < 0 || profit > 1000)) return 'กำไร (%) ต้องอยู่ระหว่าง 0 ถึง 1000'
  return null
}
```

- [ ] **Step 6: Write the implementation** — create `src/lib/templateSave.js` with exactly:

```js
// src/lib/templateSave.js
// Saving a template rewrites its joints and components (delete + reinsert), so a component cannot keep the old
// joint id. In the editor a component points at a joint by its POSITION in the joint list (joint_index, or null);
// after the joints are inserted (ids returned in the same order) this turns the rows into insertable ones.
const numOrNull = v => (v === null || v === undefined || String(v).trim() === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null))

export function jointRowsForInsert(jointRows, templateId) {
  return (jointRows || []).map((j, i) => ({
    template_id: templateId, name: String(j.name || '').trim() || `จุดชน ${i + 1}`,
    main_family: String(j.main_family || '').trim(), secondary_family: String(j.secondary_family || '').trim(),
    deduction_mode: j.deduction_mode === 'manual' ? 'manual' : 'auto',
    deduction_mm: j.deduction_mode === 'manual' ? numOrNull(j.deduction_mm) : null,
    cut_style: ['square', 'notch', 'miter45'].includes(j.cut_style) ? j.cut_style : 'square',
    notch_width_mm: j.cut_style === 'notch' ? numOrNull(j.notch_width_mm) : null,
    notch_depth_mm: j.cut_style === 'notch' ? numOrNull(j.notch_depth_mm) : null,
    sort_order: i,
  }))
}

// Why the joints cannot be saved (first problem, Thai), or null.
export function validateJoints(jointRows) {
  for (const [i, j] of (jointRows || []).entries()) {
    if (!String(j.main_family || '').trim() || !String(j.secondary_family || '').trim()) return `จุดชนที่ ${i + 1}: เลือกเส้นหลักและเส้นรอง`
    // null >= 0 is true in JS, so a blank must be rejected explicitly
    if (j.deduction_mode === 'manual' && (numOrNull(j.deduction_mm) === null || numOrNull(j.deduction_mm) < 0)) return `จุดชนที่ ${i + 1}: กรอกค่าหัก (มม.)`
    if (j.cut_style === 'notch' && !(numOrNull(j.notch_width_mm) > 0 && numOrNull(j.notch_depth_mm) > 0)) return `จุดชนที่ ${i + 1}: กรอกขนาดบาก กว้างและลึก`
  }
  return null
}

export function componentRowsForInsert(rows, templateId, insertedJoints) {
  return (rows || []).map((r, i) => {
    const idx = r.joint_index === '' || r.joint_index === null || r.joint_index === undefined ? null : Number(r.joint_index)
    const joint = idx !== null && Number.isInteger(idx) ? (insertedJoints || [])[idx] : null
    // an explicit whitelist: editor-only fields (joint_index, thickness_mm, ...) must never reach PostgREST
    return {
      template_id: templateId, role_name: r.role_name, profile_family: r.profile_family, length_rule_type: r.length_rule_type,
      length_deduction_mm: parseFloat(r.length_deduction_mm) || 0,
      quantity_basis: r.quantity_basis,
      quantity_value: parseFloat(r.quantity_value) || 0,
      joint_id: joint ? joint.id : null,
      joint_ends: Number(r.joint_ends) === 1 ? 1 : 2,
      thickness_role: r.thickness_role === 'sash' ? 'sash' : null,
      sort_order: i,
    }
  })
}

// When an existing template is opened: each component's joint_id becomes a position in the (sorted) joint list.
export function jointIndexForLoad(components, joints) {
  const order = [...(joints || [])].sort((a, b) => a.sort_order - b.sort_order)
  return (components || []).map(c => ({ ...c, joint_index: c.joint_id ? String(order.findIndex(j => j.id === c.joint_id)).replace('-1', '') : '' }))
}
```

- [ ] **Step 7: Write the implementation** — create `src/lib/profileSketch.js` with exactly:

```js
// src/lib/profileSketch.js
// A rough cross-section sketch from the catalog dimensions, for the profile form (proportions only; the real
// detail is in the attached drawing). shape: 'box' (closed hollow) | 'u' (open channel with lips, e.g. กล่องเรียบ).
// Returns an SVG string with literal colours.
const INK = '#1f2328'
const FILL = '#d6dbe0'
const n2 = n => Math.round(n * 100) / 100

export function profileSketchSvg({ width_mm, depth_mm, wall_mm, shape }) {
  const w = Number(width_mm)
  const d = Number(depth_mm)
  if (!(w > 0) || !(d > 0)) return ''
  const t0 = Number(wall_mm) > 0 ? Number(wall_mm) : Math.min(w, d) * 0.04
  const k = Math.min(140 / w, 80 / d)
  const W = w * k
  const D = d * k
  const T = Math.max(1.6, Math.min(t0 * k, Math.min(W, D) / 3))
  const x = (160 - W) / 2
  const y = (100 - D) / 2
  let body
  if (shape === 'u') {
    const yb = y + D - T / 2
    const lip = Math.min(W * 0.12, 14)
    const hk = Math.max(2.5, D * 0.12)
    body = `<polyline points="${n2(x + lip)},${n2(yb)} ${n2(x + T / 2)},${n2(yb)} ${n2(x + T / 2)},${n2(y + T / 2)} ${n2(x + W - T / 2)},${n2(y + T / 2)} ${n2(x + W - T / 2)},${n2(yb)} ${n2(x + W - lip)},${n2(yb)}" fill="none" stroke="${INK}" stroke-width="${n2(T)}"/>`
      + `<rect x="${n2(x + lip - hk * 0.2)}" y="${n2(yb - T / 2 - hk)}" width="${n2(T * 1.6)}" height="${n2(hk)}" fill="${INK}"/>`
      + `<rect x="${n2(x + W - lip - T * 1.4)}" y="${n2(yb - T / 2 - hk)}" width="${n2(T * 1.6)}" height="${n2(hk)}" fill="${INK}"/>`
  } else {
    body = `<rect x="${n2(x)}" y="${n2(y)}" width="${n2(W)}" height="${n2(D)}" fill="${FILL}" stroke="${INK}"/>`
      + `<rect x="${n2(x + T)}" y="${n2(y + T)}" width="${n2(Math.max(0, W - 2 * T))}" height="${n2(Math.max(0, D - 2 * T))}" fill="#ffffff" stroke="${INK}"/>`
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 116" width="160" height="116">${body}<text x="80" y="112" font-size="9" fill="#6b7280" text-anchor="middle">${n2(w)} x ${n2(d)} mm</text></svg>`
}
```

- [ ] **Step 8: Write the implementation** — create `src/hooks/useEstimation2b.js` with exactly:

```js
// src/hooks/useEstimation2b.js
// Data loading for the Phase 2b screens. Every table is loaded whole (the screens compute on every keystroke).
import { useMemo } from 'react'
import { supabase } from '../lib/supabase.js'
import { fetchCatalogRows } from '../lib/catalogData.js'
import { useQuery } from './useSupabase.js'
import { useCatalogTable } from './useAluCatalog.js'
import { mergeSettings } from '../lib/estimationSettings.js'

// One row per tenant; `settings` is always complete (defaults fill any gap), `row` is the stored row or null.
export function useEstimationSettings() {
  const q = useQuery(() => fetchCatalogRows(supabase, 'estimation_settings', 'id'), [])
  const row = q.data && q.data[0] ? q.data[0] : null
  const settings = useMemo(() => mergeSettings(row), [row])
  return { ...q, row, settings }
}

// No upsert (house rule): look the row up, then insert or update.
export async function saveEstimationSettings(existingRow, values) {
  const { error } = existingRow
    ? await supabase.from('estimation_settings').update(values).eq('id', existingRow.id)
    : await supabase.from('estimation_settings').insert(values)
  if (error) throw error
}

export const useLayoutTemplates = () => useCatalogTable('estimation_layout_templates', 'name')
export const useTemplateJoints = () => useCatalogTable('bom_template_joints', 'sort_order')
export const useProjectStock = () => useCatalogTable('estimation_project_stock', 'id')

// Groups rows by template_id: { [templateId]: rows[] } (the shape costOpening expects).
export function groupByTemplate(rows) {
  const m = {}
  for (const r of rows || []) (m[r.template_id] = m[r.template_id] || []).push(r)
  return m
}

```

- [ ] **Step 9: Run the tests, then the whole suite and the build**

Run: `npx vitest run src/lib/openingPayload.test.js src/lib/templateSave.test.js src/lib/profileSketch.test.js` — Expected: all PASS.
Run: `npm test` and `npm run build` — Expected: all existing tests still pass, build OK.

- [ ] **Step 10: Commit**

```bash
git add src/lib/openingPayload.js src/lib/openingPayload.test.js src/lib/templateSave.js src/lib/templateSave.test.js src/lib/profileSketch.js src/lib/profileSketch.test.js src/hooks/useEstimation2b.js
git commit -m "feat(estimation): item payload, template save helpers, profile sketch and 2b data hooks

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```


---

# Screens (Tasks 12–17)

**How to build these.** The mockup (v20) is the visual spec: same fields, labels (Thai strings are in the mockup HTML), order and states. Follow the surrounding code's style (`className="card"`, `label`, `input`, `btn`, `Modal`, `SearchableSelect`, `useDraftForm`, `canEditPage(role, 'estimation')`); read the neighbouring component first and match it. All numbers come from the pure libs above; screens must not recompute prices, deductions, bars or fixing points themselves. Gate every new entry point with the `estimation` module exactly as `src/pages/AluCatalog.jsx` and its menu entry in `src/App.jsx` already do. After each screen task run `npm run build` and `npm test`; state in the report which behaviours were NOT exercised (no database is available to agents). Do not claim a screen "works".

### Task 11A: Parent / child door-window types, three levels (migration #3, `typeTree` lib, index expansion)

Owner request 2026-10-09: split types into levels, e.g. ประตู → ประตูบานเลื่อน → ประตูบานเลื่อนรางล่าง / รางบน. Owner ruled (Ruling 18): **three levels** (level 1 = กลุ่มหลัก ประตู / หน้าต่าง / ผนังกระจก, level 2 = แบบ เช่น บานเลื่อน, level 3 = แบบย่อย เช่น รางล่าง), and **only a type with no active children can be chosen** on templates, layout templates and items.

**Files:**
- Create: `supabase/migrations/2026-10-12-02-estimation-type-parent.sql`, `supabase/tests/estimation_type_parent_test.sql`, `src/lib/typeTree.js`, `src/lib/typeTree.test.js`
- Modify: `src/lib/aluCatalogPricing.js` (`buildCatalogIndex`: expanded series-type links), `src/lib/estimationCatalogViews.js` (`partsForSeries` also matches ancestors' links), `src/lib/estimationInherit.js` (labour default through ancestors), `src/hooks/useEstimation2b.js` (`useEstimationCatalog` exposes `seriesTypes` already expanded; every caller of `typeAvailability` / `availableLayoutTemplates` / `addonTemplatesForSeries` MUST pass that list, never the raw table rows), `src/lib/estimationCatalogViews.test.js`, `src/lib/estimationInherit.test.js`
- Isolation: `door_window_types` is an estimation-only table (RLS `has_module_access('estimation')`). The column is nullable and additive; the category CHECK is widened (adds `curtain_wall`), never narrowed. No standard-module table is touched.

**Interfaces:**
- Produces: `buildTypeTree`, `selectableTypes`, `isSelectableType`, `typeLabel`, `typeAndAncestorIds`, `typeLabourDefault`, `expandSeriesTypes` (all from `typeTree.js`); `door_window_types.parent_id`; category value `curtain_wall` (label ผนังกระจก).
- Consumes: the existing index shape (`index.types` by id).

Behaviour (pure, no I/O):
1. **Up to three levels.** Same tenant and same `category` all the way down; no self-parent or loop; moving a type under a parent must keep its whole subtree within three levels. Category of a type cannot change while its children have another category (the Types tab sets a child's category from its parent). Enforced by trigger; mirrored in the Types tab (parent select lists only types that are at level 1 or 2 and are not inside the type's own subtree).
2. **Series offers.** Linking a type to a series (`alu_series_types`) makes the series offer all its descendants; linking a deeper type offers it alone. Done by `expandSeriesTypes` when the index is built, so `seriesForType`, `typesForSeries`, `allowsMixedThickness` (a descendant inherits the flag of its NEAREST linked ancestor unless it has its own link row), `typeAvailability` and layout-template availability work unchanged.
3. **Part links.** An `alu_series_parts` link on a type counts for all its descendants; a link on a descendant counts only for it; `type_id` NULL still means every type.
4. **Selectable = leaf.** `selectableTypes` returns active types with no active child. A type with children is never offered in a template, layout template or item type select; a type with no (active) children behaves exactly like a type today. A legacy template whose `type_id` has children still prices but the template editor shows a warning pill "ประเภทนี้มีประเภทย่อย เลือกประเภทย่อย".
5. **Labour default.** A type with no `default_labour_per_sqm` uses the nearest ancestor's (`typeLabourDefault`; 0 is a real value), used by `estimationInherit`.
6. **Delete.** `parent_id` is `ON DELETE RESTRICT`: deleting a type that has children fails; the Types tab says "ลบประเภทย่อยก่อน".

- [ ] **Step 1: Write the migration** `supabase/migrations/2026-10-12-02-estimation-type-parent.sql`

```sql
-- Parent/child door-window types (three levels). Additive; estimation-only table (RLS already module-gated).
ALTER TABLE door_window_types DROP CONSTRAINT IF EXISTS door_window_types_category_check;
ALTER TABLE door_window_types
  ADD CONSTRAINT door_window_types_category_check CHECK (category IN ('door','window','curtain_wall'));

ALTER TABLE door_window_types
  ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES door_window_types(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_door_window_types_parent_id ON door_window_types(parent_id);

CREATE OR REPLACE FUNCTION door_window_types_check_parent() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE p1 RECORD; p2 RECORD; depth_above INT := 0; height INT := 1;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF EXISTS (SELECT 1 FROM door_window_types WHERE parent_id = NEW.id AND category <> NEW.category) THEN
      RAISE EXCEPTION 'cannot change the category: child types have another category';
    END IF;
    IF EXISTS (SELECT 1 FROM door_window_types WHERE parent_id = NEW.id) THEN height := 2; END IF;
    IF EXISTS (SELECT 1 FROM door_window_types c JOIN door_window_types g ON g.parent_id = c.id WHERE c.parent_id = NEW.id) THEN
      height := 3;
    END IF;
  END IF;
  IF NEW.parent_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.parent_id = NEW.id THEN RAISE EXCEPTION 'a type cannot be its own parent'; END IF;
  SELECT id, tenant_id, category, parent_id INTO p1 FROM door_window_types WHERE id = NEW.parent_id;
  IF NOT FOUND OR p1.tenant_id <> NEW.tenant_id THEN RAISE EXCEPTION 'parent type not found in this tenant'; END IF;
  IF p1.category <> NEW.category THEN RAISE EXCEPTION 'a child type must have the same category as its parent'; END IF;
  depth_above := 1;
  IF p1.parent_id IS NOT NULL THEN
    IF p1.parent_id = NEW.id THEN RAISE EXCEPTION 'a type cannot be moved under its own child'; END IF;
    SELECT id, parent_id INTO p2 FROM door_window_types WHERE id = p1.parent_id;
    depth_above := 2;
    IF p2.parent_id IS NOT NULL THEN
      IF p2.parent_id = NEW.id THEN RAISE EXCEPTION 'a type cannot be moved under its own child'; END IF;
      depth_above := 3;
    END IF;
  END IF;
  IF depth_above + height > 3 THEN RAISE EXCEPTION 'types have at most three levels'; END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_door_window_types_check_parent ON door_window_types;
CREATE TRIGGER trg_door_window_types_check_parent
  BEFORE INSERT OR UPDATE OF parent_id, category, tenant_id ON door_window_types
  FOR EACH ROW EXECUTE FUNCTION door_window_types_check_parent();
```

- [ ] **Step 2: Write the SQL test** `supabase/tests/estimation_type_parent_test.sql`. Same fixture header as `estimation_2b_expand_test.sql` (copy its tenant block with the names `__TPAR TEST A/B/C__`, emails `__tpar_a__/_b__/_c__@example.com`, temp table `_tpar_fx`). Header comment: `BEGIN; <catalog migrations if not applied>; 2026-10-12-02; <this file>; ROLLBACK;`. Three DO blocks:
  - **Test 1 (rules, as tenant A):** category `curtain_wall` is accepted and `'roof'` raises `check_violation`. Insert L1 `T-L1` (door), L2 `T-L2` (parent L1), L3 `T-L3` (parent L2): all succeed. A fourth level (parent = L3) raises; an L3 under a window-category parent raises (category mismatch); `parent_id = id` raises; moving L1 under L3 raises (loop); moving a second L1 `T-X` that has one child under L2 (depth 3 + height 2) raises, but moving a childless `T-Y` under L2 succeeds; changing `T-L1` category while its children are doors raises; deleting L1 while a child exists raises `foreign_key_violation`; deleting leaves upward then L1 succeeds.
  - **Test 2 (isolation, as tenant A, runs BEFORE any delete block):** a child whose `parent_id` is a type owned by tenant B (insert B's type as B first) raises ("parent type not found"). As tenant C (no `estimation` module) `SELECT count(*) FROM door_window_types` is 0 and an `INSERT` raises (RLS).
  - **Test 3 (existing rows unchanged):** a type inserted without `parent_id` has `parent_id IS NULL`; categories `door` and `window` still work.
  Each block ends with `RAISE NOTICE 'Test N (...): TEST PASSED'`. Add `.superpowers/sdd/2026-10-09-aluminium-cost-catalog-phase-2b-screens/run-type-parent-tests.sh` by copying `run-estimation-2b-tests.sh`, replacing the migration/test file names and the persistence check with `select count(*) from information_schema.columns where table_name='door_window_types' and column_name='parent_id'` (applied) and `tenants like '__TPAR TEST%'` (leftover). **Agents never run it against Supabase; the owner runs it with `!`.**

- [ ] **Step 3: Write the failing lib tests** `src/lib/typeTree.test.js`

```js
import { describe, it, expect } from 'vitest'
import { buildTypeTree, selectableTypes, isSelectableType, typeLabel, typeAndAncestorIds, typeLabourDefault, expandSeriesTypes } from './typeTree.js'

const T = [
  { id: 'door', name: 'ประตู', category: 'door', parent_id: null, active: true, default_labour_per_sqm: 300 },
  { id: 'slide', name: 'บานเลื่อน', category: 'door', parent_id: 'door', active: true, default_labour_per_sqm: null },
  { id: 'low', name: 'รางล่าง', category: 'door', parent_id: 'slide', active: true, default_labour_per_sqm: null },
  { id: 'top', name: 'รางบน', category: 'door', parent_id: 'slide', active: true, default_labour_per_sqm: 350 },
  { id: 'swing', name: 'บานเปิด', category: 'door', parent_id: 'door', active: true },
  { id: 'win', name: 'หน้าต่าง', category: 'window', parent_id: null, active: true },
  { id: 'off', name: 'ปิดใช้งาน', category: 'window', parent_id: 'win', active: false },
]
const byId = Object.fromEntries(T.map(t => [t.id, t]))

describe('buildTypeTree', () => {
  it('nests up to three levels, sorted by name; an orphan becomes a root', () => {
    const tree = buildTypeTree(T)
    expect(tree.map(n => n.type.id).sort()).toEqual(['door', 'win'])
    const door = tree.find(n => n.type.id === 'door')
    expect(door.children.map(c => c.type.id).sort()).toEqual(['slide', 'swing'])
    expect(door.children.find(c => c.type.id === 'slide').children.map(c => c.type.id).sort()).toEqual(['low', 'top'])
    expect(buildTypeTree([{ id: 'k', name: 'k', parent_id: 'gone' }]).map(n => n.type.id)).toEqual(['k'])
  })
  it('never throws or loops on null, empty or cyclic input', () => {
    expect(buildTypeTree(null)).toEqual([])
    expect(buildTypeTree([])).toEqual([])
    expect(() => buildTypeTree([{ id: 'a', name: 'a', parent_id: 'b' }, { id: 'b', name: 'b', parent_id: 'a' }])).not.toThrow()
  })
})

describe('selectableTypes / isSelectableType (Ruling 18: leaves only)', () => {
  it('a type with active children is not selectable at any level', () => {
    expect(selectableTypes(T).map(t => t.id).sort()).toEqual(['low', 'swing', 'top', 'win'])   // win: its only child is inactive
    expect(isSelectableType(T, 'door')).toBe(false)
    expect(isSelectableType(T, 'slide')).toBe(false)
    expect(isSelectableType(T, 'low')).toBe(true)
  })
  it('inactive types are not selectable; a parent whose children are all inactive becomes selectable again', () => {
    expect(isSelectableType(T, 'off')).toBe(false)
    expect(isSelectableType(T, 'win')).toBe(true)
  })
  it('unknown or empty ids are not selectable', () => {
    expect(isSelectableType(T, 'nope')).toBe(false)
    expect(isSelectableType(T, null)).toBe(false)
  })
})

describe('typeLabel / typeAndAncestorIds / typeLabourDefault', () => {
  it('labels from the top down, joined with " › "', () => {
    expect(typeLabel(byId, 'low')).toBe('ประตู › บานเลื่อน › รางล่าง')
    expect(typeLabel(byId, 'slide')).toBe('ประตู › บานเลื่อน')
    expect(typeLabel(byId, 'door')).toBe('ประตู')
    expect(typeLabel(byId, 'nope')).toBe('')
  })
  it('lists the type then its ancestors, nearest first', () => {
    expect(typeAndAncestorIds(byId, 'low')).toEqual(['low', 'slide', 'door'])
    expect(typeAndAncestorIds(byId, 'door')).toEqual(['door'])
    expect(typeAndAncestorIds(byId, null)).toEqual([])
    expect(typeAndAncestorIds({}, 'q')).toEqual(['q'])
    expect(typeAndAncestorIds({ a: { id: 'a', parent_id: 'b' }, b: { id: 'b', parent_id: 'a' } }, 'a')).toEqual(['a', 'b'])
  })
  it('the labour rate comes from the nearest type that has one; 0 is a real value', () => {
    expect(typeLabourDefault(byId, 'low')).toBe(300)
    expect(typeLabourDefault(byId, 'top')).toBe(350)
    expect(typeLabourDefault({ ...byId, slide: { ...byId.slide, default_labour_per_sqm: 0 } }, 'low')).toBe(0)
    expect(typeLabourDefault(byId, 'win')).toBeNull()
    expect(typeLabourDefault(byId, 'nope')).toBeNull()
  })
})

describe('expandSeriesTypes', () => {
  it('a link on a type also offers every descendant, inheriting the mixed-thickness flag', () => {
    const out = expandSeriesTypes([{ id: 'l1', series_id: 's1', type_id: 'slide', allow_mixed_thickness: true }], T)
    expect(out.filter(l => l.series_id === 's1').map(l => l.type_id).sort()).toEqual(['low', 'slide', 'top'])
    expect(out.find(l => l.type_id === 'top')).toMatchObject({ allow_mixed_thickness: true, inherited_from: 'slide' })
  })
  it('a link on the top level reaches the third level', () => {
    const out = expandSeriesTypes([{ id: 'l1', series_id: 's1', type_id: 'door', allow_mixed_thickness: false }], T)
    expect(out.map(l => l.type_id).sort()).toEqual(['door', 'low', 'slide', 'swing', 'top'])
  })
  it('a deeper type linked alone offers only itself', () => {
    expect(expandSeriesTypes([{ id: 'l2', series_id: 's2', type_id: 'low', allow_mixed_thickness: false }], T).map(l => l.type_id)).toEqual(['low'])
  })
  it('an explicit link wins, and the NEAREST linked ancestor wins over a farther one, without duplicates', () => {
    const links = [
      { id: 'a', series_id: 's1', type_id: 'door', allow_mixed_thickness: false },
      { id: 'b', series_id: 's1', type_id: 'slide', allow_mixed_thickness: true },
      { id: 'c', series_id: 's1', type_id: 'top', allow_mixed_thickness: false },
    ]
    const out = expandSeriesTypes(links, T)
    expect(out.filter(l => l.type_id === 'low')).toHaveLength(1)
    expect(out.find(l => l.type_id === 'low').allow_mixed_thickness).toBe(true)
    expect(out.filter(l => l.type_id === 'top')).toHaveLength(1)
    expect(out.find(l => l.type_id === 'top').allow_mixed_thickness).toBe(false)
    expect(out.find(l => l.type_id === 'swing').allow_mixed_thickness).toBe(false)
  })
  it('does not mutate its inputs and tolerates null', () => {
    const links = [{ id: 'l1', series_id: 's1', type_id: 'door', allow_mixed_thickness: true }]
    const copy = JSON.stringify(links)
    expandSeriesTypes(links, T)
    expect(JSON.stringify(links)).toBe(copy)
    expect(expandSeriesTypes(null, null)).toEqual([])
  })
})
```

- [ ] **Step 4: Run it, see it fail** (`npx vitest run src/lib/typeTree.test.js` → module not found).

- [ ] **Step 5: Write `src/lib/typeTree.js`**

```js
// src/lib/typeTree.js
// Parent / child door-window types, up to three levels (กลุ่มหลัก → แบบ → แบบย่อย). Pure.
// A type that has active children is a grouping only: templates, layout templates and items choose a leaf (Ruling 18).

const MAX_LEVELS = 3
const byName = (a, b) => String(a.name ?? '').localeCompare(String(b.name ?? ''), 'th')
const asRows = types => (Array.isArray(types) ? types : Object.values(types || {})).filter(Boolean)

// { [parentId]: [child rows, sorted by name] }
function childrenByParent(types) {
  const out = {}
  for (const t of asRows(types)) if (t.parent_id) (out[t.parent_id] ||= []).push(t)
  for (const k of Object.keys(out)) out[k].sort(byName)
  return out
}

// [typeId, parentId?, grandparentId?] nearest first; stops at an unknown id or a loop. `typesById` is index.types.
export function typeAndAncestorIds(typesById, typeId) {
  const ids = []
  let cur = typeId
  while (cur && !ids.includes(cur) && ids.length < MAX_LEVELS) {
    ids.push(cur)
    const t = (typesById || {})[cur]
    cur = t ? t.parent_id : null
  }
  return ids
}

// [{ type, children: [...] }] sorted by name, at most three levels; a type whose parent is missing is shown as a root.
export function buildTypeTree(types) {
  const rows = asRows(types)
  const ids = new Set(rows.map(t => t.id))
  const kids = childrenByParent(rows)
  const node = (t, seen, level) => ({
    type: t,
    children: level >= MAX_LEVELS ? [] : (kids[t.id] || []).filter(c => !seen.has(c.id)).map(c => node(c, new Set([...seen, c.id]), level + 1)),
  })
  return rows.filter(t => !t.parent_id || !ids.has(t.parent_id)).sort(byName).map(t => node(t, new Set([t.id]), 1))
}

// Active types with no active child.
export function selectableTypes(types) {
  const rows = asRows(types)
  const parents = new Set(rows.filter(t => t.parent_id && t.active !== false).map(t => t.parent_id))
  return rows.filter(t => t.active !== false && !parents.has(t.id)).sort(byName)
}

export const isSelectableType = (types, typeId) => !!typeId && selectableTypes(types).some(t => t.id === typeId)

// "ประตู › บานเลื่อน › รางล่าง"; '' for an unknown id.
export function typeLabel(typesById, typeId) {
  const chain = typeAndAncestorIds(typesById, typeId).map(id => (typesById || {})[id]).filter(Boolean)
  return chain.reverse().map(t => t.name).join(' › ')
}

// Own rate if set (0 counts), else the nearest ancestor's, else null.
export function typeLabourDefault(typesById, typeId) {
  for (const id of typeAndAncestorIds(typesById, typeId)) {
    const t = (typesById || {})[id]
    const v = t ? t.default_labour_per_sqm : null
    if (v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v))) return Number(v)
  }
  return null
}

// A series linked to a type also offers every descendant. An explicit link wins; otherwise the NEAREST linked
// ancestor's flag is inherited. New array, inputs untouched.
export function expandSeriesTypes(seriesTypes, types) {
  const rows = asRows(types)
  const kids = childrenByParent(rows)
  const level = Object.fromEntries(rows.map(t => [t.id, typeAndAncestorIds(Object.fromEntries(rows.map(r => [r.id, r])), t.id).length]))
  const out = [...(seriesTypes || [])]
  const have = new Set(out.map(l => `${l.series_id}|${l.type_id}`))
  // deepest links first so a nearer ancestor claims its descendants before a farther one
  const ordered = [...(seriesTypes || [])].sort((a, b) => (level[b.type_id] || 0) - (level[a.type_id] || 0))
  for (const l of ordered) {
    const stack = [...(kids[l.type_id] || [])]
    const seen = new Set([l.type_id])
    while (stack.length) {
      const c = stack.pop()
      if (seen.has(c.id)) continue
      seen.add(c.id)
      stack.push(...(kids[c.id] || []))
      const key = `${l.series_id}|${c.id}`
      if (have.has(key)) continue
      have.add(key)
      out.push({ id: null, series_id: l.series_id, type_id: c.id, allow_mixed_thickness: l.allow_mixed_thickness === true, inherited_from: l.type_id })
    }
  }
  return out
}
```

- [ ] **Step 6: Index and views.** In `buildCatalogIndex` replace the `seriesTypesBySeries` line with `groupBy(expandSeriesTypes(rows.seriesTypes, rows.types), 'series_id')` (import from `./typeTree.js`). In `partsForSeries`, compute `const ids = typeId ? typeAndAncestorIds(index.types, typeId) : null` before the loop and use `if (ids && l.type_id && !ids.includes(l.type_id)) continue` inside it. Add tests to `estimationCatalogViews.test.js`: (a) a part linked to a parent type shows for its grandchild; (b) a part linked to one child does not show for its sibling; (c) `seriesForType(index, grandchild)` includes a series linked only to the top-level type; (d) `allowsMixedThickness` is true for a descendant of a type whose link allows it. Make `estimationInherit.resolveItemInputs` compute `typeLabour` from `typeLabourDefault(typesById, template.type_id)` but keep today's rule that only a rate `> 0` counts (`const r = typeLabourDefault(...); r > 0 ? r : null`), so the existing `t0` (rate 0 → null) test still passes; add one test: grandchild with NULL rate and parent NULL → top-level rate 300.

- [ ] **Step 7: Full run and commit**

```bash
npx vitest run && npm run build
git add supabase/migrations/2026-10-12-02-estimation-type-parent.sql supabase/tests/estimation_type_parent_test.sql src/lib src/hooks
git commit -m "feat(estimation): three-level parent/child door-window types (migration, typeTree lib, index expansion)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

(The owner-run script lives in the git-ignored `.superpowers` folder only.)

### Task 11B: Project hardware packages — hardware sets per type, chosen once per project, filled into items automatically (migration #4, `projectHardware` lib)

Owner request (mockup comments on screen 1, v22–v25): a **project hardware** = a named package that bundles the hardware set for each door/window type. It is created and edited in a subtab of the BOM template screen ("ชุดอุปกรณ์โครงการ", screen 5); the project page only has a select-only field "ชุดอุปกรณ์ของโปรเจกต์" that picks one package; each item then gets its hardware set automatically from its type.

**Files:**
- Create: `supabase/migrations/2026-10-12-03-estimation-hardware-packages.sql`, `supabase/tests/estimation_hardware_packages_test.sql`, `src/lib/projectHardware.js`, `src/lib/projectHardware.test.js`
- Modify: `src/lib/estimationInherit.js` (+ its test), `src/hooks/useEstimation2b.js` (load packages and their rows; add `useHardwarePackages()` returning `{ packages, items, savePackage, saveItems }`)
- Depends on Task 11A (`typeAndAncestorIds`). Isolation: two new estimation-only tables with the standard RLS loop; one nullable column on `estimation_projects` (an estimation-only table).

**Interfaces:**
- Produces: `hardwareSetStatus(packageItems, typesById, typeId, legacyDefaultId)` → `{ set_id, status }`, `status` ∈ `'set'` (a set is mapped), `'none'` (mapped to "no hardware set" on purpose), `'missing'` (the chosen package has nothing for this type or its ancestors), `'legacy'` (the project has no package: `packageItems` is null/undefined, so the old `default_hardware_set_id` applies); `missingHardwareTypeIds(packageItems, typesById, typeIds)`; `packagesForSeries(packages, seriesId)`.
- `resolveItemInputs(item, project, template, typesById, packageItems)` and `buildEngineOpening(raw, project, tpl, types, infills, packageItems)` gain ONE optional trailing argument. `packageItems` is the array of rows of the project's chosen package (`[]` = a chosen package that maps nothing), or null/omitted when the project has no package (today's behaviour exactly).

Rules (Ruling 20):
1. `alu_hardware_packages(name, series_id NULL = any series)` and `alu_hardware_package_items(package_id, type_id, hardware_set_id NULL = "no hardware set" on purpose)`, unique `(package_id, type_id)`. The nearest type in the chain type → parent → grandparent that has a row wins (a set on บานเลื่อน covers its 2-/3-panel children).
2. `estimation_projects.hardware_package_id` (nullable, `ON DELETE SET NULL`). The project page offers `packagesForSeries(packages, project series)` (series NULL or equal) plus "— ไม่ใช้ —" (NULL), select only.
3. Item resolution: `no_hardware_set` → none; else the item's own `hardware_set_id`; else the package's set for the template's type; else nothing. The old `default_hardware_set_id` is used ONLY while the project has no package, so existing projects price unchanged; the new UI no longer shows it.
4. A type with no row (`'missing'`) still prices, without a set; the project page and the item form warn "ประเภท … ยังไม่ได้กำหนดชุดอุปกรณ์". It is NOT an unresolved line (some types, e.g. fixed panes, need no set; the owner may overturn). A mapped set whose parts lack prices is unresolved as today.
5. The package editor's set picker lists only `kind = 'hardware_set'` parts linked to the package's series for that type (`hardwareSetsForSeries`); with series NULL it lists every active hardware set.
6. If the project's series changes to one a package does not belong to, the project keeps the package id but the page flags "ชุดนี้ไม่ใช่ของซีรีส์ที่เลือก" and every type counts as `'missing'` for the warning (screen computes it; the lib stays catalog-free).

- [ ] **Step 1: Migration** `supabase/migrations/2026-10-12-03-estimation-hardware-packages.sql`

```sql
-- Project hardware packages: a hardware set per door/window type, chosen once per estimation project. Additive; estimation-only.
CREATE TABLE alu_hardware_packages (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id  UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  name       TEXT NOT NULL,
  series_id  UUID REFERENCES alu_series(id) ON DELETE SET NULL,    -- NULL = usable with any series
  active     BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);
CREATE TABLE alu_hardware_package_items (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id       UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  package_id      UUID NOT NULL REFERENCES alu_hardware_packages(id) ON DELETE CASCADE,
  type_id         UUID NOT NULL REFERENCES door_window_types(id) ON DELETE CASCADE,
  hardware_set_id UUID REFERENCES alu_parts(id) ON DELETE CASCADE,  -- NULL = no hardware set on purpose
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (package_id, type_id)
);
ALTER TABLE estimation_projects
  ADD COLUMN IF NOT EXISTS hardware_package_id UUID REFERENCES alu_hardware_packages(id) ON DELETE SET NULL;

CREATE INDEX idx_alu_hardware_packages_series_id      ON alu_hardware_packages(series_id);
CREATE INDEX idx_alu_hardware_package_items_type_id   ON alu_hardware_package_items(type_id);
CREATE INDEX idx_alu_hardware_package_items_set_id    ON alu_hardware_package_items(hardware_set_id);
CREATE INDEX idx_estimation_projects_hw_package       ON estimation_projects(hardware_package_id);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['alu_hardware_packages','alu_hardware_package_items'] LOOP
    EXECUTE format('CREATE INDEX idx_%s_tenant_id ON %I(tenant_id)', t, t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY admin_full_access ON %I FOR ALL TO authenticated
      USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation'))
      WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation'))$p$, t);
  END LOOP;
END $$;
```

- [ ] **Step 2: SQL test** `supabase/tests/estimation_hardware_packages_test.sql` with the same fixture header as `estimation_type_parent_test.sql` (names `__HWP TEST A/B/C__`). Blocks: (1) as tenant A: insert a series, a type, a `hardware_set` part, a package (series NULL) with one row (set) and one row for a second type with `hardware_set_id` NULL (both succeed); a duplicate `(package, type)` raises `unique_violation`; a duplicate package name raises; an estimation project can take `hardware_package_id`; (2) isolation, BEFORE any delete: tenant C (no `estimation`) sees 0 rows in both tables and `INSERT` raises; tenant B sees none of A's rows; (3) deletes: deleting the type removes its rows; deleting the part removes the rows that used it; deleting the package removes its rows and sets the project's `hardware_package_id` to NULL; deleting a series sets the package's `series_id` to NULL. Owner script `run-hardware-packages-tests.sh` copied from `run-type-parent-tests.sh` (new file names; persistence check on table `alu_hardware_packages`; leftover `tenants like '__HWP TEST%'`). Agents never run it against Supabase.

- [ ] **Step 3: Failing tests** `src/lib/projectHardware.test.js`

```js
import { describe, it, expect } from 'vitest'
import { hardwareSetStatus, missingHardwareTypeIds, packagesForSeries } from './projectHardware.js'

const types = {
  slide: { id: 'slide', parent_id: null }, low: { id: 'low', parent_id: 'slide' }, top: { id: 'top', parent_id: 'slide' },
  swing: { id: 'swing', parent_id: null }, fixed: { id: 'fixed', parent_id: null },
}
const items = [
  { type_id: 'slide', hardware_set_id: 'HW-A' },
  { type_id: 'top', hardware_set_id: 'HW-B' },
  { type_id: 'fixed', hardware_set_id: null },
]

describe('hardwareSetStatus', () => {
  it('uses the type\'s own row, else the nearest ancestor\'s', () => {
    expect(hardwareSetStatus(items, types, 'top', 'OLD')).toEqual({ set_id: 'HW-B', status: 'set' })
    expect(hardwareSetStatus(items, types, 'low', 'OLD')).toEqual({ set_id: 'HW-A', status: 'set' })
    expect(hardwareSetStatus(items, types, 'slide', 'OLD')).toEqual({ set_id: 'HW-A', status: 'set' })
  })
  it('a row with no set means "no hardware set" on purpose, not missing', () => {
    expect(hardwareSetStatus(items, types, 'fixed', 'OLD')).toEqual({ set_id: null, status: 'none' })
  })
  it('a type with no row in a chosen package is missing and does NOT fall back to the old project default', () => {
    expect(hardwareSetStatus(items, types, 'swing', 'OLD')).toEqual({ set_id: null, status: 'missing' })
    expect(hardwareSetStatus([], types, 'swing', 'OLD')).toEqual({ set_id: null, status: 'missing' })
  })
  it('with no package at all (null / undefined) the old project default applies, so existing projects price the same', () => {
    expect(hardwareSetStatus(null, types, 'swing', 'OLD')).toEqual({ set_id: 'OLD', status: 'legacy' })
    expect(hardwareSetStatus(undefined, types, 'swing', null)).toEqual({ set_id: null, status: 'legacy' })
  })
  it('no type gives nothing to resolve', () => {
    expect(hardwareSetStatus(items, types, null, 'OLD')).toEqual({ set_id: null, status: 'missing' })
    expect(hardwareSetStatus(null, types, null, 'OLD')).toEqual({ set_id: 'OLD', status: 'legacy' })
  })
})

describe('missingHardwareTypeIds', () => {
  it('lists distinct type ids that are missing, in the order given', () => {
    expect(missingHardwareTypeIds(items, types, ['low', 'swing', 'fixed', 'swing', null])).toEqual(['swing'])
  })
  it('lists nothing for a project without a package or without types', () => {
    expect(missingHardwareTypeIds(null, types, ['swing'])).toEqual([])
    expect(missingHardwareTypeIds(items, types, [])).toEqual([])
    expect(missingHardwareTypeIds(items, types, null)).toEqual([])
  })
})

describe('packagesForSeries', () => {
  const pk = [
    { id: 'a', name: 'B', series_id: 's1', active: true },
    { id: 'b', name: 'A', series_id: null, active: true },
    { id: 'c', name: 'C', series_id: 's2', active: true },
    { id: 'd', name: 'D', series_id: 's1', active: false },
  ]
  it('lists active packages of that series or of any series, sorted by name', () => {
    expect(packagesForSeries(pk, 's1').map(p => p.id)).toEqual(['b', 'a'])
  })
  it('with no series chosen only any-series packages are offered; null input is empty', () => {
    expect(packagesForSeries(pk, null).map(p => p.id)).toEqual(['b'])
    expect(packagesForSeries(null, 's1')).toEqual([])
  })
})
```

- [ ] **Step 4: Run, see it fail** (`npx vitest run src/lib/projectHardware.test.js` → module not found).

- [ ] **Step 5: `src/lib/projectHardware.js`**

```js
// src/lib/projectHardware.js
// Project hardware packages: a hardware set per door/window type, chosen once per project (Ruling 20). Pure.
import { typeAndAncestorIds } from './typeTree.js'

// packageItems: rows of the project's chosen package, or null/undefined when the project has none.
// legacyDefaultId: estimation_projects.default_hardware_set_id (used only while there is no package).
export function hardwareSetStatus(packageItems, typesById, typeId, legacyDefaultId) {
  if (!Array.isArray(packageItems)) return { set_id: legacyDefaultId || null, status: 'legacy' }
  for (const id of typeAndAncestorIds(typesById, typeId)) {
    const r = packageItems.find(x => x.type_id === id)
    if (r) return r.hardware_set_id ? { set_id: r.hardware_set_id, status: 'set' } : { set_id: null, status: 'none' }
  }
  return { set_id: null, status: 'missing' }
}

// Distinct type ids (first-seen order) the chosen package does not cover; none for a project without a package.
export function missingHardwareTypeIds(packageItems, typesById, typeIds) {
  const out = []
  for (const id of typeIds || []) {
    if (id && !out.includes(id) && hardwareSetStatus(packageItems, typesById, id, null).status === 'missing') out.push(id)
  }
  return out
}

// Active packages the project's series may use (a package with no series fits any), sorted by name.
export function packagesForSeries(packages, seriesId) {
  return (packages || [])
    .filter(p => p.active !== false && (!p.series_id || p.series_id === seriesId))
    .sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? ''), 'th'))
}
```

- [ ] **Step 6: `estimationInherit`.** In `resolveItemInputs` add the trailing parameter `packageItems` and compute `const hw = hardwareSetStatus(packageItems, typesById, template && template.type_id, pj.default_hardware_set_id)`; set `hardware_set_id: it.no_hardware_set ? null : first(it.hardware_set_id, hw.set_id)`. `buildEngineOpening` passes its new trailing `packageItems` through; `buildEngineAddonOpening` is unchanged (an add-on never has a hardware set). Add tests to `estimationInherit.test.js`: item set wins over the package; `no_hardware_set` beats the package; the package's set is used for the template's type (and for a child of a mapped parent); `'missing'` gives null; `packageItems` omitted gives today's project default (the existing tests pass untouched).

- [ ] **Step 7: Full run and commit**

```bash
npx vitest run && npm run build
git add supabase/migrations/2026-10-12-03-estimation-hardware-packages.sql supabase/tests/estimation_hardware_packages_test.sql src/lib src/hooks
git commit -m "feat(estimation): project hardware packages, a hardware set per type filled into items automatically

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

### Task 12: Catalog screens — profile dimensions + die no. + drawing, mixed thickness, settings tab

**Files:**
- Modify: `src/pages/aluCatalog/ProfilesTab.jsx`, `src/pages/aluCatalog/HierarchyTab.jsx`, `src/pages/AluCatalog.jsx`, `src/components/AttachmentsSection.jsx` (optional `accept` prop only)
- Create: `src/pages/aluCatalog/SettingsTab.jsx`
- Read first: `src/components/CatalogCrud.jsx` (supports `type: 'select'`; check `number` step / min), `src/components/AttachmentsSection.jsx` (upload pattern, Ruling 13), `src/lib/catalogForm.js`

**Interfaces:**
- Consumes: Task 1 columns; `profileSketchSvg` (Task 11); `useEstimationSettings`, `saveEstimationSettings` (Task 11); `accessoriesForSeries`-style filtering is NOT needed here (settings parts are any active `kind = 'accessory'` part).
- Produces: nothing for other tasks.

Mockup screen 8 + the template/type notes. Steps:

- [ ] **Step 1: ProfilesTab.** In `PROFILE_FIELDS`: relabel `drawing_no` to `DIE NO. (รหัสแม่พิมพ์ของโรงรีด)`; add `shape_group` (text, "กลุ่มรูปร่าง เช่น กล่องเรียบ"), `width_mm` and `depth_mm` (number, step `0.01`, min 0, labels "ความกว้างรวมหน้าตัด (มม.)" / "ความสูง/ลึกรวมหน้าตัด (มม.)"), `primary_contact` (select, label "พื้นผิวสัมผัสหลัก (หน้าที่เส้นรองมาชน)": `width` = "หน้ากว้าง เช่น 101.6 (ปกติ) — เส้นรองหักตามความสูง/ลึก", `depth` = "หน้าแคบ — เส้นรองหักตามความกว้าง", default `width`; show beside it the live result, e.g. "เส้นรองจะหักข้างละ 44.45 มม.", computed with `jointDeductionMm`). Show the sketch (`profileSketchSvg` via `dangerouslySetInnerHTML` is acceptable here: the string is built only from numbers) under the form, using `thickness_mm` as `wall_mm` and `shape: 'u'` when `shape_group` contains "กล่องเรียบ" else `'box'`. Also list, read-only, the other profiles that share the same `shape_group` (DIE NO., thickness, weight) so the owner sees the dies of one shape.
- [ ] **Step 2: Drawing files.** Under the profile form render `<AttachmentsSection table="alu_profile_files" bucket="alu-profile-files" foreignKey="profile_id" entityId={profile.id} tenantId={...} accept=".pdf,.dwg,.dxf,.svg,.png,.jpg,.jpeg" />` (get `tenantId` the way the other pages that use `AttachmentsSection` do). Add the optional `accept` prop to `src/components/AttachmentsSection.jsx` (default = today's `.pdf,.xlsx,.xls,.jpg,.jpeg,.png`, so nothing else changes). Add the hint "1 ไฟล์ = 1 หน้าตัด แยกไฟล์ catalog/DWG ก่อนอัปโหลด". Files are stored and downloaded only; DWG has no preview. Deleting a profile must first delete its stored files (storage objects), because the table rows cascade but the storage objects do not: remove the objects with `supabase.storage.from('alu-profile-files').remove(paths)` before deleting the profile row. The migration (Task 1) already creates the table and bucket.
- [ ] **Step 3: HierarchyTab — mixed thickness.** Under the series-types links of the selected series, add one checkbox per linked type: "อนุญาตให้วงกบกับบานใช้ความหนาต่างกัน (งานราชการ เช่น วงกบ 2.0 / บาน 1.5)" bound to `alu_series_types.allow_mixed_thickness` (update the existing link row by id; no upsert). Disabled when the user cannot edit.
- [ ] **Step 4: SettingsTab** (new tab "ค่ามาตรฐาน" in `AluCatalog.jsx`, same gating as the other tabs). One form for `estimation_settings`: stock length (ม.), kerf ตัดฉาก 90° (มม.), kerf ตัด 45° (มม.), min keep offcut (ม.), sealant (ม./หลอด 300 มล.), fixing pitch (ม.), min fixing points per side, and four part selects (sealant, shim, screw, plug) listing active `accessory` parts or "— ไม่ใช้ —". Show the hints: "kerf เป็นค่าสมมติ ใส่ค่าจริงของเลื่อย" and, beside the 45° field, "ตัด 45° เสียมากกว่า (ประมาณ 10 มม.) ให้วัดจริง และระบุความยาวชิ้น 45° เป็นความยาวด้านนอกเสมอ". Load with `useEstimationSettings`, save with `saveEstimationSettings` (insert-or-update). If the load returned an `error`, disable saving (otherwise `saveEstimationSettings(null, …)` would insert a duplicate row). Empty numeric inputs fall back to the default (never save NaN / blank).
- [ ] **Step 4A: TypesTab tree (Ruling 18/19).** Replace the flat table in `src/pages/aluCatalog/TypesTab.jsx` with the tree from `buildTypeTree` (indent per level, up to three; show the badge "ใช้เลือกได้" on leaves only). Add fields: `parent_id` (select "อยู่ใต้ประเภท": "— ระดับบนสุด —" plus types that are at level 1 or 2 and are not the edited type or inside its own subtree, labelled with `typeLabel`) and extend the `category` options with `curtain_wall` = "ผนังกระจก". When a parent is chosen the category select is set from the parent and disabled. Add a "+ เพิ่มประเภทย่อย" button on each row of level 1 or 2 (prefills `parent_id`). `default_labour_per_sqm` hint: "เว้นว่าง = ใช้ของประเภทแม่". The delete warning gains "ถ้ามีประเภทย่อย ต้องลบประเภทย่อยก่อน". Surface the trigger's error text in Thai ("ประเภทมีได้สูงสุด 3 ระดับ"). `HierarchyTab`: the series-type picker lists the tree; ticking a type that has children shows "ซีรีส์จะผลิตประเภทย่อยทั้งหมดของประเภทนี้"; `PartsTab`/series-part links use the same tree picker with the same hint. All three use `typeLabel`.
- [ ] **Step 5: Build and commit**

```bash
npm run build && npm test
git add src/pages/aluCatalog src/pages/AluCatalog.jsx src/components/AttachmentsSection.jsx
git commit -m "feat(alu-catalog): profile dimensions, die no., drawing files, mixed-thickness flag and settings tab

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

### Task 13: BomTemplates editor — type, part links, preview settings, joints and notch tabs

**Files:**
- Modify: `src/pages/BomTemplates.jsx` (template editor: lines ~100–340)
- Create: `src/pages/bomTemplates/JointsTab.jsx`
- Read first: the editor's `handleSave` (delete + reinsert pattern), `AluminumProfiles` import (leave as is)

**Interfaces:**
- Consumes: `useCatalogTable('door_window_types')`, `useEstimationCatalog()` (families from `index.seriesProfilesBySeries` + profiles; parts), `useTemplateJoints` (Task 11), `jointRowsForInsert`, `validateJoints`, `componentRowsForInsert`, `jointIndexForLoad` (Task 11), `seriesForType` + `allowsMixedThickness` (Task 2).
- Produces: templates with `type_id`, `preview_kind`, `main_axis`, joints and component joint/thickness links.

Mockup screen 5 (FOUR tabs: the fourth, "ชุดอุปกรณ์โครงการ", edits `alu_hardware_packages` and `alu_hardware_package_items` through `useHardwarePackages` (Task 11B): package select + name + series select + "+ ชุดอุปกรณ์โครงการใหม่", and a table type → hardware set (types from `buildTypeTree`, any level; sets from `hardwareSetsForSeries` for the package series, or every active hardware set when the series is "ทุกซีรีส์"; "— ยังไม่กำหนด —" = no row, "— ไม่ใช้ชุดอุปกรณ์ —" = row with NULL set); it does not depend on the template being edited). Steps:

- [ ] **Step 1: Template fields.** Add selects `ประเภท (จากแคตตาล็อก)` → `type_id` (options = `selectableTypes(types)` labelled with `typeLabel`; if the saved `type_id` is not selectable because it now has children, keep it in the list and show a warning pill "ประเภทนี้มีประเภทย่อย เลือกประเภทย่อย"), `รูปแบบภาพตัวอย่าง` → `preview_kind` (`fixed` "บานติดตาย", `slide` "บานเลื่อน", `swing` "บานสวิง"), and `เส้นหลักของกรอบ (วิ่งเต็ม)` → `main_axis` (`vertical` "เส้นตั้ง ซ้าย/ขวา", `horizontal` "เส้นนอน บน/ล่าง"). Include them in the `payload` that is inserted/updated.
- [ ] **Step 2: Hardware lines.** Add a `part_id` select per hardware line (active parts of kind `hardware`, `accessory` or `hardware_set`, shown as `P-0007 ชื่อ`), "— ไม่ผูก (ใช้ราคาอ้างอิง) —" first. Keep `reference_unit_price` as the fallback.
- [ ] **Step 3: Family list.** Replace the `profile-family-options` datalist (read from legacy `aluminum_profiles`) with the distinct families of the catalog (`alu_series_profiles.family` or the profile's `family`).
- [ ] **Step 4: Components.** Add per component row: `joint_index` select ("ไม่มีจุดชน" + the template's joints by name), `joint_ends` (1 or 2), and `thickness_role` (select "ความหนา: ตามวงกบ" = NULL / "ตามบาน" = `sash`; shown only when the template's type is offered by at least one series with `allowsMixedThickness` true; otherwise hidden and saved as NULL). Rows are loaded through `jointIndexForLoad(components, joints)`.
- [ ] **Step 5: Joints tab** (`JointsTab.jsx`, tabs "ส่วนประกอบและอุปกรณ์" / "รายละเอียดการประกอบ (จุดชน)" / "รายละเอียดการบาก" as in the mockup). Joint rows: `name`, `main_family`, `secondary_family` (selects of families), `deduction_mode` (`auto` "อัตโนมัติ: พื้นผิวสัมผัสหลักของเส้นหลัก" / `manual` "กำหนดเอง (มม.)" + `deduction_mm`), `cut_style` (`square` "ตัดตรง 90°", `notch` "บากมน (notch)", `miter45` "ตัด 45°"). The notch tab edits `notch_width_mm` / `notch_depth_mm` of the selected joint and draws the code-drawn sketch (port the mockup's `drawNotch`). Show the main/secondary rule as a one-line hint, and for `miter45` the warning "ความยาวชิ้นตัด 45° ใช้ความยาวด้านนอกเสมอ".
- [ ] **Step 6: Save order (critical).** In `handleSave`, after the template row is written: validate with `validateJoints` (show the Thai message, do not write); delete components; delete joints; insert joints from `jointRowsForInsert(jointRows, templateId)` with `.select('id')` ordered by `sort_order`; then insert components from `componentRowsForInsert(rows, templateId, insertedJoints)`. Then hardware and constraints as today. A component must never be inserted before its joints. Before saving, check that every component linked to a joint has `profile_family === joint.secondary_family` (Thai message "ส่วนประกอบที่ผูกจุดชนต้องเป็นหน้าตัดเดียวกับเส้นรองของจุดชน") — costing prices the component's own family, so a mismatch would silently disagree. Component rows are built only by `componentRowsForInsert` (a whitelist of real columns); never spread editor rows into an insert. Validate that every component has a non-negative number for the deduction and a positive quantity (the lib turns blanks into 0, so the editor must refuse them).
- [ ] **Step 7: Build and commit**

```bash
npm run build && npm test
git add src/pages/BomTemplates.jsx src/pages/bomTemplates
git commit -m "feat(estimation): template type, part links, preview settings and joint/notch tabs

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

### Task 14: Estimation project page — defaults, extruder, price date, banners

**Project hardware (Task 11B, mockup v25 screen 1):** the single "ชุดอุปกรณ์" default is replaced by a select-only field "ชุดอุปกรณ์ของโปรเจกต์" listing `packagesForSeries(packages, project series)` plus "— ไม่ใช้ —", saved to `estimation_projects.hardware_package_id`. Show the amber banner for `missingHardwareTypeIds(...)` ("ประเภท … ยังไม่ได้กำหนดชุดอุปกรณ์ คิดราคาโดยไม่มีชุด") and, if the chosen package belongs to another series, "ชุดนี้ไม่ใช่ของซีรีส์ที่เลือก". Pass the package's rows (or null when none) to every `buildEngineOpening` / `resolveItemInputs` call.

**Files:**
- Modify: `src/pages/Estimation.jsx` (becomes a thin shell; move the opening editor out in Task 15)
- Create: `src/pages/estimation/ProjectDefaultsPanel.jsx`, `src/pages/estimation/AvailabilityBanner.jsx`, `src/pages/estimation/StalePriceBanner.jsx`, `src/pages/estimation/ItemsTable.jsx`

**Interfaces:**
- Consumes: `useEstimationCatalog()` (index, loading, error), `resolveItemInputs`, `typeAvailability`, `itemsAffectedByDefaultSeries`, `thicknessesForSeries`, `hardwareSetsForSeries`, `seriesLabelFull`, `localDateString`, `costOpening`, `listPriceChanges`, `groupByTemplate`, `useEstimationSettings`, `useTemplateJoints`.
- Produces: the props the item modal needs (`project`, `catalog`, `settings`, maps by template).

Mockup screens 1, 3, 4, and the items table of the project page. Steps:

- [ ] **Step 1: Defaults panel.** Fields: main extruder (`primary_provider_id`; "ไม่กำหนด (เลือกต่อรายการ)" allowed), series (label `ชื่อซีรีส์ · ชื่อโรงรีด`; options filtered to the main extruder when set), colour (the series' provider's `alu_finishes`), frame thickness (`thicknessesForSeries`; a single thickness is auto-selected and the select locked with the hint) and sash thickness (`default_sash_thickness_mm`, same choices, "เท่ากับวงกบ" = blank; shown only when at least one type of the series allows mixed thickness), infill, hardware set (`hardwareSetsForSeries(index, seriesId, null)`), labour ฿/ตร.ม., profit %, price date (read-only text, `price_as_of`), description format (ordered chips from `DESCRIPTION_TOKENS` stored in `description_format`, with a live sample from `buildItemDescription`). Blank = NULL (labour 0 is a value). Saving writes only changed columns.
- [ ] **Step 2: New project.** `price_as_of` is set from `localDateString(new Date())` in the insert (Ruling 17); never leave it to the DB default.
- [ ] **Step 3: Changing the default series** lists the items it affects (`itemsAffectedByDefaultSeries`) in a confirm dialog before saving; the warning banner (`AvailabilityBanner`) lists items whose template or add-on type the series does not offer (`typeAvailability`), with the offering series, as in mockup screen 3. It never blocks saving.
- [ ] **Step 4: Items table** columns: เลขช่อง, ชื่อรายการ, ประเภท, ซีรีส์, สถานะ (unresolved / ภาพเก่า / ok), ขนาด, จำนวนชุด (editable inline; integer ≥ 1, refuse blanks, fractions and 0; updates `quantity` only), ราคา/ชุด (from `costOpening(...).total`), รวม. An unresolved item shows its reasons in a tooltip and its price cell reads "—", never 0.
- [ ] **Step 5: Stale-price banner** (`StalePriceBanner`): compute each item's cost twice (`asOf = project.price_as_of`, `asOf = localDateString(new Date())`) with `costOpening`, feed `{[id]: bom}` maps to `listPriceChanges`, and show "มีราคาใหม่ N รายการ" with the list (name, before/after price row). The refresh button comes in Task 17.
- [ ] **Step 6: Gate and load states.** Show a loading line until `useEstimationCatalog().index` is non-null; show the error text if it fails; render nothing sensitive for a user without edit rights (inputs disabled via `canEdit`).
- [ ] **Step 7: Build and commit**

```bash
npm run build && npm test
git add src/pages/Estimation.jsx src/pages/estimation
git commit -m "feat(estimation): project defaults, extruder, price date, availability and stale-price banners

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

### Task 15: Item form — fields, add-on position, layout templates, preview, description, saved snapshots

**Files:**
- Create: `src/pages/estimation/ItemModal.jsx`, `src/pages/estimation/PreviewPanel.jsx`, `src/pages/estimation/LayoutTemplatePicker.jsx`, `src/pages/estimation/ItemCostSummary.jsx`
- Modify: `src/pages/Estimation.jsx` (replace the old `OpeningEditor`; delete it)

**Interfaces:**
- Consumes: Tasks 2, 3, 4, 7, 9, 10, 11 libs; the project-page props from Task 14.
- Produces: rows in `estimation_openings` (via `buildOpeningPayload`).

Mockup screen 2 (all of it). Steps:

Hardware field (mockup screen 2): while "ใช้ค่าโปรเจกต์" is ticked the select is disabled and shows the set resolved by `hardwareSetStatus` (from the project's package) for the chosen template type (follows type changes); status `missing` shows the warning "ประเภทนี้ยังไม่ได้กำหนดชุดในโปรเจกต์"; unticking lets the owner pick any set the series offers for the type.

Layout (mockup v24): two balanced columns. Left = item fields, add-on, quotation description; right = preview, layout-template cards and the save-snapshot options. The type field is three cascading selects built from `buildTypeTree(types)` (Ruling 22), the saved `template.type_id` is always the leaf. The frame field label is "ความหนา วงกบ (มม.)" and the sash select never offers "same as frame" (Ruling 21).

Type selects (main type, add-on type, layout-template main/add-on type) list `selectableTypes(types)` labelled with `typeLabel` (Ruling 18); series availability and layout-template availability use the EXPANDED `seriesTypes` from `useEstimationCatalog` (Task 11A).

- [ ] **Step 1: Fields.** Item no., item name and description (separate; description auto-filled from `buildItemDescription` with a "สร้างใหม่" button, editable), template (grouped by type), size (กว้าง/สูง ม.), panels, series / colour / thickness / infill / hardware set each with "ใช้ค่าโปรเจกต์" (empty = inherit; infill and set also have an explicit "ไม่ใช้" = `no_infill` / `no_hardware_set`), per-item labour and profit override, extra lines. **No quantity field.** Thickness choices (frame, and sash when the template's type allows mixed thickness in the resolved series, `allowsMixedThickness`) come from `thicknessesForSeries` of the resolved series; hardware-set choices from `hardwareSetsForSeries(index, seriesId, template.type_id)`; show the inherited value as a hint. Seed and save with `emptyForm` / `formFromOpening` / `validateForm` / `buildOpeningPayload` (Task 11).
- [ ] **Step 2: Add-on.** Template choice from `addonTemplatesForSeries` (2a), size, panels, **position** (บน/ล่าง/ซ้าย/ขวา) and **offset** (ม. from the left or top; blank = centred). Partly filled = "no add-on yet", not an error.
- [ ] **Step 3: Layout templates.** `LayoutTemplatePicker` shows thumbnail cards for `availableLayoutTemplates(...)` of the chosen main type: each card renders a small `buildFramePreview` of the template applied to the current size (`applyLayoutTemplate`), greyed with the reason text when unusable. Clicking applies add-on type/position/size/offset/panels; the add-on BOM template is the first of `bomTemplatesForType`, changeable. A "บันทึกเป็นแม่แบบรูปแบบ" checkbox + name saves a row from `layoutTemplateFromItem` into `estimation_layout_templates` AFTER the item saves successfully; a duplicate name error is shown in Thai and does not undo the item.
- [ ] **Step 4: Live preview.** `PreviewPanel` calls `buildFramePreview` with `main_axis` and `preview_kind` from the template, `frame_mm` from the main frame profile's visible width (`resolveCatalogProfile(...).profile.width_mm`; omit when unknown), `view` (out/in toggle), and for the "parts" style `part_labels` built from `costOpening` (profile die no. and cut length per side). Styles: double, solid, CAD, parts (all four stay, Ruling 11); render the geometry as SVG using CSS variables for theming (see the mockup's `unit()`), and draw `seams`, `decor`, `dims`, `labels`.
- [ ] **Step 5: Saved snapshots.** A checkbox "บันทึกภาพตัวอย่างพร้อมรายการ" (on by default) with ภายนอก / ภายใน. On save build the two views with NO part labels via `previewSvgString(buildFramePreview({... view: 'out' | 'in'}), { style: 'double' })`, plus `previewSignature(...)` computed from the SAME normalised values as the payload (the saved row's numbers, never raw form strings) and including the main template's `preview_kind` / `grid_row_weights` and the add-on template's `preview_kind` / `grid_row_weights` / `main_axis`, and pass `{out, in, sig}` and `savedAt` (an ISO string made in the click handler) to `buildOpeningPayload`. When the stored `preview_sig` differs from the current signature show "ภาพที่บันทึกไว้เก่ากว่าข้อมูล" and a button to re-save the snapshot.
- [ ] **Step 6: Cost summary.** `ItemCostSummary` lists, from `costOpening`: profile lines (with die no. and an "ไม่พบ: <reason>" in Thai for each unresolved reason code: `no_series` "ยังไม่เลือกซีรีส์", `no_finish` "ยังไม่เลือกสี", `no_profile` "ไม่พบหน้าตัดความหนานี้", `no_weight`, `no_kg_price` / `no_price` "ยังไม่มีราคา", `finish_other_provider` "สีเป็นของโรงรีดอื่น", `no_hardware_price`, `no_part_price`, `unknown_set` / `empty_set` / `not_hardware_set`, `no_as_of`, `no_main_profile`, `no_dimension`, `rule_not_cuttable`, `unknown_joint`, `bad_manual_deduction`), hardware, hardware-set lines, accessory extras, waste, infill, labour, silicone, felt, extra lines, per-set total. Reason-code texts must also cover `unknown_infill` "ไม่พบวัสดุอุดช่อง", `unknown_addon_template` "ไม่พบเทมเพลตชุดต่อเติม", `no_variant`/`no_piece_price` "ยังไม่มีราคาต่อเส้น", `no_provider`, and `no_dimension` reads "ยังไม่ได้กรอกขนาด" when `name === 'ขนาดช่องเปิด'` or `source === 'addon'`, but "ไม่มีมิติของหน้าตัดเส้นหลัก" when `source === 'joint'`; list every entry of `unresolved` (shape `{name, reason, source}`). The total is not shown as a number while `unresolved` is non-empty — show "ราคายังไม่ครบ" with the list instead.
- [ ] **Step 7: Constraints** (`evaluateConstraints`, existing) keep working per template.
- [ ] **Step 8: Build and commit**

```bash
npm run build && npm test
git add src/pages/Estimation.jsx src/pages/estimation
git commit -m "feat(estimation): item form with add-on position, layout templates, live preview and saved snapshots

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

### Task 16: Whole-project BOM screen — aluminium, accessories, sealant, stock length, cut optimizer, extruder comparison

**Files:**
- Create: `src/pages/estimation/ProjectBomView.jsx`, `src/pages/estimation/CutOptimizerPanel.jsx`, `src/pages/estimation/ProviderCompare.jsx`
- Modify: `src/pages/Estimation.jsx` (a "BOM ทั้งโครงการ" tab on the project page)

**Interfaces:**
- Consumes: `costOpening` (Task 7), `buildProjectBom`, `stockLengthFor` (Task 6), `compareLengths` (Task 5), `compareProviders`, `diffAgainst` (Task 8), `useProjectStock`, `useEstimationSettings`, `piece/kg price helpers` via `index`.
- Produces: `estimation_project_stock` rows, `estimation_projects.stock_length_m`.

Mockup screens 6 and 7. Steps:

- [ ] **Step 1: BOM view.** Build `entries` (`{opening_no, quantity, finish_id: resolved.finish_id, bom, addonBom, extras, unresolved: r.unresolved}`) from `costOpening` for every item, then `buildProjectBom({entries, settings, stock: stockForProject(projectStockRows, project.id, project), profilesById: index.profiles, finishesById: index.finishes, partsById: index.parts})` (`stockForProject` ignores other projects' rows). Show the three sections of mockup screen 6: (1) aluminium by profile + colour: die no., colour, merged cut list (length, quantity, 45°/90° marker), total metres, stock length (editable per profile → `estimation_project_stock`, no upsert: look up, then insert/update/delete when blank), bars, offcut; plus the project stock length field (`stock_length_m`, blank = tenant default shown as hint); (2) parts table (hardware vs accessory, quantity, cost, an "ราคายังไม่ครบ" flag); (3) sealant: total length, tubes. Unresolved entries are listed with opening and reason, above the tables.
- [ ] **Step 2: Cut optimizer panel** (mockup screen 7). Per profile: candidate lengths = the distinct `length_m` of its `alu_profile_variants` for that colour plus the stock length; `barPrice(L)`: for a `per_kg` provider = `resolveAluPrice(...).price_per_m * L`; for `per_piece` / `both` providers it must NOT scale the default-length price: use the exact `alu_profile_variants` row of length L (`findVariant` with an exact-length match) and its own latest piece price at the project's `price_as_of`, else null (then the row is compared by scrap, not cost); run `compareLengths`; highlight `best`, show bars, scrap, reusable offcut, waste %, cost, and "ใช้ความยาวนี้" which writes the per-profile stock length. Kerf and min-keep are read from settings (shown, not edited here). A candidate shorter than the longest cut shows "ตัดไม่ได้"; an infeasible row (`feasible === false`) shows its `unplaced` pieces and must never look cheap (its bar count and cost are not comparable). Cap free-typed piece quantities in the UI (the packer allocates one object per piece).
- [ ] **Step 3: Extruder comparison** (mockup screen 6, lower panel). For each candidate extruder row the owner picks a series and colour of that extruder; `compareProviders` computes aluminium cost; show difference vs the project's main extruder with `diffAgainst` (— when incomplete) and "คิดไม่ได้ N รายการ" with the reason; a "ใช้โรงรีดนี้" button sets `primary_provider_id` and the project default series/colour (after a confirm that lists the items affected). Read-only otherwise.
- [ ] **Step 4: Build and commit**

```bash
npm run build && npm test
git add src/pages/Estimation.jsx src/pages/estimation
git commit -m "feat(estimation): whole-project BOM, cut optimizer and extruder comparison screens

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

### Task 17: Refresh-price button and the quick calculator ("ลองคิดราคา")

**Files:**
- Create: `src/pages/estimation/QuickQuote.jsx`
- Modify: `src/pages/estimation/StalePriceBanner.jsx`, `src/pages/Estimation.jsx`

**Interfaces:**
- Consumes: `costOpening`, `localDateString`, `listPriceChanges`, the Task 14 maps.

Both were requested by the owner (2026-10-09: "ทำ"); there is no mockup for them, so keep them minimal and ask before adding UI beyond this.

- [ ] **Step 1: Refresh button** in `StalePriceBanner`: "อัปเดตเป็นราคาปัจจุบัน" opens a confirm dialog listing the changes (name, old → new price rows resolved to prices) and, on confirm, sets `estimation_projects.price_as_of` to `localDateString(new Date())`. Only for users with edit rights. Never automatic.
- [ ] **Step 2: Quick calculator** (a button on the Estimation page, opens a `Modal`): type/template, series, colour, thickness, width, height, panels → shows the per-set cost from `costOpening` with a throw-away item and the current project's defaults replaced by the chosen values; writes nothing to the database. Unresolved reasons are shown the same way as the item form.
- [ ] **Step 3: Build and commit**

```bash
npm run build && npm test
git add src/pages/estimation src/pages/Estimation.jsx
git commit -m "feat(estimation): refresh-price button and quick price calculator

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

### Task 18: Contract migration and retiring the legacy tables (written here, applied at deploy time only)

**Files:**
- Create: `supabase/migrations/2026-10-13-01-estimation-contract.sql`
- Modify: `src/lib/bomEngine.js` (delete `legacyPricing`), `src/lib/bomEngine.test.js` (tests that used it: switch them to a small `catalog`-style pricing stub or delete only the legacy-specific cases), `src/pages/BomTemplates.jsx` (remove the legacy colour screen `FinishForm` and its list; leave the legacy aluminium-profiles tab, which belongs to the PO side), `src/hooks/useSupabase.js` (remove `useAluminumFinishes` once nothing uses it)

**Interfaces:**
- Consumes: everything; nothing in the app may import `legacyPricing` or read `estimation_openings.series` / `finish_id` after this task.

- [ ] **Step 1: Create the migration** with exactly:

```sql
-- supabase/migrations/2026-10-13-01-estimation-contract.sql
-- Aluminium cost catalog, Phase 2b "contract" step. APPLY ONLY AT DEPLOY TIME: after the Phase 2b code is live and
-- every item has been opened and saved once (so it carries series_id / alu_finish_id). It drops the legacy columns
-- and the legacy colour table. It refuses to run while any item still relies on them.
DO $$
DECLARE n INT;
BEGIN
  SELECT count(*) INTO n FROM estimation_openings WHERE series IS NOT NULL AND series_id IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'contract refused: % item(s) still rely on the legacy series text; open and save them first', n;
  END IF;
  SELECT count(*) INTO n FROM estimation_openings WHERE finish_id IS NOT NULL AND alu_finish_id IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'contract refused: % item(s) still rely on the legacy colour; open and save them first', n;
  END IF;
END $$;

ALTER TABLE estimation_openings DROP COLUMN series, DROP COLUMN finish_id;
-- No CASCADE: if anything else still references the legacy colours this must fail loudly, not silently drop it.
DROP TABLE aluminum_finishes;
```

- [ ] **Step 2: Delete `legacyPricing`** from `src/lib/bomEngine.js`; update its tests in `src/lib/bomEngine.test.js` so the engine behaviour they pin (length rules, quantity basis, waste, grid, infill, hardware, unresolved, labour) still runs, using a tiny inline pricing stub `{kind:'catalog', profileLine(...), hardwarePrice(h), setLines(){return []}}` or `makeCatalogPricing` with an index fixture. Do NOT delete a behaviour test merely because it used the old helper.
- [ ] **Step 3: Remove** the legacy colour management from `BomTemplates.jsx` and the unused hook. Grep first (`grep -rn "aluminum_finishes\|useAluminumFinishes\|legacyPricing" src`) and list every remaining reference in the report; `PurchaseOrders.jsx` and `AluminumProfiles.jsx` must stay untouched.
- [ ] **Step 4: Build and commit** (the SQL is committed but NOT applied)

```bash
npm run build && npm test
git add supabase/migrations/2026-10-13-01-estimation-contract.sql src/lib/bomEngine.js src/lib/bomEngine.test.js src/pages/BomTemplates.jsx src/hooks/useSupabase.js
git commit -m "feat(estimation): contract migration and retire the legacy colour table and pricing adapter

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

### Task 19: Final verification and handover

- [ ] **Step 1:** `npm test` and `npm run build` — all green. Report the test count.
- [ ] **Step 2:** `git diff --stat <phase-2a-HEAD>..HEAD -- . ':!docs' ':!*.test.js'` and confirm no file outside the estimation / catalog area changed except `src/App.jsx` (menu) if it changed at all. List any other file.
- [ ] **Step 3:** Write `docs/handover-aluminium-cost-catalog.md` (short): what was built, the three SQL scripts the owner runs and their order, the deploy checklist below, the Rulings (copy the list from this plan), and the open items. Commit it.
- [ ] **Step 4:** STOP. Do not merge, do not push, do not apply any SQL. Phase 3 (cost settings, price structure, Quotation export and the quotation attachment of saved previews) is planned separately after the owner has tried Phase 2b.

---

## Owner click-through checklist (after the migrations are applied on a copy or on CHANG)
- Types tab: create ประตู → บานเลื่อน → รางล่าง / รางบน (3 levels; a 4th level is refused; a child cannot be given the other category). Link the series to บานเลื่อน only: both child types appear for that series. In a template and in the item form, only รางล่าง / รางบน are listed (not ประตู or บานเลื่อน). A part linked to บานเลื่อน shows for both children.

1. Settings tab: enter kerf 90°/45°, sealant 10 m, link shim/screw/plug parts. Catalog → profile "กล่องเรียบ" U1613: dimensions 101.6 × 44.45, primary contact "ความสูง", attach a drawing; the sketch shows; the other dies of the shape are listed.
2. Series → type: tick "อนุญาตความหนาต่างกัน" for บานเลื่อน.
3. Template: set type, preview kind, main axis = เส้นตั้ง; add a joint (main กล่องเรียบ, secondary ตัวนอน, auto); link the horizontal component to it; save, reopen — the link is still there; a manual joint with a blank mm is refused.
4. New project: price date = today's local date; set main extruder, series, colour; thickness locks when the series has one.
5. Item: no quantity field; inherit hints; pick a layout card; add-on at ล่าง; flip ภายนอก/ภายใน; "parts" style shows die no. and lengths with the secondary bar shortened; save with the snapshot; edit the width — "ภาพเก่ากว่าข้อมูล" appears.
6. An item with no series shows "ราคายังไม่ครบ" and "—" in the table, not 0.
7. BOM ทั้งโครงการ: cut list merged across items × quantity; set a bar length for one profile; the optimizer marks the best length; sealant tubes = total length ÷ 10 rounded up once; the extruder comparison shows "คิดไม่ได้" for an extruder lacking the thickness.
8. Log in as a tenant WITHOUT the estimation module: no menu entry, no data, no error toasts anywhere else.

## Deploy checklist (the order matters)

1. Owner applies Phase 1 migrations 01–03, then 2026-10-11-01, then 2026-10-12-01, then 2026-10-12-02 (type parents; test script `run-type-parent-tests.sh`), then 2026-10-12-03 (hardware packages; `run-hardware-packages-tests.sh`) (each only after its test script is green).
2. Deploy the code. Open and save every existing item once (so `series_id` / `alu_finish_id` are set).
3. Only then apply `2026-10-13-01-estimation-contract.sql` (it refuses while any item still uses the legacy columns).
4. Rebase the branch onto the current `origin/main` (the PO release moved it) before the final merge; resolve conflicts in `src/App.jsx` / `src/hooks/useSupabase.js` by hand.

## Self-Review

**Spec / owner-comment coverage.** Project defaults + extruder + price date (Tasks 1, 14); item form fields, thickness from the series, hardware vs accessory (2, 15); add-on position/offset (1, 9, 10, 15); layout templates by type with thumbnails (1, 9, 15); name vs description + configurable quotation description (9, 14, 15); no quantity in the item form (11, 14); live preview with four styles, inside/outside, joint ends, profile width (10, 15); saved double-line snapshot + stale hint (1, 10, 15); profile dimensions, die no., drawing, primary contact (1, 3, 12); joints and notch detail per template (1, 3, 13); role thickness where the type allows (1, 3, 12, 13); accessories at fixing points and sealant tubes (4, 12, 16); whole-project BOM, stock length per profile, cut optimizer 90°/45° (5, 6, 16); extruder comparison (8, 16); stale-price banner, refresh button, calculator (14, 17); legacy retirement (18). Not in this plan by the owner's instruction: CAD/DXF drawings, quotation export and attachment (Phase 3), import, PO linkage.

**Placeholder scan.** Every pure-code step contains its complete code and tests; those files were executed against the Phase 2a branch before being written here (the suite was green with them, build OK). The SQL was verified by reading only (no database is available to the planner). Screen tasks are specified by behaviour against the mockup rather than line-by-line JSX; they have no tests beyond the build, which is why the click-through checklist exists.

**Type consistency.** `costOpening` ctx maps are `{[templateId]: rows[]}` (`groupByTemplate`); `entries` for `buildProjectBom` use `finish_id` from `resolved.finish_id`; `cut_style` is `square | notch | miter45` in SQL, `assembly`, the engine and `cutOptimizer`; `ADDON_POSITIONS` is exported from both `framePreview.js` and `layoutTemplates.js` with identical contents (do not import one from the other); component rows use `joint_index` in the editor and `joint_id` in the database.

**Known gaps, stated.** The preview's mirrored inside view swaps sliding panels by a simple rule, not by real rail layout; the quotation attachment layout is undecided until Phase 3; kerf defaults are placeholders; the SQL test script has never been run.

## Hand-over notes still owed to the owner

- Legacy colour prices have no edit screen until the catalog's Prices tab is used (nothing is imported).
- Price overrides (profile/series) never expire.
- The UI allows one link per part per series per type; the database already allows several types (Ruling 2).
- Nested hardware sets must be guarded in the Parts UI (a set cannot contain a set).
- `DEFAULT current_date` is the UTC date: the app sets `price_as_of` itself (Ruling 17); projects created before this change keep the date they were applied on.
- The owner enters his saw's real kerf values in the settings tab; until then optimizer results use placeholders.
