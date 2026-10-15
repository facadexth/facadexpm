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

## Deferred minors from the final part-editor review

Two admins saving the same template at once can leave duplicate part sets (no unique key on template_id + part_key); a save that fails midway leaves the template empty until re-saved (costing reports it as incomplete, never 0; invalid models are now rejected before any delete); engine does not clamp a negative piece length (a mistyped width can give a negative line with no warning); if any of the four part tables fails to load, part-model items show "no model" and saved drawings read "ภาพเก่า"; child rows' tenant_id/butt targets are not tied to the parent in the DB (same pattern as the other estimation tables); the SQL test script has never been run and lacks some CHECK cases — run it first (BEGIN…ROLLBACK).

---

# Layouts for every type handover (2026-10-13) — part editor for all 23 catalogue leaf types

Spec: `docs/superpowers/specs/2026-10-13-part-editor-layouts-all-types-design.md`. Plan: `docs/superpowers/plans/2026-10-13-part-editor-layouts-all-types.md`. Approved mockup of the 22 drawings: `docs/reference/type-previews-mockup.html`. Branch `feat/alu-cost-catalog`, 23 commits after `9d778ff8` (19 for the plan up to `3b3b8628`, then the final-review fix wave `10aed1cc`, `c7a11ad0`, `f6907aa7` and this handover correction; suite 1847 -> 2218 passing, build OK). **Not merged, not pushed, nothing deployed, and no agent ran any SQL.** Nothing of the 12 new kinds has been clicked on real data; the screenshots in `.playwright-mcp/t10-local-*.png` (main checkout) come from a local harness, not from CHANG.

## What was built

- **13 layout kinds**, one file each under `src/lib/layouts/` (the shipped `sliding_2` plus 12 new), registered in `src/lib/layoutRegistry.js`. The part editor, the item form, the preview drawing, costing (`partExpand.js`) and the saved rows all work from the kind; the cost engine itself is unchanged.
- **Engine generalisations** (spec section 3): expression-driven piece counts / factors / overlaps (`layoutExpr.js`), grid deductions, tee joints, mitred corners, optional positions (door sill), per-track sliding (`trackOf`), per-cell kinds for curtain walls (`layoutCells.js`).
- **Editor/UI**: one interactive drawing per new kind (part tabs, fading, click-to-assign, "เสร็จแล้ว" ticks, shown on the overview badge), inputs panel from the layout, Thai issue texts. Item form: the layout's `estimator` inputs, curtain-wall cells clickable on the item preview; saved drawings are not made stale by the ticks.
- **Drawing**: `partGeometry.js` + `partGeometryBodies.js` (bars) and `partSvgSymbols.js` / `partSymbols.js` (opening symbols, dashed in/out view, hinge sides, slide arrows). The `sliding_2` drawing is byte-identical to before (pinned by a sha256 test).
- **Hardware defaults** (`src/lib/hardwareDefaults.js`): when a template is created from a layout, the layout's declared hardware is written once as `bom_template_hardware` lines (see rulings R-11a, R-F4).
- **Final-review fix wave** (rulings R-F1..R-F5 below): sliding_n / sliding_3track sashes are left / middle / right parts so the stile families are right for n >= 3; `fixed_by_type` means "the type MAY pin it"; the "ความยาวชิ้น" drawing style prints cut lengths; curtain wall k = 1 saves; swing-door beads; a dedicated message when a template's kind no longer matches its type; a template whose part rows are missing is reported incomplete.

## The 13 kinds (catalogue type -> kind)

"Fixed by type" = inputs marked `fixed_by_type` in the layout file, i.e. inputs the type **may** pin. An input is fixed only when the type's `door_window_types.layout_params` actually **sets that key** (R-F2; `model.fixedKeys`): then the value comes from the type, overrides anything stored on the template, is read-only in the editor and hidden on the item. When the type leaves it blank, the template sets it, and if it is also an estimator input the item may change it. "Estimator" = inputs the item form shows (W and H are always implicit), minus the keys the type pins. Defaults in brackets. Thai labels are `layoutLabels` in the registry (the catalogue type form's select).

| layout_kind | Thai label | Catalogue type(s) (leaf) | Fixed by type | Estimator inputs |
|---|---|---|---|---|
| `sliding_2` | บานเลื่อนสวน 2 บาน | บานเลื่อนสวน 2 บาน (shipped, unchanged) | - | - (W, H only) |
| `sliding_n` | บานเลื่อน n บาน | บานเลื่อนรางล่าง (door) | `door` (true for the bottom-rail door: threshold rail, no bottom frame) | `n` [2], 2-6 — sashes are parts บานซ้าย / บานกลาง × (n-2) / บานขวา (R-F1) |
| `sliding_3track` | บานเลื่อน 3 ราง | บานเลื่อน 3 บาน | - | `fixed_side` [left] left/right |
| `sliding_2_fixed_2` | บานเลื่อน 2 ตาย 2 | บานเลื่อน 2 ตาย 2 | - | - |
| `fixed_grid` | บานติดตาย (ซอยกลาง) | บานติดตาย | - | `rows` [2] 1-8, `cols` [3] 1-12 |
| `awning_grid` | บานกระทุ้ง (ชั้น × ช่อง) | the 6 types บานกระทุ้ง r ชั้น x c ช่อง | `rows` = r, `cols` = c | `open` [out] out/in (`rows` / `cols` are never on the item; in the template editor they are read-only only when the type pins them) |
| `casement_n` | บานเปิดข้าง | บานเปิดข้าง; บานเปิดข้างเดี่ยว (new type, n = 1) | `n` (บานเปิดข้างเดี่ยว: 1; บานเปิดข้าง: leave blank) | `n` [2] 1-8 unless the type pins it, `hinge` [left] (shown only when n = 1), `open` [out] |
| `swing_door` | ประตูบานเปิด/สวิง | บานเปิด (hinged); บานสวิงเดี่ยว / บานสวิงคู่ (pivot) | `leaves` [1] 1-2 (1 / 2 for the swing types; leave blank for บานเปิด), `pivot` (true for บานสวิง*) | `leaves` (only when the type does not pin it), `hinge` [left] (only when 1 leaf), `open` [out], `sill` [yes] yes/no |
| `frameless_door` | ประตูสวิงเปลือย | บานสวิงเปลือยเดี่ยว / คู่ | `leaves` 1 / 2 | `leaves` (only when the type does not pin it), `hinge` (only when 1 leaf), `open` |
| `hanging_door` | ประตูเลื่อนรางแขวน | บานเลื่อนรางแขวน | `leaves` [1] 1-2 (leave blank so the item chooses) | `leaves` (only when the type does not pin it) |
| `folding_door` | บานเฟี้ยม | บานเฟี้ยม | - | `nL` [2], `nR` [2], each 0-5, not both 0 |
| `curtain_wall` | Curtain wall | STICK WALL; UNITIZED CURTAIN WALL | `unitized` (false / true) | `rows` [3], `cols` [4], `spandrel` [none] none/top/bottom, `k` [0.5] (0.5 / 1 / 0), `cells` (per-cell kind map) |
| `frameless_wall` | ผนังกระจกเปลือย | ผนังกระจกบานเปลือย | - | `cols` [3] 1-12 |

