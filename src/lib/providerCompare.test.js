import { describe, it, expect } from 'vitest'
import { buildCatalogIndex } from './aluCatalogPricing.js'
import { mergeSettings } from './estimationSettings.js'
import { compareProviders, diffAgainst } from './providerCompare.js'

const index = buildCatalogIndex({
  providers: [{ id: 'A', price_basis: 'per_kg' }, { id: 'B', price_basis: 'per_kg' }],
  series: [{ id: 'sA', provider_id: 'A' }, { id: 'sB', provider_id: 'B' }, { id: 'sB2', provider_id: 'B' }],
  finishes: [{ id: 'fA', provider_id: 'A' }, { id: 'fB', provider_id: 'B' }],
  profiles: [
    { id: 'pA', provider_id: 'A', family: 'box', thickness_mm: 1.5, linear_weight_kg_per_m: 1 },
    { id: 'pB', provider_id: 'B', family: 'box', thickness_mm: 1.5, linear_weight_kg_per_m: 1 },
  ],
  seriesProfiles: [{ series_id: 'sA', profile_id: 'pA' }, { series_id: 'sB', profile_id: 'pB' }],
  kgPrices: [
    { id: 'k1', provider_id: 'A', finish_id: 'fA', price_per_kg: 100, effective_from: '2026-01-01' },
    { id: 'k2', provider_id: 'B', finish_id: 'fB', price_per_kg: 90, effective_from: '2026-01-01' },
  ],
})
const template = { id: 't1', waste_pct: 0, grid_row_weights: [1], labor_price_per_sqm: 0, silicone_price_per_m: 0, felt_price_per_m: 0, infill_width_deduction_mm: 0, infill_height_deduction_mm: 0 }
const components = { t1: [{ role_name: 'top', profile_family: 'box', length_rule_type: 'width', length_deduction_mm: 0, quantity_basis: 'fixed', quantity_value: 2 }] }
const item = { id: 'i1', template_id: 't1', width_m: 2, height_m: 1, panel_count: 1, quantity: 3, thickness_mm: 1.5 }
const base = { project: { price_as_of: '2026-06-01' }, items: [item], templatesById: { t1: template }, componentsByTemplate: components, jointsByTemplate: {}, typesById: {}, infillTypesById: {}, index, settings: mergeSettings(null), asOf: '2026-06-01' }

