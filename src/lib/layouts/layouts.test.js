import { describe, it, expect } from 'vitest'
import { defaultParams, kinds, LAYOUTS, validateLayout } from '../layoutRegistry.js'
import { panelCells, jointCount } from '../layoutCells.js'
import { startModel, validateCorners, pieceCount, setParams, trackOf, isFixedPiece, pieceLabel, sequenceOf } from '../partModel.js'
import { expandParts } from '../partExpand.js'
import { computeComponentLength } from '../bomEngine.js'
import { symbolFor } from '../partSymbols.js'
import { overviewSpecs } from '../partGeometry.js'

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

// R-F1 (spec §5.4/§5.5): the sashes are three parts; per-family stile totals are 2 key + 2(n−1) hook.
// Families by role: K = key stile, H = hook stile (butt 40 = ov), R = rail; the middle / right / front positions inherit them.
const SN_FAM = { left_key_stile: 'K', left_hook_stile: 'H', left_top: 'R', left_bottom: 'R' }
const S3_FAM = { fixed_key_stile: 'K', fixed_hook_stile: 'H', fixed_top: 'R', fixed_bottom: 'R' }
const famModel = (kind, patch, fams) => {
  let m = startModel(kind, defaultParams(kind, {}))
  if (patch) m = setParams(m, patch)
  for (const [k, ls] of Object.entries(m.lines)) for (const l of ls) l.profile_family = fams[k] || (LAYOUTS[kind].positions[k].rule.familyFrom ? '' : l.profile_family || 'F')
  return m
}
// per-family totals: { family: { pieces, mm } } over the expanded rows
const perFamily = (r) => {
  const out = {}
  for (const c of r.components) {
    const f = (out[c.profile_family] = out[c.profile_family] || { pieces: 0, mm: 0 })
    f.pieces += c.quantity_value
    f.mm = r6(f.mm + c.quantity_value * r.len(c))
  }
  return out
}

