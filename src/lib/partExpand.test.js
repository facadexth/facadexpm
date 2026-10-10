import { describe, it, expect } from 'vitest'
import { expandParts, explainPiece } from './partExpand.js'
import { computeComponentLength } from './bomEngine.js'
import { startModel, setEndMode, setPartCount, addLine } from './partModel.js'

const BUTT = { FS: 38.1, FT: 38.1, FB: 35.8, KS: 25, HS: 25 }
const buttOf = (f) => (f in BUTT ? BUTT[f] : null)
const widthOf = () => null
const FAM = { frame_top: 'FT', frame_bottom: 'FB', frame_side: 'FS', sash_top: 'ST', sash_bottom: 'SB', key_stile: 'KS', hook_stile: 'HS' }

function owner() {
  const m = startModel('sliding_2')
  for (const [k, f] of Object.entries(FAM)) m.lines[k][0].profile_family = f
  return m
}
const W = 1.8, H = 1.2
const len = (c) => computeComponentLength(c.length_rule_type, c.length_deduction_mm, W, H, c.length_factor, c.end_deduction_mm)
const byFam = (comps, f) => comps.filter((c) => c.profile_family === f)
const one = (comps, f) => { const r = byFam(comps, f); expect(r).toHaveLength(1); return r[0] }

describe('expandParts — owner worked example 1800 × 1200', () => {
  const { components, issues } = expandParts({ model: owner(), buttOf, widthOf })

  it('has no issues and one component per position', () => {
    expect(issues).toEqual([])
    expect(components).toHaveLength(7)
    expect(components.map((c) => c.sort_order)).toEqual([0, 1, 2, 3, 4, 5, 6])
    for (const c of components) {
      expect(c.quantity_basis).toBe('fixed')
      expect(c.cut_style).toBe('square')
      expect(c).not.toHaveProperty('id')
    }
  })

  it('frame top and bottom: width, butt both sides of the side frame', () => {
    for (const f of ['FT', 'FB']) {
      const c = one(components, f)
      expect(c.length_rule_type).toBe('width')
      expect(c.length_deduction_mm).toBe(0)
      expect(c.length_factor).toBe(1)
      expect(c.end_deduction_mm).toBeCloseTo(76.2, 6)
      expect(c.quantity_value).toBe(1)
      expect(len(c)).toBeCloseTo(1.7238, 6)
    }
    expect(one(components, 'FT').role_name).toBe('เฟรมบน')
  })

  it('frame side: height, no end deduction, quantity 2', () => {
    const c = one(components, 'FS')
    expect(c.length_rule_type).toBe('height')
    expect(c.end_deduction_mm).toBe(0)
    expect(c.quantity_value).toBe(2)
    expect(c.role_name).toBe('เฟรมข้าง')
    expect(len(c)).toBeCloseTo(1.2, 6)
  })

  it('sash rails: width_minus 76.2 − 25, factor 0.5, ends 50, quantity 2', () => {
    for (const f of ['ST', 'SB']) {
      const c = one(components, f)
      expect(c.length_rule_type).toBe('width_minus')
      expect(c.length_deduction_mm).toBeCloseTo(51.2, 6)
      expect(c.length_factor).toBe(0.5)
      expect(c.end_deduction_mm).toBeCloseTo(50, 6)
      expect(c.quantity_value).toBe(2)
      expect(c.thickness_role).toBe('sash')
      expect(len(c)).toBeCloseTo(0.8244, 6)
    }
  })

  it('key and hook stiles: height_minus 73.9, quantity 2', () => {
    for (const f of ['KS', 'HS']) {
      const c = one(components, f)
      expect(c.length_rule_type).toBe('height_minus')
      expect(c.length_deduction_mm).toBeCloseTo(73.9, 6)
      expect(c.end_deduction_mm).toBe(0)
      expect(c.quantity_value).toBe(2)
      expect(len(c)).toBeCloseTo(1.1261, 6)
    }
  })
})

