-- ลงสต๊อกตามใบที่เจ้าของส่งรูปมา 16 ต.ค. 2569 (ต้นทุน = ก่อน VAT)
--   inv26061496 เอส อาร์ โฮม 25 มิ.ย. 5 บรรทัด รวม 7,131 รวม VAT = รายจ่าย IN-000005776 (ก่อน VAT 6,664.49) ราคาในใบรวม VAT หาร 1.07
--   inv26081609 เอส อาร์ โฮม 27 ส.ค. 7 บรรทัด รวม 18,353 รวม VAT = รายจ่าย INV26081609 (ก่อน VAT 17,152.34) ราคาในใบรวม VAT หาร 1.07
--   IS69091410 ชาญสินทวี 14 ก.ย. ใบจริง 7,695.70 ก่อน VAT สต๊อกจาก PO2610-037 ลงไว้ 4 บรรทัด 6,310.00 ขาด 2 บรรทัด 1,385.70:
--     FT 10 ตัวหนีบล่าง สีสแตนเลส PS 1 x 745 ลด 38% = 461.90 -> HW-0064 · FT 20 ตัวหนีบบน สีสแตนเลส PS 2 x 745 ลด 38% = 923.80 -> HW-0065
-- รายการที่ชื่อตรงสินค้าเดิมทุกตัวอักษรใช้รหัสเดิม (AC-0074 กึ่งเงาเบสA, AC-0102 แม่สี TOA #11) ที่เหลือสร้างใหม่ หมวดอุปกรณ์ (AC)
-- เสื้อจราจร 1 ตัว 111 ลงตามใบด้วย สต๊อกเข้าไซท์ส่วนกลาง ไม่แตะ inventory_stock_balances (รัน sync ต่อท้าย)
-- guard: ถ้าเลขใบใดมีแถวสต๊อกอยู่แล้ว (IS69091410 ดูเฉพาะ HW-0064/HW-0065) หยุดทั้งไฟล์
DO $$
DECLARE
  r RECORD;
  t uuid;
  s uuid;
  to_id uuid;
  cat uuid := '04189523-5b5d-4290-8ef5-4360fe072afb';
BEGIN
  SELECT tenant_id INTO t FROM inventory_items WHERE code = 'AC-0036';
  s := public.central_stock_site_id(t);
  IF t IS NULL OR s IS NULL THEN RAISE EXCEPTION 'tenant/central site not found'; END IF;
  IF EXISTS (SELECT 1 FROM stock_movements WHERE tenant_id = t AND (notes ILIKE 'inv26061496 /%' OR notes ILIKE 'inv26081609 /%')) THEN
    RAISE EXCEPTION 'SR Home documents already have stock movements';
  END IF;
  IF EXISTS (SELECT 1 FROM stock_movements m JOIN inventory_items i ON i.id = m.inventory_item_id
             WHERE m.tenant_id = t AND m.notes ILIKE 'IS69091410 /%' AND i.code IN ('HW-0064', 'HW-0065')) THEN
    RAISE EXCEPTION 'IS69091410 FT lines already posted';
  END IF;
  FOR r IN
    SELECT * FROM (VALUES
      ('inv26061496', 'บริษัท เอส อาร์ โฮม จำกัด', DATE '2026-06-25', 'jun', 'สีน้ำ ทาฝ้า 4season แกลลอน A7000', 'แกลลอน', 2.0, 420.0, '', true),
      ('inv26061496', 'บริษัท เอส อาร์ โฮม จำกัด', DATE '2026-06-25', 'jun', 'สีน้ำ ทาฝ้า ทราโว่ 9ลิตร A7000', 'ถัง', 1.0, 880.0, '', true),
      ('inv26061496', 'บริษัท เอส อาร์ โฮม จำกัด', DATE '2026-06-25', 'jun', '', 'ถัง', 3.0, 1340.0, 'AC-0074', true),
      ('inv26061496', 'บริษัท เอส อาร์ โฮม จำกัด', DATE '2026-06-25', 'jun', 'สีน้ำ ภายใน มาร์ค ถัง', 'ถัง', 2.0, 640.0, '', true),
      ('inv26061496', 'บริษัท เอส อาร์ โฮม จำกัด', DATE '2026-06-25', 'jun', 'เสื้อจราจร', 'ชิ้น', 1.0, 111.0, '', true),
      ('inv26081609', 'บริษัท เอส อาร์ โฮม จำกัด', DATE '2026-08-27', 'aug', '', 'ถัง', 2.0, 1320.0, 'AC-0074', true),
      ('inv26081609', 'บริษัท เอส อาร์ โฮม จำกัด', DATE '2026-08-27', 'aug', 'แม่สีน้ำ TOA #2', 'ลิตร', 1.0, 1180.0, '', true),
      ('inv26081609', 'บริษัท เอส อาร์ โฮม จำกัด', DATE '2026-08-27', 'aug', '', 'ลิตร', 1.0, 2590.0, 'AC-0102', true),
      ('inv26081609', 'บริษัท เอส อาร์ โฮม จำกัด', DATE '2026-08-27', 'aug', 'แม่สีน้ำ TOA #14', 'ลิตร', 1.0, 3300.0, '', true),
      ('inv26081609', 'บริษัท เอส อาร์ โฮม จำกัด', DATE '2026-08-27', 'aug', 'แม่สีน้ำ TOA #7', 'ลิตร', 1.0, 3550.0, '', true),
      ('inv26081609', 'บริษัท เอส อาร์ โฮม จำกัด', DATE '2026-08-27', 'aug', 'สีน้ำกึ่งเงา 4season เบสD 9 ลิตร', 'ถัง', 4.0, 980.0, '', true),
      ('inv26081609', 'บริษัท เอส อาร์ โฮม จำกัด', DATE '2026-08-27', 'aug', 'สีน้ำกึ่งเงา 4season เบสC 9 ลิตร', 'ถัง', 1.0, 1173.0, '', true),
      ('IS69091410', 'บริษัท ชาญสินทวี จำกัด', DATE '2026-09-14', 'sep', '', 'ตัว', 1.0, 461.90, 'HW-0064', false),
      ('IS69091410', 'บริษัท ชาญสินทวี จำกัด', DATE '2026-09-14', 'sep', '', 'ตัว', 2.0, 461.90, 'HW-0065', false)
    ) AS v(doc, supplier, doc_date, mon, name, unit, qty, price, code, incl_vat)
  LOOP
    IF r.code <> '' THEN
      SELECT id INTO to_id FROM inventory_items WHERE code = r.code AND tenant_id = t;
      IF to_id IS NULL THEN RAISE EXCEPTION 'item code % not found', r.code; END IF;
    ELSE
      to_id := NULL;
      SELECT id INTO to_id FROM inventory_items WHERE tenant_id = t AND name = r.name AND active LIMIT 1;
      IF to_id IS NULL THEN
        INSERT INTO inventory_items (tenant_id, code, name, base_unit, category_id, item_kind, unit_conversion_mode, active)
        VALUES (t, '', r.name, r.unit, cat, 'raw_material', 'plain', true)
        RETURNING id INTO to_id;
      END IF;
    END IF;
    INSERT INTO stock_movements (tenant_id, inventory_item_id, site_id, movement_type, quantity, unit_cost, reference_type, notes, created_by, created_at)
    VALUES (t, to_id, s, 'purchase_in', r.qty, CASE WHEN r.incl_vat THEN round(r.price / 1.07, 4) ELSE r.price END,
            r.mon || '26_backfill', r.doc || ' / ' || r.supplier, 'contact@facadex.co.th', (r.doc_date::text || ' 05:00:00+00')::timestamptz);
  END LOOP;
END $$;
