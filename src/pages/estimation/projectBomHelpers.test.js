import { describe, it, expect } from 'vitest'
import {
  buildEntries, entriesPieceCount, parseStockLength, stockWriteAction, makeBarPrice, candidateLengths, optimizerView, comparisonRows, seriesByGroup, itemsWithForeignColour,
  cutGroupInfo, cutGroupKgPerM, cutGroupOverrides, cutGroupPricePerKg, lengthCompare, customLengthSummaryModel, bestLengthsByProfile, bomStockBasis,
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
  it('entries carry the item id and name', () => {
    const r = buildEntries([{ id: 'a', opening_no: 'D1', item_name: 'บานเลื่อน', quantity: 1 }, { id: 'b', opening_no: 'D2', quantity: 1 }], { a: cost([line()]), b: cost([line()]) })
    expect(r.entries.map(e => [e.item_id, e.item_name])).toEqual([['a', 'บานเลื่อน'], ['b', '']])
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
  it('merges an optional range of custom lengths into the candidates', () => {
    expect(candidateLengths(index('per_kg'), 'p1', 'f1', 6.4, [4, 5, 6.45])).toEqual([4, 5, 6, 6.4, 6.45])
    expect(candidateLengths(index('per_kg'), 'p1', 'f1', 6.4, [])).toEqual([5, 6, 6.4])
    expect(candidateLengths(index('per_kg'), 'p1', 'f1', 6.4, undefined)).toEqual([5, 6, 6.4])
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

describe('cut plan group maps', () => {
  const ix = {
    profiles: { p1: { id: 'p1', name: 'กรอบบน', drawing_no: 'D-1', linear_weight_kg_per_m: 1.2 }, p2: { id: 'p2', name: 'ฝา', drawing_no: null, linear_weight_kg_per_m: null } },
    finishes: { f1: { id: 'f1', name: 'อบขาว' } },
  }
  const entries = [
    { finish_id: 'f1', bom: { profileLines: [line(), line({ resolved: false, profile_id: 'p9' })], gridLines: [] } },
    { finish_id: null, bom: { profileLines: [line({ profile_id: 'p2' })], gridLines: [] }, addonBoms: [{ bom: { profileLines: [line({ profile_id: 'p1' })], gridLines: [] } }] },
  ]
  it('gives every plan group its profile and finish ids (blank finish -> null) and names', () => {
    const info = cutGroupInfo(entries, ix)
    expect(Object.keys(info).sort()).toEqual(['p1|', 'p1|f1', 'p2|'])
    expect(info['p1|f1']).toEqual({ profile_id: 'p1', finish_id: 'f1', die_no: 'D-1', name: 'กรอบบน', finish_name: 'อบขาว' })
    expect(info['p2|']).toEqual({ profile_id: 'p2', finish_id: null, die_no: null, name: 'ฝา', finish_name: null })
    for (const v of Object.values(info)) expect(v.profile_id).toBeTruthy()
  })
  it('an unknown profile still gets its id', () => {
    const info = cutGroupInfo([{ finish_id: 'fx', bom: { profileLines: [line({ profile_id: 'gone' })], gridLines: [] } }], ix)
    expect(info['gone|fx']).toEqual({ profile_id: 'gone', finish_id: 'fx', die_no: null, name: '?', finish_name: null })
  })
  it('maps weight and per-profile stock overrides onto group keys', () => {
    const info = cutGroupInfo(entries, ix)
    expect(cutGroupKgPerM(info, ix)).toEqual({ 'p1|f1': 1.2, 'p1|': 1.2, 'p2|': null })
    expect(cutGroupOverrides(info, { p1: 6.25 })).toEqual({ 'p1|f1': 6.25, 'p1|': 6.25 })
  })
  it('price per kg = bar price of 1 m / kg per m, null when unpriced or weightless', () => {
    const x = index('per_kg')
    const info = { 'p1|f1': { profile_id: 'p1', finish_id: 'f1' }, 'p1|': { profile_id: 'p1', finish_id: null } }
    const r = cutGroupPricePerKg({ groupInfo: info, index: x, seriesMap: { 'p1|f1': ['s1'] }, asOf: '2026-09-01', kgPerM: { 'p1|f1': 2, 'p1|': 2 } })
    expect(r['p1|f1']).toBe(50)
    expect(r['p1|']).toBeNull()
    expect(cutGroupPricePerKg({ groupInfo: info, index: x, seriesMap: {}, asOf: '2026-09-01', kgPerM: {} })['p1|f1']).toBeNull()
  })
})

describe('lengthCompare', () => {
  const s = { ...DEFAULT_SETTINGS }
  const entries = [{ item_id: 'a', opening_no: 'W1', quantity: 1, finish_id: 'f1', bom: { profileLines: [line({ length_m: 3.1, quantity: 2 })], gridLines: [] } }]
  it('gives the 6.40 m baseline and the least-kg length, ignoring overrides and the minimum order', () => {
    const c = lengthCompare({ entries, settings: s, kgPerM: { 'p1|f1': 1 }, offcutsByGroup: {} })
    expect(c['p1|f1'].base).toMatchObject({ length_m: 6.4, newBars: 1 })
    expect(c['p1|f1'].base.kg).toBeCloseTo(6.4)
    expect(c['p1|f1'].best.length_m).toBe(6.25)
    expect(c['p1|f1'].best.kg).toBeCloseTo(6.25)
  })
  it('a piece longer than the stock bar marks the baseline infeasible', () => {
    const long = [{ ...entries[0], bom: { profileLines: [line({ length_m: 6.6, quantity: 1 })], gridLines: [] } }]
    const c = lengthCompare({ entries: long, settings: s, kgPerM: { 'p1|f1': 1 }, offcutsByGroup: {} })
    expect(c['p1|f1'].base.feasible).toBe(false)
    expect(c['p1|f1'].best.length_m).toBe(6.6)
    expect(lengthCompare({ entries, settings: s, kgPerM: { 'p1|f1': 1 }, offcutsByGroup: {} })['p1|f1'].base.feasible).toBe(true)
  })
  it('no weight -> no best length', () => {
    const c = lengthCompare({ entries, settings: s, kgPerM: {}, offcutsByGroup: {} })
    expect(c['p1|f1'].best).toBeNull()
  })
})

const g = (o = {}) => ({ key: 'p1|f1', profile_id: 'p1', finish_id: 'f1', name: 'กรอบ', die_no: 'D-1', finish_name: 'อบขาว', length_m: 6.25, custom: true, no_weight: false, overrideRejected: false, offcutBars: [], bars: [{}, {}], unplaced: [], kg: 12.5, newOffcuts: [], ...o })

describe('customLengthSummaryModel', () => {
  const compare = { 'p1|f1': { base: { length_m: 6.4, newBars: 2, kg: 12.8 }, best: { length_m: 6.25, newBars: 2, kg: 12.5 } } }
  it('rows carry baseline, best, saving badge and cost; totals give the saving', () => {
    const m = customLengthSummaryModel({ plan: { reason: null, customKg: 12.5, groups: [g()] }, compare, prices: { 'p1|f1': 100 }, kgPerM: { 'p1|f1': 1 } })
    expect(m.rows[0]).toMatchObject({ key: 'p1|f1', kgPerM: 1, baseBars: 2, bestLength: 6.25, bestSavingKg: expect.any(Number), useLength: 6.25, newBars: 2, offcutBars: 0, kg: 12.5 })
    expect(m.rows[0].cost).toBeCloseTo(1250)
    expect(m.savingKg).toBeCloseTo(0.3)
    expect(m.savingBaht).toBeCloseTo(30)
  })
  it('an unpriced group with a saving leaves the baht saving out', () => {
    const m = customLengthSummaryModel({ plan: { reason: null, customKg: 12.5, groups: [g()] }, compare, prices: { 'p1|f1': null }, kgPerM: { 'p1|f1': 1 } })
    expect(m.rows[0].cost).toBeNull()
    expect(m.savingBaht).toBeNull()
  })
})

describe('customLengthSummaryModel with a group the stock bar cannot cut', () => {
  it('leaves that group out of the saving and counts it', () => {
    const plan = { reason: null, customKg: 19.3, groups: [g(), g({ key: 'p2|f1', profile_id: 'p2', length_m: 6.6, kg: 6.6, bars: [{}] })] }
    const compare = {
      'p1|f1': { base: { length_m: 6.4, newBars: 2, kg: 12.8, feasible: true }, best: { length_m: 6.25, newBars: 2, kg: 12.5 } },
      'p2|f1': { base: { length_m: 6.4, newBars: 0, kg: 0, feasible: false }, best: { length_m: 6.6, newBars: 1, kg: 6.6 } },
    }
    const m = customLengthSummaryModel({ plan, compare, prices: { 'p1|f1': 100, 'p2|f1': 100 }, kgPerM: { 'p1|f1': 1, 'p2|f1': 1 } })
    expect(m.excluded).toBe(1)
    expect(m.savingKg).toBeCloseTo(0.3)
    expect(m.savingBaht).toBeCloseTo(30)
    expect(m.totalKg).toBeCloseTo(19.1)
    expect(m.anyCustom).toBe(true)
    expect(m.rows[1]).toMatchObject({ baseFeasible: false, bestSavingKg: 0 })
  })
  it('flags a profile used in more than one colour', () => {
    const plan = { reason: null, customKg: 0, groups: [g(), g({ key: 'p1|f2', finish_id: 'f2' }), g({ key: 'p2|f1', profile_id: 'p2' })] }
    expect(customLengthSummaryModel({ plan, compare: {}, prices: {}, kgPerM: {} }).rows.map(r => r.sharedProfile)).toEqual([true, true, false])
  })
})

describe('bestLengthsByProfile', () => {
  it('one length per profile (its heaviest colour), skipping ones already in use or without a best', () => {
    const plan = { groups: [g(), g({ key: 'p1|f2', finish_id: 'f2', length_m: 6.4, kg: 3 }), g({ key: 'p2|f1', profile_id: 'p2', length_m: 6.4 }), g({ key: 'p3|f1', profile_id: 'p3', length_m: 6.4 })] }
    const compare = {
      'p1|f1': { base: { kg: 13 }, best: { length_m: 6.5, kg: 12 } }, 'p1|f2': { base: { kg: 3 }, best: { length_m: 4, kg: 2 } },
      'p2|f1': { base: { kg: 6.4 }, best: { length_m: 6.4, kg: 6.4 } }, 'p3|f1': { base: { kg: 1 }, best: null },
    }
    expect(bestLengthsByProfile(plan, compare)).toEqual([{ profile_id: 'p1', length_m: 6.5 }])
  })
})

describe('bomStockBasis', () => {
  const ps = { byProfile: { p1: 6.25 }, projectM: 6 }
  it('a normal job uses the market bar only: no overrides, no project length', () => {
    expect(bomStockBasis('stock', ps)).toEqual({ byProfile: {}, projectM: null })
    expect(bomStockBasis(undefined, ps)).toEqual({ byProfile: {}, projectM: null })
  })
  it('a project job keeps its per-profile lengths but never the project-wide length (same basis as the cut plan)', () => {
    expect(bomStockBasis('custom', ps)).toEqual({ byProfile: { p1: 6.25 }, projectM: null })
  })
})
