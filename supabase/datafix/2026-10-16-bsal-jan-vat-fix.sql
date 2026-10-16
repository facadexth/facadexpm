-- บี.เอส.อลูมิเนียม ม.ค. 2569: ใบ 690115016 (8,592.00) และ 690117007 (2,043.75) ลงต้นทุนรวม VAT ไว้ (เท่ารายจ่ายรวม VAT พอดี
-- และเจ้าของยืนยันว่า "ราคาในตารางรวม vat แล้ว") หลักของสต๊อกคือต้นทุนก่อน VAT จึงหาร 1.07 ทุกแถวของ 2 ใบนี้ (4 แถว)
--   690115016: AL-0415 5 x 1,643.50 -> 1,535.9813 · AC-0086 1 x 374.50 -> 350.00   รวม 8,030.00
--   690117007: AL-0434 1 x 1,332.00 -> 1,244.8598 · AL-0435 1 x 711.75 -> 665.1869  รวม 1,910.05
-- guard: ต้องเจอ 4 แถว รวม 10,635.75 พอดี ไม่งั้นหยุด ไม่แตะ inventory_stock_balances
DO $$
DECLARE n int;
BEGIN
  IF (SELECT count(*) FROM stock_movements WHERE notes ILIKE '690115016 /%' OR notes ILIKE '690117007 /%') <> 4
     OR (SELECT round(sum(quantity * unit_cost), 2) FROM stock_movements WHERE notes ILIKE '690115016 /%' OR notes ILIKE '690117007 /%') <> 10635.75 THEN
    RAISE EXCEPTION 'rows not in expected state';
  END IF;
  UPDATE stock_movements SET unit_cost = round(unit_cost / 1.07, 4),
    notes = notes || ' [แก้ 2026-10-16: ต้นทุนรวม VAT -> ก่อน VAT หาร 1.07]'
   WHERE notes ILIKE '690115016 /%' OR notes ILIKE '690117007 /%';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 4 THEN RAISE EXCEPTION 'expected 4 rows, got %', n; END IF;
END $$;
