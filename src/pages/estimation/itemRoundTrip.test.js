// The snapshot signature the item form saves (snapshotFor on the payload) must equal what the items table
// recomputes later (costItems -> costOpening().resolved -> currentPreviewSigs) from the row as Postgres returns it.
import { describe, it, expect } from 'vitest'
import { buildCatalogIndex } from '../../lib/aluCatalogPricing.js'
import { mergeSettings } from '../../lib/estimationSettings.js'
import { emptyForm, buildOpeningPayload, formFromOpening } from '../../lib/openingPayload.js'
import { itemAddonsToRows, itemAddonsFromRows } from '../../lib/addonSave.js'
import { snapshotFor } from '../../lib/itemPreviewSignature.js'
import { costItems, currentPreviewSigs, itemStatus } from './projectDefaults.js'

const index = buildCatalogIndex({
  providers: [{ id: 'A', name: 'A', price_basis: 'per_kg' }],
  series: [{ id: 'sA', provider_id: 'A', name: 'S' }],
  types: [{ id: 'slide', name: 'บานเลื่อน' }, { id: 'fixed', name: 'บานติดตาย' }],
  seriesTypes: [{ series_id: 'sA', type_id: 'slide' }, { series_id: 'sA', type_id: 'fixed' }],
  finishes: [{ id: 'fA', provider_id: 'A', name: 'ขาว' }],
  profiles: [
    { id: 'fr', provider_id: 'A', family: 'frame', thickness_mm: 1.4, width_mm: 44.45, linear_weight_kg_per_m: 1 },
    { id: 'sm', provider_id: 'A', family: 'small', thickness_mm: 1.4, width_mm: 25.4, linear_weight_kg_per_m: 1 },
  ],
  seriesProfiles: [{ series_id: 'sA', profile_id: 'fr' }, { series_id: 'sA', profile_id: 'sm' }],
})
const cost0 = { waste_pct: 5, labor_price_per_sqm: 0, silicone_price_per_m: 0, felt_price_per_m: 0, infill_width_deduction_mm: 0, infill_height_deduction_mm: 0 }
const tS = { id: 'tS', name: 'เลื่อน', type_id: 'slide', grid_row_weights: [1], main_axis: 'horizontal', preview_kind: 'slide', ...cost0 }
const tF = { id: 'tF', name: 'ติดตาย', type_id: 'fixed', grid_row_weights: [1, 2], main_axis: 'vertical', preview_kind: 'fixed', ...cost0 }
const ctx = {
  templatesById: { tS, tF },
  componentsByTemplate: {
    tS: [{ role_name: 'บน', profile_family: 'frame', length_rule_type: 'width', length_deduction_mm: 0, quantity_basis: 'fixed', quantity_value: 2 }],
    tF: [{ role_name: 'ข้าง', profile_family: 'small', length_rule_type: 'height', length_deduction_mm: 0, quantity_basis: 'fixed', quantity_value: 2 }],
  },
  hardwareByTemplate: {}, jointsByTemplate: {}, typesById: index.types, infillTypesById: {}, index, settings: mergeSettings(null), packageItems: null,
}
const project = { id: 'p1', default_series_id: 'sA', default_finish_id: 'fA', default_thickness_mm: '1.40', price_as_of: '2026-10-01' }

// numerics as Postgres returns NUMERIC through PostgREST in the worst case (text), plus columns the form never sends
const dbRow = (payload, previews) => {
  const t = v => (v === null || v === undefined ? null : String(v))
  return {
    ...payload, id: 'o1', quantity: 2, bom_templates: { name: 'x', category: 'window' },
    width_m: t(payload.width_m), height_m: t(payload.height_m), addon_width_m: t(payload.addon_width_m), addon_height_m: t(payload.addon_height_m),
    addon_offset_m: t(payload.addon_offset_m), thickness_mm: t(payload.thickness_mm),
    preview_svg_out: previews.out, preview_svg_in: previews.in, preview_sig: previews.sig, preview_saved_at: '2026-10-09T08:00:00.000Z',
  }
}

