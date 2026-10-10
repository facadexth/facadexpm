import { describe, it, expect } from 'vitest'
import { jointRowsForInsert, validateJoints, componentRowsForInsert, jointIndexForLoad } from './templateSave.js'

describe('jointRowsForInsert', () => {
  it('numbers the order, names a nameless joint, and nulls the fields the mode / style does not use', () => {
    const rows = jointRowsForInsert([
      { name: '', main_family: ' box ', secondary_family: 'bar', deduction_mode: 'auto', deduction_mm: '9', cut_style: 'square', notch_width_mm: '5' },
      { name: 'ตัวแบ่ง', main_family: 'box', secondary_family: 'mid', deduction_mode: 'manual', deduction_mm: '3', cut_style: 'notch', notch_width_mm: '40', notch_depth_mm: '20' },
    ], 't1')
    expect(rows[0]).toMatchObject({ template_id: 't1', name: 'จุดชน 1', main_family: 'box', deduction_mm: null, notch_width_mm: null, sort_order: 0 })
    expect(rows[1]).toMatchObject({ deduction_mode: 'manual', deduction_mm: 3, cut_style: 'notch', notch_width_mm: 40, notch_depth_mm: 20, sort_order: 1 })
  })
  it('manual 0 is kept as 0; an unknown cut style becomes square', () => {
    const r = jointRowsForInsert([{ main_family: 'a', secondary_family: 'b', deduction_mode: 'manual', deduction_mm: '0', cut_style: 'bevel' }], 't')[0]
    expect(r.deduction_mm).toBe(0)
    expect(r.cut_style).toBe('square')
  })
})

describe('validateJoints', () => {
  it('names the first problem; null for none', () => {
    expect(validateJoints([])).toBeNull()
    expect(validateJoints([{ main_family: '', secondary_family: 'b' }])).toMatch(/จุดชนที่ 1/)
    expect(validateJoints([{ main_family: 'a', secondary_family: 'b', deduction_mode: 'manual', deduction_mm: '' }])).toMatch(/ค่าหัก/)
    expect(validateJoints([{ main_family: 'a', secondary_family: 'b', cut_style: 'notch', notch_width_mm: '40' }])).toMatch(/ขนาดบาก/)
    expect(validateJoints([{ main_family: 'a', secondary_family: 'b', deduction_mode: 'manual', deduction_mm: '0', cut_style: 'notch', notch_width_mm: '40', notch_depth_mm: '20' }])).toBeNull()
  })
})

describe('componentRowsForInsert', () => {
  it('maps joint_index to the newly inserted joint id and drops editor-only / old ids', () => {
    const out = componentRowsForInsert([
      { id: 'old', tenant_id: 'x', created_at: 'y', role_name: 'bar', profile_family: 'bar', length_rule_type: 'width', length_deduction_mm: '0', quantity_basis: 'fixed', quantity_value: '2', joint_index: '1', joint_ends: '1', thickness_mm: '' },
      { role_name: 'top', profile_family: 'box', length_rule_type: 'width', length_deduction_mm: 0, quantity_basis: 'fixed', quantity_value: 1, joint_index: '' },
    ], 't1', [{ id: 'jA' }, { id: 'jB' }])
    expect(out[0]).toMatchObject({ template_id: 't1', joint_id: 'jB', joint_ends: 1, thickness_role: null, quantity_value: 2, sort_order: 0 })
    expect(out[0]).not.toHaveProperty('thickness_mm')
    expect(out[0]).not.toHaveProperty('id')
    expect(out[0]).not.toHaveProperty('joint_index')
    expect(out[1]).toMatchObject({ joint_id: null, joint_ends: 2, sort_order: 1 })
  })
  it('a joint index that no longer exists gives no link instead of throwing', () => {
    expect(componentRowsForInsert([{ role_name: 'a', profile_family: 'a', length_rule_type: 'width', quantity_basis: 'fixed', joint_index: '5' }], 't', [{ id: 'j' }])[0].joint_id).toBeNull()
  })
})

