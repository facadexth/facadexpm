import { describe, it, expect } from 'vitest'
import { defaultParams, kinds, LAYOUTS, validateLayout } from '../layoutRegistry.js'
import { startModel, validateCorners, pieceCount, setParams, trackOf, isFixedPiece, pieceLabel } from '../partModel.js'
import { expandParts } from '../partExpand.js'
import { computeComponentLength } from '../bomEngine.js'
import { symbolFor } from '../partSymbols.js'

const buttOf = () => 45
const widthOf = () => 60
const fill = (m) => { for (const ls of Object.values(m.lines)) for (const l of ls) l.profile_family = l.profile_family || 'F'; return m }
const mk = (kind, typeParams, patch) => { let m = startModel(kind, defaultParams(kind, typeParams)); if (patch) m = setParams(m, patch); return fill(m) }
const run = (m, wm, hm) => {
  const { components, issues } = expandParts({ model: m, buttOf, widthOf })
  const row = (name) => components.filter((c) => c.role_name === name)
  const len = (c) => computeComponentLength(c.length_rule_type, c.length_deduction_mm, wm / 1000, hm / 1000, c.length_factor, c.end_deduction_mm) * 1000
  return { components, issues, row, len }
}
const counts = (m) => Object.fromEntries(Object.keys(m.lines).map((k) => [k, pieceCount(m, k)]))

describe('registry has the grid layouts', () => {
  it('kinds', () => { for (const k of ['fixed_grid', 'awning_grid', 'casement_n', 'sliding_n', 'sliding_3track', 'sliding_2_fixed_2']) expect(kinds()).toContain(k) })
})

describe('fixed_grid', () => {
  it('snapshot: line keys and piece counts at the defaults (rows 2, cols 3)', () => {
    const m = startModel('fixed_grid', defaultParams('fixed_grid', {}))
    expect(Object.keys(m.lines)).toEqual(['frame_top', 'frame_bottom', 'frame_side', 'mullion', 'transom'])
    expect(counts(m)).toEqual({ frame_top: 1, frame_bottom: 1, frame_side: 2, mullion: 2, transom: 3 })
    expect(m.lines.frame_top[0].profile_family).toBe('กล่องเรียบ')
    expect(m.lines.mullion[0].profile_family).toBe('ซอยกลาง 4" ยูโร')
    expect(m.lines.transom[0].profile_family).toBe('ซอยกลาง 2" ยูโร')
    expect(validateCorners(m)).toEqual([])
  })
  it('2 x 3 at 1800 x 1200: mullion 2 x 1110, transom 3 x 530 (R-3b)', () => {
    const r = run(mk('fixed_grid'), 1800, 1200)
    expect(r.issues).toEqual([])
    const mul = r.row('ซอยกลางตั้ง')[0]
    expect(mul.quantity_value).toBe(2)
    expect(mul.length_deduction_mm).toBe(90)
    expect(r.len(mul)).toBeCloseTo(1110, 6)
    const tr = r.row('ซอยกลางนอน')[0]
    expect(tr.quantity_value).toBe(3)
    expect(tr.length_deduction_mm).toBe(210)
    expect(r.len(tr)).toBeCloseTo(530, 6)
  })
  it('cols 1 rows 1: no mullion/transom rows, no issues', () => {
    const m = mk('fixed_grid', {}, { rows: 1, cols: 1 })
    const r = run(m, 1800, 1200)
    expect(r.issues).toEqual([])
    expect(r.row('ซอยกลางตั้ง')).toEqual([])
    expect(r.row('ซอยกลางนอน')).toEqual([])
    expect(validateCorners(m)).toEqual([])
  })
})

