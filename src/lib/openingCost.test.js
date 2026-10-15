import { describe, it, expect } from 'vitest'
import { buildCatalogIndex } from './aluCatalogPricing.js'
import { mergeSettings } from './estimationSettings.js'
import { costOpening, buttOfFor, widthOfFor } from './openingCost.js'
import { startModel } from './partModel.js'

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

describe('costOpening with a project hardware package', () => {
  it('passes the package rows on: a type the package does not cover resolves no set, a none row stays none', () => {
    const c = ctxBase()
    c.project = { ...c.project, default_hardware_set_id: 'legacySet' }
    expect(costOpening(c).resolved.hardware_set_id).toBe('legacySet')
    expect(costOpening({ ...c, packageItems: [] }).resolved.hardware_set_id).toBeNull()
    expect(costOpening({ ...c, packageItems: [{ type_id: 'tSlide', hardware_set_id: 'setA' }] }).resolved.hardware_set_id).toBe('setA')
    expect(costOpening({ ...c, packageItems: [{ type_id: 'tSlide', hardware_set_id: null }] }).resolved.hardware_set_id).toBeNull()
  })
})

// ---- part-model templates (layout_kind) ----

const pIndex = buildCatalogIndex({
  providers: [{ id: 'A', price_basis: 'per_kg' }],
  series: [{ id: 's1', provider_id: 'A' }],
  types: [{ id: 'tSlide' }],
  seriesTypes: [{ series_id: 's1', type_id: 'tSlide', allow_mixed_thickness: true }],
  finishes: [{ id: 'f1', provider_id: 'A' }],
  profiles: [
    { id: 'fh', provider_id: 'A', family: 'fh', thickness_mm: 1.5, linear_weight_kg_per_m: 1, butt_distance_mm: 20, depth_mm: 99 },
    { id: 'fs', provider_id: 'A', family: 'fs', thickness_mm: 1.5, linear_weight_kg_per_m: 1, butt_distance_mm: '25' },
    { id: 'sr', provider_id: 'A', family: 'sr', thickness_mm: 1.5, linear_weight_kg_per_m: 1, butt_distance_mm: 10 },
    { id: 'sr2', provider_id: 'A', family: 'sr', thickness_mm: 2, linear_weight_kg_per_m: 2, butt_distance_mm: 12 },
    { id: 'ks', provider_id: 'A', family: 'ks', thickness_mm: 1.5, linear_weight_kg_per_m: 1, butt_distance_mm: 30 },
    { id: 'hs', provider_id: 'A', family: 'hs', thickness_mm: 1.5, linear_weight_kg_per_m: 1, depth_mm: 35, width_mm: 60, primary_contact: 'width' },
    { id: 'hd', provider_id: 'A', family: 'hd', thickness_mm: 1.5, linear_weight_kg_per_m: 1, depth_mm: 35, width_mm: 60, primary_contact: 'depth' },
    { id: 'z0', provider_id: 'A', family: 'zero', thickness_mm: 1.5, linear_weight_kg_per_m: 1, butt_distance_mm: 0, depth_mm: 40 },
    { id: 'bare', provider_id: 'A', family: 'bare', thickness_mm: 1.5, linear_weight_kg_per_m: 1 },
  ],
  seriesProfiles: ['fh', 'fs', 'sr', 'sr2', 'ks', 'hs', 'hd', 'z0', 'bare'].map(profile_id => ({ series_id: 's1', profile_id })),
  kgPrices: [{ id: 'k1', provider_id: 'A', finish_id: 'f1', price_per_kg: 100, effective_from: '2026-01-01' }],
})

describe('buttOfFor (Ruling PE-4: profile butt distance, else the legacy joint rule, else null)', () => {
  const buttOf = buttOfFor({ index: pIndex, seriesId: 's1', thicknessMmByFamily: { sr: 2 }, thicknessMm: 1.5 })
  it('the profile\'s own butt_distance_mm wins over its depth (strings and 0 included)', () => {
    expect(buttOf('fh')).toBe(20)
    expect(buttOf('fs')).toBe(25)
    expect(buttOf('zero')).toBe(0)
  })
  it('looks the profile up at the family\'s own thickness', () => {
    expect(buttOf('sr')).toBe(12)
    expect(buttOfFor({ index: pIndex, seriesId: 's1', thicknessMm: 1.5 })('sr')).toBe(10)
  })
  it('falls back to the legacy automatic rule: depth for a wide-face contact, width for a narrow-face contact', () => {
    expect(buttOf('hs')).toBe(35)
    expect(buttOf('hd')).toBe(60)
  })
  it('null when neither exists, for an unknown family, without a series or a thickness', () => {
    expect(buttOf('bare')).toBeNull()
    expect(buttOf('ghost')).toBeNull()
    expect(buttOf('')).toBeNull()
    expect(buttOfFor({ index: pIndex, seriesId: null, thicknessMm: 1.5 })('fh')).toBeNull()
    expect(buttOfFor({ index: pIndex, seriesId: 's1' })('fh')).toBeNull()
    expect(buttOfFor({ index: null, seriesId: 's1', thicknessMm: 1.5 })('fh')).toBeNull()
  })
  it('widthOfFor gives the resolved profile\'s width_mm or null', () => {
    const widthOf = widthOfFor({ index: pIndex, seriesId: 's1', thicknessMm: 1.5 })
    expect(widthOf('hs')).toBe(60)
    expect(widthOf('bare')).toBeNull()
  })
})

