import { describe, it, expect } from 'vitest'
import {
  buildEntries, entriesPieceCount, parseStockLength, stockWriteAction, makeBarPrice, candidateLengths, optimizerView, comparisonRows, seriesByGroup, itemsWithForeignColour,
} from './projectBomHelpers.js'
import { DEFAULT_SETTINGS } from '../../lib/estimationSettings.js'

const line = (o = {}) => ({ resolved: true, profile_id: 'p1', series_id: 's1', quantity: 2, length_m: 2, ...o })
const cost = (lines, finish = 'f1') => ({ resolved: { finish_id: finish }, bom: { profileLines: lines, gridLines: [] }, addonBom: null, extras: null, unresolved: [] })

describe('entries', () => {
  it('builds entries and lists items with no cost result', () => {
    const r = buildEntries([{ id: 'a', opening_no: 'D1', quantity: 2 }, { id: 'b', opening_no: 'D2', quantity: 1 }], { a: cost([line()]), b: null })
    expect(r.entries).toHaveLength(1)
    expect(r.entries[0].finish_id).toBe('f1')
    expect(r.skipped).toEqual([{ opening_no: 'D2', name: null, reason: 'no_template' }])
  })
  it('counts pieces x item quantity, ignoring unresolved lines', () => {
    const e = [{ quantity: 3, bom: { profileLines: [line(), line({ resolved: false })], gridLines: [line({ quantity: 1 })] }, addonBom: null }]
    expect(entriesPieceCount(e)).toBe(9)
  })
  it('collects the series per profile+colour', () => {
    const e = [{ finish_id: 'f1', bom: { profileLines: [line(), line({ series_id: 's2' })], gridLines: [] } }]
    expect([...seriesByGroup(e)['p1|f1']].sort()).toEqual(['s1', 's2'])
  })
})

describe('stock length input', () => {
  it('parses', () => {
    expect(parseStockLength('')).toBeNull()
    expect(parseStockLength(' 6.4 ')).toBe(6.4)
    expect(Number.isNaN(parseStockLength('abc'))).toBe(true)
    expect(Number.isNaN(parseStockLength('0'))).toBe(true)
    expect(Number.isNaN(parseStockLength('-1'))).toBe(true)
    expect(Number.isNaN(parseStockLength('99'))).toBe(true)
  })
  it('chooses insert / update / delete / none', () => {
    expect(stockWriteAction(null, 6)).toEqual({ op: 'insert', value: 6 })
    expect(stockWriteAction({ id: 'x', length_m: '6' }, 6)).toEqual({ op: 'none' })
    expect(stockWriteAction({ id: 'x', length_m: '6' }, 5.8)).toEqual({ op: 'update', id: 'x', value: 5.8 })
    expect(stockWriteAction({ id: 'x', length_m: '6' }, null)).toEqual({ op: 'delete', id: 'x' })
    expect(stockWriteAction(null, null)).toEqual({ op: 'none' })
    expect(stockWriteAction(null, NaN)).toEqual({ op: 'invalid' })
  })
})

const index = (basis) => ({
  providers: { pr: { id: 'pr', price_basis: basis } },
  series: { s1: { id: 's1' } },
  profiles: { p1: { id: 'p1', provider_id: 'pr', linear_weight_kg_per_m: 1, default_length_m: 6 } },
  finishes: { f1: { id: 'f1', provider_id: 'pr' } },
  variants: [{ id: 'v6', profile_id: 'p1', finish_id: 'f1', length_m: 6 }, { id: 'v5', profile_id: 'p1', finish_id: 'f1', length_m: 5 }, { id: 'vx', profile_id: 'p1', finish_id: 'other', length_m: 4 }],
  kgPrices: [{ id: 'k', provider_id: 'pr', finish_id: 'f1', series_id: null, profile_id: null, price_per_kg: 100, effective_from: '2026-01-01' }],
  piecePrices: [{ id: 'a', variant_id: 'v6', price_per_piece: 600, effective_from: '2026-01-01' }, { id: 'b', variant_id: 'v6', price_per_piece: 700, effective_from: '2026-06-01' }],
})

describe('barPrice and candidates', () => {
  it('per_kg scales the metre price', () => {
    const ix = index('per_kg')
    const f = makeBarPrice({ index: ix, profile: ix.profiles.p1, finish: ix.finishes.f1, seriesId: 's1', asOf: '2026-09-01' })
    expect(f(5)).toBe(500)
  })
  it('per_piece never scales: exact variant, latest price at asOf, else null', () => {
    const ix = index('per_piece')
    const f = makeBarPrice({ index: ix, profile: ix.profiles.p1, finish: ix.finishes.f1, seriesId: null, asOf: '2026-09-01' })
    expect(f(6)).toBe(700)
    expect(f(5)).toBeNull()      // variant exists, no price
    expect(f(6.4)).toBeNull()    // no such variant: must not fall back to the longest
    const early = makeBarPrice({ index: ix, profile: ix.profiles.p1, finish: ix.finishes.f1, seriesId: null, asOf: '2026-03-01' })
    expect(early(6)).toBe(600)
  })
  it('both provider is treated as per piece', () => {
    const ix = index('both')
    expect(makeBarPrice({ index: ix, profile: ix.profiles.p1, finish: ix.finishes.f1, asOf: '2026-09-01' })(5)).toBeNull()
  })
  it('lists variant lengths of that colour plus the stock length', () => {
    expect(candidateLengths(index('per_kg'), 'p1', 'f1', 6.4)).toEqual([5, 6, 6.4])
    expect(candidateLengths(index('per_kg'), 'p1', 'f1', 6)).toEqual([5, 6])
  })
})

