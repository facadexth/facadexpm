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
    expect(thaiTypeError('duplicate key value violates unique constraint "door_window_types_tenant_id_name_key"')).toBe('ชื่อประเภทนี้มีอยู่แล้ว (ชื่อต้องไม่ซ้ำกันทุกระดับ) ให้ใช้ชื่อเต็ม เช่น ประตูบานเลื่อนรางล่าง')
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

// ---- Task 9: layout_kind / layout_params on the type form ----
import { layoutKindOptions, typeLayoutInputs, typeLayoutParamsPayload, typeLayoutParamsForKind, typeLayoutFields } from './catalogTypeForm.js'
import { buildPayload, emptyForm, formFromRow } from './catalogForm.js'
import { kinds, layoutLabels } from './layoutRegistry.js'

describe('type form: layout kind and its fixed-by-type params', () => {
  it('the kind select lists every registered kind with its Thai label', () => {
    const opts = layoutKindOptions()
    expect(opts.map(o => o.value)).toEqual(kinds().filter(k => layoutLabels[k]))
    expect(opts.find(o => o.value === 'swing_door').label).toBe('ประตูบานเปิด/สวิง')
    expect(opts).toHaveLength(13)
  })
  it('the params fieldset shows only the kind\'s fixed_by_type inputs', () => {
    expect(typeLayoutInputs('awning_grid').map(i => i.key)).toEqual(['rows', 'cols'])
    expect(typeLayoutInputs('swing_door').map(i => i.key)).toEqual(['leaves', 'pivot'])
    expect(typeLayoutInputs('sliding_n').map(i => i.key)).toEqual(['door'])
    expect(typeLayoutInputs('curtain_wall').map(i => i.key)).toEqual(['unitized'])
    expect(typeLayoutInputs('fixed_grid')).toEqual([])
    expect(typeLayoutInputs('')).toEqual([])
    expect(typeLayoutInputs('nope')).toEqual([])
  })
  it('serialises numbers as numbers and booleans as booleans, drops unknown / non-fixed keys and blanks', () => {
    expect(typeLayoutParamsPayload('awning_grid', { rows: '3', cols: '2', open: 'in', junk: 1 })).toEqual({ rows: 3, cols: 2 })
    expect(typeLayoutParamsPayload('awning_grid', { rows: '3', cols: '' })).toEqual({ rows: 3 })
    expect(typeLayoutParamsPayload('swing_door', { leaves: '2', pivot: true })).toEqual({ leaves: 2, pivot: true })
    expect(typeLayoutParamsPayload('sliding_n', { door: false })).toEqual({ door: false })
    expect(typeLayoutParamsPayload('awning_grid', { rows: '99' })).toEqual({ rows: 8 })
  })
  it('nothing to send is null (no kind, a kind without fixed inputs, all blank, junk form)', () => {
    expect(typeLayoutParamsPayload('', { rows: 3 })).toBeNull()
    expect(typeLayoutParamsPayload('fixed_grid', { rows: 3 })).toBeNull()
    expect(typeLayoutParamsPayload('awning_grid', { rows: '', cols: '' })).toBeNull()
    expect(typeLayoutParamsPayload('awning_grid', '')).toBeNull()
  })
  it('changing the kind keeps only the values the new kind has', () => {
    expect(typeLayoutParamsForKind('swing_door', { rows: 3, leaves: 2, pivot: true })).toEqual({ leaves: 2, pivot: true })
    expect(typeLayoutParamsForKind('', { rows: 3 })).toEqual({})
    expect(typeLayoutParamsForKind('awning_grid', null)).toEqual({})
  })
})

describe('type form payload (buildPayload with typeLayoutFields): omitWhenAbsent for both fields', () => {
  const F = typeLayoutFields()
  it('a new type with no kind sends neither key (saves before the migration)', () => {
    const p = buildPayload(F, emptyForm(F))
    expect('layout_kind' in p).toBe(false)
    expect('layout_params' in p).toBe(false)
  })
  it('an old row without the columns, edited without a kind, sends neither key', () => {
    const row = { id: 'x', name: 'old' }
    const p = buildPayload(F, formFromRow(F, row), row)
    expect(p).toEqual({})
  })
  it('a kind with params sends the kind and numeric params', () => {
    const p = buildPayload(F, { layout_kind: 'awning_grid', layout_params: { rows: '3', cols: '4', junk: 'x' } })
    expect(p).toEqual({ layout_kind: 'awning_grid', layout_params: { rows: 3, cols: 4 } })
    expect(typeof p.layout_params.rows).toBe('number')
  })
  it('a row with the columns: clearing the kind sends layout_kind null and layout_params {} (NOT NULL column)', () => {
    const row = { id: 'x', layout_kind: 'awning_grid', layout_params: { rows: 3 } }
    const form = formFromRow(F, row)
    expect(form.layout_params).toEqual({ rows: 3 })
    expect(buildPayload(F, { ...form, layout_kind: '', layout_params: {} }, row)).toEqual({ layout_kind: null, layout_params: {} })
    expect(buildPayload(F, { layout_kind: 'fixed_grid', layout_params: {} }, row)).toEqual({ layout_kind: 'fixed_grid', layout_params: {} })
  })
  it('the kind field resets params to the new kind\'s keys', () => {
    const kindField = F.find(f => f.key === 'layout_kind')
    expect(kindField.sets('swing_door', { layout_kind: 'swing_door', layout_params: { rows: 3, leaves: 2 } })).toEqual({ layout_params: { leaves: 2 } })
    expect(F.find(f => f.key === 'layout_params').hidden({ layout_kind: 'fixed_grid' })).toBe(true)
    expect(F.find(f => f.key === 'layout_params').hidden({ layout_kind: 'awning_grid' })).toBe(false)
  })
})
