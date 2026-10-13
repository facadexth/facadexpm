// บานกระทุ้ง rows x cols — fixed_grid + one mitred awning sash per cell. rows/cols come from door_window_types.layout_params.
// NOTE: sash count 'rows*cols' can exceed MAX_PART_COUNT (10); pieceCount clamps the part count to 10.
import fixed_grid from './fixed_grid.js'

const SASH_TOP_RULE = { type: 'width_minus', auto: 'grid_cols', factor: '1/cols', role: 'sash', family: 'กรอบในกระทุ้ง+คิ้ว' }

export default {
  ...fixed_grid,
  kind: 'awning_grid',
  inputs: [
    { key: 'rows', label: 'จำนวนแถว', type: 'number', min: 1, max: 8, integer: true, default: 2, estimator: true, fixed_by_type: true },
    { key: 'cols', label: 'จำนวนช่อง', type: 'number', min: 1, max: 12, integer: true, default: 2, estimator: true, fixed_by_type: true },
    { key: 'open', label: 'เปิด', type: 'select', options: [{ value: 'out', label: 'เปิดออก' }, { value: 'in', label: 'เปิดเข้า' }], default: 'out', estimator: true },
  ],
  parts: [
    ...fixed_grid.parts,
    { key: 'sash', name: 'บานกระทุ้ง', count: 'rows*cols', overlap_mode: 'manual', overlap_mm: 0, corner: 'mitre', track: null },
  ],
  positions: {
    ...fixed_grid.positions,
    sash_top: { part: 'sash', orient: 'h', per: 1, name: 'ราวบนบาน (บานพับ)', rule: { ...SASH_TOP_RULE } },
    sash_bottom: { part: 'sash', orient: 'h', per: 1, name: 'ราวล่างบาน (มือจับ)', rule: { ...SASH_TOP_RULE } },
    sash_side: { part: 'sash', orient: 'v', per: 2, name: 'เสาบาน', labels: ['ซ้าย', 'ขวา'], rule: { type: 'height_minus', auto: 'grid_rows', factor: '1/rows', role: 'sash', family: 'กรอบนอกกระทุ้ง' } },
  },
  joints: [
    ...fixed_grid.joints,
    { h: 'sash_top', v: ['sash_side', 'sash_side'], vPiece: 'byEnd', vEnd: 0, mode: 'mitre' },
    { h: 'sash_bottom', v: ['sash_side', 'sash_side'], vPiece: 'byEnd', vEnd: 1, mode: 'mitre' },
  ],
  order: [...fixed_grid.order, 'sash_top', 'sash_bottom', 'sash_side'],
  hardware: [{ name: 'แขนค้ำกระทุ้ง', per: 'sash', qty: 2 }, { name: 'มือจับ', per: 'sash', qty: 1 }],
  symbol: { sash: 'v_hinge', hinge: 'top' },
}
