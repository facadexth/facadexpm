-- ============================================================
-- Add ordered_by (ชื่อผู้สั่ง) free-text field to purchase_orders.
-- ============================================================

ALTER TABLE purchase_orders ADD COLUMN ordered_by TEXT;
