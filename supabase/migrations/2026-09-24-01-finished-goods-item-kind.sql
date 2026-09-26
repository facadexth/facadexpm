-- Adds a "finished goods" concept to inventory_items, additive to the
-- existing raw-material-only model. A finished-goods row represents one
-- quotation line (quotation_item_id), tracked in "ชุด" (sets), deducted
-- fractionally as invoices bill against that line -- see
-- docs/superpowers/specs/2026-09-24-finished-goods-tax-stock-reports-design.md.
alter table inventory_items add column item_kind text not null default 'raw_material'
  check (item_kind in ('raw_material', 'finished_goods'));
alter table inventory_items add column quotation_item_id uuid references quotation_items(id) on delete set null;

-- At most one finished-goods SKU per quotation line per tenant -- the
-- confirm-flow find-or-create logic (Task 3) relies on this being
-- enforced by the database, not just application logic.
create unique index inventory_items_finished_goods_unique
  on inventory_items (tenant_id, quotation_item_id)
  where item_kind = 'finished_goods';
