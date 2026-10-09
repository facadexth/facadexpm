import { describe, it, expect } from 'vitest'
import { buildCatalogIndex } from '../../lib/aluCatalogPricing.js'
import { emptyForm } from '../../lib/openingPayload.js'
import {
  evaluateConstraints, typeTreeOf, typePath, cascadeLevels, pickInPath, templatesForType, addonTypeOptions, liveItem,
  validateItemForm, reconcileItemForm, showSashField, inheritedHardware, partLabels, layoutCards, applyCardToForm,
  layoutRowFromItem, layoutSaveErrorText, descriptionContext,
} from './itemForm.js'

const types = [
  { id: 'door', name: 'ประตู' }, { id: 'win', name: 'หน้าต่าง' },
  { id: 'slide', name: 'บานเลื่อน', parent_id: 'win' }, { id: 'fixed', name: 'บานติดตาย', parent_id: 'win' },
  { id: 's2', name: '2 บาน', parent_id: 'slide' }, { id: 's3', name: '3 บาน', parent_id: 'slide' },
  { id: 'old', name: 'เลิกใช้', parent_id: 'win', active: false },
]
const index = buildCatalogIndex({
  providers: [{ id: 'A', name: 'โรงรีด A' }, { id: 'B', name: 'โรงรีด B' }],
  series: [{ id: 'sA', provider_id: 'A', name: 'Demo 40' }, { id: 'sB', provider_id: 'B', name: 'Demo 50' }],
  types,
  seriesTypes: [{ series_id: 'sA', type_id: 'win', allow_mixed_thickness: true }, { series_id: 'sB', type_id: 'fixed' }],
  finishes: [{ id: 'fA', provider_id: 'A', name: 'ขาว' }, { id: 'fB', provider_id: 'B', name: 'ดำ' }],
  profiles: [
    { id: 'p14', provider_id: 'A', family: 'frame', thickness_mm: 1.4, drawing_no: 'D40-F1' }, { id: 'p16', provider_id: 'A', family: 'frame', thickness_mm: 1.6 },
    { id: 'pB', provider_id: 'B', family: 'frame', thickness_mm: 2 },
  ],
  seriesProfiles: [{ series_id: 'sA', profile_id: 'p14' }, { series_id: 'sA', profile_id: 'p16' }, { series_id: 'sB', profile_id: 'pB' }],
  parts: [{ id: 'hw1', kind: 'hardware_set', name: 'ชุดเลื่อน' }, { id: 'hw2', kind: 'hardware_set', name: 'ชุดอื่น' }],
  seriesParts: [{ series_id: 'sA', part_id: 'hw1', type_id: 'slide' }, { series_id: 'sA', part_id: 'hw2', type_id: 'door' }],
})
const seriesTypes = Object.values(index.seriesTypesBySeries).flat()
const tplS2 = { id: 't1', name: 'เลื่อน 2', type_id: 's2', active: true }

describe('constraints', () => {
  it('reads string sizes and reports each broken rule', () => {
    const c = [{ rule_type: 'max_width_mm', value: 2000, message: 'กว้างเกิน' }, { rule_type: 'max_panel_count', value: 2, message: 'บานเกิน' }]
    expect(evaluateConstraints({ width_m: '2.1', height_m: '1', panel_count: '3' }, c)).toEqual(['กว้างเกิน', 'บานเกิน'])
    expect(evaluateConstraints({ width_m: 1, height_m: 1, panel_count: 1 }, c)).toEqual([])
  })
})

describe('type cascade', () => {
  const tree = typeTreeOf(types)
  it('shows the next select only when the chosen type has children; the leaf is the chosen childless type', () => {
    expect(cascadeLevels(tree, []).levels).toHaveLength(1)
    const mid = cascadeLevels(tree, ['win'])
    expect(mid.levels.map(l => l.options.map(o => o.label))).toEqual([['ประตู', 'หน้าต่าง'], ['บานติดตาย', 'บานเลื่อน']])
    expect(mid.leafId).toBeNull()
    expect(cascadeLevels(tree, ['win', 'slide']).levels).toHaveLength(3)
    expect(cascadeLevels(tree, ['win', 'slide', 's3']).leafId).toBe('s3')
    expect(cascadeLevels(tree, ['win', 'fixed'])).toMatchObject({ leafId: 'fixed' })
    expect(cascadeLevels(tree, ['door']).leafId).toBe('door')
  })
  it('path from a leaf and picking drops deeper levels', () => {
    expect(typePath(index.types, 's2')).toEqual(['win', 'slide', 's2'])
    expect(pickInPath(['win', 'slide', 's2'], 1, 'fixed')).toEqual(['win', 'fixed'])
    expect(pickInPath(['win', 'slide'], 0, '')).toEqual([])
  })
  it('templates of a type keep the current one; add-on types are the selectable ones that have a template', () => {
    const tpls = [tplS2, { id: 't2', type_id: 'fixed' }, { id: 't3', type_id: 's2', active: false }]
    expect(templatesForType(tpls, 's2', 't2').map(t => t.id)).toEqual(['t1', 't2'])
    expect(addonTypeOptions(types, index.types, tpls)).toEqual([{ value: 's2', label: 'หน้าต่าง › บานเลื่อน › 2 บาน' }, { value: 'fixed', label: 'หน้าต่าง › บานติดตาย' }])
  })
})