describe('awning_grid', () => {
  const typeParams = { rows: 2, cols: 2 }
  it('snapshot', () => {
    const m = startModel('awning_grid', defaultParams('awning_grid', typeParams))
    expect(Object.keys(m.lines)).toEqual(['frame_top', 'frame_bottom', 'frame_side', 'mullion', 'transom', 'sash_top', 'sash_bottom', 'sash_side'])
    expect(counts(m)).toEqual({ frame_top: 1, frame_bottom: 1, frame_side: 2, mullion: 1, transom: 2, sash_top: 4, sash_bottom: 4, sash_side: 8 })
    expect(m.lines.sash_top[0].profile_family).toBe('กรอบในกระทุ้ง+คิ้ว')
    expect(m.lines.sash_side[0].profile_family).toBe('กรอบนอกกระทุ้ง')
    expect(m.params).toEqual({ rows: 2, cols: 2, open: 'out' })
    expect(validateCorners(m)).toEqual([])
  })
  it('2 x 2 at 1200 x 1200: cells 525, sashes mitred', () => {
    const r = run(mk('awning_grid', typeParams), 1200, 1200)
    expect(r.issues).toEqual([])
    for (const [name, qty] of [['ราวบนบาน (บานพับ)', 4], ['ราวล่างบาน (มือจับ)', 4], ['เสาบาน', 8]]) {
      const c = r.row(name)[0]
      expect(c.length_deduction_mm).toBe(150)
      expect(c.length_factor).toBe(0.5)
      expect(c.end_deduction_mm).toBe(0)
      expect(c.quantity_value).toBe(qty)
      expect(c.cut_style).toBe('miter45')
      expect(r.len(c)).toBeCloseTo(525, 6)
    }
    const mul = r.row('ซอยกลางตั้ง')[0]
    expect(mul.quantity_value).toBe(1)
    expect(r.len(mul)).toBeCloseTo(1110, 6)
    const tr = r.row('ซอยกลางนอน')[0]
    expect(tr.quantity_value).toBe(2)
    expect(r.len(tr)).toBeCloseTo(525, 6)
  })
  it('rows*cols above 10 clamps the sash count to MAX_PART_COUNT (10)', () => {
    const m = startModel('awning_grid', defaultParams('awning_grid', { rows: 4, cols: 4 }))
    expect(pieceCount(m, 'sash_top')).toBe(10)
  })
  it('symbol: top-hinged', () => {
    const m = startModel('awning_grid', defaultParams('awning_grid', typeParams))
    expect(symbolFor(m, 'sash', 0)).toEqual({ kind: 'v_hinge', hinge: 'top' })
    expect(symbolFor(m, 'frame', 0)).toEqual({ kind: 'none', hinge: null })
  })
})

describe('casement_n', () => {
  it('snapshot (n 2)', () => {
    const m = startModel('casement_n', defaultParams('casement_n', {}))
    expect(Object.keys(m.lines)).toEqual(['frame_top', 'frame_bottom', 'frame_side', 'mullion', 'sash_top', 'sash_bottom', 'sash_side'])
    expect(counts(m)).toEqual({ frame_top: 1, frame_bottom: 1, frame_side: 2, mullion: 1, sash_top: 2, sash_bottom: 2, sash_side: 4 })
    expect(m.params).toEqual({ n: 2, hinge: 'left', open: 'out' })
    expect(validateCorners(m)).toEqual([])
  })
  it('n 2 at 1500 x 1200: mullion 1 x 1110, sash_top 2 x 675, sash_side 4 x 1110', () => {
    const r = run(mk('casement_n'), 1500, 1200)
    expect(r.issues).toEqual([])
    const mul = r.row('ซอยกลางตั้ง')[0]
    expect(mul.quantity_value).toBe(1)
    expect(r.len(mul)).toBeCloseTo(1110, 6)
    const top = r.row('ราวบนบาน')[0]
    expect(top.quantity_value).toBe(2)
    expect(r.len(top)).toBeCloseTo(675, 6)
    expect(top.cut_style).toBe('miter45')
    const side = r.row('เสาบาน')[0]
    expect(side.quantity_value).toBe(4)
    expect(r.len(side)).toBeCloseTo(1110, 6)
  })
  it('n 1: no mullion, sash_top 1 x 1410, hinge honoured by the symbol', () => {
    const m = mk('casement_n', {}, { n: 1 })
    const r = run(m, 1500, 1200)
    expect(r.issues).toEqual([])
    expect(r.row('ซอยกลางตั้ง')).toEqual([])
    const top = r.row('ราวบนบาน')[0]
    expect(top.quantity_value).toBe(1)
    expect(r.len(top)).toBeCloseTo(1410, 6)
    expect(symbolFor(m, 'sash', 0)).toEqual({ kind: 'v_hinge', hinge: 'left' })
    expect(symbolFor(setParams(m, { hinge: 'right' }), 'sash', 0)).toEqual({ kind: 'v_hinge', hinge: 'right' })
  })
  it('n 3 alternates the hinge, middle piece left', () => {
    const m = startModel('casement_n', defaultParams('casement_n', {}))
    const m3 = setParams(m, { n: 3 })
    expect([0, 1, 2].map((i) => symbolFor(m3, 'sash', i).hinge)).toEqual(['left', 'left', 'right'])
    expect([0, 1].map((i) => symbolFor(m, 'sash', i).hinge)).toEqual(['left', 'right'])
  })
})

