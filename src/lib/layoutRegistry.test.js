import { describe, it, expect } from 'vitest'
import { LAYOUTS, layoutOf, inputsOf, defaultParams, kinds, exprParams, registerLayoutForTest, validateLayout } from './layoutRegistry.js'
import { startModel, pieceCount, partnerEnd, validateCorners, setParams, MAX_PIECES_PER_LINE, MAX_PART_COUNT } from './partModel.js'

describe('layoutRegistry', () => {
  it('registers sliding_2', () => {
    expect(kinds()).toContain('sliding_2')
    expect(layoutOf('sliding_2')).toBe(LAYOUTS.sliding_2)
    expect(layoutOf('sliding_2').kind).toBe('sliding_2')
    expect(inputsOf('sliding_2')).toEqual([])
  })
  it('unknown kinds throw unknown_layout', () => {
    expect(() => layoutOf('nope')).toThrow('unknown_layout')
    expect(() => layoutOf('__proto__')).toThrow('unknown_layout')
  })
  it('defaultParams(sliding_2, {}) is {}', () => {
    expect(defaultParams('sliding_2', {})).toEqual({})
  })
  it('derives each part\'s position keys in display order (the editor UI reads them)', () => {
    expect(LAYOUTS.sliding_2.parts.map(p => [p.key, p.positions])).toEqual([
      ['frame', ['frame_top', 'frame_bottom', 'frame_side']],
      ['sash', ['sash_top', 'sash_bottom', 'key_stile', 'hook_stile']],
    ])
  })
  it('exprParams: numbers pass, booleans and yes/no become 1/0, other strings are left out', () => {
    expect(exprParams({ params: { a: 2, b: true, c: false, d: 'yes', e: 'no', f: 'abc', g: NaN } })).toEqual({ a: 2, b: 1, c: 0, d: 1, e: 0 })
    expect(exprParams({})).toEqual({})
    expect(exprParams(null)).toEqual({})
  })
})

describe('registerLayoutForTest', () => {
  const def = registerLayoutForTest({
    kind: 'test_grid',
    inputs: [
      { key: 'cols', label: 'คอลัมน์', default: 2, estimator: true },
      { key: 'rows', label: 'แถว', default: 1, fixed_by_type: true },
    ],
    parts: [{ key: 'frame', name: 'วงกบ', count: 1, overlap_mode: 'manual', overlap_mm: 0, corner: 'mitre', track: null }],
    positions: {
      top: { part: 'frame', orient: 'h', per: 1, name: 'บน', rule: { type: 'width', family: 'F100' } },
      bottom: { part: 'frame', orient: 'h', per: 1, name: 'ล่าง', rule: { type: 'width' } },
      side: { part: 'frame', orient: 'v', per: 2, name: 'ข้าง', rule: { type: 'height' } },
      mullion: { part: 'frame', orient: 'v', per: 'cols-1', name: 'เสากลาง', rule: { type: 'height_minus', auto: 'frame_top_bottom', factor: '1/rows' } },
    },
    joints: [
      { h: 'top', v: ['side', 'side'], vPiece: 'byEnd', vEnd: 0, through: 'h', mode: 'mitre' },
      { h: 'bottom', v: ['side', 'side'], vPiece: 'byEnd', vEnd: 1, through: 'h', mode: 'butt' },
    ],
    order: ['top', 'bottom', 'side', 'mullion'],
  })

  it('registers and layoutOf resolves the throwaway kind', () => {
    expect(layoutOf('test_grid')).toBe(def)
    expect(kinds()).toContain('test_grid')
    expect(def.parts[0].positions).toEqual(['top', 'bottom', 'side', 'mullion'])
  })
  it('defaultParams: layout defaults, overridden only for fixed_by_type inputs', () => {
    expect(defaultParams('test_grid', {})).toEqual({ cols: 2, rows: 1 })
    expect(defaultParams('test_grid', { rows: 3, cols: 9 })).toEqual({ cols: 2, rows: 3 })
  })
  it('startModel stores params, copies rule.family, and evaluates per/factor expressions', () => {
    const m = startModel('test_grid', { cols: 4, rows: 2 })
    expect(m.params).toEqual({ cols: 4, rows: 2 })
    expect(m.lines.top[0].profile_family).toBe('F100')
    expect(m.lines.bottom[0].profile_family).toBe('')
    expect(pieceCount(m, 'mullion')).toBe(3)
    expect(m.lines.mullion[0].ends).toHaveLength(3)
    expect(m.lines.mullion[0].length_factor).toBe(0.5)
    expect(startModel('test_grid').params).toEqual({ cols: 2, rows: 1 })
  })
  it('joints drive default ends: mitre on both members, through:h makes the vertical butt', () => {
    const m = startModel('test_grid')
    expect(m.lines.top[0].ends[0]).toEqual([{ mode: 'mitre', to: null, deduction_mm: null }, { mode: 'mitre', to: null, deduction_mm: null }])
    expect(m.lines.bottom[0].ends[0][0]).toEqual({ mode: 'through', to: null, deduction_mm: null })
    expect(m.lines.side[0].ends[1][1]).toEqual({ mode: 'butt', to: { key: 'bottom', line: 0 }, deduction_mm: null })
    expect(m.lines.side[0].ends[0][0].mode).toBe('mitre')
    expect(partnerEnd(m, 'side', 1, 1)).toEqual({ key: 'bottom', piece: 0, end: 1 })
    expect(partnerEnd(m, 'mullion', 0, 0)).toBeNull()
    expect(validateCorners(m)).toEqual([])
  })
})

