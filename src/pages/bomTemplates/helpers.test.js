import { describe, it, expect } from 'vitest'
import {
  catalogFamilies, templateTypeOptions, hardwarePartOptions, relinkAfterJointRemoved, validateComponentRows,
  jointDeductionPreview, notchGeometry, itemRowsForSave, editorRowsFromItems, hardwareSetChoices, flatTypeRows, typeAllowsMixed,
} from './helpers.js'

const types = [
  { id: 'w', name: 'หน้าต่าง', parent_id: null }, { id: 'ws', name: 'บานเลื่อน', parent_id: 'w' }, { id: 'wf', name: 'บานติดตาย', parent_id: 'w' },
]
const typesById = Object.fromEntries(types.map(t => [t.id, t]))
const index = {
  types: typesById,
  series: { s1: { id: 's1', name: 'S1', active: true } },
  seriesTypesBySeries: { s1: [{ series_id: 's1', type_id: 'ws', allow_mixed_thickness: true }] },
  seriesProfilesBySeries: { s1: [{ series_id: 's1', profile_id: 'p1', family: null }, { series_id: 's1', profile_id: 'p2', family: 'บาน' }] },
  profiles: { p1: { id: 'p1', name: 'กล่อง', family: 'กล่อง', width_mm: 100, depth_mm: 40, primary_contact: 'width' }, p2: { id: 'p2', name: 'บาน', family: 'x', width_mm: 30, depth_mm: 20 } },
  parts: { a: { id: 'a', code: 'HW-A', name: 'ชุด A', kind: 'hardware_set', active: true }, b: { id: 'b', name: 'ชุด B', kind: 'hardware_set', active: true }, c: { id: 'c', name: 'ล้อ', kind: 'hardware', active: true }, d: { id: 'd', name: 'ผง', kind: 'profile', active: true } },
  seriesPartsBySeries: { s1: [{ part_id: 'a', type_id: null }] },
}

describe('bomTemplates helpers', () => {
  it('families come from links first, then profiles', () => {
    expect(catalogFamilies(index)).toEqual(['กล่อง', 'บาน'])
    expect(catalogFamilies(null)).toEqual([])
  })
  it('keeps a saved non-selectable type listed and flags it', () => {
    const r = templateTypeOptions(types, typesById, 'w')
    expect(r.options.map(o => o.id)).toContain('w')
    expect(r.savedNotSelectable).toBe(true)
    const ok = templateTypeOptions(types, typesById, 'ws')
    expect(ok.savedNotSelectable).toBe(false)
    expect(ok.options.find(o => o.id === 'ws').label).toBe('หน้าต่าง › บานเลื่อน')
  })
  it('mixed thickness only where a series allows it', () => {
    expect(typeAllowsMixed(index, 'ws')).toBe(true)
    expect(typeAllowsMixed(index, 'wf')).toBe(false)
    expect(typeAllowsMixed(index, '')).toBe(false)
  })
  it('hardware part options exclude profile parts', () => {
    expect(hardwarePartOptions(index.parts).map(o => o.id).sort()).toEqual(['a', 'b', 'c'])
  })
  it('relinks components after a joint is removed', () => {
    const rows = [{ joint_index: '0' }, { joint_index: '1' }, { joint_index: '2' }, { joint_index: '' }]
    expect(relinkAfterJointRemoved(rows, 1).map(r => r.joint_index)).toEqual(['0', '', '1', ''])
  })
  it('validates component rows', () => {
    const ok = { length_deduction_mm: '0', quantity_value: '1', profile_family: 'บาน', joint_index: '' }
    expect(validateComponentRows([ok], [])).toBeNull()
    expect(validateComponentRows([{ ...ok, length_deduction_mm: '' }], [])).toMatch(/ระยะหัก/)
    expect(validateComponentRows([{ ...ok, length_deduction_mm: '-1' }], [])).toMatch(/ระยะหัก/)
    expect(validateComponentRows([{ ...ok, quantity_value: '0' }], [])).toMatch(/จำนวน/)
    expect(validateComponentRows([{ ...ok, joint_index: '0' }], [{ secondary_family: 'อื่น' }])).toBe('ส่วนประกอบที่ผูกจุดชนต้องเป็นหน้าตัดเดียวกับเส้นรองของจุดชน')
    expect(validateComponentRows([{ ...ok, joint_index: '0' }], [{ secondary_family: 'บาน' }])).toBeNull()
  })
  it('reads the auto deduction from the catalog profile', () => {
    expect(jointDeductionPreview(index, { deduction_mode: 'auto', cut_style: 'square', main_family: 'กล่อง' }, 'ws')).toEqual([{ mm: 40, profile: 'กล่อง' }])
    expect(jointDeductionPreview(index, { deduction_mode: 'manual', deduction_mm: '12', cut_style: 'square', main_family: 'กล่อง' }, 'ws')[0].mm).toBe(12)
    expect(jointDeductionPreview(index, { deduction_mode: 'auto', cut_style: 'miter45', main_family: 'กล่อง' }, 'ws')[0].mm).toBe(0)
  })
  it('draws notch geometry from numbers', () => {
    const g = notchGeometry({ style: 'notch', widthMm: 40, depthMm: 20, mainDepthMm: 40 })
    expect(g.points.split(' ').length).toBe(8)
    expect(notchGeometry({ style: 'square', widthMm: 0, depthMm: 0 }).points.split(' ').length).toBe(4)
    expect(notchGeometry({ style: 'miter45', widthMm: 10, depthMm: 10 }).mainDepth).toBe(40)
  })
  it('package rows round trip and skip unassigned', () => {
    const rows = editorRowsFromItems([{ package_id: 'k', type_id: 'ws', hardware_set_id: 'a' }, { package_id: 'k', type_id: 'wf', hardware_set_id: null }, { package_id: 'z', type_id: 'w', hardware_set_id: 'a' }], 'k')
    expect(rows).toEqual([{ type_id: 'ws', choice: 'a' }, { type_id: 'wf', choice: '__none__' }])
    expect(itemRowsForSave([...rows, { type_id: 'w', choice: '' }, { type_id: '', choice: 'a' }])).toEqual([{ type_id: 'ws', hardware_set_id: 'a' }, { type_id: 'wf', hardware_set_id: null }])
  })
  it('set choices follow the package series', () => {
    expect(hardwareSetChoices(index, 's1', 'ws', '').map(o => o.id)).toEqual(['a'])
    expect(hardwareSetChoices(index, '', 'ws', '').map(o => o.id).sort()).toEqual(['a', 'b'])
    expect(hardwareSetChoices(index, 's1', 'ws', 'b').map(o => o.id)).toEqual(['a', 'b'])
  })
  it('flattens the type tree at any level', () => {
    expect(flatTypeRows(types, typesById).map(r => r.id)).toEqual(['w', 'wf', 'ws'])
  })
})
