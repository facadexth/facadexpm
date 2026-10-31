-- Dry run for 2026-10-31-02 (controller only). Replays the migration verbatim, exercises the functions as the
-- OWNER of tenant 1b9affc4 (role authenticated, request.jwt.claims email), and always rolls back via the final RAISE.
BEGIN;

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

-- ===================== checks (dry run only) =====================
CREATE TEMP TABLE _res (n SERIAL, line TEXT);
-- the checks below run under SET ROLE authenticated, which must be able to write the results table
GRANT ALL ON _res TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE _res_n_seq TO authenticated;

DO $t$
DECLARE
  v_t     UUID := '1b9affc4-2136-4ed1-b168-a36e6624e743'::uuid;
  v_mail  TEXT;
  v_item  UUID;
  v_set1  UUID;
  v_set2  UUID;
  res1    JSONB;
  res2    JSONB;
  res3    JSONB;
  res4    JSONB;
  n       INT;
  txt     TEXT;
  r       RECORD;
BEGIN
  INSERT INTO _res(line) VALUES (CASE WHEN EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'uq_alu_parts_inventory_item')
    THEN 'PASS 1 unique index on alu_parts.inventory_item_id' ELSE 'FAIL 1 index missing' END);

  INSERT INTO _res(line) VALUES (CASE WHEN
        NOT has_function_privilege('anon', 'public.stock_item_purchase_prices(uuid[])', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.alu_add_stock_item_to_set(uuid,uuid,text,numeric)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.alu_add_new_part_to_set(uuid,text,text,text,numeric,numeric,date)', 'EXECUTE')
    AND has_function_privilege('authenticated', 'public.stock_item_purchase_prices(uuid[])', 'EXECUTE')
    AND has_function_privilege('authenticated', 'public.alu_add_stock_item_to_set(uuid,uuid,text,numeric)', 'EXECUTE')
    AND has_function_privilege('authenticated', 'public.alu_add_new_part_to_set(uuid,text,text,text,numeric,numeric,date)', 'EXECUTE')
    THEN 'PASS 2 grants: authenticated only' ELSE 'FAIL 2 grants' END);

  SELECT string_agg(DISTINCT v.relname, ', ') INTO txt
    FROM pg_depend d JOIN pg_rewrite rw ON rw.oid = d.objid JOIN pg_class v ON v.oid = rw.ev_class
    JOIN pg_class t ON t.oid = d.refobjid
   WHERE t.relnamespace = 'public'::regnamespace AND t.relname = 'alu_parts' AND v.oid <> t.oid;
  INSERT INTO _res(line) VALUES (CASE WHEN txt IS NULL THEN 'PASS 3 no view depends on alu_parts' ELSE 'FAIL 3 views: ' || txt END);

  -- posted tax invoices whose lines do not add up to net_before_vat (then base_unit_cost might not be ex-VAT)
  SELECT count(*) INTO n FROM supplier_tax_invoices inv
   WHERE inv.status = 'posted'
     AND abs(COALESCE((SELECT sum(amount) FROM supplier_tax_invoice_items li WHERE li.invoice_id = inv.id), 0) - inv.net_before_vat) > 1;
  INSERT INTO _res(line) VALUES (CASE WHEN n = 0 THEN 'PASS 4 every posted tax invoice: lines add up to net_before_vat (ex-VAT)'
    ELSE 'info 4 posted invoices whose lines differ from net_before_vat by > 1 baht: ' || n || ' (look before trusting base_unit_cost)' END);

  -- the stock item with the most recent posted tax invoice line in category อุปกรณ์ (falls back to any active item)
  SELECT li.inventory_item_id INTO v_item
    FROM supplier_tax_invoice_items li JOIN supplier_tax_invoices inv ON inv.id = li.invoice_id AND inv.status = 'posted'
    JOIN inventory_items i ON i.id = li.inventory_item_id JOIN expense_categories c ON c.id = i.category_id AND c.name = 'อุปกรณ์'
   WHERE inv.tenant_id = v_t ORDER BY inv.invoice_date DESC LIMIT 1;
  IF v_item IS NULL THEN SELECT id INTO v_item FROM inventory_items WHERE tenant_id = v_t AND active ORDER BY name LIMIT 1; END IF;

  SELECT user_email INTO v_mail FROM user_roles WHERE tenant_id = v_t AND role = 'OWNER' ORDER BY user_email LIMIT 1;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated', 'email', v_mail)::text, true);
  EXECUTE 'SET LOCAL role authenticated';

  FOR r IN SELECT * FROM stock_item_purchase_prices(ARRAY[v_item]) ORDER BY effective_from DESC LIMIT 3 LOOP
    INSERT INTO _res(line) VALUES (format('info 5 price row %s %s %s %s (%s)', r.source, r.effective_from, r.unit_cost, r.doc_no, r.id));
  END LOOP;

  INSERT INTO alu_parts (name, kind, unit) VALUES ('dry-run set 1', 'hardware_set', 'ชุด') RETURNING id INTO v_set1;
  INSERT INTO alu_parts (name, kind, unit) VALUES ('dry-run set 2', 'hardware_set', 'ชุด') RETURNING id INTO v_set2;
  res1 := alu_add_stock_item_to_set(v_set1, v_item, 'hardware', 2);
  res2 := alu_add_stock_item_to_set(v_set1, v_item, 'hardware', 5);
  res3 := alu_add_stock_item_to_set(v_set2, v_item, 'accessory', 1);
  SELECT count(*) INTO n FROM alu_parts WHERE inventory_item_id = v_item;
  INSERT INTO _res(line) VALUES (CASE WHEN (res1->>'added')::boolean AND NOT (res2->>'added')::boolean AND (res3->>'added')::boolean
      AND res1->>'part_id' = res2->>'part_id' AND res1->>'part_id' = res3->>'part_id' AND n = 1
      AND (SELECT quantity FROM alu_part_set_items WHERE set_id = v_set1 AND part_id = (res1->>'part_id')::uuid) = 2
    THEN 'PASS 6 one part per stock item, reused across sets, a second add changes nothing'
    ELSE format('FAIL 6 %s %s %s parts=%s', res1, res2, res3, n) END);

  SELECT count(*) INTO n FROM stock_item_purchase_prices(NULL) WHERE inventory_item_id = v_item;
  INSERT INTO _res(line) VALUES ('info 7 engine rows for the linked item: ' || n);

  res4 := alu_add_new_part_to_set(v_set1, 'dry-run new part', 'ชิ้น', 'accessory', 3, 12.5, DATE '2026-10-31');
  INSERT INTO _res(line) VALUES (CASE WHEN EXISTS (SELECT 1 FROM alu_part_prices WHERE part_id = (res4->>'part_id')::uuid AND list_price = 12.5 AND effective_from = DATE '2026-10-31')
      AND EXISTS (SELECT 1 FROM alu_part_set_items WHERE set_id = v_set1 AND part_id = (res4->>'part_id')::uuid AND quantity = 3)
      AND (SELECT kind FROM alu_parts WHERE id = (res4->>'part_id')::uuid) = 'accessory'
    THEN 'PASS 8 new part with a price lands in the set' ELSE 'FAIL 8 ' || res4 END);

  BEGIN
    PERFORM alu_add_stock_item_to_set(v_set1, v_item, 'hardware_set', 1);
    INSERT INTO _res(line) VALUES ('FAIL 9 bad kind accepted');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _res(line) VALUES (CASE WHEN SQLERRM = 'bad_kind' THEN 'PASS 9 bad_kind refused' ELSE 'FAIL 9 ' || SQLERRM END);
  END;
  BEGIN
    PERFORM alu_add_stock_item_to_set(v_item, v_item, 'hardware', 1);
    INSERT INTO _res(line) VALUES ('FAIL 10 a non-set accepted');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO _res(line) VALUES (CASE WHEN SQLERRM = 'not_a_set' THEN 'PASS 10 not_a_set refused' ELSE 'FAIL 10 ' || SQLERRM END);
  END;
  EXECUTE 'RESET ROLE';
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _res(line) VALUES ('FAIL exception: ' || SQLERRM);
END $t$;

DO $z$ BEGIN RAISE EXCEPTION 'RESULTS: %', (SELECT string_agg(line, E'\n' ORDER BY n) FROM _res); END $z$;
ROLLBACK;
