import { describe, it, expect } from 'vitest'
import { mergeSettings } from './estimationSettings.js'
import { kerfM, packBars, summarizePacking, compareLengths } from './cutOptimizer.js'

const S = mergeSettings({ kerf_square_mm: 3, kerf_miter_mm: 5, min_keep_offcut_m: 0.5 })
const cut = (length_m, quantity, style = 'square') => ({ length_m, quantity, style })

describe('packBars', () => {
  it('packs longest first and charges a kerf per cut', () => {
    const { bars } = packBars([cut(3, 2)], 6.4, S)
    expect(bars.length).toBe(1)
    expect(bars[0].pieces).toEqual([3, 3])
    expect(bars[0].left).toBeCloseTo(6.4 - 6 - 0.006, 9)
  })
  it('opens a second bar when the first is full', () => {
    expect(packBars([cut(3.2, 2)], 6.4, S).bars.length).toBe(2)
  })
  it('a piece longer than the bar is reported, never dropped', () => {
    const r = packBars([cut(7, 1), cut(1, 1)], 6.4, S)
    expect(r.unplaced).toEqual([7])
    expect(r.bars.length).toBe(1)
  })
  it('a piece exactly the bar length is placed; bad rows (0 length, 0 / fractional quantity) are ignored', () => {
    expect(packBars([cut(6.4, 1)], 6.4, S).bars[0].left).toBe(0)
    expect(packBars([cut(0, 3), cut(1, 0), cut(NaN, 1)], 6.4, S).bars).toEqual([])
    expect(packBars([cut(1, 2.9)], 6.4, S).bars[0].pieces).toEqual([1, 1])
  })
  it('a 45 degree cut uses the wider kerf', () => {
    expect(kerfM('miter45', S)).toBe(0.005)
    expect(kerfM('square', S)).toBe(0.003)
    expect(kerfM('notch', S)).toBe(0.003)
    expect(packBars([cut(3, 2, 'miter45')], 6.4, S).bars[0].left).toBeCloseTo(6.4 - 6 - 0.01, 9)
  })
})

describe('summarizePacking', () => {
  it('splits offcuts into reusable (>= min keep) and scrap', () => {
    const packed = { bars: [{ pieces: [5.4], left: 1 }, { pieces: [6.1], left: 0.3 }], unplaced: [] }
    const s = summarizePacking(packed, 6.4, 0.5)
    expect(s.count).toBe(2)
    expect(s.reusable_m).toBe(1)
    expect(s.scrap_m).toBeCloseTo(0.3, 9)
    expect(s.stock_m).toBeCloseTo(12.8, 9)
    expect(s.waste_pct).toBeCloseTo((100 * (12.8 - 11.5)) / 12.8, 6)
  })
})

describe('compareLengths', () => {
  const cuts = [cut(1.8, 8), cut(1.2, 8), cut(2.1, 4), cut(0.9, 6)]
  it('returns one row per candidate length and picks the least scrap when no prices are given', () => {
    const r = compareLengths({ cuts, lengths: [5, 5.5, 6, 6.4, 7], settings: S })
    expect(r.rows.map(x => x.length_m)).toEqual([5, 5.5, 6, 6.4, 7])
    expect(r.basis).toBe('scrap')
    const min = Math.min(...r.rows.filter(x => x.feasible).map(x => x.scrap_m))
    expect(r.best.scrap_m).toBe(min)
  })
  it('a length shorter than the longest cut is infeasible and never chosen', () => {
    const r = compareLengths({ cuts: [cut(2.1, 2)], lengths: [2, 6], settings: S })
    expect(r.rows[0].feasible).toBe(false)
    expect(r.rows[0].cost).toBeNull()
    expect(r.best.length_m).toBe(6)
  })
  it('with prices on every row the cheapest total wins, even if it scraps more', () => {
    const price = L => (L === 6 ? 100 : 400)
    const r = compareLengths({ cuts: [cut(2, 2)], lengths: [6, 6.4], settings: S, barPrice: price })
    expect(r.basis).toBe('cost')
    expect(r.best.length_m).toBe(6)
    expect(r.best.cost).toBe(100)
  })
  it('a row without a price makes the choice fall back to least scrap (never compares a number with null)', () => {
    const r = compareLengths({ cuts: [cut(2, 2)], lengths: [6, 6.4], settings: S, barPrice: L => (L === 6 ? 100 : null) })
    expect(r.basis).toBe('scrap')
  })
  it('nothing to cut gives no best length', () => {
    const r = compareLengths({ cuts: [], lengths: [6.4], settings: S })
    expect(r.best).toBeNull()
    expect(r.basis).toBeNull()
  })
})
