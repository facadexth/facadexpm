import { describe, it, expect } from 'vitest'
import { defaultParams, kinds } from '../layoutRegistry.js'
import { startModel, validateCorners, pieceCount, setParams } from '../partModel.js'
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
  it('kinds', () => { for (const k of ['fixed_grid', 'awning_grid', 'casement_n']) expect(kinds()).toContain(k) })
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
