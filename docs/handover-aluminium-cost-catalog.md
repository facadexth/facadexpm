# Aluminium cost catalog — Phase 2b handover

Branch `feat/alu-cost-catalog` (worktree `.claude/worktrees/alu-cost-catalog`). **Not merged, not pushed.** Phase 3 is described in the second half of this file.

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

---

# Phase 3 handover — price structure, quotation export, attachments, compare

Spec: `docs/superpowers/specs/2026-10-09-aluminium-price-structure-and-quotation-export-design.md`. Plan: `docs/superpowers/plans/2026-10-09-aluminium-cost-catalog-phase-3-price-structure.md`. **Not merged, not pushed.** Task 9 (pictures in the catalogue screens) is **not built**: it waits for an owner-approved mockup.

## What was built

- **Price structure tab** ("โครงสร้างราคา") on the project page: waste %, profit % (the existing `profit_pct`, per-item override), PM %, project transport total, rounding step; V / W / X / Y / Z / PM / per-set / rounded price / per-m²; hide-empty cost columns; SUMPRODUCT row; two pies; aluminium weight (net and with waste); glass code hover. The formulas were checked against **all 21 rows** of the owner's workbook (`price_structure.xlsx`, sheet ELSY): V, X, Y, Z, PM, per-set, rounded price, per-m² all match.
- **Four per-set item costs** in the item form: Fire Barrier, Bracket, bend aluminium, bend glass (baht per set).
- **Send / update to quotation** (button needs `estimation` + `quotations` modules, ADMIN and edit rights on both pages): creates a normal draft quotation (one `item` + one `item_description` row per item, same defaults as a hand-made quotation), optional split material/labour (default 80/20, adjustable). Re-sending follows the owner's revision rule: draft → overwrite in place; sent/accepted → history snapshot in `quotation_revisions`, status back to draft, revision +1; each push is numbered R{rev}-{n} (R1-1, R1-2, R2-1 …). Rows the user added in the quotation are never touched; rows referenced by invoices are never deleted. Retry after a failed push does not duplicate quotations or lines.
- **Attachment pages** ("แบบแนบ") appended to the quotation print/PDF: 4 items per A4 page (2×2), outside + inside views, spec rows, hardware-set schedule (paged), colour legend, page numbers continue, footer `QT-xxxx-R2-1 · หน้า n / N`. Stored SVG previews are shown through `<img src="data:image/svg+xml…">` after a reject-validator (never injected as markup).
- **Compare after signing** ("เทียบราคาจริง" tab): pulls the agreed per-line prices and bill discount from the quotation, compares per item with the offer using the cost base of the last *sent* snapshot, shows real profit % vs the % that was set, stores an `agreed` snapshot. Opening the tab only reads.

## SQL — the owner runs these (agents never ran any)

1. Phase 2b first (`2026-10-12-02`, `-03`) as above.
2. `2026-10-14-01-price-structure.sql` — test first: `! bash .superpowers/sdd/2026-10-09-aluminium-cost-catalog-phase-3-price-structure/run-price-structure-tests.sh`, then apply.
3. `2026-10-14-02-estimation-images.sql` (adds `image_path` columns + the private `estimation-images` bucket; used by the later pictures task) — test first: `! bash .superpowers/sdd/2026-10-09-aluminium-cost-catalog-phase-3-price-structure/run-estimation-images-tests.sh`, then apply.

**Deploy order: apply 14-01 BEFORE deploying the code.** Without the migration ALL of these writes fail with an unknown-column error: item save (the four cost columns), estimation settings save (`default_*` columns), project creation (`newProjectRow` sends the factor columns and `round_step`), project factors save (`waste_pct`, `pm_pct`, `transport_total`, `round_step`) and the profit-tick write on the price structure tab; the send-to-quotation and compare tabs also need the three new tables. (14-01 also makes `estimation_quotation_lines.opening_id` nullable with ON DELETE SET NULL and caps the three `default_*_pct` settings and project `*_pct` columns at 1000.) (14-02 can follow; without it the attachment pages simply show placeholders.)

## Files touched outside the estimation area

