-- supabase/migrations/2026-09-10-02-inventory-item-auto-code.sql
--
-- Auto-generates inventory_items.code from its category's short prefix +
-- a running number scoped to that category, e.g. category "อุปกรณ์" with
-- code_prefix 'OPK' -> OPK-001, OPK-002, ... Mirrors the existing
-- MAX(numeric suffix)+1 pattern used by generate_invoice_no() etc.
-- (2026-08-14-02-fix-remaining-number-gap-bugs.sql) -- gap-immune, and
-- like those triggers, non-SECURITY-DEFINER so its MAX() lookup runs
-- under the calling user's own RLS (tenant-scoped automatically).
--
-- Only fires when code is left blank AND the item's category has a
-- code_prefix set -- an item with no category, or whose category hasn't
-- been given a prefix yet, keeps the old fully-manual behavior. Only a
-- BEFORE INSERT trigger (not UPDATE), so editing an existing item never
-- overwrites a manually-typed or already-assigned code.

ALTER TABLE expense_categories ADD COLUMN code_prefix TEXT;

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

      NEW.code := v_prefix || '-' || LPAD(v_seq_num::TEXT, 3, '0');
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_generate_inventory_item_code
  BEFORE INSERT ON inventory_items
  FOR EACH ROW EXECUTE FUNCTION generate_inventory_item_code();