describe('expandParts — variations', () => {
  it('frame side top end of the left piece butting the top frame splits the line', () => {
    const m = setEndMode(owner(), 'frame_side', 0, 0, 0, 'butt')
    const { components, issues } = expandParts({ model: m, buttOf, widthOf })
    expect(issues).toEqual([])
    const sides = byFam(components, 'FS')
    expect(sides).toHaveLength(2)
    expect(sides.map((c) => c.quantity_value)).toEqual([1, 1])
    expect(sides.map((c) => c.role_name)).toEqual(['เฟรมข้าง ซ้าย', 'เฟรมข้าง ขวา'])
    expect(len(sides[0])).toBeCloseTo(1.1619, 6) // 1200 − FT 38.1
    expect(len(sides[1])).toBeCloseTo(1.2, 6)
    // the top frame's left end now runs through: only the right end butts (38.1)
    const top = one(components, 'FT')
    expect(top.end_deduction_mm).toBeCloseTo(38.1, 6)
    expect(len(top)).toBeCloseTo(1.7619, 6)
  })

  it('frame side bottom end butting the bottom frame uses FB 35.8', () => {
    const m = setEndMode(owner(), 'frame_side', 0, 0, 1, 'butt')
    const { components } = expandParts({ model: m, buttOf, widthOf })
    const sides = byFam(components, 'FS')
    expect(sides.map((c) => c.end_deduction_mm)).toEqual([35.8, 0])
    expect(len(sides[0])).toBeCloseTo(1.1642, 6)
  })

  it('a second profile line (cover) with an override at one end', () => {
    let m = addLine(owner(), 'frame_top')
    m.lines.frame_top[1].profile_family = 'COV'
    m.lines.frame_top[1].ends[0][0] = { mode: 'butt', to: null, deduction_mm: 20 }
    m.lines.frame_top[1].ends[0][1] = { mode: 'through', to: null, deduction_mm: null }
    const { components, issues } = expandParts({ model: m, buttOf, widthOf })
    expect(issues).toEqual([])
    const c = one(components, 'COV')
    expect(c.end_deduction_mm).toBe(20)
    expect(c.role_name).toBe('เฟรมบน')
    expect(len(c)).toBeCloseTo(1.78, 6)
  })

  it('manual deduction overrides the automatic one', () => {
    const m = owner()
    m.lines.key_stile[0].deduction_auto = false
    m.lines.key_stile[0].length_deduction_mm = 80
    const { components } = expandParts({ model: m, buttOf, widthOf })
    expect(one(components, 'KS').length_deduction_mm).toBe(80)
    expect(len(one(components, 'KS'))).toBeCloseTo(1.12, 6)
  })

  it('manual overlap on the sash part', () => {
    const m = owner()
    const sash = m.parts.find((p) => p.key === 'sash')
    sash.overlap_mode = 'manual'
    sash.overlap_mm = 10
    const { components } = expandParts({ model: m, buttOf, widthOf })
    const c = one(components, 'ST')
    expect(c.length_deduction_mm).toBeCloseTo(66.2, 6)
    expect(len(c)).toBeCloseTo(0.8169, 6) // (1800 − 66.2)/2 − 50
  })

  it('auto overlap falls back to widthOf when no butt distance', () => {
    const m = owner()
    m.lines.hook_stile[0].profile_family = 'HSX'
    const { components } = expandParts({ model: m, buttOf, widthOf: (f) => (f === 'HSX' ? 30 : null) })
    expect(one(components, 'ST').length_deduction_mm).toBeCloseTo(46.2, 6)
  })

  it('sash count 3 gives quantities × 3/2', () => {
    const m = setPartCount(owner(), 'sash', 3)
    const { components, issues } = expandParts({ model: m, buttOf, widthOf })
    expect(issues).toEqual([])
    for (const f of ['ST', 'SB', 'KS', 'HS']) expect(one(components, f).quantity_value).toBe(3)
    expect(one(components, 'FS').quantity_value).toBe(2)
  })

  it('line quantity_value multiplies the piece count', () => {
    const m = owner()
    m.lines.frame_side[0].quantity_value = 2
    const { components } = expandParts({ model: m, buttOf, widthOf })
    expect(one(components, 'FS').quantity_value).toBe(4)
  })

  it('missing butt distance → no_butt_distance and 0', () => {
    const m = owner()
    m.lines.frame_side[0].profile_family = 'UNKNOWN'
    const { components, issues } = expandParts({ model: m, buttOf, widthOf })
    expect(one(components, 'FT').end_deduction_mm).toBe(0)
    expect(issues.some((i) => i.reason === 'no_butt_distance' && i.role_name === 'เฟรมบน')).toBe(true)
  })

  it('butt end with no target and no override → no_butt_target', () => {
    const m = owner()
    m.lines.frame_top[0].ends[0][0].to = null
    const { components, issues } = expandParts({ model: m, buttOf, widthOf })
    expect(one(components, 'FT').end_deduction_mm).toBeCloseTo(38.1, 6)
    expect(issues).toContainEqual({ role_name: 'เฟรมบน', reason: 'no_butt_target' })
  })

  it('corner violation is reported and components are still produced', () => {
    const m = owner()
    m.lines.frame_top[0].ends[0][0] = { mode: 'through', to: null, deduction_mm: null }
    const { components, issues } = expandParts({ model: m, buttOf, widthOf })
    expect(components).toHaveLength(7)
    expect(issues.some((i) => i.reason === 'corner_violation')).toBe(true)
  })

  it('empty profile family → no component and no_profile_family', () => {
    const m = owner()
    m.lines.key_stile[0].profile_family = ''
    const { components, issues } = expandParts({ model: m, buttOf, widthOf })
    expect(components).toHaveLength(6)
    expect(issues).toContainEqual({ role_name: 'เสากุญแจ', reason: 'no_profile_family' })
  })

  it('null or invalid model → no_model', () => {
    for (const model of [null, undefined, {}, { layout_kind: 'nope', lines: {} }]) {
      expect(expandParts({ model, buttOf, widthOf })).toEqual({ components: [], issues: [{ role_name: '', reason: 'no_model' }] })
    }
  })

  it('all-through, factor 1, no deductions → plain width/height components', () => {
    const m = owner()
    for (const lines of Object.values(m.lines)) {
      for (const l of lines) {
        l.length_rule_type = l.length_rule_type.startsWith('width') ? 'width' : 'height'
        l.length_factor = 1
        l.deduction_auto = false
        l.length_deduction_mm = 0
        for (const pair of l.ends) for (const e of pair) { e.mode = 'through'; e.to = null; e.deduction_mm = null }
      }
    }
    const { components } = expandParts({ model: m, buttOf, widthOf })
    expect(components).toHaveLength(7)
    for (const c of components) {
      expect(['width', 'height']).toContain(c.length_rule_type)
      expect(c.length_deduction_mm).toBe(0)
      expect(c.end_deduction_mm).toBe(0)
      expect(c.length_factor).toBe(1)
    }
    expect(len(one(components, 'FT'))).toBeCloseTo(1.8, 9)
    expect(len(one(components, 'KS'))).toBeCloseTo(1.2, 9)
  })
})

