-- supabase/migrations/2026-10-31-02-alu-parts-stock-link.sql
-- Hardware sets from stock (spec section 12). A catalogue part (alu_parts) may point at one stock item
-- (inventory_items); at most one part per stock item. Three functions, all SECURITY INVOKER (the caller's RLS applies):
--   stock_item_purchase_prices(p_item_ids)  read only: the latest purchase price of each stock item per date, ex-VAT,
--                                            per the item's base unit (posted supplier tax invoices, then purchase orders)
--   alu_add_stock_item_to_set(...)          find-or-create the part of a stock item, then put it in a hardware set
--   alu_add_new_part_to_set(...)            a new part that is not in stock (name, unit, optional price) into a set
-- Additive. The foreign key keeps the default action (NO ACTION). No view reads alu_parts (checked 2026-10-31).
-- The words the SQL runner refuses never appear in this file (vitest guard: src/lib/migrationFiles20261031.test.js).

ALTER TABLE alu_parts ADD COLUMN inventory_item_id UUID REFERENCES inventory_items(id);
-- an inventory item belongs to one tenant, so "one part per item" is also "one per item per tenant"
CREATE UNIQUE INDEX uq_alu_parts_inventory_item ON alu_parts (inventory_item_id) WHERE inventory_item_id IS NOT NULL;

-- p_item_ids NULL = every stock item that a catalogue part points at (what the estimation engine loads).
-- One row per (item, date, source): the last line of that day. Tax invoice lines: base_unit_cost (= line amount / base
-- quantity; the line amounts add up to net_before_vat, so it is ex-VAT). PO lines: unit price after the line discount,
-- divided by 1.07 when the PO price includes VAT; only lines in the item's base unit (no unit conversion here).
CREATE OR REPLACE FUNCTION stock_item_purchase_prices(p_item_ids UUID[] DEFAULT NULL)
RETURNS TABLE (id TEXT, inventory_item_id UUID, unit_cost NUMERIC, effective_from DATE, source TEXT, doc_no TEXT)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  WITH wanted AS (
    SELECT i.id, i.base_unit FROM inventory_items i
     WHERE (p_item_ids IS NULL AND EXISTS (SELECT 1 FROM alu_parts p WHERE p.inventory_item_id = i.id))
        OR i.id = ANY (COALESCE(p_item_ids, '{}'::uuid[]))
  ),
  sti AS (
    SELECT DISTINCT ON (li.inventory_item_id, inv.invoice_date)
           'sti:' || li.id::text AS id, li.inventory_item_id, li.base_unit_cost AS unit_cost,
           inv.invoice_date AS effective_from, 'tax_invoice'::text AS source, inv.invoice_no AS doc_no
      FROM supplier_tax_invoice_items li
      JOIN wanted w ON w.id = li.inventory_item_id
      JOIN supplier_tax_invoices inv ON inv.id = li.invoice_id AND inv.status = 'posted'
     WHERE li.base_unit_cost IS NOT NULL
     ORDER BY li.inventory_item_id, inv.invoice_date, inv.posted_at DESC NULLS LAST, li.sort_order DESC
  ),
  po AS (
    SELECT DISTINCT ON (li.inventory_item_id, o.date)
           'poi:' || li.id::text AS id, li.inventory_item_id,
           round(li.unit_price * (1 - COALESCE(li.discount_pct, 0) / 100)
                 / CASE WHEN o.has_vat AND o.price_includes_vat THEN 1.07 ELSE 1 END, 4) AS unit_cost,
           o.date AS effective_from, 'po'::text AS source, o.po_number AS doc_no
      FROM purchase_order_items li
      JOIN wanted w ON w.id = li.inventory_item_id
      JOIN purchase_orders o ON o.id = li.po_id AND o.status <> 'cancelled'
     WHERE li.unit_price > 0 AND (NULLIF(btrim(li.unit), '') IS NULL OR btrim(li.unit) = btrim(w.base_unit))
     ORDER BY li.inventory_item_id, o.date, o.created_at DESC NULLS LAST, li.sort_order DESC
  )
  SELECT * FROM sti
  UNION ALL
  SELECT * FROM po
$$;

-- Returns { part_id, added }: added = false when the set already held that part (nothing changes then).
CREATE OR REPLACE FUNCTION alu_add_stock_item_to_set(p_set_id UUID, p_inventory_item_id UUID, p_kind TEXT, p_quantity NUMERIC DEFAULT 1)
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE
  v_tenant UUID := current_tenant_id();
  v_kind   TEXT;
  v_name   TEXT;
  v_unit   TEXT;
  v_part   UUID;
  v_added  BOOLEAN := false;
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('hardware', 'accessory') THEN RAISE EXCEPTION 'bad_kind'; END IF;
  IF p_quantity IS NULL OR NOT (p_quantity > 0 AND p_quantity < 'Infinity'::numeric) THEN RAISE EXCEPTION 'bad_quantity'; END IF;
  SELECT kind INTO v_kind FROM alu_parts WHERE id = p_set_id AND tenant_id = v_tenant;
  IF v_kind IS DISTINCT FROM 'hardware_set' THEN RAISE EXCEPTION 'not_a_set'; END IF;
  SELECT name, base_unit INTO v_name, v_unit FROM inventory_items WHERE id = p_inventory_item_id AND tenant_id = v_tenant;
  IF NOT FOUND THEN RAISE EXCEPTION 'item_not_found'; END IF;
  SELECT id INTO v_part FROM alu_parts WHERE inventory_item_id = p_inventory_item_id AND tenant_id = v_tenant;
  IF v_part IS NULL THEN
    INSERT INTO alu_parts (tenant_id, name, kind, unit, inventory_item_id)
    VALUES (v_tenant, v_name, p_kind, v_unit, p_inventory_item_id)
    RETURNING id INTO v_part;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM alu_part_set_items WHERE set_id = p_set_id AND part_id = v_part) THEN
    INSERT INTO alu_part_set_items (tenant_id, set_id, part_id, quantity) VALUES (v_tenant, p_set_id, v_part, p_quantity);
    v_added := true;
  END IF;
  RETURN jsonb_build_object('part_id', v_part, 'added', v_added);
