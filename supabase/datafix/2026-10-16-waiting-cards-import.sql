-- ลงสต๊อกการ์ดที่เหลือจาก artifact "ใบที่รอใบกำกับ" ที่เจ้าของพิมพ์รายการให้แล้ว แต่ยังไม่มีแถวสต๊อก (ตรวจกับฐานข้อมูลจริง 16 ต.ค. 2569)
-- 11 ใบ 15 บรรทัด ก่อน VAT รวม 136,060.07 ต้นทุน = ก่อน VAT (ราคาที่เจ้าของพิมพ์รวม VAT แล้วหาร 1.07 ยกเว้นที่ระบุว่าก่อน VAT)
--   6808/A004        ทีม ทูเก็ตเตอร์ 16 ม.ค.  AG-SMHUB02 Motion & Safety Sensor 1 ชุด 5,000 ก่อน VAT                     = 5,000.00
--   100709           บี.เอส. 23 ม.ค.          9013 เทาซาฮาร่า 40 เส้น x 1,630.52 รวม VAT = 65,220.80 -> AL-0415             = 60,954.02
--   14/664           บี.เอส. 19 มี.ค.         กล่องเรียบ 1"x4" ขาว AM 1.5 20 เส้น x 796 รวม VAT = 15,920 -> AL-0241          = 14,878.50
--   S6804/1408       บี.เอส. 23 มี.ค.         V-39 กุญแจบานเลื่อนไขทางเดียว ดำ 10 ตัว 2,920 ลด 1,000 = 1,920 รวม VAT (สินค้าใหม่ ไม่ใช่รุ่นบิด HW-0132) = 1,794.39
--   S6804/0247       บี.เอส. 24 มี.ค.         กระดาษกาว 1" 24 ม้วน x 11 ก่อน VAT -> AC-0007                                   = 264.00
--   SR680006         บี.เอส. 29 พ.ค.          กล่องเรียบ 1"x4" ขาว 3 x 1,100 ลด 19% + ธรณีสวิงขาสูง 3067 1 x 1,370 ลด 20% + ลิ่มพลาสติก 2,000 x 1.07 = 5,909 รวม VAT = 5,522.43
--   TI2503-00012     บี.เอส. 29 พ.ค.          กล่องเรียบ 1"x4" เทาซาฮาร่า 1 x 1,300 ลด 20% = 1,040 รวม VAT                = 971.96
--   2025-00016 (...) ทีม ทูเก็ตเตอร์ 30 พ.ค.  ชุดประตูออโต้ 1 ชุด 41,195 รวม VAT ลงเต็มไม่หักมัดจำ (แบบเดียวกับ ซี เอ ซี และ ทีจีดี) = 38,500.00
--   R01680000103571  บี.เอส. 30 มิ.ย.         L 1/2"x2" 332 2 x 350 ลด 17% + ฉากเสริม 312 2 x 270 ลด 17% = 1,029 รวม VAT  = 961.68
--   340-016993       บี.เอส. 4 ก.ค.           กระจกเขียวใส 8 มม. 60"x84" 1 แผ่น 2,030 รวม VAT                              = 1,897.20
--   73260/81         บี.เอส. 10 ก.ค.          ซิลิโคนดาวคอนนิ่ง GM ขาวขุ่น 72 หลอด x 79 รวม VAT = 5,688                      = 5,315.89
-- สต๊อกเข้าไซท์ส่วนกลาง (central_stock_site_id) สินค้าที่ไม่มีรหัสในระบบสร้างใหม่ รหัสว่างให้ trigger รันเอง
-- ไม่แตะ inventory_stock_balances (รัน sync-stock-balances ต่อท้าย) guard: ถ้าเลขใบใดมีแถวสต๊อกอยู่แล้ว หยุดทั้งไฟล์
DO $$
DECLARE
  r RECORD;
  t uuid;
  s uuid;
  to_id uuid;
  cat uuid;
  kind text;
