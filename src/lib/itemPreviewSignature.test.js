import { describe, it, expect } from 'vitest'
import { buildCatalogIndex } from './aluCatalogPricing.js'
import { emptyForm, buildOpeningPayload } from './openingPayload.js'
import { frameFamily, previewFrames, itemPreviewInputs, itemPreviewSignature, snapshotPreviews } from './itemPreviewSignature.js'

const index = buildCatalogIndex({
  providers: [{ id: 'pA', name: 'A' }],
  series: [{ id: 's1', provider_id: 'pA', name: 'S1' }],
  profiles: [
    { id: 'fr15', provider_id: 'pA', family: 'frame', thickness_mm: 1.5, width_mm: 44.45 },
    { id: 'fr20', provider_id: 'pA', family: 'frame', thickness_mm: 2, width_mm: 50.8 },
    { id: 'ad15', provider_id: 'pA', family: 'small', thickness_mm: 1.5, width_mm: '25.4' },
  ],
  seriesProfiles: [{ series_id: 's1', profile_id: 'fr15' }, { series_id: 's1', profile_id: 'fr20' }, { series_id: 's1', profile_id: 'ad15' }],
})
const slide = { id: 'tSlide', main_axis: 'horizontal', preview_kind: 'slide', grid_row_weights: [1] }
const fixed = { id: 'tFix', main_axis: 'vertical', preview_kind: 'fixed', grid_row_weights: [1, 2] }
const ctx = {
  index,
  componentsByTemplate: { tSlide: [{ profile_family: 'frame', length_rule_type: 'width', thickness_role: null }], tFix: [{ profile_family: 'small', length_rule_type: 'height_minus' }] },
  jointsByTemplate: {},
}
const tplById = { tSlide: slide, tFix: fixed }

// What the item form does at save time: the payload is the normalised row.
function saveTime(form) {
  const payload = buildOpeningPayload(form, { projectId: 'p1' })
  const resolved = previewFrames({ template: tplById[payload.template_id], addonTemplate: tplById[payload.addon_template_id], ctx, seriesId: 's1', thicknessMm: 1.5 })
  return { payload, sig: itemPreviewSignature(payload, tplById[payload.template_id], tplById[payload.addon_template_id] || null, resolved) }
}
// What the items table does later: the stored row as PostgREST returns it (numerics may be strings, extra columns).
function tableTime(row) {
  const resolved = previewFrames({ template: tplById[row.template_id], addonTemplate: tplById[row.addon_template_id], ctx, seriesId: 's1', thicknessMm: '1.5' })
  return itemPreviewSignature(row, tplById[row.template_id], tplById[row.addon_template_id] || null, resolved)
}
const asDbRow = payload => {
  const s = v => (v === null ? null : String(v))
  return { ...payload, id: 'o1', quantity: 3, bom_templates: { name: 'x' }, width_m: s(payload.width_m), height_m: s(payload.height_m),
    addon_width_m: s(payload.addon_width_m), addon_height_m: s(payload.addon_height_m), addon_offset_m: s(payload.addon_offset_m) }
}

describe('frameFamily (one picker for the drawn frame and the part labels)', () => {
  const head = { profile_family: 'frame', length_rule_type: 'width' }
  const jamb = { profile_family: 'jamb', length_rule_type: 'height_minus' }
  const sash = { profile_family: 'sash', length_rule_type: 'width', thickness_role: 'sash' }
  it('no joints: the first non-sash bar cut along width/height', () => {
    expect(frameFamily([sash, { profile_family: 'p', length_rule_type: 'perimeter' }, jamb, head], [])).toBe('jamb')
  })
  it('a joint chooses only among frame families; a first joint on sash bars is ignored', () => {
    expect(frameFamily([head, jamb, sash], [{ main_family: 'sash', sort_order: 1 }, { main_family: 'jamb', sort_order: 2 }])).toBe('jamb')
    expect(frameFamily([head, jamb, sash], [{ main_family: 'sash', sort_order: 1 }])).toBe('frame')
    expect(frameFamily([head, jamb], [{ main_family: ' jamb ', sort_order: 3 }, { main_family: 'other', sort_order: 1 }])).toBe('jamb')
  })
  it('a sash-only template has no frame family, so frame_mm is omitted', () => {
    expect(frameFamily([sash], [{ main_family: 'sash' }])).toBeNull()
    const c = { ...ctx, componentsByTemplate: { tSlide: [{ ...sash, profile_family: 'frame' }] } }
    expect(previewFrames({ template: slide, ctx: c, seriesId: 's1', thicknessMm: 1.5 }).frame_mm).toBeNull()
    expect(itemPreviewInputs({ width_m: 1, height_m: 1 }, slide, null, { frame_mm: null }).frame_mm).toBeUndefined()
  })
})

describe('previewFrames', () => {
  it('reads the frame profile width at the resolved series and thickness; null when unknown', () => {
    expect(previewFrames({ template: slide, addonTemplate: fixed, ctx, seriesId: 's1', thicknessMm: 2 })).toEqual({ frame_mm: 50.8, addon_frame_mm: null })
    expect(previewFrames({ template: slide, addonTemplate: fixed, ctx, seriesId: 's1', thicknessMm: 1.5 })).toEqual({ frame_mm: 44.45, addon_frame_mm: 25.4 })
    expect(previewFrames({ template: slide, ctx, seriesId: null, thicknessMm: 1.5 })).toEqual({ frame_mm: null, addon_frame_mm: null })
  })
})

