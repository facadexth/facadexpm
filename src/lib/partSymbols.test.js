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
