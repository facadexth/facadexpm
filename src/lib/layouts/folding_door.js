// ประตูบานเฟี้ยม (D1) — nL leaves folding to the left, nR to the right, in a track frame (top, bottom U, two sides).
// startModel / setParams throw 'layout_params_invalid' when nL + nR = 0 (validParams; the editor shows "ใส่จำนวนบานซ้าย/ขวา").
// nL and nR are capped at 5 each so nL + nR <= 10 = MAX_PART_COUNT (pieceCount clamps a part's count to 10; a larger sum would
// silently lose leaves while the factor stays 1/(nL+nR)).
// The two free positions (บังใบ, คิ้วบาน) have no joint: the owner may delete them. Their default families are guesses.
// Track frame corners (owner 2026-10-16, Q1 answer ก, D1): the top / bottom tracks run through (full W) and the side
// tracks butt between them, so the joints say through: 'h'. The side track is a plain `height` rule: its two butt ends
// deduct b(top) + b(bottom) once (the old height_minus track_top_bottom pre-deduction on top of butting top/bottom
// tracks shortened both members at every corner). The drawing reads the same end modes, so it agrees.
// Schema: see layoutRegistry.js.
const LEAF_W = { type: 'width_minus', auto: 'track_sides', factor: '1/(nL+nR)', role: 'sash' }
const LEAF_H = { type: 'height_minus', auto: 'track_top_bottom', role: 'sash' }
export default {
  kind: 'folding_door',
  inputs: [
    { key: 'nL', label: 'จำนวนบานพับซ้าย', type: 'number', min: 0, max: 5, integer: true, default: 2, estimator: true },
    { key: 'nR', label: 'จำนวนบานพับขวา', type: 'number', min: 0, max: 5, integer: true, default: 2, estimator: true },
  ],
  validParams: 'nL+nR',
  parts: [
    { key: 'track', name: 'รางเฟี้ยม', count: 1, overlap_mode: 'manual', overlap_mm: 0, corner: 'butt', track: null, fixed: false, glass: false },
    { key: 'leaf', name: 'บานเฟี้ยม', count: 'nL+nR', overlap_mode: 'manual', overlap_mm: 0, corner: 'butt', track: null, fixed: false, glass: false },
  ],
  positions: {
    track_top: { part: 'track', orient: 'h', per: 1, name: 'รางบน', rule: { type: 'width', family: 'รางบน' } },
    track_bottom: { part: 'track', orient: 'h', per: 1, name: 'รางล่าง (ยูฝังพื้น)', rule: { type: 'width', family: 'รางล่าง (ยูฝังพื้น)' } },
    track_side: { part: 'track', orient: 'v', per: 2, name: 'รางข้าง', labels: ['ซ้าย', 'ขวา'], rule: { type: 'height', family: 'รางข้าง' } },
    leaf_top: { part: 'leaf', orient: 'h', per: 1, name: 'ราวบนบาน', rule: { ...LEAF_W, family: 'บานเฟี้ยมบน' } },
    leaf_bottom: { part: 'leaf', orient: 'h', per: 1, name: 'ราวล่างบาน', rule: { ...LEAF_W, family: 'บานเฟี้ยมล่าง' } },
    leaf_side: { part: 'leaf', orient: 'v', per: 2, name: 'เสาบาน', labels: ['เสาบานพับ', 'เสาอิสระ'], rule: { ...LEAF_H, family: 'เสาบานเฟี้ยม' } },
    leaf_cover_v: { part: 'leaf', orient: 'v', per: 2, name: 'บังใบ', corner: 'free', rule: { ...LEAF_H, family: 'บังใบ' } },
    leaf_cover_h: { part: 'leaf', orient: 'h', per: 2, name: 'คิ้วบาน', corner: 'free', rule: { ...LEAF_W, family: 'คิ้วบาน' } },
  },
  joints: [
    { h: 'track_top', v: ['track_side', 'track_side'], vPiece: 'byEnd', vEnd: 0, through: 'h', mode: 'butt' },
    { h: 'track_bottom', v: ['track_side', 'track_side'], vPiece: 'byEnd', vEnd: 1, through: 'h', mode: 'butt' },
    { h: 'leaf_top', v: ['leaf_side', 'leaf_side'], vPiece: 'byEnd', vEnd: 0, through: 'v', mode: 'butt' },
    { h: 'leaf_bottom', v: ['leaf_side', 'leaf_side'], vPiece: 'byEnd', vEnd: 1, through: 'v', mode: 'butt' },
  ],
  order: ['track_top', 'track_bottom', 'track_side', 'leaf_top', 'leaf_bottom', 'leaf_side', 'leaf_cover_v', 'leaf_cover_h'],
  // ceil(n/(n+1)) is 1 when the side has at least one leaf and 0 otherwise (a division-safe "n > 0")
  hardware: [
    { name: 'ล้อบน/ล่างบานเฟี้ยม', per: 'unit', qty: '(ceil(nL/2)+ceil(nR/2))*2' },
    { name: 'บานพับ', per: 'unit', qty: 'max(0,nL-1)*3+max(0,nR-1)*3' },
    { name: 'บานพับวงกบ', per: 'unit', qty: 'ceil(nL/(nL+1))*3+ceil(nR/(nR+1))*3' },
    { name: 'มือจับ', per: 'unit', qty: 'ceil(nL/(nL+1))+ceil(nR/(nR+1))' },
  ],
  symbol: { leaf: 'fold' },   // alternating V, arrows to each side, a split line when both nL and nR > 0
}
