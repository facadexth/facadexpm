# Finished-Goods Tracking + Statutory Tax Stock Reports — Design

## Context

FacadeX already has a working raw-material stock-deduction system (`record_stock_movement`,
`stock_movements`, `inventory_stock_balances`, the ตัดสต็อกจากใบแจ้งหนี้ tab / `InvoiceDeductionRow`
in `src/pages/Inventory.jsx`) that splits an invoice's subtotal into raw-material categories by %
and posts WAC-costed deductions. It has no concept of "finished goods" — every `inventory_items`
row is implicitly a raw material.

The owner needs this extended for Thai tax filing: a "finished good" per quotation line (e.g. one
ประตูหน้าต่าง item), deducted fractionally as invoices bill against it, plus formal reports.

## Legal basis (researched, not assumed)

- ประมวลรัษฎากร มาตรา 87(3): every VAT-registered seller of goods must keep a "รายงานสินค้าและ
  วัตถุดิบ" (Report of Goods and Raw Materials), one per place of business.
- Format set by ประกาศอธิบดีกรมสรรพากรเกี่ยวกับ VAT ฉบับที่ 89 (base) and ฉบับที่ 104 (amendment).
  The statutory template is a classic stock card: **วันเดือนปี | รายการ/ชนิดสินค้า | หน่วยนับ |
  เลขที่เอกสารอ้างอิง | จำนวนรับเข้า | จำนวนจำหน่ายออก | จำนวนคงเหลือ**. Practitioners commonly add
  value (บาท) columns alongside quantity for costing/audit — this design does that.
- มาตรา 87 วรรค 4: movements must be entered within **3 business days** of the transaction.
- มาตรา 87/3: reports + supporting documents must be retained **≥5 years**.
- ฉบับที่ 104: physical stock count required **twice yearly** (30 มิ.ย. / 31 ธ.ค.) — out of scope
  for this change (a manual process), noted here only so it isn't mistaken for a gap.
- The statute does **not** require separate finished-goods vs. raw-material reports — one report
  per place of business, all SKUs together. Report 3 below (combined) is the literal statutory
  report; Reports 1–2 are supplementary breakdowns for internal review, requested explicitly by
  the owner.
- Cost basis: WAC and FIFO are both compliant under Thai TFRS (TAS 2, mirrors IAS 2/IFRS — LIFO is
  not permitted). The system already uses WAC end to end
  (`record_stock_movement`'s `v_new_wac := (old_qty*old_wac + qty*unit_cost)/(old_qty+qty)`). No
  change needed; confirmed compliant.

## Decisions already made (do not re-litigate these during implementation)

1. **Finished-goods valuation basis**: NOT the full contract/sale value. Uses the SAME
   `% ต้นทุนวัสดุ` (`materialPct`) the owner already reviews and can edit per invoice in
   `InvoiceDeductionRow`, default 70 (from `app_settings` / `useInventoryCogsSettings`). No new
   setting. `finished_goods_cost = quotation_item.line_total × (materialPct / 100)`.
2. **Posting moment**: at the SAME click as the existing raw-material deduction confirm — inside
   `InvoiceDeductionRow.confirm()` — not silently at invoice creation. The owner already reviews
   `materialPct` there before confirming; that review now also governs the finished-goods entry.
   Nothing changes about the existing raw-material deduction logic or its `plan.steps`.
3. **Quantity/portion math**: `qty_sold_this_invoice (ชุด) = invoice_item.line_total /
   quotation_item.line_total`. This is independent of the cost%, already exists in the schema, no
   new tracking mechanism needed.
4. **Granularity**: line-level (1 quotation line = 1 finished-goods SKU = 1.0 ชุด total), not
   unit-level (`quotation_item_units`/`invoice_item_draws`). Matches the owner's own example
   ("รายการประตูหน้าต่าง 1 รายการ ... ตัดขายไปเป็น 0.1 ชุด").
5. **Existing raw-material deduction is untouched** — additive only, runs alongside.

## Data model change

```sql
alter table inventory_items add column item_kind text not null default 'raw_material'
  check (item_kind in ('raw_material', 'finished_goods'));
alter table inventory_items add column quotation_item_id uuid references quotation_items(id) on delete set null;
create unique index inventory_items_finished_goods_unique
  on inventory_items (tenant_id, quotation_item_id) where item_kind = 'finished_goods';
```

Finished-goods rows: `base_unit = 'ชุด'`, `unit_conversion_mode = 'plain'`, `category_id = null`,
`code = quotation.quotation_number || '-' || quotation_item.sort_order` (e.g. `QT2609-040-1`),
`name = quotation_item.description`. Their `inventory_stock_balances.site_id` = the invoice's own
`site_id` (already exists as an FK target, no schema change needed there) — gives a useful
per-project finished-goods ledger as a side effect.

No new RPC. `record_stock_movement` already supports `adjustment` (used for the lazy "รับเข้า 1
ชุด" opening entry, first time only) and `sale_out` (used for each invoice's fractional
deduction) exactly as-is. It has no `item_kind` awareness and needs none — it operates on
`inventory_item_id` regardless of kind.

## Business logic change

In `InvoiceDeductionRow.confirm()` (`src/pages/Inventory.jsx:366-390`), after the existing
raw-material `plan.steps` loop succeeds and before `onConfirmed()`:

1. Fetch this invoice's `invoice_items` joined to `quotation_items` (`item_type = 'item'` only,
   skip `item_description` rows), for `quotation_item_id, line_total` on both sides and
   `quotation_items.description`. Also skip any row where `invoice_items.quotation_item_id` is
   null (a line not tied to a quotation, if that's ever possible) — finished-goods tracking only
   applies to quotation-sourced lines; there is nothing to key the SKU off otherwise.
2. For each line: find or lazily create the matching `inventory_items` row
   (`item_kind='finished_goods', quotation_item_id=<id>`). On first creation, post one
   `record_stock_movement(movement_type='adjustment', quantity=1.0,
   unit_cost=quotation_item.line_total * materialPct/100, reference_type='quotation',
   reference_id=quotation.id)` — the "รับเข้า 1 ชุด" opening entry, valued at the same % basis so
   the WAC stays consistent from the first movement.
3. Post `record_stock_movement(movement_type='sale_out', quantity=invoice_item.line_total /
   quotation_item.line_total, unit_cost=quotation_item.line_total * materialPct/100,
   reference_type='invoice', reference_id=invoice.id, notes=invoice.invoice_number)`.
4. Idempotency: reuses the same `reference_type='invoice', reference_id=invoice.id` guard already
   checked earlier in `confirm()` (`Inventory.jsx:371-374`) — since that check runs before both the
   raw-material and finished-goods steps in the same function call, no separate guard is needed.
5. Failure handling: if a finished-goods step throws after raw-material steps already committed,
   surface the same existing catch-and-alert pattern (`Inventory.jsx:388`) — raw-material
   deductions are NOT rolled back (matches existing behavior for partial raw-material failures;
   `stock_movements` is an append-only audit ledger, not a transaction boundary).

`invoice.quotation_id` is already selected by `useUnprocessedInvoices()`'s `select('*')`
(`src/hooks/useSupabase.js:259-277`) — no query change needed there.

## The 3 reports

New subtab `🧾 รายงานภาษี` in `src/pages/Inventory.jsx`'s `view` state (alongside `items` /
`invoice_deduction` / `profiles` / `movements`), with three sub-views sharing one date-range +
category filter control bar (reuse the filter UI already built for the `movements` view).

