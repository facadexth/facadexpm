import { describe, it, expect } from 'vitest'
import { expandParts, explainPiece } from './partExpand.js'
import { computeComponentLength } from './bomEngine.js'
import { startModel, setEndMode, setPartCount, addLine } from './partModel.js'
import { defaultParams } from './layoutRegistry.js'

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

// ---------------------------------------------------------------- Task 3: grids, tees, mitres, multi-sash overlap
import { registerLayoutForTest } from './layoutRegistry.js'
import { startModel as start3, setParams, validateCorners } from './partModel.js'

const fillAll = (m, fam = 'F') => { for (const lines of Object.values(m.lines)) for (const l of lines) l.profile_family = fam; return m }
const FRAME_JOINTS = [
  { h: 'frame_top', v: ['frame_side', 'frame_side'], vPiece: 'byEnd', vEnd: 0, through: 'v', mode: 'butt' },
  { h: 'frame_bottom', v: ['frame_side', 'frame_side'], vPiece: 'byEnd', vEnd: 1, through: 'v', mode: 'butt' },
]
const FRAME_POS = {
  frame_top: { part: 'frame', orient: 'h', per: 1, name: 'เฟรมบน', rule: { type: 'width' } },
  frame_bottom: { part: 'frame', orient: 'h', per: 1, name: 'เฟรมล่าง', rule: { type: 'width' } },
  frame_side: { part: 'frame', orient: 'v', per: 2, name: 'เฟรมข้าง', labels: ['ซ้าย', 'ขวา'], rule: { type: 'height' } },
}
const FRAME_PART = { key: 'frame', name: 'วงกบ', count: 1, overlap_mode: 'manual', overlap_mm: 0, corner: 'butt', track: null }

registerLayoutForTest({
  kind: 't3_grid',
  inputs: [{ key: 'rows', label: 'แถว', default: 2 }, { key: 'cols', label: 'คอลัมน์', default: 3 }],
  parts: [FRAME_PART],
  positions: {
    ...FRAME_POS,
    mullion: { part: 'frame', orient: 'v', per: 'cols-1', name: 'ซอยตั้ง', rule: { type: 'height_minus', auto: 'frame_top_bottom' } },
    transom: { part: 'frame', orient: 'h', per: '(rows-1)*cols', name: 'ซอยนอน', rule: { type: 'width_minus', auto: 'grid_cols', factor: '1/cols' } },
  },
  joints: [...FRAME_JOINTS, { h: 'transom', v: ['mullion', 'mullion'], mode: 'tee', through: 'v' }],
  order: ['frame_top', 'frame_bottom', 'frame_side', 'mullion', 'transom'],
})

