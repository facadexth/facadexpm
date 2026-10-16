-- ชาญสินทวี ใบ 1569011619 (16 ม.ค. 2569) แก้สต๊อกให้ตรงใบจริงที่เจ้าของยืนยัน 13 ต.ค. (artifact "รายการนำเข้าสต๊อกที่ค้าง")
--   ใบจริง: OC35 3 ชุด รวม 1,650 · OC35-G 16 ชุด x 250 = 4,000 · OC-35 โช้คบนฝังในวงกบ 10 ตัว x 1,150 = 11,500
--   ก่อน VAT 17,150 = รายจ่าย HT2507074 (18,350.50 รวม VAT) ตอนนี้สต๊อกลงไว้ 20,600 (3 แถว)
--   แถว HW-0181 3 x 650   -> HW-0183 3 x 550   และเปลี่ยนชื่อ HW-0183 (เดิม "นกลาว" ไม่มีแถวอื่น) เป็น "โช๊ค OC35"
--   แถว HW-0182 1 x 250   -> สินค้าใหม่ "OC35-G" 16 x 250 แล้วปิดใช้งาน HW-0182 (ไม่เหลือแถว)
--   แถว HW-0183 16 x 1,150 -> HW-0016 (OC-35 โช้คบนฝังในวงกบ) 10 x 1,150
-- ต่างจากที่ตกลงไว้ 1 จุด: ไม่เปลี่ยนชื่อ HW-0181 เป็น OC35-G เพราะ HW-0181 มีแถวใบ 1569072713 (27 ก.ค.) อีกแถว จึงสร้างสินค้าใหม่แทน
-- guard: ทั้ง 3 แถวต้องอยู่ในสภาพเดิม ไม่งั้นหยุด ไม่แตะ inventory_stock_balances
DO $$
DECLARE
  t uuid;
  a uuid; b uuid; c uuid;
  hw0181 uuid; hw0182 uuid; hw0183 uuid; hw0016 uuid; g uuid;
BEGIN
  SELECT tenant_id INTO t FROM inventory_items WHERE code = 'AC-0036';
  SELECT id INTO hw0181 FROM inventory_items WHERE tenant_id = t AND code = 'HW-0181';
  SELECT id INTO hw0182 FROM inventory_items WHERE tenant_id = t AND code = 'HW-0182';
  SELECT id INTO hw0183 FROM inventory_items WHERE tenant_id = t AND code = 'HW-0183';
  SELECT id INTO hw0016 FROM inventory_items WHERE tenant_id = t AND code = 'HW-0016';
  IF hw0181 IS NULL OR hw0182 IS NULL OR hw0183 IS NULL OR hw0016 IS NULL THEN RAISE EXCEPTION 'item not found'; END IF;
  SELECT id INTO a FROM stock_movements WHERE notes ILIKE '1569011619 /%' AND inventory_item_id = hw0181 AND quantity = 3 AND unit_cost = 650;
  SELECT id INTO b FROM stock_movements WHERE notes ILIKE '1569011619 /%' AND inventory_item_id = hw0182 AND quantity = 1 AND unit_cost = 250;
  SELECT id INTO c FROM stock_movements WHERE notes ILIKE '1569011619 /%' AND inventory_item_id = hw0183 AND quantity = 16 AND unit_cost = 1150;
  IF a IS NULL OR b IS NULL OR c IS NULL THEN RAISE EXCEPTION 'rows of 1569011619 not in expected state'; END IF;
  IF EXISTS (SELECT 1 FROM stock_movements WHERE inventory_item_id = hw0183 AND id <> c) THEN RAISE EXCEPTION 'HW-0183 has other rows'; END IF;
  IF EXISTS (SELECT 1 FROM stock_movements WHERE inventory_item_id = hw0182 AND id <> b) THEN RAISE EXCEPTION 'HW-0182 has other rows'; END IF;

  INSERT INTO inventory_items (tenant_id, code, name, base_unit, category_id, item_kind, unit_conversion_mode, active)
  SELECT tenant_id, '', 'OC35-G', 'ชุด', category_id, item_kind, 'plain', true FROM inventory_items WHERE id = hw0182
  RETURNING id INTO g;

  UPDATE stock_movements SET inventory_item_id = hw0183, unit_cost = 550,
    notes = notes || ' [แก้ตามใบจริง 2026-10-16: HW-0181 3.0 x 650.00 -> HW-0183 (โช๊ค OC35) 3.0 x 550.00]' WHERE id = a;
  UPDATE stock_movements SET inventory_item_id = g, quantity = 16,
    notes = notes || ' [แก้ตามใบจริง 2026-10-16: HW-0182 1.0 x 250.00 -> OC35-G 16.0 x 250.00]' WHERE id = b;
  UPDATE stock_movements SET inventory_item_id = hw0016, quantity = 10,
    notes = notes || ' [แก้ตามใบจริง 2026-10-16: HW-0183 นกลาว 16.0 x 1150.00 -> HW-0016 10.0 x 1150.00]' WHERE id = c;
  UPDATE inventory_items SET name = 'โช๊ค OC35' WHERE id = hw0183;
  UPDATE inventory_items SET active = false WHERE id = hw0182;

  IF (SELECT round(sum(quantity * unit_cost), 2) FROM stock_movements WHERE notes ILIKE '1569011619 /%') <> 17150 THEN
    RAISE EXCEPTION 'total after fix is not 17,150';
  END IF;
END $$;
