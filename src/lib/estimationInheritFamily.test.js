// src/lib/estimationInheritFamily.test.js -- spec 2026-10-31 section 5: the series order and the family resolver.
import { describe, it, expect } from 'vitest'
import { buildCatalogIndex } from './aluCatalogPricing.js'
import { withFamilyResolver } from './seriesFamily.js'
import { inheritedSeries, resolveSeriesId, resolveItemInputs, itemsAffectedByDefaultFamily, itemsAffectedByDefaultSeries } from './estimationInherit.js'

const index = buildCatalogIndex({
  providers: [{ id: 'A', name: 'Alumet' }],
  seriesFamilies: [{ id: 'fA', provider_id: 'A', name: 'EURO' }],
  series: [
    { id: 'sSlide', provider_id: 'A', name: 'EURO Slide', series_family_id: 'fA' },
    { id: 'sOpen', provider_id: 'A', name: 'EURO Open', series_family_id: 'fA' },
    { id: 'sOther', provider_id: 'A', name: 'Other' },
  ],
  types: [{ id: 'slide', name: 'บานเลื่อน' }, { id: 'casement', name: 'บานเปิด' }, { id: 'awning', name: 'บานกระทุ้ง' }],
  seriesTypes: [{ id: 'l1', series_id: 'sSlide', type_id: 'slide' }, { id: 'l2', series_id: 'sOpen', type_id: 'casement' }],
})
const seriesTypes = Object.values(index.seriesTypesBySeries).flat()
const tSlide = { id: 'tS', type_id: 'slide' }
const tOpen = { id: 'tO', type_id: 'casement' }
const tAwn = { id: 'tA', type_id: 'awning' }
const fam = withFamilyResolver({ id: 'p', default_series_family_id: 'fA', default_finish_id: 'f1' }, index, seriesTypes)

describe('inheritedSeries: the order 1-4 (spec section 5)', () => {
  it("1 the item's own series always wins", () => {
    expect(inheritedSeries({ series_id: 'sOther' }, fam, tSlide)).toEqual({ series_id: 'sOther', source: 'item', familyMissing: false })
  })
  it("2 the project's family gives the series of the template's type", () => {
    expect(inheritedSeries({}, fam, tSlide)).toEqual({ series_id: 'sSlide', source: 'family', familyMissing: false })
    expect(inheritedSeries({}, fam, tOpen).series_id).toBe('sOpen')
  })
  it('2 a family without a series for the type gives null + familyMissing, never the old default', () => {
    const both = { ...fam, default_series_id: 'sOther' }
    expect(inheritedSeries({}, both, tAwn)).toEqual({ series_id: null, source: null, familyMissing: true })
  })
  it('3 an old project (no family) uses default_series_id; 4 nothing set gives null', () => {
    expect(inheritedSeries({}, { default_series_id: 'sOther' }, tAwn)).toEqual({ series_id: 'sOther', source: 'project', familyMissing: false })
    expect(inheritedSeries(null, null, null)).toEqual({ series_id: null, source: null, familyMissing: false })
  })
  it('resolveSeriesId is the series id alone', () => {
    expect(resolveSeriesId({}, fam, tOpen)).toBe('sOpen')
    expect(resolveSeriesId({ series_id: '' }, { default_series_id: 's9' }, null)).toBe('s9')
  })
})

describe('resolveItemInputs with a family', () => {
  it('series by type, every other input as before, same keys as ever', () => {
    const r = resolveItemInputs({}, fam, tSlide, index.types)
    expect(r.series_id).toBe('sSlide')
    expect(r.finish_id).toBe('f1')
    expect(Object.keys(r)).toEqual(['series_id', 'finish_id', 'infill_type_id', 'hardware_set_id', 'thickness_mm', 'sash_thickness_mm', 'labour_per_sqm', 'profit_pct'])
  })
})

describe('itemsAffectedByDefaultFamily', () => {
  const templatesById = { tS: tSlide, tO: tOpen, tA: tAwn, tAddon: { id: 'tAddon', type_id: 'casement' } }
  const items = [
    { id: 'a', template_id: 'tS' },
    { id: 'b', template_id: 'tA' },                              // no awning series in the family
    { id: 'c', template_id: 'tA', series_id: 'sOther' },          // own series: never affected
    { id: 'd', template_id: 'tS', addon_template_id: 'tAddon' },  // slide series does not make the casement add-on
  ]
  it('lists inheriting items the family cannot build', () => {
    expect(itemsAffectedByDefaultFamily(items, templatesById, index, seriesTypes, 'fA').map(i => i.id)).toEqual(['b', 'd'])
  })
  it('no key: nothing; a solo key: exactly the old single-series check', () => {
    expect(itemsAffectedByDefaultFamily(items, templatesById, index, seriesTypes, '')).toEqual([])
    expect(itemsAffectedByDefaultFamily(items, templatesById, index, seriesTypes, 'series:sSlide'))
      .toEqual(itemsAffectedByDefaultSeries(items, templatesById, 'sSlide', seriesTypes))
  })
})
