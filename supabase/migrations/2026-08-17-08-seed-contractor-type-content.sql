-- supabase/migrations/2026-08-17-08-seed-contractor-type-content.sql
--
-- Content drafted from general knowledge of well-known Thai
-- construction-material brands (not verified business relationships),
-- confirmed with the user as a v1 starting point — editable any time by
-- updating these tables directly, no code change or redeploy needed.
-- See docs/superpowers/specs/2026-08-17-contractor-type-starter-templates-design.md
-- for the full type→category→supplier table this transcribes.

INSERT INTO contractor_types (key, label_th, sort_order) VALUES
  ('painting',           'ทาสี',                    1),
  ('glass_aluminum',     'กระจก/อลูมิเนียม',        2),
  ('electrical',         'ไฟฟ้า',                   3),
  ('plumbing',           'ประปา/สุขาภิบาล',         4),
  ('structural_concrete','โครงสร้าง/คอนกรีต',       5),
  ('roofing',            'หลังคา',                  6),
  ('tiling_flooring',    'กระเบื้อง/พื้นผิว',       7),
  ('drywall_ceiling',    'ผนังเบา/ฝ้าเพดาน',        8),
  ('hvac',               'ปรับอากาศ',               9),
  ('steelwork',          'งานเหล็ก/โครงเหล็ก',      10);

INSERT INTO contractor_type_categories (contractor_type_id, name, color, sort_order)
SELECT ct.id, v.name, v.color, v.sort_order
FROM (VALUES
  ('painting',            'ค่าสี',                     '#FF6B6B', 1),
  ('painting',            'ค่าอุปกรณ์ทาสี',            '#FFD166', 2),
  ('painting',            'ค่าแรงช่างทาสี',            '#9E9EC8', 3),

  ('glass_aluminum',      'ค่ากระจก',                  '#4ECDC4', 1),
  ('glass_aluminum',      'ค่าอลูมิเนียม/เหล็ก',        '#6C63FF', 2),
  ('glass_aluminum',      'ค่าซิลิโคน/ยาง',            '#A29BFE', 3),

  ('electrical',          'ค่าสายไฟ/อุปกรณ์ไฟฟ้า',     '#FFD166', 1),
  ('electrical',          'ค่าเบรกเกอร์/ตู้ไฟ',        '#74B9FF', 2),
  ('electrical',          'ค่าแรงช่างไฟฟ้า',           '#9E9EC8', 3),

  ('plumbing',            'ค่าท่อ/ข้อต่อ',             '#4ECDC4', 1),
  ('plumbing',            'ค่าสุขภัณฑ์',                '#74B9FF', 2),
  ('plumbing',            'ค่าแรงช่างประปา',           '#9E9EC8', 3),

  ('structural_concrete', 'ค่าปูน/คอนกรีตผสมเสร็จ',    '#6C63FF', 1),
  ('structural_concrete', 'ค่าเหล็กเส้น',              '#FD79A8', 2),
  ('structural_concrete', 'ค่าแรงช่างโครงสร้าง',       '#9E9EC8', 3),

  ('roofing',             'ค่ากระเบื้อง/แผ่นหลังคา',   '#FF6B6B', 1),
  ('roofing',             'ค่าโครงหลังคา',             '#FD79A8', 2),
  ('roofing',             'ค่าแรงช่างหลังคา',          '#9E9EC8', 3),

  ('tiling_flooring',     'ค่ากระเบื้อง',              '#4ECDC4', 1),
  ('tiling_flooring',     'ค่าปูนกาว/ยาแนว',           '#FFD166', 2),
  ('tiling_flooring',     'ค่าแรงช่างปู',              '#9E9EC8', 3),

  ('drywall_ceiling',     'ค่าแผ่นยิปซั่ม/สมาร์ทบอร์ด', '#74B9FF', 1),
  ('drywall_ceiling',     'ค่าโครงคร่าว',              '#A29BFE', 2),
  ('drywall_ceiling',     'ค่าแรงช่างฝ้า/ผนัง',        '#9E9EC8', 3),

  ('hvac',                'ค่าเครื่องปรับอากาศ',       '#4ECDC4', 1),
  ('hvac',                'ค่าท่อ/ฉนวนแอร์',           '#74B9FF', 2),
  ('hvac',                'ค่าแรงช่างแอร์',            '#9E9EC8', 3),

  ('steelwork',           'ค่าเหล็กรูปพรรณ',           '#FD79A8', 1),
  ('steelwork',           'ค่าสี/สารกันสนิม',          '#FF6B6B', 2),
  ('steelwork',           'ค่าแรงช่างเหล็ก/เชื่อม',     '#9E9EC8', 3)
) AS v(type_key, name, color, sort_order)
JOIN contractor_types ct ON ct.key = v.type_key;

INSERT INTO contractor_type_category_suppliers (category_template_id, supplier_name, sort_order)
SELECT c.id, v.supplier_name, 1
FROM (VALUES
  ('painting',            'ค่าสี',                     'TOA'),
  ('painting',            'ค่าอุปกรณ์ทาสี',            'ไทวัสดุ'),

  ('glass_aluminum',      'ค่ากระจก',                  'กระจกไทยอาซาฮี'),
  ('glass_aluminum',      'ค่าอลูมิเนียม/เหล็ก',        'TOSTEM'),
  ('glass_aluminum',      'ค่าซิลิโคน/ยาง',            'Dow Corning'),

  ('electrical',          'ค่าสายไฟ/อุปกรณ์ไฟฟ้า',     'บางกอกเคเบิ้ล'),
  ('electrical',          'ค่าเบรกเกอร์/ตู้ไฟ',        'Schneider Electric'),

  ('plumbing',            'ค่าท่อ/ข้อต่อ',             'SCG'),
  ('plumbing',            'ค่าสุขภัณฑ์',                'American Standard'),

  ('structural_concrete', 'ค่าปูน/คอนกรีตผสมเสร็จ',    'ปูนอินทรี (INSEE)'),
  ('structural_concrete', 'ค่าเหล็กเส้น',              'TATA Steel'),

  ('roofing',             'ค่ากระเบื้อง/แผ่นหลังคา',   'ตราเพชร'),
  ('roofing',             'ค่าโครงหลังคา',             'เหล็กสยามยามาโตะ'),

  ('tiling_flooring',     'ค่ากระเบื้อง',              'คอตโต้ (COTTO)'),
  ('tiling_flooring',     'ค่าปูนกาว/ยาแนว',           'ตราจระเข้'),

  ('drywall_ceiling',     'ค่าแผ่นยิปซั่ม/สมาร์ทบอร์ด', 'ยิปซัม (Gyproc)'),
  ('drywall_ceiling',     'ค่าโครงคร่าว',              'ไทวัสดุ'),

  ('hvac',                'ค่าเครื่องปรับอากาศ',       'ไดกิ้น (Daikin)'),
  ('hvac',                'ค่าท่อ/ฉนวนแอร์',           'Aeroflex'),

  ('steelwork',           'ค่าเหล็กรูปพรรณ',           'เหล็กสยามยามาโตะ'),
  ('steelwork',           'ค่าสี/สารกันสนิม',          'TOA')
) AS v(type_key, category_name, supplier_name)
JOIN contractor_types ct ON ct.key = v.type_key
JOIN contractor_type_categories c ON c.contractor_type_id = ct.id AND c.name = v.category_name;
