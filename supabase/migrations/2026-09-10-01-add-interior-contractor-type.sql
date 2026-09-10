-- supabase/migrations/2026-09-10-01-add-interior-contractor-type.sql
--
-- Adds "interior" (งานตกแต่งภายใน) as a contractor type, following the
-- same type -> 3 categories -> suggested suppliers pattern seeded in
-- 2026-08-17-08-seed-contractor-type-content.sql. Content drafted from
-- general knowledge of well-known Thai brands (not verified business
-- relationships), same as the original seed -- editable any time by
-- updating these tables directly.

INSERT INTO contractor_types (key, label_th, sort_order) VALUES
  ('interior', 'ตกแต่งภายใน', 11);

INSERT INTO contractor_type_categories (contractor_type_id, name, color, sort_order)
SELECT ct.id, v.name, v.color, v.sort_order
FROM (VALUES
  ('interior', 'ค่าวัสดุปูพื้น/ผนังตกแต่ง', '#A29BFE', 1),
  ('interior', 'ค่าเฟอร์นิเจอร์/บิวท์อิน',   '#FFD166', 2),
  ('interior', 'ค่าแรงช่างตกแต่งภายใน',      '#9E9EC8', 3)
) AS v(type_key, name, color, sort_order)
JOIN contractor_types ct ON ct.key = v.type_key;

INSERT INTO contractor_type_category_suppliers (category_template_id, supplier_name, sort_order)
SELECT c.id, v.supplier_name, 1
FROM (VALUES
  ('interior', 'ค่าวัสดุปูพื้น/ผนังตกแต่ง', 'ไทวัสดุ'),
  ('interior', 'ค่าเฟอร์นิเจอร์/บิวท์อิน',   'SB Design Square')
) AS v(type_key, category_name, supplier_name)
JOIN contractor_types ct ON ct.key = v.type_key
JOIN contractor_type_categories c ON c.contractor_type_id = ct.id AND c.name = v.category_name;