describe('expandParts — grid (rows 2, cols 3) at 1800 × 1200', () => {
  const b45 = () => 45, w60 = () => 60
  const grid = () => fillAll(start3('t3_grid', { rows: 2, cols: 3 }))

  it('mullion: height_minus 90, 2 pieces, 1110; transom: width_minus 210 × 1/3, 3 pieces, 530', () => {
    const { components, issues } = expandParts({ model: grid(), buttOf: b45, widthOf: w60 })
    expect(issues).toEqual([])
    const mul = components.find((c) => c.role_name === 'ซอยตั้ง')
    expect(mul.length_rule_type).toBe('height_minus')
    expect(mul.length_deduction_mm).toBe(90)
    expect(mul.length_factor).toBe(1)
    expect(mul.end_deduction_mm).toBe(0)
    expect(mul.quantity_value).toBe(2)
    expect(computeComponentLength(mul.length_rule_type, mul.length_deduction_mm, 1.8, 1.2, mul.length_factor, mul.end_deduction_mm)).toBeCloseTo(1.11, 9)
    const tr = components.find((c) => c.role_name === 'ซอยนอน')
    expect(tr.length_rule_type).toBe('width_minus')
    expect(tr.length_deduction_mm).toBe(210)
    expect(tr.length_factor).toBeCloseTo(1 / 3, 12)
    expect(tr.end_deduction_mm).toBe(0)
    expect(tr.quantity_value).toBe(3)   // per '(rows-1)*cols' = 1 × 3 (the brief's "6 pieces" does not match its own per)
    expect(computeComponentLength(tr.length_rule_type, tr.length_deduction_mm, 1.8, 1.2, tr.length_factor, tr.end_deduction_mm)).toBeCloseTo(0.53, 9)
  })

  it('tee: the mullion runs through both ends, no corner validation on the tee', () => {
    const m = grid()
    for (const pair of m.lines.mullion[0].ends) expect(pair.map((e) => e.mode)).toEqual(['through', 'through'])
    expect(validateCorners(m)).toEqual([])
  })

  it('a tee end set to butt deducts the vertical profile butt distance', () => {
    const m = grid()
    m.lines.transom[0].ends[0][0] = { mode: 'butt', to: { key: 'mullion', line: 0 }, deduction_mm: null }
    const { components, issues } = expandParts({ model: m, buttOf: b45, widthOf: w60 })
    expect(issues).toEqual([])
    expect(components.filter((c) => c.role_name.startsWith('ซอยนอน')).map((c) => c.end_deduction_mm)).toEqual([45, 0])
  })

  it('setEndMode butt on a tee end targets the vertical and deducts its butt distance', () => {
    const m = setEndMode(grid(), 'transom', 0, 0, 0, 'butt')
    expect(m.lines.transom[0].ends[0][0]).toEqual({ mode: 'butt', to: { key: 'mullion', line: 0 }, deduction_mm: null })
    const { components, issues } = expandParts({ model: m, buttOf: b45, widthOf: w60 })
    expect(issues).toEqual([])
    expect(components.filter((c) => c.role_name.startsWith('ซอยนอน')).map((c) => c.end_deduction_mm)).toEqual([45, 0])
  })

  it('missing mullion width → no_profile_width, the grid term counts 0', () => {
    const { components, issues } = expandParts({ model: grid(), buttOf: b45, widthOf: () => null })
    expect(issues).toContainEqual({ role_name: 'ซอยนอน', reason: 'no_profile_width' })
    expect(components.find((c) => c.role_name === 'ซอยนอน').length_deduction_mm).toBe(90)
  })

  it('lineDeductions and explainPiece on a grid line', () => {
    const m = grid()
    expect(lineDeductions({ model: m, buttOf: b45, widthOf: w60, key: 'transom', lineIdx: 0 })).toEqual({ pre: 210, hasAuto: true, overlap: 0 })
    const s = explainPiece({ model: m, buttOf: b45, widthOf: w60, key: 'transom', lineIdx: 0, piece: 0, widthMm: 1800, heightMm: 1200 })
    expect(s).toBe('(กว้าง 1,800.0 − หักวงกบ/ระยะหัก 90.0 − ซอยกลาง (cols−1) × กว้าง 2 × 60.0) × 0.333333 ปลายซ้าย วิ่งสุด ปลายขวา วิ่งสุด = 530.0 มม.')
  })
})