That is 17 named types + the 6 กระทุ้ง types = 23 leaf types. **Casement (R-12a, done):** `n` on `casement_n` is both `fixed_by_type` and `estimator`, so the type บานเปิดข้างเดี่ยว sets `n = 1` in the type form (read-only in its templates, not shown on its items), while บานเปิดข้าง leaves `n` blank and each item sets it. Curtain wall also has the extra estimator inputs `spandrel`, `k` that the spec table did not list; at `k = 1` the four plate / cover lines are absent (they come back when `k` changes).

**Swing door beads (I5):** `swing_door` has two free positions คิ้วประตู (ตั้ง) / คิ้วประตู (นอน), 2 + 2 per leaf, family `คิ้วประตู` (spec 5.7 / Excel sheet 6); the vertical ones take the stile length (through), the horizontal ones the leaf width (through, no end deduction) — set deductions per line if the Excel cuts them shorter.

Position/part names per kind (วงกบ, บาน, ซอยกลาง, ราง, ...) and their default profile families are in each layout file; the default hardware per kind is the `hardware` array in the same file (counts listed in the owner questions below).

## Params columns

All three are `JSONB NOT NULL DEFAULT '{}'`, CHECK object, added by the migration:

- `door_window_types.layout_kind` (new column, nullable, 13-kind CHECK) and `door_window_types.layout_params`: the `fixed_by_type` values of the type (set in the catalogue type form next to "แบบชิ้นส่วน"). They override the template's and are applied again at creation.
- `bom_templates.layout_params`: the template's input defaults (e.g. `{rows, cols}`), plus `cells` (curtain-wall cell kinds `"row,col" -> glass|awning|spandrel`, 0-based), plus the reserved key **`_done`** = the part keys the owner ticked "เสร็จแล้ว" (UI only: not an input, dropped by `coerceParams`, never reaches an expression, ignored by the stale-drawing signature).
- `estimation_openings.layout_params`: item overrides for `estimator` inputs only, and `cells` (spec question R5: the item may override the template's cell picture — built that way, still to be confirmed).
- **Omit-when-absent (works before the migration)**: a model without params (`sliding_2`) writes no `layout_params` key to `bom_templates`; an item with no layout values writes no `layout_params` key to `estimation_openings`. So legacy sliding_2 templates and items keep saving before the migration; every new kind needs the migration to save at all (the `bom_templates` CHECK admits only `sliding_2` until then).
- Numbers are coerced and clamped on load (numeric strings from JSON are accepted; out-of-range values are clamped to the input's min/max; unknown keys are dropped).

## SQL — the owner runs this (agents never ran any), one command per message

Prerequisite: the catalogue / part-editor migrations through `2026-10-15-01` are already on CHANG. The new migration is order-independent with the parent plan's `2026-10-16-01` (it creates `door_window_types.layout_kind` with `ADD COLUMN IF NOT EXISTS`, and replaces any one-kind CHECK with the 13-kind list). It is additive and re-runnable.

1. Dry-run: the migration plus its tests in one rolled-back transaction (expect `LAYOUTS TESTS PASSED`; the check afterwards must show `applied = 0, leftover = 0`):
   `! bash .superpowers/sdd/2026-10-13-part-editor-layouts-all-types/run-layouts-tests.sh`
2. Apply for real:
   `npx supabase db query --project-ref kntspldhvcjeaubtqtkn --linked=false -f supabase/migrations/2026-10-17-01-layouts-all-types.sql`

What it does: widens **both** `door_window_types.layout_kind` (new column) **and** `bom_templates.layout_kind` CHECK to the 13 kinds (R-P1: the parent plan only mentioned the first; without the second no template of a new kind could be saved), and adds the three `layout_params` columns with object CHECKs. The standing `x.*` grep was done: only `expenses_view` uses `e.*`; no view selects from `door_window_types`, `bom_templates` or `estimation_openings` with `.*`, so no view needs recreating.

**Deploy order: apply the migration BEFORE the code.** If the code goes first, only `sliding_2` keeps working.

## Owner click-through list (nothing of the new kinds has been clicked on real data)

0. **Before the migration (R-10b, could not run — the agent's browser was logged out):** log in to the dev server (http://localhost:3001), open an existing `sliding_2` template in the part editor and an existing item that uses it; confirm the drawing and costing rows look as before and the browser console shows no errors.
1. Apply the migration (dry-run first, above).
2. **Catalogue -> type form:** before changing the แบบชิ้นส่วน of a type that already has templates, run the check below — a template whose kind differs from its type's kind no longer opens in the editor (it shows "แบบชิ้นส่วนของเทมเพลตนี้ (...) ไม่ตรงกับประเภท (...) — แก้แบบชิ้นส่วนที่ประเภทในแคตตาล็อก หรือสร้างเทมเพลตใหม่", R-F5) and costs nothing. The type form does not warn (it does not load the templates), so use the query:
   ```sql
   -- templates whose kind differs from their type's kind
   select t.id, t.name, t.layout_kind, d.name as type_name, d.layout_kind as type_kind
   from bom_templates t join door_window_types d on d.id = t.type_id
   where t.layout_kind is distinct from d.layout_kind and d.layout_kind is not null;
   ```
   Then set `layout_kind` + fixed params on each type (a fixed param left blank is not fixed: the template / item choose it): STICK WALL / UNITIZED CURTAIN WALL -> `curtain_wall` (`unitized` false / true); ผนังกระจกบานเปลือย -> `frameless_wall`; บานเปิด -> `swing_door`; บานสวิงเดี่ยว / คู่ -> `swing_door` (`pivot` true, leaves 1 / 2); บานสวิงเปลือยเดี่ยว / คู่ -> `frameless_door` (leaves 1 / 2); บานเฟี้ยม -> `folding_door`; บานเลื่อนรางแขวน -> `hanging_door`; บานเลื่อนรางล่าง -> `sliding_n` (`door` true); บานติดตาย -> `fixed_grid`; บานเปิดข้างเดี่ยว / บานเปิดข้าง -> `casement_n`; บานเลื่อนสวน 2 บาน -> `sliding_2`; บานเลื่อน 3 บาน -> `sliding_3track`; บานเลื่อน 2 ตาย 2 -> `sliding_2_fixed_2`; the 6 กระทุ้ง types -> `awning_grid` (rows = r, cols = c).
3. **One template per kind group**, assigning one profile family per part position, then save, reload and confirm preview + costing rows are unchanged after reload: fixed_grid; awning 2x2; casement 2; sliding 3; swing door with 2 leaves; folding 2+2; curtain wall with one awning cell and one spandrel cell (click cells in the preview).
4. Confirm the **default hardware** lines appear on each newly created template (and are editable; the family/part is left empty for you to pick). They are **fixed totals** computed from the template's own values at creation (e.g. 2 rollers × n of the template), and they **never follow the item's values** (an item with n = 4 on an n = 2 template still gets the template's hardware lines, R-F4). `fixed_grid`, `frameless_wall` and a curtain wall whose cells are all glass (the default) get no lines.
5. **Item form:** enter `n`, `nL,nR`, `cols`, `leaves`...; click curtain-wall cells; save; reopen; check the drawing, the weight and the costing rows; add to a quotation and look at the attachment drawing.
6. **sliding_2 templates can be re-pointed to `sliding_n`** (n = 2 gives the same per-family totals, proven by tests) to get the richer drawing with glass and slide arrows (R-8a: the old type keeps its plain drawing so its frozen tests stay green). The **type's** `layout_kind` must change to `sliding_n` too (else the template is refused as a mismatch), and the template's part rows must be re-made: after the update below, open the template: the frame lines keep their families, the sash parts (บานซ้าย / บานขวา) come back with blank families (I7) — assign the left sash's families (the right / middle sashes follow them) and save:
   ```sql
   -- re-point one sliding_2 template to sliding_n (n = 2 reproduces the numbers); the type must say sliding_n too
   update bom_templates set layout_kind = 'sliding_n', layout_params = '{"n":2}' where id = '<template id>';
   update door_window_types set layout_kind = 'sliding_n' where id = '<its type id>';
   ```
7. Open a legacy template and an old project: nothing should look different.
8. Fill the data the new numbers depend on: butt distance, width and hook overlap on every profile used by the new kinds (same rule as the part-editor handover above); without a butt distance the cost summary says so and counts 0.

## How to add a layout (a 14th kind)

1. One file `src/lib/layouts/<kind>.js` in the schema documented at the top of `src/lib/layoutRegistry.js` (kind, inputs with `estimator` / `fixed_by_type` / `only_when`, parts, positions with rules, joints, `roles`, `enabled`, `validParams`, `cells`, `familiesWhen`, `order`, `hardware`, `symbol`; `_done` is a reserved params key, never an input name).
2. One `import` and one entry in `LAYOUTS` in the registry, and the Thai label in `layoutLabels`.
3. `layoutRegistry.test.js` runs `validateLayout` over every registered layout (no extra test needed for the structure); add numbers in `src/lib/layouts/layouts.test.js` (worked examples: `startModel` snapshot, `expandParts` lengths with constant butt distances and with a profile index).
4. Geometry: a body in `src/lib/partGeometryBodies.js`, plus the matrix in `src/lib/partGeometry.test.js` (bar counts, every bar inside the opening, no overlaps except declared hook overlaps). Symbol / hardware marks in `partSvgSymbols.js` (`symbol` field of the layout; kinds `v_hinge`, `slide`, `fold`, plus `arrow` / `split`).
5. Add the kind to the CHECK list of **both** `door_window_types.layout_kind` and `bom_templates.layout_kind`. The 13-kind CHECK is closed: a 14th kind needs a **new migration** (do not edit `2026-10-17-01`).
6. If a new input should be saved, make sure it is an `inputs` entry (unknown keys are dropped by `coerceParams`).

## Rulings made in this arc (owner may overturn; the "if wrong" cost is in brackets)

Pre-flight (plan defects):
- **R-P1** The migration also widens `bom_templates.layout_kind` CHECK (plan only covered `door_window_types`); test asserts both. [one extra constraint rewrite, harmless]
- **R-P2** Task 2 also updated `partGeometry.js:90` to the new `partnerEnd(model, ...)` (plan miscounted callers). [nothing: compile fix]
- **R-P3** `autoDed` treats an absent role position as 0 (frame_top_bottom on a sill-less door = b(frame_top)). [door stile lengths off by one butt distance; tests would show it]
- **R-P4** `src/lib/partSymbols.js` is created in Task 4 (minimal `symbolFor`), extended in Task 8. [file placement only]
- **R-P5** Expression identifiers for cell counts are `cells_awning` / `cells_spandrel`. [naming only]
- **R-P6** `exprParams(model)` maps selects / booleans to numbers (yes/no -> 1/0) for every expression field. [naming only]
- **R-P7** `length_factor` of line 0 is re-derived on `setParams` when the rule factor is an expression; owner overrides of expression-driven factors are not kept across param changes. [factor drift on grids; tests caught it]

Engine / layouts:
- **R-3a** Tee joints default the horizontal ends to `through` (end deduction 0) because the grid pre-deduction already removes the full mullion/transom widths; a hand-set butt end still deducts b(vertical). Geometry insets transoms by the mullion width regardless of end mode. [transom long by (w - b) per end for profiles whose butt distance < width; visible in the expand table, adjustable]
- **R-3b** Transom count = (rows-1)·cols (rows 2, cols 3 -> 3 pieces; the spec's "6 x 530" was rows 3). [nothing: arithmetic]
- **R-3c** The cut-style token for mitred pieces is `miter45` (the app vocabulary), not the plan's `mitre`; the layout `corner: 'mitre'` mode name stays. [a string rename]
- **R-4a** `only_when` is a supported input key (show the input only while every listed param equals the value); the UI honours it (casement / swing / frameless `hinge`). [an input shown unnecessarily]
- **R-4b** `casement_n` side members keep one position name `เสาบาน` (labels เสาบานพับ / เสามือจับ), since a position has one name and BOM role_name = position name. [Thai label only]
- **R-5a** `sliding_2_fixed_2` uses `roles.hook = 'stile_b'` (one role position = one hook family for the whole part). [overlap off by (b(stile_b) - b(stile_a)) x 2 / 4 per rail when hook profiles are mixed; visible in the expand table]
- **R-6a** byEnd joints map horizontal piece p, end e <-> vertical piece p·perV + e. [sliding_2 snapshots would fail at once]
- **R-6b** `folding_door` nL / nR are capped at 5 each (sum <= MAX_PART_COUNT 10) instead of the plan's 0-6. [owner cannot enter 6+6 leaves; raise MAX_PART_COUNT later]
- **R-7a** Curtain-wall transom count = (rows+1)·cols (rows 3, cols 4 -> 16; the plan's 12 was an arithmetic error). [nothing: arithmetic]

Drawing:
- **R-8a** The `sliding_2` drawing stays exactly as shipped (no glass / arrows) because the plan freezes its tests; re-point templates to `sliding_n` for the richer drawing. [plainer preview for the one old type until re-pointed]

Persistence / UI:
- **R-9a** Door leaf members (swing, hanging, folding) use thickness role `sash`, not `leaf` — the DB CHECK admits only NULL (frame) and `sash`; the owner can still override per line. [door leaves priced at sash instead of frame thickness; one data edit to revert]
- **R-9b** `modelFromRows` still returns null for an unknown kind (frozen test); `loadModel` returns `{error:'unknown_layout'}`; costing's `no_model` is a loud refusal. [less specific error label on an impossible path]
- **R-9c** Expression-count parts (awning sashes, folding leaves, curtain-wall cells) are not editable (`setPartCount` no-op, count never persisted as a number; the UI hides the field). [owner cannot hand-override a computed sash count]
- **R-10a** The brief's live check against CHANG was limited to read-only checks of existing sliding_2 templates/items (new-kind saves are impossible before the migration and were not attempted); the implementer never applies the migration. [a UI defect on a new kind surfaces at owner acceptance; component tests are the net]
- **R-10b** That read-only live check is deferred to the owner (click-through step 0); component tests + harness screenshots stand in. [a runtime-only regression on the live data path surfaces at acceptance]
- **R-11a** `bom_template_hardware` has no `source` / `quantity_rule` columns and none were added: `hardwareDefaults` returns `{quantity, per, part_id: null, source: 'layout_default'}` and creation maps it to `{quantity_basis: 'fixed', quantity_value: total, reference_unit_price: 0, part_id: null}`; `per_sash` is resolved into the total at creation with the clamped part count; rows are inserted once on CREATE only; unevaluable rows are skipped and reported. [a hardware line count the owner edits by hand in the hardware tab]

Final whole-branch review (fix wave):
- **R-F1** `sliding_n` and `sliding_3track` model the sashes as three parts — `sash_left` (key + hook stile), `sash_mid` (count n-2, two hook stiles), `sash_right` (hook + key); 3-track `sash_fixed` / `sash_middle` / `sash_front` — so n sashes give 2 key + 2(n-1) hook stiles (spec 5.4 / 5.5) and each position has one family. `layout.sequence` orders them left to right (tracks alternate along it; 3-track `fixed_side: right` reverses it); the middle / right positions take the left sash's family while theirs is blank (`rule.familyFrom`), so a template saved at n = 2 prices an item with n = 3. n = 2 keeps sliding_2's per-family totals. [the drawing / tab naming of the middle sashes; the profile counts are the spec's]
- **R-F2** An input is fixed only when the type's `layout_params` contain that key (`model.fixedKeys`); otherwise it is editable in the template and, when estimator, on the item. Applied with R-12a. [nothing; this is the spec's section 4 reading]
- **R-12a** `casement_n` input `n` is `fixed_by_type` and `estimator` (บานเปิดข้างเดี่ยว pins n = 1). [the single-casement type shows an editable n]
- **R-F3** The "เส้นคู่ + ความยาวชิ้น" style prints each piece's cut length from the expansion (what costing prices) and omits the label where none is available and on decorative free-line strips; sliding_2's legacy drawing untouched. [a label missing on an unpriced piece]
- **R-F4** Hardware defaults stay fixed totals written at template creation, never following item values (an owner decision, below). [owner adds a per-item hardware rule later]
- **R-F5** A template whose kind no longer matches its type (or an unknown kind) shows a dedicated message naming both kinds instead of "reload"; the type form has no warning (templates are not loaded there) — the handover's check query covers it. [a less helpful message]

Also applied without a number (from the task reports): "เสร็จแล้ว" is stored per part key, so all sash instances of a part share one flag; an awning 2x2 shows 7 tabs (the ซอยกลาง part counts); changing an item's template resets its `layout_params`; `layout_params` is sent only when non-empty; the item form refuses to save when the params are refused by the layout (e.g. folding 0 + 0); the migration SQL test is `supabase/tests/layouts_all_types_test.sql`.

## Owner to confirm / open questions

Spec section 11 (the plan built to rulings; each is a data default, so a different answer is an edit, not a rebuild):
1. **R3** 3-track: which side is the fixed sash by default (built: left, mirrorable per item via `fixed_side`).
2. **R5** May an item override the template's curtain-wall cell picture, or is the picture fixed per template (one template per façade pattern)? (Built: the item may override; cells saved to `estimation_openings.layout_params.cells`.)
3. **Hanging door track length**: built as 2·W for one leaf; confirm for two leaves opening to both sides. (The drawn rail is 1.5W but costed 2W; the "ความยาวชิ้น" style prints no length on it, R-F3.)
4. **I4 / R-F4 — hardware never follows the item:** default hardware lines are fixed totals from the template's values at creation; an item that changes n / leaves / cells keeps the template's hardware quantities (a curtain wall template with default all-glass cells gets no awning hardware even if an item adds awning cells). Confirm this is acceptable, or ask for a per-item hardware rule.
5. **Hardware default counts** (now written into new templates; the `hardware` array of each layout file): sliding 2 rollers per sash + 1 lock per unit; 3-track 2x2 rollers + 3 tracks; 2+2 four rollers + 1 lock; awning / casement 2 stays (awning) or 2 hinges (casement) + 1 handle per sash; swing door 3 hinges + 1 handle per leaf, or (pivot) 1 door closer + 2 pivots per leaf; frameless door 2 patch fittings + 1 floor spring + 1 handle + 1 floor lock per leaf; hanging door 2 hanging rollers per leaf + 1 floor guide; folding door rollers 2·(ceil(nL/2)+ceil(nR/2)), hinges 3 per fold, frame hinges 3 per side, handle 1 per side; curtain wall 2 stays + 1 handle per awning cell; fixed_grid and frameless_wall none. Confirm or edit (spec asked: 3 hinges per leaf, 2 stays per awning sash, 2 rollers per sliding sash, 1 roller pair per folding pair).
6. **Series for types not in the Excel** (frameless types, bottom-rail door): which profile series should the defaults name.

Inferred or guessed in the build (from the ledger; please confirm):
7. `hanging_door` leaf stiles use `auto: 'track'` — inferred.
8. Free-line default families on `frameless_door` and `folding_door` (บังใบ, คิ้วบาน, ...) are guesses; the frameless hardware names (`patch fitting`, `floor spring`) are guesses. `fixed_by_type` on hanging_door / frameless leaves goes beyond the brief.
9. Curtain-wall sash families **บานหน้าต่างยูโร / คิ้วยูโร** are placeholders; the unitized family set covers only **Fe-Mullion / Int-Tran** — fill the rest.
10. Door leaf thickness = the sash class (R-9a); the door closer is 1 per leaf.
11. Swing-door beads คิ้วประตู: lengths built as stile height / leaf width with no end deduction (I5) — confirm against Excel sheet 6.
12. sliding_n / 3-track middle and right sashes follow the left / fixed sash's families until set (R-F1); a template made before the migration with no part rows now loads with blank families and is reported incomplete instead of priced from the Excel defaults (I7).

## Deferred minors (the final whole-branch review triages these; complete, not pretty)

Engine (partModel / partExpand / layoutExpr):
- `partnerEnd` legacy `(key, piece, end)` overload sniffs `typeof` and hard-codes sliding_2 — drop once the old tests may be migrated.
- `startModel` / `layoutOfModel` use `LAYOUTS[kind]` not `layoutOf` — a kind like `'toString'` gives a TypeError instead of `unknown_layout`; same for `setParams` with an unknown kind.
- Missing `cols` / `rows` param silently becomes 1 in grid `autoDed` (no issue raised).
- `overlapCount` result is not clamped >= 0.
- `isMitre` (partExpand) and `mitredPart` (partModel) duplicate the "part is mitred" check; `explainPiece` evaluates `ctx.isMitre(key)` twice.
- Mitre is read from the layout part's `corner` only — no per-model override.
- `setParams` does not reset ends whose `to.key` names a position it just disabled (shows as `no_butt_distance` / `both_butt`, not silent).
- `checkParams` maps every `evalExpr` error to `layout_params_invalid` (layout typos look like user input); `validateLayout` does not parse `enabled` / `validParams`.
- `jointsOf` recomputes `exprParams` per call.
- `vJoint` returns the first matching joint — `validateLayout` does not assert that every vertical key/end maps to exactly one joint for grid layouts.
- `startModel` / `setParams` do not clamp params to input min/max (only `defaultParams` / `coerceParams` and the UI do).
- `familiesWhen` is applied at `startModel` only (comment should say "start only").
- `validateModel` accepts `'mitre'` ends on any layout; `paramsFor` applies type fixed values twice (comment).
- Awning cells > MAX_PART_COUNT 10: sashes clamp to 10 while hardware uses the full count; rows x cols > 10 clamps silently — the UI should warn.

Layouts (data):
- `grid_n` duplicates the `grid_cols` line (a factory `gridAuto(param)` would remove it); `cwAuto` duplicates `gridAuto`; sash-rule constants repeated across `awning_grid` / `casement_n`; RAIL constants repeated in 3track / fixed_2.
- `validateLayout` lacks tests for the unknown-order-key branch and the panel-with-positions branch; it does not check `vEnd` in {0,1} / `vPiece` validity; the registry test skips `test_` / `t3_` kinds by name prefix.
- `symbolFor` swallows count-evaluation errors; casement tests assert `cut_style` only on `sash_top`.
- `pieceLabel` mirrors `pieceNames` but not `pos.labels` (untested mirrored path); `roles.hook` approximation (R-5a) uncommented; `LAYOUTS_HW` test helper defined after first use.
- `curtain_wall` symbol is keyed `sash` while the part key is `awning` (`symAt` workaround; re-key the data and `layouts.test.js:91`).
- `hanging_door` has no `hinge` input, so the outward symbol's hinge-left branch is unreachable.

Geometry / SVG:
- `symbolFor` dual return shape (a 4th arg changes the type) — a separate `drawingSymbol()` export would be clearer.
- No `esc()` helper in the SVG `text()` (nothing user-controlled reaches the SVG today).
- `defaultThick` has per-kind branches (a table would be data-driven); zoom fades all `hardwareMarks` regardless of part; `sliding_2` glass rect inset is approximate (returned, not drawn); hook overlap 50 (`th(hook)`) vs the mockup's fixed 40; two no-throw-only tests; symbol kinds `arrow` / `split` go beyond the brief's enum.
- `slideDir` hard-codes the three direction literals instead of importing `SLIDE_DIRECTIONS`.

Persistence:
- `defaultParams` / `coerceInput` historically treated only `typeof number` as numeric (now coerces numeric strings; keep serialising numbers).
- `isPlainObject` is defined twice (`catalogTypeForm`, `layoutRegistry`).
- `BomTemplates` resolves the type from `types` at mount (assumes loaded; the save-time guard still catches a mismatch).
- Save remains delete-then-insert and non-atomic (as in the part-editor arc).

UI:
- `no_profile_width` wording differs between `reasonText.js` and `partEditorView` `ISSUE_TEXT`.
- `package-lock.json` root version resync 1.0.0 -> 1.20.39 (noise); new dev deps `jsdom`, `@testing-library/react`, `@testing-library/dom` (controller may prefer another approach).
- `PartEditor` draft is not cleared when the `model` prop is replaced; the tablist lacks arrow-key navigation / `aria-controls`.
- Two creation tests + the payload test never ran RED; `PARAMS_HINT` wording is folding-specific for any `layout_params_invalid`.
- The `else if (form._hadLayoutParams)` branch in `buildOpeningPayload` is mostly dead; the template-switch reset is not DOM-tested; an item cannot be returned to "no own params" once it has some (equal values are a no-op in costing).
- Mitre read from the layout part corner only (see engine) — no per-model override in the editor.

Hardware:
- A retry after a partially failed create skips (or wipes) the default hardware silently; skipped rows only `console.warn`.
- `sashCount` re-evaluates `part.count` instead of reading the model; the plan is computed twice in `BomTemplates`; no component test of the create path.

SQL / process:
- `run-layouts-tests.sh` relies on `set -e` rather than grepping for `PASSED`; the test notice text is `layouts_all_types: TEST PASSED`.
- The `estimation_openings_layout_params_obj` CHECK is not exercised by the SQL test (column existence only).
- `task-1-report.md` and `run-layouts-tests.sh` are force-added to git inside the ignored `.superpowers/` (no tracked precedent) — decide whether to untrack the report.
- Commit trailers of Tasks 9 and 10 name `Claude Opus 5.5` (the model that did the work), not the session's usual line — cosmetic.

## Deferred items from the spec (not built)

- **Sealant quantity** from `jointCount` (`frameless_wall`) is computed but not priced.
- **Spandrel `panelCells`** is exposed by `layoutCells` but not priced (the infill line is a later task).
- **Hardware pricing** beyond the default counts: the lines are written with unit price 0 and no part; the owner picks the `alu_parts` family and price.
- **Add-ons** (the parent spec `2026-10-12-bom-template-by-type-and-addons-design.md`) on top of these layouts.
- Add-on combinations and the parts/CAD preview styles remain legacy for part-model templates (see the part-editor arc).

---

# Inline add-ons + sliding_2 options handover (2026-10-15)

Plan: `docs/superpowers/plans/2026-10-15-sliding2-addons.md` (spec: `docs/superpowers/specs/2026-10-12-bom-template-by-type-and-addons-design.md`, as amended by the plan's rulings). Mockups: item form https://claude.ai/artifact/Lj7rVrfvoYahQ2cEVZXGdw (v2, owner thread resolved); template editor mockup v12. Branch `feat/alu-cost-catalog`, plan commit `ae999a91`, code commits `a4585321..1ea35071` (17 commits). Suite 2218 -> 2431 passing (163 files), build OK. **Not merged, not pushed, nothing deployed, and no agent ran any SQL.** Nothing here has been clicked on real data (no live check of the item PreviewPanel or an attachment PDF with a real item).

## What was built

- **Migration `supabase/migrations/2026-10-18-01-item-addons.sql`** (additive, re-runnable): tables `bom_template_addon_pieces` (piece sets per template, keyed by mode / kind / position, `note` <= 120 chars) and `estimation_item_addons` (the item's add-ons, including the `align` column: `'start'` / `'end'`, AO-13) with RLS. SQL test: `supabase/tests/item_addons_test.sql`, runner `.superpowers/sdd/2026-10-15-sliding2-addons/run-addons-tests.sh`.
- **Libs:** `src/lib/addonModel.js` (layout, dims, piece-set defaults, validation, labels), `src/lib/addonExpand.js` (`expandAddons` -> attach units, merge overrides / sideButt / components / notes, glass, issues), `src/lib/addonSave.js` (`pieceSetsToRows`, `saveAddonPieces`, `saveItemAddons`, mm->m at 6 dp).
- **Engine:** `bomEngine.js` honours `fixed_length_mm` on components; `partExpand.js` `expandParts({ overrides, sideButt })` (family / fixed-length override per position, AO-10) plus rule `minus` / `plusWidth` (S-1); both are byte-identical when absent.
- **Costing:** `openingCost.js` `costOpening` returns `addonBoms` / `addonMerge` (attach units are priced in the same item, AO-3; merge add-ons grow the main unit's extras envelope); roll-ups widened to include them: `priceStructure.js`, `projectBom.js`, `src/pages/estimation/projectBomHelpers.js`, `providerCompare.js`; `reasonText.js` has the new issue texts; `openingPayload.js` never writes legacy add-on columns for new add-ons.
- **Hooks:** `src/hooks/useItemAddons.js`, `src/hooks/useTemplateAddonPieces.js` (wired in `Estimation.jsx` and `BomTemplates.jsx`).
- **Template UI (sliding_2 only):** `src/pages/bomTemplates/addon/` (`AddonBox`, `AddonZoom`, `AddonPieceTable`, `AddonEffects`, `addonView.js`, `addonTemplateGlue.js`) mounted in `PartEditor.jsx` / `PartPreview.jsx` / `PartSidePanel.jsx`; styles appended to `partEditor.css`; `partSave.js` saves the piece sets with the template. Golden render fixtures `partEditor-sliding2*.html` pin the editor without add-ons.
- **Item form:** `src/pages/estimation/ItemAddons.jsx`, `itemSave.js` (`addonSavePlan` refuses to write while the saved list is loading or failed, so it can never wipe rows), `itemForm.js` (`addons`, `convertLegacyAddon`, AO-7 validation), `ItemModal.jsx`, `useItemModel.js`, `ItemCostSummary.jsx` (one line per add-on).
- **Drawings / signature / attachments:** `partPreviewSvg.js` `partSvgString({ addons })` and `partViewBox` (shared outline, separate attach frame, moved dimension lines, "รวม W x H มม."), `PreviewPanel.jsx`, `itemPreviewSignature.js` `addonSignature` (so a drawing goes stale when add-ons change). The no-add-on drawing is still byte-identical (sha256 pin).
- **sliding_2 options (S-1):** `src/lib/layouts/sliding_2.js` + `layoutRegistry.js` + `projectDefaults.js`: inputs `door`, `one_fixed`, `fixed_side`; new hardware defaults; position ธรณีกันบานเลื่อน (sill guard).

## SQL — the owner runs these (agents never ran any), one command per message, both BEFORE the code deploy

Order matters: **the sliding_2 options make every sliding_2 template save write `bom_templates.layout_params`, a column created by `2026-10-17-01-layouts-all-types.sql`. The code must not ship before 2026-10-17-01 is applied**, or every sliding_2 template save fails. (Project notes saying that branch's migrations are already on CHANG were not checked live; the dry-run below shows the truth.) The two migrations are otherwise independent of each other.

1. `! bash .superpowers/sdd/2026-10-13-part-editor-layouts-all-types/run-layouts-tests.sh` (dry-run; expect `LAYOUTS TESTS PASSED`, `applied = 0, leftover = 0`)
2. `npx supabase db query --project-ref kntspldhvcjeaubtqtkn --linked=false -f supabase/migrations/2026-10-17-01-layouts-all-types.sql`
3. `! bash .superpowers/sdd/2026-10-15-sliding2-addons/run-addons-tests.sh` (dry-run; expect `ADDONS TESTS PASSED`, `leftover = 0`)
4. `npx supabase db query --project-ref kntspldhvcjeaubtqtkn --linked=false -f supabase/migrations/2026-10-18-01-item-addons.sql`

Then deploy only per `.claude/skills/chang-ship/SKILL.md`. 2026-10-18-01 now adds `align` itself when the table already exists without it (`ADD COLUMN IF NOT EXISTS` + a guarded, same-named CHECK `estimation_item_addons_align_check`), so a re-run is safe.

What breaks if a migration is missing when the code ships (from the whole-branch review):
- **If 2026-10-17-01 is missing:** sliding_2 template saves fail at `bom_templates.update({ layout_params })`, and items with the new options fail to save.
- **If 2026-10-18-01 is missing:** both add-on loads fail, every layout_kind item shows `addon_not_loaded`, provider compare marks them incomplete, add-on editing is blocked; costs still compute.

## Final review fixes (2026-10-15, after the whole-branch review)

- **I-1** Default 2·butt deductions were 0 in production (bars about 76 mm too long). Assigning / changing a set's side family in the template zoom (attach `frame_side`; merge `ao_frame_side`, else `ext`) now fills every 2·butt row still at 0 (attach frame_top / frame_bottom / mullion / rail; merge divider / ao_bead / ao_frame_far / mullion / rail) with 2·butt of that family at the editor's test series (`addonModel.fillDefaultDeductions`). At cost time a costed 2·butt piece still at 0 while the side family has a butt > 0 raises the new issue **`addon_deduction_zero`** ("ระยะหักของชิ้นช่องแสงยังเป็น 0 ตรวจใน template"), also shown as a chip on the zoom table row, so a 0 never passes silently. Rows the owner already set to a non-zero value are never touched.
- **I-2** Attach units no longer inherit the main template's grid (`grid_vertical_mullion_family`, `grid_horizontal_rail_family`, `grid_row_weights`): only the expander's mullion / rail bars are priced.
- **I-3** Add-on loads chunk ids (100 per request) and page each chunk (`fetchAllRows`, ordered by id).
- **I-4** The Estimation page keeps the last loaded add-on maps through a refetch (no plain-cost flash); send-to-quotation is disabled with "กำลังโหลดข้อมูลช่องแสง" while either map loads.
- **M-1** Migration re-runnable for `align` (above). **M-2** An existing item missing from a loaded add-on map is "not ready" in the item form (no seed, no save).

**Owner data check (I-2 trigger):** before deploy, look for live sliding_2 templates whose Grid mullion / rail families are filled (BOM template form, Grid section). Before this fix those families were added again on top of every attach add-on's own bars; after it they price the main unit only. Also expect `addon_deduction_zero` on any piece set saved earlier with 0 deductions: open the zoom and re-pick the side family (or type the deductions).

## Owner click-through list (nothing has been clicked on real data)

1. Template editor: เปิด template ชนิด sliding_2 -> ในกล่องช่องแสงกด "+ เพิ่มช่องแสง" -> เลือก ร่วมวงกบ, ตำแหน่งบน -> คลิกที่ช่องแสงนั้นให้เปิดภาพขยาย -> ที่แถว ext กำหนดโปรไฟล์ กล่องร่องวิ่งยาว ให้ เฟรมบานหลักข้างช่องแสง -> ในตารางต้องเห็น เฟรมข้าง ยาว 1600 และหมายเหตุ ตบเรียบ -> เพิ่มช่องแสงแบบ แยกวงกบ อีกอัน -> บันทึก template -> ปิดแล้วเปิดใหม่ ค่าที่แก้ต้องยังอยู่ (หมายเหตุ: หน้านี้ต้อง reload หน้าหลังบันทึกชุดชิ้นส่วนก่อนหน้า Estimation จะเห็นชุดใหม่).
2. Item form: เปิดรายการที่ใช้ template นั้น -> เพิ่มช่องแสงแบบเดียวกันสองอัน -> ดูบรรทัดต้นทุน (แต่ละช่องแสงมีบรรทัดของตัวเอง ยอดรวมต้องเท่ากับผลรวมบรรทัด) และภาพวาด (โครงร่วมกัน, กรอบแยก, ขนาด "รวม ... มม.") -> บันทึก -> เปิดซ้ำ ต้องได้ช่องแสงครบ -> ออกใบแนบ PDF (attachment) ดูว่าภาพมีช่องแสงและไม่ขึ้น "ภาพเก่า".
3. รายการเก่าที่มีชุดต่อเติมแบบเดิม (legacy add-on): กด "แปลงเป็นช่องแสงแบบใหม่" -> ต้องได้ช่องแสงแบบแยกวงกบ 1 อัน ขนาดตรงกับของเดิม และชุดเดิมถูกล้าง; ถ้ามีทั้งเก่าและใหม่พร้อมกันต้องบันทึกไม่ได้ (AO-7).
4. Type form: เลือก ประตู + เลื่อน 1 ฟิก 1 (และเลือกด้านฟิก) -> template ใหม่ต้องมีแถวฮาร์ดแวร์ ลูกล้อ 2 / มือจับล็อค 1 / กุญแจ 1 ต่อชุด และชิ้นส่วน ธรณีกันบานเลื่อน; เลื่อนสวน (ค่าเริ่มต้น) ต้องได้เหมือนเดิม.

## Data the owner must enter before the numbers are real

Defaults are data, not blockers (AO-12); any family left blank prints `no_profile_family` and is not priced.
- **Profiles per piece set** (open the zoom of each add-on kind/side): กล่องร่องวิ่งยาว (ext substitution), เฟรมข้างไม่ติดกล่อง (overlay side), คิ้วเท (bead on a top add-on), เฟรมด้านไกล (far frame), ซอย (mullion for multi-row / multi-column glass).
- **Butt distances** of every family used in those sets, including กล่องร่องวิ่งยาว (the sash deduction reads it, AO-10) and ซอย (divider qty > 0 on left/right uses it, AO-2).
- **ธรณีกันบานเลื่อน family** and the **width of เสากุญแจ** (the sill-guard length uses `w[เสากุญแจ]`).

## Rulings made in this arc (owner may overturn; the "if wrong" cost is in brackets)

From the plan:
- **AO-1** Merge add-on: the main frame's far member keeps its length; the two members beside the add-on are cut once at the overall length via an override, no extra bar. [piece lengths; data/override fix]
- **AO-2** With a merge add-on on side S and a divider row qty > 0, the sash deduction on S uses the divider's butt distance; divider qty 0 leaves it unchanged. [sash deduction on left/right; data]
- **AO-3** Attach add-ons are priced inside the same item and drawn in the same attachment, using the main template's rates (waste, labour, silicone, felt) and the item's infill; no hardware rows. [attach price slightly off; rates are per template]
- **AO-5** Limits: <= 6 add-ons per item, rows <= 6, cols <= 12, len/thick in (0, 20] m. [constants]
- **AO-7** An item with a legacy add-on cannot also have new ones; legacy wins in costing with `addon_conflict`; the form offers แปลงเป็นช่องแสงแบบใหม่. [one form rule]
- **AO-9** (owner) Sliding top/bottom merge: the main side profile is substituted (เฟรมข้างติดกล่อง -> กล่องร่องวิ่งยาว) and cut at `th`; the add-on gets 2 overlay side pieces; no divider; the main's facing member stays with a machining note (ตบเรียบ / ตบร่อง); a top add-on adds a bead (คิ้วเท). Piece sets are keyed by (mode, kind, position); left/right defaults follow the spec. [piece-set defaults; data]
- **AO-10** A merge `ext` row with a family means substitution of the main position's line 0; the substituted family's butt distance feeds other pieces' automatic deductions; family null keeps the main's. [deductions; data]
- **AO-11** Per-piece machining notes (<= 120 chars) show in the effects table and as a bracket suffix on the BOM `role_name`; never change a price. [cosmetic]
- **AO-12** Open questions are editable defaults: overlay side length `h`, bead length `len - 2*b[overlay side]`, bottom add-on bead qty 0, far frame `len - 2*b[overlay side]` family null, awning add-ons = fixed pieces (no sash pieces yet). [data edits]
- **AO-13** (owner, item-form mockup) Add-ons are placed flush with one end of the whole stack (เสมอบน/ล่าง, เสมอซ้าย/ขวา) via `align`; `offset_mm` stays as an optional shift, hidden in the item form. [one column + one select, default 'start']
- **S-1** (owner 2026-10-14/15) sliding_2 inputs `door`, `one_fixed` (0 เลื่อนสวน / 1 เลื่อน 1 ฟิก 1), `fixed_side`; hardware defaults ลูกล้อ `4 - 2*one_fixed`, มือจับล็อค `2 - one_fixed`, กุญแจ `door*(2 - one_fixed)`, all per unit; new position ธรณีกันบานเลื่อน; the `sliding_1_fixed_1` draft is folded in. [defaults for new templates only]

From the ledger (controller rulings):
- .superpowers is not git-ignored in this worktree; ledger / briefs stay uncommitted. [stray scratch files in a commit, trivially reverted]
- Task 3: `ext` length = envelope x factor - deduction (other pieces are (ref - deduction) x factor); keep as the brief says. [an ext factor other than 1 gives a slightly different length; data-fixable]
- Task 4: mm -> m is mm/1000 rounded to 6 dp (no integer rounding of mm), so 1723.8 -> 1.7238. [none]
- Task 5: roll-ups widened to sum attach units (otherwise dropped). [a roll-up double counts; caught by review]
- Task 5: attach units are frames and count in `openingExtras` units; merge add-ons grow the main unit's envelope to tw x th. [sealant / fixing-point lines over or under by the add-on frame]
- Task 6: the add-on UI is gated to sliding_2 (other kinds' piece defaults are spec-only, unreconciled with Excel). [a one-line gate change]
- Task 6b: add-ons on the perpendicular axis count in the stack for `checkRange` (consistent with the drawing); `align` kept when the position changes. [range warnings]
- Task 7: legacy AddonFields shown only for items that already have a legacy add-on on part-editor templates (new items use the new add-ons). [owner can still create legacy add-ons on flat templates]
- Task 9: the frozen `partModel.test.js` params expectations were narrowly edited (the freeze protects pieces / lines / ends / expand / drawing, not the params object), with a new test proving the snapshot minus params is unchanged. [params-shape regression on sliding_2 templates saved before the options; omit-when-absent keeps old rows loading]
- Task 9: `sill_guard` sits on the frame part, 1 piece per unit (the brief's `part: 'sash'` was a slip); the drawing keeps both slide arrows under เลื่อน 1 ฟิก 1. [a drawing detail]
- Also: `addon_not_loaded` shows on every layout_kind item with a load error (honest: cannot know which have add-ons); items without an id are exempt.

## Deferred / not built

- Type picker wizard, reference uploads, clone of add-on sets/items.
- Awning add-on sash pieces (awning add-ons cost as fixed; the form notes "ชนิดกระทุ้งตอนนี้คิดเหมือนติดตาย").
- Left/right profile rulings for merge add-ons (defaults follow the spec; owner rulings pending).
- Bead on bottom add-ons (qty 0 by default).
- Add-on UI gated to sliding_2 (other layout kinds not yet).
- Drawing arrows under เลื่อน 1 ฟิก 1 (both arrows drawn, `fixed_side` does not affect the picture); drawing overrides (ext lengths, family changes) are not shown.
- Estimation page does not reload piece sets after saving them in the editor (reload the page).
- The part editor's deduction field (`lineDeductions().pre`) omits the sill guard's after-factor term (total and ที่มา are correct).
- Hardware ลูกล้อ is now per unit (fixed expression); it no longer follows an edited sash count on new templates.
- The wording differs from the mockup: ช่องแสง / ร่วมวงกบ / แยกวงกบ vs Add-on / มีผลกับ type หลัก / แปะเพิ่ม.

## Deferred minors (complete, one line each)

- T1: SQL test 5 re-runs a pasted copy of the DO block instead of the migration file (could drift).
- T1: reject cases assert SQLSTATE only, not the constraint name.
- T2: `pieceQty` returns null for rule 'fixed' with `qty_fixed` null (expander coerces with `Number()||0`).
- T2: offset message wording; `refValue` of an unknown ref is 0; thin test edges (offset layout, left main_facing note null).
- T3: NaN can reach `merge.overrides.lengthMm` on malformed add-on dims (contained: partExpand drops non-finite, `addon_out_of_range` raised); add a `Number.isFinite` guard.
- T3: null `deduction_mm` on a row is silently 0 (`validatePieceRows` rejects < 0 only).
- T3: attach glass butt fallback 0 without an issue when frame_side qty is 0; ext glass-butt lookup ignores ext qty; fixture built at describe time.
- T3: a family override does not flow through `familyFrom` chains (sliding_n middle sashes); sliding_2 unaffected, matters for the per-type rollout.
- T4: `saveAddonPieces` inserts rows as passed (callers must use `pieceSetsToRows`); `pieceRowsToSets` strips instead of whitelists.
- T4: hooks return a fresh `{}` each render while loading (use a module-level EMPTY); `useTemplateAddonPieces` has no refetch.
- T5: refetch may flash plain totals if `useQuery` clears data on refetch (check after Task 7's refetch).
- T5: conflict test relative; attach units reuse the main template's grid / labour / silicone / felt rates.
- T5: `mainFrameUnit` envelope can be NaN on bad merge dims (add a finite fallback to plain size); envelope includes flagged merge add-ons.
- T6: inside-view zoom not mirrored (mockup neither); qty-0 pieces not drawn; effects table 3 columns vs 4.
- T6: unknown ref shows the first option; delete closes the zoom; glue tests written after the code.
- T6: load-failed text may show twice in the callout (LOAD_FAILED + saveError).
- T6b: shuffle test mostly skipped by `continue`; `checkRange` counts attach add-ons in the perpendicular stack (kept).
- T6b: migration `align` column inside `CREATE TABLE IF NOT EXISTS` has no re-run note (the final fix wave adds `ADD COLUMN IF NOT EXISTS align` + comment).
- T7: default new add-on position บน vs mockup ล่าง; "ใหม่" tag / box styling; range warning wording; merge add-on shown as one glass line (agreed).
- T7: ItemModal smoke add-on test does not assert absence of `undefined`; snapshot / signature ignored add-ons until Task 8 (done there).
- T7: `addonSavePlan` `loading` arg never passed by ItemModal (page maps loading to an undefined map); no component-level test of the effect-driven recovery path.
- T8: no garbage-add-on test for `partSvgString`; inside-view mirror test asserts only the viewBox.
- T8: `addonGeometry` computed twice per render; `AO_NUM` vs `drawableAddons` coerce negatives differently (signature over-sensitive).
- T9: stale frozen-test title ("plus params: {}"); editor deduction field omits the sill guard after-factor term.
- T9: 2026-10-17-01 must precede the deploy (stated above); ลูกล้อ per unit no longer follows an edited sash count; drawing keeps both arrows under เลื่อน 1 ฟิก 1.

### Post-review changes 2026-10-15 (evening, live click-through on CHANG)

- **Migrations applied on CHANG**: `2026-10-17-01-layouts-all-types.sql` and `2026-10-18-01-item-addons.sql` (owner ran both after the dry-run scripts passed). Profile import datafix `supabase/datafix/2026-10-13-import-aluminium-calculation-xlsx.sql` also applied (209 profiles / 11 series / 17 glass under provider "ไฟล์ Aluminium calculation") after fixing its `tenants.name` lookup (the column is `company_name`); its dry-run script is `.superpowers/sdd/2026-10-15-sliding2-addons/run-profile-import-dryrun.sh`.
- **Live data created**: BOM template "บานเลื่อนสวน 2 บาน ทั่วไป" (sliding_2, families เฟรมบน / เฟรมล่าง / เฟรมข้าง / บานเลื่อนบน / บานเลื่อนล่าง / เสากุญแจ / เสาเกี่ยว of series ทั่วไป, hardware defaults ลูกล้อ 4 + มือจับล็อค 2, no add-on piece sets yet) and a TEST item W-01 in project PARLLEL TROPICAL with one merge/top add-on. Delete W-01 when done.
- **Ruling change (owner): `door` is chosen per item.** sliding_2 `door` is now an estimator input (the catalogue type can still pin it). To make the choice real, `costOpening` passes the template's hardware rows through `hardwareDefaults.itemHardwareRows(rows, baseModel, itemModel)`: the layout hardware is evaluated with the template's params and the item's, and only the **delta** is applied — an owner-edited quantity survives, a line the template never had (กุญแจ/มือจับเรียบ on a window template) is added unpriced (`no_hardware_price`), a line reaching 0 is dropped, hand-added rows are untouched. Side effect: ลูกล้อ / มือจับล็อค now follow เลื่อน 1 ฟิก 1 per item (the earlier deferred minor is closed). Verified live: ประตู ticked → กุญแจ ×2 appears; เลื่อน 1 ฟิก 1 → ลูกล้อ ×2, มือจับล็อค ×1, กุญแจ ×1, ธรณีกันบานเลื่อน line.
- **Still open from the click-through**: imported profiles have no `width_mm` / `butt_distance_mm` (every butted end warns "โปรไฟล์ที่ชนไม่มีระยะชน", deduction 0 — ธรณีกันบานเลื่อน shows 900 instead of 853.8 until widths exist); no finish / price per kg (every line "ยังไม่เลือกสี"); series ทั่วไป is not linked to type บานเลื่อนสวน 2 บาน (yellow banner); the sliding_2 template editor still hides the layout inputs panel (PartInputs), so the template's own default for door / one_fixed is only settable on the catalogue type.
- **Ruling (owner, same evening): drawings with add-ons carry three dimension levels** — main unit, each add-on, whole unit (commit 63f4088e, `partPreviewSvg.addonDims`): a chain along each axis on the first line (main + every add-on on that axis, each with its own size) and the whole unit on a second line when the chain has more than one segment; an axis without add-ons keeps one line. Applies to the item preview, the saved preview image and the attachment pages (all go through `partSvgString`). Drawings without add-ons are byte-identical. Not dimensioned: a top/bottom add-on shorter than the main width (its own length is not on the chain; default length = main width).
- **Rulings (owner, same evening, commit 96b8520d):** (a) เลื่อน 1 ฟิก 1 marks the fixed sash with an **F in the glass corner** (sliding_2 drawing; the millimetre drawings' existing F moved from pane centre to corner); (b) add-on grid dividers are drawn **as wide as the frame member** (mullions through, rails between); (c) new **fake dividers (ซอยหลอก)** per add-on, `fake_rows` × `fake_cols` per glass pane (1..12, 1 = none), drawn at **half the frame width** — drawing only, no BOM piece and no price yet (the form says so). Needs migration **`2026-10-18-02-item-addon-fake-grid.sql`** (two columns, additive) — dry-run `.superpowers/sdd/2026-10-15-sliding2-addons/run-fake-grid-tests.sh` passed on CHANG; **apply before deploying this code**, else saving an item with add-ons fails (the insert names the columns). Preview signatures include the fake fields only when set, so previews saved before stay valid. Still not marked: the slide arrows (none in the sliding_2 drawing) and the fixed sash in the quotation description text.