// ---------------------------------------------------------------- sliding family (Task 5)
const r6 = (x) => Math.round(x * 1e6) / 1e6
const BUTT = { FS: 38.1, FT: 38.1, FB: 35.8, KS: 25, HS: 25 }
const slidingModel = (kind, patch, fams) => {
  let m = startModel(kind, defaultParams(kind, {}))
  if (patch) m = setParams(m, patch)
  for (const [k, ls] of Object.entries(m.lines)) for (const l of ls) l.profile_family = (fams && fams[k]) || l.profile_family || 'F'
  return m
}
// frame family F butts 45, hook stile family H butts 40 (ov = 40, b = 45)
const b45ov40 = (f) => (f === 'H' ? 40 : 45)
const runWith = (m, wm, hm, bo) => {
  const { components, issues } = expandParts({ model: m, buttOf: bo, widthOf: () => null })
  const len = (c) => computeComponentLength(c.length_rule_type, c.length_deduction_mm, wm / 1000, hm / 1000, c.length_factor, c.end_deduction_mm) * 1000
  return { components, issues, len, row: (name) => components.filter((c) => c.role_name === name) }
}

describe('sliding_n', () => {
  it('snapshot (n 2): same position keys as sliding_2, sash count follows n', () => {
    const m = startModel('sliding_n', defaultParams('sliding_n', {}))
    expect(Object.keys(m.lines)).toEqual(Object.keys(startModel('sliding_2').lines))
    expect(m.params).toEqual({ n: 2, door: false })
    expect(counts(m)).toEqual({ frame_top: 1, frame_bottom: 1, frame_side: 2, sash_top: 2, sash_bottom: 2, key_stile: 2, hook_stile: 2 })
    expect(validateCorners(m)).toEqual([])
    expect(setParams(m, { n: 6 }).parts.find((p) => p.key === 'sash').count).toBe('n')
    expect(pieceCount(setParams(m, { n: 6 }), 'sash_top')).toBe(6)
  })
  it('n 2 reproduces sliding_2 at 1800 x 1200 exactly (1723.8 / 1200 / 824.4 / 1126.1)', () => {
    const FAM = { frame_top: 'FT', frame_bottom: 'FB', frame_side: 'FS', sash_top: 'ST', sash_bottom: 'SB', key_stile: 'KS', hook_stile: 'HS' }
    const bo = (f) => (f in BUTT ? BUTT[f] : null)
    const a = runWith(slidingModel('sliding_n', null, FAM), 1800, 1200, bo)
    const b = (() => { const m = startModel('sliding_2'); for (const [k, f] of Object.entries(FAM)) m.lines[k][0].profile_family = f; return runWith(m, 1800, 1200, bo) })()
    expect(a.issues).toEqual([])
    expect(a.components).toEqual(b.components)
    expect(a.len(a.row('เฟรมบน')[0])).toBeCloseTo(1723.8, 6)
    expect(a.len(a.row('เฟรมข้าง')[0])).toBeCloseTo(1200, 6)
    expect(a.len(a.row('บานเลื่อนบน')[0])).toBeCloseTo(824.4, 6)
    expect(a.len(a.row('เสากุญแจ')[0])).toBeCloseTo(1126.1, 6)
  })
  it('n 3 at 2700 x 1200, ov 40, b 45: rail (2700 - 90 + 80) / 3 = 896.67, 3 rails, 3 + 3 stiles', () => {
    const m = slidingModel('sliding_n', { n: 3 }, { hook_stile: 'H' })
    const r = runWith(m, 2700, 1200, b45ov40)
    expect(r.issues).toEqual([])
    const top = r.row('บานเลื่อนบน')[0]
    expect(top.quantity_value).toBe(3)
    expect(top.length_deduction_mm).toBe(10)   // 90 - 2 x 40
    expect(top.length_factor).toBeCloseTo(1 / 3, 9)
    expect(r6(r.len(top) + top.end_deduction_mm)).toBe(r6(2690 / 3))
    expect(r6(2690 / 3)).toBe(896.666667)
    expect(r.row('เสากุญแจ')[0].quantity_value).toBe(3)
    expect(r.row('เสาเกี่ยว')[0].quantity_value).toBe(3)
  })
  it('trackOf alternates 1,2,1,2 and no piece is fixed', () => {
    const m = slidingModel('sliding_n', { n: 4 })
    expect([0, 1, 2, 3].map((i) => trackOf(m, 'sash', i))).toEqual([1, 2, 1, 2])
    expect([0, 1, 2, 3].map((i) => isFixedPiece(m, 'sash', i))).toEqual([false, false, false, false])
    expect(trackOf(m, 'frame', 0)).toBe(1)
  })
  it('door: true renames frame_bottom / frame_top; hardware and symbol', () => {
    const d = startModel('sliding_n', { door: true })
    expect(d.names.frame_bottom).toBe('รางล่าง (ธรณี)')
    expect(d.names.frame_top).toBe('รางบน')
    const w = startModel('sliding_n', defaultParams('sliding_n', {}))
    expect(w.names.frame_bottom).toBe('เฟรมล่าง')
    expect(LAYOUTS_HW('sliding_n')).toEqual([{ name: 'ลูกล้อ', per: 'sash', qty: 2 }, { name: 'กุญแจ/มือจับ', per: 'unit', qty: 1 }])
    expect(symbolFor(w, 'sash', 0).kind).toBe('slide')
  })
  it('input definitions: n 2-6 estimator, door fixed_by_type', () => {
    const [n, door] = LAYOUTS.sliding_n.inputs
    expect([n.key, n.min, n.max, n.default, n.estimator]).toEqual(['n', 2, 6, 2, true])
    expect([door.key, door.fixed_by_type, door.default]).toEqual(['door', true, false])
    expect(defaultParams('sliding_n', { door: true, n: 9 })).toEqual({ n: 2, door: true })
  })
})

