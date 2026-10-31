# FIFO Costing + MO/OB Stock Documents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace weighted-average costing with FIFO lot costing everywhere, add MO (ใบสั่งผลิต) and OB (ยอดยกมา) document types, restructure the tax-report tabs to 1–4, and refit FacadeX's existing cut documents.

**Architecture:** Lots are the in-movements themselves (`purchase_in` / positive `adjustment` / `transfer_in` / `sale_reversal` rows); every out-movement records which lot it consumed via a new `stock_movements.lot_movement_id` self-FK, written at posting time so posted prices are immutable. A replay function derives lot remainders and FIFO balance value; the client planner picks lots as-of the invoice date and emits one movement row per lot price. MO/DM/DP/OB are all `stock_documents` rows (new doc_types, parent link, target metadata).

**Tech Stack:** React (Vite) + Supabase Postgres (plpgsql RPCs, SECURITY DEFINER), vitest.

**Spec:** `docs/superpowers/specs/2026-10-26-fifo-mo-ob-stock-documents-design.md`

## Global Constraints

- Worktree `fifo-mo-ob` branched from origin/main (1.33.2); baseline 2383 vitest tests pass; suite must stay green after every task.
- Migrations: write SQL files in `supabase/migrations/` named `2026-10-26-NN-<slug>.sql`; **do not apply them** — applying via MCP is live on CHANG instantly. The controller applies after task review, dry-running a `BEGIN; ... ROLLBACK;` copy first. Subagents never call the database; they write scripts for the controller to run (owner rule 2026-10-17).
- Datafixes live in `supabase/datafix/` with a `.dryrun.sql` (BEGIN..ROLLBACK, prints verification SELECTs) beside each real file — same pattern as `supabase/datafix/2026-10-17-undo-in2601-001-spread-cut.sql`.
- Posted movement prices never change; only `lot_movement_id` may be backfilled onto existing rows (spec anti-goal).
- Numbering stays `TYPE + YYMM + '-' + NNN` per tenant via `_issue_stock_document`'s advisory-lock path.
- Tab names, exactly: `1. รายงานการตัดสินค้าสำเร็จรูป (FG)` · `2. ใบสั่งผลิต (MO)` · `3. รายงานตัดวัตถุดิบ (RM)` · `4. รายงานสินค้าและวัตถุดิบ (รวม)` — abbreviation on every tab except the last; page opens on tab 1.
- Reference labels show document numbers only (`DM2601-001`), never ` · IN...`.
- New-row check on views: before altering `stock_movements`/`stock_documents`, list views selecting `x.*` from them (view column freeze trap); recreate any found.
- Every RPC touched keeps `SECURITY DEFINER SET search_path TO 'public'` and the existing `is_admin_or_owner() AND has_module_access('purchase_orders')` guard.

## Review Focus

