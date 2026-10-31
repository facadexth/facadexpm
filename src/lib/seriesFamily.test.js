// src/lib/seriesFamily.test.js
import { describe, it, expect } from 'vitest'
import { buildCatalogIndex } from './aluCatalogPricing.js'
import {
  isSoloKey, soloKey, soloSeriesId, familyKey, projectFamilyKey, keyProviderId, familyLabel, familySeries,
  familySeriesForType, familyChoices, familyThicknesses, familyAllowsMixed, projectSeriesIds, withFamilyResolver,
  parseThicknessOptions, formatThicknessOptions,
} from './seriesFamily.js'

// ASCII names so "first by name" is unambiguous. Types: win > slide > slide2 (child), casement, fixed, awning.
const rows = {
  providers: [{ id: 'A', name: 'Alumet' }, { id: 'B', name: 'SMS' }],
  seriesFamilies: [
    { id: 'fA', provider_id: 'A', name: 'EURO', thickness_options: null, active: true },
    { id: 'fStd', provider_id: 'A', name: 'STANDARD', thickness_options: [2, 1, 1.5, 1.5], active: true },
    { id: 'fOff', provider_id: 'A', name: 'OLD', thickness_options: null, active: false },
  ],
  series: [
    { id: 's1', provider_id: 'A', name: 'EURO Slide', series_family_id: 'fA' },
    { id: 's10', provider_id: 'A', name: 'EURO Slide 3T', series_family_id: 'fA' },
    { id: 's2', provider_id: 'A', name: 'EURO Open', series_family_id: 'fA' },
    { id: 's3', provider_id: 'A', name: 'EURO Fixed', series_family_id: 'fA' },
    { id: 's4', provider_id: 'A', name: 'EURO Aaa', series_family_id: 'fA', active: false },
    { id: 's5', provider_id: 'A', name: 'MINI MC', series_family_id: 'fStd' },
    { id: 's6', provider_id: 'A', name: 'SOLO', series_family_id: null },
    { id: 's7', provider_id: 'A', name: 'OLD 1', series_family_id: 'fOff' },
    { id: 's8', provider_id: 'B', name: 'B one', series_family_id: null },
  ],
  types: [
    { id: 'win', name: 'หน้าต่าง', parent_id: null }, { id: 'slide', name: 'บานเลื่อน', parent_id: 'win' },
    { id: 'slide2', name: 'บานเลื่อน 2 บาน', parent_id: 'slide' }, { id: 'casement', name: 'บานเปิด', parent_id: 'win' },
    { id: 'fixed', name: 'บานติดตาย', parent_id: 'win' }, { id: 'awning', name: 'บานกระทุ้ง', parent_id: 'win' },
  ],
  seriesTypes: [
    { id: 'l1', series_id: 's1', type_id: 'slide', allow_mixed_thickness: false },
    { id: 'l10', series_id: 's10', type_id: 'slide', allow_mixed_thickness: false },
    { id: 'l2', series_id: 's2', type_id: 'casement', allow_mixed_thickness: true },
    { id: 'l3', series_id: 's3', type_id: 'fixed', allow_mixed_thickness: false },
    { id: 'l4', series_id: 's4', type_id: 'slide', allow_mixed_thickness: false },
    { id: 'l6', series_id: 's6', type_id: 'slide', allow_mixed_thickness: false },
  ],
  profiles: [
    { id: 'p12', provider_id: 'A', thickness_mm: 1.2 }, { id: 'p15', provider_id: 'A', thickness_mm: 1.5 }, { id: 'p20', provider_id: 'A', thickness_mm: 2 },
  ],
  seriesProfiles: [
    { series_id: 's1', profile_id: 'p12' }, { series_id: 's2', profile_id: 'p15' }, { series_id: 's3', profile_id: 'p12' }, { series_id: 's6', profile_id: 'p20' },
  ],
}
const index = buildCatalogIndex(rows)
const seriesTypes = Object.values(index.seriesTypesBySeries).flat()   // expanded, as useEstimationCatalog gives it

