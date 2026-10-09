// The snapshot signature the item form saves (snapshotFor on the payload) must equal what the items table
// recomputes later (costItems -> costOpening().resolved -> currentPreviewSigs) from the row as Postgres returns it.
import { describe, it, expect } from 'vitest'
import { buildCatalogIndex } from '../../lib/aluCatalogPricing.js'
import { mergeSettings } from '../../lib/estimationSettings.js'
import { emptyForm, buildOpeningPayload } from '../../lib/openingPayload.js'
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
