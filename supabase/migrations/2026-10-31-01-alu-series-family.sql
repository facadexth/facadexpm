-- supabase/migrations/2026-10-31-01-alu-series-family.sql
-- Series family (ซีรีส์หลัก): the project default names a family (e.g. ICONIQ EURO) and every item gets the family's
-- series for its door/window type. Spec: docs/superpowers/specs/2026-10-31-series-family-defaults-design.md (section 4).
-- Additive. Every foreign key keeps the default action (NO ACTION): a family that a series or a project still uses
-- cannot be removed; the catalogue screen says to switch it off instead. No view reads alu_series or
-- estimation_projects (checked 2026-10-31; the dry run lists live dependants too).
-- Seed: only tenant 1b9affc4-2136-4ed1-b168-a36e6624e743 has these series; every other tenant gets the schema only.
-- The words the SQL runner refuses never appear in this file (vitest guard: src/lib/migrationFiles20261031.test.js).

CREATE TABLE alu_series_families (
  id                UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id         UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  provider_id       UUID NOT NULL REFERENCES alu_providers(id),
  name              TEXT NOT NULL CHECK (btrim(name) <> ''),
  -- NULL = every thickness of the family's series; STANDARD = {1.0,1.2,1.5,1.8,2.0}
  thickness_options NUMERIC[] CHECK (thickness_options IS NULL OR (cardinality(thickness_options) > 0 AND 0 < ALL (thickness_options))),
  sort_order        INT NOT NULL DEFAULT 0,
  active            BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider_id, name),
  UNIQUE (id, provider_id)   -- target of alu_series' (family, provider) key: a series joins only its own extruder's family
);
CREATE INDEX idx_alu_series_families_tenant_id   ON alu_series_families(tenant_id);
CREATE INDEX idx_alu_series_families_provider_id ON alu_series_families(provider_id);
ALTER TABLE alu_series_families ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_full_access ON alu_series_families FOR ALL TO authenticated
  USING (((SELECT is_admin_or_owner()) AND (tenant_id = (SELECT current_tenant_id())) AND (SELECT has_module_access('estimation'::text))))
  WITH CHECK (((SELECT is_admin_or_owner()) AND (tenant_id = (SELECT current_tenant_id())) AND (SELECT has_module_access('estimation'::text))));

-- NULL = the series is a family of its own. Never named "family": alu_profiles.family is the profile's shape group.
ALTER TABLE alu_series ADD COLUMN series_family_id UUID;
ALTER TABLE alu_series ADD CONSTRAINT alu_series_series_family_fk
  FOREIGN KEY (series_family_id, provider_id) REFERENCES alu_series_families (id, provider_id);
CREATE INDEX idx_alu_series_series_family_id ON alu_series(series_family_id);

-- The project's default family. default_series_id stays (old projects, a series with no family).
ALTER TABLE estimation_projects ADD COLUMN default_series_family_id UUID REFERENCES alu_series_families(id);
CREATE INDEX idx_estimation_projects_default_family ON estimation_projects(default_series_family_id);

-- Seed the families (owner-approved table v4, 2026-10-31). Keys: ALM = Alumet, SP = SMART PLUS, SMS, MN.
WITH pv(k, id) AS (VALUES ('ALM', 'f634b34f-27de-4d8d-8766-4339bd0bced1'::uuid), ('SP', '0d407c5e-c318-4ab5-bdf5-03af2266e381'::uuid),
                   ('SMS', '33e74b71-b2aa-40d5-b6e2-45a8ad5f79f5'::uuid), ('MN', 'eabb17a4-a111-41e5-a59e-6b6226c7880a'::uuid)),
