# MN set manual 1 - sliding MN-4173B / MINI EURO / MN-4075

**Source:** `MN_1. ชุดบานเลื่อน MN-4173B, MINI EURO, MN-4075.pdf` (24 pages, scanned, no text layer). **Data:** `mn01-sliding-4173b-minieuro-4075.json`.

## What it is
This is MN's installation guide (INSTALLATION GUIDE / รูปแบบการติดตั้ง) for three sliding systems. Each layout gets two pages:
- a profile page with the die numbers, the section sizes and the CENZA hardware codes;
- an installation page with an elevation, a vertical section and a horizontal section, with every dimension in mm.

**The guide prints no cut formulas, glass formulas, hardware quantities or prices.** None were transcribed, so the cut formula count is 0. The JSON keeps each printed section dimension (frame depth, track pitch, sightlines, interlock widths) under `clearances_mm`. Those numbers can be used to derive deductions, but the derivation still has to be checked.

## Systems
| System | Pages | App types | Key profiles |
|---|---|---|---|
| MN-4173B (header says "4713B") | 4-9 | บานเลื่อนสวน 2 บาน, 4 บาน คู่กลาง, multipoint lock | U4173B head and jamb 103x31.75, U3002 sill + U4120A under-sill, U4282/U4281/U5779 stiles, U4283A interlock, U3814 rail, U5211/U4050 screen |
| MINI EURO | 10-17 | สวน 2, สวน 2 + ช่องแสงบน, คู่ 4 บาน, คู่ + มุ้ง + ช่องแสง | U4173B, U7866 sill, U6047 sash on 4 sides with CZ-AU01 corners (the mitre is assumed, not printed), U6949 hook, U7111 + U4855 jamb. Transom: M30082 box, U4637 + U4638, 1"x4" tube |
| MN-4075 | 18-19 | 3-track sliding window, 3 panels (for indoor use) | U4075 head and jamb 109.8, M43189 sill, U4459A rails, U4775A/U4457A stile, U6561 interlock |

## Dimensions worth using (all printed)
- **4173B:** frame depth 103; head 31.75. Head zone is 83.75 and sill zone is 90. At the jamb, frame 31.75 + sash sightline 48.3. The interlock is 51.2.
- **MINI EURO:** head zone 83.25 and sill zone 92.5; the jamb measures 88.5.
- **4075:** depth 109.8. Head zone is 84.75 and sill zone is 86.45; the jamb measures 80.75.

## Pages to look at
Pages 5, 7, 9, 11, 13, 15, 17 and 19 hold the sections.

## Open points
- The roles of the lock stile (เสากุญแจ) and the interlock (เสาเกี่ยว) shown in the sections conflict with the names in the profile catalogue.
- Die numbers conflict: U4457A vs U4775A, and 4713B vs 4173B.
- U7866, M43189 and U4775A are not in the 2021 profile catalogue, so their kg/m is null.