registerLayoutForTest({
  kind: 't3_mitre',
  parts: [FRAME_PART, { key: 'sash', name: 'บาน', count: 1, overlap_mode: 'manual', overlap_mm: 0, corner: 'mitre', track: null }],
  positions: {
    ...FRAME_POS,
    sash_top: { part: 'sash', orient: 'h', per: 1, name: 'บานบน', rule: { type: 'width_minus', auto: 'frame_sides', role: 'sash' } },
    sash_bottom: { part: 'sash', orient: 'h', per: 1, name: 'บานล่าง', rule: { type: 'width_minus', auto: 'frame_sides', role: 'sash' } },
    sash_left: { part: 'sash', orient: 'v', per: 1, name: 'บานซ้าย', rule: { type: 'height_minus', auto: 'frame_top_bottom', role: 'sash' } },
    sash_right: { part: 'sash', orient: 'v', per: 1, name: 'บานขวา', rule: { type: 'height_minus', auto: 'frame_top_bottom', role: 'sash' } },
  },
  joints: [
    ...FRAME_JOINTS,
    { h: 'sash_top', v: ['sash_left', 'sash_right'], vPiece: 'same', vEnd: 0, through: 'v', mode: 'butt' },
    { h: 'sash_bottom', v: ['sash_left', 'sash_right'], vPiece: 'same', vEnd: 1, through: 'v', mode: 'butt' },
  ],
  order: ['frame_top', 'frame_bottom', 'frame_side', 'sash_top', 'sash_bottom', 'sash_left', 'sash_right'],
})

describe('expandParts — mitred sash part', () => {
  it('stale butt ends still give end_deduction_mm 0, cut_style miter45, no corner_violation', () => {
    const m = fillAll(start3('t3_mitre'))
    for (const k of ['sash_top', 'sash_bottom', 'sash_left', 'sash_right']) {
      for (const pair of m.lines[k][0].ends) for (const e of [0, 1]) pair[e] = { mode: 'butt', to: null, deduction_mm: null }
    }
    expect(validateCorners(m)).toEqual([])
    const { components, issues } = expandParts({ model: m, buttOf: () => 45, widthOf: () => 60 })
    expect(issues).toEqual([])
    for (const name of ['บานบน', 'บานล่าง', 'บานซ้าย', 'บานขวา']) {
      const c = components.find((x) => x.role_name === name)
      expect(c.end_deduction_mm).toBe(0)
      expect(c.cut_style).toBe('miter45')
      expect(c.length_deduction_mm).toBe(90)
    }
    expect(components.find((x) => x.role_name === 'เฟรมบน').cut_style).toBe('square')
    const s = explainPiece({ model: m, buttOf: () => 45, widthOf: () => 60, key: 'sash_top', lineIdx: 0, piece: 0, widthMm: 1800, heightMm: 1200 })
    expect(s).toBe('กว้าง 1,800.0 − หักวงกบ/ระยะหัก 90.0 (เข้ามุม 45°) = 1,710.0 มม.')
  })
})

registerLayoutForTest({
  kind: 't3_multi',
  inputs: [{ key: 'n', label: 'จำนวนบาน', default: 3 }],
  roles: { frame_side: 'jamb', hook: 'interlock' },
  parts: [FRAME_PART, { key: 'sash', name: 'บานเลื่อน', count: 'n', overlap_mode: 'auto_hook', overlap_mm: 0, corner: 'butt', track: 'each' }],
  positions: {
    jamb: { part: 'frame', orient: 'v', per: 2, name: 'วงกบข้าง', rule: { type: 'height' } },
    rail: { part: 'sash', orient: 'h', per: 1, name: 'บานเลื่อนบน', rule: { type: 'width_minus', auto: 'frame_sides', factor: '1/n', overlap: 'hook', overlapCount: 'n-1' } },
    interlock: { part: 'sash', orient: 'v', per: 1, name: 'เสาเกี่ยว', rule: { type: 'height' } },
  },
  order: ['jamb', 'rail', 'interlock'],
})