describe('keys', () => {
  it('solo keys round-trip', () => {
    expect(soloKey('s6')).toBe('series:s6')
    expect(isSoloKey('series:s6')).toBe(true)
    expect(isSoloKey('fA')).toBe(false)
    expect(isSoloKey('')).toBe(false)
    expect(soloSeriesId('series:s6')).toBe('s6')
    expect(soloSeriesId('fA')).toBeNull()
  })
  it('familyKey: the family while it is active, else the series itself', () => {
    expect(familyKey(index.series.s1, index.seriesFamilies)).toBe('fA')
    expect(familyKey(index.series.s6, index.seriesFamilies)).toBe('series:s6')
    expect(familyKey(index.series.s7, index.seriesFamilies)).toBe('series:s7')   // family switched off
    expect(familyKey(index.series.s7)).toBe('fOff')                               // no map given: trust the column
  })
  it('projectFamilyKey prefers the family, then the single series', () => {
    expect(projectFamilyKey({ default_series_family_id: 'fA', default_series_id: 's6' })).toBe('fA')
    expect(projectFamilyKey({ default_series_id: 's6' })).toBe('series:s6')
    expect(projectFamilyKey({})).toBe('')
    expect(projectFamilyKey(null)).toBe('')
  })
  it('keyProviderId and familyLabel', () => {
    expect(keyProviderId(index, 'fA')).toBe('A')
    expect(keyProviderId(index, 'series:s8')).toBe('B')
    expect(keyProviderId(index, '')).toBeNull()
    expect(keyProviderId(index, 'gone')).toBeNull()
    expect(familyLabel(index, 'fA')).toBe('EURO')
    expect(familyLabel(index, 'series:s6')).toBe('SOLO')
    expect(familyLabel(index, '')).toBe('')
  })
})

describe('familySeries / familySeriesForType', () => {
  it('active series of the family, by name', () => {
    expect(familySeries(index, 'A', 'fA').map(s => s.id)).toEqual(['s3', 's2', 's1', 's10'])
    expect(familySeries(index, 'B', 'fA')).toEqual([])
    expect(familySeries(index, null, 'series:s6').map(s => s.id)).toEqual(['s6'])
  })
  it('picks the first series by name that makes the type; inactive series never', () => {
    expect(familySeriesForType(index, seriesTypes, 'A', 'fA', 'slide')).toBe('s1')
    expect(familySeriesForType(index, seriesTypes, 'A', 'fA', 'casement')).toBe('s2')
    expect(familySeriesForType(index, seriesTypes, 'A', 'fA', 'fixed')).toBe('s3')
  })
  it('a link on a parent type covers its child type (Review Focus 1)', () => {
    expect(familySeriesForType(index, seriesTypes, 'A', 'fA', 'slide2')).toBe('s1')
  })
  it('null when no series of the family makes the type', () => {
    expect(familySeriesForType(index, seriesTypes, 'A', 'fA', 'awning')).toBeNull()
    expect(familySeriesForType(index, seriesTypes, 'A', '', 'slide')).toBeNull()
  })
  it('no type: the first series by name (Review Focus 3)', () => {
    expect(familySeriesForType(index, seriesTypes, 'A', 'fA', null)).toBe('s3')
  })
  it('a solo key returns its series whatever the type (the old single default)', () => {
    expect(familySeriesForType(index, seriesTypes, null, 'series:s6', 'casement')).toBe('s6')
  })
})

describe('familyChoices', () => {
  it('one extruder: families with their count, lone series by name, switched-off family shown series by series', () => {
    expect(familyChoices(index, 'A')).toEqual([
      { value: 'fA', label: 'EURO · 4 ชุด', count: 4 },
      { value: 'series:s7', label: 'OLD 1', count: 1 },
      { value: 'series:s6', label: 'SOLO', count: 1 },
      { value: 'fStd', label: 'STANDARD · 1 ชุด', count: 1 },
    ])
  })
  it('no extruder chosen: every extruder, labelled with its name', () => {
    const all = familyChoices(index, '')
    expect(all.find(o => o.value === 'series:s8').label).toBe('B one · SMS')
    expect(all.find(o => o.value === 'fA').label).toBe('EURO · 4 ชุด · Alumet')
  })
})

describe('thicknesses and mixed thickness', () => {
  it("the family's own list when set (sorted, distinct), else the union of its series", () => {
    expect(familyThicknesses(index, 'fStd')).toEqual([1, 1.5, 2])
    expect(familyThicknesses(index, 'fA')).toEqual([1.2, 1.5])
    expect(familyThicknesses(index, 'series:s6')).toEqual([2])
    expect(familyThicknesses(index, '')).toEqual([])
  })
  it('mixed thickness when any series of the family allows it', () => {
    expect(familyAllowsMixed(index, seriesTypes, 'fA')).toBe(true)
    expect(familyAllowsMixed(index, seriesTypes, 'series:s6')).toBe(false)
    expect(familyAllowsMixed(index, seriesTypes, '')).toBe(false)
  })
})

