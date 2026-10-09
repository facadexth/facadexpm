import { describe, it, expect } from 'vitest'
import { buildTypeTree, selectableTypes, isSelectableType, typeLabel, typeAndAncestorIds, typeLabourDefault, expandSeriesTypes } from './typeTree.js'

const T = [
  { id: 'door', name: 'ประตู', category: 'door', parent_id: null, active: true, default_labour_per_sqm: 300 },
  { id: 'slide', name: 'บานเลื่อน', category: 'door', parent_id: 'door', active: true, default_labour_per_sqm: null },
  { id: 'low', name: 'รางล่าง', category: 'door', parent_id: 'slide', active: true, default_labour_per_sqm: null },
  { id: 'top', name: 'รางบน', category: 'door', parent_id: 'slide', active: true, default_labour_per_sqm: 350 },
  { id: 'swing', name: 'บานเปิด', category: 'door', parent_id: 'door', active: true },
  { id: 'win', name: 'หน้าต่าง', category: 'window', parent_id: null, active: true },
  { id: 'off', name: 'ปิดใช้งาน', category: 'window', parent_id: 'win', active: false },
]
const byId = Object.fromEntries(T.map(t => [t.id, t]))

describe('buildTypeTree', () => {
  it('nests up to three levels, sorted by name; an orphan becomes a root', () => {
    const tree = buildTypeTree(T)
    expect(tree.map(n => n.type.id).sort()).toEqual(['door', 'win'])
    const door = tree.find(n => n.type.id === 'door')
    expect(door.children.map(c => c.type.id).sort()).toEqual(['slide', 'swing'])
    expect(door.children.find(c => c.type.id === 'slide').children.map(c => c.type.id).sort()).toEqual(['low', 'top'])
    expect(buildTypeTree([{ id: 'k', name: 'k', parent_id: 'gone' }]).map(n => n.type.id)).toEqual(['k'])
  })
  it('never throws or loops on null, empty or cyclic input', () => {
    expect(buildTypeTree(null)).toEqual([])
    expect(buildTypeTree([])).toEqual([])
    expect(() => buildTypeTree([{ id: 'a', name: 'a', parent_id: 'b' }, { id: 'b', name: 'b', parent_id: 'a' }])).not.toThrow()
  })
})

describe('selectableTypes / isSelectableType (Ruling 18: leaves only)', () => {
  it('a type with active children is not selectable at any level', () => {
    expect(selectableTypes(T).map(t => t.id).sort()).toEqual(['low', 'swing', 'top', 'win'])   // win: its only child is inactive
    expect(isSelectableType(T, 'door')).toBe(false)
    expect(isSelectableType(T, 'slide')).toBe(false)
    expect(isSelectableType(T, 'low')).toBe(true)
  })
  it('inactive types are not selectable; a parent whose children are all inactive becomes selectable again', () => {
    expect(isSelectableType(T, 'off')).toBe(false)
    expect(isSelectableType(T, 'win')).toBe(true)
  })
  it('unknown or empty ids are not selectable', () => {
    expect(isSelectableType(T, 'nope')).toBe(false)
    expect(isSelectableType(T, null)).toBe(false)
  })
})

describe('typeLabel / typeAndAncestorIds / typeLabourDefault', () => {
  it('labels from the top down, joined with " › "', () => {
    expect(typeLabel(byId, 'low')).toBe('ประตู › บานเลื่อน › รางล่าง')
    expect(typeLabel(byId, 'slide')).toBe('ประตู › บานเลื่อน')
    expect(typeLabel(byId, 'door')).toBe('ประตู')
    expect(typeLabel(byId, 'nope')).toBe('')
  })
  it('lists the type then its ancestors, nearest first', () => {
    expect(typeAndAncestorIds(byId, 'low')).toEqual(['low', 'slide', 'door'])
    expect(typeAndAncestorIds(byId, 'door')).toEqual(['door'])
    expect(typeAndAncestorIds(byId, null)).toEqual([])
    expect(typeAndAncestorIds({}, 'q')).toEqual(['q'])
    expect(typeAndAncestorIds({ a: { id: 'a', parent_id: 'b' }, b: { id: 'b', parent_id: 'a' } }, 'a')).toEqual(['a', 'b'])
  })
  it('the labour rate comes from the nearest type that has one; 0 is a real value', () => {
    expect(typeLabourDefault(byId, 'low')).toBe(300)
    expect(typeLabourDefault(byId, 'top')).toBe(350)
    expect(typeLabourDefault({ ...byId, slide: { ...byId.slide, default_labour_per_sqm: 0 } }, 'low')).toBe(0)
    expect(typeLabourDefault(byId, 'win')).toBeNull()
    expect(typeLabourDefault(byId, 'nope')).toBeNull()
  })
})

describe('expandSeriesTypes', () => {
  it('a link on a type also offers every descendant, inheriting the mixed-thickness flag', () => {
    const out = expandSeriesTypes([{ id: 'l1', series_id: 's1', type_id: 'slide', allow_mixed_thickness: true }], T)
    expect(out.filter(l => l.series_id === 's1').map(l => l.type_id).sort()).toEqual(['low', 'slide', 'top'])
    expect(out.find(l => l.type_id === 'top')).toMatchObject({ allow_mixed_thickness: true, inherited_from: 'slide' })
  })
  it('a link on the top level reaches the third level', () => {
    const out = expandSeriesTypes([{ id: 'l1', series_id: 's1', type_id: 'door', allow_mixed_thickness: false }], T)
    expect(out.map(l => l.type_id).sort()).toEqual(['door', 'low', 'slide', 'swing', 'top'])
  })
  it('a deeper type linked alone offers only itself', () => {
    expect(expandSeriesTypes([{ id: 'l2', series_id: 's2', type_id: 'low', allow_mixed_thickness: false }], T).map(l => l.type_id)).toEqual(['low'])
  })
  it('an explicit link wins, and the NEAREST linked ancestor wins over a farther one, without duplicates', () => {
    const links = [
      { id: 'a', series_id: 's1', type_id: 'door', allow_mixed_thickness: false },
      { id: 'b', series_id: 's1', type_id: 'slide', allow_mixed_thickness: true },
      { id: 'c', series_id: 's1', type_id: 'top', allow_mixed_thickness: false },
    ]
    const out = expandSeriesTypes(links, T)
    expect(out.filter(l => l.type_id === 'low')).toHaveLength(1)
    expect(out.find(l => l.type_id === 'low').allow_mixed_thickness).toBe(true)
    expect(out.filter(l => l.type_id === 'top')).toHaveLength(1)
    expect(out.find(l => l.type_id === 'top').allow_mixed_thickness).toBe(false)
    expect(out.find(l => l.type_id === 'swing').allow_mixed_thickness).toBe(false)
  })
  it('does not mutate its inputs and tolerates null', () => {
    const links = [{ id: 'l1', series_id: 's1', type_id: 'door', allow_mixed_thickness: true }]
    const copy = JSON.stringify(links)
    expandSeriesTypes(links, T)
    expect(JSON.stringify(links)).toBe(copy)
    expect(expandSeriesTypes(null, null)).toEqual([])
  })
})
