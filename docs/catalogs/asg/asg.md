# ASG Aluminium Profile Catalogue

**Source:** `DOC/ALUMNIUM CATALOG/ASG Profile Catalogue.pdf`, 51 pages, vector drawings with a usable text layer. Every code, weight and wall thickness was checked against rendered images of the caption blocks.
**Supplier:** บริษัท เอเอสจี อลูมิเนียม โปรไฟล์ (ASG, the brand owner). Made by บริษัท คองช์ บิวดิ้ง แมททีเรียลส์ จำกัด (มอก. 284-2560, ISO 9001:2015). The alloy is 6063-T5.
**Year:** not printed. The PDF was created on 2024-06-27.
**Bar length:** not printed. `std_length_m` is set to 6.4 as an assumption.
**Prices:** none in this catalogue.

Pages 1-5 cover the company, colours and reference projects. Pages 6-51 are profile pages: one drawing per profile with code, Thai name, `WEIGHT x kg/m` and `WALL THICKNESS x mm`. The standard (assembly) drawings are on pages 12, 18, 21, 28, 34, 37, 41, 44, 50 and 51.

## Series

| Series | Pages | Rows | App types |
|---|---|---|---|
| ASG ชุดประตู หน้าต่างบานเลื่อน (Sliding window & door) | 6-12 | 19 | บานเลื่อน, บานเลื่อนสวน 2 บาน, บานเลื่อน 2 ตาย 2, บานเลื่อน 3 บาน |
| ASG ชุดบานกระทุ้ง/บานเปิด (Awning & casement) | 13-18 | 17 | บานกระทุ้ง, บานเปิด, บานติดตาย |
| ASG ประตูบานเปิด (วงกบไม้) (Door) | 19-21 | 5 | บานเปิด |
| ASG บานเลื่อน ยูโร (Euro sliding) | 22-28 | 17 | บานเลื่อน, บานเลื่อนสวน 2 บาน, บานเลื่อน 2 ตาย 2, บานเลื่อน 3 บาน |
| ASG บานเฟี้ยม (Folding door) | 29-34 | 13 | บานเฟี้ยม |
| ASG ช่องแสง 30 mm (Fix frame 30 mm) | 35-37 | 4 | บานติดตาย |
| ASG ฉากอลูมิเนียม 50 x 50 (Angle) | 36 | 2 | none |
| ASG (SM) ชุดประตู หน้าต่างบานเลื่อน (Sliding SM) | 38-41 | 9 | บานเลื่อน, บานเลื่อนสวน 2 บาน, บานเลื่อน 2 ตาย 2 |
| ASG (SM) ช่องแสง 35 mm (Fix frame 35 mm SM) | 42-44 | 6 | บานติดตาย |
| ASG (SM) ประตูบานสวิง (Swing door SM) | 45-47, 50 | 6 | บานสวิง, บานสวิงเดี่ยว, บานสวิงคู่ |
| ASG (SM) ชุดบานกระทุ้ง/บานเปิด (Awning SM) | 46-47, 51 | 3 | บานกระทุ้ง, บานเปิด |
| ASG (SM) ระแนง (Rail / slats SM) | 48-49 | 6 | none |

**Counts:** 12 series and 107 rows. There are 107 distinct dies, because each die is printed with only one wall thickness. Every row has a weight, and there are 107 pictures. 98 rows are marked `read` and 9 are marked `check`.

`width_mm` and `depth_mm` are the overall horizontal and vertical dimensions as drawn. They are `null` where no overall dimension is printed: S12, AC04, AC05, SM15, SM17 and SM27.

**Pictures:** `DOC/ALUMNIUM CATALOG/_extracted/asg-sections/` holds one PNG per die at 300 dpi, with the caption excluded, plus `manifest.json`. These replace the earlier 2026-10-31 set and use the same file names.

**Colours (page 3):** wood grain (สีลายไม้), white powder coat (สีอบขาว), black powder coat (สีอบดำ), Sahara grey (สีเทาซาฮาร่า), and special colours to order with no minimum quantity.

## Doubts
- **Typos in the codes.** Four codes are printed with "SAG-": SAG-S01, SAG-SM01, SAG-SM04 and SAG-SM07. They are stored as ASG-S01, ASG-SM01, ASG-SM04 and ASG-SM07, and each note says so.
- **Meaning of "(SM)".** The pages 38-51 headers say "Profile Catalogue (SM)", but "SM" is never explained. Page 2 mentions both a market-grade sliding set (ตลาดพัฒนา) and a SEMI set. The SM walls are mostly 1.0 mm.
- **S01 and S18.** Both are named "เฟรม 3 รางภายใน", but S01 is a 9 mm strip and S18 is a 40 mm box. No 3-track assembly drawing is printed.
- **SM20-22 (the awning sash, frame and bead).** They are printed under the SWING DOOR heading, but page 51 shows them in the SM awning/casement set, so they are placed in the awning set here. That set also uses SM10 and SM15, which stay listed in the fix-frame 35 set.
- **L05/L06 (50x50 angles).** They are printed after the fix-frame 30 pages and are kept as their own series.
- **Euro sliding head frame.** There is no separate head frame; US03 is probably used at the head as well.
- **Rails used top and bottom.** S07, SM05 and SM19 are labelled as bottom rails (ขวางล่าง), but the assembly drawings show them at both top and bottom.
- **Shared profiles.** The wood-frame door also uses AC11 and AC17 (page 21).