describe('pieceCount clamps expression-driven counts', () => {
  registerLayoutForTest({
    kind: 'test_clamp',
    inputs: [{ key: 'cols', label: 'คอลัมน์', default: 2 }],
    parts: [
      { key: 'frame', name: 'วงกบ', count: 1, overlap_mode: 'manual', overlap_mm: 0 },
      { key: 'panel', name: 'บาน', count: 'cols', overlap_mode: 'manual', overlap_mm: 0 },
    ],
    positions: {
      mullion: { part: 'frame', orient: 'v', per: 'cols-1', name: 'เสากลาง', rule: { type: 'height' } },
      panel_side: { part: 'panel', orient: 'v', per: 2, name: 'ข้างบาน', rule: { type: 'height' } },
    },
    joints: [],
    order: ['mullion', 'panel_side'],
  })

  it('cols: 0 gives 0 pieces and does not throw', () => {
    const m = startModel('test_clamp', { cols: 0 })
    expect(pieceCount(m, 'mullion')).toBe(0)
    expect(m.lines.mullion[0].ends).toEqual([])
    expect(pieceCount(m, 'panel_side')).toBe(0)
    expect(() => setParams(startModel('test_clamp'), { cols: 0 })).not.toThrow()
  })
  it('a huge cols is clamped to MAX_PIECES_PER_LINE; an expression part count to MAX_PART_COUNT', () => {
    expect(MAX_PIECES_PER_LINE).toBe(120)
    const m = setParams(startModel('test_clamp'), { cols: 5000 })
    expect(pieceCount(m, 'mullion')).toBe(MAX_PIECES_PER_LINE)
    expect(m.lines.mullion[0].ends).toHaveLength(MAX_PIECES_PER_LINE)
    expect(pieceCount(m, 'panel_side')).toBe(2 * MAX_PART_COUNT)
  })
})

describe('validateLayout', () => {
  it('every registered layout is a valid definition', () => {
    for (const k of kinds()) if (!k.startsWith('test_') && !k.startsWith('t3_')) expect([k, validateLayout(LAYOUTS[k])]).toEqual([k, []])
    expect(kinds()).toEqual(expect.arrayContaining(['sliding_2', 'fixed_grid', 'awning_grid', 'casement_n']))
  })
  it('rejects bad definitions', () => {
    const base = LAYOUTS.fixed_grid
    expect(validateLayout({ ...base, positions: { ...base.positions, mullion: { ...base.positions.mullion, part: 'zzz' } } })[0]).toMatch(/unknown part/)
    expect(validateLayout({ ...base, joints: [{ h: 'mullion', v: ['frame_side', 'frame_side'], mode: 'butt' }] })[0]).toMatch(/horizontal/)
    expect(validateLayout({ ...base, joints: [{ h: 'frame_top', v: ['transom', 'frame_side'], mode: 'butt' }] })[0]).toMatch(/vertical/)
    const dup = [...base.joints, { h: 'transom', v: ['frame_side', 'frame_side'], vPiece: 'byEnd', vEnd: 0, mode: 'butt' }]
    expect(validateLayout({ ...base, joints: dup }).join()).toMatch(/more than one joint/)
    expect(validateLayout({ ...base, order: base.order.slice(1) }).join()).toMatch(/exactly once/)
    expect(validateLayout({ ...base, order: [...base.order, 'mullion'] }).join()).toMatch(/exactly once/)
  })
  it('rejects an unknown symbol.direction', () => {
    const base = LAYOUTS.sliding_n
    expect(validateLayout({ ...base, symbol: { ...base.symbol, direction: 'sideways' } }).join()).toMatch(/symbol.direction/)
    for (const d of ['halves', 'toward_fixed', 'outward']) expect(validateLayout({ ...base, symbol: { ...base.symbol, direction: d } })).toEqual([])
  })
})