const LAYOUTS_HW = (k) => LAYOUTS[k].hardware

describe('sliding_3track', () => {
  it('snapshot: 3 sashes, frame names and families, params', () => {
    const m = startModel('sliding_3track', defaultParams('sliding_3track', {}))
    expect(m.params).toEqual({ fixed_side: 'left' })
    expect(counts(m).sash_top).toBe(3)
    expect(m.names.frame_top).toBe('เฟรมบน (3 ราง)')
    expect(m.names.frame_bottom).toBe('เฟรมล่าง (3 ราง)')
    expect(m.lines.frame_top[0].profile_family).toBe('รางบนบิ๊กเฟรม')
    expect(m.lines.frame_bottom[0].profile_family).toBe('รางล่างบิ๊กเฟรม 2 ราง')
    expect(validateCorners(m)).toEqual([])
  })
  it('same numbers as sliding_n 3 at 2700 x 1200 (ov 40, b 45): rail 896.67', () => {
    const m = slidingModel('sliding_3track', null, { hook_stile: 'H' })
    const r = runWith(m, 2700, 1200, b45ov40)
    expect(r.issues).toEqual([])
    const top = r.row('บานเลื่อนบน')[0]
    expect(top.quantity_value).toBe(3)
    expect(r6(r.len(top) + top.end_deduction_mm)).toBe(r6(2690 / 3))
  })
  it('track metadata [3,2,1] and fixed piece 0', () => {
    const m = startModel('sliding_3track', defaultParams('sliding_3track', {}))
    expect([0, 1, 2].map((i) => trackOf(m, 'sash', i))).toEqual([3, 2, 1])
    expect([0, 1, 2].map((i) => isFixedPiece(m, 'sash', i))).toEqual([true, false, false])
  })
  it('fixed_side right mirrors track and fixed', () => {
    const m = setParams(startModel('sliding_3track', defaultParams('sliding_3track', {})), { fixed_side: 'right' })
    expect(isFixedPiece(m, 'sash', 2)).toBe(true)
    expect(isFixedPiece(m, 'sash', 0)).toBe(false)
    expect([0, 1, 2].map((i) => trackOf(m, 'sash', i))).toEqual([1, 2, 3])
  })
  it('hardware: wheels 2 x 2 on the sliding sashes, 3 rails (info), symbol slide', () => {
    expect(LAYOUTS_HW('sliding_3track')).toEqual(expect.arrayContaining([{ name: 'ลูกล้อ', per: 'unit', qty: '2*2' }, { name: 'ราง', per: 'unit', qty: 3 }]))
    expect(symbolFor(startModel('sliding_3track', defaultParams('sliding_3track', {})), 'sash', 0).kind).toBe('slide')
  })
})