describe('expandParts — multi-sash overlap and roles', () => {
  it("overlapCount 'n-1' with n = 3 and ov 40 adds 80 before the factor 1/3", () => {
    const m = start3('t3_multi')
    m.lines.jamb[0].profile_family = 'J'
    m.lines.rail[0].profile_family = 'R'
    m.lines.interlock[0].profile_family = 'I'
    const buttOf3 = (f) => ({ J: 30, I: 40 })[f] ?? null
    const { components, issues } = expandParts({ model: m, buttOf: buttOf3, widthOf: () => null })
    expect(issues).toEqual([])
    const c = components.find((x) => x.role_name === 'บานเลื่อนบน')
    expect(c.length_deduction_mm).toBe(-20)   // 2·30 − 2·40
    expect(c.length_factor).toBeCloseTo(1 / 3, 12)
    expect(c.quantity_value).toBe(3)
    expect(computeComponentLength(c.length_rule_type, c.length_deduction_mm, 1.8, 1.2, c.length_factor, c.end_deduction_mm)).toBeCloseTo(1.82 / 3, 9)
    expect(sashOverlap({ model: m, buttOf: buttOf3, widthOf })).toBe(40)
    expect(lineDeductions({ model: m, buttOf: buttOf3, widthOf, key: 'rail', lineIdx: 0 })).toEqual({ pre: 60, hasAuto: true, overlap: 80 })
  })
})

registerLayoutForTest({
  kind: 't3_door',
  parts: [FRAME_PART, { key: 'leaf', name: 'บาน', count: 1, overlap_mode: 'manual', overlap_mm: 0, corner: 'butt', track: null }],
  positions: {
    frame_top: FRAME_POS.frame_top,
    frame_side: FRAME_POS.frame_side,
    stile_a: { part: 'leaf', orient: 'v', per: 2, name: 'เสาบาน', rule: { type: 'height_minus', auto: 'frame_top_bottom' } },
    stile_b: { part: 'leaf', orient: 'v', per: 2, name: 'เสาบานบน', rule: { type: 'height_minus', auto: 'frame_top' } },
    rail_a: { part: 'leaf', orient: 'h', per: 1, name: 'บานบน', rule: { type: 'sash_width', auto: 'sides_only', factor: 0.5 } },
    rail_b: { part: 'leaf', orient: 'h', per: 1, name: 'บานกลาง', rule: { type: 'sash_height', auto: 'frame_top', factor: '1/cols' } },
  },
  inputs: [{ key: 'cols', label: 'คอลัมน์', default: 2 }],
  joints: [FRAME_JOINTS[0]],
  order: ['frame_top', 'frame_side', 'stile_a', 'stile_b', 'rail_a', 'rail_b'],
})

describe('expandParts — sill-less door, sash references, param-driven factors', () => {
  const door = () => fillAll(start3('t3_door'))

  it('R-P3: frame_top_bottom with no frame_bottom position sums frame_top only (no issue)', () => {
    const { components, issues } = expandParts({ model: door(), buttOf: () => 45, widthOf: () => null })
    expect(issues).toEqual([])
    expect(components.find((c) => c.role_name === 'เสาบาน').length_deduction_mm).toBe(45)
    expect(components.find((c) => c.role_name === 'เสาบานบน').length_deduction_mm).toBe(45)
    expect(components.find((c) => c.role_name === 'บานบน').length_deduction_mm).toBe(90)
  })

  it('sash_width / sash_height compile to width_minus / height_minus with the rule auto and factor', () => {
    const m = door()
    expect(m.lines.rail_a[0]).toMatchObject({ length_rule_type: 'width_minus', deduction_auto: true, length_factor: 0.5 })
    expect(m.lines.rail_b[0]).toMatchObject({ length_rule_type: 'height_minus', deduction_auto: true, length_factor: 0.5 })
  })

  it('R-P7: setParams re-derives line 0 of expression factors; literal factors and extra lines stay', () => {
    let m = door()
    m = addLine(m, 'rail_b')
    m.lines.rail_b[1].length_factor = 0.7
    const next = setParams(m, { cols: 4 })
    expect(next.lines.rail_b[0].length_factor).toBe(0.25)
    expect(next.lines.rail_b[1].length_factor).toBe(0.7)
    expect(next.lines.rail_a[0].length_factor).toBe(0.5)
    expect(m.lines.rail_b[0].length_factor).toBe(0.5)   // input untouched
  })
})

