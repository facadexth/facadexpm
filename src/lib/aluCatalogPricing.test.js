// src/lib/aluCatalogPricing.test.js
import { describe, it, expect } from 'vitest'
import { buildCatalogIndex, resolveCatalogProfile, makeCatalogPricing } from './aluCatalogPricing.js'

const rows = () => ({
  providers: [{ id: 'p1', price_basis: 'per_kg' }, { id: 'p2', price_basis: 'per_piece' }],
  series: [{ id: 's1', provider_id: 'p1' }, { id: 's2', provider_id: 'p2' }],
  profiles: [
    { id: 'pr1', provider_id: 'p1', thickness_mm: 1.2, linear_weight_kg_per_m: 1.5, default_length_m: 6.4, active: true },
    { id: 'pr2', provider_id: 'p2', thickness_mm: 1.2, linear_weight_kg_per_m: 0.9, default_length_m: 6, active: true },
  ],
  seriesProfiles: [
    { id: 'l1', series_id: 's1', profile_id: 'pr1', family: 'Frame' },
    { id: 'l2', series_id: 's2', profile_id: 'pr2', family: 'Frame' },
  ],
  finishes: [{ id: 'f1', provider_id: 'p1' }, { id: 'f2', provider_id: 'p2' }],
  variants: [{ id: 'v2', profile_id: 'pr2', finish_id: 'f2', length_m: 6 }],
  parts: [
    { id: 'set1', name: 'Set', code: 'P-0001', kind: 'hardware_set' },
    { id: 'pt1', name: 'Lock', code: 'P-0002', kind: 'hardware' },
    { id: 'pt2', name: 'Hinge', code: 'P-0003', kind: 'hardware' },
  ],
  setItems: [{ id: 'i1', set_id: 'set1', part_id: 'pt1', quantity: 2 }, { id: 'i2', set_id: 'set1', part_id: 'pt2', quantity: 1 }],
  kgPrices: [
    { id: 'k1', provider_id: 'p1', finish_id: 'f1', series_id: null, profile_id: null, price_per_kg: 100, effective_from: '2026-01-01' },
    { id: 'k2', provider_id: 'p1', finish_id: 'f1', series_id: null, profile_id: null, price_per_kg: 120, effective_from: '2026-09-01' },
  ],
  piecePrices: [{ id: 'pc1', variant_id: 'v2', price_per_piece: 600, effective_from: '2026-01-01' }],
  partPrices: [{ id: 'pp1', part_id: 'pt1', list_price: 100, discount_pct: 10, effective_from: '2026-01-01' }],
})

describe('resolveCatalogProfile', () => {
  const index = buildCatalogIndex(rows())
  it('finds the profile linked to the series with that family and thickness', () => {
    expect(resolveCatalogProfile(index, 's1', 'Frame', 1.2).profile.id).toBe('pr1')
  })
  it('returns null for another thickness, family or series', () => {
    expect(resolveCatalogProfile(index, 's1', 'Frame', 1.5).profile).toBeNull()
    expect(resolveCatalogProfile(index, 's1', 'Other', 1.2).profile).toBeNull()
    expect(resolveCatalogProfile(index, 'nope', 'Frame', 1.2).profile).toBeNull()
  })
  it('skips inactive profiles', () => {
    const r = rows(); r.profiles[0].active = false
    expect(resolveCatalogProfile(buildCatalogIndex(r), 's1', 'Frame', 1.2).profile).toBeNull()
  })
  it('picks the lowest id and flags ambiguous when two profiles match', () => {
    const r = rows()
    r.profiles.push({ id: 'pr0', provider_id: 'p1', thickness_mm: 1.2, linear_weight_kg_per_m: 1.4, default_length_m: 6.4, active: true })
    r.seriesProfiles.push({ id: 'l3', series_id: 's1', profile_id: 'pr0', family: 'Frame' })
    const res = resolveCatalogProfile(buildCatalogIndex(r), 's1', 'Frame', 1.2)
    expect(res.profile.id).toBe('pr0')
    expect(res.ambiguous).toBe(true)
  })
})

