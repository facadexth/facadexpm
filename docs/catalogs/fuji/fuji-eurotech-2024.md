# Fuji Eurotech 2024 (Fuji Metal, bought through KC)

**Source:** `Fuji Eurotech 2024.pdf`, 49 pages. The inside cover says "EURO PROFILE 2022". It has a text layer, but every number sits in the drawings. Data file: `fuji-eurotech-2024.json`.

## Series and the app types they fit
| Series | System | App types | Notes |
|---|---|---|---|
| EcoTECH A-CLASS (p5-8) | 2-track sliding | บานเลื่อนสวน 2 บาน, ประตูบานเลื่อน | economy range, 0.7 mm wall, 8 dies |
| EcoTECH C-CLASS (p9-13) | 2-track sliding | same | same shapes, 1.0-1.2 mm wall; FJH-001..004 rubber parts |
| EUROTECH Sliding (p15-24) | 2- and 3-track euro sliding | 2/3/4-panel, centre opening, corner, recessed sill | frame 101.6 / 63.6, wall 1.5, glass 5-20 |
| EUROTECH Awning/Casement/Fixed (p25-36) | 101.6 frame | บานกระทุ้ง, บานเปิด(คู่), บานติดตาย, ช่องแสง | glass 5-33 |
| EUROTECH Bi-fold (p37-47) | folding | ประตูบานเฟี้ยม (2-10 leaves, corner) | height up to 4 m |

Page 1 is a poster with every EUROTECH profile and its kg/m. It also lists B/C variants, about 18 of which appear only on the poster (marked "estimated", tiny print), plus glass-adaptor pocket tables.

## Assembly rules, as drawn (no cut formulas are printed)
- On every series the sash is mitred at 45° with a spigot and corner bracket. The outer frame is butted at 90°.
- **Sliding:** the head uses the same die as the sill (F7976 for 3-track, F7977 for 2-track) with an F7988 cover. The section stack is head 21 + 13 gap, sash rail 78 (door) or 66 (window), and below it 8.5 + 19 + 21. Jamb 21 + 7 gap to the sash. A printed note on p24 says that when the jamb die is used as the head, keep a 19 mm sash-to-sill clearance.
- **Awning:** 19 mm from the frame edge to the sash edge on all sides. The sash face is 80, it overlaps the frame by 6, and the glass bite is 13. On a double sash with a mullion, 13 of the mullion stays visible. A double casement leaves a 5 mm gap at the F7945 centre post.
- **Bi-fold:** jamb 18 + 9.5 gap, 8 mm hinge gap, 6 mm head gap. Each meeting-joint type (odd/odd, even/odd, even/even) uses its own die.
- The "formulas" in the JSON are derived from these dimension strings and are marked [estimated].

## Pages to look at
p1 (poster with kg/m), p21-24 (sliding sections), p33-36 (awning sections), p45-47 (bi-fold sections).

## Conflicts and gaps
- p7 prints "F7381" as the die number for both sills. The KC catalogue gives F7399 (window) and F7400 (door).
- F7935 is listed twice with different weights (p31: 0.276, p40: 0.285).
- The poster gives B variants different kg/m from the inner pages.
- There are no prices and no hardware part numbers, apart from FJH-001..004.
