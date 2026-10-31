import { describe, it, expect } from 'vitest'
import { buildCatalogIndex } from '../../lib/aluCatalogPricing.js'
import { withFamilyResolver } from '../../lib/seriesFamily.js'
import { hardwareBanners, availabilityIssues, draftFromProject, reconcileDraft, buildPatch, draftSeriesKey, applySeriesKey, patchChangesSeries } from './projectDefaults.js'
import { packagesForSeriesIds } from '../../lib/projectHardware.js'

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

describe('the ซีรีส์หลัก draft', () => {
  const legacy = { id: 'p', primary_provider_id: 'A', default_series_id: 'iSlide', default_finish_id: 'fin', profit_pct: 50 }
  it('a legacy project reads as a solo key; picking a family swaps the columns', () => {
    const d = draftFromProject(legacy)
    expect(d.default_series_family_id).toBe('')
    expect(draftSeriesKey(d)).toBe('series:iSlide')
    const f = applySeriesKey(d, 'fI', famIndex)
    expect([f.default_series_family_id, f.default_series_id]).toEqual(['fI', ''])
    expect(draftSeriesKey(applySeriesKey(f, 'series:mc', famIndex))).toBe('series:mc')
  })
  it('saving a family writes the family and clears the single series', () => {
    const d = reconcileDraft(applySeriesKey(draftFromProject(legacy), 'fI', famIndex), famIndex, famSeriesTypes)
    expect(buildPatch(legacy, d)).toEqual({ default_series_family_id: 'fI', default_series_id: null })
    expect(patchChangesSeries(buildPatch(legacy, d))).toBe(true)
    expect(patchChangesSeries({ profit_pct: 5 })).toBe(false)
  })
  it('a family fills a blank main extruder', () => {
    expect(applySeriesKey(draftFromProject({}), 'fI', famIndex).primary_provider_id).toBe('A')
  })
  it('switching the main extruder clears a family of another extruder (Review Focus 2)', () => {
    const d = reconcileDraft({ ...draftFromProject({ primary_provider_id: 'A', default_series_family_id: 'fI', default_finish_id: 'fin' }), primary_provider_id: 'B' }, famIndex, famSeriesTypes)
    expect([d.default_series_family_id, d.default_series_id, d.default_finish_id]).toEqual(['', '', ''])
  })
  it("frame thickness: the family's list (STANDARD 5 values) or the union of its series; colour of its extruder kept", () => {
    const std = reconcileDraft({ ...draftFromProject({ primary_provider_id: 'A', default_finish_id: 'fin' }), default_series_family_id: 'fS', default_thickness_mm: '1.8' }, famIndex, famSeriesTypes)
    expect(std.default_thickness_mm).toBe('1.8')
    expect(std.default_finish_id).toBe('fin')
    const bad = reconcileDraft({ ...draftFromProject({ primary_provider_id: 'A' }), default_series_family_id: 'fI', default_thickness_mm: '1.8' }, famIndex, famSeriesTypes)
    expect(bad.default_thickness_mm).toBe('')    // ICONIQ EURO offers 1.2 and 2.0 only
  })
  it('the sash thickness exists when one series of the family allows mixed thickness', () => {
    const d = reconcileDraft({ ...draftFromProject({ primary_provider_id: 'A' }), default_series_family_id: 'fI', default_thickness_mm: '2' }, famIndex, famSeriesTypes)
    expect(d.default_sash_thickness_mm).toBe('2')
  })
  it('packages: no series or a series of the family', () => {
    const pk = [{ id: 'a', name: 'B', series_id: null }, { id: 'b', name: 'A', series_id: 'iOpen' }, { id: 'c', name: 'C', series_id: 'b1' }, { id: 'd', name: 'D', series_id: null, active: false }]
    expect(packagesForSeriesIds(pk, ['iOpen', 'iSlide']).map(p => p.id)).toEqual(['b', 'a'])
    expect(packagesForSeriesIds(pk, []).map(p => p.id)).toEqual(['a'])
  })
})
