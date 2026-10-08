import { describe, it, expect } from 'vitest'
import { pickLatest, resolveKgPrice, findVariant, resolveAluPrice, netPrice, resolvePartPrice } from './aluPrice.js'

const provider = { id: 'p1', price_basis: 'per_kg' }
const finish = { id: 'f1' }
const series = { id: 's1' }
const profile = { id: 'pr1', linear_weight_kg_per_m: 2.5, default_length_m: 6.4 }
const kg = (over) => ({ provider_id: 'p1', finish_id: 'f1', series_id: null, profile_id: null, price_per_kg: 95, effective_from: '2026-01-01', ...over })

describe('pickLatest', () => {
  const rows = [{ effective_from: '2026-01-01', v: 1 }, { effective_from: '2026-06-01', v: 2 }, { effective_from: '2026-12-01', v: 3 }]
  it('takes the newest row on or before asOf', () => {
    expect(pickLatest(rows, '2026-06-01').v).toBe(2)
    expect(pickLatest(rows, '2026-10-08').v).toBe(2)
  })
  it('ignores rows dated after asOf', () => {
    expect(pickLatest(rows, '2025-12-31')).toBeNull()
  })
  it('applies the predicate and tolerates null rows', () => {
    expect(pickLatest(rows, '2026-12-31', r => r.v < 3).v).toBe(2)
    expect(pickLatest(null, '2026-12-31')).toBeNull()
  })
})

describe('resolveKgPrice', () => {
  it('uses provider x finish when nothing is more specific', () => {
    const r = resolveKgPrice({ provider, finish, series, profile, asOf: '2026-10-08', kgPrices: [kg()] })
    expect(r).toMatchObject({ price_per_kg: 95, source: 'provider_finish' })
  })
  it('prefers a series override, then a profile override', () => {
    const rows = [kg(), kg({ series_id: 's1', price_per_kg: 101 }), kg({ profile_id: 'pr1', price_per_kg: 110 })]
    expect(resolveKgPrice({ provider, finish, series, profile, asOf: '2026-10-08', kgPrices: rows }).source).toBe('profile')
    expect(resolveKgPrice({ provider, finish, series, profile, asOf: '2026-10-08', kgPrices: rows.slice(0, 2) })).toMatchObject({ source: 'series', price_per_kg: 101 })
  })
  it('does not leak another colour, another series or another profile', () => {
    const rows = [kg({ finish_id: 'f2' }), kg({ series_id: 's2', price_per_kg: 1 }), kg({ profile_id: 'other', price_per_kg: 2 })]
    expect(resolveKgPrice({ provider, finish, series, profile, asOf: '2026-10-08', kgPrices: rows })).toBeNull()
  })
  it('follows history by date', () => {
    const rows = [kg(), kg({ price_per_kg: 98, effective_from: '2026-06-01' })]
    expect(resolveKgPrice({ provider, finish, series, profile, asOf: '2026-03-01', kgPrices: rows }).price_per_kg).toBe(95)
    expect(resolveKgPrice({ provider, finish, series, profile, asOf: '2026-07-01', kgPrices: rows }).price_per_kg).toBe(98)
  })
  it('coerces numeric strings', () => {
    expect(resolveKgPrice({ provider, finish, series, profile, asOf: '2026-10-08', kgPrices: [kg({ price_per_kg: '95.5' })] }).price_per_kg).toBe(95.5)
  })
})

describe('findVariant', () => {
  const variants = [
    { id: 'a', profile_id: 'pr1', finish_id: 'f1', length_m: 3 },
    { id: 'b', profile_id: 'pr1', finish_id: 'f1', length_m: 6.4 },
    { id: 'c', profile_id: 'pr1', finish_id: 'f2', length_m: 6.4 },
  ]
  it('prefers the length that matches', () => { expect(findVariant(variants, 'pr1', 'f1', 3).id).toBe('a') })
  it('falls back to the longest', () => { expect(findVariant(variants, 'pr1', 'f1', 5).id).toBe('b') })
  it('returns null when profile and colour never meet', () => { expect(findVariant(variants, 'pr1', 'f9', 6.4)).toBeNull() })
})

