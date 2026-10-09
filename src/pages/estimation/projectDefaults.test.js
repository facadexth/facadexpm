import { describe, it, expect } from 'vitest'
import { buildCatalogIndex } from '../../lib/aluCatalogPricing.js'
import {
  draftFromProject, reconcileDraft, buildPatch, validateDraft, newProjectRow, parseQuantity, seriesChoices, finishChoices,
  sashDisplayValue, packageRowsFor, hardwareBanners, availabilityIssues, itemStatus, bomsForStale, priceRowLabel, unresolvedSummary, currentPreviewSigs,
} from './projectDefaults.js'
import { itemPreviewSignature } from '../../lib/itemPreviewSignature.js'

const index = buildCatalogIndex({
  providers: [{ id: 'A', name: 'โรงรีด A' }, { id: 'B', name: 'โรงรีด B' }],
  series: [{ id: 's1', provider_id: 'A', name: 'กล่อง' }, { id: 's2', provider_id: 'B', name: 'บาง' }],
  types: [{ id: 'tSlide' }, { id: 'tFixed' }],
  seriesTypes: [{ series_id: 's1', type_id: 'tSlide', allow_mixed_thickness: true }, { series_id: 's2', type_id: 'tFixed' }],
  finishes: [{ id: 'fA', provider_id: 'A', name: 'ขาว' }, { id: 'fB', provider_id: 'B', name: 'ดำ' }],
  profiles: [
    { id: 'p1', provider_id: 'A', family: 'box', thickness_mm: 1.2 }, { id: 'p2', provider_id: 'A', family: 'box', thickness_mm: 1.5 },
    { id: 'p3', provider_id: 'B', family: 'box', thickness_mm: 1 },
  ],
  seriesProfiles: [{ series_id: 's1', profile_id: 'p1' }, { series_id: 's1', profile_id: 'p2' }, { series_id: 's2', profile_id: 'p3' }],
  kgPrices: [{ id: 'k1', price_per_kg: 100, effective_from: '2026-01-01' }],
})
const seriesTypes = Object.values(index.seriesTypesBySeries).flat()

describe('draft + reconcile', () => {
  it('series choices follow the main extruder and carry the full label', () => {
    expect(seriesChoices(index, '').map(o => o.label)).toEqual(['กล่อง · โรงรีด A', 'บาง · โรงรีด B'])
    expect(seriesChoices(index, 'B').map(o => o.value)).toEqual(['s2'])
  })
  it('a single thickness is auto-selected; several are left blank until chosen', () => {
    expect(reconcileDraft({ ...draftFromProject({}), default_series_id: 's2' }, index, seriesTypes).default_thickness_mm).toBe('1')
    expect(reconcileDraft({ ...draftFromProject({}), default_series_id: 's1' }, index, seriesTypes).default_thickness_mm).toBe('')
  })
  it('changing the extruder drops a series and colour that no longer fit', () => {
    const d = reconcileDraft({ ...draftFromProject({ default_series_id: 's1', default_finish_id: 'fA' }), primary_provider_id: 'B' }, index, seriesTypes)
    expect(d.default_series_id).toBe('')
    expect(d.default_finish_id).toBe('')
    expect(finishChoices(index, 's1', '').map(f => f.value)).toEqual(['fA'])
  })
  it('sash thickness exists only where a type allows mixed thickness, never as "equal to frame"', () => {
    const mixed = reconcileDraft({ ...draftFromProject({}), default_series_id: 's1', default_thickness_mm: '1.5', default_sash_thickness_mm: '1.2' }, index, seriesTypes)
    expect(mixed.default_sash_thickness_mm).toBe('1.2')
    const none = reconcileDraft({ ...draftFromProject({}), default_series_id: 's2', default_sash_thickness_mm: '1' }, index, seriesTypes)
    expect(none.default_sash_thickness_mm).toBe('')
    expect(sashDisplayValue({ default_sash_thickness_mm: '', default_thickness_mm: '1.5' })).toBe('')
    expect(sashDisplayValue({ default_sash_thickness_mm: '1.2', default_thickness_mm: '1.5' })).toBe('1.2')
  })
  it('a blank sash is filled with the frame value; a saved sash stays when the frame changes; no frame = blank', () => {
    const base = { ...draftFromProject({}), default_series_id: 's1' }
    expect(reconcileDraft({ ...base, default_thickness_mm: '1.5' }, index, seriesTypes).default_sash_thickness_mm).toBe('1.5')
    expect(reconcileDraft({ ...base, default_thickness_mm: '1.5', default_sash_thickness_mm: '1.2' }, index, seriesTypes).default_sash_thickness_mm).toBe('1.2')
    expect(reconcileDraft({ ...base, default_thickness_mm: '1.2', default_sash_thickness_mm: '1.5' }, index, seriesTypes).default_sash_thickness_mm).toBe('1.5')
    expect(reconcileDraft(base, index, seriesTypes).default_sash_thickness_mm).toBe('')
  })
  it('no sash value and no write when the series allows no mixed thickness', () => {
    const project = { default_series_id: 's2' }
    const d = reconcileDraft({ ...draftFromProject(project), default_thickness_mm: '1' }, index, seriesTypes)
    expect(d.default_sash_thickness_mm).toBe('')
    expect(buildPatch(project, d)).not.toHaveProperty('default_sash_thickness_mm')
  })
})