1. A cut spanning a lot boundary with floating-point remainders (lot 3.7824656 left, take 3.78246561) must drain the lot to exactly 0, never negative — pinned in Task 4's boundary test.
2. A purchase back-dated in front of an already-posted FIFO cut must not change that cut's recorded lots or prices, only future picks — pinned in Task 2's replay test script.
3. Lots with zero or negative unit_cost are excluded from sourcing (parity with today's `weighted_average_cost > 0` rule), not treated as free stock — pinned in Task 4's test.
4. A shortfall cut: FG receipt value = actual issued (scaled), MO list shows ขาด, DP equals the FG receipt — pinned in Task 4 (planner) and Task 8 (MO list).
5. A tenant with no OB and no pre-period history renders reports without a ยอดยกมา line and without crashing — pinned in Task 9's report test.

---

### Task 1: Schema — lot links, MO/OB document types

**Files:**
- Create: `supabase/migrations/2026-10-26-01-lot-links-and-doc-types.sql`
- Create: `supabase/datafix/2026-10-26-01-schema.dryrun.sql`

**Interfaces:**
- Produces: `stock_movements.lot_movement_id uuid NULL REFERENCES stock_movements(id)`; `stock_documents.parent_document_id uuid NULL REFERENCES stock_documents(id)`, `stock_documents.target_total numeric NULL`, `stock_documents.target_splits jsonb NULL`, `stock_documents.attachment_path text NULL`; doc_type values `'MO'`,`'OB'` accepted; `stock_documents.invoice_id` nullable.
- Produces: `_issue_stock_document(p_tenant_id uuid, p_invoice_id uuid, p_doc_type text, p_doc_date date, p_created_by text, p_parent uuid DEFAULT NULL, p_target_total numeric DEFAULT NULL, p_target_splits jsonb DEFAULT NULL) RETURNS uuid` — same idempotency by (invoice_id, doc_type) when invoice_id is not null; when null (OB), idempotent by (tenant_id, doc_type).

- [ ] **Step 1: Check current constraints and views.** Run `git grep -n "stock_documents\|stock_movements" supabase/migrations | grep -i "check\|create view"` and read `supabase/migrations/2026-10-17-*.sql` that created `stock_documents` to copy its exact constraint names. List any view selecting `stock_movements.*` or `stock_documents.*`; if found, include `CREATE OR REPLACE VIEW` in the migration.
- [ ] **Step 2: Write the migration** with the columns and function change in Interfaces, `ALTER TABLE ... DROP CONSTRAINT IF EXISTS` + re-add for the doc_type check (include existing 'DM','DP'), `ALTER COLUMN invoice_id DROP NOT NULL` if needed, and an index `stock_movements_lot_movement_id_idx ON stock_movements(lot_movement_id) WHERE lot_movement_id IS NOT NULL`.
- [ ] **Step 3: Write the dry-run script** — BEGIN; run the migration body; insert a probe OB document with null invoice_id and a probe MO with parent + target; SELECT them back; ROLLBACK.
- [ ] **Step 4: Commit** `feat(db): lot links on stock_movements, MO/OB document types`

### Task 2: SQL — lot replay and lots-as-of RPC

**Files:**
- Create: `supabase/migrations/2026-10-26-02-fifo-lot-functions.sql`
- Create: `supabase/datafix/2026-10-26-02-fifo-functions.dryrun.sql`

**Interfaces:**
- Consumes: Task 1 columns.
- Produces: `_replay_stock_lots(p_item uuid, p_site uuid, OUT qty numeric, OUT fifo_value numeric, OUT min_qty numeric, OUT lots jsonb) RETURNS record` — `lots` is the remaining layers oldest-first: `[{"movement_id","created_at","unit_cost","qty"}]`; `fifo_value` = Σ layer qty×cost.
- Produces: `inventory_lots_as_of(p_date date, p_site_ids uuid[]) RETURNS jsonb` — per (item,site) with stock then-and-ever-since (same min-after discipline as `inventory_balances_as_of`): `{"inventory_item_id","site_id","quantity_on_hand","first_received_at","lots":[{"movement_id","received_at","unit_cost","qty"}]}`; lots with `unit_cost <= 0` excluded; per-item available qty capped by the min-after guard (cap applies to the newest lots first so the oldest remain pickable).

- [ ] **Step 1: Write `_replay_stock_lots`.** Replay rules, in `ORDER BY created_at, id`: in-rows (`purchase_in`,`transfer_in`,`sale_reversal`, `adjustment` with quantity > 0) push a layer at their unit_cost; out-rows with `lot_movement_id` consume that specific layer; out-rows without it (historical) consume oldest-first; `receipt_reversal` consumes its `lot_movement_id` layer, else oldest-first; `adjustment` with quantity < 0 consumes oldest-first. A consume that overshoots its layer never goes negative: clamp at 0 and take the remainder oldest-first (legacy data can be inconsistent; the function must not throw).
- [ ] **Step 2: Write `inventory_lots_as_of`** following `inventory_balances_as_of`'s structure (same privilege guard, same 23:59 Asia/Bangkok cutoff, same min-after computation) but tracking layers.
- [ ] **Step 3: Write the dry-run script** proving Review Focus 2: BEGIN; create a temp tenant/item/site; insert lot A (day 1, cost 100, qty 10), post an out of 4 with `lot_movement_id` = A; insert a back-dated lot B (day 0, cost 80); assert `_replay_stock_lots` still shows A consumed by 4 (its recorded link) and B intact at 10 — the out's price did not move; ROLLBACK. Print PASS/FAIL rows.
- [ ] **Step 4: Commit** `feat(db): FIFO lot replay + lots-as-of RPC`

### Task 3: post_invoice_stock_deduction v2 — MO chain + FIFO balances

**Files:**
- Create: `supabase/migrations/2026-10-26-03-post-deduction-v2.sql`
- Create: `supabase/datafix/2026-10-26-03-post-v2.dryrun.sql`

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces: `post_invoice_stock_deduction(p_invoice_id uuid, p_movements jsonb, p_target_total numeric DEFAULT NULL, p_target_splits jsonb DEFAULT NULL) RETURNS jsonb` → `{"rows": n, "mo": "MO...", "dm": "DM...", "dp": "DP..."}`. Each p_movements element may carry `"lot_movement_id"` (RM `sale_out`/`transfer_out` rows: required; FG rows and `transfer_in`: absent).
- Document wiring: MO issued first (`p_target_total`/`p_target_splits` stored on it), DM second (parent = MO), DP third (parent = MO) — created in that order so ids/timestamps order MO→DM→DP. RM movements → stock_document_id = DM. FG `purchase_in` → MO. FG `sale_out` → DP.
- Triplet wiring, server-side: a `transfer_out` carries the source `lot_movement_id`; the `transfer_in` posted immediately after it becomes a NEW lot at the same cost; the following `sale_out` for the same item gets `lot_movement_id` = that just-inserted transfer_in id.

- [ ] **Step 1: Write the migration** replacing the function: keep the existing validation, as-of guard (`_replay_stock_lots().min_qty` replaces `_replay_stock_balance`), and per-row `_apply_stock_movement` call — then `UPDATE stock_movements SET lot_movement_id = ...` per the wiring above, and finish each touched (item,site) with `UPDATE inventory_stock_balances SET quantity_on_hand = r.qty, weighted_average_cost = CASE WHEN r.qty > 0 THEN r.fifo_value / r.qty ELSE 0 END` from `_replay_stock_lots`.
- [ ] **Step 2: Write the dry-run script:** BEGIN; temp tenant with 2 lots at different costs + an invoice; call the RPC with a 2-lot RM cut + FG pair; assert 3 documents exist in MO→DM→DP created order, FG purchase_in cites MO, balances match FIFO value; ROLLBACK; print PASS/FAIL.
- [ ] **Step 3: Commit** `feat(db): invoice cut posts MO→DM→DP with FIFO lot links`

### Task 4: JS planner — FIFO lot pricing

**Files:**
- Modify: `src/lib/inventoryCost.js` (computeInvoiceDeductionPlan, computeFinishedGoodsProductionPlan)
- Test: `src/lib/inventoryCost.test.js`

**Interfaces:**
- Consumes: `inventory_lots_as_of` row shape (Task 2).
- Produces: `computeInvoiceDeductionPlan({ invoiceSubtotal, materialPct, categorySplits, siteId, centralSiteId, items, balances, firstReceivedAt })` — same signature; each `balances` element now also carries `lots: [{movement_id, received_at, unit_cost, qty}]`. Steps gain `lotMovementId` (source lot: on `sale_out` from the site and on `transfer_out` from central; `transfer_in` and the triplet's `sale_out` carry `lotMovementId: null` — the server wires them, Task 3). One step per lot consumed; `unitCost` = that lot's cost. Item order: unchanged FIFO-by-first-receipt; within an item, lots oldest-first.
- Produces: `computeFinishedGoodsProductionPlan({ billedLines, materialPct, actualFactor = 1 })` — `value = invoiceItemLineTotal * (materialPct/100) * actualFactor`.

- [ ] **Step 1: Write failing tests** in the file's existing style:
  - `splits a category take across two lots at each lot's own price` — lot A qty 2 @100, lot B qty 5 @120, target ฿400 → steps `[2@100 (lot A), 1.666…@120 (lot B)]`, deductedValue 400.
  - `drains a lot to exactly zero across float remainders` (Review Focus 1) — lot qty 3.7824656778742924 @2030.76, target = qty×cost exactly → one step, lot remainder 0, no negative.
  - `skips lots with non-positive unit_cost` (Review Focus 3).
  - `central triplet carries the source lot on transfer_out only`.
  - `finished goods scale by actualFactor` (Review Focus 4) — actualFactor 0.9941… → value = lineTotal×pct×factor.
- [ ] **Step 2: Run** `npx vitest run src/lib/inventoryCost.test.js` — expect the new tests FAIL (lots ignored today).
- [ ] **Step 3: Implement.** Replace the `valueOf`/`take` WAC math with per-lot consumption; keep epsilon style (`1e-9`) and the shortfall contract (never throws, never fabricates).
- [ ] **Step 4: Run the full suite** `npx vitest run` — all pass (existing WAC-based planner tests will need updating to lot inputs in the same commit; preserve each test's intent, including the shortfall and no-category cases).
- [ ] **Step 5: Commit** `feat(inventory): deduction planner prices from FIFO lots`

### Task 5: Confirm flow — lots in, MO out

**Files:**
- Modify: `src/pages/Inventory.jsx` (the `asOf` loader ~line 323, `confirm()` ~line 349–460)

**Interfaces:**
- Consumes: `inventory_lots_as_of` (replaces `inventory_balances_as_of` here), Task 4 planner, Task 3 RPC signature.

- [ ] **Step 1: Switch the loader** to `supabase.rpc('inventory_lots_as_of', …)`, mapping rows to the planner's `balances` shape (keep `firstReceivedAt` from `first_received_at`).
- [ ] **Step 2: In `confirm()`:** compute `actualFactor = plan && plan.totalTargetValue > 0 ? plan.totalDeductedValue / plan.totalTargetValue : 1`; pass it to `computeFinishedGoodsProductionPlan`; include `lot_movement_id` on each RM movement from the step's `lotMovementId`; stop writing `PI-`/`PO-` notes on FG rows (pass null — the MO/DP documents carry the reference now); pass `p_target_total` (= invoiceSubtotal×materialPct%) and `p_target_splits` (the numericSplits object) to the RPC; alert shows `posted.mo / posted.dm / posted.dp`.
- [ ] **Step 3: Run** `npx vitest run` — pass. Run `npm run build` — clean.
- [ ] **Step 4: Commit** `feat(inventory): invoice cut sends lots and issues MO chain`

### Task 6: Stock value labels follow FIFO

**Files:**
- Modify: `src/pages/Inventory.jsx`, `src/pages/PurchaseOrders.jsx`, `src/components/ReceivePoLinesModal.jsx`, `src/lib/supplierTaxInvoice.js` (display strings only)

**Interfaces:** none new — `inventory_stock_balances.weighted_average_cost` now stores FIFO value ÷ qty (Task 3 / Task 11), so numbers flow unchanged.

- [ ] **Step 1:** `git grep -n "ต้นทุนเฉลี่ย" src` and change each user-facing label to `ต้นทุน/หน่วย` (keep the `supplierTaxInvoice.js` warning line's arrow format otherwise intact, and update its test expectation in `src/lib/supplierTaxInvoice.test.js`).
- [ ] **Step 2: Run** `npx vitest run` — pass.
- [ ] **Step 3: Commit** `chore(ui): stock cost labels say ต้นทุน/หน่วย (FIFO)`

### Task 7: Tax-report tabs 1–4, open on tab 1

**Files:**
- Modify: `src/pages/Inventory.jsx` (`TAX_REPORT_KINDS` ~line 538, `TaxReportsView` state ~line 583)

- [ ] **Step 1:** Rewrite `TAX_REPORT_KINDS` to four entries in order: `finished_goods` (label `1. รายงานการตัดสินค้าสำเร็จรูป (FG)`, badge `รายงานที่ 1`), `mo` (label `2. ใบสั่งผลิต (MO)`, badge `รายงานที่ 2`), `raw_material` (label `3. รายงานตัดวัตถุดิบ (RM)`, badge `รายงานที่ 3`), `all` (label `4. รายงานสินค้าและวัตถุดิบ (รวม)`, badge `รายงานที่ 4`). Change `useState('all')` → `useState('finished_goods')`. Update every `reportKind === …` branch and the subtitle/print-header text that names report numbers (`รายงานที่ 2` comments at ~line 592–607 are comments; the visible strings matter).
- [ ] **Step 2:** `npx vitest run` + `npm run build` — pass.
- [ ] **Step 3: Commit** `feat(reports): tabs 1-4 with abbreviations, FG first`

### Task 8: MO tab — list and printable ใบสั่งผลิต

**Files:**
- Modify: `src/pages/Inventory.jsx` (new `MoReportView` component rendered when `reportKind === 'mo'`)
- Modify: `src/hooks/useSupabase.js` (`useStockDocuments` ~line 1817: also select `parent_document_id, target_total, target_splits`)

**Interfaces:**
- Consumes: `useStockDocuments()`, `useStockMovements()`, `useInvoiceNumbers()`, `useCategories()` — all already loaded in `TaxReportsView`.
- Produces: `MoReportView({ stockDocuments, movements, invoiceNumbers, categories })` — list of MO docs (เลขที่ · วันที่ · ใบแจ้งหนี้ · เป้ามูลค่า = target_total · เบิกจริง = Σ its DM children's movement values · ขาด = target − actual, red when > 0.01); clicking a row opens the print view.
- Print view (mockup-approved): header `ใบสั่งผลิต <doc_number>` + Thai date; kv rows ผลิตเพื่อ (invoice number + site), เอกสารเบิก (DM number), รับสำเร็จรูปเข้า (Σ FG purchase_in citing this MO); then the per-category table — columns `หมวดวัตถุดิบ / % ที่ตั้ง / เป้ามูลค่า (บาท) / เบิกจริง (บาท) / ขาด (บาท)` from `target_splits` (% and target per category) vs actual per category (sum DM movements joined through item category), with a รวม row. Reuse the page's existing print CSS pattern (`print-repeat-sep` area ~line 888).

- [ ] **Step 1:** Extend `useStockDocuments` select.
- [ ] **Step 2:** Implement `MoReportView` per Interfaces; numbers via the file's `fmt`.
- [ ] **Step 3:** `npx vitest run` + `npm run build`; view it on `npm run dev` with mock data unavailable — rely on Task 13's live check for real data.
- [ ] **Step 4: Commit** `feat(reports): MO tab with list and printable manufacturing order`

### Task 9: Report rows — MO/DM references, 3-line drill-down, clean labels

**Files:**
- Modify: `src/pages/Inventory.jsx` (`docLabel` ~line 645, `filterLabel` ~650, FG/RM detail rendering ~line 1007–1140, `isProductionRef` usage, `LEDGER_MOVEMENT_LABELS`)
- Modify: `src/lib/inventoryCost.js` (`computeStockLedgerReport` — no signature change; rows already carry `stockDocumentId`)
- Test: `src/lib/inventoryCost.test.js`

**Interfaces:**
- Consumes: FG purchase_in rows now cite MO, FG sale_out cite DP, RM rows cite DM (Task 3); legacy rows keep PI-/PO- notes and DM/DP ids.

- [ ] **Step 1: Write the failing test** (Review Focus 5): `computeStockLedgerReport` with zero pre-period movements returns rows whose `openingQty === 0` — and add a UI-level expectation to the existing report tests (if none renders TaxReportsView, assert via the pure function only).
- [ ] **Step 2: Labels.** `docLabel` returns the document number alone (delete the `inv ?` join); `filterLabel` similarly document-numbers-only. FG รับเข้า rows: when the citing document is an MO, show `รับจากการผลิต` as the row label (extend `LEDGER_MOVEMENT_LABELS` lookup at render time by doc_type, not movement_type); keep `isProductionRef` only for legacy PI-/PO- rows.
- [ ] **Step 3: RM per-MO drill-down (referenceFilter set):** render exactly ยอดยกมา row → `เบิกไปผลิต อ้างอิง <MO number>` rows (the sale_out rows; `transfer_in`/`transfer_out` rows hidden in this view only) → ยอดคงเหลือ row. Period view (no referenceFilter) unchanged: all rows with documents cited.
- [ ] **Step 4:** Check `src/lib/peakExport.js` filters: `git grep -n "doc_type" src/lib/peakExport.js` — if it assumes only DM/DP exist, scope its queries to `('DM','DP')` and note it.
- [ ] **Step 5:** `npx vitest run` + `npm run build` — pass. **Commit** `feat(reports): MO references, 3-line drill-down, document-only labels`

### Task 10: Reversal paths carry lot links

**Files:**
- Create: `supabase/migrations/2026-10-26-04-reversal-lot-links.sql`
- Create: `supabase/datafix/2026-10-26-04-reversals.dryrun.sql`

**Interfaces:**
- Consumes: the live RPCs `_sti_receipt_movements*` / supplier-tax-invoice void, `po_unreceive_reverse_stock`, and the credit-note posting path (read their current definitions from the DB dump the controller provides, or `supabase/migrations/2026-10-*`).
- Produces: `receipt_reversal` rows get `lot_movement_id` = the purchase_in row they reverse (both void and un-receive know those ids already — they locate the original receipt rows). `purchase_return` rows get `lot_movement_id` = the purchase_in row of the tax invoice being credited when the credit note references one and that lot still has remainder ≥ the return qty; otherwise leave null (replay then consumes oldest-first). Each path finishes its touched (item,site) balances from `_replay_stock_lots` like Task 3.

- [ ] **Step 1:** Read the three paths' current SQL; write one migration updating each to set `lot_movement_id` and the FIFO balance update.
- [ ] **Step 2:** Dry-run script: BEGIN; probe a receipt + its void → reversal row links the receipt; a credit-note return against a 2-lot item → links the invoice's own lot, other lot untouched; ROLLBACK; PASS/FAIL prints.
- [ ] **Step 3: Commit** `feat(db): voids and returns cancel their own lots`

### Task 11: Switch-over datafix — all tenants

**Files:**
- Create: `supabase/datafix/2026-10-26-05-fifo-switchover.sql` + `.dryrun.sql`

**Interfaces:**
- Consumes: `_replay_stock_lots` (Task 2).
- Produces: every historical out-row's `lot_movement_id` backfilled by FIFO replay per (item,site) in `created_at, id` order (prices untouched); every `inventory_stock_balances` row recomputed (qty from replay, wac = fifo_value/qty); a delta report: `SELECT tenant, item code, old value, fifo value, delta` for every row where `abs(delta) > 0.01`, ordered by tenant then |delta| desc.

- [ ] **Step 1:** Write the datafix as one DO block per tenant (guarded: skips rows that already have lot_movement_id, so it is re-runnable), with the delta SELECT at the end.
- [ ] **Step 2:** Dry-run copy prints, per tenant: row counts linked, total old value vs total FIFO value, top-20 item deltas — the owner sees FacadeX's jump before the real run (spec requirement).
- [ ] **Step 3: Commit** `datafix: materialize FIFO lot links + balance values (all tenants)`

### Task 12: FacadeX OB2601-001

**Files:**
- Create: `supabase/datafix/2026-10-26-06-facadex-ob.sql` + `.dryrun.sql`
- Create: `scripts/verify-opening-vs-source.mjs`

**Interfaces:**
- Consumes: the 725 `reference_type='opening_balance'` movements (verified marker); Task 1's OB doc type + `attachment_path`.
- Produces: one `stock_documents` row — tenant FacadeX (`1b9affc4-2136-4ed1-b168-a36e6624e743`), doc_type 'OB', doc_number 'OB2601-001', doc_date '2026-01-01', invoice_id null, attachment_path 'stock-documents/facadex/OB2601-001-stock-20251231.pdf'; all opening_balance movements get `stock_document_id` = it.

- [ ] **Step 1:** Write the datafix (idempotent: `WHERE NOT EXISTS` the OB row).
- [ ] **Step 2:** Write `verify-opening-vs-source.mjs`: reads the opening import source spreadsheet (`ยอดยกมาต้นปี_2569.xlsx` in the repo root — the machine-readable sheet built from the 31 ธ.ค. 2568 PDF) and a CSV export of the opening movements (the controller supplies it from a read-only query), joins on item code, prints any qty/unit-cost mismatch. Zero mismatches expected; mismatches block the OB datafix until explained. (The PDF itself has broken text encoding; the controller spot-checks ~10 random items against the rendered PDF pages by eye.)
- [ ] **Step 3:** Note for the controller: upload the PDF (`DOC/สต๊อก  31-12-2025 ล่าสุด(1).pdf` in the MAIN checkout, not this worktree) to the storage bucket at the attachment_path above before running the datafix.
- [ ] **Step 4: Commit** `datafix: FacadeX adoption OB2601-001 + opening verification script`

### Task 13: Refit the posted WAC cuts

**Files:**
- Create: `supabase/datafix/2026-10-26-07-refit-wac-cuts.sql` + `.dryrun.sql`

**Interfaces:**
- Consumes: Tasks 2–3, 11–12 applied. Targets: every FacadeX invoice that has DM/DP stock_documents but no MO at run time (today only IN2601-001; the script discovers them, owner decision: refit all).
- Produces: per such invoice, inside one transaction: delete its DM/DP documents and their movements (hard delete, owner decision — numbers free up and `_issue_stock_document` max+1 re-issues the same numbers when it was the month's only/latest doc; the script asserts the number it will get back equals the number it deleted, and aborts that invoice with a NOTICE if not); re-post through `post_invoice_stock_deduction` with per-category targets equal to the ORIGINAL cut's per-category posted totals (so the cut's economic size is unchanged — only prices and documents change) [plan's call]; FG value = actual issued.
- Produces: final verification block — for the whole tenant: every out-row has a lot link, no stock card dips below its pre-fix minimum, `inventory_stock_balances` matches `_replay_stock_lots`, and the refit invoices' DM totals printed old vs new.

- [ ] **Step 1:** Write it; dry-run copy prints the discovered invoices, the number-reuse assertion, and old/new totals without committing.
- [ ] **Step 2: Commit** `datafix: refit WAC invoice cuts as FIFO under MO`

### Task 14: Ship

**Files:**
- Modify: `src/changelog.json`, `package.json` (version), `public/manual/` (คู่มือ: FIFO, ใบสั่งผลิต, OB, แท็บใหม่ — per the every-job rule)

- [ ] **Step 1:** Bump to 1.34.0 with Thai changelog notes covering: FIFO ทั้งระบบ, ใบสั่งผลิต MO, แท็บรายงาน 1–4, เลขอ้างอิงใหม่, ใบ OB.
- [ ] **Step 2:** `npx vitest run` + `npm run build` — green.
- [ ] **Step 3: Commit** `chore(release): 1.34.0 FIFO + MO/OB`
- [ ] **Step 4 (controller, with the chang-ship skill, in order):** apply migrations 01–04 (dry-run first), run switchover dry-run → show owner the delta report → real run, OB datafix (after PDF upload + verify script), refit dry-run → real run, deploy web, verify live: cut-test on a test tenant, FacadeX tabs 1–4 render, MO2601-001 printable, stock card of กระจกเทมเปอร์ใส 10 มม. shows OB → DM chain at FIFO prices.

---

## Self-review notes

- Spec coverage: FIFO engine (T2–T5, T10–T11), MO (T1, T3, T5, T8), OB (T1, T12), labels/IN removal (T9), tabs (T7), per-MO 3-line view (T9), official-card period view (already live, T9 keeps it), FG-cites-MO (T3+T9), datafix scope all pre-go-live cuts (T13), delta report (T11), value displays (T6), ship+manual (T14).
- Types: `lot_movement_id` spelled identically in T1–T5, T10–T11; `lots` element `{movement_id, received_at, unit_cost, qty}` in T2's RPC vs planner input — planner uses the RPC's spelling (snake_case) directly; T4's `lotMovementId` is the step-output field only.
- Not in scope (spec non-goals): labor/overhead on MO, BOM, % config UI, year-end close workflow.
