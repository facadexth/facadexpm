// หน้าต่างบานเลื่อน 2 บาน — the original part-editor layout, moved to data. Behaviour is FROZEN (see partModel.test.js).
// Schema: see layoutRegistry.js.
export default {
  kind: 'sliding_2',
  inputs: [
    // W/H are implicit (width_m/height_m); sliding_2 has no extra inputs
  ],
  parts: [
    { key: 'frame', name: 'วงกบ', count: 1, overlap_mode: 'manual', overlap_mm: 0, corner: 'butt', track: null, fixed: false, glass: false },
    { key: 'sash', name: 'บานเลื่อน', count: 2, overlap_mode: 'auto_hook', overlap_mm: 0, corner: 'butt', track: 'alternate' },
  ],
  positions: {
    frame_top: { part: 'frame', orient: 'h', per: 1, name: 'เฟรมบน', rule: { type: 'width' } },
    frame_bottom: { part: 'frame', orient: 'h', per: 1, name: 'เฟรมล่าง', rule: { type: 'width' } },
    frame_side: { part: 'frame', orient: 'v', per: 2, name: 'เฟรมข้าง', labels: ['ซ้าย', 'ขวา'], rule: { type: 'height' } },
    sash_top: { part: 'sash', orient: 'h', per: 1, name: 'บานเลื่อนบน', rule: { type: 'width_minus', auto: 'frame_sides', factor: 0.5, overlap: 'hook', role: 'sash' } },
    sash_bottom: { part: 'sash', orient: 'h', per: 1, name: 'บานเลื่อนล่าง', rule: { type: 'width_minus', auto: 'frame_sides', factor: 0.5, overlap: 'hook', role: 'sash' } },
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
  symbol: { sash: 'slide' },
}
