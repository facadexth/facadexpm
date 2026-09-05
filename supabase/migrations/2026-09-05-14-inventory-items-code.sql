-- ============================================================
-- Add code (รหัสสินค้า) free-text field to inventory_items, for
-- referencing items by a short internal code.
-- ============================================================

ALTER TABLE inventory_items ADD COLUMN code TEXT;
