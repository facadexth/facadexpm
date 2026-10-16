# SMS001 Retail 5 (Schimmer Metal Standard) — 124 pages

**What it is:** SMS retail/general profile book. It covers Thai-market generic dies, S-numbers only.
- Pages 22–75: window and door profiles:
  - SHOPFRONTS & DOORS บานสวิง
  - SLIDING บานเลื่อน (S161xx 4", S16480 เสริมกล่อง, S28xxx, S46xxx, S08xxx, S206xx)
  - CASEMENT บานกระทุ้ง (S232xx, S235xx, ยูเนี่ยน S231xx)
  - SUNSHADE ระแนง
  - CURTAINWALL (S245xx, S10240…)
  - the same dies repeated in powder-coat (อบขาว/อบดำ) and golden-teak finishes
- Pages 76–118: standard sections. Square/rect tube, angles, flat bar, U-channel, round tube and round bar, each with dimensions and kg/m.

File: `sms001-retail-5.json`.

**Extracted:**
- **1,402 kg/m values**: 300 from profile tables, plus 1,102 standard sections.
- **443 weights printed as "kg/piece" ranges** (e.g. S16100 1.20 mm = 3.50–3.80 kg/pcs). These have no length stated, so they are stored as `kg_per_piece_range` with `kg_per_m: null`.
- Wall thickness comes from the column header.
- Some cells carry a different die for that thickness (e.g. S23981 at 2.0 mm vs S53521 at 1.5 mm). These are stored with the die printed in the cell.

**Assembly:** pages 33–35 (sliding door/window), 45–46 (casement), 50 (louvre) and 55 (curtain wall) are typical elevations with die call-outs. **No cut formulas.** Hardware page 12 has bi-fold hardware photos only.

**Check by hand:**
- OCR of the kg/pcs ranges on pages 22–75. Column alignment is OCR-based.
- Page 27 has two "1.50 mm" columns.
- Powder-coat and golden-teak pages 61–75 repeat the same dies at slightly different weights.
