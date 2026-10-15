// Render smoke test: the item popup renders (new and edit, with an add-on, a stale snapshot and layout cards)
// without throwing. Server-side render only: no effects, no clicks, no Supabase.
import { describe, it, expect, vi } from 'vitest'
import { renderToString } from 'react-dom/server'
import { buildCatalogIndex } from '../../lib/aluCatalogPricing.js'
import { mergeSettings } from '../../lib/estimationSettings.js'
import { startModel } from '../../lib/partModel.js'

vi.mock('../../lib/supabase.js', () => ({ supabase: {}, fmt: n => (n == null || isNaN(n) ? '—' : Number(n).toFixed(2)) }))
const { default: ItemModal } = await import('./ItemModal.jsx')

const index = buildCatalogIndex({
  providers: [{ id: 'A', name: 'โรงรีด A', price_basis: 'per_kg' }],
  series: [{ id: 'sA', provider_id: 'A', name: 'Demo 40' }],
  types: [{ id: 'win', name: 'หน้าต่าง' }, { id: 'slide', name: 'บานเลื่อน', parent_id: 'win' }, { id: 'fixed', name: 'บานติดตาย', parent_id: 'win' }],
  seriesTypes: [{ series_id: 'sA', type_id: 'win', allow_mixed_thickness: true }],
  finishes: [{ id: 'fA', provider_id: 'A', name: 'ขาว' }],
  profiles: [{ id: 'p14', provider_id: 'A', family: 'frame', thickness_mm: 1.4, drawing_no: 'D40-F1', width_mm: 44.45, linear_weight_kg_per_m: 1 }],
  seriesProfiles: [{ series_id: 'sA', profile_id: 'p14' }],
})
const tSlide = { id: 'tS', name: 'เลื่อน', type_id: 'slide', active: true, grid_row_weights: [1], waste_pct: 5, labor_price_per_sqm: 0, silicone_price_per_m: 0, felt_price_per_m: 0, infill_width_deduction_mm: 0, infill_height_deduction_mm: 0, main_axis: 'horizontal', preview_kind: 'slide' }
const tFix = { ...tSlide, id: 'tF', name: 'ติดตาย', type_id: 'fixed', main_axis: 'vertical', preview_kind: 'fixed' }
const ctx = {
  templatesById: { tS: tSlide, tF: tFix }, componentsByTemplate: { tS: [{ role_name: 'วงกบบน', profile_family: 'frame', length_rule_type: 'width', length_deduction_mm: 0, quantity_basis: 'fixed', quantity_value: 2 }] },
  hardwareByTemplate: {}, jointsByTemplate: {}, typesById: index.types, infillTypesById: {}, index, settings: mergeSettings(null), packageItems: null,
}
const project = { id: 'p1', default_series_id: 'sA', default_finish_id: 'fA', default_thickness_mm: 1.4, price_as_of: '2026-10-01', description_format: ['item_name', 'type', 'size'] }
const layouts = [{ id: 'L1', name: 'เลื่อน + ช่องแสง', main_type_id: 'slide', main_panel_count: 2, addon_type_id: 'fixed', addon_position: 'top', addon_width_ratio: 1, addon_height_ratio: 0.3, addon_offset_ratio: 0 }]
const props = { project, ctx, templates: [tSlide, tFix], constraints: [{ template_id: 'tS', rule_type: 'max_width_mm', value: 1000, message: 'กว้างเกิน 1 ม.' }], infillTypes: [], layoutTemplates: layouts, seriesTypes: Object.values(index.seriesTypesBySeries).flat(), canEdit: true, onClose() {}, onSaved() {}, onLayoutSaved() {} }