`src/pages/Quotations.jsx` — additive only (+36 / −6, the removed lines are signature/call-site lines): `QuotationHeader` exported with an optional `subtitle`; `QuotationPaper` optional `extraPages` / `extraPageCount`; the document modal calls `useQuotationAttachments`. A characterization snapshot of the original output was committed first and is unchanged; for a tenant without `estimation` the hook makes zero queries (tested). `Estimation.jsx` gained two tabs. No other standard module changed.

## Owner click-through list (nothing has been clicked with real data yet)

1. Apply the migrations above (tests first). Open a project: set waste / profit / PM / transport / step; add items with the four extra costs.
2. Price structure tab: compare the numbers with your ELSY workbook.
3. Press "ส่งไปใบเสนอราคา": pick a customer; check the draft quotation (lines, prices, notes, bank) in the Quotations page.
4. Open the quotation print / PDF: check attachment pages (A4 heights, 4 per page, colour swatches, hardware schedule), the last page has no blank page after it, footer label.
5. Change a price, press update → R1-2; mark the quotation sent, then update again → R2-1, quotation back to draft with revision 2.
6. Tick split material/labour and re-check totals. Mark the quotation accepted, edit a price in the Quotations page, open "เทียบราคาจริง" and pull the agreed prices.

## Decisions waiting for the owner

- Attachment pages are visible only to admin/owner (row security on the link/line tables). Other roles that print a linked quotation get no attachments and no warning. Open read access to the quotation roles, or show a warning?
- If the print modal is opened before attachments finish loading and PDF is pressed immediately, the PDF has no attachments.
- Pictures in the catalogues (Task 9): needs a mockup of the upload field per catalogue screen.
- Transport total in the ELSY sheet is calculated from trips × km × rate + film per sq ft + cleaning per sq m; the app has one number. Add a small sub-calculator?
- The ELSY sheet applies a supplier discount per cost category (e.g. glass −10%) before V; the app uses catalogue prices as they are.
- Compare tab shows per item only (no per-category comparison).

## Rulings made in Phase 3 (owner may overturn)

P3-1 reuse the existing `profit_pct` (no `markup_pct`); P3-2 the template's own waste is excluded from V and the project's waste % applies to aluminium; P3-3 `image_path` on `alu_profiles`, `infill_types`, `alu_parts`, `alu_finishes` (+ `color_hex`), `alu_profiles.image_url` ignored; P3-4 sub-number stored on `estimation_price_snapshots`; P3-5 split rounding goes to labour; plus: Task 9 gated on mockup; migration before deploy; user-row sort order may be rewritten (order only); validity default 30 days (spec §6); notes from `tenants.default_notes`; thumbnails (`thumb` mode) deferred and disabled in the dialog; hook takes `hasModuleAccess` as a parameter (`useTenant` is not a shared context).

## Deferred minors

link-insert failure after the quotation insert can orphan one draft (tiny window); step-6 failure then retry adds a second sent snapshot; send gate untested in a browser; attachment: moved-last-set vs notes budget, duplicate part keys, no hardware page when no set is used, `-webkit-line-clamp` unchecked in PDF, part quantities per set not per type; source-guard test bypassable (`supabase['from']`); sumproductRow ignores its `keys` argument; tests do not pin the profit untick write.

---

# Part editor handover — BOM Template part editor (sliding window, 2 sashes, no transom)

Spec: `docs/superpowers/specs/2026-10-10-bom-template-part-editor-design.md`. Plan: `docs/superpowers/plans/2026-10-10-bom-template-part-editor.md`. Approved mockup: `docs/superpowers/mockups/2026-10-10-bom-part-editor-mockup.html`. **Not merged, not pushed.** Nothing has been clicked with real data yet.

## What was built

