-- 2 เรื่องสุดท้ายของงานสต๊อกค้าง (เจ้าของตอบ 16 ต.ค. 2569)
-- 1) ชาญสินทวี IV6807793 (28 ม.ค.) มือจับสีสแตนเลส 10 ชุด x 420 = 4,200 ก่อน VAT = รายจ่าย IV6807793 (4,494 รวม VAT)
--    ไม่มีสินค้าชื่อตรงทุกตัวอักษร จึงสร้างใหม่ "มือจับสีสแตนเลส" หมวดอุปกรณ์ HW ลงที่ไซท์ส่วนกลาง
-- 2) บี.เอส. 690109011 (9 ม.ค.) เจ้าของยืนยันยอดในใบ 29,538.21 รวม VAT แล้ว -> ต้นทุนก่อน VAT หาร 1.07 (2 แถว, รวมเหลือ 27,605.80)
--    รายจ่าย 70001/90 (29,548.00) แก้ให้ตรงใบตามที่เจ้าของสั่งไว้ 8 ต.ค. ("เอาใบกำกับเป็นหลัก แก้expense"):
--    29,538.21 รวม VAT = 27,605.80 + VAT 1,932.41
-- guard ทุกข้อ ไม่ตรงสภาพเดิมหยุดทั้งไฟล์ ไม่แตะ inventory_stock_balances (รัน sync ต่อท้าย)
DO $$
DECLARE t uuid; s uuid; it uuid; n int;
BEGIN
  SELECT tenant_id INTO t FROM inventory_items WHERE code = 'AC-0036';
  s := public.central_stock_site_id(t);
  IF t IS NULL OR s IS NULL THEN RAISE EXCEPTION 'tenant/central site not found'; END IF;

  IF EXISTS (SELECT 1 FROM stock_movements WHERE tenant_id = t AND notes ILIKE 'IV6807793 /%') THEN
    RAISE EXCEPTION 'IV6807793 already has stock';
  END IF;
  SELECT id INTO it FROM inventory_items WHERE tenant_id = t AND name = 'มือจับสีสแตนเลส' AND active LIMIT 1;
  IF it IS NULL THEN
    INSERT INTO inventory_items (tenant_id, code, name, base_unit, category_id, item_kind, unit_conversion_mode, active)
    SELECT t, '', 'มือจับสีสแตนเลส', 'ชุด', category_id, item_kind, 'plain', true FROM inventory_items WHERE tenant_id = t AND code = 'HW-0176'
    RETURNING id INTO it;
  END IF;
  INSERT INTO stock_movements (tenant_id, inventory_item_id, site_id, movement_type, quantity, unit_cost, reference_type, notes, created_by, created_at)
  VALUES (t, it, s, 'purchase_in', 10, 420, 'jan26_backfill', 'IV6807793 / บริษัท ชาญสินทวี จำกัด', 'contact@facadex.co.th', '2026-01-28 05:00:00+00');

  IF (SELECT count(*) FROM stock_movements WHERE notes ILIKE '690109011 /%') <> 2
     OR (SELECT round(sum(quantity * unit_cost), 2) FROM stock_movements WHERE notes ILIKE '690109011 /%') <> 29538.21 THEN
    RAISE EXCEPTION '690109011 rows not in expected state';
  END IF;
  UPDATE stock_movements SET unit_cost = round(unit_cost / 1.07, 4),
    notes = notes || ' [แก้ 2026-10-16: ต้นทุนรวม VAT -> ก่อน VAT หาร 1.07]'
   WHERE notes ILIKE '690109011 /%';

  UPDATE expenses SET amount = 29538.21, amount_no_vat = 27605.80, vat = 1932.41,
         notes = concat_ws(' ', nullif(notes, ''), '[แก้ 2026-10-16: ตรงใบกำกับ 690109011 29,538.21 ยอดเดิม 29,548.00]'),
         updated_at = now()
   WHERE invoice_no = '70001/90' AND amount = 29548 AND supplier ILIKE '%บี.เอส.อลูมิเนียม%';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'expected 1 expense 70001/90 at 29,548, got %', n; END IF;
END $$;