const FAMS = { frame_top: 'fh', frame_bottom: 'fh', frame_side: 'fs', sash_top: 'sr', sash_bottom: 'sr', key_stile: 'ks', hook_stile: 'hs' }
const partModel = (fams = FAMS) => {
  const m = startModel('sliding_2')
  for (const [k, f] of Object.entries(fams)) m.lines[k][0].profile_family = f
  return m
}
const pCtx = (model = partModel()) => ({
  item: { width_m: 2, height_m: 1, panel_count: 1, quantity: 1, template_id: 'tp' },
  project: { default_series_id: 's1', default_finish_id: 'f1', default_thickness_mm: 1.5 },
  template: T({ id: 'tp', name: 'บานเลื่อน 2', layout_kind: 'sliding_2' }), componentsByTemplate: {}, hardwareByTemplate: {}, jointsByTemplate: {},
  partModelByTemplate: model ? { tp: model } : {},
  typesById: pIndex.types, infillTypesById: {}, index: pIndex, settings: mergeSettings(null), asOf: '2026-06-01',
})

describe('costOpening for a part-model template (layout_kind)', () => {
  it('expands the model into engine components and prices them', () => {
    const r = costOpening(pCtx())
    const rows = r.bom.profileLines.map(l => [l.role_name, l.family, Math.round(l.length_m * 1e6) / 1e6, l.quantity])
    // frame top/bottom 2000 - 2 x 25 (side frame butt) ; side frames 1000 through
    // sash rails ((2000 - 2 x 25 + 35 hook overlap) x 0.5) - 35 (hook end, legacy depth rule) - 30 (key end) = 927.5
    // stiles 1000 - (20 + 20)
    expect(rows).toEqual([
      ['เฟรมบน', 'fh', 1.95, 1], ['เฟรมล่าง', 'fh', 1.95, 1], ['เฟรมข้าง', 'fs', 1, 2],
      ['บานเลื่อนบน', 'sr', 0.9275, 2], ['บานเลื่อนล่าง', 'sr', 0.9275, 2],
      ['เสากุญแจ', 'ks', 0.96, 2], ['เสาเกี่ยว', 'hs', 0.96, 2],
    ])
    expect(r.bom.profileLines.every(l => l.resolved)).toBe(true)
    expect(r.unresolved).toEqual([])
    expect(r.total).toBeCloseTo(100 * (1.95 * 2 + 2 + 0.9275 * 4 + 0.96 * 4))
  })
  it('a butted profile without any butt distance is unresolved (no_butt_distance), never a silent 0', () => {
    const r = costOpening(pCtx(partModel({ ...FAMS, key_stile: 'bare' })))
    expect(r.unresolved).toContainEqual({ name: 'บานเลื่อนบน', reason: 'no_butt_distance', source: 'joint' })
    expect(r.unresolved).toContainEqual({ name: 'บานเลื่อนล่าง', reason: 'no_butt_distance', source: 'joint' })
    expect(r.issues).toContainEqual({ role_name: 'บานเลื่อนบน', reason: 'no_butt_distance' })
  })
  it('sash-role lines are priced at the sash thickness where the series+type allows it', () => {
    const m = partModel()
    m.lines.key_stile[0].thickness_role = null
    m.lines.hook_stile[0].thickness_role = null
    const c = pCtx(m)
    c.project = { ...c.project, default_sash_thickness_mm: 2 }
    const r = costOpening(c)
    const rail = r.bom.profileLines.find(l => l.role_name === 'บานเลื่อนบน')
    expect(rail.thickness_mm).toBe(2)
    expect(rail.length_m).toBeCloseTo(0.9275)
    expect(r.bom.profileLines.find(l => l.role_name === 'เฟรมบน').thickness_mm).toBe(1.5)
    expect(r.unresolved).toEqual([])
  })
  it('a position without a profile family and a corner violation are listed', () => {
    const m = partModel({ ...FAMS, key_stile: '' })
    m.lines.frame_side[0].ends[0][0] = { mode: 'butt', to: null, deduction_mm: 5 }
    const r = costOpening(pCtx(m))
    expect(r.unresolved).toContainEqual({ name: 'เสากุญแจ', reason: 'no_profile_family', source: 'joint' })
    expect(r.unresolved.some(u => u.reason === 'corner_violation' && u.source === 'joint')).toBe(true)
  })
  it('a layout_kind template with no model in ctx does not throw and says no_model', () => {
    for (const c of [pCtx(null), { ...pCtx(), partModelByTemplate: undefined }]) {
      const r = costOpening(c)
      expect(r.bom.profileLines).toEqual([])
      expect(r.unresolved).toContainEqual({ name: 'บานเลื่อน 2', reason: 'no_model', source: 'joint' })
    }
  })
  it('the add-on template may be a part-model template too', () => {
    const c = pCtx()
    c.template = T({ id: 't1' })
    c.componentsByTemplate = { t1: [] }
    c.addonTemplate = T({ id: 'tp', layout_kind: 'sliding_2' })
    c.item = { ...c.item, template_id: 't1', addon_template_id: 'tp', addon_width_m: 2, addon_height_m: 1 }
    const r = costOpening(c)
    expect(r.addonBom.profileLines).toHaveLength(7)
    expect(r.unresolved).toEqual([])
  })
})