describe('withFamilyResolver', () => {
  it('a project without a family comes back as the same object', () => {
    const pj = { id: 'p', default_series_id: 's6' }
    expect(withFamilyResolver(pj, index, seriesTypes)).toBe(pj)
    expect(withFamilyResolver(null, index, seriesTypes)).toBeNull()
  })
  it('adds seriesForType, familyName and familySeriesIds', () => {
    const pj = withFamilyResolver({ id: 'p', default_series_family_id: 'fA' }, index, seriesTypes)
    expect(pj.seriesForType('slide')).toBe('s1')
    expect(pj.seriesForType('awning')).toBeNull()
    expect(pj.seriesForType(null)).toBe('s3')
    expect(pj.familyName).toBe('EURO')
    expect(pj.familySeriesIds).toEqual(['s3', 's2', 's1', 's10'])
  })
  it("uses the family's own extruder even when the project's main extruder is another (Review Focus 2)", () => {
    const pj = withFamilyResolver({ id: 'p', default_series_family_id: 'fA', primary_provider_id: 'B' }, index, seriesTypes)
    expect(pj.seriesForType('casement')).toBe('s2')
  })
  it('projectSeriesIds: the family series, or the single series, or none', () => {
    expect(projectSeriesIds(withFamilyResolver({ default_series_family_id: 'fA' }, index, seriesTypes))).toEqual(['s3', 's2', 's1', 's10'])
    expect(projectSeriesIds({ default_series_id: 's6' })).toEqual(['s6'])
    expect(projectSeriesIds({})).toEqual([])
  })
})

describe('thickness text on the family form', () => {
  it('parses commas or spaces, sorts, drops duplicates; blank = every thickness', () => {
    expect(parseThicknessOptions('1.0, 1.2 1.5,1.2')).toEqual({ value: [1, 1.2, 1.5], error: null })
    expect(parseThicknessOptions('  ')).toEqual({ value: null, error: null })
    expect(parseThicknessOptions(null)).toEqual({ value: null, error: null })
    expect(parseThicknessOptions([2, 1])).toEqual({ value: [1, 2], error: null })
    expect(parseThicknessOptions('1.2, abc').error).toBe('ความหนาต้องเป็นตัวเลขมากกว่า 0 คั่นด้วยจุลภาค เช่น 1.0, 1.2, 1.5')
    expect(parseThicknessOptions('0').error).not.toBeNull()
  })
  it('formats with one decimal at least', () => {
    expect(formatThicknessOptions([1, 1.2, 2])).toBe('1.0, 1.2, 2.0')
    expect(formatThicknessOptions(null)).toBe('')
  })
})

describe('buildCatalogIndex', () => {
  it('indexes families by id, {} when not loaded', () => {
    expect(index.seriesFamilies.fA.name).toBe('EURO')
    expect(buildCatalogIndex({}).seriesFamilies).toEqual({})
  })
})

describe('familySeriesForType: an exact link beats a parent link', () => {
  // slide > slide2. pName links the parent (covers slide2 by inheritance), xName links slide2 itself.
  const build = (parentName, exactName) => {
    const ix = buildCatalogIndex({
      providers: [{ id: 'A', name: 'Alumet' }],
      seriesFamilies: [{ id: 'f', provider_id: 'A', name: 'FAM', active: true }],
      series: [
        { id: 'sp', provider_id: 'A', name: parentName, series_family_id: 'f' },
        { id: 'sx', provider_id: 'A', name: exactName, series_family_id: 'f' },
      ],
      types: [{ id: 'slide', name: 'บานเลื่อน', parent_id: null }, { id: 'slide2', name: 'บานเลื่อน 2 บาน', parent_id: 'slide' }],
      seriesTypes: [{ id: 'lp', series_id: 'sp', type_id: 'slide' }, { id: 'lx', series_id: 'sx', type_id: 'slide2' }],
      profiles: [], seriesProfiles: [],
    })
    return [ix, Object.values(ix.seriesTypesBySeries).flat()]
  }
  it('the exact series wins when it sorts first by name', () => {
    const [ix, st] = build('B parent', 'A exact')
    expect(familySeriesForType(ix, st, 'A', 'f', 'slide2')).toBe('sx')
  })
  it('the exact series wins even when the parent-linked one sorts first by name', () => {
    const [ix, st] = build('A parent', 'B exact')
    expect(familySeriesForType(ix, st, 'A', 'f', 'slide2')).toBe('sx')
  })
  it('the parent type itself still goes to the parent-linked series', () => {
    const [ix, st] = build('A parent', 'B exact')
    expect(familySeriesForType(ix, st, 'A', 'f', 'slide')).toBe('sp')
  })
})
