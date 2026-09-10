-- supabase/migrations/2026-09-10-03-inventory-item-code-4-digit-padding.sql
--
-- generate_inventory_item_code() (2026-09-10-02) zero-pads the running
-- number to 3 digits (OPK-001). By the time this shipped, the user had
-- already hand-assigned codes to all 7 existing items across the two
-- categories with a prefix set (กระจก/GL, อุปกรณ์/HW) using 4-digit
-- padding -- GL-0001, GL-0002, HW-0001..HW-0005. Match that convention
-- so future auto-generated codes stay consistent with what's already in
-- the system instead of clashing (HW-0005 next to a new HW-006).
--
-- Only affects NEW items with a blank code -- the trigger never
-- touches an already-assigned code, so the 7 existing rows are
-- untouched by this migration.
CREATE OR REPLACE FUNCTION generate_inventory_item_code()
RETURNS TRIGGER AS $$
DECLARE
  v_prefix TEXT;
  v_seq_num INT;
BEGIN
  IF NEW.code IS NULL OR NEW.code = '' THEN
    IF NEW.category_id IS NOT NULL THEN
      SELECT code_prefix INTO v_prefix FROM expense_categories WHERE id = NEW.category_id;
    END IF;

    IF v_prefix IS NOT NULL AND v_prefix != '' THEN
      SELECT COALESCE(MAX(SUBSTRING(code FROM '-([0-9]+)$')::INT), 0) + 1
      INTO v_seq_num
      FROM inventory_items
      WHERE category_id = NEW.category_id AND code LIKE v_prefix || '-%';

      NEW.code := v_prefix || '-' || LPAD(v_seq_num::TEXT, 4, '0');
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