describe('resolveAluPrice', () => {
  const piece = (over) => ({ variant_id: 'v1', price_per_piece: 1200, effective_from: '2026-01-01', ...over })
  const variants = [{ id: 'v1', profile_id: 'pr1', finish_id: 'f1', length_m: 6.4 }]

  it('per_kg: price per metre = weight per metre x price per kg', () => {
    const r = resolveAluPrice({ provider, series, profile, finish, variants, asOf: '2026-10-08', kgPrices: [kg()], piecePrices: [] })
    expect(r).toMatchObject({ basis: 'per_kg', price_per_kg: 95, price_per_m: 237.5, source: 'provider_finish' })
  })
  it('per_piece: piece price divided by stock length', () => {
    const r = resolveAluPrice({ provider: { ...provider, price_basis: 'per_piece' }, series, profile, finish, variants, asOf: '2026-10-08', kgPrices: [], piecePrices: [piece()] })
    expect(r).toMatchObject({ basis: 'per_piece', price_per_piece: 1200, price_per_m: 187.5, variant_id: 'v1' })
  })
  it('both: kg wins, piece is the fallback', () => {
    const both = { ...provider, price_basis: 'both' }
    expect(resolveAluPrice({ provider: both, series, profile, finish, variants, asOf: '2026-10-08', kgPrices: [kg()], piecePrices: [piece()] }).basis).toBe('per_kg')
    expect(resolveAluPrice({ provider: both, series, profile, finish, variants, asOf: '2026-10-08', kgPrices: [], piecePrices: [piece()] }).basis).toBe('per_piece')
  })
  it('per_kg provider with only piece prices is unresolved, never silently piece-priced', () => {
    expect(resolveAluPrice({ provider, series, profile, finish, variants, asOf: '2026-10-08', kgPrices: [], piecePrices: [piece()] }))
      .toEqual({ unresolved: true, reason: 'no_kg_price' })
  })
  it('per_kg with a zero or missing weight is unresolved', () => {
    for (const w of [0, null, undefined]) {
      expect(resolveAluPrice({ provider, series, profile: { ...profile, linear_weight_kg_per_m: w }, finish, variants, asOf: '2026-10-08', kgPrices: [kg()], piecePrices: [] }))
        .toEqual({ unresolved: true, reason: 'no_weight' })
    }
  })
  it('both with zero or missing weight skips kg and falls back to the piece price', () => {
    const both = { ...provider, price_basis: 'both' }
    for (const w of [0, null, undefined]) {
      const r = resolveAluPrice({ provider: both, series, profile: { ...profile, linear_weight_kg_per_m: w }, finish, variants, asOf: '2026-10-08', kgPrices: [kg()], piecePrices: [piece()] })
      expect(r).toMatchObject({ basis: 'per_piece', price_per_piece: 1200, variant_id: 'v1' })
    }
  })
  it('both with zero weight and no piece price is unresolved "no_weight" (tells the user what to fix)', () => {
    const both = { ...provider, price_basis: 'both' }
    const noWt = { ...profile, linear_weight_kg_per_m: 0 }
    expect(resolveAluPrice({ provider: both, series, profile: noWt, finish, variants, asOf: '2026-10-08', kgPrices: [kg()], piecePrices: [] }))
      .toEqual({ unresolved: true, reason: 'no_weight' })
    expect(resolveAluPrice({ provider: both, series, profile: noWt, finish, variants: [], asOf: '2026-10-08', kgPrices: [kg()], piecePrices: [] }))
      .toEqual({ unresolved: true, reason: 'no_weight' })
  })
  it('per_piece reasons: no variant, then no price', () => {
    const pp = { ...provider, price_basis: 'per_piece' }
    expect(resolveAluPrice({ provider: pp, series, profile, finish, variants: [], asOf: '2026-10-08', kgPrices: [], piecePrices: [] })).toEqual({ unresolved: true, reason: 'no_variant' })
    expect(resolveAluPrice({ provider: pp, series, profile, finish, variants, asOf: '2026-10-08', kgPrices: [], piecePrices: [] })).toEqual({ unresolved: true, reason: 'no_piece_price' })
  })
  it('both with nothing priced is "no_price"', () => {
    expect(resolveAluPrice({ provider: { ...provider, price_basis: 'both' }, series, profile, finish, variants, asOf: '2026-10-08', kgPrices: [], piecePrices: [] }))
      .toEqual({ unresolved: true, reason: 'no_price' })
  })
  it('a price that starts after asOf does not apply', () => {
    expect(resolveAluPrice({ provider, series, profile, finish, variants, asOf: '2025-12-31', kgPrices: [kg()], piecePrices: [] }).unresolved).toBe(true)
  })
})

describe('part prices', () => {
  it('netPrice applies the discount percentage', () => {
    expect(netPrice(1000, 22)).toBeCloseTo(780, 6)
    expect(netPrice(1000)).toBe(1000)
  })
  it('resolvePartPrice returns list, discount and net for the latest row', () => {
    const rows = [
      { part_id: 'x', list_price: 900, discount_pct: 0, effective_from: '2026-01-01' },
      { part_id: 'x', list_price: 1000, discount_pct: 22, effective_from: '2026-06-01' },
      { part_id: 'y', list_price: 5, discount_pct: 0, effective_from: '2026-07-01' },
    ]
    const r = resolvePartPrice({ partId: 'x', asOf: '2026-10-08', partPrices: rows })
    expect(r).toMatchObject({ list_price: 1000, discount_pct: 22 })
    expect(r.net_price).toBeCloseTo(780, 6)
    expect(resolvePartPrice({ partId: 'x', asOf: '2025-01-01', partPrices: rows })).toBeNull()
  })
})

describe('resolveAluPrice -- row_id of the price row used', () => {
  const provider = { id: 'p', price_basis: 'both' }
  const profile = { id: 'pr', linear_weight_kg_per_m: 2, default_length_m: 6 }
  const finish = { id: 'f' }
  const variants = [{ id: 'v', profile_id: 'pr', finish_id: 'f', length_m: 6 }]

  it('per_kg result carries the id of the kg price row', () => {
    const kgPrices = [{ id: 'k1', provider_id: 'p', finish_id: 'f', series_id: null, profile_id: null, price_per_kg: 100, effective_from: '2026-01-01' }]
    const r = resolveAluPrice({ provider, series: null, profile, finish, variants, asOf: '2026-06-01', kgPrices, piecePrices: [] })
    expect(r.basis).toBe('per_kg')
    expect(r.row_id).toBe('k1')
  })

  it('per_piece result carries the id of the piece price row', () => {
    const piecePrices = [{ id: 'pc1', variant_id: 'v', price_per_piece: 600, effective_from: '2026-01-01' }]
    const r = resolveAluPrice({ provider, series: null, profile, finish, variants, asOf: '2026-06-01', kgPrices: [], piecePrices })
    expect(r.basis).toBe('per_piece')
    expect(r.row_id).toBe('pc1')
  })
})