describe('jointIndexForLoad', () => {
  it('turns joint_id back into a position in the sort_order sorted joint list', () => {
    const joints = [{ id: 'b', sort_order: 1 }, { id: 'a', sort_order: 0 }]
    const out = jointIndexForLoad([{ joint_id: 'b' }, { joint_id: 'a' }, { joint_id: null }, { joint_id: 'gone' }], joints)
    expect(out.map(c => c.joint_index)).toEqual(['1', '0', '', ''])
  })
})

describe('componentRowsForInsert whitelist', () => {
  it('only the real bom_template_components columns reach the insert, whatever the editor row carries', () => {
    const [row] = componentRowsForInsert([{ foo: 1, bar: 'x', thickness_mm: 2, joint_index: '0', id: 'old', role_name: 'a', profile_family: 'f', length_rule_type: 'width', quantity_basis: 'fixed', thickness_role: 'sash' }], 't', [{ id: 'j' }])
    expect(Object.keys(row).sort()).toEqual(['template_id', 'role_name', 'profile_family', 'length_rule_type', 'length_deduction_mm', 'quantity_basis', 'quantity_value', 'joint_id', 'joint_ends', 'thickness_role', 'sort_order'].sort())
    expect(row).toMatchObject({ thickness_role: 'sash', length_deduction_mm: 0, quantity_value: 0, joint_id: 'j', joint_ends: 2 })
    expect(componentRowsForInsert([{ thickness_role: 'frame' }], 't', [])[0].thickness_role).toBeNull()
  })
})

import { templatePayload } from './templateSave.js'

describe('templatePayload (characterization: legacy templates write the same bom_templates row as before)', () => {
  const form = {
    name: 'T', category: 'window', waste_pct: '10', infill_width_deduction_mm: '5', infill_height_deduction_mm: 'x',
    labor_price_per_sqm: '100', silicone_price_per_m: '0', felt_price_per_m: '2.5', grid_row_weights: [1, 2],
    grid_horizontal_rail_family: '', grid_vertical_mullion_family: 'M', type_id: '', preview_kind: 'slide', main_axis: 'vertical', active: true,
  }
  // the literal payload handleSave built before the part editor (copied from BomTemplates.jsx at 4bb10a63)
  const before = f => ({
    name: f.name, category: f.category,
    waste_pct: parseFloat(f.waste_pct) || 0,
    infill_width_deduction_mm: parseFloat(f.infill_width_deduction_mm) || 0,
    infill_height_deduction_mm: parseFloat(f.infill_height_deduction_mm) || 0,
    labor_price_per_sqm: parseFloat(f.labor_price_per_sqm) || 0,
    silicone_price_per_m: parseFloat(f.silicone_price_per_m) || 0,
    felt_price_per_m: parseFloat(f.felt_price_per_m) || 0,
    grid_row_weights: f.grid_row_weights,
    grid_horizontal_rail_family: f.grid_horizontal_rail_family || null,
    grid_vertical_mullion_family: f.grid_vertical_mullion_family || null,
    type_id: f.type_id || null,
    preview_kind: f.preview_kind, main_axis: f.main_axis,
    active: f.active !== false,
  })
  it('a template without layout_kind: identical payload, no layout_kind key at all', () => {
    expect(templatePayload(form)).toStrictEqual(before(form))
    expect(templatePayload({ ...form, layout_kind: '' }, null)).toStrictEqual(before(form))
    expect('layout_kind' in templatePayload({ ...form, layout_kind: null }, undefined)).toBe(false)
  })
  it('a part-model template writes layout_kind; clearing a saved one writes null', () => {
    expect(templatePayload({ ...form, layout_kind: 'sliding_2' })).toStrictEqual({ ...before(form), layout_kind: 'sliding_2' })
    expect(templatePayload({ ...form, layout_kind: '' }, 'sliding_2')).toStrictEqual({ ...before(form), layout_kind: null })
  })
})