describe('ItemModal renders', () => {
  it('new item', () => {
    const html = renderToString(<ItemModal {...props} opening={null} currentSig={null} />)
    expect(html).toContain('เพิ่มรายการ')
    expect(html).toContain('ภาพตัวอย่าง')
    expect(html).not.toContain('จำนวนชุด')
  })
  it('existing item with an add-on, a stale snapshot, constraint violation and a priced cost', () => {
    const opening = { id: 'o1', project_id: 'p1', opening_no: 'W-01', template_id: 'tS', width_m: '1.8', height_m: 1.2, panel_count: 2, addon_template_id: 'tF', addon_width_m: 1.8, addon_height_m: 0.4, addon_position: 'top', addon_panel_count: 1, quantity: 2, preview_svg_out: '<svg/>', preview_sig: 'old', extra_lines: [] }
    const html = renderToString(<ItemModal {...props} opening={opening} currentSig="new" />)
    expect(html).toContain('แก้ไขรายการ W-01')
    expect(html).toContain('ภาพที่บันทึกไว้เก่ากว่าข้อมูล')
    expect(html).toContain('กว้างเกิน 1 ม.')
    expect(html).toContain('เลื่อน + ช่องแสง')
    expect(html).toContain('<svg')
    expect(html).toContain('ราคายังไม่ครบ')
  })
  it('a layout_kind item draws the part-editor drawing (two styles only)', () => {
    const tPart = { ...tSlide, id: 'tP', name: 'เลื่อน 2 บาน (part)', layout_kind: 'sliding_2' }
    const model = startModel('sliding_2')
    for (const k of Object.keys(model.lines)) model.lines[k][0].profile_family = 'frame'
    const pctx = { ...ctx, templatesById: { ...ctx.templatesById, tP: tPart }, partModelByTemplate: { tP: model } }
    const opening = { id: 'o2', project_id: 'p1', opening_no: 'W-02', template_id: 'tP', width_m: '1.8', height_m: 1.2, panel_count: 2, quantity: 1, extra_lines: [] }
    const html = renderToString(<ItemModal {...props} ctx={pctx} templates={[tSlide, tFix, tPart]} opening={opening} currentSig={null} />)
    expect(html).toContain('data:image/svg+xml')
    expect(html).not.toContain('เส้นเดียว (CAD)')
    expect(html).not.toMatch(/NaN/)
  })
  it('a layout_kind item with saved add-ons: the ช่องแสง rows, one cost line per attach add-on, merge glass, issues', () => {
    const tPart = { ...tSlide, id: 'tP', name: 'เลื่อน 2 บาน (part)', layout_kind: 'sliding_2' }
    const model = startModel('sliding_2')
    for (const k of Object.keys(model.lines)) model.lines[k][0].profile_family = 'frame'
    const addons = [
      { id: 'a1', mode: 'merge', kind: 'fixed', position: 'top', len_mm: 1800, thick_mm: 400, offset_mm: 0, align: 'start', rows: 1, cols: 3 },
      { id: 'a2', mode: 'attach', kind: 'fixed', position: 'right', len_mm: 1200, thick_mm: 500, offset_mm: 0, align: 'end', rows: 2, cols: 1 },
    ]
    const pctx = { ...ctx, templatesById: { ...ctx.templatesById, tP: tPart }, partModelByTemplate: { tP: model }, itemAddonsByOpening: { o3: addons }, addonPiecesByTemplate: { tP: [] } }
    const opening = { id: 'o3', project_id: 'p1', opening_no: 'W-03', template_id: 'tP', width_m: '1.8', height_m: 1.2, panel_count: 2, quantity: 1, extra_lines: [] }
    const html = renderToString(<ItemModal {...props} ctx={pctx} templates={[tSlide, tFix, tPart]} opening={opening} currentSig={null} />).replace(/<!-- -->/g, '')
    expect(html).toContain('ร่วมวงกบ · ติดตาย · บน · 1800 × 400 มม. · 1 × 3 ช่อง · เสมอซ้าย')
    expect(html).toContain('แยกวงกบ · ติดตาย · ขวา · 500 × 1200 มม. · 2 × 1 ช่อง · เสมอล่าง')
    expect(html).toContain('ช่องแสง 2 (แยกวงกบ)')
    expect(html).toContain('กระจกช่องแสง (ร่วมวงกบ) 0.72 ตร.ม.')
    expect(html).toContain('ช่องแสง 1 คิ้วเท: ตำแหน่งนี้ยังไม่ได้เลือกโปรไฟล์')
    expect(html).toContain('หมายเหตุ ช่องแสง 1: ตบเรียบ')
    expect(html).not.toContain('ของเพิ่มเติม <')
    expect(html).not.toMatch(/NaN/)
  })
  it('add-ons still loading: the box says so; a legacy add-on on a layout_kind item shows the convert box', () => {
    const tPart = { ...tSlide, id: 'tP', name: 'เลื่อน 2 บาน (part)', layout_kind: 'sliding_2' }
    const model = startModel('sliding_2')
    const pctx = { ...ctx, templatesById: { ...ctx.templatesById, tP: tPart }, partModelByTemplate: { tP: model } }
    const opening = { id: 'o4', project_id: 'p1', opening_no: 'W-04', template_id: 'tP', width_m: '1.8', height_m: 1.2, panel_count: 2, quantity: 1, extra_lines: [] }
    expect(renderToString(<ItemModal {...props} ctx={pctx} templates={[tSlide, tFix, tPart]} opening={opening} currentSig={null} />)).toContain('กำลังโหลดช่องแสง')
    const legacy = { ...opening, addon_template_id: 'tF', addon_width_m: 1.8, addon_height_m: 0.4, addon_position: 'top', addon_panel_count: 1 }
    const html = renderToString(<ItemModal {...props} ctx={{ ...pctx, itemAddonsByOpening: { o4: [] } }} templates={[tSlide, tFix, tPart]} opening={legacy} currentSig={null} />)
    expect(html).toContain('แปลงเป็นช่องแสงแบบใหม่')
    expect(html).toContain('ของเพิ่มเติม')   // the legacy fields stay editable
  })
})
