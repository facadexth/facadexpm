// ผนังกระจกเคอร์เทนวอลล์ rows x cols — mullions (full height) + transoms, pressure plate / cover free lines, and per-cell
// kinds (glass / awning / spandrel, see layoutCells.js). Schema: see layoutRegistry.js.
//   `cells: {...}`   declares per-cell kinds: layoutRegistry.exprParams then adds cells_awning / cells_spandrel
//                    (expression identifiers; the dotted `cells.awning` is not a valid identifier).
//   panel: true      part is an infill panel (no aluminium): contributes layoutCells.panelCells only; costing prices it.
//   familiesWhen     { param: { position: family } } — a truthy param sets line 0's family (unitized set), like namesWhen.
// Awning cell count can exceed partModel.MAX_PART_COUNT (10): pieceCount clamps the sash part count to 10.
const PL = { type: 'width', family: 'NO.9019' }
const CV = { type: 'width', family: 'NO.3112' }
// Excel: (W(R+1) + H(C+1)) (1-k) — one width line and one height line per member.
const W_LINE = '(rows+1)*(1-k)'
const H_LINE = '(cols+1)*(1-k)'
const RAIL = { type: 'width_minus', auto: 'cw_cols', factor: '1/cols', role: 'sash', family: 'บานหน้าต่างยูโร' }

export default {
  kind: 'curtain_wall',
  inputs: [
    { key: 'rows', label: 'จำนวนแถว', type: 'number', min: 1, max: 8, integer: true, default: 3, estimator: true },
    { key: 'cols', label: 'จำนวนช่อง', type: 'number', min: 1, max: 12, integer: true, default: 4, estimator: true },
    { key: 'spandrel', label: 'แผงทึบ (spandrel)', type: 'select', options: [{ value: 'none', label: 'ไม่มี' }, { value: 'top', label: 'แถวบน' }, { value: 'bottom', label: 'แถวล่าง' }], default: 'none', estimator: true },
    { key: 'cells', label: 'ชนิดแต่ละช่อง', type: 'cells', default: {}, estimator: true },
    { key: 'k', label: 'สัดส่วนแผ่นกด/ฝาปิด', type: 'select', options: [{ value: 0.5, label: '0.5' }, { value: 1, label: '1' }, { value: 0, label: '0' }], default: 0.5, estimator: true },
    { key: 'unitized', label: 'ยูนิไทซ์', type: 'boolean', default: false, fixed_by_type: true },
  ],
  cells: { kinds: ['glass', 'awning', 'spandrel'] },
  familiesWhen: { unitized: { mullion: 'Fe-Mullion', transom: 'Int-Tran' } },
  parts: [
    { key: 'frame', name: 'โครงเคอร์เทนวอลล์', count: 1, overlap_mode: 'manual', overlap_mm: 0, corner: 'butt', track: null, fixed: false, glass: false },
    { key: 'awning', name: 'บานกระทุ้ง', count: 'cells_awning', overlap_mode: 'manual', overlap_mm: 0, corner: 'mitre', track: null, fixed: false, glass: false },
    { key: 'spandrel', name: 'แผงทึบ', count: 'cells_spandrel', overlap_mode: 'manual', overlap_mm: 0, corner: 'butt', track: null, fixed: false, glass: false, panel: true },
  ],
  positions: {
    mullion: { part: 'frame', orient: 'v', per: 'cols+1', name: 'เสา mullion', rule: { type: 'height', family: 'NO.9010' } },
    transom: { part: 'frame', orient: 'h', per: '(rows+1)*cols', name: 'ราว transom', rule: { type: 'width_minus', auto: 'cw_cols', factor: '1/cols', family: 'NO.9023' } },
    plate_w: { part: 'frame', orient: 'h', per: 1, name: 'แผ่นกด (แนวนอน)', corner: 'free', rule: { ...PL, factor: W_LINE } },
    plate_h: { part: 'frame', orient: 'v', per: 1, name: 'แผ่นกด (แนวตั้ง)', corner: 'free', rule: { type: 'height', family: 'NO.9019', factor: H_LINE } },
    cover_w: { part: 'frame', orient: 'h', per: 1, name: 'ฝาปิด (แนวนอน)', corner: 'free', rule: { ...CV, factor: W_LINE } },
    cover_h: { part: 'frame', orient: 'v', per: 1, name: 'ฝาปิด (แนวตั้ง)', corner: 'free', rule: { type: 'height', family: 'NO.3112', factor: H_LINE } },
    sash_top: { part: 'awning', orient: 'h', per: 1, name: 'ราวบนบาน (บานพับ)', rule: { ...RAIL } },
    sash_bottom: { part: 'awning', orient: 'h', per: 1, name: 'ราวล่างบาน (มือจับ)', rule: { ...RAIL } },
    sash_side: { part: 'awning', orient: 'v', per: 2, name: 'เสาบาน', labels: ['ซ้าย', 'ขวา'], rule: { type: 'height_minus', auto: 'cw_rows', factor: '1/rows', role: 'sash', family: 'คิ้วยูโร' } },
  },
  joints: [
    { h: 'transom', v: ['mullion', 'mullion'], through: 'v', mode: 'tee' },
    { h: 'sash_top', v: ['sash_side', 'sash_side'], vPiece: 'byEnd', vEnd: 0, mode: 'mitre' },
    { h: 'sash_bottom', v: ['sash_side', 'sash_side'], vPiece: 'byEnd', vEnd: 1, mode: 'mitre' },
  ],
  order: ['mullion', 'transom', 'plate_w', 'plate_h', 'cover_w', 'cover_h', 'sash_top', 'sash_bottom', 'sash_side'],
  hardware: [
    { name: 'แขนค้ำกระทุ้ง', per: 'unit', qty: 'cells_awning*2' },
    { name: 'มือจับ', per: 'unit', qty: 'cells_awning' },
  ],
  symbol: { sash: 'v_hinge', hinge: 'top' },
}