describe('isolation: a template without layout_kind is untouched by part models', () => {
  it('costs byte-for-byte as before, even with partModelByTemplate in ctx (also for the template\'s own id)', () => {
    const before = costOpening(ctxBase())
    const withModels = costOpening({ ...ctxBase(), partModelByTemplate: { t1: partModel(), tp: partModel() } })
    expect(JSON.stringify(withModels)).toBe(JSON.stringify(before))
    expect(withModels.total).toBeCloseTo(584)
    const j = ctxBase(); j.jointsByTemplate = { t1: [{ ...joints[0], main_family: 'missing' }] }
    expect(JSON.stringify(costOpening({ ...j, partModelByTemplate: { t1: partModel() } }))).toBe(JSON.stringify(costOpening(j)))
  })
})

// ---- Task 9: every layout kind; the item's layout_params ----
import { partPreviewCtx, modelForItem } from './openingCost.js'
import { cycleCellKind } from './partModel.js'

const famAll = (m, fams) => {
  const out = JSON.parse(JSON.stringify(m))
  for (const k of Object.keys(out.lines)) out.lines[k][0].profile_family = fams[k] || (k.startsWith('frame') ? 'fh' : 'sr')
  return out
}
const kCtx = (model, kind, item = {}) => ({
  ...pCtx(model),
  template: T({ id: 'tp', name: `แบบ ${kind}`, layout_kind: kind }),
  item: { width_m: 2, height_m: 1.5, panel_count: 1, quantity: 1, template_id: 'tp', ...item },
})
const qty = (r, role) => r.bom.profileLines.filter(l => l.role_name.startsWith(role)).reduce((s, l) => s + l.quantity, 0)

describe('costOpening: the item\'s layout_params override the template\'s for estimator inputs only', () => {
  // R-F1: the left sash's families; the middle / right sashes follow them (familyFrom), so only the left ones are set
  const slidingN = () => { const m = famAll(startModel('sliding_n'), { frame_side: 'fs', left_key_stile: 'ks', left_hook_stile: 'hs' }); for (const k of ['mid_top', 'mid_bottom', 'mid_hook_a', 'mid_hook_b', 'right_top', 'right_bottom', 'right_hook_stile', 'right_key_stile']) if (m.lines[k]) m.lines[k][0].profile_family = ''; return m }
  it('sliding_n template (n 2) priced for an item with layout_params { n: 3 } has three sashes', () => {
    const two = costOpening(kCtx(slidingN(), 'sliding_n'))
    expect(qty(two, 'บานเลื่อนบน')).toBe(2)
    for (const lp of [{ n: 3 }, { n: '3' }]) {
      const three = costOpening(kCtx(slidingN(), 'sliding_n', { layout_params: lp }))
      expect(qty(three, 'บานเลื่อนบน')).toBe(3)
      expect(qty(three, 'บานเลื่อนล่าง')).toBe(3)
      expect(qty(three, 'เสากุญแจ')).toBe(2)   // R-F1: two outer key stiles
      expect(qty(three, 'เสาเกี่ยว')).toBe(4)   // and 2(n-1) hook stiles (เสาเกี่ยว… names start with it)
      expect(three.total).toBeGreaterThan(two.total)
    }
  })
  it('a non-estimator / fixed_by_type input on the item is ignored: rows on awning_grid, door on sliding_n', () => {
    const awning = famAll(startModel('awning_grid', { rows: 2, cols: 2 }), {})
    const base = costOpening(kCtx(awning, 'awning_grid'))
    const withRows = costOpening(kCtx(awning, 'awning_grid', { layout_params: { rows: 3, cols: 1 } }))
    expect(JSON.stringify(withRows.bom.profileLines)).toBe(JSON.stringify(base.bom.profileLines))
    expect(withRows.total).toBe(base.total)
    const door = costOpening(kCtx(slidingN(), 'sliding_n', { layout_params: { door: true } }))
    expect(JSON.stringify(door.bom)).toBe(JSON.stringify(costOpening(kCtx(slidingN(), 'sliding_n')).bom))
  })
  it('modelForItem: same model object when the item changes nothing; unknown keys dropped', () => {
    const m = slidingN()
    expect(modelForItem(m, {})).toBe(m)
    expect(modelForItem(m, { layout_params: { n: 2, junk: 1 } })).toBe(m)
    expect(modelForItem(m, { layout_params: { rows: 4 } })).toBe(m)
    expect(modelForItem(m, { layout_params: { n: 9 } }).params.n).toBe(6)   // clamped to the input max
    expect(modelForItem(null, { layout_params: { n: 3 } })).toBeNull()
  })
  it('an item param set the layout refuses (folding 0 + 0) is reported, never thrown', () => {
    const fold = famAll(startModel('folding_door'), {})
    const r = costOpening(kCtx(fold, 'folding_door', { layout_params: { nL: 0, nR: 0 } }))
    expect(r.unresolved).toContainEqual({ name: 'แบบ folding_door', reason: 'layout_params_invalid', source: 'joint' })
    expect(r.bom.profileLines).toEqual([])
  })
  it('the item preview draws the same item-adjusted model (partPreviewCtx with the item)', () => {
    const c = kCtx(slidingN(), 'sliding_n', { layout_params: { n: 3 } })
    const resolved = costOpening(c).resolved
    expect(partPreviewCtx(c, c.template, resolved, c.item).model.params.n).toBe(3)
    expect(partPreviewCtx(c, c.template, resolved).model.params.n).toBe(2)
  })
  it('only the main template takes the item params; an add-on part template keeps its own', () => {
    const c = kCtx(slidingN(), 'sliding_n', { layout_params: { n: 3 } })
    c.template = T({ id: 't1' })
    c.componentsByTemplate = { t1: [] }
    c.addonTemplate = T({ id: 'tp', layout_kind: 'sliding_n' })
    c.item = { ...c.item, template_id: 't1', addon_template_id: 'tp', addon_width_m: 2, addon_height_m: 1 }
    const r = costOpening(c)
    expect(r.addonBom.profileLines.filter(l => l.role_name.startsWith('บานเลื่อนบน')).reduce((s, l) => s + l.quantity, 0)).toBe(2)
  })
})