describe('sliding_2_fixed_2', () => {
  const m0 = () => startModel('sliding_2_fixed_2', defaultParams('sliding_2_fixed_2', {}))
  it('snapshot', () => {
    const m = m0()
    expect(m.params).toEqual({})
    expect(counts(m)).toEqual({ frame_top: 1, frame_bottom: 1, frame_side: 2, sash_top: 4, sash_bottom: 4, stile_a: 4, stile_b: 4, sill_cover: 1 })
    expect(validateCorners(m)).toEqual([])
    expect(m.names.sill_cover).toBe('ตบธรณี')
  })
  it('2400 x 1200: rail (2400 - 90 + 80) / 4 = 597.5; sill_cover 1200 square', () => {
    const r = runWith(slidingModel('sliding_2_fixed_2', null, { stile_b: 'H' }), 2400, 1200, b45ov40)
    expect(r.issues).toEqual([])
    const top = r.row('บานเลื่อนบน')[0]
    expect(top.quantity_value).toBe(4)
    expect(top.length_factor).toBe(0.25)
    expect(r.len(top) + top.end_deduction_mm).toBeCloseTo(597.5, 6)
    const sill = r.row('ตบธรณี')[0]
    expect(r.len(sill)).toBeCloseTo(1200, 6)
    expect(sill.cut_style).toBe('square')
    expect(sill.quantity_value).toBe(1)
  })
  it('track [2,1,1,2], fixed [true,false,false,true]', () => {
    const m = m0()
    expect([0, 1, 2, 3].map((i) => trackOf(m, 'sash', i))).toEqual([2, 1, 1, 2])
    expect([0, 1, 2, 3].map((i) => isFixedPiece(m, 'sash', i))).toEqual([true, false, false, true])
  })
  it('pieceLabel: piece-dependent stile names (D10 order), fallbacks', () => {
    const m = m0()
    expect(pieceLabel(m, 'stile_b', 1)).toBe('เสากุญแจตัวผู้')
    expect([0, 1, 2, 3].map((i) => pieceLabel(m, 'stile_a', i))).toEqual(['เสากุญแจ', 'เสาเกี่ยว', 'เสากุญแจตัวเมีย', 'เสาเกี่ยว'])
    expect(pieceLabel(m, 'frame_side', 1)).toBe('ขวา')       // position labels
    expect(pieceLabel(m, 'sash_top', 2)).toBe('บานเลื่อนบน 3') // name + index when per x count > 1
    expect(pieceLabel(m, 'sill_cover', 0)).toBe('ตบธรณี')      // single piece: just the name
  })
  it('Excel type 2 (W 3300, H 1000, b 0, ov 0): stile lengths sum 8 x 1000 = 8000', () => {
    // Excel lists เสากุญแจ 2H + เสาเกี่ยว 4H + เสาตาย 2H = 8H; here the same aluminium is 4 stile_a + 4 stile_b
    // (same lengths, different names), so only the total is comparable.
    const r = runWith(slidingModel('sliding_2_fixed_2'), 3300, 1000, () => 0)
    expect(r.issues).toEqual([])
    const stiles = r.components.filter((c) => c.length_rule_type === 'height_minus')
    const total = stiles.reduce((s, c) => s + c.quantity_value * r.len(c), 0)
    expect(total).toBeCloseTo(8000, 6)
  })
})

// ---------------------------------------------------------------- doors (Task 6)
import { glassParts } from '../partModel.js'
import { evalExpr } from '../layoutExpr.js'
import { exprParams } from '../layoutRegistry.js'

const doorModel = (kind, patch) => { let m = startModel(kind, defaultParams(kind, {})); if (patch) m = setParams(m, patch); return fill(m) }