// ---------------------------------------------------------------- Task 6: role-driven track autos
registerLayoutForTest({
  kind: 'test_t6_track',
  inputs: [],
  parts: [FRAME_PART, { key: 'leaf', name: 'บาน', count: 1, overlap_mode: 'manual', overlap_mm: 0, corner: 'butt', track: null }],
  positions: {
    track_rail: { part: 'frame', orient: 'h', per: 1, name: 'ราง', corner: 'free', rule: { type: 'width' } },
    track_top: { part: 'frame', orient: 'h', per: 1, name: 'รางบน', corner: 'free', rule: { type: 'width' } },
    track_bottom: { part: 'frame', orient: 'h', per: 1, name: 'รางล่าง', corner: 'free', rule: { type: 'width' } },
    track_side: { part: 'frame', orient: 'v', per: 2, name: 'รางข้าง', corner: 'free', rule: { type: 'height' } },
    by_track: { part: 'leaf', orient: 'v', per: 1, name: 'A', corner: 'free', rule: { type: 'height_minus', auto: 'track' } },
    by_tb: { part: 'leaf', orient: 'v', per: 1, name: 'B', corner: 'free', rule: { type: 'height_minus', auto: 'track_top_bottom' } },
    by_ts: { part: 'leaf', orient: 'h', per: 1, name: 'C', corner: 'free', rule: { type: 'width_minus', auto: 'track_sides' } },
  },
  joints: [],
  order: ['track_rail', 'track_top', 'track_bottom', 'track_side', 'by_track', 'by_tb', 'by_ts'],
})

describe('role-driven track autos', () => {
  const FAM = { track_rail: 'R', track_top: 'T', track_bottom: 'B', track_side: 'S' }
  const bt = (f) => ({ R: 11, T: 20, B: 30, S: 7 }[f] ?? 1)
  const model = () => {
    const m = start3('test_t6_track', {})
    for (const [k, ls] of Object.entries(m.lines)) for (const l of ls) l.profile_family = FAM[k] || 'X'
    return m
  }
  it('track = b(track_rail), track_top_bottom = b(track_top)+b(track_bottom), track_sides = 2 b(track_side)', () => {
    const { components, issues } = expandParts({ model: model(), buttOf: bt, widthOf: () => null })
    expect(issues).toEqual([])
    const ded = (n) => components.find((c) => c.role_name === n).length_deduction_mm
    expect([ded('A'), ded('B'), ded('C')]).toEqual([11, 50, 14])
  })
  it('an absent track role contributes 0 (R-P3)', () => {
    const m = model()
    delete m.lines.track_rail
    const { components } = expandParts({ model: m, buttOf: bt, widthOf: () => null })
    expect(components.find((c) => c.role_name === 'A').length_deduction_mm).toBe(0)
  })
})

describe('curtain_wall autos cw_cols / cw_rows (widths, not butt distances)', () => {
  it('cw_cols = (cols+1)·w(mullion), cw_rows = (rows+1)·w(transom)', () => {
    const m = startModel('curtain_wall', defaultParams('curtain_wall', { rows: 3, cols: 4 }))
    for (const ls of Object.values(m.lines)) for (const l of ls) l.profile_family = 'F'
    m.lines.mullion[0].profile_family = 'MU'
    m.lines.transom[0].profile_family = 'TR'
    const w = (f) => ({ MU: 50, TR: 70 }[f] ?? 1)
    const x = lineDeductions({ model: m, buttOf: () => 999, widthOf: w, key: 'transom', lineIdx: 0 })
    expect(x).toMatchObject({ pre: 250, hasAuto: true })   // 5 × 50, the butt distance (999) is ignored
    const m2 = setParams(m, { cells: { '0,0': 'awning' } })
    expect(lineDeductions({ model: m2, buttOf: () => 999, widthOf: w, key: 'sash_side', lineIdx: 0 }).pre).toBe(280)   // 4 × 70
  })
})