describe('costOpening: refusals and glass / panel parts', () => {
  it('a model refused at load (layout_mismatch) is reported with the template name, no rows', () => {
    const c = kCtx(null, 'sliding_2')
    c.partModelByTemplate = { tp: { error: 'layout_mismatch' } }
    const r = costOpening(c)
    expect(r.bom.profileLines).toEqual([])
    expect(r.unresolved).toContainEqual({ name: 'แบบ sliding_2', reason: 'layout_mismatch', source: 'joint' })
    expect(partPreviewCtx(c, c.template, r.resolved)).toBeNull()
  })
  it('frameless_door costs its three frame pieces and no leaf rows (the leaves are glass)', () => {
    const m = famAll(startModel('frameless_door', { leaves: 2 }), { frame_side: 'fs' })
    const r = costOpening(kCtx(m, 'frameless_door'))
    expect(r.bom.profileLines.map(l => l.role_name).every(n => n.startsWith('เฟรม'))).toBe(true)
    expect(r.bom.profileLines.reduce((s, l) => s + l.quantity, 0)).toBe(3)
    expect(r.unresolved).toEqual([])
  })
  it('a curtain wall with a spandrel (panel) cell costs without throwing and prices no panel aluminium', () => {
    let m = startModel('curtain_wall')
    m = cycleCellKind(cycleCellKind(m, 0, 0), 0, 0)   // glass -> awning -> spandrel
    m = famAll(m, {})
    const r = costOpening(kCtx(m, 'curtain_wall'))
    expect(r.bom.profileLines.length).toBeGreaterThan(0)
    expect(r.bom.profileLines.some(l => /spandrel|แผงทึบ/i.test(l.role_name))).toBe(false)
    expect(Number.isFinite(r.total)).toBe(true)
  })
})

describe('door leaves are priced at the sash thickness (ruling R-9a)', () => {
  it('a swing_door leaf uses the series sash thickness; the frame keeps the main thickness', () => {
    const m = startModel('swing_door')   // leaf members (role sash) -> sr, everything else (frame, sill) -> fh
    for (const k of Object.keys(m.lines)) m.lines[k][0].profile_family = m.lines[k][0].thickness_role === 'sash' ? 'sr' : 'fh'
    const c = kCtx(m, 'swing_door')
    c.project = { ...c.project, default_sash_thickness_mm: 2 }
    const r = costOpening(c)
    const leaf = r.bom.profileLines.filter(l => l.family === 'sr')
    expect(leaf.length).toBeGreaterThan(0)
    expect(leaf.every(l => l.thickness_mm === 2)).toBe(true)
    expect(r.bom.profileLines.filter(l => l.family === 'fh').every(l => l.thickness_mm === 1.5)).toBe(true)
    expect(r.bom.profileLines.filter(l => l.family === 'fh').length).toBeGreaterThan(0)
  })
})

