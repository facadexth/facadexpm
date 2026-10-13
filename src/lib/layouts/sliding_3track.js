// บานเลื่อน 3 ราง — 3 sashes on 3 tracks (spec §5.5, R-F1): บานฟิก (fixed, back track 3: เสากุญแจ at the frame + เสาเกี่ยว),
// บานกลาง (track 2: เสาเกี่ยว + เสาเกี่ยว), บานหน้า (front track 1: เสาเกี่ยว + เสากุญแจ at the frame) → 2 key + 4 hook stiles.
// Rails use the same formula as sliding_n with n = 3. `sequence` lists the parts left to right for the fixed-LEFT
// arrangement; mirrorWhen fixed_side 'right' reverses the whole row (sequenceOf), so the fixed sash stands on the right.
// The middle / front sashes' positions take the fixed sash's family by default (rule.familyFrom).
import sliding_n from './sliding_n.js'

const RAIL = { type: 'width_minus', auto: 'frame_sides', factor: '1/3', overlap: 'hook', overlapCount: 2, role: 'sash' }
const STILE = { type: 'height_minus', auto: 'frame_top_bottom', role: 'sash' }
const SASH = { count: 1, overlap_mode: 'auto_hook', overlap_mm: 0, corner: 'butt', glass: false }
const p = sliding_n.positions

const pos = (part, orient, name, rule, from) => ({ part, orient, per: 1, name, rule: { ...rule, ...(from ? { familyFrom: from } : {}) } })
const railJoints = (top, bottom, left, right) => [
  { h: top, v: [left, right], vPiece: 'same', vEnd: 0, through: 'v', mode: 'butt' },
  { h: bottom, v: [left, right], vPiece: 'same', vEnd: 1, through: 'v', mode: 'butt' },
]

export default {
  kind: 'sliding_3track',
  inputs: [
    { key: 'fixed_side', label: 'บานติดตาย', type: 'select', options: [{ value: 'left', label: 'ซ้าย' }, { value: 'right', label: 'ขวา' }], default: 'left', estimator: true },
  ],
  mirrorWhen: { fixed_side: 'right' },
  roles: { hook: 'fixed_hook_stile' },
  sequence: ['sash_fixed', 'sash_middle', 'sash_front'],
  parts: [
    sliding_n.parts[0],
    { key: 'sash_fixed', name: 'บานฟิก', ...SASH, track: 3, fixed: true },
    { key: 'sash_middle', name: 'บานกลาง', ...SASH, track: 2, fixed: false },
    { key: 'sash_front', name: 'บานหน้า', ...SASH, track: 1, fixed: false },
  ],
  positions: {
    frame_top: { ...p.frame_top, name: 'เฟรมบน (3 ราง)', rule: { type: 'width', family: 'รางบนบิ๊กเฟรม' } },
    frame_bottom: { ...p.frame_bottom, name: 'เฟรมล่าง (3 ราง)', rule: { type: 'width', family: 'รางล่างบิ๊กเฟรม 2 ราง' } },
    frame_side: p.frame_side,
    fixed_top: pos('sash_fixed', 'h', 'บานเลื่อนบน (บานฟิก)', RAIL),
    fixed_bottom: pos('sash_fixed', 'h', 'บานเลื่อนล่าง (บานฟิก)', RAIL),
    fixed_key_stile: pos('sash_fixed', 'v', 'เสากุญแจ (บานฟิก)', STILE),
    fixed_hook_stile: pos('sash_fixed', 'v', 'เสาเกี่ยว (บานฟิก)', STILE),
    middle_top: pos('sash_middle', 'h', 'บานเลื่อนบน (บานกลาง)', RAIL, 'fixed_top'),
    middle_bottom: pos('sash_middle', 'h', 'บานเลื่อนล่าง (บานกลาง)', RAIL, 'fixed_bottom'),
    middle_hook_a: pos('sash_middle', 'v', 'เสาเกี่ยวซ้าย (บานกลาง)', STILE, 'fixed_hook_stile'),
    middle_hook_b: pos('sash_middle', 'v', 'เสาเกี่ยวขวา (บานกลาง)', STILE, 'fixed_hook_stile'),
    front_top: pos('sash_front', 'h', 'บานเลื่อนบน (บานหน้า)', RAIL, 'fixed_top'),
    front_bottom: pos('sash_front', 'h', 'บานเลื่อนล่าง (บานหน้า)', RAIL, 'fixed_bottom'),
    front_hook_stile: pos('sash_front', 'v', 'เสาเกี่ยว (บานหน้า)', STILE, 'fixed_hook_stile'),
    front_key_stile: pos('sash_front', 'v', 'เสากุญแจ (บานหน้า)', STILE, 'fixed_key_stile'),
  },
  // rail joint v = [left stile, right stile] in the fixed-left arrangement (the drawing swaps them when mirrored)
  joints: [
    sliding_n.joints[0],
    sliding_n.joints[1],
    ...railJoints('fixed_top', 'fixed_bottom', 'fixed_key_stile', 'fixed_hook_stile'),
    ...railJoints('middle_top', 'middle_bottom', 'middle_hook_a', 'middle_hook_b'),
    ...railJoints('front_top', 'front_bottom', 'front_hook_stile', 'front_key_stile'),
  ],
  order: [
    'frame_top', 'frame_bottom', 'frame_side',
    'fixed_top', 'fixed_bottom', 'fixed_key_stile', 'fixed_hook_stile',
    'middle_top', 'middle_bottom', 'middle_hook_a', 'middle_hook_b',
    'front_top', 'front_bottom', 'front_hook_stile', 'front_key_stile',
  ],
  hardware: [{ name: 'ลูกล้อ', per: 'unit', qty: '2*2' }, { name: 'ราง', per: 'unit', qty: 3 }],   // wheels on the 2 sliding sashes; rails informational
  symbol: { sash_fixed: 'slide', sash_middle: 'slide', sash_front: 'slide', direction: 'toward_fixed', fixedMark: 'F' },
}
