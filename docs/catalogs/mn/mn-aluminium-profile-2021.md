# MN Metal Supply - Aluminum Extrusions Vol. 8 (2021)

**Source:** `MN Aluminium Profile.pdf` (260 pages, has a text layer). **Supplier:** บริษัท แม่น้ำเมทอลซัพพลาย จำกัด (Mae Num Metal Supply, "MNG maenum group"), Rama 3 Soi 52, Bangkok.
**Data file:** `mn-aluminium-profile-2021.json`. It holds 42 series and 1,218 profiles. 974 of the profiles have a die number, and 244 are Group 01 standard tubes/angles with no die number. Every kg/m value was read from the page image and checked against the text layer.
**Page numbers:** the printed catalogue page equals the PDF page minus 5. The JSON uses PDF pages.

## What it is
This is a **profile section catalogue only**. Each page shows section drawings with the die number, wall thickness and kg/m. Many families come in 3-5 wall thicknesses, and each thickness has its own die number.
**It has no assembly drawings, cut formulas, glass formulas, prices, finishes or hardware.** The only "assembly" information is the partner profiles drawn dashed next to a section, for example a sill cover clipped on a sill or a bead in a frame. A die index sits on PDF pages 252-258.

## Series and the app types they serve
| Series (PDF pages) | App types |
|---|---|
| Shopfront box 4" 101.6x44.45: plain / grooved 12.7-30 / stepped box + covers (17-24, 49-50) | บานติดตาย, ช่องแสง, frame boxes |
| 4"x2", 4"x1", 101.6x20, 3" 76.2x38.1, 5"/6" boxes; SF20 (25-44) | บานติดตาย |
| Glazing beads คิ้ว (51-54) | all glazed types |
| Swing door: stile 54x46, top rail 44x51, bottom rail 44x80, frames, thresholds, door stop U2256/M3185 (55-80) | บานสวิงเดี่ยว/คู่ |
| Frameless door shoes (85), automatic door covers (86) | บานสวิงเปลือย |
| Hanging rail (82-84) | บานเลื่อนรางแขวน |
| Folding door (87-90) | บานเฟี้ยม |
| **Sliding 95 mm** (head M4001 / jamb M4003 / sill M4002 + cover M4010; lock stile M4011, interlock M4012, top rail M4013, bottom rail M4014; 9.5 glass slot) (93-101) | บานเลื่อนสวน 2 บาน, 2 ตาย 2 |
| Sliding 71.5 / 1-track 36.35 (91-92), 105.5 (109-111) | บานเลื่อน |
| Box-frame 4" sliding with rails in the box (M4870, M4869, M4871, M457x; U39xx) (102-108) | บานเลื่อน in a 4" box frame |
| Sliding door 103 (U3002 / U4454A / U4455A frames; sashes 67 / 60.15 / 51.2, 9.5 or 12 slot) (112-119) | ประตูบานเลื่อน |
| 3-track 109.8 (120-123); Big-frame 101.6 / 130 / 151.9 + 38 mm sashes (124-132); Euro (133-134) | ประตูบานเลื่อน |
| Awning 36.63 (frame U1883, sash U4438/U1881, bead U3441) (141-142) | บานกระทุ้ง 1-2 ชั้น |
| Awning with a 4" frame box (143-147, 151); 36.5/48.5 (140, 145-146); 56.3 (148); 3" (149) | บานกระทุ้ง |
| Casement 4" U42xx-U43xx (frame 101.6x44.45, sash 39.85, beads U4301/U4296) (152-157); pivot (158) | บานเปิด, บานเปิดข้าง |
| Curtain wall stick 44.45 / 50.8 / 63.5 mullions, caps, pressure plates, sleeves (159-191) | ผนังกระจก |
| Fly screens (81, 135-137), lifting window (138-139), louvre (192-220), spandrel (221-227), cladding/roof/T-ceiling/handrail/misc (228-251) | other |

## Assembly / cut rules
**None are printed.** The drawings only show which parts go together:
- Sliding sills take a sill cover: M4002 + M4010, M4835 + M4033, M40053 + M4872, U3002 + U3015 + U4120A.
- The stepped box (กล่องเปิด) is closed by its small cover.
- Door frames take the stop U2256 or M3185.
- Awning and casement frames and sashes take their bead.

Cut lengths, clearances and overlaps still have to come from the shop's own rules.

## Pages a human should check
- **26:** U2980 is printed at 1.541 kg/m, which looks like a misprint.
- **87:** the folding-door frame roles are my guess.
- **6-8 and 192:** the scan has blue pen marks on the rows for 2"x1" x1.5, 4"x1-3/4" x1.2 and 4"x2" x1.5, and on LS20005 and LS20006.
- **Index pages 252-258:** U4218, U4347 and U5732 are listed but have no drawing.

## Match with the app's provisional series
- **ชุด 4" ใหม่ and ชุด 3":** no MN die matches their thickness and kg/m, so they are probably from another supplier.
- **Big Frame:** 2.0 mm at 1.309 kg/m matches M4056, and 2.0 mm at 1.371 kg/m matches M4058. The names may be swapped (see the open questions).

## Unreadable
None. Every page rendered clearly.