fam(k, name, thickness_options, sort_order) AS (VALUES
  ('ALM', 'STANDARD', ARRAY[1.0,1.2,1.5,1.8,2.0]::numeric[], 0),
  ('ALM', 'ICONIQ EURO', NULL::numeric[], 1),
  ('ALM', 'PRO SMART', NULL::numeric[], 2),
  ('ALM', 'PRO SMART X', NULL::numeric[], 3),
  ('ALM', 'MINI', NULL::numeric[], 4),
  ('SP', 'EURO 1.5', NULL::numeric[], 0),
  ('SP', 'SEMI EURO 1.2', NULL::numeric[], 1),
  ('SMS', 'STANDARD', ARRAY[1.0,1.2,1.5,1.8,2.0]::numeric[], 0),
  ('SMS', 'HOMELIFE', NULL::numeric[], 1),
  ('SMS', 'PROLINE', NULL::numeric[], 2),
  ('MN', 'STANDARD', ARRAY[1.0,1.2,1.5,1.8,2.0]::numeric[], 0),
  ('MN', 'ยูโร 2021', NULL::numeric[], 1),
  ('MN', 'ยูโร 4"', NULL::numeric[], 2),
  ('MN', 'ยูโรไทย', NULL::numeric[], 3),
  ('MN', 'บานเลื่อนใหญ่ 4" / 130 / 6"', NULL::numeric[], 4),
  ('MN', 'บานเลื่อนพิเศษ 4"', NULL::numeric[], 5),
  ('MN', 'บานเลื่อน ราง 110', NULL::numeric[], 6),
  ('MN', 'บานเลื่อนทั่วไป', NULL::numeric[], 7),
  ('MN', 'รางแขวน', NULL::numeric[], 8),
  ('MN', 'บานกระทุ้ง 2" / ยูเนี่ยน', NULL::numeric[], 9),
  ('MN', 'บานกระทุ้งเปิดข้าง', NULL::numeric[], 10),
  ('MN', 'ประตูบานเปิด 4"x1"', NULL::numeric[], 11),
  ('MN', 'ช่องแสง-บานสวิง', NULL::numeric[], 12),
  ('MN', 'บานเฟี้ยม', NULL::numeric[], 13),
  ('MN', 'ผนังกระจก', NULL::numeric[], 14),
  ('MN', 'ราวกันตก', NULL::numeric[], 15),
  ('MN', 'miscellaneous (misc.)', NULL::numeric[], 16)
)
INSERT INTO alu_series_families (tenant_id, provider_id, name, thickness_options, sort_order)
SELECT p.tenant_id, p.id, fam.name, fam.thickness_options, fam.sort_order
  FROM fam
  JOIN pv ON pv.k = fam.k
  JOIN alu_providers p ON p.id = pv.id AND p.tenant_id = '1b9affc4-2136-4ed1-b168-a36e6624e743'::uuid;

-- Put each series in its family: (extruder, family, series name exactly as stored).
WITH pv(k, id) AS (VALUES ('ALM', 'f634b34f-27de-4d8d-8766-4339bd0bced1'::uuid), ('SP', '0d407c5e-c318-4ab5-bdf5-03af2266e381'::uuid),
                   ('SMS', '33e74b71-b2aa-40d5-b6e2-45a8ad5f79f5'::uuid), ('MN', 'eabb17a4-a111-41e5-a59e-6b6226c7880a'::uuid)),
