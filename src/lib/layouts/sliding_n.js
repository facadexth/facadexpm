// หน้าต่าง/ประตูบานเลื่อน n บาน (n = 2–6) — sliding_2 generalised. With n = 2 it reproduces sliding_2's per-family totals.
// Rails: (W − frame sides + (n−1) overlaps) / n. Stiles (spec §5.4, R-F1): the two OUTER stiles are เสากุญแจ, every
// inner stile is เสาเกี่ยว, so the sashes are three parts — บานซ้าย (count 1: key at the frame + hook), บานกลาง
// (count n−2: hook + hook) and บานขวา (count 1: hook + key at the frame) — giving 2 key + 2(n−1) hook stiles.
// `sequence` orders the three parts left to right (tracks alternate along it, the drawing and the slide arrows follow it).
// The middle / right sashes' positions take the left sash's family by default (rule.familyFrom) until the owner picks one.
const RAIL = { type: 'width_minus', auto: 'frame_sides', factor: '1/n', overlap: 'hook', overlapCount: 'n-1', role: 'sash' }
const STILE = { type: 'height_minus', auto: 'frame_top_bottom', role: 'sash' }
const SASH = { overlap_mode: 'auto_hook', overlap_mm: 0, corner: 'butt', track: 'alternate', fixed: false, glass: false }

const pos = (part, orient, name, rule, from) => ({ part, orient, per: 1, name, rule: { ...rule, ...(from ? { familyFrom: from } : {}) } })
const railJoints = (top, bottom, left, right) => [
  { h: top, v: [left, right], vPiece: 'same', vEnd: 0, through: 'v', mode: 'butt' },
  { h: bottom, v: [left, right], vPiece: 'same', vEnd: 1, through: 'v', mode: 'butt' },
]

export default {
  kind: 'sliding_n',
  inputs: [
    { key: 'n', label: 'จำนวนบาน', type: 'number', min: 2, max: 6, integer: true, default: 2, estimator: true },
    { key: 'door', label: 'ประตู (ราง/ธรณี)', type: 'boolean', default: false, fixed_by_type: true },
  ],
  namesWhen: { door: { frame_bottom: 'รางล่าง (ธรณี)', frame_top: 'รางบน' } },
  roles: { hook: 'left_hook_stile' },
  sequence: ['sash_left', 'sash_mid', 'sash_right'],
  parts: [
    { key: 'frame', name: 'วงกบ', count: 1, overlap_mode: 'manual', overlap_mm: 0, corner: 'butt', track: null, fixed: false, glass: false },
    { key: 'sash_left', name: 'บานซ้าย', count: 1, ...SASH },
    { key: 'sash_mid', name: 'บานกลาง', count: 'n-2', ...SASH },
    { key: 'sash_right', name: 'บานขวา', count: 1, ...SASH },
  ],
  positions: {
    frame_top: { part: 'frame', orient: 'h', per: 1, name: 'เฟรมบน', rule: { type: 'width' } },
    frame_bottom: { part: 'frame', orient: 'h', per: 1, name: 'เฟรมล่าง', rule: { type: 'width' } },
    frame_side: { part: 'frame', orient: 'v', per: 2, name: 'เฟรมข้าง', labels: ['ซ้าย', 'ขวา'], rule: { type: 'height' } },
    left_top: pos('sash_left', 'h', 'บานเลื่อนบน (บานซ้าย)', RAIL),
    left_bottom: pos('sash_left', 'h', 'บานเลื่อนล่าง (บานซ้าย)', RAIL),
    left_key_stile: pos('sash_left', 'v', 'เสากุญแจ (บานซ้าย)', STILE),
    left_hook_stile: pos('sash_left', 'v', 'เสาเกี่ยว (บานซ้าย)', STILE),
    mid_top: pos('sash_mid', 'h', 'บานเลื่อนบน (บานกลาง)', RAIL, 'left_top'),
    mid_bottom: pos('sash_mid', 'h', 'บานเลื่อนล่าง (บานกลาง)', RAIL, 'left_bottom'),
    mid_hook_a: pos('sash_mid', 'v', 'เสาเกี่ยวซ้าย (บานกลาง)', STILE, 'left_hook_stile'),
    mid_hook_b: pos('sash_mid', 'v', 'เสาเกี่ยวขวา (บานกลาง)', STILE, 'left_hook_stile'),
    right_top: pos('sash_right', 'h', 'บานเลื่อนบน (บานขวา)', RAIL, 'left_top'),
    right_bottom: pos('sash_right', 'h', 'บานเลื่อนล่าง (บานขวา)', RAIL, 'left_bottom'),
    right_hook_stile: pos('sash_right', 'v', 'เสาเกี่ยว (บานขวา)', STILE, 'left_hook_stile'),
    right_key_stile: pos('sash_right', 'v', 'เสากุญแจ (บานขวา)', STILE, 'left_key_stile'),
  },
  // rail joint v = [left stile, right stile] as drawn left to right
  joints: [
    { h: 'frame_top', v: ['frame_side', 'frame_side'], vPiece: 'byEnd', vEnd: 0, through: 'v', mode: 'butt' },
    { h: 'frame_bottom', v: ['frame_side', 'frame_side'], vPiece: 'byEnd', vEnd: 1, through: 'v', mode: 'butt' },
    ...railJoints('left_top', 'left_bottom', 'left_key_stile', 'left_hook_stile'),
    ...railJoints('mid_top', 'mid_bottom', 'mid_hook_a', 'mid_hook_b'),
    ...railJoints('right_top', 'right_bottom', 'right_hook_stile', 'right_key_stile'),
  ],
  order: [
    'frame_top', 'frame_bottom', 'frame_side',
    'left_top', 'left_bottom', 'left_key_stile', 'left_hook_stile',
    'mid_top', 'mid_bottom', 'mid_hook_a', 'mid_hook_b',
    'right_top', 'right_bottom', 'right_hook_stile', 'right_key_stile',
  ],
  hardware: [{ name: 'ลูกล้อ', per: 'sash', qty: 2 }, { name: 'กุญแจ/มือจับ', per: 'unit', qty: 1 }],
  symbol: { sash_left: 'slide', sash_mid: 'slide', sash_right: 'slide', direction: 'halves' },   // left half slides →, right half ←
}
