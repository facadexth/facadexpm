# ALUINCH catalogue, part A (T, F, V, D, S, B, C, H series)

**What it is:** eight series PDFs from ALUINCH ("MEETS YOUR DESIRE ... WHERE YOUR DESIGN"), in `DOC/ALUMNIUM CATALOG/ALUINCH/`. Each PDF follows the same layout:
- p.1-3: photos and an intro;
- p.4 (and p.6 for T and S): the profile page;
- p.5-6 for B, C and H: hardware;
- the remaining pages: section drawings.

No company details, year, prices, weights or aluminium colours are printed anywhere. The other ALUINCH PDFs (EXT SLIDING, SLIM SLIDING, INT FOLDING, CABINET, J, L, M, W, ACC) are in part B.

Data file: `aluinch-part-a.json`, with **92 rows, one per die**. ALUINCH prints one wall thickness per die, so `die_no` never repeats. Pictures are in `DOC/ALUMNIUM CATALOG/_extracted/aluinch-a-sections/` (92 PNGs plus manifest.json). H.04A and H.06A have no drawing of their own, so their PNGs reuse the H.04 / H.06 drawing.

| Series (PDF) | Rows | With wall | App types | What it is |
|---|---|---|---|---|
| T (T-SERIE, pp.4, 6) | 25 | 20 | บานติดตาย, บานเปิด, บานสวิง | Office glass-partition boxes 101.6 x 20/25, corner posts, power pole, T5 light batten. Glass 6-12 mm with rubber, 15 mm with silicone. Swing doors are 35/45 mm leaves on T-35/45/55 stops. |
| F (F-SERIE, p.4) | 12 | 8 | บานติดตาย, บานเปิด, บานสวิง | The same partition system in a 45 mm "mini" section. |
| V (V-SERIE, p.4) | 7 | 5 | บานเปิด, บานสวิง, บานเลื่อนรางแขวน | Adjustable door casings that wrap the wall end. Wall 100-125 mm uses V.01+V.02, 135-160 V.02+V.03, 125-165 V.01+V.04, 160-200 V.03+V.04, and swing 100-210 V.05+V.05. |
| D (D-SERIE, p.4) | 15 | 12 | บานเปิด, บานสวิง, บานเลื่อนรางแขวน | Aluminium doors, Slim 60 / Strong 100 stiles, 35 mm leaf. Hinges, closers, floor spring, interior sliding. Also ALU-DEC edge trims for wood doors. |
| S (S-SERIE, pp.4, 6) | 12 | 7 | none | Wall skirting 50/100/150/200 and a wiring skirting (SKW). Corners, stop ends and the PVC cover SR are recorded as accessories. |
| B (B-SERIE, p.4) | 7 | 6 | บานเฟี้ยม | Folding doors: track 62 wide, leaf frame 50 x 64. Layouts 1:1 to 6:6 are on pp.7-8. |
| C (C-SERIE, p.4) | 4 | 4 | บานกระทุ้ง, บานเปิด, บานติดตาย | Awning and double casement windows with gear locks. |
| H (H-SERIE, p.4) | 10 | 9 | none (บานยก) | Hung windows: vertical sliding on spring balances, tilt-in. No matching app type. |

**Weights:** none are printed, so **kg_per_m is null on all 92 rows**. A weight table has to come from ALUINCH.

**Bar length:** every profile page except S prints "2.8 m. / 6.4 m." without saying which die comes in which length. `std_length_m` is set to 6.4 for now. S prints no length (null).

**Wall:** 71 of 92 rows have a printed wall thickness.
- Where two values are printed (for example D-60: 3 and 2), `wall_mm` is the main web and the other value is in `note`.
- 21 rows have no wall printed: door stops, small beads, some covers, and the SKF flat strips.

**Assembly / cut rules:**
- The only printed cut angle is **45°** on the V-series casing corners (exploded view, V p.4).
- No other cut angles, cut sizes or glass formulas are printed.
- Section-drawing titles are listed per page under `assembly`.
- H p.6 prints the H.04 notch (5 mm x 28 mm) and the 650 mm spring channel.

**Hardware** (codes in the JSON):
- B: rollers, guides, locks, gear rods BG/100-180, flush bolts, hinges, stop.
- C: CH-01 / CH-02 handles; CT-01 restrictors; CF-01 friction hinges, with a load table of max size, kg and angle; CG gear legs; CF.B flush bolt; RC glass rubber.
- H: HA spring sets (450/800/1000, sold as sets), HH.01-HH.06.

**Colours:** no aluminium finishes are printed. The only colours are on hardware:
- white / gray / black for C handles and the RC rubber;
- white / black for H locks;
- white / gray / black for the S PVC cover SR.

**Doubts:**
- **No grey-part entries.** H.04A (grey insert in H.04) has no caption or size. T-5.04 (grey part drawn in T-5.03) has no entry of its own.
- **Spelling of companion labels.** T-20.09 and T-25.17 show companions labelled "F.20-06" / "F.25-08", which are the F-series dies F-20.06 / F-25.08. SKC.A is also spelled SKC-A.
- **C-series drawings are low-res rasters.** C-01 wall 1.5 or 1.6? C-04 wall 1.3 or 1.5, and height 52.5 or 52.6? Both rows are marked `check`.
- **V-05 use.** The caption says "for sliding door" but the intro says swing doors (V.05+V.05).
- **Missing app types.** H (บานยก) and S (skirting) have no matching app type.
- **Role names are my mapping.** New families: ซอยลูกฟัก, เสามุม, เสางานระบบ, รางไฟ, บังใบ, วงกบทับใน/นอก, ปิดสันบาน, คิ้วสักหลาด, บัวเชิงผนัง, ฝาปิดร่องสกรู, เสากลาง, เสาข้างบานยก, ตัวเสริมซอย.
- **Missing titles.** Two section-drawing titles could not be read from the margin strip: F p.8 and D p.11.