m(k, family_name, series_name) AS (VALUES
  ('ALM', 'STANDARD', 'MINI MC ท่อกลม / กล่องสี่เหลี่ยม'),
  ('ALM', 'ICONIQ EURO', 'ICONIQ EURO บานติดตาย'),
  ('ALM', 'ICONIQ EURO', 'ICONIQ EURO บานเปิด / บานกระทุ้ง'),
  ('ALM', 'ICONIQ EURO', 'ICONIQ EURO บานเลื่อน'),
  ('ALM', 'PRO SMART', 'PRO SMART บานติดตาย'),
  ('ALM', 'PRO SMART', 'PRO SMART บานเฟี้ยม'),
  ('ALM', 'PRO SMART', 'PRO SMART บานเลื่อน'),
  ('ALM', 'PRO SMART', 'PRO SMART หน้าต่างบานเปิด / บานกระทุ้ง'),
  ('ALM', 'PRO SMART X', 'PRO SMART X บานเปิด / บานกระทุ้ง'),
  ('ALM', 'PRO SMART X', 'PRO SMART X บานเลื่อน'),
  ('ALM', 'MINI', 'MINI CAS บานกระทุ้ง'),
  ('ALM', 'MINI', 'MINI CUR ผนังกระจก'),
  ('ALM', 'MINI', 'MINI OP บานเปิด'),
  ('ALM', 'MINI', 'MINI SH ช่องแสง / บานสวิง'),
  ('ALM', 'MINI', 'MINI SL บานเลื่อนมาตรฐาน'),
  ('SP', 'EURO 1.5', 'EURO 1.5 ชุดบานเปิด / บานกระทุ้ง / บานติดตาย'),
  ('SP', 'EURO 1.5', 'EURO 1.5 ชุดบานเลื่อน 2 ราง / 3 ราง'),
  ('SP', 'EURO 1.5', 'EURO 1.5 ชุดประตูบานเฟี้ยม'),
  ('SP', 'SEMI EURO 1.2', 'SEMI EURO 1.2 ชุดบานเปิด / บานกระทุ้ง / บานติดตาย'),
  ('SP', 'SEMI EURO 1.2', 'SEMI EURO 1.2 ชุดบานเลื่อน 2 ราง / 3 ราง'),
  ('SMS', 'STANDARD', 'SMS001 บานกระทุ้ง'),
  ('SMS', 'STANDARD', 'SMS001 บานสวิง / ช่องแสง'),
  ('SMS', 'STANDARD', 'SMS001 บานเลื่อน'),
  ('SMS', 'STANDARD', 'SMS001 ผนังกระจก'),
  ('SMS', 'STANDARD', 'SMS001 ระแนง / บังแดด'),
  ('SMS', 'STANDARD', 'SMS001 หน้าตัดมาตรฐาน (ท่อ / ฉาก / แบน / ราง)'),
  ('SMS', 'HOMELIFE', 'HOMELIFE 2000 (200) บานเลื่อน'),
  ('SMS', 'HOMELIFE', 'HOMELIFE 268 หน้าต่างบานเลื่อน 68.36'),
  ('SMS', 'HOMELIFE', 'HOMELIFE 3000 (220) บานเลื่อนเฟรม 45'),
  ('SMS', 'HOMELIFE', 'HOMELIFE 4000 (240) บานเฟี้ยม'),
  ('SMS', 'HOMELIFE', 'HOMELIFE 5000 (250) ประตูบานเปิดคู่'),
  ('SMS', 'HOMELIFE', 'HOMELIFE 6000 / 7000 (260) บานกระทุ้ง / บานเปิด'),
  ('SMS', 'PROLINE', 'PROLINE 1000 (100) ช่องแสง'),
  ('SMS', 'PROLINE', 'PROLINE 1000 (110) ช่องแสงร่องใหญ่'),
  ('SMS', 'PROLINE', 'PROLINE 130 / 131 ประตูบานสวิง'),
  ('MN', 'STANDARD', 'GROUP 01 ท่อ/ฉาก/ตัว U/เส้นแบน มาตรฐาน'),
  ('MN', 'ยูโร 2021', 'EURO SERIES SLIDING DOOR ประตูบานเลื่อนยูโร'),
  ('MN', 'ยูโร 2021', 'ชุดบานเลื่อน MN-U7125 EURO2021 (2 ราง)'),
  ('MN', 'ยูโร 2021', 'ชุดบานเลื่อน MN-U7126 EURO2021 (3 ราง)'),
  ('MN', 'ยูโร 4"', 'ชุดบานเลื่อน MN-7463 EURO 4" (3 ราง)'),
  ('MN', 'ยูโรไทย', 'ชุดบานเลื่อน EURO THAI'),
  ('MN', 'บานเลื่อนใหญ่ 4" / 130 / 6"', 'ชุดบานเลื่อนชุดใหญ่ MN-40303 / MN-42943'),
  ('MN', 'บานเลื่อนใหญ่ 4" / 130 / 6"', 'ชุดบานเลื่อนชุดใหญ่ MN-41479 (3 ราง)'),
  ('MN', 'บานเลื่อนใหญ่ 4" / 130 / 6"', 'ชุดบานเลื่อนชุดใหญ่ MN-42500 (130)'),
  ('MN', 'บานเลื่อนใหญ่ 4" / 130 / 6"', 'SLIDING FRAMES 101.6 / 130 / 151.9'),
  ('MN', 'บานเลื่อนใหญ่ 4" / 130 / 6"', 'SLIDING DOOR SASH หนา 38 มม. ร่อง 12'),
  ('MN', 'บานเลื่อนพิเศษ 4"', 'ชุดบานเลื่อน MN-4173B'),
  ('MN', 'บานเลื่อนพิเศษ 4"', 'SLIDING DOOR 101.6-103 มม.'),
  ('MN', 'บานเลื่อนพิเศษ 4"', 'ชุดบานเลื่อน MINI EURO'),
  ('MN', 'บานเลื่อน ราง 110', 'ชุดบานเลื่อน MN-4075 (3 ราง)'),
  ('MN', 'บานเลื่อน ราง 110', 'SLIDING 3 ราง 109.8'),
  ('MN', 'บานเลื่อนทั่วไป', 'SLIDING 95 มม. ชุดบานเลื่อนมาตรฐาน'),
  ('MN', 'บานเลื่อนทั่วไป', 'BOX-FRAME SLIDING 4"x1.75" (ร่องบาน 29.5)'),
  ('MN', 'บานเลื่อนทั่วไป', 'SLIDING WINDOW 2 ราง 71.5 + 1 ราง 36.35'),
  ('MN', 'บานเลื่อนทั่วไป', 'SLIDING 105.5 มม.'),
  ('MN', 'บานเลื่อนทั่วไป', 'FLY SCREEN (SLIDING) มุ้งบานเลื่อน'),
  ('MN', 'รางแขวน', 'ชุดประตูรางแขวน MN-U6359'),
  ('MN', 'รางแขวน', 'HANGING SLIDING RAIL บานเลื่อนรางแขวน'),
  ('MN', 'บานกระทุ้ง 2" / ยูเนี่ยน', 'ชุดบานกระทุ้ง 2" MN-50662 / MN-50690'),
  ('MN', 'บานกระทุ้ง 2" / ยูเนี่ยน', 'AWNING 36.5 / 48.5'),
  ('MN', 'บานกระทุ้ง 2" / ยูเนี่ยน', 'ชุดบานกระทุ้ง UNION (UN)'),
  ('MN', 'บานกระทุ้ง 2" / ยูเนี่ยน', 'AWNING 56.3'),
  ('MN', 'บานกระทุ้ง 2" / ยูเนี่ยน', 'AWNING-CASEMENT 36.63'),
  ('MN', 'บานกระทุ้งเปิดข้าง', 'AWNING กรอบนอก 4" ในตัว'),
  ('MN', 'บานกระทุ้งเปิดข้าง', 'CASEMENT 45/52'),
  ('MN', 'บานกระทุ้งเปิดข้าง', 'ชุดหน้าต่างบานเปิดยูโร MN-50624'),
  ('MN', 'ประตูบานเปิด 4"x1"', 'SHOPFRONT 4"x1" 101.6x25.4'),
  ('MN', 'ประตูบานเปิด 4"x1"', 'ชุดประตูบานเปิด MN-3513 / MN-30083 (วงกบบาง)'),
  ('MN', 'ประตูบานเปิด 4"x1"', 'ชุดประตูบานเปิด + ช่องแสงสลิม MN-30457'),
  ('MN', 'ประตูบานเปิด 4"x1"', 'ชุดคานผลักประตูหนีไฟ MN-30457 / MN-30458'),
  ('MN', 'ประตูบานเปิด 4"x1"', 'SHOPFRONT 101.6x20'),
  ('MN', 'ช่องแสง-บานสวิง', 'SWING DOOR ประตูบานสวิง'),
  ('MN', 'ช่องแสง-บานสวิง', 'SHOPFRONT 4"x2" กล่อง 101.6x50.8'),
  ('MN', 'ช่องแสง-บานสวิง', 'SHOPFRONT 3" 76.2x38.1'),
  ('MN', 'ช่องแสง-บานสวิง', 'SHOPFRONT 4" กล่อง 101.6x44.45'),
  ('MN', 'ช่องแสง-บานสวิง', 'SHOPFRONT 5" / 6"'),
  ('MN', 'ช่องแสง-บานสวิง', 'ชุดประตูบานเปิดเดี่ยว + ช่องแสง MN-50166'),
  ('MN', 'ช่องแสง-บานสวิง', 'ชุดประตูบานเปิดวงกบไม้ MN-1778'),
  ('MN', 'ช่องแสง-บานสวิง', 'ชุดประตูบานเลื่อน AUTOMATIC MN-U3393'),
  ('MN', 'บานเฟี้ยม', 'FOLDING DOOR ประตูบานเฟี้ยม'),
  ('MN', 'บานเฟี้ยม', 'ชุดบานเฟี้ยม (101.6)'),
  ('MN', 'ผนังกระจก', 'CURTAIN WALL ผนังกระจก (stick)'),
  ('MN', 'ผนังกระจก', 'CURTAIN WALL (CASEMENT) บานเปิดในผนังกระจก'),
  ('MN', 'ราวกันตก', 'ราวกันตก กระจก MN-BH034'),
  ('MN', 'ราวกันตก', 'ราวกันตก ลูกกรง MN-BH035'),
  ('MN', 'miscellaneous (misc.)', 'PIVOT WINDOW หน้าต่างบานหมุน'),
  ('MN', 'miscellaneous (misc.)', 'LIFTING WINDOW หน้าต่างบานยก'),
  ('MN', 'miscellaneous (misc.)', 'FRAMELESS DOOR ประตูบานเปลือย'),
  ('MN', 'miscellaneous (misc.)', 'AUTOMATIC SLIDING DOOR ฝาครอบประตูอัตโนมัติ'),
  ('MN', 'miscellaneous (misc.)', 'GLAZING BEAD คิ้วใส่กระจก'),
  ('MN', 'miscellaneous (misc.)', 'SPANDREL ลูกฟูก'),
  ('MN', 'miscellaneous (misc.)', 'LOUVER - SUNSHADE เกล็ดระบายอากาศ-แผงบังแดด'),
  ('MN', 'miscellaneous (misc.)', 'CLADDING / ROOFING / T-CEILING / BALUSTRADE / MISC (GROUP 07)'),
  ('MN', 'miscellaneous (misc.)', 'CASEMENT 4" (วงกบ 101.6x44.45)'),
  ('MN', 'miscellaneous (misc.)', 'FLY SCREEN (CASEMENT) มุ้งบานเปิด'),
  ('MN', 'miscellaneous (misc.)', 'ชุดประตูบานเปิด HEAVY DUTY MN-7855'),
  ('MN', 'miscellaneous (misc.)', 'SF20 SHOPFRONT'),
  ('MN', 'miscellaneous (misc.)', 'SW20 SWING DOOR'),
  ('MN', 'miscellaneous (misc.)', 'AWNING 3"'),
  ('MN', 'miscellaneous (misc.)', 'BOX-FRAME SLIDING 4" กล่อง 4" มีรางในตัว'),
  ('MN', 'miscellaneous (misc.)', 'T-SLOT SOLID BARS'),
  ('MN', 'miscellaneous (misc.)', 'ชุด ULTRA SLIM MN-7112')
)
UPDATE alu_series s
   SET series_family_id = f.id
  FROM m
  JOIN pv ON pv.k = m.k
  JOIN alu_series_families f ON f.provider_id = pv.id AND f.name = m.family_name
 WHERE s.provider_id = pv.id AND s.name = m.series_name;