BEGIN
  SELECT tenant_id INTO t FROM inventory_items WHERE code = 'AC-0036';
  s := public.central_stock_site_id(t);
  IF t IS NULL OR s IS NULL THEN RAISE EXCEPTION 'tenant/central site not found'; END IF;
  FOR r IN SELECT DISTINCT doc FROM (VALUES
      ('6808/A004'), ('100709'), ('14/664'), ('S6804/1408'), ('S6804/0247'), ('SR680006'), ('TI2503-00012'),
      ('2025-00016 (ทีม ทูเก็ตเตอร์ 30 พ.ค.)'), ('R01680000103571'), ('340-016993'), ('73260/81')
  ) AS x(doc) LOOP
    IF EXISTS (SELECT 1 FROM stock_movements WHERE tenant_id = t AND notes ILIKE r.doc || ' /%') THEN
      RAISE EXCEPTION 'document % already has stock movements', r.doc;
    END IF;
  END LOOP;
  FOR r IN
    SELECT * FROM (VALUES
      ('6808/A004', 'ทีม ทูเก็ตเตอร์', DATE '2026-01-16', 'jan', 'AG-SMHUB02 Motion & Safety Sensor', 'ชุด', 1.0, 5000.0000, '', 'HW'),
      ('100709', 'บี.เอส.อลูมิเนียม ซัพพลาย', DATE '2026-01-23', 'jan', '', 'เส้น', 40.0, 1523.8505, 'AL-0415', 'AL'),
      ('14/664', 'บี.เอส.อลูมิเนียม ซัพพลาย', DATE '2026-03-19', 'mar', '', 'เส้น', 20.0, 743.9252, 'AL-0241', 'AL'),
      ('S6804/1408', 'บี.เอส.อลูมิเนียม ซัพพลาย', DATE '2026-03-23', 'mar', 'V-39 กุญแจบานเลื่อนไขทางเดียว สีดำ-BLACK', 'ตัว', 10.0, 179.4393, '', 'HW'),
      ('S6804/0247', 'บี.เอส.อลูมิเนียม ซัพพลาย', DATE '2026-03-24', 'mar', '', 'ม้วน', 24.0, 11.0000, 'AC-0007', 'AC'),
      ('SR680006', 'บี.เอส.อลูมิเนียม ซัพพลาย', DATE '2026-05-29', 'may', '', 'เส้น', 3.0, 832.7103, 'AL-0241', 'AL'),
      ('SR680006', 'บี.เอส.อลูมิเนียม ซัพพลาย', DATE '2026-05-29', 'may', 'ธรณีสวิงขาสูง เทาซาฮาร่า AM 5.0-3067', 'เส้น', 1.0, 1024.2991, '', 'AL'),
      ('SR680006', 'บี.เอส.อลูมิเนียม ซัพพลาย', DATE '2026-05-29', 'may', 'ลิ่มพลาสติก', 'อัน', 2000.0, 1.0000, '', 'AC'),
      ('TI2503-00012', 'บี.เอส.อลูมิเนียม ซัพพลาย', DATE '2026-05-29', 'may', 'กล่องเรียบ 1"x4" เทาซาฮาร่า AM 1.5-010127', 'เส้น', 1.0, 971.9626, '', 'AL'),
      ('2025-00016 (ทีม ทูเก็ตเตอร์ 30 พ.ค.)', 'ทีม ทูเก็ตเตอร์', DATE '2026-05-30', 'may', 'ชุดประตูอัตโนมัติ (ทีม ทูเก็ตเตอร์)', 'ชุด', 1.0, 38500.0000, '', 'HW'),
      ('R01680000103571', 'บี.เอส.อลูมิเนียม ซัพพลาย', DATE '2026-06-30', 'jun', 'L 1/2"x2" เทาซาฮาร่า AM 1.2-332', 'เส้น', 2.0, 271.4458, '', 'AL'),
      ('R01680000103571', 'บี.เอส.อลูมิเนียม ซัพพลาย', DATE '2026-06-30', 'jun', 'ฉากเสริม เทาซาฮาร่า AM 1.2-312', 'เส้น', 2.0, 209.3946, '', 'AL'),
      ('340-016993', 'บี.เอส.อลูมิเนียม ซัพพลาย', DATE '2026-07-04', 'jul', 'กระจกเขียวใส 8 มม. 60"x84"', 'แผ่น', 1.0, 1897.1963, '', 'GL'),
      ('73260/81', 'บี.เอส.อลูมิเนียม ซัพพลาย', DATE '2026-07-10', 'jul', 'ซิลิโคนดาวคอนนิ่ง GM ขาวขุ่น ไร้กรด หลอดฟ้า / 24', 'หลอด', 72.0, 73.8318, '', 'SL')
    ) AS v(doc, supplier, doc_date, mon, name, unit, qty, cost, code, cat)
  LOOP
    IF r.code <> '' THEN
      SELECT id INTO to_id FROM inventory_items WHERE code = r.code AND tenant_id = t;
      IF to_id IS NULL THEN RAISE EXCEPTION 'item code % not found', r.code; END IF;
    ELSE
      to_id := NULL;
      SELECT id INTO to_id FROM inventory_items WHERE tenant_id = t AND name = r.name AND active LIMIT 1;
      IF to_id IS NULL THEN
        SELECT c.id INTO cat FROM (VALUES
          ('AL', '49ce5d97-8f6d-4fb9-881a-0a00a400a71f'::uuid),
          ('HW', '440c50a8-8109-40b4-b1d3-ee1e53808bd5'::uuid),
          ('GL', '7f906a1f-e75b-4b8d-8e66-b47c383705bd'::uuid),
          ('SL', '692bda85-7c3f-4484-8840-c5f5e465333d'::uuid),
          ('AC', '04189523-5b5d-4290-8ef5-4360fe072afb'::uuid)
        ) AS c(p, id) WHERE c.p = r.cat;
        IF cat IS NULL THEN RAISE EXCEPTION 'category % not found', r.cat; END IF;
        SELECT item_kind INTO kind FROM inventory_items WHERE tenant_id = t AND category_id = cat AND active
          GROUP BY item_kind ORDER BY count(*) DESC LIMIT 1;
        INSERT INTO inventory_items (tenant_id, code, name, base_unit, category_id, item_kind, unit_conversion_mode, active)
        VALUES (t, '', r.name, r.unit, cat, COALESCE(kind, 'raw_material'), 'plain', true)
        RETURNING id INTO to_id;
      END IF;
    END IF;
    INSERT INTO stock_movements (tenant_id, inventory_item_id, site_id, movement_type, quantity, unit_cost, reference_type, notes, created_by, created_at)
    VALUES (t, to_id, s, 'purchase_in', r.qty, r.cost, r.mon || '26_backfill', r.doc || ' / ' || r.supplier, 'contact@facadex.co.th', (r.doc_date::text || ' 05:00:00+00')::timestamptz);
  END LOOP;
END $$;