describe('compareProviders', () => {
  it('prices the same items in each candidate series and colour, x quantity', () => {
    const r = compareProviders({ ...base, candidates: [{ providerId: 'A', seriesId: 'sA', finishId: 'fA' }, { providerId: 'B', seriesId: 'sB', finishId: 'fB' }] })
    expect(r[0].aluminium).toBe(2 * 2 * 100 * 3)
    expect(r[1].aluminium).toBe(2 * 2 * 90 * 3)
    expect(r.every(x => x.complete)).toBe(true)
  })
  it('a candidate series without the profile is incomplete and counts the unpriced lines', () => {
    const r = compareProviders({ ...base, candidates: [{ providerId: 'B', seriesId: 'sB2', finishId: 'fB' }] })
    expect(r[0]).toMatchObject({ aluminium: 0, unresolvedLines: 3, complete: false })
  })
  it('a candidate colour from another extruder is unresolved, not silently priced', () => {
    const r = compareProviders({ ...base, candidates: [{ providerId: 'B', seriesId: 'sB', finishId: 'fA' }] })
    expect(r[0].complete).toBe(false)
  })
  it('an item whose template is gone is skipped; no items is incomplete', () => {
    const r = compareProviders({ ...base, items: [{ ...item, template_id: 'gone' }], candidates: [{ providerId: 'A', seriesId: 'sA', finishId: 'fA' }] })
    expect(r[0]).toMatchObject({ itemsPriced: 0, complete: false })
  })
  it('a candidate without finishId is incomplete, zero aluminium, diffAgainst is null', () => {
    const r = compareProviders({ ...base, candidates: [{ providerId: 'A', seriesId: 'sA' }] })
    expect(r[0]).toMatchObject({ aluminium: 0, complete: false })
    expect(diffAgainst({ complete: true, aluminium: 1000 }, r[0])).toBeNull()
  })
  it('an item with height_m 0 is unresolved', () => {
    const r = compareProviders({ ...base, items: [{ ...item, height_m: 0 }], candidates: [{ providerId: 'A', seriesId: 'sA', finishId: 'fA' }] })
    expect(r[0].complete).toBe(false)
    expect(r[0].unresolvedLines).toBeGreaterThanOrEqual(1)
  })
  it('an item with its own series_id and alu_finish_id is still priced in the candidate series', () => {
    const itemWithOwnSeries = { ...item, series_id: 'sB', alu_finish_id: 'fB' }
    const r = compareProviders({ ...base, items: [itemWithOwnSeries], candidates: [{ providerId: 'A', seriesId: 'sA', finishId: 'fA' }] })
    expect(r[0].aluminium).toBe(2 * 2 * 100 * 3)
  })
  it('an item with addon_template_id includes the addon aluminium cost', () => {
    const t2 = { id: 't2', waste_pct: 0, grid_row_weights: [1], labor_price_per_sqm: 0, silicone_price_per_m: 0, felt_price_per_m: 0, infill_width_deduction_mm: 0, infill_height_deduction_mm: 0 }
    const componentsWithAddon = { ...components, t2: [{ role_name: 'addon', profile_family: 'box', length_rule_type: 'width', length_deduction_mm: 0, quantity_basis: 'fixed', quantity_value: 0.5 }] }
    const itemWithAddon = { ...item, addon_template_id: 't2', addon_width_m: 2, addon_height_m: 1 }
    const r = compareProviders({
      ...base,
      items: [itemWithAddon],
      templatesById: { ...base.templatesById, t2 },
      componentsByTemplate: componentsWithAddon,
      candidates: [{ providerId: 'A', seriesId: 'sA', finishId: 'fA' }]
    })
    expect(r[0].aluminium).toBe(1500)
  })
  it('an item with an unresolvable joint is incomplete', () => {
    const componentWithJoint = [{ role_name: 'top', profile_family: 'box', length_rule_type: 'width', length_deduction_mm: 0, quantity_basis: 'fixed', quantity_value: 2, joint_id: 'j1' }]
    const joints = { j1: { main_family: 'nonexistent' } }
    const r = compareProviders({
      ...base,
      componentsByTemplate: { t1: componentWithJoint },
      jointsByTemplate: joints,
      candidates: [{ providerId: 'A', seriesId: 'sA', finishId: 'fA' }]
    })
    expect(r[0].complete).toBe(false)
  })
})

describe('diffAgainst', () => {
  it('amount and percent against the base row', () => {
    expect(diffAgainst({ complete: true, aluminium: 1000 }, { complete: true, aluminium: 960 })).toEqual({ amount: -40, pct: -4 })
  })
  it('is null when either side is incomplete or the base is 0', () => {
    expect(diffAgainst({ complete: true, aluminium: 1000 }, { complete: false, aluminium: 0 })).toBeNull()
    expect(diffAgainst({ complete: false, aluminium: 0 }, { complete: true, aluminium: 5 })).toBeNull()
    expect(diffAgainst({ complete: true, aluminium: 0 }, { complete: true, aluminium: 5 })).toBeNull()
    expect(diffAgainst(null, null)).toBeNull()
  })
})

describe('Follow-up A: an item whose template is missing', () => {
  it('makes the row incomplete, so a diff against a complete base is null', () => {
    const r = compareProviders({ ...base, items: [item, { ...item, id: 'i2', template_id: 'gone', quantity: 2 }], candidates: [{ providerId: 'A', seriesId: 'sA', finishId: 'fA' }] })
    expect(r[0]).toMatchObject({ itemsPriced: 1, unresolvedLines: 2, complete: false })
    expect(diffAgainst({ complete: true, aluminium: 1000 }, r[0])).toBeNull()
  })
})

describe('fix round 1: left-out add-on or infill makes the row incomplete', () => {
  const cand = [{ providerId: 'A', seriesId: 'sA', finishId: 'fA' }]
  it('an add-on template that is not found', () => {
    const r = compareProviders({ ...base, items: [{ ...item, addon_template_id: 'gone', addon_width_m: 1, addon_height_m: 1 }], candidates: cand })
    expect(r[0].complete).toBe(false)
  })
  it('an infill type that is not found', () => {
    const r = compareProviders({ ...base, items: [{ ...item, infill_type_id: 'nope' }], candidates: cand })
    expect(r[0].complete).toBe(false)
  })
})
