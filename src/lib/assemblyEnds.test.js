// src/lib/assemblyEnds.test.js
import { describe, it, expect } from 'vitest'
import { applyJoints } from './assembly.js'
import { buildCatalogIndex } from './aluCatalogPricing.js'

// an empty catalogue: every joint here is manual / mitre, so no main profile is looked up for its size
const index = buildCatalogIndex({})
describe('applyJoints end data', () => {
  it('a jointed component carries the joint name and how many ends it cuts', () => {
    const joints = [{ id: 'j1', name: 'บากรับกรอบนอน', main_family: 'X', secondary_family: 'Y', deduction_mode: 'manual', deduction_mm: 5, cut_style: 'notch', notch_width_mm: 20, notch_depth_mm: 8 }]
    const components = [{ role_name: 'กรอบบานตั้ง', profile_family: 'Y', length_rule_type: 'height', length_deduction_mm: 0, joint_id: 'j1', joint_ends: 1 }]
    const { components: out } = applyJoints({ components, joints, index, seriesId: null, thicknessMm: 1.2 })
    expect(out[0]).toMatchObject({ cut_style: 'notch', cut_ends: 1, joint_name: 'บากรับกรอบนอน', notch_width_mm: 20, notch_depth_mm: 8 })
  })
  it('a mitred main bar cuts both ends; a plain bar cuts none', () => {
    const joints = [{ id: 'j1', name: 'มุม 45', main_family: 'F', secondary_family: 'F', deduction_mode: 'manual', deduction_mm: 0, cut_style: 'miter45' }]
    const components = [{ role_name: 'เฟรมบน', profile_family: 'F', length_rule_type: 'width' }, { role_name: 'อื่น', profile_family: 'Z', length_rule_type: 'width' }]
    const { components: out } = applyJoints({ components, joints, index, seriesId: null, thicknessMm: 1.2 })
    expect(out[0]).toMatchObject({ cut_style: 'miter45', cut_ends: 2, joint_name: 'มุม 45' })
    expect(out[1]).toMatchObject({ cut_style: 'square', cut_ends: 0, joint_name: null })
  })
  it('a square joint cuts no ends; an unresolvable joint falls back to square', () => {
    const joints = [{ id: 'j1', name: 'ชนตรง', main_family: 'X', deduction_mode: 'manual', deduction_mm: 5, cut_style: 'square' }]
    const components = [
      { role_name: 'a', profile_family: 'Y', length_rule_type: 'height', joint_id: 'j1', joint_ends: 2 },
      { role_name: 'b', profile_family: 'Y', length_rule_type: 'perimeter', joint_id: 'j1' },
      { role_name: 'c', profile_family: 'Y', length_rule_type: 'height', joint_id: 'missing' },
    ]
    const { components: out } = applyJoints({ components, joints, index, seriesId: null, thicknessMm: 1.2 })
    expect(out[0]).toMatchObject({ cut_style: 'square', cut_ends: 0, joint_name: 'ชนตรง' })
    expect(out[1]).toMatchObject({ cut_style: 'square', cut_ends: 0, joint_name: null })
    expect(out[2]).toMatchObject({ cut_style: 'square', cut_ends: 0, joint_name: null })
  })
})