describe('makeCatalogPricing.profileLine', () => {
  const index = buildCatalogIndex(rows())
  const line = (opts, input = {}) =>
    makeCatalogPricing({ index, seriesId: 's1', finishId: 'f1', asOf: '2026-06-01', ...opts })
      .profileLine({ role_name: 'Top rail', family: 'Frame', length_m: 2, quantity: 2, thickness_mm: 1.2, ...input })

  it('per_kg: weight x price, as of the date, with the price row id', () => {
    const l = line()
    expect(l.resolved).toBe(true)
    expect(l.weight_kg).toBeCloseTo(6)        // 2 m x 2 x 1.5 kg/m
    expect(l.cost).toBeCloseTo(600)           // 6 kg x 100
    expect(l.price_row_id).toBe('k1')
    expect(l.reason).toBeNull()
  })
  it('a price dated after asOf is ignored; a later asOf picks it up', () => {
    expect(line({ asOf: '2026-06-01' }).price_row_id).toBe('k1')
    expect(line({ asOf: '2026-10-01' }).cost).toBeCloseTo(720)
    expect(line({ asOf: '2026-10-01' }).price_row_id).toBe('k2')
  })
  it('per_piece: cost from the piece price spread over the stock length', () => {
    const l = line({ seriesId: 's2', finishId: 'f2' })
    expect(l.resolved).toBe(true)
    expect(l.basis).toBe('per_piece')
    expect(l.cost).toBeCloseTo(2 * 2 * (600 / 6))  // 400
    expect(l.weight_kg).toBeCloseTo(2 * 2 * 0.9)   // informational
    expect(l.price_row_id).toBe('pc1')
  })
  it('unresolved reasons are explicit and cost is 0 (never silent)', () => {
    expect(line({ seriesId: null })).toMatchObject({ resolved: false, reason: 'no_series', cost: 0 })
    expect(line({ finishId: null })).toMatchObject({ resolved: false, reason: 'no_finish', cost: 0 })
    expect(line({}, { family: 'Nope' })).toMatchObject({ resolved: false, reason: 'no_profile' })
    expect(line({}, { thickness_mm: 9 })).toMatchObject({ resolved: false, reason: 'no_profile' })
    expect(line({ asOf: '2025-01-01' })).toMatchObject({ resolved: false, reason: 'no_kg_price', cost: 0 })
  })
  it('a colour of another extruder is never priced (Review Focus 1)', () => {
    expect(line({ finishId: 'f2' })).toMatchObject({ resolved: false, reason: 'finish_other_provider', cost: 0 })
  })
  it('flags an ambiguous profile match on a resolved line (Review Focus 6)', () => {
    const r = rows()
    r.profiles.push({ id: 'pr0', provider_id: 'p1', thickness_mm: 1.2, linear_weight_kg_per_m: 1.4, default_length_m: 6.4, active: true })
    r.seriesProfiles.push({ id: 'l3', series_id: 's1', profile_id: 'pr0', family: 'Frame' })
    const l = makeCatalogPricing({ index: buildCatalogIndex(r), seriesId: 's1', finishId: 'f1', asOf: '2026-06-01' })
      .profileLine({ role_name: 'X', family: 'Frame', length_m: 1, quantity: 1, thickness_mm: 1.2 })
    expect(l.ambiguous).toBe(true)
    expect(l.profile_id).toBe('pr0')
  })
})

describe('makeCatalogPricing.hardwarePrice', () => {
  const pricing = makeCatalogPricing({ index: buildCatalogIndex(rows()), seriesId: 's1', finishId: 'f1', asOf: '2026-06-01' })
  it('uses the net part price when the hardware line points at a priced part', () => {
    expect(pricing.hardwarePrice({ part_id: 'pt1', reference_unit_price: 50 })).toMatchObject({ unit_price: 90, source: 'part', price_row_id: 'pp1' })
  })
  it('falls back to the reference price with no part, or a part with no price', () => {
    expect(pricing.hardwarePrice({ part_id: null, reference_unit_price: 50 })).toMatchObject({ unit_price: 50, source: 'reference', price_row_id: null })
    expect(pricing.hardwarePrice({ part_id: 'pt2', reference_unit_price: 40 })).toMatchObject({ unit_price: 40, source: 'reference' })
  })
})