describe('swing_door', () => {
  const rows = (m) => run(m, 1800, 2100)
  it('snapshot: keys, counts, families, params', () => {
    const m = startModel('swing_door', defaultParams('swing_door', {}))
    expect(Object.keys(m.lines)).toEqual(['frame_top', 'sill', 'frame_side', 'leaf_stile_hinge', 'leaf_stile_handle', 'leaf_rail_top', 'leaf_rail_bottom'])
    expect(m.params).toEqual({ leaves: 1, hinge: 'left', open: 'out', sill: 'yes', pivot: false })
    expect(counts(m)).toEqual({ frame_top: 1, sill: 1, frame_side: 2, leaf_stile_hinge: 1, leaf_stile_handle: 1, leaf_rail_top: 1, leaf_rail_bottom: 1 })
    expect(m.lines.frame_top[0].profile_family).toBe('กล่องแจ็คสัน')
    expect(m.lines.leaf_stile_hinge[0].profile_family).toBe('เสาประตูสวิง')
    expect(m.lines.leaf_rail_top[0].profile_family).toBe('เสาบนสวิง')
    expect(m.lines.leaf_rail_bottom[0].profile_family).toBe('เสาล่างสวิง')
    expect(m.lines.sill[0].profile_family).toBe('ธรณีสวิง')
    expect(validateCorners(m)).toEqual([])
  })
  it('input definitions', () => {
    const by = Object.fromEntries(LAYOUTS.swing_door.inputs.map((i) => [i.key, i]))
    expect([by.leaves.min, by.leaves.max, by.leaves.default, by.leaves.estimator, by.leaves.fixed_by_type]).toEqual([1, 2, 1, true, true])
    expect(by.hinge.only_when).toEqual({ leaves: 1 })
    expect([by.pivot.type, by.pivot.fixed_by_type, by.pivot.default]).toEqual(['boolean', true, false])
    expect(by.sill.default).toBe('yes')
    expect(defaultParams('swing_door', { leaves: 2, pivot: true })).toMatchObject({ leaves: 2, pivot: true })
  })
  it('leaves 2, sill yes, 1800 x 2100, b 45: rails 855 (qty 2 each), stiles 2010', () => {
    const m = doorModel('swing_door', { leaves: 2 })
    const r = rows(m)
    expect(r.issues).toEqual([])
    for (const name of ['เสาบนสวิง', 'เสาล่างสวิง'].map((_, i) => m.names[['leaf_rail_top', 'leaf_rail_bottom'][i]])) {
      const c = r.row(name)[0]
      expect(c.quantity_value).toBe(2)
      expect(r6(r.len(c) + c.end_deduction_mm)).toBe(855)
    }
    for (const k of ['leaf_stile_hinge', 'leaf_stile_handle']) {
      const c = r.row(m.names[k])[0]
      expect(c.quantity_value).toBe(2)
      expect(r6(r.len(c))).toBe(2010)
    }
    expect(r6(r.len(r.row(m.names.frame_side)[0]))).toBe(2100)
    expect(r.row(m.names.sill)).toHaveLength(1)
  })
  it('sill no: stiles 2055 and no sill row; toggling back restores 2010', () => {
    let m = doorModel('swing_door', { leaves: 2, sill: 'no' })
    let r = rows(m)
    expect(r.issues).toEqual([])
    expect(r.components.map((c) => c.role_name)).not.toContain('ธรณี (วงกบล่าง)')
    expect(r6(r.len(r.row(m.names.leaf_stile_hinge)[0]))).toBe(2055)
    m = fill(setParams(m, { sill: 'yes' }))
    r = rows(m)
    expect(r.issues).toEqual([])
    expect(r6(r.len(r.row(m.names.leaf_stile_hinge)[0]))).toBe(2010)
    expect(r.row('ธรณี (วงกบล่าง)')).toHaveLength(1)
  })
  it('doors are butt-jointed (D15): stiles run through, rails butt, frame top butts into the sides', () => {
    const m = doorModel('swing_door')
    expect(m.lines.leaf_stile_hinge[0].ends[0].map((e) => e.mode)).toEqual(['through', 'through'])
    expect(m.lines.leaf_rail_top[0].ends[0].map((e) => e.mode)).toEqual(['butt', 'butt'])
    expect(m.lines.frame_top[0].ends[0].map((e) => e.mode)).toEqual(['butt', 'butt'])
    expect(LAYOUTS.swing_door.parts.every((p) => p.corner === 'butt')).toBe(true)
  })
  it('hardware sets by pivot (qty expressions), v_hinge symbol', () => {
    const hw = (params) => LAYOUTS.swing_door.hardware.map((h) => [h.name, h.per, evalExpr(h.qty, exprParams({ params }))]).filter(([, , q]) => q > 0)
    expect(hw({ pivot: false })).toEqual([['บานพับ', 'sash', 3], ['มือจับ', 'sash', 1]])
    expect(hw({ pivot: true })).toEqual([['door closer ฝังวงกบบน', 'sash', 1], ['เดือยบน/ล่าง', 'sash', 2], ['มือจับ', 'sash', 1]])
    expect(symbolFor(startModel('swing_door', defaultParams('swing_door', {})), 'leaf', 0)).toEqual({ kind: 'v_hinge', hinge: 'left' })
    const two = doorModel('swing_door', { leaves: 2 })
    expect([0, 1].map((i) => symbolFor(two, 'leaf', i).hinge)).toEqual(['left', 'right'])
  })
})

