import { describe, it, expect } from 'vitest'
import { buildCatalogIndex } from './aluCatalogPricing.js'
import { mergeSettings } from './estimationSettings.js'
import { compareProviders } from './providerCompare.js'

const index = buildCatalogIndex({
  providers: [{ id: 'A', price_basis: 'per_kg' }],
  seriesFamilies: [{ id: 'famA', provider_id: 'A', name: 'EURO' }],
  series: [{ id: 'sFix', provider_id: 'A', name: 'EURO Fixed', series_family_id: 'famA' }, { id: 'sSl', provider_id: 'A', name: 'EURO Slide', series_family_id: 'famA' }],
  types: [{ id: 'fixed' }, { id: 'slide' }, { id: 'casement' }],
  seriesTypes: [{ id: 'l1', series_id: 'sFix', type_id: 'fixed' }, { id: 'l2', series_id: 'sSl', type_id: 'slide' }],
  finishes: [{ id: 'fA', provider_id: 'A' }],
  profiles: [{ id: 'pA', provider_id: 'A', family: 'box', thickness_mm: 1.5, linear_weight_kg_per_m: 1 }],
  seriesProfiles: [{ series_id: 'sFix', profile_id: 'pA' }, { series_id: 'sSl', profile_id: 'pA' }],
  kgPrices: [{ id: 'k1', provider_id: 'A', finish_id: 'fA', price_per_kg: 100, effective_from: '2026-01-01' }],
})
const seriesTypes = Object.values(index.seriesTypesBySeries).flat()
const tpl = (id, type_id) => ({ id, type_id, waste_pct: 0, grid_row_weights: [1], labor_price_per_sqm: 0, silicone_price_per_m: 0, felt_price_per_m: 0, infill_width_deduction_mm: 0, infill_height_deduction_mm: 0 })
const templatesById = { tF: tpl('tF', 'fixed'), tS: tpl('tS', 'slide'), tC: tpl('tC', 'casement') }
const comp = [{ role_name: 'top', profile_family: 'box', length_rule_type: 'width', length_deduction_mm: 0, quantity_basis: 'fixed', quantity_value: 2 }]
const componentsByTemplate = { tF: comp, tS: comp, tC: comp }
const item = (id, template_id) => ({ id, opening_no: id, template_id, width_m: 2, height_m: 1, panel_count: 1, quantity: 1, thickness_mm: 1.5 })
const base = { project: { price_as_of: '2026-06-01' }, templatesById, componentsByTemplate, jointsByTemplate: {}, typesById: index.types, infillTypesById: {}, index, settings: mergeSettings(null), asOf: '2026-06-01', seriesTypes }

describe('compareProviders with a family candidate', () => {
  it("each item is priced in the family's series for its type", () => {
    const [r] = compareProviders({ ...base, items: [item('F1', 'tF'), item('S1', 'tS')], candidates: [{ providerId: 'A', seriesKey: 'famA', finishId: 'fA' }] })
    expect(r).toMatchObject({ aluminium: 2 * 2 * 100 * 2, complete: true, itemsPriced: 2 })
  })
  it('a type the family has no series for is unresolved and named, never priced in another series', () => {
    const [r] = compareProviders({ ...base, items: [item('F1', 'tF'), item('C1', 'tC')], candidates: [{ providerId: 'A', seriesKey: 'famA', finishId: 'fA' }] })
    expect(r.complete).toBe(false)
    expect(r.unresolvedLines).toBe(1)
    expect(r.failedItems).toEqual([{ id: 'C1', opening_no: 'C1', text: 'ซีรีส์หลักนี้ไม่มีชุดสำหรับประเภทนี้' }])
  })
  it('a candidate with neither seriesKey nor seriesId is pending', () => {
    const [r] = compareProviders({ ...base, items: [item('F1', 'tF')], candidates: [{ providerId: 'A', seriesKey: '', finishId: 'fA' }] })
    expect(r).toMatchObject({ aluminium: 0, complete: false })
  })
})
