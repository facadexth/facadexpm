import { describe, it, expect } from 'vitest'
import { buildCatalogIndex } from './aluCatalogPricing.js'
import { mergeSettings } from './estimationSettings.js'
import { costOpening } from './openingCost.js'

const index = buildCatalogIndex({
  providers: [{ id: 'A', price_basis: 'per_kg' }],
  series: [{ id: 's1', provider_id: 'A' }],
  types: [{ id: 'tSlide' }, { id: 'tFixed' }],
  seriesTypes: [{ series_id: 's1', type_id: 'tSlide', allow_mixed_thickness: true }, { series_id: 's1', type_id: 'tFixed' }],
  finishes: [{ id: 'f1', provider_id: 'A' }],
  profiles: [
    { id: 'box', provider_id: 'A', family: 'box', thickness_mm: 1.5, linear_weight_kg_per_m: 1, depth_mm: 40, primary_contact: 'width' },
    { id: 'bar', provider_id: 'A', family: 'bar', thickness_mm: 1.5, linear_weight_kg_per_m: 1 },
    { id: 'bar2', provider_id: 'A', family: 'bar', thickness_mm: 2, linear_weight_kg_per_m: 2 },
  ],
  seriesProfiles: ['box', 'bar', 'bar2'].map(profile_id => ({ series_id: 's1', profile_id })),
  kgPrices: [{ id: 'k1', provider_id: 'A', finish_id: 'f1', price_per_kg: 100, effective_from: '2026-01-01' }],
  parts: [{ id: 'shim', name: 'shim', kind: 'accessory', unit: 'ตัว' }],
  partPrices: [{ id: 'pp1', part_id: 'shim', list_price: 2, discount_pct: 0, effective_from: '2026-01-01' }],
})
const T = (o = {}) => ({ id: 't1', type_id: 'tSlide', waste_pct: 0, grid_row_weights: [1], labor_price_per_sqm: 0, silicone_price_per_m: 0, felt_price_per_m: 0, infill_width_deduction_mm: 0, infill_height_deduction_mm: 0, ...o })
const comps = [
  { role_name: 'top', profile_family: 'box', length_rule_type: 'width', length_deduction_mm: 0, quantity_basis: 'fixed', quantity_value: 1 },
  { role_name: 'bar', profile_family: 'bar', length_rule_type: 'width', length_deduction_mm: 0, quantity_basis: 'fixed', quantity_value: 2, joint_id: 'j1', joint_ends: 2 },
]
const joints = [{ id: 'j1', main_family: 'box', secondary_family: 'bar', deduction_mode: 'auto', cut_style: 'square' }]
const ctxBase = () => ({
  item: { width_m: 2, height_m: 1, panel_count: 1, quantity: 1, template_id: 't1' },
  project: { default_series_id: 's1', default_finish_id: 'f1', default_thickness_mm: 1.5 },
  template: T(), componentsByTemplate: { t1: comps }, hardwareByTemplate: {}, jointsByTemplate: { t1: joints },
  typesById: index.types, infillTypesById: {}, index, settings: mergeSettings(null), asOf: '2026-06-01',
})