describe('live item + validation', () => {
  it('a half-filled add-on is left out of the live item, not an error', () => {
    const { item, addonPartial } = liveItem({ ...emptyForm(), opening_no: 'W1', template_id: 't1', width_m: '1.2', height_m: '1', has_addon: true, addon_template_id: 't2', addon_width_m: '1.2' }, 'p')
    expect(addonPartial).toBe(true)
    expect(item).toMatchObject({ addon_template_id: null, addon_width_m: null, width_m: 1.2 })
    const full = liveItem({ ...emptyForm(), template_id: 't1', has_addon: true, addon_template_id: 't2', addon_width_m: '1.2', addon_height_m: '0.4', addon_position: 'left' }, 'p')
    expect(full.addonPartial).toBe(false)
    expect(full.item.addon_position).toBe('left')
  })
  it('extra lines need a description and a numeric amount', () => {
    const ok = { ...emptyForm(), opening_no: 'W1', template_id: 't1', width_m: '1', height_m: '1' }
    expect(validateItemForm(ok)).toBeNull()
    expect(validateItemForm({ ...ok, extra_lines: [{ description: 'ดัดโค้ง', amount: 'abc' }] })).toContain('ตัวเลข')
    expect(validateItemForm({ ...ok, extra_lines: [{ description: '', amount: '100' }] })).toContain('รายละเอียด')
    expect(validateItemForm({ ...ok, extra_lines: [{ description: 'ดัดโค้ง', amount: '0' }] })).toBeNull()
  })
})

describe('reconcileItemForm', () => {
  const project = { default_series_id: 'sA', default_thickness_mm: 1.4, primary_provider_id: 'A' }
  it('an own thickness the series does not offer is cleared; a single thickness is set when the project value does not fit', () => {
    expect(reconcileItemForm({ ...emptyForm(), thickness_mm: '2' }, { index, project, template: tplS2 }).thickness_mm).toBe('')
    expect(reconcileItemForm({ ...emptyForm(), series_id: 'sB' }, { index, project, template: tplS2 }).thickness_mm).toBe('2')
    expect(reconcileItemForm({ ...emptyForm() }, { index, project, template: tplS2 }).thickness_mm).toBe('')
  })
  it('sash shows only where the series+type allows mixed thickness, and then always holds a real number', () => {
    expect(showSashField(index, 'sA', tplS2)).toBe(true)
    expect(showSashField(index, 'sB', { type_id: 'fixed' })).toBe(false)
    expect(reconcileItemForm({ ...emptyForm() }, { index, project, template: tplS2 }).sash_thickness_mm).toBe('1.4')
    expect(reconcileItemForm({ ...emptyForm(), sash_thickness_mm: '1.6' }, { index, project: { ...project, default_sash_thickness_mm: 1.4 }, template: tplS2 }).sash_thickness_mm).toBe('1.6')
    expect(reconcileItemForm({ ...emptyForm() }, { index, project: { ...project, default_sash_thickness_mm: 1.6 }, template: tplS2 }).sash_thickness_mm).toBe('1.6')
    expect(reconcileItemForm({ ...emptyForm(), series_id: 'sB', sash_thickness_mm: '2' }, { index, project, template: { type_id: 'fixed' } }).sash_thickness_mm).toBe('')
  })
  it('colour and hardware set must fit the series (and type)', () => {
    const f = reconcileItemForm({ ...emptyForm(), alu_finish_id: 'fB', hardware_set_id: 'hw2' }, { index, project, template: tplS2 })
    expect(f.alu_finish_id).toBe('')
    expect(f.hardware_set_id).toBe('')
    expect(reconcileItemForm({ ...emptyForm(), alu_finish_id: 'fA', hardware_set_id: 'hw1' }, { index, project, template: tplS2 })).toMatchObject({ alu_finish_id: 'fA', hardware_set_id: 'hw1' })
  })
})

describe('inherited hardware', () => {
  it('follows the project package by type (ancestor rows count); missing says so; no package = legacy default', () => {
    const pkg = [{ type_id: 'slide', hardware_set_id: 'hw1' }, { type_id: 'fixed', hardware_set_id: null }]
    expect(inheritedHardware({ packageItems: pkg, index, typeId: 's2', project: {} })).toMatchObject({ set_id: 'hw1', status: 'set', label: 'ชุดเลื่อน' })
    expect(inheritedHardware({ packageItems: pkg, index, typeId: 'fixed', project: {} })).toMatchObject({ status: 'none', label: 'ไม่ใช้ชุดอุปกรณ์' })
    expect(inheritedHardware({ packageItems: pkg, index, typeId: 'door', project: {} })).toMatchObject({ status: 'missing', warning: 'ประเภทนี้ยังไม่ได้กำหนดชุดในโปรเจกต์' })
    expect(inheritedHardware({ packageItems: null, index, typeId: 'door', project: { default_hardware_set_id: 'hw2' } })).toMatchObject({ status: 'legacy', label: 'ชุดอื่น' })
  })
})

