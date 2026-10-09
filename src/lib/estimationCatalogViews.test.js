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

describe('estimationCatalogViews with parent / child types', () => {
  const tree = buildCatalogIndex({
    series: [{ id: 's1', name: 'S1' }, { id: 's2', name: 'S2' }],
    types: [
      { id: 'door', name: 'ประตู', parent_id: null },
      { id: 'slide', name: 'บานเลื่อน', parent_id: 'door' },
      { id: 'low', name: 'รางล่าง', parent_id: 'slide' },
      { id: 'top', name: 'รางบน', parent_id: 'slide' },
    ],
    seriesTypes: [{ series_id: 's1', type_id: 'door', allow_mixed_thickness: false }, { series_id: 's2', type_id: 'slide', allow_mixed_thickness: true }],
    parts: [{ id: 'hp', name: 'P', kind: 'hardware' }, { id: 'hl', name: 'L', kind: 'hardware' }],
    seriesParts: [{ series_id: 's1', type_id: 'slide', part_id: 'hp' }, { series_id: 's1', type_id: 'low', part_id: 'hl' }],
  })
  it('a part linked to a parent type shows for its grandchild', () => {
    expect(hardwareForSeries(tree, 's1', 'top').map(p => p.id)).toEqual(['hp'])
  })
  it('a part linked to one child does not show for its sibling', () => {
    expect(hardwareForSeries(tree, 's1', 'low').map(p => p.id).sort()).toEqual(['hl', 'hp'])
    expect(hardwareForSeries(tree, 's1', 'top').map(p => p.id)).not.toContain('hl')
  })
  it('seriesForType finds a series linked only to the top-level type', () => {
    expect(seriesForType(tree, 'low').map(s => s.id)).toEqual(['s1', 's2'])
  })
  it('a descendant inherits the mixed-thickness flag of its nearest linked ancestor', () => {
    expect(allowsMixedThickness(tree, 's2', 'low')).toBe(true)
    expect(allowsMixedThickness(tree, 's1', 'low')).toBe(false)
  })
})
