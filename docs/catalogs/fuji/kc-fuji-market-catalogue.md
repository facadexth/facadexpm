# KC Fuji market catalogue (Fuji Metal "Aluminium Profiles", ตัวตลาด)

**Source:** `KC ฟูจิแคตตาลอกตัวตลาด.pdf`, 36 pages, scanned with no text layer. Every page was read from the JPEGs. Data file: `kc-fuji-market-catalogue.json`. Fuji Metal makes these profiles and KC is the supplier the company buys them from.

## The key point: weights are mostly per bar, not per metre
Most tables give **kg per bar** (one 6.0, 6.1 or 6.4 m length) as a range. The range is split by finish (anodised ผิวชุบ or painted ผิวพ่นสี) and by wall thickness (0.80, 1.00 or 1.20 mm). These ranges go into `kg_per_bar` and `kg_per_m` is left null. True kg/m is printed only for:
- EcoTech A/C-CLASS
- F7874, F7875, F7876, F7877, F7878
- F203, F7276
- the flat bars (เส้นแบน) and the curved flat bars (เส้นแบนท้องปลิง)

## Series and the app types they fit
| Series | Pages | App types |
|---|---|---|
| EcoTech A-CLASS (0.7) | 4-5 | 2-panel sliding. This table resolves the PDF 10 sill misprint: F7399 window, F7400 door, F7398 threshold cover |
| EcoTech C-CLASS (1.0-1.2) | 6-7 | 2-panel sliding |
| ชุดบานเลื่อน F7010-F7023, F7150-52 เสริมกล่อง | 8-10 | standard 4" sliding window with screen, glazing-bar strips F2031/F2032 |
| ชุดบานสวิง / shopfront F9030-F9077 | 11-16 | 4" box fixed glazing, swing door, top-hung sliding door (F9077 track) |
| ชุดบานกระทุ้ง ยูเนี่ยน F3100-F3102, F7877/78 | 17-19 | awning/casement, mullion and transom, corner cleats F169/F170/F172 |
| Standard profiles | 20-30, 33 | corrugated sheet, polycarbonate frame, plywood, louvres, box sections, angles, fall-guard angles, U channels, tubes, flat bars, misc |
| ชุดตู้กับข้าว | 31-32 | kitchen cabinet profiles (not windows) |

The sections on pages 4-18 show which die goes where. They print no dimensions, no cut formulas and no prices.

## Gaps
- F771 is listed at 7.867 kg/m, which looks wrong.
- F0859 is printed as "0.12-.015".
- F170 is paired with a thinner wall but a heavier weight than F169.
- Pages 34-35 are มอก. licences and page 36 is the back cover.