describe('buildPatch', () => {
  const project = { default_series_id: 's1', labour_per_sqm: '0', profit_pct: '10', default_thickness_mm: '1.5', description_format: ['item_name'] }
  it('writes only changed columns; blank is NULL, labour 0 is a value', () => {
    const d = draftFromProject(project)
    expect(buildPatch(project, d)).toEqual({})
    expect(buildPatch(project, { ...d, profit_pct: '' })).toEqual({ profit_pct: null })
    expect(buildPatch(project, { ...d, labour_per_sqm: '' })).toEqual({ labour_per_sqm: null })
    expect(buildPatch({ ...project, labour_per_sqm: null }, { ...d, labour_per_sqm: '0' })).toEqual({ labour_per_sqm: 0 })
    expect(buildPatch(project, { ...d, hardware_package_id: 'pk', description_format: ['item_name', 'size'] }))
      .toEqual({ hardware_package_id: 'pk', description_format: ['item_name', 'size'] })
  })
  it('validates labour, profit and the description format', () => {
    const d = draftFromProject(project)
    expect(validateDraft(d)).toBeNull()
    expect(validateDraft({ ...d, labour_per_sqm: '-1' })).toBeTruthy()
    expect(validateDraft({ ...d, profit_pct: '1001' })).toBeTruthy()
    expect(validateDraft({ ...d, profit_pct: 'abc' })).toBeTruthy()
    expect(validateDraft({ ...d, description_format: [] })).toBeTruthy()
  })
})

describe('small rules', () => {
  it('a new project takes its price date from the local date', () => {
    expect(newProjectRow('  บ้าน ', undefined, new Date(2026, 9, 9, 3, 0))).toMatchObject({ name: 'บ้าน', price_as_of: '2026-10-09' })
  })
  it('a new project is seeded with the factor defaults; transport stays NULL', () => {
    const now = new Date(2026, 9, 9, 3, 0)
    expect(newProjectRow('x', undefined, now)).toEqual({ name: 'x', price_as_of: '2026-10-09', waste_pct: 10, profit_pct: 45, pm_pct: 2, round_step: 100, transport_total: null })
    const r = newProjectRow('x', { default_waste_pct: 8, default_profit_pct: 30, default_pm_pct: 1, default_round_step: 50 }, now)
    expect(r).toMatchObject({ waste_pct: 8, profit_pct: 30, pm_pct: 1, round_step: 50, transport_total: null })
  })
  it('quantity refuses blanks, fractions, 0 and negatives', () => {
    expect(['', ' ', '0', '1.5', '-2', 'abc', '2e3'].map(parseQuantity)).toEqual([null, null, null, null, null, null, null])
    expect(parseQuantity('3')).toBe(3)
  })
  it('package rows: null without a package, only its own rows with one', () => {
    const all = [{ package_id: 'p', type_id: 'tSlide' }, { package_id: 'q', type_id: 'tFixed' }]
    expect(packageRowsFor({}, all)).toBeNull()
    expect(packageRowsFor({ hardware_package_id: 'p' }, all)).toEqual([all[0]])
    expect(packageRowsFor({ hardware_package_id: 'empty' }, all)).toEqual([])
  })
})