describe('frameless_door', () => {
  it('snapshot: only the frame has aluminium positions', () => {
    const m = startModel('frameless_door', defaultParams('frameless_door', {}))
    expect(Object.keys(m.lines)).toEqual(['frame_top', 'frame_side'])
    expect(m.params).toEqual({ leaves: 1, hinge: 'left', open: 'out' })
    expect(LAYOUTS.frameless_door.parts.find((p) => p.key === 'leaf')).toMatchObject({ glass: true, count: 'leaves', positions: [] })
    expect(LAYOUTS.frameless_door.inputs.find((i) => i.key === 'leaves').fixed_by_type).toBe(true)
  })
  it('three aluminium pieces: sides x 2 and top; glassParts: 2 leaves of 855 at 1800', () => {
    const m = doorModel('frameless_door', { leaves: 2 })
    const r = run(m, 1800, 2100)
    expect(r.issues).toEqual([])
    expect(r.components.map((c) => [c.role_name, c.quantity_value])).toEqual([['เฟรมบน', 1], ['เฟรมข้าง', 2]])
    expect(r.components.reduce((s, c) => s + c.quantity_value, 0)).toBe(3)
    expect(glassParts(m, { widthMm: 1800, buttOf }).map((g) => [g.part, g.idx, g.widthMm])).toEqual([['leaf', 0, 855], ['leaf', 1, 855]])
  })
  it('hardware per leaf: patch fitting 2, floor spring 1, stainless handle 1, floor lock 1', () => {
    expect(LAYOUTS.frameless_door.hardware.map((h) => [h.name, h.qty])).toEqual([['patch fitting', 2], ['floor spring', 1], ['มือจับสแตนเลส', 1], ['กุญแจล็อคพื้น', 1]])
    expect(LAYOUTS.frameless_door.hardware.every((h) => h.per === 'sash')).toBe(true)
  })
})

describe('hanging_door', () => {
  it('snapshot', () => {
    const m = startModel('hanging_door', defaultParams('hanging_door', {}))
    expect(Object.keys(m.lines)).toEqual(['track_rail', 'track_cover', 'frame_side', 'leaf_stile_a', 'leaf_stile_b', 'leaf_rail_top', 'leaf_rail_bottom'])
    expect(m.params).toEqual({ leaves: 1 })
    expect(m.lines.track_rail[0].profile_family).toBe('รางแขวนใหญ่')
    expect(m.lines.track_cover[0].profile_family).toBe('กล่อง 1-3/4')
    expect(validateCorners(m)).toEqual([])
  })
  it('leaves 1, W 2400: track_rail 4800 (factor 2), cover 4800', () => {
    const m = doorModel('hanging_door')
    const r = run(m, 2400, 2100)
    expect(r.issues).toEqual([])
    expect(r6(r.len(r.row(m.names.track_rail)[0]))).toBe(4800)
    expect(r6(r.len(r.row(m.names.track_cover)[0]))).toBe(4800)
  })
  it('frame_side = H - b(track_rail) once; rails (W - 2 b(frame_side)) / leaves', () => {
    const m = doorModel('hanging_door', { leaves: 2 })
    const r = run(m, 2400, 2100)
    expect(r.issues).toEqual([])
    expect(r6(r.len(r.row(m.names.frame_side)[0]))).toBe(2055)
    const rail = r.row(m.names.leaf_rail_top)[0]
    expect(rail.quantity_value).toBe(2)
    expect(r6(r.len(rail) + rail.end_deduction_mm)).toBe(1155)
  })
  it('hardware and symbol', () => {
    expect(LAYOUTS.hanging_door.hardware).toEqual([{ name: 'ลูกล้อรางแขวน', per: 'sash', qty: 2 }, { name: 'ไกด์พื้น', per: 'unit', qty: 1 }])
    expect(symbolFor(startModel('hanging_door', defaultParams('hanging_door', {})), 'leaf', 0).kind).toBe('slide')
  })
})

