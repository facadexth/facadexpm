// บานเลื่อน 3 ราง — 3 sashes on 3 tracks, one fixed (fixed_side). Rails use the same formula as sliding_n with n = 3.
// track [3,2,1] and fixed piece 0 are for the LEFT-fixed arrangement; mirrorWhen flips piece indexes when fixed_side is right.
import sliding_n from './sliding_n.js'

const RAIL = { type: 'width_minus', auto: 'frame_sides', factor: '1/3', overlap: 'hook', overlapCount: 2, role: 'sash' }
const p = sliding_n.positions

export default {
  kind: 'sliding_3track',
  inputs: [
    { key: 'fixed_side', label: 'บานติดตาย', type: 'select', options: [{ value: 'left', label: 'ซ้าย' }, { value: 'right', label: 'ขวา' }], default: 'left', estimator: true },
  ],
  mirrorWhen: { fixed_side: 'right' },
  parts: [
    sliding_n.parts[0],
    { key: 'sash', name: 'บานเลื่อน', count: 3, overlap_mode: 'auto_hook', overlap_mm: 0, corner: 'butt', track: [3, 2, 1], fixed: [true, false, false] },
  ],
  positions: {
    frame_top: { ...p.frame_top, name: 'เฟรมบน (3 ราง)', rule: { type: 'width', family: 'รางบนบิ๊กเฟรม' } },
    frame_bottom: { ...p.frame_bottom, name: 'เฟรมล่าง (3 ราง)', rule: { type: 'width', family: 'รางล่างบิ๊กเฟรม 2 ราง' } },
    frame_side: p.frame_side,
    sash_top: { ...p.sash_top, rule: { ...RAIL } },
    sash_bottom: { ...p.sash_bottom, rule: { ...RAIL } },
    key_stile: p.key_stile,
    hook_stile: p.hook_stile,
  },
  joints: sliding_n.joints,
  order: sliding_n.order,
  hardware: [{ name: 'ลูกล้อ', per: 'unit', qty: '2*2' }, { name: 'ราง', per: 'unit', qty: 3 }],   // wheels on the 2 sliding sashes; rails informational
  symbol: { sash: 'slide', direction: 'toward_fixed', fixedMark: 'F' },
}