describe('defaultParams clamping', () => {
  it('clamps fixed_by_type values to min/max and rounds whole numbers', () => {
    expect(defaultParams('awning_grid', { rows: 99, cols: 0 })).toEqual({ rows: 8, cols: 1, open: 'out' })
    expect(defaultParams('awning_grid', { rows: 2.6, cols: 'x' })).toEqual({ rows: 3, cols: 2, open: 'out' })
    expect(defaultParams('awning_grid', {})).toEqual({ rows: 2, cols: 2, open: 'out' })
  })
})

// ---- Task 9: coerceParams / layoutLabels ----
import { coerceParams, layoutLabels } from './layoutRegistry.js'

describe('coerceParams (stored JSON -> typed params)', () => {
  it('numeric strings become numbers, clamped to min/max and rounded when integer', () => {
    expect(coerceParams('awning_grid', { rows: '2', cols: '0.5' })).toEqual({ rows: 2, cols: 1 })
    expect(coerceParams('awning_grid', { rows: 99 })).toEqual({ rows: 8 })
    expect(coerceParams('sliding_n', { n: '3' })).toEqual({ n: 3 })
  })
  it('unknown keys and invalid values are dropped (the defaults then apply)', () => {
    expect(coerceParams('awning_grid', { rows: 2, junk: 1, open: 'sideways' })).toEqual({ rows: 2 })
    expect(coerceParams('awning_grid', { rows: 'abc', cols: '' })).toEqual({})
    expect(coerceParams('sliding_2', { anything: 1 })).toEqual({})
  })
  it('booleans from true/false/1/0 (and their strings); selects keep their option value, numeric options from text', () => {
    expect(coerceParams('sliding_n', { door: 'true' })).toEqual({ door: true })
    expect(coerceParams('sliding_n', { door: 0 })).toEqual({ door: false })
    expect(coerceParams('swing_door', { pivot: 1, sill: 'no' })).toEqual({ pivot: true, sill: 'no' })
    expect(coerceParams('curtain_wall', { k: '1', unitized: 'false' })).toEqual({ k: 1, unitized: false })
  })
  it('cells stay an object (a non-object is dropped); null / non-object input gives {}', () => {
    const cells = { '0,1': 'awning' }
    const out = coerceParams('curtain_wall', { cells })
    expect(out).toEqual({ cells })
    expect(out.cells).not.toBe(cells)
    expect(coerceParams('curtain_wall', { cells: 'x' })).toEqual({})
    expect(coerceParams('curtain_wall', null)).toEqual({})
    expect(coerceParams('curtain_wall', [1, 2])).toEqual({})
  })
  it('throws unknown_layout for an unknown kind', () => {
    expect(() => coerceParams('nope', {})).toThrow(/unknown_layout/)
  })
  it('defaultParams shares the coercion: a numeric string from the type is taken', () => {
    expect(defaultParams('awning_grid', { rows: '3', cols: '4' })).toEqual({ rows: 3, cols: 4, open: 'out' })
  })
})

describe('layoutLabels', () => {
  it('has a Thai label for every registered kind', () => {
    expect(Object.keys(layoutLabels).sort()).toEqual(kinds().filter(k => !k.startsWith('test_')).sort())
    expect(layoutLabels.sliding_2).toBe('บานเลื่อนสวน 2 บาน')
    expect(layoutLabels.awning_grid).toBe('บานกระทุ้ง (ชั้น × ช่อง)')
    expect(layoutLabels.frameless_wall).toBe('ผนังกระจกเปลือย')
  })
})
