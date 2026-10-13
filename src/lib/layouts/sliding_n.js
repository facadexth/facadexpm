// หน้าต่าง/ประตูบานเลื่อน n บาน (n = 2–6) — sliding_2 generalised. With n = 2 it reproduces sliding_2 exactly.
// Rails: (W − frame sides + (n−1) overlaps) / n. Drawing: sashes of the right half are mirrored (key stiles at the frame).
export default {
  kind: 'sliding_n',
  inputs: [
    { key: 'n', label: 'จำนวนบาน', type: 'number', min: 2, max: 6, integer: true, default: 2, estimator: true },
    { key: 'door', label: 'ประตู (ราง/ธรณี)', type: 'boolean', default: false, fixed_by_type: true },
  ],
  namesWhen: { door: { frame_bottom: 'รางล่าง (ธรณี)', frame_top: 'รางบน' } },
  parts: [
    { key: 'frame', name: 'วงกบ', count: 1, overlap_mode: 'manual', overlap_mm: 0, corner: 'butt', track: null, fixed: false, glass: false },
    { key: 'sash', name: 'บานเลื่อน', count: 'n', overlap_mode: 'auto_hook', overlap_mm: 0, corner: 'butt', track: 'alternate' },
  ],
  positions: {
    frame_top: { part: 'frame', orient: 'h', per: 1, name: 'เฟรมบน', rule: { type: 'width' } },
    frame_bottom: { part: 'frame', orient: 'h', per: 1, name: 'เฟรมล่าง', rule: { type: 'width' } },
    frame_side: { part: 'frame', orient: 'v', per: 2, name: 'เฟรมข้าง', labels: ['ซ้าย', 'ขวา'], rule: { type: 'height' } },
    sash_top: { part: 'sash', orient: 'h', per: 1, name: 'บานเลื่อนบน', rule: { type: 'width_minus', auto: 'frame_sides', factor: '1/n', overlap: 'hook', overlapCount: 'n-1', role: 'sash' } },
    sash_bottom: { part: 'sash', orient: 'h', per: 1, name: 'บานเลื่อนล่าง', rule: { type: 'width_minus', auto: 'frame_sides', factor: '1/n', overlap: 'hook', overlapCount: 'n-1', role: 'sash' } },
    key_stile: { part: 'sash', orient: 'v', per: 1, name: 'เสากุญแจ', rule: { type: 'height_minus', auto: 'frame_top_bottom', role: 'sash' } },
    hook_stile: { part: 'sash', orient: 'v', per: 1, name: 'เสาเกี่ยว', rule: { type: 'height_minus', auto: 'frame_top_bottom', role: 'sash' } },
  },
  joints: [
    { h: 'frame_top', v: ['frame_side', 'frame_side'], vPiece: 'byEnd', vEnd: 0, through: 'v', mode: 'butt' },
    { h: 'frame_bottom', v: ['frame_side', 'frame_side'], vPiece: 'byEnd', vEnd: 1, through: 'v', mode: 'butt' },
    { h: 'sash_top', v: ['hook_stile', 'key_stile'], vPiece: 'same', vEnd: 0, through: 'v', mode: 'butt' },
    { h: 'sash_bottom', v: ['hook_stile', 'key_stile'], vPiece: 'same', vEnd: 1, through: 'v', mode: 'butt' },
  ],
  order: ['frame_top', 'frame_bottom', 'frame_side', 'sash_top', 'sash_bottom', 'key_stile', 'hook_stile'],
  hardware: [{ name: 'ลูกล้อ', per: 'sash', qty: 2 }, { name: 'กุญแจ/มือจับ', per: 'unit', qty: 1 }],
  symbol: { sash: 'slide', direction: 'halves' },   // left half slides →, right half ←
}
