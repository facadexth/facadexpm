# PREMIER (Goldstar Metal), part A: EURO SERIES, EXTRA PLUS, CLICK LOCK, railing

**What it is:** this file covers four of the PDFs in `DOC/ALUMNIUM CATALOG/PREMIER/`. Another helper does the rest of the folder.

| PDF | Pages | Printed |
|---|---|---|
| `EURO SERIE.pdf` | 32 | Vol.2026 |
| `EXTRA PLUS.pdf` | 44 | Vol.2026 |
| `CLICK LOCK.pdf` | 4 | undated |
| `E-Catalog Premier ราวกันตก.pdf` | 12 | undated |

The supplier is Aluminium Premier, บริษัท โกลด์สตาร์เมททอล จำกัด (Goldstar Metal), Call Center 089 918 9908.

Almost none of the pages have a text layer. Values were read from page images. The EXTRA PLUS weight columns do have text and were taken from it.

**How the rows are built:**
- PREMIER gives each wall thickness its own code, for example P-124563 = 1.2 mm and P-154465 = 1.5 mm of the same drawing. That makes one row per code, with no suffixes.
- Weights are printed **per bar** as low-high ranges:
  - ชุบ (anodize) and พ่น (powder coat) in every file;
  - ลายไม้ (wood grain) as well in EXTRA PLUS and CLICK LOCK.
- **kg_per_m = powder coat midpoint ÷ bar length** (6.40 m, or 6.00 m for ลูกฟูก). All raw ranges are in each row's note.
- `page` = the PDF page inside that series' `source_pdf`.

Data file: `premier-part-a.json`, **122 rows**. Of these:
- 119 have kg_per_m;
- 114 have wall_mm;
- 119 have width/depth.

Pictures: `DOC/ALUMNIUM CATALOG/_extracted/premier-a-sections/`, 119 PNGs plus manifest.json. They come from the dimensioned 1:1 section pages. Light-grey ghost parts and NEW badges were removed and a die caption added.

| Series (PDF pages) | Rows | kg/m | wall | pics | App types |
|---|---|---|---|---|---|
| EURO SERIES sliding, 4" frame (tables pp.4-6, sections pp.12-15) | 38 | 37 | 37 | 37 | บานเลื่อนสวน 2 บาน, บานเลื่อน 2 ตาย 2, บานเลื่อน 3 บาน, บานติดตาย |
| EURO SERIES casement / double / awning / fix (tables pp.20-21, sections pp.26-28) | 16 | 16 | 16 | 16 | บานเปิด, บานกระทุ้ง, บานติดตาย |
| EXTRA PLUS sliding, 10 cm frame (tables pp.4-6, sections pp.13-16, 21) | 28 | 28 | 28 | 28 | บานเลื่อนสวน 2 บาน, บานเลื่อน 2 ตาย 2, บานเลื่อน 3 บาน, บานติดตาย |
| EXTRA PLUS sliding with euro sash (table p.17, sections p.18) | 9 | 7 | 7 | 7 | บานเลื่อนสวน 2 บาน, บานเลื่อน 2 ตาย 2 |
| EXTRA PLUS casement / awning (tables pp.28-29, sections pp.36-39) | 18 | 18 | 18 | 18 | บานเปิด, บานกระทุ้ง, บานติดตาย |
| CLICK LOCK wall/ceiling cladding + ลูกฟูก (p.2) | 5 | 5 | 0 | 5 | none |
| ราวกันตก Smart Railing (pp.6-7) | 8 | 8 | 8 | 8 | none |

Three rows exist only in the shop-drawing parts lists, so they have no weight, wall or picture:
- **P-153620** and **P-153621**: EXTRA PLUS euro-sash head/sill;
- **P-154308**: EURO ตบก้าน.

**Hardware:** the JSON transcribes the hardware sheets with codes:
- EURO sliding: 25 items;
- EURO casement: 32 items;
- EXTRA PLUS sliding: 23 items, plus HD-214;
- EXTRA PLUS casement: 27 items;
- railing: 7 items.

The EXTRA PLUS shop drawings also carry per-window hardware quantity tables, which were not transcribed.

**Cut rules:**
- EXTRA PLUS p.27 prints "ตัดเข้ามุม 45°" for sash corners. Each corner takes 2 ฉากประคองบาน, 2 ฉากข้อต่อ 2x2" and ยางลูกโป่ง.
- The EURO elevations draw mitred corners and list corner cleats (ฉากเข้ามุม 24 / 41 mm).
- No cut lengths or glass formulas are printed anywhere, and there are no prices.

**Colours:**
- No colour names in the window tables. The finishes are anodize / powder coat, plus wood grain for EXTRA PLUS.
- Hardware comes in ดำ / ขาว / มิลล์ / แชมเปญ.
- CLICK LOCK: powder coat and สีลายไม้.
- Railing:
  - ALUMINIUM WOOD Italian wood-grain film;
  - powder coat with a 10-year warranty, swatches white / black / dark grey.

**Doubts:**
- **Weight basis.** kg/m uses the powder-coat midpoint, as instructed. aluwork used the anodize midpoint instead.
- **Likely misprinted weights:**
  - **P-124941**: the powder weight is higher than the 1.5 mm version, so its kg/m is too high.
  - **P-007407**, 50 mm railing post: only "1.39" is printed. That is probably kg/m, not kg per bar, which makes the stored 0.217 about 6x too low.
  - **P-403526**, railing bottom rail: looks too heavy.
- **One weight only.** P-123264 Adapter prints a single anodize weight, 3.48.
- **CLICK LOCK:**
  - The pictures for the 30 mm and screw-cover profiles print the placeholder code "P-123456". The table codes P-105022 / P-105020 are used instead.
  - No wall thickness is printed for any CLICK LOCK profile.
- **Codes outside the tables:**
  - P-009511, P-126776 and P-126778 appear only on hardware or drawing notes, so they are not in the rows.
  - P-103505 is called คิ้ว in the table, ฝาปิด on its drawing, and "P-113505" in one parts list.
- **Same code twice.** ฉากเข้ามุม 24 mm and 41 mm carry the same code, 02-HD-0-HD-214.
- **Guessed roles:** the role names are my mapping. Guessed ones are ตบก้าน, ตัวตบเฟรม, ตัวต่อเฟรมล่าง, and ตบยู/ตบเรียบ = ตบราง. New families are listed in the JSON.
