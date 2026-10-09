import { describe, it, expect } from 'vitest'
import { buildCatalogIndex } from './aluCatalogPricing.js'
import {
  thicknessesForSeries, hardwareSetsForSeries, hardwareForSeries, accessoriesForSeries,
  typesForSeries, seriesForType, allowsMixedThickness,
} from './estimationCatalogViews.js'

const rows = {
  providers: [{ id: 'pA', name: 'A' }],
  series: [{ id: 's1', provider_id: 'pA', name: 'S1' }, { id: 's2', provider_id: 'pA', name: 'S2' }],
  types: [{ id: 't1', name: 'บานเลื่อน' }, { id: 't2', name: 'บานเปิด' }, { id: 't3', name: 'ปิดอยู่', active: false }],
  seriesTypes: [
    { series_id: 's1', type_id: 't1', allow_mixed_thickness: true },
    { series_id: 's1', type_id: 't2' },
    { series_id: 's1', type_id: 't3' },
    { series_id: 's2', type_id: 't1' },
  ],
  profiles: [
    { id: 'p1', provider_id: 'pA', thickness_mm: 1.2 }, { id: 'p2', provider_id: 'pA', thickness_mm: 1.5 },
    { id: 'p3', provider_id: 'pA', thickness_mm: 1.5 }, { id: 'p4', provider_id: 'pA', thickness_mm: 2, active: false },
    { id: 'p5', provider_id: 'pA', thickness_mm: null },
  ],
  seriesProfiles: ['p1', 'p2', 'p3', 'p4', 'p5'].map(profile_id => ({ series_id: 's1', profile_id })),
  parts: [
    { id: 'h1', name: 'ชุด B', kind: 'hardware_set' }, { id: 'h2', name: 'ชุด A', kind: 'hardware_set' },
    { id: 'h3', name: 'ล้อ', kind: 'hardware' }, { id: 'a1', name: 'shim', kind: 'accessory' },
    { id: 'h4', name: 'เลิกใช้', kind: 'hardware_set', active: false },
  ],
  seriesParts: [
    { series_id: 's1', type_id: 't1', part_id: 'h1' }, { series_id: 's1', type_id: null, part_id: 'h2' },
    { series_id: 's1', type_id: 't2', part_id: 'h3' }, { series_id: 's1', type_id: null, part_id: 'a1' },
    { series_id: 's1', type_id: 't1', part_id: 'h4' },
  ],
}
const index = buildCatalogIndex(rows)

describe('estimationCatalogViews', () => {
  it('lists distinct active thicknesses, ascending; no thickness / inactive profiles are skipped', () => {
    expect(thicknessesForSeries(index, 's1')).toEqual([1.2, 1.5])
    expect(thicknessesForSeries(index, 'nope')).toEqual([])
  })
  it('hardware sets: the type\'s links plus every-type links, active only, sorted by name', () => {
    expect(hardwareSetsForSeries(index, 's1', 't1').map(p => p.id)).toEqual(['h2', 'h1'])
    expect(hardwareSetsForSeries(index, 's1', 't2').map(p => p.id)).toEqual(['h2'])
  })
  it('with no type given every link of the series counts', () => {
    expect(hardwareSetsForSeries(index, 's1', null).map(p => p.id)).toEqual(['h2', 'h1'])
  })
  it('hardware and accessories are separate kinds', () => {
    expect(hardwareForSeries(index, 's1', 't2').map(p => p.id)).toEqual(['h3'])
    expect(hardwareForSeries(index, 's1', 't1')).toEqual([])
    expect(accessoriesForSeries(index, 's1', 't1').map(p => p.id)).toEqual(['a1'])
  })
  it('types for a series skip inactive types; series for a type lists every offering series', () => {
    expect(typesForSeries(index, 's1').map(t => t.id)).toEqual(['t2', 't1'])
    expect(seriesForType(index, 't1').map(s => s.id)).toEqual(['s1', 's2'])
    expect(seriesForType(index, 't2').map(s => s.id)).toEqual(['s1'])
  })
  it('mixed thickness is allowed only where the series-type link says so', () => {
    expect(allowsMixedThickness(index, 's1', 't1')).toBe(true)
    expect(allowsMixedThickness(index, 's1', 't2')).toBe(false)
    expect(allowsMixedThickness(index, 's2', 't9')).toBe(false)
  })
})
