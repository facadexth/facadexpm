-- ============================================================
-- ONE-OFF DATA IMPORT (part 2) — the rest of "aluiminium calculation.xlsx" (generated 2026-10-15; NOT part of the code release).
-- Part 1 (2026-10-13-import-aluminium-calculation-xlsx.sql) imported 209 profiles, 9 series and 17 glass types.
-- This file adds, under the same tenant and provider ("ไฟล์ Aluminium calculation"):
--   1. finish 'POWDER COATING SAHARA' (cell E1). NO price per kg: the file's ราคา/กก. cell I1 is the placeholder 1.
--   2. 24 hardware parts (rows 240-263, column D = ราคา) as alu_parts kind 'hardware', each with one alu_part_prices row
--      (list price, no discount) effective 2026-01-01 so projects dated before today (price date 2026-10-09) see them.
--      Rows 260-263 sit in the บานเฟี้ยม block and get the suffix " (บานเฟี้ยม)".
--   3. series ↔ type links (alu_series_types) read from the file's 9 calculator blocks (rows 267-436):
--      sliding (บานเลื่อนสวน 2 บาน, บานเลื่อน 2 ตาย 2, บานเลื่อน 3 บาน): ทั่วไป (mixed thickness, the file prices 1.8/1.5 etc.),
--        Big Frame, ชุด 4" ใหม่ (กล่องริม 4");  บานติดตาย: ทั่วไป, EURO, ชุด 4" ใหม่;  STICK WALL: Curtain Wall NO.9xxx;
--      UNITIZED CURTAIN WALL: Unitized, Unitized เล็ก;  บานกระทุ้ง (+ its 6 leaves): ทั่วไป, EURO;
--      บานสวิง (+ เดี่ยว / คู่): ทั่วไป;  บานเลื่อนรางแขวน: ทั่วไป;  บานเฟี้ยม: บานเฟี้ยม;
--      INFERRED (no calculator block, from the hardware names อุปกรณ์บานเปิด/ประตู EURO): บานเปิด, บานเปิดข้าง: EURO.
--      Parents (บานเลื่อน, บานกระทุ้ง, บานสวิง) are linked with their leaves. Not linked (no block in the file): บานเลื่อนรางล่าง,
--      ผนังกระจกบานเปลือย, บานสวิงเปลือย เดี่ยว/คู่, บานเกร็ด (no such type).
--   4. the hardware rows of BOM template 'บานเลื่อนสวน 2 บาน ทั่วไป' (created 2026-10-15) that have no part yet:
--      ลูกล้อ -> ลูกล้อบานเลื่อน, มือจับล็อค (ด้านใน) -> มือจับฝัง(ล็อค).
-- NOT imported: glass labour บาท/ตร.ฟ. per block and O/P % (calculator inputs, not master data; types already carry the
-- owner's labour per m²), widths / butt distances (owner enters later).
-- Idempotent: a part is skipped when (tenant, name) exists; a price when (part, effective_from) exists; links ON CONFLICT DO NOTHING.
-- Dry run: replace the final COMMIT with ROLLBACK (run-alu-calc-part2-dryrun.sh does that), read the NOTICE lines.
-- ============================================================
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE _xl_hw (xl_row INT, name TEXT, price NUMERIC) ON COMMIT DROP;
INSERT INTO _xl_hw VALUES
  (240, 'โช้คอัพ vvp', 1050),
  (241, 'โช้คอัพแจ็คสัน', 1050),
  (242, 'กุญแจสวิง', 650),
  (243, 'กุญแจอโตน่า', 500),
  (244, 'กลอนสวิง', 65),
  (245, 'มือจับฝัง(ล็อค)', 85),
  (246, 'มือจับฝัง(เรียบมีรู)', 55),
  (247, 'มือจับฝัง(เรียบไม่มีรู)', 55),
  (248, 'ลูกล้อบานเลื่อน', 35),
  (249, 'ลูกล้อรางแขวน', 204),
  (250, 'มือจับกระทุ้ง', 150),
  (251, 'บานพับกระทุ้ง/ST', 350),
  (252, 'บานพับกระทุ้ง', 350),
  (253, 'มือจับสวิง HD-117', 700),
  (254, 'ลูกล้อคู่ Big Frame', 140),
  (255, 'มือจับเลื่อนคู่กุญแจ แม่น้ำ', 1080),
  (256, 'อุปกรณ์บานเปิด EURO', 1005),
  (257, 'อุปกรณ์ประตูEURO', 4900),
  (258, 'ล้อบนบานเฟี้ยม', 750),
  (259, 'ล้อล่างบานเฟี้ยม', 700),
  (260, 'บานพับ (บานเฟี้ยม)', 240),
  (261, 'บานพับ+มือจับ (บานเฟี้ยม)', 320),
  (262, 'ตัวยึดบน (บานเฟี้ยม)', 340),
  (263, 'มือจับฝัง (บานเฟี้ยม)', 372);

CREATE TEMP TABLE _xl_links (type_name TEXT, series_name TEXT, mixed BOOLEAN) ON COMMIT DROP;
INSERT INTO _xl_links VALUES
  ('บานเลื่อน', 'ทั่วไป', true), ('บานเลื่อน', 'Big Frame', false), ('บานเลื่อน', 'ชุด 4" ใหม่', false),
  ('บานเลื่อนสวน 2 บาน', 'ทั่วไป', true), ('บานเลื่อนสวน 2 บาน', 'Big Frame', false), ('บานเลื่อนสวน 2 บาน', 'ชุด 4" ใหม่', false),
  ('บานเลื่อน 2 ตาย 2', 'ทั่วไป', true), ('บานเลื่อน 2 ตาย 2', 'Big Frame', false), ('บานเลื่อน 2 ตาย 2', 'ชุด 4" ใหม่', false),
  ('บานเลื่อน 3 บาน', 'ทั่วไป', true), ('บานเลื่อน 3 บาน', 'Big Frame', false), ('บานเลื่อน 3 บาน', 'ชุด 4" ใหม่', false),
  ('บานติดตาย', 'ทั่วไป', false), ('บานติดตาย', 'EURO', false), ('บานติดตาย', 'ชุด 4" ใหม่', false),
  ('STICK WALL', 'Curtain Wall NO.9xxx', false),
  ('UNITIZED CURTAIN WALL', 'Unitized', false), ('UNITIZED CURTAIN WALL', 'Unitized เล็ก', false),
  ('บานกระทุ้ง', 'ทั่วไป', false), ('บานกระทุ้ง', 'EURO', false),
  ('บานกระทุ้ง 1 ชั้น x 1 ช่อง = 1 บาน', 'ทั่วไป', false), ('บานกระทุ้ง 1 ชั้น x 1 ช่อง = 1 บาน', 'EURO', false),
  ('บานกระทุ้ง 1 ชั้น x 2 ช่อง = 2 บาน', 'ทั่วไป', false), ('บานกระทุ้ง 1 ชั้น x 2 ช่อง = 2 บาน', 'EURO', false),
  ('บานกระทุ้ง 1 ชั้น x 3 ช่อง = 3 บาน', 'ทั่วไป', false), ('บานกระทุ้ง 1 ชั้น x 3 ช่อง = 3 บาน', 'EURO', false),
  ('บานกระทุ้ง 1 ชั้น x 4 ช่อง = 4 บาน', 'ทั่วไป', false), ('บานกระทุ้ง 1 ชั้น x 4 ช่อง = 4 บาน', 'EURO', false),
  ('บานกระทุ้ง 2 ชั้น x 1 ช่อง = 2 บาน', 'ทั่วไป', false), ('บานกระทุ้ง 2 ชั้น x 1 ช่อง = 2 บาน', 'EURO', false),
  ('บานกระทุ้ง 2 ชั้น x 2 ช่อง = 4 บาน', 'ทั่วไป', false), ('บานกระทุ้ง 2 ชั้น x 2 ช่อง = 4 บาน', 'EURO', false),
  ('บานสวิง', 'ทั่วไป', false), ('บานสวิงเดี่ยว', 'ทั่วไป', false), ('บานสวิงคู่', 'ทั่วไป', false),
  ('บานเลื่อนรางแขวน', 'ทั่วไป', false),
  ('บานเฟี้ยม', 'บานเฟี้ยม', false),
  ('บานเปิด', 'EURO', false), ('บานเปิดข้าง', 'EURO', false);

DO $$
DECLARE
  c_tenant        CONSTANT UUID := '1b9affc4-2136-4ed1-b168-a36e6624e743';   -- FacadeX tenant (NOTICE prints its name)
  c_provider_name CONSTANT TEXT := 'ไฟล์ Aluminium calculation';
  c_finish_name   CONSTANT TEXT := 'POWDER COATING SAHARA';
  c_price_from    CONSTANT DATE := '2026-01-01';
  c_template_name CONSTANT TEXT := 'บานเลื่อนสวน 2 บาน ทั่วไป';
  v_tenant_name TEXT; v_provider UUID; v_n INT; v_part UUID; r RECORD;
  v_types_missing TEXT; v_series_missing TEXT;
BEGIN
  SELECT company_name INTO v_tenant_name FROM tenants WHERE id = c_tenant;
  IF v_tenant_name IS NULL THEN RAISE EXCEPTION 'ABORT: tenant % not found', c_tenant; END IF;
  RAISE NOTICE 'tenant = % (%)', v_tenant_name, c_tenant;
  SELECT id INTO v_provider FROM alu_providers WHERE tenant_id = c_tenant AND name = c_provider_name;
  IF v_provider IS NULL THEN RAISE EXCEPTION 'ABORT: provider % not found (run part 1 first)', c_provider_name; END IF;

  -- 1. finish
  INSERT INTO alu_finishes (tenant_id, provider_id, name) VALUES (c_tenant, v_provider, c_finish_name)
    ON CONFLICT (provider_id, name) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT; RAISE NOTICE 'finish inserted: % (price per kg NOT set: the file has the placeholder 1)', v_n;

  -- 2. hardware parts + prices
  v_n := 0;
  FOR r IN SELECT * FROM _xl_hw ORDER BY xl_row LOOP
    SELECT id INTO v_part FROM alu_parts WHERE tenant_id = c_tenant AND name = r.name;
    IF v_part IS NULL THEN
      INSERT INTO alu_parts (tenant_id, provider_id, name, kind, unit) VALUES (c_tenant, v_provider, r.name, 'hardware', 'ชิ้น') RETURNING id INTO v_part;
      v_n := v_n + 1;
    END IF;
    INSERT INTO alu_part_prices (tenant_id, part_id, list_price, discount_pct, effective_from, source)
      VALUES (c_tenant, v_part, r.price, 0, c_price_from, 'aluiminium calculation.xlsx row ' || r.xl_row)
      ON CONFLICT (part_id, effective_from) DO NOTHING;
  END LOOP;
  RAISE NOTICE 'hardware parts inserted: % of %', v_n, (SELECT count(*) FROM _xl_hw);
  RAISE NOTICE 'hardware prices now: %', (SELECT count(*) FROM alu_part_prices pp JOIN alu_parts p ON p.id = pp.part_id JOIN _xl_hw h ON h.name = p.name WHERE p.tenant_id = c_tenant);

  -- 3. series <-> type links
  SELECT string_agg(DISTINCT l.type_name, ', ') INTO v_types_missing FROM _xl_links l
    WHERE NOT EXISTS (SELECT 1 FROM door_window_types t WHERE t.tenant_id = c_tenant AND t.name = l.type_name);
  SELECT string_agg(DISTINCT l.series_name, ', ') INTO v_series_missing FROM _xl_links l
    WHERE NOT EXISTS (SELECT 1 FROM alu_series s WHERE s.tenant_id = c_tenant AND s.name = l.series_name);
  IF v_types_missing IS NOT NULL THEN RAISE NOTICE 'types not found (skipped): %', v_types_missing; END IF;
  IF v_series_missing IS NOT NULL THEN RAISE NOTICE 'series not found (skipped): %', v_series_missing; END IF;
  INSERT INTO alu_series_types (tenant_id, series_id, type_id, allow_mixed_thickness)
    SELECT c_tenant, s.id, t.id, l.mixed FROM _xl_links l
      JOIN alu_series s ON s.tenant_id = c_tenant AND s.name = l.series_name
      JOIN door_window_types t ON t.tenant_id = c_tenant AND t.name = l.type_name
    ON CONFLICT (series_id, type_id) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT; RAISE NOTICE 'series-type links inserted: % of %', v_n, (SELECT count(*) FROM _xl_links);

  -- 4. the sliding template's hardware rows
  UPDATE bom_template_hardware h SET part_id = p.id
    FROM bom_templates t, alu_parts p
    WHERE h.template_id = t.id AND t.tenant_id = c_tenant AND t.name = c_template_name AND h.part_id IS NULL
      AND p.tenant_id = c_tenant
      AND ((h.name = 'ลูกล้อ' AND p.name = 'ลูกล้อบานเลื่อน') OR (h.name = 'มือจับล็อค (ด้านใน)' AND p.name = 'มือจับฝัง(ล็อค)'));
  GET DIAGNOSTICS v_n = ROW_COUNT; RAISE NOTICE 'template hardware rows linked: %', v_n;
END $$;

-- Dry run: replace COMMIT with ROLLBACK, read the NOTICE lines, then run again with COMMIT.
COMMIT;
