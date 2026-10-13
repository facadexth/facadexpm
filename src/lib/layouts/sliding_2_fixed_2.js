// บานเลื่อน 2 + ติดตาย 2 (4 sashes, outer two fixed). Stiles are per sash (stile_a left / stile_b right) with
// piece-dependent default names (D10, left to right); sill_cover (ตบธรณี) is a free profile of W × 0.5.
import sliding_n from './sliding_n.js'

const RAIL = { type: 'width_minus', auto: 'frame_sides', factor: 0.25, overlap: 'hook', overlapCount: 2, role: 'sash' }
const STILE = { type: 'height_minus', auto: 'frame_top_bottom', role: 'sash' }
const p = sliding_n.positions

export default {
  kind: 'sliding_2_fixed_2',
  inputs: [],
  roles: { hook: 'stile_b' },
  pieceNames: {
    stile_a: ['เสากุญแจ', 'เสาเกี่ยว', 'เสากุญแจตัวเมีย', 'เสาเกี่ยว'],
    stile_b: ['เสาเกี่ยว', 'เสากุญแจตัวผู้', 'เสาเกี่ยว', 'เสากุญแจ'],
  },
  parts: [
    sliding_n.parts[0],
    { key: 'sash', name: 'บานเลื่อน', count: 4, overlap_mode: 'auto_hook', overlap_mm: 0, corner: 'butt', track: [2, 1, 1, 2], fixed: [true, false, false, true] },
  ],
  positions: {
    frame_top: p.frame_top,
    frame_bottom: p.frame_bottom,
    frame_side: p.frame_side,
    sash_top: { ...p.sash_top, rule: { ...RAIL } },
    sash_bottom: { ...p.sash_bottom, rule: { ...RAIL } },
    stile_a: { part: 'sash', orient: 'v', per: 1, name: 'เสาซ้ายของบาน', rule: { ...STILE } },
    stile_b: { part: 'sash', orient: 'v', per: 1, name: 'เสาขวาของบาน', rule: { ...STILE } },
    sill_cover: { part: 'frame', orient: 'h', per: 1, name: 'ตบธรณี', corner: 'free', rule: { type: 'width', factor: 0.5 } },
  },
  joints: [
    sliding_n.joints[0],
    sliding_n.joints[1],
    { h: 'sash_top', v: ['stile_a', 'stile_b'], vPiece: 'same', vEnd: 0, through: 'v', mode: 'butt' },
    { h: 'sash_bottom', v: ['stile_a', 'stile_b'], vPiece: 'same', vEnd: 1, through: 'v', mode: 'butt' },
  ],
  order: ['frame_top', 'frame_bottom', 'frame_side', 'sash_top', 'sash_bottom', 'stile_a', 'stile_b', 'sill_cover'],
  hardware: [{ name: 'ลูกล้อ', per: 'unit', qty: 4 }, { name: 'กุญแจ', per: 'unit', qty: 1 }],
  symbol: { sash: 'slide', direction: 'halves', fixedMark: 'F' },
}
