# Aluminium cost catalog — Phase 2b handover

Branch `feat/alu-cost-catalog` (worktree `.claude/worktrees/alu-cost-catalog`). **Not merged, not pushed.** Phase 3 (cost settings, price-structure table, Quotation export, attaching the saved previews to a quotation) is planned separately after you have tried Phase 2b.

## What was built

- **Catalog (FacadeX only, module `estimation`):** extruder → series → door/window type → parts/hardware, price history by `effective_from`, three-level type tree (กลุ่มหลัก → แบบ → แบบย่อย) with parent/child, profile dimensions + DIE NO. + primary contact surface + drawing files, mixed frame/sash thickness per series×type, settings tab (stock length, kerf 90°/45°, sealant, fixing points, accessory parts).
- **BOM templates:** type, preview kind, main axis, joints (main/secondary bar, automatic deduction from profile dimensions or manual, square / notch / 45°), notch tab, hardware-package tab ("ชุดอุปกรณ์โครงการ").
- **Project page:** defaults (extruder, series, colour, frame + sash thickness, infill, hardware package, labour, profit), price date locked, availability warning, stale-price banner with refresh button, items table, quick calculator ("ลองคิดราคา").
- **Item form:** cascading type select, add-on with position and offset (mm), layout templates, live preview (4 styles, inside/outside), saved double-line snapshot with signature + "ภาพเก่า" hint, cost summary with Thai reason codes, quotation description.
- **Whole-project BOM:** aluminium by profile + colour with stock length per profile, cut optimizer (whole project), parts/accessories, sealant tubes, extruder comparison.
- **Contract migration** written (not applied) and legacy colour table / pricing adapter retired in code.

## SQL — the owner runs these, in this order, each only after its test script is green

Agents never ran any of this. Use `!` in the prompt. Test scripts run inside one rolled-back transaction.

1. Already applied on CHANG (2026-10-09): `2026-10-10-01..03`, `2026-10-11-01`, `2026-10-12-01`.
2. `2026-10-12-02-estimation-type-parent.sql` — test first: `! bash .superpowers/sdd/2026-10-09-aluminium-cost-catalog-phase-2b-screens/run-type-parent-tests.sh`, then apply the migration.
3. `2026-10-12-03-estimation-hardware-packages.sql` — test first: `! bash .superpowers/sdd/.../run-hardware-packages-tests.sh`, then apply.
4. **Deploy time only:** `2026-10-13-01-estimation-contract.sql` (drops legacy columns and the legacy colour table; refuses while any item still relies on them).

## Deploy checklist (the order matters)

1. Apply steps 2 and 3 above (each after its test is green).
2. Deploy the code. Open and save every existing item once so `series_id` / `alu_finish_id` are set.
3. Only then apply the contract migration (it refuses to run otherwise).
4. Rebase the branch onto the current `origin/main` (the PO release moved it) before the final merge; resolve conflicts in `src/App.jsx` / `src/hooks/useSupabase.js` by hand.
5. Do not merge before Phase 3 is done (owner's standing rule).

## Files touched outside the estimation / catalog area

`src/App.jsx` (menu entry, 3 lines), `src/components/AttachmentsSection.jsx` (optional `accept` prop; default unchanged), `src/components/Modal.jsx` (optional `maxWidth` for `ConfirmDialog`; default 400), `src/hooks/useSupabase.js` (removed the unused legacy colour hook), `src/lib/catalogData.js`, `src/lib/staleProjectPrices.js`. New shared components `CatalogCrud.jsx` and `LinkEditor.jsx` are used only by the alu catalog tabs. Standard-module pages (`PurchaseOrders.jsx`, `AluminumProfiles.jsx`, …) are untouched.

## Excel import

`TEMPLATE_แคตตาล็อกอลูมิเนียม.xlsx` (17 sheets, in the main folder). No import button exists: when you return the filled file I convert it to an SQL script for you to check and run.

## Rulings (the plan's list; owner may overturn any of them)

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
23. **(owner-approved mockup) The item form shows MILLIMETRES** for sizes and add-on offsets; conversion to metres only in `formFromOpening` / `buildOpeningPayload`; DB, signature and engine stay metres.
24. **Frame width in the preview** comes from the family of the first non-sash (thickness_role NULL) width/height component; joints only choose among those; one shared picker for the drawn frame and the "parts" labels.
25. **Type names stay globally unique** (`door_window_types UNIQUE (tenant_id, name)`): the owner names types in full ("ประตูบานเลื่อนรางล่าง") and the Excel import references types by name; the UI gives a Thai duplicate message and hint. *Wrong if:* the owner wants the same short name under different parents (change the index, use paths in the import).
26. **The contract migration refuses only when nothing resolves** (item value, else the project's default, is NULL) for series / colour, with a guard-logic SQL test; the type-parent trigger function sets `search_path`.

## Open items and notes for the owner

- **Owner decisions still open:** Rulings 4 / 7 / 8 / 9 run on the plan's defaults (1 DIE NO. = 1 item; offcuts never reduce cost; shim + screw + plug off until their parts are linked in settings; sealant shown as tubes while its cost stays the silicone line); real saw kerf values (defaults 3 mm square / 10 mm 45° are placeholders); whether an unmapped type in a hardware package should block pricing instead of warning.
- No screen has been clicked through with real data (agents cannot load data): use the click-through checklist in the plan (`docs/superpowers/plans/2026-10-09-aluminium-cost-catalog-phase-2b-screens.md`, section "Owner click-through checklist").
- Legacy colour prices have no edit screen until the catalog's Prices tab is used (nothing is imported).
- Price overrides (profile/series) never expire.
- The UI allows one link per part per series per type; the database already allows several types (Ruling 2).
- Nested hardware sets must be guarded in the Parts UI (a set cannot contain a set).
- `DEFAULT current_date` is the UTC date: the app sets `price_as_of` itself (Ruling 17); projects created before this change keep the date they were applied on.
- Deferred minors are listed in the SDD ledger (`.superpowers/sdd/2026-10-09-aluminium-cost-catalog-phase-2b-screens/progress.md`): e.g. saving a BOM template reads old row ids without checking the read's own error; the quick calculator may stay open when switching project; a project's hardware package name/series save is not atomic with its rows.
- Review minors deferred on purpose: inactive-ancestor types (the item cascade hides the subtree, other pickers list the leaf); the project defaults panel counts as edited when opened (reconcile fills blanks); BOM template category is still door/window only; duplicated tiny helpers (`num`, `isSet`); `BomTemplates.jsx` is 594 lines; the typeless-template banner also counts items that set their own hardware; a failed new-template save leaves a delete button that does nothing until refetch.
- Contract-guard test: `! bash .superpowers/sdd/2026-10-09-aluminium-cost-catalog-phase-2b-screens/run-contract-guard-tests.sh` (needs migrations up to 2026-10-11-01 applied; run it before the deploy-time contract step).
- Drawing / CAD (DXF/DWG) export is a later extension, not part of this arc.
