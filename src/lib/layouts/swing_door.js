// ประตูบานสวิง 1–2 บาน — วงกบ (หัว + ข้าง + ธรณีถ้ามี) + บานสวิง (เสา 2 + ราวบน/ล่าง). Butt-jointed (D15): stiles run through,
// rails butt into them. Schema: see layoutRegistry.js.
// `sill` (input) = yes/no; position `sill` has enabled: 'sill', so it is absent from the model while the input is 'no'.
// Stile height auto 'frame_top_bottom' = b(frame_top) + b(frame_bottom); roles.frame_bottom maps to `sill`, and an absent
// sill adds 0 (R-P3), so a sill-less door's stile deducts the head only.
export default {
  kind: 'swing_door',
  inputs: [
    { key: 'leaves', label: 'จำนวนบาน', type: 'number', min: 1, max: 2, integer: true, default: 1, estimator: true, fixed_by_type: true },
    { key: 'hinge', label: 'บานพับด้าน', type: 'select', options: [{ value: 'left', label: 'ซ้าย' }, { value: 'right', label: 'ขวา' }], default: 'left', only_when: { leaves: 1 }, estimator: true },
    { key: 'open', label: 'เปิด', type: 'select', options: [{ value: 'out', label: 'เปิดออก' }, { value: 'in', label: 'เปิดเข้า' }], default: 'out', estimator: true },
    { key: 'sill', label: 'ธรณี', type: 'select', options: [{ value: 'yes', label: 'มีธรณี' }, { value: 'no', label: 'ไม่มีธรณี' }], default: 'yes', estimator: true },
    { key: 'pivot', label: 'เดือยบน/ล่าง (โช้คฝังวงกบ)', type: 'boolean', default: false, fixed_by_type: true },
  ],
  roles: { frame_bottom: 'sill' },
  parts: [
    { key: 'frame', name: 'วงกบ', count: 1, overlap_mode: 'manual', overlap_mm: 0, corner: 'butt', track: null, fixed: false, glass: false },
    { key: 'leaf', name: 'บานสวิง', count: 'leaves', overlap_mode: 'manual', overlap_mm: 0, corner: 'butt', track: null, fixed: false, glass: false },
  ],
  positions: {
    frame_top: { part: 'frame', orient: 'h', per: 1, name: 'เฟรมบน', rule: { type: 'width', family: 'กล่องแจ็คสัน' } },
    sill: { part: 'frame', orient: 'h', per: 1, name: 'ธรณี (วงกบล่าง)', enabled: 'sill', rule: { type: 'width', family: 'ธรณีสวิง' } },
    frame_side: { part: 'frame', orient: 'v', per: 2, name: 'เฟรมข้าง', labels: ['ซ้าย', 'ขวา'], rule: { type: 'height', family: 'กล่องแจ็คสัน' } },
    leaf_stile_hinge: { part: 'leaf', orient: 'v', per: 1, name: 'เสาบานพับ', rule: { type: 'height_minus', auto: 'frame_top_bottom', role: 'sash', family: 'เสาประตูสวิง' } },
    leaf_stile_handle: { part: 'leaf', orient: 'v', per: 1, name: 'เสามือจับ', rule: { type: 'height_minus', auto: 'frame_top_bottom', role: 'sash', family: 'เสาประตูสวิง' } },
    leaf_rail_top: { part: 'leaf', orient: 'h', per: 1, name: 'ราวบนบาน', rule: { type: 'width_minus', auto: 'frame_sides', factor: '1/leaves', role: 'sash', family: 'เสาบนสวิง' } },
    leaf_rail_bottom: { part: 'leaf', orient: 'h', per: 1, name: 'ราวล่างบาน', rule: { type: 'width_minus', auto: 'frame_sides', factor: '1/leaves', role: 'sash', family: 'เสาล่างสวิง' } },
    // คิ้วประตู (glazing beads, spec §5.7 / Excel sheet 6): free lines ×4 per leaf — 2 along the stiles, 2 along the rails
    leaf_bead_v: { part: 'leaf', orient: 'v', per: 2, name: 'คิ้วประตู (ตั้ง)', corner: 'free', rule: { type: 'height_minus', auto: 'frame_top_bottom', role: 'sash', family: 'คิ้วประตู' } },
    leaf_bead_h: { part: 'leaf', orient: 'h', per: 2, name: 'คิ้วประตู (นอน)', corner: 'free', rule: { type: 'width_minus', auto: 'frame_sides', factor: '1/leaves', role: 'sash', family: 'คิ้วประตู' } },
  },
  joints: [
    { h: 'frame_top', v: ['frame_side', 'frame_side'], vPiece: 'byEnd', vEnd: 0, through: 'v', mode: 'butt' },
    { h: 'sill', v: ['frame_side', 'frame_side'], vPiece: 'byEnd', vEnd: 1, through: 'v', mode: 'butt' },
    { h: 'leaf_rail_top', v: ['leaf_stile_hinge', 'leaf_stile_handle'], vPiece: 'same', vEnd: 0, through: 'v', mode: 'butt' },
    { h: 'leaf_rail_bottom', v: ['leaf_stile_hinge', 'leaf_stile_handle'], vPiece: 'same', vEnd: 1, through: 'v', mode: 'butt' },
  ],
  order: ['frame_top', 'sill', 'frame_side', 'leaf_stile_hinge', 'leaf_stile_handle', 'leaf_rail_top', 'leaf_rail_bottom', 'leaf_bead_v', 'leaf_bead_h'],
  // two alternative sets selected by the boolean input `pivot` (1/0 in expressions)
  hardware: [
    { name: 'บานพับ', per: 'sash', qty: '(1-pivot)*3' },
    { name: 'door closer ฝังวงกบบน', per: 'sash', qty: 'pivot*1' },
    { name: 'เดือยบน/ล่าง', per: 'sash', qty: 'pivot*2' },
    { name: 'มือจับ', per: 'sash', qty: 1 },
  ],
  symbol: { leaf: 'v_hinge', hinge: 'alternate' },   // single: the `hinge` input; double: outer stiles. `open` picks dashed/solid per view
}
