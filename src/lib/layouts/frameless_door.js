// ประตูกระจกเปลือย (D16) — aluminium only in the frame (two sides + head, no sill); the leaves are glass panes with no positions
// (`glass: true`; partModel.glassParts lists them). Schema: see layoutRegistry.js.
export default {
  kind: 'frameless_door',
  inputs: [
    { key: 'leaves', label: 'จำนวนบาน', type: 'number', min: 1, max: 2, integer: true, default: 1, estimator: true, fixed_by_type: true },
    { key: 'hinge', label: 'บานพับด้าน', type: 'select', options: [{ value: 'left', label: 'ซ้าย' }, { value: 'right', label: 'ขวา' }], default: 'left', only_when: { leaves: 1 }, estimator: true },
    { key: 'open', label: 'เปิด', type: 'select', options: [{ value: 'out', label: 'เปิดออก' }, { value: 'in', label: 'เปิดเข้า' }], default: 'out', estimator: true },
  ],
  parts: [
    { key: 'frame', name: 'วงกบ', count: 1, overlap_mode: 'manual', overlap_mm: 0, corner: 'butt', track: null, fixed: false, glass: false },
    { key: 'leaf', name: 'บานกระจก', count: 'leaves', overlap_mode: 'manual', overlap_mm: 0, corner: 'butt', track: null, fixed: false, glass: true },
  ],
  positions: {
    frame_top: { part: 'frame', orient: 'h', per: 1, name: 'เฟรมบน', rule: { type: 'width', family: 'กล่องเรียบ' } },
    frame_side: { part: 'frame', orient: 'v', per: 2, name: 'เฟรมข้าง', labels: ['ซ้าย', 'ขวา'], rule: { type: 'height', family: 'กล่องเรียบ' } },
  },
  joints: [
    { h: 'frame_top', v: ['frame_side', 'frame_side'], vPiece: 'byEnd', vEnd: 0, through: 'v', mode: 'butt' },
  ],
  order: ['frame_top', 'frame_side'],
  hardware: [
    { name: 'patch fitting', per: 'sash', qty: 2 },
    { name: 'floor spring', per: 'sash', qty: 1 },
    { name: 'มือจับสแตนเลส', per: 'sash', qty: 1 },
    { name: 'กุญแจล็อคพื้น', per: 'sash', qty: 1 },
  ],
  symbol: { leaf: 'v_hinge', hinge: 'alternate' },
}
