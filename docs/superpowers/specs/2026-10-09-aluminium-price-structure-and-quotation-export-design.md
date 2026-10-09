# Aluminium price structure and quotation export (Phase 3) — design

Date: 2026-10-09 · Branch: `feat/alu-cost-catalog` · Status: **draft for the owner's review** (no code, no plan yet)

Mockup (owner-reviewed, v14): https://claude.ai/artifact/PJqo9xMxMGyxvAw8LbYMvh — source of truth for layout and wording. Reference workbook: `price_structure.xlsx` (sheet `ELSY`), sample PDF `SAMPLE_PRICE_STRUCTURE.pdf` (could not be read in this environment; the workbook was used).

## 1. Goal

From an estimation project whose items already carry a cost (Phase 2b), produce the project's **price structure** (cost → waste → profit → transport → PM → rounded selling price), send it to the **Quotation** module as a draft quotation with optional drawings attached, keep a reproducible record of what was offered at each revision, and after the customer signs, **pull the negotiated prices back** to see the real profit per item.

Success = the owner can open a project, see the same numbers his ELSY workbook gives, press one button to get a quotation (one line per item, A4 attachment pages), change prices and re-send under his revision rule, and after signing compare agreed prices with the offer item by item.

## 2. Owner decisions (all from the owner, 2026-10-09)

1. One quotation line per item: an `item` row (name, unit, quantity, unit price, total) followed by an `item_description` row (size, series, colour, glass), the structure the Quotation module already uses. Cost is never shown to the customer.
2. Waste, profit, transport, PM and the rounding step are set **per project**. Profit may be overridden **per item** (untick "follow the project" on the row). (Overrides an earlier "project only" answer.)
3. Four new per-item costs, entered as an amount per set in the item form: Fire Barrier, Bracket, bend aluminium, bend glass.
4. Revision rule (estimation side only): the first send is revision 1; pulling the quotation back to edit, from the quotation itself or by pressing "update price" in the price structure, makes it revision 2, and it stays revision 2 however many times it is edited until it is sent again. **The Quotation module's own page is not changed** (its counter bumps on every saved edit after the first send; this difference is recorded in §9).
5. After the customer accepts, a button pulls the agreed prices back into the price structure to compare with the offer: per-item final price and the real profit % against the % that was set.
6. Attachment pages: header identical to the quotation (subtitle "แบบแนบ"), page numbers continue the quotation's numbering, A4, 4 items per page in a 2 × 2 grid, outside and inside views in one frame with the set's dimensions, then aluminium / glass / hardware set / hardware lines, then a hardware-set schedule (what each set contains, with a picture per part) and the aluminium colours used.
7. Hardware sets: when a project uses several brands, each item shows its hardware-set name; the schedule at the end explains what each set contains.
8. Aluminium colour is shown per item as a square swatch plus the colour name; a legend at the end lists the colours used and the items.
9. The price-structure table shows a SUMPRODUCT row (cost × quantity per column), pie charts (cost by category; selling-price composition), total aluminium weight (net and with waste), the real column names from ELSY (no letters V–Z), hides cost columns that are zero for every item, shows the glass code with a hover (type, price per m² and per ft²), and has a clickable text for every tick box.
10. Sub-numbering (owner, round 2): every export/update from the price structure gets a running sub-number inside its revision: before the first send `R1-1, R1-2 …`; after a send and a pull-back `R2-1, R2-2 …` until sent again; then `R3-1 …`. The sub-number resets to 1 with each new revision.
11. Split pricing is offered: a tick box "แยกค่าของ/ค่าแรง" with an adjustable ratio next to it, default 80 / 20.
12. The export must behave as a plain export of the price structure into a normal quotation: everything is the same as a quotation created by hand (same defaults for notes, terms, bank, VAT, validity); only the attachment pages are added at the back.
13. Every catalogue table (aluminium profiles, glass/infill types, silicone/felt and other sundries, hardware parts and sets) carries an attached picture; the attachment pages use these pictures.
14. Isolation: estimation is FacadeX-only. Nothing in the standard Quotation module may change for tenants without the `estimation` module; additions there must be optional and tested.

## 3. Scope

In scope: price-structure calculation and screen; four new item costs; per-project factors and per-item profit override; "send to quotation" (create draft, update lines on later sends, revision 2 rule); attachment pages and A4 pagination for the quotation print/PDF; snapshots of what was offered; "pull agreed prices" comparison.