describe('part labels', () => {
  it('die no. + cut length of the first frame bar along the width and along the height', () => {
    const components = [{ length_rule_type: 'width', thickness_role: 'sash' }, { length_rule_type: 'width_minus' }, { length_rule_type: 'height' }]
    const bom = { profileLines: [{ length_m: 0.7, family: 'sash' }, { length_m: 1.4111, profile_id: 'p14', family: 'frame' }, { length_m: 1.2, family: 'frame' }] }
    expect(partLabels({ components, bom, index })).toEqual({ top: 'D40-F1 1411', bottom: 'D40-F1 1411', left: 'frame 1200', right: 'frame 1200' })
    expect(partLabels({ components: [], bom, index })).toBeNull()
  })
})

describe('layout templates', () => {
  const layouts = [
    { id: 'L1', name: '2 บาน + ช่องแสงบน', main_type_id: 's2', main_panel_count: 2, addon_type_id: 'fixed', addon_position: 'top', addon_width_ratio: 1, addon_height_ratio: 0.25, addon_offset_ratio: 0 },
    { id: 'L2', name: 'ไม่มีของเพิ่ม', main_type_id: 's2', main_panel_count: 3 },
    { id: 'L3', name: 'ประตูอื่น', main_type_id: 'door' },
  ]
  const addonTpl = { id: 'tf', type_id: 'fixed' }
  it('lists the cards of the main type with the add-on template and a reason when unusable', () => {
    const cards = layoutCards({ layoutTemplates: layouts, mainTypeId: 's2', seriesId: 'sA', seriesTypes, addonTemplates: [addonTpl], widthM: '2', heightM: '1.2' })
    expect(cards.map(c => [c.template.id, c.usable])).toEqual([['L1', true], ['L2', true]])
    expect(cards[0].addonTemplate.id).toBe('tf')
    const noAddon = layoutCards({ layoutTemplates: layouts, mainTypeId: 's2', seriesId: 'sA', seriesTypes, addonTemplates: [], widthM: '', heightM: '' })
    expect(noAddon.find(c => c.template.id === 'L1')).toMatchObject({ usable: false, reasonText: 'ยังไม่มีเทมเพลต BOM ของประเภทของเพิ่มเติม', sized: false })
    const otherSeries = layoutCards({ layoutTemplates: layouts, mainTypeId: 's2', seriesId: 'sB', seriesTypes, addonTemplates: [addonTpl], widthM: '2', heightM: '1' })
    expect(otherSeries[0].reasonText).toBe('ซีรีส์นี้ไม่มีประเภทชุดหลักนี้')
  })
  it('clicking a card fills panels and the add-on; a card without add-on clears it', () => {
    const [l1, l2] = layoutCards({ layoutTemplates: layouts, mainTypeId: 's2', seriesId: 'sA', seriesTypes, addonTemplates: [addonTpl], widthM: '2', heightM: '1.2' })
    expect(applyCardToForm(emptyForm(), l1)).toMatchObject({ panel_count: '2', has_addon: true, addon_template_id: 'tf', addon_position: 'top', addon_width_m: '2', addon_height_m: '0.3', addon_offset_m: '0' })
    expect(applyCardToForm({ ...emptyForm(), has_addon: true, addon_template_id: 'tf' }, l2)).toMatchObject({ panel_count: '3', has_addon: false, addon_template_id: '' })
  })
  it('save row from the saved item; duplicate name reads in Thai', () => {
    const row = layoutRowFromItem({ width_m: 2, height_m: 1.2, panel_count: 2, addon_template_id: 'tf', addon_width_m: 2, addon_height_m: 0.3, addon_position: 'top', addon_offset_m: null, addon_panel_count: 1 }, { name: ' แบบ A ', mainTypeId: 's2', addonTypeId: 'fixed' })
    expect(row).toMatchObject({ name: 'แบบ A', main_type_id: 's2', addon_type_id: 'fixed', addon_position: 'top', addon_height_ratio: 0.25, addon_offset_ratio: 0, main_panel_count: 2 })
    expect(layoutSaveErrorText({ code: '23505', message: 'duplicate key value' })).toBe('มีแม่แบบรูปแบบชื่อนี้แล้ว ตั้งชื่ออื่นแล้วบันทึกอีกครั้ง')
    expect(layoutSaveErrorText({ message: 'boom' })).toContain('boom')
  })
})

describe('description context', () => {
  it('uses the resolved (inherited) values and the type chain', () => {
    const ctx = descriptionContext({ item: { item_name: 'W-03', width_m: 1.8, height_m: 1.2 }, resolved: { series_id: 'sA', finish_id: 'fA', thickness_mm: 1.4 }, index, template: tplS2, infillTypesById: {} })
    expect(ctx).toMatchObject({ item_name: 'W-03', type_name: 'หน้าต่าง บานเลื่อน 2 บาน', series_label: 'Demo 40 · โรงรีด A', finish_name: 'ขาว', thickness_mm: 1.4 })
  })
})
