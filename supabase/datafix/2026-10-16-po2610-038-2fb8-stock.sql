-- ไทย-เยอรมัน PO2610-038: บรรทัด 2FB8 กระจกกันไฟ 2 ชม. 15 mm. FPO8 (410 X 410) 4 แผ่น x 2,550 = 10,200 ไม่มีสต๊อก
-- เพราะบรรทัดนี้ไม่ได้ผูกสินค้า ตอนรับของ 6 ต.ค. ระบบจึงข้ามไป เจ้าของสั่ง 16 ต.ค. ให้ลงสต๊อก
-- ทำ: สร้างสินค้าใหม่ชื่อตามบรรทัด (หมวดกระจก หน่วยแผ่น) แล้วลงรับเข้า 4 x 2,550 ที่ไซท์ส่วนกลาง
-- ไม่ผูกสินค้ากับบรรทัด PO (trigger poi_block_when_receipted ห้ามแก้บรรทัด PO ที่มีมัดจำ) แถวสต๊อกอ้าง PO เดียวกัน เวลาเดียวกับแถวรับของอื่น หลังลง สต๊อกของ PO นี้ = 206,730.00 เท่ายอด PO ก่อน VAT
-- guard: บรรทัดต้องยังไม่ผูกสินค้า และ PO ต้องมีสต๊อก 196,530.00 พอดี ไม่งั้นหยุด ไม่แตะ inventory_stock_balances
DO $$
DECLARE
  po uuid := 'de73ede3-4a2f-48a4-a5e1-3c0f31c39854';
  line uuid := '60be64b4-818a-4500-a15a-12bc50d71db2';
  t uuid; s uuid; ref RECORD; new_id uuid;
BEGIN
  SELECT tenant_id INTO t FROM purchase_orders WHERE id = po;
  s := public.central_stock_site_id(t);
  IF t IS NULL OR s IS NULL THEN RAISE EXCEPTION 'PO/central site not found'; END IF;
  IF (SELECT inventory_item_id FROM purchase_order_items WHERE id = line AND po_id = po AND quantity = 4 AND unit_price = 2550) IS NOT NULL
     OR NOT EXISTS (SELECT 1 FROM purchase_order_items WHERE id = line AND po_id = po AND quantity = 4 AND unit_price = 2550) THEN
    RAISE EXCEPTION 'line 2FB8 not in expected state';
  END IF;
  IF (SELECT round(sum(quantity * unit_cost), 2) FROM stock_movements WHERE reference_id = po) <> 196530 THEN
    RAISE EXCEPTION 'PO stock total is not 196,530';
  END IF;
  SELECT m.created_at, m.created_by, m.reference_type, i.category_id, i.item_kind INTO ref
    FROM stock_movements m JOIN inventory_items i ON i.id = m.inventory_item_id
   WHERE m.reference_id = po AND i.code = 'GL-0423' LIMIT 1;
  INSERT INTO inventory_items (tenant_id, code, name, base_unit, category_id, item_kind, unit_conversion_mode, active)
  VALUES (t, '', '2FB8 - กระจกกันไฟ 2 ชม. 15 mm.FPO8 Fire Resistant Glass (410 X 410)', 'แผ่น', ref.category_id, ref.item_kind, 'plain', true)
  RETURNING id INTO new_id;
  INSERT INTO stock_movements (tenant_id, inventory_item_id, site_id, movement_type, quantity, unit_cost, reference_type, reference_id, notes, created_by, created_at)
  VALUES (t, new_id, s, 'purchase_in', 4, 2550, ref.reference_type, po, 'PO2610-038 บรรทัด 2FB8 (ลงเพิ่ม 2026-10-16 เจ้าของสั่ง)', ref.created_by, ref.created_at);
  IF (SELECT round(sum(quantity * unit_cost), 2) FROM stock_movements WHERE reference_id = po) <> 206730 THEN
    RAISE EXCEPTION 'PO stock total after fix is not 206,730';
  END IF;
END $$;
