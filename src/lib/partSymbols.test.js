import { describe, it, expect } from 'vitest'
import { startModel, setParams } from './partModel.js'
import { defaultParams } from './layoutRegistry.js'
import { symbolFor } from './partSymbols.js'

describe('symbolFor', () => {
  it('sliding_2 sash is a slide with no hinge; parts without an entry are none', () => {
    const m = startModel('sliding_2')
    expect(symbolFor(m, 'sash', 1)).toEqual({ kind: 'slide', hinge: null })
    expect(symbolFor(m, 'frame', 0)).toEqual({ kind: 'none', hinge: null })
    expect(symbolFor(m, 'nope', 0)).toEqual({ kind: 'none', hinge: null })
  })
  it('hinge top stays top', () => {
    expect(symbolFor(startModel('awning_grid', defaultParams('awning_grid', {})), 'sash', 3)).toEqual({ kind: 'v_hinge', hinge: 'top' })
  })
  it('alternate: left half left, right half right, odd middle left, count 1 uses the hinge param', () => {
    const c = (n, hinge) => setParams(startModel('casement_n', defaultParams('casement_n', {})), hinge ? { n, hinge } : { n })
    const h = (m, n) => Array.from({ length: n }, (_, i) => symbolFor(m, 'sash', i).hinge)
    expect(h(c(4), 4)).toEqual(['left', 'left', 'right', 'right'])
    expect(h(c(5), 5)).toEqual(['left', 'left', 'left', 'right', 'right'])
    expect(h(c(1), 1)).toEqual(['left'])
    expect(h(c(1, 'right'), 1)).toEqual(['right'])
  })
})

// ---------------------------------------------------------------- Task 8: view-aware symbols (dashed / dir / fold)
import { foldSymbols } from './partSymbols.js'

describe('symbolFor with a view (Task 8)', () => {
  const m = (kind, params = {}) => startModel(kind, { ...defaultParams(kind, {}), ...params })
  const all = (model, part, n, view = 'out') => Array.from({ length: n }, (_, i) => symbolFor(model, part, i, { view }))
  it('casement n=2: hinges left, right; opens out → solid outside, dashed inside', () => {
    expect(all(m('casement_n'), 'sash', 2).map((s) => s.hinge)).toEqual(['left', 'right'])
    expect(all(m('casement_n'), 'sash', 2).map((s) => s.dashed)).toEqual([false, false])
    expect(all(m('casement_n'), 'sash', 2, 'in').map((s) => s.dashed)).toEqual([true, true])
  })
  it('awning: hinge top', () => {
    expect(symbolFor(m('awning_grid'), 'sash', 0, { view: 'out' })).toMatchObject({ kind: 'v_hinge', hinge: 'top', dashed: false, dir: 0 })
  })
  it('swing_door open in, view out → dashed', () => {
    expect(symbolFor(m('swing_door', { open: 'in' }), 'leaf', 0, { view: 'out' })).toMatchObject({ kind: 'v_hinge', hinge: 'left', dashed: true })
    expect(symbolFor(m('swing_door', { open: 'in' }), 'leaf', 0, { view: 'in' }).dashed).toBe(false)
  })
  it('slide: halves → left half +1, right half −1', () => {
    expect(all(m('sliding_n', { n: 4 }), 'sash', 4).map((s) => [s.kind, s.dir])).toEqual([['slide', 1], ['slide', 1], ['slide', -1], ['slide', -1]])
  })
  it('slide toward_fixed: the fixed piece is none (fixed), the others point at it; mirrored with fixed_side right', () => {
    expect(all(m('sliding_3track'), 'sash', 3).map((s) => [s.kind, s.dir])).toEqual([['none', 0], ['slide', -1], ['slide', -1]])
    expect(all(m('sliding_3track', { fixed_side: 'right' }), 'sash', 3).map((s) => [s.kind, s.dir])).toEqual([['slide', 1], ['slide', 1], ['none', 0]])
    expect(symbolFor(m('sliding_3track'), 'sash', 0, { view: 'out' }).fixed).toBe(true)
  })
  it('sliding_2_fixed_2: each sliding sash points at its fixed neighbour', () => {
    expect(all(m('sliding_2_fixed_2'), 'sash', 4).map((s) => [s.kind, s.dir])).toEqual([['none', 0], ['slide', -1], ['slide', 1], ['none', 0]])
  })
  it('fold nL 2 nR 1: 3 V entries alternating per side (first leaf of each side at the jamb), 2 arrows, split', () => {
    const f = m('folding_door', { nL: 2, nR: 1 })
    const v = all(f, 'leaf', 3)
    expect(v.map((s) => s.kind)).toEqual(['fold', 'fold', 'fold'])
    expect(v.map((s) => s.hinge)).toEqual(['left', 'right', 'right'])
    expect(v.map((s) => s.dir)).toEqual([-1, -1, 1])
    expect(v.every((s) => s.split === true)).toBe(true)
    const fs = foldSymbols(f)
    expect(fs.leaves).toHaveLength(3)
    expect(fs.arrows.map((a) => a.dir)).toEqual([-1, 1])
    expect(fs.split).toBe(true)
    expect(foldSymbols(m('folding_door', { nL: 0, nR: 3 }))).toMatchObject({ split: false, arrows: [{ dir: 1, from: 0, count: 3 }] })
  })
  it('without a view the legacy { kind, hinge } shape is unchanged', () => {
    expect(symbolFor(startModel('sliding_2'), 'sash', 0)).toEqual({ kind: 'slide', hinge: null })
  })
})
