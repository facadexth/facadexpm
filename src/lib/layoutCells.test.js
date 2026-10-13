import { describe, it, expect } from 'vitest'
import { cellKinds, cycleCell, countKinds, panelCells, jointCount, cellParams } from './layoutCells.js'
import { startModel, setParams, cycleCellKind, pieceCount } from './partModel.js'
import { defaultParams, exprParams } from './layoutRegistry.js'

const cw = (patch) => setParams(startModel('curtain_wall', defaultParams('curtain_wall', {})), patch || {})

describe('layoutCells', () => {
  it('spandrel top, rows 3 cols 4: row 0 is spandrel, the rest glass', () => {
    const m = cw({ spandrel: 'top' })
    const k = cellKinds(m)
    expect(Object.keys(k)).toHaveLength(12)
    expect(countKinds(m)).toEqual({ glass: 8, awning: 0, spandrel: 4 })
    expect(panelCells(m)).toEqual([0, 1, 2, 3].map((c) => ({ r: 0, c })))
    expect(panelCells(m).length).toBe(4)
  })
  it('spandrel bottom uses the last row; none is all glass', () => {
    expect(panelCells(cw({ spandrel: 'bottom' })).map((x) => x.r)).toEqual([2, 2, 2, 2])
    expect(countKinds(cw())).toEqual({ glass: 12, awning: 0, spandrel: 0 })
  })
  it('cycleCell goes glass -> awning -> spandrel -> glass and does not mutate', () => {
    const m = cw()
    const a = cycleCell(m, 1, 2)
    expect(cellKinds(a)['1,2']).toBe('awning')
    expect(cellKinds(cycleCell(a, 1, 2))['1,2']).toBe('spandrel')
    expect(cellKinds(cycleCell(cycleCell(a, 1, 2), 1, 2))['1,2']).toBe('glass')
    expect(m.params.cells).toEqual({})
  })
  it('cycling a defaulted spandrel cell continues from spandrel', () => {
    expect(cellKinds(cycleCell(cw({ spandrel: 'top' }), 0, 0))['0,0']).toBe('glass')
  })
  it('out-of-grid keys are dropped after shrinking cols (Review Focus 5) and never crash', () => {
    let m = cycleCell(cw(), 0, 3)
    expect(m.params.cells['0,3']).toBe('awning')
    m = setParams(m, { cols: 2 })
    expect(m.params.cells['0,3']).toBe('awning')   // stored, but ignored
    const k = cellKinds(m)
    expect(Object.keys(k).sort()).toEqual(['0,0', '0,1', '1,0', '1,1', '2,0', '2,1'])
    expect(countKinds(m).awning).toBe(0)
    expect(exprParams(m).cells_awning).toBe(0)
    expect(pieceCount(m, 'sash_top')).toBe(0)
    expect(Object.keys(cellKinds(cycleCell(m, 2, 1)))).not.toContain('0,3')
    expect(cycleCell(m, 0, 3).params.cells).toEqual(m.params.cells)   // out-of-grid cycle is a no-op
  })
  it('garbage cells are tolerated', () => {
    for (const cells of [null, 'x', 5, { '0,0': 'bogus' }]) expect(countKinds({ params: { rows: 2, cols: 2, cells } }).glass).toBe(4)
    expect(cellKinds({})).toEqual({})
  })
  it('cycleCellKind refreshes counts and ends: one awning cell gives 1 sash, 2 sides', () => {
    const m = cycleCellKind(cw(), 1, 1)
    expect(exprParams(m)).toMatchObject({ cells_awning: 1, cells_spandrel: 0 })
    expect([pieceCount(m, 'sash_top'), pieceCount(m, 'sash_side')]).toEqual([1, 2])
    expect(m.lines.sash_side[0].ends).toHaveLength(2)
  })
  it('cellParams', () => { expect(cellParams({ rows: 3, cols: 4, spandrel: 'top' })).toEqual({ cells_awning: 0, cells_spandrel: 4 }) })
  it('jointCount = cols - 1', () => {
    expect(jointCount({ params: { cols: 3 } })).toBe(2)
    expect(jointCount({ params: { cols: 1 } })).toBe(0)
    expect(jointCount({ params: {} })).toBe(0)
  })
})
