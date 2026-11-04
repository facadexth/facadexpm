# PREMIER (Goldstar Metal), part B: folding, Slim Line, SYNC, U-WALL and box slats

**What it is:** 7 PREMIER catalogues from บริษัท โกลด์สตาร์เมททอล จำกัด (กระทุ่มแบน, สมุทรสาคร), www.aluminiumpremier.com:

| File | Year |
|---|---|
| FOLDING DOOR.pdf | Vol.2026 |
| SLIM FOLDING.pdf | Vol.2025 |
| SLIM OPEN.pdf | Vol.2025 |
| SLIM SLIDING.pdf | Vol.2025-1 |
| SYNC SLIM.pdf | no year printed |
| Premier U-WALL.pdf | no year printed |
| Premier ระแนงอลูมิเนียมแบบกล่อง.pdf | no year printed |

The PDFs are image-only, so every value was read from page renders.

Each profile table prints, per die:
- one wall thickness;
- the bar length (6.40 m, or 6.00 m for angles and slats);
- the weight **per bar** as a low-high range, one for สีชุบ (anodize) and one for สีพ่น (powder coat). SYNC also prints a range for สีลายไม้ (woodgrain).

There are no prices, cut formulas or glass formulas.

**Data file:** `premier-part-b.json`, with **85 profile rows (80 distinct dies)**.
- Every row has a weight: kg/m = powder-coat midpoint ÷ bar length.
- Every row has a wall thickness.
- `page` is the page number in that series' own PDF.

**Pictures:** `DOC/ALUMNIUM CATALOG/_extracted/premier-b-sections/`, with 80 PNGs plus manifest.json.

| Series (file, pages) | Rows | App types |
|---|---|---|
| บานเฟี้ยม No.1, 4" frame option (FOLDING DOOR pp.5-8) | 4 | บานเฟี้ยม |
| บานเฟี้ยม No.1, frame 62 x 72.5 (FOLDING DOOR pp.18-26) | 16 | บานเฟี้ยม |
| SLIM LINE folding (SLIM FOLDING pp.10-14) | 9 | บานเฟี้ยม |
| SLIM LINE open doors (SLIM OPEN pp.10-11) | 11 | บานเปิด, บานติดตาย |
| SLIM LINE sliding, bottom roller (SLIM SLIDING pp.12-13) | 10 | บานเลื่อนสวน 2 บาน, บานเลื่อน 2 ตาย 2, บานเลื่อน 3 บาน, บานเลื่อนรางล่าง, บานติดตาย |
| SLIM LINE hanging (SLIM SLIDING pp.12-13) | 15 | บานเลื่อนรางแขวน, บานติดตาย |
| SYNC 3-panel synchronised, top-hung (SYNC p.10-11) | 8 | บานเลื่อน 3 บาน, บานเลื่อนรางแขวน |
| U-WALL slats and bases (U-WALL p.6) | 8 | none |
| ระแนงกล่องลายไม้ (box slats p.6) | 4 | none |

**Assembly rules:**
- **Folding door corners.** FOLDING DOOR p.16 prints that the frame and sash have a groove for corner angles, so corners are assembled at **45°**. pp.23-24 show a 90° folding corner, which uses corner post P-154312.
- **Other series.** Slim Line and SYNC do not print a cut angle. SLIM OPEN lists corner cleats (ฉากบานเปิด) and a SPINA PIN.
- **Shared dies:**
  - Slim Folding P-124058 is both the head and the jambs.
  - Slim Sliding P-003398 is head plus jamb.
  - P-254579 is the top and bottom rail of the sliding sash.
  - The hanging sash uses P-003325 (top rail) and P-003324 (bottom rail).
  - The SYNC head is P-245136 modules joined with plastic clips every 25-30 cm. Frame depth is 100 / 146 / 192 mm for 2 / 3 / 4 tracks.
- **Size limits:**
  - FOLDING DOOR: 900 mm × 3,000 mm per panel, 40 kg.
  - SLIM FOLDING: 600 mm × 2,500 mm, 30 kg.
  - SLIM OPEN: 900 mm × 2,400 mm.
  - SLIM SLIDING: 1,000 mm × 2,700 mm sliding, 1,000 mm × 2,400 mm hanging.
  - SYNC: 600-1,000 mm × 2,800 mm.

**Hardware with codes:**
- FOLDING DOOR p.26: 16 items, black (-3-) and white (-5-).
- SLIM FOLDING p.14: 15 items.
- SLIM OPEN p.11: 7 items.
- SLIM SLIDING p.13: 6 items.
- SYNC p.10: 4 hardware sets plus 2 plastic clips, with quantities per 3-panel set.

**Colours** (colour chart in FOLDING DOOR p.4 and box slats p.7):
- Powder coat: White 5, Black 17, Sahara Gray 49.
- Woodgrain: Butternut 121, Light Oak 119, Snow 118, Natural 122, Golden Teak 75, Teak 78, Red Teak 76, Brown Teak 77.
- Anodize: no colour names are printed.

**Doubts:**
- **Weight choice.** kg/m uses the powder-coat midpoint. P-124076 has no powder value, so it uses anodize.
- **No anodize weight:** box slats G-086284 and G-087947.
- **Missing sizes.** P-153090 (Joint B) has no dimensioned drawing, so its width and depth are null. G-300105's size (25.4) is taken from its name.
- **Missing die.** SLIM SLIDING p.8 (90° corner) uses P-003422, which is not in any table.
- **Typo.** FOLDING DOOR p.22 prints "P-107924 P-107923", which is probably P-107294 / P-107293.
- **Clipped picture.** The P-124528 drawing is cut off in the catalogue's own table cell, so its picture has confidence `check`.
- **Unconfirmed mapping.** The sash rails split between sliding and hanging is my mapping, based on the printed names.
