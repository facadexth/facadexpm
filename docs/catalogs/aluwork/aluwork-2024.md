# Thai Aluwork: aluframe Light Product Catalog (ALUWORK.pdf)

**What it is:** a 28-page catalogue from Thai Aluwork Co., Ltd. (บริษัท ไทยอลูเวิร์ค จำกัด, Samut Sakhon), brand "aluframe Light". No year is printed; the cover carries the มอก. 284-2564 badge. PDF page = printed page + 3.

Each profile table row prints:
- one drawing;
- 1 to 4 thickness variants, each with its own code (base die + 2-digit wall, e.g. 5071 + 08 = **507108** at 0.8 mm);
- bars per bundle and bar length (6.40, 6.10 or 6.00 m);
- weight **per bar** as a low-high range, one for Anodize and one for Powder Coat.

There are no prices, cut formulas, glass formulas or hardware lists. Data file: `aluwork-2024.json`, with **247 rows, one per thickness code**. Every row has a weight (kg/m = Anodize midpoint ÷ bar length), and 246 of the 247 have a wall thickness. Pictures are in `DOC/ALUMNIUM CATALOG/_extracted/aluwork-sections/` (247 PNGs plus manifest.json).

| Series (PDF pages) | Rows | App types |
|---|---|---|
| Sliding windows & doors, frames 95.0 / 71.5 (3") / 101.6 with box (tables pp.6-8, assemblies pp.4-5) | 81 | บานเลื่อนสวน 2 บาน, บานเลื่อน 2 ตาย 2, บานติดตาย |
| Awning / casement windows, Union set + light set (tables pp.10-11, assembly p.9) | 31 | บานกระทุ้ง, บานเปิด, บานติดตาย |
| Swing doors and fixed lights, 4" boxes (tables pp.21-23, shopfront assemblies pp.12-20) | 78 | บานสวิง, บานติดตาย |
| Fixed lights, 3" (p.24) | 16 | บานติดตาย |
| Hinged doors (p.25) | 9 | บานเปิด |
| Boxes / ระแนง tubes (p.26) | 13 | none |
| Others: U and Z sections, ลูกฟูก panels (p.27) | 19 | none |

**Assembly rules:**
- Every assembly drawing says "FRAME 90° CUT". Frames are butt-jointed, not mitred.
- Dies on the assembly drawings are the 4-5 digit base numbers, for example sash 5081 / 5082 / 5076 / 5077 / 5078 and fixed-panel post 5083.

**Colours:**
- Anodize: Na-1, Na-Clear, Satin, Bronze, Black.
- Powder coat: Frost white, Off white, Coconut white, Champagne, Nobel grey, Urban grey, Flint grey, Autumn brown, Phantom black, Super black.
- aluwood film: Tassie Oak, French Oak, Teak Brown, Teak Dark Brown.

**Doubts:**
- **Duplicate codes in the catalogue.** 14 rows reuse a code from another row, so they got a `-p<page>n<row>` suffix:
  - ชนกลางมุ้ง reuses the เฟรมล่าง codes.
  - คิ้วลอยเท (หัวมน) reuses the ขวางบน / ขวางล่าง codes. The assembly drawings call these beads 5068 / 5069.
  - ตบเรียบ 3" and ตบร่อง 3" share codes.
- **Copied weights.** The two small คิ้วลอยเทเล็ก rows have exactly the ขวางล่าง weights, so their kg/m is wrong.
- **Likely typos:** 507112 (probably 507812), 13053110 (probably 1305310), and the 707415 / 707417 thickness suffixes.
- **Odd weights:** 1314008, 607512, 607612, 607707 and 607710.
- **Unknown job:** p.11 ประตู/หน้าต่าง มีริม / ไม่มีริม and ซีกลางใหญ่. The role is not known.
- **No weight:** 11496 and 11542 appear only on the assembly drawings.
- **No wall:** 16316 has no wall thickness printed.
- **Weight choice:** kg/m uses the Anodize midpoint. Confirm with the owner.
- The role names are my mapping.