describe('itemPreviewSignature round trip', () => {
  it('horizontal-axis slide template: save-time signature equals the one recomputed from the stored row', () => {
    const form = { ...emptyForm(), opening_no: 'W1', template_id: 'tSlide', width_m: '1800', height_m: '1200', panel_count: '2' }
    const { payload, sig } = saveTime(form)
    expect(tableTime(asDbRow(payload))).toBe(sig)
    expect(sig).toContain('horizontal')
    expect(sig).toContain('slide')
    expect(sig).toContain('44.45')
  })
  it('an item with an add-on round-trips too (offset blank = centred stays null)', () => {
    const form = { ...emptyForm(), opening_no: 'W2', template_id: 'tSlide', width_m: '2000', height_m: '2100', panel_count: '3',
      has_addon: true, addon_template_id: 'tFix', addon_width_m: '2000', addon_height_m: '400', addon_panel_count: '2', addon_position: 'left', addon_offset_m: '' }
    const { payload, sig } = saveTime(form)
    expect(tableTime(asDbRow(payload))).toBe(sig)
    const withOffset = saveTime({ ...form, addon_offset_m: '0' })
    expect(tableTime(asDbRow(withOffset.payload))).toBe(withOffset.sig)
    expect(withOffset.sig).not.toBe(sig)
  })
  it('changing the size (main or add-on) changes the signature', () => {
    const form = { ...emptyForm(), opening_no: 'W3', template_id: 'tSlide', width_m: '1800', height_m: '1200', has_addon: true, addon_template_id: 'tFix', addon_width_m: '1800', addon_height_m: '400' }
    const a = saveTime(form).sig
    expect(saveTime({ ...form, width_m: '1810' }).sig).not.toBe(a)
    expect(saveTime({ ...form, addon_height_m: '500' }).sig).not.toBe(a)
    expect(saveTime({ ...form, width_m: '1800.0' }).sig).toBe(a)
  })
  it('a template preview change or a frame thickness change makes the stored signature old', () => {
    const { payload, sig } = saveTime({ ...emptyForm(), opening_no: 'W4', template_id: 'tSlide', width_m: '1000', height_m: '1000' })
    expect(itemPreviewSignature(payload, { ...slide, preview_kind: 'swing' }, null, { frame_mm: 44.45 })).not.toBe(sig)
    expect(itemPreviewSignature(payload, slide, null, { frame_mm: 50.8 })).not.toBe(sig)
  })
})

describe('itemPreviewInputs / snapshotPreviews', () => {
  it('builds the drawing inputs from string values; a half-filled add-on is left out', () => {
    const inputs = itemPreviewInputs({ template_id: 'tSlide', width_m: '1.5', height_m: '1', panel_count: '2', addon_template_id: 'tFix', addon_width_m: '', addon_height_m: '0.3' }, slide, fixed, { frame_mm: 44.45 })
    expect(inputs).toMatchObject({ width_m: 1.5, height_m: 1, panel_count: 2, main_axis: 'horizontal', frame_mm: 44.45, addon: null })
  })
  it('saves double-line SVGs without part labels for the chosen views, plus the signature', () => {
    const row = { template_id: 'tSlide', width_m: 1.5, height_m: 1, panel_count: 2, addon_template_id: 'tFix', addon_width_m: 1.5, addon_height_m: 0.3, addon_position: 'top', addon_panel_count: 1 }
    const snap = snapshotPreviews(row, slide, fixed, { frame_mm: 44.45 }, { out: true, in: false })
    expect(snap.out).toMatch(/^<svg/)
    expect(snap.in).toBeNull()
    expect(snap.sig).toBe(itemPreviewSignature(row, slide, fixed, { frame_mm: 44.45 }))
    expect(snapshotPreviews(row, slide, fixed, {}, { out: false, in: false })).toBeNull()
    expect(snapshotPreviews({ ...row, width_m: null }, slide, fixed, {}, { out: true, in: true })).toBeNull()
    const both = snapshotPreviews(row, slide, fixed, {}, { out: true, in: true })
    expect(both.in).toMatch(/^<svg/)
    expect(both.in).not.toBe(both.out)
  })
})

describe('a part-model template (layout_kind) has no flat components: the legacy preview helpers do not throw', () => {
  const tp = { id: 'tPart', main_axis: 'horizontal', preview_kind: 'slide', grid_row_weights: [1], layout_kind: 'sliding_2' }
  it('frameFamily of nothing is null, previewFrames gives null frames, inputs and a snapshot still come out', () => {
    expect(frameFamily([], [])).toBeNull()
    expect(frameFamily(undefined, undefined)).toBeNull()
    const frames = previewFrames({ template: tp, addonTemplate: null, ctx, seriesId: 's1', thicknessMm: 1.5 })
    expect(frames).toEqual({ frame_mm: null, addon_frame_mm: null })
    const inputs = itemPreviewInputs({ template_id: 'tPart', width_m: '1.8', height_m: '1.2', panel_count: 2 }, tp, null, frames)
    expect(inputs).toMatchObject({ template: tp, width_m: 1.8, height_m: 1.2, panel_count: 2, main_axis: 'horizontal', addon: null })
    expect(inputs.frame_mm).toBeUndefined()
    expect(() => snapshotPreviews({ template_id: 'tPart', width_m: 1.8, height_m: 1.2, panel_count: 2 }, tp, null, frames)).not.toThrow()
  })
})