All three are pure queries over the existing `stock_movements` / `inventory_stock_balances` /
`inventory_items` tables — no new tables for reporting, no snapshot/materialized rollup needed at
current data volume (fully computable live: opening = signed sum of all movements before range
start, in/out = sums within range, closing = opening + in − out).

**Report 1 — รายงานการตัดสินค้าสำเร็จรูป** (`inventory_items.item_kind = 'finished_goods'`)
Columns: วันที่ | รหัสสินค้า (QT code + line suffix) | รายการ | หน่วยนับ (ชุด) | เลขที่อ้างอิง (IV
number, from `stock_movements.notes` or a join through `reference_id` to `invoices.invoice_number`
when `reference_type='invoice'`) | ประเภท (รับเข้า/ขายออก) | จำนวนรับเข้า | มูลค่ารับเข้า |
จำนวนขายออก | มูลค่าขายออก | จำนวนคงเหลือ | มูลค่าคงเหลือ. Category filter is a no-op here (finished
goods have no `category_id`) — keep the control for UI consistency with the other two reports.

**Report 2 — รายงานตัดวัตถุดิบ** (`item_kind = 'raw_material'`, itemized per movement)
Same column shape as Report 1, keyed on real `inventory_items`/`expense_categories`; effectively
the existing ประวัติการเคลื่อนไหว tab with an `item_kind` filter (default `raw_material`) and a
join to the originating invoice number for audit trace-back.

**Report 3 — รายงานสินค้าและวัตถุดิบ (รวม)** — the literal statutory report. Both kinds combined,
same stock-card layout, grouped by SKU, opening/closing balance by qty AND value for the selected
period.

## Testing

- Unit-test the fractional math (`invoice_item.line_total / quotation_item.line_total`, and the
  materialPct-scaled unit cost) in isolation — pure function, extract alongside
  `computeInvoiceDeductionPlan` in `src/lib/inventoryCost.js` rather than inlining in the
  component, so it's independently testable.
- Integration path: create a disposable quotation + invoice (small, real client/site) in a test
  run, confirm ตัดสต็อก once, assert both the raw-material movements AND the new finished-goods
  movements landed with the expected qty/value, then confirm a second partial invoice against the
  same quotation line and assert the finished-goods balance decreases further (not reset) and the
  existing item is reused (not duplicated) via the unique index.
- Verify the idempotency guard still fires correctly (re-opening an already-confirmed invoice's
  row and attempting confirm again must not double-post either raw-material or finished-goods
  movements).
