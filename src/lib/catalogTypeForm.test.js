import { describe, it, expect } from 'vitest'
import { flattenTypeTree, typeSubtreeIds, parentOptions, categoryForParent, typePickerOptions, thaiTypeError, sketchShapeFor, sameShapeProfiles } from './catalogTypeForm.js'

const T = [
  { id: 'door', name: 'ประตู', category: 'door', parent_id: null },
  { id: 'slide', name: 'บานเลื่อน', category: 'door', parent_id: 'door' },
  { id: 'low', name: 'รางล่าง', category: 'door', parent_id: 'slide' },
  { id: 'win', name: 'หน้าต่าง', category: 'window', parent_id: null },
  { id: 'cw', name: 'ผนังกระจก', category: 'curtain_wall', parent_id: null },
]

describe('type tree helpers', () => {
  it('flattens with levels and marks selectable leaves only', () => {
    const rows = flattenTypeTree(T)
    expect(rows.map(r => [r.type.id, r.level, r.selectable])).toEqual([
      ['door', 1, false], ['slide', 2, false], ['low', 3, true], ['cw', 1, true], ['win', 1, true],
    ])
  })
  it('subtree', () => { expect([...typeSubtreeIds(T, 'door')].sort()).toEqual(['door', 'low', 'slide']) })
  it('parent options: level 1-2 only, not own subtree', () => {
    expect(parentOptions(T).map(o => o.value).sort()).toEqual(['cw', 'door', 'slide', 'win'])
    // door spans three levels itself, so it fits under nothing
    expect(parentOptions(T, 'door')).toEqual([])
    expect(parentOptions(T, 'win').map(o => o.value).sort()).toEqual(['cw', 'door', 'slide'])
  })
  it('a type with children cannot go under a level-2 type', () => {
    // slide has a child (height 2): under win (level 1) ok, under door's child would be level 3 -> not offered
    expect(parentOptions(T, 'slide').map(o => o.value).sort()).toEqual(['cw', 'door', 'win'])
    const two = [...T, { id: 'x', name: 'x', category: 'window', parent_id: 'win' }]
    expect(parentOptions(two, 'slide').map(o => o.value)).not.toContain('x')
  })
  it('labels use the full path', () => {
    expect(parentOptions(T).find(o => o.value === 'slide').label).toBe('ประตู › บานเลื่อน')
  })
  it('category follows the parent', () => {
    expect(categoryForParent(T, 'win')).toBe('window')
    expect(categoryForParent(T, '')).toBeNull()
  })
  it('picker options in tree order, hides inactive unless kept', () => {
    const t = [...T, { id: 'old', name: 'เก่า', category: 'door', parent_id: null, active: false }]
    expect(typePickerOptions(t).map(o => o.id)).not.toContain('old')
    expect(typePickerOptions(t, new Set(['old'])).find(o => o.id === 'old').label).toBe('เก่า (ปิดใช้งาน)')
    expect(typePickerOptions(T).find(o => o.id === 'slide').hasChildren).toBe(true)
  })
})

describe('misc', () => {
  it('translates trigger errors', () => {
    expect(thaiTypeError('types have at most three levels')).toBe('ประเภทมีได้สูงสุด 3 ระดับ')
    expect(thaiTypeError('something else')).toBeNull()
  })
  it('sketch shape', () => { expect(sketchShapeFor('กล่องเรียบ')).toBe('u'); expect(sketchShapeFor('')).toBe('box') })
  it('same-shape profiles are same extruder, same group, thin first', () => {
    const ps = [
      { id: 'a', provider_id: 'p', shape_group: 'กล่องเรียบ', thickness_mm: 1.5 },
      { id: 'b', provider_id: 'p', shape_group: 'กล่องเรียบ', thickness_mm: 1.0 },
      { id: 'c', provider_id: 'q', shape_group: 'กล่องเรียบ', thickness_mm: 1.2 },
      { id: 'd', provider_id: 'p', shape_group: 'อื่น', thickness_mm: 1.2 },
    ]
    expect(sameShapeProfiles(ps, ps[0]).map(p => p.id)).toEqual(['b'])
    expect(sameShapeProfiles(ps, { id: 'z', provider_id: 'p', shape_group: '' })).toEqual([])
  })
})
