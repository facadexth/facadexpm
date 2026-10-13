// บานเปิด n บาน (rows fixed at 1) — frame + n-1 mullions + n mitred casement sashes.
// Sash widths use rule.auto 'grid_n' (partExpand): the same as grid_cols but reading the `n` input instead of `cols`.
import fixed_grid from './fixed_grid.js'

const SASH_RAIL_RULE = { type: 'width_minus', auto: 'grid_n', factor: '1/n', role: 'sash', family: 'กรอบในกระทุ้ง+คิ้ว' }
const { frame_top, frame_bottom, frame_side, mullion } = fixed_grid.positions

export default {
  kind: 'casement_n',
  inputs: [
    // R-12a: the type may pin n (บานเปิดข้างเดี่ยว n = 1); when it does not, the item sets n (บานเปิดข้าง)
    { key: 'n', label: 'จำนวนบาน', type: 'number', min: 1, max: 8, integer: true, default: 2, estimator: true, fixed_by_type: true },
    { key: 'hinge', label: 'บานพับด้าน', type: 'select', options: [{ value: 'left', label: 'ซ้าย' }, { value: 'right', label: 'ขวา' }], default: 'left', only_when: { n: 1 }, estimator: true },
    { key: 'open', label: 'เปิด', type: 'select', options: [{ value: 'out', label: 'เปิดออก' }, { value: 'in', label: 'เปิดเข้า' }], default: 'out', estimator: true },
  ],
  parts: [
    fixed_grid.parts[0],
    { key: 'grid', name: 'ซอยกลาง', count: 1, overlap_mode: 'manual', overlap_mm: 0, corner: 'butt', track: null, fixed: false, glass: false },
    { key: 'sash', name: 'บานเปิด', count: 'n', overlap_mode: 'manual', overlap_mm: 0, corner: 'mitre', track: null },
  ],
  positions: {
    frame_top, frame_bottom, frame_side,
    mullion: { ...mullion, per: 'n-1' },
    sash_top: { part: 'sash', orient: 'h', per: 1, name: 'ราวบนบาน', rule: { ...SASH_RAIL_RULE } },
    sash_bottom: { part: 'sash', orient: 'h', per: 1, name: 'ราวล่างบาน', rule: { ...SASH_RAIL_RULE } },
    sash_side: { part: 'sash', orient: 'v', per: 2, name: 'เสาบาน', labels: ['เสาบานพับ', 'เสามือจับ'], rule: { type: 'height_minus', auto: 'frame_top_bottom', role: 'sash', family: 'กรอบนอกกระทุ้ง' } },
  },
  joints: [
    fixed_grid.joints[0],
    fixed_grid.joints[1],
    { h: 'sash_top', v: ['sash_side', 'sash_side'], vPiece: 'byEnd', vEnd: 0, mode: 'mitre' },
    { h: 'sash_bottom', v: ['sash_side', 'sash_side'], vPiece: 'byEnd', vEnd: 1, mode: 'mitre' },
  ],
  order: ['frame_top', 'frame_bottom', 'frame_side', 'mullion', 'sash_top', 'sash_bottom', 'sash_side'],
  hardware: [{ name: 'บานพับ', per: 'sash', qty: 2 }, { name: 'มือจับ', per: 'sash', qty: 1 }],
  symbol: { sash: 'v_hinge', hinge: 'alternate' },
}
