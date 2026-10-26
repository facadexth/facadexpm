# FIFO costing + MO/OB stock documents — design

Date: 2026-10-26 · Status: draft, awaiting owner approval
Owner conversation: "ขอแก้เอกสารหักสต๊อก" — grew from fixing one document
into the costing-method and document-chain redesign below.

## Intent and why

The company is replacing PEAK accounting with FacadeXPM. The accountant
and the Revenue Department will read our stock documents, so they must
match formal Thai practice:

- PEAK costs stock **FIFO**. Our deduction engine prices cuts at
  weighted-average cost, so our numbers can never reconcile with PEAK's
  or with what the accountant expects.
- Thai cost-accounting practice (and the ป.89 stock-card format —
  columns เลขที่ใบสำคัญ / วันเดือนปี / รับ / จ่าย / คงเหลือ, every
  movement citing a supporting document) expects a **manufacturing
  order** between raw materials and finished goods. We jump straight
  from raw-material cut (DM) to finished-goods sale (DP) with nothing
  tying them together.
- Opening balances (ยอดยกมา) have no supporting document to cite.

## Owner decisions (2026-10-26, all confirmed in chat)

1. **Whole system goes FIFO, like PEAK.** Not a per-feature or
   per-tenant toggle. Cut prices come from actual purchase lots,
   oldest-first; remaining stock is valued by the remaining lots. This
   supersedes the 2026-10-17 decision where "FIFO" only picked which
   items got cut while cost stayed weighted-average.
2. **New document type MO (ใบสั่งผลิต, manufacturing order)**, numbered
   like the others (MO2601-001). One per invoice cut. Its target value
   comes from the existing % config (invoice subtotal × materialPct ×
   category splits). The MO is an order/parent document: it moves no
   stock itself.
3. **DM stays** as the material requisition under the MO (ใบเบิก/ตัด
   วัตถุดิบ): the document that actually moves raw material out, at
   FIFO prices, citing its MO.
4. **Document order:** MO is created before-or-with DM (they carry
   different data: the order vs. the goods actually issued), and MO is
   always before DP. One click on the invoice still issues the whole
   chain: MO → DM → DP, all dated the invoice date, ledger-ordered in
   that sequence.
