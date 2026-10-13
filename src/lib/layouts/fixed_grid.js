// บานกระจกติดตาย แบ่งช่อง rows x cols — frame + mullions (ซอยกลางตั้ง) + transoms (ซอยกลางนอน). Schema: see layoutRegistry.js.
// Limits (plan Global Constraints): rows 1-8, cols 1-12, whole numbers.
export default {
  kind: 'fixed_grid',
  inputs: [
    { key: 'rows', label: 'จำนวนแถว', type: 'number', min: 1, max: 8, integer: true, default: 2, estimator: true },
    { key: 'cols', label: 'จำนวนช่อง', type: 'number', min: 1, max: 12, integer: true, default: 3, estimator: true },
  ],
  parts: [
    { key: 'frame', name: 'วงกบ', count: 1, overlap_mode: 'manual', overlap_mm: 0, corner: 'butt', track: null, fixed: false, glass: false },
    { key: 'grid', name: 'ซอยกลาง', count: 1, overlap_mode: 'manual', overlap_mm: 0, corner: 'butt', track: null, fixed: false, glass: false },
  ],
  positions: {
    frame_top: { part: 'frame', orient: 'h', per: 1, name: 'เฟรมบน', rule: { type: 'width', family: 'กล่องเรียบ' } },
    frame_bottom: { part: 'frame', orient: 'h', per: 1, name: 'เฟรมล่าง', rule: { type: 'width', family: 'กล่องเรียบ' } },
    frame_side: { part: 'frame', orient: 'v', per: 2, name: 'เฟรมข้าง', labels: ['ซ้าย', 'ขวา'], rule: { type: 'height', family: 'กล่องเรียบ' } },
    mullion: { part: 'grid', orient: 'v', per: 'cols-1', name: 'ซอยกลางตั้ง', rule: { type: 'height_minus', auto: 'frame_top_bottom', family: 'ซอยกลาง 4" ยูโร' } },
    transom: { part: 'grid', orient: 'h', per: '(rows-1)*cols', name: 'ซอยกลางนอน', rule: { type: 'width_minus', auto: 'grid_cols', factor: '1/cols', family: 'ซอยกลาง 2" ยูโร' } },
  },
  joints: [
    { h: 'frame_top', v: ['frame_side', 'frame_side'], vPiece: 'byEnd', vEnd: 0, through: 'v', mode: 'butt' },
    { h: 'frame_bottom', v: ['frame_side', 'frame_side'], vPiece: 'byEnd', vEnd: 1, through: 'v', mode: 'butt' },
    { h: 'transom', v: ['mullion', 'mullion'], through: 'v', mode: 'tee' },
  ],
  order: ['frame_top', 'frame_bottom', 'frame_side', 'mullion', 'transom'],
  hardware: [],
  symbol: {},
}
