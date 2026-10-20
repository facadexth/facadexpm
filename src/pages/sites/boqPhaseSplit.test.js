import { describe, it, expect } from 'vitest'
import {
  cellsFromRows, cellsToRows, buildDefaultCells, rowTotal, rowOk, cellIsCustom, computePhaseWeights, itemShares,
} from './boqPhaseSplit.js'

const phases = [
  { id: 'A', name: 'ผลิต', sort_order: 1 },
  { id: 'B', name: 'ติดตั้ง', sort_order: 2 },
  { id: 'C', name: 'เก็บงาน', sort_order: 3 },
  { id: 'V', name: 'VO-1', sort_order: 4, is_vo: true },
]
const items = [{ id: 'i1' }, { id: 'i2' }]

describe('cells <-> rows', () => {
  it('builds a cell map from saved rows, a missing cell is 0', () => {
    const cells = cellsFromRows(items, phases, [{ boq_item_id: 'i1', phase_id: 'A', pct: '40' }, { boq_item_id: 'i1', phase_id: 'B', pct: 60 }])
    expect(cells).toEqual({ i1: { A: 40, B: 60, C: 0, V: 0 }, i2: { A: 0, B: 0, C: 0, V: 0 } })
  })
  it('sends every item x phase cell to the RPC', () => {
    const rows = cellsToRows({ i1: { A: 40, B: 60, C: 0, V: 0 } }, items.slice(0, 1), phases)
    expect(rows).toEqual([
      { boq_item_id: 'i1', phase_id: 'A', pct: 40 }, { boq_item_id: 'i1', phase_id: 'B', pct: 60 },
      { boq_item_id: 'i1', phase_id: 'C', pct: 0 }, { boq_item_id: 'i1', phase_id: 'V', pct: 0 },
    ])
  })
  it('a blank or bad cell is sent as 0', () => {
    expect(cellsToRows({ i1: { A: '', B: 'x' } }, items.slice(0, 1), phases.slice(0, 2)).map((r) => r.pct)).toEqual([0, 0])
  })
  it('default cells copy the template defaults into every item', () => {
    const cells = buildDefaultCells(items, phases, [{ phase_id: 'A', pct: '40' }, { phase_id: 'B', pct: 40 }, { phase_id: 'C', pct: 20 }])
    expect(cells.i1).toEqual({ A: 40, B: 40, C: 20, V: 0 })
    expect(cells.i2).toEqual(cells.i1)
  })
})

describe('row total', () => {
  it('sums the row to 2 dp and accepts 100 +- 0.01 like the DB', () => {
    expect(rowTotal({ A: '33.33', B: 33.33, C: 33.34 })).toBe(100)
    expect(rowOk({ A: 50, B: 49.995 })).toBe(true)
    expect(rowOk({ A: 50, B: 49.9 })).toBe(false)
    expect(rowOk({ A: 100, B: 1 })).toBe(false)
  })
  it('a cell differing from the template default is custom', () => {
    const defaults = { A: 40, B: 40, C: 20 }
    expect(cellIsCustom(40, defaults.A)).toBe(false)
    expect(cellIsCustom('40', defaults.A)).toBe(false)
    expect(cellIsCustom(50, defaults.A)).toBe(true)
    expect(cellIsCustom(0, undefined)).toBe(false)
  })
})

describe('itemShares', () => {
  it('uses the BOQ tab shares (percent) as fractions', () => {
    expect(itemShares(items, { i1: 70, i2: 30 })).toEqual({ i1: 0.7, i2: 0.3 })
  })
  it('equal shares when the RPC shares are not available', () => {
    expect(itemShares(items, null)).toEqual({ i1: 0.5, i2: 0.5 })
    expect(itemShares([], null)).toEqual({})
  })
})

describe('computePhaseWeights (same formula as recompute_site_phase_weights)', () => {
  it('dry-run (c): shares 70/30, i1 40/50/10, i2 20/50/30 -> 34/50/16', () => {
    const cells = { i1: { A: 40, B: 50, C: 10, V: 0 }, i2: { A: 20, B: 50, C: 30, V: 0 } }
    expect(computePhaseWeights({ phases, shares: { i1: 0.7, i2: 0.3 }, cells })).toEqual({ A: 34, B: 50, C: 16, V: 0 })
  })
  it('weights are normalised over contract phases only; pct on a VO phase is dropped, VO stays 0', () => {
    const cells = { i1: { A: 50, B: 0, C: 0, V: 50 } }
    expect(computePhaseWeights({ phases, shares: { i1: 1 }, cells })).toEqual({ A: 100, B: 0, C: 0, V: 0 })
  })
  it('rounds to 2 dp and puts the remainder on the largest phase so the total is exactly 100', () => {
    const cells = { i1: { A: 100 / 3, B: 100 / 3, C: 100 / 3 } }
    const w = computePhaseWeights({ phases: phases.slice(0, 3), shares: { i1: 1 }, cells })
    expect(Object.values(w).reduce((s, x) => s + x, 0)).toBeCloseTo(100, 10)
    expect(w).toEqual({ A: 33.34, B: 33.33, C: 33.33 })
  })
  it('every pct on VO phases -> contract phases share equally', () => {
    const cells = { i1: { A: 0, B: 0, C: 0, V: 100 } }
    expect(computePhaseWeights({ phases, shares: { i1: 1 }, cells })).toEqual({ A: 33.34, B: 33.33, C: 33.33, V: 0 })
  })
  it('issue phases are ignored, blank cells count as 0', () => {
    const ph = [...phases, { id: 'X', name: 'issue', sort_order: 9, is_issue_phase: true }]
    const cells = { i1: { A: '', B: '100', X: 50 } }
    expect(computePhaseWeights({ phases: ph, shares: { i1: 1 }, cells })).toEqual({ A: 0, B: 100, C: 0, V: 0 })
  })
})
