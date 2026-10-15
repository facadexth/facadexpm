// หน้าต่างบานเลื่อน 2 บาน — the original part-editor layout, moved to data. Behaviour is FROZEN (see partModel.test.js).
// Schema: see layoutRegistry.js.
// Options (Task 9) are invisible under the defaults (door false, one_fixed 0): `one_fixed` 1 (เลื่อน 1 ฟิก 1) adds
// sill_guard (ธรณีกันบานเลื่อน, one free piece on the frame) = (W − 2·b(frame_side) + o) × 0.5 − b(hook) − b(key) + w(key)
// (rule.minus / rule.plusWidth: terms applied after the factor, see partExpand.js). `door` and `one_fixed` only change the
// hardware: the template's starting rows (hardwareDefaults) and, per item, the delta of the layout hardware between the
// template's params and the item's (hardwareDefaults.itemHardwareRows, owner 2026-10-15: ประตู/หน้าต่าง is chosen per item). The drawing does not mark the fixed sash (part.fixed cannot follow a param): both slide arrows show.
export default {
  kind: 'sliding_2',
  inputs: [
    // W/H are implicit (width_m/height_m)
    { key: 'door', label: 'ประตู / หน้าต่าง', type: 'boolean', default: false, fixed_by_type: true, estimator: true },
    { key: 'one_fixed', label: 'รูปแบบบาน', type: 'select', options: [{ value: 0, label: 'เลื่อนสวน (2 บานเลื่อน)' }, { value: 1, label: 'เลื่อน 1 ฟิก 1' }], default: 0, fixed_by_type: true, estimator: true },
    { key: 'fixed_side', label: 'บานฟิกอยู่', type: 'select', options: [{ value: 'left', label: 'ซ้าย' }, { value: 'right', label: 'ขวา' }], default: 'left', only_when: { one_fixed: 1 }, estimator: true },
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
    sill_guard: { part: 'frame', orient: 'h', per: 1, name: 'ธรณีกันบานเลื่อน', enabled: 'one_fixed', corner: 'free',
      rule: { type: 'width_minus', auto: 'frame_sides', factor: 0.5, overlap: 'hook', role: 'sash', family: 'ธรณีกันบานเลื่อน', minus: ['hook_stile', 'key_stile'], plusWidth: ['key_stile'] } },
  },
  joints: [
    { h: 'frame_top', v: ['frame_side', 'frame_side'], vPiece: 'byEnd', vEnd: 0, through: 'v', mode: 'butt' },
    { h: 'frame_bottom', v: ['frame_side', 'frame_side'], vPiece: 'byEnd', vEnd: 1, through: 'v', mode: 'butt' },
    { h: 'sash_top', v: ['hook_stile', 'key_stile'], vPiece: 'same', vEnd: 0, through: 'v', mode: 'butt' },
    { h: 'sash_bottom', v: ['hook_stile', 'key_stile'], vPiece: 'same', vEnd: 1, through: 'v', mode: 'butt' },
  ],
  order: ['frame_top', 'frame_bottom', 'frame_side', 'sash_top', 'sash_bottom', 'key_stile', 'hook_stile', 'sill_guard'],
  hardware: [
    { name: 'ลูกล้อ', per: 'unit', qty: '4-2*one_fixed' },
    { name: 'มือจับล็อค (ด้านใน)', per: 'unit', qty: '2-one_fixed' },
    { name: 'กุญแจ/มือจับเรียบ (ด้านนอก)', per: 'unit', qty: 'door*(2-one_fixed)' },
  ],
  symbol: { sash: 'slide' },
}