5. **Finished-goods receipt cites the MO.** Report 1's รับเข้า row shows
   the MO number (replacing today's PI-/invoice reference). DP remains
   the finished-goods sale-out document (report 1's จ่าย row).
6. **OB (ยอดยกมา) is a real document, issued once per tenant — at
   system adoption only.** (Owner first asked for OB, then challenged
   the yearly version; standard practice confirmed his instinct.)
   There is no yearly OB: the ledger is continuous, FIFO lots cross
   year boundaries keeping their original purchase-document
   references, and a report period's ยอดยกมา line is a computed
   figure, not a document. Year-end physical-count differences are
   booked as adjustment documents. FacadeX gets retroactive
   OB2601-001 for its 1 Jan 2026 opening, with the legacy closing
   report "สินค้าคงเหลือ ณ 31 ธ.ค. 2568" (DOC/สต๊อก  31-12-2025
   ล่าสุด(1).pdf, 47 pages, per-item code/qty/unit price/value) as
   its attached supporting evidence.
7. **Reference labels drop the invoice number:** show "DM2601-001", not
   "DM2601-001 · IN2601-001". The invoice stays linked internally
   (invoice_id / reference_id); it just leaves the visible label.
8. **Report 2 (raw materials), per-MO detail view = 3 lines:**
   ยอดยกมา → เบิกไปผลิต อ้างอิง DM (ซึ่งอ้าง MO) → ยอดคงเหลือ. The
   transfer in/out noise disappears from this view. The period view
   keeps purchase-receipt rows — the official card format requires รับ
   rows; only the per-MO drill-down is reduced to 3 lines.
9. **The one existing cut gets refitted:** FacadeX DM2601-001 +
   DP2601-001 (invoice IN2601-001, dated 2026-01-06) are re-posted at
   FIFO prices, under a new MO2601-001, in MO → DM → DP order.

## Goals

- FIFO lot engine used by every stock valuation in the app.
- MO and OB document types, issued and numbered like DM/DP, with a
  printable MO view and an MO listing in the tax-reports page.
- Tax reports match the official card: every line cites a document,
  running balance, ยอดยกมา cites OB.
- Datafix for the existing FacadeX cut (decision 9) and a retroactive
  OB for the 2026 opening balances.

## Non-goals

- Labor/overhead on the MO — material cost only for now.
- BOM-driven MOs (quantities come from the % config, as today).
- Changing the % configuration UI.
- A year-end close workflow. There is none to build: the ledger is
  continuous, ยอดยกมา is computed per report period, and count
  differences are ordinary adjustment documents. Only the one-time
  adoption OB (retro for FacadeX) exists.

## Anti-goals (failure even if it works)

- Silently rewriting other tenants' historical numbers. The engine
  switch is global, but posted movements keep the prices they were
  posted at; only new cuts and *re-posted* documents (decision 9) get
  FIFO prices.
- A FIFO engine the reports can't reproduce. The stock card and the
  balances must be derivable from the same ledger + lots; no second
  source of truth.

## Current state (verified live 2026-10-26)

- Deduction engine: `computeInvoiceDeductionPlan` in
  `src/lib/inventoryCost.js` (pure JS, unit-tested). WAC pricing, FIFO
  item order, invoice site first then ส่วนกลาง via
  transfer_out/transfer_in/sale_out triplets. FG side: self-balancing
  produce+sell pair (PI-/PO- notes) valued at materialPct% of the
  invoice line.
- Posting: RPC `post_invoice_stock_deduction(p_invoice_id,
  p_movements)` — validates, posts via `_apply_stock_movement`
  back-dated to the invoice date, issues DM/DP via
  `_issue_stock_document`, guards the as-of running balance via
  `_replay_stock_balance`, updates `inventory_stock_balances`
  (quantity_on_hand, weighted_average_cost).
- `stock_documents`: {doc_type 'DM'|'DP', doc_number, doc_date,
  invoice_id, created_by}; numbering TYPE+YYMM-### per tenant inside
  `_issue_stock_document`, idempotent per (invoice_id, doc_type) — OB
  has no invoice, so it needs its own issue path.
- Tax reports: `TaxReportsView` in `src/pages/Inventory.jsx`, 3 tabs;
  `docLabel()` (~line 648) builds the "DM2601-001 · IN2601-001" label.
- Central-site rule: all stock lives at ส่วนกลาง; expenses per job
  site (docs + memory, live since 2026-10-16).
- The one existing cut: DM2601-001 (10 material items, WAC prices like
  73.8342 / 149.1778) + DP2601-001 (งานตามสัญญา 31,430 in/out pair),
  both dated 2026-01-06, created by the 2026-10-17 datafix.
- Opening balances: backfilled Jan 2026 as purchase_in movements with
  real per-lot costs (stock backfill project, closed 2026-10-16).

## Design

### FIFO lot engine

- A **lot** is each incoming movement that adds priced stock: OB lines
  (today's reference_type='opening_balance' rows), purchase_in,
  adjustment-in, sale_reversal (and transfer_in carries its source
  lot).
- **Consumption is recorded, not re-derived** [my call, after builder
  review]: when an outflow posts, the engine picks lots oldest-first
  *at posting time* and records which lot(s) it consumed (a lot
  consumption link per movement row). Lot state comes from those
  links. A movement back-dated in front of already-posted outflows
  therefore never re-prices them — posted prices are immutable; the
  existing as-of quantity guard still applies. Pre-FIFO history gets
  its links materialized once by the switch-over datafix: quantities
  replayed oldest-first in movement-date order, posted values left
  exactly as posted.
- Every outgoing valuation (DM production issue, FG sale, purchase
  returns, credit notes, adjustments-out) consumes lots oldest-first.
  A cut that spans lots splits into one movement row per lot price, so
  the ledger itself shows the FIFO prices used.
- **Reversal rules** [my calls, builder review Q3]: a void/un-receive
  (receipt_reversal) cancels its *own specific lot* and refuses if
  that lot is already partly consumed (same refusal behavior as
  today); a purchase_return/credit note returns from the identified
  source lot when the document names one, else oldest remaining; a
  sale_reversal re-creates a lot priced at what the sale consumed; an
  adjustment-in is a new lot at its own unit_cost; an adjustment-out
  consumes oldest-first.
- Stock value everywhere = sum of remaining lot values.
  `inventory_stock_balances.weighted_average_cost` becomes a derived
  blended figure (value ÷ qty) kept for display/compatibility; every
  UI that prices stock must price from lots.
- **Switch-over for existing tenants** [my call]: every tenant's lot
  links are materialized from their real ledger (no freeze-to-one-
  layer). Posted outflow values stay as posted, so each tenant's
  displayed stock value may jump at switch-over (WAC remainder → FIFO
  remainder). The switch datafix emits a per-tenant, per-item
  valuation delta report so nothing changes silently; the owner sees
  FacadeX's delta before go-live.
- The deduction planner keeps its current shape (target value per
  category, FIFO item order, shortfall reporting — never fabricates
  stock, never throws) but prices each take from the item's lots
  instead of one WAC number.
- FG receipt cost = the actual total the DM issued (equals the target
  when there is no shortfall). The produce+sell pair stays
  self-balancing. [My call, standard cost accounting: FG enters at
  actual production cost, the % config is the target.]

### MO document

- `stock_documents.doc_type` gains 'MO'. Issued first in
  `post_invoice_stock_deduction`; doc_date = invoice date; the chain's
  ledger order MO → DM → DP is fixed by issue sequence.
- MO stores its target value (per category and total) and links the
  invoice. DM and DP gain a parent link to their MO
  (`parent_document_id` or equivalent).
- Raw-material movements keep stock_document_id = DM (the DM cites its
  MO); FG produce movements get stock_document_id = MO's… **no** —
  FG produce rows cite the **MO**, FG sale rows cite the **DP**
  (decision 5). DM rows cite the DM.
- Printable MO view: invoice ref, then a per-category table — หมวด /
  % ที่ตั้ง / เป้ามูลค่า / เบิกจริง / ขาด — with a total row (owner
  decision 2026-10-26 via mockup comment: "มีรายละเอียดด้วย"), plus
  the FG received line. An MO listing lives in the
  tax-reports page between reports 1 and 2 — exact layout per the
  mockup artifact the owner will comment on before any UI is built.

### OB document

- doc_type 'OB', no invoice_id, one per tenant, issued once at system
  adoption (FacadeX: OB2601-001, doc_date 2026-01-01). Its lines are
  the opening lots: per item, per price layer, each the oldest lot of
  that item.
- No yearly re-issue. Lots cross year boundaries keeping their
  original purchase-document references; a period report's ยอดยกมา
  line is computed as of the period start. Year-end count differences
  are booked as adjustment documents citing the count sheet.
- The OB can carry an attachment / named source reference; FacadeX's
  OB attaches the legacy 31 ธ.ค. 2568 closing report PDF, and the
  datafix verifies every opening unit price in the DB against that
  PDF line-by-line (item code is the join key) before issuing the OB.
- Retro OB for FacadeX: OB2601-001 dated 2026-01-01 adopting the
  already-backfilled opening movements. Verified live 2026-10-26: the
  opening is cleanly marked — 725 movements with
  reference_type='opening_balance', notes "ยอดยกมาต้นปี 2569", posted
  2025-12-31 — while real Jan/Feb purchases carry
  reference_type='jan26_backfill'/'feb26_backfill' with supplier
  invoice numbers in notes. The OB adopts exactly the opening_balance
  rows; no ambiguity.
- Tenants without an OB [my call]: the card simply starts at its
  first movement; a ยอดยกมา line appears only where there is history
  before the period (computed) or an OB (adoption). A tenant adopting
  mid-stream with existing stock gets an OB when they load opening
  balances, same as FacadeX.

### Reports

- Report 1 (FG card): รับเข้า cites MO, จ่าย cites DP. No invoice
  numbers in labels anywhere (decision 7).
- Report 2 (RM): period view = official card with every รับ/จ่าย row
  citing its document and a running คงเหลือ; per-MO drill-down = the
  3-line view (decision 8).
- Tab layout (owner decisions 2026-10-26 via mockup comments): tabs
  renumber to 1–4 — 1. รายงานการตัดสินค้าสำเร็จรูป (FG) ·
  2. ใบสั่งผลิต (MO) · 3. รายงานตัดวัตถุดิบ (RM) ·
  4. รายงานสินค้าและวัตถุดิบ (รวม). Every tab name carries its
  abbreviation except the last; the page opens on tab 1 (today it
  opens on the combined report). Elsewhere in this document "report
  2 (RM)" refers to what is now tab 3.

### Datafix (decision 9) — FacadeX only

- Undo the 2026-10-17 cut (same guarded pattern as the IN2601-001
  spread-cut undo), then re-post through the new engine: OB2601-001,
  MO2601-001, DM2601-001 at FIFO prices, DP2601-001, dated 2026-01-06.
- Scope covers **every invoice cut posted before go-live**, not just
  IN2601-001 — the owner keeps cutting invoices in date order while
  this is built (owner decision 2026-10-26: "ตัดต่อเลย"), and each
  WAC-priced cut posted in the meantime gets refitted the same way
  (undo → re-post FIFO under its MO).
- Numbering (owner decision 2026-10-26: "ไม่เก็บฉบับเก่า"): the old
  DM/DP rows are hard-deleted and the same numbers re-issued, so the
  documents keep their numbers; no void/audit copy of the WAC version
  is kept.
- The all-tenant switch with a per-tenant valuation delta report was
  confirmed by the owner 2026-10-26.
- Dry-run first, verify the whole tenant's cards afterwards (not just
  touched items) — stock-backfill lessons apply.

## Constraints

- Migrations applied via MCP go live on CHANG instantly; dry-run
  everything, RLS self-reference and view-column-freeze traps apply.
- Standing rules: new worktree from origin/main; mockup artifact
  before building UI; test fully + artifact + dev server before push;
  subagents write BEGIN..ROLLBACK scripts, controller runs them.
- The vitest suite (2400+ tests) must stay green; the FIFO engine is
  pure-function tested like `inventoryCost.js` is today.

## Left to the builder

- Lot representation: derived by replay vs. materialized lots table —
  must keep back-dated (as-of) cuts, renumber-safe id-based
  references, and report-derivability.
- Where MO target/actual and the DM→MO / DP→MO links are stored.
- Whether opening lines get their own movement_type or stay
  purchase_in linked to the OB.
- How transfer_in carries lot identity (rare under the central-site
  rule).
- Exact UI, after the owner approves the mockup.