describe('fixed_by_type inputs are fixed only when the type pins them (final fix wave, R-F2 / R-12a)', () => {
  const rowsOfModel = async (m) => {
    const { modelToRows } = await import('./partSave.js')
    let i = 0
    return modelToRows(m, 'tp', () => `r${++i}`)
  }
  const load = async (kind, typeParams, base = {}) => {
    const { modelFromRows } = await import('./partSave.js')
    const m = famAll(startModel(kind, base), {})
    return modelFromRows({ template: { id: 'tp', layout_kind: kind, layout_params: m.params }, type: { id: 'ty', layout_kind: kind, layout_params: typeParams }, ...(await rowsOfModel(m)) })
  }
  const leaves = (r) => qty(r, 'เสาบานพับ')
  it('swing door: a type that sets no leaves lets the item price 2 leaves', async () => {
    const m = await load('swing_door', {})
    expect(m.fixedKeys).toBeUndefined()
    expect(leaves(costOpening(kCtx(m, 'swing_door')))).toBe(1)
    expect(leaves(costOpening(kCtx(m, 'swing_door', { layout_params: { leaves: 2 } })))).toBe(2)
  })
  it('swing door: a type with leaves 2 pins it; the item cannot change it', async () => {
    const m = await load('swing_door', { leaves: 2 })
    expect(m.fixedKeys).toEqual(['leaves'])
    expect(leaves(costOpening(kCtx(m, 'swing_door')))).toBe(2)
    expect(leaves(costOpening(kCtx(m, 'swing_door', { layout_params: { leaves: 1 } })))).toBe(2)
    expect(modelForItem(m, { layout_params: { leaves: 1 } })).toBe(m)
  })
  it('casement: type { n: 1 } pins n (บานเปิดข้างเดี่ยว); a type without n lets the item set it (บานเปิดข้าง)', async () => {
    const one = await load('casement_n', { n: 1 })
    expect(one.params.n).toBe(1)
    expect(one.fixedKeys).toEqual(['n'])
    expect(modelForItem(one, { layout_params: { n: 3 } })).toBe(one)
    const free = await load('casement_n', {})
    expect(modelForItem(free, { layout_params: { n: 3 } }).params.n).toBe(3)
    const { LAYOUTS } = await import('./layoutRegistry.js')
    const n = LAYOUTS.casement_n.inputs.find(i => i.key === 'n')
    expect([n.estimator, n.fixed_by_type]).toEqual([true, true])
  })
})

// ---- Task 5 (sliding_2 add-ons): inline add-ons (ช่องแสง) in costing ----
import { readFileSync } from 'node:fs'
import { defaultAddonPieces } from './addonModel.js'

const LONG = 'กล่องร่องวิ่งยาว'
const aIndex = buildCatalogIndex({
  providers: [{ id: 'A', price_basis: 'per_kg' }],
  series: [{ id: 's1', provider_id: 'A' }],
  types: [{ id: 'tSlide' }],
  seriesTypes: [{ series_id: 's1', type_id: 'tSlide', allow_mixed_thickness: true }],
  finishes: [{ id: 'f1', provider_id: 'A' }],
  profiles: [
    { id: 'fh', provider_id: 'A', family: 'fh', thickness_mm: 1.5, linear_weight_kg_per_m: 1, butt_distance_mm: 20 },
    { id: 'fs', provider_id: 'A', family: 'fs', thickness_mm: 1.5, linear_weight_kg_per_m: 1, butt_distance_mm: 25 },
    { id: 'sr', provider_id: 'A', family: 'sr', thickness_mm: 1.5, linear_weight_kg_per_m: 1, butt_distance_mm: 10 },
    { id: 'ks', provider_id: 'A', family: 'ks', thickness_mm: 1.5, linear_weight_kg_per_m: 1, butt_distance_mm: 30 },
    { id: 'hs', provider_id: 'A', family: 'hs', thickness_mm: 1.5, linear_weight_kg_per_m: 1, butt_distance_mm: 35 },
    { id: 'lg', provider_id: 'A', family: LONG, thickness_mm: 1.5, linear_weight_kg_per_m: 2, butt_distance_mm: 50 },
  ],
  seriesProfiles: ['fh', 'fs', 'sr', 'ks', 'hs', 'lg'].map(profile_id => ({ series_id: 's1', profile_id })),
  kgPrices: [{ id: 'k1', provider_id: 'A', finish_id: 'f1', price_per_kg: 100, effective_from: '2026-01-01' }],
})
const ATTACH_FAMS = { frame_top: 'fh', frame_bottom: 'fh', frame_side: 'fs', mullion: 'sr', rail: 'sr' }
const pieceRows = (mode, position, fams) => defaultAddonPieces({ mode, kind: 'fixed', position, layoutKind: 'sliding_2', buttMm: 10 })
  .map(r => ({ ...r, profile_family: r.piece_key in fams ? fams[r.piece_key] : 'sr' }))
const ao = o => ({ mode: 'attach', kind: 'fixed', position: 'top', len_mm: 1800, thick_mm: 400, offset_mm: 0, rows: 1, cols: 3, ...o })
const aCtx = (addons, rows = [], extra = {}) => ({
  ...pCtx(),
  index: aIndex, typesById: aIndex.types,
  item: { id: 'o1', width_m: 1.8, height_m: 1.2, panel_count: 1, quantity: 1, template_id: 'tp', infill_type_id: 'g1' },
  infillTypesById: { g1: { id: 'g1', name: 'กระจก', price_per_sqm: 1000 } },
  itemAddonsByOpening: addons ? { o1: addons } : {}, addonPiecesByTemplate: { tp: rows },
  ...extra,
})
const plainOf = c => costOpening({ ...c, itemAddonsByOpening: {} })