Out of scope (later): CAD/DXF drawing export; importing quotations created outside the estimation module; changing the Quotation page's own revision counter; invoices from the price structure.

## 4. Calculation (pure library `priceStructure`, tested against ELSY rows)

Per item, per set (all inputs already computed by `costOpening`):

- `V` (รวมต้นทุน) = aluminium + hardware + glass + labour + Fire Barrier + Bracket + bend aluminium + bend glass + supplementary (silicone, felt, extra lines as today). Unresolved items are excluded and flagged, never counted as 0.
- `W` (เผื่อเสียเศษ) = aluminium cost × project waste %.
- `X` (กำไร) = `V` × profit %, where profit % is the project's unless the item overrides it. Profit is **not** applied to `W`.
- `Y` (ราคาขาย) = `V` + `W` + `X`.
- `Z` (ค่าขนส่ง) = project transport total × (`Y` × quantity) ÷ Σ(`Y` × quantity), divided by the item's quantity.
- PM = ceil(`Y` × PM %) (whole baht, as the workbook's ROUNDUP).
- Price per set (ราคาต่อชุด) = `Y` + `Z` + PM; **selling price (ราคาขายจริง)** = price per set rounded **up** to the project's step (default 100); price per m² = price per set ÷ width ÷ height.
- Line total = selling price × quantity. Project total = Σ line totals (before VAT).
- Weight: aluminium weight per set = Σ `weight_kg` of the aluminium lines; project total = Σ weight × quantity; "with waste" = × (1 + waste %).
- Aggregates: SUMPRODUCT per column = Σ(column × quantity); pies use those sums.

Real profit after negotiation (§8): `(agreed net price − (V + W + Z + PM)) ÷ V`, same base as the set profit %. Agreed net price = agreed unit price − that item's share of any bill-level discount (allocated pro rata to line totals). If the quotation's prices include VAT, divide by 1.07 first.

Rounding of money to 2 decimals only at display; calculations keep full precision except the two explicit roundings above.

## 5. Data model (new migrations, all additive and nullable; the owner applies them)

`2026-10-14-01-price-structure.sql` (name provisional):

- `estimation_projects`: `waste_pct`, `markup_pct`, `pm_pct`, `transport_total` (numeric ≥ 0, nullable), `round_step` (numeric > 0, default 100). Defaults for a new project come from `estimation_settings` (new nullable columns `default_waste_pct`, `default_markup_pct`, `default_pm_pct`, `default_round_step`), seeded once at creation; changing the settings never alters existing projects.
- `estimation_openings`: `fire_barrier_cost`, `bracket_cost`, `bend_alu_cost`, `bend_glass_cost` (numeric ≥ 0, nullable; NULL = none), `markup_pct` (nullable: NULL = follow the project).
- `infill_types`: nullable `code` text (glass code, e.g. TP6), shown in the price structure and the attachment.
- `estimation_quotation_links` (one row per project that has been sent): `project_id` (unique), `quotation_id` (FK → `quotations`, ON DELETE SET NULL), `attach_enabled`, `attach_mode` (`pages|thumb|both`), `attach_view` (`both|out|in`), `last_pushed_revision`, `last_pushed_at`.
- `estimation_quotation_lines`: `project_id`, `opening_id`, `item_row_id` and `description_row_id` (the generated `quotation_items` ids, ON DELETE SET NULL), unique `(project_id, opening_id)`. This is how a re-send finds the rows it owns; rows the user added in the quotation are never touched.
- `estimation_price_snapshots` (append-only): `project_id`, `quotation_id`, `kind` (`sent|agreed`), `revision`, `price_as_of`, `factors` jsonb, `items` jsonb (per item: costs by category, V, W, X, Y, Z, PM, price per set, selling price, quantity, profit % used, weight, unresolved reasons), `totals` jsonb, `created_at`.
- `estimation_quotation_links` also gets `split_enabled` (bool, default false) and `split_material_pct` (numeric 0–100, default 80).
- `estimation_price_snapshots` also gets `sub_no` (int ≥ 1): the running number inside `revision` (revision NULL means before first send, shown as R1-n). Label shown = `R{revision_or_1}-{sub_no}`.
- Pictures: nullable `image_path` text on each catalogue table (aluminium profiles, `infill_types`, sundries such as silicone/felt wherever they are stored, `alu_parts` for hardware and hardware sets), plus one private storage bucket `estimation-images` with tenant-prefixed paths and storage policies gated like the estimation tables (admin/owner + estimation module). The plan must first list exactly which tables hold profiles, sundries and sets. Pages without a picture show the drawn placeholder icon.
- All new tables: RLS loop `is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('estimation')`, `tenant_id DEFAULT current_tenant_id()`, tenant index.

The only touch on a standard table is a **foreign key from an estimation table to `quotations`** (and to `quotation_items`); no column is added to `quotations` or `quotation_items`.

## 6. Screens (see the mockup, tabs 1–5)

- **Project page → tab "โครงสร้างราคา"**: factor panel, items table with the columns above (hidden when empty for the whole project), per-row profit toggle, SUMPRODUCT footer, two pies, glass hover, project total, button "ส่งไปใบเสนอราคา" / "อัปเดตราคาไปใบเสนอราคา".
- **Item form**: four new cost fields, always visible in the item form (blank = none).
- **Send dialog**: customer, site, dates, validity (default 30 days), attachment options (mode, views), list of lines to create, warning for items without a saved preview; blocked while any item is unresolved unless the owner explicitly skips those items.
- **Quotation print/PDF** (existing page, optional addition): continues page numbers into attachment pages; see §7.
- **Revision tab content** (mockup tab 4): the state machine and the "update price" diff dialog.
- **Compare after signing** (mockup tab 5): button "ดึงราคาที่ตกลงกลับมาเทียบ", table per item, project summary.

## 7. Sending, revisions and the printed document

### 7.1 First send

Creates a `quotations` draft (client required; `site_id`, `date`, `valid_until`, VAT and payment terms/notes from the same defaults the Quotation "new" form uses; `has_vat = true`, prices exclude VAT, `pricing_mode = 'combined'`, or `'split'` when the split box is ticked), then for every item two `quotation_items` rows in order: `item` (description = "NO name", unit "ชุด", quantity, `unit_price` = selling price, `line_total`) and `item_description` (text from the project's description format; quantity 0, price 0), mirroring exactly what the Quotation page itself inserts. Writes the link, the line map and a `sent`-kind snapshot with `revision = null` (draft). Draft = no revision yet.

Split mode: with the box ticked, each line's selling price is divided into material = price × material % (default 80, adjustable beside the box) and labour = remainder, written to `unit_price_material` / `unit_price_labor` with `unit_price` equal to their sum, so the line total never changes; rounding goes to the labour part. The ratio is stored on the link and reused on re-send.

### 7.2 Re-send ("update price")

State is read from the quotation, never kept twice:

| Quotation state when the button is pressed | What happens |
|---|---|
| draft, never sent | overwrite generated rows in place; no revision |
| draft, `ever_sent`, already pulled back | overwrite generated rows; revision unchanged (stays N) |
| `sent` or `accepted` (accepted needs an extra confirmation: invoices may reference lines) | snapshot the current content into `quotation_revisions` (same JSON shape the Quotation page writes, so its history view renders it), set status to `draft`, set `revision = revision + 1`, then overwrite generated rows |

Generated rows are updated in place by id (ids stay valid for any invoice rows pointing at them); items added to the project get new row pairs; items removed from the project delete their generated pair only if no invoice references it, otherwise the pair is kept and flagged. Rows the user added in the quotation are untouched. A `sent`-kind snapshot is appended for every push. Pressing "send" in the Quotation page itself is unchanged (it sets `ever_sent`).

The owner's rule therefore holds for every push from the estimation side: the revision number follows the table above, and each push also increments `sub_no` within that revision (R2-1, R2-2 …); a new revision restarts at 1 (R3-1). The label appears in the price-structure history, in the send/update confirmation, and in the footer of the attachment pages; the quotation's own revision field shows only the whole number. Edits made in the Quotation page keep that page's own counter (§9).

### 7.3 Print / PDF with attachments

`QuotationPaper` gains one **optional** prop, `extraPages` (array of ready-to-render page bodies; absent or empty for everyone else). When present it appends them after the last quotation page with the same header (title "ใบเสนอราคา", subtitle "แบบแนบ"), numbers running on (`n / total`, total including them). The Quotation page loads the extra pages only when the tenant has the `estimation` module and the quotation has an estimation link, so tenants without the module run no new query and render the document exactly as today (tested). The attachment content is built by estimation code from the saved double-line snapshot SVGs (`preview_svg_out/in`, never redrawn), the project's hardware package, and the colour list; 4 items per A4 page (2 × 2), hardware-set schedule and colour legend kept with their headings. In `thumb`/`both` mode a small thumbnail is added to the item row (optional `thumbSvg` per item). Pagination measures real heights (as the mockup does) and never splits an item frame.

## 8. Compare after the customer signs

Button on the price-structure tab, enabled when the linked quotation exists and has been accepted (or on owner request for sent). It reads the quotation's current item rows through the line map and header discount (`discount_amount` or `discount_pct`), computes agreed net price per item (§4), and appends an `agreed`-kind snapshot. The tab then shows, per item: offered price, agreed unit price, bill-discount share, agreed net, difference (baht and %), cost base (V+W+Z+PM from the **last sent snapshot**, so later catalog price changes do not rewrite history), set profit %, real profit %, difference in points; and a project summary (offered vs agreed total, reduction %, set vs real profit). Read-only: nothing in the estimate or the quotation changes. If lines were removed/added in the quotation after export, the table lists them as "ไม่มีในโครงสร้างราคา" / "เพิ่มในใบเสนอราคา" and excludes them from the profit calculation.

## 9. Known differences and risks

- **Revision counters differ**: the Quotation page bumps the revision on every saved edit after the first send; the estimation side follows the owner's rule. After an edit in the Quotation page the next estimation push does not bump again while the quotation is a draft.
- Writing into `quotations`, `quotation_items` and `quotation_revisions` from estimation code requires both modules; the button is hidden otherwise (UI) and the writes are refused by those tables' existing RLS (DB).
- Attachment pages add print weight to a standard component: the new prop must be a strict no-op when absent (test with and without).
- Pagination by measured heights depends on fonts; PDF export must wait for fonts (the mockup's headless print does).
- Foreign keys to `quotations`/`quotation_items` use SET NULL so deleting a quotation never fails because of estimation data; the link then shows "ใบเสนอราคาถูกลบ".
- A project's prices shown in the quotation can drift from the structure if someone edits lines in the Quotation page; the compare screen exists for exactly that.

## 10. Resolved questions and remaining items

Resolved by the owner on 2026-10-09: sub-numbering (decision 10); split pricing with adjustable 80/20 (decision 11); notes/terms/bank identical to a hand-made quotation (decision 12); pictures on every catalogue table (decision 13); aluminium weight is net cut weight × quantity, and the same plus waste; the new `markup_pct` is the only profit input in the price structure (any older Phase 2b field is ignored by it, to be confirmed against the code when the plan is written).

Remaining, decided in the plan: the exact list of catalogue tables that receive `image_path`; picture upload UI in each catalogue screen (small additive file field, mockup first per the standing rule); picture size limit and thumbnail handling for the attachment pages.

## 11. Testing

- `priceStructure` pure tests: the ELSY workbook rows (expected values copied from the sheet into the test), waste on aluminium only, profit base, pro-rata transport, PM ceil, rounding steps, per-item override, unresolved exclusion, weights, real-profit formula incl. bill discount and VAT-inclusive prices.
- Hide-empty-column and SUMPRODUCT view-model tests.
- SQL tests (owner-run scripts): new tables RLS and isolation (tenant without `estimation` sees nothing and cannot insert), FKs set null, unique constraints, checks (≥ 0).
- Send/re-send logic tested with an in-memory fake of the three quotation tables: state table of §7.2, id stability, user-added rows untouched, invoice-referenced rows kept, `quotation_revisions` snapshot shape equal to the Quotation page's.
- Isolation tests: Quotation page with no link / no module renders byte-identical output and fires no new query; `extraPages` absent is a no-op.
- A4 pagination tests on the pure measuring/greedy-fill function (keep-with-next, footer blocks, total page count).
- Build, full suite, and the owner's click-through list; agents never run SQL against Supabase.

## 12. Deploy order

Apply the Phase 2b migrations (`2026-10-12-02`, `-03`) and the contract step per the Phase 2b handover first; then the Phase 3 migration (test script first); then deploy the code. No merge before the owner approves the whole arc; rebase on the current `origin/main` before the final merge.