describe('folding_door', () => {
  const buttTrack = (f) => (f === 'รางบน' || f === 'รางล่าง (ยูฝังพื้น)' ? 60 : 45)
  const fold = (patch) => doorModel('folding_door', patch)
  it('snapshot: nL 2 nR 2, 4 leaves', () => {
    const m = startModel('folding_door', defaultParams('folding_door', {}))
    expect(m.params).toEqual({ nL: 2, nR: 2 })
    expect(Object.keys(m.lines)).toEqual(['track_top', 'track_bottom', 'track_side', 'leaf_top', 'leaf_bottom', 'leaf_side', 'leaf_cover_v', 'leaf_cover_h'])
    expect(counts(m)).toMatchObject({ track_top: 1, track_bottom: 1, track_side: 2, leaf_top: 4, leaf_bottom: 4, leaf_side: 8, leaf_cover_v: 8, leaf_cover_h: 8 })
    expect(m.lines.track_top[0].profile_family).toBe('รางบน')
    expect(m.lines.track_bottom[0].profile_family).toBe('รางล่าง (ยูฝังพื้น)')
    expect(validateCorners(m)).toEqual([])
  })
  it('nL 2 nR 2, W 3000 H 2400, b 45 (tracks 60): leaf width 727.5, leaf_side 2280', () => {
    const m = fold()
    const r = runWith(m, 3000, 2400, buttTrack)
    expect(r.issues).toEqual([])
    const top = r.row(m.names.leaf_top)[0]
    expect(top.quantity_value).toBe(4)
    expect(r6(r.len(top) + top.end_deduction_mm)).toBe(727.5)
    const side = r.row(m.names.leaf_side)[0]
    expect(side.quantity_value).toBe(8)
    expect(r6(r.len(side))).toBe(2280)
    expect(r6(r.len(r.row(m.names.track_side)[0]))).toBe(2280)
  })
  it('the two free lines carry the leaf member rules and no corner partner', () => {
    const m = fold()
    expect(m.lines.leaf_cover_v[0]).toMatchObject({ length_rule_type: 'height_minus', deduction_auto: true })
    expect(m.lines.leaf_cover_h[0]).toMatchObject({ length_rule_type: 'width_minus', deduction_auto: true, length_factor: 0.25 })
    expect(m.lines.leaf_cover_v[0].ends[0].map((e) => e.mode)).toEqual(['through', 'through'])
    const r = runWith(m, 3000, 2400, buttTrack)
    expect(r6(r.len(r.row(m.names.leaf_cover_v)[0]))).toBe(2280)
  })
  it('nL 0 nR 0 throws layout_params_invalid; one side only works (factor 1/(nL+nR))', () => {
    expect(() => startModel('folding_door', { nL: 0, nR: 0 })).toThrow('layout_params_invalid')
    const m = fold({ nL: 3, nR: 0 })
    expect(m.lines.leaf_top[0].length_factor).toBeCloseTo(1 / 3, 12)
    expect(counts(m).leaf_top).toBe(3)
  })
  it('input definitions: nL, nR 0-6 default 2 estimator', () => {
    for (const k of ['nL', 'nR']) {
      const i = LAYOUTS.folding_door.inputs.find((x) => x.key === k)
      expect([i.min, i.max, i.default, i.estimator, i.integer]).toEqual([0, 5, 2, true, true])
    }
    expect(LAYOUTS.folding_door.validParams).toBe('nL+nR')
  })
  it('hardware quantities by side counts', () => {
    const hw = (nL, nR) => Object.fromEntries(LAYOUTS.folding_door.hardware.map((h) => [h.name, evalExpr(h.qty, { nL, nR })]))
    expect(hw(2, 2)).toEqual({ 'ล้อบน/ล่างบานเฟี้ยม': 4, บานพับ: 6, บานพับวงกบ: 6, มือจับ: 2 })
    expect(hw(3, 0)).toEqual({ 'ล้อบน/ล่างบานเฟี้ยม': 4, บานพับ: 6, บานพับวงกบ: 3, มือจับ: 1 })
    expect(hw(1, 0)).toEqual({ 'ล้อบน/ล่างบานเฟี้ยม': 2, บานพับ: 0, บานพับวงกบ: 3, มือจับ: 1 })
    expect(symbolFor(fold(), 'leaf', 0).kind).toBe('fold')
  })
})

describe('folding_door leaf cap (R-6b)', () => {
  it('nL, nR max 5 so the sum never exceeds MAX_PART_COUNT: 5+5 gives 10 leaves with factor 1/10', () => {
    const m = doorModel('folding_door', { nL: 5, nR: 5 })
    expect(counts(m).leaf_top).toBe(10)
    expect(m.lines.leaf_top[0].length_factor).toBeCloseTo(0.1, 12)
    const r = run(m, 5000, 2400)
    const top = r.row(m.names.leaf_top)[0]
    expect(top.quantity_value).toBe(10)
    expect(r6(r.len(top) + top.end_deduction_mm)).toBe(r6((5000 - 90) / 10))
    expect(defaultParams('folding_door', { nL: 6, nR: 6 })).toEqual({ nL: 2, nR: 2 })   // not fixed_by_type: type params are ignored
  })
})

describe('every registered layout passes validateLayout', () => {
  it('all 11', () => {
    const real = ['sliding_2', 'fixed_grid', 'awning_grid', 'casement_n', 'sliding_n', 'sliding_3track', 'sliding_2_fixed_2', 'swing_door', 'frameless_door', 'hanging_door', 'folding_door']
    for (const k of real) { expect(kinds()).toContain(k); expect([k, validateLayout(LAYOUTS[k])]).toEqual([k, []]) }
  })
})