describe('Task 5 (a): parity without add-ons', () => {
  it('the absolute-total case is unchanged without the new keys and with empty maps', () => {
    const before = costOpening(ctxBase())
    expect(before.total).toBeCloseTo(584)
    const withEmpty = costOpening({ ...ctxBase(), itemAddonsByOpening: {}, addonPiecesByTemplate: {} })
    expect(JSON.stringify(withEmpty)).toBe(JSON.stringify(before))
    expect(before.addonBoms).toEqual([])
    expect(before.addonMerge).toBeNull()
  })
  it('a part-model item costs the same with empty / still-loading (undefined) add-on maps', () => {
    const before = costOpening(pCtx())
    for (const extra of [{ itemAddonsByOpening: {}, addonPiecesByTemplate: {} }, { itemAddonsByOpening: undefined, addonPiecesByTemplate: undefined }]) {
      expect(JSON.stringify(costOpening({ ...pCtx(), ...extra }))).toBe(JSON.stringify(before))
    }
  })
  it('the legacy add-on case is unchanged', () => {
    const c = ctxBase()
    c.settings = mergeSettings({ shim_part_id: 'shim' })
    c.addonTemplate = T({ id: 't2' })
    c.componentsByTemplate = { t1: comps.slice(0, 1), t2: comps.slice(0, 1) }
    c.item = { ...c.item, id: 'o1', addon_template_id: 't2', addon_width_m: 2, addon_height_m: 0.5 }
    const before = costOpening(c)
    expect(before.total).toBeCloseTo(460)
    expect(JSON.stringify(costOpening({ ...c, itemAddonsByOpening: { other: [ao()] }, addonPiecesByTemplate: {} }))).toBe(JSON.stringify(before))
  })
})

describe('Task 5 (b): an attach add-on is its own unit', () => {
  it('top 1800 × 400, 1 × 3: one addonBom with frame top/bottom/side + mullion; total = main + unit', () => {
    const c = aCtx([ao()], pieceRows('attach', null, ATTACH_FAMS))
    const r = costOpening(c)
    const plain = plainOf(c)
    expect(r.addonBoms).toHaveLength(1)
    expect(r.addonBoms[0].addonIndex).toBe(0)
    const lines = r.addonBoms[0].bom.profileLines
    expect(lines.map(l => [l.family, Math.round(l.length_m * 1e6) / 1e6, l.quantity])).toEqual([
      ['fh', 1.78, 1], ['fh', 1.78, 1], ['fs', 0.4, 2], ['sr', 0.38, 2],
    ])
    expect(lines.every(l => l.resolved)).toBe(true)
    expect(r.bom.profileLines).toEqual(plain.bom.profileLines)   // attach never changes the main frame
    expect(r.addonBoms[0].bom.totalCost).toBeGreaterThan(0)
    expect(r.total).toBeCloseTo(plain.total + r.addonBoms[0].bom.totalCost)
    expect(r.unresolved).toEqual([])
    expect(r.addonMerge.glass).toEqual({ area_sqm: 0, cost: 0, panes: 0 })   // attach glass is in its own BOM
  })
  it('an attach piece without a family is listed with source addon and its addonIndex', () => {
    const r = costOpening(aCtx([ao()], pieceRows('attach', null, { ...ATTACH_FAMS, mullion: null })))
    expect(r.unresolved).toContainEqual({ name: 'ซอยกลางตั้ง (ช่องแสง 1)', reason: 'no_profile_family', source: 'addon', addonIndex: 0 })
  })
  it('an unresolved attach profile line is appended with source addon', () => {
    const r = costOpening(aCtx([ao()], pieceRows('attach', null, { ...ATTACH_FAMS, mullion: 'ghost' })))
    expect(r.unresolved.some(u => u.source === 'addon' && u.reason && u.name && u.addonIndex === undefined)).toBe(true)
  })
})

describe('Task 5 (c): a merge add-on joins the main frame', () => {
  it('sliding_2 top add-on, ext family changed: เฟรมข้าง 1.6 m in the long family, note ตบเรียบ, 3 panes', () => {
    const c = aCtx([ao({ mode: 'merge' })], pieceRows('merge', 'top', { ext: LONG, main_facing: null }))
    const r = costOpening(c)
    const side = r.bom.profileLines.find(l => l.role_name === 'เฟรมข้าง')
    expect(side.length_m).toBeCloseTo(1.6)
    expect(side.family).toBe(LONG)
    expect(side.quantity).toBe(2)
    expect(r.addonMerge.notes.map(n => n.text).join(' ')).toContain('ตบเรียบ')
    expect(r.addonMerge.glass.panes).toBe(3)
    // glass panes: (1800 − 2 × 10) / 3 × (400 − 2 × 10)
    const area = 3 * ((1800 - 20) / 3) * (400 - 20) / 1e6
    expect(r.addonMerge.glass.area_sqm).toBeCloseTo(area, 9)
    expect(r.addonMerge.glass.cost).toBeCloseTo(area * 1000, 6)
    expect(r.addonBoms).toEqual([])
    // merge pieces are main BOM lines after the main rows, numbered on
    const mergedRoles = r.addonMerge.components.map(x => x.role_name)
    expect(mergedRoles.length).toBeGreaterThan(0)
    expect(r.bom.profileLines.slice(-mergedRoles.length).map(l => l.role_name)).toEqual(mergedRoles)
    const sorts = r.addonMerge.components.map(x => x.sort_order)
    expect(Math.min(...sorts)).toBe(r.bom.profileLines.length - mergedRoles.length)
    expect(r.total).toBeCloseTo(r.bom.totalCost + r.addonMerge.glass.cost + r.extras.cost)
    expect(r.unresolved).toEqual([])
  })
  it('partPreviewCtx returns the item\'s add-ons and the same overrides / sideButt', () => {
    const c = aCtx([ao({ mode: 'merge' })], pieceRows('merge', 'top', { ext: LONG, main_facing: null }))
    const r = costOpening(c)
    const p = partPreviewCtx(c, c.template, r.resolved, c.item)
    expect(p.addons).toEqual([ao({ mode: 'merge' })])
    expect(p.overrides).toEqual({ frame_side: { lengthMm: 1600, family: LONG } })
    expect(p.sideButt).toEqual({})
    const none = partPreviewCtx(pCtx(), pCtx().template, r.resolved, pCtx().item)
    expect(none.addons).toEqual([])
    expect(none.overrides).toEqual({})
  })
})

