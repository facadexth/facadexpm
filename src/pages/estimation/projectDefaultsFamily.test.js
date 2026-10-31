import { describe, it, expect } from 'vitest'
import { buildCatalogIndex } from '../../lib/aluCatalogPricing.js'
import { withFamilyResolver } from '../../lib/seriesFamily.js'
import { hardwareBanners, availabilityIssues } from './projectDefaults.js'

export const famIndex = buildCatalogIndex({
  providers: [{ id: 'A', name: 'บจก. อลูเม็ท (Alumet)' }, { id: 'B', name: 'SMS' }],
  seriesFamilies: [
    { id: 'fI', provider_id: 'A', name: 'ICONIQ EURO', thickness_options: null },
    { id: 'fS', provider_id: 'A', name: 'STANDARD', thickness_options: [1.0, 1.2, 1.5, 1.8, 2.0] },
  ],
  series: [
    { id: 'iSlide', provider_id: 'A', name: 'ICONIQ EURO บานเลื่อน', series_family_id: 'fI' },
    { id: 'iOpen', provider_id: 'A', name: 'ICONIQ EURO บานเปิด / บานกระทุ้ง', series_family_id: 'fI' },
    { id: 'iFix', provider_id: 'A', name: 'ICONIQ EURO บานติดตาย', series_family_id: 'fI' },
    { id: 'mc', provider_id: 'A', name: 'MINI MC ท่อกลม / กล่องสี่เหลี่ยม', series_family_id: 'fS' },
    { id: 'b1', provider_id: 'B', name: 'SMS 230' },
  ],
  types: [{ id: 'tSlide', name: 'บานเลื่อน' }, { id: 'tOpen', name: 'บานเปิด' }, { id: 'tFix', name: 'บานติดตาย' }, { id: 'tFold', name: 'บานเฟี้ยม' }],
  seriesTypes: [
    { series_id: 'iSlide', type_id: 'tSlide', allow_mixed_thickness: false },
    { series_id: 'iOpen', type_id: 'tOpen', allow_mixed_thickness: true },
    { series_id: 'iFix', type_id: 'tFix', allow_mixed_thickness: false },
  ],
  finishes: [{ id: 'fin', provider_id: 'A', name: '15664 Heritage Oak' }],
  profiles: [{ id: 'p12', provider_id: 'A', thickness_mm: 1.2 }, { id: 'p20', provider_id: 'A', thickness_mm: 2 }],
  seriesProfiles: [{ series_id: 'iSlide', profile_id: 'p12' }, { series_id: 'iOpen', profile_id: 'p20' }],
})
export const famSeriesTypes = Object.values(famIndex.seriesTypesBySeries).flat()
const templatesById = { tS: { id: 'tS', name: 'บานเลื่อน 2 บาน', type_id: 'tSlide' }, tF: { id: 'tF', name: 'บานเฟี้ยม 4 บาน', type_id: 'tFold' } }

describe('banners with a project family', () => {
  const project = withFamilyResolver({ id: 'p', default_series_family_id: 'fI' }, famIndex, famSeriesTypes)
  it('a type the family has no series for is listed with the family name', () => {
    const issues = availabilityIssues({ items: [{ id: 'a', template_id: 'tS' }, { id: 'b', template_id: 'tF' }], project, templatesById, index: famIndex, seriesTypes: famSeriesTypes })
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ which: 'main', familyMissing: true, familyName: 'ICONIQ EURO', offeredBy: [] })
    expect(issues[0].item.id).toBe('b')
  })
  it('a package of a series inside the family is not "another series"', () => {
    const base = { packageItems: null, items: [], templatesById, typesById: famIndex.types }
    expect(hardwareBanners({ ...base, project, pkg: { series_id: 'iOpen' } }).wrongSeries).toBe(false)
    expect(hardwareBanners({ ...base, project, pkg: { series_id: 'b1' } }).wrongSeries).toBe(true)
    expect(hardwareBanners({ ...base, project, pkg: { series_id: null } }).wrongSeries).toBe(false)
  })
})
