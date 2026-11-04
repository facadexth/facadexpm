# ALUINCH catalogues, part B (W, J, L, M, E, X, i series + ACC)

**What it is:** eight ALUINCH catalogue files from `DOC/ALUMNIUM CATALOG/ALUINCH/` (tagline "...WHERE YOUR DESIGN MEETS YOUR DESIRE..."). The files print no company name, address, year or prices. The other ALUINCH files (B, C, D, F, H, S, T, V) are in part A, which another helper is doing.

- `ALUINCH INT FOLDING DOOR.pdf` is **byte-identical** to `ALUINCH SLIM SLIDING.pdf` (same MD5). I read it once, as the X series.
- `ALUINCH ACC.pdf` (2 pages) has only rubbers and mohair: RG, RC, RE, RD, RX, RW, RB and AS. I recorded these as series accessories, not as profiles.
- The text layers are outlined, so only dimension numbers survive in them. I read every code, name and size from page images.

Data file: `aluinch-part-b.json`. It has 114 profile rows covering 113 distinct dies. E-03i appears in both the E ECO set and the i series.

**There is no weight anywhere in these catalogues, so `kg_per_m` is null in every row.** All rows are listed in open_questions.

| Series (file) | Rows | wall_mm filled | App types |
|---|---|---|---|
| W, casement / awning window (W-SERIE p.4) | 3 | 3 | บานกระทุ้ง, บานเปิด |
| J, joinery trims: U / T / L channels (J-SERIE p.3-4) | 16 | 16 | none |
| L, louvre blades and frames (L-SERIE p.3-4) | 15 | 8 | none (no louvre type exists) |
| M, slim wardrobe sliding (M-SERIE p.3-4) | 4 | 1 | บานเลื่อนรางแขวน, บานสวิง |
| E STANDARD, exterior sliding, 3 track 101.6 (EXT SLIDING p.5-6) | 29 | 27 | บานเลื่อนสวน 2 บาน, บานเลื่อน 2 ตาย 2, บานเลื่อน 3 บาน, บานเลื่อนรางล่าง, บานติดตาย |
| E ECO, 2 track 68 (p.7) | 7 | 7 | บานเลื่อนสวน 2 บาน, บานเลื่อน 3 บาน, บานเลื่อนรางล่าง |
| E LARGE, 4 track 135 (p.7) | 3 | 3 | บานเลื่อนรางล่าง, บานเลื่อน 3 บาน |
| X, extra-slim 16 mm solid interior doors (SLIM SLIDING p.4, p.15) | 14 | 0 (solid sections) | บานเลื่อนรางแขวน, บานสวิง, บานเปิด, บานเฟี้ยม, บานติดตาย |
| i, cabinet and closet frames and handles (CABINET p.3, 5, 6, 9) | 23 | 8 | บานเปิด, บานเลื่อนรางล่าง |

**Bar lengths:**
- W, M, E and X: 2.8 m and 6.4 m, printed on the tape graphic. I set std_length_m to 6.4.
- L: 6.0 m.
- J and i: the length is printed per item (2.5 to 6.4 m).

**Assembly and cut rules:**
- **Cut angle:** no catalogue prints a 45° or 90° cut. X and M rails butt between the stiles and are fixed with connector rods (X-A / M.A, Ø9 mm ports, M5/M6 screws), so those are 90° butt joints.
- **E standard sliding formulas (p.3), copied exactly as printed:**
  - 2 panel: `E = (D-146)/2`. This probably means F.
  - 3 panel [0:1:1]: `F = (D-196)/3`.
  - 4 panel [0:1:1:0]: `F = (D-309)/4`.
  - 4 panel [0:1:1:1]: `F = (D-246)/4`.
  - Sash height: `B = A-28`.
  - Glass: แนวตั้ง C+15 mm, แนวนอน F+18 mm.
  - The catalogue says "ใช้คำนวนเฉพาะบานเลื่อน Standard เท่านั้น".
- **Drain holes:** at least 8 cm long, one every 60 cm.
- **Rollers:** the printed numbers next to E-07 (60/80/160) and E-07A (120/240) are the EHR roller classes used with them.
- **W windows** sit in a T-20.01 frame (T series, in part A) and use the C-03 glazing bead (C series).

**Colours:**
- Profiles have no colour chart. The E pages print "ANODIZED 12 (±2) MICRON, ALLOY 6063T5, THICKNESS 1.5 MM".
- Hardware comes in white, black, grey or champagne. Rubbers come in white, black or grey.

**Pictures:** `DOC/ALUMNIUM CATALOG/_extracted/aluinch-b-sections/` holds 113 PNGs plus `manifest.json`. Each die has one picture, file name = die with spaces changed to `_`, and the manifest `die` matches the JSON `die_no` exactly. All crops were checked on contact sheets.
- **Shared pictures:**
  - E-03A and E-03B use the E-03 drawing.
  - E-03F uses the E-03E drawing.
  - E-04BE uses the E-04E drawing.
  - E-03i appears once, under the E ECO set.
- **Raster drawings:** XM-01 and XM-02 are raster images inside the PDF.

**Doubts:**
- **No weights:** there are no weights anywhere, and many walls are missing (X and M solid sections, several L and i rows).
- **Grey add-on parts:** E-03A, E-03B, E-03F and E-04BE have no name or size of their own.
- **Printed size vs drawing:** the size printed in the text differs from the drawing for M-01..M-03, i-01, i-02 and E-04E. The JSON uses the drawing.
- **Typo:** L-4368 is called "4668" in the Thai text.
- **Possible code clash:** S.01 may clash with a code in the S series file.
- **Role names** are my mapping.
- **Handles kept as hardware:** i-H, iH-01 and iH-02 are 160/174 mm handle pieces, so I recorded them as hardware.