describe('Task 5 (d)–(f): add-ons that are not costed say why', () => {
  it('(d) legacy + new ⇒ legacy total and addon_conflict', () => {
    const c = aCtx([ao()], pieceRows('attach', null, ATTACH_FAMS))
    c.addonTemplate = T({ id: 't2' })
    c.componentsByTemplate = { t2: [{ role_name: 'top', profile_family: 'fh', length_rule_type: 'width', length_deduction_mm: 0, quantity_basis: 'fixed', quantity_value: 1 }] }
    c.item = { ...c.item, addon_template_id: 't2', addon_width_m: 1.8, addon_height_m: 0.4 }
    const r = costOpening(c)
    const legacy = plainOf(c)
    expect(legacy.addonBom).not.toBeNull()
    expect(r.total).toBeCloseTo(legacy.total)
    expect(r.addonBoms).toEqual([])
    expect(r.unresolved).toContainEqual({ name: 'ช่องแสง', reason: 'addon_conflict', source: 'addon' })
  })
  it('(e) a load error ⇒ addon_not_loaded once, total as plain', () => {
    for (const err of [{ itemAddonsError: 'x' }, { addonPiecesError: 'x' }]) {
      const c = aCtx([ao()], pieceRows('attach', null, ATTACH_FAMS), err)
      const r = costOpening(c)
      expect(r.total).toBeCloseTo(plainOf({ ...c, itemAddonsError: null, addonPiecesError: null }).total)
      expect(r.unresolved.filter(u => u.reason === 'addon_not_loaded')).toEqual([{ name: 'ช่องแสง', reason: 'addon_not_loaded', source: 'addon' }])
      expect(r.addonBoms).toEqual([])
    }
    // a template without layout_kind is not affected by an add-on load error
    expect(JSON.stringify(costOpening({ ...ctxBase(), itemAddonsError: 'x' }))).toBe(JSON.stringify(costOpening(ctxBase())))
  })
  it('(f) a template without layout_kind + add-ons ⇒ addon_needs_layout, plain total', () => {
    const c = { ...ctxBase(), item: { ...ctxBase().item, id: 'o1' }, itemAddonsByOpening: { o1: [ao()] } }
    const r = costOpening(c)
    expect(r.total).toBeCloseTo(584)
    expect(r.unresolved).toEqual([{ name: 'ช่องแสง', reason: 'addon_needs_layout', source: 'addon' }])
  })
})

