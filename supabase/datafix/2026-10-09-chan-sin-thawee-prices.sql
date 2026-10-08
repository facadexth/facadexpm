-- ชาญสินทวี backfill: unit costs keyed at LIST price instead of the discounted price printed on the real documents.
-- Ledger-only (stock_movements.unit_cost + note); inventory_stock_balances are NOT touched (owner: fix identity/price first, quantities later).
-- Each row is guarded: exactly one movement must match (item code, document ref, old cost) or the whole script aborts.
-- Discounts from the owner's documents: 6 พ.ค. 3100->2573 (-17%); 10 มิ.ย. FC-49/FC-34 -25%, FT-10/FT-20 -38%, AT-140 owner price 82; 22 ก.ค. PS 400 -45% = 220.
DO $$
DECLARE
  r RECORD;
  n int;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('AC-0210', '1569050635', 3100.00, 2573.00),
      ('AC-0212', '1509061009', 4950.00, 3712.50),
      ('AC-0213', '1509061009', 1700.00, 1275.00),
      ('AC-0214', '1509061009',  745.00,  461.90),
      ('AC-0215', '1509061009',  745.00,  461.90),
      ('AC-0216', '1509061009',  105.00,   82.00),
      ('AC-0176', '1589042?',     84.00,   82.00),
      ('AL-0813', '1569072219',  170.00,  220.00)
    ) AS t(code, doc_ref, old_cost, new_cost)
  LOOP
    UPDATE stock_movements m
       SET unit_cost = r.new_cost,
           notes = m.notes || ' [แก้ราคา 2026-10-09: เดิม ' || r.old_cost::text || ' ตามราคาก่อนลด -> ' || r.new_cost::text || ' ตามใบจริง]'
      FROM inventory_items i
     WHERE i.id = m.inventory_item_id AND i.code = r.code
       AND m.movement_type = 'purchase_in' AND m.notes ILIKE r.doc_ref || ' / %ชาญสินทวี%'
       AND m.unit_cost = r.old_cost;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 1 THEN RAISE EXCEPTION 'expected exactly 1 movement for % / % at %, got %', r.code, r.doc_ref, r.old_cost, n; END IF;
  END LOOP;
END $$;
