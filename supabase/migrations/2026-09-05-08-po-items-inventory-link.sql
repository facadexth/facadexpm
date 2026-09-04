-- Inventory Phase 1, part 3/3: link purchase_order_items to inventory_items
-- Adds nullable FK column so PO lines can be linked to inventory items (pure stock effect, no expense).

ALTER TABLE purchase_order_items ADD COLUMN inventory_item_id UUID REFERENCES inventory_items(id) ON DELETE SET NULL;
CREATE INDEX idx_purchase_order_items_inventory_item_id ON purchase_order_items(inventory_item_id);