END $$;

-- A part that is not in stock: created here (code P-nnnn by the existing trigger), priced from p_price_date when a
-- price is given, and put in the set. Returns { part_id }.
CREATE OR REPLACE FUNCTION alu_add_new_part_to_set(p_set_id UUID, p_name TEXT, p_unit TEXT, p_kind TEXT,
                                                   p_quantity NUMERIC DEFAULT 1, p_price NUMERIC DEFAULT NULL, p_price_date DATE DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE
  v_tenant UUID := current_tenant_id();
  v_kind   TEXT;
  v_part   UUID;
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('hardware', 'accessory') THEN RAISE EXCEPTION 'bad_kind'; END IF;
  IF COALESCE(btrim(p_name), '') = '' OR COALESCE(btrim(p_unit), '') = '' THEN RAISE EXCEPTION 'bad_name'; END IF;
  IF p_quantity IS NULL OR NOT (p_quantity > 0 AND p_quantity < 'Infinity'::numeric) THEN RAISE EXCEPTION 'bad_quantity'; END IF;
  IF p_price IS NOT NULL AND (NOT (p_price >= 0 AND p_price < 'Infinity'::numeric) OR p_price_date IS NULL) THEN RAISE EXCEPTION 'bad_price'; END IF;
  SELECT kind INTO v_kind FROM alu_parts WHERE id = p_set_id AND tenant_id = v_tenant;
  IF v_kind IS DISTINCT FROM 'hardware_set' THEN RAISE EXCEPTION 'not_a_set'; END IF;
  INSERT INTO alu_parts (tenant_id, name, kind, unit) VALUES (v_tenant, btrim(p_name), p_kind, btrim(p_unit)) RETURNING id INTO v_part;
  IF p_price IS NOT NULL THEN
    INSERT INTO alu_part_prices (tenant_id, part_id, list_price, discount_pct, effective_from, source)
    VALUES (v_tenant, v_part, p_price, 0, p_price_date, 'manual');
  END IF;
  INSERT INTO alu_part_set_items (tenant_id, set_id, part_id, quantity) VALUES (v_tenant, p_set_id, v_part, p_quantity);
  RETURN jsonb_build_object('part_id', v_part);
END $$;

REVOKE ALL ON FUNCTION stock_item_purchase_prices(UUID[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION alu_add_stock_item_to_set(UUID, UUID, TEXT, NUMERIC) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION alu_add_new_part_to_set(UUID, TEXT, TEXT, TEXT, NUMERIC, NUMERIC, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION stock_item_purchase_prices(UUID[]) TO authenticated;
GRANT EXECUTE ON FUNCTION alu_add_stock_item_to_set(UUID, UUID, TEXT, NUMERIC) TO authenticated;
GRANT EXECUTE ON FUNCTION alu_add_new_part_to_set(UUID, TEXT, TEXT, TEXT, NUMERIC, NUMERIC, DATE) TO authenticated;