describe('snapshot signature: item form save == items table recomputation', () => {
  it('horizontal slide main + add-on, sizes in millimetres on the form', () => {
    const form = { ...emptyForm(), opening_no: 'W1', template_id: 'tS', width_m: '1150', height_m: '1200', panel_count: '2',
      has_addon: true, addon_template_id: 'tF', addon_width_m: '1150', addon_height_m: '350', addon_position: 'top', addon_offset_m: '' }
    const payload = buildOpeningPayload(form, { projectId: 'p1' })
    const previews = snapshotFor(payload, { project, ctx, views: { out: true, in: true } })
    expect(previews.sig).toContain('44.45')
    expect(previews.sig).toContain('25.4')
    const row = dbRow(payload, previews)
    const costs = costItems({ items: [row], project, base: ctx, asOf: project.price_as_of })
    const sigs = currentPreviewSigs({ items: [row], costs, base: ctx })
    expect(sigs.o1).toBe(previews.sig)
    expect(itemStatus(row, { ...costs.o1, unresolved: [] }, sigs.o1)).toBe('ok')
    const moved = { ...row, width_m: '1.2' }
    const sigs2 = currentPreviewSigs({ items: [moved], costs: costItems({ items: [moved], project, base: ctx, asOf: project.price_as_of }), base: ctx })
    expect(itemStatus(moved, { unresolved: [] }, sigs2.o1)).toBe('old_preview')
  })
})

describe('inline add-ons round trip (form -> rows -> form)', () => {
  const addons = [
    { mode: 'merge', kind: 'fixed', position: 'top', len_mm: 1723.8, thick_mm: 400, offset_mm: 0, align: 'start', rows: 1, cols: 3 },
    { mode: 'attach', kind: 'awning', position: 'right', len_mm: 1200, thick_mm: 512.5, offset_mm: 0, align: 'end', rows: 2, cols: 1 },
  ]
  const form = { ...emptyForm(), opening_no: 'W1', template_id: 'tS', width_m: '1723.8', height_m: '1200', panel_count: '2', addons }

  it('two add-ons come back mm-exact and the opening row carries no add-on of either kind', () => {
    const payload = buildOpeningPayload(form, { projectId: 'p1' })
    expect(payload).not.toHaveProperty('addons')
    expect(payload).toMatchObject({ addon_template_id: null, addon_width_m: null, addon_height_m: null, addon_position: null, addon_offset_m: null, addon_panel_count: 1 })
    // as Postgres returns them: numerics as text, with ids
    const rows = itemAddonsToRows(form.addons, 'o1').map((r, i) => ({ ...r, id: `a${i}`, len_m: String(r.len_m), thick_m: String(r.thick_m), offset_m: String(r.offset_m) }))
    const back = formFromOpening({ ...payload, id: 'o1' }, itemAddonsFromRows(rows))
    expect(back.addons.map(({ id, ...a }) => a)).toEqual(addons)   // eslint-disable-line no-unused-vars
    expect(back.width_m).toBe('1723.8')
    expect(back.has_addon).toBe(false)
  })
  it('a legacy-only item round-trips byte-identically (no add-on keys added to the payload)', () => {
    const row = { id: 'o9', project_id: 'p1', opening_no: 'W9', item_name: null, item_description: null, template_id: 'tS', series_id: null, alu_finish_id: null,
      thickness_mm: null, sash_thickness_mm: null, no_infill: false, infill_type_id: null, no_hardware_set: false, hardware_set_id: null,
      width_m: 1.15, height_m: 1.2, panel_count: 2, addon_template_id: 'tF', addon_width_m: 1.15, addon_height_m: 0.35, addon_panel_count: 3,
      addon_position: 'top', addon_offset_m: 0.025, labour_per_sqm: null, profit_pct: null, fire_barrier_cost: null, bracket_cost: null,
      bend_alu_cost: null, bend_glass_cost: null, extra_lines: [] }
    const before = JSON.stringify(buildOpeningPayload({ ...formFromOpening(row) }, { projectId: 'p1' }))
    const expected = JSON.stringify((({ id, ...r }) => r)(row))   // eslint-disable-line no-unused-vars
    expect(before).toBe(expected)
    const f = formFromOpening(row)
    expect(f.addons).toEqual([])
    expect(JSON.stringify(buildOpeningPayload(f, { projectId: 'p1' }))).toBe(expected)
  })
})
