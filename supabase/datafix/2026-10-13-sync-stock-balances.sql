-- ซิงก์ inventory_stock_balances ให้ตรงสมุดสต๊อก (stock_movements) ของทุกสินค้า/ไซต์
-- เล่นซ้ำสมุดสต๊อกเรียงตามเวลา (created_at แล้ว id) ด้วยสูตรเดียวกับ record_stock_movement():
--   purchase_in / transfer_in / sale_reversal : เพิ่มจำนวน ต้นทุนถัวเฉลี่ย = (จำนวนเดิม x ต้นทุนเดิม + จำนวนที่เข้า x ต้นทุน) / จำนวนใหม่
--   adjustment : บวกส่วนต่างที่เก็บไว้ (จำนวนที่เก็บคือ ใหม่ - เดิม) ต้นทุนถัวเฉลี่ย = ต้นทุนของแถว
--   transfer_out / sale_out / purchase_return / receipt_reversal : หักจำนวน ต้นทุนไม่เปลี่ยน
-- แล้วเขียนทับ (upsert) แถวยอดคงเหลือของคู่ (สินค้า, ไซต์) ที่มีความเคลื่อนไหว ส่วนแถวยอดคงเหลือที่ไม่มีความเคลื่อนไหวในสมุดเลยตั้งเป็น 0 (ไม่ลบแถว)
-- รันซ้ำได้ ได้ผลเดิมทุกครั้ง
DO $$
DECLARE
  r RECORD;
  t uuid;
  oq numeric;
  ow numeric;
  nq numeric;
  nw numeric;
BEGIN
  SELECT tenant_id INTO t FROM inventory_items WHERE code = 'AC-0036';
  IF t IS NULL THEN RAISE EXCEPTION 'tenant not found'; END IF;
  CREATE TEMP TABLE st (item uuid, site uuid, qty numeric, wac numeric, PRIMARY KEY (item, site)) ON COMMIT DROP;
  FOR r IN
    SELECT inventory_item_id AS i, site_id AS s, movement_type AS mt, quantity AS q, unit_cost AS c
    FROM stock_movements WHERE tenant_id = t ORDER BY created_at, id
  LOOP
    SELECT qty, wac INTO oq, ow FROM st WHERE item = r.i AND site = r.s;
    IF NOT FOUND THEN oq := 0; ow := 0; END IF;
    IF r.mt = 'adjustment' THEN
      nq := oq + r.q;
      nw := COALESCE(r.c, ow);
    ELSIF r.mt IN ('purchase_in', 'transfer_in', 'sale_reversal') THEN
      nq := oq + r.q;
      IF nq = 0 THEN nw := 0; ELSE nw := (oq * ow + r.q * COALESCE(r.c, 0)) / nq; END IF;
    ELSE
      nq := oq - r.q;
      nw := ow;
    END IF;
    INSERT INTO st (item, site, qty, wac) VALUES (r.i, r.s, nq, nw)
    ON CONFLICT (item, site) DO UPDATE SET qty = nq, wac = nw;
  END LOOP;
  INSERT INTO inventory_stock_balances (tenant_id, inventory_item_id, site_id, quantity_on_hand, weighted_average_cost, updated_at)
  SELECT t, item, site, qty, wac, now() FROM st
  ON CONFLICT (inventory_item_id, site_id) DO UPDATE
    SET quantity_on_hand = EXCLUDED.quantity_on_hand, weighted_average_cost = EXCLUDED.weighted_average_cost, updated_at = now();
  -- แถวยอดคงเหลือที่ไม่มีความเคลื่อนไหวในสมุดเลย (เศษจากแถวสมุดที่เคยลบ/ย้าย เช่น HW-0336 ที่ย้ายไป HW-0132) ตั้งเป็น 0 ให้ตรงสมุด
  UPDATE inventory_stock_balances b SET quantity_on_hand = 0, weighted_average_cost = 0, updated_at = now()
  WHERE b.tenant_id = t AND (b.quantity_on_hand <> 0 OR b.weighted_average_cost <> 0)
    AND NOT EXISTS (SELECT 1 FROM st x WHERE x.item = b.inventory_item_id AND x.site = b.site_id);
END $$;
