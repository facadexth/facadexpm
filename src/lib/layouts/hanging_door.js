// ประตูรางแขวน 1–2 บาน — รางแขวน (rail + cover, factor 2 each, free corners: open question 3 of the spec stays at the default 2),
// วงกบข้าง (height less the track rail, once: rule.auto 'track') and butt-jointed leaves. Schema: see layoutRegistry.js.
export default {
  kind: 'hanging_door',
  inputs: [
    { key: 'leaves', label: 'จำนวนบาน', type: 'number', min: 1, max: 2, integer: true, default: 1, estimator: true, fixed_by_type: true },
  ],
  parts: [
    { key: 'track', name: 'รางแขวน', count: 1, overlap_mode: 'manual', overlap_mm: 0, corner: 'free', track: null, fixed: false, glass: false },
    { key: 'frame', name: 'วงกบ', count: 1, overlap_mode: 'manual', overlap_mm: 0, corner: 'butt', track: null, fixed: false, glass: false },
    { key: 'leaf', name: 'บานแขวน', count: 'leaves', overlap_mode: 'manual', overlap_mm: 0, corner: 'butt', track: null, fixed: false, glass: false },
  ],
  positions: {
    track_rail: { part: 'track', orient: 'h', per: 1, name: 'รางแขวนใหญ่', corner: 'free', rule: { type: 'width', factor: 2, family: 'รางแขวนใหญ่' } },
    track_cover: { part: 'track', orient: 'h', per: 1, name: 'กล่อง 1-3/4', corner: 'free', rule: { type: 'width', factor: 2, family: 'กล่อง 1-3/4' } },
    frame_side: { part: 'frame', orient: 'v', per: 2, name: 'เฟรมข้าง', labels: ['ซ้าย', 'ขวา'], rule: { type: 'height_minus', auto: 'track', family: 'กล่องแจ็คสัน' } },
    // leaf stiles hang from the same track, so they take the same height as the frame sides
    leaf_stile_a: { part: 'leaf', orient: 'v', per: 1, name: 'เสาประตูแขวน (ซ้าย)', rule: { type: 'height_minus', auto: 'track', role: 'leaf', family: 'เสาประตูสวิง' } },
    leaf_stile_b: { part: 'leaf', orient: 'v', per: 1, name: 'เสาประตูแขวน (ขวา)', rule: { type: 'height_minus', auto: 'track', role: 'leaf', family: 'เสาประตูสวิง' } },
    leaf_rail_top: { part: 'leaf', orient: 'h', per: 1, name: 'ราวบนบาน', rule: { type: 'width_minus', auto: 'frame_sides', factor: '1/leaves', role: 'leaf', family: 'เสาบนสวิง' } },
    leaf_rail_bottom: { part: 'leaf', orient: 'h', per: 1, name: 'ราวล่างบาน', rule: { type: 'width_minus', auto: 'frame_sides', factor: '1/leaves', role: 'leaf', family: 'เสาล่างสวิง' } },
  },
  joints: [
    { h: 'leaf_rail_top', v: ['leaf_stile_a', 'leaf_stile_b'], vPiece: 'same', vEnd: 0, through: 'v', mode: 'butt' },
    { h: 'leaf_rail_bottom', v: ['leaf_stile_a', 'leaf_stile_b'], vPiece: 'same', vEnd: 1, through: 'v', mode: 'butt' },
  ],
  order: ['track_rail', 'track_cover', 'frame_side', 'leaf_stile_a', 'leaf_stile_b', 'leaf_rail_top', 'leaf_rail_bottom'],
  hardware: [{ name: 'ลูกล้อรางแขวน', per: 'sash', qty: 2 }, { name: 'ไกด์พื้น', per: 'unit', qty: 1 }],
  symbol: { leaf: 'slide', direction: 'halves' },   // single: toward the open side; double: outward from the middle
}
