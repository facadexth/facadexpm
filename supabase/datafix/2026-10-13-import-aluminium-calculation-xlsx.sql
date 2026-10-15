-- ============================================================
-- ONE-OFF DATA IMPORT — โปรไฟล์อลูมิเนียม + กระจก จากไฟล์ "aluiminium calculation.xlsx" (generated 2026-10-13; NOT part of the code release).
-- What: 209 profiles (ชื่อ, ความหนา, กก./ม.) linked to 9 series under ONE provider, and 17 glass infill types.
--       Prices per kg are NOT imported (the file's ราคา/กก. cell I1 is the placeholder 1). Labour per glass (บาท/ตร.ฟ.) is listed in
--       comments only — infill_types has no labour column.
-- Units: the file prices glass in บาท/ตร.ฟ.; infill_types.price_per_sqm is per m², so each price is multiplied by c_sqft_per_sqm.
--       10.7639 ft²/m² is exact. The file itself divides m² by 0.09 (= 11.111 ft²/m², about 3.2 % more); set c_sqft_per_sqm := 1/0.09
--       if the totals must match the file instead.
-- Series: the engine resolves a template family through alu_series_profiles (series → family → thickness), so every profile is
--       linked to the series of its block in the file: 'ทั่วไป' (is_base) = the general rows, plus 'Big Frame', 'Curtain Wall NO.9xxx', 'EURO', 'Unitized', 'Unitized เล็ก', 'ชุด 3"', 'ชุด 4" ใหม่', 'บานเฟี้ยม'.
--       EURO grid rows are also linked to 'Big Frame' because the file's Big Frame totals use them. Prune links in the catalog UI later.
-- Naming: alu_profiles.name = alu_profiles.family = the file's row name, so BOM template families use the file's words verbatim.
--       Rows 154–161 (Unitized เล็ก) get the suffix " (เล็ก)" because they reuse the Unitized names with lighter sections.
--       Row 118 'ฝาเปิดปิด' (inside the 3" block) is imported as 'ฝาเปิดปิด 3"' to keep it apart from ฝาเปิดปิด 1.2 (row 27).
--       Duplicate identical rows (ธรณีสวิง 2 ×2, มือจับยาว 3 ×2) are imported once. Rows without กก./ม. are skipped.
-- Idempotent: a profile is skipped when (provider, name, thickness) already exists; a series/glass when (tenant/provider, name) exists;
--       links use ON CONFLICT DO NOTHING. Re-running changes nothing.
-- How:  verify c_tenant and c_provider_name below, dry-run with ROLLBACK first, then run as ONE transaction:
--       psql "$DB" -v ON_ERROR_STOP=1 -f 2026-10-13-import-aluminium-calculation-xlsx.sql
--       (or: npx supabase db query -f supabase/datafix/2026-10-13-import-aluminium-calculation-xlsx.sql)
-- ============================================================
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE _xl_profiles (xl_row INT, name TEXT, thickness_mm NUMERIC, kg_per_m NUMERIC, series TEXT[]) ON COMMIT DROP;
INSERT INTO _xl_profiles VALUES
  (5, 'กล่องร่อง', 1, 0.774, ARRAY['ทั่วไป']),
  (6, 'กล่องร่อง', 1.2, 1.001, ARRAY['ทั่วไป']),
  (7, 'กล่องร่อง', 1.3, 1.07, ARRAY['ทั่วไป']),
  (8, 'กล่องร่อง', 1.5, 1.202, ARRAY['ทั่วไป']),
  (9, 'กล่องร่อง', 1.75, 1.336, ARRAY['ทั่วไป']),
  (10, 'กล่องร่อง', 2, 1.538, ARRAY['ทั่วไป']),
  (11, 'กล่องร่อง', 2.5, 1.771, ARRAY['ทั่วไป']),
  (12, 'กล่องเรียบ', 1, 0.605, ARRAY['ทั่วไป']),
  (13, 'กล่องเรียบ', 1.2, 0.72, ARRAY['ทั่วไป']),
  (14, 'กล่องเรียบ', 1.3, 0.814, ARRAY['ทั่วไป']),
  (15, 'กล่องเรียบ', 1.5, 0.908, ARRAY['ทั่วไป']),
  (16, 'กล่องเรียบ', 1.75, 1.059, ARRAY['ทั่วไป']),
  (17, 'กล่องเรียบ', 2, 1.168, ARRAY['ทั่วไป']),
  (18, 'กล่องเรียบ', 2.5, 1.417, ARRAY['ทั่วไป']),
  (20, 'กล่องเปิดปิด', 1.2, 0.805, ARRAY['ทั่วไป']),
  (21, 'กล่องเปิดปิด', 1.3, 0.772, ARRAY['ทั่วไป']),
  (22, 'กล่องเปิดปิด', 1.5, 0.85, ARRAY['ทั่วไป']),
  (23, 'กล่องเปิดปิด', 1.8, 0.955, ARRAY['ทั่วไป']),
  (24, 'กล่องเปิดปิด', 2, 1.111, ARRAY['ทั่วไป']),
  (25, 'กล่องเปิดปิด', 2.5, 1.49, ARRAY['ทั่วไป']),
  (26, 'ฝาเปิดปิด', 1, 0.272, ARRAY['ทั่วไป']),
  (27, 'ฝาเปิดปิด', 1.2, 0.321, ARRAY['ทั่วไป']),
  (28, 'ฝาเปิดปิด', 1.5, 0.399, ARRAY['ทั่วไป']),
  (29, 'ตบร่อง', 1, 0.412, ARRAY['ทั่วไป']),
  (30, 'ตบร่อง', 1.1, 0.472, ARRAY['ทั่วไป']),
  (31, 'ตบร่อง', 1.5, 0.562, ARRAY['ทั่วไป']),
  (32, 'ตบเรียบ', 1, 0.272, ARRAY['ทั่วไป']),
  (33, 'ตบเรียบ', 1.1, 0.327, ARRAY['ทั่วไป']),
  (34, 'ตบเรียบ', 1.5, 0.408, ARRAY['ทั่วไป']),
  (35, 'กล่องแจ็คสัน', 1.5, 0.81, ARRAY['ทั่วไป']),
  (36, 'กล่องแจ็คสัน', 2, 1.137, ARRAY['ทั่วไป']),
  (37, 'ฝาแจ็คสัน', 1.5, 0.485, ARRAY['ทั่วไป']),
  (38, 'ฝาแจ็คสัน', 2, 0.596, ARRAY['ทั่วไป']),
  (39, 'เสาประตูสวิง', 1.5, 0.848, ARRAY['ทั่วไป']),
  (40, 'เสาประตูสวิง', 1.7, 0.933, ARRAY['ทั่วไป']),
  (41, 'เสาประตูสวิง', 2, 1.061, ARRAY['ทั่วไป']),
  (42, 'เสาประตูสวิง', 2.3, 1.208, ARRAY['ทั่วไป']),
  (43, 'เสาบนสวิง', 1.5, 0.81, ARRAY['ทั่วไป']),
  (44, 'เสาบนสวิง', 1.7, 0.902, ARRAY['ทั่วไป']),
  (45, 'เสาบนสวิง', 2, 1.038, ARRAY['ทั่วไป']),
  (46, 'เสาบนสวิง', 2.3, 1.074, ARRAY['ทั่วไป']),
  (47, 'เสาล่างสวิง', 1.5, 1.031, ARRAY['ทั่วไป']),
  (48, 'เสาล่างสวิง', 1.7, 1.16, ARRAY['ทั่วไป']),
  (49, 'เสาล่างสวิง', 2, 1.338, ARRAY['ทั่วไป']),
  (50, 'เสาล่างสวิง', 2.3, 1.522, ARRAY['ทั่วไป']),
  (51, 'คิ้วประตู', 1, 0.11, ARRAY['ทั่วไป']),
  (52, 'ธรณีสวิง', 2, 0.961, ARRAY['ทั่วไป']),
  (54, 'มือจับยาว', 3, 1.068, ARRAY['ทั่วไป']),
  (56, 'กล่องไม้ขีด', 1.4, 1.21, ARRAY['ทั่วไป']),
  (57, 'กล่องไม้ขีด', 1.5, 1.332, ARRAY['ทั่วไป']),
  (58, 'ซอยลูกฟัก', NULL, 0.489, ARRAY['ทั่วไป']),
  (59, 'รางแขวนใหญ่', NULL, 0.637, ARRAY['ทั่วไป']),
  (60, 'คิ้วลอยเทเล็ก 1"', NULL, 0.136, ARRAY['ทั่วไป']),
  (61, 'คิ้วลอยเทใหญ่ 1"', NULL, 0.177, ARRAY['ทั่วไป']),
  (62, 'เฟรมบน', 1, 0.714, ARRAY['ทั่วไป']),
  (63, 'เฟรมบน', 1.2, 0.815, ARRAY['ทั่วไป']),
  (64, 'เฟรมบน', 1.3, 0.9045, ARRAY['ทั่วไป']),
  (65, 'เฟรมบน', 1.5, 0.994, ARRAY['ทั่วไป']),
  (66, 'เฟรมบน', 1.8, 1.1, ARRAY['ทั่วไป']),
  (67, 'เฟรมล่าง', 1, 0.514, ARRAY['ทั่วไป']),
  (68, 'เฟรมล่าง', 1.2, 0.586, ARRAY['ทั่วไป']),
  (69, 'เฟรมล่าง', 1.3, 0.692, ARRAY['ทั่วไป']),
  (70, 'เฟรมล่าง', 1.5, 0.804, ARRAY['ทั่วไป']),
  (71, 'เฟรมล่าง', 1.8, 0.894, ARRAY['ทั่วไป']),
  (72, 'เฟรมข้าง', 1, 0.524, ARRAY['ทั่วไป']),
  (73, 'เฟรมข้าง', 1.2, 0.657, ARRAY['ทั่วไป']),
  (74, 'เฟรมข้าง', 1.3, 0.681, ARRAY['ทั่วไป']),
  (75, 'เฟรมข้าง', 1.5, 0.717, ARRAY['ทั่วไป']),
  (76, 'เฟรมข้าง', 1.8, 0.846, ARRAY['ทั่วไป']),
  (77, 'ตบธรณี', 1, 0.118, ARRAY['ทั่วไป']),
  (78, 'ตบธรณี', 1.3, 0.226, ARRAY['ทั่วไป']),
  (79, 'เสากุญแจ', 1, 0.497, ARRAY['ทั่วไป']),
  (80, 'เสากุญแจ', 1.2, 0.568, ARRAY['ทั่วไป']),
  (81, 'เสากุญแจ', 1.3, 0.596, ARRAY['ทั่วไป']),
  (82, 'เสากุญแจ', 1.5, 0.693, ARRAY['ทั่วไป']),
  (83, 'เสากุญแจ', 1.8, 0.855, ARRAY['ทั่วไป']),
  (84, 'เสาเกี่ยว', 1, 0.637, ARRAY['ทั่วไป']),
  (85, 'เสาเกี่ยว', 1.2, 0.696, ARRAY['ทั่วไป']),
  (86, 'เสาเกี่ยว', 1.3, 0.731, ARRAY['ทั่วไป']),
  (87, 'เสาเกี่ยว', 1.5, 0.774, ARRAY['ทั่วไป']),
  (88, 'เสาเกี่ยว', 1.8, 0.895, ARRAY['ทั่วไป']),
  (89, 'เสาตาย', 1, 0.328, ARRAY['ทั่วไป']),
  (90, 'เสาตาย', 1.2, 0.389, ARRAY['ทั่วไป']),
  (91, 'เสาตาย', 1.3, 0.412, ARRAY['ทั่วไป']),
  (92, 'เสาตาย', 1.5, 0.462, ARRAY['ทั่วไป']),
  (93, 'เสาตาย', 1.8, 0.588, ARRAY['ทั่วไป']),
  (94, 'บานเลื่อนบน', 1, 0.424, ARRAY['ทั่วไป']),
  (95, 'บานเลื่อนบน', 1.2, 0.468, ARRAY['ทั่วไป']),
  (96, 'บานเลื่อนบน', 1.3, 0.498, ARRAY['ทั่วไป']),
  (97, 'บานเลื่อนบน', 1.5, 0.541, ARRAY['ทั่วไป']),
  (98, 'บานเลื่อนบน', 1.8, 0.611, ARRAY['ทั่วไป']),
  (99, 'บานเลื่อนล่าง', 1, 0.471, ARRAY['ทั่วไป']),
  (100, 'บานเลื่อนล่าง', 1.2, 0.543, ARRAY['ทั่วไป']),
  (101, 'บานเลื่อนล่าง', 1.3, 0.61, ARRAY['ทั่วไป']),
  (102, 'บานเลื่อนล่าง', 1.5, 0.709, ARRAY['ทั่วไป']),
  (103, 'บานเลื่อนล่าง', 1.8, 0.864, ARRAY['ทั่วไป']),
  (104, 'ประกบกลาง', 1.2, 0.264, ARRAY['ทั่วไป']),
  (105, 'ประกบกลาง', 1.6, 0.295, ARRAY['ทั่วไป']),
  (106, 'กรอบมุ้งบานเลื่อน', 1, 0.327, ARRAY['ทั่วไป']),
  (107, 'กรอบมุ้งบานเลื่อน', 1.2, 0.395, ARRAY['ทั่วไป']),
  (108, 'กรอบมุ้งบานเลื่อน', 1.5, 0.48, ARRAY['ทั่วไป']),
  (109, 'ชนกลางมุ้ง', 1.3, 0.156, ARRAY['ทั่วไป']),
  (110, 'เส้นต่อกลาง', 1, 0.449, ARRAY['ทั่วไป']),
  (111, 'เส้นต่อกลาง', 1.2, 0.539, ARRAY['ทั่วไป']),
  (112, 'เฟรมบน 3"', 1.2, 0.629, ARRAY['ชุด 3"']),
  (113, 'เฟรมล่าง 3"', 1.2, 0.476, ARRAY['ชุด 3"']),
  (114, 'เฟรมข้าง 3"', 1.2, 0.517, ARRAY['ชุด 3"']),
  (115, 'กล่องร่อง 3"', 1.3, 0.783, ARRAY['ชุด 3"']),
  (116, 'กล่องเรียบ 3"', 1.3, 0.62, ARRAY['ชุด 3"']),
  (117, 'กล่องเปิดปิด 3"', 1.4, 0.77, ARRAY['ชุด 3"']),
  (118, 'ฝาเปิดปิด 3"', 1.2, 0.262, ARRAY['ชุด 3"']),
  (119, 'ตบร่อง 3"', 1.2, 0.422, ARRAY['ชุด 3"']),
  (120, 'ตบเรียบ 3"', 1.2, 0.223, ARRAY['ชุด 3"']),
  (121, 'วงกบไม้', 1.5, 0.782, ARRAY['ทั่วไป']),
  (122, 'วงกบไม้', 1.7, 0.88, ARRAY['ทั่วไป']),
  (123, 'กล่องเรียบมีปีก', 1.5, 1.04, ARRAY['ทั่วไป']),
  (124, 'คิ้วลอยเทใหญ่ผนัง', 1.1, 0.3, ARRAY['ทั่วไป']),
  (125, 'คิ้วลอยเทเล็ก', 1.1, 0.149, ARRAY['ทั่วไป']),
  (126, 'คิ้วลอยเทใหญ่', 1.1, 0.231, ARRAY['ทั่วไป']),
  (127, 'Z'' 3/4 X 4', 1.2, 0.64, ARRAY['ทั่วไป']),
  (128, 'Z'' 1/2 X 13/4', 1.1, 0.214, ARRAY['ทั่วไป']),
  (129, 'U'' 3/4 X 4', 1.2, 0.447, ARRAY['ทั่วไป']),
  (130, 'U'' 1/2 X 13/4', 1.1, 0.155, ARRAY['ทั่วไป']),
  (131, 'กล่อง 1-3/4 x 1- 1-3/4', 1.2, 0.455, ARRAY['ทั่วไป']),
  (132, 'รางแขวนใหญ่', 1.3, 0.563, ARRAY['ทั่วไป']),
  (134, 'NO.9010', 2.5, 2.747, ARRAY['Curtain Wall NO.9xxx']),
  (135, 'NO.9023', 2, 1.942, ARRAY['Curtain Wall NO.9xxx']),
  (136, 'NO.9019', 2.5, 0.608, ARRAY['Curtain Wall NO.9xxx']),
  (137, 'NO.3112', 1.8, 0.571, ARRAY['Curtain Wall NO.9xxx']),
  (138, 'NO.9013', 1.8, 1.493, ARRAY['Curtain Wall NO.9xxx']),
  (139, 'NO.9014', 1.3, 0.285, ARRAY['Curtain Wall NO.9xxx']),
  (140, 'NO.9015', 2, 0.399, ARRAY['Curtain Wall NO.9xxx']),
  (142, 'Gutter 13-0292a', 2, 2.236, ARRAY['Unitized']),
  (143, 'Sill13-0593a', 2, 1.709, ARRAY['Unitized']),
  (144, 'Fe-Mullion 13-0594a', 2, 1.624, ARRAY['Unitized']),
  (145, 'Ma-Mullion 13-0595a', 2, 2.038, ARRAY['Unitized']),
  (146, 'Int-Tran-W 13-0596a', 2, 2.654, ARRAY['Unitized']),
  (147, 'Int-Tran 13-0596a', 2, 2.738, ARRAY['Unitized']),
  (148, 'casement 13-0599a', 3, 1.286, ARRAY['Unitized']),
  (149, 'casem-base 13-0598a', 2, 1.148, ARRAY['Unitized']),
  (154, 'Gutter 13-0292a (เล็ก)', 2, 1.203, ARRAY['Unitized เล็ก']),
  (155, 'Sill13-0593a (เล็ก)', 2, 0.837, ARRAY['Unitized เล็ก']),
  (156, 'Fe-Mullion 13-0594a (เล็ก)', 2, 1.026, ARRAY['Unitized เล็ก']),
  (157, 'Ma-Mullion 13-0595a (เล็ก)', 2, 0.837, ARRAY['Unitized เล็ก']),
  (158, 'Int-Tran-W 13-0596a (เล็ก)', 2, 1.456, ARRAY['Unitized เล็ก']),
  (159, 'Int-Tran 13-0596a (เล็ก)', 2, 1.456, ARRAY['Unitized เล็ก']),
  (160, 'casement 13-0599a (เล็ก)', 3, 0.705, ARRAY['Unitized เล็ก']),
  (161, 'casem-base 13-0598a (เล็ก)', 2, 0.408, ARRAY['Unitized เล็ก']),
  (163, 'กรอบในกระทุ้ง+คิ้ว', 1.6, 0.705, ARRAY['ทั่วไป']),
  (164, 'กรอบนอกกระทุ้ง', 1.6, 0.408, ARRAY['ทั่วไป']),
  (165, 'ลูกฟุกลอนใหญ่', 1, 0.482, ARRAY['ทั่วไป']),
  (166, 'ลูกฟุกลอนเรี่ยบ', 1, 0.415, ARRAY['ทั่วไป']),
  (167, 'รางบนติดกล่อง', 1.2, 0.983, ARRAY['ทั่วไป']),
  (168, 'รางบนติดกล่อง', 1.5, 1.229, ARRAY['ทั่วไป']),
  (169, 'รางบนติดกล่อง', 1.8, 1.536, ARRAY['ทั่วไป']),
  (170, 'รางล่างติดกล่อง', 1.2, 0.9, ARRAY['ทั่วไป']),
  (171, 'รางล่างติดกล่อง', 1.5, 1.126, ARRAY['ทั่วไป']),
  (172, 'รางล่างติดกล่อง', 1.8, 1.351, ARRAY['ทั่วไป']),
  (173, 'รางข้างติดกล่อง', 1.2, 0.899, ARRAY['ทั่วไป']),
  (174, 'รางข้างติดกล่อง', 1.5, 1.124, ARRAY['ทั่วไป']),
  (175, 'รางข้างติดกล่อง', 1.8, 1.348, ARRAY['ทั่วไป']),
  (176, 'กล่องริมพร้อมเดรนยูโร', 2, 1.756, ARRAY['EURO', 'Big Frame']),
  (177, 'กล่องริมยูโร', 2, 1.572, ARRAY['EURO', 'Big Frame']),
  (178, 'คิ้วยูโร', 1, 0.185, ARRAY['EURO', 'Big Frame']),
  (179, 'ฝาตบกล่องริมยูโร', 1, 0.245, ARRAY['EURO', 'Big Frame']),
  (180, 'ซอยกลาง 2" ยูโร', 1.5, 0.899, ARRAY['EURO', 'Big Frame']),
  (181, 'ซอยกลาง 4" ยูโร', 1.5, 1.493, ARRAY['EURO', 'Big Frame']),
  (182, 'ซอยกลาง 6" ยูโร', 2, 2.961, ARRAY['EURO', 'Big Frame']),
  (183, 'บานหน้าต่างยูโร', 2, 0.978, ARRAY['EURO', 'Big Frame']),
  (184, 'บานประตูยูโร', 2, 1.797, ARRAY['EURO', 'Big Frame']),
  (185, 'กล่องริมยูโร 2"', 1.5, 0.813, ARRAY['EURO', 'Big Frame']),
  (186, 'รางบนบิ๊กเฟรม', 2, 1.309, ARRAY['Big Frame']),
  (187, 'รางล่างบิ๊กเฟรม', 2, 1.695, ARRAY['Big Frame']),
  (188, 'รางล่างบิ๊กเฟรม2ราง', 2, 2.1, ARRAY['Big Frame']),
  (189, 'รางข้างบานเลื่อน', 2, 1.371, ARRAY['Big Frame']),
  (190, 'ตบธรณีบานเลื่อน', 2, 0.445, ARRAY['Big Frame']),
  (191, 'เสากุญแจบานเลื่อน', 2, 1.114, ARRAY['Big Frame']),
  (192, 'เสาเกี่ยวบานเลื่อน', 2, 1.89, ARRAY['Big Frame']),
  (193, 'เสาตายบานเลื่อน', 2, 0.796, ARRAY['Big Frame']),
  (194, 'ขวางบนบานเลื่อน', 2, 1.009, ARRAY['Big Frame']),
  (195, 'ขวางล่างบานเลื่อน', 2, 1.495, ARRAY['Big Frame']),
  (196, 'รางบนชุด4"ใหม่', 1.5, 0.854, ARRAY['ชุด 4" ใหม่']),
  (197, 'รางล่างชุด4"ใหม่', 1.5, 0.823, ARRAY['ชุด 4" ใหม่']),
  (198, 'รางล่างชุด4"ใหม่ 3ราง', 1.5, 0.847, ARRAY['ชุด 4" ใหม่']),
  (199, 'รางข้างชุด4"ใหม่', 1.5, 0.904, ARRAY['ชุด 4" ใหม่']),
  (200, 'ขวางบนชุด4"ใหม่', 1.5, 0.541, ARRAY['ชุด 4" ใหม่']),
  (201, 'ขวางล่างชุด4"ใหม่', 1.5, 0.57, ARRAY['ชุด 4" ใหม่']),
  (202, 'เสากุญแจชุด4"ใหม่', 1.5, 0.756, ARRAY['ชุด 4" ใหม่']),
  (203, 'เสาเกี่ยวชุด4"ใหม่', 1.5, 0.743, ARRAY['ชุด 4" ใหม่']),
  (204, 'กล่องริม+ฝาชุด4"ใหม่', 1.5, 1.101, ARRAY['ชุด 4" ใหม่']),
  (205, 'ซอยกลาง2" ชุด4"ใหม่', 1.5, 0.68, ARRAY['ชุด 4" ใหม่']),
  (206, 'ซอยกลาง4" ชุด4"ใหม่', 1.2, 1.2, ARRAY['ชุด 4" ใหม่']),
  (207, 'คิ้วชุด4"ใหม่', 1.5, 0.12, ARRAY['ชุด 4" ใหม่']),
  (208, 'ธรณี 3 ราง', 1.2, 0.2, ARRAY['ชุด 4" ใหม่']),
  (209, 'รางบน', 2, 2.45, ARRAY['บานเฟี้ยม']),
  (210, 'รางข้าง', 2, 1.32, ARRAY['บานเฟี้ยม']),
  (211, 'รางล่าง', 2, 1.81, ARRAY['บานเฟี้ยม']),
  (212, 'ตบรางบน', 1.5, 0.43, ARRAY['บานเฟี้ยม']),
  (213, 'ตบรางข้าง', 1.5, 0.34, ARRAY['บานเฟี้ยม']),
  (214, 'ยูฝังพื้น', 1.5, 0.32, ARRAY['บานเฟี้ยม']),
  (215, 'กรอบบาน 3"', 1.8, 1.36, ARRAY['บานเฟี้ยม']),
  (216, 'บังใบนอก 3"', 1.8, 1.46, ARRAY['บานเฟี้ยม']),
  (217, 'บังใบใน 3"', 1.8, 1.46, ARRAY['บานเฟี้ยม']),
  (218, 'ต่อกลาง 3"', 1.8, 1.58, ARRAY['บานเฟี้ยม']),
  (219, 'คิ้วบาน 3"', 1.3, 0.263, ARRAY['บานเฟี้ยม']),
  (220, 'กรอบบาน 4"', 1.8, 1.621, ARRAY['บานเฟี้ยม']),
  (221, 'บังใบนอก 4"', 1.8, 1.702, ARRAY['บานเฟี้ยม']),
  (222, 'บังใบใน 4"', 2, 1.702, ARRAY['บานเฟี้ยม']),
  (223, 'คิ้วบาน 4"', 1.5, 0.331, ARRAY['บานเฟี้ยม']);

CREATE TEMP TABLE _xl_glass (name TEXT, price_per_sqft NUMERIC, labour_per_sqft NUMERIC, src TEXT) ON COMMIT DROP;
INSERT INTO _xl_glass VALUES
  ('กระจกใส 5มม.', 27.2, NULL, 'แถว 224'),
  ('กระจกใส 6มม.', 30.8, NULL, 'แถว 225'),
  ('กระจกใส 8มม.', 60, NULL, 'แถว 226'),
  ('กระจกใส 10มม.', 75, NULL, 'แถว 227'),
  ('กระจกใส 12มม.', 88, NULL, 'แถว 228'),
  ('กระจกสีชา 5มม.', 32.5, NULL, 'แถว 229'),
  ('กระจกสีชา 6มม.', 37.5, NULL, 'แถว 230'),
  ('กระจกสีชา 8มม.', 75, NULL, 'แถว 231'),
  ('กระจกสีชา 10มม.', 90, NULL, 'แถว 232'),
  ('กระจกสีชา 12มม.', 105, NULL, 'แถว 233'),
  ('SOLA TAX 6มม.', 115, NULL, 'แถว 234'),
  ('กระจกเงา 5มม.', 39, NULL, 'แถว 235'),
  ('กระจกเงา 6มม.', 43, NULL, 'แถว 236'),
  ('กระจกอบใส 12มม.', 215, 40, 'ค่าที่ VLOOKUP คืนในเซลล์ F331'),
  ('กระจกลามิเนตอบสี 8+8', 555, 60, 'ค่าที่ VLOOKUP คืนในเซลล์ F348'),
  ('กระจกลามิเนตใส 4+4', 125, 20, 'ค่าที่ VLOOKUP คืนในเซลล์ G367'),
  ('กระจกอบใส 10มม.', 190, 30, 'ค่าที่ VLOOKUP คืนในเซลล์ G383');

DO $$
DECLARE
  c_tenant        CONSTANT UUID    := '1b9affc4-2136-4ed1-b168-a36e6624e743';  -- FacadeX tenant: VERIFY (the NOTICE below prints its name)
  c_provider_name CONSTANT TEXT    := 'ไฟล์ Aluminium calculation';            -- change to an existing extruder's name to import under it
  c_sqft_per_sqm  CONSTANT NUMERIC := 10.7639;                                  -- or 1/0.09 to match the file's rounding
  v_tenant_name TEXT; v_provider UUID; v_series UUID; v_profile UUID; v_sname TEXT;
  r RECORD; n_prof INT := 0; n_skip INT := 0; n_link INT := 0; n_glass INT := 0; n_gskip INT := 0;
BEGIN
  SELECT company_name INTO v_tenant_name FROM tenants WHERE id = c_tenant;
  IF v_tenant_name IS NULL THEN RAISE EXCEPTION 'ABORT: tenant % not found', c_tenant; END IF;
  RAISE NOTICE 'tenant = % (%)', v_tenant_name, c_tenant;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'alu_profiles' AND column_name = 'butt_distance_mm') THEN
    RAISE EXCEPTION 'ABORT: apply migration 2026-10-15-01-bom-part-editor first';
  END IF;

  SELECT id INTO v_provider FROM alu_providers WHERE tenant_id = c_tenant AND name = c_provider_name;
  IF v_provider IS NULL THEN
    INSERT INTO alu_providers (tenant_id, name, short_name, price_basis) VALUES (c_tenant, c_provider_name, 'XLS', 'per_kg') RETURNING id INTO v_provider;
    RAISE NOTICE 'provider created: %', c_provider_name;
  ELSE
    RAISE NOTICE 'provider exists: % (%)', c_provider_name, v_provider;
  END IF;

  FOREACH v_sname IN ARRAY ARRAY['ทั่วไป', 'Big Frame', 'Curtain Wall NO.9xxx', 'EURO', 'Unitized', 'Unitized เล็ก', 'ชุด 3"', 'ชุด 4" ใหม่', 'บานเฟี้ยม'] LOOP
    IF NOT EXISTS (SELECT 1 FROM alu_series WHERE provider_id = v_provider AND name = v_sname) THEN
      INSERT INTO alu_series (tenant_id, provider_id, name, is_base) VALUES (c_tenant, v_provider, v_sname, v_sname = 'ทั่วไป');
    END IF;
  END LOOP;

  FOR r IN SELECT * FROM _xl_profiles ORDER BY xl_row LOOP
    SELECT id INTO v_profile FROM alu_profiles
     WHERE provider_id = v_provider AND name = r.name AND thickness_mm IS NOT DISTINCT FROM r.thickness_mm
     ORDER BY id LIMIT 1;
    IF v_profile IS NULL THEN
      INSERT INTO alu_profiles (tenant_id, provider_id, name, family, thickness_mm, linear_weight_kg_per_m, default_length_m)
      VALUES (c_tenant, v_provider, r.name, r.name, r.thickness_mm, r.kg_per_m, 6.4) RETURNING id INTO v_profile;
      n_prof := n_prof + 1;
    ELSE
      n_skip := n_skip + 1;
    END IF;
    FOREACH v_sname IN ARRAY r.series LOOP
      SELECT id INTO v_series FROM alu_series WHERE provider_id = v_provider AND name = v_sname;
      INSERT INTO alu_series_profiles (tenant_id, series_id, profile_id, family)
      VALUES (c_tenant, v_series, v_profile, r.name)
      ON CONFLICT (series_id, profile_id) DO NOTHING;
      IF FOUND THEN n_link := n_link + 1; END IF;
    END LOOP;
  END LOOP;

  FOR r IN SELECT * FROM _xl_glass LOOP
    IF EXISTS (SELECT 1 FROM infill_types WHERE tenant_id = c_tenant AND name = r.name) THEN
      n_gskip := n_gskip + 1;
    ELSE
      INSERT INTO infill_types (tenant_id, name, price_per_sqm, material_kind)
      VALUES (c_tenant, r.name, round(r.price_per_sqft * c_sqft_per_sqm, 2), 'glass');
      n_glass := n_glass + 1;
    END IF;
  END LOOP;

  RAISE NOTICE 'profiles inserted % / already there %, series links added %, glass inserted % / already there %', n_prof, n_skip, n_link, n_glass, n_gskip;
END $$;

-- Dry run: replace COMMIT with ROLLBACK, read the NOTICE lines, then run again with COMMIT.
COMMIT;
