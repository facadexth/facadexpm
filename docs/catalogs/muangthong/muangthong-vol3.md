# Muangthong Aluminium: Profile Catalogue Vol.3 (แคตตาล็อคเมืองทอง.pdf)

**What it is:** a 280-page scanned die catalogue from Muangthong Aluminium Industry Co., Ltd. Every section is drawn with its overall size, wall thickness and **weight in kg/m**. There are no prices, no standard bar lengths, no hardware, and **no cut or glass formulas anywhere**. PDF page = printed page + 5. Data file: `muangthong-vol3.json` (733 profile rows, every one with a printed kg/m).

| Group (PDF pages) | Series | App types it serves |
|---|---|---|
| 01 Shopfront & doors (8-86) | Box system 3"x1.5" / 4"x1" / 4"x1.75" / 4"x2" / 4"x4" / 5" / 6": grooved box (กล่องร่อง), plain box (กล่องเรียบ), stepped box (กล่องเปิด), snap covers (ฝาตบร่อง/ฝาปิด), beads, thresholds and corner posts. The tables on pp.8-15 list every wall thickness (suffix A/B/C/F/G). | Fixed lights, shopfront |
| | Swing door stile 54x46 + rails 44x51 / 44x80, in wall sets 1.5 / 1.7 / 2.0 / 2.2 / 2.3 / 2.5. There are also heavy versions 76-150 wide and rebated door frames 3097 / 3174. | Swing doors, door with transom light |
| 02 Sliding (90-165) | 4000 (frame 95, the core range, walls 0.9-2.0), 4004 (frame 71.5), 4080 (frame 70.6), 4097 (frame 103), 4141 / 4158 / 4873 (frame 101.6), 40301 and 40120 sliding doors, box-frame sliding, 3-track 105.5 inside a 3729 box, TR and HR reinforced interlocks | 2-panel slider, 4-panel F-S-S-F, 3-track, sliding door |
| 02 Wind tables (167-172) | Maximum wind pressure (kg/m²) by W x H for the TR and HR series | (for engineering checks) |
| 03 Casement / awning (176-199) | 5000, 5398, 5451, 5200, 5036 casements; 5203, 5207, 50193 and 51057 awnings | Casement windows, awning windows |
| 04 Curtain wall (202-225) | Mullions 44.45-101.6 wide, transoms, pressure plates, caps, vent frames | Curtain wall |
| 05 / 06 / 07 (228-250) | Sunshade louvres and carriers, spandrel planks, fly-screen frames (2006 is used with every slider) | Sunshade, spandrel, fly screen |
| TD (253-279) | AA tolerance tables, coating specs, anodised finishes E&A / MT512 / MT514 / MT517 / MT519 | finishes |

**How the members fit together (from the assembly drawings only; no numbers are given):**
- **4000 slider (p.96):**
  - Frame: head 4001F, sill 4002F, jambs 4003F.
  - Sashes: top rail 4014F, bottom rail 4015F, mid rail 4018.
  - Stiles: 4013F at the jamb on the fixed panels, a 4012F pair as interlocks, and 4011F+4011F with a 4016 cap at a bi-parting centre (40795/40796 is the alternative).
  - Screen: 2006 runs on the outer track behind cover 4010F.
- **Other sliders:** every slider page follows the same pattern of head / sill / jamb frames, top and bottom rails, a jamb stile, an interlock and a meeting cap. The parts are listed under `assembly[].joints` in the JSON.
- **Doors:** the stiles run full height and the rails butt between them. This is only inferred from the elevations; no joint type is printed.

**Pages a human should check:**
- 8-15: thickness tables.
- 96, 110, 117, 120, 123, 137, 148, 152-154, 159, 163: sliding assemblies.
- 167-172: wind tables.
- 176-198: casement assemblies.
- 279: finishes.

**Could not read or not present:**
- All pages were readable.
- Two weights are printed differently on two pages each: 3809 (0.384 vs 0.387) and 5121 (0.195 vs 0.190).
- Die 41567 appears on the HR assembly drawing, but it has no section page.
- The role names are my mapping. Shapes I could not place are filed under `อื่นๆ`.