describe('costOpening', () => {
  it('inherits series/colour/thickness from the project, applies the joint deduction, prices through the catalog', () => {
    const r = costOpening(ctxBase())
    // top: 2 m x 1 kg/m x 100 = 200 ; bar: (2 - 2 x 0.040) m x 2 pieces x 1 kg/m x 100 = 384
    expect(r.bom.profileLines[0].cost).toBeCloseTo(200)
    expect(r.bom.profileLines[1].length_m).toBeCloseTo(1.92)
    expect(r.bom.profileLines[1].cost).toBeCloseTo(384)
    expect(r.total).toBeCloseTo(584)
    expect(r.unresolved).toEqual([])
  })
  it('an unresolvable joint is reported and the component keeps the template\'s own length', () => {
    const c = ctxBase()
    c.jointsByTemplate = { t1: [{ ...joints[0], main_family: 'missing' }] }
    const r = costOpening(c)
    expect(r.bom.profileLines[1].length_m).toBe(2)
    expect(r.issues).toEqual([{ role_name: 'bar', reason: 'no_main_profile' }])
    expect(r.unresolved.some(u => u.reason === 'no_main_profile')).toBe(true)
  })
  it('a sash-role component is priced at the sash thickness only where the series+type allows mixed thickness', () => {
    const c = ctxBase()
    c.project = { ...c.project, default_thickness_mm: 1.5, default_sash_thickness_mm: 2 }
    c.componentsByTemplate = { t1: [{ ...comps[0], thickness_role: 'sash', profile_family: 'bar' }, { ...comps[0], role_name: 'frame', profile_family: 'bar' }] }
    const r = costOpening(c)
    expect(r.bom.profileLines.map(l => l.thickness_mm)).toEqual([2, 1.5])
    c.template = T({ type_id: 'tFixed' })
    expect(costOpening(c).bom.profileLines.map(l => l.thickness_mm)).toEqual([1.5, 1.5])
  })
  it('an item\'s own sash thickness wins over the project default', () => {
    const c = ctxBase()
    c.project = { ...c.project, default_sash_thickness_mm: 1.5 }
    c.item = { ...c.item, sash_thickness_mm: 2 }
    c.componentsByTemplate = { t1: [{ ...comps[0], thickness_role: 'sash', profile_family: 'bar' }] }
    expect(costOpening(c).bom.profileLines[0].thickness_mm).toBe(2)
  })
  it('adds the add-on BOM and the accessory extras (shim x fixing points) to the total', () => {
    const c = ctxBase()
    c.settings = mergeSettings({ shim_part_id: 'shim' })
    c.addonTemplate = T({ id: 't2' })
    c.componentsByTemplate = { t1: comps.slice(0, 1), t2: comps.slice(0, 1) }
    c.item = { ...c.item, addon_template_id: 't2', addon_width_m: 2, addon_height_m: 0.5 }
    const r = costOpening(c)
    expect(r.addonBom.totalCost).toBeCloseTo(200)
    // main 2 x 1: 2 x 5 + 2 x 3 = 16 points; add-on 2 x 0.5: 2 x 5 + 2 x 2 = 14 points; 30 shims x 2 baht = 60
    expect(r.extras.points).toBe(30)
    expect(r.extras.cost).toBe(60)
    expect(r.total).toBeCloseTo(200 + 200 + 60)
  })
  it('no series chosen anywhere is unresolved with a reason, never a silent 0 total', () => {
    const c = ctxBase()
    c.project = {}
    const r = costOpening(c)
    expect(r.unresolved.length).toBeGreaterThan(0)
    expect(r.bom.profileLines[0].reason).toBe('no_series')
  })
  it('an add-on without a size is ignored (partially filled = no add-on yet)', () => {
    const c = ctxBase()
    c.addonTemplate = T({ id: 't2' })
    c.item = { ...c.item, addon_template_id: 't2', addon_width_m: 2 }
    expect(costOpening(c).addonBom).toBeNull()
  })
  it('string width/height (DB numerics) cost the same as numbers', () => {
    const c = ctxBase()
    c.item = { ...c.item, width_m: '2', height_m: '1' }
    expect(costOpening(c).total).toBeCloseTo(584)
  })
  it('a missing main height is flagged no_dimension, never a silent 0', () => {
    const c = ctxBase()
    c.item = { ...c.item, height_m: undefined }
    const r = costOpening(c)
    expect(r.unresolved).toContainEqual({ name: 'ขนาดช่องเปิด', reason: 'no_dimension', source: 'main' })
  })
  it('every unresolved entry has exactly name/reason/source, joint failures included', () => {
    const c = ctxBase()
    c.jointsByTemplate = { t1: [{ ...joints[0], main_family: 'missing' }] }
    c.project = { ...c.project, default_series_id: undefined }
    const r = costOpening(c)
    expect(r.unresolved.length).toBeGreaterThan(0)
    r.unresolved.forEach(u => expect(Object.keys(u).sort()).toEqual(['name', 'reason', 'source']))
    const c2 = ctxBase()
    c2.jointsByTemplate = { t1: [{ ...joints[0], main_family: 'missing' }] }
    expect(costOpening(c2).unresolved).toContainEqual({ name: 'bar', reason: 'no_main_profile', source: 'joint' })
  })
  it('an infill id missing from infillTypesById is flagged unknown_infill', () => {
    const c = ctxBase()
    c.item = { ...c.item, infill_type_id: 'ghost' }
    expect(costOpening(c).unresolved).toContainEqual({ name: 'วัสดุอุดช่อง', reason: 'unknown_infill', source: 'main' })
  })
})

describe('costOpening reports an add-on it could not cost', () => {
  it('unknown add-on template, zero add-on size; a normal add-on adds nothing', () => {
    const c = ctxBase()
    c.item = { ...c.item, addon_template_id: 't2', addon_width_m: 2, addon_height_m: 0.5 }
    expect(costOpening(c).unresolved).toContainEqual({ name: 'ชุดต่อเติม', reason: 'unknown_addon_template', source: 'addon' })
    c.addonTemplate = T({ id: 't2' })
    c.componentsByTemplate = { t1: comps.slice(0, 1), t2: comps.slice(0, 1) }
    expect(costOpening(c).unresolved).toEqual([])
    c.item = { ...c.item, addon_height_m: 0 }
    expect(costOpening(c).unresolved).toContainEqual({ name: 'ชุดต่อเติม', reason: 'no_dimension', source: 'addon' })
  })
})