describe('Task 5 (h): every costing caller gets the add-on maps', () => {
  const src = f => readFileSync(new URL(f, import.meta.url), 'utf8')
  it('Estimation.jsx puts the four add-on keys into the shared base ctx (costItems / QuickQuote / ItemModal spread it)', () => {
    const s = src('../pages/Estimation.jsx')
    expect(s).toMatch(/useTemplateAddonPieces\(/)
    expect(s).toMatch(/useItemAddons\(/)
    const baseBlock = s.slice(s.indexOf('const base = useMemo'), s.indexOf('const packageItems'))
    for (const k of ['addonPiecesByTemplate', 'itemAddonsByOpening', 'addonPiecesError', 'itemAddonsError', 'partModelByTemplate']) expect(baseBlock).toContain(k)
  })
  it('ProviderCompare passes both maps and both errors to compareProviders, which passes them to costOpening', () => {
    const pc = src('../pages/estimation/ProviderCompare.jsx')
    const lib = src('./providerCompare.js')
    for (const k of ['addonPiecesByTemplate', 'itemAddonsByOpening', 'addonPiecesError', 'itemAddonsError']) {
      expect(pc).toContain(`base.${k}`)
      expect(lib).toContain(`ctx.${k}`)
    }
  })
})

describe('Task 5: roll-ups read the attach units and the merge glass', async () => {
  const { costBoms } = await import('./openingCost.js')
  const { costBreakdown } = await import('./priceStructure.js')
  const { compareProviders } = await import('./providerCompare.js')
  const { bomsForStale } = await import('../pages/estimation/projectDefaults.js')
  const { buildEntries, entriesPieceCount } = await import('../pages/estimation/projectBomHelpers.js')
  const attachCtx = () => aCtx([ao()], pieceRows('attach', null, ATTACH_FAMS))
  const aluOf = b => [...b.profileLines, ...b.gridLines].reduce((s, l) => s + l.cost, 0)
  it('costBoms lists main, legacy add-on and attach units', () => {
    const r = costOpening(attachCtx())
    expect(costBoms(r)).toEqual([r.bom, r.addonBoms[0].bom])
    expect(costBoms(plainOf(attachCtx()))).toHaveLength(1)
  })
  it('price structure, stale prices, project BOM and extruder compare include the attach unit', () => {
    const c = attachCtx()
    const r = costOpening(c)
    const unit = r.addonBoms[0].bom
    expect(costBreakdown(r).alu).toBeCloseTo(aluOf(r.bom) + aluOf(unit))
    expect(costBreakdown(r).glass).toBeCloseTo(r.bom.infillCost + unit.infillCost)
    expect(bomsForStale({ o1: r }).o1.profileLines).toHaveLength(r.bom.profileLines.length + unit.profileLines.length)
    const { entries } = buildEntries([c.item], { o1: r })
    const pieces = b => b.profileLines.reduce((s, l) => s + l.quantity, 0)
    expect(entriesPieceCount(entries)).toBe(pieces(r.bom) + pieces(unit))
    const cmp = compareProviders({ ...c, items: [c.item], templatesById: { tp: c.template }, candidates: [{ providerId: 'A', seriesId: 's1', finishId: 'f1' }] })
    expect(cmp[0].aluminium).toBeCloseTo(aluOf(r.bom) + aluOf(unit))
  })
  it('price structure counts the merge glass; a load error makes the extruder row incomplete', () => {
    const r = costOpening(aCtx([ao({ mode: 'merge' })], pieceRows('merge', 'top', { ext: LONG, main_facing: null })))
    expect(costBreakdown(r).glass).toBeCloseTo(r.bom.infillCost + r.addonMerge.glass.cost)
    const c = aCtx([ao()], pieceRows('attach', null, ATTACH_FAMS), { itemAddonsError: 'x' })
    const cmp = compareProviders({ ...c, items: [c.item], templatesById: { tp: c.template }, candidates: [{ providerId: 'A', seriesId: 's1', finishId: 'f1' }] })
    expect(cmp[0].complete).toBe(false)
  })
})

describe('Task 5 fix: add-on frames in openingExtras; items without an id', async () => {
  const { openingExtras } = await import('./openingExtras.js')
  const settings = mergeSettings({ shim_part_id: 'shim' })
  const ext = units => openingExtras({ units, settings, partsById: aIndex.parts, pricing: { hardwarePrice: () => ({ source: 'reference', unit_price: 0 }) } })
  it('attach add-on ⇒ extras over two frames (main + attach unit)', () => {
    const r = costOpening(aCtx([ao()], pieceRows('attach', null, ATTACH_FAMS), { settings }))
    const want = ext([{ width_m: 1.8, height_m: 1.2 }, { width_m: 1.8, height_m: 0.4 }])
    expect(r.extras.points).toBe(want.points)
    expect(r.extras.sealant_m).toBeCloseTo(10.4)
    expect(r.extras.points).toBeGreaterThan(ext([{ width_m: 1.8, height_m: 1.2 }]).points)
  })
  it('merge top 1800 × 400 on 1800 × 1200 ⇒ the main frame is 1.8 × 1.6', () => {
    const r = costOpening(aCtx([ao({ mode: 'merge' })], pieceRows('merge', 'top', { ext: LONG, main_facing: null }), { settings }))
    const want = ext([{ width_m: 1.8, height_m: 1.6 }])
    expect(r.extras.points).toBe(want.points)
    expect(r.extras.sealant_m).toBeCloseTo(6.8)
  })
  it('no add-ons ⇒ extras unchanged (absolute numbers)', () => {
    const r = costOpening(aCtx(null, [], { settings }))
    expect(r.extras.sealant_m).toBeCloseTo(6)
    expect(r.extras.points).toBe(ext([{ width_m: 1.8, height_m: 1.2 }]).points)
    // the legacy case: main 2 × 1 + add-on 2 × 0.5 ⇒ 30 points (as before)
    const c = ctxBase()
    c.settings = mergeSettings({ shim_part_id: 'shim' })
    c.addonTemplate = T({ id: 't2' })
    c.componentsByTemplate = { t1: comps.slice(0, 1), t2: comps.slice(0, 1) }
    c.item = { ...c.item, addon_template_id: 't2', addon_width_m: 2, addon_height_m: 0.5 }
    expect(costOpening({ ...c, itemAddonsByOpening: {} }).extras.points).toBe(30)
  })
  it('an item without an id gets no addon_not_loaded on a load error', () => {
    for (const id of [undefined, null]) {
      const c = aCtx(null, [], { itemAddonsError: 'x', addonPiecesError: 'y' })
      c.item = { ...c.item, id }
      const r = costOpening(c)
      expect(r.unresolved.some(u => u.reason === 'addon_not_loaded')).toBe(false)
      expect(JSON.stringify(r)).toBe(JSON.stringify(costOpening({ ...c, itemAddonsError: null, addonPiecesError: null })))
    }
  })
})