-- Guard: on the database that has these extruders, every family and every listed series must have landed.
DO $$
DECLARE f INT; n INT;
BEGIN
  IF EXISTS (SELECT 1 FROM alu_providers WHERE id = 'eabb17a4-a111-41e5-a59e-6b6226c7880a'::uuid AND tenant_id = '1b9affc4-2136-4ed1-b168-a36e6624e743'::uuid) THEN
    SELECT count(*) INTO f FROM alu_series_families WHERE tenant_id = '1b9affc4-2136-4ed1-b168-a36e6624e743'::uuid;
    SELECT count(*) INTO n FROM alu_series WHERE tenant_id = '1b9affc4-2136-4ed1-b168-a36e6624e743'::uuid AND series_family_id IS NOT NULL;
    IF f <> 27 OR n <> 102 THEN
      RAISE EXCEPTION 'series family seed: % families (expect 27), % series (expect 102); was a series renamed after 2026-10-31?', f, n;
    END IF;
  END IF;
END $$;

-- Move projects whose default series now belongs to a family (spec section 4.4). A series with no family stays as it is.
UPDATE estimation_projects p
   SET default_series_family_id = s.series_family_id,
       primary_provider_id      = COALESCE(p.primary_provider_id, s.provider_id),
       default_series_id        = NULL
  FROM alu_series s
 WHERE s.id = p.default_series_id AND s.series_family_id IS NOT NULL;
