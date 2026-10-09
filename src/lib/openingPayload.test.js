import { describe, it, expect } from 'vitest'
import { emptyForm, formFromOpening, buildOpeningPayload, validateForm } from './openingPayload.js'

const filled = (o = {}) => ({ ...emptyForm(), opening_no: 'D1', template_id: 't1', width_m: '2.4', height_m: '2.1', ...o })

describe('buildOpeningPayload', () => {
  it('blank inherit fields become NULL, never empty strings or 0', () => {
    const p = buildOpeningPayload(filled(), { projectId: 'p1' })
    expect(p).toMatchObject({ project_id: 'p1', series_id: null, alu_finish_id: null, thickness_mm: null, sash_thickness_mm: null, infill_type_id: null, hardware_set_id: null, labour_per_sqm: null, profit_pct: null, item_name: null })
    expect(p.no_infill).toBe(false)
    expect(p).not.toHaveProperty('quantity')
    expect(p).not.toHaveProperty('preview_svg_out')
  })
  it('labour 0 and profit 0 are real values, not "inherit"', () => {
    const p = buildOpeningPayload(filled({ labour_per_sqm: '0', profit_pct: '0' }), { projectId: 'p1' })
    expect(p.labour_per_sqm).toBe(0)
    expect(p.profit_pct).toBe(0)
  })
  it('frame and sash thickness are separate numbers; blank sash = same as frame (NULL)', () => {
    const p = buildOpeningPayload(filled({ thickness_mm: '2', sash_thickness_mm: '1.5' }), { projectId: 'p1' })
    expect(p).toMatchObject({ thickness_mm: 2, sash_thickness_mm: 1.5 })
    expect(buildOpeningPayload(filled({ thickness_mm: '2' }), { projectId: 'p1' }).sash_thickness_mm).toBeNull()
  })
  it('"none" flags win over a leftover selection', () => {
    const p = buildOpeningPayload(filled({ no_infill: true, infill_type_id: 'g1', no_hardware_set: true, hardware_set_id: 'h1' }), { projectId: 'p1' })
    expect(p).toMatchObject({ no_infill: true, infill_type_id: null, no_hardware_set: true, hardware_set_id: null })
  })
  it('add-on fields are cleared when the add-on is switched off, and kept (with position/offset) when on', () => {
    const off = buildOpeningPayload(filled({ has_addon: false, addon_template_id: 't2', addon_width_m: '1', addon_position: 'bottom' }), { projectId: 'p1' })
    expect(off).toMatchObject({ addon_template_id: null, addon_width_m: null, addon_position: null, addon_offset_m: null, addon_panel_count: 1 })
    const on = buildOpeningPayload(filled({ has_addon: true, addon_template_id: 't2', addon_width_m: '1.2', addon_height_m: '0.4', addon_position: 'left', addon_offset_m: '0.3' }), { projectId: 'p1' })
    expect(on).toMatchObject({ addon_template_id: 't2', addon_width_m: 1.2, addon_height_m: 0.4, addon_position: 'left', addon_offset_m: 0.3 })
  })
  it('snapshots are included only when previews are passed', () => {
    const p = buildOpeningPayload(filled(), { projectId: 'p1', previews: { out: '<svg/>', in: null, sig: 's' }, savedAt: '2026-10-09T10:00:00Z' })
    expect(p).toMatchObject({ preview_svg_out: '<svg/>', preview_svg_in: null, preview_sig: 's', preview_saved_at: '2026-10-09T10:00:00Z' })
  })
  it('extra lines are normalised; text numbers become numbers; an invalid panel count falls back to 1', () => {
    const p = buildOpeningPayload(filled({ panel_count: '0', extra_lines: [{ description: 'Fire barrier', amount: '1500' }, { description: null, amount: 'x' }] }), { projectId: 'p1' })
    expect(p.panel_count).toBe(1)
    expect(p.extra_lines).toEqual([{ description: 'Fire barrier', amount: 1500 }, { description: '', amount: 0 }])
  })
})

describe('formFromOpening', () => {
  it('round-trips an item row (NULLs show as empty text)', () => {
    const row = { opening_no: 'D1', template_id: 't1', width_m: 2.4, height_m: 2.1, panel_count: 2, series_id: null, thickness_mm: 1.5, no_infill: true, addon_template_id: 't2', addon_width_m: 1, addon_height_m: 0.4, addon_position: 'bottom', addon_offset_m: 0 }
    const f = formFromOpening(row)
    expect(f).toMatchObject({ series_id: '', thickness_mm: '1.5', no_infill: true, has_addon: true, addon_position: 'bottom', addon_offset_m: '0', panel_count: '2' })
    const p = buildOpeningPayload(f, { projectId: 'p1' })
    expect(p).toMatchObject({ thickness_mm: 1.5, addon_offset_m: 0, addon_template_id: 't2', series_id: null })
  })
})

describe('validateForm', () => {
  it('names the first missing thing in Thai, null when savable', () => {
    expect(validateForm(emptyForm())).toBe('กรอกเลขช่อง')
    expect(validateForm({ ...emptyForm(), opening_no: 'D1' })).toBe('เลือก template')
    expect(validateForm({ ...emptyForm(), opening_no: 'D1', template_id: 't' })).toMatch(/ขนาด/)
    expect(validateForm(filled())).toBeNull()
  })
  it('a partly filled add-on blocks saving; negative labour and out-of-range profit are refused', () => {
    expect(validateForm(filled({ has_addon: true }))).toMatch(/ชุดต่อเติม/)
    expect(validateForm(filled({ has_addon: true, addon_template_id: 't2', addon_width_m: '1' }))).toMatch(/ขนาดชุดต่อเติม/)
    expect(validateForm(filled({ labour_per_sqm: '-1' }))).toMatch(/ค่าแรง/)
    expect(validateForm(filled({ profit_pct: '1001' }))).toMatch(/กำไร/)
    expect(validateForm(filled({ labour_per_sqm: '0', profit_pct: '0' }))).toBeNull()
  })
})