describe('makeCatalogPricing.setLines', () => {
  const pricing = makeCatalogPricing({ index: buildCatalogIndex(rows()), seriesId: 's1', finishId: 'f1', asOf: '2026-06-01' })
  it('prices each set item; an unpriced part is listed unresolved with cost 0 (Review Focus 5)', () => {
    const lines = pricing.setLines('set1')
    expect(lines).toHaveLength(2)
    const lock = lines.find(l => l.name === 'Lock')
    const hinge = lines.find(l => l.name === 'Hinge')
    expect(lock).toMatchObject({ quantity: 2, unit_price: 90, cost: 180, resolved: true, code: 'P-0002' })
    expect(hinge).toMatchObject({ quantity: 1, cost: 0, resolved: false })
  })
  it('no set chosen (null/undefined) is a real "no set": no lines', () => {
    expect(pricing.setLines(null)).toEqual([])
    expect(pricing.setLines(undefined)).toEqual([])
  })
  it('an unknown set id is one unresolved line, never silently empty', () => {
    expect(pricing.setLines('nope')).toEqual([expect.objectContaining({ name: 'ชุดอุปกรณ์', reason: 'unknown_set', resolved: false, cost: 0 })])
  })
  it('a part that is not a hardware_set is unresolved not_hardware_set', () => {
    expect(pricing.setLines('pt1')).toEqual([expect.objectContaining({ reason: 'not_hardware_set', resolved: false, cost: 0 })])
  })
  it('a hardware_set with zero items is unresolved empty_set', () => {
    const r = rows(); r.parts.push({ id: 'set2', name: 'Empty', code: 'P-0009', kind: 'hardware_set' })
    const p = makeCatalogPricing({ index: buildCatalogIndex(r), seriesId: 's1', finishId: 'f1', asOf: '2026-06-01' })
    expect(p.setLines('set2')).toEqual([expect.objectContaining({ reason: 'empty_set', resolved: false, cost: 0 })])
  })
})

describe('makeCatalogPricing asOf guard', () => {
  const bad = [undefined, null, '', 'today', new Date('2026-06-01'), '2026-6-1']
  for (const asOf of bad) {
    it('asOf=' + String(asOf) + ' prices nothing', () => {
      const p = makeCatalogPricing({ index: buildCatalogIndex(rows()), seriesId: 's1', finishId: 'f1', asOf })
      expect(p.profileLine({ role_name: 'R', family: 'Frame', length_m: 2, quantity: 2, thickness_mm: 1.2 }))
        .toMatchObject({ resolved: false, reason: 'no_as_of', cost: 0 })
      expect(p.hardwarePrice({ part_id: 'pt1', reference_unit_price: 50 }))
        .toMatchObject({ unit_price: 0, source: 'reference', unresolved: true, reason: 'no_as_of' })
      const lines = p.setLines('set1')
      expect(lines).toHaveLength(2)
      for (const l of lines) expect(l).toMatchObject({ resolved: false, reason: 'no_as_of', cost: 0, unit_price: 0 })
    })
  }
  it('a valid date still prices normally', () => {
    const p = makeCatalogPricing({ index: buildCatalogIndex(rows()), seriesId: 's1', finishId: 'f1', asOf: '2026-06-01' })
    expect(p.profileLine({ role_name: 'R', family: 'Frame', length_m: 2, quantity: 2, thickness_mm: 1.2 }).resolved).toBe(true)
  })
})

describe('resolveCatalogProfile family fallback', () => {
  it('link.family null falls back to profile.family', () => {
    const r = rows(); r.seriesProfiles[0].family = null; r.profiles[0].family = 'Frame'
    expect(resolveCatalogProfile(buildCatalogIndex(r), 's1', 'Frame', 1.2).profile.id).toBe('pr1')
  })
  it('whitespace on either side matches', () => {
    const r = rows(); r.seriesProfiles[0].family = ' Frame '
    expect(resolveCatalogProfile(buildCatalogIndex(r), 's1', 'Frame', 1.2).profile.id).toBe('pr1')
    expect(resolveCatalogProfile(buildCatalogIndex(rows()), 's1', '  Frame\t', 1.2).profile.id).toBe('pr1')
  })
  it('no family anywhere gives no_profile', () => {
    const r = rows(); r.seriesProfiles[0].family = null
    expect(resolveCatalogProfile(buildCatalogIndex(r), 's1', 'Frame', 1.2).profile).toBeNull()
    const p = makeCatalogPricing({ index: buildCatalogIndex(r), seriesId: 's1', finishId: 'f1', asOf: '2026-06-01' })
    expect(p.profileLine({ role_name: 'R', family: 'Frame', length_m: 1, quantity: 1, thickness_mm: 1.2 }).reason).toBe('no_profile')
  })
})
