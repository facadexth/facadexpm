import { describe, it, expect } from 'vitest'
import { availableLayoutTemplates, applyLayoutTemplate, bomTemplatesForType, layoutTemplateFromItem } from './layoutTemplates.js'

const seriesTypes = [{ series_id: 's1', type_id: 'slide' }, { series_id: 's1', type_id: 'fixed' }, { series_id: 's2', type_id: 'slide' }]
const tpls = [
  { id: 'a', name: 'บานเลื่อน + ช่องแสงบน', main_type_id: 'slide', addon_type_id: 'fixed', addon_position: 'top', addon_width_ratio: 1, addon_height_ratio: 0.3, addon_offset_ratio: 0, main_panel_count: 2, addon_panel_count: 1 },
  { id: 'b', name: 'บานเลื่อนเปล่า', main_type_id: 'slide', addon_type_id: null, addon_position: null },
  { id: 'c', name: 'ประตู', main_type_id: 'swing' },
  { id: 'd', name: 'ปิด', main_type_id: 'slide', active: false },
]

describe('availableLayoutTemplates', () => {
  it('shows only the main type\'s templates, usable first, with the reason for a greyed card', () => {
    const r = availableLayoutTemplates(tpls, { mainTypeId: 'slide', seriesId: 's2', seriesTypes })
    expect(r.map(x => [x.template.id, x.usable, x.reason])).toEqual([['b', true, null], ['a', false, 'addon_type_not_offered']])
    expect(availableLayoutTemplates(tpls, { mainTypeId: 'slide', seriesId: 's1', seriesTypes }).every(x => x.usable)).toBe(true)
  })
  it('without a series nothing is judged unusable; without a main type every active template shows', () => {
    expect(availableLayoutTemplates(tpls, { mainTypeId: 'slide', seriesId: null, seriesTypes }).every(x => x.usable)).toBe(true)
    expect(availableLayoutTemplates(tpls, { mainTypeId: null, seriesId: null, seriesTypes }).length).toBe(3)
  })
  it('a series that lacks the main type itself is not usable', () => {
    expect(availableLayoutTemplates(tpls, { mainTypeId: 'swing', seriesId: 's1', seriesTypes })[0].reason).toBe('main_type_not_offered')
  })
  it('without options does not throw', () => {
    expect(availableLayoutTemplates(tpls)).toHaveLength(3)
  })
})

describe('applyLayoutTemplate', () => {
  it('top add-on: width and offset against the main width, height against the main height', () => {
    expect(applyLayoutTemplate({ ...tpls[0], addon_width_ratio: 0.5, addon_offset_ratio: 0.25 }, 2, 1.5)).toEqual({
      main_panel_count: 2, addon_type_id: 'fixed', addon_position: 'top', addon_width_m: 1, addon_height_m: 0.45, addon_offset_m: 0.5, addon_panel_count: 1,
    })
  })
  it('left/right add-on: offset runs along the main height', () => {
    const r = applyLayoutTemplate({ ...tpls[0], addon_position: 'left', addon_width_ratio: 0.2, addon_offset_ratio: 0.5 }, 2, 1.5)
    expect(r.addon_offset_m).toBe(0.75)
    expect(r.addon_width_m).toBe(0.4)
  })
  it('a template without an add-on, or a missing size, is handled', () => {
    expect(applyLayoutTemplate(tpls[1], 2, 1.5).addon_type_id).toBeNull()
    expect(applyLayoutTemplate(tpls[0], 0, 1.5)).toBeNull()
    expect(applyLayoutTemplate(null, 2, 1.5)).toBeNull()
  })
  it('save-then-apply round trip for left and right returns same addon dimensions', () => {
    const t = layoutTemplateFromItem({ name: 'left-test', mainTypeId: 'swing', addonTypeId: 'fixed', position: 'left', widthM: 2, heightM: 1.5, addonWidthM: 0.4, addonHeightM: 0.45, offsetM: 0.75, mainPanels: 1, addonPanels: 1 })
    const result = applyLayoutTemplate(t, 2, 1.5)
    expect(result.addon_width_m).toBe(0.4)
    expect(result.addon_height_m).toBe(0.45)
    expect(result.addon_offset_m).toBe(0.75)
  })
  it('template with null addon_width_ratio and addon_height_ratio applies with finite defaults', () => {
    const result = applyLayoutTemplate({ main_type_id: 'slide', addon_type_id: 'fixed', addon_position: 'top', addon_width_ratio: null, addon_height_ratio: null, addon_offset_ratio: 0 }, 2, 1.5)
    expect(Number.isFinite(result.addon_width_m)).toBe(true)
    expect(Number.isFinite(result.addon_height_m)).toBe(true)
    expect(result.addon_width_m).toBe(2)
    expect(result.addon_height_m).toBe(0.5)
  })
  it('offset ratio of 1.5 is clamped to 1', () => {
    const result = applyLayoutTemplate({ ...tpls[0], addon_offset_ratio: 1.5 }, 2, 1.5)
    expect(result.addon_offset_m).toBe(2)
  })
})

describe('bomTemplatesForType / layoutTemplateFromItem', () => {
  it('finds the active BOM templates of a type', () => {
    expect(bomTemplatesForType([{ id: 1, type_id: 't' }, { id: 2, type_id: 't', active: false }, { id: 3, type_id: 'u' }], 't').map(t => t.id)).toEqual([1])
  })
  it('turns an item into ratios that apply back to the same sizes', () => {
    const t = layoutTemplateFromItem({ name: ' X ', mainTypeId: 'slide', addonTypeId: 'fixed', position: 'top', widthM: 2, heightM: 1.5, addonWidthM: 1, addonHeightM: 0.45, offsetM: 0.5, mainPanels: 2, addonPanels: 1 })
    expect(t).toMatchObject({ name: 'X', addon_width_ratio: 0.5, addon_height_ratio: 0.3, addon_offset_ratio: 0.25 })
    expect(applyLayoutTemplate(t, 2, 1.5)).toMatchObject({ addon_width_m: 1, addon_height_m: 0.45, addon_offset_m: 0.5 })
  })
  it('refuses a nameless template, and an offset beyond the side is clamped to 1', () => {
    expect(layoutTemplateFromItem({ name: ' ', mainTypeId: 'slide', widthM: 2, heightM: 1 })).toBeNull()
    expect(layoutTemplateFromItem({ name: 'x', mainTypeId: 'slide', addonTypeId: 'f', position: 'top', widthM: 2, heightM: 1, addonWidthM: 1, addonHeightM: 0.3, offsetM: 9 }).addon_offset_ratio).toBe(1)
  })
})

describe('ADDON_POSITIONS', () => {
  it('is the same list the preview uses', async () => {
    const fp = await import('./framePreview.js')
    const lt = await import('./layoutTemplates.js')
    expect(lt.ADDON_POSITIONS).toBe(fp.ADDON_POSITIONS)
  })
})