- **BOM Template → tab "ส่วนประกอบ"**: for a template created from "สร้างจากแบบบานเลื่อน 2 บาน (ไม่มีช่องแสง)" the flat component table is replaced by the part editor: live overview drawing (outside/inside), zoomed part view with clickable end markers (วิ่งสุด ↔ ชน, exactly one of the two pieces at a corner runs through), side panel per position (profile family, length rule, deduction auto/manual, length factor, pieces, thickness role, per-piece per-end target + deduction, "ที่มา" step line), "+ เพิ่มโปรไฟล์ในตำแหน่งนี้", components table grouped by part with "↳ ความยาวไม่เท่ากัน" lines. Legacy templates (no layout kind) are unchanged.
- **Automatic deductions** from the frame's butt distances (sash rails: 2 × side-frame butt distance − hook overlap, stiles: top + bottom frame butt distance), manual override per line; overlap = hook-stile distance (auto) or manual.
- **Engine**: two optional columns on template components, `length_factor` (default 1) and `end_deduction_mm` (default 0): `length = rule × factor − end_deduction/1000`. Legacy rows: identical results. The part model is expanded into these flat components at costing time (`partExpand.js`), so pricing, weight, bars, quotations use the unchanged cost engine.
- **Item preview and quotation attachment drawings** for part-model templates are the same drawing as the editor overview (`partPreviewSvg.js`, same true-scale widths); outside/inside; only double-line and solid styles (parts/CAD styles and add-on combinations stay legacy). Stored drawings are marked "ภาพเก่า" when the model or a drawn width changes.
- **Catalogue**: new field "ระยะชน เมื่อถูกชน หลัง notch (มม.)" on every aluminium profile.
- Expander problems (no butt distance, no target, no profile family, corner violation, no model) are shown in the cost summary like joint issues — never silently counted as 0.

## SQL — the owner runs this (agents never ran any), one command per message

After the Phase 3 migrations (through `2026-10-14-02`):

1. Test first (runs migration + tests in one rolled-back transaction): `! bash .superpowers/sdd/2026-10-10-bom-template-part-editor/run-part-editor-tests.sh` — expect `PART EDITOR TESTS PASSED` and leftover = 0.
2. Apply `supabase/migrations/2026-10-15-01-bom-part-editor.sql`.

**Deploy order: apply the migration BEFORE deploying the code.** Without it the Estimation page still works for legacy templates (the four new tables just fail to load), but saving a typed butt distance fails and part-model templates show "no model".

## Data the owner must enter before the numbers are real

Per profile (and per series/thickness where it differs): **full width, butt distance after notch, hook overlap / clearance**. Without a butt distance the cost summary says "no_butt_distance" (Thai text) and counts 0 for that deduction. Worked example to check (1800 × 1200; side-frame 38.1, top 38.1, bottom 35.8, stiles 25, hook 25): frame top/bottom 1,723.8; side frames 1,200; sash rails 824.4; stiles 1,126.1.

## Owner click-through list

1. Apply migration (test first). Catalogue → profiles: enter butt distances for the frame/sash profiles.
2. BOM Templates → new template → "สร้างจากแบบบานเลื่อน 2 บาน": pick profiles for each position; check the table numbers against the worked example.
3. Click an end marker: partner flips, deductions change, lengths split into "ความยาวไม่เท่ากัน" rows. Add a second profile (cover) to a position.
4. Save, reload: model comes back unchanged. Switch to inside view.
5. Estimation: add an item with this template; check cost, weight, drawing; add to quotation; check the attachment page drawing.
6. Open a legacy template and an old project: nothing should look different.

## Deferred / notes

Add-on combinations and the parts/CAD preview styles are still legacy for part-model templates; other window/door types to follow the same pattern (spec §10 table); the owner's formulas for other types are still to be defined. Save is delete-then-insert (non-atomic, last-write-wins if two admins edit the same template at once). The mockup puts the hook stile on the left of every sash, so the meeting stiles are sash 1's key stile and sash 2's hook stile — **owner to confirm** this matches the real window (hook–hook in the middle?). Bar count uses the 6.4 m default length. The editor takes widths at its test series/thickness, the item at its own. Live check in the real app is still owed.

## Rulings made in the part-editor arc (owner may overturn)

PE-1..PE-6 (plan header), PE-7 hook takes `templates` and the part path gates on `layout_kind` alone (no model → `no_model`), PE-8 small additive Task 6 reviewed by the controller only, PE-9 item/quotation drawing uses the editor's true-scale widths and the stale-drawing signature is model JSON + drawn widths.