describe('sliding_n', () => {
  it('snapshot (n 2): frame keys of sliding_2, three sash parts (left / middle n−2 / right), middle has no pieces', () => {
    const m = startModel('sliding_n', defaultParams('sliding_n', {}))
    expect(m.params).toEqual({ n: 2, door: false })
    expect(m.parts.map((p) => [p.key, p.name, p.count])).toEqual([['frame', 'วงกบ', 1], ['sash_left', 'บานซ้าย', 1], ['sash_mid', 'บานกลาง', 'n-2'], ['sash_right', 'บานขวา', 1]])
    expect(counts(m)).toEqual({
      frame_top: 1, frame_bottom: 1, frame_side: 2,
      left_top: 1, left_bottom: 1, left_key_stile: 1, left_hook_stile: 1,
      mid_top: 0, mid_bottom: 0, mid_hook_a: 0, mid_hook_b: 0,
      right_top: 1, right_bottom: 1, right_hook_stile: 1, right_key_stile: 1,
    })
    expect(validateCorners(m)).toEqual([])
    expect(pieceCount(setParams(m, { n: 6 }), 'mid_top')).toBe(4)
    expect(LAYOUTS.sliding_n.roles.hook).toBe('left_hook_stile')
  })
  it('n 2 keeps sliding_2\'s per-family totals at 1800 x 1200 (1723.8 / 1200 / 824.4 / 1126.1)', () => {
    // adjusted (final fix wave, R-F1): the rows are now per part, so the old toEqual(components) becomes per-family totals
    const FAM = { frame_top: 'FT', frame_bottom: 'FB', frame_side: 'FS', left_top: 'ST', left_bottom: 'SB', left_key_stile: 'KS', left_hook_stile: 'HS' }
    const bo = (f) => (f in BUTT ? BUTT[f] : null)
    const a = runWith(famModel('sliding_n', null, FAM), 1800, 1200, bo)
    const b = (() => { const m = startModel('sliding_2'); for (const [k, f] of Object.entries({ frame_top: 'FT', frame_bottom: 'FB', frame_side: 'FS', sash_top: 'ST', sash_bottom: 'SB', key_stile: 'KS', hook_stile: 'HS' })) m.lines[k][0].profile_family = f; return runWith(m, 1800, 1200, bo) })()
    expect(a.issues).toEqual([])
    expect(perFamily(a)).toEqual(perFamily(b))
    expect(Object.keys(perFamily(a)).sort()).toEqual(['FB', 'FS', 'FT', 'HS', 'KS', 'SB', 'ST'])
    expect(a.len(a.row('เฟรมบน')[0])).toBeCloseTo(1723.8, 6)
    expect(a.len(a.row('เฟรมข้าง')[0])).toBeCloseTo(1200, 6)
    expect(a.len(a.row('บานเลื่อนบน (บานซ้าย)')[0])).toBeCloseTo(824.4, 6)
    expect(a.len(a.row('บานเลื่อนบน (บานขวา)')[0])).toBeCloseTo(824.4, 6)
    expect(a.len(a.row('เสากุญแจ (บานซ้าย)')[0])).toBeCloseTo(1126.1, 6)
    expect(a.len(a.row('เสากุญแจ (บานขวา)')[0])).toBeCloseTo(1126.1, 6)
  })
  it('n 3 at 2700 x 1200, ov 40, b 45: rail (2700 - 90 + 80) / 3 = 896.67, 3 rails each, key 2 / hook 4', () => {
    const r = runWith(famModel('sliding_n', { n: 3 }, SN_FAM), 2700, 1200, b45ov40)
    expect(r.issues).toEqual([])
    const tops = r.components.filter((c) => c.role_name.startsWith('บานเลื่อนบน'))
    expect(tops.reduce((s, c) => s + c.quantity_value, 0)).toBe(3)
    for (const top of tops) {
      expect(top.length_deduction_mm).toBe(10)   // 90 - 2 x 40
      expect(top.length_factor).toBeCloseTo(1 / 3, 9)
      expect(r6(r.len(top) + top.end_deduction_mm)).toBe(r6(2690 / 3))
    }
    expect(r6(2690 / 3)).toBe(896.666667)
    const fam = perFamily(r)
    expect([fam.K.pieces, fam.H.pieces, fam.R.pieces]).toEqual([2, 4, 6])
  })
  it('n 4: key 2 / hook 6; n 2: key 2 / hook 2; n 6: key 2 / hook 10', () => {
    for (const [n, hook] of [[2, 2], [4, 6], [6, 10]]) {
      const fam = perFamily(runWith(famModel('sliding_n', { n }, SN_FAM), 2700, 1200, b45ov40))
      expect([n, fam.K.pieces, fam.H.pieces, fam.R.pieces]).toEqual([n, 2, hook, 2 * n])
    }
  })
  it('the middle / right sashes follow the left sash\'s families until the owner picks their own (familyFrom)', () => {
    const m = famModel('sliding_n', { n: 3 }, { ...SN_FAM, mid_hook_b: 'H2' })
    const r = runWith(m, 2700, 1200, (f) => ({ H: 40, H2: 40 }[f] ?? 45))
    expect(r.issues).toEqual([])
    const fam = perFamily(r)
    expect([fam.K.pieces, fam.H.pieces, fam.H2.pieces]).toEqual([2, 3, 1])
  })
  it('trackOf alternates 1,2,1,2 along the row and no piece is fixed', () => {
    const m = slidingModel('sliding_n', { n: 4 })
    const row = [['sash_left', 0], ['sash_mid', 0], ['sash_mid', 1], ['sash_right', 0]]
    expect(row.map(([p, i]) => trackOf(m, p, i))).toEqual([1, 2, 1, 2])
    expect(row.map(([p, i]) => isFixedPiece(m, p, i))).toEqual([false, false, false, false])
    expect(trackOf(slidingModel('sliding_n', { n: 3 }), 'sash_right', 0)).toBe(1)
    expect(trackOf(m, 'frame', 0)).toBe(1)
  })
  it('door: true renames frame_bottom / frame_top; hardware and symbol', () => {
    const d = startModel('sliding_n', { door: true })
    expect(d.names.frame_bottom).toBe('รางล่าง (ธรณี)')
    expect(d.names.frame_top).toBe('รางบน')
    const w = startModel('sliding_n', defaultParams('sliding_n', {}))
    expect(w.names.frame_bottom).toBe('เฟรมล่าง')
    expect(LAYOUTS_HW('sliding_n')).toEqual([{ name: 'ลูกล้อ', per: 'sash', qty: 2 }, { name: 'กุญแจ/มือจับ', per: 'unit', qty: 1 }])
    expect(symbolFor(w, 'sash_left', 0).kind).toBe('slide')
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
  it('snapshot: fixed / middle / front parts, frame names and families, params', () => {
    const m = startModel('sliding_3track', defaultParams('sliding_3track', {}))
    expect(m.params).toEqual({ fixed_side: 'left' })
    expect(m.parts.map((p) => [p.key, p.name])).toEqual([['frame', 'วงกบ'], ['sash_fixed', 'บานฟิก'], ['sash_middle', 'บานกลาง'], ['sash_front', 'บานหน้า']])
    expect(['fixed_top', 'middle_top', 'front_top'].map((k) => counts(m)[k])).toEqual([1, 1, 1])
    expect(m.names.frame_top).toBe('เฟรมบน (3 ราง)')
    expect(m.names.frame_bottom).toBe('เฟรมล่าง (3 ราง)')
    expect(m.lines.frame_top[0].profile_family).toBe('รางบนบิ๊กเฟรม')
    expect(m.lines.frame_bottom[0].profile_family).toBe('รางล่างบิ๊กเฟรม 2 ราง')
    expect(validateCorners(m)).toEqual([])
  })
  it('same rails as sliding_n 3 at 2700 x 1200 (ov 40, b 45): 896.67; key 2 / hook 4 (mirrored too)', () => {
    for (const fixed_side of ['left', 'right']) {
      const r = runWith(famModel('sliding_3track', { fixed_side }, S3_FAM), 2700, 1200, b45ov40)
      expect(r.issues).toEqual([])
      const tops = r.components.filter((c) => c.role_name.startsWith('บานเลื่อนบน'))
      expect(tops.reduce((s, c) => s + c.quantity_value, 0)).toBe(3)
      for (const top of tops) expect(r6(r.len(top) + top.end_deduction_mm)).toBe(r6(2690 / 3))
      const fam = perFamily(r)
      expect([fixed_side, fam.K.pieces, fam.H.pieces, fam.R.pieces]).toEqual([fixed_side, 2, 4, 6])
    }
  })
  it('stiles per sash (spec §5.5): fixed = key + hook, middle = hook + hook, front = hook + key', () => {
    const P = LAYOUTS.sliding_3track.parts.map((p) => [p.key, p.positions.filter((k) => LAYOUTS.sliding_3track.positions[k].orient === 'v')])
    expect(P.slice(1)).toEqual([['sash_fixed', ['fixed_key_stile', 'fixed_hook_stile']], ['sash_middle', ['middle_hook_a', 'middle_hook_b']], ['sash_front', ['front_hook_stile', 'front_key_stile']]])
  })
  it('tracks 3 / 2 / 1 and the fixed sash; the row reverses when fixed_side = right', () => {
    const m = startModel('sliding_3track', defaultParams('sliding_3track', {}))
    expect(['sash_fixed', 'sash_middle', 'sash_front'].map((p) => trackOf(m, p, 0))).toEqual([3, 2, 1])
    expect(['sash_fixed', 'sash_middle', 'sash_front'].map((p) => isFixedPiece(m, p, 0))).toEqual([true, false, false])
    expect(sequenceOf(m).map((x) => x.part)).toEqual(['sash_fixed', 'sash_middle', 'sash_front'])
    const r = setParams(m, { fixed_side: 'right' })
    expect(sequenceOf(r).map((x) => x.part)).toEqual(['sash_front', 'sash_middle', 'sash_fixed'])
    expect(sequenceOf(r).map((x) => trackOf(r, x.part, x.idx))).toEqual([1, 2, 3])
    expect(isFixedPiece(r, 'sash_fixed', 0)).toBe(true)
  })
  it('hardware: wheels 2 x 2 on the sliding sashes, 3 rails (info), symbol slide', () => {
    expect(LAYOUTS_HW('sliding_3track')).toEqual(expect.arrayContaining([{ name: 'ลูกล้อ', per: 'unit', qty: '2*2' }, { name: 'ราง', per: 'unit', qty: 3 }]))
    expect(symbolFor(startModel('sliding_3track', defaultParams('sliding_3track', {})), 'sash_middle', 0).kind).toBe('slide')
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
import { glassParts, cycleCellKind } from '../partModel.js'
import { evalExpr } from '../layoutExpr.js'
import { exprParams } from '../layoutRegistry.js'

const doorModel = (kind, patch) => { let m = startModel(kind, defaultParams(kind, {})); if (patch) m = setParams(m, patch); return fill(m) }

describe('swing_door', () => {
  const rows = (m) => run(m, 1800, 2100)
  it('snapshot: keys, counts, families, params', () => {
    const m = startModel('swing_door', defaultParams('swing_door', {}))
    // adjusted (final fix wave, I5): + the door beads คิ้วประตู (free lines, 2 vertical + 2 horizontal per leaf)
    expect(Object.keys(m.lines)).toEqual(['frame_top', 'sill', 'frame_side', 'leaf_stile_hinge', 'leaf_stile_handle', 'leaf_rail_top', 'leaf_rail_bottom', 'leaf_bead_v', 'leaf_bead_h'])
    expect(m.params).toEqual({ leaves: 1, hinge: 'left', open: 'out', sill: 'yes', pivot: false })
    expect(counts(m)).toEqual({ frame_top: 1, sill: 1, frame_side: 2, leaf_stile_hinge: 1, leaf_stile_handle: 1, leaf_rail_top: 1, leaf_rail_bottom: 1, leaf_bead_v: 2, leaf_bead_h: 2 })
    expect([m.lines.leaf_bead_v[0].profile_family, m.lines.leaf_bead_h[0].profile_family]).toEqual(['คิ้วประตู', 'คิ้วประตู'])
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
    // คิ้วประตู ×4 per leaf (I5): 2 × 2 along the stiles (2010, through) and 2 × 2 along the rails (leaf width 855)
    const bv = r.row(m.names.leaf_bead_v)[0], bh = r.row(m.names.leaf_bead_h)[0]
    expect([bv.quantity_value, r6(r.len(bv)), bv.profile_family]).toEqual([4, 2010, 'คิ้วประตู'])
    expect([bh.quantity_value, r6(r.len(bh)), bh.end_deduction_mm]).toEqual([4, 855, 0])
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
  // Owner 2026-10-16 (Q1 answer ก, D1): at the track frame's corners the top / bottom tracks run through (full W) and the
  // side tracks butt between them (H − b(top) − b(bottom)). Before the fix BOTH were shortened (top/bottom W − 2·b(side)).
  // The drawing reads the same stored end modes, so it must agree: top/bottom drawn over the full width, sides between them.
  it('owner 2026-10-16 (D1): top/bottom tracks run through, side tracks butt; costing and drawing agree', () => {
    const m = fold()
    expect(m.lines.track_top[0].ends[0].map((e) => e.mode)).toEqual(['through', 'through'])
    expect(m.lines.track_bottom[0].ends[0].map((e) => e.mode)).toEqual(['through', 'through'])
    expect(m.lines.track_side[0].ends.map((p) => p.map((e) => e.mode))).toEqual([['butt', 'butt'], ['butt', 'butt']])
    expect(validateCorners(m)).toEqual([])
    const r = runWith(m, 3000, 2400, buttTrack)
    expect(r.issues).toEqual([])
    expect(r6(r.len(r.row(m.names.track_top)[0]))).toBe(3000)
    expect(r6(r.len(r.row(m.names.track_bottom)[0]))).toBe(3000)
    const side = r.row(m.names.track_side)[0]
    expect(side.quantity_value).toBe(2)
    expect(r6(r.len(side))).toBe(2280)   // 2400 − 60 − 60, deducted once (end deductions), not twice
    const o = overviewSpecs({ model: m, widthMm: 3000, heightMm: 2400 })
    const mm = (p) => ({ x: (p.x - o.box.frameX) / o.box.scale, y: (p.y - o.box.frameY) / o.box.scale, w: p.w / o.box.scale, h: p.h / o.box.scale })
    const top = mm(o.pieces.find((p) => p.key === 'track_top'))
    expect(top.x).toBeCloseTo(0, 6)
    expect(top.w).toBeCloseTo(3000, 6)
    const sides = o.pieces.filter((p) => p.key === 'track_side').map(mm)
    const tTop = mm(o.pieces.find((p) => p.key === 'track_top')).h, tBot = mm(o.pieces.find((p) => p.key === 'track_bottom')).h
    for (const s of sides) {
      expect(s.y).toBeCloseTo(tTop, 6)
      expect(s.h).toBeCloseTo(2400 - tTop - tBot, 6)
    }
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
  it('all 13', () => {
    const real = ['sliding_2', 'fixed_grid', 'awning_grid', 'casement_n', 'sliding_n', 'sliding_3track', 'sliding_2_fixed_2', 'swing_door', 'frameless_door', 'hanging_door', 'folding_door', 'curtain_wall', 'frameless_wall']
    for (const k of real) { expect(kinds()).toContain(k); expect([k, validateLayout(LAYOUTS[k])]).toEqual([k, []]) }
  })
})

describe('curtain_wall and frameless_wall (Task 7)', () => {
  const W = { 'NO.9010': 65, 'NO.9023': 65 }
  const wOf = (f) => W[f] ?? 65
  const bZero = () => 0
  const runCw = (m, wm, hm) => {
    const { components, issues } = expandParts({ model: m, buttOf: bZero, widthOf: wOf })
    const row = (name) => components.filter((c) => c.role_name === name)
    const len = (c) => computeComponentLength(c.length_rule_type, c.length_deduction_mm, wm / 1000, hm / 1000, c.length_factor, c.end_deduction_mm) * 1000
    return { components, issues, row, len }
  }
  const cw = (patch) => setParams(startModel('curtain_wall', defaultParams('curtain_wall', {})), patch || {})

  it('snapshot: defaults rows 3 cols 4, line keys and piece counts', () => {
    const m = cw()
    expect(m.params).toEqual({ rows: 3, cols: 4, spandrel: 'none', cells: {}, k: 0.5, unitized: false })
    expect(Object.keys(m.lines)).toEqual(['mullion', 'transom', 'plate_w', 'plate_h', 'cover_w', 'cover_h', 'sash_top', 'sash_bottom', 'sash_side'])
    expect(counts(m)).toEqual({ mullion: 5, transom: 16, plate_w: 1, plate_h: 1, cover_w: 1, cover_h: 1, sash_top: 0, sash_bottom: 0, sash_side: 0 })
    expect(m.lines.mullion[0].profile_family).toBe('NO.9010')
    expect(m.lines.transom[0].profile_family).toBe('NO.9023')
    expect(validateCorners(m)).toEqual([])
    expect(defaultParams('curtain_wall', {}).cells).not.toBe(defaultParams('curtain_wall', {}).cells)   // defaults are not shared
  })
  it('3600 x 3000: mullions 5 x 3000, transoms (rows+1)*cols = 16 x 818.75 (brief says 12 = rows*cols; per expression wins), no sash rows without awning cells', () => {
    const r = runCw(fill(cw()), 3600, 3000)
    expect(r.issues).toEqual([])
    const mu = r.row('เสา mullion')[0]
    expect([mu.quantity_value, r6(r.len(mu))]).toEqual([5, 3000])
    const tr = r.row('ราว transom')[0]
    expect([tr.quantity_value, r6(r.len(tr))]).toEqual([16, 818.75])
    expect(r.components.some((c) => c.cut_style === 'miter45')).toBe(false)
  })
  it('one awning cell: rails 818.75 (x1 each), sides (3000 - 4 x 65)/3 = 913.33 (x2), mitred', () => {
    const m = fill(cycleCellKind(cw(), 1, 2))
    const r = runCw(m, 3600, 3000)
    expect(r.issues).toEqual([])
    const top = r.row(m.names.sash_top)[0]
    const bot = r.row(m.names.sash_bottom)[0]
    const side = r.row(m.names.sash_side)[0]
    expect([top.quantity_value, bot.quantity_value, side.quantity_value]).toEqual([1, 1, 2])
    expect([r6(r.len(top)), r6(r.len(bot))]).toEqual([818.75, 818.75])
    expect(r.len(side)).toBeCloseTo(913.3333, 3)
    expect([top, bot, side].map((c) => c.cut_style)).toEqual(['miter45', 'miter45', 'miter45'])
    expect(validateCorners(m)).toEqual([])
  })
  it('three awning cells: sash quantities follow cells_awning; hardware 2 + 1 per awning cell', () => {
    let m = cw()
    for (const [r, c] of [[0, 0], [1, 1], [2, 3]]) m = cycleCellKind(m, r, c)
    const r = runCw(fill(m), 3600, 3000)
    expect(r.row(m.names.sash_side)[0].quantity_value).toBe(6)
    expect(r.row(m.names.sash_top)[0].quantity_value).toBe(3)
    const hw = Object.fromEntries(LAYOUTS.curtain_wall.hardware.map((h) => [h.name, evalExpr(h.qty, exprParams(m))]))
    expect(hw).toEqual({ แขนค้ำกระทุ้ง: 6, มือจับ: 3 })
  })
  it('awning cells above MAX_PART_COUNT clamp to 10 sashes', () => {
    let m = cw({ rows: 4, cols: 4 })
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) m = cycleCellKind(m, r, c)
    expect(exprParams(m).cells_awning).toBe(16)
    expect(pieceCount(m, 'sash_top')).toBe(10)
  })
  it('spandrel top: 4 panel cells, spandrel part has no positions and is not glass; no aluminium rows from it', () => {
    const m = cw({ spandrel: 'top' })
    expect(panelCells(m)).toHaveLength(4)
    const p = LAYOUTS.curtain_wall.parts.find((x) => x.key === 'spandrel')
    expect(p).toMatchObject({ panel: true, glass: false, count: 'cells_spandrel', positions: [] })
    expect(exprParams(m).cells_spandrel).toBe(4)
    expect(glassParts(m)).toEqual([])
  })
  it('pressure plate and cover: width line (R+1)(1-k) and height line (C+1)(1-k); sum = (W(R+1)+H(C+1))(1-k)', () => {
    // adjusted (final fix wave, I3): k = 1 removes the four lines (enabled '1-k'), see the next test
    for (const [k, kk] of [[undefined, 0.5], [0, 0]]) {
      const m = fill(k === undefined ? cw() : cw({ k }))
      const r = runCw(m, 3600, 3000)
      const total = r.len(r.row(m.names.plate_w)[0]) + r.len(r.row(m.names.plate_h)[0])
      expect(r6(total)).toBe(r6((3600 * 4 + 3000 * 5) * (1 - kk)))
      expect(r6(r.len(r.row(m.names.cover_w)[0]) + r.len(r.row(m.names.cover_h)[0]))).toBe(r6((3600 * 4 + 3000 * 5) * (1 - kk)))
    }
    expect(cw().lines.plate_w[0].profile_family).toBe('NO.9019')
    expect(cw().lines.cover_h[0].profile_family).toBe('NO.3112')
  })
  it('k = 1: no plate / cover positions and the template validates; k back to 0.5 restores them with the former factors (I3)', async () => {
    const { validateModel } = await import('../partSave.js')
    const one = cw({ k: 1 })
    for (const key of ['plate_w', 'plate_h', 'cover_w', 'cover_h']) expect(one.lines[key]).toBeUndefined()
    expect(validateModel(fill(one))).toBeNull()
    expect(runCw(fill(one), 3600, 3000).components.map((c) => c.role_name)).not.toContain('แผ่นกด (แนวนอน)')
    const half = setParams(one, { k: 0.5 })
    expect(['plate_w', 'plate_h', 'cover_w', 'cover_h'].map((key) => half.lines[key][0].length_factor)).toEqual([2, 2.5, 2, 2.5])
    expect(half.lines.plate_w[0].profile_family).toBe('NO.9019')
    expect(validateModel(fill(half))).toBeNull()
    expect(setParams(one, { k: '0.5' }).lines.cover_h).toHaveLength(1)
  })
  it('k stored as text still evaluates numerically', () => {
    expect(exprParams({ layout_kind: 'curtain_wall', params: { rows: 1, cols: 1, k: '0.5' } }).k).toBe(0.5)
    expect(exprParams({ layout_kind: 'curtain_wall', params: { k: 'junk' } }).k).toBeUndefined()
  })
  it('unitized switches mullion and transom families (familiesWhen), others keep theirs', () => {
    const m = startModel('curtain_wall', defaultParams('curtain_wall', { unitized: true }))
    expect(m.params.unitized).toBe(true)
    expect([m.lines.mullion[0].profile_family, m.lines.transom[0].profile_family]).toEqual(['Fe-Mullion', 'Int-Tran'])
    expect(m.lines.plate_w[0].profile_family).toBe('NO.9019')
    expect(cw().lines.mullion[0].profile_family).toBe('NO.9010')
  })
  it('a layout with cells declared only: other layouts get no cells_* params', () => {
    expect(exprParams(startModel('fixed_grid', defaultParams('fixed_grid', {}))).cells_awning).toBeUndefined()
  })

  it('frameless_wall cols 3 at 3600: frame 4 rows, 3 panes of 1170, 2 joints', () => {
    const m = fill(startModel('frameless_wall', defaultParams('frameless_wall', {})))
    expect(m.params).toEqual({ cols: 3 })
    expect(Object.keys(m.lines)).toEqual(['frame_top', 'frame_bottom', 'frame_side'])
    expect(counts(m)).toEqual({ frame_top: 1, frame_bottom: 1, frame_side: 2 })
    expect(LAYOUTS.frameless_wall.parts.find((p) => p.key === 'pane')).toMatchObject({ glass: true, count: 'cols', positions: [] })
    expect(glassParts(m, { widthMm: 3600, buttOf }).map((g) => [g.part, g.idx, g.widthMm])).toEqual([['pane', 0, 1170], ['pane', 1, 1170], ['pane', 2, 1170]])
    expect(jointCount(m)).toBe(2)
    expect(jointCount(setParams(m, { cols: 5 }))).toBe(4)
    expect(glassParts(setParams(m, { cols: 5 }))).toHaveLength(5)
    expect(validateCorners(m)).toEqual([])
    expect(validateLayout(LAYOUTS.frameless_wall)).toEqual([])
  })
  it('validateLayout rejects a panel part that has positions or is glass', () => {
    const bad = { ...LAYOUTS.curtain_wall, parts: LAYOUTS.curtain_wall.parts.map((p) => (p.key === 'spandrel' ? { ...p, glass: true } : p)) }
    expect(validateLayout(bad).join()).toMatch(/panel part/)
  })
})

describe('part / position keys fit the database CHECK (migration 2026-10-18-03)', () => {
  it('every layout key matches ^[a-z][a-z0-9_]{0,39}$', async () => {
    const { LAYOUTS } = await import('../layoutRegistry.js')
    const re = /^[a-z][a-z0-9_]{0,39}$/
    for (const L of Object.values(LAYOUTS)) {
      for (const p of L.parts) expect(p.key).toMatch(re)
      for (const k of Object.keys(L.positions)) expect(k).toMatch(re)
    }
  })
})