describe('explainPiece', () => {
  it('reproduces the rail explanation', () => {
    const s = explainPiece({ model: owner(), buttOf, widthOf, key: 'sash_top', lineIdx: 0, piece: 0, widthMm: 1800, heightMm: 1200 })
    expect(s).toBe('(กว้าง 1,800.0 − หักวงกบ/ระยะหัก 76.2 + ระยะซ้อนบาน 25.0) × 0.5 − ปลายซ้าย ชน เสาเกี่ยว 25.0 − ปลายขวา ชน เสากุญแจ 25.0 = 824.4 มม.')
  })

  it('explains a through end and a plain height', () => {
    const s = explainPiece({ model: owner(), buttOf, widthOf, key: 'frame_side', lineIdx: 0, piece: 0, widthMm: 1800, heightMm: 1200 })
    expect(s).toBe('สูง 1,200.0 ปลายบน วิ่งสุด ปลายล่าง วิ่งสุด = 1,200.0 มม.')
  })
})

import { lineDeductions, sashOverlap, endDeduction } from './partExpand.js'

describe('editor read-outs', () => {
  it('sources map every component back to its position line and pieces', () => {
    const m = setEndMode(owner(), 'frame_side', 0, 0, 0, 'butt')
    const { components, sources } = expandParts({ model: m, buttOf, widthOf })
    expect(sources).toHaveLength(components.length)
    const side = sources.filter((s) => s.key === 'frame_side')
    expect(side).toEqual([{ key: 'frame_side', line: 0, pieces: [0] }, { key: 'frame_side', line: 0, pieces: [1] }])
    expect(sources.find((s) => s.key === 'sash_top')).toEqual({ key: 'sash_top', line: 0, pieces: [0, 1] })
  })
  it('lineDeductions / sashOverlap / endDeduction give the expander numbers', () => {
    const m = owner()
    expect(lineDeductions({ model: m, buttOf, widthOf, key: 'sash_top', lineIdx: 0 })).toEqual({ pre: 76.2, hasAuto: true, overlap: 25 })
    expect(lineDeductions({ model: m, buttOf, widthOf, key: 'key_stile', lineIdx: 0 }).pre).toBeCloseTo(73.9, 6)
    expect(lineDeductions({ model: m, buttOf, widthOf, key: 'frame_top', lineIdx: 0 })).toEqual({ pre: 0, hasAuto: false, overlap: 0 })
    expect(sashOverlap({ model: m, buttOf, widthOf })).toBe(25)
    expect(endDeduction({ model: m, buttOf, widthOf, end: m.lines.frame_top[0].ends[0][0] })).toEqual({ mm: 38.1, problem: null })
  })
})