describe('banners', () => {
  const templatesById = { t1: { id: 't1', name: 'บานเลื่อน', type_id: 'tSlide' }, t2: { id: 't2', name: 'ติดตาย', type_id: 'tFixed' } }
  it('lists types the package does not cover, and a package of another series', () => {
    const items = [{ template_id: 't1' }, { template_id: 't2', addon_template_id: 't1' }]
    const b = hardwareBanners({ project: { default_series_id: 's1' }, pkg: { series_id: 's2' }, packageItems: [{ type_id: 'tSlide', hardware_set_id: 'x' }], items, templatesById, typesById: index.types })
    expect(b).toEqual({ missingTypeIds: ['tFixed'], wrongSeries: true, typelessTemplateItems: 0 })
    expect(hardwareBanners({ project: {}, pkg: null, packageItems: null, items, templatesById, typesById: index.types }).missingTypeIds).toEqual([])
  })
  it('an add-on template type never raises the missing-type banner', () => {
    const items = [{ template_id: 't1', addon_template_id: 't2' }]
    const b = hardwareBanners({ project: {}, pkg: null, packageItems: [{ type_id: 'tSlide', hardware_set_id: 'x' }], items, templatesById, typesById: index.types })
    expect(b.missingTypeIds).toEqual([])
  })
  it('counts items whose template has no type, only when the project has a package', () => {
    const tpl = { ...templatesById, t3: { id: 't3', name: 'ไม่ระบุ', type_id: null } }
    const items = [{ template_id: 't3' }, { template_id: 't3' }, { template_id: 't1' }]
    const withPkg = hardwareBanners({ project: {}, pkg: null, packageItems: [{ type_id: 'tSlide', hardware_set_id: 'x' }], items, templatesById: tpl, typesById: index.types })
    expect(withPkg.typelessTemplateItems).toBe(2)
    expect(hardwareBanners({ project: {}, pkg: null, packageItems: null, items, templatesById: tpl, typesById: index.types }).typelessTemplateItems).toBe(0)
  })
  it('availability: the type a series does not offer, with the series that do', () => {
    const issues = availabilityIssues({ items: [{ id: 'i', template_id: 't2' }, { id: 'j', template_id: 't1', series_id: 's2' }], project: { default_series_id: 's1' }, templatesById, index, seriesTypes })
    expect(issues.map(x => [x.item.id, x.which, x.offeredBy])).toEqual([['i', 'main', ['บาง · โรงรีด B']], ['j', 'main', ['กล่อง · โรงรีด A']]])
  })
})

describe('status + stale helpers', () => {
  it('unresolved wins; no cost is unresolved; otherwise ok', () => {
    expect(itemStatus({}, null)).toBe('unresolved')
    expect(itemStatus({}, { unresolved: [{ name: 'x', reason: 'no_series' }] })).toBe('unresolved')
    expect(itemStatus({}, { unresolved: [] })).toBe('ok')
    expect(unresolvedSummary([{ name: 'ขนาด', reason: 'no_dimension' }])).toContain('ขนาด')
    expect(unresolvedSummary([{ name: 'เสา', reason: 'no_dimension', source: 'joint' }])).toBe('เสา: ไม่มีมิติของหน้าตัดเส้นหลัก')
    expect(unresolvedSummary([{ name: 'ขนาดช่องเปิด', reason: 'no_dimension', source: 'main' }])).toBe('ขนาดช่องเปิด: ยังไม่ได้กรอกขนาด')
  })
  it('old preview: a saved drawing whose signature differs from the current one (shared helper)', () => {
    const tpl = { id: 'tH', main_axis: 'horizontal', preview_kind: 'slide', grid_row_weights: [1] }
    const item = { id: 'o1', template_id: 'tH', width_m: '1.8', height_m: 1.2, panel_count: 2, preview_svg_out: '<svg/>' }
    const cost = { unresolved: [], resolved: { series_id: null, thickness_mm: null } }
    const base = { templatesById: { tH: tpl }, index, componentsByTemplate: {}, jointsByTemplate: {} }
    const saved = itemPreviewSignature({ ...item, width_m: 1.8 }, tpl, null, { frame_mm: null })
    const sigs = currentPreviewSigs({ items: [{ ...item, preview_sig: saved }, { id: 'o2', template_id: 'tH' }], costs: { o1: cost, o2: cost }, base })
    expect(Object.keys(sigs)).toEqual(['o1'])
    expect(itemStatus({ ...item, preview_sig: saved }, cost, sigs.o1)).toBe('ok')
    const moved = currentPreviewSigs({ items: [{ ...item, width_m: 2, preview_sig: saved }], costs: { o1: cost }, base })
    expect(itemStatus({ ...item, preview_sig: saved }, cost, moved.o1)).toBe('old_preview')
    expect(itemStatus({ ...item, preview_svg_out: null, preview_sig: saved }, cost, moved.o1)).toBe('ok')
    expect(itemStatus({ ...item, preview_sig: saved }, { unresolved: [{ reason: 'no_series' }] }, moved.o1)).toBe('unresolved')
  })
  it('add-on lines are folded into the BOM handed to listPriceChanges', () => {
    const m = bomsForStale({ a: { bom: { profileLines: [1], gridLines: [], hardwareLines: [], hardwareSetLines: [] }, addonBom: { profileLines: [2], gridLines: [], hardwareLines: [], hardwareSetLines: [] } }, b: null })
    expect(m.a.profileLines).toEqual([1, 2])
    expect(m.b).toBeUndefined()
  })
  it('price rows read as money with their start date; no id is "no price"', () => {
    expect(priceRowLabel(index, 'k1')).toContain('100.00')
    expect(priceRowLabel(index, null)).toBe('ไม่มีราคา')
  })
})
