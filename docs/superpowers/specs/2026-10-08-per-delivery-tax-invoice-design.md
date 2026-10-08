# Supplier tax invoice per delivery (ใบกำกับภาษี 1 ใบต่อ 1 การส่งของ) — design

Date: 2026-10-08 · Status: draft for owner review · Builds on `2026-10-06-supplier-tax-invoice-matching-design.md` (live) and `2026-10-07-po-deposit-and-partial-receipt-design.md` (live as of 2026-10-08)

## 1. What the owner asked (condensed)
- Suppliers (e.g. CAC) deliver a PO in **lots**. Each lot arrives **with its own tax invoice**, and the invoice number differs per lot (it follows the supplier's numbering).
- Add an **option**: one tax invoice per delivery. **Default stays one tax invoice per PO** (today's behaviour).
- Stock should follow the **goods delivered**: when a lot arrives with its invoice, that lot's stock enters from that lot's invoice.

## 2. Today (verified in code and live schema)
- `supplier_tax_invoice_pos(invoice_id, po_id)` links an invoice to whole POs; a PO can be in one active invoice (`stip_po_active_uq`). Only `received` POs are eligible, so a partially received PO cannot be matched.
- `post_supplier_tax_invoice` reverses the stock movements of **the whole PO** (`reference_type='purchase_order'`, `reference_id=<po>`) and posts the invoice lines; it stamps the invoice number on the PO's bills (all bills, including split rows, since migration 03).
- Each goods receipt (`po_receipts`) already knows its bill (`expense_id`), its goods value (`goods_subtotal`, `goods_vat`) and its stock (`po_receipt_items.stock_movement_id`). That is what makes a per-delivery link possible without touching the receive flow.
- `purchase_orders.stock_from_invoice` already exists: a PO receipt posts no stock and the invoice posts it.

## 3. Proposed design

### 3.1 A mode on the PO
`purchase_orders.tax_invoice_mode` text, `'po'` (default) or `'delivery'`.
- Set on the PO form (a small choice next to the existing "stock from invoice" choice) and changeable from the ⋯ menu **only while the PO has no receipt and no active invoice**.
- Optional convenience (open question Q1): remember the mode per supplier and pre-select it for that supplier's new POs.
- `'po'` POs behave exactly as today. Nothing existing changes meaning.

### 3.2 Data (additive)
- New `supplier_tax_invoice_receipts(tenant_id, invoice_id, receipt_id)` with a partial unique index so a receipt is in at most one non-void invoice (same pattern as `supplier_tax_invoice_pos`). Named FKs, RLS and grants like the existing link table (clients read only, RPCs write).
- An invoice links **either** POs **or** receipts, never both (validation trigger + RPC check), so the two worlds never mix inside one invoice.
- Several receipts (even of different POs of the same supplier) may be linked to one invoice, and one PO's receipts may go to different invoices.

### 3.3 Eligibility and matching
- A receipt is eligible when: its PO is in `'delivery'` mode, same supplier as the invoice, the receipt is not already in an active invoice, and it has a bill (or is fully covered by a deposit and has none — then the stamp step has nothing to stamp).
- A `'delivery'` PO may be `partially_received`; it never needs to be fully received (the R7 rule applies only to `'po'` mode).
- Match rule: invoice net before VAT vs Σ `goods_subtotal` of the linked receipts, same tolerance as today (max 1% / 5 baht, reason required beyond it). The comparison also accepts the VAT-inclusive basis (invoice total vs Σ(`goods_subtotal`+`goods_vat`)), because supplier documents mix both bases.

### 3.4 Posting and void (extend the two existing RPCs, keep their contracts)
- Post: post the invoice lines as stock (as today), then reverse **only the linked receipts' stock movements** (found through `po_receipt_items.stock_movement_id`), with the same exact weighted-average inverse and the same "never an exception, flagged in preview" rule. Record the reversals per receipt. Stamp the invoice number on **that receipt's bill and its split children** (reusing the stamps table), leave the PO's other bills alone.
- A receipt with no stock (PO flagged `stock_from_invoice`, or non-stock lines) has nothing to reverse; the invoice lines simply add stock.
- Void: restore only that invoice's reversed movements and stamped bills; other receipts and invoices are untouched.
- PO status is never changed by posting; a `'delivery'` PO stays `partially_received` until its last receipt.

### 3.5 Stock follows the delivered lot
For a `'delivery'` PO, the ideal one-step flow is: receive the lot, key (or scan) that lot's invoice, post.
- In the receive dialog add an optional checkbox "ลงใบกำกับภาษีของล็อตนี้ต่อทันที". After the receipt succeeds it opens the supplier tax invoice form with the new receipt already selected and lines prefilled from the PO lines of the receipt (or from a scan).
- Stock policy per PO stays the owner's existing choice: either stock enters at receipt (and is replaced by the invoice's lines when the invoice posts), or `stock_from_invoice` (stock enters only when the lot's invoice posts).

### 3.6 UI
- Supplier tax invoice form: a switch "ผูกกับ: ใบสั่งซื้อ | การส่งของ". In delivery mode the picker lists the supplier's un-invoiced receipts (PO number, receipt number `PO-R<n>`, date, goods value) instead of POs, with a running Σ against the invoice net.
- PO popup: each receipt shows its invoice number once linked ("ใบกำกับ <no>") and a button to start an invoice for it.
- Swap-invoice action: stays for `'po'` mode single-bill POs; for `'delivery'` POs the per-receipt invoice form replaces it.

## 4. Safety and compatibility
- All changes additive; migration `2026-10-0x-04` after the three live ones. `'po'` mode code paths keep their current function bodies; the new branches are guarded by the invoice's link type.
- Same locking order as today (PO row, then expenses in id order, then balances in item order); the receipt-level links are locked after the PO row.
- A receipt already in a posted invoice cannot be edited or have its bill deleted (existing triggers extended to the new link table).
- Web is fail-soft before the migration (new switch hidden when the link table is missing), like the earlier release.

## 5. Out of scope (v1)
- Changing the mode after a receipt exists; mixing PO-level and delivery-level links in one invoice.
- Credit notes against a delivery invoice (use the existing supplier credit note feature).
- PEAK export of the invoice document (expenses export as today; duplicate supplier invoice numbers across split bills remain an unverified PEAK behaviour).

## 6. Testing
Rolled-back SQL tests (house style): delivery-mode post with one receipt of a two-receipt PO; two receipts of different POs in one invoice; void restores only those receipts; stock reversal exactness incl. balance reaching 0 and below 0 warnings; a receipt cannot be linked twice; mixed link types rejected; `'po'` mode behaviour unchanged (re-run the existing tax-invoice, deposit and receipt tests); cross-tenant and role gates. vitest for the matching maths (both VAT bases) and the eligibility helper. Playwright harness for the form switch and the "ต่อทันที" flow. Whole-branch review before applying, then a live check on a test tenant.

## 7. Open questions for the owner
1. Remember the mode per supplier (e.g. CAC always `delivery`)? Proposed: yes, as a default on the supplier, still changeable per PO.
2. Should "ลงใบกำกับภาษีของล็อตนี้ต่อทันที" be ticked by default for `delivery` POs? Proposed: yes.
3. If a lot arrives **before** its invoice (invoice follows days later): proposed to allow linking later (receipt stays un-invoiced, flagged in the list "รอใบกำกับ"). Confirm.
4. For `delivery` POs with stock-from-invoice: is it acceptable that lot stock stays out of inventory until its invoice is posted?