describe('per_kg bar price across several series', () => {
  const ix = () => { const x = index('per_kg'); x.series = { s1: { id: 's1' }, s2: { id: 's2' } }; return x }
  const price = (x, ids) => makeBarPrice({ index: x, profile: x.profiles.p1, finish: x.finishes.f1, seriesIds: ids, asOf: '2026-09-01' })
  it('same price in both series gives a number', () => { expect(price(ix(), ['s1', 's2'])(5)).toBe(500) })
  it('different series-level prices give null; a single series is unchanged', () => {
    const x = ix()
    x.kgPrices = [...x.kgPrices, { id: 'k2', provider_id: 'pr', finish_id: 'f1', series_id: 's2', profile_id: null, price_per_kg: 120, effective_from: '2026-01-01' }]
    expect(price(x, ['s1', 's2'])(5)).toBeNull()
    expect(price(x, ['s1'])(5)).toBe(500)
    expect(price(x, ['s2'])(5)).toBe(600)
  })
})

describe('optimizerView', () => {
  const group = { profile_id: 'p1', finish_id: 'f1', stock_length_m: 6, cuts: [{ length_m: 5.5, quantity: 1, style: 'square' }, { length_m: 2, quantity: 2, style: 'square' }] }
  it('marks a shorter candidate infeasible with its unplaced pieces and no cost', () => {
    const v = optimizerView({ group, index: index('per_piece'), settings: DEFAULT_SETTINGS, asOf: '2026-09-01', seriesIds: ['s1'] })
    const r5 = v.rows.find(r => r.length_m === 5)
    expect(r5.status).toBe('infeasible')
    expect(r5.unplaced).toEqual([5.5])
    expect(r5.cost).toBeNull()
    expect(r5.count).toBeNull()
    expect(r5.best).toBe(false)
    const r6 = v.rows.find(r => r.length_m === 6)
    expect(r6.status).toBe('ok')
    expect(r6.isCurrent).toBe(true)
    expect(r6.best).toBe(true)
    expect(v.basis).toBe('cost')    // the only feasible row (6 m) is priced; the infeasible 5 m row is ignored
  })
  it('compares by scrap when a feasible row has no price', () => {
    const g = { ...group, stock_length_m: 6.4 }
    const v = optimizerView({ group: g, index: index('per_piece'), settings: DEFAULT_SETTINGS, asOf: '2026-09-01', seriesIds: [] })
    expect(v.basis).toBe('scrap')
    expect(v.rows.find(r => r.length_m === 6.4).cost).toBeNull()
  })
})

describe('comparisonRows', () => {
  const results = [
    { providerId: 'A', seriesId: 's', finishId: 'f', aluminium: 1000, complete: true, unresolvedLines: 0 },
    { providerId: 'B', seriesId: 's', finishId: 'f', aluminium: 900, complete: true, unresolvedLines: 0 },
    { providerId: 'C', seriesId: 's', finishId: 'f', aluminium: 300, complete: false, unresolvedLines: 3 },
    { providerId: 'D', seriesId: '', finishId: '', aluminium: 0, complete: false, unresolvedLines: 1 },
  ]
  it('gives a difference only for complete rows, never a fake saving', () => {
    const rows = comparisonRows(results, 'A')
    expect(rows[0].isBase).toBe(true)
    expect(rows[0].diff).toBeNull()
    expect(rows[1].diff.amount).toBe(-100)
    expect(rows[1].canApply).toBe(true)
    expect(rows[2].aluminium).toBeNull()
    expect(rows[2].diff).toBeNull()
    expect(rows[2].unresolvedLines).toBe(3)
    expect(rows[2].canApply).toBe(false)
    expect(rows[3].pending).toBe(true)
  })
  it('has no differences when the base itself is incomplete', () => {
    const rows = comparisonRows([{ ...results[0], complete: false, unresolvedLines: 2 }, results[1]], 'A')
    expect(rows[1].diff).toBeNull()
  })
})

describe('itemsWithForeignColour', () => {
  it('lists items whose own colour belongs to another extruder', () => {
    const ix = { finishes: { fa: { provider_id: 'A' }, fb: { provider_id: 'B' } } }
    const items = [{ id: 1, alu_finish_id: 'fa' }, { id: 2, alu_finish_id: 'fb' }, { id: 3, alu_finish_id: null }]
    expect(itemsWithForeignColour(items, ix, 'B').map(i => i.id)).toEqual([1])
  })
})
